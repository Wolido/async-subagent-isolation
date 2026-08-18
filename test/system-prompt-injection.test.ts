/**
 * TDD 红阶段测试：子 agent 清单注入主 agent 系统提示词（system-prompt-injection）
 *
 * 本文件验证阶段 1 新功能的行为契约：扩展注册 `before_agent_start` 钩子，
 * 在每次 agent 启动前，把所有已发现子 agent 的 `name — description` 清单
 * （带来源标记 user/project）追加到 event.systemPrompt 尾部。
 *
 * 当前 src/index.ts 尚未实现该功能，因此这些测试应全部失败（红阶段），
 * 失败原因对应尚未实现的行为：
 *   - 钩子级测试：pi._eventHandlers 中没有 "before_agent_start" →
 *     getBeforeAgentStartHandler 抛出明确错误
 *   - builder 级测试：buildAgentPromptInjection 未导出 →
 *     requireBuilder 抛出明确错误
 *
 * 设计决策覆盖（用户拍板）：
 * 1. 注入格式：`name — description` 每行一条（— 为 U+2014 em dash），
 *    同一行带来源标记（user/project）
 * 2. 追加而非覆盖：注入文本追加到 systemPrompt 尾部，原有内容保留在前
 * 3. 作用域：与 discoverAgents(cwd, scope) 语义一致（both 默认，project
 *    覆盖 user 同名；scope=user/project 时只含对应来源）
 * 4. 缓存（关键）：注入文本在启动/reload 时构建并缓存——同一 factory 实例内
 *    修改 agent 文件不影响注入；重新执行 factory（模拟 /reload）后注入刷新
 * 5. reload 后注入仍然正常（关键，用户明确要求）
 * 6. 空 agent 目录：不注入额外内容（systemPrompt 原样返回），不抛错
 * 7. 非法 agent 文件：frontmatter 损坏/缺 name/缺 description 的文件被跳过，
 *    不影响其他 agent 注入
 *
 * 实现契约（coder 需满足的接口）：
 *   - 扩展 factory 内注册：pi.on("before_agent_start", async (event, ctx) => ...)
 *     返回 { systemPrompt }；无 agent 时可返回 undefined/{} 或原样 systemPrompt
 *   - 导出纯函数：buildAgentPromptInjection(cwd: string, scope: AgentScope) => string
 *     返回注入文本块；无 agent 时返回空字符串 ""
 *   - 注入缓存必须按 factory 执行实例隔离（闭包），使测试里再次调用
 *     extension(pi) 即可模拟 /reload 后的重建
 */

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import extension, * as ext from "../src/index.ts";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

// Only mock getAgentDir (module boundary: user-level config dir).
// parseFrontmatter must stay REAL so YAML syntax errors surface authentically
// (same convention as agent-loading.test.ts).
vi.mock("@earendil-works/pi-coding-agent", async () => {
	const actual = await vi.importActual("@earendil-works/pi-coding-agent");
	return {
		...actual,
		getAgentDir: vi.fn(),
	};
});

/** U+2014 EM DASH — the separator mandated by design decision 1. */
const EM = "\u2014";

const BASE_PROMPT = "You are the master agent.\nUse your tools wisely.";

type AgentScope = "user" | "project" | "both";
type BuildAgentPromptInjectionFn = (cwd: string, scope: AgentScope) => string;
type BeforeAgentStartHandler = (
	event: unknown,
	ctx: unknown,
) => Promise<{ systemPrompt?: string } | undefined | void>;

/**
 * Access the (not yet implemented) builder export in a red-phase-safe way:
 * the static import cannot reference a missing named export, so we go through
 * the module namespace and fail with a clear, behavior-linked error instead.
 */
const buildAgentPromptInjection = (
	ext as unknown as { buildAgentPromptInjection?: BuildAgentPromptInjectionFn }
).buildAgentPromptInjection;

function requireBuilder(): BuildAgentPromptInjectionFn {
	if (typeof buildAgentPromptInjection !== "function") {
		throw new Error(
			"buildAgentPromptInjection(cwd, scope) is not exported from src/index.ts — " +
				"feature not implemented yet (red phase). " +
				"Contract: (cwd: string, scope: 'user' | 'project' | 'both') => string, " +
				"returns '' when no agents are discovered.",
		);
	}
	return buildAgentPromptInjection;
}

