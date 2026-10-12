/**
 * 红阶段测试：`src/web/server.ts` —— 本地 HTTP 服务追踪 subagent 会话的
 * 第三个模块（真实起服务 + 真实 HTTP 请求，端口 0 随机分配）。模块尚不存在，
 * 本文件整体红属预期。
 *
 * 被测接口（固定签名，实现者照此实现）：
 *   startWebServer(opts): Promise<WebServerHandle>
 *   opts = {
 *     mainSessionFile: () => string | null;               // 每请求现取主会话文件路径
 *     registry: Map<string, { status?, agentName?, task? }>;
 *     rootDir: string;                                    // subagent-sessions 根
 *     validateTaskId?: (taskId: unknown) => string | null; // 返回错误串或 null
 *     resolveSessionDir?: (taskId: string) => string;      // 穿越时抛错
 *     findSessionFile?: (taskId: string) => string | null; // 目录内 mtime 最新 .jsonl
 *     completedTasks?: () => ReadonlyMap<
 *       string, { status?: string; finishedAt: number }
 *     >;                       // /api/tree 构建时现取完成记录只读快照，透传给 buildSessionTree
 *   }
 *   handle = { port, url, token, close() }；url = http://127.0.0.1:<port>/?t=<token>；
 *   token = crypto.randomBytes(16).toString("hex")；close() 幂等。
 *   单例存于 globalThis.__piSubagentWebServer，暴露底层 server（node:http Server）
 *   与 token。
 *
 * 请求校验（顺序：方法 → Host → Origin → token）：
 *   非 GET → 405；Host 不匹配 ^(127\.0\.0\.1|localhost|\[::1\]):<port>$ → 403
 *   （防 DNS rebinding）；有 Origin 头且不匹配 ^http://(127\.0\.0\.1|localhost):<port>$
 *   → 403；?t= 不等于 token → 403。错误响应与 /api/session、/api/image 一律
 *   Cache-Control: no-store；/api/tree 的 200/304 用 Cache-Control: no-cache
 *  （ETag 内容派生，可复用）；JSON 用 application/json; charset=utf-8。
 *
 * 路由：
 *   GET /                     → 页面 HTML（来自 page.ts 的 PAGE_HTML）
 *   GET /api/tree             → { apiVersion: 2, nodes: [...],
 *                               truncated: { total, showing, dropped },
 *                               expand: null | { taskId, children } } 对象；
 *                               ?expand=<taskId> 调 buildSubtree 展开直属子节点：
 *                               非 UUID 形 400 {error}、../ 穿越 403 {error}、
 *                               会话不存在 → 200 且 expand: null
 *   GET /api/session?taskId=..&offset=..&tail=0|1[&before=N]
 *                             → { taskId, offset, nextOffset, size, mtime, links,
 *                                entries, malformed, truncatedBefore, hasMore,
 *                                oversizeLine, entriesStartOffset }
 *   before=<非负整数>（与既有 offset 互斥使用）→ 走 readBefore 反向字节窗口回读，
 *   供客户端自动向前补齐（替代旧的「Load earlier / MAX_ENTRIES 截断」）：
 *     · 前向（普通/tail）：entriesStartOffset = 本次首条 entry 的 entryOffsets[0]，
 *       无 entries 时 = 本次 offset；
 *     · 反向（before）：entriesStartOffset = readBefore 的 startOffset，
 *       offset/nextOffset 回显为 before（客户端忽略），truncatedBefore =
 *       startOffset > 0（裁决：startOffset 0 = 已到文件开头 = false，
 *       reviewer 曾主张 mid-file 场景为 true，系误读，维持既定契约），
 *       hasMore = false；反向读取同样 stripImages（沿用
 *       entryOffsets），base64 图片绝不下发；既有字段全部保持。
 *   未知 taskId / 无会话文件 → 404 JSON { error: string }；
 *   taskId 非 UUID 形 → 400；路径穿越 / 符号链接逃逸（realpath 不在 rootDir
 *   前缀内）→ 403。注意校验顺序：`../` 类穿越必须先于 UUID 形状检查判 403
 *   （否则与「路径穿越 → 403」用例矛盾），非穿越的非 UUID 形才判 400。
 *
 * 用例清单（编号对应验收清单 1–12）：
 *   1. 无 token → 403（并断言 no-store）
 *   2. 错 Host（evil.example.com:<port>）→ 403
 *   3. 错 Origin（http://evil.example.com）→ 403
 *   4. POST → 405（方法检查先于其余检查）
 *   5. 未知（UUID 形）taskId → 404，body 为 { error: string } + JSON content-type
 *   5b. 非穿越的非 UUID 形 taskId → 400（钉住与 403 的顺序关系）
 *   6. 路径穿越 taskId（../outside）→ 403
 *   7. 任务目录为指向 rootDir 外的符号链接（realpath 逃逸）→ 403
 *   8. 连续两次 GET /api/session（第二次带上次 nextOffset）→ 只回新增 entry，
 *      nextOffset 单调递增
 *   9. /api/tree → 对象结构：apiVersion === 2、nodes 数组（根 = 主会话异步收据
 *      派发的任务）、truncated 三值、expand: null；每个节点含 childCount/childSummary
 *   10. close() 幂等（两次调用不抛）；关闭后再请求连接被拒（ECONNREFUSED）
 *   11. /reload 模拟：vi.resetModules() 后重新动态 import 并再次 startWebServer
 *       → 端口与 token 不变，旧 token 仍可访问
 *   12. 只监听 127.0.0.1（读 globalThis.__piSubagentWebServer.server.address()）
 *
 * /api/tree 性能修复新增用例：
 *   13. /api/tree ETag：首响应带引号 ETag + no-cache；If-None-Match 命中 → 304
 *       空 body + no-cache；主会话文件 size+mtime 变化 → 200 且新 ETag 不同
 *   14. /api/session 响应含布尔字段 oversizeLine（普通小文件为 false）
 *   15. Origin 白名单含 IPv6 环回 http://[::1]:<port> → 200（Host/token 均合法）
 *   16. 通用（非 v7）UUID 形 taskId 的会话可读 → 200（默认校验为通用 UUID 形状）
 *   17. taskId 穿越到与 rootDir basename 共享前缀的兄弟目录（subagent-sessions-evil）
 *       → 403（朴素 startsWith(root) 会把 subagent-sessions-evil* 误判在 root 内）
 *   18. UUID 形任务目录为指向 rootDir 同名前缀兄弟目录的符号链接 → 403 且不泄露
 *       兄弟目录内容（realpath 守卫若退化为纯词法/朴素前缀匹配会被打穿到 200）
 *
 * ETag 反映状态变化的新增用例：
 *   19. 新建一个 UUID 任务目录使 rootDir mtime 变化 → 用旧 ETag 发 If-None-Match
 *       → 200 且新 ETag ≠ 旧（不得被 304 冻结）
 *   20. 向 opts.registry 写入一条（树结构不变，registry 摘要变）→ 旧 ETag 请求
 *       → 200 且 ETag 变化
 *
 * 内容派生 ETag（移除 10 秒时间桶；vi.spyOn(Date, "now") 前移墙钟验证与时间无关）：
 *   21. t0 → 200 记 ETag；墙钟前移 1 小时后带同一 If-None-Match → 304 空 body
 *       （内容不变必须 304，无论时间）；随后 registry 变化 → 200 且新 ETag ≠ 旧；
 *       普通请求 body 为 { apiVersion, nodes, truncated, expand } 对象
 *
 * /api/session 的 apiVersion 与 expand 参数新增用例：
 *   31. /api/session 前向（offset）与反向（before）分支的 200 响应均带
 *       apiVersion: 2
 *   32. ?expand= 非 UUID 形 → 400 { error: "Invalid taskId" }（no-store）；
 *       ../ 穿越 → 403 { error: "Forbidden" }（no-store）；合法但会话不存在 →
 *       200 且 expand: null；成功 → expand { taskId, children }（children 来自
 *       buildSubtree：depth 1、200 字符 task 截断 + taskTruncated、childCount、
 *       childSummary）
 *   33. expand 参数纳入 ETag：同内容不同 expand 带旧 If-None-Match → 200 新 ETag
 *
 * completedTasks 注入的新增用例：
 *   29. opts.completedTasks 注入生效：异步收据 childId + 子会话 mtime = 当前
 *       （本会判 recent），注入完成记录 → /api/tree 该节点 status "finished"
 *       且 finishedAt 等于注入值
 *   30. completedTasks 快照变化使旧 ETag 失效（内容派生指纹纳入快照摘要，
 *       墙钟钉死仅保证用例确定性）
 *
 * entriesStartOffset 与 before 反向回读（客户端自动向前补齐）新增用例：
 *   22. 前向响应含数字 entriesStartOffset = 首条 entry 的文件字节起始偏移
 *       （全量读 = 0；按行边界续读 = 该行绝对偏移；空增量 = 本次 offset）
 *   23. before=size → 全部 entries、entriesStartOffset 0、offset/nextOffset
 *       回显 before、truncatedBefore false、hasMore false
 *   24. 从 size 起循环 before = entriesStartOffset 到 0（fixture 含 >1 MiB 单行、
 *       跨越多 1 MiB 分片，参照序列手工解析而非一次前向读取），拼接片段与参照
 *       逐条相等（顺序、无重复、无丢失）且到达 0
 *   25. before 落在行中间 → entries 恰为该区间之前的完整行，entriesStartOffset < before；
 *       本 fixture 已回到文件开头（entriesStartOffset === 0）→ truncatedBefore === false
 *   26. 反向响应不下发 base64 图片（stripImages 沿用 entryOffsets → imageRef）
 *   27. 越界/非法 before（负数、非数字、超 size）→ 确定性回落 0/ clamp，一律 200，
 *       随后正常请求仍 200
 *   28. tail=1 首屏在「文件 >512 KiB 且尾窗口内无换行」时返回空 entries +
 *       truncatedBefore true，entriesStartOffset 必须是可继续向前回读的有界非零
 *       字节偏移（不得回落请求 offset 0），据此发起 before= 能拉回头部行
 *
 * 约定（沿仓库惯例，同 test/subagent-web-tail.test.ts）：globals:false 显式
 * import from "vitest"；fixture 用 fs.mkdtempSync(os.tmpdir()) + afterEach 递归
 * 删除；真实起服务（端口 0）、真实 http.request（agent:false 单连接，不留
 * keep-alive 连接拖住 close()）；用完必须 await handle.close()。
 */

import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { getGlobalServer } from "../src/web/server.ts";
import type { StartWebServerOptions, WebServerHandle } from "../src/web/server.ts";

type ServerModule = typeof import("../src/web/server.ts");
type RegistryEntry = { status?: string; agentName?: string; task?: string };

// ---------------------------------------------------------------------------
// JSONL 行构造器（形状同 test/subagent-web-tree.test.ts：真实数据形状）
// ---------------------------------------------------------------------------

/** 固定 epoch（2023-11，明确在过去；用例 9 依赖墙钟 now 判定 mtime 已过 recent 窗口）。 */
const PAST = 1_700_000_000_000;

/**
 * 钉死墙钟的基准时刻。新契约的 /api/tree ETag 与时间无关（无 10s 桶），
 * 钉钟仅为用例确定性（内容变化/不变化的判定不依赖真实时钟）。
 */
const T0 = 1_700_000_010_000;

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

/** 父会话里一条 toolResult 消息，text 为异步派发收据文本。 */
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

