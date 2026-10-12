/**
 * 红阶段测试：`src/web/session-source.ts` —— 会话 JSONL 解析 + 有界读取 +
 * path/size/mtime 缓存的解析底座。
 *
 * 被测接口（固定签名，实现者照此实现）：
 *   MAX_PARSE_BYTES = 20 * 1024 * 1024
 *   readSessionSummary(filePath: string): SessionSummary
 *     SessionSummary = {
 *       headerTs: number | null;
 *       toolCalls: Map<string, ParsedToolCall>;   // 仅 subagent toolCall
 *       callOrder: ParsedToolCall[];              // 出现顺序
 *       results: ParsedResult[];                  // subagent toolResult
 *     }
 *     ParsedToolCall = { id, agent?, task?, ts }
 *     ParsedResult    = { toolCallId, text, ts }
 *   resetSessionSourceCacheForTests(): void
 *
 * 说明：user 消息不再解析（firstUserText 字段与 readFirstUserMessage 导出已随
 * 内容匹配机制一并删除，父子链接改由 children.jsonl 指针 + 收据完成）。
 *
 * 用例覆盖（对应 brief 要点）：
 *   1. 解析：headerTs / subagent toolCall（agent/task/ts，按序）/ toolResult。
 *   2. 大文件保护：文件 > MAX_PARSE_BYTES 时只读尾部窗口（按行边界对齐）——
 *      构造 >21 MiB 文件，头部与尾部各一条 subagent toolCall，只有尾部那条可见，
 *      证明读取有界、不会整文件载入解析。
 *   3. 缓存：同一未变文件两次调用返回等价结果；文件追加（size/mtime 变化）后
 *      再次调用看到新内容。
 *   A1. ParsedResult.isError: boolean —— 来自 toolResult 消息的
 *      message.isError === true；字段缺失视为 false。
 *   A2. SessionSummary.lastEntryTs: number | null —— 文件中**最后一条 message
 *      行**的时间戳（按文件顺序取最后一条而非最大 ts；session 头行与其它类型
 *      行（如 compaction）**不计入**，头行时间戳只进 headerTs）；无 message 行
 *      → null。缓存策略与 summary 相同（同一 LRU key
 *      path/size/mtimeMs，文件追加后新值可见）。
 *
 * 约定（沿仓库惯例，同 test/subagent-web-tree.test.ts）：globals:false 显式
 * import from "vitest"；fixture 用 fs.mkdtempSync(os.tmpdir()) + afterEach 递归
 * 删除；beforeEach 调 resetSessionSourceCacheForTests() 隔离模块级缓存，测试
 * 相互独立、不依赖执行顺序。
 */

import { describe, expect, it, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { MAX_PARSE_BYTES, readSessionSummary, resetSessionSourceCacheForTests } from "../src/web/session-source.ts";
import type { ParsedResult, ParsedToolCall, SessionSummary } from "../src/web/session-source.ts";

/** 固定时间戳：所有 ts/header 断言相对它计算，不依赖真实时钟。 */
const TS = 1_800_000_000_000;

function iso(ms: number): string {
	return new Date(ms).toISOString();
}

// ---------------------------------------------------------------------------
// JSONL 行构造器（形状同 test/subagent-web-tree.test.ts：真实数据形状）
// ---------------------------------------------------------------------------

function sessionHeaderLine(sessionId: string, ts: number): string {
	return JSON.stringify({ type: "session", sessionId, timestamp: iso(ts) });
}

/** user 消息行（真实会话里存在；解析结果不再包含 user 消息字段）。 */
function userLine(text: string, ts: number): string {
	return JSON.stringify({
		type: "message",
		id: `msg-user-${ts}`,
		parentId: `session-${ts}`,
		timestamp: iso(ts),
		message: { role: "user", content: [{ type: "text", text }] },
	});
}

/** assistant 消息里的 subagent toolCall。 */
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

/** subagent toolResult 行（text 为收据文本）。 */
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

/** subagent toolResult 行，message.isError === true（派发被拒 / 运行失败）。 */
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

/** subagent toolResult 行，完全不带 isError 字段（契约：缺失视为 false）。 */
function receiptLineWithoutIsError(callId: string, text: string, ts: number): string {
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
		},
	});
}

// ---------------------------------------------------------------------------
// fixture 落盘
// ---------------------------------------------------------------------------

let tmpDir: string;
let filePath: string;

beforeEach(() => {
	tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "subagent-web-source-"));
	filePath = path.join(tmpDir, "session.jsonl");
	// 隔离模块级缓存：每个用例从冷缓存开始，不依赖执行顺序
	resetSessionSourceCacheForTests();
});

