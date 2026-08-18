/**
 * 阶段 2（model/thinking 配置模块）TDD 红阶段契约测试。
 *
 * 背景：阶段 1（agent 清单注入）已验收。本阶段交付 model/thinking 配置的可视化
 * 编辑器，但底层机制不变：仍然是既有 subagent-isolation.json 双级文件（user 级
 * ~/.pi/agent/subagent-isolation.json 与 project 级 .pi/subagent-isolation.json
 * 合并，project 覆盖 user 同名 key），命令只是它的"编辑器"。数据读写层与编辑
 * UI 组件必须以独立导出函数形式存在（阶段 3 统一入口 /subagent-config 与阶段 4
 * 合并复用），且派发时每次重新读配置（修改即时生效，无需 reload）。
 *
 * 本文件钉死的契约（红阶段：全部预期失败，待 coder 实现后转绿）：
 *
 * A. 数据层（纯函数/文件 IO 级）
 *   A1 合并视图 computeEffectiveModelConfigs(agents, userOverrides, projectOverrides)
 *      → 每个 agent 的"实际生效 model/thinking"：json 覆盖优先于 frontmatter；
 *      project 覆盖优先于 user（注意：运行时合并是【按 key 整体替换】
 *      {...user, ...project}，不是按字段合并——project 级 entry 存在时 user 级
 *      同 key entry 的其它字段对运行时不可见，展示必须与此一致）；无配置时
 *      字段为 undefined。返回数组元素形状：
 *      { name, model?, modelSource?, thinking?, thinkingSource? }，
 *      source ∈ "project" | "user" | "frontmatter" | undefined。
 *   A2 写回 writeModelOverride(filePath, agentName, patch) →
 *      { ok: true } | { ok: false; error: string }（返回结果对象，不抛异常，
 *      UI 需要 error 文本展示）。patch = { model?: string | null, thinking?:
 *      string | null }：string 设置、null 清除、undefined 不动。写入格式必须
 *      与 loadModelOverridesFile 解析兼容（写后能读回）。
 *   A3 清空语义：字段清 null → 生效值回退 frontmatter（或 undefined）；agent
 *      最后一个字段被清掉时整个 key 从 JSON 移除，不残留空对象/空 key。
 *   A4 无效值防护：非法 thinking（不在官方 7 级别 off|minimal|low|medium|
 *      high|xhigh|max 内）、空串/纯空白 model → 整体拒绝（ok:false），不产生
 *      半写状态；目标文件是非法 JSON 时拒绝覆写。
 *   A5 未知字段保留：写回操作读取原始 JSON、只改目标 agent 的 model/thinking
 *      字段，其它顶层 key 与 entry 内未知字段原样保留（实现提示：不能经由
 *      normalizeOverride 回写——它会丢弃未知字段）。
 *   A6 写入目标路径 resolveModelOverridePath(scope, cwd)：user → getAgentDir()
 *      下的 subagent-isolation.json；project → 从 cwd 向上找到的第一个
 *      .pi/subagent-isolation.json（即实际管辖当前 cwd 读取的那个文件），都没
 *      有时回退 cwd/.pi/subagent-isolation.json。
 *
 * B. 交互流程（editAgentModelConfig 子流程）
 *   【需求变更】/subagent-models 命令已移除：model/thinking 是 /subagent-config
 *      统一入口的 7 字段之一，独立命令冗余，配置入口唯一化。
 *   B6 命令移除契约：扩展激活后注册表中不得存在 subagent-models 命令；
 *      /subagent-config 统一入口保持注册。原 B7（命令级非 TUI 回退/零 agent
 *      早退/命令级 happy path）随命令一并废止 —— 统一入口侧的对应契约见
 *      test/agent-config-editor.test.ts 与 test/available-models.test.ts。
 *   B8 子流程（可自动化部分）：agentName 必传（由 /subagent-config 父流程
 *      预选，独立 agent 选择步骤已移除，不存在任何 agent picker）→ 选择字段
 *      （model/thinking/clear）→ 输入/选择新值（thinking 用官方 7 级别
 *      select；model 值按【$models 需求变更】改为：subagent-isolation.json
 *      顶层 $models 列表非空 → 从列表 select，空/未配置 → 回退自由 input
 *      向后兼容）→ 选择写入目标（user/project）→ 写回 → 确认提示。通过
 *      独立导出的 editAgentModelConfig + 脚本化假 UI 驱动断言。未知
 *      agentName 报错、取消/零写入语义保留不变。
 *      【$models 需求变更说明】可用 model 列表由 subagent-isolation.json
 *      顶层 $models 字段统一承载（项目从未读取过无扩展名 subagent-models
 *      文本文件，无历史格式可言）。本文件全部
 *      model 输入用例运行在未配置 $models 的环境（getAgentDir 指向空 tmp
 *      目录、无 project 级文件）→ 空列表 → fallback input，逐案分析后原有
 *      断言在新语义下全部保持有效、无需改动；select 语义、$models 读写
 *      （loadAvailableModels / updateAvailableModels）与 /subagent-config
 *      列表管理入口契约见 test/available-models.test.ts。
 *      【对话框标签约定】实现可自由润色选项文案，但选项标签必须包含对应的英文
 *      key：agent 名、"model"/"thinking" 字段名、官方 thinking 级别名、
 *      "user"/"project" 目标名——测试按子串匹配脚本化应答。
 *      【手工验证项】真实 TUI 按键体验、当前生效值在选项标签中的展示、清除
 *      已有覆盖的 UX 入口——见测试文件头尾与移交报告。
 *
 * C. 阶段 3/4 衔接
 *   C9 独立导出钉死：computeEffectiveModelConfigs / writeModelOverride /
 *      resolveModelOverridePath / editAgentModelConfig（红）。
 *   C10 既有导出面不变：isThinkingLevel / normalizeOverride /
 *      loadModelOverridesFile / loadModelOverrides / discoverAgents（本文件内
 *      保持绿）；config.test.ts 全量保持绿（由 npm test 零回归验证）。
 *
 * D. UX 改进（本轮红阶段追加：选项标注当前值 + input 预填"在原值上修改"）
 *   D1 editAgentModelConfig 字段 select：model 选项含当前生效 model + 来源
 *      标记（如 "model — vendor/m (user)"）；thinking 选项含当前生效级别。
 *      标注为追加内容，既有英文 key 子串匹配用例保持绿。
 *   D2 thinking 级别 select：恰好一个选项带 "current" 标记，且对应当前生
 *      效级别；官方 7 级别完整不变（B8 既有断言语义）。
 *   D3 写入目标 select（user/project）：恰好一个选项带 "current" 标记，且
 *      对应当前生效来源（user 级覆盖生效 → user 带标记；project 同理）。
 *   D4 model fallback input（$models 空）：input 第三参 initial = 当前生效
 *      model（json 覆盖优先于 frontmatter）；无任何配置时钉死传 ""（空串
 *      契约，不是 undefined/省略——调用方无需判空）。
 *   D5 预填不改变取消/提交语义：预填输入上 Esc = 零写入；用户提交的值
 *      （脚本应答）覆盖预填值写回。
 *   ⚠️ 既有用例适配说明（本轮）：独立调用（无 embedded）的值步/目标步 ESC
 *   从"取消即退出"改为统一逐级回退（值步 ESC → 回字段选择；写入目标 ESC →
 *   回值步；字段选择 ESC → 完全退出）——B8 值步/目标步取消、D2 级别选择
 *   取消、D3 写入目标取消、D5 预填取消共六个用例脚本追加逐级 ESC 步骤，
 *   零写入断言保留；字段选择 ESC = 顶层完全退出，语义不变（D1 用例不动）。
 *   D6 类型钉：ModelConfigEditorUI.input 扩展为 (title, placeholder?,
 *      initial?)。红阶段以 @ts-expect-error 消费三参调用的编译错误；coder
 *      扩展接口后 tsc 报 unused 指令，删除该指令即完成类型钉转绿。
 *   【手工验证项（自动化覆盖不了）】真实 TUI 预填输入框（命令层适配：
 *   ctx.ui.custom + pi-tui Input.setValue(initial)）：Enter 提交（未改动 =
 *   提交原值，语义与旧 placeholder 时代一致）/ Esc 取消零写入 / 光标初始
 *   位置与全选态；适配层在 ui.custom 不可用时的普通 input 回退；选项标注
 *   在窄终端的可读性（截断）与 current 标记可发现性。
 *
 * 红阶段技术说明：新导出尚不存在，全部经 (mod as any) 命名空间访问，使失败
 * 落在断言/调用处（"xxx is not a function" / typeof 断言），而非模块导入期；
 * 同时保证本测试文件在严格单文件 typecheck 下无错误。
 */

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as mod from "../src/index.ts";
import { loadModelOverridesFile, loadModelOverrides } from "../src/index.ts";
import type { ModelConfigEditorUI } from "../src/index.ts";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

// 只 mock 模块边界 getAgentDir（user 级配置目录）；parseFrontmatter 等保持真实。
vi.mock("@earendil-works/pi-coding-agent", async () => {
	const actual = await vi.importActual("@earendil-works/pi-coding-agent");
	return {
		...actual,
		getAgentDir: vi.fn(),
	};
});

// ---------------------------------------------------------------------------
// 预期新导出的访问器（红阶段为 undefined；coder 实现后同一调用点转绿）
// ---------------------------------------------------------------------------

/** 预期签名：(agents, userOverrides, projectOverrides, processOverrides?) => EffectiveModelConfig[] */
function viewOf(agents: any[], userOverrides: any, projectOverrides: any, processOverrides?: any): any[] {
	return (mod as any).computeEffectiveModelConfigs(agents, userOverrides, projectOverrides, processOverrides);
}

