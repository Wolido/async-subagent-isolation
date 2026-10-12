/**
 * Session-tree construction for the local web view.
 *
 * `buildSessionTree` walks the main session JSONL (and, recursively, each
 * dispatched subagent session JSONL) and produces the parent/child tree of
 * subagent tasks. Three parent -> child link sources are recognised:
 *
 *   1) receipt — a `subagent` toolResult carrying either the async receipt
 *      "Dispatched <agent>. taskId: <id>" or the sync suffix
 *      "[subagent session: <id>]";
 *   2) pointer — a `<sessionDir>/children.jsonl` sidecar record written by
 *      the dispatch path, which links an in-flight child by exact taskId
 *      before its receipt lands (the main session never reads this file);
 *   3) result — an `isError` toolResult (dispatch rejected or child run
 *      failed) classified into a rejected / failed node;
 *   4) unknown — a dispatch toolCall with neither a receipt nor a matching
 *      pointer; the node is kept with an empty taskId so the UI can show a
 *      waiting state instead of silently dropping the dispatch.
 *
 * Receipts win over pointers for the same childId (full rebuild, never a
 * duplicate node), except for a stale sync receipt older than the newest
 * pointer row, which must not mark a re-dispatched child finished. A pointer
 * whose agent and task both match a receipt-less toolCall suppresses the
 * unknown node for that call. The latest result (max ts) of a childId decides
 * its link, so a later run overrides an earlier rejected/failed outcome and
 * vice versa.
 *
 * Performance: JSONL parsing is delegated to `session-source` (parse cache
 * keyed by path/size/mtime). Directory lookup is strictly directed: a node's
 * taskId is resolved with a direct `statSync(<rootDir>/<taskId>)` plus a
 * readdir of that single task directory. The sessions root is never
 * enumerated.
 *
 * All reads are best-effort: a missing/unparsable session, directory or
 * pointer file degrades that node instead of failing the whole build.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { CHILDREN_FILE_NAME, readChildPointers } from "./children.ts";
import type { ChildPointer } from "./children.ts";
import { readSessionSummary } from "./session-source.ts";
import type { ParsedResult, ParsedToolCall, SessionSummary } from "./session-source.ts";
import { childSummary } from "./tree-view.ts";

export interface SessionTreeNode {
	taskId: string;
	agent: string;
	task: string;
	depth: number;
	/** Classification of the latest dispatch event (see `resolveStatus`). */
	status: "running" | "recent" | "finished" | "pending" | "rejected" | "failed";
	linkSource: "receipt" | "pointer" | "result" | "unknown";
	startedAt: number;
	finishedAt?: number;
	/** One-line reason of a rejected dispatch, e.g. `not in roster`. */
	reason?: string;
	/** Full original text of a rejected / failed toolResult. */
	errorText?: string;
	/** First TASK_TEXT_MAX code points when the original task text was longer. */
	taskTruncated?: true;
	/**
	 * Number of direct children: the scanned list length when this node's
	 * children were scanned, otherwise the children.jsonl pointer count of the
	 * node's own session directory (0 when there is none).
	 */
	childCount: number;
	/**
	 * `childSummary(children)` when scanned; when lazy, `""` for 0 children,
	 * `"N children · all finished"` for a finished node, else the neutral
	 * `"N children"` wording matching the node's own status.
	 */
	childSummary: string;
	children: SessionTreeNode[];
}

/** Completion record of a recently finished task, keyed by taskId. */
export interface CompletedTaskInfo {
	status?: string;
	finishedAt: number;
}

export interface BuildTreeDeps {
	mainSessionFile: string | null;
	registry: Map<string, { status?: string; agentName?: string; task?: string }>;
	rootDir: string;
	now?: number;
	completedTasks?: ReadonlyMap<string, CompletedTaskInfo>;
}

/** Top-level truncation report of one `buildSessionTreeResult` call. */
export interface TruncationInfo {
	/** Discovered top-level dispatch entries (before the top-level budget). */
	total: number;
	/** Top-level nodes actually returned. */
	showing: number;
	/** `total - showing` (0 while nothing was dropped). */
	dropped: number;
}

export interface BuildTreeResult {
	nodes: SessionTreeNode[];
	truncated: TruncationInfo;
}

/** Deps of one explicit subtree expansion (depth based at 1). */
export interface SubtreeDeps {
	rootDir: string;
	registry: Map<string, { status?: string; agentName?: string; task?: string }>;
	completedTasks?: ReadonlyMap<string, CompletedTaskInfo>;
	now?: number;
	sessionDir: string | null;
	sessionFile: string | null;
}

/**
 * One navigation link from a `subagent` toolCall to the child task it
 * dispatched, for the transcript nav items of the web page. Receipt links
 * carry the call's own agent/task when the call is known; pointer links carry
 * the sidecar record's raw text (matched on trimmed equality).
 */
export interface SessionLink {
	toolCallId: string;
	childTaskId: string;
	agent: string;
	task: string;
	source: "receipt" | "pointer";
}

/**
 * Async dispatch receipt, e.g. "Dispatched coder. taskId: <uuid>". The agent
 * name may contain spaces: the match anchors on the literal ". taskId: "
 * separator plus the UUID shape, never on whitespace inside the name.
 */
