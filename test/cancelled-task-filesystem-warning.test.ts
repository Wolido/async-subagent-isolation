/**
 * 取消任务的文件系统残留警告 —— 红阶段契约测试
 *
 * 本文件守护的契约（尚未实现，故本文件预期红）：
 * 取消是**中途杀进程**（SIGTERM → 5s → SIGKILL），已落盘的写入不会回滚。
 * 因此"已取消"≠"工作区未被触碰"：子 agent 可能留下写了一半的编辑、已经
 * 生效的改动，或多步改动里只完成了一步。若不在取消回执 / 质询回执 /
 * [subagent-result] 信封 / 用户侧 notify 里显式提醒，主 agent 与用户就会
 * 把已取消的任务当成"什么都没发生"，进而在一个半成品工作区上继续作业。
 *
 * 契约要点（唯一真源常量 `CANCELLED_TASK_EFFECTS_WARNING`：本文件既 import 该
 * 常量，也保留冻结字面量 EXPECTED_WARNING 作为契约锚 —— 见「0. 唯一真源一致性」，
 * 两侧逐字不一致即红，且行为断言一律用常量而非字面量）：
 *  1. 确认取消回执：`Cancel request sent: ...` → 空行 → 警告 → 空行 → 在途块。
 *  2. 取消类 [subagent-result] 信封：正文之后 → 空行 → 警告（**只出现一次**），
 *     且 details.output / details 里均不得出现该警告。
 *  3. 质询回执：既有 `⚠️ Cancelling discards ...` 行 → 空行 → 警告 → 空行 →
 *     既有 `To confirm the cancel, ...` 指令行。
 *  4. 用户侧 notify 用**短句**（不复用长常量）；零任务等既有分支文案不动。
 *  5. 成功/失败/超时信封**不得**出现该警告（负向锁定，防误伤常态路径）。
 *
 * 同时本文件是措辞漂移守卫：EXPECTED_WARNING 必须与实现里的常量逐字一致
 * （emoji、em dash、反引号、分号都不例外）。
 *
 * 本文件不改生产代码、不改既有测试文件；既有测试没有任何一处逐字锁定
 * 取消回执 / 质询回执全文，故与本契约不冲突。
 */

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn } from "node:child_process";
import extension, {
	buildResultEnvelope,
	CANCELLED_TASK_EFFECTS_WARNING,
	taskRegistry,
	resetProgressManagerForTests,
	type AsyncSubagentTask,
} from "../src/index.ts";
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

/**
 * 契约锚：待实现常量 `CANCELLED_TASK_EFFECTS_WARNING` 的逐字值。
 * 故意写成本文件内的冻结字面量（而非 import 常量）：常量尚不存在时，
 * 本文件仍能完整加载，红只来自断言失败。
 */
const EXPECTED_WARNING =
	"⚠️ A cancelled subagent is killed mid-run, so its work stops wherever it was: anything it had already written stays on disk — possibly a half-written edit, a change already applied, or only one step of a multi-step change. Verify the files it touched before relying on the workspace (e.g. `git status` / `git diff`); a cancelled task is not the same as an untouched tree.";

/** 既有（未改动）质询回执里的不可撤销警告行，本文件用它做顺序锚点。 */
const EXISTING_CHALLENGE_WARNING =
	"⚠️ Cancelling discards all of this task's in-flight progress and cannot be undone.";

/** 既有（未改动）零任务分支文案。 */
const NO_TASK_TO_CANCEL_ALL = "No running subagent tasks to cancel.";

/** 既有（未改动）唯一在途任务时的回执在途块文案。 */
const NO_OTHER_TASK_IN_FLIGHT = "No other tasks are in flight after this cancel request.";

/** 用户侧 /subagent-cancel 成功文案（短句，按契约逐字锁定）。 */
function expectedUserCancelNotify(taskId: string): string {
	return `Subagent task ${taskId} cancelled — killed mid-run, so its file changes may be incomplete; check what it touched.`;
}

/** 用户侧 /subagent-cancel-all 成功文案（短句，按契约逐字锁定）。 */
function expectedCancelAllNotify(count: number): string {
	return `Cancelled ${count} running subagent task(s) — killed mid-run, so their file changes may be incomplete; check what they touched.`;
}

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

/** 统计逐字串出现次数（契约要求"恰好一次"，防重复插入）。 */
function countOccurrences(haystack: string, needle: string): number {
	return haystack.split(needle).length - 1;
}

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
// buildResultEnvelope fixture（SingleResult 未导出，构造最小真实形状）
// ---------------------------------------------------------------------------

