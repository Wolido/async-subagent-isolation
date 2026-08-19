/**
 * Contract tests: interactive pickers for /subagent-result and /subagent-cancel
 * (无参数时弹出交互选择列表), 含 q 键退出需求。
 *
 * 需求（来自产品）:
 * 1. /subagent-result 无参数 → 交互选择列表列出最近 5 个已运行结束的任务
 *    (按结束时间倒序), ↑↓ 选择、Enter 进入与 /subagent-result <taskId> 相同
 *    的全屏结果查看器; Esc 或 q 退出, 不做任何操作。
 * 2. /subagent-cancel 无参数 → 交互选择列表列出全部运行中任务 (不受 5 个上
 *    限), ↑↓ 选择、Enter 走与 cancelTask(taskId, "user") 相同的路径取消;
 *    Esc 或 q 退出, 不做任何操作。
 * 3. 带参数旧行为 (/subagent-result <taskId> / /subagent-cancel <taskId> /
 *    /subagent-cancel-all) 保持不变; 非 TUI (hasUI=false 或 mode!=="tui") 不弹
 *    列表, 回退到现有提示行为。
 *
 * 接口选型（已查证）:
 * - pi 内置 ctx.ui.select() 底层组件 ExtensionSelectorComponent 与 pi-tui 的
 *   SelectList 都只处理 ↑↓/Enter/Esc(Ctrl+C), 均不响应 q 键, 且 select() 无
 *   自定义按键选项 (dist/modes/interactive/components/extension-selector.js,
 *   pi-tui/dist/components/select-list.js)。q 键退出只能通过 ctx.ui.custom()
 *   自定义组件实现 (tui.md Pattern 1: SelectList + 自定义 handleInput 拦截)。
 * - 因此测试不 mock ui.select, 而是捕获 ui.custom 收到的组件, 通过模拟终端
 *   输入 (↑↓/Enter/Esc/q) 驱动组件, 断言最终可观察行为。
 * - 选择列表与结果查看器都经 ui.custom 调用, 按调用顺序区分: captured[0] 是
 *   选择列表, 选中后 captured[1] 是结果查看器。Esc/q 场景只有一次调用。
 * - 选项内容从组件 render() 输出的文本行断言 (标签格式由实现定, 只断言
 *   taskId 片段出现/不出现/相对顺序); 数量上限场景用滚动收集 (反复 ↓) 后的
 *   渲染文本并集, 对 SelectList maxVisible 截断稳健。
 *
 * 数据来源策略（实现自由，测试不锁死）: "已结束任务"在测试中同时通过两条路径
 * 驱动，无论实现选哪种数据来源都能观察到同一份列表：
 *   (a) dispatch→完成的完整流程（内存完成记录: completeAsyncTask 已从
 *       taskRegistry 删除任务并发出 [subagent-result] 通知）；
 *   (b) 在 subagent-sessions/<taskId>/ 写入受控 mtime 的会话文件（目录扫描）,
 *       mtime 顺序与完成顺序一致。
 *
 * 本套件的两类测试:
 * - 交互选择器的功能契约测试（describe A/B 主体）: 列表内容、顺序、数量上限、
 *   选中/退出行为, 通过 ui.custom 捕获组件 + 模拟终端输入驱动断言。
 * - 标注 [回归锁定] 的测试钉住必须保持不变的传统行为: 带参数路径
 *   (/subagent-result <taskId> / /subagent-cancel <taskId> / /subagent-cancel-all)
 *   与非 TUI 回退提示, 防止交互选择器的实现破坏旧行为。
 *
 * 测试隔离（reviewer 🟡-3 加固）: src/index.ts 持有模块级 completedTasks
 * (最近完成任务记录, 未导出) 与 taskRegistry。为避免跨测试泄漏 (且不与
 * coder 并行修改 src 冲突, 不新增导出), 每个测试前 vi.resetModules() +
 * 动态 import 获得干净模块实例 —— completedTasks / taskRegistry 天然为空。
 * vi.mock 工厂在 re-import 时重跑, 因此 getAgentDir / spawn 的 mock 引用
 * 必须在 beforeEach 中重新获取配置 (静态 import 拿到的是旧实例)。
 * describe C 专门验证该隔离: 同 taskId 跨测试写会话文件不得误弹 picker。
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

/**
 * Fresh module handles, re-assigned per test after vi.resetModules() so that
 * module-level state (completedTasks, taskRegistry) never leaks across tests.
 */