/**
 * Build a mock pi object that captures all registration calls.
 * (Same shape as async-mode.test.ts / async-regression.test.ts.)
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
		registerMessageRenderer: vi.fn(),
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

type MockPi = ReturnType<typeof createMockPi>;

/** Minimal ExtensionContext shape: the handler only needs ctx.cwd. */
function createMockCtx(cwd: string) {
	return {
		cwd,
		hasUI: false,
	};
}

/** Minimal BeforeAgentStartEvent shape: the handler only needs event.systemPrompt. */
function makeBeforeAgentStartEvent(systemPrompt: string) {
	return {
		type: "before_agent_start",
		prompt: "user prompt text",
		systemPrompt,
	};
}

/**
 * Fetch the registered before_agent_start handler. Throws a clear,
 * behavior-linked error while the feature is unimplemented (red phase).
 */
function getBeforeAgentStartHandler(pi: MockPi): BeforeAgentStartHandler {
	const handlers = pi._eventHandlers.get("before_agent_start");
	if (!handlers || handlers.length === 0) {
		throw new Error(
			'No "before_agent_start" handler registered — feature not implemented yet (red phase). ' +
				'Expected pi.on("before_agent_start", async (event, ctx) => ...) in the extension factory.',
		);
	}
	return handlers[0] as BeforeAgentStartHandler;
}

/** Write a well-formed agent definition file. */
function writeAgent(dir: string, fileName: string, name: string, description: string): void {
	fs.writeFileSync(
		path.join(dir, fileName),
		`---\nname: ${name}\ndescription: ${description}\n---\nYou are ${name}.\n`,
		"utf-8",
	);
}

