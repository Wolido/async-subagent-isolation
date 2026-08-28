/**
 * RED-phase tests: preflight validation for subagent cwd + command executable
 *
 * These tests are written against the **desired** behavior described in the
 * product decision doc. They **expect failure** until the coder implements:
 *   1. CWD existence verification (pre-spawn, not post-error-in-stderr).
 *   2. Structured error propagation (isError=true via result channel, not
 *      only stderr text).
 *   3. Command-executable check (process.execPath must exist + be X_OK).
 *
 * Tests are grouped into eleven families:
 *   A – characterisation (proves current misleading ENOENT symptom via raw Node spawn)
 *   B – behavioural contract (asserts future API shapes / exported functions)
 *   C – behavioral integration via public execute() (spawn mocked for call-count assertion)
 *   D – regression (valid paths unchanged)
 *   E – structured output (error exposes fields on result channel)
 *   F – R2: the two preflight entries (exported async `preflightSpawn` and the
 *       sync one behind execute()) must map identical errno facts identically
 *   G – R3/R4: CWD_INACCESSIBLE semantics + deterministic permission branch
 *   H – R5: empty / whitespace-only `cwd` param must behave like "no param"
 *   I – R6: `~user/x` must not be silently expanded
 *   J – G1/D4: a *bare* command name must never be X_OK-checked, in either
 *       preflight entry (mutation-verified: removing `path.isAbsolute(command)`
 *       from src/index.ts:295 / :322 used to leave all 738 tests green)
 *   K – G2: the exhaustive cwd/exec probe truth table — "a probe threw" and
 *       "a probe answered false" are different facts and must produce
 *       different verdicts (and never a silent OK)
 *
 * Hint for the implementation round (not asserted here, prevention of the
 * original bug class): the `cwd` schema description (src/index.ts, `cwd:
 * Type.Optional(Type.String({ description: … }))` in the subagent tool schema)
 * must state that a missing directory is a hard error (never auto-created) and
 * that only `~/…` and bare `~` are expanded — `~user/…` is not. That text is
 * read by the model on every dispatch, so it is the cheapest place to keep the
 * misleading-spawn-ENOENT bug from coming back.
 *
 * Fixture conventions (matching existing test files):
 *   tmpBase  → mkdtemp under os.tmpdir()
 *   defaultCwd → path under tmpBase where .pi/agents/tester.md lives
 *   getAgentDir(mock) → separate agentDir under tmpBase
 *   Extension loaded once per beforeEach; vi.clearAllMocks() after each.
 */

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn, ChildProcess } from "node:child_process";
import extension, { taskRegistry } from "../src/index.ts";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

/* ─── Mocking setup ─────────────────────────────────────────────── */

vi.mock("@earendil-works/pi-coding-agent", async () => {
	const actual = await vi.importActual("@earendil-works/pi-coding-agent");
	return {
		...actual,
		getAgentDir: vi.fn(),
	};
});

vi.mock("node:child_process", () => ({
	spawn: vi.fn<typeof spawn>(),
})) as never;

// Store real spawn for tests that need it (characterisation / countermeasure).
const _realSpawn = require("node:child_process").spawn;

/* ─── Types & interfaces (mirrors desired result shape) ──────────── */

interface PreflightResult {
	ok: boolean;
	/** Every code the production decision function can emit. Keep in sync with
	 *  `PreflightCode` in src/index.ts — `CWD_INACCESSIBLE` is the fourth member
	 *  ("directory exists but cannot be stat'ed / entered", e.g. EACCES) and was
	 *  missing from this union (R7). */
	code?: "CWD_MISSING" | "CWD_NOT_DIR" | "CWD_INACCESSIBLE" | "EXEC_MISSING" | null;
	message?: string;
	fields?: {
		command?: string;
		cwd?: string;
		/** CWD_MISSING → false; CWD_NOT_DIR / CWD_INACCESSIBLE / EXEC_MISSING →
		 *  true (the code's own meaning: the directory IS there, something else
		 *  is wrong). */
		cwdExists?: boolean;
		source?: "param" | "session";
	};
}

type ExecuteFn = (
	toolCallId: string,
	params: Record<string, unknown>,
	signal: AbortSignal | undefined,
	onUpdate: unknown,
	ctx: unknown,
) => Promise<any>;

/* ─── Helpers ───────────────────────────────────────────────────── */

function createSuccessfulProc(): ChildProcess {
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

function resolveTilde(val: string): string {
	if (!val.startsWith("~/")) return val;
	return path.join(os.homedir(), val.slice(2));
}

const SESSION_ID = "019ffdd3-3eb5-733d-b481-a53e5292bd04";
const ENV_KEYS = [
	"PI_SUBAGENT_DEPTH",
	"PI_SUBAGENT_HARD_TIMEOUT_MS",
	"PI_SUBAGENT_ACTIVITY_TIMEOUT_MS",
	"PI_CURRENT_AGENT_NAME",
];

/* ─── Test class: shared temp dir + spies ────────────────────────── */

class Fixture {
	tmpBase!: string;
	agentDir!: string;
	defaultCwd!: string;
	/** NOTE: this path never reaches production code. `execute()` receives the
	 *  session cwd through `ctx.cwd` (== `defaultCwd`), which `runSingleAgent`
	 *  passes to `resolveAgentCwd({ sessionCwd: defaultCwd })`. Kept only as an
	 *  extra tmp path; validating "the session cwd itself" must delete
	 *  `defaultCwd`, not this one (see [c5]). */
	sessionCwd!: string;
	spawnCalls: Array<{ command: string; args: string[]; options: unknown }> = [];
	executeTool!: ExecuteFn;
	savedEnv: Record<string, string | undefined> = {};

	beforeEach_(): void {
		this.tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "subagent-preflight-test-"));
		this.agentDir = path.join(this.tmpBase, "agent-dir");
		this.defaultCwd = path.join(this.tmpBase, "default-cwd");
		this.sessionCwd = path.join(this.tmpBase, "session-cwd");
		fs.mkdirSync(path.join(this.defaultCwd, ".pi", "agents"), { recursive: true });
		fs.mkdirSync(this.sessionCwd, { recursive: true });

		// Write agent config where discoverAgents will find it
		fs.writeFileSync(
			path.join(this.defaultCwd, ".pi", "agents", "tester.md"),
			"---\nname: tester\ndescription: Test agent\n---\n",
			"utf-8",
		);

		vi.mocked(getAgentDir).mockReturnValue(this.agentDir);

		// Same agent, discovered from the *user* scope (getAgentDir() is mocked to
		// agentDir, see above). This is what lets a test delete defaultCwd and still
		// reach the cwd preflight instead of dying at the "unknown agent" guard.
		// With agentScope "both" the project copy still wins (it is set after the
		// user copy in discoverAgents), so existing cases are unaffected.
		fs.mkdirSync(path.join(this.agentDir, "agents"), { recursive: true });
		fs.writeFileSync(
			path.join(this.agentDir, "agents", "tester.md"),
			"---\nname: tester\ndescription: Test agent\n---\n",
			"utf-8",
		);

		// Capture spawn calls; auto-complete the process synchronously
		this.spawnCalls = [];
		vi.mocked(spawn).mockImplementation(((cmd, args, opts) => {
			this.spawnCalls.push({ command: cmd, args, options: opts });
			return createSuccessfulProc();
		}) as never);

		// Pin delegation-depth / timeout env vars
		this.savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
		process.env.PI_SUBAGENT_DEPTH = "0";
		delete process.env.PI_SUBAGENT_HARD_TIMEOUT_MS;
		delete process.env.PI_SUBAGENT_ACTIVITY_TIMEOUT_MS;

		// Load extension — captures execute tool reference
		const pi = {
			registerTool: (t: { name: string; execute: ExecuteFn }) => {
				if (t.name === "subagent") this.executeTool = t.execute;
			},
		};
		extension(pi as never);
	}

	afterEach_(): void {
		for (const key of ENV_KEYS) {
			if (this.savedEnv[key] === undefined) delete process.env[key];
			else process.env[key] = this.savedEnv[key];
		}
		try { fs.rmSync(this.tmpBase, { recursive: true, force: true }); } catch { /* best-effort */ }
		vi.clearAllMocks();
		taskRegistry.clear();
	}

	async runSubagent(cwdParam?: string, extraParams?: Record<string, unknown>): Promise<any> {
		const params: Record<string, unknown> = { agent: "tester", task: "test task", sessionId: SESSION_ID };
		if (cwdParam !== undefined) params.cwd = cwdParam;
		Object.assign(params, extraParams ?? {});
		return this.executeTool!("call-1", params, undefined, undefined, { cwd: this.defaultCwd, hasUI: false });
	}

	/**
	 * Dispatch through the public execute() seam and assert the run was rejected
	 * before spawn, returning `{ result, row }` where `row` is the structured
	 * SingleResult carrying `preflightCode` / `preflightFields` — the facts the
	 * *synchronous* preflight entry produced.
	 */
	async expectRejection(
		cwdParam?: string,
		extraParams?: Record<string, unknown>,
	): Promise<{ result: any; row: any }> {
		const result = await this.runSubagent(cwdParam, extraParams);
		expect(this.spawnCalls).toHaveLength(0);
		expect(result.isError).toBe(true);
		const row = result.details?.results?.[0];
		expect(row?.preflightCode).toBeTruthy();
		return { result, row };
	}
}

