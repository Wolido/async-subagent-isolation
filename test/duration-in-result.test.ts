/**
 * 子 agent 返回信息（[subagent-result] 通知）必须包含运行时长
 *
 * 背景：信封 content 已有「耗时」行，但用的是 formatElapsed(task.startedAt)
 * （"派发至今"的 MM:SS，进度 widget 专用，不改动它）。原缺口：
 * 1. SubagentResultDetails 无 durationMs → registerMessageRenderer 通知卡片不显示耗时；
 * 2. 同步模式 SingleResult 无 startedAt/finishedAt → renderResult 富渲染不显示时长；
 * 3. 取消/超时（result 为 null）路径 details 无时长；
 * 4. formatElapsed 只到秒、>99 分钟溢出（MM:SS）→ 需要毫秒级 formatDuration。
 *
 * 需求契约（本文件锁定的行为，v1.3.0 已实现，全部用例保持绿）：
 * - formatDuration(ms): <1h → "MM:SS"（如 00:05、02:34）；≥1h → "H:MM:SS"
 *   （小时不补零，如 1:05:03）；0/负数/NaN/Infinity → "00:00"。
 * - SubagentResultDetails.durationMs: number（毫秒），成功/失败/超时/取消
 *   （result 为 null 时用派发时刻起算）都必须存在且 ≥ 0。
 * - 信封 content 的「耗时」行 = formatDuration(durationMs)（真实运行时长）。
 * - registerMessageRenderer 卡片（成功/失败/超时/已取消）必须含 formatDuration 输出。
 * - renderResult 富渲染（折叠态与展开态）在 SingleResult 带 startedAt/finishedAt
 *   时显示时长；不带时不得渲染 NaN 或抛异常（回归保护）。
 *
 * 收尾轮追加（reviewer 待修项驱动，均已实现并锁定）：
 * - formatDuration 对 NaN/Infinity 的防御：钳位输出 "00:00"
 *   （原实现会输出 "NaN:NaN" / "Infinity:NaN:NaN"）；
 * - 盲区锁定：未知 agent 早退的 startedAt/finishedAt、失败/取消信封
 *   content 与 details.durationMs 一致性、hard_timeout 路径时长、富渲染 0ms、
 *   卡片 NaN/Infinity 输入回归保护。
 * 注：无效 sessionId 在 execute 层（validateSessionId 前置校验）即被拦截并返回
 * results: []，永远无法到达 runSingleAgent 的 sessionId 早退分支，故该路径不覆盖。
 */

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn } from "node:child_process";
import extension, { taskRegistry, formatDuration } from "../src/index.ts";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

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

/** Create a fake ChildProcess whose kill() is a no-op; the test ends it manually. */
function createControllableProc() {
	const proc = new EventEmitter() as any;
	proc.stdout = new EventEmitter();
	proc.stderr = new EventEmitter();
	proc.kill = vi.fn(() => true);
	proc.exitCode = null;
	proc.signalCode = null;
	return proc;
}

/** Create a fake ChildProcess that exits successfully on next microtask. */
function createSuccessfulProc() {
	const proc = new EventEmitter() as any;
	proc.stdout = new EventEmitter();
	proc.stderr = new EventEmitter();
	proc.kill = vi.fn();
	proc.exitCode = null;
	proc.signalCode = null;
	queueMicrotask(() => {
		proc.stdout.emit("end");
		proc.emit("exit", 0, null);
		proc.emit("close", 0, null);
	});
	return proc;
}

/** Manually end the process so the result promise resolves. */
function endProcess(proc: any, exitCode = 0, signal: string | null = null) {
	proc.stdout.emit("end");
	proc.emit("exit", signal ? null : exitCode, signal);
	proc.emit("close", signal ? null : exitCode, signal);
}