const ASYNC_RECEIPT_RE =
	/^Dispatched (.+)\. taskId: ([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;

/** Sync dispatch suffix, e.g. "...\n\n[subagent session: <uuid>]" (trailing \n optional). */
const SYNC_SESSION_RE =
	/(?:^|\n)\s*\[subagent session: ([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\]\s*$/;

/** Parsed dispatch receipt: child task id, async agent name and receipt shape. */
interface ParsedReceipt {
	childId: string;
	receiptAgent: string | undefined;
	kind: "async" | "sync";
}

/**
 * Parse one `subagent` toolResult text against the two receipt shapes. Shared
 * by the tree build (dispatch links) and `collectSessionLinks` so the two
 * regexes are never implemented twice.
 */
function parseReceipt(text: string): ParsedReceipt | null {
	const trimmed = text.trim();
	const asyncMatch = ASYNC_RECEIPT_RE.exec(trimmed);
	if (asyncMatch) return { childId: asyncMatch[2], receiptAgent: asyncMatch[1], kind: "async" };
	const syncMatch = SYNC_SESSION_RE.exec(trimmed);
	if (syncMatch) return { childId: syncMatch[1], receiptAgent: undefined, kind: "sync" };
	return null;
}

/** Root depth is 0, so nodes are created for depths 0..MAX_DEPTH. */
const MAX_DEPTH = 6;
/**
 * Per-level node budgets (the old global MAX_NODES=200 is gone): depth 0
 * keeps at most MAX_ROOT_NODES top-level dispatches and every other level at
 * most MAX_CHILD_NODES direct children. A level over budget drops its oldest
 * entries (by startedAt) and keeps the newest ones, so a fresh task can never
 * disappear behind an old one.
 */
const MAX_ROOT_NODES = 1000;
const MAX_CHILD_NODES = 200;
/** Task texts longer than this are cut to the first TASK_TEXT_MAX characters. */
const TASK_TEXT_MAX = 200;
/**
 * Fallback-only window: when neither the registry, a sync receipt nor a
 * completedTasks record is available, a child session whose last entry
 * timestamp falls within this window of `now` is the sole reason to show
 * "recent"; otherwise the node is "finished". Not a completion signal by
 * itself, and the file mtime no longer participates in this decision.
 */
const RECENT_WINDOW_MS = 10_000;
/**
 * Pointer liveness fallback: a pointer-linked child with no postdating sync
 * receipt is "running", but once its last entry is silent for longer than
 * this window it degrades to "recent", so a genuinely crashed child cannot
 * stay "running" forever. 10 minutes.
 */
const POINTER_STALE_WINDOW_MS = 600_000;

// ---------------------------------------------------------------------------
// Task directories
// ---------------------------------------------------------------------------

interface DirInfo {
	taskId: string;
	dir: string;
	dirMtime: number | null;
	sessionFile: string | null;
	fileMtime: number | null;
}

/** Lazily resolve the newest `.jsonl` of one task directory. */
function ensureSessionFile(info: DirInfo): void {
	if (info.sessionFile !== null) return;
	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(info.dir, { withFileTypes: true });
	} catch {
		return;
	}
	for (const entry of entries) {
		if (!entry.isFile() || !entry.name.endsWith(".jsonl") || entry.name === CHILDREN_FILE_NAME) continue;
		const filePath = path.join(info.dir, entry.name);
		try {
			const mtime = fs.statSync(filePath).mtimeMs;
			if (info.fileMtime === null || mtime > info.fileMtime) {
				info.fileMtime = mtime;
				info.sessionFile = filePath;
			}
		} catch {
			/* ignore unreadable entries */
		}
	}
}

/** Fresh direct inspection of one task dir: stat + newest `.jsonl`. */
function inspectTaskDir(dir: string, taskId: string): DirInfo {
	let dirMtime: number | null = null;
	try {
		dirMtime = fs.statSync(dir).mtimeMs;
	} catch {
		/* unreadable dir -> degraded info */
	}
	const info: DirInfo = { taskId, dir, dirMtime, sessionFile: null, fileMtime: null };
	ensureSessionFile(info);
	return info;
}

// ---------------------------------------------------------------------------
// Build context
// ---------------------------------------------------------------------------

interface TreeContext {
	rootDir: string;
	now: number;
	registry: Map<string, { status?: string; agentName?: string; task?: string }>;
	/** In-process completion records injected by the host; empty when absent. */
	completedTasks: ReadonlyMap<string, CompletedTaskInfo>;
	/** Per-build cache of direct task-dir stats; null = missing/unreadable. */
	taskDirs: Map<string, DirInfo | null>;
	seen: Set<string>;
}

/**
 * One task directory by id without scanning rootDir: a per-build cached
 * direct `statSync` of `<rootDir>/<taskId>` followed by a readdir of that
 * single directory. Never enumerates the sessions root.
 */
function getTaskDir(ctx: TreeContext, taskId: string): DirInfo | null {
	const cached = ctx.taskDirs.get(taskId);
	if (cached !== undefined) return cached;
	const dir = path.join(ctx.rootDir, taskId);
	let info: DirInfo | null = null;
	try {
		if (fs.statSync(dir).isDirectory()) info = inspectTaskDir(dir, taskId);
	} catch {
		info = null; // missing/unreadable -> degraded node
	}
	ctx.taskDirs.set(taskId, info);
	return info;
}

// ---------------------------------------------------------------------------
// Dispatch discovery
// ---------------------------------------------------------------------------

interface DispatchLink {
	childId: string;
	toolCallId: string;
	source: "receipt" | "pointer" | "result" | "unknown";
	call: ParsedToolCall | undefined;
	receiptAgent: string | undefined;
	pointer: ChildPointer | undefined;
	/** Receipt shape and toolResult timestamp; only set for receipt links. */
	receiptKind?: "async" | "sync";
	receiptTs?: number;
	/** Classification of an `isError` toolResult; only set for result links. */
	errorStatus?: "rejected" | "failed";
	/** Timestamp of the `isError` toolResult; only set for result links. */
	errorTs?: number;
	reason?: string;
	errorText?: string;
}

/** One classified `subagent` toolResult: what it links to and how it ended. */
interface ClassifiedResult {
	result: ParsedResult;
	/** Child session id, or "" when the error names no extractable id. */
	childId: string;
	kind: "receipt" | "rejected" | "failed";
	receiptKind?: "async" | "sync";
	receiptAgent?: string;
	reason?: string;
}

/**
 * Dispatch-gate rejection wording, mapped to a one-line reason. A rejected
 * dispatch never started a child session, so it is classified apart from a
 * failed run (which does have a child session / diagnostics).
 */
function rejectionReason(text: string): string | null {
	const trimmed = text.trim();
	if (/^Cannot dispatch "[^"]+"\. Allowed subagents:/.test(trimmed)) return "not in roster";
	const unknown = /^Unknown agent: "([^"]+)"\./.exec(trimmed);
	if (unknown) return `unknown agent "${unknown[1]}"`;
	if (/depth limit reached/i.test(trimmed)) return "depth limit reached";
	if (/is already running/i.test(trimmed)) return "already running";
	const missing = /Missing (?:or empty )?required parameter: "([^"]+)"/.exec(trimmed);
	if (missing) return `missing required parameter "${missing[1]}"`;
	if (/Invalid sessionId/i.test(trimmed)) return "invalid sessionId";
	return null;
}