/* ─── Loaded production entry points (typed against the shapes above) ───── */

type AsyncPreflightFn = (opts: {
	command: string;
	cwd: string;
	source?: "param" | "session";
	checkExists: (p: string) => Promise<boolean>;
	isDir: (p: string) => Promise<boolean>;
	hasExec: (p: string) => Promise<boolean>;
}) => Promise<PreflightResult>;

type ResolveAgentCwdFn = (opts: {
	paramCwd?: string;
	sessionCwd: string;
	homedir: string;
}) => { cwd: string; source: "param" | "session" };

async function loadExport<T>(name: string): Promise<T> {
	const mod = await import("../src/index.ts");
	const fn = (mod as Record<string, unknown>)[name];
	expect(typeof fn).toBe("function"); // RED when the export is missing/removed
	return fn as T;
}

/**
 * Probes faithful to real filesystem semantics: they surface the errno instead
 * of swallowing it into `false`. That is exactly what the production sync entry
 * sees from `fs.statSync`, so feeding these to the exported async entry is what
 * makes the two comparable on "同一组注入事实" (R2).
 */
const REAL_FS_PROBES = {
	checkExists: async (p: string) => {
		await fs.promises.stat(p);
		return true;
	},
	isDir: async (p: string) => (await fs.promises.stat(p)).isDirectory(),
	hasExec: async (p: string) => {
		await fs.promises.access(p, fs.constants.X_OK);
		return true;
	},
};

/** Build an errno-shaped error, i.e. what node:fs rejects with. */
function errnoError(code: string): NodeJS.ErrnoException {
	const err: NodeJS.ErrnoException = new Error(`injected ${code}`);
	err.code = code;
	return err;
}

/** Host probe: which errno does a real `stat` of `p` fail with (undefined = succeeded)? */
function hostStatErrno(p: string): string | undefined {
	try {
		fs.statSync(p);
		return undefined;
	} catch (err) {
		return (err as NodeJS.ErrnoException).code;
	}
}

/* ═══════════════════════════════════════════════════════════════════
 * A. CHARACTERISATION — proves the current symptom exists
 *    (Raw Node.js spawn behavior, no extension code involved)
 * ═══════════════════════════════════════════════════════════════════ */

describe("A. Characterisation: current spawn-ENOENT symptom", () => {
	// Restore all mocks for raw Node spawn; re-install happens via afterEach_ of next section.

	it("[symptom-A1] direct node:spawn with nonexistent cwd emits the misleading 'spawn … ENOENT' message", () => {
		// Pure Node characterization: proves why the bug confuses users.
		// The error blames the node execPath, which could equally mean a
		// broken Homebrew symlink or deleted Cellar — not just a missing cwd.
		const execPath = process.execPath;
		const fakeCwd = "/this/path/definitely/does/not/exist/enoent-characterisation-" + Date.now();

		let caughtMsg: string | null = null;
		const proc = _realSpawn(execPath, ["--version"], { cwd: fakeCwd, shell: false, stdio: ["ignore", "pipe", "pipe"] });
		proc.on("error", (err: NodeJS.ErrnoException) => {
			caughtMsg = String(err.message);
			proc.kill();
		});
		return new Promise<void>((resolve) => setTimeout(resolve, 50)).then(() => {
			expect(caughtMsg).toBeDefined();
			expect(caughtMsg!).toMatch(/^spawn .* ENOENT$/);
			// Key symptom: the message mentions the node path, NOT the cwd problem.
			expect(caughtMsg!).not.toContain(fakeCwd);
		});
	});
});

/* ═══════════════════════════════════════════════════════════════════
 * B. BEHAVIOURAL CONTRACT — asserts future API shapes
 *    (These fail because the functions don't exist yet.)
 * ═══════════════════════════════════════════════════════════════════ */

describe("B. Contract: resolveAgentCwd utility function must exist", () => {
	it("[contract-B1] resolveAgentCwd is a named export from the extension module", async () => {
		const mod = await import("../src/index.ts");
		expect(("resolveAgentCwd" in mod)).toBe(true); // RED: function not yet exported
	});

	it("[contract-B2] resolveAgentCwd correctly resolves ~/ relative to injected homedir", async () => {
		const mod = await import("../src/index.ts");
		const fn = (mod as any).resolveAgentCwd;
		expect(typeof fn).toBe("function");
		const result = fn({ paramCwd: "~/my/task/dir", sessionCwd: "/nonexistent/session", homedir: "/tmp/homedir-fixture" });
		expect(result.cwd).toBe("/tmp/homedir-fixture/my/task/dir");
		expect(result.source).toBe("param");
	});

	it("[contract-B3] resolveAgentCwd resolves relative paths against sessionCwd (not process.cwd())", async () => {
		const mod = await import("../src/index.ts");
		const fn = (mod as any).resolveAgentCwd;
		const result = fn({ paramCwd: "sub/tasks", sessionCwd: "/sessions/base", homedir: "/tmp/homedir" });
		expect(result.cwd).toBe(path.resolve("/sessions/base", "sub/tasks"));
		expect(result.source).toBe("param");
	});

	it("[contract-B4] when no paramCwd, falls back to sessionCwd with source=session", async () => {
		const mod = await import("../src/index.ts");
		const fn = (mod as any).resolveAgentCwd;
		const result = fn({ sessionCwd: "/some/session", homedir: "/tmp/h" });
		expect(result.cwd).toBe("/some/session");
		expect(result.source).toBe("session");
	});
});

describe("B. Contract: preflightSpawn must return structured results", () => {
	it("[contract-B5] preflightSpawn is a named export from the extension module", async () => {
		const mod = await import("../src/index.ts");
		expect(("preflightSpawn" in mod)).toBe(true);
	});

	it("[contract-B6] preflightSpawn returns { ok: false, code: 'CWD_MISSING', fields: {...} } for missing cwd", async () => {
		const mod = await import("../src/index.ts");
		const fn = (mod as any).preflightSpawn;
		expect(typeof fn).toBe("function");
		const tmpMissing = path.join(os.tmpdir(), "preflight-cwd-missing-" + Date.now());
		const result = await fn({
			command: process.execPath,
			cwd: tmpMissing,
			checkExists: async (p: string) => fs.promises.stat(p).then(() => true).catch(() => false),
			isDir: async (p: string) => {
				const s = await fs.promises.stat(p);
				return s.isDirectory();
			},
			hasExec: async (p: string) => fs.promises.access(p, fs.constants.X_OK).then(() => true).catch(() => false),
		});
		expect(result.ok).toBe(false);
		expect(result.code).toBe("CWD_MISSING");
		expect(result.fields!.command).toBeDefined();
		expect(result.fields!.cwd).toBe(tmpMissing);
		expect(result.fields!.cwdExists).toBe(false);
	});

	it("[contract-B7] preflightSpawn returns { ok: false, code: 'CWD_NOT_DIR' } when target is a file", async () => {
		const mod = await import("../src/index.ts");
		const fn = (mod as any).preflightSpawn;
		const tmpFile = path.join(os.tmpdir(), "preflight-cwd-file-" + Date.now());
		fs.writeFileSync(tmpFile, "not-a-directory", "utf-8");
		const result = await fn({
			command: process.execPath,
			cwd: tmpFile,
			checkExists: async (p: string) => fs.promises.stat(p).then(() => true).catch(() => false),
			isDir: async (p: string) => {
				const s = await fs.promises.stat(p);
				return s.isDirectory();
			},
			hasExec: async (p: string) => fs.promises.access(p, fs.constants.X_OK).then(() => true).catch(() => false),
		});
		expect(result.ok).toBe(false);
		expect(result.code).toBe("CWD_NOT_DIR");
		expect(result.fields!.cwdExists).toBe(true); // exists but wrong type
		fs.unlinkSync(tmpFile);
	});

	it("[contract-B8] preflightSpawn returns { ok: false, code: 'EXEC_MISSING' } when command path is absent", async () => {
		const mod = await import("../src/index.ts");
		const fn = (mod as any).preflightSpawn;
		const result = await fn({
			command: "/absolute/nonexistent/executable-path",
			cwd: os.tmpdir(),
			checkExists: async (p: string) => fs.promises.stat(p).then(() => true).catch(() => false),
			isDir: async (p: string) => {
				const s = await fs.promises.stat(p);
				return s.isDirectory();
			},
			hasExec: async (p: string) => fs.promises.access(p, fs.constants.X_OK).then(() => true).catch(() => false),
		});
		expect(result.ok).toBe(false);
		expect(result.code).toBe("EXEC_MISSING");
		expect(result.fields!.command).toBe("/absolute/nonexistent/executable-path");
		expect(result.message).toContain("重启"); // Chinese hint about restarting pi
	});

	it("[contract-B9] preflightSpawn returns { ok: true } for valid cwd + existing command", async () => {
		const mod = await import("../src/index.ts");
		const fn = (mod as any).preflightSpawn;
		const result = await fn({
			command: process.execPath,
			cwd: os.tmpdir(),
			checkExists: async (p: string) => fs.promises.stat(p).then(() => true).catch(() => false),
			isDir: async (p: string) => {
				const s = await fs.promises.stat(p);
				return s.isDirectory();
			},
			hasExec: async (p: string) => fs.promises.access(p, fs.constants.X_OK).then(() => true).catch(() => false),
		});
		expect(result.ok).toBe(true);
		expect(result.code).toBeUndefined();
	});
});

