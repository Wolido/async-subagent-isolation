/**
 * Red-phase tests for subagent_cancel tool
 *
 * Verifies the main agent can cancel tasks via a subagent_cancel tool
 * (parallel to /subagent-cancel command, with cancelledBy="agent" in envelope).
 *
 * Expected failures (red phase):
 * - Tool does not exist yet
 * - cancelledBy field does not exist on details / task record
 * - Agent cancel body text does not exist
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

function writeAgentFile(cwd: string) {
	fs.mkdirSync(path.join(cwd, ".pi", "agents"), { recursive: true });
	fs.writeFileSync(
		path.join(cwd, ".pi", "agents", "tester.md"),
		`---\nname: tester\ndescription: Test agent\n---\n`,
		"utf-8",
	);
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

describe("subagent_cancel 工具 — 红阶段测试", () => {
	let tmpBase: string;
	let agentDir: string;
	let defaultCwd: string;
	let savedEnv: Record<string, string | undefined>;
	let procRef: ReturnType<typeof createControllableProc> | null;
	let allProcs: ReturnType<typeof createControllableProc>[];

	beforeEach(() => {
		vi.useFakeTimers();
		taskRegistry.clear();

		tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "subagent-cancel-tool-test-"));
		agentDir = path.join(tmpBase, "agent-dir");
		defaultCwd = path.join(tmpBase, "default-cwd");
		writeAgentFile(defaultCwd);
		fs.mkdirSync(agentDir, { recursive: true });
		vi.mocked(getAgentDir).mockReturnValue(agentDir);

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
		delete process.env.PI_CURRENT_AGENT_NAME;
		delete process.env.PI_CAN_DELEGATE;
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
		const executeSubagentTool = toolsByName.get("subagent")?.execute as ExecuteFn | undefined;
		const executeCancelTool = toolsByName.get("subagent_cancel")?.execute as ExecuteFn | undefined;
		return { pi, executeSubagentTool, executeCancelTool, toolsByName };
	}

	// ================================================================
	// 1. subagent_cancel 工具注册
	// ================================================================
	describe("1. subagent_cancel 工具注册", () => {
		it('扩展应注册名为 "subagent_cancel" 的工具', () => {
			const { pi, toolsByName } = setupExtension();

			expect(pi.registerTool).toHaveBeenCalled();
			expect(toolsByName.has("subagent_cancel")).toBe(true);
		});
	});

	// ================================================================
	// 2. 工具取消行为
	// ================================================================
	describe("2. 工具取消行为（kill + 信封 cancelledBy=agent + agent 正文）", () => {
		it("调用 subagent_cancel 后子进程应被 SIGTERM（kill 调用）且任务状态变为 cancelled", async () => {
			const { executeSubagentTool, executeCancelTool } = setupExtension();
			expect(executeCancelTool, "subagent_cancel tool should be registered").toBeDefined();
			const ctx = createMockTuiCtx(defaultCwd);

			// Arrange: dispatch a task
			const executePromise = executeSubagentTool!(
				"call-1",
				{ agent: "tester", task: "test task", sessionId: "tool-cancel-kill" },
				undefined,
				undefined,
				ctx,
			);
			await raceWithTimeout(executePromise, 200);

			expect(taskRegistry.has("tool-cancel-kill")).toBe(true);
			const proc = allProcs[0];
			expect(proc).toBeDefined();

			// Act: cancel via tool
			await executeCancelTool!("call-2", { taskId: "tool-cancel-kill" }, undefined, undefined, ctx);

			// Assert: task status is cancelled and abort was triggered (SIGTERM sent)
			expect(taskRegistry.get("tool-cancel-kill")?.status).toBe("cancelled");
			expect(proc.kill).toHaveBeenCalledWith("SIGTERM");
		});

		it("调用 subagent_cancel 后信封 details 应含 cancelledBy='agent'", async () => {
			const { executeSubagentTool, executeCancelTool, pi } = setupExtension();
			expect(executeCancelTool, "subagent_cancel tool should be registered").toBeDefined();
			const ctx = createMockTuiCtx(defaultCwd);

			// Arrange: dispatch a task
			const executePromise = executeSubagentTool!(
				"call-1",
				{ agent: "tester", task: "test task", sessionId: "tool-cancel-envelope" },
				undefined,
				undefined,
				ctx,
			);
			await raceWithTimeout(executePromise, 200);

			// Act: cancel via tool
			await executeCancelTool!("call-2", { taskId: "tool-cancel-envelope" }, undefined, undefined, ctx);

			// Drive the abort cascade → completeAsyncTask → sendMessage
			endProcess(allProcs[0], null, "SIGTERM");
			await vi.advanceTimersByTimeAsync(1000);

			// Assert: envelope sent with cancelled status and cancelledBy=agent
			expect(pi.sendMessage).toHaveBeenCalled();
			const [message] = pi._sendMessageCalls[0];
			expect(message.customType).toBe("subagent-result");
			expect(message.details.cancelledBy).toBe("agent");
		});

		it('调用 subagent_cancel 后信封正文应含"主 agent"与"subagent_cancel"字样', async () => {
			const { executeSubagentTool, executeCancelTool, pi } = setupExtension();
			expect(executeCancelTool, "subagent_cancel tool should be registered").toBeDefined();
			const ctx = createMockTuiCtx(defaultCwd);

			// Arrange
			const executePromise = executeSubagentTool!(
				"call-1",
				{ agent: "tester", task: "test task", sessionId: "tool-cancel-body" },
				undefined,
				undefined,
				ctx,
			);
			await raceWithTimeout(executePromise, 200);

			// Act
			await executeCancelTool!("call-2", { taskId: "tool-cancel-body" }, undefined, undefined, ctx);

			endProcess(allProcs[0], null, "SIGTERM");
			await vi.advanceTimersByTimeAsync(1000);

			// Assert
			expect(pi.sendMessage).toHaveBeenCalled();
			const [message] = pi._sendMessageCalls[0];
			const content: string = message.content;
			expect(content).toMatch(/主\s*agent/);
			expect(content).toMatch(/subagent_cancel/);
		});

		it("subagent_cancel 应返回成功回执，确认任务已取消", async () => {
			const { executeSubagentTool, executeCancelTool } = setupExtension();
			expect(executeCancelTool, "subagent_cancel tool should be registered").toBeDefined();
			const ctx = createMockTuiCtx(defaultCwd);

			// Arrange
			const executePromise = executeSubagentTool!(
				"call-1",
				{ agent: "tester", task: "test task", sessionId: "tool-cancel-receipt" },
				undefined,
				undefined,
				ctx,
			);
			await raceWithTimeout(executePromise, 200);

			// Act
			const result = await executeCancelTool!("call-2", { taskId: "tool-cancel-receipt" }, undefined, undefined, ctx);

			// Assert: not an error, content mentions the taskId
			expect(result.isError).toBeFalsy();
			const text = result.content.map((c: any) => c.text).join("");
			expect(text).toMatch(/tool-cancel-receipt/);
			expect(text).toMatch(/cancel|取消/);
		});
	});

	// ================================================================
	// 3. 命令路径来源不变（user）
	// ================================================================
	describe("3. 命令路径来源不变（/subagent-cancel → cancelledBy='user'）", () => {
		it('/subagent-cancel 命令取消后信封 details 应含 cancelledBy="user"', async () => {
			const { executeSubagentTool: executeTool, pi } = setupExtension();
			const ctx = createMockTuiCtx(defaultCwd);

			// Arrange: dispatch a task
			const executePromise = executeTool!(
				"call-1",
				{ agent: "tester", task: "test task", sessionId: "user-cancel-cb" },
				undefined,
				undefined,
				ctx,
			);
			await raceWithTimeout(executePromise, 200);

			// Act: cancel via command
			const cancelCommand = pi._commandDefs.get("subagent-cancel");
			expect(cancelCommand).toBeDefined();
			await cancelCommand.handler("user-cancel-cb", { ui: { notify: vi.fn() } });

			endProcess(allProcs[0], null, "SIGTERM");
			await vi.advanceTimersByTimeAsync(1000);

			// Assert: envelope details.cancelledBy should be "user"
			expect(pi.sendMessage).toHaveBeenCalled();
			const [message] = pi._sendMessageCalls[0];
			expect(message.details.cancelledBy).toBe("user");
		});

		it("/subagent-cancel 命令取消后信封正文应保持现有用户文案", async () => {
			const { executeSubagentTool: executeTool, pi } = setupExtension();
			const ctx = createMockTuiCtx(defaultCwd);

			// Arrange
			const executePromise = executeTool!(
				"call-1",
				{ agent: "tester", task: "test task", sessionId: "user-cancel-body-lock" },
				undefined,
				undefined,
				ctx,
			);
			await raceWithTimeout(executePromise, 200);

			// Act
			const cancelCommand = pi._commandDefs.get("subagent-cancel");
			await cancelCommand.handler("user-cancel-body-lock", { ui: { notify: vi.fn() } });

			endProcess(allProcs[0], null, "SIGTERM");
			await vi.advanceTimersByTimeAsync(1000);

			// Assert: body should still contain user-cancel semantics
			expect(pi.sendMessage).toHaveBeenCalled();
			const [message] = pi._sendMessageCalls[0];
			const content: string = message.content;
			expect(content).toMatch(/用户.*取消|取消.*用户|\/subagent-cancel/);
		});
	});

	// ================================================================
	// 4. 工具取消不存在任务
	// ================================================================
	describe("4. 工具取消不存在任务", () => {
		it("subagent_cancel 传入不存在的 taskId → isError 或错误提示", async () => {
			const { executeCancelTool } = setupExtension();
			expect(executeCancelTool, "subagent_cancel tool should be registered").toBeDefined();

			const ctx = createMockTuiCtx(defaultCwd);

			const result = await executeCancelTool!(
				"call-1",
				{ taskId: "non-existent-task-id" },
				undefined,
				undefined,
				ctx,
			);

			// Should be an error or contain error message
			const isErrorResponse = result.isError === true;
			const text = result.content.map((c: any) => c.text).join("");
			const hasErrorText = /not found|不存在|no.*task|no.*running/i.test(text);

			expect(isErrorResponse || hasErrorText).toBe(true);
		});

		it("subagent_cancel 传入空 taskId → isError 或错误提示", async () => {
			const { executeCancelTool } = setupExtension();
			expect(executeCancelTool, "subagent_cancel tool should be registered").toBeDefined();

			const ctx = createMockTuiCtx(defaultCwd);

			const result = await executeCancelTool!(
				"call-1",
				{ taskId: "" },
				undefined,
				undefined,
				ctx,
			);

			const isErrorResponse = result.isError === true;
			const text = result.content.map((c: any) => c.text).join("");
			const hasErrorText = /required|missing|empty|必填|缺少|不能为空/i.test(text);

			expect(isErrorResponse || hasErrorText).toBe(true);
		});
	});

	// ================================================================
	// 5. 防滥用引导
	// ================================================================
	describe("5. 防滥用引导", () => {
		it('subagent_cancel 工具的 description 应包含"取消"字样', () => {
			const { toolsByName } = setupExtension();
			const cancelTool = toolsByName.get("subagent_cancel");
			expect(cancelTool, "subagent_cancel tool should be registered").toBeDefined();
			expect(cancelTool.description).toMatch(/取消|cancel/i);
		});

		it('subagent_cancel 工具的 description 应包含"错误"或"不再需要"类引导', () => {
			const { toolsByName } = setupExtension();
			const cancelTool = toolsByName.get("subagent_cancel");
			expect(cancelTool, "subagent_cancel tool should be registered").toBeDefined();
			expect(cancelTool.description).toMatch(/错误|不再需要|wrong|no longer needed|unnecessary/i);
		});

		it("subagent_cancel 工具的 description 应包含不要因等待时间长而取消的引导", () => {
			const { toolsByName } = setupExtension();
			const cancelTool = toolsByName.get("subagent_cancel");
			expect(cancelTool, "subagent_cancel tool should be registered").toBeDefined();
			expect(cancelTool.description).toMatch(/等待|wait|时间长|long.*time|slow|patience/i);
		});
	});

	// ================================================================
	// 6. 回归锁定：用户取消路径现有测试保持绿
	// ================================================================
	describe("6. 回归锁定：用户取消路径", () => {
		it("用户取消后信封状态应为「已取消」（cancelled）", async () => {
			const { executeSubagentTool: executeTool, pi } = setupExtension();
			const ctx = createMockTuiCtx(defaultCwd);

			const executePromise = executeTool!(
				"call-1",
				{ agent: "tester", task: "test task", sessionId: "regression-user-cancel" },
				undefined,
				undefined,
				ctx,
			);
			await raceWithTimeout(executePromise, 200);

			const cancelCommand = pi._commandDefs.get("subagent-cancel");
			await cancelCommand.handler("regression-user-cancel", { ui: { notify: vi.fn() } });

			endProcess(allProcs[0], null, "SIGTERM");
			await vi.advanceTimersByTimeAsync(1000);

			expect(pi.sendMessage).toHaveBeenCalled();
			const [message] = pi._sendMessageCalls[0];
			expect(message.customType).toBe("subagent-result");
			// 状态词为"已取消" (cancelled status word in the content)
			expect(message.content).toMatch(/已取消/);
		});

		it("用户取消后 /subagent-cancel 命令仍然正常工作（功能不退化）", async () => {
			const { executeSubagentTool: executeTool, pi } = setupExtension();
			const ctx = createMockTuiCtx(defaultCwd);

			const executePromise = executeTool!(
				"call-1",
				{ agent: "tester", task: "test task", sessionId: "regression-cmd-works" },
				undefined,
				undefined,
				ctx,
			);
			await raceWithTimeout(executePromise, 200);

			const cancelCommand = pi._commandDefs.get("subagent-cancel");
			expect(cancelCommand).toBeDefined();

			const notifyMock = vi.fn();
			await cancelCommand.handler("regression-cmd-works", { ui: { notify: notifyMock } });

			// Task status should be cancelled
			expect(taskRegistry.get("regression-cmd-works")?.status).toBe("cancelled");
			// Command should emit info notification
			expect(notifyMock).toHaveBeenCalledWith(
				expect.stringContaining("regression-cmd-works"),
				"info",
			);
		});
	});
});
