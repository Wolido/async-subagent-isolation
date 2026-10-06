/**
 * Regression tests for timeout behavior in runSingleAgent (src/index.ts)
 *
 * These tests lock in the fixed behavior for three former bugs:
 * 1. stderr data resets the activity timer
 * 2. Activity timer starts immediately after spawn
 * 3. Timeout kills set a structured stopReason
 */

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn } from "node:child_process";
import extension from "../src/index.ts";
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

const SESSION_ID = "019ffdd3-3eb5-733d-b481-a53e5292bd02";

/**
 * Grace period between the timeout's first SIGTERM and the SIGKILL escalation.
 * Locked to the cancel path's escalation delay in src/index.ts
 * (`sigkillTimer = setTimeout(..., 5000)` in runSingleAgent's abort handler,
 * plus a `proc.exitCode/signalCode` liveness re-check): the timeout kill paths
 * must reuse that exact mechanism, not invent a different grace.
 */
const SIGTERM_GRACE_MS = 5000;

const ENV_KEYS = [
	"PI_SUBAGENT_DEPTH",
	"PI_SUBAGENT_HARD_TIMEOUT_MS",
	"PI_SUBAGENT_ACTIVITY_TIMEOUT_MS",
];

type ExecuteFn = (
	toolCallId: string,
	params: Record<string, unknown>,
	signal: AbortSignal | undefined,
	onUpdate: unknown,
	ctx: unknown,
) => Promise<any>;

/**
 * Create a fake ChildProcess that we can control externally.
 *
 * By default the fake process terminates on SIGTERM and SIGKILL (a
 * well-behaved child) and mirrors real ChildProcess bookkeeping by setting
 * `signalCode` when it exits. Pass `terminatesOn: ["SIGKILL"]` for a process
 * that ignores SIGTERM — required to observe the grace-period escalation — and
 * `terminatesOn: []` for a process whose exit timing this test drives manually.
 */
function createControllableProc(options: { terminatesOn?: string[] } = {}) {
	const terminatesOn = options.terminatesOn ?? ["SIGTERM", "SIGKILL"];
	const proc = new EventEmitter() as any;
	proc.stdout = new EventEmitter();
	proc.stderr = new EventEmitter();
	proc.kill = vi.fn((signal?: string) => {
		// Simulate process termination for the signals this fake child handles.
		if (signal && terminatesOn.includes(signal)) {
			queueMicrotask(() => {
				proc.signalCode = signal;
				proc.stdout.emit("end");
				proc.emit("exit", null, signal);
				proc.emit("close", null, signal);
			});
		}
		return true;
	});
	proc.exitCode = null;
	proc.signalCode = null;
	return proc;
}

/**
 * Simulate a real ChildProcess exit: set the exit bookkeeping before emitting
 * `exit` / `close`, exactly like Node does (a signal exit leaves `exitCode`
 * null and sets `signalCode`).
 */
function emitProcessExit(proc: any, signal: string | null = null, code = 0) {
	if (signal !== null) proc.signalCode = signal;
	else proc.exitCode = code;
	proc.stdout.emit("end");
	proc.emit("exit", signal !== null ? null : code, signal);
	proc.emit("close", signal !== null ? null : code, signal);
}

/**
 * Create a successful proc that exits normally
 */
function createSuccessfulProc() {
	const proc = new EventEmitter() as any;
	proc.stdout = new EventEmitter();
	proc.stderr = new EventEmitter();
	proc.kill = vi.fn();
	proc.exitCode = null;
	proc.signalCode = null;
	queueMicrotask(() => {
		proc.stdout.emit("end");
		proc.emit("exit", 0, null);
	});
	return proc;
}

