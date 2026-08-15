/**
 * TDD red phase: sessionId must be a UUID v7 (or omitted)
 *
 * Contract under test (defined here, implemented by coder):
 *
 *   The ONLY legitimate reason to pass `sessionId` is to resume the UUID v7
 *   returned by a previous dispatch receipt. Therefore validateSessionId must
 *   accept exactly the uuidv7() output shape and reject everything else:
 *
 *     /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
 *
 *   - 36 chars, hyphenated 8-4-4-4-12, lowercase hex only.
 *   - Version nibble (start of 3rd group) must be "7".
 *   - Variant nibble (start of 4th group) must be one of 8/9/a/b.
 *   - STRICT lowercase: receipts always emit lowercase uuidv7() output, so
 *     uppercase input can only come from hand-editing and is rejected rather
 *     than normalized. This keeps a single canonical form for registry keys
 *     and session directory names (no case-normalization ambiguity).
 *   - Empty / whitespace-only / "." / ".." keep their existing rejections.
 *   - The rejection message must name the parameter ("sessionId") and state
 *     the only-legitimate-use semantics (resume a previous dispatch receipt's
 *     UUID v7; "resume" or 复用), stay under 200 chars, and not leak
 *     implementation details (regex source, file paths).
 *
 * All tests in this file are EXPECTED TO FAIL (red) until coder tightens
 * validateSessionId (src/index.ts L895-902) and the schema pattern /
 * description (src/index.ts L1704-1707).
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

/** The strict UUID v7 shape the new contract accepts (lowercase only). */
const UUID_V7_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/**
 * Real outputs captured from the uuidv7() implementation in src/index.ts.
 * Hardcoded so tests stay deterministic.
 */
const VALID_V7_A = "019ffdd3-3eb5-733d-b481-a53e5292bd59"; // variant nibble "b"
const VALID_V7_B = "019ffdd3-3eb6-702d-8ac7-ef7ea99ae5ed"; // variant nibble "8"

/** Sanity: our fixtures really are what the contract should accept. */
describe("test fixtures sanity check", () => {
	it("VALID_V7_A and VALID_V7_B match the strict UUID v7 shape", () => {
		expect(VALID_V7_A).toMatch(UUID_V7_RE);
		expect(VALID_V7_B).toMatch(UUID_V7_RE);
	});
});

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

