/**
 * 阶段 3（/subagent-config 统一配置管理命令）TDD 红阶段契约测试。
 *
 * 背景：阶段 1（agent 清单注入 + 缓存语义）、阶段 2（model/thinking 配置模块：
 * computeEffectiveModelConfigs / writeModelOverride / resolveModelOverridePath /
 * editAgentModelConfig + /subagent-models）已验收。本阶段交付统一入口
 * /subagent-config：一个斜杠命令管理子 agent 的全部配置状态（name、description、
 * tools、skills、body 正文、model/thinking）。
 *
 * 用户已拍板的设计决策（测试必须钉死，coder 必须遵守）：
 *  1. 命令名 /subagent-config。
 *  2. 【用户决策（本轮变更）：改名功能移除】name 不再可编辑——字段选择无
 *     name 项；name 是只读身份标识（总览标注/字段选择标题仍展示 agent 名）。
 *     文件重命名逻辑及衍生契约（冲突检测、回滚、rename 后 filePath 刷新）
 *     整体删除：updateAgentFile 拒绝任何 name patch（不重命名、不新建、不
 *     删除）。
 *  3. body 用外部 editor 编辑（spawn $EDITOR）。测试不真 spawn —— 编辑流程必须
 *     接受注入的 read/write 回调（editAgentBodyWithEditor）或注入式 editBody
 *     回调（editAgentConfig），测试以 Fake 模拟 editor 结果。
 *  4. 其余字段用选择/输入：description/tools/skills 文本输入（name 不可编辑）、
 *     model/thinking 复用阶段 2 流程（含 agentName 预选 seam）。
 *  5. reload 提示：改 description → 结果提示必须含 "reload"（注入清单在
 *     before_agent_start 缓存，需 /reload 重建；name 不可编辑故无 name 侧）；
 *     改 tools/skills/body/model/thinking → 提示不得含 reload（即时生效）。
 *  6. model/thinking 编辑复用 editAgentModelConfig；生效值"当前值+来源"
 *     展示在字段选择选项标注（computeEffectiveModelConfigs 合并视图接入
 *     编辑流程，消除 test-only 导出漂移风险）。
 *  7. 字段级编辑含 clear 选项（清除 model/thinking 覆盖，回退 frontmatter）。
 *     【本测试钉死的具体交互】clear 选项位于 model 编辑器的字段选择层
 *     （标签含 "clear" + "model"/"thinking"），选中后直接进入写入目标选择
 *     （user/project），以 null patch 走 writeModelOverride 的既有清空语义；
 *     thinking 级别 select 保持恰好官方 7 级别不变。
 *  8. 【用户决策（本轮变更）：详情视图 notify 已移除】选中 agent 后不再打印
 *     文件路径/description/tools/skills/model/thinking/body 摘要的详情 info
 *     notify——信息获取靠 agent picker 总览标注与字段选择选项标注。选中
 *     agent 后直接进入字段选择；生效值+来源仅保留在字段选项标注与 picker
 *     总览标注中。
 *
 * 本文件钉死的契约（红阶段：全部预期失败，待 coder 实现后转绿）：
 *
 * A. agent 文件读写层（纯函数级，返回结果对象不抛异常）
 *   A1 readAgentFile(filePath) → { ok: true; name; description; tools?;
 *      skills?; body } | { ok: false; error: string }。
 *      复用 parseFrontmatter 语义；非法 frontmatter / 缺 name / 缺 description /
 *      文件不存在 → ok:false，不抛异常。skills 键存在但为空 → []（与
 *      loadAgentsFromDir 的 hasSkills 语义一致）；tools/skills 键不存在 →
 *      undefined。
 *   A2 updateAgentFile(filePath, patch) → { ok: true; filePath } |
 *      { ok: false; error }。patch = { name?, description?, tools?, skills?,
 *      body? }；任何 name patch 整体拒绝（见 A6）；tools/skills 为逗号分隔
 *      字符串（parseListField 语义），空串 =
 *      清除该 key。写回后：已修改字段新值可被 parseFrontmatter 读回（往返
 *      兼容）；未修改字段语义不变（重新解析等值）；body 字节逐字保留；
 *      未知 frontmatter key 原样保留。
 *   A3 【已移除】改名功能整体删除（原"name 修改 → 文件重命名"契约作废，含
 *      冲突检测/回滚/同名 no-op）；新契约见 A6 的"任何 name patch 整体拒绝"
 *      与 agent-file-rename-rollback.test.ts（改写：rename 回滚契约 → name
 *      patch 拒绝契约）。
 *   A4 tools/skills 逗号串 ↔ frontmatter 列表往返；空串 → 从 frontmatter 移除
 *      该 key（原始文本中不再出现 ^tools:/^skills: 行）。
 *   A5 body 写回：updateAgentFile 的 body patch 直接替换正文；editor 流程
 *      editAgentBodyWithEditor({ filePath, read?, write? }) → read 注入模拟
 *      editor 结果（缺省实现才 spawn $EDITOR），返回新正文 → write 落盘；
 *      返回 undefined（editor 取消/失败）或正文未改动或全空白 → 不写盘。
 *   A6 校验原子性：任何 name patch 整体拒绝且文件字节不变（改名功能移除：
 *      name 是只读身份标识，不重命名/不新建/不删除）；description 空或纯空白
 *      → 整体拒绝且文件字节不变（与 loadAgentsFromDir 跳过规则一致）；含任一
 *      非法字段的 patch 整体拒绝（不半写）；文件不存在 / IO 错误 → ok:false
 *      不抛异常。
 *
 * B. 编辑流程（命令级 + editAgentConfig 独立导出，脚本化假 UI 驱动，沿用
 *    阶段 2 模式）
 *   B7 /subagent-config 注册、description 合理；非 TUI → notify warning
 *     （与 /subagent-cancel、/subagent-models 一致）；无 agent → 不开对话框
 *     直接 notify；未知 agentName 参数 → 报错不崩不写盘。
 *   B8 主流程：选 agent（选项含来源标记 user/project）→ 选字段 → 编辑 →
 *     写回 → 结果提示；任一步取消零写入。选中 agent 后直接进入字段选择
 *     （无详情 notify——详情视图已移除，见设计决策 8）。命令带参数 =
 *     agentName 预选，跳过 agent 选择。
 *   B9 字段选项完整性：字段列表恰含 description/tools/skills/body/model/
 *     thinking 6 项且不含 name（按整词子串匹配，标签可自由润色；name 已不
 *     可编辑，不出现在字段选择中）。
 *   B10 reload 提示矩阵：description → 结果提示含 /reload/i（name 不可编辑，
 *     无 name 侧）；tools/skills/body/model/thinking → 全部提示文本不含
 *     /reload/i。
 *   B11 model/thinking 复用：字段选 model/thinking → 进入 editAgentModelConfig
 *     同款子流程（字段 select 含 "model"/"thinking" 精确项、thinking 7 级别
 *     select、user/project 写入目标）；agent 文件字节不变；clear 选项清除
 *     覆盖后合并视图回退 frontmatter。
 *   B12 body 集成：字段选 body → 调用注入的 editBody(filePath) 回调；
 *     changed:false / ok:false 时不写盘且有相应提示。
 *   B13 写失败（IO 错误）→ notify error 且文件不变。
 *
 * C. 衔接契约
 *   C14 数据层/流程函数独立导出：readAgentFile / updateAgentFile /
 *      editAgentBodyWithEditor / editAgentConfig（阶段 4 与文档引用钉死）。
 *   C15 既有导出面不变（阶段 1/2 全部导出保持），全量 npm test 零回归。
 *
 * E. UX 改进（本轮红阶段追加：选项标注当前值 + input 预填"在原值上修改"）
 *   E1 字段 select 每个选项标注当前值：description/tools/skills/body 字面
 *      值（摘要）；model 生效值+来源；thinking 生效级别（取生效值，json
 *      覆盖优先于 frontmatter）。标注为追加内容，B9 的 \b 整词子串匹配
 *      用例保持绿。
 *   E2 description/tools/skills 文本输入经 input 第三参 initial 预填当前值
 *      （tools/skills 为 ", " 逗号连接串，与既有 placeholder 约定一致）；
 *      无当前值（tools/skills key 缺失）时钉死传 ""（空串契约，不是
 *      undefined/省略）。name 不可编辑，无 name 预填。
 *   E3 预填不改变取消/提交语义：Esc 零写入；提交值覆盖预填值写回。
 *   ⚠️ 既有用例适配说明：B11 对子流程（editAgentModelConfig）字段 select
 *   的精确相等断言（o === "model" / o === "thinking"）已放宽为词边界子串
 *   匹配（排除 clear 项）——该 select 的选项按新契约追加当前值标注后不再
 *   精确等于字段 key，原断言与新契约构造性冲突；断言语义（字段项存在且
 *   区别于 clear 项）不变。
 *   【手工验证项（本组新增）】真实 TUI 预填输入框（命令层适配：
 *   ctx.ui.custom + pi-tui Input.setValue(initial)）：编辑 name/description/
 *   tools/skills 时输入框预填当前值，Enter 提交 / Esc 取消零写入；选项标注
 *   在窄终端的可读性（截断）。
 *
 * F. UX 改进（本轮红阶段追加：总览标注 + ESC 逐级回退 + Clear 说明）
 *   F1 总览标注：agent picker 的每个 agent 选项直接带该 agent 的生效
 *      model/thinking 标注，格式钉死为
 *      `<name> (<source>) — <model> (<thinking>)`（出现顺序：名称 → 来源
 *      → model → thinking；分隔/润色自由）。model/thinking 取
 *      computeEffectiveModelConfigs 生效值（json 覆盖优先 frontmatter——
 *      被遮蔽的 frontmatter 值不得出现在选项中）；未配置槽位的占位符
 *      钉死为 `not set`（全角括号，不会与 model ID 子串撞车）。既有
 *      (user)/(project) 来源标记子串断言保持兼容；标注永不进入写入值
 *      （选中标注选项必须映射回 agent 本体）。
 *   F2 ESC 逐级回退（editAgentConfig 主流程）：文本字段编辑 ESC → 回
 *      字段选择（可重选其它字段继续编辑）；字段选择 ESC → 回 agent 选择
 *      （可换选其它 agent）；agent 选择 ESC → 完全退出（顶层，不再提问）；
 *      body 取消（read undefined）→ 回字段选择（"unchanged" 提示语义
 *      不变）。agentName 预选时字段选择之上无 agent 选择层级 → 字段选择
 *      ESC 直接完全退出。字段编辑（含 body 全部退出路径、model/thinking
 *      子流程写入）成功后回到字段选择界面——可连续修改多个字段（本轮语义
 *      变更，见 G 组）；只有 ESC 逐级回退才退出。回退全程零写入。
 *   F3 ESC 逐级回退（editAgentModelConfig 子流程，agentName 必传）：写入
 *      目标 ESC → 回值步（重输入的值覆盖先前收集值）；值步 ESC → 回子
 *      流程字段选择（可换字段）；clear 分支无值步 → 写入目标 ESC 直接回
 *      子流程字段选择；子流程字段选择 ESC → 返回父流程字段选择（不退
 *      出、不重启子流程；独立调用无父级 = 子流程直接返回）。
 *   F4 Clear 说明：clear 选项标签钉死为 `clear model (reset to frontmatter)`
 *      / `clear thinking (reset to frontmatter)`（英文 key clear/model/
 *      thinking 子串兼容 + reset/frontmatter 说明可见）；clear 完成反馈
 *      说明回退结果——按“清除目标文件该 entry 后重算的生效视图”得出（双
 *      层级并存时可能回退到另一级 json，而非总是 frontmatter；生效值有值
 *      时含该值，无处可回退时含“未配置/未定义”语义，英文 key 子串匹配）。
 *   ⚠️ 既有用例适配说明（本轮）：B8 字段选择步取消、B9/B10 description 输入
 *   步取消、B12 body 取消、E3 预填取消四个用例从"取消即退出"改为"回退一
 *   级再退出"（脚本追加逐级 ESC 步骤，零写入断言保留）；agent 选择步取
 *   消 = 顶层完全退出，语义不变（B7/B8 既有用例不动）。
 *
 * G. 编辑成功/结束后回字段选择（本轮红阶段，用户确认的交互修正）
 *     所有字段编辑成功后回到字段选择界面（可连续改多个字段），只有 ESC
 *     逐级回退才退出（字段选择 ESC → agent 选择 ESC → 完全退出）。body
 *     的四条退出路径（保存 changed:true / 未修改 changed:false / 取消
 *     cancelled / 失败 ok:false）全部回字段选择（未修改 `:q` 场景现状是
 *     直接结束——本轮钉死必须回字段选择）；model/thinking 子流程写入成
 *     功 → 回父流程字段选择（可继续改其它字段）；$models add/remove 写
 *     入成功 → 回动作选择（可连续增删，见 available-models.test.ts）。编
 *     辑成功后的确认提示（info notify）保留。独立调用 editAgentModelConfig
 *     （无父级）写回成功后仍直接返回结果对象结束（子流程自身契约不变，
 *     model-config-editor.test.ts 不受影响）。
 *   ⚠️ 既有用例适配说明（本轮）：全部 happy path（写回即结束）用例脚本末
 *   尾追加 ESC 步——agentName 预选流程追加"字段选择 ESC"（完全退出）；
 *   命令层（有 agent 选择层）追加"字段选择 ESC + agent 选择 ESC"；B11/
 *   F3/F4 子流程与 B12 body 用例追加"父流程字段选择 ESC"；$models 用例
 *   追加"动作选择 ESC + agent 选择 ESC"（见 available-models.test.ts）。
 *   写回断言与确认提示断言全部保留；B7/B8 纯 ESC 用例不动。
 *
 * H. agent picker 选项排序契约（本轮红阶段，用户需求：显示顺序 = json key 顺序）
 *     agent picker 的选项顺序必须与 subagent-isolation.json 的 key 顺序一致
 *     （排序键 = loadModelOverrides(cwd) 的 key 顺序：{...user, ...project}
 *     合并后保序；$models 特殊 key 不参与）；json 未配置的 agent 排在已配置
 *     的后面（保持 discoverAgents 的既有相对顺序）；排序只作用于显示层
 *     （editAgentConfig 的 picker 构造处），discoverAgents 返回顺序与派发
 *     逻辑不受影响。子流程 editAgentModelConfig 无 agent 选择步（agentName
 *     必传，model-config-editor.test.ts 已钉死），契约只在 editAgentConfig
 *     层。详见文件尾部 H 组。既有用例评估：B8 来源标记（.some）、F1 总览标注
 *     （.find + 选项内部格式正则）、M4 $models 入口（.some）均不钉选项数组
 *     顺序；17 处 calls[N].options toEqual calls[M].options 均为同一 picker
 *     的自比较（排序后两侧一致）——均无需适配。
 *
 * 红阶段技术说明：新导出尚不存在，全部经 (mod as any) 命名空间访问，使失败
 * 落在断言/调用处（"xxx is not a function" / typeof 断言），而非模块导入期；
 * 同时保证本测试文件在严格单文件 typecheck 下无错误。
 *
 * 【手工验证项（自动化覆盖不了，移交主 agent）】
 *  - 真实 TUI 按键体验：agent 选择/字段选择/输入框；
 *  - 外部 editor 真实 spawn：$EDITOR 未设置时的回退（vi/nano）、编辑器异常
 *    退出（非零码）路径、编辑后 frontmatter 未被误改的确认；
 *  - clear 选项在真实 TUI 中的可发现性与文案。
 */

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as mod from "../src/index.ts";
import {
	discoverAgents,
	loadModelOverridesFile,
	computeEffectiveModelConfigs,
} from "../src/index.ts";
import { getAgentDir, parseFrontmatter } from "@earendil-works/pi-coding-agent";

// 只 mock 模块边界 getAgentDir（user 级配置目录）；parseFrontmatter 保持真实，
// 使"写回 → 重新解析"的往返兼容断言走真实解析器（不依赖任何具体 YAML 库）。
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

/** 预期签名：(filePath) => { ok: true; name; description; tools?; skills?; body } | { ok: false; error } */
function readAgent(filePath: string): any {
	return (mod as any).readAgentFile(filePath);
}

/** 预期签名：(filePath, patch) => { ok: true; filePath } | { ok: false; error } */
function patchAgent(filePath: string, patch: any): any {
	return (mod as any).updateAgentFile(filePath, patch);
}

/** 预期签名：({ filePath, read?, write? }) => Promise<{ ok: true; changed: boolean } | { ok: false; error }> */
function runBodyEditor(deps: any): Promise<any> {
	return (mod as any).editAgentBodyWithEditor(deps);
}

/** 预期签名：({ ui, cwd, agents, agentName?, editBody? }) => Promise<unknown> */
function runConfigFlow(deps: any): Promise<unknown> {
	return (mod as any).editAgentConfig(deps);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const CODER_BODY = "You are the coder agent.\n\n## Rules\n\n- Write code\n- Run tests";

/** 构造一个最小合法 agent 文件内容（body 无首/尾空行、恰好一个结尾换行）。 */
function agentFileContent(name: string, description: string, frontmatterExtra = "", body = CODER_BODY): string {
	const extra = frontmatterExtra ? `${frontmatterExtra}\n` : "";
	return `---\nname: ${name}\ndescription: ${description}\n${extra}---\n${body}\n`;
}

/** 提取 frontmatter 块（含两个 --- 分隔行与结尾换行）用于字节级对比。 */
function frontmatterBlockOf(content: string): string {
	const match = content.match(/^---\n[\s\S]*?\n---\n/);
	if (!match) throw new Error("测试 fixture 缺少 frontmatter 块");
	return match[0];
}

/** 提取 frontmatter 块之后的 body 区段（字节原样）用于逐字保留断言。 */
function bodySectionOf(content: string): string {
	return content.slice(frontmatterBlockOf(content).length);
}

/**
 * 脚本化假 UI（Fake，非 mock 内部模块）：与阶段 2 model-config-editor.test.ts
 * 同款。按队列依次应答 select/input，记录每次提问（kind/title/options），
 * 应答与提问类型不匹配或选项无匹配时记入 mismatches 并返回 undefined
 * （等价用户取消）。字符串应答先精确匹配、再退到子串匹配；RegExp 应答取
 * 第一个匹配的选项。应答为 undefined 表示用户在该步取消（Esc）。
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
	 * input 的第三参 initial（预填当前值，E2 契约）。流程未传时为 undefined，
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

/** 汇总全部 notify 文本（reload 提示矩阵的全量断言用）。 */
function allNotifyText(notifyMock: ReturnType<typeof vi.fn>): string {
	return notifyMock.mock.calls.map((args) => String(args[0])).join("\n");
}

/** 构造捕获注册表的 mock pi（与阶段 2 测试同款）。 */
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

// ---------------------------------------------------------------------------
// 共享 fixture：每个测试独立 tmp 目录；getAgentDir 指向 tmp 下 user-agent 目录。
// 目录命名为 workspace（而非 project），避免 picker/字段标注里的 "project" 来源
// 标记断言被路径中的同名子串误命中。
// ---------------------------------------------------------------------------

let tmpBase: string;
let userAgentDir: string;
let workspaceDir: string;
let agentsDir: string;
let userAgentsDir: string;
let userFile: string;
let workspaceFile: string;

beforeEach(() => {
	tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "agent-config-editor-test-"));
	userAgentDir = path.join(tmpBase, "user-agent");
	workspaceDir = path.join(tmpBase, "workspace");
	agentsDir = path.join(workspaceDir, ".pi", "agents");
	userAgentsDir = path.join(userAgentDir, "agents");
	userFile = path.join(userAgentDir, "subagent-isolation.json");
	workspaceFile = path.join(workspaceDir, ".pi", "subagent-isolation.json");
	fs.mkdirSync(userAgentDir, { recursive: true });
	fs.mkdirSync(workspaceDir, { recursive: true });
	vi.mocked(getAgentDir).mockReturnValue(userAgentDir);
});

afterEach(() => {
	fs.rmSync(tmpBase, { recursive: true, force: true });
	vi.clearAllMocks();
});

/** 在 workspaceDir/.pi/agents/ 写一个 agent 文件，返回其路径。 */
function writeProjectAgent(name: string, frontmatterExtra = "", body?: string): string {
	fs.mkdirSync(agentsDir, { recursive: true });
	const filePath = path.join(agentsDir, `${name}.md`);
	fs.writeFileSync(filePath, agentFileContent(name, `${name} agent`, frontmatterExtra, body), "utf-8");
	return filePath;
}

/** 在 user 级 agents 目录写一个 agent 文件，返回其路径。 */
function writeUserAgent(name: string, frontmatterExtra = "", body?: string): string {
	fs.mkdirSync(userAgentsDir, { recursive: true });
	const filePath = path.join(userAgentsDir, `${name}.md`);
	fs.writeFileSync(filePath, agentFileContent(name, `${name} agent`, frontmatterExtra, body), "utf-8");
	return filePath;
}

// ===========================================================================
// C14. 衔接契约：数据层与流程函数的独立导出
// ===========================================================================
describe("C14. 衔接契约：阶段 3 数据层/流程函数独立导出", () => {
	it("should export readAgentFile as a function", () => {
		expect(typeof (mod as any).readAgentFile).toBe("function");
	});

	it("should export updateAgentFile as a function", () => {
		expect(typeof (mod as any).updateAgentFile).toBe("function");
	});

	it("should export editAgentBodyWithEditor as a function", () => {
		expect(typeof (mod as any).editAgentBodyWithEditor).toBe("function");
	});

	it("should export editAgentConfig as a function", () => {
		expect(typeof (mod as any).editAgentConfig).toBe("function");
	});

	it("should keep every stage-1/2 export intact (C15 防误删)", () => {
		expect(typeof mod.isThinkingLevel).toBe("function");
		expect(typeof mod.normalizeOverride).toBe("function");
		expect(typeof mod.loadModelOverridesFile).toBe("function");
		expect(typeof mod.loadModelOverrides).toBe("function");
		expect(typeof mod.loadAgentsFromDir).toBe("function");
		expect(typeof mod.discoverAgents).toBe("function");
		expect(typeof mod.computeEffectiveModelConfigs).toBe("function");
		expect(typeof mod.writeModelOverride).toBe("function");
		expect(typeof mod.resolveModelOverridePath).toBe("function");
		expect(typeof mod.editAgentModelConfig).toBe("function");
	});
});

// ===========================================================================
// A1. 读：readAgentFile
// ===========================================================================
describe("A1. 读 readAgentFile（parseFrontmatter 语义，错误返回不抛出）", () => {
	it("should parse name/description/tools/skills/body from a well-formed agent file", () => {
		// Arrange
		const filePath = writeProjectAgent("coder", "tools: read, write, bash\nskills: systematic-debugging");

		// Act
		const result = readAgent(filePath);

		// Assert
		expect(result.ok).toBe(true);
		expect(result.name).toBe("coder");
		expect(result.description).toBe("coder agent");
		expect(result.tools).toEqual(["read", "write", "bash"]);
		expect(result.skills).toEqual(["systematic-debugging"]);
		expect(result.body).toBe(CODER_BODY);
	});

	it("should parse tools/skills written as YAML lists", () => {
		// Arrange
		const filePath = writeProjectAgent("coder", "tools:\n  - read\n  - bash\nskills:\n  - a\n  - b");

		// Act
		const result = readAgent(filePath);

		// Assert
		expect(result.ok).toBe(true);
		expect(result.tools).toEqual(["read", "bash"]);
		expect(result.skills).toEqual(["a", "b"]);
	});

	it("should return tools/skills as undefined when the keys are absent", () => {
		// Arrange
		const filePath = writeProjectAgent("coder");

		// Act
		const result = readAgent(filePath);

		// Assert
		expect(result.ok).toBe(true);
		expect(result.tools).toBeUndefined();
		expect(result.skills).toBeUndefined();
	});

	it("should return an empty skills array when the skills key is present but empty (loadAgentsFromDir 语义)", () => {
		// Arrange
		const filePath = writeProjectAgent("coder", "skills:");

		// Act
		const result = readAgent(filePath);

		// Assert
		expect(result.ok).toBe(true);
		expect(result.skills).toEqual([]);
	});

	it("should return ok:false without throwing when the frontmatter is invalid YAML", () => {
		// Arrange: description: foo: bar: baz —— YAML 语法错误（agent-loading 测试同款坏文件）
		fs.mkdirSync(agentsDir, { recursive: true });
		const filePath = path.join(agentsDir, "bad.md");
		fs.writeFileSync(filePath, `---\nname: bad\ndescription: foo: bar: baz\n---\nBad body.\n`, "utf-8");

		// Act
		let thrown: unknown;
		let result: any;
		try {
			result = readAgent(filePath);
		} catch (err) {
			thrown = err;
		}

		// Assert
		expect(thrown).toBeUndefined();
		expect(result.ok).toBe(false);
		expect(typeof result.error).toBe("string");
		expect(result.error.length).toBeGreaterThan(0);
	});

	it("should return ok:false when the name is missing or empty (与 loadAgentsFromDir 跳过规则一致)", () => {
		// Arrange
		fs.mkdirSync(agentsDir, { recursive: true });
		const filePath = path.join(agentsDir, "noname.md");
		fs.writeFileSync(filePath, `---\ndescription: No name here\n---\nBody.\n`, "utf-8");

		// Act
		const result = readAgent(filePath);

		// Assert
		expect(result.ok).toBe(false);
		expect(typeof result.error).toBe("string");
	});

	it("should return ok:false when the description is missing or empty (与 loadAgentsFromDir 跳过规则一致)", () => {
		// Arrange
		fs.mkdirSync(agentsDir, { recursive: true });
		const filePath = path.join(agentsDir, "nodesc.md");
		fs.writeFileSync(filePath, `---\nname: nodesc\n---\nBody.\n`, "utf-8");

		// Act
		const result = readAgent(filePath);

		// Assert
		expect(result.ok).toBe(false);
		expect(typeof result.error).toBe("string");
	});

	it("should return ok:false without throwing when the file does not exist", () => {
		// Arrange
		const filePath = path.join(agentsDir, "ghost.md");

		// Act
		let thrown: unknown;
		let result: any;
		try {
			result = readAgent(filePath);
		} catch (err) {
			thrown = err;
		}

		// Assert
		expect(thrown).toBeUndefined();
		expect(result.ok).toBe(false);
		expect(typeof result.error).toBe("string");
	});
});

