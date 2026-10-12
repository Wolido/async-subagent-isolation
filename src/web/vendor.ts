/**
 * Vendored browser bundles inlined into `PAGE_HTML`.
 *
 * `marked.min.js` and `highlight.min.js` are copied verbatim (license headers
 * preserved, see `assets/vendor/NOTICE`) and read here so the self-contained
 * page can inline them into `<script>` blocks: no external request, no npm
 * dependency at runtime. A missing asset degrades to an empty string so the
 * page (plain text rendering) still loads instead of failing the extension.
 */

import * as fs from "node:fs";
import { fileURLToPath } from "node:url";

/** Read one vendored bundle relative to this module; "" when unreadable. */
function readVendor(relativePath: string): string {
	try {
		return fs.readFileSync(fileURLToPath(new URL(relativePath, import.meta.url)), "utf-8");
	} catch {
		return "";
	}
}

/**
 * Defense in depth for inlining raw JS into `<script>`: a literal `</script`
 * would terminate the block early in the browser (breaking the page). The
 * vendored bundles contain none today, but a future vendor update cannot
 * silently break out of the page.
 */
function inlineSafe(source: string): string {
	return source.replace(/<\/script/gi, "<\\/script");
}

/** marked v18.0.5 (MIT), license header preserved inside the source. */
export const MARKED_JS: string = inlineSafe(readVendor("../../assets/vendor/marked.min.js"));

/** highlight.js v11.9.0 (BSD-3-Clause), license header preserved inside the source. */
export const HIGHLIGHT_JS: string = inlineSafe(readVendor("../../assets/vendor/highlight.min.js"));
