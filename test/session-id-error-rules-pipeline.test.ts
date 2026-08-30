/**
 * TDD red phase: sessionId rejection rules must reach the model through the
 * real pi validation pipeline WITHOUT leaking id construction hints.
 *
 * Contract under test (must-follow for implementation):
 *
 *   For any sessionId that the system judges illegal, the text the model
 *   actually sees in the real pi pipeline MUST express both rules:
 *     (a) omit sessionId entirely to auto-generate a fresh id;
 *     (b) the only legitimate reason to pass sessionId is to resume the id
 *         returned in a previous dispatch receipt.
 *
 *   The model-visible rejection MUST NOT use "must match pattern" / bare
 *   regex as the refusal reason, MUST NOT mention "UUID v7" / "lowercase" /
 *   "UUID v4" / "slug", and MUST NOT leak regex source fragments such as
 *   [0-9a-f]{8}. It must stay under 200 characters.
 *
 *   This is enforced at the pipeline level: the helper reproduces the real
 *   pi order — schema validation first via validateToolArguments, then the
 *   tool's execute(). Schema validation must not intercept format-class
 *   illegal sessionIds with a bare pattern error; instead the rejection
 *   must surface from execute() with the rule-bearing message.
 */

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn } from "node:child_process";
import { validateToolArguments } from "@earendil-works/pi-ai";
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

const UUID_V7_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

const VALID_V7 = "019ffdd3-3eb5-733d-b481-a53e5292bd59";
const UUID_V4 = "7c9e6679-7425-40de-944b-e07fc1f90ae7";

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
		_toolDefs: toolDefs,
		_commandDefs: commandDefs,
		_eventHandlers: eventHandlers,
		_sendMessageCalls: sendMessageCalls,
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

