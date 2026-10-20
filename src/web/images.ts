/**
 * Image lazy-loading helpers for the local web viewer.
 *
 * Base64 images are megabytes large, so `/api/session` never ships them:
 * `stripImages` rewrites every structured image part into a small placeholder
 * carrying an `imageRef {entryIndex, block}` (entryIndex = absolute JSONL byte
 * offset). The page later fetches one image on demand through `/api/image`,
 * which uses `lookupImage` to re-read exactly that JSONL line and decode the
 * requested block. The size cap is checked before decoding so an oversized
 * image never allocates its decoded Buffer.
 *
 * A second, text-only path covers `data:image/...;base64,...` payloads that
 * tools embed directly inside a string (Markdown image syntax included): those
 * are replaced by a `[图片已省略：<mime>，<size>]` placeholder while the prose
 * around them is preserved. They are never downloadable, so no `imageRef` is
 * produced; base64 is stripped from the response in both paths.
 *
 * Node built-ins only (zero runtime dependencies).
 */

import * as fs from "node:fs";

/** Default per-image cap: 16 MiB decoded. */
export const MAX_IMAGE_BYTES = 16 * 1024 * 1024;

/**
 * Hard cap for one JSONL line read by `lookupImage`. A single max-size image
 * needs ~21.4 MiB of base64 plus the JSON envelope; 64 MiB admits a few of
 * them while keeping a pathological no-newline line from being read forever.
 * A larger configured `maxBytes` raises the cap so one such image still fits.
 */
const LINE_READ_LIMIT = 64 * 1024 * 1024;

/** Envelope allowance (keys, ids, escaping) on top of one image payload. */
const LINE_ENVELOPE_BYTES = 1024 * 1024;

/** Chunk size used while scanning a line up to its newline. */
const READ_CHUNK_BYTES = 64 * 1024;

const NEWLINE = 0x0a;

/** Pointer to one image part inside a session file. */
export interface ImageRef {
	entryIndex: number;
	block: number;
}

/** Minimal shape of a raw (not yet stripped) image part. */
export interface ImagePart {
	mimeType?: unknown;
	data: string;
}

export type ImageLookup =
	| { kind: "ok"; mimeType: string; data: Buffer }
	| { kind: "too-large"; mimeType: string; byteLength: number }
	| { kind: "not-found" };

/**
 * Base64 decoded byte length in O(1): no Buffer allocation, only the encoded
 * length and the padding suffix are inspected.
 */
export function base64ByteLength(data: string): number {
	if (data.length === 0) return 0;
	let padding = 0;
	if (data.endsWith("==")) padding = 2;
	else if (data.endsWith("=")) padding = 1;
	return Math.floor((data.length * 3) / 4) - padding;
}

/** Explicit non-empty `mimeType` wins; otherwise sniff the base64 magic head. */
export function imageMimeType(part: ImagePart): string {
	const explicit = part.mimeType;
	if (typeof explicit === "string" && explicit.length > 0) return explicit;
	const data = part.data;
	if (data.startsWith("iVBORw0KGgo")) return "image/png";
	if (data.startsWith("/9j/")) return "image/jpeg";
	if (data.startsWith("R0lGOD")) return "image/gif";
	if (data.startsWith("UklGR")) return "image/webp";
	return "application/octet-stream";
}

/**
 * Deep-copy `entries` and replace every image part with a `data`-free
 * placeholder: `{type, mimeType, byteLength, imageRef:{entryIndex, block}}`.
 * `entryIndex` comes from `entryOffsets[i]`; `block` counts image parts in
 * depth-first traversal order across the whole entry. The input is never
 * mutated, and entries without images come out deep-equal to their originals.
 *
 * Inline `data:image/...;base64,...` payloads embedded in a string (bare URIs
 * and Markdown image syntax) are replaced by a `[图片已省略：mime，size]` text
 * placeholder instead of an `imageRef`: they carry no `block` index and never
 * reach `/api/image`, so `block` numbering of structured parts is unaffected.
 */
export function stripImages(entries: unknown[], entryOffsets: number[]): unknown[] {
	return entries.map((entry, index) => cloneEntry(entry, entryOffsets[index] ?? 0));
}

