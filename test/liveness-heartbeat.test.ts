/**
 * RED：同步派发期间的活性上报（onUpdate）
 *
 * 背景（用户实测）：主 agent 异步派 engineer，engineer 同步派 tester；engineer
 * 在等 tester 期间自身 stdout 无任何输出，主 agent 的活动超时
 * （PI_SUBAGENT_ACTIVITY_TIMEOUT_MS，默认 600s：直接子进程 stdout/stderr
 * 双双静默满 10 分钟即 SIGKILL）把它误杀。根因：subagent 工具 execute 的
 * onUpdate（pi 工具进度回调）从未被调用；pi 在 --mode json 下会把
 * tool_execution_update 等进度写入 stdout，这是可用的"活性"通道。
 *
 * 需求契约（本文件锁定，RED：当前实现 onUpdate 调用次数为 0）：
 * 1. 同步派发（execute 非 TUI 分支）运行开始立即上报一次；
 * 2. 既有进度触发点（tool_execution_start / tool_execution_update / ...
 *    走既有 100ms 节流）随发一次；
 * 3. 周期性心跳：H = clamp(活动超时/3, 5s, 30s)，静默等待期间每 H 毫秒
 *    至少一次（15s -> H=5s；默认 600s / <=0 -> H=30s，且不早于 H）；
 * 4. 负载是合法的部分结果：非空 text content，含子 agent 名与运行状态
 *    （阶段 / 最近工具 / 已运行时长至少其一）；
 * 5. 运行结束心跳停止（结束后不再有 onUpdate 调用）；
 * 6. onUpdate 缺省时不炸；最终结果不受影响。
 *
 * 不改动：最终结果、退出/杀进程逻辑、async（TUI）路径、legacy；活动超时对
 * 「直接子进程真静默」的判定语义不变。
 */

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn } from "node:child_process";
import extension, { resetProgressManagerForTests } from "../src/index.ts";
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

const AGENT = "tester";
const SESSION_ID = "019ffdd3-3eb5-733d-b481-a53e5292bd01";
const FINAL_TEXT = "子 agent 最终输出";
const ENV_KEYS = [
	"PI_SUBAGENT_DEPTH",
	"PI_SUBAGENT_HARD_TIMEOUT_MS",
	"PI_SUBAGENT_ACTIVITY_TIMEOUT_MS",
	"PI_CURRENT_AGENT_NAME",
	"PI_SUBAGENT_ALLOWED",
];

type OnUpdateFn = (partialResult: any) => void;
type ExecuteFn = (
	toolCallId: string,
	params: Record<string, unknown>,
	signal: AbortSignal | undefined,
	onUpdate: OnUpdateFn | undefined,
	ctx: unknown,
) => Promise<any>;

/**
 * 运行状态信号：阶段 / 最近工具 / 已运行时长至少其一。中英文措辞、phase
 * 词汇、mm:ss 或 Ns 计时均接受，只锁定"负载里有可供监控读取的状态"。
 */
const RUN_STATUS_SIGNAL =
	/tool|thinking|waiting|idle|running|elapsed|phase|status|\d{1,3}:\d{2}|\d+\s*s\b|运行|阶段|状态|工具/i;

/** Create a fake ChildProcess that stays alive until the test ends it. */
function createControllableProc() {
	const proc = new EventEmitter() as any;
	proc.stdout = new EventEmitter();
	proc.stderr = new EventEmitter();
	proc.kill = vi.fn(() => true);
	proc.exitCode = null;
	proc.signalCode = null;
	return proc;
}

/** End the fake process so the awaited run resolves. */
function endProcess(proc: any, exitCode = 0, signal: string | null = null) {
	proc.stdout.emit("end");
	proc.emit("exit", signal ? null : exitCode, signal);
	proc.emit("close", signal ? null : exitCode, signal);
}

/** Concatenated text parts of a partial tool result (empty when shape is wrong). */
function extractText(update: any): string {
	const content = Array.isArray(update?.content) ? update.content : [];
	return content
		.filter((part: any) => part?.type === "text")
		.map((part: any) => (typeof part?.text === "string" ? part.text : ""))
		.join("\n");
}

/** Assert one onUpdate payload is a legal partial result carrying name + status. */
function expectLivenessPayload(update: any): void {
	expect(Array.isArray(update?.content), "负载必须是带 content 数组的部分结果").toBe(true);
	const text = extractText(update);
	expect(text.trim().length, "负载必须含非空 text content").toBeGreaterThan(0);

	const serialized = JSON.stringify(update);
	expect(serialized, "负载必须含子 agent 名").toContain(AGENT);
	expect(serialized, "负载必须含运行状态（阶段/最近工具/已运行时长至少其一）").toMatch(RUN_STATUS_SIGNAL);
}

