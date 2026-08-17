/**
 * TDD 红阶段测试：异步化改造（async-mode）
 *
 * 本文件验证 8 项设计决策所描述的新行为。当前 src/index.ts 尚未实现，
 * 因此这些测试应该全部失败（红阶段），失败原因对应尚未实现的行为。
 *
 * 设计决策覆盖：
 * 1. TUI 模式异步派发（ctx.mode === "tui" → execute 立即返回回执）
 * 2. taskId = sessionId（uuidv7 生成或复用）
 * 3. 信封格式与状态词（sendMessage → subagent-result 信封）
 * 4. 任务描述截断（>200 字截断）
 * 5. 深度限制（MAX_SUBAGENT_DEPTH=1，无 canDelegate 概念）
 * 6. /subagent-cancel 命令（用户取消 → SIGTERM → 5s → SIGKILL → 已取消通知）
 * 7. session_shutdown 处理器（遍历注册表 kill 所有在飞子进程）
 * 8. 非 TUI 模式降级同步（与现状完全一致）
 */

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn } from "node:child_process";
import extension, { taskRegistry } from "../src/index.ts";
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

const SESSION_ID = "019ffdd3-3eb5-733d-b481-a53e5292bd01";
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

/**
 * Create a fake ChildProcess whose kill() is a no-op.
 * The process stays alive until manually terminated by the test.
 */
function createControllableProc() {
	const proc = new EventEmitter() as any;
	proc.stdout = new EventEmitter();
	proc.stderr = new EventEmitter();
	proc.kill = vi.fn(() => true); // no-op: does NOT auto-exit
	proc.exitCode = null;
	proc.signalCode = null;
	return proc;
}

/**
 * Create a fake ChildProcess that exits successfully on next microtask.
 */
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

/**
 * Helper: manually end the process so the result promise resolves.
 */
function endProcess(proc: any, exitCode = 0, signal: string | null = null) {
	proc.stdout.emit("end");
	proc.emit("exit", signal ? null : exitCode, signal);
	proc.emit("close", signal ? null : exitCode, signal);
}

/**
 * Build a mock pi object that captures all registration calls.
 */
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
	};
}

/**
 * Create a mock ctx with proper structure for TUI mode.
 */
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

/**
 * Create a mock ctx for non-TUI mode.
 */
function createMockNonTuiCtx(cwd: string, mode?: "print" | "rpc" | "json") {
	return {
		cwd,
		hasUI: false,
		mode,
	};
}

/**
 * Helper: race execute() against a timeout to detect immediate returns.
 * Returns { result, timedOut } to indicate which won the race.
 * Uses real timers to avoid interference with fake timers.
 */
async function raceWithTimeout<T>(promise: Promise<T>, timeoutMs = 200): Promise<{ result: T | null; timedOut: boolean }> {
	// Temporarily use real timers for this timeout
	vi.useRealTimers();
	try {
		const timeout = new Promise<null>((resolve) => setTimeout(() => resolve(null), timeoutMs));
		const result = await Promise.race([promise, timeout]);
		return { result, timedOut: result === null };
	} finally {
		// Restore fake timers
		vi.useFakeTimers();
	}
}

