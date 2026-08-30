/**
 * Async regression tests & B1 red-phase test
 *
 * Covers reviewer-identified defect B1 (taskRegistry conflict protection)
 * and test gaps T1–T8 from the review report.
 *
 * B1 is expected to FAIL (red phase) because the current implementation
 * unconditionally overwrites taskRegistry entries without checking for
 * existing in-flight tasks with the same sessionId.
 */

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn } from "node:child_process";
import extension, { taskRegistry, type AsyncSubagentTask } from "../src/index.ts";
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

/**
 * Create a fake ChildProcess whose kill() is a no-op.
 */
function createControllableProc() {
	const proc = new EventEmitter() as any;
	proc.stdout = new EventEmitter();
	proc.stderr = new EventEmitter();
	proc.kill = vi.fn(() => true);
	proc.exitCode = null;
	proc.signalCode = null;
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
		registerMessageRenderer: vi.fn(),
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
 * Helper: race execute() against a timeout to detect immediate returns.
 */
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

describe("异步化回归测试 & B1 红阶段", () => {
	let tmpBase: string;
	let agentDir: string;
	let defaultCwd: string;
	let savedEnv: Record<string, string | undefined>;
	let procRef: ReturnType<typeof createControllableProc> | null;
	/** Track all spawned procs for multi-spawn tests */
	let allProcs: ReturnType<typeof createControllableProc>[];

	beforeEach(() => {
		vi.useFakeTimers();

		// Clear the module-level taskRegistry to prevent cross-test leakage (T1)
		taskRegistry.clear();

		tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "async-subagent-isolation-regression-"));
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
		allProcs = [];
		vi.mocked(spawn).mockImplementation((() => {
			const proc = createControllableProc();
			procRef = proc;
			allProcs.push(proc);
			return proc;
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
	// B1: taskRegistry conflict protection
	// ================================================================
	describe("B1: 同 sessionId 冲突防护", () => {
		it("should reject second async dispatch with same sessionId when first task is still in-flight", async () => {
			const { executeTool } = setupExtension();
			const ctx = createMockTuiCtx(defaultCwd);

			// First dispatch — should succeed with receipt
			const first = await executeTool(
				"call-1",
				{ agent: "tester", task: "first task", sessionId: "019ffdd3-3eb5-733d-b481-a53e5292bd20" },
				undefined,
				undefined,
				ctx,
			);

			expect(first.isError).toBeFalsy();
			expect(first.content[0].text).toMatch(/dispatched/i);
			expect(taskRegistry.size).toBe(1);

			// Second dispatch with same sessionId — MUST be rejected
			const second = await executeTool(
				"call-2",
				{ agent: "tester", task: "second task", sessionId: "019ffdd3-3eb5-733d-b481-a53e5292bd20" },
				undefined,
				undefined,
				ctx,
			);

			// Expected: isError=true, message says task already exists / wait / cancel / use new id
			expect(second.isError).toBe(true);
			expect(second.content[0].text).toMatch(
				/already|exist|wait|cancel|new.*id/i,
			);

			// The first task's process should still be alive (not replaced)
			expect(taskRegistry.size).toBe(1);
			expect(taskRegistry.get("019ffdd3-3eb5-733d-b481-a53e5292bd20")).toBeDefined();
		});

		it("should only spawn one child process when second dispatch is rejected", async () => {
			const { executeTool } = setupExtension();
			const ctx = createMockTuiCtx(defaultCwd);

			await executeTool(
				"call-1",
				{ agent: "tester", task: "first task", sessionId: "019ffdd3-3eb5-733d-b481-a53e5292bd20" },
				undefined,
				undefined,
				ctx,
			);

			await executeTool(
				"call-2",
				{ agent: "tester", task: "second task", sessionId: "019ffdd3-3eb5-733d-b481-a53e5292bd20" },
				undefined,
				undefined,
				ctx,
			);

			// Only one spawn should have occurred
			expect(allProcs.length).toBe(1);
		});
	});

	// ================================================================
	// T1: taskRegistry cleanup assertions
	// ================================================================
	describe("T1: taskRegistry 清理断言", () => {
		it("should remove task from registry after successful completion", async () => {
			const { executeTool } = setupExtension();
			const ctx = createMockTuiCtx(defaultCwd);

			const executePromise = executeTool(
				"call-1",
				{ agent: "tester", task: "test task", sessionId: "019ffdd3-3eb5-733d-b481-a53e5292bd21" },
				undefined,
				undefined,
				ctx,
			);
			await raceWithTimeout(executePromise, 200);

			expect(taskRegistry.size).toBe(1);

			// Complete the task successfully: inject a message_end with text so this
			// really tests the success path under N2.
			allProcs[0].stdout.emit(
				"data",
				Buffer.from(
					JSON.stringify({
						type: "message_end",
						message: {
							role: "assistant",
							content: [{ type: "text", text: "success" }],
							stopReason: "end_turn",
							usage: { input: 10, output: 5, totalTokens: 15 },
						},
					}) + "\n",
				),
			);
			await vi.advanceTimersByTimeAsync(0);
			endProcess(allProcs[0], 0);
			await vi.advanceTimersByTimeAsync(1000);

			expect(taskRegistry.size).toBe(0);
			const result = await executePromise;
			expect(result.isError).toBeFalsy();
		});

		it("should remove task from registry after cancel", async () => {
			const { pi, executeTool } = setupExtension();
			const ctx = createMockTuiCtx(defaultCwd);

			const executePromise = executeTool(
				"call-1",
				{ agent: "tester", task: "test task", sessionId: "019ffdd3-3eb5-733d-b481-a53e5292bd22" },
				undefined,
				undefined,
				ctx,
			);
			await raceWithTimeout(executePromise, 200);

			expect(taskRegistry.size).toBe(1);

			// Cancel the task
			const cancelCommand = pi._commandDefs.get("subagent-cancel");
			await cancelCommand.handler("019ffdd3-3eb5-733d-b481-a53e5292bd22", { ui: { notify: vi.fn() } });

			// Advance through SIGTERM grace + SIGKILL + finalize
			await vi.advanceTimersByTimeAsync(1000);
			endProcess(allProcs[0], null, "SIGTERM");
			await vi.advanceTimersByTimeAsync(1000);

			expect(taskRegistry.size).toBe(0);
		});

		it("should remove all tasks from registry after session_shutdown", async () => {
			const { pi, executeTool } = setupExtension();
			const ctx = createMockTuiCtx(defaultCwd);

			// Dispatch two tasks
			await executeTool(
				"call-1",
				{ agent: "tester", task: "task 1", sessionId: "019ffdd3-3eb5-733d-b481-a53e5292bd23" },
				undefined,
				undefined,
				ctx,
			);
			await executeTool(
				"call-2",
				{ agent: "tester", task: "task 2", sessionId: "019ffdd3-3eb5-733d-b481-a53e5292bd24" },
				undefined,
				undefined,
				ctx,
			);

			expect(taskRegistry.size).toBe(2);

			// Trigger shutdown
			const shutdownHandlers = pi._eventHandlers.get("session_shutdown");
			await shutdownHandlers![0]({ type: "session_shutdown" });

			// End both processes
			for (const proc of allProcs) {
				endProcess(proc, null, "SIGTERM");
			}
			await vi.advanceTimersByTimeAsync(1000);

			expect(taskRegistry.size).toBe(0);
		});
	});

	// ================================================================
	// T2: sendMessage error graceful degradation
	// ================================================================
	describe("T2: sendMessage 同步抛错降级", () => {
		it("should not crash or produce unhandled rejection when sendMessage throws on completion", async () => {
			const { pi, executeTool } = setupExtension();
			const ctx = createMockTuiCtx(defaultCwd);

			const executePromise = executeTool(
				"call-1",
				{ agent: "tester", task: "test task", sessionId: "019ffdd3-3eb5-733d-b481-a53e5292bd25" },
				undefined,
				undefined,
				ctx,
			);
			await raceWithTimeout(executePromise, 200);

			// Make sendMessage throw
			pi.sendMessage.mockImplementation(() => {
				throw new Error("Session already destroyed");
			});

			// Complete the task — this triggers completeAsyncTask which calls sendMessage.
			// 本用例验证 sendMessage 抛错时的降级行为，不依赖终态成功/失败；
			// 保持 endProcess(0) 无 message_end 是为了最小化改动。
			endProcess(allProcs[0], 0);

			// Should not throw or produce unhandled rejection
			await vi.advanceTimersByTimeAsync(1000);

			// Registry should still be cleaned up and completeAsyncTask was attempted
			expect(taskRegistry.size).toBe(0);
			expect(pi.sendMessage).toHaveBeenCalled();
		});

		it("should not crash when sendMessage throws after session_shutdown", async () => {
			const { pi, executeTool } = setupExtension();
			const ctx = createMockTuiCtx(defaultCwd);

			const executePromise = executeTool(
				"call-1",
				{ agent: "tester", task: "test task", sessionId: "019ffdd3-3eb5-733d-b481-a53e5292bd26" },
				undefined,
				undefined,
				ctx,
			);
			await raceWithTimeout(executePromise, 200);

			// Trigger shutdown first
			const shutdownHandlers = pi._eventHandlers.get("session_shutdown");
			await shutdownHandlers![0]({ type: "session_shutdown" });

			// Now make sendMessage throw (simulating post-shutdown state)
			pi.sendMessage.mockImplementation(() => {
				throw new Error("Session is gone");
			});

			// End the process — completeAsyncTask will try to sendMessage and fail
			endProcess(allProcs[0], null, "SIGTERM");

			// Should not crash or produce unhandled rejection
			await vi.advanceTimersByTimeAsync(1000);
			expect(taskRegistry.size).toBe(0);
		});
	});

	// ================================================================
	// T4: hard_timeout envelope status
	// ================================================================
	// T4: hard_timeout fires INSIDE runSingleAgent's promise executor (a single
	// synchronous block).  The timer is created in the CURRENT fake-timer
	// context.  Using raceWithTimeout here would call vi.useRealTimers() then
	// vi.useFakeTimers(), orphaning that timer.  Because TUI-mode execute()
	// resolves immediately, we can simply await it directly and stay in one
	// fake-timer context for the entire test.
	describe("T4: hard_timeout → 信封状态「超时」", () => {
		it("should produce envelope with '超时' status when hard_timeout fires", async () => {
			process.env.PI_SUBAGENT_HARD_TIMEOUT_MS = "2000";
			const { pi, executeTool } = setupExtension();
			const ctx = createMockTuiCtx(defaultCwd);

			// execute resolves immediately with receipt in TUI mode
			const result = await executeTool(
				"call-1",
				{ agent: "tester", task: "test task", sessionId: "019ffdd3-3eb5-733d-b481-a53e5292bd27" },
				undefined,
				undefined,
				ctx,
			);
			expect(result.isError).toBeFalsy();
			expect(taskRegistry.size).toBe(1);

			// Advance past the hard timeout — timer fires inside runSingleAgent,
			// kills the process, and triggers completeAsyncTask → sendMessage
			await vi.advanceTimersByTimeAsync(3000);

			// Envelope should be sent with timeout status
			expect(pi.sendMessage).toHaveBeenCalled();
			const [message] = pi._sendMessageCalls[0];
			expect(message.content).toContain("timed out");
			expect(message.customType).toBe("subagent-result");
		});

		it("should set stopReason to hard_timeout in details", async () => {
			process.env.PI_SUBAGENT_HARD_TIMEOUT_MS = "1500";
			const { pi, executeTool } = setupExtension();
			const ctx = createMockTuiCtx(defaultCwd);

			await executeTool(
				"call-1",
				{ agent: "tester", task: "test task", sessionId: "019ffdd3-3eb5-733d-b481-a53e5292bd28" },
				undefined,
				undefined,
				ctx,
			);

			await vi.advanceTimersByTimeAsync(2000);

			expect(pi.sendMessage).toHaveBeenCalled();
			const [message] = pi._sendMessageCalls[0];
			expect(message.details.stopReason).toBe("hard_timeout");
		});
	});

	// ================================================================
	// T5: shutdown envelope/status correctness
	// ================================================================
	describe("T5: shutdown 后信封与状态正确性", () => {
		it("should send envelope with '已取消' status after shutdown", async () => {
			const { pi, executeTool } = setupExtension();
			const ctx = createMockTuiCtx(defaultCwd);

			const executePromise = executeTool(
				"call-1",
				{ agent: "tester", task: "test task", sessionId: "019ffdd3-3eb5-733d-b481-a53e5292bd29" },
				undefined,
				undefined,
				ctx,
			);
			await raceWithTimeout(executePromise, 200);

			// Trigger shutdown
			const shutdownHandlers = pi._eventHandlers.get("session_shutdown");
			await shutdownHandlers![0]({ type: "session_shutdown" });

			// End the process
			endProcess(allProcs[0], null, "SIGTERM");
			await vi.advanceTimersByTimeAsync(1000);

			// Envelope should be sent with cancelled status
			expect(pi.sendMessage).toHaveBeenCalled();
			const [message] = pi._sendMessageCalls[0];
			expect(message.customType).toBe("subagent-result");
			expect(message.content).toContain("cancelled");
		});

		it("should include killed_on_shutdown stopReason in details", async () => {
			const { pi, executeTool } = setupExtension();
			const ctx = createMockTuiCtx(defaultCwd);

			const executePromise = executeTool(
				"call-1",
				{ agent: "tester", task: "test task", sessionId: "019ffdd3-3eb5-733d-b481-a53e5292bd2a" },
				undefined,
				undefined,
				ctx,
			);
			await raceWithTimeout(executePromise, 200);

			const shutdownHandlers = pi._eventHandlers.get("session_shutdown");
			await shutdownHandlers![0]({ type: "session_shutdown" });

			endProcess(allProcs[0], null, "SIGTERM");
			await vi.advanceTimersByTimeAsync(1000);

			expect(pi.sendMessage).toHaveBeenCalled();
			const [message] = pi._sendMessageCalls[0];
			expect(message.details.stopReason).toBe("killed_on_shutdown");
		});

		it("should not crash when multiple tasks are shut down simultaneously", async () => {
			const { pi, executeTool } = setupExtension();
			const ctx = createMockTuiCtx(defaultCwd);

			// Dispatch two tasks
			await executeTool(
				"call-1",
				{ agent: "tester", task: "task 1", sessionId: "019ffdd3-3eb5-733d-b481-a53e5292bd2b" },
				undefined,
				undefined,
				ctx,
			);
			await executeTool(
				"call-2",
				{ agent: "tester", task: "task 2", sessionId: "019ffdd3-3eb5-733d-b481-a53e5292bd2c" },
				undefined,
				undefined,
				ctx,
			);

			// Shutdown both
			const shutdownHandlers = pi._eventHandlers.get("session_shutdown");
			await shutdownHandlers![0]({ type: "session_shutdown" });

			// End both processes
			for (const proc of allProcs) {
				endProcess(proc, null, "SIGTERM");
			}
			await vi.advanceTimersByTimeAsync(1000);

			// Both envelopes should be sent
			expect(pi.sendMessage).toHaveBeenCalledTimes(2);
			expect(taskRegistry.size).toBe(0);
		});
	});

	// ================================================================
	// T6: uuidv7 taskId generation when sessionId omitted
	// ================================================================
	describe("T6: 省略 sessionId 时 uuidv7 生成 taskId", () => {
		it("should generate a UUID v7 taskId when sessionId is not provided", async () => {
			const { executeTool } = setupExtension();
			const ctx = createMockTuiCtx(defaultCwd);

			const executePromise = executeTool(
				"call-1",
				{ agent: "tester", task: "test task" },
				undefined,
				undefined,
				ctx,
			);

			const { result, timedOut } = await raceWithTimeout(executePromise, 200);

			expect(timedOut).toBe(false);
			expect(result).not.toBeNull();
			expect(result!.isError).toBeFalsy();

			const text = result!.content[0].text;
			// Extract the UUID from the receipt text
			const uuidMatch = text.match(
				/[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/,
			);
			expect(uuidMatch).not.toBeNull();

			// The generated taskId should be in the registry
			const taskId = uuidMatch![0];
			expect(taskRegistry.has(taskId)).toBe(true);
		});

		it("should use the generated UUID as both taskId and session directory name", async () => {
			const { executeTool } = setupExtension();
			const ctx = createMockTuiCtx(defaultCwd);

			const executePromise = executeTool(
				"call-1",
				{ agent: "tester", task: "test task" },
				undefined,
				undefined,
				ctx,
			);

			const { result } = await raceWithTimeout(executePromise, 200);
			const text = result!.content[0].text;

			// Extract taskId from receipt
			const uuidMatch = text.match(
				/[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/,
			);
			expect(uuidMatch).not.toBeNull();

			const taskId = uuidMatch![0];

			// Registry entry should exist with this taskId
			const record = taskRegistry.get(taskId);
			expect(record).toBeDefined();
			expect(record!.taskId).toBe(taskId);
			expect(record!.agentName).toBe("tester");
			expect(record!.status).toBe("running");
		});
	});

	// ================================================================
	// T7: /subagent-cancel warning for non-existent/completed tasks
	// ================================================================
	describe("T7: /subagent-cancel 不存在/已完成任务的 warning", () => {
		it("should emit warning when cancelling a non-existent taskId", async () => {
			const { pi } = setupExtension();

			const cancelCommand = pi._commandDefs.get("subagent-cancel");
			expect(cancelCommand).toBeDefined();

			const notifyMock = vi.fn();
			await cancelCommand.handler("non-existent-id", { ui: { notify: notifyMock } });

			expect(notifyMock).toHaveBeenCalledWith(
				expect.stringContaining("non-existent-id"),
				"warning",
			);
		});

		it("should emit warning when cancelling with empty taskId", async () => {
			const { pi } = setupExtension();

			const cancelCommand = pi._commandDefs.get("subagent-cancel");
			const notifyMock = vi.fn();
			await cancelCommand.handler("", { ui: { notify: notifyMock } });

			expect(notifyMock).toHaveBeenCalledWith(
				expect.stringContaining("(none)"),
				"warning",
			);
		});

		it("should emit warning when cancelling an already-completed task", async () => {
			const { pi, executeTool } = setupExtension();
			const ctx = createMockTuiCtx(defaultCwd);
			const sessionId = "019ffdd3-3eb5-733d-b481-a53e5292bd2d";

			// Dispatch a task
			const executePromise = executeTool(
				"call-1",
				{ agent: "tester", task: "test task", sessionId },
				undefined,
				undefined,
				ctx,
			);
			await raceWithTimeout(executePromise, 200);

			// Complete it: 本用例验证「已结束任务再取消」的告警，不依赖终态；
			// endProcess(0) 仅用于触发 completeAsyncTask 使任务出 registry。
			endProcess(allProcs[0], 0);
			await vi.advanceTimersByTimeAsync(1000);
			expect(taskRegistry.has(sessionId)).toBe(false);
			expect(pi.sendMessage).toHaveBeenCalled();
			// Now try to cancel it — should warn since it's been removed from registry
			const cancelCommand = pi._commandDefs.get("subagent-cancel");
			const notifyMock = vi.fn();
			await cancelCommand.handler(sessionId, { ui: { notify: notifyMock } });

			expect(notifyMock).toHaveBeenCalledWith(
				expect.stringContaining("019ffdd3-3eb5-733d-b481-a53e5292bd2d"),
				"warning",
			);
		});
	});

	// ================================================================
	// T9: /subagent-cancel-all 一键取消全部运行中任务（红阶段）
	// ================================================================
	describe("T9: /subagent-cancel-all 一键取消全部（红阶段）", () => {
		/**
		 * Inject a synthetic "running" task directly into the registry, wiring
		 * the same abort → SIGTERM cascade that runSingleAgent sets up, so the
		 * observable behavior matches a real in-flight task without spawning.
		 */
		function injectRunningTask(taskId: string, taskText = `task ${taskId}`) {
			const abortController = new AbortController();
			const proc = createControllableProc();
			abortController.signal.addEventListener("abort", () => {
				proc.kill("SIGTERM");
			});
			const record: AsyncSubagentTask = {
				taskId,
				agentName: "tester",
				task: taskText,
				startedAt: Date.now(),
				abortController,
				status: "running",
				proc,
			};
			taskRegistry.set(taskId, record);
			return { record, abortController, proc };
		}

		it('应注册 "subagent-cancel-all" 命令', () => {
			const { pi } = setupExtension();

			expect(pi._commandDefs.has("subagent-cancel-all")).toBe(true);
		});

		it("无参数调用应取消所有 running 任务并 notify 已取消数量", async () => {
			const { pi } = setupExtension();
			const cancelAllCommand = pi._commandDefs.get("subagent-cancel-all");
			expect(cancelAllCommand, "subagent-cancel-all command should be registered").toBeDefined();

			// Arrange: two running tasks
			const { record: taskA, proc: procA } = injectRunningTask("cancel-all-a");
			const { record: taskB, proc: procB } = injectRunningTask("cancel-all-b");
			expect(taskRegistry.size).toBe(2);

			// Act: trigger handler with no argument
			const notifyMock = vi.fn();
			await cancelAllCommand!.handler("", { ui: { notify: notifyMock } });

			// Assert: both tasks cancelled (status + abort cascade + SIGTERM)
			expect(taskA.status).toBe("cancelled");
			expect(taskB.status).toBe("cancelled");
			expect(taskA.abortController.signal.aborted).toBe(true);
			expect(taskB.abortController.signal.aborted).toBe(true);
			expect(procA.kill).toHaveBeenCalledWith("SIGTERM");
			expect(procB.kill).toHaveBeenCalledWith("SIGTERM");

			// Assert: notify 提示含「已取消」与数量
			expect(notifyMock).toHaveBeenCalledWith(expect.stringMatching(/cancelled/i), "info");
			expect(notifyMock).toHaveBeenCalledWith(expect.stringContaining("2"), "info");
		});

		it("注册表为空时 notify 提示无运行中任务", async () => {
			const { pi } = setupExtension();
			const cancelAllCommand = pi._commandDefs.get("subagent-cancel-all");
			expect(cancelAllCommand, "subagent-cancel-all command should be registered").toBeDefined();

			expect(taskRegistry.size).toBe(0);

			const notifyMock = vi.fn();
			await cancelAllCommand!.handler("", { ui: { notify: notifyMock } });

			expect(notifyMock).toHaveBeenCalledWith(
				expect.stringMatching(/no running subagent task/i),
				expect.any(String),
			);
		});

		it("被取消任务的 cancelledBy 应为 user（与 /subagent-cancel 一致）", async () => {
			const { pi } = setupExtension();
			const cancelAllCommand = pi._commandDefs.get("subagent-cancel-all");
			expect(cancelAllCommand, "subagent-cancel-all command should be registered").toBeDefined();

			injectRunningTask("cancel-all-cb-a");
			injectRunningTask("cancel-all-cb-b");

			const notifyMock = vi.fn();
			await cancelAllCommand!.handler("", { ui: { notify: notifyMock } });

			expect(taskRegistry.get("cancel-all-cb-a")?.cancelledBy).toBe("user");
			expect(taskRegistry.get("cancel-all-cb-b")?.cancelledBy).toBe("user");
		});

		it("只取消 running 任务，不触碰已完成/已取消记录", async () => {
			const { pi } = setupExtension();
			const cancelAllCommand = pi._commandDefs.get("subagent-cancel-all");
			expect(cancelAllCommand, "subagent-cancel-all command should be registered").toBeDefined();

			// One running task + one already-cancelled record
			const { record: running } = injectRunningTask("cancel-all-mixed-running");
			const finishedAbort = new AbortController();
			const finishedProc = createControllableProc();
			const finished: AsyncSubagentTask = {
				taskId: "cancel-all-mixed-finished",
				agentName: "tester",
				task: "already done",
				startedAt: Date.now(),
				abortController: finishedAbort,
				status: "cancelled",
				cancelledBy: "user",
				proc: finishedProc,
			};
			taskRegistry.set("cancel-all-mixed-finished", finished);

			const notifyMock = vi.fn();
			await cancelAllCommand!.handler("", { ui: { notify: notifyMock } });

			// Running task cancelled via abort cascade
			expect(running.status).toBe("cancelled");
			expect(running.abortController.signal.aborted).toBe(true);
			// Already-cancelled record untouched
			expect(finished.status).toBe("cancelled");
			expect(finishedAbort.signal.aborted).toBe(false);
			expect(finishedProc.kill).not.toHaveBeenCalled();
			// notify 统计的是 running 数量（1 个）
			expect(notifyMock).toHaveBeenCalledWith(expect.stringContaining("1"), "info");
		});

		it("完整流程：取消全部后每个任务各发一封 cancelledBy=user 的已取消信封", async () => {
			const { pi, executeTool } = setupExtension();
			const ctx = createMockTuiCtx(defaultCwd);

			// Dispatch two real tasks
			await executeTool(
				"call-1",
				{ agent: "tester", task: "task 1", sessionId: "019ffdd3-3eb5-733d-b481-a53e5292bd2e" },
				undefined,
				undefined,
				ctx,
			);
			await executeTool(
				"call-2",
				{ agent: "tester", task: "task 2", sessionId: "019ffdd3-3eb5-733d-b481-a53e5292bd2f" },
				undefined,
				undefined,
				ctx,
			);
			expect(taskRegistry.size).toBe(2);

			const cancelAllCommand = pi._commandDefs.get("subagent-cancel-all");
			expect(cancelAllCommand, "subagent-cancel-all command should be registered").toBeDefined();
			await cancelAllCommand!.handler("", { ui: { notify: vi.fn() } });

			// Both tasks marked cancelled
			expect(taskRegistry.get("019ffdd3-3eb5-733d-b481-a53e5292bd2e")?.status).toBe("cancelled");
			expect(taskRegistry.get("019ffdd3-3eb5-733d-b481-a53e5292bd2f")?.status).toBe("cancelled");

			// End both procs → each completion sends a subagent-result envelope
			for (const proc of allProcs) {
				endProcess(proc, null, "SIGTERM");
			}
			await vi.advanceTimersByTimeAsync(1000);

			expect(pi.sendMessage).toHaveBeenCalledTimes(2);
			const envelopes = pi._sendMessageCalls.map((c: any[]) => c[0]);
			for (const envelope of envelopes) {
				expect(envelope.customType).toBe("subagent-result");
				expect(envelope.content).toContain("cancelled");
				expect(envelope.details.cancelledBy).toBe("user");
			}
		});

		// 回归锁定：/subagent-cancel 无参列出运行任务的行为不受影响（应保持绿）
		it("回归：/subagent-cancel 无参数仍列出运行任务", async () => {
			const { pi } = setupExtension();
			const cancelCommand = pi._commandDefs.get("subagent-cancel");
			expect(cancelCommand).toBeDefined();

			injectRunningTask("regression-listed-task");

			const notifyMock = vi.fn();
			await cancelCommand!.handler("", { ui: { notify: notifyMock } });

			expect(notifyMock).toHaveBeenCalledWith(
				expect.stringContaining("regression-listed-task"),
				"warning",
			);
		});
	});

	// ================================================================
	// T8: SIGTERM grace period — no SIGKILL if process exits in time
	// ================================================================
	describe("T8: SIGTERM 宽限期内进程退出则不发 SIGKILL", () => {
		it("should not send SIGKILL if process exits during grace period", async () => {
			const { pi, executeTool } = setupExtension();
			const ctx = createMockTuiCtx(defaultCwd);

			const executePromise = executeTool(
				"call-1",
				{ agent: "tester", task: "test task", sessionId: "019ffdd3-3eb5-733d-b481-a53e5292bd30" },
				undefined,
				undefined,
				ctx,
			);
			await raceWithTimeout(executePromise, 200);

			const proc = allProcs[0];

			// Cancel the task → SIGTERM sent
			const cancelCommand = pi._commandDefs.get("subagent-cancel");
			await cancelCommand.handler("019ffdd3-3eb5-733d-b481-a53e5292bd30", { ui: { notify: vi.fn() } });

			expect(proc.kill).toHaveBeenCalledWith("SIGTERM");

			// Process exits during grace period (before 5s SIGKILL timer fires)
			await vi.advanceTimersByTimeAsync(1000);
			endProcess(proc, null, "SIGTERM");

			// Advance past the 5s SIGKILL timer — it should have been cleared
			await vi.advanceTimersByTimeAsync(5000);

			// SIGKILL should NOT have been called
			const killCalls = proc.kill.mock.calls.map((c: any[]) => c[0]);
			expect(killCalls).not.toContain("SIGKILL");
		});

		it("should send SIGKILL only if process does not exit within grace period", async () => {
			const { pi, executeTool } = setupExtension();
			const ctx = createMockTuiCtx(defaultCwd);

			const executePromise = executeTool(
				"call-1",
				{ agent: "tester", task: "test task", sessionId: "019ffdd3-3eb5-733d-b481-a53e5292bd31" },
				undefined,
				undefined,
				ctx,
			);
			await raceWithTimeout(executePromise, 200);

			const proc = allProcs[0];

			// Cancel → SIGTERM
			const cancelCommand = pi._commandDefs.get("subagent-cancel");
			await cancelCommand.handler("019ffdd3-3eb5-733d-b481-a53e5292bd31", { ui: { notify: vi.fn() } });

			expect(proc.kill).toHaveBeenCalledWith("SIGTERM");

			// Advance 5s — process does NOT exit, SIGKILL should fire
			await vi.advanceTimersByTimeAsync(5000);
			expect(proc.kill).toHaveBeenCalledWith("SIGKILL");
		});
	});

	// ================================================================
	// T3: B1 fix regression — same sessionId conflict is rejected
	// ================================================================
	describe("T3: B1 修复后回归 — 同 sessionId 冲突被拒", () => {
		it("should allow dispatch after previous task with same sessionId completes", async () => {
			const { pi, executeTool } = setupExtension();
			const ctx = createMockTuiCtx(defaultCwd);
			const sessionId = "019ffdd3-3eb5-733d-b481-a53e5292bd32";

			// First dispatch
			const first = await executeTool(
				"call-1",
				{ agent: "tester", task: "first task", sessionId },
				undefined,
				undefined,
				ctx,
			);
			expect(first.isError).toBeFalsy();
			expect(taskRegistry.size).toBe(1);

			// Complete the first task: 本用例验证同 sessionId 复用，不依赖终态；
			// endProcess(0) 仅用于触发 completeAsyncTask 使任务出 registry。
			endProcess(allProcs[0], 0);
			await vi.advanceTimersByTimeAsync(1000);
			expect(taskRegistry.size).toBe(0);
			expect(pi.sendMessage).toHaveBeenCalled();

			// Second dispatch with same sessionId should succeed (no conflict)
			const second = await executeTool(
				"call-2",
				{ agent: "tester", task: "second task", sessionId },
				undefined,
				undefined,
				ctx,
			);
			expect(second.isError).toBeFalsy();
			expect(second.content[0].text).toMatch(/dispatched/i);
			expect(taskRegistry.size).toBe(1);
		});
	});

	// ================================================================
	// N1: 孤儿窗口防护——cancelled 任务在飞时 shutdown 补 SIGKILL
	// ================================================================
	describe("N1: 孤儿窗口——cancelled 任务在飞时 shutdown 应补 SIGKILL", () => {
		it("should SIGKILL a cancelled task's still-alive proc on session_shutdown", async () => {
			const { pi, executeTool } = setupExtension();
			const ctx = createMockTuiCtx(defaultCwd);

			// 1. Dispatch a task — status "running", proc spawned
			const executePromise = executeTool(
				"call-1",
				{ agent: "tester", task: "test task", sessionId: "019ffdd3-3eb5-733d-b481-a53e5292bd33" },
				undefined,
				undefined,
				ctx,
			);
			await raceWithTimeout(executePromise, 200);

			const proc = allProcs[0];
			expect(proc).toBeDefined();
			expect(taskRegistry.get("019ffdd3-3eb5-733d-b481-a53e5292bd33")!.status).toBe("running");

			// 2. Cancel the task → status becomes "cancelled", SIGTERM sent
			const cancelCommand = pi._commandDefs.get("subagent-cancel");
			await cancelCommand.handler("019ffdd3-3eb5-733d-b481-a53e5292bd33", { ui: { notify: vi.fn() } });

			expect(taskRegistry.get("019ffdd3-3eb5-733d-b481-a53e5292bd33")!.status).toBe("cancelled");
			expect(proc.kill).toHaveBeenCalledWith("SIGTERM");

			// Proc is still alive (mock doesn't auto-exit on kill)
			expect(proc.exitCode).toBeNull();
			expect(proc.signalCode).toBeNull();

			// 3. Trigger session_shutdown
			const shutdownHandlers = pi._eventHandlers.get("session_shutdown");
			await shutdownHandlers![0]({ type: "session_shutdown" });

			// The shutdown handler must SIGKILL the still-alive proc even though
			// the task was already cancelled (orphan-process protection).
			const killCalls = proc.kill.mock.calls.map((c: any[]) => c[0]);
			expect(killCalls).toContain("SIGKILL");
		});
	});

	// ================================================================
	// N2: B2 机制回归测试——shutdown 同步 SIGKILL + pre-spawn 窗口
	// ================================================================
	describe("N2: B2 机制——shutdown 同步 SIGKILL 与 pre-spawn 窗口", () => {
		it("should synchronously SIGKILL running task procs during shutdown handler", async () => {
			const { pi, executeTool } = setupExtension();
			const ctx = createMockTuiCtx(defaultCwd);

			const executePromise = executeTool(
				"call-1",
				{ agent: "tester", task: "test task", sessionId: "019ffdd3-3eb5-733d-b481-a53e5292bd34" },
				undefined,
				undefined,
				ctx,
			);
			await raceWithTimeout(executePromise, 200);

			const proc = allProcs[0];
			expect(proc).toBeDefined();

			// Clear any prior kill calls to isolate shutdown behavior
			proc.kill.mockClear();

			// Trigger session_shutdown
			const shutdownHandlers = pi._eventHandlers.get("session_shutdown");
			expect(shutdownHandlers).toBeDefined();

			// Before calling the handler, SIGKILL should NOT have been called
			expect(proc.kill).not.toHaveBeenCalled();

			// Call the handler
			await shutdownHandlers![0]({ type: "session_shutdown" });

			// After the handler, SIGKILL should have been called synchronously
			expect(proc.kill).toHaveBeenCalledWith("SIGKILL");
		});

		it("should SIGKILL proc spawned after shutdown via onProcSpawn backstop (pre-spawn window)", async () => {
			// This test verifies the B2 mechanism: when shutdown fires before
			// the proc is spawned (during writePromptToTempFile), the onProcSpawn
			// callback catches the late-born proc and SIGKILLs it.
			//
			// We mock writePromptToTempFile to pause, then trigger shutdown,
			// then resume the write, allowing spawn to happen. The onProcSpawn
			// callback should see status === "killed_on_shutdown" and SIGKILL.

			const { pi, executeTool } = setupExtension();
			const ctx = createMockTuiCtx(defaultCwd);

			// Create an agent with a non-empty systemPrompt to trigger writePromptToTempFile
			fs.writeFileSync(
				path.join(defaultCwd, ".pi", "agents", "prompter.md"),
				`---\nname: prompter\ndescription: Agent with prompt\n---\nYou are a helpful assistant.`,
				"utf-8",
			);

			// Mock fs.promises.mkdtemp to pause until we explicitly resolve
			let resumeMkdtemp!: (dir: string) => void;
			const mkdtempPause = new Promise<string>((resolve) => {
				resumeMkdtemp = resolve;
			});
			const originalMkdtemp = fs.promises.mkdtemp.bind(fs.promises);
			let mkdtempCalled = false;
			vi.spyOn(fs.promises, "mkdtemp").mockImplementation(((...args: any[]) => {
				const template = args[0] as string;
				if (template.includes("pi-subagent-")) {
					mkdtempCalled = true;
					return mkdtempPause;
				}
				return originalMkdtemp(template);
			}) as any);

			try {
				// Dispatch with the prompter agent → runSingleAgent starts,
				// hits writePromptToTempFile → mkdtemp is called and paused
				const executePromise = executeTool(
					"call-1",
					{ agent: "prompter", task: "test task", sessionId: "019ffdd3-3eb5-733d-b481-a53e5292bd35" },
					undefined,
					undefined,
					ctx,
				);
				await raceWithTimeout(executePromise, 200);

				// Wait for mkdtemp to be called (runSingleAgent reached writePromptToTempFile)
				await vi.waitFor(() => expect(mkdtempCalled).toBe(true), { timeout: 1000 });

				// No proc spawned yet (write is paused before spawn)
				expect(allProcs.length).toBe(0);
				expect(taskRegistry.get("019ffdd3-3eb5-733d-b481-a53e5292bd35")).toBeDefined();
				expect(taskRegistry.get("019ffdd3-3eb5-733d-b481-a53e5292bd35")!.status).toBe("running");

				// Trigger shutdown while in the pre-spawn window
				const shutdownHandlers = pi._eventHandlers.get("session_shutdown");
				await shutdownHandlers![0]({ type: "session_shutdown" });

				// Task status should now be "killed_on_shutdown"
				expect(taskRegistry.get("019ffdd3-3eb5-733d-b481-a53e5292bd35")!.status).toBe("killed_on_shutdown");

				// No proc yet — shutdown couldn't SIGKILL what doesn't exist
				expect(allProcs.length).toBe(0);

				// Now resume the temp file write → spawn happens → onProcSpawn fires
				const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "n2-resume-"));
				resumeMkdtemp(tmpDir);

				// Let the async chain proceed through writeFile → spawn → onProcSpawn
				await vi.waitFor(() => expect(allProcs.length).toBe(1), { timeout: 2000 });

				// The onProcSpawn callback should have seen "killed_on_shutdown"
				// and sent SIGKILL to the newly spawned proc
				const proc = allProcs[0];
				expect(proc.kill).toHaveBeenCalledWith("SIGKILL");
			} finally {
				vi.restoreAllMocks();
			}
		});
	});

	// ================================================================
	// N5: validateSessionId 回归防护
	// ================================================================
	describe("N5: validateSessionId 回归防护", () => {
		it("should reject non-UUID sessionId with the resume-from-receipt contract", async () => {
			const { executeTool } = setupExtension();
			const ctx = createMockTuiCtx(defaultCwd);

			const result = await executeTool(
				"call-1",
				{ agent: "tester", task: "test task", sessionId: "bad@session#id!" },
				undefined,
				undefined,
				ctx,
			);

			expect(result.isError).toBe(true);
			const text = result.content[0].text;
			expect(text).toMatch(/sessionId/i);
			expect(text).not.toMatch(/\bUUID\s?v7\b/i);
			expect(text).not.toMatch(/lowercase/i);
			expect(text).toMatch(/receipt|resume/i);
		});

		it('should reject sessionId "." and ".."', async () => {
			const { executeTool } = setupExtension();
			const ctx = createMockTuiCtx(defaultCwd);

			const dotResult = await executeTool(
				"call-1",
				{ agent: "tester", task: "test task", sessionId: "." },
				undefined,
				undefined,
				ctx,
			);
			expect(dotResult.isError).toBe(true);
			expect(dotResult.content[0].text).toMatch(/not allowed|invalid/i);

			const dotDotResult = await executeTool(
				"call-2",
				{ agent: "tester", task: "test task", sessionId: ".." },
				undefined,
				undefined,
				ctx,
			);
			expect(dotDotResult.isError).toBe(true);
			expect(dotDotResult.content[0].text).toMatch(/not allowed|invalid/i);
		});

		it("should accept a UUID v7 sessionId with leading/trailing whitespace after trim normalization", async () => {
			const { executeTool } = setupExtension();
			const ctx = createMockTuiCtx(defaultCwd);

			const validV7 = "019ffdd3-3eb5-733d-b481-a53e5292bd36";
			const result = await executeTool(
				"call-1",
				{ agent: "tester", task: "test task", sessionId: `  ${validV7}  ` },
				undefined,
				undefined,
				ctx,
			);

			// Should succeed — trim() normalizes to the UUID v7
			expect(result.isError).toBeFalsy();
			expect(result.content[0].text).toMatch(/dispatched/i);
			// The trimmed sessionId should be used as the task key
			expect(taskRegistry.has(validV7)).toBe(true);
		});
	});
});
