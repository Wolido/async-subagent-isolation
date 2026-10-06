/**
 * 派发名单制（dispatch）——调用门禁测试
 *
 * 规格（docs/ASI派发配置改造_设计文档_v2.md §4.1）：
 * - 名单非空时，每次调用校验目标 agent 在名单内；不在则返回错误结果，
 *   文本模板：`Cannot dispatch "{target}". Allowed subagents: {allowed.join(", ")}.`（isError=true）。
 * - 在名单内 → 正常放行（同步路径照常 spawn）。
 * - 主进程名单 = `dispatch.main`；子进程名单 = `PI_SUBAGENT_ALLOWED`
 *   （逗号分隔，按名单内出现顺序展示；未设置与空串等效）。
 * - 合并语义：项目级出现 `dispatch` 字段 → 整份替换用户级；沿 cwd 向上找最近配置。
 * - legacy（无 `dispatch` 字段）：原深度门禁逻辑原样生效。
 *
 * 状态：名单门禁已在 src/index.ts 实现（名单内放行/名单外拒绝、S×C 合成交集、
 * 子进程按 PI_SUBAGENT_ALLOWED 行事、legacy 回退）。本文件由 TDD 红阶段转正；
 * 本次仅更新头注释，断言零改动。
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

type ExecuteFn = (
	toolCallId: string,
	params: Record<string, unknown>,
	signal: AbortSignal | undefined,
	onUpdate: unknown,
	ctx: unknown,
) => Promise<any>;

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

/** 立即成功退出的假子进程（同步路径等待它结束）；发一条真实 assistant 消息避免“假成功”失败判定。 */
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

function createMockNonTuiCtx(cwd: string) {
	return { cwd, hasUI: false };
}

