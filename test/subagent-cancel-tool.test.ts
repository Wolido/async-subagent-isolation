/**
 * Red-phase tests for action=cancel 两步确认（destructive-action 确认模式）
 *
 * 背景：主 agent 会对正常在途的子 agent 任务发出"误取消"——叙事层说"等待"，
 * 动作层却发射 action="cancel"。纪律文字治不住动作发射层面的泄漏，因此在
 * 执行路径上加结构摩擦：agent 发起的 cancel 改为两步确认。
 *
 * 新契约（本文件 RED 部分，需要 coder 实现后变绿）：
 * 1. Schema：subagent 工具新增可选参数 confirm（boolean，默认 false）与
 *    reason（string）。
 * 2. 首次 cancel（无 confirm 或 confirm !== true）且任务存在 → 零副作用
 *    （任务继续运行、abortController 未触发、无 [subagent-result] 通知），
 *    返回质询回执（challenge）：正文含 agent 名/任务摘要/已运行时长/最近
 *    进度信息（从未上报则明示"尚无进度上报"）/不可撤销警告/二次调用指令；
 *    details 无 results 数组、cancelled:false、带 confirmRequired:true 与
 *    执行成功回执区分。
 * 3. 确认 cancel（confirm:true）：reason 缺失或空白 → 报错且零副作用；
 *    reason 非空 → 走现有 cancelTask(taskId, "agent") 路径执行，reason 记录
 *    在任务记录上，最终 [subagent-result] 信封正文（abortedFallbackBody 的
 *    agent 分支）必须包含该理由。
 * 4. 用户路径（/subagent-cancel、/subagent-cancel-all、交互 picker）保持
 *    单步不变——既有 describe 6/9 与 interactive-pickers.test.ts 锁定。
 * 5. 工具 description / promptGuidelines 更新为两步确认流程 + "等待 = 不
 *    发起任何工具调用、直接结束回合；对在途任务不存在查询/催办类动作"语义。
 * 6. progressManager.update() 需记录最近更新时间戳（类级行为见
 *    progress-manager.test.ts；端到端"最近进度距今"由 describe 3 锁定）。
 *
 * 契约变更迁移（本文件 GREEN 部分）：
 * - 旧 describe 2（工具取消行为）的 4 个用例原以"无 confirm 直接执行"调用，
 *   与新契约的第一步质询冲突，已迁移为"confirm:true + 非空 reason"的确认
 *   调用（describe 5），钉住"确认后执行效果与旧单步执行一致"。迁移后这些
 *   用例在旧实现（confirm 被忽略、直接执行）与新实现下均应为绿。
 * - taskId 缺失/为空、无此运行中任务两类报错维持不变（契约 2 前两条），
 *   既有 describe 7 保持绿。
 */

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn } from "node:child_process";
import extension, { taskRegistry, resetProgressManagerForTests } from "../src/index.ts";
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

