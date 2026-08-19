/**
 * Red-phase tests for cancel/shutdown envelope body differentiation
 * and /subagent-result "no output" vs "no record" distinction.
 *
 * These tests verify the current implementation does NOT properly differentiate
 * between user cancel and shutdown in envelope body text, and that /subagent-result
 * misleadingly shows "无此任务记录" when a session file exists but has no assistant text.
 *
 * Expected: ALL tests should FAIL until the fixes are implemented.
 */

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn } from "node:child_process";
import extension, { taskRegistry } from "../src/index.ts";
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

const ENV_KEYS = [
	"PI_SUBAGENT_DEPTH",
	"PI_SUBAGENT_HARD_TIMEOUT_MS",
	"PI_SUBAGENT_ACTIVITY_TIMEOUT_MS",
	"PI_CURRENT_AGENT_NAME",
	"PI_CAN_DELEGATE",
];

type ExecuteFn = (
	toolCallId: string,
	params: Record<string, unknown>,
	signal: AbortSignal | undefined,
	onUpdate: unknown,
	ctx: unknown,
) => Promise<any>;

/**
 * Create a fake ChildProcess whose kill() is a no-op.
 */
function createControllableProc() {
	const proc = new EventEmitter() as any;
	proc.stdout = new EventEmitter();
	proc.stderr = new EventEmitter();
	proc.kill = vi.fn(() => true);
	proc.exitCode = null;
	proc.signalCode = null;
	return proc;
}

/**
 * Helper: manually end the process so the result promise resolves.
 */
function endProcess(proc: any, exitCode = 0, signal: string | null = null) {
	proc.stdout.emit("end");
	proc.emit("exit", signal ? null : exitCode, signal);
	proc.emit("close", signal ? null : exitCode, signal);
}

/**
 * Build a mock pi object that captures all registration calls.
 */
function createMockPi() {
	const toolDefs: any[] = [];
	const commandDefs: Map<string, any> = new Map();
	const eventHandlers: Map<string, Function[]> = new Map();
	const sendMessageCalls: any[] = [];

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
		sendMessage: vi.fn((...args: any[]) => {
			sendMessageCalls.push(args);
		}),
		// Test helpers
		_toolDefs: toolDefs,
		_commandDefs: commandDefs,
		_eventHandlers: eventHandlers,
		_sendMessageCalls: sendMessageCalls,
	};
}

/**
 * Create a mock ctx with proper structure for TUI mode.
 */
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

/**
 * Helper: race execute() against a timeout to detect immediate returns.
 */
async function raceWithTimeout<T>(
	promise: Promise<T>,
	timeoutMs = 200,
): Promise<{ result: T | null; timedOut: boolean }> {
	vi.useRealTimers();
	try {
		const timeout = new Promise<null>((resolve) => setTimeout(() => resolve(null), timeoutMs));
		const result = await Promise.race([promise, timeout]);
		return { result, timedOut: result === null };
	} finally {
		vi.useFakeTimers();
	}
}

/** Write a JSONL session file with the given messages array. */
function writeSessionFile(sessionDir: string, taskId: string, messages: object[]): string {
	fs.mkdirSync(sessionDir, { recursive: true });
	const filePath = path.join(sessionDir, `1700000000000_${taskId}.jsonl`);
	const content = messages.map((m) => JSON.stringify(m)).join("\n") + "\n";
	fs.writeFileSync(filePath, content, "utf-8");
	return filePath;
}

/** Set env vars to safe defaults for dispatch tests. */
function setSafeEnvForDispatch() {
	process.env.PI_SUBAGENT_DEPTH = "0";
	delete process.env.PI_CURRENT_AGENT_NAME;
	delete process.env.PI_CAN_DELEGATE;
	delete process.env.PI_SUBAGENT_HARD_TIMEOUT_MS;
	delete process.env.PI_SUBAGENT_ACTIVITY_TIMEOUT_MS;
}