describe("系统提示词注入（子 agent name + description 清单）- TDD 红阶段", () => {
	let tmpBase: string;
	let agentDir: string;
	let userAgentsDir: string;
	let defaultCwd: string;
	let projectAgentsDir: string;

	beforeEach(() => {
		tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "async-subagent-isolation-prompt-injection-"));
		// User level: getAgentDir() is mocked to agentDir; user agents live in <agentDir>/agents.
		agentDir = path.join(tmpBase, "agent-dir");
		userAgentsDir = path.join(agentDir, "agents");
		fs.mkdirSync(userAgentsDir, { recursive: true });
		// Project level: <cwd>/.pi/agents (findNearestProjectAgentsDir stops here,
		// so the upward walk never escapes the tmp tree).
		defaultCwd = path.join(tmpBase, "default-cwd");
		projectAgentsDir = path.join(defaultCwd, ".pi", "agents");
		fs.mkdirSync(projectAgentsDir, { recursive: true });
		vi.mocked(getAgentDir).mockReturnValue(agentDir);
	});

	afterEach(() => {
		vi.restoreAllMocks();
		fs.rmSync(tmpBase, { recursive: true, force: true });
	});

	/**
	 * Execute the extension factory against a fresh mock pi. Re-calling this
	 * simulates pi's /reload, which re-executes the factory and re-registers
	 * all hooks (jiti loads extensions with moduleCache: false).
	 */
	function setupExtension() {
		const pi = createMockPi();
		extension(pi as any);
		return { pi };
	}

	// ================================================================
	// 契约 1：注入文本格式（builder 单元级）
	// ================================================================
	describe("契约 1：注入文本格式", () => {
		it("should export buildAgentPromptInjection(cwd, scope) as the injection builder", () => {
			// 红阶段：导出不存在 → typeof 为 "undefined"
			expect(typeof buildAgentPromptInjection).toBe("function");
		});

		it("should list each agent as `name — description` with a source marker on the same line", () => {
			// Arrange
			writeAgent(userAgentsDir, "tester.md", "tester", "Tests things");
			writeAgent(projectAgentsDir, "coder.md", "coder", "Writes code");

			// Act
			const text = requireBuilder()(defaultCwd, "both");

			// Assert: `name — description` (em dash) with the source word on the same line
			expect(text).toMatch(new RegExp(`tester ${EM} Tests things.*\\buser\\b`));
			expect(text).toMatch(new RegExp(`coder ${EM} Writes code.*\\bproject\\b`));
		});
	});

	// ================================================================
	// 契约 2：作用域语义（builder 单元级，与 discoverAgents 一致）
	// ================================================================
	describe("契约 2：作用域语义", () => {
		it("should let a project agent override a same-named user agent when scope is both", () => {
			// Arrange
			writeAgent(userAgentsDir, "shared.md", "shared", "User version");
			writeAgent(projectAgentsDir, "shared.md", "shared", "Project version");

			// Act
			const text = requireBuilder()(defaultCwd, "both");

			// Assert
			expect(text).toMatch(new RegExp(`shared ${EM} Project version.*\\bproject\\b`));
			expect(text).not.toContain("User version");
		});

		it("should include only user agents when scope is user", () => {
			// Arrange
			writeAgent(userAgentsDir, "useronly.md", "useronly", "User agent");
			writeAgent(projectAgentsDir, "projonly.md", "projonly", "Project agent");

			// Act
			const text = requireBuilder()(defaultCwd, "user");

			// Assert
			expect(text).toMatch(new RegExp(`useronly ${EM} User agent`));
			expect(text).not.toContain("projonly");
		});

		it("should include only project agents when scope is project", () => {
			// Arrange
			writeAgent(userAgentsDir, "useronly.md", "useronly", "User agent");
			writeAgent(projectAgentsDir, "projonly.md", "projonly", "Project agent");

			// Act
			const text = requireBuilder()(defaultCwd, "project");

			// Assert
			expect(text).toMatch(new RegExp(`projonly ${EM} Project agent`));
			expect(text).not.toContain("useronly");
		});
	});

	// ================================================================
	// 契约 3：空目录与非法文件（builder 单元级）
	// ================================================================
	describe("契约 3：空目录与非法文件", () => {
		it("should return an empty string when no agents exist in either source", () => {
			// Arrange: both userAgentsDir and projectAgentsDir exist but are empty

			// Act
			const text = requireBuilder()(defaultCwd, "both");

			// Assert
			expect(text).toBe("");
		});

		it("should skip invalid agent files (broken frontmatter / missing name / missing description) and still include valid ones", () => {
			// Arrange
			fs.writeFileSync(
				path.join(projectAgentsDir, "broken-yaml.md"),
				`---\nname: broken\ndescription: foo: bar: baz\n---\nBroken body.\n`,
				"utf-8",
			);
			fs.writeFileSync(
				path.join(projectAgentsDir, "no-name.md"),
				`---\ndescription: Has no name\n---\nNameless body.\n`,
				"utf-8",
			);
			fs.writeFileSync(
				path.join(projectAgentsDir, "no-desc.md"),
				`---\nname: nodesc\n---\nDescriptionless body.\n`,
				"utf-8",
			);
			writeAgent(projectAgentsDir, "good.md", "good", "Good agent");
			// loadAgentsFromDir warns for each skipped file; keep test output clean.
			vi.spyOn(console, "warn").mockImplementation(() => {});

			// Act
			let text: string | undefined;
			let thrown: unknown;
			try {
				text = requireBuilder()(defaultCwd, "both");
			} catch (err) {
				thrown = err;
			}

			// Assert
			expect(thrown).toBeUndefined();
			expect(text).toMatch(new RegExp(`good ${EM} Good agent`));
			expect(text).not.toContain("broken");
			expect(text).not.toContain("nodesc");
			expect(text).not.toContain("Has no name");
		});
	});

	// ================================================================
	// 契约 4：before_agent_start 钩子集成（追加而非覆盖；默认 both 作用域）
	// ================================================================
	describe("契约 4：before_agent_start 钩子集成", () => {
		it("should register a before_agent_start handler in the extension factory", () => {
			// Act
			const { pi } = setupExtension();

			// Assert（红阶段：pi.on 从未以 "before_agent_start" 调用）
			expect(pi.on).toHaveBeenCalledWith("before_agent_start", expect.any(Function));
		});

		it("should append the agent list after the original system prompt, not replace it", async () => {
			// Arrange
			writeAgent(userAgentsDir, "tester.md", "tester", "Tests things");
			writeAgent(projectAgentsDir, "coder.md", "coder", "Writes code");
			const { pi } = setupExtension();
			const handler = getBeforeAgentStartHandler(pi);

			// Act
			const result = await handler(makeBeforeAgentStartEvent(BASE_PROMPT), createMockCtx(defaultCwd));

			// Assert
			const prompt = result?.systemPrompt;
			expect(typeof prompt).toBe("string");
			// 原有内容保留在前（追加到尾部，而非覆盖/前插）
			expect(prompt!.startsWith(BASE_PROMPT)).toBe(true);
			expect(prompt!.length).toBeGreaterThan(BASE_PROMPT.length);
			// 默认 both 作用域：user 级与 project 级 agent 都出现在注入清单中
			expect(prompt!).toMatch(new RegExp(`tester ${EM} Tests things.*\\buser\\b`));
			expect(prompt!).toMatch(new RegExp(`coder ${EM} Writes code.*\\bproject\\b`));
		});

		it("should inject with scope=both semantics by default (project overrides same-named user agent)", async () => {
			// Arrange
			writeAgent(userAgentsDir, "shared.md", "shared", "User version");
			writeAgent(projectAgentsDir, "shared.md", "shared", "Project version");
			const { pi } = setupExtension();
			const handler = getBeforeAgentStartHandler(pi);

			// Act
			const result = await handler(makeBeforeAgentStartEvent(BASE_PROMPT), createMockCtx(defaultCwd));

			// Assert
			expect(result?.systemPrompt).toMatch(new RegExp(`shared ${EM} Project version.*\\bproject\\b`));
			expect(result?.systemPrompt).not.toContain("User version");
		});
	});

	// ================================================================
	// 契约 5：缓存行为（关键）——启动/reload 时构建并缓存
	// ================================================================
	describe("契约 5：缓存行为", () => {
		it("should keep the cached injection unchanged when agent files change without a reload", async () => {
			// Arrange
			writeAgent(projectAgentsDir, "tester.md", "tester", "Original description");
			const { pi } = setupExtension();
			const handler = getBeforeAgentStartHandler(pi);
			const ctx = createMockCtx(defaultCwd);

			// Act 1：首次触发，构建注入（应含原始 description）
			const first = await handler(makeBeforeAgentStartEvent(BASE_PROMPT), ctx);
			expect(first?.systemPrompt).toMatch(new RegExp(`tester ${EM} Original description`));

			// Arrange 2：修改 agent 定义文件（不 reload）
			writeAgent(projectAgentsDir, "tester.md", "tester", "CHANGED description");

			// Act 2：同一 factory 实例再次触发 before_agent_start
			const second = await handler(makeBeforeAgentStartEvent(BASE_PROMPT), ctx);

			// Assert：注入内容不变（缓存生效）
			expect(second?.systemPrompt).toMatch(new RegExp(`tester ${EM} Original description`));
			expect(second?.systemPrompt).not.toContain("CHANGED description");
		});

		it("should rebuild the injection after a simulated reload (factory re-executed)", async () => {
			// Arrange
			writeAgent(projectAgentsDir, "tester.md", "tester", "Original description");
			const first = setupExtension();
			const firstHandler = getBeforeAgentStartHandler(first.pi);
			// 触发一次以建立缓存（模拟启动后的第一轮）
			await firstHandler(makeBeforeAgentStartEvent(BASE_PROMPT), createMockCtx(defaultCwd));

			// 修改 agent 定义文件
			writeAgent(projectAgentsDir, "tester.md", "tester", "CHANGED description");

			// Act：模拟 /reload —— pi 重新执行扩展 factory（全新的 pi 对象）
			const second = setupExtension();
			const secondHandler = getBeforeAgentStartHandler(second.pi);
			const result = await secondHandler(makeBeforeAgentStartEvent(BASE_PROMPT), createMockCtx(defaultCwd));

			// Assert：reload 后注入刷新为新值
			expect(result?.systemPrompt).toContain("CHANGED description");
			expect(result?.systemPrompt).not.toContain("Original description");
		});
	});

	// ================================================================
	// 契约 6：reload 后注入仍然正常（关键，用户明确要求验证）
	// ================================================================
	describe("契约 6：reload 后注入仍然正常", () => {
		it("should still register the handler and inject correctly after a simulated reload", async () => {
			// Arrange
			writeAgent(userAgentsDir, "tester.md", "tester", "Tests things");

			// Act 1：初次启动，注入正常
			const first = setupExtension();
			const firstResult = await getBeforeAgentStartHandler(first.pi)(
				makeBeforeAgentStartEvent(BASE_PROMPT),
				createMockCtx(defaultCwd),
			);
			expect(firstResult?.systemPrompt).toMatch(new RegExp(`tester ${EM} Tests things.*\\buser\\b`));

			// Act 2：模拟 /reload —— factory 重新执行，钩子重新注册
			const second = setupExtension();

			// Assert：钩子仍然存在且注入正确
			const handlers = second.pi._eventHandlers.get("before_agent_start");
			expect(handlers).toBeDefined();
			expect(handlers!.length).toBeGreaterThan(0);
			const secondResult = await (handlers![0] as BeforeAgentStartHandler)(
				makeBeforeAgentStartEvent(BASE_PROMPT),
				createMockCtx(defaultCwd),
			);
			expect(secondResult?.systemPrompt).toMatch(new RegExp(`tester ${EM} Tests things.*\\buser\\b`));
		});
	});

	// ================================================================
	// 契约 7：空 agent 目录（钩子级）——不注入额外内容，不抛错
	// ================================================================
	describe("契约 7：空 agent 目录（钩子级）", () => {
		it("should leave the system prompt unchanged and not throw when no agents are discovered", async () => {
			// Arrange: both agent dirs are empty
			const { pi } = setupExtension();
			const handler = getBeforeAgentStartHandler(pi);

			// Act
			let result: { systemPrompt?: string } | undefined | void;
			let thrown: unknown;
			try {
				result = await handler(makeBeforeAgentStartEvent(BASE_PROMPT), createMockCtx(defaultCwd));
			} catch (err) {
				thrown = err;
			}

			// Assert：不抛错；systemPrompt 原样返回
			// （实现可返回 undefined/{}，也可返回 { systemPrompt: event.systemPrompt }）
			expect(thrown).toBeUndefined();
			const effective = (result as { systemPrompt?: string } | undefined)?.systemPrompt ?? BASE_PROMPT;
			expect(effective).toBe(BASE_PROMPT);
		});
	});
});