// ===========================================================================
// A2. 写 frontmatter 字段：updateAgentFile
// ===========================================================================
describe("A2. 写回 updateAgentFile（往返兼容 + 未触碰部分逐字保留）", () => {
	it("should update description while preserving every other field semantically and the body verbatim", () => {
		// Arrange
		const filePath = writeProjectAgent("coder", "tools: read, write\nskills: systematic-debugging");
		const before = fs.readFileSync(filePath, "utf-8");

		// Act
		const result = patchAgent(filePath, { description: "New shiny description" });

		// Assert: 写回成功 + 重新解析语义正确
		expect(result.ok).toBe(true);
		const reread = readAgent(filePath);
		expect(reread.ok).toBe(true);
		expect(reread.description).toBe("New shiny description");
		expect(reread.name).toBe("coder");
		expect(reread.tools).toEqual(["read", "write"]);
		expect(reread.skills).toEqual(["systematic-debugging"]);
		expect(reread.body).toBe(CODER_BODY);
		// 逐字保留：body 区段字节不变；未修改字段的 frontmatter 行原样保留
		const after = fs.readFileSync(filePath, "utf-8");
		expect(bodySectionOf(after), "body 区段必须字节逐字保留").toBe(bodySectionOf(before));
		expect(after).toMatch(/^tools: read, write$/m);
		expect(after).toMatch(/^skills: systematic-debugging$/m);
		expect(after).toMatch(/^name: coder$/m);
	});

	it("should keep the name line untouched when only description is patched", () => {
		// Arrange: name 是只读身份标识（改名功能已移除，A3 契约作废）；此处验证
		// description patch 不影响 name 字段值
		const filePath = writeProjectAgent("coder");

		// Act
		const result = patchAgent(filePath, { description: "D2" });

		// Assert
		expect(result.ok).toBe(true);
		const reread = readAgent(filePath);
		expect(reread.name).toBe("coder");
		expect(reread.description).toBe("D2");
	});

	it("should round-trip a multi-field patch through parseFrontmatter (往返兼容)", () => {
		// Arrange
		const filePath = writeProjectAgent("coder", "tools: read\nskills: old-skill");

		// Act: 一次 patch 改多个字段
		const result = patchAgent(filePath, {
			description: "Round trip description",
			tools: "grep, find, ls",
			skills: "skill-a, skill-b",
		});

		// Assert: 写回格式必须能被真实 parseFrontmatter 读回（不依赖具体 YAML 库）
		expect(result.ok).toBe(true);
		const { frontmatter, body } = parseFrontmatter<Record<string, unknown>>(fs.readFileSync(filePath, "utf-8"));
		expect(frontmatter.name).toBe("coder");
		expect(frontmatter.description).toBe("Round trip description");
		expect(frontmatter.tools).toBe("grep, find, ls");
		expect(frontmatter.skills).toBe("skill-a, skill-b");
		expect(body).toBe(CODER_BODY);
	});

	it("should preserve unknown frontmatter keys verbatim", () => {
		// Arrange
		const filePath = writeProjectAgent("coder", "x-custom: keepme\nx-num: 42");

		// Act
		const result = patchAgent(filePath, { description: "New description" });

		// Assert: 未知 key 重新解析后等值（不得经由丢弃未知字段的规范化路径回写）
		expect(result.ok).toBe(true);
		const { frontmatter } = parseFrontmatter<Record<string, unknown>>(fs.readFileSync(filePath, "utf-8"));
		expect(frontmatter["x-custom"]).toBe("keepme");
		expect(frontmatter["x-num"]).toBe(42);
	});

	it("should preserve frontmatter model/thinking fields when patching other fields", () => {
		// Arrange
		const filePath = writeProjectAgent("coder", "model: fm/coder-model\nthinking: low");

		// Act
		const result = patchAgent(filePath, { tools: "read, bash" });

		// Assert
		expect(result.ok).toBe(true);
		const { frontmatter } = parseFrontmatter<Record<string, unknown>>(fs.readFileSync(filePath, "utf-8"));
		expect(frontmatter.model).toBe("fm/coder-model");
		expect(frontmatter.thinking).toBe("low");
	});

	it("should round-trip descriptions containing YAML-significant characters exactly", () => {
		// Arrange: 含 ": "、"#"、双引号 —— 序列化端必须正确引用/转义
		const filePath = writeProjectAgent("coder");
		const tricky = 'Writes: code # fast "quoted" 你好';

		// Act
		const result = patchAgent(filePath, { description: tricky });

		// Assert: 重新解析后逐字符等值
		expect(result.ok).toBe(true);
		const reread = readAgent(filePath);
		expect(reread.description).toBe(tricky);
	});

	// -----------------------------------------------------------------------
	// P0-1 孤儿续行守卫：被 patch 的 key 当前值若是多行（块标量 / YAML 列表），
	// 行级重写会产生孤儿续行，必须拒绝并保持文件字节不变。
	// -----------------------------------------------------------------------
	describe("P0-1 孤儿续行守卫（拒绝 patch 多行值 key，文件字节不变）", () => {
		/** 写一个 frontmatter 含块标量 description 的 agent 文件，返回路径。 */
		function writeBlockScalarAgent(extra = ""): string {
			fs.mkdirSync(agentsDir, { recursive: true });
			const filePath = path.join(agentsDir, "coder.md");
			const extraBlock = extra ? `${extra}\n` : "";
			const content = `---\nname: coder\ndescription: |\n  Multi-line\n  block scalar description\n${extraBlock}---\n${CODER_BODY}\n`;
			fs.writeFileSync(filePath, content, "utf-8");
			return filePath;
		}

		it("should refuse to patch description when its current value is a multi-line block scalar", () => {
			// Arrange: frontmatter 含 `description: |` 多行块标量
			const filePath = writeBlockScalarAgent();
			const before = fs.readFileSync(filePath, "utf-8");

			// Act: patch 该多行值 key
			const result = patchAgent(filePath, { description: "new value" });

			// Assert: 拒绝 + 可读 error + 文件字节不变
			expect(result.ok).toBe(false);
			expect(typeof result.error).toBe("string");
			expect(result.error.length).toBeGreaterThan(0);
			expect(fs.readFileSync(filePath, "utf-8"), "被拒绝的 patch 不得改动文件任何字节").toBe(before);
		});

		it("should refuse to patch tools when its current value is a YAML list", () => {
			// Arrange: tools 为 YAML 列表式（续行以 `- ` 开头）
			const filePath = writeProjectAgent("coder", "tools:\n  - read\n  - write");
			const before = fs.readFileSync(filePath, "utf-8");

			// Act
			const result = patchAgent(filePath, { tools: "read, write" });

			// Assert: 拒绝 + 可读 error + 文件字节不变
			expect(result.ok).toBe(false);
			expect(typeof result.error).toBe("string");
			expect(result.error.length).toBeGreaterThan(0);
			expect(fs.readFileSync(filePath, "utf-8"), "被拒绝的 patch 不得改动文件任何字节").toBe(before);
		});

		it("should still update single-line description and tools normally (control)", () => {
			// Arrange: 常规单行 description + 单行 tools
			const filePath = writeProjectAgent("coder", "tools: read, write");

			// Act: patch 同样的 key
			const result = patchAgent(filePath, { description: "Updated single line desc", tools: "bash, grep" });

			// Assert: 与现有 updateAgentFile 用例行为一致——写回成功且语义正确
			expect(result.ok).toBe(true);
			const reread = readAgent(filePath);
			expect(reread.ok).toBe(true);
			expect(reread.description).toBe("Updated single line desc");
			expect(reread.tools).toEqual(["bash", "grep"]);
		});

		it("should allow patching another single-line key when an unpatched key holds a block scalar (control)", () => {
			// Arrange: 块标量 description + 单行 tools（不 patch 块标量 key）
			const filePath = writeBlockScalarAgent("tools: read");

			// Act: 只 patch 单行的 tools key
			const result = patchAgent(filePath, { tools: "read, write" });

			// Assert: 守卫只拒绝被 patch 的 key 本身是多行值的情况，此处应放行
			expect(result.ok).toBe(true);
			const reread = readAgent(filePath);
			expect(reread.ok).toBe(true);
			expect(reread.tools).toEqual(["read", "write"]);
			expect(reread.description).toContain("Multi-line");
		});
	});
});

// ===========================================================================
// A4. tools/skills 写回（逗号串 ↔ frontmatter 列表；空值清除 key）
// ===========================================================================
describe("A4. tools/skills 写回（parseListField 语义）", () => {
	it("should write a comma-separated tools string as a parseable frontmatter field", () => {
		// Arrange
		const filePath = writeProjectAgent("coder", "tools: read");

		// Act: 含多余空白的逗号串
		const result = patchAgent(filePath, { tools: "read, write ,bash" });

		// Assert: 重新解析出 trim 后的列表
		expect(result.ok).toBe(true);
		expect(readAgent(filePath).tools).toEqual(["read", "write", "bash"]);
	});

	it("should remove the tools key from the frontmatter when patched with an empty string", () => {
		// Arrange
		const filePath = writeProjectAgent("coder", "tools: read, write\nskills: keepme");

		// Act
		const result = patchAgent(filePath, { tools: "" });

		// Assert: 原始文本中 ^tools: 行消失；skills 行保留；读回 tools 为 undefined
		expect(result.ok).toBe(true);
		const after = fs.readFileSync(filePath, "utf-8");
		expect(after).not.toMatch(/^tools:/m);
		expect(after).toMatch(/^skills: keepme$/m);
		const reread = readAgent(filePath);
		expect(reread.tools).toBeUndefined();
		expect(reread.skills).toEqual(["keepme"]);
	});

	it("should remove the skills key when patched with an empty string", () => {
		// Arrange
		const filePath = writeProjectAgent("coder", "skills: a, b");

		// Act
		const result = patchAgent(filePath, { skills: "" });

		// Assert
		expect(result.ok).toBe(true);
		expect(fs.readFileSync(filePath, "utf-8")).not.toMatch(/^skills:/m);
		expect(readAgent(filePath).skills).toBeUndefined();
	});

	it("should add a skills field to an agent that did not have one", () => {
		// Arrange
		const filePath = writeProjectAgent("coder");

		// Act
		const result = patchAgent(filePath, { skills: "systematic-debugging, deep-research" });

		// Assert
		expect(result.ok).toBe(true);
		expect(readAgent(filePath).skills).toEqual(["systematic-debugging", "deep-research"]);
	});
});

// ===========================================================================
// A5. body 写回与外部 editor 流程（注入式，不真 spawn）
// ===========================================================================
describe("A5. body 写回与 editor 流程（注入 read/write 回调）", () => {
	it("should replace the body via a body patch while keeping the frontmatter block byte-identical", () => {
		// Arrange
		const filePath = writeProjectAgent("coder", "tools: read, write");
		const before = fs.readFileSync(filePath, "utf-8");
		const newBody = "You are the rewritten agent.\n\n## 你好\n\n- 中文正文\n- second";

		// Act
		const result = patchAgent(filePath, { body: newBody });

		// Assert: frontmatter 块字节不变，body 读回语义等值
		expect(result.ok).toBe(true);
		const after = fs.readFileSync(filePath, "utf-8");
		expect(frontmatterBlockOf(after), "body patch 不得触碰 frontmatter 块").toBe(frontmatterBlockOf(before));
		expect(readAgent(filePath).body).toBe(newBody);
	});

	it("should write the edited body to disk when the injected read callback returns new content", async () => {
		// Arrange
		const filePath = writeProjectAgent("coder", "tools: read");
		const before = fs.readFileSync(filePath, "utf-8");
		const newBody = "Edited in an external editor.\n\n## New section";
		// 注入的 read 模拟 editor：收到当前正文，返回编辑后正文（缺省 write = 写回 filePath）
		const read = vi.fn(async (_currentBody: string) => newBody);

		// Act
		const result = await runBodyEditor({ filePath, read });

		// Assert: read 拿到当前正文；文件被更新且 frontmatter 块字节不变
		expect(read).toHaveBeenCalledTimes(1);
		expect(read.mock.calls[0][0]).toBe(CODER_BODY);
		expect(result.ok).toBe(true);
		expect(result.changed).toBe(true);
		const after = fs.readFileSync(filePath, "utf-8");
		expect(readAgent(filePath).body).toBe(newBody);
		expect(frontmatterBlockOf(after)).toBe(frontmatterBlockOf(before));
	});

	it("should not write anything when the editor leaves the body unchanged", async () => {
		// Arrange
		const filePath = writeProjectAgent("coder");
		const before = fs.readFileSync(filePath, "utf-8");
		const read = vi.fn(async () => CODER_BODY); // editor 打开但未改动
		const write = vi.fn();

		// Act
		const result = await runBodyEditor({ filePath, read, write });

		// Assert: no-op —— 不调 write、文件字节不变
		expect(result.ok).toBe(true);
		expect(result.changed).toBe(false);
		expect(write, "正文未改动时不得写盘").not.toHaveBeenCalled();
		expect(fs.readFileSync(filePath, "utf-8")).toBe(before);
	});

	it("should not write anything when the injected read returns undefined (editor 取消/失败)", async () => {
		// Arrange
		const filePath = writeProjectAgent("coder");
		const before = fs.readFileSync(filePath, "utf-8");
		const read = vi.fn(async () => undefined as string | undefined);
		const write = vi.fn();

		// Act
		const result = await runBodyEditor({ filePath, read, write });

		// Assert
		expect(result.ok).toBe(true);
		expect(result.changed).toBe(false);
		expect(write).not.toHaveBeenCalled();
		expect(fs.readFileSync(filePath, "utf-8")).toBe(before);
	});

	it("should not write anything when the edited body is whitespace-only (防空正文误写)", async () => {
		// Arrange
		const filePath = writeProjectAgent("coder");
		const before = fs.readFileSync(filePath, "utf-8");
		const read = vi.fn(async () => "   \n  \n");
		const write = vi.fn();

		// Act
		await runBodyEditor({ filePath, read, write });

		// Assert: 不写盘、文件不变（结果形状不钉死，但绝不能产生写操作）
		expect(write).not.toHaveBeenCalled();
		expect(fs.readFileSync(filePath, "utf-8")).toBe(before);
	});

	it("should treat a trailing-newline-only difference as unchanged (no-op 不写盘)", async () => {
		// Arrange: 编辑器保留尾部换行 → 读回内容仅比当前 body 多一个 "\n"（清单 9）
		const filePath = writeProjectAgent("coder");
		const before = fs.readFileSync(filePath, "utf-8");
		const read = vi.fn(async () => `${CODER_BODY}\n`);
		const write = vi.fn();

		// Act
		const result = await runBodyEditor({ filePath, read, write });

		// Assert: 语义 no-op —— changed:false、不写盘、文件字节不变
		expect(result.ok).toBe(true);
		expect(result.changed, "仅尾部换行差异应视为未改动").toBe(false);
		expect(write, "仅尾部换行差异不得写盘").not.toHaveBeenCalled();
		expect(fs.readFileSync(filePath, "utf-8")).toBe(before);
	});
});

// ===========================================================================
// A6. 校验原子性：非法值整体拒绝，文件字节不变
// ===========================================================================
describe("A6. 校验原子性（防半写）", () => {
	it("should reject any name patch outright and leave the file byte-identical (改名功能移除：name 是只读身份标识)", () => {
		// Arrange
		const filePath = writeProjectAgent("coder");
		const before = fs.readFileSync(filePath, "utf-8");

		// Act: 即使是合法新名（非空、无非法字符）也被整体拒绝——name 不再可编辑
		const result = patchAgent(filePath, { name: "expert" });

		// Assert: 拒绝（不抛异常）、文件字节不变、目录里不多出不删文件
		expect(result.ok).toBe(false);
		expect(typeof result.error).toBe("string");
		expect(fs.readFileSync(filePath, "utf-8")).toBe(before);
		expect(fs.readdirSync(agentsDir), "name patch 不得触发任何文件系统改动（不重命名/不新建）").toEqual(["coder.md"]);
	});

	it("should reject a name+description combined patch wholesale (不半写：合法 description 也不得写入)", () => {
		// Arrange
		const filePath = writeProjectAgent("coder");
		const before = fs.readFileSync(filePath, "utf-8");

		// Act: patch 同时含 name 与 description
		const result = patchAgent(filePath, { name: "expert", description: "Should not land" });

		// Assert: 整体拒绝，description 不得落盘
		expect(result.ok).toBe(false);
		expect(fs.readFileSync(filePath, "utf-8")).toBe(before);
		expect(fs.readdirSync(agentsDir)).toEqual(["coder.md"]);
	});

	it("should reject an empty-string description patch and leave the file byte-identical", () => {
		// Arrange
		const filePath = writeProjectAgent("coder");
		const before = fs.readFileSync(filePath, "utf-8");

		// Act
		const result = patchAgent(filePath, { description: "" });

		// Assert
		expect(result.ok).toBe(false);
		expect(typeof result.error).toBe("string");
		expect(fs.readFileSync(filePath, "utf-8")).toBe(before);
	});

	it("should reject a whitespace-only description patch", () => {
		// Arrange
		const filePath = writeProjectAgent("coder");
		const before = fs.readFileSync(filePath, "utf-8");

		// Act
		const result = patchAgent(filePath, { description: "   " });

		// Assert
		expect(result.ok).toBe(false);
		expect(fs.readFileSync(filePath, "utf-8")).toBe(before);
	});

	it("should reject the whole patch when any field is invalid (不半写)", () => {
		// Arrange
		const filePath = writeProjectAgent("coder");
		const before = fs.readFileSync(filePath, "utf-8");

		// Act: description 合法但 patch 含 name —— 整个 patch 必须被拒绝（name 不可编辑）
		const result = patchAgent(filePath, { description: "Good description", name: "bad/name" });

		// Assert: 连合法的 description 也不得写入
		expect(result.ok).toBe(false);
		expect(fs.readFileSync(filePath, "utf-8")).toBe(before);
	});

	it("should return ok:false without throwing when the target file does not exist", () => {
		// Arrange
		const filePath = path.join(agentsDir, "ghost.md");

		// Act
		let thrown: unknown;
		let result: any;
		try {
			result = patchAgent(filePath, { description: "D" });
		} catch (err) {
			thrown = err;
		}

		// Assert
		expect(thrown).toBeUndefined();
		expect(result.ok).toBe(false);
		expect(fs.existsSync(filePath), "拒绝写入时不得创建文件").toBe(false);
	});

	it("should return ok:false and leave content unchanged on an IO error (read-only file + dir)", () => {
		// Arrange: 文件只读 + 目录只读 —— 无论实现走直接写还是临时文件+原子
		// rename（rename 覆盖只读文件在目录可写时会成功），都构成真实写入失败
		const filePath = writeProjectAgent("coder");
		const before = fs.readFileSync(filePath, "utf-8");
		fs.chmodSync(filePath, 0o444);
		fs.chmodSync(agentsDir, 0o555);

		// Act
		let result: any;
		try {
			result = patchAgent(filePath, { description: "D2" });
		} finally {
			fs.chmodSync(agentsDir, 0o755); // 恢复以便 afterEach 清理
			fs.chmodSync(filePath, 0o644);
		}

		// Assert
		expect(result.ok).toBe(false);
		expect(typeof result.error).toBe("string");
		expect(fs.readFileSync(filePath, "utf-8")).toBe(before);
	});
});

// ===========================================================================
// B7. 命令契约 /subagent-config
// ===========================================================================
describe("B7. 命令契约 /subagent-config", () => {
	function setupExtension() {
		const pi = createMockPi();
		(mod.default as any)(pi);
		return { pi, command: pi._commandDefs.get("subagent-config") };
	}

	it("should register a /subagent-config command with a meaningful description", () => {
		// Act
		const { command } = setupExtension();

		// Assert
		expect(command, "命令 subagent-config 应注册").toBeDefined();
		expect(typeof command.description).toBe("string");
		expect(command.description.length).toBeGreaterThan(0);
		expect(command.description).toMatch(/config|配置/i);
		expect(typeof command.handler).toBe("function");
	});

	it("should notify usage (warning) and write nothing when invoked outside TUI mode", async () => {
		// Arrange: 有 agent 可编辑（确保命中的不是"无 agent"分支）
		const agentPath = writeProjectAgent("coder");
		const before = fs.readFileSync(agentPath, "utf-8");
		const { command } = setupExtension();
		const notify = vi.fn();
		const custom = vi.fn();
		const select = vi.fn();
		const input = vi.fn();
		const ctx = { hasUI: false, mode: "print", cwd: workspaceDir, ui: { notify, custom, select, input } };

		// Act
		await command.handler("", ctx);

		// Assert: 与 /subagent-cancel、/subagent-models 的非 TUI 回退一致
		expect(notify).toHaveBeenCalledTimes(1);
		const [message, type] = notify.mock.calls[0];
		expect(String(message)).toMatch(/subagent-config|usage|config/i);
		expect(type).toBe("warning");
		expect(custom, "非 TUI 不得打开自定义组件").not.toHaveBeenCalled();
		expect(select, "非 TUI 不得打开选择对话框").not.toHaveBeenCalled();
		expect(input, "非 TUI 不得打开输入对话框").not.toHaveBeenCalled();
		expect(fs.readFileSync(agentPath, "utf-8"), "非 TUI 不得改 agent 文件").toBe(before);
		expect(fs.existsSync(userFile), "非 TUI 不得写 user 级配置").toBe(false);
		expect(fs.existsSync(workspaceFile), "非 TUI 不得写 project 级配置").toBe(false);
	});

	it("should still open the picker with the $models management entry when no agents are discovered (TUI)", async () => {
		// Arrange: user/project 两侧都没有 agent —— 阶段 4 清单 8 起零 agent
		// 不再早退：picker 仍弹出（含 $models 管理入口），取消安静零写入。
		// （端到端走通 add 的契约见 available-models.test.ts 清单 8 用例。）
		// ⚠️ q 键适配层适配（任务 B）：本用例改为走回退路径（ctx 不提供
		// custom）——零 agent 弹出 picker 是流程层契约，与 UI 通道无关；
		// 原"select 不得打开 custom"断言随适配器改造（select 在 custom 可用
		// 时改走 SelectList）失效，由 I 组用例接管 custom 路径钉死。
		const { command } = setupExtension();
		const { ui, calls, mismatches, leftover, notifyMock } = createScriptedUi([{ select: undefined }]);
		const ctx = { hasUI: true, mode: "tui", cwd: workspaceDir, ui };

		// Act
		await command.handler("", ctx);

		// Assert：零 agent 仍弹出含管理入口的 picker；取消零写入、无提示
		expect(mismatches).toEqual([]);
		expect(leftover).toEqual([]);
		expect(calls.length).toBeGreaterThanOrEqual(1);
		const options = calls[0].options ?? [];
		expect(
			options.some((o) => /model/i.test(o) && /list/i.test(o)),
			`零 agent 时 picker 应包含 model-list 管理入口（实际选项 = [${options.join(" | ")}]）`,
		).toBe(true);
		expect(notifyMock, "picker 即取消是安静的（无详情、无提示）").not.toHaveBeenCalled();
		expect(fs.existsSync(userFile)).toBe(false);
		expect(fs.existsSync(workspaceFile)).toBe(false);
	});

	it("should notify an error and not crash when the command argument names an unknown agent", async () => {
		// Arrange: 有 coder，但参数指定 ghost
		writeProjectAgent("coder");
		const { command } = setupExtension();
		const { ui, calls, notifyMock } = createScriptedUi([]);
		const ctx = { hasUI: true, mode: "tui", cwd: workspaceDir, ui };

		// Act
		await command.handler("ghost", ctx);

		// Assert: 不提问、不写文件、有错误提示
		expect(calls).toHaveLength(0);
		expect(notifyMock).toHaveBeenCalled();
		const [message, type] = notifyMock.mock.calls[0];
		expect(String(message)).toMatch(/ghost/);
		expect(["error", "warning"]).toContain(type);
		expect(fs.readdirSync(agentsDir)).toEqual(["coder.md"]);
		expect(fs.existsSync(userFile)).toBe(false);
		expect(fs.existsSync(workspaceFile)).toBe(false);
	});
});

// ===========================================================================
// B8. 主流程（命令级，脚本化假 UI 驱动）
// ===========================================================================
describe("B8. 主流程：选 agent → 选字段 → 编辑 → 写回 → 提示", () => {
	function setupExtension() {
		const pi = createMockPi();
		(mod.default as any)(pi);
		return { pi, command: pi._commandDefs.get("subagent-config") };
	}

	it("should mark each agent option with its source (user/project) in the agent picker", async () => {
		// Arrange: 两侧各一个 agent
		writeUserAgent("helper");
		writeProjectAgent("coder");
		const { command } = setupExtension();
		const { ui, calls } = createScriptedUi([{ select: undefined }]); // 第一步取消
		const ctx = { hasUI: true, mode: "tui", cwd: workspaceDir, ui };

		// Act
		await command.handler("", ctx);

		// Assert: agent 选择项带来源标记
		expect(calls.length).toBeGreaterThanOrEqual(1);
		const options = calls[0].options ?? [];
		expect(options.some((o) => /coder/.test(o) && /project/i.test(o)), "coder 选项应标 project 来源").toBe(true);
		expect(options.some((o) => /helper/.test(o) && /user/i.test(o)), "helper 选项应标 user 来源").toBe(true);
	});

	it("should skip agent selection when the command is invoked with an agentName argument", async () => {
		// Arrange
		writeProjectAgent("coder");
		writeProjectAgent("writer");
		const { command } = setupExtension();
		const { ui, calls, mismatches, leftover } = createScriptedUi([
			{ select: "description" }, // 第一个提问必须是字段选择
			{ input: "Arg-driven description" },
			{ select: undefined }, // 写回成功 → 回字段选择；字段选择 ESC → 完全退出（agentName 预选）
		]);
		const ctx = { hasUI: true, mode: "tui", cwd: workspaceDir, ui };

		// Act
		await command.handler("coder", ctx);

		// Assert
		expect(mismatches).toEqual([]);
		expect(leftover).toEqual([]);
		const offeredOptions = calls.filter((c) => c.kind === "select").flatMap((c) => c.options ?? []);
		expect(
			offeredOptions.some((o) => o === "coder" || o === "writer"),
			"预选 agent 后不应再出现 agent 选择步骤",
		).toBe(false);
		expect(readAgent(path.join(agentsDir, "coder.md")).description).toBe("Arg-driven description");
	});

	it("should write nothing and show no detail when the user cancels at the agent-selection step", async () => {
		// Arrange
		const agentPath = writeProjectAgent("coder");
		const before = fs.readFileSync(agentPath, "utf-8");
		const { command } = setupExtension();
		const { ui, notifyMock } = createScriptedUi([{ select: undefined }]);
		const ctx = { hasUI: true, mode: "tui", cwd: workspaceDir, ui };

		// Act
		await command.handler("", ctx);

		// Assert: 零写入、零提示（取消是安静的）
		expect(fs.readFileSync(agentPath, "utf-8")).toBe(before);
		expect(fs.existsSync(userFile)).toBe(false);
		expect(fs.existsSync(workspaceFile)).toBe(false);
		expect(notifyMock, "agent 选择即取消时不应有任何 notify（详情视图也未触发）").not.toHaveBeenCalled();
	});

	it("should return to the agent picker (then exit quietly) when the user presses ESC at the field-selection step", async () => {
		// Arrange
		const agentPath = writeProjectAgent("coder");
		const before = fs.readFileSync(agentPath, "utf-8");
		const { command } = setupExtension();
		// ESC 回退语义（F2）：字段选择 ESC → 回 agent 选择；agent 选择 ESC → 完全退出
		const { ui, calls, mismatches, leftover } = createScriptedUi([
			{ select: "coder" }, // 1. 选择 agent
			{ select: undefined }, // 2. 字段选择 ESC → 回 agent 选择
			{ select: undefined }, // 3. agent 选择 ESC → 完全退出
		]);
		const ctx = { hasUI: true, mode: "tui", cwd: workspaceDir, ui };

		// Act
		await command.handler("", ctx);

		// Assert
		expect(mismatches).toEqual([]);
		expect(leftover).toEqual([]);
		expect(calls).toHaveLength(3);
		expect(calls[2].options, "字段选择 ESC 后应回到 agent 选择（选项与首次提问一致）").toEqual(calls[0].options);
		// 回退零写入
		expect(fs.readFileSync(agentPath, "utf-8")).toBe(before);
		expect(fs.existsSync(userFile)).toBe(false);
		expect(fs.existsSync(workspaceFile)).toBe(false);
	});
});

