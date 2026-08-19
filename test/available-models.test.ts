/**
 * $models（可用 model 列表）需求变更 TDD 红阶段契约测试。
 *
 * 背景：阶段 1/2 已验收，阶段 3（/subagent-config）进行中。用户拍板的需求变更：
 *  1. 可用 model 列表统一由 subagent-isolation.json 顶层 "$models" 字段（JSON 数组）
 *     承载（项目从未读取过无扩展名 subagent-models 文本文件，不存在历史格式迁移）。
 *     "$" 前缀避免与 agent 名冲突：
 *       { "$models": ["kimi-coding/k3-256k", ...], "tester": { "model": ... } }
 *  2. editAgentModelConfig 的 model 分支从"自由文本 input"改为"从 $models 列表
 *     select"；列表为空时回退 input 自由输入（向后兼容——阶段 2/3 既有用例全部
 *     运行在无 $models 的环境，走 fallback，断言不受影响，见
 *     model-config-editor.test.ts 头注与逐案分析）。
 *  3. $models 列表本身可增删：/subagent-config 顶层提供"可用 model 列表管理"
 *     入口。
 *
 * 已验证的兼容性事实（本文件 M5 用回归测试钉死，预期绿）：
 *  - normalizeOverride 对数组值返回 undefined → $models 不产生 override，
 *    loadModelOverridesFile / loadModelOverrides 读取语义不变；
 *  - writeModelOverride 保留顶层未知 key → $models 不会被覆盖写破坏；
 *  - loadModelOverrides 按 key 整体替换语义不变。
 *
 * 本文件钉死的契约（红阶段：除 M3 的 fallback 用例与 M5 兼容用例外全部预期
 * 失败，待 coder 实现后转绿）：
 *
 * M1. 读取 loadAvailableModels(cwd) →
 *     { models: string[]; source?: "user" | "project"; filePath?: string }
 *     （返回结果对象，不抛异常；models 为空时 source/filePath 为 undefined）。
 *     - 生效列表的取舍与读取侧一致：project 管辖文件（从 cwd 向上 walk-up 找到
 *       的第一个 .pi/subagent-isolation.json，同 resolveModelOverridePath /
 *       loadModelOverrides 读取侧）的 $models 是合法数组 → 用 project 的
 *       （整体覆盖 user，与按 key 整体替换语义一致）；否则 user 级
 *       getAgentDir()/subagent-isolation.json 的 $models 是合法数组 → 用
 *       user 的；都没有 → 空列表。
 *     - $models 非数组（字符串/对象/数字）→ 视为不存在。
 *     - 数组项清洗：非字符串项丢弃；字符串项 trim 后为空丢弃；去重（保留首次
 *       出现顺序）。
 * M2. 增删 updateAvailableModels(filePath, patch) →
 *     { ok: true } | { ok: false; error: string }（结果对象风格与
 *     writeModelOverride 一致，不抛异常）。patch = { add?: string; remove?:
 *     string }，add 与 remove 必须恰好二选一。
 *     - add：trim 后非空、不得含任何空白字符（非法格式整体拒绝，ok:false，
 *       不产生半写/不建文件）；去重（已存在 → ok:true 幂等，不重复追加）；
 *       追加到列表末尾；目标文件不存在 → 创建（含父目录）；$models 原有值
 *       非数组 → 视为空列表基底重写为 [新值]。
 *     - remove：目标不存在（列表无此项/无 $models key/文件不存在）→ ok:true
 *       no-op，不建文件；删到最后一项 → 保留 "$models": []（空数组 key 不删，
 *       使 project 级可以显式遮蔽 user 级列表）。
 *     - 防半写：全部校验先于任何写入；目标文件是非法 JSON → 拒绝覆写且字节
 *       不变。写回保留顶层其它 key（agent 配置、未知 key）逐字语义（深等于）。
 *     - 往返兼容：写回后可被 loadAvailableModels 读回（$models 是字符串数组）。
 * M3. model 编辑新语义（editAgentModelConfig 的 model 分支）：
 *     loadAvailableModels(cwd).models 非空 → 值步骤用 ui.select，选项恰为
 *     列表项（数量相等、每项包含对应 model ID），选中项的【model ID 本身】
 *     被写入；列表为空 → 回退 ui.input（向后兼容，本用例预期绿）。
 * M4. /subagent-config 入口：agent 选择列表中插入"可用 model 列表管理"特殊
 *     选项（标签同时含英文 key "model" 与 "list"）。进入后【动作选择菜单即
 *     列表】（本轮重构，M7 契约）：选项 = 当前 $models 列表每项（格式
 *     `${model} (${source})`，来源标记与 loadAvailableModels 的 source 一
 *     致；顺序 = 列表顺序）+ "add model" + "back"；列表为空时菜单恰为
 *     ["add model", "back"]；菜单不含 view/查看 选项（不再有"查看"动作，
 *     列表就在菜单里）。add：选 "add model" → input 输入 model ID → 选择
 *     写入目标（user/project，复用阶段 2 resolveModelOverridePath 语义）→
 *     写回 → 确认提示（info，含 model ID）。删除：选中列表中的模型 →
 *     ui.confirm 确认（防误删，指名被删模型）→ 确认后选择写入目标 → 写回
 *     → 回动作选择（菜单基于最新列表重建）；确认取消 → 不删除、回动作选
 *     择。任一步取消零写入；非法输入 error 提示且零写入。阶段 4 清单 8：
 *     零 agent（无 agentName 参数）时命令不得早退——picker 仍含管理入口且
 *     add 流程可用（红阶段，待 coder 解除 no-agents 守卫）；有 agent 时
 *     agent 选项与入口并存（控制用例，预期绿）。
 * M5. 兼容性回归钉（预期绿）：loadModelOverridesFile 忽略 $models key；
 *     writeModelOverride 保留 $models 逐字。
 *
 * M4+. UX 改进（本轮红阶段追加）：$models 管理流程的写入目标 select
 *     （user/project）标注当前生效列表来源——恰好一个选项带 "current" 标记，
 *     且对应 loadAvailableModels 的 source（user 级列表生效 → user 带标记；
 *     project 同理）。标注为追加内容，既有子串匹配用例保持绿。
 *
 * 【A1 移交适配】M3 的 4 处 runEditorFlow 调用已随 editAgentModelConfig
 *     子流程化（agentName 必传、无独立 agent 选择步）适配：补传
 *     agentName: "coder"、删脚本首步 agent 选择、call 索引/序列断言减项
 *     （fallback 用例 ["select","select","input","select"] → ["select","input","select"]）。
 *     前 3 个用例对适配前/后实现均应保持绿；值步取消用例升级为 ESC 回退
 *     语义（见下），红阶段预期失败。
 *
 * M4++. ESC 逐级回退（editAvailableModelsList，本轮红阶段追加）：写入目标
 *     ESC → 回值步（add 重输入 / 删除重选，重收集的值覆盖先前值）；值步
 *     ESC → 回动作选择（菜单即列表，可换 add 或改选模型）；动作选择 ESC
 *     或选中 "back" → 返回调用方（/subagent-config 的 agent 选择，可继续
 *     选 agent 编辑）。回退全程零写入；写入成功后回到动作选择（本轮语义变
 *     更：可连续 add/删除多个 model，仅 ESC 逐级回退退出——动作选择 ESC →
 *     回 agent 选择；agent 选择 ESC → 完全退出）。既有 M4 动作步取消、M4
 *     写入目标步取消、M4+ 两条写入目标标注用例从"取消即退出"改为"逐级回退
 *     再退出"（脚本追加逐级 ESC，零写入断言保留）；M4/M4++ 的 happy path
 *     （写回即结束）用例脚本末尾追加"动作选择 ESC + agent 选择 ESC"步，写
 *     回断言保留。
 *
 * M7. 菜单即列表（本轮重构红阶段契约）：动作选择菜单选项 = 当前模型列表
 *     （每项 `${model} (${source})` 来源标记，顺序 = 列表顺序）+ "add
 *     model" + "back"；每次回到动作选择时菜单基于最新列表重建（增删后立
 *     即可见）；选中模型 → 确认删除（ui.confirm，指名被删模型）→ 写入目标
 *     → 落盘（user/project 双侧）；确认取消 → 不删除、回动作选择；空列表
 *     → 菜单恰为 ["add model", "back"]；"back" → 返回 agent 选择（与动作
 *     选择 ESC 同义）；菜单不含 view/查看 选项。
 *
 * 红阶段技术说明：新导出尚不存在，全部经 (mod as any) 命名空间访问，使失败
 * 落在断言/调用处（"xxx is not a function"），而非模块导入期；同时保证本测试
 * 文件在严格单文件 typecheck 下无错误。测试假 UI 的 confirm 为脚本化步骤
 * （{ confirm: boolean }，记录 kind: "confirm" 调用）；未脚本化时宽容兜底返
 * 回 true，不破坏未钉确认步的既有用例。
 */

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as mod from "../src/index.ts";
import { loadModelOverridesFile } from "../src/index.ts";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

// 只 mock 模块边界 getAgentDir（user 级配置目录）；其余保持真实。
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

/** 预期签名：(cwd) => { models: string[]; source?: "user" | "project"; filePath?: string } */
function loadAvailable(cwd: string): any {
	return (mod as any).loadAvailableModels(cwd);
}

/** 预期签名：(filePath, patch: { add?: string; remove?: string }) => { ok: true } | { ok: false; error: string } */
function updateAvailable(filePath: string, patch: any): any {
	return (mod as any).updateAvailableModels(filePath, patch);
}

/** 阶段 2 已有导出：(deps: { ui, cwd, agents, agentName? }) => Promise<unknown> */
function runEditorFlow(deps: any): Promise<unknown> {
	return (mod as any).editAgentModelConfig(deps);
}

// ---------------------------------------------------------------------------
// Helpers（与阶段 2/3 测试同款模式）
// ---------------------------------------------------------------------------

