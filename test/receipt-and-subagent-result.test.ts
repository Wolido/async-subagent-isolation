/**
 * Red-phase tests for three change requests:
 * 1. Receipt text simplification (回执精简回归)
 * 2. /subagent-result slash command (new feature — command not yet implemented)
 *
 * Notification card (registerMessageRenderer) is pure UI rendering — no tests.
 */

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn } from "node:child_process";
import extension, { taskRegistry, type AsyncSubagentTask } from "../src/index.ts";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

vi.mock("@earendil-works/pi-coding-agent", async () => {
	const actual = await vi.importActual("@earendil-works/pi-coding-agent");
	return {
		...actual,
		getAgentDir: vi.fn(),
	};
});

vi.mock("node:child_process", () => ({
	spawn: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Helpers (mirrors async-regression.test.ts patterns)
// ---------------------------------------------------------------------------

function createControllableProc() {
	const proc = new EventEmitter() as any;
	proc.stdout = new EventEmitter();
	proc.stderr = new EventEmitter();
	proc.kill = vi.fn(() => true);
	proc.exitCode = null;
	proc.signalCode = null;
	return proc;
}

function createMockPi() {
	const toolDefs: any[] = [];
	const commandDefs: Map<string, any> = new Map();
	const eventHandlers: Map<string, Function[]> = new Map();
	return {
		registerTool: vi.fn((tool: any) => {
			toolDefs.push(tool);
		}),
		registerCommand: vi.fn((name: string, options: any) => {
			commandDefs.set(name, options);
		}),
		registerMessageRenderer: vi.fn(),
		on: vi.fn((event: string, handler: Function) => {
			if (!eventHandlers.has(event)) eventHandlers.set(event, []);
			eventHandlers.get(event)!.push(handler);
		}),
		sendMessage: vi.fn(),
		_toolDefs: toolDefs,
		_commandDefs: commandDefs,
		_eventHandlers: eventHandlers,
	};
}

function createMockTuiCtx(cwd: string) {
	return {
		cwd,
		hasUI: true,
		mode: "tui" as const,
		ui: {
			setWidget: vi.fn(),
			confirm: vi.fn().mockResolvedValue(true),
		},
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

/** Mock a TUI command ctx that captures handleInput for interactive testing.
 * `done` is captured as a vi.fn() so tests can assert the viewer was closed
 * (Enter/Esc/q all close via done()). */
function createInteractiveViewerCtx() {
	const notifyMock = vi.fn();
	let component: any = null;
	const doneMock = vi.fn();
	const customMock = vi.fn(async (cb: any) => {
		const theme = { fg: (_c: string, s: string) => s, bold: (s: string) => s };
		component = cb(null, theme, null, doneMock);
	});
	const ctx = { hasUI: true, mode: "tui" as const, ui: { notify: notifyMock, custom: customMock } };
	return {
		ctx,
		notifyMock,
		customMock,
		getComponent: () => component,
		getRendered: (width = 80) => component ? component.render(width).join("\n") : "",
		handleInput: (data: string) => component?.handleInput(data),
		doneMock,
	};
}

type ExecuteFn = (
	toolCallId: string,
	params: Record<string, unknown>,
	signal: AbortSignal | undefined,
	onUpdate: unknown,
	ctx: unknown,
) => Promise<any>;

/** Write a JSONL session file with the given messages array. */
function writeSessionFile(sessionDir: string, taskId: string, messages: object[]): string {
	fs.mkdirSync(sessionDir, { recursive: true });
	const filePath = path.join(sessionDir, `1700000000000_${taskId}.jsonl`);
	const content = messages.map((m) => JSON.stringify(m)).join("\n") + "\n";
	fs.writeFileSync(filePath, content, "utf-8");
	return filePath;
}

// ---------------------------------------------------------------------------
// Env keys that affect execute() behavior — must be controlled per-test to
// avoid leakage from parallel test files (vitest shares process.env across
// worker threads by default).
// ---------------------------------------------------------------------------
const ENV_KEYS = [
	"PI_SUBAGENT_DEPTH",
	"PI_SUBAGENT_HARD_TIMEOUT_MS",
	"PI_SUBAGENT_ACTIVITY_TIMEOUT_MS",
	"PI_CURRENT_AGENT_NAME",
	"PI_CAN_DELEGATE",
];

/** Set env vars to safe defaults for dispatch tests. Call right before executeTool. */
function setSafeEnvForDispatch() {
	process.env.PI_SUBAGENT_DEPTH = "0";
	delete process.env.PI_CURRENT_AGENT_NAME;
	delete process.env.PI_CAN_DELEGATE;
	delete process.env.PI_SUBAGENT_HARD_TIMEOUT_MS;
	delete process.env.PI_SUBAGENT_ACTIVITY_TIMEOUT_MS;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("回执精简 & /subagent-result 命令 — 红阶段测试", () => {
	let tempDir: string;
	let procRef: ReturnType<typeof createControllableProc> | null;
	let savedEnv: Record<string, string | undefined>;

	beforeEach(() => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "subagent-receipt-cmd-"));
		vi.mocked(getAgentDir).mockReturnValue(tempDir);

		procRef = null;
		vi.mocked(spawn).mockImplementation((() => {
			const proc = createControllableProc();
			procRef = proc;
			return proc;
		}) as any);

		// Save env state
		savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
	});

	afterEach(() => {
		// Restore env state
		for (const key of ENV_KEYS) {
			if (savedEnv[key] === undefined) delete process.env[key];
			else process.env[key] = savedEnv[key];
		}
		fs.rmSync(tempDir, { recursive: true, force: true });
		taskRegistry.clear();
		vi.restoreAllMocks();
	});

	/** Load extension and capture registrations. */
	function loadExtension() {
		const pi = createMockPi();
		extension(pi as any);
		return {
			pi,
			executeTool: pi._toolDefs[0].execute as ExecuteFn,
		};
	}

	/** Helper: set up agent file and return ctx + executeTool. */
	function setupReceiptTest(agentName = "researcher") {
		setSafeEnvForDispatch();
		const { executeTool } = loadExtension();
		const cwd = path.join(tempDir, "cwd");
		fs.mkdirSync(path.join(cwd, ".pi", "agents"), { recursive: true });
		fs.writeFileSync(
			path.join(cwd, ".pi", "agents", `${agentName}.md`),
			`---\nname: ${agentName}\ndescription: Test agent\n---\n`,
			"utf-8",
		);
		const ctx = createMockTuiCtx(cwd);
		return { executeTool, ctx };
	}

	// ================================================================
	// 1. 回执精简回归
	// ================================================================
	describe("回执精简回归", () => {
		it("回执应以「已派出」开头且包含 taskId", async () => {
			const { executeTool, ctx } = setupReceiptTest();

			const result = await executeTool(
				"call-1",
				{ agent: "researcher", task: "do something" },
				undefined,
				undefined,
				ctx,
			);

			expect(result.isError).toBeFalsy();
			const receipt = result.content[0].text;
			expect(receipt).toMatch(/^已派出/);
			// Should contain a taskId (UUID or session id)
			expect(receipt).toMatch(/taskId/);
		});

		it("回执不应含长说明词（Do not treat / poll / fabricate）", async () => {
			const { executeTool, ctx } = setupReceiptTest();

			const result = await executeTool(
				"call-1",
				{ agent: "researcher", task: "do something" },
				undefined,
				undefined,
				ctx,
			);

			const receipt = result.content[0].text;
			expect(receipt).not.toMatch(/Do not treat/i);
			expect(receipt).not.toMatch(/poll/i);
			expect(receipt).not.toMatch(/fabricate/i);
		});
	});

	// ================================================================
	// 2. /subagent-result 命令
	// ================================================================
	describe("/subagent-result 命令", () => {
		it("扩展应注册 subagent-result 命令", () => {
			const { pi } = loadExtension();
			expect(pi._commandDefs.has("subagent-result")).toBe(true);
		});

		it("handler 应提取 session 文件中最后一条 assistant 文本并输出", async () => {
			const { pi } = loadExtension();
			const commandDef = pi._commandDefs.get("subagent-result");
			expect(commandDef).toBeDefined();

			const taskId = "test-task-123";
			const sessionDir = path.join(tempDir, "subagent-sessions", taskId);
			writeSessionFile(sessionDir, taskId, [
				{
					type: "message",
					message: { role: "user", content: [{ type: "text", text: "What is 2+2?" }] },
				},
				{
					type: "message",
					message: {
						role: "assistant",
						content: [{ type: "text", text: "The answer is 4." }],
					},
				},
			]);

			const stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
			const { ctx, customMock, getRendered } = createViewerCtx();

			await commandDef.handler(taskId, ctx);

			// Result is shown in the fullscreen viewer, not on stdout.
			expect(customMock).toHaveBeenCalled();
			expect(getRendered()).toContain("The answer is 4.");
			expect(stdoutSpy).not.toHaveBeenCalled();
		});

		it("handler 传入不存在的 taskId 应输出「无此任务记录」类提示", async () => {
			const { pi } = loadExtension();
			const commandDef = pi._commandDefs.get("subagent-result");
			expect(commandDef).toBeDefined();

			const consoleSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
			const notifyMock = vi.fn();
			const ctx = { ui: { notify: notifyMock } };

			await commandDef.handler("non-existent-task-id", ctx);

			const allOutput = [
				consoleSpy.mock.calls.map((c) => String(c[0])).join(""),
				...notifyMock.mock.calls.map((c) => String(c[0])),
			].join("");

			expect(allOutput).toMatch(/无|not found|不存在|没有|no.*record/i);
		});

		it("多消息 JSONL 应保留完整会话顺序（方案 A）", async () => {
			const { pi } = loadExtension();
			const commandDef = pi._commandDefs.get("subagent-result");
			expect(commandDef).toBeDefined();

			const taskId = "multi-msg-task";
			const sessionDir = path.join(tempDir, "subagent-sessions", taskId);
			writeSessionFile(sessionDir, taskId, [
				{
					type: "message",
					message: {
						role: "assistant",
						content: [{ type: "text", text: "First response" }],
					},
				},
				{
					type: "message",
					message: { role: "user", content: [{ type: "text", text: "Follow-up question" }] },
				},
				{
					type: "message",
					message: { role: "assistant", content: [{ type: "text", text: "Final answer" }] },
				},
			]);

			const stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
			const { ctx, customMock, getRendered } = createViewerCtx();

			await commandDef.handler(taskId, ctx);

			// Should contain the LAST assistant text
			expect(customMock).toHaveBeenCalled();
			expect(getRendered()).toContain("Final answer");
			// 方案 A: 完整会话记录包含中间轮文本，且保持原始会话顺序
			expect(getRendered()).toContain("First response");
			expect(getRendered().indexOf("First response")).toBeLessThan(getRendered().indexOf("Final answer"));
			expect(stdoutSpy).not.toHaveBeenCalled();
		});
	});

	// ================================================================
	// 4. /subagent-result 滚动功能红阶段测试
	// ================================================================
	describe("/subagent-result 滚动功能（红阶段）", () => {
		/** Generate a long multi-line text (200 lines). */
		function generateLongText(lineCount = 200): string {
			return Array.from({ length: lineCount }, (_, i) => `Line ${i + 1}: This is test content.`).join("\n");
		}

		it("长文本应按 down 键后 render 输出发生变化（发生滚动）", async () => {
			const { pi } = loadExtension();
			const commandDef = pi._commandDefs.get("subagent-result");
			expect(commandDef).toBeDefined();

			const taskId = "long-text-scroll-task";
			const sessionDir = path.join(tempDir, "subagent-sessions", taskId);
			writeSessionFile(sessionDir, taskId, [
				{
					type: "message",
					message: {
						role: "assistant",
						content: [{ type: "text", text: generateLongText() }],
					},
				},
			]);

			const { ctx, getRendered, handleInput } = createInteractiveViewerCtx();
			await commandDef.handler(taskId, ctx);

			// Capture initial render (no scroll)
			const initialRender = getRendered();

			// Simulate pressing down arrow key
			handleInput("\x1b[B"); // down arrow

			// Re-render after scroll
			const afterScrollRender = getRendered();

			// Output should have changed (scrolled)
			expect(afterScrollRender).not.toBe(initialRender);
		});

		it("连续按 down 后再按 up 应能回到顶部", async () => {
			const { pi } = loadExtension();
			const commandDef = pi._commandDefs.get("subagent-result");
			expect(commandDef).toBeDefined();

			const taskId = "scroll-updown-task";
			const sessionDir = path.join(tempDir, "subagent-sessions", taskId);
			writeSessionFile(sessionDir, taskId, [
				{
					type: "message",
					message: {
						role: "assistant",
						content: [{ type: "text", text: generateLongText() }],
					},
				},
			]);

			const { ctx, getRendered, handleInput } = createInteractiveViewerCtx();
			await commandDef.handler(taskId, ctx);

			const initialRender = getRendered();

			// Scroll down 10 times
			for (let i = 0; i < 10; i++) {
				handleInput("\x1b[B"); // down arrow
			}
			const scrolledDownRender = getRendered();

			// Scroll up 10 times to return to top
			for (let i = 0; i < 10; i++) {
				handleInput("\x1b[A"); // up arrow
			}
			const scrolledUpRender = getRendered();

			// Should be back to initial state
			expect(scrolledUpRender).toBe(initialRender);
			// And different from scrolled-down state
			expect(scrolledDownRender).not.toBe(initialRender);
		});

		it("PageDown 键应能翻页", async () => {
			const { pi } = loadExtension();
			const commandDef = pi._commandDefs.get("subagent-result");
			expect(commandDef).toBeDefined();

			const taskId = "pagedown-task";
			const sessionDir = path.join(tempDir, "subagent-sessions", taskId);
			writeSessionFile(sessionDir, taskId, [
				{
					type: "message",
					message: {
						role: "assistant",
						content: [{ type: "text", text: generateLongText() }],
					},
				},
			]);

			const { ctx, getRendered, handleInput } = createInteractiveViewerCtx();
			await commandDef.handler(taskId, ctx);

			const initialRender = getRendered();

			// Press PageDown
			handleInput("\x1b[6~"); // PageDown

			const afterPageDownRender = getRendered();

			// Output should have changed (scrolled by a page)
			expect(afterPageDownRender).not.toBe(initialRender);
		});

		it("Home 键应跳到开头", async () => {
			const { pi } = loadExtension();
			const commandDef = pi._commandDefs.get("subagent-result");
			expect(commandDef).toBeDefined();

			const taskId = "home-key-task";
			const sessionDir = path.join(tempDir, "subagent-sessions", taskId);
			writeSessionFile(sessionDir, taskId, [
				{
					type: "message",
					message: {
						role: "assistant",
						content: [{ type: "text", text: generateLongText() }],
					},
				},
			]);

			const { ctx, getRendered, handleInput } = createInteractiveViewerCtx();
			await commandDef.handler(taskId, ctx);

			const initialRender = getRendered();

			// Scroll down first
			for (let i = 0; i < 5; i++) {
				handleInput("\x1b[B"); // down arrow
			}
			const scrolledRender = getRendered();

			// Press Home to go back to top
			handleInput("\x1b[H"); // Home key

			const afterHomeRender = getRendered();

			// Should be back to initial state
			expect(afterHomeRender).toBe(initialRender);
			// And different from scrolled state
			expect(scrolledRender).not.toBe(initialRender);
		});

		it("End 键应跳到底部", async () => {
			const { pi } = loadExtension();
			const commandDef = pi._commandDefs.get("subagent-result");
			expect(commandDef).toBeDefined();

			const taskId = "end-key-task";
			const sessionDir = path.join(tempDir, "subagent-sessions", taskId);
			writeSessionFile(sessionDir, taskId, [
				{
					type: "message",
					message: {
						role: "assistant",
						content: [{ type: "text", text: generateLongText() }],
					},
				},
			]);

			const { ctx, getRendered, handleInput } = createInteractiveViewerCtx();
			await commandDef.handler(taskId, ctx);

			const initialRender = getRendered();

			// Press End to jump to bottom
			handleInput("\x1b[F"); // End key

			const afterEndRender = getRendered();

			// Output should have changed (scrolled to bottom)
			expect(afterEndRender).not.toBe(initialRender);
			// Should contain the last line
			expect(afterEndRender).toContain("Line 200");
		});

		it("短文本不应滚动（回归测试：短文本全显示）", async () => {
			const { pi } = loadExtension();
			const commandDef = pi._commandDefs.get("subagent-result");
			expect(commandDef).toBeDefined();

			const taskId = "short-text-task";
			const sessionDir = path.join(tempDir, "subagent-sessions", taskId);
			writeSessionFile(sessionDir, taskId, [
				{
					type: "message",
					message: {
						role: "assistant",
						content: [{ type: "text", text: "The answer is 4." }],
					},
				},
			]);

			const { ctx, getRendered, handleInput } = createInteractiveViewerCtx();
			await commandDef.handler(taskId, ctx);

			const initialRender = getRendered();

			// Short text should contain the full content
			expect(initialRender).toContain("The answer is 4.");

			// Press down arrow - should have no effect on short text
			handleInput("\x1b[B"); // down arrow

			const afterDownRender = getRendered();

			// Short text should still be fully visible (no scroll needed)
			expect(afterDownRender).toContain("The answer is 4.");
		});
	});

	// ================================================================
	// 5. /subagent-result 替代按键（less/vim 风格，红阶段）
	// PageUp/PageDown 需 Fn 组合难按，新增替代键：
	//   空格=向下翻页  b=向上翻页  j=向下滚一行  k=向上滚一行
	//   g=跳到开头     G=跳到底部
	// ================================================================
	describe("/subagent-result 替代按键（红阶段）", () => {
		/** Generate a long multi-line text (200 lines). */
		function generateLongText(lineCount = 200): string {
			return Array.from({ length: lineCount }, (_, i) => `Line ${i + 1}: This is test content.`).join("\n");
		}

		/** Open the fullscreen viewer with a 200-line assistant text. */
		async function openViewer(taskId: string) {
			const { pi } = loadExtension();
			const commandDef = pi._commandDefs.get("subagent-result");
			expect(commandDef).toBeDefined();

			const sessionDir = path.join(tempDir, "subagent-sessions", taskId);
			writeSessionFile(sessionDir, taskId, [
				{
					type: "message",
					message: {
						role: "assistant",
						content: [{ type: "text", text: generateLongText() }],
					},
				},
			]);

			const viewer = createInteractiveViewerCtx();
			await commandDef.handler(taskId, viewer.ctx);
			return viewer;
		}

		it("空格键应向下翻页（替代 PageDown）", async () => {
			const { getRendered, handleInput } = await openViewer("space-page-down");

			// Arrange: 初始在顶部
			const initialRender = getRendered();
			expect(initialRender).toContain("Line 1:");

			// Act: 按空格（字符 " "）
			handleInput(" ");

			// Assert: 应发生向下翻页（输出变化）
			expect(getRendered()).not.toBe(initialRender);
		});

		it("b 键应向上翻页（替代 PageUp）", async () => {
			const { getRendered, handleInput } = await openViewer("b-page-up");

			// Arrange: 先跳到底部
			handleInput("\x1b[F"); // End
			const bottomRender = getRendered();
			expect(bottomRender).toContain("Line 200");

			// Act: 按 b
			handleInput("b");
			const afterBRender = getRendered();

			// Assert: 应向上翻页（输出向上变化，不再显示最后一行）
			expect(afterBRender).not.toBe(bottomRender);
			expect(afterBRender).not.toContain("Line 200");
		});

		it("j 键应向下滚动一行（替代 ↓）", async () => {
			const { getRendered, handleInput } = await openViewer("j-scroll-down");

			// Arrange: 初始在顶部
			const initialRender = getRendered();

			// Act: 按 j
			handleInput("j");
			const afterJRender = getRendered();

			// Assert: 应下移一行（输出变化）
			expect(afterJRender).not.toBe(initialRender);

			// 再按 j：继续逐行下移
			handleInput("j");
			expect(getRendered()).not.toBe(afterJRender);
		});

		it("k 键应向上滚动一行（替代 ↑）", async () => {
			const { getRendered, handleInput } = await openViewer("k-scroll-up");

			// Arrange: 先用 ↓ 向下滚两行
			handleInput("\x1b[B"); // ↓ 1 行
			const oneDownRender = getRendered();
			handleInput("\x1b[B"); // ↓ 2 行
			expect(getRendered()).not.toBe(oneDownRender);

			// Act: 按 k
			handleInput("k");

			// Assert: 应向上滚回一行（回到 ↓ 1 行时的输出）
			expect(getRendered()).toBe(oneDownRender);
		});

		it("g 键应跳到开头（替代 Home）", async () => {
			const { getRendered, handleInput } = await openViewer("g-jump-top");

			// Arrange: 先跳到底部
			handleInput("\x1b[F"); // End
			expect(getRendered()).toContain("Line 200");

			// Act: 按 g
			handleInput("g");

			// Assert: 应回到顶部（输出含第一行）
			expect(getRendered()).toContain("Line 1:");
		});

		it("G 键应跳到底部（替代 End）", async () => {
			const { getRendered, handleInput } = await openViewer("G-jump-bottom");

			// Arrange: 初始在顶部
			const initialRender = getRendered();
			expect(initialRender).toContain("Line 1:");

			// Act: 按 G
			handleInput("G");
			const afterGRender = getRendered();

			// Assert: 应跳到底部（输出含最后一行）
			expect(afterGRender).toContain("Line 200");
			expect(afterGRender).not.toBe(initialRender);
		});

		it("空格在底部不再下移（与 PageDown 同 clamp 逻辑）", async () => {
			const { getRendered, handleInput } = await openViewer("space-bottom-clamp");

			// Act: 多次按空格应滚到底部（当前空格无响应 → 停留顶部）
			for (let i = 0; i < 50; i++) {
				handleInput(" ");
			}
			const atBottomRender = getRendered();

			// Assert: 应滚到底部（输出含最后一行）
			expect(atBottomRender).toContain("Line 200");

			// 底部再按空格：不越界、输出不再变化
			handleInput(" ");
			expect(getRendered()).toBe(atBottomRender);
		});

		it("g 在顶部不越界（clamp 到 0，不崩溃）", async () => {
			const { getRendered, handleInput } = await openViewer("g-top-clamp");

			// Arrange: 初始在顶部
			const initialRender = getRendered();
			expect(initialRender).toContain("Line 1:");

			// 先向下滚动 3 行
			for (let i = 0; i < 3; i++) {
				handleInput("\x1b[B"); // ↓
			}
			expect(getRendered()).not.toBe(initialRender);

			// Act: 按 g 应回到顶部
			handleInput("g");

			// Assert: 恰好回到顶部（不越界、不偏移）
			expect(getRendered()).toBe(initialRender);
		});

		// ============================================================
		// 5b. 替代按键的 Kitty 键盘协议（CSI-u）形态（红阶段）
		// Kitty/WezTerm/ghostty/foot 等终端启用 Kitty 协议后，普通字符也
		// 会被编码为 CSI-u 序列（flag 1 disambiguate / flag 4 alternate
		// keys）：按 k 收到 \x1b[107u、空格 \x1b[32u、shift+g 收到
		// \x1b[103:71;2u。当前 handleInput 用裸字符比较（data === "k" 等），
		// 这些序列全部不响应。修复方向：改用 matchesKey(data, "k") /
		// matchesKey(data, Key.space) / matchesKey(data, Key.shift("g"))
		// （matchesKey 同时覆盖原始字符与 CSI-u 两种形态）。
		// ============================================================
		describe("替代按键（Kitty CSI-u 形态，红阶段）", () => {
			it("CSI-u 空格（\\x1b[32u）应向下翻页（替代 PageDown）", async () => {
				const { getRendered, handleInput } = await openViewer("csi-u-space-page-down");

				// Arrange: 初始在顶部
				const initialRender = getRendered();
				expect(initialRender).toContain("Line 1:");

				// Act: Kitty 协议下按空格，终端发送 CSI-u 序列 \x1b[32u（空格 = 0x20 = 32）
				handleInput("\x1b[32u");

				// Assert: 应发生向下翻页（输出变化）——当前裸字符比较不响应 → 红
				expect(getRendered()).not.toBe(initialRender);
			});

			it("CSI-u k（\\x1b[107u）应向上滚动一行（替代 ↑）", async () => {
				const { getRendered, handleInput } = await openViewer("csi-u-k-scroll-up");

				// Arrange: 先用 ↓ 向下滚两行
				handleInput("\x1b[B"); // ↓ 1 行
				const oneDownRender = getRendered();
				handleInput("\x1b[B"); // ↓ 2 行
				expect(getRendered()).not.toBe(oneDownRender);

				// Act: Kitty 协议下按 k，终端发送 CSI-u 序列 \x1b[107u（k = 0x6b = 107）
				handleInput("\x1b[107u");

				// Assert: 应向上滚回一行（回到 ↓ 1 行时的输出）——当前不响应 → 红
				expect(getRendered()).toBe(oneDownRender);
			});

			it("CSI-u j（\\x1b[106u）应向下滚动一行（替代 ↓）", async () => {
				const { getRendered, handleInput } = await openViewer("csi-u-j-scroll-down");

				// Arrange: 初始在顶部
				const initialRender = getRendered();

				// Act: Kitty 协议下按 j，终端发送 CSI-u 序列 \x1b[106u（j = 0x6a = 106）
				handleInput("\x1b[106u");

				// Assert: 应下移一行（输出变化）——当前不响应 → 红
				expect(getRendered()).not.toBe(initialRender);
			});

			it("CSI-u shift+g（\\x1b[103:71;2u）应跳到底部（替代 End）", async () => {
				const { getRendered, handleInput } = await openViewer("csi-u-shift-g-jump-bottom");

				// Arrange: 初始在顶部
				const initialRender = getRendered();
				expect(initialRender).toContain("Line 1:");

				// Act: Kitty 协议下按 shift+G，终端发送 CSI-u 序列 \x1b[103:71;2u
				//（codepoint 103='g' : shifted 71='G' ; mod 2 = shift，flag 4 alternate keys）
				handleInput("\x1b[103:71;2u");

				// Assert: 应跳到底部（输出含最后一行）——当前不响应 → 红
				expect(getRendered()).toContain("Line 200");
				expect(getRendered()).not.toBe(initialRender);
			});
		});

		// ============================================================
		// 5c. q 键关闭查看器（红阶段）
		// 需求：/subagent-result 全屏查看器加 q 键退出，与 Enter/Esc 并列。
		// 当前 handleInput 仅对 enter/escape 调用 done()，q 无处理 → 红。
		// 修复方向：与替代按键一致使用 matchesKey(data, "q")，以同时兼容
		// 裸字符 q 与 Kitty CSI-u 形态 \x1b[113u（q = 0x71 = 113）。
		// ============================================================
		describe("q 键关闭查看器（红阶段）", () => {
			it("裸 q（\"q\"）应关闭查看器（done 被调用）", async () => {
				const { handleInput, doneMock } = await openViewer("q-close-bare");

				// Arrange: 打开查看器后 done 未被调用
				expect(doneMock).not.toHaveBeenCalled();

				// Act: 按 q
				handleInput("q");

				// Assert: 应调用 done 关闭查看器 —— 当前 q 无处理 → 红
				expect(doneMock).toHaveBeenCalled();
			});

			it("CSI-u q（\\x1b[113u）应关闭查看器（done 被调用）", async () => {
				const { handleInput, doneMock } = await openViewer("q-close-csi-u");

				// Arrange: 打开查看器后 done 未被调用
				expect(doneMock).not.toHaveBeenCalled();

				// Act: Kitty 协议下按 q，终端发送 CSI-u 序列 \x1b[113u（q = 0x71 = 113）
				handleInput("\x1b[113u");

				// Assert: 应调用 done 关闭查看器 —— 当前不响应 → 红
				expect(doneMock).toHaveBeenCalled();
			});

			it("回归：Enter（\\r）应关闭查看器（done 被调用）", async () => {
				const { handleInput, doneMock } = await openViewer("enter-close-regression");

				// Act: 按 Enter
				handleInput("\r");

				// Assert: 应调用 done —— 既有行为，保持绿
				expect(doneMock).toHaveBeenCalled();
			});

			it("回归：Esc（\\x1b）应关闭查看器（done 被调用）", async () => {
				const { handleInput, doneMock } = await openViewer("escape-close-regression");

				// Act: 按 Esc
				handleInput("\x1b");

				// Assert: 应调用 done —— 既有行为，保持绿
				expect(doneMock).toHaveBeenCalled();
			});
		});
	});

	// ================================================================
	// 3. /subagent-result 修复红阶段测试
	// ================================================================
	describe("/subagent-result 修复红阶段测试", () => {
		it("should refuse to show result when task is still running in taskRegistry", async () => {
			const { pi } = loadExtension();
			const commandDef = pi._commandDefs.get("subagent-result");
			expect(commandDef).toBeDefined();

			// Create a running task in the registry
			const taskId = "running-task-123";
			const runningTask: AsyncSubagentTask = {
				taskId,
			agentName: "test-agent",
			task: "test task",
				startedAt: Date.now(),
				abortController: new AbortController(),
				status: "running",
			};
			taskRegistry.set(taskId, runningTask);

			// Also create a session file for this task (should be ignored)
			const sessionDir = path.join(tempDir, "subagent-sessions", taskId);
			writeSessionFile(sessionDir, taskId, [
				{
					type: "message",
					message: {
						role: "assistant",
						content: [{ type: "text", text: "Partial result" }],
					},
				},
			]);

			const stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
			const notifyMock = vi.fn();
			const ctx = { ui: { notify: notifyMock, custom: vi.fn() } };

			await commandDef.handler(taskId, ctx);

			// Should show "still running" message
			const allOutput = [
				stdoutSpy.mock.calls.map((c) => String(c[0])).join(""),
				...notifyMock.mock.calls.map((c) => String(c[0])),
			].join("");

			expect(allOutput).toMatch(/仍在运行|still running|任务尚未完成/);
			// Should NOT show the session file content
			expect(allOutput).not.toContain("Partial result");
			// Should NOT use stdout.write
			expect(stdoutSpy).not.toHaveBeenCalled();
		});

		it("should NOT use process.stdout.write to display result", async () => {
			const { pi } = loadExtension();
			const commandDef = pi._commandDefs.get("subagent-result");
			expect(commandDef).toBeDefined();

			const taskId = "finished-task-456";
			const sessionDir = path.join(tempDir, "subagent-sessions", taskId);
			writeSessionFile(sessionDir, taskId, [
				{
					type: "message",
					message: {
						role: "assistant",
						content: [{ type: "text", text: "Final result text" }],
					},
				},
			]);

			const stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
			const { ctx } = createViewerCtx();

			await commandDef.handler(taskId, ctx);

			// Should NOT use process.stdout.write (current implementation does → red)
			expect(stdoutSpy).not.toHaveBeenCalled();
		});

		it("should use ctx.ui.custom() to display result in fullscreen viewer", async () => {
			const { pi } = loadExtension();
			const commandDef = pi._commandDefs.get("subagent-result");
			expect(commandDef).toBeDefined();

			const taskId = "finished-task-789";
			const sessionDir = path.join(tempDir, "subagent-sessions", taskId);
			writeSessionFile(sessionDir, taskId, [
				{
					type: "message",
					message: {
						role: "assistant",
						content: [{ type: "text", text: "Result for custom UI" }],
					},
				},
			]);

			const stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
			const { ctx, customMock } = createViewerCtx();

			await commandDef.handler(taskId, ctx);

			// Should use ctx.ui.custom() for display (current implementation doesn't → red)
			expect(customMock).toHaveBeenCalled();
			// Should NOT write to stdout
			expect(stdoutSpy).not.toHaveBeenCalled();
		});
	});

	// ================================================================
	// 6. /subagent-result 操作提示位置（红阶段）
	// 修复目标：操作提示从底部 footer 移到标题行（第一行永远可见）：
	//   Subagent Result: <taskId>  ↑↓/jk 滚动 · Space/b 翻页 · g/G 首尾 · Enter/Esc/q 关闭
	// 当前实现：提示在底部 footer 行（被挤到屏幕外），标题行只有 taskId → 以下测试红。
	// 渲染结构：[顶部边框, 标题行, body..., footer, 底部边框]，标题行 = 第一行内容行。
	// ================================================================
	describe("/subagent-result 操作提示位置（红阶段）", () => {
		/** 操作提示关键词（取自 footer 提示文本，任一命中即视为含提示）。 */
		const HINT_PATTERN = /Space|翻页|关闭|滚动|首尾/;

		/** 用受控短文本打开查看器（内容不含提示关键词，避免误判）。 */
		async function openShortViewer(taskId: string, text = "The answer is 4.") {
			const { pi } = loadExtension();
			const commandDef = pi._commandDefs.get("subagent-result");
			expect(commandDef).toBeDefined();
			const sessionDir = path.join(tempDir, "subagent-sessions", taskId);
			writeSessionFile(sessionDir, taskId, [
				{
					type: "message",
					message: {
						role: "assistant",
						content: [{ type: "text", text }],
					},
				},
			]);
			const viewer = createInteractiveViewerCtx();
			await commandDef.handler(taskId, viewer.ctx);
			return viewer;
		}

		/** 渲染行数组（getRendered 以 \n 拼接，拆回行数组）。 */
		function renderedLines(viewer: ReturnType<typeof createInteractiveViewerCtx>): string[] {
			return viewer.getRendered().split("\n");
		}

		/** 标题行 = 渲染输出的第一行内容行（顶部边框之后的 "Subagent Result: ..." 行）。 */
		function titleLine(viewer: ReturnType<typeof createInteractiveViewerCtx>): string {
			return renderedLines(viewer).find((line) => line.includes("Subagent Result")) ?? "";
		}

		it("标题行（第一行内容行）应包含操作提示关键词（当前提示在底部 footer → 红）", async () => {
			// Arrange: 打开查看器
			const viewer = await openShortViewer("hint-title-red");

			// Act: 取标题行
			const title = titleLine(viewer);

			// Assert: 标题行应含操作提示关键词（如 "Space" / "翻页" / "关闭"）
			// 当前实现标题行仅 "Subagent Result: <taskId>"，提示在底部 footer → 红
			expect(title).toMatch(HINT_PATTERN);
		});

		it("第一行（标题行）应同时包含标题与操作提示 → 红", async () => {
			const viewer = await openShortViewer("hint-title-both");

			const title = titleLine(viewer);

			// 标题行应包含标题本身……
			expect(title).toContain("Subagent Result");
			// ……且同一行还包含操作提示（当前提示在 footer，不同行 → 红）
			expect(title).toMatch(HINT_PATTERN);
		});

		it("操作提示不应残留在底部 footer 行（footer 删除 → 红）", async () => {
			const viewer = await openShortViewer("hint-footer-removed");

			// 渲染结构：[顶部边框, 标题, body..., footer, 底部边框]
			// 底部边框前的最后一行内容（当前是 footer 提示行）
			const lines = renderedLines(viewer);
			const lastContentLine = lines[lines.length - 2] ?? "";

			// 当前 footer 行含提示关键词 → 红
			expect(lastContentLine).not.toMatch(HINT_PATTERN);
		});
	});
});