/**
 * Only a dispatch attempt can produce a rejected/failed node. Any other
 * non-empty action (`cancel`, `schemas`, ...) never started a child session,
 * so its error result is dropped entirely; an absent/empty/`"dispatch"`
 * action is the tool's default dispatch.
 */
function isDispatchAttempt(call: ParsedToolCall | undefined): boolean {
	const action = call?.action;
	return action === undefined || action === "" || action === "dispatch";
}

/**
 * Classify one `subagent` toolResult: a non-error receipt links a child
 * session; an error of a dispatch attempt whose wording matches the dispatch
 * gate is `rejected`; an error carrying a child id (`[subagent session: <id>]`)
 * or exit-code diagnostics is `failed`. Non-dispatch results classify to
 * null. `isError` results are never treated as successful sync receipts.
 */
function classifyResult(result: ParsedResult, call: ParsedToolCall | undefined): ClassifiedResult | null {
	const receipt = parseReceipt(result.text);
	if (!result.isError) {
		if (receipt === null) return null;
		return {
			result,
			childId: receipt.childId,
			kind: "receipt",
			receiptKind: receipt.kind,
			receiptAgent: receipt.receiptAgent,
		};
	}
	// cancel/schemas errors must not surface as dispatch outcomes at all.
	if (!isDispatchAttempt(call)) return null;
	// A failed run's diagnostics can echo gate wording (e.g. "is already
	// running" in stderr): a child id or exit-code diagnostics mark it failed
	// before any rejection wording match.
	if (receipt !== null || /Exit code:/.test(result.text)) {
		return { result, childId: receipt?.childId ?? "", kind: "failed" };
	}
	const reason = rejectionReason(result.text);
	// Rejection wording never carries a sync suffix (those classify as failed
	// above), so a rejected dispatch has no child id.
	if (reason !== null) return { result, childId: "", kind: "rejected", reason };
	// Any other isError toolResult originates from the dispatch gate too; keep
	// it visible as rejected with a generic reason instead of dropping it.
	return { result, childId: "", kind: "rejected", reason: "dispatch rejected" };
}

/**
 * Collect this session's dispatch links per childId, latest event wins:
 * the newest (max ts) result of a childId decides whether it is linked by a
 * receipt or classified rejected/failed; a stale sync receipt older than the
 * newest pointer row loses to that pointer. Then pointer records for the
 * remaining childIds, rejected links without a childId, and an unknown link
 * for every result-less toolCall no pointer covers.
 */
function collectDispatchLinks(ctx: TreeContext, sessionDir: string | null, sessionFile: string | null): DispatchLink[] {
	const links: DispatchLink[] = [];
	const pointers = sessionDir !== null ? readChildPointers(sessionDir) : [];
	if (sessionFile === null) {
		for (const pointer of pointers) {
			links.push({
				childId: pointer.childTaskId,
				toolCallId: "",
				source: "pointer",
				call: undefined,
				receiptAgent: undefined,
				pointer,
			});
		}
		return links;
	}

	const session = readSessionSummary(sessionFile);
	const coveredCallIds = new Set<string>();
	// Latest result per toolCallId: a reused call id is decided by ts (equal ts
	// keeps the later line in file order).
	const latestByCall = new Map<string, ClassifiedResult>();
	for (const result of session.results) {
		const classified = classifyResult(result, session.toolCalls.get(result.toolCallId));
		if (classified === null) continue;
		coveredCallIds.add(result.toolCallId);
		const previous = latestByCall.get(result.toolCallId);
		if (previous === undefined || result.ts >= previous.result.ts) latestByCall.set(result.toolCallId, classified);
	}
	// Latest result per linked childId: a later run (receipt or failure) wins.
	const latestByChild = new Map<string, ClassifiedResult>();
	for (const classified of latestByCall.values()) {
		if (classified.childId === "") continue;
		const previous = latestByChild.get(classified.childId);
		if (previous === undefined || classified.result.ts >= previous.result.ts) {
			latestByChild.set(classified.childId, classified);
		}
	}

	const pointerByChild = new Map(pointers.map((pointer) => [pointer.childTaskId, pointer]));
	const claimedChildIds = new Set<string>();
	for (const [childId, classified] of latestByChild) {
		const pointer = pointerByChild.get(childId);
		// A result older than the newest pointer row is stale: the pointer link
		// below wins so a re-dispatched child is not finished by an old receipt.
		if (pointer !== undefined && classified.result.ts <= pointer.startedAt) continue;
		claimedChildIds.add(childId);
		const call = session.toolCalls.get(classified.result.toolCallId);
		if (classified.kind === "receipt") {
			links.push({
				childId,
				toolCallId: classified.result.toolCallId,
				source: "receipt",
				call,
				receiptAgent: classified.receiptAgent,
				pointer,
				receiptKind: classified.receiptKind,
				receiptTs: classified.result.ts,
			});
		} else {
			links.push({
				childId,
				toolCallId: classified.result.toolCallId,
				source: "result",
				call,
				receiptAgent: undefined,
				pointer,
				errorStatus: classified.kind,
				errorTs: classified.result.ts,
				reason: classified.reason,
				errorText: classified.result.text,
			});
		}
	}
	for (const pointer of pointers) {
		if (claimedChildIds.has(pointer.childTaskId)) continue;
		links.push({
			childId: pointer.childTaskId,
			toolCallId: "",
			source: "pointer",
			call: undefined,
			receiptAgent: undefined,
			pointer,
		});
	}
	// Results without a child id (a rejected dispatch, or a failed run whose
	// diagnostics name no session) are emitted as result links; buildLevel's
	// explicit defence keeps only `rejected` among them.
	for (const classified of latestByCall.values()) {
		if (classified.kind === "receipt" || classified.childId !== "") continue;
		links.push({
			childId: "",
			toolCallId: classified.result.toolCallId,
			source: "result",
			call: session.toolCalls.get(classified.result.toolCallId),
			receiptAgent: undefined,
			pointer: undefined,
			errorStatus: classified.kind,
			errorTs: classified.result.ts,
			reason: classified.reason,
			errorText: classified.result.text,
		});
	}
	for (const call of session.callOrder) {
		if (coveredCallIds.has(call.id)) continue;
		// Non-dispatch calls (cancel/schemas) never started a child, even when
		// the model redundantly passed a task; they must produce no node.
		if (!isDispatchAttempt(call)) continue;
		if (typeof call.task !== "string" || call.task === "") continue;
		const coveredByPointer = pointers.some(
			(pointer) =>
				(pointer.agent ?? "").trim() === (call.agent ?? "").trim() &&
				(pointer.task ?? "").trim() === (call.task ?? "").trim(),
		);
		if (coveredByPointer) continue;
		links.push({
			childId: "",
			toolCallId: call.id,
			source: "unknown",
			call,
			receiptAgent: undefined,
			pointer: undefined,
		});
	}
	return links;
}