// ===========================================================================
// B9/B10. 字段编辑（editAgentConfig 独立导出）+ reload 提示矩阵
// ===========================================================================
describe("B9/B10. 字段编辑与 reload 提示矩阵（editAgentConfig 假 UI 驱动）", () => {
	it("should enter the field select directly after selecting the agent, with no detail notify (详情 notify 已移除)", async () => {
		// Arrange: frontmatter 提供 model + tools/skills；project 级 json 覆盖 thinking
		writeProjectAgent(
			"detailer",
			"tools: read, bash\nskills: systematic-debugging\nmodel: fm/detail-model\nthinking: minimal",
			"You are the detailer agent.\n\nSecond line.",
		);
		fs.mkdirSync(path.dirname(workspaceFile), { recursive: true });
		fs.writeFileSync(workspaceFile, JSON.stringify({ detailer: { thinking: "high" } }), "utf-8");
		const { agents } = discoverAgents(workspaceDir, "both");
		const { ui, calls, notifyMock } = createScriptedUi([{ select: undefined }]); // 字段选择步取消

		// Act
		await runConfigFlow({ ui, cwd: workspaceDir, agents, agentName: "detailer" });

		// Assert: 选中 agent 后直接进入字段选择——取消流程零写入，任何 notify 都
		// 只能是详情视图，故 not.toHaveBeenCalled() 即钉死“无详情 notify”。
		expect(calls, "第一个提问必须是字段选择").toHaveLength(1);
		expect(calls[0].kind).toBe("select");
		expect(calls[0].title, "字段选择标题仍标识 agent（选项→agent 映射可观察）").toMatch(/Agent "detailer".*select field/i);
		expect(notifyMock, "选中 agent 后直接进入字段选择，不得有详情 notify（取消流程应安静）").not.toHaveBeenCalled();
		// 字段标注保留（信息获取靠标注）：生效值+来源、tools/skills/body 内容仍在选项里
		const options = calls[0].options ?? [];
		const optionOf = (field: string) => options.find((o) => new RegExp(`\\b${field}\\b`, "i").test(o));
		expect(optionOf("tools")!, "tools 选项应标注当前值").toContain("read");
		expect(optionOf("tools")!, "tools 选项应标注当前值").toContain("bash");
		expect(optionOf("skills")!, "skills 选项应标注当前值").toContain("systematic-debugging");
		expect(optionOf("body")!, "body 选项应标注正文摘要").toContain("You are the detailer");
		// model & thinking 已合并为一项：合并选项同时携带两个生效值 + 各自来源
		// （optionOf("model") 与 optionOf("thinking") 均命中同一合并项）。
		expect(optionOf("model")!, "合并项应标注生效 model").toContain("fm/detail-model");
		expect(optionOf("model")!, "合并项应标注 model 来源（frontmatter）").toMatch(/frontmatter/i);
		expect(optionOf("thinking")!, "合并项应标注生效 thinking（project json 覆盖生效）").toContain("high");
		expect(optionOf("thinking")!, "合并项应标注 thinking 来源（project）").toMatch(/project/i);
		expect(optionOf("model")!, "model/thinking 必须合并为同一选项（同时含两个英文 key）").toMatch(/\bmodel\b/i);
		expect(optionOf("model")!, "model/thinking 必须合并为同一选项（同时含两个英文 key）").toMatch(/\bthinking\b/i);
		// 零写入
		expect(fs.readFileSync(workspaceFile, "utf-8")).toBe(JSON.stringify({ detailer: { thinking: "high" } }));
	});

	it("should never print detail content (file path / body summary / field-value lines) in any notify during an edit flow", async () => {
		// Arrange: 编辑流程正常有确认 notify（保留回归）；断言全部 notify 不含
		// 详情视图专有内容（文件路径、正文摘要、"description: " 等详情行前缀、
		// "(default: all tools)" 占位）。
		const filePath = writeProjectAgent("coder", "tools: read, bash", "You are the coder agent.");
		const { agents } = discoverAgents(workspaceDir, "both");
		const { ui, mismatches, leftover, notifyMock } = createScriptedUi([
			{ select: "description" }, // 1. 字段选择 description
			{ input: "Detail-free desc v2" }, // 2. 提交 → 写回成功 → 回字段选择
			{ select: undefined }, // 3. 字段选择 ESC → 完全退出（agentName 预选）
		]);

		// Act
		await runConfigFlow({ ui, cwd: workspaceDir, agents, agentName: "coder" });

		// Assert: 确认提示保留（回归），但任何 notify 都不得含详情视图内容
		expect(mismatches).toEqual([]);
		expect(leftover).toEqual([]);
		expect(
			notifyMock.mock.calls.some(([m, t]) => (t === undefined || t === "info") && String(m).includes("coder")),
			"写回后确认提示应保留",
		).toBe(true);
		expect(allNotifyText(notifyMock), "改 description 必须提示需要 /reload（回归）").toMatch(/reload/i);
		const text = allNotifyText(notifyMock);
		expect(text, "notify 不得含文件路径（详情视图内容）").not.toContain(filePath);
		expect(text, "notify 不得含正文摘要（详情视图内容）").not.toContain("You are the coder agent.");
		expect(text, "notify 不得含详情行前缀（description:/tools:/skills:/body:/model:/thinking:）").not.toMatch(
			/^(description|tools|skills|body|model|thinking): /m,
		);
		expect(text, "notify 不得含详情视图的 tools 占位文案").not.toContain("(default: all tools)");
		expect(readAgent(filePath).description).toBe("Detail-free desc v2");
	});

	it("should offer exactly five editable fields in the field select, with no name option (B9 完整性：model/thinking 合并)", async () => {
		// Arrange
		writeProjectAgent("coder", "model: fm/m");
		const { agents } = discoverAgents(workspaceDir, "both");
		const { ui, calls } = createScriptedUi([{ select: undefined }]);

		// Act
		await runConfigFlow({ ui, cwd: workspaceDir, agents, agentName: "coder" });

		// Assert: 字段 select 恰 5 个可编辑字段（4 文本字段 + model & thinking 合
		// 并项；name 已移除——只读身份标识）。合并项同时含 model/thinking 两个
		// 英文 key（\bmodel\b / \bthinking\b 子串均命中它），标签可自由润色。
		const fieldCall = calls.find((c) => c.kind === "select");
		expect(fieldCall).toBeDefined();
		const options = fieldCall!.options ?? [];
		const textFieldKeys = ["description", "tools", "skills", "body"];
		const isCombinedField = (o: string) => /\bmodel\b/i.test(o) && /\bthinking\b/i.test(o);
		for (const field of textFieldKeys) {
			expect(
				options.some((o) => new RegExp(`\\b${field}\\b`, "i").test(o)),
				`字段选项缺少 ${field}（实际选项 = [${options.join(" | ")}]）`,
			).toBe(true);
		}
		expect(options.some(isCombinedField), "字段选项缺少 model & thinking 合并项（实际选项 = [" + options.join(" | ") + "]）").toBe(true);
		// 精确性：可编辑字段恰好 5 项（无多余字段项）；name 不得出现在选项中
		// （整词匹配，防 "rename"/标注内容中的 name 误伤）
		expect(
			options.filter((o) => textFieldKeys.some((f) => new RegExp(`\\b${f}\\b`, "i").test(o)) || isCombinedField(o)),
			"字段选项应恰好覆盖 5 个可编辑字段（无多余字段项）",
		).toHaveLength(5);
		expect(
			options.some((o) => new RegExp(`\\bname\\b`, "i").test(o)),
			"name 已不可编辑，字段选择不得出现 name 选项（实际选项 = [" + options.join(" | ") + "]）",
		).toBe(false);
		// name 展示保留：字段选择标题仍以 agent 名标识当前编辑对象（只读身份标识）
		expect(fieldCall!.title, "字段选择标题应仍含 agent 名").toMatch(/coder/);
	});

	it("should edit description and hint that /reload is required (B10)", async () => {
		// Arrange
		const filePath = writeProjectAgent("coder");
		const { agents } = discoverAgents(workspaceDir, "both");
		const { ui, mismatches, leftover, notifyMock } = createScriptedUi([
			{ select: "description" },
			{ input: "Brand new description" },
			{ select: undefined }, // 写回成功 → 回字段选择；字段选择 ESC → 完全退出（agentName 预选）
		]);

		// Act
		await runConfigFlow({ ui, cwd: workspaceDir, agents, agentName: "coder" });

		// Assert
		expect(mismatches).toEqual([]);
		expect(leftover).toEqual([]);
		expect(readAgent(filePath).description).toBe("Brand new description");
		expect(readAgent(filePath).name).toBe("coder");
		expect(allNotifyText(notifyMock), "改 description 必须提示需要 /reload").toMatch(/reload/i);
	});

	it("should edit tools via comma-separated input and NOT mention reload (即时生效)", async () => {
		// Arrange
		const filePath = writeProjectAgent("coder", "tools: read");
		const { agents } = discoverAgents(workspaceDir, "both");
		const { ui, mismatches, leftover, notifyMock } = createScriptedUi([
			{ select: "tools" },
			{ input: "read, write, bash" },
			{ select: undefined }, // 写回成功 → 回字段选择；字段选择 ESC → 完全退出（agentName 预选）
		]);

		// Act
		await runConfigFlow({ ui, cwd: workspaceDir, agents, agentName: "coder" });

		// Assert
		expect(mismatches).toEqual([]);
		expect(leftover).toEqual([]);
		expect(readAgent(filePath).tools).toEqual(["read", "write", "bash"]);
		const text = allNotifyText(notifyMock);
		expect(text, "tools 即时生效，提示不得含 reload").not.toMatch(/reload/i);
		expect(notifyMock.mock.calls.some(([m, t]) => String(m).includes("coder") && (t === undefined || t === "info"))).toBe(true);
	});

	it("should clear the skills key via empty input and NOT mention reload", async () => {
		// Arrange
		const filePath = writeProjectAgent("coder", "skills: a, b");
		const { agents } = discoverAgents(workspaceDir, "both");
		const { ui, mismatches, leftover, notifyMock } = createScriptedUi([
			{ select: "skills" },
			{ input: "" },
			{ select: undefined }, // 写回成功 → 回字段选择；字段选择 ESC → 完全退出（agentName 预选）
		]);

		// Act
		await runConfigFlow({ ui, cwd: workspaceDir, agents, agentName: "coder" });

		// Assert: 空输入 = 清除该 key
		expect(mismatches).toEqual([]);
		expect(leftover).toEqual([]);
		expect(fs.readFileSync(filePath, "utf-8")).not.toMatch(/^skills:/m);
		expect(allNotifyText(notifyMock)).not.toMatch(/reload/i);
	});

	it("should return to the field select (then exit, zero writes) when the user presses ESC at the description-input step", async () => {
		// Arrange
		const filePath = writeProjectAgent("coder");
		const before = fs.readFileSync(filePath, "utf-8");
		const { agents } = discoverAgents(workspaceDir, "both");
		// ESC 回退语义（F2）：编辑 ESC → 回字段选择；agentName 预选时字段选择之上
		// 无 agent 选择层级 → 字段选择 ESC 直接完全退出
		const { ui, calls, mismatches, leftover } = createScriptedUi([
			{ select: "description" }, // 1. 选择字段
			{ input: undefined }, // 2. description 输入 ESC → 回字段选择
			{ select: undefined }, // 3. 字段选择 ESC → 完全退出（agentName 预选）
		]);

		// Act
		await runConfigFlow({ ui, cwd: workspaceDir, agents, agentName: "coder" });

		// Assert
		expect(mismatches).toEqual([]);
		expect(leftover).toEqual([]);
		expect(calls).toHaveLength(3);
		expect(calls[2].options, "description 输入 ESC 后应回到字段选择（选项与首次提问一致）").toEqual(calls[0].options);
		// 回退零写入：文件字节不变、无重命名
		expect(fs.readFileSync(filePath, "utf-8")).toBe(before);
		expect(fs.readdirSync(agentsDir)).toEqual(["coder.md"]);
	});

	it("should notify an error and not crash when the preselected agentName is unknown", async () => {
		// Arrange
		writeProjectAgent("coder");
		const { agents } = discoverAgents(workspaceDir, "both");
		const { ui, calls, notifyMock } = createScriptedUi([]);

		// Act
		await runConfigFlow({ ui, cwd: workspaceDir, agents, agentName: "ghost" });

		// Assert: 不提问、不写文件、有错误提示
		expect(calls).toHaveLength(0);
		expect(notifyMock).toHaveBeenCalled();
		const [message, type] = notifyMock.mock.calls[0];
		expect(String(message)).toMatch(/ghost/);
		expect(["error", "warning"]).toContain(type);
		expect(fs.readdirSync(agentsDir)).toEqual(["coder.md"]);
	});

	it("should skip agent selection when agentName is preselected (命令参数 seam)", async () => {
		// Arrange
		writeProjectAgent("coder");
		writeProjectAgent("writer");
		const { agents } = discoverAgents(workspaceDir, "both");
		const { ui, calls, mismatches, leftover } = createScriptedUi([
			{ select: "description" },
			{ input: "D2" },
			{ select: undefined }, // 写回成功 → 回字段选择；字段选择 ESC → 完全退出（agentName 预选）
		]);

		// Act
		await runConfigFlow({ ui, cwd: workspaceDir, agents, agentName: "coder" });

		// Assert
		expect(mismatches).toEqual([]);
		expect(leftover).toEqual([]);
		const offeredOptions = calls.filter((c) => c.kind === "select").flatMap((c) => c.options ?? []);
		expect(offeredOptions.some((o) => o === "coder" || o === "writer"), "预选后不应再列 agent").toBe(false);
	});
});

// ===========================================================================
// B11. model/thinking 编辑复用 editAgentModelConfig + clear 选项
// 子流程写入成功 → 回父流程字段选择（本轮语义变更：脚本末尾追加父流程字段
// 选择 ESC 步，写回断言保留）。
// ===========================================================================
describe("B11. model/thinking 合并编辑（动作选择层：edit / clear model & thinking）", () => {
	it("should enter the combined subflow when the merged field is chosen (agent 文件不受影响)", async () => {
		// Arrange
		const agentPath = writeProjectAgent("coder", "model: fm/coder-model");
		const before = fs.readFileSync(agentPath, "utf-8");
		const { agents } = discoverAgents(workspaceDir, "both");
		const { ui, calls, mismatches, leftover, notifyMock } = createScriptedUi([
			{ select: "model & thinking" }, // 1. 父流程字段选择（合并项）→ 子流程
			{ select: "edit model & thinking" }, // 2. 子流程动作选择 edit
			{ input: "vendor/m-new" }, // 3. model 值步（$models 空 → input）
			{ select: "not set" }, // 4. thinking 值步：未配置 (current) → null
			{ select: "user" }, // 5. 写入目标
			{ select: undefined }, // 6. 子流程写回成功 → 回父流程字段选择；字段选择 ESC → 完全退出（agentName 预选）
		]);

		// Act
		await runConfigFlow({ ui, cwd: workspaceDir, agents, agentName: "coder" });

		// Assert: 序列对齐；第 2 步是子流程动作选择层（edit / clear 两项）
		expect(mismatches).toEqual([]);
		expect(leftover).toEqual([]);
		const actionCall = calls.filter((c) => c.kind === "select")[1];
		expect(
			actionCall.options?.some((o) => /edit/i.test(o) && /\bmodel\b/i.test(o) && /\bthinking\b/i.test(o)),
			"动作选择层应含 edit model & thinking 项",
		).toBe(true);
		expect(
			actionCall.options?.some((o) => /clear/i.test(o) && /\bmodel\b/i.test(o) && /\bthinking\b/i.test(o)),
			"动作选择层应含 clear model & thinking 项",
		).toBe(true);
		// 一次写入：thinking 显式未配置 → 只写 model；agent 文件字节不变
		expect(loadModelOverridesFile(userFile)).toEqual({ coder: { model: "vendor/m-new" } });
		expect(fs.readFileSync(agentPath, "utf-8")).toBe(before);
		expect(allNotifyText(notifyMock), "model 覆盖即时生效，提示不得含 reload").not.toMatch(/reload/i);
	});

	it("should write both model and thinking in one pass with the 7-level select and the project-level file", async () => {
		// Arrange
		writeProjectAgent("coder", "thinking: low");
		const { agents } = discoverAgents(workspaceDir, "both");
		const { ui, calls, mismatches, leftover, notifyMock } = createScriptedUi([
			{ select: "model & thinking" }, // 1. 父流程字段选择（合并项）→ 子流程
			{ select: "edit model & thinking" }, // 2. 动作选择 edit
			{ input: "keep/m" }, // 3. model 值步（$models 空 → input）
			{ select: "high" }, // 4. thinking 值步：官方 7 级别 select
			{ select: "project" }, // 5. 写入目标
			{ select: undefined }, // 6. 写回成功 → 回父流程字段选择；字段选择 ESC → 完全退出（agentName 预选）
		]);

		// Act
		await runConfigFlow({ ui, cwd: workspaceDir, agents, agentName: "coder" });

		// Assert
		expect(mismatches).toEqual([]);
		expect(leftover).toEqual([]);
		const levelCall = calls.find(
			(c) => c.kind === "select" && c.options?.some((o) => o.includes("off")) && c.options?.some((o) => o.includes("max")),
		);
		expect(levelCall, "应有一个提供官方 7 级别的 thinking select").toBeDefined();
		for (const level of ["off", "minimal", "low", "medium", "high", "xhigh", "max"]) {
			expect(levelCall!.options!.some((o) => o.includes(level)), `thinking 选项缺 ${level}`).toBe(true);
		}
		// 合并写入：model 与 thinking 一次落盘（entry 完整，不再有字段级遮蔽坑）
		expect(loadModelOverridesFile(workspaceFile)).toEqual({ coder: { model: "keep/m", thinking: "high" } });
		expect(fs.existsSync(userFile)).toBe(false);
		expect(allNotifyText(notifyMock)).not.toMatch(/reload/i);
	});

	it("should clear the whole entry via the combined clear action and fall back to frontmatter", async () => {
		// Arrange: project 级覆盖 thinking=low；frontmatter thinking=minimal
		writeProjectAgent("coder", "thinking: minimal");
		fs.mkdirSync(path.dirname(workspaceFile), { recursive: true });
		fs.writeFileSync(workspaceFile, JSON.stringify({ coder: { thinking: "low" } }), "utf-8");
		const { agents } = discoverAgents(workspaceDir, "both");
		const { ui, mismatches, leftover, notifyMock } = createScriptedUi([
			{ select: "model & thinking" }, // 1. 父流程字段选择（合并项）→ 子流程
			{ select: "clear model & thinking" }, // 2. 动作选择 clear（整体清除，无值步）
			{ select: "project" }, // 3. 写入目标（清除也按目标文件生效）
			{ select: undefined }, // 4. clear 写回成功 → 回父流程字段选择；字段选择 ESC → 完全退出（agentName 预选）
		]);

		// Act
		await runConfigFlow({ ui, cwd: workspaceDir, agents, agentName: "coder" });

		// Assert: coder 整条 entry 移除（两字段 null → entry 消失）
		expect(mismatches).toEqual([]);
		expect(leftover).toEqual([]);
		expect(loadModelOverridesFile(workspaceFile)).toEqual({});
		// 合并视图回退 frontmatter
		const view = computeEffectiveModelConfigs(agents, loadModelOverridesFile(userFile), loadModelOverridesFile(workspaceFile));
		const coder = view.find((v) => v.name === "coder");
		expect(coder?.thinking).toBe("minimal");
		expect(coder?.thinkingSource).toBe("frontmatter");
		expect(allNotifyText(notifyMock)).not.toMatch(/reload/i);
	});

	it("should clear the whole entry on the user level and fall back to the frontmatter model", async () => {
		// Arrange: user 级覆盖 model；frontmatter model=fm/coder-model
		writeProjectAgent("coder", "model: fm/coder-model");
		fs.writeFileSync(userFile, JSON.stringify({ coder: { model: "user/override-model" } }), "utf-8");
		const { agents } = discoverAgents(workspaceDir, "both");
		const { ui, mismatches, leftover, notifyMock } = createScriptedUi([
			{ select: "model & thinking" }, // 1. 父流程字段选择（合并项）→ 子流程
			{ select: "clear model & thinking" }, // 2. 动作选择 clear
			{ select: "user" }, // 3. 写入目标
			{ select: undefined }, // 4. clear 写回成功 → 回父流程字段选择；字段选择 ESC → 完全退出（agentName 预选）
		]);

		// Act
		await runConfigFlow({ ui, cwd: workspaceDir, agents, agentName: "coder" });

		// Assert
		expect(mismatches).toEqual([]);
		expect(leftover).toEqual([]);
		expect(loadModelOverridesFile(userFile)).toEqual({});
		const view = computeEffectiveModelConfigs(agents, loadModelOverridesFile(userFile), loadModelOverridesFile(workspaceFile));
		const coder = view.find((v) => v.name === "coder");
		expect(coder?.model).toBe("fm/coder-model");
		expect(coder?.modelSource).toBe("frontmatter");
		expect(allNotifyText(notifyMock)).not.toMatch(/reload/i);
	});
});

// ===========================================================================
// B12. body 编辑集成（注入 editBody 回调，测试不真 spawn 编辑器）
// 保存/未修改/失败三路写回后均回字段选择（本轮语义变更：脚本末尾追加字段选
// 择 ESC 步；取消路径既有"回字段选择"语义不变）——四路回字段选择的显式契
// 约见文件尾 G 组。
// ===========================================================================
describe("B12. body 编辑集成（editBody 注入 seam）", () => {
	it("should invoke the injected editBody callback with the agent file path and persist its result", async () => {
		// Arrange
		const filePath = writeProjectAgent("coder", "tools: read");
		const { agents } = discoverAgents(workspaceDir, "both");
		const newContent = agentFileContent("coder", "coder agent", "tools: read", "Body rewritten by editor.");
		// Fake editBody：模拟"编辑器把新内容写回文件"的完整操作
		const editBody = vi.fn(async (p: string) => {
			fs.writeFileSync(p, newContent, "utf-8");
			return { ok: true, changed: true };
		});
		const { ui, mismatches, leftover, notifyMock } = createScriptedUi([
			{ select: "body" },
			{ select: undefined }, // 保存成功 → 回字段选择；字段选择 ESC → 完全退出（agentName 预选）
		]);

		// Act
		await runConfigFlow({ ui, cwd: workspaceDir, agents, agentName: "coder", editBody });

		// Assert
		expect(mismatches).toEqual([]);
		expect(leftover).toEqual([]);
		expect(editBody).toHaveBeenCalledTimes(1);
		expect(editBody.mock.calls[0][0], "editBody 应收到 agent 文件路径").toBe(filePath);
		expect(readAgent(filePath).body).toBe("Body rewritten by editor.");
		expect(readAgent(filePath).tools).toEqual(["read"]);
		expect(allNotifyText(notifyMock), "body 即时生效，提示不得含 reload").not.toMatch(/reload/i);
	});

	it("should leave the file untouched when editBody reports no change", async () => {
		// Arrange
		const filePath = writeProjectAgent("coder");
		const before = fs.readFileSync(filePath, "utf-8");
		const { agents } = discoverAgents(workspaceDir, "both");
		const editBody = vi.fn(async () => ({ ok: true, changed: false }));
		const { ui, mismatches, leftover } = createScriptedUi([
			{ select: "body" },
			{ select: undefined }, // 未修改（:q）→ 回字段选择；字段选择 ESC → 完全退出（agentName 预选）
		]);

		// Act
		await runConfigFlow({ ui, cwd: workspaceDir, agents, agentName: "coder", editBody });

		// Assert
		expect(mismatches).toEqual([]);
		expect(leftover).toEqual([]);
		expect(fs.readFileSync(filePath, "utf-8")).toBe(before);
	});

	it("should notify an error and leave the file untouched when editBody fails (editor 异常退出)", async () => {
		// Arrange
		const filePath = writeProjectAgent("coder");
		const before = fs.readFileSync(filePath, "utf-8");
		const { agents } = discoverAgents(workspaceDir, "both");
		const editBody = vi.fn(async () => ({ ok: false, error: "editor exited with code 1" }));
		const { ui, mismatches, leftover, notifyMock } = createScriptedUi([
			{ select: "body" },
			{ select: undefined }, // 失败 → 回字段选择；字段选择 ESC → 完全退出（agentName 预选）
		]);

		// Act
		await runConfigFlow({ ui, cwd: workspaceDir, agents, agentName: "coder", editBody });

		// Assert
		expect(mismatches).toEqual([]);
		expect(leftover).toEqual([]);
		expect(fs.readFileSync(filePath, "utf-8")).toBe(before);
		const errored = notifyMock.mock.calls.some(([m, t]) => t === "error" && /editor|exit|1/.test(String(m)));
		expect(errored, "editBody 失败应有 error 级提示").toBe(true);
	});

	it("should notify a distinguishable launch failure (not 'unchanged') when the default editor fails to start", async () => {
		// Arrange: $EDITOR 指向不存在的命令 → spawn 失败（清单 3：$EDITOR 未设置/不存在场景）。
		// 不注入 editBody → 走缺省 editAgentBodyWithEditor → openBodyInExternalEditor 真实 spawn。
		const filePath = writeProjectAgent("coder");
		const before = fs.readFileSync(filePath, "utf-8");
		const { agents } = discoverAgents(workspaceDir, "both");
		const { ui, mismatches, leftover, notifyMock } = createScriptedUi([
			{ select: "body" },
			{ select: undefined }, // 启动失败 → 回字段选择；字段选择 ESC → 完全退出（agentName 预选）
		]);
		const savedEditor = process.env.EDITOR;
		const savedVisual = process.env.VISUAL;
		process.env.EDITOR = "subagent-test-no-such-editor-9f3b2c";
		delete process.env.VISUAL;
		try {
			// Act
			await runConfigFlow({ ui, cwd: workspaceDir, agents, agentName: "coder" });
		} finally {
			if (savedEditor === undefined) delete process.env.EDITOR;
			else process.env.EDITOR = savedEditor;
			if (savedVisual === undefined) delete process.env.VISUAL;
			else process.env.VISUAL = savedVisual;
		}

		// Assert: 不写盘；提示为 error 级"失败"，与取消/未改动的 "unchanged" 文本可区分
		expect(mismatches).toEqual([]);
		expect(leftover).toEqual([]);
		expect(fs.readFileSync(filePath, "utf-8"), "编辑器未启动不得写盘").toBe(before);
		const text = allNotifyText(notifyMock);
		expect(text, "启动失败不得误报为 unchanged（与取消提示可区分）").not.toMatch(/unchanged|未改动/);
		const failed = notifyMock.mock.calls.some(([m, t]) => t === "error" && /editor|launch|start|fail|启动|失败/i.test(String(m)));
		expect(failed, "编辑器启动失败应有 error 级失败提示").toBe(true);
	});

	it("should return to the field select (no write, no failure notice) when the user cancels the editor (read → undefined)", async () => {
		// Arrange: editBody 走真实 editAgentBodyWithEditor，read 返回 undefined（用户取消，控制组）
		const filePath = writeProjectAgent("coder");
		const before = fs.readFileSync(filePath, "utf-8");
		const { agents } = discoverAgents(workspaceDir, "both");
		const editBody = (p: string) => runBodyEditor({ filePath: p, read: async () => undefined as string | undefined });
		// ESC 回退语义（F2）：body 取消（read undefined）→ 回字段选择；字段选择
		// ESC → 完全退出（agentName 预选，无 agent 选择层级）
		const { ui, calls, mismatches, leftover, notifyMock } = createScriptedUi([
			{ select: "body" }, // 1. 选择 body 字段
			{ select: undefined }, // 2. body 取消后回到字段选择，ESC 退出
		]);

		// Act
		await runConfigFlow({ ui, cwd: workspaceDir, agents, agentName: "coder", editBody });

		// Assert: 不写盘；提示为"未改动"而非失败（与启动失败提示可区分）
		expect(mismatches).toEqual([]);
		expect(leftover).toEqual([]);
		expect(calls).toHaveLength(2);
		expect(calls[1].options, "body 取消后应回到字段选择（选项与首次提问一致）").toEqual(calls[0].options);
		expect(fs.readFileSync(filePath, "utf-8")).toBe(before);
		const text = allNotifyText(notifyMock);
		expect(text, "取消不得伴随失败字样").not.toMatch(/fail|失败/i);
		expect(text, "取消应提示未改动").toMatch(/unchanged|未改动/);
		expect(notifyMock.mock.calls.some(([, t]) => t === "error"), "取消不得产生 error 级提示").toBe(false);
	});
});