/** Mock pi capturing tool/command/event registrations, sendMessage and message renderers. */
function createMockPi() {
	const toolDefs: any[] = [];
	const commandDefs: Map<string, any> = new Map();
	const eventHandlers: Map<string, Function[]> = new Map();
	const sendMessageCalls: any[] = [];
	const messageRenderers: Map<string, Function> = new Map();

	return {
		registerTool: vi.fn((tool: any) => {
			toolDefs.push(tool);
		}),
		registerCommand: vi.fn((name: string, options: any) => {
			commandDefs.set(name, options);
		}),
		registerMessageRenderer: vi.fn((type: string, renderer: Function) => {
			messageRenderers.set(type, renderer);
		}),
		on: vi.fn((event: string, handler: Function) => {
			if (!eventHandlers.has(event)) eventHandlers.set(event, []);
			eventHandlers.get(event)!.push(handler);
		}),
		sendMessage: vi.fn((...args: any[]) => {
			sendMessageCalls.push(args);
		}),
		// Test helpers
		_toolDefs: toolDefs,
		_commandDefs: commandDefs,
		_eventHandlers: eventHandlers,
		_sendMessageCalls: sendMessageCalls,
		_messageRenderers: messageRenderers,
	};
}

/** Mock ctx for TUI mode. */
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

/** Mock ctx for non-TUI (sync) mode. */
function createMockNonTuiCtx(cwd: string, mode?: "print" | "rpc" | "json") {
	return {
		cwd,
		hasUI: false,
		mode,
	};
}

/** Race execute() against a real-timer timeout (fake timers are active in flow tests). */
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

/** Plain-text theme: every color fn returns the text unchanged. */
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

// ================================================================
// 1. formatDuration 单元测试（纯函数，直接精确断言）
// ================================================================
describe("formatDuration 单元测试", () => {
	it("5000ms → 00:05（不足 1 分钟补零到 MM:SS）", () => {
		expect(formatDuration(5000)).toBe("00:05");
	});

	it("154000ms → 02:34（2 分 34 秒）", () => {
		expect(formatDuration(154_000)).toBe("02:34");
	});

	it("3903000ms → 1:05:03（≥1 小时，小时不补零）", () => {
		expect(formatDuration(3_903_000)).toBe("1:05:03");
	});

	it("0ms → 00:00", () => {
		expect(formatDuration(0)).toBe("00:00");
	});

	it("负数 → 00:00（钳位到 0）", () => {
		expect(formatDuration(-5000)).toBe("00:00");
	});

	it("恰好 1 小时（3600000ms）→ 1:00:00", () => {
		expect(formatDuration(3_600_000)).toBe("1:00:00");
	});

	it("恰好 1 分钟（60000ms）→ 01:00", () => {
		expect(formatDuration(60_000)).toBe("01:00");
	});

	it("差 1ms 到 1 分钟（59999ms）→ 00:59（毫秒截断而非四舍五入）", () => {
		expect(formatDuration(59_999)).toBe("00:59");
	});

	it("差 1ms 到 1 小时（3599999ms）→ 59:59（仍是 MM:SS，小时不补零边界）", () => {
		expect(formatDuration(3_599_999)).toBe("59:59");
	});

	it("100 分钟（6000000ms）→ 1:40:00（修复 formatElapsed 的 >99 分钟溢出）", () => {
		expect(formatDuration(6_000_000)).toBe("1:40:00");
	});

	// —— 绿（锁定）：NaN/Infinity → "00:00" 防御。契约已由 formatDuration 入口的
	// Number.isFinite 守卫实现（src/index.ts:618），非有限输入直接钳位返回 "00:00"。
	it("NaN → 00:00（非数值输入防御）", () => {
		expect(formatDuration(NaN)).toBe("00:00");
	});

	it("Infinity → 00:00（无限大输入防御）", () => {
		expect(formatDuration(Infinity)).toBe("00:00");
	});
});

