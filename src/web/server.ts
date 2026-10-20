/**
 * Local HTTP server for the subagent session viewer.
 *
 * Serves the self-contained page plus three JSON endpoints:
 *
 *   GET /            -> PAGE_HTML
 *   GET /api/tree    -> session tree of the main session's subagent tasks
 *   GET /api/session -> incremental JSONL transcript for one taskId
 *   GET /api/path    -> ancestor breadcrumb path of one taskId
 *
 * Security: loopback-only binding, Host/Origin pinning (anti DNS rebinding)
 * and a per-run bearer token in the `t` query parameter. A `taskId` is
 * contained under `rootDir` (lexically and via realpath) before the UUID
 * shape check, so `../` traversal and symlink escapes are rejected with 403.
 *
 * The server is a process-wide singleton on `globalThis.__piSubagentWebServer`
 * so a `/reload` can take over the live port and token instead of dropping
 * open viewer tabs. Node built-ins only (zero runtime dependencies).
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as http from "node:http";
import * as path from "node:path";
import { API_VERSION } from "./api-version.ts";
import { CHILDREN_FILE_NAME } from "./children.ts";
import { MAX_IMAGE_BYTES, lookupImage, stripImages } from "./images.ts";
import { PAGE_HTML } from "./page.ts";
import { createTailReader, readBefore } from "./tail.ts";
import { buildSessionPath, buildSessionTreeResult, buildSubtree, collectSessionLinks } from "./tree.ts";
import type { CompletedTaskInfo } from "./tree.ts";

export interface WebServerHandle {
	port: number;
	url: string;
	token: string;
	close(): Promise<void>;
}

export interface StartWebServerOptions {
	mainSessionFile: () => string | null;
	registry: Map<string, { status?: string; agentName?: string; task?: string }>;
	rootDir: string;
	validateTaskId?: (taskId: unknown) => string | null;
	resolveSessionDir?: (taskId: string) => string;
	findSessionFile?: (taskId: string) => string | null;
	/** Per-image byte cap for `/api/image`; defaults to `MAX_IMAGE_BYTES`. */
	maxImageBytes?: number;
	/** Loopback port to bind; omitted or 0 picks a random ephemeral port. */
	port?: number;
	/** Per-request snapshot of in-process finished tasks for `/api/tree`. */
	completedTasks?: () => ReadonlyMap<string, CompletedTaskInfo>;
}

/**
 * Minimal structural view of a connection socket, enough for close() and
 * avoiding an extra node:net import.
 */
interface ConnectionSocket {
	destroy(): void;
	on(event: "close", listener: () => void): unknown;
}

/** Process-wide singleton state; `opts` is swapped on `/reload` take-over. */
interface WebServerSingleton {
	server: http.Server;
	token: string;
	port: number;
	opts: StartWebServerOptions;
	closed: boolean;
	sockets: Set<ConnectionSocket>;
	/** Resolves once `listen` succeeded; rejects when binding failed. */
	ready: Promise<void>;
	/** Public handle, filled in once the bound port is known. */
	handle: WebServerHandle | null;
}

type TailReader = ReturnType<typeof createTailReader>;
type SendJson = (status: number, value: unknown, headers?: http.OutgoingHttpHeaders) => void;

const SINGLETON_KEY = "__piSubagentWebServer";
const JSON_CONTENT_TYPE = "application/json; charset=utf-8";
const HTML_CONTENT_TYPE = "text/html; charset=utf-8";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * One-shot wide window for `?before=` backfill. Only used when the default
 * window returns nothing because a single line outgrew it; never the default
 * window (`tail.ts`'s 8 MiB chase constant stays untouched).
 */
const WIDE_BACKFILL_BYTES = 32 * 1024 * 1024;

// ---------------------------------------------------------------------------
// taskId containment and defaults
// ---------------------------------------------------------------------------

function defaultValidateTaskId(taskId: unknown): string | null {
	return typeof taskId === "string" && UUID_RE.test(taskId) ? null : "Invalid taskId";
}

/** Resolve `<rootDir>/<taskId>` and refuse to leave the sessions root. */
function defaultResolveSessionDir(rootAbs: string): (taskId: string) => string {
	return (taskId: string) => {
		const dir = path.resolve(rootAbs, taskId);
		if (!isWithin(rootAbs, dir)) throw new Error("taskId escapes the sessions root");
		return dir;
	};
}

/** Newest `.jsonl` inside a task directory, or null when there is none. */
function newestSessionFile(dir: string): string | null {
	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(dir, { withFileTypes: true });
	} catch {
		return null;
	}
	let newest: string | null = null;
	let newestMtime = -Infinity;
	for (const entry of entries) {
		if (!entry.isFile() || !entry.name.endsWith(".jsonl") || entry.name === CHILDREN_FILE_NAME) continue;
		const filePath = path.join(dir, entry.name);
		try {
			const mtime = fs.statSync(filePath).mtimeMs;
			if (mtime > newestMtime) {
				newestMtime = mtime;
				newest = filePath;
			}
		} catch {
			/* unreadable entry: skip */
		}
	}
	return newest;
}

