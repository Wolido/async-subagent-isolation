/**
 * PAGE_HTML 主 <script> 的 DOM 行为测试：错误面板跨树重建保持（A）、空 taskId
 * 错误行的面板保持与移动（A-5 / A-6）、真实路由切换收起面板（A-7）、重建后恢复
 * 键盘焦点（B1，C-10）、taskless 行的键盘焦点恢复（I1）、hashchange 忽略非任务
 * 路由（B2，C-07）、完全同键的 taskless rejected 行（C1），以及字符串级落点锁。
 *
 * 与既有字符串级页面契约不同，本文件经 test/page-dom-harness.ts（node:vm +
 * 手写最小 DOM stub，零新增依赖）真执行主 <script>，只经 DOM 事件、
 * location.hash、fetch、setInterval 与页面交互，断言全部走可观测 DOM 读数
 * （hidden / textContent / dataset / activeElement / scrollTop）。state 在
 * IIFE 内不可外读：openPanelTaskId、routed 等状态一律以 DOM 读数代理。
 *
 * 契约（A / A-7 / B2 / A-5 / A-6 / N-3 / N-4 / B1 已由实现落地，本文件的这些
 * 用例为回归锁，预期绿：面板键已含 errorText||reason 且不含 startedAt（N-3 /
 * N-4），焦点恢复已晚于 roving tabindex 赋值（B1）；C1（两条逐字全同的
 * taskless rejected 行共用同一面板键）与 I1（焦点落在 taskless 行上时重建后
 * 不再恢复）预期红，待 coder 落地后变绿）：
 *
 *   A. 原因面板跨树重建保持：
 *      - state 面板键字段（openPanelTaskId，初始 null）；
 *      - 行激活（click 与 keydown 的 Enter/Space 两条路径）遇到
 *        node.errorText || node.reason 时：面板已展开 → 收起且
 *        面板键（等于该 node.taskId 时）置 null；否则展开且
 *        置为 node.taskId；
 *      - renderList 挂载面板时 hidden 取决于面板键 === node.taskId；
 *        展开面板的 .text textContent 仍逐字为 node.errorText（不截断）；
 *      - 再点同一行收起；点另一行面板移动到新行（原行收起）；重建跟随新行。
 *   A-5. 空 taskId 的错误行（tree.ts 的 rejected 派发节点：派发被拒且错误未
 *        点名任务时 taskId 为 ""，但 reason / errorText 照常赋值，renderList
 *        会为它挂 .node-error）：点击展开后必须与有 taskId 的行一样跨重建保持
 *        （面板存在、hidden === false、.text 逐字为 errorText）。
 *   A-6. 两条空 taskId 错误行不得因 taskId 同为空串被当成同一行：点第二行是
 *        「移动」（第二行展开、第一行收起），重建后仍跟随第二行；任意时刻全树
 *        展开的 .node-error 数量 ≤ 1。
 *   A-7. 真实路由切换（#/t/<id> 之间、以及回到 "#/"）必须收起上一页展开的面板，
 *        且重建不得复活；被守卫忽略的 hash 不收起（见 B2）。
 *   B1. renderTree() 重建前记录当前焦点行（document.activeElement 是 treeEl
 *       内 .node 且 dataset.taskId 非空才记，否则 null），挂行后按 taskId
 *       row.focus({ preventScroll: true }) 恢复；恢复路径不得调 scrollIntoView、
 *       不得写 treeEl.scrollTop（第 14 批滚动不变量）。
 *       回归锁（绿）：restore 必须晚于 highlightSelection() → updateRovingTabindex
 *       写入 tabindex；否则新行是无 tabindex 的 div role="button"，HTML 规范下
 *       focus() 对不可聚焦元素是 no-op → 真实浏览器里 activeElement 停在 body。
 *       harness 已建模可聚焦性，用例失败信息区分「没恢复」与「restore 早于
 *       tabindex 赋值」。
 *   I1. 作用域缺口（预期红）：B1 的「重建前 activeElement 是树内 .node 行」判据
 *       未限定该行有 taskId。taskless 行（pending/rejected/unknown）在无选中时
 *       由 roving tabindex 持有 tabindex="0"，是真实可聚焦目标；当前 renderTree
 *       只在 dataset.taskId 非空时记录焦点行，taskless 行重建后焦点落到 body。
 *   B2. route() 开头加守卫：首次路由（boot 直接调用，state 上的标志第一个
 *       hashchange 之前为假）照常执行；此后只接受 #/t/<id>（可解析出 taskId）
 *       与逐字 "#/"，其余（"" / "#"、"#foo"、"#/t/"、"#/t/%ZZ"）一律 return：
 *       不改 state.taskId、不清面板键、不重渲染。"#/" 例外
 *       保留「返回任务列表」入口（src/web/page.ts showTaskNotFound 的
 *       <a class="back-to-list" href="#/">）。
 *       window.addEventListener("hashchange", route) 注册语句逐字不变（既有
 *       test/subagent-web-page.test.ts 锁定），守卫写在 route() 内部。
 *
 * 本文件新增的锁与缺口（红/绿及变异捕获口径）：
 *   N-1. 被忽略的 hashchange 之后下一次树轮询仍不得收起面板（绿锁；变异口径：
 *        把 route() 里的 `state.openPanelTaskId = null;` 上移到守卫 `return`
 *        之前 → 面板键在被忽略的 hash 上被清零，下一次 renderTree 即收起，
 *        用例变红）。视觉当下无变化，必须靠 rebuild 观测。
 *   N-2. 展开行的 row.dataset.panelKey 非空且跨重建逐字相同（绿锁；变异口径：
 *        删掉 renderList 里的 `row.dataset.panelKey = key;` → 用例变红）。
 *   N-3. 复合键碰撞（绿锁）：两条 taskless 错误行仅 errorText/reason 不同，
 *        agent/status/startedAt/task 全同 → 面板键已把 errorText||reason 并入，
 *        两行可区分。契约：任意时刻至多一块面板非 hidden + 点第二行是「移动」+
 *        重建后仍跟随第二行。
 *   N-4. 键跨重建稳定性（绿锁）：taskless 错误行的 startedAt 在后端可能回退为
 *        Date.now()（每次 /api/tree 都变）；行键已不含 startedAt，同一 errorText
 *        的面板仍展开。
 *   C1. 完全同键（预期红）：同一会话里两次 subagent 派发（不同 callId、同一
 *        agent、同一 task 文本）都被同一个 roster 门以同一句拒掉 →
 *        buildSessionTreeResult 产出两个 taskId/agent/status/task/startedAt/
 *        errorText/reason 逐字全同的 taskless rejected 节点。当前面板键由这些
 *        字段拼成 → 两行同键：一次重建后两块 .node-error 同时非 hidden，且点
 *        第二行只把面板整体收起（第二行打不开）。契约：同键行仍须可区分（例如
 *        在键后缀一个稳定序号），至多一块展开、点第二行移动到第二行、重建后
 *        仍跟随第二行。
 *
 * 明确不做：C-11（markdown 四空格缩进）相关用例，另行决策。
 */

import { describe, expect, it } from "vitest";
import { PAGE_HTML } from "../src/web/page.ts";
import { createPageDomHarness, type DomEl, type FocusAttempt, type PageDomHarness } from "./page-dom-harness.ts";

// ---------------------------------------------------------------------------
// 测试数据：一棵三节点的根树 —— task-a / task-b 均为 rejected 且带 errorText
// 与 reason（面板载体），task-c 为普通 finished 节点（无面板，作为对照行）。
// ---------------------------------------------------------------------------