// ============================================================================
// reviewer 审查补充契约（契约 8–11）— TDD 红阶段
//
// 来源：阶段 1 转绿后的 reviewer 审查 —— 两项必须修复 + 两个值得钉死的
// 边角，既有 14 个测试均未覆盖：
//   契约 8（必须修复）：子 agent 进程内不注入 —— before_agent_start 钩子
//     当前缺少 PI_SUBAGENT_DEPTH 守卫，子 agent（depth >= 1）启动时也会把
//     子 agent 清单注入自己的系统提示词（它根本不能用 subagent 工具，注入
//     纯属污染）。守卫 pattern 参照工具层 depth gate（runSingleAgent /
//     subagent execute 里 parseEnvInt(process.env.PI_SUBAGENT_DEPTH, 0)）。
//   契约 9（必须修复）：ctx.cwd 为 undefined 时不抛错 —— 当前实现把
//     ctx.cwd 直接传给 buildAgentPromptInjection → path.join(undefined, ...)
//     抛 TypeError。钉死行为（本文件拍板）：静默跳过（不抛错、不注入、
//     systemPrompt 原样），且空态由缓存/哨兵保证只尝试一次 —— 同一
//     factory 实例内后续触发（哪怕 ctx.cwd 已恢复有效）不再重试、不重复
//     抛错。若 coder 与 reviewer 协商后改用 process.cwd() 兜底方案，仅需
//     调整契约 9 中 "systemPrompt 原样" 的两条断言；不抛错与哨兵断言不变。
//   契约 10（边角钉死）：YAML 块标量多行 description 压平为单行 —— 注入
//     行的 name、description、来源标记必须在同一行；描述文本中的空白
//     （换行、tab、连续空格）压平为单空格，无换行符残留。
//   契约 11（边角钉死，现有实现已正确，补显式断言）：空结果只构建一次 ——
//     首次触发构建为空后，同一 factory 实例内新增 agent 文件不重建；重跑
//     factory（模拟 /reload）后能看到新 agent。
// ============================================================================

