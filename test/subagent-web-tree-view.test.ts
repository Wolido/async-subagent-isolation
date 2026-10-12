/**
 * 红阶段测试：`src/web/tree-view.ts` —— /subagent-web 页面纯逻辑抽取出的可单测模块
 * （函数源码会以 `.toString()` 内联进页面，实现必须自包含、无 import）。
 * 模块已存在，既有用例保持绿；本轮新增导出 lineageRowId / lineageLabel 尚未
 * 实现，对应用例经动态 import 加载、缺失时抛明确说明（本文件可正常收集，
 * 不让新缺口把既有用例拖成整体红）。
 *
 * 被测接口（固定签名，实现者照此实现）：
 *   childSummary(children: ReadonlyArray<{ status?: string }>): string
 *   ancestorIds(nodes: ReadonlyArray<{ taskId?: string; children?: any[] }>, taskId: string): string[]
 *   scrollTargetTaskId(nodes: ReadonlyArray<{ taskId?: string; status?: string }>, selectedTaskId: string | null): string | null
 *   backTarget(path: unknown, ancestors: string[]): string | null
 *   lineageRowId(taskId: string | null, path: unknown, ancestors: ReadonlyArray<string>): string | null
 *   lineageLabel(agent: unknown, taskId: string): string
 *   durationMs(node: { status?: string; startedAt?: number; finishedAt?: number }, nowMs: number): number | null
 *
 *   backTarget（本轮 C：← Back 仅 depth ≥ 2 出现）：
 *     - path 为服务端 /api/path 的段数组（[{taskId,agent,task,status}, …]）
 *       或字符串数组；归一化 = 每节取 taskId（对象取 .taskId、字符串原样），
 *       过滤空串；返回归一化链的最后一节 = 直接上级 taskId；path 归一化
 *       结果为空时，回退归一化 ancestors（调用方用 ancestorIds 构造）并取
 *       其末节；
 *     - 两者都空（顶层任务，depth 1）→ null；非数组/undefined 输入按空
 *       处理（不抛），再走 ancestors 回退；经 .toString() 内联进页面，
 *       必须自包含（不引用模块外符号）。
 *
 *   scrollTargetTaskId（用户口径修订 B：打开页面自动滚到最新，仅首次渲染）：
 *     - nodes 为渲染顺序（最旧→最新，即 renderList 的传入顺序）；
 *     - selectedTaskId 非空且 nodes 中存在同 taskId 节点 → null（深链优先，
 *       不自动滚动）；
 *     - 否则取最后一个 status === "running" 节点；没有 running 取最后一个节点；
 *       返回其非空 taskId，taskId 为空 → null；
 *     - 空数组 → null。
 *
 *   lineageRowId（本轮 A 谱系高亮：侧栏只列 depth-1 任务，当前任务 depth ≥ 2
 *     时把其 depth-1 祖先行置为选中态）：
 *     - taskId 空（null）→ null（无从高亮）；
 *     - 归一化 path（对象段取 .taskId、字符串段原样、过滤空串）非空 → 返回
 *       首节 path[0]（depth ≥ 2 的根祖先 = depth-1 祖先行）；
 *     - path 归一化为空时归一化 ancestors（过滤空串）非空 → 返回首节
 *       ancestors[0]（服务端 path 未到达时的树内回退）；
 *     - 两者皆空（depth 1）→ 返回 taskId 自身（当前行即选中行，无后缀）；
 *     - 非数组/undefined 输入按空处理、不抛；经 .toString() 内联进页面，必须
 *       自包含。
 *   lineageLabel（选中行尾部位置后缀）：
 *     - 形状 "↳ " + agent + " · " + taskId.slice(0, 8)；
 *     - agent 非「去空白后的非空字符串」（缺失 / 纯空白 / 非字符串）→ 回退
 *       "subagent"；
 *     - taskId 不足 8 位时 slice 原样返回（不抛）。
 *   durationMs（本轮 B：rejected/failed 耗时不得累积，经 .toString() 内联）：
 *     - 终态（finished / rejected / failed）：finishedAt 为有限 number →
 *       返回 max(0, finishedAt − (startedAt || 0))（与 nowMs 无关的固定值）；
 *       finishedAt 缺失或非法（NaN / 非 number / 非有限）→ null（页面显示 "—"）；
 *     - 非终态（running / recent / pending 及其它）：返回
 *       max(0, nowMs − (startedAt || 0))（随时间累积）；
 *     - startedAt 缺失按 0 处理，不抛。
 *
 * 语义（逐条编码成用例）：
 *   childSummary:
 *     - 空数组 → ""；
 *     - 恰 1 个子节点 → "1 child"（单数），N 个 → "N children"（复数），
 *       总数计入**全部**子节点（含 finished 与未知状态）；
 *     - 状态段只统计 running/recent/pending/rejected/failed 五种，固定顺序
 *       running → recent → pending → rejected → failed，且只列 count > 0 的段；
 *       finished 段永远省略；
 *     - 未知/缺失 status 只计入总数、不产生状态段。
 *   ancestorIds:
 *     - 返回目标 taskId 的祖先 id 链（根 → 直接父），不含目标本身；
 *     - 目标是根节点或不在树中 → []；
 *     - 路径上 taskId 为空串的中间节点跳过（不进结果）。
 *   注：pruneCollapsed 随侧栏折叠功能整体退役（信息架构 A 侧栏扁平化），
 *   函数与用例一并删除，页面不再内联其源码。
 *
 * 约定（沿仓库惯例，同 test/subagent-web-children.test.ts）：globals:false 显式
 * import from "vitest"；纯函数、不依赖文件系统与真实时钟。
 */

