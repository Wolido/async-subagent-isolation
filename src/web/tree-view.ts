/**
 * Pure view helpers for the sidebar tree.
 *
 * These functions are inlined verbatim into `PAGE_HTML` through
 * `Function.prototype.toString()` (same pattern as `escapeRawHtml`), so each
 * one must be self-contained: no imports, no module-level constants, no
 * side effects, no DOM access. Unit tests live in
 * `test/subagent-web-tree-view.test.ts`.
 */

/**
 * Aggregated summary of a node's children, e.g. `"3 children · 2 running · 1
 * failed"`. The total counts every child (including `finished` and unknown
 * statuses); the status segments list only the five countable statuses in the
 * fixed order running, recent, pending, rejected, failed, and only when their
 * count is > 0. No children -> `""`.
 */
export function childSummary(children: ReadonlyArray<{ status?: string }>): string {
	if (children.length === 0) return "";
	const order = ["running", "recent", "pending", "rejected", "failed"];
	const counts: Record<string, number> = {};
	for (const status of order) counts[status] = 0;
	for (const child of children) {
		const status = child && typeof child.status === "string" ? child.status : "";
		if (Object.prototype.hasOwnProperty.call(counts, status)) counts[status] += 1;
	}
	let text = children.length === 1 ? "1 child" : children.length + " children";
	for (const status of order) {
		if (counts[status] > 0) text += " · " + counts[status] + " " + status;
	}
	return text;
}

/**
 * Sidebar scroll target for the first render after the page opens.
 * `nodes` is in render order (oldest first, i.e. the order `renderList`
 * receives): the last `running` node wins, otherwise the last node. Returns
 * `null` when a deep-linked `selectedTaskId` is present in the list (the deep
 * link already decides what is on screen) and when the chosen node has no
 * non-empty taskId, so callers never scroll to a row they cannot find.
 */
export function scrollTargetTaskId(
	nodes: ReadonlyArray<{ taskId?: string; status?: string }>,
	selectedTaskId: string | null,
): string | null {
	if (selectedTaskId) {
		for (let i = 0; i < nodes.length; i += 1) {
			if (nodes[i].taskId === selectedTaskId) return null;
		}
	}
	let chosen: { taskId?: string; status?: string } | null = null;
	for (let i = 0; i < nodes.length; i += 1) {
		if (nodes[i].status === "running") chosen = nodes[i];
	}
	if (!chosen) chosen = nodes.length > 0 ? nodes[nodes.length - 1] : null;
	if (!chosen) return null;
	const id = typeof chosen.taskId === "string" ? chosen.taskId : "";
	return id !== "" ? id : null;
}

/**
 * One-line breadcrumb label for a task. The task text is a dispatch prompt
 * (the server keeps up to 200 code points), so it is whitespace-collapsed and
 * bounded to 40 characters (37 + "..."): a prompt rendered verbatim wraps the
 * crumb bar into a paragraph, which makes the breadcrumb look like page
 * content and pushes the current segment out of view. Falls back to the
 * taskId's first 8 characters when the task text is missing or blank, and
 * returns `""` when neither is available.
 */
export function crumbLabel(task: unknown, taskId: string): string {
	const text = typeof task === "string" ? task.replace(/\s+/g, " ").trim() : "";
	const id = typeof taskId === "string" ? taskId : "";
	const value = text === "" ? id.slice(0, 8) : text;
	if (value.length <= 40) return value;
	return value.slice(0, 37).trimEnd() + "...";
}

/**
 * Ancestor taskId chain of `taskId`, root first down to its direct parent
 * (the target itself is excluded). Returns `[]` when the target is a root or
 * not present, and skips intermediate nodes whose taskId is an empty string.
 */
export function ancestorIds(nodes: ReadonlyArray<{ taskId?: string; children?: any[] }>, taskId: string): string[] {
	const stack: Array<{ node: any; path: string[] }> = [];
	for (let i = nodes.length - 1; i >= 0; i -= 1) stack.push({ node: nodes[i], path: [] });
	while (stack.length > 0) {
		const entry = stack.pop();
		if (!entry || !entry.node) continue;
		const id = typeof entry.node.taskId === "string" ? entry.node.taskId : "";
		if (id !== "" && id === taskId) return entry.path;
		const nextPath = id !== "" ? entry.path.concat(id) : entry.path;
		const children = entry.node.children;
		if (Array.isArray(children)) {
			for (let i = children.length - 1; i >= 0; i -= 1) stack.push({ node: children[i], path: nextPath });
		}
	}
	return [];
}

/**
 * Sidebar row that represents the current task while the sidebar lists only
 * depth-1 tasks. The root ancestor of the current branch (depth ≥ 2) owns the
 * active row; a depth-1 task is its own row. `path` is the server
 * `/api/path` chain and `ancestors` the client-side `ancestorIds` fallback;
 * both accept `{ taskId }` objects or plain strings and skip empty segments.
 * Returns `null` for a missing taskId and never throws, so the inlined page
 * code can call it unguarded.
 */