const API_V = 2;
const ERROR_TEXT_A = "task-a exploded: boom\n    at line 1\n    at line 2 —— 全量逐字，不得截断的完整错误文本".repeat(2);
const ERROR_TEXT_B = "task-b exploded: kaboom —— 另一个带面板的 rejected 节点，用于面板移动断言";

function errorNode(taskId: string): Record<string, unknown> {
	return {
		taskId,
		agent: "coder",
		status: "rejected",
		task: "investigate " + taskId,
		startedAt: 1_700_000_000_000,
		finishedAt: 1_700_000_003_000,
		errorText: taskId === "task-a" ? ERROR_TEXT_A : ERROR_TEXT_B,
		reason: "reason of " + taskId,
		children: [],
		childCount: 0,
	};
}

function finishedNode(taskId: string): Record<string, unknown> {
	return {
		taskId,
		agent: "reviewer",
		status: "finished",
		task: "inspect " + taskId,
		startedAt: 1_700_000_000_000,
		finishedAt: 1_700_000_002_000,
		errorText: "",
		reason: "",
		children: [],
		childCount: 0,
	};
}

function treeOf(...nodes: Array<Record<string, unknown>>): unknown {
	return { apiVersion: API_V, nodes, truncated: { dropped: 0 } };
}

/** boot 到根列表（无 hash）：三行，task-a / task-b 带错误面板。 */
async function bootRoot(): Promise<PageDomHarness> {
	const harness = createPageDomHarness();
	await harness.boot(treeOf(errorNode("task-a"), errorNode("task-b"), finishedNode("task-c")));
	expect(harness.rowIds(), "前置：三行必须渲染出来").toEqual(["task-a", "task-b", "task-c"]);
	return harness;
}

/** boot 深链到 #/t/task-a 并展开 task-a 的错误面板（A 场景叠加在 B2 上）。 */
async function bootAtTaskA(): Promise<PageDomHarness> {
	const harness = createPageDomHarness({ hash: "#/t/task-a" });
	await harness.boot(treeOf(errorNode("task-a"), errorNode("task-b"), finishedNode("task-c")));
	expect(harness.activeRowTaskId(), "前置：深链 task-a 的行必须高亮").toBe("task-a");
	harness.clickRow("task-a");
	expect(harness.panelFor("task-a")?.hidden, "前置：task-a 面板应已展开").toBe(false);
	return harness;
}

/** 断言某 taskId 的面板处于展开态，.text 逐字为该节点 errorText；返回面板元素。 */
function expectPanelOpen(harness: PageDomHarness, taskId: string): NonNullable<ReturnType<PageDomHarness["panelFor"]>> {
	const panel = harness.panelFor(taskId);
	expect(panel, `taskId "${taskId}" 的 .node-error 面板应存在`).not.toBeNull();
	expect((panel as NonNullable<typeof panel>).hidden, `taskId "${taskId}" 的面板应展开（hidden = false）`).toBe(false);
	const text = (panel as NonNullable<typeof panel>).querySelector(".text");
	expect(text, "面板应含 .text 段").not.toBeNull();
	expect(text?.textContent, "展开面板的 .text 必须逐字为该节点 errorText（不截断）").toBe(
		taskId === "task-a" ? ERROR_TEXT_A : ERROR_TEXT_B,
	);
	return panel as NonNullable<typeof panel>;
}

function expectPanelClosed(harness: PageDomHarness, taskId: string, why: string): void {
	const panel = harness.panelFor(taskId);
	expect(panel, `taskId "${taskId}" 的面板应仍在树上（只是收起）`).not.toBeNull();
	expect(panel?.hidden, why).toBe(true);
}

// ---------------------------------------------------------------------------
// A-5 / A-6 测试数据：两条 taskId 为空串的错误行（tree.ts 的 rejected 派发节点：
// 派发被拒且错误未点名任务时 taskId 为 ""，reason / errorText 照常赋值）。
// 行只能按树序（rowAt(index) / panelAt(index)）寻址，因为空 taskId 无法作键。
// ---------------------------------------------------------------------------

const ERR_TEXT_ONE = "err one —— 第一条派发被拒的错误文本（taskId 为空串，不得截断）";
const ERR_TEXT_TWO = "err two —— 第二条派发被拒的错误文本（taskId 同为空串，必须区分）";

function tasklessErrorNode(errorText: string, task: string, startedAt = 1_700_000_000_000): Record<string, unknown> {
	return {
		taskId: "",
		agent: "coder",
		status: "rejected",
		task,
		startedAt,
		finishedAt: 1_700_000_003_000,
		errorText,
		reason: "reason of " + task,
		linkSource: "result",
		children: [],
		childCount: 0,
	};
}

/** boot 根列表：第 0 / 1 行是空 taskId 错误行（err one / err two），第 2 行为对照行。 */
async function bootTasklessErrorTree(): Promise<PageDomHarness> {
	const harness = createPageDomHarness();
	await harness.boot(treeOf(tasklessErrorNode(ERR_TEXT_ONE, "task one"), tasklessErrorNode(ERR_TEXT_TWO, "task two"), finishedNode("task-c")));
	expect(harness.rowCount(), "前置：三行必须渲染出来（含两条空 taskId 错误行）").toBe(3);
	expect(harness.rowIds(), "前置：空 taskId 的行不进入 rowIds()").toEqual(["task-c"]);
	expect(harness.panelAt(0), "前置：第 0 行应挂 .node-error 面板").not.toBeNull();
	expect(harness.panelAt(1), "前置：第 1 行应挂 .node-error 面板").not.toBeNull();
	expect(harness.panelAt(0)?.hidden, "前置：面板初始收起").toBe(true);
	expect(harness.panelAt(1)?.hidden, "前置：面板初始收起").toBe(true);
	return harness;
}

function expectRowAtPanelOpen(
	harness: PageDomHarness,
	index: number,
	expectedText: string,
	why: string,
): DomEl {
	const panel = harness.panelAt(index);
	expect(panel, `第 ${index} 行的 .node-error 面板应存在`).not.toBeNull();
	const openPanel = panel as NonNullable<typeof panel>;
	expect(openPanel.hidden, why).toBe(false);
	const text = openPanel.querySelector(".text");
	expect(text, "面板应含 .text 段").not.toBeNull();
	expect(text?.textContent, "展开面板的 .text 必须逐字为该节点 errorText（不截断）").toBe(expectedText);
	return openPanel;
}

function expectRowAtPanelClosed(harness: PageDomHarness, index: number, why: string): void {
	const panel = harness.panelAt(index);
	expect(panel, `第 ${index} 行的 .node-error 面板应仍在树上（只是收起）`).not.toBeNull();
	expect(panel?.hidden, why).toBe(true);
}

// ---------------------------------------------------------------------------
// N-3 复合键碰撞数据：两条 taskless 错误行的 agent / status / startedAt / task
// 逐字相同，只有 errorText / reason 不同（panelKey 的降级输入只取前四者 →
// 现实现两行同键）。行只能按面板文本（rowForPanelText）寻址：同键意味着
// panelKey 本身分不开这两行，index 又不跨重建稳定。
// ---------------------------------------------------------------------------

const COLLIDE_TEXT_ONE = "collide one —— 复合键碰撞行一（仅 errorText/reason 与行二不同）";
const COLLIDE_TEXT_TWO = "collide two —— 复合键碰撞行二（agent/status/startedAt/task 与行一全同）";

