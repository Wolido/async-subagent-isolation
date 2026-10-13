/**
 * 回归/覆盖测试：底部进度组件（`SubagentProgressManager` 的 widget）鼠标点击。
 *
 * 目标功能（已实现，本文件正常情况下应全绿）：
 * 组件在 `render(width)` / `invalidate()` 之外提供可选 `handleMouse(event)`：
 *  - 仅响应 `event.type === "click" && event.button === "left"`；
 *  - `y=0`（上边框）或 `y >= 1 + visible.length`（下边框/越界）→ 返回 undefined，
 *    不消费事件；
 *  - 命中判定用 DISPLAY 列：`prefixWidth = visibleWidth("● ") + visibleWidth(taskId)
 *    + visibleWidth(" ")`，名字列区间 `[prefixWidth, min(event.width,
 *    prefixWidth + nameColWidth))`，命中当且仅当 `prefixWidth <= x < end`；
 *  - 命中 → 返回已处理结果，并异步确保进程级 web server 启动、打开平台
 *    opener 到 `${handle.url}#/t/<taskId>`；
 *  - 未命中 → 返回 undefined，且不启动 server、不 spawn。
 *
 * 模块隔离沿用 test/subagent-web-command.test.ts 的成熟模式。
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import { visibleWidth } from "@earendil-works/pi-tui";

// ---------------------------------------------------------------------------
// 模块 mock（工厂会被 vi.resetModules() 重跑；跨重跑状态放 vi.hoisted）
// ---------------------------------------------------------------------------

/** 镜像真实模块的 globalThis 单例语义（startWebServer 同步写入）。 */
const webState = vi.hoisted(() => ({
	currentServer: null as null | {
		port: number;
		url: string;
		token: string;
		close: ReturnType<typeof vi.fn>;
	},
}));

vi.mock("@earendil-works/pi-coding-agent", async () => {
	const actual = await vi.importActual("@earendil-works/pi-coding-agent");
	return {
		...actual,
		getAgentDir: vi.fn(),
	};
});

vi.mock("node:child_process", () => ({
	spawn: vi.fn(),
}));

vi.mock("../src/web/server.ts", () => ({
	startWebServer: vi.fn(),
	getGlobalServer: vi.fn(() => webState.currentServer),
}));

// ---------------------------------------------------------------------------
// 常量与 helpers
// ---------------------------------------------------------------------------

const WIDGET_KEY = "async-subagent-isolation-progress";
const PORT = 43210;
const TOKEN = "tok";
const BASE_URL = `http://127.0.0.1:${PORT}/?t=${TOKEN}`;
const SPAWN_OPTIONS = { detached: true, stdio: "ignore" };
/** 名字列命中起点：`visibleWidth("● ") + visibleWidth(taskId) + visibleWidth(" ")`。 */
const PREFIX_PREFIX = "● ";

/** 36 字符 UUID 形 taskId（各任务等长，避免列偏移干扰）。 */
function makeTaskId(n: number): string {
	return `019ffdd3-3eb5-733d-b481-a53e5292c${String(n).padStart(3, "0")}`;
}

/** 假进程：EventEmitter + no-op unref()，便于 emit("error") / ("exit")。 */
function createFakeProc() {
	const proc = new EventEmitter() as any;
	proc.unref = vi.fn();
	proc.kill = vi.fn(() => true);
	proc.stdout = new EventEmitter();
	proc.stderr = new EventEmitter();
	return proc;
}

/** Mock theme：返回纯文本（无 ANSI），渲染行即纯字符串。 */
function createMockTheme() {
	return {
		fg: vi.fn((_color: string, text: string) => text),
		bg: vi.fn((_color: string, text: string) => text),
		bold: vi.fn((text: string) => text),
		italic: vi.fn((text: string) => text),
		underline: vi.fn((text: string) => text),
		inverse: vi.fn((text: string) => text),
		strikethrough: vi.fn((text: string) => text),
		getFgAnsi: vi.fn(() => ""),
		getBgAnsi: vi.fn(() => ""),
		getColorMode: vi.fn(() => "truecolor"),
		getThinkingBorderColor: vi.fn(() => (s: string) => s),
		getBashModeBorderColor: vi.fn(() => (s: string) => s),
	} as any;
}

