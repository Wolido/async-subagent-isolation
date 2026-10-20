/**
 * 红阶段测试：`src/web/images.ts` —— 图片懒加载的服务端剥离/查找纯函数模块。
 * 模块尚不存在，本文件整体红属预期。
 *
 * 被测接口（固定签名，实现者照此实现）：
 *   MAX_IMAGE_BYTES = 16 * 1024 * 1024
 *   base64ByteLength(data)                    —— O(1) 估算解码后字节数，不分配 Buffer；空串 => 0
 *   imageMimeType({ mimeType?, data })        —— 显式非空字符串 mimeType 优先；否则从 base64 头
 *                                                嗅探 PNG/JPEG/GIF/WebP；否则 application/octet-stream
 *   stripImages(entries, entryOffsets)        —— 深拷贝并把带 string `data` 的 image part 替换为
 *                                                { type, mimeType, byteLength, imageRef:{entryIndex,block} }；
 *                                                entryIndex = entryOffsets[i]，block = entry 内 image part
 *                                                的 0 基顺序序号（跨整个 entry 计数，非数组下标）；
 *                                                不改入参、非 image part 原样、剥离后不残留 data
 *   lookupImage(filePath, entryOffset, block, maxBytes?)
 *                                             —— 读 entryOffset 处 JSONL 行，取序号 block 的 image part
 *                                                解码字节：
 *                                                - 字节数 > maxBytes（默认 MAX_IMAGE_BYTES）
 *                                                  => too-large，且不得分配解码 Buffer
 *                                                - 行读取有上限（无换行超限 => too-large）
 *                                                - offset 越界 / JSON 坏 / block 不在 => not-found
 *
 * 约定（沿仓库惯例）：globals:false 显式 import from "vitest"；fixture 用
 * fs.mkdtempSync(os.tmpdir()) + afterEach 递归删除；纯函数 + 临时 JSONL 文件，
 * 无网络、无服务。
 */

import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { MAX_IMAGE_BYTES, base64ByteLength, imageMimeType, stripImages, lookupImage } from "../src/web/images.ts";

// ---------------------------------------------------------------------------
// fixture 常量
// ---------------------------------------------------------------------------

/** 1×1 透明 PNG 的 base64（解码后恰好 70 字节）。 */
const PNG_B64 =
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const PNG_BYTES = Buffer.from(PNG_B64, "base64");
expect(PNG_BYTES.length, "前提自检：PNG fixture 必须是 70 字节").toBe(70);

/** 第二张图：伪造 JPEG 头的字节序列（与 PNG 不同，用于区分 block 0/1）。 */
const JPEG_BYTES = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]);
const JPEG_B64 = JPEG_BYTES.toString("base64");

/**
 * 各格式 magic 的 base64 前缀常量（由 magic 字节生成，避免手抄漂移）：
 *   PNG   89 50 4E 47            -> iVBORw（前 6 字符覆盖 4 字节 magic）
 *   JPEG  FF D8 FF               -> /9j/
 *   GIF   "GIF89a"               -> R0lGODlh
 *   WebP  "RIFF" + size + "WEBP" -> UklGRiQAAABXRUJQ
 */
const PNG_B64_PREFIX = Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString("base64").replace(/=+$/, "");
const JPEG_B64_PREFIX = Buffer.from([0xff, 0xd8, 0xff]).toString("base64");
const GIF_B64_PREFIX = Buffer.from("GIF89a", "ascii").toString("base64");
const WEBP_B64_PREFIX = Buffer.concat([
	Buffer.from("RIFF", "ascii"),
	Buffer.from([0x24, 0x00, 0x00, 0x00]),
	Buffer.from("WEBP", "ascii"),
]).toString("base64");

/** 用 magic 的 base64 前缀 + 补零字符构造一段可嗅探的 base64 载荷。 */
function payloadAfterPrefix(prefix: string): string {
	return prefix + "AAAAAAAA".repeat(4);
}

// ================================================================
// base64ByteLength
// ================================================================