function collidingTasklessNode(errorText: string): Record<string, unknown> {
	return {
		taskId: "",
		agent: "coder",
		status: "rejected",
		task: "same dispatch",
		startedAt: 1_700_000_000_000,
		finishedAt: 1_700_000_003_000,
		errorText,
		reason: "reason of " + errorText,
		linkSource: "result",
		children: [],
		childCount: 0,
	};
}

/** boot 根列表：第 0 / 1 行是仅 errorText/reason 不同的 taskless 错误行，第 2 行为对照行。 */
async function bootCollidingTasklessTree(): Promise<PageDomHarness> {
	const harness = createPageDomHarness();
	await harness.boot(treeOf(collidingTasklessNode(COLLIDE_TEXT_ONE), collidingTasklessNode(COLLIDE_TEXT_TWO), finishedNode("task-c")));
	expect(harness.rowCount(), "前置：三行必须渲染出来（含两条复合键字段全同的 taskless 错误行）").toBe(3);
	expect(harness.rowForPanelText(COLLIDE_TEXT_ONE), "前置：行一应按面板文本可寻址").not.toBeNull();
	expect(harness.rowForPanelText(COLLIDE_TEXT_TWO), "前置：行二应按面板文本可寻址").not.toBeNull();
	expect(harness.panelAt(0)?.hidden, "前置：行一面板初始收起").toBe(true);
	expect(harness.panelAt(1)?.hidden, "前置：行二面板初始收起").toBe(true);
	return harness;
}

/** 按面板 .text 逐字文本断言该行面板展开（跨重建稳定寻址，不依赖 index）。 */
function expectPanelOpenByText(harness: PageDomHarness, errorText: string, why: string): void {
	const row = harness.rowForPanelText(errorText);
	expect(row, `树上应有 .node-error .text 逐字为该 errorText 的行（${errorText.slice(0, 24)}…）`).not.toBeNull();
	const panel = row?.parentNode?.querySelector(".node-error") ?? null;
	expect(panel, why).not.toBeNull();
	expect(panel?.hidden, why).toBe(false);
	expect(panel?.querySelector(".text")?.textContent, "展开面板的 .text 必须逐字为该行 errorText（不截断）").toBe(errorText);
}

function expectPanelClosedByText(harness: PageDomHarness, errorText: string, why: string): void {
	const row = harness.rowForPanelText(errorText);
	expect(row, `树上应有 .node-error .text 逐字为该 errorText 的行（${errorText.slice(0, 24)}…）`).not.toBeNull();
	const panel = row?.parentNode?.querySelector(".node-error") ?? null;
	expect(panel, why).not.toBeNull();
	expect(panel?.hidden, why).toBe(true);
}

// ---------------------------------------------------------------------------
// A. 原因面板跨树重建保持（回归锁，绿）
// ---------------------------------------------------------------------------

describe("A. 错误面板跨树重建保持（真 DOM 执行）", () => {
	it("should keep the clicked error row's panel open across a tree rebuild", async () => {
		// Arrange：根列表三行，task-a 带 errorText + reason
		const harness = await bootRoot();

		// Act：点击错误行展开面板
		harness.clickRow("task-a");

		// Assert：面板存在、非 hidden、.text 逐字为 errorText
		expectPanelOpen(harness, "task-a");

		// Act：触发一次树轮询（renderTree 整体重建行与面板）
		await harness.advanceTreePoll();

		// Assert：重建后同一 taskId 的面板仍展开、同一文本 —— 依据
		// state.openPanelTaskId 恢复 hidden，而不是重建即收起
		expectPanelOpen(harness, "task-a");
	});

	it("should keep an Enter-opened panel open across a rebuild and collapse it on the second Enter", async () => {
		// Arrange：键盘路径（keydown Enter）是与 click 并列的行激活入口
		const harness = await bootRoot();

		// Act：Enter 展开面板
		harness.pressRow("task-a", "Enter");

		// Assert：键盘展开与点击等价
		expectPanelOpen(harness, "task-a");

		// Act：重建
		await harness.advanceTreePoll();

		// Assert：键盘路径写入的 openPanelTaskId 同样要跨重建保持
		expectPanelOpen(harness, "task-a");

		// Act：再次 Enter
		harness.pressRow("task-a", "Enter");

		// Assert：收起，且重建后仍收起
		expectPanelClosed(harness, "task-a", "第二次 Enter 应收起面板");
		await harness.advanceTreePoll();
		expectPanelClosed(harness, "task-a", "收起状态跨重建保持");
	});

	it("should collapse the panel when the same row is clicked again and stay collapsed after a rebuild", async () => {
		// Arrange：面板已展开（前置包含 A 的跨重建保持判据）
		const harness = await bootRoot();
		harness.clickRow("task-a");
		expectPanelOpen(harness, "task-a");
		await harness.advanceTreePoll();
		expectPanelOpen(harness, "task-a");

		// Act：再次点击同一行
		harness.clickRow("task-a");

		// Assert：收起（hidden）
		expectPanelClosed(harness, "task-a", "再点同一行应收起面板");

		// Act & Assert：重建后仍收起（openPanelTaskId 已被清，不得复活面板）
		await harness.advanceTreePoll();
		expectPanelClosed(harness, "task-a", "收起状态跨重建保持");
	});

	it("should move the open panel to the newly clicked error row and follow it across rebuilds", async () => {
		// Arrange：task-a 面板展开
		const harness = await bootRoot();
		harness.clickRow("task-a");
		expectPanelOpen(harness, "task-a");

		// Act：点击另一条带 errorText 的行
		harness.clickRow("task-b");

		// Assert：面板移动到新行，原行收起（同一时刻只有一块展开的面板）
		expectPanelOpen(harness, "task-b");
		expectPanelClosed(harness, "task-a", "面板移动后原行必须收起");

		// Act & Assert：重建后跟随新行
		await harness.advanceTreePoll();
		expectPanelOpen(harness, "task-b");
		expectPanelClosed(harness, "task-a", "重建后原行保持收起");
	});

	it("should not navigate when an error row is clicked", async () => {
		// Arrange：根列表（hash 为初始空串）
		const harness = await bootRoot();
		const hashBefore = harness.hash();

		// Act：点击错误行（面板切换，不导航、不发请求）
		harness.clickRow("task-a");

		// Assert：hash 逐字不变
		expect(harness.hash(), "错误行的点击只切换面板，不得改写 location.hash").toBe(hashBefore);
	});

	it("should toggle the error panel with Space and keep it open across a rebuild", async () => {
		// Arrange：Space（key " "）与 Enter、click 并列的行激活入口
		const harness = await bootRoot();

		// Act：Space 展开面板
		harness.pressRow("task-a", " ");

		// Assert：键盘 Space 路径展开面板
		expectPanelOpen(harness, "task-a");

		// Act：重建
		await harness.advanceTreePoll();

		// Assert：Space 写入的面板键同样要跨重建保持
		expectPanelOpen(harness, "task-a");

		// Act：再次 Space
		harness.pressRow("task-a", " ");

		// Assert：收起，且重建后仍收起
		expectPanelClosed(harness, "task-a", "第二次 Space 应收起面板");
		await harness.advanceTreePoll();
		expectPanelClosed(harness, "task-a", "Space 收起状态跨重建保持");
	});

	it("should stamp a non-empty data-panel-key on the expanded error row and keep it byte-identical across rebuilds", async () => {
		// Arrange：展开 task-a 的面板
		const harness = await bootRoot();
		harness.clickRow("task-a");
		expectPanelOpen(harness, "task-a");

		// Act & Assert：展开的那行必须携带非空 row.dataset.panelKey（renderList 挂
		// 面板时写入；删掉该写入本用例即红 —— 现无其它断言覆盖它）
		const rowBefore = harness.rowFor("task-a");
		expect(rowBefore, "前置：task-a 行应存在").not.toBeNull();
		const keyBefore = (rowBefore as DomEl).dataset.panelKey;
		expect(keyBefore, "展开的错误行必须携带非空 data-panel-key（面板键的 DOM 落点，删掉 row.dataset.panelKey 写入即红）").toBeTruthy();

		// Act：一次真实重建
		await harness.advanceTreePoll();

		// Assert：重建后同一行（按 taskId 寻址）的键值逐字不变 —— 面板跟随行键
		// 而非 DOM 位置，键必须跨重建稳定
		const rowAfter = harness.rowFor("task-a");
		expect(rowAfter, "重建后 task-a 行应重新渲染").not.toBeNull();
		expect(
			(rowAfter as DomEl).dataset.panelKey,
			"重建后同一行的 data-panel-key 必须与重建前逐字相同（面板状态按行键恢复）",
		).toBe(keyBefore);
	});
});