/** 预期签名：(filePath, agentName, patch) => { ok: true } | { ok: false; error: string } */
function writeOverride(filePath: string, agentName: string, patch: any): any {
	return (mod as any).writeModelOverride(filePath, agentName, patch);
}

/** 预期签名：(scope: "user" | "project", cwd: string) => string */
function resolvePath(scope: "user" | "project", cwd: string): string {
	return (mod as any).resolveModelOverridePath(scope, cwd);
}

/** 签名：(deps: { ui, cwd, agents, agentName: string }) => Promise<unknown> —— agentName 必传（子流程化：无独立 agent 选择入口） */
function runEditorFlow(deps: any): Promise<unknown> {
	return (mod as any).editAgentModelConfig(deps);
}

/** 预期签名：(agentName, patch) => { ok: true } | { ok: false; error: string } */
function setProcessOverride(agentName: string, patch: any): any {
	return (mod as any).setProcessOverride(agentName, patch);
}

/** 预期签名：() => Record<string, ModelOverride> */
function getProcessOverrides(): any {
	return (mod as any).getProcessOverrides();
}

/** 预期签名：(agentName) => void */
function clearProcessOverride(agentName: string): void {
	(mod as any).clearProcessOverride(agentName);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** 构造一个 AgentConfig 形状的测试 agent（宽松 any：视图函数只需 name/model/thinking）。 */
function makeAgent(name: string, extra: Record<string, unknown> = {}): any {
	return {
		name,
		description: `${name} agent`,
		systemPrompt: "",
		source: "project",
		filePath: `/fake/${name}.md`,
		...extra,
	};
}

/** 读取目标文件的原始 JSON（不经 normalizeOverride —— A5 契约要看原始内容）。 */
function readRawJson(filePath: string): any {
	return JSON.parse(fs.readFileSync(filePath, "utf-8"));
}

/**
 * 脚本化假 UI（Fake，非 mock 内部模块）：按队列依次应答 select/input，
 * 记录每次提问（kind/title/options），应答与提问类型不匹配或选项无匹配时
 * 记入 mismatches 并返回 undefined（等价用户取消）。字符串应答先精确匹配、
 * 再退到子串匹配；RegExp 应答取第一个匹配的选项。select/input 应答为
 * undefined 表示用户在该步取消（Esc）。
 */
type UiStep =
	| { select: string | RegExp | undefined }
	| { input: string | undefined };

interface UiCall {
	kind: "select" | "input";
	title: string;
	options?: string[];
	placeholder?: string;
	/**
	 * input 的第三参 initial（预填当前值，D4 契约）。流程未传时为 undefined，
	 * 与"传空串"的空值契约可区分（toBe 断言 undefined ≠ ""）。
	 */
	initial?: string;
}

function createScriptedUi(steps: UiStep[]) {
	const calls: UiCall[] = [];
	const mismatches: string[] = [];
	const queue = [...steps];
	const notifyMock = vi.fn();
	const ui = {
		select: async (title: string, options: string[]): Promise<string | undefined> => {
			calls.push({ kind: "select", title, options: [...options] });
			const step = queue.shift();
			if (!step || !("select" in step)) {
				mismatches.push(`select("${title}") 被提问，但下一个脚本步骤是 ${JSON.stringify(step)}`);
				return undefined;
			}
			const wanted = step.select;
			if (wanted === undefined) return undefined; // 脚本化取消
			if (typeof wanted === "string") {
				const exact = options.find((o) => o === wanted);
				if (exact !== undefined) return exact;
				const partial = options.find((o) => o.includes(wanted));
				if (partial !== undefined) return partial;
			} else {
				const byRegex = options.find((o) => wanted.test(o));
				if (byRegex !== undefined) return byRegex;
			}
			mismatches.push(`select("${title}"): 没有选项匹配 ${String(wanted)}，选项 = [${options.join(" | ")}]`);
			return undefined;
		},
		input: async (title: string, placeholder?: string, initial?: string): Promise<string | undefined> => {
			calls.push({ kind: "input", title, placeholder, initial });
			const step = queue.shift();
			if (!step || !("input" in step)) {
				mismatches.push(`input("${title}") 被提问，但下一个脚本步骤是 ${JSON.stringify(step)}`);
				return undefined;
			}
			return step.input;
		},
		// 宽容兜底：实现若额外加确认对话框，默认确认（不影响主流程断言）。
		confirm: async () => true,
		notify: notifyMock,
	};
	return { ui, calls, mismatches, notifyMock, leftover: queue };
}

/** 构造捕获注册表的 mock pi（与 render-result/interactive-pickers 测试同款）。 */
function createMockPi() {
	const toolDefs: any[] = [];
	const commandDefs = new Map<string, any>();
	return {
		registerTool: vi.fn((tool: any) => {
			toolDefs.push(tool);
		}),
		registerCommand: vi.fn((name: string, options: any) => {
			commandDefs.set(name, options);
		}),
		registerMessageRenderer: vi.fn(),
		on: vi.fn(),
		sendMessage: vi.fn(),
		_toolDefs: toolDefs,
		_commandDefs: commandDefs,
	};
}

/** 在 projectDir/.pi/agents/ 写一个最小合法 agent 文件。 */
function writeProjectAgent(projectDir: string, name: string, frontmatterExtra = ""): void {
	const agentsDir = path.join(projectDir, ".pi", "agents");
	fs.mkdirSync(agentsDir, { recursive: true });
	const extra = frontmatterExtra ? `${frontmatterExtra}\n` : "";
	fs.writeFileSync(
		path.join(agentsDir, `${name}.md`),
		`---\nname: ${name}\ndescription: ${name} agent\n${extra}---\nYou are ${name}.\n`,
		"utf-8",
	);
}

// ---------------------------------------------------------------------------
// 共享 fixture：每个测试独立 tmp 目录；getAgentDir 指向 tmp 下 user-agent 目录
// ---------------------------------------------------------------------------

let tmpBase: string;
let userAgentDir: string;
let projectDir: string;
let userFile: string;
let projectFile: string;

beforeEach(() => {
	tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "model-config-editor-test-"));
	userAgentDir = path.join(tmpBase, "user-agent");
	projectDir = path.join(tmpBase, "project");
	fs.mkdirSync(userAgentDir, { recursive: true });
	fs.mkdirSync(projectDir, { recursive: true });
	userFile = path.join(userAgentDir, "subagent-isolation.json");
	projectFile = path.join(projectDir, ".pi", "subagent-isolation.json");
	vi.mocked(getAgentDir).mockReturnValue(userAgentDir);
});

afterEach(() => {
	fs.rmSync(tmpBase, { recursive: true, force: true });
	vi.clearAllMocks();
});

// ===========================================================================
// C. 阶段 3/4 衔接契约：独立导出
// ===========================================================================
describe("C. 阶段 3/4 衔接契约：数据层与 UI 组件的独立导出", () => {
	it("should export computeEffectiveModelConfigs as a function", () => {
		expect(typeof (mod as any).computeEffectiveModelConfigs).toBe("function");
	});

	it("should export writeModelOverride as a function", () => {
		expect(typeof (mod as any).writeModelOverride).toBe("function");
	});

	it("should export resolveModelOverridePath as a function", () => {
		expect(typeof (mod as any).resolveModelOverridePath).toBe("function");
	});

	it("should export editAgentModelConfig as a function", () => {
		expect(typeof (mod as any).editAgentModelConfig).toBe("function");
	});

	it("should keep the existing data-layer exports intact (C10 防误删)", () => {
		expect(typeof mod.isThinkingLevel).toBe("function");
		expect(typeof mod.normalizeOverride).toBe("function");
		expect(typeof mod.loadModelOverridesFile).toBe("function");
		expect(typeof mod.loadModelOverrides).toBe("function");
		expect(typeof mod.discoverAgents).toBe("function");
	});
});

