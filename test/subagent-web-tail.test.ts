/**
 * 红阶段测试：`src/web/tail.ts` —— 本地 web 服务追踪 subagent 会话 JSONL 的
 * 第一个模块（两个纯函数 + 有状态 tail 读取器）。模块尚不存在，本文件整体红属预期。
 *
 * 被测接口（固定签名，实现者照此实现）：
 *   alignToLineBoundary(buf, start)       —— 纯函数：start 起（含）第一个 0x0A 之后的索引；无则 -1
 *   parseChunk(buf, maxBytes?)            —— 纯函数：按 '\n' 切行、逐行 JSON.parse（坏行 try/catch 跳过）
 *                                            返回 { entries, malformed, consumed, oversizeLine }
 *   createTailReader() → { read(opts), stateCount() } —— 按 taskId 缓存 { filePath, offset, residual, size, mtimeMs, ino }；
 *                                                    stateCount() = 当前缓存的 per-task 状态数（测试钩子）
 *
 * read() 语义逐条编码成用例：
 *   1. stat 失败 → null，并清该 taskId 的缓存（含 residual 半行残留）
 *   2. 首读 offset:0 + tail:true → 从 max(0, size-512KiB) 快照起、前移到随后第一个
 *      '\n' 之后开始返回；truncatedBefore === true，文件头部 entry 不返回
 *   3. size 未变 → 空增量：entries []、malformed 0、nextOffset 不动、hasMore false
 *   4. 追加后再读（传上次 nextOffset，tail:true）→ 只回新增 entry，nextOffset 单调递增
 *   5. 半行 residual：先只回完整行、nextOffset 停在该行 '\n' 之后；补齐半行+换行后再读
 *      回第 2 条 entry 且 malformed === 0
 *   6. 坏行跳过：夹在合法行之间的非法 JSON 计入 malformed，合法行照常返回
 *   7. 截断（size < offset）与 inode 变化（同名路径被替换）→ 从 0 重新对齐读取，
 *      不因旧 offset 越界报错
 *   8. 单行超过 maxBytes → 该行单独放行（可 parse）、oversizeLine === true
 *   9. 追行累加有 8 MiB 硬上限：单行 ≥ 12 MiB → 不再无限累积，read 返回
 *      oversizeLine === true、entries []、nextOffset 越过该行（丢弃残行、流继续）、
 *      residual 不被无限持有；再次 read 返回空且不重复该行；调用有界（不得 OOM/超时）
 *  10. 半行残留在超过 8 MiB 上限后被丢弃并标记 oversizeLine === true，下次读取不重复该残行
 *  11. < 8 MiB 但 > maxBytes 的单行仍按语义 8 单独放行并 parse（追行上限不误伤小单行）
 *  12. 单个 reader 大量不同 taskId（> 2×64）反复读取 → 每个 task 只回自己的 entry，
 *      不崩溃、不串味（状态表 LRU 上界本身由代码审查，不要求严格断言）
 *  13. 半行拼接的判别力守卫：跨两次读取每条 entry 恰好出现一次、malformed 恒 0、
 *      nextOffset 精确到字节（抓住温和退化：seek 从 base+residual.length 退回 base
 *      → residual 字节被重复消费/重复解析；residual 切片差一字节 → 半行缺首字节
 *      或多带前一行的换行符 → 坏行）
 *  14. 截断边界收紧到 offset + residual：size 仍 ≥ 但 < offset + residual 长度时也必须
 *      丢弃缓存从 0 重新对齐（抓住温和退化：newResidual 恒被清空 → 缓存半行被忽略、
 *      从 offset 继续读只会拿到半截坏数据）
 *  15. LRU 上限锁定：同一 reader 依次读 160 个不同 taskId → stateCount() === 64（有界）
 *  16. residual 超限分支锁定：maxBytes(16 MiB) > 9 MiB 半行 → 一次读满窗口后残行被
 *      丢弃并前移（oversizeLine true、nextOffset = 文件大小）；追加正常行续读只回新增行
 *      （oversizeLine false、malformed 0）
 *
 * readBefore —— 客户端自动向前补齐（替代旧的「Load earlier / MAX_ENTRIES 截断」契约）：
 *   readBefore(filePath, before, maxBytes?) → TailBeforeResult | null
 *   { entries, entryOffsets, malformed, oversizeLine, startOffset, size, mtime }
 *   语义：读取文件字节区间 [startOffset, before) 内的完整行（before 先 clamp 到
 *   [0, size]），按文件顺序升序返回；请求窗口名义 ≤ maxBytes（默认 1 MiB =
 *   1048576），窗口内首行不完整（行从窗口之前开始）时向前扩展窗口直到拿到至少
 *   一条完整行；单行超过 maxBytes 必须被完整取回（不得拆半/丢弃，扩展上限沿用
 *   CHASE_MAX_BYTES 8 MiB 思路）；startOffset = 首条返回 entry 的绝对字节起始偏移
 *   （before===0 或文件为空 → entries []、startOffset 0）；文件不存在/读不到 → null；
 *   坏行跳过并计数（与 parseChunk 一致）；该函数无状态，不得污染
 *   createTailReader() 的 per-taskId 前向缓存。
 *   扩展耗尽 CHASE_MAX_BYTES 仍取不回任何完整行时（单行长度超过
 *   1 MiB 名义窗口 + 8 MiB 扩展上限，即 >9 MiB）：entries []、
 *   oversizeLine true、startOffset ∈ (0, size) —— 有界向前游标，客户端
 *   据此继续回读、不会在同一 before 上死循环。
 *
 * 约定（沿仓库惯例）：globals:false 显式 import from "vitest"；fixture 用
 * fs.mkdtempSync(os.tmpdir()) + afterEach 递归删除；每个用例自建 reader，互不共享状态。
 */

import { describe, expect, it, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { alignToLineBoundary, parseChunk, createTailReader, readBefore } from "../src/web/tail.ts";
import type { TailBeforeResult, TailReadOpts, TailResult } from "../src/web/tail.ts";

type TailReader = ReturnType<typeof createTailReader>;

let tmpDir: string;

beforeEach(() => {
	tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "subagent-web-tail-"));
});

afterEach(() => {
	fs.rmSync(tmpDir, { recursive: true, force: true });
});

/** 写入会话 JSONL fixture，返回绝对路径。 */
function writeJsonl(name: string, content: string): string {
	const filePath = path.join(tmpDir, name);
	fs.writeFileSync(filePath, content, "utf-8");
	return filePath;
}

/** 当前文件字节数 + mtimeMs 快照（用于断言 result.size / result.mtime）。 */
function snapshot(filePath: string): { size: number; mtime: number } {
	const st = fs.statSync(filePath);

	return { size: st.size, mtime: st.mtimeMs };
}

/** read() 应返回结果的用例统一走此入口：非 null 断言 + 解包。 */
function readTail(reader: TailReader, opts: TailReadOpts): TailResult {
	const result = reader.read(opts);
	expect(result, `read(${opts.taskId}) 应返回结果而非 null`).not.toBeNull();

	return result as TailResult;
}

describe("alignToLineBoundary（纯函数：第一个 '\\n' 之后的索引）", () => {
	it("should return the index right after the first newline at or after start", () => {
		// Arrange
		const buf = Buffer.from("abc\ndef\n", "utf-8");

		// Act / Assert
		expect(alignToLineBoundary(buf, 0)).toBe(4);
		expect(alignToLineBoundary(buf, 4)).toBe(8);
	});

	it("should treat a newline exactly at start as the boundary", () => {
		// Arrange
		const buf = Buffer.from("ab\ncd", "utf-8");

		// Act / Assert
		expect(alignToLineBoundary(buf, 2)).toBe(3);
	});

	it("should return -1 when there is no newline at or after start", () => {
		// Arrange
		const noNewline = Buffer.from("abcdef", "utf-8");
		const onlyBeforeStart = Buffer.from("ab\ncd", "utf-8");
		const empty = Buffer.alloc(0);

		// Act / Assert
		expect(alignToLineBoundary(noNewline, 0)).toBe(-1);
		expect(alignToLineBoundary(onlyBeforeStart, 3)).toBe(-1);
		expect(alignToLineBoundary(empty, 0)).toBe(-1);
	});
});

