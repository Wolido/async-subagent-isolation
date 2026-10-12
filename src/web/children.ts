/**
 * Sidecar child pointers for the web session tree.
 *
 * At dispatch time the subagent tool appends one `ChildPointer` line to
 * `<parentSessionDir>/children.jsonl`, so the web tree can link an in-flight
 * child before its receipt lands in the parent session. The file is
 * append-only; repeated dispatches with the same childTaskId are resolved
 * last-wins on read.
 *
 * Best-effort by contract: a missing/unreadable file reads as empty and a
 * failed append is swallowed, so pointer bookkeeping can never break (or
 * throw out of) the dispatch path. Node built-ins only (zero runtime
 * dependencies).
 */

import * as fs from "node:fs";
import * as path from "node:path";

export const CHILDREN_FILE_NAME = "children.jsonl";

/** Lines longer than this are treated as corrupt and skipped on read. */
export const MAX_CHILD_POINTER_LINE_BYTES = 1024 * 1024;

/**
 * Whole-file read cap. `readChildPointers` reads at most this many bytes, so
 * a runaway pointer file cannot stall (or blow up memory in) the web tree
 * build; records past the cap are never returned.
 */
export const MAX_CHILD_POINTER_FILE_BYTES = 8 * 1024 * 1024;

export interface ChildPointer {
	childTaskId: string;
	agent: string;
	task: string;
	startedAt: number;
	depth: number;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * Append one pointer record as a JSON line. Never throws: the write is
 * best-effort because a failed pointer only degrades the web tree.
 */
export function appendChildPointer(sessionDir: string, record: ChildPointer): void {
	try {
		fs.appendFileSync(path.join(sessionDir, CHILDREN_FILE_NAME), JSON.stringify(record) + "\n");
	} catch {
		/* best-effort: a failed pointer write must never break dispatch */
	}
}

/**
 * Read and validate the pointer records of a session directory. Missing or
 * unreadable files read as []; malformed lines, invalid field types and
 * oversized lines are skipped; a repeated childTaskId keeps the last record.
 * At most MAX_CHILD_POINTER_FILE_BYTES are read: when the file is larger, the
 * window is cut back to its last complete line, so only records inside the
 * cap are returned. Never throws.
 */
export function readChildPointers(sessionDir: string): ChildPointer[] {
	let raw: string;
	let fd: number | null = null;
	try {
		fd = fs.openSync(path.join(sessionDir, CHILDREN_FILE_NAME), "r");
		// Allocate the read window from the file size so a small pointer file a
		// tree poll touches (one per unscanned node) never allocates the full
		// 8 MiB cap; without a stat the full cap is the best-effort fallback.
		let size = MAX_CHILD_POINTER_FILE_BYTES;
		try {
			size = fs.fstatSync(fd).size;
		} catch {
			/* without a size, allocate the whole cap (best-effort) */
		}
		const windowBytes = Math.min(Math.max(size, 0), MAX_CHILD_POINTER_FILE_BYTES);
		const buffer = Buffer.allocUnsafe(windowBytes);
		const bytesRead = fs.readSync(fd, buffer, 0, windowBytes, 0);
		let end = bytesRead;
		if (size > MAX_CHILD_POINTER_FILE_BYTES) {
			// The read may have stopped mid-line: keep bytes through the last
			// newline inside the window and drop the partial tail line.
			const lastNewline = buffer.subarray(0, bytesRead).lastIndexOf(10);
			end = lastNewline === -1 ? 0 : lastNewline + 1;
		}
		raw = buffer.toString("utf-8", 0, end);
	} catch {
		return [];
	} finally {
		if (fd !== null) {
			try {
				fs.closeSync(fd);
			} catch {
				/* best-effort close */
			}
		}
	}
	const byChild = new Map<string, ChildPointer>();
	for (const line of raw.split("\n")) {
		if (line.trim() === "") continue;
		if (Buffer.byteLength(line, "utf-8") > MAX_CHILD_POINTER_LINE_BYTES) continue;
		let parsed: unknown;
		try {
			parsed = JSON.parse(line);
		} catch {
			continue; // skip malformed lines
		}
		if (typeof parsed !== "object" || parsed === null) continue;
		const candidate = parsed as Record<string, unknown>;
		const { childTaskId, agent, task, startedAt, depth } = candidate;
		if (typeof childTaskId !== "string" || !UUID_RE.test(childTaskId)) continue;
		if (typeof agent !== "string" || typeof task !== "string") continue;
		if (typeof startedAt !== "number" || !Number.isFinite(startedAt)) continue;
		if (typeof depth !== "number" || !Number.isFinite(depth)) continue;
		byChild.set(childTaskId, { childTaskId, agent, task, startedAt, depth });
	}
	return [...byChild.values()];
}
