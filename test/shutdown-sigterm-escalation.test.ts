/**
 * session_shutdown 兜底语义变更 —— 红阶段契约（mocked，fake timers）
 *
 * 旧行为（B2 机制，原始用例见 async-regression.test.ts N1/N2 与
 * async-mode.test.ts 设计决策 7）：session_shutdown 处理器对在飞子进程
 * 立即 proc.kill("SIGKILL")（src/index.ts session_shutdown 处理器的
 * "SIGKILL backstop" 注释块）。后果：子 pi 被瞬间打死，来不及回收它自己
 * 以 detached:true 拉起的 bash 工具进程 → 孙进程成孤儿
 * （真实进程实验 N=5/5 复现）。
 *
 * 新行为契约（本文件钉住 B1/B2/B3/B7 + 第七轮复审新增项）：
 * 1. SIGTERM 先行：shutdown 处理器对在飞任务的存活 proc 走
 *    abort() 既有的 SIGTERM 级联；处理器自身不得直接调用
 *    kill("SIGKILL")（kill 调用序列中不得出现 "SIGKILL"）。
 * 2. 升级辅助进程：处理器拉起一个 detached + stdio:"ignore"
 *    且调用 unref() 的辅助进程（形如 sh -c 'sleep <grace>; kill -9 <pid>'），
 *    由它在宽限期后补 SIGKILL —— 因此 SIGKILL 升级活过父进程退出，
 *    子进程必死，同时子进程拿到了 SIGTERM 的清理窗口去回收孙进程。
 * 3. 不拖住主进程：拉起辅助进程不得 await、不得阻塞 shutdown 处理器
 *    返回；宽限期只允许出现在辅助进程里，不得出现在主进程事件循环里
 *    （fake timers 下处理器 promise 必须不推进时间即 resolve）。
 * 4. 宽限期可注入且解析必须严格：只接受 PI_SUBAGENT_SHUTDOWN_KILL_GRACE_MS
 *    为「严格正整数十进制字面量」（/^[0-9]+$/）且
 *    0 < 值 ≤ MAX_SHUTDOWN_KILL_GRACE_MS（可用上界 86400000ms = 24h）；
 *    其余一切输入——空串、非数字、负数、小数、科学计数法（"1e3"/"1e21"）、
 *    带空白/正号/其它进制前缀、超出安全整数范围（"9007199254740993"）、以及
 *    合法但超出可用上界的值（"86400001"/"5000000000000"）——一律回退默认
 *    宽限期 5000ms（与既有 abort 级联一致）。辅助命令行必须同时包含目标
 *    PID 与宽限期的数值（毫秒值或等值秒数，如 1500 → "1500" 或 "1.5"）。
 *    理由（两次实测缺陷）：(a) 超大值使 String(ms/1000) 产生科学计数法
 *    （sleep 1e+19 立即失败 → 立即补刀，宽限期被完全绕过）；(b) 合法正整数
 *    5000000000000 生成的 sleep 5000000000 超出 macOS sleep 操作数上限
 *    （~4294967296s），同样立即失败 → 立即补刀——同一失败类换了形态。
 *    24h 上界使 sleep 操作数 ≤ 86400s，远离平台上限。因此辅助命令的
 *    sleep 参数永远不得含 e+/e- 形态。
 * 5. 真实进程验证（B4 子进程必死 / B5 不多杀 / B6 无残留 / C 目标已死则
 *    辅助进程早退 / B 极大合法宽限期不绕过）见
 *    test/shutdown-real-process.test.ts。
 * 6. 时序纪律（第七轮复审）：测试一律按 spawn 调用下标/参数定位辅助进程，
 *    不得依赖「辅助进程比子进程晚一个 macrotask 出现」——生产必须可以
 *    同步拉起辅助进程（见 async-regression.test.ts N2 的修正说明）。
 * 7. 最终存活守卫（收尾轮 A 项复审修正为结构级）：补刀前的最终复查必须与
 *    kill -9 <pid> 紧邻——按 ";" 切分后，含 kill -9 <pid> 的片段本身或其
 *    紧邻前一片段必须含 kill -0 <pid>，且脚本中最后一个 kill -0 <pid>
 *    必须位于 kill -9 <pid> 之前、间隔 ≤96 字符。仅做子串存在性检查不够：
 *    循环条件（while kill -0 <pid> && …）里就含同一子串，只删掉最终复查
 *    那一段 871/871 仍全绿（变异 f1 实测）。该守卫缩小 PID 复用误杀窗口。
 *
 * 当前 RED：宽限期非法值回退（契约 4）、kill -0 存活检查存在性此前无覆盖
 *（现补钉）。其余用例随实现落地已 GREEN。
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
	"PI_SUBAGENT_SHUTDOWN_KILL_GRACE_MS",
];

/** Distinct fake pids so escalation-helper commands are attributable. */
let nextFakePid = 400001;