/* ═══════════════════════════════════════════════════════════════════
 * C. BEHAVIORAL INTEGRATION — via public execute(), real temp dirs
 *    Spawn IS mocked so we assert call counts; error logic flows
 *    through the full pipeline without the buggy behavior being fixed.
 * ═══════════════════════════════════════════════════════════════════ */

/* ═══════════════════════════════════════════════════════════════════
 * C. BEHAVIORAL INTEGRATION — via public execute(), real temp dirs
 *    Uses Fixture.spawnCalls spy (mock that returns success) to detect
 *    whether spawn was invoked. After preflight is added, spawn must NOT
 *    fire for invalid cwd inputs — this assertion proves that.
 *
 *    Note: result.isError stays undefined under the mock because mock
 *    spawn always succeeds. That's expected — the key behavioral change
 *    we're testing is "no spawn call", not the downstream isError flag.
 * ═══════════════════════════════════════════════════════════════════ */

describe("C. Behavioral integration: execute() enforces preflight before spawn", () => {
	const f = new Fixture();

	beforeEach(() => f.beforeEach_());
	afterEach(() => f.afterEach_());

	it("[c1] paramCwd → nonexistent deep dir: spawn never called after fix; cwd value present in output", async () => {
		const nonExistentDeep = path.join(f.tmpBase, "no/such/deep/nested/dir");

		const result = await f.runSubagent(nonExistentDeep);

		// Post-fix: preflight must catch this BEFORE spawn → zero calls
		expect(f.spawnCalls).toHaveLength(0);

		// Post-fix: text should mention the cwd so user knows which dir failed
		const text = result.content?.[0]?.text ?? "";
		expect(text).toContain(nonExistentDeep);
	});

	it("[c2a] paramCwd='~/...' expands correctly (target exists → success, spawn called)", async () => {
		// Create the expanded target directory under a controlled root
		const homedirReal = os.homedir();
		const expandedTarget = path.join(homedirReal, "__preflight_expand_ok__");
		fs.mkdirSync(expandedTarget, { recursive: true });
		try {
			const result = await f.runSubagent("~/__preflight_expand_ok__");
			expect(result.isError).toBe(undefined); // success path
			expect(f.spawnCalls).toHaveLength(1);
			// Post-fix: tilde should be resolved to actual homedir path
			expect((f.spawnCalls[0].options as any).cwd).toBe(expandedTarget);
		} finally {
			fs.rmSync(expandedTarget, { recursive: true, force: true });
		}
	});

	it("[c2b] paramCwd='~/...' expands correctly (target doesn't exist → spawn NOT called)", async () => {
		const nonExistentTilde = "~/__preflight_expand_missing_" + Date.now();

		const result = await f.runSubagent(nonExistentTilde);

		// Post-fix: preflight resolves tilde, finds missing dir → no spawn
		expect(f.spawnCalls).toHaveLength(0);
	});

	it("[c3] paramCwd relative path resolves against defaultCwd (the effective cwd), not process.cwd()", async () => {
		// Pass an absolute path pointing into nonexistent deep dir.
		// In the current code, effectiveCwd = paramCwd if given.
		// After fix, preflight validates it. Either way, spawn should NOT fire.
		const fakeResolved = path.join(f.tmpBase, "fake-relative-no-such-dir");

		const result = await f.runSubagent(fakeResolved);

		expect(f.spawnCalls).toHaveLength(0);
	});

	it("[c4] paramCwd points to a FILE → spawn NOT called (CWD_NOT_DIR)", async () => {
		const fileTarget = path.join(f.tmpBase, "this-is-a-file-not-a-dir.txt");
		fs.writeFileSync(fileTarget, "I am content, not a directory", "utf-8");

		const result = await f.runSubagent(fileTarget);

		// After fix: preflight sees a file, returns CWD_NOT_DIR → no spawn
		expect(f.spawnCalls).toHaveLength(0);

		fs.unlinkSync(fileTarget);
	});

	it("[c5] session cwd itself doesn't exist → CWD_MISSING attributed to source=session, no spawn", async () => {
		// R1: agent discovery must not depend on ctx.cwd, otherwise deleting the
		// session cwd makes the dispatch fail at the "unknown agent" guard and
		// `spawnCalls.length === 0` would be a FALSE green. So: the agent definition
		// is also present under the mocked getAgentDir() (see beforeEach_), and this
		// dispatch pins agentScope:"user" — project discovery (which reads ctx.cwd)
		// is skipped entirely. What is left failing is the session cwd itself,
		// i.e. `defaultCwd`, which is the value execute() actually forwards to
		// runSingleAgent (src/index.ts: runSingleAgent(defaultCwd = ctx.cwd) →
		// resolveAgentCwd({ sessionCwd: defaultCwd })).
		fs.rmSync(f.defaultCwd, { recursive: true, force: true });

		const result = await f.runSubagent(undefined, { agentScope: "user" });

		// Effect: the fallback-to-session-cwd path must be validated before spawn.
		expect(f.spawnCalls).toHaveLength(0);

		// Cause (locked, not just the symptom): a structured CWD_MISSING on the
		// result channel, pointing at the session cwd.
		expect(result.isError).toBe(true);
		const row = result.details?.results?.[0];
		// The dispatch must have got PAST agent discovery — the "unknown agent"
		// guard also leaves spawnCalls empty, which is the false green R1 warns about.
		expect(row?.agent).toBe("tester");
		expect(row?.agentSource).toBe("user");
		expect(row?.preflightCode).toBe("CWD_MISSING");
		expect(row?.preflightFields?.cwd).toBe(f.defaultCwd);
		expect(row?.preflightFields?.cwdExists).toBe(false);
		expect(row?.preflightFields?.source).toBe("session");

		// Text surfaced to the model names the code and the offending directory.
		const text = result.content?.[0]?.text ?? "";
		expect(text).toContain("[CWD_MISSING]");
		expect(text).toContain(f.defaultCwd);
		// Must not degrade into the raw Node message that started this bug.
		expect(text).not.toMatch(/spawn .* ENOENT/);
	});

	it("[c6] invalid command path → EXEC_MISSING contract verified (see B-contract)", async () => {
		// EXEC_MISSING behavior is fully tested in B. Contract section.
		// This integration-layer check verifies preflightSpawn exists:
		const mod = await import("../src/index.ts");
		const fn = (mod as any).preflightSpawn;
		expect(typeof fn).toBe("function"); // RED: will fail until implemented

		const tmpFile = path.join(os.tmpdir(), "exec-missing-command-test-" + Date.now());
		fs.writeFileSync(tmpFile, "#!/bin/bash\ntrue", "utf-8");
		fs.chmodSync(tmpFile, 0o644); // remove x bit so access(X_OK) fails
		try {
			const result = await fn({
				command: tmpFile,
				cwd: os.tmpdir(),
				checkExists: async (p: string) => fs.promises.stat(p).then(() => true).catch(() => false),
				isDir: async (p: string) => {
					const s = await fs.promises.stat(p);
					return s.isDirectory();
				},
				hasExec: async (p: string) => fs.promises.access(p, fs.constants.X_OK).then(() => true).catch(() => false),
			});
			expect(result.ok).toBe(false);
			expect(result.code).toBe("EXEC_MISSING");
			expect(result.message).toMatch(/重启|restart|kill.*all.*pi/gi);
		} finally {
			fs.unlinkSync(tmpFile);
		}
	});

	it("[c7] REAL SPAWN COUNTERMEASURE: direct spawn gives misleading ENOENT, fixed path should NOT", async () => {
		// Part 0: temporarily restore real spawn (module-level mock interferes)
		vi.restoreAllMocks();
		const rSpawn = _realSpawn;

		// Part 1: demonstrate the raw Node.js behavior
		const execPath = process.execPath;
		const bogusCwd = "/path/that/does/not/exist/subagent-enoent-countermeasure";
		let rawError: string | null = null;
		const rawProc = rSpawn(execPath, ["--version"], { cwd: bogusCwd, shell: false, stdio: ["ignore", "pipe", "pipe"] });
		rawProc.on("error", (err: NodeJS.ErrnoException) => {
			rawError = String(err.message);
			rawProc.kill();
		});
		await new Promise<void>((resolve) => setTimeout(resolve, 50));
		expect(rawError).toMatch(/^spawn .* ENOENT$/);

		// Part 2: preflight path should NOT produce the same misleading pattern
		const mod = await import("../src/index.ts");
		const fn = (mod as any).preflightSpawn;
		expect(typeof fn).toBe("function"); // RED: will fail until implemented
		const preflightResult = await fn({
			command: execPath,
			cwd: bogusCwd,
			checkExists: async (p: string) => fs.promises.stat(p).then(() => true).catch(() => false),
			isDir: async (p: string) => {
				const s = await fs.promises.stat(p);
				return s.isDirectory();
			},
			hasExec: async (p: string) => fs.promises.access(p, fs.constants.X_OK).then(() => true).catch(() => false),
		});
		expect(preflightResult.ok).toBe(false);
		expect(preflightResult.message).not.toMatch(/spawn .* ENOENT/);
	});
});

