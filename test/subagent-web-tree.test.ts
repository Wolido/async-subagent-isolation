/**
 * 红阶段测试：`src/web/tree.ts` —— 本地 web 视图追踪 subagent 会话树的模块
 * （纯函数 buildSessionTree）。
 *
 * 被测接口（固定签名）：
 *   buildSessionTreeResult(deps: BuildTreeDeps): BuildTreeResult
 *     —— { nodes: SessionTreeNode[]; truncated: TruncationInfo }
 *   buildSessionTree(deps: BuildTreeDeps): SessionTreeNode[]
 *     —— 旧签名保留，返回 buildSessionTreeResult(deps).nodes
 *   buildSubtree(deps: SubtreeDeps): SessionTreeNode[]
 *     —— 显式展开某节点的直属子节点（depth 以 1 为基准，孙为 2…）
 *   resetSubtreeCacheForTests(): void —— 清 expand 子树缓存（LRU）
 *   deps = { mainSessionFile, registry, rootDir, now?, completedTasks? }
 *   SubtreeDeps = { rootDir, registry, completedTasks?, now?, sessionDir, sessionFile }
 *   completedTasks?: ReadonlyMap<string, { status?: string; finishedAt: number }>
 *     —— 同进程 depth 1 子任务的完成记录（只读注入，优先于 mtime 判 finished）
 *
 * 第 7 轮新契约（本文件用例逐条编码）：
 *   A. 预算分层 + 截断保留最新：MAX_ROOT_NODES=1000（顶层/depth 0）、
 *      MAX_CHILD_NODES=200（每个节点的子列表）、MAX_DEPTH=6 保留；旧的全局
 *      MAX_NODES=200 语义删除。顶层名额与子列表名额互不占用；单层超预算时
 *      丢 startedAt 最旧的、保留最新 N 个，返回顺序仍按 startedAt 升序。
 *      TruncationInfo 描述顶层列表：total=发现的顶层派发条目总数、
 *      showing=返回的顶层节点数、dropped=total-showing（未截断时 total===showing、
 *      dropped===0，但字段始终存在）。
 *   B. 惰性子树扫描：顶层永远即时构建；running/recent 节点即时扫描子节点；
 *      finished（以及 failed）节点默认不扫（children: []），改填必填字段
 *      childCount（该节点会话目录 children.jsonl 的指针条数，无目录/文件为 0）与
 *      childSummary（指针数 0 → ""；否则 "3 children · all finished" /
 *      "1 child · all finished"）；已扫描节点 childCount = children.length、
 *      childSummary 用 src/web/tree-view.ts 的 childSummary(children) 真值函数。
 *      孤儿保护：节点自身会话异常收尾（callOrder 非空且最后一个 subagent
 *      toolCall 无对应 toolResult）时，即使 finished 也强制扫描其子节点。
 *   C. 任务文本截断：TASK_TEXT_MAX=200，所有 node.task 截断到前 200 字符，
 *      被截断时附 taskTruncated: true（未截断时缺省），短文本逐字保留。
 *
 * 真实数据形状（fixture 照此造）：
 *   - subagent 会话根目录下每个任务一个目录：<rootDir>/<taskId>/<ISO>_<taskId>.jsonl；
 *     孙会话与父同级同根（rootDir 下平铺）。
 *   - JSONL 每行一个 entry：{"type":"session",...} 头；{"type":"message",...,
 *     "message":{"role":"user"|"assistant"|"toolResult",...}}。
 *   - 父会话里派发记录：assistant 消息含 toolCall { name:"subagent", arguments:{agent,task,action:"dispatch" } }，
 *     随后 toolResult 消息（toolName:"subagent"）携带收据文本。
 *   - 派发时写 sidecar 指针文件：<sessionDir>/children.jsonl，每行一个
 *     { childTaskId, agent, task, startedAt, depth }（best-effort，由 src/index.ts
 *     的派发路径写入）。
 *
 * 三种父→子链接来源（旧的「内容匹配」机制已整体删除）：
 *   1) receipt：toolResult 里的异步收据 "Dispatched <agent>. taskId: <childId>"
 *      或同步后缀 "[subagent session: <childId>]"；
 *   2) pointer：子会话目录（sessionFile 所在目录）下的 children.jsonl 每条指针
 *      建一个节点（taskId=childTaskId，agent/task 取自指针，linkSource="pointer"）。
 *      主会话（depth 0）不读 children.jsonl；
 *   3) unknown：某次派发（toolCall）既无 receipt、也无匹配指针 → 仍建节点，
 *      taskId 为空字符串 ""，agent/task 取自 toolCall 参数，linkSource="unknown"。
 *      指针覆盖判定：无 receipt 的 toolCall 若与某个指针的 agent/task 都相同，
 *      视为已被指针覆盖，不再为它建 unknown 节点。
 * 去重：已知 childId（receipt/pointer）加入全局 seen；unknown 节点的空 taskId
 * 不加入 seen。receipt 节点与 pointer 节点都经 statSync("<rootDir>/<childId>")
 * 定位子目录、取目录内最新 .jsonl 继续递归；unknown 节点无子节点。
 * 硬约束：树构建任何情况下不得以 rootDir 为参数调用 fs.readdirSync（只允许
 * 对单个子任务目录 readdir）。
 *
 * read()/status 语义逐条编码成用例（编号对应验收清单）：
 *   1. 异步收据 → 根节点，taskId/agent/task/linkSource:"receipt"
 *   1b. 异步收据的 agent 名可含空格（"Dispatched ops legion. taskId: <id>"
 *       也要解析出 agent="ops legion"，不得降级为 unknown）
 *   2. 同步后缀 → 同样建节点，linkSource:"receipt"
 *   3. 在飞子任务通过指针建链 → linkSource:"pointer"，无 unknown 冗余节点
 *   3b. 指针覆盖判定对 task 首尾空白容忍：toolCall 的 arguments.task 原文与指针
 *       task（派发时已 trim）仅差首尾空白 → 视为已被覆盖，不多出 unknown 节点
 *   4. 无 receipt 无指针 → unknown 降级，taskId === ""；该场景同样不扫 rootDir
 *   4b. unknown 节点 status 为 "pending"（等待收据的独立状态），finishedAt 为 undefined
 *   5. 收据落盘后再次 build：指针节点不重复、linkSource 升级为 "receipt"
 *   6. 递归：孙节点 depth 递增（0/1/2）
 *   7. depth 上限 6；节点预算改为分层（顶层 1000 / 每节点子列表 200），
 *      单层超预算截断保留 startedAt 最新的 N 个
 *   8. 诱饵目录（隐藏/非 UUID/无 .jsonl）不产生节点
 *   9. status 优先级（9b 详测 + 新增「指针链接的状态判定」「状态判定回归」详测）：
 *      1) registry 该 childId status==="running" → "running"；
 *      2) 指针链接（children.jsonl 存在该 childId 的指针）且没有晚于该指针
 *         startedAt 的同步收据 ⇒ "running"（指针节点 startedAt 取最新指针行的
 *         startedAt，不得用子会话 headerTs 顶替；陈旧同步收据不得判 finished）；
 *         兜底：无晚于指针的同步收据、且子会话 lastEntryTs 存在且
 *         now − lastEntryTs > 10 分钟（600_000ms）→ 降级 "recent"
 *         （避免真出错时永远挂 running）；子会话无 lastEntryTs 时仍 "running"；
 *      3) 同步收据（且晚于指针 startedAt，或无指针）→ "finished"，
 *         finishedAt = 该收据 toolResult 行的 ts；
 *      4) completedTasks 记录 → "finished"，finishedAt = 记录值；
 *      5) 子会话 lastEntryTs 在 now−10_000 内 → "recent"；
 *      6) 否则 → "finished"，finishedAt = lastEntryTs ?? startedAt 兜底。
 *      状态判定**不再读文件 mtime**（DirInfo 的 fileMtime 仅用于挑选最新 .jsonl
 *      与 startedAt 兜底）；异步收据落盘于派发瞬间，本身不代表结束；
 *      RECENT_WINDOW_MS 兜底窗口 30s → 10s。
 *   9r. 错误结果分类（rejected / failed，最新事件胜，详测见「错误结果分类」）：
 *      依据该 toolCall 对应的最新一条 toolResult（按 ts）；isError 且文案匹配
 *      派发被拒 → "rejected"（reason + errorText）；isError 且带子任务 id
 *      （[subagent session: <uuid>] 或诊断含 Exit code:）→ "failed"
 *      （errorText = 完整原文）；error 结果绝不被当成成功同步收据；
 *      finishedAt = 错误 toolResult 行的 ts（errorTs，耗时不随 Date.now()
 *      累积；见本轮 B 契约）；无结果、无错误 → "pending"（unknown）；
 *      同一 id 多次运行只有一个节点。
 *   9f. failed 无 id 防御：isError 结果诊断含 Exit code: 但无 [subagent session: <id>]
 *       后缀、无收据 → 该派发**不产出任何节点**（尤其不得产出 taskId:"" 的 failed
 *       节点）；同一 fixture 里 rejected 无 id 仍产出 taskId:"" rejected 节点、
 *       failed 带 id 仍产出保留 id 的 failed 节点（新防御只影响「failed 且无 id」）。
 *   9d. C 节硬约束：除主会话直接派发层（node.depth === 0）以外的节点，若只有
 *       异步收据（无同步收据、无 children.jsonl 指针，如指针功能上线前的旧派发），
 *       不得被「子会话 lastEntryTs 的 10s 兜底窗口/兜底 finished」判 finished，
 *       必须 "pending"；depth 0（主会话直接派发）保持原 finished 行为；
 *       completedTasks 记录与 10s recent 窗口的优先级不变（见「深链旧派发的
 *       状态判定」详测。注意本仓库 node.depth：主会话直接派发的节点 depth === 0，
 *       孙辈 === 1，即验收清单里的「depth ≥ 2」对应 node.depth ≥ 1）。
 *  10. 会话目录多 .jsonl 取最新（receipt 场景，以 startedAt 锁定）；无法解析的
 *      目录不致命；sidecar children.jsonl 不得被当作会话文件（其 mtime 更新时
 *      仍须选中真正的会话 .jsonl，否则丢失该目录的收据链接）
 *  11. 同一 childId 去重：双收据 / receipt+pointer / 完全重复收据 → 各只 1 节点
 *  12. 跨 build 解析缓存一致性（未变 fixture 两次一致、追加后可见）
 *  13. receipt 场景与含 pointer 的在飞场景：readdirSync 从未以 rootDir 为参数
 *
 * 独立审查缺口（第 7 轮后补，先修测试契约再修实现）：
 *   契约 5（新语义钉住，预期绿）. recent 兑底窗口为闭区间 [now−10_000, now]：
 *      未来 lastEntryTs（时钟偏移）不判 recent → 兑底 finished；下界恰
 *      NOW−10_000 仍 recent，NOW−10_001 出窗 → finished（见「recent 上界」组）。
 *   契约 6（配套修复，跨桶用例预期红）. buildSubtree 缓存键需并入 now 的
 *      粗粒度桶（如 5s/10s）：同桶内重复展开仍命中不重扫；纯时间推进跨桶后
 *      必须重新扫描，使指针降级（running→recent）等时间驱动判定生效
 *      （见「buildSubtree」组尾两例）。
 *
 * 约定（沿仓库惯例，同 test/subagent-web-tail.test.ts）：globals:false 显式
 * import from "vitest"；fixture 用 fs.mkdtempSync(os.tmpdir()) + afterEach 递归
 * 删除；注入固定 now，文件/目录 mtime 全部显式设定，测试确定性不依赖真实时钟。
 */

import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { buildSessionTree, buildSessionTreeResult, buildSubtree, resetSubtreeCacheForTests } from "../src/web/tree.ts";
import type { BuildTreeDeps, SessionTreeNode } from "../src/web/tree.ts";
// 仅类型引用：children.ts 模块运行时由实现者新建，type-only import 在转译期被
// 剥离，不会导致本文件在红阶段整体 import 失败。
import type { ChildPointer } from "../src/web/children.ts";

// readdirSync 观测：`vi.spyOn(fs, "readdirSync")` 对 ESM 模块命名空间不可行
// （属性不可配置，vitest 直接报 "Module namespace is not configurable in ESM"），
// 故用 vi.mock 把 node:fs 的 readdirSync 换成 vi.fn 包裹原实现的 spy；测试里用
// vi.mocked(fs.readdirSync) 取同一 spy，mockClear() 的语义与 spyOn(...).mockClear()
// 等价，且 tree.ts 与本文件共享同一模块实例。断言前 mockClear()、断言后不 restore，
// 保持 spy 实现始终为真实 readdirSync。
vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs")>();
	return { ...actual, readdirSync: vi.fn(actual.readdirSync) };
});

/** 注入的「现在」：固定 epoch，所有断言相对它计算。 */
const NOW = 1_800_000_000_000;

