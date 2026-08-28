/**
 * [subagent-result] 通知投递模式与在途块措辞 —— 红阶段契约测试
 *
 * 背景（已确诊事实链）：
 * 1. completeAsyncTask 曾用 pi.sendMessage(..., { deliverAs: "followUp", triggerTurn: true })
 *    发通知（红阶段注记：修复前为 followUp，现已修复为 steer）。pi 文档语义：
 *    followUp = 等整个 agent run 结束才送达；
 *    steer（pi 默认）= 当前 assistant turn 的工具调用执行完后、下一次 LLM 调用前送达。
 *    因此通知被憋到主 agent 整个回合结束才送达。
 * 2. 信封"在途任务"块（formatActiveTasks()）是信封构建时刻的 registry 快照；
 *    构建与送达之间主 agent 可能已派发新任务——快照过期。旧措辞"当前无在途任务"
 *    是绝对化陈述，与事实冲突时构成误导。
 * 3. 工具 promptGuidelines 缺少"快照滞后时以本回合派发记录为准"的裁决规则。
 *
 * 已批准修复方案（全部约束在插件内，本文件钉住其契约）：
 * - S1 投递模式：deliverAs 从 "followUp" 改为 "steer"（triggerTurn: true 保留）。
 * - S2 事件锚定措辞：在途块从绝对陈述改为锚定"本信封所属任务的结束事件"的限定陈述，
 *   不引入墙上时钟时间。空：如"本任务结束时无其他在途任务"；非空：如"本任务结束时，
 *   其他在途任务: ..."。具体中文措辞由实现定，本文件锁语义不锁字面。
 * - S3 裁决优先级：promptGuidelines 新增条目，同时含"在途块是构建时刻快照、可能滞后"
 *   语义与"与本回合亲手发出的派发记录冲突时，以派发记录为准"语义。
 *
 * 断言原则（上一轮红阶段教训）：宽松断言一律按行/按条目匹配，防止跨行假绿。
 * 时钟时间负向断言只作用于在途块本身（信封"- 耗时:"行合法的 H:MM:SS 不在其列）。
 */

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn } from "node:child_process";
import extension, { taskRegistry, formatActiveTasks } from "../src/index.ts";
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

// ---------------------------------------------------------------------------
// S2 断言助手（锁语义不锁字面；按行匹配防跨行假绿）
// ---------------------------------------------------------------------------

/**
 * 时钟时间模式（H:MM:SS 或 MM:SS）。在途块刻意不含任何时间信息
 * （回答"还有什么在跑"，而非"跑了多久"/"几点了"），故两种形态都禁止。
 */
const CLOCK_TIME = /\d{1,2}:\d{2}(:\d{2})?/;

/** 旧绝对句式（S2 要求移除）。 */
const ABSOLUTE_EMPTY_WORDING = /No tasks? (are|were) (currently )?in flight/i;

/**
 * 绝对化"此刻"语义（防绝对句式换皮回潮）：同行出现"当前/目前/now"类
 * 时间副词 + 在途语义即违规。按行判定，不误伤跨行合法内容。
 */
const ABSOLUTE_NOW_SEMANTICS = /now|currently/i;

/**
 * 从信封正文提取在途块："- 会话:" 元信息行与 "---" 分隔线之间即
 * formatActiveTasks() 的输出（buildResultEnvelope 固定结构）。
 */
function extractInFlightBlock(content: string): string {
	const m = content.match(/- Session:[^\n]*\n+([\s\S]*?)\n+---/);
	return m ? m[1] : "";
}

/**
 * 在途块内是否存在"事件锚定"行：同一行同时含
 *   (a) 对本信封所属任务的指代（本任务/该任务/此任务/本信封）
 *   (b) 结束事件词（结束/完成）
 *   (c) 在途语义（在途）
 * empty=true  时还要求同行含否定词（无/没有/再无）——空在途的锚定陈述；
 * empty=false 时要求锚定行不含否定词——非空时不得谎称"无在途"。
 */
function hasEventAnchoredLine(block: string, empty: boolean): boolean {
	return block.split("\n").some((line) => {
		const anchored = /this task/.test(line) && /ended|finished|completed/.test(line) && /in[- ]flight/.test(line);
		if (!anchored) return false;
		const negated = /no |none/i.test(line);
		return empty ? negated : !negated;
	});
}