/**
 * Stat-only change key of `<sessionDir>/children.jsonl`: a fixed marker when
 * sessionDir is null or the file is missing/unreadable, otherwise
 * `size:mtimeMs`. Cheap enough to compute on every call, so a changed sidecar
 * always invalidates the cached links while an unchanged one is never read.
 */
function childrenStatKey(sessionDir: string | null): string {
	if (sessionDir === null) return "none";
	try {
		const stat = fs.statSync(path.join(sessionDir, CHILDREN_FILE_NAME));
		return `${stat.size}:${stat.mtimeMs}`;
	} catch {
		return "missing";
	}
}

/**
 * Per-summary link cache. `readSessionSummary` already caches parses by
 * `(path, size, mtimeMs)` and returns the same summary object while the
 * session file is unchanged, so the summary itself is a correct identity key
 * for the receipt side. The sidecar side is keyed by its own stat, so a
 * changed children.jsonl is always recomputed. The WeakMap key keeps the
 * cache bounded: an entry dies with its summary (and the session-source LRU
 * caps live summaries at CACHE_LIMIT).
 */
const linksCache = new WeakMap<SessionSummary, { key: string; links: SessionLink[] }>();

/**
 * Collect the transcript navigation links of one session: one link per known
 * dispatch toolCall, receipts first (results order), then sidecar pointers
 * (read order) matched to the first unclaimed call with equal agent/task.
 * The same toolCallId is emitted at most once and receipts always win. Calls
 * with neither a receipt nor a matching pointer produce no link. Never
 * enumerates the sessions root: only the session file and
 * `<sessionDir>/children.jsonl` are read, and never throws.
 *
 * Results are cached per (summary identity, children.jsonl size:mtimeMs):
 * repeated `/api/session` polls over unchanged files reuse the links instead
 * of re-reading and re-matching the sidecar every second.
 */
export function collectSessionLinks(deps: {
	sessionFile: string | null;
	sessionDir: string | null;
}): SessionLink[] {
	// No session file -> no receipts and no call to match pointers against.
	if (deps.sessionFile === null) return [];
	const session = readSessionSummary(deps.sessionFile);
	const key = childrenStatKey(deps.sessionDir);
	const cached = linksCache.get(session);
	if (cached !== undefined && cached.key === key) return cached.links;

	const links: SessionLink[] = [];
	const claimedCallIds = new Set<string>();
	for (const result of session.results) {
		const receipt = parseReceipt(result.text);
		if (receipt === null || claimedCallIds.has(result.toolCallId)) continue;
		claimedCallIds.add(result.toolCallId);
		const call = session.toolCalls.get(result.toolCallId);
		links.push({
			toolCallId: result.toolCallId,
			childTaskId: receipt.childId,
			agent: call?.agent ?? receipt.receiptAgent ?? "",
			task: call?.task ?? "",
			source: "receipt",
		});
	}
	const pointers = deps.sessionDir !== null ? readChildPointers(deps.sessionDir) : [];
	for (const pointer of pointers) {
		const call = session.callOrder.find(
			(candidate) =>
				!claimedCallIds.has(candidate.id) &&
				(candidate.agent ?? "").trim() === (pointer.agent ?? "").trim() &&
				(candidate.task ?? "").trim() === (pointer.task ?? "").trim(),
		);
		if (call === undefined) continue;
		claimedCallIds.add(call.id);
		links.push({
			toolCallId: call.id,
			childTaskId: pointer.childTaskId,
			agent: pointer.agent,
			task: pointer.task,
			source: "pointer",
		});
	}
	linksCache.set(session, { key, links });
	return links;
}

// ---------------------------------------------------------------------------
// Node construction
// ---------------------------------------------------------------------------

function resolveStartedAt(ctx: TreeContext, info: DirInfo | null, call: ParsedToolCall | undefined): number {
	const headerTs = info?.sessionFile ? readSessionSummary(info.sessionFile).headerTs : null;
	if (headerTs !== null) return headerTs;
	if (info?.dirMtime ?? null) return info?.dirMtime as number;
	if (info?.fileMtime ?? null) return info?.fileMtime as number;
	if (call && call.ts > 0) return call.ts;
	return ctx.now;
}

/**
 * A pointer node is anchored at the newest pointer row's startedAt (the
 * re-dispatch time). The child session headerTs must not stand in for it:
 * a stale receipt comparison would otherwise misjudge a re-dispatched child.
 * The header/mtime chain only backstops a degenerate startedAt of 0.
 */
function resolvePointerStartedAt(ctx: TreeContext, info: DirInfo | null, pointer: ChildPointer): number {
	if (Number.isFinite(pointer.startedAt) && pointer.startedAt > 0) return pointer.startedAt;
	const headerTs = info?.sessionFile ? readSessionSummary(info.sessionFile).headerTs : null;
	if (headerTs !== null) return headerTs;
	if (info?.dirMtime ?? null) return info?.dirMtime as number;
	if (info?.fileMtime ?? null) return info?.fileMtime as number;
	return ctx.now;
}

