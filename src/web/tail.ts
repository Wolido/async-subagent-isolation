/**
 * Incremental JSONL tail reader for the local web server.
 *
 * `alignToLineBoundary` / `parseChunk` are pure helpers; `createTailReader`
 * keeps per-`taskId` state so repeated polls only return newly appended lines.
 * Node built-ins only (zero runtime dependencies).
 */

import * as fs from "node:fs";

const NEWLINE = 0x0a;
const EMPTY_BUFFER = Buffer.alloc(0);

/** Default single-read cap (1 MiB) when `TailReadOpts.maxBytes` is absent. */
const DEFAULT_MAX_BYTES = 1024 * 1024;

/** First-read `tail` snapshot window: start at most this many bytes before EOF. */
const TAIL_WINDOW_BYTES = 512 * 1024;

/** Probe/chase chunk size used while looking for the end of a line. */
const CHASE_CHUNK_BYTES = 64 * 1024;

/** Hard cap for chasing a single line; beyond it the line is dropped, not buffered. */
const CHASE_MAX_BYTES = 8 * 1024 * 1024;

/** Hard cap for one held-back partial line; beyond it the line is dropped. */
const RESIDUAL_MAX_BYTES = 8 * 1024 * 1024;

/** Maximum number of per-`taskId` states kept before the least-recently-used is evicted. */
const MAX_STATES = 64;

/** Pure-function result of `parseChunk`. */
export interface ParseChunkResult {
	entries: any[];
	/** Buffer-relative start index of each parsed entry (same length as `entries`). */
	lineStarts: number[];
	malformed: number;
	consumed: number;
	oversizeLine: boolean;
}

export interface TailReadOpts {
	taskId: string;
	filePath: string;
	/** Absolute byte offset to resume from; defaults to the cached offset or 0. */
	offset?: number;
	/** First-read hint: skip the file head and start near the end of the file. */
	tail?: boolean;
	/** Upper bound (bytes) for a single read; a single oversized line is admitted alone. */
	maxBytes?: number;
}

export interface TailResult {
	entries: any[];
	/** Absolute file byte offset of each entry (same length as `entries`). */
	entryOffsets: number[];
	malformed: number;
	nextOffset: number;
	size: number;
	mtime: number;
	hasMore: boolean;
	truncatedBefore: boolean;
	oversizeLine: boolean;
	/**
	 * Absolute offset this read's window started at (the internal `base`): a
	 * bounded, backward-reachable cursor for auto-backfill when the response
	 * carries no entries.
	 */
	startOffset: number;
}

/** Result of the stateless backward window read (`readBefore`). */
export interface TailBeforeResult {
	entries: any[];
	/** Absolute file byte offset of each entry (same length as `entries`). */
	entryOffsets: number[];
	malformed: number;
	oversizeLine: boolean;
	/**
	 * Backward cursor for the next `readBefore` call. With entries it is the
	 * absolute start offset of the first entry; with no complete entry it is the
	 * window start examined by this call, which is always strictly below
	 * `before` (0 means there are no earlier bytes). The client can therefore
	 * always keep walking backwards instead of stalling on the same `before`.
	 */
	startOffset: number;
	size: number;
	mtime: number;
}

/** Per-`taskId` cache: where reading stopped and which bytes are still unparsed. */
interface TailState {
	filePath: string;
	offset: number;
	residual: Buffer;
	size: number;
	mtimeMs: number;
	ino: number;
}

/**
 * Index right after the first `0x0A` at or after `start`; `-1` when there is none.
 */
export function alignToLineBoundary(buf: Buffer, start: number): number {
	const index = buf.indexOf(NEWLINE, start);

	return index === -1 ? -1 : index + 1;
}

/**
 * Split `buf` on `'\n'` and JSON.parse every complete line.
 *
 * Malformed lines are skipped and counted. A trailing partial line is left
 * unconsumed (`consumed` stops at the last `'\n'`). At most `maxBytes` are
 * consumed per call, except that a single line longer than `maxBytes` is
 * admitted alone and flagged via `oversizeLine`.
 */