// ===========================================================================
// B13. 写失败路径（IO 错误 → notify error 且文件不变）
// ===========================================================================
describe("B13. 写失败路径", () => {
	it("should notify an error and leave the file unchanged when the write hits an IO error", async () => {
		// Arrange: 只读文件 + 只读目录（对直接写与原子 rename 两种实现都构成失败）
		const filePath = writeProjectAgent("coder");
		const before = fs.readFileSync(filePath, "utf-8");
		fs.chmodSync(filePath, 0o444);
		fs.chmodSync(agentsDir, 0o555);
		const { agents } = discoverAgents(workspaceDir, "both");
		const { ui, notifyMock } = createScriptedUi([{ select: "description" }, { input: "Doomed" }]);

		// Act
		try {
			await runConfigFlow({ ui, cwd: workspaceDir, agents, agentName: "coder" });
		} finally {
			fs.chmodSync(agentsDir, 0o755);
			fs.chmodSync(filePath, 0o644);
		}

		// Assert: 有 error 级提示，文件字节不变
		const errored = notifyMock.mock.calls.some(([, t]) => t === "error");
		expect(errored, "写失败应有 error 级提示").toBe(true);
		expect(fs.readFileSync(filePath, "utf-8")).toBe(before);
	});
});

// ===========================================================================
// E. UX 改进（红阶段）：字段选项标注当前值 + 文本输入预填"在原值上修改"
// ===========================================================================
// 断言全部走 calls 记录（子串/正则匹配），与实现文案润色解耦。标注是追加内容，
// B8/B9/B10 既有用例（英文 key 子串匹配）必须保持绿。
describe("E. UX 改进：字段选项标注当前值与文本输入预填（红阶段契约）", () => {
	// ---------------------------------------------------------------------
	// E1. 字段选择 select 标注当前值
	// ---------------------------------------------------------------------
	it("should annotate the description/tools/skills/body field options with their current values", async () => {
		// Arrange: 全文本字段有值；body 首行 "You are the coder agent."
		writeProjectAgent("coder", "tools: read, write\nskills: systematic-debugging, deep-research");
		const { agents } = discoverAgents(workspaceDir, "both");
		const { ui, calls, mismatches, leftover } = createScriptedUi([{ select: undefined }]); // 字段选择步取消

		// Act
		await runConfigFlow({ ui, cwd: workspaceDir, agents, agentName: "coder" });

		// Assert: 字段 select 各选项（按字段 key 词边界定位）携带当前值
		expect(mismatches).toEqual([]);
		expect(leftover).toEqual([]);
		const fieldCall = calls.find((c) => c.kind === "select");
		expect(fieldCall, "应有字段选择 select").toBeDefined();
		const options = fieldCall!.options ?? [];
		const optionOf = (field: string) => options.find((o) => new RegExp(`\\b${field}\\b`, "i").test(o));
		expect(optionOf("description"), "字段选项缺 description").toBeDefined();
		expect(optionOf("description")!, "description 选项应标注当前 description").toContain("coder agent");
		expect(optionOf("tools"), "字段选项缺 tools").toBeDefined();
		expect(optionOf("tools")!, "tools 选项应标注当前 tools").toContain("read");
		expect(optionOf("tools")!, "tools 选项应标注当前 tools").toContain("write");
		expect(optionOf("skills"), "字段选项缺 skills").toBeDefined();
		expect(optionOf("skills")!, "skills 选项应标注当前 skills").toContain("systematic-debugging");
		expect(optionOf("body"), "字段选项缺 body").toBeDefined();
		expect(optionOf("body")!, "body 选项应标注当前正文摘要").toContain("You are the coder");
	});

	it("should annotate the combined model & thinking field option with the effective model and its source", async () => {
		// Arrange: user 级覆盖 vendor/override-m 生效（frontmatter 另有 fm/m）。
		// 覆盖值特意不含 "user" 字样，使 /\buser\b/ 只能来自来源标注。
		writeProjectAgent("coder", "model: fm/m");
		fs.writeFileSync(userFile, JSON.stringify({ coder: { model: "vendor/override-m" } }), "utf-8");
		const { agents } = discoverAgents(workspaceDir, "both");
		const { ui, calls, mismatches, leftover } = createScriptedUi([{ select: undefined }]);

		// Act
		await runConfigFlow({ ui, cwd: workspaceDir, agents, agentName: "coder" });

		// Assert
		expect(mismatches).toEqual([]);
		expect(leftover).toEqual([]);
		const fieldCall = calls.find((c) => c.kind === "select");
		const modelOption = (fieldCall?.options ?? []).find((o) => /\bmodel\b/i.test(o));
		expect(modelOption, "字段选项缺 model & thinking 合并项").toBeDefined();
		expect(modelOption!, "合并项应标注当前生效 model").toContain("vendor/override-m");
		expect(modelOption!, "合并项应标注生效来源（user 级覆盖）").toMatch(/\buser\b/i);
		expect(modelOption!, "合并项必须同时含 model 与 thinking 两个槽位").toMatch(/\bthinking\b/i);
		expect(modelOption!, "thinking 未配置时槽位应显示占位符").toContain(UNCONFIGURED_PLACEHOLDER);
	});

	it("should annotate the combined model & thinking field option with the effective thinking level", async () => {
		// Arrange: project 级覆盖 high 生效（frontmatter minimal）—— 标注取生效值而非 frontmatter
		writeProjectAgent("coder", "thinking: minimal");
		fs.mkdirSync(path.dirname(workspaceFile), { recursive: true });
		fs.writeFileSync(workspaceFile, JSON.stringify({ coder: { thinking: "high" } }), "utf-8");
		const { agents } = discoverAgents(workspaceDir, "both");
		const { ui, calls, mismatches, leftover } = createScriptedUi([{ select: undefined }]);

		// Act
		await runConfigFlow({ ui, cwd: workspaceDir, agents, agentName: "coder" });

		// Assert
		expect(mismatches).toEqual([]);
		expect(leftover).toEqual([]);
		const fieldCall = calls.find((c) => c.kind === "select");
		const thinkingOption = (fieldCall?.options ?? []).find((o) => /\bthinking\b/i.test(o));
		expect(thinkingOption, "字段选项缺 model & thinking 合并项").toBeDefined();
		expect(thinkingOption!, "合并项应标注当前生效级别（覆盖优先）").toContain("high");
		expect(thinkingOption!, "合并项必须同时含 model 与 thinking 两个槽位").toMatch(/\bmodel\b/i);
		expect(thinkingOption!, "model 未配置时槽位应显示占位符").toContain(UNCONFIGURED_PLACEHOLDER);
	});

	// ---------------------------------------------------------------------
	// E2. 文本输入预填当前值（input 第三参 initial）
	// ---------------------------------------------------------------------
	it("should prefill the description input with the current description", async () => {
		// Arrange: description = "coder agent"（writeProjectAgent 缺省）
		const filePath = writeProjectAgent("coder");
		const { agents } = discoverAgents(workspaceDir, "both");
		const { ui, calls, mismatches, leftover } = createScriptedUi([
			{ select: "description" },
			{ input: "coder agent v2" },
			{ select: undefined }, // 写回成功 → 回字段选择；字段选择 ESC → 完全退出（agentName 预选）
		]);

		// Act
		await runConfigFlow({ ui, cwd: workspaceDir, agents, agentName: "coder" });

		// Assert
		expect(mismatches).toEqual([]);
		expect(leftover).toEqual([]);
		const inputCall = calls.find((c) => c.kind === "input");
		expect(inputCall!.initial, "description 输入应预填当前 description").toBe("coder agent");
		expect(readAgent(filePath).description).toBe("coder agent v2");
	});

	it("should prefill the tools input with the current comma-joined tools", async () => {
		// Arrange
		const filePath = writeProjectAgent("coder", "tools: read, write");
		const { agents } = discoverAgents(workspaceDir, "both");
		const { ui, calls, mismatches, leftover } = createScriptedUi([
			{ select: "tools" },
			{ input: "read, write, bash" },
			{ select: undefined }, // 写回成功 → 回字段选择；字段选择 ESC → 完全退出（agentName 预选）
		]);

		// Act
		await runConfigFlow({ ui, cwd: workspaceDir, agents, agentName: "coder" });

		// Assert: 预填串为 ", " 连接（与既有 placeholder 约定一致，可往返解析）
		expect(mismatches).toEqual([]);
		expect(leftover).toEqual([]);
		const inputCall = calls.find((c) => c.kind === "input");
		expect(inputCall!.initial, "tools 输入应预填当前 tools（逗号连接）").toBe("read, write");
		expect(readAgent(filePath).tools).toEqual(["read", "write", "bash"]);
	});

	it("should prefill the skills input with the current comma-joined skills", async () => {
		// Arrange
		writeProjectAgent("coder", "skills: systematic-debugging, deep-research");
		const { agents } = discoverAgents(workspaceDir, "both");
		const { ui, calls, mismatches, leftover } = createScriptedUi([
			{ select: "skills" },
			{ input: "systematic-debugging" },
			{ select: undefined }, // 写回成功 → 回字段选择；字段选择 ESC → 完全退出（agentName 预选）
		]);

		// Act
		await runConfigFlow({ ui, cwd: workspaceDir, agents, agentName: "coder" });

		// Assert
		expect(mismatches).toEqual([]);
		expect(leftover).toEqual([]);
		const inputCall = calls.find((c) => c.kind === "input");
		expect(inputCall!.initial, "skills 输入应预填当前 skills（逗号连接）").toBe("systematic-debugging, deep-research");
	});

	it("should pass an empty string (not undefined) as initial for tools when the agent has no tools key (空值契约)", async () => {
		// Arrange: 无 tools key
		writeProjectAgent("coder");
		const { agents } = discoverAgents(workspaceDir, "both");
		const { ui, calls, mismatches, leftover } = createScriptedUi([
			{ select: "tools" },
			{ input: "bash" },
			{ select: undefined }, // 写回成功 → 回字段选择；字段选择 ESC → 完全退出（agentName 预选）
		]);

		// Act
		await runConfigFlow({ ui, cwd: workspaceDir, agents, agentName: "coder" });

		// Assert: 钉死空值契约 —— 无当前值时 initial 为空串（调用方无需判空）
		expect(mismatches).toEqual([]);
		expect(leftover).toEqual([]);
		const inputCall = calls.find((c) => c.kind === "input");
		expect(inputCall!.initial, "无 tools 时 initial 应为空串而非 undefined/省略").toBe("");
	});

	// ---------------------------------------------------------------------
	// E3. 预填不改变取消语义
	// ---------------------------------------------------------------------
	it("should keep back-step semantics on a prefilled input: Esc writes nothing even with initial present", async () => {
		// Arrange: description 编辑步 ESC → 回字段选择 → ESC 退出（agentName 预选）
		const filePath = writeProjectAgent("coder");
		const before = fs.readFileSync(filePath, "utf-8");
		const { agents } = discoverAgents(workspaceDir, "both");
		const { ui, calls, mismatches, leftover } = createScriptedUi([
			{ select: "description" },
			{ input: undefined }, // 预填输入框 ESC → 回字段选择
			{ select: undefined }, // 字段选择 ESC → 完全退出
		]);

		// Act
		await runConfigFlow({ ui, cwd: workspaceDir, agents, agentName: "coder" });

		// Assert: 预填已传入，但回退 = 文件字节不变、无重命名
		expect(mismatches).toEqual([]);
		expect(leftover).toEqual([]);
		expect(calls.find((c) => c.kind === "input")!.initial, "回退场景同样应传入预填值").toBe("coder agent");
		expect(fs.readFileSync(filePath, "utf-8")).toBe(before);
		expect(fs.readdirSync(agentsDir)).toEqual(["coder.md"]);
	});
});

// ===========================================================================
// F. UX 改进（红阶段）：总览标注 + ESC 逐级回退 + Clear 说明
// ===========================================================================
// 断言全部走 calls 记录（子串/正则匹配），与实现文案润色解耦。总览标注是追加
// 内容（B8 来源标记子串断言保持绿）；ESC 回退全程零写入；写回成功后回到字段
// 选择（本轮语义变更，可连续编辑；见文件尾 G 组），仅 ESC 逐级回退触发退出。

/** F1 钉死的未配置占位符（全角括号，不会与 model ID 子串撞车）。 */
const UNCONFIGURED_PLACEHOLDER = "not set";

describe("F1. 总览标注：agent picker 选项带生效 model/thinking（红阶段契约）", () => {
	function setupExtension() {
		const pi = createMockPi();
		(mod.default as any)(pi);
		return { pi, command: pi._commandDefs.get("subagent-config") };
	}

	it("should annotate each agent option with its effective model and thinking (整 key 合并语义：project entry 遮蔽 user 级同 key entry)", async () => {
		// Arrange: helper 纯 frontmatter；coder 的 project 级 entry 存在 → 整 key
		// 遮蔽 user 级 entry（总览统一走 computeEffectiveModelConfigs 的整 key 合
		// 并，与 dispatch 一致）——project entry 无 model 字段 → model 回退
		// frontmatter fm/coder-m（user 级 vendor/override-m 被遮蔽，不得出现）；
		// thinking 取 project 级 xhigh（frontmatter minimal 被遮蔽）。
		writeUserAgent("helper", "model: fm/helper-m\nthinking: low");
		writeProjectAgent("coder", "model: fm/coder-m\nthinking: minimal");
		fs.writeFileSync(userFile, JSON.stringify({ coder: { model: "vendor/override-m" } }), "utf-8");
		fs.mkdirSync(path.dirname(workspaceFile), { recursive: true });
		fs.writeFileSync(workspaceFile, JSON.stringify({ coder: { thinking: "xhigh" } }), "utf-8");
		const { command } = setupExtension();
		const { ui, calls } = createScriptedUi([{ select: undefined }]); // picker 顶层 ESC → 退出
		const ctx = { hasUI: true, mode: "tui", cwd: workspaceDir, ui };

		// Act
		await command.handler("", ctx);

		// Assert: 选项语义 = <name> (<source>) — <model> (<thinking)>（顺序：名→来源→model→thinking）
		const options = calls[0]?.options ?? [];
		const helperOption = options.find((o) => /\bhelper\b/.test(o));
		const coderOption = options.find((o) => /\bcoder\b/.test(o));
		expect(helperOption, "picker 缺 helper 选项").toBeDefined();
		expect(coderOption, "picker 缺 coder 选项").toBeDefined();
		// 来源标记兼容（既有断言语义不变）
		expect(helperOption!, "helper 选项应标 user 来源").toMatch(/\buser\b/i);
		expect(coderOption!, "coder 选项应标 project 来源").toMatch(/\bproject\b/i);
		// 生效值标注：无覆盖时取 frontmatter 值
		expect(helperOption!, "helper 选项应标注生效 model").toContain("fm/helper-m");
		expect(helperOption!, "helper 选项应标注生效 thinking").toContain("low");
		// 生效值标注：整 key 合并语义（project entry 存在 → user 级同 key entry
		// 整体不可见；project entry 未配的字段回退 frontmatter）
		expect(coderOption!, "project entry 存在时 user 级 model 被整 key 遮蔽，不得出现在标注中").not.toContain("vendor/override-m");
		expect(coderOption!, "project entry 无 model 字段 → 生效 model 回退 frontmatter").toContain("fm/coder-m");
		expect(coderOption!, "coder 选项应标注生效 thinking（project 级覆盖生效）").toContain("xhigh");
		expect(coderOption!, "被遮蔽的 frontmatter thinking 不得出现在标注中").not.toContain("minimal");
		// 格式顺序钉：name → source → model → thinking
		expect(coderOption!, "选项格式应为 <name> (<source>) — <model> (<thinking>)").toMatch(
			/coder[\s\S]*\bproject\b[\s\S]*fm\/coder-m[\s\S]*xhigh/i,
		);
	});

	it("should show the pinned placeholder for unconfigured slots, and never for configured ones", async () => {
		// Arrange: bare 无 model/thinking 配置；decked 全配置
		writeProjectAgent("bare");
		writeProjectAgent("decked", "model: fm/decked-m\nthinking: high");
		const { command } = setupExtension();
		const { ui, calls } = createScriptedUi([{ select: undefined }]);
		const ctx = { hasUI: true, mode: "tui", cwd: workspaceDir, ui };

		// Act
		await command.handler("", ctx);

		// Assert: 未配置槽位显示占位符；全配置选项不得出现占位符
		const options = calls[0]?.options ?? [];
		const bareOption = options.find((o) => /\bbare\b/.test(o));
		const deckedOption = options.find((o) => /\bdecked\b/.test(o));
		expect(bareOption, "picker 缺 bare 选项").toBeDefined();
		expect(deckedOption, "picker 缺 decked 选项").toBeDefined();
		expect(bareOption!, "未配置 agent 的选项应带占位符not set").toContain(UNCONFIGURED_PLACEHOLDER);
		expect(deckedOption!, "全配置 agent 的选项不得出现占位符").not.toContain(UNCONFIGURED_PLACEHOLDER);
		expect(deckedOption!, "decked 选项应标注生效 model").toContain("fm/decked-m");
		expect(deckedOption!, "decked 选项应标注生效 thinking").toContain("high");
	});

	it("should map the annotated option back to the agent (标注永不进入写入值)", async () => {
		// Arrange: 选项带标注时选中 agent，编辑 description 正常落盘
		const filePath = writeProjectAgent("coder", "model: fm/coder-m");
		const { command } = setupExtension();
		const { ui, calls, mismatches, leftover } = createScriptedUi([
			{ select: "coder" }, // 子串命中标注选项
			{ select: "description" },
			{ input: "Picked via annotated option" },
			{ select: undefined }, // 写回成功 → 回字段选择；字段选择 ESC → 回 agent 选择
			{ select: undefined }, // agent 选择 ESC → 完全退出
		]);
		const ctx = { hasUI: true, mode: "tui", cwd: workspaceDir, ui };

		// Act
		await command.handler("", ctx);

		// Assert: picker 选项确已带标注；标注选项映射回 agent 本体；写入值 = 输入值
		expect(calls[0].options?.some((o) => o.includes("fm/coder-m")), "picker 选项应带生效值标注").toBe(true);
		expect(mismatches).toEqual([]);
		expect(leftover).toEqual([]);
		expect(readAgent(filePath).name, "标注不得混入 agent 名映射").toBe("coder");
		expect(readAgent(filePath).description, "写入值不得混入标注内容").toBe("Picked via annotated option");
	});
});

describe("F2. ESC 逐级回退：editAgentConfig 主流程（红阶段契约）", () => {
	function setupExtension() {
		const pi = createMockPi();
		(mod.default as any)(pi);
		return { pi, command: pi._commandDefs.get("subagent-config") };
	}

	it("should return to the field select on ESC during a text-field edit and allow reselecting another field", async () => {
		// Arrange
		const filePath = writeProjectAgent("coder", "tools: read");
		const { agents } = discoverAgents(workspaceDir, "both");
		const { ui, calls, mismatches, leftover, notifyMock } = createScriptedUi([
			{ select: "tools" }, // 1. 字段选择 tools
			{ input: undefined }, // 2. tools 输入 ESC → 回字段选择
			{ select: "description" }, // 3. 重选 description
			{ input: "Reselected description" }, // 4. 提交新值
			{ select: undefined }, // 5. 写回成功 → 回字段选择；字段选择 ESC → 完全退出（agentName 预选）
		]);

		// Act
		await runConfigFlow({ ui, cwd: workspaceDir, agents, agentName: "coder" });

		// Assert: 回退可重选 —— tools 未动（ESC 零写入），description 落盘
		expect(mismatches).toEqual([]);
		expect(leftover).toEqual([]);
		expect(calls.map((c) => c.kind)).toEqual(["select", "input", "select", "input", "select"]);
		expect(calls[2].options, "编辑 ESC 后应回到同一字段选择").toEqual(calls[0].options);
		expect(fs.existsSync(path.join(agentsDir, "coder.md")), "tools 编辑被 ESC，文件不得变动").toBe(true);
		expect(readAgent(filePath).tools, "tools 编辑被 ESC 不得写盘").toEqual(["read"]);
		expect(readAgent(filePath).description).toBe("Reselected description");
		expect(allNotifyText(notifyMock), "改 description 必须提示需要 /reload").toMatch(/reload/i);
	});

	it("should return to the agent picker on ESC at the field select and allow picking another agent", async () => {
		// Arrange
		const coderPath = writeProjectAgent("coder");
		const coderBefore = fs.readFileSync(coderPath, "utf-8");
		const writerPath = writeProjectAgent("writer");
		const { command } = setupExtension();
		const { ui, calls, mismatches, leftover } = createScriptedUi([
			{ select: "coder" }, // 1. agent 选择 coder
			{ select: undefined }, // 2. 字段选择 ESC → 回 agent 选择
			{ select: "writer" }, // 3. 换选 writer
			{ select: "description" }, // 4. 字段选择 description
			{ input: "Writer desc v2" }, // 5. 提交
			{ select: undefined }, // 6. 写回成功 → 回字段选择；字段选择 ESC → 回 agent 选择
			{ select: undefined }, // 7. agent 选择 ESC → 完全退出
		]);
		const ctx = { hasUI: true, mode: "tui", cwd: workspaceDir, ui };

		// Act
		await command.handler("", ctx);

		// Assert: 回退换选 —— coder 零写入，writer 落盘
		expect(mismatches).toEqual([]);
		expect(leftover).toEqual([]);
		expect(calls[2].options, "字段选择 ESC 后应回到 agent 选择（选项与首次一致）").toEqual(calls[0].options);
		expect(fs.readFileSync(coderPath, "utf-8")).toBe(coderBefore);
		expect(readAgent(writerPath).description).toBe("Writer desc v2");
		expect(fs.existsSync(userFile)).toBe(false);
		expect(fs.existsSync(workspaceFile)).toBe(false);
	});

	it("should exit entirely on ESC at the top-level agent picker (恰好一次提问，零写入零提示)", async () => {
		// Arrange
		const agentPath = writeProjectAgent("coder");
		const before = fs.readFileSync(agentPath, "utf-8");
		const { command } = setupExtension();
		const { ui, calls, mismatches, leftover, notifyMock } = createScriptedUi([{ select: undefined }]);
		const ctx = { hasUI: true, mode: "tui", cwd: workspaceDir, ui };

		// Act
		await command.handler("", ctx);

		// Assert: 顶层 ESC = 完全退出（不再提问），不是回退循环
		expect(mismatches).toEqual([]);
		expect(leftover).toEqual([]);
		expect(calls, "agent 选择 ESC 后不得再有任何提问").toHaveLength(1);
		expect(fs.readFileSync(agentPath, "utf-8")).toBe(before);
		expect(fs.existsSync(userFile)).toBe(false);
		expect(fs.existsSync(workspaceFile)).toBe(false);
		expect(notifyMock).not.toHaveBeenCalled();
	});

	it("should exit entirely on ESC at the field select when agentName is preselected (无 agent 选择层级)", async () => {
		// Arrange
		const agentPath = writeProjectAgent("coder");
		const before = fs.readFileSync(agentPath, "utf-8");
		const { agents } = discoverAgents(workspaceDir, "both");
		const { ui, calls, mismatches, leftover } = createScriptedUi([{ select: undefined }]);

		// Act
		await runConfigFlow({ ui, cwd: workspaceDir, agents, agentName: "coder" });

		// Assert: agentName 预选时字段选择之上无层级 → ESC 直接完全退出（不得弹 agent picker）
		expect(mismatches).toEqual([]);
		expect(leftover).toEqual([]);
		expect(calls, "agentName 预选时字段选择 ESC 应完全退出（恰好一次提问）").toHaveLength(1);
		expect(fs.readFileSync(agentPath, "utf-8")).toBe(before);
		expect(fs.existsSync(userFile)).toBe(false);
		expect(fs.existsSync(workspaceFile)).toBe(false);
	});

	it("should write nothing across a multi-level back-navigation chain (编辑 ESC ×2 → 字段选择 ESC → 退出)", async () => {
		// Arrange
		const agentPath = writeProjectAgent("coder", "tools: read");
		const before = fs.readFileSync(agentPath, "utf-8");
		const { agents } = discoverAgents(workspaceDir, "both");
		const { ui, calls, mismatches, leftover } = createScriptedUi([
			{ select: "description" }, // 1. 字段选择 description
			{ input: undefined }, // 2. description 输入 ESC → 回字段选择
			{ select: "tools" }, // 3. 重选 tools
			{ input: undefined }, // 4. tools 输入 ESC → 回字段选择
			{ select: undefined }, // 5. 字段选择 ESC → 完全退出（agentName 预选）
		]);

		// Act
		await runConfigFlow({ ui, cwd: workspaceDir, agents, agentName: "coder" });

		// Assert: 全链回退零写入（文件字节不变、无重命名、两侧 json 不建）
		expect(mismatches).toEqual([]);
		expect(leftover).toEqual([]);
		expect(calls.map((c) => c.kind)).toEqual(["select", "input", "select", "input", "select"]);
		expect(fs.readFileSync(agentPath, "utf-8")).toBe(before);
		expect(fs.readdirSync(agentsDir)).toEqual(["coder.md"]);
		expect(fs.existsSync(userFile)).toBe(false);
		expect(fs.existsSync(workspaceFile)).toBe(false);
	});
});