/* ═══════════════════════════════════════════════════════════════════
 * D. REGRESSION — valid paths behave exactly as they do today
 * ═══════════════════════════════════════════════════════════════════ */

describe("D. Regression: valid paths unchanged", () => {
	const f = new Fixture();

	beforeEach(() => f.beforeEach_());
	afterEach(() => f.afterEach_());

	it("[d1] explicit valid cwd: spawn occurs once with correct cwd option", async () => {
		const result = await f.runSubagent(f.defaultCwd);

		expect(result.isError).toBe(undefined); // success — no isError set
		expect(f.spawnCalls).toHaveLength(1);
		expect((f.spawnCalls[0].options as any).cwd).toBe(f.defaultCwd);
	});

	it("[d2] no cwd param: falls back to session cwd, spawn occurs", async () => {
		const result = await f.runSubagent(undefined);

		expect(result.isError).toBe(undefined); // success
		expect(f.spawnCalls).toHaveLength(1);
		expect((f.spawnCalls[0].options as any).cwd).toBe(f.defaultCwd);
	});

	it("[d3] env vars PI_SUBAGENT_DEPTH and PI_CURRENT_AGENT_NAME are set by spawn", async () => {
		await f.runSubagent(f.defaultCwd);

		expect(f.spawnCalls).toHaveLength(1);
		const env = (f.spawnCalls[0].options as any).env;
		expect(env["PI_SUBAGENT_DEPTH"]).toBe("1");
		expect(env["PI_CURRENT_AGENT_NAME"]).toBe("tester");
	});
});

/* ═══════════════════════════════════════════════════════════════════
 * E. STRUCTURED OUTPUT — isError exposes diagnostic fields
 * ═══════════════════════════════════════════════════════════════════ */

describe("E. Structured output: isError result exposes diagnostic fields", () => {
	const f = new Fixture();

	beforeEach(() => f.beforeEach_());
	afterEach(() => f.afterEach_());

	it("[e1] error result exposes isError=true + details.results with command/cwd info", async () => {
		const nonExistentCwd = path.join(f.tmpBase, "structured-output-test-no-such-dir");

		const result = await f.runSubagent(nonExistentCwd);

		// Top-level isError flag
		expect(result.isError).toBe(true);

		// Result array present in details
		expect(Array.isArray(result.details?.results)).toBe(true);
		expect(result.details!.results!.length).toBeGreaterThan(0);

		const r = result.details!.results![0];

		// After fix: stderr should contain structured codes like CWD_MISSING
		expect(r.stderr).toContain("CWD_MISSING");
		// And the content text should mention the cwd value and suggest creation
		const text = result.content?.[0]?.text ?? "";
		expect(text).toContain(nonExistentCwd);
	});

	it("[e2] success result has no isError and no error fields", async () => {
		const result = await f.runSubagent(f.defaultCwd);

		expect(result.isError).toBe(undefined);
		expect(result.details?.results?.[0].stopReason).toBeUndefined();
		expect(result.details?.results?.[0].errorMessage).toBeUndefined();
	});
});

/* ═══════════════════════════════════════════════════════════════════
 * F. R2 — THE TWO PREFLIGHT ENTRIES MUST AGREE ON THE SAME ERRNO FACTS
 *    `preflightSpawn` (exported, async, currently dead code) and the sync
 *    entry reached through execute() must map an identical errno fact to an
 *    identical `code` + `fields`. ENOENT / ENOTDIR mean "no such directory"
 *    → CWD_MISSING; anything else (EACCES, …) → CWD_INACCESSIBLE.
 *    Sync side: real path, real fs. Async side: probes that surface the very
 *    same real errno (REAL_FS_PROBES). Same path in, same facts either way.
 * ═══════════════════════════════════════════════════════════════════ */

describe("F. R2: async preflightSpawn and the sync entry must produce identical code+fields", () => {
	const f = new Fixture();

	beforeEach(() => f.beforeEach_());
	afterEach(() => f.afterEach_());

	it("[r2-enoent] stat → ENOENT maps to CWD_MISSING in BOTH entries, with identical fields", async () => {
		const missing = path.join(f.tmpBase, "parity-enoent", "deep");

		const { row: sync } = await f.expectRejection(missing);
		const preflightSpawn = await loadExport<AsyncPreflightFn>("preflightSpawn");
		// command/source are taken from the sync row so both entries really are fed
		// the same facts; only the errno handling may differ.
		const async_ = await preflightSpawn({
			command: sync.preflightFields.command,
			cwd: missing,
			source: sync.preflightFields.source,
			...REAL_FS_PROBES,
		});

		expect(async_.ok).toBe(false);
		// ENOENT means "no such directory", not "exists but inaccessible".
		expect(async_.code).toBe("CWD_MISSING");
		// Parity with the sync entry (which already says CWD_MISSING).
		expect(async_.code).toBe(sync.preflightCode);
		expect(async_.fields).toEqual(sync.preflightFields);
	});

	it("[r2-enotdir] stat → ENOTDIR (a parent component is a file) maps to CWD_MISSING in BOTH entries", async () => {
		const blocker = path.join(f.tmpBase, "parity-enotdir-blocker.txt");
		fs.writeFileSync(blocker, "I am a file, so anything below me is ENOTDIR", "utf-8");
		const underFile = path.join(blocker, "child-dir");
		try {
			const { row: sync } = await f.expectRejection(underFile);
			const preflightSpawn = await loadExport<AsyncPreflightFn>("preflightSpawn");
			const async_ = await preflightSpawn({
				command: sync.preflightFields.command,
				cwd: underFile,
				source: sync.preflightFields.source,
				...REAL_FS_PROBES,
			});

			expect(async_.ok).toBe(false);
			expect(async_.code).toBe("CWD_MISSING");
			expect(async_.code).toBe(sync.preflightCode);
			expect(async_.fields).toEqual(sync.preflightFields);
		} finally {
			fs.unlinkSync(blocker);
		}
	});
});

/* ═══════════════════════════════════════════════════════════════════
 * G. R3/R4 — CWD_INACCESSIBLE semantics
 *    The code means \"the directory is there, we just cannot get at it\", so
 *    fields.cwdExists must be true. The branch must be reachable
 *    deterministically: via an injected checker that throws EACCES (chmod 000
 *    does NOT work — the owner can still stat their own directory).
 * ═══════════════════════════════════════════════════════════════════ */