// ===========================================================================
// A1. 合并视图：computeEffectiveModelConfigs
// ===========================================================================
describe("A1. 合并视图 computeEffectiveModelConfigs（json 覆盖 > frontmatter，project > user）", () => {
	it("should fall back to frontmatter values when no json override exists", () => {
		// Arrange
		const agents = [makeAgent("coder", { model: "fm-model", thinking: "low" })];

		// Act
		const result = viewOf(agents, {}, {});

		// Assert
		const coder = result.find((r) => r.name === "coder");
		expect(coder.model).toBe("fm-model");
		expect(coder.modelSource).toBe("frontmatter");
		expect(coder.thinking).toBe("low");
		expect(coder.thinkingSource).toBe("frontmatter");
	});

	it("should let user-level json override frontmatter", () => {
		// Arrange
		const agents = [makeAgent("coder", { model: "fm-model", thinking: "low" })];

		// Act
		const result = viewOf(agents, { coder: { model: "user-model", thinking: "high" } }, {});

		// Assert
		const coder = result.find((r) => r.name === "coder");
		expect(coder.model).toBe("user-model");
		expect(coder.modelSource).toBe("user");
		expect(coder.thinking).toBe("high");
		expect(coder.thinkingSource).toBe("user");
	});

	it("should let project-level json override frontmatter", () => {
		// Arrange
		const agents = [makeAgent("coder", { model: "fm-model", thinking: "low" })];

		// Act
		const result = viewOf(agents, {}, { coder: { model: "project-model" } });

		// Assert
		const coder = result.find((r) => r.name === "coder");
		expect(coder.model).toBe("project-model");
		expect(coder.modelSource).toBe("project");
		expect(coder.thinking).toBe("low");
		expect(coder.thinkingSource).toBe("frontmatter");
	});

	it("should shadow a user-level entry wholesale when a project-level entry exists for the same agent", () => {
		// 关键语义：loadModelOverrides 的运行时合并是【按 key 整体替换】
		// （{...userOverrides, ...projectOverrides}），不是按字段合并。因此 project
		// 级 entry 只有 thinking 时，user 级 entry 的 model 对运行时不可见 ——
		// 展示的"实际生效值"必须与派发行为一致，错误地按字段合并会把
		// user-model 显示为生效 model（运行时并不会用它）。
		// Arrange
		const agents = [makeAgent("coder", { model: "fm-model", thinking: "minimal" })];

		// Act
		const result = viewOf(
			agents,
			{ coder: { model: "user-model", thinking: "low" } },
			{ coder: { thinking: "high" } },
		);

		// Assert
		const coder = result.find((r) => r.name === "coder");
		expect(coder.thinking).toBe("high");
		expect(coder.thinkingSource).toBe("project");
		expect(coder.model, "user 级 model 被 project 级同 key entry 整体遮蔽，应回退 frontmatter").toBe("fm-model");
		expect(coder.modelSource).toBe("frontmatter");
	});

	it("should return undefined fields when nothing is configured anywhere", () => {
		// Arrange
		const agents = [makeAgent("plain")];

		// Act
		const result = viewOf(agents, {}, {});

		// Assert
		const plain = result.find((r) => r.name === "plain");
		expect(plain.model).toBeUndefined();
		expect(plain.thinking).toBeUndefined();
		expect(plain.modelSource).toBeUndefined();
		expect(plain.thinkingSource).toBeUndefined();
	});

	it("should apply a user-level thinking-only override to an agent without frontmatter", () => {
		// Arrange
		const agents = [makeAgent("plain")];

		// Act
		const result = viewOf(agents, { plain: { thinking: "low" } }, {});

		// Assert
		const plain = result.find((r) => r.name === "plain");
		expect(plain.thinking).toBe("low");
		expect(plain.thinkingSource).toBe("user");
		expect(plain.model).toBeUndefined();
		expect(plain.modelSource).toBeUndefined();
	});

	it("should treat a legacy string-format override (normalized to {model}) as a user model override", () => {
		// loadModelOverridesFile 已把 "coder": "legacy/m" 规范化为 { model: "legacy/m" }；
		// 视图函数接收的是规范化后的记录。
		// Arrange
		const agents = [makeAgent("coder", { thinking: "low" })];

		// Act
		const result = viewOf(agents, { coder: { model: "legacy-model" } }, {});

		// Assert
		const coder = result.find((r) => r.name === "coder");
		expect(coder.model).toBe("legacy-model");
		expect(coder.modelSource).toBe("user");
		expect(coder.thinking).toBe("low");
		expect(coder.thinkingSource).toBe("frontmatter");
	});
});

// ===========================================================================
// A2. 写回：writeModelOverride
// ===========================================================================
describe("A2. 写回 writeModelOverride（写入格式与 loadModelOverridesFile 兼容）", () => {
	it("should create the file (and missing parent dirs) when writing to a non-existent path", () => {
		// Arrange: projectFile 的父目录 .pi/ 尚不存在
		expect(fs.existsSync(projectFile)).toBe(false);

		// Act
		const result = writeOverride(projectFile, "coder", { model: "vendor/model-a", thinking: "high" });

		// Assert: ok + 文件创建 + 写后能经现有解析器读回
		expect(result.ok).toBe(true);
		expect(fs.existsSync(projectFile)).toBe(true);
		expect(loadModelOverridesFile(projectFile)).toEqual({
			coder: { model: "vendor/model-a", thinking: "high" },
		});
	});

	it("should make the written value visible to loadModelOverrides immediately (即时生效链路)", () => {
		// Arrange: （无既有文件）

		// Act
		const result = writeOverride(projectFile, "coder", { model: "vendor/model-a" });

		// Assert: 派发路径每次重新 loadModelOverrides(cwd) —— 写完即可读到
		expect(result.ok).toBe(true);
		expect(loadModelOverrides(projectDir)).toEqual({ coder: { model: "vendor/model-a" } });
	});

	it("should update one field while preserving the entry's other field and sibling entries", () => {
		// Arrange
		fs.mkdirSync(path.dirname(projectFile), { recursive: true });
		fs.writeFileSync(
			projectFile,
			JSON.stringify({ coder: { model: "old/model", thinking: "low" }, other: "keep/me" }),
			"utf-8",
		);

		// Act
		const result = writeOverride(projectFile, "coder", { model: "new/model" });

		// Assert
		expect(result.ok).toBe(true);
		expect(readRawJson(projectFile)).toEqual({
			coder: { model: "new/model", thinking: "low" },
			other: "keep/me",
		});
	});

	it("should upgrade a legacy string entry in place, preserving its model when adding thinking", () => {
		// Arrange: 旧格式 "coder": "legacy/m"
		fs.mkdirSync(path.dirname(projectFile), { recursive: true });
		fs.writeFileSync(projectFile, JSON.stringify({ coder: "legacy/m" }), "utf-8");

		// Act
		const result = writeOverride(projectFile, "coder", { thinking: "high" });

		// Assert: 升级为对象格式且不丢既有 model
		expect(result.ok).toBe(true);
		expect(readRawJson(projectFile)).toEqual({ coder: { model: "legacy/m", thinking: "high" } });
		expect(loadModelOverridesFile(projectFile)).toEqual({ coder: { model: "legacy/m", thinking: "high" } });
	});

	it("should support a thinking-only write and read it back", () => {
		// Arrange: （无既有文件）

		// Act
		const result = writeOverride(userFile, "coder", { thinking: "low" });

		// Assert
		expect(result.ok).toBe(true);
		expect(loadModelOverridesFile(userFile)).toEqual({ coder: { thinking: "low" } });
	});

	it("should reject the write without touching Object.prototype when agentName is '__proto__'", () => {
		// Arrange: （无既有文件）

		// Act
		const result = writeOverride(projectFile, "__proto__", { model: "vendor/model-a" });

		// Assert: 整体拒绝（与 A4 防半写语义一致）；不污染 Object.prototype；不落盘
		expect(result.ok).toBe(false);
		expect(({} as Record<string, unknown>).model).toBeUndefined();
		expect(fs.existsSync(projectFile)).toBe(false);
	});

	it("should reject the write without creating a file when agentName is 'constructor'", () => {
		// Arrange: （无既有文件）

		// Act
		const result = writeOverride(projectFile, "constructor", { model: "vendor/model-a" });

		// Assert: 整体拒绝；不落盘
		expect(result.ok).toBe(false);
		expect(fs.existsSync(projectFile)).toBe(false);
	});
});

// ===========================================================================
// A3. 清空语义（patch 字段为 null）
// ===========================================================================
describe("A3. 清空语义：删除配置项后回退 frontmatter，JSON 不残留空对象/空 key", () => {
	it("should remove only the cleared field and keep the entry's remaining field", () => {
		// Arrange
		fs.mkdirSync(path.dirname(projectFile), { recursive: true });
		fs.writeFileSync(projectFile, JSON.stringify({ coder: { model: "m", thinking: "low" } }), "utf-8");

		// Act
		const result = writeOverride(projectFile, "coder", { model: null });

		// Assert
		expect(result.ok).toBe(true);
		const raw = readRawJson(projectFile);
		expect(raw.coder).toEqual({ thinking: "low" });
		expect("model" in raw.coder).toBe(false);
	});

	it("should remove the agent key entirely when its last field is cleared (不留空对象)", () => {
		// Arrange
		fs.mkdirSync(path.dirname(projectFile), { recursive: true });
		fs.writeFileSync(projectFile, JSON.stringify({ coder: { model: "m" }, other: "x/y" }), "utf-8");

		// Act
		const result = writeOverride(projectFile, "coder", { model: null });

		// Assert: coder key 整个移除（不能是 "coder": {}），other 不受影响
		expect(result.ok).toBe(true);
		expect(readRawJson(projectFile)).toEqual({ other: "x/y" });
	});

	it("should remove a legacy string entry when its model is cleared", () => {
		// Arrange
		fs.writeFileSync(userFile, JSON.stringify({ coder: "legacy/m", other: "x/y" }), "utf-8");

		// Act
		const result = writeOverride(userFile, "coder", { model: null });

		// Assert
		expect(result.ok).toBe(true);
		expect(readRawJson(userFile)).toEqual({ other: "x/y" });
	});

	it("should be a no-op when clearing an agent that has no entry, creating neither key nor file", () => {
		// Arrange: 文件存在但无 coder
		fs.writeFileSync(userFile, JSON.stringify({ other: "x/y" }), "utf-8");

		// Act
		const result = writeOverride(userFile, "coder", { model: null, thinking: null });

		// Assert
		expect(result.ok).toBe(true);
		expect(readRawJson(userFile)).toEqual({ other: "x/y" });

		// Act: 文件不存在时清空同样是 no-op，且不得创建文件
		const result2 = writeOverride(projectFile, "coder", { model: null });

		// Assert
		expect(result2.ok).toBe(true);
		expect(fs.existsSync(projectFile)).toBe(false);
	});

	it("should fall back to frontmatter in the merged view after the override is cleared", () => {
		// Arrange: project 级覆盖 model；agent frontmatter 带 fm-model
		fs.mkdirSync(path.dirname(projectFile), { recursive: true });
		fs.writeFileSync(projectFile, JSON.stringify({ coder: { model: "p-model" } }), "utf-8");
		const agents = [makeAgent("coder", { model: "fm-model", thinking: "low" })];

		// Act: 清空 project 级 model 覆盖
		const result = writeOverride(projectFile, "coder", { model: null });

		// Assert: 读链 + 视图链联动 —— 生效值回退 frontmatter
		expect(result.ok).toBe(true);
		const coder = viewOf(agents, loadModelOverridesFile(userFile), loadModelOverridesFile(projectFile)).find(
			(r) => r.name === "coder",
		);
		expect(coder.model).toBe("fm-model");
		expect(coder.modelSource).toBe("frontmatter");
		expect(coder.thinking).toBe("low");
	});
});

