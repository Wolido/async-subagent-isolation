/**
 * Red-phase tests for 方案 A: /subagent-result 查看器显示完整会话记录.
 *
 * 当前实现只显示 extractFinalAssistantText 提取的最后一条 assistant 文本；
 * 需求是显示完整会话记录（中间工具调用、toolResult、多轮文本）+ 任务原文
 * （session 文件第一条 user 消息，通常以 "Task: " 开头）。
 *
 * 以下测试均为红阶段：在当前实现下断言失败，需 coder 实现新提取函数
 * （建议名 extractSessionTranscript）并让 /subagent-result handler 使用它。
 *
 * 本文件只测试 /subagent-result 命令 handler 的可观测渲染输出，不触碰 src/。
 */

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import extension, { taskRegistry } from "../src/index.ts";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

vi.mock("@earendil-works/pi-coding-agent", async () => {
	const actual = await vi.importActual("@earendil-works/pi-coding-agent");
	return {
		...actual,
		getAgentDir: vi.fn(),
	};
});

// ---------------------------------------------------------------------------
// Helpers（与 test/receipt-and-subagent-result.test.ts 保持一致的最小集）
// ---------------------------------------------------------------------------

function createMockPi() {
	const commandDefs: Map<string, any> = new Map();
	return {
		registerTool: vi.fn(),
		registerCommand: vi.fn((name: string, options: any) => {
			commandDefs.set(name, options);
		}),
		registerMessageRenderer: vi.fn(),
		on: vi.fn(),
		sendMessage: vi.fn(),
		_commandDefs: commandDefs,
	};
}

/** Mock a TUI command ctx and capture the text shown via ctx.ui.custom(). */
function createViewerCtx() {
	const notifyMock = vi.fn();
	let rendered = "";
	const customMock = vi.fn(async (cb: any) => {
		const theme = { fg: (_c: string, s: string) => s, bold: (s: string) => s };
		const component = cb(null, theme, null, () => {});
		rendered = component.render(80).join("\n");
	});
	const ctx = { hasUI: true, mode: "tui" as const, ui: { notify: notifyMock, custom: customMock } };
	return { ctx, notifyMock, customMock, getRendered: () => rendered };
}

