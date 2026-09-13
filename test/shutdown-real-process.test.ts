/**
 * session_shutdown 新语义的 REAL-PROCESS 验证（B4 / B5 / B6 / C 早退）
 *
 * 本文件不得 mock node:child_process：子进程与升级辅助进程都是真实
 * OS 进程，用 process.kill(pid, 0) 判活。所有用例 try/finally
 * 兜底，断言失败也不留孤儿/辅助进程。
 *
 * 契约（与 test/shutdown-sigterm-escalation.test.ts 头注释一致）：
 * - shutdown 处理器先对存活 proc 发 SIGTERM（不给立即 SIGKILL）；
 * - 同时拉起 detached + stdio:"ignore" + unref 的辅助进程，命令含目标
 *   PID、宽限期与 kill -0 存活检查，宽限期后补 SIGKILL（SIGKILL 升级
 *   活过父进程退出）；
 * - 宽限期经 PI_SUBAGENT_SHUTDOWN_KILL_GRACE_MS 注入（严格正整数
 *   十进制毫秒，非法值回退默认 5000ms）；
 * - 宽限期过后辅助进程自身必须退出，不得残留（否则每次退出攒一个）；
 * - C（第七轮复审新增）：目标已死时辅助进程必须显著早于宽限期退出——
 *   实测缺陷形态是目标 t=0.01s 已死、辅助进程仍睡满到 t=1.55s（grace=1.5s），
 *   PID 复用窗口被拉满整个宽限期。契约：目标死亡后辅助进程须在 ≤1s 内
 *   退出（约为 1.5s 宽限期的 2/3），而非睡满。
 * - B（收尾轮新增，当前 RED）：合法但极大的宽限期（如 5000000000000ms，
 *   超出 macOS sleep 操作数上限 ~4294967296s）不得绕过宽限期退化为
 *   「立即 SIGKILL」。契约（与 escalation 头注释一致）：实现须定义可用上界
 *   86400000ms（24h），超出回退默认 5000ms；本用例以「忽略 SIGTERM 的目标
 *   在 shutdown 后 1s 内仍未退出」区分「真的在等」与「立即补刀」。
 *
 * 判活/清理卫生（第七轮复审要求）：
 * - 一律只对本用例自己记录/查得的 PID 判定与发信号；
 * - 辅助进程由 src 内部 spawn，测试无法直接拿到 ChildProcess 句柄，
 *   唯一获取途径是一次窄化 ps 查找（命令行同时含本用例目标 pid 与
 *   "kill"）——见 findHelperPid 的残留风险声明；
 * - 不做全局 argv 扫描作为判活依据，不按 argv 模式杀进程（旧版的
 *   psHasOrphanSleep60 / killHelpers 已移除，前后对比见报告）。
 *
 * 用例直接构造真实子进程并注册进 taskRegistry，再调用注册到的
 * session_shutdown 处理器 —— 覆盖与真实派发完全相同的 shutdown 代码路径。
 */

import { describe, expect, it, vi, afterEach } from "vitest";
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import extension, { taskRegistry, type AsyncSubagentTask } from "../src/index.ts";

const SHUTDOWN_GRACE_MS = 800;
const EARLY_EXIT_GRACE_MS = 1500;
const EARLY_EXIT_THRESHOLD_MS = 1000;
const GRACE_ENV_KEY = "PI_SUBAGENT_SHUTDOWN_KILL_GRACE_MS";

/** 真实子进程脚本：忽略 SIGTERM（trap '' 的 SIG_IGN  dispositions 跨 exec 保留）。 */
const IGNORE_TERM_SCRIPT = 'trap "" TERM; exec sleep 60';
/** 真实子进程脚本：正常响应 SIGTERM。 */
const NORMAL_TERM_SCRIPT = "exec sleep 60";

let taskSeq = 0;

function createMockPi() {
	const eventHandlers: Map<string, Function[]> = new Map();
	return {
		registerTool: vi.fn(),
		registerCommand: vi.fn(),
		registerMessageRenderer: vi.fn(),
		on: vi.fn((event: string, handler: Function) => {
			if (!eventHandlers.has(event)) eventHandlers.set(event, []);
			eventHandlers.get(event)!.push(handler);
		}),
		sendMessage: vi.fn(),
		_eventHandlers: eventHandlers,
	};
}

/**
 * 真实拉起一个子进程并以 running 任务身份注册进 taskRegistry。
 * 返回子进程句柄；调用方负责 try/finally 回收。
 */
