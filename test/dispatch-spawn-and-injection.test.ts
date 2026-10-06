/**
 * TDD 红阶段测试：派发名单制（dispatch）——spawn 传名单 + 系统提示词注入收窄
 *
 * 规格（docs/ASI派发配置改造_设计文档_v2.md §4.1）：
 * - 名单模式父进程 spawn 子 agent 时，为子进程设置 `PI_SUBAGENT_ALLOWED`：
 *   值 = `dispatch[子 agent]`（逗号分隔，保持配置顺序）；该子 agent 无名单行
 *   （或空行）→ 不设置该变量；legacy 模式同样不设置。
 * - 系统提示词里只注入名单内的 agent：主进程用 `dispatch.main`，
 *   子进程用 `PI_SUBAGENT_ALLOWED`；legacy（无 dispatch 字段）行为不变
 *   （全量注入，深度 >= 1 时不注入）。
 *
 * 当前 src/index.ts 未实现 dispatch，spawn env 里没有 PI_SUBAGENT_ALLOWED，
 * 注入也不收窄，因此下列新行为用例全红，失败原因 = 目标行为未实现。
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

describe("dispatch 名单制：spawn 传名单 + 注入收窄（TDD 红阶段）", () => {
	let tmpBase: string;
	let userAgentDir: string;
	let projectCwd: string;
	let previousCwd: string;
	let savedEnv: Record<string, string | undefined>;

	beforeEach(() => {
		tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "asi-dispatch-spawn-injection-"));
		userAgentDir = path.join(tmpBase, "user-agent");
		projectCwd = path.join(tmpBase, "project");
		fs.mkdirSync(path.join(userAgentDir, "agents"), { recursive: true });
		fs.mkdirSync(path.join(projectCwd, ".pi", "agents"), { recursive: true });
		vi.mocked(getAgentDir).mockReturnValue(userAgentDir);

		previousCwd = process.cwd();
		process.chdir(projectCwd);

		savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
		for (const key of ENV_KEYS) delete process.env[key];

		vi.mocked(spawn).mockReset();
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

	function writeProjectDispatch(dispatch: unknown): void {
		fs.writeFileSync(
			path.join(projectCwd, ".pi", "subagent-isolation.json"),
			JSON.stringify({ dispatch }),
			"utf-8",
		);
	}

	function writeAgent(name: string): void {
		fs.writeFileSync(
			path.join(projectCwd, ".pi", "agents", `${name}.md`),
			`---\nname: ${name}\ndescription: ${name} agent\ntools: read, subagent\n---\nYou are ${name}.\n`,
			"utf-8",
		);
	}

	function setupExtension(): MockPi {
		const pi = createMockPi();
		extension(pi as any);
		return pi;
	}

	async function dispatchTo(pi: MockPi, agent: string): Promise<any> {
		const tool = pi._toolDefs.find((t: any) => t.name === "subagent");
		if (!tool || typeof tool.execute !== "function") {
			throw new Error(
				"subagent 工具未注册 —— 名单模式注册行为未实现（红阶段）；" +
					"expected registerTool({ name: \"subagent\", ... }) in the extension factory.",
			);
		}
		return (tool.execute as ExecuteFn)("call-1", { agent, task: "test task" }, undefined, undefined, { cwd: projectCwd, hasUI: false });
	}

	function spawnEnv(callIndex = 0): Record<string, string | undefined> {
		const calls = vi.mocked(spawn).mock.calls;
		expect(calls.length, "子进程应已 spawn").toBeGreaterThan(callIndex);
		return (calls[callIndex][2] as any).env as Record<string, string | undefined>;
	}

	async function runInjection(pi: MockPi): Promise<string> {
		const handlers = pi._eventHandlers.get("before_agent_start");
		if (!handlers || handlers.length === 0) {
			throw new Error(
				'No "before_agent_start" handler registered —— 注入行为不可用（红阶段）。',
			);
		}
		const handler = handlers[0] as BeforeAgentStartHandler;
		const result = await handler(
			{ type: "before_agent_start", prompt: "user prompt", systemPrompt: BASE_PROMPT },
			{ cwd: projectCwd, hasUI: false },
		);
		return result?.systemPrompt ?? BASE_PROMPT;
	}

	/** 模拟「本进程是一个派发名单制父进程 spawn 出来的子 agent」。 */
	function markAsSubagentChild(allowed?: string): void {
		process.env.PI_SUBAGENT_DEPTH = "1";
		process.env.PI_CURRENT_AGENT_NAME = "middle";
		if (allowed === undefined) delete process.env.PI_SUBAGENT_ALLOWED;
		else process.env.PI_SUBAGENT_ALLOWED = allowed;
	}

	// ================================================================
	// spawn 传名单
	// ================================================================

	it("should set PI_SUBAGENT_ALLOWED to the dispatched child's roster (main → coder ⇒ coder's row)", async () => {
		writeProjectDispatch({ main: ["coder"], coder: ["tester", "coder-lite"] });
		writeAgent("coder");
		writeAgent("tester");
		writeAgent("coder-lite");
		const pi = setupExtension();

		await dispatchTo(pi, "coder");

		expect(spawnEnv()["PI_SUBAGENT_ALLOWED"]).toBe("tester,coder-lite");
	});

	it("should not set PI_SUBAGENT_ALLOWED when the dispatched child has no roster row", async () => {
		writeProjectDispatch({ main: ["leaf"] });
		writeAgent("leaf");
		const pi = setupExtension();

		await dispatchTo(pi, "leaf");

		expect("PI_SUBAGENT_ALLOWED" in spawnEnv()).toBe(false);
	});

	it("should not set PI_SUBAGENT_ALLOWED when the dispatched child's roster row is empty", async () => {
		writeProjectDispatch({ main: ["leaf"], leaf: [] });
		writeAgent("leaf");
		const pi = setupExtension();

		await dispatchTo(pi, "leaf");

		expect("PI_SUBAGENT_ALLOWED" in spawnEnv()).toBe(false);
	});

	it("should not set PI_SUBAGENT_ALLOWED in legacy mode (no dispatch field)", async () => {
		writeAgent("tester");
		const pi = setupExtension();

		await dispatchTo(pi, "tester");

		expect("PI_SUBAGENT_ALLOWED" in spawnEnv()).toBe(false);
	});

	it("should set PI_SUBAGENT_ALLOWED from the middle layer's own dispatch row when it dispatches a child", async () => {
		writeProjectDispatch({ main: ["middle"], middle: ["coder"], coder: ["tester"] });
		writeAgent("middle");
		writeAgent("coder");
		writeAgent("tester");
		markAsSubagentChild("coder");
		const pi = setupExtension();

		await dispatchTo(pi, "coder");

		// 子进程名单取自 coder 自己的名单行（不是 middle 的环境变量值 "coder"）。
		expect(spawnEnv()["PI_SUBAGENT_ALLOWED"]).toBe("tester");
	});

	// ================================================================
	// 系统提示词注入收窄
	// ================================================================

	it("should inject only the main roster agents in list mode (beta is not in dispatch.main)", async () => {
		// 校验前置：beta 若是表内键会因不可达而硬错误 fail-closed；改为不在表内的孤立
		// .md（只触发提示、不拦截），保持“beta 不在 main 名单”的断言语义不变。
		writeProjectDispatch({ main: ["alpha"], alpha: [] });
		writeAgent("alpha");
		writeAgent("beta");
		const pi = setupExtension();

		const prompt = await runInjection(pi);

		expect(prompt).toContain("alpha");
		expect(prompt).not.toContain("beta");
	});

	it("should inject only the PI_SUBAGENT_ALLOWED agents inside a subagent (env roster wins over dispatch.main)", async () => {
		// 校验前置：middle 需从 main 可达（且 middle/alpha 均为表内键、有只读 .md）。
		writeProjectDispatch({ main: ["gamma", "middle"], middle: ["alpha"], alpha: [] });
		writeAgent("alpha");
		writeAgent("gamma");
		writeAgent("middle");
		markAsSubagentChild("alpha");
		const pi = setupExtension();

		const prompt = await runInjection(pi);

		expect(prompt).toContain("alpha");
		expect(prompt).not.toContain("gamma");
	});

	it("should keep injecting every discovered agent when no dispatch is configured (legacy)", async () => {
		writeAgent("alpha");
		writeAgent("beta");
		const pi = setupExtension();

		const prompt = await runInjection(pi);

		expect(prompt).toContain("alpha");
		expect(prompt).toContain("beta");
	});

	it("should inject nothing inside a list-mode leaf subagent (empty roster)", async () => {
		writeProjectDispatch({ main: ["alpha"], alpha: [] });
		writeAgent("alpha");
		markAsSubagentChild();
		const pi = setupExtension();

		const prompt = await runInjection(pi);

		expect(prompt).toBe(BASE_PROMPT);
	});
});