// ===========================================================================
// A4. 无效值防护
// ===========================================================================
describe("A4. 无效值防护：整体拒绝，不产生半写状态", () => {
	it("should reject a thinking level outside the official 7 and leave the file byte-identical", () => {
		// Arrange
		fs.mkdirSync(path.dirname(projectFile), { recursive: true });
		const before = JSON.stringify({ coder: { model: "m" } });
		fs.writeFileSync(projectFile, before, "utf-8");

		// Act
		const result = writeOverride(projectFile, "coder", { thinking: "super" });

		// Assert
		expect(result.ok).toBe(false);
		expect(typeof result.error).toBe("string");
		expect(result.error.length).toBeGreaterThan(0);
		expect(fs.readFileSync(projectFile, "utf-8"), "拒绝写入时文件内容必须保持不变").toBe(before);
	});

	it("should reject an empty-string model", () => {
		// Arrange: （无既有文件）

		// Act
		const result = writeOverride(projectFile, "coder", { model: "" });

		// Assert
		expect(result.ok).toBe(false);
		expect(typeof result.error).toBe("string");
		expect(fs.existsSync(projectFile), "拒绝写入时不得创建文件").toBe(false);
	});

	it("should reject a whitespace-only model", () => {
		// Arrange: （无既有文件）

		// Act
		const result = writeOverride(projectFile, "coder", { model: "   " });

		// Assert
		expect(result.ok).toBe(false);
		expect(fs.existsSync(projectFile)).toBe(false);
	});

	it("should reject the whole patch when any field is invalid (不半写)", () => {
		// Arrange
		fs.mkdirSync(path.dirname(projectFile), { recursive: true });
		const before = JSON.stringify({ coder: { model: "old/m" } });
		fs.writeFileSync(projectFile, before, "utf-8");

		// Act: model 合法但 thinking 非法 —— 整个 patch 必须被拒绝
		const result = writeOverride(projectFile, "coder", { model: "good/m", thinking: "bogus" });

		// Assert: 连合法的 model 字段也不得写入（半写状态禁止）
		expect(result.ok).toBe(false);
		expect(fs.readFileSync(projectFile, "utf-8")).toBe(before);
	});

	it("should refuse to write when the target file contains invalid JSON (不覆写用户手写内容)", () => {
		// Arrange
		fs.mkdirSync(path.dirname(projectFile), { recursive: true });
		const before = "{ 这不是合法 JSON, ";
		fs.writeFileSync(projectFile, before, "utf-8");
		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

		// Act
		const result = writeOverride(projectFile, "coder", { model: "m" });

		// Assert
		expect(result.ok).toBe(false);
		expect(typeof result.error).toBe("string");
		expect(fs.readFileSync(projectFile, "utf-8"), "非法 JSON 文件必须原样保留").toBe(before);
		warnSpy.mockRestore();
	});
});

// ===========================================================================
// A5. 未知字段保留
// ===========================================================================
describe("A5. 未知字段保留：写回不破坏用户手写的其它配置", () => {
	it("should preserve unknown top-level keys verbatim", () => {
		// Arrange: 顶层混入未知 key（字符串 / 对象）与其它 agent 的旧格式 entry
		fs.mkdirSync(path.dirname(projectFile), { recursive: true });
		fs.writeFileSync(
			projectFile,
			JSON.stringify({
				$schema: "https://example.com/schema.json",
				notes: { anything: [1, 2, 3] },
				other: "keep/me",
				coder: { model: "old/m" },
			}),
			"utf-8",
		);

		// Act
		const result = writeOverride(projectFile, "coder", { model: "new/m" });

		// Assert: 未知 key 深等于原值，目标字段被更新
		expect(result.ok).toBe(true);
		const raw = readRawJson(projectFile);
		expect(raw.$schema).toBe("https://example.com/schema.json");
		expect(raw.notes).toEqual({ anything: [1, 2, 3] });
		expect(raw.other).toBe("keep/me");
		expect(raw.coder.model).toBe("new/m");
	});

	it("should preserve unknown fields inside the agent's own entry", () => {
		// Arrange: entry 内带用户手写的备注字段
		fs.mkdirSync(path.dirname(projectFile), { recursive: true });
		fs.writeFileSync(projectFile, JSON.stringify({ coder: { model: "old/m", note: "手写的备注" } }), "utf-8");

		// Act
		const result = writeOverride(projectFile, "coder", { thinking: "high" });

		// Assert: note 原样保留（实现不能经由 normalizeOverride 回写——它会丢弃未知字段）
		expect(result.ok).toBe(true);
		expect(readRawJson(projectFile)).toEqual({
			coder: { model: "old/m", thinking: "high", note: "手写的备注" },
		});
	});
});

// ===========================================================================
// A6. 写入目标路径 resolveModelOverridePath
// ===========================================================================
describe("A6. 写入目标路径 resolveModelOverridePath", () => {
	it("should resolve user scope to the subagent-isolation.json under getAgentDir()", () => {
		// Act
		const resolved = resolvePath("user", projectDir);

		// Assert
		expect(resolved).toBe(path.join(userAgentDir, "subagent-isolation.json"));
	});

	it("should resolve project scope to the governing .pi/subagent-isolation.json found by walking up", () => {
		// Arrange: projectDir 下已有 project 级配置；从更深的嵌套目录解析
		fs.mkdirSync(path.dirname(projectFile), { recursive: true });
		fs.writeFileSync(projectFile, "{}", "utf-8");
		const nested = path.join(projectDir, "packages", "app");
		fs.mkdirSync(nested, { recursive: true });

		// Act
		const resolved = resolvePath("project", nested);

		// Assert: 与 loadModelOverrides 的读取侧一致 —— 写到实际管辖该 cwd 的文件
		expect(resolved).toBe(projectFile);
	});

	it("should prefer the nearest project file when several ancestors have one", () => {
		// Arrange: tmpBase 与 projectDir 各有一份 project 级配置
		const outerFile = path.join(tmpBase, ".pi", "subagent-isolation.json");
		fs.mkdirSync(path.dirname(outerFile), { recursive: true });
		fs.writeFileSync(outerFile, "{}", "utf-8");
		fs.mkdirSync(path.dirname(projectFile), { recursive: true });
		fs.writeFileSync(projectFile, "{}", "utf-8");
		const nested = path.join(projectDir, "packages", "app");
		fs.mkdirSync(nested, { recursive: true });

		// Act
		const resolved = resolvePath("project", nested);

		// Assert: 最近者胜（与读取侧的 walk-up 首个命中一致）
		expect(resolved).toBe(projectFile);
	});

	it("should fall back to cwd/.pi/subagent-isolation.json when no project file exists yet", () => {
		// Arrange: 整条祖先链上都没有 project 级配置

		// Act
		const resolved = resolvePath("project", projectDir);

		// Assert
		expect(resolved).toBe(projectFile);
	});
});

// ===========================================================================
// B. 命令契约：/subagent-models 已移除（配置入口唯一化为 /subagent-config）
// ===========================================================================
describe("B. 命令契约：/subagent-models 不再注册（B6 命令移除）", () => {
	function setupExtension() {
		const pi = createMockPi();
		(mod.default as any)(pi);
		return { pi };
	}

	it("should NOT register a /subagent-models command (B6 移除契约：入口唯一化到 /subagent-config)", () => {
		// Act
		const { pi } = setupExtension();

		// Assert: 注册表无此命令，且任何 registerCommand 调用都未使用该命令名
		expect(
			pi._commandDefs.get("subagent-models"),
			"/subagent-models 已移除：model/thinking 编辑由 /subagent-config 统一入口承载",
		).toBeUndefined();
		const registeredNames = vi.mocked(pi.registerCommand).mock.calls.map(([name]) => name);
		expect(registeredNames, "registerCommand 调用中不得出现 subagent-models").not.toContain("subagent-models");
		// 统一入口必须保持注册（防误删）
		expect(pi._commandDefs.get("subagent-config"), "/subagent-config 统一入口必须保持注册").toBeDefined();
	});

	// 【废止说明】原 B7（非 TUI 回退）、零 agent 早退、命令级 happy path 三个
	// 用例钉的是已移除命令的 handler 行为，随命令一并删除：
	// - 非 TUI 回退：/subagent-config 侧的同款契约由 test/agent-config-editor.test.ts 覆盖；
	// - 零 agent：/subagent-config 零 agent 不早退（$models 管理入口可用），契约见
	//   test/available-models.test.ts 与 test/agent-config-editor.test.ts；
	// - 编辑流程本体：由本文件 B8 组（子流程形态）直接钉住，无需命令层中转。
});