describe("action=cancel 两步确认 — 红阶段测试", () => {
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
		// The progress manager is a module-level singleton: dispatched-but-
		// unfinished tasks would leak widget registrations and last-activity
		// timestamps into later cases (today masked by unique UUIDs per test).
		resetProgressManagerForTests();
		fs.rmSync(tmpBase, { recursive: true, force: true });
		vi.clearAllMocks();
		vi.useRealTimers();
	});

	function setupExtension() {
		const pi = createMockPi();
		extension(pi as any);
		const toolsByName = new Map(pi._toolDefs.map((t: any) => [t.name, t] as const));
		const executeSubagentTool = toolsByName.get("subagent")?.execute as ExecuteFn | undefined;
		// 取消通过 subagent 工具 action=cancel 分派（单入口）
		const executeCancelTool = (
			toolCallId: string,
			params: Record<string, unknown>,
			signal: AbortSignal | undefined,
			onUpdate: unknown,
			ctx: unknown,
		) => executeSubagentTool!(toolCallId, { action: "cancel", ...params }, signal, onUpdate, ctx);
		return { pi, executeSubagentTool, executeCancelTool, toolsByName };
	}

	/** Dispatch a running task and return its proc (shared arrange for cancel tests). */
	async function dispatchTask(
		executeSubagentTool: ExecuteFn,
		ctx: unknown,
		taskId: string,
		task = "整理季度报表并输出摘要",
	) {
		const executePromise = executeSubagentTool(
			"call-dispatch",
			{ agent: "tester", task, sessionId: taskId },
			undefined,
			undefined,
			ctx,
		);
		await raceWithTimeout(executePromise, 200);
		expect(taskRegistry.get(taskId)?.status).toBe("running");
		return allProcs[allProcs.length - 1];
	}

	// ================================================================
	// 1. 单入口 action 参数（既有契约，保持绿）
	// ================================================================
	describe("1. 单入口 action 参数（既有契约）", () => {
		it("subagent 工具 parameters 应声明 action 字段", () => {
			const { toolsByName } = setupExtension();

			const subagent = toolsByName.get("subagent");
			expect(subagent, "subagent tool should be registered").toBeDefined();
			const props = subagent.parameters.properties || {};
			expect(props.action, "subagent parameters should declare an action field").toBeDefined();
		});

		it("subagent_cancel 工具不应再单独注册", () => {
			const { toolsByName } = setupExtension();
			expect(toolsByName.has("subagent_cancel")).toBe(false);
		});
	});

	// ================================================================
	// 2. Schema：confirm / reason 参数（新契约 1，RED）
	// ================================================================
	describe("2. Schema：confirm / reason 参数（新契约）", () => {
		it("subagent 工具 parameters 应声明可选的 confirm（boolean）字段（RED：当前 schema 无 confirm）", () => {
			const { toolsByName } = setupExtension();

			const subagent = toolsByName.get("subagent");
			const props = subagent.parameters.properties || {};
			expect(props.confirm, "subagent parameters should declare a confirm field").toBeDefined();
			expect(props.confirm.type).toBe("boolean");
			// confirm 必须可选（不得进 required）：缺省 = false = 首次调用只质询
			const required: string[] = subagent.parameters.required || [];
			expect(required).not.toContain("confirm");
			// 缺省 = false = 首次调用只质询
			expect(props.confirm.default).toBe(false);
		});

		it("subagent 工具 parameters 应声明可选的 reason（string）字段（RED：当前 schema 无 reason）", () => {
			const { toolsByName } = setupExtension();

			const subagent = toolsByName.get("subagent");
			const props = subagent.parameters.properties || {};
			expect(props.reason, "subagent parameters should declare a reason field").toBeDefined();
			expect(props.reason.type).toBe("string");
			const required: string[] = subagent.parameters.required || [];
			expect(required).not.toContain("reason");
		});
	});

	// ================================================================
	// 3. 首次 cancel → 质询回执（新契约 2：零副作用 + challenge，RED）
	// ================================================================
	describe("3. 首次 cancel（无 confirm / confirm≠true）→ 质询回执", () => {
		it("无 confirm 的首次 cancel 应零副作用：任务继续运行、abort 未触发、无 [subagent-result] 通知（RED：当前直接执行取消）", async () => {
			const { executeSubagentTool, executeCancelTool, pi } = setupExtension();
			const ctx = createMockTuiCtx(defaultCwd);
			const taskId = "019ffdd3-3eb5-733d-b481-a53e5292bda0";

			// Arrange
			const proc = await dispatchTask(executeSubagentTool!, ctx, taskId);

			// Act: 首次 cancel，不带 confirm
			await executeCancelTool!("call-cancel", { taskId }, undefined, undefined, ctx);

			// Assert: 零副作用 —— registry 条目不动、abortController 未触发、
			// 子进程未收到 SIGTERM、无 [subagent-result] 通知发出
			const record = taskRegistry.get(taskId);
			expect(record?.status, "质询不得改变任务状态").toBe("running");
			expect(record?.abortController.signal.aborted, "质询不得触发 abortController").toBe(false);
			expect(proc.kill, "质询不得 kill 子进程").not.toHaveBeenCalled();
			expect(pi.sendMessage, "质询不得发出 [subagent-result] 通知").not.toHaveBeenCalled();
		});

		it("confirm:false 与缺省行为一致，同样只返回质询且零副作用（RED）", async () => {
			const { executeSubagentTool, executeCancelTool } = setupExtension();
			const ctx = createMockTuiCtx(defaultCwd);
			const taskId = "019ffdd3-3eb5-733d-b481-a53e5292bda1";

			// Arrange
			const proc = await dispatchTask(executeSubagentTool!, ctx, taskId);

			// Act: confirm 显式为 false（≠ true → 质询分支）
			const result = await executeCancelTool!("call-cancel", { taskId, confirm: false }, undefined, undefined, ctx);

			// Assert: 质询回执 + 任务继续运行
			expect(result.details?.confirmRequired).toBe(true);
			expect(taskRegistry.get(taskId)?.status).toBe("running");
			expect(proc.kill).not.toHaveBeenCalled();
		});

		it("质询回执应为非错误回执，details 无 results 数组、cancelled:false、confirmRequired:true（与执行成功回执区分，RED）", async () => {
			const { executeSubagentTool, executeCancelTool } = setupExtension();
			const ctx = createMockTuiCtx(defaultCwd);
			const taskId = "019ffdd3-3eb5-733d-b481-a53e5292bda2";

			// Arrange
			await dispatchTask(executeSubagentTool!, ctx, taskId);

			// Act
			const result = await executeCancelTool!("call-cancel", { taskId }, undefined, undefined, ctx);

			// Assert: 质询是正常中间回执（非错误）；details 形状与
			// 执行成功回执（cancelled:true，无 confirmRequired）明确区分。
			// confirmRequired 为契约示例字段名；实现若改名需同步此断言。
			expect(result.isError, "质询回执不应是错误").toBeFalsy();
			expect(result.details?.results, "质询回执 details 不得携带 results 数组").toBeUndefined();
			expect(result.details?.cancelled).toBe(false);
			expect(result.details?.confirmRequired).toBe(true);
			expect(result.details?.taskId).toBe(taskId);
		});

		it("质询正文应包含 agent 名、任务摘要与已运行时长（RED）", async () => {
			const { executeSubagentTool, executeCancelTool } = setupExtension();
			const ctx = createMockTuiCtx(defaultCwd);
			const taskId = "019ffdd3-3eb5-733d-b481-a53e5292bda3";

			// Arrange: 任务已运行约 3 秒
			await dispatchTask(executeSubagentTool!, ctx, taskId, "整理季度报表并输出摘要");
			await vi.advanceTimersByTimeAsync(3000);

			// Act
			const result = await executeCancelTool!("call-cancel", { taskId }, undefined, undefined, ctx);

			// Assert: 宽松断言关键语义点（具体措辞由实现定）
			const text = result.content.map((c: any) => c.text).join("");
			expect(text).toContain("tester");
			expect(text).toMatch(/整理季度报表/);
			expect(text).toMatch(/elapsed|running for|uptime/i);
		});

		it("从未上报进度的任务，质询正文应明示「尚无进度上报」语义（新契约 2/6，RED）", async () => {
			const { executeSubagentTool, executeCancelTool } = setupExtension();
			const ctx = createMockTuiCtx(defaultCwd);
			const taskId = "019ffdd3-3eb5-733d-b481-a53e5292bda4";

			// Arrange: dispatch 后不产生任何 stdout 事件 → 进度从未上报
			await dispatchTask(executeSubagentTool!, ctx, taskId);

			// Act
			const result = await executeCancelTool!("call-cancel", { taskId }, undefined, undefined, ctx);

			// Assert
			const text = result.content.map((c: any) => c.text).join("");
			expect(text).toMatch(/none reported yet|no progress|never reported/i);
		});

		it("已上报进度的任务，质询正文应包含最近进度距今信息（新契约 2/6，RED）", async () => {
			const { executeSubagentTool, executeCancelTool } = setupExtension();
			const ctx = createMockTuiCtx(defaultCwd);
			const taskId = "019ffdd3-3eb5-733d-b481-a53e5292bda5";

			// Arrange: 经 runSingleAgent 的 stdout JSONL 解析驱动一次真实进度上报
			//（turn_start → emitProgress → progressManager.update），再推进 5 秒
			const proc = await dispatchTask(executeSubagentTool!, ctx, taskId);
			proc.stdout.emit("data", JSON.stringify({ type: "turn_start" }) + "\n");
			await vi.advanceTimersByTimeAsync(5000);

			// Act
			const result = await executeCancelTool!("call-cancel", { taskId }, undefined, undefined, ctx);

			// Assert: 宽松断言"最近进度 + 时间量"语义（如"最近进度更新: 5 秒前"）
			const text = result.content.map((c: any) => c.text).join("");
			expect(text).toMatch(/last progress|last activity/i);
			expect(text).toMatch(/\d+\s*s\b/);
			expect(text).not.toMatch(/none reported yet/);
		});

		it("最近进度距今 ≥1 小时时应折叠为 H:MM:SS 且中英两处数值一致（长间隔分支锁定）", async () => {
			const { executeSubagentTool, executeCancelTool } = setupExtension();
			const ctx = createMockTuiCtx(defaultCwd);
			const taskId = "019ffdd3-3eb5-733d-b481-a53e5292bdc4";

			// Arrange: 默认 inactivity 超时 600s 会在推进 3665s 时先杀死任务，
			// 抬高到 2h 以隔离本用例要锁的长间隔格式化分支
			process.env.PI_SUBAGENT_ACTIVITY_TIMEOUT_MS = String(2 * 60 * 60 * 1000);
			const proc = await dispatchTask(executeSubagentTool!, ctx, taskId);
			proc.stdout.emit("data", JSON.stringify({ type: "turn_start" }) + "\n");
			await vi.advanceTimersByTimeAsync(3665_000); // 1h 1m 5s

			// Act
			const result = await executeCancelTool!("call-cancel", { taskId }, undefined, undefined, ctx);

			// Assert: 折叠为 H:MM:SS（formatDuration 复用），中英两处同一格式化值
			//（反向引用锁一致），不再出现巨型秒数
			const text = result.content.map((c: any) => c.text).join("");
			const progressLine = text.split("\n").find((l: string) => /Last progress/.test(l));
			expect(progressLine).toBeDefined();
			expect(progressLine).toContain("1:01:05");
			expect(progressLine).toMatch(/Last progress update: (\d+:\d{2}:\d{2}) ago/);
			expect(progressLine).not.toContain("3665");
			expect(progressLine).not.toMatch(/\d{4,}\s*s\b/);
		});

		it("质询正文应包含明确警告：取消将丢弃全部在途进度且不可撤销（RED）", async () => {
			const { executeSubagentTool, executeCancelTool } = setupExtension();
			const ctx = createMockTuiCtx(defaultCwd);
			const taskId = "019ffdd3-3eb5-733d-b481-a53e5292bda6";

			// Arrange
			await dispatchTask(executeSubagentTool!, ctx, taskId);

			// Act
			const result = await executeCancelTool!("call-cancel", { taskId }, undefined, undefined, ctx);

			// Assert: 宽松断言两个语义点（丢弃在途进度 + 不可撤销）
			const text = result.content.map((c: any) => c.text).join("");
			expect(text).toMatch(/discard/i);
			expect(text).toMatch(/irreversible|cannot be undone/i);
		});

		it("质询正文应包含明确的二次调用指令（action=cancel、同一 taskId、confirm:true、reason 必填，RED）", async () => {
			const { executeSubagentTool, executeCancelTool } = setupExtension();
			const ctx = createMockTuiCtx(defaultCwd);
			const taskId = "019ffdd3-3eb5-733d-b481-a53e5292bda7";

			// Arrange
			await dispatchTask(executeSubagentTool!, ctx, taskId);

			// Act
			const result = await executeCancelTool!("call-cancel", { taskId }, undefined, undefined, ctx);

			// Assert: 宽松断言指令四要素
			const text = result.content.map((c: any) => c.text).join("");
			expect(text).toContain(taskId);
			expect(text).toMatch(/confirm/i);
			expect(text).toMatch(/true/);
			expect(text).toMatch(/reason/i);
		});

		it("两步串联：质询后再以 confirm:true + reason 调用应正常执行取消（RED：当前首次调用即执行，第二次报「无此运行中任务」）", async () => {
			const { executeSubagentTool, executeCancelTool } = setupExtension();
			const ctx = createMockTuiCtx(defaultCwd);
			const taskId = "019ffdd3-3eb5-733d-b481-a53e5292bda8";

			// Arrange
			const proc = await dispatchTask(executeSubagentTool!, ctx, taskId);

			// Act: 第一步质询
			const challenge = await executeCancelTool!("call-1", { taskId }, undefined, undefined, ctx);
			expect(challenge.details?.confirmRequired).toBe(true);
			// 质询与确认之间任务必须仍在运行
			expect(taskRegistry.get(taskId)?.status).toBe("running");

			// Act: 第二步确认
			const confirmed = await executeCancelTool!(
				"call-2",
				{ taskId, confirm: true, reason: "任务目标已改变" },
				undefined,
				undefined,
				ctx,
			);

			// Assert: 确认调用执行取消
			expect(confirmed.isError).toBeFalsy();
			expect(confirmed.details?.cancelled).toBe(true);
			expect(taskRegistry.get(taskId)?.status).toBe("cancelled");
			expect(proc.kill).toHaveBeenCalledWith("SIGTERM");
		});

		it("confirm 传字符串 \"true\" 或数字 1（非 boolean true）→ 仍走质询分支且零副作用（边界锁定）", async () => {
			const { executeSubagentTool, executeCancelTool } = setupExtension();
			const ctx = createMockTuiCtx(defaultCwd);
			const taskId = "019ffdd3-3eb5-733d-b481-a53e5292bdc0";

			// Arrange
			const proc = await dispatchTask(executeSubagentTool!, ctx, taskId);

			// Act: confirm 为非 boolean 真值（schema 之外的宽松调用）——只有
			// 严格的 confirm === true 才进入确认分支，其余一律质询（fail-safe）
			const asString = await executeCancelTool!("call-1", { taskId, confirm: "true" }, undefined, undefined, ctx);
			const asNumber = await executeCancelTool!("call-2", { taskId, confirm: 1 }, undefined, undefined, ctx);

			// Assert: 两次都返回质询回执，任务零副作用继续运行
			for (const result of [asString, asNumber]) {
				expect(result.isError).toBeFalsy();
				expect(result.details?.confirmRequired).toBe(true);
				expect(result.details?.cancelled).toBe(false);
			}
			expect(taskRegistry.get(taskId)?.status).toBe("running");
			expect(taskRegistry.get(taskId)?.abortController.signal.aborted).toBe(false);
			expect(proc.kill).not.toHaveBeenCalled();
		});

		it("连续两次质询（均无 confirm）→ 均返回 confirmRequired:true 且均零副作用（质询可重复，边界锁定）", async () => {
			const { executeSubagentTool, executeCancelTool } = setupExtension();
			const ctx = createMockTuiCtx(defaultCwd);
			const taskId = "019ffdd3-3eb5-733d-b481-a53e5292bdc1";

			// Arrange
			const proc = await dispatchTask(executeSubagentTool!, ctx, taskId);

			// Act: 质询无状态、不过期——重复首次调用应得到同样的质询回执
			const first = await executeCancelTool!("call-1", { taskId }, undefined, undefined, ctx);
			const second = await executeCancelTool!("call-2", { taskId }, undefined, undefined, ctx);

			// Assert
			expect(first.details?.confirmRequired).toBe(true);
			expect(second.details?.confirmRequired).toBe(true);
			expect(first.isError).toBeFalsy();
			expect(second.isError).toBeFalsy();
			expect(taskRegistry.get(taskId)?.status).toBe("running");
			expect(taskRegistry.get(taskId)?.abortController.signal.aborted).toBe(false);
			expect(proc.kill).not.toHaveBeenCalled();
		});
	});

	// ================================================================
	// 4. 确认 cancel：reason 校验与理由落库（新契约 3，RED）
	// ================================================================
	describe("4. 确认 cancel（confirm:true）的 reason 校验与理由落库", () => {
		it("confirm:true 但 reason 缺失 → 报错且零副作用，任务继续运行（RED：当前无 reason 校验，直接执行）", async () => {
			const { executeSubagentTool, executeCancelTool, pi } = setupExtension();
			const ctx = createMockTuiCtx(defaultCwd);
			const taskId = "019ffdd3-3eb5-733d-b481-a53e5292bdb0";

			// Arrange
			const proc = await dispatchTask(executeSubagentTool!, ctx, taskId);

			// Act
			const result = await executeCancelTool!("call-cancel", { taskId, confirm: true }, undefined, undefined, ctx);

			// Assert: 错误指向 reason 必填；任务零副作用继续运行
			expect(result.isError).toBe(true);
			const text = result.content.map((c: any) => c.text).join("");
			expect(text).toMatch(/reason/i);
			expect(text).toMatch(/required|missing/i);
			expect(taskRegistry.get(taskId)?.status).toBe("running");
			expect(taskRegistry.get(taskId)?.abortController.signal.aborted).toBe(false);
			expect(proc.kill).not.toHaveBeenCalled();
			expect(pi.sendMessage).not.toHaveBeenCalled();
		});

		it("confirm:true 但 reason 为空白字符串 → 报错且零副作用（RED）", async () => {
			const { executeSubagentTool, executeCancelTool } = setupExtension();
			const ctx = createMockTuiCtx(defaultCwd);
			const taskId = "019ffdd3-3eb5-733d-b481-a53e5292bdb1";

			// Arrange
			const proc = await dispatchTask(executeSubagentTool!, ctx, taskId);

			// Act: reason 仅含空白字符，视同缺失
			const result = await executeCancelTool!(
				"call-cancel",
				{ taskId, confirm: true, reason: "   " },
				undefined,
				undefined,
				ctx,
			);

			// Assert
			expect(result.isError).toBe(true);
			const text = result.content.map((c: any) => c.text).join("");
			expect(text).toMatch(/reason/i);
			expect(taskRegistry.get(taskId)?.status).toBe("running");
			expect(proc.kill).not.toHaveBeenCalled();
		});

		it("confirm:true + 非空 reason 执行取消后，reason 应记录在任务记录上（RED：当前任务记录无理由字段）", async () => {
			const { executeSubagentTool, executeCancelTool } = setupExtension();
			const ctx = createMockTuiCtx(defaultCwd);
			const taskId = "019ffdd3-3eb5-733d-b481-a53e5292bdb2";
			const reason = "目标已由用户手动完成-superseded-x9q";

			// Arrange
			await dispatchTask(executeSubagentTool!, ctx, taskId);

			// Act
			const result = await executeCancelTool!(
				"call-cancel",
				{ taskId, confirm: true, reason },
				undefined,
				undefined,
				ctx,
			);

			// Assert: 执行成功且任务记录携带取消理由。
			// 字段名由实现定（cancelReason 等），只锁行为语义：记录上可读到该理由。
			expect(result.isError).toBeFalsy();
			const record: any = taskRegistry.get(taskId);
			expect(record, "取消后任务记录应仍在 registry（completeAsyncTask 前）").toBeDefined();
			expect(record.cancelReason, "任务记录应携带取消理由").toBe(reason);
		});

		it("confirm:true + 非空 reason 取消后，[subagent-result] 信封正文应包含该理由（abortedFallbackBody agent 分支，RED）", async () => {
			const { executeSubagentTool, executeCancelTool, pi } = setupExtension();
			const ctx = createMockTuiCtx(defaultCwd);
			const taskId = "019ffdd3-3eb5-733d-b481-a53e5292bdb3";
			const reason = "需求已变更，结果不再可用-req-changed-k7m";

			// Arrange
			await dispatchTask(executeSubagentTool!, ctx, taskId);

			// Act
			await executeCancelTool!("call-cancel", { taskId, confirm: true, reason }, undefined, undefined, ctx);
			endProcess(allProcs[0], null, "SIGTERM");
			await vi.advanceTimersByTimeAsync(1000);

			// Assert: 信封仍标明主 agent 来源（既有语义不回归），且正文包含取消理由
			expect(pi.sendMessage).toHaveBeenCalled();
			const [message] = pi._sendMessageCalls[0];
			expect(message.customType).toBe("subagent-result");
			expect(message.details.cancelledBy).toBe("agent");
			const content: string = message.content;
			expect(content).toMatch(/main\s*agent/);
			expect(content).toContain(reason);
		});

		it("confirm:true + 非空 reason + 不存在 taskId → 维持「无此运行中任务」报错（回归锁定：存在性优先于确认，保持绿）", async () => {
			const { executeCancelTool } = setupExtension();
			const ctx = createMockTuiCtx(defaultCwd);

			// Act
			const result = await executeCancelTool!(
				"call-1",
				{ taskId: "non-existent-task-id", confirm: true, reason: "清理不再需要" },
				undefined,
				undefined,
				ctx,
			);

			// Assert
			expect(result.isError).toBe(true);
			const text = result.content.map((c: any) => c.text).join("");
			expect(text).toMatch(/No running subagent task with this id|no running|not found/i);
		});

		it("confirm:true 但 reason 为非 string 类型（number/object）→ 报错且零副作用（边界锁定）", async () => {
			const { executeSubagentTool, executeCancelTool } = setupExtension();
			const ctx = createMockTuiCtx(defaultCwd);
			const taskId = "019ffdd3-3eb5-733d-b481-a53e5292bdc2";

			// Arrange
			const proc = await dispatchTask(executeSubagentTool!, ctx, taskId);

			// Act: reason 必须是字符串；number/object 视同缺失（fail-safe 拒绝）
			const asNumber = await executeCancelTool!("call-1", { taskId, confirm: true, reason: 42 }, undefined, undefined, ctx);
			const asObject = await executeCancelTool!("call-2", { taskId, confirm: true, reason: { why: "x" } }, undefined, undefined, ctx);

			// Assert: 报错指向 reason 必填，任务零副作用继续运行
			for (const result of [asNumber, asObject]) {
				expect(result.isError).toBe(true);
				const text = result.content.map((c: any) => c.text).join("");
				expect(text).toMatch(/reason/i);
			}
			expect(taskRegistry.get(taskId)?.status).toBe("running");
			expect(taskRegistry.get(taskId)?.abortController.signal.aborted).toBe(false);
			expect(proc.kill).not.toHaveBeenCalled();
		});

		it("质询后任务自然结束，再以 confirm:true + reason 确认 → 报「无此运行中任务」（存在性校验优先，边界锁定）", async () => {
			const { executeSubagentTool, executeCancelTool, pi } = setupExtension();
			const ctx = createMockTuiCtx(defaultCwd);
			const taskId = "019ffdd3-3eb5-733d-b481-a53e5292bdc3";

			// Arrange
			const proc = await dispatchTask(executeSubagentTool!, ctx, taskId);

			// Act: 第一步质询
			const challenge = await executeCancelTool!("call-1", { taskId }, undefined, undefined, ctx);
			expect(challenge.details?.confirmRequired).toBe(true);

			// 质询与确认之间任务自然结束（exit 0 → completeAsyncTask → 出 registry）。
			// 本用例验证「确认时任务已不在 registry」的存在性校验，不依赖终态；
			// endProcess(0) 仅用于触发 completeAsyncTask。
			endProcess(proc, 0);
			await vi.advanceTimersByTimeAsync(1000);
			expect(taskRegistry.has(taskId)).toBe(false);
			expect(pi.sendMessage).toHaveBeenCalled();

			// Act: 第二步确认——存在性校验优先于 confirm/reason，报无此运行中任务
			const result = await executeCancelTool!(
				"call-2",
				{ taskId, confirm: true, reason: "任务目标已改变" },
				undefined,
				undefined,
				ctx,
			);

			// Assert
			expect(result.isError).toBe(true);
			const text = result.content.map((c: any) => c.text).join("");
			expect(text).toMatch(/No running subagent task with this id|no running|not found/i);
		});
	});

	// ================================================================
	// 5. 确认后执行行为（契约变更迁移：原 describe 2「工具取消行为」）
	//
	// 变更理由：旧契约下这 4 个用例以"无 confirm 直接执行"调用 action=cancel；
	// 两步确认契约下首次调用只返回质询，故迁移为"confirm:true + 非空 reason"
	// 的确认调用，继续钉住确认后的执行效果（与旧单步执行一致）。质询行为本身
	// 由 describe 3 的新增用例钉住。
	// ================================================================
	describe("5. 确认后执行行为（kill + 信封 cancelledBy=agent + agent 正文）", () => {
		it("confirm 取消后子进程应被 SIGTERM（kill 调用）且任务状态变为 cancelled", async () => {
			const { executeSubagentTool, executeCancelTool } = setupExtension();
			expect(executeCancelTool, "executeCancelTool should be defined").toBeDefined();
			const ctx = createMockTuiCtx(defaultCwd);

			// Arrange: dispatch a task
			const executePromise = executeSubagentTool!(
				"call-1",
				{ agent: "tester", task: "test task", sessionId: "019ffdd3-3eb5-733d-b481-a53e5292bd70" },
				undefined,
				undefined,
				ctx,
			);
			await raceWithTimeout(executePromise, 200);

			expect(taskRegistry.has("019ffdd3-3eb5-733d-b481-a53e5292bd70")).toBe(true);
			const proc = allProcs[0];
			expect(proc).toBeDefined();

			// Act: confirm cancel via tool（两步确认的第二步）
			await executeCancelTool!(
				"call-2",
				{ taskId: "019ffdd3-3eb5-733d-b481-a53e5292bd70", confirm: true, reason: "任务目标已改变" },
				undefined,
				undefined,
				ctx,
			);

			// Assert: task status is cancelled and abort was triggered (SIGTERM sent)
			expect(taskRegistry.get("019ffdd3-3eb5-733d-b481-a53e5292bd70")?.status).toBe("cancelled");
			expect(proc.kill).toHaveBeenCalledWith("SIGTERM");
		});

		it("confirm 取消后信封 details 应含 cancelledBy='agent'", async () => {
			const { executeSubagentTool, executeCancelTool, pi } = setupExtension();
			expect(executeCancelTool, "executeCancelTool should be defined").toBeDefined();
			const ctx = createMockTuiCtx(defaultCwd);

			// Arrange: dispatch a task
			const executePromise = executeSubagentTool!(
				"call-1",
				{ agent: "tester", task: "test task", sessionId: "019ffdd3-3eb5-733d-b481-a53e5292bd71" },
				undefined,
				undefined,
				ctx,
			);
			await raceWithTimeout(executePromise, 200);

			// Act: confirm cancel via tool
			await executeCancelTool!(
				"call-2",
				{ taskId: "019ffdd3-3eb5-733d-b481-a53e5292bd71", confirm: true, reason: "任务目标已改变" },
				undefined,
				undefined,
				ctx,
			);

			// Drive the abort cascade → completeAsyncTask → sendMessage
			endProcess(allProcs[0], null, "SIGTERM");
			await vi.advanceTimersByTimeAsync(1000);

			// Assert: envelope sent with cancelled status and cancelledBy=agent
			expect(pi.sendMessage).toHaveBeenCalled();
			const [message] = pi._sendMessageCalls[0];
			expect(message.customType).toBe("subagent-result");
			expect(message.details.cancelledBy).toBe("agent");
		});

		it('confirm 取消后信封正文应标明由主 agent 取消（区分来源，非用户取消文案）', async () => {
			const { executeSubagentTool, executeCancelTool, pi } = setupExtension();
			expect(executeCancelTool, "executeCancelTool should be defined").toBeDefined();
			const ctx = createMockTuiCtx(defaultCwd);

			// Arrange
			const executePromise = executeSubagentTool!(
				"call-1",
				{ agent: "tester", task: "test task", sessionId: "019ffdd3-3eb5-733d-b481-a53e5292bd72" },
				undefined,
				undefined,
				ctx,
			);
			await raceWithTimeout(executePromise, 200);

			// Act
			await executeCancelTool!(
				"call-2",
				{ taskId: "019ffdd3-3eb5-733d-b481-a53e5292bd72", confirm: true, reason: "任务目标已改变" },
				undefined,
				undefined,
				ctx,
			);

			endProcess(allProcs[0], null, "SIGTERM");
			await vi.advanceTimersByTimeAsync(1000);

			// Assert: 取消信封（已取消）+ 主 agent 来源 + 非用户取消文案
			expect(pi.sendMessage).toHaveBeenCalled();
			const [message] = pi._sendMessageCalls[0];
			const content: string = message.content;
			expect(content).toMatch(/cancelled/);
			expect(content).toMatch(/main\s*agent/);
			expect(content).not.toMatch(/Do not automatically re-dispatch/i);
		});

		it("confirm 取消应返回成功回执，确认任务已取消（与质询回执区分）", async () => {
			const { executeSubagentTool, executeCancelTool } = setupExtension();
			expect(executeCancelTool, "executeCancelTool should be defined").toBeDefined();
			const ctx = createMockTuiCtx(defaultCwd);

			// Arrange
			const executePromise = executeSubagentTool!(
				"call-1",
				{ agent: "tester", task: "test task", sessionId: "019ffdd3-3eb5-733d-b481-a53e5292bd73" },
				undefined,
				undefined,
				ctx,
			);
			await raceWithTimeout(executePromise, 200);

			// Act
			const result = await executeCancelTool!(
				"call-2",
				{ taskId: "019ffdd3-3eb5-733d-b481-a53e5292bd73", confirm: true, reason: "任务目标已改变" },
				undefined,
				undefined,
				ctx,
			);

			// Assert: not an error, content mentions the taskId, details 为执行成功
			// 形状（cancelled:true 且无 confirmRequired 标记，与质询回执区分）
			expect(result.isError).toBeFalsy();
			const text = result.content.map((c: any) => c.text).join("");
			expect(text).toMatch(/019ffdd3-3eb5-733d-b481-a53e5292bd73/);
			expect(text).toMatch(/cancel/i);
			expect(result.details).toMatchObject({ taskId: "019ffdd3-3eb5-733d-b481-a53e5292bd73", cancelled: true });
			expect(result.details?.confirmRequired, "执行成功回执不得携带质询标记").toBeFalsy();
		});

		it("confirm 取消唯一任务后回执应锚定取消请求时刻：含「已无其他在途任务」语义且不含「本任务结束」（🟡-1 回执措辞锁定）", async () => {
			const { executeSubagentTool, executeCancelTool } = setupExtension();
			expect(executeCancelTool, "executeCancelTool should be defined").toBeDefined();
			const ctx = createMockTuiCtx(defaultCwd);

			// Arrange: 只派发 1 个任务
			const executePromise = executeSubagentTool!(
				"call-1",
				{ agent: "tester", task: "唯一任务", sessionId: "019ffdd3-3eb5-733d-b481-a53e5292bd80" },
				undefined,
				undefined,
				ctx,
			);
			await raceWithTimeout(executePromise, 200);

			// Act: confirm cancel（两步确认的第二步）
			const result = await executeCancelTool!(
				"call-2",
				{ taskId: "019ffdd3-3eb5-733d-b481-a53e5292bd80", confirm: true, reason: "任务目标已改变" },
				undefined,
				undefined,
				ctx,
			);

			// Assert: 回执锚定「取消请求发出后」而非信封的「本任务结束」——确认时本任务
			// 并未结束（结果稍后以 [subagent-result] 通知返回）。若未来被改回共享
			// formatActiveTasks() 的「本任务结束时」锚定，本用例会红。
			const text = result.content.map((c: any) => c.text).join("");
			expect(text).toMatch(/No other tasks are in flight after this cancel request/);
			expect(text).not.toMatch(/when this task ended/);
			expect(text).not.toMatch(/No tasks? (are|were) in flight/i);
		});

		it("confirm 取消后回执应锚定取消请求时刻并保留其余在途任务行（2 派 1 消，🟡-1 回执措辞锁定）", async () => {
			const { executeSubagentTool, executeCancelTool } = setupExtension();
			expect(executeCancelTool, "executeCancelTool should be defined").toBeDefined();
			const ctx = createMockTuiCtx(defaultCwd);

			// Arrange: 派发 2 个任务
			const executePromise1 = executeSubagentTool!(
				"call-1",
				{ agent: "tester", task: "任务1", sessionId: "019ffdd3-3eb5-733d-b481-a53e5292bd81" },
				undefined,
				undefined,
				ctx,
			);
			await raceWithTimeout(executePromise1, 200);
			const executePromise2 = executeSubagentTool!(
				"call-2",
				{ agent: "tester", task: "任务2", sessionId: "019ffdd3-3eb5-733d-b481-a53e5292bd82" },
				undefined,
				undefined,
				ctx,
			);
			await raceWithTimeout(executePromise2, 200);
			expect(taskRegistry.size).toBe(2);

			// Act: confirm 取消第一个
			const result = await executeCancelTool!(
				"call-3",
				{ taskId: "019ffdd3-3eb5-733d-b481-a53e5292bd81", confirm: true, reason: "任务目标已改变" },
				undefined,
				undefined,
				ctx,
			);

			// Assert: 锚定「取消请求发出后」（锁语义：同行含 取消请求发出后 + 其余在途任务: 1），
			// 其余在途任务行不丢失、排除被取消任务，且不得出现信封专属的「本任务结束」锚定语。
			const text = result.content.map((c: any) => c.text).join("");
			const anchored = text.split("\n").some((line: string) => /after this cancel request/.test(line) && /still in flight after this cancel request: 1/.test(line));
			expect(anchored, "回执应有锚定取消请求发出时刻的在途行（如「取消请求发出后，其余在途任务: 1」）").toBe(true);
			expect(text).not.toMatch(/when this task ended/);
			expect(text).toContain("019ffdd3-3eb5-733d-b481-a53e5292bd82");
			expect(text).toContain("tester");
			expect(text).toMatch(/任务2/);
			const taskLines = text.split("\n").filter((l: string) => /^- .* \(.*\):/.test(l));
			for (const line of taskLines) {
				expect(line).not.toContain("019ffdd3-3eb5-733d-b481-a53e5292bd81");
			}
		});
	});

	// ================================================================
	// 6. 命令路径来源不变（user，契约 4 回归锁定：单步、无需 confirm/reason）
	// ================================================================
	describe("6. 命令路径来源不变（/subagent-cancel → cancelledBy='user'）", () => {
		it('/subagent-cancel 命令取消后信封 details 应含 cancelledBy="user"', async () => {
			const { executeSubagentTool: executeTool, pi } = setupExtension();
			const ctx = createMockTuiCtx(defaultCwd);

			// Arrange: dispatch a task
			const executePromise = executeTool!(
				"call-1",
				{ agent: "tester", task: "test task", sessionId: "019ffdd3-3eb5-733d-b481-a53e5292bd74" },
				undefined,
				undefined,
				ctx,
			);
			await raceWithTimeout(executePromise, 200);

			// Act: cancel via command（用户路径单步直接执行，不要求 confirm/reason）
			const cancelCommand = pi._commandDefs.get("subagent-cancel");
			expect(cancelCommand).toBeDefined();
			await cancelCommand.handler("019ffdd3-3eb5-733d-b481-a53e5292bd74", { ui: { notify: vi.fn() } });

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
				{ agent: "tester", task: "test task", sessionId: "019ffdd3-3eb5-733d-b481-a53e5292bd75" },
				undefined,
				undefined,
				ctx,
			);
			await raceWithTimeout(executePromise, 200);

			// Act
			const cancelCommand = pi._commandDefs.get("subagent-cancel");
			await cancelCommand.handler("019ffdd3-3eb5-733d-b481-a53e5292bd75", { ui: { notify: vi.fn() } });

			endProcess(allProcs[0], null, "SIGTERM");
			await vi.advanceTimersByTimeAsync(1000);

			// Assert: body should still contain user-cancel semantics
			expect(pi.sendMessage).toHaveBeenCalled();
			const [message] = pi._sendMessageCalls[0];
			const content: string = message.content;
			expect(content).toMatch(/user.*cancel|cancel.*user|\/subagent-cancel/i);
		});
	});

	// ================================================================
	// 7. action=cancel 取消不存在任务（契约 2 前两条：维持现有报错，保持绿）
	// ================================================================
	describe("7. action=cancel 取消不存在任务（维持现有报错）", () => {
		it("action=cancel 传入不存在的 taskId → 错误提示无此运行中任务", async () => {
			const { executeCancelTool } = setupExtension();
			expect(executeCancelTool, "executeCancelTool should be defined").toBeDefined();

			const ctx = createMockTuiCtx(defaultCwd);

			const result = await executeCancelTool!(
				"call-1",
				{ taskId: "non-existent-task-id" },
				undefined,
				undefined,
				ctx,
			);

			// 错误且提示无此运行中任务（不能只是任意参数错误）
			expect(result.isError).toBe(true);
			const text = result.content.map((c: any) => c.text).join("");
			expect(text).toMatch(/No running subagent task with this id|no running|not found/i);
		});

		it("action=cancel 传入空 taskId → 错误提示必填", async () => {
			const { executeCancelTool } = setupExtension();
			expect(executeCancelTool, "executeCancelTool should be defined").toBeDefined();

			const ctx = createMockTuiCtx(defaultCwd);

			const result = await executeCancelTool!(
				"call-1",
				{ taskId: "" },
				undefined,
				undefined,
				ctx,
			);

			expect(result.isError).toBe(true);
			const text = result.content.map((c: any) => c.text).join("");
			// 必须指向 taskId 参数，而不是其它参数
			expect(text).toMatch(/taskId/);
			expect(text).toMatch(/required|missing|empty/i);
		});
	});

	// ================================================================
	// 8. 工具提示词：防滥用引导（保持绿）+ 两步确认与等待语义（新契约 5，RED）
	// ================================================================
	describe("8. 工具提示词（description / promptGuidelines）", () => {
		it('subagent 工具的 description 应包含"取消"字样（防滥用引导保留）', () => {
			const { toolsByName } = setupExtension();
			const subagent = toolsByName.get("subagent");
			expect(subagent, "subagent tool should be registered").toBeDefined();
			expect(subagent.description).toMatch(/cancel/i);
		});

		it('subagent 工具的 description 应包含"错误"或"不再需要"类引导（防滥用引导保留）', () => {
			const { toolsByName } = setupExtension();
			const subagent = toolsByName.get("subagent");
			expect(subagent, "subagent tool should be registered").toBeDefined();
			expect(subagent.description).toMatch(/wrong|no longer needed|unnecessary/i);
		});

		it("subagent 工具的 description 应包含不要因等待时间长而取消的引导（防滥用引导保留）", () => {
			const { toolsByName } = setupExtension();
			const subagent = toolsByName.get("subagent");
			expect(subagent, "subagent tool should be registered").toBeDefined();
			expect(subagent.description).toMatch(/patience|be patient|Do NOT cancel/i);
		});

		it("description 的 CANCEL DISCIPLINE 应包含 confirm 两步确认指引（RED：当前描述无 confirm 语义）", () => {
			const { toolsByName } = setupExtension();
			const subagent = toolsByName.get("subagent");
			expect(subagent, "subagent tool should be registered").toBeDefined();
			// 宽松断言关键语义点：取消流程需出现 confirm 相关指引（具体措辞由实现定）
			expect(subagent.description).toMatch(/confirm/i);
		});

		it("promptGuidelines 应包含两步确认条目（同时提及 confirm 与 reason，RED）", () => {
			const { toolsByName } = setupExtension();
			const subagent = toolsByName.get("subagent");
			const guidelines: string[] = subagent.promptGuidelines || [];
			expect(guidelines.length).toBeGreaterThan(0);

			const hasTwoStepGuideline = guidelines.some((g: string) => /confirm/i.test(g) && /reason/i.test(g));
			expect(hasTwoStepGuideline, "promptGuidelines 应有条目同时提及 confirm 与 reason").toBe(true);
		});

		it("应声明「等待 = 不发起任何工具调用、直接结束回合」语义（RED：当前仅说 be patient/end the turn，未把等待与不发起调用绑定）", () => {
			const { toolsByName } = setupExtension();
			const subagent = toolsByName.get("subagent");
			// 同一行/同一条内同时含"等待"语义与"结束回合/不发起调用"语义。
			// description 是多行字符串，必须按行拆分（整体匹配会让分属不同行的
			// "耐心等待"与"or end the turn"误过——红阶段曾因此假绿）。
			const lines = [
				...(subagent.description as string).split("\n"),
				...((subagent.promptGuidelines as string[]) || []),
			];
			const hasWaitingSemantics = lines.some(
				(l) => /wait/i.test(l) && /end (the )?turn|without (any )?tool call|no tool call/i.test(l),
			);
			expect(hasWaitingSemantics).toBe(true);
		});

		it("应声明「对在途任务不存在查询/催办类动作（刻意设计）」语义（RED）", () => {
			const { toolsByName } = setupExtension();
			const subagent = toolsByName.get("subagent");
			const lines = [
				...(subagent.description as string).split("\n"),
				...((subagent.promptGuidelines as string[]) || []),
			];
			// 宽松断言：同一行/条内出现查询/催办类词与否定语义
			//（不含 poll —— 现行描述已有 "Do NOT poll"，避免误过）
			const hasNoQuerySemantics = lines.some(
				(l) => /query|nag/i.test(l) && /no |none/i.test(l),
			);
			expect(hasNoQuerySemantics).toBe(true);
		});
	});

	// ================================================================
	// 9. 回归锁定：用户取消路径现有测试保持绿（契约 4）
	// ================================================================
	describe("9. 回归锁定：用户取消路径", () => {
		it("用户取消后信封状态应为「已取消」（cancelled）", async () => {
			const { executeSubagentTool: executeTool, pi } = setupExtension();
			const ctx = createMockTuiCtx(defaultCwd);

			const executePromise = executeTool!(
				"call-1",
				{ agent: "tester", task: "test task", sessionId: "019ffdd3-3eb5-733d-b481-a53e5292bd76" },
				undefined,
				undefined,
				ctx,
			);
			await raceWithTimeout(executePromise, 200);

			const cancelCommand = pi._commandDefs.get("subagent-cancel");
			await cancelCommand.handler("019ffdd3-3eb5-733d-b481-a53e5292bd76", { ui: { notify: vi.fn() } });

			endProcess(allProcs[0], null, "SIGTERM");
			await vi.advanceTimersByTimeAsync(1000);

			expect(pi.sendMessage).toHaveBeenCalled();
			const [message] = pi._sendMessageCalls[0];
			expect(message.customType).toBe("subagent-result");
			// 状态词为"已取消" (cancelled status word in the content)
			expect(message.content).toMatch(/cancelled/);
		});

		it("用户取消后 /subagent-cancel 命令仍然正常工作（单步，功能不退化）", async () => {
			const { executeSubagentTool: executeTool, pi } = setupExtension();
			const ctx = createMockTuiCtx(defaultCwd);

			const executePromise = executeTool!(
				"call-1",
				{ agent: "tester", task: "test task", sessionId: "019ffdd3-3eb5-733d-b481-a53e5292bd77" },
				undefined,
				undefined,
				ctx,
			);
			await raceWithTimeout(executePromise, 200);

			const cancelCommand = pi._commandDefs.get("subagent-cancel");
			expect(cancelCommand).toBeDefined();

			const notifyMock = vi.fn();
			await cancelCommand.handler("019ffdd3-3eb5-733d-b481-a53e5292bd77", { ui: { notify: notifyMock } });

			// Task status should be cancelled（用户路径单步直接执行，无质询）
			expect(taskRegistry.get("019ffdd3-3eb5-733d-b481-a53e5292bd77")?.status).toBe("cancelled");
			// Command should emit info notification
			expect(notifyMock).toHaveBeenCalledWith(
				expect.stringContaining("019ffdd3-3eb5-733d-b481-a53e5292bd77"),
				"info",
			);
		});
	});
});