/**
 * Status priority, highest first (each step mirrors the acceptance cases of
 * test/subagent-web-tree.test.ts):
 *
 *   1. registry lists this childId as `running` -> running (beats every other
 *      signal, including a sync receipt and a completedTasks record);
 *   2. a pointer row exists for this childId and no sync receipt postdates the
 *      newest pointer's startedAt -> running. The pointer is the in-flight
 *      marker; a sync receipt older than the newest pointer is stale (another
 *      run's receipt) and must not judge finished. Fallback: once the child
 *      session's lastEntryTs exists and is older than POINTER_STALE_WINDOW_MS
 *      (10 min), degrade to recent, so a genuinely crashed child cannot sit
 *      at running forever; without a lastEntryTs the node stays running;
 *   3. a sync receipt postdating the pointer startedAt (or no pointer at
 *      all) -> finished, finishedAt = the receipt toolResult line's ts;
 *   4. a completedTasks record -> finished, finishedAt = the record value;
 *   5. the child session's lastEntryTs inside [now - RECENT_WINDOW_MS, now]
 *      (10 s) -> recent; a future lastEntryTs is outside the window;
 *   6. otherwise -> finished, finishedAt = lastEntryTs ?? startedAt fallback —
 *      except a node at depth >= 1 (grandchild and below; direct main-session
 *      dispatches sit at depth 0) linked by an async receipt only: with
 *      neither a sync receipt nor a pointer there is no positive completion
 *      signal, so the last-entry fallback must not certify the legacy nested
 *      dispatch and it is "pending" (no finishedAt) instead. Depth 0, and a
 *      link carrying a sync receipt or pointer that still reaches this step,
 *      keep the finished fallback.
 *
 * Error results short-circuit straight after the registry check: their
 * rejected / failed classification is the latest event and never falls
 * through to steps 3-6. An async receipt only means "dispatched": it is never
 * a completion signal on its own. File mtime is no longer a status signal at
 * all (it only picks the newest `.jsonl` and backstops startedAt).
 */
function resolveStatus(
	ctx: TreeContext,
	taskId: string,
	depth: number,
	info: DirInfo | null,
	fallbackFinishedAt: number,
	link: DispatchLink,
): { status: SessionTreeNode["status"]; finishedAt?: number } {
	if (ctx.registry.get(taskId)?.status === "running") return { status: "running" };
	if (link.source === "result") {
		// A result line without a real timestamp parses to ts=0; it must not
		// become a frozen finishedAt (the UI would render "0s" instead of
		// "—"). Same defence as the sync receipt branch's receiptTs > 0.
		const errTs = link.errorTs !== undefined && link.errorTs > 0 ? link.errorTs : undefined;
		return { status: link.errorStatus === "failed" ? "failed" : "rejected", finishedAt: errTs };
	}

	const lastEntryTs = info?.sessionFile ? readSessionSummary(info.sessionFile).lastEntryTs : null;

	if (link.pointer !== undefined && link.receiptKind !== "sync") {
		if (lastEntryTs !== null && ctx.now - lastEntryTs > POINTER_STALE_WINDOW_MS) return { status: "recent" };
		return { status: "running" };
	}

	if (link.receiptKind === "sync") {
		const receiptTs = link.receiptTs !== undefined && link.receiptTs > 0 ? link.receiptTs : null;
		return { status: "finished", finishedAt: receiptTs ?? fallbackFinishedAt };
	}

	const record = ctx.completedTasks.get(taskId);
	if (record !== undefined) return { status: "finished", finishedAt: record.finishedAt };
	// The fallback window is [now - RECENT_WINDOW_MS, now]: a lastEntryTs in
	// the future (clock skew) is not "recent" and falls through to the
	// finished fallback, so the status cannot flap purely because the wall
	// clock moved within a pinned-now fixture.
	if (lastEntryTs !== null && lastEntryTs <= ctx.now && ctx.now - lastEntryTs <= RECENT_WINDOW_MS) {
		return { status: "recent" };
	}
	// A nested (depth >= 1) node whose link still reaches here has no positive
	// completion signal: sync receipts returned in step 4, pointer rows in
	// step 3, and an async receipt merely means "dispatched". The last-entry
	// fallback must not certify such a legacy chain finished.
	if (depth >= 1 && link.pointer === undefined) return { status: "pending" };
	return { status: "finished", finishedAt: lastEntryTs ?? fallbackFinishedAt };
}

/**
 * Apply a level budget. In ascending mode (every level of the main session
 * tree) the level is always returned in ascending `startedAt` order with ties
 * in discovery order, truncated or not; when the level produced more nodes
 * than allowed, the `budget` nodes with the newest `startedAt` are kept.
 * `alwaysAscending: false` preserves the legacy behaviour of the explicit
 * expand endpoint (discovery order while within budget, newest-N ascending
 * when truncated).
 */
function selectNewest(nodes: SessionTreeNode[], budget: number, alwaysAscending: boolean): SessionTreeNode[] {
	if (!alwaysAscending && nodes.length <= budget) return nodes;
	const ranked = nodes.map((node, index) => ({ node, index }));
	if (ranked.length > budget) {
		ranked.sort((a, b) => b.node.startedAt - a.node.startedAt || a.index - b.index);
		ranked.length = budget;
	}
	ranked.sort((a, b) => a.node.startedAt - b.node.startedAt || a.index - b.index);
	return ranked.map((entry) => entry.node);
}

/**
 * Cut `text` to TASK_TEXT_MAX code points; a shorter text is returned
 * unchanged. Counts by Unicode code points (`Array.from`), never UTF-16 code
 * units, so a non-BMP character is never split into a lone high/low surrogate.
 */
function truncateTaskText(text: string): string {
	const codePoints = Array.from(text);
	return codePoints.length > TASK_TEXT_MAX ? codePoints.slice(0, TASK_TEXT_MAX).join("") : text;
}

/** Cut `node.task` to TASK_TEXT_MAX code points, flagging the cut. */
function truncateTask(node: SessionTreeNode): void {
	const truncated = truncateTaskText(node.task);
	if (truncated !== node.task) {
		node.task = truncated;
		node.taskTruncated = true;
	}
}

/**
 * Orphan protection: a session that ends with a `subagent` toolCall whose
 * toolResult never landed was cut off mid-dispatch (crash / kill), so its
 * finished status must not hide an in-flight child. `callOrder` holds every
 * parsed `subagent` toolCall; the last one having no result in `results`
 * marks the abnormal ending.
 */
function endedAbnormally(sessionFile: string | null): boolean {
	if (sessionFile === null) return false;
	const session = readSessionSummary(sessionFile);
	if (session.callOrder.length === 0) return false;
	const lastCall = session.callOrder[session.callOrder.length - 1];
	return !session.results.some((result) => result.toolCallId === lastCall.id);
}

/**
 * Lazy fallback child fields: the sidecar pointer count of the node's own
 * session directory (0 without a directory or a file). The "all finished"
 * wording is only truthful for a `finished` node; every other unscanned
 * status (running / recent / pending / failed / rejected, including nodes
 * left unscanned by the depth limit) gets the neutral plural wording.
 */