describe("F3. ESC 逐级回退：editAgentModelConfig 子流程（红阶段契约）", () => {
	it("should return to the action layer on ESC at the model-value step and allow restarting edit (model 值步 ESC → 回动作选择)", async () => {
		// Arrange
		const agentPath = writeProjectAgent("coder");
		const before = fs.readFileSync(agentPath, "utf-8");
		const { agents } = discoverAgents(workspaceDir, "both");
		const { ui, calls, mismatches, leftover } = createScriptedUi([
			{ select: "model & thinking" }, // 1. 父流程字段选择（合并项）→ 进入子流程
			{ select: "edit model & thinking" }, // 2. 子流程动作选择 edit
			{ input: undefined }, // 3. model 值步 ESC → 回动作选择（丢弃已收集值）
			{ select: "edit model & thinking" }, // 4. 重选 edit（换不了字段——合并编辑只有一项）
			{ input: "keep/m" }, // 5. model 值步
			{ select: "high" }, // 6. thinking 值步（官方 7 级别 select）
			{ select: "project" }, // 7. 写入目标
			{ select: undefined }, // 8. 子流程写回成功 → 回父流程字段选择；字段选择 ESC → 完全退出（agentName 预选）
		]);

		// Act
		await runConfigFlow({ ui, cwd: workspaceDir, agents, agentName: "coder" });

		// Assert: 第 4 次提问是动作选择层（含 clear 选项，区别于父流程字段选择）
		expect(mismatches).toEqual([]);
		expect(leftover).toEqual([]);
		expect(calls[3].options, "model 值步 ESC 后应回到动作选择层（与首次一致）").toEqual(calls[1].options);
		expect(calls[3].options?.some((o) => /clear/i.test(o)), "动作选择层应含 clear 选项").toBe(true);
		// 重选后写回成功：model+thinking 合并落盘；agent 文件字节不变
		expect(loadModelOverridesFile(workspaceFile)).toEqual({ coder: { model: "keep/m", thinking: "high" } });
		expect(fs.existsSync(userFile)).toBe(false);
		expect(fs.readFileSync(agentPath, "utf-8")).toBe(before);
	});

	it("should return to the action layer on ESC at the write-target step (目标 ESC → 回动作选择，丢弃已收集值)", async () => {
		// Arrange
		writeProjectAgent("coder");
		const { agents } = discoverAgents(workspaceDir, "both");
		const { ui, calls, mismatches, leftover } = createScriptedUi([
			{ select: "model & thinking" }, // 1. 父流程字段选择
			{ select: "edit model & thinking" }, // 2. 动作选择 edit
			{ input: "vendor/first-m" }, // 3. model 值步
			{ select: "high" }, // 4. thinking 值步
			{ select: undefined }, // 5. 写入目标 ESC → 回动作选择（重编辑覆盖先前收集值）
			{ select: "edit model & thinking" }, // 6. 重选 edit
			{ input: "vendor/second-m" }, // 7. 重输入（覆盖先前收集值）
			{ select: "high" }, // 8. thinking 值步
			{ select: "user" }, // 9. 写入目标 user
			{ select: undefined }, // 10. 子流程写回成功 → 回父流程字段选择；字段选择 ESC → 完全退出（agentName 预选）
		]);

		// Act
		await runConfigFlow({ ui, cwd: workspaceDir, agents, agentName: "coder" });

		// Assert: 第 6 次提问是动作选择层 select（不是值步 input）；只有重编辑值落盘
		expect(mismatches).toEqual([]);
		expect(leftover).toEqual([]);
		expect(calls[5].kind, "写入目标 ESC 后应回到动作选择层（select）").toBe("select");
		expect(calls[5].options?.some((o) => /clear/i.test(o)), "回到的应是动作选择层（含 clear 选项）").toBe(true);
		expect(loadModelOverridesFile(userFile), "只有重编辑的值落盘").toEqual({ coder: { model: "vendor/second-m", thinking: "high" } });
		expect(fs.existsSync(workspaceFile)).toBe(false);
	});

	it("should return to the PARENT field select on ESC at the subflow action layer (不退出、不重启子流程)", async () => {
		// Arrange
		const filePath = writeProjectAgent("coder");
		const { agents } = discoverAgents(workspaceDir, "both");
		const { ui, calls, mismatches, leftover } = createScriptedUi([
			{ select: "model & thinking" }, // 1. 父流程字段选择 → 进入子流程
			{ select: undefined }, // 2. 动作选择层 ESC → 回父流程字段选择
			{ select: "description" }, // 3. 父流程重选 description
			{ input: "Back at parent field" }, // 4. 提交
			{ select: undefined }, // 5. 写回成功 → 回字段选择；字段选择 ESC → 完全退出（agentName 预选）
		]);

		// Act
		await runConfigFlow({ ui, cwd: workspaceDir, agents, agentName: "coder" });

		// Assert: 第 3 次提问是父流程字段选择（与第 1 次一致；5 字段、无 clear 选项）
		expect(mismatches).toEqual([]);
		expect(leftover).toEqual([]);
		expect(calls[2].options, "动作选择 ESC 后应回到父流程字段选择（与首次一致）").toEqual(calls[0].options);
		expect(calls[2].options?.some((o) => /clear/i.test(o)), "父流程字段选择不得含子流程的 clear 选项").toBe(false);
		// 回父流程后可再选其它字段并落盘；model/thinking 零写入
		expect(readAgent(filePath).description).toBe("Back at parent field");
		expect(fs.existsSync(userFile)).toBe(false);
		expect(fs.existsSync(workspaceFile)).toBe(false);
	});

	it("should return to the action layer on ESC at the write-target step of a clear branch (clear 无值步)", async () => {
		// Arrange: project 级已有 model+thinking 覆盖
		writeProjectAgent("coder", "model: fm/coder-m\nthinking: minimal");
		fs.mkdirSync(path.dirname(workspaceFile), { recursive: true });
		fs.writeFileSync(workspaceFile, JSON.stringify({ coder: { model: "keep/m", thinking: "low" } }), "utf-8");
		const { agents } = discoverAgents(workspaceDir, "both");
		const { ui, calls, mismatches, leftover } = createScriptedUi([
			{ select: "model & thinking" }, // 1. 父流程字段选择 → 子流程
			{ select: "clear model & thinking" }, // 2. 动作选择 clear（无值步）
			{ select: undefined }, // 3. 写入目标 ESC → 回动作选择（clear 未执行）
			{ select: "clear model & thinking" }, // 4. 重选 clear
			{ select: "project" }, // 5. 写入目标 project → 执行
			{ select: undefined }, // 6. clear 写回成功 → 回父流程字段选择；字段选择 ESC → 完全退出（agentName 预选）
		]);

		// Act
		await runConfigFlow({ ui, cwd: workspaceDir, agents, agentName: "coder" });

		// Assert: 第 4 次提问是动作选择层；第一个 clear 未落盘，第二个落盘（整条清除）
		expect(mismatches).toEqual([]);
		expect(leftover).toEqual([]);
		expect(calls[3].options, "clear 分支写入目标 ESC 后应回到动作选择层（与首次一致）").toEqual(calls[1].options);
		expect(loadModelOverridesFile(workspaceFile), "clear 被 ESC 不得执行；重选后整条 entry 清除").toEqual({});
		expect(fs.existsSync(userFile)).toBe(false);
	});
});

describe("F4. Clear 说明：动作层标签含 reset 说明 + 完成反馈含双字段回退目标（红阶段契约）", () => {
	it("should label the clear action with a reset-to-frontmatter explanation", async () => {
		// Arrange
		writeProjectAgent("coder");
		const { agents } = discoverAgents(workspaceDir, "both");
		const { ui, calls, mismatches, leftover } = createScriptedUi([
			{ select: "model & thinking" }, // 1. 父流程字段选择（合并项）→ 子流程
			{ select: undefined }, // 2. 动作选择层 ESC → 回父流程字段选择
			{ select: undefined }, // 3. 父流程字段选择 ESC → 完全退出（agentName 预选）
		]);

		// Act
		await runConfigFlow({ ui, cwd: workspaceDir, agents, agentName: "coder" });

		// Assert: 动作选择层的 clear 选项带 reset 说明（整体清除 model & thinking）
		expect(mismatches).toEqual([]);
		expect(leftover).toEqual([]);
		const actionOptions = calls[1].options ?? [];
		const clearAction = actionOptions.find((o) => /clear/i.test(o) && /\bmodel\b/i.test(o) && /\bthinking\b/i.test(o));
		const editAction = actionOptions.find((o) => /edit/i.test(o) && /\bmodel\b/i.test(o) && /\bthinking\b/i.test(o));
		expect(clearAction, "动作选择层缺 clear model & thinking 项").toBeDefined();
		expect(editAction, "动作选择层缺 edit model & thinking 项").toBeDefined();
		expect(clearAction!, "clear 标签应含 reset 说明").toMatch(/\breset\b/i);
		expect(clearAction!, "clear 标签应说明回退目标 frontmatter").toMatch(/\bfrontmatter\b/i);
	});

	it("should notify the fallback target values for both model and thinking after clearing (frontmatter 有值 → 反馈含双回退值)", async () => {
		// Arrange: user 级覆盖 model；frontmatter model=fm/coder-model（无 thinking）
		writeProjectAgent("coder", "model: fm/coder-model");
		fs.writeFileSync(userFile, JSON.stringify({ coder: { model: "user/override-model" } }), "utf-8");
		const { agents } = discoverAgents(workspaceDir, "both");
		const { ui, mismatches, leftover, notifyMock } = createScriptedUi([
			{ select: "model & thinking" }, // 1. 父流程字段选择
			{ select: "clear model & thinking" }, // 2. 动作选择 clear
			{ select: "user" }, // 3. 写入目标
			{ select: undefined }, // 4. clear 写回成功 → 回父流程字段选择；字段选择 ESC → 完全退出（agentName 预选）
		]);

		// Act
		await runConfigFlow({ ui, cwd: workspaceDir, agents, agentName: "coder" });

		// Assert: clear 落盘 + 完成反馈说明双字段各自回退结果（frontmatter + 生效值）
		expect(mismatches).toEqual([]);
		expect(leftover).toEqual([]);
		expect(loadModelOverridesFile(userFile)).toEqual({});
		const text = allNotifyText(notifyMock);
		expect(text, "clear 完成反馈应说明回退到 frontmatter").toMatch(/\bfrontmatter\b/i);
		expect(text, "clear 完成反馈应含回退后的生效 model（frontmatter fm/coder-model）").toContain("fm/coder-model");
	});

	it("should notify the unconfigured fallback after clearing when frontmatter has no value either", async () => {
		// Arrange: project 级覆盖 thinking；frontmatter 无 model/thinking
		writeProjectAgent("coder");
		fs.mkdirSync(path.dirname(workspaceFile), { recursive: true });
		fs.writeFileSync(workspaceFile, JSON.stringify({ coder: { thinking: "low" } }), "utf-8");
		const { agents } = discoverAgents(workspaceDir, "both");
		const { ui, mismatches, leftover, notifyMock } = createScriptedUi([
			{ select: "model & thinking" }, // 1. 父流程字段选择
			{ select: "clear model & thinking" }, // 2. 动作选择 clear
			{ select: "project" }, // 3. 写入目标
			{ select: undefined }, // 4. clear 写回成功 → 回父流程字段选择；字段选择 ESC → 完全退出（agentName 预选）
		]);

		// Act
		await runConfigFlow({ ui, cwd: workspaceDir, agents, agentName: "coder" });

		// Assert: clear 落盘 + 反馈含 frontmatter 与"未配置/未定义"语义
		expect(mismatches).toEqual([]);
		expect(leftover).toEqual([]);
		expect(loadModelOverridesFile(workspaceFile)).toEqual({});
		const text = allNotifyText(notifyMock);
		expect(text, "clear 完成反馈应说明回退到 frontmatter").toMatch(/\bfrontmatter\b/i);
		expect(text, "frontmatter 亦无配置时反馈应含未配置/未定义语义").toMatch(
			/not\s+(configured|set|defined)|none|undefined|未配置|无配置|未定义/i,
		);
	});

	it("should report the recomputed effective values (user level) after clearing a project-level entry in a dual-layer setup", async () => {
		// Arrange: 双层级混合 —— user 级 model=A + project 级 model=B + frontmatter
		// fm/coder-m（project entry 整 key 遮蔽 user）。clear project 级整条后生效
		// 视图重算：project entry 消失 → model 回退到 user 级 A；thinking 无配置。
		// 注意：project 值取名 remove-m（避开 "clear" 子串，防止与选项标注拼接后
		// 误命中 clear 选项正则）。
		writeProjectAgent("coder", "model: fm/coder-m");
		fs.writeFileSync(userFile, JSON.stringify({ coder: { model: "user/keep-m" } }), "utf-8");
		fs.mkdirSync(path.dirname(workspaceFile), { recursive: true });
		fs.writeFileSync(workspaceFile, JSON.stringify({ coder: { model: "project/remove-m" } }), "utf-8");
		const { agents } = discoverAgents(workspaceDir, "both");
		const { ui, mismatches, leftover, notifyMock } = createScriptedUi([
			{ select: "model & thinking" }, // 1. 父流程字段选择
			{ select: "clear model & thinking" }, // 2. 动作选择 clear
			{ select: "project" }, // 3. 写入目标 project
			{ select: undefined }, // 4. clear 写回成功 → 回父流程字段选择；字段选择 ESC → 完全退出（agentName 预选）
		]);

		// Act
		await runConfigFlow({ ui, cwd: workspaceDir, agents, agentName: "coder" });

		// Assert: clear 落盘；clear 完成反馈 = 清除目标 entry 后重算的生效值（user 级
		// A，值自含来源可辨识子串 user/），不得宣称 frontmatter: fm/coder-m。断言限定
		// 在含 "cleared" 的反馈行（写回确认/回退反馈行，不属于本契约的提示不掺入）。
		expect(mismatches).toEqual([]);
		expect(leftover).toEqual([]);
		expect(loadModelOverridesFile(workspaceFile)).toEqual({});
		expect(loadModelOverridesFile(userFile), "user 级 entry 应原样保留").toEqual({ coder: { model: "user/keep-m" } });
		const clearNotify = notifyMock.mock.calls.map((args) => String(args[0])).find((s) => /cleared/i.test(s)) ?? "";
		expect(clearNotify, "clear 反馈应体现清除后重算的生效值（user 级 A）").toContain("user/keep-m");
		expect(clearNotify, "clear 反馈不得宣称回退到 frontmatter 值").not.toContain("fm/coder-m");
	});

	it("should report the still-effective project value after clearing a shadowed user-level entry (dual-layer symmetric)", async () => {
		// Arrange: 对称场景 —— user 级 model=A + project 级 model=B + frontmatter
		// fm/coder-m。clear user 级整条后 project entry 仍整 key 遮蔽 user →
		// 生效值不变仍为 B；反馈不得宣称回退到 frontmatter 或被遮蔽的 user 级 A。
		writeProjectAgent("coder", "model: fm/coder-m");
		fs.writeFileSync(userFile, JSON.stringify({ coder: { model: "user/keep-m" } }), "utf-8");
		fs.mkdirSync(path.dirname(workspaceFile), { recursive: true });
		fs.writeFileSync(workspaceFile, JSON.stringify({ coder: { model: "project/keep-m" } }), "utf-8");
		const { agents } = discoverAgents(workspaceDir, "both");
		const { ui, mismatches, leftover, notifyMock } = createScriptedUi([
			{ select: "model & thinking" }, // 1. 父流程字段选择
			{ select: "clear model & thinking" }, // 2. 动作选择 clear
			{ select: "user" }, // 3. 写入目标 user
			{ select: undefined }, // 4. clear 写回成功 → 回父流程字段选择；字段选择 ESC → 完全退出（agentName 预选）
		]);

		// Act
		await runConfigFlow({ ui, cwd: workspaceDir, agents, agentName: "coder" });

		// Assert: user 级 clear 落盘；project 仍遮蔽 → 生效值不变仍为 B；clear 完成反
		// 馈 = 清除后重算的生效值（B，值自含来源可辨识子串 project/）。断言限定在含
		// "cleared" 的反馈行（写回确认/回退反馈行，不属于本契约的提示不掺入）。
		expect(mismatches).toEqual([]);
		expect(leftover).toEqual([]);
		expect(loadModelOverridesFile(userFile)).toEqual({});
		expect(loadModelOverridesFile(workspaceFile), "project 级 entry 应原样保留").toEqual({ coder: { model: "project/keep-m" } });
		const clearNotify = notifyMock.mock.calls.map((args) => String(args[0])).find((s) => /cleared/i.test(s)) ?? "";
		expect(clearNotify, "clear 反馈应体现清除后仍生效的 project 级值 B").toContain("project/keep-m");
		expect(clearNotify, "clear 反馈不得宣称回退到 frontmatter 值").not.toContain("fm/coder-m");
		expect(clearNotify, "clear 反馈不得宣称已被遮蔽的 user 级值").not.toContain("user/keep-m");
	});
});

// ===========================================================================
// G. 编辑成功/结束后回字段选择（本轮红阶段：用户确认的交互修正）
// ===========================================================================
// 核心语义：所有字段编辑成功后回到字段选择界面（可连续改多个字段），只有
// ESC 逐级回退才退出（字段选择 ESC → agent 选择 ESC → 完全退出）。body 的
// 四条退出路径（保存/未修改/取消/失败）全部回字段选择；model/thinking 子流
// 程写入成功 → 回父流程字段选择。编辑成功后的确认提示（info notify）保留。
describe("G. 编辑成功/结束后回字段选择（可连续修改核心语义，红阶段契约）", () => {
	it("should allow editing multiple fields in one flow, returning to the field select after each successful write (连续多字段编辑)", async () => {
		// Arrange: 一个流程内先改 description 再改 tools，两次都写回成功
		const filePath = writeProjectAgent("coder", "tools: read");
		const { agents } = discoverAgents(workspaceDir, "both");
		const { ui, calls, mismatches, leftover, notifyMock } = createScriptedUi([
			{ select: "description" }, // 1. 字段选择 description
			{ input: "Desc v2" }, // 2. 提交 → 写回成功 → 回字段选择
			{ select: "tools" }, // 3. 重选 tools（未退出）
			{ input: "read, write, bash" }, // 4. 提交 → 写回成功 → 回字段选择
			{ select: undefined }, // 5. 字段选择 ESC → 完全退出（agentName 预选）
		]);

		// Act
		await runConfigFlow({ ui, cwd: workspaceDir, agents, agentName: "coder" });

		// Assert: 两次写回都落盘；每次写回后都回到同一字段选择（可连续修改）
		expect(mismatches).toEqual([]);
		expect(leftover).toEqual([]);
		expect(calls.map((c) => c.kind)).toEqual(["select", "input", "select", "input", "select"]);
		// 标注必须随写回实时刷新（本轮 bug 契约）：第一次写回后 description 标注
		// 含新值；第二次写回后 tools 标注含新列表（且不再停留旧值）。"回到字段
		// 选择"的语义不变：仍是 select 提问、标题含 agent 名。
		expect(calls[2].kind, "第一次写回后应回到字段选择（仍是 select 提问）").toBe("select");
		expect(calls[2].title, "回到字段选择的标题应含 agent 名").toContain("coder");
		const descOption2 = (calls[2].options ?? []).find((o) => /\bdescription\b/i.test(o));
		expect(descOption2, "第一次写回后字段选择的 description 选项应存在").toBeDefined();
		expect(descOption2!, "description 标注应刷新为写回的新值").toContain("Desc v2");
		expect(descOption2!, "description 标注不得停留旧值").not.toContain("coder agent");
		expect(calls[4].kind, "第二次写回后应回到字段选择（仍是 select 提问）").toBe("select");
		expect(calls[4].title, "回到字段选择的标题应含 agent 名").toContain("coder");
		const toolsOption2 = (calls[4].options ?? []).find((o) => /\btools\b/i.test(o));
		expect(toolsOption2, "第二次写回后字段选择的 tools 选项应存在").toBeDefined();
		expect(toolsOption2!, "tools 标注应刷新为新列表").toContain("read, write, bash");
		expect(toolsOption2!, "tools 标注不得停留在旧值（旧标注为 tools — read）").not.toMatch(/tools\s*—\s*read\s*$/i);
		expect(readAgent(filePath).description).toBe("Desc v2");
		expect(readAgent(filePath).tools).toEqual(["read", "write", "bash"]);
		// 确认提示保留：description 改后需 /reload；两次写回各有含 agent 名的 info 确认
		expect(allNotifyText(notifyMock), "改 description 必须提示需要 /reload").toMatch(/reload/i);
		const confirmed = notifyMock.mock.calls.filter(([m, t]) => (t === undefined || t === "info") && String(m).includes("coder"));
		expect(confirmed.length, "每次写回后应有确认提示（两次写回各一条 info）").toBeGreaterThanOrEqual(2);
	});

	it("should return to the parent field select after a successful model subflow write and allow continuing with a text field (子流程写回父字段选择)", async () => {
		// Arrange: model & thinking 经子流程合并写回成功后不退出，回父流程字段
		// 选择继续改 description（thinking 值步确认未配置 → 只写 model）
		const filePath = writeProjectAgent("coder");
		const { agents } = discoverAgents(workspaceDir, "both");
		const { ui, calls, mismatches, leftover } = createScriptedUi([
			{ select: "model & thinking" }, // 1. 父流程字段选择（合并项）→ 进入子流程
			{ select: "edit model & thinking" }, // 2. 子流程动作选择 edit
			{ input: "vendor/cont-m" }, // 3. model 值步
			{ select: "not set" }, // 4. thinking 值步：未配置 (current) → 确认 → null
			{ select: "user" }, // 5. 写入目标 user → 写回成功 → 回父流程字段选择
			{ select: "description" }, // 6. 父流程重选 description（未退出）
			{ input: "After subflow" }, // 7. 提交 → 写回成功 → 回字段选择
			{ select: undefined }, // 8. 字段选择 ESC → 完全退出（agentName 预选）
		]);

		// Act
		await runConfigFlow({ ui, cwd: workspaceDir, agents, agentName: "coder" });

		// Assert: 子流程写回后父字段选择可继续编辑；两侧写回都落盘
		expect(mismatches).toEqual([]);
		expect(leftover).toEqual([]);
		// 子流程写回后父字段选择的 model 标注必须实时刷新（旧值 = frontmatter
		// 默认/未配置占位；本夹具无 frontmatter model → 未配置）。"回到父流程
		// 字段选择"的语义不变：仍是 select 提问、标题含 agent 名。
		expect(calls[5].kind, "子流程写回成功后应回到父流程字段选择（仍是 select 提问）").toBe("select");
		expect(calls[5].title, "回到字段选择的标题应含 agent 名").toContain("coder");
		const modelOption5 = (calls[5].options ?? []).find((o) => /\bmodel\b/i.test(o));
		expect(modelOption5, "子流程写回后父字段选择的 model & thinking 合并项应存在").toBeDefined();
		expect(modelOption5!, "合并项 model 标注应刷新为子流程写回的新值").toContain("vendor/cont-m");
		expect(modelOption5!, "合并项 model 标注应标 user 来源").toMatch(/\buser\b/i);
		// 契约（E 组同款）：未配置槽位必须显示not set——本视图 thinking 未配置
		// （子流程 thinking 值步选not set），故占位符按契约出现；model 槽位已刷
		// 新为新值（vendor/cont-m + user 来源，见上两条断言），不再停留未配置。
		expect(modelOption5!, "thinking 未配置槽位按契约显示占位符not set").toContain(UNCONFIGURED_PLACEHOLDER);
		expect(loadModelOverridesFile(userFile)).toEqual({ coder: { model: "vendor/cont-m" } });
		expect(readAgent(filePath).description).toBe("After subflow");
	});

	it("should return to the field select after a saved body edit (changed:true → 回字段选择)", async () => {
		// Arrange: 保存（changed:true）—— 写盘后回字段选择，不退出
		const filePath = writeProjectAgent("coder");
		const { agents } = discoverAgents(workspaceDir, "both");
		const newContent = agentFileContent("coder", "coder agent", "", "Body v2.");
		const editBody = vi.fn(async (p: string) => {
			fs.writeFileSync(p, newContent, "utf-8");
			return { ok: true, changed: true };
		});
		const { ui, calls, mismatches, leftover, notifyMock } = createScriptedUi([
			{ select: "body" }, // 1. 字段选择 body
			{ select: undefined }, // 2. 保存成功 → 回字段选择；字段选择 ESC → 完全退出
		]);

		// Act
		await runConfigFlow({ ui, cwd: workspaceDir, agents, agentName: "coder", editBody });

		// Assert: 正文落盘；字段选择被重新提问；确认提示保留
		expect(mismatches).toEqual([]);
		expect(leftover).toEqual([]);
		expect(calls).toHaveLength(2);
		// body 保存后字段选择的 body 标注必须实时刷新为新正文摘要（旧正文摘要
		// "You are the coder agent…" 不得停留）。"回到字段选择"语义不变。
		expect(calls[1].kind, "body 保存后应回到字段选择（仍是 select 提问）").toBe("select");
		expect(calls[1].title, "回到字段选择的标题应含 agent 名").toContain("coder");
		const bodyOption1 = (calls[1].options ?? []).find((o) => /\bbody\b/i.test(o));
		expect(bodyOption1, "body 保存后字段选择的 body 选项应存在").toBeDefined();
		expect(bodyOption1!, "body 标注应刷新为新正文摘要").toContain("Body v2");
		expect(bodyOption1!, "body 标注不得停留旧正文摘要").not.toContain("You are the coder");
		expect(readAgent(filePath).body).toBe("Body v2.");
		const confirmed = notifyMock.mock.calls.some(([m, t]) => (t === undefined || t === "info") && String(m).includes("coder"));
		expect(confirmed, "保存成功应有 info 确认提示").toBe(true);
	});

	it("should return to the field select when the body is UNCHANGED (changed:false, :q 场景)", async () => {
		// Arrange: vim :q 未修改退出（changed:false，无 cancelled）—— 现状是直接
		// 结束，本轮钉死必须回字段选择（用户点名的特殊场景）
		const filePath = writeProjectAgent("coder");
		const before = fs.readFileSync(filePath, "utf-8");
		const { agents } = discoverAgents(workspaceDir, "both");
		const editBody = vi.fn(async () => ({ ok: true, changed: false }));
		const { ui, calls, mismatches, leftover, notifyMock } = createScriptedUi([
			{ select: "body" }, // 1. 字段选择 body
			{ select: undefined }, // 2. 未修改 → 回字段选择；字段选择 ESC → 完全退出
		]);

		// Act
		await runConfigFlow({ ui, cwd: workspaceDir, agents, agentName: "coder", editBody });

		// Assert: 字段选择被重新提问（不退出）；零写入；unchanged 提示保留
		expect(mismatches).toEqual([]);
		expect(leftover).toEqual([]);
		expect(calls).toHaveLength(2);
		expect(calls[1].options, "body 未修改（:q）后必须回字段选择（选项与首次一致）").toEqual(calls[0].options);
		expect(fs.readFileSync(filePath, "utf-8"), ":q 未修改不得写盘").toBe(before);
		expect(allNotifyText(notifyMock), "未修改提示语义不变").toMatch(/unchanged|未改动/);
	});

	it("should return to the field select when the body edit is CANCELLED (cancelled → 回字段选择)", async () => {
		// Arrange: 编辑器取消（changed:false + cancelled:true）—— 与未修改同路回字段选择
		const filePath = writeProjectAgent("coder");
		const before = fs.readFileSync(filePath, "utf-8");
		const { agents } = discoverAgents(workspaceDir, "both");
		const editBody = vi.fn(async () => ({ ok: true, changed: false, cancelled: true }));
		const { ui, calls, mismatches, leftover, notifyMock } = createScriptedUi([
			{ select: "body" }, // 1. 字段选择 body
			{ select: undefined }, // 2. 取消 → 回字段选择；字段选择 ESC → 完全退出
		]);

		// Act
		await runConfigFlow({ ui, cwd: workspaceDir, agents, agentName: "coder", editBody });

		// Assert: 回字段选择、零写入、无 error 级提示
		expect(mismatches).toEqual([]);
		expect(leftover).toEqual([]);
		expect(calls).toHaveLength(2);
		expect(calls[1].options, "body 取消后应回到字段选择（选项与首次一致）").toEqual(calls[0].options);
		expect(fs.readFileSync(filePath, "utf-8")).toBe(before);
		expect(notifyMock.mock.calls.some(([, t]) => t === "error"), "取消不得产生 error 级提示").toBe(false);
	});

	it("should return to the field select when the body edit FAILS (ok:false → 回字段选择)", async () => {
		// Arrange: 编辑器失败（ok:false）—— 现状是报错后直接结束，本轮钉死必须回字段选择
		const filePath = writeProjectAgent("coder");
		const before = fs.readFileSync(filePath, "utf-8");
		const { agents } = discoverAgents(workspaceDir, "both");
		const editBody = vi.fn(async () => ({ ok: false, error: "editor crashed" }));
		const { ui, calls, mismatches, leftover, notifyMock } = createScriptedUi([
			{ select: "body" }, // 1. 字段选择 body
			{ select: undefined }, // 2. 失败 → 回字段选择；字段选择 ESC → 完全退出
		]);

		// Act
		await runConfigFlow({ ui, cwd: workspaceDir, agents, agentName: "coder", editBody });

		// Assert: 回字段选择、零写入、error 级提示保留
		expect(mismatches).toEqual([]);
		expect(leftover).toEqual([]);
		expect(calls).toHaveLength(2);
		expect(calls[1].options, "body 失败后应回到字段选择（选项与首次一致）").toEqual(calls[0].options);
		expect(fs.readFileSync(filePath, "utf-8"), "body 失败不得写盘").toBe(before);
		const errored = notifyMock.mock.calls.some(([m, t]) => t === "error" && /editor|crashed|fail/i.test(String(m)));
		expect(errored, "body 失败应有 error 级提示").toBe(true);
	});
});

