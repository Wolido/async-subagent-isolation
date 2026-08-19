/**
 * Tests for active tasks tracking (单入口 action 模式: envelope active list,
 * cancel return)
 *
 * 契约：subagent_status / subagent_cancel 独立工具已移除，
 * cancel 由 subagent 工具 action 参数分派。
 *
 * 变更（v1.2.0）：action="status" 已从工具面移除。
 * §2/§3 为负向契约（RED）：status 一律被拒绝，不得返回在途列表。
 * §4/5/6 为共享面（在途块仍由信封与 cancel 回执共享 formatActiveTasks()），不动。
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

// ---------------------------------------------------------------------------
// S2 事件锚定措辞断言助手（锁语义不锁字面；按行匹配防跨行假绿）
// ---------------------------------------------------------------------------

/** 时钟时间模式（H:MM:SS 或 MM:SS）——在途块刻意不含任何时间信息。 */
const CLOCK_TIME = /\d{1,2}:\d{2}(:\d{2})?/;
/** 旧绝对句式（S2 要求移除）。 */
const ABSOLUTE_EMPTY_WORDING = /No tasks? (are|were) (currently )?in flight/i;

/** 从信封正文提取在途块（"- 会话:" 行与 "---" 分隔线之间即 formatActiveTasks() 输出）。 */
function extractInFlightBlock(content: string): string {
	const m = content.match(/- Session:[^\n]*\n+([\s\S]*?)\n+---/);
	return m ? m[1] : "";
}

/**
 * 在途块内是否存在"事件锚定"行：同一行同时含 (a) 对本信封所属任务的指代、
 * (b) 结束事件词、(c) 在途语义。empty=true 时还要求同行含否定词；empty=false
 * 时要求锚定行不含否定词（非空时不得谎称"无在途"）。
 */
