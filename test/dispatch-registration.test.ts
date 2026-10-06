/**
 * TDD 红阶段测试：派发名单制（dispatch）——工具注册 / 叶子规则
 *
 * 规格（docs/ASI派发配置改造_设计文档_v2.md §4.1、§5）：
 * - `subagent-isolation.json` 新增顶层字段 `dispatch`：{ 管事的: [可派子 agent...] }。
 * - 名单非空 → 注册 `subagent` 工具；名单为空 / 无此行 → 不注册（叶子，满足 I2）。
 * - 主进程名单 = `dispatch.main`；子进程名单来自 `PI_SUBAGENT_ALLOWED`
 *   （逗号分隔；未设置与空串等效）。
 * - 项目级出现 `dispatch` 字段 → 整份替换用户级；无 `dispatch` 字段 → legacy 模式：
 *   原行为零改动（无条件注册，子进程里工具仍注册、由深度门禁在 execute 时拦截）。
 *
 * 当前 src/index.ts 尚未实现 dispatch（JSON 里的 `dispatch` 被
 * loadModelOverridesFile 当作无效 override 忽略），工厂函数无条件注册 subagent
 * 工具，因此「空名单 / 无此行不注册」用例全红，失败原因 = 新行为未实现。
 *
 * 注意：扩展工厂拿不到 ctx.cwd，主进程名单只能在工厂时从 process.cwd() 读配置；
 * 测试用 process.chdir(fixture) 驱动工厂，再用 ctx.cwd=fixture 驱动 execute。
 */

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import extension from "../src/index.ts";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

// 仅 mock getAgentDir（用户级配置目录模块边界）；其余 API 保持真实。
vi.mock("@earendil-works/pi-coding-agent", async () => {
	const actual = await vi.importActual("@earendil-works/pi-coding-agent");
	return {
		...actual,
		getAgentDir: vi.fn(),
	};
});

/** 与 spawn 注入身份/名单相关的变量：beforeEach 清空、afterEach 还原。 */
const ENV_KEYS = [
	"PI_SUBAGENT_DEPTH",
	"PI_SUBAGENT_ALLOWED",
	"PI_CURRENT_AGENT_NAME",
	"PI_CAN_DELEGATE",
	"PI_SUBAGENT_HARD_TIMEOUT_MS",
	"PI_SUBAGENT_ACTIVITY_TIMEOUT_MS",
];

/** 与既有测试一致的 mock pi：捕获 registerTool 的 tool 定义。 */
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
		// Test helpers
		_toolDefs: toolDefs,
		_commandDefs: commandDefs,
		_eventHandlers: eventHandlers,
	};
}

type MockPi = ReturnType<typeof createMockPi>;

