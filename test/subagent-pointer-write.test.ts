/**
 * TDD 红阶段测试：`src/index.ts` 派发路径的 sidecar 指针写入（children.jsonl）。
 *
 * 设计（与 src/web/children.ts、src/web/tree.ts 的指针模型配套）：subagent 工具
 * execute() 在 effectiveSessionId 确定且重复 id 守卫之后，若 currentDepth >= 1，
 * best-effort 调 appendChildPointer(getSubagentSessionDir(parentTaskId), {
 *   childTaskId: effectiveSessionId, agent, task, startedAt: Date.now(),
 *   depth: currentDepth + 1
 * })；整段异常吞掉，写指针失败不得影响派发主流程。主 agent（depth 0）不写。
 * 父 taskId 取 ctx.sessionManager?.getSessionId?.()。
 *
 * 深度锁绕行（为何必须构造名单制 list mode）：legacy 模式下 MAX_SUBAGENT_DEPTH=1，
 * depth >= 1 的派发在 execute 入口就被深度锁拦截，根本走不到派发路径。名单制
 * （配置里存在 dispatch 字段 → listMode）用 effective roster 取代深度锁。
 *
 * list mode 的构造位置（为何写项目级而非用户级配置）：
 *   - 工厂快照 S 在 extension(pi) 注册时以 process.cwd() 解析并做启动校验
 *     （形状/入口/只读人设/环/可达性），任一 blocking 发现即整体不注册工具。
 *     test/setup-env.ts 已把 worker cwd 钉到 os.tmpdir()（祖先链无配置），故
 *     用户级（getAgentDir，被 mock）写配置会让 S=present 并进入校验——
 *     {"main":["tester"],"tester":["tester"]} 的自环正是 blocking 环，工具不会
 *     注册，端到端路径直接断。
 *   - 运行时配置 C = loadDispatchConfig(ctx.cwd)：execute 内解析、无启动校验；
 *     在 defaultCwd/.pi/subagent-isolation.json 放 dispatch 字段 → runtimeDispatch
 *     .present === true → listMode，深度锁被跳过；depth>=1 时名单取
 *     PI_SUBAGENT_ALLOWED（父进程注入，测试显式设置）。
 *   - defaultCwd/.pi/agents/tester.md 保证 discoverAgents(ctx.cwd) 找到目标 agent。
 *
 * 用例：
 *   1. depth 1 派发（TUI 异步路径）成功 → 回执含 Dispatched；
 *      <agentDir>/subagent-sessions/<PARENT_ID>/children.jsonl 恰好 1 条记录，
 *      字段逐一锁定（depth === 2 = currentDepth 1 + 1）。
 *   2. 指针写入失败 → 派发主流程不受影响：回执照常、isError 不为 true、details
 *      结构正常、诱饵文件未被改写；且 appendFileSync 被调用恰好 1 次 —— 钉住
 *      「确实尝试写入」：实现若不写指针，调用次数断言变红（否则「无写入即无异常」
 *      让本用例在未实现时也假绿）。失败注入用 vi.fn 包裹的 appendFileSync 的
 *      mockImplementationOnce（EACCES），父目录位置的普通文件同时覆盖 ENOTDIR 路径。
 *   3. depth 0（主 agent）派发 → 即使父会话目录已存在且 ctx 提供 sessionManager，
 *      也不写 children.jsonl。
 *   4. depth 1 同步（非 TUI，mode "print"）派发 → 同样写指针：嵌套派发实际走
 *      同步路径，锁住「写入块被误移进 TUI 分支」的回归。
 *
 * 约定（沿仓库惯例，同 test/async-mode.test.ts）：globals:false 显式 import；
 * vi.mock 模块级 mock；fixture 用 fs.mkdtempSync(os.tmpdir()) + afterEach 递归
 * 删除；env 保存/恢复；vi.useFakeTimers()（spawn 被 mock，子进程永不退出，
 * execute 的 TUI 异步分支立即返回回执）。
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

// appendFileSync 换成 vi.fn 包裹原实现（默认 call-through）：失败用例可注入
// 一次性异常，并用调用计数钉住「确实尝试了指针写入」；其余调用仍走真实行为。
vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs")>();
	return {
		...actual,
		appendFileSync: vi.fn(actual.appendFileSync),
	};
});

/** 派发方（父任务）taskId：ctx.sessionManager.getSessionId() 的返回值。 */
const PARENT_ID = "019ffdd3-3eb5-733d-b481-a53e5292bd01";
/** 子任务 sessionId（uuid v7 形状，可被 validateSessionId 接受）。 */
const CHILD_ID = "019ffdd3-3eb5-7733-8481-a53e5292bd02";
const CHILD_ID_FAILED_WRITE = "019ffdd3-3eb5-7733-9481-a53e5292bd03";
const CHILD_ID_DEPTH_ZERO = "019ffdd3-3eb5-7733-a481-a53e5292bd04";
const CHILD_ID_SYNC = "019ffdd3-3eb5-7733-b481-a53e5292bd05";