// ---------------------------------------------------------------------------
// A-5 / A-6. 空 taskId 错误行的面板（回归锁，绿）
// ---------------------------------------------------------------------------

describe("A-5/A-6. 空 taskId 错误行的面板（真 DOM 执行）", () => {
	it("should keep the error panel of a taskless error row open across a tree rebuild", async () => {
		// Arrange：第 0 行 taskId 为空串，但 errorText / reason 照常存在
		const harness = await bootTasklessErrorTree();

		// Act：点击该行
		harness.clickRowAt(0);

		// Assert：面板展开，.text 逐字为 errorText
		expectRowAtPanelOpen(harness, 0, ERR_TEXT_ONE, "点击空 taskId 错误行应展开面板");

		// Act：一次真实重建（renderTree 整体重建行与面板）
		await harness.advanceTreePoll();

		// Assert：重建后仍展开、文本不变 —— 空 taskId 不是放弃跨重建保持的理由
		expectRowAtPanelOpen(harness, 0, ERR_TEXT_ONE, "空 taskId 行的面板必须跨重建保持展开");
	});

	it("should move the open panel from the first taskless error row to the second one", async () => {
		// Arrange：两条空 taskId 错误行，面板均初始收起
		const harness = await bootTasklessErrorTree();

		// Act：点第一行
		harness.clickRowAt(0);

		// Assert：第一行展开、第二行收起，且至多一块展开
		expectRowAtPanelOpen(harness, 0, ERR_TEXT_ONE, "点第一行应展开第一行的面板");
		expectRowAtPanelClosed(harness, 1, "第一行展开时第二行必须收起");
		expect(harness.openPanelCount(), "展开第一行后至多一块面板非 hidden").toBeLessThanOrEqual(1);

		// Act：点第二行
		harness.clickRowAt(1);

		// Assert：移动语义 —— 第二行展开、第一行收起；不得因 taskId 同为空串
		// 被当成「同一行」而整体收起
		expectRowAtPanelOpen(harness, 1, ERR_TEXT_TWO, "点第二行应把面板移动到第二行（两条空 taskId 行不得混淆）");
		expectRowAtPanelClosed(harness, 0, "面板移动后第一行必须收起");
		expect(harness.openPanelCount(), "移动后至多一块面板非 hidden").toBeLessThanOrEqual(1);
	});

	it("should keep the second taskless error row's panel open across a rebuild", async () => {
		// Arrange：面板已从第一行移动到第二行
		const harness = await bootTasklessErrorTree();
		harness.clickRowAt(0);
		harness.clickRowAt(1);
		expectRowAtPanelOpen(harness, 1, ERR_TEXT_TWO, "前置：面板应在第二行");

		// Act：一次真实重建
		await harness.advanceTreePoll();

		// Assert：重建后仍是第二行展开、文本为 "err two"，第一行保持收起
		expectRowAtPanelOpen(harness, 1, ERR_TEXT_TWO, "重建后仍应是第二行展开、文本为 err two");
		expectRowAtPanelClosed(harness, 0, "重建后第一行保持收起");
		expect(harness.openPanelCount(), "重建后至多一块面板非 hidden").toBeLessThanOrEqual(1);
	});

	it("should never show more than one open error panel while the panel moves between taskless rows", async () => {
		// Arrange：两条空 taskId 错误行
		const harness = await bootTasklessErrorTree();
		expect(harness.openPanelCount(), "前置：初始全收起").toBe(0);

		// Act & Assert：每次交互（含重建）后都检查「至多一块」不变量
		harness.clickRowAt(0);
		expect(harness.openPanelCount(), "点第一行后至多一块展开").toBeLessThanOrEqual(1);
		harness.clickRowAt(1);
		expect(harness.openPanelCount(), "点第二行后至多一块展开").toBeLessThanOrEqual(1);
		await harness.advanceTreePoll();
		expect(harness.openPanelCount(), "重建后至多一块展开").toBeLessThanOrEqual(1);
		harness.clickRowAt(0);
		expect(harness.openPanelCount(), "移回第一行后至多一块展开").toBeLessThanOrEqual(1);
	});
});

// ---------------------------------------------------------------------------
// N-3. 复合键碰撞（降级输入）：两条 taskless 错误行只有 errorText / reason
// 不同，agent / status / startedAt / task 全同 → 面板键已把 errorText||reason
// 并入，两行可区分（回归锁，绿）。
// ---------------------------------------------------------------------------

describe("A-6+/N-3. 复合键完全碰撞的两条 taskless 错误行（真 DOM 执行）", () => {
	it("should never show two open error panels when two taskless rows share every composite-key field", async () => {
		// Arrange：两条仅 errorText/reason 不同的 taskless 错误行
		const harness = await bootCollidingTasklessTree();
		expect(harness.openPanelCount(), "前置：初始全收起").toBe(0);

		// Act & Assert：每次交互（含重建）后都检查「至多一块展开」不变量
		harness.clickRowAt(0);
		expect(harness.openPanelCount(), "点第一行后至多一块面板非 hidden").toBeLessThanOrEqual(1);
		harness.clickRowAt(1);
		expect(harness.openPanelCount(), "点第二行后至多一块面板非 hidden（键相同也不得两块同时挂开）").toBeLessThanOrEqual(1);
		await harness.advanceTreePoll();
		expect(harness.openPanelCount(), "重建后至多一块面板非 hidden").toBeLessThanOrEqual(1);
	});

	it("should move the panel to the second colliding taskless row and keep it there across rebuilds", async () => {
		// Arrange：两条仅 errorText/reason 不同的 taskless 错误行
		const harness = await bootCollidingTasklessTree();

		// Act：点第一行
		harness.clickRowAt(0);
		expectPanelOpenByText(harness, COLLIDE_TEXT_ONE, "点第一行应展开第一行的面板");

		// Act：点第二行（与第一行仅 errorText / reason 不同）
		harness.clickRowAt(1);

		// Assert：移动语义 —— 第二行展开、第一行收起。复合键字段全同也不得被
		// 当成同一行整体收起（否则点第二行后第二行根本没展开）
		expectPanelOpenByText(
			harness,
			COLLIDE_TEXT_TWO,
			"点第二行必须把面板移动到第二行：仅 errorText/reason 不同的 taskless 行不得因复合键相同被当成同一行（否则整体收起、第二行打不开）",
		);
		expectPanelClosedByText(harness, COLLIDE_TEXT_ONE, "面板移动后第一行必须收起");

		// Act & Assert：重建后仍跟随第二行
		await harness.advanceTreePoll();
		expectPanelOpenByText(harness, COLLIDE_TEXT_TWO, "重建后面板仍应跟随第二行（同一 errorText 即同一行）");
		expectPanelClosedByText(harness, COLLIDE_TEXT_ONE, "重建后第一行保持收起");
	});
});