import { describe, expect, it } from "vitest";
import { ancestorIds, backTarget, childSummary, crumbLabel, scrollTargetTaskId } from "../src/web/tree-view.ts";

// ---------------------------------------------------------------------------
// 本轮新增导出的动态加载（红阶段 lineageRowId / lineageLabel 尚未实现）
// 缺失时抛带明确说明的错误而非 TypeError；既有用例不受影响、保持绿。
// 写法沿用 test/subagent-web-links.test.ts / test/subagent-web-markdown.test.ts。
// ---------------------------------------------------------------------------

type LineageRowId = (taskId: string | null, path: unknown, ancestors: ReadonlyArray<string>) => string | null;
type LineageLabel = (agent: unknown, taskId: string) => string;

/** 动态加载 lineageRowId；未导出时抛出红阶段预期的明确错误。 */
async function loadLineageRowId(): Promise<LineageRowId> {
	const mod = (await import("../src/web/tree-view.ts")) as Record<string, unknown>;
	const fn = mod.lineageRowId;
	if (typeof fn !== "function") {
		throw new Error("lineageRowId 未从 src/web/tree-view.ts 导出（红阶段预期：需 coder 实现）");
	}
	return fn as LineageRowId;
}

/** 动态加载 lineageLabel；未导出时抛出红阶段预期的明确错误。 */
async function loadLineageLabel(): Promise<LineageLabel> {
	const mod = (await import("../src/web/tree-view.ts")) as Record<string, unknown>;
	const fn = mod.lineageLabel;
	if (typeof fn !== "function") {
		throw new Error("lineageLabel 未从 src/web/tree-view.ts 导出（红阶段预期：需 coder 实现）");
	}
	return fn as LineageLabel;
}

type DurationMs = (node: { status?: string; startedAt?: number; finishedAt?: number }, nowMs: number) => number | null;

/** 动态加载 durationMs；未导出时抛出红阶段预期的明确错误。 */
async function loadDurationMs(): Promise<DurationMs> {
	const mod = (await import("../src/web/tree-view.ts")) as Record<string, unknown>;
	const fn = mod.durationMs;
	if (typeof fn !== "function") {
		throw new Error("durationMs 未从 src/web/tree-view.ts 导出（红阶段预期：需 coder 实现）");
	}
	return fn as DurationMs;
}