afterEach(() => {
	fs.rmSync(tmpDir, { recursive: true, force: true });
});

/** 覆盖写会话 JSONL。 */
function writeSession(lines: string[]): void {
	fs.writeFileSync(filePath, lines.join("\n") + "\n", "utf-8");
}

/** 把 Summary 归一成可 toEqual 比较的形状（Map → entries）。 */
function snapshot(summary: SessionSummary): {
	headerTs: number | null;
	lastEntryTs: number | null;
	toolCalls: [string, ParsedToolCall][];
	callOrder: ParsedToolCall[];
	results: ParsedResult[];
} {
	return {
		headerTs: summary.headerTs,
		lastEntryTs: summary.lastEntryTs,
		toolCalls: [...summary.toolCalls.entries()],
		callOrder: summary.callOrder,
		results: summary.results,
	};
}

// ================================================================
// 1. 解析
// ================================================================

describe("readSessionSummary 解析", () => {
	it("should parse the session header timestamp from the leading session entry", () => {
		// Arrange
		writeSession([sessionHeaderLine("session-abc", TS), userLine("hello", TS)]);

		// Act
		const summary = readSessionSummary(filePath);

		// Assert
		expect(summary.headerTs).toBe(TS);
	});

	it("should parse subagent tool calls with agent, task and timestamp in dispatch order", () => {
		// Arrange: 两条 subagent toolCall，时间与顺序均不同
		writeSession([
			sessionHeaderLine("session-abc", TS),
			toolCallLine("call-1", "coder", "first task", TS + 1_000),
			toolCallLine("call-2", "tester", "second task", TS + 2_000),
		]);

		// Act
		const summary = readSessionSummary(filePath);

		// Assert: 逐字段断言 + 出现顺序
		expect(summary.toolCalls.size).toBe(2);
		expect(summary.toolCalls.get("call-1")).toEqual({
			id: "call-1",
			agent: "coder",
			task: "first task",
			ts: TS + 1_000,
		});
		expect(summary.toolCalls.get("call-2")).toEqual({
			id: "call-2",
			agent: "tester",
			task: "second task",
			ts: TS + 2_000,
		});
		expect(summary.callOrder.map((call) => call.id)).toEqual(["call-1", "call-2"]);
	});

	it("should parse subagent tool results keyed by tool call id", () => {
		// Arrange: toolCall + 对应收据文本
		const receiptText = "Dispatched coder. taskId: 00000000-0000-4000-8000-000000000001";
		writeSession([
			sessionHeaderLine("session-abc", TS),
			toolCallLine("call-1", "coder", "the task", TS + 1_000),
			receiptLine("call-1", receiptText, TS + 2_000),
		]);

		// Act
		const summary = readSessionSummary(filePath);

		// Assert: isError 随结果解析（缺失的字段按契约归一为 false）
		expect(summary.results).toEqual([{ toolCallId: "call-1", text: receiptText, ts: TS + 2_000, isError: false }]);
	});
});

// ================================================================
// A1. ParsedResult.isError
// ================================================================

describe("ParsedResult.isError", () => {
	it("should mark a subagent tool result as an error when the message carries isError true", () => {
		// Arrange: 派发被拒的错误结果（message.isError === true）
		const errorText = 'Missing required parameter: "agent". Please specify the name of the agent to invoke.';
		writeSession([
			sessionHeaderLine("session-abc", TS),
			errorResultLine("call-1", errorText, TS + 1_000),
		]);

		// Act
		const summary = readSessionSummary(filePath);

		// Assert
		expect(summary.results).toHaveLength(1);
		expect(summary.results[0].toolCallId).toBe("call-1");
		expect(summary.results[0].isError).toBe(true);
	});

	it("should treat a subagent tool result without an isError field as non-error", () => {
		// Arrange: toolResult 消息不带 isError 字段（旧数据形状）
		const receiptText = "Dispatched coder. taskId: 00000000-0000-4000-8000-00000000000a";
		writeSession([
			sessionHeaderLine("session-abc", TS),
			receiptLineWithoutIsError("call-1", receiptText, TS + 1_000),
		]);

		// Act
		const summary = readSessionSummary(filePath);

		// Assert: 缺失视为 false，不是 undefined、不是 true
		expect(summary.results).toHaveLength(1);
		expect(summary.results[0].isError).toBe(false);
	});
});

// ================================================================
// A2. SessionSummary.lastEntryTs
// ================================================================