/** uuid 形状的固定 taskId 生成器（version 4 形状，逐个确定）。 */
function uuid(n: number): string {
	return `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
}

function iso(ms: number): string {
	return new Date(ms).toISOString();
}

// ---------------------------------------------------------------------------
// JSONL 行构造器（形状照真实数据）
// ---------------------------------------------------------------------------

function sessionHeaderLine(sessionId: string, ts: number): string {
	return JSON.stringify({ type: "session", sessionId, timestamp: iso(ts) });
}

/** 父会话里一条 assistant 消息，含 subagent toolCall。 */
function toolCallLine(callId: string, agent: string, task: string, ts: number): string {
	return JSON.stringify({
		type: "message",
		id: `msg-call-${callId}`,
		parentId: "msg-main-root",
		timestamp: iso(ts),
		message: {
			role: "assistant",
			content: [{ type: "toolCall", id: callId, name: "subagent", arguments: { agent, task, action: "dispatch" } }],
		},
	});
}

/** 父会话里一条 toolResult 消息，text 为收据文本（异步一行式或同步后缀式）。 */
function receiptLine(callId: string, text: string, ts: number): string {
	return JSON.stringify({
		type: "message",
		id: `msg-receipt-${callId}`,
		parentId: `msg-call-${callId}`,
		timestamp: iso(ts),
		message: {
			role: "toolResult",
			toolCallId: callId,
			toolName: "subagent",
			content: [{ type: "text", text }],
			isError: false,
		},
	});
}

/** 父会话里一条 isError === true 的 toolResult（派发被拒 / 运行失败的错误结果）。 */
function errorResultLine(callId: string, text: string, ts: number): string {
	return JSON.stringify({
		type: "message",
		id: `msg-err-${callId}`,
		parentId: `msg-call-${callId}`,
		timestamp: iso(ts),
		message: {
			role: "toolResult",
			toolCallId: callId,
			toolName: "subagent",
			content: [{ type: "text", text }],
			isError: true,
		},
	});
}

/** 子会话 JSONL 行：session 头 + 首条 user（"Task: <task>"）+ assistant 文本 + 可选附加行。 */
function childSessionLines(taskId: string, task: string, ts: number, extraLines: string[] = []): string[] {
	return [
		sessionHeaderLine(taskId, ts),
		JSON.stringify({
			type: "message",
			id: `msg-user-${taskId}`,
			parentId: `session-${taskId}`,
			timestamp: iso(ts),
			message: { role: "user", content: [{ type: "text", text: `Task: ${task}` }] },
		}),
		JSON.stringify({
			type: "message",
			id: `msg-asst-${taskId}`,
			parentId: `msg-user-${taskId}`,
			timestamp: iso(ts),
			message: { role: "assistant", content: [{ type: "text", text: "working on it" }] },
		}),
		...extraLines,
	];
}

// ---------------------------------------------------------------------------
// fixture 落盘
// ---------------------------------------------------------------------------

let rootDir: string; // subagent-sessions 根（临时目录）
let mainFile: string; // 主会话 JSONL

beforeEach(() => {
	rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "subagent-web-tree-"));
	mainFile = path.join(rootDir, "main-session.jsonl");
});

afterEach(() => {
	fs.rmSync(rootDir, { recursive: true, force: true });
});

/** 写主会话 JSONL（覆盖写）。 */
function writeMain(lines: string[]): void {
	fs.writeFileSync(mainFile, lines.join("\n") + "\n", "utf-8");
}

/** 追加主会话 JSONL（模拟收据随后落盘）。 */
function appendMain(lines: string[]): void {
	fs.appendFileSync(mainFile, lines.join("\n") + "\n", "utf-8");
}

/**
 * 写子会话：<rootDir>/<taskId>/<ISO>_<taskId>.jsonl，条目 ts 与文件/目录 mtime
 * 同值（状态判定只依据条目时间戳 lastEntryTs；mtime 仅用于挑选最新 .jsonl）。
 */
function writeChildSession(taskId: string, task: string, mtimeMs: number, extraLines: string[] = []): string {
	const dir = path.join(rootDir, taskId);
	fs.mkdirSync(dir, { recursive: true });
	const filePath = path.join(dir, `${iso(mtimeMs)}_${taskId}.jsonl`);
	fs.writeFileSync(filePath, childSessionLines(taskId, task, mtimeMs, extraLines).join("\n") + "\n", "utf-8");
	const d = new Date(mtimeMs);
	fs.utimesSync(filePath, d, d);
	fs.utimesSync(dir, d, d);

	return filePath;
}

/**
 * 写子会话并显式分离「条目时间戳 entryTs」与「文件 mtime fileMtimeMs」：
 * 状态判定必须只看 entryTs（lastEntryTs），touch mtime 不得改变 status
 * （B(6) 的背离 fixture）。
 */
function writeChildSessionSplit(
	taskId: string,
	task: string,
	entryTs: number,
	fileMtimeMs: number,
	extraLines: string[] = [],
): string {
	const dir = path.join(rootDir, taskId);
	fs.mkdirSync(dir, { recursive: true });
	const filePath = path.join(dir, `${iso(fileMtimeMs)}_${taskId}.jsonl`);
	fs.writeFileSync(filePath, childSessionLines(taskId, task, entryTs, extraLines).join("\n") + "\n", "utf-8");
	const d = new Date(fileMtimeMs);
	fs.utimesSync(filePath, d, d);
	fs.utimesSync(dir, d, d);

	return filePath;
}

/**
 * 写派发指针文件：在 <rootDir>/<taskId>/children.jsonl 逐行写入 JSON
 * （文件名与 src/web/children.ts 的 CHILDREN_FILE_NAME 一致；红阶段用字面量
 * 避免对未实现模块的运行时依赖）。
 */
function writeChildrenJsonl(taskId: string, records: ChildPointer[]): void {
	const dir = path.join(rootDir, taskId);
	fs.mkdirSync(dir, { recursive: true });
	const lines = records.map((record) => JSON.stringify(record));
	fs.writeFileSync(path.join(dir, "children.jsonl"), lines.join("\n") + "\n", "utf-8");
}

/** 设定任意路径（文件或目录）的 mtime。 */
function setMtime(p: string, mtimeMs: number): void {
	const d = new Date(mtimeMs);
	fs.utimesSync(p, d, d);
}

/** 默认 deps：主会话文件 + 空 registry + 注入固定 now。 */
function makeDeps(overrides: Partial<BuildTreeDeps> = {}): BuildTreeDeps {
	return { mainSessionFile: mainFile, registry: new Map(), rootDir, now: NOW, ...overrides };
}

/** 深度优先收集全树节点（含根）。 */
function flatten(nodes: SessionTreeNode[]): SessionTreeNode[] {
	return nodes.flatMap((n) => [n, ...flatten(n.children)]);
}

/** readdirSync 观测里以 rootDir 为参数的调用（硬约束验收）。 */
function rootDirReaddirs(): unknown[][] {
	return vi
		.mocked(fs.readdirSync)
		.mock.calls.filter((args) => args[0] === rootDir);
}

/** readdirSync 观测里以 dirs 中任一目录为参数的调用次数（惰性扫描 / 子树缓存验收）。 */
function readdirsOf(dirs: string[]): number {
	return vi
		.mocked(fs.readdirSync)
		.mock.calls.filter((args) => dirs.includes(args[0] as string)).length;
}

/**
 * 新惰性契约：只有 running/recent 节点即时扫描子节点，finished 节点默认惰性。
 * 既有夹具的父节点多判 finished（旧实现无条件扫描、看不见差异），用例改以
 * registry running 显式标记「父节点在飞 → 即时扫描」，对新旧实现等价成立。
 */
function runningRegistry(...ids: string[]): Map<string, { status: string }> {
	return new Map(ids.map((id) => [id, { status: "running" }]));
}

/**
 * 生成 count 条「toolCall + 异步收据」派发行：taskId 逐条唯一（idBase + i），
 * ts 严格递增（tsBase + i * stepMs），task 文本为 "<prefix> <i>"。
 * 用于 250 / >1000 条的规模与截断夹具。
 */
function dispatchLines(
	count: number,
	prefix: string,
	tsBase: number,
	stepMs: number,
	idBase: number,
	agent = "coder",
): string[] {
	const lines: string[] = [];
	for (let i = 0; i < count; i++) {
		const ts = tsBase + i * stepMs;
		lines.push(toolCallLine(`${prefix}-${i}`, agent, `${prefix} ${i}`, ts));
		lines.push(receiptLine(`${prefix}-${i}`, `Dispatched ${agent}. taskId: ${uuid(idBase + i)}`, ts + 1));
	}
	return lines;
}

// ================================================================
// 1. 异步收据解析
// ================================================================
describe("异步收据（Dispatched <agent>. taskId: <id>）", () => {
	it("should build a root node with receipt linkSource when the main session holds an async dispatch receipt", () => {
		// Arrange: 主会话 toolCall + 异步收据；子目录/子会话存在
		const childId = uuid(1);
		const task = "Implement the tree module";
		writeMain([
			sessionHeaderLine("main-session", NOW - 300_000),
			toolCallLine("call-1", "coder", task, NOW - 120_000),
			receiptLine("call-1", `Dispatched coder. taskId: ${childId}`, NOW - 110_000),
		]);
		writeChildSession(childId, task, NOW - 5_000);

		// Act
		const tree = buildSessionTree(makeDeps());

		// Assert
		expect(tree).toHaveLength(1);
		const node = tree[0];
		expect(node.taskId).toBe(childId);
		expect(node.agent).toBe("coder");
		expect(node.task).toBe(task);
		expect(node.linkSource).toBe("receipt");
		expect(node.depth).toBe(0);
		expect(node.children).toHaveLength(0);
		expect(node.status).toBe("recent"); // 文件 mtime = now−5s，在 now−10s 兜底窗口内
		expect(node.finishedAt).toBeUndefined();
		expect(Number.isFinite(node.startedAt)).toBe(true);
		expect(node.startedAt).toBeGreaterThan(0);
		expect(node.startedAt).toBeLessThanOrEqual(NOW);
	});

	it("should build a receipt node when the agent name in the async receipt contains a space", () => {
		// Arrange: 收据 "Dispatched ops legion. taskId: <id>" —— agent 名含空格；
		// 解析不得因 agent 段遇空白断掉而整条收据失配、降级为 unknown
		const childId = uuid(18);
		const task = "Coordinate the ops legion";
		writeMain([
			sessionHeaderLine("main-session", NOW - 300_000),
			toolCallLine("call-1", "ops legion", task, NOW - 120_000),
			receiptLine("call-1", `Dispatched ops legion. taskId: ${childId}`, NOW - 110_000),
		]);

		// Act: 无需子会话目录 —— 收据本身足以建链，直接断言节点
		const tree = buildSessionTree(makeDeps());

		// Assert: agent 保留空格原样，taskId 取自收据，来源为 receipt（而非 unknown）
		expect(tree).toHaveLength(1);
		const node = tree[0];
		expect(node.agent).toBe("ops legion");
		expect(node.taskId).toBe(childId);
		expect(node.linkSource).toBe("receipt");
	});
});

// ================================================================
// 2. 同步后缀解析
// ================================================================
describe("同步后缀（[subagent session: <id>]）", () => {
	it("should build a root node with receipt linkSource when the toolResult text ends with the sync session suffix", () => {
		// Arrange: toolResult 文本 = 任意正文 + 空行 + 后缀行（以 \n 结尾）
		const childId = uuid(2);
		const task = "Write the release notes";
		const receiptText = `Done, full transcript attached.\n\n[subagent session: ${childId}]\n`;
		writeMain([
			sessionHeaderLine("main-session", NOW - 300_000),
			toolCallLine("call-1", "researcher", task, NOW - 120_000),
			receiptLine("call-1", receiptText, NOW - 110_000),
		]);
		writeChildSession(childId, task, NOW - 5_000);

		// Act
		const tree = buildSessionTree(makeDeps());

		// Assert
		expect(tree).toHaveLength(1);
		const node = tree[0];
		expect(node.taskId).toBe(childId);
		expect(node.agent).toBe("researcher");
		expect(node.task).toBe(task);
		expect(node.linkSource).toBe("receipt");
		expect(node.depth).toBe(0);
		expect(node.children).toHaveLength(0);
	});
});

// ================================================================
// 3. 在飞子任务通过指针建链
// ================================================================
describe("在飞派发的指针建链（children.jsonl）", () => {
	it("should link an in-flight dispatch from the child pointer file without emitting a redundant unknown node", () => {
		// Arrange: 主会话 receipt → A；A 会话里有一条无收据的 toolCall（call-2）；
		// A 的会话目录 children.jsonl 含一条与 call-2 agent/task 都相同的指针指向 B；
		// B 目录存在子会话文件
		const aId = uuid(3);
		const bId = uuid(4);
		const aTask = "Parent task dispatched by the main agent";
		const bTask = "In-flight task whose receipt has not landed";
		writeMain([
			sessionHeaderLine("main-session", NOW - 300_000),
			toolCallLine("call-1", "coder", aTask, NOW - 120_000),
			receiptLine("call-1", `Dispatched coder. taskId: ${aId}`, NOW - 110_000),
		]);
		writeChildSession(aId, aTask, NOW - 100_000, [toolCallLine("call-2", "tester", bTask, NOW - 95_000)]);
		writeChildrenJsonl(aId, [{ childTaskId: bId, agent: "tester", task: bTask, startedAt: NOW - 94_000, depth: 2 }]);
		writeChildSession(bId, bTask, NOW - 80_000);

		// Act: A 标为 running（新惰性契约：finished 父节点默认不展开子节点）
		const tree = buildSessionTree(makeDeps({ registry: runningRegistry(aId) }));

		// Assert: A 恰有 1 个子节点，字段来自指针；不出现 unknown 冗余节点
		expect(tree).toHaveLength(1);
		const a = tree[0];
		expect(a.taskId).toBe(aId);
		expect(a.children).toHaveLength(1);
		const b = a.children[0];
		expect(b.taskId).toBe(bId);
		expect(b.agent).toBe("tester");
		expect(b.task).toBe(bTask);
		expect(b.linkSource).toBe("pointer");
		expect(b.depth).toBe(1);
		expect(flatten(tree).some((n) => n.taskId === "" || n.linkSource === "unknown")).toBe(false);
	});
});

// ================================================================
// 3b. 指针覆盖判定的空白容忍（toolCall task 原文 vs 指针 task 已 trim）
// ================================================================
describe("指针覆盖判定的空白容忍", () => {
	it("should cover a receipt-less toolCall whose raw task text only differs from the pointer task by surrounding whitespace", () => {
		// Arrange: 主会话 receipt → A；A 会话里一条无收据 toolCall，其 arguments.task
		// 为原文（带首尾空白，LLM 传参未 trim 就落进 JSONL）；A 目录 children.jsonl
		// 里的指针 task 为 trim 后文本（派发路径写指针用 params.task.trim()）；
		// B 目录存在子会话
		const aId = uuid(60);
		const bId = uuid(61);
		const aTask = "Parent task of the whitespace dispatch";
		const rawTask = "  Deploy the fix  \n";
		const trimmedTask = "Deploy the fix";
		writeMain([
			sessionHeaderLine("main-session", NOW - 300_000),
			toolCallLine("call-1", "coder", aTask, NOW - 120_000),
			receiptLine("call-1", `Dispatched coder. taskId: ${aId}`, NOW - 110_000),
		]);
		writeChildSession(aId, aTask, NOW - 100_000, [toolCallLine("call-2", "tester", rawTask, NOW - 95_000)]);
		writeChildrenJsonl(aId, [{ childTaskId: bId, agent: "tester", task: trimmedTask, startedAt: NOW - 94_000, depth: 2 }]);
		writeChildSession(bId, trimmedTask, NOW - 80_000);

		// Act: A 标为 running 触发即时扫描（新惰性契约）
		const tree = buildSessionTree(makeDeps({ registry: runningRegistry(aId) }));

		// Assert: A 恰 1 个子节点（指针建链）；空白差异不得让覆盖判定失配、
		// 多出一个 unknown 冗余节点
		expect(tree).toHaveLength(1);
		expect(tree[0].children).toHaveLength(1);
		const b = tree[0].children[0];
		expect(b.taskId).toBe(bId);
		expect(b.linkSource).toBe("pointer");
		expect(flatten(tree).some((n) => n.taskId === "")).toBe(false);
	});
});

// ================================================================
// 4. 无 receipt 无指针 → unknown 降级
// ================================================================
describe("unknown 降级（既无收据也无指针）", () => {
	it("should build a single unknown node with an empty taskId when a dispatch has neither a receipt nor a pointer", () => {
		// Arrange: 主会话只有一条 toolCall，无 receipt；rootDir 下无任何 children.jsonl
		const task = "Nobody linked this dispatch yet";
		writeMain([sessionHeaderLine("main-session", NOW - 300_000), toolCallLine("call-1", "coder", task, NOW - 60_000)]);

		// Act: 清空 readdir 观测后 build —— unknown 分支同样不得以 rootDir 为参数
		// 枚举（抓住「在 unknown 分支加回 rootDir 兜底枚举」的回归）
		const readdirSpy = vi.mocked(fs.readdirSync);
		readdirSpy.mockClear();
		const tree = buildSessionTree(makeDeps());
		const rootReaddirs = rootDirReaddirs();

		// Assert: 1 个 unknown 节点，taskId 为空串，agent/task 来自 toolCall 参数
		expect(tree).toHaveLength(1);
		const node = tree[0];
		expect(node.taskId).toBe("");
		expect(node.linkSource).toBe("unknown");
		expect(node.agent).toBe("coder");
		expect(node.task).toBe(task);
		expect(node.depth).toBe(0);
		expect(node.children).toHaveLength(0);

		// Assert: 未以 rootDir 为参数 readdirSync
		expect(rootReaddirs).toHaveLength(0);
	});

	it("should mark a receipt-less, pointer-less dispatch as pending with no finishedAt while it waits for the receipt", () => {
		// Arrange: 主会话只有一条 toolCall，无 receipt；无任何 children.jsonl → unknown 节点
		const task = "Dispatch still waiting for its receipt";
		writeMain([sessionHeaderLine("main-session", NOW - 300_000), toolCallLine("call-1", "coder", task, NOW - 60_000)]);

		// Act
		const tree = buildSessionTree(makeDeps());

		// Assert: 等待收据的 unknown 节点用独立的 pending 状态，不得标成 finished，
		// 也不得带 finishedAt
		expect(tree).toHaveLength(1);
		const node = tree[0];
		expect(node.linkSource).toBe("unknown");
		expect(node.status).toBe("pending");
		expect(node.finishedAt).toBeUndefined();
	});
});

// ================================================================
// 5. 指针升级为收据、不重复建节点
// ================================================================
describe("指针升级为收据", () => {
	it("should upgrade a pointer node to receipt and not duplicate it once the receipt lands in the parent session", () => {
		// Arrange: 同第 3 节的指针场景
		const aId = uuid(5);
		const bId = uuid(6);
		const aTask = "Parent that will receive the late receipt";
		const bTask = "Long running analysis";
		writeMain([
			sessionHeaderLine("main-session", NOW - 300_000),
			toolCallLine("call-1", "coder", aTask, NOW - 120_000),
			receiptLine("call-1", `Dispatched coder. taskId: ${aId}`, NOW - 110_000),
		]);
		const aFile = writeChildSession(aId, aTask, NOW - 100_000, [toolCallLine("call-2", "tester", bTask, NOW - 95_000)]);
		writeChildrenJsonl(aId, [{ childTaskId: bId, agent: "tester", task: bTask, startedAt: NOW - 94_000, depth: 2 }]);
		writeChildSession(bId, bTask, NOW - 80_000);

		// Act 1: 收据落盘前 → pointer 链接（A 标 running 以触发即时扫描：新惰性契约）
		const registry = runningRegistry(aId);
		const before = buildSessionTree(makeDeps({ registry }));
		expect(before).toHaveLength(1);
		expect(before[0].children).toHaveLength(1);
		expect(before[0].children[0].taskId).toBe(bId);
		expect(before[0].children[0].linkSource).toBe("pointer");

		// Act 2: 向 A 会话追加对应异步收据后再次构建
		fs.appendFileSync(aFile, receiptLine("call-2", `Dispatched tester. taskId: ${bId}`, NOW - 70_000) + "\n", "utf-8");
		const after = buildSessionTree(makeDeps({ registry }));

		// Assert: 同一节点、数量不增、linkSource 升级
		expect(after).toHaveLength(1);
		expect(after[0].children).toHaveLength(1);
		const b = after[0].children[0];
		expect(b.taskId).toBe(bId);
		expect(b.agent).toBe("tester");
		expect(b.task).toBe(bTask);
		expect(b.linkSource).toBe("receipt");
		expect(b.depth).toBe(1);
	});
});

// ================================================================
// 6. 递归：孙会话
// ================================================================
describe("递归建树", () => {
	it("should recurse into child sessions that themselves dispatched tasks and increment depth 0/1/2", () => {
		// Arrange: 主会话 → a（异步收据）；a 会话 → b（异步收据）；b 会话 → c（异步收据）
		const aId = uuid(7);
		const bId = uuid(8);
		const cId = uuid(9);
		const aTask = "Split the work into a sub task";
		const bTask = "Deep dive the sub task";
		const cTask = "Verify the deep dive";
		writeMain([
			sessionHeaderLine("main-session", NOW - 300_000),
			toolCallLine("call-1", "coder", aTask, NOW - 120_000),
			receiptLine("call-1", `Dispatched coder. taskId: ${aId}`, NOW - 110_000),
		]);
		writeChildSession(aId, aTask, NOW - 100_000, [
			toolCallLine("call-2", "tester", bTask, NOW - 95_000),
			receiptLine("call-2", `Dispatched tester. taskId: ${bId}`, NOW - 90_000),
		]);
		writeChildSession(bId, bTask, NOW - 80_000, [
			toolCallLine("call-3", "reviewer", cTask, NOW - 75_000),
			receiptLine("call-3", `Dispatched reviewer. taskId: ${cId}`, NOW - 70_000),
		]);
		writeChildSession(cId, cTask, NOW - 60_000);

		// Act: A、B 标为 running 触发逐层即时扫描（新惰性契约：finished/pending
		// 中间节点默认不展开，深度断言本身不变）
		const tree = buildSessionTree(makeDeps({ registry: runningRegistry(aId, bId) }));
		expect(tree).toHaveLength(1);
		const root = tree[0];
		expect(root.taskId).toBe(aId);
		expect(root.agent).toBe("coder");
		expect(root.task).toBe(aTask);
		expect(root.depth).toBe(0);
		expect(root.children).toHaveLength(1);

		const child = root.children[0];
		expect(child.taskId).toBe(bId);
		expect(child.agent).toBe("tester");
		expect(child.task).toBe(bTask);
		expect(child.linkSource).toBe("receipt");
		expect(child.depth).toBe(1);
		expect(child.children).toHaveLength(1);

		const grand = child.children[0];
		expect(grand.taskId).toBe(cId);
		expect(grand.agent).toBe("reviewer");
		expect(grand.task).toBe(cTask);
		expect(grand.linkSource).toBe("receipt");
		expect(grand.depth).toBe(2);
		expect(grand.children).toHaveLength(0);
	});
});

// ================================================================
// 7. 深度上限 6、节点上限 200
// ================================================================
describe("规模上限", () => {
	it("should keep depth at or below 6 when the dispatch chain nests deeper than the cap", () => {
		// Arrange: 主会话 → c0 → c1 → … → c9（共 10 层子任务，超深度上限）
		const CHAIN = 10;
		const ids = Array.from({ length: CHAIN }, (_, i) => uuid(100 + i));
		writeMain([
			sessionHeaderLine("main-session", NOW - 600_000),
			toolCallLine("call-main", "coder", "task-0", NOW - 500_000),
			receiptLine("call-main", `Dispatched coder. taskId: ${ids[0]}`, NOW - 490_000),
		]);
		for (let i = 0; i < CHAIN; i++) {
			const extras =
				i < CHAIN - 1
					? [
							toolCallLine(`call-${i}`, "coder", `task-${i + 1}`, NOW - 400_000 + i * 1_000),
							receiptLine(`call-${i}`, `Dispatched coder. taskId: ${ids[i + 1]}`, NOW - 400_000 + i * 1_000 + 1),
						]
					: [];
			writeChildSession(ids[i], `task-${i}`, NOW - 60_000, extras);
		}

		// Act: 新惰性契约下中间节点不默认展开 —— 把链上全部子任务标为 running
		// 触发逐层即时扫描；深度上限断言本身不变
		const registry = new Map(ids.map((id) => [id, { status: "running" as const, agentName: "coder" }]));
		const tree = buildSessionTree(makeDeps({ registry }));
		const nodes = flatten(tree);
		const maxDepth = Math.max(...nodes.map((n) => n.depth));

		// Assert: 不无限增长；且链确实长出了节点（防空树假通过）
		expect(maxDepth).toBeLessThanOrEqual(6);
		expect(nodes.length).toBeGreaterThanOrEqual(7);
	});

	it("should keep all 250 top-level dispatches when they stay under the 1000 top-level budget", () => {
		// Arrange: 主会话派发 250 个任务，每个都有收据与子会话。旧全局
		// MAX_NODES=200 会砍到 200；新契约顶层预算 MAX_ROOT_NODES=1000，250 全留
		const TASKS = 250;
		const lines = [sessionHeaderLine("main-session", NOW - 600_000)];
		for (let i = 0; i < TASKS; i++) {
			const id = uuid(1000 + i);
			lines.push(toolCallLine(`call-${i}`, "coder", `task ${i}`, NOW - 500_000));
			lines.push(receiptLine(`call-${i}`, `Dispatched coder. taskId: ${id}`, NOW - 500_000 + 1));
			writeChildSession(id, `task ${i}`, NOW - 10_000);
		}
		writeMain(lines);

		// Act
		const result = buildSessionTreeResult(makeDeps());

		// Assert: 250 个顶层节点全部保留；truncated 报未截断三值（字段始终存在）
		expect(result.nodes).toHaveLength(250);
		expect(result.truncated).toEqual({ total: 250, showing: 250, dropped: 0 });
		expect(result.nodes.map((n) => n.task)).toEqual(Array.from({ length: 250 }, (_, i) => `task ${i}`));
		// buildSessionTree 保持旧签名，返回同一 nodes 数组
		expect(buildSessionTree(makeDeps())).toEqual(result.nodes);
	});
});

// ================================================================
// 8. 诱饵目录不产生节点
// ================================================================
describe("非任务目录", () => {
	it("should never turn hidden, non-UUID or jsonl-less decoy directories into nodes", () => {
		// Arrange: 唯一的派发走 receipt；rootDir 下另有三个与派发无关的诱饵目录
		// （旧机制会枚举 rootDir 做内容匹配；新机制只按 receipt/指针定向 stat，
		// 诱饵无论如何都不应变成节点）
		const childId = uuid(10);
		const task = "The only dispatched task";
		writeMain([
			sessionHeaderLine("main-session", NOW - 300_000),
			toolCallLine("call-1", "coder", task, NOW - 120_000),
			receiptLine("call-1", `Dispatched coder. taskId: ${childId}`, NOW - 110_000),
		]);
		writeChildSession(childId, task, NOW - 10_000);

		// 诱饵 1：隐藏目录 .zvec-grep/，内含可解析的会话 jsonl
		writeChildSession(".zvec-grep", "decoy hidden dir task", NOW - 10_000);
		// 诱饵 2：非 UUID 目录名，内含可解析的会话 jsonl
		writeChildSession("not-a-uuid-dir", "decoy non uuid task", NOW - 10_000);
		// 诱饵 3：UUID 形状目录名，但没有 .jsonl（空目录）
		const emptyId = uuid(11);
		const emptyDir = path.join(rootDir, emptyId);
		fs.mkdirSync(emptyDir, { recursive: true });
		setMtime(emptyDir, NOW - 10_000);

		// Act
		const tree = buildSessionTree(makeDeps());

		// Assert: 只有 receipt 指向的任务建节点，三个诱饵都不出现
		expect(tree).toHaveLength(1);
		expect(tree[0].taskId).toBe(childId);
		expect(tree[0].linkSource).toBe("receipt");
		const nodes = flatten(tree);
		expect(nodes.some((n) => n.taskId === ".zvec-grep")).toBe(false);
		expect(nodes.some((n) => n.taskId === "not-a-uuid-dir")).toBe(false);
		expect(nodes.some((n) => n.taskId === emptyId)).toBe(false);
	});
});

// ================================================================
// 9. status 三态
// ================================================================
describe("status 判定", () => {
	it("should mark a node running when the registry lists the taskId as running", () => {
		// Arrange: 文件 mtime 很旧，但 registry 说 running → registry 优先
		const childId = uuid(12);
		const task = "Still going";
		writeMain([
			sessionHeaderLine("main-session", NOW - 600_000),
			toolCallLine("call-1", "coder", task, NOW - 500_000),
			receiptLine("call-1", `Dispatched coder. taskId: ${childId}`, NOW - 490_000),
		]);
		writeChildSession(childId, task, NOW - 600_000);
		const registry = new Map([[childId, { status: "running", agentName: "coder", task }]]);

		// Act
		const tree = buildSessionTree(makeDeps({ registry }));

		// Assert
		expect(tree).toHaveLength(1);
		expect(tree[0].taskId).toBe(childId);
		expect(tree[0].status).toBe("running");
		expect(tree[0].finishedAt).toBeUndefined();
	});

	it("should mark a node recent when the child session's last entry timestamp is within the 10s fallback window of now", () => {
		// Arrange: 不在 registry，子会话最后条目 ts = now−5s（10s 兜底窗口内，且不踩
		// now−10s 的窗口边界）
		const childId = uuid(13);
		const task = "Just finished";
		writeMain([
			sessionHeaderLine("main-session", NOW - 600_000),
			toolCallLine("call-1", "coder", task, NOW - 500_000),
			receiptLine("call-1", `Dispatched coder. taskId: ${childId}`, NOW - 490_000),
		]);
		writeChildSession(childId, task, NOW - 5_000);

		// Act
		const tree = buildSessionTree(makeDeps());

		// Assert
		expect(tree).toHaveLength(1);
		expect(tree[0].status).toBe("recent");
		expect(tree[0].finishedAt).toBeUndefined();
	});

	it("should mark a node finished with lastEntryTs as finishedAt when the last entry timestamp is older than the 10s fallback window", () => {
		// Arrange: 不在 registry，子会话最后条目 ts = now−600s
		const childId = uuid(14);
		const task = "Long done";
		writeMain([
			sessionHeaderLine("main-session", NOW - 600_000),
			toolCallLine("call-1", "coder", task, NOW - 500_000),
			receiptLine("call-1", `Dispatched coder. taskId: ${childId}`, NOW - 490_000),
		]);
		writeChildSession(childId, task, NOW - 600_000);

		// Act
		const tree = buildSessionTree(makeDeps());

		// Assert
		expect(tree).toHaveLength(1);
		expect(tree[0].taskId).toBe(childId);
		expect(tree[0].status).toBe("finished");
		expect(tree[0].finishedAt).toBe(NOW - 600_000);
	});
});

// ================================================================
// 9b. 状态优先级：running > 同步收据 > 完成记录 > lastEntryTs 兜底窗口（10s）
// ================================================================
describe("状态优先级（同步收据 / 完成记录 / lastEntryTs 兜底）", () => {
	it("should mark a node finished with the sync receipt toolResult timestamp as finishedAt even when the child session mtime is now", () => {
		// Arrange: 同步收据（文本以 [subagent session: <id>] 结尾）= 派发即结束；
		// 收据条目 ts 取与 mtime 明显不同的固定值 NOW−123456，子会话 mtime = NOW
		const childId = uuid(200);
		const task = "Sync dispatched task";
		const receiptTs = NOW - 123_456;
		writeMain([
			sessionHeaderLine("main-session", NOW - 300_000),
			toolCallLine("call-1", "coder", task, NOW - 200_000),
			receiptLine("call-1", `Done, done.\n\n[subagent session: ${childId}]`, receiptTs),
		]);
		writeChildSession(childId, task, NOW);

		// Act
		const tree = buildSessionTree(makeDeps());

		// Assert: 同步收据即结束 —— 即使 mtime = now 也不得判 recent；
		// finishedAt 精确等于该 toolResult 条目的 timestamp（session-source 用
		// entry.timestamp 解析），不是 mtime、不是 now
		expect(tree).toHaveLength(1);
		const node = tree[0];
		expect(node.status).toBe("finished");
		expect(node.finishedAt).toBe(receiptTs);
	});

	it("should prefer a completedTasks record over the fresh mtime for an async-receipt node", () => {
		// Arrange: 异步收据节点、子会话 mtime = NOW（无记录时会判 recent），
		// 注入完成记录 status "succeeded"、finishedAt = NOW−777
		const childId = uuid(201);
		const task = "Async dispatched task completed in this process";
		writeMain([
			sessionHeaderLine("main-session", NOW - 300_000),
			toolCallLine("call-1", "coder", task, NOW - 200_000),
			receiptLine("call-1", `Dispatched coder. taskId: ${childId}`, NOW - 110_000),
		]);
		writeChildSession(childId, task, NOW);
		const completedTasks = new Map([[childId, { status: "succeeded", finishedAt: NOW - 777 }]]);

		// Act
		const tree = buildSessionTree(makeDeps({ completedTasks }));

		// Assert: 完成记录压过 mtime 窗口 → finished，finishedAt 取记录里的值
		expect(tree).toHaveLength(1);
		const node = tree[0];
		expect(node.status).toBe("finished");
		expect(node.finishedAt).toBe(NOW - 777);
	});

	it("should prefer the sync receipt timestamp over a completedTasks record for finishedAt", () => {
		// Arrange: 同一 childId 同时有同步收据与完成记录，两者 finishedAt 不同
		//（优先级链第 2 位压第 3 位：收据 ts 胜出），mtime = NOW
		const childId = uuid(202);
		const task = "Both a sync receipt and a completion record";
		const receiptTs = NOW - 50_000;
		writeMain([
			sessionHeaderLine("main-session", NOW - 300_000),
			toolCallLine("call-1", "coder", task, NOW - 200_000),
			receiptLine("call-1", `Done.\n\n[subagent session: ${childId}]`, receiptTs),
		]);
		writeChildSession(childId, task, NOW);
		const completedTasks = new Map([[childId, { status: "succeeded", finishedAt: NOW - 444_444 }]]);

		// Act
		const tree = buildSessionTree(makeDeps({ completedTasks }));

		// Assert: 同步收据优先 → finishedAt = 收据 toolResult ts，而非记录值
		expect(tree).toHaveLength(1);
		const node = tree[0];
		expect(node.status).toBe("finished");
		expect(node.finishedAt).toBe(receiptTs);
		expect(node.finishedAt).not.toBe(NOW - 444_444);
	});

	it("should keep a registry running node at running even with a sync receipt and a completedTasks record", () => {
		// Arrange: 同一 childId 三重信号齐全 —— registry running + 同步收据 +
		// 完成记录，mtime = NOW；registry 优先级最高
		const childId = uuid(203);
		const task = "Still running despite stale completion signals";
		writeMain([
			sessionHeaderLine("main-session", NOW - 300_000),
			toolCallLine("call-1", "coder", task, NOW - 200_000),
			receiptLine("call-1", `Done.\n\n[subagent session: ${childId}]`, NOW - 150_000),
		]);
		writeChildSession(childId, task, NOW);
		const registry = new Map([[childId, { status: "running", agentName: "coder", task }]]);
		const completedTasks = new Map([[childId, { status: "succeeded", finishedAt: NOW - 777 }]]);

		// Act
		const tree = buildSessionTree(makeDeps({ registry, completedTasks }));

		// Assert: registry running 压过同步收据与完成记录，且不得带 finishedAt
		expect(tree).toHaveLength(1);
		const node = tree[0];
		expect(node.status).toBe("running");
		expect(node.finishedAt).toBeUndefined();
	});

	it("should not treat an async dispatch receipt as completion when the child session was just written", () => {
		// Arrange: 异步收据（落盘于派发瞬间，不代表结束）+ mtime = NOW +
		// 空 registry + 无完成记录
		const childId = uuid(204);
		const task = "Async receipt is not a completion signal";
		writeMain([
			sessionHeaderLine("main-session", NOW - 300_000),
			toolCallLine("call-1", "coder", task, NOW - 200_000),
			receiptLine("call-1", `Dispatched coder. taskId: ${childId}`, NOW - 110_000),
		]);
		writeChildSession(childId, task, NOW);

		// Act
		const tree = buildSessionTree(makeDeps());

		// Assert: 异步收据本身不判 finished —— 仍走 mtime 窗口 → recent
		expect(tree).toHaveLength(1);
		const node = tree[0];
		expect(node.status).toBe("recent");
		expect(node.finishedAt).toBeUndefined();
	});

	it("should mark a node recent when the only signal is a last entry timestamp inside the 10s fallback window", () => {
		// Arrange: 无 registry、无完成记录、无同步收据；最后条目 ts = NOW−9_000
		//（10s 兜底窗口内，且不踩边界）
		const childId = uuid(205);
		const task = "Only a lastEntryTs signal";
		writeMain([
			sessionHeaderLine("main-session", NOW - 600_000),
			toolCallLine("call-1", "coder", task, NOW - 500_000),
			receiptLine("call-1", `Dispatched coder. taskId: ${childId}`, NOW - 490_000),
		]);
		writeChildSession(childId, task, NOW - 9_000);

		// Act
		const tree = buildSessionTree(makeDeps());

		// Assert
		expect(tree).toHaveLength(1);
		expect(tree[0].status).toBe("recent");
		expect(tree[0].finishedAt).toBeUndefined();
	});

	it("should mark a node finished with lastEntryTs as finishedAt when the last entry timestamp falls outside the 10s fallback window", () => {
		// Arrange: 最后条目 ts = NOW−20_000 —— 旧 30s 窗口内（会判 recent）、新 10s
		// 兜底窗外（必须判 finished）；无 registry、无完成记录、无同步收据
		const childId = uuid(206);
		const task = "Quiet for longer than the fallback window";
		writeMain([
			sessionHeaderLine("main-session", NOW - 600_000),
			toolCallLine("call-1", "coder", task, NOW - 500_000),
			receiptLine("call-1", `Dispatched coder. taskId: ${childId}`, NOW - 490_000),
		]);
		writeChildSession(childId, task, NOW - 20_000);

		// Act
		const tree = buildSessionTree(makeDeps());

		// Assert: 窗口缩到 10s → finished，finishedAt 为子会话最后条目 ts 本身
		expect(tree).toHaveLength(1);
		const node = tree[0];
		expect(node.status).toBe("finished");
		expect(node.finishedAt).toBe(NOW - 20_000);
	});
});

// ================================================================
// 独立审查缺口（第 7 轮后补）契约 5：recent 上界 —— 兑底窗口为闭区间
// [now−10_000, now]：未来 lastEntryTs（时钟偏移）不判 recent，直接落到
// 兑底 finished；下界 NOW−10_000 仍 recent（含），NOW−10_001 已出窗 → finished。
// 夹具用 writeChildSessionSplit 分离条目 ts 与文件 mtime，只验条目时间戳。
// ================================================================
describe("recent 上界（未来 lastEntryTs 不判 recent，窗口边界闭区间）", () => {
	it("should mark a node finished, not recent, when the child's last entry timestamp is 5s in the future", () => {
		// Arrange: 异步收据（depth 0）+ 子会话最后条目 ts = NOW+5_000（窗口上界
		// now 之外的未来时间戳），文件 mtime 钉在 NOW 避免 mtime 干扰
		const childId = uuid(210_001);
		const task = "Clock-skewed future child";
		writeMain([
			sessionHeaderLine("main-session", NOW - 600_000),
			toolCallLine("call-1", "coder", task, NOW - 500_000),
			receiptLine("call-1", `Dispatched coder. taskId: ${childId}`, NOW - 490_000),
		]);
		writeChildSessionSplit(childId, task, NOW + 5_000, NOW);

		// Act
		const tree = buildSessionTree(makeDeps());

		// Assert: 未来时间戳在窗口外 —— finished，finishedAt = 该未来 ts 本身，
		// 不得因 |Δnow| 小而判 recent
		expect(tree).toHaveLength(1);
		const node = tree[0];
		expect(node.status).toBe("finished");
		expect(node.finishedAt).toBe(NOW + 5_000);
	});

	it("should mark a node finished, never permanently recent, when the child's last entry timestamp is 10 hours in the future", () => {
		// Arrange: 最后条目 ts = NOW+10*3600_000（远未来）—— 若实现写成
		// Math.abs(now−lastEntryTs) ≤ 窗口 之类的双向判定，这里会永远 recent
		const childId = uuid(210_002);
		const task = "Far-future child session";
		writeMain([
			sessionHeaderLine("main-session", NOW - 600_000),
			toolCallLine("call-1", "coder", task, NOW - 500_000),
			receiptLine("call-1", `Dispatched coder. taskId: ${childId}`, NOW - 490_000),
		]);
		writeChildSessionSplit(childId, task, NOW + 10 * 3600_000, NOW);

		// Act
		const tree = buildSessionTree(makeDeps());

		// Assert: 远未来同样出窗 —— finished（不得永远 recent），finishedAt = 该 ts
		expect(tree).toHaveLength(1);
		const node = tree[0];
		expect(node.status).toBe("finished");
		expect(node.finishedAt).toBe(NOW + 10 * 3600_000);
	});

	it("should keep the inclusive lower boundary: lastEntryTs exactly NOW − 10_000 is still recent", () => {
		// Arrange: 最后条目 ts 恰在窗口下界 NOW−10_000（闭区间，含）
		const childId = uuid(210_003);
		const task = "Exactly on the recent window edge";
		writeMain([
			sessionHeaderLine("main-session", NOW - 600_000),
			toolCallLine("call-1", "coder", task, NOW - 500_000),
			receiptLine("call-1", `Dispatched coder. taskId: ${childId}`, NOW - 490_000),
		]);
		writeChildSessionSplit(childId, task, NOW - 10_000, NOW - 10_000);

		// Act
		const tree = buildSessionTree(makeDeps());

		// Assert: 边界含 —— recent，且不带 finishedAt
		expect(tree).toHaveLength(1);
		const node = tree[0];
		expect(node.status).toBe("recent");
		expect(node.finishedAt).toBeUndefined();
	});

	it("should mark a node finished one millisecond past the lower boundary (lastEntryTs = NOW − 10_001)", () => {
		// Arrange: 最后条目 ts = NOW−10_001 —— 比下界多 1ms，刚出窗
		const childId = uuid(210_004);
		const task = "One millisecond past the window";
		writeMain([
			sessionHeaderLine("main-session", NOW - 600_000),
			toolCallLine("call-1", "coder", task, NOW - 500_000),
			receiptLine("call-1", `Dispatched coder. taskId: ${childId}`, NOW - 490_000),
		]);
		writeChildSessionSplit(childId, task, NOW - 10_001, NOW - 10_001);

		// Act
		const tree = buildSessionTree(makeDeps());

		// Assert: 出窗即 finished，finishedAt = 最后条目 ts
		expect(tree).toHaveLength(1);
		const node = tree[0];
		expect(node.status).toBe("finished");
		expect(node.finishedAt).toBe(NOW - 10_001);
	});
});

// ================================================================
// 10. 会话目录的稳健性：多 .jsonl 取最新；无法解析的目录不致命
// ================================================================
describe("会话目录的稳健性", () => {
	it("should select the most recent jsonl in a receipt-linked session directory holding several files", () => {
		// Arrange: receipt 指向 childId；其目录内两份 jsonl —— 旧文件 session 头
		// 时间 NOW−200s（"stale task"）、新文件 NOW−10s（目标 task），文件与目录
		// mtime 显式设定（新者更新）。startedAt 取最新文件的 session 头时间。
		const childId = uuid(15);
		const task = "Latest session task";
		writeMain([
			sessionHeaderLine("main-session", NOW - 300_000),
			toolCallLine("call-1", "coder", task, NOW - 120_000),
			receiptLine("call-1", `Dispatched coder. taskId: ${childId}`, NOW - 110_000),
		]);
		const dir = path.join(rootDir, childId);
		fs.mkdirSync(dir, { recursive: true });
		const oldTs = NOW - 200_000;
		const oldFile = path.join(dir, `${iso(oldTs)}_${childId}.jsonl`);
		fs.writeFileSync(oldFile, childSessionLines(childId, "stale task", oldTs).join("\n") + "\n", "utf-8");
		setMtime(oldFile, oldTs);
		const newTs = NOW - 10_000;
		const newFile = path.join(dir, `${iso(newTs)}_${childId}.jsonl`);
		fs.writeFileSync(newFile, childSessionLines(childId, task, newTs).join("\n") + "\n", "utf-8");
		setMtime(newFile, newTs);
		setMtime(dir, newTs);

		// Act
		const tree = buildSessionTree(makeDeps());

		// Assert: 选中最新文件 —— startedAt 锁定为新文件的 session 头时间
		expect(tree).toHaveLength(1);
		expect(tree[0].taskId).toBe(childId);
		expect(tree[0].task).toBe(task);
		expect(tree[0].linkSource).toBe("receipt");
		expect(tree[0].startedAt).toBe(newTs);
		expect(tree[0].startedAt).not.toBe(oldTs);
	});

	it("should skip an unparsable session directory without failing the whole build", () => {
		// Arrange: 一个正常任务 + 一个会话文件全是垃圾字节的任务（都有收据）
		const goodId = uuid(16);
		const badId = uuid(17);
		const task = "Good task";
		writeMain([
			sessionHeaderLine("main-session", NOW - 300_000),
			toolCallLine("call-1", "coder", task, NOW - 120_000),
			receiptLine("call-1", `Dispatched coder. taskId: ${goodId}`, NOW - 110_000),
			toolCallLine("call-2", "tester", "Bad task", NOW - 120_000),
			receiptLine("call-2", `Dispatched tester. taskId: ${badId}`, NOW - 110_000),
		]);
		writeChildSession(goodId, task, NOW - 10_000);
		const badDir = path.join(rootDir, badId);
		fs.mkdirSync(badDir, { recursive: true });
		const badFile = path.join(badDir, `${iso(NOW - 10_000)}_${badId}.jsonl`);
		fs.writeFileSync(badFile, "not json at all\n{{{ totally broken\n binary-ish garbage\n", "utf-8");
		setMtime(badFile, NOW - 10_000);
		setMtime(badDir, NOW - 10_000);

		// Act: 不应抛错（坏目录是否仍建出降级节点未被规格锁定，这里只断言不致命）
		let tree: SessionTreeNode[] | undefined;
		expect(() => {
			tree = buildSessionTree(makeDeps());
		}).not.toThrow();

		// Assert: 正常任务不受影响
		expect(tree).toBeDefined();
		const good = (tree as SessionTreeNode[]).find((n) => n.taskId === goodId);
		expect(good, "正常任务的节点应照常建立").toBeDefined();
		expect(good?.agent).toBe("coder");
		expect(good?.linkSource).toBe("receipt");
	});

	it("should still link a grandchild by receipt when the sidecar children.jsonl is newer than the session file", () => {
		// Arrange: 主会话 receipt → A；A 的会话 jsonl 含 receipt → B；A 目录里另有
		// mtime 更新的 children.jsonl（指针指向 B —— 派发时先写指针、收据随后落盘
		// 的真实时序）。children.jsonl 以 .jsonl 结尾，选会话文件的逻辑必须排除它，
		// 否则会把它误当 A 的会话文件解析 → 读不到那张收据 → B 丢 receipt 链接
		const aId = uuid(70);
		const bId = uuid(71);
		const aTask = "Parent with a newer sidecar file";
		const bTask = "Grandchild linked by receipt";
		writeMain([
			sessionHeaderLine("main-session", NOW - 300_000),
			toolCallLine("call-1", "coder", aTask, NOW - 120_000),
			receiptLine("call-1", `Dispatched coder. taskId: ${aId}`, NOW - 110_000),
		]);
		writeChildSession(aId, aTask, NOW - 10_000, [
			toolCallLine("call-2", "tester", bTask, NOW - 9_500),
			receiptLine("call-2", `Dispatched tester. taskId: ${bId}`, NOW - 9_000),
		]);
		writeChildrenJsonl(aId, [{ childTaskId: bId, agent: "tester", task: bTask, startedAt: NOW - 9_400, depth: 2 }]);
		// sidecar mtime 新于 A 的会话文件（NOW−10s）
		setMtime(path.join(rootDir, aId, "children.jsonl"), NOW - 2_000);
		writeChildSession(bId, bTask, NOW - 8_000);

		// Act
		const tree = buildSessionTree(makeDeps());

		// Assert: B 仍以 receipt 建链（depth 1）——不因 sidecar 更新而降级/丢失
		expect(tree).toHaveLength(1);
		expect(tree[0].taskId).toBe(aId);
		expect(tree[0].children).toHaveLength(1);
		const b = tree[0].children[0];
		expect(b.taskId).toBe(bId);
		expect(b.linkSource).toBe("receipt");
		expect(b.depth).toBe(1);
	});
});

// ================================================================
// 11. 同一 childId 的去重守卫（锁定 ctx.seen 去重）
// ================================================================
describe("同一 childId 的去重守卫", () => {
	it("should build a single node when two async receipts in the same build point at the same childId", () => {
		// Arrange: 两个不同 toolCallId 的收据都指向同一 childId（如同一子任务被重复上报）
		const childId = uuid(21);
		const task = "Implement the dedup guard";
		writeMain([
			sessionHeaderLine("main-session", NOW - 300_000),
			toolCallLine("call-1", "coder", task, NOW - 120_000),
			receiptLine("call-1", `Dispatched coder. taskId: ${childId}`, NOW - 110_000),
			toolCallLine("call-2", "coder", task, NOW - 120_000),
			receiptLine("call-2", `Dispatched coder. taskId: ${childId}`, NOW - 110_000),
		]);
		writeChildSession(childId, task, NOW - 10_000);

		// Act
		const tree = buildSessionTree(makeDeps());

		// Assert: 两条收据 → 一个 childId → 只建 1 个节点
		expect(tree).toHaveLength(1);
		const node = tree[0];
		expect(node.taskId).toBe(childId);
		expect(node.agent).toBe("coder");
		expect(node.task).toBe(task);
		expect(node.linkSource).toBe("receipt");
		expect(node.depth).toBe(0);
		expect(node.children).toHaveLength(0);
	});

	it("should build a single receipt-sourced node when the same childId is hit by both a receipt and a pointer", () => {
		// Arrange: 主会话 receipt → A；A 会话内 call-2 有 receipt → B，同时 A 目录的
		// children.jsonl 里还有一条指向 B 的指针（派发时先写指针、收据随后落盘的
		// 真实时序）→ 同一 childId 同时被 receipt 与 pointer 命中。
		const aId = uuid(22);
		const bId = uuid(23);
		const aTask = "Parent of the doubly linked child";
		const bTask = "Ship the release";
		writeMain([
			sessionHeaderLine("main-session", NOW - 300_000),
			toolCallLine("call-1", "coder", aTask, NOW - 120_000),
			receiptLine("call-1", `Dispatched coder. taskId: ${aId}`, NOW - 110_000),
		]);
		writeChildSession(aId, aTask, NOW - 100_000, [
			toolCallLine("call-2", "tester", bTask, NOW - 95_000),
			receiptLine("call-2", `Dispatched tester. taskId: ${bId}`, NOW - 90_000),
		]);
		writeChildrenJsonl(aId, [{ childTaskId: bId, agent: "tester", task: bTask, startedAt: NOW - 94_000, depth: 2 }]);
		writeChildSession(bId, bTask, NOW - 80_000);

		// Act: A 标为 running 触发即时扫描（新惰性契约：否则 finished 父节点不展开）
		const tree = buildSessionTree(makeDeps({ registry: runningRegistry(aId) }));

		// Assert: 只建 1 个节点，来源为 receipt（收据优先于指针）
		expect(tree).toHaveLength(1);
		expect(tree[0].children).toHaveLength(1);
		const b = tree[0].children[0];
		expect(b.taskId).toBe(bId);
		expect(b.agent).toBe("tester");
		expect(b.task).toBe(bTask);
		expect(b.linkSource).toBe("receipt");
		expect(b.depth).toBe(1);
		expect(flatten(tree).filter((n) => n.taskId === bId)).toHaveLength(1);
	});

	it("should build a single node when the exact same async receipt appears twice", () => {
		// Arrange: 同一 toolCallId 的完全相同收据行重复落盘两次（同 childUuid）
		const childId = uuid(24);
		const task = "Parse the duplicated receipt";
		const receiptText = `Dispatched coder. taskId: ${childId}`;
		writeMain([
			sessionHeaderLine("main-session", NOW - 300_000),
			toolCallLine("call-1", "coder", task, NOW - 120_000),
			receiptLine("call-1", receiptText, NOW - 110_000),
			receiptLine("call-1", receiptText, NOW - 110_000),
		]);
		writeChildSession(childId, task, NOW - 5_000);

		// Act
		const tree = buildSessionTree(makeDeps());

		// Assert: 重复收据 → 只建 1 个节点
		expect(tree).toHaveLength(1);
		const node = tree[0];
		expect(node.taskId).toBe(childId);
		expect(node.agent).toBe("coder");
		expect(node.task).toBe(task);
		expect(node.linkSource).toBe("receipt");
		expect(node.depth).toBe(0);
		expect(node.children).toHaveLength(0);
	});
});

// ================================================================
// 12. 跨 build 的解析缓存一致性
// ================================================================
describe("跨 build 的解析缓存一致性", () => {
	it("should return an identical tree on two consecutive builds over an unchanged fixture", () => {
		// Arrange: 主会话收据 → 子会话（收据）→ 孙会话，全部 mtime 显式固定
		const childId = uuid(34);
		const grandId = uuid(35);
		const task = "Stable tree fixture";
		const subTask = "Stable sub fixture";
		writeMain([
			sessionHeaderLine("main-session", NOW - 300_000),
			toolCallLine("call-1", "coder", task, NOW - 120_000),
			receiptLine("call-1", `Dispatched coder. taskId: ${childId}`, NOW - 110_000),
		]);
		writeChildSession(childId, task, NOW - 5_000, [
			toolCallLine("call-2", "tester", subTask, NOW - 4_500),
			receiptLine("call-2", `Dispatched tester. taskId: ${grandId}`, NOW - 4_000),
		]);
		writeChildSession(grandId, subTask, NOW - 3_500);

		// Act: 同一 fixture 连续两次 build
		const first = buildSessionTree(makeDeps());
		const second = buildSessionTree(makeDeps());

		// Assert: 首次非空（防空等价），两次结果逐字段一致
		expect(first).toHaveLength(1);
		expect(flatten(first)).toHaveLength(2);
		expect(second).toEqual(first);
	});

	it("should reflect an entry appended to a child session on the next build", () => {
		// Arrange: 主会话收据 → 子会话；子会话尚未派发任何任务
		const childId = uuid(36);
		const grandId = uuid(37);
		const task = "Child that will dispatch later";
		const subTask = "Grandchild appended after the first build";
		writeMain([
			sessionHeaderLine("main-session", NOW - 300_000),
			toolCallLine("call-1", "coder", task, NOW - 120_000),
			receiptLine("call-1", `Dispatched coder. taskId: ${childId}`, NOW - 110_000),
		]);
		const childFile = writeChildSession(childId, task, NOW - 5_000);

		// Act 1: 首次 build
		const first = buildSessionTree(makeDeps());

		// Assert 1: 子会话无子节点
		expect(first).toHaveLength(1);
		expect(first[0].children).toHaveLength(0);

		// Act 2: 向子会话追加一条派发（toolCall + 收据），size 变化且 mtime 显式更新
		fs.appendFileSync(
			childFile,
			[
				toolCallLine("call-2", "tester", subTask, NOW - 4_500),
				receiptLine("call-2", `Dispatched tester. taskId: ${grandId}`, NOW - 4_000),
			].join("\n") + "\n",
			"utf-8",
		);
		setMtime(childFile, NOW - 4_000);
		const second = buildSessionTree(makeDeps());

		// Assert 2: 孙节点出现（若解析缓存不按 size/mtime 失效，这里仍是空 children）
		expect(second).toHaveLength(1);
		expect(second[0].taskId).toBe(childId);
		expect(second[0].children).toHaveLength(1);
		expect(second[0].children[0].taskId).toBe(grandId);
		expect(second[0].children[0].agent).toBe("tester");
		expect(second[0].children[0].task).toBe(subTask);
		expect(second[0].children[0].depth).toBe(1);
		expect(second[0].children[0].linkSource).toBe("receipt");
	});
});

// ================================================================
// 13. 树构建不枚举 sessions 根目录（readdirSync 硬约束）
// ================================================================
describe("树构建的 readdir 成本", () => {
	it("should never readdir the sessions root when every dispatch is linked by receipt", () => {
		// Arrange: 纯 receipt fixture —— 主会话收据 → 子任务，子任务收据 → 孙任务，
		// 全部走 receipt 链接（无在飞派发）
		const childId = uuid(45);
		const grandId = uuid(46);
		const task = "Receipt-only parent task";
		const subTask = "Receipt-only child task";
		writeMain([
			sessionHeaderLine("main-session", NOW - 300_000),
			toolCallLine("call-1", "coder", task, NOW - 120_000),
			receiptLine("call-1", `Dispatched coder. taskId: ${childId}`, NOW - 110_000),
		]);
		writeChildSession(childId, task, NOW - 100_000, [
			toolCallLine("call-2", "tester", subTask, NOW - 95_000),
			receiptLine("call-2", `Dispatched tester. taskId: ${grandId}`, NOW - 90_000),
		]);
		writeChildSession(grandId, subTask, NOW - 80_000);

		// Act: 清空 readdir 观测后连续两次 build，随后立刻收集对 rootDir 的调用。
		// 父节点标 running 以触发即时扫描（新惰性契约），其余 readdir 约束不变
		const registry = runningRegistry(childId);
		const readdirSpy = vi.mocked(fs.readdirSync);
		readdirSpy.mockClear();
		const first = buildSessionTree(makeDeps({ registry }));
		const second = buildSessionTree(makeDeps({ registry }));
		const rootReaddirs = rootDirReaddirs();

		// Assert: 树非空（防空树假通过：两次 build 都真实建出了父子孙节点），
		// 且对 path === rootDir 的 readdirSync 调用次数为 0（子任务目录自身的 readdir 不计）
		expect(first).toHaveLength(1);
		expect(flatten(first)).toHaveLength(2);
		expect(first[0].linkSource).toBe("receipt");
		expect(second).toEqual(first);
		expect(rootReaddirs).toHaveLength(0);
	});

	it("should never readdir the sessions root when an in-flight dispatch is linked by a pointer", () => {
		// Arrange: 含 pointer 的在飞场景 —— 主会话 receipt → A；A 的在飞派发
		// （call-2 无收据）由 A 目录的 children.jsonl 指针建链
		const aId = uuid(47);
		const bId = uuid(48);
		const aTask = "Pointer parent task";
		const bTask = "Pointer-linked in-flight task";
		writeMain([
			sessionHeaderLine("main-session", NOW - 300_000),
			toolCallLine("call-1", "coder", aTask, NOW - 120_000),
			receiptLine("call-1", `Dispatched coder. taskId: ${aId}`, NOW - 110_000),
		]);
		writeChildSession(aId, aTask, NOW - 100_000, [toolCallLine("call-2", "tester", bTask, NOW - 95_000)]);
		writeChildrenJsonl(aId, [{ childTaskId: bId, agent: "tester", task: bTask, startedAt: NOW - 94_000, depth: 2 }]);
		writeChildSession(bId, bTask, NOW - 80_000);

		// Act: 清空 readdir 观测后 build，随后立刻收集对 rootDir 的调用。
		// A 标 running 以触发即时扫描（新惰性契约），对 rootDir 的 readdir 仍必须为 0
		const readdirSpy = vi.mocked(fs.readdirSync);
		readdirSpy.mockClear();
		const tree = buildSessionTree(makeDeps({ registry: runningRegistry(aId) }));
		const rootReaddirs = rootDirReaddirs();

		// Assert: 指针节点真实建出（防空等价），且对 rootDir 的 readdirSync 为 0
		expect(tree).toHaveLength(1);
		expect(tree[0].children).toHaveLength(1);
		expect(tree[0].children[0].taskId).toBe(bId);
		expect(tree[0].children[0].linkSource).toBe("pointer");
		expect(rootReaddirs).toHaveLength(0);
	});
});

// ================================================================
// B. 指针链接的状态判定（新优先级：不再读文件 mtime）
// ================================================================
describe("指针链接的状态判定", () => {
	it("should keep a silent but alive pointer-linked nested task running when lastEntryTs is outside the 10s window but within 10 minutes", () => {
		// Arrange (B1): 主会话收据 → A；A 的在飞派发（call-2 无收据）由 A 目录的
		// children.jsonl 指针建链；B 子会话最后条目 ts = now−60s（超出 10s recent
		// 窗口、但未超 10 分钟兜底）→ 活着但静默，必须 running
		const aId = uuid(300);
		const bId = uuid(301);
		const aTask = "Parent of the silent nested task";
		const bTask = "Silent but alive nested task";
		writeMain([
			sessionHeaderLine("main-session", NOW - 300_000),
			toolCallLine("call-1", "coder", aTask, NOW - 120_000),
			receiptLine("call-1", `Dispatched coder. taskId: ${aId}`, NOW - 110_000),
		]);
		writeChildSession(aId, aTask, NOW - 100_000, [toolCallLine("call-2", "tester", bTask, NOW - 95_000)]);
		writeChildrenJsonl(aId, [{ childTaskId: bId, agent: "tester", task: bTask, startedAt: NOW - 94_000, depth: 2 }]);
		writeChildSession(bId, bTask, NOW - 60_000);

		// Act: A 标 running 触发即时扫描（新惰性契约）
		const tree = buildSessionTree(makeDeps({ registry: runningRegistry(aId) }));

		// Assert: 有指针、无任何收据 → running；静默超 10s 也不得 finished/recent
		expect(tree).toHaveLength(1);
		expect(tree[0].children).toHaveLength(1);
		const b = tree[0].children[0];
		expect(b.taskId).toBe(bId);
		expect(b.status).toBe("running");
		expect(b.finishedAt).toBeUndefined();
	});

	it("should keep a re-dispatched child running with the newest pointer startedAt when the only sync receipt predates it", () => {
		// Arrange (B2 复用): A 目录 children.jsonl 先有一条指针
		// （startedAt = now−120s），父会话 A 里有一条早于该指针的同步收据
		// （ts = now−180s），随后又追加一行更新的指针（startedAt = now−5s，
		// readChildPointers 按 childTaskId 取最后一行）。陈旧收据不得把节点判
		// finished；节点 startedAt 必须取最新指针的 startedAt，不得用子会话
		// headerTs（now−90s）顶替
		const aId = uuid(310);
		const xId = uuid(311);
		const aTask = "Parent that reused a session id";
		const xTask = "Reused child task";
		writeMain([
			sessionHeaderLine("main-session", NOW - 600_000),
			toolCallLine("call-1", "coder", aTask, NOW - 500_000),
			receiptLine("call-1", `Dispatched coder. taskId: ${aId}`, NOW - 490_000),
		]);
		writeChildSession(aId, aTask, NOW - 450_000, [
			toolCallLine("call-2", "tester", xTask, NOW - 440_000),
			receiptLine("call-2", `Old run done.\n\n[subagent session: ${xId}]`, NOW - 180_000),
		]);
		writeChildrenJsonl(aId, [
			{ childTaskId: xId, agent: "tester", task: xTask, startedAt: NOW - 120_000, depth: 2 },
			{ childTaskId: xId, agent: "tester", task: xTask, startedAt: NOW - 5_000, depth: 2 },
		]);
		writeChildSession(xId, xTask, NOW - 90_000);

		// Act: A 标 running 触发即时扫描（新惰性契约）
		const tree = buildSessionTree(makeDeps({ registry: runningRegistry(aId) }));

		// Assert: 陈旧同步收据不得判 finished；startedAt = 最新指针行
		expect(tree).toHaveLength(1);
		expect(tree[0].children).toHaveLength(1);
		const x = tree[0].children[0];
		expect(x.taskId).toBe(xId);
		expect(x.status).toBe("running");
		expect(x.finishedAt).toBeUndefined();
		expect(x.startedAt).toBe(NOW - 5_000);
	});

	it("should mark a pointer-linked child finished at the sync receipt timestamp when the receipt postdates the newest pointer", () => {
		// Arrange (B3): 同 B2 结构（指针行 startedAt = now−120s / now−5s），但
		// 同步收据 ts = now−1s —— 晚于最新指针 startedAt → 收据是完成信号
		const aId = uuid(312);
		const xId = uuid(313);
		const aTask = "Parent awaiting the late sync receipt";
		const xTask = "Child finished after the pointer";
		const receiptTs = NOW - 1_000;
		writeMain([
			sessionHeaderLine("main-session", NOW - 600_000),
			toolCallLine("call-1", "coder", aTask, NOW - 500_000),
			receiptLine("call-1", `Dispatched coder. taskId: ${aId}`, NOW - 490_000),
		]);
		writeChildSession(aId, aTask, NOW - 450_000, [
			toolCallLine("call-2", "tester", xTask, NOW - 440_000),
			receiptLine("call-2", `Done, done.\n\n[subagent session: ${xId}]`, receiptTs),
		]);
		writeChildrenJsonl(aId, [
			{ childTaskId: xId, agent: "tester", task: xTask, startedAt: NOW - 120_000, depth: 2 },
			{ childTaskId: xId, agent: "tester", task: xTask, startedAt: NOW - 5_000, depth: 2 },
		]);
		writeChildSession(xId, xTask, NOW - 90_000);

		// Act: A 标 running 触发即时扫描（新惰性契约）
		const tree = buildSessionTree(makeDeps({ registry: runningRegistry(aId) }));

		// Assert: 晚于指针的同步收据 → finished，finishedAt = 该收据 toolResult ts
		expect(tree).toHaveLength(1);
		expect(tree[0].children).toHaveLength(1);
		const x = tree[0].children[0];
		expect(x.taskId).toBe(xId);
		expect(x.status).toBe("finished");
		expect(x.finishedAt).toBe(receiptTs);
	});

	it("should degrade a receipt-less pointer link to recent when the child lastEntryTs is older than 10 minutes", () => {
		// Arrange (B4): 指针、无任何收据、子会话最后条目 ts = now−700_000
		// （超过 10 分钟兜底）→ 降级 recent（避免真出错时永远挂 running）
		const aId = uuid(314);
		const xId = uuid(315);
		const aTask = "Parent of the long-gone pointer";
		const xTask = "Pointer target gone silent for ages";
		writeMain([
			sessionHeaderLine("main-session", NOW - 900_000),
			toolCallLine("call-1", "coder", aTask, NOW - 850_000),
			receiptLine("call-1", `Dispatched coder. taskId: ${aId}`, NOW - 840_000),
		]);
		writeChildSession(aId, aTask, NOW - 800_000, [toolCallLine("call-2", "tester", xTask, NOW - 750_000)]);
		writeChildrenJsonl(aId, [{ childTaskId: xId, agent: "tester", task: xTask, startedAt: NOW - 701_000, depth: 2 }]);
		writeChildSession(xId, xTask, NOW - 700_000);

		// Act: A 标 running 触发即时扫描（新惰性契约）
		const tree = buildSessionTree(makeDeps({ registry: runningRegistry(aId) }));

		// Assert
		expect(tree).toHaveLength(1);
		expect(tree[0].children).toHaveLength(1);
		const x = tree[0].children[0];
		expect(x.taskId).toBe(xId);
		expect(x.status).toBe("recent");
		expect(x.finishedAt).toBeUndefined();
	});

	it("should mark a depth-1 async-receipt child finished from the completedTasks record when no pointer exists", () => {
		// Arrange (B5 回归): 主会话收据 → A；A 会话异步收据 → B（A 目录无
		// children.jsonl）；completedTasks 注入 B 的完成记录
		const aId = uuid(321);
		const bId = uuid(322);
		const aTask = "Parent dispatching without pointers";
		const bTask = "Completed in this process";
		writeMain([
			sessionHeaderLine("main-session", NOW - 300_000),
			toolCallLine("call-1", "coder", aTask, NOW - 120_000),
			receiptLine("call-1", `Dispatched coder. taskId: ${aId}`, NOW - 110_000),
		]);
		writeChildSession(aId, aTask, NOW - 100_000, [
			toolCallLine("call-2", "tester", bTask, NOW - 95_000),
			receiptLine("call-2", `Dispatched tester. taskId: ${bId}`, NOW - 90_000),
		]);
		writeChildSession(bId, bTask, NOW - 5_000);
		const completedTasks = new Map([[bId, { status: "succeeded", finishedAt: NOW - 777 }]]);

		// Act: A 标 running 触发即时扫描（新惰性契约）
		const tree = buildSessionTree(makeDeps({ registry: runningRegistry(aId), completedTasks }));

		// Assert: 完成记录 → finished，finishedAt = 记录值
		expect(tree).toHaveLength(1);
		expect(tree[0].children).toHaveLength(1);
		const b = tree[0].children[0];
		expect(b.taskId).toBe(bId);
		expect(b.status).toBe("finished");
		expect(b.finishedAt).toBe(NOW - 777);
	});

	it("should not mark a node recent when the file mtime is touched to now but the last entry timestamp is old", () => {
		// Arrange (B6 背离 fixture): 条目 ts = now−300s，文件与目录 mtime 显式
		// touch 成 now —— 状态判定只看 lastEntryTs，touch mtime 不得让它变 recent
		const childId = uuid(320);
		const task = "Old entries but a fresh mtime";
		writeMain([
			sessionHeaderLine("main-session", NOW - 600_000),
			toolCallLine("call-1", "coder", task, NOW - 500_000),
			receiptLine("call-1", `Dispatched coder. taskId: ${childId}`, NOW - 490_000),
		]);
		writeChildSessionSplit(childId, task, NOW - 300_000, NOW);

		// Act
		const tree = buildSessionTree(makeDeps());

		// Assert: mtime = now 也不得判 recent；finishedAt 取条目时间戳
		expect(tree).toHaveLength(1);
		expect(tree[0].status).toBe("finished");
		expect(tree[0].finishedAt).toBe(NOW - 300_000);
	});
});

// ================================================================
// C-1. 深链旧派发的状态硬约束：异步收据 + 无同步收据 + 无指针 ⇒ pending
// ================================================================
describe("深链旧派发的状态判定（异步收据无同步收据无指针）", () => {
	it("should mark a nested legacy async-receipt dispatch pending when it has neither a sync receipt nor a pointer", () => {
		// Arrange (用例 1): 主会话收据 → P（node.depth 0）；P 会话里 subagent
		// toolCall + 异步收据派发 C（指针功能上线前的旧派发，P 目录无
		// children.jsonl）；C 子会话最后条目 ts = now−60s（10s 窗口外）→
		// 不得被「最后条目兜底」判 finished
		const pId = uuid(600);
		const cId = uuid(601);
		const pTask = "Parent dispatching the legacy nested task";
		const cTask = "Legacy nested dispatch with no pointer";
		writeMain([
			sessionHeaderLine("main-session", NOW - 300_000),
			toolCallLine("call-1", "coder", pTask, NOW - 120_000),
			receiptLine("call-1", `Dispatched coder. taskId: ${pId}`, NOW - 110_000),
		]);
		writeChildSession(pId, pTask, NOW - 100_000, [
			toolCallLine("call-2", "tester", cTask, NOW - 95_000),
			receiptLine("call-2", `Dispatched tester. taskId: ${cId}`, NOW - 90_000),
		]);
		// P 目录无 children.jsonl —— 旧派发没有任何指针
		writeChildSession(cId, cTask, NOW - 60_000);

		// Act: P 标 running 触发即时扫描（新惰性契约：finished 父节点默认不展开）
		const tree = buildSessionTree(makeDeps({ registry: runningRegistry(pId) }));

		// Assert: C 以异步收据建链（receipt），但既无同步收据也无指针 ⇒ pending，
		// 不得 finished（验收清单里的孙辈 depth ≥ 2 对应 node.depth === 1）
		expect(tree).toHaveLength(1);
		expect(tree[0].children).toHaveLength(1);
		const c = tree[0].children[0];
		expect(c.taskId).toBe(cId);
		expect(c.depth).toBe(1);
		expect(c.linkSource).toBe("receipt");
		expect(c.status).toBe("pending");
	});

	it("should keep a direct main-session async-receipt dispatch finished when its last entry is older than the window", () => {
		// Arrange (用例 2): 主会话异步收据直接派发 D、无指针、D 最后条目很旧
		// （now−60s）⇒ depth 0 兜底保持原行为 finished，新规则不得扩张到
		// 主会话直接派发层
		const dId = uuid(602);
		const dTask = "Direct legacy dispatch from the main session";
		writeMain([
			sessionHeaderLine("main-session", NOW - 300_000),
			toolCallLine("call-1", "coder", dTask, NOW - 120_000),
			receiptLine("call-1", `Dispatched coder. taskId: ${dId}`, NOW - 110_000),
		]);
		writeChildSession(dId, dTask, NOW - 60_000);

		// Act
		const tree = buildSessionTree(makeDeps());

		// Assert
		expect(tree).toHaveLength(1);
		const d = tree[0];
		expect(d.taskId).toBe(dId);
		expect(d.depth).toBe(0);
		expect(d.linkSource).toBe("receipt");
		expect(d.status).toBe("finished");
	});

	it("should keep a re-dispatched nested child running off the fresh pointer when the only sync receipt predates it", () => {
		// Arrange (用例 3): P 目录 children.jsonl 有 C 的新指针（startedAt =
		// now−5s），P 会话里只有比该指针更旧的同步收据（ts = now−180s）⇒
		// 新规则不得把「指针在飞」的复用节点判 pending/finished
		const pId = uuid(603);
		const cId = uuid(604);
		const pTask = "Parent that re-dispatched a nested child";
		const cTask = "Re-dispatched nested child";
		writeMain([
			sessionHeaderLine("main-session", NOW - 600_000),
			toolCallLine("call-1", "coder", pTask, NOW - 500_000),
			receiptLine("call-1", `Dispatched coder. taskId: ${pId}`, NOW - 490_000),
		]);
		writeChildSession(pId, pTask, NOW - 450_000, [
			toolCallLine("call-2", "tester", cTask, NOW - 440_000),
			receiptLine("call-2", `Old run done.\n\n[subagent session: ${cId}]`, NOW - 180_000),
		]);
		writeChildrenJsonl(pId, [{ childTaskId: cId, agent: "tester", task: cTask, startedAt: NOW - 5_000, depth: 2 }]);
		writeChildSession(cId, cTask, NOW - 90_000);

		// Act: P 标 running 触发即时扫描（新惰性契约）
		const tree = buildSessionTree(makeDeps({ registry: runningRegistry(pId) }));

		// Assert: 陈旧同步收据输给新指针 → 指针链接、running、startedAt 取新指针
		expect(tree).toHaveLength(1);
		expect(tree[0].children).toHaveLength(1);
		const c = tree[0].children[0];
		expect(c.taskId).toBe(cId);
		expect(c.linkSource).toBe("pointer");
		expect(c.status).toBe("running");
		expect(c.startedAt).toBe(NOW - 5_000);
	});

	it("should keep a nested receipt-linked legacy dispatch recent when its last entry is inside the 10s window", () => {
		// Arrange (用例 4): 同用例 1 形状（异步收据、无指针、无同步收据），但
		// C 最后条目 ts = now−5s（10s 窗口内）⇒ recent 窗口优先于新 pending 兜底
		const pId = uuid(605);
		const cId = uuid(606);
		const pTask = "Parent of the recently active legacy child";
		const cTask = "Legacy nested dispatch still inside the window";
		writeMain([
			sessionHeaderLine("main-session", NOW - 300_000),
			toolCallLine("call-1", "coder", pTask, NOW - 120_000),
			receiptLine("call-1", `Dispatched coder. taskId: ${pId}`, NOW - 110_000),
		]);
		writeChildSession(pId, pTask, NOW - 100_000, [
			toolCallLine("call-2", "tester", cTask, NOW - 95_000),
			receiptLine("call-2", `Dispatched tester. taskId: ${cId}`, NOW - 90_000),
		]);
		writeChildSession(cId, cTask, NOW - 5_000);

		// Act: P 标 running 触发即时扫描（新惰性契约）
		const tree = buildSessionTree(makeDeps({ registry: runningRegistry(pId) }));

		// Assert: recent（不是 pending、不是 finished）
		expect(tree).toHaveLength(1);
		expect(tree[0].children).toHaveLength(1);
		const c = tree[0].children[0];
		expect(c.taskId).toBe(cId);
		expect(c.linkSource).toBe("receipt");
		expect(c.status).toBe("recent");
		expect(c.finishedAt).toBeUndefined();
	});

	it("should keep a nested legacy dispatch finished from the completedTasks record despite having no sync receipt or pointer", () => {
		// Arrange (用例 5): 同用例 1 形状 + completedTasks 注入 C 的完成记录
		// ⇒ 完成记录是正向完成信号，优先于新 pending 兜底
		const pId = uuid(607);
		const cId = uuid(608);
		const pTask = "Parent of the in-process completed legacy child";
		const cTask = "Legacy nested dispatch completed in this process";
		writeMain([
			sessionHeaderLine("main-session", NOW - 300_000),
			toolCallLine("call-1", "coder", pTask, NOW - 120_000),
			receiptLine("call-1", `Dispatched coder. taskId: ${pId}`, NOW - 110_000),
		]);
		writeChildSession(pId, pTask, NOW - 100_000, [
			toolCallLine("call-2", "tester", cTask, NOW - 95_000),
			receiptLine("call-2", `Dispatched tester. taskId: ${cId}`, NOW - 90_000),
		]);
		writeChildSession(cId, cTask, NOW - 60_000);
		const completedTasks = new Map([[cId, { status: "succeeded", finishedAt: NOW - 777 }]]);

		// Act: P 标 running 触发即时扫描（新惰性契约）
		const tree = buildSessionTree(makeDeps({ registry: runningRegistry(pId), completedTasks }));

		// Assert: 完成记录 → finished，finishedAt = 记录值（不是 pending）
		expect(tree).toHaveLength(1);
		expect(tree[0].children).toHaveLength(1);
		const c = tree[0].children[0];
		expect(c.taskId).toBe(cId);
		expect(c.status).toBe("finished");
		expect(c.finishedAt).toBe(NOW - 777);
	});

	it("should keep a nested sync-receipt dispatch finished with the receipt timestamp when no pointer exists", () => {
		// Arrange (C 优先级链上半环回归锁 1): 主会话收据 → P（depth 0）；P 会话内
		// toolCall + 同步收据派发 C，P 目录无 children.jsonl、无 completedTasks
		// 记录、C 最后条目很旧（now−60s）⇒ depth ≥ 1 的 pending 守卫不得被误移到
		// sync 收据分支之前，同步收据仍是 finished 信号且 finishedAt = 收据 ts
		const pId = uuid(610);
		const cId = uuid(611);
		const pTask = "Parent dispatching a nested sync task";
		const cTask = "Nested sync-receipt dispatch";
		const receiptTs = NOW - 30_000;
		writeMain([
			sessionHeaderLine("main-session", NOW - 300_000),
			toolCallLine("call-1", "coder", pTask, NOW - 120_000),
			receiptLine("call-1", `Dispatched coder. taskId: ${pId}`, NOW - 110_000),
		]);
		writeChildSession(pId, pTask, NOW - 100_000, [
			toolCallLine("call-2", "tester", cTask, NOW - 95_000),
			receiptLine("call-2", `All done.\n\n[subagent session: ${cId}]`, receiptTs),
		]);
		// P 目录无 children.jsonl
		writeChildSession(cId, cTask, NOW - 60_000);

		// Act: P 标 running 触发即时扫描（新惰性契约）
		const tree = buildSessionTree(makeDeps({ registry: runningRegistry(pId) }));

		// Assert: 同步收据在孙辈层仍是完成信号 —— finished，finishedAt = 该收据
		// toolResult 行 ts（非 lastEntryTs、非 startedAt 兑底）
		expect(tree).toHaveLength(1);
		expect(tree[0].children).toHaveLength(1);
		const c = tree[0].children[0];
		expect(c.taskId).toBe(cId);
		expect(c.depth).toBe(1);
		expect(c.status).toBe("finished");
		expect(c.finishedAt).toBe(receiptTs);
	});

	it("should keep a nested legacy dispatch running when the registry lists its taskId as running", () => {
		// Arrange (C 优先级链上半环回归锁 2): 同用例 1 形状（异步收据、无指针、
		// 无同步收据、C 最后条目很旧），但 C 在 registry 里 status "running"
		// ⇒ registry 最高优先级在孙辈层同样压过 pending 守卫
		const pId = uuid(612);
		const cId = uuid(613);
		const pTask = "Parent of the registry-listed nested task";
		const cTask = "Nested task still running per the registry";
		writeMain([
			sessionHeaderLine("main-session", NOW - 300_000),
			toolCallLine("call-1", "coder", pTask, NOW - 120_000),
			receiptLine("call-1", `Dispatched coder. taskId: ${pId}`, NOW - 110_000),
		]);
		writeChildSession(pId, pTask, NOW - 100_000, [
			toolCallLine("call-2", "tester", cTask, NOW - 95_000),
			receiptLine("call-2", `Dispatched tester. taskId: ${cId}`, NOW - 90_000),
		]);
		writeChildSession(cId, cTask, NOW - 60_000);
		// P 也标 running：新惰性契约下否则 P 不展开、C 根本不会被构建；
		// C 的 running 断言仍只由 cId 自己的 registry 条目决定
		const registry = new Map([
			[pId, { status: "running" as const, agentName: "coder" }],
			[cId, { status: "running", agentName: "tester", task: cTask }],
		]);

		// Act
		const tree = buildSessionTree(makeDeps({ registry }));

		// Assert: registry running 在孙辈层同样最高优先级 → running，不带 finishedAt
		expect(tree).toHaveLength(1);
		expect(tree[0].children).toHaveLength(1);
		const c = tree[0].children[0];
		expect(c.taskId).toBe(cId);
		expect(c.depth).toBe(1);
		expect(c.status).toBe("running");
		expect(c.finishedAt).toBeUndefined();
	});
});

// ================================================================
// C. 错误结果分类（rejected / failed，最新事件胜；本轮 B：rejected/failed 节点
//    带 finishedAt = 错误 toolResult 行的 ts —— 耗时固定不随 now 累积，页面在
//    缺结束时刻时显示 "—"）
// ================================================================
describe("错误结果分类（rejected / failed）", () => {
	it("should classify a roster-rejected dispatch error as rejected with a reason and the full error text", () => {
		// Arrange: toolCall + isError:true 的派发被拒文本（无 childId）
		const errorText = `Cannot dispatch "coder". Allowed subagents: coder.`;
		writeMain([
			sessionHeaderLine("main-session", NOW - 300_000),
			toolCallLine("call-1", "coder", "Denied dispatch", NOW - 60_000),
			errorResultLine("call-1", errorText, NOW - 59_000),
		]);

		// Act
		const tree = buildSessionTree(makeDeps());

		// Assert: 单节点、rejected、taskId 为空、reason 非空、errorText 含原文
		expect(tree).toHaveLength(1);
		const node = tree[0];
		expect(node.status).toBe("rejected");
		expect(node.taskId).toBe("");
		expect(typeof node.reason).toBe("string");
		expect(node.reason.length).toBeGreaterThan(0);
		expect(node.errorText).toContain(errorText);
		// 本轮 B 契约: rejected 节点带 finishedAt = 错误 toolResult 行 ts
		// （耗时固定，不随 Date.now() 累积；红阶段需 coder 落地 errorTs）
		expect(node.finishedAt).toBe(NOW - 59_000);
	});

	it("should classify an unknown-agent dispatch error as rejected with the agent name in the reason", () => {
		// Arrange: Unknown agent 文案（带引号冒号，同 src/index.ts）
		const errorText = `Unknown agent: "coder-lite". Available agents: coder.`;
		writeMain([
			sessionHeaderLine("main-session", NOW - 300_000),
			toolCallLine("call-1", "coder-lite", "Dispatch to a missing agent", NOW - 60_000),
			errorResultLine("call-1", errorText, NOW - 59_000),
		]);

		// Act
		const tree = buildSessionTree(makeDeps());

		// Assert: rejected，reason 点名 coder-lite，errorText 含原文
		expect(tree).toHaveLength(1);
		const node = tree[0];
		expect(node.status).toBe("rejected");
		expect(node.reason).toContain("coder-lite");
		expect(node.errorText).toContain(errorText);
		// 本轮 B 契约: rejected 节点带 finishedAt = 错误 toolResult 行 ts
		expect(node.finishedAt).toBe(NOW - 59_000);
	});

	it("should classify an error result carrying a session id as failed instead of a successful sync receipt", () => {
		// Arrange: isError:true + 文本尾缀 [subagent session: <id>] —— 老的
		// SYNC_SESSION_RE 会把该 error 文本当成功同步收据（→ finished），必须判 failed
		const childId = uuid(330);
		const errorText = `boom\n\n[subagent session: ${childId}]`;
		writeMain([
			sessionHeaderLine("main-session", NOW - 300_000),
			toolCallLine("call-1", "coder", "Task that failed", NOW - 60_000),
			errorResultLine("call-1", errorText, NOW - 59_000),
		]);

		// Act
		const tree = buildSessionTree(makeDeps());

		// Assert: failed 而非 finished；childId 保留为 taskId；errorText 含原文
		expect(tree).toHaveLength(1);
		const node = tree[0];
		expect(node.status).toBe("failed");
		expect(node.status).not.toBe("finished");
		expect(node.taskId).toBe(childId);
		expect(node.errorText).toContain("boom");
		// 本轮 B 契约: failed 节点带 finishedAt = 错误 toolResult 行 ts
		expect(node.finishedAt).toBe(NOW - 59_000);
	});

	it("should classify Exit code diagnostics carrying a session id as failed", () => {
		// Arrange: 运行失败的完整诊断形状（Exit code + 会话 id 尾缀）
		const childId = uuid(331);
		const errorText = `Agent: coder (project)\nExit code: 1\nError message: boom\n\n[subagent session: ${childId}]`;
		writeMain([
			sessionHeaderLine("main-session", NOW - 300_000),
			toolCallLine("call-1", "coder", "Task with exit code diagnostics", NOW - 60_000),
			errorResultLine("call-1", errorText, NOW - 59_000),
		]);

		// Act
		const tree = buildSessionTree(makeDeps());

		// Assert: 同样判 failed（不得被同步收据正则抢走）
		expect(tree).toHaveLength(1);
		const node = tree[0];
		expect(node.status).toBe("failed");
		expect(node.taskId).toBe(childId);
		expect(node.errorText).toContain("Exit code: 1");
		// 本轮 B 契约: failed 节点带 finishedAt = 错误 toolResult 行 ts
		expect(node.finishedAt).toBe(NOW - 59_000);
	});

	it("should let a later successful sync receipt for the same child id override an earlier failed result", () => {
		// Arrange (C1): 同 id 先失败（isError + id），复用后成功同步收据（同 id）
		const childId = uuid(340);
		const errText = `boom\n\n[subagent session: ${childId}]`;
		const okText = `All good.\n\n[subagent session: ${childId}]`;
		writeMain([
			sessionHeaderLine("main-session", NOW - 600_000),
			toolCallLine("call-1", "coder", "Reused run", NOW - 300_000),
			errorResultLine("call-1", errText, NOW - 200_000),
			toolCallLine("call-2", "coder", "Reused run", NOW - 150_000),
			receiptLine("call-2", okText, NOW - 100_000),
		]);

		// Act
		const tree = buildSessionTree(makeDeps());

		// Assert: 最新事件胜 —— 单节点、finished（finishedAt = 成功收据 ts）、
		// 不残留 failed、errorText 不残留
		const nodes = flatten(tree);
		expect(nodes).toHaveLength(1);
		expect(nodes[0].taskId).toBe(childId);
		expect(nodes[0].status).toBe("finished");
		expect(nodes[0].finishedAt).toBe(NOW - 100_000);
		expect(nodes[0].errorText).toBeUndefined();
	});

	it("should let a later failed result for the same child id override an earlier successful receipt", () => {
		// Arrange (C2): 同 id 先成功收据，复用后新的 isError 结果（带同 id）
		const childId = uuid(341);
		const okText = `All good.\n\n[subagent session: ${childId}]`;
		const errText = `boom on the reuse\n\n[subagent session: ${childId}]`;
		writeMain([
			sessionHeaderLine("main-session", NOW - 600_000),
			toolCallLine("call-1", "coder", "Reused run", NOW - 300_000),
			receiptLine("call-1", okText, NOW - 250_000),
			toolCallLine("call-2", "coder", "Reused run", NOW - 150_000),
			errorResultLine("call-2", errText, NOW - 100_000),
		]);

		// Act
		const tree = buildSessionTree(makeDeps());

		// Assert: 单节点、status failed、errorText 为最新错误原文
		const nodes = flatten(tree);
		expect(nodes).toHaveLength(1);
		expect(nodes[0].taskId).toBe(childId);
		expect(nodes[0].status).toBe("failed");
		expect(nodes[0].errorText).toContain("boom on the reuse");
	});

	it("should keep exactly one node when the same child id runs twice", () => {
		// Arrange (C3): 同 id 两次成功运行（两条 toolCall + 两条同步收据）
		const childId = uuid(342);
		const okText = `All good.\n\n[subagent session: ${childId}]`;
		writeMain([
			sessionHeaderLine("main-session", NOW - 600_000),
			toolCallLine("call-1", "coder", "First run", NOW - 300_000),
			receiptLine("call-1", okText, NOW - 290_000),
			toolCallLine("call-2", "coder", "First run", NOW - 200_000),
			receiptLine("call-2", okText, NOW - 190_000),
		]);

		// Act
		const tree = buildSessionTree(makeDeps());

		// Assert: 不重复、不叠加 —— 恰 1 个节点
		const nodes = flatten(tree);
		expect(nodes).toHaveLength(1);
		expect(nodes.filter((n) => n.taskId === childId)).toHaveLength(1);
	});

	it("should emit no node at all for a failed dispatch whose error result carries no session id", () => {
		// Arrange (F 项): 三条 isError 派发结果写进同一 fixture ——
		// (1) failed 无 id：诊断含 Exit code:、无 [subagent session: <uuid>] 后缀、
		//     无收据 → 该派发不得产出任何节点（尤其不得产出 taskId:"" 的 failed 节点）；
		// (2) rejected 无 id：Cannot dispatch "..." → 回归对照，仍产出 taskId:"" rejected；
		// (3) failed 带 id：带 [subagent session: <id>] → 回归对照，仍产出保留 id 的 failed。
		const failedNoIdTask = "Failed dispatch without a session id";
		const rejectedTask = "Rejected dispatch without a session id";
		const failedWithIdTask = "Failed dispatch with a session id";
		const childId = uuid(500);
		writeMain([
			sessionHeaderLine("main-session", NOW - 300_000),
			toolCallLine("call-fail-noid", "coder", failedNoIdTask, NOW - 60_000),
			errorResultLine("call-fail-noid", "Agent: coder (project)\nExit code: 1\nError message: boom", NOW - 59_000),
			toolCallLine("call-rejected", "coder", rejectedTask, NOW - 58_000),
			errorResultLine("call-rejected", `Cannot dispatch "coder". Allowed subagents: coder.`, NOW - 57_000),
			toolCallLine("call-fail-id", "coder", failedWithIdTask, NOW - 56_000),
			errorResultLine(
				"call-fail-id",
				`Agent: coder (project)\nExit code: 1\nError message: boom\n\n[subagent session: ${childId}]`,
				NOW - 55_000,
			),
		]);

		// Act
		const tree = buildSessionTree(makeDeps());
		const nodes = flatten(tree);

		// Assert (1): failed 无 id → 该派发对应的节点不存在，也不存在 failed + 空 taskId 节点
		expect(nodes.filter((n) => n.task === failedNoIdTask)).toHaveLength(0);
		expect(nodes.filter((n) => n.status === "failed" && n.taskId === "")).toHaveLength(0);
		// 整体长度：只剩 rejected 与 failed-带 id 两个节点（兼抓 task 文本以外的残留）
		expect(nodes).toHaveLength(2);

		// Assert (2): rejected 无 id 回归 —— 仍产出恰 1 个 taskId:"" 的 rejected 节点
		const rejectedNodes = nodes.filter((n) => n.task === rejectedTask);
		expect(rejectedNodes).toHaveLength(1);
		expect(rejectedNodes[0].status).toBe("rejected");
		expect(rejectedNodes[0].taskId).toBe("");

		// Assert (3): failed 带 id 回归 —— 仍产出恰 1 个保留 childId 的 failed 节点
		const failedNodes = nodes.filter((n) => n.task === failedWithIdTask);
		expect(failedNodes).toHaveLength(1);
		expect(failedNodes[0].status).toBe("failed");
		expect(failedNodes[0].taskId).toBe(childId);
	});

	it("should leave finishedAt undefined (never 0) for rejected and failed nodes whose error result line carries no timestamp", () => {
		// Arrange（本轮回归锁）: 两条 isError 错误结果行时间戳为 0 —— 复用
		// errorResultLine 并传 ts=0：timestamp 写成 epoch ISO
		// "1970-01-01T00:00:00.000Z"，按 session-source 的 toTimestamp 语义
		// Date.parse 得 0（等价于缺时间戳行的 ts = entryTs ?? 0 兜底）。无守卫时
		// 服务端会把 finishedAt: 0 写进节点，客户端耗时列渲染冻结的 "0s" 而非 "—"。
		const rejectedTask = "Rejected dispatch on a timestamp-less error line";
		const failedTask = "Failed dispatch on a timestamp-less error line";
		const childId = uuid(600);
		writeMain([
			sessionHeaderLine("main-session", NOW - 300_000),
			toolCallLine("call-rej", "coder", rejectedTask, NOW - 60_000),
			errorResultLine("call-rej", `Cannot dispatch "coder". Allowed subagents: coder.`, 0),
			toolCallLine("call-fail", "coder", failedTask, NOW - 59_000),
			errorResultLine("call-fail", `boom\n\n[subagent session: ${childId}]`, 0),
		]);

		// Act
		const tree = buildSessionTree(makeDeps());
		const nodes = flatten(tree);

		// Assert: 两节点仍正常分类 —— rejected（空 taskId）与 failed（保留 childId）
		const rejected = nodes.filter((n) => n.task === rejectedTask);
		expect(rejected).toHaveLength(1);
		expect(rejected[0].status).toBe("rejected");
		const failed = nodes.filter((n) => n.task === failedTask);
		expect(failed).toHaveLength(1);
		expect(failed[0].status).toBe("failed");
		expect(failed[0].taskId).toBe(childId);

		// Assert（回归锁）: ts=0 的错误结果不得产出 finishedAt —— 必须为
		// undefined（页面 durationMs 返回 null → "—"），绝不为 0
		expect(rejected[0].finishedAt, "rejected node must not carry finishedAt: 0").toBeUndefined();
		expect(rejected[0].finishedAt, "rejected finishedAt must not be 0").not.toBe(0);
		expect(failed[0].finishedAt, "failed node must not carry finishedAt: 0").toBeUndefined();
		expect(failed[0].finishedAt, "failed finishedAt must not be 0").not.toBe(0);
	});
});

// ================================================================
// 分类边界：cancel / 缺 task 的 dispatch / failed 诊断含拒稿子串
// ================================================================

/** subagent toolCall 行，arguments 原样注入（cancel、缺 task 的 dispatch 等边界形状）。 */
function subagentToolCallLine(callId: string, args: Record<string, unknown>, ts: number): string {
	return JSON.stringify({
		type: "message",
		id: `msg-call-${callId}`,
		parentId: "msg-main-root",
		timestamp: iso(ts),
		message: {
			role: "assistant",
			content: [{ type: "toolCall", id: callId, name: "subagent", arguments: args }],
		},
	});
}

describe("错误结果分类边界（cancel / 缺 task / failed 含拒稿子串）", () => {
	it("should not create any node when the error result belongs to a cancel or an invalid-action call", () => {
		// Arrange: 主会话两条非派发调用的 isError 结果 ——
		// (1) action:"cancel"（带 taskId、无 task），文案为「无此运行中任务」；
		// (2) action:"schemas"（非法 action）。两者都没有真正派发出子任务，
		// 不应产生任何侧栏节点
		const cancelTarget = uuid(400);
		writeMain([
			sessionHeaderLine("main-session", NOW - 300_000),
			subagentToolCallLine("call-1", { agent: "coder", action: "cancel", taskId: cancelTarget, confirm: true }, NOW - 60_000),
			errorResultLine("call-1", `No running subagent task with this id: ${cancelTarget}.`, NOW - 59_000),
			subagentToolCallLine("call-2", { agent: "coder", action: "schemas" }, NOW - 58_000),
			errorResultLine("call-2", `Invalid action: "schemas". Must be one of "dispatch" (default), "cancel".`, NOW - 57_000),
		]);

		// Act
		const tree = buildSessionTree(makeDeps());

		// Assert: 整棵树为空 —— 非派发 action 的错误结果不产生任何节点
		expect(flatten(tree)).toHaveLength(0);
	});

	it("should not create any node for a cancel call that carries a non-empty task parameter", () => {
		// Arrange: action:"cancel" 且 arguments 里带非空 task（LLM 冗余传参），
		// 无 toolResult —— unknown 回退只检查 call.task 非空会误产出 pending 节点
		const cancelTarget = uuid(401);
		writeMain([
			sessionHeaderLine("main-session", NOW - 300_000),
			subagentToolCallLine(
				"call-1",
				{ agent: "coder", action: "cancel", taskId: cancelTarget, task: "some task text" },
				NOW - 60_000,
			),
		]);

		// Act
		const tree = buildSessionTree(makeDeps());

		// Assert: 整棵树为空（cancel 不是派发，不产生任何节点）
		expect(flatten(tree)).toHaveLength(0);
	});

	it("should keep a result-less plain dispatch visible as a single pending node", () => {
		// Arrange: 正常 action:"dispatch"、有非空 task、无结果 —— 门禁只挡非派发
		// action，不得误伤正常派发的等待态
		writeMain([
			sessionHeaderLine("main-session", NOW - 300_000),
			subagentToolCallLine("call-1", { agent: "coder", action: "dispatch", task: "real task" }, NOW - 60_000),
		]);

		// Act
		const tree = buildSessionTree(makeDeps());

		// Assert: 恰 1 个 pending 节点
		const nodes = flatten(tree);
		expect(nodes).toHaveLength(1);
		expect(nodes[0].status).toBe("pending");
	});

	it("should create a rejected node with an empty taskId when a dispatch is missing the required task parameter", () => {
		// Arrange: action:"dispatch" 但缺 task 参数 + 派发门禁的缺参错误文案
		const errorText = `Missing or empty required parameter: "task".`;
		writeMain([
			sessionHeaderLine("main-session", NOW - 300_000),
			subagentToolCallLine("call-1", { agent: "coder", action: "dispatch" }, NOW - 60_000),
			errorResultLine("call-1", errorText, NOW - 59_000),
		]);

		// Act
		const tree = buildSessionTree(makeDeps());

		// Assert: 恰一个 rejected 节点，taskId 为空，errorText 含原文
		const rejected = flatten(tree).filter((n) => n.status === "rejected");
		expect(rejected).toHaveLength(1);
		expect(rejected[0].taskId).toBe("");
		expect(rejected[0].errorText).toContain(errorText);
	});

	it("should keep a failed result as failed when its diagnostics echo an already-running rejection substring", () => {
		// Arrange: 运行失败诊断同时含 "is already running" 子串（如子进程 stderr
		// 回显）与 [subagent session: <id>] 尾缀 —— 有 childId/诊断 ⇒ failed，
		// 不得被 rejected 门禁文案抢走
		const childId = uuid(402);
		const errorText = `Agent: coder (project)\nExit code: 1\nStderr:\nA background subagent task is already running\n\n[subagent session: ${childId}]`;
		writeMain([
			sessionHeaderLine("main-session", NOW - 300_000),
			toolCallLine("call-1", "coder", "Task whose diagnostics echo a rejection", NOW - 60_000),
			errorResultLine("call-1", errorText, NOW - 59_000),
		]);

		// Act
		const tree = buildSessionTree(makeDeps());

		// Assert: status failed（不是 rejected），childId 保留为 taskId
		const nodes = flatten(tree);
		expect(nodes).toHaveLength(1);
		expect(nodes[0].status).toBe("failed");
		expect(nodes[0].taskId).toBe(childId);
	});
});

// ================================================================
// 第7 轮新契约 A：预算分层 + 截断保留最新
// ================================================================
describe("预算分层与截断保留最新", () => {
	it("should report a zeroed TruncationInfo when the main session holds no dispatches", () => {
		// Arrange: 只有会话头、没有任何派发
		writeMain([sessionHeaderLine("main-session", NOW - 300_000)]);

		// Act
		const result = buildSessionTreeResult(makeDeps());

		// Assert: 未截断时三值字段也必须存在且归零
		expect(result.nodes).toEqual([]);
		expect(result.truncated).toEqual({ total: 0, showing: 0, dropped: 0 });
	});

	it("should drop the 50 oldest top-level dispatches beyond the 1000 budget and keep the newest 1000 in startedAt order", () => {
		// Arrange: 1050 个顶层异步派发（无子目录 → startedAt 回落到严格递增的 call.ts）
		const TOTAL = 1050;
		writeMain([
			sessionHeaderLine("main-session", NOW - 3_000_000),
			...dispatchLines(TOTAL, "task", NOW - 2_000_000, 1_000, 70_000),
		]);

		// Act
		const result = buildSessionTreeResult(makeDeps());

		// Assert: 截断三值精确；保留的是 startedAt 最新的 1000 个（最旧 50 个被丢）
		expect(result.truncated).toEqual({ total: 1050, showing: 1000, dropped: 50 });
		expect(result.nodes).toHaveLength(1000);
		expect(result.nodes.map((n) => n.task)).toEqual(
			Array.from({ length: 1000 }, (_, i) => `task ${50 + i}`),
		);
		// 最新任务绝不消失：最后一个派发仍在末位
		expect(result.nodes[999].task).toBe("task 1049");
		// 返回顺序仍按 startedAt 升序（旧 → 新）
		const startedAts = result.nodes.map((n) => n.startedAt);
		expect([...startedAts].sort((a, b) => a - b)).toEqual(startedAts);
	});

	it("should truncate a child list to the newest 200 of 250 dispatches under that node", () => {
		// Arrange: 主会话只派发 P；P 会话里派发 250 个孙任务（孙目录齐全，
		// startedAt 取各自会话头，严格递增）；P 的最后条目落在 recent 窗口内
		// → 新惰性契约下 P 被即时扫描
		const pId = uuid(80_000);
		const CHILDREN = 250;
		for (let i = 0; i < CHILDREN; i++) {
			writeChildSession(uuid(80_100 + i), `grand ${i}`, NOW - 900_000 + i * 1_000);
		}
		writeMain([
			sessionHeaderLine("main-session", NOW - 5_000_000),
			toolCallLine("call-p", "coder", "parent with many children", NOW - 4_600),
			receiptLine("call-p", `Dispatched coder. taskId: ${pId}`, NOW - 4_590),
		]);
		const pLines = dispatchLines(CHILDREN, "grand", NOW - 4_500, 1, 80_100, "tester");
		writeChildSession(pId, "parent with many children", NOW - 4_500, pLines);

		// Act
		const tree = buildSessionTree(makeDeps());
		const p = tree[0];

		// Assert: 子列表 250 → 200，丢最旧 50 个、保最新；顺序仍按 startedAt 升序
		expect(p.taskId).toBe(pId);
		expect(p.status).toBe("recent");
		expect(p.children).toHaveLength(200);
		expect(p.children.map((c) => c.task)).toEqual(
			Array.from({ length: 200 }, (_, i) => `grand ${50 + i}`),
		);
		expect(p.children[0].startedAt).toBe(NOW - 900_000 + 50 * 1_000);
		// 已扫描节点：childCount = children.length，childSummary 走 tree-view 真值函数
		expect(p.childCount).toBe(200);
		expect(p.childSummary).toBe("200 children · 200 pending");
	});

	it("should not let child nodes consume the top-level budget", () => {
		// Arrange: 顶层 250 个派发（P + 249 个普通派发），P 自己又派发 250 个孙任务。
		// 旧全局 MAX_NODES=200：P 的孙列表会吃光名额、顶层只剩 1 个；
		// 新契约两层预算互不占用
		const pId = uuid(90_000);
		// P：会话头很旧（startedAt 最旧，排序稳定在首位），但派发行落在 recent
		// 窗口内（lastEntryTs = NOW−7009）→ P 被即时扫描
		writeChildSessionSplit(
			pId,
			"top parent",
			NOW - 3_000_000,
			NOW - 3_000_000,
			dispatchLines(250, "grand", NOW - 9_500, 10, 90_100),
		);
		const lines = [sessionHeaderLine("main-session", NOW - 4_000_000)];
		lines.push(toolCallLine("call-p", "coder", "top parent", NOW - 3_000_100));
		lines.push(receiptLine("call-p", `Dispatched coder. taskId: ${pId}`, NOW - 3_000_090));
		for (let i = 1; i < 250; i++) {
			const ts = NOW - 2_000_000 + i * 1_000;
			lines.push(toolCallLine(`top-${i}`, "coder", `top ${i}`, ts));
			lines.push(receiptLine(`top-${i}`, `Dispatched coder. taskId: ${uuid(91_000 + i)}`, ts + 1));
		}
		writeMain(lines);

		// Act
		const result = buildSessionTreeResult(makeDeps());

		// Assert: 孙列表不占顶层名额 —— 顶层 250 全留，P 的子列表独立截到 200
		expect(result.truncated).toEqual({ total: 250, showing: 250, dropped: 0 });
		expect(result.nodes).toHaveLength(250);
		expect(result.nodes[0].taskId).toBe(pId);
		expect(result.nodes[0].status).toBe("recent");
		expect(result.nodes[0].children).toHaveLength(200);
		expect(result.nodes[0].children.map((c) => c.task)).toEqual(
			Array.from({ length: 200 }, (_, i) => `grand ${50 + i}`),
		);
	});
});

// ================================================================
// 第7 轮新契约 B：惰性子树扫描
// ================================================================
describe("惰性子树扫描", () => {
	/** 主会话收据 → P；P 目录含 children.jsonl 指针 → g1/g2（各自会话齐全）。 */
	function writeFinishedParentFixture(): { pId: string; g1: string; g2: string } {
		const pId = uuid(100_000);
		const g1 = uuid(100_001);
		const g2 = uuid(100_002);
		writeMain([
			sessionHeaderLine("main-session", NOW - 300_000),
			toolCallLine("call-1", "coder", "finished parent task", NOW - 120_000),
			receiptLine("call-1", `Dispatched coder. taskId: ${pId}`, NOW - 110_000),
		]);
		// P 最后条目 NOW−600s → finished（新契约默认不扫子节点）
		writeChildSession(pId, "finished parent task", NOW - 600_000);
		writeChildrenJsonl(pId, [
			{ childTaskId: g1, agent: "tester", task: "pointer child one", startedAt: NOW - 500_000, depth: 2 },
			{ childTaskId: g2, agent: "tester", task: "pointer child two", startedAt: NOW - 490_000, depth: 2 },
		]);
		writeChildSession(g1, "pointer child one", NOW - 60_000);
		writeChildSession(g2, "pointer child two", NOW - 60_000);
		return { pId, g1, g2 };
	}

	it("should skip a finished node's child scan and fill childCount/childSummary from the children.jsonl pointers", () => {
		// Arrange
		const { pId, g1, g2 } = writeFinishedParentFixture();
		const gDirs = [path.join(rootDir, g1), path.join(rootDir, g2)];

		// Act: 清空 readdir 观测后 build
		vi.mocked(fs.readdirSync).mockClear();
		const tree = buildSessionTree(makeDeps());
		const p = tree[0];

		// Assert: finished 父节点不展开；childCount 取指针条数、文案为 all finished
		expect(p.taskId).toBe(pId);
		expect(p.status).toBe("finished");
		expect(p.children).toEqual([]);
		expect(p.childCount).toBe(2);
		expect(p.childSummary).toBe("2 children · all finished");
		// 惰性硬证据：两个子目录一次都没被 readdir（子目录会话存在却未被扫描）
		expect(readdirsOf(gDirs)).toBe(0);
	});

	it("should scan a running node's children immediately and derive childCount/childSummary from the scanned list", () => {
		// Arrange: 同一 fixture，仅把 P 标为 running
		const { pId, g1, g2 } = writeFinishedParentFixture();
		const gDirs = [path.join(rootDir, g1), path.join(rootDir, g2)];

		// Act: 清空 readdir 观测后 build
		vi.mocked(fs.readdirSync).mockClear();
		const tree = buildSessionTree(makeDeps({ registry: runningRegistry(pId) }));
		const p = tree[0];

		// Assert: running 父节点即时展开，指针链与状态如实可见
		expect(p.status).toBe("running");
		expect(p.children.map((c) => [c.taskId, c.linkSource, c.depth])).toEqual([
			[g1, "pointer", 1],
			[g2, "pointer", 1],
		]);
		expect(p.children.every((c) => c.status === "running")).toBe(true);
		expect(p.childCount).toBe(2);
		expect(p.childSummary).toBe("2 children · 2 running");
		// 扫描的硬证据：两个子目录各被 readdir 恰一次（建立各自的会话文件信息）
		expect(readdirsOf(gDirs)).toBe(2);
	});

	it("should report childCount 0 and an empty childSummary for a finished node without a session directory", () => {
		// Arrange: 收据指向的子目录不存在 → 无 children.jsonl 可读
		const childId = uuid(101_000);
		writeMain([
			sessionHeaderLine("main-session", NOW - 300_000),
			toolCallLine("call-1", "coder", "dir-less task", NOW - 120_000),
			receiptLine("call-1", `Dispatched coder. taskId: ${childId}`, NOW - 110_000),
		]);

		// Act
		const tree = buildSessionTree(makeDeps());
		const node = tree[0];

		// Assert: 无目录 → childCount 0、childSummary 空串（必填字段仍存在）
		expect(node.status).toBe("finished");
		expect(node.children).toEqual([]);
		expect(node.childCount).toBe(0);
		expect(node.childSummary).toBe("");
	});
});

// ================================================================
// 第7 轮新契约 B-孤儿保护：异常收尾的父节点强制扫描
// ================================================================
describe("异常收尾父节点的孤儿保护", () => {
	it("should force-scan a finished parent whose own session ended without a result for its last subagent call", () => {
		// Arrange: P 被判 finished（最后条目 NOW−500s），但 P 会话里最后一个
		// subagent toolCall 没有对应 toolResult（异常收尾）；指针指向在飞孙会话
		const pId = uuid(102_000);
		const gId = uuid(102_001);
		writeMain([
			sessionHeaderLine("main-session", NOW - 300_000),
			toolCallLine("call-1", "coder", "abandoned parent task", NOW - 120_000),
			receiptLine("call-1", `Dispatched coder. taskId: ${pId}`, NOW - 110_000),
		]);
		writeChildSession(pId, "abandoned parent task", NOW - 500_000, [
			toolCallLine("p-call", "tester", "orphan child task", NOW - 500_000),
		]);
		writeChildrenJsonl(pId, [
			{ childTaskId: gId, agent: "tester", task: "orphan child task", startedAt: NOW - 100_000, depth: 2 },
		]);
		writeChildSession(gId, "orphan child task", NOW - 2_000);

		// Act
		const tree = buildSessionTree(makeDeps());
		const p = tree[0];

		// Assert: finished 但异常收尾 → 强制扫描；在飞孙会话如实显示 running
		expect(p.status).toBe("finished");
		expect(p.children).toHaveLength(1);
		const g = p.children[0];
		expect(g.taskId).toBe(gId);
		expect(g.linkSource).toBe("pointer");
		expect(g.depth).toBe(1);
		expect(g.status).toBe("running");
		expect(p.childCount).toBe(1);
		expect(p.childSummary).toBe("1 child · 1 running");
	});

	it("should keep a normally finished parent lazy and report the pointer count instead", () => {
		// Arrange: 对照 —— 同一形状，但 P 会话的最后一个 subagent toolCall 有结果
		//（正常收尾）→ 维持惰性
		const pId = uuid(102_100);
		const gId = uuid(102_101);
		writeMain([
			sessionHeaderLine("main-session", NOW - 300_000),
			toolCallLine("call-1", "coder", "normally finished parent task", NOW - 120_000),
			receiptLine("call-1", `Dispatched coder. taskId: ${pId}`, NOW - 110_000),
		]);
		writeChildSession(pId, "normally finished parent task", NOW - 500_000, [
			toolCallLine("p-call", "tester", "finished child task", NOW - 500_000),
			receiptLine("p-call", `Dispatched tester. taskId: ${gId}`, NOW - 499_000),
		]);
		writeChildrenJsonl(pId, [
			{ childTaskId: gId, agent: "tester", task: "finished child task", startedAt: NOW - 490_000, depth: 2 },
		]);
		writeChildSession(gId, "finished child task", NOW - 60_000);

		// Act
		const tree = buildSessionTree(makeDeps());
		const p = tree[0];

		// Assert: 正常收尾 → 不展开，childCount 取指针条数、文案 all finished
		expect(p.status).toBe("finished");
		expect(p.children).toEqual([]);
		expect(p.childCount).toBe(1);
		expect(p.childSummary).toBe("1 child · all finished");
	});
});

// ================================================================
// 第7 轮新契约：buildSubtree 显式展开 + 缓存
// ================================================================
describe("buildSubtree（显式展开子树）", () => {
	it("should return the node's direct children with depth based at 1", () => {
		// Arrange: 主会话收据 → P（finished，主树惰性不展开）；P 会话两条派发收据
		const pId = uuid(103_000);
		const g1 = uuid(103_001);
		const g2 = uuid(103_002);
		writeMain([
			sessionHeaderLine("main-session", NOW - 300_000),
			toolCallLine("call-1", "coder", "subtree parent", NOW - 120_000),
			receiptLine("call-1", `Dispatched coder. taskId: ${pId}`, NOW - 110_000),
		]);
		const pFile = writeChildSession(pId, "subtree parent", NOW - 600_000, [
			toolCallLine("g-call-1", "tester", "first grandchild", NOW - 500_000),
			receiptLine("g-call-1", `Dispatched tester. taskId: ${g1}`, NOW - 499_000),
			toolCallLine("g-call-2", "tester", "second grandchild", NOW - 480_000),
			receiptLine("g-call-2", `Dispatched tester. taskId: ${g2}`, NOW - 479_000),
		]);
		writeChildSession(g1, "first grandchild", NOW - 60_000);
		writeChildSession(g2, "second grandchild", NOW - 60_000);

		// Act
		const children = buildSubtree({
			rootDir,
			registry: new Map(),
			now: NOW,
			sessionDir: path.join(rootDir, pId),
			sessionFile: pFile,
		});

		// Assert: 直属子节点、depth 以 1 为基准、叶子的 childCount/childSummary 就位
		expect(children).toHaveLength(2);
		expect(children.map((c) => c.taskId)).toEqual([g1, g2]);
		expect(children.map((c) => c.depth)).toEqual([1, 1]);
		expect(children[0].agent).toBe("tester");
		expect(children[0].task).toBe("first grandchild");
		expect(children[0].childCount).toBe(0);
		expect(children[0].childSummary).toBe("");
	});

	it("should serve a repeated buildSubtree from cache without re-scanning when files are unchanged", () => {
		// Arrange: 同上形状的单子 fixture
		const pId = uuid(104_000);
		const g1 = uuid(104_001);
		writeMain([
			sessionHeaderLine("main-session", NOW - 300_000),
			toolCallLine("call-1", "coder", "cached subtree parent", NOW - 120_000),
			receiptLine("call-1", `Dispatched coder. taskId: ${pId}`, NOW - 110_000),
		]);
		const pFile = writeChildSession(pId, "cached subtree parent", NOW - 600_000, [
			toolCallLine("g-call", "tester", "cached grandchild", NOW - 500_000),
			receiptLine("g-call", `Dispatched tester. taskId: ${g1}`, NOW - 499_000),
		]);
		writeChildSession(g1, "cached grandchild", NOW - 60_000);
		const deps = {
			rootDir,
			registry: new Map<string, { status?: string; agentName?: string; task?: string }>(),
			now: NOW,
			sessionDir: path.join(rootDir, pId),
			sessionFile: pFile,
		};
		const gDir = path.join(rootDir, g1);

		// Act 1: 清缓存 + 清 readdir 观测后首次展开
		resetSubtreeCacheForTests();
		vi.mocked(fs.readdirSync).mockClear();
		const first = buildSubtree(deps);
		const firstReaddirs = readdirsOf([gDir]);

		// Assert 1: 首次确实扫描了子目录（防空等价）
		expect(first).toHaveLength(1);
		expect(first[0].taskId).toBe(g1);
		expect(firstReaddirs).toBe(1);

		// Act 2: 文件未变，清空观测后再次展开同一子树
		vi.mocked(fs.readdirSync).mockClear();
		const second = buildSubtree(deps);

		// Assert 2: 缓存命中 —— 子目录 readdir 次数不增，结果逐字段一致
		expect(readdirsOf([gDir])).toBe(0);
		expect(second).toEqual(first);
	});

	it("should rescan the subtree after resetSubtreeCacheForTests()", () => {
		// Arrange: 复用单子 fixture 形状
		const pId = uuid(104_100);
		const g1 = uuid(104_101);
		writeMain([
			sessionHeaderLine("main-session", NOW - 300_000),
			toolCallLine("call-1", "coder", "reset subtree parent", NOW - 120_000),
			receiptLine("call-1", `Dispatched coder. taskId: ${pId}`, NOW - 110_000),
		]);
		const pFile = writeChildSession(pId, "reset subtree parent", NOW - 600_000, [
			toolCallLine("g-call", "tester", "reset grandchild", NOW - 500_000),
			receiptLine("g-call", `Dispatched tester. taskId: ${g1}`, NOW - 499_000),
		]);
		writeChildSession(g1, "reset grandchild", NOW - 60_000);
		const deps = {
			rootDir,
			registry: new Map<string, { status?: string; agentName?: string; task?: string }>(),
			now: NOW,
			sessionDir: path.join(rootDir, pId),
			sessionFile: pFile,
		};
		const gDir = path.join(rootDir, g1);

		// Act 1: 首次展开（填充缓存）
		resetSubtreeCacheForTests();
		const first = buildSubtree(deps);

		// Act 2: 清缓存 + 清观测后再次展开
		resetSubtreeCacheForTests();
		vi.mocked(fs.readdirSync).mockClear();
		const rescanned = buildSubtree(deps);

		// Assert: 清缓存后必须重新扫描（子目录 readdir 恢复），结果不变
		expect(readdirsOf([gDir])).toBe(1);
		expect(rescanned).toEqual(first);
	});

	it("should rescan the subtree when children.jsonl changed", () => {
		// Arrange: P 会话一条收据派发 → g1；初始无 children.jsonl
		const pId = uuid(104_200);
		const g1 = uuid(104_201);
		const g2 = uuid(104_202);
		writeMain([
			sessionHeaderLine("main-session", NOW - 300_000),
			toolCallLine("call-1", "coder", "sidecar subtree parent", NOW - 120_000),
			receiptLine("call-1", `Dispatched coder. taskId: ${pId}`, NOW - 110_000),
		]);
		const pFile = writeChildSession(pId, "sidecar subtree parent", NOW - 600_000, [
			toolCallLine("g-call", "tester", "receipt grandchild", NOW - 500_000),
			receiptLine("g-call", `Dispatched tester. taskId: ${g1}`, NOW - 499_000),
		]);
		writeChildSession(g1, "receipt grandchild", NOW - 60_000);
		const deps = {
			rootDir,
			registry: new Map<string, { status?: string; agentName?: string; task?: string }>(),
			now: NOW,
			sessionDir: path.join(rootDir, pId),
			sessionFile: pFile,
		};

		// Act 1: 首次展开（缓存里只有收据子节点）
		resetSubtreeCacheForTests();
		const first = buildSubtree(deps);
		expect(first.map((c) => c.taskId)).toEqual([g1]);

		// Act 2: 追加 children.jsonl 指针（size/mtime 变化）后再次展开
		writeChildrenJsonl(pId, [
			{ childTaskId: g2, agent: "tester", task: "pointer grandchild", startedAt: NOW - 480_000, depth: 2 },
		]);
		writeChildSession(g2, "pointer grandchild", NOW - 60_000);
		vi.mocked(fs.readdirSync).mockClear();
		const second = buildSubtree(deps);

		// Assert: sidecar 参与缓存键 —— 新指针子节点出现，且子目录被重扫
		expect(second.map((c) => c.taskId)).toEqual([g1, g2]);
		expect(second[1].linkSource).toBe("pointer");
		expect(readdirsOf([path.join(rootDir, g1)])).toBe(1);
	});

	it("should keep hitting the cache for a now advance within the same coarse bucket", () => {
		// Arrange: P 会话仅会话头 + children.jsonl 指针链接 g；g 最后条目
		// ts = NOW−60_000（now=NOW 时在 10 分钟指针陈旧窗内 → running）。NOW 是
		// 10_000 的整数倍，桶边界（5s/10s 档）对齐，now+1_000 必同桶
		const pId = uuid(104_300);
		const gId = uuid(104_301);
		const pFile = writeChildSession(pId, "now-bucket parent", NOW - 600_000);
		writeChildrenJsonl(pId, [
			{ childTaskId: gId, agent: "tester", task: "pointer grandchild", startedAt: NOW - 590_000, depth: 2 },
		]);
		writeChildSession(gId, "pointer grandchild", NOW - 60_000);
		const base = {
			rootDir,
			registry: new Map<string, { status?: string; agentName?: string; task?: string }>(),
			sessionDir: path.join(rootDir, pId),
			sessionFile: pFile,
		};
		const gDir = path.join(rootDir, gId);

		// Act 1: 清缓存 + 清观测后首次展开（now = NOW）
		resetSubtreeCacheForTests();
		vi.mocked(fs.readdirSync).mockClear();
		const first = buildSubtree({ ...base, now: NOW });
		expect(first).toHaveLength(1);
		expect(first[0].taskId).toBe(gId);
		expect(first[0].status).toBe("running");
		expect(readdirsOf([gDir])).toBe(1);

		// Act 2: now 推进 1s（同粗桶内），清观测后再次展开
		vi.mocked(fs.readdirSync).mockClear();
		const second = buildSubtree({ ...base, now: NOW + 1_000 });

		// Assert: 同桶仍命中缓存 —— 子目录 readdir 不增，结果与首次一致
		expect(readdirsOf([gDir])).toBe(0);
		expect(second).toEqual(first);
	});

	it("should rescan the subtree when now advances past the coarse bucket so a time-driven status change takes effect", () => {
		// Arrange: 同上指针夹具；纯时间推进（文件全部未变）必须让指针降级
		// 生效 —— 缓存键需并入 now 的粗粒度桶（如 5s/10s），否则降级在缓存中
		// 永不发生。NOW 为 10_000 整数倍，now+700_000 必跨任何 5s/10s 档
		const pId = uuid(104_400);
		const gId = uuid(104_401);
		const pFile = writeChildSession(pId, "now-bucket stale parent", NOW - 600_000);
		writeChildrenJsonl(pId, [
			{ childTaskId: gId, agent: "tester", task: "stale pointer grandchild", startedAt: NOW - 590_000, depth: 2 },
		]);
		writeChildSession(gId, "stale pointer grandchild", NOW - 60_000);
		const base = {
			rootDir,
			registry: new Map<string, { status?: string; agentName?: string; task?: string }>(),
			sessionDir: path.join(rootDir, pId),
			sessionFile: pFile,
		};
		const gDir = path.join(rootDir, gId);

		// Act 1: 首次展开（now = NOW —— 静默 60s，未超 10 分钟指针陈旧窗）
		resetSubtreeCacheForTests();
		vi.mocked(fs.readdirSync).mockClear();
		const first = buildSubtree({ ...base, now: NOW });
		expect(first).toHaveLength(1);
		expect(first[0].status).toBe("running");
		expect(readdirsOf([gDir])).toBe(1);

		// Act 2: 文件全部未变，仅 now 推进 700s（静默累计 760s > 600s）
		vi.mocked(fs.readdirSync).mockClear();
		const second = buildSubtree({ ...base, now: NOW + 700_000 });

		// Assert: 跨桶必须重新扫描（子目录 readdir 恢复），且结果反映新 now：
		// 指针降级 running → recent（旧实现命中旧缓存 → readdir 0 且仍 running）
		expect(readdirsOf([gDir])).toBe(1);
		expect(second[0].status).toBe("recent");
		expect(second[0].finishedAt).toBeUndefined();
	});

	it("should rescan the cached subtree when a grandchild session file changes within the same now bucket", () => {
		// Arrange: P 会话仅会话头 + children.jsonl 指针链接孙任务 G（同 now 桶夹具
		// 沿用本组「now 推进同桶」两例）；P 文件 / children.jsonl / registry /
		// now 全程不变 —— 旧缓存键（sessionFile + children.jsonl stat + registry +
		// completedTasks + floor(now/5000)）在两次展开间必然同键。G 最后条目
		// ts = NOW−60_000（指针在飞、静默 60s < 10min 陈旧窗 → running）。
		const pId = uuid(104_500);
		const gId = uuid(104_501);
		const pFile = writeChildSession(pId, "grandchild-change parent", NOW - 600_000);
		writeChildrenJsonl(pId, [
			{ childTaskId: gId, agent: "tester", task: "changing grandchild", startedAt: NOW - 590_000, depth: 2 },
		]);
		const gFile = writeChildSession(gId, "changing grandchild", NOW - 60_000);
		const deps = {
			rootDir,
			registry: new Map<string, { status?: string; agentName?: string; task?: string }>(),
			now: NOW,
			sessionDir: path.join(rootDir, pId),
			sessionFile: pFile,
		};
		const gDir = path.join(rootDir, gId);

		// Act 1: 清缓存 + 清 readdir 观测后首次展开（now = NOW）
		resetSubtreeCacheForTests();
		vi.mocked(fs.readdirSync).mockClear();
		const first = buildSubtree(deps);

		// Assert 1: 首次确实扫描 G 的子目录，且指针链接判 running
		expect(first).toHaveLength(1);
		expect(first[0].taskId).toBe(gId);
		expect(first[0].status).toBe("running");
		expect(readdirsOf([gDir])).toBe(1);

		// Act 2: 只改写 G 的会话文件内容 —— 条目 ts 变为 NOW−700_000（静默 700s
		// 超 10min 指针陈旧窗），显式 setMtime 保证 size:mtime 指纹变化；
		// P 会话文件、children.jsonl、registry、now（同一 5s 桶）全部不动
		fs.writeFileSync(
			gFile,
			childSessionLines(gId, "changing grandchild", NOW - 700_000).join("\n") + "\n",
			"utf-8",
		);
		setMtime(gFile, NOW - 50_000);
		vi.mocked(fs.readdirSync).mockClear();
		const second = buildSubtree(deps);

		// Assert 2: 子孙会话文件变化必须失效缓存 —— 结果反映 G 的新状态
		// （running → recent），且子目录确实被重扫（旧实现命中陈旧缓存 →
		// 仍 running、readdir 0）
		expect(second[0].status).toBe("recent");
		expect(readdirsOf([gDir])).toBeGreaterThan(0);
	});

	it("should rescan when a direct child session file changes within the same bucket", () => {
		// Arrange: P 会话 toolCall + 异步收据直连子任务 G（无指针）；G 最后条目
		// ts = NOW−60_000：depth ≥ 1 且无同步收据/指针/completedTasks、又在
		// 10s recent 窗外 → pending。同桶内 P 文件与 now 均不变，旧键必同键。
		const pId = uuid(104_600);
		const gId = uuid(104_601);
		writeMain([
			sessionHeaderLine("main-session", NOW - 300_000),
			toolCallLine("call-1", "coder", "direct child change parent", NOW - 120_000),
			receiptLine("call-1", `Dispatched coder. taskId: ${pId}`, NOW - 110_000),
		]);
		const pFile = writeChildSession(pId, "direct child change parent", NOW - 600_000, [
			toolCallLine("g-call", "tester", "direct child", NOW - 500_000),
			receiptLine("g-call", `Dispatched tester. taskId: ${gId}`, NOW - 499_000),
		]);
		const gFile = writeChildSession(gId, "direct child", NOW - 60_000);
		const deps = {
			rootDir,
			registry: new Map<string, { status?: string; agentName?: string; task?: string }>(),
			now: NOW,
			sessionDir: path.join(rootDir, pId),
			sessionFile: pFile,
		};
		const gDir = path.join(rootDir, gId);

		// Act 1: 清缓存 + 清 readdir 观测后首次展开（now = NOW）
		resetSubtreeCacheForTests();
		vi.mocked(fs.readdirSync).mockClear();
		const first = buildSubtree(deps);

		// Assert 1: 首次扫描 G 的子目录，收据直连且无完成信号 → pending
		expect(first).toHaveLength(1);
		expect(first[0].taskId).toBe(gId);
		expect(first[0].status).toBe("pending");
		expect(readdirsOf([gDir])).toBe(1);

		// Act 2: 只改写 G 的会话文件内容 —— 条目 ts 变为 NOW−5_000（落入
		// [now−10_000, now] recent 窗口），P 文件 / registry / now 不变
		fs.writeFileSync(
			gFile,
			childSessionLines(gId, "direct child", NOW - 5_000).join("\n") + "\n",
			"utf-8",
		);
		setMtime(gFile, NOW - 50_000);
		vi.mocked(fs.readdirSync).mockClear();
		const second = buildSubtree(deps);

		// Assert 2: 直连子任务会话文件变化必须失效缓存 —— 结果反映新状态
		// （pending → recent），且子目录确实被重扫（旧实现命中陈旧缓存 →
		// 仍 pending、readdir 0）
		expect(second[0].status).toBe("recent");
		expect(readdirsOf([gDir])).toBeGreaterThan(0);
	});
});

// ================================================================
// 第7 轮新契约 C：task 文本截断（TASK_TEXT_MAX = 200）
// ================================================================
describe("task 文本截断（TASK_TEXT_MAX = 200）", () => {
	it("should truncate a 250-character task to its first 200 characters and mark taskTruncated", () => {
		// Arrange: 250 字符的 task 文本，经收据建链的顶层节点
		const childId = uuid(105_000);
		const longTask = "T".repeat(250);
		writeMain([
			sessionHeaderLine("main-session", NOW - 300_000),
			toolCallLine("call-1", "coder", longTask, NOW - 120_000),
			receiptLine("call-1", `Dispatched coder. taskId: ${childId}`, NOW - 110_000),
		]);

		// Act
		const node = buildSessionTree(makeDeps())[0];

		// Assert: 恰 200 字符、为原文前缀，且带截断标记
		expect(node.task.length).toBe(200);
		expect(node.task).toBe(longTask.slice(0, 200));
		expect(node.taskTruncated).toBe(true);
	});

	it("should keep a task of exactly 200 characters verbatim without the taskTruncated flag", () => {
		// Arrange: 恰 200 字符的边界 —— 不得截断、不得标记
		const childId = uuid(105_100);
		const exactTask = "X".repeat(200);
		writeMain([
			sessionHeaderLine("main-session", NOW - 300_000),
			toolCallLine("call-1", "coder", exactTask, NOW - 120_000),
			receiptLine("call-1", `Dispatched coder. taskId: ${childId}`, NOW - 110_000),
		]);

		// Act
		const node = buildSessionTree(makeDeps())[0];

		// Assert: 逐字保留，taskTruncated 缺省
		expect(node.task).toBe(exactTask);
		expect(node.taskTruncated).toBeUndefined();
	});

	it("should truncate a pointer-sourced child task as well", () => {
		// Arrange: P recent → 即时扫描；子节点 task 来自 children.jsonl 指针（250 字符）
		const pId = uuid(105_200);
		const gId = uuid(105_201);
		const longChildTask = "C".repeat(250);
		writeMain([
			sessionHeaderLine("main-session", NOW - 300_000),
			toolCallLine("call-1", "coder", "pointer task parent", NOW - 120_000),
			receiptLine("call-1", `Dispatched coder. taskId: ${pId}`, NOW - 110_000),
		]);
		writeChildSession(pId, "pointer task parent", NOW - 5_000);
		writeChildrenJsonl(pId, [
			{ childTaskId: gId, agent: "tester", task: longChildTask, startedAt: NOW - 4_000, depth: 2 },
		]);
		writeChildSession(gId, "child session placeholder", NOW - 60_000);

		// Act
		const tree = buildSessionTree(makeDeps());
		const child = tree[0].children[0];

		// Assert: 指针来源的 task 同样截断到 200 并标记
		expect(child.linkSource).toBe("pointer");
		expect(child.task.length).toBe(200);
		expect(child.task).toBe(longChildTask.slice(0, 200));
		expect(child.taskTruncated).toBe(true);
	});
});

// ================================================================
// 第 7 轮回归（独立审查缺口）：同层节点按 startedAt 升序返回、
// 任务文本按 Unicode 码点截断、未扫描节点 childSummary 措辞与自身状态一致。
// ================================================================

describe("同层节点按 startedAt 升序返回（回归）", () => {
	it("should return same-level nodes in ascending startedAt order when a later-timestamped receipt is discovered before an earlier unknown dispatch", () => {
		// Arrange: 主会话两条同层派发 —— 文件靠前的是 receipt 派发（call.ts =
		// NOW−30_000，较晚），靠后的是无收据无指针的 unknown 派发（call.ts =
		// NOW−60_000，较早）。链接收集顺序永远先 receipt 后 unknown → 发现顺序
		// 与 startedAt 顺序相反；未截断（2 < 预算）时也不得退回发现顺序
		const childId = uuid(110_000);
		const receiptTask = "Receipt dispatch with the later timestamp";
		const unknownTask = "Unknown dispatch with the earlier timestamp";
		writeMain([
			sessionHeaderLine("main-session", NOW - 300_000),
			toolCallLine("call-receipt", "coder", receiptTask, NOW - 30_000),
			receiptLine("call-receipt", `Dispatched coder. taskId: ${childId}`, NOW - 29_000),
			toolCallLine("call-unknown", "tester", unknownTask, NOW - 60_000),
		]);

		// Act
		const nodes = buildSessionTree(makeDeps());

		// Assert: 恰两条同层节点，按 startedAt 升序（旧在前）—— 未知派发
		//（NOW−60_000）先于收据派发（NOW−30_000），且 startedAt 取自各自 call.ts
		//（两条都无子目录，回落 call.ts）
		expect(nodes).toHaveLength(2);
		expect(nodes.map((n) => n.task)).toEqual([unknownTask, receiptTask]);
		expect(nodes.map((n) => n.linkSource)).toEqual(["unknown", "receipt"]);
		expect(nodes.map((n) => n.startedAt)).toEqual([NOW - 60_000, NOW - 30_000]);
		// 整体非降序（数组级守卫，不只看首尾两条）
		const startedAts = nodes.map((n) => n.startedAt);
		expect([...startedAts].sort((a, b) => a - b)).toEqual(startedAts);
	});
});

describe("任务文本按 Unicode 码点截断（回归）", () => {
	it("should truncate a 250-code-point non-BMP task to exactly 200 code points without leaving a lone surrogate", () => {
		// Arrange: 250 个非 BMP 字符（每个 2 个 UTF-16 码元）的 task 文本，
		// 经收据建链的顶层节点；按码点截断 → 前 200 个 emoji（400 个码元）
		const childId = uuid(110_100);
		const longTask = "🙂".repeat(250);
		expect(longTask.length).toBe(500); // 前提自检：确为非 BMP 双码元字符
		writeMain([
			sessionHeaderLine("main-session", NOW - 300_000),
			toolCallLine("call-1", "coder", longTask, NOW - 120_000),
			receiptLine("call-1", `Dispatched coder. taskId: ${childId}`, NOW - 110_000),
		]);

		// Act
		const node = buildSessionTree(makeDeps())[0];

		// Assert: 恰 200 个码点（UTF-16 码元切片会得到 100 个 emoji），且为
		// 原文按码点的前缀；截断标记照常
		expect(Array.from(node.task).length).toBe(200);
		expect(node.task).toBe("🙂".repeat(200));
		expect(node.taskTruncated).toBe(true);
		// 不得在代理对中间切开（孤立高/低代理项 0 命中）
		expect(node.task).not.toMatch(
			/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/,
		);
	});
});

describe("未扫描节点的 childSummary 措辞与自身状态一致（回归）", () => {
	it("should use the neutral '1 child' summary for a pending unscanned node whose own directory holds one pointer", () => {
		// Arrange: 主会话收据 → P（registry running 触发即时扫描）；P 会话内
		// 异步收据派发 C（无指针、无同步收据 → depth 1 pending）；C 自己的
		// 目录里 children.jsonl 有 1 条指针 → C 不被扫描，惰性字段取指针数
		const pId = uuid(111_000);
		const cId = uuid(111_001);
		const gId = uuid(111_002);
		const pTask = "Parent scanned via the registry";
		const cTask = "Pending child whose directory holds a pointer";
		writeMain([
			sessionHeaderLine("main-session", NOW - 300_000),
			toolCallLine("call-1", "coder", pTask, NOW - 120_000),
			receiptLine("call-1", `Dispatched coder. taskId: ${pId}`, NOW - 110_000),
		]);
		writeChildSession(pId, pTask, NOW - 100_000, [
			toolCallLine("p-call", "tester", cTask, NOW - 95_000),
			receiptLine("p-call", `Dispatched tester. taskId: ${cId}`, NOW - 90_000),
		]);
		writeChildSession(cId, cTask, NOW - 600_000);
		writeChildrenJsonl(cId, [
			{ childTaskId: gId, agent: "reviewer", task: "grandchild behind the pending node", startedAt: NOW - 500_000, depth: 3 },
		]);

		// Act
		const tree = buildSessionTree(makeDeps({ registry: runningRegistry(pId) }));
		const p = tree[0];

		// Assert: C 未扫描（children 空、childCount 取指针数 1），但状态是
		// pending 而非 finished → 措辞必须中性 "1 child"，不得出现 all finished
		expect(p.taskId).toBe(pId);
		expect(p.children).toHaveLength(1);
		const c = p.children[0];
		expect(c.taskId).toBe(cId);
		expect(c.status).toBe("pending");
		expect(c.children).toEqual([]);
		expect(c.childCount).toBe(1);
		expect(c.childSummary).toBe("1 child");
		expect(c.childSummary).not.toContain("all finished");
	});

	it("should use the neutral '2 children' summary for a failed unscanned node whose own directory holds two pointers", () => {
		// Arrange: P（registry running → 即时扫描）会话里一条 isError 结果
		// 带 [subagent session: C] → C 判 failed（不扫描）；C 目录 children.jsonl
		// 有 2 条指针 → 惰性字段取指针数 2；failed 不是 finished，措辞须中性
		const pId = uuid(112_000);
		const cId = uuid(112_001);
		const g1 = uuid(112_002);
		const g2 = uuid(112_003);
		const pTask = "Parent whose child failed";
		const cTask = "Failed child whose directory holds two pointers";
		writeMain([
			sessionHeaderLine("main-session", NOW - 300_000),
			toolCallLine("call-1", "coder", pTask, NOW - 120_000),
			receiptLine("call-1", `Dispatched coder. taskId: ${pId}`, NOW - 110_000),
		]);
		writeChildSession(pId, pTask, NOW - 100_000, [
			errorResultLine(
				"p-call",
				`Agent: tester (project)\nExit code: 1\nError message: boom\n\n[subagent session: ${cId}]`,
				NOW - 90_000,
			),
		]);
		writeChildSession(cId, cTask, NOW - 600_000);
		writeChildrenJsonl(cId, [
			{ childTaskId: g1, agent: "reviewer", task: "pointer grandchild one", startedAt: NOW - 500_000, depth: 3 },
			{ childTaskId: g2, agent: "reviewer", task: "pointer grandchild two", startedAt: NOW - 490_000, depth: 3 },
		]);

		// Act
		const tree = buildSessionTree(makeDeps({ registry: runningRegistry(pId) }));
		const p = tree[0];

		// Assert: failed 未扫描节点 → 中性 "2 children"，复数档也要覆盖，
		// 且不得出现 all finished
		expect(p.children).toHaveLength(1);
		const c = p.children[0];
		expect(c.taskId).toBe(cId);
		expect(c.status).toBe("failed");
		expect(c.children).toEqual([]);
		expect(c.childCount).toBe(2);
		expect(c.childSummary).toBe("2 children");
		expect(c.childSummary).not.toContain("all finished");
	});
});
