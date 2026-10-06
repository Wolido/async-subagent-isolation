/**
 * RED 测试：dispatch 启动校验（工厂时执行，S 存在 dispatch 字段即触发）
 *
 * 规格（本轮 brief 规格 A）：
 * - 硬错误（任一 → fail-closed：不注册 subagent 工具；错误逐条 console.warn，
 *   前缀 [async-subagent-isolation]）：
 *   ① main 行缺失；② 表内名字（键与值，main 键除外）缺对应 .md；
 *   ③ 名字从 main 沿名单不可达；④ 有环/自环；
 *   ⑤ 管事的（键，除 main）tools 含 write/edit（bash 不计）；
 *   ⑥ 形状非法：dispatch 非对象 / 行值非数组 / 数组元素非「非空字符串」。
 * - JSON 解析失败：仅警告 + 按「无 dispatch」容错（不 fail-closed）。
 * - 提示（不拦截）：有 .md 但未进任何名单 → 「不会被派到」，仍正常注册。
 * - fail-closed 时仍注册 /subagent-dispatch 命令。
 * - 正对照：合法配置 → 无错误、正常注册。
 *
 * 当前 src/index.ts 无启动校验（工厂只看 S.main 是否为空决定注册），因此
 * 所有 fail-closed 用例与警告用例必红；正对照与 JSON 容错的注册断言当前即绿。
 */

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import extension from "../src/index.ts";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

vi.mock("@earendil-works/pi-coding-agent", async () => {
	const actual = await vi.importActual("@earendil-works/pi-coding-agent");
	return {
		...actual,
		getAgentDir: vi.fn(),
	};
});

const ENV_KEYS = [
	"PI_SUBAGENT_DEPTH",
	"PI_SUBAGENT_ALLOWED",
	"PI_CURRENT_AGENT_NAME",
	"PI_CAN_DELEGATE",
	"PI_SUBAGENT_HARD_TIMEOUT_MS",
	"PI_SUBAGENT_ACTIVITY_TIMEOUT_MS",
];

const WARN_PREFIX = "[async-subagent-isolation]";

/** before_agent_start 注入事件的最小形状（本文件只关心 systemPrompt）。 */
const BASE_PROMPT = "You are the master agent.\nUse your tools wisely.";

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

/** 收集 console.warn 的全部调用文本（多参数拼接、调用间换行）。 */
function warnText(spy: { mock: { calls: unknown[][] } }): string {
	return spy.mock.calls.map((call) => call.map((v) => String(v)).join(" ")).join("\n");
}

