/**
 * TDD 红阶段测试：subagent 工具的 action="peek"（一次性查看中途状态，不等待、
 * 不轮询）。
 *
 * 需求背景：主 agent 派出的子 agent 在后台异步运行，完工才有 [subagent-result]
 * 通知；中途没有任何可观测入口。peek 提供一次同步快照：带 taskId 时看单个任务
 * 的内存态（registry 里的 liveResult）或回退读磁盘会话文件；不带 taskId 时按
 * startedAt 升序列出全部任务。
 *
 * 现状（回归锁定）：src/index.ts 已实现 action="peek" —— 带 taskId 时读
 * registry 的 liveResult，未命中回退磁盘会话文件；不带 taskId 时按 startedAt
 * 升序列出全部任务。本文件用例是这些行为的回归锁（当前全部通过）。
 *
 * 契约要点（逐条编码在下面用例里）：
 *  - 单任务 brief 输出最多 8 行，行序固定为 头部 / 派单 / 自述 / 最近 / 已碰 /
 *    失败 / 状态 / 警示，缺项整行跳过。上限的存在意义是：peek 要在一次调用里
 *    看完，行数一旦随会话长度增长就会反过来污染主 agent 上下文；固定行序则让
 *    主 agent 不必逐行猜测哪一行是哪类信息。
 *  - 时间只用相对时长，绝不出现钟点：绝对时间会诱导主 agent 做时钟推算；
 *  - 「派单」取 task.task 折叠空白并截断 120 字（与派单时的摘要同长度，便于
 *    主 agent 把 peek 行对回自己当初的派单）；
 *  - 「自述」取最后一条 assistant 消息的非空 text 块拼接；若该消息没有 text，
 *    回退其最后一个 thinking 块的首句（截到首个 `。`/`！`/`？`/`.` 或 60 字）。
 *    只做摘录不做总结：peek 报的是子 agent 自己的话，避免主 agent 把生成式
 *    概括误当成子 agent 的意图；
 *  - 「最近」每个工具调用渲染为 `name(参数值)`（取值按 path / file_path /
 *    filePath / command / pattern / agent / task / sessionId / code 的优先级，
 *    值截 40 字，`→` 连接）；带上有界参数值是因为只给工具名时「edit」无法
 *    区分改了哪个文件，而这正是主 agent 判断是否跑偏所需的最小信息；
 *  - 「已碰」从 messages 的 toolCall 抽路径键 path / file_path / filePath；
 *    command 不计入，因为命令字符串不是被改动的文件；
 *  - 「失败」为 toolResult 中 isError === true 的条数，为 0 时整行不出现
 *    （0 次失败没有信息量，省略比报「0」更省一行）；
 *  - 「状态」看最后一条 toolCall 是否有同 toolCallId 的 toolResult；registry
 *    路径给出 `正在执行 <name>` / `空闲`，磁盘回退给出 `未知（无内存数据）`
 *    —— 磁盘上没有内存态，写「空闲」会被误读成「此刻没在干活」；
 *  - detail: "tail" 在 brief 之后追加 `— 原文 —` 段（最后 2 条消息、各截 150
 *    字摘录），因为 brief 是确定性的但有损，需要原文兜底时不能靠再猜一次；
 *  - 「警示」只放确定性命中项，`；` 分隔，全不命中则整行不出现；
 *  - 输出里不得出现「疑似跑偏」这类判断。
 *
 * 测试策略：沿用仓库既有 helper 风格 —— 只 mock getAgentDir、createMockPi 捕获
 * toolDefs 后取 subagent 的 execute；用 vi.useFakeTimers + setSystemTime 固定
 * 时钟，所有断言都是确定性的相对时长；磁盘回退用临时目录 fixture（同
 * test/session-transcript.test.ts）。本文件不触碰 src/。
 */

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import extension, { taskRegistry, resetProgressManagerForTests, STATUS_WORDS } from "../src/index.ts";
import type { AsyncSubagentTask } from "../src/index.ts";
import * as srcIndex from "../src/index.ts";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

// 仅 mock getAgentDir（用户级配置目录模块边界）；其余 API 保持真实。
vi.mock("@earendil-works/pi-coding-agent", async () => {
	const actual = await vi.importActual("@earendil-works/pi-coding-agent");
	return {
		...actual,
		getAgentDir: vi.fn(),
	};
});

// ---------------------------------------------------------------------------
// 固定夹具（不依赖真实时钟 / 随机数）
// ---------------------------------------------------------------------------

/** 固定「现在」：1_800_000_000_000 ms。所有相对时长都相对它计算。 */
const NOW = 1_800_000_000_000;

/** 固定 taskId：前三段相同，首段不同以便多任务时用短 id 区分。 */
const TASK_A = "019f3f44-3eb5-733d-b481-a53e5292c101";
const TASK_B = "019f3f45-3eb5-733d-b481-a53e5292c102";
const TASK_C = "019f3f46-3eb5-733d-b481-a53e5292c103";
const TASK_DISK = "019f3f47-3eb5-733d-b481-a53e5292c104";
const TASK_MISSING = "019f3f48-3eb5-733d-b481-a53e5292c105";

/** 与既有测试一致：清空 spawn 注入的身份/名单变量，保证 legacy 基线（可正常调用 execute）。 */
const ENV_KEYS = [
	"PI_SUBAGENT_DEPTH",
	"PI_SUBAGENT_ALLOWED",
	"PI_CURRENT_AGENT_NAME",
	"PI_CAN_DELEGATE",
	"PI_SUBAGENT_HARD_TIMEOUT_MS",
	"PI_SUBAGENT_ACTIVITY_TIMEOUT_MS",
];

/**
 * 期望 src 暴露的测试钩子：模块级「本进程内已结束任务」记录数组
 * （与 taskRegistry 同风格的导出）。元素形如
 * { taskId, agentName, task, startedAt, status, finishedAt }。
 * 用命名空间导入而不是具名导入：缺导出时只有依赖它的用例红，其余用例照常运行。
 */
function completedTasksOf(): any[] | undefined {
	const value = (srcIndex as any).completedTasks;
	return Array.isArray(value) ? value : undefined;
}

type ExecuteFn = (
	toolCallId: string,
	params: Record<string, unknown>,
	signal: AbortSignal | undefined,
	onUpdate: unknown,
	ctx: unknown,
) => Promise<any>;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** 与既有测试一致的 mock pi：捕获 registerTool 的 tool 定义。 */
function createMockPi() {
	const toolDefs: any[] = [];
	return {
		registerTool: vi.fn((tool: any) => {
			toolDefs.push(tool);
		}),
		registerCommand: vi.fn(),
		registerMessageRenderer: vi.fn(),
		on: vi.fn(),
		sendMessage: vi.fn(),
		_toolDefs: toolDefs,
	};
}

/** 一条 assistant 消息，content 只放一个 toolCall（轮次/工具计数在夹具里保持一致）。 */
function assistantToolCall(name: string, args: Record<string, unknown>, toolCallId: string): any {
	return {
		role: "assistant",
		content: [{ type: "toolCall", id: toolCallId, name, arguments: args }],
	};
}

/** 一条与 toolCall 配对的 toolResult 消息（同 toolCallId）。 */
function toolResult(toolCallId: string, toolName: string): any {
	return {
		role: "toolResult",
		toolCallId,
		toolName,
		content: [{ type: "text", text: "ok" }],
	};
}