describe("SessionSummary.lastEntryTs", () => {
	it("should report the timestamp of the message line that appears last in the file, not the maximum timestamp", () => {
		// Arrange: header ts 最大，但文件最后一条 message 行（toolCall 行）ts 最小 ——
		// 契约取「文件中最后出现的 message 行」而非最大值（头行不计入 lastEntryTs）
		writeSession([
			sessionHeaderLine("session-abc", TS + 5_000),
			userLine("earlier by position", TS + 2_000),
			toolCallLine("call-1", "coder", "last by position", TS + 1_000),
		]);

		// Act
		const summary = readSessionSummary(filePath);

		// Assert: 最后一条 message 行的 ts 胜出
		expect(summary.lastEntryTs).toBe(TS + 1_000);
		expect(summary.lastEntryTs).not.toBe(TS + 5_000);
	});

	it("should be null when the file holds only a session header and no message lines", () => {
		// Arrange: 只有 {"type":"session",...,"timestamp":...} 头行 —— 头行时间戳
		// 只进 headerTs，不再计入 lastEntryTs
		writeSession([sessionHeaderLine("session-abc", TS)]);

		// Act
		const summary = readSessionSummary(filePath);

		// Assert: 头行确实被解析（fixture sanity），但 lastEntryTs 不取头行
		expect(summary.headerTs).toBe(TS);
		expect(summary.lastEntryTs).toBe(null);
	});

	it("should take the timestamp of the last message line when the file has a header and message lines", () => {
		// Arrange: 头行 ts 最大、最后一条 message 行 ts 最小 —— 取最后一条 message 行
		writeSession([
			sessionHeaderLine("session-abc", TS + 9_000),
			userLine("first message", TS + 5_000),
			toolCallLine("call-1", "coder", "last message", TS + 1_000),
		]);

		// Act
		const summary = readSessionSummary(filePath);

		// Assert: 最后一条 message 行的时间戳（不是头行的）
		expect(summary.lastEntryTs).toBe(TS + 1_000);
		expect(summary.lastEntryTs).not.toBe(TS + 9_000);
	});

	it("should not change lastEntryTs when a non-message non-session line such as compaction appears after the last message", () => {
		// Arrange: header + message + compaction（ts 更大）—— 非 message 非 session
		// 行不得改写 lastEntryTs
		writeSession([
			sessionHeaderLine("session-abc", TS),
			userLine("real message", TS + 1_000),
			JSON.stringify({ type: "compaction", timestamp: iso(TS + 9_000) }),
		]);

		// Act
		const summary = readSessionSummary(filePath);

		// Assert: compaction 行被忽略，仍取最后一条 message 行的 ts
		expect(summary.lastEntryTs).toBe(TS + 1_000);
	});

	it("should still read headerTs from the session header line while messages carry later timestamps", () => {
		// Arrange: 头行 ts 早于其后的 message 行 —— headerTs 不得因 lastEntryTs
		// 的规格变更回归为 message 时间戳
		writeSession([sessionHeaderLine("session-abc", TS), userLine("later message", TS + 5_000)]);

		// Act
		const summary = readSessionSummary(filePath);

		// Assert: headerTs 仍取 session 头行
		expect(summary.headerTs).toBe(TS);
		expect(summary.headerTs).not.toBe(TS + 5_000);
	});

	it("should update lastEntryTs when a line is appended between two reads", () => {
		// Arrange: 首读只有 header + 一条 user 消息
		writeSession([sessionHeaderLine("session-abc", TS), userLine("first", TS + 1_000)]);
		expect(readSessionSummary(filePath).lastEntryTs).toBe(TS + 1_000);

		// Act: 追加一条更晚的 entry（size/mtime 变化 → 同一 LRU key 失效重解析）
		fs.appendFileSync(filePath, userLine("appended", TS + 9_000) + "\n", "utf-8");
		const second = readSessionSummary(filePath);

		// Assert: 缓存追加后新值可见
		expect(second.lastEntryTs).toBe(TS + 9_000);
	});

	it("should be null for an empty session file", () => {
		// Arrange: 真正的空文件（0 字节）
		fs.writeFileSync(filePath, "", "utf-8");

		// Act
		const summary = readSessionSummary(filePath);

		// Assert
		expect(summary.lastEntryTs).toBe(null);
	});

	it("should be null when the file holds only unparsable lines", () => {
		// Arrange: 垃圾字节，无任何可解析 entry
		fs.writeFileSync(filePath, "not json at all\n{{{ totally broken\n", "utf-8");

		// Act
		const summary = readSessionSummary(filePath);

		// Assert
		expect(summary.lastEntryTs).toBe(null);
	});

	it("should be null when no entry carries a parseable timestamp", () => {
		// Arrange: 合法 message entry，但没有任何可解析的时间戳字段
		fs.writeFileSync(
			filePath,
			JSON.stringify({
				type: "message",
				id: "msg-no-ts",
				message: { role: "assistant", content: [{ type: "text", text: "no timestamp here" }] },
			}) + "\n",
			"utf-8",
		);

		// Act
		const summary = readSessionSummary(filePath);

		// Assert: 无可解析时间戳 → null（不回落 0/now）
		expect(summary.lastEntryTs).toBe(null);
	});
});