export function parseChunk(buf: Buffer, maxBytes: number = DEFAULT_MAX_BYTES): ParseChunkResult {
	const limit = normalizeMaxBytes(maxBytes);
	const entries: any[] = [];
	const lineStarts: number[] = [];
	let malformed = 0;
	let consumed = 0;
	let oversizeLine = false;

	while (consumed < buf.length) {
		const newline = buf.indexOf(NEWLINE, consumed);
		if (newline === -1) {
			// trailing partial line: hold it back for the next read
			break;
		}
		const lineEnd = newline + 1;
		if (consumed > 0 && lineEnd > limit) {
			// read budget reached: leave the rest of the chunk untouched
			break;
		}
		const isOversize = newline - consumed > limit;
		if (isOversize) {
			oversizeLine = true;
		}
		const lineStart = consumed;
		try {
			entries.push(JSON.parse(buf.toString("utf-8", lineStart, newline)));
			lineStarts.push(lineStart);
		} catch {
			malformed++;
		}
		consumed = lineEnd;
		if (isOversize) {
			// an oversized line is admitted by itself, no matter the budget
			break;
		}
	}

	return { entries, lineStarts, malformed, consumed, oversizeLine };
}

// ---------------------------------------------------------------------------
// Backward window read (client auto-backfill)
// ---------------------------------------------------------------------------

/**
 * Stateless backward read for client auto-backfill.
 *
 * `before` is clamped to `[0, size]`; `before === 0` yields an empty result.
 * The nominal window starts at `before - maxBytes`, but when its head is the
 * tail of a line that started before it the window is extended backwards
 * chunk by chunk (capped at `CHASE_MAX_BYTES`) until that line is complete, so
 * a single line longer than `maxBytes` is still returned whole. A trailing
 * line cut by a mid-line `before` is dropped; malformed lines are skipped and
 * counted. Entries stay in file order and `entryOffsets` holds the absolute
 * byte offset of each line start. When nothing complete is returned,
 * `startOffset` falls back to the examined window start so it stays a strictly
 * backward cursor below `before`. A missing/unreadable file returns null.
 *
 * Unlike `createTailReader().read`, this function is pure: it never touches
 * the per-`taskId` forward cache.
 */
export function readBefore(
	filePath: string,
	before: number,
	maxBytes: number = DEFAULT_MAX_BYTES,
): TailBeforeResult | null {
	let stat: fs.Stats;
	try {
		stat = fs.statSync(filePath);
	} catch {
		return null;
	}
	let fd: number;
	try {
		fd = fs.openSync(filePath, "r");
	} catch {
		return null;
	}

	try {
		const size = stat.size;
		const limit = normalizeMaxBytes(maxBytes);
		let clamped = typeof before === "number" && Number.isFinite(before) ? Math.floor(before) : 0;
		if (clamped < 0) {
			clamped = 0;
		}
		if (clamped > size) {
			clamped = size;
		}
		if (clamped === 0) {
			return emptyBeforeResult(size, stat.mtimeMs);
		}

		// Nominal window ending at `before`; a partial head line is completed by
		// stepping backwards in `limit`-sized chunks until a newline is found.
		let windowStart = Math.max(0, clamped - limit);
		let expanded = 0;
		while (windowStart > 0 && !isLineStart(fd, windowStart) && expanded < CHASE_MAX_BYTES) {
			const chunk = Math.min(limit, windowStart, CHASE_MAX_BYTES - expanded);
			const chunkStart = windowStart - chunk;
			const probe = readExact(fd, chunkStart, chunk);
			expanded += probe.length;
			const boundary = probe.lastIndexOf(NEWLINE);
			if (boundary !== -1) {
				windowStart = chunkStart + boundary + 1;
				break;
			}
			windowStart = chunkStart;
			if (probe.length === 0) {
				break;
			}
		}

		let buf = readExact(fd, windowStart, clamped - windowStart);
		let base = windowStart;
		let headTrimmed = false;
		if (base > 0 && !isLineStart(fd, base)) {
			const boundary = buf.indexOf(NEWLINE);
			if (boundary === -1) {
				// The chase cap was hit inside one long line: no complete line can be
				// returned. `base` is a bounded backward cursor, so the client loop
				// still makes progress instead of spinning on the same `before`.
				return {
					entries: [],
					entryOffsets: [],
					malformed: 0,
					oversizeLine: true,
					startOffset: base,
					size,
					mtime: stat.mtimeMs,
				};
			}
			headTrimmed = true;
			buf = buf.subarray(boundary + 1);
			base += boundary + 1;
		}

		const parsed = parseChunk(buf, buf.length);
		const entries = parsed.entries;
		const entryOffsets = parsed.lineStarts.map((start) => base + start);
		let oversizeLine = headTrimmed && entries.length === 0;
		for (const start of parsed.lineStarts) {
			const newline = buf.indexOf(NEWLINE, start);
			const lineEnd = newline === -1 ? buf.length : newline;
			if (lineEnd - start > limit) {
				oversizeLine = true;
				break;
			}
		}

		return {
			entries,
			entryOffsets,
			malformed: parsed.malformed,
			oversizeLine,
			startOffset: entryOffsets.length > 0 ? entryOffsets[0] : windowStart,
			size,
			mtime: stat.mtimeMs,
		};
	} finally {
		fs.closeSync(fd);
	}
}

