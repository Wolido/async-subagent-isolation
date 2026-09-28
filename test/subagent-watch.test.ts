/**
 * Contract + regression test suite for /subagent-watch (GitHub issue #1: TUI 中
 * 实时观察运行中子 agent 的输出). 当前 30 个用例全部通过；其中若干用例是
 * 随真实缺陷修复与体验增强追加的回归锁（见「缺陷回归」「增强」用例块）。
 *
 * 行为契约（验收文案已锁定，以下测试逐条编码，文案逐字断言）：
 *  1. 注册命令 subagent-watch，description 逐字：
 *     "Watch a running background subagent task live (usage: /subagent-watch <taskId>)"
 *  2. 只服务运行中任务：taskId 非当前在飞任务（已结束或不存在）→ 不打开查看器，
 *     warning 通知逐字：
 *     "Task not running — /subagent-watch shows running tasks only: ${taskId}. Use /subagent-result for finished tasks."
 *  3. 带参（TUI）→ 全屏 overlay 实时查看器，挂载参数与 /subagent-result 一致：
 *     { overlay: true, overlayOptions: { width: "100%", maxHeight: "100%", anchor: "top-left", margin: 0 } }
 *     标题逐字包含 "Subagent Watch: ${taskId}"；初始内容含该任务已有助手文本。
 *  4. 每 1000ms 定时刷新（测试用 fake timers 推进，不依赖真实等待）：
 *     message_end 新文本 / 工具调用与结果（工具名）/ 无 message_end 的
 *     message_update+text_delta 流式增量，均须在下一个刷新周期内出现在渲染中。
 *  5. 无参（TUI）→ 交互选择列表只含运行中任务；Enter 打开所选任务的查看器；
 *     无运行中任务 → warning 逐字："No running subagent tasks to watch."
 *  6. 观看中任务结束 → 停止刷新（清定时器），内容追加一行，逐字：
 *     "Task finished — live updates stopped. Final result: /subagent-result ${taskId}"
 *     之后继续推进定时器不得报错、不得重复追加或继续更新；查看器保持打开。
 *  7. Enter / Esc / q 关闭查看器（与 /subagent-result 相同按键习惯：
 *     ↑↓/jk 滚动、Space/b 翻页、g/G 首尾同时覆盖）；关闭后推进定时器不得
 *     产生新的渲染/读取副作用。
 *  8. 非 TUI（mode "json"/print）→ 不打开查看器，console.log 一行，逐字：
 *     "[subagent-watch] taskId: ${taskId} — live view requires TUI mode."
 *  9. 既有全量测试保持通过（由全量 npx vitest run 验证）。
 *
 * 数据来源的接口选型（测试驱动的「新输出」注入缝）：
 * 契约第 4 条点名 message_end / message_update / text_delta —— 这些是子进程
 * stdout JSON 事件类型（见 src/index.ts runSingleAgent 的 processLineRaw）。
 * pi 的会话 JSONL 只落盘最终 message（不落流式增量），所以任何能满足契约 4c
 *（流式增量可见）的实现都必须消费子进程 stdout 事件流。因此本套件沿既有
 * 做法（mock spawn + 喂 stdout JSON 事件）驱动「运行中任务产生的新输出」。
 *
 * 模块隔离：vi.resetModules() + 动态 import（沿用 interactive-pickers.test.ts
 * 的成熟模式），保证 taskRegistry 及实现未来新增的模块级实时缓冲都天然为空。
 */

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AsyncSubagentTask } from "../src/index.ts";

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

// ---------------------------------------------------------------------------
// 锁定文案（逐字，来自验收契约）
// ---------------------------------------------------------------------------

const COMMAND_NAME = "subagent-watch";
const COMMAND_DESCRIPTION =
	"Watch a running background subagent task live (usage: /subagent-watch <taskId>)";
const WARN_NOT_RUNNING = (taskId: string) =>
	`Task not running — /subagent-watch shows running tasks only: ${taskId}. Use /subagent-result for finished tasks.`;
const WARN_NONE_RUNNING = "No running subagent tasks to watch.";
const FINISH_LINE = (taskId: string) =>
	`Task finished — live updates stopped. Final result: /subagent-result ${taskId}`;
const NON_TUI_LOG = (taskId: string) =>
	`[subagent-watch] taskId: ${taskId} — live view requires TUI mode.`;
const TITLE = (taskId: string) => `Subagent Watch: ${taskId}`;
const OVERLAY_OPTIONS = {
	overlay: true,
	overlayOptions: { width: "100%", maxHeight: "100%", anchor: "top-left", margin: 0 },
};

const ENV_KEYS = [
	"PI_SUBAGENT_DEPTH",
	"PI_SUBAGENT_HARD_TIMEOUT_MS",
	"PI_SUBAGENT_ACTIVITY_TIMEOUT_MS",
	"PI_CURRENT_AGENT_NAME",
	"PI_CAN_DELEGATE",
];

/** 刷新周期（契约第 4 条：每 1000ms 刷新一次）。 */
const REFRESH_MS = 1000;

const KEY_ENTER = "\r";
const KEY_ESC = "\x1b";
const KEY_Q = "q";

type ExecuteFn = (
	toolCallId: string,
	params: Record<string, unknown>,
	signal: AbortSignal | undefined,
	onUpdate: unknown,
	ctx: unknown,
) => Promise<any>;

/** 干净模块实例（beforeEach 中 vi.resetModules() + 动态 import 后赋值）。 */
let extension: (typeof import("../src/index.ts"))["default"];
let taskRegistry: Map<string, AsyncSubagentTask>;

// ---------------------------------------------------------------------------
// Helpers（沿用 interactive-pickers.test.ts / async-mode.test.ts 的既有模式）
// ---------------------------------------------------------------------------

/** Create a fake ChildProcess whose kill() is a no-op. */
function createControllableProc() {
	const proc = new EventEmitter() as any;
	proc.stdout = new EventEmitter();
	proc.stderr = new EventEmitter();
	proc.kill = vi.fn(() => true);
	proc.exitCode = null;
	proc.signalCode = null;
	return proc;
}

/** Manually end the process so the runSingleAgent promise resolves (success). */
function endProcess(proc: any, exitCode = 0, signal: string | null = null) {
	proc.stdout.emit("end");
	proc.emit("exit", signal ? null : exitCode, signal);
	proc.emit("close", signal ? null : exitCode, signal);
}

