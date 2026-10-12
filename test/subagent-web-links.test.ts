/**
 * 红阶段测试：`src/web/tree.ts` 新增导出 `collectSessionLinks` + `src/web/server.ts`
 * 的 `/api/session` links 字段与 port 选项（四条用户反馈的第一轮修复契约）。
 * collectSessionLinks 尚未导出、links 字段与 port 选项尚未实现，本文件预期红。
 *
 * 被测接口（固定签名，实现者照此实现）：
 *   A. tree.ts 新增导出：
 *      export interface SessionLink {
 *        toolCallId: string; childTaskId: string; agent: string; task: string;
 *        source: "receipt" | "pointer";
 *      }
 *      export function collectSessionLinks(deps: {
 *        sessionFile: string | null; sessionDir: string | null;
 *      }): SessionLink[]
 *      行为：
 *        - 收据优先：从 readSessionSummary(sessionFile).results 按既有两条正则
 *          （^Dispatched (.+)\. taskId: <uuid>$ 异步；
 *           (?:^|\n)\s*\[subagent session: <uuid>\]\s*$ 同步）解析 childId，
 *          产出 { toolCallId: result.toolCallId, childTaskId,
 *                agent: call?.agent ?? receiptAgent ?? "",
 *                task: call?.task ?? "", source: "receipt" }；
 *        - 指针：对 readChildPointers(sessionDir) 每条 pointer，在 summary.callOrder
 *          里找第一个尚未被收据占用的 call（agent 与 task 去首尾空白后精确相等），
 *          命中产出 { toolCallId: call.id, childTaskId: pointer.childTaskId,
 *                    agent: pointer.agent, task: pointer.task, source: "pointer" }；
 *          同一 toolCallId 不重复（收据胜）；
 *        - 两者都无的 toolCall 不产生 link；sessionFile === null 时无收据来源；
 *          sessionDir === null 时无指针；
 *        - 顺序：先收据（results 顺序）后指针（readChildPointers 顺序）；
 *        - 硬约束：构建 links 时不得对会话根目录（rootDir）做 readdir 扫描。
 *   B. server.ts：
 *      1. `/api/session` 成功响应体新增字段 links: SessionLink[]（永远存在，
 *         可为空数组），由 collectSessionLinks({ sessionFile: <该任务会话文件>,
 *         sessionDir: <该任务会话目录> }) 计算；指针来自该被查看任务自己目录下的
 *         children.jsonl；
 *      2. StartWebServerOptions 新增可选 port?: number，
 *         server.listen(opts.port ?? 0, "127.0.0.1", ...)。默认（不传）随机端口；
 *         传 0 等价随机；传具体端口则 handle.port 等于该端口；端口被占用时
 *         startWebServer 的 Promise reject（不吞错）。
 *
 * collectSessionLinks 的导入方式：动态 import + 缺失守卫 —— 红阶段该导出不存在，
 * 若顶层静态 import 会让本文件整体 import 失败、连 B 组（真实起服务）用例都
 * 无法执行；动态导入让 A 组用例以「导出缺失」的明确错误变红，B 组用例则以
 * 断言失败（links 缺失 / port 未生效）变红，两类失败可区分。
 *
 * readdirSync 观测：同 test/subagent-web-tree.test.ts —— vi.spyOn(fs, "readdirSync")
 * 对 ESM 模块命名空间不可行（属性不可配置），改用 vi.mock 把 node:fs 的
 * readdirSync 换成 vi.fn 包裹原实现的 spy；tree.ts、server.ts 与本文件共享同一
 * 模块实例。断言前 mockClear()，mock 实现始终为真实 readdirSync。
 *
 * 约定（沿仓库惯例，同 test/subagent-web-server.test.ts）：globals:false 显式
 * import from "vitest"；fixture 用 fs.mkdtempSync(os.tmpdir()) + afterEach 递归
 * 删除；真实起服务（端口 0 或显式端口）、真实 http.request（agent:false），用完
 * 必须 await handle.close()。JSONL 行构造器沿用 subagent-web-server.test.ts 风格。
 */