describe("runSingleAgent timeout behavior", () => {
	let tmpBase: string;
	let agentDir: string;
	let defaultCwd: string;
	let executeTool: ExecuteFn;
	let savedEnv: Record<string, string | undefined>;
	let procRef: ReturnType<typeof createControllableProc> | null;
	let procFactory: () => any;

	beforeEach(() => {
		vi.useFakeTimers();
		
		tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "async-subagent-isolation-timeout-test-"));
		agentDir = path.join(tmpBase, "agent-dir");
		defaultCwd = path.join(tmpBase, "default-cwd");
		fs.mkdirSync(path.join(defaultCwd, ".pi", "agents"), { recursive: true });
		fs.mkdirSync(agentDir, { recursive: true });
		vi.mocked(getAgentDir).mockReturnValue(agentDir);

		// Write a test agent
		fs.writeFileSync(
			path.join(defaultCwd, ".pi", "agents", "tester.md"),
			`---\nname: tester\ndescription: Test agent\n---\n`,
			"utf-8",
		);

		procRef = null;
		procFactory = () => createControllableProc();
		vi.mocked(spawn).mockImplementation((() => {
			procRef = procFactory();
			return procRef;
		}) as any);

		const pi = {
			registerTool: (tool: { name: string; execute: ExecuteFn }) => {
				// The extension registers a single subagent tool; cancel is dispatched via its action parameter. These tests exercise subagent.
				if (tool.name === "subagent") executeTool = tool.execute;
			},
		};
		extension(pi as any);

		savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
		process.env.PI_SUBAGENT_DEPTH = "0";
	});

	afterEach(() => {
		for (const key of ENV_KEYS) {
			if (savedEnv[key] === undefined) delete process.env[key];
			else process.env[key] = savedEnv[key];
		}
		fs.rmSync(tmpBase, { recursive: true, force: true });
		vi.clearAllMocks();
		vi.useRealTimers();
	});

	async function runSingleAgent() {
		return executeTool("call-1", {
			agent: "tester",
			task: "test task",
			sessionId: SESSION_ID,
		}, undefined, undefined, {
			cwd: defaultCwd,
			hasUI: false,
		});
	}

	describe("Bug #1: stderr should reset activity timer", () => {
		it("should not kill process when stderr data arrives before activity timeout", async () => {
			// Set a short activity timeout for testing
			process.env.PI_SUBAGENT_ACTIVITY_TIMEOUT_MS = "1000";
			delete process.env.PI_SUBAGENT_HARD_TIMEOUT_MS;

			const resultPromise = runSingleAgent();
			
			// Wait for spawn to be called
			await vi.advanceTimersByTimeAsync(0);
			expect(procRef).not.toBeNull();

			// Emit some stdout data to start activity
			procRef!.stdout.emit("data", Buffer.from('{"type":"turn_start"}\n'));
			await vi.advanceTimersByTimeAsync(0);

			// Wait for most of the timeout period
			await vi.advanceTimersByTimeAsync(800);

			// Emit stderr data - this resets the timer (Bug #1 fix)
			procRef!.stderr.emit("data", Buffer.from("shell command output\n"));
			await vi.advanceTimersByTimeAsync(0);

			// Wait past the original timeout - process should NOT be killed
			// because stderr activity should have reset the timer
			await vi.advanceTimersByTimeAsync(500);

			// Bug #1 fixed: process is NOT killed (timer reset at 800ms, so next timeout at 1800ms)
			expect(procRef!.kill).not.toHaveBeenCalled();

			// Clean up
			procRef!.stdout.emit("end");
			procRef!.emit("exit", 0, null);
			await resultPromise;
		});
	});

	describe("Bug #2: Activity timer should start after spawn", () => {
		it("should kill process if no activity after spawn within timeout", async () => {
			// Set a short activity timeout
			process.env.PI_SUBAGENT_ACTIVITY_TIMEOUT_MS = "1000";
			delete process.env.PI_SUBAGENT_HARD_TIMEOUT_MS;

			const resultPromise = runSingleAgent();
			
			// Wait for spawn to be called
			await vi.advanceTimersByTimeAsync(0);
			expect(procRef).not.toBeNull();

			// DON'T emit any stdout/stderr data - simulating a hung process
			// The activity timer should have started at spawn time
			
			// Wait for the full timeout period
			await vi.advanceTimersByTimeAsync(1000);

			// Bug #2 fixed: process IS killed (timer started at spawn). The exact
			// first signal is locked by the SIGTERM-first contract tests below.
			expect(procRef!.kill).toHaveBeenCalled();

			// Clean up
			await resultPromise;
		});

		it("should allow process to run if activity occurs before timeout", async () => {
			process.env.PI_SUBAGENT_ACTIVITY_TIMEOUT_MS = "1000";
			delete process.env.PI_SUBAGENT_HARD_TIMEOUT_MS;

			const resultPromise = runSingleAgent();
			await vi.advanceTimersByTimeAsync(0);

			// Emit activity before timeout
			await vi.advanceTimersByTimeAsync(500);
			procRef!.stdout.emit("data", Buffer.from('{"type":"turn_start"}\n'));
			await vi.advanceTimersByTimeAsync(0);

			// Wait past original timeout but within reset timeout
			await vi.advanceTimersByTimeAsync(800);

			// Process should NOT be killed
			expect(procRef!.kill).not.toHaveBeenCalled();

			// Clean up
			procRef!.stdout.emit("end");
			procRef!.emit("exit", 0, null);
			await resultPromise;
		});
	});

	describe("Bug #3: Timeout kill should set structured stopReason", () => {
		it("should set stopReason to 'activity_timeout' when activity timeout triggers", async () => {
			process.env.PI_SUBAGENT_ACTIVITY_TIMEOUT_MS = "1000";
			delete process.env.PI_SUBAGENT_HARD_TIMEOUT_MS;

			const resultPromise = runSingleAgent();
			await vi.advanceTimersByTimeAsync(0);

			// Emit some initial activity
			procRef!.stdout.emit("data", Buffer.from('{"type":"turn_start"}\n'));
			await vi.advanceTimersByTimeAsync(0);

			// Wait for timeout
			await vi.advanceTimersByTimeAsync(1000);

			// Let the process terminate
			await vi.advanceTimersByTimeAsync(100);

			const result = await resultPromise;

			// Bug #3 fixed: stopReason is "activity_timeout"
			expect(result.details.results[0].stopReason).toBe("activity_timeout");
		});

		it("should set stopReason to 'hard_timeout' when hard timeout triggers", async () => {
			process.env.PI_SUBAGENT_HARD_TIMEOUT_MS = "2000";
			delete process.env.PI_SUBAGENT_ACTIVITY_TIMEOUT_MS;

			const resultPromise = runSingleAgent();
			await vi.advanceTimersByTimeAsync(0);

			// Emit activity to keep process alive (activity timeout disabled)
			procRef!.stdout.emit("data", Buffer.from('{"type":"turn_start"}\n'));
			await vi.advanceTimersByTimeAsync(0);

			// Wait for hard timeout
			await vi.advanceTimersByTimeAsync(2000);
			await vi.advanceTimersByTimeAsync(100);

			const result = await resultPromise;

			// Bug #3 fixed: stopReason is "hard_timeout"
			expect(result.details.results[0].stopReason).toBe("hard_timeout");
		});

		it("should include timeout info in stderr for debugging", async () => {
			process.env.PI_SUBAGENT_ACTIVITY_TIMEOUT_MS = "1000";
			delete process.env.PI_SUBAGENT_HARD_TIMEOUT_MS;

			const resultPromise = runSingleAgent();
			await vi.advanceTimersByTimeAsync(0);

			procRef!.stdout.emit("data", Buffer.from('{"type":"turn_start"}\n'));
			await vi.advanceTimersByTimeAsync(0);

			await vi.advanceTimersByTimeAsync(1000);
			await vi.advanceTimersByTimeAsync(100);

			const result = await resultPromise;

			// Should have diagnostic message in stderr
			expect(result.details.results[0].stderr).toContain("activity timeout");
			// Should also have stopReason set (Bug #3 fix)
			expect(result.details.results[0].stopReason).toBe("activity_timeout");
		});
	});

	describe("Integration: Combined timeout scenarios", () => {
		it("should handle stderr activity preventing timeout and set correct stopReason on eventual timeout", async () => {
			process.env.PI_SUBAGENT_ACTIVITY_TIMEOUT_MS = "1000";
			delete process.env.PI_SUBAGENT_HARD_TIMEOUT_MS;

			const resultPromise = runSingleAgent();
			await vi.advanceTimersByTimeAsync(0);

			// Start with stdout activity
			procRef!.stdout.emit("data", Buffer.from('{"type":"turn_start"}\n'));
			await vi.advanceTimersByTimeAsync(0);

			// Wait 800ms
			await vi.advanceTimersByTimeAsync(800);

			// Emit stderr - should reset timer (Bug #1)
			procRef!.stderr.emit("data", Buffer.from("working...\n"));
			await vi.advanceTimersByTimeAsync(0);

			// Wait 800ms more (total 1600ms, but timer reset at 800ms)
			await vi.advanceTimersByTimeAsync(800);

			// Should not be killed yet
			expect(procRef!.kill).not.toHaveBeenCalled();

			// Wait for timeout after last activity
			await vi.advanceTimersByTimeAsync(200);

			// Now should be killed (first signal locked by the SIGTERM-first
			// contract tests below)
			expect(procRef!.kill).toHaveBeenCalled();
			await vi.advanceTimersByTimeAsync(100);

			const result = await resultPromise;

			// Should have structured stopReason (Bug #3)
			expect(result.details.results[0].stopReason).toBe("activity_timeout");
		});
	});

	// ================================================================
	// SIGTERM-first timeout kills (RED contract)
	//
	// Old behavior: activity/hard timeouts called proc.kill("SIGKILL")
	// directly as the first and only signal, giving the child no chance to
	// reap its own descendants. New behavior: reuse the cancel-path
	// escalation — SIGTERM first, then a SIGTERM_GRACE_MS grace with a
	// liveness re-check before SIGKILL. stopReason semantics
	// (activity_timeout / hard_timeout) are unchanged.
	// ================================================================
	describe("SIGTERM-first timeout kills (RED contract)", () => {
		it("should send SIGTERM, not SIGKILL, as the first kill signal when the activity timeout fires", async () => {
			// Arrange: a well-behaved child that exits on SIGTERM
			process.env.PI_SUBAGENT_ACTIVITY_TIMEOUT_MS = "1000";
			delete process.env.PI_SUBAGENT_HARD_TIMEOUT_MS;

			// Act
			const resultPromise = runSingleAgent();
			await vi.advanceTimersByTimeAsync(0);
			expect(procRef).not.toBeNull();
			await vi.advanceTimersByTimeAsync(1000);

			// Assert
			const killCalls = procRef!.kill.mock.calls.map((c: any[]) => c[0]);
			expect(killCalls[0], "超时首发信号必须是 SIGTERM（旧行为是 SIGKILL）").toBe("SIGTERM");

			await resultPromise;
		});

		it("should not send SIGKILL and leave no escalation timer when the process exits within the grace period", async () => {
			// Arrange: the fake child ignores every signal so this test owns the
			// exit timing — it exits 2s into the 5s grace, like a child that
			// reaped its own grandchildren before dying.
			process.env.PI_SUBAGENT_ACTIVITY_TIMEOUT_MS = "1000";
			delete process.env.PI_SUBAGENT_HARD_TIMEOUT_MS;
			procFactory = () => createControllableProc({ terminatesOn: [] });

			const resultPromise = runSingleAgent();
			await vi.advanceTimersByTimeAsync(0);
			expect(procRef).not.toBeNull();

			// Act: timeout fires -> SIGTERM
			await vi.advanceTimersByTimeAsync(1000);
			expect(procRef!.kill).toHaveBeenCalledWith("SIGTERM");

			// Exit mid-grace
			await vi.advanceTimersByTimeAsync(2000);
			emitProcessExit(procRef!, "SIGTERM");
			await vi.advanceTimersByTimeAsync(0);

			// Assert: the escalation timer must have been cleared on exit
			expect(vi.getTimerCount(), "进程退出后不得遗留升级定时器").toBe(0);

			const result = await resultPromise;
			expect(result.isError).toBe(true);
			expect(result.details.results[0].stopReason).toBe("activity_timeout");

			// Assert: no SIGKILL even after the full grace + finalize window
			await vi.advanceTimersByTimeAsync(SIGTERM_GRACE_MS);
			const killCalls = procRef!.kill.mock.calls.map((c: any[]) => c[0]);
			expect(killCalls, "宽限期内退出的进程不得补发 SIGKILL").not.toContain("SIGKILL");
		});

		it("should escalate to SIGKILL only after the exact cancel-path grace when the process ignores SIGTERM", async () => {
			// Arrange: SIGTERM-ignoring child, only SIGKILL terminates it
			process.env.PI_SUBAGENT_ACTIVITY_TIMEOUT_MS = "1000";
			delete process.env.PI_SUBAGENT_HARD_TIMEOUT_MS;
			procFactory = () => createControllableProc({ terminatesOn: ["SIGKILL"] });

			const resultPromise = runSingleAgent();
			await vi.advanceTimersByTimeAsync(0);
			await vi.advanceTimersByTimeAsync(1000);

			// Assert: SIGTERM immediately, no SIGKILL and no second signal yet
			expect(procRef!.kill).toHaveBeenCalledWith("SIGTERM");
			await vi.advanceTimersByTimeAsync(SIGTERM_GRACE_MS - 1);
			expect(procRef!.kill.mock.calls.map((c: any[]) => c[0])).toEqual(["SIGTERM"]);

			// Act: grace expires -> SIGKILL
			await vi.advanceTimersByTimeAsync(1);
			expect(procRef!.kill.mock.calls.map((c: any[]) => c[0])).toEqual(["SIGTERM", "SIGKILL"]);

			// Assert: the escalation guarantees exit, so the run still finalizes
			// as a timeout instead of hanging on the grace period
			const result = await resultPromise;
			expect(result.isError).toBe(true);
			expect(result.details.results[0].stopReason).toBe("activity_timeout");
		});

		it("should apply the same SIGTERM -> grace -> SIGKILL escalation to the hard timeout", async () => {
			// Arrange
			process.env.PI_SUBAGENT_HARD_TIMEOUT_MS = "2000";
			delete process.env.PI_SUBAGENT_ACTIVITY_TIMEOUT_MS;
			procFactory = () => createControllableProc({ terminatesOn: ["SIGKILL"] });

			const resultPromise = runSingleAgent();
			await vi.advanceTimersByTimeAsync(0);
			await vi.advanceTimersByTimeAsync(2000);

			// Assert: hard timeout also starts with SIGTERM, never a first SIGKILL
			const killCalls = procRef!.kill.mock.calls.map((c: any[]) => c[0]);
			expect(killCalls[0], "hard_timeout 首发信号必须是 SIGTERM").toBe("SIGTERM");

			// Act: grace expires -> SIGKILL
			await vi.advanceTimersByTimeAsync(SIGTERM_GRACE_MS);
			expect(procRef!.kill.mock.calls.map((c: any[]) => c[0])).toEqual(["SIGTERM", "SIGKILL"]);

			// Assert: stopReason semantics unchanged
			const result = await resultPromise;
			expect(result.isError).toBe(true);
			expect(result.details.results[0].stopReason).toBe("hard_timeout");
		});
	});
});