// ================================================================
// childSummary
// ================================================================
describe("childSummary", () => {
	it("should return an empty string when there are no children", () => {
		// Arrange
		const children: Array<{ status?: string }> = [];

		// Act
		const summary = childSummary(children);

		// Assert
		expect(summary).toBe("");
	});

	it("should use the singular child label when the only child is finished", () => {
		// Arrange: 单数形式，且 finished 段不得出现
		const children = [{ status: "finished" }];

		// Act
		const summary = childSummary(children);

		// Assert
		expect(summary).toBe("1 child");
	});

	it("should omit the finished segment while still counting all children in the total", () => {
		// Arrange: running + finished + failed —— 总数 3（含 finished），
		// 状态段只列 running 与 failed
		const children = [{ status: "running" }, { status: "finished" }, { status: "failed" }];

		// Act
		const summary = childSummary(children);

		// Assert
		expect(summary).toBe("3 children · 1 running · 1 failed");
	});

	it("should list status segments in the fixed running, recent, pending, rejected, failed order when every kind is present", () => {
		// Arrange: 五种计数状态各 1 个 + finished 1 个 —— 总数 6，
		// 段顺序固定、finished 段省略
		const children = [
			{ status: "running" },
			{ status: "recent" },
			{ status: "pending" },
			{ status: "rejected" },
			{ status: "failed" },
			{ status: "finished" },
		];

		// Act
		const summary = childSummary(children);

		// Assert
		expect(summary).toBe("6 children · 1 running · 1 recent · 1 pending · 1 rejected · 1 failed");
	});

	it("should count unknown or missing statuses into the total without producing a status segment", () => {
		// Arrange: 未知 status 与缺失 status —— 只进总数，不产生状态段
		const children: Array<{ status?: string }> = [{ status: "weird" }, {}];

		// Act
		const summary = childSummary(children);

		// Assert
		expect(summary).toBe("2 children");
	});
});

// ================================================================
// ancestorIds
// ================================================================
describe("ancestorIds", () => {
	/** 深链树 a → b → c。 */
	const chain = [{ taskId: "a", children: [{ taskId: "b", children: [{ taskId: "c" }] }] }];

	it("should return the ancestor chain from the root down to the parent of a deep target", () => {
		// Act
		const ids = ancestorIds(chain, "c");

		// Assert: a、b 是 c 的祖先（不含 c 自身），根在前
		expect(ids).toEqual(["a", "b"]);
	});

	it("should return an empty array when the target is a root node", () => {
		// Act
		const ids = ancestorIds(chain, "a");

		// Assert: 根节点没有祖先
		expect(ids).toEqual([]);
	});

	it("should return an empty array when the target is not in the tree", () => {
		// Act
		const ids = ancestorIds(chain, "missing");

		// Assert: 不在树中 → 空数组（不抛错）
		expect(ids).toEqual([]);
	});

	it("should skip intermediate nodes whose taskId is an empty string", () => {
		// Arrange: a → "" → c 的路径，空串中间节点不进结果
		const tree = [{ taskId: "a", children: [{ taskId: "", children: [{ taskId: "c" }] }] }];

		// Act
		const ids = ancestorIds(tree, "c");

		// Assert: 只剩 a，空串节点被跳过
		expect(ids).toEqual(["a"]);
	});
});

// ================================================================
// crumbLabel
// ================================================================
describe("crumbLabel", () => {
	it("should collapse whitespace and newlines of a prompt into a single line", () => {
		// Arrange: 真实派发提示词形状（多段、含换行与缩进）
		const task = "MODE: quick\n\n背景：主 agent 需要回报天气。\n\n  要求：只给结论。";

		// Act
		const label = crumbLabel(task, "01a12d38-f151-7288-b3ec-15e4a77667cd");

		// Assert: 空白折叠为单空格，无换行残留
		// （提示词开头 "Task: " 不在本字段内，服务端下发的是任务正文）
		expect(label).toBe("MODE: quick 背景：主 agent 需要回报天气。 要求：只给结论。");
		expect(label).not.toMatch(/\n/);
	});

	it("should bound a long prompt to 40 characters (37 + ellipsis)", () => {
		// Arrange: 200 码点的服务端任务正文（页面 200 字上限的现实形状）
		const task = "看".repeat(200);

		// Act
		const label = crumbLabel(task, "01a12d38-f151-7288-b3ec-15e4a77667cd");

		// Assert: 不超一行的长度上限，并保留明确的截断标记
		expect(label.length).toBe(40);
		expect(label).toBe("看".repeat(37) + "...");
	});

	it("should keep a label of exactly 40 characters unchanged", () => {
		// Arrange
		const task = "x".repeat(40);

		// Act
		const label = crumbLabel(task, "01a12d38-f151-7288-b3ec-15e4a77667cd");

		// Assert: 边界值不截断、不加省略号
		expect(label).toBe(task);
	});

	it("should fall back to the taskId's first 8 characters when the task text is missing or blank", () => {
		// Arrange: 节点没有任务正文（服务端未下发）与纯空白正文两种形状
		const taskId = "01a12d39-0264-7f94-a382-84686f818c6f";

		// Act / Assert
		expect(crumbLabel(undefined, taskId)).toBe("01a12d39");
		expect(crumbLabel("   \n  ", taskId)).toBe("01a12d39");
	});

	it("should return an empty string when neither the task text nor the taskId is available", () => {
		// Arrange / Act / Assert: 无 taskId 的 unknown 节点不回退出 "undefined"
		expect(crumbLabel(undefined, "")).toBe("");
	});
});