import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { startWebServer } from "../src/web/server.ts";
import type { StartWebServerOptions, WebServerHandle } from "../src/web/server.ts";

// readdirSync 观测（理由见文件头）：包裹真实实现的 vi.fn spy。
vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs")>();
	return { ...actual, readdirSync: vi.fn(actual.readdirSync) };
});
const readdirSyncSpy = vi.mocked(fs.readdirSync);

// ---------------------------------------------------------------------------
// 被测类型与动态加载（红阶段 collectSessionLinks 未导出）
// ---------------------------------------------------------------------------

/** 与 src/web/tree.ts 待实现契约一致的 SessionLink 形状（本文件不 import 类型，避免红阶段类型错误掩盖行为断言）。 */
interface SessionLink {
	toolCallId: string;
	childTaskId: string;
	agent: string;
	task: string;
	source: "receipt" | "pointer";
}

type CollectSessionLinks = (deps: { sessionFile: string | null; sessionDir: string | null }) => SessionLink[];

/** 动态加载被测导出；缺失时抛出带明确说明的错误（红阶段的预期失败形态之一）。 */
async function loadCollectSessionLinks(): Promise<CollectSessionLinks> {
	const mod = (await import("../src/web/tree.ts")) as Record<string, unknown>;
	const fn = mod.collectSessionLinks;
	if (typeof fn !== "function") {
		throw new Error("collectSessionLinks 未从 src/web/tree.ts 导出（红阶段预期：需 coder 实现）");
	}

	return fn as CollectSessionLinks;
}

// ---------------------------------------------------------------------------
// JSONL 行构造器（形状沿用 test/subagent-web-server.test.ts）
// ---------------------------------------------------------------------------

/** 固定 epoch（2023-11，明确在过去）。 */
const PAST = 1_700_000_000_000;