function cloneEntry(entry: unknown, entryIndex: number): unknown {
	let block = 0;

	const cloneValue = (value: unknown): unknown => {
		if (Array.isArray(value)) return value.map(cloneValue);
		if (typeof value === "string") return stripInlineImages(value);
		if (value === null || typeof value !== "object") return value;
		const record = value as Record<string, unknown>;
		if (record.type === "image" && typeof record.data === "string") {
			const data = record.data;
			return {
				type: "image",
				mimeType: imageMimeType({ mimeType: record.mimeType, data }),
				byteLength: base64ByteLength(data),
				imageRef: { entryIndex, block: block++ },
			};
		}
		const clone: Record<string, unknown> = {};
		for (const key of Object.keys(record)) {
			clone[key] = cloneValue(record[key]);
		}
		return clone;
	};

	return cloneValue(entry);
}

/**
 * Replace inline base64 image payloads inside `text` with a short
 * `[图片已省略：<mime>，<size>]` placeholder. Markdown image syntax is replaced
 * as a whole, a bare URI only in itself, so surrounding prose (and a trailing
 * `)`) survives. Strings without `data:image/` are returned as-is (no copy,
 * no replace). The payload is never decoded: its length comes from
 * `base64ByteLength`. Inline images stay text-only: no `imageRef` is emitted.
 */
function stripInlineImages(text: string): string {
	if (!text.includes("data:image/")) return text;
	const placeholder = (mimeType: string, payload: string): string =>
		`[图片已省略：image/${mimeType}，${formatBytes(base64ByteLength(payload))}]`;
	return text
		.replace(
			// `alt` is capped at 200 chars to keep the match linear: with an
			// unbounded class every `![` start rescans to the next `]`, which is
			// O(n²) on adversarial input. An over-long alt only degrades to
			// "base64 stripped, `![...](…)` shell kept" — never a base64 leak,
			// because the bare-URI pass below still replaces the payload.
			/!\[[^\]]{0,200}\]\(\s*data:image\/([\w.+-]+);base64,([A-Za-z0-9+/=]*)\s*\)/g,
			(_match, mimeType: string, payload: string) => placeholder(mimeType, payload),
		)
		.replace(/data:image\/([\w.+-]+);base64,([A-Za-z0-9+/=]*)/g, (_match, mimeType: string, payload: string) =>
			placeholder(mimeType, payload),
		);
}

/** Placeholder size: `B` below 1 KiB, `KB` (rounded) below 1 MiB, else `MB` (1 decimal). */
function formatBytes(bytes: number): string {
	if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
	if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
	return `${bytes} B`;
}

/**
 * Read the JSONL line starting at `entryOffset` and return the `block`-th
 * image part (same depth-first order as `stripImages`). Decoded bytes are
 * checked against `maxBytes` before decoding: an oversized image reports
 * `too-large` with its byte length and never allocates a decoded Buffer.
 * A line with no newline that outgrows the read cap is also `too-large`;
 * bad offsets, malformed JSON and missing blocks are `not-found`.
 */
export function lookupImage(
	filePath: string,
	entryOffset: number,
	block: number,
	maxBytes: number = MAX_IMAGE_BYTES,
): ImageLookup {
	const limit = lineReadLimit(maxBytes);
	const line = readLineAt(filePath, entryOffset, limit);
	if (line === null) return { kind: "not-found" };
	if (!line.complete) return oversizedLineLookup(line.text, block);

	let entry: unknown;
	try {
		entry = JSON.parse(line.text);
	} catch {
		return { kind: "not-found" };
	}
	const part = findImagePart(entry, block, { seen: 0 });
	if (part === null) return { kind: "not-found" };

	const byteLength = base64ByteLength(part.data);
	if (byteLength > maxBytes) {
		return { kind: "too-large", mimeType: part.mimeType, byteLength };
	}
	return { kind: "ok", mimeType: part.mimeType, data: Buffer.from(part.data, "base64") };
}

interface FoundImagePart {
	mimeType: string;
	data: string;
}

