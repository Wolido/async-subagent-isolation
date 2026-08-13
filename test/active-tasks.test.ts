/**
 * Tests for active tasks tracking (单入口 action 模式: subagent action=status,
 * envelope active list, cancel return)
 *
 * 契约：subagent_status / subagent_cancel 独立工具已移除，
 * status/cancel 由 subagent 工具 action 参数分派。
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

describe("在途任务台账", () => {
	let tmpBase: string;
	let agentDir: string;
	let defaultCwd: string;
	let savedEnv: Record<string, string | undefined>;
	let allProcs: ReturnType<typeof createControllableProc>[];

	beforeEach(() => {
		vi.useFakeTimers();
		taskRegistry.clear();

		tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "active-tasks-test-"));
		agentDir = path.join(tmpBase, "agent-dir");
		defaultCwd = path.join(tmpBase, "default-cwd");
		writeAgentFile(defaultCwd);
		fs.mkdirSync(agentDir, { recursive: true });
		vi.mocked(getAgentDir).mockReturnValue(agentDir);

		allProcs = [];
		vi.mocked(spawn).mockImplementation((() => {
			const proc = createControllableProc();
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
		// 新契约：status/cancel 通过 subagent 工具的 action 参数分派
		const executeStatusTool = (
			toolCallId: string,
			params: Record<string, unknown>,
			signal: AbortSignal | undefined,
			onUpdate: unknown,
			ctx: unknown,
		) => executeSubagentTool!(toolCallId, { action: "status", ...params }, signal, onUpdate, ctx);
		const executeCancelTool = (
			toolCallId: string,
			params: Record<string, unknown>,
			signal: AbortSignal | undefined,
			onUpdate: unknown,
			ctx: unknown,
		) => executeSubagentTool!(toolCallId, { action: "cancel", ...params }, signal, onUpdate, ctx);
		return { pi, executeSubagentTool, executeStatusTool, executeCancelTool, toolsByName };
	}

	// ================================================================
	// 1. 单入口 action 参数（新契约）
	// ================================================================
	describe("1. 单入口 action 参数（新契约）", () => {
		it("subagent 工具 parameters 应声明 action 字段", () => {
			const { toolsByName } = setupExtension();

			const subagent = toolsByName.get("subagent");
			expect(subagent, "subagent tool should be registered").toBeDefined();
			const props = subagent.parameters.properties || {};
			expect(props.action, "subagent parameters should declare an action field").toBeDefined();
		});

		it("subagent_status 工具不应再单独注册", () => {
			const { toolsByName } = setupExtension();
			expect(toolsByName.has("subagent_status")).toBe(false);
		});

		it("subagent_cancel 工具不应再单独注册", () => {
			const { toolsByName } = setupExtension();
			expect(toolsByName.has("subagent_cancel")).toBe(false);
		});
	});

	// ================================================================
	// 2. 查询在途列表（action=status）
	// ================================================================
	describe("2. 查询在途列表（action=status）", () => {
		it("应返回在途任务的 taskId、agent 名、任务描述", async () => {
			const { executeSubagentTool, executeStatusTool } = setupExtension();
			expect(executeStatusTool, "subagent tool should be registered (status dispatched via action param)").toBeDefined();
			const ctx = createMockTuiCtx(defaultCwd);

			// Arrange: dispatch 2 tasks
			const executePromise1 = executeSubagentTool!(
				"call-1",
				{ agent: "tester", task: "调研 XX 方案", sessionId: "task-1" },
				undefined,
				undefined,
				ctx,
			);
			await raceWithTimeout(executePromise1, 200);

			const executePromise2 = executeSubagentTool!(
				"call-2",
				{ agent: "tester", task: "重构认证中间件", sessionId: "task-2" },
				undefined,
				undefined,
				ctx,
			);
			await raceWithTimeout(executePromise2, 200);

			expect(taskRegistry.size).toBe(2);

			// Act: query status
			const result = await executeStatusTool!("call-3", {}, undefined, undefined, ctx);

			// Assert: should contain both taskIds, agent names, and task descriptions
			const text = result.content.map((c: any) => c.text).join("");
			expect(text).toContain("task-1");
			expect(text).toContain("task-2");
			expect(text).toContain("tester");
			expect(text).toMatch(/调研 XX 方案/);
			expect(text).toMatch(/重构认证中间件/);
		});

		it("不应包含耗时格式（如 00: 或 已运行）", async () => {
			const { executeSubagentTool, executeStatusTool } = setupExtension();
			expect(executeStatusTool, "subagent tool should be registered (status dispatched via action param)").toBeDefined();
			const ctx = createMockTuiCtx(defaultCwd);

			// Arrange: dispatch a task
			const executePromise = executeSubagentTool!(
				"call-1",
				{ agent: "tester", task: "测试任务", sessionId: "no-elapsed" },
				undefined,
				undefined,
				ctx,
			);
			await raceWithTimeout(executePromise, 200);

			// Act: query status
			const result = await executeStatusTool!("call-2", {}, undefined, undefined, ctx);

			// Assert: NOT an error response, and should NOT contain elapsed time format
			expect(result.isError).toBeFalsy();
			const text = result.content.map((c: any) => c.text).join("");
			expect(text).not.toMatch(/\d{2}:\d{2}/); // No MM:SS format
			expect(text).not.toMatch(/已运行/);
		});

		it("应只列 status === 'running' 的任务", async () => {
			const { executeSubagentTool, executeStatusTool, executeCancelTool } = setupExtension();
			expect(executeStatusTool, "subagent tool should be registered (status dispatched via action param)").toBeDefined();
			expect(executeCancelTool, "subagent tool should be registered (cancel dispatched via action param)").toBeDefined();
			const ctx = createMockTuiCtx(defaultCwd);

			// Arrange: dispatch 2 tasks
			const executePromise1 = executeSubagentTool!(
				"call-1",
				{ agent: "tester", task: "任务1", sessionId: "running-task" },
				undefined,
				undefined,
				ctx,
			);
			await raceWithTimeout(executePromise1, 200);

			const executePromise2 = executeSubagentTool!(
				"call-2",
				{ agent: "tester", task: "任务2", sessionId: "to-cancel" },
				undefined,
				undefined,
				ctx,
			);
			await raceWithTimeout(executePromise2, 200);

			// Cancel one task
			await executeCancelTool!("call-3", { taskId: "to-cancel" }, undefined, undefined, ctx);

			// Act: query status
			const result = await executeStatusTool!("call-4", {}, undefined, undefined, ctx);

			// Assert: should only contain the running task
			const text = result.content.map((c: any) => c.text).join("");
			expect(text).toContain("running-task");
			expect(text).not.toContain("to-cancel");
		});
	});

	// ================================================================
	// 3. 空在途
	// ================================================================
	describe("3. 空在途", () => {
		it("注册表为空时应返回'当前无在途任务'", async () => {
			const { executeStatusTool } = setupExtension();
			expect(executeStatusTool, "subagent tool should be registered (status dispatched via action param)").toBeDefined();
			const ctx = createMockTuiCtx(defaultCwd);

			expect(taskRegistry.size).toBe(0);

			// Act
			const result = await executeStatusTool!("call-1", {}, undefined, undefined, ctx);

			// Assert
			const text = result.content.map((c: any) => c.text).join("");
			expect(text).toMatch(/当前无在途任务/);
		});
	});

	// ================================================================
	// 4. 信封带在途列表
	// ================================================================
	describe("4. 信封带在途列表", () => {
		it("完成通知信封应含'在途任务: N'及在途任务信息", async () => {
			const { executeSubagentTool, pi } = setupExtension();
			const ctx = createMockTuiCtx(defaultCwd);

			// Arrange: dispatch 2 tasks
			const executePromise1 = executeSubagentTool!(
				"call-1",
				{ agent: "tester", task: "任务1", sessionId: "completing-task" },
				undefined,
				undefined,
				ctx,
			);
			await raceWithTimeout(executePromise1, 200);

			const executePromise2 = executeSubagentTool!(
				"call-2",
				{ agent: "tester", task: "任务2", sessionId: "remaining-task" },
				undefined,
				undefined,
				ctx,
			);
			await raceWithTimeout(executePromise2, 200);

			expect(taskRegistry.size).toBe(2);

			// Act: complete the first task
			endProcess(allProcs[0], 0);
			await vi.advanceTimersByTimeAsync(1000);

			// Assert: envelope should contain active tasks list
			expect(pi.sendMessage).toHaveBeenCalled();
			const [message] = pi._sendMessageCalls[0];
			const content: string = message.content;
			
			expect(content).toMatch(/在途任务:\s*1/);
			expect(content).toContain("remaining-task");
			expect(content).toContain("tester");
			expect(content).toMatch(/任务2/);
		});

		it("信封在途列表应排除刚完成的任务自己", async () => {
			const { executeSubagentTool, pi } = setupExtension();
			const ctx = createMockTuiCtx(defaultCwd);

			// Arrange: dispatch a task
			const executePromise = executeSubagentTool!(
				"call-1",
				{ agent: "tester", task: "测试任务", sessionId: "self-exclude" },
				undefined,
				undefined,
				ctx,
			);
			await raceWithTimeout(executePromise, 200);

			expect(taskRegistry.size).toBe(1);

			// Act: complete the task
			endProcess(allProcs[0], 0);
			await vi.advanceTimersByTimeAsync(1000);

			// Assert: envelope should show 0 active tasks (self excluded)
			expect(pi.sendMessage).toHaveBeenCalled();
			const [message] = pi._sendMessageCalls[0];
			const content: string = message.content;
			
			// Should contain "在途任务: 0" (or no active tasks section if 0)
			expect(content).toMatch(/在途任务:\s*0|当前无在途任务/);
			
			// The header contains the completed task's ID, but the active tasks list should not
			// Check that "self-exclude" appears in header but not in active tasks section
			const lines = content.split("\n");
			const activeTasksSection = lines.filter(l => l.match(/^- .* \(.*\):/)); // Lines like "- taskId (agent): task"
			
			// Active tasks section should not contain the completed task's ID
			for (const line of activeTasksSection) {
				expect(line).not.toContain("self-exclude");
			}
		});
	});

	// ================================================================
	// 5. action=cancel 返回在途列表
	// ================================================================
	describe("5. action=cancel 返回在途列表", () => {
		it("取消成功后应返回剩余在途任务信息", async () => {
			const { executeSubagentTool, executeCancelTool } = setupExtension();
			expect(executeCancelTool, "subagent tool should be registered (cancel dispatched via action param)").toBeDefined();
			const ctx = createMockTuiCtx(defaultCwd);

			// Arrange: dispatch 2 tasks
			const executePromise1 = executeSubagentTool!(
				"call-1",
				{ agent: "tester", task: "任务1", sessionId: "to-cancel" },
				undefined,
				undefined,
				ctx,
			);
			await raceWithTimeout(executePromise1, 200);

			const executePromise2 = executeSubagentTool!(
				"call-2",
				{ agent: "tester", task: "任务2", sessionId: "remaining" },
				undefined,
				undefined,
				ctx,
			);
			await raceWithTimeout(executePromise2, 200);

			expect(taskRegistry.size).toBe(2);

			// Act: cancel the first task
			const result = await executeCancelTool!("call-3", { taskId: "to-cancel" }, undefined, undefined, ctx);

			// Assert: return value should contain remaining active tasks
			const text = result.content.map((c: any) => c.text).join("");
			expect(text).toMatch(/在途任务/);
			expect(text).toContain("remaining");
			expect(text).toContain("tester");
			expect(text).toMatch(/任务2/);
		});

		it("取消后在途列表应排除被取消的任务", async () => {
			const { executeSubagentTool, executeCancelTool } = setupExtension();
			expect(executeCancelTool, "subagent tool should be registered (cancel dispatched via action param)").toBeDefined();
			const ctx = createMockTuiCtx(defaultCwd);

			// Arrange: dispatch 2 tasks
			const executePromise1 = executeSubagentTool!(
				"call-1",
				{ agent: "tester", task: "任务1", sessionId: "cancel-me" },
				undefined,
				undefined,
				ctx,
			);
			await raceWithTimeout(executePromise1, 200);

			const executePromise2 = executeSubagentTool!(
				"call-2",
				{ agent: "tester", task: "任务2", sessionId: "keep-me" },
				undefined,
				undefined,
				ctx,
			);
			await raceWithTimeout(executePromise2, 200);

			// Act: cancel the first task
			const result = await executeCancelTool!("call-3", { taskId: "cancel-me" }, undefined, undefined, ctx);

			// Assert: should contain "keep-me" but not "cancel-me" in active tasks
			const text = result.content.map((c: any) => c.text).join("");
			expect(text).toContain("keep-me");
			
			// Check that "cancel-me" is not in the active tasks section
			const lines = text.split("\n");
			const activeTasksSection = lines.filter(l => l.match(/^- .* \(.*\):/));
			for (const line of activeTasksSection) {
				expect(line).not.toContain("cancel-me");
			}
		});
	});

	// ================================================================
	// 6. 回归锁定：现有测试应保持绿
	// ================================================================
	describe("6. 回归锁定：现有信封断言兼容性", () => {
		it("现有信封应仍包含 taskId、状态、任务描述等核心信息", async () => {
			const { executeSubagentTool, pi } = setupExtension();
			const ctx = createMockTuiCtx(defaultCwd);

			// Arrange: dispatch a task
			const executePromise = executeSubagentTool!(
				"call-1",
				{ agent: "tester", task: "回归测试任务", sessionId: "regression-envelope" },
				undefined,
				undefined,
				ctx,
			);
			await raceWithTimeout(executePromise, 200);

			// Act: complete the task
			endProcess(allProcs[0], 0);
			await vi.advanceTimersByTimeAsync(1000);

			// Assert: envelope should still contain all existing fields
			expect(pi.sendMessage).toHaveBeenCalled();
			const [message] = pi._sendMessageCalls[0];
			const content: string = message.content;
			
			// Existing envelope structure should be preserved
			expect(content).toContain("[subagent-result]");
			expect(content).toContain("regression-envelope"); // taskId
			expect(content).toContain("tester"); // agent name
			expect(content).toContain("状态:"); // status field
			expect(content).toContain("任务:"); // task field
			expect(content).toMatch(/回归测试任务/); // task description
			
			// New active tasks section should be added (even if 0)
			expect(content).toMatch(/在途任务|当前无在途任务/);
		});

		it("取消信封应仍包含 cancelledBy 字段", async () => {
			const { executeSubagentTool, executeCancelTool, pi } = setupExtension();
			expect(executeCancelTool, "subagent tool should be registered (cancel dispatched via action param)").toBeDefined();
			const ctx = createMockTuiCtx(defaultCwd);

			// Arrange: dispatch a task
			const executePromise = executeSubagentTool!(
				"call-1",
				{ agent: "tester", task: "取消测试", sessionId: "regression-cancel" },
				undefined,
				undefined,
				ctx,
			);
			await raceWithTimeout(executePromise, 200);

			// Act: cancel via tool
			await executeCancelTool!("call-2", { taskId: "regression-cancel" }, undefined, undefined, ctx);
			endProcess(allProcs[0], null, "SIGTERM");
			await vi.advanceTimersByTimeAsync(1000);

			// Assert: envelope should still have cancelledBy
			expect(pi.sendMessage).toHaveBeenCalled();
			const [message] = pi._sendMessageCalls[0];
			expect(message.details.cancelledBy).toBe("agent");
			
			// And should contain active tasks section
			const content: string = message.content;
			expect(content).toMatch(/在途任务|当前无在途任务/);
		});
	});
});