/** 构造一个 AgentConfig 形状的测试 agent（宽松 any：流程函数只需 name）。 */
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

/** 读取目标文件的原始 JSON（看 $models 与其它 key 的原始内容）。 */
function readRawJson(filePath: string): any {
	return JSON.parse(fs.readFileSync(filePath, "utf-8"));
}

/**
 * 脚本化假 UI（Fake，非 mock 内部模块）：与阶段 2/3 同款。按队列依次应答
 * select/input，记录每次提问（kind/title/options）；应答与提问类型不匹配或
 * 选项无匹配时记入 mismatches 并返回 undefined（等价用户取消）。字符串应答
 * 先精确匹配、再退到子串匹配；RegExp 应答取第一个匹配的选项。应答为
 * undefined 表示用户在该步取消（Esc）。
 */
type UiStep =
	| { select: string | RegExp | undefined }
	| { input: string | undefined }
	/** 删除确认（防误删契约）：true = 确认删除，false = 取消（回动作选择）。 */
	| { confirm: boolean };

interface UiCall {
	kind: "select" | "input" | "confirm";
	title: string;
	options?: string[];
	placeholder?: string;
	/** input 的第三参 initial（预填当前值，UX 改进契约）。流程未传时为 undefined。 */
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
		// confirm 为脚本化步骤（{ confirm: boolean }）并记录调用（kind:
		// "confirm"）。未脚本化（既有用例未钉确认步）时宽容兜底返回 true，
		// 不影响主流程断言；脚本化了但实现未提问 → 该步留队，后续 select/
		// input 消费它时报 mismatch（红）。
		confirm: async (title?: string, _message?: string): Promise<boolean> => {
			calls.push({ kind: "confirm", title: String(title ?? "") });
			const step = queue.shift();
			if (!step || !("confirm" in step)) {
				mismatches.push(`confirm("${title}") 被提问，但下一个脚本步骤是 ${JSON.stringify(step)}`);
				return true;
			}
			return step.confirm;
		},
		notify: notifyMock,
	};
	return { ui, calls, mismatches, notifyMock, leftover: queue };
}

/** 汇总全部 notify 文本。 */
function allNotifyText(notifyMock: ReturnType<typeof vi.fn>): string {
	return notifyMock.mock.calls.map((args) => String(args[0])).join("\n");
}

/** 构造捕获注册表的 mock pi（与阶段 2/3 测试同款）。 */
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

/** "可用 model 列表管理"入口选项的匹配模式：标签同时含英文 key model 与 list。 */
const MODELS_ENTRY_PATTERN = /model.*list|list.*model/i;

// ---------------------------------------------------------------------------
// 共享 fixture：每个测试独立 tmp 目录；getAgentDir 指向 tmp 下 user-agent 目录
// ---------------------------------------------------------------------------

let tmpBase: string;
let userAgentDir: string;
let projectDir: string;
let agentsDir: string;
let userFile: string;
let projectFile: string;

beforeEach(() => {
	tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "available-models-test-"));
	userAgentDir = path.join(tmpBase, "user-agent");
	projectDir = path.join(tmpBase, "project");
	agentsDir = path.join(projectDir, ".pi", "agents");
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

/** 在 projectDir/.pi/agents/ 写一个最小合法 agent 文件（入口流程需要至少一个 agent）。 */
function writeProjectAgent(name: string): void {
	fs.mkdirSync(agentsDir, { recursive: true });
	fs.writeFileSync(
		path.join(agentsDir, `${name}.md`),
		`---\nname: ${name}\ndescription: ${name} agent\n---\nYou are ${name}.\n`,
		"utf-8",
	);
}

/** 写一个 subagent-isolation.json（自动建父目录）。 */
function writeIsolationFile(filePath: string, content: unknown): void {
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	fs.writeFileSync(filePath, typeof content === "string" ? content : JSON.stringify(content), "utf-8");
}

// ===========================================================================
// C. 衔接契约：新函数独立导出
// ===========================================================================
describe("C. 衔接契约：$models 读写函数独立导出", () => {
	it("should export loadAvailableModels as a function", () => {
		expect(typeof (mod as any).loadAvailableModels).toBe("function");
	});

	it("should export updateAvailableModels as a function", () => {
		expect(typeof (mod as any).updateAvailableModels).toBe("function");
	});

	it("should keep every stage-1/2 export intact (防误删)", () => {
		expect(typeof mod.isThinkingLevel).toBe("function");
		expect(typeof mod.normalizeOverride).toBe("function");
		expect(typeof mod.loadModelOverridesFile).toBe("function");
		expect(typeof mod.loadModelOverrides).toBe("function");
		expect(typeof mod.discoverAgents).toBe("function");
		expect(typeof mod.computeEffectiveModelConfigs).toBe("function");
		expect(typeof mod.writeModelOverride).toBe("function");
		expect(typeof mod.resolveModelOverridePath).toBe("function");
		expect(typeof mod.editAgentModelConfig).toBe("function");
	});
});

// ===========================================================================
// M1. 读取：loadAvailableModels
// ===========================================================================
describe("M1. 读取 loadAvailableModels（project 覆盖 user，非法值视为空）", () => {
	it("should return the user-level $models list with source 'user' when only the user file has one", () => {
		// Arrange
		writeIsolationFile(userFile, { $models: ["kimi-coding/k3-256k", "opencode-go/deepseek-v4-flash"] });

		// Act
		const result = loadAvailable(projectDir);

		// Assert
		expect(result.models).toEqual(["kimi-coding/k3-256k", "opencode-go/deepseek-v4-flash"]);
		expect(result.source).toBe("user");
		expect(result.filePath).toBe(userFile);
	});

	it("should let the project-level $models list shadow the user-level one wholesale", () => {
		// Arrange: 两侧都有合法 $models —— project 整体覆盖 user（按 key 整体替换语义）
		writeIsolationFile(userFile, { $models: ["u/user-model"] });
		writeIsolationFile(projectFile, { $models: ["p/project-model"] });

		// Act
		const result = loadAvailable(projectDir);

		// Assert
		expect(result.models).toEqual(["p/project-model"]);
		expect(result.source).toBe("project");
		expect(result.filePath).toBe(projectFile);
	});

	it("should fall back to the user-level list when the governing project file has no $models key", () => {
		// Arrange: project 文件存在但无 $models key
		writeIsolationFile(userFile, { $models: ["u/user-model"] });
		writeIsolationFile(projectFile, { coder: { model: "keep/me" } });

		// Act
		const result = loadAvailable(projectDir);

		// Assert
		expect(result.models).toEqual(["u/user-model"]);
		expect(result.source).toBe("user");
	});

	it("should return an empty list when neither level configures $models", () => {
		// Arrange: （两侧文件都不存在）

		// Act
		const result = loadAvailable(projectDir);

		// Assert
		expect(result.models).toEqual([]);
		expect(result.source).toBeUndefined();
		expect(result.filePath).toBeUndefined();
	});

	it.each([["a-plain-string"], [{ nested: true }], [42]])(
		"should treat a non-array models-list value (%j) as absent",
		(badValue) => {
			// Arrange: user 级 $models 是非法类型
			writeIsolationFile(userFile, { $models: badValue, coder: { model: "keep/me" } });

			// Act
			const result = loadAvailable(projectDir);

			// Assert: 视为未配置 —— 空列表、无来源
			expect(result.models).toEqual([]);
			expect(result.source).toBeUndefined();
		},
	);

	it("should filter non-string/blank items, trim entries, and drop duplicates", () => {
		// Arrange
		writeIsolationFile(userFile, {
			$models: ["keep/one", 42, "", "   ", null, "keep/two", "keep/one", "  padded/m  "],
		});

		// Act
		const result = loadAvailable(projectDir);

		// Assert: 非字符串/纯空白丢弃；trim；去重保留首次出现顺序
		expect(result.models).toEqual(["keep/one", "keep/two", "padded/m"]);
	});

	it("should read the governing project file found by walking up from a nested cwd", () => {
		// Arrange: 从更深的嵌套目录解析，与读取侧 walk-up 一致
		writeIsolationFile(projectFile, { $models: ["p/nested-cwd"] });
		const nested = path.join(projectDir, "packages", "app");
		fs.mkdirSync(nested, { recursive: true });

		// Act
		const result = loadAvailable(nested);

		// Assert
		expect(result.models).toEqual(["p/nested-cwd"]);
		expect(result.source).toBe("project");
	});
});