/** uuid 形状的固定 taskId 生成器（version 4 形状，逐个确定）。 */
function uuid(n: number): string {
	return `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
}

function iso(ms: number): string {
	return new Date(ms).toISOString();
}

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

// ---------------------------------------------------------------------------
// fixture 状态
// ---------------------------------------------------------------------------

let tmpDir: string; // 任务临时根
let rootDir: string; // subagent-sessions 根：<tmpDir>/subagent-sessions
let sessionDir: string; // 被查看任务自己的会话目录：<rootDir>/<taskId>
let sessionFile: string; // 被查看任务自己的会话文件：<sessionDir>/session.jsonl
let childrenFile: string; // 该任务目录下的指针 sidecar：<sessionDir>/children.jsonl
let mainFile: string; // B 组：server 的 mainSessionFile（本文件不测 /api/tree，仅占位）
let registry: Map<string, { status?: string; agentName?: string; task?: string }>;
let handles: WebServerHandle[]; // 本用例启动过的全部句柄，afterEach 统一关闭

beforeEach(() => {
	tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "subagent-web-links-"));
	rootDir = path.join(tmpDir, "subagent-sessions");
	sessionDir = path.join(rootDir, uuid(1));
	fs.mkdirSync(sessionDir, { recursive: true });
	sessionFile = path.join(sessionDir, "session.jsonl");
	childrenFile = path.join(sessionDir, "children.jsonl");
	mainFile = path.join(tmpDir, "main-session.jsonl");
	registry = new Map();
	handles = [];
});

afterEach(async () => {
	for (const handle of handles) {
		try {
			await handle.close();
		} catch {
			/* 清理容错：断言已在用例内完成 */
		}
	}
	delete (globalThis as any).__piSubagentWebServer;
	fs.rmSync(tmpDir, { recursive: true, force: true });
});

/** 覆盖写被查看任务的会话 JSONL。 */
function writeSession(lines: string[]): void {
	fs.writeFileSync(sessionFile, lines.join("\n") + "\n", "utf-8");
}

/** 覆盖写该任务目录下的 children.jsonl 指针 sidecar。 */
function writePointers(records: Array<{ childTaskId: string; agent: string; task: string; startedAt?: number; depth?: number }>): void {
	const body = records.map((record) =>
		JSON.stringify({ startedAt: PAST, depth: 1, ...record }),
	);
	fs.writeFileSync(childrenFile, body.join("\n") + (body.length > 0 ? "\n" : ""), "utf-8");
}

// ================================================================
// A. collectSessionLinks（tree.ts 新增导出）
// ================================================================

describe("collectSessionLinks（收据/指针 → SessionLink）", () => {
	it("should produce a receipt-sourced link when the session contains an async 'Dispatched <agent>. taskId: <uuid>' receipt", async () => {
		// Arrange: 一次 subagent 派发 + 异步收据（无指针）
		const collect = await loadCollectSessionLinks();
		const childId = uuid(101);
		writeSession([
			sessionHeaderLine("main-session", PAST),
			toolCallLine("call-1", "coder", "Implement the fix", PAST),
			receiptLine("call-1", `Dispatched coder. taskId: ${childId}`, PAST + 1_000),
		]);

		// Act
		const links = collect({ sessionFile, sessionDir });

		// Assert: 收据 link —— agent/task 取自 toolCall（call 存在时优先）
		expect(links).toEqual([
			{ toolCallId: "call-1", childTaskId: childId, agent: "coder", task: "Implement the fix", source: "receipt" },
		]);
	});

	it("should produce a receipt-sourced link for the sync '[subagent session: <uuid>]' suffix", async () => {
		// Arrange: 同步派发 —— 收据文本以 [subagent session: <uuid>] 结尾；同步收据
		// 无 receiptAgent，agent 只能来自 toolCall
		const collect = await loadCollectSessionLinks();
		const childId = uuid(102);
		writeSession([
			sessionHeaderLine("main-session", PAST),
			toolCallLine("call-1", "reviewer", "Review the patch", PAST),
			receiptLine("call-1", `Looks good.\n\n[subagent session: ${childId}]`, PAST + 1_000),
		]);

		// Act
		const links = collect({ sessionFile, sessionDir });

		// Assert
		expect(links).toEqual([
			{ toolCallId: "call-1", childTaskId: childId, agent: "reviewer", task: "Review the patch", source: "receipt" },
		]);
	});

	it("should produce a pointer-sourced link for a receipt-less toolCall matched by children.jsonl", async () => {
		// Arrange: 在飞派发 —— toolCall 无收据，children.jsonl 有 agent/task 相同的指针
		const collect = await loadCollectSessionLinks();
		const childId = uuid(103);
		writeSession([
			sessionHeaderLine("main-session", PAST),
			toolCallLine("call-1", "coder", "Implement the fix", PAST),
		]);
		writePointers([{ childTaskId: childId, agent: "coder", task: "Implement the fix" }]);

		// Act
		const links = collect({ sessionFile, sessionDir });

		// Assert: agent/task 取自指针，toolCallId 取自被匹配的 call
		expect(links).toEqual([
			{ toolCallId: "call-1", childTaskId: childId, agent: "coder", task: "Implement the fix", source: "pointer" },
		]);
	});

	it("should produce no link for a toolCall that has neither a receipt nor a matching pointer", async () => {
		// Arrange: 只有 toolCall，无收据、无 children.jsonl
		const collect = await loadCollectSessionLinks();
		writeSession([
			sessionHeaderLine("main-session", PAST),
			toolCallLine("call-1", "coder", "Implement the fix", PAST),
		]);

		// Act
		const links = collect({ sessionFile, sessionDir });

		// Assert: 不产生任何 link（不降级、不猜测）
		expect(links).toEqual([]);
	});

	it("should prefer the receipt over a pointer for the same toolCall and never emit both", async () => {
		// Arrange: toolCall 同时有收据（childA）与指针（childB，agent/task 相同）
		const collect = await loadCollectSessionLinks();
		const childA = uuid(104);
		const childB = uuid(105);
		writeSession([
			sessionHeaderLine("main-session", PAST),
			toolCallLine("call-1", "coder", "Implement the fix", PAST),
			receiptLine("call-1", `Dispatched coder. taskId: ${childA}`, PAST + 1_000),
		]);
		writePointers([{ childTaskId: childB, agent: "coder", task: "Implement the fix" }]);

		// Act
		const links = collect({ sessionFile, sessionDir });

		// Assert: 同一 toolCallId 只出现一次，且收据胜（childTaskId 为收据里的 childA）
		expect(links).toEqual([
			{ toolCallId: "call-1", childTaskId: childA, agent: "coder", task: "Implement the fix", source: "receipt" },
		]);
	});

	it("should match a pointer when agent and task differ from the toolCall only in surrounding whitespace", async () => {
		// Arrange: 指针的 agent/task 原文带首尾空白，去空白后与 toolCall 精确相等
		const collect = await loadCollectSessionLinks();
		const childId = uuid(106);
		writeSession([
			sessionHeaderLine("main-session", PAST),
			toolCallLine("call-1", "coder", "Implement the fix", PAST),
		]);
		writePointers([{ childTaskId: childId, agent: "  coder ", task: " Implement the fix\n" }]);

		// Act
		const links = collect({ sessionFile, sessionDir });

		// Assert: 去首尾空白后精确相等 → 匹配成功（link 的 agent/task 取指针原文）
		expect(links).toEqual([
			{ toolCallId: "call-1", childTaskId: childId, agent: "  coder ", task: " Implement the fix\n", source: "pointer" },
		]);
	});

	it("should not match a pointer whose agent differs beyond surrounding whitespace", async () => {
		// Arrange: 指针 agent 为 "Coder"（大小写不同 → 非精确相等），task 相同；
		// toolCall 无收据 → 无任何 link（不放行模糊匹配）
		const collect = await loadCollectSessionLinks();
		writeSession([
			sessionHeaderLine("main-session", PAST),
			toolCallLine("call-1", "coder", "Implement the fix", PAST),
		]);
		writePointers([{ childTaskId: uuid(107), agent: "Coder", task: "Implement the fix" }]);

		// Act
		const links = collect({ sessionFile, sessionDir });

		// Assert
		expect(links).toEqual([]);
	});

	it("should not match a pointer whose task differs beyond surrounding whitespace", async () => {
		// Arrange: 指针 task 为 "Implement the fix!"（多一个感叹号），agent 相同
		const collect = await loadCollectSessionLinks();
		writeSession([
			sessionHeaderLine("main-session", PAST),
			toolCallLine("call-1", "coder", "Implement the fix", PAST),
		]);
		writePointers([{ childTaskId: uuid(108), agent: "coder", task: "Implement the fix!" }]);

		// Act
		const links = collect({ sessionFile, sessionDir });

		// Assert
		expect(links).toEqual([]);
	});

	it("should return no links when sessionFile is null (no receipt source)", async () => {
		// Arrange: 会话文件缺失（null）—— 无可解析的 toolCall/收据；目录下有指针
		// 也无 call 可匹配
		const collect = await loadCollectSessionLinks();
		writePointers([{ childTaskId: uuid(109), agent: "coder", task: "Implement the fix" }]);

		// Act
		const links = collect({ sessionFile: null, sessionDir });

		// Assert: 不抛错、不产出 link
		expect(links).toEqual([]);
	});

	it("should still return receipt links without any pointer link when sessionDir is null", async () => {
		// Arrange: 会话目录缺失（null）—— 无 children.jsonl 可读；会话含一次收据派发
		// 与一次在飞派发（后者无从匹配指针）
		const collect = await loadCollectSessionLinks();
		const childId = uuid(110);
		writeSession([
			sessionHeaderLine("main-session", PAST),
			toolCallLine("call-1", "coder", "Implement the fix", PAST),
			receiptLine("call-1", `Dispatched coder. taskId: ${childId}`, PAST + 1_000),
			toolCallLine("call-2", "tester", "Write the tests", PAST + 2_000),
		]);

		// Act
		const links = collect({ sessionFile, sessionDir: null });

		// Assert: 只有收据 link，在飞 call 不产生指针 link
		expect(links).toEqual([
			{ toolCallId: "call-1", childTaskId: childId, agent: "coder", task: "Implement the fix", source: "receipt" },
		]);
	});

	it("should order links as receipts first (results order) then pointers (readChildPointers order)", async () => {
		// Arrange: 两次收据派发 + 两条指针（分别匹配 call-3、call-4）
		const collect = await loadCollectSessionLinks();
		const childA = uuid(111);
		const childB = uuid(112);
		const pointerA = uuid(113);
		const pointerB = uuid(114);
		writeSession([
			sessionHeaderLine("main-session", PAST),
			toolCallLine("call-1", "coder", "Task one", PAST),
			receiptLine("call-1", `Dispatched coder. taskId: ${childA}`, PAST + 1_000),
			toolCallLine("call-2", "reviewer", "Task two", PAST + 2_000),
			receiptLine("call-2", `Dispatched reviewer. taskId: ${childB}`, PAST + 3_000),
			toolCallLine("call-3", "tester", "Task three", PAST + 4_000),
			toolCallLine("call-4", "ops", "Task four", PAST + 5_000),
		]);
		writePointers([
			{ childTaskId: pointerA, agent: "tester", task: "Task three" },
			{ childTaskId: pointerB, agent: "ops", task: "Task four" },
		]);

		// Act
		const links = collect({ sessionFile, sessionDir });

		// Assert: 前两条为收据（results 顺序），后两条为指针（读取顺序）
		expect(links.map((link) => link.source)).toEqual(["receipt", "receipt", "pointer", "pointer"]);
		expect(links.map((link) => link.childTaskId)).toEqual([childA, childB, pointerA, pointerB]);
		expect(links.map((link) => link.toolCallId)).toEqual(["call-1", "call-2", "call-3", "call-4"]);
	});

	it("should never readdir the sessions root while collecting links", async () => {
		// Arrange: 收据与指针齐备的真实 fixture；断言前清空 spy 记录
		const collect = await loadCollectSessionLinks();
		const childA = uuid(115);
		const pointerA = uuid(116);
		writeSession([
			sessionHeaderLine("main-session", PAST),
			toolCallLine("call-1", "coder", "Task one", PAST),
			receiptLine("call-1", `Dispatched coder. taskId: ${childA}`, PAST + 1_000),
			toolCallLine("call-2", "tester", "Task two", PAST + 2_000),
		]);
		writePointers([{ childTaskId: pointerA, agent: "tester", task: "Task two" }]);
		readdirSyncSpy.mockClear();

		// Act
		const links = collect({ sessionFile, sessionDir });

		// Assert: 两条 link 正常产出，且构建期间 readdirSync 从未以 rootDir 为参数
		//（指针走 openSync(children.jsonl)、会话走 readFileSync —— 都不需要枚举根目录）
		expect(links).toHaveLength(2);
		const rootReaddirCalls = readdirSyncSpy.mock.calls.filter((call) => path.resolve(String(call[0])) === path.resolve(rootDir));
		expect(rootReaddirCalls).toHaveLength(0);
	});
});

// ================================================================
// B. server.ts：/api/session links 字段 + port 选项（真实起服务）
// ================================================================

// ---------------------------------------------------------------------------
// HTTP 辅助（真实请求；agent:false = 每请求独立连接，不留 keep-alive 连接）
// ---------------------------------------------------------------------------

interface RawResponse {
	status: number;
	headers: http.IncomingHttpHeaders;
	body: string;
}

function request(port: number, requestPath: string): Promise<RawResponse> {
	return new Promise((resolve, reject) => {
		const req = http.request({ host: "127.0.0.1", port, path: requestPath, method: "GET", agent: false }, (res) => {
			const chunks: Buffer[] = [];
			res.on("data", (chunk: Buffer) => chunks.push(chunk));
			res.on("end", () => {
				resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString("utf-8") });
			});
		});
		req.on("error", reject);
		req.end();
	});
}

/** 带合法 token 的会话读取路径。 */
function sessionPath(taskId: string, token: string): string {
	return `/api/session?${new URLSearchParams({ taskId, offset: "0", tail: "0", t: token }).toString()}`;
}

function parseJson(res: RawResponse): any {
	return JSON.parse(res.body);
}

/** 起服务并登记句柄；extra 以 Record 承载尚不存在的 port 选项（红阶段不触发类型错误）。 */
async function start(extra: Record<string, unknown> = {}): Promise<WebServerHandle> {
	const handle = await startWebServer({
		mainSessionFile: () => mainFile,
		registry,
		rootDir,
		...extra,
	} as StartWebServerOptions);
	handles.push(handle);

	return handle;
}

/** 申请一个当前空闲的端口（临时服务 listen(0) 后立即释放）。 */
function findFreePort(): Promise<number> {
	return new Promise((resolve, reject) => {
		const probe = http.createServer();
		probe.once("error", reject);
		probe.listen(0, "127.0.0.1", () => {
			const address = probe.address();
			const port = typeof address === "object" && address !== null ? address.port : 0;
			probe.close(() => resolve(port));
		});
	});
}

/** 写被查看任务的会话文件（B 组场景在 rootDir/<taskId>/ 下）。 */
function writeTaskSession(taskId: string, lines: string[]): string {
	const dir = path.join(rootDir, taskId);
	fs.mkdirSync(dir, { recursive: true });
	const filePath = path.join(dir, "session.jsonl");
	fs.writeFileSync(filePath, lines.join("\n") + "\n", "utf-8");

	return filePath;
}

/** 写被查看任务目录下的 children.jsonl 指针 sidecar。 */
function writeTaskPointers(taskId: string, records: Array<{ childTaskId: string; agent: string; task: string }>): void {
	const body = records.map((record) => JSON.stringify({ startedAt: PAST, depth: 1, ...record }));
	fs.writeFileSync(path.join(rootDir, taskId, "children.jsonl"), body.join("\n") + "\n", "utf-8");
}

// ------------------------------------------------------------
// B1. /api/session 响应 links 字段
// ------------------------------------------------------------

describe("/api/session 响应 links 字段", () => {
	it("should include a links array with the receipt-sourced link of the viewed task's own session", async () => {
		// Arrange: 被查看任务的会话文件含一次派发 + 异步收据
		const handle = await start();
		const taskId = uuid(201);
		const childId = uuid(202);
		writeTaskSession(taskId, [
			sessionHeaderLine(taskId, PAST),
			toolCallLine("call-1", "coder", "Implement the fix", PAST),
			receiptLine("call-1", `Dispatched coder. taskId: ${childId}`, PAST + 1_000),
		]);

		// Act
		const res = await request(handle.port, sessionPath(taskId, handle.token));

		// Assert: 成功响应体含 links，内容为该会话的收据 link
		expect(res.status).toBe(200);
		const body = parseJson(res);
		expect(Array.isArray(body.links)).toBe(true);
		expect(body.links).toEqual([
			{ toolCallId: "call-1", childTaskId: childId, agent: "coder", task: "Implement the fix", source: "receipt" },
		]);
	});

	it("should include a pointer-sourced link from the viewed task's own children.jsonl sidecar", async () => {
		// Arrange: 被查看任务的会话含在飞派发（无收据），其目录下 children.jsonl
		// 记录匹配指针 —— 指针必须来自「该被查看任务自己目录」而非别处
		const handle = await start();
		const taskId = uuid(203);
		const childId = uuid(204);
		writeTaskSession(taskId, [
			sessionHeaderLine(taskId, PAST),
			toolCallLine("call-1", "tester", "Write the tests", PAST),
		]);
		writeTaskPointers(taskId, [{ childTaskId: childId, agent: "tester", task: "Write the tests" }]);

		// Act
		const res = await request(handle.port, sessionPath(taskId, handle.token));

		// Assert
		expect(res.status).toBe(200);
		const body = parseJson(res);
		expect(Array.isArray(body.links)).toBe(true);
		expect(body.links).toEqual([
			{ toolCallId: "call-1", childTaskId: childId, agent: "tester", task: "Write the tests", source: "pointer" },
		]);
	});

	it("should always include links (as an empty array) for a session without any dispatch", async () => {
		// Arrange: 普通会话文件，无派发记录
		const handle = await start();
		const taskId = uuid(205);
		writeTaskSession(taskId, [sessionHeaderLine(taskId, PAST)]);

		// Act
		const res = await request(handle.port, sessionPath(taskId, handle.token));

		// Assert: 字段永远存在，无派发时为空数组
		expect(res.status).toBe(200);
		const body = parseJson(res);
		expect(Object.prototype.hasOwnProperty.call(body, "links")).toBe(true);
		expect(body.links).toEqual([]);
	});
});

// ------------------------------------------------------------
// B2. StartWebServerOptions.port
// ------------------------------------------------------------

describe("startWebServer port 选项", () => {
	it("should bind a random ephemeral port when the port option is omitted (default unchanged)", async () => {
		// Arrange / Act: 不传 port（默认行为必须与现状一致）
		const handle = await start();

		// Assert: 随机端口可用且服务可达
		expect(handle.port).toBeGreaterThan(0);
		const res = await request(handle.port, `/?t=${handle.token}`);
		expect(res.status).toBe(200);
	});

	it("should treat an explicit port of 0 as a random ephemeral port", async () => {
		// Arrange / Act: 传 0 等价随机
		const handle = await start({ port: 0 });

		// Assert
		expect(handle.port).toBeGreaterThan(0);
		const res = await request(handle.port, `/?t=${handle.token}`);
		expect(res.status).toBe(200);
	});

	it("should bind exactly the requested port when a concrete port is provided", async () => {
		// Arrange: 先取一个当前空闲的端口
		const wanted = await findFreePort();

		// Act
		const handle = await start({ port: wanted });

		// Assert: handle.port 等于指定端口，且该端口真实可达
		expect(handle.port).toBe(wanted);
		const res = await request(wanted, `/?t=${handle.token}`);
		expect(res.status).toBe(200);
	});

	it("should reject (not swallow) when the requested port is already occupied", async () => {
		// Arrange: 占住一个端口
		const occupier = http.createServer();
		const occupiedPort = await new Promise<number>((resolve, reject) => {
			occupier.once("error", reject);
			occupier.listen(0, "127.0.0.1", () => {
				const address = occupier.address();
				resolve(typeof address === "object" && address !== null ? address.port : 0);
			});
		});

		// Act: 尝试在被占用的端口上启动（EPERM/EADDRINUSE 必须 reject）
		let started: WebServerHandle | null = null;
		let error: unknown = null;
		try {
			started = await start({ port: occupiedPort });
		} catch (caught) {
			error = caught;
		}
		// 清理：红阶段实现若忽略了 port（错误地绑上随机端口成功），把泄漏句柄关掉再断言
		if (started !== null) await started.close();
		await new Promise<void>((resolve) => occupier.close(() => resolve()));

		// Assert: 必须 reject，不得静默绑到别的端口继续跑
		expect(error).not.toBeNull();
		expect(started).toBeNull();
	});
});