let extension: (typeof import("../src/index.ts"))["default"];
let taskRegistry: Map<string, AsyncSubagentTask>;

const ENV_KEYS = [
	"PI_SUBAGENT_DEPTH",
	"PI_SUBAGENT_HARD_TIMEOUT_MS",
	"PI_SUBAGENT_ACTIVITY_TIMEOUT_MS",
	"PI_CURRENT_AGENT_NAME",
	"PI_CAN_DELEGATE",
];

type ExecuteFn = (
	toolCallId: string,
	params: Record<string, unknown>,
	signal: AbortSignal | undefined,
	onUpdate: unknown,
	ctx: unknown,
) => Promise<any>;

/** 终端输入序列（裸形态） */
const KEY_DOWN = "\x1b[B";
const KEY_ENTER = "\r";
const KEY_ESC = "\x1b";
const KEY_Q = "q";

// ---------------------------------------------------------------------------
// Helpers (mirror subagent-cancel-tool.test.ts / receipt-and-subagent-result.test.ts)
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
	const sendMessageCalls: any[] = [];

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
		sendMessage: vi.fn((...args: any[]) => {
			sendMessageCalls.push(args);
		}),
		_toolDefs: toolDefs,
		_commandDefs: commandDefs,
		_eventHandlers: eventHandlers,
		_sendMessageCalls: sendMessageCalls,
	};
}

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
}

/**
 * Mock a TUI command ctx whose ui.custom() captures the created component.
 * The custom() promise resolves when the component calls done(value), matching
 * real pi behavior (the overlay lives until the component finishes).
 *
 * 选择列表与查看器都经 ui.custom 调用, 按调用顺序区分:
 * captured[0] = 选择列表, 选中后 captured[1] = 结果查看器。
 */
function createCustomCtx() {
	const notifyMock = vi.fn();
	const captured: CapturedComponent[] = [];
	const customMock = vi.fn(
		(cb: any) =>
			new Promise((resolve) => {
				const theme = { fg: (_c: string, s: string) => s, bold: (s: string) => s };
				// tui stub: 文档 Pattern 1 的 handleInput 调 tui.requestRender() (非 optional)
				const tui = { requestRender: vi.fn() };
				const done = vi.fn((value?: unknown) => resolve(value));
				const component = cb(tui, theme, null, done);
				captured.push({
					component,
					done,
					getRendered: (width = 80) => component.render(width).join("\n"),
				});
			}),
	);
	const ctx = { hasUI: true, mode: "tui" as const, ui: { notify: notifyMock, custom: customMock } };
	return { ctx, notifyMock, customMock, captured };
}

/**
 * Wait until ui.custom has been called n times. Each round yields the real
 * event loop (fake timers are toggled off) so implementations using async fs
 * (e.g. scanning subagent-sessions/) can complete.
 */
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

/**
 * Rendered text union of a picker component: initial render plus repeated
 * ↓ presses, so options hidden by a maxVisible scroll window still show up.
 */
function collectRenderedText(component: any, downs = 8): string {
	let text = component.render(80).join("\n");
	for (let i = 0; i < downs; i++) {
		component.handleInput(KEY_DOWN);
		text += `\n${component.render(80).join("\n")}`;
	}
	return text;
}