// ===========================================================================
// M2. 增删：updateAvailableModels
// ===========================================================================
describe("M2. 增删 updateAvailableModels（校验先于写入，往返兼容）", () => {
	it("should create the file (and parent dirs) with the new model when adding to a non-existent path", () => {
		// Arrange: projectFile 的父目录 .pi/ 尚不存在
		expect(fs.existsSync(projectFile)).toBe(false);

		// Act
		const result = updateAvailable(projectFile, { add: "kimi-coding/k3-256k" });

		// Assert: ok + 文件创建 + $models 是字符串数组 + 可被读取端立即读回
		expect(result.ok).toBe(true);
		expect(fs.existsSync(projectFile)).toBe(true);
		expect(readRawJson(projectFile)).toEqual({ $models: ["kimi-coding/k3-256k"] });
		const reread = loadAvailable(projectDir);
		expect(reread.models).toEqual(["kimi-coding/k3-256k"]);
		expect(reread.source).toBe("project");
	});

	it("should append to an existing list, preserving order and sibling agent entries", () => {
		// Arrange
		writeIsolationFile(userFile, {
			$models: ["u/existing"],
			coder: { model: "keep/me", thinking: "low" },
		});

		// Act
		const result = updateAvailable(userFile, { add: "new-vendor/model-x" });

		// Assert: 追加到末尾；agent 配置 entry 逐字保留
		expect(result.ok).toBe(true);
		expect(readRawJson(userFile)).toEqual({
			$models: ["u/existing", "new-vendor/model-x"],
			coder: { model: "keep/me", thinking: "low" },
		});
	});

	it("should be idempotent when adding a model that is already in the list (去重)", () => {
		// Arrange
		writeIsolationFile(userFile, { $models: ["u/existing", "u/other"] });

		// Act
		const result = updateAvailable(userFile, { add: "u/existing" });

		// Assert: ok 且不产生重复项
		expect(result.ok).toBe(true);
		expect(readRawJson(userFile).$models).toEqual(["u/existing", "u/other"]);
	});

	it.each([["", "empty string"], ["   ", "whitespace only"], ["white space/model", "embedded whitespace"]])(
		"should reject an invalid add value (%j: %s) without writing or creating anything",
		(badValue) => {
			// Arrange: 场景 a —— 已有文件字节不变；场景 b —— 文件不存在时不得创建
			writeIsolationFile(userFile, { $models: ["u/existing"] });
			const before = fs.readFileSync(userFile, "utf-8");

			// Act
			const result = updateAvailable(userFile, { add: badValue });
			const resultNoFile = updateAvailable(projectFile, { add: badValue });

			// Assert
			expect(result.ok).toBe(false);
			expect(typeof result.error).toBe("string");
			expect(fs.readFileSync(userFile, "utf-8"), "拒绝写入时文件内容必须保持不变").toBe(before);
			expect(resultNoFile.ok).toBe(false);
			expect(fs.existsSync(projectFile), "拒绝写入时不得创建文件").toBe(false);
		},
	);

	it("should refuse to write when the target file contains invalid JSON (不覆写用户手写内容)", () => {
		// Arrange
		const before = "{ 这不是合法 JSON, ";
		writeIsolationFile(userFile, before);
		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

		// Act
		const result = updateAvailable(userFile, { add: "new/m" });

		// Assert
		expect(result.ok).toBe(false);
		expect(typeof result.error).toBe("string");
		expect(fs.readFileSync(userFile, "utf-8"), "非法 JSON 文件必须原样保留").toBe(before);
		warnSpy.mockRestore();
	});

	it("should rewrite a non-array $models value as a fresh single-item list (视为空基底)", () => {
		// Arrange: $models 被用户手写成了字符串
		writeIsolationFile(userFile, { $models: "oops", coder: { model: "keep/me" } });

		// Act
		const result = updateAvailable(userFile, { add: "fresh/m" });

		// Assert: 与读取端"非数组视为空"一致 —— 以空列表为基底重写
		expect(result.ok).toBe(true);
		expect(readRawJson(userFile)).toEqual({ $models: ["fresh/m"], coder: { model: "keep/me" } });
	});

	it("should remove an existing model and keep the remaining list and sibling entries", () => {
		// Arrange
		writeIsolationFile(userFile, { $models: ["a/m-one", "b/m-two"], coder: { model: "keep/me" } });

		// Act
		const result = updateAvailable(userFile, { remove: "a/m-one" });

		// Assert
		expect(result.ok).toBe(true);
		expect(readRawJson(userFile)).toEqual({ $models: ["b/m-two"], coder: { model: "keep/me" } });
	});

	it("should keep an explicit empty $models array when the last item is removed (key 不删)", () => {
		// Arrange
		writeIsolationFile(userFile, { $models: ["only/one"] });

		// Act
		const result = updateAvailable(userFile, { remove: "only/one" });

		// Assert: 保留 "$models": [] —— 空数组是合法配置（如 project 级显式遮蔽 user 列表）
		expect(result.ok).toBe(true);
		expect(readRawJson(userFile)).toEqual({ $models: [] });
	});

	it("should be a no-op when removing a model that is not in the list (不报错不改动)", () => {
		// Arrange
		writeIsolationFile(userFile, { $models: ["a/m-one"] });

		// Act
		const result = updateAvailable(userFile, { remove: "ghost/m" });

		// Assert
		expect(result.ok).toBe(true);
		expect(readRawJson(userFile).$models).toEqual(["a/m-one"]);
	});

	it("should be a no-op without creating anything when removing and the file does not exist", () => {
		// Arrange: （无文件）

		// Act
		const result = updateAvailable(projectFile, { remove: "ghost/m" });

		// Assert
		expect(result.ok).toBe(true);
		expect(fs.existsSync(projectFile), "remove no-op 不得创建文件").toBe(false);
	});

	it("should reject a patch that has neither or both of add/remove (恰好二选一)", () => {
		// Arrange
		writeIsolationFile(userFile, { $models: ["u/existing"] });
		const before = fs.readFileSync(userFile, "utf-8");

		// Act
		const neither = updateAvailable(userFile, {});
		const both = updateAvailable(userFile, { add: "x/m", remove: "u/existing" });

		// Assert
		expect(neither.ok).toBe(false);
		expect(both.ok).toBe(false);
		expect(fs.readFileSync(userFile, "utf-8")).toBe(before);
	});
});

// ===========================================================================
// M3. model 编辑新语义：$models 非空 → select，空 → fallback input
// ===========================================================================
describe("M3. editAgentModelConfig 的 model 分支：列表非空走 select，空回退 input", () => {
	it("should offer exactly the $models list as a select for the model value and write the chosen id verbatim", async () => {
		// Arrange: user 级配置 $models
		writeIsolationFile(userFile, { $models: ["kimi-coding/k3-256k", "opencode-go/deepseek-v4-flash"] });
		// A1 适配：agentName 必传（子流程形态，无 agent 选择步）+ 合并编辑（动作选
		// 择层 → model 值步（$models select）→ thinking 值步 → 写入目标）
		const { ui, calls, mismatches, leftover, notifyMock } = createScriptedUi([
			{ select: "edit model & thinking" }, // 1. 动作选择 edit
			{ select: "kimi-coding/k3-256k" }, // 2. model 值步：从 $models 列表 select
			{ select: "not set" }, // 3. thinking 值步（未配置 current）
			{ select: "project" }, // 4. 写入目标
		]);

		// Act
		await runEditorFlow({ ui, cwd: projectDir, agents: [makeAgent("coder")], agentName: "coder" });

		// Assert: 序列对齐；model 值步骤是 select 而非 input
		expect(mismatches).toEqual([]);
		expect(leftover).toEqual([]);
		expect(calls.every((c) => c.kind === "select"), "$models 非空时不得再出现自由 input").toBe(true);
		const valueCall = calls[1];
		expect(valueCall.options, "model 值 select 的选项应恰为 $models 列表项").toHaveLength(2);
		expect(valueCall.options!.some((o) => o.includes("kimi-coding/k3-256k"))).toBe(true);
		expect(valueCall.options!.some((o) => o.includes("opencode-go/deepseek-v4-flash"))).toBe(true);
		// 写入的是 model ID 本身，不是展示标签；thinking 显式未配置 → 只写 model
		expect(loadModelOverridesFile(projectFile)).toEqual({ coder: { model: "kimi-coding/k3-256k" } });
		expect(notifyMock.mock.calls.some(([m]) => String(m).includes("coder"))).toBe(true);
	});

	it("should source the select options from the project-level list when it shadows the user-level one", async () => {
		// Arrange: 两侧都有 $models —— project 覆盖 user
		writeIsolationFile(userFile, { $models: ["u/user-model"] });
		writeIsolationFile(projectFile, { $models: ["p/model-a", "p/model-b"] });
		// A1 适配：agentName 必传（子流程形态，无 agent 选择步）+ 合并编辑
		const { ui, calls, mismatches, leftover } = createScriptedUi([
			{ select: "edit model & thinking" },
			{ select: "p/model-b" },
			{ select: "not set" },
			{ select: "user" },
		]);

		// Act
		await runEditorFlow({ ui, cwd: projectDir, agents: [makeAgent("coder")], agentName: "coder" });

		// Assert: 选项恰为 project 级列表（user 级列表不可见）
		expect(mismatches).toEqual([]);
		expect(leftover).toEqual([]);
		const valueCall = calls[1];
		expect(valueCall.kind).toBe("select");
		expect(valueCall.options).toHaveLength(2);
		expect(valueCall.options!.some((o) => o.includes("p/model-a"))).toBe(true);
		expect(valueCall.options!.some((o) => o.includes("p/model-b"))).toBe(true);
		expect(valueCall.options!.some((o) => o.includes("u/user-model")), "project 列表生效时不得混入 user 级项").toBe(false);
		expect(loadModelOverridesFile(userFile).coder).toEqual({ model: "p/model-b" });
	});

	it("should fall back to a free-text input when the $models list is empty (向后兼容，预期绿)", async () => {
		// Arrange: （无 $models 配置 —— 与阶段 2/3 全部既有用例的环境相同）

		// Act: A1 适配 —— agentName 必传 + 合并编辑（动作选择 → model 值步 input →
		// thinking 值步 select → 写入目标 select）
		const { ui, calls, mismatches, leftover } = createScriptedUi([
			{ select: "edit model & thinking" },
			{ input: "vendor/free-typed" },
			{ select: "not set" },
			{ select: "user" },
		]);
		await runEditorFlow({ ui, cwd: projectDir, agents: [makeAgent("coder")], agentName: "coder" });

		// Assert: 值步骤是 input；写入 trim 后的自由输入值
		expect(mismatches).toEqual([]);
		expect(leftover).toEqual([]);
		expect(calls.map((c) => c.kind)).toEqual(["select", "input", "select", "select"]);
		expect(loadModelOverridesFile(userFile)).toEqual({ coder: { model: "vendor/free-typed" } });
	});

	it("should return to the action layer on ESC at the model-select step (then exit on action ESC, zero writes)", async () => {
		// Arrange: $models 非空，值选择步 ESC
		writeIsolationFile(userFile, { $models: ["kimi-coding/k3-256k"] });
		const before = fs.readFileSync(userFile, "utf-8");
		// A1 适配 + 合并编辑 ESC 回退语义（同款）：model 值步 ESC → 回动作选择；
		// 动作选择 ESC → 子流程返回（独立调用无父级 = 直接 resolve）
		const { ui, calls, mismatches, leftover } = createScriptedUi([
			{ select: "edit model & thinking" }, // 1. 动作选择 edit
			{ select: undefined }, // 2. model 值步（$models select）ESC → 回动作选择
			{ select: undefined }, // 3. 动作选择步 ESC → 子流程返回
		]);

		// Act
		await runEditorFlow({ ui, cwd: projectDir, agents: [makeAgent("coder")], agentName: "coder" });

		// Assert: 值步 ESC 后回到同一动作选择；全程零写入
		expect(mismatches).toEqual([]);
		expect(leftover).toEqual([]);
		expect(calls).toHaveLength(3);
		expect(calls[2].options, "model 值步 ESC 后应回到动作选择层（选项与首次一致）").toEqual(calls[0].options);
		expect(calls[2].options?.some((o) => /clear/i.test(o)), "动作选择应含 clear 选项（区别于值步 select）").toBe(true);
		expect(fs.readFileSync(userFile, "utf-8")).toBe(before);
		expect(fs.existsSync(projectFile)).toBe(false);
	});
});