describe("G. R3/R4: CWD_INACCESSIBLE is injected-triggerable and carries cwdExists=true", () => {
	const f = new Fixture();

	beforeEach(() => f.beforeEach_());
	afterEach(() => f.afterEach_());

	it("[r3-eacces-fields] CWD_INACCESSIBLE from the stat probe reports fields.cwdExists === true", async () => {
		const preflightSpawn = await loadExport<AsyncPreflightFn>("preflightSpawn");

		const result = await preflightSpawn({
			command: process.execPath,
			cwd: "/injected/eacces/dir",
			source: "param",
			checkExists: async () => {
				throw errnoError("EACCES");
			},
			isDir: async () => true,
			hasExec: async () => true,
		});

		expect(result.ok).toBe(false);
		// Guard against an over-eager \"map every throw to CWD_MISSING\" fix.
		expect(result.code).toBe("CWD_INACCESSIBLE");
		// R3: "exists but cannot be accessed" — cwdExists must say true.
		expect(result.fields?.cwdExists).toBe(true);
		expect(result.fields?.cwd).toBe("/injected/eacces/dir");
	});

	it("[r3-eacces-isdir] CWD_INACCESSIBLE from the isDir probe reports fields.cwdExists === true", async () => {
		const preflightSpawn = await loadExport<AsyncPreflightFn>("preflightSpawn");

		const result = await preflightSpawn({
			command: process.execPath,
			cwd: "/injected/eacces/after-stat",
			source: "session",
			checkExists: async () => true,
			isDir: async () => {
				throw errnoError("EACCES");
			},
			hasExec: async () => true,
		});

		expect(result.ok).toBe(false);
		expect(result.code).toBe("CWD_INACCESSIBLE");
		expect(result.fields?.cwdExists).toBe(true);
		expect(result.fields?.source).toBe("session");
	});

	it("[r4-real-eacces] a path the current uid cannot even stat is CWD_INACCESSIBLE, not CWD_MISSING", async () => {
		// R4: no chmod 000 here — on macOS/Linux the owner can still stat a 0700
		// directory they own, so that recipe yields no EACCES at all. /private/var/
		// root is root:wheel 0700, so the *lookup* of a name inside it fails with
		// EACCES for an unprivileged uid.
		const probe = path.join("/private/var/root", "__preflight_eacces_probe__");
		const hostErrno = hostStatErrno(probe);
		const preflightSpawn = await loadExport<AsyncPreflightFn>("preflightSpawn");

		let result: PreflightResult;
		if (hostErrno === "EACCES") {
			// Real fs facts, faithful probes.
			result = await preflightSpawn({
				command: process.execPath,
				cwd: probe,
				source: "param",
				...REAL_FS_PROBES,
			});
		} else {
			// Host-dependent half unavailable (running as root, or no
			// /private/var/root). Fall back to the deterministic injected EACCES
			// instead of it.skip(): the case always exercises the permission
			// branch, so it can never silently stop testing anything.
			result = await preflightSpawn({
				command: process.execPath,
				cwd: probe,
				source: "param",
				checkExists: async () => {
					throw errnoError("EACCES");
				},
				isDir: async () => true,
				hasExec: async () => true,
			});
		}

		expect(result.code).toBe("CWD_INACCESSIBLE");
		expect(result.fields?.cwd).toBe(probe);
		expect(result.fields?.cwdExists).toBe(true); // R3

		if (hostErrno === "EACCES") {
			// Same real EACCES fact through the production (sync) entry: same code.
			const { row: sync } = await f.expectRejection(probe);
			expect(sync.preflightCode).toBe("CWD_INACCESSIBLE");
			expect(sync.preflightFields.cwd).toBe(probe);
			expect(sync.preflightFields.cwdExists).toBe(true); // R3
		}
	});
});

/* ═══════════════════════════════════════════════════════════════════
 * H. R5 — an empty / whitespace-only cwd param means "no cwd param"
 * ═══════════════════════════════════════════════════════════════════ */

describe("H. R5: blank cwd param normalizes to the session cwd with source=session", () => {
	const SESSION = path.join(path.sep, "sessions", "base");
	const HOME = path.join(path.sep, "tmp", "homedir-fixture");

	it("[r5-empty] paramCwd='' returns the session cwd verbatim and source='session'", async () => {
		const resolveAgentCwd = await loadExport<ResolveAgentCwdFn>("resolveAgentCwd");

		expect(resolveAgentCwd({ paramCwd: "", sessionCwd: SESSION, homedir: HOME })).toEqual({
			cwd: SESSION,
			source: "session",
		});
	});

	it("[r5-whitespace-only] paramCwd='   ' returns the session cwd verbatim and source='session'", async () => {
		const resolveAgentCwd = await loadExport<ResolveAgentCwdFn>("resolveAgentCwd");

		expect(resolveAgentCwd({ paramCwd: "   ", sessionCwd: SESSION, homedir: HOME })).toEqual({
			cwd: SESSION,
			source: "session",
		});
	});

	describe("via the public execute() seam", () => {
		const f = new Fixture();

		beforeEach(() => f.beforeEach_());
		afterEach(() => f.afterEach_());

		it("[r5-blank-dispatch] dispatch with cwd='' behaves exactly like omitting it (spawn at session cwd)", async () => {
			const result = await f.runSubagent("");

			expect(result.isError).toBe(undefined);
			expect(f.spawnCalls).toHaveLength(1);
			expect((f.spawnCalls[0].options as any).cwd).toBe(f.defaultCwd);
		});
	});
});

/* ═══════════════════════════════════════════════════════════════════
 * I. R6 — `~user/x` (tilde immediately followed by a non-separator) is NOT
 *    supported: no expansion, no lying about it, hard CWD_MISSING.
 *    (Deliberately no os.userInfo()/getent lookup is introduced for this.)
 * ═══════════════════════════════════════════════════════════════════ */

describe("I. R6: '~user/x' is not expanded and must be rejected as CWD_MISSING", () => {
	const SESSION = path.join(path.sep, "sessions", "base");
	const HOME = path.join(path.sep, "tmp", "homedir-fixture");

	it("[r6-no-expansion] resolveAgentCwd keeps '~someone/x' literal-bound: no homedir substitution", async () => {
		const resolveAgentCwd = await loadExport<ResolveAgentCwdFn>("resolveAgentCwd");

		const result = resolveAgentCwd({ paramCwd: "~someone/x", sessionCwd: SESSION, homedir: HOME });

		// Not expanded into someone's home …
		expect(result.cwd).not.toBe(path.join(HOME, "someone", "x"));
		expect(result.cwd.startsWith(HOME + path.sep)).toBe(false);
		// … the untouched literal is what gets validated …
		expect(result.cwd).toContain("~someone/x");
		// … and a param really was supplied, so the source must not claim session.
		expect(result.source).toBe("param");
	});

	describe("via the public execute() seam", () => {
		const f = new Fixture();

		beforeEach(() => f.beforeEach_());
		afterEach(() => f.afterEach_());

		it("[r6-dispatch] dispatch with cwd='~someone/projects' → no spawn, CWD_MISSING naming the literal", async () => {
			const { result, row } = await f.expectRejection("~someone/projects");

			expect(row.preflightCode).toBe("CWD_MISSING");
			expect(row.preflightFields.cwdExists).toBe(false);
			const text = result.content?.[0]?.text ?? "";
			expect(text).toContain("[CWD_MISSING]");
			expect(text).toContain("~someone/projects");
			// Must not pretend the path landed under the real home directory.
			expect(text).not.toContain(path.join(os.homedir(), "someone"));
		});
	});
});

/* ═══════════════════════════════════════════════════════════════════
 * J. G1 — D4: the `path.isAbsolute(command)` guard must never be lost.
 *    `getPiInvocation()` (src/index.ts:1980) falls back to the BARE name "pi"
 *    whenever pi was started through a generic `node` binary whose entry script
 *    is gone. A bare name resolves via PATH *inside* spawn(2), so access(X_OK)
 *    on the literal string "pi" is guaranteed to fail — checking it would turn
 *    every single normal session into EXEC_MISSING. That guard is the only line
 *    of defence, and until now nothing had teeth for it: removing
 *    `path.isAbsolute(…)` from both preflight entries kept all 738 tests green
 *    (blind review, 2026-08-28), because every existing case feeds an ABSOLUTE
 *    command (process.execPath) — vitest's own `process.argv[1]` exists, so
 *    production code never took the bare-name branch either.
 *
 *    Four locks, one per entry × per observable:
 *      [g1-async-*]  exported preflightSpawn  → OK + hasExec never consulted
 *      [g1-spawn-*]  real execute() dispatch  → spawn really fires with "pi"
 *    Mutation-checked in a throwaway copy of the repo (both guards removed);
 *    see the task hand-off notes.
 * ═══════════════════════════════════════════════════════════════════ */