describe("异步化改造 - TDD 红阶段", () => {
	let tmpBase: string;
	let agentDir: string;
	let defaultCwd: string;
	let savedEnv: Record<string, string | undefined>;
	let procRef: ReturnType<typeof createControllableProc> | null;

	beforeEach(() => {
		vi.useFakeTimers();

		// Clear the module-level taskRegistry to prevent cross-test leakage:
		// an in-flight task left over from a previous test would now (B1 guard)
		// block re-dispatching the same sessionId.
		taskRegistry.clear();

		tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "async-subagent-isolation-async-test-"));
		agentDir = path.join(tmpBase, "agent-dir");
		defaultCwd = path.join(tmpBase, "default-cwd");
		fs.mkdirSync(path.join(defaultCwd, ".pi", "agents"), { recursive: true });
		fs.mkdirSync(agentDir, { recursive: true });
		vi.mocked(getAgentDir).mockReturnValue(agentDir);

		// Write a test agent
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

	// ================================================================
	// 设计决策 1：TUI 模式异步派发
	// ================================================================
	describe("设计决策 1：TUI 模式异步派发", () => {
		it("TUI 模式下 execute 立即返回回执（子进程不 emit 任何事件时 execute 已 resolve）", async () => {
			const { executeTool } = setupExtension();
			const ctx = createMockTuiCtx(defaultCwd);

			const executePromise = executeTool(
				"call-1",
				{ agent: "tester", task: "test task", sessionId: SESSION_ID },
				undefined,
				undefined,
				ctx,
			);

			const { result, timedOut } = await raceWithTimeout(executePromise, 200);

			// 红阶段：会超时（当前实现等待子进程）
			// 绿阶段：立即返回回执
			expect(timedOut).toBe(false);
			expect(result).not.toBeNull();

			const text = result!.content[0].text;
			// 回执文本应包含"已派出"或"dispatched"语义
			expect(text).toMatch(/已派出|dispatched|queued|started/i);

			// 回执应包含 taskId（sessionId）
			expect(text).toContain(SESSION_ID);

			// 子进程不应有结果输出被返回
			expect(text).not.toContain("[subagent session:");
		});

		it("TUI 模式回执的 taskId 等于 sessionId（uuidv7 生成或复用）", async () => {
			const { executeTool } = setupExtension();
			const ctx = createMockTuiCtx(defaultCwd);

			const executePromise = executeTool(
				"call-1",
				{ agent: "tester", task: "test task", sessionId: SESSION_ID },
				undefined,
				undefined,
				ctx,
			);

			const { result, timedOut } = await raceWithTimeout(executePromise, 200);

			expect(timedOut).toBe(false);
			expect(result).not.toBeNull();

			// taskId 应与传入的 sessionId 一致
			expect(result!.content[0].text).toContain(SESSION_ID);
		});

		it("TUI 模式回执不 await 子进程（即使子进程永远不退出）", async () => {
			const { executeTool } = setupExtension();
			const ctx = createMockTuiCtx(defaultCwd);
			// procRef 是 controllable：不 emit 任何事件

			const executePromise = executeTool(
				"call-1",
				{ agent: "tester", task: "test task", sessionId: SESSION_ID },
				undefined,
				undefined,
				ctx,
			);

			const { result, timedOut } = await raceWithTimeout(executePromise, 200);

			// 红阶段：会超时
			// 绿阶段：立即返回回执文本
			expect(timedOut).toBe(false);
			expect(result).not.toBeNull();
			expect(result!.content[0].text).toMatch(/已派出|dispatched|queued|started/i);
		});
	});

	// ================================================================
	// 设计决策 3：信封格式与 sendMessage 调用
	// ================================================================
	describe("设计决策 3：信封格式与 sendMessage 调用", () => {
		it("子进程成功退出后调用 pi.sendMessage 推送 [subagent-result] 信封", async () => {
			const { pi, executeTool } = setupExtension();
			const ctx = createMockTuiCtx(defaultCwd);

			// 派发任务（红阶段会超时，所以先检查是否立即返回）
			const executePromise = executeTool(
				"call-1",
				{ agent: "tester", task: "test task", sessionId: SESSION_ID },
				undefined,
				undefined,
				ctx,
			);

			const { result, timedOut } = await raceWithTimeout(executePromise, 200);
			
			// 红阶段：会超时，因为 execute 等待子进程
			// 绿阶段：立即返回回执
			if (timedOut) {
				// 红阶段预期：抛出错误说明 sendMessage 尚未实现
				throw new Error("Red phase: execute() did not return immediately in TUI mode, sendMessage not yet implemented");
			}

			// 绿阶段：模拟子进程成功退出
			procRef!.stdout.emit(
				"data",
				Buffer.from(
					JSON.stringify({
						type: "message_end",
						message: {
							role: "assistant",
							content: [{ type: "text", text: "子 agent 完整结果文本" }],
							stopReason: "end_turn",
							usage: { input: 10, output: 5, totalTokens: 15 },
						},
					}) + "\n",
				),
			);
			await vi.advanceTimersByTimeAsync(0);

			endProcess(procRef!, 0);
			await vi.advanceTimersByTimeAsync(1000);

			// 验证 sendMessage 被调用
			expect(pi.sendMessage).toHaveBeenCalled();
			const [message, options] = pi._sendMessageCalls[0];

			// customType
			expect(message.customType).toBe("subagent-result");

			// deliverAs 和 triggerTurn
			// 契约迁移（S1 通知滞后修复）：deliverAs 由 "followUp"（等整个 agent run 结束
			// 才送达，导致 [subagent-result] 通知滞后）改为 "steer"（当前 assistant turn
			// 的工具调用执行完后、下一次 LLM 调用前送达）；triggerTurn: true 保留。
			// 当前实现仍为 "followUp"，本断言在实现完成前 RED。
			expect(options.deliverAs).toBe("steer");
			expect(options.triggerTurn).toBe(true);

			// content 包含 [subagent-result] 前缀
			expect(message.content).toContain("[subagent-result]");

			// content 包含状态行
			expect(message.content).toContain("成功");
			expect(message.content).toContain("状态:");
		});

		it("子进程失败后信封状态=失败", async () => {
			const { pi, executeTool } = setupExtension();
			const ctx = createMockTuiCtx(defaultCwd);

			const executePromise = executeTool(
				"call-1",
				{ agent: "tester", task: "test task", sessionId: SESSION_ID },
				undefined,
				undefined,
				ctx,
			);

			const { timedOut } = await raceWithTimeout(executePromise, 200);
			
			if (timedOut) {
				throw new Error("Red phase: execute() did not return immediately, sendMessage not yet implemented");
			}

			procRef!.stderr.emit("data", Buffer.from("error: something went wrong\n"));
			await vi.advanceTimersByTimeAsync(0);

			endProcess(procRef!, 1);
			await vi.advanceTimersByTimeAsync(1000);

			expect(pi.sendMessage).toHaveBeenCalled();
			const [message] = pi._sendMessageCalls[0];
			expect(message.content).toContain("失败");
		});

		it("活动超时后信封状态=超时", async () => {
			const { pi, executeTool } = setupExtension();
			const ctx = createMockTuiCtx(defaultCwd);
			process.env.PI_SUBAGENT_ACTIVITY_TIMEOUT_MS = "1000";

			const executePromise = executeTool(
				"call-1",
				{ agent: "tester", task: "test task", sessionId: SESSION_ID },
				undefined,
				undefined,
				ctx,
			);

			const { timedOut } = await raceWithTimeout(executePromise, 200);
			
			if (timedOut) {
				throw new Error("Red phase: execute() did not return immediately, sendMessage not yet implemented");
			}

			// Emit initial activity to arm the timer
			procRef!.stdout.emit("data", Buffer.from('{"type":"turn_start"}\n'));
			await vi.advanceTimersByTimeAsync(0);

			// Wait for activity timeout
			await vi.advanceTimersByTimeAsync(1500);

			expect(pi.sendMessage).toHaveBeenCalled();
			const [message] = pi._sendMessageCalls[0];
			expect(message.content).toContain("超时");
		});

		it("信封 details 携带结构化数据", async () => {
			const { pi, executeTool } = setupExtension();
			const ctx = createMockTuiCtx(defaultCwd);

			const executePromise = executeTool(
				"call-1",
				{ agent: "tester", task: "test task", sessionId: SESSION_ID },
				undefined,
				undefined,
				ctx,
			);

			const { timedOut } = await raceWithTimeout(executePromise, 200);
			
			if (timedOut) {
				throw new Error("Red phase: execute() did not return immediately, sendMessage not yet implemented");
			}

			procRef!.stdout.emit(
				"data",
				Buffer.from(
					JSON.stringify({
						type: "message_end",
						message: {
							role: "assistant",
							content: [{ type: "text", text: "结果" }],
							stopReason: "end_turn",
							usage: { input: 10, output: 5, totalTokens: 15 },
						},
					}) + "\n",
				),
			);
			await vi.advanceTimersByTimeAsync(0);
			endProcess(procRef!, 0);
			await vi.advanceTimersByTimeAsync(1000);

			expect(pi.sendMessage).toHaveBeenCalled();
			const [message] = pi._sendMessageCalls[0];
			expect(message.details).toBeDefined();
			expect(message.details.taskId).toBe(SESSION_ID);
			expect(message.details.agent).toBe("tester");
			expect(message.details.status).toBe("成功");
			expect(message.details.sessionId).toBe(SESSION_ID);
		});
	});

	// ================================================================
	// 设计决策 4：任务描述截断
	// ================================================================
	describe("设计决策 4：任务描述截断", () => {
		it("任务描述 > 200 字 → 信封「任务」行被截断", async () => {
			const { pi, executeTool } = setupExtension();
			const ctx = createMockTuiCtx(defaultCwd);
			const longTask = "a".repeat(250);

			const executePromise = executeTool(
				"call-1",
				{ agent: "tester", task: longTask, sessionId: SESSION_ID },
				undefined,
				undefined,
				ctx,
			);

			const { timedOut } = await raceWithTimeout(executePromise, 200);
			
			if (timedOut) {
				throw new Error("Red phase: execute() did not return immediately, task truncation not yet implemented");
			}

			procRef!.stdout.emit(
				"data",
				Buffer.from(
					JSON.stringify({
						type: "message_end",
						message: {
							role: "assistant",
							content: [{ type: "text", text: "结果" }],
							stopReason: "end_turn",
							usage: { input: 10, output: 5, totalTokens: 15 },
						},
					}) + "\n",
				),
			);
			await vi.advanceTimersByTimeAsync(0);
			endProcess(procRef!, 0);
			await vi.advanceTimersByTimeAsync(1000);

			expect(pi.sendMessage).toHaveBeenCalled();
			const [message] = pi._sendMessageCalls[0];
			const content: string = message.content;

			// 找到「任务:」行
			const taskLine = content.split("\n").find((l: string) => l.includes("任务:"));
			expect(taskLine).toBeDefined();

			// 任务描述部分应 ≤ 200 字 + 截断标记
			const taskContent = taskLine!.replace(/^.*任务:\s*/, "");
			expect(taskContent.length).toBeLessThanOrEqual(203); // 200 + "..."
		});
	});

	// ================================================================
	// 设计决策 5：深度限制（MAX_SUBAGENT_DEPTH=1，无 canDelegate）
	// ================================================================
	describe("设计决策 5：深度限制", () => {
		it("depth ≥ 1 → blocked，消息不再提及 canDelegate", async () => {
			process.env.PI_SUBAGENT_DEPTH = "1";
			const { executeTool } = setupExtension();
			const ctx = createMockNonTuiCtx(defaultCwd);

			const result = await executeTool(
				"call-1",
				{ agent: "tester", task: "test task", sessionId: SESSION_ID },
				undefined,
				undefined,
				ctx,
			);

			expect(result.isError).toBe(true);
			const text = result.content[0].text;
			expect(text).toMatch(/blocked|限制|depth/i);

			// 不再提及 canDelegate
			expect(text).not.toMatch(/canDelegate/i);
		});

		it("agent frontmatter 写 canDelegate: true 在 depth=1 仍然被 blocked", async () => {
			// 写入 canDelegate: true 的 agent
			fs.writeFileSync(
				path.join(defaultCwd, ".pi", "agents", "delegator.md"),
				`---\nname: delegator\ndescription: Delegating agent\ncanDelegate: true\n---\n`,
				"utf-8",
			);

			process.env.PI_SUBAGENT_DEPTH = "1";
			const { executeTool } = setupExtension();
			const ctx = createMockNonTuiCtx(defaultCwd);

			const result = await executeTool(
				"call-1",
				{ agent: "delegator", task: "test task", sessionId: SESSION_ID },
				undefined,
				undefined,
				ctx,
			);

			// canDelegate: true 不再起作用 → depth=1 一律 blocked
			expect(result.isError).toBe(true);
			const text = result.content[0].text;
			expect(text).not.toMatch(/canDelegate/i);
		});
	});

	// ================================================================
	// 设计决策 6：/subagent-cancel 命令
	// ================================================================
	describe("设计决策 6：/subagent-cancel 命令", () => {
		it("扩展注册 /subagent-cancel 命令", () => {
			const { pi } = setupExtension();

			expect(pi.registerCommand).toHaveBeenCalledWith(
				"subagent-cancel",
				expect.any(Object),
			);
		});

		it("取消在飞任务 → kill(SIGTERM) → 5s → SIGKILL → sendMessage 状态=已取消", async () => {
			const { pi, executeTool } = setupExtension();
			const ctx = createMockTuiCtx(defaultCwd);

			// 派发任务（TUI 模式异步）
			const executePromise = executeTool(
				"call-1",
				{ agent: "tester", task: "test task", sessionId: SESSION_ID },
				undefined,
				undefined,
				ctx,
			);

			const { timedOut } = await raceWithTimeout(executePromise, 200);
			
			if (timedOut) {
				throw new Error("Red phase: execute() did not return immediately, cancel not yet implemented");
			}

			// 获取注册的命令
			expect(pi.registerCommand).toHaveBeenCalled();
			const cancelCommand = pi._commandDefs.get("subagent-cancel");
			expect(cancelCommand).toBeDefined();

			// 执行取消
			await cancelCommand.handler(SESSION_ID, ctx);

			// SIGTERM 应立即发送
			expect(procRef!.kill).toHaveBeenCalledWith("SIGTERM");

			// 5 秒后应发送 SIGKILL（级联）
			await vi.advanceTimersByTimeAsync(5000);
			expect(procRef!.kill).toHaveBeenCalledWith("SIGKILL");

			// 模拟进程退出
			endProcess(procRef!, null, "SIGKILL");
			await vi.advanceTimersByTimeAsync(1000);

			// sendMessage 应被调用，状态=已取消
			expect(pi.sendMessage).toHaveBeenCalled();
			const [message] = pi._sendMessageCalls[0];
			expect(message.content).toContain("已取消");
		});
	});

	// ================================================================
	// 设计决策 7：session_shutdown 处理器
	// ================================================================
	describe("设计决策 7：session_shutdown 处理器", () => {
		it("扩展注册 session_shutdown 事件处理器", () => {
			const { pi } = setupExtension();

			expect(pi.on).toHaveBeenCalledWith("session_shutdown", expect.any(Function));
		});

		it("session_shutdown 时 kill 所有在飞子进程，标记 killed_on_shutdown", async () => {
			const { pi, executeTool } = setupExtension();
			const ctx = createMockTuiCtx(defaultCwd);

			// 派发第一个任务
			const executePromise1 = executeTool(
				"call-1",
				{ agent: "tester", task: "task 1", sessionId: "019ffdd3-3eb5-733d-b481-a53e5292bd0f" },
				undefined,
				undefined,
				ctx,
			);
			const { result: result1, timedOut: timedOut1 } = await raceWithTimeout(executePromise1, 200);
			
			if (timedOut1) {
				throw new Error("Red phase: execute() did not return immediately, session_shutdown not yet implemented");
			}
			const proc1 = procRef!;

			// Reset for second spawn
			vi.mocked(spawn).mockImplementation((() => {
				const proc = createControllableProc();
				(procRef as any) = proc;
				return proc;
			}) as any);

			// 派发第二个任务
			const executePromise2 = executeTool(
				"call-2",
				{ agent: "tester", task: "task 2", sessionId: "019ffdd3-3eb5-733d-b481-a53e5292bd10" },
				undefined,
				undefined,
				ctx,
			);
			const { timedOut: timedOut2 } = await raceWithTimeout(executePromise2, 200);
			
			if (timedOut2) {
				throw new Error("Red phase: execute() did not return immediately, session_shutdown not yet implemented");
			}
			const proc2 = procRef!;

			// 触发 shutdown
			const shutdownHandlers = pi._eventHandlers.get("session_shutdown");
			expect(shutdownHandlers).toBeDefined();
			expect(shutdownHandlers!.length).toBeGreaterThan(0);

			await shutdownHandlers![0]({ type: "session_shutdown" });

			// 两个进程都应被 kill
			expect(proc1.kill).toHaveBeenCalled();
			expect(proc2.kill).toHaveBeenCalled();
		});
	});

	// ================================================================
	// 设计决策 8：非 TUI 模式降级同步
	// ================================================================
	describe("设计决策 8：非 TUI 模式降级同步", () => {
		it("mode=undefined → execute 保持同步（等待子进程退出才 resolve）", async () => {
			// 使用立即退出的进程
			vi.mocked(spawn).mockImplementation((() => {
				return createSuccessfulProc();
			}) as any);

			const { executeTool } = setupExtension();
			const ctx = createMockNonTuiCtx(defaultCwd);

			// mode 为 undefined → 同步路径
			const result = await executeTool(
				"call-1",
				{ agent: "tester", task: "test task", sessionId: SESSION_ID },
				undefined,
				undefined,
				ctx,
			);

			// 应该包含子进程结果（非回执）
			const text = result.content[0].text;
			expect(text).toContain(SESSION_ID);
			// 不应包含异步回执语义
			expect(text).not.toMatch(/已派出|dispatched|queued/i);
		});

		it("mode=print → execute 保持同步（与现状完全一致）", async () => {
			vi.mocked(spawn).mockImplementation((() => {
				return createSuccessfulProc();
			}) as any);

			const { executeTool } = setupExtension();
			const ctx = createMockNonTuiCtx(defaultCwd, "print");

			const result = await executeTool(
				"call-1",
				{ agent: "tester", task: "test task", sessionId: SESSION_ID },
				undefined,
				undefined,
				ctx,
			);

			// 同步路径：返回最终结果
			const text = result.content[0].text;
			expect(text).toContain(SESSION_ID);
			expect(text).not.toMatch(/已派出|dispatched|queued/i);
		});
	});
});