// ===========================================================================
// M4. /subagent-config 入口：可用 model 列表管理
// ===========================================================================
describe("M4. /subagent-config 的可用 model 列表管理入口", () => {
	function setupExtension() {
		const pi = createMockPi();
		(mod.default as any)(pi);
		return { pi, command: pi._commandDefs.get("subagent-config") };
	}

	it("should offer a model-list management entry (label containing 'model' and 'list') in the agent picker", async () => {
		// Arrange
		writeProjectAgent("coder");
		const { command } = setupExtension();
		const { ui, calls } = createScriptedUi([{ select: undefined }]); // 第一步取消
		const ctx = { hasUI: true, mode: "tui", cwd: projectDir, ui };

		// Act
		await command.handler("", ctx);

		// Assert: agent 选择列表中有管理入口选项
		expect(calls.length).toBeGreaterThanOrEqual(1);
		const options = calls[0].options ?? [];
		expect(
			options.some((o) => /model/i.test(o) && /list/i.test(o)),
			`agent 选择列表应包含 model-list 管理入口（实际选项 = [${options.join(" | ")}]）`,
		).toBe(true);
		// 取消是安静的：零写入
		expect(fs.existsSync(userFile)).toBe(false);
		expect(fs.existsSync(projectFile)).toBe(false);
	});

	it("should show the current list with source markers as the action menu, and return to the agent picker on ESC at the action step (zero writes)", async () => {
		// Arrange: user 级已有列表
		writeIsolationFile(userFile, { $models: ["u/one", "u/two"] });
		const before = fs.readFileSync(userFile, "utf-8");
		writeProjectAgent("coder");
		const { command } = setupExtension();
		// ESC 回退语义（M4++）：动作选择 ESC → 返回调用方（agent 选择）；agent 选择 ESC → 完全退出
		const { ui, calls, mismatches, leftover } = createScriptedUi([
			{ select: MODELS_ENTRY_PATTERN }, // 1. 进入管理入口
			{ select: undefined }, // 2. 动作选择步 ESC → 回 agent 选择
			{ select: undefined }, // 3. agent 选择 ESC → 完全退出
		]);
		const ctx = { hasUI: true, mode: "tui", cwd: projectDir, ui };

		// Act
		await command.handler("", ctx);

		// Assert: 序列对齐；动作选择菜单即列表（列表项 + 来源标记 + add model + back，
		// 顺序 = 列表顺序）；无独立"查看"选项；回退零写入
		expect(mismatches).toEqual([]);
		expect(leftover).toEqual([]);
		expect(calls[2].options, "动作选择 ESC 后应回到 agent 选择（选项与首次一致）").toEqual(calls[0].options);
		const actionOptions = calls[1].options ?? [];
		expect(actionOptions, "动作选择菜单应 = 列表 + add model + back（含来源标记、保持顺序）").toEqual([
			"u/one (user)",
			"u/two (user)",
			"add model",
			"back",
		]);
		expect(actionOptions.some((o) => /view|查看/i.test(o)), "动作菜单不得含 view/查看 选项（列表就在菜单里）").toBe(false);
		// 回退零写入：文件字节不变
		expect(fs.readFileSync(userFile, "utf-8")).toBe(before);
		expect(fs.existsSync(projectFile)).toBe(false);
	});

	it("should add a model via input and write it to the chosen target file (user)", async () => {
		// Arrange
		writeIsolationFile(userFile, { $models: ["u/existing"], coder: { model: "keep/me" } });
		writeProjectAgent("coder");
		const { command } = setupExtension();
		const { ui, calls, mismatches, leftover, notifyMock } = createScriptedUi([
			{ select: MODELS_ENTRY_PATTERN }, // 1. 管理入口
			{ select: "add model" }, // 2. 动作菜单：add model
			{ input: "new-vendor/model-x" }, // 3. 输入 model ID
			{ select: "user" }, // 4. 写入目标
			{ select: undefined }, // 5. add 写回成功 → 回动作选择；动作选择 ESC → 回 agent 选择
			{ select: undefined }, // 6. agent 选择 ESC → 完全退出
		]);
		const ctx = { hasUI: true, mode: "tui", cwd: projectDir, ui };

		// Act
		await command.handler("", ctx);

		// Assert: 追加到 user 级列表；agent 配置 entry 逐字保留；确认提示含 model ID；
		// 写回后重问的动作菜单已含新 model（菜单即列表，实时反映）
		expect(mismatches).toEqual([]);
		expect(leftover).toEqual([]);
		expect(calls[4].options, "add 写回成功后应回到动作选择（菜单含新 model）").toEqual([
			"u/existing (user)",
			"new-vendor/model-x (user)",
			"add model",
			"back",
		]);
		expect(readRawJson(userFile)).toEqual({
			$models: ["u/existing", "new-vendor/model-x"],
			coder: { model: "keep/me" },
		});
		expect(fs.existsSync(projectFile)).toBe(false);
		const confirmed = notifyMock.mock.calls.some(
			([m, t]) => String(m).includes("new-vendor/model-x") && (t === undefined || t === "info"),
		);
		expect(confirmed, "写回后应有包含 model ID 的确认提示").toBe(true);
	});

	it("should return to the action select after a successful add and allow adding another model (连续 add 语义)", async () => {
		// Arrange: 连续 add 两个 model —— add 写回成功后回动作选择，不退出
		writeIsolationFile(userFile, { $models: ["u/existing"] });
		writeProjectAgent("coder");
		const { command } = setupExtension();
		const { ui, calls, mismatches, leftover, notifyMock } = createScriptedUi([
			{ select: MODELS_ENTRY_PATTERN }, // 1. 管理入口
			{ select: "add model" }, // 2. 动作菜单：add model
			{ input: "new-vendor/m-one" }, // 3. 输入第一个 model ID
			{ select: "user" }, // 4. 写入目标 user → 写回成功 → 回动作选择
			{ select: "add model" }, // 5. 动作选择重问（未退出）→ 再选 add model
			{ input: "new-vendor/m-two" }, // 6. 输入第二个 model ID
			{ select: "project" }, // 7. 写入目标 project → 写回成功 → 回动作选择
			{ select: undefined }, // 8. 动作选择 ESC → 回 agent 选择
			{ select: undefined }, // 9. agent 选择 ESC → 完全退出
		]);
		const ctx = { hasUI: true, mode: "tui", cwd: projectDir, ui };

		// Act
		await command.handler("", ctx);

		// Assert: 两次 add 都落盘；每次写回后都回到动作选择且菜单基于最新列表重建
		// （第一次 add 后 user 列表多一项；第二次 add 写 project 后 project 遮蔽 user
		// → 菜单 = project 列表，M1 遮蔽语义的菜单体现）
		expect(mismatches).toEqual([]);
		expect(leftover).toEqual([]);
		expect(calls[4].options, "第一次 add 写回后菜单应含新 model").toEqual([
			"u/existing (user)",
			"new-vendor/m-one (user)",
			"add model",
			"back",
		]);
		expect(calls[7].options, "第二次 add 写 project 后 project 遮蔽 user → 菜单 = project 列表").toEqual([
			"new-vendor/m-two (project)",
			"add model",
			"back",
		]);
		expect(readRawJson(userFile).$models).toEqual(["u/existing", "new-vendor/m-one"]);
		expect(readRawJson(projectFile).$models).toEqual(["new-vendor/m-two"]);
		// 每次写回后的确认提示保留（含各自 model ID）
		const text = allNotifyText(notifyMock);
		expect(text, "第一个 add 的确认提示应含 model ID").toContain("new-vendor/m-one");
		expect(text, "第二个 add 的确认提示应含 model ID").toContain("new-vendor/m-two");
	});

	it("should delete a model picked from the action menu after an explicit confirmation, writing the chosen target file (user)", async () => {
		// Arrange
		writeIsolationFile(userFile, { $models: ["a/m-one", "b/m-two"] });
		writeProjectAgent("coder");
		const { command } = setupExtension();
		const { ui, calls, mismatches, leftover } = createScriptedUi([
			{ select: MODELS_ENTRY_PATTERN }, // 1. 管理入口
			{ select: "a/m-one" }, // 2. 动作选择=列表：选中要删的模型
			{ confirm: true }, // 3. 删除确认（防误删）
			{ select: "user" }, // 4. 写入目标
			{ select: undefined }, // 5. 删除写回成功 → 回动作选择；动作选择 ESC → 回 agent 选择
			{ select: undefined }, // 6. agent 选择 ESC → 完全退出
		]);
		const ctx = { hasUI: true, mode: "tui", cwd: projectDir, ui };

		// Act
		await command.handler("", ctx);

		// Assert: 动作选择菜单即列表（列表项 + add model + back）；删除前有指名模型的
		// 确认步；写回后仅剩 b/m-two
		expect(mismatches).toEqual([]);
		expect(leftover).toEqual([]);
		expect(calls[1].options, "动作选择菜单应 = 列表 + add model + back").toEqual([
			"a/m-one (user)",
			"b/m-two (user)",
			"add model",
			"back",
		]);
		const confirmCall = calls.find((c) => c.kind === "confirm");
		expect(confirmCall, "删除前必须有确认步（防误删）").toBeDefined();
		expect(confirmCall!.title, "确认提示应指名要删除的模型").toContain("a/m-one");
		expect(readRawJson(userFile).$models).toEqual(["b/m-two"]);
	});

	it("should offer exactly [add model, back] for an empty list and support adding the first model (project target)", async () => {
		// Arrange: 无任何 $models 配置
		writeProjectAgent("coder");
		const { command } = setupExtension();
		const { ui, calls, mismatches, leftover } = createScriptedUi([
			{ select: MODELS_ENTRY_PATTERN },
			{ select: "add model" },
			{ input: "p/first-model" },
			{ select: "project" },
			{ select: undefined }, // add 写回成功 → 回动作选择；动作选择 ESC → 回 agent 选择
			{ select: undefined }, // agent 选择 ESC → 完全退出
		]);
		const ctx = { hasUI: true, mode: "tui", cwd: projectDir, ui };

		// Act
		await command.handler("", ctx);

		// Assert: 空列表时动作菜单恰为 [add model, back]（空态由菜单自身表达）；
		// project 级文件被创建；读取端立即可见
		expect(mismatches).toEqual([]);
		expect(leftover).toEqual([]);
		expect(calls[1].options, "空列表时动作菜单应恰为 [add model, back]").toEqual(["add model", "back"]);
		expect(readRawJson(projectFile)).toEqual({ $models: ["p/first-model"] });
		expect(fs.existsSync(userFile)).toBe(false);
		const reread = loadAvailable(projectDir);
		expect(reread.models).toEqual(["p/first-model"]);
		expect(reread.source).toBe("project");
	});

	it("should walk back level by level on ESC from the write-target step (target → value → action → picker → exit, zero writes)", async () => {
		// Arrange
		writeIsolationFile(userFile, { $models: ["u/existing"] });
		const before = fs.readFileSync(userFile, "utf-8");
		writeProjectAgent("coder");
		const { command } = setupExtension();
		// ESC 回退语义（M4++）：写入目标 ESC → 回值步；值步 ESC → 回动作选择；
		// 动作选择 ESC → 回 agent 选择；agent 选择 ESC → 完全退出
		const { ui, calls, mismatches, leftover } = createScriptedUi([
			{ select: MODELS_ENTRY_PATTERN }, // 1. 管理入口
			{ select: "add model" }, // 2. 动作：添加
			{ input: "x/y" }, // 3. 输入 model ID
			{ select: undefined }, // 4. 写入目标步 ESC → 回值步
			{ input: undefined }, // 5. 值步 ESC → 回动作选择
			{ select: undefined }, // 6. 动作选择 ESC → 回 agent 选择
			{ select: undefined }, // 7. agent 选择 ESC → 完全退出
		]);
		const ctx = { hasUI: true, mode: "tui", cwd: projectDir, ui };

		// Act
		await command.handler("", ctx);

		// Assert: 逐级回退链路（值步重问为 input；动作选择重问含列表 + add model + back；最后回到 agent 选择）
		expect(mismatches).toEqual([]);
		expect(leftover).toEqual([]);
		expect(calls.map((c) => c.kind)).toEqual(["select", "select", "input", "select", "input", "select", "select"]);
		expect(calls[5].options, "值步 ESC 后应回到动作选择（与首次一致）").toEqual(calls[1].options);
		expect(calls[6].options, "动作选择 ESC 后应回到 agent 选择（与首次一致）").toEqual(calls[0].options);
		// 已收集的值不得提前落盘，全链零写入
		expect(fs.readFileSync(userFile, "utf-8")).toBe(before);
		expect(fs.existsSync(projectFile)).toBe(false);
	});

	it("should notify an error and write nothing when the model id entered is invalid", async () => {
		// Arrange: 空串 model ID —— 无论实现选择报错结束还是重新提问，都不得落盘
		writeIsolationFile(userFile, { $models: ["u/existing"] });
		const before = fs.readFileSync(userFile, "utf-8");
		writeProjectAgent("coder");
		const { command } = setupExtension();
		const { ui, notifyMock } = createScriptedUi([
			{ select: MODELS_ENTRY_PATTERN },
			{ select: "add model" },
			{ input: "" },
		]);
		const ctx = { hasUI: true, mode: "tui", cwd: projectDir, ui };

		// Act
		await command.handler("", ctx);

		// Assert: error 级提示 + 零写入（此用例只钉文件状态，不钉对话框序列）
		const errored = notifyMock.mock.calls.some(([, t]) => t === "error");
		expect(errored, "非法 model ID 应有 error 级提示").toBe(true);
		expect(fs.readFileSync(userFile, "utf-8")).toBe(before);
		expect(fs.existsSync(projectFile)).toBe(false);
	});

	// ---------------------------------------------------------------------
	// 阶段 4 清理清单 8：零 agent 时 $models 管理入口仍可达（命令级红阶段）。
	// 现状：handler 在 agents.length===0 && agentName===undefined 时早退
	// notify，$models 管理入口不可达。期望：不早退，picker 仍含管理入口，
	// 选中后管理流程（add）完整走通。首条断言当前即红（零提问）。
	// ---------------------------------------------------------------------

	it("should still open the picker with the $models management entry when zero agents are discovered, and add works end-to-end", async () => {
		// Arrange: user/project 两侧均无 agent（不创建 .pi/agents 目录）
		const { command } = setupExtension();
		const { ui, calls, mismatches, leftover } = createScriptedUi([
			{ select: MODELS_ENTRY_PATTERN }, // 1. 管理入口
			{ select: "add model" }, // 2. 动作菜单：add model
			{ input: "zero-agent/model-x" }, // 3. 输入 model ID
			{ select: "user" }, // 4. 写入目标 user
			{ select: undefined }, // 5. add 写回成功 → 回动作选择；动作选择 ESC → 回 agent 选择
			{ select: undefined }, // 6. agent 选择 ESC → 完全退出
		]);
		const ctx = { hasUI: true, mode: "tui", cwd: projectDir, ui };

		// Act
		await command.handler("", ctx);

		// Assert: 零 agent 不得早退——第一步 select 必须被提问且含管理入口
		expect(
			calls.length,
			"零 agent 时命令不得早退 notify，应仍弹出含 $models 管理入口的选择列表",
		).toBeGreaterThanOrEqual(1);
		const options = calls[0]?.options ?? [];
		expect(
			options.some((o) => /model/i.test(o) && /list/i.test(o)),
			`零 agent 时选择列表应包含 model-list 管理入口（实际选项 = [${options.join(" | ")}]）`,
		).toBe(true);
		// 入口可达语义钉死：选中入口后 add 流程完整走通并落盘
		expect(mismatches).toEqual([]);
		expect(leftover).toEqual([]);
		expect(readRawJson(userFile)).toEqual({ $models: ["zero-agent/model-x"] });
	});

	it("should keep offering discovered agents alongside the $models entry when agents exist (control: 有 agent 时行为不变)", async () => {
		// Arrange
		writeProjectAgent("coder");
		const { command } = setupExtension();
		const { ui, calls } = createScriptedUi([{ select: undefined }]); // 第一步取消
		const ctx = { hasUI: true, mode: "tui", cwd: projectDir, ui };

		// Act
		await command.handler("", ctx);

		// Assert: agent 选项与管理入口同时在列；取消安静（零写入）
		expect(calls.length).toBeGreaterThanOrEqual(1);
		const options = calls[0].options ?? [];
		expect(
			options.some((o) => /coder/.test(o)),
			`有 agent 时 agent 选项应仍在列表中（实际选项 = [${options.join(" | ")}]）`,
		).toBe(true);
		expect(
			options.some((o) => /model/i.test(o) && /list/i.test(o)),
			`有 agent 时管理入口应仍在列表中（实际选项 = [${options.join(" | ")}]）`,
		).toBe(true);
		expect(fs.existsSync(userFile)).toBe(false);
		expect(fs.existsSync(projectFile)).toBe(false);
	});
});

