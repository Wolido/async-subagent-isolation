/**
 * 红阶段测试：/subagent-web 侧栏（#tree-list / treeEl）滚动位置保持。
 *
 * 回归背景：renderTree() 每次整体重建行（treeEl.textContent = "" 后重挂），
 * 侧栏 scrollTop 归零 —— 点行切换任务、树轮询刷新、页面刷新都会跳回顶部。
 * 修复冻结契约两块（实现由 coder 落地；本组在 src 未改时新契约用例预期红，
 * 回归锁用例保持绿）：
 *
 * A. src/web/tree-view.ts 新增 4 个纯函数导出（经 ${…toString()} 内联进
 *    PAGE_HTML，必须自包含：无 import、无模块级常量、无 DOM 副作用、不抛）：
 *    1) sidebarScrollAnchor(rows, listTop, scrollTop) → {taskId, offset, scrollTop}：
 *       rows 为数组/类数组，每项形如 {dataset:{taskId}, getBoundingClientRect()}。
 *       返回第一个（按顺序）rect.bottom > listTop 的行作为锚点行；taskId =
 *       dataset.taskId（非字符串→""）；offset = rect.top − listTop（可为负）；
 *       scrollTop 原样透传（非有限数→0）。无满足行（空数组/全在容器上方）→
 *       {taskId:"", offset:0, scrollTop}。行缺 getBoundingClientRect 或返回
 *       非法值时跳过该行，不抛。
 *    2) sidebarRestoreScrollTop(anchor, rows, listTop, currentScrollTop, maxScrollTop)
 *       → number：anchor.taskId 非空时在 rows 中找同 taskId 行，找到 →
 *       next = currentScrollTop + (row.rect.top − listTop) − anchor.offset；
 *       未找到（或 taskId 为空）→ next = anchor.scrollTop；返回
 *       clamp(next, 0, max(0, maxScrollTop))；maxScrollTop / currentScrollTop
 *       非有限数按 0；anchor null/非法 → 视作 {taskId:"",offset:0,scrollTop:0}。
 *       不抛。关键不变量（验收 1/2）：rows 未变化且用当前视图的 anchor（同一
 *       位置的同一行）恢复时，返回值必须逐字（===，浮点误差为 0）等于传入的
 *       currentScrollTop。
 *    3) parseSidebarAnchor(raw) → 锚点对象 | null：JSON.parse 失败 / 结果非
 *       普通对象 / 为 null → null；否则归一化：taskId 非字符串→""，
 *       offset、scrollTop 非有限 number→0。
 *    4) serializeSidebarAnchor(anchor) → string：归一化后
 *       JSON.stringify({taskId, offset, scrollTop})（键顺序固定）；与
 *       parseSidebarAnchor 互为 round-trip。
 *
 * B. src/web/page.ts 源码级契约（字符串级断言）：
 *    - localStorage 键字面 "asi-sidebar-scroll"（不得用 token —— token 每次
 *      运行都变）；PAGE_HTML 逐字含上述 4 个函数的 fn.toString()；
 *    - state 声明新增 savedSidebarScroll: null、sidebarScrollInitialized: false；
 *    - renderTree()：先捕获锚点（captureSidebarAnchor( 或等价调用）早于
 *      treeEl.textContent = "" 清空；清空 → renderList( → 恢复
 *      （restoreSidebarAnchor( 或等价，且内部经 sidebarRestoreScrollTop()）；
 *      renderList( 之后仍调 autoScrollSidebar()（既有 B3 契约保留）；首渲染
 *      分支恢复 state.savedSidebarScroll；
 *    - autoScrollSidebar() 首行守卫包含 state.savedSidebarScroll（有保存位置
 *      不再执行一次性自动滚动 / 不再记录折叠待办）；仍有
 *      scrollTargetTaskId(state.tree, state.taskId) 调用点；折叠分支仍记录
 *      待办旗标（不消耗一次性机会）；
 *    - activateRow() 不含 autoScrollSidebar / treeEl.scrollTop / scrollIntoView；
 *    - focusRow() 仍是「roving tabindex + row.focus()」，无 scrollTop /
 *      scrollIntoView 直写；既有 moveFocus / Home / End 绑定保留；
 *    - boot()：route() 之前执行 state.savedSidebarScroll = …（读 localStorage）；
 *      treeEl "scroll" 监听持久化（含 persistSidebarScroll 或 localStorage
 *      写入 + 键字面），持久化键必须是 "asi-sidebar-scroll"；
 *    - applySidebar()/expandSidebar() 的折叠补滚仍受 !state.userScrolledSidebar
 *      与待办旗标门控。
 *
 * 六条验收 → 用例映射：
 *   验收 1（点行切换不跳顶）：sidebarRestoreScrollTop「rows 未变化逐字复原」
 *       不变量 + activateRow 无滚动写入；
 *   验收 2（轮询重建不跳顶）：同上不变量 + renderTree 捕获早于清空、恢复晚于
 *       renderList、恢复经 sidebarRestoreScrollTop 的次序断言；
 *   验收 3（刷新恢复上次位置）：serialize/parse round-trip + renderTree 首渲染
 *       使用 state.savedSidebarScroll + 锚点行消失回退 anchor.scrollTop 并
 *       clamp 到 [0, maxScrollTop] + boot 读取/持久化两条；
 *   验收 4（首开仍滚到最新）：autoScrollSidebar 的 scrollTargetTaskId 调用点 +
 *       renderTree 仍调 autoScrollSidebar() + 首行守卫含 saved 门控；
 *   验收 5（键盘最小滚动）：focusRow 源码契约 + moveFocus/Home/End 绑定仍在；
 *   验收 6（折叠延后滚动仅无保存位置时触发）：折叠分支待办旗标（不消耗一次性
 *       机会）+ 首行守卫含 saved 门控 + 展开补滚受 !userScrolledSidebar 与
 *       待办旗标门控。
 *
 * 审查补充缺口（本次新增）：
 *   缺口 1（当前 src 未改 → 预期红，要求 3/4）：折叠首渲染 + localStorage
 *       有保存位置 —— renderTree 置 state.sidebarScrollInitialized = true
 *       须受「列表非零高度」守卫；展开路径（applySidebar/expandSidebar）须在
 *       !sidebarScrollInitialized 时以 state.savedSidebarScroll 补恢复；
 *   缺口 2（当前实现下应绿的变异自证）：MUT-A（renderTree 恢复
 *       restoreSidebarAnchor(anchor) 而非 null）、MUT-B（autoScrollSidebar
 *       首行守卫 || state.savedSidebarScroll 不得反转）、MUT-C（saved 分支
 *       保留 firstRender 门控）。
 *   缺口 A（当前 src 未改 → 预期红）：applySidebar 展开补恢复分支的
 *       state.sidebarScrollInitialized = true 置位须受「列表非空」
 *       （querySelectorAll(".node").length > 0 / rows.length > 0）与
 *       「高度非零」（getBoundingClientRect().height > 0 / listRect.height > 0
 *       一类）双守卫，与 renderTree 首渲染置位一致；否则加载即折叠 + 有
 *       保存位置时，用户在首次 /api/tree 返回前点开侧栏 —— 0 行下恢复被
 *       clamp 成 0 却仍置位，恢复时机被永久消耗、保存位置丢失。
 *   缺口 B（当前实现下应绿的变异自证）：MUT-F（captureSidebarAnchor 行集
 *       换成 []，锚点永远退化为原始 scrollTop，行级锚定失效）、MUT-G
 *       （restoreSidebarAnchor 上界换成 var max = 1 / 0，每次恢复被
 *       clamp 成 0 = 跳顶复发）。
 *
 * 约定（沿仓库惯例，同 test/subagent-web-tree-view.test.ts /
 * test/subagent-web-page.test.ts）：globals:false 显式 import from "vitest"；
 * 新导出函数经动态 import 加载，缺失时抛带明确说明的错误（本文件可正常收集，
 * 不是收集/加载错误）；零新增依赖（无 jsdom），纯函数真值用例 + 源码级契约。
 */