function unscannedChildFields(
	sessionDir: string | null,
	status: SessionTreeNode["status"],
): { childCount: number; childSummary: string } {
	if (sessionDir === null) return { childCount: 0, childSummary: "" };
	const count = readChildPointers(sessionDir).length;
	if (count === 0) return { childCount: 0, childSummary: "" };
	const plural = count === 1 ? "1 child" : `${count} children`;
	return {
		childCount: count,
		childSummary: status === "finished" ? `${plural} · all finished` : plural,
	};
}

/**
 * Fill a node's task truncation and child fields. Children are scanned
 * immediately only for running / recent nodes and for orphan-protected
 * (abnormally ended) sessions; finished / failed / pending nodes stay lazy
 * and report their pointer count instead.
 */
function finalizeNode(ctx: TreeContext, node: SessionTreeNode, info: DirInfo | null, depth: number): void {
	truncateTask(node);
	const scan = node.status === "running" || node.status === "recent" || endedAbnormally(info?.sessionFile ?? null);
	if (scan && depth < MAX_DEPTH && info !== null) {
		const children = buildLevel(ctx, info.dir, info.sessionFile, depth + 1).nodes;
		node.children = children;
		node.childCount = children.length;
		node.childSummary = childSummary(children);
		return;
	}
	const lazy = unscannedChildFields(info?.dir ?? null, node.status);
	node.children = [];
	node.childCount = lazy.childCount;
	node.childSummary = lazy.childSummary;
}

/**
 * Display fields of one linked child, resolved exactly as `buildLevel` did
 * inline before: agent / task / startedAt by link source, then the status
 * classification. Shared by the tree build and the path query so both agree.
 */
interface LinkFields {
	agent: string;
	task: string;
	startedAt: number;
	status: { status: SessionTreeNode["status"]; finishedAt?: number };
}

function resolveLinkFields(ctx: TreeContext, link: DispatchLink, depth: number, info: DirInfo | null): LinkFields {
	const registryEntry = ctx.registry.get(link.childId);
	let agent: string;
	let task: string;
	let startedAt: number;
	if (link.source === "pointer" && link.pointer !== undefined) {
		agent = link.pointer.agent;
		task = link.pointer.task;
		startedAt = resolvePointerStartedAt(ctx, info, link.pointer);
	} else {
		agent =
			link.call?.agent ??
			link.receiptAgent ??
			(typeof registryEntry?.agentName === "string" ? registryEntry.agentName : "subagent");
		task = link.call?.task ?? (typeof registryEntry?.task === "string" ? registryEntry.task : "");
		startedAt = resolveStartedAt(ctx, info, link.call);
	}
	return { agent, task, startedAt, status: resolveStatus(ctx, link.childId, depth, info, startedAt, link) };
}

/** One level build: every discovered node plus the budgeted public list. */
interface LevelResult {
	/** Nodes discovered at this level before the budget was applied. */
	total: number;
	nodes: SessionTreeNode[];
}

function buildLevel(
	ctx: TreeContext,
	sessionDir: string | null,
	sessionFile: string | null,
	depth: number,
	alwaysAscending = true,
): LevelResult {
	if (depth > MAX_DEPTH) return { total: 0, nodes: [] };
	const links = collectDispatchLinks(ctx, sessionDir, sessionFile);
	const all: SessionTreeNode[] = [];
	for (const link of links) {
		// Unknown links carry no childId: they are never deduped, so several
		// receipt-less dispatches can coexist at the same level.
		if (link.childId !== "" && ctx.seen.has(link.childId)) continue;
		if (link.childId !== "") ctx.seen.add(link.childId);

		// Explicit defence: only a rejected dispatch may produce a node without a
		// child id. A `failed` result whose diagnostics carry no `[subagent
		// session: <id>]` suffix must never surface as a taskId:"" failed node
		// (it names no session to open). Drop it here, before it consumes a
		// level budget slot.
		if (link.source === "result" && link.childId === "" && link.errorStatus === "failed") continue;

		if (link.source === "unknown") {
			const call = link.call;
			const startedAt = call && call.ts > 0 ? call.ts : ctx.now;
			// Waiting for a receipt: an independent "pending" state, never a
			// finished one, and no finishedAt until the link is resolved.
			const node: SessionTreeNode = {
				taskId: "",
				agent: call?.agent ?? "subagent",
				task: call?.task ?? "",
				depth,
				status: "pending",
				linkSource: "unknown",
				startedAt,
				children: [],
				childCount: 0,
				childSummary: "",
			};
			finalizeNode(ctx, node, null, depth);
			all.push(node);
			continue;
		}

		if (link.source === "result" && link.childId === "") {
			// Rejected dispatch: no child session exists, so no directory lookup
			// and no recursion; taskId stays "" (unless the error named one).
			const call = link.call;
			const node: SessionTreeNode = {
				taskId: "",
				agent: call?.agent ?? "subagent",
				task: call?.task ?? "",
				depth,
				status: "rejected",
				linkSource: "result",
				startedAt: call && call.ts > 0 ? call.ts : ctx.now,
				children: [],
				childCount: 0,
				childSummary: "",
			};
			if (link.errorTs !== undefined && link.errorTs > 0) node.finishedAt = link.errorTs;
			if (link.reason !== undefined) node.reason = link.reason;
			if (link.errorText !== undefined) node.errorText = link.errorText;
			finalizeNode(ctx, node, null, depth);
			all.push(node);
			continue;
		}

		const info = getTaskDir(ctx, link.childId);
		const fields = resolveLinkFields(ctx, link, depth, info);
		const status = fields.status;

		const node: SessionTreeNode = {
			taskId: link.childId,
			agent: fields.agent,
			task: fields.task,
			depth,
			status: status.status,
			linkSource: link.source,
			startedAt: fields.startedAt,
			children: [],
			childCount: 0,
			childSummary: "",
		};
		if (status.finishedAt !== undefined) node.finishedAt = status.finishedAt;
		if (link.reason !== undefined) node.reason = link.reason;
		if (link.errorText !== undefined) node.errorText = link.errorText;
		finalizeNode(ctx, node, info, depth);
		all.push(node);
	}
	const budget = depth === 0 ? MAX_ROOT_NODES : MAX_CHILD_NODES;
	return { total: all.length, nodes: selectNewest(all, budget, alwaysAscending) };
}