describe("J. G1/D4: bare command names are never X_OK-checked", () => {
	const f = new Fixture();

	beforeEach(() => f.beforeEach_());
	afterEach(() => f.afterEach_());

	/** Force `getPiInvocation()` into branch 3 (bare "pi"): the entry script in
	 *  process.argv[1] must not exist and process.execPath must look like a
	 *  generic runtime. Both globals are restored before returning. */
	async function dispatchWithBareCommand(cwdParam?: string, extraParams?: Record<string, unknown>): Promise<any> {
		const prevArgv1 = process.argv[1];
		const prevExecPath = process.execPath;
		process.argv[1] = path.join(f.tmpBase, "pi-entry-script-already-gone.js");
		process.execPath = path.join(path.sep, "opt", "generic-runtime", "bin", "node");
		try {
			return await f.runSubagent(cwdParam, extraParams);
		} finally {
			process.argv[1] = prevArgv1;
			process.execPath = prevExecPath;
		}
	}

	/** Would `spawn("pi")`'s PATH lookup be the only thing that could make an
	 *  access(X_OK) on the literal bare name succeed? If the repo cwd happens to
	 *  contain an executable file named "pi", the sync-entry lock below has no
	 *  teeth on this host and must say so instead of passing vacuously. */
	function bareNameIsExecutableHere(name: string): boolean {
		try {
			fs.accessSync(name, fs.constants.X_OK);
			return true;
		} catch {
			return false;
		}
	}

	it("[g1-async-bare-false] preflightSpawn says OK for a bare command even though hasExec would answer false", async () => {
		const preflightSpawn = await loadExport<AsyncPreflightFn>("preflightSpawn");
		const hasExec = vi.fn(async () => true as boolean);
		hasExec.mockImplementation(async () => false);

		const result = await preflightSpawn({
			command: "pi",
			cwd: "/injected/bare-command/dir",
			source: "param",
			checkExists: async () => true,
			isDir: async () => true,
			hasExec,
		});

		expect(result.ok).toBe(true);
		expect(result.code).toBeUndefined();
		// D4 as an observable: the exec probe must not even be consulted for a
		// bare name (an absolute-path command must still be checked — locked by
		// [contract-B8] and the EXEC rows of the truth table below).
		expect(hasExec).not.toHaveBeenCalled();
	});

	it("[g1-async-bare-throws] preflightSpawn says OK for a bare command even when hasExec would throw ENOENT", async () => {
		const preflightSpawn = await loadExport<AsyncPreflightFn>("preflightSpawn");
		const hasExec = vi.fn(async () => {
			throw errnoError("ENOENT");
		});

		const result = await preflightSpawn({
			command: "pi",
			cwd: "/injected/bare-command/dir",
			source: "param",
			checkExists: async () => true,
			isDir: async () => true,
			hasExec,
		});

		expect(result.ok).toBe(true);
		expect(result.code).toBeUndefined();
		expect(hasExec).not.toHaveBeenCalled();
	});

	it("[g1-spawn-bare-ok] production dispatch with a bare command still spawns (no EXEC_MISSING)", async () => {
		// Precondition, not an implementation assertion: "pi" must NOT be an
		// executable file in process.cwd(), otherwise the mutant we are guarding
		// against would pass this test by accident on that host.
		expect(bareNameIsExecutableHere("pi")).toBe(false);
		expect(fs.existsSync(path.join(f.tmpBase, "pi-entry-script-already-gone.js"))).toBe(false);

		const result = await dispatchWithBareCommand(f.defaultCwd);

		// The bare-name branch really was taken (otherwise this proves nothing).
		expect(f.spawnCalls).toHaveLength(1);
		expect(path.isAbsolute(f.spawnCalls[0].command)).toBe(false);
		expect(f.spawnCalls[0].command).toBe("pi");
		expect((f.spawnCalls[0].options as any).cwd).toBe(f.defaultCwd);

		// And the run is a success: no preflight verdict of any kind.
		expect(result.isError).toBe(undefined);
		const row = result.details?.results?.[0];
		expect(row?.preflightCode).toBeUndefined();
		expect(row?.preflightFields).toBeUndefined();
		expect(row?.errorMessage).toBeUndefined();
		const text = result.content?.[0]?.text ?? "";
		expect(text).not.toContain("EXEC_MISSING");
	});

	it("[g1-spawn-bare-cwd-missing] the bare-name exemption must not skip the cwd checks", async () => {
		const missing = path.join(f.tmpBase, "bare-command-but-missing-cwd");

		const result = await dispatchWithBareCommand(missing);

		// A bare command name only waives the EXEC check — never the cwd one.
		// (Guards against "if (!path.isAbsolute(command)) return OK" as a
		// mis-guided way of implementing D4.)
		expect(f.spawnCalls).toHaveLength(0);
		expect(result.isError).toBe(true);
		const row = result.details?.results?.[0];
		expect(row?.preflightCode).toBe("CWD_MISSING");
		expect(row?.preflightFields?.cwd).toBe(missing);
		expect(row?.preflightFields?.cwdExists).toBe(false);
	});
});

/* ═══════════════════════════════════════════════════════════════════
 * K. G2 — THE EXHAUSTIVE PREFLIGHT TRUTH TABLE (T-C).
 *    One row = one combination of injected facts; every cwd/exec probe either
 *    returns a boolean (a *determination*) or throws (a *failed probe*, with or
 *    without `.code`). The two must never be collapsed into the same fact —
 *    that collapse is exactly the ENOENT-vs-EACCES bug this whole change set
 *    exists for, and it is still present in two cells (see RED list).
 *
 *    Rules the rows encode (parent-ruled contract, 2026-08-28):
 *      R-a  ENOENT/ENOTDIR from ANY cwd probe  → CWD_MISSING (native semantics:
 *           "this path is not a directory that exists").
 *      R-b  any other errno, or a throw with no errno at all → CWD_INACCESSIBLE
 *           with fields.cwdExists === true: while the probe is broken we cannot
 *           claim the directory is absent.
 *      R-c  a probe that THREW is never read as "probe answered false", so a
 *           thrown probe can never fall through to OK (fail-open).
 *      R-d  cwd facts outrank command facts whenever both are bad.
 *      R-e  the exec check applies to absolute commands only (D4, cf. [J]).
 *
 *    K also carries the focused anti-fail-open lock [g2-never-ok-when-probe-threw]
 *    and the sync-entry real-fs parity rows [g2-sync-*] (preflightSpawnSync has
 *    no injectable probes, so those run against real filesystem facts).
 * ═══════════════════════════════════════════════════════════════════ */

type PreflightCodeLocal = "CWD_MISSING" | "CWD_NOT_DIR" | "CWD_INACCESSIBLE" | "EXEC_MISSING";

/** A probe's observable behaviour: `{ret}` = it answered; `{errno}` = it threw an
 *  ErrnoException; `{noErrno}` = it threw something with no `.code` field at all
 *  (what a non-fs failure — or a future wrapper — looks like); `{nonBoolean}` =
 *  it returned a value that is not a boolean (a lying probe must not be read as
 *  "yes"). */
type ProbeSpec = { ret: boolean } | { errno: string } | { noErrno: true } | { nonBoolean: unknown };

const PROBE_CWD = "/injected-facts/cwd";
const ABS_COMMAND = process.execPath;
const BARE_COMMAND = "pi";

interface TruthRow {
	id: string;
	fact: string;
	command: string;
	source: "param" | "session";
	checkExists: ProbeSpec;
	isDir: ProbeSpec;
	hasExec: ProbeSpec;
	code: PreflightCodeLocal;
	cwdExists: boolean;
	message?: RegExp;
	/** When true, the exec probe must not be consulted (cwd already failed). */
	execUnchecked?: boolean;
}

/**
 * Hand-off contract for the implementation round (what the rows below require,
 * stated once so `coder` does not have to reverse-engineer it from 26 cases):
 *
 *   1. "A probe threw" is a fact of its own — it must be recorded, not inferred
 *      from `cwdErrno === undefined`. Minimal shape (inside PreflightFacts):
 *        cwdProbeFailed?: boolean;   // default false; true = stat/isDir threw
 *        cwdErrno?: string;          // verbatim errno, "EUNKNOWN" when absent
 *      The existing injected signature (checkExists/isDir/hasExec →
 *      Promise<boolean>, allowed to throw) must NOT change — [contract-B5..B9],
 *      [r2-*], [r3-*] and every row below feed probes through it.
 *   2. OK requires cwdIsDir === true, i.e. a *positive determination*. `!== false`
 *      is the bug: an `undefined` left behind by a throwing probe is not a yes.
 *   3. Classification of a failed probe: ENOENT/ENOTDIR → CWD_MISSING;
 *      every other errno, and "no errno at all" → CWD_INACCESSIBLE with
 *      fields.cwdExists === true.
 */
