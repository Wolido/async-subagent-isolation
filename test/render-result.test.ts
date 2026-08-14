/**
 * renderResult 对 cancel 回执的 details（无 results 字段）不得抛异常
 *
 * 背景（reviewer 审查 #1）：单入口 action 模式下，action=cancel 返回
 * details.taskId/cancelled，无 SubagentDetails.results 数组。renderResult
 * 直接访问 details.results.length 会抛 TypeError，导致渲染管线中断。
 *
 * Breaking change（v2.0.0）：action="status" 已从工具面移除，
 * details.activeTasks 形状不再可能产生 —— 原 status 渲染回退用例已删除，
 * 文本回退契约由下列 cancel 回执用例锁定（实现已满足，保持绿）。
 */

import { describe, expect, it, vi, beforeEach } from "vitest";
import extension from "../src/index.ts";

/** Build a mock pi object that captures all registration calls. */
function createMockPi() {
	const toolDefs: any[] = [];
	return {
		registerTool: vi.fn((tool: any) => {
			toolDefs.push(tool);
		}),
		registerCommand: vi.fn(),
		registerMessageRenderer: vi.fn(),
		on: vi.fn(),
		sendMessage: vi.fn(),
		_toolDefs: toolDefs,
	};
}

/** Plain-text theme: every color fn returns the text unchanged. */
function createMockTheme() {
	return {
		fg: vi.fn((_color: string, text: string) => text),
		bg: vi.fn((_color: string, text: string) => text),
		bold: vi.fn((text: string) => text),
		italic: vi.fn((text: string) => text),
		underline: vi.fn((text: string) => text),
		inverse: vi.fn((text: string) => text),
		strikethrough: vi.fn((text: string) => text),
		getFgAnsi: vi.fn(() => ""),
		getBgAnsi: vi.fn(() => ""),
		getColorMode: vi.fn(() => "truecolor"),
		getThinkingBorderColor: vi.fn(() => (s: string) => s),
		getBashModeBorderColor: vi.fn(() => (s: string) => s),
	} as any;
}

describe("renderResult — cancel 回执无 results 字段（#1 修复，契约锁定）", () => {
	let renderResult: any;
	let mockTheme: ReturnType<typeof createMockTheme>;
	const context = { lastComponent: undefined };

	beforeEach(() => {
		const pi = createMockPi();
		extension(pi as any);
		const subagent = pi._toolDefs.find((t: any) => t.name === "subagent");
		expect(subagent, "subagent tool should be registered").toBeDefined();
		renderResult = subagent.renderResult;
		mockTheme = createMockTheme();
	});

	it("action=cancel 的 result 渲染不抛 TypeError 且有文本输出（契约锁定：实现已满足）", () => {
		// Arrange: action=cancel 成功回执的真实返回形状 —— details 只有 taskId/cancelled
		const cancelResult = {
			content: [{ type: "text", text: "已发送取消请求: task-1 (cancel request sent); 结果稍后以 [subagent-result] 通知返回。" }],
			details: { taskId: "task-1", cancelled: true },
		};

		const render = () => renderResult(cancelResult, { expanded: false }, mockTheme, context);
		expect(render).not.toThrow();

		const lines = render().render(80);
		const text = lines.join("\n");
		expect(text.length).toBeGreaterThan(0);
		expect(text).toContain("task-1");
	});

	it("cancel 失败回执（details 亦无 results）渲染不抛 TypeError 且透传回执正文（契约锁定：实现已满足）", () => {
		// Arrange: action=cancel 失败路径返回形状 —— isError + details.taskId/cancelled:false
		const cancelErrorResult = {
			content: [{ type: "text", text: "无此运行中任务: ghost (no running subagent task with this id)." }],
			details: { taskId: "ghost", cancelled: false },
			isError: true,
		};

		const render = () => renderResult(cancelErrorResult, { expanded: false }, mockTheme, context);
		expect(render).not.toThrow();

		// Assert: 文本回退必须透传回执正文（含回执特定文案），
		// 而非仅"非空"——既锁内容，也锁不落入 "(no subagent result)" 兜底占位
		const lines = render().render(80);
		const text = lines.join("\n");
		expect(text).toContain("无此运行中任务");
		expect(text).toContain("ghost");
		expect(text).not.toContain("(no subagent result)");
	});
});

describe("renderResult — results.length===1 富渲染（契约锁定：实现已满足）", () => {
	let renderResult: any;
	let mockTheme: ReturnType<typeof createMockTheme>;
	const context = { lastComponent: undefined };

	beforeEach(() => {
		const pi = createMockPi();
		extension(pi as any);
		const subagent = pi._toolDefs.find((t: any) => t.name === "subagent");
		expect(subagent, "subagent tool should be registered").toBeDefined();
		renderResult = subagent.renderResult;
		mockTheme = createMockTheme();
	});

	/** 构造真实单结果 details（mode=single + results 数组长度为 1） */
	function singleResultDetails(overrides: Record<string, any> = {}): any {
		return {
			mode: "single",
			agentScope: "both",
			projectAgentsDir: null,
			results: [
				{
					agent: "coder",
					agentSource: "project",
					task: "补测试契约",
					exitCode: 0,
					messages: [{ role: "assistant", content: [{ type: "text", text: "任务完成" }] }],
					stderr: "",
					usage: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 1 },
					phase: "idle",
					lastPhaseChange: 0,
					sessionId: "rich-render-session",
					...overrides,
				},
			],
		};
	}

	it("成功回执走富渲染：折叠态含 agent 名与成功标记 ✓", () => {
		// Arrange: sync 模式成功返回形状 —— details.results 长度恰为 1
		const result = {
			content: [{ type: "text", text: "任务完成" }],
			details: singleResultDetails(),
		};

		// Act: 折叠态渲染
		const lines = renderResult(result, { expanded: false }, mockTheme, context).render(80);
		const text = lines.join("\n");

		// Assert: 进入富渲染分支 —— 含 agent 名、成功标记 ✓，非兜底占位
		expect(text).toContain("coder");
		expect(text).toContain("✓");
		expect(text).not.toContain("✗");
		expect(text).not.toContain("(no subagent result)");
	});

	it("失败回执走富渲染：折叠态含 agent 名、失败标记 ✗ 与错误信息", () => {
		// Arrange: sync 模式失败返回形状 —— exitCode 非 0 + stopReason/errorMessage
		const result = {
			content: [{ type: "text", text: "内部错误" }],
			details: singleResultDetails({
				exitCode: 1,
				stopReason: "error",
				errorMessage: "boom",
			}),
			isError: true,
		};

		// Act: 折叠态渲染
		const lines = renderResult(result, { expanded: false }, mockTheme, context).render(80);
		const text = lines.join("\n");

		// Assert: 富渲染分支 —— 含 agent 名、失败标记 ✗、错误信息，非兜底占位
		expect(text).toContain("coder");
		expect(text).toContain("✗");
		expect(text).toContain("Error: boom");
		expect(text).not.toContain("(no subagent result)");
	});
});
