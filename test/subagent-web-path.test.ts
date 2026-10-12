/**
 * `src/web/tree.ts` 的 `buildSessionPath` —— 冷深链完整面包屑的服务端路径查询
 * （纯函数）。导出已落地，本文件现绿（下述「红阶段」措辞仅作冻结契约存档，
 * 不再表示本文件预期整体红）。
 *
 * 被测接口（固定签名，实现者照此实现，不得偏离）：
 *   buildSessionPath(deps: BuildTreeDeps, targetTaskId: string):
 *     { found: boolean; path: PathSegment[]; node: PathSegment | null }
 *   interface PathSegment { taskId: string; agent: string; task: string; status: string }
 *   （status 为现有六态字符串 running/recent/finished/pending/rejected/failed）
 *
 * 语义（本文件用例逐条编码）：
 *   - `path` = 从最顶层根节点（主会话直接派发）到目标**直接父**的祖先链，
 *     不含目标本身；顺序 root 在前、直接父在后。
 *   - `node` = 目标自身的 segment（仅 found 时非 null）。
 *   - 目标本身是根节点（主会话直接派发）→ found=true、path=[]。
 *   - 目标不可达（既不是根，也不是任一收据 / children.jsonl 指针可下探到的
 *     后代）→ found=false、path=[]、node=null。
 *   - 每节 `task` 截断到前 200 个码点（与 TASK_TEXT_MAX 一致，按 Unicode
 *     码点计数，不切碎代理对）。
 *   - 永不抛错：null mainSessionFile、不可读的 sessions 根 / 任务目录只降级。
 *   - **关键 1**：路径下探不受展示预算（MAX_CHILD_NODES=200 / selectNewest
 *     截断保留最新）影响 —— 被预算丢弃的最旧同层节点仍可找到。
 *   - **关键 2**：路径下探必须能穿透 finished / pending 节点的子级 ——
 *     finalizeNode 的懒扫描（finished/pending 默认不展开 children）只约束
 *     展示树，不适用于路径查询。
 *
 * 夹具构造沿用 test/subagent-web-tree.test.ts 的真实数据形状：
 *   主会话 JSONL（tmpDir/main-session.jsonl，toolCall + 异步/同步收据）+
 *   <rootDir>/<taskId>/<ISO>_<taskId>.jsonl 子会话 +
 *   <rootDir>/<taskId>/children.jsonl 指针 sidecar。
 * 注入固定 now，会话条目时间戳全部显式设定，状态判定确定性不依赖真实时钟。
 *
 * 状态语义按现有规则钉死（resolveStatus）：depth 0 异步收据 + 旧 lastEntryTs
 * → finished；depth ≥ 1 仅异步收据（无指针无同步收据无完成记录）→ pending；
 * 同步收据 → 任意深度 finished；指针链接且 10 分钟内有活动 → running。
 */

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { buildSessionPath, buildSessionTree } from "../src/web/tree.ts";
// 仅类型引用：PathSegment 为冻结契约中的新接口，type-only import 在转译期被剥离。
import type { BuildTreeDeps, PathSegment, SessionTreeNode } from "../src/web/tree.ts";
// 同上：children.jsonl 指针记录的形状。
import type { ChildPointer } from "../src/web/children.ts";

// ---------------------------------------------------------------------------
// 读盘计数（确定性终止性信号）：`node:fs` 的只读入口全部包一层计数器，
// 供环形查询的读盘上界断言使用。vi.hoisted 保证计数对象在 vi.mock 工厂
// （提升到 import 之前执行）里可见；包装只做计数并原样转发，行为不变。
// ---------------------------------------------------------------------------

/** 只读入口的调用计数：total 为总和，perKey 分项（诊断用）。 */
const fsRead = vi.hoisted(() => ({ total: 0, perKey: {} as Record<string, number> }));

/** 计数器清零（fixture 落盘自身也走这些入口，Act 前调用）。 */
function resetFsReadCounts(): void {
	fsRead.total = 0;
	fsRead.perKey = {};
}

vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs")>();
	const mocked: Record<string, unknown> = { ...actual, default: (actual as { default?: unknown }).default ?? actual };
	const READ_KEYS = [
		"readdirSync", "statSync", "lstatSync", "readFileSync",
		"openSync", "fstatSync", "readSync", "existsSync", "accessSync",
	] as const;
	for (const key of READ_KEYS) {
		const fn = actual[key];
		if (typeof fn !== "function") continue;
		mocked[key] = (...args: unknown[]) => {
			fsRead.total += 1;
			fsRead.perKey[key] = (fsRead.perKey[key] ?? 0) + 1;
			return (fn as (...inner: unknown[]) => unknown)(...args);
		};
	}
	return mocked;
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
// JSONL 行构造器（形状照真实数据，同 subagent-web-tree.test.ts）
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

/** 同步收据文本（任意正文 + 空行 + 后缀行）。 */
function syncReceiptText(childId: string): string {
	return `Done, full transcript attached.\n\n[subagent session: ${childId}]\n`;
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

let tmpDir: string; // 任务临时根
let rootDir: string; // subagent-sessions 根：<tmpDir>/subagent-sessions
let mainFile: string; // 主会话 JSONL：<tmpDir>/main-session.jsonl

beforeEach(() => {
	tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "subagent-web-path-"));
	rootDir = path.join(tmpDir, "subagent-sessions");
	fs.mkdirSync(rootDir, { recursive: true });
	mainFile = path.join(tmpDir, "main-session.jsonl");
});

afterEach(() => {
	fs.rmSync(tmpDir, { recursive: true, force: true });
});

/** 写主会话 JSONL（覆盖写）。 */
function writeMain(lines: string[]): void {
	fs.writeFileSync(mainFile, lines.join("\n") + "\n", "utf-8");
}

/**
 * 写子会话：<rootDir>/<taskId>/<ISO>_<taskId>.jsonl，条目 ts 与文件/目录 mtime
 * 同值（extraLines 携带自己的派发行 ts）。
 */
function writeChildSession(taskId: string, task: string, ts: number, extraLines: string[] = []): string {
	const dir = path.join(rootDir, taskId);
	fs.mkdirSync(dir, { recursive: true });
	const filePath = path.join(dir, `${iso(ts)}_${taskId}.jsonl`);
	fs.writeFileSync(filePath, childSessionLines(taskId, task, ts, extraLines).join("\n") + "\n", "utf-8");
	const d = new Date(ts);
	fs.utimesSync(filePath, d, d);
	fs.utimesSync(dir, d, d);

	return filePath;
}

/** 写派发指针文件：<rootDir>/<taskId>/children.jsonl 逐行 JSON。 */
function writeChildrenJsonl(taskId: string, records: ChildPointer[]): void {
	const dir = path.join(rootDir, taskId);
	fs.mkdirSync(dir, { recursive: true });
	const lines = records.map((record) => JSON.stringify(record));
	fs.writeFileSync(path.join(dir, "children.jsonl"), lines.join("\n") + "\n", "utf-8");
}

/** 默认 deps：主会话文件 + 空 registry + 注入固定 now。 */
function makeDeps(overrides: Partial<BuildTreeDeps> = {}): BuildTreeDeps {
	return { mainSessionFile: mainFile, registry: new Map(), rootDir, now: NOW, ...overrides };
}

/**
 * 主会话 → ids[0] → ids[1] → … → ids[count-1] 的全异步收据链：
 * ids[0] 由主会话直接派发（agent "coder"、task "task 0"）；每个 ids[i]（i ≥ 1）
 * 由其父会话以 agent "tester"、task "task i" 派发。所有会话最后条目都远早于
 * NOW（落在 10s recent 窗口外）：根 finished、更深层 pending。
 */