// ================================================================
// backTarget
// ================================================================
describe("backTarget", () => {
	it("should return the direct parent (the last segment) when the server path is an array of segment objects", () => {
		// Arrange: /api/path 段形状 {taskId, agent, task, status}，两层祖先
		const path = [
			{ taskId: "01a12d38", agent: "root", task: "t0", status: "finished" },
			{ taskId: "01a12d39", agent: "mid", task: "t1", status: "running" },
		];

		// Act
		const back = backTarget(path, []);

		// Assert: 直接上级 = 归一化链的最后一节（不含当前任务自身）
		expect(back).toBe("01a12d39");
	});

	it("should return the last segment when the path is a plain string array", () => {
		// Arrange: 字符串段数组（归一化后原样）

		// Act
		const back = backTarget(["a", "b", "c"], []);

		// Assert
		expect(back).toBe("c");
	});

	it("should return null for an empty chain (top-level task, depth 1)", () => {
		// Arrange / Act: 祖先链为空
		const back = backTarget([], []);

		// Assert: 顶层任务没有直接上级 → null（Back 按钮不渲染）
		expect(back).toBeNull();
	});

	it("should filter out empty segments before picking the direct parent", () => {
		// Arrange: 混合段 + 空串段（含尾部空段）—— 末节必须是过滤后真正的末节
		const path = [{ taskId: "01a1" }, "", { taskId: "01a2" }, { taskId: "" }, ""];

		// Act
		const back = backTarget(path, []);

		// Assert: 空串段不参与，取 01a2 而非 ""
		expect(back).toBe("01a2");
	});

	it("should fall back to the last ancestors segment when the server path yields no segment", () => {
		// Arrange: 冷深链还没拿到服务端 path（或 path 全为空段）——
		// 调用方以 ancestorIds 构造的祖先链兜底

		// Act
		const back = backTarget([], ["01a1", "01a2"]);

		// Assert: path 归一化为空 → 取 ancestors 归一化后的末节
		expect(back).toBe("01a2");
	});

	it("should return null without throwing for a non-array or undefined path", () => {
		// Arrange / Act / Assert: 未知形状输入兕底为 null（不抛错）
		expect(backTarget(undefined, [])).toBeNull();
		expect(backTarget(null, [])).toBeNull();
		expect(backTarget("01a12d38", [])).toBeNull();
	});
});

