/**
 * Contract tests: subagent result observability & success-state semantics
 *
 * This change-set covers four approved items (N1-N4) plus additional
 * regression locks added during review (T1-T6). Assertions are written
 * against the desired behavior; tests that still expect implementation
 * fixes are marked (RED), and tests that already pass are marked as
 * regression locks (GREEN).
 *
 *   N1 · errorMessage must surface in the envelope body + details.errorMessage.
 *   N2 · succeeded requires (a) exitCode===0, (b) last assistant stopReason
 *        is a normal terminal state, (c) last assistant contains non-empty text.
 *   N3 · message_end(error) must not immediately kill/finalize; wait for
 *        agent_end{willRetry:false} or auto_retry_end{finalError}.
 *   N4 · stderr warning lines must never masquerade as the answer.
 *
 * Fixture conventions (same as sibling files):
 *   - tmpBase under os.tmpdir()
 *   - spawn/getAgentDir mocked
 *   - afterEach cleanup
 *   - no .only / .skip
 */

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn } from "node:child_process";
import extension, { taskRegistry, buildResultEnvelope, STATUS_WORDS } from "../src/index.ts";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

/* ─── Mocks ─────────────────────────────────────────────────────── */

vi.mock("@earendil-works/pi-coding-agent", async () => {
	const actual = await vi.importActual("@earendil-works/pi-coding-agent");
	return {
		...actual,
		getAgentDir: vi.fn(),
	};
});