describe("parseChunk（纯函数：切行 + 逐行 JSON.parse）", () => {
	it("should parse every complete line and consume through the last newline", () => {
		// Arrange
		const buf = Buffer.from('{"a":1}\n{"b":2}\n', "utf-8");

		// Act
		const result = parseChunk(buf);

		// Assert
		expect(result.entries).toEqual([{ a: 1 }, { b: 2 }]);
		expect(result.malformed).toBe(0);
		expect(result.consumed).toBe(buf.length);
		expect(result.oversizeLine).toBe(false);
	});

	it("should leave a trailing partial line unparsed and stop consumed at the last newline", () => {
		// Arrange
		const buf = Buffer.from('{"a":1}\n{"b":', "utf-8");

		// Act
		const result = parseChunk(buf);

		// Assert: consumed = 到最后一个 '\n'（含）= 8
		expect(result.entries).toEqual([{ a: 1 }]);
		expect(result.malformed).toBe(0);
		expect(result.consumed).toBe(8);
		expect(result.oversizeLine).toBe(false);
	});

	it("should skip a malformed line between valid lines and count it once", () => {
		// Arrange
		const buf = Buffer.from('{"a":1}\n{not json\n{"b":2}\n', "utf-8");

		// Act
		const result = parseChunk(buf);

		// Assert
		expect(result.entries).toEqual([{ a: 1 }, { b: 2 }]);
		expect(result.malformed).toBe(1);
		expect(result.consumed).toBe(buf.length);
		expect(result.oversizeLine).toBe(false);
	});

	it("should consume nothing when the buffer contains no newline", () => {
		// Arrange
		const buf = Buffer.from('{"a":1}', "utf-8");

		// Act
		const result = parseChunk(buf);

		// Assert
		expect(result.entries).toEqual([]);
		expect(result.malformed).toBe(0);
		expect(result.consumed).toBe(0);
		expect(result.oversizeLine).toBe(false);
	});

	it("should admit a line longer than maxBytes, flag oversizeLine and still consume it", () => {
		// Arrange: 单行 63 字节 > maxBytes 10
		const payload = "x".repeat(50);
		const buf = Buffer.from(`{"payload":"${payload}"}\n`, "utf-8");

		// Act
		const result = parseChunk(buf, 10);

		// Assert
		expect(result.entries.length).toBe(1);
		expect(result.entries[0].payload).toBe(payload);
		expect(result.malformed).toBe(0);
		expect(result.consumed).toBe(buf.length);
		expect(result.oversizeLine).toBe(true);
	});
});