/** 子会话 JSONL 行：session 头 + 首条 user（"Task: <task>"）+ assistant 文本。 */
function childSessionLines(taskId: string, task: string, ts: number): string[] {
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
	];
}

// ---------------------------------------------------------------------------
// fixture 状态
// ---------------------------------------------------------------------------

let tmpDir: string; // 任务临时根
let rootDir: string; // subagent-sessions 根：<tmpDir>/subagent-sessions
let mainFile: string; // 主会话 JSONL：<tmpDir>/main-session.jsonl
let registry: Map<string, RegistryEntry>;
let handles: WebServerHandle[]; // 本用例启动过的全部句柄，afterEach 统一关闭

beforeEach(() => {
	tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "subagent-web-server-"));
	rootDir = path.join(tmpDir, "subagent-sessions");
	fs.mkdirSync(rootDir, { recursive: true });
	mainFile = path.join(tmpDir, "main-session.jsonl");
	registry = new Map();
	handles = [];
});

afterEach(async () => {
	// 关闭服务（close 幂等；接管场景下旧句柄也必须可安全关闭）
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

// ---------------------------------------------------------------------------
// 被测模块加载 + 服务启动
// ---------------------------------------------------------------------------

/** 动态 import 被测模块（配合 vi.resetModules() 模拟 /reload）。 */
async function loadServer(): Promise<ServerModule> {
	return (await import("../src/web/server.ts")) as ServerModule;
}

function makeOptions(overrides: Partial<StartWebServerOptions> = {}): StartWebServerOptions {
	return { mainSessionFile: () => mainFile, registry, rootDir, ...overrides };
}

async function start(overrides: Partial<StartWebServerOptions> = {}): Promise<WebServerHandle> {
	const mod = await loadServer();
	const handle = await mod.startWebServer(makeOptions(overrides));
	handles.push(handle);

	return handle;
}

// ---------------------------------------------------------------------------
// fixture 落盘
// ---------------------------------------------------------------------------

/** 写主会话 JSONL（覆盖写）。 */
function writeMain(lines: string[]): void {
	fs.writeFileSync(mainFile, lines.join("\n") + "\n", "utf-8");
}

/**
 * 写子会话：<rootDir>/<taskId>/<ISO>_<taskId>.jsonl，并把文件与目录 mtime
 * 显式设定为 mtimeMs（默认 = 1 小时前 → 状态确定为 "finished"）。
 */
function writeChildSession(taskId: string, task: string, mtimeMs: number = Date.now() - 3_600_000): string {
	const dir = path.join(rootDir, taskId);
	fs.mkdirSync(dir, { recursive: true });
	const filePath = path.join(dir, `${iso(mtimeMs)}_${taskId}.jsonl`);
	fs.writeFileSync(filePath, childSessionLines(taskId, task, mtimeMs).join("\n") + "\n", "utf-8");
	const d = new Date(mtimeMs);
	fs.utimesSync(filePath, d, d);
	fs.utimesSync(dir, d, d);

	return filePath;
}

// ---------------------------------------------------------------------------
// HTTP 辅助（真实请求；agent:false = 每请求独立连接，不留 keep-alive 连接）
// ---------------------------------------------------------------------------

interface RawResponse {
	status: number;
	headers: http.IncomingHttpHeaders;
	body: string;
}

interface RequestOptions {
	method?: string;
	headers?: http.OutgoingHttpHeaders;
}

function request(port: number, requestPath: string, opts: RequestOptions = {}): Promise<RawResponse> {
	return new Promise((resolve, reject) => {
		const req = http.request(
			{ host: "127.0.0.1", port, path: requestPath, method: opts.method ?? "GET", agent: false, headers: opts.headers ?? {} },
			(res) => {
				const chunks: Buffer[] = [];
				res.on("data", (chunk: Buffer) => chunks.push(chunk));
				res.on("end", () => {
					resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString("utf-8") });
				});
			},
		);
		req.on("error", reject);
		req.end();
	});
}

/** 断言端口已释放：再发请求必须得到连接层错误（ECONNREFUSED）。 */
function expectConnectionRefused(port: number): Promise<void> {
	return new Promise((resolve, reject) => {
		const req = http.request({ host: "127.0.0.1", port, path: "/", method: "GET", agent: false }, () => {
			reject(new Error(`port ${port} 仍可连接：close() 后必须拒绝连接`));
		});
		req.on("error", (err: NodeJS.ErrnoException) => {
			if (err.code === "ECONNREFUSED") resolve();
			else reject(new Error(`期望 ECONNREFUSED，实际 ${err.code ?? err.message}`));
		});
		req.end();
	});
}

/** JSON 响应头统一断言：content-type 为 application/json; charset=utf-8 且 no-store。 */
function expectJsonHeaders(res: RawResponse): void {
	expect(res.headers["content-type"]).toBe("application/json; charset=utf-8");
	expect(res.headers["cache-control"]).toBe("no-store");
}

/** /api/tree 成功响应头断言：JSON content-type + no-cache（ETag 内容派生，可复用）。 */
function expectTreeHeaders(res: RawResponse): void {
	expect(res.headers["content-type"]).toBe("application/json; charset=utf-8");
	expect(res.headers["cache-control"]).toBe("no-cache");
}

function parseJson(res: RawResponse): any {
	return JSON.parse(res.body);
}

/**
 * 解析 /api/tree 的对象响应并断言新契约结构：apiVersion === 2、nodes 为数组、
 * truncated 恰为 {total, showing, dropped} 三个数字、expand 字段存在（值由用例另行断言）。
 */
function parseTree(res: RawResponse): {
	apiVersion: number;
	nodes: any[];
	truncated: { total: number; showing: number; dropped: number };
	expand: any;
} {
	const body = parseJson(res);
	expect(body.apiVersion).toBe(2);
	expect(Array.isArray(body.nodes)).toBe(true);
	expect(typeof body.truncated).toBe("object");
	expect(Object.keys(body.truncated).sort()).toEqual(["dropped", "showing", "total"]);
	for (const key of ["total", "showing", "dropped"]) {
		expect(typeof body.truncated[key]).toBe("number");
	}
	expect(body).toHaveProperty("expand");
	return body;
}

/** 带合法 token 的会话读取路径。 */
function sessionPath(taskId: string, token: string, extra: Record<string, string> = {}): string {
	const params = new URLSearchParams({ taskId, offset: "0", tail: "0", t: token, ...extra });

	return `/api/session?${params.toString()}`;
}

// ================================================================
// 1–4. 请求校验：方法 → Host → Origin → token
// ================================================================

describe("请求校验（方法 → Host → Origin → token）", () => {
	it("should return 403 with no-store when the token query parameter is missing", async () => {
		// Arrange
		const handle = await start();

		// Act
		const res = await request(handle.port, "/api/tree");

		// Assert
		expect(res.status).toBe(403);
		expect(res.headers["cache-control"]).toBe("no-store");
	});

	it("should return 403 when the Host header does not match loopback with the server port", async () => {
		// Arrange
		const handle = await start();

		// Act: 连到正确端口但 Host 伪造为外部域名（DNS rebinding 形状）
		const res = await request(handle.port, `/api/tree?t=${handle.token}`, {
			headers: { Host: `evil.example.com:${handle.port}` },
		});

		// Assert
		expect(res.status).toBe(403);
	});

	it("should return 403 when the Origin header does not match the server origin", async () => {
		// Arrange
		const handle = await start();

		// Act
		const res = await request(handle.port, `/api/tree?t=${handle.token}`, {
			headers: { Origin: "http://evil.example.com" },
		});

		// Assert
		expect(res.status).toBe(403);
	});

	it("should allow the request when the Origin header is the server's own loopback origin", async () => {
		// Arrange: 其余校验全部合法（正确 Host + 合法 token），Origin 为服务自身 loopback origin
		const handle = await start();

		// Act
		const res = await request(handle.port, `/api/tree?t=${handle.token}`, {
			headers: { Origin: `http://localhost:${handle.port}` },
		});

		// Assert: 正向用例 —— 合法 loopback Origin 必须放行，不得过度拦截
		expect(res.status).toBe(200);
		expectTreeHeaders(res);
		expect(Array.isArray(parseTree(res).nodes)).toBe(true);
	});

	it("should allow the request when the Origin header is the bracketed IPv6 loopback origin", async () => {
		// Arrange: Host（默认 127.0.0.1:<port>）与 token 均合法，仅 Origin 为 IPv6 环回
		const handle = await start();

		// Act
		const res = await request(handle.port, `/api/tree?t=${handle.token}`, {
			headers: { Origin: `http://[::1]:${handle.port}` },
		});

		// Assert: 正向用例 —— [::1] 必须在 Origin 白名单内，不得过度拦截
		expect(res.status).toBe(200);
		expectTreeHeaders(res);
		expect(Array.isArray(parseTree(res).nodes)).toBe(true);
	});

	it("should return 405 when the request method is not GET", async () => {
		// Arrange
		const handle = await start();

		// Act: 其余校验全部合法，只有方法非法
		const res = await request(handle.port, `/?t=${handle.token}`, { method: "POST" });

		// Assert
		expect(res.status).toBe(405);
		expect(res.headers["cache-control"]).toBe("no-store");
	});
});

// ================================================================
// 5–7 + 5b. taskId 校验与错误响应
// ================================================================