function writeReceiptChain(count: number, idBase: number): string[] {
	const ids = Array.from({ length: count }, (_, i) => uuid(idBase + i));
	writeMain([
		sessionHeaderLine("main-session", NOW - 3_000_000),
		toolCallLine("call-0", "coder", "task 0", NOW - 500_000),
		receiptLine("call-0", `Dispatched coder. taskId: ${ids[0]}`, NOW - 490_000),
	]);
	for (let i = 0; i < count - 1; i++) {
		writeChildSession(ids[i], `task ${i}`, NOW - 600_000 + i * 1_000, [
			toolCallLine(`call-${i + 1}`, "tester", `task ${i + 1}`, NOW - 500_000 + i * 1_000),
			receiptLine(`call-${i + 1}`, `Dispatched tester. taskId: ${ids[i + 1]}`, NOW - 490_000 + i * 1_000),
		]);
	}
	writeChildSession(ids[count - 1], `task ${count - 1}`, NOW - 600_000 + (count - 1) * 1_000);

	return ids;
}

/**
 * 生成 count 条「toolCall + 异步收据」派发行：taskId 逐条唯一（idBase + i），
 * ts 严格递增（tsBase + i * stepMs），task 文本为 "<prefix> <i>"（同
 * subagent-web-tree.test.ts 的规模夹具）。
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

/** 孤立代理对（截断若按 UTF-16 码元切分会命中）。 */
const LONE_SURROGATE_RE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

// ================================================================
// 根级目标（主会话直接派发）
// ================================================================

describe("根级目标", () => {
	it("should return found with an empty path and the target's own segment when the target is dispatched directly by the main session", () => {
		// Arrange: 主会话 → A → B → C 的收据链，目标 = 根节点 A
		const ids = writeReceiptChain(3, 1);

		// Act
		const result = buildSessionPath(makeDeps(), ids[0]);

		// Assert: found、path 恰为空（目标自身即根，无祖先节）、node 为真实
		// segment（status = depth 0 异步收据 + 旧 lastEntryTs → finished）
		expect(result.found).toBe(true);
		expect(result.path).toEqual([]);
		expect(result.node).toEqual({ taskId: ids[0], agent: "coder", task: "task 0", status: "finished" });
	});
});

// ================================================================
// depth-1 目标（根的直接子级）
// ================================================================

describe("depth-1 目标", () => {
	it("should return a path of exactly the root segment when the target is a direct child of a root task", () => {
		// Arrange: 同一收据链，目标 = A 的子级 B
		const ids = writeReceiptChain(3, 10);

		// Act
		const result = buildSessionPath(makeDeps(), ids[1]);

		// Assert: path 恰为 [root]，顺序 root 在前；node 为 B 自身
		expect(result.found).toBe(true);
		expect(result.path).toEqual([{ taskId: ids[0], agent: "coder", task: "task 0", status: "finished" }]);
		expect(result.node).toEqual({ taskId: ids[1], agent: "tester", task: "task 1", status: "pending" });
	});
});

// ================================================================
// depth-2 / depth-3 目标（完整链 root → … → 直接父，顺序正确）
// ================================================================

describe("depth-2 / depth-3 目标的完整祖先链", () => {
	it("should return the full ancestor chain root-first when the target sits two levels below the root", () => {
		// Arrange: A → B → C，目标 = C（孙辈）；path 应为 [A, B]（root 在前、
		// 直接父 B 在后，不含目标自身）
		const ids = writeReceiptChain(3, 20);

		// Act
		const result = buildSessionPath(makeDeps(), ids[2]);

		// Assert
		expect(result.found).toBe(true);
		expect(result.path).toEqual([
			{ taskId: ids[0], agent: "coder", task: "task 0", status: "finished" },
			{ taskId: ids[1], agent: "tester", task: "task 1", status: "pending" },
		]);
		expect(result.node).toEqual({ taskId: ids[2], agent: "tester", task: "task 2", status: "pending" });
	});

	it("should return the full ancestor chain root-first when the target sits three levels below the root", () => {
		// Arrange: A → B → C → D，目标 = D；path 应为 [A, B, C]
		const ids = writeReceiptChain(4, 30);

		// Act
		const result = buildSessionPath(makeDeps(), ids[3]);

		// Assert: 链完整、顺序 root → … → 直接父
		expect(result.found).toBe(true);
		expect(result.path.map((segment) => segment.taskId)).toEqual([ids[0], ids[1], ids[2]]);
		expect(result.path).toEqual([
			{ taskId: ids[0], agent: "coder", task: "task 0", status: "finished" },
			{ taskId: ids[1], agent: "tester", task: "task 1", status: "pending" },
			{ taskId: ids[2], agent: "tester", task: "task 2", status: "pending" },
		]);
		expect(result.node).toEqual({ taskId: ids[3], agent: "tester", task: "task 3", status: "pending" });
	});
});