function emptyBeforeResult(size: number, mtime: number): TailBeforeResult {
	return { entries: [], entryOffsets: [], malformed: 0, oversizeLine: false, startOffset: 0, size, mtime };
}

/** True when `position` is 0 or directly follows a newline. */
function isLineStart(fd: number, position: number): boolean {
	if (position <= 0) {
		return true;
	}
	const probe = readExact(fd, position - 1, 1);
	return probe.length === 1 && probe[0] === NEWLINE;
}

/** Stateful JSONL reader: each `taskId` caches its own offset and residual bytes. */
export function createTailReader(): {
	read: (opts: TailReadOpts) => TailResult | null;
	stateCount: () => number;
} {
	const states = new Map<string, TailState>();

	return {
		/** Test hook: current number of cached per-`taskId` states. */
		stateCount(): number {
			return states.size;
		},

		read(opts: TailReadOpts): TailResult | null {
			const maxBytes = normalizeMaxBytes(opts.maxBytes);

			let stat: fs.Stats;
			try {
				stat = fs.statSync(opts.filePath);
			} catch {
				// file vanished: drop everything cached for this task
				states.delete(opts.taskId);

				return null;
			}

			let fd: number;
			try {
				fd = fs.openSync(opts.filePath, "r");
			} catch {
				states.delete(opts.taskId);

				return null;
			}

			try {
				const size = stat.size;
				const cached = states.get(opts.taskId);
				if (cached !== undefined) {
					// refresh recency so the LRU cap evicts genuinely cold tasks
					states.delete(opts.taskId);
					states.set(opts.taskId, cached);
				}
				const samePath = cached !== undefined && cached.filePath === opts.filePath;
				const reusable =
					samePath &&
					!isInvalidated(cached as TailState, stat) &&
					(opts.offset === undefined || opts.offset === (cached as TailState).offset);

				let base: number;
				let residual: Buffer;
				let truncatedBefore = false;

				if (reusable) {
					base = (cached as TailState).offset;
					residual = (cached as TailState).residual;
				} else {
					// truncation / replaced inode always restarts from 0; otherwise honor the client offset
					const invalidated = samePath && isInvalidated(cached as TailState, stat);
					let requested = invalidated ? 0 : opts.offset ?? 0;
					if (!Number.isFinite(requested) || requested < 0 || requested > size) {
						requested = 0;
					}
					base = Math.floor(requested);
					residual = EMPTY_BUFFER;
					if (base === 0 && opts.tail === true) {
						const snapshotStart = Math.max(0, size - TAIL_WINDOW_BYTES);
						if (snapshotStart > 0) {
							base = findLineStart(fd, snapshotStart, size);
							truncatedBefore = true;
						}
					}
				}

				// `residual` starts at `base`, so new bytes begin after it
				const seek = base + residual.length;
				let data: Buffer = EMPTY_BUFFER;
				let chaseOverflowed = false;
				if (seek < size) {
					data = readExact(fd, seek, Math.min(maxBytes, size - seek));
					// no newline anywhere in the window: chase the line end, then concat once
					const chased: Buffer[] = [];
					let chasedBytes = 0;
					while (
						residual.indexOf(NEWLINE) === -1 &&
						data.indexOf(NEWLINE) === -1 &&
						seek + data.length + chasedBytes < size
					) {
						const budget = CHASE_MAX_BYTES - residual.length - data.length - chasedBytes;
						if (budget <= 0) {
							// line outgrew the chase cap without a newline: drop it instead of buffering
							chaseOverflowed = true;
							break;
						}
						const chunk = Math.min(
							Math.max(maxBytes, CHASE_CHUNK_BYTES),
							budget,
							size - (seek + data.length + chasedBytes),
						);
						const extra = readExact(fd, seek + data.length + chasedBytes, chunk);
						if (extra.length === 0) {
							break;
						}
						chased.push(extra);
						chasedBytes += extra.length;
						if (extra.indexOf(NEWLINE) !== -1) {
							break;
						}
					}
					if (chasedBytes > 0) {
						data = Buffer.concat([data, ...chased], data.length + chasedBytes);
					}
				}

				if (chaseOverflowed) {
					// discard the oversized line and resume right after its newline (or EOF)
					const skippedOffset = findLineStart(fd, base, size);
					states.set(opts.taskId, {
						filePath: opts.filePath,
						offset: skippedOffset,
						residual: EMPTY_BUFFER,
						size,
						mtimeMs: stat.mtimeMs,
						ino: stat.ino,
					});
					evictOverflow(states);

					return {
						entries: [],
						entryOffsets: [],
						malformed: 0,
						nextOffset: skippedOffset,
						size,
						mtime: stat.mtimeMs,
						hasMore: skippedOffset < size,
						truncatedBefore,
						oversizeLine: true,
						startOffset: base,
					};
				}

				const combined: Buffer =
					residual.length > 0 ? (data.length > 0 ? Buffer.concat([residual, data]) : residual) : data;
				const parsed = parseChunk(combined, maxBytes);
				let nextOffset = base + parsed.consumed;
				let newResidual =
					parsed.consumed < combined.length ? combined.subarray(parsed.consumed) : EMPTY_BUFFER;
				let oversizeLine = parsed.oversizeLine;

				if (newResidual.length > RESIDUAL_MAX_BYTES) {
					// partial line too long to keep around: drop it and skip to its end
					nextOffset = findLineStart(fd, nextOffset, size);
					newResidual = EMPTY_BUFFER;
					oversizeLine = true;
				}

				states.set(opts.taskId, {
					filePath: opts.filePath,
					offset: nextOffset,
					residual: newResidual,
					size,
					mtimeMs: stat.mtimeMs,
					ino: stat.ino,
				});
				evictOverflow(states);

				return {
					entries: parsed.entries,
					// `combined` starts at file position `base`, so relative line starts
					// become absolute session-file byte offsets by adding `base`.
					entryOffsets: parsed.lineStarts.map((start) => base + start),
					malformed: parsed.malformed,
					nextOffset,
					size,
					mtime: stat.mtimeMs,
					hasMore: nextOffset < size,
					truncatedBefore,
					oversizeLine,
					startOffset: base,
				};
			} finally {
				fs.closeSync(fd);
			}
		},
	};
}