describe("base64ByteLength（O(1) 解码字节数估算）", () => {
	it("should return 0 for the empty string", () => {
		// Arrange / Act
		const length = base64ByteLength("");

		// Assert
		expect(length).toBe(0);
	});

	it("should count decoded bytes for padded base64", () => {
		// Arrange / Act / Assert
		expect(base64ByteLength("YQ==")).toBe(1); // "a"
		expect(base64ByteLength("YWJj")).toBe(3); // "abc"
		expect(base64ByteLength("aGVsbG8=")).toBe(5); // "hello"
	});

	it("should count decoded bytes for unpadded base64", () => {
		// Arrange / Act / Assert
		expect(base64ByteLength("YQ")).toBe(1);
		expect(base64ByteLength("aGVsbG8")).toBe(5);
	});

	it("should report the decoded byte length of the known 1x1 PNG fixture", () => {
		// Arrange / Act
		const length = base64ByteLength(PNG_B64);

		// Assert: 与真实解码长度一致（70 字节）
		expect(length).toBe(70);
		expect(length).toBe(PNG_BYTES.length);
	});

	it("should agree with the real decoded length for an arbitrary payload", () => {
		// Arrange: 以 Buffer 解码为参照（仅测试内做 oracle，被测实现不得分配 Buffer）
		const payload = Buffer.from("the quick brown fox jumps over the lazy dog", "utf-8").toString("base64");

		// Act
		const length = base64ByteLength(payload);

		// Assert
		expect(length).toBe(Buffer.from(payload, "base64").length);
	});
});

// ================================================================
// imageMimeType
// ================================================================

describe("imageMimeType（mimeType 优先，缺失时嗅探 base64 头）", () => {
	it("should prefer an explicit non-empty mimeType over sniffing", () => {
		// Arrange / Act / Assert: 数据是 PNG，但显式声明 image/jpeg → 尊重显式值
		expect(imageMimeType({ mimeType: "image/jpeg", data: PNG_B64 })).toBe("image/jpeg");
		expect(imageMimeType({ mimeType: "image/webp", data: PNG_B64 })).toBe("image/webp");
	});

	it("should sniff PNG when mimeType is absent, not a string, or empty", () => {
		// Arrange / Act / Assert: 三种「无有效显式 mimeType」的形态都回落到嗅探
		expect(imageMimeType({ data: PNG_B64 })).toBe("image/png");
		expect(imageMimeType({ mimeType: 42, data: PNG_B64 })).toBe("image/png");
		expect(imageMimeType({ mimeType: "", data: PNG_B64 })).toBe("image/png");
		expect(imageMimeType({ mimeType: null, data: PNG_B64 })).toBe("image/png");
	});

	it("should sniff JPEG from the base64 head", () => {
		// Arrange
		const data = payloadAfterPrefix(JPEG_B64_PREFIX);

		// Act / Assert
		expect(data.startsWith(JPEG_B64_PREFIX)).toBe(true);
		expect(imageMimeType({ data })).toBe("image/jpeg");
	});

	it("should sniff GIF from the base64 head", () => {
		// Arrange
		const data = payloadAfterPrefix(GIF_B64_PREFIX);

		// Act / Assert
		expect(data.startsWith(GIF_B64_PREFIX)).toBe(true);
		expect(imageMimeType({ data })).toBe("image/gif");
	});

	it("should sniff WebP (RIFF....WEBP) from the base64 head", () => {
		// Arrange
		const data = payloadAfterPrefix(WEBP_B64_PREFIX);

		// Act / Assert
		expect(data.startsWith(WEBP_B64_PREFIX)).toBe(true);
		expect(imageMimeType({ data })).toBe("image/webp");
	});

	it("should sniff PNG from the real fixture's base64 head", () => {
		// Arrange / Act / Assert
		expect(PNG_B64.startsWith(PNG_B64_PREFIX)).toBe(true);
		expect(imageMimeType({ data: PNG_B64 })).toBe("image/png");
	});

	it("should fall back to application/octet-stream for unknown or empty data", () => {
		// Arrange
		const unknown = Buffer.from("hello world", "utf-8").toString("base64");

		// Act / Assert
		expect(imageMimeType({ data: unknown })).toBe("application/octet-stream");
		expect(imageMimeType({ data: "" })).toBe("application/octet-stream");
	});
});