/** Build a mock pi object that captures all registration calls. */
function createMockPi() {
	const toolDefs: any[] = [];
	const commandDefs: Map<string, any> = new Map();
	const eventHandlers: Map<string, Function[]> = new Map();
	return {
		registerTool: vi.fn((tool: any) => {
			toolDefs.push(tool);
		}),
		registerCommand: vi.fn((name: string, options: any) => {
			commandDefs.set(name, options);
		}),
		registerMessageRenderer: vi.fn(),
		on: vi.fn((event: string, handler: Function) => {
			if (!eventHandlers.has(event)) eventHandlers.set(event, []);
			eventHandlers.get(event)!.push(handler);
		}),
		sendMessage: vi.fn(),
		_toolDefs: toolDefs,
		_commandDefs: commandDefs,
		_eventHandlers: eventHandlers,
	};
}

/** Mock ctx for dispatching (TUI mode). */
function createMockTuiCtx(cwd: string) {
	return {
		cwd,
		hasUI: true,
		mode: "tui" as const,
		ui: {
			setWidget: vi.fn(),
			confirm: vi.fn().mockResolvedValue(true),
		},
	};
}

interface CapturedComponent {
	component: any;
	done: ReturnType<typeof vi.fn>;
	getRendered: (width?: number) => string;
	handleInput: (data: string) => void;
}

/**
 * Mock a TUI command ctx whose ui.custom() captures the created component and
 * returns a promise resolving when the component calls done() (mirrors real pi:
 * the overlay lives until the component finishes). captured[0] = 选择列表或
 * 查看器；picker 选中后 captured[1] = 查看器。
 */
function createCustomCtx() {
	const notifyMock = vi.fn();
	const captured: CapturedComponent[] = [];
	const customMock = vi.fn(
		(cb: any) =>
			new Promise((resolve) => {
				const theme = { fg: (_c: string, s: string) => s, bold: (s: string) => s };
				const tui = { requestRender: vi.fn() };
				const done = vi.fn((value?: unknown) => resolve(value));
				const component = cb(tui, theme, null, done);
				captured.push({
					component,
					done,
					getRendered: (width = 80) => component.render(width).join("\n"),
					handleInput: (data: string) => component.handleInput(data),
				});
			}),
	);
	const ctx = { hasUI: true, mode: "tui" as const, ui: { notify: notifyMock, custom: customMock } };
	return { ctx, notifyMock, customMock, captured };
}

/** Wait until ui.custom has been called n times (yields real event loop for async handler steps). */
async function waitForCustomCalls(captured: unknown[], n: number): Promise<void> {
	for (let i = 0; i < 100 && captured.length < n; i++) {
		vi.useRealTimers();
		await new Promise((r) => setTimeout(r, 2));
		vi.useFakeTimers();
	}
}

/** Fixed-size async flush for steps where no new custom call is expected. */
async function flushAsync(rounds = 10): Promise<void> {
	for (let i = 0; i < rounds; i++) {
		vi.useRealTimers();
		await new Promise((r) => setTimeout(r, 1));
		vi.useFakeTimers();
	}
}

/** Race execute() against a timeout to detect immediate returns (fake-timer safe). */
async function raceWithTimeout<T>(
	promise: Promise<T>,
	timeoutMs = 200,
): Promise<{ result: T | null; timedOut: boolean }> {
	vi.useRealTimers();
	try {
		const timeout = new Promise<null>((resolve) => setTimeout(() => resolve(null), timeoutMs));
		const result = await Promise.race([promise, timeout]);
		return { result, timedOut: result === null };
	} finally {
		vi.useFakeTimers();
	}
}

/** UUID v7-shaped taskId（sessionId 校验要求），每个用例使用不同 n。 */
function makeTaskId(n: number): string {
	return `019ffdd3-3eb5-733d-b481-a53e5292c${String(n).padStart(3, "0")}`;
}

/** 向被 mock 的子进程注入一条 stdout JSON 事件（同步进入 processLineRaw）。 */
function feedEvent(proc: any, event: object): void {
	proc.stdout.emit("data", Buffer.from(JSON.stringify(event) + "\n"));
}

/** 子进程 stdout JSON：一条已完成的 assistant 消息（message_end）。 */
function assistantEndEvent(text: string): object {
	return {
		type: "message_end",
		message: {
			role: "assistant",
			content: [{ type: "text", text }],
			stopReason: "end_turn",
			usage: { input: 10, output: 5, totalTokens: 15 },
		},
	};
}

/** 子进程 stdout JSON：流式增量（message_update / text_delta，无 message_end）。 */
function textDeltaEvent(delta: string): object {
	return { type: "message_update", assistantMessageEvent: { type: "text_delta", delta } };
}

/** 子进程 stdout JSON：工具调用开始（携带工具名）。 */
function toolStartEvent(toolName: string): object {
	return { type: "tool_execution_start", toolName };
}

/** 子进程 stdout JSON：工具调用结束（携带 toolResult 消息）。 */
function toolEndEvent(toolName: string, resultText: string): object {
	return {
		type: "tool_execution_end",
		message: { role: "toolResult", toolName, content: [{ type: "text", text: resultText }] },
	};
}

