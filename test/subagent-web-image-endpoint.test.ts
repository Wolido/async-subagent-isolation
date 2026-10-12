/**
 * 红阶段测试：`/api/image` 端点 + `/api/session` 图片剥离 —— 本地 web 服务的
 * 图片懒加载服务端契约（真实起服务 + 真实 HTTP 请求，端口 0 随机分配）。
 *
 * 被测契约（固定，实现者照此实现）：
 *   1. GET /api/session 返回的 entries 必须经 stripImages(entries, entryOffsets)：
 *      image part 无 `data`、有 mimeType/byteLength/imageRef{entryIndex,block}；
 *      无图片的 entry 剥离后仍 toEqual 原 entry；响应其余字段不变。
 *   2. StartWebServerOptions 新增可选 maxImageBytes?: number（默认 MAX_IMAGE_BYTES）。
 *   3. GET /api/image?taskId=..&entry=..&block=..：
 *      - 鉴权链与 /api/session 完全复用（非 GET→405；错 Host/Origin/缺错 token→403）
 *      - taskId 校验顺序与 /api/session 完全一致：缺 taskId→400；词法穿越或
 *        realpath 逃逸→403；非穿越的非 UUID 形→400；无会话文件→404
 *      - entry/block 必须存在且为非负整数字符串，否则 400 {error:string}
 *      - lookup not-found→404 {error}；too-large→413 {error,byteLength}；
 *        ok→200 原始字节，Content-Type = 该块 mimeType，Cache-Control: no-store，
 *        带正确 Content-Length
 *      - 所有 JSON 错误响应 content-type = application/json; charset=utf-8
 *
 * 约定（沿仓库惯例，同 test/subagent-web-server.test.ts）：globals:false 显式
 * import from "vitest"；fixture 用 fs.mkdtempSync(os.tmpdir()) + afterEach 递归
 * 删除；真实起服务（端口 0）、真实 http.request（agent:false 单连接）；用完必须
 * await handle.close() 并删 globalThis.__piSubagentWebServer。
 */