// ================================================================
// 2. 大文件保护：> MAX_PARSE_BYTES 只读尾部窗口
// ================================================================

describe("大文件保护（文件超过 MAX_PARSE_BYTES）", () => {
	it("should define MAX_PARSE_BYTES as 20 * 1024 * 1024", () => {
		// Act + Assert（常量钉死，窗口用例依赖它）
		expect(MAX_PARSE_BYTES).toBe(20 * 1024 * 1024);
	});

	it("should parse only the tail window when the session file exceeds MAX_PARSE_BYTES", () => {
		// Arrange: >21 MiB —— 头部一条 subagent toolCall、尾部一条 subagent toolCall，
		// 中间填充合法 JSONL 行。尾部窗口（≤20 MiB）必然够不到头部那条。
		const headCall = "call-head";
		const tailCall = "call-tail";
		const headLine = toolCallLine(headCall, "coder", "head dispatch that must stay unread", TS + 1_000);
		const tailLine = toolCallLine(tailCall, "tester", "tail dispatch inside the window", TS + 2_000);
		const filler = JSON.stringify({
			type: "message",
			id: "msg-filler",
			timestamp: iso(TS),
			message: { role: "assistant", content: [{ type: "text", text: "f".repeat(8 * 1024) }] },
		});
		const targetBytes = 21.5 * 1024 * 1024; // >21 MiB，且比尾部窗口多出约 1.5 MiB
		const fillerCount = Math.ceil(targetBytes / (Buffer.byteLength(filler) + 1));
		const lines = [sessionHeaderLine("session-abc", TS), headLine];
		for (let i = 0; i < fillerCount; i++) {
			lines.push(filler);
		}
		lines.push(tailLine);
		writeSession(lines);

		// Assert 0: fixture 确实越界（防空等价通过）
		expect(fs.statSync(filePath).size).toBeGreaterThan(MAX_PARSE_BYTES);

		// Act
		const summary = readSessionSummary(filePath);

		// Assert: 只有尾部窗口内的 toolCall 可见；头部那条不可见（读取有界）
		expect(summary.toolCalls.has(tailCall)).toBe(true);
		expect(summary.callOrder.map((call) => call.id)).toEqual([tailCall]);
		expect(summary.toolCalls.has(headCall)).toBe(false);
	}, 60_000);
});

// ================================================================
// 3. path/size/mtime 缓存
// ================================================================

describe("readSessionSummary 缓存", () => {
	it("should return an equivalent summary when the same unchanged file is read twice", () => {
		// Arrange: 一个包含全部解析要素的未变 fixture
		const receiptText = "Dispatched coder. taskId: 00000000-0000-4000-8000-000000000003";
		writeSession([
			sessionHeaderLine("session-abc", TS),
			userLine("cache me", TS + 1_000),
			toolCallLine("call-1", "coder", "cache me", TS + 2_000),
			receiptLine("call-1", receiptText, TS + 3_000),
		]);

		// Act
		const first = readSessionSummary(filePath);
		const second = readSessionSummary(filePath);

		// Assert: 两次等价（归一后逐字段比较），且确实解析到了内容（防空等价）
		expect(snapshot(second)).toEqual(snapshot(first));
		expect(second.headerTs).toBe(TS);
		expect(second.toolCalls.get("call-1")).toEqual(first.toolCalls.get("call-1"));
		expect(second.results).toEqual(first.results);
	});

	it("should reflect content appended between two reads once the file size and mtime changed", () => {
		// Arrange: 首读时还没有 toolResult
		writeSession([
			sessionHeaderLine("session-abc", TS),
			toolCallLine("call-1", "coder", "await receipt", TS + 1_000),
		]);
		const first = readSessionSummary(filePath);
		expect(first.results).toHaveLength(0);

		// Act: 追加收据行（size 与 mtime 均变化）后再读
		const receiptText = "Dispatched coder. taskId: 00000000-0000-4000-8000-000000000002";
		fs.appendFileSync(filePath, receiptLine("call-1", receiptText, TS + 2_000) + "\n", "utf-8");
		const second = readSessionSummary(filePath);

		// Assert: 缓存按 size/mtime 失效，新内容可见
		expect(second.results).toEqual([{ toolCallId: "call-1", text: receiptText, ts: TS + 2_000, isError: false }]);
	});
});