const REJECT_ROWS: TruthRow[] = [
	// --- checkExists: "answered no" vs "threw" (the R-a/R-b/R-c frontier) ---
	{ id: "ce-false", fact: "checkExists returned false (determined: absent)", command: ABS_COMMAND, source: "param", checkExists: { ret: false }, isDir: { ret: true }, hasExec: { ret: true }, code: "CWD_MISSING", cwdExists: false },
	{ id: "ce-enoent", fact: "checkExists threw ENOENT", command: ABS_COMMAND, source: "param", checkExists: { errno: "ENOENT" }, isDir: { ret: true }, hasExec: { ret: true }, code: "CWD_MISSING", cwdExists: false },
	{ id: "ce-enotdir", fact: "checkExists threw ENOTDIR", command: ABS_COMMAND, source: "param", checkExists: { errno: "ENOTDIR" }, isDir: { ret: true }, hasExec: { ret: true }, code: "CWD_MISSING", cwdExists: false },
	{ id: "ce-eacces", fact: "checkExists threw EACCES (absent? unknown — do not lie)", command: ABS_COMMAND, source: "param", checkExists: { errno: "EACCES" }, isDir: { ret: true }, hasExec: { ret: true }, code: "CWD_INACCESSIBLE", cwdExists: true, message: /errno=EACCES/ },
	{ id: "ce-eloop", fact: "checkExists threw ELOOP", command: ABS_COMMAND, source: "param", checkExists: { errno: "ELOOP" }, isDir: { ret: true }, hasExec: { ret: true }, code: "CWD_INACCESSIBLE", cwdExists: true, message: /errno=ELOOP/ },
	{ id: "ce-enametoolong", fact: "checkExists threw ENAMETOOLONG", command: ABS_COMMAND, source: "param", checkExists: { errno: "ENAMETOOLONG" }, isDir: { ret: true }, hasExec: { ret: true }, code: "CWD_INACCESSIBLE", cwdExists: true, message: /errno=ENAMETOOLONG/ },
	{ id: "ce-estale", fact: "checkExists threw ESTALE", command: ABS_COMMAND, source: "param", checkExists: { errno: "ESTALE" }, isDir: { ret: true }, hasExec: { ret: true }, code: "CWD_INACCESSIBLE", cwdExists: true, message: /errno=ESTALE/ },
	// ✗ RED today: cwdErrno stays undefined → the "no errno = determined absent"
	// shortcut maps a *broken probe* to CWD_MISSING.
	{ id: "ce-noerrno", fact: "checkExists threw WITHOUT an errno (.code absent)", command: ABS_COMMAND, source: "param", checkExists: { noErrno: true }, isDir: { ret: true }, hasExec: { ret: true }, code: "CWD_INACCESSIBLE", cwdExists: true, message: /errno=(e?unknown)/i },

	// --- isDir (only reached once checkExists positively determined "there") ---
	{ id: "isdir-false", fact: "checkExists true + isDir returned false (determined: not a dir)", command: ABS_COMMAND, source: "param", checkExists: { ret: true }, isDir: { ret: false }, hasExec: { ret: true }, code: "CWD_NOT_DIR", cwdExists: true },
	{ id: "isdir-eacces", fact: "checkExists true + isDir threw EACCES", command: ABS_COMMAND, source: "session", checkExists: { ret: true }, isDir: { errno: "EACCES" }, hasExec: { ret: true }, code: "CWD_INACCESSIBLE", cwdExists: true, message: /errno=EACCES/ },
	{ id: "isdir-enametoolong", fact: "checkExists true + isDir threw ENAMETOOLONG", command: ABS_COMMAND, source: "param", checkExists: { ret: true }, isDir: { errno: "ENAMETOOLONG" }, hasExec: { ret: true }, code: "CWD_INACCESSIBLE", cwdExists: true, message: /errno=ENAMETOOLONG/ },
	// ✗ RED today. Contract-rule R-a wins over R-b here: ENOENT/ENOTDIR carries a
	// native meaning ("nothing at this path" / "a parent component is a file"), so
	// a late throw from isDir — the directory vanished between the two probes — is
	// CWD_MISSING, not "exists but inaccessible". (Row 2 of the ruled contract
	// table outranks row 6 for these two errnos; both agree it must not be OK.)
	{ id: "isdir-enoent", fact: "checkExists true + isDir threw ENOENT (rmdir'd in between)", command: ABS_COMMAND, source: "param", checkExists: { ret: true }, isDir: { errno: "ENOENT" }, hasExec: { ret: true }, code: "CWD_MISSING", cwdExists: false },
	{ id: "isdir-enotdir", fact: "checkExists true + isDir threw ENOTDIR", command: ABS_COMMAND, source: "param", checkExists: { ret: true }, isDir: { errno: "ENOTDIR" }, hasExec: { ret: true }, code: "CWD_MISSING", cwdExists: false },
	// ✗✗ THE FAIL-OPEN CELL: today the decision falls through every branch and
	// returns OK, i.e. spawns into a cwd nothing was ever determined about.
	{ id: "isdir-noerrno", fact: "checkExists true + isDir threw WITHOUT an errno", command: ABS_COMMAND, source: "param", checkExists: { ret: true }, isDir: { noErrno: true }, hasExec: { ret: true }, code: "CWD_INACCESSIBLE", cwdExists: true, message: /errno=(e?unknown)/i },

	// --- isDir returns a non-boolean value (lying probe: must not be read as "yes") ---
	{ id: "isdir-undefined", fact: "checkExists true + isDir returned undefined (no throw)", command: ABS_COMMAND, source: "param", checkExists: { ret: true }, isDir: { nonBoolean: undefined }, hasExec: { ret: true }, code: "CWD_INACCESSIBLE", cwdExists: true, message: /errno=(e?unknown)/i, execUnchecked: true },
	{ id: "isdir-null", fact: "checkExists true + isDir returned null", command: ABS_COMMAND, source: "param", checkExists: { ret: true }, isDir: { nonBoolean: null }, hasExec: { ret: true }, code: "CWD_INACCESSIBLE", cwdExists: true, message: /errno=(e?unknown)/i, execUnchecked: true },
	{ id: "isdir-zero", fact: "checkExists true + isDir returned 0 (falsy non-boolean)", command: ABS_COMMAND, source: "param", checkExists: { ret: true }, isDir: { nonBoolean: 0 }, hasExec: { ret: true }, code: "CWD_INACCESSIBLE", cwdExists: true, message: /errno=(e?unknown)/i, execUnchecked: true },
	{ id: "isdir-yes", fact: "checkExists true + isDir returned string 'yes' (truthy non-boolean)", command: ABS_COMMAND, source: "param", checkExists: { ret: true }, isDir: { nonBoolean: "yes" }, hasExec: { ret: true }, code: "CWD_INACCESSIBLE", cwdExists: true, message: /errno=(e?unknown)/i, execUnchecked: true },

	// --- exec facts (cwd was determined to be a real directory) ---
	{ id: "exec-false", fact: "absolute command, hasExec returned false", command: ABS_COMMAND, source: "param", checkExists: { ret: true }, isDir: { ret: true }, hasExec: { ret: false }, code: "EXEC_MISSING", cwdExists: true },
	{ id: "exec-enoent", fact: "absolute command, hasExec threw ENOENT", command: ABS_COMMAND, source: "param", checkExists: { ret: true }, isDir: { ret: true }, hasExec: { errno: "ENOENT" }, code: "EXEC_MISSING", cwdExists: true, message: /errno=ENOENT/ },
	{ id: "exec-eacces", fact: "absolute command, hasExec threw EACCES (no x bit)", command: ABS_COMMAND, source: "param", checkExists: { ret: true }, isDir: { ret: true }, hasExec: { errno: "EACCES" }, code: "EXEC_MISSING", cwdExists: true, message: /errno=EACCES/ },
	{ id: "exec-noerrno", fact: "absolute command, hasExec threw WITHOUT an errno", command: ABS_COMMAND, source: "param", checkExists: { ret: true }, isDir: { ret: true }, hasExec: { noErrno: true }, code: "EXEC_MISSING", cwdExists: true, message: /errno=(e?unknown)/i },

	// --- a bare command name never reaches the exec check, but every cwd fact
	//     below still decides exactly the same way (D4 has no side effects) ---
	{ id: "bare-ce-false", fact: "bare command + checkExists returned false", command: BARE_COMMAND, source: "param", checkExists: { ret: false }, isDir: { ret: true }, hasExec: { ret: false }, code: "CWD_MISSING", cwdExists: false },
	{ id: "bare-isdir-false", fact: "bare command + isDir returned false", command: BARE_COMMAND, source: "session", checkExists: { ret: true }, isDir: { ret: false }, hasExec: { ret: false }, code: "CWD_NOT_DIR", cwdExists: true },
	{ id: "bare-ce-eacces", fact: "bare command + checkExists threw EACCES", command: BARE_COMMAND, source: "param", checkExists: { errno: "EACCES" }, isDir: { ret: true }, hasExec: { ret: false }, code: "CWD_INACCESSIBLE", cwdExists: true, message: /errno=EACCES/ },

	// --- R-d: cwd outranks command on purpose ---
	{ id: "prio-missing-vs-exec", fact: "cwd absent AND command not executable", command: ABS_COMMAND, source: "param", checkExists: { ret: false }, isDir: { ret: true }, hasExec: { ret: false }, code: "CWD_MISSING", cwdExists: false },
	{ id: "prio-notdir-vs-exec", fact: "cwd is a file AND command not executable", command: ABS_COMMAND, source: "param", checkExists: { ret: true }, isDir: { ret: false }, hasExec: { ret: false }, code: "CWD_NOT_DIR", cwdExists: true },
	{ id: "prio-inaccessible-vs-exec", fact: "isDir threw EACCES AND command not executable", command: ABS_COMMAND, source: "param", checkExists: { ret: true }, isDir: { errno: "EACCES" }, hasExec: { ret: false }, code: "CWD_INACCESSIBLE", cwdExists: true },
	// A thrown checkExists outranks an `isDir` that says false: the isDir answer
	// is meaningless once the existence probe is broken (and calling it at all
	// would be a second lie).
	{ id: "prio-throw-vs-false", fact: "checkExists threw EACCES + isDir returned false", command: ABS_COMMAND, source: "param", checkExists: { errno: "EACCES" }, isDir: { ret: false }, hasExec: { ret: true }, code: "CWD_INACCESSIBLE", cwdExists: true },
	{ id: "prio-noerrno-vs-false", fact: "checkExists threw without errno + isDir returned false", command: ABS_COMMAND, source: "param", checkExists: { noErrno: true }, isDir: { ret: false }, hasExec: { ret: true }, code: "CWD_INACCESSIBLE", cwdExists: true, message: /errno=(e?unknown)/i },
];