import { describe, expect, it } from "vitest";
import { PAGE_HTML } from "../src/web/page.ts";

// ---------------------------------------------------------------------------
// 冻结类型的动态加载（红阶段 4 个新导出尚未实现）：缺失时抛带明确说明的错误
// 而非 TypeError；写法沿用 test/subagent-web-tree-view.test.ts。
// ---------------------------------------------------------------------------

type SidebarAnchor = { taskId: string; offset: number; scrollTop: number };
type SidebarScrollAnchor = (rows: unknown, listTop: number, scrollTop: number) => SidebarAnchor;
type SidebarRestoreScrollTop = (
	anchor: SidebarAnchor | null,
	rows: unknown,
	listTop: number,
	currentScrollTop: number,
	maxScrollTop: number,
) => number;
type ParseSidebarAnchor = (raw: string) => SidebarAnchor | null;
type SerializeSidebarAnchor = (anchor: unknown) => string;

/** 动态加载 sidebarScrollAnchor；未导出时抛出红阶段预期的明确错误。 */
async function loadSidebarScrollAnchor(): Promise<SidebarScrollAnchor> {
	const mod = (await import("../src/web/tree-view.ts")) as Record<string, unknown>;
	const fn = mod.sidebarScrollAnchor;
	if (typeof fn !== "function") {
		throw new Error("sidebarScrollAnchor 未从 src/web/tree-view.ts 导出（红阶段预期：需 coder 实现）");
	}
	return fn as SidebarScrollAnchor;
}

/** 动态加载 sidebarRestoreScrollTop；未导出时抛出红阶段预期的明确错误。 */
async function loadSidebarRestoreScrollTop(): Promise<SidebarRestoreScrollTop> {
	const mod = (await import("../src/web/tree-view.ts")) as Record<string, unknown>;
	const fn = mod.sidebarRestoreScrollTop;
	if (typeof fn !== "function") {
		throw new Error("sidebarRestoreScrollTop 未从 src/web/tree-view.ts 导出（红阶段预期：需 coder 实现）");
	}
	return fn as SidebarRestoreScrollTop;
}

/** 动态加载 parseSidebarAnchor；未导出时抛出红阶段预期的明确错误。 */
async function loadParseSidebarAnchor(): Promise<ParseSidebarAnchor> {
	const mod = (await import("../src/web/tree-view.ts")) as Record<string, unknown>;
	const fn = mod.parseSidebarAnchor;
	if (typeof fn !== "function") {
		throw new Error("parseSidebarAnchor 未从 src/web/tree-view.ts 导出（红阶段预期：需 coder 实现）");
	}
	return fn as ParseSidebarAnchor;
}

/** 动态加载 serializeSidebarAnchor；未导出时抛出红阶段预期的明确错误。 */
async function loadSerializeSidebarAnchor(): Promise<SerializeSidebarAnchor> {
	const mod = (await import("../src/web/tree-view.ts")) as Record<string, unknown>;
	const fn = mod.serializeSidebarAnchor;
	if (typeof fn !== "function") {
		throw new Error("serializeSidebarAnchor 未从 src/web/tree-view.ts 导出（红阶段预期：需 coder 实现）");
	}
	return fn as SerializeSidebarAnchor;
}

// ---------------------------------------------------------------------------
// 页面源码片段抽取（fnBody / stateDecl / bootBody / blockAt 沿用
// test/subagent-web-page.test.ts 的写法，独立副本避免跨测试文件耦合）。
// ---------------------------------------------------------------------------