export function lineageRowId(taskId: string | null, path: unknown, ancestors: ReadonlyArray<string>): string | null {
	if (typeof taskId !== "string" || taskId === "") return null;
	const normalize = (segments: unknown): string[] => {
		const ids: string[] = [];
		if (!Array.isArray(segments)) return ids;
		for (let i = 0; i < segments.length; i += 1) {
			const segment = segments[i] as { taskId?: unknown } | string | null | undefined;
			const id = segment && typeof segment === "object" ? segment.taskId : segment;
			if (typeof id === "string" && id !== "") ids.push(id);
		}
		return ids;
	};
	const chain = normalize(path);
	if (chain.length > 0) return chain[0];
	const fallback = normalize(ancestors);
	if (fallback.length > 0) return fallback[0];
	return taskId;
}

/**
 * One-line suffix for the highlighted ancestor row, e.g.
 * `"↳ researcher · 01a12d39"`: the current deep task's agent (falling back to
 * `"subagent"` when missing, blank or not a string) plus the first 8
 * characters of its taskId (shorter ids pass through unchanged).
 */
export function lineageLabel(agent: unknown, taskId: string): string {
	const name = typeof agent === "string" ? agent.trim() : "";
	const id = typeof taskId === "string" ? taskId : "";
	return "↳ " + (name === "" ? "subagent" : name) + " · " + id.slice(0, 8);
}

/**
 * Elapsed duration of one tree node in ms, or `null` when a terminal node has
 * no usable finish timestamp. Terminal statuses (`finished` / `rejected` /
 * `failed`) freeze at `finishedAt − startedAt` and never accumulate with
 * `nowMs`; every other status grows from `startedAt` to `nowMs`. A missing
 * startedAt counts as 0, an invalid finishedAt (NaN / non-number / non-finite)
 * yields `null`, and an invalid nowMs falls back to `Date.now()`. Self-
 * contained for inlining into PAGE_HTML; never throws.
 */
export function durationMs(
	node: { status?: string; startedAt?: number; finishedAt?: number },
	nowMs: number,
): number | null {
	const status = node && typeof node.status === "string" ? node.status : "";
	const start = node && typeof node.startedAt === "number" && Number.isFinite(node.startedAt) ? node.startedAt : 0;
	if (status === "finished" || status === "rejected" || status === "failed") {
		const finishedAt = node ? node.finishedAt : undefined;
		if (typeof finishedAt !== "number" || !Number.isFinite(finishedAt)) return null;
		return Math.max(0, finishedAt - start);
	}
	const now = Number.isFinite(nowMs) ? nowMs : Date.now();
	return Math.max(0, now - start);
}

/**
 * Direct parent (the last non-empty segment) of a task, used by the `← Back`
 * button and `Alt+←`. `path` is the server-side `/api/path` chain (segments
 * are `{ taskId }` objects or plain strings); `ancestors` is the client-side
 * `ancestorIds` fallback used when the server path yields no segment yet (a
 * cold deep link). Returns `null` for a top-level task (both chains empty) and
 * for unknown input shapes — never throws, so the inlined page code can call
 * it unguarded.
 */
export function backTarget(path: unknown, ancestors: string[]): string | null {
	const ids: string[] = [];
	if (Array.isArray(path)) {
		for (let i = 0; i < path.length; i += 1) {
			const segment = path[i] as { taskId?: unknown } | string | null | undefined;
			const id = segment && typeof segment === "object" ? segment.taskId : segment;
			if (typeof id === "string" && id !== "") ids.push(id);
		}
	}
	if (ids.length > 0) return ids[ids.length - 1];
	const fallback: string[] = [];
	if (Array.isArray(ancestors)) {
		for (let i = 0; i < ancestors.length; i += 1) {
			const segment = ancestors[i] as { taskId?: unknown } | string | null | undefined;
			const id = segment && typeof segment === "object" ? segment.taskId : segment;
			if (typeof id === "string" && id !== "") fallback.push(id);
		}
	}
	return fallback.length > 0 ? fallback[fallback.length - 1] : null;
}

/**
 * Sidebar scroll anchor: the first row (in index order) whose bottom edge is
 * still below `listTop`, i.e. the topmost row the container shows. A
 * partially occluded row counts, so `offset` (row top − container top) may be
 * negative. `scrollTop` rides through untouched so the caller can pair the
 * anchor with the scroll position it was captured at. Rows without a usable
 * `getBoundingClientRect` (missing, null rect, non-finite top/bottom) are
 * skipped and every invalid number normalizes instead of throwing, so the
 * inlined page code can call it unguarded. `rows` may be an array or any
 * array-like (a live `NodeList` from the page).
 */