/** 在途块不得含绝对化"此刻"语义行（当前/目前/now + 在途）。 */
function hasAbsoluteNowLine(block: string): boolean {
	return block.split("\n").some((line) => ABSOLUTE_NOW_SEMANTICS.test(line) && /in[- ]flight/.test(line));
}

describe("[subagent-result] 通知投递模式与在途块措辞（S1/S2/S3 红阶段）", () => {
	let tmpBase: string;
	let agentDir: string;
	let defaultCwd: string;
	let savedEnv: Record<string, string | undefined>;
	let allProcs: ReturnType<typeof createControllableProc>[];

	beforeEach(() => {
		vi.useFakeTimers();
		taskRegistry.clear();

		tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "subagent-result-delivery-test-"));
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

	/** 派发一个任务并等待 execute() 立即返回（异步 TUI 模式契约）。 */
	async function dispatchTask(executeSubagentTool: ExecuteFn, callId: string, task: string, sessionId: string) {
		const ctx = createMockTuiCtx(defaultCwd);
		const executePromise = executeSubagentTool(callId, { agent: "tester", task, sessionId }, undefined, undefined, ctx);
		await raceWithTimeout(executePromise, 200);
		return executePromise;
	}

	// ================================================================
	// S1 投递模式：deliverAs "followUp" → "steer"（triggerTurn: true 保留）
	// ================================================================
	describe("S1 投递模式（steer + triggerTurn）", () => {
		it("should deliver completion notification with deliverAs 'steer' and triggerTurn true（红阶段注记：修复前为 followUp）", async () => {
			// Arrange
			const { executeSubagentTool, pi } = setupExtension();
			await dispatchTask(executeSubagentTool!, "call-1", "test task", "019ffdd3-3eb5-733d-b481-a53e5292c001");

			// Act: 子进程成功退出 → completeAsyncTask → pi.sendMessage
			// 注入含 text 的 message_end，使本用例继续覆盖「成功路径」
			//（N2 后 exit 0 但无终态文本会判 failed）。
			allProcs[0].stdout.emit(
				"data",
				Buffer.from(
					JSON.stringify({
						type: "message_end",
						message: {
							role: "assistant",
							content: [{ type: "text", text: "子 agent 成功结果" }],
							stopReason: "end_turn",
							usage: { input: 10, output: 5, totalTokens: 15 },
						},
					}) + "\n",
				),
			);
			await vi.advanceTimersByTimeAsync(0);
			endProcess(allProcs[0], 0);
			await vi.advanceTimersByTimeAsync(1000);

			// Assert
			expect(pi.sendMessage).toHaveBeenCalled();
			const [message, options] = pi._sendMessageCalls[0];
			expect(message.customType).toBe("subagent-result");
			// S1 契约：steer 在当前 assistant turn 的工具调用执行完后、下一次 LLM 调用
			// 前送达；followUp 会憋到整个 agent run 结束（即本次修复的滞后根因）。
			// 红阶段注记：修复前实现为 "followUp"（本断言现为 GREEN 锁定，防回潮）。
			expect(options.deliverAs).toBe("steer");
			expect(options.triggerTurn).toBe(true);
		});
	});

	// ================================================================
	// S2 事件锚定措辞 —— formatActiveTasks() 直接单元契约
	// ================================================================
	describe("S2 事件锚定措辞 —— formatActiveTasks() 单元契约", () => {
		it("should use event-anchored wording (not absolute) when registry is empty（RED）", () => {
			// Arrange
			expect(taskRegistry.size).toBe(0);

			// Act
			const out = formatActiveTasks();

			// Assert：锚在"本信封所属任务的结束事件"上，主 agent 可用事件先后推断快照
			// 是否过期；不得出现绝对句式，不得出现墙上时钟时间。
			expect(hasEventAnchoredLine(out, true), "空在途应有锚定本任务结束事件的限定陈述（如「本任务结束时无其他在途任务」）").toBe(true);
			expect(out).not.toMatch(ABSOLUTE_EMPTY_WORDING);
			expect(hasAbsoluteNowLine(out), "不得出现「当前/目前 + 在途」的绝对化此刻陈述").toBe(false);
			expect(out).not.toMatch(CLOCK_TIME);
		});

		it("should keep anchor semantics and full task list when tasks remain（RED）", () => {
			// Arrange: 两个 running 任务（formatActiveTasks 只依赖这四个字段）
			taskRegistry.set("019ffdd3-3eb5-733d-b481-a53e5292c010", {
				taskId: "019ffdd3-3eb5-733d-b481-a53e5292c010",
				agentName: "tester",
				task: "调研 XX 方案",
				status: "running",
			} as any);
			taskRegistry.set("019ffdd3-3eb5-733d-b481-a53e5292c011", {
				taskId: "019ffdd3-3eb5-733d-b481-a53e5292c011",
				agentName: "reviewer",
				task: "重构认证中间件",
				status: "running",
			} as any);

			// Act
			const out = formatActiveTasks();

			// Assert：锚定语义 + 任务列表仍完整（taskId/agent 名/任务摘要不丢失）
			expect(hasEventAnchoredLine(out, false), "非空在途应有锚定本任务结束事件的限定陈述（如「本任务结束时，其他在途任务: …」）").toBe(true);
			expect(out).not.toMatch(ABSOLUTE_EMPTY_WORDING);
			expect(hasAbsoluteNowLine(out)).toBe(false);
			expect(out).not.toMatch(CLOCK_TIME);
			expect(out).toContain("019ffdd3-3eb5-733d-b481-a53e5292c010");
			expect(out).toContain("019ffdd3-3eb5-733d-b481-a53e5292c011");
			expect(out).toContain("tester");
			expect(out).toContain("reviewer");
			expect(out).toMatch(/调研 XX 方案/);
			expect(out).toMatch(/重构认证中间件/);
		});
	});

	// ================================================================
	// S2 事件锚定措辞 —— 信封集成契约（经 buildResultEnvelope 的在途块）
	// ================================================================
	describe("S2 事件锚定措辞 —— 信封在途块集成契约", () => {
		it("should anchor the empty in-flight block to this task's end event in the envelope（RED）", async () => {
			// Arrange: 只派一个任务，完成后在途为空
			const { executeSubagentTool, pi } = setupExtension();
			await dispatchTask(executeSubagentTool!, "call-1", "测试任务", "019ffdd3-3eb5-733d-b481-a53e5292c002");

			// Act
			// 注入含 text 的 message_end，使本用例继续覆盖「成功路径」
			allProcs[0].stdout.emit(
				"data",
				Buffer.from(
					JSON.stringify({
						type: "message_end",
						message: {
							role: "assistant",
							content: [{ type: "text", text: "任务完成" }],
							stopReason: "end_turn",
							usage: { input: 10, output: 5, totalTokens: 15 },
						},
					}) + "\n",
				),
			);
			await vi.advanceTimersByTimeAsync(0);
			endProcess(allProcs[0], 0);
			await vi.advanceTimersByTimeAsync(1000);

			// Assert：信封在途块（- 会话: 与 --- 之间）为事件锚定限定陈述
			expect(pi.sendMessage).toHaveBeenCalled();
			const content: string = pi._sendMessageCalls[0][0].content;
			const block = extractInFlightBlock(content);
			expect(block, "信封应包含在途块（- 会话: 行与 --- 分隔线之间）").not.toBe("");
			expect(hasEventAnchoredLine(block, true), "空在途块应有锚定本任务结束事件的限定陈述").toBe(true);
			expect(block).not.toMatch(ABSOLUTE_EMPTY_WORDING);
			expect(hasAbsoluteNowLine(block)).toBe(false);
			expect(block).not.toMatch(CLOCK_TIME);
		});

		it("should anchor the non-empty in-flight block and keep other tasks complete in the envelope（RED）", async () => {
			// Arrange: 派两个任务，完成第一个，第二个仍在途
			const { executeSubagentTool, pi } = setupExtension();
			await dispatchTask(executeSubagentTool!, "call-1", "任务1", "019ffdd3-3eb5-733d-b481-a53e5292c003");
			await dispatchTask(executeSubagentTool!, "call-2", "任务2", "019ffdd3-3eb5-733d-b481-a53e5292c004");
			expect(taskRegistry.size).toBe(2);

			// Act: 完成第一个任务
			// 注入含 text 的 message_end，使本用例继续覆盖「成功路径」
			allProcs[0].stdout.emit(
				"data",
				Buffer.from(
					JSON.stringify({
						type: "message_end",
						message: {
							role: "assistant",
							content: [{ type: "text", text: "任务1完成" }],
							stopReason: "end_turn",
							usage: { input: 10, output: 5, totalTokens: 15 },
						},
					}) + "\n",
				),
			);
			await vi.advanceTimersByTimeAsync(0);
			endProcess(allProcs[0], 0);
			await vi.advanceTimersByTimeAsync(1000);

			// Assert：锚定语义 + 其余在途任务的 taskId/agent/摘要不丢失 + 无时钟时间
			expect(pi.sendMessage).toHaveBeenCalled();
			const content: string = pi._sendMessageCalls[0][0].content;
			const block = extractInFlightBlock(content);
			expect(block, "信封应包含在途块（- 会话: 行与 --- 分隔线之间）").not.toBe("");
			expect(hasEventAnchoredLine(block, false), "非空在途块应有锚定本任务结束事件的限定陈述").toBe(true);
			expect(block).not.toMatch(ABSOLUTE_EMPTY_WORDING);
			expect(hasAbsoluteNowLine(block)).toBe(false);
			expect(block).not.toMatch(CLOCK_TIME);
			expect(block).toContain("019ffdd3-3eb5-733d-b481-a53e5292c004");
			expect(block).toContain("tester");
			expect(block).toMatch(/任务2/);
		});
	});

	// ================================================================
	// S3 裁决优先级：promptGuidelines 新增快照滞后裁决条目
	// ================================================================
	describe("S3 裁决优先级（promptGuidelines）", () => {
		it("should have a promptGuidelines entry stating in-flight block is a build-time snapshot and dispatch records prevail（RED）", () => {
			// Arrange
			const { toolsByName } = setupExtension();
			const subagent = toolsByName.get("subagent");
			expect(subagent, "subagent tool should be registered").toBeDefined();
			const guidelines: string[] = subagent.promptGuidelines || [];
			expect(guidelines.length).toBeGreaterThan(0);

			// Assert：同一条目内同时含
			//   (a) 在途块是构建时刻快照、可能滞后 的语义
			//   (b) 与本回合亲手发出的派发记录冲突时以派发记录为准 的语义
			// 按条目匹配（每条一个语义点），不跨条目拼接——防止跨条目假绿。
			const SNAPSHOT_SEMANTICS = /snapshot|stale|out.?of.?date|build[- ]time|as of/i;
			const DISPATCH_PREVAILS = /dispatch record|prevail|take precedence|override|trust .{0,20}dispatch/i;
			const hasRule = guidelines.some((g) => SNAPSHOT_SEMANTICS.test(g) && DISPATCH_PREVAILS.test(g));
			expect(
				hasRule,
				"promptGuidelines 应有条目同时含「在途块是构建时刻快照、可能滞后」与「冲突时以派发记录为准」语义",
			).toBe(true);
		});
	});

	// ================================================================
	// N2 语义迁移：exit 0 但无终态文本必须判 failed
	// ================================================================
	describe("N2 语义迁移：exit 0 + 无终态文本 ⇒ failed", () => {
		it("TUI 异步路径 exit 0 且无 message_end 文本时信封状态应为 failed（RED）", async () => {
			const { executeSubagentTool, pi } = setupExtension();
			const ctx = createMockTuiCtx(defaultCwd);
			const executePromise = executeSubagentTool!(
				"call-1",
				{ agent: "tester", task: "test task", sessionId: "019ffdd3-3eb5-733d-b481-a53e5292be01" },
				undefined,
				undefined,
				ctx,
			);
			await raceWithTimeout(executePromise, 200);

			endProcess(allProcs[0], 0);
			await vi.advanceTimersByTimeAsync(1000);

			expect(pi.sendMessage).toHaveBeenCalled();
			const [message] = pi._sendMessageCalls[0];
			expect(message.details.status).toBe("failed");
		});
	});
});