function spawnRealTask(script: string): { child: ChildProcess; taskId: string; pid: number } {
	const child = spawn("sh", ["-c", script], { detached: true, stdio: "ignore" });
	if (!child.pid) throw new Error("spawn did not yield a pid");
	const taskId = `realproc-${Date.now()}-${taskSeq++}`;
	const task: AsyncSubagentTask = {
		taskId,
		agentName: "real-proc",
		task: "real process shutdown test",
		startedAt: Date.now(),
		abortController: new AbortController(),
		status: "running",
		proc: child,
	};
	taskRegistry.set(taskId, task);
	return { child, taskId, pid: child.pid };
}

/** process.kill(pid, 0) 判活：ESRCH → 已死。只对本用例记录的 PID 使用。 */
function isAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

/** 按 pid 精确查 ps 命令行（键为我们的记录值，非全局模式匹配）。 */
function childCmdline(pid: number): string {
	const out = execFileSync("ps", ["-eo", "pid=,args="], { encoding: "utf-8" });
	const line = out.split("\n").find((l) => l.trim().startsWith(`${pid} `));
	return line?.trim() ?? "";
}

/**
 * 窄化查找升级辅助进程的 pid：命令行同时包含本用例目标 pid 字符串与 "kill"。
 *
 * 这是本 harness 获取辅助进程句柄的唯一途径（辅助进程由 src 内部 spawn，
 * 测试拿不到 ChildProcess 对象）。
 *
 * 残留风险（如实声明，不假装已解决）：判定依赖一次窄化的 ps argv 扫描，
 * 理论上若某个无关进程的命令行恰好同时包含本用例刚启动的目标 pid 数字串
 * 与 "kill" 会误认。该 pid 为本用例自己记录、秒级的进程号，误认概率可忽略；
 * 且判定完成后，后续一律只用记录的 PID + kill(pid,0)，不再扫描。若超时未
 * 找到（例如实现缺陷未拉起辅助进程），返回 null，由用例以明确信息失败。
 */
async function findHelperPid(targetPid: number, timeoutMs = 3000, intervalMs = 50): Promise<number | null> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const out = execFileSync("ps", ["-eo", "pid=,args="], { encoding: "utf-8" });
		const line = out.split("\n").find((l) => l.includes(String(targetPid)) && l.includes("kill"));
		if (line) {
			const pid = Number(line.trim().split(/\s+/)[0]);
			if (Number.isInteger(pid) && pid > 1) return pid;
		}
		await new Promise((r) => setTimeout(r, intervalMs));
	}
	return null;
}

/**
 * 等子进程完成 exec（args 变为 sleep 60、不再有 trap）：
 * 只有 exec 之后 SIG_IGN 的 TERM disposition 才生效，此前发 SIGTERM 会误杀。
 */
async function waitForChildExec(pid: number, timeoutMs = 3000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const cmdline = childCmdline(pid);
		if (cmdline.includes("sleep 60") && !cmdline.includes("trap")) return;
		await new Promise((r) => setTimeout(r, 50));
	}
	throw new Error(`child ${pid} did not exec 'sleep 60' in time (cmdline: ${childCmdline(pid)})`);
}

async function waitFor(cond: () => boolean, timeoutMs: number, intervalMs = 50): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (cond()) return true;
		await new Promise((r) => setTimeout(r, intervalMs));
	}
	return cond();
}

/** 只对本用例查得的 PID 发 SIGKILL；不做任何全局 argv 扫描清理。 */
function killRecordedPid(pid: number | null) {
	if (pid === null) return;
	try {
		process.kill(pid, "SIGKILL");
	} catch {
		/* already gone */
	}
}