// ================================================================
// scrollTargetTaskId
// ================================================================
describe("scrollTargetTaskId", () => {
	it("should return the last node's taskId when no node is running", () => {
		// Arrange: 无 running —— 取最后一个节点（渲染顺序最旧→最新）
		const nodes = [
			{ taskId: "task-a", status: "finished" },
			{ taskId: "task-b", status: "recent" },
		];

		// Act
		const target = scrollTargetTaskId(nodes, null);

		// Assert
		expect(target).toBe("task-b");
	});

	it("should return the last running node's taskId when several nodes are running", () => {
		// Arrange: 两个 running，末节点也是 running —— 选最后一个 running
		const nodes = [
			{ taskId: "task-a", status: "running" },
			{ taskId: "task-b", status: "finished" },
			{ taskId: "task-c", status: "running" },
		];

		// Act
		const target = scrollTargetTaskId(nodes, null);

		// Assert
		expect(target).toBe("task-c");
	});

	it("should return the last running node's taskId even when the running node sits in the middle", () => {
		// Arrange: running 在中间（其后还有已结束节点）—— 仍取最后一个 running，
		// 而不是末节点
		const nodes = [
			{ taskId: "task-a", status: "running" },
			{ taskId: "task-b", status: "running" },
			{ taskId: "task-c", status: "finished" },
		];

		// Act
		const target = scrollTargetTaskId(nodes, null);

		// Assert
		expect(target).toBe("task-b");
	});

	it("should return null when the deep-linked selected taskId exists in the list", () => {
		// Arrange: 深链选中 task-b（在列表中）—— 深链优先，不自动滚动；
		// 若非深链本例应按 running 规则返回 task-a
		const nodes = [
			{ taskId: "task-a", status: "running" },
			{ taskId: "task-b", status: "finished" },
		];

		// Act
		const target = scrollTargetTaskId(nodes, "task-b");

		// Assert
		expect(target).toBeNull();
	});

	it("should pick by the running-else-last rule when the selected taskId is not in the list", () => {
		// Arrange: selected 不在列表 —— 不阻断自动滚动，仍按 running/末节点规则
		const nodes = [
			{ taskId: "task-a", status: "finished" },
			{ taskId: "task-b", status: "running" },
		];

		// Act
		const target = scrollTargetTaskId(nodes, "task-missing");

		// Assert
		expect(target).toBe("task-b");
	});

	it("should return null for an empty node list", () => {
		// Arrange / Act
		const target = scrollTargetTaskId([], null);

		// Assert
		expect(target).toBeNull();
	});

	it("should return null when the chosen node has an empty taskId", () => {
		// Arrange: 无 running，末节点 taskId 为空串（unknown 节点）—— 无可滚动目标
		const nodes = [
			{ taskId: "task-a", status: "finished" },
			{ taskId: "", status: "pending" },
		];

		// Act
		const target = scrollTargetTaskId(nodes, null);

		// Assert
		expect(target).toBeNull();
	});
});

// ================================================================
// lineageRowId（本轮 A：depth ≥ 2 高亮其 depth-1 祖先行）
// ================================================================
describe("lineageRowId", () => {
	it("should return the taskId itself when both path and ancestors are empty (depth 1)", async () => {
		// Arrange: 顶层任务 —— 服务端 path 空、树内无祖先
		const lineageRowId = await loadLineageRowId();

		// Act
		const rowId = lineageRowId("01a12d39-0264-7f94-a382-84686f818c6f", [], []);

		// Assert: 本行即选中行（depth 1 的高亮目标）
		expect(rowId).toBe("01a12d39-0264-7f94-a382-84686f818c6f");
	});

	it("should return the root segment when path holds a single ancestor (depth 2)", async () => {
		// Arrange: depth-2 —— path = [root]
		const lineageRowId = await loadLineageRowId();

		// Act
		const rowId = lineageRowId("01a12d3b-0000-7000-8000-000000000002", ["01a12d3a-root"], ["01a12d3a-root"]);

		// Assert: depth-1 祖先行 = 链首
		expect(rowId).toBe("01a12d3a-root");
	});

	it("should return the root segment when path holds two ancestors (depth 3)", async () => {
		// Arrange: depth-3 —— path = [root, mid]（服务端段为 {taskId} 对象形状）
		const lineageRowId = await loadLineageRowId();

		// Act
		const rowId = lineageRowId("01a12d3c-0000-7000-8000-000000000003", [{ taskId: "root" }, { taskId: "mid" }], ["root", "mid"]);

		// Assert: 仍取链首（depth-1 祖先行），不是直接上级 mid
		expect(rowId).toBe("root");
	});

	it("should fall back to the first ancestors segment when the server path yields no segment", async () => {
		// Arrange: 冷深链 path 还没到达（或全为空段）—— 用树内祖先链回退
		const lineageRowId = await loadLineageRowId();

		// Act
		const rowId = lineageRowId("task-c", [], ["root", "mid"]);

		// Assert: 回退链的首节同样是 depth-1 祖先行
		expect(rowId).toBe("root");
	});

	it("should return the taskId when both chains normalize to empty", async () => {
		// Arrange: 两链的段全部为空串 —— 归一化后皆空，按 depth 1 处理
		const lineageRowId = await loadLineageRowId();

		// Act
		const rowId = lineageRowId("task-root", [{ taskId: "" }], [""]);

		// Assert: 无祖先可高亮 → 高亮自身行
		expect(rowId).toBe("task-root");
	});

	it("should filter empty segments out of both chains before picking the first one", async () => {
		// Arrange: 头部空串 + 空对象段夹杂 —— 首个归一化后的真实段是 root
		const lineageRowId = await loadLineageRowId();

		// Act
		const rowId = lineageRowId("task-c", ["", "root", { taskId: "" }, "mid"], ["", "root"]);

		// Assert: 空串段不参与，取 root 而非 ""
		expect(rowId).toBe("root");
	});

	it("should treat a non-array or undefined chain as empty without throwing", async () => {
		// Arrange: 未知形状输入（非数组 / undefined / null）
		const lineageRowId = await loadLineageRowId();

		// Act / Assert: path 非数组按空处理，回退 ancestors
		expect(lineageRowId("task-root", undefined, ["root"])).toBe("root");
		expect(lineageRowId("task-root", null, ["root"])).toBe("root");
		expect(lineageRowId("task-root", "01a12d38", ["root"])).toBe("root");

		// Assert: ancestors 也非数组按空处理 —— 两链皆空 → taskId，且不抛
		expect(lineageRowId("task-root", [], undefined as unknown as string[])).toBe("task-root");
		expect(lineageRowId("task-root", [], "01a12d38" as unknown as string[])).toBe("task-root");
	});

	it("should return null when the taskId is null", async () => {
		// Arrange: 未选中任何任务（state.taskId 为 null）—— 即使链非空也不高亮
		const lineageRowId = await loadLineageRowId();

		// Act / Assert
		expect(lineageRowId(null, ["root"], [])).toBeNull();
		expect(lineageRowId(null, [], ["root"])).toBeNull();
		expect(lineageRowId(null, [], [])).toBeNull();
	});
});