describe("taskId 校验与错误响应", () => {
	it("should return 404 with a JSON error body when the taskId is unknown", async () => {
		// Arrange: 合法 UUID 形状但 rootDir 下无该任务目录
		const handle = await start();
		const unknownId = uuid(99);

		// Act
		const res = await request(handle.port, sessionPath(unknownId, handle.token));

		// Assert
		expect(res.status).toBe(404);
		expectJsonHeaders(res);
		const body = parseJson(res);
		expect(body).toHaveProperty("error");
		expect(typeof body.error).toBe("string");
		expect(body.error.length).toBeGreaterThan(0);
		expect(Object.keys(body)).toEqual(["error"]);
	});

	it("should return 400 when the taskId is not UUID-shaped and does not traverse", async () => {
		// Arrange: 非穿越、非 UUID 形 → 形状校验的 400（与穿越 403 的顺序关系由此钉住）
		const handle = await start();

		// Act
		const res = await request(handle.port, sessionPath("not-a-uuid", handle.token));

		// Assert
		expect(res.status).toBe(400);
	});

	it("should return 403 when the taskId traverses outside the sessions root", async () => {
		// Arrange: rootDir 同级放置真实的外部会话文件，taskId 用 ../ 穿越过去
		const handle = await start();
		const outsideDir = path.join(tmpDir, "outside");
		fs.mkdirSync(outsideDir, { recursive: true });
		fs.writeFileSync(path.join(outsideDir, "session.jsonl"), '{"seq":1}\n', "utf-8");

		// Act
		const res = await request(handle.port, sessionPath(`../outside`, handle.token));

		// Assert
		expect(res.status).toBe(403);
	});

	it("should return 403 when the task directory is a symlink escaping the sessions root", async () => {
		// Arrange: 任务目录本身是指向 rootDir 外目录的符号链接（realpath 逃逸）；
		// 外部目录内含真实 .jsonl（无论实现校验目录还是文件的 realpath 都应判 403）
		const handle = await start();
		const escapeId = uuid(7);
		const outsideDir = path.join(tmpDir, "escape-target");
		fs.mkdirSync(outsideDir, { recursive: true });
		fs.writeFileSync(path.join(outsideDir, "session.jsonl"), '{"seq":1}\n', "utf-8");
		fs.symlinkSync(outsideDir, path.join(rootDir, escapeId), "dir");

		// Act
		const res = await request(handle.port, sessionPath(escapeId, handle.token));

		// Assert
		expect(res.status).toBe(403);
	});

	it("should return 403 when the taskId traverses into a sibling directory sharing the sessions root name prefix", async () => {
		// Arrange: 兄弟目录名以 rootDir 的 basename 为前缀（subagent-sessions-evil），
		// 内含真实会话文件；朴素 child.startsWith(parent) 会把它误判在 root 内
		const handle = await start();
		const escapeId = uuid(11);
		const siblingDir = path.join(tmpDir, "subagent-sessions-evil", escapeId);
		fs.mkdirSync(siblingDir, { recursive: true });
		fs.writeFileSync(path.join(siblingDir, "session.jsonl"), '{"seq":1,"text":"PREFIX-SIBLING-SENTINEL"}\n', "utf-8");

		// Act
		const res = await request(handle.port, sessionPath(`../subagent-sessions-evil/${escapeId}`, handle.token));

		// Assert: 词法包含性守卫必须先于形状校验判 403，且不泄露兄弟目录内容
		expect(res.status).toBe(403);
		expect(res.body).not.toContain("PREFIX-SIBLING-SENTINEL");
		expectJsonHeaders(res);
	});

	it("should return 403 when the task directory symlinks to a sibling sharing the sessions root name prefix", async () => {
		// Arrange: UUID 形任务目录（词法在 root 内）是指向 rootDir 同名前缀兄弟目录的
		// 符号链接；realpath 守卫若退化为朴素 startsWith(root)，
		// <tmp>/subagent-sessions-evil 会被误判在 <tmp>/subagent-sessions 内
		const handle = await start();
		const escapeId = uuid(12);
		const siblingDir = path.join(tmpDir, "subagent-sessions-evil");
		fs.mkdirSync(siblingDir, { recursive: true });
		fs.writeFileSync(path.join(siblingDir, "session.jsonl"), '{"seq":1,"text":"PREFIX-ESCAPE-SENTINEL"}\n', "utf-8");
		fs.symlinkSync(siblingDir, path.join(rootDir, escapeId), "dir");

		// Act
		const res = await request(handle.port, sessionPath(escapeId, handle.token));

		// Assert: 403，且响应体绝不包含兄弟目录的哨兵串
		expect(res.status).toBe(403);
		expect(res.body).not.toContain("PREFIX-ESCAPE-SENTINEL");
		expectJsonHeaders(res);
	});

	it("should return 403 or 404 without leaking the target when the session file inside the task directory is a symlink escaping the sessions root", async () => {
		// Arrange: 任务目录是 rootDir 内的真实目录，但目录内的 .jsonl 是指向
		// rootDir 外部文件的符号链接（文件级 realpath 逃逸）；外部文件含哨兵串
		const handle = await start();
		const escapeId = uuid(8);
		const dir = path.join(rootDir, escapeId);
		fs.mkdirSync(dir, { recursive: true });
		const sentinel = "OUTSIDE-SENTINEL-c91f4b";
		const outsideFile = path.join(tmpDir, "outside-session.jsonl");
		fs.writeFileSync(outsideFile, JSON.stringify({ seq: 1, text: sentinel }) + "\n", "utf-8");
		fs.symlinkSync(outsideFile, path.join(dir, `${iso(PAST)}_${escapeId}.jsonl`));

		// Act
		const res = await request(handle.port, sessionPath(escapeId, handle.token));

		// Assert: 拒绝（403/404 皆可），且响应体绝不包含外部文件的哨兵串
		expect([403, 404]).toContain(res.status);
		expect(res.body).not.toContain(sentinel);
		expectJsonHeaders(res);
		const body = parseJson(res);
		expect(typeof body.error).toBe("string");
		expect(body.error.length).toBeGreaterThan(0);
	});

	it("should read a session when the taskId is a generic (non-v7) UUID shape", async () => {
		// Arrange: v4 形状的 taskId 目录 + 会话文件（默认校验为通用 UUID 形状，非 v7 专用）
		const handle = await start();
		const taskId = uuid(43);
		const dir = path.join(rootDir, taskId);
		fs.mkdirSync(dir, { recursive: true });
		const filePath = path.join(dir, `${iso(PAST)}_${taskId}.jsonl`);
		fs.writeFileSync(filePath, '{"seq":1,"text":"v4 task"}\n', "utf-8");

		// Act
		const res = await request(handle.port, sessionPath(taskId, handle.token));

		// Assert: 通用 UUID 形状即可读（若实现收紧为 v7-only，这里会变 400）
		expect(res.status).toBe(200);
		expectJsonHeaders(res);
		const body = parseJson(res);
		expect(body.taskId).toBe(taskId);
		expect(body.entries).toEqual([{ seq: 1, text: "v4 task" }]);
	});
});

// ================================================================
// 畸形请求目标（GET //）
// ================================================================

describe("畸形请求目标", () => {
	it("should return 400 with a JSON error body for the request target `//` and keep serving subsequent requests", async () => {
		// Arrange
		const handle = await start();

		// Act 1: 请求目标为 "//"（协议相对 URL，解析必失败），不带 token
		const bad = await request(handle.port, "//");

		// Assert 1: 400 + JSON {error: string} + no-store，而非进程崩溃/连接中断
		expect(bad.status).toBe(400);
		expectJsonHeaders(bad);
		const badBody = parseJson(bad);
		expect(Object.keys(badBody)).toEqual(["error"]);
		expect(typeof badBody.error).toBe("string");
		expect(badBody.error.length).toBeGreaterThan(0);

		// Act 2: 紧接着一个正常请求 —— 服务必须仍存活
		const alive = await request(handle.port, `/api/tree?t=${handle.token}`);

		// Assert 2: 进程未崩溃，正常返回 200（/api/tree 成功响应为 no-cache）
		expect(alive.status).toBe(200);
		expectTreeHeaders(alive);
	});
});

// ================================================================
// 8. /api/session 增量读取
// ================================================================

describe("/api/session 增量读取", () => {
	it("should return only the appended entry and a monotonically increasing nextOffset when resuming from the previous nextOffset", async () => {
		// Arrange: 任务会话文件含两条完整行
		const handle = await start();
		const taskId = uuid(1);
		const firstContent = '{"seq":1,"text":"first"}\n{"seq":2,"text":"second"}\n';
		const appended = '{"seq":3,"text":"third"}\n';
		const dir = path.join(rootDir, taskId);
		fs.mkdirSync(dir, { recursive: true });
		const filePath = path.join(dir, `${iso(PAST)}_${taskId}.jsonl`);
		fs.writeFileSync(filePath, firstContent, "utf-8");

		// Act 1: 首读全量
		const first = await request(handle.port, sessionPath(taskId, handle.token));

		// Assert 1: 结构字段逐个具体断言（前向分支必须带 apiVersion: 2）
		expect(first.status).toBe(200);
		expectJsonHeaders(first);
		const firstBody = parseJson(first);
		expect(firstBody.apiVersion).toBe(2);
		expect(firstBody.taskId).toBe(taskId);
		expect(firstBody.offset).toBe(0);
		expect(firstBody.entries).toEqual([{ seq: 1, text: "first" }, { seq: 2, text: "second" }]);
		expect(firstBody.malformed).toBe(0);
		expect(firstBody.truncatedBefore).toBe(false);
		expect(firstBody.hasMore).toBe(false);
		expect(firstBody.nextOffset).toBe(Buffer.byteLength(firstContent));
		expect(firstBody.size).toBe(fs.statSync(filePath).size);
		expect(firstBody.mtime).toBe(fs.statSync(filePath).mtimeMs);

		// Act 2: 追加一行后带上次 nextOffset 追读
		fs.appendFileSync(filePath, appended, "utf-8");
		const second = await request(
			handle.port,
			sessionPath(taskId, handle.token, { offset: String(firstBody.nextOffset) }),
		);

		// Assert 2: 只回新增 entry，nextOffset 单调递增到新文件末尾
		expect(second.status).toBe(200);
		const secondBody = parseJson(second);
		expect(secondBody.taskId).toBe(taskId);
		expect(secondBody.offset).toBe(firstBody.nextOffset);
		expect(secondBody.entries).toEqual([{ seq: 3, text: "third" }]);
		expect(secondBody.malformed).toBe(0);
		expect(secondBody.truncatedBefore).toBe(false);
		expect(secondBody.hasMore).toBe(false);
		expect(secondBody.nextOffset).toBe(Buffer.byteLength(firstContent + appended));
		expect(secondBody.nextOffset).toBeGreaterThan(firstBody.nextOffset);
		expect(secondBody.size).toBe(fs.statSync(filePath).size);
	});

	it("should serve the session jsonl entries rather than the newer children.jsonl sidecar when no findSessionFile override is configured", async () => {
		// Arrange: 任务目录内会话 .jsonl（mtime = now−60s）+ mtime 更新的
		// children.jsonl（now−10s）；服务未传 findSessionFile → 走默认的
		// 「目录内 mtime 最新 .jsonl」发现逻辑，sidecar 必须被排除
		const handle = await start();
		const taskId = uuid(5);
		writeChildSession(taskId, "task with a newer sidecar", Date.now() - 60_000);
		const sidecar = path.join(rootDir, taskId, "children.jsonl");
		fs.writeFileSync(
			sidecar,
			JSON.stringify({
				childTaskId: uuid(6),
				agent: "tester",
				task: "pointer target",
				startedAt: Date.now() - 50_000,
				depth: 2,
			}) + "\n",
			"utf-8",
		);
		const sidecarTime = new Date(Date.now() - 10_000);
		fs.utimesSync(sidecar, sidecarTime, sidecarTime);

		// Act
		const res = await request(handle.port, sessionPath(taskId, handle.token));

		// Assert: 200 且返回的是会话 .jsonl 内容（含 "Task: " user 行），不是 sidecar 记录
		expect(res.status).toBe(200);
		expectJsonHeaders(res);
		const body = parseJson(res);
		expect(body.entries.length).toBeGreaterThan(0);
		expect(body.entries.some((entry: any) => JSON.stringify(entry).includes("Task: task with a newer sidecar"))).toBe(true);
		expect(body.entries.some((entry: any) => Object.prototype.hasOwnProperty.call(entry, "childTaskId"))).toBe(false);
	});
});

// ================================================================
// 9. /api/tree
// ================================================================

describe("/api/tree 会话树", () => {
	it("should return the session tree object rooted at the main session's dispatched tasks", async () => {
		// Arrange: 主会话含异步派发收据，rootDir 下有对应子会话（mtime 1 小时前 → finished）
		const handle = await start();
		const childId = uuid(2);
		const task = "Implement the web server";
		writeMain([
			sessionHeaderLine("main-session", PAST),
			toolCallLine("call-1", "coder", task, PAST),
			receiptLine("call-1", `Dispatched coder. taskId: ${childId}`, PAST + 1_000),
		]);
		writeChildSession(childId, task, PAST + 60_000);

		// Act
		const res = await request(handle.port, `/api/tree?t=${handle.token}`);

		// Assert: 对象结构（不再是裸数组）：apiVersion 2 + nodes + truncated + expand null
		expect(res.status).toBe(200);
		expectTreeHeaders(res);
		const body = parseTree(res);
		expect(body.apiVersion).toBe(2);
		expect(body.truncated).toEqual({ total: 1, showing: 1, dropped: 0 });
		expect(body.expand).toBeNull();
		expect(body.nodes).toHaveLength(1);
		const node = body.nodes[0];
		expect(node.taskId).toBe(childId);
		expect(node.agent).toBe("coder");
		expect(node.task).toBe(task);
		expect(node.depth).toBe(0);
		expect(node.linkSource).toBe("receipt");
		expect(node.status).toBe("finished");
		expect(Array.isArray(node.children)).toBe(true);
		expect(node.children).toHaveLength(0);
		// 惰性字段随节点下发：无 children.jsonl → 0 / 空串
		expect(node.childCount).toBe(0);
		expect(node.childSummary).toBe("");
	});
});