function hasEventAnchoredLine(block: string, empty: boolean): boolean {
	return block.split("\n").some((line) => {
		const anchored = /this task/.test(line) && /ended|finished|completed/.test(line) && /in[- ]flight/.test(line);
		if (!anchored) return false;
		const negated = /no |none/i.test(line);
		return empty ? negated : !negated;
	});
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
		// 新契约：cancel 通过 subagent 工具的 action 参数分派
		// （status 已从工具面移除 —— 负向契约测试直接以 { action: "status" } 调用 executeSubagentTool）
		const executeCancelTool = (
			toolCallId: string,
			params: Record<string, unknown>,
			signal: AbortSignal | undefined,
			onUpdate: unknown,
			ctx: unknown,
		) => executeSubagentTool!(toolCallId, { action: "cancel", ...params }, signal, onUpdate, ctx);
		return { pi, executeSubagentTool, executeCancelTool, toolsByName };
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
	// 2. 查询在途列表已移除：action=status 负向契约（RED）
	// ================================================================
	describe("2. action=status 必须被拒绝（负向契约：status 已从工具面移除）", () => {
		it("有在途任务时 action=status 必须拒绝，且回执不得返回任何 taskId/agent/任务描述（RED：当前返回在途列表）", async () => {
			const { executeSubagentTool } = setupExtension();
			const ctx = createMockTuiCtx(defaultCwd);

			// Arrange: dispatch 2 tasks
			const executePromise1 = executeSubagentTool!(
				"call-1",
				{ agent: "tester", task: "调研 XX 方案", sessionId: "019ffdd3-3eb5-733d-b481-a53e5292bd11" },
				undefined,
				undefined,
				ctx,
			);
			await raceWithTimeout(executePromise1, 200);

			const executePromise2 = executeSubagentTool!(
				"call-2",
				{ agent: "tester", task: "重构认证中间件", sessionId: "019ffdd3-3eb5-733d-b481-a53e5292bd12" },
				undefined,
				undefined,
				ctx,
			);
			await raceWithTimeout(executePromise2, 200);

			expect(taskRegistry.size).toBe(2);

			// Act: status 已移除 —— 必须被拒绝
			const result = await executeSubagentTool!("call-3", { action: "status" }, undefined, undefined, ctx);

			// Assert: 拒绝（isError + Invalid action），且回执不得暴露在途列表信息
			expect(result.isError).toBe(true);
			const text = result.content.map((c: any) => c.text).join("");
			expect(text).toMatch(/Invalid action/);
			expect(text).not.toMatch(/in[- ]flight/i);
			expect(text).not.toContain("019ffdd3-3eb5-733d-b481-a53e5292bd11");
			expect(text).not.toContain("019ffdd3-3eb5-733d-b481-a53e5292bd12");
			expect(text).not.toMatch(/调研 XX 方案/);
			expect(text).not.toMatch(/重构认证中间件/);
		});

		it("action=status 即使携带 agent/task 也必须拒绝（与未知 action 同等强度，不得分派，RED）", async () => {
			const { executeSubagentTool } = setupExtension();
			const ctx = createMockTuiCtx(defaultCwd);

			// Act: status 不得被当作 dispatch 或任何有效 action 处理
			const result = await executeSubagentTool!(
				"call-1",
				{ action: "status", agent: "tester", task: "x" },
				undefined,
				undefined,
				ctx,
			);

			// Assert: 拒绝分支在分派之前返回 —— 不得 spawn 子进程，不得写入任务注册表
			expect(result.isError).toBe(true);
			const text = result.content.map((c: any) => c.text).join("");
			expect(text).toMatch(/Invalid action/);
			expect(spawn).not.toHaveBeenCalled();
			expect(taskRegistry.size).toBe(0);
		});

		it("任务处于 running 或 cancelled 状态时 action=status 一律拒绝（不再有「只列 running」语义，RED）", async () => {
			const { executeSubagentTool, executeCancelTool } = setupExtension();
			const ctx = createMockTuiCtx(defaultCwd);

			// Arrange: dispatch 2 tasks, cancel one —— 注册表同时含 running 与 cancelled
			const executePromise1 = executeSubagentTool!(
				"call-1",
				{ agent: "tester", task: "任务1", sessionId: "019ffdd3-3eb5-733d-b481-a53e5292bd13" },
				undefined,
				undefined,
				ctx,
			);
			await raceWithTimeout(executePromise1, 200);

			const executePromise2 = executeSubagentTool!(
				"call-2",
				{ agent: "tester", task: "任务2", sessionId: "019ffdd3-3eb5-733d-b481-a53e5292bd14" },
				undefined,
				undefined,
				ctx,
			);
			await raceWithTimeout(executePromise2, 200);

			await executeCancelTool!("call-3", { taskId: "019ffdd3-3eb5-733d-b481-a53e5292bd14" }, undefined, undefined, ctx);

			// Act
			const result = await executeSubagentTool!("call-4", { action: "status" }, undefined, undefined, ctx);

			// Assert: 无论任务状态如何，status 都被拒绝且不透出任何 taskId
			expect(result.isError).toBe(true);
			const text = result.content.map((c: any) => c.text).join("");
			expect(text).toMatch(/Invalid action/);
			expect(text).not.toContain("019ffdd3-3eb5-733d-b481-a53e5292bd13");
			expect(text).not.toContain("019ffdd3-3eb5-733d-b481-a53e5292bd14");
		});
	});

	// ================================================================
	// 3. 空在途：status 已移除，空注册表同样拒绝（负向契约）
	// ================================================================
	describe("3. 空在途 —— action=status 负向契约", () => {
		it("注册表为空时 action=status 必须拒绝，而非返回「当前无在途任务」（RED）", async () => {
			const { executeSubagentTool } = setupExtension();
			const ctx = createMockTuiCtx(defaultCwd);

			expect(taskRegistry.size).toBe(0);

			// Act
			const result = await executeSubagentTool!("call-1", { action: "status" }, undefined, undefined, ctx);

			// Assert: 拒绝，且不得出现在途块措辞（S2 迁移后本守卫仍需有效：旧绝对句
			// "当前无在途任务"与新版事件锚定措辞（本任务结束/在途任务）均不得出现）
			expect(result.isError).toBe(true);
			const text = result.content.map((c: any) => c.text).join("");
			expect(text).toMatch(/Invalid action/);
			expect(text).not.toMatch(/in[- ]flight|when this task ended/i);
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
				{ agent: "tester", task: "任务1", sessionId: "019ffdd3-3eb5-733d-b481-a53e5292bd15" },
				undefined,
				undefined,
				ctx,
			);
			await raceWithTimeout(executePromise1, 200);

			const executePromise2 = executeSubagentTool!(
				"call-2",
				{ agent: "tester", task: "任务2", sessionId: "019ffdd3-3eb5-733d-b481-a53e5292bd16" },
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

			// 契约迁移（S2 事件锚定措辞）：在途块从绝对陈述改为锚定"本信封所属任务
			// 结束事件"的限定陈述。锁语义不锁字面：块内须有事件锚定行（本任务+结束
			// +在途 同行），其余在途任务的 taskId/agent/摘要 不丢失，且不含时钟时间。
			// 当前实现仍为无锚定的"在途任务: N"→ 本断言在实现完成前 RED。
			const block = extractInFlightBlock(content);
			expect(block, "信封应包含在途块（- 会话: 行与 --- 分隔线之间）").not.toBe("");
			expect(hasEventAnchoredLine(block, false), "非空在途块应有锚定本任务结束事件的限定陈述").toBe(true);
			expect(block).not.toMatch(ABSOLUTE_EMPTY_WORDING);
			expect(block).not.toMatch(CLOCK_TIME);
			expect(block).toContain("019ffdd3-3eb5-733d-b481-a53e5292bd16");
			expect(block).toContain("tester");
			expect(block).toMatch(/任务2/);
		});

		it("信封在途列表应排除刚完成的任务自己", async () => {
			const { executeSubagentTool, pi } = setupExtension();
			const ctx = createMockTuiCtx(defaultCwd);

			// Arrange: dispatch a task
			const executePromise = executeSubagentTool!(
				"call-1",
				{ agent: "tester", task: "测试任务", sessionId: "019ffdd3-3eb5-733d-b481-a53e5292bd17" },
				undefined,
				undefined,
				ctx,
			);
			await raceWithTimeout(executePromise, 200);

			expect(taskRegistry.size).toBe(1);

			// Act: complete the task
			endProcess(allProcs[0], 0);
			await vi.advanceTimersByTimeAsync(1000);

			// Assert: envelope should show empty in-flight block (self excluded)
			expect(pi.sendMessage).toHaveBeenCalled();
			const [message] = pi._sendMessageCalls[0];
			const content: string = message.content;

			// 契约迁移（S2 事件锚定措辞）：空在途由绝对句"当前无在途任务"改为锚定
			// 本任务结束事件的限定表述（如"本任务结束时无其他在途任务"）。当前实现
			// 仍为旧绝对句 → 本断言在实现完成前 RED。
			const block = extractInFlightBlock(content);
			expect(block, "信封应包含在途块（- 会话: 行与 --- 分隔线之间）").not.toBe("");
			expect(hasEventAnchoredLine(block, true), "空在途块应有锚定本任务结束事件的限定陈述").toBe(true);
			expect(block).not.toMatch(ABSOLUTE_EMPTY_WORDING);
			expect(block).not.toMatch(CLOCK_TIME);
			
			// The header contains the completed task's ID, but the active tasks list should not
			// Check that the self-excluded task id appears in header but not in active tasks section
			const lines = content.split("\n");
			const activeTasksSection = lines.filter(l => l.match(/^- .* \(.*\):/)); // Lines like "- taskId (agent): task"
			
			// Active tasks section should not contain the completed task's ID
			for (const line of activeTasksSection) {
				expect(line).not.toContain("019ffdd3-3eb5-733d-b481-a53e5292bd17");
			}
		});
	});

	// ================================================================
	// 5. action=cancel 返回在途列表
	// ================================================================
	describe("5. action=cancel 返回在途列表", () => {
		// 契约变更（destructive-action 两步确认）：agent 发起的 cancel 首次调用
		// 只返回质询回执，confirm:true + 非空 reason 才执行。以下用例已迁移为
		// 确认调用，钉住确认成功回执仍携带在途列表。
		it("取消成功后应返回剩余在途任务信息", async () => {
			const { executeSubagentTool, executeCancelTool } = setupExtension();
			expect(executeCancelTool, "subagent tool should be registered (cancel dispatched via action param)").toBeDefined();
			const ctx = createMockTuiCtx(defaultCwd);

			// Arrange: dispatch 2 tasks
			const executePromise1 = executeSubagentTool!(
				"call-1",
				{ agent: "tester", task: "任务1", sessionId: "019ffdd3-3eb5-733d-b481-a53e5292bd14" },
				undefined,
				undefined,
				ctx,
			);
			await raceWithTimeout(executePromise1, 200);

			const executePromise2 = executeSubagentTool!(
				"call-2",
				{ agent: "tester", task: "任务2", sessionId: "019ffdd3-3eb5-733d-b481-a53e5292bd18" },
				undefined,
				undefined,
				ctx,
			);
			await raceWithTimeout(executePromise2, 200);

			expect(taskRegistry.size).toBe(2);

			// Act: cancel the first task（confirm:true + reason，两步确认的第二步）
			const result = await executeCancelTool!("call-3", { taskId: "019ffdd3-3eb5-733d-b481-a53e5292bd14", confirm: true, reason: "任务目标已改变" }, undefined, undefined, ctx);

			// Assert: return value should contain remaining active tasks
			const text = result.content.map((c: any) => c.text).join("");
			expect(text).toMatch(/in[- ]flight/i);
			expect(text).toContain("019ffdd3-3eb5-733d-b481-a53e5292bd18");
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
				{ agent: "tester", task: "任务1", sessionId: "019ffdd3-3eb5-733d-b481-a53e5292bd19" },
				undefined,
				undefined,
				ctx,
			);
			await raceWithTimeout(executePromise1, 200);

			const executePromise2 = executeSubagentTool!(
				"call-2",
				{ agent: "tester", task: "任务2", sessionId: "019ffdd3-3eb5-733d-b481-a53e5292bd1a" },
				undefined,
				undefined,
				ctx,
			);
			await raceWithTimeout(executePromise2, 200);

			// Act: cancel the first task（confirm:true + reason）
			const result = await executeCancelTool!("call-3", { taskId: "019ffdd3-3eb5-733d-b481-a53e5292bd19", confirm: true, reason: "任务目标已改变" }, undefined, undefined, ctx);

			// Assert: should contain "keep-me" but not "cancel-me" in active tasks
			const text = result.content.map((c: any) => c.text).join("");
			expect(text).toContain("019ffdd3-3eb5-733d-b481-a53e5292bd1a");
			
			// Check that "cancel-me" is not in the active tasks section
			const lines = text.split("\n");
			const activeTasksSection = lines.filter(l => l.match(/^- .* \(.*\):/));
			for (const line of activeTasksSection) {
				expect(line).not.toContain("019ffdd3-3eb5-733d-b481-a53e5292bd19");
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
				{ agent: "tester", task: "回归测试任务", sessionId: "019ffdd3-3eb5-733d-b481-a53e5292bd1b" },
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
			expect(content).toContain("019ffdd3-3eb5-733d-b481-a53e5292bd1b"); // taskId
			expect(content).toContain("tester"); // agent name
			expect(content).toContain("Status:"); // status field
			expect(content).toContain("Task:"); // task field
			expect(content).toMatch(/回归测试任务/); // task description
			
			// 在途块仍存在，但措辞已迁移（S2 事件锚定）：空在途为锚定本任务结束
			// 事件的限定表述，不再用绝对句"当前无在途任务"，不含时钟时间。
			// 当前实现仍为旧绝对句 → 本断言在实现完成前 RED。
			const block = extractInFlightBlock(content);
			expect(block, "信封应包含在途块（- 会话: 行与 --- 分隔线之间）").not.toBe("");
			expect(hasEventAnchoredLine(block, true), "空在途块应有锚定本任务结束事件的限定陈述").toBe(true);
			expect(block).not.toMatch(ABSOLUTE_EMPTY_WORDING);
			expect(block).not.toMatch(CLOCK_TIME);
		});

		it("取消信封应仍包含 cancelledBy 字段", async () => {
			const { executeSubagentTool, executeCancelTool, pi } = setupExtension();
			expect(executeCancelTool, "subagent tool should be registered (cancel dispatched via action param)").toBeDefined();
			const ctx = createMockTuiCtx(defaultCwd);

			// Arrange: dispatch a task
			const executePromise = executeSubagentTool!(
				"call-1",
				{ agent: "tester", task: "取消测试", sessionId: "019ffdd3-3eb5-733d-b481-a53e5292bd1c" },
				undefined,
				undefined,
				ctx,
			);
			await raceWithTimeout(executePromise, 200);

			// Act: cancel via tool（confirm:true + reason，两步确认的第二步；
			// 契约变更迁移：原为无 confirm 的单步调用）
			await executeCancelTool!("call-2", { taskId: "019ffdd3-3eb5-733d-b481-a53e5292bd1c", confirm: true, reason: "任务目标已改变" }, undefined, undefined, ctx);
			endProcess(allProcs[0], null, "SIGTERM");
			await vi.advanceTimersByTimeAsync(1000);

			// Assert: envelope should still have cancelledBy
			expect(pi.sendMessage).toHaveBeenCalled();
			const [message] = pi._sendMessageCalls[0];
			expect(message.details.cancelledBy).toBe("agent");
			
			// And should contain active tasks section
			// 契约迁移（S2 事件锚定措辞）：取消唯一任务后在途为空，空在途块应为锚定
			// 本任务结束事件的限定表述，不再用绝对句"当前无在途任务"。
			// 当前实现仍为旧绝对句 → 本断言在实现完成前 RED。
			const content: string = message.content;
			const block = extractInFlightBlock(content);
			expect(block, "信封应包含在途块（- 会话: 行与 --- 分隔线之间）").not.toBe("");
			expect(hasEventAnchoredLine(block, true), "空在途块应有锚定本任务结束事件的限定陈述").toBe(true);
			expect(block).not.toMatch(ABSOLUTE_EMPTY_WORDING);
			expect(block).not.toMatch(CLOCK_TIME);
		});
	});
});