function writeAgentFile(cwd: string) {
	fs.mkdirSync(path.join(cwd, ".pi", "agents"), { recursive: true });
	fs.writeFileSync(
		path.join(cwd, ".pi", "agents", "tester.md"),
		`---\nname: tester\ndescription: Test agent\n---\n`,
		"utf-8",
	);
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

/** UUID v7-shaped taskId for deterministic dispatch sessionIds. */
function makeTaskId(n: number): string {
	return `019ffdd3-3eb5-733d-b481-a53e5292b${String(n).padStart(3, "0")}`;
}

/** Insert a running task directly into the registry (cancel-picker drive). */
function insertRunningTask(taskId: string, agentName = "tester"): AsyncSubagentTask {
	const record: AsyncSubagentTask = {
		taskId,
		agentName,
		task: `task for ${taskId}`,
		startedAt: Date.now(),
		abortController: new AbortController(),
		status: "running",
	};
	taskRegistry.set(taskId, record);
	return record;
}

/** 提示"没有已结束任务"语义的匹配器（中英文均可，标签格式由实现定）。 */
const NO_FINISHED_TASKS_PATTERN = /no finished subagent tasks|no (finished|completed)/i;

describe("交互选择列表（/subagent-result & /subagent-cancel 无参数）", () => {
	let tmpBase: string;
	let agentDir: string;
	let defaultCwd: string;
	let savedEnv: Record<string, string | undefined>;
	let allProcs: ReturnType<typeof createControllableProc>[];

	beforeEach(async () => {
		vi.useFakeTimers();
		// 模块级状态隔离: 干净模块实例 → completedTasks / taskRegistry 为空
		vi.resetModules();
		const mod = await import("../src/index.ts");
		extension = mod.default;
		taskRegistry = mod.taskRegistry;

		tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "interactive-pickers-test-"));
		agentDir = path.join(tmpBase, "agent-dir");
		defaultCwd = path.join(tmpBase, "default-cwd");
		writeAgentFile(defaultCwd);
		fs.mkdirSync(agentDir, { recursive: true });
		// resetModules 后 vi.mock 工厂重跑, 必须重新取引用再配置
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
	});

	afterEach(() => {
		for (const key of ENV_KEYS) {
			if (savedEnv[key] === undefined) delete process.env[key];
			else process.env[key] = savedEnv[key];
		}
		taskRegistry.clear();
		fs.rmSync(tmpBase, { recursive: true, force: true });
		vi.clearAllMocks();
		vi.useRealTimers();
	});

	function setupExtension() {
		const pi = createMockPi();
		extension(pi as any);
		const toolsByName = new Map(pi._toolDefs.map((t: any) => [t.name, t] as const));
		const executeTool = toolsByName.get("subagent")?.execute as ExecuteFn;
		return {
			pi,
			executeTool,
			resultCommand: pi._commandDefs.get("subagent-result"),
			cancelCommand: pi._commandDefs.get("subagent-cancel"),
			cancelAllCommand: pi._commandDefs.get("subagent-cancel-all"),
		};
	}

	/**
	 * Drive one task through dispatch→completion and give it a session file.
	 * Completion order = call order; the session file's mtime is set to match
	 * (n increases), so in-memory and directory-scan data sources observe the
	 * same finish ordering.
	 */
	async function finishTask(n: number): Promise<string> {
		const taskId = makeTaskId(n);
		const executePromise = executeToolRef(
			`call-${taskId}`,
			{ agent: "tester", task: `task ${n}`, sessionId: taskId },
			undefined,
			undefined,
			dispatchCtxRef,
		);
		await raceWithTimeout(executePromise, 200);
		expect(taskRegistry.has(taskId), `task ${taskId} should be running after dispatch`).toBe(true);

		endProcess(allProcs[allProcs.length - 1], 0);
		await vi.advanceTimersByTimeAsync(1000);
		expect(taskRegistry.has(taskId), `task ${taskId} should leave the registry after completion`).toBe(false);

		writeFinishedSessionFile(taskId, `RESULT-TEXT-${n}`, 1_700_000_000_000 + n * 10_000);
		return taskId;
	}

	/** Dispatch a task and leave it running. */
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
		expect(taskRegistry.get(taskId)?.status).toBe("running");
		return taskId;
	}

	function writeFinishedSessionFile(taskId: string, assistantText: string, mtimeMs: number): void {
		const sessionDir = path.join(agentDir, "subagent-sessions", taskId);
		fs.mkdirSync(sessionDir, { recursive: true });
		const filePath = path.join(sessionDir, `1700000000000_${taskId}.jsonl`);
		const content =
			[
				{ type: "message", message: { role: "user", content: [{ type: "text", text: `Task: ${taskId}` }] } },
				{ type: "message", message: { role: "assistant", content: [{ type: "text", text: assistantText }] } },
			]
				.map((m) => JSON.stringify(m))
				.join("\n") + "\n";
		fs.writeFileSync(filePath, content, "utf-8");
		const d = new Date(mtimeMs);
		fs.utimesSync(filePath, d, d);
	}

	// Set per-test in the result-picker describe block.
	let executeToolRef: ExecuteFn;
	let dispatchCtxRef: unknown;

	// ================================================================
	// A. /subagent-result 无参数 → 最近 5 个已结束任务的选择列表
	// ================================================================
	describe("A. /subagent-result 交互选择（无参数）", () => {
		let resultCommand: any;

		beforeEach(() => {
			const setup = setupExtension();
			executeToolRef = setup.executeTool;
			dispatchCtxRef = createMockTuiCtx(defaultCwd);
			resultCommand = setup.resultCommand;
		});

		it("有 3 个已完成任务 → 弹出选择列表, 渲染含 3 个 taskId, 按结束时间倒序", async () => {
			// Arrange: 完成 3 个任务 (t1 最早, t3 最新)
			const t1 = await finishTask(1);
			const t2 = await finishTask(2);
			const t3 = await finishTask(3);
			const { ctx, captured } = createCustomCtx();

			// Act: 无参数调用 → 应弹出选择列表 (captured[0])
			const handlerPromise = resultCommand.handler("", ctx);
			await waitForCustomCalls(captured, 1);

			// Assert: 选择列表弹出, 3 个已完成任务全部渲染, 最新在前
			expect(captured, "无参数时应通过 ui.custom 弹出选择列表").toHaveLength(1);
			const rendered = captured[0].getRendered();
			expect(rendered).toContain(t1);
			expect(rendered).toContain(t2);
			expect(rendered).toContain(t3);
			expect(rendered.indexOf(t3)).toBeLessThan(rendered.indexOf(t2));
			expect(rendered.indexOf(t2)).toBeLessThan(rendered.indexOf(t1));

			// Cleanup: Esc 关闭选择列表
			captured[0].component.handleInput(KEY_ESC);
			await handlerPromise;
		});

		it("有 6 个已完成任务 → 只列最近 5 个 (不含最旧)", async () => {
			// Arrange: 完成 6 个任务 (t1 最早 … t6 最新)
			const ids: string[] = [];
			for (let n = 1; n <= 6; n++) ids.push(await finishTask(n));
			const { ctx, captured } = createCustomCtx();

			// Act
			const handlerPromise = resultCommand.handler("", ctx);
			await waitForCustomCalls(captured, 1);

			// Assert: 滚动收集渲染文本, 最近 5 个全部出现, 最旧的 t1 不出现
			expect(captured, "无参数时应通过 ui.custom 弹出选择列表").toHaveLength(1);
			const rendered = collectRenderedText(captured[0].component);
			for (const id of ids.slice(1)) {
				expect(rendered, `选项应包含最近完成的任务 ${id}`).toContain(id);
			}
			expect(rendered, "超过 5 个已完成任务时最旧的一个不应列出").not.toContain(ids[0]);

			// Cleanup
			captured[0].component.handleInput(KEY_ESC);
			await handlerPromise;
		});

		it("运行中的任务不应出现在已结束任务选择列表中", async () => {
			// Arrange: 2 个已完成 + 1 个仍在运行
			const t1 = await finishTask(1);
			const t2 = await finishTask(2);
			const runningId = await dispatchRunningTask(3);
			const { ctx, captured } = createCustomCtx();

			// Act
			const handlerPromise = resultCommand.handler("", ctx);
			await waitForCustomCalls(captured, 1);

			// Assert: 只列 2 个已完成任务, 运行中任务被排除
			expect(captured).toHaveLength(1);
			const rendered = captured[0].getRendered();
			expect(rendered).toContain(t1);
			expect(rendered).toContain(t2);
			expect(rendered).not.toContain(runningId);

			// Cleanup
			captured[0].component.handleInput(KEY_ESC);
			await handlerPromise;
		});

		it("↑↓ 选中后按 Enter → 打开全屏查看器展示该任务结果 (与带参路径相同)", async () => {
			// Arrange: 3 个已完成任务 (倒序 t3,t2,t1); ↓ 一次后 Enter 选中 t2
			await finishTask(1);
			const t2 = await finishTask(2);
			await finishTask(3);
			const { ctx, captured } = createCustomCtx();

			// Act: 弹出选择列表 → ↓ → Enter
			const handlerPromise = resultCommand.handler("", ctx);
			await waitForCustomCalls(captured, 1);
			expect(captured).toHaveLength(1);
			captured[0].component.handleInput(KEY_DOWN);
			captured[0].component.handleInput(KEY_ENTER);
			await waitForCustomCalls(captured, 2);

			// Assert: 第二次 ui.custom 调用是与带参路径相同的结果查看器,
			// 展示被选中任务 (t2) 的会话内容
			expect(captured, "选中后应打开全屏结果查看器").toHaveLength(2);
			const viewerRendered = captured[1].getRendered();
			expect(viewerRendered).toContain("RESULT-TEXT-2");
			expect(viewerRendered).not.toContain("RESULT-TEXT-1");
			expect(viewerRendered).not.toContain("RESULT-TEXT-3");

			// Cleanup: Esc 关闭查看器
			captured[1].component.handleInput(KEY_ESC);
			await handlerPromise;
		});

		it("Esc → 不打开查看器, 无任何通知", async () => {
			// Arrange
			await finishTask(1);
			const { ctx, captured, notifyMock } = createCustomCtx();

			// Act: 弹出选择列表 → Esc
			const handlerPromise = resultCommand.handler("", ctx);
			await waitForCustomCalls(captured, 1);
			expect(captured, "无参数时应通过 ui.custom 弹出选择列表").toHaveLength(1);
			captured[0].component.handleInput(KEY_ESC);
			await handlerPromise;
			await flushAsync();

			// Assert: Esc 后不做任何操作 (无查看器, 无通知)
			expect(captured, "Esc 后不应打开查看器").toHaveLength(1);
			expect(notifyMock, "Esc 后不应有任何通知").not.toHaveBeenCalled();
		});

		it("q 键 → 不打开查看器, 无任何通知 (与 Esc 对称)", async () => {
			// Arrange
			await finishTask(1);
			const { ctx, captured, notifyMock } = createCustomCtx();

			// Act: 弹出选择列表 → 按 q
			const handlerPromise = resultCommand.handler("", ctx);
			await waitForCustomCalls(captured, 1);
			expect(captured, "无参数时应通过 ui.custom 弹出选择列表").toHaveLength(1);
			captured[0].component.handleInput(KEY_Q);
			await handlerPromise;
			await flushAsync();

			// Assert: q 后不做任何操作 (组件 done, 无查看器, 无通知)
			expect(captured[0].done, "q 应关闭选择列表 (调用 done)").toHaveBeenCalled();
			expect(captured, "q 后不应打开查看器").toHaveLength(1);
			expect(notifyMock, "q 后不应有任何通知").not.toHaveBeenCalled();
		});

		it("q 退出后再次打开列表仍正常工作", async () => {
			// Arrange
			const t1 = await finishTask(1);
			const { ctx, captured } = createCustomCtx();

			// Act 1: 第一次打开, q 退出
			const first = resultCommand.handler("", ctx);
			await waitForCustomCalls(captured, 1);
			expect(captured).toHaveLength(1);
			captured[0].component.handleInput(KEY_Q);
			await first;

			// Act 2: 再次打开, Enter 选中唯一任务
			const second = resultCommand.handler("", ctx);
			await waitForCustomCalls(captured, 2);
			expect(captured, "q 退出后再次无参数调用应重新弹出选择列表").toHaveLength(2);
			expect(captured[1].getRendered()).toContain(t1);
			captured[1].component.handleInput(KEY_ENTER);
			await waitForCustomCalls(captured, 3);

			// Assert: 查看器正常打开
			expect(captured, "选中后应打开全屏结果查看器").toHaveLength(3);
			expect(captured[2].getRendered()).toContain("RESULT-TEXT-1");

			// Cleanup
			captured[2].component.handleInput(KEY_ESC);
			await second;
		});

		it("无已完成任务 → 提示没有已结束任务, 不弹选择列表", async () => {
			// Arrange: 没有任何已完成任务
			const { ctx, customMock, notifyMock } = createCustomCtx();

			// Act
			await resultCommand.handler("", ctx);

			// Assert: 不弹 custom; notify 提示"没有已结束任务"语义 (info/warning 均可)
			expect(customMock, "无已完成任务时不应弹选择列表").not.toHaveBeenCalled();
			expect(notifyMock).toHaveBeenCalledTimes(1);
			const [message, type] = notifyMock.mock.calls[0];
			expect(String(message)).toMatch(NO_FINISHED_TASKS_PATTERN);
			expect(["info", "warning"]).toContain(type);
		});

		it("只有运行中任务 (无已结束) → 提示没有已结束任务, 不弹选择列表", async () => {
			// Arrange: 1 个任务仍在运行, 尚未结束
			await dispatchRunningTask(1);
			const { ctx, customMock, notifyMock } = createCustomCtx();

			// Act
			await resultCommand.handler("", ctx);

			// Assert
			expect(customMock, "运行中任务不属于已结束列表, 不应弹选择列表").not.toHaveBeenCalled();
			expect(notifyMock).toHaveBeenCalledTimes(1);
			const [message, type] = notifyMock.mock.calls[0];
			expect(String(message)).toMatch(NO_FINISHED_TASKS_PATTERN);
			expect(["info", "warning"]).toContain(type);
		});

		it("[回归锁定] 带参数 /subagent-result <taskId> 仍走旧逻辑: 不弹选择列表, 直接打开查看器", async () => {
			// Arrange: 2 个已完成任务; 若误弹选择列表, t2 会出现在渲染中
			const t1 = await finishTask(1);
			await finishTask(2);
			const { ctx, captured } = createCustomCtx();

			// Act: 带参数调用
			const handlerPromise = resultCommand.handler(t1, ctx);
			await waitForCustomCalls(captured, 1);

			// Assert: 旧路径不变 — 仅一次 ui.custom (查看器), 内容是 t1 的结果
			expect(captured, "带参数时应直接打开查看器 (仅一次 ui.custom)").toHaveLength(1);
			const rendered = captured[0].getRendered();
			expect(rendered).toContain("RESULT-TEXT-1");
			expect(rendered, "带参数时不应弹出含其他任务的选择列表").not.toContain("RESULT-TEXT-2");

			// Cleanup: Esc 关闭查看器
			captured[0].component.handleInput(KEY_ESC);
			await handlerPromise;
		});

		it("[回归锁定] 非 TUI (hasUI=false) → 不弹选择列表, 回退现有 usage 提示", async () => {
			// Arrange: 有已完成任务, 但无 UI
			await finishTask(1);
			const notifyMock = vi.fn();
			const customMock = vi.fn();
			const ctx = { hasUI: false, ui: { notify: notifyMock, custom: customMock } };

			// Act
			await resultCommand.handler("", ctx);

			// Assert: 非 TUI 不弹 custom, 保持现有提示行为
			expect(customMock, "非 TUI 不应调用 ui.custom").not.toHaveBeenCalled();
			expect(notifyMock).toHaveBeenCalledTimes(1);
			const [message, type] = notifyMock.mock.calls[0];
			expect(String(message)).toMatch(/Usage|\/subagent-result/);
			expect(type).toBe("warning");
		});
	});

	// ================================================================
	// B. /subagent-cancel 无参数 → 全部运行中任务的选择列表
	// ================================================================
	describe("B. /subagent-cancel 交互选择（无参数）", () => {
		it("有 6 个运行中任务 → 选择列表渲染全部 6 个 (不受 5 个上限)", async () => {
			// Arrange: 6 个运行中任务
			const ids = Array.from({ length: 6 }, (_, i) => makeTaskId(i + 1));
			for (const id of ids) insertRunningTask(id);
			const { cancelCommand } = setupExtension();
			const { ctx, captured } = createCustomCtx();

			// Act
			const handlerPromise = cancelCommand.handler("", ctx);
			await waitForCustomCalls(captured, 1);

			// Assert: 滚动收集渲染文本, 6 个运行中任务全部列出
			expect(captured, "无参数且有运行中任务时应通过 ui.custom 弹出选择列表").toHaveLength(1);
			const rendered = collectRenderedText(captured[0].component);
			for (const id of ids) {
				expect(rendered, `运行中任务应全部列出, 不受 5 个上限: 缺 ${id}`).toContain(id);
			}

			// Cleanup: Esc 关闭选择列表
			captured[0].component.handleInput(KEY_ESC);
			await handlerPromise;
		});

		it("Enter 选中某项 → 该任务走 cancelTask(taskId, 'user') 相同路径被取消", async () => {
			// Arrange: 3 个运行中任务; 直接 Enter 选中列表第一项
			const tasks = [insertRunningTask(makeTaskId(1)), insertRunningTask(makeTaskId(2)), insertRunningTask(makeTaskId(3))];
			const { cancelCommand } = setupExtension();
			const { ctx, captured, notifyMock } = createCustomCtx();

			// Act: 弹出选择列表 → Enter (选中 index 0)
			const handlerPromise = cancelCommand.handler("", ctx);
			await waitForCustomCalls(captured, 1);
			expect(captured).toHaveLength(1);
			captured[0].component.handleInput(KEY_ENTER);
			await handlerPromise;
			await flushAsync();

			// Assert: 与 /subagent-cancel <taskId> 相同的可观察行为 ——
			// 恰好一个任务被取消 (cancelledBy=user, abort 触发), 其余仍 running
			const cancelled = tasks.filter((t) => t.status === "cancelled");
			const stillRunning = tasks.filter((t) => t.status === "running");
			expect(cancelled, "Enter 选中后应恰好取消一个任务").toHaveLength(1);
			expect(cancelled[0].cancelledBy, "命令路径来源应为 user").toBe("user");
			expect(cancelled[0].abortController.signal.aborted, "应触发 abort (SIGTERM 级联)").toBe(true);
			expect(stillRunning, "未选中的任务不受影响").toHaveLength(2);
			expect(notifyMock).toHaveBeenCalledWith(expect.stringContaining(cancelled[0].taskId), "info");
		});

		it("Esc → 不取消任何任务, 无任何通知", async () => {
			// Arrange
			const t1 = insertRunningTask(makeTaskId(1));
			const t2 = insertRunningTask(makeTaskId(2));
			const { cancelCommand } = setupExtension();
			const { ctx, captured, notifyMock } = createCustomCtx();

			// Act: 弹出选择列表 → Esc
			const handlerPromise = cancelCommand.handler("", ctx);
			await waitForCustomCalls(captured, 1);
			expect(captured, "无参数且有运行中任务时应通过 ui.custom 弹出选择列表").toHaveLength(1);
			captured[0].component.handleInput(KEY_ESC);
			await handlerPromise;
			await flushAsync();

			// Assert: Esc 后不做任何操作
			expect(t1.status, "Esc 后不应取消任何任务").toBe("running");
			expect(t2.status, "Esc 后不应取消任何任务").toBe("running");
			expect(notifyMock, "Esc 后不应有任何通知").not.toHaveBeenCalled();
		});

		it("q 键 → 不取消任何任务, 无任何通知 (与 Esc 对称)", async () => {
			// Arrange
			const t1 = insertRunningTask(makeTaskId(1));
			const t2 = insertRunningTask(makeTaskId(2));
			const { cancelCommand } = setupExtension();
			const { ctx, captured, notifyMock } = createCustomCtx();

			// Act: 弹出选择列表 → 按 q
			const handlerPromise = cancelCommand.handler("", ctx);
			await waitForCustomCalls(captured, 1);
			expect(captured, "无参数且有运行中任务时应通过 ui.custom 弹出选择列表").toHaveLength(1);
			captured[0].component.handleInput(KEY_Q);
			await handlerPromise;
			await flushAsync();

			// Assert: q 后不做任何操作 (组件 done, 任务全部保持 running, 无通知)
			expect(captured[0].done, "q 应关闭选择列表 (调用 done)").toHaveBeenCalled();
			expect(t1.status, "q 后不应取消任何任务").toBe("running");
			expect(t2.status, "q 后不应取消任何任务").toBe("running");
			expect(notifyMock, "q 后不应有任何通知").not.toHaveBeenCalled();
		});

		it("[回归锁定] 无运行中任务 → 不弹选择列表, 保持现有提示行为", async () => {
			// Arrange: 注册表为空
			const { cancelCommand } = setupExtension();
			const { ctx, customMock, notifyMock } = createCustomCtx();

			// Act
			await cancelCommand.handler("", ctx);

			// Assert: 现状即提示无任务, 不弹列表 (新行为保持不变)
			expect(customMock, "无运行中任务时不应弹选择列表").not.toHaveBeenCalled();
			expect(notifyMock).toHaveBeenCalledTimes(1);
			const [message, type] = notifyMock.mock.calls[0];
			expect(String(message)).toMatch(/no running/i);
			expect(type).toBe("warning");
		});

		it("[回归锁定] 带参数 /subagent-cancel <taskId> 仍走旧逻辑: 不弹选择列表, 直接取消", async () => {
			// Arrange
			const t1 = insertRunningTask(makeTaskId(1));
			const { cancelCommand } = setupExtension();
			const { ctx, customMock, notifyMock } = createCustomCtx();

			// Act: 带参数调用
			await cancelCommand.handler(t1.taskId, ctx);

			// Assert: 旧路径不变
			expect(customMock, "带参数时不应弹选择列表").not.toHaveBeenCalled();
			expect(t1.status).toBe("cancelled");
			expect(t1.cancelledBy).toBe("user");
			expect(notifyMock).toHaveBeenCalledWith(expect.stringContaining(t1.taskId), "info");
		});

		it("[回归锁定] /subagent-cancel-all 不变: 不弹选择列表, 取消全部运行中任务", async () => {
			// Arrange
			const t1 = insertRunningTask(makeTaskId(1));
			const t2 = insertRunningTask(makeTaskId(2));
			const t3 = insertRunningTask(makeTaskId(3));
			const { cancelAllCommand } = setupExtension();
			const { ctx, customMock, notifyMock } = createCustomCtx();

			// Act
			await cancelAllCommand.handler("", ctx);

			// Assert
			expect(customMock, "cancel-all 不应弹选择列表").not.toHaveBeenCalled();
			expect(t1.status).toBe("cancelled");
			expect(t2.status).toBe("cancelled");
			expect(t3.status).toBe("cancelled");
			expect(notifyMock).toHaveBeenCalledTimes(1);
			expect(notifyMock.mock.calls[0][1]).toBe("info");
		});

		it("[回归锁定] 非 TUI (hasUI=false) → 不弹选择列表, 回退现有提示 (列出运行中任务), 不取消任何任务", async () => {
			// Arrange
			const t1 = insertRunningTask(makeTaskId(1));
			const t2 = insertRunningTask(makeTaskId(2));
			const { cancelCommand } = setupExtension();
			const notifyMock = vi.fn();
			const customMock = vi.fn();
			const ctx = { hasUI: false, ui: { notify: notifyMock, custom: customMock } };

			// Act
			await cancelCommand.handler("", ctx);

			// Assert: 非 TUI 不弹列表, 保持现有提示行为
			expect(customMock, "非 TUI 不应调用 ui.custom").not.toHaveBeenCalled();
			expect(notifyMock).toHaveBeenCalledTimes(1);
			const [message, type] = notifyMock.mock.calls[0];
			expect(String(message)).toMatch(/no running|running tasks/i);
			expect(type).toBe("warning");
			expect(t1.status, "非 TUI 回退不应取消任何任务").toBe("running");
			expect(t2.status, "非 TUI 回退不应取消任何任务").toBe("running");
		});
	});

	// ================================================================
	// C. completedTasks 跨测试隔离验证 (reviewer 🟡-3)
	// C1 在本测试的模块实例中完成任务 9 (污染上游状态); C2 在新模块实例 +
	// 新 agentDir 下为同一 taskId 只写会话文件 (磁盘残留, 无完成记录) ——
	// 若 completedTasks 跨测试泄漏, findSessionFile 过滤会放行该记录, 导致
	// "无已完成任务"场景误弹 picker。vitest 同文件内测试顺序执行, 该测试对
	// 即为隔离机制的针对性验证。
	// ================================================================
	describe("C. completedTasks 跨测试隔离验证", () => {
		let resultCommand: any;

		beforeEach(() => {
			const setup = setupExtension();
			executeToolRef = setup.executeTool;
			dispatchCtxRef = createMockTuiCtx(defaultCwd);
			resultCommand = setup.resultCommand;
		});

		it("C1: 先完成一个任务 (本实例中 completedTasks 产生记录, picker 正常弹出)", async () => {
			// Arrange + Act: 完成任务 9 → 无参数调用应弹出含 task 9 的 picker
			const t9 = await finishTask(9);
			const { ctx, captured } = createCustomCtx();
			const handlerPromise = resultCommand.handler("", ctx);
			await waitForCustomCalls(captured, 1);

			// Assert: picker 弹出且列出 task 9 (证明污染已产生)
			expect(captured).toHaveLength(1);
			expect(captured[0].getRendered()).toContain(t9);

			// Cleanup
			captured[0].component.handleInput(KEY_ESC);
			await handlerPromise;
		});

		it("C2: 同 taskId 只有会话文件 (新目录磁盘残留) 而无完成记录 → 不弹 picker", async () => {
			// Arrange: 新模块实例 + 新 agentDir, 仅为 task 9 (C1 完成过) 与
			// task 1 (A 块测试完成过) 写会话文件 —— 磁盘上有文件, 但本实例的
			// completedTasks 为空。泄漏实现会误弹 picker; 隔离后必须不弹。
			writeFinishedSessionFile(makeTaskId(9), "RESULT-TEXT-9", 1_700_000_900_000);
			writeFinishedSessionFile(makeTaskId(1), "RESULT-TEXT-1", 1_700_000_100_000);
			const { ctx, customMock, notifyMock } = createCustomCtx();

			// Act
			await resultCommand.handler("", ctx);

			// Assert: completedTasks 隔离生效 —— 不弹列表, 提示没有已结束任务
			expect(customMock, "无完成记录时不应弹选择列表 (completedTasks 必须跨测试隔离)").not.toHaveBeenCalled();
			expect(notifyMock).toHaveBeenCalledTimes(1);
			const [message, type] = notifyMock.mock.calls[0];
			expect(String(message)).toMatch(NO_FINISHED_TASKS_PATTERN);
			expect(["info", "warning"]).toContain(type);
		});
	});
});