// ================================================================
// completedTasks 注入（同进程 depth 1 完成记录透传给 buildSessionTree）
// ================================================================

describe("/api/tree completedTasks 注入", () => {
	it("should mark a node finished with the injected finishedAt when opts.completedTasks carries its completion record", async () => {
		// Arrange: 异步收据指向 childId，子会话 mtime = 当前时刻（无完成记录时
		// 本会判 recent）；完成记录 finishedAt 为固定值，与 mtime 无关
		const childId = uuid(100);
		const task = "Finished in this process";
		writeMain([
			sessionHeaderLine("main-session", PAST),
			toolCallLine("call-1", "coder", task, PAST),
			receiptLine("call-1", `Dispatched coder. taskId: ${childId}`, PAST + 1_000),
		]);
		writeChildSession(childId, task, Date.now());
		const finishedAt = PAST + 120_000;

		// Act: opts.completedTasks 为每请求现取的只读快照 getter
		const handle = await start({
			completedTasks: () => new Map([[childId, { status: "succeeded", finishedAt }]]),
		});
		const res = await request(handle.port, `/api/tree?t=${handle.token}`);

		// Assert: 注入的完成记录压过 mtime 窗口 → finished，finishedAt 等于注入值
		expect(res.status).toBe(200);
		expectTreeHeaders(res);
		const body = parseTree(res);
		expect(body.truncated).toEqual({ total: 1, showing: 1, dropped: 0 });
		expect(body.nodes).toHaveLength(1);
		expect(body.nodes[0].taskId).toBe(childId);
		expect(body.nodes[0].status).toBe("finished");
		expect(body.nodes[0].finishedAt).toBe(finishedAt);
	});
});

// ================================================================
// 10–12. 关闭与单例
// ================================================================

describe("关闭与单例", () => {
	it("should be idempotent on close and refuse connections after close", async () => {
		// Arrange
		const handle = await start();
		const port = handle.port;

		// Act 1: 第一次关闭
		await handle.close();
		// Act 2: 第二次关闭必须幂等（resolve 而非抛错）
		await expect(handle.close()).resolves.toBeUndefined();

		// Assert: 端口已释放，再连被拒
		await expectConnectionRefused(port);
	});

	it("should keep the same port and token when restarted after vi.resetModules (simulated /reload)", async () => {
		// Arrange: 第一次启动（旧标签页持有旧 token）
		const mod1 = await loadServer();
		const handle1 = await mod1.startWebServer(makeOptions());
		handles.push(handle1);
		const port1 = handle1.port;
		const token1 = handle1.token;

		// Act: 模拟 /reload —— 重置模块缓存后重新动态 import 并再次启动
		vi.resetModules();
		const mod2 = await loadServer();
		const handle2 = await mod2.startWebServer(makeOptions());
		handles.push(handle2);

		// Assert: 接管同一端口与同一 token，打开中的标签页不失效
		expect(handle2.port).toBe(port1);
		expect(handle2.token).toBe(token1);
		const res = await request(handle2.port, `/api/tree?t=${token1}`);
		expect(res.status).toBe(200);
		const singleton = (globalThis as any).__piSubagentWebServer;
		expect(singleton).toBeDefined();
		expect(singleton.token).toBe(token1);
		expect(singleton.server.address().port).toBe(port1);
	});

	it("should bind only to 127.0.0.1 and expose the singleton with server and token", async () => {
		// Arrange
		const handle = await start();

		// Assert: handle 接口（token 为 32 位 hex，url 形状固定）
		expect(handle.token).toMatch(/^[0-9a-f]{32}$/);
		expect(handle.url).toBe(`http://127.0.0.1:${handle.port}/?t=${handle.token}`);

		// Assert: 单例暴露底层 server 与 token，且只监听 127.0.0.1
		const singleton = (globalThis as any).__piSubagentWebServer;
		expect(singleton).toBeDefined();
		expect(singleton.token).toBe(handle.token);
		const address = singleton.server.address();
		expect(address).not.toBeNull();
		expect(typeof address).toBe("object");
		expect((address as any).address).toBe("127.0.0.1");
		expect((address as any).port).toBe(handle.port);
	});
});

// ================================================================
// getGlobalServer 进程单例访问器（命令层入口）
// ================================================================

describe("getGlobalServer", () => {
	it("should return null when the web server has never been started", async () => {
		// Arrange: 本用例不启动任何服务（afterEach 已删除 globalThis.__piSubagentWebServer，
		// 其余用例不会把单例泄漏到本用例）

		// Act
		const global = getGlobalServer();

		// Assert
		expect(global).toBeNull();
	});

	it("should return null when the singleton on globalThis is already marked closed", () => {
		// Arrange: 直接注入一个已关闭形态的单例（字段名同 src/web/server.ts 的
		// WebServerSingleton：closed + handle），handle 本身非空 —— 守卫必须只看 closed
		(globalThis as any).__piSubagentWebServer = {
			closed: true,
			handle: {
				port: 43210,
				url: "http://127.0.0.1:43210/?t=tok",
				token: "tok",
				close: () => Promise.resolve(),
			},
		};

		// Act
		const server = getGlobalServer();

		// Assert: 已关闭单例视为无服务
		expect(server).toBeNull();

		// 清理本用例注入的 global（afterEach 亦会兜底删除）
		delete (globalThis as any).__piSubagentWebServer;
	});

	it("should return the running handle matching startWebServer's handle and null after close", async () => {
		// Arrange
		const handle = await start();

		// Act: 服务运行中
		const running = getGlobalServer();

		// Assert: 非 null，且 port/url/token 与 startWebServer 返回的 handle 逐字段一致
		expect(running).not.toBeNull();
		expect(running!.port).toBe(handle.port);
		expect(running!.url).toBe(handle.url);
		expect(running!.token).toBe(handle.token);

		// Act: 关闭服务
		await handle.close();

		// Assert: 单例消失
		expect(getGlobalServer()).toBeNull();
	});
});

// ================================================================
// /api/tree ETag 与条件请求
// ================================================================

describe("/api/tree ETag 条件请求", () => {
	it("should include a quoted ETag on /api/tree and answer a matching If-None-Match with an empty 304", async () => {
		// Arrange: 主会话含异步派发收据，rootDir 下有对应子会话；钉死墙钟使
		// 用例确定性不依赖真实时钟（内容派生 ETag 本身与时间无关）
		const handle = await start();
		const childId = uuid(4);
		const task = "Serve the tree with caching";
		writeMain([
			sessionHeaderLine("main-session", PAST),
			toolCallLine("call-1", "coder", task, PAST),
			receiptLine("call-1", `Dispatched coder. taskId: ${childId}`, PAST + 1_000),
		]);
		writeChildSession(childId, task, PAST + 60_000);
		const nowSpy = vi.spyOn(Date, "now").mockReturnValue(T0);

		try {
			// Act 1: 首次读取
			const first = await request(handle.port, `/api/tree?t=${handle.token}`);

			// Assert 1: 200 + 带引号的 ETag + no-cache
			expect(first.status).toBe(200);
			expectTreeHeaders(first);
			const etag = first.headers.etag;
			expect(typeof etag).toBe("string");
			expect(etag).toMatch(/^".+"$/);

			// Act 2: 用该 ETag 发条件请求（内容未变）
			const conditional = await request(handle.port, `/api/tree?t=${handle.token}`, {
				headers: { "If-None-Match": etag as string },
			});

			// Assert 2: 304 + 空 body + no-cache（/api/tree 可复用缓存）
			expect(conditional.status).toBe(304);
			expect(conditional.body).toBe("");
			expect(conditional.headers["cache-control"]).toBe("no-cache");
		} finally {
			nowSpy.mockRestore();
		}
	});

	it("should answer a conditional request with 304 when the content is unchanged, no matter how much wall-clock time passed", async () => {
		// Arrange: ETag 内容派生、无 10 秒时间桶；钉死墙钟后前移 1 小时验证与时间无关
		const handle = await start();
		const childId = uuid(6);
		const task = "Stay 304 regardless of wall-clock time";
		writeMain([
			sessionHeaderLine("main-session", PAST),
			toolCallLine("call-1", "coder", task, PAST),
			receiptLine("call-1", `Dispatched coder. taskId: ${childId}`, PAST + 1_000),
		]);
		writeChildSession(childId, task, PAST + 60_000);
		const nowSpy = vi.spyOn(Date, "now").mockReturnValue(T0);

		try {
			// Act 1: t0 首读
			const first = await request(handle.port, `/api/tree?t=${handle.token}`);
			expect(first.status).toBe(200);
			expectTreeHeaders(first);
			const etag = first.headers.etag;
			expect(typeof etag).toBe("string");
			expect(etag).toMatch(/^".+"$/);

			// Act 2: 墙钟前移 1 小时，内容完全不变，带同一 If-None-Match
			nowSpy.mockReturnValue(T0 + 3_600_000);
			const later = await request(handle.port, `/api/tree?t=${handle.token}`, {
				headers: { "If-None-Match": etag as string },
			});

			// Assert 2: 内容不变 → 304 空 body + no-cache（时间推移不得强制 200）
			expect(later.status).toBe(304);
			expect(later.body).toBe("");
			expect(later.headers["cache-control"]).toBe("no-cache");

			// Act 3: 内容变化（registry 写入一条）后带旧 ETag 复取
			registry.set(uuid(62), { status: "running", agentName: "coder", task: "Etag content bust" });
			const changed = await request(handle.port, `/api/tree?t=${handle.token}`, {
				headers: { "If-None-Match": etag as string },
			});

			// Assert 3: 内容变化 → 200 且新 ETag ≠ 旧，body 为新契约对象
			expect(changed.status).toBe(200);
			expectTreeHeaders(changed);
			expect(typeof changed.headers.etag).toBe("string");
			expect(changed.headers.etag).not.toBe(etag);
			expect(Array.isArray(parseTree(changed).nodes)).toBe(true);
		} finally {
			nowSpy.mockRestore();
		}
	});

	it("should return 200 with a different ETag when the main session file changed", async () => {
		// Arrange: 首读拿到 ETag
		const handle = await start();
		const childId = uuid(5);
		const task = "Bust the tree etag";
		writeMain([
			sessionHeaderLine("main-session", PAST),
			toolCallLine("call-1", "coder", task, PAST),
			receiptLine("call-1", `Dispatched coder. taskId: ${childId}`, PAST + 1_000),
		]);
		writeChildSession(childId, task, PAST + 60_000);
		const first = await request(handle.port, `/api/tree?t=${handle.token}`);
		expect(first.status).toBe(200);
		expectTreeHeaders(first);
		const etag = first.headers.etag;
		expect(typeof etag).toBe("string");

		// Act: 追加一条不改变树结构的 assistant 行，并把 mtime 显式挪到不同时刻
		// （size 与 mtime 均变化 → 旧 ETag 必须失效）
		fs.appendFileSync(
			mainFile,
			JSON.stringify({
				type: "message",
				id: "msg-note",
				parentId: "msg-asst",
				timestamp: iso(PAST + 5_000),
				message: { role: "assistant", content: [{ type: "text", text: "cache-busting note" }] },
			}) + "\n",
			"utf-8",
		);
		const shifted = new Date(PAST - 60_000);
		fs.utimesSync(mainFile, shifted, shifted);
		const conditional = await request(handle.port, `/api/tree?t=${handle.token}`, {
			headers: { "If-None-Match": etag as string },
		});

		// Assert: 200 + 新 ETag 不同 + 仍为 JSON/no-cache
		expect(conditional.status).toBe(200);
		expectTreeHeaders(conditional);
		expect(typeof conditional.headers.etag).toBe("string");
		expect(conditional.headers.etag).not.toBe(etag);
		expect(Array.isArray(parseTree(conditional).nodes)).toBe(true);
	});
});