// ===========================================================================
// M5. 兼容性回归钉（预期绿）：$models 不破坏既有读写语义
// ===========================================================================
describe("M5. 兼容性：$models 对既有读取/写回语义零影响", () => {
	it("should make loadModelOverridesFile ignore the $models key (数组不产生 override)", () => {
		// Arrange: $models 与 agent 配置混排
		writeIsolationFile(userFile, {
			$models: ["kimi-coding/k3-256k"],
			coder: { model: "keep/me", thinking: "low" },
		});

		// Act
		const overrides = loadModelOverridesFile(userFile);

		// Assert: $models 不出现在 override 记录中（normalizeOverride 对数组返回 undefined）
		expect(overrides).toEqual({ coder: { model: "keep/me", thinking: "low" } });
		expect("$models" in overrides).toBe(false);
	});

	it("should preserve the $models key verbatim when writeModelOverride updates an agent entry", () => {
		// Arrange
		writeIsolationFile(userFile, { $models: ["kimi-coding/k3-256k"], coder: { model: "old/m" } });

		// Act
		const result = mod.writeModelOverride(userFile, "coder", { thinking: "high" });

		// Assert: agent 字段更新，$models 逐字保留
		expect(result.ok).toBe(true);
		expect(readRawJson(userFile)).toEqual({
			$models: ["kimi-coding/k3-256k"],
			coder: { model: "old/m", thinking: "high" },
		});
	});
});