function createTask(overrides: Partial<AsyncSubagentTask> = {}): AsyncSubagentTask {
	return {
		taskId: "019ffdd3-3eb5-733d-b481-a53e5292e001",
		agentName: "tester",
		task: "验证取消信封的文件残留警告",
		startedAt: Date.now() - 1500,
		abortController: new AbortController(),
		status: "running",
		...overrides,
	};
}

function createResult(overrides: Record<string, unknown> = {}) {
	return {
		agent: "tester",
		agentSource: "project",
		task: "验证取消信封的文件残留警告",
		exitCode: 0,
		messages: [{ role: "assistant", content: [{ type: "text", text: "任务产物" }] }],
		stderr: "",
		usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 15, turns: 1 },
		phase: "idle",
		lastPhaseChange: 0,
		sessionId: "019ffdd3-3eb5-733d-b481-a53e5292e001",
		startedAt: Date.now() - 1500,
		finishedAt: Date.now(),
		...overrides,
	} as any;
}

describe("取消任务的文件系统残留警告 — 红阶段契约测试", () => {
	let tmpBase: string;
	let agentDir: string;
	let defaultCwd: string;
	let savedEnv: Record<string, string | undefined>;
	let allProcs: ReturnType<typeof createControllableProc>[];

	beforeEach(() => {
		vi.useFakeTimers();
		taskRegistry.clear();

		tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "subagent-cancel-fs-warning-test-"));
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
		// progress manager 是模块级单例：未清理会污染后续用例的最近活动时间戳
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
		const executeCancelTool = (
			callId: string,
			params: Record<string, unknown>,
			ctx: unknown,
		) => executeSubagentTool!(callId, { action: "cancel", ...params }, undefined, undefined, ctx);
		return { pi, executeSubagentTool, executeCancelTool, toolsByName };
	}

	/** 派发一个后台任务并返回其 proc（取消类用例的共享 arrange）。 */
	async function dispatchTask(
		executeSubagentTool: ExecuteFn,
		ctx: unknown,
		callId: string,
		sessionId: string,
		task = "整理季度报表并输出摘要",
	) {
		const executePromise = executeSubagentTool(
			callId,
			{ agent: "tester", task, sessionId },
			undefined,
			undefined,
			ctx,
		);
		await raceWithTimeout(executePromise, 200);
		expect(taskRegistry.get(sessionId)?.status, "前置：任务应处于运行中").toBe("running");
		return allProcs[allProcs.length - 1];
	}

	// ================================================================
	// 0. 唯一真源一致性：导出常量 vs 测试冻结字面量
	// ================================================================
	describe("0. 唯一真源一致性", () => {
		it("导出的 CANCELLED_TASK_EFFECTS_WARNING 应与测试冻结字面量逐字一致", () => {
			// Arrange / Act：导出的唯一真源常量即被测值
			const exportedWarning = CANCELLED_TASK_EFFECTS_WARNING;

			// Assert：任一侧措辞漂移（emoji、em dash、反引号、分号、句读）都会红
			expect(exportedWarning, "导出常量应与测试冻结字面量 EXPECTED_WARNING 逐字一致").toBe(
				EXPECTED_WARNING,
			);
		});

		it("cancelled 信封正文应引用同一常量（行为锚用常量断言，而非另抄一份字面量）", () => {
			// Arrange
			const task = createTask({ status: "cancelled", cancelledBy: "user" });

			// Act
			const envelope = buildResultEnvelope(task, null, "cancelled", "aborted");

			// Assert：正文必须由同一个常量拼出，实现另抄一份文案即红
			expect(envelope.content, "cancelled 信封正文应包含导出的唯一真源常量").toContain(
				CANCELLED_TASK_EFFECTS_WARNING,
			);
		});
	});

	// ================================================================
	// 1. 确认取消回执（action=cancel + confirm:true + 非空 reason）
	// ================================================================
	describe("1. 确认取消回执", () => {
		it("确认取消回执应包含文件残留警告且恰好一次（RED：当前回执无警告）", async () => {
			const { executeSubagentTool, executeCancelTool } = setupExtension();
			const ctx = createMockTuiCtx(defaultCwd);
			const taskId = "019ffdd3-3eb5-733d-b481-a53e5292e010";

			// Arrange
			await dispatchTask(executeSubagentTool!, ctx, "call-dispatch", taskId);

			// Act
			const result = await executeCancelTool("call-cancel", { taskId, confirm: true, reason: "任务目标已改变" }, ctx);

			// Assert：警告逐字出现且只出现一次；回执首行语义与警示 emoji 仍在
			const text = result.content.map((c: any) => c.text).join("");
			expect(countOccurrences(text, EXPECTED_WARNING), "确认取消回执中文件残留警告应恰好出现一次").toBe(1);
			expect(text, "回执应保留取消请求语义").toContain("Cancel request sent:");
			expect(text, "回执应保留警示 emoji").toContain("⚠️");
		});

		it("确认取消回执应给出半途终止语义与 git status / git diff 核查建议（RED）", async () => {
			const { executeSubagentTool, executeCancelTool } = setupExtension();
			const ctx = createMockTuiCtx(defaultCwd);
			const taskId = "019ffdd3-3eb5-733d-b481-a53e5292e011";

			// Arrange
			await dispatchTask(executeSubagentTool!, ctx, "call-dispatch", taskId);

			// Act
			const result = await executeCancelTool("call-cancel", { taskId, confirm: true, reason: "任务目标已改变" }, ctx);

			// Assert：语义级匹配（措辞由常量载体决定，这里锁语义）
			const text = result.content.map((c: any) => c.text).join("");
			expect(text, "应说明取消是半途杀进程").toMatch(/killed mid-run/);
			expect(text, "应说明已写入的内容留在磁盘上").toMatch(/stays on disk/);
			expect(text, "应建议用 git status 核查").toContain("git status");
			expect(text, "应建议用 git diff 核查").toContain("git diff");
		});

		it("确认取消回执中警告应为独立段落：首行之后、在途块之前、上下各一空行（RED）", async () => {
			const { executeSubagentTool, executeCancelTool } = setupExtension();
			const ctx = createMockTuiCtx(defaultCwd);
			const taskId = "019ffdd3-3eb5-733d-b481-a53e5292e012";

			// Arrange
			await dispatchTask(executeSubagentTool!, ctx, "call-dispatch", taskId);

			// Act
			const result = await executeCancelTool("call-cancel", { taskId, confirm: true, reason: "任务目标已改变" }, ctx);

			// Assert：按行定位，防跨行假绿
			const lines: string[] = result.content.map((c: any) => c.text).join("").split("\n");
			const requestIdx = lines.findIndex((l) => l.startsWith("Cancel request sent:"));
			const warningIdx = lines.findIndex((l) => l === EXPECTED_WARNING);
			const inFlightIdx = lines.findIndex((l) => l === NO_OTHER_TASK_IN_FLIGHT);

			expect(requestIdx, "回执应含 `Cancel request sent:` 首行").toBeGreaterThan(-1);
			expect(warningIdx, "回执应含逐字一致的警告行").toBeGreaterThan(-1);
			expect(inFlightIdx, "回执应含「已无其他在途任务」块").toBeGreaterThan(-1);
			expect(warningIdx, "警告行应在取消请求首行之后").toBeGreaterThan(requestIdx);
			expect(warningIdx, "警告行应在在途块之前").toBeLessThan(inFlightIdx);
			expect(lines[warningIdx - 1], "警告行上方应为空行").toBe("");
			expect(lines[warningIdx + 1], "警告行下方应为空行").toBe("");
		});

		it("确认取消唯一任务后回执仍应保留「已无其他在途任务」块（回归，预期绿）", async () => {
			const { executeSubagentTool, executeCancelTool } = setupExtension();
			const ctx = createMockTuiCtx(defaultCwd);
			const taskId = "019ffdd3-3eb5-733d-b481-a53e5292e013";

			// Arrange
			await dispatchTask(executeSubagentTool!, ctx, "call-dispatch", taskId);

			// Act
			const result = await executeCancelTool("call-cancel", { taskId, confirm: true, reason: "任务目标已改变" }, ctx);

			// Assert：在途块语义未被警告插入破坏
			const text = result.content.map((c: any) => c.text).join("");
			expect(text).toContain(NO_OTHER_TASK_IN_FLIGHT);
			expect(text, "回执不得借用信封的「本任务结束」锚定语").not.toMatch(/when this task ended/);
		});

		it("两派一消时回执应仍列出另一任务的 taskId 与 agent 名（回归，预期绿）", async () => {
			const { executeSubagentTool, executeCancelTool } = setupExtension();
			const ctx = createMockTuiCtx(defaultCwd);
			const cancelledId = "019ffdd3-3eb5-733d-b481-a53e5292e014";
			const survivorId = "019ffdd3-3eb5-733d-b481-a53e5292e015";

			// Arrange
			await dispatchTask(executeSubagentTool!, ctx, "call-dispatch-1", cancelledId, "任务1");
			await dispatchTask(executeSubagentTool!, ctx, "call-dispatch-2", survivorId, "任务2");

			// Act
			const result = await executeCancelTool(
				"call-cancel",
				{ taskId: cancelledId, confirm: true, reason: "任务目标已改变" },
				ctx,
			);

			// Assert：在途块仍包含另一任务（taskId + agent 名），且任务行里不出现被取消任务
			//（首行 `Cancel request sent: <taskId>` 本身含被取消 taskId，故只比对任务行）
			const text = result.content.map((c: any) => c.text).join("");
			expect(text).toContain(survivorId);
			expect(text).toMatch(/tester/);
			const taskLines = text.split("\n").filter((l: string) => /^- .* \(.*\):/.test(l));
			expect(taskLines.length, "在途块应只列出另一任务这一行").toBe(1);
			for (const line of taskLines) {
				expect(line, "在途任务行不得包含被取消任务").not.toContain(cancelledId);
			}
		});

		it("确认取消回执 details 应为 { taskId, cancelled: true } 形状且无 confirmRequired（回归，预期绿）", async () => {
			const { executeSubagentTool, executeCancelTool } = setupExtension();
			const ctx = createMockTuiCtx(defaultCwd);
			const taskId = "019ffdd3-3eb5-733d-b481-a53e5292e016";

			// Arrange
			await dispatchTask(executeSubagentTool!, ctx, "call-dispatch", taskId);

			// Act
			const result = await executeCancelTool("call-cancel", { taskId, confirm: true, reason: "任务目标已改变" }, ctx);

			// Assert：加入警告不得改变 details 契约
			expect(result.isError).toBeFalsy();
			expect(result.details).toMatchObject({ taskId, cancelled: true });
			expect(result.details?.confirmRequired, "确认回执不得携带质询标记").toBeFalsy();
			// Assert：键集合逐字锁定，防警告相关字段（如 warning / filesystemWarning）混进 details
			expect(Object.keys(result.details).sort(), "确认回执 details 应恰为 cancelled / taskId 两个键").toEqual([
				"cancelled",
				"taskId",
			]);
		});
	});

	// ================================================================
	// 2. [subagent-result] 信封：agent 取消（confirm:true）
	// ================================================================
	describe("2. [subagent-result] 信封（agent 取消）", () => {
		it("agent 取消信封应含文件残留警告且恰好一次（RED：当前信封无警告）", async () => {
			const { executeSubagentTool, executeCancelTool, pi } = setupExtension();
			const ctx = createMockTuiCtx(defaultCwd);
			const taskId = "019ffdd3-3eb5-733d-b481-a53e5292e020";

			// Arrange
			const proc = await dispatchTask(executeSubagentTool!, ctx, "call-dispatch", taskId);
			await executeCancelTool("call-cancel", { taskId, confirm: true, reason: "任务目标已改变" }, ctx);

			// Act：子进程按 SIGTERM 收尾 → 信封发出
			endProcess(proc, null, "SIGTERM");
			await vi.advanceTimersByTimeAsync(1000);

			// Assert
			expect(pi.sendMessage, "取消收尾后应发出一封 [subagent-result] 信封").toHaveBeenCalled();
			const envelope: string = pi._sendMessageCalls[0][0].content;
			expect(countOccurrences(envelope, EXPECTED_WARNING), "agent 取消信封中文件残留警告应恰好出现一次").toBe(1);
		});

		it("agent 取消信封的警告应位于正文分隔符之后，且正文保留主 agent 来源说明（RED）", async () => {
			const { executeSubagentTool, executeCancelTool, pi } = setupExtension();
			const ctx = createMockTuiCtx(defaultCwd);
			const taskId = "019ffdd3-3eb5-733d-b481-a53e5292e021";

			// Arrange
			const proc = await dispatchTask(executeSubagentTool!, ctx, "call-dispatch", taskId);
			await executeCancelTool("call-cancel", { taskId, confirm: true, reason: "任务目标已改变" }, ctx);

			// Act
			endProcess(proc, null, "SIGTERM");
			await vi.advanceTimersByTimeAsync(1000);

			// Assert：警告属正文段（在最后一个 `\n---\n` 之后），来源说明不受影响
			const envelope: string = pi._sendMessageCalls[0][0].content;
			const warningIdx = envelope.indexOf(EXPECTED_WARNING);
			expect(warningIdx, "agent 取消信封应含逐字一致的警告").toBeGreaterThan(-1);
			expect(warningIdx, "警告应位于最后一个正文分隔符之后").toBeGreaterThan(envelope.lastIndexOf("\n---\n"));
			expect(envelope, "信封正文应保留「主 agent 发起取消」的来源说明").toMatch(/main\s*agent/);
		});

		it("agent 取消信封的 details 不得携带该警告（RED：警告只属于正文）", async () => {
			const { executeSubagentTool, executeCancelTool, pi } = setupExtension();
			const ctx = createMockTuiCtx(defaultCwd);
			const taskId = "019ffdd3-3eb5-733d-b481-a53e5292e022";

			// Arrange
			const proc = await dispatchTask(executeSubagentTool!, ctx, "call-dispatch", taskId);
			await executeCancelTool("call-cancel", { taskId, confirm: true, reason: "任务目标已改变" }, ctx);

			// Act
			endProcess(proc, null, "SIGTERM");
			await vi.advanceTimersByTimeAsync(1000);

			// Assert：cancelledBy 保持 agent；output / details 均不得夹带警告
			const message = pi._sendMessageCalls[0][0];
			expect(message.details.cancelledBy).toBe("agent");
			expect(message.details.output ?? "", "details.output 不得包含警告").not.toContain(EXPECTED_WARNING);
			expect(JSON.stringify(message.details), "details 整体不得包含警告").not.toContain(EXPECTED_WARNING);
		});
	});

	// ================================================================
	// 3. [subagent-result] 信封 + notify：用户 /subagent-cancel
	// ================================================================
	describe("3. [subagent-result] 信封（用户 /subagent-cancel）", () => {
		it("用户取消信封应含文件残留警告且恰好一次，来源仍为 user（RED）", async () => {
			const { executeSubagentTool, pi } = setupExtension();
			const ctx = createMockTuiCtx(defaultCwd);
			const taskId = "019ffdd3-3eb5-733d-b481-a53e5292e030";

			// Arrange
			const proc = await dispatchTask(executeSubagentTool!, ctx, "call-dispatch", taskId);
			const cancelCommand = pi._commandDefs.get("subagent-cancel");
			expect(cancelCommand, "/subagent-cancel 命令应已注册").toBeDefined();

			// Act
			await cancelCommand.handler(taskId, { ui: { notify: vi.fn() } });
			endProcess(proc, null, "SIGTERM");
			await vi.advanceTimersByTimeAsync(1000);

			// Assert
			const message = pi._sendMessageCalls[0][0];
			const envelope: string = message.content;
			expect(countOccurrences(envelope, EXPECTED_WARNING), "用户取消信封中文件残留警告应恰好出现一次").toBe(1);
			expect(envelope, "信封正文应保留 /subagent-cancel 来源说明").toContain("/subagent-cancel");
			expect(message.details.cancelledBy, "cancelledBy 契约不变").toBe("user");
		});

		it("/subagent-cancel 成功文案应改为文件残留短句（逐字锁定，RED）", async () => {
			const { executeSubagentTool, pi } = setupExtension();
			const ctx = createMockTuiCtx(defaultCwd);
			const taskId = "019ffdd3-3eb5-733d-b481-a53e5292e031";

			// Arrange
			await dispatchTask(executeSubagentTool!, ctx, "call-dispatch", taskId);
			const cancelCommand = pi._commandDefs.get("subagent-cancel");
			const notifyMock = vi.fn();

			// Act
			await cancelCommand.handler(taskId, { ui: { notify: notifyMock } });

			// Assert：用户可见短句（不复用长常量），severity 保持 info
			expect(notifyMock).toHaveBeenCalledWith(expectedUserCancelNotify(taskId), "info");
		});
	});

	// ================================================================
	// 4. [subagent-result] 信封 + notify：/subagent-cancel-all 批量
	// ================================================================
	describe("4. /subagent-cancel-all 批量取消", () => {
		it("批量取消后每个被取消任务的信封都应含文件残留警告且各一次（RED）", async () => {
			const { executeSubagentTool, pi } = setupExtension();
			const ctx = createMockTuiCtx(defaultCwd);
			const firstId = "019ffdd3-3eb5-733d-b481-a53e5292e040";
			const secondId = "019ffdd3-3eb5-733d-b481-a53e5292e041";

			// Arrange
			await dispatchTask(executeSubagentTool!, ctx, "call-dispatch-1", firstId, "任务1");
			await dispatchTask(executeSubagentTool!, ctx, "call-dispatch-2", secondId, "任务2");
			const cancelAllCommand = pi._commandDefs.get("subagent-cancel-all");
			expect(cancelAllCommand, "/subagent-cancel-all 命令应已注册").toBeDefined();

			// Act
			await cancelAllCommand.handler("", { ui: { notify: vi.fn() } });
			for (const proc of allProcs) {
				endProcess(proc, null, "SIGTERM");
			}
			await vi.advanceTimersByTimeAsync(1000);

			// Assert：每个被取消任务各一封信封，各自恰好一次警告
			expect(pi._sendMessageCalls.length, "两个被取消任务应各发一封信封").toBe(2);
			const envelopes = pi._sendMessageCalls.map((call: any[]) => call[0].content as string);
			for (const envelope of envelopes) {
				expect(countOccurrences(envelope, EXPECTED_WARNING), "每个批量取消信封都应恰好含一次警告").toBe(1);
			}
		});

		it("/subagent-cancel-all 成功文案应改为文件残留短句并保留计数（逐字锁定，RED）", async () => {
			const { executeSubagentTool, pi } = setupExtension();
			const ctx = createMockTuiCtx(defaultCwd);
			const firstId = "019ffdd3-3eb5-733d-b481-a53e5292e042";
			const secondId = "019ffdd3-3eb5-733d-b481-a53e5292e043";

			// Arrange
			await dispatchTask(executeSubagentTool!, ctx, "call-dispatch-1", firstId, "任务1");
			await dispatchTask(executeSubagentTool!, ctx, "call-dispatch-2", secondId, "任务2");
			const cancelAllCommand = pi._commandDefs.get("subagent-cancel-all");
			const notifyMock = vi.fn();

			// Act
			await cancelAllCommand.handler("", { ui: { notify: notifyMock } });

			// Assert：数量 + 文件残留短句，severity 保持 info
			expect(notifyMock).toHaveBeenCalledWith(expectedCancelAllNotify(2), "info");
		});

		it("注册表为空时批量取消文案应保持不变（回归，预期绿）", async () => {
			const { pi } = setupExtension();
			const cancelAllCommand = pi._commandDefs.get("subagent-cancel-all");
			expect(cancelAllCommand, "/subagent-cancel-all 命令应已注册").toBeDefined();
			expect(taskRegistry.size, "前置：注册表应为空").toBe(0);
			const notifyMock = vi.fn();

			// Act
			await cancelAllCommand.handler("", { ui: { notify: notifyMock } });

			// Assert：零任务分支文案与 severity 均不动
			expect(notifyMock).toHaveBeenCalledWith(NO_TASK_TO_CANCEL_ALL, "info");
		});
	});

	// ================================================================
	// 5. 负向锁定：非取消终态信封不得出现该警告
	// ================================================================
	describe("5. 负向锁定：非取消终态信封不出现警告", () => {
		it("succeeded 信封不应出现文件残留警告（回归，预期绿）", () => {
			// Arrange
			const task = createTask();
			const result = createResult();

			// Act
			const envelope = buildResultEnvelope(task, result, "success");

			// Assert
			expect(envelope.content).not.toContain(EXPECTED_WARNING);
			expect(envelope.content, "成功信封不应出现工作区核查建议").not.toContain("git status");
		});

		it("failed 信封不应出现文件残留警告（回归，预期绿）", () => {
			// Arrange
			const task = createTask();
			const result = createResult({ exitCode: 1, stopReason: "error", errorMessage: "boom", messages: [] });

			// Act
			const envelope = buildResultEnvelope(task, result, "failure");

			// Assert
			expect(envelope.content).not.toContain(EXPECTED_WARNING);
			expect(envelope.content, "失败信封不应出现工作区核查建议").not.toContain("git status");
		});

		it("timed out 信封不应出现文件残留警告（回归，预期绿）", () => {
			// Arrange
			const task = createTask();
			const result = createResult({ stopReason: "hard_timeout", messages: [] });

			// Act
			const envelope = buildResultEnvelope(task, result, "timeout");

			// Assert
			expect(envelope.content).not.toContain(EXPECTED_WARNING);
			expect(envelope.content, "超时信封不应出现工作区核查建议").not.toContain("git status");
		});

		it("cancelled 信封应含警告恰好一次且以警告结尾（RED：当前无警告）", () => {
			// Arrange
			const task = createTask({ status: "cancelled", cancelledBy: "user" });

			// Act
			const envelope = buildResultEnvelope(task, null, "cancelled", "aborted");

			// Assert
			expect(countOccurrences(envelope.content, EXPECTED_WARNING), "已取消信封应恰好含一次警告").toBe(1);
			expect(
				envelope.content.endsWith(EXPECTED_WARNING),
				"警告应作为信封正文的最后一个段落（末尾无其他内容）",
			).toBe(true);
		});
	});

	// ================================================================
	// 6. 质询回执（首次 cancel，无 confirm / confirm !== true）
	// ================================================================
	describe("6. 质询回执（首次 cancel）", () => {
		it("质询回执应含文件残留警告且恰好一次（RED：当前质询无警告）", async () => {
			const { executeSubagentTool, executeCancelTool } = setupExtension();
			const ctx = createMockTuiCtx(defaultCwd);
			const taskId = "019ffdd3-3eb5-733d-b481-a53e5292e050";

			// Arrange
			await dispatchTask(executeSubagentTool!, ctx, "call-dispatch", taskId);

			// Act
			const result = await executeCancelTool("call-cancel", { taskId }, ctx);

			// Assert
			const text = result.content.map((c: any) => c.text).join("");
			expect(countOccurrences(text, EXPECTED_WARNING), "质询回执中文件残留警告应恰好出现一次").toBe(1);
		});

		it("质询回执应保留 agent 名、任务摘要、已运行时长与「尚无进度上报」信息（回归，预期绿）", async () => {
			const { executeSubagentTool, executeCancelTool } = setupExtension();
			const ctx = createMockTuiCtx(defaultCwd);
			const taskId = "019ffdd3-3eb5-733d-b481-a53e5292e051";

			// Arrange：派发后不上报任何进度，推进 3 秒
			await dispatchTask(executeSubagentTool!, ctx, "call-dispatch", taskId, "整理季度报表并输出摘要");
			await vi.advanceTimersByTimeAsync(3000);

			// Act
			const result = await executeCancelTool("call-cancel", { taskId }, ctx);

			// Assert
			const text = result.content.map((c: any) => c.text).join("");
			expect(text).toContain("tester");
			expect(text).toMatch(/整理季度报表/);
			expect(text).toMatch(/Elapsed|elapsed/);
			expect(text, "从未上报进度时应明示尚无进度").toMatch(/none reported yet/);
			expect(text, "应保留既有「丢弃在途进度且不可撤销」警告").toContain(EXISTING_CHALLENGE_WARNING);
			expect(text, "应保留 reason 必填的二次调用指令").toMatch(/confirm/i);
			expect(text).toMatch(/reason/i);
		});

		it("质询回执的警告应紧接既有不可撤销警告之后、二次调用指令之前，且各自空行分隔（RED）", async () => {
			const { executeSubagentTool, executeCancelTool } = setupExtension();
			const ctx = createMockTuiCtx(defaultCwd);
			const taskId = "019ffdd3-3eb5-733d-b481-a53e5292e052";

			// Arrange
			await dispatchTask(executeSubagentTool!, ctx, "call-dispatch", taskId);

			// Act
			const result = await executeCancelTool("call-cancel", { taskId }, ctx);

			// Assert：按行定位三段，防跨行假绿
			const lines: string[] = result.content.map((c: any) => c.text).join("").split("\n");
			const discardIdx = lines.findIndex((l) => l === EXISTING_CHALLENGE_WARNING);
			const warningIdx = lines.findIndex((l) => l === EXPECTED_WARNING);
			const instructionIdx = lines.findIndex((l) => /^To confirm the cancel/.test(l));

			expect(discardIdx, "质询应含既有的不可撤销警告行").toBeGreaterThan(-1);
			expect(warningIdx, "质询应含逐字一致的文件残留警告行").toBeGreaterThan(-1);
			expect(instructionIdx, "质询应含既有的二次调用指令行").toBeGreaterThan(-1);
			expect(warningIdx, "文件残留警告应排在不可撤销警告之后").toBeGreaterThan(discardIdx);
			expect(warningIdx, "文件残留警告应排在二次调用指令之前").toBeLessThan(instructionIdx);
			expect(lines[discardIdx + 1], "不可撤销警告与文件残留警告之间应为空行").toBe("");
			expect(lines[warningIdx - 1], "文件残留警告上方应为空行").toBe("");
			expect(lines[warningIdx + 1], "文件残留警告下方应为空行").toBe("");
			expect(lines[instructionIdx - 1], "二次调用指令上方应为空行").toBe("");
		});

		it("质询回执 details 应保持 confirmRequired 质询形状（回归，预期绿）", async () => {
			const { executeSubagentTool, executeCancelTool } = setupExtension();
			const ctx = createMockTuiCtx(defaultCwd);
			const taskId = "019ffdd3-3eb5-733d-b481-a53e5292e053";

			// Arrange
			await dispatchTask(executeSubagentTool!, ctx, "call-dispatch", taskId);

			// Act
			const result = await executeCancelTool("call-cancel", { taskId }, ctx);

			// Assert
			expect(result.isError, "质询回执不应是错误").toBeFalsy();
			expect(result.details).toMatchObject({ taskId, cancelled: false, confirmRequired: true });
		});
	});

	// ================================================================
	// 7. 零副作用回归：质询不得改动任何运行时状态
	// ================================================================
	describe("7. 质询零副作用回归", () => {
		it("首次质询应零副作用：任务继续运行、abort 未触发、proc.kill 未调用、无通知发出（回归，预期绿）", async () => {
			const { executeSubagentTool, executeCancelTool, pi } = setupExtension();
			const ctx = createMockTuiCtx(defaultCwd);
			const taskId = "019ffdd3-3eb5-733d-b481-a53e5292e060";

			// Arrange
			const proc = await dispatchTask(executeSubagentTool!, ctx, "call-dispatch", taskId);

			// Act
			await executeCancelTool("call-cancel", { taskId }, ctx);

			// Assert
			const record = taskRegistry.get(taskId);
			expect(record?.status, "质询不得改变任务状态").toBe("running");
			expect(record?.abortController.signal.aborted, "质询不得触发 abortController").toBe(false);
			expect(proc.kill, "质询不得 kill 子进程").not.toHaveBeenCalled();
			expect(pi.sendMessage, "质询不得发出 [subagent-result] 通知").not.toHaveBeenCalled();
		});
	});

	// ================================================================
	// 8. cancelled 信封：三种来源与正文/警告段落边界（单元）
	// ================================================================
	describe("8. cancelled 信封：三种来源与正文段落边界", () => {
		it("session_shutdown 来源的 cancelled 信封应含警告恰好一次并保留关闭来源说明（回归，预期绿：补齐第三种来源，此前无覆盖）", () => {
			// Arrange：会话关闭导致无 result，正文回落到 killed_on_shutdown 来源说明
			const task = createTask({ status: "killed_on_shutdown" });

			// Act
			const envelope = buildResultEnvelope(task, null, "cancelled", "killed_on_shutdown");

			// Assert：三种来源都必须追加警告，只给 user/agent 追加的分支式实现会漏掉本来源
			expect(
				countOccurrences(envelope.content, EXPECTED_WARNING),
				"session_shutdown 来源的 cancelled 信封应恰好含一次警告",
			).toBe(1);
			// Assert：来源说明应逐字保留且排在警告之前，不得被警告挤压
			const lines: string[] = envelope.content.split("\n");
			const warningIdx = lines.findIndex((l) => l === EXPECTED_WARNING);
			const shutdownIdx = lines.findIndex((l) => l.includes("session_shutdown"));
			expect(
				envelope.content,
				"正文应保留 session_shutdown 来源说明",
			).toContain("The task was terminated because the session shut down (session_shutdown).");
			expect(warningIdx, "信封应含逐字一致的警告行").toBeGreaterThan(-1);
			expect(shutdownIdx, "信封正文应含 session_shutdown 来源说明行").toBeGreaterThan(-1);
			expect(warningIdx, "警告应排在 session_shutdown 来源说明之后").toBeGreaterThan(shutdownIdx);
		});

		it("cancelled 信封的正文与警告之间应恰好一个空行（回归，预期绿：防多空行/少空行漂移）", () => {
			// Arrange
			const task = createTask({ status: "cancelled", cancelledBy: "user" });

			// Act
			const envelope = buildResultEnvelope(task, null, "cancelled", "aborted");

			// Assert：按行定位，挡 ["", "", WARNING]（多空行）与 [WARNING]（少空行）两种漂移
			const lines: string[] = envelope.content.split("\n");
			const warningIdx = lines.findIndex((l) => l === EXPECTED_WARNING);
			expect(warningIdx, "信封应含逐字一致的警告行").toBeGreaterThan(-1);
			expect(lines[warningIdx - 1], "正文与警告之间应恰为一个空行").toBe("");
			expect(lines[warningIdx - 2], "警告上方第二行应为正文，不得再多一个空行").not.toBe("");
		});

		it("cancelled 信封在正文非空（子 agent 真实产出）时仍应追加警告恰好一次并以其结尾（回归，预期绿）", () => {
			// Arrange：completeAsyncTask 在 result 存在且 task.status !== running 时同样判 cancelled
			const task = createTask({ status: "cancelled", cancelledBy: "user" });
			const result = createResult();

			// Act
			const envelope = buildResultEnvelope(task, result, "cancelled", "aborted");

			// Assert：正文为子 agent 真实产出；把追加逻辑挪进 abortedFallbackBody 会在此路径静默丢警告
			expect(envelope.content, "正文应保留子 agent 的真实产出").toContain("任务产物");
			expect(
				countOccurrences(envelope.content, EXPECTED_WARNING),
				"正文非空的 cancelled 信封也应恰好含一次警告",
			).toBe(1);
			expect(
				envelope.content.endsWith(EXPECTED_WARNING),
				"警告应仍作为正文的最后一个段落",
			).toBe(true);
		});
	});

});