// ================================================================
// 深度上限：路径下探不受展示层 MAX_DEPTH=6 限制
// ================================================================

describe("深度上限外的目标", () => {
	it("should find a target beyond the display depth limit with its full ancestor chain", () => {
		// Arrange: root → … → depth7 的 8 节点全异步收据链（root 为主会话直接
		// 派发 = depth 0；目标 ids[7] 在展示层 MAX_DEPTH=6 之外）
		const ids = writeReceiptChain(8, 110);
		const targetId = ids[7];

		// 前提自检：展示树里不含目标节点（面包屑必须穿透展示深度上限）
		const visibleTaskIds = new Set<string>();
		const collectIds = (nodes: SessionTreeNode[]): void => {
			for (const node of nodes) {
				visibleTaskIds.add(node.taskId);
				collectIds(node.children);
			}
		};
		collectIds(buildSessionTree(makeDeps()));
		expect(visibleTaskIds.has(targetId)).toBe(false);

		// Act
		const result = buildSessionPath(makeDeps(), targetId);

		// Assert: found；祖先链完整 root…直接父（ids[0..6] 共 7 节，root 在前、
		// 直接父在后，不含目标自身）；node 为目标自身的 segment
		expect(result.found).toBe(true);
		expect(result.path).toHaveLength(7);
		expect(result.path.map((segment) => segment.taskId)).toEqual(ids.slice(0, 7));
		expect(result.node).toEqual({ taskId: targetId, agent: "tester", task: "task 7", status: "pending" });
	});
});

// ================================================================
// 链中 finished（懒扫描）节点仍可下探
// ================================================================

describe("穿透懒扫描的 finished 节点", () => {
	it("should still find a deeper descendant when an ancestor on the chain is finished and left unscanned by the lazy tree build", () => {
		// Arrange: A（根，旧会话 → finished）→ B（同步收据 → 任意深度 finished）
		// → C（目标，异步收据 → pending）
		const aId = uuid(40);
		const bId = uuid(41);
		const cId = uuid(42);
		writeMain([
			sessionHeaderLine("main-session", NOW - 3_000_000),
			toolCallLine("call-a", "coder", "task A", NOW - 500_000),
			receiptLine("call-a", `Dispatched coder. taskId: ${aId}`, NOW - 490_000),
		]);
		writeChildSession(aId, "task A", NOW - 600_000, [
			toolCallLine("call-b", "tester", "task B", NOW - 500_000),
			receiptLine("call-b", syncReceiptText(bId), NOW - 499_000),
		]);
		writeChildSession(bId, "task B", NOW - 599_000, [
			toolCallLine("call-c", "reviewer", "task C", NOW - 498_000),
			receiptLine("call-c", `Dispatched reviewer. taskId: ${cId}`, NOW - 497_000),
		]);
		writeChildSession(cId, "task C", NOW - 598_000);

		// Act + 前提自检：展示树里 A 为 finished 且 children 为空（懒扫描）——
		// C 在展示树中完全不可见，面包屑必须穿透它
		const tree = buildSessionTree(makeDeps());
		expect(tree).toHaveLength(1);
		expect(tree[0].taskId).toBe(aId);
		expect(tree[0].status).toBe("finished");
		expect(tree[0].children).toEqual([]);

		const result = buildSessionPath(makeDeps(), cId);

		// Assert: 链完整 [A, B]；直接父 B 是 finished 的懒扫描节点，仍是路径一节
		expect(result.found).toBe(true);
		expect(result.path.map((segment) => segment.taskId)).toEqual([aId, bId]);
		expect(result.path[0].status).toBe("finished");
		expect(result.path[1].status).toBe("finished");
		expect(result.node).toEqual({ taskId: cId, agent: "reviewer", task: "task C", status: "pending" });
	});
});

// ================================================================
// 展示预算截断不影响路径下探（MAX_CHILD_NODES=200 / selectNewest）
// ================================================================