// ================================================================
// /api/session oversizeLine 字段
// ================================================================

describe("/api/session oversizeLine 字段", () => {
	it("should include a boolean oversizeLine field that is false for a small session file", async () => {
		// Arrange: 普通小会话文件（两行 JSONL）
		const handle = await start();
		const taskId = uuid(44);
		const dir = path.join(rootDir, taskId);
		fs.mkdirSync(dir, { recursive: true });
		const filePath = path.join(dir, `${iso(PAST)}_${taskId}.jsonl`);
		fs.writeFileSync(filePath, '{"seq":1,"text":"first"}\n{"seq":2,"text":"second"}\n', "utf-8");

		// Act
		const res = await request(handle.port, sessionPath(taskId, handle.token));

		// Assert: 200 响应体含布尔字段 oversizeLine，小文件为 false
		expect(res.status).toBe(200);
		expectJsonHeaders(res);
		const body = parseJson(res);
		expect(typeof body.oversizeLine).toBe("boolean");
		expect(body.oversizeLine).toBe(false);
	});
});

// ================================================================
// /api/tree ETag 反映 rootDir / registry 变化
// ================================================================

describe("/api/tree ETag 反映状态变化", () => {
	it("should answer an outdated If-None-Match with 200 and a different ETag when a task directory changed the sessions root mtime", async () => {
		// Arrange: 首读拿到 ETag（rootDir mtime 此时为 fixture 创建时刻）
		const handle = await start();
		writeMain([sessionHeaderLine("main-session", PAST)]);
		const first = await request(handle.port, `/api/tree?t=${handle.token}`);
		expect(first.status).toBe(200);
		expectTreeHeaders(first);
		const etag = first.headers.etag;
		expect(typeof etag).toBe("string");

		// Act: 新建一个 UUID 任务目录（rootDir mtime 随之变化），并显式把 rootDir mtime
		// 挪到与首响应时刻确定不同的值（避免文件系统 mtime 粒度造成同值歧义）
		const taskId = uuid(51);
		fs.mkdirSync(path.join(rootDir, taskId), { recursive: true });
		const shifted = new Date(Date.now() - 60_000);
		fs.utimesSync(rootDir, shifted, shifted);
		const second = await request(handle.port, `/api/tree?t=${handle.token}`, {
			headers: { "If-None-Match": etag as string },
		});

		// Assert: 旧 ETag 失效 → 200 + 新 ETag 不同 + 仍是 JSON/no-cache
		expect(second.status).toBe(200);
		expectTreeHeaders(second);
		expect(typeof second.headers.etag).toBe("string");
		expect(second.headers.etag).not.toBe(etag);
		expect(Array.isArray(parseTree(second).nodes)).toBe(true);
	});

	it("should answer an outdated If-None-Match with 200 and a different ETag when the registry changed", async () => {
		// Arrange: 首读拿到 ETag；两读之间不动主会话与 rootDir，只有 registry 变化
		const handle = await start();
		writeMain([sessionHeaderLine("main-session", PAST)]);
		const first = await request(handle.port, `/api/tree?t=${handle.token}`);
		expect(first.status).toBe(200);
		expectTreeHeaders(first);
		const etag = first.headers.etag;
		expect(typeof etag).toBe("string");

		// Act: 向 opts.registry（startWebServer 持有的同一 Map）写入一条
		registry.set(uuid(61), { status: "running", agentName: "coder", task: "Registry-only change" });
		const second = await request(handle.port, `/api/tree?t=${handle.token}`, {
			headers: { "If-None-Match": etag as string },
		});

		// Assert: registry 摘要变化 → 旧 ETag 失效 → 200 + 新 ETag 不同
		expect(second.status).toBe(200);
		expectTreeHeaders(second);
		expect(typeof second.headers.etag).toBe("string");
		expect(second.headers.etag).not.toBe(etag);
		expect(Array.isArray(parseTree(second).nodes)).toBe(true);
	});

	it("should answer an outdated If-None-Match with 200 and a different ETag when the completedTasks snapshot changed", async () => {
		// Arrange: 首读拿到 ETag；两读之间只变 completedTasks 快照。墙钟钉在 T0
		// 排除时间桶滚动的干扰，否则 10s 桶跨桶会掩盖指纹是否真的纳入了快照摘要
		writeMain([sessionHeaderLine("main-session", PAST)]);
		let snapshot: ReadonlyMap<string, { status?: string; finishedAt: number }> = new Map();
		const handle = await start({ completedTasks: () => snapshot });
		// 墙钟钉死仅为用例确定性（内容派生 ETag 已无时间桶）
		const nowSpy = vi.spyOn(Date, "now").mockReturnValue(T0);

		try {
			// Act 1: 空快照首读
			const first = await request(handle.port, `/api/tree?t=${handle.token}`);
			expect(first.status).toBe(200);
			expectTreeHeaders(first);
			const etag = first.headers.etag;
			expect(typeof etag).toBe("string");

			// Act 2: 只改变 completedTasks 快照（主会话、rootDir、registry 均不动）
			snapshot = new Map([[uuid(71), { status: "succeeded", finishedAt: PAST + 90_000 }]]);
			const second = await request(handle.port, `/api/tree?t=${handle.token}`, {
				headers: { "If-None-Match": etag as string },
			});

			// Assert: 快照摘要纳入指纹 → 旧 ETag 失效 → 200 + 新 ETag 不同
			expect(second.status).toBe(200);
			expectTreeHeaders(second);
			expect(typeof second.headers.etag).toBe("string");
			expect(second.headers.etag).not.toBe(etag);
		} finally {
			nowSpy.mockRestore();
		}
	});
});

// ================================================================
// 22–27. entriesStartOffset 与 before 反向回读（客户端自动向前补齐）
// ================================================================

/** 1×1 透明 PNG 的 base64（同 test/subagent-web-images.test.ts 的 fixture）。 */
const PNG_B64 =
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

/** 写任务会话 JSONL（复用 writeChildSession 的目录/命名形状，内容自定）。 */
function writeTaskJsonl(taskId: string, lines: string[]): string {
	const dir = path.join(rootDir, taskId);
	fs.mkdirSync(dir, { recursive: true });
	const filePath = path.join(dir, `${iso(PAST)}_${taskId}.jsonl`);
	fs.writeFileSync(filePath, lines.join("\n") + "\n", "utf-8");

	return filePath;
}

/** 写任务会话原始字节（内容自带换行形状，末行是否换行由内容决定）。 */
function writeTaskRaw(taskId: string, content: string): string {
	const dir = path.join(rootDir, taskId);
	fs.mkdirSync(dir, { recursive: true });
	const filePath = path.join(dir, `${iso(PAST)}_${taskId}.jsonl`);
	fs.writeFileSync(filePath, content, "utf-8");

	return filePath;
}

/** 反向读取路径：只带 taskId/before/t（不带 offset/tail —— 两者互斥使用）。 */
function beforePath(taskId: string, token: string, before: number | string): string {
	const params = new URLSearchParams({ taskId, before: String(before), t: token });

	return `/api/session?${params.toString()}`;
}

describe("/api/session entriesStartOffset（前向）", () => {
	it("should include a numeric entriesStartOffset equal to the first entry's file byte offset on a forward read", async () => {
		// Arrange: 两行 JSONL（首条 entry 起于字节 0）
		const handle = await start();
		const taskId = uuid(80);
		writeTaskJsonl(taskId, ['{"seq":1,"text":"first"}', '{"seq":2,"text":"second"}']);

		// Act
		const res = await request(handle.port, sessionPath(taskId, handle.token));

		// Assert: 200 + 数字型 entriesStartOffset = 首条 entry 的文件字节起始偏移
		expect(res.status).toBe(200);
		expectJsonHeaders(res);
		const body = parseJson(res);
		expect(body.entries).toEqual([{ seq: 1, text: "first" }, { seq: 2, text: "second" }]);
		expect(typeof body.entriesStartOffset).toBe("number");
		expect(body.entriesStartOffset).toBe(0);
	});

	it("should echo the resume byte offset as entriesStartOffset on an incremental forward read", async () => {
		// Arrange: 按第一行字节长度从行边界续读，首条 entry 即第二行行首
		const handle = await start();
		const taskId = uuid(81);
		const line1 = '{"seq":1,"text":"first"}';
		const line2 = '{"seq":2,"text":"second"}';
		writeTaskJsonl(taskId, [line1, line2]);
		const resumeOffset = Buffer.byteLength(line1) + 1;

		// Act
		const res = await request(
			handle.port,
			sessionPath(taskId, handle.token, { offset: String(resumeOffset) }),
		);

		// Assert
		expect(res.status).toBe(200);
		const body = parseJson(res);
		expect(body.entries).toEqual([{ seq: 2, text: "second" }]);
		expect(typeof body.entriesStartOffset).toBe("number");
		expect(body.entriesStartOffset).toBe(resumeOffset);
	});

	it("should report the requested offset as entriesStartOffset when a forward read returns no entries", async () => {
		// Arrange: 已读到文件末尾的 offset
		const handle = await start();
		const taskId = uuid(82);
		const filePath = writeTaskJsonl(taskId, ['{"seq":1}', '{"seq":2}']);
		const size = fs.statSync(filePath).size;

		// Act: offset = size → 空增量
		const res = await request(
			handle.port,
			sessionPath(taskId, handle.token, { offset: String(size) }),
		);

		// Assert: 无 entries 时回显本次 offset
		expect(res.status).toBe(200);
		const body = parseJson(res);
		expect(body.entries).toEqual([]);
		expect(typeof body.entriesStartOffset).toBe("number");
		expect(body.entriesStartOffset).toBe(size);
	});
});