// ===========================================================================
// B8. 编辑流程 editAgentModelConfig（子流程形态：agentName 必传，假 UI 驱动）
// ===========================================================================
describe("B8. 编辑流程 editAgentModelConfig（子流程形态：agentName 必传）", () => {
	it("should write the project-level file on the full model-editing happy path", async () => {
		// Arrange: agentName 必传（父流程预选）—— 第一个提问即字段选择
		const { ui, mismatches, leftover, notifyMock } = createScriptedUi([
			{ select: "model" }, // 1. 选择字段
			{ input: "vendor/m-new" }, // 2. 输入新值
			{ select: "project" }, // 3. 选择写入目标
		]);

		// Act
		await runEditorFlow({ ui, cwd: projectDir, agents: [makeAgent("coder")], agentName: "coder" });

		// Assert
		expect(mismatches).toEqual([]);
		expect(leftover).toEqual([]);
		expect(loadModelOverridesFile(projectFile)).toEqual({ coder: { model: "vendor/m-new" } });
		expect(fs.existsSync(userFile)).toBe(false);
		expect(notifyMock.mock.calls.some(([m]) => String(m).includes("coder"))).toBe(true);
	});

	it("should offer the 7 official thinking levels as a select and write the chosen level to the user-level file", async () => {
		// Arrange
		const { ui, calls, mismatches, leftover } = createScriptedUi([
			{ select: "thinking" }, // 1. 选择字段
			{ select: "high" }, // 2. 官方 7 级别 select
			{ select: "user" }, // 3. 写入目标
		]);

		// Act
		await runEditorFlow({ ui, cwd: projectDir, agents: [makeAgent("coder", { thinking: "low" })], agentName: "coder" });

		// Assert: thinking 的取值必须通过 select 提供官方 7 级别（不允许自由输入）
		expect(mismatches).toEqual([]);
		expect(leftover).toEqual([]);
		const levelCall = calls.find(
			(c) => c.kind === "select" && c.options !== undefined && c.options.some((o) => o.includes("off")) && c.options.some((o) => o.includes("max")),
		);
		expect(levelCall, "应有一个提供 thinking 级别的 select 步骤").toBeDefined();
		expect(levelCall!.options!.length).toBeGreaterThanOrEqual(7);
		for (const level of ["off", "minimal", "low", "medium", "high", "xhigh", "max"]) {
			expect(levelCall!.options!.some((o) => o.includes(level)), `thinking 选项缺 ${level}`).toBe(true);
		}
		// 写入的是级别本身（"high"），不是展示标签
		expect(loadModelOverridesFile(userFile)).toEqual({ coder: { thinking: "high" } });
		expect(fs.existsSync(projectFile)).toBe(false);
	});

	// 【需求变更】agent 选择步骤已随子流程化移除（agentName 必传），原
	// "agent 选择步取消零写入"用例废止，由以下两条契约替代（运行时 + 类型层）。
	it("should never open an agent picker when agentName is omitted (运行时装甲：独立 agent 选择入口已移除)", async () => {
		// Arrange: 脚本备好 coder 应答 —— 若实现仍弹出 agent picker 会被消费并留在 calls 记录里
		const { ui, calls } = createScriptedUi([{ select: "coder" }]);

		// Act: 故意缺省 agentName（经 any 访问器绕过类型层；类型钉见下条用例）
		await runEditorFlow({ ui, cwd: projectDir, agents: [makeAgent("coder"), makeAgent("writer")] });

		// Assert: 不得出现"选项恰为 agent 名单"的 picker；任何情况下零写入
		const agentPicker = calls.find(
			(c) => c.kind === "select" && c.options?.includes("coder") && c.options?.includes("writer"),
		);
		expect(agentPicker, "子流程化后不存在独立 agent 选择入口（agentName 必传）").toBeUndefined();
		expect(fs.existsSync(userFile)).toBe(false);
		expect(fs.existsSync(projectFile)).toBe(false);
	});

	it("should type agentName as a required parameter of editAgentModelConfig (类型钉)", () => {
		// 类型钉机制（同 D6，方向相反）：红阶段当前签名为 agentName?: string
		// （可选），下述缺参赋值编译通过，tsc 保持干净；coder 子流程化改为
		// agentName: string 必传后，该赋值产生编译错误 —— 届时为其补一行
		// directive（即 @ts-expect-error，注意不得置于注释行首）即完成转绿；
		// 此后任何人把参数改回可选都会触发 unused 指令报错，类型层永久钉死
		// "无 agentName 的独立入口调用不合法"。
		type EditorDeps = Parameters<typeof mod.editAgentModelConfig>[0];
		// @ts-expect-error — agentName: string 必传后，本赋值缺 agentName 报 TS2741，此指令被消费；改回可选则本指令报 unused，类型层钉死
		const depsWithoutAgentName: EditorDeps = {
			ui: undefined as unknown as ModelConfigEditorUI,
			cwd: projectDir,
			agents: [],
		};

		// Assert: 运行时仅消费变量（类型钉在编译层生效）
		expect(depsWithoutAgentName.agents).toEqual([]);
	});

	it("should write nothing when the user cancels at the value-input step", async () => {
		// Arrange: 值输入步 ESC → 回字段选择（统一逐级回退）；字段选择 ESC → 完全退出
		const { ui, mismatches, leftover } = createScriptedUi([
			{ select: "model" },
			{ input: undefined },
			{ select: undefined },
		]);

		// Act
		await runEditorFlow({ ui, cwd: projectDir, agents: [makeAgent("coder")], agentName: "coder" });

		// Assert
		expect(mismatches).toEqual([]);
		expect(leftover).toEqual([]);
		expect(fs.existsSync(userFile)).toBe(false);
		expect(fs.existsSync(projectFile)).toBe(false);
	});

	it("should write nothing when the user cancels at the write-target step", async () => {
		// Arrange: 目标选择步取消 —— 写入目标 ESC → 回值步 → 值步 ESC → 回字段选择
		// → 字段选择 ESC → 完全退出（统一逐级回退，任何已收集的值都不得提前落盘）
		const { ui, mismatches, leftover } = createScriptedUi([
			{ select: "model" },
			{ input: "vendor/m" },
			{ select: undefined },
			{ input: undefined },
			{ select: undefined },
		]);

		// Act
		await runEditorFlow({ ui, cwd: projectDir, agents: [makeAgent("coder")], agentName: "coder" });

		// Assert
		expect(mismatches).toEqual([]);
		expect(leftover).toEqual([]);
		expect(fs.existsSync(userFile), "选定写入目标前不得写 user 级文件").toBe(false);
		expect(fs.existsSync(projectFile), "选定写入目标前不得写 project 级文件").toBe(false);
	});

	it("should go straight to field selection when the required agentName is given (子流程形态：无 agent 选择步)", async () => {
		// Arrange: 必传参数 agentName = coder —— 第一个提问必须是字段选择，不得再列 agent
		const { ui, calls, mismatches, leftover } = createScriptedUi([
			{ select: "model" },
			{ input: "vendor/m" },
			{ select: "user" },
		]);

		// Act
		await runEditorFlow({ ui, cwd: projectDir, agents: [makeAgent("coder"), makeAgent("writer")], agentName: "coder" });

		// Assert
		expect(mismatches).toEqual([]);
		expect(leftover).toEqual([]);
		const offeredOptions = calls.filter((c) => c.kind === "select").flatMap((c) => c.options ?? []);
		expect(offeredOptions.some((o) => o === "coder" || o === "writer"), "预选 agent 后不应再出现 agent 选择步骤").toBe(false);
		expect(loadModelOverridesFile(userFile)).toEqual({ coder: { model: "vendor/m" } });
	});

	it("should notify an error and not crash when the preselected agentName is unknown", async () => {
		// Arrange
		const { ui, calls, notifyMock } = createScriptedUi([]);

		// Act
		await runEditorFlow({ ui, cwd: projectDir, agents: [makeAgent("coder")], agentName: "ghost" });

		// Assert: 不提问、不写文件、有错误提示
		expect(calls).toHaveLength(0);
		expect(notifyMock).toHaveBeenCalled();
		const [message, type] = notifyMock.mock.calls[0];
		expect(String(message)).toMatch(/ghost/);
		expect(["error", "warning"]).toContain(type);
		expect(fs.existsSync(userFile)).toBe(false);
		expect(fs.existsSync(projectFile)).toBe(false);
	});

	it("should not write anything when the model value entered is empty (无效值在 UI 层被拦下)", async () => {
		// Arrange: 输入空串 model —— 无论实现选择报错结束还是重新提问，都不得落盘
		const { ui } = createScriptedUi([{ select: "model" }, { input: "" }]);

		// Act
		await runEditorFlow({ ui, cwd: projectDir, agents: [makeAgent("coder")], agentName: "coder" });

		// Assert: promise 正常 resolve（不挂起不抛异常）且无任何写入
		expect(fs.existsSync(userFile)).toBe(false);
		expect(fs.existsSync(projectFile)).toBe(false);
	});

	it("should fall back to a free-text input for the model value when no $models list is configured (向后兼容契约)", async () => {
		// 新语义下本用例显式钉死回退路径：$models 未配置（user/project 文件都不
		// 存在）→ 空列表 → model 值步骤必须是自由 input（子流程化后无 agent
		// 选择步，提问类型序列 select → input → select）。$models 非空时的
		// select 语义见 test/available-models.test.ts。
		// Arrange
		const { ui, calls, mismatches, leftover } = createScriptedUi([
			{ select: "model" },
			{ input: "vendor/free-input" },
			{ select: "user" },
		]);

		// Act
		await runEditorFlow({ ui, cwd: projectDir, agents: [makeAgent("coder")], agentName: "coder" });

		// Assert
		expect(mismatches).toEqual([]);
		expect(leftover).toEqual([]);
		expect(calls.map((c) => c.kind), "空 $models 列表时 model 值步骤必须是 input（fallback）").toEqual([
			"select",
			"input",
			"select",
		]);
		expect(loadModelOverridesFile(userFile)).toEqual({ coder: { model: "vendor/free-input" } });
	});
});