describe("sync dispatch liveness via onUpdate", () => {
	let tmpBase: string;
	let agentDir: string;
	let defaultCwd: string;
	let savedEnv: Record<string, string | undefined>;
	let procRef: ReturnType<typeof createControllableProc> | null;

	beforeEach(() => {
		vi.useFakeTimers();

		tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "subagent-liveness-test-"));
		agentDir = path.join(tmpBase, "agent-dir");
		defaultCwd = path.join(tmpBase, "default-cwd");
		fs.mkdirSync(path.join(defaultCwd, ".pi", "agents"), { recursive: true });
		fs.mkdirSync(agentDir, { recursive: true });
		vi.mocked(getAgentDir).mockReturnValue(agentDir);

		fs.writeFileSync(
			path.join(defaultCwd, ".pi", "agents", `${AGENT}.md`),
			`---\nname: ${AGENT}\ndescription: Test agent\n---\n`,
			"utf-8",
		);

		procRef = null;
		vi.mocked(spawn).mockImplementation((() => {
			procRef = createControllableProc();
			return procRef;
		}) as any);

		savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
		process.env.PI_SUBAGENT_DEPTH = "0";
		delete process.env.PI_SUBAGENT_HARD_TIMEOUT_MS;
		delete process.env.PI_SUBAGENT_ACTIVITY_TIMEOUT_MS;
	});

	afterEach(() => {
		for (const key of ENV_KEYS) {
			if (savedEnv[key] === undefined) delete process.env[key];
			else process.env[key] = savedEnv[key];
		}
		resetProgressManagerForTests();
		vi.clearAllTimers();
		fs.rmSync(tmpBase, { recursive: true, force: true });
		vi.clearAllMocks();
		vi.useRealTimers();
	});

	/** Register the extension and return the captured subagent.execute. */
	function setupExecute(): ExecuteFn {
		const toolDefs: any[] = [];
		const pi = {
			registerTool: vi.fn((tool: any) => {
				toolDefs.push(tool);
			}),
		};
		extension(pi as any);
		const tool = toolDefs.find((t) => t.name === "subagent");
		if (!tool) throw new Error("subagent tool not registered");
		return tool.execute as ExecuteFn;
	}

	/**
	 * Start a sync dispatch (non-TUI), let spawn settle, return the still-running
	 * promise inside a plain object. The wrapper object matters: an async function
	 * returning a thenable would adopt it and block until the run ends.
	 */
	async function startSyncDispatch(execute: ExecuteFn, onUpdate: OnUpdateFn | undefined) {
		const run = execute(
			"call-1",
			{ agent: AGENT, task: "test task", sessionId: SESSION_ID },
			undefined,
			onUpdate,
			{ cwd: defaultCwd, hasUI: false },
		);
		await vi.advanceTimersByTimeAsync(0);
		expect(procRef, "子进程应已 spawn（同步派发已开始）").not.toBeNull();
		return { run };
	}

	/** Feed one assistant message_end event through the child's stdout. */
	async function emitFinalOutput(text = FINAL_TEXT) {
		procRef!.stdout.emit(
			"data",
			Buffer.from(
				JSON.stringify({
					type: "message_end",
					message: {
						role: "assistant",
						content: [{ type: "text", text }],
						stopReason: "end_turn",
						usage: { input: 10, output: 5, totalTokens: 15 },
					},
				}) + "\n",
			),
		);
		await vi.advanceTimersByTimeAsync(0);
	}

	it("should emit an initial onUpdate as soon as sync dispatch starts", async () => {
		const onUpdate = vi.fn();
		const execute = setupExecute();
		const { run } = await startSyncDispatch(execute, onUpdate);

		// 无需任何子进程事件：运行开始即发一次
		expect(onUpdate.mock.calls.length).toBeGreaterThanOrEqual(1);

		endProcess(procRef!, 0);
		await run;
	});

	it("should forward event-driven child progress through onUpdate after the 100ms throttle", async () => {
		process.env.PI_SUBAGENT_ACTIVITY_TIMEOUT_MS = "15000";
		const onUpdate = vi.fn();
		const execute = setupExecute();
		const { run } = await startSyncDispatch(execute, onUpdate);
		const initialCalls = onUpdate.mock.calls.length;

		// 子进程产生一次既有进度触发点（tool_execution_start）
		procRef!.stdout.emit("data", Buffer.from('{"type":"tool_execution_start","toolName":"bash"}\n'));
		await vi.advanceTimersByTimeAsync(100);

		// 事件驱动的进度随发一次（沿用既有 100ms 节流，轮询到这里已到期）
		expect(onUpdate.mock.calls.length).toBeGreaterThanOrEqual(initialCalls + 1);

		endProcess(procRef!, 0);
		await run;
	});

	it("should coalesce bursty child progress into one onUpdate within the throttle window", async () => {
		process.env.PI_SUBAGENT_ACTIVITY_TIMEOUT_MS = "15000";
		const onUpdate = vi.fn();
		const execute = setupExecute();
		const { run } = await startSyncDispatch(execute, onUpdate);
		const initialCalls = onUpdate.mock.calls.length;

		// 同一节流窗口内三次进度事件 -> 至多一次随发
		const toolUpdates =
			'{"type":"tool_execution_update","toolName":"bash"}\n' +
			'{"type":"tool_execution_update","toolName":"bash"}\n' +
			'{"type":"tool_execution_update","toolName":"bash"}\n';
		procRef!.stdout.emit("data", Buffer.from(toolUpdates));
		await vi.advanceTimersByTimeAsync(100);

		expect(onUpdate.mock.calls.length).toBe(initialCalls + 1);

		endProcess(procRef!, 0);
		await run;
	});

	it("should heartbeat every H when the child stays silent (15s activity timeout -> H=5s)", async () => {
		process.env.PI_SUBAGENT_ACTIVITY_TIMEOUT_MS = "15000";
		const onUpdate = vi.fn();
		const execute = setupExecute();
		const { run } = await startSyncDispatch(execute, onUpdate);
		const initialCalls = onUpdate.mock.calls.length;
		expect(initialCalls).toBeGreaterThanOrEqual(1);

		// 距上次活动不足 H：不要求（也不允许提前）心跳
		await vi.advanceTimersByTimeAsync(4999);
		expect(onUpdate.mock.calls.length).toBe(initialCalls);

		// 静默满 H：至少一次心跳
		await vi.advanceTimersByTimeAsync(1);
		const atFiveSeconds = onUpdate.mock.calls.length;
		expect(atFiveSeconds).toBeGreaterThanOrEqual(initialCalls + 1);

		// 继续静默再满 H：再来一次（周期性）
		await vi.advanceTimersByTimeAsync(5000);
		expect(onUpdate.mock.calls.length).toBeGreaterThanOrEqual(atFiveSeconds + 1);

		endProcess(procRef!, 0);
		await run;
	});

	it("should clamp the heartbeat to 30s under the default activity timeout (600s)", async () => {
		delete process.env.PI_SUBAGENT_ACTIVITY_TIMEOUT_MS;
		const onUpdate = vi.fn();
		const execute = setupExecute();
		const { run } = await startSyncDispatch(execute, onUpdate);
		const initialCalls = onUpdate.mock.calls.length;
		expect(initialCalls).toBeGreaterThanOrEqual(1);

		// 600s/3 = 200s 被上夹到 30s：29.999s 前不得有心跳
		await vi.advanceTimersByTimeAsync(29_999);
		expect(onUpdate.mock.calls.length).toBe(initialCalls);

		await vi.advanceTimersByTimeAsync(1);
		expect(onUpdate.mock.calls.length).toBeGreaterThanOrEqual(initialCalls + 1);

		endProcess(procRef!, 0);
		await run;
	});

	it("should clamp the heartbeat to 30s when the activity timeout is <= 0", async () => {
		process.env.PI_SUBAGENT_ACTIVITY_TIMEOUT_MS = "0";
		const onUpdate = vi.fn();
		const execute = setupExecute();
		const { run } = await startSyncDispatch(execute, onUpdate);
		const initialCalls = onUpdate.mock.calls.length;
		expect(initialCalls).toBeGreaterThanOrEqual(1);

		await vi.advanceTimersByTimeAsync(29_999);
		expect(onUpdate.mock.calls.length).toBe(initialCalls);

		await vi.advanceTimersByTimeAsync(1);
		expect(onUpdate.mock.calls.length).toBeGreaterThanOrEqual(initialCalls + 1);

		endProcess(procRef!, 0);
		await run;
	});

	it("should carry the subagent name and a run-status signal in every liveness payload", async () => {
		process.env.PI_SUBAGENT_ACTIVITY_TIMEOUT_MS = "15000";
		const onUpdate = vi.fn();
		const execute = setupExecute();
		const { run } = await startSyncDispatch(execute, onUpdate);

		procRef!.stdout.emit("data", Buffer.from('{"type":"tool_execution_start","toolName":"bash"}\n'));
		await vi.advanceTimersByTimeAsync(100);
		await vi.advanceTimersByTimeAsync(5000);

		expect(onUpdate.mock.calls.length).toBeGreaterThanOrEqual(3);
		for (const [update] of onUpdate.mock.calls) {
			expectLivenessPayload(update);
		}

		endProcess(procRef!, 0);
		await run;
	});

	it("should stop emitting onUpdate after the run has ended", async () => {
		process.env.PI_SUBAGENT_ACTIVITY_TIMEOUT_MS = "15000";
		const onUpdate = vi.fn();
		const execute = setupExecute();
		const { run } = await startSyncDispatch(execute, onUpdate);
		const initialCalls = onUpdate.mock.calls.length;

		await vi.advanceTimersByTimeAsync(5000);
		// 前置：静默期内确实有心跳，否则「结束后不再调用」是空断言
		expect(onUpdate.mock.calls.length).toBeGreaterThanOrEqual(initialCalls + 1);

		endProcess(procRef!, 0);
		await run;

		const callsAtEnd = onUpdate.mock.calls.length;
		await vi.advanceTimersByTimeAsync(60_000);
		expect(onUpdate.mock.calls.length).toBe(callsAtEnd);
	});

	it("should not crash when onUpdate is omitted", async () => {
		const execute = setupExecute();
		const { run } = await startSyncDispatch(execute, undefined);

		await emitFinalOutput();
		endProcess(procRef!, 0);
		const result = await run;

		expect(result.details?.results?.length).toBe(1);
		expect(result.details.results[0].exitCode).toBe(0);
	});

	it("should return the unchanged final result when onUpdate is provided", async () => {
		const onUpdate = vi.fn();
		const execute = setupExecute();
		const { run } = await startSyncDispatch(execute, onUpdate);

		await emitFinalOutput();
		endProcess(procRef!, 0);
		const result = await run;

		// 对照：挂上 onUpdate 后最终结果仍与无回调时一致（不在本用例断言回调次数）
		expect(result.isError).toBeFalsy();
		expect(result.content[0].text).toBe(`${FINAL_TEXT}\n\n[subagent session: ${SESSION_ID}]`);
		expect(result.details.results[0].exitCode).toBe(0);
	});

	it("should clamp the heartbeat up to 5s when a third of the activity timeout is shorter (6s -> H=5s)", async () => {
		// 鉴别：6s/3 = 2s。无下夹时 H=2s（2000ms 即触发心跳），有下夹时 H=5s。
		process.env.PI_SUBAGENT_ACTIVITY_TIMEOUT_MS = "6000";
		const onUpdate = vi.fn();
		const execute = setupExecute();
		const { run } = await startSyncDispatch(execute, onUpdate);
		const initialCalls = onUpdate.mock.calls.length;
		expect(initialCalls).toBeGreaterThanOrEqual(1);

		// 裸 /3 会在 2000ms 触发；带下夹时 2001ms 不得有任何新增调用
		await vi.advanceTimersByTimeAsync(2001);
		expect(onUpdate.mock.calls.length).toBe(initialCalls);

		// 离 initial 满 4999ms 仍不得有心跳
		await vi.advanceTimersByTimeAsync(4999 - 2001);
		expect(onUpdate.mock.calls.length).toBe(initialCalls);

		// 恰在 5000ms 发出第一次心跳
		await vi.advanceTimersByTimeAsync(1);
		expect(onUpdate.mock.calls.length).toBe(initialCalls + 1);

		// 注意：不再继续推进到 6000ms —— 活动超时本身会在 6s 触发杀进程；
		// 周期性由既有 15s/H=5s 用例覆盖。
		endProcess(procRef!, 0);
		await run;
	});

	it("should keep the run alive and return the unchanged result when onUpdate throws", async () => {
		// 鉴别：去掉 reportLiveness 内的 try/catch 后，初始上报会直接让 execute 拒绝。
		process.env.PI_SUBAGENT_ACTIVITY_TIMEOUT_MS = "15000"; // H=5s，让心跳回调也走过抛错路径
		const onUpdate = vi.fn(() => {
			throw new Error("onUpdate boom");
		});
		const execute = setupExecute();
		const { run } = await startSyncDispatch(execute, onUpdate);

		// 初始上报 + 一次心跳都抛错：必须全部被吞掉（卡死或崩溃都算违反契约）
		await vi.advanceTimersByTimeAsync(5000);

		await emitFinalOutput();
		endProcess(procRef!, 0);
		const result = await run;

		// 最终结果与对照（onUpdate 正常版）完全一致
		expect(result.isError).toBeFalsy();
		expect(result.content[0].text).toBe(`${FINAL_TEXT}\n\n[subagent session: ${SESSION_ID}]`);
		expect(result.details.results[0].exitCode).toBe(0);
		expect(onUpdate.mock.calls.length).toBeGreaterThanOrEqual(2); // 初始 + 心跳均确实调用过
	});
});