/** Depth-first search mirroring `stripImages`; a matched part is not descended into. */
function findImagePart(node: unknown, block: number, counter: { seen: number }): FoundImagePart | null {
	if (Array.isArray(node)) {
		for (const item of node) {
			const found = findImagePart(item, block, counter);
			if (found !== null) return found;
		}
		return null;
	}
	if (node === null || typeof node !== "object") return null;
	const record = node as Record<string, unknown>;
	if (record.type === "image" && typeof record.data === "string") {
		if (counter.seen === block) {
			const data = record.data;
			return { mimeType: imageMimeType({ mimeType: record.mimeType, data }), data };
		}
		counter.seen += 1;
		return null;
	}
	for (const key of Object.keys(record)) {
		const found = findImagePart(record[key], block, counter);
		if (found !== null) return found;
	}
	return null;
}

/** Read one line starting at `offset`; `complete` is false when the cap hit first. */
function readLineAt(
	filePath: string,
	offset: number,
	limit: number,
): { text: string; complete: boolean } | null {
	let fd: number;
	try {
		fd = fs.openSync(filePath, "r");
	} catch {
		return null;
	}
	try {
		let size: number;
		try {
			size = fs.fstatSync(fd).size;
		} catch {
			return null;
		}
		if (!Number.isInteger(offset) || offset < 0 || offset >= size) return null;

		const chunks: Buffer[] = [];
		let total = 0;
		let position = offset;
		let complete = false;
		while (position < size) {
			const want = Math.min(READ_CHUNK_BYTES, size - position, limit - total);
			if (want <= 0) break;
			const chunk = readExact(fd, position, want);
			if (chunk.length === 0) break;
			const newline = chunk.indexOf(NEWLINE);
			if (newline !== -1) {
				chunks.push(chunk.subarray(0, newline));
				total += newline;
				position += newline + 1;
				complete = true;
				break;
			}
			chunks.push(chunk);
			total += chunk.length;
			position += chunk.length;
		}
		if (!complete && position >= size) complete = true;
		return { text: Buffer.concat(chunks, total).toString("utf-8"), complete };
	} finally {
		fs.closeSync(fd);
	}
}

/**
 * Best-effort recovery for a line that outgrew the read cap (so JSON.parse is
 * impossible). Scans the visible prefix for image parts in appearance order
 * and reports the requested block's visible byte length, falling back to the
 * largest complete `data` payload seen.
 */
function oversizedLineLookup(prefix: string, block: number): ImageLookup {
	const marker = /"(mimeType|type|data)"\s*:\s*"([^"]*)"/g;
	let current = -1;
	let mimeType: string | undefined;
	let fallbackMime = "";
	let fallbackBytes = 0;
	let match: RegExpExecArray | null;
	while ((match = marker.exec(prefix)) !== null) {
		const key = match[1];
		const value = match[2];
		if (key === "type") {
			if (value === "image") {
				current += 1;
				mimeType = undefined;
			}
		} else if (key === "mimeType" && current >= 0) {
			mimeType = value;
		} else if (key === "data" && current >= 0) {
			const bytes = base64ByteLength(value);
			if (bytes > fallbackBytes) {
				fallbackBytes = bytes;
				fallbackMime = mimeType ?? "";
			}
			if (current === block) {
				return { kind: "too-large", mimeType: mimeType || "application/octet-stream", byteLength: bytes };
			}
		}
	}
	return { kind: "too-large", mimeType: fallbackMime || "application/octet-stream", byteLength: fallbackBytes };
}

/** Line read cap: at least one max-size image (plus envelope) must fit. */
function lineReadLimit(maxBytes: number): number {
	const payload = Number.isFinite(maxBytes) && maxBytes > 0 ? Math.ceil(maxBytes / 3) * 4 : 0;
	return Math.max(LINE_READ_LIMIT, payload + LINE_ENVELOPE_BYTES);
}

/** Read exactly `length` bytes at absolute `position` (shorter only at EOF). */
function readExact(fd: number, position: number, length: number): Buffer {
	const buf = Buffer.allocUnsafe(length);
	let total = 0;
	while (total < length) {
		const read = fs.readSync(fd, buf, total, length - total, position + total);
		if (read <= 0) break;
		total += read;
	}
	return total === length ? buf : buf.subarray(0, total);
}