describe("createTailReader().read — 会话 JSONL 追踪契约", () => {
	it("should return null when the file does not exist (stat fails)", () => {
		// Arrange
		const reader = createTailReader();
		const missingPath = path.join(tmpDir, "missing.jsonl");

		// Act
		const result = reader.read({ taskId: "t-missing", filePath: missingPath });

		// Assert
		expect(result).toBeNull();
	});

	it("should drop the cached residual when the file disappears so a recreated file is read from scratch", () => {
		// Arrange: 半行残留的文件
		const filePath = writeJsonl("session.jsonl", '{"n":1}\n{"n":2');
		const reader = createTailReader();

		// Act 1: 首读回完整行，residual 缓存在 reader 内
		const first = readTail(reader, { taskId: "t1", filePath });
		expect(first.entries).toEqual([{ n: 1 }]);
		expect(first.nextOffset).toBe(8);
		expect(first.hasMore).toBe(true);

		// Act 2: 删除文件 → null（并清缓存）
		fs.unlinkSync(filePath);
		const gone = reader.read({ taskId: "t1", filePath, offset: first.nextOffset });

		// Act 3: 同名重建不同内容 → 必须从 0 读全
		fs.writeFileSync(filePath, '{"n":9}\n{"n":8}\n', "utf-8");
		const fresh = readTail(reader, { taskId: "t1", filePath, offset: 0 });

		// Assert: 旧 residual 未拼接（否则首行成坏行）、旧 offset 未沿用（否则少一条）
		expect(gone).toBeNull();
		expect(fresh.entries).toEqual([{ n: 9 }, { n: 8 }]);
		expect(fresh.malformed).toBe(0);
		expect(fresh.nextOffset).toBe(16);
		expect(fresh.hasMore).toBe(false);
		expect(fresh.truncatedBefore).toBe(false);
	});

	it("should skip the file head and set truncatedBefore when the first read starts at offset 0 with tail true", () => {
		// Arrange: >512KiB 的文件，头部一条 "first"、尾部一条 "last"，中间全是 padding
		const lines: string[] = [JSON.stringify({ id: "first" })];
		for (let i = 0; i < 900; i++) {
			lines.push(JSON.stringify({ id: `pad-${i}`, blob: "a".repeat(600) }));
		}
		lines.push(JSON.stringify({ id: "last" }));
		const filePath = writeJsonl("big.jsonl", lines.join("\n") + "\n");
		const fileSnapshot = snapshot(filePath);
		expect(fileSnapshot.size, "fixture 必须超过 512KiB 才能触发首页快照").toBeGreaterThan(512 * 1024);
		const reader = createTailReader();

		// Act
		const result = readTail(reader, { taskId: "t-tail", filePath, offset: 0, tail: true });

		// Assert: 头部被跳过、尾部读全
		expect(result.truncatedBefore).toBe(true);
		expect(result.entries.length).toBeGreaterThan(0);
		expect(result.entries.some((e: { id: string }) => e.id === "first")).toBe(false);
		expect(result.entries[0].id.startsWith("pad-")).toBe(true);
		expect(result.entries[result.entries.length - 1].id).toBe("last");
		expect(result.nextOffset).toBe(fileSnapshot.size);
		expect(result.hasMore).toBe(false);
	});

	it("should return an empty increment when the file is unchanged", () => {
		// Arrange
		const filePath = writeJsonl("session.jsonl", '{"id":"a"}\n{"id":"b"}\n');
		const fileSnapshot = snapshot(filePath);
		const reader = createTailReader();
		const first = readTail(reader, { taskId: "t3", filePath });
		expect(first.entries.length).toBe(2);
		expect(first.nextOffset).toBe(fileSnapshot.size);

		// Act
		const second = readTail(reader, { taskId: "t3", filePath, offset: first.nextOffset });

		// Assert: 空增量，不重读整文件
		expect(second.entries).toEqual([]);
		expect(second.malformed).toBe(0);
		expect(second.nextOffset).toBe(first.nextOffset);
		expect(second.hasMore).toBe(false);
		expect(second.truncatedBefore).toBe(false);
		expect(second.size).toBe(fileSnapshot.size);
		expect(second.mtime).toBe(fileSnapshot.mtime);
	});

	it("should keep nextOffset unchanged across repeated reads of an unchanged file", () => {
		// Arrange
		const filePath = writeJsonl("session.jsonl", '{"id":"a"}\n{"id":"b"}\n');
		const reader = createTailReader();
		const r1 = readTail(reader, { taskId: "t-stable", filePath });
		expect(r1.nextOffset).toBe(22);

		// Act
		const r2 = readTail(reader, { taskId: "t-stable", filePath, offset: r1.nextOffset });
		const r3 = readTail(reader, { taskId: "t-stable", filePath, offset: r2.nextOffset });

		// Assert
		expect(r2.nextOffset).toBe(r1.nextOffset);
		expect(r3.nextOffset).toBe(r2.nextOffset);
		expect(r3.entries).toEqual([]);
		expect(r3.malformed).toBe(0);
	});

	it("should return only the appended entry when re-reading from the previous nextOffset with tail true", () => {
		// Arrange
		const filePath = writeJsonl("session.jsonl", '{"id":"a"}\n');
		const reader = createTailReader();
		const first = readTail(reader, { taskId: "t4", filePath });
		expect(first.entries.length).toBe(1);
		expect(first.nextOffset).toBe(11);

		// Act: 客户端带上次 nextOffset 追读
		fs.appendFileSync(filePath, '{"id":"b"}\n', "utf-8");
		const second = readTail(reader, { taskId: "t4", filePath, offset: first.nextOffset, tail: true });
		const fileSnapshot = snapshot(filePath);

		// Assert: 只回新增行，nextOffset 单调递增到新文件末尾
		expect(second.entries.length).toBe(1);
		expect(second.entries[0].id).toBe("b");
		expect(second.malformed).toBe(0);
		expect(second.nextOffset).toBe(22);
		expect(second.nextOffset).toBeGreaterThan(first.nextOffset);
		expect(second.hasMore).toBe(false);
		expect(second.truncatedBefore).toBe(false);
		expect(second.size).toBe(fileSnapshot.size);
		expect(second.mtime).toBe(fileSnapshot.mtime);
	});

	it("should hold back a trailing half-line and stitch it into the next read", () => {
		// Arrange: 一条完整行 + 半条（无结尾 '\n'）
		const filePath = writeJsonl("session.jsonl", '{"n":1}\n{"n":2');
		const reader = createTailReader();

		// Act 1
		const first = readTail(reader, { taskId: "t5", filePath, offset: 0 });

		// Act 2: 补上剩余半行及 '\n' 后追读
		fs.appendFileSync(filePath, "}\n", "utf-8");
		const second = readTail(reader, { taskId: "t5", filePath, offset: first.nextOffset, tail: true });

		// Assert 1: 半行不返回、nextOffset 停在完整行 '\n' 之后、有残留 → hasMore
		expect(first.entries).toEqual([{ n: 1 }]);
		expect(first.malformed).toBe(0);
		expect(first.nextOffset).toBe(8);
		expect(first.hasMore).toBe(true);

		// Assert 2: 拼接后第 2 条 entry 正常解析，无坏行
		expect(second.entries).toEqual([{ n: 2 }]);
		expect(second.malformed).toBe(0);
		expect(second.nextOffset).toBe(16);
		expect(second.hasMore).toBe(false);
	});

	it("should deliver each stitched entry exactly once with an exact nextOffset across two reads", () => {
		// Arrange: 第一次读取留下 19 字节半行 residual（不跨行边界返回）
		const filePath = writeJsonl("session.jsonl", '{"seq":1}\n{"seq":2,"txt":"par');
		const reader = createTailReader();

		// Act 1: 只回第一条完整行
		const first = readTail(reader, { taskId: "t5b", filePath, offset: 0 });

		// Act 2: 补齐半行并追加第三条后再读
		fs.appendFileSync(filePath, 'tial"}\n{"seq":3}\n', "utf-8");
		const second = readTail(reader, { taskId: "t5b", filePath, offset: first.nextOffset, tail: true });

		// Act 3: 文件未变再读一次（residual 字节不得被重复消费）
		const third = readTail(reader, { taskId: "t5b", filePath, offset: second.nextOffset, tail: true });
		const fileSnapshot = snapshot(filePath);

		// Assert 1: 半行被扣住，只回第 1 条，偏移停在第一个 '\n' 之后
		expect(first.entries).toEqual([{ seq: 1 }]);
		expect(first.malformed).toBe(0);
		expect(first.nextOffset).toBe(10);
		expect(first.hasMore).toBe(true);

		// Assert 2: 拼接后两条 entry 各解析恰好一次、零坏行、nextOffset 精确到字节
		expect(second.entries).toEqual([{ seq: 2, txt: "partial" }, { seq: 3 }]);
		expect(second.malformed).toBe(0);
		expect(second.nextOffset).toBe(fileSnapshot.size);
		expect(second.hasMore).toBe(false);

		// Assert 3: 第三次读取为空增量，不重复、不产生坏行、偏移不动
		expect(third.entries).toEqual([]);
		expect(third.malformed).toBe(0);
		expect(third.nextOffset).toBe(fileSnapshot.size);

		// Assert 4: 跨读取累计，seq 1/2/3 每条恰好出现一次
		const seqs = [...first.entries, ...second.entries, ...third.entries].map((entry) => entry.seq);
		expect(seqs).toEqual([1, 2, 3]);
	});

	it("should restart from offset 0 when the file shrinks into the held-back half-line", () => {
		// Arrange: 完整行 + 54 字节无换行半行（被读取器扣为 residual）
		const partial = '{"n":2,"pad":"' + "x".repeat(40);
		const filePath = writeJsonl("session.jsonl", '{"n":1}\n' + partial);
		const reader = createTailReader();
		const first = readTail(reader, { taskId: "t5c", filePath, offset: 0 });
		expect(first.entries).toEqual([{ n: 1 }]);
		const cachedOffset = first.nextOffset;
		const cachedSize = fs.statSync(filePath).size;

		// Act: 截断到「offset ≤ size < offset + residual.length」——半行被削短但 offset 仍有效
		const shrinkSize = cachedOffset + 12;
		expect(shrinkSize).toBeLessThan(cachedSize);
		fs.truncateSync(filePath, shrinkSize);
		const second = readTail(reader, { taskId: "t5c", filePath, offset: cachedOffset, tail: true });

		// Assert: 缓存半行已失效 → 丢弃 residual 从 0 重新对齐，重新返回第 1 条
		expect(second.entries).toEqual([{ n: 1 }]);
		expect(second.malformed).toBe(0);
		expect(second.nextOffset).toBe(cachedOffset);
		expect(second.size).toBe(shrinkSize);
		expect(second.hasMore).toBe(true);
	});

	it("should skip the malformed line between two valid lines and count it in malformed", () => {
		// Arrange
		const filePath = writeJsonl("session.jsonl", '{"ok":1}\n{not json\n{"ok":2}\n');
		const fileSnapshot = snapshot(filePath);
		const reader = createTailReader();

		// Act
		const result = readTail(reader, { taskId: "t6", filePath });

		// Assert
		expect(result.entries).toEqual([{ ok: 1 }, { ok: 2 }]);
		expect(result.entries.length).toBe(2);
		expect(result.malformed).toBe(1);
		expect(result.nextOffset).toBe(fileSnapshot.size);
		expect(result.hasMore).toBe(false);
	});

	it("should reset to offset 0 when the file shrinks below the cached offset", () => {
		// Arrange: 较大文件先读到 offset
		const filePath = writeJsonl("session.jsonl", '{"i":0}\n{"i":1}\n{"i":2}\n{"i":3}\n{"i":4}\n');
		const reader = createTailReader();
		const first = readTail(reader, { taskId: "t7", filePath });
		const staleOffset = first.nextOffset;
		expect(first.entries.length).toBe(5);

		// Act: 截短为更小内容（size < offset），带旧 offset 追读
		fs.writeFileSync(filePath, '{"i":0}\n{"i":1}\n', "utf-8");
		const fileSnapshot = snapshot(filePath);
		expect(fileSnapshot.size).toBeLessThan(staleOffset);
		const second = readTail(reader, { taskId: "t7", filePath, offset: staleOffset, tail: true });

		// Assert: 从 0 重新对齐，不因旧 offset 越界报错
		expect(second.entries).toEqual([{ i: 0 }, { i: 1 }]);
		expect(second.malformed).toBe(0);
		expect(second.truncatedBefore).toBe(false);
		expect(second.nextOffset).toBe(fileSnapshot.size);
		expect(second.hasMore).toBe(false);
	});

	it("should reset to offset 0 when the same path is replaced by a new inode", () => {
		// Arrange: 旧文件 3 行，读到 offset（= 旧文件字节数）
		const filePath = writeJsonl("swap.jsonl", '{"gen":"old","i":0}\n{"gen":"old","i":1}\n{"gen":"old","i":2}\n');
		const oldSnapshot = snapshot(filePath);
		const oldIno = fs.statSync(filePath).ino;
		const reader = createTailReader();
		const first = readTail(reader, { taskId: "t8", filePath });
		expect(first.entries.length).toBe(3);
		const staleOffset = first.nextOffset;
		expect(staleOffset).toBe(oldSnapshot.size);

		// Arrange: 原文件仍在时创建新内容文件（两文件同时存活 → ino 必不同），
		// 再原子替换同名路径，等价于「删除后重建同名文件」但 inode 变化确定发生。
		const newContent = [
			'{"gen":"new","i":0}',
			'{"gen":"new","i":1}',
			'{"gen":"new","i":2}',
			'{"gen":"new","i":3}',
			'{"gen":"new","i":4}',
			'{"gen":"new","i":5}',
		].join("\n") + "\n";
		const decoyPath = path.join(tmpDir, "swap.next.jsonl");
		fs.writeFileSync(decoyPath, newContent, "utf-8");
		const decoyIno = fs.statSync(decoyPath).ino;
		expect(decoyIno, "前提自检：同时存活的两个文件 inode 必不同").not.toBe(oldIno);
		fs.renameSync(decoyPath, filePath);
		const newSnapshot = snapshot(filePath);
		expect(fs.statSync(filePath).ino).not.toBe(oldIno);
		// 新文件比旧 offset 大 → 只有 inode 变化能触发重置（size<offset 不成立）
		expect(newSnapshot.size).toBeGreaterThan(staleOffset);

		// Act
		const second = readTail(reader, { taskId: "t8", filePath, offset: staleOffset, tail: true });

		// Assert: 从 0 重置，读到新文件全部 6 条
		expect(second.entries.length).toBe(6);
		expect(second.entries[0]).toEqual({ gen: "new", i: 0 });
		expect(second.malformed).toBe(0);
		expect(second.truncatedBefore).toBe(false);
		expect(second.nextOffset).toBe(newSnapshot.size);
		expect(second.hasMore).toBe(false);
	});

	it("should return an oversize line by itself with oversizeLine true when maxBytes is tiny", () => {
		// Arrange: 单行 63 字节 > maxBytes 10
		const payload = "x".repeat(50);
		const filePath = writeJsonl("long.jsonl", `{"payload":"${payload}"}\n`);
		const fileSnapshot = snapshot(filePath);
		const reader = createTailReader();

		// Act
		const result = readTail(reader, { taskId: "t9", filePath, maxBytes: 10 });

		// Assert: 该行被单独放行且可 parse
		expect(result.entries.length).toBe(1);
		expect(result.entries[0].payload).toBe(payload);
		expect(result.malformed).toBe(0);
		expect(result.oversizeLine).toBe(true);
		expect(result.nextOffset).toBe(fileSnapshot.size);
		expect(result.hasMore).toBe(false);
		expect(result.truncatedBefore).toBe(false);
	});

	it("should drop a line beyond the 8 MiB chase cap, flag oversizeLine and advance nextOffset past it", () => {
		// Arrange: 单行 12 MiB（> 8 MiB 追行上限），行尾有 '\n'；不传 maxBytes（默认 1 MiB 窗口）
		const payload = "x".repeat(12 * 1024 * 1024);
		const filePath = writeJsonl("huge.jsonl", `{"payload":"${payload}"}\n`);
		const fileSnapshot = snapshot(filePath);
		expect(fileSnapshot.size, "前提自检：fixture 单行必须超过 12 MiB").toBeGreaterThan(12 * 1024 * 1024);
		const reader = createTailReader();

		// Act: offset:0 + tail:false，必须在有界时间内返回
		const startedAt = Date.now();
		const result = readTail(reader, { taskId: "t-huge", filePath, offset: 0, tail: false });
		const elapsedMs = Date.now() - startedAt;

		// Assert 1: 超长行被丢弃（不 parse、不计坏行），nextOffset 越过该行
		expect(result.oversizeLine).toBe(true);
		expect(result.entries).toEqual([]);
		expect(result.malformed).toBe(0);
		expect(result.nextOffset).toBe(fileSnapshot.size);
		expect(result.hasMore).toBe(false);
		expect(result.truncatedBefore).toBe(false);
		// 有界：调用必须在预算内返回（无上限实现会持续 concat 追到行尾）
		expect(elapsedMs).toBeLessThan(10_000);

		// Act 2: 按上次 nextOffset 再读
		const again = readTail(reader, {
			taskId: "t-huge",
			filePath,
			offset: result.nextOffset,
			tail: false,
		});

		// Assert 2: 空增量，超长残行不重复返回、不重复标记
		expect(again.entries).toEqual([]);
		expect(again.malformed).toBe(0);
		expect(again.nextOffset).toBe(result.nextOffset);
		expect(again.hasMore).toBe(false);
	}, 20_000);

	it("should discard a partial line that outgrows the cap and flag oversizeLine so the next read does not repeat it", () => {
		// Arrange: 9 MiB 半行（无 '\n'）> 8 MiB 上限
		const partial = `{"payload":"${"y".repeat(9 * 1024 * 1024)}`;
		const filePath = writeJsonl("half.jsonl", partial);
		const fileSnapshot = snapshot(filePath);
		expect(fileSnapshot.size, "前提自检：半行必须超过 8 MiB 上限").toBeGreaterThan(8 * 1024 * 1024);
		const reader = createTailReader();

		// Act 1: 首读遇到超限半行
		const first = readTail(reader, { taskId: "t-half", filePath, offset: 0, tail: false });

		// Assert 1: 残行被丢弃并标记，nextOffset 推进到行末（EOF），residual 不再持有
		expect(first.oversizeLine).toBe(true);
		expect(first.entries).toEqual([]);
		expect(first.malformed).toBe(0);
		expect(first.nextOffset).toBe(fileSnapshot.size);
		expect(first.hasMore).toBe(false);

		// Act 2: 追加一条正常行，按上次 nextOffset 续读
		fs.appendFileSync(filePath, '{"id":"after"}\n', "utf-8");
		const second = readTail(reader, {
			taskId: "t-half",
			filePath,
			offset: first.nextOffset,
			tail: false,
		});
		const grownSnapshot = snapshot(filePath);

		// Assert 2: 只回新行；被丢弃的 9 MiB 残行不重复出现、不拼接成坏行
		expect(second.entries).toEqual([{ id: "after" }]);
		expect(second.malformed).toBe(0);
		expect(second.oversizeLine).toBe(false);
		expect(second.nextOffset).toBe(grownSnapshot.size);
		expect(second.hasMore).toBe(false);
	}, 20_000);

	it("should admit and parse a single line below the chase cap even when it exceeds maxBytes", () => {
		// Arrange: ~100 KiB 单行 < 8 MiB 上限，但 > maxBytes 4096（会触发追行）
		const payload = "z".repeat(100 * 1024);
		const filePath = writeJsonl("mid.jsonl", `{"payload":"${payload}"}\n`);
		const fileSnapshot = snapshot(filePath);
		const reader = createTailReader();

		// Act
		const result = readTail(reader, {
			taskId: "t-mid",
			filePath,
			offset: 0,
			tail: false,
			maxBytes: 4096,
		});

		// Assert: 按语义 8 单独放行并 parse，不是被当作超限行丢弃
		expect(result.entries.length).toBe(1);
		expect(result.entries[0].payload).toBe(payload);
		expect(result.malformed).toBe(0);
		expect(result.oversizeLine).toBe(true);
		expect(result.nextOffset).toBe(fileSnapshot.size);
		expect(result.hasMore).toBe(false);
		expect(result.truncatedBefore).toBe(false);
	});

	it("should keep per-task reads isolated when many task ids share one reader", () => {
		// Arrange: 160 个 taskId（> 2×64 的候选 LRU 上界），每个 task 一个独立文件
		const taskCount = 160;
		const filePaths: string[] = [];
		for (let i = 0; i < taskCount; i++) {
			filePaths.push(
				writeJsonl(`task-${i}.jsonl`, JSON.stringify({ task: i, seq: 0 }) + "\n"),
			);
		}
		const reader = createTailReader();
		const offsets: number[] = [];

		// Act 1: 逐个首读，写满状态表（超过 64 上界会淘汰早期条目）
		for (let i = 0; i < taskCount; i++) {
			const first = readTail(reader, {
				taskId: `task-${i}`,
				filePath: filePaths[i],
				offset: 0,
			});
			expect(first.entries, `task-${i} 首读`).toEqual([{ task: i, seq: 0 }]);
			expect(first.malformed, `task-${i} 首读 malformed`).toBe(0);
			offsets.push(first.nextOffset);
		}

		// Act 2: 每个 task 追加一行后按上次 nextOffset 续读
		for (let i = 0; i < taskCount; i++) {
			fs.appendFileSync(filePaths[i], JSON.stringify({ task: i, seq: 1 }) + "\n", "utf-8");
			const second = readTail(reader, {
				taskId: `task-${i}`,
				filePath: filePaths[i],
				offset: offsets[i],
			});
			expect(second.entries, `task-${i} 追读`).toEqual([{ task: i, seq: 1 }]);
			expect(second.malformed, `task-${i} 追读 malformed`).toBe(0);
			offsets[i] = second.nextOffset;
		}

		// Act 3: 回访最早的一批 task（LRU 淘汰后重读也绝不能串到别的 task）
		for (let i = 0; i < 16; i++) {
			const third = readTail(reader, {
				taskId: `task-${i}`,
				filePath: filePaths[i],
				offset: offsets[i],
			});
			expect(third.entries, `task-${i} 回访`).toEqual([]);
			expect(third.malformed, `task-${i} 回访 malformed`).toBe(0);
			expect(third.nextOffset, `task-${i} 回访 nextOffset`).toBe(offsets[i]);
		}

		// Act 4: 从 0 重读 task-0 自己的文件 → 只含 task-0 的两行（无外来 entry）
		const reread = readTail(reader, { taskId: "task-0", filePath: filePaths[0], offset: 0 });

		// Assert
		expect(reread.entries).toEqual([
			{ task: 0, seq: 0 },
			{ task: 0, seq: 1 },
		]);
		expect(reread.malformed).toBe(0);
		expect(reread.nextOffset).toBe(offsets[0]);
	}, 30_000);

	it("should keep the per-task state table bounded at 64 when one reader reads 160 different task ids", () => {
		// Arrange: 160 个 taskId（> LRU 上限 64），每个 task 一个独立临时文件
		const taskCount = 160;
		const filePaths: string[] = [];
		for (let i = 0; i < taskCount; i++) {
			filePaths.push(writeJsonl(`lru-${i}.jsonl`, JSON.stringify({ task: i }) + "\n"));
		}
		const reader = createTailReader();

		// Act: 同一个 reader 依次读取全部 160 个不同 taskId
		for (let i = 0; i < taskCount; i++) {
			const result = readTail(reader, { taskId: `lru-${i}`, filePath: filePaths[i], offset: 0 });
			expect(result.entries, `lru-${i} 首读`).toEqual([{ task: i }]);
			expect(result.malformed, `lru-${i} 首读 malformed`).toBe(0);
		}

		// Assert: 状态表有界 —— LRU 上限 64 生效，绝不随 taskId 数量增长
		expect(reader.stateCount()).toBe(64);
	});

	it("should drop an over-limit residual and resume with only the appended line when maxBytes exceeds the residual", () => {
		// Arrange: `{"a":1}\n`（8 字节）+ 9 MiB 无换行半行
		const partial = `{"payload":"${"y".repeat(9 * 1024 * 1024)}`;
		const filePath = writeJsonl("residual-oversize.jsonl", '{"a":1}\n' + partial);
		const fileSnapshot = snapshot(filePath);
		expect(fileSnapshot.size, "前提自检：首行 + 9 MiB 半行必须超过 8 MiB 上限").toBeGreaterThan(8 * 1024 * 1024);
		const reader = createTailReader();

		// Act 1: maxBytes 16 MiB > 9 MiB 半行 → 窗口一次读满，走 residual 超限分支
		const first = readTail(reader, {
			taskId: "t-residual",
			filePath,
			offset: 0,
			maxBytes: 16 * 1024 * 1024,
		});

		// Assert 1: 残行被丢弃并前移 —— oversizeLine true、nextOffset 推到文件大小
		expect(first.oversizeLine).toBe(true);
		expect(first.nextOffset).toBe(fileSnapshot.size);
		expect(first.entries).toEqual([{ a: 1 }]);
		expect(first.malformed).toBe(0);
		expect(first.hasMore).toBe(false);

		// Act 2: 文件尾追加一条正常行，按上次 nextOffset 续读
		fs.appendFileSync(filePath, '{"b":2}\n', "utf-8");
		const second = readTail(reader, {
			taskId: "t-residual",
			filePath,
			offset: first.nextOffset,
			maxBytes: 16 * 1024 * 1024,
		});
		const grownSnapshot = snapshot(filePath);

		// Assert 2: 只返回新增行；被丢弃的残行不重复出现、不拼成坏行
		expect(second.entries).toEqual([{ b: 2 }]);
		expect(second.oversizeLine).toBe(false);
		expect(second.malformed).toBe(0);
		expect(second.nextOffset).toBe(grownSnapshot.size);
		expect(second.hasMore).toBe(false);
	}, 20_000);
});