// ================================================================
// lineageLabel（本轮 A：选中行尾部位置后缀）
// ================================================================
describe("lineageLabel", () => {
	it("should compose the suffix as the agent, the middot and the first 8 characters of the taskId", async () => {
		// Arrange
		const lineageLabel = await loadLineageLabel();

		// Act
		const label = lineageLabel("researcher", "01a12d39-0264-7f94-a382-84686f818c6f");

		// Assert: "↳ <agent> · <taskId 前 8 位>"
		expect(label).toBe("↳ researcher · 01a12d39");
	});

	it("should fall back to subagent when the agent is missing, blank or not a string", async () => {
		// Arrange
		const lineageLabel = await loadLineageLabel();
		const taskId = "01a12d39-0264-7f94-a382-84686f818c6f";

		// Act / Assert: 缺失 / 纯空白 / 非字符串一律回退 "subagent"
		expect(lineageLabel(undefined, taskId)).toBe("↳ subagent · 01a12d39");
		expect(lineageLabel(null, taskId)).toBe("↳ subagent · 01a12d39");
		expect(lineageLabel("   \n  ", taskId)).toBe("↳ subagent · 01a12d39");
		expect(lineageLabel(42, taskId)).toBe("↳ subagent · 01a12d39");
	});

	it("should slice safely when the taskId is shorter than 8 characters", async () => {
		// Arrange
		const lineageLabel = await loadLineageLabel();

		// Act / Assert: slice(0, 8) 对短串原样返回（不抛、不补位）
		expect(lineageLabel("researcher", "abc")).toBe("↳ researcher · abc");
		expect(lineageLabel("researcher", "01a12d3")).toBe("↳ researcher · 01a12d3");
	});
});