vi.mock("node:child_process", () => ({
	spawn: vi.fn<typeof spawn>(),
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

/* ─── Helpers ───────────────────────────────────────────────────── */

function createControllableProc() {
	const proc = new EventEmitter() as any;
	proc.stdout = new EventEmitter();
	proc.stderr = new EventEmitter();
	proc.kill = vi.fn(() => true);
	proc.exitCode = null;
	proc.signalCode = null;
	return proc;
}

function endProcess(proc: any, exitCode = 0, signal: string | null = null) {
	proc.stdout.emit("end");
	proc.emit("exit", signal ? null : exitCode, signal);
	proc.emit("close", signal ? null : exitCode, signal);
}

function createMockPi() {
	const toolDefs: any[] = [];
	const sendMessageCalls: any[] = [];
	const messageRenderers: Map<string, Function> = new Map();
	return {
		registerTool: vi.fn((tool: any) => toolDefs.push(tool)),
		registerCommand: vi.fn(),
		registerMessageRenderer: vi.fn((type: string, renderer: Function) => messageRenderers.set(type, renderer)),
		on: vi.fn(),
		sendMessage: vi.fn((...args: any[]) => sendMessageCalls.push(args)),
		_toolDefs: toolDefs,
		_sendMessageCalls: sendMessageCalls,
		_messageRenderers: messageRenderers,
	};
}

/** Plain-text theme for renderResult tests. */
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

function createTuiCtx(cwd: string) {
	return {
		cwd,
		hasUI: true,
		mode: "tui" as const,
		ui: { setWidget: vi.fn(), confirm: vi.fn().mockResolvedValue(true) },
	};
}

function createSyncCtx(cwd: string) {
	return { cwd, hasUI: false };
}

/**
 * Production-side constant that should be exported by src/index.ts.
 * Test side mirrors it as a literal so the RED contract is explicit.
 */
const ERROR_MESSAGE_MAX_CHARS = 2000;

function writeAgentFile(cwd: string) {
	fs.mkdirSync(path.join(cwd, ".pi", "agents"), { recursive: true });
	fs.writeFileSync(
		path.join(cwd, ".pi", "agents", "tester.md"),
		"---\nname: tester\ndescription: Test agent\n---\n",
		"utf-8",
	);
}

async function raceWithTimeout<T>(promise: Promise<T>, timeoutMs = 200): Promise<{ result: T | null; timedOut: boolean }> {
	vi.useRealTimers();
	try {
		const timeout = new Promise<null>((resolve) => setTimeout(() => resolve(null), timeoutMs));
		const result = await Promise.race([promise, timeout]);
		return { result, timedOut: result === null };
	} finally {
		vi.useFakeTimers();
	}
}

function emitLine(proc: any, obj: unknown) {
	proc.stdout.emit("data", Buffer.from(JSON.stringify(obj) + "\n"));
}

/** Emit a message_end event carrying an assistant message. */
function emitMessageEnd(
	proc: any,
	{
		text,
		content,
		stopReason = "end_turn",
		errorMessage,
		usage = { input: 10, output: 5, totalTokens: 15 },
	}: {
		text?: string;
		content?: any[];
		stopReason?: string;
		errorMessage?: string;
		usage?: any;
	},
) {
	const message: any = {
		role: "assistant",
		content: content ?? (text !== undefined ? [{ type: "text", text }] : []),
		stopReason,
		usage,
	};
	if (errorMessage !== undefined) message.errorMessage = errorMessage;
	emitLine(proc, { type: "message_end", message });
}

/** Emit an agent_end event from the subagent runtime.
 *  Real shape (verified in pi-coding-agent core): { type: "agent_end", messages: AgentMessage[], willRetry: boolean }
 */
function emitAgentEnd(proc: any, { willRetry, messages = [] }: { willRetry: boolean; messages?: any[] }) {
	emitLine(proc, { type: "agent_end", messages, willRetry });
}

/** Emit an auto_retry_start event.
 *  Real shape: { type: "auto_retry_start", attempt: number, maxAttempts: number, delayMs: number, errorMessage: string }
 */
function emitAutoRetryStart(
	proc: any,
	{
		attempt = 1,
		maxAttempts = 3,
		delayMs = 2000,
		errorMessage = "transient",
	}: { attempt?: number; maxAttempts?: number; delayMs?: number; errorMessage?: string } = {},
) {
	emitLine(proc, { type: "auto_retry_start", attempt, maxAttempts, delayMs, errorMessage });
}

/** Emit an auto_retry_end event.
 *  Real shape: { type: "auto_retry_end", success: boolean, attempt: number, finalError?: string }
 */
function emitAutoRetryEnd(
	proc: any,
	payload: { success: true; attempt?: number } | { finalError: string; attempt?: number },
) {
	const attempt = payload.attempt ?? 1;
	if ("finalError" in payload) {
		emitLine(proc, { type: "auto_retry_end", success: false, attempt, finalError: payload.finalError });
	} else {
		emitLine(proc, { type: "auto_retry_end", success: true, attempt });
	}
}

function extractInFlightBlock(content: string): string {
	const m = content.match(/- Session:[^\n]*\n+([\s\S]*?)\n+---/);
	return m ? m[1] : "";
}

/* ─── Test suite ────────────────────────────────────────────────── */

describe("result observability & state semantics (N1-N4)", () => {
	let tmpBase: string;
	let agentDir: string;
	let defaultCwd: string;
	let savedEnv: Record<string, string | undefined>;
	let allProcs: ReturnType<typeof createControllableProc>[];

	beforeEach(() => {
		vi.useFakeTimers();
		taskRegistry.clear();

		tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "result-obs-test-"));
		agentDir = path.join(tmpBase, "agent-dir");
		defaultCwd = path.join(tmpBase, "default-cwd");
		writeAgentFile(defaultCwd);
		fs.mkdirSync(agentDir, { recursive: true });
		vi.mocked(getAgentDir).mockReturnValue(agentDir);

		allProcs = [];
		vi.mocked(spawn).mockImplementation((() => {
			const proc = createControllableProc();
			allProcs.push(proc);
			return proc;
		}) as any);

		savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
		process.env.PI_SUBAGENT_DEPTH = "0";
		delete process.env.PI_CURRENT_AGENT_NAME;
		delete process.env.PI_CAN_DELEGATE;
		delete process.env.PI_SUBAGENT_HARD_TIMEOUT_MS;
		delete process.env.PI_SUBAGENT_ACTIVITY_TIMEOUT_MS;
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
		const toolsByName = new Map(pi._toolDefs.map((t: any) => [t.name, t] as const));
		const executeSubagentTool = toolsByName.get("subagent")?.execute as ExecuteFn | undefined;
		return { pi, executeSubagentTool, toolsByName };
	}

	async function dispatchTuiTask(executeSubagentTool: ExecuteFn, sessionId: string) {
		const ctx = createTuiCtx(defaultCwd);
		const promise = executeSubagentTool("call-1", { agent: "tester", task: "test task", sessionId }, undefined, undefined, ctx);
		const { timedOut } = await raceWithTimeout(promise, 200);
		expect(timedOut, "TUI dispatch must return immediately with a receipt").toBe(false);
		return ctx;
	}

	function runSyncTask(executeSubagentTool: ExecuteFn) {
		const ctx = createSyncCtx(defaultCwd);
		return executeSubagentTool("call-1", { agent: "tester", task: "test task", sessionId: "019ffdd3-3eb5-733d-b481-a53e5292bd01" }, undefined, undefined, ctx);
	}

	function getLastEnvelope(pi: ReturnType<typeof createMockPi>) {
		expect(pi.sendMessage).toHaveBeenCalled();
		const [message] = pi._sendMessageCalls[pi._sendMessageCalls.length - 1];
		return message;
	}

	/* ═══════════════════════════════════════════════════════════════
	 * N1 · errorMessage must be visible in the envelope
	 * ═══════════════════════════════════════════════════════════════ */
	describe("N1 · errorMessage exposure", () => {
		it("should expose result.errorMessage in the envelope body for message_end(error) (RED)", async () => {
			const { pi, executeSubagentTool } = setupExtension();
			await dispatchTuiTask(executeSubagentTool!, "019ffdd3-3eb5-733d-b481-a53e5292bd02");
			const errorMsg = "429 {\"type\":\"rate_limit_error\",\"message\":\"The engine is currently overloaded\"}";

			emitMessageEnd(allProcs[0], { content: [], stopReason: "error", errorMessage: errorMsg });
			await vi.advanceTimersByTimeAsync(0);
			endProcess(allProcs[0], 0);
			await vi.advanceTimersByTimeAsync(1000);

			const message = getLastEnvelope(pi);
			expect(message.details.status).toBe(STATUS_WORDS.failure);
			expect(message.content).toContain(errorMsg);
			expect(message.details.errorMessage).toBe(errorMsg);
			expect(message.details.output).toBe("");
		});

		it("should expose result.errorMessage in the envelope body for auto_retry_end{finalError} (RED)", async () => {
			const { pi, executeSubagentTool } = setupExtension();
			await dispatchTuiTask(executeSubagentTool!, "019ffdd3-3eb5-733d-b481-a53e5292bd03");
			const finalError = "after 3 retries the upstream still returned 503";

			emitMessageEnd(allProcs[0], { content: [], stopReason: "error", errorMessage: "transient 429" });
			await vi.advanceTimersByTimeAsync(0);
			emitAutoRetryEnd(allProcs[0], { finalError });
			await vi.advanceTimersByTimeAsync(0);
			endProcess(allProcs[0], 0);
			await vi.advanceTimersByTimeAsync(1000);

			const message = getLastEnvelope(pi);
			expect(message.details.status).toBe(STATUS_WORDS.failure);
			expect(message.content).toContain(finalError);
			expect(message.details.errorMessage).toBe(finalError);
			expect(message.details.output).toBe("");
		});

		it("should truncate an over-long errorMessage from message_end(error) (RED)", async () => {
			const { pi, executeSubagentTool } = setupExtension();
			await dispatchTuiTask(executeSubagentTool!, "019ffdd3-3eb5-733d-b481-a53e5292bd04");
			const errorMsg = "upstream error: " + "x".repeat(5000);

			emitMessageEnd(allProcs[0], { content: [], stopReason: "error", errorMessage: errorMsg });
			await vi.advanceTimersByTimeAsync(0);
			endProcess(allProcs[0], 0);
			await vi.advanceTimersByTimeAsync(1000);

			const message = getLastEnvelope(pi);
			expect(message.details.status).toBe(STATUS_WORDS.failure);

			// (a) The full 5000-char run must not survive in either place.
			expect(message.content).not.toMatch(/x{2000,}/);
			expect((message.details.errorMessage ?? "")).not.toMatch(/x{2000,}/);

			// (b) details.errorMessage is capped near the production constant.
			expect(message.details.errorMessage?.length ?? 0).toBeLessThanOrEqual(ERROR_MESSAGE_MAX_CHARS + 64);

			// (c) Prefix is preserved so the error remains identifiable.
			expect(message.content).toContain(errorMsg.slice(0, 100));
			expect(message.details.errorMessage).toContain(errorMsg.slice(0, 100));

			// (d) Truncation marker is mandatory.
			expect(message.content).toMatch(/…?\[truncated\]|… \(truncated\)|\(truncated\)|\.\.\. \(/i);
			expect(message.details.errorMessage).toMatch(/…?\[truncated\]|… \(truncated\)|\(truncated\)|\.\.\. \(/i);
		});

		it("should truncate an over-long finalError from auto_retry_end{finalError} (RED)", async () => {
			const { pi, executeSubagentTool } = setupExtension();
			await dispatchTuiTask(executeSubagentTool!, "019ffdd3-3eb5-733d-b481-a53e5292bd06");
			const finalError = "retries exhausted: " + "x".repeat(5000);

			emitMessageEnd(allProcs[0], { content: [], stopReason: "error", errorMessage: "transient" });
			await vi.advanceTimersByTimeAsync(0);
			emitAutoRetryEnd(allProcs[0], { finalError });
			await vi.advanceTimersByTimeAsync(0);
			endProcess(allProcs[0], 0);
			await vi.advanceTimersByTimeAsync(1000);

			const message = getLastEnvelope(pi);
			expect(message.details.status).toBe(STATUS_WORDS.failure);
			expect(message.content).not.toMatch(/x{2000,}/);
			expect((message.details.errorMessage ?? "")).not.toMatch(/x{2000,}/);
			expect(message.details.errorMessage?.length ?? 0).toBeLessThanOrEqual(ERROR_MESSAGE_MAX_CHARS + 64);
			expect(message.content).toContain(finalError.slice(0, 100));
			expect(message.details.errorMessage).toContain(finalError.slice(0, 100));
			expect(message.content).toMatch(/…?\[truncated\]|… \(truncated\)|\(truncated\)|\.\.\. \(/i);
			expect(message.details.errorMessage).toMatch(/…?\[truncated\]|… \(truncated\)|\(truncated\)|\.\.\. \(/i);
		});

		it("should place errorMessage in the meta-info area without breaking the in-flight block (RED)", async () => {
			const { pi, executeSubagentTool } = setupExtension();
			await dispatchTuiTask(executeSubagentTool!, "019ffdd3-3eb5-733d-b481-a53e5292bd05");
			const errorMsg = "structured error payload";

			emitMessageEnd(allProcs[0], { content: [], stopReason: "error", errorMessage: errorMsg });
			await vi.advanceTimersByTimeAsync(0);
			endProcess(allProcs[0], 0);
			await vi.advanceTimersByTimeAsync(1000);

			const content: string = getLastEnvelope(pi).content;
			const block = extractInFlightBlock(content);
			expect(block).not.toContain(errorMsg);
			// errorMessage must appear before the "---" separator (i.e. in meta-info).
			const separatorIndex = content.indexOf("\n---\n");
			const errorIndex = content.indexOf(errorMsg);
			expect(errorIndex).toBeGreaterThanOrEqual(0);
			expect(errorIndex).toBeLessThan(separatorIndex);
			expect(getLastEnvelope(pi).details.output).toBe("");
		});
	});

	/* ═══════════════════════════════════════════════════════════════
	 * N2 · success three-layer criteria
	 * ═══════════════════════════════════════════════════════════════ */
	describe("N2 · success three-layer criteria", () => {
		it("should mark succeeded when exitCode=0, stopReason=end_turn and last assistant has text (GREEN regression lock)", async () => {
			const { pi, executeSubagentTool } = setupExtension();
			await dispatchTuiTask(executeSubagentTool!, "019ffdd3-3eb5-733d-b481-a53e5292bd10");

			emitMessageEnd(allProcs[0], { text: "final answer" });
			await vi.advanceTimersByTimeAsync(0);
			endProcess(allProcs[0], 0);
			await vi.advanceTimersByTimeAsync(1000);

			const message = getLastEnvelope(pi);
			expect(message.details.status).toBe(STATUS_WORDS.success);
			expect(message.content).toContain("final answer");
			expect(message.details.output).toBe("final answer");
		});

		it("should mark failed when exitCode=0 but last assistant stopReason is length (RED)", async () => {
			const { pi, executeSubagentTool } = setupExtension();
			await dispatchTuiTask(executeSubagentTool!, "019ffdd3-3eb5-733d-b481-a53e5292bd11");

			emitMessageEnd(allProcs[0], { text: "truncated", stopReason: "length" });
			await vi.advanceTimersByTimeAsync(0);
			endProcess(allProcs[0], 0);
			await vi.advanceTimersByTimeAsync(1000);

			const message = getLastEnvelope(pi);
			expect(message.details.status).toBe(STATUS_WORDS.failure);
		});

		it("should mark failed when exitCode=0 but last assistant stopReason is deferred (RED)", async () => {
			const { pi, executeSubagentTool } = setupExtension();
			await dispatchTuiTask(executeSubagentTool!, "019ffdd3-3eb5-733d-b481-a53e5292bd12");

			emitMessageEnd(allProcs[0], { text: "deferred answer", stopReason: "deferred" });
			await vi.advanceTimersByTimeAsync(0);
			endProcess(allProcs[0], 0);
			await vi.advanceTimersByTimeAsync(1000);

			const message = getLastEnvelope(pi);
			expect(message.details.status).toBe(STATUS_WORDS.failure);
		});

		it("should mark failed when exitCode=0 but last assistant has only thinking, no text (morphology ②) (RED)", async () => {
			const { pi, executeSubagentTool } = setupExtension();
			await dispatchTuiTask(executeSubagentTool!, "019ffdd3-3eb5-733d-b481-a53e5292bd13");

			emitMessageEnd(allProcs[0], {
				content: [{ type: "thinking", thinking: "I should compute this..." }],
				stopReason: "stop",
			});
			await vi.advanceTimersByTimeAsync(0);
			endProcess(allProcs[0], 0);
			await vi.advanceTimersByTimeAsync(1000);

			const message = getLastEnvelope(pi);
			expect(message.details.status).toBe(STATUS_WORDS.failure);
			expect(message.details.output).toBe("");
		});

		it("should mark failed when exitCode=0 but no assistant message was ever emitted (RED)", async () => {
			const { pi, executeSubagentTool } = setupExtension();
			await dispatchTuiTask(executeSubagentTool!, "019ffdd3-3eb5-733d-b481-a53e5292bd14");

			endProcess(allProcs[0], 0);
			await vi.advanceTimersByTimeAsync(1000);

			const message = getLastEnvelope(pi);
			expect(message.details.status).toBe(STATUS_WORDS.failure);
		});

		it("should not use previous assistant text when final assistant is error+empty (morphology ①) (RED)", async () => {
			const { pi, executeSubagentTool } = setupExtension();
			await dispatchTuiTask(executeSubagentTool!, "019ffdd3-3eb5-733d-b481-a53e5292bd15");
			const staleText = "this was the previous turn's answer";
			const errorMsg = "429 rate limit";

			emitMessageEnd(allProcs[0], { text: staleText, stopReason: "end_turn" });
			await vi.advanceTimersByTimeAsync(0);
			emitMessageEnd(allProcs[0], { content: [], stopReason: "error", errorMessage: errorMsg });
			await vi.advanceTimersByTimeAsync(0);
			endProcess(allProcs[0], 0);
			await vi.advanceTimersByTimeAsync(1000);

			const message = getLastEnvelope(pi);
			expect(message.details.status).toBe(STATUS_WORDS.failure);
			expect(message.content).toContain(errorMsg);
			expect(message.content).not.toContain(staleText);
			expect(message.details.output).toBe("");
		});

		it("should treat sync-path exit 0 + no text as failure, not success (RED)", async () => {
			const { executeSubagentTool } = setupExtension();
			const promise = runSyncTask(executeSubagentTool!);
			await vi.advanceTimersByTimeAsync(0);

			endProcess(allProcs[0], 0);
			await vi.advanceTimersByTimeAsync(0);

			const result = await promise;
			expect(result.isError).toBe(true);
			expect(result.details.results[0].exitCode).toBe(0);
		});

		it("should keep details.output and envelope body coherent in success path (GREEN regression lock)", async () => {
			const { pi, executeSubagentTool } = setupExtension();
			await dispatchTuiTask(executeSubagentTool!, "019ffdd3-3eb5-733d-b481-a53e5292bd16");
			const text = "exactly this";

			emitMessageEnd(allProcs[0], { text });
			await vi.advanceTimersByTimeAsync(0);
			endProcess(allProcs[0], 0);
			await vi.advanceTimersByTimeAsync(1000);

			const message = getLastEnvelope(pi);
			expect(message.details.output).toBe(text);
			expect(message.content).toContain(text);
		});
	});

	/* ═══════════════════════════════════════════════════════════════
	 * N3 · do not preempt pi's retry; only terminal events finalize
	 * ═══════════════════════════════════════════════════════════════ */
	describe("N3 · retry-aware finalization", () => {
		it("message_end(error) must not kill or finalize immediately (RED)", async () => {
			const { pi, executeSubagentTool } = setupExtension();
			await dispatchTuiTask(executeSubagentTool!, "019ffdd3-3eb5-733d-b481-a53e5292bd20");

			emitMessageEnd(allProcs[0], { content: [], stopReason: "error", errorMessage: "transient" });
			await vi.advanceTimersByTimeAsync(0);

			expect(allProcs[0].kill).not.toHaveBeenCalled();
			expect(pi.sendMessage).not.toHaveBeenCalled();
		});

		it("should finalize failure on agent_end{willRetry:false} after message_end(error) (RED)", async () => {
			const { pi, executeSubagentTool } = setupExtension();
			await dispatchTuiTask(executeSubagentTool!, "019ffdd3-3eb5-733d-b481-a53e5292bd21");

			emitMessageEnd(allProcs[0], { content: [], stopReason: "error", errorMessage: "transient" });
			await vi.advanceTimersByTimeAsync(0);
			expect(allProcs[0].kill).not.toHaveBeenCalled();
			expect(pi.sendMessage).not.toHaveBeenCalled();

			emitAgentEnd(allProcs[0], { willRetry: false, messages: [] });
			await vi.advanceTimersByTimeAsync(0);
			endProcess(allProcs[0], 0);
			await vi.advanceTimersByTimeAsync(1000);

			const message = getLastEnvelope(pi);
			expect(message.details.status).toBe(STATUS_WORDS.failure);
			expect(allProcs[0].kill).toHaveBeenCalledTimes(1);
		});

		it("should finalize failure on auto_retry_end{finalError} after message_end(error) (RED)", async () => {
			const { pi, executeSubagentTool } = setupExtension();
			await dispatchTuiTask(executeSubagentTool!, "019ffdd3-3eb5-733d-b481-a53e5292bd22");
			const finalError = "retries exhausted";

			emitMessageEnd(allProcs[0], { content: [], stopReason: "error", errorMessage: "transient" });
			await vi.advanceTimersByTimeAsync(0);
			expect(allProcs[0].kill).not.toHaveBeenCalled();
			expect(pi.sendMessage).not.toHaveBeenCalled();

			emitAutoRetryEnd(allProcs[0], { finalError });
			await vi.advanceTimersByTimeAsync(0);
			endProcess(allProcs[0], 0);
			await vi.advanceTimersByTimeAsync(1000);

			const message = getLastEnvelope(pi);
			expect(message.details.status).toBe(STATUS_WORDS.failure);
			expect(message.details.errorMessage).toBe(finalError);
			expect(allProcs[0].kill).toHaveBeenCalledTimes(1);
		});

		it("auto_retry_start after message_end(error) must not finalize (RED)", async () => {
			const { pi, executeSubagentTool } = setupExtension();
			await dispatchTuiTask(executeSubagentTool!, "019ffdd3-3eb5-733d-b481-a53e5292bd23");

			emitMessageEnd(allProcs[0], { content: [], stopReason: "error", errorMessage: "transient" });
			await vi.advanceTimersByTimeAsync(0);
			expect(allProcs[0].kill).not.toHaveBeenCalled();
			expect(pi.sendMessage).not.toHaveBeenCalled();

			emitAutoRetryStart(allProcs[0]);
			await vi.advanceTimersByTimeAsync(0);

			expect(allProcs[0].kill).not.toHaveBeenCalled();
			expect(pi.sendMessage).not.toHaveBeenCalled();
		});

		it("agent_end{willRetry:true} after message_end(error) must not finalize (RED)", async () => {
			const { pi, executeSubagentTool } = setupExtension();
			await dispatchTuiTask(executeSubagentTool!, "019ffdd3-3eb5-733d-b481-a53e5292bd24");

			emitMessageEnd(allProcs[0], { content: [], stopReason: "error", errorMessage: "transient" });
			await vi.advanceTimersByTimeAsync(0);
			expect(allProcs[0].kill).not.toHaveBeenCalled();
			expect(pi.sendMessage).not.toHaveBeenCalled();

			emitAgentEnd(allProcs[0], { willRetry: true, messages: [] });
			await vi.advanceTimersByTimeAsync(0);

			expect(allProcs[0].kill).not.toHaveBeenCalled();
			expect(pi.sendMessage).not.toHaveBeenCalled();
		});

		it("agent_end{willRetry:false} after success finalizes success (GREEN regression lock)", async () => {
			const { pi, executeSubagentTool } = setupExtension();
			await dispatchTuiTask(executeSubagentTool!, "019ffdd3-3eb5-733d-b481-a53e5292bd27");

			emitMessageEnd(allProcs[0], { text: "done" });
			await vi.advanceTimersByTimeAsync(0);
			expect(pi.sendMessage).not.toHaveBeenCalled();

			emitAgentEnd(allProcs[0], { willRetry: false, messages: [] });
			await vi.advanceTimersByTimeAsync(0);
			endProcess(allProcs[0], 0);
			await vi.advanceTimersByTimeAsync(1000);

			const message = getLastEnvelope(pi);
			expect(message.details.status).toBe(STATUS_WORDS.success);
			expect(message.content).toContain("done");
		});

		it("auto_retry_end{success:true} followed by final text still succeeds (RED)", async () => {
			const { pi, executeSubagentTool } = setupExtension();
			await dispatchTuiTask(executeSubagentTool!, "019ffdd3-3eb5-733d-b481-a53e5292bd25");

			emitMessageEnd(allProcs[0], { content: [], stopReason: "error", errorMessage: "transient" });
			await vi.advanceTimersByTimeAsync(0);
			expect(allProcs[0].kill).not.toHaveBeenCalled();
			expect(pi.sendMessage).not.toHaveBeenCalled();

			emitAutoRetryEnd(allProcs[0], { success: true });
			await vi.advanceTimersByTimeAsync(0);
			expect(allProcs[0].kill).not.toHaveBeenCalled();
			expect(pi.sendMessage).not.toHaveBeenCalled();

			emitMessageEnd(allProcs[0], { text: "retry succeeded" });
			await vi.advanceTimersByTimeAsync(0);
			emitAgentEnd(allProcs[0], { willRetry: false, messages: [] });
			await vi.advanceTimersByTimeAsync(0);
			endProcess(allProcs[0], 0);
			await vi.advanceTimersByTimeAsync(1000);

			const message = getLastEnvelope(pi);
			expect(message.details.status).toBe(STATUS_WORDS.success);
			expect(message.content).toContain("retry succeeded");
		});

		it("activity_timeout must still fire after message_end(error) if the process goes silent (safety net) (RED)", async () => {
			process.env.PI_SUBAGENT_ACTIVITY_TIMEOUT_MS = "500";
			delete process.env.PI_SUBAGENT_HARD_TIMEOUT_MS;

			const { pi, executeSubagentTool } = setupExtension();
			await dispatchTuiTask(executeSubagentTool!, "019ffdd3-3eb5-733d-b481-a53e5292bd26");

			emitMessageEnd(allProcs[0], { content: [], stopReason: "error", errorMessage: "transient" });
			await vi.advanceTimersByTimeAsync(0);

			// Process stays silent after the error.
			await vi.advanceTimersByTimeAsync(600);

			const sigkillCalls = allProcs[0].kill.mock.calls.filter((call: any[]) => call[0] === "SIGKILL");
			expect(sigkillCalls.length).toBeGreaterThanOrEqual(1);

			endProcess(allProcs[0], 0);
			await vi.advanceTimersByTimeAsync(1000);

			const message = getLastEnvelope(pi);
			expect(message.details.status).toBe(STATUS_WORDS.timeout);
		});
	});

	/* ═══════════════════════════════════════════════════════════════
	 * T1 · async stderr fallback on failure without errorMessage/output
	 * ═══════════════════════════════════════════════════════════════ */
	describe("T1 · async stderr fallback on failure without errorMessage/output", () => {
		it("should include a - Stderr: tail in the envelope when failure has no errorMessage and no output (RED)", async () => {
			const { pi, executeSubagentTool } = setupExtension();
			await dispatchTuiTask(executeSubagentTool!, "019ffdd3-3eb5-733d-b481-a53e5292bd40");
			const fatal = "FATAL: cannot load configuration from /etc/pi/config.yaml";

			allProcs[0].stderr.emit("data", Buffer.from(fatal + "\n"));
			await vi.advanceTimersByTimeAsync(0);
			endProcess(allProcs[0], 1);
			await vi.advanceTimersByTimeAsync(1000);

			const message = getLastEnvelope(pi);
			expect(message.details.status).toBe(STATUS_WORDS.failure);
			expect(message.details.errorMessage).toBeUndefined();
			expect(message.details.output).toBe("");
			expect(message.content).toMatch(/- Stderr:/);
			expect(message.content).toContain(fatal);
		});

		it("should NOT append a - Stderr: line when an errorMessage is already present (RED)", async () => {
			const { pi, executeSubagentTool } = setupExtension();
			await dispatchTuiTask(executeSubagentTool!, "019ffdd3-3eb5-733d-b481-a53e5292bd41");
			const fatal = "FATAL: cannot load configuration";
			const errorMsg = "upstream returned 500";

			allProcs[0].stderr.emit("data", Buffer.from(fatal + "\n"));
			await vi.advanceTimersByTimeAsync(0);
			emitMessageEnd(allProcs[0], { content: [], stopReason: "error", errorMessage: errorMsg });
			await vi.advanceTimersByTimeAsync(0);
			endProcess(allProcs[0], 1);
			await vi.advanceTimersByTimeAsync(1000);

			const message = getLastEnvelope(pi);
			expect(message.details.status).toBe(STATUS_WORDS.failure);
			expect(message.details.errorMessage).toBe(errorMsg);
			expect(message.content).toContain(errorMsg);
			expect(message.content).not.toMatch(/- Stderr:/);
		});

		it("success envelope must not contain a - Stderr: line (GREEN regression lock)", async () => {
			const { pi, executeSubagentTool } = setupExtension();
			await dispatchTuiTask(executeSubagentTool!, "019ffdd3-3eb5-733d-b481-a53e5292bd42");

			emitMessageEnd(allProcs[0], { text: "all good" });
			await vi.advanceTimersByTimeAsync(0);
			emitAgentEnd(allProcs[0], { willRetry: false, messages: [] });
			await vi.advanceTimersByTimeAsync(0);
			endProcess(allProcs[0], 0);
			await vi.advanceTimersByTimeAsync(1000);

			const message = getLastEnvelope(pi);
			expect(message.details.status).toBe(STATUS_WORDS.success);
			expect(message.content).not.toMatch(/- Stderr:/);
		});
	});

	/* ═══════════════════════════════════════════════════════════════
	 * T2 · retry events must re-arm the activity timer
	 * ═══════════════════════════════════════════════════════════════ */
	describe("T2 · retry events must re-arm the activity timer", () => {
		it("agent_end{willRetry:true} after message_end(error) must re-arm activity timer (RED)", async () => {
			process.env.PI_SUBAGENT_ACTIVITY_TIMEOUT_MS = "500";
			delete process.env.PI_SUBAGENT_HARD_TIMEOUT_MS;

			const { pi, executeSubagentTool } = setupExtension();
			await dispatchTuiTask(executeSubagentTool!, "019ffdd3-3eb5-733d-b481-a53e5292bd43");

			emitMessageEnd(allProcs[0], { content: [], stopReason: "error", errorMessage: "transient" });
			await vi.advanceTimersByTimeAsync(0);
			await vi.advanceTimersByTimeAsync(600);

			emitAgentEnd(allProcs[0], { willRetry: true, messages: [] });
			await vi.advanceTimersByTimeAsync(0);
			await vi.advanceTimersByTimeAsync(600);

			emitMessageEnd(allProcs[0], { text: "recovered" });
			await vi.advanceTimersByTimeAsync(0);
			emitAgentEnd(allProcs[0], { willRetry: false, messages: [] });
			await vi.advanceTimersByTimeAsync(0);
			endProcess(allProcs[0], 0);
			await vi.advanceTimersByTimeAsync(1000);

			const message = getLastEnvelope(pi);
			expect(message.details.status).toBe(STATUS_WORDS.success);
			expect(message.content).toContain("recovered");
		});

		it("auto_retry_start after agent_end{willRetry:true} must re-arm activity timer (RED)", async () => {
			process.env.PI_SUBAGENT_ACTIVITY_TIMEOUT_MS = "500";
			delete process.env.PI_SUBAGENT_HARD_TIMEOUT_MS;

			const { pi, executeSubagentTool } = setupExtension();
			await dispatchTuiTask(executeSubagentTool!, "019ffdd3-3eb5-733d-b481-a53e5292bd44");

			emitMessageEnd(allProcs[0], { content: [], stopReason: "error", errorMessage: "transient" });
			await vi.advanceTimersByTimeAsync(0);
			emitAgentEnd(allProcs[0], { willRetry: true, messages: [] });
			await vi.advanceTimersByTimeAsync(0);
			await vi.advanceTimersByTimeAsync(600);

			emitAutoRetryStart(allProcs[0]);
			await vi.advanceTimersByTimeAsync(0);
			await vi.advanceTimersByTimeAsync(600);

			emitMessageEnd(allProcs[0], { text: "recovered" });
			await vi.advanceTimersByTimeAsync(0);
			emitAgentEnd(allProcs[0], { willRetry: false, messages: [] });
			await vi.advanceTimersByTimeAsync(0);
			endProcess(allProcs[0], 0);
			await vi.advanceTimersByTimeAsync(1000);

			const message = getLastEnvelope(pi);
			expect(message.details.status).toBe(STATUS_WORDS.success);
		});

		it("auto_retry_end after a retry must re-arm activity timer (RED)", async () => {
			process.env.PI_SUBAGENT_ACTIVITY_TIMEOUT_MS = "500";
			delete process.env.PI_SUBAGENT_HARD_TIMEOUT_MS;

			const { pi, executeSubagentTool } = setupExtension();
			await dispatchTuiTask(executeSubagentTool!, "019ffdd3-3eb5-733d-b481-a53e5292bd45");

			emitMessageEnd(allProcs[0], { content: [], stopReason: "error", errorMessage: "transient" });
			await vi.advanceTimersByTimeAsync(0);
			emitAgentEnd(allProcs[0], { willRetry: true, messages: [] });
			await vi.advanceTimersByTimeAsync(0);
			emitAutoRetryStart(allProcs[0]);
			await vi.advanceTimersByTimeAsync(0);
			await vi.advanceTimersByTimeAsync(600);

			emitAutoRetryEnd(allProcs[0], { success: true });
			await vi.advanceTimersByTimeAsync(0);
			await vi.advanceTimersByTimeAsync(600);

			emitMessageEnd(allProcs[0], { text: "recovered" });
			await vi.advanceTimersByTimeAsync(0);
			emitAgentEnd(allProcs[0], { willRetry: false, messages: [] });
			await vi.advanceTimersByTimeAsync(0);
			endProcess(allProcs[0], 0);
			await vi.advanceTimersByTimeAsync(1000);

			const message = getLastEnvelope(pi);
			expect(message.details.status).toBe(STATUS_WORDS.success);
		});
	});

	/* ═══════════════════════════════════════════════════════════════
	 * T3 · renderResult icon must match the actual failure status
	 * ═══════════════════════════════════════════════════════════════ */
	describe("T3 · renderResult icon matches failure status", () => {
		it("should render the error icon for stopReason=length even when exitCode=0 (RED)", async () => {
			const { pi } = setupExtension();
			const subagent = pi._toolDefs.find((t: any) => t.name === "subagent");
			expect(subagent?.renderResult).toBeDefined();
			const renderResult = subagent.renderResult;

			const result = {
				content: [{ type: "text", text: "truncated" }],
				details: {
					mode: "single",
					agentScope: "both",
					projectAgentsDir: null,
					results: [
						{
							agent: "tester",
							agentSource: "project",
							task: "render test",
							exitCode: 0,
							stopReason: "length",
							messages: [
								{
									role: "assistant",
									content: [{ type: "text", text: "truncated" }],
								},
							],
							stderr: "",
							usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 1 },
							phase: "idle",
							lastPhaseChange: 0,
							sessionId: "019ffdd3-3eb5-733d-b481-a53e5292bd50",
						},
					],
				},
			};

			const text = renderResult(result, { expanded: false }, createMockTheme(), { lastComponent: undefined }).render(80).join("\n");
			expect(text).toContain("✗");
			expect(text).not.toContain("✓");
			expect(text).toContain("[length]");
		});
	});

	/* ═══════════════════════════════════════════════════════════════
	 * T4 · N4 stderr warning: tighten assertion to Stderr: label
	 * ═══════════════════════════════════════════════════════════════ */
	describe("T4 · stderr warning must surface via - Stderr: label", () => {
		it("async stderr warning must appear under a - Stderr: label, not as the body (RED)", async () => {
			const { pi, executeSubagentTool } = setupExtension();
			const sessionId = "019ffdd3-3eb5-733d-b481-a53e5292bd51";
			await dispatchTuiTask(executeSubagentTool!, sessionId);
			const warning = "Warning: No project session found, using new session.";

			allProcs[0].stderr.emit("data", Buffer.from(warning + "\n"));
			await vi.advanceTimersByTimeAsync(0);
			endProcess(allProcs[0], 0);
			await vi.advanceTimersByTimeAsync(1000);

			const message = getLastEnvelope(pi);
			const content: string = message.content;

			expect(message.details.status).toBe(STATUS_WORDS.failure);
			expect(message.details.output).toBe("");
			expect(message.content).not.toBe(warning);
			expect(content).toMatch(/- Stderr:/);
			expect(content).toContain(warning);
			expect(content).toContain("No project session found");

			// The warning must live only inside the stderr diagnostic block,
			// not after the --- separator that marks the real answer/body area.
			const parts = content.split("---");
			const beforeSeparator = parts[0] ?? "";
			const afterSeparator = parts.slice(1).join("---");
			expect(beforeSeparator).toContain("- Stderr:");
			expect(beforeSeparator).toContain(warning);
			expect(afterSeparator).not.toContain(warning);

			// The raw stderr must never leak into details.output or any details field.
			expect(message.details.output).toBe("");
			const detailsJson = JSON.stringify(message.details);
			expect(detailsJson).not.toContain(warning);
		});

		it("sync stderr warning must remain readable in diagnostics (GREEN regression lock)", async () => {
			const { executeSubagentTool } = setupExtension();
			const warning = "Warning: No project session found, using new session.";
			const promise = runSyncTask(executeSubagentTool!);
			await vi.advanceTimersByTimeAsync(0);

			allProcs[0].stderr.emit("data", Buffer.from(warning + "\n"));
			await vi.advanceTimersByTimeAsync(0);
			endProcess(allProcs[0], 0);
			await vi.advanceTimersByTimeAsync(0);

			const result = await promise;
			expect(result.isError).toBe(true);
			const text = result.content.map((c: any) => c.text).join("");
			expect(text).toContain(warning);
		});
	});

	/* ═══════════════════════════════════════════════════════════════
	 * T5 · async envelope and sync execute must agree on success/failure
	 * ═══════════════════════════════════════════════════════════════ */
	describe("T5 · async envelope and sync execute agree on success/failure", () => {
		it("stopReason=length with text must be failed in both async and sync paths (RED)", async () => {
			const sessionId = "019ffdd3-3eb5-733d-b481-a53e5292bd52";

			// Async path
			const { pi: asyncPi, executeSubagentTool: asyncTool } = setupExtension();
			await dispatchTuiTask(asyncTool!, sessionId);
			emitMessageEnd(allProcs[0], { text: "truncated", stopReason: "length" });
			await vi.advanceTimersByTimeAsync(0);
			emitAgentEnd(allProcs[0], { willRetry: false, messages: [] });
			await vi.advanceTimersByTimeAsync(0);
			endProcess(allProcs[0], 0);
			await vi.advanceTimersByTimeAsync(1000);

			const asyncMessage = asyncPi._sendMessageCalls[asyncPi._sendMessageCalls.length - 1][0];
			const asyncStatus = asyncMessage.details.status;

			// Sync path with the same result shape: use the second proc spawned in this test.
			const { executeSubagentTool: syncTool } = setupExtension();
			const syncPromise = syncTool("call-2", { agent: "tester", task: "truncated", sessionId: "019ffdd3-3eb5-733d-b481-a53e5292bd53" }, undefined, undefined, createSyncCtx(defaultCwd));
			await vi.advanceTimersByTimeAsync(0);
			emitMessageEnd(allProcs[allProcs.length - 1], { text: "truncated", stopReason: "length" });
			await vi.advanceTimersByTimeAsync(0);
			endProcess(allProcs[allProcs.length - 1], 0);
			await vi.advanceTimersByTimeAsync(0);
			const syncResult = await syncPromise;

			expect(asyncStatus).toBe(STATUS_WORDS.failure);
			expect(syncResult.isError).toBe(true);
		});
	});

});