describe("展示预算截断不影响路径下探", () => {
	it("should find a target that the display budget dropped from its parent's child list", () => {
		// Arrange: P 的会话派发 250 个子任务（startedAt 严格递增），目标 = 最旧
		// 的 grand 0 —— 展示树按 MAX_CHILD_NODES=200 截断时必被丢弃
		const CHILDREN = 250;
		const pId = uuid(50);
		const targetId = uuid(50_100);
		for (let i = 0; i < CHILDREN; i++) {
			writeChildSession(uuid(50_100 + i), `grand ${i}`, NOW - 900_000 + i * 1_000);
		}
		writeMain([
			sessionHeaderLine("main-session", NOW - 5_000_000),
			toolCallLine("call-p", "coder", "parent with many children", NOW - 4_600),
			receiptLine("call-p", `Dispatched coder. taskId: ${pId}`, NOW - 4_590),
		]);
		// P 最后条目 NOW−9_250（recent 窗口内）→ 展示树即时扫描 P，截断只因预算
		writeChildSession(pId, "parent with many children", NOW - 9_600, dispatchLines(CHILDREN, "grand", NOW - 9_500, 1, 50_100));

		// Act + 前提自检：展示树恰好截掉最旧 50 个，目标不在其中
		const tree = buildSessionTree(makeDeps());
		const p = tree[0];
		expect(p.taskId).toBe(pId);
		expect(p.status).toBe("recent");
		expect(p.children).toHaveLength(200);
		expect(p.children.some((child) => child.taskId === targetId)).toBe(false);

		const result = buildSessionPath(makeDeps(), targetId);

		// Assert: 被预算丢弃的最旧同层节点仍可下探到
		expect(result.found).toBe(true);
		expect(result.path).toEqual([
			{ taskId: pId, agent: "coder", task: "parent with many children", status: "recent" },
		]);
		expect(result.node).toEqual({ taskId: targetId, agent: "coder", task: "grand 0", status: "pending" });
	});
});

// ================================================================
// children.jsonl 指针链接的可达性
// ================================================================

describe("指针链接的目标可达", () => {
	it("should reach an in-flight child linked only by a children.jsonl pointer", () => {
		// Arrange: A 会话里一条无收据 toolCall；A 目录 children.jsonl 指针 → B
		const aId = uuid(60);
		const bId = uuid(61);
		writeMain([
			sessionHeaderLine("main-session", NOW - 3_000_000),
			toolCallLine("call-a", "coder", "task A", NOW - 500_000),
			receiptLine("call-a", `Dispatched coder. taskId: ${aId}`, NOW - 490_000),
		]);
		writeChildSession(aId, "task A", NOW - 600_000, [toolCallLine("call-b", "tester", "task B", NOW - 500_000)]);
		writeChildrenJsonl(aId, [
			{ childTaskId: bId, agent: "tester", task: "task B", startedAt: NOW - 400_000, depth: 2 },
		]);
		writeChildSession(bId, "task B", NOW - 300_000);

		// Act
		const result = buildSessionPath(makeDeps(), bId);

		// Assert: 指针链可达；B 为指针链接 + 10 分钟内有活动 → running
		expect(result.found).toBe(true);
		expect(result.path).toEqual([{ taskId: aId, agent: "coder", task: "task A", status: "finished" }]);
		expect(result.node).toEqual({ taskId: bId, agent: "tester", task: "task B", status: "running" });
	});
});

// ================================================================
// task 截断到前 200 个码点（每节都截）
// ================================================================