/**
 * Build the subagent session tree rooted at the main session's dispatch
 * records with the top-level truncation report. Returns a zeroed result when
 * there is no main session file. Never throws: unreadable dirs/files/fixtures
 * degrade individual nodes.
 */
export function buildSessionTreeResult(deps: BuildTreeDeps): BuildTreeResult {
	if (deps.mainSessionFile === null) {
		return { nodes: [], truncated: { total: 0, showing: 0, dropped: 0 } };
	}
	const ctx: TreeContext = {
		rootDir: deps.rootDir,
		now: deps.now ?? Date.now(),
		registry: deps.registry,
		completedTasks: deps.completedTasks ?? new Map(),
		taskDirs: new Map(),
		seen: new Set(),
	};
	// The main session (depth 0) has no own session directory: it never reads
	// a children.jsonl. Pointer files are only consulted for subagent levels.
	const level = buildLevel(ctx, null, deps.mainSessionFile, 0);
	return {
		nodes: level.nodes,
		truncated: {
			total: level.total,
			showing: level.nodes.length,
			dropped: level.total - level.nodes.length,
		},
	};
}

/**
 * Build the subagent session tree rooted at the main session's dispatch
 * records. Returns [] when there is no main session file. Never throws:
 * unreadable dirs/files/fixtures degrade individual nodes.
 */
export function buildSessionTree(deps: BuildTreeDeps): SessionTreeNode[] {
	return buildSessionTreeResult(deps).nodes;
}

// ---------------------------------------------------------------------------
// Path query
// ---------------------------------------------------------------------------

/**
 * One hop of a `/api/path` breadcrumb: the display fields of one task on the
 * ancestor chain, or of the target itself. `task` is cut to TASK_TEXT_MAX
 * code points exactly like `SessionTreeNode.task`.
 */
export interface PathSegment {
	taskId: string;
	agent: string;
	task: string;
	status: string;
}

/** Display segment of one linked child, without any child scan or budget. */
function pathSegmentOf(ctx: TreeContext, link: DispatchLink, depth: number, info: DirInfo | null): PathSegment {
	const fields = resolveLinkFields(ctx, link, depth, info);
	return {
		taskId: link.childId,
		agent: fields.agent,
		task: truncateTaskText(fields.task),
		status: fields.status.status,
	};
}

/**
 * Recursive DFS half of `buildSessionPath`: walk one level's links, descend
 * into a node only when its session actually has dispatch links (candidate-
 * branch pruning) and return on the first match (early exit). `visited`
 * mirrors the display build's one-node-per-childId rule, so a repeated child
 * is searched at its first occurrence only and a cyclic pointer cannot loop;
 * because a childId is never visited twice, the walk terminates without any
 * depth gate — the display-layer MAX_DEPTH must not bound a path query.
 */
function findPathInLevel(
	ctx: TreeContext,
	links: DispatchLink[],
	targetTaskId: string,
	depth: number,
	ancestors: PathSegment[],
	visited: Set<string>,
): { path: PathSegment[]; node: PathSegment } | null {
	for (const link of links) {
		// Links without a childId (unknown / rejected dispatches) have no task
		// directory to descend into and no id a query could name.
		if (link.childId === "" || visited.has(link.childId)) continue;
		visited.add(link.childId);
		const info = getTaskDir(ctx, link.childId);
		const segment = pathSegmentOf(ctx, link, depth, info);
		if (link.childId === targetTaskId) return { path: ancestors, node: segment };
		// A session without dispatch links cannot contain the target: never
		// descend past it.
		if (info === null) continue;
		const childLinks = collectDispatchLinks(ctx, info.dir, info.sessionFile);
		if (childLinks.length === 0) continue;
		ancestors.push(segment);
		const found = findPathInLevel(ctx, childLinks, targetTaskId, depth + 1, ancestors, visited);
		if (found !== null) return found;
		ancestors.pop();
	}
	return null;
}

/**
 * Ancestor breadcrumb of one taskId: `path` is the chain from the topmost
 * root (dispatched directly by the main session) down to the target's direct
 * parent, root first and excluding the target; `node` is the target's own
 * segment. A root target yields `path: []`; a target unreachable from the
 * session tree yields `found: false` with `path: []` and `node: null`.
 *
 * Display budgets (MAX_ROOT_NODES / MAX_CHILD_NODES via `selectNewest`) and
 * the lazy-scan rule are bypassed on purpose: every candidate level is
 * inspected in full and finished / pending nodes are descended into, so a
 * breadcrumb exists for tasks the display tree never rendered. The walk is
 * deduplicated per childId (`visited`), which also guarantees termination
 * (a pointer cycle cannot loop) and deliberately imposes no display depth
 * limit, so a target below MAX_DEPTH stays reachable. Never throws: a null
 * main session or an unreadable task directory / sidecar just makes a branch
 * look empty.
 */
export function buildSessionPath(
	deps: BuildTreeDeps,
	targetTaskId: string,
): { found: boolean; path: PathSegment[]; node: PathSegment | null } {
	if (deps.mainSessionFile === null) return { found: false, path: [], node: null };
	const ctx: TreeContext = {
		rootDir: deps.rootDir,
		now: deps.now ?? Date.now(),
		registry: deps.registry,
		completedTasks: deps.completedTasks ?? new Map(),
		taskDirs: new Map(),
		// Unused by this path query: the walk dedups through its own `visited`
		// set below; `seen` belongs to the display build (`buildLevel`).
		seen: new Set(),
	};
	// The main session (depth 0) has no own session directory, exactly as in
	// buildSessionTreeResult: it never reads a children.jsonl.
	const roots = collectDispatchLinks(ctx, null, deps.mainSessionFile);
	const found = findPathInLevel(ctx, roots, targetTaskId, 0, [], new Set());
	if (found === null) return { found: false, path: [], node: null };
	return { found: true, path: found.path, node: found.node };
}

/** Bounded LRU of expand results; oldest entry evicted on overflow. */
const SUBTREE_CACHE_LIMIT = 64;
/**
 * Coarse `now` bucket of the expand cache key: a cached subtree is only served
 * within the same bucket, so a purely time-driven status change (pointer
 * liveness degrading `running` -> `recent`) takes effect once `now` crosses a
 * bucket boundary while repeated expands inside one bucket still hit the
 * cache. 5 s is well below the 10 min pointer-stale window.
 */