/** Path is `parent` itself or nested inside it (pure lexical check). */
function isWithin(parent: string, child: string): boolean {
	const relative = path.relative(parent, child);
	return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

/**
 * Realpath containment: the closest existing ancestor of `target` must
 * resolve inside the realpath of `rootAbs`. Needed on macOS where /var is a
 * symlink to /private/var, and for task dirs that are symlinks escaping the
 * sessions root. A missing target is fine (lexical containment already held),
 * but an unresolvable root fails closed.
 */
function isRealpathWithin(rootAbs: string, target: string): boolean {
	let realRoot: string;
	try {
		realRoot = fs.realpathSync(rootAbs);
	} catch {
		return false;
	}
	let current = path.resolve(target);
	for (;;) {
		try {
			return isWithin(realRoot, fs.realpathSync(current));
		} catch {
			const parent = path.dirname(current);
			if (parent === current) return true;
			current = parent;
		}
	}
}

/** Constant-time bearer token check; unequal lengths are rejected up front. */
function tokenMatches(actual: string | null, expected: string): boolean {
	if (actual === null) return false;
	const actualBytes = Buffer.from(actual, "utf-8");
	const expectedBytes = Buffer.from(expected, "utf-8");
	if (actualBytes.length !== expectedBytes.length) return false;
	return crypto.timingSafeEqual(actualBytes, expectedBytes);
}

function parseOffset(raw: string | null): number {
	if (raw === null) return 0;
	const value = Number(raw);
	return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

/**
 * `before` backward cursor: a non-negative integer, anything else falls back
 * to 0 (which `readBefore` treats as "empty window"). Out-of-range values are
 * clamped against the file size inside `readBefore`, never rejected.
 */
function parseBefore(raw: string | null): number {
	if (raw === null || !/^\d+$/.test(raw)) return 0;
	const value = Number(raw);
	return Number.isSafeInteger(value) ? value : 0;
}

/**
 * Cheap input fingerprint of `/api/tree`: main session `size:mtimeMs`,
 * rootDir mtime, the registry's id:status:agent:task summary, the
 * completedTasks id:status:finishedAt summary and the raw `expand` parameter.
 * Unlike the body alone, it changes when an input that does not alter the
 * visible body changed (a main-session note, a new task directory, a registry
 * / completedTasks record outside the tree), which the historical ETag
 * contract requires. No tree build and no directory scan involved.
 *
 * @param completedTasks the per-request snapshot, so fingerprint and build
 *   always observe the same map
 */
function treeInputKey(
	opts: StartWebServerOptions,
	expand: string | null,
	completedTasks: ReadonlyMap<string, CompletedTaskInfo> | undefined,
): string {
	let mainSession = "none";
	const mainSessionFile = opts.mainSessionFile();
	if (mainSessionFile !== null) {
		try {
			const stat = fs.statSync(mainSessionFile);
			mainSession = `${stat.size}:${stat.mtimeMs}`;
		} catch {
			mainSession = "missing";
		}
	}
	let rootMtime = "none";
	try {
		rootMtime = String(fs.statSync(opts.rootDir).mtimeMs);
	} catch {
		/* unreadable rootDir -> stable "none" */
	}
	const registryPart = [...opts.registry]
		.map(([id, entry]) => `${id}:${entry.status ?? ""}:${entry.agentName ?? ""}:${entry.task ?? ""}`)
		.sort()
		.join(",");
	const completedPart = completedTasks
		? [...completedTasks]
				.map(([id, record]) => `${id}:${record.status ?? ""}:${record.finishedAt}`)
				.sort()
				.join(",")
		: "none";
	return `${mainSession}|${rootMtime}|${registryPart}|${completedPart}|${expand ?? "none"}`;
}

// ---------------------------------------------------------------------------
// Request handling
// ---------------------------------------------------------------------------

function createRequestHandler(state: WebServerSingleton, tailReader: TailReader): http.RequestListener {
	return (req, res) => {
		const send = (
			status: number,
			body: string,
			contentType: string,
			extraHeaders?: http.OutgoingHttpHeaders,
		): void => {
			res.writeHead(status, {
				"Content-Type": contentType,
				"Cache-Control": "no-store",
				"Referrer-Policy": "no-referrer",
				...extraHeaders,
			});
			res.end(body);
		};
		const sendJson: SendJson = (status, value, headers) =>
			send(status, JSON.stringify(value), JSON_CONTENT_TYPE, headers);

		try {
			// Validation order: method -> Host -> Origin -> token.
			if (req.method !== "GET") {
				sendJson(405, { error: "Method not allowed" });
				return;
			}
			const hostOk = new RegExp(`^(127\\.0\\.0\\.1|localhost|\\[::1\\]):${state.port}$`).test(req.headers.host ?? "");
			if (!hostOk) {
				sendJson(403, { error: "Forbidden" });
				return;
			}
			const origin = req.headers.origin;
			if (origin !== undefined && !new RegExp(`^http://(127\\.0\\.0\\.1|localhost|\\[::1\\]):${state.port}$`).test(origin)) {
				sendJson(403, { error: "Forbidden" });
				return;
			}
			let url: URL;
			try {
				url = new URL(req.url ?? "/", `http://127.0.0.1:${state.port}`);
			} catch {
				// Malformed request target (e.g. `GET //`): 400, never an uncaught
				// ERR_INVALID_URL that would take the whole process down.
				sendJson(400, { error: "Bad request" });
				return;
			}
			if (!tokenMatches(url.searchParams.get("t"), state.token)) {
				sendJson(403, { error: "Forbidden" });
				return;
			}

			// Options are read per request so a `/reload` take-over swaps them live.
			const opts = state.opts;
			if (url.pathname === "/") {
				send(200, PAGE_HTML, HTML_CONTENT_TYPE);
				return;
			}
			if (url.pathname === "/api/tree") {
				// `?expand=<taskId>` is validated before the conditional-request
				// check, so a bad parameter never answers 304 off a stale ETag.
				const expandId = url.searchParams.get("expand");
				let expandedDir: string | null = null;
				let expandedFile: string | null = null;
				if (expandId !== null) {
					const resolved = resolveTaskDir(state, expandId, sendJson);
					if (resolved === null) return;
					expandedDir = resolved.sessionDir;
					expandedFile = (opts.findSessionFile ?? (() => newestSessionFile(resolved.sessionDir)))(expandId);
				}
				const completedTasks = opts.completedTasks?.();
				const tree = buildSessionTreeResult({
					mainSessionFile: opts.mainSessionFile(),
					registry: opts.registry,
					rootDir: opts.rootDir,
					completedTasks,
				});
				// Expand success only when the task session exists; a valid taskId
				// without a session keeps the tree answer and reports expand: null.
				const expand =
					expandId !== null && expandedFile !== null
						? {
								taskId: expandId,
								children: buildSubtree({
									rootDir: opts.rootDir,
									registry: opts.registry,
									completedTasks,
									sessionDir: expandedDir,
									sessionFile: expandedFile,
								}),
							}
						: null;
				const payload = { apiVersion: API_VERSION, nodes: tree.nodes, truncated: tree.truncated, expand };
				// ETag over the exact serialized body (any change that can alter the
				// response bytes - child sessions, children.jsonl, registry,
				// completedTasks, expand - is reflected) combined with the input
				// fingerprint, so an input change that leaves the body byte-identical
				// (main-session note, new task dir, out-of-tree registry record) also
				// invalidates the tag instead of wrongly answering 304.
				const body = JSON.stringify(payload);
				const etag = `"${crypto
					.createHash("sha1")
					.update(`${body}\n${treeInputKey(opts, expandId, completedTasks)}`)
					.digest("hex")}"`;
				if (req.headers["if-none-match"] === etag) {
					// Unchanged since the client's copy: 304 with an empty body.
					send(304, "", JSON_CONTENT_TYPE, { ETag: etag, "Cache-Control": "no-cache" });
					return;
				}
				send(200, body, JSON_CONTENT_TYPE, { ETag: etag, "Cache-Control": "no-cache" });
				return;
			}
			if (url.pathname === "/api/session") {
				handleSessionRequest(state, tailReader, url, sendJson);
				return;
			}
			if (url.pathname === "/api/path") {
				// Breadcrumb query: same taskId guard as /api/session, but a task
				// missing from the session tree is an answer (found: false), never a
				// 404 — the page resolves the path of a node it already displays.
				const taskId = url.searchParams.get("taskId");
				if (taskId === null) {
					sendJson(400, { error: "Missing taskId" });
					return;
				}
				const resolved = resolveTaskDir(state, taskId, sendJson);
				if (resolved === null) return;
				const pathResult = buildSessionPath(
					{
						mainSessionFile: opts.mainSessionFile(),
						registry: opts.registry,
						rootDir: opts.rootDir,
						completedTasks: opts.completedTasks?.(),
					},
					taskId,
				);
				sendJson(200, {
					apiVersion: API_VERSION,
					taskId,
					found: pathResult.found,
					path: pathResult.path,
					node: pathResult.node,
				});
				return;
			}
			if (url.pathname === "/api/image") {
				handleImageRequest(state, url, res, sendJson);
				return;
			}
			sendJson(404, { error: "Not found" });
		} catch {
			// Last-resort guard: a single bad request must never crash the process.
			if (res.headersSent) {
				res.end();
			} else {
				sendJson(500, { error: "Internal server error" });
			}
		}
	};
}

/**
 * Containment first (so `../` traversal is a 403 even for non-UUID ids), then
 * UUID shape (400): the shared taskId guard of `/api/session`, `/api/image`
 * and `/api/tree?expand=`. Sends the error response itself and returns null
 * when it did; a success returns the validated taskId and its session dir.
 */
function resolveTaskDir(
	state: WebServerSingleton,
	taskId: string,
	sendJson: SendJson,
): { taskId: string; sessionDir: string } | null {
	const opts = state.opts;
	const rootAbs = path.resolve(opts.rootDir);
	const lexicalDir = path.resolve(rootAbs, taskId);
	if (!isWithin(rootAbs, lexicalDir)) {
		sendJson(403, { error: "Forbidden" });
		return null;
	}

	const resolveSessionDir = opts.resolveSessionDir ?? defaultResolveSessionDir(rootAbs);
	let sessionDir: string;
	try {
		sessionDir = resolveSessionDir(taskId);
	} catch {
		sendJson(403, { error: "Forbidden" });
		return null;
	}
	if (!isWithin(rootAbs, path.resolve(sessionDir)) || !isRealpathWithin(rootAbs, sessionDir)) {
		sendJson(403, { error: "Forbidden" });
		return null;
	}

	const validateTaskId = opts.validateTaskId ?? defaultValidateTaskId;
	const invalid = validateTaskId(taskId);
	if (invalid !== null) {
		sendJson(400, { error: invalid });
		return null;
	}

	return { taskId, sessionDir };
}

/**
 * Resolve one `/api/session` / `/api/image` taskId to its session file: the
 * containment/UUID guard above, then existence (404). Returns null when an
 * error response was already sent.
 */
function resolveSessionFile(
	state: WebServerSingleton,
	url: URL,
	sendJson: SendJson,
): { taskId: string; filePath: string; sessionDir: string } | null {
	const taskId = url.searchParams.get("taskId");
	if (taskId === null) {
		sendJson(400, { error: "Missing taskId" });
		return null;
	}

	const resolved = resolveTaskDir(state, taskId, sendJson);
	if (resolved === null) return null;
	const { sessionDir } = resolved;
	const filePath = (state.opts.findSessionFile ?? (() => newestSessionFile(sessionDir)))(taskId);
	if (filePath === null) {
		sendJson(404, { error: "Session not found" });
		return null;
	}

	return { taskId, filePath, sessionDir };
}

/**
 * Drop `system` entries: both `entry.type === "system"` and
 * `entry.type === "message"` with `message.role === "system"`. Applied after
 * `stripImages`, so `imageRef.entryIndex` keeps pointing at the original JSONL
 * byte offset and filtering only shortens the `entries` array. The cursors
 * stay byte-level for the same reason: `nextOffset`/`size`/`mtime`,
 * `entriesStartOffset` and `hasMore` come from the reader's file-byte
 * window, never from the filtered array length, so the client's
 * next/previous-window arithmetic is unaffected by the stripped entries.
 *
 * @param entries entries already run through `stripImages`
 * @returns the entries without system headers/system-role messages
 */
function stripSystemEntries(entries: unknown[]): unknown[] {
	return entries.filter((entry) => {
		if (entry === null || typeof entry !== "object") return true;
		const record = entry as Record<string, unknown>;
		if (record.type === "system") return false;
		if (record.type === "message") {
			const message = record.message;
			if (message !== null && typeof message === "object" && (message as Record<string, unknown>).role === "system") {
				return false;
			}
		}
		return true;
	});
}

/** `GET /api/session` — incremental transcript with base64 images stripped. */
function handleSessionRequest(
	state: WebServerSingleton,
	tailReader: TailReader,
	url: URL,
	sendJson: SendJson,
): void {
	const resolved = resolveSessionFile(state, url, sendJson);
	if (resolved === null) return;

	const beforeRaw = url.searchParams.get("before");
	if (beforeRaw !== null) {
		// Backward window (client auto-backfill): independent of the forward
		// `offset` cursor. `offset`/`nextOffset` echo `before` so an old client
		// cannot mistake the response for a forward increment.
		const before = parseBefore(beforeRaw);
		let back = readBefore(resolved.filePath, before);
		if (back === null) {
			sendJson(404, { error: "Session not found" });
			return;
		}
		// A line larger than the default window yields no complete entry (empty
		// `entries` + `oversizeLine`) but still a bounded backward cursor. Retry
		// once with a wide window to pull that line in together with the complete
		// lines before it; the wide result only replaces a strictly backward one.
		if (back.entries.length === 0 && back.oversizeLine) {
			const wide = readBefore(resolved.filePath, before, WIDE_BACKFILL_BYTES);
			if (wide !== null && wide.startOffset < before) back = wide;
		}
		sendJson(200, {
			taskId: resolved.taskId,
			apiVersion: API_VERSION,
			offset: before,
			nextOffset: before,
			size: back.size,
			mtime: back.mtime,
			links: collectSessionLinks({ sessionFile: resolved.filePath, sessionDir: resolved.sessionDir }),
			// `entryOffsets` are absolute byte offsets, so the stripped imageRefs
			// keep resolving through `/api/image` exactly like the forward path.
			entries: stripSystemEntries(stripImages(back.entries, back.entryOffsets)),
			malformed: back.malformed,
			truncatedBefore: back.startOffset > 0,
			hasMore: false,
			oversizeLine: back.oversizeLine,
			entriesStartOffset: back.startOffset,
		});
		return;
	}

	const offset = parseOffset(url.searchParams.get("offset"));
	const result = tailReader.read({
		taskId: resolved.taskId,
		filePath: resolved.filePath,
		offset,
		tail: url.searchParams.get("tail") === "1",
	});
	if (result === null) {
		sendJson(404, { error: "Session not found" });
		return;
	}
	sendJson(200, {
		taskId: resolved.taskId,
		apiVersion: API_VERSION,
		offset,
		nextOffset: result.nextOffset,
		size: result.size,
		mtime: result.mtime,
		// Transcript nav links of this task's own session: receipts plus the
		// pointers under its own session directory.
		links: collectSessionLinks({ sessionFile: resolved.filePath, sessionDir: resolved.sessionDir }),
		// Base64 image data never reaches the client; each image part is
		// replaced by an imageRef the page resolves lazily via /api/image.
		// System entries are stripped afterwards, without touching the
		// byte-level cursors above.
		entries: stripSystemEntries(stripImages(result.entries, result.entryOffsets)),
		malformed: result.malformed,
		truncatedBefore: result.truncatedBefore,
		hasMore: result.hasMore,
		// Minor-4: the tail reader already computes this and it is useful
		// client-side diagnostics, so expose it instead of dropping it.
		oversizeLine: result.oversizeLine,
		// Backfill cursor: the file byte offset of this response's first entry;
		// when the response carries no entries, the window start this read began
		// at (never the requested offset blindly, which would pin tail reads at 0).
		entriesStartOffset: result.entryOffsets.length > 0 ? result.entryOffsets[0] : result.startOffset,
	});
}

/** Non-negative integer query parameter in `/^\d+$/` and safe-number form. */
function parseIndexParam(raw: string | null): number | null {
	if (raw === null || !/^\d+$/.test(raw)) return null;
	const value = Number(raw);
	return Number.isSafeInteger(value) ? value : null;
}

/** `GET /api/image` — raw bytes of one image block, fetched on demand. */
function handleImageRequest(
	state: WebServerSingleton,
	url: URL,
	res: http.ServerResponse,
	sendJson: SendJson,
): void {
	const resolved = resolveSessionFile(state, url, sendJson);
	if (resolved === null) return;

	const entry = parseIndexParam(url.searchParams.get("entry"));
	if (entry === null) {
		sendJson(400, { error: "Invalid entry" });
		return;
	}
	const block = parseIndexParam(url.searchParams.get("block"));
	if (block === null) {
		sendJson(400, { error: "Invalid block" });
		return;
	}

	const result = lookupImage(
		resolved.filePath,
		entry,
		block,
		state.opts.maxImageBytes ?? MAX_IMAGE_BYTES,
	);
	if (result.kind === "not-found") {
		sendJson(404, { error: "Image not found" });
		return;
	}
	if (result.kind === "too-large") {
		sendJson(413, { error: "Image too large", byteLength: result.byteLength });
		return;
	}

	res.writeHead(200, {
		"Content-Type": result.mimeType,
		"Content-Length": String(result.data.length),
		"Cache-Control": "no-store",
		"Referrer-Policy": "no-referrer",
	});
	res.end(result.data);
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

/**
 * Start (or take over) the loopback web server. When a live singleton exists
 * (same process after `/reload`) its port and token are kept and only the
 * options reference is swapped, so open viewer tabs stay valid.
 */
export async function startWebServer(opts: StartWebServerOptions): Promise<WebServerHandle> {
	const existing = (globalThis as any)[SINGLETON_KEY] as WebServerSingleton | undefined;
	if (existing !== undefined && !existing.closed) {
		existing.opts = opts;
		// A concurrent start may still be binding: wait for its port/handle.
		await existing.ready;
		return existing.handle ?? makeHandle(existing);
	}

	const state: WebServerSingleton = {
		server: undefined as unknown as http.Server,
		token: crypto.randomBytes(16).toString("hex"),
		port: 0,
		opts,
		closed: false,
		sockets: new Set<ConnectionSocket>(),
		ready: Promise.resolve(),
		handle: null,
	};
	const server = http.createServer(createRequestHandler(state, createTailReader()));
	state.server = server;
	server.on("connection", (socket) => {
		state.sockets.add(socket);
		socket.on("close", () => {
			state.sockets.delete(socket);
		});
	});

	let resolveReady: () => void = () => {};
	let rejectReady: (error: unknown) => void = () => {};
	state.ready = new Promise<void>((resolve, reject) => {
		resolveReady = resolve;
		rejectReady = reject;
	});
	// Swallow the rejection for callers that never await `ready`; the startup
	// path itself observes the original error and no unhandled rejection leaks.
	state.ready.catch(() => {});

	// Publish the placeholder synchronously, before `listen`, so a concurrent
	// call takes over this state instead of binding a second server.
	(globalThis as any)[SINGLETON_KEY] = state;

	try {
		await new Promise<void>((resolve, reject) => {
			const onError = (error: Error): void => reject(error);
			server.once("error", onError);
			server.listen(opts.port ?? 0, "127.0.0.1", () => {
				server.removeListener("error", onError);
				resolve();
			});
		});
	} catch (error) {
		// Binding failed: drop the placeholder so a later call can start fresh.
		if ((globalThis as any)[SINGLETON_KEY] === state) {
			delete (globalThis as any)[SINGLETON_KEY];
		}
		rejectReady(error);
		throw error;
	}

	const address = server.address();
	state.port = typeof address === "object" && address !== null ? address.port : 0;
	state.handle = makeHandle(state);
	resolveReady();
	return state.handle;
}

/**
 * The live process-wide singleton handle, or `null` when no server is running
 * (never started, still binding, or already closed).
 */
export function getGlobalServer(): WebServerHandle | null {
	const state = (globalThis as any)[SINGLETON_KEY] as WebServerSingleton | undefined;
	if (state === undefined || state.closed || state.handle === null) return null;
	return state.handle;
}

function makeHandle(state: WebServerSingleton): WebServerHandle {
	return {
		port: state.port,
		token: state.token,
		url: `http://127.0.0.1:${state.port}/?t=${state.token}`,
		close: () => closeWebServer(state),
	};
}

/** Idempotent: stop listening, drop tracked sockets and the singleton. */
function closeWebServer(state: WebServerSingleton): Promise<void> {
	if (state.closed) return Promise.resolve();
	state.closed = true;
	for (const socket of state.sockets) socket.destroy();
	state.sockets.clear();
	if ((globalThis as any)[SINGLETON_KEY] === state) {
		delete (globalThis as any)[SINGLETON_KEY];
	}
	return new Promise<void>((resolve) => {
		state.server.close(() => resolve());
	});
}