describe("dispatch 名单制：注册 / 叶子规则（TDD 红阶段）", () => {
	let tmpBase: string;
	let userAgentDir: string;
	let projectCwd: string;
	let previousCwd: string;
	let savedEnv: Record<string, string | undefined>;

	beforeEach(() => {
		tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "asi-dispatch-registration-"));
		userAgentDir = path.join(tmpBase, "user-agent");
		projectCwd = path.join(tmpBase, "project");
		fs.mkdirSync(path.join(userAgentDir, "agents"), { recursive: true });
		fs.mkdirSync(path.join(projectCwd, ".pi", "agents"), { recursive: true });
		vi.mocked(getAgentDir).mockReturnValue(userAgentDir);

		// 工厂时读取 process.cwd() 的主进程名单：把 cwd 钉到 fixture。
		previousCwd = process.cwd();
		process.chdir(projectCwd);

		savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
		for (const key of ENV_KEYS) delete process.env[key];
	});

	afterEach(() => {
		process.chdir(previousCwd);
		for (const key of ENV_KEYS) {
			if (savedEnv[key] === undefined) delete process.env[key];
			else process.env[key] = savedEnv[key];
		}
		vi.restoreAllMocks();
		fs.rmSync(tmpBase, { recursive: true, force: true });
	});

	/** 项目级配置：<cwd>/.pi/subagent-isolation.json */
	function writeProjectDispatch(dispatch: unknown): void {
		fs.writeFileSync(
			path.join(projectCwd, ".pi", "subagent-isolation.json"),
			JSON.stringify({ dispatch }),
			"utf-8",
		);
	}

	/** 用户级配置：<getAgentDir()>/subagent-isolation.json */
	function writeUserDispatch(dispatch: unknown): void {
		fs.writeFileSync(
			path.join(userAgentDir, "subagent-isolation.json"),
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

	function hasSubagentTool(pi: MockPi): boolean {
		return pi._toolDefs.some((tool) => tool.name === "subagent");
	}

	/** 模拟「本进程是一个派发名单制父进程 spawn 出来的子 agent」。 */
	function markAsSubagentChildren(): void {
		process.env.PI_SUBAGENT_DEPTH = "1";
		process.env.PI_CURRENT_AGENT_NAME = "middle";
	}

	// ================================================================
	// 主进程：名单来自 dispatch.main
	// ================================================================

	it("should register the subagent tool when dispatch.main lists at least one agent", () => {
		writeProjectDispatch({ main: ["tester"] });
		writeAgent("tester");

		const pi = setupExtension();

		expect(hasSubagentTool(pi)).toBe(true);
	});

	it("should not register the subagent tool when dispatch.main is an empty list (leaf)", () => {
		// 校验前置：空 main 行本身是合法表（无其他名字），叶子语义不被硬错误遮蔽。
		writeProjectDispatch({ main: [] });
		writeAgent("tester");

		const pi = setupExtension();

		expect(hasSubagentTool(pi)).toBe(false);
	});

	it("should not register the subagent tool when dispatch has no main row", () => {
		writeProjectDispatch({ engineer: ["tester"] });
		writeAgent("tester");

		const pi = setupExtension();

		expect(hasSubagentTool(pi)).toBe(false);
	});

	it("should let the project dispatch replace the user dispatch as a whole (project main empty ⇒ leaf)", () => {
		writeUserDispatch({ main: ["user-child"], "user-child": [] });
		// 校验前置：项目 main 为空时表内不能有不可达键，否则会因硬错误 fail-closed
		// 而非叶子语义不注册。
		writeProjectDispatch({ main: [] });
		writeAgent("user-child");

		const pi = setupExtension();

		// 项目级出现 dispatch 字段 → 整份替换用户级；替换后 main 为空 → 叶子。
		expect(hasSubagentTool(pi)).toBe(false);
	});

	// ================================================================
	// 子进程：名单来自 PI_SUBAGENT_ALLOWED
	// ================================================================

	it("should not register the subagent tool inside a subagent when PI_SUBAGENT_ALLOWED is an empty string", () => {
		writeProjectDispatch({ main: ["middle"], middle: [] });
		writeAgent("middle");
		markAsSubagentChildren();
		process.env.PI_SUBAGENT_ALLOWED = "";

		const pi = setupExtension();

		// 空名单 = 叶子：即使 dispatch 配置存在也不注册（满足 I2）。
		expect(hasSubagentTool(pi)).toBe(false);
	});

	it("should not register the subagent tool inside a subagent when PI_SUBAGENT_ALLOWED is unset (equivalent to empty)", () => {
		writeProjectDispatch({ main: ["middle"], middle: [] });
		writeAgent("middle");
		markAsSubagentChildren();
		// PI_SUBAGENT_ALLOWED 未设置 —— 与空串等效，仍是空名单。

		const pi = setupExtension();

		expect(hasSubagentTool(pi)).toBe(false);
	});

	it("should register the subagent tool inside a subagent when PI_SUBAGENT_ALLOWED lists at least one agent", () => {
		writeProjectDispatch({ main: ["middle"], middle: ["tester"], tester: [] });
		// 校验前置：middle 与 tester 都是表内名字，必须都有对应 .md（且管事的只读）。
		writeAgent("middle");
		writeAgent("tester");
		markAsSubagentChildren();
		process.env.PI_SUBAGENT_ALLOWED = "tester";

		const pi = setupExtension();

		expect(hasSubagentTool(pi)).toBe(true);
	});

	// ================================================================
	// legacy 对照：无 dispatch 字段 → 原行为零改动
	// ================================================================

	it("should keep registering the subagent tool when no dispatch is configured (legacy)", () => {
		writeAgent("tester");

		const pi = setupExtension();

		expect(hasSubagentTool(pi)).toBe(true);
	});

	it("should keep registering the subagent tool inside a subagent when no dispatch is configured (legacy)", () => {
		writeAgent("tester");
		markAsSubagentChildren();

		const pi = setupExtension();

		// legacy：工具仍注册，深度门禁在 execute 时拦截（与改造前一致）。
		expect(hasSubagentTool(pi)).toBe(true);
	});
});