const SUBTREE_NOW_BUCKET_MS = 5000;

/** One cached expand result: the nodes plus the stat snapshot they were built from. */
interface SubtreeCacheEntry {
	nodes: SessionTreeNode[];
	/** `path -> statChangeKey` of every file read while building `nodes`. */
	files: Array<[string, string]>;
}
const subtreeCache = new Map<string, SubtreeCacheEntry>();

/** `size:mtimeMs` change key of one file, or "none"/"missing". */
function statChangeKey(filePath: string | null): string {
	if (filePath === null) return "none";
	try {
		const stat = fs.statSync(filePath);
		return `${stat.size}:${stat.mtimeMs}`;
	} catch {
		return "missing";
	}
}

/**
 * Content summary of the in-process registry. Any change to a record's
 * status / agent / task changes the string, so a registry update invalidates
 * cached expand results even when every file on disk is untouched.
 */
function registrySummary(registry: Map<string, { status?: string; agentName?: string; task?: string }>): string {
	return [...registry]
		.map(([id, entry]) => `${id}:${entry.status ?? ""}:${entry.agentName ?? ""}:${entry.task ?? ""}`)
		.sort()
		.join(",");
}

/** Content summary of the completedTasks snapshot, status included. */
function completedTasksSummary(completedTasks: ReadonlyMap<string, CompletedTaskInfo> | undefined): string {
	if (completedTasks === undefined) return "none";
	return [...completedTasks]
		.map(([id, record]) => `${id}:${record.status ?? ""}:${record.finishedAt}`)
		.sort()
		.join(",");
}

/**
 * Cache key of one expanded subtree: the session file and its sidecar
 * children.jsonl change keys plus the registry / completedTasks content
 * summaries. The file keys are stats only (no readdir), so a cache hit
 * serves the previous scan without touching any task directory, while a
 * registry / completedTasks change (status included) is never replayed from
 * a stale entry.
 */
function subtreeCacheKey(deps: SubtreeDeps, now: number): string {
	const childrenKey =
		deps.sessionDir !== null ? statChangeKey(path.join(deps.sessionDir, CHILDREN_FILE_NAME)) : "none";
	const nowBucket = Math.floor(now / SUBTREE_NOW_BUCKET_MS);
	return `${deps.sessionDir ?? "none"}|${statChangeKey(deps.sessionFile)}|${childrenKey}|${registrySummary(deps.registry)}|${completedTasksSummary(deps.completedTasks)}|${nowBucket}`;
}

/**
 * Re-check a cached entry against the filesystem with stats only: `true` when
 * every recorded file still has the same `statChangeKey`. Never reads a
 * directory, so an unchanged subtree keeps the "cache hit -> no task-dir
 * readdir" contract, while a changed descendant session file (or a newly
 * appearing / vanishing sidecar) forces a rebuild.
 */
function subtreeFilesUnchanged(entry: SubtreeCacheEntry): boolean {
	for (const [filePath, changeKey] of entry.files) {
		if (statChangeKey(filePath) !== changeKey) return false;
	}
	return true;
}

/**
 * Stat snapshot of every file one built subtree was derived from: the session
 * file and children.jsonl of every returned node's task dir (recursively),
 * plus the expanded session file and its own sidecar. The session files come
 * from the build's own `ctx.taskDirs`, so exactly the files that were read are
 * re-checked. Missing paths are recorded with the "none"/"missing" semantics
 * of `statChangeKey`, so a later appearance also invalidates the entry.
 */
function collectSubtreeFiles(ctx: TreeContext, deps: SubtreeDeps, nodes: SessionTreeNode[]): Array<[string, string]> {
	const files = new Map<string, string>();
	const add = (filePath: string | null): void => {
		if (filePath === null || files.has(filePath)) return;
		files.set(filePath, statChangeKey(filePath));
	};
	const visit = (list: SessionTreeNode[]): void => {
		for (const node of list) {
			if (node.taskId !== "") {
				add(ctx.taskDirs.get(node.taskId)?.sessionFile ?? null);
				add(path.join(ctx.rootDir, node.taskId, CHILDREN_FILE_NAME));
			}
			visit(node.children);
		}
	};
	visit(nodes);
	add(deps.sessionFile);
	add(deps.sessionDir !== null ? path.join(deps.sessionDir, CHILDREN_FILE_NAME) : null);
	return [...files];
}

/**
 * Direct children of one explicit expand request (depth based at 1). Results
 * are cached by the sessionFile/children.jsonl stats so a repeated expand of
 * an unchanged subtree never re-scans; the cache is a bounded LRU. A hit
 * additionally re-stats every file the cached build read, so a descendant
 * session change inside one now bucket still forces a rebuild. The direct
 * children keep their discovery order while within budget (the frozen
 * expand contract); only an over-budget list is reordered ascending. Never
 * throws (readers are best-effort).
 */
export function buildSubtree(deps: SubtreeDeps): SessionTreeNode[] {
	const now = deps.now ?? Date.now();
	const key = subtreeCacheKey(deps, now);
	const cached = subtreeCache.get(key);
	if (cached !== undefined && subtreeFilesUnchanged(cached)) {
		subtreeCache.delete(key);
		subtreeCache.set(key, cached);
		return cached.nodes;
	}
	const ctx: TreeContext = {
		rootDir: deps.rootDir,
		now,
		registry: deps.registry,
		completedTasks: deps.completedTasks ?? new Map(),
		taskDirs: new Map(),
		seen: new Set(),
	};
	const nodes = buildLevel(ctx, deps.sessionDir, deps.sessionFile, 1, false).nodes;
	const entry: SubtreeCacheEntry = { nodes, files: collectSubtreeFiles(ctx, deps, nodes) };
	subtreeCache.delete(key);
	subtreeCache.set(key, entry);
	if (subtreeCache.size > SUBTREE_CACHE_LIMIT) {
		const oldest = subtreeCache.keys().next().value;
		if (oldest !== undefined) subtreeCache.delete(oldest);
	}
	return nodes;
}

/** Test-isolation hook: the expand cache is process-wide. */
export function resetSubtreeCacheForTests(): void {
	subtreeCache.clear();
}
