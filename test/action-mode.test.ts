/**
 * TDD 红阶段测试：单入口 action 模式（新契约）
 *
 * 背景：原实现注册三个独立工具（subagent / subagent_status / subagent_cancel），
 * 主 agent 的 --tools 白名单只挂了 subagent，导致 status/cancel 能力缺失。
 * 重构为「单入口多 action」：只保留 subagent 工具，新增 action 参数
 * （dispatch 默认 / status / cancel），挂一个工具即拥有全部能力。
 *
 * 新契约（本文件 RED 部分）：
 * - subagent 工具参数 schema 声明 action 字段（缺省 dispatch）
 * - subagent_status / subagent_cancel 不再单独注册
 * - 工具 description 不再引用已移除的独立工具名（subagent_status/subagent_cancel），
 *   但保留不轮询指引与取消防滥用引导
 * - action=cancel：按 taskId 取消，信封 cancelledBy="agent"（区分取消来源）
 *
 * Breaking change（v2.0.0，本文件负向契约 RED 部分）：
 * - action="status" 从工具面移除：schema 不再枚举 "status"、execute 一律拒绝
 *   （Invalid action）、description / promptGuidelines / 错误文案枚举段 /
 *   深度拦截文案均不再出现 "status"
 * - cancel 行为不变；在途列表仍由信封在途块与 cancel 回执共享 formatActiveTasks()
 *
 * 回归锁定（本文件 GREEN 部分，不得回归）：
 * - 不带 action 的 agent/task 调用 = dispatch（缺省），回执语义不变
 * - 回执单行「已派出 … taskId」、[subagent-result] 信封、在途任务块、不轮询指引
 * - /subagent-cancel 用户取消仍 cancelledBy="user"
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

/** Manually end the process so the result promise resolves. */
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

function writeAgentFile(cwd: string) {
	fs.mkdirSync(path.join(cwd, ".pi", "agents"), { recursive: true });
	fs.writeFileSync(
		path.join(cwd, ".pi", "agents", "tester.md"),
		`---\nname: tester\ndescription: Test agent\n---\n`,
		"utf-8",
	);
}

/** Race execute() against a timeout to detect immediate returns. */
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