// ===========================================================================
// M6. 读取鲁棒性：BOM 剥除（\uFEFF 前缀不视为非法 JSON，不被静默忽略）
// ===========================================================================
describe("M6. 读取鲁棒性：带 BOM 的配置文件正常解析", () => {
	it("should return the user-level $models list when the file content has a BOM prefix", () => {
		// Arrange: user 级文件带 \uFEFF 前缀 + 合法 $models
		writeIsolationFile(
			userFile,
			"\uFEFF" + JSON.stringify({ $models: ["kimi-coding/k3-256k", "opencode-go/deepseek-v4-flash"] }),
		);

		// Act
		const result = loadAvailable(projectDir);

		// Assert: BOM 剥除后正常解析，不视为非法 JSON
		expect(result.models).toEqual(["kimi-coding/k3-256k", "opencode-go/deepseek-v4-flash"]);
		expect(result.source).toBe("user");
		expect(result.filePath).toBe(userFile);
	});

	it("should parse the agent override when the file content has a BOM prefix", () => {
		// Arrange: 同文件带 BOM + agent override
		writeIsolationFile(userFile, "\uFEFF" + JSON.stringify({ tester: { model: "x" } }));

		// Act
		const overrides = loadModelOverridesFile(userFile);

		// Assert: BOM 剥除后解析出 override
		expect(overrides).toEqual({ tester: { model: "x" } });
	});
});

// ===========================================================================
// M4+. UX 改进（红阶段）：$models 管理流程的写入目标 select 标注当前生效来源
// ===========================================================================
describe("M4+. UX 改进：$models 写入目标 select 标注当前生效来源（红阶段契约）", () => {
	function setupExtension() {
		const pi = createMockPi();
		(mod.default as any)(pi);
		return { pi, command: pi._commandDefs.get("subagent-config") };
	}

	it("should mark the current effective list source (user) in the write-target select of the add flow", async () => {
		// Arrange: user 级 $models 生效中
		writeIsolationFile(userFile, { $models: ["u/one"] });
		const before = fs.readFileSync(userFile, "utf-8");
		writeProjectAgent("coder");
		const { command } = setupExtension();
		const { ui, calls, mismatches, leftover } = createScriptedUi([
			{ select: MODELS_ENTRY_PATTERN }, // 1. 管理入口
			{ select: "add model" }, // 2. 动作菜单：add model
			{ input: "x/y" }, // 3. 输入 model ID
			{ select: undefined }, // 4. 写入目标步 ESC → 回值步（标注断言后逐级退出）
			{ input: undefined }, // 5. 值步 ESC → 回动作选择
			{ select: undefined }, // 6. 动作选择 ESC → 回 agent 选择
			{ select: undefined }, // 7. agent 选择 ESC → 完全退出
		]);
		const ctx = { hasUI: true, mode: "tui", cwd: projectDir, ui };

		// Act
		await command.handler("", ctx);

		// Assert: 写入目标 select 恰好一个选项带 current 标记，且对应列表来源 user
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
		expect(marked[0], "带 current 标记的应是当前生效列表来源 user").toMatch(/\buser\b/i);
		// 回退零写入：列表文件字节不变，对侧不建文件
		expect(fs.readFileSync(userFile, "utf-8")).toBe(before);
		expect(fs.existsSync(projectFile)).toBe(false);
	});

	it("should mark the current effective list source (project) in the write-target select of the add flow", async () => {
		// Arrange: project 级 $models 生效中（遮蔽 user 级）
		writeIsolationFile(userFile, { $models: ["u/one"] });
		writeIsolationFile(projectFile, { $models: ["p/one"] });
		const beforeUser = fs.readFileSync(userFile, "utf-8");
		const beforeProject = fs.readFileSync(projectFile, "utf-8");
		writeProjectAgent("coder");
		const { command } = setupExtension();
		const { ui, calls, mismatches, leftover } = createScriptedUi([
			{ select: MODELS_ENTRY_PATTERN },
			{ select: "add model" }, // 动作菜单：add model
			{ input: "x/y" },
			{ select: undefined }, // 写入目标步 ESC → 回值步（标注断言后逐级退出）
			{ input: undefined }, // 值步 ESC → 回动作选择
			{ select: undefined }, // 动作选择 ESC → 回 agent 选择
			{ select: undefined }, // agent 选择 ESC → 完全退出
		]);
		const ctx = { hasUI: true, mode: "tui", cwd: projectDir, ui };

		// Act
		await command.handler("", ctx);

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
		expect(marked[0], "带 current 标记的应是当前生效列表来源 project").toMatch(/\bproject\b/i);
		expect(fs.readFileSync(userFile, "utf-8")).toBe(beforeUser);
		expect(fs.readFileSync(projectFile, "utf-8")).toBe(beforeProject);
	});
});

// ===========================================================================
// M4++. ESC 逐级回退：editAvailableModelsList（红阶段契约）
// ===========================================================================
// 写入目标 ESC → 回值步；值步 ESC → 回动作选择（菜单即列表，可换 add 或改选
// 模型）；动作选择 ESC 或选中 "back" → 返回调用方（agent 选择，可继续编辑
// agent）。回退全程零写入；写入成功后回到动作选择（本轮语义变更，可连续增删；
// 仅 ESC 逐级回退退出）。
describe("M4++. ESC 逐级回退：$models 管理子流程（红阶段契约）", () => {
	function setupExtension() {
		const pi = createMockPi();
		(mod.default as any)(pi);
		return { pi, command: pi._commandDefs.get("subagent-config") };
	}

	it("should return to the value step on ESC at the write-target step and write the re-entered value (add flow)", async () => {
		// Arrange
		writeIsolationFile(userFile, { $models: ["u/existing"] });
		writeProjectAgent("coder");
		const { command } = setupExtension();
		const { ui, calls, mismatches, leftover } = createScriptedUi([
			{ select: MODELS_ENTRY_PATTERN }, // 1. 管理入口
			{ select: "add model" }, // 2. 动作菜单：add model
			{ input: "x/first-m" }, // 3. 输入第一个值
			{ select: undefined }, // 4. 写入目标 ESC → 回值步
			{ input: "x/second-m" }, // 5. 重输入（覆盖先前收集值）
			{ select: "user" }, // 6. 写入目标 user
			{ select: undefined }, // 7. 写回成功 → 回动作选择；动作选择 ESC → 回 agent 选择
			{ select: undefined }, // 8. agent 选择 ESC → 完全退出
		]);
		const ctx = { hasUI: true, mode: "tui", cwd: projectDir, ui };

		// Act
		await command.handler("", ctx);

		// Assert: 第 5 次提问是值步 input；只有重输入的值落盘
		expect(mismatches).toEqual([]);
		expect(leftover).toEqual([]);
		expect(calls[4].kind, "写入目标 ESC 后应回到值步（input）").toBe("input");
		expect(readRawJson(userFile).$models, "先前收集的值不得落盘").toEqual(["u/existing", "x/second-m"]);
		expect(fs.existsSync(projectFile)).toBe(false);
	});

	it("should return to the action menu on ESC at the value step and allow switching from add to deleting a model", async () => {
		// Arrange
		writeIsolationFile(userFile, { $models: ["a/m-one", "b/m-two"] });
		writeProjectAgent("coder");
		const { command } = setupExtension();
		const { ui, calls, mismatches, leftover } = createScriptedUi([
			{ select: MODELS_ENTRY_PATTERN }, // 1. 管理入口
			{ select: "add model" }, // 2. 动作菜单：add model
			{ input: undefined }, // 3. 值步 ESC → 回动作选择
			{ select: "a/m-one" }, // 4. 换选列表中的模型（删除入口 = 列表项）
			{ confirm: true }, // 5. 删除确认
			{ select: "user" }, // 6. 写入目标 user
			{ select: undefined }, // 7. 写回成功 → 回动作选择；动作选择 ESC → 回 agent 选择
			{ select: undefined }, // 8. agent 选择 ESC → 完全退出
		]);
		const ctx = { hasUI: true, mode: "tui", cwd: projectDir, ui };

		// Act
		await command.handler("", ctx);

		// Assert: 第 4 次提问是动作选择（菜单即列表：与首次一致，无独立 remove 选项）；
		// 换动作（add → 删除模型）生效
		expect(mismatches).toEqual([]);
		expect(leftover).toEqual([]);
		expect(calls[3].options, "值步 ESC 后应回到动作选择（与首次一致）").toEqual(calls[1].options);
		expect(calls[3].options, "动作选择应 = 列表 + add model + back（无 remove 选项）").toEqual([
			"a/m-one (user)",
			"b/m-two (user)",
			"add model",
			"back",
		]);
		expect(calls[3].options?.some((o) => /remove/i.test(o)), "动作菜单不得含独立 remove 选项（删除入口 = 列表项）").toBe(false);
		expect(readRawJson(userFile).$models, "删除落盘（add 被 ESC 未执行）").toEqual(["b/m-two"]);
		expect(fs.existsSync(projectFile)).toBe(false);
	});

	it("should return to the agent picker on ESC at the action select and allow picking an agent (caller continues)", async () => {
		// Arrange
		writeIsolationFile(userFile, { $models: ["u/one"] });
		const before = fs.readFileSync(userFile, "utf-8");
		writeProjectAgent("coder");
		const { command } = setupExtension();
		const { ui, calls, mismatches, leftover } = createScriptedUi([
			{ select: MODELS_ENTRY_PATTERN }, // 1. 管理入口
			{ select: undefined }, // 2. 动作选择 ESC → 回 agent 选择
			{ select: "coder" }, // 3. 换选 agent coder
			{ select: "description" }, // 4. 字段选择 description
			{ input: "Edited after models-entry ESC" }, // 5. 提交
			{ select: undefined }, // 6. description 写回成功 → 回字段选择；字段选择 ESC → 回 agent 选择
			{ select: undefined }, // 7. agent 选择 ESC → 完全退出
		]);
		const ctx = { hasUI: true, mode: "tui", cwd: projectDir, ui };

		// Act
		await command.handler("", ctx);

		// Assert: 动作选择 ESC 返回调用方（agent 选择），可继续编辑 agent；$models 零写入
		expect(mismatches).toEqual([]);
		expect(leftover).toEqual([]);
		expect(calls[2].options, "动作选择 ESC 后应回到 agent 选择（选项与首次一致）").toEqual(calls[0].options);
		expect(
			calls[2].options?.some((o) => /model/i.test(o) && /list/i.test(o)),
			"agent 选择应仍含 $models 管理入口",
		).toBe(true);
		expect(fs.readFileSync(userFile, "utf-8"), "$models 列表零写入").toBe(before);
		expect(fs.existsSync(projectFile)).toBe(false);
		const reread = fs.readFileSync(path.join(agentsDir, "coder.md"), "utf-8");
		expect(reread, "description 编辑落盘").toContain("Edited after models-entry ESC");
	});
});

