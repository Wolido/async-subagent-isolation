/**
 * RED 补充测试：主进程名单的「启动快照 S × 运行时 ctx.cwd C」合成规则
 *
 * 背景（审查发现的 fail-open 空隙）：主进程名单此前在「工厂启动快照 S」
 * 与「每次调用 ctx.cwd 的解析结果 C」之间二选一 —— 若 S 有 dispatch 而 C
 * 解析不到 dispatch，execute 会退回 legacy 深度门（depth 0 直接放行），
 * 名单门禁被绕过；系统提示注入同理退回全量注入。
 *
 * 待测新语义：
 * - S = 工厂启动时 process.cwd() 的解析结果；C = 每次调用 ctx.cwd 的解析结果。
 * - S 或 C 任一「存在 dispatch 字段」→ 名单模式（否则 legacy）。
 * - 有效名单 = 各存在来源名单的交集（仅一方存在时即该方名单）。
 * - 调用门禁与系统提示注入都用有效名单；拒绝文案列出有效名单。
 * - 注册判定保持现状（只看 S）：S 存在且 main 非空 → 注册；S 不存在 →
 *   无条件注册（legacy 注册，供 C 生效）。
 *
 * 下列 D1/D2 分歧用例针对修复前实现必红：
 * - D1（S 存在、C 不存在）：当前 C 缺失 → 退回 legacy → depth 0 无门禁放行
 *   intruder；注入退回全量。
 * - D2（S、C 都存在且不同）：当前 C 全量生效 → 交集外的目标照常放行/文案
 *   多出 C-only 目标。
 *
 * 每个用例经真实可观测行为驱动：mock ExtensionAPI（捕获 registerTool /
 * before_agent_start）+ mock spawn + 两棵临时项目树的配置文件；不引用任何
 * 新增导出函数。
 */

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn } from "node:child_process";
import extension from "../src/index.ts";
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
	"PI_SUBAGENT_ALLOWED",
	"PI_CURRENT_AGENT_NAME",
	"PI_CAN_DELEGATE",
	"PI_SUBAGENT_HARD_TIMEOUT_MS",
	"PI_SUBAGENT_ACTIVITY_TIMEOUT_MS",
];

const BASE_PROMPT = "You are the master agent.\nUse your tools wisely.";

type ExecuteFn = (
	toolCallId: string,
	params: Record<string, unknown>,
	signal: AbortSignal | undefined,
	onUpdate: unknown,
	ctx: unknown,
) => Promise<any>;

type BeforeAgentStartHandler = (
	event: unknown,
	ctx: unknown,
) => Promise<{ systemPrompt?: string } | undefined | void>;

function createMockPi() {
	const toolDefs: any[] = [];
	const commandDefs: Map<string, any> = new Map();
	const eventHandlers: Map<string, Function[]> = new Map();

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
		sendMessage: vi.fn(),
		_toolDefs: toolDefs,
		_commandDefs: commandDefs,
		_eventHandlers: eventHandlers,
	};
}

type MockPi = ReturnType<typeof createMockPi>;

/** 立即成功退出的假子进程；发一条真实 assistant 消息避免“假成功”失败判定。 */
function createSuccessfulProc() {
	const proc = new EventEmitter() as any;
	proc.stdout = new EventEmitter();
	proc.stderr = new EventEmitter();
	proc.kill = vi.fn();
	proc.exitCode = null;
	proc.signalCode = null;
	queueMicrotask(() => {
		proc.stdout.emit(
			"data",
			Buffer.from(
				JSON.stringify({
					type: "message_end",
					message: {
						role: "assistant",
						content: [{ type: "text", text: "success output" }],
						stopReason: "end_turn",
						usage: { input: 10, output: 5, totalTokens: 15 },
					},
				}) + "\n",
			),
		);
		proc.stdout.emit("end");
		proc.emit("exit", 0, null);
		proc.emit("close", 0, null);
	});
	return proc;
}