describe("/api/session?before 反向回读（客户端自动向前补齐）", () => {
	it("should return every entry with entriesStartOffset 0 and truncatedBefore false when before equals the file size", async () => {
		// Arrange
		const handle = await start();
		const taskId = uuid(83);
		const lines = ['{"seq":1,"text":"first"}', '{"seq":2,"text":"second"}', '{"seq":3,"text":"third"}'];
		const filePath = writeTaskJsonl(taskId, lines);
		const size = fs.statSync(filePath).size;

		// Act
		const res = await request(handle.port, beforePath(taskId, handle.token, size));

		// Assert: 全量返回 + 新字段与反向读取的响应字段（before/back 分支也带 apiVersion）
		expect(res.status).toBe(200);
		expectJsonHeaders(res);
		const body = parseJson(res);
		expect(body.apiVersion).toBe(2);
		expect(body.taskId).toBe(taskId);
		expect(body.entries).toEqual(lines.map((line) => JSON.parse(line)));
		expect(body.malformed).toBe(0);
		expect(typeof body.entriesStartOffset).toBe("number");
		expect(body.entriesStartOffset).toBe(0);
		expect(body.offset).toBe(size);
		expect(body.nextOffset).toBe(size);
		expect(body.truncatedBefore).toBe(false);
		expect(body.hasMore).toBe(false);
		expect(body.size).toBe(size);
	});

	it("should stitch before-chunks back into the exact forward sequence without loss or duplication", async () => {
		// Arrange: 15 行 fixture，中部夹一条 >1 MiB 的单行，使文件跨越多个默认
		// 1 MiB 分片（iterations > 1 只在这个前提下才有意义，不靠条目数上限）
		const handle = await start();
		const taskId = uuid(84);
		const lines: string[] = [];
		for (let i = 0; i < 7; i++) {
			lines.push(JSON.stringify({ seq: i, text: `line-${i}-${"p".repeat(i * 5)}` }));
		}
		lines.push(
			JSON.stringify({
				seq: 7,
				text: "huge",
				payload: "h".repeat(Math.round(1.2 * 1024 * 1024)),
			}),
		);
		for (let i = 8; i < 15; i++) {
			lines.push(JSON.stringify({ seq: i, text: `line-${i}-${"p".repeat(i * 5)}` }));
		}
		const filePath = writeTaskJsonl(taskId, lines);
		const size = fs.statSync(filePath).size;
		expect(size, "前提自检：fixture 必须超过默认 1 MiB 分片窗口").toBeGreaterThan(1024 * 1024);
		// 参照序列手工解析（不拿一次前向 HTTP 读取当参照：前向受 1 MiB 预算限制只会回一部分）
		const reference = lines.map((line) => JSON.parse(line));
		expect(reference).toHaveLength(15);

		// Act: 从 size 起循环 before = entriesStartOffset 直到 0
		const fragments: any[][] = [];
		let before = size;
		let iterations = 0;
		while (before > 0) {
			const res = await request(handle.port, beforePath(taskId, handle.token, before));
			expect(res.status).toBe(200);
			const body = parseJson(res);
			expect(typeof body.entriesStartOffset, "反向响应必须携带数字型 entriesStartOffset").toBe("number");
			fragments.unshift(body.entries);
			expect(body.entriesStartOffset, "每片都必须严格向前推进").toBeLessThan(before);
			before = body.entriesStartOffset;
			iterations++;
			expect(iterations, "回溯循环必须有界终止").toBeLessThan(50);
		}
		const collected = fragments.flat();

		// Assert: 循环到达 0；拼接序列与手工参照逐条相等（顺序、无重复、无丢失）
		expect(before).toBe(0);
		expect(collected).toEqual(reference);
		expect(iterations).toBeGreaterThan(1);
	});

	it("should return exactly the entries before a mid-file before value with entriesStartOffset below it", async () => {
		// Arrange: 5 行，before 落在第 5 行行中间
		const handle = await start();
		const taskId = uuid(85);
		const lines = [
			'{"seq":1,"text":"first"}',
			'{"seq":2,"text":"second"}',
			'{"seq":3,"text":"third"}',
			'{"seq":4,"text":"fourth"}',
			'{"seq":5,"text":"fifth-and-more"}',
		];
		const filePath = writeTaskJsonl(taskId, lines);
		const size = fs.statSync(filePath).size;
		const firstFourBytes = Buffer.byteLength(lines.slice(0, 4).join("\n") + "\n");
		const beforeValue = firstFourBytes + 3;
		expect(beforeValue, "前提自检：before 必须落在第 5 行行中间").toBeLessThan(size);

		// Act
		const res = await request(handle.port, beforePath(taskId, handle.token, beforeValue));

		// Assert: 恰为区间前的完整行，起点严格小于 before
		expect(res.status).toBe(200);
		const body = parseJson(res);
		expect(body.entries).toEqual(lines.slice(0, 4).map((line) => JSON.parse(line)));
		expect(typeof body.entriesStartOffset).toBe("number");
		expect(body.entriesStartOffset).toBeLessThan(beforeValue);
		// 裁决：该片段已回到文件开头（entriesStartOffset === 0）→ 前方无内容，
		// truncatedBefore 按既定契约 = startOffset > 0 → false
		//（reviewer 曾主张此处为 true，系对 fixture 的误读；已更正）
		expect(body.entriesStartOffset).toBe(0);
		expect(body.truncatedBefore).toBe(false);
	});

	it("should strip base64 image parts from the reverse response", async () => {
		// Arrange: 含 image part 的行夹在普通行之间
		const handle = await start();
		const taskId = uuid(86);
		const line0 = '{"seq":1,"text":"before-image"}';
		const imageLine = JSON.stringify({
			type: "message",
			id: "msg-img",
			message: {
				role: "assistant",
				content: [{ type: "image", mimeType: "image/png", data: PNG_B64 }],
			},
		});
		const line2 = '{"seq":3,"text":"after-image"}';
		const filePath = writeTaskJsonl(taskId, [line0, imageLine, line2]);
		const size = fs.statSync(filePath).size;
		const imageOffset = Buffer.byteLength(line0) + 1;

		// Act: 反向全量读取
		const res = await request(handle.port, beforePath(taskId, handle.token, size));

		// Assert: base64 绝不下发，image part 被换成 imageRef（entryIndex = 绝对字节偏移）
		expect(res.status).toBe(200);
		expect(res.body).not.toContain(PNG_B64);
		expect(res.body).not.toContain("data:image/");
		const body = parseJson(res);
		expect(body.entries).toHaveLength(3);
		const part = body.entries[1].message.content[0];
		expect(part.type).toBe("image");
		expect(part).not.toHaveProperty("data");
		expect(part.imageRef).toEqual({ entryIndex: imageOffset, block: 0 });
		expect(typeof body.entriesStartOffset).toBe("number");
		expect(body.entriesStartOffset).toBe(0);
	});

	it("should expose a bounded nonzero entriesStartOffset when tail=1 finds no newline in the tail window", async () => {
		// Arrange: 3 条小行 + 一条 ≥600 KiB 无换行的超长尾行（末行无结尾换行）；
		// 文件 >512 KiB → tail 首读的快照窗口整个落在超长行内部且窗口内无 '\n'
		const handle = await start();
		const taskId = uuid(88);
		const headLines = [
			JSON.stringify({ seq: 0, text: "first" }),
			JSON.stringify({ seq: 1, text: "second" }),
			JSON.stringify({ seq: 2, text: "third" }),
		];
		const tailLine = JSON.stringify({ seq: 3, text: `tail-${"t".repeat(600 * 1024)}` });
		const filePath = writeTaskRaw(taskId, headLines.join("\n") + "\n" + tailLine);
		const size = fs.statSync(filePath).size;
		expect(size, "前提自检：文件必须超过 512 KiB 的 tail 快照窗口").toBeGreaterThan(512 * 1024);

		// Act 1: 首屏 tail=1 读取
		const tailParams = new URLSearchParams({ taskId, offset: "0", tail: "1", t: handle.token });
		const res = await request(handle.port, `/api/session?${tailParams.toString()}`);

		// Assert 1: 尾窗口内无换行 → 空 entries + truncatedBefore true；但补齐游标
		// 必须是有界非零字节偏移（回落到请求 offset 0 会让客户端头部永远拉不到）
		expect(res.status).toBe(200);
		expectJsonHeaders(res);
		const body = parseJson(res);
		expect(body.truncatedBefore).toBe(true);
		expect(body.entries).toEqual([]);
		expect(typeof body.entriesStartOffset).toBe("number");
		expect(body.entriesStartOffset, "补齐游标必须非零（不得回落请求 offset）").toBeGreaterThan(0);
		expect(body.entriesStartOffset, "游标必须有界（≤ 文件字节数）").toBeLessThanOrEqual(size);

		// Act 2: 客户端用该游标发起向前补齐
		const backRes = await request(handle.port, beforePath(taskId, handle.token, body.entriesStartOffset));

		// Assert 2: 能取回更早的行 → 游标确实可推进（非 0 死端）
		expect(backRes.status).toBe(200);
		expectJsonHeaders(backRes);
		const backBody = parseJson(backRes);
		expect(Array.isArray(backBody.entries)).toBe(true);
		expect(
			backBody.entries.some((entry: any) => entry.seq === 0),
			"用游标 before= 应能拉回头部 entry（seq:0）",
		).toBe(true);
	});

	it("should keep serving requests after an out-of-range or non-numeric before", async () => {
		// Arrange
		const handle = await start();
		const taskId = uuid(87);
		const filePath = writeTaskJsonl(taskId, ['{"seq":1}', '{"seq":2}']);
		const size = fs.statSync(filePath).size;

		// Act / Assert: 负数、非数字、超 size —— 实现确定性回落为 0（超 size 由
		// readBefore clamp），一律 200，不崩溃
		for (const bad of ["-5", "abc", String(size + 1000)]) {
			const res = await request(handle.port, beforePath(taskId, handle.token, bad));
			expect(res.status, `before=${bad} 应确定性回落并返回 200`).toBe(200);
		}

		// 存活证据：随后一次正常请求仍 200
		const alive = await request(handle.port, sessionPath(taskId, handle.token));
		expect(alive.status).toBe(200);
		expectJsonHeaders(alive);
		expect(parseJson(alive).entries).toEqual([{ seq: 1 }, { seq: 2 }]);
	});
});

// ================================================================
// D. /api/session 剥离 system 条目（forward 与 before 两条路径）
// ================================================================

/** system 类型条目（entry.type === "system"），带唯一哨兵。 */
const SYSTEM_TYPE_LINE = JSON.stringify({
	type: "system",
	subtype: "init",
	note: "SYSTEM-TYPE-SENTINEL",
	timestamp: iso(PAST),
});

/** system 角色消息条目（entry.type === "message" 且 message.role === "system"）。 */
const SYSTEM_ROLE_LINE = JSON.stringify({
	type: "message",
	id: "msg-system-role",
	timestamp: iso(PAST),
	message: { role: "system", content: [{ type: "text", text: "SYSTEM-ROLE-SENTINEL" }] },
});

/** 普通 assistant 消息，携带一个 base64 图片段（stripImages 的对象）。 */
const IMAGE_LINE = JSON.stringify({
	type: "message",
	id: "msg-img",
	message: { role: "assistant", content: [{ type: "image", mimeType: "image/png", data: PNG_B64 }] },
});

/**
 * 落一个含两条 system 条目 + 两条普通条目 + 一条图片条目的会话文件，
 * 返回 { size, imageOffset }（imageOffset = 图片行在原文件中的绝对字节偏移）。
 */
function writeSystemHeavySession(taskId: string): { size: number; imageOffset: number } {
	const normalBefore = '{"seq":1,"text":"before-system"}';
	const normalAfter = '{"seq":4,"text":"after-image"}';
	const filePath = writeTaskJsonl(taskId, [
		SYSTEM_TYPE_LINE,
		normalBefore,
		SYSTEM_ROLE_LINE,
		IMAGE_LINE,
		normalAfter,
	]);
	const imageOffset = Buffer.byteLength(SYSTEM_TYPE_LINE + "\n" + normalBefore + "\n" + SYSTEM_ROLE_LINE + "\n", "utf-8");

	return { size: fs.statSync(filePath).size, imageOffset };
}