const countOccurrences = (haystack: string, needle: string) => haystack.split(needle).length - 1;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("/subagent-watch 命令（issue #1 实时观察运行中子 agent）", () => {
	let tmpBase: string;
	let agentDir: string;
	let defaultCwd: string;
	let savedEnv: Record<string, string | undefined>;
	let allProcs: ReturnType<typeof createControllableProc>[];
	let watchCommand: any;
	let executeToolRef: ExecuteFn;
	let dispatchCtxRef: unknown;

	beforeEach(async () => {
		vi.useFakeTimers();
		// 模块级状态隔离：干净模块实例 → taskRegistry（及实现未来的实时缓冲）为空
		vi.resetModules();
		const mod = await import("../src/index.ts");
		extension = mod.default;
		taskRegistry = mod.taskRegistry;

		tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "subagent-watch-test-"));
		agentDir = path.join(tmpBase, "agent-dir");
		defaultCwd = path.join(tmpBase, "default-cwd");
		fs.mkdirSync(path.join(defaultCwd, ".pi", "agents"), { recursive: true });
		fs.mkdirSync(agentDir, { recursive: true });
		fs.writeFileSync(
			path.join(defaultCwd, ".pi", "agents", "tester.md"),
			`---\nname: tester\ndescription: Test agent\n---\n`,
			"utf-8",
		);

		// resetModules 后 vi.mock 工厂重跑，必须重新取引用再配置
		const piPkg = await import("@earendil-works/pi-coding-agent");
		vi.mocked(piPkg.getAgentDir).mockReturnValue(agentDir);

		allProcs = [];
		const cp = await import("node:child_process");
		vi.mocked(cp.spawn).mockImplementation((() => {
			const proc = createControllableProc();
			allProcs.push(proc);
			return proc;
		}) as any);

		savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
		process.env.PI_SUBAGENT_DEPTH = "0";
		delete process.env.PI_CURRENT_AGENT_NAME;
		delete process.env.PI_CAN_DELEGATE;
		delete process.env.PI_SUBAGENT_HARD_TIMEOUT_MS;
		delete process.env.PI_SUBAGENT_ACTIVITY_TIMEOUT_MS;

		// 加载扩展并取出 subagent-watch 命令定义
		const pi = createMockPi();
		extension(pi as any);
		watchCommand = pi._commandDefs.get(COMMAND_NAME);
		const toolsByName = new Map(pi._toolDefs.map((t: any) => [t.name, t] as const));
		executeToolRef = toolsByName.get("subagent")?.execute as ExecuteFn;
		dispatchCtxRef = createMockTuiCtx(defaultCwd);
	});

	afterEach(() => {
		for (const key of ENV_KEYS) {
			if (savedEnv[key] === undefined) delete process.env[key];
			else process.env[key] = savedEnv[key];
		}
		taskRegistry.clear();
		fs.rmSync(tmpBase, { recursive: true, force: true });
		vi.restoreAllMocks();
		vi.clearAllMocks();
		vi.useRealTimers();
	});

	/** Insert a task directly into the registry with the given status. */
	function insertTask(taskId: string, status: AsyncSubagentTask["status"]): AsyncSubagentTask {
		const record: AsyncSubagentTask = {
			taskId,
			agentName: "tester",
			task: `task for ${taskId}`,
			startedAt: Date.now(),
			abortController: new AbortController(),
			status,
		};
		taskRegistry.set(taskId, record);
		return record;
	}

	/** Dispatch a task via the subagent tool and leave it running. */
	async function dispatchRunningTask(n: number): Promise<string> {
		const taskId = makeTaskId(n);
		const executePromise = executeToolRef(
			`call-${taskId}`,
			{ agent: "tester", task: `task ${n}`, sessionId: taskId },
			undefined,
			undefined,
			dispatchCtxRef,
		);
		await raceWithTimeout(executePromise, 200);
		expect(taskRegistry.get(taskId)?.status, `task ${taskId} should be running after dispatch`).toBe("running");
		return taskId;
	}

	function lastProc(): any {
		return allProcs[allProcs.length - 1];
	}

	// ================================================================
	// 规格 1 — 命令注册
	// ================================================================
	describe("规格 1 — 命令注册", () => {
		it("should register the subagent-watch command with the exact locked description", () => {
			expect(watchCommand, "功能缺失：未注册 subagent-watch 命令").toBeDefined();
			expect(watchCommand.description).toBe(COMMAND_DESCRIPTION);
		});
	});

	// ================================================================
	// 规格 2 — 只服务运行中任务（核心约束）
	// ================================================================
	describe("规格 2 — 只服务运行中任务", () => {
		it("should warn with the exact locked message and not open any viewer when the taskId does not exist", async () => {
			expect(watchCommand, "功能缺失：未注册 subagent-watch 命令").toBeDefined();
			const taskId = makeTaskId(101);
			const { ctx, notifyMock, customMock } = createCustomCtx();

			await watchCommand.handler(taskId, ctx);

			expect(customMock, "非运行中任务不得打开查看器").not.toHaveBeenCalled();
			expect(notifyMock).toHaveBeenCalledTimes(1);
			expect(notifyMock).toHaveBeenCalledWith(WARN_NOT_RUNNING(taskId), "warning");
		});

		it("should warn with the exact locked message when the taskId is in the registry but not running (已结束/已取消)", async () => {
			expect(watchCommand, "功能缺失：未注册 subagent-watch 命令").toBeDefined();
			const taskId = makeTaskId(102);
			// 在册但非 running（取消后尚未回收的结束态）→ 同样不得打开查看器
			insertTask(taskId, "cancelled");
			const { ctx, notifyMock, customMock } = createCustomCtx();

			await watchCommand.handler(taskId, ctx);

			expect(customMock, "已结束任务不得打开查看器").not.toHaveBeenCalled();
			expect(notifyMock).toHaveBeenCalledTimes(1);
			expect(notifyMock).toHaveBeenCalledWith(WARN_NOT_RUNNING(taskId), "warning");
		});
	});

	// ================================================================
	// 规格 3 — 带参打开（overlay 挂载 + 标题 + 初始内容）
	// ================================================================
	describe("规格 3 — 带参打开", () => {
		it("should open the viewer as a fullscreen overlay with the exact same mount options as /subagent-result", async () => {
			expect(watchCommand, "功能缺失：未注册 subagent-watch 命令").toBeDefined();
			const taskId = makeTaskId(201);
			insertTask(taskId, "running");
			const { ctx, customMock, captured } = createCustomCtx();

			const handlerPromise = watchCommand.handler(taskId, ctx);
			await waitForCustomCalls(captured, 1);

			expect(customMock).toHaveBeenCalledTimes(1);
			expect(customMock.mock.calls[0][1]).toEqual(OVERLAY_OPTIONS);

			captured[0].handleInput(KEY_ESC);
			await handlerPromise;
		});

		it("should render a title containing the exact locked text 'Subagent Watch: <taskId>'", async () => {
			expect(watchCommand, "功能缺失：未注册 subagent-watch 命令").toBeDefined();
			const taskId = makeTaskId(202);
			insertTask(taskId, "running");
			const { ctx, captured } = createCustomCtx();

			const handlerPromise = watchCommand.handler(taskId, ctx);
			await waitForCustomCalls(captured, 1);

			expect(captured[0].getRendered()).toContain(TITLE(taskId));

			captured[0].handleInput(KEY_ESC);
			await handlerPromise;
		});

		it("should include the assistant text the task already produced in the initial render (before any timer tick)", async () => {
			expect(watchCommand, "功能缺失：未注册 subagent-watch 命令").toBeDefined();
			// Arrange: 派发任务并先产生一段输出，再打开查看器
			const taskId = await dispatchRunningTask(203);
			feedEvent(lastProc(), assistantEndEvent("已经产出的助手文本 ALPHA-203"));
			const { ctx, captured } = createCustomCtx();

			// Act: 打开查看器（未推进任何定时器）
			const handlerPromise = watchCommand.handler(taskId, ctx);
			await waitForCustomCalls(captured, 1);

			// Assert: 初始渲染即包含已有助手文本
			expect(captured[0].getRendered()).toContain("已经产出的助手文本 ALPHA-203");

			captured[0].handleInput(KEY_ESC);
			await handlerPromise;
		});
	});

	// ================================================================
	// 规格 4 — 每 1000ms 实时刷新（fake timers 推进，无真实等待）
	// ================================================================
	describe("规格 4 — 实时刷新（1s 刷新周期）", () => {
		it("should render a new assistant message (message_end) within one refresh tick", async () => {
			expect(watchCommand, "功能缺失：未注册 subagent-watch 命令").toBeDefined();
			// Arrange
			const taskId = await dispatchRunningTask(301);
			feedEvent(lastProc(), assistantEndEvent("刷新前的文本 AAA"));
			const { ctx, captured } = createCustomCtx();
			const handlerPromise = watchCommand.handler(taskId, ctx);
			await waitForCustomCalls(captured, 1);
			expect(captured[0].getRendered()).toContain("刷新前的文本 AAA");

			// Act: 运行中产生新输出，推进一个刷新周期
			feedEvent(lastProc(), assistantEndEvent("新刷新周期出现的文本 BBB-301"));
			await vi.advanceTimersByTimeAsync(REFRESH_MS);

			// Assert: 新文本出现在渲染中
			expect(captured[0].getRendered()).toContain("新刷新周期出现的文本 BBB-301");

			captured[0].handleInput(KEY_ESC);
			await handlerPromise;
		});

		it("should render new tool call / tool result content (tool name) within one refresh tick", async () => {
			expect(watchCommand, "功能缺失：未注册 subagent-watch 命令").toBeDefined();
			// Arrange
			const taskId = await dispatchRunningTask(302);
			const { ctx, captured } = createCustomCtx();
			const handlerPromise = watchCommand.handler(taskId, ctx);
			await waitForCustomCalls(captured, 1);

			// Act: 运行中产生工具调用与工具结果事件，推进一个刷新周期
			feedEvent(lastProc(), toolStartEvent("read_file"));
			feedEvent(lastProc(), toolEndEvent("read_file", "工具结果内容 BBB-302"));
			await vi.advanceTimersByTimeAsync(REFRESH_MS);

			// Assert: 渲染包含工具名等新内容
			const rendered = captured[0].getRendered();
			expect(rendered).toContain("read_file");
			expect(rendered).toContain("工具结果内容 BBB-302");

			captured[0].handleInput(KEY_ESC);
			await handlerPromise;
		});

		it("should render streaming text (message_update / text_delta without message_end) within one refresh tick", async () => {
			expect(watchCommand, "功能缺失：未注册 subagent-watch 命令").toBeDefined();
			// Arrange
			const taskId = await dispatchRunningTask(303);
			const { ctx, captured } = createCustomCtx();
			const handlerPromise = watchCommand.handler(taskId, ctx);
			await waitForCustomCalls(captured, 1);

			// Act: 只有流式增量、没有 message_end（体现「正在生成」）
			feedEvent(lastProc(), textDeltaEvent("正在生成的流式增量 BBB-303"));
			await vi.advanceTimersByTimeAsync(REFRESH_MS);

			// Assert: 渲染包含该增量文本
			expect(captured[0].getRendered()).toContain("正在生成的流式增量 BBB-303");

			captured[0].handleInput(KEY_ESC);
			await handlerPromise;
		});
	});

	// ================================================================
	// 规格 5 — 无参 picker（只含运行中任务）
	// ================================================================
	describe("规格 5 — 无参 picker", () => {
		it("should open a picker listing only running tasks and open the watch viewer for the selected task on Enter", async () => {
			expect(watchCommand, "功能缺失：未注册 subagent-watch 命令").toBeDefined();
			// Arrange: 2 个运行中 + 1 个已取消（在册但非 running）
			const runningA = makeTaskId(401);
			const runningB = makeTaskId(402);
			const finishedC = makeTaskId(403);
			insertTask(runningA, "running");
			insertTask(runningB, "running");
			insertTask(finishedC, "cancelled");
			const { ctx, notifyMock, captured } = createCustomCtx();

			// Act: 无参数调用 → 弹出选择列表
			const handlerPromise = watchCommand.handler("", ctx);
			await waitForCustomCalls(captured, 1);

			// Assert: 列表只包含运行中任务
			expect(captured, "无参（TUI）应弹出交互选择列表").toHaveLength(1);
			const pickerRendered = captured[0].getRendered();
			expect(pickerRendered).toContain(runningA);
			expect(pickerRendered).toContain(runningB);
			expect(pickerRendered, "已结束/非运行中任务不得出现在列表中").not.toContain(finishedC);
			expect(notifyMock).not.toHaveBeenCalled();

			// Act: Enter 打开所选任务的实时查看器
			captured[0].handleInput(KEY_ENTER);
			await waitForCustomCalls(captured, 2);

			// Assert: 查看器标题为所选任务（实现自定列表顺序：A、B 之一即可）
			expect(captured, "Enter 应打开所选任务的实时查看器").toHaveLength(2);
			const viewerRendered = captured[1].getRendered();
			expect(viewerRendered).toMatch(/Subagent Watch: (019ffdd3-3eb5-733d-b481-a53e5292c401|019ffdd3-3eb5-733d-b481-a53e5292c402)/);
			expect(viewerRendered).not.toContain(finishedC);

			captured[1].handleInput(KEY_ESC);
			await handlerPromise;
		});

		it("should dismiss without opening a viewer and without any notification when Esc is pressed in the picker", async () => {
			expect(watchCommand, "功能缺失：未注册 subagent-watch 命令").toBeDefined();
			insertTask(makeTaskId(404), "running");
			const { ctx, notifyMock, captured } = createCustomCtx();

			const handlerPromise = watchCommand.handler("", ctx);
			await waitForCustomCalls(captured, 1);
			expect(captured).toHaveLength(1);
			captured[0].handleInput(KEY_ESC);
			await handlerPromise;
			await flushAsync();

			expect(captured, "Esc 后不应打开查看器").toHaveLength(1);
			expect(notifyMock, "Esc 后不应有任何通知").not.toHaveBeenCalled();
		});

		it("should dismiss without opening a viewer and without any notification when q is pressed in the picker", async () => {
			expect(watchCommand, "功能缺失：未注册 subagent-watch 命令").toBeDefined();
			insertTask(makeTaskId(405), "running");
			const { ctx, notifyMock, captured } = createCustomCtx();

			const handlerPromise = watchCommand.handler("", ctx);
			await waitForCustomCalls(captured, 1);
			expect(captured).toHaveLength(1);
			captured[0].handleInput(KEY_Q);
			await handlerPromise;
			await flushAsync();

			expect(captured[0].done, "q 应关闭选择列表（调用 done）").toHaveBeenCalled();
			expect(captured, "q 后不应打开查看器").toHaveLength(1);
			expect(notifyMock, "q 后不应有任何通知").not.toHaveBeenCalled();
		});

		it("should warn with the exact locked message 'No running subagent tasks to watch.' when nothing is running", async () => {
			expect(watchCommand, "功能缺失：未注册 subagent-watch 命令").toBeDefined();
			// Arrange: 只有已结束任务，没有运行中任务
			insertTask(makeTaskId(406), "cancelled");
			const { ctx, notifyMock, customMock } = createCustomCtx();

			await watchCommand.handler("", ctx);

			expect(customMock, "无运行中任务时不应弹选择列表").not.toHaveBeenCalled();
			expect(notifyMock).toHaveBeenCalledTimes(1);
			expect(notifyMock).toHaveBeenCalledWith(WARN_NONE_RUNNING, "warning");
		});
	});

	// ================================================================
	// 规格 6 — 观看过程中任务结束
	// ================================================================
	describe("规格 6 — 观看过程中任务结束", () => {
		it("should append the exact locked finish line once, stop refreshing, and stay stable on further timer ticks", async () => {
			expect(watchCommand, "功能缺失：未注册 subagent-watch 命令").toBeDefined();
			// Arrange: 任务运行中并已产生输出，查看器已打开
			const taskId = await dispatchRunningTask(501);
			feedEvent(lastProc(), assistantEndEvent("任务结束前的输出 AAA-501"));
			const { ctx, captured } = createCustomCtx();
			const handlerPromise = watchCommand.handler(taskId, ctx);
			await waitForCustomCalls(captured, 1);
			expect(captured[0].getRendered()).toContain("任务结束前的输出 AAA-501");
			expect(captured[0].getRendered()).not.toContain(FINISH_LINE(taskId));

			// Act: 任务结束（子进程退出 → completeAsyncTask 将任务移出注册表）
			endProcess(lastProc(), 0);
			await vi.advanceTimersByTimeAsync(REFRESH_MS);

			// Assert: 内容追加一行锁定文案，恰好一次
			const afterFinish = captured[0].getRendered();
			expect(afterFinish).toContain(FINISH_LINE(taskId));
			expect(countOccurrences(afterFinish, FINISH_LINE(taskId)), "结束提示不得重复追加").toBe(1);
			expect(captured[0].done, "查看器保持打开（不调用 done）").not.toHaveBeenCalled();

			// Act: 继续推进多个刷新周期
			await vi.advanceTimersByTimeAsync(REFRESH_MS * 3);

			// Assert: 不得报错、不得重复追加或继续更新（渲染保持稳定）
			const laterRender = captured[0].getRendered();
			expect(laterRender).toBe(afterFinish);
			expect(countOccurrences(laterRender, FINISH_LINE(taskId))).toBe(1);

			captured[0].handleInput(KEY_ESC);
			await handlerPromise;
		});
	});

	// ================================================================
	// 规格 7 — 关闭（Enter / Esc / q + /subagent-result 按键习惯）
	// ================================================================
	describe("规格 7 — 关闭与按键习惯", () => {
		/** 打开一个运行中任务的查看器（共用 Arrange 步骤）。 */
		async function openViewer(n: number) {
			const taskId = await dispatchRunningTask(n);
			feedEvent(lastProc(), assistantEndEvent(`观看内容 AAA-${n}`));
			const { ctx, captured } = createCustomCtx();
			const handlerPromise = watchCommand.handler(taskId, ctx);
			await waitForCustomCalls(captured, 1);
			return { taskId, ctx, captured, handlerPromise };
		}

		it("should close the viewer when Enter is pressed", async () => {
			expect(watchCommand, "功能缺失：未注册 subagent-watch 命令").toBeDefined();
			const { captured, handlerPromise } = await openViewer(701);

			captured[0].handleInput(KEY_ENTER);

			expect(captured[0].done, "Enter 应关闭查看器（调用 done）").toHaveBeenCalled();
			await handlerPromise;
		});

		it("should close the viewer when Esc is pressed", async () => {
			expect(watchCommand, "功能缺失：未注册 subagent-watch 命令").toBeDefined();
			const { captured, handlerPromise } = await openViewer(702);

			captured[0].handleInput(KEY_ESC);

			expect(captured[0].done, "Esc 应关闭查看器（调用 done）").toHaveBeenCalled();
			await handlerPromise;
		});

		it("should close the viewer when q is pressed", async () => {
			expect(watchCommand, "功能缺失：未注册 subagent-watch 命令").toBeDefined();
			const { captured, handlerPromise } = await openViewer(703);

			captured[0].handleInput(KEY_Q);

			expect(captured[0].done, "q 应关闭查看器（调用 done）").toHaveBeenCalled();
			await handlerPromise;
		});

		it("should produce no timer side effects after close (no new render/read when the timer advances)", async () => {
			expect(watchCommand, "功能缺失：未注册 subagent-watch 命令").toBeDefined();
			const { captured, handlerPromise } = await openViewer(704);
			captured[0].handleInput(KEY_ENTER);
			expect(captured[0].done).toHaveBeenCalled();
			await handlerPromise;
			const renderAtClose = captured[0].getRendered();

			// Act: 关闭后继续产生新输出并推进多个刷新周期
			feedEvent(lastProc(), assistantEndEvent("关闭之后才出现的新文本 BBB-704"));
			await vi.advanceTimersByTimeAsync(REFRESH_MS * 3);

			// Assert: 无新渲染副作用（无新内容、无异常），渲染保持不变
			expect(captured[0].getRendered()).toBe(renderAtClose);
			expect(captured[0].getRendered()).not.toContain("关闭之后才出现的新文本 BBB-704");
		});

		it("should support the /subagent-result scrolling key habits (g/G top/bottom, k scroll up)", async () => {
			expect(watchCommand, "功能缺失：未注册 subagent-watch 命令").toBeDefined();
			// Arrange: 长文本（80 行）使其可滚动
			const longText = Array.from({ length: 80 }, (_, i) => `Line ${i + 1}: watch scroll content.`).join("\n");
			const taskId = await dispatchRunningTask(705);
			feedEvent(lastProc(), assistantEndEvent(longText));
			const { ctx, captured } = createCustomCtx();
			const handlerPromise = watchCommand.handler(taskId, ctx);
			await waitForCustomCalls(captured, 1);

			// Act + Assert: g 跳到开头（不依赖打开时的初始滚动位置）
			captured[0].handleInput("g");
			expect(captured[0].getRendered()).toContain("Line 1:");

			// G 跳到末尾
			captured[0].handleInput("G");
			expect(captured[0].getRendered()).toContain("Line 80");

			// k 向上滚动一行（末尾不再可见）
			captured[0].handleInput("k");
			expect(captured[0].getRendered()).not.toContain("Line 80");

			captured[0].handleInput(KEY_ESC);
			await handlerPromise;
		});
	});

	// ================================================================
	// 规格 8 — 非 TUI 模式
	// ================================================================
	describe("规格 8 — 非 TUI 模式", () => {
		it("should log the exact locked line and not open any viewer in print mode", async () => {
			expect(watchCommand, "功能缺失：未注册 subagent-watch 命令").toBeDefined();
			const taskId = makeTaskId(801);
			insertTask(taskId, "running");
			const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
			const notifyMock = vi.fn();
			const customMock = vi.fn();
			const ctx = { hasUI: false, mode: "print" as const, ui: { notify: notifyMock, custom: customMock } };

			await watchCommand.handler(taskId, ctx);

			expect(customMock, "非 TUI 模式不得打开查看器").not.toHaveBeenCalled();
			expect(logSpy).toHaveBeenCalledTimes(1);
			expect(logSpy).toHaveBeenCalledWith(NON_TUI_LOG(taskId));
			logSpy.mockRestore();
		});

		it("should log the exact locked line and not open any viewer in json mode", async () => {
			expect(watchCommand, "功能缺失：未注册 subagent-watch 命令").toBeDefined();
			const taskId = makeTaskId(802);
			insertTask(taskId, "running");
			const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
			const notifyMock = vi.fn();
			const customMock = vi.fn();
			const ctx = { hasUI: false, mode: "json" as const, ui: { notify: notifyMock, custom: customMock } };

			await watchCommand.handler(taskId, ctx);

			expect(customMock, "非 TUI 模式不得打开查看器").not.toHaveBeenCalled();
			expect(logSpy).toHaveBeenCalledTimes(1);
			expect(logSpy).toHaveBeenCalledWith(NON_TUI_LOG(taskId));
			logSpy.mockRestore();
		});
	});

	// ================================================================
	// 缺陷回归 — 同回合 text_delta + message_end 后不得残留 [streaming] 重复渲染
	// （实证缺陷：message_end 把完整文本推入 messages 但不清空 thinkingBuffer
	//   （仅 turn_start 清空），而 buildText() 无条件把非空缓冲追加为
	//   [streaming] 行 → 同一文本渲染两遍，把已完成内容误报为「正在生成」。
	//   以下用例随该缺陷修复追加，当前全部通过（回归锁）；第 3 条为修复
	//   保护，防止误杀「正在生成」。）
	// ================================================================
	describe("缺陷回归 — 同回合流式增量后 message_end 不得残留 [streaming] 重复渲染", () => {
		it("should render the streamed text exactly once (as [assistant]) and leave no [streaming] row when text_delta is followed by message_end in the same turn (短文本)", async () => {
			expect(watchCommand, "功能缺失：未注册 subagent-watch 命令").toBeDefined();
			// Arrange
			const marker = "UNIQ-MARKER-SHORT-901";
			const taskId = await dispatchRunningTask(901);
			const { ctx, captured } = createCustomCtx();
			const handlerPromise = watchCommand.handler(taskId, ctx);
			await waitForCustomCalls(captured, 1);

			// Act: 同一回合先流式增量、再 message_end 物化同一文本，推进 1 个刷新周期
			feedEvent(lastProc(), textDeltaEvent(marker));
			feedEvent(lastProc(), assistantEndEvent(marker));
			await vi.advanceTimersByTimeAsync(REFRESH_MS);

			// Assert: M 只能出现一次（即 [assistant] M），不得存在包含 M 的 [streaming] 行
			const rendered = captured[0].getRendered();
			expect(rendered).toContain(`[assistant] ${marker}`);
			expect(rendered, "已完成文本不得再以 [streaming] 行出现").not.toContain("[streaming]");
			expect(countOccurrences(rendered, marker), "同一文本不得渲染两遍").toBe(1);

			captured[0].handleInput(KEY_ESC);
			await handlerPromise;
		});

		it("should leave no [streaming] row and show the full text as [assistant] when multi-chunk text_deltas beyond the 2048-char stream buffer cap are followed by message_end (长文本)", async () => {
			expect(watchCommand, "功能缺失：未注册 subagent-watch 命令").toBeDefined();
			// Arrange: 总长超过流式缓冲 2048 字符上限（src/index.ts text_delta 截断逻辑），
			// 头部标记会在增量阶段被缓冲截断丢弃，只能靠 message_end 的完整文本呈现
			const headMarker = "HEADMARK-LONG-902";
			const tailMarker = "TAILMARK-LONG-902";
			const chunk1 = headMarker + "a".repeat(600);
			const chunk2 = "b".repeat(700);
			const chunk3 = "c".repeat(700);
			const chunk4 = "d".repeat(200) + tailMarker;
			const longText = chunk1 + chunk2 + chunk3 + chunk4; // ≈2234 字符 > 2048
			const taskId = await dispatchRunningTask(902);
			const { ctx, captured } = createCustomCtx();
			const handlerPromise = watchCommand.handler(taskId, ctx);
			await waitForCustomCalls(captured, 1);

			// Act: 多段 text_delta 拼成长文本，再喂同一长文本的 message_end
			feedEvent(lastProc(), textDeltaEvent(chunk1));
			feedEvent(lastProc(), textDeltaEvent(chunk2));
			feedEvent(lastProc(), textDeltaEvent(chunk3));
			feedEvent(lastProc(), textDeltaEvent(chunk4));
			feedEvent(lastProc(), assistantEndEvent(longText));
			await vi.advanceTimersByTimeAsync(REFRESH_MS);

			// Assert: 已完成全文正常呈现（头部标记在增量阶段已被缓冲截断丢弃，只能靠
			// message_end 的完整文本出现），且渲染中不得残留任何 [streaming] 行。
			// 宽渲染避免折行使全文处于可视窗口内；[assistant] 条目标签用行首匹配（
			// Markdown 对超长无空格词会折到下一行，标签与正文不一定同行）。
			const wide = captured[0].getRendered(300);
			expect(wide).toContain(headMarker);
			expect(wide).toContain(tailMarker);
			expect(
				wide.split("\n").some((l) => l.trimStart().startsWith("[assistant]")),
				"已完成文本须以 [assistant] 条目呈现",
			).toBe(true);
			expect(wide, "message_end 后不得残留 [streaming] 行（含被截断的流式缓冲）").not.toContain("[streaming]");
			expect(countOccurrences(wide, tailMarker), "尾部标记不得同时出现在 [assistant] 与 [streaming] 两处").toBe(1);

			captured[0].handleInput(KEY_ESC);
			await handlerPromise;
		});

		it("should keep an unmaterialized text_delta visible as a [streaming] row when no message_end arrives (修复保护：不得误杀「正在生成」)", async () => {
			expect(watchCommand, "功能缺失：未注册 subagent-watch 命令").toBeDefined();
			// Arrange
			const delta = "尚未物化的流式增量 MARK-903";
			const taskId = await dispatchRunningTask(903);
			const { ctx, captured } = createCustomCtx();
			const handlerPromise = watchCommand.handler(taskId, ctx);
			await waitForCustomCalls(captured, 1);

			// Act: 只喂 text_delta（无 message_end），推进 1 个刷新周期
			feedEvent(lastProc(), textDeltaEvent(delta));
			await vi.advanceTimersByTimeAsync(REFRESH_MS);

			// Assert: 未物化的增量仍须以 [streaming] 行可见（本条修复前后均应为绿）
			const rendered = captured[0].getRendered();
			expect(rendered).toContain("[streaming]");
			expect(rendered).toContain(delta);

			captured[0].handleInput(KEY_ESC);
			await handlerPromise;
		});
	});

	// ================================================================
	// 缺陷回归（第二轮）— 空白结尾文本重复渲染
	// （审查实证：buildText() 物化判定先把 thinkingBuffer trim 再与已完成
	//   assistant 文本做 endsWith 后缀匹配；而原始缓冲恒为消息文本的原始
	//   后缀（text_delta 逐段精确拼接）。一旦消息文本以空白结尾（尾随换行 /
	//   尾随空格 / 多行文本以换行结尾），trim 后 endsWith 失败 → 判定「未物化」
	//   → 同一文本以 [assistant] + [streaming] 渲染两遍，直至下一个 turn_start
	//   才消失。第一轮 901/902 均以非空白结尾，漏掉本类。以下用例断言渲染文本
	//   行为：标记恰出现 1 次（只以 [assistant] 形式），且无包含标记的
	//   [streaming] 行。以下用例随该缺陷修复追加，当前全部通过（回归锁）。）
	// ================================================================