describe("sessionId UUID v7 validation (red phase)", () => {
	let tmpBase: string;
	let agentDir: string;
	let defaultCwd: string;
	let savedEnv: Record<string, string | undefined>;
	let procRef: ReturnType<typeof createControllableProc> | null;

	beforeEach(() => {
		vi.useFakeTimers();

		taskRegistry.clear();

		tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "session-id-uuid-v7-test-"));
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
		const executeTool = pi._toolDefs[0].execute as ExecuteFn;
		return { pi, executeTool };
	}

	async function dispatch(sessionId: string | undefined) {
		const { executeTool } = setupExtension();
		const ctx = createMockTuiCtx(defaultCwd);
		const params: Record<string, unknown> = { agent: "tester", task: "test task" };
		if (sessionId !== undefined) params.sessionId = sessionId;
		return executeTool("call-1", params, undefined, undefined, ctx);
	}

	// ================================================================
	// 正向：合法 UUID v7 被接受
	// ================================================================
	describe("positive: valid UUID v7 is accepted", () => {
		it("should accept a uuidv7()-generated sessionId and return a dispatch receipt", async () => {
			const result = await dispatch(VALID_V7_A);

			expect(result.isError).toBeFalsy();
			expect(result.content[0].text).toMatch(/已派出|dispatched/i);
			expect(result.content[0].text).toContain(VALID_V7_A);
			expect(taskRegistry.has(VALID_V7_A)).toBe(true);

			if (procRef) endProcess(procRef);
		});

		it("should accept a UUID v7 with leading/trailing whitespace after trim normalization", async () => {
			const result = await dispatch(`  ${VALID_V7_B}  `);

			expect(result.isError).toBeFalsy();
			// The trimmed UUID v7 is the registry key
			expect(taskRegistry.has(VALID_V7_B)).toBe(true);

			if (procRef) endProcess(procRef);
		});

		it("should auto-generate a taskId matching the strict UUID v7 shape when sessionId is omitted", async () => {
			const result = await dispatch(undefined);

			expect(result.isError).toBeFalsy();
			const match = result.content[0].text.match(/taskId:\s*(\S+)/);
			expect(match, "receipt should contain a taskId").not.toBeNull();
			expect(match![1]).toMatch(UUID_V7_RE);
			expect(taskRegistry.has(match![1])).toBe(true);

			if (procRef) endProcess(procRef);
		});
	});

	// ================================================================
	// 负向：slug 风格 sessionId 被拒
	// ================================================================
	describe("negative: slug-style sessionIds are rejected", () => {
		it('should reject slug-style sessionId "tester-status-remove" and name the resume semantics', async () => {
			const result = await dispatch("tester-status-remove");

			expect(result.isError).toBe(true);
			expect(result.content[0].text).toMatch(/sessionId/i);
			expect(result.content[0].text).toMatch(/resume|复用/i);
		});

		it('should reject arbitrary external input "auth-refactor" and state the expected UUID v7 format', async () => {
			const result = await dispatch("auth-refactor");

			expect(result.isError).toBe(true);
			expect(result.content[0].text).toMatch(/sessionId/i);
			expect(result.content[0].text).toMatch(/uuid\s?v7/i);
		});
	});

	// ================================================================
	// 负向：UUID v7 格式边界（差一点都不行）
	// ================================================================
	describe("negative: near-miss UUID v7 shapes are rejected", () => {
		it("should reject a UUID whose version nibble is not 7", async () => {
			// VALID_V7_A with 3rd-group leading "7" flipped to "6"
			const notV7 = "019ffdd3-3eb5-633d-b481-a53e5292bd59";

			const result = await dispatch(notV7);

			expect(result.isError).toBe(true);
			expect(result.content[0].text).toMatch(/sessionId/i);
		});

		it("should reject a UUID v7 whose variant nibble is not 8/9/a/b", async () => {
			// VALID_V7_A with 4th-group leading "b" flipped to "c"
			const badVariant = "019ffdd3-3eb5-733d-c481-a53e5292bd59";

			const result = await dispatch(badVariant);

			expect(result.isError).toBe(true);
			expect(result.content[0].text).toMatch(/sessionId/i);
		});

		it("should reject a UUID v7 truncated to 35 characters", async () => {
			const result = await dispatch(VALID_V7_A.slice(0, 35));

			expect(result.isError).toBe(true);
			expect(result.content[0].text).toMatch(/sessionId/i);
		});

		it("should reject a UUID v7 padded to 37 characters", async () => {
			const result = await dispatch(`${VALID_V7_A}0`);

			expect(result.isError).toBe(true);
			expect(result.content[0].text).toMatch(/sessionId/i);
		});

		it("should reject an all-uppercase UUID v7 (strict lowercase; receipts never emit uppercase)", async () => {
			const result = await dispatch(VALID_V7_A.toUpperCase());

			expect(result.isError).toBe(true);
			expect(result.content[0].text).toMatch(/sessionId/i);
		});

		it("should reject a UUID-shaped string with a non-hex letter in a hex position", async () => {
			// "g" passes the legacy charset [A-Za-z0-9_.-] but is not hex
			const nonHex = "g19ffdd3-3eb5-733d-b481-a53e5292bd59";

			const result = await dispatch(nonHex);

			expect(result.isError).toBe(true);
			expect(result.content[0].text).toMatch(/sessionId/i);
		});
	});

	// ================================================================
	// 既有行为保留：空值与路径穿越防护
	// ================================================================
	describe("existing behavior preserved: empty and path-traversal rejections", () => {
		it("should reject an empty sessionId with an 'empty' error", async () => {
			const result = await dispatch("");

			expect(result.isError).toBe(true);
			expect(result.content[0].text).toMatch(/empty|空/i);
		});

		it("should reject a whitespace-only sessionId as empty after trim", async () => {
			const result = await dispatch(" ");

			expect(result.isError).toBe(true);
			expect(result.content[0].text).toMatch(/empty|空/i);
		});

		it('should reject sessionId "." as not allowed', async () => {
			const result = await dispatch(".");

			expect(result.isError).toBe(true);
			expect(result.content[0].text).toMatch(/not allowed|invalid|非法|不允许/i);
		});

		it('should reject sessionId ".." as not allowed', async () => {
			const result = await dispatch("..");

			expect(result.isError).toBe(true);
			expect(result.content[0].text).toMatch(/not allowed|invalid|非法|不允许/i);
		});
	});

	// ================================================================
	// 错误信息可见性
	// ================================================================
	describe("error message visibility", () => {
		it("should keep the rejection message under 200 characters", async () => {
			const result = await dispatch("tester-status-remove");

			expect(result.isError).toBe(true);
			expect(result.content[0].text.length).toBeLessThanOrEqual(200);
		});

		it("should not leak implementation details (regex source, file paths) in the rejection message", async () => {
			const result = await dispatch("tester-status-remove");

			expect(result.isError).toBe(true);
			expect(result.content[0].text).not.toContain("[0-9a-f]");
			expect(result.content[0].text).not.toContain("index.ts");
		});
	});

	// ================================================================
	// 拒绝时不产生副作用
	// ================================================================
	describe("rejection has no side effects", () => {
		it("should neither spawn a process nor register a task when sessionId is rejected", async () => {
			const result = await dispatch("tester-status-remove");

			expect(result.isError).toBe(true);
			expect(taskRegistry.size).toBe(0);
			expect(spawn).not.toHaveBeenCalled();
		});
	});

	// ================================================================
	// 本轮红阶段新增（reviewer 修复项 1+2+3，既有的 19 条之上追加）
	// ================================================================

	// ================================================================
	// A. 错误信息长度边界：36 字符的非法输入不得把消息撑过 200 字符
	// ================================================================
	describe("error message length boundary (36-char invalid input)", () => {
		it("should keep the rejection message under 200 characters for a 36-char near-miss input", async () => {
			// Exactly 36 chars like a real UUID, but the version nibble is "6"
			// and the final char is non-hex "g" — rejected by the strict shape.
			// The message must stay within the 200-char budget even for long
			// inputs (i.e. it must not embed the raw input verbatim).
			const nearMiss36 = "019ffdd3-3eb5-633d-b481-a53e5292bd5g";
			expect(nearMiss36).toHaveLength(36);

			const result = await dispatch(nearMiss36);

			expect(result.isError).toBe(true);
			const text: string = result.content[0].text;
			expect(text.length).toBeLessThanOrEqual(200);
			expect(text).toMatch(/sessionId/i);
			expect(text).toMatch(/uuid\s?v7/i);
			expect(text).toMatch(/resume|复用/i);
		});
	});

	// ================================================================
	// B. 非字符串 sessionId：返回结构化错误，而非抛 TypeError
	//    （params.sessionId 可以是任意 JSON 值，校验必须先行防御）
	// ================================================================
	describe("non-string sessionId inputs return a structured error instead of throwing", () => {
		async function dispatchRawSessionId(sessionId: unknown) {
			const { executeTool } = setupExtension();
			const ctx = createMockTuiCtx(defaultCwd);
			return executeTool(
				"call-1",
				{ agent: "tester", task: "test task", sessionId },
				undefined,
				undefined,
				ctx,
			);
		}

		it("should return an isError result instead of throwing when sessionId is null", async () => {
			const result = await dispatchRawSessionId(null);

			expect(result.isError).toBe(true);
			expect(result.content[0].text).toMatch(/sessionId/i);
			expect(result.content[0].text).toMatch(/must be a string/i);
		});

		it("should return an isError result instead of throwing when sessionId is a number", async () => {
			const result = await dispatchRawSessionId(123);

			expect(result.isError).toBe(true);
			expect(result.content[0].text).toMatch(/sessionId/i);
			expect(result.content[0].text).toMatch(/must be a string/i);
		});

		it("should return an isError result instead of throwing when sessionId is an array", async () => {
			const result = await dispatchRawSessionId([VALID_V7_A]);

			expect(result.isError).toBe(true);
			expect(result.content[0].text).toMatch(/sessionId/i);
			expect(result.content[0].text).toMatch(/must be a string/i);
		});

		it("should return an isError result instead of throwing when sessionId is an object", async () => {
			const result = await dispatchRawSessionId({ id: VALID_V7_A });

			expect(result.isError).toBe(true);
			expect(result.content[0].text).toMatch(/sessionId/i);
			expect(result.content[0].text).toMatch(/must be a string/i);
		});
	});
});