describe("/api/session 剥离 system 条目", () => {
	it("should strip system entries from the forward response while keeping byte cursors and imageRef offsets intact", async () => {
		// Arrange: 含 system 条目 + 普通条目 + 图片段的会话文件
		const handle = await start();
		const taskId = uuid(90);
		const { size, imageOffset } = writeSystemHeavySession(taskId);

		// Act: 前向读取（offset 路径）
		const res = await request(handle.port, sessionPath(taskId, handle.token));

		// Assert: 响应不含任何 system 条目
		expect(res.status).toBe(200);
		expectJsonHeaders(res);
		expect(res.body).not.toContain("SYSTEM-TYPE-SENTINEL");
		expect(res.body).not.toContain("SYSTEM-ROLE-SENTINEL");
		const body = parseJson(res);
		expect(body.entries).toHaveLength(3);
		expect(body.entries[0]).toEqual({ seq: 1, text: "before-system" });
		expect(body.entries[2]).toEqual({ seq: 4, text: "after-image" });

		// Assert: 剥离发生在 stripImages 之后 —— imageRef.entryIndex 仍是原文件
		// 字节偏移（不是剥离后数组下标，也不是 kept-entry 偏移）
		const part = body.entries[1].message.content[0];
		expect(part.type).toBe("image");
		expect(part).not.toHaveProperty("data");
		expect(part.imageRef).toEqual({ entryIndex: imageOffset, block: 0 });

		// Assert: 字节游标语义不受剥离影响
		expect(body.offset).toBe(0);
		expect(body.nextOffset).toBe(size);
		expect(body.size).toBe(size);
		expect(body.entriesStartOffset).toBe(0);
		expect(body.malformed).toBe(0);
		expect(body.truncatedBefore).toBe(false);
		expect(body.hasMore).toBe(false);
	});

	it("should strip system entries from the before/backfill response while keeping cursors and imageRef byte offsets intact", async () => {
		// Arrange: 同一形状的 fixture，走反向补齐路径
		const handle = await start();
		const taskId = uuid(90);
		const { size, imageOffset } = writeSystemHeavySession(taskId);

		// Act: 反向读取（before 路径）
		const res = await request(handle.port, beforePath(taskId, handle.token, size));

		// Assert: 响应不含任何 system 条目，其它条目仍在
		expect(res.status).toBe(200);
		expectJsonHeaders(res);
		expect(res.body).not.toContain("SYSTEM-TYPE-SENTINEL");
		expect(res.body).not.toContain("SYSTEM-ROLE-SENTINEL");
		const body = parseJson(res);
		expect(body.entries).toHaveLength(3);
		expect(body.entries[0]).toEqual({ seq: 1, text: "before-system" });
		expect(body.entries[2]).toEqual({ seq: 4, text: "after-image" });

		// Assert: imageRef.entryIndex 仍是绝对字节偏移
		const part = body.entries[1].message.content[0];
		expect(part.type).toBe("image");
		expect(part).not.toHaveProperty("data");
		expect(part.imageRef).toEqual({ entryIndex: imageOffset, block: 0 });

		// Assert: 反向游标语义不受剥离影响（offset/nextOffset 回显 before）
		expect(body.offset).toBe(size);
		expect(body.nextOffset).toBe(size);
		expect(body.size).toBe(size);
		expect(body.entriesStartOffset).toBe(0);
		expect(body.malformed).toBe(0);
		expect(body.truncatedBefore).toBe(false);
		expect(body.hasMore).toBe(false);
	});
});

// ================================================================
// /api/tree expand 参数（buildSubtree 展开直属子节点）
// ================================================================

/**
 * 落一个可展开任务目录：<rootDir>/<expandId>/ 的会话内含一条派发收据 → 子任务，
 * 子任务目录齐全；派发 task 文本为 250 字符，用于覆盖子节点的 200 字符截断。
 */
function writeExpandableTask(expandId: string): { childId: string; longTask: string } {
	const childId = uuid(710);
	const longTask = "E".repeat(250);
	writeTaskJsonl(expandId, [
		sessionHeaderLine(expandId, PAST),
		toolCallLine("exp-call", "tester", longTask, PAST + 1_000),
		receiptLine("exp-call", `Dispatched tester. taskId: ${childId}`, PAST + 2_000),
	]);
	writeChildSession(childId, "expand child session", PAST + 60_000);

	return { childId, longTask };
}

describe("/api/tree expand 参数", () => {
	it("should return 400 with a JSON error when expand is not UUID-shaped", async () => {
		// Arrange: 其余校验合法；expand 值非 UUID 形且不含穿越
		const handle = await start();
		writeMain([sessionHeaderLine("main-session", PAST)]);

		// Act
		const res = await request(handle.port, `/api/tree?t=${handle.token}&expand=not-a-uuid`);

		// Assert: 400 + 具体错误文案；错误响应保持 no-store（仅 /api/tree 成功响应 no-cache）
		expect(res.status).toBe(400);
		expectJsonHeaders(res);
		expect(parseJson(res)).toEqual({ error: "Invalid taskId" });
	});

	it("should return 403 with a JSON error when expand traverses outside the sessions root", async () => {
		// Arrange: ../ 穿越必须先于 UUID 形状判 403（与 /api/session 的顺序一致）
		const handle = await start();
		writeMain([sessionHeaderLine("main-session", PAST)]);

		// Act
		const res = await request(
			handle.port,
			`/api/tree?t=${handle.token}&expand=${encodeURIComponent("../outside")}`,
		);

		// Assert: 403 + Forbidden；no-store
		expect(res.status).toBe(403);
		expectJsonHeaders(res);
		expect(parseJson(res)).toEqual({ error: "Forbidden" });
	});

	it("should answer 200 with expand null when the expanded taskId has no session", async () => {
		// Arrange: 合法 UUID 形状但 rootDir 下无该任务目录
		const handle = await start();
		writeMain([sessionHeaderLine("main-session", PAST)]);
		const missingId = uuid(711);

		// Act
		const res = await request(handle.port, `/api/tree?t=${handle.token}&expand=${missingId}`);

		// Assert: 200，expand 显式为 null，其余新契约字段照常
		expect(res.status).toBe(200);
		expectTreeHeaders(res);
		const body = parseTree(res);
		expect(body.apiVersion).toBe(2);
		expect(body.expand).toBeNull();
		expect(body.nodes).toEqual([]);
		expect(body.truncated).toEqual({ total: 0, showing: 0, dropped: 0 });
	});

	it("should expand a task's direct children when expand carries a valid existing taskId", async () => {
		// Arrange: 可展开任务目录（会话内一条收据 → 子任务，task 250 字符）
		const handle = await start();
		writeMain([sessionHeaderLine("main-session", PAST)]);
		const expandId = uuid(712);
		const { childId, longTask } = writeExpandableTask(expandId);

		// Act
		const res = await request(handle.port, `/api/tree?t=${handle.token}&expand=${expandId}`);

		// Assert: expand 携带 taskId 与 buildSubtree 产物（depth 1、截断后的 task、
		// childCount/childSummary）
		expect(res.status).toBe(200);
		expectTreeHeaders(res);
		const body = parseTree(res);
		expect(body.expand).not.toBeNull();
		expect(body.expand.taskId).toBe(expandId);
		expect(body.expand.children).toHaveLength(1);
		const child = body.expand.children[0];
		expect(child.taskId).toBe(childId);
		expect(child.agent).toBe("tester");
		expect(child.depth).toBe(1);
		expect(child.linkSource).toBe("receipt");
		expect(child.task.length).toBe(200);
		expect(child.task).toBe(longTask.slice(0, 200));
		expect(child.taskTruncated).toBe(true);
		expect(child.childCount).toBe(0);
		expect(child.childSummary).toBe("");
	});

	it("should include the expand parameter in the ETag so a different expand answers 200 with a fresh ETag", async () => {
		// Arrange: 首读（无 expand）拿 ETag；两次请求间内容不变，墙钟钉死保证确定性
		const handle = await start();
		writeMain([sessionHeaderLine("main-session", PAST)]);
		const expandId = uuid(713);
		writeExpandableTask(expandId);
		const nowSpy = vi.spyOn(Date, "now").mockReturnValue(T0);

		try {
			const first = await request(handle.port, `/api/tree?t=${handle.token}`);
			expect(first.status).toBe(200);
			expectTreeHeaders(first);
			const etag = first.headers.etag;
			expect(typeof etag).toBe("string");

			// Act: 同内容 + 不同 expand 参数，带旧 If-None-Match
			const expanded = await request(handle.port, `/api/tree?t=${handle.token}&expand=${expandId}`, {
				headers: { "If-None-Match": etag as string },
			});

			// Assert: expand 参与指纹 → 200 且新 ETag ≠ 旧（不得被 304 冻结）
			expect(expanded.status).toBe(200);
			expectTreeHeaders(expanded);
			expect(typeof expanded.headers.etag).toBe("string");
			expect(expanded.headers.etag).not.toBe(etag);
			expect(parseTree(expanded).expand?.taskId).toBe(expandId);
		} finally {
			nowSpy.mockRestore();
		}
	});
});

// ================================================================
// 第 7 轮回归（独立审查缺口，HTTP 层）：
//   1. /api/tree ETag 必须反映任何影响响应体的变化 —— 已存在任务目录内的
//      子会话 jsonl 追加与 children.jsonl 指针追加（rootDir mtime / 主会话 /
//      registry / completedTasks 全都不变）同样必须让旧 If-None-Match 失效；
//   2. expand 结构缓存不得返回陈旧状态 —— 文件不动、只改 registry 时，再次
//      expand 必须反映新的 status。
// ================================================================