// ===========================================================================
// H. 排序契约（红阶段）：agent picker 选项顺序 = subagent-isolation.json key 顺序
// ===========================================================================
// 用户需求：agent 显示顺序与 subagent-isolation.json 的 key 顺序相同（如
// tester、coder、reviewer…）；未在 json 中配置的 agent 排在后面（保持
// discoverAgents 的既有相对顺序）。钉死的语义：
//   1. 排序键 = loadModelOverrides(cwd) 的 key 顺序 —— {...user, ...project}
//      合并后保序（user 先出现的 key 在前；同名 key 位置不变；project 新 key
//      追加在后）；$models 特殊 key 不参与（normalizeOverride 对数组返回
//      undefined 而被跳过，故排序键天然不含它）。
//   2. 显示层排序：只作用于 editAgentConfig 的 agent picker 构造处；
//      discoverAgents 返回顺序与派发逻辑不受影响（本组用例钉死文件序基线）。
//   3. 子流程 editAgentModelConfig 无 agent 选择步（agentName 必传，
//      model-config-editor.test.ts 已钉死"子流程化后不存在独立 agent 选择
//      入口"），排序契约只在 editAgentConfig 层。
// 交互探测模式：本组用例全部在 picker 顶层 ESC 退出（零写入、不依赖 G 组
// "写回后回字段选择"的在途语义），失败点 = 选项顺序本身。夹具前提守卫：
// readdir 文件序若与 json 顺序恰好相同则测试无区分度——Arrange 阶段显式
// 断言两者不同，环境异常时大声失败而非静默误绿。
describe("H. 排序契约：agent picker 选项顺序 = json key 顺序（红阶段）", () => {
	function setupExtension() {
		const pi = createMockPi();
		(mod.default as any)(pi);
		return { pi, command: pi._commandDefs.get("subagent-config") };
	}

	/** $models 管理入口选项（picker 恒追加在 agent 选项之后，本组顺序断言剥离它）。 */
	const MODELS_ENTRY_RE = /manage available model list/i;

	/**
	 * 提取 picker 选项数组的纯 agent 顺序（剥离 $models 入口）。F1 钉死选项
	 * 格式名称在最前（名称 → 来源 → model → thinking），故取首 token 即 agent
	 * 名；提取失败（格式假设被破坏）大声报错，便于调整夹具而非静默误判。
	 */
	function agentOrderOf(options: string[] | undefined, knownNames: string[]): string[] {
		const order: string[] = [];
		for (const option of options ?? []) {
			if (MODELS_ENTRY_RE.test(option)) continue;
			const first = option.match(/^\S+/)?.[0] ?? "";
			if (!knownNames.includes(first)) {
				throw new Error(
					`H 组夹具/格式假设被破坏：无法从选项提取 agent 名（选项 = "${option}"，已知名 = [${knownNames.join(", ")}]）`,
				);
			}
			order.push(first);
		}
		return order;
	}

	/** 写 project 级 json（自动建目录）。 */
	function writeProjectJson(entries: Record<string, unknown>): void {
		fs.mkdirSync(path.dirname(workspaceFile), { recursive: true });
		fs.writeFileSync(workspaceFile, JSON.stringify(entries), "utf-8");
	}

	it("should order configured agent options by the project json key order (json 顺序生效，与 readdir 字母序不同)", async () => {
		// Arrange: readdir 文件序 = coder/reviewer/tester；project json 顺序 = tester/coder/reviewer
		writeProjectAgent("coder");
		writeProjectAgent("reviewer");
		writeProjectAgent("tester");
		const jsonOrder = ["tester", "coder", "reviewer"];
		writeProjectJson({
			tester: { model: "m-t" },
			coder: { model: "m-c" },
			reviewer: { model: "m-r" },
		});
		// 夹具前提：discovery（readdir 文件序）必须与 json 顺序不同，测试才有区分度
		const discovered = discoverAgents(workspaceDir, "both").agents.map((a) => a.name);
		expect(discovered, "夹具前提：readdir 文件序不应恰好等于 json 顺序（否则无区分度，请调整 fixture）").not.toEqual(jsonOrder);
		const { command } = setupExtension();
		const { ui, calls } = createScriptedUi([{ select: undefined }]); // picker 顶层 ESC → 退出
		const ctx = { hasUI: true, mode: "tui", cwd: workspaceDir, ui };

		// Act
		await command.handler("", ctx);

		// Assert: 选项顺序 = json key 顺序（tester → coder → reviewer）
		const order = agentOrderOf(calls[0]?.options, ["coder", "reviewer", "tester"]);
		expect(order, "picker 选项顺序必须等于 project json 的 key 顺序（tester/coder/reviewer）").toEqual(jsonOrder);
	});

	it("should place unconfigured agents after configured ones, keeping their discovery order (未配置排后)", async () => {
		// Arrange: 5 个 agent，json 只配 tester/coder（顺序 tester → coder）
		writeProjectAgent("coder");
		writeProjectAgent("reviewer");
		writeProjectAgent("tester");
		writeProjectAgent("helper");
		writeProjectAgent("researcher");
		writeProjectJson({ tester: { model: "m-t" }, coder: { model: "m-c" } });
		const configured = ["tester", "coder"];
		const discovered = discoverAgents(workspaceDir, "both").agents.map((a) => a.name);
		const expected = [...configured, ...discovered.filter((n) => !configured.includes(n))];
		expect(discovered, "夹具前提：discovery 顺序不应恰好等于预期 picker 顺序（否则无区分度）").not.toEqual(expected);
		const { command } = setupExtension();
		const { ui, calls } = createScriptedUi([{ select: undefined }]);
		const ctx = { hasUI: true, mode: "tui", cwd: workspaceDir, ui };

		// Act
		await command.handler("", ctx);

		// Assert: 有配置的在前（json 顺序），无配置的在后（discovery 相对顺序不变）
		const order = agentOrderOf(calls[0]?.options, ["coder", "reviewer", "tester", "helper", "researcher"]);
		expect(order, "未配置 agent 必须排在配置 agent 之后并保持 discoverAgents 相对顺序").toEqual(expected);
	});

	it("should ignore the $models key when ordering agents ($models 不参与排序键)", async () => {
		// Arrange: $models 夹在两个 agent key 之间——若被（错误地）当作排序键会打乱顺序
		writeProjectAgent("coder");
		writeProjectAgent("reviewer");
		writeProjectAgent("tester");
		writeProjectJson({
			tester: { model: "m-t" },
			$models: ["m-list-x"],
			coder: { model: "m-c" },
		});
		const configured = ["tester", "coder"];
		const discovered = discoverAgents(workspaceDir, "both").agents.map((a) => a.name);
		const expected = [...configured, ...discovered.filter((n) => !configured.includes(n))];
		expect(discovered, "夹具前提：discovery 顺序不应恰好等于预期 picker 顺序（否则无区分度）").not.toEqual(expected);
		const { command } = setupExtension();
		const { ui, calls } = createScriptedUi([{ select: undefined }]);
		const ctx = { hasUI: true, mode: "tui", cwd: workspaceDir, ui };

		// Act
		await command.handler("", ctx);

		// Assert: $models 存在不改变 agent 顺序（排序键 = loadModelOverrides 的 key，$models 被跳过）
		const order = agentOrderOf(calls[0]?.options, ["coder", "reviewer", "tester"]);
		expect(order, "$models 不得参与排序键（agent 顺序 = 去掉 $models 后的 json key 顺序）").toEqual(expected);
	});

	it("should order options by the {...user, ...project} merged key order (user 级与 project 级合并保序)", async () => {
		// Arrange: user json { gamma, alpha }；project json { alpha, beta } →
		// 合并 key 顺序 = [gamma, alpha, beta]（user 先出现的在前；同名 alpha 位
		// 置不变；project 新 key beta 追加在后）。若按 project 优先或字段级合并
		// 排序，顺序会是 [alpha, beta, gamma]——本用例钉死整 key 合并保序。
		for (const n of ["alpha", "beta", "gamma", "delta"]) writeProjectAgent(n);
		fs.writeFileSync(userFile, JSON.stringify({ gamma: { model: "m-g" }, alpha: { model: "m-a" } }), "utf-8");
		writeProjectJson({ alpha: { model: "m-a2" }, beta: { model: "m-b" } });
		const mergedOrder = ["gamma", "alpha", "beta"];
		const discovered = discoverAgents(workspaceDir, "both").agents.map((a) => a.name);
		const expected = [...mergedOrder, ...discovered.filter((n) => !mergedOrder.includes(n))];
		expect(discovered, "夹具前提：discovery 顺序不应恰好等于预期 picker 顺序（否则无区分度）").not.toEqual(expected);
		const { command } = setupExtension();
		const { ui, calls } = createScriptedUi([{ select: undefined }]);
		const ctx = { hasUI: true, mode: "tui", cwd: workspaceDir, ui };

		// Act
		await command.handler("", ctx);

		// Assert: 排序键 = loadModelOverrides 合并保序后的 key 顺序
		const order = agentOrderOf(calls[0]?.options, ["alpha", "beta", "gamma", "delta"]);
		expect(order, "选项顺序必须等于 {...user, ...project} 合并后的 key 顺序（user 在前、同名保位、project 新 key 追加）").toEqual(expected);
	});

	it("should keep discoverAgents order unchanged when the picker is sorted (排序只影响显示层，不影响派发)", async () => {
		// Arrange
		writeProjectAgent("coder");
		writeProjectAgent("reviewer");
		writeProjectAgent("tester");
		const jsonOrder = ["tester", "coder", "reviewer"];
		writeProjectJson({
			tester: { model: "m-t" },
			coder: { model: "m-c" },
			reviewer: { model: "m-r" },
		});
		const before = discoverAgents(workspaceDir, "both").agents.map((a) => a.name);
		expect(before, "夹具前提：discovery 顺序不应恰好等于 json 顺序（否则无区分度）").not.toEqual(jsonOrder);
		const { command } = setupExtension();
		const { ui, calls } = createScriptedUi([{ select: undefined }]);
		const ctx = { hasUI: true, mode: "tui", cwd: workspaceDir, ui };

		// Act: 跑一遍显示层流程（读 json、构造 picker）
		await command.handler("", ctx);
		const order = agentOrderOf(calls[0]?.options, ["coder", "reviewer", "tester"]);

		// Assert: picker 已按 json 排序；discoverAgents 顺序保持文件序不变（排序不得泄漏到派发层）
		expect(order, "picker 选项顺序必须等于 json key 顺序").toEqual(jsonOrder);
		const after = discoverAgents(workspaceDir, "both").agents.map((a) => a.name);
		expect(after, "discoverAgents 顺序必须保持文件序（排序是显示层行为，不得泄漏到派发）").toEqual(before);
		const fileOrder = fs
			.readdirSync(agentsDir)
			.filter((f) => f.endsWith(".md"))
			.map((f) => f.replace(/\.md$/, ""));
		expect(after, "discoverAgents 顺序 = agents 目录 readdir 文件序（基线钉死）").toEqual(fileOrder);
	});

	it("should map a sorted picker option back to its agent (排序不得破坏选项→agent 映射)", async () => {
		// Arrange: tester 在排序后的 picker 中位于第 0 位（字母序时位于第 2 位）。
		// 若实现只排序选项数组却仍按未排序 agents 数组的索引映射，选中 tester
		// 会打开错误 agent 的字段选择——本用例是排序实现的回归守卫（当前未排序
		// 实现按标签映射正确，故现状绿；排序实现引入索引错位时转红）。观察点：
		// 详情 notify 已移除，选项→agent 映射改由字段选择标题标识的 agent 名
		// 验证（详情视图不再存在，不可再作为观察点）。
		writeProjectAgent("coder");
		writeProjectAgent("reviewer");
		writeProjectAgent("tester");
		writeProjectJson({
			tester: { model: "m-t" },
			coder: { model: "m-c" },
			reviewer: { model: "m-r" },
		});
		const { command } = setupExtension();
		const { ui, calls, mismatches, leftover } = createScriptedUi([
			{ select: /tester/ }, // 1. 选中 tester 选项
			{ select: undefined }, // 2. 字段选择 ESC → 回 agent 选择
			{ select: undefined }, // 3. agent 选择 ESC → 完全退出
		]);
		const ctx = { hasUI: true, mode: "tui", cwd: workspaceDir, ui };

		// Act
		await command.handler("", ctx);

		// Assert: 字段选择标题展示的是 tester（选项→agent 映射正确）
		expect(mismatches).toEqual([]);
		expect(leftover).toEqual([]);
		expect(calls).toHaveLength(3);
		expect(calls[2].options, "字段选择 ESC 后应回到 agent 选择（选项与首次一致）").toEqual(calls[0].options);
		const fieldSelect = calls.find((c) => c.kind === "select" && /select field/i.test(c.title));
		expect(fieldSelect, "选中 tester 后应进入字段选择").toBeDefined();
		expect(fieldSelect!.title, "选中 tester 选项必须打开 tester 的字段选择").toContain('Agent "tester"');
		expect(fieldSelect!.title, "不得打开其它 agent 的字段选择").not.toContain('Agent "coder"');
		expect(fieldSelect!.title, "不得打开其它 agent 的字段选择").not.toContain('Agent "reviewer"');
	});
});

// ===========================================================================
// I. q 键适配层契约（任务 B 红阶段：适配器 select 走 ui.custom + SelectList，
// q = ESC；文本输入不受影响）
// ===========================================================================
//
// 用户需求：选择菜单中按 q = 向上一级或退出（与 ESC 完全一致）。实现路径：
// adaptModelConfigEditorUI 的 select 在 ui.custom 可用时改用 pi-tui SelectList
// （复用 pickTaskInteractively 的 q/Esc 处理模式）；ui.custom 不可用时回退原生
// ui.select（既有假 UI 命令级用例走回退路径，全部保持绿）。文本输入（预填输入
// 框）例外：q 是正常字符，适配器 input 路径不动。
//
// 可测性结论：q 键真实按键无法在流程层模拟，但适配器经 ui.custom 创建的组件
// 可被测试捕获并直接驱动 handleInput（与 interactive-pickers.test.ts 同款模
// 式），key 数据用裸字符 "q"/"Q"/"\x1b"/"\x03"/"\r" 注入（matchesKey 兼容裸
// 字符与 Kitty CSI-u 形态）——因此 q/Q/Esc/Ctrl+C/Enter 全部可自动化钉死，无
// 需手工验证。
//
// 红阶段说明：当前 select 直接走 ui.select（不经 custom），以下用例全部预期
// 失败（custom 从未被调用），待 coder 改造适配器后转绿。I5 的 input 路径是既
// 有已实现行为（预填走 custom Input），改造后必须保持——绿回归钉。

/** I 组专用：捕获 ui.custom 收到的组件（与 interactive-pickers.test.ts 同款）。 */
interface CapturedCustomComponent {
	component: any;
	done: ReturnType<typeof vi.fn>;
	getRendered: (width?: number) => string;
}

/** I 组专用：可编程 ui.custom mock —— 捕获组件 + 可驱动 done；原生 select/input 为探针。 */
function createAdapterCustomCtx() {
	const notifyMock = vi.fn();
	// 回退路径探针：custom 可用时适配器不得触碰原生 select/input。
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
				// tui stub：Pattern 1 的 handleInput 调 tui.requestRender()（非 optional）
				const tui = { requestRender: vi.fn() };
				const done = vi.fn((value?: unknown) => resolve(value));
				const component = cb(tui, theme, null, done);
				captured.push({
					component,
					done,
					// 通用 SGR 剥离（\x1b[<params>m）：生产侧 Input 光标反显（\x1b[7m…\x1b[27m）
					// 会打断渲染串中值的连续显示（I5 契约），SelectList 主题 stub 无 SGR 恒等；
					// 剥离所有 SGR 输出后断言，对生产侧任何渲染序列免疫。
					getRendered: (width = 80) =>
						component.render(width).map((l: string) => l.replace(/\x1b\[[0-9;]*m/g, "")).join("\n"),
				});
			}),
	);
	const ctx = {
		hasUI: true,
		mode: "tui" as const,
		cwd: workspaceDir,
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

describe("I. q 键适配层契约（红阶段：select 经 ui.custom + SelectList，q = ESC；input 不受影响）", () => {
	// 键常量与 interactive-pickers.test.ts 保持一致（matchesKey 兼容裸字符）。
	const KEY_DOWN = "\x1b[B";
	const KEY_ENTER = "\r";
	const KEY_ESC = "\x1b";
	const KEY_Q = "q";
	const KEY_CTRL_C = "\x03";

	function setupExtension() {
		const pi = createMockPi();
		(mod.default as any)(pi);
		return { pi, command: pi._commandDefs.get("subagent-config") };
	}

	it("I1. should route the agent-picker select through ui.custom (SelectList render) when custom is available, leaving native select untouched", async () => {
		// Arrange
		writeProjectAgent("coder");
		const { command } = setupExtension();
		const { ctx, captured, customMock, nativeSelect } = createAdapterCustomCtx();

		// Act: 弹出 agent 选择（custom 路径）
		const handlerPromise = command.handler("", ctx);
		await waitForCustomCalls(captured, 1);
		expect(captured[0].getRendered(), "SelectList 渲染应包含 agent 选项").toContain("coder");
		captured[0].component.handleInput(KEY_Q); // 顶层 q → 完全退出
		await handlerPromise;

		// Assert: 走 custom 而非原生 select；q 取消安静零写入
		expect(customMock, "custom 可用时 select 必须经 ui.custom").toHaveBeenCalledTimes(1);
		expect(nativeSelect, "custom 可用时不得调用原生 ui.select").not.toHaveBeenCalled();
		expect(fs.existsSync(userFile)).toBe(false);
		expect(fs.existsSync(workspaceFile)).toBe(false);
	});

	it("I2. should propagate the Enter-selected option from the custom SelectList into the flow (field select follows)", async () => {
		// Arrange
		writeProjectAgent("coder");
		const { command } = setupExtension();
		const { ctx, captured, customMock } = createAdapterCustomCtx();

		// Act: picker Enter 选中 coder（首项）→ 字段选择（custom[1]）
		const handlerPromise = command.handler("", ctx);
		await waitForCustomCalls(captured, 1);
		captured[0].component.handleInput(KEY_ENTER);
		await waitForCustomCalls(captured, 2);

		// Assert: 选中值正确回传流程 —— 字段选择已打开且选项完整
		expect(captured[1].getRendered(), "字段选择应含 description 字段选项").toMatch(/description/);
		expect(captured[1].getRendered(), "字段选择应含 model 字段选项").toMatch(/model/);

		// Act: 字段选择 Esc → 回 agent 选择；agent 选择 Esc → 完全退出
		captured[1].component.handleInput(KEY_ESC);
		await waitForCustomCalls(captured, 3);
		captured[2].component.handleInput(KEY_ESC);
		await handlerPromise;

		// Assert: 恰好三次 custom（picker → 字段 → picker），全程零写入
		expect(customMock).toHaveBeenCalledTimes(3);
		expect(fs.existsSync(userFile)).toBe(false);
		expect(fs.existsSync(workspaceFile)).toBe(false);
	});

	it("I3a. should close the custom select with undefined on bare q (q = ESC at the top level)", async () => {
		// Arrange
		writeProjectAgent("coder");
		const { command } = setupExtension();
		const { ctx, captured, customMock, notifyMock } = createAdapterCustomCtx();

		// Act: picker 弹出 → 按 q
		const handlerPromise = command.handler("", ctx);
		await waitForCustomCalls(captured, 1);
		expect(captured[0].done).not.toHaveBeenCalled();
		captured[0].component.handleInput(KEY_Q);
		await handlerPromise;

		// Assert: q 关闭组件（done(undefined)），流程静默退出，无第二层对话框
		expect(captured[0].done, "q 应关闭选择组件（done(undefined)）").toHaveBeenCalledWith(undefined);
		expect(customMock, "q 关闭后流程应退出（无后续对话框）").toHaveBeenCalledTimes(1);
		expect(notifyMock, "picker 即取消是安静的").not.toHaveBeenCalled();
		expect(fs.existsSync(userFile)).toBe(false);
		expect(fs.existsSync(workspaceFile)).toBe(false);
	});

	it("I3b. should close the custom select with undefined on Shift+Q (matchesKey shift+q)", async () => {
		// Arrange
		writeProjectAgent("coder");
		const { command } = setupExtension();
		const { ctx, captured } = createAdapterCustomCtx();

		// Act: picker 弹出 → 按大写 Q
		const handlerPromise = command.handler("", ctx);
		await waitForCustomCalls(captured, 1);
		captured[0].component.handleInput("Q");
		await handlerPromise;

		// Assert: Shift+Q 与 q 对称（matchesKey(data, Key.shift("q"))）
		expect(captured[0].done, "Shift+Q 应关闭选择组件（done(undefined)）").toHaveBeenCalledWith(undefined);
		expect(fs.existsSync(userFile)).toBe(false);
		expect(fs.existsSync(workspaceFile)).toBe(false);
	});

	it("I3c. should close the custom select with undefined on Esc (SelectList onCancel still wired)", async () => {
		// Arrange
		writeProjectAgent("coder");
		const { command } = setupExtension();
		const { ctx, captured } = createAdapterCustomCtx();

		// Act: picker 弹出 → 按 Esc
		const handlerPromise = command.handler("", ctx);
		await waitForCustomCalls(captured, 1);
		captured[0].component.handleInput(KEY_ESC);
		await handlerPromise;

		// Assert: Esc 语义不变（SelectList 的 cancel 键位经 onCancel → done(undefined)）
		expect(captured[0].done, "Esc 应关闭选择组件（done(undefined)）").toHaveBeenCalledWith(undefined);
		expect(fs.existsSync(userFile)).toBe(false);
		expect(fs.existsSync(workspaceFile)).toBe(false);
	});

	it("I3d. should close the custom select with undefined on Ctrl+C (SelectList cancel binding)", async () => {
		// Arrange
		writeProjectAgent("coder");
		const { command } = setupExtension();
		const { ctx, captured } = createAdapterCustomCtx();

		// Act: picker 弹出 → 按 Ctrl+C（\x03）
		const handlerPromise = command.handler("", ctx);
		await waitForCustomCalls(captured, 1);
		captured[0].component.handleInput(KEY_CTRL_C);
		await handlerPromise;

		// Assert: Ctrl+C 与 Esc 同路（tui.select.cancel 默认键位含 escape 与 ctrl+c）
		expect(captured[0].done, "Ctrl+C 应关闭选择组件（done(undefined)）").toHaveBeenCalledWith(undefined);
		expect(fs.existsSync(userFile)).toBe(false);
		expect(fs.existsSync(workspaceFile)).toBe(false);
	});

	it("I4. should treat q at the field select as ESC: back to the agent picker, then q at the top exits (zero writes)", async () => {
		// Arrange
		writeProjectAgent("coder");
		const { command } = setupExtension();
		const { ctx, captured, customMock } = createAdapterCustomCtx();

		// Act: picker Enter（coder）→ 字段选择 → q（= ESC 回退一级）
		const handlerPromise = command.handler("", ctx);
		await waitForCustomCalls(captured, 1);
		captured[0].component.handleInput(KEY_ENTER);
		await waitForCustomCalls(captured, 2);
		captured[1].component.handleInput(KEY_Q);
		await waitForCustomCalls(captured, 3);

		// Assert: q 后回到 agent 选择（回退一级，不是退出）
		expect(captured[2].getRendered(), "字段选择 q 后应回到 agent 选择").toContain("coder");

		// Act: 顶层 q → 完全退出
		captured[2].component.handleInput(KEY_Q);
		await handlerPromise;

		// Assert: 回退全程零写入
		expect(customMock).toHaveBeenCalledTimes(3);
		expect(fs.existsSync(userFile)).toBe(false);
		expect(fs.existsSync(workspaceFile)).toBe(false);
	});

	it("I5. should keep the input path unchanged: prefilled input uses custom Input (not SelectList) and q is a normal character", async () => {
		// Arrange
		writeProjectAgent("coder");
		const { command } = setupExtension();
		const { ctx, captured, nativeInput } = createAdapterCustomCtx();

		// Act: picker Enter（coder）→ 字段选择 Enter（description，首项）→ 预填输入框
		const handlerPromise = command.handler("", ctx);
		await waitForCustomCalls(captured, 1);
		captured[0].component.handleInput(KEY_ENTER);
		await waitForCustomCalls(captured, 2);
		captured[1].component.handleInput(KEY_ENTER);
		await waitForCustomCalls(captured, 3);

		// Assert: 输入框经 custom 弹出且预填当前值；不回退原生 ui.input
		expect(captured[2].getRendered(), "输入框应预填当前 description").toContain("coder agent");
		expect(nativeInput, "custom 可用且 initial 存在时输入不得回退原生 ui.input").not.toHaveBeenCalled();

		// Act: 在输入框里按两次 q —— q 是正常字符，不得关闭输入框
		captured[2].component.handleInput(KEY_Q);
		expect(captured[2].done, "q 在输入框内是普通字符，不得关闭输入框").not.toHaveBeenCalled();
		captured[2].component.handleInput(KEY_Q);
		expect(captured[2].done, "q 在输入框内是普通字符，不得关闭输入框").not.toHaveBeenCalled();
		expect(captured[2].getRendered(), "q 应作为字符进入输入框（光标在 0 处插入）").toContain("qqcoder agent");

		// Act: Enter 提交 "qqcoder agent" → description 落盘
		captured[2].component.handleInput(KEY_ENTER);
		expect(captured[2].done, "Enter 应提交输入值（含 q 的字符串）").toHaveBeenCalledWith("qqcoder agent");

		// Act: 写回成功 → 回字段选择 → Esc 逐级退出
		await waitForCustomCalls(captured, 4);
		captured[3].component.handleInput(KEY_ESC);
		await waitForCustomCalls(captured, 5);
		captured[4].component.handleInput(KEY_ESC);
		await handlerPromise;

		// Assert: 值含 q 被照常写回（description 更新；name 只读身份，文件不重命名）
		const reread = readAgent(path.join(agentsDir, "coder.md"));
		expect(reread.description, "提交值应含 q 且照常写回").toBe("qqcoder agent");
		expect(reread.name, "name 不可编辑，文件不得被重命名").toBe("coder");
		expect(fs.existsSync(path.join(agentsDir, "qqcoder agent.md")), "不得按输入值重命名文件").toBe(false);
	});

	it("I6. should still open the picker via the custom SelectList when no agents are discovered (zero-agent $models entry), q exits quietly", async () => {
		// Arrange: user/project 两侧都没有 agent
		const { command } = setupExtension();
		const { ctx, captured, customMock, notifyMock } = createAdapterCustomCtx();

		// Act: 零 agent 仍弹出 picker（custom 路径）
		const handlerPromise = command.handler("", ctx);
		await waitForCustomCalls(captured, 1);
		expect(captured[0].getRendered(), "零 agent 时 SelectList 应包含 model-list 管理入口").toMatch(/model[\s\S]*list|list[\s\S]*model/i);
		captured[0].component.handleInput(KEY_Q);
		await handlerPromise;

		// Assert: 取消安静零写入
		expect(customMock).toHaveBeenCalledTimes(1);
		expect(notifyMock, "picker 即取消是安静的").not.toHaveBeenCalled();
		expect(fs.existsSync(userFile)).toBe(false);
		expect(fs.existsSync(workspaceFile)).toBe(false);
	});
});

// ===========================================================================
// J. 进程内存级临时覆盖：字段选项标注 + clear 回退（红阶段契约）
// ===========================================================================
// 内存层（模块级单例）优先级最高：process > project json > user json > frontmatter。
// 字段选择选项的生效值/来源标注必须反映内存层（详情 notify 已移除——生效值信息
// 仅靠 picker 总览与字段选项标注）；clear 选 this process 时清除内存覆盖并回退到
// 文件配置，反馈含重算后的生效值。本文件 J 组测试经完整 editAgentConfig
// 流程（字段选择 → 子流程），与 model-config-editor H 组（子流程直驱）互补。
// resetProcessOverridesForTests 模拟进程退出/reload（测试间隔离）。
describe("J. 进程内存级临时覆盖：字段标注与 clear 回退（红阶段契约）", () => {
	beforeEach(() => {
		// 测试间隔离：清空模块级内存覆盖层（红阶段函数不存在时跳过）。
		(mod as any).resetProcessOverridesForTests?.();
	});

	afterEach(() => {
		// 密闭：最后一个用例若留有覆盖，同文件后续 describe 会继承（测试卫生）。
		(mod as any).resetProcessOverridesForTests?.();
	});

	it("should skip the detail notify and show the process-layer value and source in the field-option annotation (无详情 notify；进程覆盖标注在字段选项)", async () => {
		// Arrange: 内存层 model 覆盖生效（遮蔽 frontmatter fm/coder-m）
		writeProjectAgent("coder", "model: fm/coder-m");
		(mod as any).setProcessOverride("coder", { model: "proc/m" });
		const { agents } = discoverAgents(workspaceDir, "both");
		const { ui, calls, mismatches, leftover, notifyMock } = createScriptedUi([
			{ select: undefined }, // 字段选择 ESC → 完全退出（agentName 预选）
		]);

		// Act
		await runConfigFlow({ ui, cwd: workspaceDir, agents, agentName: "coder" });

		// Assert: 取消流程零写入——任何 notify 都只能是详情视图，not.toHaveBeenCalled()
		// 即钉死“无详情 notify”；进程层生效值/来源改由字段 model 选项标注承载。
		expect(mismatches).toEqual([]);
		expect(leftover).toEqual([]);
		expect(calls).toHaveLength(1);
		expect(notifyMock, "选中 agent 后直接进入字段选择，不得有详情 notify（取消流程应安静）").not.toHaveBeenCalled();
		const modelOption = (calls[0].options ?? []).find((o) => /\bmodel\b/i.test(o));
		expect(modelOption, "字段选项缺 model & thinking 合并项").toBeDefined();
		expect(modelOption!, "合并项标注应显示内存层生效 model").toContain("proc/m");
		expect(modelOption!, "合并项 model 来源应含 process").toMatch(/process/i);
		expect(modelOption!, "合并项必须同时含 model 与 thinking 两个槽位").toMatch(/\bthinking\b/i);
		// saved 新语义：单字段（仅 model）进程覆盖也显示 saved；被遮蔽的前端值只
		// 允许出现在 saved 片段内，不得泄漏进 (process) 前的生效值槽位。
		expect(modelOption!, "单字段进程覆盖也应显示 saved 片段").toContain("[saved:");
		const saved = modelOption!.match(/\[saved:([^\]]*)\]/)?.[1];
		expect(saved, "saved 片段应存在").toBeDefined();
		expect(saved!, "saved 片段应显示低层 frontmatter model 值与来源").toMatch(/fm\/coder-m\s*\(\s*frontmatter\s*\)/i);
		expect(modelOption!.split("[saved:")[0]!, "生效值槽位不得含被遮蔽的 frontmatter model（只允许出现在 saved 片段）").not.toContain("fm/coder-m");
	});

	it("should clear the process-layer override via the full flow and fall back to frontmatter with correct feedback", async () => {
		// Arrange: frontmatter model + 内存层覆盖（内存层遮蔽 frontmatter）
		writeProjectAgent("coder", "model: fm/coder-m");
		(mod as any).setProcessOverride("coder", { model: "proc/m" });
		const { agents } = discoverAgents(workspaceDir, "both");
		const { ui, mismatches, leftover, notifyMock } = createScriptedUi([
			{ select: "model & thinking" }, // 1. 父流程字段选择（合并项）→ 子流程
			{ select: "clear model & thinking" }, // 2. 动作选择 clear（整条清除，无值步）
			{ select: "this process" }, // 3. 写入目标 this process
			{ select: undefined }, // 4. clear 成功 → 回父流程字段选择；字段选择 ESC → 完全退出
		]);

		// Act
		await runConfigFlow({ ui, cwd: workspaceDir, agents, agentName: "coder" });

		// Assert: 内存层清空；文件零写入；clear 反馈 = 回退 frontmatter 值
		expect(mismatches).toEqual([]);
		expect(leftover).toEqual([]);
		expect((mod as any).getProcessOverrides(), "clear this process 后内存层应清空").toEqual({});
		expect(fs.existsSync(userFile), "clear this process 不得写 user 级文件").toBe(false);
		expect(fs.existsSync(workspaceFile), "clear this process 不得写 project 级文件").toBe(false);
		const clearNotify = notifyMock.mock.calls.map((args) => String(args[0])).find((s) => /cleared/i.test(s)) ?? "";
		expect(clearNotify, "clear 反馈应说明回退到 frontmatter").toMatch(/\bfrontmatter\b/i);
		expect(clearNotify, "clear 反馈应含回退后的生效值（frontmatter model）").toContain("fm/coder-m");
		expect(clearNotify, "clear 反馈不得宣称被清除的内存层值").not.toContain("proc/m");
	});
});