/**
 * Create a fake ChildProcess whose kill() is a no-op.
 * The process stays alive until manually terminated by the test.
 * `pid` and `unref` are present so the shutdown escalation helper can
 * embed the pid in its command line and unref itself.
 */
function createControllableProc() {
	const proc = new EventEmitter() as any;
	proc.stdout = new EventEmitter();
	proc.stderr = new EventEmitter();
	proc.kill = vi.fn(() => true); // no-op: does NOT auto-exit
	proc.exitCode = null;
	proc.signalCode = null;
	proc.pid = nextFakePid++;
	proc.unref = vi.fn();
	return proc;
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

type ExecuteFn = (
	toolCallId: string,
	params: Record<string, unknown>,
	signal: AbortSignal | undefined,
	onUpdate: unknown,
	ctx: unknown,
) => Promise<any>;

/**
 * Helper: race a promise against a real-time timeout to detect blocking.
 * Temporarily switches to real timers to avoid interference with fake timers.
 */
async function raceWithTimeout<T>(
	promise: Promise<T>,
	timeoutMs = 500,
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

describe("session_shutdown 新语义：SIGTERM 先行 + detached 升级辅助进程（红阶段契约）", () => {
	let tmpBase: string;
	let agentDir: string;
	let defaultCwd: string;
	let savedEnv: Record<string, string | undefined>;
	/** Track all spawned procs: [0] is the subagent, later ones are escalation helpers. */
	let allProcs: ReturnType<typeof createControllableProc>[];

	beforeEach(() => {
		vi.useFakeTimers();

		// Clear the module-level taskRegistry to prevent cross-test leakage.
		taskRegistry.clear();

		tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "async-subagent-isolation-shutdown-contract-"));
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

		allProcs = [];
		vi.mocked(spawn).mockImplementation((() => {
			const proc = createControllableProc();
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

	async function dispatchTask(executeTool: ExecuteFn, sessionId: string) {
		const ctx = createMockTuiCtx(defaultCwd);
		const executePromise = executeTool(
			"call-1",
			{ agent: "tester", task: "test task", sessionId },
			undefined,
			undefined,
			ctx,
		);
		const { timedOut } = await raceWithTimeout(executePromise, 200);
		expect(timedOut, "TUI 模式 execute 应立即返回回执").toBe(false);
	}

	function getShutdownHandler(pi: ReturnType<typeof createMockPi>): Function {
		const handlers = pi._eventHandlers.get("session_shutdown");
		expect(handlers).toBeDefined();
		expect(handlers!.length).toBeGreaterThan(0);
		return handlers![0];
	}

	/** 升级辅助进程断言（契约第 2、4 条）。 */
	function expectEscalationHelper(spawnCallIndex: number, targetPid: number, graceMs?: number) {
		const calls = vi.mocked(spawn).mock.calls;
		expect(calls.length, "应额外拉起一个升级辅助进程").toBeGreaterThan(spawnCallIndex);
		const [cmd, args, opts] = calls[spawnCallIndex];
		const cmdline = `${String(cmd)} ${(args as string[]).join(" ")}`;
		expect(cmdline, "辅助命令必须包含目标 PID").toContain(String(targetPid));
		if (graceMs !== undefined) {
			const variants = [String(graceMs), String(graceMs / 1000)];
			expect(
				variants.some((v) => cmdline.includes(v)),
				`辅助命令必须包含宽限期（${variants.join(" 或 ")}），实际: ${cmdline}`,
			).toBe(true);
		}
		expect((opts as any)?.detached, "辅助进程必须 detached").toBe(true);
		expect((opts as any)?.stdio, "辅助进程必须 stdio:ignore").toBe("ignore");
		const helperProc = allProcs[spawnCallIndex];
		expect(helperProc.unref, "辅助进程必须 unref").toHaveBeenCalled();
	}

	// ================================================================
	// B1: SIGTERM 先行 —— 处理器不得直接 SIGKILL
	// ================================================================
	it("should send SIGTERM first and never call kill(\"SIGKILL\") directly from the shutdown handler", async () => {
		const { pi, executeTool } = setupExtension();
		await dispatchTask(executeTool, "019ffdd3-3eb5-733d-b481-a53e5292bd51");

		const proc = allProcs[0];
		expect(taskRegistry.size).toBe(1);

		const shutdownHandler = getShutdownHandler(pi);
		await shutdownHandler({ type: "session_shutdown" });

		const killCalls = proc.kill.mock.calls.map((c: any[]) => c[0]);
		expect(killCalls, "shutdown 必须给子进程 SIGTERM 机会").toContain("SIGTERM");
		expect(killCalls, "旧行为：shutdown 处理器立即 SIGKILL —— 应改为只发 SIGTERM").not.toContain("SIGKILL");
	});

	// ================================================================
	// B2: 升级辅助进程被正确拉起，且主进程不被拖住
	// ================================================================
	it("should synchronously spawn a detached unref'd escalation helper without waiting for the grace period", async () => {
		const { pi, executeTool } = setupExtension();
		await dispatchTask(executeTool, "019ffdd3-3eb5-733d-b481-a53e5292bd52");

		const proc = allProcs[0];
		const spawnCallsBeforeShutdown = vi.mocked(spawn).mock.calls.length;
		expect(spawnCallsBeforeShutdown).toBe(1); // 仅派发时的一次 spawn

		const shutdownHandler = getShutdownHandler(pi);

		// Act：处理器不得等待宽限期（fake timers 不推进时必须 resolve）。
		const handlerPromise = shutdownHandler({ type: "session_shutdown" }) as Promise<void>;
		const { timedOut } = await raceWithTimeout(handlerPromise, 500);
		expect(timedOut, "shutdown 处理器不得 await 宽限期，不得拖住主进程退出").toBe(false);

		// Assert：恰好拉起一个升级辅助进程（契约第 2 条）。
		expect(vi.mocked(spawn).mock.calls.length, "shutdown 应拉起一个升级辅助进程").toBe(
			spawnCallsBeforeShutdown + 1,
		);
		expectEscalationHelper(spawnCallsBeforeShutdown, proc.pid);
	});

	// ================================================================
	// B3: 宽限期可注入（PI_SUBAGENT_SHUTDOWN_KILL_GRACE_MS）
	// ================================================================
	it("should embed the injectable grace period from PI_SUBAGENT_SHUTDOWN_KILL_GRACE_MS in the helper command", async () => {
		process.env.PI_SUBAGENT_SHUTDOWN_KILL_GRACE_MS = "1500";
		const { pi, executeTool } = setupExtension();
		await dispatchTask(executeTool, "019ffdd3-3eb5-733d-b481-a53e5292bd53");

		const proc = allProcs[0];

		const shutdownHandler = getShutdownHandler(pi);
		await shutdownHandler({ type: "session_shutdown" });

		expectEscalationHelper(1, proc.pid, 1500);
	});

	/** 取最近一次 spawn（升级辅助进程）的完整命令行。 */
	function helperCmdline(): string {
		const calls = vi.mocked(spawn).mock.calls;
		expect(calls.length, "shutdown 应拉起一个升级辅助进程").toBeGreaterThan(1);
		const [cmd, args] = calls[calls.length - 1];
		return `${String(cmd)} ${(args as string[]).join(" ")}`;
	}

	// ================================================================
	// 宽限期解析契约（第七轮复审新增，当前 RED）
	// ================================================================
	const INVALID_GRACES = [
		"",                        // 空串
		"abc",                     // 非数字
		"NaN",                     // 非数字
		"0",                       // 非正
		"-1",                      // 负数
		"1e3",                     // 科学计数法（parseInt 会误解析为 1ms）
		"1.9",                     // 小数（parseInt 会误解析为 1ms）
		" 1500",                   // 前导空白
		"+1500",                   // 正号前缀
		"0x10",                    // 其它进制前缀
		"1e21",                    // 科学计数法（parseInt 会误解析为 1ms）
		"9007199254740993",        // MAX_SAFE_INTEGER + 1
		"100000000000000000000000",// 1e23：String(ms/1000) 会产生科学计数法
		"86400001",                // 合法但超出可用上界 24h（收尾轮 B 项）
		"5000000000000",           // 合法 safe integer，但 sleep 5000000000 超 macOS sleep 上限 → 秒死绕过宽限期（收尾轮 B 项实测）
	];
	for (const [index, v] of INVALID_GRACES.entries()) {
		it(`should fall back to the default grace for invalid PI_SUBAGENT_SHUTDOWN_KILL_GRACE_MS=${JSON.stringify(v)}`, async () => {
			process.env.PI_SUBAGENT_SHUTDOWN_KILL_GRACE_MS = v;
			const { pi, executeTool } = setupExtension();
			await dispatchTask(executeTool, `019ffdd3-3eb5-733d-b481-a53e5292bd7${index.toString(16)}`);

			const shutdownHandler = getShutdownHandler(pi);
			await shutdownHandler({ type: "session_shutdown" });

			const cmdline = helperCmdline();
			// 词边界精确匹配（收尾轮修正）："/sleep 5/" 子串会把 "sleep 5000000"（合法值
			// 5000000000000 生成的操作数）误判为已回退默认——与 A 项同类的子串陷阱。
			expect(
				cmdline,
				`非法宽限期 ${JSON.stringify(v)} 必须回退默认 5000ms（sleep 操作数恰为 5），实际: ${cmdline}`,
			).toMatch(/sleep\s+5(?:\.0+)?(?=[\s;])/);
			expect(cmdline, "sleep 参数不得为科学计数法（e+/e-）").not.toMatch(/sleep\s+[^\s;]*[eE][+-]?[0-9]/);
		});
	}

	it("should accept a plain positive integer grace and never emit scientific notation for it", async () => {
		process.env.PI_SUBAGENT_SHUTDOWN_KILL_GRACE_MS = "1500";
		const { pi, executeTool } = setupExtension();
		await dispatchTask(executeTool, "019ffdd3-3eb5-733d-b481-a53e5292bd5e");

		const shutdownHandler = getShutdownHandler(pi);
		await shutdownHandler({ type: "session_shutdown" });

		const cmdline = helperCmdline();
		expect(cmdline.includes("1500") || cmdline.includes("1.5"), `合法宽限期 1500 必须出现在命令中，实际: ${cmdline}`).toBe(true);
		expect(cmdline, "sleep 参数不得为科学计数法（e+/e-）").not.toMatch(/sleep\s+[^\s;]*[eE][+-]?[0-9]/);
	});

	it("should accept the maximum usable grace (24h = 86400000ms) and emit a sleep operand within platform limits", async () => {
		// 收尾轮 B 项：可用上界本身必须被接受，且 sleep 操作数（86400s）远离
		// macOS sleep 上限（~4294967296s）——这是「真的在等」与「立即补刀」的分界。
		process.env.PI_SUBAGENT_SHUTDOWN_KILL_GRACE_MS = "86400000";
		const { pi, executeTool } = setupExtension();
		await dispatchTask(executeTool, "019ffdd3-3eb5-733d-b481-a53e5292bd6a");

		const shutdownHandler = getShutdownHandler(pi);
		await shutdownHandler({ type: "session_shutdown" });

		const cmdline = helperCmdline();
		expect(cmdline.includes("86400000") || cmdline.includes("sleep 86400"), `上界宽限期 24h 必须出现在命令中，实际: ${cmdline}`).toBe(true);
		expect(cmdline, "sleep 参数不得为科学计数法（e+/e-）").not.toMatch(/sleep\s+[^\s;]*[eE][+-]?[0-9]/);
		const sleepOperand = Number(cmdline.match(/sleep\s+([^\s;]+)/)?.[1]);
		expect(Number.isFinite(sleepOperand), `sleep 操作数必须是数值，实际: ${cmdline}`).toBe(true);
		expect(sleepOperand, `sleep 操作数必须 ≤ macOS 上限 4294967296s（否则 sleep 拒绝、立即补刀），实际 ${sleepOperand}`).toBeLessThanOrEqual(4294967296);
	});

	// ================================================================
	// D: 存活检查必须存在（第七轮复审补钉，堵假绿）
	// ================================================================
	it("should include a liveness re-check (kill -0 <pid>) in the helper command", async () => {
		// 复审补钉（收尾轮升级为结构级）：辅助命令的补刀前最终复查必须与
		// kill -9 <pid> 紧邻，缩小 PID 复用误杀窗口（目标已死且 pid 被复用时，
		// 缺了该最终复查就会误杀无辜进程）。此前的子串断言
		// toContain(`kill -0 ${pid}`) 不够：脚本循环条件
		//（while kill -0 <pid> && kill -0 $sleeper）里就含同一子串，只删掉
		// 最终复查那一段，871/871 仍全绿（变异 f1 实测）。故改为结构断言：
		// 含 kill -9 的片段本身或其紧邻前一片段必须含 kill -0，且脚本中最后
		// 一个 kill -0 <pid> 必须位于 kill -9 <pid> 之前、间隔 ≤96 字符
		//（覆盖 "…; then " 的连接开销；循环条件里的 kill -0 距 kill -9 远超此限）。
		const GUARD_MAX_GAP = 96;
		const { pi, executeTool } = setupExtension();
		await dispatchTask(executeTool, "019ffdd3-3eb5-733d-b481-a53e5292bd5f");
		const proc = allProcs[0];

		const shutdownHandler = getShutdownHandler(pi);
		await shutdownHandler({ type: "session_shutdown" });

		const cmdline = helperCmdline();
		const kill9Match = cmdline.match(new RegExp(`kill -9 ${proc.pid}\\b`));
		expect(kill9Match, "辅助脚本必须包含 kill -9 <pid> 补刀").not.toBeNull();
		const kill9Idx = kill9Match!.index!;
		const lastKill0 = cmdline.lastIndexOf(`kill -0 ${proc.pid}`);
		expect(lastKill0, "辅助脚本必须包含 kill -0 <pid> 存活复查").toBeGreaterThanOrEqual(0);
		expect(
			lastKill0,
			"最终存活复查（最后一个 kill -0 <pid>）必须位于 kill -9 <pid> 之前",
		).toBeLessThan(kill9Idx);
		expect(
			kill9Idx - lastKill0,
			`kill -0 复查必须与 kill -9 补刀紧邻（间隔 ≤${GUARD_MAX_GAP} 字符）`,
		).toBeLessThanOrEqual(GUARD_MAX_GAP);
		const segs = cmdline.split(";").map((s) => s.trim());
		const kill9Seg = segs.findIndex((s) => s.includes(`kill -9 ${proc.pid}`));
		expect(kill9Seg, "必须能按 ; 定位 kill -9 片段").toBeGreaterThanOrEqual(0);
		const guardInSameSeg = segs[kill9Seg].includes(`kill -0 ${proc.pid}`);
		const guardInPrevSeg = kill9Seg > 0 && segs[kill9Seg - 1].includes(`kill -0 ${proc.pid}`);
		expect(
			guardInSameSeg || guardInPrevSeg,
			"紧邻 kill -9 <pid> 的片段必须包含 kill -0 <pid> 最终复查（变异 f1：只删最终复查必须变红）",
		).toBe(true);
	});

	// ================================================================
	// B7: 既有 shutdown 语义不回退
	// ================================================================
	it("should keep marking running tasks as killed_on_shutdown and firing their abort controller", async () => {
		const { pi, executeTool } = setupExtension();
		const sessionId = "019ffdd3-3eb5-733d-b481-a53e5292bd54";
		await dispatchTask(executeTool, sessionId);

		const task = taskRegistry.get(sessionId) as AsyncSubagentTask;
		expect(task.status).toBe("running");
		expect(task.abortController.signal.aborted).toBe(false);

		const shutdownHandler = getShutdownHandler(pi);
		await shutdownHandler({ type: "session_shutdown" });

		// 既有语义：状态置 killed_on_shutdown、abort 触发（信封文案区分等
		// 既有断言仍由 async-regression T5 与
		// cancel-shutdown-envelope-differentiation 钉住，此处锁状态机）。
		expect(task.status).toBe("killed_on_shutdown");
		expect(task.abortController.signal.aborted).toBe(true);
	});
});