/** Write a JSONL session file with the given messages array（与现有 writeSessionFile 一致）. */
function writeSessionFile(sessionDir: string, taskId: string, messages: object[]): string {
	fs.mkdirSync(sessionDir, { recursive: true });
	const filePath = path.join(sessionDir, `1700000000000_${taskId}.jsonl`);
	const content = messages.map((m) => JSON.stringify(m)).join("\n") + "\n";
	fs.writeFileSync(filePath, content, "utf-8");
	return filePath;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("/subagent-result 完整会话记录（方案 A，红阶段）", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "session-transcript-"));
		vi.mocked(getAgentDir).mockReturnValue(tempDir);
		taskRegistry.clear();
	});

	afterEach(() => {
		fs.rmSync(tempDir, { recursive: true, force: true });
		taskRegistry.clear();
		vi.restoreAllMocks();
	});

	/** Load extension and grab the /subagent-result command handler. */
	async function runHandler(taskId: string) {
		const pi = createMockPi();
		extension(pi as any);
		const commandDef = pi._commandDefs.get("subagent-result");
		expect(commandDef).toBeDefined();
		const viewer = createViewerCtx();
		await commandDef.handler(taskId, viewer.ctx);
		return viewer;
	}

	// ================================================================
	// 1. 任务原文显示（红）
	// 当前实现只显示最后一条 assistant 文本，不包含任务原文 → 红。
	// ================================================================
	describe("任务原文显示", () => {
		it("查看器应显示「任务原文」标签（当前只显示最终文本 → 红）", async () => {
			// Arrange: 第一条 user 消息以 "Task: " 开头
			const taskId = "transcript-task-label";
			const sessionDir = path.join(tempDir, "subagent-sessions", taskId);
			writeSessionFile(sessionDir, taskId, [
				{
					type: "message",
					message: { role: "user", content: [{ type: "text", text: "Task: 重构认证中间件" }] },
				},
				{
					type: "message",
					message: {
						role: "assistant",
						content: [{ type: "text", text: "所有测试通过，任务完成。" }],
					},
				},
			]);

			// Act: 触发 /subagent-result handler
			const { getRendered } = await runHandler(taskId);

			// Assert: 渲染内容应包含"任务原文"标签
			expect(getRendered()).toContain("任务原文");
		});

		it("查看器应显示任务文本「重构认证中间件」（当前只显示最终文本 → 红）", async () => {
			// Arrange
			const taskId = "transcript-task-text";
			const sessionDir = path.join(tempDir, "subagent-sessions", taskId);
			writeSessionFile(sessionDir, taskId, [
				{
					type: "message",
					message: { role: "user", content: [{ type: "text", text: "Task: 重构认证中间件" }] },
				},
				{
					type: "message",
					message: {
						role: "assistant",
						content: [{ type: "text", text: "所有测试通过，任务完成。" }],
					},
				},
			]);

			// Act
			const { getRendered } = await runHandler(taskId);

			// Assert: 任务原文内容应出现在渲染中
			// （注意：assistant 文本刻意不含"重构认证中间件"，避免误绿）
			expect(getRendered()).toContain("重构认证中间件");
		});
	});

	// ================================================================
	// 2. 工具调用行显示（红）
	// ================================================================
	describe("工具调用行显示", () => {
		it("查看器应显示工具调用行「→ read」（当前只显示最终文本 → 红）", async () => {
			// Arrange: assistant 消息 content 含 type:"toolCall" 的 part
			const taskId = "transcript-tool-call";
			const sessionDir = path.join(tempDir, "subagent-sessions", taskId);
			writeSessionFile(sessionDir, taskId, [
				{
					type: "message",
					message: { role: "user", content: [{ type: "text", text: "Task: 读取配置" }] },
				},
				{
					type: "message",
					message: {
						role: "assistant",
						content: [{ type: "toolCall", name: "read", arguments: { path: "config.json" } }],
					},
				},
				{
					type: "message",
					message: {
						role: "assistant",
						content: [{ type: "text", text: "配置已读取，无异常。" }],
					},
				},
			]);

			// Act
			const { getRendered } = await runHandler(taskId);

			// Assert: 工具名应出现在渲染中（期望 "→ read" 形式）
			expect(getRendered()).toContain("→ read");
		});

		it("查看器应显示 write 工具调用行（当前只显示最终文本 → 红）", async () => {
			// Arrange
			const taskId = "transcript-tool-call-write";
			const sessionDir = path.join(tempDir, "subagent-sessions", taskId);
			writeSessionFile(sessionDir, taskId, [
				{
					type: "message",
					message: { role: "user", content: [{ type: "text", text: "Task: 修改文件" }] },
				},
				{
					type: "message",
					message: {
						role: "assistant",
						content: [{ type: "toolCall", name: "write", arguments: { path: "src/a.ts", content: "..." } }],
					},
				},
				{
					type: "message",
					message: {
						role: "assistant",
						content: [{ type: "text", text: "文件已写入。" }],
					},
				},
			]);

			// Act
			const { getRendered } = await runHandler(taskId);

			// Assert
			expect(getRendered()).toContain("→ write");
		});
	});

	// ================================================================
	// 3. toolResult 显示（红）
	// ================================================================
	describe("toolResult 显示", () => {
		it("查看器应显示工具结果摘要（当前只显示最终文本 → 红）", async () => {
			// Arrange: session 含 toolResult 消息（role:"toolResult"）
			const taskId = "transcript-tool-result";
			const sessionDir = path.join(tempDir, "subagent-sessions", taskId);
			writeSessionFile(sessionDir, taskId, [
				{
					type: "message",
					message: { role: "user", content: [{ type: "text", text: "Task: 统计行数" }] },
				},
				{
					type: "message",
					message: {
						role: "assistant",
						content: [{ type: "toolCall", name: "read", arguments: { path: "src/index.ts" } }],
					},
				},
				{
					type: "message",
					message: {
						role: "toolResult",
						toolCallId: "call-1",
						toolName: "read",
						content: [{ type: "text", text: "文件共 120 行" }],
						isError: false,
					},
				},
				{
					type: "message",
					message: {
						role: "assistant",
						content: [{ type: "text", text: "统计完成。" }],
					},
				},
			]);

			// Act
			const { getRendered } = await runHandler(taskId);

			// Assert: 工具结果摘要应出现在渲染中
			expect(getRendered()).toContain("文件共 120 行");
		});
	});

	// ================================================================
	// 4. 多轮顺序（红）
	// ================================================================
	describe("多轮顺序", () => {
		it("assistant 文本 → 工具调用 → 最终输出的顺序应在渲染中保持（当前只显示最终输出 → 红）", async () => {
			// Arrange: 构造 文本 → 工具调用 → toolResult → 最终输出 的多轮会话
			const taskId = "transcript-order";
			const sessionDir = path.join(tempDir, "subagent-sessions", taskId);
			writeSessionFile(sessionDir, taskId, [
				{
					type: "message",
					message: { role: "user", content: [{ type: "text", text: "Task: 重构认证中间件" }] },
				},
				{
					type: "message",
					message: {
						role: "assistant",
						content: [{ type: "text", text: "第一步：读取现状" }],
					},
				},
				{
					type: "message",
					message: {
						role: "assistant",
						content: [{ type: "toolCall", name: "read", arguments: { path: "src/middleware.ts" } }],
					},
				},
				{
					type: "message",
					message: {
						role: "toolResult",
						toolCallId: "call-2",
						toolName: "read",
						content: [{ type: "text", text: "已读取 src/middleware.ts" }],
						isError: false,
					},
				},
				{
					type: "message",
					message: {
						role: "assistant",
						content: [{ type: "text", text: "最终输出：重构完成" }],
					},
				},
			]);

			// Act
			const { getRendered } = await runHandler(taskId);
			const rendered = getRendered();

			// Assert: 三段内容都应在渲染中
			expect(rendered).toContain("第一步：读取现状");
			expect(rendered).toContain("→ read");
			expect(rendered).toContain("最终输出：重构完成");

			// Assert: 顺序保持 文本 → 工具调用 → 最终输出
			const firstStepIdx = rendered.indexOf("第一步：读取现状");
			const toolCallIdx = rendered.indexOf("→ read");
			const finalIdx = rendered.indexOf("最终输出：重构完成");
			expect(firstStepIdx).toBeGreaterThanOrEqual(0);
			expect(firstStepIdx).toBeLessThan(toolCallIdx);
			expect(toolCallIdx).toBeLessThan(finalIdx);
		});
	});

	// ================================================================
	// 5. 回归锁定：最终输出仍是完整记录的组成部分（现在绿，实现后必须保持绿）
	// ================================================================
	describe("回归锁定", () => {
		it("最终 assistant 文本仍应出现在查看器中（完整记录是最终输出的超集）", async () => {
			// Arrange
			const taskId = "transcript-regression-final";
			const sessionDir = path.join(tempDir, "subagent-sessions", taskId);
			writeSessionFile(sessionDir, taskId, [
				{
					type: "message",
					message: { role: "user", content: [{ type: "text", text: "Task: 重构认证中间件" }] },
				},
				{
					type: "message",
					message: {
						role: "assistant",
						content: [{ type: "text", text: "First response" }],
					},
				},
				{
					type: "message",
					message: {
						role: "assistant",
						content: [{ type: "text", text: "Final answer" }],
					},
				},
			]);

			// Act
			const { getRendered } = await runHandler(taskId);

			// Assert: 最终输出仍在渲染中（完整会话记录应包含它）
			expect(getRendered()).toContain("Final answer");
		});

		it("无 assistant 文本的会话仍应提示「任务无最终输出」（不崩溃）", async () => {
			// Arrange: 只有 user 消息，无 assistant 文本
			const taskId = "transcript-no-assistant";
			const sessionDir = path.join(tempDir, "subagent-sessions", taskId);
			writeSessionFile(sessionDir, taskId, [
				{
					type: "message",
					message: { role: "user", content: [{ type: "text", text: "Task: 重构认证中间件" }] },
				},
			]);

			// Act
			const pi = createMockPi();
			extension(pi as any);
			const commandDef = pi._commandDefs.get("subagent-result");
			const notifyMock = vi.fn();
			const ctx = { hasUI: true, mode: "tui" as const, ui: { notify: notifyMock, custom: vi.fn() } };
			await commandDef.handler(taskId, ctx);

			// Assert: 应提示无最终输出（不抛异常）
			const allOutput = notifyMock.mock.calls.map((c) => String(c[0])).join("");
			expect(allOutput).toMatch(/无最终输出|未产生/);
		});
	});
});