// ---------------------------------------------------------------------------
// 追加：图片懒加载需要的行偏移契约 —— lineStarts / entryOffsets
//（ParseChunkResult.lineStarts 与 TailResult.entryOffsets 为本轮新增字段）
// ---------------------------------------------------------------------------

describe("parseChunk — lineStarts 与 entries 一一对应", () => {
	it("should return lineStarts one-to-one with entries pointing at each line's first byte", () => {
		// Arrange: 两行已知长度的紧凑 JSON（第二行从索引 8 起）
		const buf = Buffer.from('{"a":1}\n{"b":2}\n', "utf-8");

		// Act
		const result = parseChunk(buf);

		// Assert: 精确断言各行首字节索引
		expect(result.entries).toEqual([{ a: 1 }, { b: 2 }]);
		expect(result.lineStarts).toEqual([0, 8]);
		expect(result.lineStarts).toHaveLength(result.entries.length);
	});

	it("should skip malformed lines in lineStarts so it stays aligned with entries", () => {
		// Arrange: 第一行是坏 JSON（`{bad json` 9 字节占下标 0-8，'\n' 在下标 9），
		// 第二行合法行首在下标 10
		const buf = Buffer.from('{bad json\n{"a":1}\n', "utf-8");

		// Act
		const result = parseChunk(buf);

		// Assert: 坏行不产生 entry，也不占 lineStarts 槽位（第二行行首 = 10）
		expect(result.entries).toEqual([{ a: 1 }]);
		expect(result.lineStarts).toEqual([10]);
		expect(result.lineStarts).toHaveLength(result.entries.length);
	});

	it("should not record the trailing partial line in lineStarts", () => {
		// Arrange: 第二行是未完结的半行（不解析、不消费）
		const buf = Buffer.from('{"a":1}\n{"b":', "utf-8");

		// Act
		const result = parseChunk(buf);

		// Assert: 只有已解析的第一行有起点
		expect(result.entries).toEqual([{ a: 1 }]);
		expect(result.lineStarts).toEqual([0]);
		expect(result.lineStarts).toHaveLength(result.entries.length);
	});
});