// ===========================================================================
// D. UX 改进（红阶段）：选项标注当前值 + input 预填"在原值上修改"
// ===========================================================================
// 断言全部走 calls 记录（子串/正则匹配），与实现文案润色解耦。标注是追加内容，
// 既有英文 key 子串匹配用例（B8/B11 等）必须保持绿。
describe("D. UX 改进：选项标注当前值与 input 预填（红阶段契约）", () => {
	// ---------------------------------------------------------------------
	// D1. 字段选择 select 标注当前生效值
	// ---------------------------------------------------------------------
	it("should annotate the model field option with the current effective model and its source", async () => {
		// Arrange: frontmatter model 被 user 级 json 覆盖 —— 生效 vendor/override-m（来源 user）。
		// 覆盖值特意不含 "user" 字样，使 /\buser\b/ 只能来自来源标注。
		fs.writeFileSync(userFile, JSON.stringify({ coder: { model: "vendor/override-m" } }), "utf-8");
		const { ui, calls, mismatches, leftover } = createScriptedUi([{ select: undefined }]); // 字段选择步取消

		// Act
		await runEditorFlow({ ui, cwd: projectDir, agents: [makeAgent("coder", { model: "fm/coder-model" })], agentName: "coder" });

		// Assert: 字段 select 的 model 选项（排除 clear 项）含生效值与来源标记
		expect(mismatches).toEqual([]);
		expect(leftover).toEqual([]);
		const fieldCall = calls.find((c) => c.kind === "select" && c.options?.some((o) => /clear/i.test(o)));
		expect(fieldCall, "应有字段选择 select（含 clear 项）").toBeDefined();
		const modelOption = fieldCall!.options!.find((o) => /\bmodel\b/i.test(o) && !/clear/i.test(o));
		expect(modelOption, "字段选项中应有 model 项").toBeDefined();
		expect(modelOption!, "model 选项应标注当前生效值").toContain("vendor/override-m");
		expect(modelOption!, "model 选项应标注生效来源（user 级覆盖）").toMatch(/\buser\b/i);
	});

	it("should annotate the thinking field option with the current effective thinking level", async () => {
		// Arrange: frontmatter thinking=medium，无任何 json 覆盖
		const { ui, calls, mismatches, leftover } = createScriptedUi([{ select: undefined }]); // 字段选择步取消

		// Act
		await runEditorFlow({ ui, cwd: projectDir, agents: [makeAgent("coder", { thinking: "medium" })], agentName: "coder" });

		// Assert
		expect(mismatches).toEqual([]);
		expect(leftover).toEqual([]);
		const fieldCall = calls.find((c) => c.kind === "select" && c.options?.some((o) => /clear/i.test(o)));
		expect(fieldCall, "应有字段选择 select（含 clear 项）").toBeDefined();
		const thinkingOption = fieldCall!.options!.find((o) => /\bthinking\b/i.test(o) && !/clear/i.test(o));
		expect(thinkingOption, "字段选项中应有 thinking 项").toBeDefined();
		expect(thinkingOption!, "thinking 选项应标注当前生效级别").toContain("medium");
	});

	// ---------------------------------------------------------------------
	// D2. thinking 级别 select 标注当前生效级别
	// ---------------------------------------------------------------------
	it("should mark exactly the current effective level in the thinking-level select", async () => {
		// Arrange: 生效 thinking = low（frontmatter）
		const { ui, calls, mismatches, leftover } = createScriptedUi([
			{ select: "thinking" }, // 字段选择
			{ select: undefined }, // 级别选择步（值步）ESC → 回字段选择（统一逐级回退）
			{ select: undefined }, // 字段选择 ESC → 完全退出（零写入）
		]);

		// Act
		await runEditorFlow({ ui, cwd: projectDir, agents: [makeAgent("coder", { thinking: "low" })], agentName: "coder" });

		// Assert: 官方 7 级别完整（B8 语义不变）；恰好一个选项带 current 标记且为 low
		expect(mismatches).toEqual([]);
		expect(leftover).toEqual([]);
		const levelCall = calls.find(
			(c) => c.kind === "select" && c.options?.some((o) => o.includes("off")) && c.options?.some((o) => o.includes("max")),
		);
		expect(levelCall, "应有 thinking 级别 select").toBeDefined();
		for (const level of ["off", "minimal", "low", "medium", "high", "xhigh", "max"]) {
			expect(levelCall!.options!.some((o) => o.includes(level)), `级别选项缺 ${level}`).toBe(true);
		}
		const marked = levelCall!.options!.filter((o) => /current/i.test(o));
		expect(marked, "恰好一个级别选项应带 current 标记").toHaveLength(1);
		expect(marked[0], "带 current 标记的应是当前生效级别 low").toContain("low");
	});

	// ---------------------------------------------------------------------
	// D3. 写入目标 select 标注当前生效来源
	// ---------------------------------------------------------------------
	it("should mark the current effective source (user) in the write-target select", async () => {
		// Arrange: user 级 model 覆盖生效中
		fs.writeFileSync(userFile, JSON.stringify({ coder: { model: "vendor/user-m" } }), "utf-8");
		const before = fs.readFileSync(userFile, "utf-8");
		const { ui, calls, mismatches, leftover } = createScriptedUi([
			{ select: "model" }, // 字段选择
			{ input: "vendor/new-m" }, // 新值
			{ select: undefined }, // 写入目标 ESC → 回值步（统一逐级回退）
			{ input: undefined }, // 值步 ESC → 回字段选择
			{ select: undefined }, // 字段选择 ESC → 完全退出（零写入）
		]);

		// Act
		await runEditorFlow({ ui, cwd: projectDir, agents: [makeAgent("coder", { model: "fm/m" })], agentName: "coder" });

		// Assert: 恰好一个目标选项带 current 标记，且对应当前生效来源 user
		expect(mismatches).toEqual([]);
		expect(leftover).toEqual([]);
		const targetCall = calls.find(
			(c) =>
				c.kind === "select" &&
				c.options?.some((o) => /\buser\b/i.test(o)) &&
				c.options?.some((o) => /\bproject\b/i.test(o)),
		);
		expect(targetCall, "应有写入目标 select（user/project）").toBeDefined();
		const marked = targetCall!.options!.filter((o) => /current/i.test(o));
		expect(marked, "恰好一个写入目标选项应带 current 标记").toHaveLength(1);
		expect(marked[0], "带 current 标记的应是当前生效来源 user").toMatch(/\buser\b/i);
		// 取消零写入：既有覆盖文件字节不变，对侧不建文件
		expect(fs.readFileSync(userFile, "utf-8")).toBe(before);
		expect(fs.existsSync(projectFile)).toBe(false);
	});

	it("should mark the current effective source (project) in the write-target select", async () => {
		// Arrange: project 级 model 覆盖生效中
		fs.mkdirSync(path.dirname(projectFile), { recursive: true });
		fs.writeFileSync(projectFile, JSON.stringify({ coder: { model: "vendor/proj-m" } }), "utf-8");
		const before = fs.readFileSync(projectFile, "utf-8");
		const { ui, calls, mismatches, leftover } = createScriptedUi([
			{ select: "model" },
			{ input: "vendor/new-m" },
			{ select: undefined }, // 写入目标 ESC → 回值步（统一逐级回退）
			{ input: undefined }, // 值步 ESC → 回字段选择
			{ select: undefined }, // 字段选择 ESC → 完全退出（零写入）
		]);

		// Act
		await runEditorFlow({ ui, cwd: projectDir, agents: [makeAgent("coder", { model: "fm/m" })], agentName: "coder" });

		// Assert
		expect(mismatches).toEqual([]);
		expect(leftover).toEqual([]);
		const targetCall = calls.find(
			(c) =>
				c.kind === "select" &&
				c.options?.some((o) => /\buser\b/i.test(o)) &&
				c.options?.some((o) => /\bproject\b/i.test(o)),
		);
		expect(targetCall, "应有写入目标 select（user/project）").toBeDefined();
		const marked = targetCall!.options!.filter((o) => /current/i.test(o));
		expect(marked, "恰好一个写入目标选项应带 current 标记").toHaveLength(1);
		expect(marked[0], "带 current 标记的应是当前生效来源 project").toMatch(/\bproject\b/i);
		expect(fs.readFileSync(projectFile, "utf-8")).toBe(before);
		expect(fs.existsSync(userFile)).toBe(false);
	});

	// ---------------------------------------------------------------------
	// D4. model fallback input 预填当前生效 model（第三参 initial）
	// ---------------------------------------------------------------------
	it("should prefill the model fallback input with the current effective model via the initial parameter", async () => {
		// Arrange: 生效 model = fm/coder-model（frontmatter）；$models 空 → fallback input
		const { ui, calls, mismatches, leftover } = createScriptedUi([
			{ select: "model" },
			{ input: "vendor/brand-new" },
			{ select: "user" },
		]);

		// Act
		await runEditorFlow({ ui, cwd: projectDir, agents: [makeAgent("coder", { model: "fm/coder-model" })], agentName: "coder" });

		// Assert: initial = 当前生效值；脚本应答值照常写回（提交语义不变）
		expect(mismatches).toEqual([]);
		expect(leftover).toEqual([]);
		const inputCall = calls.find((c) => c.kind === "input");
		expect(inputCall, "$models 空时 model 值步骤应为 input").toBeDefined();
		expect(inputCall!.initial, "model 输入应预填当前生效 model").toBe("fm/coder-model");
		expect(loadModelOverridesFile(userFile)).toEqual({ coder: { model: "vendor/brand-new" } });
	});

	it("should prefill the model fallback input with the json-override value when it shadows the frontmatter", async () => {
		// Arrange: project 级覆盖 vendor/proj-m 遮蔽 frontmatter fm/m
		fs.mkdirSync(path.dirname(projectFile), { recursive: true });
		fs.writeFileSync(projectFile, JSON.stringify({ coder: { model: "vendor/proj-m" } }), "utf-8");
		const { ui, calls, mismatches, leftover } = createScriptedUi([
			{ select: "model" },
			{ input: "vendor/another" },
			{ select: "user" },
		]);

		// Act
		await runEditorFlow({ ui, cwd: projectDir, agents: [makeAgent("coder", { model: "fm/m" })], agentName: "coder" });

		// Assert: 预填值取生效值（json 覆盖优先于 frontmatter）
		expect(mismatches).toEqual([]);
		expect(leftover).toEqual([]);
		const inputCall = calls.find((c) => c.kind === "input");
		expect(inputCall!.initial, "预填值应是生效 model（json 覆盖优先于 frontmatter）").toBe("vendor/proj-m");
	});

	it("should pass an empty string (not undefined) as initial when no model is configured anywhere (空值契约)", async () => {
		// Arrange: 无 frontmatter model、无任何覆盖
		const { ui, calls, mismatches, leftover } = createScriptedUi([
			{ select: "model" },
			{ input: "vendor/first" },
			{ select: "user" },
		]);

		// Act
		await runEditorFlow({ ui, cwd: projectDir, agents: [makeAgent("coder")], agentName: "coder" });

		// Assert: 钉死空值契约 —— 无当前值时 initial 为空串（调用方无需判空）
		expect(mismatches).toEqual([]);
		expect(leftover).toEqual([]);
		const inputCall = calls.find((c) => c.kind === "input");
		expect(inputCall!.initial, "无配置时 initial 应为空串而非 undefined/省略").toBe("");
	});

	// ---------------------------------------------------------------------
	// D5. 预填不改变取消语义
	// ---------------------------------------------------------------------
	it("should keep cancel semantics on a prefilled input: Esc after prefill writes nothing", async () => {
		// Arrange: 生效 model = fm/coder-model；值输入步 ESC → 回字段选择（统一逐级
		// 回退）；字段选择 ESC → 完全退出（预填不改变回退语义，零写入）
		const { ui, calls, mismatches, leftover } = createScriptedUi([
			{ select: "model" },
			{ input: undefined },
			{ select: undefined },
		]);

		// Act
		await runEditorFlow({ ui, cwd: projectDir, agents: [makeAgent("coder", { model: "fm/coder-model" })], agentName: "coder" });

		// Assert: 预填仍发生（initial 已传入），但取消 = 零写入
		expect(mismatches).toEqual([]);
		expect(leftover).toEqual([]);
		expect(calls.find((c) => c.kind === "input")!.initial, "取消场景同样应传入预填值").toBe("fm/coder-model");
		expect(fs.existsSync(userFile)).toBe(false);
		expect(fs.existsSync(projectFile)).toBe(false);
	});

	// ---------------------------------------------------------------------
	// D6. 类型钉：ModelConfigEditorUI.input 三参签名
	// ---------------------------------------------------------------------
	it("should type ModelConfigEditorUI.input with an optional third initial parameter (类型钉)", async () => {
		// Arrange: 假 UI 本身已声明三参（结构化兼容两参/三参接口）。
		// 类型钉机制：@ts-expect-error 消费当前两参签名下三参调用的编译错误
		// （红阶段 tsc 干净）；coder 把接口扩展为 (title, placeholder?, initial?)
		// 后，tsc 报 "unused @ts-expect-error directive" —— 删除该指令即转绿。
		// 运行时部分验证假 UI 的 initial 记录链路（本用例运行时预期绿，红在类型层）。
		const { ui, calls } = createScriptedUi([{ input: "submitted" }]);
		const typedUi: ModelConfigEditorUI = ui;

		// Act
		const value = await typedUi.input("New model", "provider/model-id", "current/model");

		// Assert
		expect(value).toBe("submitted");
		expect(calls[0].initial, "假 UI 应记录第三参 initial").toBe("current/model");
	});
});