// ---------------------------------------------------------------------------
// N-4. 键跨重建稳定性：taskless 错误行的 startedAt 在真实后端可能回退为
// Date.now()（每次 /api/tree 都变）；同一 errorText 的面板必须仍展开，
// 行键已不含 startedAt（回归锁，绿）。
// ---------------------------------------------------------------------------

describe("A-8/N-4. taskless 行面板键跨 startedAt 变化保持（真 DOM 执行）", () => {
	it("should keep the taskless error row's panel open when its startedAt changes in the next /api/tree response", async () => {
		// Arrange：第一次树里 startedAt 固定，展开第 0 行（按面板文本寻址）
		const harness = await bootTasklessErrorTree();
		harness.clickRowAt(0);
		expectPanelOpenByText(harness, ERR_TEXT_ONE, "前置：面板应在 errorText 为 err one 的行");

		// Act：第二次 /api/tree 里该节点 startedAt 回退为 Date.now()（每次响应
		// 都变），其余字段逐字不变
		harness.setApi("/api/tree", {
			status: 200,
			body: treeOf(
				tasklessErrorNode(ERR_TEXT_ONE, "task one", 1_700_000_004_000),
				tasklessErrorNode(ERR_TEXT_TWO, "task two"),
				finishedNode("task-c"),
			),
		});
		await harness.advanceTreePoll();

		// Assert：同一 errorText（同一逻辑行）的面板仍展开、文本逐字不变 ——
		// 行键不得依赖每次都变的 startedAt，后端回退 startedAt 不是收起面板的理由
		expectPanelOpenByText(
			harness,
			ERR_TEXT_ONE,
			"startedAt 在下一次 /api/tree 里变化后，同一 errorText 的面板必须仍展开（行键不得包含每次都变的 startedAt）",
		);
	});
});

// ---------------------------------------------------------------------------
// C1. 完全同键的两条 taskless rejected 行：同一会话里两次 subagent 派发（不同
// callId、同一 agent、同一 task 文本）都被同一个 roster 门以同一句拒掉 →
// buildSessionTreeResult 产出两个 taskId/agent/status/task/startedAt/errorText/
// reason 逐字全同的 taskless rejected 节点（call.ts 为 0 时 startedAt 回落
// ctx.now，同一响应内相同）。当前实现的面板键由这些字段拼成 → 两行同键：
// 点第一行后一次重建会把两块 .node-error 同时置为非 hidden，且点第二行只把
// 面板整体收起（第二行打不开）。契约：同键行仍须可区分（例如在键后缀一个稳定
// 序号），任意时刻至多一块展开，点第二行是「移动」，重建后跟随被点的那一行。
//（预期红，待 coder 落地同键行的稳定区分后变绿。）
// ---------------------------------------------------------------------------

const ROSTER_GATE_TEXT = 'Cannot dispatch "coder". Allowed subagents: coder.';
const IDENTICAL_DISPATCH_TASK = "run the identical dispatch twice";

/** 与 src/web/tree.ts 的 rejected 派发节点同形，两次派发仅 callId 不同。 */
function identicalTasklessRejectedNode(): Record<string, unknown> {
	return {
		taskId: "",
		agent: "coder",
		status: "rejected",
		task: IDENTICAL_DISPATCH_TASK,
		depth: 0,
		linkSource: "result",
		startedAt: 1_700_000_000_000,
		finishedAt: 1_700_000_003_000,
		errorText: ROSTER_GATE_TEXT,
		reason: "not in roster",
		childSummary: "",
		children: [],
		childCount: 0,
	};
}

/** boot 根列表：第 0 / 1 行是字段逐字全同（errorText 也相同）的 taskless rejected 行。 */
async function bootIdenticalTasklessTree(): Promise<PageDomHarness> {
	const harness = createPageDomHarness();
	await harness.boot(treeOf(identicalTasklessRejectedNode(), identicalTasklessRejectedNode(), finishedNode("task-c")));
	expect(harness.rowCount(), "前置：两条完全相同的 taskless 行 + 对照行必须渲染出来").toBe(3);
	for (const index of [0, 1]) {
		const panel = harness.panelAt(index);
		expect(panel, `前置：第 ${index} 行应挂 .node-error 面板`).not.toBeNull();
		expect(panel?.hidden, `前置：第 ${index} 行面板初始收起`).toBe(true);
		expect(panel?.querySelector(".text")?.textContent, `前置：第 ${index} 行的面板文本为同一句 roster 门拒绝`).toBe(ROSTER_GATE_TEXT);
	}
	expect(harness.openPanelCount(), "前置：初始全收起").toBe(0);
	return harness;
}

describe("C1. 完全同键的两条 taskless rejected 行（真 DOM 执行）", () => {
	it("should keep exactly one error panel open across a rebuild when two taskless rows are byte-identical", async () => {
		// Arrange：两行字段逐字全同、面板文本也相同；先点第一行
		const harness = await bootIdenticalTasklessTree();
		harness.clickRowAt(0);
		expect(harness.openPanelCount(), "点第一行后必须恰有一块面板非 hidden").toBe(1);
		expect(harness.panelAt(0)?.hidden, "展开的应是第一行下的面板").toBe(false);
		expect(harness.panelAt(1)?.hidden, "第一行展开时第二行必须收起").toBe(true);

		// Act：一次真实重建
		await harness.advanceTreePoll();

		// Assert：完全同键的两行不得在重建后同时展开 —— 任意时刻至多一块面板
		// 非 hidden（收到 2 即当前实现把两行当成了同一行、两块面板同时挂开）
		expect(harness.rowCount(), "重建后两条完全相同的行必须仍是两行（不得被合并/去重）").toBe(3);
		expect(
			harness.openPanelCount(),
			"重建后必须恰有一块面板非 hidden：两条逐字全同的 taskless 行不得同时展开（面板键需能区分同键行）",
		).toBe(1);
		expect(harness.panelAt(0)?.hidden, "重建后仍应是第一行下的面板展开").toBe(false);
		expect(harness.panelAt(1)?.hidden, "重建后第二行必须保持收起").toBe(true);
	});

	it("should move the panel to the second byte-identical taskless row and keep it there across rebuilds", async () => {
		// Arrange：两行字段逐字全同；面板先在第一行展开
		const harness = await bootIdenticalTasklessTree();
		harness.clickRowAt(0);
		expect(harness.panelAt(0)?.hidden, "前置：第一行面板应先展开").toBe(false);

		// Act：点第二行（与第一行仅 callId 不同，树字段逐字全同）
		harness.clickRowAt(1);

		// Assert：移动语义 —— 第二行展开、第一行收起。同键行不得被当成「同一行」
		// 而把面板整体收起（否则第二行根本打不开）
		expect(harness.panelAt(1)?.hidden, "点第二行必须展开第二行下的面板（同键行不得被当成同一行整体收起）").toBe(false);
		expect(harness.panelAt(0)?.hidden, "面板移动后第一行必须收起").toBe(true);
		expect(harness.openPanelCount(), "移动后必须恰有一块面板非 hidden").toBe(1);

		// Act：一次真实重建
		await harness.advanceTreePoll();

		// Assert：重建后仍跟随第二行（第一行收起、第二行展开、恰一块非 hidden）
		expect(harness.rowCount(), "重建后两条完全相同的行必须仍是两行（不得被合并/去重）").toBe(3);
		expect(harness.panelAt(1)?.hidden, "重建后面板必须仍跟随第二行").toBe(false);
		expect(harness.panelAt(0)?.hidden, "重建后第一行保持收起").toBe(true);
		expect(harness.openPanelCount(), "重建后仍必须恰有一块面板非 hidden").toBe(1);
	});
});