describe("dispatch 名单制：调用门禁（已实现；回归锁）", () => {
	let tmpBase: string;
	let userAgentDir: string;
	let projectCwd: string;
	let previousCwd: string;
	let savedEnv: Record<string, string | undefined>;

	beforeEach(() => {
		tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "asi-dispatch-gate-"));
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

	function writeProjectDispatch(dispatch: unknown, dir: string = projectCwd): void {
		fs.mkdirSync(path.join(dir, ".pi"), { recursive: true });
		fs.writeFileSync(
			path.join(dir, ".pi", "subagent-isolation.json"),
			JSON.stringify({ dispatch }),
			"utf-8",
		);
	}

	function writeUserDispatch(dispatch: unknown): void {
		fs.writeFileSync(
			path.join(userAgentDir, "subagent-isolation.json"),
			JSON.stringify({ dispatch }),
			"utf-8",
		);
	}

	function writeAgent(name: string, dir: string = projectCwd): void {
		fs.mkdirSync(path.join(dir, ".pi", "agents"), { recursive: true });
		fs.writeFileSync(
			path.join(dir, ".pi", "agents", `${name}.md`),
			`---\nname: ${name}\ndescription: ${name} agent\ntools: read, subagent\n---\nYou are ${name}.\n`,
			"utf-8",
		);
	}

	/** 用户级 agent .md（校验②“用户级 agent 目录 或 配置树对应 .pi/agents/”的另一侧）。 */
	function writeUserAgent(name: string): void {
		fs.writeFileSync(
			path.join(userAgentDir, "agents", `${name}.md`),
			`---\nname: ${name}\ndescription: ${name} agent\ntools: read, subagent\n---\nYou are ${name}.\n`,
			"utf-8",
		);
	}

	function setupExtension(): MockPi {
		const pi = createMockPi();
		extension(pi as any);
		return pi;
	}

	async function dispatchTo(pi: MockPi, cwd: string, agent: string): Promise<any> {
		const tool = pi._toolDefs.find((t: any) => t.name === "subagent");
		if (!tool || typeof tool.execute !== "function") {
			throw new Error(
				"subagent 工具未注册 —— 名单模式下生效名单为空时不注册；" +
					"expected registerTool({ name: \"subagent\", ... }) in the extension factory.",
			);
		}
		return (tool.execute as ExecuteFn)("call-1", { agent, task: "test task" }, undefined, undefined, createMockNonTuiCtx(cwd));
	}

	/** 模拟「本进程是一个派发名单制父进程 spawn 出来的子 agent」。 */
	function markAsSubagentChild(allowed?: string): void {
		process.env.PI_SUBAGENT_DEPTH = "1";
		process.env.PI_CURRENT_AGENT_NAME = "middle";
		if (allowed === undefined) delete process.env.PI_SUBAGENT_ALLOWED;
		else process.env.PI_SUBAGENT_ALLOWED = allowed;
	}

	// ================================================================
	// 主进程：名单 = dispatch.main
	// ================================================================

	it("should reject with the exact roster text when target is not in the main roster", async () => {
		writeProjectDispatch({ main: ["tester", "coder"], tester: [], coder: [] });
		writeAgent("tester");
		writeAgent("coder");
		writeAgent("reviewer");
		const pi = setupExtension();

		const result = await dispatchTo(pi, projectCwd, "reviewer");

		expect(result.isError).toBe(true);
		expect(result.content[0].text).toBe("Cannot dispatch \"reviewer\". Allowed subagents: tester, coder.");
		expect(vi.mocked(spawn)).not.toHaveBeenCalled();
	});

	it("should list the roster in the configured order inside the rejection text", async () => {
		writeProjectDispatch({ main: ["coder", "tester"], coder: [], tester: [] });
		writeAgent("tester");
		writeAgent("coder");
		writeAgent("reviewer");
		const pi = setupExtension();

		const result = await dispatchTo(pi, projectCwd, "reviewer");

		expect(result.content[0].text).toBe("Cannot dispatch \"reviewer\". Allowed subagents: coder, tester.");
	});

	it("should allow dispatching a target that is in the main roster", async () => {
		writeProjectDispatch({ main: ["tester"], tester: [] });
		writeAgent("tester");
		const pi = setupExtension();

		const result = await dispatchTo(pi, projectCwd, "tester");

		expect(result.isError).not.toBe(true);
		expect(vi.mocked(spawn)).toHaveBeenCalledTimes(1);
	});

	// ================================================================
	// 子进程：名单 = PI_SUBAGENT_ALLOWED（优先于 dispatch.main）
	// ================================================================

	it("should reject targets outside PI_SUBAGENT_ALLOWED inside a subagent (env roster wins over dispatch.main)", async () => {
		// 校验前置：middle 需从 main 可达，否则工厂态校验会硬错误 fail-closed。
		writeProjectDispatch({ main: ["main-child", "middle"], "main-child": [], middle: ["tester"], tester: [] });
		writeAgent("main-child");
		writeAgent("middle");
		writeAgent("tester");
		markAsSubagentChild("tester");
		const pi = setupExtension();

		const result = await dispatchTo(pi, projectCwd, "main-child");

		expect(result.isError).toBe(true);
		expect(result.content[0].text).toBe("Cannot dispatch \"main-child\". Allowed subagents: tester.");
	});

	it("should allow a target listed in PI_SUBAGENT_ALLOWED inside a subagent", async () => {
		// 校验前置：middle 需从 main 可达，否则工厂态校验会硬错误 fail-closed。
		writeProjectDispatch({ main: ["main-child", "middle"], "main-child": [], middle: ["tester"], tester: [] });
		writeAgent("main-child");
		writeAgent("middle");
		writeAgent("tester");
		markAsSubagentChild("tester");
		const pi = setupExtension();

		const result = await dispatchTo(pi, projectCwd, "tester");

		expect(result.isError).not.toBe(true);
		expect(vi.mocked(spawn)).toHaveBeenCalledTimes(1);
	});

	it("should trim names in PI_SUBAGENT_ALLOWED and keep them in order inside the rejection text", async () => {
		writeProjectDispatch({ main: ["middle"], middle: ["tester", "coder"], tester: [], coder: [] });
		writeAgent("middle");
		writeAgent("tester");
		writeAgent("coder");
		writeAgent("other");
		markAsSubagentChild(" tester , coder ");
		const pi = setupExtension();

		const result = await dispatchTo(pi, projectCwd, "other");

		expect(result.content[0].text).toBe("Cannot dispatch \"other\". Allowed subagents: tester, coder.");
	});

	// ================================================================
	// 配置合并：项目级整份替换用户级；向上找最近
	// ================================================================

	it("should let the project dispatch replace the user dispatch as a whole (user-child is no longer allowed)", async () => {
		writeUserDispatch({ main: ["user-child"], "user-child": [] });
		writeProjectDispatch({ main: ["proj-child"], "proj-child": [] });
		writeAgent("user-child");
		writeAgent("proj-child");
		const pi = setupExtension();

		const result = await dispatchTo(pi, projectCwd, "user-child");

		expect(result.isError).toBe(true);
		expect(result.content[0].text).toBe("Cannot dispatch \"user-child\". Allowed subagents: proj-child.");
	});

	it("should keep the user dispatch when the project config exists without a dispatch field", async () => {
		writeUserDispatch({ main: ["user-child"], "user-child": [] });
		fs.writeFileSync(
			path.join(projectCwd, ".pi", "subagent-isolation.json"),
			JSON.stringify({ coder: { model: "proj/model" } }),
			"utf-8",
		);
		writeAgent("user-child");
		writeUserAgent("user-child"); // S 来自用户级配置：两侧都留 .md
		writeAgent("other");
		const pi = setupExtension();

		const result = await dispatchTo(pi, projectCwd, "other");

		expect(result.isError).toBe(true);
		expect(result.content[0].text).toBe("Cannot dispatch \"other\". Allowed subagents: user-child.");
	});

	it("should find the nearest dispatch config walking up from cwd and ignore farther ones", async () => {
		const ancestorDir = path.join(tmpBase, "ancestor");
		const nearProject = path.join(ancestorDir, "near-project");
		const deepCwd = path.join(nearProject, "nested", "deep");
		fs.mkdirSync(deepCwd, { recursive: true });
		writeProjectDispatch({ main: ["ancestor-child"], "ancestor-child": [] }, ancestorDir);
		writeProjectDispatch({ main: ["near-child"], "near-child": [] }, nearProject);
		writeAgent("ancestor-child", ancestorDir);
		writeAgent("near-child", nearProject);
		const pi = setupExtension();

		const result = await dispatchTo(pi, deepCwd, "ancestor-child");

		expect(result.isError).toBe(true);
		expect(result.content[0].text).toBe("Cannot dispatch \"ancestor-child\". Allowed subagents: near-child.");
	});

	// ================================================================
	// legacy 对照：无 dispatch 字段 → 原深度门禁原样生效
	// ================================================================

	it("should keep the legacy depth gate inside a subagent when no dispatch is configured", async () => {
		writeAgent("tester");
		process.env.PI_SUBAGENT_DEPTH = "1";
		process.env.PI_CURRENT_AGENT_NAME = "middle";
		const pi = setupExtension();

		const result = await dispatchTo(pi, projectCwd, "tester");

		expect(result.isError).toBe(true);
		expect(result.content[0].text).toContain("depth limit reached");
		expect(result.content[0].text).toContain("max: 1");
		expect(vi.mocked(spawn)).not.toHaveBeenCalled();
	});

	it("should not apply any list gate at main depth when no dispatch is configured (legacy)", async () => {
		writeAgent("tester");
		const pi = setupExtension();

		const result = await dispatchTo(pi, projectCwd, "tester");

		expect(result.isError).not.toBe(true);
		expect(vi.mocked(spawn)).toHaveBeenCalledTimes(1);
	});
});