// ===========================================================================
// H. 进程内存级临时覆盖（红阶段契约）
// ===========================================================================
// 语义：内存覆盖层为模块级单例（随扩展生命周期；reload 后消失属预期——临时语
// 义）。优先级链：process > project json > user json > frontmatter。写入目标三
// 选一（this process / user / project）：选 this process 只写内存不落盘；clear
// 作用于内存层时清除该 agent 的覆盖并回退到文件配置。resetProcessOverridesForTests
// 模拟进程退出/reload（测试间隔离，参照 resetProgressManagerForTests 模式）。
// 数据层契约：computeEffectiveModelConfigs 第 4 参（可选）携带内存层；来源标注
// 数据字面量为 process（UI 文案可渲染为 this process，断言用子串匹配）。
describe("H. 进程内存级临时覆盖（红阶段契约）", () => {
	beforeEach(() => {
		// 测试间隔离：清空模块级内存覆盖层（红阶段函数不存在时跳过）。
		(mod as any).resetProcessOverridesForTests?.();
	});

	afterEach(() => {
		// 密闭：最后一个用例若留有覆盖，同文件后续 describe 会继承（测试卫生）。
		(mod as any).resetProcessOverridesForTests?.();
	});

	// ---------------------------------------------------------------------
	// H1. 内存层 API 形态与读写
	// ---------------------------------------------------------------------
	it("should export the process-override API (set/get/clear/reset)", () => {
		expect(typeof (mod as any).setProcessOverride).toBe("function");
		expect(typeof (mod as any).getProcessOverrides).toBe("function");
		expect(typeof (mod as any).clearProcessOverride).toBe("function");
		expect(typeof (mod as any).resetProcessOverridesForTests).toBe("function");
	});

	it("should start empty after reset (进程退出/reload 后消失)", () => {
		// Act
		const overrides = getProcessOverrides();

		// Assert
		expect(overrides).toEqual({});
	});

	it("should round-trip setProcessOverride/getProcessOverrides", () => {
		// Act
		const result = setProcessOverride("coder", { model: "proc/m", thinking: "high" });

		// Assert
		expect(result).toEqual({ ok: true });
		expect(getProcessOverrides()).toEqual({ coder: { model: "proc/m", thinking: "high" } });
	});

	it("should remove a single field on a null patch and drop the entry when the last field is cleared", () => {
		// Arrange
		setProcessOverride("coder", { model: "proc/m", thinking: "high" });

		// Act: null 清除 model 字段，thinking 保留
		setProcessOverride("coder", { model: null });

		// Assert
		expect(getProcessOverrides()).toEqual({ coder: { thinking: "high" } });

		// Act: 清除最后一个字段 → 整 key 移除（不残留空对象）
		setProcessOverride("coder", { thinking: null });

		// Assert
		expect(getProcessOverrides()).toEqual({});
	});

	it("should remove the whole entry via clearProcessOverride", () => {
		// Arrange
		setProcessOverride("coder", { model: "proc/m" });
		setProcessOverride("writer", { model: "proc/w" });

		// Act
		clearProcessOverride("coder");

		// Assert: 只清除指名 agent，其它 entry 不受影响
		expect(getProcessOverrides()).toEqual({ writer: { model: "proc/w" } });
	});

	it("should reject reserved keys like the file writer does (原型污染防护)", () => {
		// Act
		const result = setProcessOverride("__proto__", { model: "evil/m" });

		// Assert
		expect(result).toEqual({ ok: false, error: expect.stringMatching(/reserved/i) });
		expect(getProcessOverrides()).toEqual({});
	});

	it("should empty the layer on resetProcessOverridesForTests (模拟进程退出/reload)", () => {
		// Arrange
		setProcessOverride("coder", { model: "proc/m" });
		setProcessOverride("writer", { thinking: "low" });
		expect(getProcessOverrides()).not.toEqual({});

		// Act
		(mod as any).resetProcessOverridesForTests();

		// Assert
		expect(getProcessOverrides()).toEqual({});
	});

	// ---------------------------------------------------------------------
	// H2. 优先级链：process > project json > user json > frontmatter
	// ---------------------------------------------------------------------
	it("should give the process layer top priority over project/user/frontmatter", () => {
		// Arrange: 四层同 agent 各配一值（第 4 参 = 内存层）
		const agents = [makeAgent("coder", { model: "fm/m", thinking: "minimal" })];

		// Act
		const result = viewOf(
			agents,
			{ coder: { model: "u/m" } },
			{ coder: { thinking: "low" } },
			{ coder: { model: "proc/m", thinking: "high" } },
		);

		// Assert
		const coder = result.find((r) => r.name === "coder");
		expect(coder.model).toBe("proc/m");
		expect(coder.modelSource).toBe("process");
		expect(coder.thinking).toBe("high");
		expect(coder.thinkingSource).toBe("process");
	});

	it("should let the process layer shadow lower layers per whole-key replacement (整 key 遮蔽)", () => {
		// 与既有 A1 整 key 语义一致：process entry 只配 thinking 时，user 级同 key
		// entry 的 model 对运行时不可见 → model 回退 frontmatter，而非按字段合并 user。
		// Arrange
		const agents = [makeAgent("coder", { model: "fm/m", thinking: "minimal" })];

		// Act
		const result = viewOf(agents, { coder: { model: "u/m" } }, {}, { coder: { thinking: "high" } });

		// Assert
		const coder = result.find((r) => r.name === "coder");
		expect(coder.thinking).toBe("high");
		expect(coder.thinkingSource).toBe("process");
		expect(coder.model, "user 级 model 被 process 级同 key entry 整体遮蔽，应回退 frontmatter").toBe("fm/m");
		expect(coder.modelSource).toBe("frontmatter");
	});

	it("should leave lower layers effective when the process layer has no entry for the agent", () => {
		// Arrange: process 层只有别的 agent（等价于未配置）
		const agents = [makeAgent("coder", { model: "fm/m" })];

		// Act
		const result = viewOf(agents, { coder: { model: "u/m" } }, {}, { writer: { model: "proc/w" } });

		// Assert
		const coder = result.find((r) => r.name === "coder");
		expect(coder.model).toBe("u/m");
		expect(coder.modelSource).toBe("user");
	});

	it("should mark the process source when only the process layer configures the agent", () => {
		// Arrange
		const agents = [makeAgent("coder", { model: "fm/m" })];

		// Act
		const result = viewOf(agents, {}, {}, { coder: { model: "proc/m" } });

		// Assert: process 未配字段且无低层配置 → 保持未配置
		const coder = result.find((r) => r.name === "coder");
		expect(coder.model).toBe("proc/m");
		expect(coder.modelSource).toBe("process");
		expect(coder.thinking).toBeUndefined();
		expect(coder.thinkingSource).toBeUndefined();
	});

	// ---------------------------------------------------------------------
	// H3. 写入目标三选一：this process / user / project
	// ---------------------------------------------------------------------
	it("should offer this process as a third write-target option and mark it current when the process layer governs", async () => {
		// Arrange: 内存层 model 覆盖生效中（遮蔽 frontmatter）
		setProcessOverride("coder", { model: "proc/m" });
		const { ui, calls, mismatches, leftover } = createScriptedUi([
			{ select: "model" }, // 字段选择
			{ input: "vendor/new-m" }, // 新值
			{ select: undefined }, // 写入目标 ESC → 回值步（标注断言后逐级退出）
			{ input: undefined }, // 值步 ESC → 回字段选择
			{ select: undefined }, // 字段选择 ESC → 完全退出（零写入）
		]);

		// Act
		await runEditorFlow({ ui, cwd: projectDir, agents: [makeAgent("coder", { model: "fm/m" })], agentName: "coder" });

		// Assert: 三选项齐备；恰好一个 current 标记且在 this process 上
		expect(mismatches).toEqual([]);
		expect(leftover).toEqual([]);
		const targetCall = calls.find(
			(c) =>
				c.kind === "select" &&
				c.options?.some((o) => /\buser\b/i.test(o)) &&
				c.options?.some((o) => /\bproject\b/i.test(o)),
		);
		expect(targetCall, "应有写入目标 select").toBeDefined();
		expect(
			targetCall!.options!.some((o) => o.includes("this process")),
			"写入目标 select 应含 this process 选项（英文 key）",
		).toBe(true);
		const marked = targetCall!.options!.filter((o) => /current/i.test(o));
		expect(marked, "恰好一个写入目标选项应带 current 标记").toHaveLength(1);
		expect(marked[0], "带 current 标记的应是 this process（内存层生效）").toMatch(/process/i);
		// 零写入
		expect(fs.existsSync(userFile)).toBe(false);
		expect(fs.existsSync(projectFile)).toBe(false);
	});

	it("should offer this process as an unmarked third option when no layer configures the agent", async () => {
		// Arrange: 无任何配置（frontmatter 也无 model）→ 无 current 标记
		const { ui, calls, mismatches, leftover } = createScriptedUi([
			{ select: "model" },
			{ input: "vendor/new-m" },
			{ select: undefined }, // 写入目标 ESC → 回值步
			{ input: undefined }, // 值步 ESC → 回字段选择
			{ select: undefined }, // 字段选择 ESC → 完全退出
		]);

		// Act
		await runEditorFlow({ ui, cwd: projectDir, agents: [makeAgent("coder")], agentName: "coder" });

		// Assert: 三选项齐备；未配置来源 → 无 current 标记
		expect(mismatches).toEqual([]);
		expect(leftover).toEqual([]);
		const targetCall = calls.find(
			(c) =>
				c.kind === "select" &&
				c.options?.some((o) => /\buser\b/i.test(o)) &&
				c.options?.some((o) => /\bproject\b/i.test(o)),
		);
		expect(targetCall, "应有写入目标 select").toBeDefined();
		expect(
			targetCall!.options!.some((o) => o.includes("this process")),
			"写入目标 select 应含 this process 选项（英文 key）",
		).toBe(true);
		expect(
			targetCall!.options!.filter((o) => /current/i.test(o)),
			"无配置来源时不得有 current 标记",
		).toHaveLength(0);
		expect(fs.existsSync(userFile)).toBe(false);
		expect(fs.existsSync(projectFile)).toBe(false);
	});

	// ---------------------------------------------------------------------
	// H4. 选 this process 写入：只写内存、不落盘、生效值立即变化
	// ---------------------------------------------------------------------
	it("should write to the process layer without touching any file when this process is chosen", async () => {
		// Arrange
		const { ui, mismatches, leftover } = createScriptedUi([
			{ select: "model" }, // 字段选择
			{ input: "vendor/proc-m" }, // 新值
			{ select: "this process" }, // 写入目标 this process
		]);

		// Act
		await runEditorFlow({ ui, cwd: projectDir, agents: [makeAgent("coder", { model: "fm/m" })], agentName: "coder" });

		// Assert: 内存层写入；user/project 文件都不存在（不落盘）
		expect(mismatches).toEqual([]);
		expect(leftover).toEqual([]);
		expect(getProcessOverrides()).toEqual({ coder: { model: "vendor/proc-m" } });
		expect(fs.existsSync(userFile), "选 this process 不得写 user 级文件").toBe(false);
		expect(fs.existsSync(projectFile), "选 this process 不得写 project 级文件").toBe(false);
		// 生效值立即变化：内存层并入后视图取 process 值
		const view = viewOf([makeAgent("coder", { model: "fm/m" })], {}, {}, getProcessOverrides());
		const coder = view.find((r) => r.name === "coder");
		expect(coder.model).toBe("vendor/proc-m");
		expect(coder.modelSource).toBe("process");
	});

	// ---------------------------------------------------------------------
	// H5. 字段标注与预填反映内存层来源
	// ---------------------------------------------------------------------
	it("should annotate the field options with the process-layer value and source", async () => {
		// Arrange: 内存层 model/thinking 覆盖生效（遮蔽 frontmatter）
		setProcessOverride("coder", { model: "proc/m", thinking: "low" });
		const { ui, calls, mismatches, leftover } = createScriptedUi([{ select: undefined }]); // 字段选择步取消

		// Act
		await runEditorFlow({ ui, cwd: projectDir, agents: [makeAgent("coder", { model: "fm/m", thinking: "medium" })], agentName: "coder" });

		// Assert: 覆盖值自含可辨识子串；来源标注 process（子串匹配）
		expect(mismatches).toEqual([]);
		expect(leftover).toEqual([]);
		const fieldCall = calls.find((c) => c.kind === "select" && c.options?.some((o) => /clear/i.test(o)));
		expect(fieldCall, "应有字段选择 select").toBeDefined();
		const modelOption = fieldCall!.options!.find((o) => /\bmodel\b/i.test(o) && !/clear/i.test(o));
		expect(modelOption!, "model 选项应标注内存层生效值").toContain("proc/m");
		expect(modelOption!, "model 选项应标注来源 process").toMatch(/process/i);
		const thinkingOption = fieldCall!.options!.find((o) => /\bthinking\b/i.test(o) && !/clear/i.test(o));
		expect(thinkingOption!, "thinking 选项应标注内存层生效值").toContain("low");
		expect(thinkingOption!, "thinking 选项应标注来源 process").toMatch(/process/i);
	});

	it("should prefill the model fallback input with the process-layer effective value", async () => {
		// Arrange: 内存层 model 覆盖生效（优先级最高）
		setProcessOverride("coder", { model: "proc/m" });
		const { ui, calls, mismatches, leftover } = createScriptedUi([
			{ select: "model" },
			{ input: "vendor/new" },
			{ select: "user" },
		]);

		// Act
		await runEditorFlow({ ui, cwd: projectDir, agents: [makeAgent("coder", { model: "fm/m" })], agentName: "coder" });

		// Assert: 预填值 = 内存层生效 model（遮蔽 frontmatter）
		expect(mismatches).toEqual([]);
		expect(leftover).toEqual([]);
		const inputCall = calls.find((c) => c.kind === "input");
		expect(inputCall, "$models 空时 model 值步骤应为 input").toBeDefined();
		expect(inputCall!.initial, "预填值应是内存层生效 model").toBe("proc/m");
	});

	// ---------------------------------------------------------------------
	// H6. clear 作用于内存层：清除覆盖 → 生效值回退文件配置（反馈正确）
	// ---------------------------------------------------------------------
	it("should clear the process-layer override and fall back to the file config with correct feedback", async () => {
		// Arrange: user 级 model 覆盖 + 内存层覆盖（内存层遮蔽 user）
		fs.writeFileSync(userFile, JSON.stringify({ coder: { model: "user/keep-m" } }), "utf-8");
		setProcessOverride("coder", { model: "proc/m" });
		const before = fs.readFileSync(userFile, "utf-8");
		const { ui, mismatches, leftover, notifyMock } = createScriptedUi([
			{ select: /clear.*model|model.*clear/i }, // 字段选择 clear model（无值步）
			{ select: "this process" }, // 写入目标 this process
		]);

		// Act
		await runEditorFlow({ ui, cwd: projectDir, agents: [makeAgent("coder", { model: "fm/m" })], agentName: "coder" });

		// Assert: 内存层清除；文件字节不变；clear 反馈 = 清除后重算的生效值（回退 user 级）
		expect(mismatches).toEqual([]);
		expect(leftover).toEqual([]);
		expect(getProcessOverrides(), "clear 后内存层应清空该 agent 的覆盖").toEqual({});
		expect(fs.readFileSync(userFile, "utf-8"), "clear this process 不得改写文件").toBe(before);
		expect(fs.existsSync(projectFile)).toBe(false);
		const clearNotify = notifyMock.mock.calls.map((args) => String(args[0])).find((s) => /cleared/i.test(s)) ?? "";
		expect(clearNotify, "clear 反馈应含回退后的生效值（user 级）").toContain("user/keep-m");
		expect(clearNotify, "clear 反馈不得宣称被清除的内存层值").not.toContain("proc/m");
	});
});