describe("取消/关闭信封正文区分 & /subagent-result 无输出提示 — 红阶段测试", () => {
	let tmpBase: string;
	let agentDir: string;
	let defaultCwd: string;
	let savedEnv: Record<string, string | undefined>;
	let procRef: ReturnType<typeof createControllableProc> | null;
	let allProcs: ReturnType<typeof createControllableProc>[];

	beforeEach(() => {
		vi.useFakeTimers();
		taskRegistry.clear();

		tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "subagent-cancel-shutdown-test-"));
		agentDir = path.join(tmpBase, "agent-dir");
		defaultCwd = path.join(tmpBase, "default-cwd");
		fs.mkdirSync(path.join(defaultCwd, ".pi", "agents"), { recursive: true });
		fs.mkdirSync(agentDir, { recursive: true });
		vi.mocked(getAgentDir).mockReturnValue(agentDir);

		fs.writeFileSync(
			path.join(defaultCwd, ".pi", "agents", "tester.md"),
			`---\nname: tester\ndescription: Test agent\n---\n`,
			"utf-8",
		);

		procRef = null;
		allProcs = [];
		vi.mocked(spawn).mockImplementation((() => {
			const proc = createControllableProc();
			procRef = proc;
			allProcs.push(proc);
			return proc;
		}) as any);

		savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
		setSafeEnvForDispatch();
	});

	afterEach(() => {
		for (const key of ENV_KEYS) {
			if (savedEnv[key] === undefined) delete process.env[key];
			else process.env[key] = savedEnv[key];
		}
		taskRegistry.clear();
		fs.rmSync(tmpBase, { recursive: true, force: true });
		vi.clearAllMocks();
		vi.useRealTimers();
	});

	function setupExtension() {
		const pi = createMockPi();
		extension(pi as any);
		const executeTool = pi._toolDefs[0].execute as ExecuteFn;
		return { pi, executeTool };
	}

	// ================================================================
	// 1. Cancel envelope body should contain user-cancel semantics
	// ================================================================
	describe("用户取消信封正文应包含用户语义", () => {
		it('用户取消后信封正文应包含「用户」和「取消」语义（或 /subagent-cancel）', async () => {
			const { pi, executeTool } = setupExtension();
			const ctx = createMockTuiCtx(defaultCwd);

			// Dispatch a task
			const executePromise = executeTool(
				"call-1",
				{ agent: "tester", task: "test task", sessionId: "019ffdd3-3eb5-733d-b481-a53e5292bd80" },
				undefined,
				undefined,
				ctx,
			);
			await raceWithTimeout(executePromise, 200);

			// Cancel the task via /subagent-cancel
			const cancelCommand = pi._commandDefs.get("subagent-cancel");
			expect(cancelCommand).toBeDefined();
			await cancelCommand.handler("019ffdd3-3eb5-733d-b481-a53e5292bd80", { ui: { notify: vi.fn() } });

			// End the process
			endProcess(allProcs[0], null, "SIGTERM");
			await vi.advanceTimersByTimeAsync(1000);

			// Verify sendMessage was called with the envelope
			expect(pi.sendMessage).toHaveBeenCalled();
			const [message] = pi._sendMessageCalls[0];
			const envelopeContent: string = message.content;

			// Red phase: envelope body should contain user-cancel semantics
			// Expected: "用户" and "取消" (or "/subagent-cancel")
			// Current: "任务已被中止，未产生输出。" (no user semantics)
			expect(envelopeContent).toMatch(/user.*cancel|cancel.*user|\/subagent-cancel/i);
		});

		it('用户取消后信封正文不应只有笼统的「任务已被中止」', async () => {
			const { pi, executeTool } = setupExtension();
			const ctx = createMockTuiCtx(defaultCwd);

			const executePromise = executeTool(
				"call-1",
				{ agent: "tester", task: "test task", sessionId: "019ffdd3-3eb5-733d-b481-a53e5292bd81" },
				undefined,
				undefined,
				ctx,
			);
			await raceWithTimeout(executePromise, 200);

			// Cancel the task
			const cancelCommand = pi._commandDefs.get("subagent-cancel");
			await cancelCommand.handler("019ffdd3-3eb5-733d-b481-a53e5292bd81", { ui: { notify: vi.fn() } });

			endProcess(allProcs[0], null, "SIGTERM");
			await vi.advanceTimersByTimeAsync(1000);

			expect(pi.sendMessage).toHaveBeenCalled();
			const [message] = pi._sendMessageCalls[0];
			const envelopeContent: string = message.content;

			// Red phase: should NOT have ONLY the generic message
			// It should have user-cancel semantics instead
			const hasGenericMessage = envelopeContent.includes("no output");
			const hasUserCancelSemantics = /user.*cancel|cancel.*user|\/subagent-cancel/i.test(envelopeContent);

			// If it has the generic message, it MUST also have user-cancel semantics
			// (or better: should NOT have the generic message at all)
			if (hasGenericMessage) {
				expect(hasUserCancelSemantics).toBe(true);
			}
		});
	});

	// ================================================================
	// 2. Shutdown envelope body should contain session-shutdown semantics
	// ================================================================
	describe("会话关闭信封正文应包含会话语义", () => {
		it('shutdown 后信封正文（body）应包含「会话」类文案（与用户取消区分）', async () => {
			const { pi, executeTool } = setupExtension();
			const ctx = createMockTuiCtx(defaultCwd);

			// Dispatch a task
			const executePromise = executeTool(
				"call-1",
				{ agent: "tester", task: "test task", sessionId: "019ffdd3-3eb5-733d-b481-a53e5292bd82" },
				undefined,
				undefined,
				ctx,
			);
			await raceWithTimeout(executePromise, 200);

			// Trigger session_shutdown
			const shutdownHandlers = pi._eventHandlers.get("session_shutdown");
			expect(shutdownHandlers).toBeDefined();
			await shutdownHandlers![0]({ type: "session_shutdown" });

			// End the process
			endProcess(allProcs[0], null, "SIGTERM");
			await vi.advanceTimersByTimeAsync(1000);

			// Verify sendMessage was called
			expect(pi.sendMessage).toHaveBeenCalled();
			const [message] = pi._sendMessageCalls[0];
			const envelopeContent: string = message.content;

			// Extract the BODY text (after "---" separator, before any metadata)
			// The envelope format is:
			// ## [subagent-result] ...
			// - 状态: ...
			// - 任务: ...
			// ...
			// ---
			// <BODY TEXT HERE>
			const bodyMatch = envelopeContent.match(/---\s*\n(.+)/s);
			const bodyText = bodyMatch ? bodyMatch[1].trim() : "";

			// Red phase: BODY text should contain session-shutdown semantics
			// Expected: "会话已关闭" or "会话被终止" or similar
			// Current: "任务已被中止，未产生输出。" (same as user cancel - no distinction)
			// Note: The envelope has "- 会话: taskId" metadata line, but we're checking
			// the BODY text after "---", not the metadata lines
			expect(bodyText).toMatch(/session/i);
		});

		it("shutdown 信封正文（body）应与用户取消信封正文不同", async () => {
			const { pi, executeTool } = setupExtension();
			const ctx = createMockTuiCtx(defaultCwd);

			// Helper to extract body text from envelope
			const extractBody = (envelopeContent: string): string => {
				const bodyMatch = envelopeContent.match(/---\s*\n(.+)/s);
				return bodyMatch ? bodyMatch[1].trim() : "";
			};

			// First: user cancel scenario
			const cancelPromise = executeTool(
				"call-1",
				{ agent: "tester", task: "test task", sessionId: "019ffdd3-3eb5-733d-b481-a53e5292bd83" },
				undefined,
				undefined,
				ctx,
			);
			await raceWithTimeout(cancelPromise, 200);

			const cancelCommand = pi._commandDefs.get("subagent-cancel");
			await cancelCommand.handler("019ffdd3-3eb5-733d-b481-a53e5292bd83", { ui: { notify: vi.fn() } });
			endProcess(allProcs[0], null, "SIGTERM");
			await vi.advanceTimersByTimeAsync(1000);

			const cancelBodyText = extractBody(pi._sendMessageCalls[0][0].content);

			// Reset for shutdown scenario
			taskRegistry.clear();
			pi._sendMessageCalls.length = 0;
			vi.mocked(spawn).mockClear();
			allProcs = [];
			vi.mocked(spawn).mockImplementation((() => {
				const proc = createControllableProc();
				procRef = proc;
				allProcs.push(proc);
				return proc;
			}) as any);

			// Second: shutdown scenario
			const shutdownPromise = executeTool(
				"call-2",
				{ agent: "tester", task: "test task", sessionId: "019ffdd3-3eb5-733d-b481-a53e5292bd84" },
				undefined,
				undefined,
				ctx,
			);
			await raceWithTimeout(shutdownPromise, 200);

			const shutdownHandlers = pi._eventHandlers.get("session_shutdown");
			await shutdownHandlers![0]({ type: "session_shutdown" });
			endProcess(allProcs[0], null, "SIGTERM");
			await vi.advanceTimersByTimeAsync(1000);

			const shutdownBodyText = extractBody(pi._sendMessageCalls[0][0].content);

			// Red phase: cancel and shutdown envelope BODY text should be DIFFERENT
			// Current: both use "任务已被中止，未产生输出。" (identical - no distinction)
			// We're comparing only the body text after "---", not the entire envelope
			expect(cancelBodyText).not.toBe(shutdownBodyText);
		});
	});

	// ================================================================
	// 3. promptGuidelines should include cancel discipline
	// ================================================================
	describe("promptGuidelines 应包含取消纪律", () => {
		it("工具定义的 promptGuidelines 应包含取消相关条目", () => {
			const { pi } = setupExtension();

			expect(pi._toolDefs.length).toBeGreaterThan(0);
			const toolDef = pi._toolDefs[0];
			expect(toolDef.promptGuidelines).toBeDefined();
			expect(Array.isArray(toolDef.promptGuidelines)).toBe(true);

			// Red phase: promptGuidelines should contain a cancel-related entry
			// Expected: mentions "取消" (cancel) and "用户" (user) and "重试" (retry)
			// Current: no cancel discipline in promptGuidelines
			const hasCancelGuideline = toolDef.promptGuidelines.some((g: string) =>
				/cancel/i.test(g) && /user/i.test(g)
			);

			expect(hasCancelGuideline).toBe(true);
		});

		it("取消纪律应明确：已取消=用户主动操作，不要自动重试/重新派发前询问用户", () => {
			const { pi } = setupExtension();
			const toolDef = pi._toolDefs[0];

			// Red phase: should have a guideline that says cancelled tasks should not
			// be automatically retried without asking the user first
			const hasNoAutoRetryGuideline = toolDef.promptGuidelines.some((g: string) =>
				/cancel/i.test(g) && /retry|re-dispatch|redispatch|ask/i.test(g)
			);

			expect(hasNoAutoRetryGuideline).toBe(true);
		});
	});

	// ================================================================
	// 4. /subagent-result should distinguish "no record" vs "no output"
	// ================================================================
	describe("/subagent-result 应区分无记录与无最终输出", () => {
		it('session 文件存在但无 assistant 文本 → 应提示「无最终输出」（非「无此任务记录」）', async () => {
			const { pi } = setupExtension();
			const commandDef = pi._commandDefs.get("subagent-result");
			expect(commandDef).toBeDefined();

			const taskId = "killed-task-no-output";
			const sessionDir = path.join(agentDir, "subagent-sessions", taskId);

			// Write a session file with NO assistant text (only toolResult/thinking)
			writeSessionFile(sessionDir, taskId, [
				{
					type: "message",
					message: {
						role: "user",
						content: [{ type: "text", text: "Do something" }],
					},
				},
				{
					type: "message",
					message: {
						role: "assistant",
						content: [
							{ type: "tool_use", name: "some_tool", input: { param: "value" } },
						],
					},
				},
				{
					type: "tool_result",
					tool_use_id: "toolu_123",
					content: [{ type: "text", text: "Tool output" }],
				},
			]);

			const notifyMock = vi.fn();
			const ctx = { ui: { notify: notifyMock, custom: vi.fn() } };

			await commandDef.handler(taskId, ctx);

			// Red phase: should show "无最终输出" (no final output) with session path
			// Current: shows "无此任务记录" (no record) - misleading!
			const notifyOutput = notifyMock.mock.calls.map((c) => String(c[0])).join("");

			// Should indicate "no output" (not "no record")
			expect(notifyOutput).toMatch(/no final output|no.*output/i);

			// Should NOT say "无此任务记录" (that's for missing sessions)
			expect(notifyOutput).not.toMatch(/No task record for|no.*record/i);
		});

		it('session 文件存在但无 assistant 文本 → 提示应包含完整 session 文件路径', async () => {
			const { pi } = setupExtension();
			const commandDef = pi._commandDefs.get("subagent-result");
			expect(commandDef).toBeDefined();

			const taskId = "killed-task-with-path";
			const sessionDir = path.join(agentDir, "subagent-sessions", taskId);

			// Write a session file with only thinking (no assistant text)
			writeSessionFile(sessionDir, taskId, [
				{
					type: "message",
					message: {
						role: "assistant",
						content: [{ type: "thinking", thinking: "Let me think..." }],
					},
				},
			]);

			const notifyMock = vi.fn();
			const ctx = { ui: { notify: notifyMock, custom: vi.fn() } };

			await commandDef.handler(taskId, ctx);

			// Red phase: should include the FULL session file path in the message
			const notifyOutput = notifyMock.mock.calls.map((c) => String(c[0])).join("");

			// Should mention the actual file path (not just taskId)
			// The path should contain "subagent-sessions" and the taskId
			expect(notifyOutput).toMatch(/subagent-sessions.*killed-task-with-path|killed-task-with-path.*subagent-sessions/i);
		});

		it('不存在的 taskId → 仍应输出「无此任务记录」（回归锁定）', async () => {
			const { pi } = setupExtension();
			const commandDef = pi._commandDefs.get("subagent-result");
			expect(commandDef).toBeDefined();

			const notifyMock = vi.fn();
			const ctx = { ui: { notify: notifyMock, custom: vi.fn() } };

			await commandDef.handler("completely-nonexistent-task-id", ctx);

			// This should remain green: truly non-existent tasks should say "no record"
			const notifyOutput = notifyMock.mock.calls.map((c) => String(c[0])).join("");

			expect(notifyOutput).toMatch(/No task record for|no.*record|not.*found/i);
		});
	});
});