/** 抽指定具名函数到下一个具名函数之间的函数体（含声明行）。 */
function fnBody(name: string): string {
	const start = PAGE_HTML.indexOf(`function ${name}(`);
	expect(start, `missing function ${name}`).toBeGreaterThan(-1);
	const bodyStart = start + `function ${name}(`.length;
	const nextNamed = /function [A-Za-z_$][\w$]*\s*\(/.exec(PAGE_HTML.slice(bodyStart));
	expect(nextNamed, `missing named function after ${name}`).not.toBeNull();
	return PAGE_HTML.slice(start, bodyStart + (nextNamed as RegExpExecArray).index);
}

/** 抽 `var state = { … };` 声明片段（对象字面量内首个 `};` 即声明结束）。 */
function stateDecl(): string {
	const start = PAGE_HTML.indexOf("var state = {");
	expect(start, "missing state object").toBeGreaterThan(-1);
	const end = PAGE_HTML.indexOf("};", start);
	expect(end, "missing state object end").toBeGreaterThan(start);
	return PAGE_HTML.slice(start, end + 2);
}

/** 抽 function boot( 到 IIFE 收尾之间的脚本（boot 之后无具名函数）。 */
function bootBody(): string {
	const start = PAGE_HTML.indexOf("function boot(");
	expect(start, "missing boot").toBeGreaterThan(-1);
	const end = PAGE_HTML.indexOf("})();", start);
	expect(end, "missing IIFE end after boot").toBeGreaterThan(start);
	return PAGE_HTML.slice(start, end);
}

/** 抽以 openIdx（`(` 下标）起的配平括号内容；返回括号内文本与配平 `)` 下标。 */
function parenContent(source: string, openIdx: number): { text: string; end: number } {
	expect(source[openIdx], "parenContent expects an open parenthesis").toBe("(");
	let depth = 0;
	for (let i = openIdx; i < source.length; i += 1) {
		if (source[i] === "(") {
			depth += 1;
		} else if (source[i] === ")") {
			depth -= 1;
			if (depth === 0) {
				return { text: source.slice(openIdx + 1, i), end: i };
			}
		}
	}
	throw new Error("unbalanced parentheses at index " + openIdx);
}

/**
 * 枚举 body 内所有 `if` 的条件文本与语句区域（花括号块或单语句），
 * 供「包围条件」「含某串的条件」两级断言复用。
 */
function ifScopes(body: string): { condition: string; start: number; end: number }[] {
	const scopes: { condition: string; start: number; end: number }[] = [];
	const re = /\bif\s*\(/g;
	let match: RegExpExecArray | null;
	while ((match = re.exec(body)) !== null) {
		const open = body.indexOf("(", match.index);
		if (open === -1) { continue; }
		const { text, end: condEnd } = parenContent(body, open);
		const after = condEnd + 1;
		const brace = body.indexOf("{", after);
		const semi = body.indexOf(";", after);
		let end = -1;
		if (brace !== -1 && (semi === -1 || brace < semi)) {
			end = after + blockAt(body, after).length;
		} else if (semi !== -1) {
			end = semi + 1;
		}
		if (end !== -1) { scopes.push({ condition: text, start: after, end }); }
		re.lastIndex = after;
	}
	return scopes;
}

/** 抽包含下标 idx 的最内层 if 条件；无包围 if 时按 label 报红。 */
function enclosingIfCondition(body: string, idx: number, label: string): string {
	const scopes = ifScopes(body)
		.filter((scope) => scope.start <= idx && idx < scope.end)
		.sort((a, b) => a.start - b.start);
	expect(scopes.length, label).toBeGreaterThan(0);
	return scopes[scopes.length - 1].condition;
}

/** 抽条件文本内含 needle 的首个 if 条件；缺失按 label 报红。 */
function ifConditionContaining(body: string, needle: string, label: string): string {
	const scope = ifScopes(body).find((candidate) => candidate.condition.includes(needle));
	expect(scope, label).not.toBeUndefined();
	return (scope as { condition: string }).condition;
}

/**
 * 从 idx 起抽第一个 `{` 所在的花括号块（按花括号配平），供分支级断言，
 * 避免窗口溢出到后续代码造成误判。
 */
function blockAt(source: string, idx: number): string {
	const open = source.indexOf("{", idx);
	expect(open, "missing block after index").toBeGreaterThan(-1);
	let depth = 0;
	for (let i = open; i < source.length; i += 1) {
		if (source[i] === "{") {
			depth += 1;
		} else if (source[i] === "}") {
			depth -= 1;
			if (depth === 0) {
				return source.slice(idx, i + 1);
			}
		}
	}
	throw new Error("unbalanced braces after index " + idx);
}

/** 抽具名函数体声明大括号后的首个 if 条件文本（括号配平），供首行守卫断言。 */
function firstIfCondition(body: string, fnName: string): string {
	const decl = body.indexOf(`function ${fnName}(`);
	expect(decl, `missing function ${fnName} declaration`).toBeGreaterThan(-1);
	const open = body.indexOf("{", decl);
	expect(open, `missing body open brace for ${fnName}`).toBeGreaterThan(-1);
	const local = body.slice(open).search(/\bif\s*\(/);
	expect(local, `missing leading if guard in ${fnName}`).toBeGreaterThan(-1);
	const paren = body.indexOf("(", open + local);
	expect(paren, "missing if condition parenthesis").toBeGreaterThan(-1);
	let depth = 0;
	for (let i = paren; i < body.length; i += 1) {
		if (body[i] === "(") {
			depth += 1;
		} else if (body[i] === ")") {
			depth -= 1;
			if (depth === 0) {
				return body.slice(paren + 1, i);
			}
		}
	}
	throw new Error("unbalanced if condition in " + fnName);
}

/**
 * 抽 autoScrollSidebar 内折叠守卫（treeEl.getBoundingClientRect().height === 0，
 * 内联或经 listRect/list 变量均可）所在分支；缺失时 expect 直接报红。
 */
function collapsedGuardBranch(): { body: string; branch: string; flag: string } {
	const body = fnBody("autoScrollSidebar");
	let idx = body.search(/treeEl\.getBoundingClientRect\(\)\.height\s*===\s*0/);
	if (idx === -1) {
		const decl = body.match(/(?:var|let|const)\s+(\w+)\s*=\s*treeEl\.getBoundingClientRect\(\)/);
		if (decl) {
			idx = body.search(new RegExp(`${decl[1]}\\.height\\s*===\\s*0`));
		}
	}
	expect(idx, "missing collapsed guard: treeEl.getBoundingClientRect().height === 0").toBeGreaterThan(-1);
	const branch = blockAt(body, idx);
	const pending = branch.match(/state\.(\w+)\s*=\s*true/);
	expect(pending, "collapsed branch must record a pending flag instead of consuming the one-shot").not.toBeNull();
	return { body, branch, flag: (pending as RegExpExecArray)[1] };
}

/** 行 fixture：dataset.taskId + getBoundingClientRect()（无 DOM，纯对象）。 */
type RowFixture = {
	dataset: { taskId: unknown };
	getBoundingClientRect: () => { top: number; bottom: number };
};

function row(taskId: unknown, top: number, bottom: number): RowFixture {
	return { dataset: { taskId }, getBoundingClientRect: () => ({ top, bottom }) };
}

// ================================================================
// sidebarScrollAnchor：锚点行捕获（数组/类数组，第一个底缘越过容器顶的行）
// ================================================================
describe("sidebarScrollAnchor", () => {
	it("should pick the first row crossing the list top as the anchor with offset = top − listTop (frozen 3-row fixture)", async () => {
		// Arrange: listTop=100；三行 top/bottom = [120,160] / [60,100] / [40,60]
		// —— 只有第一行 bottom(160) > 100（第二行 bottom === 100 不算越过）
		const sidebarScrollAnchor = await loadSidebarScrollAnchor();
		const rows = [row("r1", 120, 160), row("r2", 60, 100), row("r3", 40, 60)];

		// Act
		const anchor = sidebarScrollAnchor(rows, 100, 137.3);

		// Assert: 锚点 = 第一行；offset = 120 − 100 = 20；scrollTop 原样透传
		expect(anchor).toEqual({ taskId: "r1", offset: 20, scrollTop: 137.3 });
	});

	it("should treat a partially occluded row (top < listTop < bottom) as visible, with a negative offset", async () => {
		// Arrange: 第一行整个在容器上方；第二行被容器顶缘裁切（top=80 < 100 < bottom=140）
		const sidebarScrollAnchor = await loadSidebarScrollAnchor();
		const rows = [row("gone", 40, 99), row("partial", 80, 140), row("below", 200, 240)];

		// Act
		const anchor = sidebarScrollAnchor(rows, 100, 80);

		// Assert: 部分遮挡也算可见；offset 可为负（80 − 100 = −20）
		expect(anchor).toEqual({ taskId: "partial", offset: -20, scrollTop: 80 });
	});

	it("should take the earliest visible row in order when several rows are visible", async () => {
		// Arrange: 首行在容器上方（跳过），其后两行都可见 —— 取顺序上的第一个
		const sidebarScrollAnchor = await loadSidebarScrollAnchor();
		const rows = [row("gone", 40, 99), row("first", 120, 160), row("second", 130, 170)];

		// Act
		const anchor = sidebarScrollAnchor(rows, 100, 0);

		// Assert
		expect(anchor).toEqual({ taskId: "first", offset: 20, scrollTop: 0 });
	});

	it("should return an empty anchor when every row sits above the container top, keeping the scrollTop passthrough", async () => {
		// Arrange: 全部行 bottom ≤ listTop —— 没有可见锚点行
		const sidebarScrollAnchor = await loadSidebarScrollAnchor();
		const rows = [row("a", 10, 40), row("b", 50, 90), row("c", 60, 100)];

		// Act
		const anchor = sidebarScrollAnchor(rows, 100, 64.5);

		// Assert: 空锚点，但 scrollTop 仍是透传值（不归零）
		expect(anchor).toEqual({ taskId: "", offset: 0, scrollTop: 64.5 });
	});

	it("should return an empty anchor for an empty row list", async () => {
		// Arrange / Act
		const sidebarScrollAnchor = await loadSidebarScrollAnchor();
		const anchor = sidebarScrollAnchor([], 100, 12);

		// Assert
		expect(anchor).toEqual({ taskId: "", offset: 0, scrollTop: 12 });
	});

	it("should skip rows without a usable getBoundingClientRect instead of throwing", async () => {
		// Arrange: 缺 getBoundingClientRect 的行 + 返回非法值（null）的行在前
		const sidebarScrollAnchor = await loadSidebarScrollAnchor();
		const rows = [
			{ dataset: { taskId: "no-rect" } },
			{ dataset: { taskId: "null-rect" }, getBoundingClientRect: () => null as never },
			row("good", 120, 160),
		];

		// Act / Assert: 坏行被跳过、不抛；锚点落到最后的合法行
		const anchor = sidebarScrollAnchor(rows, 100, 10);
		expect(anchor).toEqual({ taskId: "good", offset: 20, scrollTop: 10 });
	});

	it("should normalize a non-string dataset.taskId to an empty string", async () => {
		// Arrange: unknown 节点形状（taskId 非字符串）
		const sidebarScrollAnchor = await loadSidebarScrollAnchor();

		// Act / Assert
		expect(sidebarScrollAnchor([row(42, 120, 160)], 100, 0)).toEqual({ taskId: "", offset: 20, scrollTop: 0 });
		expect(sidebarScrollAnchor([row(undefined, 120, 160)], 100, 0)).toEqual({ taskId: "", offset: 20, scrollTop: 0 });
	});

	it("should coerce a non-finite scrollTop to 0", async () => {
		// Arrange: 透传参数非法形状（NaN / Infinity）
		const sidebarScrollAnchor = await loadSidebarScrollAnchor();

		// Act / Assert: 非有限数一律归 0（同一归一化行为）
		expect(sidebarScrollAnchor([row("r1", 120, 160)], 100, Number.NaN).scrollTop).toBe(0);
		expect(sidebarScrollAnchor([row("r1", 120, 160)], 100, Infinity).scrollTop).toBe(0);
	});

	it("should accept an array-like rows collection (length + indexed items)", async () => {
		// Arrange: 冻结接口声明 rows 为数组/类数组
		const sidebarScrollAnchor = await loadSidebarScrollAnchor();
		const rows = { 0: row("r1", 120, 160), 1: row("r2", 180, 220), length: 2 };

		// Act
		const anchor = sidebarScrollAnchor(rows, 100, 5);

		// Assert
		expect(anchor).toEqual({ taskId: "r1", offset: 20, scrollTop: 5 });
	});
});

// ================================================================
// sidebarRestoreScrollTop：锚点行位移差复原 + 回退 + clamp
// ================================================================
describe("sidebarRestoreScrollTop", () => {
	it("should return currentScrollTop verbatim (===, zero float error) when rows are unchanged and the anchor row is re-measured", async () => {
		// Arrange: 用当前视图捕获 anchor（同一位置的同一行），rows 不变后恢复
		const sidebarScrollAnchor = await loadSidebarScrollAnchor();
		const sidebarRestoreScrollTop = await loadSidebarRestoreScrollTop();
		const rows = [row("t1", 130.55, 162.55), row("t2", 200, 240)];
		const anchor = sidebarScrollAnchor(rows, 100, 137.3);

		// Act: 恢复测量时刻的 currentScrollTop 恰为捕获时的值
		const next = sidebarRestoreScrollTop(anchor, rows, 100, 137.3, 1000);

		// Assert（验收 1/2 关键不变量）: 逐字复原，浮点误差为 0
		expect(next).toBe(137.3);
	});

	it("should shift by (rowTop − listTop) − anchor.offset when the anchor row moved since capture", async () => {
		// Arrange: 锚点行捕获时在 120（offset 20），恢复时被顶下去到 150 ——
		// 当前 scrollTop=100 → 100 + 50 − 20 = 130
		const sidebarRestoreScrollTop = await loadSidebarRestoreScrollTop();
		const anchor = { taskId: "a", offset: 20, scrollTop: 0 };

		// Act
		const next = sidebarRestoreScrollTop(anchor, [row("a", 150, 190)], 100, 100, 1000);

		// Assert
		expect(next).toBe(130);
	});

	it("should fall back to anchor.scrollTop when the anchor row is no longer rendered", async () => {
		// Arrange: 锚点行消失（任务删除/不在已加载列表）
		const sidebarRestoreScrollTop = await loadSidebarRestoreScrollTop();
		const anchor = { taskId: "gone", offset: 20, scrollTop: 64.5 };

		// Act
		const next = sidebarRestoreScrollTop(anchor, [row("other", 120, 160)], 100, 100, 1000);

		// Assert
		expect(next).toBe(64.5);
	});

	it("should fall back to anchor.scrollTop when the anchor taskId is empty even though rows exist", async () => {
		// Arrange: taskId 为空 —— 不做行匹配（unknown 锚点）
		const sidebarRestoreScrollTop = await loadSidebarRestoreScrollTop();
		const anchor = { taskId: "", offset: 0, scrollTop: 64.5 };

		// Act
		const next = sidebarRestoreScrollTop(anchor, [row("x", 120, 160)], 100, 100, 1000);

		// Assert
		expect(next).toBe(64.5);
	});

	it("should clamp a fallback above maxScrollTop down to maxScrollTop", async () => {
		// Arrange: 回退值 500 超过可滚上界 300（验收 3：锚点行消失 + clamp）
		const sidebarRestoreScrollTop = await loadSidebarRestoreScrollTop();
		const anchor = { taskId: "gone", offset: 20, scrollTop: 500 };

		// Act
		const next = sidebarRestoreScrollTop(anchor, [], 100, 0, 300);

		// Assert
		expect(next).toBe(300);
	});

	it("should clamp a negative restored value to 0", async () => {
		// Arrange: 找到行但位移差使 next 为负（offset 50、当前 top 与 listTop 齐平）
		const sidebarRestoreScrollTop = await loadSidebarRestoreScrollTop();
		const anchor = { taskId: "x", offset: 50, scrollTop: 10 };

		// Act: next = 10 + (100 − 100) − 50 = −40 → 0
		const next = sidebarRestoreScrollTop(anchor, [row("x", 100, 130)], 100, 10, 1000);

		// Assert
		expect(next).toBe(0);
	});

	it("should treat a negative maxScrollTop as 0 (upper bound = max(0, maxScrollTop))", async () => {
		// Arrange / Act: 上界按 max(0, −5) = 0 —— 任何正值都被压到 0
		const sidebarRestoreScrollTop = await loadSidebarRestoreScrollTop();
		const next = sidebarRestoreScrollTop({ taskId: "", offset: 0, scrollTop: 10 }, [], 100, 0, -5);

		// Assert
		expect(next).toBe(0);
	});

	it("should return 0 for a null anchor", async () => {
		// Arrange: anchor 缺失（localStorage 里没有、或首渲染前）——
		// 视作 {taskId:"", offset:0, scrollTop:0}，currentScrollTop 不参与
		const sidebarRestoreScrollTop = await loadSidebarRestoreScrollTop();

		// Act / Assert
		expect(sidebarRestoreScrollTop(null, [], 100, 42, 500)).toBe(0);
	});

	it("should treat a non-finite currentScrollTop as 0", async () => {
		// Arrange: 恢复测量时刻 scrollTop 非法 —— 按 0 参与位移差
		const sidebarRestoreScrollTop = await loadSidebarRestoreScrollTop();
		const anchor = { taskId: "x", offset: 5, scrollTop: 99 };

		// Act: next = 0 + (110 − 100) − 5 = 5
		const next = sidebarRestoreScrollTop(anchor, [row("x", 110, 140)], 100, Number.NaN, 1000);

		// Assert
		expect(next).toBe(5);
	});

	it("should treat a non-finite maxScrollTop as 0", async () => {
		// Arrange: 上界非法 → 按 0 —— 正的回退值被压到 0
		const sidebarRestoreScrollTop = await loadSidebarRestoreScrollTop();

		// Act / Assert
		expect(sidebarRestoreScrollTop({ taskId: "", offset: 0, scrollTop: 100 }, [], 100, 50, Infinity)).toBe(0);
	});
});

// ================================================================
// parseSidebarAnchor：localStorage 字符串 → 锚点对象（归一化）
// ================================================================
describe("parseSidebarAnchor", () => {
	it("should parse a valid JSON anchor object", async () => {
		// Arrange
		const parseSidebarAnchor = await loadParseSidebarAnchor();

		// Act
		const anchor = parseSidebarAnchor('{"taskId":"01a12d38","offset":-12.5,"scrollTop":240}');

		// Assert
		expect(anchor).toEqual({ taskId: "01a12d38", offset: -12.5, scrollTop: 240 });
	});

	it("should return null for unparsable JSON", async () => {
		// Arrange / Act
		const parseSidebarAnchor = await loadParseSidebarAnchor();

		// Assert
		expect(parseSidebarAnchor("not json")).toBeNull();
	});

	it("should return null for the JSON literal null", async () => {
		// Arrange / Act
		const parseSidebarAnchor = await loadParseSidebarAnchor();

		// Assert: JSON.parse 成功但结果为 null —— 无锚点可恢复
		expect(parseSidebarAnchor("null")).toBeNull();
	});

	it("should return null for a JSON array", async () => {
		// Arrange / Act
		const parseSidebarAnchor = await loadParseSidebarAnchor();

		// Assert: 数组不是普通对象
		expect(parseSidebarAnchor("[1,2]")).toBeNull();
	});

	it("should return null for JSON primitives that are not plain objects", async () => {
		// Arrange / Act
		const parseSidebarAnchor = await loadParseSidebarAnchor();

		// Assert: 数字 / 字符串字面量同样不是普通对象
		expect(parseSidebarAnchor("42")).toBeNull();
		expect(parseSidebarAnchor('"task"')).toBeNull();
	});

	it("should normalize missing or wrongly typed fields to the frozen defaults", async () => {
		// Arrange: taskId 非字符串、offset 非数字、scrollTop 缺失
		const parseSidebarAnchor = await loadParseSidebarAnchor();

		// Act
		const anchor = parseSidebarAnchor('{"taskId":42,"offset":"x"}');

		// Assert
		expect(anchor).toEqual({ taskId: "", offset: 0, scrollTop: 0 });
	});
});

// ================================================================
// serializeSidebarAnchor：锚点对象 → localStorage 字符串（归一化 + round-trip）
// ================================================================
describe("serializeSidebarAnchor", () => {
	it("should emit the three keys in the exact taskId, offset, scrollTop order", async () => {
		// Arrange
		const serializeSidebarAnchor = await loadSerializeSidebarAnchor();

		// Act
		const raw = serializeSidebarAnchor({ taskId: "t1", offset: 12.5, scrollTop: 240 });

		// Assert: 键顺序固定（刷新后 parse 结果不受键序影响，且值稳定可比）
		expect(raw).toBe('{"taskId":"t1","offset":12.5,"scrollTop":240}');
	});

	it("should round-trip a valid anchor through parseSidebarAnchor without loss (acceptance 3)", async () => {
		// Arrange: 负偏移的小数 offset + 正 scrollTop
		const serializeSidebarAnchor = await loadSerializeSidebarAnchor();
		const parseSidebarAnchor = await loadParseSidebarAnchor();

		// Act
		const parsed = parseSidebarAnchor(serializeSidebarAnchor({ taskId: "01a1", offset: -12.75, scrollTop: 300 }));

		// Assert: parse(serialize(a)) 深等于归一化后的 a
		expect(parsed).toEqual({ taskId: "01a1", offset: -12.75, scrollTop: 300 });
	});

	it("should round-trip invalid fields to the normalized defaults", async () => {
		// Arrange: taskId 非字符串、offset 非有限数、scrollTop 非有限数
		const serializeSidebarAnchor = await loadSerializeSidebarAnchor();
		const parseSidebarAnchor = await loadParseSidebarAnchor();

		// Act
		const parsed = parseSidebarAnchor(serializeSidebarAnchor({ taskId: 7, offset: Infinity, scrollTop: Number.NaN }));

		// Assert: 序列化前先归一化（否则 Infinity 经 JSON.stringify 变 null 而非 0）
		expect(parsed).toEqual({ taskId: "", offset: 0, scrollTop: 0 });
	});

	it("should be deterministic: equal inputs serialize to equal strings", async () => {
		// Arrange
		const serializeSidebarAnchor = await loadSerializeSidebarAnchor();
		const anchor = { taskId: "t", offset: 1, scrollTop: 2 };

		// Act / Assert
		expect(serializeSidebarAnchor(anchor)).toBe(serializeSidebarAnchor(anchor));
	});
});

// ================================================================
// PAGE_HTML 契约（一）：localStorage 键字面 + state 新字段
// ================================================================
describe("PAGE_HTML 侧栏滚动持久化键与 state 字段（红阶段，字符串级）", () => {
	it("should use the literal localStorage key \"asi-sidebar-scroll\", never the per-run token", () => {
		// Arrange / Act: PAGE_HTML 为固定导出常量

		// Assert: 键逐字出现，且实际用在 localStorage 读/写上；token 每次运行
		// 都变，持久化键不得由它拼装
		expect(PAGE_HTML).toContain('"asi-sidebar-scroll"');
		expect(PAGE_HTML).toMatch(/localStorage\.(?:getItem|setItem)\(\s*"asi-sidebar-scroll"/);
	});

	it("should declare state.savedSidebarScroll as null and state.sidebarScrollInitialized as false", () => {
		// Arrange: state 对象声明片段
		const decl = stateDecl();

		// Assert: 两个新字段与冻结初值（null = 无保存位置；false = 尚未首渲染）
		expect(decl, "state must declare savedSidebarScroll: null").toMatch(/\bsavedSidebarScroll\s*:\s*null\b/);
		expect(decl, "state must declare sidebarScrollInitialized: false").toMatch(/\bsidebarScrollInitialized\s*:\s*false\b/);
	});
});

// ================================================================
// PAGE_HTML 契约（二）：4 个纯函数经 ${…toString()} 逐字内联
// ================================================================
describe("PAGE_HTML 侧栏滚动纯函数内联（红阶段，字符串级）", () => {
	it("should inline the sidebarScrollAnchor source verbatim into PAGE_HTML", async () => {
		// Arrange
		const sidebarScrollAnchor = await loadSidebarScrollAnchor();

		// Act / Assert: ${sidebarScrollAnchor.toString()} 插值 —— 删除即红
		expect(PAGE_HTML).toContain(sidebarScrollAnchor.toString());
	});

	it("should inline the sidebarRestoreScrollTop source verbatim into PAGE_HTML", async () => {
		// Arrange
		const sidebarRestoreScrollTop = await loadSidebarRestoreScrollTop();

		// Act / Assert
		expect(PAGE_HTML).toContain(sidebarRestoreScrollTop.toString());
	});

	it("should inline the parseSidebarAnchor source verbatim into PAGE_HTML", async () => {
		// Arrange
		const parseSidebarAnchor = await loadParseSidebarAnchor();

		// Act / Assert
		expect(PAGE_HTML).toContain(parseSidebarAnchor.toString());
	});

	it("should inline the serializeSidebarAnchor source verbatim into PAGE_HTML", async () => {
		// Arrange
		const serializeSidebarAnchor = await loadSerializeSidebarAnchor();

		// Act / Assert
		expect(PAGE_HTML).toContain(serializeSidebarAnchor.toString());
	});
});

// ================================================================
// PAGE_HTML 契约（三）：renderTree 捕获 → 清空 → 重挂 → 恢复 的次序
// （验收 2；首渲染 saved 分支见下一组，验收 3）
// ================================================================
describe("PAGE_HTML renderTree 侧栏锚点捕获与恢复次序（红阶段，字符串级）", () => {
	/** renderTree 体内锚点捕获调用（captureSidebarAnchor 或等价的 sidebarScrollAnchor）。 */
	function captureCallIndex(body: string): number {
		const candidates = [body.indexOf("captureSidebarAnchor("), body.indexOf("sidebarScrollAnchor(")].filter(
			(idx) => idx >= 0,
		);
		return candidates.length > 0 ? Math.min(...candidates) : -1;
	}

	/** renderTree 体内恢复调用（restoreSidebarAnchor 或等价的 sidebarRestoreScrollTop）。 */
	function restoreCallIndex(body: string): number {
		const candidates = [body.indexOf("restoreSidebarAnchor("), body.indexOf("sidebarRestoreScrollTop(")].filter(
			(idx) => idx >= 0,
		);
		return candidates.length > 0 ? Math.min(...candidates) : -1;
	}

	it("should capture the sidebar anchor before clearing #tree-list in renderTree", () => {
		// Arrange
		const body = fnBody("renderTree");
		const captureIdx = captureCallIndex(body);
		const clearIdx = body.indexOf('treeEl.textContent = ""');

		// Assert: 捕获调用存在，且早于清空（清空后旧行的几何信息不可再得）
		expect(captureIdx, "renderTree must capture the sidebar anchor").toBeGreaterThan(-1);
		expect(clearIdx, 'renderTree must clear with treeEl.textContent = ""').toBeGreaterThan(-1);
		expect(captureIdx, "anchor capture must precede the list clear").toBeLessThan(clearIdx);
	});

	it("should clear, re-mount via renderList, then restore the sidebar scroll (acceptance 2)", () => {
		// Arrange
		const body = fnBody("renderTree");
		const clearIdx = body.indexOf('treeEl.textContent = ""');
		const listIdx = body.search(/renderList\(/);
		const restoreIdx = restoreCallIndex(body);

		// Assert: 清空 → renderList → 恢复，三步严格有序
		expect(clearIdx, 'renderTree must clear with treeEl.textContent = ""').toBeGreaterThan(-1);
		expect(listIdx, "renderTree must re-mount rows via renderList(").toBeGreaterThan(clearIdx);
		expect(restoreIdx, "renderTree must restore the sidebar scroll").toBeGreaterThan(listIdx);
	});

	it("should route the restore through sidebarRestoreScrollTop", () => {
		// Arrange
		const body = fnBody("renderTree");

		// Assert: renderTree 直调 sidebarRestoreScrollTop，或经恢复 helper 且
		// 该 helper 内部调用它（恢复数学只有这一处实现）
		if (body.includes("restoreSidebarAnchor(")) {
			const helper = fnBody("restoreSidebarAnchor");
			expect(helper, "restoreSidebarAnchor must call sidebarRestoreScrollTop").toMatch(/sidebarRestoreScrollTop\s*\(/);
		} else {
			expect(body, "renderTree must call sidebarRestoreScrollTop").toMatch(/sidebarRestoreScrollTop\s*\(/);
		}
	});

	it("should keep calling autoScrollSidebar() after renderList in renderTree (acceptance 4 regression)", () => {
		// Arrange: 既有 B3 契约 —— 首开自动滚在挂行之后执行
		const body = fnBody("renderTree");
		const listIdx = body.search(/renderList\(/);
		const autoIdx = body.search(/autoScrollSidebar\s*\(\s*\)/);

		// Assert
		expect(listIdx, "renderTree must call renderList first").toBeGreaterThan(-1);
		expect(autoIdx, "renderTree must still call autoScrollSidebar()").toBeGreaterThan(listIdx);
	});

	it("should restore the saved position through state.savedSidebarScroll on the first render (acceptance 3)", () => {
		// Arrange: renderTree 函数体
		const body = fnBody("renderTree");

		// Assert: 首渲染（state.savedSidebarScroll 有值）分支里恢复保存位置
		expect(body, "renderTree must consult state.savedSidebarScroll for the first render").toContain(
			"state.savedSidebarScroll",
		);
	});

	it("should pass state.savedSidebarScroll as the restore argument in the first-render saved branch", () => {
		// Arrange: renderTree 函数体
		const body = fnBody("renderTree");

		// Assert: 保存位置必须真正作为恢复入参，而不只是出现在 if 条件里
		expect(
			body,
			"saved 分支必须把 state.savedSidebarScroll 传给恢复（restoreSidebarAnchor(state.savedSidebarScroll)）；仅在 if 条件里读取而不作为恢复入参，会让保存位置永不恢复（验收 3 运行时行为损坏）",
		).toMatch(/restoreSidebarAnchor\s*\(\s*state\.savedSidebarScroll\s*\)/);
	});
});

// ================================================================
// PAGE_HTML 契约（四）：autoScrollSidebar 的 saved 门控 + 折叠待办回归
// （验收 4 / 验收 6）
// ================================================================
describe("PAGE_HTML autoScrollSidebar 保存位置门控与折叠待办（红阶段，字符串级）", () => {
	it("should include state.savedSidebarScroll in the leading guard of autoScrollSidebar (acceptance 4/6)", () => {
		// Arrange
		const body = fnBody("autoScrollSidebar");

		// Assert: 首行守卫读取保存位置 —— 有保存位置时不再执行一次性自动滚动
		const cond = firstIfCondition(body, "autoScrollSidebar");
		expect(cond, "autoScrollSidebar's leading guard must read state.savedSidebarScroll").toContain(
			"state.savedSidebarScroll",
		);
	});

	it("should keep the deep-link-aware target call scrollTargetTaskId(state.tree, state.taskId) (acceptance 4 regression)", () => {
		// Arrange: autoScrollSidebar 函数体
		const body = fnBody("autoScrollSidebar");

		// Assert: 首开自动滚目标仍是既有调用点（深链优先，最新 running/末行）
		expect(body).toContain("scrollTargetTaskId(state.tree, state.taskId)");
	});

	it("should record a pending flag without consuming the one-shot when the sidebar is collapsed (acceptance 6 regression)", () => {
		// Arrange: 折叠守卫分支（treeEl.getBoundingClientRect().height === 0）
		const { branch } = collapsedGuardBranch();

		// Assert: 提前 return、不消耗一次性机会，改为记录待办旗标
		expect(branch, "collapsed branch must early-return").toMatch(/\breturn\b/);
		expect(branch, "collapsed branch must not consume the one-shot").not.toMatch(/autoScrolledOnce\s*=\s*true/);
		const pending = branch.match(/state\.(\w+)\s*=\s*true/);
		expect(pending, "collapsed branch must record a pending flag").not.toBeNull();
		expect((pending as RegExpExecArray)[1]).not.toBe("autoScrolledOnce");
		expect((pending as RegExpExecArray)[1]).not.toBe("userScrolledSidebar");
	});

	it("should gate the expand catch-up on !state.userScrolledSidebar and the pending flag (acceptance 6 regression)", () => {
		// Arrange: 待办旗标名取自折叠分支（与上一条用例同源）
		const { flag } = collapsedGuardBranch();
		const combined = fnBody("expandSidebar") + "\n" + fnBody("applySidebar");

		// Act: 展开路径上的补滚调用点
		const callIdx = combined.search(/autoScrollSidebar\s*\(\s*\)/);

		// Assert: 补滚一次，且调用点之前已有 !state.userScrolledSidebar 与旗标读取
		expect(callIdx, "missing autoScrollSidebar() catch-up on the expand path").toBeGreaterThan(-1);
		const guardIdx = combined.search(/!state\.userScrolledSidebar/);
		expect(guardIdx, "catch-up must be gated on !state.userScrolledSidebar").toBeGreaterThan(-1);
		expect(guardIdx).toBeLessThan(callIdx);
		expect(combined.slice(0, callIdx), `catch-up must read the pending flag state.${flag}`).toContain(`state.${flag}`);
	});
});

// ================================================================
// PAGE_HTML 契约（五）：activateRow 不改侧栏滚动（验收 1）
// ================================================================
describe("PAGE_HTML activateRow 不触碰侧栏滚动（验收 1，字符串级）", () => {
	it("should keep activateRow free of autoScrollSidebar, treeEl.scrollTop and scrollIntoView (acceptance 1)", () => {
		// Arrange: activateRow 函数体（点击/Enter 共用的激活路径）
		const body = fnBody("activateRow");

		// Assert: 点行切换任务绝不改变侧栏滚动 —— 无自动滚调用、无 scrollTop
		// 直写、无 scrollIntoView；滚动位置完全由 renderTree 的锚点恢复负责
		expect(body, "activateRow must not trigger the one-shot auto scroll").not.toMatch(/autoScrollSidebar/);
		expect(body, "activateRow must not write treeEl.scrollTop").not.toMatch(/treeEl\.scrollTop/);
		expect(body, "activateRow must not scrollIntoView").not.toContain("scrollIntoView");
	});
});

// ================================================================
// PAGE_HTML 契约（六）：键盘最小滚动契约保留（验收 5）
// ================================================================
describe("PAGE_HTML 键盘焦点移动最小滚动契约（验收 5，字符串级）", () => {
	it("should keep focusRow on roving tabindex plus row.focus() with no direct scroll writes", () => {
		// Arrange: focusRow 函数体
		const body = fnBody("focusRow");

		// Assert: 仍是「设置 roving tabindex + row.focus()」；滚动交给浏览器
		// focus() 的最小滚动，不直接写 scrollTop / scrollIntoView
		expect(body).toMatch(/setAttribute\(\s*"tabindex"/);
		expect(body).toMatch(/\.focus\(\)/);
		expect(body, "focusRow must not write scrollTop").not.toMatch(/scrollTop/);
		expect(body, "focusRow must not scrollIntoView").not.toContain("scrollIntoView");
	});

	it("should keep the ArrowUp/ArrowDown and Home/End bindings on moveFocus and focusRow", () => {
		// Arrange / Act: PAGE_HTML 为固定导出常量（轻量源码断言，不重复
		// test/subagent-web-page.test.ts 的既有大段用例）

		// Assert: ↑↓ 走 moveFocus(±1)，Home/End 走 focusRow(首行/末行)
		expect(PAGE_HTML).toContain("function moveFocus(");
		expect(PAGE_HTML).toContain("moveFocus(row, 1, event)");
		expect(PAGE_HTML).toContain("moveFocus(row, -1, event)");
		expect(PAGE_HTML).toContain("focusRow(rows[0], event)");
		expect(PAGE_HTML).toContain("focusRow(rowsEnd[rowsEnd.length - 1], event)");
	});
});

// ================================================================
// PAGE_HTML 契约（七）：boot 读取 + 滚动持久化（验收 3）
// ================================================================
describe("PAGE_HTML boot 侧栏滚动恢复与持久化（验收 3，红阶段，字符串级）", () => {
	it("should load state.savedSidebarScroll from localStorage before route() runs in boot()", () => {
		// Arrange
		const boot = bootBody();
		const assignIdx = boot.search(/state\.savedSidebarScroll\s*=(?!=)/);

		// Assert: 赋值存在且早于 route()（路由渲染时保存位置已就位）
		expect(assignIdx, "boot must assign state.savedSidebarScroll before the first render").toBeGreaterThan(-1);
		const routeIdx = boot.search(/\broute\(\)\s*;/);
		expect(routeIdx, "boot must still call route()").toBeGreaterThan(-1);
		expect(assignIdx, "the saved anchor must be loaded before route()").toBeLessThan(routeIdx);

		// Assert: 赋值附近从 localStorage 读持久化键（刷新恢复的数据来源）
		const windowText = boot.slice(Math.max(0, assignIdx - 300), assignIdx + 400);
		expect(windowText, "the saved anchor must be read from localStorage").toContain("localStorage");
		expect(windowText, "the localStorage read must use the literal asi-sidebar-scroll key").toContain(
			'"asi-sidebar-scroll"',
		);
	});

	it("should persist the sidebar scroll anchor from a treeEl scroll listener in boot()", () => {
		// Arrange
		const boot = bootBody();
		const listenIdx = boot.search(/treeEl\.addEventListener\(\s*"scroll"/);

		// Assert: 滚动监听存在，且回调内持久化 —— persistSidebarScroll( 或
		// localStorage.setItem + 键字面
		expect(listenIdx, 'boot must register treeEl.addEventListener("scroll"').toBeGreaterThan(-1);
		const block = blockAt(boot, listenIdx);
		const persists =
			/persistSidebarScroll\s*\(/.test(block) ||
			(/localStorage\.setItem/.test(block) && block.includes("asi-sidebar-scroll"));
		expect(
			persists,
			'the scroll listener must persist via persistSidebarScroll() or localStorage.setItem("asi-sidebar-scroll")',
		).toBe(true);
	});
});

// ================================================================
// 缺口 1（当前 src 未改 → 预期红）：折叠首渲染不消耗侧栏恢复时机（要求 3/4）
//
// 场景：页面加载时侧栏折叠（#tree-list 高度 0）+ localStorage 有保存位置。
// 现实现首渲染就把 state.sidebarScrollInitialized 置 true，折叠下
// scrollHeight - clientHeight = 0，保存位置被 clamp 成 0 且唯一恢复时机
// 被消耗；展开后不再恢复。期望：折叠首渲染不置位（不消耗恢复时机），
// 展开时以 state.savedSidebarScroll 恢复。
// ================================================================
describe("PAGE_HTML 折叠首渲染不消耗侧栏恢复时机（红阶段，字符串级）", () => {
	it("should guard the first-render state.sidebarScrollInitialized = true assignment behind a non-zero list height", () => {
		// Arrange: renderTree 体内首个（唯一）置位赋值
		const body = fnBody("renderTree");
		const assignIdx = body.search(/state\.sidebarScrollInitialized\s*=\s*true\b/);
		expect(assignIdx, "renderTree must assign state.sidebarScrollInitialized = true").toBeGreaterThan(-1);

		// Act: 包围该赋值的 if 条件（折叠时行仍挂载但高度为 0，不能仅按行数置位）
		const cond = enclosingIfCondition(
			body,
			assignIdx,
			"the sidebarScrollInitialized = true assignment must sit inside an if guard",
		);

		// Assert: 条件里判定列表 rect 高度 —— 出现 getBoundingClientRect（或
		// listRect 一类 rect 变量）+ .height 与 0 的比较，且语义是「高度非零」
		//（> 0 / !== 0，或 === 0 取反），折叠态（高度 0）不得置位
		const hasRect = /getBoundingClientRect\s*\(/.test(cond) || /\b\w*[Rr]ect\b/.test(cond);
		expect(
			hasRect,
			`the first-render flag must be guarded by a list rect measurement, got condition: ${cond}`,
		).toBe(true);
		expect(
			/\.height\s*(?:!==|===|>=|<=|>|<)\s*0\b/.test(cond),
			`the guard must compare a rect height against 0 (height > 0 / !== 0 / !height === 0), got condition: ${cond}`,
		).toBe(true);
		const nonZero =
			/\.height\s*(?:!==|>)\s*0\b/.test(cond) || /!\s*\(?\s*[\w.)\]]*\.height\s*===\s*0\b/.test(cond);
		expect(
			nonZero,
			`the guard must mean "list has non-zero height" (collapsed height === 0 must NOT flip the flag), got condition: ${cond}`,
		).toBe(true);
	});

	it("should restore state.savedSidebarScroll from the expand path while the sidebar stayed uninitialized", () => {
		// Arrange: 展开路径合并文本（applySidebar 为实际展开动作，expandSidebar 调它）
		const combined = fnBody("applySidebar") + "\n" + fnBody("expandSidebar");

		// Assert 1: 展开路径读取保存位置
		expect(
			combined,
			"the expand path must consult state.savedSidebarScroll (collapsed first render must not be the only restore moment)",
		).toContain("state.savedSidebarScroll");

		// Assert 2: 展开时调用恢复（restoreSidebarAnchor( 或等价 sidebarRestoreScrollTop(）
		const callIdx = combined.search(/(?:restoreSidebarAnchor|sidebarRestoreScrollTop)\s*\(/);
		expect(
			callIdx,
			"the expand path must call restoreSidebarAnchor(state.savedSidebarScroll) (or the equivalent sidebarRestoreScrollTop)",
		).toBeGreaterThan(-1);

		// Assert 3: 该调用受 sidebarScrollInitialized 门控（仅首渲染尚未完成时补恢复）
		const cond = enclosingIfCondition(
			combined,
			callIdx,
			"the expand-path restore must be gated by state.sidebarScrollInitialized",
		);
		expect(
			/!\s*state\.sidebarScrollInitialized\b|state\.sidebarScrollInitialized\s*===\s*false\b/.test(cond),
			`the expand-path restore must run only while state.sidebarScrollInitialized is false, got condition: ${cond}`,
		).toBe(true);
		const around = combined.slice(Math.max(0, callIdx - 220), callIdx + 180);
		expect(around, "the expand-path restore must consume state.savedSidebarScroll as its input").toContain(
			"state.savedSidebarScroll",
		);
	});
});

// ================================================================
// 缺口 A（当前 src 未改 → 预期红）：applySidebar 展开补恢复的置位须先
// 确认「列表非空且高度非零」，否则恢复时机被永久消耗。
//
// 场景：加载即折叠 + localStorage 有保存位置，用户在首次 /api/tree 返回
// 之前就点开侧栏 —— 此时 0 行、高度 0，restoreSidebarAnchor 把保存位置
// clamp 成 0 却仍置位 state.sidebarScrollInitialized = true，恢复时机被
// 永久消耗、保存位置丢失。期望：展开补恢复只在列表非空且高度非零时
// 消耗恢复时机（不满足不得置位），与 renderTree 首渲染置位的双守卫一致。
// ================================================================
describe("PAGE_HTML applySidebar 展开补恢复受列表非空与非零高度双守卫（红阶段，字符串级）", () => {
	it("should guard the expand-path state.sidebarScrollInitialized = true assignment behind a non-empty list and a non-zero list height", () => {
		// Arrange: applySidebar 体内展开补恢复分支的置位赋值
		const body = fnBody("applySidebar");
		const assignIdx = body.search(/state\.sidebarScrollInitialized\s*=\s*true\b/);
		expect(
			assignIdx,
			"applySidebar must assign state.sidebarScrollInitialized = true in the expand catch-up",
		).toBeGreaterThan(-1);

		// Act: 包围该赋值的最内层 if 条件
		const cond = enclosingIfCondition(
			body,
			assignIdx,
			"the expand-path sidebarScrollInitialized = true assignment must sit inside an if guard",
		);

		// Assert 1: 列表非空 —— 0 行时恢复无从谈起，不得消耗恢复时机
		const hasRows =
			/querySelectorAll\s*\(\s*"\.node"\s*\)\s*\.\s*length\s*(?:!==|>)\s*0\b/.test(cond) ||
			/\brows\s*\.\s*length\s*(?:!==|>)\s*0\b/.test(cond);
		expect(
			hasRows,
			`the expand catch-up must first check the list is non-empty (querySelectorAll(".node").length > 0 or rows.length > 0); expanding before the first /api/tree response would otherwise consume the restore moment against 0 rows and lose the saved position, got condition: ${cond}`,
		).toBe(true);

		// Assert 2: 高度非零 —— 折叠/未布局（height 0）时恢复被 clamp 成 0，
		// 同样不得置位消耗恢复时机（与 renderTree 首渲染双守卫一致）
		const hasHeight =
			/\.height\s*(?:!==|>)\s*0\b/.test(cond) ||
			/!\s*\(?\s*[\w.)\]]*\.height\s*===\s*0\b/.test(cond) ||
			/\.\s*height\b(?!\s*[=!<>])/.test(cond);
		expect(
			hasHeight,
			`the expand catch-up must first check the list has non-zero height (getBoundingClientRect().height > 0 / listRect.height > 0); a zero-height restore clamps to 0 yet would still flip the flag, permanently consuming the restore moment, got condition: ${cond}`,
		).toBe(true);
	});
});

// ================================================================
// 缺口 2：变异自证（当前已实现的正确代码下应绿，分别杀掉 MUT-A/B/C）
// ================================================================
describe("PAGE_HTML 侧栏滚动变异自证（MUT-A/B/C，当前实现下应绿）", () => {
	it("should restore the captured anchor (restoreSidebarAnchor(anchor)) instead of a no-op in renderTree (kills MUT-A)", () => {
		// Arrange: renderTree 体内恢复调用
		const body = fnBody("renderTree");

		// Act: 主判据 —— 用捕获的 anchor 恢复；备选 —— else 分支内使用 anchor
		const usesCaptured = /restoreSidebarAnchor\s*\(\s*anchor\s*\)/.test(body);
		const elseIdx = body.search(/}\s*else\s*\{/);
		const elseBlock = elseIdx >= 0 ? blockAt(body, body.indexOf("{", elseIdx)) : "";
		const usesAnchorInElse = /\banchor\b/.test(elseBlock);

		// Assert: restoreSidebarAnchor(null)（恢复变 no-op = 滚动跳顶 bug 复发）必须弄红
		expect(
			usesCaptured || usesAnchorInElse,
			"renderTree must restore the captured anchor (restoreSidebarAnchor(anchor)); restoreSidebarAnchor(null) degrades the restore to a no-op and re-introduces the scroll-to-top bug",
		).toBe(true);
	});

	it("should keep || state.savedSidebarScroll (never && !state.savedSidebarScroll) in the leading guard of autoScrollSidebar (kills MUT-B)", () => {
		// Arrange: 首行守卫
		const body = fnBody("autoScrollSidebar");
		const cond = firstIfCondition(body, "autoScrollSidebar");

		// Assert: 有保存位置时短路（不自动滚、不记录折叠待办）
		expect(
			/\|\|\s*state\.savedSidebarScroll\b/.test(cond),
			`the leading guard must short-circuit on || state.savedSidebarScroll, got condition: ${cond}`,
		).toBe(true);
		// Assert: 反转变异（有保存值反而自动滚）必须弄红
		expect(
			/!\s*state\.savedSidebarScroll\b/.test(cond),
			`the leading guard must not test !state.savedSidebarScroll (that would auto-scroll exactly when a saved position exists), got condition: ${cond}`,
		).toBe(false);
	});

	it("should keep the first-render saved branch gated by firstRender so later polls never jump back (kills MUT-C)", () => {
		// Arrange: renderTree 内含 state.savedSidebarScroll 的 if 条件
		const body = fnBody("renderTree");
		const cond = ifConditionContaining(
			body,
			"state.savedSidebarScroll",
			"renderTree must branch on state.savedSidebarScroll inside an if condition",
		);

		// Assert: 首渲染门控存在 —— 每次轮询都跳回开机位置的变异必须弄红
		expect(
			/\bfirstRender\b|!\s*state\.sidebarScrollInitialized\b|state\.sidebarScrollInitialized\s*===\s*false\b/.test(cond),
			`the saved-position branch must stay gated on firstRender / !state.sidebarScrollInitialized, got condition: ${cond}`,
		).toBe(true);
	});
});

// ================================================================
// 缺口 B：变异自证（当前实现下应绿，分别杀掉 MUT-F/G）
// ================================================================
describe("PAGE_HTML 锚点行集捕获与恢复上界变异自证（MUT-F/G，当前实现下应绿）", () => {
	it('should read the rendered rows via treeEl.querySelectorAll(".node") in captureSidebarAnchor (kills MUT-F)', () => {
		// Arrange: captureSidebarAnchor 函数体
		const body = fnBody("captureSidebarAnchor");

		// Assert: 行集换成 [] 时锚点永远退化为原始 scrollTop（行级锚定失效，
		// 该变异必须弄红）
		expect(
			body,
			'captureSidebarAnchor must read the row set with treeEl.querySelectorAll(".node"); replacing it with [] degrades every anchor to the raw scrollTop and silently disables row-level anchoring (MUT-F)',
		).toContain('treeEl.querySelectorAll(".node")');
	});

	it("should clamp the restore against the scrollHeight − clientHeight range as the upper bound in restoreSidebarAnchor (kills MUT-G)", () => {
		// Arrange: restoreSidebarAnchor 函数体
		const body = fnBody("restoreSidebarAnchor");

		// Assert: 上界 = scrollHeight − clientHeight 差值；换成 `var max = 1 / 0`
		// 时每次恢复都被 clamp 成 0（跳顶复发）——该变异必须弄红
		expect(
			body,
			"restoreSidebarAnchor must derive the clamp upper bound from the treeEl.scrollHeight - treeEl.clientHeight difference; replacing it with `var max = 1 / 0` disables the upper clamp so every restore clamps to 0 and the scroll-to-top bug reappears (MUT-G)",
		).toMatch(/scrollHeight\s*-\s*(?:\w+\.)*clientHeight/);
	});
});