import { describe, expect, it, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { startWebServer } from "../src/web/server.ts";
import type { StartWebServerOptions, WebServerHandle } from "../src/web/server.ts";

// ---------------------------------------------------------------------------
// fixture 常量与行构造器
// ---------------------------------------------------------------------------

/** 1×1 透明 PNG 的 base64（解码后恰好 70 字节）。 */
const PNG_B64 =
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const PNG_BYTES = Buffer.from(PNG_B64, "base64");
expect(PNG_BYTES.length, "前提自检：PNG fixture 必须是 70 字节").toBe(70);

/** 固定过去时刻（mtime 1 小时前 → 会话状态确定为 finished）。 */
const PAST_MTIME = Date.now() - 3_600_000;

type RegistryEntry = { status?: string; agentName?: string; task?: string };

/** startWebServer 选项（含本轮契约新增的 maxImageBytes）。 */
type StartOverrides = Partial<StartWebServerOptions> & { maxImageBytes?: number };

/** uuid 形状的固定 taskId 生成器（version 4 形状，逐个确定）。 */
function uuid(n: number): string {
	return `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
}

function iso(ms: number): string {
	return new Date(ms).toISOString();
}

// ---------------------------------------------------------------------------
// fixture 状态
// ---------------------------------------------------------------------------

let tmpDir: string; // 任务临时根
let rootDir: string; // subagent-sessions 根：<tmpDir>/subagent-sessions
let mainFile: string; // 主会话 JSONL（startWebServer 必填）
let registry: Map<string, RegistryEntry>;
let handles: WebServerHandle[]; // 本用例启动过的全部句柄，afterEach 统一关闭

beforeEach(() => {
	tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "subagent-web-image-"));
	rootDir = path.join(tmpDir, "subagent-sessions");
	fs.mkdirSync(rootDir, { recursive: true });
	mainFile = path.join(tmpDir, "main-session.jsonl");
	fs.writeFileSync(mainFile, JSON.stringify({ type: "session", sessionId: "main" }) + "\n", "utf-8");
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

/** 起服务并登记句柄。 */
async function start(overrides: StartOverrides = {}): Promise<WebServerHandle> {
	const handle = await startWebServer({ mainSessionFile: () => mainFile, registry, rootDir, ...overrides });
	handles.push(handle);

	return handle;
}

// ---------------------------------------------------------------------------
// fixture 落盘：含 base64 image 的子会话
// ---------------------------------------------------------------------------

interface ImageSessionFixture {
	filePath: string;
	lines: string[];
	/** image part 所在 JSONL 行的绝对字节偏移。 */
	imageLineOffset: number;
}

/**
 * 写子会话：<rootDir>/<taskId>/<ISO>_<taskId>.jsonl，共 4 行：
 * session 头 + user + assistant + 带 base64 image 的 toolResult。
 * 文件与目录 mtime 显式设为 1 小时前（默认 findSessionFile 可发现）。
 */
function writeImageSession(taskId: string): ImageSessionFixture {
	const ts = PAST_MTIME;
	const lines = [
		JSON.stringify({ type: "session", sessionId: taskId, timestamp: iso(ts) }),
		JSON.stringify({
			type: "message",
			id: `msg-user-${taskId}`,
			parentId: `session-${taskId}`,
			timestamp: iso(ts),
			message: { role: "user", content: [{ type: "text", text: "Task: draw a pixel" }] },
		}),
		JSON.stringify({
			type: "message",
			id: `msg-asst-${taskId}`,
			parentId: `msg-user-${taskId}`,
			timestamp: iso(ts),
			message: { role: "assistant", content: [{ type: "text", text: "here is the screenshot" }] },
		}),
		JSON.stringify({
			type: "message",
			id: `msg-img-${taskId}`,
			parentId: `msg-asst-${taskId}`,
			timestamp: iso(ts),
			message: {
				role: "toolResult",
				toolCallId: "call-1",
				toolName: "view",
				content: [
					{ type: "text", text: "screenshot" },
					{ type: "image", mimeType: "image/png", data: PNG_B64 },
				],
				isError: false,
			},
		}),
	];
	const imageLineOffset = Buffer.byteLength(lines.slice(0, 3).join("\n") + "\n", "utf-8");
	const dir = path.join(rootDir, taskId);
	fs.mkdirSync(dir, { recursive: true });
	const filePath = path.join(dir, `${iso(ts)}_${taskId}.jsonl`);
	fs.writeFileSync(filePath, lines.join("\n") + "\n", "utf-8");
	const d = new Date(ts);
	fs.utimesSync(filePath, d, d);
	fs.utimesSync(dir, d, d);

	return { filePath, lines, imageLineOffset };
}

// ---------------------------------------------------------------------------
// HTTP 辅助（真实请求；agent:false = 每请求独立连接，不留 keep-alive 连接）
// ---------------------------------------------------------------------------

interface RawResponse {
	status: number;
	headers: http.IncomingHttpHeaders;
	raw: Buffer;
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
					resolve({ status: res.statusCode ?? 0, headers: res.headers, raw: Buffer.concat(chunks) });
				});
			},
		);
		req.on("error", reject);
		req.end();
	});
}

function text(res: RawResponse): string {
	return res.raw.toString("utf-8");
}

function jsonOf(res: RawResponse): any {
	return JSON.parse(text(res));
}

/** JSON 响应头统一断言：content-type 为 application/json; charset=utf-8 且 no-store。 */
function expectJsonHeaders(res: RawResponse): void {
	expect(res.headers["content-type"]).toBe("application/json; charset=utf-8");
	expect(res.headers["cache-control"]).toBe("no-store");
}

/** 错误响应体统一断言：单个非空 error 字符串字段。 */
function expectJsonError(res: RawResponse): any {
	expectJsonHeaders(res);
	const body = jsonOf(res);
	expect(typeof body.error).toBe("string");
	expect(body.error.length).toBeGreaterThan(0);

	return body;
}

/** 带合法 token 的 /api/session 读取路径。 */
function sessionPath(taskId: string, token: string): string {
	return `/api/session?${new URLSearchParams({ taskId, offset: "0", tail: "0", t: token })}`;
}

/**
 * /api/image 路径构造。taskId/token 传 null 表示省略该参数（测缺失分支）；
 * params 中 undefined 值同样省略。
 */
function imagePath(
	taskId: string | null,
	token: string | null,
	params: Record<string, string | undefined>,
): string {
	const search = new URLSearchParams();
	if (token !== null) search.set("t", token);
	if (taskId !== null) search.set("taskId", taskId);
	for (const [key, value] of Object.entries(params)) {
		if (value !== undefined) search.set(key, value);
	}

	return `/api/image?${search.toString()}`;
}

/** 从 /api/session 响应里定位被剥离的 image part（type === "image"）。 */
function imagePartOf(body: any): any {
	for (const entry of body.entries) {
		const content = entry?.message?.content;
		if (!Array.isArray(content)) continue;
		for (const part of content) {
			if (part && part.type === "image") return part;
		}
	}

	return undefined;
}

// ================================================================
// /api/session 图片剥离契约
// ================================================================

describe("/api/session 图片剥离", () => {
	it("should strip base64 data from the image part and expose imageRef and byteLength", async () => {
		// Arrange
		const handle = await start();
		const taskId = uuid(1);
		const fixture = writeImageSession(taskId);

		// Act
		const res = await request(handle.port, sessionPath(taskId, handle.token));

		// Assert: 200 + 结构字段不变
		expect(res.status).toBe(200);
		expectJsonHeaders(res);
		const body = jsonOf(res);
		expect(body.taskId).toBe(taskId);
		expect(body.offset).toBe(0);
		expect(body.malformed).toBe(0);
		expect(body.hasMore).toBe(false);
		expect(body.nextOffset).toBe(fs.statSync(fixture.filePath).size);

		// Assert: image part 被替换为占位形状，entryIndex = 该行绝对字节偏移
		const part = imagePartOf(body);
		expect(part).toEqual({
			type: "image",
			mimeType: "image/png",
			byteLength: 70,
			imageRef: { entryIndex: fixture.imageLineOffset, block: 0 },
		});
		expect(part).not.toHaveProperty("data");

		// Assert: 整个响应体序列化后不得出现 "data":"（base64 不下发）
		expect(JSON.stringify(body)).not.toContain('"data":"');
	});

	it("should keep entries without images deep-equal to their original JSONL lines", async () => {
		// Arrange
		const handle = await start();
		const taskId = uuid(2);
		const fixture = writeImageSession(taskId);

		// Act
		const res = await request(handle.port, sessionPath(taskId, handle.token));

		// Assert: 前三条（session 头 / user / assistant）剥离后仍等于原行
		expect(res.status).toBe(200);
		const body = jsonOf(res);
		expect(body.entries).toHaveLength(4);
		expect(body.entries[0]).toEqual(JSON.parse(fixture.lines[0]));
		expect(body.entries[1]).toEqual(JSON.parse(fixture.lines[1]));
		expect(body.entries[2]).toEqual(JSON.parse(fixture.lines[2]));
	});
});

// ================================================================
// /api/image 请求校验（与 /api/session 复用同一鉴权链）
// ================================================================

describe("/api/image 请求校验（方法 → Host → Origin → token）", () => {
	it("should return 403 with no-store when the token query parameter is missing", async () => {
		// Arrange
		const handle = await start();
		const taskId = uuid(3);
		writeImageSession(taskId);

		// Act
		const res = await request(handle.port, imagePath(taskId, null, { entry: "0", block: "0" }));

		// Assert
		expect(res.status).toBe(403);
		expect(res.headers["cache-control"]).toBe("no-store");
		expectJsonError(res);
	});

	it("should return 403 when the Host header does not match loopback with the server port", async () => {
		// Arrange
		const handle = await start();
		const taskId = uuid(4);
		writeImageSession(taskId);

		// Act: 连到正确端口但 Host 伪造为外部域名（DNS rebinding 形状）
		const res = await request(handle.port, imagePath(taskId, handle.token, { entry: "0", block: "0" }), {
			headers: { Host: `evil.example.com:${handle.port}` },
		});

		// Assert
		expect(res.status).toBe(403);
		expectJsonError(res);
	});

	it("should return 403 when the Origin header does not match the server origin", async () => {
		// Arrange
		const handle = await start();
		const taskId = uuid(5);
		writeImageSession(taskId);

		// Act
		const res = await request(handle.port, imagePath(taskId, handle.token, { entry: "0", block: "0" }), {
			headers: { Origin: "http://evil.example.com" },
		});

		// Assert
		expect(res.status).toBe(403);
		expectJsonError(res);
	});

	it("should return 405 when the request method is not GET", async () => {
		// Arrange
		const handle = await start();
		const taskId = uuid(6);
		writeImageSession(taskId);

		// Act: 其余校验全部合法，只有方法非法
		const res = await request(handle.port, imagePath(taskId, handle.token, { entry: "0", block: "0" }), {
			method: "POST",
		});

		// Assert
		expect(res.status).toBe(405);
		expect(res.headers["cache-control"]).toBe("no-store");
		expectJsonError(res);
	});
});

// ================================================================
// /api/image taskId 校验（顺序与 /api/session 完全一致）
// ================================================================

describe("/api/image taskId 校验", () => {
	it("should return 400 when taskId is missing", async () => {
		// Arrange
		const handle = await start();

		// Act: entry/block 合法，仅缺 taskId
		const res = await request(handle.port, imagePath(null, handle.token, { entry: "0", block: "0" }));

		// Assert
		expect(res.status).toBe(400);
		expectJsonError(res);
	});

	it("should return 403 when taskId traverses outside the sessions root", async () => {
		// Arrange: rootDir 同级放置真实的外部会话文件，taskId 用 ../ 穿越过去
		const handle = await start();
		const outsideDir = path.join(tmpDir, "outside");
		fs.mkdirSync(outsideDir, { recursive: true });
		fs.writeFileSync(path.join(outsideDir, "session.jsonl"), '{"seq":1}\n', "utf-8");

		// Act: entry/block 合法 —— 穿越必须先于其余形状检查判 403
		const res = await request(
			handle.port,
			imagePath("../outside", handle.token, { entry: "0", block: "0" }),
		);

		// Assert
		expect(res.status).toBe(403);
		expectJsonError(res);
	});

	it("should return 400 when taskId is not UUID-shaped and does not traverse", async () => {
		// Arrange
		const handle = await start();

		// Act
		const res = await request(
			handle.port,
			imagePath("not-a-uuid", handle.token, { entry: "0", block: "0" }),
		);

		// Assert
		expect(res.status).toBe(400);
		expectJsonError(res);
	});

	it("should return 404 when no session file exists for a valid taskId", async () => {
		// Arrange: 合法 UUID 形状但 rootDir 下无该任务目录
		const handle = await start();

		// Act
		const res = await request(handle.port, imagePath(uuid(99), handle.token, { entry: "0", block: "0" }));

		// Assert
		expect(res.status).toBe(404);
		expectJsonError(res);
	});
});

// ================================================================
// /api/image entry / block 参数校验
// ================================================================

describe("/api/image entry / block 参数校验", () => {
	it("should return 400 when entry is missing", async () => {
		// Arrange: 合法 taskId + 会话文件，仅缺 entry
		const handle = await start();
		const taskId = uuid(10);
		writeImageSession(taskId);

		// Act
		const res = await request(handle.port, imagePath(taskId, handle.token, { block: "0" }));

		// Assert
		expect(res.status).toBe(400);
		expectJsonError(res);
	});

	it("should return 400 when entry is negative", async () => {
		// Arrange
		const handle = await start();
		const taskId = uuid(11);
		writeImageSession(taskId);

		// Act
		const res = await request(handle.port, imagePath(taskId, handle.token, { entry: "-1", block: "0" }));

		// Assert
		expect(res.status).toBe(400);
		expectJsonError(res);
	});

	it("should return 400 when entry is not an integer string", async () => {
		// Arrange
		const handle = await start();
		const taskId = uuid(12);
		writeImageSession(taskId);

		// Act / Assert: 非数字与小数都不接受
		const notNumber = await request(handle.port, imagePath(taskId, handle.token, { entry: "abc", block: "0" }));
		expect(notNumber.status).toBe(400);
		expectJsonError(notNumber);

		const fraction = await request(handle.port, imagePath(taskId, handle.token, { entry: "1.5", block: "0" }));
		expect(fraction.status).toBe(400);
		expectJsonError(fraction);
	});

	it("should return 400 when block is missing", async () => {
		// Arrange
		const handle = await start();
		const taskId = uuid(13);
		const fixture = writeImageSession(taskId);

		// Act
		const res = await request(
			handle.port,
			imagePath(taskId, handle.token, { entry: String(fixture.imageLineOffset) }),
		);

		// Assert
		expect(res.status).toBe(400);
		expectJsonError(res);
	});

	it("should return 400 when block is negative or not an integer string", async () => {
		// Arrange
		const handle = await start();
		const taskId = uuid(14);
		const fixture = writeImageSession(taskId);
		const entry = String(fixture.imageLineOffset);

		// Act / Assert: 负数
		const negative = await request(handle.port, imagePath(taskId, handle.token, { entry, block: "-1" }));
		expect(negative.status).toBe(400);
		expectJsonError(negative);

		// Act / Assert: 非数字
		const notNumber = await request(handle.port, imagePath(taskId, handle.token, { entry, block: "x" }));
		expect(notNumber.status).toBe(400);
		expectJsonError(notNumber);
	});
});

// ================================================================
// /api/image 正向读取与 lookup 错误映射
// ================================================================

describe("/api/image 读取与错误映射", () => {
	it("should return the raw image bytes with the part's content type, no-store and a correct content-length", async () => {
		// Arrange: 先读 /api/session，拿 strip 后的 imageRef.entryIndex / block
		const handle = await start();
		const taskId = uuid(20);
		writeImageSession(taskId);
		const sessionRes = await request(handle.port, sessionPath(taskId, handle.token));
		expect(sessionRes.status).toBe(200);
		const part = imagePartOf(jsonOf(sessionRes));
		expect(part).toHaveProperty("imageRef");

		// Act
		const res = await request(
			handle.port,
			imagePath(taskId, handle.token, {
				entry: String(part.imageRef.entryIndex),
				block: String(part.imageRef.block),
			}),
		);

		// Assert: 200 + 原始字节 + 头逐字段钉死
		expect(res.status).toBe(200);
		expect(res.headers["content-type"]).toBe("image/png");
		expect(res.headers["cache-control"]).toBe("no-store");
		expect(res.headers["content-length"]).toBe(String(PNG_BYTES.length));
		expect(res.raw.length).toBe(70);
		expect(res.raw.equals(PNG_BYTES)).toBe(true);
	});

	it("should return 404 with a JSON error body when the entry offset has no image", async () => {
		// Arrange: entry=0 指向 session 头行（合法偏移，但该行没有 image part）
		const handle = await start();
		const taskId = uuid(21);
		writeImageSession(taskId);

		// Act
		const res = await request(handle.port, imagePath(taskId, handle.token, { entry: "0", block: "0" }));

		// Assert
		expect(res.status).toBe(404);
		expectJsonError(res);
	});

	it("should return 404 when the entry offset is beyond the session file", async () => {
		// Arrange
		const handle = await start();
		const taskId = uuid(22);
		const fixture = writeImageSession(taskId);
		const beyond = fs.statSync(fixture.filePath).size + 1000;

		// Act
		const res = await request(handle.port, imagePath(taskId, handle.token, { entry: String(beyond), block: "0" }));

		// Assert
		expect(res.status).toBe(404);
		expectJsonError(res);
	});

	it("should return 404 when the block does not exist in the entry", async () => {
		// Arrange: 该行只有 block 0
		const handle = await start();
		const taskId = uuid(23);
		const fixture = writeImageSession(taskId);

		// Act
		const res = await request(
			handle.port,
			imagePath(taskId, handle.token, { entry: String(fixture.imageLineOffset), block: "7" }),
		);

		// Assert
		expect(res.status).toBe(404);
		expectJsonError(res);
	});

	it("should return 413 with byteLength when the image exceeds maxImageBytes", async () => {
		// Arrange: 小阈值 10 字节 < PNG 的 70 字节
		const handle = await start({ maxImageBytes: 10 });
		const taskId = uuid(24);
		const fixture = writeImageSession(taskId);

		// Act
		const res = await request(
			handle.port,
			imagePath(taskId, handle.token, { entry: String(fixture.imageLineOffset), block: "0" }),
		);

		// Assert: 413 + {error, byteLength} JSON
		expect(res.status).toBe(413);
		expectJsonHeaders(res);
		const body = jsonOf(res);
		expect(Object.keys(body).sort()).toEqual(["byteLength", "error"]);
		expect(body.byteLength).toBe(70);
		expect(typeof body.error).toBe("string");
		expect(body.error.length).toBeGreaterThan(0);
	});

	it("should return 404 for an unknown path below /api/image", async () => {
		// Arrange
		const handle = await start();
		const taskId = uuid(25);
		writeImageSession(taskId);

		// Act: 未知子路径落回通用 404（可选守卫）
		const res = await request(
			handle.port,
			`/api/image/extra?${new URLSearchParams({ taskId, entry: "0", block: "0", t: handle.token })}`,
		);

		// Assert
		expect(res.status).toBe(404);
		expectJsonError(res);
	});
});