describe("segment.task 按码点截断到 200", () => {
	it("should cut the target segment's task to exactly 200 code points when the task text is longer", () => {
		// Arrange: 250 个码点的 task 文本（含非 BMP 字符），经收据建链的根级目标
		const childId = uuid(70);
		const longTask = "a".repeat(199) + "🙂" + "z".repeat(50);
		expect(Array.from(longTask).length).toBe(250); // 前提自检：确为 250 码点
		writeMain([
			sessionHeaderLine("main-session", NOW - 3_000_000),
			toolCallLine("call-1", "coder", longTask, NOW - 120_000),
			receiptLine("call-1", `Dispatched coder. taskId: ${childId}`, NOW - 110_000),
		]);

		// Act
		const result = buildSessionPath(makeDeps(), childId);

		// Assert: node.task 恰 200 个码点、为原文按码点的前缀，且不切碎代理对
		expect(result.found).toBe(true);
		expect(result.node).not.toBeNull();
		expect(Array.from(result.node!.task).length).toBe(200);
		expect(result.node!.task).toBe("a".repeat(199) + "🙂");
		expect(result.node!.task).not.toMatch(LONE_SURROGATE_RE);
	});

	it("should cut an ancestor path segment's task to exactly 200 code points as well", () => {
		// Arrange: 根 A 的 task 文本 250 个码点（全非 BMP），目标 B 是 A 的直接子级
		const aId = uuid(80);
		const bId = uuid(81);
		const longTask = "🙂".repeat(250);
		expect(Array.from(longTask).length).toBe(250); // 前提自检
		writeMain([
			sessionHeaderLine("main-session", NOW - 3_000_000),
			toolCallLine("call-a", "coder", longTask, NOW - 500_000),
			receiptLine("call-a", `Dispatched coder. taskId: ${aId}`, NOW - 490_000),
		]);
		writeChildSession(aId, "parent session placeholder", NOW - 600_000, [
			toolCallLine("call-b", "tester", "task B", NOW - 500_000),
			receiptLine("call-b", `Dispatched tester. taskId: ${bId}`, NOW - 490_000),
		]);
		writeChildSession(bId, "task B", NOW - 300_000);

		// Act
		const result = buildSessionPath(makeDeps(), bId);

		// Assert: path 每节的 task 同样截到 200 码点（UTF-16 码元切分会得到 100 个 emoji）
		expect(result.found).toBe(true);
		expect(result.path).toHaveLength(1);
		expect(Array.from(result.path[0].task).length).toBe(200);
		expect(result.path[0].task).toBe("🙂".repeat(200));
		expect(result.path[0].task).not.toMatch(LONE_SURROGATE_RE);
	});
});

// ================================================================
// 不可达目标
// ================================================================

describe("不可达目标", () => {
	it("should report found false with an empty path and a null node when the target exists nowhere in the session tree", () => {
		// Arrange: 会话树里有一个真实任务，查询的是另一个既无收据也无指针、
		// 磁盘上也无目录的 taskId
		writeReceiptChain(2, 90);
		const missing = uuid(99);

		// Act
		const result = buildSessionPath(makeDeps(), missing);

		// Assert: 三字段整体归位（found=false 时 path 恒空、node 恒 null）
		expect(result).toEqual({ found: false, path: [], node: null });
	});
});

// ================================================================
// 环形夹具：路径下探的终止性（共享 visited 每 childId 至多变一次）
// ================================================================