describe("createTailReader().read — entryOffsets 绝对文件字节偏移", () => {
	/** 按绝对偏移从原文里切出该行并 parse（验证 entryOffsets 指向真实行首）。 */
	function lineAtOffset(content: string, offset: number): any {
		const end = content.indexOf("\n", offset);

		return JSON.parse(content.slice(offset, end === -1 ? content.length : end));
	}

	it("should return absolute line offsets aligned with entries on the first read from offset 0", () => {
		// Arrange: 三行等长紧凑 JSON（行首 0 / 8 / 16）
		const filePath = writeJsonl("entry-offsets.jsonl", '{"n":1}\n{"n":2}\n{"n":3}\n');
		const reader = createTailReader();

		// Act
		const result = readTail(reader, { taskId: "t-eo1", filePath, offset: 0 });
		const content = fs.readFileSync(filePath, "utf-8");

		// Assert: 精确偏移 + 与 entries 等长 + 逐个回到真实文件行
		expect(result.entries).toEqual([{ n: 1 }, { n: 2 }, { n: 3 }]);
		expect(result.entryOffsets).toEqual([0, 8, 16]);
		expect(result.entryOffsets).toHaveLength(result.entries.length);
		result.entryOffsets.forEach((offset, index) => {
			expect(lineAtOffset(content, offset)).toEqual(result.entries[index]);
		});
	});

	it("should return the absolute offset of each appended line on an incremental read", () => {
		// Arrange: 首读一行，再追加两行
		const filePath = writeJsonl("entry-offsets-inc.jsonl", '{"n":1}\n');
		const reader = createTailReader();
		const first = readTail(reader, { taskId: "t-eo2", filePath, offset: 0 });
		expect(first.entryOffsets).toEqual([0]);

		fs.appendFileSync(filePath, '{"n":2}\n{"n":3}\n', "utf-8");

		// Act: 带上次 nextOffset 追读
		const second = readTail(reader, { taskId: "t-eo2", filePath, offset: first.nextOffset });
		const content = fs.readFileSync(filePath, "utf-8");

		// Assert: 新增行的绝对偏移（8 / 16）且指向真实行首
		expect(second.entries).toEqual([{ n: 2 }, { n: 3 }]);
		expect(second.entryOffsets).toEqual([8, 16]);
		expect(second.entryOffsets).toHaveLength(second.entries.length);
		second.entryOffsets.forEach((offset, index) => {
			expect(offset).toBeGreaterThanOrEqual(first.nextOffset);
			expect(lineAtOffset(content, offset)).toEqual(second.entries[index]);
		});
	});

	it("should return absolute offsets for the entries found in the first-read tail window", () => {
		// Arrange: >512KiB 的文件，头部一条 "first"、尾部一条 "last"，中间全是 padding
		const lines: string[] = [JSON.stringify({ id: "first" })];
		for (let i = 0; i < 900; i++) {
			lines.push(JSON.stringify({ id: `pad-${i}`, blob: "a".repeat(600) }));
		}
		lines.push(JSON.stringify({ id: "last" }));
		const filePath = writeJsonl("entry-offsets-tail.jsonl", lines.join("\n") + "\n");
		const fileSnapshot = snapshot(filePath);
		expect(fileSnapshot.size, "前提自检：fixture 必须超过 512KiB 才能触发首页快照").toBeGreaterThan(512 * 1024);
		const reader = createTailReader();

		// Act
		const result = readTail(reader, { taskId: "t-eo3", filePath, offset: 0, tail: true });
		const content = fs.readFileSync(filePath, "utf-8");

		// Assert: 与 entries 等长；首条起点 > 0（头部被截断）且等于该行在文件中的真实位置
		expect(result.truncatedBefore).toBe(true);
		expect(result.entryOffsets).toHaveLength(result.entries.length);
		expect(result.entryOffsets[0]).toBeGreaterThan(0);
		const firstLineText = JSON.stringify(result.entries[0]);
		expect(result.entryOffsets[0]).toBe(content.indexOf(firstLineText));
		result.entryOffsets.forEach((offset, index) => {
			expect(lineAtOffset(content, offset)).toEqual(result.entries[index]);
		});
	});

	it("should return the absolute offset of a residual-stitched line across two reads", () => {
		// Arrange: 第一条完整行 + 未完结半行（`{"b":` 无结尾 '\n'，首读被扣为 residual）
		const filePath = writeJsonl("entry-offsets-residual.jsonl", '{"a":1}\n{"b":');
		const reader = createTailReader();

		// Act 1: 首读只回完整行，半行残留在 reader 内
		const first = readTail(reader, { taskId: "t-eo4", filePath, offset: 0 });

		// Act 2: 追加补全半行及 '\n' 后按上次 nextOffset 再读（走 residual 拼接路径）
		fs.appendFileSync(filePath, '2}\n', "utf-8");
		const second = readTail(reader, { taskId: "t-eo4", filePath, offset: first.nextOffset });
		const content = fs.readFileSync(filePath, "utf-8");

		// Assert 1: 首读只回完整行
		expect(first.entries).toEqual([{ a: 1 }]);
		expect(first.entryOffsets).toEqual([0]);

		// Assert 2: 拼接行的 entryOffsets[0] = 该行首字节绝对偏移（8），且与 entries 等长；
		// 用 fs.readFileSync 在文件内容里 indexOf(该行文本) 交叉验证
		expect(second.entries).toEqual([{ b: 2 }]);
		expect(second.entryOffsets).toHaveLength(second.entries.length);
		const stitchedLine = JSON.stringify(second.entries[0]);
		expect(second.entryOffsets[0]).toBe(content.indexOf(stitchedLine));
		expect(second.entryOffsets[0]).toBe(8);

		// Assert 3: 用该偏移切行 + parseChunk 能取回同一 entry（与 lineAtOffset 同源的判据）
		expect(lineAtOffset(content, second.entryOffsets[0])).toEqual(second.entries[0]);
		const slice = Buffer.from(content.slice(second.entryOffsets[0]), "utf-8");
		expect(parseChunk(slice).entries).toEqual(second.entries);
	});
});