// ---------------------------------------------------------------------------
// A-7. 真实路由切换收起面板（回归锁，绿；删掉 route() 的面板键清零即红）
// ---------------------------------------------------------------------------

describe("A-7. 真实路由切换收起展开的面板（真 DOM 执行）", () => {
	it("should collapse task A's panel when the route switches to task B", async () => {
		// Arrange：深链 #/t/task-a 并展开 A 的面板
		const harness = await bootAtTaskA();

		// Act：真实任务切换
		await harness.fireHashChange("#/t/task-b");

		// Assert：A 的面板收起（hidden，不是被销毁）
		expectPanelClosed(harness, "task-a", "真实任务切换必须收起上一页展开的面板");

		// Act & Assert：重建不得复活
		await harness.advanceTreePoll();
		expectPanelClosed(harness, "task-a", "切换后重建不得复活旧面板");
	});

	it("should collapse task A's panel when the route returns to the root route \"#/\"", async () => {
		// Arrange：深链 #/t/task-a 并展开 A 的面板
		const harness = await bootAtTaskA();

		// Act：回到根路由（接受的路由，同样要清面板）
		await harness.fireHashChange("#/");

		// Assert：A 的面板收起
		expectPanelClosed(harness, "task-a", "回到根路由必须收起上一页展开的面板");

		// Act & Assert：重建不得复活
		await harness.advanceTreePoll();
		expectPanelClosed(harness, "task-a", "根路由收起后重建不得复活旧面板");
	});
});

// ---------------------------------------------------------------------------
// B1. 重建后恢复键盘焦点（C-10 契约，回归锁，绿：restore 必须晚于
// highlightSelection 写 roving tabindex）
// ---------------------------------------------------------------------------

/**
 * 焦点恢复失败的归因（写进断言消息，区分两种缺口）：
 *   (a) 重建期间没有任何对 .node 行的 focus() 调用 → 「没恢复」；
 *   (b) 有调用但彼时行不可聚焦（无 tabindex 的 div role=button，浏览器
 *       focus() 是 no-op）→ 「restore 早于 tabindex 赋值」。
 * focusable / tabindexAtCall 是 harness 在调用瞬间记录的快照（时序证据），
 * 不读断言时刻的属性值（彼时 highlightSelection 已补写 tabindex，会掩盖时序）。
 */
function restoreDiagnosis(harness: PageDomHarness, attemptsBefore: number): string {
	const rowAttempts = harness
		.focusAttempts()
		.slice(attemptsBefore)
		.filter((attempt) => attempt.el.classList.contains("node"));
	if (rowAttempts.length === 0) {
		return "诊断=没恢复：重建期间没有任何对 .node 行的 focus() 调用";
	}
	const last = rowAttempts[rowAttempts.length - 1] as FocusAttempt;
	if (!last.focusable) {
		return (
			"诊断=restore 早于 tabindex 赋值：focus() 调用瞬间该行 tabindex=" +
			JSON.stringify(last.tabindexAtCall) +
			"（不可聚焦 div role=button 的 focus() 在浏览器是 no-op，彼时 highlightSelection 尚未写 roving tabindex）"
		);
	}
	return (
		"诊断=focus() 已在行可聚焦时调用（调用瞬间 tabindex=" +
		JSON.stringify(last.tabindexAtCall) +
		"）但 activeElement 未落到该行"
	);
}

