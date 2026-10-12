/**
 * RED 测试：/subagent-dispatch 命令（新输出规格）
 *
 * 规格（本轮 brief，逐条对应）：
 * ① 首行固定 `Dispatch roster (from subagent-isolation.json):`，空一行后
 *    每个管事一行 `<manager> → <合成名单>`（合成 = 既有 S×C 交集规则
 *    composeEffectiveRoster；manager = S 与 C roster 键的并集；合成为空时
 *    打印 `<manager> → (none)`）；
 * ② 完全没有反查段——输出不得包含 `反查` 或 `←`；
 * ③ 校验发现按 message 去重：S（工厂 cwd）与 C（命令 cwd）两组 message
 *    完全相同 → 每条只打一次且无前缀；不同 → 只在一侧出现的加
 *    `[S <factoryCwd>] ` / `[C <callCwd>] ` 前缀，两侧都有的无前缀打一次；
 * ④ 无发现 → 逐字 `Validation findings: none`；有发现 → 逐字
 *    `Validation findings:` 后跟发现行；
 * ⑤ 新增「未生效」diff 段：仅当非空时打印，位于发现段之后、前置一空行，
 *    标题逐字 `Not yet active (in subagent-isolation.json, needs /reload):`，
 *    对命令 cwd 文件 roster 的每个 manager 键算
 *    `diff = fileRow \ composeEffectiveRoster(S, C, manager)`（保文件序），
 *    非空则打 `<manager> → <名单>`；整行未生效时 diff 即整行；
 * ⑥ legacy（S 与 C 都无 `dispatch` 字段）→ 逐字单行提示；
 * ⑦ 命令 description 逐字
 *    `Show the effective dispatch roster from subagent-isolation.json with validation findings`。
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

describe("/subagent-dispatch 命令（新输出规格）[RED]", () => {
	let tmpBase: string;
	let userAgentDir: string;
	let previousCwd: string;
	let savedEnv: Record<string, string | undefined>;

	beforeEach(() => {
		tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "asi-dispatch-command-"));
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

	function writeAgent(dir: string, name: string, tools = "read, subagent"): void {
		fs.writeFileSync(
			path.join(dir, ".pi", "agents", `${name}.md`),
			`---\nname: ${name}\ndescription: ${name} agent\ntools: ${tools}\n---\nYou are ${name}.\n`,
			"utf-8",
		);
	}

	/**
	 * chdir 工厂树 → 装 console.warn 采集器（工厂期警告不入命令输出）→ 执行 factory。
	 */
	function setupExtension(factoryCwd: string): { pi: MockPi; warnCalls: string[] } {
		process.chdir(factoryCwd);
		const warnCalls: string[] = [];
		vi.spyOn(console, "warn").mockImplementation((...args: unknown[]) => {
			warnCalls.push(args.map(String).join(" "));
		});
		const pi = createMockPi();
		extension(pi as any);
		return { pi, warnCalls };
	}

	/**
	 * 调命令并拼接所有输出渠道（ui.notify / console.log / console.info /
	 * 命令执行期间新产生的 console.warn），按子串断言。
	 */
	async function runDispatchCommand(pi: MockPi, callCwd: string, warnCalls: string[]): Promise<string> {
		const command = pi._commandDefs.get("subagent-dispatch");
		if (!command) {
			throw new Error(
				'subagent-dispatch 命令未注册 —— 功能未实现（红阶段）；expected pi.registerCommand?.("subagent-dispatch", ...).',
			);
		}
		// 只采集命令执行期间产生的内容，排除工厂期警告。
		warnCalls.length = 0;
		const chunks: string[] = [];
		const push = (...args: unknown[]) => {
			chunks.push(args.map(String).join(" "));
		};
		const notify = vi.fn((...args: unknown[]) => push(...args));
		const logSpy = vi.spyOn(console, "log").mockImplementation(push);
		const infoSpy = vi.spyOn(console, "info").mockImplementation(push);
		try {
			await command.handler("", { cwd: callCwd, hasUI: false, ui: { notify } });
		} finally {
			logSpy.mockRestore();
			infoSpy.mockRestore();
		}
		chunks.push(...warnCalls);
		return chunks.join("\n");
	}

	// ================================================================
	// 注册 + description
	// ================================================================

	it("should register the subagent-dispatch command", () => {
		const tree = makeTree("valid", { main: ["coordinator"], coordinator: ["worker"] });
		writeAgent(tree, "coordinator");
		writeAgent(tree, "worker");

		const { pi } = setupExtension(tree);

		expect(pi._commandDefs.has("subagent-dispatch")).toBe(true);
	});

	it("should use the verbatim description for the subagent-dispatch command", () => {
		const tree = makeTree("valid", { main: ["coordinator"], coordinator: ["worker"] });
		writeAgent(tree, "coordinator");
		writeAgent(tree, "worker");

		const { pi } = setupExtension(tree);

		const command = pi._commandDefs.get("subagent-dispatch");
		expect(command.description).toBe(
			"Show the effective dispatch roster from subagent-isolation.json with validation findings",
		);
	});

	// ================================================================
	// 整体输出（逐字精确）+ 无反查
	// ================================================================

	it("should print the exact roster-only output with no findings and no diff section", async () => {
		const tree = makeTree("valid", { main: ["coordinator"], coordinator: ["worker"] });
		writeAgent(tree, "coordinator");
		writeAgent(tree, "worker");
		const { pi, warnCalls } = setupExtension(tree);

		const output = await runDispatchCommand(pi, tree, warnCalls);

		// 代表性运行：整个输出恰好是名单表 + `Validation findings: none`，
		// 没有 diff 段、没有 legacy 行、没有多余空行，也绝不含反查元素。
		expect(output).toBe(
			"Dispatch roster (from subagent-isolation.json):\n" +
				"\n" +
				"main → coordinator\n" +
				"coordinator → worker\n" +
				"\n" +
				"Validation findings: none",
		);
		expect(output).not.toContain("反查");
		expect(output).not.toContain("←");
	});

	it("should print (none) for a manager whose S×C composed intersection is empty", async () => {
		// S 与 C 对 a 的名单不相交（b vs c）→ 合成交集为空 → `a → (none)`。
		const sTree = makeTree("s-tree", { main: ["a"], a: ["b"] });
		writeAgent(sTree, "a");
		writeAgent(sTree, "b");
		const cTree = makeTree("c-tree", { main: ["a"], a: ["c"] });
		writeAgent(cTree, "a");
		writeAgent(cTree, "c");
		const { pi, warnCalls } = setupExtension(sTree);

		const output = await runDispatchCommand(pi, cTree, warnCalls);

		expect(output).toContain("a → (none)");
	});

	// ================================================================
	// 校验发现（按 message 去重；前缀只给单侧独有的发现）
	// ================================================================

	it("should dedupe identical S/C findings with no source prefix", async () => {
		// S 与 C 完全相同且都没 ghost 的 agent 文件 → 两组 message 一致 →
		// 每条只打一次、无前缀。
		const tree = makeTree("same", { main: ["ghost"] });
		const { pi, warnCalls } = setupExtension(tree);

		const output = await runDispatchCommand(pi, tree, warnCalls);

		expect(output).toContain("ghost");
		expect(output).not.toContain("[S ");
		expect(output).not.toContain("[C ");
	});

	it("should prefix source-only findings with [S <factoryCwd>] and [C <callCwd>]", async () => {
		// S 只报 ghost、C 只报 phantom → 两条都只在一侧出现 → 各带自己侧前缀。
		const sTree = makeTree("s-ghost", { main: ["ghost"] });
		const cTree = makeTree("c-phantom", { main: ["phantom"] });
		const { pi, warnCalls } = setupExtension(sTree);

		const output = await runDispatchCommand(pi, cTree, warnCalls);

		expect(output).toMatch(/\[S [^\n]*\][^\n]*ghost/);
		expect(output).toMatch(/\[C [^\n]*\][^\n]*phantom/);
	});

	// ================================================================
	// 未生效 diff 段
	// ================================================================

	it("should omit the Not yet active diff section when the config file is unmodified", async () => {
		const tree = makeTree("valid", { main: ["coordinator"], coordinator: ["worker"] });
		writeAgent(tree, "coordinator");
		writeAgent(tree, "worker");
		const { pi, warnCalls } = setupExtension(tree);

		const output = await runDispatchCommand(pi, tree, warnCalls);

		expect(output).not.toContain("Not yet active");
	});

	it("should print the Not yet active diff section for file rows not yet effective after /reload", async () => {
		// 工厂期快照 S 拿到旧文件；命令执行前把同一棵树的文件改出 newcomer
		// （写进了文件但还没生效，因为 S 在工厂时刻已定格）。
		const tree = makeTree("mutated", { main: ["coordinator"], coordinator: ["worker"] });
		writeAgent(tree, "coordinator");
		writeAgent(tree, "worker");
		const { pi, warnCalls } = setupExtension(tree);
		fs.writeFileSync(
			path.join(tree, ".pi", "subagent-isolation.json"),
			JSON.stringify({ dispatch: { main: ["coordinator", "newcomer"], coordinator: ["worker"] } }),
			"utf-8",
		);

		const output = await runDispatchCommand(pi, tree, warnCalls);

		// main 行：文件行含 newcomer，但合成名单（S∩C）没有 → diff = [newcomer]。
		expect(output).toContain("Not yet active (in subagent-isolation.json, needs /reload):");
		expect(output).toContain("main → newcomer");
		// newcomer 没有 agent 文件 → 至少一条校验发现，发现段不是 `none` 形态。
		expect(output).toContain("Validation findings:");
		expect(output).not.toContain("Validation findings: none");
	});

	// ================================================================
	// legacy
	// ================================================================

	it("should print exactly the verbatim legacy line when no dispatch field exists", async () => {
		const tree = makeTree("legacy");
		writeAgent(tree, "worker");
		const { pi, warnCalls } = setupExtension(tree);

		const output = await runDispatchCommand(pi, tree, warnCalls);

		expect(output).toBe(
			"No dispatch config (legacy mode): the subagent tool is not limited by a roster; " +
				"dispatch inside a subagent process is still blocked by the depth lock (PI_SUBAGENT_DEPTH).",
		);
	});
});
