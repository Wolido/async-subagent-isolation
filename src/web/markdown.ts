/**
 * Markdown rendering helpers for the local web viewer.
 *
 * Both functions are inlined verbatim into `PAGE_HTML` via `.toString()`, so
 * they must stay pure and self-contained: no imports, no module-level
 * references and no `this`. Raw HTML outside code is escaped before the
 * markdown parser runs, so model output can never inject live markup; links are
 * restricted to `http(s)` and in-page anchors.
 */

/**
 * Escape raw HTML text while leaving code untouched.
 *
 * Outside code every `<` becomes `&lt;` (`>` stays, so blockquotes keep
 * working). Inside fenced code blocks (```/~~~) and inline backtick code spans
 * nothing is escaped: the markdown parser escapes code itself, and
 * pre-escaping would double-escape `<` into `&amp;lt;`. Non-string input
 * returns "". Self-contained because the page inlines the `.toString()` source.
 */
export function escapeRawHtml(text: string): string {
	if (typeof text !== "string") {
		return "";
	}
	var out = "";
	var i = 0;
	var length = text.length;
	var fenceChar = "";
	var fenceLength = 0;
	while (i < length) {
		if (i === 0 || text.charAt(i - 1) === "\n") {
			var lineEnd = text.indexOf("\n", i);
			if (lineEnd === -1) {
				lineEnd = length;
			}
			var line = text.slice(i, lineEnd);
			var match = /^( {0,3})(`{3,}|~{3,})(.*)$/.exec(line);
			var inFence = fenceChar !== "";
			if (inFence || match !== null) {
				if (inFence && match !== null && match[2].charAt(0) === fenceChar && match[2].length >= fenceLength && match[3].trim() === "") {
					fenceChar = "";
					fenceLength = 0;
				} else if (!inFence && match !== null) {
					fenceChar = match[2].charAt(0);
					fenceLength = match[2].length;
				}
				out += line;
				i = lineEnd;
				if (i < length) {
					out += "\n";
					i += 1;
				}
				continue;
			}
		}
		var ch = text.charAt(i);
		if (ch === "`") {
			var runEnd = i;
			while (runEnd < length && text.charAt(runEnd) === "`") {
				runEnd += 1;
			}
			var runLength = runEnd - i;
			var close = -1;
			var scan = runEnd;
			while (scan < length) {
				if (text.charAt(scan) !== "`") {
					scan += 1;
					continue;
				}
				var closeEnd = scan;
				while (closeEnd < length && text.charAt(closeEnd) === "`") {
					closeEnd += 1;
				}
				if (closeEnd - scan === runLength) {
					close = scan;
					break;
				}
				scan = closeEnd;
			}
			if (close === -1) {
				// unclosed code span: conservatively escape the remaining text
				out += text.slice(i).split("<").join("&lt;");
				i = length;
				continue;
			}
			out += text.slice(i, close + runLength);
			i = close + runLength;
			continue;
		}
		if (ch === "<") {
			out += "&lt;";
		} else {
			out += ch;
		}
		i += 1;
	}
	return out;
}

/**
 * True only for `http:`, `https:` and in-page `#` anchors (case-insensitive,
 * trimmed); everything else (`javascript:`, `data:`, `mailto:`, `//host`,
 * relative paths, non-strings) is rejected.
 */
export function isSafeHref(href: string): boolean {
	if (typeof href !== "string") {
		return false;
	}
	return /^(https?:|#)/i.test(href.trim());
}

/**
 * True only for `data:` URLs (case-insensitive) and internal `/api/image`
 * paths, checked after trimming; everything else (`http:`, `https:`,
 * protocol-relative `//host`, relative paths, `javascript:`, empty strings,
 * non-strings) is rejected, so a rendered `<img>` can never auto-request a
 * remote resource. Self-contained because the page inlines the
 * `.toString()` source.
 */
export function isAllowedImageSrc(src: string): boolean {
	if (typeof src !== "string") {
		return false;
	}
	var trimmed = src.trim();
	if (/^data:/i.test(trimmed)) {
		return true;
	}
	// The internal endpoint must be exactly "/api/image" or "/api/image?": a
	// longer path (/api/imageX, /api/image.evil, /api/image/../session) names a
	// different resource and must not pass the prefix check.
	if (trimmed.indexOf("/api/image") !== 0) {
		return false;
	}
	return trimmed.length === 10 || trimmed.charAt(10) === "?";
}

/**
 * Neutralize remote resource references in an HTML string before it reaches
 * `innerHTML`: foreign-content/scriptable elements are dropped entirely, a
 * non-whitelisted `src` on any element is renamed to `data-remote-src` (so no
 * live URL is ever fetched), and every `srcset`/`imagesrcset`/`poster`/`style`/
 * `background` attribute is deleted. `data:` and `/api/image` image sources are
 * left untouched. An unclosed tag is escaped (`<` becomes `&lt;`) instead of
 * being emitted verbatim. Tags are isolated quote-aware (a `>` inside `"`/`'`
 * does not end the tag), non-string input is stringified, input without `<` is
 * returned as-is and the function never throws. Self-contained because the page
 * inlines the `.toString()` source; only `isAllowedImageSrc` is referenced.
 */
export function neutralizeRemoteMarkup(html: string): string {
	var source = typeof html === "string" ? html : String(html);
	if (source.indexOf("<") === -1) {
		return source;
	}
	var blocked = ["iframe", "object", "embed", "video", "audio", "source", "link", "style", "base", "meta", "form", "script", "track", "image"];
	var attribute = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)(\s*=\s*("[^"]*"|'[^']*'|[^\s"'=<>`]+))?/g;
	var out = "";
	var index = 0;
	var length = source.length;
	while (index < length) {
		var start = source.indexOf("<", index);
		if (start === -1) {
			out += source.slice(index);
			break;
		}
		out += source.slice(index, start);
		var closing = source.charAt(start + 1) === "/";
		var nameStart = closing ? start + 2 : start + 1;
		var nameEnd = nameStart;
		while (nameEnd < length && /[A-Za-z0-9-]/.test(source.charAt(nameEnd))) {
			nameEnd += 1;
		}
		if (nameEnd === nameStart) {
			// Not a tag (plain `<` in text): keep it and rescan after it.
			out += "<";
			index = start + 1;
			continue;
		}
		// Skip quoted attribute values so a `>` inside e.g. srcset="a > b"
		// never truncates the tag.
		var scan = nameEnd;
		var quote = "";
		var tagEnd = -1;
		while (scan < length) {
			var ch = source.charAt(scan);
			if (quote !== "") {
				if (ch === quote) { quote = ""; }
			} else if (ch === '"' || ch === "'") {
				quote = ch;
			} else if (ch === ">") {
				tagEnd = scan;
				break;
			}
			scan += 1;
		}
		if (tagEnd === -1) {
			// Unclosed tag: escape its `<` fail-closed and keep scanning the
			// remaining markup instead of emitting a live tag fragment.
			out += "&lt;";
			index = start + 1;
			continue;
		}
		var tagName = source.slice(nameStart, nameEnd).toLowerCase();
		if (blocked.indexOf(tagName) !== -1) {
			index = tagEnd + 1;
			continue;
		}
		if (closing) {
			out += source.slice(start, tagEnd + 1);
			index = tagEnd + 1;
			continue;
		}
		var attrsStart = nameEnd;
		var attrsEnd = tagEnd;
		if (source.charAt(attrsEnd - 1) === "/") {
			attrsEnd -= 1;
		}
		var rewritten = source.slice(attrsStart, attrsEnd).replace(attribute, function (match, attributeName, valuePart, value) {
			var lower = String(attributeName).toLowerCase();
			if (lower === "srcset" || lower === "imagesrcset" || lower === "poster" || lower === "style" || lower === "background") {
				return "";
			}
			if (lower === "src") {
				var raw = typeof value === "string" ? value : "";
				if (raw.charAt(0) === '"' || raw.charAt(0) === "'") {
					raw = raw.slice(1, raw.length - 1);
				}
				if (!isAllowedImageSrc(raw)) {
					if (raw.indexOf('"') === -1) {
						return 'data-remote-src="' + raw + '"';
					}
					// A `"` inside a single-quoted value would break a double-quoted
					// rewrite into new attributes: keep the original quoting instead.
					return "data-remote-src" + (typeof valuePart === "string" ? valuePart : "");
				}
			}
			return match;
		});
		out += source.slice(start, attrsStart) + rewritten + source.slice(attrsEnd, tagEnd + 1);
		index = tagEnd + 1;
	}
	return out;
}