describe("系统提示词注入 — reviewer 审查补充契约（TDD 红阶段）", () => {
	let tmpBase: string;
	let agentDir: string;
	let userAgentsDir: string;
	let defaultCwd: string;
	let projectAgentsDir: string;

	beforeEach(() => {
		tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "async-subagent-isolation-prompt-injection-review-"));
		agentDir = path.join(tmpBase, "agent-dir");
		userAgentsDir = path.join(agentDir, "agents");
		fs.mkdirSync(userAgentsDir, { recursive: true });
		defaultCwd = path.join(tmpBase, "default-cwd");
		projectAgentsDir = path.join(defaultCwd, ".pi", "agents");
		fs.mkdirSync(projectAgentsDir, { recursive: true });
		vi.mocked(getAgentDir).mockReturnValue(agentDir);
	});

	afterEach(() => {
		vi.restoreAllMocks();
		fs.rmSync(tmpBase, { recursive: true, force: true });
	});

	/** Same as the top-level describe: re-executing the factory simulates /reload. */
	function setupExtension() {
		const pi = createMockPi();
		extension(pi as any);
		return { pi };
	}

	// ================================================================
	// 契约 8：子 agent 进程内不注入（PI_SUBAGENT_DEPTH 守卫）
	// ================================================================
	describe("契约 8：子 agent 进程内不注入（PI_SUBAGENT_DEPTH 守卫）", () => {
		// 环境变量保存/恢复约定（与 async-mode.test.ts 等文件一致）：
		// vitest worker 间默认共享 process.env，必须逐测试还原，避免污染。
		const ENV_KEYS = ["PI_SUBAGENT_DEPTH"];
		let savedEnv: Record<string, string | undefined>;

		beforeEach(() => {
			savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]] as const));
			// 基线 = 主 agent 进程（变量未设置）；各用例按需自行覆盖。
			delete process.env.PI_SUBAGENT_DEPTH;
		});

		afterEach(() => {
			for (const key of ENV_KEYS) {
				if (savedEnv[key] === undefined) delete process.env[key];
				else process.env[key] = savedEnv[key];
			}
		});

		it("should not inject the subagent roster when PI_SUBAGENT_DEPTH is 1 (subagent process)", async () => {
			// Arrange：user/project 两级都有可注入的 agent；env 在 factory 之前
			// 设置，兼容 factory 期或触发期读取守卫的两种实现。
			writeAgent(userAgentsDir, "tester.md", "tester", "Tests things");
			writeAgent(projectAgentsDir, "coder.md", "coder", "Writes code");
			process.env.PI_SUBAGENT_DEPTH = "1";
			const { pi } = setupExtension();
			const handler = getBeforeAgentStartHandler(pi);

			// Act
			const result = await handler(makeBeforeAgentStartEvent(BASE_PROMPT), createMockCtx(defaultCwd));

			// Assert：不注入注入块（返回 undefined 或 systemPrompt 原样）
			const effective = (result as { systemPrompt?: string } | undefined)?.systemPrompt ?? BASE_PROMPT;
			expect(effective).not.toContain("Available Subagents");
			expect(effective).toBe(BASE_PROMPT);
		});

		it("should inject normally when PI_SUBAGENT_DEPTH is 0 (main agent process)", async () => {
			// Arrange
			writeAgent(projectAgentsDir, "coder.md", "coder", "Writes code");
			process.env.PI_SUBAGENT_DEPTH = "0";
			const { pi } = setupExtension();
			const handler = getBeforeAgentStartHandler(pi);

			// Act
			const result = await handler(makeBeforeAgentStartEvent(BASE_PROMPT), createMockCtx(defaultCwd));

			// Assert：depth=0 是主 agent 进程，注入不受守卫影响（防 coder 把守卫写得过宽）
			expect(result?.systemPrompt).toContain("Available Subagents");
			expect(result?.systemPrompt).toMatch(new RegExp(`coder ${EM} Writes code.*\\bproject\\b`));
		});

		it("should inject normally when PI_SUBAGENT_DEPTH is unset (main agent process)", async () => {
			// Arrange：beforeEach 已删除该变量
			writeAgent(projectAgentsDir, "coder.md", "coder", "Writes code");
			const { pi } = setupExtension();
			const handler = getBeforeAgentStartHandler(pi);

			// Act
			const result = await handler(makeBeforeAgentStartEvent(BASE_PROMPT), createMockCtx(defaultCwd));

			// Assert
			expect(result?.systemPrompt).toContain("Available Subagents");
			expect(result?.systemPrompt).toMatch(new RegExp(`coder ${EM} Writes code.*\\bproject\\b`));
		});
	});

	// ================================================================
	// 契约 9：ctx.cwd 为 undefined 时不抛错（静默跳过 + 空态哨兵）
	// ================================================================
	describe("契约 9：ctx.cwd 为 undefined 时不抛错", () => {
		it("should not throw and should leave the system prompt unchanged when ctx.cwd is undefined", async () => {
			// Arrange：有合法 agent 可注入 —— 若实现错误地用了别的 cwd 兜底，
			// 注入内容会暴露；钉死的行为是"静默跳过"。
			writeAgent(projectAgentsDir, "coder.md", "coder", "Writes code");
			const { pi } = setupExtension();
			const handler = getBeforeAgentStartHandler(pi);
			const undefinedCwdCtx = { cwd: undefined, hasUI: false };

			// Act
			let result: { systemPrompt?: string } | undefined | void;
			let thrown: unknown;
			try {
				result = await handler(makeBeforeAgentStartEvent(BASE_PROMPT), undefinedCwdCtx);
			} catch (err) {
				thrown = err;
			}

			// Assert：不抛错；注入静默跳过，systemPrompt 原样
			expect(thrown).toBeUndefined();
			const effective = (result as { systemPrompt?: string } | undefined)?.systemPrompt ?? BASE_PROMPT;
			expect(effective).toBe(BASE_PROMPT);
			expect(effective).not.toContain("Available Subagents");
		});

		it("should not throw on repeated triggers when ctx.cwd stays undefined (empty state attempted only once)", async () => {
			// Arrange
			const { pi } = setupExtension();
			const handler = getBeforeAgentStartHandler(pi);
			const undefinedCwdCtx = { cwd: undefined, hasUI: false };

			// Act：连续触发 3 次，收集每次抛出的异常
			const thrown: unknown[] = [];
			const effects: string[] = [];
			for (let i = 0; i < 3; i++) {
				try {
					const result = await handler(makeBeforeAgentStartEvent(BASE_PROMPT), undefinedCwdCtx);
					effects.push((result as { systemPrompt?: string } | undefined)?.systemPrompt ?? BASE_PROMPT);
				} catch (err) {
					thrown.push(err);
				}
			}

			// Assert：没有任何一次抛错；每次 systemPrompt 都原样
			// （当前实现 agentPromptInjection 抛错后保持 null，每次触发都会重新抛 —— 红）
			expect(thrown).toEqual([]);
			expect(effects).toEqual([BASE_PROMPT, BASE_PROMPT, BASE_PROMPT]);
		});

		it("should cache the undefined-cwd empty state: a later trigger with a valid cwd in the same factory instance still skips injection", async () => {
			// Arrange
			writeAgent(projectAgentsDir, "coder.md", "coder", "Writes code");
			const { pi } = setupExtension();
			const handler = getBeforeAgentStartHandler(pi);

			// Act 1：首次以 undefined cwd 触发，空态被缓存/哨兵记录
			let firstThrown: unknown;
			try {
				await handler(makeBeforeAgentStartEvent(BASE_PROMPT), { cwd: undefined, hasUI: false });
			} catch (err) {
				firstThrown = err;
			}
			expect(firstThrown).toBeUndefined();

			// Act 2：同一 factory 实例，这次 ctx.cwd 有效
			let result: { systemPrompt?: string } | undefined | void;
			let secondThrown: unknown;
			try {
				result = await handler(makeBeforeAgentStartEvent(BASE_PROMPT), createMockCtx(defaultCwd));
			} catch (err) {
				secondThrown = err;
			}

			// Assert：不抛错，且不重试构建 —— 沿用首次缓存的空态，注入仍为空。
			// 这是"空态只尝试一次"的可观测证据（无需 spy 内部实现）。
			expect(secondThrown).toBeUndefined();
			const effective = (result as { systemPrompt?: string } | undefined)?.systemPrompt ?? BASE_PROMPT;
			expect(effective).toBe(BASE_PROMPT);
			expect(effective).not.toContain("Available Subagents");
		});
	});

	// ================================================================
	// 契约 10：多行/含换行 description 不破坏行格式（builder 单元级）
	// ================================================================
	describe("契约 10：多行 description 压平为单行", () => {
		it("should flatten a multi-line (YAML block scalar) description into single-spaced text on the agent line", () => {
			// Arrange：description: | 块标量产生含换行/tab/连续空格的 description
			// （parseFrontmatter 解析值为 "First line of the description\nsecond line   with\t  extra   spaces\n"）
			fs.writeFileSync(
				path.join(projectAgentsDir, "multiline.md"),
				"---\nname: multiline\ndescription: |\n  First line of the description\n  second line   with\t  extra   spaces\n---\nBody.\n",
				"utf-8",
			);

			// Act
			const text = requireBuilder()(defaultCwd, "both");

			// Assert：name、压平后的 description、来源标记在同一行；
			// 空白（\n、\t、连续空格）全部压平为单空格
			const line = text.split("\n").find((l) => l.startsWith("- multiline "));
			expect(line).toBe(`- multiline ${EM} First line of the description second line with extra spaces (project)`);
			// 无换行符残留：描述的第二段不得以独立行/行首片段形式泄漏出来
			expect(text).not.toContain("\nsecond line");
		});
	});

	// ================================================================
	// 契约 11：空结果只构建一次（钉死现有已正确但未显式断言的行为）
	// ================================================================
	describe("契约 11：空结果只构建一次", () => {
		it("should not rebuild the injection when agent files appear after an empty first build (empty result is cached)", async () => {
			// Arrange：两个 agent 目录均为空
			const { pi } = setupExtension();
			const handler = getBeforeAgentStartHandler(pi);
			const ctx = createMockCtx(defaultCwd);

			// Act 1：首次触发，构建（并缓存）空注入
			const first = await handler(makeBeforeAgentStartEvent(BASE_PROMPT), ctx);
			expect((first as { systemPrompt?: string } | undefined)?.systemPrompt ?? BASE_PROMPT).toBe(BASE_PROMPT);

			// Arrange 2：不 reload，新增一个合法 agent 文件
			writeAgent(projectAgentsDir, "late.md", "late", "Added after first build");

			// Act 2：同一 factory 实例再次触发
			const second = await handler(makeBeforeAgentStartEvent(BASE_PROMPT), ctx);

			// Assert：注入仍为空 —— 空结果已被缓存，未重新构建
			const effective = (second as { systemPrompt?: string } | undefined)?.systemPrompt ?? BASE_PROMPT;
			expect(effective).toBe(BASE_PROMPT);
			expect(effective).not.toContain("late");
		});

		it("should pick up agents added after an empty first build once the factory re-runs (simulated reload)", async () => {
			// Arrange：先建立空缓存（首个 factory 实例触发一次）
			const first = setupExtension();
			await getBeforeAgentStartHandler(first.pi)(
				makeBeforeAgentStartEvent(BASE_PROMPT),
				createMockCtx(defaultCwd),
			);

			// agent 文件出现，然后模拟 /reload —— factory 重新执行（全新闭包）
			writeAgent(projectAgentsDir, "late.md", "late", "Added after first build");
			const second = setupExtension();

			// Act
			const result = await getBeforeAgentStartHandler(second.pi)(
				makeBeforeAgentStartEvent(BASE_PROMPT),
				createMockCtx(defaultCwd),
			);

			// Assert：reload 后重建，注入包含新 agent
			expect(result?.systemPrompt).toMatch(new RegExp(`late ${EM} Added after first build.*\\bproject\\b`));
		});
	});
});