describe("sessionId error rules pipeline (red phase)", () => {
	let tmpBase: string;
	let agentDir: string;
	let defaultCwd: string;
	let savedEnv: Record<string, string | undefined>;
	let procRef: ReturnType<typeof createControllableProc> | null;

	beforeEach(() => {
		vi.useFakeTimers();

		taskRegistry.clear();

		tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "session-id-error-rules-test-"));
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
		vi.mocked(spawn).mockImplementation((() => {
			const proc = createControllableProc();
			procRef = proc;
			return proc;
		}) as any);

		savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
		process.env.PI_SUBAGENT_DEPTH = "0";
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
		const toolDef = pi._toolDefs[0];
		const executeTool = toolDef.execute as ExecuteFn;
		return { pi, toolDef, executeTool };
	}

	/**
	 * Replicates the real pi pipeline:
	 * 1. validateToolArguments against the registered subagent schema.
	 * 2. If schema validation passes, call the tool's execute().
	 *
	 * Returns the exact text the model sees, and whether that text represents
	 * an error.
	 */
	async function dispatch(sessionId: string | undefined) {
		const { toolDef, executeTool } = setupExtension();
		const ctx = createMockTuiCtx(defaultCwd);
		const args: Record<string, unknown> = { agent: "tester", task: "test task" };
		if (sessionId !== undefined) args.sessionId = sessionId;

		// Step 1: real pi schema validation.
		try {
			validateToolArguments(toolDef as any, { name: "subagent", arguments: args } as any);
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			return { text: message, isError: true, isSchemaError: true };
		}

		// Step 2: execute() only when schema validation succeeds.
		const result = await executeTool("call-1", args, undefined, undefined, ctx);

		if (result.isError) {
			return { text: result.content[0].text as string, isError: true, isSchemaError: false };
		}

		return { text: result.content[0].text as string, isError: false, isSchemaError: false };
	}

	// ================================================================
	// Criterion 1: pipeline-level rejection message reaches the model
	// with both rules and no bare pattern wording.
	// ================================================================
	describe("criterion 1: model-visible rejection must carry both rules", () => {
		function assertRuleBearingMessage(text: string) {
			expect(text).toMatch(/sessionId/i);
			expect(text).toMatch(/omit/i);
			expect(text).toMatch(/resume/i);
			expect(text).not.toMatch(/\buuid\s?v7\b/i);
			expect(text).not.toMatch(/lowercase/i);
			expect(text).not.toMatch(/must match pattern/i);
			expect(text).not.toContain("[0-9a-f]");
			expect(text.length).toBeLessThanOrEqual(200);
		}

		it('should reject "tester-status-remove" with a rule-bearing message, not a pattern error', async () => {
			const { text, isError } = await dispatch("tester-status-remove");

			expect(isError).toBe(true);
			assertRuleBearingMessage(text);
			expect(spawn).not.toHaveBeenCalled();
			expect(taskRegistry.size).toBe(0);

			if (procRef) endProcess(procRef);
		});

		it("should reject a UUID v4 with a rule-bearing message, not a pattern error", async () => {
			const { text, isError } = await dispatch(UUID_V4);

			expect(isError).toBe(true);
			assertRuleBearingMessage(text);
			expect(spawn).not.toHaveBeenCalled();
			expect(taskRegistry.size).toBe(0);

			if (procRef) endProcess(procRef);
		});

		it("should reject an uppercase UUID v7 with a rule-bearing message, not a pattern error", async () => {
			const { text, isError } = await dispatch(VALID_V7.toUpperCase());

			expect(isError).toBe(true);
			assertRuleBearingMessage(text);
			expect(spawn).not.toHaveBeenCalled();
			expect(taskRegistry.size).toBe(0);

			if (procRef) endProcess(procRef);
		});

		it('should reject a 36-char near-miss with version nibble "6" using a rule-bearing message, not a pattern error', async () => {
			const nearMiss = "019ffdd3-3eb5-633d-b481-a53e5292bd59";
			expect(nearMiss).toHaveLength(36);
			expect(nearMiss).not.toMatch(UUID_V7_RE);

			const { text, isError } = await dispatch(nearMiss);

			expect(isError).toBe(true);
			assertRuleBearingMessage(text);
			expect(spawn).not.toHaveBeenCalled();
			expect(taskRegistry.size).toBe(0);

			if (procRef) endProcess(procRef);
		});

		it('should reject path-traversal sessionId "../../etc/passwd" with a rule-bearing message, not a pattern error', async () => {
			const { text, isError } = await dispatch("../../etc/passwd");

			expect(isError).toBe(true);
			assertRuleBearingMessage(text);
			expect(spawn).not.toHaveBeenCalled();
			expect(taskRegistry.size).toBe(0);

			if (procRef) endProcess(procRef);
		});
	});

	// ================================================================
	// Criterion 2: valid lowercase UUID v7 passes the pipeline unchanged.
	// ================================================================
	describe("criterion 2: valid UUID v7 is not rejected by the pipeline", () => {
		it("should accept a valid lowercase UUID v7 and return a dispatch receipt containing that id", async () => {
			const { text, isError } = await dispatch(VALID_V7);

			expect(isError).toBe(false);
			expect(text).toMatch(/dispatched/i);
			expect(text).toContain(VALID_V7);
			expect(taskRegistry.has(VALID_V7)).toBe(true);

			if (procRef) endProcess(procRef);
		});
	});

	// ================================================================
	// Criterion 3: omitting sessionId auto-generates a UUID v7.
	// ================================================================
	describe("criterion 3: omitted sessionId auto-generates a strict UUID v7", () => {
		it("should auto-generate a taskId matching the strict UUID v7 shape when sessionId is omitted", async () => {
			const { text, isError } = await dispatch(undefined);

			expect(isError).toBe(false);
			const match = text.match(/taskId:\s*(\S+)/);
			expect(match, "receipt should contain a taskId").not.toBeNull();
			expect(match![1]).toMatch(UUID_V7_RE);
			expect(taskRegistry.has(match![1])).toBe(true);

			if (procRef) endProcess(procRef);
		});
	});

	// ================================================================
	// Criterion 4: path-traversal inputs never reach spawn or registry.
	// ================================================================
	describe("criterion 4: path-traversal inputs do not spawn or register", () => {
		it('should not call spawn or register a task for sessionId "../../etc/passwd"', async () => {
			await dispatch("../../etc/passwd");

			expect(spawn).not.toHaveBeenCalled();
			expect(taskRegistry.size).toBe(0);

			if (procRef) endProcess(procRef);
		});
	});

	// ================================================================
	// Criterion 5: mutation guard — verified in the test-run output.
	// On the current HEAD (schema pattern still present) the criterion-1
	// cases must fail with a "must match pattern" schema error.
	// ================================================================
});