// ---------------------------------------------------------------------------
// 追加：readBefore —— 客户端自动向前补齐（替代旧的 Load earlier / MAX_ENTRIES 截断）
// ---------------------------------------------------------------------------

/** readBefore 非 null 断言 + 解包（文件缺失等失败在用例内单独断言）。 */
function readBeforeOrThrow(filePath: string, before: number, maxBytes?: number): TailBeforeResult {
	const result = readBefore(filePath, before, maxBytes);
	expect(result, `readBefore(${before}) 应返回结果而非 null`).not.toBeNull();

	return result as TailBeforeResult;
}

/** 逐片校验单次 readBefore 窗口自身的内部一致性。 */
function expectChunkConsistent(chunk: TailBeforeResult, before: number): void {
	expect(chunk.entries.length, "entries 与 entryOffsets 等长").toBe(chunk.entryOffsets.length);
	if (chunk.entries.length > 0) {
		expect(chunk.entryOffsets[0], "startOffset 即首条 entry 的绝对偏移").toBe(chunk.startOffset);
		for (let i = 0; i < chunk.entryOffsets.length; i++) {
			expect(chunk.entryOffsets[i], "entryOffsets 严格升序").toBeGreaterThan(i === 0 ? -1 : chunk.entryOffsets[i - 1]);
			expect(chunk.entryOffsets[i], "窗口内 entry 绝不越过 before").toBeLessThan(before);
		}
	}
	expect(typeof chunk.oversizeLine, "oversizeLine 字段存在且为布尔").toBe("boolean");
}