// ================================================================
// 2-4. 信封与同步结果时长：需要完整子进程流程的测试
// ================================================================
describe("子 agent 返回时长 — 全流程（信封 + 同步结果）", () => {
	let tmpBase: string;
	let agentDir: string;
	let defaultCwd: string;
	let savedEnv: Record<string, string | undefined>;
	let procRef: ReturnType<typeof createControllableProc> | null;

	beforeEach(() => {
		vi.useFakeTimers();
		taskRegistry.clear();

		tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "subagent-duration-test-"));
		agentDir = path.join(tmpBase, "agent-dir");
		defaultCwd = path.join(tmpBase, "default-cwd");
		fs.mkdirSync(path.join(defaultCwd, ".pi", "agents"), { recursive: true });
		fs.mkdirSync(agentDir, { recursive: true });
		vi.mocked(getAgentDir).mockReturnValue(agentDir);

		fs.writeFileSync(
			path.join(defaultCwd, ".pi", "agents", "tester.md"),
			`---\nname: tester\ndescription: Test agent\n---\n`,
			"utf-8",
		);

		procRef = null;
		vi.mocked(spawn).mockImplementation((() => {
			procRef = createControllableProc();
			return procRef;
		}) as any);

		savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
		process.env.PI_SUBAGENT_DEPTH = "0";
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
		const executeTool = pi._toolDefs[0].execute as ExecuteFn;
		return { pi, executeTool };
	}

	/** TUI 异步派发并等待回执返回（子进程已 spawn，仍未退出）。 */
	async function dispatchTuiTask(executeTool: ExecuteFn, sessionId: string) {
		const ctx = createMockTuiCtx(defaultCwd);
		const executePromise = executeTool(
			"call-1",
			{ agent: "tester", task: "test task", sessionId },
			undefined,
			undefined,
			ctx,
		);
		const { timedOut } = await raceWithTimeout(executePromise, 200);
		expect(timedOut, "TUI 模式 execute 应立即返回回执（既有行为）").toBe(false);
		expect(procRef, "子进程应已 spawn").not.toBeNull();
		return ctx;
	}

	/** 模拟子进程产生一条 assistant 最终输出。 */
	async function emitFinalOutput(text = "子 agent 结果文本") {
		procRef!.stdout.emit(
			"data",
			Buffer.from(
				JSON.stringify({
					type: "message_end",
					message: {
						role: "assistant",
						content: [{ type: "text", text }],
						stopReason: "end_turn",
						usage: { input: 10, output: 5, totalTokens: 15 },
					},
				}) + "\n",
			),
		);
		await vi.advanceTimersByTimeAsync(0);
	}

	// ================================================================
	// 2. 信封成功路径
	// ================================================================
	describe("信封成功路径", () => {
		it("成功信封 details.durationMs 为有限 number 且 ≥ 0，content 含「耗时: 」行", async () => {
			const { pi, executeTool } = setupExtension();
			await dispatchTuiTask(executeTool, "019ffdd3-3eb5-733d-b481-a53e5292bd21");

			await emitFinalOutput();
			endProcess(procRef!, 0);
			await vi.advanceTimersByTimeAsync(1000);

			expect(pi.sendMessage).toHaveBeenCalled();
			const [message] = pi._sendMessageCalls[0];
			expect(message.customType).toBe("subagent-result");
			expect(message.details.status).toBe("成功");

			// 既有行为：content 含「耗时: 」行（当前即绿，行格式不变）
			expect(message.content).toContain("耗时: ");

			// 新行为：结构化 details 携带运行时长
			expect(typeof message.details.durationMs).toBe("number");
			expect(Number.isFinite(message.details.durationMs)).toBe(true);
			expect(message.details.durationMs).toBeGreaterThanOrEqual(0);
		});

		it("成功信封「耗时」行文本应等于 formatDuration(details.durationMs)（真实运行时长）", async () => {
			const { pi, executeTool } = setupExtension();
			await dispatchTuiTask(executeTool, "019ffdd3-3eb5-733d-b481-a53e5292bd22");

			await emitFinalOutput();
			endProcess(procRef!, 0);
			await vi.advanceTimersByTimeAsync(1000);

			expect(pi.sendMessage).toHaveBeenCalled();
			const [message] = pi._sendMessageCalls[0];

			// 「耗时」行展示的必须是 formatDuration(durationMs) 的输出，
			// 即与结构化字段一致的真实运行时长（而非"派发至今"的别的值）。
			const expected = formatDuration(message.details.durationMs);
			expect(message.content).toContain(`耗时: ${expected}`);
		});
	});

	// ================================================================
	// 3. 信封失败/超时/取消路径
	// ================================================================
	describe("信封失败/超时/取消路径", () => {
		it("失败信封（exitCode≠0）details.durationMs 存在且为 ≥ 0 的有限 number", async () => {
			const { pi, executeTool } = setupExtension();
			await dispatchTuiTask(executeTool, "019ffdd3-3eb5-733d-b481-a53e5292bd23");

			procRef!.stderr.emit("data", Buffer.from("error: something went wrong\n"));
			await vi.advanceTimersByTimeAsync(0);
			endProcess(procRef!, 1);
			await vi.advanceTimersByTimeAsync(1000);

			expect(pi.sendMessage).toHaveBeenCalled();
			const [message] = pi._sendMessageCalls[0];
			expect(message.details.status).toBe("失败");

			expect(typeof message.details.durationMs).toBe("number");
			expect(Number.isFinite(message.details.durationMs)).toBe(true);
			expect(message.details.durationMs).toBeGreaterThanOrEqual(0);
		});

		it("超时信封（活动超时）details.durationMs 存在且为 ≥ 0 的有限 number", async () => {
			process.env.PI_SUBAGENT_ACTIVITY_TIMEOUT_MS = "1000";
			const { pi, executeTool } = setupExtension();
			await dispatchTuiTask(executeTool, "019ffdd3-3eb5-733d-b481-a53e5292bd24");

			// 产生一次活动以启动活动计时器，然后静默至超时
			procRef!.stdout.emit("data", Buffer.from('{"type":"turn_start"}\n'));
			await vi.advanceTimersByTimeAsync(0);
			await vi.advanceTimersByTimeAsync(1500);

			expect(pi.sendMessage).toHaveBeenCalled();
			const [message] = pi._sendMessageCalls[0];
			expect(message.details.status).toBe("超时");

			expect(typeof message.details.durationMs).toBe("number");
			expect(Number.isFinite(message.details.durationMs)).toBe(true);
			expect(message.details.durationMs).toBeGreaterThanOrEqual(0);
		});

		it("取消信封（result 为 null）details.durationMs 存在且为 ≥ 0 的有限 number", async () => {
			const { pi, executeTool } = setupExtension();
			const ctx = await dispatchTuiTask(executeTool, "019ffdd3-3eb5-733d-b481-a53e5292bd25");

			// 用户经 /subagent-cancel 取消 → abort 级联 → runSingleAgent reject（result null）
			const cancelCommand = pi._commandDefs.get("subagent-cancel");
			expect(cancelCommand).toBeDefined();
			await cancelCommand.handler("019ffdd3-3eb5-733d-b481-a53e5292bd25", ctx);

			endProcess(procRef!, null, "SIGTERM");
			await vi.advanceTimersByTimeAsync(1000);

			expect(pi.sendMessage).toHaveBeenCalled();
			const [message] = pi._sendMessageCalls[0];
			expect(message.details.status).toBe("已取消");

			// result 为 null 时也应有时长（自派发时刻起算）
			expect(typeof message.details.durationMs).toBe("number");
			expect(Number.isFinite(message.details.durationMs)).toBe(true);
			expect(message.details.durationMs).toBeGreaterThanOrEqual(0);
		});

		// —— 绿（锁定）：失败信封 content 的「耗时」行必须与结构化 details.durationMs 一致
		it("失败信封「耗时」行文本应等于 formatDuration(details.durationMs)（content 与结构化字段一致）", async () => {
			const { pi, executeTool } = setupExtension();
			await dispatchTuiTask(executeTool, "019ffdd3-3eb5-733d-b481-a53e5292bd27");

			procRef!.stderr.emit("data", Buffer.from("error: something went wrong\n"));
			await vi.advanceTimersByTimeAsync(0);
			endProcess(procRef!, 1);
			await vi.advanceTimersByTimeAsync(1000);

			expect(pi.sendMessage).toHaveBeenCalled();
			const [message] = pi._sendMessageCalls[0];
			expect(message.details.status).toBe("失败");

			// 「耗时」行展示的必须是 formatDuration(durationMs) 的输出，不得与结构化字段分叉
			const expected = formatDuration(message.details.durationMs);
			expect(message.content).toContain(`耗时: ${expected}`);
		});

		// —— 绿（锁定）：取消信封（result 为 null）content 的「耗时」行与 details.durationMs 一致
		it("取消信封（result 为 null）「耗时」行文本应等于 formatDuration(details.durationMs) 且 durationMs ≥ 0", async () => {
			const { pi, executeTool } = setupExtension();
			const ctx = await dispatchTuiTask(executeTool, "019ffdd3-3eb5-733d-b481-a53e5292bd28");

			// 用户经 /subagent-cancel 取消 → abort 级联 → runSingleAgent reject（result null）
			const cancelCommand = pi._commandDefs.get("subagent-cancel");
			expect(cancelCommand).toBeDefined();
			await cancelCommand.handler("019ffdd3-3eb5-733d-b481-a53e5292bd28", ctx);

			endProcess(procRef!, null, "SIGTERM");
			await vi.advanceTimersByTimeAsync(1000);

			expect(pi.sendMessage).toHaveBeenCalled();
			const [message] = pi._sendMessageCalls[0];
			expect(message.details.status).toBe("已取消");

			// result 为 null 时时长自派发时刻（task.startedAt）起算，仍为非负有限值
			expect(message.details.durationMs).toBeGreaterThanOrEqual(0);
			const expected = formatDuration(message.details.durationMs);
			expect(message.content).toContain(`耗时: ${expected}`);
		});

		// —— 绿（锁定）：hard_timeout 路径的信封也携带真实时长
		// （构造方式参考 technical-debt.test.ts：PI_SUBAGENT_HARD_TIMEOUT_MS + 可控 proc）
		it("硬超时信封（PI_SUBAGENT_HARD_TIMEOUT_MS 触发）details.durationMs 为有限 number 且 ≥ 0", async () => {
			process.env.PI_SUBAGENT_HARD_TIMEOUT_MS = "1000";
			const { pi, executeTool } = setupExtension();
			const ctx = createMockTuiCtx(defaultCwd);

			// 全程 fake timers 派发（不经 raceWithTimeout 的真实计时器窗口）：
			// 硬计时器在 spawn 后的 promise executor 中只武装一次，必须落在 fake
			// 时钟上，后续 advanceTimersByTimeAsync 才能触发；spawn 链的真实 fs
			// （writePromptToTempFile）经 0ms 异步推进完成（同 technical-debt.test.ts
			// 的 runSubagent + advanceTimersByTimeAsync(0) 模式）。
			const executePromise = executeTool(
				"call-1",
				{ agent: "tester", task: "test task", sessionId: "019ffdd3-3eb5-733d-b481-a53e5292bd29" },
				undefined,
				undefined,
				ctx,
			);
			await vi.advanceTimersByTimeAsync(0);
			await executePromise; // TUI 回执（既有行为，已由 dispatchTuiTask 各用例覆盖，不重复断言）
			expect(procRef, "子进程应已 spawn").not.toBeNull();

			// 产生一次活动后保持静默；硬计时器独立于活动计时器，T=1000 触发
			// SIGKILL + finalize(1)（默认活动超时 600s，不会抢先触发）
			procRef!.stdout.emit("data", Buffer.from('{"type":"turn_start"}\n'));
			await vi.advanceTimersByTimeAsync(0);
			await vi.advanceTimersByTimeAsync(1500);

			expect(pi.sendMessage).toHaveBeenCalled();
			const [message] = pi._sendMessageCalls[0];
			// 确认走的是硬超时路径（区别于活动超时信封用例）
			expect(message.details.stopReason).toBe("hard_timeout");
			expect(message.details.status).toBe("超时");

			expect(typeof message.details.durationMs).toBe("number");
			expect(Number.isFinite(message.details.durationMs)).toBe(true);
			expect(message.details.durationMs).toBeGreaterThanOrEqual(0);
		});
	});

	// ================================================================
	// 4. 同步模式：SingleResult 携带 startedAt/finishedAt
	// ================================================================
	describe("同步模式 SingleResult 时长字段", () => {
		it("非 TUI 同步执行返回的 results[0] 含 startedAt/finishedAt（number 且 finishedAt ≥ startedAt）", async () => {
			vi.mocked(spawn).mockImplementation((() => createSuccessfulProc()) as any);

			const { executeTool } = setupExtension();
			const ctx = createMockNonTuiCtx(defaultCwd);

			const result = await executeTool(
				"call-1",
				{ agent: "tester", task: "test task", sessionId: "019ffdd3-3eb5-733d-b481-a53e5292bd26" },
				undefined,
				undefined,
				ctx,
			);

			// 同步路径：details.results 长度 1（既有行为）
			expect(result.details?.results?.length).toBe(1);
			const single = result.details.results[0];

			// 新行为：SingleResult 携带进程实际启动/结束时刻，供 renderResult 计算时长
			expect(typeof single.startedAt).toBe("number");
			expect(typeof single.finishedAt).toBe("number");
			expect(Number.isFinite(single.startedAt)).toBe(true);
			expect(Number.isFinite(single.finishedAt)).toBe(true);
			expect(single.finishedAt).toBeGreaterThanOrEqual(single.startedAt);
		});

		// —— 绿（锁定）：runSingleAgent 未知 agent 早退分支也携带时间戳（真实运行时长 ≈ 0）。
		// 注：无效 sessionId 在 execute 层（validateSessionId 前置校验）即被拦截并返回
		// results: []，无法到达 runSingleAgent 的 sessionId 早退分支，故该路径不覆盖。
		it("未知 agent 早退路径：results[0] 的 startedAt/finishedAt 为有限 number 且 finishedAt ≥ startedAt", async () => {
			const { executeTool } = setupExtension();
			const ctx = createMockNonTuiCtx(defaultCwd);

			const result = await executeTool(
				"call-1",
				{ agent: "no-such-agent", task: "test task", sessionId: "019ffdd3-3eb5-733d-b481-a53e5292bd2a" },
				undefined,
				undefined,
				ctx,
			);

			// 既有行为：未知 agent 早退为错误结果，details.results 长度 1，且不 spawn 子进程
			expect(result.isError).toBe(true);
			expect(result.details?.results?.length).toBe(1);
			expect(spawn).not.toHaveBeenCalled();
			const single = result.details.results[0];

			// 锁定：早退分支同样携带 startedAt/finishedAt（供 renderResult 计算时长）
			expect(typeof single.startedAt).toBe("number");
			expect(typeof single.finishedAt).toBe("number");
			expect(Number.isFinite(single.startedAt)).toBe(true);
			expect(Number.isFinite(single.finishedAt)).toBe(true);
			expect(single.finishedAt).toBeGreaterThanOrEqual(single.startedAt);
		});
	});
});