/** 构造一个 registry 任务（直接写入权威内存，不经过 spawn / completeAsyncTask）。 */
function makeTask(params: {
	taskId: string;
	agentName: string;
	task: string;
	startedAt: number;
	messages: any[];
	status?: AsyncSubagentTask["status"];
}): AsyncSubagentTask {
	return {
		taskId: params.taskId,
		agentName: params.agentName,
		task: params.task,
		startedAt: params.startedAt,
		status: params.status ?? "running",
		abortController: new AbortController(),
		liveResult: {
			agent: params.agentName,
			agentSource: "user",
			task: params.task,
			exitCode: 0,
			messages: params.messages,
			stderr: "",
			usage: { input: 0, output: 0, totalTokens: 0 },
			phase: "idle",
			lastPhaseChange: params.startedAt,
			sessionId: params.taskId,
			startedAt: params.startedAt,
		},
	} as AsyncSubagentTask;
}

/**
 * 写一个带显式 timestamp 的 pi 会话 JSONL 文件：磁盘路径的「最近活动」取自
 * 最后一条 message 的 timestamp，mtime 是真实墙钟（与 fake timers 的 NOW 不可
 * 比），所以需要精确控制磁盘路径的 idle 时长时用这个夹具。
 */
function writeSessionFileAt(
	agentDir: string,
	taskId: string,
	messages: any[],
	lastActivityAt: number,
	startedAt = lastActivityAt,
): string {
	const dir = path.join(agentDir, "subagent-sessions", taskId);
	fs.mkdirSync(dir, { recursive: true });
	const file = path.join(dir, `1700000000000_${taskId}.jsonl`);
	const lines = [
		JSON.stringify({ type: "session", version: 3, id: taskId, timestamp: new Date(startedAt).toISOString() }),
		...messages.map((message) =>
			JSON.stringify({ type: "message", timestamp: new Date(lastActivityAt).toISOString(), message }),
		),
	];
	fs.writeFileSync(file, lines.join("\n") + "\n", "utf-8");
	return file;
}

/** 写一个 pi 会话 JSONL 文件（首行 session，随后 message 记录）。 */
function writeSessionFile(agentDir: string, taskId: string, messages: any[]): string {
	const dir = path.join(agentDir, "subagent-sessions", taskId);
	fs.mkdirSync(dir, { recursive: true });
	const file = path.join(dir, `1700000000000_${taskId}.jsonl`);
	const lines = [
		JSON.stringify({ type: "session", version: 3, id: taskId, timestamp: new Date(NOW).toISOString() }),
		...messages.map((message) => JSON.stringify({ type: "message", message })),
	];
	fs.writeFileSync(file, lines.join("\n") + "\n", "utf-8");
	return file;
}

/** 取非空行（peek 的文本行数断言不受空行影响）。 */
function nonEmptyLines(text: string): string[] {
	return text.split("\n").filter((line) => line.trim() !== "");
}

/** 取以某前缀开头的行（断言「警示：」整行）。 */
function lineStartingWith(text: string, prefix: string): string | undefined {
	return nonEmptyLines(text).find((line) => line.startsWith(prefix));
}

/** 一条只有 assistant text 块的消息（用于「自述」与 tail 原文摘录）。 */
function assistantText(text: string): any {
	return { role: "assistant", content: [{ type: "text", text }] };
}

/** 一条只有 thinking 块的 assistant 消息（用于「自述」的 thinking 回退）。 */
function assistantThinking(thinking: string): any {
	return { role: "assistant", content: [{ type: "thinking", thinking }] };
}