/** Mock ctx：hasUI + setWidget/notify 捕获。 */
function createMockCtx() {
	const notify = vi.fn();
	const setWidget = vi.fn();
	return {
		ctx: { cwd: "/tmp", hasUI: true, mode: "tui" as const, ui: { setWidget, notify } },
		notify,
	};
}

/** 取出最近一次 widget 工厂并实例化组件。 */
function getWidgetComponent(setWidget: ReturnType<typeof vi.fn>, theme: unknown) {
	const calls = setWidget.mock.calls.filter(
		([key, value]: [unknown, unknown]) => key === WIDGET_KEY && typeof value === "function",
	);
	expect(calls.length, "widget 工厂应已通过 setWidget 注册").toBeGreaterThan(0);
	const factory = calls[calls.length - 1][1] as (tui: unknown, theme: unknown) => any;
	return factory({}, theme);
}

/** 构造一次 click 事件（其余字段填齐，模拟 TuiMouseEvent）。 */
function makeClick(overrides: Record<string, unknown> = {}) {
	return {
		type: "click",
		button: "left",
		x: 0,
		y: 0,
		screenX: 0,
		screenY: 0,
		width: 200,
		height: 24,
		shift: false,
		alt: false,
		ctrl: false,
		...overrides,
	} as any;
}

/** 子串起点在渲染行中的 DISPLAY 列（0-based，visibleWidth 单位）。 */
function displayColOf(row: string, needle: string): number {
	const idx = row.indexOf(needle);
	expect(idx, `渲染行应包含 ${JSON.stringify(needle)}：${JSON.stringify(row)}`).toBeGreaterThanOrEqual(0);
	return visibleWidth(row.slice(0, idx));
}

/**
 * 单任务（已注册一个已知名字的 agent）名字列的命中区间：
 * `prefixWidth = visibleWidth("● ") + visibleWidth(taskId) + visibleWidth(" ")`，
 * `nameColWidth` 即该 agent 名字的显示宽度（上限 30），
 * `end = min(event.width, prefixWidth + nameColWidth)`。
 */
function nameColumnBounds(taskId: string, name: string, eventWidth: number) {
	const prefixWidth = visibleWidth(PREFIX_PREFIX) + visibleWidth(taskId) + visibleWidth(" ");
	const nameColWidth = Math.min(30, visibleWidth(name));
	return { prefixWidth, nameColWidth, end: Math.min(eventWidth, prefixWidth + nameColWidth) };
}