// ================================================================
// durationMs（本轮 B：rejected/failed 耗时不得累积，缺结束时刻显示 —）
// 经 .toString() 内联进页面，必须自包含。
// ================================================================
describe("durationMs", () => {
	const NOW = 1_700_000_000_000;

	it("should return a fixed finishedAt − startedAt duration for terminal nodes, independent of nowMs", async () => {
		// Arrange: 三种终态各带 finishedAt（startedAt = now−10s、finishedAt = now−4s）
		const durationMs = await loadDurationMs();

		// Act / Assert: 6s 固定值，nowMs 推进 1 小时也不变（耗时不得累积）
		for (const status of ["rejected", "finished", "failed"]) {
			const node = { status, startedAt: NOW - 10_000, finishedAt: NOW - 4_000 };
			expect(durationMs(node, NOW), `${status} duration must be frozen`).toBe(6_000);
			expect(durationMs(node, NOW + 3_600_000), `${status} duration must ignore nowMs`).toBe(6_000);
		}
	});

	it("should return null for a terminal node without a finishedAt", async () => {
		// Arrange: 终态但缺结束时刻（服务端 errorTs 尚未落地的兜底形状）
		const durationMs = await loadDurationMs();

		// Act / Assert: null（页面显示 "—"），nowMs 推进也不得变成累积值
		for (const status of ["rejected", "finished", "failed"]) {
			const node = { status, startedAt: NOW - 10_000 };
			expect(durationMs(node, NOW), `${status} without finishedAt must be null`).toBeNull();
			expect(durationMs(node, NOW + 3_000), `${status} without finishedAt must stay null`).toBeNull();
		}
	});

	it("should keep accumulating with nowMs for running, recent and pending nodes", async () => {
		// Arrange: 非终态节点（startedAt = now−10s）
		const durationMs = await loadDurationMs();

		// Act / Assert: nowMs 与 nowMs+3s 的差恰为 3000（随时间累积）
		for (const status of ["running", "recent", "pending"]) {
			const node = { status, startedAt: NOW - 10_000 };
			const atNow = durationMs(node, NOW);
			const later = durationMs(node, NOW + 3_000);
			expect(atNow, `${status} must accumulate from startedAt`).toBe(10_000);
			expect((later as number) - (atNow as number), `${status} must grow with nowMs`).toBe(3_000);
		}
	});

	it("should treat a missing startedAt as 0 without throwing", async () => {
		// Arrange: 节点缺 startedAt（服务端尚未落 ts 的兜底形状）
		const durationMs = await loadDurationMs();

		// Act / Assert: 非终态 → nowMs − 0；终态 → finishedAt − 0；均不抛
		expect(durationMs({ status: "running" }, 5_000)).toBe(5_000);
		expect(durationMs({ status: "rejected", finishedAt: 7_000 }, 9_000)).toBe(7_000);
	});

	it("should return null when finishedAt is not a finite number (NaN, non-number or Infinity)", async () => {
		// Arrange: 非法 finishedAt 形状
		const durationMs = await loadDurationMs();

		// Act / Assert: 一律 null（页面显示 "—"），绝不落进 Date.now() 累积
		for (const finishedAt of [Number.NaN, "123", null, Infinity]) {
			const node = { status: "failed", startedAt: NOW - 10_000, finishedAt: finishedAt as number };
			expect(durationMs(node, NOW), `finishedAt ${String(finishedAt)} must yield null`).toBeNull();
		}
	});

	it("should clamp a negative duration to 0", async () => {
		// Arrange: finishedAt 早于 startedAt（时钟回拨/数据异常）
		const durationMs = await loadDurationMs();

		// Act / Assert: max(0, …) —— 终态与非终态都不得返回负数
		expect(durationMs({ status: "rejected", startedAt: NOW, finishedAt: NOW - 5_000 }, NOW)).toBe(0);
		expect(durationMs({ status: "running", startedAt: NOW + 5_000 }, NOW)).toBe(0);
	});

	it("should return 0 for a rejected node with finishedAt 0 (semantic record: the server's errorTs > 0 guard keeps finishedAt: 0 off the wire)", async () => {
		// Arrange: finishedAt: 0 是有限 number —— 客户端不在此兜底（服务端已以
		// errorTs > 0 守卫，不下发 finishedAt: 0；若真下发，页面会显示 "0s" 而非
		// "—"）。本例只记录该语义边界，不构成对服务端的替代防线。
		const durationMs = await loadDurationMs();

		// Act / Assert: max(0, 0 − 1000) = 0（既非 null、也非随 nowMs 累积的值）
		expect(durationMs({ status: "rejected", startedAt: 1000, finishedAt: 0 }, 9_000)).toBe(0);
	});
});
