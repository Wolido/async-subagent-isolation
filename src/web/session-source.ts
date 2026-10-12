/**
 * Session JSONL source of truth for the web tree builder.
 *
 * `readSessionSummary` parses a session file once and caches the result by
 * `(path, size, mtimeMs)` in a bounded LRU: an append or rewrite naturally
 * invalidates the entry, while repeated `/api/tree` requests over unchanged
 * files reuse the parsed summary instead of reading and parsing again.
 *
 * Files larger than `MAX_PARSE_BYTES` are never loaded whole: only the tail
 * window `[size - MAX_PARSE_BYTES, size)` is read and the leading partial
 * line is dropped. Parsing is best-effort: a missing or unparsable file
 * degrades to an empty summary, malformed lines are skipped, never fatal.
 * User messages are ignored: parent/child links come from receipts and the
 * children.jsonl sidecar pointers, not from task-text matching.
 *
 * Node built-ins only (zero runtime dependencies).
 */

import * as fs from "node:fs";

export const MAX_PARSE_BYTES = 20 * 1024 * 1024;

export interface ParsedToolCall {
	id: string;
	agent?: string;
	task?: string;
	ts: number;
	/**
	 * Explicit non-dispatch action (`cancel`, `schemas`, ...). The default
	 * dispatch normalises to absent: `undefined`, `""` and `"dispatch"` all
	 * parse to `undefined`, so a normal dispatch keeps the historical parsed
	 * shape `{id, agent, task, ts}`.
	 */
	action?: string;
}

export interface ParsedResult {
	toolCallId: string;
	text: string;
	ts: number;
	/** `message.isError === true`; a missing field normalises to false. */
	isError: boolean;
}

export interface SessionSummary {
	headerTs: number | null;
	/**
	 * Timestamp of the last timestamp-bearing `message` line in file order (the
	 * session header line never contributes; header-only files stay null).
	 */
	lastEntryTs: number | null;
	toolCalls: Map<string, ParsedToolCall>;
	callOrder: ParsedToolCall[];
	results: ParsedResult[];
}

/** Bounded parse cache: at most this many file summaries are retained (LRU). */
const CACHE_LIMIT = 256;

interface CacheEntry {
	size: number;
	mtimeMs: number;
	summary: SessionSummary;
}

const cache = new Map<string, CacheEntry>();

function emptySummary(): SessionSummary {
	return {
		headerTs: null,
		lastEntryTs: null,
		toolCalls: new Map(),
		callOrder: [],
		results: [],
	};
}

function toTimestamp(value: unknown): number | null {
	if (typeof value === "number" && Number.isFinite(value)) return value;
	if (typeof value === "string") {
		const parsed = Date.parse(value);
		if (Number.isFinite(parsed)) return parsed;
	}
	return null;
}

function joinTextParts(content: unknown): string | null {
	if (!Array.isArray(content)) return null;
	const parts: string[] = [];
	for (const part of content) {
		if (part && part.type === "text" && typeof part.text === "string") parts.push(part.text);
	}
	return parts.length > 0 ? parts.join("\n") : null;
}

/** Read a file whole, or only its tail window when it exceeds MAX_PARSE_BYTES. */
function readFileText(filePath: string, size: number): string | null {
	if (size <= MAX_PARSE_BYTES) {
		try {
			return fs.readFileSync(filePath, "utf-8");
		} catch {
			return null;
		}
	}
	let fd: number;
	try {
		fd = fs.openSync(filePath, "r");
	} catch {
		return null;
	}
	try {
		const buf = Buffer.allocUnsafe(MAX_PARSE_BYTES);
		const bytesRead = fs.readSync(fd, buf, 0, MAX_PARSE_BYTES, size - MAX_PARSE_BYTES);
		const raw = buf.toString("utf-8", 0, bytesRead);
		// The window usually starts mid-line: drop everything up to and
		// including the first newline so only complete lines are parsed.
		const newline = raw.indexOf("\n");
		return newline === -1 ? "" : raw.slice(newline + 1);
	} catch {
		return null;
	} finally {
		fs.closeSync(fd);
	}
}

