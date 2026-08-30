/**
 * TDD red phase: every model-visible sessionId surface must be shape-free.
 *
 * User ruling (round 3):
 *   Any text that reaches the model context — static pre-call surfaces OR
 *   dynamic post-call error/receipt surfaces — must NOT leak the shape or
 *   construction rules of the id. The model should only know two rules:
 *     (a) omit sessionId to auto-generate a fresh id;
 *     (b) pass sessionId only when resuming the id returned in a previous
 *         dispatch receipt.
 *
 *   Forbidden wording anywhere in model context:
 *     "UUID v7" / "v7", "lowercase", "UUID v4", "slug", literal UUID examples,
 *     regex source fragments such as [0-9a-f].
 *
 *   Exception: real taskId/sessionId values carried in receipts, envelopes,
 *   and already-running notices are required and are NOT leaks.
 *
 * Surfaces under test:
 *   1. parameters.properties.sessionId.description
 *   2. description (the ACTIONS "- sessionId:" line only)
 *   3. promptGuidelines (the entry that mentions the parameter name "sessionId")
 *   4. dynamic rejection text from validateSessionId (pipeline path)
 *   5. dynamic already-running notice
 *   6. dispatch receipt (exception lock — real value must be preserved)
 *   7. [subagent-result] envelope (exception lock — real value must be preserved)
 *
 * Legend:
 *   A = forbidden construction hints must be absent
 *   B = both rules must be present (static surfaces, strengthened against reverse semantics)
 *   C = dynamic error surfaces must be construction-hint free (red on HEAD)
 *   D = strictness regression lock (should stay green)
 *   E = real-value exception lock (should stay green)
 *   F = other dynamic surfaces lock (should stay green)
 *   G = unified construction-hint scan (red on HEAD)
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

/** The example id the current prompt surface leaks. Shape is valid UUID v7. */
const LEAKED_EXAMPLE_ID = "019ffdd3-3eb5-733d-b481-a53e5292bd00";

/** Same-family prefix that must not appear anywhere on the pre-call surface. */
const LEAKED_PREFIX = "019ffdd3";

/** A valid-shape id that is not the registry fixture used elsewhere. */
const VALID_V7 = "019ffdd3-3eb5-733d-b481-a53e5292bd59";

/** Matches a literal UUID example anywhere in text. */
const UUID_LITERAL_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

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

function setupExtension() {
	const pi = createMockPi();
	extension(pi as any);
	const toolDef = pi._toolDefs[0];
	const executeTool = toolDef.execute as ExecuteFn;
	return { pi, toolDef, executeTool };
}

function setupExtensionWithPi() {
	return setupExtension();
}

function getSessionIdSchemaDescription(toolDef: any): string {
	return toolDef?.parameters?.properties?.sessionId?.description ?? "";
}

function getSessionIdToolLine(toolDef: any): string {
	const desc = typeof toolDef?.description === "string" ? toolDef.description : "";
	const line = desc
		.split("\n")
		.find((l: string) => /^- sessionId:/i.test(l));
	return line ?? "";
}

function getSessionIdPromptGuideline(toolDef: any): string {
	const guidelines = Array.isArray(toolDef?.promptGuidelines) ? toolDef.promptGuidelines : [];
	// The target entry is the one that names the parameter "sessionId".
	const entry = guidelines.find((g: string) => typeof g === "string" && g.includes("sessionId"));
	return entry ?? "";
}

function assertNoConstructionHints(text: string, label: string) {
	expect(text, `${label}: must not contain a literal UUID example`).not.toMatch(UUID_LITERAL_RE);
	expect(text, `${label}: must not leak the known example id`).not.toContain(LEAKED_EXAMPLE_ID);
	expect(text, `${label}: must not leak the known example id prefix`).not.toContain(LEAKED_PREFIX);
	expect(text, `${label}: must not mention "UUID v7"`).not.toMatch(/\buuid\s?v7\b/i);
	expect(text, `${label}: must not mention "lowercase"`).not.toMatch(/lowercase/i);
	expect(text, `${label}: must not mention "UUID v4"`).not.toMatch(/\buuid\s?v4\b/i);
	expect(text, `${label}: must not mention "slug"`).not.toMatch(/\bslug\b/i);
	expect(text, `${label}: must not contain regex source fragments like [0-9a-f]`).not.toMatch(/\[0-9a-f\]/);
	expect(text, `${label}: must not contain 8 consecutive hex chars (UUID-shape fragment)`).not.toMatch(/[0-9a-f]{8}/i);
}

