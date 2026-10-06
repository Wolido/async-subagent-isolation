/**
 * RED 测试：/subagent-dispatch 命令（规格 B）
 *
 * 规格（本轮 brief 规格 B）：
 * - 注册名 `subagent-dispatch`。
 * - 执行输出包含：
 *   ① 本进程视角的有效名单表（各管事的 → 合成后名单，合成 = 既有 S×C 交集规则）；
 *   ② 反查（成员 ← 可派它的管事的）；
 *   ③ 校验发现（硬错误 + 未接入提示；对 S 与执行时 cwd 的 C 都校验）；
 *   ④ legacy（无任何 dispatch 字段）→ 「未配置 dispatch（legacy 模式）」类提示。
 * - 断言按子串（行映射语义 + 反查语义）。
 *
 * 当前 src/index.ts 未注册该命令，因此所有用例在取命令时即红（明确失败原因：
 * 功能未实现），不依赖内部实现细节。
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

describe("/subagent-dispatch 命令（规格 B）[RED]", () => {
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
	// 注册
	// ================================================================

	it("should register the subagent-dispatch command", () => {
		const tree = makeTree("valid", { main: ["coordinator"], coordinator: ["worker"] });
		writeAgent(tree, "coordinator");
		writeAgent(tree, "worker");

		const { pi } = setupExtension(tree);

		expect(pi._commandDefs.has("subagent-dispatch")).toBe(true);
	});

	// ================================================================
	// 有效名单表 + 反查
	// ================================================================

	it("should print the effective roster table (manager → composed list)", async () => {
		const tree = makeTree("valid", { main: ["coordinator"], coordinator: ["worker"] });
		writeAgent(tree, "coordinator");
		writeAgent(tree, "worker");
		const { pi, warnCalls } = setupExtension(tree);

		const output = await runDispatchCommand(pi, tree, warnCalls);

		expect(output).toMatch(/main\s*→\s*coordinator/);
		expect(output).toMatch(/coordinator\s*→\s*worker/);
	});

	it("should print the reverse lookup (member ← manager)", async () => {
		const tree = makeTree("valid", { main: ["coordinator"], coordinator: ["worker"] });
		writeAgent(tree, "coordinator");
		writeAgent(tree, "worker");
		const { pi, warnCalls } = setupExtension(tree);

		const output = await runDispatchCommand(pi, tree, warnCalls);

		expect(output).toMatch(/coordinator\s*←\s*main/);
		expect(output).toMatch(/worker\s*←\s*coordinator/);
	});

	// ================================================================
	// 校验发现（S 与 C 都校验）
	// ================================================================

	it("should include validation findings for the execution cwd (C)", async () => {
		const sTree = makeTree("s-valid", { main: ["coordinator"], coordinator: ["worker"] });
		writeAgent(sTree, "coordinator");
		writeAgent(sTree, "worker");
		const cTree = makeTree("c-invalid", { main: ["ghost"] });
		const { pi, warnCalls } = setupExtension(sTree);

		const output = await runDispatchCommand(pi, cTree, warnCalls);

		expect(output).toContain("ghost");
	});

	it("should include validation findings for the factory snapshot (S)", async () => {
		const sTree = makeTree("s-invalid", { main: ["ghost"] });
		const { pi, warnCalls } = setupExtension(sTree);

		const output = await runDispatchCommand(pi, sTree, warnCalls);

		expect(output).toContain("ghost");
	});

	// ================================================================
	// legacy
	// ================================================================

	it("should report legacy mode when no dispatch field is configured", async () => {
		const tree = makeTree("legacy");
		writeAgent(tree, "worker");
		const { pi, warnCalls } = setupExtension(tree);

		const output = await runDispatchCommand(pi, tree, warnCalls);

		expect(output).toContain("未配置 dispatch");
		expect(output).toMatch(/legacy/i);
	});
});