export function sidebarScrollAnchor(
	rows: ArrayLike<unknown>,
	listTop: number,
	scrollTop: number,
): { taskId: string; offset: number; scrollTop: number } {
	const scroll = typeof scrollTop === "number" && Number.isFinite(scrollTop) ? scrollTop : 0;
	const empty = { taskId: "", offset: 0, scrollTop: scroll };
	if (!rows || typeof rows.length !== "number") return empty;
	const top = typeof listTop === "number" && Number.isFinite(listTop) ? listTop : 0;
	for (let i = 0; i < rows.length; i += 1) {
		const row = rows[i] as {
			dataset?: { taskId?: unknown };
			getBoundingClientRect?: () => { top?: unknown; bottom?: unknown } | null;
		} | null | undefined;
		if (!row || typeof row.getBoundingClientRect !== "function") continue;
		const rect = row.getBoundingClientRect();
		if (!rect) continue;
		const rectTop = typeof rect.top === "number" && Number.isFinite(rect.top) ? rect.top : Number.NaN;
		const rectBottom = typeof rect.bottom === "number" && Number.isFinite(rect.bottom) ? rect.bottom : Number.NaN;
		if (!Number.isFinite(rectTop) || !Number.isFinite(rectBottom)) continue;
		if (!(rectBottom > top)) continue;
		return {
			taskId: row.dataset && typeof row.dataset.taskId === "string" ? row.dataset.taskId : "",
			offset: rectTop - top,
			scrollTop: scroll,
		};
	}
	return empty;
}

/**
 * Scroll top that keeps `anchor` pinned at its captured pixel offset after a
 * rebuild: when the anchor row is still rendered (`dataset.taskId` match), the
 * scroll shifts by the row's own movement (`rowTop − listTop`), so a column
 * that did not move returns `currentScrollTop` verbatim; when the row is gone
 * (or the anchor carries no taskId) it falls back to the raw captured
 * `scrollTop`. The result is clamped to `[0, maxScrollTop]`, invalid numbers
 * normalize instead of propagating, and nothing here ever throws.
 */
export function sidebarRestoreScrollTop(
	anchor: unknown,
	rows: ArrayLike<unknown>,
	listTop: number,
	currentScrollTop: number,
	maxScrollTop: number,
): number {
	const source = (anchor && typeof anchor === "object" ? anchor : {}) as {
		taskId?: unknown;
		offset?: unknown;
		scrollTop?: unknown;
	};
	const taskId = typeof source.taskId === "string" ? source.taskId : "";
	const offset = typeof source.offset === "number" && Number.isFinite(source.offset) ? source.offset : 0;
	const saved = typeof source.scrollTop === "number" && Number.isFinite(source.scrollTop) ? source.scrollTop : 0;
	const current = typeof currentScrollTop === "number" && Number.isFinite(currentScrollTop) ? currentScrollTop : 0;
	const max = typeof maxScrollTop === "number" && Number.isFinite(maxScrollTop) ? maxScrollTop : 0;
	const top = typeof listTop === "number" && Number.isFinite(listTop) ? listTop : 0;
	let next = saved;
	if (taskId !== "" && rows && typeof rows.length === "number") {
		for (let i = 0; i < rows.length; i += 1) {
			const row = rows[i] as {
				dataset?: { taskId?: unknown };
				getBoundingClientRect?: () => { top?: unknown } | null;
			} | null | undefined;
			if (!row || !row.dataset || row.dataset.taskId !== taskId) continue;
			if (typeof row.getBoundingClientRect !== "function") continue;
			const rect = row.getBoundingClientRect();
			if (!rect || typeof rect.top !== "number" || !Number.isFinite(rect.top)) continue;
			next = current + (rect.top - top) - offset;
			break;
		}
	}
	return Math.max(0, Math.min(next, Math.max(0, max)));
}

/**
 * Decode the persisted sidebar anchor. Anything that is not a JSON object
 * (unparsable text, `null`, arrays, primitives, non-string input) yields
 * `null`, and a decoded object's fields are normalized like
 * `sidebarRestoreScrollTop`: a non-string taskId and non-finite numbers fall
 * back to their empty/zero defaults. Never throws.
 */
export function parseSidebarAnchor(raw: unknown): { taskId: string; offset: number; scrollTop: number } | null {
	if (typeof raw !== "string") return null;
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch (error) {
		return null;
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
	const value = parsed as { taskId?: unknown; offset?: unknown; scrollTop?: unknown };
	return {
		taskId: typeof value.taskId === "string" ? value.taskId : "",
		offset: typeof value.offset === "number" && Number.isFinite(value.offset) ? value.offset : 0,
		scrollTop: typeof value.scrollTop === "number" && Number.isFinite(value.scrollTop) ? value.scrollTop : 0,
	};
}

/**
 * Encode the sidebar anchor for localStorage. Fields are normalized first
 * (same defaults as `parseSidebarAnchor`) so `Infinity`/`NaN` become `0`
 * instead of `null`, and the keys are always emitted in the fixed order
 * taskId, offset, scrollTop so equal anchors produce equal strings. Non-object
 * input serializes the empty anchor.
 */
export function serializeSidebarAnchor(anchor: unknown): string {
	const value = (anchor && typeof anchor === "object" ? anchor : {}) as {
		taskId?: unknown;
		offset?: unknown;
		scrollTop?: unknown;
	};
	return JSON.stringify({
		taskId: typeof value.taskId === "string" ? value.taskId : "",
		offset: typeof value.offset === "number" && Number.isFinite(value.offset) ? value.offset : 0,
		scrollTop: typeof value.scrollTop === "number" && Number.isFinite(value.scrollTop) ? value.scrollTop : 0,
	});
}
