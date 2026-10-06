/**
 * TDD 红阶段测试：subagent 工具的曝光面（exposure）
 *
 * 需求：pi 的 `codemode` 允许脚本通过 `ctx.executeTool()` 调用其它工具；本扩展的
 * `subagent` 是异步语义（调用即返回回执，真实结果稍后以 `[subagent-result]`
 * 通知到达），脚本里调用会静默拿不到结果。因此注册出的 `subagent` 工具定义必须带
 * `exposure: "model-only"`（pi 语义：仍声明给模型、可被模型直接调用，但永不被脚本
 * 调用），同时不能是 `"hidden"`（对模型也必须可见）。
 *
 * 现状：src/index.ts 的 registerTool 定义里没有 `exposure` 字段，取到的是
 * undefined，故 exposure 用例为红；是否注册与 name 用例为绿（legacy 模式无条件
 * 注册，本用例不写 dispatch 配置以确保工厂必然注册）。
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

/** 与既有测试一致：清空 spawn 注入的身份/名单变量，保证 legacy 基线。 */
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

describe("subagent 工具曝光面：model-only（TDD 红阶段）", () => {
	let tmpBase: string;
	let userAgentDir: string;
	let projectCwd: string;
	let previousCwd: string;
	let savedEnv: Record<string, string | undefined>;

	beforeEach(() => {
		tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "asi-tool-exposure-"));
		userAgentDir = path.join(tmpBase, "user-agent");
		projectCwd = path.join(tmpBase, "project");
		fs.mkdirSync(path.join(userAgentDir, "agents"), { recursive: true });
		fs.mkdirSync(path.join(projectCwd, ".pi", "agents"), { recursive: true });
		vi.mocked(getAgentDir).mockReturnValue(userAgentDir);

		// 工厂时读取 process.cwd()：把 cwd 钉到无 dispatch 配置的临时项目目录，
		// 走 legacy 分支（无条件注册），确保能取到真正被注册的 subagent 定义。
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

	function setupExtension(): MockPi {
		const pi = createMockPi();
		extension(pi as any);
		return pi;
	}

	function getSubagentToolDef(pi: MockPi): any {
		return pi._toolDefs.find((tool) => tool.name === "subagent");
	}

	it("should register the subagent tool under the visible name when no dispatch is configured", () => {
		// Arrange：项目/用户级均无 subagent-isolation.json（legacy 模式）。

		// Act
		const pi = setupExtension();

		// Assert：工具确实注册，名字是模型可见的 "subagent"，且没有被隐藏。
		const tool = getSubagentToolDef(pi);

		expect(tool).toBeDefined();
		expect(tool.name).toBe("subagent");
		expect(tool.exposure).not.toBe("hidden");
	});

	it("should declare exposure model-only when registering the subagent tool", () => {
		// Arrange：项目/用户级均无 subagent-isolation.json（legacy 模式）。

		// Act
		const pi = setupExtension();

		// Assert：精确等于 "model-only" —— 该值同时排除未被脚本调用的 undefined
		// 与对模型隐藏的 "hidden"，不允许出现"字段存在即可"的弱断言。
		const tool = getSubagentToolDef(pi);

		expect(tool.exposure).toBe("model-only");
	});
});
