/**
 * 红阶段测试：`src/web/children.ts` —— 派发时写入的 sidecar 指针文件
 * `<sessionDir>/children.jsonl` 的写入与解析（替代旧的内容匹配推断在飞父子链接）。
 * 模块尚不存在，本文件整体红属预期。
 *
 * 被测接口（固定签名，实现者照此实现）：
 *   CHILDREN_FILE_NAME = "children.jsonl"
 *   MAX_CHILD_POINTER_LINE_BYTES = 1024 * 1024
 *   MAX_CHILD_POINTER_FILE_BYTES = 8 * 1024 * 1024
 *   ChildPointer = { childTaskId, agent, task, startedAt, depth }
 *   appendChildPointer(sessionDir, record): void
 *     —— 追加一行 JSON.stringify(record) + "\n" 到 <sessionDir>/children.jsonl；
 *        任何异常吞掉、永不抛出（best-effort，写指针失败不得影响派发主流程）。
 *   readChildPointers(sessionDir): ChildPointer[]
 *     —— 文件缺失/不可读 → []；逐行解析，跳过空行/坏 JSON/字段类型不合法
 *        （childTaskId 非 UUID 字符串、agent/task 非字符串、startedAt/depth
 *        非有限数字）的行；单行字节长度 > MAX_CHILD_POINTER_LINE_BYTES 的行跳过；
 *        整文件字节长度 > MAX_CHILD_POINTER_FILE_BYTES 时只保留文件开头窗口内
 *        完整行解析出的记录（超限之后的行不再返回）；
 *        同一 childTaskId 多次出现 → last wins（字段取最后一次，条目只保留一次）。
 *
 * 用例覆盖：
 *   1. 正常解析：两条合法行 → 2 条，字段逐一相等
 *   2. 文件缺失 → []
 *   3. 坏行容错：空行/非 JSON/缺字段/字段类型错误夹在合法行之间 → 只返回合法记录
 *   4. 重复 childTaskId → 只返回 1 条，字段取最后一次
 *   5. 单行超 MAX_CHILD_POINTER_LINE_BYTES → 跳过该行
 *   5b. 整文件超 MAX_CHILD_POINTER_FILE_BYTES → 只保留文件开头的合法记录，
 *       超限之后的合法行不得被捞回
 *   5c. 常量钉死：MAX_CHILD_POINTER_FILE_BYTES === 8 * 1024 * 1024
 *   6. appendChildPointer 写入格式（一行、两行的精确字节往返）
 *   7. appendChildPointer 失败不抛（ENOTDIR / ENOENT）
 *
 * 约定（沿仓库惯例，同 test/subagent-web-tail.test.ts）：globals:false 显式
 * import from "vitest"；fixture 用 fs.mkdtempSync(os.tmpdir()) + afterEach 递归
 * 删除；不依赖真实时钟。
 */