// ===========================================================================
// K. 写回后菜单标注实时刷新（本轮红阶段，用户报告的 bug 契约）
// ===========================================================================
// 用户报告：在 /subagent-config 里更新一个 agent 的 model 后，同一命令会话
// 内菜单标注不会立即更新（字段选择与 agent 选择列表的标注都是旧值），必须
// 退出命令重新进入才能看到新值。根因：editAgentConfig 的生效视图
// （userOverrides/projectOverrides/effectiveView）、editFields 的
// effective/fieldOptions、agent picker 的 orderedAgents/agentOptions/
// pickerOptions 都在命令入口只计算一次并悬挂在闭包里——任何字段写回成功后
// 这些标注都不刷新。
// 本组钉死新契约：同一次命令会话内，任何写回成功后回到的菜单（父字段选择 /
// agent picker）标注必须立即反映新值（含来源）；clear 后标注回退显示回退
// 值；this process 写入只刷新标注、不落盘。全部经 createScriptedUi 的 calls
// 记录断言（optionOf 风格定位选项，子串/正则匹配，不钉死实现文案）。
describe("K. 写回后菜单标注实时刷新（同一次命令会话内不退出即可见）", () => {
	beforeEach(() => {
		// 测试间隔离：清空模块级内存覆盖层（K7 写 this process 的密闭性）。
		(mod as any).resetProcessOverridesForTests?.();
	});

	afterEach(() => {
		// 密闭：不留覆盖给同文件后续 describe（测试卫生）。
		(mod as any).resetProcessOverridesForTests?.();
	});

	/** optionOf 辅助：按字段 key 词边界定位选项（与 E 组同款风格）。 */
	function optionOf(options: string[] | undefined, field: string): string | undefined {
		return (options ?? []).find((o) => new RegExp(`\\b${field}\\b`, "i").test(o));
	}

	/** setupExtension：命令注册捕获（与 H/B8 组同款，K 组内局部定义）。 */
	function setupExtension() {
		const pi = createMockPi();
		(mod.default as any)(pi);
		return { pi, command: pi._commandDefs.get("subagent-config") };
	}

	/** $models 管理入口选项（picker 恒追加在 agent 选项之后，顺序断言剥离它）。 */
	const PICKER_MODELS_ENTRY_RE = /manage available model list/i;

	/**
	 * 提取 picker 选项数组的纯 agent 顺序（H 组 agentOrderOf 的等价实现——H 组
	 * 的 helper 定义在其 describe 内部不可达）。选项格式
	 * `<name> (<source>) — <model> (<thinking>)`，故取首 token 即 agent 名；
	 * 提取失败（格式假设被破坏）大声报错，便于调整夹具而非静默误判。
	 */
	function pickerAgentOrderOf(options: string[] | undefined, knownNames: string[]): string[] {
		const order: string[] = [];
		for (const option of options ?? []) {
			if (PICKER_MODELS_ENTRY_RE.test(option)) continue;
			const first = option.match(/^\S+/)?.[0] ?? "";
			if (!knownNames.includes(first)) {
				throw new Error(
					`K 组夹具/格式假设被破坏：无法从选项提取 agent 名（选项 = "${option}"，已知名 = [${knownNames.join(", ")}]）`,
				);
			}
			order.push(first);
		}
		return order;
	}

	it("K1 should refresh the model annotation on the parent field select after a model write-back (model → user)", async () => {
		// Arrange: frontmatter model 为旧值；脚本写回新值到 user 级后 ESC 退出
		writeProjectAgent("coder", "model: fm/old-m");
		const { agents } = discoverAgents(workspaceDir, "both");
		const { ui, calls, mismatches, leftover } = createScriptedUi([
			{ select: "model & thinking" }, // 1. 父字段选择（合并项）→ 子流程
			{ select: "edit model & thinking" }, // 2. 动作选择 edit
			{ input: "vendor/cont-m" }, // 3. model 值步（$models 空 → input）
			{ select: "not set" }, // 4. thinking 值步：未配置 (current) → 确认 → null
			{ select: "user" }, // 5. 写入目标 user → 写回成功 → 回父字段选择
			{ select: undefined }, // 6. 父字段选择 ESC → 完全退出（agentName 预选）
		]);

		// Act
		await runConfigFlow({ ui, cwd: workspaceDir, agents, agentName: "coder" });

		// Assert: 回父字段选择那次的合并项标注含新值 + user 来源，不含旧值
		expect(mismatches).toEqual([]);
		expect(leftover).toEqual([]);
		expect(calls[5].kind).toBe("select");
		expect(calls[5].title).toContain("coder");
		const modelOption = optionOf(calls[5].options, "model");
		expect(modelOption, "写回后父字段选择的 model & thinking 合并项应存在").toBeDefined();
		expect(modelOption!, "合并项 model 标注应刷新为写回的新值").toContain("vendor/cont-m");
		expect(modelOption!, "合并项 model 标注应标 user 来源").toMatch(/\buser\b/i);
		expect(modelOption!, "合并项不得停留旧值（frontmatter fm/old-m）").not.toContain("fm/old-m");
	});

	it("K2 should refresh the picker overview annotation after a model write-back without leaving the command (用户报告的确切场景)", async () => {
		// Arrange: 命令级（无 agentName）——picker 总览标注带旧 model
		writeProjectAgent("coder", "model: fm/coder-m");
		const { command } = (() => {
			const pi = createMockPi();
			(mod.default as any)(pi);
			return { command: pi._commandDefs.get("subagent-config") };
		})();
		const { ui, calls, mismatches, leftover } = createScriptedUi([
			{ select: "coder" }, // 1. picker 选 coder
			{ select: "model & thinking" }, // 2. 父字段选择（合并项）→ 子流程
			{ select: "edit model & thinking" }, // 3. 动作选择 edit
			{ input: "new/proj-m" }, // 4. model 值步（$models 空 → input）
			{ select: "not set" }, // 5. thinking 值步 → null
			{ select: "project" }, // 6. 写入目标 project → 写回成功 → 回父字段选择
			{ select: undefined }, // 7. 父字段选择 ESC → 回 agent picker
			{ select: undefined }, // 8. picker ESC → 完全退出
		]);
		const ctx = { hasUI: true, mode: "tui", cwd: workspaceDir, ui };

		// Act
		await command.handler("", ctx);

		// Assert: 第二次 picker 的 coder 选项标注含新 model，不含旧值
		expect(mismatches).toEqual([]);
		expect(leftover).toEqual([]);
		expect(calls[7].kind, "父字段选择 ESC 后应回 agent picker（仍是 select 提问）").toBe("select");
		const coderOption = (calls[7].options ?? []).find((o) => /\bcoder\b/.test(o));
		expect(coderOption, "第二次 picker 应含 coder 选项").toBeDefined();
		expect(coderOption!, "picker 总览标注应刷新为新 model").toContain("new/proj-m");
		expect(coderOption!, "picker 总览标注不得停留旧值（frontmatter fm/coder-m）").not.toContain("fm/coder-m");
	});

	it("K3 should refresh the description annotation on the field select after a description write-back", async () => {
		// Arrange: 缺省 description = "coder agent"（writeProjectAgent 缺省）
		writeProjectAgent("coder");
		const { agents } = discoverAgents(workspaceDir, "both");
		const { ui, calls, mismatches, leftover } = createScriptedUi([
			{ select: "description" }, // 1. 字段选择 description
			{ input: "Desc v3" }, // 2. 提交 → 写回成功 → 回字段选择
			{ select: undefined }, // 3. 字段选择 ESC → 完全退出（agentName 预选）
		]);

		// Act
		await runConfigFlow({ ui, cwd: workspaceDir, agents, agentName: "coder" });

		// Assert: 回字段选择那次的 description 标注含新值、不含旧值
		expect(mismatches).toEqual([]);
		expect(leftover).toEqual([]);
		expect(calls[2].kind).toBe("select");
		const descOption = optionOf(calls[2].options, "description");
		expect(descOption, "写回后字段选择的 description 选项应存在").toBeDefined();
		expect(descOption!, "description 标注应刷新为写回的新值").toContain("Desc v3");
		expect(descOption!, "description 标注不得停留旧值").not.toContain("coder agent");
	});

	it("K4 should refresh the tools annotation on the field select after a tools write-back (旧值被替换)", async () => {
		// Arrange: 旧值 curl 不是新列表的子串，可干净断言"被替换"
		writeProjectAgent("coder", "tools: curl");
		const { agents } = discoverAgents(workspaceDir, "both");
		const { ui, calls, mismatches, leftover } = createScriptedUi([
			{ select: "tools" }, // 1. 字段选择 tools
			{ input: "read, write, bash" }, // 2. 提交 → 写回成功 → 回字段选择
			{ select: undefined }, // 3. 字段选择 ESC → 完全退出（agentName 预选）
		]);

		// Act
		await runConfigFlow({ ui, cwd: workspaceDir, agents, agentName: "coder" });

		// Assert: 回字段选择那次的 tools 标注含新列表、旧值被替换
		expect(mismatches).toEqual([]);
		expect(leftover).toEqual([]);
		expect(calls[2].kind).toBe("select");
		const toolsOption = optionOf(calls[2].options, "tools");
		expect(toolsOption, "写回后字段选择的 tools 选项应存在").toBeDefined();
		expect(toolsOption!, "tools 标注应刷新为新列表").toContain("read, write, bash");
		expect(toolsOption!, "tools 标注不得停留旧值（curl 被替换）").not.toContain("curl");
	});

	it("K5 should refresh the body annotation on the field select after a saved body edit (changed:true)", async () => {
		// Arrange: 注入 editBody 写盘 "Body v2."（与 G 组 body 测试同款写法）
		writeProjectAgent("coder");
		const { agents } = discoverAgents(workspaceDir, "both");
		const newContent = agentFileContent("coder", "coder agent", "", "Body v2.");
		const editBody = vi.fn(async (p: string) => {
			fs.writeFileSync(p, newContent, "utf-8");
			return { ok: true, changed: true };
		});
		const { ui, calls, mismatches, leftover } = createScriptedUi([
			{ select: "body" }, // 1. 字段选择 body
			{ select: undefined }, // 2. 保存成功 → 回字段选择；字段选择 ESC → 完全退出
		]);

		// Act
		await runConfigFlow({ ui, cwd: workspaceDir, agents, agentName: "coder", editBody });

		// Assert: 回字段选择那次的 body 标注含新正文摘要、不含旧正文摘要
		expect(mismatches).toEqual([]);
		expect(leftover).toEqual([]);
		expect(calls[1].kind).toBe("select");
		const bodyOption = optionOf(calls[1].options, "body");
		expect(bodyOption, "body 保存后字段选择的 body 选项应存在").toBeDefined();
		expect(bodyOption!, "body 标注应刷新为新正文摘要").toContain("Body v2");
		expect(bodyOption!, "body 标注不得停留旧正文摘要").not.toContain("You are the coder");
	});

	it("K6 should refresh the model annotation back to the frontmatter value after a clear (user 覆盖被清除)", async () => {
		// Arrange: user 级覆盖遮蔽 frontmatter；clear user → 生效值回退 frontmatter
		writeProjectAgent("coder", "model: fm/coder-m");
		fs.writeFileSync(userFile, JSON.stringify({ coder: { model: "user/override-m" } }), "utf-8");
		const { agents } = discoverAgents(workspaceDir, "both");
		const { ui, calls, mismatches, leftover } = createScriptedUi([
			{ select: "model & thinking" }, // 1. 父字段选择（合并项）→ 子流程
			{ select: "clear model & thinking" }, // 2. 动作选择 clear（整条清除，无值步）
			{ select: "user" }, // 3. 写入目标 user → 清除成功 → 回父字段选择
			{ select: undefined }, // 4. 父字段选择 ESC → 完全退出（agentName 预选）
		]);

		// Act
		await runConfigFlow({ ui, cwd: workspaceDir, agents, agentName: "coder" });

		// Assert: 回字段选择那次的合并项标注回退显示 frontmatter 值 + 来源，
		// 不含被清除的 user 覆盖值
		expect(mismatches).toEqual([]);
		expect(leftover).toEqual([]);
		expect(calls[3].kind).toBe("select");
		const modelOption = optionOf(calls[3].options, "model");
		expect(modelOption, "clear 后字段选择的 model & thinking 合并项应存在").toBeDefined();
		expect(modelOption!, "clear 后合并项 model 标注应回退显示 frontmatter 值").toContain("fm/coder-m");
		expect(modelOption!, "clear 后合并项 model 来源应为 frontmatter").toMatch(/\bfrontmatter\b/i);
		expect(modelOption!, "clear 后合并项不得含被清除的覆盖值").not.toContain("user/override-m");
	});

	it("K7 should refresh the model annotation with the process source after writing to this process, with zero file writes", async () => {
		// Arrange: frontmatter model 旧值；写 this process（内存层）→ 标注刷新
		writeProjectAgent("coder", "model: fm/coder-m");
		const { agents } = discoverAgents(workspaceDir, "both");
		const { ui, calls, mismatches, leftover } = createScriptedUi([
			{ select: "model & thinking" }, // 1. 父字段选择（合并项）→ 子流程
			{ select: "edit model & thinking" }, // 2. 动作选择 edit
			{ input: "proc/m" }, // 3. model 值步（$models 空 → input）
			{ select: "not set" }, // 4. thinking 值步 → null
			{ select: "this process" }, // 5. 写入目标 this process → 写回成功 → 回父字段选择
			{ select: undefined }, // 6. 父字段选择 ESC → 完全退出（agentName 预选）
		]);

		// Act
		await runConfigFlow({ ui, cwd: workspaceDir, agents, agentName: "coder" });

		// Assert: 标注含新值 + process 来源，不含被遮蔽的 frontmatter 值；
		// 内存层写入不得触碰 user/project 文件
		expect(mismatches).toEqual([]);
		expect(leftover).toEqual([]);
		expect(calls[5].kind).toBe("select");
		const modelOption = optionOf(calls[5].options, "model");
		expect(modelOption, "this process 写回后字段选择的 model & thinking 合并项应存在").toBeDefined();
		expect(modelOption!, "合并项 model 标注应刷新为内存层新值").toContain("proc/m");
		expect(modelOption!, "合并项 model 来源应含 process").toMatch(/process/i);
		// saved 新语义：写回 this process 后的单字段（仅 model）覆盖也显示 saved。
		// 被遮蔽的 frontmatter 值只出现在 saved 片段内，生效值槽位不得泄漏。
		expect(modelOption!, "单字段进程覆盖写回后也应显示 saved 片段").toContain("[saved:");
		const saved = modelOption!.match(/\[saved:([^\]]*)\]/)?.[1];
		expect(saved, "saved 片段应存在").toBeDefined();
		expect(saved!, "saved 片段应显示低层 frontmatter model 值与来源").toMatch(/fm\/coder-m\s*\(\s*frontmatter\s*\)/i);
		expect(modelOption!.split("[saved:")[0]!, "生效值槽位不得含被遮蔽的 frontmatter 值（只允许出现在 saved 片段）").not.toContain("fm/coder-m");
		expect(fs.existsSync(userFile), "写 this process 不得写 user 级文件").toBe(false);
		expect(fs.existsSync(workspaceFile), "写 this process 不得写 project 级文件").toBe(false);
	});

	it("K8 should re-order the picker by the new json key when a model write-back creates a fresh override key (回归保护：写回新建 key 后回 picker 排序随 json 更新)", async () => {
		// Arrange: 3 个 agent 均未配置（无任何 json）→ 首次 picker 顺序 = 发现
		// 顺序（readdir 文件序）；给 tester 写 user 级 model 后 → user json 新
		// key [tester] → 回 picker 时 tester 前移到首位（配置过的按 json key 顺
		// 序在前，未配置的按发现顺序在后）。
		writeProjectAgent("coder");
		writeProjectAgent("reviewer");
		writeProjectAgent("tester");
		const allNames = ["coder", "reviewer", "tester"];
		const discovered = discoverAgents(workspaceDir, "both").agents.map((a) => a.name);
		// 夹具前提：tester 不得天然位于发现顺序首位（否则"前移"无区分度），
		// 环境异常时大声失败而非静默误绿（H 组同款模式）。
		expect(discovered[0], "夹具前提：readdir 文件序首位不应是 tester（否则无区分度，请调整 fixture）").not.toBe("tester");
		const { command } = setupExtension();
		const { ui, calls, mismatches, leftover } = createScriptedUi([
			{ select: "tester" }, // 1. picker 选 tester（未配置区，按发现顺序）
			{ select: "model & thinking" }, // 2. 父字段选择（合并项）→ 子流程
			{ select: "edit model & thinking" }, // 3. 动作选择 edit
			{ input: "user/ord-m" }, // 4. model 值步（$models 空 → input）
			{ select: "not set" }, // 5. thinking 值步 → null
			{ select: "user" }, // 6. 写入目标 user → 写回成功 → 回父字段选择
			{ select: undefined }, // 7. 父字段选择 ESC → 回 agent picker
			{ select: undefined }, // 8. picker ESC → 完全退出
		]);
		const ctx = { hasUI: true, mode: "tui", cwd: workspaceDir, ui };

		// Act
		await command.handler("", ctx);

		// Assert: 写回前 picker 顺序 = 发现顺序（tester 不在首位）；写回后 user
		// json key 顺序 [tester] → 第二次 picker 中 tester 前移为首位，其余
		// agent 保持发现相对顺序。
		expect(mismatches).toEqual([]);
		expect(leftover).toEqual([]);
		expect(calls[7].kind, "父字段选择 ESC 后应回 agent picker（仍是 select 提问）").toBe("select");
		expect(calls[7].title, "回到 picker 的标题应含 select agent").toMatch(/select agent/i);
		const firstOrder = pickerAgentOrderOf(calls[0]?.options, allNames);
		expect(firstOrder, "初始无配置时 picker 顺序 = 发现顺序").toEqual(discovered);
		expect(firstOrder[0], "初始 tester 不得在首位（与夹具前提一致）").not.toBe("tester");
		expect(loadModelOverridesFile(userFile), "写回应落盘 user 级 json").toEqual({ tester: { model: "user/ord-m" } });
		const secondOrder = pickerAgentOrderOf(calls[7]?.options, allNames);
		expect(
			secondOrder,
			"写回新建 json key 后，picker 顺序应随 json key 更新：tester 前移到首位，其余保持发现顺序",
		).toEqual(["tester", ...discovered.filter((n) => n !== "tester")]);
		expect(secondOrder[0], "第二次 picker 首位应为 tester（user json key 顺序）").toBe("tester");
	});

	// ---------------------------------------------------------------------
	// K9-K11：合并编辑重构追加（用户场景回归 + 进程级标识 + clear 合并反馈）
	// ---------------------------------------------------------------------
	it("K9 should keep the entry complete after a merged process-layer edit so lower layers are never shadowed (用户场景回归：进程级合并编辑后 model/thinking 都不再意外消失)", async () => {
		// 场景 A：user 级只配 model（无 thinking）。进程级合并编辑 model & thinking：
		// model 输入新值，thinking 值步确认预选的not set(current) → 进程 entry
		// { model: "proc/m" }。断言 model 生效为进程新值、thinking 保持未配置、
		// user 文件原样（低层无遮蔽）。
		writeProjectAgent("coder");
		fs.writeFileSync(userFile, JSON.stringify({ coder: { model: "user/m" } }), "utf-8");
		const userBefore = fs.readFileSync(userFile, "utf-8");
		const { agents } = discoverAgents(workspaceDir, "both");
		const { ui: uiA, calls: callsA, mismatches: mismatchesA, leftover: leftoverA } = createScriptedUi([
			{ select: "model & thinking" }, // 1. 父字段选择（合并项）→ 子流程
			{ select: "edit model & thinking" }, // 2. 动作选择 edit
			{ input: "proc/m" }, // 3. model 值步
			{ select: "not set" }, // 4. thinking 值步：预选not set(current) 并确认
			{ select: "this process" }, // 5. 写入目标 this process
			{ select: undefined }, // 6. 父字段选择 ESC → 完全退出
		]);

		// Act A
		await runConfigFlow({ ui: uiA, cwd: workspaceDir, agents, agentName: "coder" });

		// Assert A：model 生效为进程新值；thinking 保持未配置；user 文件原样
		expect(mismatchesA).toEqual([]);
		expect(leftoverA).toEqual([]);
		expect((mod as any).getProcessOverrides(), "进程 entry 只含 model（thinking 显式未配置）").toEqual({ coder: { model: "proc/m" } });
		const viewA = computeEffectiveModelConfigs(
			agents,
			loadModelOverridesFile(userFile),
			loadModelOverridesFile(workspaceFile),
			(mod as any).getProcessOverrides(),
		).find((v) => v.name === "coder");
		expect(viewA?.model, "model 生效值应为进程新值").toBe("proc/m");
		expect(viewA?.modelSource).toBe("process");
		expect(viewA?.thinking, "thinking 保持未配置（进程/低层均无值）").toBeUndefined();
		expect(fs.readFileSync(userFile, "utf-8"), "写 this process 不得改动 user 文件（低层无遮蔽）").toBe(userBefore);
		expect(fs.existsSync(workspaceFile)).toBe(false);

		// 场景 B（对称）：user 级配 model+thinking。进程级合并编辑时 thinking 值步
		// 预选当前生效值（user 级 high (current)）并确认 → 进程 entry 完整
		// { model, thinking } → thinking 保持低层值（不再是not set——旧 bug）。
		(mod as any).resetProcessOverridesForTests?.();
		fs.writeFileSync(userFile, JSON.stringify({ coder: { model: "user/m", thinking: "high" } }), "utf-8");
		const userBeforeB = fs.readFileSync(userFile, "utf-8");
		const { ui: uiB, calls: callsB, mismatches: mismatchesB, leftover: leftoverB } = createScriptedUi([
			{ select: "model & thinking" }, // 1. 父字段选择（合并项）→ 子流程
			{ select: "edit model & thinking" }, // 2. 动作选择 edit
			{ input: "proc/m" }, // 3. model 值步
			{ select: "high" }, // 4. thinking 值步：预选生效值 high (current) 并确认
			{ select: "this process" }, // 5. 写入目标 this process
			{ select: undefined }, // 6. 父字段选择 ESC → 完全退出
		]);

		// Act B
		await runConfigFlow({ ui: uiB, cwd: workspaceDir, agents, agentName: "coder" });

		// Assert B：进程 entry 完整（model+thinking 合并写入）；thinking 保持低层
		// 值（不再被意外遮蔽成未配置）；user 文件原样
		expect(mismatchesB).toEqual([]);
		expect(leftoverB).toEqual([]);
		expect((mod as any).getProcessOverrides(), "进程 entry 必须完整（model+thinking 一次写入）").toEqual({
			coder: { model: "proc/m", thinking: "high" },
		});
		const viewB = computeEffectiveModelConfigs(
			agents,
			loadModelOverridesFile(userFile),
			loadModelOverridesFile(workspaceFile),
			(mod as any).getProcessOverrides(),
		).find((v) => v.name === "coder");
		expect(viewB?.model, "model 生效值应为进程新值").toBe("proc/m");
		expect(viewB?.thinking, "thinking 保持低层生效值（合并写入后不再变not set）").toBe("high");
		expect(viewB?.thinkingSource).toBe("process");
		expect(fs.readFileSync(userFile, "utf-8"), "写 this process 不得改动 user 文件").toBe(userBeforeB);
		expect(fs.existsSync(workspaceFile)).toBe(false);
	});

	it("K10 should mark agents with a process-layer override with a trailing (process) badge in the picker overview (picker 进程级标识)", async () => {
		// Arrange: 命令级；coder 将在流程内写入 this process，writer 全程无覆盖
		writeProjectAgent("coder");
		writeProjectAgent("writer");
		const { command } = setupExtension();
		const { ui, calls, mismatches, leftover } = createScriptedUi([
			{ select: "coder" }, // 1. picker 选 coder
			{ select: "model & thinking" }, // 2. 父字段选择（合并项）→ 子流程
			{ select: "edit model & thinking" }, // 3. 动作选择 edit
			{ input: "proc/k10" }, // 4. model 值步
			{ select: "not set" }, // 5. thinking 值步 → null
			{ select: "this process" }, // 6. 写入目标 this process
			{ select: undefined }, // 7. 父字段选择 ESC → 回 agent picker
			{ select: undefined }, // 8. picker ESC → 完全退出
		]);
		const ctx = { hasUI: true, mode: "tui", cwd: workspaceDir, ui };

		// Act
		await command.handler("", ctx);

		// Assert: 无覆盖时选项行尾无 (process) 标记；进程级写入后回 picker，coder
		// 选项行尾出现 (process) 标记（writer 无覆盖 → 不出现）
		expect(mismatches).toEqual([]);
		expect(leftover).toEqual([]);
		const pickerOption = (options: string[] | undefined, name: string) => (options ?? []).find((o) => new RegExp(`\\b${name}\\b`).test(o));
		const coder0 = pickerOption(calls[0]?.options, "coder");
		const writer0 = pickerOption(calls[0]?.options, "writer");
		expect(coder0, "首次 picker 应含 coder 选项").toBeDefined();
		expect(writer0, "首次 picker 应含 writer 选项").toBeDefined();
		expect(coder0!, "无进程覆盖时 coder 选项行尾不得有 (process) 标记").not.toMatch(/\(process\)\s*$/);
		expect(coder0!, "无进程覆盖时 coder 选项不得含 saved 片段").not.toContain("[saved:");
		expect(writer0!, "无进程覆盖时 writer 选项行尾不得有 (process) 标记").not.toMatch(/\(process\)\s*$/);
		expect(writer0!, "无进程覆盖时 writer 选项不得含 saved 片段").not.toContain("[saved:");
		expect(calls[7].kind, "父字段选择 ESC 后应回 agent picker").toBe("select");
		const coder7 = pickerOption(calls[7]?.options, "coder");
		const writer7 = pickerOption(calls[7]?.options, "writer");
		expect(coder7, "第二次 picker 应含 coder 选项").toBeDefined();
		expect(writer7, "第二次 picker 应含 writer 选项").toBeDefined();
		expect(coder7!, "进程级写入后 coder 选项应保留 (process) 标记").toMatch(/\(process\)/i);
		// saved 新语义：单字段（仅 model）进程覆盖也显示 saved，且追加在
		// (process) 之后——选项行尾不再是裸 (process)。
		expect(coder7!, "进程级写入后 coder 选项行尾应追加 saved 片段").toMatch(/\(process\)\s*\[saved:/i);
		expect(coder7!, "coder 选项标注应刷新为内存层新值").toContain("proc/k10");
		expect(writer7!, "无进程覆盖的 writer 选项行尾不得有 (process) 标记").not.toMatch(/\(process\)\s*$/);
		expect(writer7!, "无进程覆盖的 writer 选项不得含 saved 片段").not.toContain("[saved:");
		expect((mod as any).getProcessOverrides()).toEqual({ coder: { model: "proc/k10" } });
		expect(fs.existsSync(userFile)).toBe(false);
		expect(fs.existsSync(workspaceFile)).toBe(false);
	});

	it("K11 should report both model and thinking fallback values when clearing a process-layer entry (clear 合并反馈：双字段回退)", async () => {
		// Arrange: frontmatter model+thinking 都有值；进程层覆盖两者
		writeProjectAgent("coder", "model: fm/coder-m\nthinking: low");
		(mod as any).setProcessOverride("coder", { model: "proc/m", thinking: "high" });
		const { agents } = discoverAgents(workspaceDir, "both");
		const { ui, mismatches, leftover, notifyMock } = createScriptedUi([
			{ select: "model & thinking" }, // 1. 父字段选择（合并项）→ 子流程
			{ select: "clear model & thinking" }, // 2. 动作选择 clear（整条清除，无值步）
			{ select: "this process" }, // 3. 写入目标 this process
			{ select: undefined }, // 4. 父字段选择 ESC → 完全退出
		]);

		// Act
		await runConfigFlow({ ui, cwd: workspaceDir, agents, agentName: "coder" });

		// Assert: 进程 entry 整条消失；clear 反馈含 model 与 thinking 各自回退值
		expect(mismatches).toEqual([]);
		expect(leftover).toEqual([]);
		expect((mod as any).getProcessOverrides(), "clear 后进程 entry 应整条消失").toEqual({});
		expect(fs.existsSync(userFile), "clear this process 不得写 user 级文件").toBe(false);
		expect(fs.existsSync(workspaceFile), "clear this process 不得写 project 级文件").toBe(false);
		const clearNotify = notifyMock.mock.calls.map((args) => String(args[0])).find((s) => /cleared/i.test(s)) ?? "";
		expect(clearNotify, "clear 反馈应说明回退到 frontmatter").toMatch(/\bfrontmatter\b/i);
		expect(clearNotify, "clear 反馈应含 model 回退值（frontmatter fm/coder-m）").toContain("fm/coder-m");
		expect(clearNotify, "clear 反馈应含 thinking 回退值（frontmatter low）").toContain("low");
		expect(clearNotify, "clear 反馈不得宣称被清除的内存层 model").not.toContain("proc/m");
		expect(clearNotify, "clear 反馈不得宣称被清除的内存层 thinking").not.toContain("high");
	});
});