describe("B1. renderTree 重建后恢复键盘焦点（真 DOM 执行）", () => {
	it("should restore focus to the same row after a rebuild without writing scrollTop", async () => {
		// Arrange：roving tabindex 语义下 task-b 行持有焦点；预置非零侧栏滚动位，
		// 使任何滚动写入都可观测
		const harness = await bootRoot();
		harness.focusRow("task-b");
		harness.setTreeScrollTop(40);
		expect(harness.activeElementTaskId(), "前置：task-b 行应持有焦点").toBe("task-b");
		const scrollTopBefore = harness.treeScrollTop();
		const attemptsBefore = harness.focusAttempts().length;

		// Act：触发一次重建
		await harness.advanceTreePoll();

		// Assert：document.activeElement 仍是同一 taskId 的新行（不是 detached
		// 旧行、不是 body）；失败消息带归因，区分「没恢复」与「restore 早于
		// tabindex 赋值」（见 restoreDiagnosis）
		expect(
			harness.activeElementTaskId(),
			`重建后 activeElement 必须是同一 taskId 的行（不是 body）；${restoreDiagnosis(harness, attemptsBefore)}`,
		).toBe("task-b");

		// Assert：焦点恢复路径不写滚动 —— 重建前后 treeEl.scrollTop 逐字不变
		expect(harness.treeScrollTop(), "重建（含焦点恢复）不得写 treeEl.scrollTop").toBe(scrollTopBefore);
	});

	it("should run the focus restore only after the rebuilt row receives its roving tabindex", async () => {
		// Arrange：task-b 持有焦点，记录 focus() 调用基线
		const harness = await bootRoot();
		harness.focusRow("task-b");
		const attemptsBefore = harness.focusAttempts().length;

		// Act：一次真实重建
		await harness.advanceTreePoll();

		// Assert：重建恰好对目标行调用一次焦点恢复
		const rowAttempts = harness
			.focusAttempts()
			.slice(attemptsBefore)
			.filter((attempt) => attempt.el.classList.contains("node"));
		expect(rowAttempts.length, "重建必须对重建后的目标行调用一次焦点恢复 focus()").toBe(1);

		// Assert：该次调用发生时行必须已可聚焦 —— HTML 规范下 focus() 对无
		// tabindex 的元素是空操作，只有 restore 晚于 highlightSelection →
		// updateRovingTabindex 写入 tabindex 才能真正把焦点放回行上
		const restore = rowAttempts[0] as FocusAttempt;
		expect(
			restore.focusable,
			"焦点恢复调用 focus() 的瞬间重建行必须已可聚焦（调用瞬间 tabindex=" +
				JSON.stringify(restore.tabindexAtCall) +
				"）：restore 早于 highlightSelection 的 roving tabindex 赋值，真实浏览器里 focus() 是 no-op，activeElement 停在 body",
		).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// I1. taskless 行的键盘焦点跨重建恢复：B1 的判据是「重建前 document.activeElement
// 是树内 .node 行 → 重建后焦点回到同一行」，未限定该行有 taskId。无选中时
// roving tabindex 把 tabindex="0" 给首行，而首行常常就是 pending/rejected/
// unknown 的 taskless 行 —— 它是真实可聚焦目标；focusRow / 键盘导航也能把
// 焦点移到 taskless 行上。当前 renderTree() 只在 activeEl.dataset.taskId 非空
// 时记录焦点行，taskless 行重建后 activeElement 落在 body。
//（预期红，待 coder 按稳定行标识（而非 taskId）记录/恢复焦点后变绿。）
// ---------------------------------------------------------------------------

const TASKLESS_FOCUS_TASK = "waiting for receipt —— I1 的 taskless pending 行（唯一文本用于稳定寻址）";

/** 与 src/web/tree.ts 的 unknown 链接节点同形：taskId 为空、无错误面板。 */
function tasklessPendingNode(task: string): Record<string, unknown> {
	return {
		taskId: "",
		agent: "coder",
		status: "pending",
		task,
		depth: 0,
		linkSource: "unknown",
		startedAt: 1_700_000_000_000,
		childSummary: "",
		children: [],
		childCount: 0,
	};
}

/**
 * I1 失败归因（写进断言消息）：区分「taskless 行没恢复焦点（activeElement 停在
 * body / 非树内行）」与「焦点落到了别的行」。
 */
function tasklessFocusDiagnosis(harness: PageDomHarness, expectedIdentity: string | null): string {
	const active = harness.document.activeElement;
	if (!active || active.nodeType !== 1 || !active.isConnected()) {
		return "诊断=taskless 行没恢复焦点：重建后 activeElement 不在文档树内";
	}
	if (active === harness.document.body) {
		return "诊断=taskless 行没恢复焦点：重建后 activeElement 停在 body（焦点行记录只认 dataset.taskId 非空的行，taskless 行被跳过）";
	}
	if (!active.classList.contains("node")) {
		return `诊断=taskless 行没恢复焦点：重建后 activeElement 是 <${active.tagName.toLowerCase()}> 而非树内 .node 行`;
	}
	return `诊断=焦点落到了别的行：期望标识 ${JSON.stringify(expectedIdentity)}，实际 ${JSON.stringify(harness.rowIdentity(active))}`;
}

describe("I1. taskless 行的键盘焦点跨重建恢复（真 DOM 执行）", () => {
	it("should restore focus to the same taskless row after a rebuild without writing scrollTop", async () => {
		// Arrange：首行是 taskless pending 行（无 taskId、无错误面板）。无选中时
		// roving tabindex 把 tabindex="0" 给它，因此它是真实可聚焦行。
		const harness = createPageDomHarness();
		await harness.boot(treeOf(tasklessPendingNode(TASKLESS_FOCUS_TASK), finishedNode("task-c")));
		expect(harness.rowCount(), "前置：taskless 行 + 对照行").toBe(2);
		harness.focusRowAt(0);
		const focusedBefore = harness.activeElementRow();
		expect(focusedBefore, "前置：焦点必须已落在树内 .node 行上（taskless 行可聚焦）").not.toBeNull();
		expect(harness.activeElementTaskId(), "前置：该行 dataset.taskId 为空串（旧焦点行记录的盲区）").toBeNull();
		const identityBefore = harness.rowIdentity(focusedBefore);
		expect(identityBefore, "前置：焦点行按稳定标识（行内唯一 task-line 文本）可寻址，不依赖 index").toBe(
			"taskline:" + TASKLESS_FOCUS_TASK,
		);
		harness.setTreeScrollTop(40);
		const scrollTopBefore = harness.treeScrollTop();

		// Act：一次真实重建
		await harness.advanceTreePoll();

		// Assert：activeElement 必须是重建后的同一 taskless 行（按稳定标识匹配），
		// 不能停在 body。失败消息带归因：taskless 行没恢复焦点 ≠ 焦点落到别的行。
		expect(
			harness.rowIdentity(harness.activeElementRow()),
			`重建后焦点必须回到同一 taskless 行；${tasklessFocusDiagnosis(harness, identityBefore)}`,
		).toBe(identityBefore);

		// Assert：焦点恢复路径不写滚动 —— 重建前后 treeEl.scrollTop 逐字不变
		expect(harness.treeScrollTop(), "重建（含焦点恢复）不得写 treeEl.scrollTop").toBe(scrollTopBefore);
	});
});

// ---------------------------------------------------------------------------
// B2. hashchange 忽略非任务路由（C-07，回归锁，绿；"#/" 为接受的例外）
// ---------------------------------------------------------------------------

/** 被忽略 hash 的公共读数断言：当前任务仍是 A、面包屑仍在、无新请求、面板未收起。 */
function expectTaskAUnchanged(harness: PageDomHarness, ignoredHash: string, transcriptBefore: NonNullable<ReturnType<PageDomHarness["transcriptChildren"]>>): void {
	// 读数 1：active 行仍是 task-a（state.taskId 未被改写）
	expect(harness.activeRowTaskId(), `忽略 ${JSON.stringify(ignoredHash)} 后当前任务行必须仍是 task-a`).toBe("task-a");

	// 读数 2：#crumbs 的 aria-current="page" 当前段仍在，文本仍含 A 的任务信息
	const crumbs = harness.crumbState();
	expect(crumbs.hidden, `忽略 ${JSON.stringify(ignoredHash)} 后面包屑不得被收起`).toBe(false);
	expect(crumbs.currentLabel, "当前段必须存在").not.toBeNull();
	expect(crumbs.currentLabel, "当前段文本仍含 task-a 的任务信息").toContain("task-a");

	// 读数 3：转录区未被清空重建 —— 子节点必须是同一批对象（identity）
	const transcriptAfter = harness.transcriptChildren();
	expect(transcriptAfter.length, "忽略的路由不得清空重建转录区").toBe(transcriptBefore.length);
	transcriptAfter.forEach((child, index) => {
		expect(child, "转录区子节点必须保持同一对象（未重建）").toBe(transcriptBefore[index]);
	});

	// 读数 4（A 场景叠加）：openPanelTaskId 对应的面板未被收起
	expect(harness.panelFor("task-a")?.hidden, "路由守卫不得清 openPanelTaskId（面板不得被收起）").toBe(false);
}

describe("B2. hashchange 忽略非任务路由（真 DOM 执行）", () => {
	it("should keep task A when a hashchange carries an empty fragment", async () => {
		// Arrange：深链 #/t/task-a，面板展开；记录转录区子节点与请求数
		const harness = await bootAtTaskA();
		const transcriptBefore = harness.transcriptChildren();
		const requestsBefore = harness.requests().length;

		// Act：浏览器里裸 # 的 location.hash 就是 ""
		await harness.fireHashChange("");

		// Assert：读数全部保持（请求数单独断言，避免 helper 内自比较）
		expectTaskAUnchanged(harness, "", transcriptBefore);
		expect(harness.requests().length, "被忽略的路由不得发起新的请求").toBe(requestsBefore);
	});

	it("should keep task A when a hashchange carries an unknown fragment \"#foo\"", async () => {
		// Arrange
		const harness = await bootAtTaskA();
		const transcriptBefore = harness.transcriptChildren();
		const requestsBefore = harness.requests().length;

		// Act
		await harness.fireHashChange("#foo");

		// Assert
		expectTaskAUnchanged(harness, "#foo", transcriptBefore);
		expect(harness.requests().length, "被忽略的路由不得发起新的请求").toBe(requestsBefore);
	});

	it("should keep task A when a hashchange carries a task prefix without id or an undecodable id", async () => {
		// Arrange：#/t/ 解析不出 taskId；#/t/%ZZ 的 decodeURIComponent 抛错同样回落 null
		const harness = await bootAtTaskA();

		// Act & Assert：空 id
		const transcriptBeforeEmptyId = harness.transcriptChildren();
		const requestsBeforeEmptyId = harness.requests().length;
		await harness.fireHashChange("#/t/");
		expectTaskAUnchanged(harness, "#/t/", transcriptBeforeEmptyId);
		expect(harness.requests().length, "被忽略的路由不得发起新的请求").toBe(requestsBeforeEmptyId);

		// Act & Assert：decodeURIComponent 抛错的 id
		const transcriptBeforeBadEscape = harness.transcriptChildren();
		const requestsBeforeBadEscape = harness.requests().length;
		await harness.fireHashChange("#/t/%ZZ");
		expectTaskAUnchanged(harness, "#/t/%ZZ", transcriptBeforeBadEscape);
		expect(harness.requests().length, "被忽略的路由不得发起新的请求").toBe(requestsBeforeBadEscape);
	});

	it("should return to the root list when the hash becomes the root route \"#/\"", async () => {
		// Arrange：深链 task-a
		const harness = await bootAtTaskA();

		// Act：逐字 "#/"（「未找到该任务」卡片的返回列表入口）必须照常路由
		await harness.fireHashChange("#/");

		// Assert：当前任务被清空 —— 无 active 行、无 aria-current 当前段、空态文案出现
		expect(harness.activeRowTaskId(), "#/ 应清空当前任务的行高亮").toBeNull();
		const crumbs = harness.crumbState();
		expect(crumbs.currentLabel, "#/ 后 #crumbs 不得有 aria-current=page 当前段").toBeNull();
		expect(harness.hasEmptyState(), "#/ 应回到空态文案").toBe(true);
		expect(harness.hash(), "#/ 是被接受的路由，hash 保留").toBe("#/");
	});

	it("should keep task A's open panel through the next tree poll after an ignored hashchange \"#foo\"", async () => {
		// Arrange：深链 #/t/task-a 并展开面板
		const harness = await bootAtTaskA();

		// Act：被忽略的 hashchange（守卫直接 return，当下 DOM 无变化）后紧接一次树轮询重建
		await harness.fireHashChange("#foo");
		await harness.advanceTreePoll();

		// Assert：面板仍展开、.text 逐字不变 —— 面板键清零必须在守卫 return 之后；
		// 若清零被上移到守卫之前，当下视觉无变化，但下一次 renderTree 会收起面板
		expectPanelOpen(harness, "task-a");
	});

	it("should keep task A's open panel through the next tree poll after an ignored hashchange with an empty fragment", async () => {
		// Arrange：深链 #/t/task-a 并展开面板
		const harness = await bootAtTaskA();

		// Act：浏览器里裸 # 的 location.hash 就是 ""，同样被守卫忽略
		await harness.fireHashChange("");
		await harness.advanceTreePoll();

		// Assert：面板仍展开、.text 逐字不变（同上：清零不得早于守卫 return）
		expectPanelOpen(harness, "task-a");
	});
});

// ---------------------------------------------------------------------------
// 落点形状（字符串级）：锁住 A / A-7 / B1 / B2 的实现落点，防止只在 harness
// 桩里成立的假修复。字段名锁接受 openPanelTaskId / openPanelKey 任一等价名，
// 但「至多一块展开」「preventScroll: true」「route() 守卫 + hashchange 注册」
// 三类语义锁逐字不变。
// ---------------------------------------------------------------------------

describe("PAGE_HTML 面板保持 / 焦点恢复 / 路由守卫的落点形状（字符串级）", () => {
	/** 抽指定具名函数到下一个具名函数之间的函数体（沿用既有页面测试的写法）。 */
	function fnBody(name: string): string {
		const start = PAGE_HTML.indexOf(`function ${name}(`);
		expect(start, `missing function ${name}`).toBeGreaterThan(-1);
		const bodyStart = start + `function ${name}(`.length;
		const nextNamed = /function [A-Za-z_$][\w$]*\s*\(/.exec(PAGE_HTML.slice(bodyStart));
		expect(nextNamed, `missing named function after ${name}`).not.toBeNull();
		return PAGE_HTML.slice(start, bodyStart + (nextNamed as RegExpExecArray).index);
	}

	it("should declare the panel-key state field and drive the error panel mount and both toggle paths from it", () => {
		// Assert：state 字段（openPanelTaskId / openPanelKey 等价任一）+ renderList 内
		// 挂载 hidden 取值与 click/keydown 两条激活路径都要读写该字段（≥3 处）；
		// 用 includes 避免失败时整页 diff
		expect(
			/(openPanelTaskId|openPanelKey):\s*null/.test(PAGE_HTML),
			"state 需新增面板键字段（openPanelTaskId 或 openPanelKey，初始 null）",
		).toBe(true);
		const body = fnBody("renderList");
		const hits = body.match(/openPanelTaskId|openPanelKey/g) ?? [];
		expect(hits.length, "renderList 需：挂载 hidden 取值 + click 收/放 + keydown 收/放").toBeGreaterThanOrEqual(3);
	});

	it("should restore focus with focus({ preventScroll: true }) and record the focused row before the rebuild clears the tree", () => {
		// Assert：preventScroll 字面落点（正则先对字符串求值，失败时不整页 diff）
		expect(
			/\.focus\(\{\s*preventScroll:\s*true\s*\}\)/.test(PAGE_HTML),
			"焦点恢复必须走 focus({ preventScroll: true })",
		).toBe(true);

		// Assert：renderTree 内 activeElement 的读取早于清空重建
		const body = fnBody("renderTree");
		const activeIdx = body.indexOf("activeElement");
		const clearIdx = body.indexOf('textContent = ""');
		expect(activeIdx, "renderTree 重建前需记录 document.activeElement 上的焦点行").toBeGreaterThan(-1);
		expect(clearIdx, "renderTree 仍先清空再重建").toBeGreaterThan(activeIdx);
		expect(activeIdx, "焦点行记录必须早于 treeEl.textContent = \"\" 清空").toBeLessThan(clearIdx);

		// Assert：恢复路径不得引入滚动写入（第 14 批滚动不变量）
		expect(body, "renderTree 不得调用 scrollIntoView").not.toContain("scrollIntoView");
	});

	it("should guard route() with ROOT_HASH and a first-route state flag before state.taskId is assigned", () => {
		// Assert：根路由字面量常量
		expect(PAGE_HTML.includes('var ROOT_HASH = "#/";'), "需声明 var ROOT_HASH = \"#/\";").toBe(true);

		// Assert：route() 开头守卫 —— state 上的首路由标志 + ROOT_HASH，
		// 判定早于 state.taskId 赋值，通过后置位
		const body = fnBody("route");
		const flag = /state\.(routed|routeInitialized)\b/.exec(body)?.[1];
		expect(flag, "route() 需用 state 上的首路由标志（routed / routeInitialized）做守卫").toBeTruthy();
		expect(body.includes("ROOT_HASH"), "守卫需逐字比对根路由 ROOT_HASH").toBe(true);
		const guardIdx = body.indexOf(flag as string);
		const taskIdx = body.indexOf("state.taskId = routeTaskId()");
		expect(taskIdx, "route() 仍从 routeTaskId() 取当前任务").toBeGreaterThan(-1);
		expect(guardIdx, "守卫必须早于 state.taskId 赋值（否则首次路由/任务路由一起被拦）").toBeLessThan(taskIdx);
		expect(body, "守卫通过后需把首路由标志置 true").toMatch(new RegExp(`state\\.${flag}\\s*=\\s*true`));

		// Assert：注册语句逐字不变（守卫只能写在 route() 内部）
		expect(
			PAGE_HTML.includes('window.addEventListener("hashchange", route)'),
			'hashchange 注册语句必须逐字保持 window.addEventListener("hashchange", route)',
		).toBe(true);
	});
});