import { describe, expect, it, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { CHILDREN_FILE_NAME, MAX_CHILD_POINTER_FILE_BYTES, MAX_CHILD_POINTER_LINE_BYTES, appendChildPointer, readChildPointers } from "../src/web/children.ts";
import type { ChildPointer } from "../src/web/children.ts";

/** uuid 形状的固定 taskId 生成器（version 4 形状，逐个确定）。 */
function uuid(n: number): string {
	return `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
}

/** 合法指针记录工厂（字段逐个可控）。 */
function pointer(n: number, overrides: Partial<ChildPointer> = {}): ChildPointer {
	return {
		childTaskId: uuid(n),
		agent: "coder",
		task: `task ${n}`,
		startedAt: 1_800_000_000_000 + n,
		depth: 2,
		...overrides,
	};
}

let sessionDir: string;

beforeEach(() => {
	sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), "subagent-web-children-"));
});

afterEach(() => {
	fs.rmSync(sessionDir, { recursive: true, force: true });
});

/** 覆盖写 children.jsonl（每行一个 JSON 对象，末尾带换行）。 */
function writeChildrenLines(lines: string[]): void {
	fs.writeFileSync(path.join(sessionDir, CHILDREN_FILE_NAME), lines.join("\n") + "\n", "utf-8");
}

// ================================================================
// 1. 正常解析
// ================================================================

describe("readChildPointers 解析", () => {
	it("should return both records with exact fields when the file holds two valid JSON lines", () => {
		// Arrange: 两条合法指针
		const first = pointer(1);
		const second = pointer(2, { agent: "tester", task: "second task", depth: 3 });
		writeChildrenLines([JSON.stringify(first), JSON.stringify(second)]);

		// Act
		const records = readChildPointers(sessionDir);

		// Assert: 2 条，字段逐一相等
		expect(records).toHaveLength(2);
		expect(records[0]).toEqual(first);
		expect(records[1]).toEqual(second);
	});

	it("should return an empty array when the session directory holds no children file", () => {
		// Arrange: 不写 children.jsonl

		// Act
		const records = readChildPointers(sessionDir);

		// Assert
		expect(records).toEqual([]);
	});

	it("should skip blank, malformed and invalid-field lines while keeping the valid ones", () => {
		// Arrange: 坏行夹在两条合法行之间 —— 空行、非 JSON 文本、缺字段的 JSON、
		// childTaskId 非 UUID 字符串、agent 非字符串、task 非字符串、startedAt 非数字、
		// depth 非有限数字
		const first = pointer(3);
		const second = pointer(4);
		writeChildrenLines([
			JSON.stringify(first),
			"",
			"not json at all",
			"{ missing brace",
			JSON.stringify({ agent: "coder", task: "no childTaskId" }),
			JSON.stringify({ ...pointer(6), childTaskId: "not-a-uuid" }),
			JSON.stringify({ ...pointer(7), agent: 42 }),
			JSON.stringify({ ...pointer(8), task: null }),
			JSON.stringify({ ...pointer(9), startedAt: "yesterday" }),
			JSON.stringify({ ...pointer(10), depth: Number.POSITIVE_INFINITY }),
			JSON.stringify(second),
		]);

		// Act
		const records = readChildPointers(sessionDir);

		// Assert: 只有两条合法记录
		expect(records).toHaveLength(2);
		expect(records[0]).toEqual(first);
		expect(records[1]).toEqual(second);
		expect(records.some((r) => r.task === "no childTaskId")).toBe(false);
	});

	it("should keep a single record taking the last fields when the same childTaskId appears twice", () => {
		// Arrange: 同一 childTaskId 两行，agent/task/startedAt/depth 均不同
		const childTaskId = uuid(11);
		const first = pointer(11, { agent: "coder", task: "first wording", startedAt: 1_000, depth: 2 });
		const last = pointer(11, { agent: "reviewer", task: "last wording", startedAt: 2_000, depth: 4 });
		writeChildrenLines([JSON.stringify(first), JSON.stringify(last)]);

		// Act
		const records = readChildPointers(sessionDir);

		// Assert: 只保留 1 条，字段取最后一次
		expect(records).toHaveLength(1);
		expect(records[0].childTaskId).toBe(childTaskId);
		expect(records[0].agent).toBe("reviewer");
		expect(records[0].task).toBe("last wording");
		expect(records[0].startedAt).toBe(2_000);
		expect(records[0].depth).toBe(4);
	});

	it("should skip a line whose byte length exceeds MAX_CHILD_POINTER_LINE_BYTES", () => {
		// Arrange: 常量钉死 + 一条超长行 + 一条合法行
		expect(MAX_CHILD_POINTER_LINE_BYTES).toBe(1024 * 1024);
		const oversized = JSON.stringify(pointer(12, { task: "x".repeat(MAX_CHILD_POINTER_LINE_BYTES + 1) }));
		expect(Buffer.byteLength(oversized, "utf-8")).toBeGreaterThan(MAX_CHILD_POINTER_LINE_BYTES);
		const valid = pointer(13);
		writeChildrenLines([oversized, JSON.stringify(valid)]);

		// Act
		const records = readChildPointers(sessionDir);

		// Assert: 超长行被跳过，只剩合法那条
		expect(records).toHaveLength(1);
		expect(records[0]).toEqual(valid);
	});

	it("should export the whole-file pointer cap as exactly 8 MiB", () => {
		// Arrange / Act: 纯常量断言

		// Assert: 整文件上限钉死为 8 MiB
		expect(MAX_CHILD_POINTER_FILE_BYTES).toBe(8 * 1024 * 1024);
	});

	it("should return only the leading records when the whole children file exceeds MAX_CHILD_POINTER_FILE_BYTES", () => {
		// Arrange: 前两行合法指针 → 一行超过整文件上限的超长填充行 → 第三条合法指针。
		// 填充行本身也是合法 JSON 指针 —— 专为抓「只有逐行上限、没有整文件上限」
		// 的实现：逐行跳过填充行后还会把尾部第三条合法记录捞回来
		const FILE_CAP = 8 * 1024 * 1024;
		const first = pointer(41);
		const second = pointer(42, { agent: "tester", task: "second leading record", depth: 3 });
		const third = pointer(43, { agent: "reviewer", task: "record past the file cap" });
		const padding = JSON.stringify(pointer(44, { task: "x".repeat(FILE_CAP + 1) }));
		const raw = [JSON.stringify(first), JSON.stringify(second), padding, JSON.stringify(third)].join("\n") + "\n";
		expect(Buffer.byteLength(raw, "utf-8")).toBeGreaterThan(FILE_CAP);
		fs.writeFileSync(path.join(sessionDir, CHILDREN_FILE_NAME), raw, "utf-8");

		// Act: 不得抛错
		let records: ChildPointer[] | undefined;
		expect(() => {
			records = readChildPointers(sessionDir);
		}).not.toThrow();

		// Assert: 恰好前两条（文件顺序、字段逐一相等）；填充行与超限后的第三条
		// 都不得出现
		expect(records).toHaveLength(2);
		expect(records?.[0]).toEqual(first);
		expect(records?.[1]).toEqual(second);
		expect(records?.some((r) => r.childTaskId === third.childTaskId)).toBe(false);
	});
});

// ================================================================
// 2. appendChildPointer 写入
// ================================================================

describe("appendChildPointer 写入", () => {
	it("should append exactly one JSON line matching JSON.stringify(record) + newline", () => {
		// Arrange
		const record = pointer(21);

		// Act
		appendChildPointer(sessionDir, record);

		// Assert: 文件内容恰为一行 JSON + 换行
		const content = fs.readFileSync(path.join(sessionDir, CHILDREN_FILE_NAME), "utf-8");
		expect(content).toBe(JSON.stringify(record) + "\n");
	});

	it("should append a second JSON line that round-trips through JSON.parse when called twice", () => {
		// Arrange
		const first = pointer(22);
		const second = pointer(23);

		// Act
		appendChildPointer(sessionDir, first);
		appendChildPointer(sessionDir, second);

		// Assert: 两行，逐行 JSON.parse 往返一致
		const lines = fs.readFileSync(path.join(sessionDir, CHILDREN_FILE_NAME), "utf-8").split("\n");
		expect(lines).toHaveLength(3); // 两行内容 + 末尾换行切出的空串
		expect(lines[2]).toBe("");
		expect(JSON.parse(lines[0])).toEqual(first);
		expect(JSON.parse(lines[1])).toEqual(second);
	});
});

// ================================================================
// 3. appendChildPointer 失败不抛（best-effort）
// ================================================================

describe("appendChildPointer 的 best-effort 语义", () => {
	it("should not throw when the session path is an existing plain file (ENOTDIR)", () => {
		// Arrange: sessionDir 指向一个已存在的普通文件
		const filePath = path.join(sessionDir, "plain.txt");
		fs.writeFileSync(filePath, "i am a file", "utf-8");
		const record = pointer(31);

		// Act + Assert: appendFileSync 落到 ENOTDIR，但不得抛出
		expect(() => appendChildPointer(filePath, record)).not.toThrow();
	});

	it("should not throw when the session directory does not exist (ENOENT)", () => {
		// Arrange: 不存在的目录
		const missingDir = path.join(sessionDir, "no-such-dir");
		const record = pointer(32);

		// Act + Assert: ENOENT 不得抛出
		expect(() => appendChildPointer(missingDir, record)).not.toThrow();
	});
});
