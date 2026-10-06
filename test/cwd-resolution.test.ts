/**
 * Behaviour locks for the subagent tool's working-directory contract.
 *
 * Target semantics (the tests below are the executable form of it):
 *   1. The tool declares no `cwd` parameter at all — the JSON Schema exposed
 *      to the model must not contain a `cwd` property, so the model has no way
 *      to ask for a different working directory.
 *   2. The spawned subprocess always runs in the caller's session cwd
 *      (execute()'s `ctx.cwd`), on the sync path and the tui/async path alike.
 *      Relative `skills` paths resolve against that same directory.
 *   3. A stray `cwd` key in the call params is ignored: it neither moves the
 *      subprocess nor introduces a new error path (a nonexistent value must
 *      not block the dispatch).
 *   4. Calls without any `cwd` key behave exactly as they do today
 *      (characterisation must not regress): spawn cwd, relative skill
 *      resolution, absolute/`~/` skill handling and the session-dir argument
 *      are all pinned.
 *   5. Legacy mode (a project config without a `dispatch` field) keeps the
 *      same cwd contract.
 *
 * The subprocess boundary (`node:child_process.spawn`) is mocked so the spawn
 * options/cwd and the `--skill` CLI args can be inspected without launching a
 * real pi process.
 *
 * Lock (implemented): the tool declares no `cwd` parameter and a stray `cwd`
 * key sent by a stale caller is inert, so every "stray cwd key" case below
 * spawns at `ctx.cwd`. These cases were RED before the parameter was removed.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn } from "node:child_process";
import extension, { taskRegistry, resetProgressManagerForTests } from "../src/index.ts";
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

const SESSION_ID = "019ffdd3-3eb5-733d-b481-a53e5292bd04";
const ENV_KEYS = [
	"PI_SUBAGENT_DEPTH",
	"PI_SUBAGENT_HARD_TIMEOUT_MS",
	"PI_SUBAGENT_ACTIVITY_TIMEOUT_MS",
];

interface SpawnCall {
	command: string;
	args: string[];
	options: { cwd?: string; env?: Record<string, string | undefined> };
}

type ExecuteFn = (
	toolCallId: string,
	params: Record<string, unknown>,
	signal: AbortSignal | undefined,
	onUpdate: unknown,
	ctx: unknown,
) => Promise<any>;

/** Collect every value that follows a CLI flag, e.g. all `--skill <path>` values. */
function flagValues(args: string[], flag: string): string[] {
	const values: string[] = [];
	for (let i = 0; i < args.length - 1; i++) {
		if (args[i] === flag) values.push(args[i + 1]);
	}
	return values;
}

/**
 * A minimal fake ChildProcess: emit stdout "end" and "exit" 0 on the next
 * microtask (after runSingleAgent has attached its listeners), so the run
 * finalizes successfully with exit code 0.
 */
function createSuccessfulProc() {
	const proc = new EventEmitter() as any;
	proc.stdout = new EventEmitter();
	proc.stderr = new EventEmitter();
	proc.kill = vi.fn();
	proc.exitCode = null;
	proc.signalCode = null;
	queueMicrotask(() => {
		proc.stdout.emit(
			"data",
			Buffer.from(
				JSON.stringify({
					type: "message_end",
					message: {
						role: "assistant",
						content: [{ type: "text", text: "success output" }],
						stopReason: "end_turn",
						usage: { input: 10, output: 5, totalTokens: 15 },
					},
				}) + "\n",
			),
		);
		proc.stdout.emit("end");
		proc.emit("exit", 0, null);
	});
	return proc;
}