/** 让异步点击体（ensure server / spawn）在 fake timers 下推进完毕。 */
async function flushAsync(rounds = 5): Promise<void> {
	for (let i = 0; i < rounds; i++) {
		await Promise.resolve();
		await vi.advanceTimersByTimeAsync(0);
	}
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("SubagentProgressManager — 进度组件鼠标点击", () => {
	let mockTheme: ReturnType<typeof createMockTheme>;
	let SubagentProgressManager: typeof import("../src/index.ts")["SubagentProgressManager"];
	let spawnMock: ReturnType<typeof vi.fn>;
	let startWebServerMock: ReturnType<typeof vi.fn>;
	let allProcs: any[];
	let unregisterFns: Array<() => void>;

	beforeEach(async () => {
		vi.resetModules();
		vi.useFakeTimers();
		mockTheme = createMockTheme();
		allProcs = [];
		unregisterFns = [];

		vi.spyOn(process, "platform", "get").mockReturnValue("darwin");

		const piPkg = await import("@earendil-works/pi-coding-agent");
		vi.mocked(piPkg.getAgentDir).mockReturnValue("/tmp/progress-widget-mouse-agent");

		const cp = await import("node:child_process");
		spawnMock = vi.mocked(cp.spawn);
		spawnMock.mockImplementation((() => {
			const proc = createFakeProc();
			allProcs.push(proc);
			return proc;
		}) as any);

		webState.currentServer = null;
		const webMod = await import("../src/web/server.ts");
		startWebServerMock = vi.mocked(webMod.startWebServer) as any;
		// 忠实镜像真实 src/web/server.ts：`getGlobalServer()` 在 listen 期间返回
		// null，只有绑定完成后 handle 才被发布。因此这里用 setImmediate 模拟绑定
		// 这一 macrotask，且在 await 之后才写入 `webState.currentServer`。
		startWebServerMock.mockImplementation(async () => {
			if (webState.currentServer) return webState.currentServer;
			const handle = {
				port: PORT,
				url: BASE_URL,
				token: TOKEN,
				close: vi.fn(async () => {
					webState.currentServer = null;
				}),
			};
			// 绑定需要一个 macrotask：期间 getGlobalServer() 仍返回 null。
			await new Promise<void>((resolve) => setImmediate(resolve));
			webState.currentServer = handle;
			return handle;
		});

		const mod = await import("../src/index.ts");
		SubagentProgressManager = mod.SubagentProgressManager;
	});

	afterEach(() => {
		for (const fn of unregisterFns) fn();
		unregisterFns = [];
		webState.currentServer = null;
		vi.useRealTimers();
		vi.restoreAllMocks();
		vi.clearAllMocks();
	});

	/** 注册若干任务（每个之间推进 1000ms 以确定 startedAt 顺序），返回组件。 */
	function setup(agents: Array<{ id: string; name: string; recentTools?: string[] }>) {
		const manager = new SubagentProgressManager();
		const { ctx, notify } = createMockCtx();
		for (const agent of agents) {
			manager.register(ctx, agent.id, agent.name);
			if (agent.recentTools) manager.update(agent.id, { recentTools: agent.recentTools });
			vi.advanceTimersByTime(1000);
		}
		unregisterFns.push(() => {
			for (const agent of agents) manager.unregister(agent.id);
		});
		const component = getWidgetComponent(ctx.ui.setWidget, mockTheme);
		return { manager, ctx, notify, component };
	}

	it("should expose a handleMouse method on the widget component", () => {
		const { component } = setup([{ id: makeTaskId(1), name: "agent-a" }]);

		expect(typeof component.handleMouse).toBe("function");
	});

	describe("无 UI（hasUI:false）不注册 widget 组件", () => {
		it("should not register a widget factory when ctx.hasUI is false", () => {
			const setWidget = vi.fn();
			const notify = vi.fn();
			const ctxNoUI = { cwd: "/tmp", hasUI: false, mode: "tui" as const, ui: { setWidget, notify } };
			const manager = new SubagentProgressManager();
			const taskId = makeTaskId(91);

			manager.register(ctxNoUI, taskId, "agent-x");
			unregisterFns.push(() => manager.unregister(taskId));

			expect(setWidget, "hasUI:false 时 ctx.ui.setWidget 不应被调用").not.toHaveBeenCalled();
			const factoryRegistrations = setWidget.mock.calls.filter(
				([key, value]: [unknown, unknown]) => key === WIDGET_KEY && typeof value === "function",
			);
			expect(factoryRegistrations, "hasUI:false 时不应注册可实例化（handleMouse）的 widget 工厂").toHaveLength(0);
		});
	});

	describe("点击名字列（命中）", () => {
		it("should open 'open' at the task route when the name column of a task row is clicked", async () => {
			const taskId = makeTaskId(11);
			const { component } = setup([{ id: taskId, name: "agent-a" }]);
			const width = 200;
			const row = component.render(width)[1];
			const prefixWidth = visibleWidth(PREFIX_PREFIX) + visibleWidth(taskId) + visibleWidth(" ");
			expect(row.startsWith(`${PREFIX_PREFIX}${taskId}`), "任务行应以 ● + taskId 开头").toBe(true);

			const result = component.handleMouse?.(makeClick({ x: prefixWidth, y: 1, width }));

			expect(result, "名字列点击应被处理").toBeDefined();

			await flushAsync();

			expect(spawnMock, "名字列点击应调用平台打开器").toHaveBeenCalledTimes(1);
			expect(spawnMock.mock.calls[0][0]).toBe("open");
			expect(spawnMock.mock.calls[0][1][0]).toBe(`${BASE_URL}#/t/${taskId}`);
			expect(startWebServerMock, "命中应确保 web server 启动").toHaveBeenCalledTimes(1);
		});
	});

	describe("点击未命中（不消费 / 不启动 / 不 spawn）", () => {
		it("should ignore clicks that miss the name column without starting a server or spawning", async () => {
			const taskId = makeTaskId(21);
			const { component } = setup([{ id: taskId, name: "agent-a", recentTools: ["bash ls -la"] }]);
			const width = 240;
			const lines = component.render(width);
			const visibleCount = lines.length - 2; // 上/下边框各一行
			const row = lines[1];
			const prefixWidth = visibleWidth(PREFIX_PREFIX) + visibleWidth(taskId) + visibleWidth(" ");
			const phaseCol = displayColOf(row, "(running...)");
			// 推进过定时器，elapsed 实际为 MM:SS 形态（如 00:01）——按渲染结果定位，不写死。
			const elapsedText = row.match(/\d{2}:\d{2}/)?.[0] ?? "";
			const elapsedCol = displayColOf(row, elapsedText);
			const hintCol = displayColOf(row, "→");
			const bottomY = 1 + visibleCount;

			const cases: Array<[string, any]> = [
				["taskId 内 x=2", makeClick({ x: 2, y: 1, width })],
				["taskId 内 x=3", makeClick({ x: 3, y: 1, width })],
				["phase 列", makeClick({ x: phaseCol, y: 1, width })],
				["elapsed 列", makeClick({ x: elapsedCol, y: 1, width })],
				["tool hint 列", makeClick({ x: hintCol, y: 1, width })],
				["上边框 y=0", makeClick({ x: prefixWidth, y: 0, width })],
				["下边框行", makeClick({ x: prefixWidth, y: bottomY, width })],
				["越界 y", makeClick({ x: prefixWidth, y: bottomY + 5, width })],
			];

			for (const [label, event] of cases) {
				const result = component.handleMouse?.(event);
				expect(result, `未命中不得消费事件（${label}）`).toBeUndefined();
			}

			await flushAsync();

			expect(startWebServerMock, "未命中不得启动 web server").not.toHaveBeenCalled();
			expect(spawnMock, "未命中不得 spawn 打开器").not.toHaveBeenCalled();
		});
	});

	describe("名字列边界（命中/未命中）", () => {
		const NAME = "agent-a"; // nameColWidth = visibleWidth("agent-a") = 7（单任务）

		it("should hit when x === prefixWidth (first cell of the name column)", async () => {
			const taskId = makeTaskId(71);
			const { component } = setup([{ id: taskId, name: NAME }]);
			const width = 200;
			const { prefixWidth } = nameColumnBounds(taskId, NAME, width);

			const result = component.handleMouse?.(makeClick({ x: prefixWidth, y: 1, width }));

			expect(result, "名字列首格应命中").toBeDefined();

			await flushAsync();

			expect(spawnMock, "命中应 spawn 平台打开器").toHaveBeenCalledTimes(1);
			expect(spawnMock.mock.calls[0][1][0]).toBe(`${BASE_URL}#/t/${taskId}`);
		});

		it("should miss when x === prefixWidth - 1 (the separator space after the taskId)", async () => {
			const taskId = makeTaskId(72);
			const { component } = setup([{ id: taskId, name: NAME }]);
			const width = 200;
			const { prefixWidth } = nameColumnBounds(taskId, NAME, width);

			const result = component.handleMouse?.(makeClick({ x: prefixWidth - 1, y: 1, width }));

			expect(result, "taskId 后的分隔空格不得命中").toBeUndefined();

			await flushAsync();

			expect(startWebServerMock, "未命中不得启动 web server").not.toHaveBeenCalled();
			expect(spawnMock, "未命中不得 spawn 打开器").not.toHaveBeenCalled();
		});

		it("should miss when x === end (the separator space after the name column)", async () => {
			const taskId = makeTaskId(73);
			const { component } = setup([{ id: taskId, name: NAME }]);
			const width = 200;
			const { end } = nameColumnBounds(taskId, NAME, width);

			const result = component.handleMouse?.(makeClick({ x: end, y: 1, width }));

			expect(result, "名字列右边界之外（含端点）不得命中").toBeUndefined();

			await flushAsync();

			expect(startWebServerMock, "未命中不得启动 web server").not.toHaveBeenCalled();
			expect(spawnMock, "未命中不得 spawn 打开器").not.toHaveBeenCalled();
		});

		it("should hit when x === end - 1 (last cell of the name column)", async () => {
			const taskId = makeTaskId(74);
			const { component } = setup([{ id: taskId, name: NAME }]);
			const width = 200;
			const { end } = nameColumnBounds(taskId, NAME, width);

			const result = component.handleMouse?.(makeClick({ x: end - 1, y: 1, width }));

			expect(result, "名字列末格应命中").toBeDefined();

			await flushAsync();

			expect(spawnMock, "命中应 spawn 平台打开器").toHaveBeenCalledTimes(1);
			expect(spawnMock.mock.calls[0][1][0]).toBe(`${BASE_URL}#/t/${taskId}`);
		});
	});

	describe("非手势事件（不消费 / 不启动 / 不 spawn）", () => {
		const NAME = "agent-a";

		it("should ignore a press-type event at a name-column x", async () => {
			const taskId = makeTaskId(81);
			const { component } = setup([{ id: taskId, name: NAME }]);
			const width = 200;
			const { prefixWidth } = nameColumnBounds(taskId, NAME, width);
			// 同一 x 在左键 click 下会命中（见边界用例），此处 type 非 click。
			const result = component.handleMouse?.(
				makeClick({ type: "press", button: "left", x: prefixWidth, y: 1, width }),
			);

			expect(result, "press 事件不得被消费").toBeUndefined();

			await flushAsync();

			expect(startWebServerMock, "press 不得启动 web server").not.toHaveBeenCalled();
			expect(spawnMock, "press 不得 spawn 打开器").not.toHaveBeenCalled();
		});

		it("should ignore a right-button click at a name-column x", async () => {
			const taskId = makeTaskId(82);
			const { component } = setup([{ id: taskId, name: NAME }]);
			const width = 200;
			const { prefixWidth } = nameColumnBounds(taskId, NAME, width);

			const result = component.handleMouse?.(
				makeClick({ type: "click", button: "right", x: prefixWidth, y: 1, width }),
			);

			expect(result, "右键点击不得被消费").toBeUndefined();

			await flushAsync();

			expect(startWebServerMock, "右键点击不得启动 web server").not.toHaveBeenCalled();
			expect(spawnMock, "右键点击不得 spawn 打开器").not.toHaveBeenCalled();
		});
	});

	describe("连续点击与多行映射", () => {
		it("should reuse one web server across two clicks yet spawn two distinct task URLs", async () => {
			const t1 = makeTaskId(31);
			const t2 = makeTaskId(32);
			const { component } = setup([
				{ id: t1, name: "agent-a" },
				{ id: t2, name: "agent-b" },
			]);
			const width = 240;
			const prefixWidth = visibleWidth(PREFIX_PREFIX) + visibleWidth(t1) + visibleWidth(" ");

			// 连续两次点击（中间不 flush）：单例应拦下第二次 startWebServer。
			const r1 = component.handleMouse?.(makeClick({ x: prefixWidth, y: 1, width }));
			const r2 = component.handleMouse?.(makeClick({ x: prefixWidth, y: 2, width }));
			expect(r1, "第一次点击应被处理").toBeDefined();
			expect(r2, "第二次点击应被处理").toBeDefined();

			await flushAsync();

			expect(startWebServerMock, "第二次点击应复用进程级单例服务").toHaveBeenCalledTimes(1);
			expect(spawnMock, "两次命中应各打开一次").toHaveBeenCalledTimes(2);
			expect(spawnMock.mock.calls.map((c: any[]) => c[1][0])).toEqual([
				`${BASE_URL}#/t/${t1}`,
				`${BASE_URL}#/t/${t2}`,
			]);
		});

		it("should map the clicked row to the sorted task and open that task's route", async () => {
			const t1 = makeTaskId(41);
			const t2 = makeTaskId(42);
			const t3 = makeTaskId(43);
			const { component } = setup([
				{ id: t1, name: "alpha" },
				{ id: t2, name: "beta" },
				{ id: t3, name: "gamma" },
			]);
			const width = 240;
			const prefixWidth = visibleWidth(PREFIX_PREFIX) + visibleWidth(t1) + visibleWidth(" ");

			// y=1 → visible[0] = task1（上边框偏移 +1 已应用）；y=3 → visible[2] = task3。
			component.handleMouse?.(makeClick({ x: prefixWidth, y: 1, width }));
			await flushAsync();
			component.handleMouse?.(makeClick({ x: prefixWidth, y: 3, width }));
			await flushAsync();

			expect(spawnMock).toHaveBeenCalledTimes(2);
			expect(spawnMock.mock.calls[0][1][0]).toBe(`${BASE_URL}#/t/${t1}`);
			expect(spawnMock.mock.calls[1][1][0]).toBe(`${BASE_URL}#/t/${t3}`);
		});
	});

	describe("打开器失败回退（恰一次 warning 通知）", () => {
		it("should notify once with the exact fallback URL when the opener emits error then a non-zero exit", async () => {
			const taskId = makeTaskId(51);
			const { component, notify } = setup([{ id: taskId, name: "agent-a" }]);
			const width = 200;
			const prefixWidth = visibleWidth(PREFIX_PREFIX) + visibleWidth(taskId) + visibleWidth(" ");
			const expectedUrl = `${BASE_URL}#/t/${taskId}`;

			component.handleMouse?.(makeClick({ x: prefixWidth, y: 1, width }));
			await flushAsync();
			expect(allProcs.length, "打开器应已被 spawn").toBe(1);
			allProcs[0].emit("error", new Error("ENOENT"));
			allProcs[0].emit("exit", 1, null);
			await flushAsync();

			expect(notify, "error + 非零 exit 双触发只允许一条回退通知").toHaveBeenCalledTimes(1);
			expect(notify.mock.calls[0][0]).toBe(`Could not open the browser — open this URL manually: ${expectedUrl}`);
			expect(notify.mock.calls[0][1]).toBe("warning");
		});

		it("should notify once with the exact fallback URL when the opener exits non-zero without an error event", async () => {
			const taskId = makeTaskId(52);
			const { component, notify } = setup([{ id: taskId, name: "agent-a" }]);
			const width = 200;
			const prefixWidth = visibleWidth(PREFIX_PREFIX) + visibleWidth(taskId) + visibleWidth(" ");
			const expectedUrl = `${BASE_URL}#/t/${taskId}`;

			component.handleMouse?.(makeClick({ x: prefixWidth, y: 1, width }));
			await flushAsync();
			expect(allProcs.length, "打开器应已被 spawn").toBe(1);
			allProcs[0].emit("exit", 1, null);
			await flushAsync();

			expect(notify).toHaveBeenCalledTimes(1);
			expect(notify.mock.calls[0][0]).toBe(`Could not open the browser — open this URL manually: ${expectedUrl}`);
			expect(notify.mock.calls[0][1]).toBe("warning");
		});

		it("should notify once with the exact fallback URL when spawn throws synchronously", async () => {
			const taskId = makeTaskId(53);
			const { component, notify } = setup([{ id: taskId, name: "agent-a" }]);
			const width = 200;
			const prefixWidth = visibleWidth(PREFIX_PREFIX) + visibleWidth(taskId) + visibleWidth(" ");
			const expectedUrl = `${BASE_URL}#/t/${taskId}`;
			spawnMock.mockImplementation((() => {
				throw new Error("spawn failed");
			}) as any);

			component.handleMouse?.(makeClick({ x: prefixWidth, y: 1, width }));
			await flushAsync();

			expect(notify).toHaveBeenCalledTimes(1);
			expect(notify.mock.calls[0][0]).toBe(`Could not open the browser — open this URL manually: ${expectedUrl}`);
			expect(notify.mock.calls[0][1]).toBe("warning");
		});

		it("should notify once with the server-start warning and not spawn when the server fails to start", async () => {
			const taskId = makeTaskId(54);
			const { component, notify } = setup([{ id: taskId, name: "agent-a" }]);
			const width = 200;
			const { prefixWidth } = nameColumnBounds(taskId, "agent-a", width);
			// startWebServer rejects（绑定失败）——命中先确保 server，再打开 URL。
			startWebServerMock.mockImplementationOnce(() => Promise.reject(new Error("bind failed")));

			const result = component.handleMouse?.(makeClick({ x: prefixWidth, y: 1, width }));
			expect(result, "命中仍应同步消费事件").toBeDefined();

			await flushAsync();

			expect(notify, "server 启动失败应恰发一条 warning").toHaveBeenCalledTimes(1);
			expect(notify.mock.calls[0][0]).toBe("Could not start the subagent web view.");
			expect(notify.mock.calls[0][1]).toBe("warning");
			expect(spawnMock, "server 未启动不得 spawn 打开器").not.toHaveBeenCalled();
		});
	});

	describe("窄宽度截断", () => {
		it("should only hit the visible portion of the name column when the row is truncated", async () => {
			const taskId = makeTaskId(61);
			const longName = "a-very-very-long-agent-name-exceeding-limit";
			const { component } = setup([{ id: taskId, name: longName }]);
			const prefixWidth = visibleWidth(PREFIX_PREFIX) + visibleWidth(taskId) + visibleWidth(" ");
			const width = prefixWidth + 5; // 可见名字列只剩 5 列（nameColWidth 上限 30）
			const fullNameColWidth = Math.min(30, visibleWidth(longName));
			// 该 x 落在完整名字列内部（若没有 event.width 截断仍会命中），
			// 但已 >= event.width（渲染截断后的可见终点）——用于验证 clamp。
			const clampedX = prefixWidth + 6;
			expect(clampedX, "该 x 应在完整名字列内").toBeLessThan(prefixWidth + fullNameColWidth);
			expect(clampedX, "该 x 应 >= event.width（被截断）").toBeGreaterThanOrEqual(width);

			// 可见部分内 → 命中
			const rHit = component.handleMouse?.(makeClick({ x: prefixWidth + 4, y: 1, width }));
			expect(rHit, "名字列可见部分内的点击应被处理").toBeDefined();
			await flushAsync();
			expect(spawnMock).toHaveBeenCalledTimes(1);
			expect(spawnMock.mock.calls[0][1][0]).toBe(`${BASE_URL}#/t/${taskId}`);

			// 超出 event.width → 未命中
			spawnMock.mockClear();
			const rMiss = component.handleMouse?.(makeClick({ x: clampedX, y: 1, width }));
			expect(rMiss, "超出渲染宽度的点击不得被处理").toBeUndefined();
			await flushAsync();
			expect(startWebServerMock, "未命中不得启动新 server").toHaveBeenCalledTimes(1); // 仅前一次命中
			expect(spawnMock, "超出渲染宽度的点击不得 spawn").not.toHaveBeenCalled();
		});
	});
});