// ===========================================================================
// M7. 菜单即列表：$models 动作选择重构（本轮红阶段契约）
// ===========================================================================
// 动作选择菜单选项 = 当前模型列表（每项 `${model} (${source})` 来源标记，
// 顺序 = 列表顺序）+ "add model" + "back"；列表为空时菜单恰为
// ["add model", "back"]；菜单不含 view/查看 选项（不再有"查看"动作，列表就
// 在菜单里）。选中模型 → ui.confirm 确认删除（防误删，指名被删模型）→ 确认
// 后选择写入目标 → 写回；确认取消 → 不删除、回动作选择。每次回到动作选择时
// 菜单基于最新列表重建（增删后立即可见，支持连续增删）。"back" → 返回 agent
// 选择（与动作选择 ESC 同义）。
describe("M7. 菜单即列表：$models 动作选择 = 当前列表 + add model + back（红阶段契约）", () => {
	function setupExtension() {
		const pi = createMockPi();
		(mod.default as any)(pi);
		return { pi, command: pi._commandDefs.get("subagent-config") };
	}

	it("should list the current models with user source markers in the action menu, in list order, with add model and back (菜单即列表)", async () => {
		// Arrange: user 级列表生效
		writeIsolationFile(userFile, { $models: ["kimi-coding/k3-256k", "opencode-go/deepseek-v4-flash"] });
		const before = fs.readFileSync(userFile, "utf-8");
		writeProjectAgent("coder");
		const { command } = setupExtension();
		const { ui, calls, mismatches, leftover } = createScriptedUi([
			{ select: MODELS_ENTRY_PATTERN }, // 1. 进入管理入口
			{ select: undefined }, // 2. 动作选择 ESC → 回 agent 选择
			{ select: undefined }, // 3. agent 选择 ESC → 完全退出
		]);
		const ctx = { hasUI: true, mode: "tui", cwd: projectDir, ui };

		// Act
		await command.handler("", ctx);

		// Assert: 菜单选项精确 = 列表项（含 (user) 标记、保持列表顺序）+ add model + back
		expect(mismatches).toEqual([]);
		expect(leftover).toEqual([]);
		expect(calls[1].options, "动作菜单应 = 列表（来源标记、列表顺序）+ add model + back").toEqual([
			"kimi-coding/k3-256k (user)",
			"opencode-go/deepseek-v4-flash (user)",
			"add model",
			"back",
		]);
		expect(calls[1].options!.some((o) => /view|查看/i.test(o)), "动作菜单不得含 view/查看 选项").toBe(false);
		// 只展示不写：零写入
		expect(fs.readFileSync(userFile, "utf-8")).toBe(before);
		expect(fs.existsSync(projectFile)).toBe(false);
	});

	it("should mark list items with the project source when the project-level list governs (遮蔽语义)", async () => {
		// Arrange: project 级遮蔽 user 级
		writeIsolationFile(userFile, { $models: ["u/one"] });
		writeIsolationFile(projectFile, { $models: ["p/one", "p/two"] });
		writeProjectAgent("coder");
		const { command } = setupExtension();
		const { ui, calls, mismatches, leftover } = createScriptedUi([
			{ select: MODELS_ENTRY_PATTERN },
			{ select: undefined }, // 动作选择 ESC
			{ select: undefined }, // agent 选择 ESC
		]);
		const ctx = { hasUI: true, mode: "tui", cwd: projectDir, ui };

		// Act
		await command.handler("", ctx);

		// Assert: 来源标记与 loadAvailableModels 的 source 一致（project 生效）
		expect(mismatches).toEqual([]);
		expect(leftover).toEqual([]);
		expect(calls[1].options, "生效列表为 project 级时列表项应带 (project) 标记").toEqual([
			"p/one (project)",
			"p/two (project)",
			"add model",
			"back",
		]);
	});

	it("should delete the picked model after an explicit confirmation and write the chosen target file (user)", async () => {
		// Arrange
		writeIsolationFile(userFile, { $models: ["a/m-one", "b/m-two"] });
		writeProjectAgent("coder");
		const { command } = setupExtension();
		const { ui, calls, mismatches, leftover } = createScriptedUi([
			{ select: MODELS_ENTRY_PATTERN }, // 1. 管理入口
			{ select: "a/m-one" }, // 2. 动作菜单=列表：选中要删的模型
			{ confirm: true }, // 3. 删除确认（防误删）
			{ select: "user" }, // 4. 写入目标 user
			{ select: undefined }, // 5. 删除写回 → 回动作选择；ESC → 回 agent 选择
			{ select: undefined }, // 6. agent 选择 ESC → 完全退出
		]);
		const ctx = { hasUI: true, mode: "tui", cwd: projectDir, ui };

		// Act
		await command.handler("", ctx);

		// Assert: 确认步发生在模型选中与写入目标之间、指名被删模型；删除落盘到所选目标
		expect(mismatches).toEqual([]);
		expect(leftover).toEqual([]);
		const confirmCall = calls.find((c) => c.kind === "confirm");
		expect(confirmCall, "删除前必须有确认步").toBeDefined();
		expect(confirmCall!.title, "确认提示应指名要删除的模型").toContain("a/m-one");
		expect(readRawJson(userFile).$models, "删除写回 user 级").toEqual(["b/m-two"]);
		expect(fs.existsSync(projectFile), "对侧不建文件").toBe(false);
	});

	it("should delete a model at the project level, keeping an explicit empty list when the last item is removed", async () => {
		// Arrange: project 级列表生效
		writeIsolationFile(projectFile, { $models: ["p/only"] });
		writeProjectAgent("coder");
		const { command } = setupExtension();
		const { ui, calls, mismatches, leftover } = createScriptedUi([
			{ select: MODELS_ENTRY_PATTERN }, // 1. 管理入口
			{ select: "p/only" }, // 2. 选中要删的模型
			{ confirm: true }, // 3. 删除确认
			{ select: "project" }, // 4. 写入目标 project
			{ select: undefined }, // 5. 删除写回 → 回动作选择（列表已空 → 菜单 [add model, back]）；ESC → 回 agent 选择
			{ select: undefined }, // 6. agent 选择 ESC → 完全退出
		]);
		const ctx = { hasUI: true, mode: "tui", cwd: projectDir, ui };

		// Act
		await command.handler("", ctx);

		// Assert: project 级删除落盘；删到最后一项保留 "$models": []（M2 语义）；
		// 重问的动作菜单回到空列表形态（菜单即列表，实时反映）
		expect(mismatches).toEqual([]);
		expect(leftover).toEqual([]);
		expect(readRawJson(projectFile).$models, "删到最后一项保留空数组 key").toEqual([]);
		expect(fs.existsSync(userFile)).toBe(false);
		expect(calls[4].options, "删除最后一项后动作菜单应恰为 [add model, back]").toEqual(["add model", "back"]);
	});

	it("should cancel the deletion and return to the action menu when the confirmation is declined (防误删)", async () => {
		// Arrange
		writeIsolationFile(userFile, { $models: ["a/m-one", "b/m-two"] });
		const before = fs.readFileSync(userFile, "utf-8");
		writeProjectAgent("coder");
		const { command } = setupExtension();
		const { ui, calls, mismatches, leftover } = createScriptedUi([
			{ select: MODELS_ENTRY_PATTERN }, // 1. 管理入口
			{ select: "a/m-one" }, // 2. 选中要删的模型
			{ confirm: false }, // 3. 拒绝确认 → 不删除、回动作选择
			{ select: undefined }, // 4. 动作选择 ESC → 回 agent 选择
			{ select: undefined }, // 5. agent 选择 ESC → 完全退出
		]);
		const ctx = { hasUI: true, mode: "tui", cwd: projectDir, ui };

		// Act
		await command.handler("", ctx);

		// Assert: 确认被拒后不得出现写入目标 select、零写入、回动作选择（菜单不变）
		expect(mismatches).toEqual([]);
		expect(leftover).toEqual([]);
		const targetPrompted = calls.some(
			(c) =>
				c.kind === "select" &&
				c.options?.some((o) => /\buser\b/i.test(o)) &&
				c.options?.some((o) => /\bproject\b/i.test(o)),
		);
		expect(targetPrompted, "确认被拒后不得进入写入目标选择").toBe(false);
		expect(fs.readFileSync(userFile, "utf-8"), "确认被拒零写入").toBe(before);
		expect(fs.existsSync(projectFile)).toBe(false);
		expect(calls[3].options, "确认被拒后应回到动作选择（菜单不变）").toEqual([
			"a/m-one (user)",
			"b/m-two (user)",
			"add model",
			"back",
		]);
	});

	it("should offer exactly [add model, back] when the list is empty (空列表菜单)", async () => {
		// Arrange: 无任何 $models 配置
		writeProjectAgent("coder");
		const { command } = setupExtension();
		const { ui, calls, mismatches, leftover } = createScriptedUi([
			{ select: MODELS_ENTRY_PATTERN }, // 1. 管理入口
			{ select: undefined }, // 2. 动作选择 ESC → 回 agent 选择
			{ select: undefined }, // 3. agent 选择 ESC → 完全退出
		]);
		const ctx = { hasUI: true, mode: "tui", cwd: projectDir, ui };

		// Act
		await command.handler("", ctx);

		// Assert: 空列表 → 菜单恰为 [add model, back]（无模型项、无查看选项）
		expect(mismatches).toEqual([]);
		expect(leftover).toEqual([]);
		expect(calls[1].options, "空列表时动作菜单应恰为 [add model, back]").toEqual(["add model", "back"]);
		expect(calls[1].options!.some((o) => /view|查看/i.test(o)), "动作菜单不得含 view/查看 选项").toBe(false);
		expect(fs.existsSync(userFile)).toBe(false);
		expect(fs.existsSync(projectFile)).toBe(false);
	});

	it("should return to the agent picker on 'back' and allow continuing with agent editing (命令级全链)", async () => {
		// Arrange
		writeIsolationFile(userFile, { $models: ["u/one"] });
		const before = fs.readFileSync(userFile, "utf-8");
		writeProjectAgent("coder");
		const { command } = setupExtension();
		const { ui, calls, mismatches, leftover } = createScriptedUi([
			{ select: MODELS_ENTRY_PATTERN }, // 1. 管理入口
			{ select: "back" }, // 2. 动作菜单：back → 回 agent 选择
			{ select: "coder" }, // 3. agent 选择（重问）
			{ select: "description" }, // 4. 字段选择 description
			{ input: "Edited after models back" }, // 5. 提交
			{ select: undefined }, // 6. description 写回成功 → 回字段选择；字段选择 ESC → 回 agent 选择
			{ select: undefined }, // 7. agent 选择 ESC → 完全退出
		]);
		const ctx = { hasUI: true, mode: "tui", cwd: projectDir, ui };

		// Act
		await command.handler("", ctx);

		// Assert: 选中 back 后回到 agent 选择（选项与首次一致），可继续编辑 agent；$models 零写入
		expect(mismatches).toEqual([]);
		expect(leftover).toEqual([]);
		expect(calls[2].options, "选中 back 后应回到 agent 选择（选项与首次一致）").toEqual(calls[0].options);
		expect(fs.readFileSync(userFile, "utf-8"), "$models 列表零写入").toBe(before);
		expect(fs.existsSync(projectFile)).toBe(false);
		const reread = fs.readFileSync(path.join(agentsDir, "coder.md"), "utf-8");
		expect(reread, "description 编辑落盘").toContain("Edited after models back");
	});

	it("should rebuild the action menu from the updated list after a deletion, then allow adding (连续增删)", async () => {
		// Arrange
		writeIsolationFile(userFile, { $models: ["a/m-one", "b/m-two"] });
		writeProjectAgent("coder");
		const { command } = setupExtension();
		const { ui, calls, mismatches, leftover } = createScriptedUi([
			{ select: MODELS_ENTRY_PATTERN }, // 1. 管理入口
			{ select: "a/m-one" }, // 2. 选中删除 a/m-one
			{ confirm: true }, // 3. 确认
			{ select: "user" }, // 4. 写入目标 user → 删除写回 → 回动作选择
			{ select: "add model" }, // 5. 重问的菜单已不含 a/m-one → 选 add model
			{ input: "c/m-three" }, // 6. 输入新 model
			{ select: "user" }, // 7. 写入目标 user → add 写回 → 回动作选择
			{ select: undefined }, // 8. 动作选择 ESC → 回 agent 选择
			{ select: undefined }, // 9. agent 选择 ESC → 完全退出
		]);
		const ctx = { hasUI: true, mode: "tui", cwd: projectDir, ui };

		// Act
		await command.handler("", ctx);

		// Assert: 删除后重问的动作菜单 = 剩余列表（菜单即列表，必须反映最新状态）；
		// 删 + 加 都落盘、顺序保持
		expect(mismatches).toEqual([]);
		expect(leftover).toEqual([]);
		expect(calls[4].options, "删除后动作菜单应重建为剩余列表").toEqual([
			"b/m-two (user)",
			"add model",
			"back",
		]);
		expect(readRawJson(userFile).$models, "删一个再 add 一个，顺序保持").toEqual(["b/m-two", "c/m-three"]);
		expect(fs.existsSync(projectFile)).toBe(false);
	});
});