describe("subagent cwd contract: the subprocess always runs in the session cwd", () => {
	let tmpBase: string;
	let agentDir: string;
	let sessionCwd: string;
	let otherCwd: string;
	let spawnCalls: SpawnCall[];
	let executeTool: ExecuteFn;
	let toolDef: any;
	let savedEnv: Record<string, string | undefined>;

	function writeProjectAgent(skills?: string[]): void {
		const skillsLine = skills ? `skills: ${skills.join(", ")}\n` : "";
		fs.writeFileSync(
			path.join(sessionCwd, ".pi", "agents", "tester.md"),
			`---\nname: tester\ndescription: Test agent\n${skillsLine}---\n`,
			"utf-8",
		);
	}

	/** A project config present but without a `dispatch` field = legacy mode. */
	function writeLegacyProjectConfig(): void {
		fs.writeFileSync(path.join(sessionCwd, ".pi", "subagent-isolation.json"), "{}", "utf-8");
	}

	/** Dispatch through the public execute() seam with ctx.cwd = sessionCwd. */
	async function runSubagent(params: Record<string, unknown> = {}) {
		return executeTool(
			"call-1",
			{ agent: "tester", task: "test task", sessionId: SESSION_ID, ...params },
			undefined,
			undefined,
			{ cwd: sessionCwd, hasUI: false },
		);
	}

	/** Same dispatch, but with a TUI ctx so execute() takes the async path. */
	async function runSubagentTui(params: Record<string, unknown> = {}) {
		return executeTool(
			"call-1",
			{ agent: "tester", task: "test task", sessionId: SESSION_ID, ...params },
			undefined,
			undefined,
			{
				cwd: sessionCwd,
				hasUI: true,
				mode: "tui",
				ui: { setWidget: vi.fn(), confirm: vi.fn().mockResolvedValue(true) },
			},
		);
	}

	beforeEach(() => {
		tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "async-subagent-isolation-cwd-test-"));
		agentDir = path.join(tmpBase, "agent-dir");
		sessionCwd = path.join(tmpBase, "session-cwd");
		otherCwd = path.join(tmpBase, "other-cwd");
		fs.mkdirSync(path.join(sessionCwd, ".pi", "agents"), { recursive: true });
		fs.mkdirSync(otherCwd, { recursive: true });
		vi.mocked(getAgentDir).mockReturnValue(agentDir);

		spawnCalls = [];
		vi.mocked(spawn).mockImplementation(((command: string, args: string[], options: any) => {
			spawnCalls.push({ command, args, options });
			return createSuccessfulProc();
		}) as any);

		// Capture the tool definition registered by the extension entry point.
		toolDef = undefined;
		const pi = {
			registerTool: (tool: { name: string; parameters?: unknown; execute: ExecuteFn }) => {
				// The extension registers a single subagent tool; cancel is dispatched via its action parameter. These tests exercise subagent.
				if (tool.name === "subagent") {
					executeTool = tool.execute;
					toolDef = tool;
				}
			},
			sendMessage: vi.fn(),
		};
		extension(pi as any);

		// Pin delegation-depth / timeout env vars so results are deterministic
		// regardless of the environment the test suite runs in.
		savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
		process.env.PI_SUBAGENT_DEPTH = "0";
		delete process.env.PI_SUBAGENT_HARD_TIMEOUT_MS;
		delete process.env.PI_SUBAGENT_ACTIVITY_TIMEOUT_MS;
	});

	afterEach(() => {
		taskRegistry.clear();
		resetProgressManagerForTests();
		for (const key of ENV_KEYS) {
			if (savedEnv[key] === undefined) delete process.env[key];
			else process.env[key] = savedEnv[key];
		}
		fs.rmSync(tmpBase, { recursive: true, force: true });
		vi.clearAllMocks();
	});

	// ── Target semantics 1: no `cwd` parameter on the tool surface ──────────
	// First line of defence: the model is never told the key exists. (The second
	// one — a stray key sent by a stale caller is inert — is locked by the
	// "stray cwd key" cases below and by test/cwd-preflight-red.test.ts [c1]/[d2].)
	it("should not declare a cwd parameter in the subagent tool schema", () => {
		// Arrange: the extension factory registered the tool in beforeEach.
		// Act: inspect the parameter schema the model would receive.
		const properties = toolDef.parameters?.properties ?? {};

		// Assert: no per-call working directory may be advertised.
		expect(Object.prototype.hasOwnProperty.call(properties, "cwd")).toBe(false);
		expect(toolDef.parameters?.required ?? []).not.toContain("cwd");
	});

	// ── Target semantics 4: the no-cwd-key call must not regress ────────────
	it("should spawn in the session cwd and resolve relative skills against it when the call omits cwd", async () => {
		// Arrange
		writeProjectAgent(["skills/helper", "skills/other"]);

		// Act
		const result = await runSubagent();

		// Assert: spawn cwd, relative skill resolution and session dir all use
		// the caller's session cwd / agent dir as before.
		expect(result.isError).toBeUndefined();
		expect(spawnCalls).toHaveLength(1);
		const { args, options } = spawnCalls[0];
		expect(options.cwd).toBe(sessionCwd);
		expect(flagValues(args, "--skill")).toEqual([
			path.resolve(sessionCwd, "skills/helper"),
			path.resolve(sessionCwd, "skills/other"),
		]);
		expect(flagValues(args, "--session-dir")).toEqual([
			path.resolve(agentDir, "subagent-sessions", SESSION_ID),
		]);
	});

	// ── Target semantics 2 + 3: a stray `cwd` key must not move the child ───
	// Second line of defence: even if the key is still sent (schema drift, a
	// hand-written call), execute() must ignore it completely — no relocation,
	// no new error path.
	it("should spawn in the session cwd when the call carries a cwd key pointing at another existing directory", async () => {
		// Arrange: another real directory exists, tempting the child away.
		writeProjectAgent();

		// Act
		const result = await runSubagent({ cwd: otherCwd });

		// Assert
		// Lock: the call's cwd key must not influence the child — even a real,
		// existing otherCwd cannot move the spawn; the case was RED before the
		// parameter was removed.
		expect(result.isError).toBeUndefined();
		expect(spawnCalls).toHaveLength(1);
		expect(spawnCalls[0].options.cwd).toBe(sessionCwd);
	});

	it("should spawn in the session cwd even when the call's cwd key points at a nonexistent directory", async () => {
		// Arrange
		writeProjectAgent();
		const missingDir = path.join(tmpBase, "no-such-dir");

		// Act
		const result = await runSubagent({ cwd: missingDir });

		// Assert: the ignored key introduces no new error path — no CWD_*
		// rejection, the dispatch spawns; the case was RED before the parameter
		// was removed.
		expect(result.isError).toBeUndefined();
		expect(spawnCalls).toHaveLength(1);
		expect(spawnCalls[0].options.cwd).toBe(sessionCwd);
		const text = result.content?.[0]?.text ?? "";
		expect(text).not.toContain("[CWD_");
		expect(text).not.toContain("agent cwd 参数");
	});

	it("should spawn in the session cwd on the tui/async path when the call carries a cwd key", async () => {
		// Arrange
		writeProjectAgent();

		// Act
		const result = await runSubagentTui({ cwd: otherCwd });

		// Assert: the receipt is returned (dispatch accepted) and the background
		// child was started in the session cwd.
		// Lock: the call's cwd key must not reach the spawn options; the case
		// was RED before the parameter was removed.
		expect(result.isError).toBeUndefined();
		expect(spawnCalls).toHaveLength(1);
		expect(spawnCalls[0].options.cwd).toBe(sessionCwd);
	});

	it("should resolve relative skill paths against the session cwd when the call carries a cwd key", async () => {
		// Arrange: the other directory mimics the same layout, so a wrong base
		// would resolve to a real but wrong path.
		writeProjectAgent(["skills/helper"]);
		fs.mkdirSync(path.join(otherCwd, "skills", "helper"), { recursive: true });

		// Act
		const result = await runSubagent({ cwd: otherCwd });

		// Assert
		// Lock: relative skills always resolve against the session cwd, never
		// the call's cwd key; the case was RED before the parameter was removed.
		expect(result.isError).toBeUndefined();
		expect(spawnCalls).toHaveLength(1);
		expect(flagValues(spawnCalls[0].args, "--skill")).toEqual([
			path.resolve(sessionCwd, "skills/helper"),
		]);
	});

	it("should ignore a relative skill path that escapes the session cwd and keep the in-bounds path", async () => {
		// Arrange
		writeProjectAgent(["../outside", "skills/ok"]);

		// Act
		const result = await runSubagent();

		// Assert
		const { args } = spawnCalls[0];
		expect(flagValues(args, "--skill")).toEqual([path.resolve(sessionCwd, "skills/ok")]);
		expect(result.details.results[0].stderr).toContain(
			'skill path "../outside" resolves outside the agent base directory and was ignored',
		);
	});

	it("should leave absolute and home-relative skill paths unchanged regardless of the session cwd", async () => {
		// Arrange
		const absoluteSkill = path.join(tmpBase, "abs-skill");
		writeProjectAgent([absoluteSkill, "~/home-skill"]);

		// Act
		await runSubagent();

		// Assert
		const { args } = spawnCalls[0];
		expect(flagValues(args, "--skill")).toEqual([
			absoluteSkill,
			path.join(os.homedir(), "home-skill"),
		]);
	});

	// ── Target semantics 5: legacy mode keeps the same cwd contract ─────────
	it("should keep spawning in the session cwd in legacy mode (config without a dispatch field)", async () => {
		// Arrange
		writeProjectAgent();
		writeLegacyProjectConfig();

		// Act
		const result = await runSubagent();

		// Assert
		expect(result.isError).toBeUndefined();
		expect(spawnCalls).toHaveLength(1);
		expect(spawnCalls[0].options.cwd).toBe(sessionCwd);
	});

	it("should ignore a stray cwd key in legacy mode too (config without a dispatch field)", async () => {
		// Arrange
		writeProjectAgent();
		writeLegacyProjectConfig();

		// Act
		const result = await runSubagent({ cwd: otherCwd });

		// Assert
		// Lock: legacy mode ignores the stray cwd key exactly like list mode;
		// the case was RED before the parameter was removed.
		expect(result.isError).toBeUndefined();
		expect(spawnCalls).toHaveLength(1);
		expect(spawnCalls[0].options.cwd).toBe(sessionCwd);
	});
});