describe("session_shutdown 新语义：真实进程验证（B4/B5/B6/C）", () => {
	const savedGrace = process.env[GRACE_ENV_KEY];
	let spawned: { child: ChildProcess; pid: number }[] = [];

	function register(child: ChildProcess, pid: number) {
		spawned.push({ child, pid });
	}

	afterEach(() => {
		// 兜底回收：任何仍存活的本用例子进程一律 SIGKILL（只认记录的 PID）。
		for (const { pid } of spawned) {
			if (isAlive(pid)) {
				try {
					process.kill(pid, "SIGKILL");
				} catch {
					/* already gone */
				}
			}
		}
		spawned = [];
		taskRegistry.clear();
		if (savedGrace === undefined) delete process.env[GRACE_ENV_KEY];
		else process.env[GRACE_ENV_KEY] = savedGrace;
		// 残留风险（如实声明）：若某个用例在记录辅助进程 pid 之前失败，finally 中
		// 无法对该辅助进程发信号；它自身有界（sleep 宽限后经 kill -0 失败自退），
		// 最坏残留一个 ≤ 宽限期（≤1.5s）的辅助进程，不做全局清理（避免误杀）。
	});

	function runShutdown(): Function {
		const pi = createMockPi();
		extension(pi as any);
		const handlers = pi._eventHandlers.get("session_shutdown");
		expect(handlers).toBeDefined();
		expect(handlers!.length).toBeGreaterThan(0);
		return handlers![0];
	}

	// ================================================================
	// B4: 子进程必死 —— SIGTERM 忽略者也在宽限期后被 SIGKILL（真实进程）
	// ================================================================
	it("should SIGKILL a SIGTERM-ignoring child after the grace period (real process, no mock)", async () => {
		process.env[GRACE_ENV_KEY] = String(SHUTDOWN_GRACE_MS);
		const { child, pid } = spawnRealTask(IGNORE_TERM_SCRIPT);
		register(child, pid);
		const exitInfo = new Promise<{ code: number | null; signal: string | null }>((resolve) =>
			child.once("exit", (code, signal) => resolve({ code, signal })),
		);
		let helperPid: number | null = null;
		try {
			// 等 exec 完成（trap 已安装且跨 exec 保留），再验证它确实忽略 SIGTERM ——
			// 这是构造前提：防脚本写错导致「必死」断言假绿。
			await waitForChildExec(pid);
			process.kill(pid, "SIGTERM");
			await new Promise((r) => setTimeout(r, 150));
			expect(isAlive(pid), "precondition: child must ignore SIGTERM").toBe(true);

			// Act：走真实 shutdown 路径（处理器路径同步武装辅助进程，立刻开始
			// 窄化查找，避免「子进程已死 + 辅助进程睡满宽限已退」的竞态漏认）。
			const shutdownHandler = runShutdown();
			await shutdownHandler({ type: "session_shutdown" });
			helperPid = await findHelperPid(pid, 3000);

			// 新语义：shutdown 不立即 SIGKILL —— 忽略 SIGTERM 的进程在宽限期前不得退出。
			// 注意不能用 isAlive 判这点：SIGKILL 后未回收的 zombie 对 kill(pid,0) 仍"活"，
			// 必须看真实的 exit 事件（旧行为此处瞬间 exit，精确指向"仍是立即 SIGKILL"）。
			const earlyExit = await Promise.race([
				exitInfo,
				new Promise<null>((r) => setTimeout(() => r(null), 300)),
			]);
			expect(earlyExit, "旧行为：shutdown 立即 SIGKILL —— 新语义必须先给 SIGTERM 窗口").toBeNull();

			// 宽限期过后：升级辅助进程补的 SIGKILL 必须到位（子进程必死，且确为 SIGKILL）。
			const killed = await Promise.race([
				exitInfo,
				new Promise<null>((r) => setTimeout(() => r(null), SHUTDOWN_GRACE_MS + 5000)),
			]);
			expect(killed, `child ${pid} must be reaped after the escalation helper fires`).not.toBeNull();
			expect(killed!.signal, `child ${pid} must be SIGKILLed by the escalation helper`).toBe("SIGKILL");
		} finally {
			killRecordedPid(isAlive(pid) ? pid : null);
			if (helperPid === null) {
				// 用例在记录前失败：窄化补查一次（仅限本用例目标 pid），找不到则不清理。
				helperPid = await findHelperPid(pid, 500);
			}
			killRecordedPid(helperPid);
			taskRegistry.clear();
		}
		// 收尾证据：本用例相关的两个 PID 均已退出（判定只依据记录的 PID）。
		expect(isAlive(pid), `child ${pid} must be gone`).toBe(false);
	}, 20000);

	// ================================================================
	// B5: 正常响应的子进程不被多杀（真实进程）
	// ================================================================
	it("should let a SIGTERM-responsive child die by SIGTERM without being SIGKILLed (real process)", async () => {
		process.env[GRACE_ENV_KEY] = String(SHUTDOWN_GRACE_MS);
		const { child, pid } = spawnRealTask(NORMAL_TERM_SCRIPT);
		register(child, pid);
		const exitInfo = new Promise<{ code: number | null; signal: string | null }>((resolve) =>
			child.once("exit", (code, signal) => resolve({ code, signal })),
		);
		let helperPid: number | null = null;
		try {
			const shutdownHandler = runShutdown();
			await shutdownHandler({ type: "session_shutdown" });
			// 立刻记录辅助进程 pid（竞态防护：见 B4 说明）。
			helperPid = await findHelperPid(pid, 3000);

			// 被 SIGTERM 结束（而非 SIGKILL）——race 上限 3s，远小于 sleep 60。
			const { signal } = await Promise.race([
				exitInfo,
				new Promise<never>((_r, rej) => setTimeout(() => rej(new Error("child did not exit within 3s")), 3000)),
			]);
			expect(signal, "child must be terminated by SIGTERM, not SIGKILL").toBe("SIGTERM");

			// 辅助进程随后正确退出（等宽限期 + 余量后无残留）。
			// 判活只依据记录到的辅助进程 PID（findHelperPid 的窄化扫描风险见函数注释）。
			expect(helperPid, "escalation helper must have been spawned").not.toBeNull();
			const helperGone = await waitFor(() => !isAlive(helperPid!), SHUTDOWN_GRACE_MS + 5000);
			expect(helperGone, "escalation helper must exit after the grace period").toBe(true);
			expect(isAlive(pid)).toBe(false);
		} finally {
			killRecordedPid(isAlive(pid) ? pid : null);
			killRecordedPid(helperPid);
			taskRegistry.clear();
		}
	}, 20000);

	// ================================================================
	// B6: 不遗留辅助进程 / 不遗留本用例孤儿（真实进程）
	// ================================================================
	it("should leave no escalation helper or orphan behind after the grace period (real process)", async () => {
		process.env[GRACE_ENV_KEY] = String(SHUTDOWN_GRACE_MS);
		const { child, pid } = spawnRealTask(NORMAL_TERM_SCRIPT);
		register(child, pid);
		const exitInfo = new Promise((resolve) => child.once("exit", resolve));
		let helperPid: number | null = null;
		try {
			const shutdownHandler = runShutdown();
			await shutdownHandler({ type: "session_shutdown" });
			// 立刻记录辅助进程 pid（竞态防护：见 B4 说明）。
			helperPid = await findHelperPid(pid, 3000);
			await Promise.race([
				exitInfo,
				new Promise((_r, rej) => setTimeout(() => rej(new Error("child did not exit within 3s")), 3000)),
			]);

			// 宽限期 + 余量过后：辅助进程不得残留（否则每次退出都会攒一个）。
			expect(helperPid, "escalation helper must have been spawned").not.toBeNull();
			const helperGone = await waitFor(() => !isAlive(helperPid!), SHUTDOWN_GRACE_MS + 5000);
			expect(helperGone, `no escalation helper may linger for pid ${pid}`).toBe(true);

			// 孤儿判定（卫生收紧后）：本 harness 的子进程（exec sleep 60）不拉孙进程，
			// 因此「无孤儿」= 本用例记录的全部 PID 均已死亡。旧版的全局 argv 扫描
			// psHasOrphanSleep60() 已移除：匹配行尾 " sleep 60" 既可误伤无关进程（假红）、
			// 也会漏掉带引号/后续参数的形态（假绿）。孙进程回收的端到端证据由独立
			// E2E（真实关窗）承担，不由本文件的 argv 扫描承担。
			expect(isAlive(pid), `orphan check: child ${pid} must be dead`).toBe(false);
		} finally {
			killRecordedPid(isAlive(pid) ? pid : null);
			killRecordedPid(helperPid);
			taskRegistry.clear();
		}

		// 用例结束后再输出一次 ps 快照（仅作原始证据，按本用例 pid 过滤；判活依据仍是记录的 PID）。
		const out = execFileSync("ps", ["-eo", "pid=,args="], { encoding: "utf-8" });
		const lingering = out.split("\n").filter((l) => l.includes(String(pid)));
		console.log(`[B6] ps lines mentioning pid ${pid}:`, lingering);
		expect(lingering, `no process may still reference pid ${pid}`).toEqual([]);
	}, 20000);

	// ================================================================
	// C: 目标已死则辅助进程必须早退（第七轮复审新增，当前 RED）
	// ================================================================
	it("should exit the escalation helper well before the grace period when the target is already dead (real process)", async () => {
		process.env[GRACE_ENV_KEY] = String(EARLY_EXIT_GRACE_MS);
		const { child, pid } = spawnRealTask(NORMAL_TERM_SCRIPT);
		register(child, pid);
		const exitInfo = new Promise((resolve) => child.once("exit", resolve));
		let helperPid: number | null = null;
		const t0 = Date.now();
		try {
			const shutdownHandler = runShutdown();
			await shutdownHandler({ type: "session_shutdown" });
			// 立刻记录辅助进程 pid（竞态防护：见 B4 说明）。
			helperPid = await findHelperPid(pid, 3000);

			// 目标被 SIGTERM 秒杀（≈100ms 内死亡）——构造「目标已死」场景。
			await Promise.race([
				exitInfo,
				new Promise((_r, rej) => setTimeout(() => rej(new Error("child did not exit within 3s")), 3000)),
			]);

			// 记录辅助进程 pid，随后只按该 PID 判活。
			expect(helperPid, "escalation helper must have been spawned").not.toBeNull();

			// 契约：目标已死时辅助进程不得睡满宽限期——须在 ≤1s 内退出
			//（EARLY_EXIT_GRACE_MS=1500ms 的 2/3；实测缺陷形态为睡满 ~1550ms）。
			const helperGone = await waitFor(() => !isAlive(helperPid!), EARLY_EXIT_GRACE_MS + 5000);
			const elapsed = Date.now() - t0;
			expect(helperGone, `escalation helper ${helperPid} must exit at all`).toBe(true);
			expect(
				elapsed,
				`目标已死：辅助进程须在 ≤${EARLY_EXIT_THRESHOLD_MS}ms 内退出（不得睡满 ${EARLY_EXIT_GRACE_MS}ms 宽限期），实际 ${elapsed}ms`,
			).toBeLessThanOrEqual(EARLY_EXIT_THRESHOLD_MS);
		} finally {
			killRecordedPid(isAlive(pid) ? pid : null);
			killRecordedPid(helperPid);
			taskRegistry.clear();
		}
	}, 20000);

	// ================================================================
	// B: 合法但极大的宽限期不得绕过（收尾轮新增，当前 RED）
	// ================================================================
	it("should not bypass the grace period for a huge but legal grace value (real process)", async () => {
		// 实测缺陷：PI_SUBAGENT_SHUTDOWN_KILL_GRACE_MS=5000000000000 是合法正整数、
		// safe integer，但生成的 sleep 5000000000 超出 macOS sleep 上限
		//（~4294967296s）→ sleep 直接拒绝、sleeper 秒死 → 循环立即退出 →
		// kill -9 立即执行 ⇒ 宽限期被完全绕过（t≈0.03s 目标已死），退化为
		//「立即 SIGKILL」——与科学计数法缺陷同属一个失败类。
		// 契约：实现定义可用上界 86400000ms（24h），超出回退默认 5000ms；
		// 回退后辅助进程真的在等 5s，目标（忽略 SIGTERM）在 shutdown 后 1s 内
		// 仍未退出。判据用 exit 事件而非 isAlive（zombie 对 kill(pid,0) 仍"活"）。
		process.env[GRACE_ENV_KEY] = "5000000000000";
		const { child, pid } = spawnRealTask(IGNORE_TERM_SCRIPT);
		register(child, pid);
		const exitInfo = new Promise<{ code: number | null; signal: string | null }>((resolve) =>
			child.once("exit", (code, signal) => resolve({ code, signal })),
		);
		let helperPid: number | null = null;
		try {
			// 等 exec 完成（trap 生效，忽略 SIGTERM）——构造前提。
			await waitForChildExec(pid);

			const shutdownHandler = runShutdown();
			await shutdownHandler({ type: "session_shutdown" });
			// 立刻记录辅助进程 pid（竞态防护：见 B4 说明）。
			helperPid = await findHelperPid(pid, 3000);

			// 核心断言：1s 内不得退出（exit 事件包装为对象——信号退出 code 为 null，
			// 裸 once("exit", resolve) 会 resolve(null) 与超时分支混淆，假绿）。
			// 当前实现下 sleeper 秒死、立即补刀，exit 在 ~0.03s 触发 → 本断言 RED，
			// 精确指向「极大合法值绕过宽限期」。
			const earlyExit = await Promise.race([
				exitInfo,
				new Promise<null>((r) => setTimeout(() => r(null), 1000)),
			]);
			expect(
				earlyExit,
				"极大但合法的宽限期不得绕过：忽略 SIGTERM 的目标在 shutdown 后 1s 内必须仍存活（不得被立即 SIGKILL）",
			).toBeNull();
		} finally {
			killRecordedPid(isAlive(pid) ? pid : null);
			killRecordedPid(helperPid);
			taskRegistry.clear();
		}
	}, 20000);
});