// ================================================================
// stripImages
// ================================================================

describe("stripImages（深拷贝 + 剥离 base64 image part）", () => {
	it("should replace an image part in assistant content with a stripped placeholder", () => {
		// Arrange: assistant 消息含 text + image 两段
		const entries = [
			{
				type: "message",
				message: {
					role: "assistant",
					content: [
						{ type: "text", text: "here is a picture" },
						{ type: "image", mimeType: "image/png", data: PNG_B64 },
					],
				},
			},
		];

		// Act
		const stripped = stripImages(entries, [4096]);

		// Assert: 替换后的形状逐字段钉死，data 字段消失
		const part = (stripped[0] as any).message.content[1];
		expect(part).toEqual({
			type: "image",
			mimeType: "image/png",
			byteLength: 70,
			imageRef: { entryIndex: 4096, block: 0 },
		});
		expect(part).not.toHaveProperty("data");
	});

	it("should replace an image part in toolResult content", () => {
		// Arrange
		const entries = [
			{
				type: "message",
				message: {
					role: "toolResult",
					toolCallId: "call-1",
					toolName: "view",
					content: [{ type: "image", mimeType: "image/png", data: PNG_B64 }],
					isError: false,
				},
			},
		];

		// Act
		const stripped = stripImages(entries, [0]);

		// Assert
		const part = (stripped[0] as any).message.content[0];
		expect(part).toEqual({
			type: "image",
			mimeType: "image/png",
			byteLength: 70,
			imageRef: { entryIndex: 0, block: 0 },
		});
		expect(part).not.toHaveProperty("data");
	});

	it("should replace an image part carried by a non-assistant, non-toolResult role", () => {
		// Arrange: user 角色的图片同样被剥离
		const entries = [
			{
				type: "message",
				message: {
					role: "user",
					content: [
						{ type: "text", text: "see this" },
						{ type: "image", mimeType: "image/png", data: PNG_B64 },
					],
				},
			},
		];

		// Act
		const stripped = stripImages(entries, [7]);

		// Assert
		const part = (stripped[0] as any).message.content[1];
		expect(part).toEqual({
			type: "image",
			mimeType: "image/png",
			byteLength: 70,
			imageRef: { entryIndex: 7, block: 0 },
		});
		expect(part).not.toHaveProperty("data");
	});

	it("should replace an image part at an arbitrary nested position", () => {
		// Arrange: image part 不在 message.content，而藏在深层结构里
		const entries = [{ type: "custom", payload: { nested: [{ type: "image", data: PNG_B64 }] } }];

		// Act
		const stripped = stripImages(entries, [100]);

		// Assert
		const part = (stripped[0] as any).payload.nested[0];
		expect(part).toEqual({
			type: "image",
			mimeType: "image/png",
			byteLength: 70,
			imageRef: { entryIndex: 100, block: 0 },
		});
		expect(part).not.toHaveProperty("data");
	});

	it("should number blocks 0,1,2 across the whole entry regardless of array indices", () => {
		// Arrange: 三张图分别在 content 下标 1/3/5（非图片 part 插在中间）
		const entries = [
			{
				type: "message",
				message: {
					role: "assistant",
					content: [
						{ type: "text", text: "before" },
						{ type: "image", mimeType: "image/png", data: PNG_B64 },
						{ type: "text", text: "middle" },
						{ type: "image", mimeType: "image/jpeg", data: JPEG_B64 },
						{ type: "text", text: "between" },
						{ type: "image", mimeType: "image/png", data: PNG_B64 },
					],
				},
			},
		];

		// Act
		const stripped = stripImages(entries, [555]);
		const content = (stripped[0] as any).message.content;

		// Assert: block 是 image part 的顺序序号（0,1,2），不是数组下标（1,3,5）
		expect(content[1].imageRef).toEqual({ entryIndex: 555, block: 0 });
		expect(content[3].imageRef).toEqual({ entryIndex: 555, block: 1 });
		expect(content[5].imageRef).toEqual({ entryIndex: 555, block: 2 });
		expect(content[3].byteLength).toBe(JPEG_BYTES.length);
		expect(content.filter((p: any) => p.type === "image").every((p: any) => !("data" in p))).toBe(true);
	});

	it("should use each entry's own offset from entryOffsets for imageRef.entryIndex", () => {
		// Arrange: 两条 entry，图片在第二条；offset 一一对应传入
		const entries = [
			{ type: "message", message: { role: "assistant", content: [{ type: "text", text: "no image" }] } },
			{
				type: "message",
				message: {
					role: "toolResult",
					content: [{ type: "image", mimeType: "image/png", data: PNG_B64 }],
				},
			},
		];

		// Act
		const stripped = stripImages(entries, [0, 500]);

		// Assert
		const part = (stripped[1] as any).message.content[0];
		expect(part.imageRef.entryIndex).toBe(500);
		expect(part.imageRef.block).toBe(0);
		expect(stripped[0]).toEqual(entries[0]);
	});

	it("should keep non-image parts unchanged even when they carry a data field", () => {
		// Arrange: text part 原样；带 data 但 type 不是 image 的 part 原样
		const entries = [
			{
				type: "message",
				message: {
					role: "assistant",
					content: [
						{ type: "text", text: "hello" },
						{ type: "file", name: "a.txt", data: "aGVsbG8=" },
					],
				},
			},
		];

		// Act
		const stripped = stripImages(entries, [0]);
		const content = (stripped[0] as any).message.content;

		// Assert
		expect(content[0]).toEqual({ type: "text", text: "hello" });
		expect(content[1]).toEqual({ type: "file", name: "a.txt", data: "aGVsbG8=" });
	});

	it("should keep an image part without a string data field as-is", () => {
		// Arrange: image part 没有 data / data 不是 string → 不属于「带 string data」，原样保留
		const entries = [
			{
				type: "message",
				message: {
					role: "assistant",
					content: [
						{ type: "image", mimeType: "image/png" },
						{ type: "image", mimeType: "image/png", data: 42 },
					],
				},
			},
		];

		// Act
		const stripped = stripImages(entries, [0]);
		const content = (stripped[0] as any).message.content;

		// Assert
		expect(content[0]).toEqual({ type: "image", mimeType: "image/png" });
		expect(content[1]).toEqual({ type: "image", mimeType: "image/png", data: 42 });
	});

	it("should not mutate the input entries array or its nested objects", () => {
		// Arrange: 深拷贝入参作为对照
		const entries = [
			{
				type: "message",
				message: {
					role: "assistant",
					content: [
						{ type: "text", text: "keep" },
						{ type: "image", mimeType: "image/png", data: PNG_B64 },
					],
				},
			},
		];
		const snapshot = structuredClone(entries);

		// Act
		const stripped = stripImages(entries, [11]);

		// Assert: 入参逐字节不变；返回的是新数组/新对象（深拷贝）
		expect(entries).toEqual(snapshot);
		expect(stripped).not.toBe(entries);
		expect(stripped[0]).not.toBe(entries[0]);
	});

	it("should leave entries without images deep-equal to their originals", () => {
		// Arrange: 无图片的普通 entry
		const entries = [
			{ type: "session", sessionId: "s-1" },
			{ type: "message", message: { role: "assistant", content: [{ type: "text", text: "done" }] } },
		];
		const snapshot = structuredClone(entries);

		// Act
		const stripped = stripImages(entries, [0, 40]);

		// Assert
		expect(stripped).toEqual(snapshot);
		expect(stripped).toEqual(entries);
	});

	// ---- 字符串内嵌 data URI：与结构化 image part 并行的第二条剥离路径 ----
	// 真实会话里 toolResult 正文常把图片以 Markdown 内嵌 data URI 塞进字符串，
	// 单行因此 >9MiB 无法回填；占位格式固定为
	// `[图片已省略：<mime>，<size>]`（全角冒号/逗号），size 由 base64ByteLength 决定。

	it("should replace an inline Markdown data-URI image with a size placeholder", () => {
		// Arrange: assistant 文本里内嵌一整个 Markdown 图片（data URI 走字符串）
		const entries = [
			{
				type: "message",
				message: {
					role: "assistant",
					content: [{ type: "text", text: `看图 ![样张](data:image/png;base64,${PNG_B64}) 完成` }],
				},
			},
		];

		// Act
		const stripped = stripImages(entries, [0]);

		// Assert: 整段 Markdown 图片变成一个占位；前后文字保留；data URI 不再残留
		const text = (stripped[0] as any).message.content[0].text;
		expect(text).toBe("看图 [图片已省略：image/png，70 B] 完成");
		expect(text).not.toContain("data:image");
		expect(text.startsWith("看图 ")).toBe(true);
		expect(text.endsWith(" 完成")).toBe(true);
	});

	it("should replace a bare data URI inside text with a size placeholder", () => {
		// Arrange: 没有 Markdown 语法包裹的裸 data URI
		const entries = [
			{
				type: "message",
				message: {
					role: "toolResult",
					content: [{ type: "text", text: `截图：data:image/png;base64,${PNG_B64} 结束` }],
				},
			},
		];

		// Act
		const stripped = stripImages(entries, [0]);

		// Assert: 只替换 URI 本身，周围文字不动
		const text = (stripped[0] as any).message.content[0].text;
		expect(text).toBe("截图：[图片已省略：image/png，70 B] 结束");
		expect(text).not.toContain("data:image");
	});

	it("should leave ordinary text and external markdown images untouched", () => {
		// Arrange: 普通文本 + 外链 Markdown 图片（非 data URI）+ 行内 code
		const original = "普通文本 ![外链](https://example.com/a.png) 与 code";
		const entries = [
			{ type: "message", message: { role: "assistant", content: [{ type: "text", text: original }] } },
		];

		// Act
		const stripped = stripImages(entries, [0]);

		// Assert: 逐字相同（不要求引用相等）
		const text = (stripped[0] as any).message.content[0].text;
		expect(text).toEqual(original);
	});

	it("should strip multiple inline images in one string", () => {
		// Arrange: 同一个字符串里两处 data URI，中间夹文字
		const text = `A ![one](data:image/png;base64,${PNG_B64}) B data:image/png;base64,${PNG_B64} C`;
		const entries = [{ type: "message", message: { role: "assistant", content: [{ type: "text", text }] } }];

		// Act
		const stripped = stripImages(entries, [0]);

		// Assert: 两处都变占位，夹在中间的文字保留
		const result = (stripped[0] as any).message.content[0].text;
		expect(result).toBe(
			"A [图片已省略：image/png，70 B] B [图片已省略：image/png，70 B] C",
		);
		expect(result).not.toContain("data:image");
	});

	it("should shrink a 10 MiB inline base64 payload to a short placeholder", () => {
		// Arrange: 10 MiB 的 base64 载荷（解码 7,864,320 B → 7.5 MB）
		const text = `BEFORE ![img](data:image/png;base64,${"A".repeat(10 * 1024 * 1024)}) AFTER`;
		const entries = [
			{ type: "message", message: { role: "toolResult", content: [{ type: "text", text }] } },
		];

		// Act
		const stripped = stripImages(entries, [0]);

		// Assert: 行被压到很短，尺寸按 MB（1 位小数）呈现，两端文字保留
		const result = (stripped[0] as any).message.content[0].text;
		expect(result.length).toBeLessThan(200);
		expect(result).toContain("[图片已省略：image/png，7.5 MB]");
		expect(result).not.toContain("data:image");
		expect(result).toContain("BEFORE");
		expect(result).toContain("AFTER");
		expect(result.endsWith("AFTER")).toBe(true);
	});

	it("should keep the structured image part path working while stripping inline URIs", () => {
		// Arrange: 同一 entry 内既有结构化 image part，又有含 data URI 的 text part
		const entries = [
			{
				type: "message",
				message: {
					role: "assistant",
					content: [
						{ type: "image", mimeType: "image/png", data: PNG_B64 },
						{ type: "text", text: `内嵌 ![img](data:image/png;base64,${PNG_B64}) 结束` },
					],
				},
			},
		];

		// Act
		const stripped = stripImages(entries, [0]);
		const content = (stripped[0] as any).message.content;

		// Assert: 结构化图片仍走 imageRef 懒加载（block 0），text 里的 URI 走文本占位
		expect(content[0]).toEqual({
			type: "image",
			mimeType: "image/png",
			byteLength: 70,
			imageRef: { entryIndex: 0, block: 0 },
		});
		expect(content[0]).not.toHaveProperty("data");
		expect(content[1].text).toBe("内嵌 [图片已省略：image/png，70 B] 结束");
		expect(content[1].text).not.toContain("data:image");
	});
});