/** Evict least-recently-used task states until the cache is back within its cap. */
function evictOverflow(states: Map<string, TailState>): void {
	while (states.size > MAX_STATES) {
		const oldest = states.keys().next().value;
		if (oldest === undefined) {
			return;
		}
		states.delete(oldest);
	}
}

/** A cached state is stale when the file was replaced or shrank into cached bytes. */
function isInvalidated(cached: TailState, stat: fs.Stats): boolean {
	return cached.ino !== stat.ino || stat.size < cached.offset + cached.residual.length;
}

/** Absolute position right after the first `'\n'` in `[from, end)`, or `end`. */
function findLineStart(fd: number, from: number, end: number): number {
	let position = from;
	while (position < end) {
		const probe = readExact(fd, position, Math.min(CHASE_CHUNK_BYTES, end - position));
		if (probe.length === 0) {
			break;
		}
		const boundary = alignToLineBoundary(probe, 0);
		if (boundary !== -1) {
			return position + boundary;
		}
		position += probe.length;
	}

	return end;
}

/** Read exactly `length` bytes at absolute `position` (shorter only at EOF). */
function readExact(fd: number, position: number, length: number): Buffer {
	const buf = Buffer.allocUnsafe(length);
	let total = 0;
	while (total < length) {
		const read = fs.readSync(fd, buf, total, length - total, position + total);
		if (read <= 0) {
			break;
		}
		total += read;
	}

	return total === length ? buf : buf.subarray(0, total);
}

function normalizeMaxBytes(value: number | undefined): number {
	return typeof value === "number" && Number.isFinite(value) && value > 0
		? Math.floor(value)
		: DEFAULT_MAX_BYTES;
}