/** 一条带文本内容的 toolResult（便于在 tail 摘录里用唯一标记定位）。 */
function toolResultWithText(toolCallId: string, toolName: string, text: string, isError = false): any {
	return {
		role: "toolResult",
		toolCallId,
		toolName,
		isError,
		content: [{ type: "text", text }],
	};
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('subagent action="peek"（TDD 红阶段）', () => {
	let tmpBase: string;
	let agentDir: string;
	let projectCwd: string;
	let previousCwd: string;
	let savedEnv: Record<string, string | undefined>;
	let execute: ExecuteFn;
	let ctx: any;

	beforeEach(() => {
		vi.useFakeTimers();
		vi.setSystemTime(NOW);

		tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "peek-test-"));
		agentDir = path.join(tmpBase, "agent-dir");
		projectCwd = path.join(tmpBase, "project");
		fs.mkdirSync(agentDir, { recursive: true });
		// 无 subagent-isolation.json 的项目目录 → legacy 模式，subagent 工具无条件注册。
		fs.mkdirSync(path.join(projectCwd, ".pi", "agents"), { recursive: true });
		vi.mocked(getAgentDir).mockReturnValue(agentDir);

		// 工厂读取 process.cwd()：钉到临时项目目录，保证工具被注册。
		previousCwd = process.cwd();
		process.chdir(projectCwd);

		savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
		for (const key of ENV_KEYS) delete process.env[key];

		// 模块级内存权威数据隔离。
		taskRegistry.clear();
		if (completedTasksOf()) completedTasksOf()!.length = 0;
		resetProgressManagerForTests();

		const pi = createMockPi();
		extension(pi as any);
		const toolDef = pi._toolDefs.find((tool) => tool.name === "subagent");
		expect(toolDef, "subagent 工具应已注册").toBeDefined();
		execute = toolDef.execute;

		ctx = {
			cwd: projectCwd,
			hasUI: false,
			mode: "print" as const,
			ui: { notify: vi.fn(), setWidget: vi.fn() },
		};
	});

	afterEach(() => {
		process.chdir(previousCwd);
		for (const key of ENV_KEYS) {
			if (savedEnv[key] === undefined) delete process.env[key];
			else process.env[key] = savedEnv[key];
		}
		taskRegistry.clear();
		if (completedTasksOf()) completedTasksOf()!.length = 0;
		resetProgressManagerForTests();
		vi.useRealTimers();
		vi.restoreAllMocks();
		fs.rmSync(tmpBase, { recursive: true, force: true });
	});

	/** 调用 action="peek" 并返回 execute 结果。 */
	async function peek(params: Record<string, unknown>): Promise<any> {
		return execute("call-peek", { action: "peek", ...params }, undefined, undefined, ctx);
	}

	/** 取返回文本（execute 返回 { content: [{ type: "text", text }], details }）。 */
	function textOf(result: any): string {
		expect(result?.content?.[0]?.type).toBe("text");
		expect(typeof result.content[0].text).toBe("string");
		return result.content[0].text;
	}

	// ================================================================
	// 1. registry 命中：elapsed / 轮次 / 最近工具 / 已碰文件 / 状态
	// ================================================================
	it("should compute elapsed, rounds, recent tools, touched files and idle status from the registry task", async () => {
		// Arrange: 已跑 12 分 30 秒；4 个 assistant 轮次，每轮一个 toolCall + 配对结果。
		taskRegistry.set(
			TASK_A,
			makeTask({
				taskId: TASK_A,
				agentName: "engine-legion",
				task: "改写 README 的安装说明与注意事项，保持其余不变",
				startedAt: NOW - 750_000,
				messages: [
					assistantToolCall("edit", { path: "timer/index.ts" }, "tool_1"),
					toolResult("tool_1", "edit"),
					assistantToolCall("bash", { command: "node --test" }, "tool_2"),
					toolResult("tool_2", "bash"),
					assistantToolCall("edit", { path: "timer/parse.ts" }, "tool_3"),
					toolResult("tool_3", "edit"),
					assistantToolCall("edit", { path: "timer/timer.test.ts" }, "tool_4"),
					toolResult("tool_4", "edit"),
				],
			}),
		);

		// Act
		const result = await peek({ taskId: TASK_A });
		const text = textOf(result);

		// Assert: 头部（短 id + agent + 相对时长 + 轮次 + 状态词），且绝无钟点。
		const lines = nonEmptyLines(text);
		const header = lines[0];
		expect(result.isError).toBeFalsy();
		expect(header).toContain("#019f3f44 engine-legion");
		expect(header).toContain("已跑 12 分 30 秒");
		expect(header).toContain("4 轮");
		expect(header).toContain("running");
		expect(header).toContain("空闲");
		expect(text, "时间只用相对时长，不得出现钟点").not.toMatch(/\d{1,2}:\d{2}/);

		// Assert: 派单摘要取自 task.task（折叠空白）。
		expect(text).toContain("派单：改写 README 的安装说明与注意事项，保持其余不变");

		// Assert: 最近工具来自 toolCall（最后三个），顺序保持调用顺序。
		const recentLine = lineStartingWith(text, "最近：");
		expect(recentLine, "缺少「最近：」行").toBeDefined();
		expect(recentLine).toContain("bash(node --test)");
		expect(recentLine).toContain("edit(timer/parse.ts)");
		expect(recentLine).toContain("edit(timer/timer.test.ts)");
		expect(recentLine!.indexOf("bash(node --test)")).toBeLessThan(recentLine!.indexOf("edit(timer/parse.ts)"));
		expect(recentLine!.indexOf("edit(timer/parse.ts)")).toBeLessThan(recentLine!.indexOf("edit(timer/timer.test.ts)"));

		// Assert: 已碰文件按路径计数；command 不计入路径统计。
		const touchedLine = lineStartingWith(text, "已碰：");
		expect(touchedLine, "缺少「已碰：」行").toBeDefined();
		expect(touchedLine).toContain("timer/index.ts ×1");
		expect(touchedLine).toContain("timer/parse.ts ×1");
		expect(touchedLine).toContain("timer/timer.test.ts ×1");
		expect(touchedLine, "command 不得计入「已碰」").not.toMatch(/node --test\s*×/);

		// Assert: 所有 toolCall 都有配对结果 → 空闲。
		expect(text).toContain("状态：空闲");

		// Assert: 单任务输出行数受控（≤6 行）。
		expect(lines.length).toBeLessThanOrEqual(6);
	});

	// ================================================================
	// 2. 同一 (name, path) 连续 3 次 → 确定性警示
	// ================================================================
	it("should warn '同一文件连续改 3 次' when the same name+path is edited three times in a row", async () => {
		// Arrange: 三次连续的 edit 同一路径（中间无其它工具调用）。
		taskRegistry.set(
			TASK_A,
			makeTask({
				taskId: TASK_A,
				agentName: "engine-legion",
				task: "反复修改同一文件",
				startedAt: NOW - 60_000,
				messages: [
					assistantToolCall("edit", { path: "timer/index.ts" }, "tool_1"),
					toolResult("tool_1", "edit"),
					assistantToolCall("edit", { path: "timer/index.ts" }, "tool_2"),
					toolResult("tool_2", "edit"),
					assistantToolCall("edit", { path: "timer/index.ts" }, "tool_3"),
					toolResult("tool_3", "edit"),
				],
			}),
		);

		// Act
		const result = await peek({ taskId: TASK_A });
		const text = textOf(result);

		// Assert: 警示行存在且命中该确定性项；不得出现主观「跑偏」判断。
		const warningLine = lineStartingWith(text, "警示：");
		expect(warningLine, "连续改同一文件 3 次应出现「警示：」行").toBeDefined();
		expect(warningLine).toContain("同一文件连续改 3 次");
		expect(text).not.toContain("疑似跑偏");
	});

	// ================================================================
	// 3. 轮次 ≥20 且最近 5 个 toolCall 全 read → 「只读不写」
	// ================================================================
	it("should warn '只读不写' when rounds reach 20 and the last five tool calls are all read-only", async () => {
		// Arrange: 20 个 assistant 轮次，每轮一个 read（路径各不相同，避免连续同文件项）。
		const messages: any[] = [];
		for (let i = 0; i < 20; i++) {
			messages.push(assistantToolCall("read", { path: `src/file-${i}.ts` }, `tool_${i}`));
			messages.push(toolResult(`tool_${i}`, "read"));
		}
		taskRegistry.set(
			TASK_A,
			makeTask({
				taskId: TASK_A,
				agentName: "engine-legion",
				task: "只读排查 20 轮",
				startedAt: NOW - 1_200_000,
				messages,
			}),
		);

		// Act
		const result = await peek({ taskId: TASK_A });
		const text = textOf(result);

		// Assert: 轮次与警示项均确定性命中；不出现主观断语。
		expect(text).toContain("20 轮");
		const warningLine = lineStartingWith(text, "警示：");
		expect(warningLine, "轮次 ≥20 且近 5 次全只读应出现「警示：」行").toBeDefined();
		expect(warningLine).toContain("只读不写");
		expect(text).not.toContain("疑似跑偏");
	});

	// ================================================================
	// 4. 结尾 toolCall 无配对 toolResult → 状态「正在执行 <name>」
	// ================================================================
	it("should report '正在执行 bash' when the last tool call has no matching tool result", async () => {
		// Arrange: 最后一个 toolCall 是 bash，且没有任何 toolResult 携带其 toolCallId。
		taskRegistry.set(
			TASK_A,
			makeTask({
				taskId: TASK_A,
				agentName: "engine-legion",
				task: "正在跑测试",
				startedAt: NOW - 30_000,
				messages: [
					assistantToolCall("edit", { path: "timer/index.ts" }, "tool_1"),
					toolResult("tool_1", "edit"),
					assistantToolCall("bash", { command: "node --test" }, "tool_2"),
				],
			}),
		);

		// Act
		const result = await peek({ taskId: TASK_A });
		const text = textOf(result);

		// Assert: 未配对 → 正在执行，且指出工具名。
		expect(text).toContain("状态：正在执行 bash");
		expect(text).not.toContain("状态：空闲");
	});

	// ================================================================
	// 5. registry 未命中 → 回退读磁盘会话文件
	// ================================================================
	it("should fall back to the on-disk session file when the taskId is not in the registry", async () => {
		// Arrange: 任务不在 registry；磁盘会话含首条 user「Task: …」与 3 个 assistant 轮次。
		writeSessionFile(agentDir, TASK_DISK, [
			{ role: "user", content: [{ type: "text", text: "Task: 磁盘回退解析 TASKMARK-550" }] },
			assistantToolCall("edit", { path: "timer/index.ts" }, "tool_1"),
			toolResult("tool_1", "edit"),
			assistantToolCall("bash", { command: "node --test" }, "tool_2"),
			toolResult("tool_2", "bash"),
			assistantToolCall("edit", { path: "timer/parse.ts" }, "tool_3"),
			toolResult("tool_3", "edit"),
		]);
		expect(taskRegistry.has(TASK_DISK), "前置：任务不应在 registry 中").toBe(false);

		// Act
		const result = await peek({ taskId: TASK_DISK });
		const text = textOf(result);

		// Assert: 从磁盘解析出派单摘要与轮次（不因 registry 未命中而报错）。
		expect(result.isError).toBeFalsy();
		expect(text).toContain("#019f3f47");
		expect(text).toContain("磁盘回退解析 TASKMARK-550");
		expect(text).toContain("3 轮");
	});

	// ================================================================
	// 6. taskId 不存在且磁盘也没有 → 明确错误
	// ================================================================
	it("should return an explicit error suggesting an argument-less peek when the taskId is found nowhere", async () => {
		// Arrange: registry 无此任务，磁盘也从未写入会话目录。
		expect(taskRegistry.has(TASK_MISSING)).toBe(false);

		// Act
		const result = await peek({ taskId: TASK_MISSING });
		const text = textOf(result);

		// Assert: isError + 文本提示「用不带 taskId 的 peek 看现有任务」。
		expect(result.isError).toBe(true);
		expect(text).toMatch(/不带\s*taskId/);
		expect(text).toContain("peek");
	});

	// ================================================================
	// 7. 不带 taskId → 全部任务按 startedAt 升序，每任务一行
	// ================================================================
	it("should list every task one line each in ascending startedAt order when no taskId is given", async () => {
		// Arrange: 插入顺序 A、C、B；startedAt 顺序 B（最早）< A < C。
		taskRegistry.set(
			TASK_A,
			makeTask({
				taskId: TASK_A,
				agentName: "engine-legion",
				task: "任务 ALPHA",
				startedAt: NOW - 300_000,
				messages: [],
			}),
		);
		taskRegistry.set(
			TASK_C,
			makeTask({
				taskId: TASK_C,
				agentName: "engine-gamma",
				task: "任务 GAMMA",
				startedAt: NOW - 100_000,
				messages: [],
			}),
		);
		taskRegistry.set(
			TASK_B,
			makeTask({
				taskId: TASK_B,
				agentName: "engine-beta",
				task: "任务 BETA",
				startedAt: NOW - 600_000,
				messages: [],
			}),
		);

		// Act
		const result = await peek({});
		const text = textOf(result);

		// Assert: 每任务恰一行，共 3 行。
		const lines = nonEmptyLines(text);
		expect(result.isError).toBeFalsy();
		expect(lines).toHaveLength(3);

		// Assert: 每行含短 id、状态词、相对时长与派单摘要（无钟点）。
		for (const line of lines) {
			expect(line).toContain("· running ·");
			expect(line).toContain("空闲");
			expect(line, "列表时间只用相对时长").not.toMatch(/\d{1,2}:\d{2}/);
		}
		expect(lines.some((line) => line.startsWith("#019f3f44 "))).toBe(true);
		expect(lines.some((line) => line.startsWith("#019f3f45 "))).toBe(true);
		expect(lines.some((line) => line.startsWith("#019f3f46 "))).toBe(true);

		// Assert: startedAt 升序：B 最早，A 次之，C 最后。
		const joined = lines.join("\n");
		expect(joined.indexOf("#019f3f45")).toBeLessThan(joined.indexOf("#019f3f44"));
		expect(joined.indexOf("#019f3f44")).toBeLessThan(joined.indexOf("#019f3f46"));

		// Assert: 每行带派单摘要。
		expect(joined).toContain("任务 BETA");
		expect(joined).toContain("任务 ALPHA");
		expect(joined).toContain("任务 GAMMA");
	});

	// ================================================================
	// 8. 「最近」读得到 subagent 的参数（agent / task），不只工具名
	// ================================================================
	it("should show the subagent arguments, not just the tool name, in the recent line", async () => {
		// Arrange: 两个 subagent 调用，分别只带 agent / 只带 task（候选键取首个非空值）。
		taskRegistry.set(
			TASK_A,
			makeTask({
				taskId: TASK_A,
				agentName: "master",
				task: "派单旁观",
				startedAt: NOW - 30_000,
				messages: [
					assistantToolCall("subagent", { agent: "engine-legion" }, "tool_1"),
					toolResult("tool_1", "subagent"),
					assistantToolCall("subagent", { task: "TASKMARK-RECENT" }, "tool_2"),
					toolResult("tool_2", "subagent"),
				],
			}),
		);

		// Act
		const result = await peek({ taskId: TASK_A });
		const text = textOf(result);

		// Assert: 参数值出现在「最近」行（只读到工具名时不会出现）。
		const recentLine = lineStartingWith(text, "最近：");
		expect(recentLine, "缺少「最近：」行").toBeDefined();
		expect(recentLine).toContain("subagent");
		expect(recentLine).toContain("engine-legion");
		expect(recentLine).toContain("TASKMARK-RECENT");
	});

	// ================================================================
	// 9. 「自述」取最后一条 assistant 的 text 块；无 text 时回退 thinking 首句
	// ================================================================
	it("should narrate the last assistant text blocks, falling back to the first thinking sentence when there is no text", async () => {
		// Arrange: 最后一条 assistant 有多个 text 块，其中一块为空。
		taskRegistry.set(
			TASK_A,
			makeTask({
				taskId: TASK_A,
				agentName: "engine-legion",
				task: "自述提取",
				startedAt: NOW - 30_000,
				messages: [
					assistantToolCall("read", { path: "src/a.ts" }, "tool_1"),
					toolResult("tool_1", "read"),
					{
						role: "assistant",
						content: [
							{ type: "text", text: "第一段自述" },
							{ type: "text", text: "   " },
							{ type: "text", text: "第二段自述" },
						],
					},
				],
			}),
		);

		// Act
		const withText = textOf(await peek({ taskId: TASK_A }));

		// Assert: 拼接最后一条 assistant 的所有非空 text 块。
		const textLine = lineStartingWith(withText, "自述：");
		expect(textLine, "缺少「自述：」行").toBeDefined();
		expect(textLine).toContain("第一段自述");
		expect(textLine).toContain("第二段自述");

		// Arrange: 换成没有 text、只有 thinking 的结尾消息（多句）。
		taskRegistry.set(
			TASK_A,
			makeTask({
				taskId: TASK_A,
				agentName: "engine-legion",
				task: "自述提取",
				startedAt: NOW - 30_000,
				messages: [
					assistantToolCall("read", { path: "src/a.ts" }, "tool_1"),
					toolResult("tool_1", "read"),
					assistantThinking("先看目录。再看文件。第三句"),
				],
			}),
		);

		// Act
		const withThinking = textOf(await peek({ taskId: TASK_A }));

		// Assert: 回退到 thinking 首句（截到第一个句号），不带后续句子。
		const thinkingLine = lineStartingWith(withThinking, "自述：");
		expect(thinkingLine, "缺少「自述：」行").toBeDefined();
		expect(thinkingLine).toContain("先看目录");
		expect(thinkingLine).not.toContain("再看文件");
	});

	// ================================================================
	// 10. 无 text 无 thinking → 「自述」整行不出现
	// ================================================================
	it("should omit the narration line entirely when the last assistant message has neither text nor thinking", async () => {
		// Arrange: 最后一条 assistant 只有 toolCall。
		taskRegistry.set(
			TASK_A,
			makeTask({
				taskId: TASK_A,
				agentName: "engine-legion",
				task: "无文本消息",
				startedAt: NOW - 30_000,
				messages: [
					assistantToolCall("read", { path: "src/a.ts" }, "tool_1"),
					toolResult("tool_1", "read"),
				],
			}),
		);

		// Act
		const text = textOf(await peek({ taskId: TASK_A }));

		// Assert: 整行不出现，也不留空占位。
		expect(lineStartingWith(text, "自述：")).toBeUndefined();
		expect(text).not.toContain("自述");
	});

	// ================================================================
	// 11. 「失败」统计 isError 条数；为 0 时整行不出现
	// ================================================================
	it("should count failed tool results and omit the failure line when the count is zero", async () => {
		// Arrange: 3 个 toolResult，其中 2 个 isError: true。
		taskRegistry.set(
			TASK_A,
			makeTask({
				taskId: TASK_A,
				agentName: "engine-legion",
				task: "失败计数",
				startedAt: NOW - 30_000,
				messages: [
					assistantToolCall("edit", { path: "src/a.ts" }, "tool_1"),
					toolResultWithText("tool_1", "edit", "boom", true),
					assistantToolCall("bash", { command: "node --test" }, "tool_2"),
					toolResultWithText("tool_2", "bash", "boom", true),
					assistantToolCall("read", { path: "src/b.ts" }, "tool_3"),
					toolResultWithText("tool_3", "read", "ok", false),
				],
			}),
		);

		// Act
		const text = textOf(await peek({ taskId: TASK_A }));

		// Assert: 失败计数为 2。
		const failedLine = lineStartingWith(text, "失败：");
		expect(failedLine, "缺少「失败：」行").toBeDefined();
		expect(failedLine).toContain("失败：2 次");

		// Arrange: 全部 isError: false。
		taskRegistry.set(
			TASK_A,
			makeTask({
				taskId: TASK_A,
				agentName: "engine-legion",
				task: "失败计数",
				startedAt: NOW - 30_000,
				messages: [
					assistantToolCall("edit", { path: "src/a.ts" }, "tool_1"),
					toolResultWithText("tool_1", "edit", "ok", false),
					assistantToolCall("bash", { command: "node --test" }, "tool_2"),
					toolResultWithText("tool_2", "bash", "ok", false),
					assistantToolCall("read", { path: "src/b.ts" }, "tool_3"),
					toolResultWithText("tool_3", "read", "ok", false),
				],
			}),
		);

		// Act
		const allOk = textOf(await peek({ taskId: TASK_A }));

		// Assert: 为 0 时整行不出现。
		expect(lineStartingWith(allOk, "失败：")).toBeUndefined();
	});

	// ================================================================
	// 12. detail: "tail" 追加最后 2 条消息原文；"brief" 不追加
	// ================================================================
	it("should append the last two raw messages only when detail is 'tail'", async () => {
		// Arrange: 前部有早期文本；最后 2 条是 assistant 文本 + toolResult。
		taskRegistry.set(
			TASK_A,
			makeTask({
				taskId: TASK_A,
				agentName: "engine-legion",
				task: "原文摘录",
				startedAt: NOW - 30_000,
				messages: [
					assistantText("EARLY-EXCERPT 早期内容"),
					assistantToolCall("read", { path: "src/a.ts" }, "tool_1"),
					toolResult("tool_1", "read"),
					assistantText("TAIL-ASSISTANT 最终答复"),
					toolResultWithText("tool_9", "bash", "TAIL-RESULT 命令输出", false),
				],
			}),
		);

		// Act
		const tailText = textOf(await peek({ taskId: TASK_A, detail: "tail" }));
		const briefText = textOf(await peek({ taskId: TASK_A, detail: "brief" }));
		const defaultText = textOf(await peek({ taskId: TASK_A }));

		// Assert: tail 追加「— 原文 —」及最后 2 条消息的单行摘录。
		expect(tailText).toContain("— 原文 —");
		expect(tailText).toContain("TAIL-ASSISTANT 最终答复");
		expect(tailText).toContain("TAIL-RESULT 命令输出");
		expect(lineStartingWith(tailText, "[assistant]")).toBeDefined();
		expect(lineStartingWith(tailText, "[toolResult]")).toBeDefined();
		expect(tailText, "摘录只取最后 2 条消息").not.toContain("EARLY-EXCERPT");

		// Assert: brief（显式与默认）都不追加原文。
		expect(briefText).not.toContain("— 原文 —");
		expect(defaultText).not.toContain("— 原文 —");
	});

	// ================================================================
	// 13. 磁盘回退的状态词与 registry 的状态词
	// ================================================================
	it("should report an unknown status from disk and keep the live status from the registry", async () => {
		// Arrange: 磁盘会话（registry 未命中）。
		writeSessionFile(agentDir, TASK_DISK, [
			{ role: "user", content: [{ type: "text", text: "Task: 磁盘状态词" }] },
			assistantToolCall("read", { path: "src/a.ts" }, "tool_1"),
			toolResult("tool_1", "read"),
		]);

		// Act
		const diskText = textOf(await peek({ taskId: TASK_DISK }));

		// Assert: 磁盘路径没有内存态，明确标未知。
		expect(diskText).toContain("状态：未知（无内存数据）");

		// Arrange: registry 任务，结尾 bash 无配对结果；另一个任务全部配对。
		taskRegistry.set(
			TASK_A,
			makeTask({
				taskId: TASK_A,
				agentName: "engine-legion",
				task: "正在执行",
				startedAt: NOW - 30_000,
				messages: [
					assistantToolCall("read", { path: "src/a.ts" }, "tool_1"),
					toolResult("tool_1", "read"),
					assistantToolCall("bash", { command: "node --test" }, "tool_2"),
				],
			}),
		);
		taskRegistry.set(
			TASK_B,
			makeTask({
				taskId: TASK_B,
				agentName: "engine-beta",
				task: "空闲",
				startedAt: NOW - 20_000,
				messages: [
					assistantToolCall("read", { path: "src/b.ts" }, "tool_3"),
					toolResult("tool_3", "read"),
				],
			}),
		);

		// Act
		const runningText = textOf(await peek({ taskId: TASK_A }));
		const idleText = textOf(await peek({ taskId: TASK_B }));

		// Assert: registry 路径仍输出「正在执行 <name>」/「空闲」。
		expect(runningText).toContain("状态：正在执行 bash");
		expect(idleText).toContain("状态：空闲");
	});

	// ================================================================
	// 14. 行数上限：八项全有也不超过 8 行
	// ================================================================
	it("should keep the brief output at eight lines or fewer when every section is present", async () => {
		// Arrange: 头部 / 派单 / 自述 / 最近 / 已碰 / 失败 / 状态 / 警示 全部命中。
		taskRegistry.set(
			TASK_A,
			makeTask({
				taskId: TASK_A,
				agentName: "engine-legion",
				task: "全都有的任务 " + "细节".repeat(80),
				startedAt: NOW - 30_000,
				messages: [
					assistantToolCall("edit", { path: "src/a.ts" }, "tool_1"),
					toolResultWithText("tool_1", "edit", "boom", true),
					assistantToolCall("edit", { path: "src/a.ts" }, "tool_2"),
					toolResultWithText("tool_2", "edit", "ok", false),
					assistantToolCall("edit", { path: "src/a.ts" }, "tool_3"),
					toolResultWithText("tool_3", "edit", "ok", false),
					{
						role: "assistant",
						content: [
							{ type: "text", text: "正在收尾，自述内容在此" },
							{ type: "toolCall", id: "tool_4", name: "bash", arguments: { command: "node --test" } },
						],
					},
				],
			}),
		);

		// Act
		const text = textOf(await peek({ taskId: TASK_A }));
		const lines = nonEmptyLines(text);

		// Assert: 八项各占一行，总数不超过 8。
		expect(lines.length).toBeLessThanOrEqual(8);
		for (const prefix of ["派单：", "自述：", "最近：", "已碰：", "失败：", "状态：", "警示："]) {
			expect(lineStartingWith(text, prefix), `缺少「${prefix}」行`).toBeDefined();
		}
	});

	// ================================================================
	// 15. 「派单」上限为 120 字（不再是 60）
	// ================================================================
	it("should keep up to 120 characters of the task description on the dispatch line", async () => {
		// Arrange: 60 字之后、120 字之前放唯一标记，第 121 字起放另一唯一标记。
		const kept = "甲".repeat(60) + "KEEP-MARK-100" + "甲".repeat(120 - 60 - "KEEP-MARK-100".length);
		expect(kept.length, "断言夹具恰为 120 字").toBe(120);
		const dropped = "DROP-MARK-121" + "乙".repeat(50);
		taskRegistry.set(
			TASK_A,
			makeTask({
				taskId: TASK_A,
				agentName: "engine-legion",
				task: kept + dropped,
				startedAt: NOW - 30_000,
				messages: [],
			}),
		);

		// Act
		const text = textOf(await peek({ taskId: TASK_A }));

		// Assert: 120 字内的标记保留，121 字起的标记被截掉。
		const dispatchLine = lineStartingWith(text, "派单：");
		expect(dispatchLine, "缺少「派单：」行").toBeDefined();
		expect(dispatchLine).toContain("KEEP-MARK-100");
		expect(dispatchLine).not.toContain("DROP-MARK-121");
	});

	// ================================================================
	// 16. completedTasks 命中：内存提供身份与状态，磁盘提供行为轨迹
	// ================================================================
	it("should merge the completedTasks identity with the on-disk trace when the task already finished in this process", async () => {
		// Arrange: 本进程内已结束的记录（含 agentName / status）。
		expect(completedTasksOf(), "src 应导出 completedTasks 供测试构造已结束记录").toBeDefined();
		completedTasksOf()!.push({
			taskId: TASK_A,
			agentName: "engine-legion",
			task: "已完成任务 MEMORY-TASK-MARK",
			startedAt: NOW - 600_000,
			status: "success",
			finishedAt: NOW - 60_000,
		});
		// Arrange: 磁盘会话只提供轨迹（无 agent 名，内容带唯一标记）。
		writeSessionFile(agentDir, TASK_A, [
			{ role: "user", content: [{ type: "text", text: "Task: 磁盘轨迹 TASKMARK-COMPLETED" }] },
			assistantToolCall("read", { path: "completed/touched.ts" }, "tool_1"),
			toolResultWithText("tool_1", "read", "FAIL-MARK-COMPLETED", true),
			assistantToolCall("bash", { command: "node --test" }, "tool_2"),
			toolResult("tool_2", "bash"),
			assistantText("NARRATION-MARK-COMPLETED 已完成收尾"),
		]);
		expect(taskRegistry.has(TASK_A), "前置：任务不应在 registry 中").toBe(false);

		// Act
		const result = await peek({ taskId: TASK_A });
		const text = textOf(result);

		// Assert: 身份与状态来自内存（磁盘上没有 agent 名与状态）。
		expect(result.isError).toBeFalsy();
		expect(text).toContain("engine-legion");
		expect(text).toContain(STATUS_WORDS.success);
		expect(text, "内存命中时不应报未知状态").not.toContain("未知（无内存数据）");

		// Assert: 轨迹字段来自磁盘（内存记录里只有任务摘要）。
		const recentLine = lineStartingWith(text, "最近：");
		expect(recentLine, "缺少「最近：」行").toBeDefined();
		expect(recentLine).toContain("completed/touched.ts");
		expect(recentLine).toContain("bash(node --test)");
		const narrationLine = lineStartingWith(text, "自述：");
		expect(narrationLine, "缺少「自述：」行").toBeDefined();
		expect(narrationLine).toContain("NARRATION-MARK-COMPLETED");
		const touchedLine = lineStartingWith(text, "已碰：");
		expect(touchedLine, "缺少「已碰：」行").toBeDefined();
		expect(touchedLine).toContain("completed/touched.ts ×1");
		expect(lineStartingWith(text, "失败："), "缺少「失败：」行").toContain("失败：1 次");

		// Assert: 「状态」行同样用 STATUS_WORDS 状态词，不得与头部的 succeeded 自相矛盾（不能是「空闲」）。
		const statusLine = lineStartingWith(text, "状态：");
		expect(statusLine, "缺少「状态：」行").toBeDefined();
		expect(statusLine).toContain(STATUS_WORDS.success);
		expect(statusLine, "内存命中时「状态」行不应报未知").not.toContain("未知（无内存数据）");
		expect(statusLine, "已完成任务不能同时说 succeeded 与空闲").not.toContain("空闲");
	});

	// ================================================================
	// 17. completedTasks 未命中 → 磁盘回退的未知状态
	// ================================================================
	it("should fall back to disk with an unknown status when the task is not in completedTasks", async () => {
		// Arrange: 内存两处都没有；只有磁盘会话。
		writeSessionFile(agentDir, TASK_DISK, [
			{ role: "user", content: [{ type: "text", text: "Task: 磁盘未知状态" }] },
			assistantToolCall("read", { path: "src/a.ts" }, "tool_1"),
			toolResult("tool_1", "read"),
		]);
		expect(taskRegistry.has(TASK_DISK)).toBe(false);
		expect(completedTasksOf()?.some((record) => record.taskId === TASK_DISK) ?? false).toBe(false);

		// Act
		const text = textOf(await peek({ taskId: TASK_DISK }));

		// Assert: 无内存态 → 明确未知，且不回落到「空闲」。
		expect(text).toContain("状态：未知（无内存数据）");
		expect(text).not.toContain("状态：空闲");
	});

	// ================================================================
	// 18. 连续 3 次 read 同一文件 → 不算「连续改」
	// ================================================================
	it("should not warn '同一文件连续改' when the same file is read three times in a row", async () => {
		// Arrange: 三次连续的 read 同一路径。
		taskRegistry.set(
			TASK_A,
			makeTask({
				taskId: TASK_A,
				agentName: "engine-legion",
				task: "反复读同一文件",
				startedAt: NOW - 60_000,
				messages: [
					assistantToolCall("read", { path: "src/a.ts" }, "tool_1"),
					toolResult("tool_1", "read"),
					assistantToolCall("read", { path: "src/a.ts" }, "tool_2"),
					toolResult("tool_2", "read"),
					assistantToolCall("read", { path: "src/a.ts" }, "tool_3"),
					toolResult("tool_3", "read"),
				],
			}),
		);

		// Act
		const text = textOf(await peek({ taskId: TASK_A }));

		// Assert: 读不是写，不能报「连续改」。
		expect(text).not.toContain("同一文件连续改");
	});

	// ================================================================
	// 19. 连续 3 次 edit 同一文件 → 仍命中「连续改 3 次」
	// ================================================================
	it("should warn '同一文件连续改 3 次' when the same file is edited three times in a row", async () => {
		// Arrange: 三次连续的 edit 同一路径。
		taskRegistry.set(
			TASK_A,
			makeTask({
				taskId: TASK_A,
				agentName: "engine-legion",
				task: "反复改同一文件",
				startedAt: NOW - 60_000,
				messages: [
					assistantToolCall("edit", { path: "src/a.ts" }, "tool_1"),
					toolResult("tool_1", "edit"),
					assistantToolCall("edit", { path: "src/a.ts" }, "tool_2"),
					toolResult("tool_2", "edit"),
					assistantToolCall("edit", { path: "src/a.ts" }, "tool_3"),
					toolResult("tool_3", "edit"),
				],
			}),
		);

		// Act
		const text = textOf(await peek({ taskId: TASK_A }));

		// Assert: 写路径仍然确定性命中。
		expect(lineStartingWith(text, "警示：")).toContain("同一文件连续改 3 次");
	});

	// ================================================================
	// 20. 最近 5 次含 bash → 不算「只读不写」
	// ================================================================
	it("should not warn '只读不写' when the last five tool calls include bash", async () => {
		// Arrange: 20 轮；最近 5 次为 4 次 read + 1 次 bash。
		const messages: any[] = [];
		for (let i = 0; i < 19; i++) {
			messages.push(assistantToolCall("read", { path: `src/file-${i}.ts` }, `tool_${i}`));
			messages.push(toolResult(`tool_${i}`, "read"));
		}
		messages.push(assistantToolCall("bash", { command: "node --test" }, "tool_bash"));
		messages.push(toolResult("tool_bash", "bash"));
		taskRegistry.set(
			TASK_A,
			makeTask({
				taskId: TASK_A,
				agentName: "engine-legion",
				task: "读后跑测试",
				startedAt: NOW - 1_200_000,
				messages,
			}),
		);

		// Act
		const text = textOf(await peek({ taskId: TASK_A }));

		// Assert: 触发条件成立（20 轮），但 bash 是执行动作，不能算只读。
		expect(text).toContain("20 轮");
		expect(text).not.toContain("只读不写");
	});

	// ================================================================
	// 21. 自述剥掉行首四类 markdown 前缀（#+ / ** / - / >）
	// ================================================================
	it("should strip each of the four leading markdown markers from the narration line", async () => {
		// Arrange: 四种行首标记，各自带唯一正文标记（多行文本会被折叠空白）。
		const cases = [
			{ label: "标题", text: "## 已完成\n\n收尾完成", prefix: /^自述：\s*#/, marker: "已完成" },
			{ label: "粗体", text: "**粗体MARK** 开头", prefix: /^自述：\s*[-*>]/, marker: "粗体MARK" },
			// 闭合 `**` 后直接接中文冒号：行首 `**` 仍属于前缀，必须剥掉。
			{ label: "粗体接标点", text: "**结论**：收尾 TASKMARK-BOLD", prefix: /^自述：\s*\*/, marker: "TASKMARK-BOLD" },
			{ label: "列表", text: "- 列表项MARK\n\n正文", prefix: /^自述：\s*[-*>]/, marker: "列表项MARK" },
			{ label: "引用", text: "> 引用MARK\n\n正文", prefix: /^自述：\s*[-*>]/, marker: "引用MARK" },
		];

		for (const testCase of cases) {
			taskRegistry.set(
				TASK_A,
				makeTask({
					taskId: TASK_A,
					agentName: "engine-legion",
					task: "自述剥前缀",
					startedAt: NOW - 30_000,
					messages: [
						assistantToolCall("read", { path: "src/a.ts" }, "tool_1"),
						toolResult("tool_1", "read"),
						assistantText(testCase.text),
					],
				}),
			);

			// Act
			const text = textOf(await peek({ taskId: TASK_A }));
			const narrationLine = lineStartingWith(text, "自述：");

			// Assert: 行首标记被剥掉（不以该前缀字符开头），正文标记保留。
			expect(narrationLine, `缺少「自述：」行（${testCase.label}）`).toBeDefined();
			expect(narrationLine, `${testCase.label}前缀未剥离`).not.toMatch(testCase.prefix);
			expect(narrationLine, `${testCase.label}前缀剥离吃掉了正文`).toContain(testCase.marker);
		}
	});

	// ================================================================
	// 22. 正文本身以 `**` 开头（glob，不是 markdown 前缀）→ 原样保留
	// ================================================================
	it("should keep a glob body that starts with '**' intact on the narration line", async () => {
		// Arrange: 最后一条 assistant 的文本以 glob `**/*.ts` 开头。
		taskRegistry.set(
			TASK_A,
			makeTask({
				taskId: TASK_A,
				agentName: "engine-legion",
				task: "自述 glob 正文",
				startedAt: NOW - 30_000,
				messages: [
					assistantToolCall("read", { path: "src/a.ts" }, "tool_1"),
					toolResult("tool_1", "read"),
					assistantText("**/*.ts 这三个文件都要看"),
				],
			}),
		);

		// Act
		const text = textOf(await peek({ taskId: TASK_A }));
		const narrationLine = lineStartingWith(text, "自述：");

		// Assert: `**` 是正文的一部分，不得当 markdown 前缀剥掉。
		expect(narrationLine, "缺少「自述：」行").toBeDefined();
		expect(narrationLine, "glob 的 `**` 被当成 markdown 前缀剥掉").toContain("**/*.ts");
		expect(narrationLine).toContain("这三个文件都要看");
	});

	// ================================================================
	// 23. 终态任务：头部不再说「空闲」，状态行给终态词
	// ================================================================
	it("should say '结束' instead of '空闲' in the header and report the terminal word for a finished task", async () => {
		// Arrange: 本进程内已结束 1 分钟的任务（终态 = success），磁盘提供轨迹。
		expect(completedTasksOf(), "src 应导出 completedTasks 供测试构造已结束记录").toBeDefined();
		completedTasksOf()!.push({
			taskId: TASK_A,
			agentName: "engine-legion",
			task: "终态头部",
			startedAt: NOW - 600_000,
			status: "success",
			finishedAt: NOW - 60_000,
		});
		writeSessionFile(agentDir, TASK_A, [
			{ role: "user", content: [{ type: "text", text: "Task: 终态头部" }] },
			assistantToolCall("read", { path: "src/a.ts" }, "tool_1"),
			toolResult("tool_1", "read"),
			assistantText("TERMINAL-HEADER 收尾完成"),
		]);

		// Act
		const text = textOf(await peek({ taskId: TASK_A }));
		const header = nonEmptyLines(text)[0];

		// Assert: 终态任务没有「空闲」这个概念，头部改说「结束 <时长>」。
		expect(header).toContain("结束 ");
		expect(header, "终态任务的头部不应出现「空闲 」").not.toContain("空闲 ");
		expect(text).toContain("状态：succeeded");
	});

	// ================================================================
	// 24. 在跑任务：头部仍然是「空闲 <时长>」
	// ================================================================
	it("should still say '空闲' in the header for a running task", async () => {
		// Arrange: registry 里的在跑任务，最后活动 1 分钟前。
		taskRegistry.set(
			TASK_A,
			makeTask({
				taskId: TASK_A,
				agentName: "engine-legion",
				task: "在跑头部",
				startedAt: NOW - 600_000,
				messages: [],
			}),
		);

		// Act
		const text = textOf(await peek({ taskId: TASK_A }));
		const header = nonEmptyLines(text)[0];

		// Assert: 在跑任务照旧报空闲，且是相对时长。
		expect(header).toContain("空闲 ");
		expect(header).not.toContain("结束 ");
	});

	// ================================================================
	// 25. 终态任务：空闲 / 结尾无回音类警示全部不成立
	// ================================================================
	it("should not warn about idle time or a silent ending for a finished task", async () => {
		// Arrange: 终态任务，最后活动在 10 分钟前（≥ 空闲 5 分钟阈值）。
		completedTasksOf()!.push({
			taskId: TASK_A,
			agentName: "engine-legion",
			task: "终态空闲警示",
			startedAt: NOW - 1_200_000,
			status: "success",
			finishedAt: NOW - 600_000,
		});
		writeSessionFile(agentDir, TASK_A, [
			{ role: "user", content: [{ type: "text", text: "Task: 终态空闲警示" }] },
			assistantToolCall("read", { path: "src/a.ts" }, "tool_1"),
			toolResult("tool_1", "read"),
			assistantText("TERMINAL-IDLE 收尾完成"),
		]);

		// Act
		const idleText = textOf(await peek({ taskId: TASK_A }));

		// Assert: 任务已结束，「空闲超过 5 分钟」是对终态的误报。
		expect(idleText, "终态任务不应出现「空闲超过 5 分钟」").not.toContain("空闲超过 5 分钟");

		// Arrange: 换成结尾是 toolResult 的终态任务，最后活动在 15 分钟前（≥ 结尾无回音阈值）。
		completedTasksOf()!.length = 0;
		completedTasksOf()!.push({
			taskId: TASK_A,
			agentName: "engine-legion",
			task: "终态结尾警示",
			startedAt: NOW - 1_500_000,
			status: "success",
			finishedAt: NOW - 900_000,
		});
		writeSessionFile(agentDir, TASK_A, [
			{ role: "user", content: [{ type: "text", text: "Task: 终态结尾警示" }] },
			assistantToolCall("bash", { command: "node --test" }, "tool_2"),
			toolResultWithText("tool_2", "bash", "TAIL-RESULT 命令输出", false),
		]);

		// Act
		const silentText = textOf(await peek({ taskId: TASK_A }));

		// Assert: 任务已结束，「结尾无回音」同样是对终态的误报。
		expect(silentText, "终态任务不应出现「结尾无回音」").not.toContain("结尾无回音");
	});

	// ================================================================
	// 26. 在跑任务：空闲 10 分钟仍然报「空闲超过 5 分钟」（防过度抑制）
	// ================================================================
	it("should still warn '空闲超过 5 分钟' when a running task has been idle for ten minutes", async () => {
		// Arrange: 在跑任务，最后活动 10 分钟前。
		taskRegistry.set(
			TASK_A,
			makeTask({
				taskId: TASK_A,
				agentName: "engine-legion",
				task: "在跑长空闲",
				startedAt: NOW - 600_000,
				messages: [],
			}),
		);

		// Act
		const text = textOf(await peek({ taskId: TASK_A }));

		// Assert: 抑制只针对终态，在跑任务照旧报空闲警示。
		expect(lineStartingWith(text, "警示：")).toContain("空闲超过 5 分钟");
	});

	// ================================================================
	// 27. 列表形态：终态行说「结束」，不再说「空闲」
	// ================================================================
	it("should say '结束' instead of '空闲' on the finished task's list line", async () => {
		// Arrange: 一个在跑任务 + 一个本进程内已结束任务。
		taskRegistry.set(
			TASK_A,
			makeTask({
				taskId: TASK_A,
				agentName: "engine-legion",
				task: "列表在跑",
				startedAt: NOW - 300_000,
				messages: [],
			}),
		);
		completedTasksOf()!.push({
			taskId: TASK_B,
			agentName: "engine-beta",
			task: "列表终态",
			startedAt: NOW - 600_000,
			status: "success",
			finishedAt: NOW - 60_000,
		});

		// Act
		const text = textOf(await peek({}));
		const finishedLine = lineStartingWith(text, "#019f3f45 ");

		// Assert: 终态行说「结束 <时长>」，且不含「空闲 」。
		expect(finishedLine, "缺少终态任务的列表行").toBeDefined();
		expect(finishedLine).toContain("结束 ");
		expect(finishedLine, "终态任务的列表行不应出现「空闲 」").not.toContain("空闲 ");
	});

	// ================================================================
	// 28. 自述 `**结论**：x`：闭合的 `**` 也要剥掉
	// ================================================================
	it("should strip the closing '**' of a bold narration lead-in", async () => {
		// Arrange: 最后一条 assistant 文本以粗体短语「**结论**：」开头。
		taskRegistry.set(
			TASK_A,
			makeTask({
				taskId: TASK_A,
				agentName: "engine-legion",
				task: "自述闭合粗体",
				startedAt: NOW - 30_000,
				messages: [
					assistantToolCall("read", { path: "src/a.ts" }, "tool_1"),
					toolResult("tool_1", "read"),
					assistantText("**结论**：SELFMARK-BOLD 收尾完成"),
				],
			}),
		);

		// Act
		const text = textOf(await peek({ taskId: TASK_A }));

		// Assert: 成对的 `**` 是格式噪音，单行输出里不得留下 `结论**`。
		expect(text).not.toContain("结论**");
		expect(lineStartingWith(text, "自述：")).toContain("结论");
		expect(lineStartingWith(text, "自述：")).toContain("SELFMARK-BOLD");
	});

	// ================================================================
	// 29. 磁盘回退（活性未知）：空闲 10 分钟不报「空闲超过 5 分钟」
	// ================================================================
	it("should not warn about idle time on the disk fallback path when idle for ten minutes", async () => {
		// Arrange: registry / completedTasks 都没有，只有磁盘会话；最后活动 10 分钟前。
		writeSessionFileAt(
			agentDir,
			TASK_DISK,
			[
				{ role: "user", content: [{ type: "text", text: "Task: 磁盘未知活性" }] },
				assistantToolCall("read", { path: "src/a.ts" }, "tool_1"),
				toolResult("tool_1", "read"),
				assistantText("DISK-IDLE 还在想下一步"),
			],
			NOW - 600_000,
			NOW - 900_000,
		);
		expect(taskRegistry.has(TASK_DISK), "前置：任务不应在 registry 中").toBe(false);
		expect(completedTasksOf()?.some((record) => record.taskId === TASK_DISK) ?? false).toBe(false);

		// Act
		const text = textOf(await peek({ taskId: TASK_DISK }));

		// Assert: 磁盘上不知道它是否还活着，就不能用「可能卡住了」的口吻报警。
		const warningLine = lineStartingWith(text, "警示：");
		expect(warningLine ?? "", "磁盘回退路径不应出现「空闲超过 5 分钟」").not.toContain("空闲超过 5 分钟");
		expect(text, "磁盘回退路径的状态行仍是未知").toContain("状态：未知（无内存数据）");
	});

	// ================================================================
	// 30. 磁盘回退（活性未知）：结尾 toolResult + 空闲 15 分钟不报「结尾无回音」
	// ================================================================
	it("should not warn about a silent ending on the disk fallback path when the last message is a tool result", async () => {
		// Arrange: 磁盘会话，最后一条是 toolResult；最后活动 15 分钟前（≥ 阈值）。
		writeSessionFileAt(
			agentDir,
			TASK_DISK,
			[
				{ role: "user", content: [{ type: "text", text: "Task: 磁盘静默结尾" }] },
				assistantToolCall("bash", { command: "node --test" }, "tool_1"),
				toolResultWithText("tool_1", "bash", "DISK-TAIL 命令输出", false),
			],
			NOW - 900_000,
			NOW - 1_200_000,
		);

		// Act
		const text = textOf(await peek({ taskId: TASK_DISK }));

		// Assert: 「结尾无回音」同样预设任务该活着；磁盘路径不得报。
		const warningLine = lineStartingWith(text, "警示：");
		expect(warningLine ?? "", "磁盘回退路径不应出现「结尾无回音」").not.toContain("结尾无回音");
	});

	// ================================================================
	// 31. 在跑任务（活性已知）：空闲 10 分钟仍报「空闲超过 5 分钟」
	// ================================================================
	it("should keep warning about idle time when the task is known to be live in the registry", async () => {
		// Arrange: registry 里的在跑任务，最后活动 10 分钟前。
		taskRegistry.set(
			TASK_A,
			makeTask({
				taskId: TASK_A,
				agentName: "engine-legion",
				task: "在跑长空闲 LIVE-IDLE",
				startedAt: NOW - 900_000,
				messages: [
					assistantToolCall("read", { path: "src/a.ts" }, "tool_1"),
					toolResult("tool_1", "read"),
				],
			}),
		);

		// Act
		const text = textOf(await peek({ taskId: TASK_A }));

		// Assert: 活性已知时该警示仍然成立，抑制不能一刀切。
		expect(lineStartingWith(text, "警示："), "在跑任务空闲 10 分钟仍应报「空闲超过 5 分钟」").toContain("空闲超过 5 分钟");
	});

	// ================================================================
	// 32. 磁盘回退仍报行为类警示：只读不写 / 触及 N 个文件
	// ================================================================
	it("should still report behaviour warnings on the disk fallback path", async () => {
		// Arrange: 20 轮 read（路径各不相同 → 触及 20 个文件 > 8，且近 5 次全只读）；
		// 最后活动 30 秒前，使活性类警示不会干扰本例。
		const messages: any[] = [
			{ role: "user", content: [{ type: "text", text: "Task: 磁盘只读排查" }] },
		];
		for (let i = 0; i < 20; i++) {
			messages.push(assistantToolCall("read", { path: `src/disk/file-${i}.ts` }, `tool_${i}`));
			messages.push(toolResult(`tool_${i}`, "read"));
		}
		writeSessionFileAt(agentDir, TASK_DISK, messages, NOW - 30_000, NOW - 1_200_000);

		// Act
		const text = textOf(await peek({ taskId: TASK_DISK }));

		// Assert: 行为类警示与活性无关，磁盘路径照常判定（不是整体静音）。
		const warningLine = lineStartingWith(text, "警示：");
		expect(warningLine, "磁盘回退路径仍应有「警示：」行").toBeDefined();
		expect(warningLine).toContain("只读不写");
		expect(warningLine).toContain("触及 20 个文件");
	});
});