describe("插件提示词资源冲突纪律 — 红阶段测试", () => {
	it("subagent 工具 promptGuidelines 应包含资源冲突纪律", () => {
		const pi = createMockPi();
		extension(pi as any);

		expect(pi._toolDefs.length).toBeGreaterThan(0);
		const subagentTool = pi._toolDefs[0];
		expect(subagentTool.promptGuidelines).toBeDefined();
		expect(Array.isArray(subagentTool.promptGuidelines)).toBe(true);

		// Red phase: should contain resource conflict discipline
		// Expected: mentions "conflict" or "same files" or similar
		// Currently FAILS because no resource conflict guideline exists
		const hasResourceConflictGuideline = subagentTool.promptGuidelines.some((g: string) =>
			/conflict|same files|same code/i.test(g)
		);

		expect(hasResourceConflictGuideline).toBe(true);
	});

	it("subagent 工具应明确提示并行派发前检查任务是否操作同一文件/代码区域", () => {
		const pi = createMockPi();
		extension(pi as any);

		const subagentTool = pi._toolDefs[0];

		// Red phase: should explicitly mention checking for file/code region conflicts
		// before parallel dispatch
		// Expected: something like "check if tasks operate on same files/code regions"
		// Currently FAILS because no such guideline exists
		const hasFileCheckGuideline = subagentTool.promptGuidelines.some((g: string) =>
			/(check|verify|ensure).*(same|same files|same code)/i.test(g) ||
			/(parallel|concurrent).*(same|conflict)/i.test(g)
		);

		expect(hasFileCheckGuideline).toBe(true);
	});
});