describe("环形指针的终止性", () => {
	it("should terminate with found false when two task directories point at each other and the target is unreachable", () => {
		// Arrange: 主会话 → A；A 的会话收据指 B，B 的会话收据指回 A —— A ↔ B
		// 互指环。查询的目标既不在环上也不在任何分支上（不可达）
		const aId = uuid(120);
		const bId = uuid(121);
		const missing = uuid(129);
		writeMain([
			sessionHeaderLine("main-session", NOW - 3_000_000),
			toolCallLine("call-a", "coder", "task A", NOW - 500_000),
			receiptLine("call-a", `Dispatched coder. taskId: ${aId}`, NOW - 490_000),
		]);
		writeChildSession(aId, "task A", NOW - 600_000, [
			toolCallLine("call-b", "tester", "task B", NOW - 500_000),
			receiptLine("call-b", `Dispatched tester. taskId: ${bId}`, NOW - 490_000),
		]);
		// B 的会话又把 A 当子任务派发一次 → 环闭合
		writeChildSession(bId, "task B", NOW - 599_000, [
			toolCallLine("call-a2", "reviewer", "task A re-entered", NOW - 498_000),
			receiptLine("call-a2", `Dispatched reviewer. taskId: ${aId}`, NOW - 497_000),
		]);

		// Act: 环形下探必须在默认超时内返回（不挂死、不爆栈）
		const result = buildSessionPath(makeDeps(), missing);

		// Assert: 三字段整体归位
		expect(result).toEqual({ found: false, path: [], node: null });
	});

	it("should terminate with found false when a task directory points at itself and the target is unreachable", () => {
		// Arrange: 主会话 → A；A 的会话收据指回自己（自环 A → A）
		const aId = uuid(130);
		const missing = uuid(139);
		writeMain([
			sessionHeaderLine("main-session", NOW - 3_000_000),
			toolCallLine("call-a", "coder", "task A", NOW - 500_000),
			receiptLine("call-a", `Dispatched coder. taskId: ${aId}`, NOW - 490_000),
		]);
		writeChildSession(aId, "task A", NOW - 600_000, [
			toolCallLine("call-self", "coder", "task A self", NOW - 500_000),
			receiptLine("call-self", `Dispatched coder. taskId: ${aId}`, NOW - 490_000),
		]);

		// Act
		const result = buildSessionPath(makeDeps(), missing);

		// Assert: 三字段整体归位
		expect(result).toEqual({ found: false, path: [], node: null });
	});

	it("should terminate with found false when a three-node ring closes back on the root and the target is unreachable", () => {
		// Arrange: 主会话 → A；A → B → C → A（三节点长环）
		const aId = uuid(140);
		const bId = uuid(141);
		const cId = uuid(142);
		const missing = uuid(149);
		writeMain([
			sessionHeaderLine("main-session", NOW - 3_000_000),
			toolCallLine("call-a", "coder", "task A", NOW - 500_000),
			receiptLine("call-a", `Dispatched coder. taskId: ${aId}`, NOW - 490_000),
		]);
		writeChildSession(aId, "task A", NOW - 600_000, [
			toolCallLine("call-b", "tester", "task B", NOW - 500_000),
			receiptLine("call-b", `Dispatched tester. taskId: ${bId}`, NOW - 490_000),
		]);
		writeChildSession(bId, "task B", NOW - 599_000, [
			toolCallLine("call-c", "tester", "task C", NOW - 498_000),
			receiptLine("call-c", `Dispatched tester. taskId: ${cId}`, NOW - 497_000),
		]);
		writeChildSession(cId, "task C", NOW - 598_000, [
			toolCallLine("call-a3", "reviewer", "task A re-entered", NOW - 496_000),
			receiptLine("call-a3", `Dispatched reviewer. taskId: ${aId}`, NOW - 495_000),
		]);

		// Act
		const result = buildSessionPath(makeDeps(), missing);

		// Assert: 三字段整体归位
		expect(result).toEqual({ found: false, path: [], node: null });
	});

	// -----------------------------------------------------------------------
	// 确定性终止性信号（补强）：上面三条环形用例只断言“返回不挂死”，
	// 在「删掉 visited 去重」的变异下可能因栈溢出 RangeError 落进 src 侧
	// best-effort try/catch 被吞而“侥幸变红/变绿”。此处改为可计数的读盘量：
	// 无环时每个 childId 至多变一次（visited 保证），读盘量与环长无关的常数
	// 级；无 visited 时每次回环都重新 stat/打开同一会话，读盘量随递归深度
	// 无界增长，在击穿上界前即确定性变红，不依赖栈溢出落在哪一层。
	// -----------------------------------------------------------------------

	/** 环形查询的读盘量常数上界（与环长 / 节点数无关，实测健康值远小于此）。 */
	const RING_READ_BOUND = 200;

	it("should keep the disk reads of a cyclic path query within a constant bound", () => {
		// Arrange: 三节点环夹具（主会话 → A；A → B → C → A）+ 不可达目标；
		// fixture 落盘后清零读盘计数，只量 Act 期间的查询开销
		const aId = uuid(150);
		const bId = uuid(151);
		const cId = uuid(152);
		const missing = uuid(159);
		writeMain([
			sessionHeaderLine("main-session", NOW - 3_000_000),
			toolCallLine("call-a", "coder", "task A", NOW - 500_000),
			receiptLine("call-a", `Dispatched coder. taskId: ${aId}`, NOW - 490_000),
		]);
		writeChildSession(aId, "task A", NOW - 600_000, [
			toolCallLine("call-b", "tester", "task B", NOW - 500_000),
			receiptLine("call-b", `Dispatched tester. taskId: ${bId}`, NOW - 490_000),
		]);
		writeChildSession(bId, "task B", NOW - 599_000, [
			toolCallLine("call-c", "tester", "task C", NOW - 498_000),
			receiptLine("call-c", `Dispatched tester. taskId: ${cId}`, NOW - 497_000),
		]);
		writeChildSession(cId, "task C", NOW - 598_000, [
			toolCallLine("call-a3", "reviewer", "task A re-entered", NOW - 496_000),
			receiptLine("call-a3", `Dispatched reviewer. taskId: ${aId}`, NOW - 495_000),
		]);
		resetFsReadCounts();

		// Act: 即使环形下探抛错（如无 visited 时的栈溢出 RangeError）也必须
		// 先量到读盘量再断言 —— 上界红信号不依赖错误落在哪一层 try/catch
		let result: ReturnType<typeof buildSessionPath> | undefined;
		let actError: unknown = undefined;
		try {
			result = buildSessionPath(makeDeps(), missing);
		} catch (error) {
			actError = error;
		}
		const reads = fsRead.total;

		// Assert: 计数器确实接线（否则上界断言会空转自绿）
		expect(reads, `fs read counter not wired: ${JSON.stringify(fsRead.perKey)}`).toBeGreaterThan(0);

		// Assert: 读盘量为常数上界 —— visited 去重下环形查询的读盘量不随
		// 环长 / 回环次数增长；去掉 visited 后每次回环都重新 stat/打开同一会话，
		// 读盘量在溢出前即无界增长，必然击穿上界（确定性红，排在最前）
		expect(reads, `ring query read too much: ${JSON.stringify(fsRead.perKey)}`).toBeLessThanOrEqual(RING_READ_BOUND);

		// Assert: 终止性信号本身 —— 不抛错、且三字段整体归位
		expect(actError).toBeUndefined();
		expect(result).toEqual({ found: false, path: [], node: null });
	});
});