const ENV_KEYS = [
	"PI_SUBAGENT_DEPTH",
	"PI_SUBAGENT_ALLOWED",
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

/** Distinct fake pids so escalation-helper commands are attributable. */
let nextFakePid = 500001;

/**
 * Create a fake ChildProcess whose kill() is a no-op (mirrors
 * test/async-mode.test.ts): the process stays alive until the test ends.
 */
function createControllableProc() {
	const proc = new EventEmitter() as any;
	proc.stdout = new EventEmitter();
	proc.stderr = new EventEmitter();
	proc.kill = vi.fn(() => true);
	proc.exitCode = null;
	proc.signalCode = null;
	proc.pid = nextFakePid++;
	proc.unref = vi.fn();
	return proc;
}

/**
 * Create a fake ChildProcess that exits successfully on next microtask
 * （照抄 test/async-mode.test.ts 的 createSuccessfulProc，供同步派发路径用）。
 */
function createSuccessfulProc() {
	const proc = new EventEmitter() as any;
	proc.stdout = new EventEmitter();
	proc.stderr = new EventEmitter();
	proc.kill = vi.fn();
	proc.exitCode = null;
	proc.signalCode = null;
	proc.pid = nextFakePid++;
	proc.unref = vi.fn();
	queueMicrotask(() => {
		proc.stdout.emit("end");
		proc.emit("exit", 0, null);
		proc.emit("close", 0, null);
	});
	return proc;
}

/**
 * Build a mock pi object that captures all registration calls
 * (照抄 test/async-mode.test.ts 的 createMockPi)。
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

/** TUI 模式 mock ctx，附 sessionManager（指针写入取父 taskId 用）。 */
function createTuiCtx(cwd: string) {
	return {
		cwd,
		hasUI: true,
		mode: "tui" as const,
		ui: {
			setWidget: vi.fn(),
			confirm: vi.fn().mockResolvedValue(true),
		},
		sessionManager: {
			getSessionId: () => PARENT_ID,
		},
	};
}

describe("派发路径的 children.jsonl 指针写入 - TDD 红阶段", () => {
	let tmpBase: string;
	let agentDir: string;
	let defaultCwd: string;
	let savedEnv: Record<string, string | undefined>;

	/** 父任务会话目录（指针文件所在目录）。 */
	function parentSessionDir(): string {
		return path.join(agentDir, "subagent-sessions", PARENT_ID);
	}

	/** 指针文件绝对路径。 */
	function pointerFile(): string {
		return path.join(parentSessionDir(), "children.jsonl");
	}

	beforeEach(() => {
		vi.useFakeTimers();

		// Clear the module-level taskRegistry to prevent cross-test leakage:
		// an in-flight task with the same sessionId would trip the duplicate-id
		// guard (B1) and block the dispatch before the pointer write.
		taskRegistry.clear();

		tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "async-subagent-isolation-pointer-write-"));
		agentDir = path.join(tmpBase, "agent-dir");
		defaultCwd = path.join(tmpBase, "default-cwd");
		fs.mkdirSync(path.join(defaultCwd, ".pi", "agents"), { recursive: true });
		fs.mkdirSync(agentDir, { recursive: true });
		vi.mocked(getAgentDir).mockReturnValue(agentDir);

		// Write a test agent (discovered from ctx.cwd by execute's discoverAgents)
		fs.writeFileSync(
			path.join(defaultCwd, ".pi", "agents", "tester.md"),
			`---\nname: tester\ndescription: Test agent\n---\n`,
			"utf-8",
		);

		// 名单制：项目级 dispatch 配置 → execute 里 runtimeDispatch.present === true
		// → listMode，跳过 legacy 深度锁（工厂快照 S 不受影响：注册时 cwd 是
		// os.tmpdir()，walk-up 找不到任何配置，见文件头说明）。
		fs.writeFileSync(
			path.join(defaultCwd, ".pi", "subagent-isolation.json"),
			JSON.stringify({ dispatch: { main: ["tester"], tester: ["tester"] } }),
			"utf-8",
		);

		vi.mocked(spawn).mockImplementation((() => createControllableProc()) as any);

		savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
		// 子 agent（depth 1）身份：名单制下 PI_SUBAGENT_ALLOWED 是权威名单
		process.env.PI_SUBAGENT_DEPTH = "1";
		process.env.PI_SUBAGENT_ALLOWED = "tester";
	});

	afterEach(() => {
		for (const key of ENV_KEYS) {
			if (savedEnv[key] === undefined) delete process.env[key];
			else process.env[key] = savedEnv[key];
		}
		taskRegistry.clear();
		fs.rmSync(tmpBase, { recursive: true, force: true });
		vi.clearAllMocks();
		// clearAllMocks 不清 mockImplementationOnce 队列：若某用例注入的失败未被
		// 消费（红态），这里显式 reset 恢复 call-through，不污染后续用例。
		vi.mocked(fs.appendFileSync).mockReset();
		vi.useRealTimers();
	});

	function setupExtension() {
		const pi = createMockPi();
		extension(pi as any);
		const tool = pi._toolDefs.find((t: any) => t?.name === "subagent");
		expect(tool, "名单制下 subagent 工具应已注册（fixture 前提，非被测行为）").toBeDefined();
		const executeTool = tool.execute as ExecuteFn;
		return { pi, executeTool };
	}

	// ================================================================
	// 1. depth >= 1 派发成功 → 写入恰一条指针记录
	// ================================================================
	it("should append exactly one child pointer record when a depth-1 dispatch determines the effective session id", async () => {
		// Arrange
		const { executeTool } = setupExtension();
		const ctx = createTuiCtx(defaultCwd);
		// appendChildPointer 是 best-effort：父目录不存在会 ENOENT 被吞掉，
		// 为断言「写入成功」先保证目录存在（生产里由父任务自己的派发创建）
		fs.mkdirSync(parentSessionDir(), { recursive: true });

		// Act: TUI 异步派发，spawn 已 mock，execute 应立即返回回执
		const res = await executeTool(
			"call-1",
			{ agent: "tester", task: "pointer write task", sessionId: CHILD_ID },
			undefined,
			undefined,
			ctx,
		);

		// Assert: 派发主流程正常
		expect(res.isError).not.toBe(true);
		expect(res.content[0].text).toContain("Dispatched");
		expect(res.content[0].text).toContain(CHILD_ID);

		// Assert: 指针文件存在且恰好 1 条记录，字段逐一锁定
		expect(fs.existsSync(pointerFile())).toBe(true);
		const lines = fs
			.readFileSync(pointerFile(), "utf-8")
			.split("\n")
			.filter((line) => line.trim() !== "");
		expect(lines).toHaveLength(1);
		const record = JSON.parse(lines[0]);
		expect(record.childTaskId).toBe(CHILD_ID);
		expect(record.agent).toBe("tester");
		expect(record.task).toBe("pointer write task");
		expect(typeof record.startedAt).toBe("number");
		expect(record.startedAt).toBeGreaterThan(0);
		// depth = currentDepth(1) + 1：子任务在其父视角里的深度
		expect(record.depth).toBe(2);
	});

	// ================================================================
	// 2. 指针写入失败（ENOTDIR）不影响派发主流程
	// ================================================================
	it("should still dispatch successfully when appending the child pointer fails", async () => {
		// Arrange: 父任务会话目录的位置放一个普通文件（真实 ENOTDIR 路径），并把
		// appendFileSync 的第一次调用一次性替换为抛 EACCES —— 无论撞上哪种失败
		// 都必须吞掉。mock 计数同时钉住「确实尝试过写入」：实现若不写指针，
		// 下面的 toHaveBeenCalledTimes(1) 会红（否则「无写入即无异常」假绿）。
		const { executeTool } = setupExtension();
		const ctx = createTuiCtx(defaultCwd);
		fs.mkdirSync(path.join(agentDir, "subagent-sessions"), { recursive: true });
		fs.writeFileSync(parentSessionDir(), "", "utf-8");
		vi.mocked(fs.appendFileSync).mockClear();
		vi.mocked(fs.appendFileSync).mockImplementationOnce(() => {
			throw new Error("EACCES: permission denied, append 'children.jsonl'");
		});

		// Act
		const res = await executeTool(
			"call-1",
			{ agent: "tester", task: "pointer write task", sessionId: CHILD_ID_FAILED_WRITE },
			undefined,
			undefined,
			ctx,
		);

		// Assert: 派发主流程不受影响 —— 回执照常、非错误、details 结构正常
		expect(res.isError).not.toBe(true);
		expect(res.content[0].text).toContain("Dispatched");
		expect(res.content[0].text).toContain(CHILD_ID_FAILED_WRITE);
		expect(res.details.mode).toBe("single");
		expect(res.details.results).toEqual([]);

		// Assert: 确实尝试了指针写入（恰好一次，src 里只有 children.ts 用 appendFileSync）
		expect(fs.appendFileSync).toHaveBeenCalledTimes(1);

		// Assert: 诱饵普通文件内容未被改写（仍为空）
		expect(fs.readFileSync(parentSessionDir(), "utf-8")).toBe("");
	});

	// ================================================================
	// 3. 主 agent（depth 0）派发不写指针
	// ================================================================
	it("should not write a child pointer when the main agent (depth 0) dispatches", async () => {
		// Arrange: 回到主 agent 深度；即使父会话目录已存在（写入若发生会真实
		// 落盘，保证负断言有判别力）且 ctx 提供 sessionManager
		process.env.PI_SUBAGENT_DEPTH = "0";
		delete process.env.PI_SUBAGENT_ALLOWED;
		const { executeTool } = setupExtension();
		const ctx = createTuiCtx(defaultCwd);
		fs.mkdirSync(parentSessionDir(), { recursive: true });

		// Act
		const res = await executeTool(
			"call-1",
			{ agent: "tester", task: "depth zero task", sessionId: CHILD_ID_DEPTH_ZERO },
			undefined,
			undefined,
			ctx,
		);

		// Assert: 派发正常，但不写指针
		expect(res.isError).not.toBe(true);
		expect(res.content[0].text).toContain("Dispatched");
		expect(fs.existsSync(pointerFile())).toBe(false);
	});

	// ================================================================
	// 4. 同步（非 TUI）派发路径同样写指针
	// ================================================================
	it("should append exactly one child pointer record when a depth-1 dispatch runs the sync (non-TUI) path", async () => {
		// Arrange: 非 TUI（mode "print"）→ 同步路径，execute await 子进程退出才
		// resolve；子进程用立即成功退出的假进程（同 test/async-mode.test.ts 的
		// 同步派发用例手法）；名单制 list mode 设置沿用 beforeEach
		vi.mocked(spawn).mockImplementation((() => createSuccessfulProc()) as any);
		const { executeTool } = setupExtension();
		const ctx = {
			cwd: defaultCwd,
			hasUI: false,
			mode: "print" as const,
			sessionManager: {
				getSessionId: () => PARENT_ID,
			},
		};
		fs.mkdirSync(parentSessionDir(), { recursive: true });

		// Act: 同步路径 await 到子进程退出（假进程 exit 0 无输出 → N2 映射为
		// 诊断文本，其内容与本用例的被测行为无关，不断言 isError）
		const res = await executeTool(
			"call-1",
			{ agent: "tester", task: "sync pointer write task", sessionId: CHILD_ID_SYNC },
			undefined,
			undefined,
			ctx,
		);

		// Assert: execute 完整走完同步路径并返回子进程结果（含会话 id，非异步回执）
		expect(res.content[0].text).toContain(CHILD_ID_SYNC);
		expect(res.content[0].text).not.toMatch(/dispatched/i);

		// Assert: 指针已写入且恰好 1 条，字段正确
		expect(fs.existsSync(pointerFile())).toBe(true);
		const lines = fs
			.readFileSync(pointerFile(), "utf-8")
			.split("\n")
			.filter((line) => line.trim() !== "");
		expect(lines).toHaveLength(1);
		const record = JSON.parse(lines[0]);
		expect(record.childTaskId).toBe(CHILD_ID_SYNC);
		expect(record.agent).toBe("tester");
		expect(record.task).toBe("sync pointer write task");
		expect(record.depth).toBe(2);
	});
});