const ALLOW_ROWS: Array<{
	id: string;
	fact: string;
	command: string;
	checkExists: ProbeSpec;
	isDir: ProbeSpec;
	hasExec: ProbeSpec;
	/** D4: for a bare command the exec probe must not be consulted at all. */
	execUnchecked: boolean;
}> = [
	{ id: "all-probes-good", fact: "cwd determined to be an existing directory + absolute command executable", command: ABS_COMMAND, checkExists: { ret: true }, isDir: { ret: true }, hasExec: { ret: true }, execUnchecked: false },
	{ id: "bare-exec-false", fact: "bare command + hasExec would answer false → exec check skipped, OK", command: BARE_COMMAND, checkExists: { ret: true }, isDir: { ret: true }, hasExec: { ret: false }, execUnchecked: true },
	{ id: "bare-exec-throws", fact: "bare command + hasExec would throw → exec check skipped, OK", command: BARE_COMMAND, checkExists: { ret: true }, isDir: { ret: true }, hasExec: { errno: "ENOENT" }, execUnchecked: true },
];

/** Turn an injected fact into a probe implementation. */
function probeFrom(spec: ProbeSpec): (p: string) => Promise<boolean> {
	if ("ret" in spec) return async () => spec.ret;
	if ("nonBoolean" in spec) return async () => spec.nonBoolean as any;
	if ("noErrno" in spec)
		return async () => {
			throw new Error("injected probe failure without an errno (no .code)");
		};
	return async () => {
		throw errnoError(spec.errno);
	};
}

describe("K. G2: exhaustive cwd-probe truth table (probe threw ≠ probe answered no)", () => {
	it.each(REJECT_ROWS.map((row) => [row.id, row.fact, row.code, row] as const))(
		"[g2-truth|%s] %s ⇒ %s",
		async (_id: string, _fact: string, _code: string, row: TruthRow) => {
			const preflightSpawn = await loadExport<AsyncPreflightFn>("preflightSpawn");
			const hasExec = vi.fn(probeFrom(row.hasExec));

			const result = await preflightSpawn({
				command: row.command,
				cwd: PROBE_CWD,
				source: row.source,
				checkExists: probeFrom(row.checkExists),
				isDir: probeFrom(row.isDir),
				hasExec,
			});

			expect(result.ok).toBe(false);
			expect(result.code).toBe(row.code);
			// fields must carry the same verdict the code does — no half-truths.
			expect(result.fields?.cwd).toBe(PROBE_CWD);
			expect(result.fields?.command).toBe(row.command);
			expect(result.fields?.source).toBe(row.source);
			expect(result.fields?.cwdExists).toBe(row.cwdExists);
			if (row.message) expect(result.message).toMatch(row.message);
			// When the cwd check does not positively determine a directory, the exec
			// probe must not be consulted (locks the "isDir lied" class).
			if (row.execUnchecked) expect(hasExec).not.toHaveBeenCalled();
		},
	);

	it.each(ALLOW_ROWS.map((row) => [row.id, row.fact, row] as const))(
		"[g2-truth|ok-%s] %s ⇒ OK",
		async (_id: string, _fact: string, row: (typeof ALLOW_ROWS)[number]) => {
			const preflightSpawn = await loadExport<AsyncPreflightFn>("preflightSpawn");
			const hasExec = vi.fn(probeFrom(row.hasExec));

			const result = await preflightSpawn({
				command: row.command,
				cwd: PROBE_CWD,
				source: "param",
				checkExists: probeFrom(row.checkExists),
				isDir: probeFrom(row.isDir),
				hasExec,
			});

			expect(result.ok).toBe(true);
			expect(result.code).toBeUndefined();
			if (row.execUnchecked) expect(hasExec).not.toHaveBeenCalled();
		},
	);

	it("[g2-never-ok-when-probe-threw] the three isDir facts must stay three distinguishable verdicts", async () => {
		// "isDir said no", "isDir could not tell us (EACCES)" and "isDir could not
		// tell us (no errno)" are three different facts. Collapsing any pair — in
		// particular collapsing the third one into OK — is the regression this
		// locks out.
		const preflightSpawn = await loadExport<AsyncPreflightFn>("preflightSpawn");
		const verdict = async (isDir: ProbeSpec) =>
			preflightSpawn({
				command: ABS_COMMAND,
				cwd: PROBE_CWD,
				source: "param",
				checkExists: async () => true,
				isDir: probeFrom(isDir),
				hasExec: async () => true,
			});

		const answeredNo = await verdict({ ret: false });
		const threwEacces = await verdict({ errno: "EACCES" });
		const threwNoErrno = await verdict({ noErrno: true });

		expect(answeredNo.code).toBe("CWD_NOT_DIR");
		expect(threwEacces.code).toBe("CWD_INACCESSIBLE");
		expect(threwNoErrno.code).toBe("CWD_INACCESSIBLE");
		// The invariant, stated separately from any single cell of the table:
		// a probe that threw can never produce a green light.
		expect(threwNoErrno.ok).toBe(false);
		expect(threwEacces.ok).toBe(false);
		// …and the two failures must remain distinguishable from each other.
		expect(threwNoErrno.message).toMatch(/errno=/);
		expect(threwEacces.message).toMatch(/errno=EACCES/);
		expect(threwNoErrno.message).not.toMatch(/errno=EACCES/);
	});

	describe("sync entry (preflightSpawnSync via execute()) — real filesystem facts", () => {
		const f = new Fixture();

		beforeEach(() => f.beforeEach_());
		afterEach(() => f.afterEach_());

		it("[g2-sync-enametoolong] a cwd whose stat fails with ENAMETOOLONG is CWD_INACCESSIBLE, never CWD_MISSING", async () => {
			// The one "other errno" a real filesystem supplies deterministically
			// (NAME_MAX is 255 on macOS and Linux). Precondition asserted first so
			// a host that cannot produce the fact fails loudly instead of passing
			// vacuously.
			const tooLong = path.join(f.tmpBase, "x".repeat(300));
			expect(hostStatErrno(tooLong)).toBe("ENAMETOOLONG");

			const { result, row } = await f.expectRejection(tooLong);

			expect(row.preflightCode).toBe("CWD_INACCESSIBLE");
			expect(row.preflightFields.cwd).toBe(tooLong);
			// Honesty rule R-b: undetermined existence must not be reported as absent.
			expect(row.preflightFields.cwdExists).toBe(true);
			const text = result.content?.[0]?.text ?? "";
			expect(text).toContain("[CWD_INACCESSIBLE]");
			expect(text).not.toContain("[CWD_MISSING]");
		});

		it("[g2-sync-file-cwd-fields] a cwd that is a file reports CWD_NOT_DIR with cwdExists=true (strengthens [c4])", async () => {
			const fileTarget = path.join(f.tmpBase, "g2-sync-this-is-a-file.txt");
			fs.writeFileSync(fileTarget, "not a directory", "utf-8");
			try {
				const { row } = await f.expectRejection(fileTarget);

				expect(row.preflightCode).toBe("CWD_NOT_DIR");
				expect(row.preflightFields.cwd).toBe(fileTarget);
				expect(row.preflightFields.cwdExists).toBe(true);
				expect(row.preflightFields.source).toBe("param");
			} finally {
				fs.unlinkSync(fileTarget);
			}
		});
	});
});