describe("单入口 action 模式 — 新契约红阶段", () => {
	let tmpBase: string;
	let agentDir: string;
	let defaultCwd: string;
	let savedEnv: Record<string, string | undefined>;
	let allProcs: ReturnType<typeof createControllableProc>[];

	beforeEach(() => {
		vi.useFakeTimers();
		taskRegistry.clear();

		tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "action-mode-test-"));
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
		return { pi, executeSubagentTool, toolsByName };
	}

	// ================================================================
	// 1. 新契约：单入口 action 参数与工具收敛
	// ================================================================
	describe("1. 单入口 action 参数（新契约）", () => {
		it("schema：agent/task 应为可选，action 枚举仅含 dispatch/cancel（status 已移除）且默认 dispatch（RED：当前仍枚举 status）", () => {
			const { toolsByName } = setupExtension();

			const subagent = toolsByName.get("subagent");
			expect(subagent, "subagent tool should be registered").toBeDefined();
			const schema = subagent.parameters;
			const props = schema.properties || {};
			const required: string[] = schema.required || [];

			// action：可选（不在 required 中）、枚举仅含 dispatch/cancel、默认 dispatch
			expect(props.action, "subagent parameters should declare an action field").toBeDefined();
			expect(required).not.toContain("action");
			const actionConsts = (props.action.anyOf || props.action.oneOf || []).map((s: any) => s.const);
			expect(actionConsts).toEqual(expect.arrayContaining(["dispatch", "cancel"]));
			expect(actionConsts).not.toContain("status");
			expect(props.action.default).toBe("dispatch");

			// agent/task：Optional（cancel 不要求 agent/task）
			// → 不应出现在 required 中
			expect(required).not.toContain("agent");
			expect(required).not.toContain("task");
		});

		it("subagent_status 工具不应再单独注册（RED：当前仍注册）", () => {
			const { toolsByName } = setupExtension();
			expect(toolsByName.has("subagent_status")).toBe(false);
		});

		it("subagent_cancel 工具不应再单独注册（RED：当前仍注册）", () => {
			const { toolsByName } = setupExtension();
			expect(toolsByName.has("subagent_cancel")).toBe(false);
		});

		it("description 不应再引用已移除的独立工具名（RED：当前引用 subagent_status）", () => {
			const { toolsByName } = setupExtension();
			const desc = toolsByName.get("subagent").description;
			expect(desc).not.toMatch(/subagent_status|subagent_cancel/);
		});
	});

	// ================================================================
	// 2. 回归锁定：action 缺省 = dispatch，兼容现有 agent/task 调用
	// ================================================================
	describe("2. action 缺省为 dispatch（回归锁定，应保持绿）", () => {
		it("不带 action 的 agent+task 调用仍返回派发回执", async () => {
			const { executeSubagentTool } = setupExtension();
			const ctx = createMockTuiCtx(defaultCwd);

			const executePromise = executeSubagentTool!(
				"call-1",
				{ agent: "tester", task: "test task", sessionId: "default-dispatch" },
				undefined,
				undefined,
				ctx,
			);
			const { result, timedOut } = await raceWithTimeout(executePromise, 200);

			expect(timedOut).toBe(false);
			expect(result!.isError).toBeFalsy();
			expect(result!.content[0].text).toMatch(/^已派出/);
			expect(result!.content[0].text).toContain("default-dispatch");
		});

		it("显式 action=dispatch 与缺省行为一致（兼容现有调用形态）", async () => {
			const { executeSubagentTool } = setupExtension();
			const ctx = createMockTuiCtx(defaultCwd);

			const executePromise = executeSubagentTool!(
				"call-1",
				{ action: "dispatch", agent: "tester", task: "test task", sessionId: "explicit-dispatch" },
				undefined,
				undefined,
				ctx,
			);
			const { result, timedOut } = await raceWithTimeout(executePromise, 200);

			expect(timedOut).toBe(false);
			expect(result!.isError).toBeFalsy();
			expect(result!.content[0].text).toMatch(/^已派出/);
			expect(result!.content[0].text).toContain("explicit-dispatch");
		});

		it("action=dispatch 缺 agent → 报错（与现有校验一致）", async () => {
			const { executeSubagentTool } = setupExtension();
			const ctx = createMockTuiCtx(defaultCwd);

			const result = await executeSubagentTool!(
				"call-1",
				{ action: "dispatch", task: "test task" },
				undefined,
				undefined,
				ctx,
			);

			expect(result.isError).toBe(true);
			const text = result.content[0].text;
			expect(text).toMatch(/agent/);
		});

		it("action=dispatch 缺 task → 报错（与现有校验一致）", async () => {
			const { executeSubagentTool } = setupExtension();
			const ctx = createMockTuiCtx(defaultCwd);

			const result = await executeSubagentTool!(
				"call-1",
				{ action: "dispatch", agent: "tester" },
				undefined,
				undefined,
				ctx,
			);

			expect(result.isError).toBe(true);
			const text = result.content[0].text;
			expect(text).toMatch(/task/);
		});
	});

	// ================================================================
	// 3. 负向契约：action=status 必须被拒绝（status 已从工具面移除）
	// ================================================================
	describe("3. action=status 必须被拒绝（负向契约）", () => {
		it("execute({action:'status'}) 应返回 isError:true 且文案含 Invalid action（RED：当前返回在途列表）", async () => {
			const { executeSubagentTool } = setupExtension();
			const ctx = createMockTuiCtx(defaultCwd);

			// Act: status 已移除 —— 与未知 action 同等拒绝
			const result = await executeSubagentTool!("call-1", { action: "status" }, undefined, undefined, ctx);

			// Assert: 拒绝而非返回在途列表；回显被拒绝的输入
			expect(result.isError).toBe(true);
			const text = result.content.map((c: any) => c.text).join("");
			expect(text).toMatch(/Invalid action/);
			expect(text).toContain('"status"'); // 回显被拒绝的输入值
		});

		it("即使有在途任务，action=status 也不得返回在途列表格式（taskId/agent/任务描述均不可见，RED）", async () => {
			const { executeSubagentTool } = setupExtension();
			const ctx = createMockTuiCtx(defaultCwd);

			// Arrange: dispatch 2 tasks
			const p1 = executeSubagentTool!(
				"call-1",
				{ agent: "tester", task: "调研 XX 方案", sessionId: "status-reject-1" },
				undefined,
				undefined,
				ctx,
			);
			await raceWithTimeout(p1, 200);

			const p2 = executeSubagentTool!(
				"call-2",
				{ agent: "tester", task: "重构认证中间件", sessionId: "status-reject-2" },
				undefined,
				undefined,
				ctx,
			);
			await raceWithTimeout(p2, 200);

			expect(taskRegistry.size).toBe(2);

			// Act
			const result = await executeSubagentTool!("call-3", { action: "status" }, undefined, undefined, ctx);

			// Assert: 拒绝，且回执不得暴露在途列表信息
			expect(result.isError).toBe(true);
			const text = result.content.map((c: any) => c.text).join("");
			expect(text).not.toMatch(/在途任务|当前无在途任务/);
			expect(text).not.toContain("status-reject-1");
			expect(text).not.toContain("status-reject-2");
			expect(text).not.toMatch(/调研 XX 方案/);
			expect(text).not.toMatch(/重构认证中间件/);
		});

		it("空在途时 action=status 同样拒绝，而非返回「当前无在途任务」（RED）", async () => {
			const { executeSubagentTool } = setupExtension();
			const ctx = createMockTuiCtx(defaultCwd);

			expect(taskRegistry.size).toBe(0);

			const result = await executeSubagentTool!("call-1", { action: "status" }, undefined, undefined, ctx);

			expect(result.isError).toBe(true);
			const text = result.content.map((c: any) => c.text).join("");
			expect(text).not.toMatch(/当前无在途任务/);
		});

		it("action=status 不得产生 details.activeTasks 字段（RED）", async () => {
			const { executeSubagentTool } = setupExtension();
			const ctx = createMockTuiCtx(defaultCwd);

			const p1 = executeSubagentTool!(
				"call-1",
				{ agent: "tester", task: "任务", sessionId: "status-reject-details" },
				undefined,
				undefined,
				ctx,
			);
			await raceWithTimeout(p1, 200);

			const result = await executeSubagentTool!("call-2", { action: "status" }, undefined, undefined, ctx);

			expect(result.isError).toBe(true);
			expect(result.details?.activeTasks).toBeUndefined();
		});

		it("action=status 不得 spawn 子进程、不得写入任务注册表（与 action=foo 同等拒绝强度，RED）", async () => {
			const { executeSubagentTool } = setupExtension();
			const ctx = createMockTuiCtx(defaultCwd);

			const result = await executeSubagentTool!("call-1", { action: "status" }, undefined, undefined, ctx);

			expect(result.isError).toBe(true);
			expect(spawn).not.toHaveBeenCalled();
			expect(taskRegistry.size).toBe(0);
		});
	});

	// ================================================================
	// 4. 新契约：action=cancel 按 taskId 取消
	// ================================================================
	describe("4. action=cancel 按 taskId 取消（新契约）", () => {
		it("action=cancel 应 SIGTERM 子进程并标记任务 cancelled（RED）", async () => {
			const { executeSubagentTool } = setupExtension();
			const ctx = createMockTuiCtx(defaultCwd);

			// Arrange: dispatch a task
			const executePromise = executeSubagentTool!(
				"call-1",
				{ agent: "tester", task: "test task", sessionId: "action-cancel-kill" },
				undefined,
				undefined,
				ctx,
			);
			await raceWithTimeout(executePromise, 200);

			expect(taskRegistry.has("action-cancel-kill")).toBe(true);
			const proc = allProcs[0];

			// Act: action=cancel（不携带 agent/task）
			const result = await executeSubagentTool!(
				"call-2",
				{ action: "cancel", taskId: "action-cancel-kill" },
				undefined,
				undefined,
				ctx,
			);

			// Assert: 任务被取消且 SIGTERM 已发送
			expect(result.isError).toBeFalsy();
			expect(taskRegistry.get("action-cancel-kill")?.status).toBe("cancelled");
			expect(proc.kill).toHaveBeenCalledWith("SIGTERM");
		});

		it("action=cancel 信封 details.cancelledBy='agent'（区分取消来源，RED）", async () => {
			const { executeSubagentTool, pi } = setupExtension();
			const ctx = createMockTuiCtx(defaultCwd);

			const executePromise = executeSubagentTool!(
				"call-1",
				{ agent: "tester", task: "test task", sessionId: "action-cancel-envelope" },
				undefined,
				undefined,
				ctx,
			);
			await raceWithTimeout(executePromise, 200);

			await executeSubagentTool!(
				"call-2",
				{ action: "cancel", taskId: "action-cancel-envelope" },
				undefined,
				undefined,
				ctx,
			);

			// Drive the abort cascade → completeAsyncTask → sendMessage
			endProcess(allProcs[0], null, "SIGTERM");
			await vi.advanceTimersByTimeAsync(1000);

			expect(pi.sendMessage).toHaveBeenCalled();
			const [message] = pi._sendMessageCalls[0];
			expect(message.customType).toBe("subagent-result");
			expect(message.details.cancelledBy).toBe("agent");
		});

		it('action=cancel 信封正文应标明由主 agent 取消（RED）', async () => {
			const { executeSubagentTool, pi } = setupExtension();
			const ctx = createMockTuiCtx(defaultCwd);

			const executePromise = executeSubagentTool!(
				"call-1",
				{ agent: "tester", task: "test task", sessionId: "action-cancel-body" },
				undefined,
				undefined,
				ctx,
			);
			await raceWithTimeout(executePromise, 200);

			await executeSubagentTool!(
				"call-2",
				{ action: "cancel", taskId: "action-cancel-body" },
				undefined,
				undefined,
				ctx,
			);

			endProcess(allProcs[0], null, "SIGTERM");
			await vi.advanceTimersByTimeAsync(1000);

			expect(pi.sendMessage).toHaveBeenCalled();
			const [message] = pi._sendMessageCalls[0];
			const content: string = message.content;
			// 必须是取消信封（状态=已取消）且正文标明由主 agent 取消，
			// 且不得是用户取消文案（来源区分）
			expect(content).toMatch(/已取消/);
			expect(content).toMatch(/主\s*agent/);
			expect(content).not.toMatch(/请勿自动重新派发/);
		});

		it("action=cancel 成功应返回含 taskId 与取消确认的回执（RED）", async () => {
			const { executeSubagentTool } = setupExtension();
			const ctx = createMockTuiCtx(defaultCwd);

			const executePromise = executeSubagentTool!(
				"call-1",
				{ agent: "tester", task: "test task", sessionId: "action-cancel-receipt" },
				undefined,
				undefined,
				ctx,
			);
			await raceWithTimeout(executePromise, 200);

			const result = await executeSubagentTool!(
				"call-2",
				{ action: "cancel", taskId: "action-cancel-receipt" },
				undefined,
				undefined,
				ctx,
			);

			expect(result.isError).toBeFalsy();
			const text = result.content.map((c: any) => c.text).join("");
			expect(text).toMatch(/action-cancel-receipt/);
			expect(text).toMatch(/cancel|取消/);
			expect(result.details).toMatchObject({ taskId: "action-cancel-receipt", cancelled: true });
		});

		it("action=cancel 不存在 taskId → 错误提示「无此运行中任务」（RED）", async () => {
			const { executeSubagentTool } = setupExtension();
			const ctx = createMockTuiCtx(defaultCwd);

			const result = await executeSubagentTool!(
				"call-1",
				{ action: "cancel", taskId: "non-existent-task-id" },
				undefined,
				undefined,
				ctx,
			);

			expect(result.isError).toBe(true);
			const text = result.content.map((c: any) => c.text).join("");
			expect(text).toMatch(/无此运行中任务|no running|不存在|not found/i);
		});

		it("action=cancel 空 taskId → 错误提示必填（RED）", async () => {
			const { executeSubagentTool } = setupExtension();
			const ctx = createMockTuiCtx(defaultCwd);

			const result = await executeSubagentTool!(
				"call-1",
				{ action: "cancel", taskId: "" },
				undefined,
				undefined,
				ctx,
			);

			expect(result.isError).toBe(true);
			const text = result.content.map((c: any) => c.text).join("");
			expect(text).toMatch(/taskId/);
			expect(text).toMatch(/必填|不能为空|required|missing|empty/i);
		});

		it("深度限制应拦截 action=cancel（depth=1 子 agent 取消应收到深度拦截错误，RED：当前 cancel 绕过深度检查）", async () => {
			process.env.PI_SUBAGENT_DEPTH = "1";
			const { executeSubagentTool } = setupExtension();
			const ctx = createMockTuiCtx(defaultCwd);

			const result = await executeSubagentTool!(
				"call-1",
				{ action: "cancel", taskId: "any-task" },
				undefined,
				undefined,
				ctx,
			);

			// 子 agent 不应执行取消，而应收到深度拦截错误
			expect(result.isError).toBe(true);
			const text = result.content.map((c: any) => c.text).join("");
			expect(text).toMatch(/depth|深度|blocked|限制/);
		});
	});

	// ================================================================
	// 5. 回归锁定：现有异步语义不回归
	// ================================================================
	describe("5. 回归锁定：现有异步语义不回归（应保持绿）", () => {
		it("派发回执仍为单行「已派出 … taskId」，不含长说明词", async () => {
			const { executeSubagentTool } = setupExtension();
			const ctx = createMockTuiCtx(defaultCwd);

			const result = await executeSubagentTool!(
				"call-1",
				{ agent: "tester", task: "do something" },
				undefined,
				undefined,
				ctx,
			);

			const receipt = result.content[0].text;
			expect(receipt).toMatch(/^已派出/);
			expect(receipt).toMatch(/taskId/);
			expect(receipt).not.toMatch(/Do not treat|poll|fabricate/i);
		});

		it("信封仍含 [subagent-result]、状态、任务、在途任务块", async () => {
			const { executeSubagentTool, pi } = setupExtension();
			const ctx = createMockTuiCtx(defaultCwd);

			const executePromise = executeSubagentTool!(
				"call-1",
				{ agent: "tester", task: "回归测试任务", sessionId: "regression-envelope" },
				undefined,
				undefined,
				ctx,
			);
			await raceWithTimeout(executePromise, 200);

			endProcess(allProcs[0], 0);
			await vi.advanceTimersByTimeAsync(1000);

			expect(pi.sendMessage).toHaveBeenCalled();
			const [message] = pi._sendMessageCalls[0];
			const content: string = message.content;
			expect(content).toContain("[subagent-result]");
			expect(content).toContain("状态:");
			expect(content).toContain("任务:");
			expect(content).toMatch(/在途任务|当前无在途任务/);
		});

		it("description 仍包含不轮询指引（Do NOT poll）", () => {
			const { toolsByName } = setupExtension();
			const desc = toolsByName.get("subagent").description;
			expect(desc).toMatch(/Do NOT poll/i);
		});

		it("/subagent-cancel 用户取消仍 cancelledBy='user'（来源区分不回归）", async () => {
			const { executeSubagentTool, pi } = setupExtension();
			const ctx = createMockTuiCtx(defaultCwd);

			const executePromise = executeSubagentTool!(
				"call-1",
				{ agent: "tester", task: "test task", sessionId: "user-cancel-regression" },
				undefined,
				undefined,
				ctx,
			);
			await raceWithTimeout(executePromise, 200);

			const cancelCommand = pi._commandDefs.get("subagent-cancel");
			expect(cancelCommand).toBeDefined();
			await cancelCommand.handler("user-cancel-regression", { ui: { notify: vi.fn() } });

			endProcess(allProcs[0], null, "SIGTERM");
			await vi.advanceTimersByTimeAsync(1000);

			expect(pi.sendMessage).toHaveBeenCalled();
			const [message] = pi._sendMessageCalls[0];
			expect(message.details.cancelledBy).toBe("user");
		});
	});

	// ================================================================
	// 6. 未知 action 拒绝分支（新契约）
	// ================================================================
	describe("6. 未知 action 拒绝分支（契约锁定：实现已满足）", () => {
		it("action=foo（无 agent/task）→ isError:true 且文案含 Invalid action", async () => {
			const { executeSubagentTool } = setupExtension();
			const ctx = createMockTuiCtx(defaultCwd);

			// Act: 未知 action，且不带任何其他参数
			const result = await executeSubagentTool!("call-1", { action: "foo" }, undefined, undefined, ctx);

			// Assert: 拒绝而非静默按 dispatch 处理
			expect(result.isError).toBe(true);
			const text = result.content.map((c: any) => c.text).join("");
			expect(text).toMatch(/Invalid action/);
			expect(text).toContain("foo");
		});

		it("action=foo 携带 agent/task → isError:true 且不 spawn 子进程、不新增注册条目", async () => {
			const { executeSubagentTool } = setupExtension();
			const ctx = createMockTuiCtx(defaultCwd);

			// Act: 未知 action，即使携带合法 dispatch 参数（agent/task）也必须拒绝
			const result = await executeSubagentTool!(
				"call-1",
				{ action: "foo", agent: "coder", task: "x" },
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
	});

	// ================================================================
	// 7. 交叉一致性：status 从工具面彻底移除（schema/description/错误文案一致）
	// ================================================================
	describe("7. 交叉一致性：status 从工具面彻底移除（负向契约）", () => {
		it("SubagentActionSchema 不应再枚举 'status' literal（parameters introspection，RED）", () => {
			const { toolsByName } = setupExtension();

			const subagent = toolsByName.get("subagent");
			expect(subagent, "subagent tool should be registered").toBeDefined();
			const props = subagent.parameters.properties || {};
			const actionConsts = (props.action.anyOf || props.action.oneOf || []).map((s: any) => s.const);

			// status literal 已废弃；枚举恰好剩下 dispatch + cancel
			expect(actionConsts).not.toContain("status");
			expect(actionConsts).toEqual(expect.arrayContaining(["dispatch", "cancel"]));
			expect(actionConsts).toHaveLength(2);
		});

		it("description 不应再将 status 列为可用 action（RED：当前含 '- status:' 与 action=\"status\" 引用）", () => {
			const { toolsByName } = setupExtension();
			const desc: string = toolsByName.get("subagent").description;

			expect(desc).not.toMatch(/- status:/);
			expect(desc).not.toContain('action="status"');
			expect(desc).not.toContain("action='status'");
		});

		it("promptGuidelines 不应指引使用 action=\"status\"（交叉一致性锁定）", () => {
			const { toolsByName } = setupExtension();
			const guidelines: string[] = toolsByName.get("subagent").promptGuidelines || [];

			expect(guidelines.length).toBeGreaterThan(0);
			for (const g of guidelines) {
				expect(g).not.toContain('action="status"');
				expect(g).not.toContain("action='status'");
			}
		});

		it("Invalid action 错误文案的枚举段不应再列出 \"status\"（RED：当前为 dispatch/status/cancel）", async () => {
			const { executeSubagentTool } = setupExtension();
			const ctx = createMockTuiCtx(defaultCwd);

			const result = await executeSubagentTool!("call-1", { action: "status" }, undefined, undefined, ctx);

			expect(result.isError).toBe(true);
			const text = result.content.map((c: any) => c.text).join("");
			// 枚举段（Must be one of ...）不得再列出 "status"（回显输入值不在此列）
			expect(text).not.toMatch(/one of[^.]*"status"/);
		});

		it("深度拦截错误消息不应包含 'status' 字样（RED：当前为 dispatch/status/cancel）", async () => {
			process.env.PI_SUBAGENT_DEPTH = "1";
			const { executeSubagentTool } = setupExtension();
			const ctx = createMockTuiCtx(defaultCwd);

			const result = await executeSubagentTool!("call-1", { action: "status" }, undefined, undefined, ctx);

			// 子 agent 仍被深度门禁拦截，但文案枚举段不得再出现 status
			expect(result.isError).toBe(true);
			const text = result.content.map((c: any) => c.text).join("");
			expect(text).toMatch(/depth|深度|blocked|限制/);
			expect(text).not.toContain("status");
		});
	});
});