describe("主进程名单合成（S × C）：门禁与注入 [RED 补充]", () => {
	let tmpBase: string;
	let userAgentDir: string;
	let previousCwd: string;
	let savedEnv: Record<string, string | undefined>;

	beforeEach(() => {
		tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "asi-dispatch-snapshot-"));
		userAgentDir = path.join(tmpBase, "user-agent");
		fs.mkdirSync(path.join(userAgentDir, "agents"), { recursive: true });
		vi.mocked(getAgentDir).mockReturnValue(userAgentDir);

		previousCwd = process.cwd();
		savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
		for (const key of ENV_KEYS) delete process.env[key];

		vi.mocked(spawn).mockImplementation((() => createSuccessfulProc()) as any);
	});

	afterEach(() => {
		process.chdir(previousCwd);
		for (const key of ENV_KEYS) {
			if (savedEnv[key] === undefined) delete process.env[key];
			else process.env[key] = savedEnv[key];
		}
		vi.clearAllMocks();
		vi.restoreAllMocks();
		fs.rmSync(tmpBase, { recursive: true, force: true });
	});

	/**
	 * 建一棵临时项目树：始终有 `.pi/agents/`；传了 dispatch 才写配置文件。
	 * 返回树根目录。
	 */
	function makeTree(name: string, dispatch?: unknown): string {
		const dir = path.join(tmpBase, name);
		fs.mkdirSync(path.join(dir, ".pi", "agents"), { recursive: true });
		if (dispatch !== undefined) {
			fs.writeFileSync(
				path.join(dir, ".pi", "subagent-isolation.json"),
				JSON.stringify({ dispatch }),
				"utf-8",
			);
		}
		return dir;
	}

	function writeAgent(dir: string, name: string): void {
		fs.writeFileSync(
			path.join(dir, ".pi", "agents", `${name}.md`),
			`---\nname: ${name}\ndescription: ${name} agent\ntools: read, subagent\n---\nYou are ${name}.\n`,
			"utf-8",
		);
	}

	/** chdir 到工厂树根后执行 factory（S 快照即取在这里）。 */
	function setupExtension(factoryCwd: string): MockPi {
		process.chdir(factoryCwd);
		const pi = createMockPi();
		extension(pi as any);
		return pi;
	}

	async function dispatchTo(pi: MockPi, callCwd: string, agent: string): Promise<any> {
		const tool = pi._toolDefs.find((t: any) => t.name === "subagent");
		if (!tool || typeof tool.execute !== "function") {
			throw new Error(
				"subagent 工具未注册 —— 名单模式注册行为未实现（红阶段）；" +
					"expected registerTool({ name: \"subagent\", ... }) in the extension factory.",
			);
		}
		return (tool.execute as ExecuteFn)(
			"call-1",
			{ agent, task: "test task" },
			undefined,
			undefined,
			{ cwd: callCwd, hasUI: false },
		);
	}

	async function runInjection(pi: MockPi, callCwd: string): Promise<string> {
		const handlers = pi._eventHandlers.get("before_agent_start");
		if (!handlers || handlers.length === 0) {
			throw new Error('No "before_agent_start" handler registered —— 注入行为不可用（红阶段）。');
		}
		const handler = handlers[0] as BeforeAgentStartHandler;
		const result = await handler(
			{ type: "before_agent_start", prompt: "user prompt", systemPrompt: BASE_PROMPT },
			{ cwd: callCwd, hasUI: false },
		);
		return result?.systemPrompt ?? BASE_PROMPT;
	}

	// ================================================================
	// D1：S 存在、C 不存在 → 必须按 S 的名单拦截（当前 fail-open）
	// ================================================================

	it("should reject an intruder when the factory snapshot has dispatch but ctx.cwd does not (D1)", async () => {
		const sTree = makeTree("s-tree", { main: ["allowed-a"], "allowed-a": [] });
		// 校验前置：S 树也要有对应 .md（allowed-a 为表内键，需只读）。
		writeAgent(sTree, "allowed-a");
		const cTree = makeTree("c-tree");
		writeAgent(cTree, "allowed-a");
		writeAgent(cTree, "intruder");
		const pi = setupExtension(sTree);

		const result = await dispatchTo(pi, cTree, "intruder");

		expect(result.isError).toBe(true);
		expect(result.content[0].text).toBe("Cannot dispatch \"intruder\". Allowed subagents: allowed-a.");
		expect(vi.mocked(spawn)).not.toHaveBeenCalled();
	});

	it("should allow a target on the factory snapshot roster when ctx.cwd has no dispatch (D1)", async () => {
		const sTree = makeTree("s-tree", { main: ["allowed-a"], "allowed-a": [] });
		// 校验前置：S 树也要有对应 .md（allowed-a 为表内键，需只读）。
		writeAgent(sTree, "allowed-a");
		const cTree = makeTree("c-tree");
		writeAgent(cTree, "allowed-a");
		writeAgent(cTree, "intruder");
		const pi = setupExtension(sTree);

		const result = await dispatchTo(pi, cTree, "allowed-a");

		expect(result.isError).not.toBe(true);
		expect(vi.mocked(spawn)).toHaveBeenCalledTimes(1);
	});

	// ================================================================
	// D2：S、C 都存在且不同 → 有效名单 = 交集
	// ================================================================

	it("should reject a call-cwd-only target when both snapshots exist (D2, intersection)", async () => {
		const sTree = makeTree("s-tree", { main: ["a", "shared"] });
		// 校验前置：S 表内名字需有对应 .md。
		writeAgent(sTree, "a");
		writeAgent(sTree, "shared");
		const cTree = makeTree("c-tree", { main: ["b", "shared"] });
		writeAgent(cTree, "a");
		writeAgent(cTree, "b");
		writeAgent(cTree, "shared");
		const pi = setupExtension(sTree);

		const result = await dispatchTo(pi, cTree, "b");

		expect(result.isError).toBe(true);
		expect(result.content[0].text).toBe("Cannot dispatch \"b\". Allowed subagents: shared.");
		expect(vi.mocked(spawn)).not.toHaveBeenCalled();
	});

	it("should reject a factory-only target when both snapshots exist (D2, intersection)", async () => {
		const sTree = makeTree("s-tree", { main: ["a", "shared"] });
		// 校验前置：S 表内名字需有对应 .md。
		writeAgent(sTree, "a");
		writeAgent(sTree, "shared");
		const cTree = makeTree("c-tree", { main: ["b", "shared"] });
		writeAgent(cTree, "a");
		writeAgent(cTree, "b");
		writeAgent(cTree, "shared");
		const pi = setupExtension(sTree);

		const result = await dispatchTo(pi, cTree, "a");

		expect(result.isError).toBe(true);
		expect(result.content[0].text).toBe("Cannot dispatch \"a\". Allowed subagents: shared.");
		expect(vi.mocked(spawn)).not.toHaveBeenCalled();
	});

	it("should allow a target present in both snapshots (D2, intersection)", async () => {
		const sTree = makeTree("s-tree", { main: ["a", "shared"] });
		// 校验前置：S 表内名字需有对应 .md。
		writeAgent(sTree, "a");
		writeAgent(sTree, "shared");
		const cTree = makeTree("c-tree", { main: ["b", "shared"] });
		writeAgent(cTree, "a");
		writeAgent(cTree, "b");
		writeAgent(cTree, "shared");
		const pi = setupExtension(sTree);

		const result = await dispatchTo(pi, cTree, "shared");

		expect(result.isError).not.toBe(true);
		expect(vi.mocked(spawn)).toHaveBeenCalledTimes(1);
	});

	// ================================================================
	// 注入：与门禁同规则（D1 场景，当前退回 legacy 全量注入）
	// ================================================================

	it("should inject only the effective roster when the factory snapshot has dispatch but ctx.cwd does not (D1)", async () => {
		const sTree = makeTree("s-tree", { main: ["allowed-a"], "allowed-a": [] });
		// 校验前置：S 树也要有对应 .md（allowed-a 为表内键，需只读）。
		writeAgent(sTree, "allowed-a");
		const cTree = makeTree("c-tree");
		writeAgent(cTree, "allowed-a");
		writeAgent(cTree, "intruder");
		const pi = setupExtension(sTree);

		const prompt = await runInjection(pi, cTree);

		expect(prompt).toContain("allowed-a");
		expect(prompt).not.toContain("intruder");
	});

	// ================================================================
	// 对称守卫：S 不存在、C 存在 → 仍按 C 的名单拦截（新语义“任一存在”）
	// ================================================================

	it("should still enforce the ctx.cwd roster when the factory snapshot has no dispatch (C-only list mode)", async () => {
		const sTree = makeTree("s-tree");
		const cTree = makeTree("c-tree", { main: ["c-allowed"] });
		writeAgent(cTree, "c-allowed");
		writeAgent(cTree, "intruder");
		const pi = setupExtension(sTree);

		const result = await dispatchTo(pi, cTree, "intruder");

		expect(result.isError).toBe(true);
		expect(result.content[0].text).toBe("Cannot dispatch \"intruder\". Allowed subagents: c-allowed.");
		expect(vi.mocked(spawn)).not.toHaveBeenCalled();
	});

	// ================================================================
	// 永久回归：S×C 边界语义（已实证正确，锁定不再回退）
	// ================================================================

	it("should reject every target and inject nothing when the S×C main intersection is empty", async () => {
		const sTree = makeTree("s-tree", { main: ["a"] });
		// 校验前置：S 表内名字需有对应 .md。
		writeAgent(sTree, "a");
		const cTree = makeTree("c-tree", { main: ["b"] });
		writeAgent(cTree, "a");
		writeAgent(cTree, "b");
		const pi = setupExtension(sTree);

		const result = await dispatchTo(pi, cTree, "a");

		expect(result.isError).toBe(true);
		expect(result.content[0].text).toBe("Cannot dispatch \"a\". Allowed subagents: .");
		expect(vi.mocked(spawn)).not.toHaveBeenCalled();

		const prompt = await runInjection(pi, cTree);
		expect(prompt).toBe(BASE_PROMPT);
	});

	it("should order the composed intersection by the factory snapshot S (S order wins)", async () => {
		const sTree = makeTree("s-tree", { main: ["x", "shared"] });
		// 校验前置：S 表内名字需有对应 .md。
		writeAgent(sTree, "x");
		writeAgent(sTree, "shared");
		const cTree = makeTree("c-tree", { main: ["shared", "x"] });
		writeAgent(cTree, "x");
		writeAgent(cTree, "shared");
		writeAgent(cTree, "intruder");
		const pi = setupExtension(sTree);

		const result = await dispatchTo(pi, cTree, "intruder");

		expect(result.isError).toBe(true);
		expect(result.content[0].text).toBe("Cannot dispatch \"intruder\". Allowed subagents: x, shared.");
		expect(vi.mocked(spawn)).not.toHaveBeenCalled();
	});

	it("should not leak a child roster when the S×C rows for that child intersect to empty", async () => {
		const sTree = makeTree("s-tree", { main: ["coder"], coder: ["s1"] });
		// 校验前置：S 表内名字需有对应 .md（coder 为管事的键，需只读）。
		writeAgent(sTree, "coder");
		writeAgent(sTree, "s1");
		const cTree = makeTree("c-tree", { main: ["coder"], coder: ["s2"] });
		writeAgent(cTree, "coder");
		const pi = setupExtension(sTree);

		const result = await dispatchTo(pi, cTree, "coder");

		expect(result.isError).not.toBe(true);
		expect(vi.mocked(spawn)).toHaveBeenCalledTimes(1);
		const env = (vi.mocked(spawn).mock.calls[0][2] as any).env as Record<string, string | undefined>;
		expect("PI_SUBAGENT_ALLOWED" in env).toBe(false);
	});

	it("should register from the factory snapshot alone and reject all when only ctx.cwd has an empty main row", async () => {
		const sTree = makeTree("s-tree");
		const cTree = makeTree("c-tree", { main: [] });
		writeAgent(cTree, "a");
		const pi = setupExtension(sTree);

		const result = await dispatchTo(pi, cTree, "a");

		expect(result.isError).toBe(true);
		expect(result.content[0].text).toBe("Cannot dispatch \"a\". Allowed subagents: .");
		expect(vi.mocked(spawn)).not.toHaveBeenCalled();
	});

	// ================================================================
	// 合成去重：有效名单去重、保序（拒绝文案与 spawn env 不出现重复）
	// ================================================================

	it("should dedupe the effective roster inside the rejection text", async () => {
		const sTree = makeTree("s-tree", { main: ["a", "a"] });
		// 校验前置：S 表内名字需有对应 .md（重复项本身不是硬错误）。
		writeAgent(sTree, "a");
		const cTree = makeTree("c-tree");
		writeAgent(cTree, "a");
		writeAgent(cTree, "x");
		const pi = setupExtension(sTree);

		const result = await dispatchTo(pi, cTree, "x");

		expect(result.isError).toBe(true);
		expect(result.content[0].text).toBe("Cannot dispatch \"x\". Allowed subagents: a.");
		expect(vi.mocked(spawn)).not.toHaveBeenCalled();
	});

	it("should dedupe the child roster before writing PI_SUBAGENT_ALLOWED", async () => {
		const sTree = makeTree("s-tree", { main: ["coder"], coder: ["s1", "s1"] });
		// 校验前置：S 表内名字需有对应 .md（coder 为管事的键，需只读）。
		writeAgent(sTree, "coder");
		writeAgent(sTree, "s1");
		const cTree = makeTree("c-tree", { main: ["coder"], coder: ["s1", "s1"] });
		writeAgent(cTree, "coder");
		const pi = setupExtension(sTree);

		const result = await dispatchTo(pi, cTree, "coder");

		expect(result.isError).not.toBe(true);
		expect(vi.mocked(spawn)).toHaveBeenCalledTimes(1);
		const env = (vi.mocked(spawn).mock.calls[0][2] as any).env as Record<string, string | undefined>;
		expect(env["PI_SUBAGENT_ALLOWED"]).toBe("s1");
	});
});