// ================================================================
// 5. registerMessageRenderer 通知卡片耗时
// ================================================================
describe("registerMessageRenderer 通知卡片耗时", () => {
	let pi: ReturnType<typeof createMockPi>;

	beforeEach(() => {
		pi = createMockPi();
		extension(pi as any);
	});

	/** 构造 SubagentResultDetails 形状的消息 details。 */
	function makeDetails(overrides: Record<string, any> = {}): any {
		return {
			taskId: "task-card-1",
			agent: "tester",
			status: "成功",
			exitCode: 0,
			usage: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 1 },
			sessionId: "sess-card-1",
			output: "done",
			...overrides,
		};
	}

	/** 经注册的 subagent-result 渲染器渲染卡片，返回纯文本。 */
	function renderCard(details: any): string {
		const renderer = pi._messageRenderers.get("subagent-result");
		expect(renderer, "subagent-result message renderer should be registered").toBeDefined();
		const component = renderer!(
			{ content: "(envelope content)", details },
			{},
			createMockTheme(),
		);
		return component.render(80).join("\n");
	}

	it("成功卡片含 formatDuration 输出（durationMs=154000 → 02:34）", () => {
		const text = renderCard(makeDetails({ status: "成功", durationMs: 154_000 }));
		expect(text).toContain("02:34");
	});

	it("失败卡片含 formatDuration 输出（durationMs=5000 → 00:05）", () => {
		const text = renderCard(makeDetails({ status: "失败", exitCode: 1, durationMs: 5_000 }));
		expect(text).toContain("00:05");
	});

	it("超时卡片含 formatDuration 输出（durationMs=65000 → 01:05）", () => {
		const text = renderCard(makeDetails({ status: "超时", exitCode: null, durationMs: 65_000 }));
		expect(text).toContain("01:05");
	});

	it("已取消卡片含 formatDuration 输出（durationMs=3000 → 00:03）", () => {
		const text = renderCard(makeDetails({ status: "已取消", exitCode: null, durationMs: 3_000 }));
		expect(text).toContain("00:03");
	});

	it("durationMs=0 时卡片仍显示 00:00（0 是合法时长，不得被 falsy 判断吞掉）", () => {
		const text = renderCard(makeDetails({ durationMs: 0 }));
		expect(text).toContain("00:00");
	});

	it("旧形状 details（无 durationMs）渲染不抛异常、无 NaN/undefined 文本（回归保护，当前即绿）", () => {
		const details = makeDetails();
		delete details.durationMs;

		const render = () => renderCard(details);
		expect(render).not.toThrow();

		const text = render();
		expect(text).toContain("tester"); // 卡片仍正常渲染
		expect(text).not.toContain("NaN");
		expect(text).not.toContain("undefined");
	});

	// —— 绿（回归保护）：durationMs 为 NaN/Infinity 时 Number.isFinite 守卫省略耗时，
	// 卡片不抛异常、不渲染非数值文本（即使 formatDuration 补了防御，守卫仍不可移除）
	it("durationMs 为 NaN 时卡片渲染不抛异常、输出不含 NaN 文本（当前即绿）", () => {
		const details = makeDetails({ durationMs: NaN });

		const render = () => renderCard(details);
		expect(render).not.toThrow();

		const text = render();
		expect(text).toContain("tester"); // 卡片仍正常渲染
		expect(text).not.toContain("NaN");
	});

	it("durationMs 为 Infinity 时卡片渲染不抛异常、输出不含 NaN/Infinity 文本（当前即绿）", () => {
		const details = makeDetails({ durationMs: Infinity });

		const render = () => renderCard(details);
		expect(render).not.toThrow();

		const text = render();
		expect(text).toContain("tester"); // 卡片仍正常渲染
		expect(text).not.toContain("NaN");
		expect(text).not.toContain("Infinity");
	});
});