// ================================================================
// 永不抛错：null mainSessionFile / 不可读的 sessions 根
// ================================================================

describe("永不抛错", () => {
	it("should not throw and report the target unreachable when there is no main session file", () => {
		// Arrange
		const deps = makeDeps({ mainSessionFile: null });

		// Act
		let result: ReturnType<typeof buildSessionPath> | undefined;
		expect(() => {
			result = buildSessionPath(deps, uuid(1));
		}).not.toThrow();

		// Assert: 无主会话 = 无会话树 = 目标不可达
		expect(result).toEqual({ found: false, path: [], node: null });
	});

	it("should not throw when the sessions root directory cannot be read, keeping a receipt-linked root reachable", () => {
		// Arrange: 主会话收据 → aId；随后把 rootDir 替换成普通文件 —— 其下任何
		// 任务目录都不可 stat/不可枚举（ENOTDIR，确定性；不用 chmod 000，
		// owner 仍可读自己的目录，见 cwd-preflight-red.test.ts 的先例）
		const aId = uuid(100);
		writeMain([
			sessionHeaderLine("main-session", NOW - 300_000),
			toolCallLine("call-1", "coder", "task under an unreadable root", NOW - 120_000),
			receiptLine("call-1", `Dispatched coder. taskId: ${aId}`, NOW - 110_000),
		]);
		fs.rmSync(rootDir, { recursive: true, force: true });
		fs.writeFileSync(rootDir, "not a directory", "utf-8");

		// Act
		let result: ReturnType<typeof buildSessionPath> | undefined;
		expect(() => {
			result = buildSessionPath(makeDeps(), aId);
		}).not.toThrow();

		// Assert: 目录不可读只降级信息，收据链接的根目标仍可达（根级判定不依赖目录）
		expect(result!.found).toBe(true);
		expect(result!.path).toEqual([]);
		expect(result!.node).not.toBeNull();
		expect(result!.node!.taskId).toBe(aId);
		expect(result!.node!.agent).toBe("coder");
		expect(result!.node!.task).toBe("task under an unreadable root");
	});
});