/** Parse one session JSONL text. Malformed lines are skipped, never fatal. */
function parseSessionText(raw: string): SessionSummary {
	const parsed = emptySummary();
	for (const line of raw.split("\n")) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		let entry: any;
		try {
			entry = JSON.parse(trimmed);
		} catch {
			continue; // skip malformed lines
		}
		if (entry?.type === "session") {
			// The header only feeds `headerTs`: `lastEntryTs` reflects message
			// lines exclusively (a header-only file has lastEntryTs === null).
			const headerTs = toTimestamp(entry.timestamp) ?? toTimestamp(entry.message?.timestamp);
			if (parsed.headerTs === null) parsed.headerTs = headerTs;
			continue;
		}
		if (entry?.type !== "message") continue;
		const message = entry.message;
		// File-order last timestamp: without one, `lastEntryTs` must stay unchanged
		// (never fall back to 0/now); the parse fallback below only feeds ts fields.
		const entryTs = toTimestamp(entry.timestamp) ?? toTimestamp(message?.timestamp);
		if (entryTs !== null) parsed.lastEntryTs = entryTs;
		const ts = entryTs ?? 0;
		const content = message?.content;
		if (!Array.isArray(content)) continue;
		if (message?.role === "assistant") {
			for (const part of content) {
				if (part?.type !== "toolCall" || part?.name !== "subagent") continue;
				const id = typeof part.id === "string" ? part.id : "";
				if (!id || parsed.toolCalls.has(id)) continue;
				const args = part.arguments;
				const rawAction = typeof args?.action === "string" ? args.action : undefined;
				const call: ParsedToolCall = {
					id,
					agent: typeof args?.agent === "string" ? args.agent : undefined,
					task: typeof args?.task === "string" ? args.task : undefined,
					ts,
					action: rawAction === undefined || rawAction === "" || rawAction === "dispatch" ? undefined : rawAction,
				};
				parsed.toolCalls.set(id, call);
				parsed.callOrder.push(call);
			}
			continue;
		}
		if (message?.role === "toolResult" && message?.toolName === "subagent") {
			const toolCallId = typeof message.toolCallId === "string" ? message.toolCallId : "";
			if (!toolCallId) continue;
			const text = joinTextParts(content);
			if (text === null) continue;
			parsed.results.push({ toolCallId, text, ts, isError: message.isError === true });
		}
	}
	return parsed;
}

/**
 * Parsed summary of a session file, cached by `(path, size, mtimeMs)`. Any
 * size/mtime change re-reads and re-parses the file; unchanged files are
 * served from the LRU cache.
 */
export function readSessionSummary(filePath: string): SessionSummary {
	let stat: fs.Stats;
	try {
		stat = fs.statSync(filePath);
	} catch {
		return emptySummary(); // missing/unreadable file -> degraded summary
	}
	const cached = cache.get(filePath);
	if (cached !== undefined && cached.size === stat.size && cached.mtimeMs === stat.mtimeMs) {
		// LRU refresh: re-insert as the most recently used entry.
		cache.delete(filePath);
		cache.set(filePath, cached);
		return cached.summary;
	}
	const raw = readFileText(filePath, stat.size);
	if (raw === null) return emptySummary();
	const summary = parseSessionText(raw);
	// Re-insert so an updated file becomes the most recently used entry.
	cache.delete(filePath);
	cache.set(filePath, { size: stat.size, mtimeMs: stat.mtimeMs, summary });
	if (cache.size > CACHE_LIMIT) {
		const oldest = cache.keys().next().value;
		if (oldest !== undefined) cache.delete(oldest);
	}
	return summary;
}

/** Test-isolation hook: module-level parse cache is process-wide. */
export function resetSessionSourceCacheForTests(): void {
	cache.clear();
}