describe("readBefore — 反向字节窗口回读契约", () => {
	it("should return every entry in ascending order with startOffset 0 when before equals the file size", () => {
		// Arrange: 5 行不等长 JSONL
		const lines = [
			JSON.stringify({ id: "L0" }),
			JSON.stringify({ id: "L1", pad: "aaaa" }),
			JSON.stringify({ id: "L2", pad: "b".repeat(40) }),
			JSON.stringify({ id: "L3" }),
			JSON.stringify({ id: "L4", pad: "cccccccc" }),
		];
		const filePath = writeJsonl("back-full.jsonl", lines.join("\n") + "\n");
		const fileSnapshot = snapshot(filePath);
		const expected = lines.map((line) => JSON.parse(line));

		// Act
		const result = readBeforeOrThrow(filePath, fileSnapshot.size);

		// Assert: 全量升序 + 起点 0 + 字段齐备
		expect(result.entries).toEqual(expected);
		expect(result.malformed).toBe(0);
		expect(result.startOffset).toBe(0);
		expect(result.entryOffsets[0]).toBe(0);
		expect(result.entryOffsets).toEqual([0, ...lines.slice(0, -1).map((line, i) =>
			lines.slice(0, i + 1).reduce((acc, l) => acc + Buffer.byteLength(l) + 1, 0),
		)]);
		expect(result.size).toBe(fileSnapshot.size);
		expect(result.mtime).toBe(fileSnapshot.mtime);
		expectChunkConsistent(result, fileSnapshot.size);
	});

	it("should stitch chunked backward reads back into the exact forward sequence without loss or duplication", () => {
		// Arrange: 30 行不等长 fixture
		const lines: string[] = [];
		for (let i = 0; i < 30; i++) {
			lines.push(JSON.stringify({ seq: i, text: `line-${i}-${"p".repeat(i * 3)}` }));
		}
		const content = lines.join("\n") + "\n";
		const filePath = writeJsonl("back-loop.jsonl", content);
		const fileSnapshot = snapshot(filePath);
		// 参照序列手工解析（不依赖 parseChunk —— 其 maxBytes 是读预算，
		// 预算耗尽会 break，不能充当 readBefore「窗口内全部完整行」的参照）
		const reference = content.split("\n").filter((l) => l !== "").map((l) => JSON.parse(l));
		expect(reference).toHaveLength(30);

		// Act: 从 before=size 起循环 before = startOffset 直到 0；
		// 显式 maxBytes 256 强制多分片（默认 1 MiB 窗口对 1.5 KB 小文件
		// 天然只需 1 片，"多次迭代"只在小窗口下才有意义）
		const fragments: any[][] = [];
		let before = fileSnapshot.size;
		let iterations = 0;
		while (before > 0) {
			const chunk = readBeforeOrThrow(filePath, before, 256);
			expectChunkConsistent(chunk, before);
			fragments.unshift(chunk.entries);
			expect(chunk.startOffset, "每片都必须严格向前推进（不重不漏的前提）").toBeLessThan(before);
			before = chunk.startOffset;
			iterations++;
			expect(iterations, "回溯循环必须有界终止").toBeLessThan(100);
		}
		const collected = fragments.flat();

		// Assert: 拼接序列与正向全量逐条相等（顺序一致、无重复、无丢失）
		expect(collected).toEqual(reference);
		expect(iterations).toBeGreaterThan(1);
	});

	it("should return only the complete lines strictly before a line-start boundary", () => {
		// Arrange: 4 行，已知各行绝对字节偏移
		const lines = [
			JSON.stringify({ id: "L0" }),
			JSON.stringify({ id: "L1", pad: "aaaa" }),
			JSON.stringify({ id: "L2", pad: "bbbbbbbb" }),
			JSON.stringify({ id: "L3" }),
		];
		const content = lines.join("\n") + "\n";
		const filePath = writeJsonl("back-boundary.jsonl", content);
		const offsets: number[] = [];
		let acc = 0;
		for (const line of lines) {
			offsets.push(acc);
			acc += Buffer.byteLength(line) + 1;
		}

		// Act: before = 第 3 行的行首偏移（落在行边界上）
		const result = readBeforeOrThrow(filePath, offsets[2]);

		// Assert: 恰好返回边界前的完整行，无重叠
		expect(result.entries).toEqual([JSON.parse(lines[0]), JSON.parse(lines[1])]);
		expect(result.startOffset).toBe(0);
		expect(result.entryOffsets).toEqual([offsets[0], offsets[1]]);
		expect(result.entryOffsets[0]).toBe(result.startOffset);
		// 每条 entry 的整行都终止于 before 之前（窗口不越界、不重叠）
		result.entryOffsets.forEach((offset, index) => {
			const lineEnd = content.indexOf("\n", offset);
			expect(lineEnd).toBeGreaterThanOrEqual(offset);
			expect(lineEnd).toBeLessThanOrEqual(offsets[2]);
			expect(index).toBeLessThan(result.entries.length);
		});
	});

	it("should drop the line straddling before and keep only the complete lines before it", () => {
		// Arrange: before 落在第 2 行（L1）的行中间
		const lines = [
			JSON.stringify({ id: "L0" }),
			JSON.stringify({ id: "L1", pad: "a".repeat(64) }),
			JSON.stringify({ id: "L2" }),
		];
		const content = lines.join("\n") + "\n";
		const filePath = writeJsonl("back-midline.jsonl", content);
		const l1Start = Buffer.byteLength(lines[0]) + 1;
		const before = l1Start + 3;
		expect(before).toBeLessThan(Buffer.byteLength(content));

		// Act
		const result = readBeforeOrThrow(filePath, before);

		// Assert: 跨越 before 的 L1 被丢弃，只回其前的完整行
		expect(result.entries).toEqual([JSON.parse(lines[0])]);
		expect(result.startOffset).toBe(0);
		expect(result.entryOffsets).toEqual([0]);
		expect(result.entryOffsets[0]).toBeLessThan(before);
		expect(result.malformed).toBe(0);
	});

	it("should clamp before above the file size down to size", () => {
		// Arrange
		const content = '{"n":1}\n{"n":2}\n{"n":3}\n';
		const filePath = writeJsonl("back-clamp.jsonl", content);
		const fileSnapshot = snapshot(filePath);

		// Act
		const result = readBeforeOrThrow(filePath, fileSnapshot.size + 4096);

		// Assert: 与 before === size 等价
		expect(result.entries).toEqual([{ n: 1 }, { n: 2 }, { n: 3 }]);
		expect(result.startOffset).toBe(0);
		expect(result.entryOffsets).toEqual([0, 8, 16]);
		expect(result.size).toBe(fileSnapshot.size);
	});

	it("should return an empty window when before is 0", () => {
		// Arrange
		const filePath = writeJsonl("back-zero.jsonl", '{"n":1}\n{"n":2}\n');

		// Act
		const result = readBeforeOrThrow(filePath, 0);

		// Assert
		expect(result.entries).toEqual([]);
		expect(result.entryOffsets).toEqual([]);
		expect(result.startOffset).toBe(0);
		expect(result.malformed).toBe(0);
	});

	it("should return an empty window for an empty file", () => {
		// Arrange: 0 字节文件
		const filePath = writeJsonl("back-empty.jsonl", "");

		// Act
		const result = readBeforeOrThrow(filePath, 123);

		// Assert
		expect(result.entries).toEqual([]);
		expect(result.startOffset).toBe(0);
		expect(result.size).toBe(0);
	});

	it("should retrieve a single line larger than the default window completely across backward chunks", () => {
		// Arrange: 1.5 MiB 单行 JSON 夹在多行之间（> 默认 1 MiB 窗口，< 8 MiB 扩展上限）
		const hugePayload = "x".repeat(Math.round(1.5 * 1024 * 1024));
		const lines = [
			JSON.stringify({ id: "head-1" }),
			JSON.stringify({ id: "head-2", pad: "a".repeat(64) }),
			JSON.stringify({ id: "huge", payload: hugePayload }),
			JSON.stringify({ id: "tail-1" }),
			JSON.stringify({ id: "tail-2" }),
		];
		const content = lines.join("\n") + "\n";
		const filePath = writeJsonl("back-huge.jsonl", content);
		const fileSnapshot = snapshot(filePath);
		expect(fileSnapshot.size, "前提自检：fixture 必须超过默认 1 MiB 窗口").toBeGreaterThan(1024 * 1024);
		const hugeOffset = content.indexOf(lines[2]);
		// 参照序列手工解析（不依赖 parseChunk 的读预算行为：1.5 MiB 单行会
		// 耗尽其默认 1 MiB 预算导致后续行被截断，不能当全量参照）
		const reference = content.split("\n").filter((l) => l !== "").map((l) => JSON.parse(l));
		expect(reference).toHaveLength(5);

		// Act 1: 首片窗口落在超长行内部，必须向前扩展把整行完整取回
		const first = readBeforeOrThrow(filePath, fileSnapshot.size);
		const hugeEntries = first.entries.filter((entry: any) => entry.id === "huge");

		// Assert 1: 超长行完整返回（JSON 可解析、内容与写入一致）且偏移正确
		expect(hugeEntries).toHaveLength(1);
		expect(hugeEntries[0].payload).toBe(hugePayload);
		expect(first.entryOffsets).toContain(hugeOffset);
		const atHuge = first.entryOffsets.indexOf(hugeOffset);
		expect(first.entries[atHuge]).toEqual(JSON.parse(lines[2]));
		// 收紧：1.5 MiB 单行明确超过默认 1 MiB 窗口 → oversizeLine 具体为 true
		expect(first.oversizeLine).toBe(true);

		// Act 2: 从 size 起循环回溯到 0
		const fragments: any[][] = [];
		let before = fileSnapshot.size;
		let iterations = 0;
		while (before > 0) {
			const chunk = readBeforeOrThrow(filePath, before);
			expectChunkConsistent(chunk, before);
			fragments.unshift(chunk.entries);
			expect(chunk.startOffset, "回溯必须严格向前推进").toBeLessThan(before);
			before = chunk.startOffset;
			iterations++;
			expect(iterations, "回溯循环必须有界终止").toBeLessThan(100);
		}
		const collected = fragments.flat();

		// Assert 2: 循环仍能到达 0，拼接后逐条等于正向全量，超长行恰好出现一次
		expect(before).toBe(0);
		expect(collected).toEqual(reference);
		expect(collected.filter((entry: any) => entry.id === "huge")).toHaveLength(1);
	}, 30_000);

	it("should return a bounded nonzero cursor when the backward chase cap is exhausted inside one giant line", () => {
		// Arrange: 文件只有一条 >9 MiB、无换行的单行（末尾无 '\n'）。回溯扩展的
		// 上限是 CHASE_MAX_BYTES 8 MiB，从名义窗口起点（size − 1 MiB）最多再向后
		// 退 8 MiB，因此行长 > 9 MiB 才会真正耗尽扩展上限、无法取回任何完整行。
		const payload = "x".repeat(Math.round(9.5 * 1024 * 1024));
		const line = JSON.stringify({ payload });
		const filePath = writeJsonl("back-chase-cap.jsonl", line);
		const fileSnapshot = snapshot(filePath);
		expect(fileSnapshot.size, "前提自检：单行必须超过 1 MiB 窗口 + 8 MiB 扩展上限").toBeGreaterThan(
			9 * 1024 * 1024,
		);

		// Act
		const result = readBeforeOrThrow(filePath, fileSnapshot.size);

		// Assert: 无完整行可回；但游标必须有界推进（0 < startOffset < size），
		// 客户端据此继续回读且不会在同一 before 上死循环
		expect(result.entries).toEqual([]);
		expect(result.entryOffsets).toEqual([]);
		expect(result.oversizeLine).toBe(true);
		expect(result.startOffset, "游标必须非零").toBeGreaterThan(0);
		expect(result.startOffset, "游标必须小于文件大小（严格前进）").toBeLessThan(fileSnapshot.size);
	}, 30_000);

	it("should advance backward past a jumbo line that ends exactly at the cursor instead of stalling", () => {
		// Arrange: 3 行 —— 小行 / >9 MiB 巨型行（带结尾换行）/ 小行，before 取第 3 行
		// 行首。名义窗口（1 MiB）与追赶上限（8 MiB）全部落在巨型行内部，追不到
		// 该行行首；而窗口末字节恰是巨型行的结尾换行。旧实现的「裁剪头部半行」
		// 逻辑因此命中这条位于 buf.length - 1 的换行，subarray 后得到空 buffer、
		// base 被推到 before，startOffset 回退成 before —— 零进度。
		const lines = [
			JSON.stringify({ id: "head-1" }),
			JSON.stringify({ id: "huge", payload: "x".repeat(12 * 1024 * 1024) }),
			JSON.stringify({ id: "tail-1" }),
		];
		const content = lines.join("\n") + "\n";
		const filePath = writeJsonl("back-jumbo-line-end.jsonl", content);
		const before = Buffer.byteLength(lines[0]) + 1 + Buffer.byteLength(lines[1]) + 1;
		expect(Buffer.byteLength(lines[1]), "前提自检：中间行必须超过 1MiB 窗口 + 8MiB 追赶上限").toBeGreaterThan(
			9 * 1024 * 1024,
		);
		expect(before, "before 必须恰为第 3 行行首").toBe(content.indexOf(lines[2]));

		// Act 1: 窗口起点落在巨型行内部，追不到行首 → 本次窗口无完整行可回
		const first = readBeforeOrThrow(filePath, before);

		// Assert 1: 无 entry，但游标必须有界且严格向前（旧实现返回 startOffset === before，
		// 客户端 page.ts:1786 的 `next >= before` 守卫会因此永久停止回填）
		expect(first.entries).toEqual([]);
		expect(first.entryOffsets).toEqual([]);
		expect(first.startOffset, "游标必须非零").toBeGreaterThan(0);
		expect(
			first.startOffset,
			"游标必须严格小于 before：旧实现会把 startOffset 跑成 before，导致客户端 page.ts:1786 永久停止回填",
		).toBeLessThan(before);
		expect(first.oversizeLine, "响应不得伪装成 EOF").toBe(true);

		// Act 2: 从 before 起循环回溯到 0
		const collected: any[][] = [];
		let cursor = before;
		let iterations = 0;
		while (cursor > 0) {
			const chunk = readBeforeOrThrow(filePath, cursor);
			expectChunkConsistent(chunk, cursor);
			expect(chunk.startOffset, "每片都必须严格向前推进（否则回溯死循环）").toBeLessThan(cursor);
			collected.unshift(chunk.entries);
			cursor = chunk.startOffset;
			iterations++;
			expect(iterations, "回溯循环必须有界终止").toBeLessThan(100);
		}

		// Assert 2: 循环必须到达 0；巨型行沿用现有丢弃策略（不在本次范围），
		// 但其前面的第 1 行小行必须被收集到
		expect(cursor).toBe(0);
		expect(iterations, "巨型行只需少量大步回退，不应退化成逐字节爬行").toBeLessThanOrEqual(3);
		expect(collected.flat()).toEqual([JSON.parse(lines[0])]);
		expect(
			collected.flat().some((entry: any) => entry.id === "huge"),
			"巨型行不得被回填进 entries",
		).toBe(false);
	}, 30_000);

	it("should return a >9 MiB line whole when the caller widens maxBytes to 32 MiB", () => {
		// Arrange: 3 行 —— 小行 / >9 MiB 巨型行 / 小行，before 取第 3 行行首。
		// 默认 1 MiB 名义窗口 + 8 MiB 追赶上限追不到 10 MiB 行的行首（上一条用例）；
		// 调用方把 maxBytes 放宽到 32 MiB 后，窗口一次覆盖全文件，整行必须被完整取回。
		const lines = [
			JSON.stringify({ id: "head-1" }),
			JSON.stringify({ id: "huge", payload: "x".repeat(10 * 1024 * 1024) }),
			JSON.stringify({ id: "tail-1" }),
		];
		const content = lines.join("\n") + "\n";
		const filePath = writeJsonl("back-wide-window.jsonl", content);
		expect(Buffer.byteLength(lines[1]), "前提自检：中间行必须超过默认窗口 + 追赶上限").toBeGreaterThan(
			9 * 1024 * 1024,
		);
		const before = content.indexOf(lines[2]);
		expect(before, "before 必须恰为第 3 行行首").toBeGreaterThan(0);

		// Act: 宽窗口（32 MiB）一次读回 before 之前的全部完整行
		const result = readBeforeOrThrow(filePath, before, 32 * 1024 * 1024);

		// Assert: 两行都拿到，巨型行整行完整，无超限/坏行标记
		expect(result.entries.length).toBe(2);
		expect(result.entryOffsets).toEqual([0, Buffer.byteLength(lines[0]) + 1]);
		expect(result.startOffset).toBe(0);
		expect(result.entries[1].id).toBe("huge");
		expect(result.entries[1].payload.length).toBe(10 * 1024 * 1024);
		expect(result.oversizeLine).toBe(false);
		expect(result.malformed).toBe(0);
	}, 30_000);

	it("should skip malformed lines and count them in malformed", () => {
		// Arrange: 坏行夹在两条合法行之间
		const filePath = writeJsonl("back-malformed.jsonl", '{"ok":1}\n{not json\n{"ok":2}\n');
		const fileSnapshot = snapshot(filePath);

		// Act
		const result = readBeforeOrThrow(filePath, fileSnapshot.size);

		// Assert
		expect(result.entries).toEqual([{ ok: 1 }, { ok: 2 }]);
		expect(result.malformed).toBe(1);
		expect(result.startOffset).toBe(0);
	});

	it("should return null when the file does not exist", () => {
		// Arrange
		const missingPath = path.join(tmpDir, "missing-back.jsonl");

		// Act
		const result = readBefore(missingPath, 100);

		// Assert
		expect(result).toBeNull();
	});

	it("should keep the forward per-task cache intact when readBefore runs between two reads", () => {
		// Arrange: 前向首读建立 per-taskId 状态
		const filePath = writeJsonl("back-coexist.jsonl", '{"n":1}\n{"n":2}\n{"n":3}\n');
		const reader = createTailReader();
		const first = readTail(reader, { taskId: "t-back", filePath, offset: 0, tail: true });
		expect(first.entries).toEqual([{ n: 1 }, { n: 2 }, { n: 3 }]);
		expect(reader.stateCount()).toBe(1);

		// Act: 中途插入一次无状态的 readBefore
		const back = readBeforeOrThrow(filePath, snapshot(filePath).size);
		expect(back.entries).toEqual([{ n: 1 }, { n: 2 }, { n: 3 }]);
		expect(reader.stateCount(), "readBefore 不得向前向缓存写入任何状态").toBe(1);

		// Assert: 前向缓存未被破坏 —— 空增量照旧
		const second = readTail(reader, { taskId: "t-back", filePath, offset: first.nextOffset, tail: true });
		expect(second.entries).toEqual([]);
		expect(second.malformed).toBe(0);
		expect(second.nextOffset).toBe(first.nextOffset);
		expect(reader.stateCount()).toBe(1);

		// Assert: 追加后续读仍只回新增行（既有行为不变）
		fs.appendFileSync(filePath, '{"n":4}\n', "utf-8");
		const third = readTail(reader, { taskId: "t-back", filePath, offset: second.nextOffset, tail: true });
		expect(third.entries).toEqual([{ n: 4 }]);
		expect(third.malformed).toBe(0);
		expect(reader.stateCount()).toBe(1);
	});
});