describe("dispatch 启动校验（规格 A）[RED]", () => {
	let tmpBase: string;
	let userAgentDir: string;
	let previousCwd: string;
	let savedEnv: Record<string, string | undefined>;

	beforeEach(() => {
		tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "asi-dispatch-validation-"));
		userAgentDir = path.join(tmpBase, "user-agent");
		fs.mkdirSync(path.join(userAgentDir, "agents"), { recursive: true });
		vi.mocked(getAgentDir).mockReturnValue(userAgentDir);

		previousCwd = process.cwd();
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

	/** 建项目树；dispatch 传 undefined 则不写配置文件。 */
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

	/** 写 agent .md；tools 缺省时省略 tools 行（默认全工具面）。 */
	function writeAgent(dir: string, name: string, tools?: string): void {
		const toolsLine = tools === undefined ? "" : `\ntools: ${tools}`;
		fs.writeFileSync(
			path.join(dir, ".pi", "agents", `${name}.md`),
			`---\nname: ${name}\ndescription: ${name} agent${toolsLine}\n---\nYou are ${name}.\n`,
			"utf-8",
		);
	}

	/** chdir 工厂树 → 装 console.warn 探针 → 执行 factory。 */
	function setupExtension(factoryCwd: string): { pi: MockPi; warnSpy: ReturnType<typeof vi.spyOn> } {
		process.chdir(factoryCwd);
		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
		const pi = createMockPi();
		extension(pi as any);
		return { pi, warnSpy };
	}

	function hasSubagentTool(pi: MockPi): boolean {
		return pi._toolDefs.some((tool) => tool.name === "subagent");
	}

	/** 调 before_agent_start 钩子，返回注入后的 systemPrompt（未注入时即 BASE）。 */
	async function runInjection(pi: MockPi, callCwd: string): Promise<string> {
		const handlers = pi._eventHandlers.get("before_agent_start");
		if (!handlers || handlers.length === 0) {
			throw new Error('No "before_agent_start" handler registered —— 注入行为不可用。');
		}
		const handler = handlers[0] as BeforeAgentStartHandler;
		const result = await handler(
			{ type: "before_agent_start", prompt: "user prompt", systemPrompt: BASE_PROMPT },
			{ cwd: callCwd, hasUI: false },
		);
		return result?.systemPrompt ?? BASE_PROMPT;
	}

	// ================================================================
	// 正对照 + JSON 容错
	// ================================================================

	it("should register normally and warn nothing for a valid dispatch table", () => {
		const tree = makeTree("valid", { main: ["coordinator"], coordinator: ["worker"] });
		writeAgent(tree, "coordinator", "read, bash, subagent");
		writeAgent(tree, "worker", "write"); // 执行者可写：只检查管事的

		const { pi, warnSpy } = setupExtension(tree);

		expect(hasSubagentTool(pi)).toBe(true);
		expect(warnSpy).not.toHaveBeenCalled();
	});

	it("should warn but fall back to legacy when the config file is not valid JSON", () => {
		const tree = makeTree("bad-json");
		fs.writeFileSync(path.join(tree, ".pi", "subagent-isolation.json"), "{ dispatch: ", "utf-8");

		const { pi, warnSpy } = setupExtension(tree);

		// 容错：坏 JSON 只警告，按“无 dispatch 字段”处理 —— 不得 fail-closed。
		expect(warnText(warnSpy)).toContain(WARN_PREFIX);
		expect(hasSubagentTool(pi)).toBe(true);
	});

	it("should warn about an agent that is in no roster but still register normally", () => {
		const tree = makeTree("hint", { main: ["worker"] });
		writeAgent(tree, "worker");
		writeAgent(tree, "orphan");

		const { pi, warnSpy } = setupExtension(tree);

		const text = warnText(warnSpy);
		expect(hasSubagentTool(pi)).toBe(true);
		expect(text).toContain("orphan");
		expect(text).toContain("不会被派到");
	});

	// ================================================================
	// 硬错误 → fail-closed（不注册 subagent 工具）
	// ================================================================

	it("should fail closed and report when the main row is missing", () => {
		const tree = makeTree("no-main", { engineer: ["worker"] });
		writeAgent(tree, "engineer", "read, subagent");
		writeAgent(tree, "worker", "read");

		const { pi, warnSpy } = setupExtension(tree);

		expect(hasSubagentTool(pi)).toBe(false);
		expect(warnText(warnSpy)).toContain("main");
		// 成因专属子串：只断前缀/“main”会在校验整体失效时被“缺 main ⇒ 叶子也
		// 不注册”的等价性遮蔽（变异常绿）；必须命中“缺少 main 行”的报错本身。
		expect(warnText(warnSpy)).toContain('缺少 "main" 行');
		// fail-closed 仍注册 /subagent-dispatch（供排查）。
		expect(pi._commandDefs.has("subagent-dispatch")).toBe(true);
	});

	it("should fail closed and report a roster name with no agent file", () => {
		const tree = makeTree("missing-md", { main: ["ghost"] });

		const { pi, warnSpy } = setupExtension(tree);

		expect(hasSubagentTool(pi)).toBe(false);
		expect(warnText(warnSpy)).toContain("ghost");
	});

	it("should fail closed and report an agent unreachable from main", () => {
		const tree = makeTree("unreachable", { main: ["worker"], middle: ["worker"] });
		writeAgent(tree, "worker", "read");
		writeAgent(tree, "middle", "read, subagent");

		const { pi, warnSpy } = setupExtension(tree);

		expect(hasSubagentTool(pi)).toBe(false);
		expect(warnText(warnSpy)).toContain("middle");
	});

	it("should fail closed and report a cycle", () => {
		const tree = makeTree("cycle", { main: ["a"], a: ["b"], b: ["a"] });
		writeAgent(tree, "a", "read, subagent");
		writeAgent(tree, "b", "read, subagent");

		const { pi, warnSpy } = setupExtension(tree);

		expect(hasSubagentTool(pi)).toBe(false);
		expect(warnText(warnSpy)).toMatch(/环/);
	});

	it("should fail closed and report a self-loop", () => {
		const tree = makeTree("self-loop", { main: ["a"], a: ["a"] });
		writeAgent(tree, "a", "read, subagent");

		const { pi, warnSpy } = setupExtension(tree);

		expect(hasSubagentTool(pi)).toBe(false);
		expect(warnText(warnSpy)).toMatch(/环/);
	});

	it("should fail closed when a manager's tools include write/edit", () => {
		const tree = makeTree("writable-manager", { main: ["writer"], writer: ["worker"] });
		writeAgent(tree, "writer", "read, write, subagent");
		writeAgent(tree, "worker", "read");

		const { pi, warnSpy } = setupExtension(tree);

		expect(hasSubagentTool(pi)).toBe(false);
		const text = warnText(warnSpy);
		expect(text).toContain("writer");
		expect(text).toMatch(/write|edit/);
	});

	// ================================================================
	// ⑦ 管事的 tools 必须声明 subagent（spawn --tools 白名单含扩展工具）
	// ================================================================

	it("should fail closed and report a manager whose tools do not declare subagent (⑦)", () => {
		// 管事的 tools 非空且不含 subagent → spawn 白名单里没有该扩展工具，实际
		// 无法派发；其余校验均通过（md 齐、只读、可达、无环），只命中 ⑦。
		const tree = makeTree("manager-without-subagent", { main: ["manager"], manager: ["worker"] });
		writeAgent(tree, "manager", "read, bash");
		writeAgent(tree, "worker", "read");

		const { pi, warnSpy } = setupExtension(tree);

		expect(hasSubagentTool(pi)).toBe(false);
		const text = warnText(warnSpy);
		expect(text).toContain('"manager"');
		// ⑦ 语义：报的是 tools 未声明 subagent（前缀也含 subagent 字样，故与名字同断）。
		expect(text).toContain("subagent");
		expect(text).toContain("tools");
	});

	it("should not require subagent on non-manager (leaf) agents", () => {
		// ⑦ 只查「键（main 除外）」：作为值的叶子 agent 不声明 subagent 不影响启动。
		const tree = makeTree("leaf-without-subagent", { main: ["leaf"] });
		writeAgent(tree, "leaf", "read");

		const { pi, warnSpy } = setupExtension(tree);

		expect(hasSubagentTool(pi)).toBe(true);
		expect(warnSpy).not.toHaveBeenCalled();
	});

	it("should not double-report ⑦ when a manager's tools are missing (⑤ already covers it)", () => {
		// 边界：tools 缺失/为空 → ⑤ 已判不合格；⑦ 不得重复报。
		// 用“含 manager 的告警条数”判别（不能用 not.toContain("subagent")：
		// 日志前缀 [async-subagent-isolation] 本身就含 subagent 字样）。
		const tree = makeTree("manager-no-tools", { main: ["manager"], manager: ["worker"] });
		writeAgent(tree, "manager"); // 不写 tools 行
		writeAgent(tree, "worker", "read");

		const { pi, warnSpy } = setupExtension(tree);

		expect(hasSubagentTool(pi)).toBe(false);
		const lines = warnSpy.mock.calls.map((call) => call.map((v) => String(v)).join(" "));
		const managerLines = lines.filter((line) => line.includes('"manager"'));
		// 仅 ⑤ 一条；若 ⑦ 也报，会多出一条含 manager 的告警。
		expect(managerLines).toHaveLength(1);
		expect(managerLines[0]).toMatch(/write|edit|tools/);
	});

	// ================================================================
	// 形状非法（规格 ⑥）
	// ================================================================

	it("should fail closed and report a non-object dispatch value", () => {
		const tree = makeTree("shape-non-object", "not-an-object");

		const { pi, warnSpy } = setupExtension(tree);

		expect(hasSubagentTool(pi)).toBe(false);
		expect(warnText(warnSpy)).toContain(WARN_PREFIX);
		// 成因专属子串（变异鉴别）：形状错误被静默丢弃时 roster 为空、注册也为
		// false，仅断前缀会被“叶子等价”遮蔽；必须命中“必须是一个对象”。
		expect(warnText(warnSpy)).toContain("必须是一个对象");
	});

	it("should fail closed and report a row that is not an array", () => {
		const tree = makeTree("shape-row", { main: "tester" });
		writeAgent(tree, "tester", "read");

		const { pi, warnSpy } = setupExtension(tree);

		expect(hasSubagentTool(pi)).toBe(false);
		expect(warnText(warnSpy)).toContain(WARN_PREFIX);
		// 成因专属子串（变异鉴别）：同 shape-non-object，必须命中“必须是数组”。
		expect(warnText(warnSpy)).toContain("必须是数组");
	});

	it("should fail closed and report a non-string roster element", () => {
		const tree = makeTree("shape-element", { main: ["tester", 42] });
		writeAgent(tree, "tester", "read");

		const { pi, warnSpy } = setupExtension(tree);

		expect(hasSubagentTool(pi)).toBe(false);
		expect(warnText(warnSpy)).toContain(WARN_PREFIX);
	});

	// ================================================================
	// 变异鉴别：roster 非空 + 行值形状错误（不得被“叶子等价”遮蔽）
	// ================================================================

	it("should fail closed and report a bad row even when the rest of the roster is non-empty", () => {
		// 若形状错误被静默丢弃，{ main: ["a"], x: 5 } 会退化为 { main: ["a"] }：
		// 工具照常注册——此时仅靠“空名单不注册”无法发现变异。
		const tree = makeTree("shape-row-nonempty", { main: ["a"], x: 5 });
		writeAgent(tree, "a", "read");

		const { pi, warnSpy } = setupExtension(tree);

		expect(hasSubagentTool(pi)).toBe(false);
		expect(warnText(warnSpy)).toContain('dispatch["x"] 的值必须是数组');
	});

	// ================================================================
	// 校验阻断时注入跳过（fail-closed 不止于工具注册面）
	// ================================================================

	it("should skip the roster injection when startup validation is blocked", async () => {
		// 硬错误（ghost 缺 .md）→ 工厂 fail-closed；注入也必须一并跳过（返回 BASE），
		// 不得照常列出名单内容。当前实现照常注入 → 本用例预期 RED。
		const tree = makeTree("blocked-injection", { main: ["a", "ghost"] });
		writeAgent(tree, "a", "read");
		const { pi, warnSpy } = setupExtension(tree);

		// 前置自证：硬错误确实触发（防止 fixture 漂移导致假绿）。
		expect(warnText(warnSpy)).toContain("找不到对应的 agent 文件");

		const prompt = await runInjection(pi, tree);

		expect(prompt).toBe(BASE_PROMPT);
	});

	// ================================================================
	// 多问题逐条报告
	// ================================================================

	it("should report every problem one by one", () => {
		const tree = makeTree("multi-error", { main: ["ghost-a"], "middle-x": ["ghost-b"] });

		const { pi, warnSpy } = setupExtension(tree);

		const text = warnText(warnSpy);
		expect(hasSubagentTool(pi)).toBe(false);
		expect(text).toContain("ghost-a");
		expect(text).toContain("ghost-b");
		// 逐条报告：至少两条独立警告（不合并成一条）。
		expect(warnSpy.mock.calls.length).toBeGreaterThanOrEqual(2);
	});
});