// ===========================================================================
// S. saved（"配置文件里的原值"）片段：进程级覆盖时显示低层生效值（红阶段契约）
// ===========================================================================
// 语义（设计已定稿）：agent 有进程级（this process）覆盖时，在其菜单标注末尾
// 追加 `[saved: <model> (<modelSource>) / <thinking> (<thinkingSource>)]`
// 片段，展示"配置文件里的原值"——排除进程层后的 project > user > frontmatter
// 链（即 computeEffectiveModelConfigs(agents, user, project) 不传进程层参数
// 的结果）。无进程覆盖 → 不显示 saved。槽位无值 → `not set`（无来源标注）。
// 位置：picker 总览行尾（... (process) [saved: ...]）、字段选择 model &
// thinking 合并项标注末尾、子流程动作选择 edit model & thinking 选项标注末尾。
// saved 是追加文本：选项经 indexOf/子串映射回 agent 本体，不进入写入值。
describe("S. saved 原值片段：进程覆盖时显示低层生效值（红阶段契约）", () => {
	beforeEach(() => {
		// 测试间隔离：清空模块级内存覆盖层（S7 写/清 this process 的密闭性）。
		(mod as any).resetProcessOverridesForTests?.();
	});

	afterEach(() => {
		// 密闭：不留覆盖给同文件后续 describe（测试卫生）。
		(mod as any).resetProcessOverridesForTests?.();
	});

	/** optionOf 辅助：按字段 key 词边界定位选项（与 E/K 组同款风格）。 */
	function optionOf(options: string[] | undefined, field: string): string | undefined {
		return (options ?? []).find((o) => new RegExp(`\\b${field}\\b`, "i").test(o));
	}

	/** 从选项提取 [saved: ...] 片段内容（未实现时返回 undefined → 断言红）。 */
	function savedFragmentOf(option: string | undefined): string | undefined {
		return option?.match(/\[saved:([^\]]*)\]/)?.[1];
	}

	/** setupExtension：命令注册捕获（与 H/B8/K 组同款，S 组内局部定义）。 */
	function setupExtension() {
		const pi = createMockPi();
		(mod.default as any)(pi);
		return { pi, command: pi._commandDefs.get("subagent-config") };
	}

	it("S1 should show the saved fragment with the user-level low value for process-overridden agents in the picker, and none for override-free agents (picker 总览行尾)", async () => {
		// Arrange: coder 的 user 级 json 配 model+thinking（低层值）+ 进程级覆盖；
		// writer 无任何覆盖（控制组：无进程覆盖 → 不显示 saved）
		writeProjectAgent("coder");
		writeProjectAgent("writer");
		fs.writeFileSync(userFile, JSON.stringify({ coder: { model: "user/saved-m", thinking: "low" } }), "utf-8");
		(mod as any).setProcessOverride("coder", { model: "proc/m", thinking: "high" });
		const { command } = setupExtension();
		const { ui, calls, mismatches, leftover } = createScriptedUi([{ select: undefined }]); // picker ESC → 退出
		const ctx = { hasUI: true, mode: "tui", cwd: workspaceDir, ui };

		// Act
		await command.handler("", ctx);

		// Assert: coder 选项行尾 (process) 后紧跟 [saved:，含低层 user 值 + 来源；
		// writer（无进程覆盖）不得含 [saved:
		expect(mismatches).toEqual([]);
		expect(leftover).toEqual([]);
		const options = calls[0]?.options ?? [];
		const coderOption = options.find((o) => /\bcoder\b/.test(o));
		const writerOption = options.find((o) => /\bwriter\b/.test(o));
		expect(coderOption, "picker 缺 coder 选项").toBeDefined();
		expect(writerOption, "picker 缺 writer 选项").toBeDefined();
		expect(coderOption!, "进程覆盖 agent 的选项应含 saved 片段").toContain("[saved:");
		expect(coderOption!, "saved 片段应紧跟 (process) 标记之后（picker 行尾位置）").toMatch(/\(process\)\s*\[saved:/i);
		const saved = savedFragmentOf(coderOption);
		expect(saved, "saved 片段内容应存在").toBeDefined();
		expect(saved!, "saved 片段应含低层 model 值 + user 来源").toMatch(/user\/saved-m\s*\(\s*user\s*\)/i);
		expect(saved!, "saved 片段应含低层 thinking 值 + user 来源").toMatch(/low\s*\(\s*user\s*\)/i);
		expect(saved!, "saved 片段不得含进程层遮蔽 model").not.toContain("proc/m");
		expect(saved!, "saved 片段不得含进程层遮蔽 thinking").not.toContain("high");
		expect(writerOption!, "无进程覆盖的 agent 选项不得含 saved 片段").not.toContain("[saved:");
	});

	it("S2 should append a saved fragment to the model & thinking field option annotation", async () => {
		// Arrange: user 级 json model+thinking 为低层值；进程级覆盖遮蔽
		writeProjectAgent("coder");
		fs.writeFileSync(userFile, JSON.stringify({ coder: { model: "user/saved-m", thinking: "low" } }), "utf-8");
		(mod as any).setProcessOverride("coder", { model: "proc/m", thinking: "high" });
		const { agents } = discoverAgents(workspaceDir, "both");
		const { ui, calls, mismatches, leftover } = createScriptedUi([
			{ select: undefined }, // 字段选择 ESC → 完全退出（agentName 预选）
		]);

		// Act
		await runConfigFlow({ ui, cwd: workspaceDir, agents, agentName: "coder" });

		// Assert: 字段选择 model & thinking 合并项标注含 saved 片段（低层 user 值）
		expect(mismatches).toEqual([]);
		expect(leftover).toEqual([]);
		const modelOption = optionOf(calls[0]?.options, "model");
		expect(modelOption, "字段选择应存在 model & thinking 合并项").toBeDefined();
		expect(modelOption!, "合并项标注应含 saved 片段").toContain("[saved:");
		const saved = savedFragmentOf(modelOption);
		expect(saved, "saved 片段内容应存在").toBeDefined();
		expect(saved!, "saved 片段应为低层 user model 值 + user 来源").toMatch(/user\/saved-m\s*\(\s*user\s*\)/i);
		expect(saved!, "saved 片段应含低层 thinking 值").toContain("low");
	});

	it("S3 should append a saved fragment to the edit model & thinking action option", async () => {
		// Arrange: user 级 json model+thinking 为低层值；进程级覆盖遮蔽
		writeProjectAgent("coder");
		fs.writeFileSync(userFile, JSON.stringify({ coder: { model: "user/saved-m", thinking: "low" } }), "utf-8");
		(mod as any).setProcessOverride("coder", { model: "proc/m", thinking: "high" });
		const { agents } = discoverAgents(workspaceDir, "both");
		const { ui, calls, mismatches, leftover } = createScriptedUi([
			{ select: "model & thinking" }, // 1. 字段选择（合并项）→ 子流程
			{ select: undefined }, // 2. 动作选择 ESC → 回父字段选择
			{ select: undefined }, // 3. 字段选择 ESC → 完全退出
		]);

		// Act
		await runConfigFlow({ ui, cwd: workspaceDir, agents, agentName: "coder" });

		// Assert: 动作选择层 edit model & thinking 选项标注含 saved 片段（低层 user 值）
		expect(mismatches).toEqual([]);
		expect(leftover).toEqual([]);
		const actionCall = calls.find((c) => c.kind === "select" && (c.options ?? []).some((o) => /edit/i.test(o)));
		expect(actionCall, "应到达子流程动作选择层").toBeDefined();
		const editOption = (actionCall!.options ?? []).find((o) => /edit/i.test(o) && /\bmodel\b/i.test(o) && /\bthinking\b/i.test(o));
		expect(editOption, "动作选择应含 edit model & thinking 项").toBeDefined();
		expect(editOption!, "edit model & thinking 标注应含 saved 片段").toContain("[saved:");
		const saved = savedFragmentOf(editOption);
		expect(saved, "saved 片段内容应存在").toBeDefined();
		expect(saved!, "saved 片段应为低层 user model 值 + user 来源").toMatch(/user\/saved-m\s*\(\s*user\s*\)/i);
	});

	it("S4 should render both saved slots as not set when there is no low-level value (json 与 frontmatter 都无)", async () => {
		// Arrange: coder 只有进程级覆盖；user/project json 与 frontmatter 均无 model/thinking
		writeProjectAgent("coder");
		(mod as any).setProcessOverride("coder", { model: "proc/m", thinking: "high" });
		const { agents } = discoverAgents(workspaceDir, "both");
		const { ui, calls, mismatches, leftover } = createScriptedUi([
			{ select: undefined }, // 字段选择 ESC → 完全退出（agentName 预选）
		]);

		// Act
		await runConfigFlow({ ui, cwd: workspaceDir, agents, agentName: "coder" });

		// Assert: 字段选择合并项含 saved 片段，且双槽位均为 not set（无来源标注）
		expect(mismatches).toEqual([]);
		expect(leftover).toEqual([]);
		const modelOption = optionOf(calls[0]?.options, "model");
		expect(modelOption, "字段选择应存在 model & thinking 合并项").toBeDefined();
		const saved = savedFragmentOf(modelOption);
		expect(saved, "有进程覆盖时 saved 片段应存在（低层无值也显示）").toBeDefined();
		expect(saved!, "低层无值时双槽位应显示 not set 占位符（无来源标注）").toMatch(
			new RegExp(`^\\s*${UNCONFIGURED_PLACEHOLDER}\\s*/\\s*${UNCONFIGURED_PLACEHOLDER}\\s*$`, "i"),
		);
		expect(saved!, "not set 槽位不得带来源标注").not.toMatch(/\((user|project|frontmatter)\)/i);
	});

	it("S5 should show the (frontmatter) source when the low-level value comes from the agent file itself", async () => {
		// Arrange: user/project json 无 coder；frontmatter 配 model+thinking；进程覆盖遮蔽
		writeProjectAgent("coder", "model: fm/coder-m\nthinking: low");
		(mod as any).setProcessOverride("coder", { model: "proc/m", thinking: "high" });
		const { agents } = discoverAgents(workspaceDir, "both");
		const { ui, calls, mismatches, leftover } = createScriptedUi([
			{ select: undefined }, // 字段选择 ESC → 完全退出（agentName 预选）
		]);

		// Act
		await runConfigFlow({ ui, cwd: workspaceDir, agents, agentName: "coder" });

		// Assert: saved 片段含 frontmatter model/thinking 值及 (frontmatter) 来源
		expect(mismatches).toEqual([]);
		expect(leftover).toEqual([]);
		const modelOption = optionOf(calls[0]?.options, "model");
		expect(modelOption, "字段选择应存在 model & thinking 合并项").toBeDefined();
		const saved = savedFragmentOf(modelOption);
		expect(saved, "saved 片段应存在").toBeDefined();
		expect(saved!, "saved 片段应显示 frontmatter model 值 + (frontmatter) 来源").toMatch(/fm\/coder-m\s*\(\s*frontmatter\s*\)/i);
		expect(saved!, "saved 片段应显示 frontmatter thinking 值 + (frontmatter) 来源").toMatch(/low\s*\(\s*frontmatter\s*\)/i);
	});

	it("S6 should map an option carrying a saved fragment back to the correct agent (saved 是追加文本，不进入写入值)", async () => {
		// Arrange: coder 有 user 低层值 + 进程覆盖（选项带 saved 片段）；writer 无覆盖
		writeProjectAgent("coder");
		writeProjectAgent("writer");
		fs.writeFileSync(userFile, JSON.stringify({ coder: { model: "user/saved-m", thinking: "low" } }), "utf-8");
		(mod as any).setProcessOverride("coder", { model: "proc/m", thinking: "high" });
		const { command } = setupExtension();
		const { ui, calls, mismatches, leftover } = createScriptedUi([
			{ select: "coder" }, // 子串命中带 saved 片段的标注选项
			{ select: "description" },
			{ input: "Picked via saved-annotated option" },
			{ select: undefined }, // 写回成功 → 回字段选择；字段选择 ESC → 回 agent 选择
			{ select: undefined }, // agent 选择 ESC → 完全退出
		]);
		const ctx = { hasUI: true, mode: "tui", cwd: workspaceDir, ui };

		// Act
		await command.handler("", ctx);

		// Assert: picker 选项确已带 saved 片段（feature 前置钉死）；标注选项经
		// indexOf 映射回 coder 本体；写入值 = 输入值（saved 不进入写入）
		expect(calls[0]?.options?.some((o) => /\[saved:/.test(o)), "picker 选项应带 saved 片段").toBe(true);
		expect(mismatches).toEqual([]);
		expect(leftover).toEqual([]);
		const coderFile = path.join(agentsDir, "coder.md");
		expect(readAgent(coderFile).name, "标注选项应映射回 coder 本体").toBe("coder");
		expect(readAgent(coderFile).description, "写入值必须为输入值，不得混入 saved 片段文本").toBe("Picked via saved-annotated option");
	});

	it("S7 should show the saved fragment after a process-layer write and hide it after clearing, within the same command session (同一会话内刷新)", async () => {
		// Arrange: user 级低层 model+thinking；agentName 预选跳过 picker
		writeProjectAgent("coder");
		fs.writeFileSync(userFile, JSON.stringify({ coder: { model: "user/saved-m", thinking: "low" } }), "utf-8");
		const userBefore = fs.readFileSync(userFile, "utf-8");
		const { agents } = discoverAgents(workspaceDir, "both");
		const { ui, calls, mismatches, leftover } = createScriptedUi([
			{ select: "model & thinking" }, // calls[0] 字段选择（尚未写进程覆盖 → 无 saved）
			{ select: "edit model & thinking" }, // calls[1] 动作选择 edit
			{ input: "proc/m" }, // calls[2] model 值步
			{ select: "low" }, // calls[3] thinking 值步：预选低层 current（low）并确认
			{ select: "this process" }, // calls[4] 写入目标 this process → 写回成功 → 回字段选择
			{ select: "model & thinking" }, // calls[5] 字段选择（进程覆盖已存在 → 应含 saved）→ 子流程
			{ select: "clear model & thinking" }, // calls[6] 动作选择 clear（整条清除，无值步）
			{ select: "this process" }, // calls[7] 写入目标 this process → 清除 → 回字段选择
			{ select: undefined }, // calls[8] 字段选择 ESC → 完全退出
		]);

		// Act
		await runConfigFlow({ ui, cwd: workspaceDir, agents, agentName: "coder" });

		// Assert: 写进程前无 saved；写入后 saved 出现（低层 user 值）；clear 后 saved 消失
		expect(mismatches).toEqual([]);
		expect(leftover).toEqual([]);
		const beforeOption = optionOf(calls[0]?.options, "model");
		expect(beforeOption, "首次字段选择应存在 model & thinking 合并项").toBeDefined();
		expect(beforeOption!, "写进程前（无进程覆盖）不得含 saved 片段").not.toContain("[saved:");
		const afterWriteOption = optionOf(calls[5]?.options, "model");
		expect(afterWriteOption, "写回后字段选择应存在 model & thinking 合并项").toBeDefined();
		expect(afterWriteOption!, "进程覆盖写入后字段选择应出现 saved 片段").toContain("[saved:");
		const saved = savedFragmentOf(afterWriteOption);
		expect(saved, "写回后 saved 片段应存在").toBeDefined();
		expect(saved!, "saved 片段应显示低层 user model 值 + user 来源").toMatch(/user\/saved-m\s*\(\s*user\s*\)/i);
		const afterClearOption = optionOf(calls[8]?.options, "model");
		expect(afterClearOption, "clear 后字段选择应存在 model & thinking 合并项").toBeDefined();
		expect(afterClearOption!, "clear 进程覆盖后 saved 片段应消失").not.toContain("[saved:");
		expect((mod as any).getProcessOverrides(), "clear 后进程 entry 应整条消失").toEqual({});
		expect(fs.readFileSync(userFile, "utf-8"), "写/清 this process 不得改动 user 级文件").toBe(userBefore);
	});

	it("S8 should show the saved fragment for a single-field (model-only) process override — any process override, not just complete ones (用户需求：单字段进程覆盖也显示原值)", async () => {
		// Arrange: user 级 json 低层 model+thinking；进程层只覆盖 model（单字段）
		writeProjectAgent("coder");
		fs.writeFileSync(userFile, JSON.stringify({ coder: { model: "user/saved-m", thinking: "low" } }), "utf-8");
		(mod as any).setProcessOverride("coder", { model: "proc/m" });
		const { agents } = discoverAgents(workspaceDir, "both");
		const { ui, calls, mismatches, leftover } = createScriptedUi([
			{ select: undefined }, // 字段选择 ESC → 完全退出（agentName 预选）
		]);

		// Act
		await runConfigFlow({ ui, cwd: workspaceDir, agents, agentName: "coder" });

		// Assert: 单字段（仅 model）进程覆盖也显示 saved；低层 model/thinking 与
		// user 来源出现在 saved 片段内
		expect(mismatches).toEqual([]);
		expect(leftover).toEqual([]);
		const modelOption = optionOf(calls[0]?.options, "model");
		expect(modelOption, "字段选择应存在 model & thinking 合并项").toBeDefined();
		expect(modelOption!, "单字段进程覆盖也应显示 saved 片段").toContain("[saved:");
		const saved = savedFragmentOf(modelOption);
		expect(saved, "saved 片段应存在").toBeDefined();
		expect(saved!, "saved 片段应显示低层 user model 值 + user 来源").toMatch(/user\/saved-m\s*\(\s*user\s*\)/i);
		expect(saved!, "saved 片段应显示低层 thinking 值").toContain("low");
	});
});