// ================================================================
// lookupImage
// ================================================================

describe("lookupImage（按 entryOffset + block 从 JSONL 行取图）", () => {
	let tmpDir: string;
	let filePath: string;
	let lineOffsets: number[];

	beforeEach(() => {
		// Arrange: 三行 JSONL —— session 头 / 含两张图的 toolResult / assistant 文本
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "subagent-web-images-"));
		const lines = [
			JSON.stringify({ type: "session", sessionId: "s-1" }),
			JSON.stringify({
				type: "message",
				id: "msg-img",
				message: {
					role: "toolResult",
					toolCallId: "call-1",
					toolName: "view",
					content: [
						{ type: "text", text: "screenshot" },
						{ type: "image", mimeType: "image/png", data: PNG_B64 },
						{ type: "text", text: "and" },
						{ type: "image", mimeType: "image/jpeg", data: JPEG_B64 },
					],
					isError: false,
				},
			}),
			JSON.stringify({
				type: "message",
				id: "msg-asst",
				message: { role: "assistant", content: [{ type: "text", text: "done" }] },
			}),
		];
		lineOffsets = [];
		let position = 0;
		for (const line of lines) {
			lineOffsets.push(position);
			position += Buffer.byteLength(line, "utf-8") + 1;
		}
		filePath = path.join(tmpDir, "session.jsonl");
		fs.writeFileSync(filePath, lines.join("\n") + "\n", "utf-8");
	});

	afterEach(() => {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	it("should expose the default 16 MiB max image size", () => {
		// Arrange / Act / Assert
		expect(MAX_IMAGE_BYTES).toBe(16 * 1024 * 1024);
	});

	it("should decode and return the first image of the entry at the given line offset", () => {
		// Arrange / Act
		const result = lookupImage(filePath, lineOffsets[1], 0);

		// Assert
		expect(result.kind).toBe("ok");
		if (result.kind !== "ok") return;
		expect(result.mimeType).toBe("image/png");
		expect(Buffer.isBuffer(result.data)).toBe(true);
		expect(result.data.equals(PNG_BYTES)).toBe(true);
		expect(result.data.length).toBe(70);
	});

	it("should select the second image of the same entry via block 1", () => {
		// Arrange / Act
		const result = lookupImage(filePath, lineOffsets[1], 1);

		// Assert: 同一行内 block 序号区分两张图
		expect(result.kind).toBe("ok");
		if (result.kind !== "ok") return;
		expect(result.mimeType).toBe("image/jpeg");
		expect(result.data.equals(JPEG_BYTES)).toBe(true);
	});

	it("should return not-found for an offset whose line has no image part", () => {
		// Arrange / Act: session 头行与 assistant 行都没有 image
		const header = lookupImage(filePath, lineOffsets[0], 0);
		const assistant = lookupImage(filePath, lineOffsets[2], 0);

		// Assert
		expect(header.kind).toBe("not-found");
		expect(assistant.kind).toBe("not-found");
	});

	it("should return not-found when the block is outside the entry's image list", () => {
		// Arrange / Act: 该行只有 block 0 与 block 1
		const result = lookupImage(filePath, lineOffsets[1], 2);

		// Assert
		expect(result.kind).toBe("not-found");
	});

	it("should return not-found when the offset points into the middle of a line", () => {
		// Arrange / Act: 行内偏移（非行首）→ 读出的不是合法 JSON 行
		const result = lookupImage(filePath, lineOffsets[1] + 3, 0);

		// Assert
		expect(result.kind).toBe("not-found");
	});

	it("should return not-found when the offset is beyond the end of the file", () => {
		// Arrange
		const beyond = Buffer.byteLength(fs.readFileSync(filePath)) + 100;

		// Act
		const result = lookupImage(filePath, beyond, 0);

		// Assert
		expect(result.kind).toBe("not-found");
	});

	it("should return not-found when the line at the offset is malformed JSON", () => {
		// Arrange: 独立 fixture —— 第二行是坏 JSON
		const badPath = path.join(tmpDir, "bad.jsonl");
		fs.writeFileSync(badPath, '{"ok":1}\n{not json\n', "utf-8");

		// Act
		const result = lookupImage(badPath, 9, 0);

		// Assert
		expect(result.kind).toBe("not-found");
	});

	it("should return too-large without allocating a decoded buffer when the image exceeds maxBytes", () => {
		// Arrange: 小阈值 10 字节 < PNG 的 70 字节
		const smallMax = 10;
		expect(PNG_BYTES.length).toBeGreaterThan(smallMax);

		// Act
		const result = lookupImage(filePath, lineOffsets[1], 0, smallMax);

		// Assert: too-large + byteLength，且返回对象不含解码 data（不得分配 Buffer）
		expect(result.kind).toBe("too-large");
		if (result.kind !== "too-large") return;
		expect(result.byteLength).toBe(70);
		expect(result.mimeType).toBe("image/png");
		expect(Object.keys(result)).not.toContain("data");
		expect(result).not.toHaveProperty("data");
	});

	it("should decide too-large without invoking a base64 decode, and decode on the ok path", () => {
		// Arrange: spy Buffer.from 并按编码参数分类。lookupImage 读文件走
		// allocUnsafe/Buffer.concat，全模块唯一形如 Buffer.from(x, "base64") 的调用
		// 是 ok 分支的解码 —— 判据「base64 解码是否发生」因此有判别力，
		// 不是 vacuous 的类型断言（对照：not.toHaveProperty("data") 在类型上恒真）。
		const fromSpy = vi.spyOn(Buffer, "from");
		try {
			// Act 1: maxBytes(10) < 解码长度(70) → too-large 分支
			const tooLarge = lookupImage(filePath, lineOffsets[1], 0, 10);

			// Assert 1: 返回 too-large，且全程未以 base64 编码调用过 Buffer.from（未解码）
			expect(tooLarge.kind).toBe("too-large");
			expect(fromSpy.mock.calls.filter((call) => call[1] === "base64")).toEqual([]);

			// Act 2: 默认阈值 → ok 分支（正向对照，防 spy 被写成「永不调用」的假绿）
			fromSpy.mockClear();
			const ok = lookupImage(filePath, lineOffsets[1], 0);

			// Assert 2: 确实以该图的 base64 字符串调了 Buffer.from 解码，且字节正确
			expect(ok.kind).toBe("ok");
			expect(fromSpy).toHaveBeenCalledWith(PNG_B64, "base64");
			if (ok.kind === "ok") {
				expect(ok.data.equals(PNG_BYTES)).toBe(true);
			}
		} finally {
			fromSpy.mockRestore();
		}
	});
});