describe("/api/tree ETag 反映子会话文件与指针变化（回归）", () => {
	it("should answer an outdated If-None-Match with 200 and a fresh ETag when a pointer row was appended to the existing task's children.jsonl", async () => {
		// Arrange: 主会话收据 → childId；子会话很旧（finished → 惰性，首轮
		// childCount 0 / childSummary ""）
		const handle = await start();
		const childId = uuid(200);
		const task = "Task whose pointer file changes the tree body";
		writeMain([
			sessionHeaderLine("main-session", PAST),
			toolCallLine("call-1", "coder", task, PAST),
			receiptLine("call-1", `Dispatched coder. taskId: ${childId}`, PAST + 1_000),
		]);
		writeChildSession(childId, task, PAST + 60_000);
		const first = await request(handle.port, `/api/tree?t=${handle.token}`);
		expect(first.status).toBe(200);
		expectTreeHeaders(first);
		const etag = first.headers.etag;
		expect(typeof etag).toBe("string");
		expect(parseTree(first).nodes[0].childCount).toBe(0);
		expect(parseTree(first).nodes[0].childSummary).toBe("");

		// Act: 向已存在的 <rootDir>/<childId>/children.jsonl 追加一条指针 ——
		// 主会话、rootDir mtime、registry、completedTasks 全都不变，只有子任务
		// 目录内容变了
		const pointer = {
			childTaskId: uuid(201),
			agent: "tester",
			task: "pointer child appended after the first read",
			startedAt: PAST + 90_000,
			depth: 2,
		};
		fs.appendFileSync(path.join(rootDir, childId, "children.jsonl"), JSON.stringify(pointer) + "\n", "utf-8");
		const second = await request(handle.port, `/api/tree?t=${handle.token}`, {
			headers: { "If-None-Match": etag as string },
		});

		// Assert: 旧 ETag 不得把新 body 冻结成 304 —— 必须 200 + 新 ETag，
		// 且 body 反映新指针计数
		expect(second.status).toBe(200);
		expectTreeHeaders(second);
		expect(typeof second.headers.etag).toBe("string");
		expect(second.headers.etag).not.toBe(etag);
		const body = parseTree(second);
		expect(body.nodes[0].childCount).toBe(1);
		expect(body.nodes[0].childSummary).toBe("1 child · all finished");
	});

	it("should answer an outdated If-None-Match with 200 and a fresh ETag when an entry was appended to the child session jsonl", async () => {
		// Arrange: 同上形状，首轮节点为 finished；墙钟钉死保证 recent 窗口判定
		// 确定性（ETag 指纹本身与时间无关）
		const handle = await start();
		const childId = uuid(210);
		const task = "Task whose session file changes the tree body";
		writeMain([
			sessionHeaderLine("main-session", PAST),
			toolCallLine("call-1", "coder", task, PAST),
			receiptLine("call-1", `Dispatched coder. taskId: ${childId}`, PAST + 1_000),
		]);
		const childFile = writeChildSession(childId, task, PAST - 60_000);
		const nowSpy = vi.spyOn(Date, "now").mockReturnValue(T0);

		try {
			const first = await request(handle.port, `/api/tree?t=${handle.token}`);
			expect(first.status).toBe(200);
			expectTreeHeaders(first);
			const etag = first.headers.etag;
			expect(typeof etag).toBe("string");
			expect(parseTree(first).nodes[0].status).toBe("finished");

			// Act: 向子会话 jsonl 追加一条最新条目（ts = T0−5s，10s recent
			// 窗口内）→ 响应体该节点必须变 recent
			fs.appendFileSync(
				childFile,
				JSON.stringify({
					type: "message",
					id: "msg-appended",
					parentId: "msg-asst-" + childId,
					timestamp: iso(T0 - 5_000),
					message: { role: "assistant", content: [{ type: "text", text: "still working" }] },
				}) + "\n",
				"utf-8",
			);
			const second = await request(handle.port, `/api/tree?t=${handle.token}`, {
				headers: { "If-None-Match": etag as string },
			});

			// Assert: 子会话内容变化必须让旧 ETag 失效：200 + 新 ETag，
			// body 里该节点状态从 finished 变为 recent
			expect(second.status).toBe(200);
			expectTreeHeaders(second);
			expect(typeof second.headers.etag).toBe("string");
			expect(second.headers.etag).not.toBe(etag);
			expect(parseTree(second).nodes[0].status).toBe("recent");
		} finally {
			nowSpy.mockRestore();
		}
	});
});

describe("/api/tree?expand 结构缓存不返回陈旧状态（回归）", () => {
	it("should recompute the expanded children's status after only the registry changed, with every file untouched", async () => {
		// Arrange: 可展开任务 expandId（会话内一条异步收据 → childId，无指针
		// → depth 1 pending）；子会话很旧
		const handle = await start();
		writeMain([sessionHeaderLine("main-session", PAST)]);
		const expandId = uuid(720);
		const childId = uuid(721);
		const childTask = "Expand cache child whose status must refresh";
		writeTaskJsonl(expandId, [
			sessionHeaderLine(expandId, PAST),
			toolCallLine("exp-call", "tester", childTask, PAST + 1_000),
			receiptLine("exp-call", `Dispatched tester. taskId: ${childId}`, PAST + 2_000),
		]);
		writeChildSession(childId, "expand cache child session", PAST + 60_000);

		// Act 1: 首次展开 → pending（无 registry、无指针、无同步收据、
		// 子会话远古）
		const first = await request(handle.port, `/api/tree?t=${handle.token}&expand=${expandId}`);
		expect(first.status).toBe(200);
		const firstBody = parseTree(first);
		expect(firstBody.expand).not.toBeNull();
		expect(firstBody.expand.taskId).toBe(expandId);
		expect(firstBody.expand.children).toHaveLength(1);
		expect(firstBody.expand.children[0].taskId).toBe(childId);
		expect(firstBody.expand.children[0].status).toBe("pending");

		// Act 2: 只把该 child 写进 opts.registry（主会话/子会话/指针文件全部
		// 不动），再次展开同一子树
		registry.set(childId, { status: "running", agentName: "tester", task: childTask });
		const second = await request(handle.port, `/api/tree?t=${handle.token}&expand=${expandId}`);

		// Assert: 缓存键必须覆盖 registry/completedTasks —— 第二次展开的
		// child status 必须是 running，不得回放缓存里的 pending
		expect(second.status).toBe(200);
		const secondBody = parseTree(second);
		expect(secondBody.expand).not.toBeNull();
		expect(secondBody.expand.children).toHaveLength(1);
		expect(secondBody.expand.children[0].taskId).toBe(childId);
		expect(secondBody.expand.children[0].status).toBe("running");
	});
});

// ================================================================
// /api/path —— 冷深链完整面包屑（服务端路径接口）：
//   GET /api/path?taskId=<uuid> → 200 { apiVersion, taskId, found, path, node }
//   缺 taskId → 400；坏 token / 坏 Origin / 坏 Host → 403（沿用现有守卫，
//   守卫在路由分发之前）；非法或越界的 taskId → 400/403（沿用 resolveTaskDir）；
//   目标不存在（磁盘无该任务）→ 200 且 found:false、path:[]、node:null。
// 路由尚不存在（未匹配路径一律 404），200/400 用例红属预期；坏 token 的 403
// 由通用请求守卫先行给出，红阶段即绿（钉住守卫对新路由同样生效）。
// 注：200 成功响应的 Cache-Control 未在契约中钉死，本文件只断言 JSON
// content-type，不替实现者选定缓存语义。
// ================================================================

/** /api/path 请求路径：taskId + token。 */
function apiPathRoute(taskId: string, token: string): string {
	const params = new URLSearchParams({ taskId, t: token });

	return `/api/path?${params.toString()}`;
}

describe("/api/path 会话路径", () => {
	it("should answer 200 with apiVersion, taskId, found, path and node for an existing root task", async () => {
		// Arrange: 主会话异步收据 → childId（根级目标），子会话很久以前 → finished
		const handle = await start();
		const childId = uuid(300);
		const task = "Serve the breadcrumb path";
		writeMain([
			sessionHeaderLine("main-session", PAST),
			toolCallLine("call-1", "coder", task, PAST),
			receiptLine("call-1", `Dispatched coder. taskId: ${childId}`, PAST + 1_000),
		]);
		writeChildSession(childId, task, PAST + 60_000);

		// Act
		const res = await request(handle.port, apiPathRoute(childId, handle.token));

		// Assert: 200 + 契约五字段；根级目标 found=true、path=[]、node 为真实 segment
		expect(res.status).toBe(200);
		expect(res.headers["content-type"]).toBe("application/json; charset=utf-8");
		const body = parseJson(res);
		expect(Object.keys(body).sort()).toEqual(["apiVersion", "found", "node", "path", "taskId"]);
		expect(body.apiVersion).toBe(2);
		expect(body.taskId).toBe(childId);
		expect(body.found).toBe(true);
		expect(body.path).toEqual([]);
		expect(body.node).toEqual({ taskId: childId, agent: "coder", task, status: "finished" });
	});

	it("should return 400 when the taskId query parameter is missing", async () => {
		// Arrange: 其余校验合法（正确 token），仅缺 taskId
		const handle = await start();

		// Act
		const res = await request(handle.port, `/api/path?t=${handle.token}`);

		// Assert: 400 + JSON 错误体（错误响应一律 no-store）
		expect(res.status).toBe(400);
		expectJsonHeaders(res);
		const body = parseJson(res);
		expect(Object.keys(body)).toEqual(["error"]);
		expect(typeof body.error).toBe("string");
		expect(body.error.length).toBeGreaterThan(0);
	});

	it("should return 403 when the token query parameter is missing", async () => {
		// Arrange: 仅缺 token —— 守卫在路由分发之前，新路由同样被拦截
		const handle = await start();

		// Act
		const res = await request(handle.port, apiPathRoute(uuid(301), ""));

		// Assert
		expect(res.status).toBe(403);
		expectJsonHeaders(res);
	});

	it("should return 400 with an Invalid taskId error when the taskId is not UUID-shaped and does not traverse", async () => {
		// Arrange: 其余校验合法（正确 token），仅 taskId 非 UUID 形且无穿越 ——
		// /api/path 必须沿用同一 taskId 守卫，不得绕过（变异自证：删掉守卫后 67/67 仍绿）
		const handle = await start();

		// Act
		const res = await request(handle.port, apiPathRoute("not-a-uuid", handle.token));

		// Assert: 400 + 契约错误体 { error: "Invalid taskId" } + no-store
		expect(res.status).toBe(400);
		expectJsonHeaders(res);
		const body = parseJson(res);
		expect(Object.keys(body)).toEqual(["error"]);
		expect(body.error).toBe("Invalid taskId");
	});

	it("should return 403 with a Forbidden error when the taskId traverses outside the sessions root", async () => {
		// Arrange: 其余校验合法（正确 token），仅 taskId 带 ../ 穿越 —— /api/path
		// 必须沿用同一 taskId 守卫，不得绕过（变异自证：删掉守卫后 67/67 仍绿）
		const handle = await start();

		// Act
		const res = await request(handle.port, apiPathRoute("../../outside", handle.token));

		// Assert: 403 + 契约错误体 { error: "Forbidden" } + no-store
		expect(res.status).toBe(403);
		expectJsonHeaders(res);
		const body = parseJson(res);
		expect(Object.keys(body)).toEqual(["error"]);
		expect(body.error).toBe("Forbidden");
	});

	it("should return 403 with a Forbidden error when the Host header does not match loopback with the server port", async () => {
		// Arrange: 合法 taskId + 合法 token，仅 Host 伪造为外部域名（DNS rebinding
		// 形状）—— 守卫在路由分发之前，/api/path 同样被拦截
		const handle = await start();

		// Act
		const res = await request(handle.port, apiPathRoute(uuid(303), handle.token), {
			headers: { Host: `evil.example.com:${handle.port}` },
		});

		// Assert
		expect(res.status).toBe(403);
		expectJsonHeaders(res);
	});

	it("should answer 200 with found false when the task does not exist on disk", async () => {
		// Arrange: 合法 UUID 形状但 rootDir 下无该任务目录、会话树中也无链接
		const handle = await start();
		writeMain([sessionHeaderLine("main-session", PAST)]);
		const missingId = uuid(302);

		// Act
		const res = await request(handle.port, apiPathRoute(missingId, handle.token));

		// Assert: 目标不存在不是错误 —— 200 且 found:false、path 空、node null
		expect(res.status).toBe(200);
		expect(res.headers["content-type"]).toBe("application/json; charset=utf-8");
		const body = parseJson(res);
		expect(Object.keys(body).sort()).toEqual(["apiVersion", "found", "node", "path", "taskId"]);
		expect(body.apiVersion).toBe(2);
		expect(body.taskId).toBe(missingId);
		expect(body.found).toBe(false);
		expect(body.path).toEqual([]);
		expect(body.node).toBeNull();
	});
});