describe("缺陷回归（第二轮）— 空白结尾文本不得重复渲染", () => {
		it("should render the text exactly once as [assistant] with no [streaming] row when the streamed text ends with a newline (WSMARK-904)", async () => {
			expect(watchCommand, "功能缺失：未注册 subagent-watch 命令").toBeDefined();
			// Arrange
			const marker = "WSMARK-904";
			const taskId = await dispatchRunningTask(904);
			const { ctx, captured } = createCustomCtx();
			const handlerPromise = watchCommand.handler(taskId, ctx);
			await waitForCustomCalls(captured, 1);

			// Act: 同一回合先喂尾随换行的 text_delta，再喂同文本（含 \n）的 message_end
			feedEvent(lastProc(), textDeltaEvent(`${marker}\n`));
			feedEvent(lastProc(), assistantEndEvent(`${marker}\n`));
			await vi.advanceTimersByTimeAsync(REFRESH_MS);

			// Assert: 标记只能出现一次（即 [assistant] 形式），不得有包含该标记的 [streaming] 行
			const rendered = captured[0].getRendered();
			expect(rendered).toContain(`[assistant] ${marker}`);
			expect(countOccurrences(rendered, marker), "空白结尾文本不得渲染两遍（trim 后缓冲仍是原文后缀，不得误判未物化）").toBe(1);
			expect(
				rendered.split("\n").some((l) => l.includes("[streaming]") && l.includes(marker)),
				"已完成文本不得再以 [streaming] 行出现",
			).toBe(false);

			captured[0].handleInput(KEY_ESC);
			await handlerPromise;
		});

		it("should render the text exactly once as [assistant] with no [streaming] row when the streamed text ends with trailing spaces (WSMARK-905)", async () => {
			expect(watchCommand, "功能缺失：未注册 subagent-watch 命令").toBeDefined();
			// Arrange
			const marker = "WSMARK-905";
			const taskId = await dispatchRunningTask(905);
			const { ctx, captured } = createCustomCtx();
			const handlerPromise = watchCommand.handler(taskId, ctx);
			await waitForCustomCalls(captured, 1);

			// Act: 同一回合先喂带 3 个尾随空格的 text_delta，再喂同文本（含尾随空格）的 message_end
			feedEvent(lastProc(), textDeltaEvent(`${marker}   `));
			feedEvent(lastProc(), assistantEndEvent(`${marker}   `));
			await vi.advanceTimersByTimeAsync(REFRESH_MS);

			// Assert: 标记只能出现一次（即 [assistant] 形式），不得有包含该标记的 [streaming] 行
			const rendered = captured[0].getRendered();
			expect(rendered).toContain(`[assistant] ${marker}`);
			expect(countOccurrences(rendered, marker), "尾随空格文本不得渲染两遍（trim 后缓冲仍是原文后缀，不得误判未物化）").toBe(1);
			expect(
				rendered.split("\n").some((l) => l.includes("[streaming]") && l.includes(marker)),
				"已完成文本不得再以 [streaming] 行出现",
			).toBe(false);

			captured[0].handleInput(KEY_ESC);
			await handlerPromise;
		});

		it("should render the text exactly once as [assistant] with no [streaming] row when multi-line streamed text ends with a newline (WSMARK-906)", async () => {
			expect(watchCommand, "功能缺失：未注册 subagent-watch 命令").toBeDefined();
			// Arrange
			const marker = "WSMARK-906";
			const taskId = await dispatchRunningTask(906);
			const { ctx, captured } = createCustomCtx();
			const handlerPromise = watchCommand.handler(taskId, ctx);
			await waitForCustomCalls(captured, 1);

			// Act: 同一回合先喂多行（以换行结尾）的 text_delta，再喂同文本的 message_end
			feedEvent(lastProc(), textDeltaEvent(`first line\n${marker}\n`));
			feedEvent(lastProc(), assistantEndEvent(`first line\n${marker}\n`));
			await vi.advanceTimersByTimeAsync(REFRESH_MS);

			// Assert: 标记只能出现一次（即 [assistant] 形式），不得有包含该标记的 [streaming] 行
			// （多行文本的换行被 Markdown 渲染为行分隔，[assistant] 标签与标记不处同一行，
			//   故以条目头验证 [assistant] 形式，而非整行 containment）
			const rendered = captured[0].getRendered();
			expect(rendered).toContain("[assistant] first line");
			expect(countOccurrences(rendered, marker), "多行换行结尾文本不得渲染两遍（trim 后缓冲仍是原文后缀，不得误判未物化）").toBe(1);
			expect(
				rendered.split("\n").some((l) => l.includes("[streaming]") && l.includes(marker)),
				"已完成文本不得再以 [streaming] 行出现",
			).toBe(false);

			captured[0].handleInput(KEY_ESC);
			await handlerPromise;
		});
	});

	// ================================================================
	// 增强 — 查看器正文顶部显示原任务（用户实测反馈：页面很空、看不出这是什么
	// 任务；与 /subagent-result 对齐同款两节结构：「Original task\n\n<任务原文>」
	// 在前、「Conversation log\n\n<条目>」在后，纯文本标签非 Markdown 标题。
	// 任务原文须逐字来自主 agent 下发的任务文本，初始渲染即出现，且刷新周期
	// 推进后仍只出现一次（不得因周期性重建重复叠加）。以下用例随该增强
	// 实现追加，当前全部通过（回归锁）。)
	// ================================================================
	describe("增强 — 查看器显示原任务（Original task 节）", () => {
		/** 派发一个任务描述含自定义文本的运行中任务（沿用 dispatchRunningTask 的注入缝，仅放开 task 文本）。 */
		async function dispatchRunningTaskWithText(n: number, taskText: string): Promise<string> {
			const taskId = makeTaskId(n);
			const executePromise = executeToolRef(
				`call-${taskId}`,
				{ agent: "tester", task: taskText, sessionId: taskId },
				undefined,
				undefined,
				dispatchCtxRef,
			);
			await raceWithTimeout(executePromise, 200);
			expect(taskRegistry.get(taskId)?.status, `task ${taskId} should be running after dispatch`).toBe("running");
			return taskId;
		}

		it("should include the 'Original task' and 'Conversation log' section labels and the verbatim task text in the initial render", async () => {
			expect(watchCommand, "功能缺失：未注册 subagent-watch 命令").toBeDefined();
			// Arrange: 任务描述含唯一标记（任务原文中仅出现一次），且任务先产生一段已有输出
			const marker = "TASKMARK-907";
			const taskText = `请排查 TASKMARK-907 相关告警并给出根因报告。`;
			const taskId = await dispatchRunningTaskWithText(907, taskText);
			feedEvent(lastProc(), assistantEndEvent("已有的助手回复 ALPHA-907"));
			const { ctx, captured } = createCustomCtx();

			// Act: 打开查看器（不推进任何定时器）
			const handlerPromise = watchCommand.handler(taskId, ctx);
			await waitForCustomCalls(captured, 1);

			// Assert: 初始渲染即含两节纯文本标签（独立成行，与 /subagent-result 同款）
			// 与逐字任务原文；标记出现次数与任务描述中的出现一致（恰好一次）
			const rendered = captured[0].getRendered();
			const lines = rendered.split("\n");
			expect(lines.some((l) => l.trim() === "Original task"), "初始渲染须含 Original task 标签行").toBe(true);
			expect(lines.some((l) => l.trim() === "Conversation log"), "初始渲染须含 Conversation log 标签行").toBe(true);
			expect(rendered).toContain(marker);
			expect(countOccurrences(rendered, marker), "任务标记须逐字出现，且次数与任务描述中的出现一致").toBe(1);

			captured[0].handleInput(KEY_ESC);
			await handlerPromise;
		});

		it("should place the original task text before the first conversation entry", async () => {
			expect(watchCommand, "功能缺失：未注册 subagent-watch 命令").toBeDefined();
			// Arrange: 任务先产生一条已完成助手输出，再打开查看器
			const marker = "TASKMARK-908";
			const taskText = `验证 TASKMARK-908 的端到端行为。`;
			const taskId = await dispatchRunningTaskWithText(908, taskText);
			feedEvent(lastProc(), assistantEndEvent("首个对话条目 ALPHA-908"));
			const { ctx, captured } = createCustomCtx();
			const handlerPromise = watchCommand.handler(taskId, ctx);
			await waitForCustomCalls(captured, 1);

			// Assert: 任务原文位于首个对话条目（[assistant]）之前
			const rendered = captured[0].getRendered();
			const markerIndex = rendered.indexOf(marker);
			const firstEntryIndex = rendered.indexOf("[assistant]");
			expect(markerIndex, "初始渲染须含任务标记").toBeGreaterThanOrEqual(0);
			expect(firstEntryIndex, "初始渲染须含对话条目").toBeGreaterThanOrEqual(0);
			expect(markerIndex, "任务原文须位于首个对话条目之前").toBeLessThan(firstEntryIndex);

			captured[0].handleInput(KEY_ESC);
			await handlerPromise;
		});

		it("should keep the task text rendered exactly once across refresh cycles", async () => {
			expect(watchCommand, "功能缺失：未注册 subagent-watch 命令").toBeDefined();
			// Arrange
			const marker = "TASKMARK-909";
			const taskText = `跟踪 TASKMARK-909 直至收敛。`;
			const taskId = await dispatchRunningTaskWithText(909, taskText);
			const { ctx, captured } = createCustomCtx();
			const handlerPromise = watchCommand.handler(taskId, ctx);
			await waitForCustomCalls(captured, 1);
			expect(captured[0].getRendered(), "初始渲染须含任务原文").toContain(marker);

			// Act: 运行中产生新输出，推进 2 个刷新周期（周期性重建不得重复叠加任务原文）
			feedEvent(lastProc(), assistantEndEvent("第二周期新增的输出 BBB-909"));
			await vi.advanceTimersByTimeAsync(REFRESH_MS);
			feedEvent(lastProc(), textDeltaEvent("第三周期的流式增量 CCC-909"));
			await vi.advanceTimersByTimeAsync(REFRESH_MS);

			// Assert: 两节标签仍在，任务标记仍只出现一次
			const rendered = captured[0].getRendered();
			expect(rendered).toContain("Original task");
			expect(rendered).toContain("Conversation log");
			expect(countOccurrences(rendered, marker), "刷新周期推进后任务原文不得重复叠加").toBe(1);

			captured[0].handleInput(KEY_ESC);
			await handlerPromise;
		});
	});
});