// ================================================================
// 6. renderResult 富渲染时长（同步模式，details.results 长度 1）
// ================================================================
describe("renderResult 富渲染时长", () => {
	let renderResult: any;
	let mockTheme: ReturnType<typeof createMockTheme>;
	const context = { lastComponent: undefined };

	beforeEach(() => {
		const pi = createMockPi();
		extension(pi as any);
		const subagent = pi._toolDefs.find((t: any) => t.name === "subagent");
		expect(subagent, "subagent tool should be registered").toBeDefined();
		renderResult = subagent.renderResult;
		mockTheme = createMockTheme();
	});

	/** 构造单结果 details（复用 render-result.test.ts 的 singleResultDetails 模式）。 */
	function singleResultDetails(overrides: Record<string, any> = {}): any {
		return {
			mode: "single",
			agentScope: "both",
			projectAgentsDir: null,
			results: [
				{
					agent: "coder",
					agentSource: "project",
					task: "补测试契约",
					exitCode: 0,
					messages: [{ role: "assistant", content: [{ type: "text", text: "任务完成" }] }],
					stderr: "",
					usage: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 1 },
					phase: "idle",
					lastPhaseChange: 0,
					sessionId: "rich-render-session",
					...overrides,
				},
			],
		};
	}

	it("折叠态：SingleResult 带 startedAt/finishedAt（差 5000ms）时输出含 00:05", () => {
		const now = Date.now();
		const result = {
			content: [{ type: "text", text: "任务完成" }],
			details: singleResultDetails({ startedAt: now - 5_000, finishedAt: now }),
		};

		const text = renderResult(result, { expanded: false }, mockTheme, context).render(80).join("\n");

		expect(text).toContain("00:05");
	});

	it("展开态：SingleResult 带 startedAt/finishedAt（差 5000ms）时输出含 00:05", () => {
		const now = Date.now();
		const result = {
			content: [{ type: "text", text: "任务完成" }],
			details: singleResultDetails({ startedAt: now - 5_000, finishedAt: now }),
		};

		const text = renderResult(result, { expanded: true }, mockTheme, context).render(80).join("\n");

		expect(text).toContain("00:05");
	});

	it("SingleResult 不带 startedAt/finishedAt 时不得渲染 NaN 或抛异常（回归保护，当前即绿）", () => {
		const result = {
			content: [{ type: "text", text: "任务完成" }],
			details: singleResultDetails(),
		};

		const renderCollapsed = () => renderResult(result, { expanded: false }, mockTheme, context);
		expect(renderCollapsed).not.toThrow();
		const collapsedText = renderCollapsed().render(80).join("\n");
		expect(collapsedText).toContain("coder"); // 富渲染分支仍正常
		expect(collapsedText).not.toContain("NaN");
		expect(collapsedText).not.toContain("undefined");

		const renderExpanded = () => renderResult(result, { expanded: true }, mockTheme, context);
		expect(renderExpanded).not.toThrow();
		const expandedText = renderExpanded().render(80).join("\n");
		expect(expandedText).toContain("coder");
		expect(expandedText).not.toContain("NaN");
		expect(expandedText).not.toContain("undefined");
	});

	// —— 绿（锁定）：startedAt === finishedAt 的 0ms 运行，时长应渲染为 00:00
	// （守卫用 Number.isFinite 而非 falsy 判断，0 差值不得被吞掉）
	it("折叠态：startedAt === finishedAt（0ms 运行）时输出含 00:00", () => {
		const now = Date.now();
		const result = {
			content: [{ type: "text", text: "任务完成" }],
			details: singleResultDetails({ startedAt: now, finishedAt: now }),
		};

		const text = renderResult(result, { expanded: false }, mockTheme, context).render(80).join("\n");

		expect(text).toContain("00:00");
	});

	it("展开态：startedAt === finishedAt（0ms 运行）时输出含 00:00", () => {
		const now = Date.now();
		const result = {
			content: [{ type: "text", text: "任务完成" }],
			details: singleResultDetails({ startedAt: now, finishedAt: now }),
		};

		const text = renderResult(result, { expanded: true }, mockTheme, context).render(80).join("\n");

		expect(text).toContain("00:00");
	});
});