// ===========================================================================
// M8. q 键适配层契约（任务 B 红阶段）：$models 动作菜单经 ui.custom +
// SelectList，q = ESC（回 agent 选择）
// ===========================================================================
//
// 背景：用户需求"选择菜单中按 q = 向上一级或退出"。实现路径：
// adaptModelConfigEditorUI 的 select 在 ui.custom 可用时改用 pi-tui
// SelectList（复用 pickTaskInteractively 的 q/Esc 处理模式），$models 动作
// 选择菜单与 agent 选择/字段选择/值选择/thinking 级别/写入目标共用同一适配
// 器。本组钉死动作菜单的 custom 路径与 q 回退语义（ESC 语义不变：动作选择
// ESC/q → 回 agent 选择；agent 选择 ESC/q → 完全退出）。回退全程零写入。
//
// 可测性说明：q 键真实按键经 ui.custom 捕获组件后以裸字符 "q"/"\x1b" 注入
// handleInput 驱动（matchesKey 兼容裸字符），与 interactive-pickers.test.ts
// 同款模式，可自动化。
//
// 红阶段说明：当前 select 直接走 ui.select（不经 custom），本用例预期失败。

/** M8 专用：捕获 ui.custom 收到的组件（与 interactive-pickers.test.ts 同款）。 */
interface CapturedCustomComponent {
	component: any;
	done: ReturnType<typeof vi.fn>;
	getRendered: (width?: number) => string;
}

/** M8 专用：可编程 ui.custom mock；原生 select/input 为回退路径探针。 */
function createAdapterCustomCtx() {
	const notifyMock = vi.fn();
	const nativeSelect = vi.fn(async (): Promise<undefined> => undefined);
	const nativeInput = vi.fn(async (): Promise<undefined> => undefined);
	const captured: CapturedCustomComponent[] = [];
	const customMock = vi.fn(
		(cb: any) =>
			new Promise((resolve) => {
				const theme = {
					fg: (_c: string, s: string) => s,
					bold: (s: string) => s,
					dim: (s: string) => s,
					muted: (s: string) => s,
					warning: (s: string) => s,
				};
				const tui = { requestRender: vi.fn() };
				const done = vi.fn((value?: unknown) => resolve(value));
				const component = cb(tui, theme, null, done);
				captured.push({
					component,
					done,
					getRendered: (width = 80) => component.render(width).join("\n"),
				});
			}),
	);
	const ctx = {
		hasUI: true,
		mode: "tui" as const,
		cwd: projectDir,
		ui: { notify: notifyMock, custom: customMock, select: nativeSelect, input: nativeInput },
	};
	return { ctx, notifyMock, customMock, nativeSelect, nativeInput, captured };
}

/** 轮询等待 ui.custom 捕获到第 n 个组件（无 fake timers，纯异步让步）。 */
async function waitForCustomCalls(captured: unknown[], n: number): Promise<void> {
	for (let i = 0; i < 200 && captured.length < n; i++) {
		await new Promise((r) => setTimeout(r, 1));
	}
	expect(captured.length, `ui.custom 应已被调用 ${n} 次（当前 ${captured.length} 次）`).toBeGreaterThanOrEqual(n);
}

describe("M8. q 键适配层：$models 动作菜单经 ui.custom SelectList（红阶段契约）", () => {
	const KEY_DOWN = "\x1b[B";
	const KEY_ENTER = "\r";
	const KEY_ESC = "\x1b";
	const KEY_Q = "q";

	function setupExtension() {
		const pi = createMockPi();
		(mod.default as any)(pi);
		return { pi, command: pi._commandDefs.get("subagent-config") };
	}

	it("should route the $models action select through ui.custom and treat q at the action step as ESC (back to agent picker, zero writes)", async () => {
		// Arrange: user 级已有列表
		writeIsolationFile(userFile, { $models: ["u/one", "u/two"] });
		const before = fs.readFileSync(userFile, "utf-8");
		writeProjectAgent("coder");
		const { command } = setupExtension();
		const { ctx, captured, customMock, nativeSelect } = createAdapterCustomCtx();

		// Act: agent picker（custom SelectList）→ ↓ 到 $models 管理入口 → Enter
		const handlerPromise = command.handler("", ctx);
		await waitForCustomCalls(captured, 1);
		expect(captured[0].getRendered(), "agent 选择应含 model-list 管理入口").toMatch(/model[\s\S]*list|list[\s\S]*model/i);
		captured[0].component.handleInput(KEY_DOWN);
		captured[0].component.handleInput(KEY_ENTER);

		// Act: 动作选择（custom SelectList）→ 按 q
		await waitForCustomCalls(captured, 2);
		expect(captured[1].getRendered(), "动作选择应含 add 动作").toMatch(/add/i);
		captured[1].component.handleInput(KEY_Q);

		// Act: q = ESC → 回 agent 选择；顶层 q → 完全退出
		await waitForCustomCalls(captured, 3);
		expect(captured[2].getRendered(), "动作选择 q 后应回到 agent 选择").toContain("coder");
		captured[2].component.handleInput(KEY_Q);
		await handlerPromise;

		// Assert: 全程经 custom（原生 select 未触碰）；回退零写入
		expect(customMock).toHaveBeenCalledTimes(3);
		expect(nativeSelect, "custom 可用时不得调用原生 ui.select").not.toHaveBeenCalled();
		expect(fs.readFileSync(userFile, "utf-8")).toBe(before);
		expect(fs.existsSync(projectFile)).toBe(false);
	});
});
