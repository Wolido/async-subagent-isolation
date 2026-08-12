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

/** Mock a TUI command ctx that captures handleInput for interactive testing. */
function createInteractiveViewerCtx() {
	const notifyMock = vi.fn();
	let component: any = null;
	const customMock = vi.fn(async (cb: any) => {
		const theme = { fg: (_c: string, s: string) => s, bold: (s: string) => s };
		component = cb(null, theme, null, () => {});
	});
	const ctx = { hasUI: true, mode: "tui" as const, ui: { notify: notifyMock, custom: customMock } };
	return {
		ctx,
		notifyMock,
		customMock,
		getComponent: () => component,
		getRendered: (width = 80) => component ? component.render(width).join("\n") : "",
		handleInput: (data: string) => component?.handleInput(data),
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

		it("多消息 JSONL 应只取最后一条 assistant 文本", async () => {
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
			// Should NOT contain the FIRST assistant text
			expect(getRendered()).not.toContain("First response");
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
});