/**
 * Strengthened rule check for static pre-call surfaces.
 *
 * Split by sentence-ending punctuation so clauses joined by ";" or "—" stay in
 * the same sentence. This lets "Omit otherwise; a new one is generated
 * automatically" be treated as one rule-bearing sentence, while a reverse-
 * semantic sentence like "Never omit the receipt when resuming a session; do
 * not generate a new one." is rejected because it contains the keywords in a
 * negated context.
 */
function assertBothRules(text: string, label: string) {
	const sentences = text
		.split(/[.!?]+/)
		.map((s) => s.trim())
		.filter(Boolean);

	expect(
		sentences.some((s) => /omit/i.test(s)),
		`${label}: must state the omit/auto-generate rule`,
	).toBe(true);
	expect(
		sentences.some((s) => /resume|resuming/i.test(s)),
		`${label}: must state the resume-from-receipt rule`,
	).toBe(true);

	const negationRe = /\b(never|not|no|nothing|nobody|nowhere|neither|don't|don’t|doesn't|doesn’t|won't|won’t|can't|can’t|shouldn't|shouldn’t|mustn|isn|aren|wasn|weren|haven|hasn|hadn|couldn|wouldn)\b/i;

	for (const sentence of sentences) {
		if (/omit/i.test(sentence)) {
			const negated = negationRe.test(sentence);
			expect(negated, `${label}: omit sentence must not be negated`).toBe(false);
			expect(sentence, `${label}: omit sentence must link to auto-generate/new`).toMatch(/generate|new/i);
		}
		if (/resume|resuming/i.test(sentence)) {
			const negated = negationRe.test(sentence);
			expect(negated, `${label}: resume sentence must not be negated`).toBe(false);
			expect(sentence, `${label}: resume sentence must link to receipt/previous`).toMatch(/receipt|previous/i);
		}
	}
}

/**
 * Looser rule check for dynamic rejection text. The implementation only needs
 * to keep the two rules somewhere in the message; the stricter clause-direction
 * check is enforced on the static pre-call surfaces.
 */
function assertDynamicRules(text: string, label: string) {
	expect(text, `${label}: must state the omit/auto-generate rule`).toMatch(/omit/i);
	expect(text, `${label}: must state the resume-from-receipt rule (resume/resuming)`).toMatch(/resume|resuming/i);
	expect(text, `${label}: must state the resume-from-receipt rule (receipt)`).toMatch(/receipt/i);
}

/**
 * Assert that dynamic model-visible text contains no id construction hints.
 *
 * Real taskId/sessionId values are NOT leaks, but this helper is intended for
 * rejection messages that should not echo the invalid input as a UUID-shaped
 * example either.
 */
function assertNoShapeSpecifications(text: string, label: string) {
	expect(text, `${label}: must not mention "UUID v7"`).not.toMatch(/\buuid\s?v7\b/i);
	expect(text, `${label}: must not mention "lowercase"`).not.toMatch(/lowercase/i);
	expect(text, `${label}: must not mention "UUID v4"`).not.toMatch(/\buuid\s?v4\b/i);
	expect(text, `${label}: must not mention "slug"`).not.toMatch(/\bslug\b/i);
	expect(text, `${label}: must not contain regex source fragments like [0-9a-f]`).not.toMatch(/\[0-9a-f\]/);
	expect(text, `${label}: must not contain a literal UUID-shaped example`).not.toMatch(UUID_LITERAL_RE);
}

describe("sessionId prompt surface must not leak construction hints (red phase)", () => {
	// ================================================================
	// A. Forbidden construction hints must be absent from all three surfaces.
	// ================================================================
	describe("A. forbidden construction hints", () => {
		it("A1: schema description must not leak UUID examples or construction specs", () => {
			const { toolDef } = setupExtension();
			const text = getSessionIdSchemaDescription(toolDef);

			expect(text.length).toBeGreaterThan(0);
			assertNoConstructionHints(text, "schema description");
		});

		it("A2: tool description sessionId line must not leak UUID examples or construction specs", () => {
			const { toolDef } = setupExtension();
			const text = getSessionIdToolLine(toolDef);

			expect(text.length).toBeGreaterThan(0);
			assertNoConstructionHints(text, "tool description sessionId line");
		});

		it("A3: promptGuidelines sessionId entry must not leak UUID examples or construction specs", () => {
			const { toolDef } = setupExtension();
			const text = getSessionIdPromptGuideline(toolDef);

			expect(text.length).toBeGreaterThan(0);
			assertNoConstructionHints(text, "promptGuidelines sessionId entry");
		});

		it("A4: schema property must not re-introduce a pattern (regression lock)", () => {
			const { toolDef } = setupExtension();

			expect(toolDef?.parameters?.properties?.sessionId?.pattern).toBeUndefined();
		});
	});

	// ================================================================
	// B. Both rules must be present on all three surfaces.
	// ================================================================
	describe("B. required rule-bearing semantics", () => {
		it("B1: schema description must state both rules", () => {
			const { toolDef } = setupExtension();
			const text = getSessionIdSchemaDescription(toolDef);

			assertBothRules(text, "schema description");
		});

		it("B2: tool description sessionId line must state both rules", () => {
			const { toolDef } = setupExtension();
			const text = getSessionIdToolLine(toolDef);

			assertBothRules(text, "tool description sessionId line");
		});

		it("B3: promptGuidelines sessionId entry must state both rules", () => {
			const { toolDef } = setupExtension();
			const text = getSessionIdPromptGuideline(toolDef);

			assertBothRules(text, "promptGuidelines sessionId entry");
		});

		it("B4: assertBothRules must reject reverse-semantic counter-example", () => {
			const counterExample =
				"Never omit the receipt when resuming a session; do not generate a new one.";

			let caught: Error | undefined;
			try {
				assertBothRules(counterExample, "counter-example");
			} catch (err) {
				caught = err instanceof Error ? err : new Error(String(err));
			}

			expect(caught, "counter-example must be rejected").toBeDefined();
			console.log("Counter-example rejection message:", caught!.message);
		});
	});

	// ================================================================
	// C. Dynamic rejection surfaces must be construction-hint free (red on HEAD).
	// ================================================================
	describe("C. dynamic rejection surfaces must be construction-hint free", () => {
		let tmpBase: string;
		let agentDir: string;
		let defaultCwd: string;
		let savedEnv: Record<string, string | undefined>;
		let procRef: ReturnType<typeof createControllableProc> | null;

		beforeEach(() => {
			vi.useFakeTimers();
			taskRegistry.clear();

			tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "session-id-prompt-surface-test-"));
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

		async function dispatch(sessionId: string | undefined) {
			const { toolDef, executeTool } = setupExtension();
			const ctx = createMockTuiCtx(defaultCwd);
			const args: Record<string, unknown> = { agent: "tester", task: "test task" };
			if (sessionId !== undefined) args.sessionId = sessionId;

			try {
				validateToolArguments(toolDef as any, { name: "subagent", arguments: args } as any);
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				return { text: message, isError: true, isSchemaError: true };
			}

			const result = await executeTool("call-1", args, undefined, undefined, ctx);

			if (result.isError) {
				return { text: result.content[0].text as string, isError: true, isSchemaError: false };
			}
			return { text: result.content[0].text as string, isError: false, isSchemaError: false };
		}

		it("C1: pipeline rejection for slug carries both rules and no construction hints", async () => {
			const { text, isError, isSchemaError } = await dispatch("tester-status-remove");

			expect(isSchemaError).toBe(false);
			expect(isError).toBe(true);
			assertDynamicRules(text, "C1 rejection text");
			assertNoShapeSpecifications(text, "C1 rejection text");
			expect(text).not.toMatch(/must match pattern/i);
			expect(text.length).toBeLessThanOrEqual(200);
			expect(spawn).not.toHaveBeenCalled();
			expect(taskRegistry.size).toBe(0);

			if (procRef) endProcess(procRef);
		});

		it("C2: pipeline rejection for UUID v4 carries both rules and no construction hints", async () => {
			const { text, isError, isSchemaError } = await dispatch("7c9e6679-7425-40de-944b-e07fc1f90ae7");

			expect(isSchemaError).toBe(false);
			expect(isError).toBe(true);
			assertDynamicRules(text, "C2 rejection text");
			assertNoShapeSpecifications(text, "C2 rejection text");
			expect(text).not.toMatch(/must match pattern/i);
			expect(text.length).toBeLessThanOrEqual(200);
			expect(spawn).not.toHaveBeenCalled();
			expect(taskRegistry.size).toBe(0);

			if (procRef) endProcess(procRef);
		});

		it("C3: pipeline rejection for uppercase UUID v7 carries both rules and no construction hints", async () => {
			const { text, isError, isSchemaError } = await dispatch(VALID_V7.toUpperCase());

			expect(isSchemaError).toBe(false);
			expect(isError).toBe(true);
			assertDynamicRules(text, "C3 rejection text");
			assertNoShapeSpecifications(text, "C3 rejection text");
			expect(text).not.toMatch(/must match pattern/i);
			expect(text.length).toBeLessThanOrEqual(200);
			expect(spawn).not.toHaveBeenCalled();
			expect(taskRegistry.size).toBe(0);

			if (procRef) endProcess(procRef);
		});

		it("C4: pipeline rejection for path-traversal sessionId carries both rules and no construction hints", async () => {
			const { text, isError, isSchemaError } = await dispatch("../../etc/passwd");

			expect(isSchemaError).toBe(false);
			expect(isError).toBe(true);
			assertDynamicRules(text, "C4 rejection text");
			assertNoShapeSpecifications(text, "C4 rejection text");
			expect(text).not.toMatch(/must match pattern/i);
			expect(text.length).toBeLessThanOrEqual(200);
			expect(spawn).not.toHaveBeenCalled();
			expect(taskRegistry.size).toBe(0);

			if (procRef) endProcess(procRef);
		});
	});

	// ================================================================
	// D. Strictness regression: shape-valid example id is not format-rejected.
	// ================================================================
	describe("D. strictness regression", () => {
		let tmpBase: string;
		let agentDir: string;
		let defaultCwd: string;
		let savedEnv: Record<string, string | undefined>;
		let procRef: ReturnType<typeof createControllableProc> | null;

		beforeEach(() => {
			vi.useFakeTimers();
			taskRegistry.clear();

			tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "session-id-prompt-surface-strictness-test-"));
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

		async function dispatch(sessionId: string | undefined) {
			const { toolDef, executeTool } = setupExtension();
			const ctx = createMockTuiCtx(defaultCwd);
			const args: Record<string, unknown> = { agent: "tester", task: "test task" };
			if (sessionId !== undefined) args.sessionId = sessionId;

			try {
				validateToolArguments(toolDef as any, { name: "subagent", arguments: args } as any);
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				return { text: message, isError: true, isSchemaError: true };
			}

			const result = await executeTool("call-1", args, undefined, undefined, ctx);

			if (result.isError) {
				return { text: result.content[0].text as string, isError: true, isSchemaError: false };
			}
			return { text: result.content[0].text as string, isError: false, isSchemaError: false };
		}

		it("D1: the leaked example id is shape-valid and must not be rejected by schema/format checks", async () => {
			// SECURITY NOTE: this id is identical in shape to a real UUID v7 and
			// therefore passes format validation. It is the example id that the
			// prompt surface currently leaks. The model could copy it and attempt
			// to resume a session that does not belong to it. This test only
			// asserts that the id is not rejected *for format reasons*; whether
			// the id maps to an existing session is a separate concern that the
			// current round explicitly does NOT address (per user ruling).
			const { isSchemaError } = await dispatch(LEAKED_EXAMPLE_ID);

			expect(isSchemaError).toBe(false);

			if (procRef) endProcess(procRef);
		});
	});

	// ================================================================
	// E. Exception lock: real taskId values are allowed in success surfaces.
	// ================================================================
	describe("E. real taskId values are allowed in success surfaces", () => {
		let tmpBase: string;
		let agentDir: string;
		let defaultCwd: string;
		let savedEnv: Record<string, string | undefined>;
		let procRef: ReturnType<typeof createControllableProc> | null;

		beforeEach(() => {
			vi.useFakeTimers();
			taskRegistry.clear();

			tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "session-id-prompt-surface-exception-lock-test-"));
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

		async function dispatch(sessionId: string | undefined) {
			const { toolDef, executeTool } = setupExtension();
			const ctx = createMockTuiCtx(defaultCwd);
			const args: Record<string, unknown> = { agent: "tester", task: "test task" };
			if (sessionId !== undefined) args.sessionId = sessionId;

			try {
				validateToolArguments(toolDef as any, { name: "subagent", arguments: args } as any);
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				return { text: message, isError: true, isSchemaError: true };
			}

			const result = await executeTool("call-1", args, undefined, undefined, ctx);

			if (result.isError) {
				return { text: result.content[0].text as string, isError: true, isSchemaError: false };
			}
			return { text: result.content[0].text as string, isError: false, isSchemaError: false };
		}

		it("E1: dispatch receipt must include the real taskId value verbatim", async () => {
			const { text, isError, isSchemaError } = await dispatch(VALID_V7);

			expect(isSchemaError).toBe(false);
			expect(isError).toBe(false);
			expect(text).toMatch(/dispatched/i);
			expect(text).toContain(VALID_V7);

			if (procRef) endProcess(procRef);
		});
	});

	// ================================================================
	// F. Other dynamic surfaces: already-running notice.
	// ================================================================
	describe("F. already-running notice must not leak construction hints", () => {
		let tmpBase: string;
		let agentDir: string;
		let defaultCwd: string;
		let savedEnv: Record<string, string | undefined>;
		let procRef: ReturnType<typeof createControllableProc> | null;

		beforeEach(() => {
			vi.useFakeTimers();
			taskRegistry.clear();

			tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "session-id-prompt-surface-running-test-"));
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

		async function dispatch(sessionId: string | undefined) {
			const { toolDef, executeTool } = setupExtension();
			const ctx = createMockTuiCtx(defaultCwd);
			const args: Record<string, unknown> = { agent: "tester", task: "test task" };
			if (sessionId !== undefined) args.sessionId = sessionId;

			try {
				validateToolArguments(toolDef as any, { name: "subagent", arguments: args } as any);
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				return { text: message, isError: true, isSchemaError: true };
			}

			const result = await executeTool("call-1", args, undefined, undefined, ctx);

			if (result.isError) {
				return { text: result.content[0].text as string, isError: true, isSchemaError: false };
			}
			return { text: result.content[0].text as string, isError: false, isSchemaError: false };
		}

		it("F1: already-running notice must carry the real taskId and omit rule without shape specs", async () => {
			// First dispatch starts a background task.
			const first = await dispatch(VALID_V7);
			expect(first.isError).toBe(false);
			expect(first.text).toContain(VALID_V7);

			// Second dispatch with the same id is rejected.
			const { text, isError, isSchemaError } = await dispatch(VALID_V7);
			expect(isSchemaError).toBe(false);
			expect(isError).toBe(true);

			// Real taskId value is required/allowed.
			expect(text).toContain(VALID_V7);
			// Rule-bearing semantics.
			expect(text).toMatch(/sessionId/i);
			expect(text).toMatch(/omit/i);
			// Forbidden construction hints.
			expect(text).not.toMatch(/\buuid\s?v7\b/i);
			expect(text).not.toMatch(/lowercase/i);
			expect(text).not.toMatch(/\buuid\s?v4\b/i);
			expect(text).not.toMatch(/\bslug\b/i);
			expect(text).not.toMatch(/\[0-9a-f\]/);

			if (procRef) endProcess(procRef);
		});
	});

	// ================================================================
	// G. Unified construction-hint scan: every model-visible sessionId
	//    related string must be free of shape specs, with an explicit
	//    exception for real taskId/sessionId values.
	// ================================================================
	describe("G. unified construction-hint scan", () => {
		let tmpBase: string;
		let agentDir: string;
		let defaultCwd: string;
		let savedEnv: Record<string, string | undefined>;
		let procRef: ReturnType<typeof createControllableProc> | null;

		beforeEach(() => {
			vi.useFakeTimers();
			taskRegistry.clear();

			tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "session-id-unified-scan-test-"));
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

		async function getRejectionText(executeTool: ExecuteFn, ctx: unknown, sessionId: unknown) {
			const result = await executeTool(
				"call-1",
				{ agent: "tester", task: "test task", sessionId },
				undefined,
				undefined,
				ctx,
			);
			expect(result.isError, `sessionId=${String(sessionId)} should be rejected`).toBe(true);
			return result.content[0].text as string;
		}

		it("G1: all sessionId-related model-visible strings must be free of construction hints", async () => {
			// ---------------------------------------------------------------
			// Collect static surfaces.
			// ---------------------------------------------------------------
			const { toolDef } = setupExtension();
			const staticSamples = [
				{ name: "schema description", text: getSessionIdSchemaDescription(toolDef), realValue: undefined as string | undefined },
				{ name: "tool description sessionId line", text: getSessionIdToolLine(toolDef), realValue: undefined },
				{ name: "promptGuidelines sessionId entry", text: getSessionIdPromptGuideline(toolDef), realValue: undefined },
			];

			// ---------------------------------------------------------------
			// Collect dynamic rejection texts (executeTool path).
			// ---------------------------------------------------------------
			const { executeTool } = setupExtension();
			const ctx = createMockTuiCtx(defaultCwd);

			const rejectionInputs: { name: string; sessionId: unknown }[] = [
				{ name: "rejection: non-string (null)", sessionId: null },
				{ name: "rejection: non-string (number)", sessionId: 123 },
				{ name: "rejection: empty string", sessionId: "" },
				{ name: "rejection: '.'", sessionId: "." },
				{ name: "rejection: '..'", sessionId: ".." },
				{ name: "rejection: slug", sessionId: "tester-status-remove" },
				{ name: "rejection: UUID v4", sessionId: "7c9e6679-7425-40de-944b-e07fc1f90ae7" },
				{ name: "rejection: uppercase UUID v7", sessionId: VALID_V7.toUpperCase() },
				{ name: "rejection: path traversal", sessionId: "../../etc/passwd" },
			];

			const rejectionSamples = await Promise.all(
				rejectionInputs.map(async ({ name, sessionId }) => {
					const text = await getRejectionText(executeTool, ctx, sessionId);
					return { name, text, realValue: undefined as string | undefined };
				}),
			);

			// ---------------------------------------------------------------
			// Collect success / already-running / envelope surfaces.
			// Use a fresh pi so we can read the sent envelope.
			// ---------------------------------------------------------------
			const { pi, executeTool: executeTool2 } = setupExtensionWithPi();
			const ctx2 = createMockTuiCtx(defaultCwd);

			const receiptResult = await executeTool2(
				"receipt-call",
				{ agent: "tester", task: "test task", sessionId: VALID_V7 },
				undefined,
				undefined,
				ctx2,
			);
			const receiptText = receiptResult.content[0].text as string;
			expect(receiptText, "receipt must contain the real taskId").toContain(VALID_V7);

			const runningResult = await executeTool2(
				"running-call",
				{ agent: "tester", task: "test task", sessionId: VALID_V7 },
				undefined,
				undefined,
				ctx2,
			);
			expect(runningResult.isError ?? false, "already-running result must be an error").toBe(true);
			const runningText = runningResult.content[0].text as string;

			expect(procRef, "a process should have been spawned for the receipt dispatch").not.toBeNull();
			endProcess(procRef!);
			await vi.advanceTimersByTimeAsync(100);

			expect(pi.sendMessage, "envelope should be sent after process ends").toHaveBeenCalled();
			const [message] = pi._sendMessageCalls[0];
			const envelopeText: string = message.content;

			const exceptionSamples = [
				{ name: "success: dispatch receipt", text: receiptText, realValue: VALID_V7 },
				{ name: "error: already-running notice", text: runningText, realValue: VALID_V7 },
				{ name: "notification: [subagent-result] envelope", text: envelopeText, realValue: VALID_V7 },
			];

			// ---------------------------------------------------------------
			// Unified scan table.
			// ---------------------------------------------------------------
			const samples = [...staticSamples, ...rejectionSamples, ...exceptionSamples];

			for (const { name, text, realValue } of samples) {
				expect(text.length, `${name}: text must not be empty`).toBeGreaterThan(0);

				// Forbidden wording applies to every model-visible text.
				expect(text, `${name}: must not mention "UUID v7"`).not.toMatch(/\buuid\s?v7\b/i);
				expect(text, `${name}: must not mention "lowercase"`).not.toMatch(/lowercase/i);
				expect(text, `${name}: must not mention "UUID v4"`).not.toMatch(/\buuid\s?v4\b/i);
				expect(text, `${name}: must not mention "slug"`).not.toMatch(/\bslug\b/i);
				expect(text, `${name}: must not contain regex source fragment [0-9a-f]`).not.toMatch(/\[0-9a-f\]/);

				if (realValue) {
					// Exception clause: real values are required/allowed.
					expect(text, `${name}: must verbatim include the real taskId/sessionId value`).toContain(realValue);
					// We deliberately skip literal UUID-shape / hex-sequence scans here;
					// a real value is not a construction hint.
				} else {
					// Non-exception texts must not carry UUID-shaped examples or regex fragments.
					expect(text, `${name}: must not contain a literal UUID-shaped example`).not.toMatch(UUID_LITERAL_RE);
					expect(text, `${name}: must not contain 8 consecutive hex chars (UUID-shape fragment)`).not.toMatch(/[0-9a-f]{8}/i);
				}
			}
		});
	});
});
