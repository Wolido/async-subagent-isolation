import { describe, expect, it, vi, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { loadAgentsFromDir } from "../src/index.ts";

// Only mock getAgentDir (module boundary: user-level config dir).
// parseFrontmatter must stay REAL so YAML syntax errors surface authentically.
vi.mock("@earendil-works/pi-coding-agent", async () => {
	const actual = await vi.importActual("@earendil-works/pi-coding-agent");
	return {
		...actual,
		getAgentDir: vi.fn(),
	};
});

const GOOD_MD = `---
name: good
description: A good agent
---
You are a good agent.
`;

function makeTmpAgentsDir(): string {
	const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-loading-"));
	const agentsDir = path.join(tmpDir, ".pi", "agents");
	fs.mkdirSync(agentsDir, { recursive: true });
	return agentsDir;
}

function collectWarnText(spy: ReturnType<typeof vi.spyOn>): string {
	return spy.mock.calls.map((args) => args.map(String).join(" ")).join("\n");
}

describe("A: single bad file must not break loading of valid agents in the same dir", () => {
	let agentsDir: string;

	afterEach(() => {
		vi.restoreAllMocks();
		if (agentsDir) fs.rmSync(path.dirname(path.dirname(agentsDir)), { recursive: true, force: true });
	});

	it("should load only the valid agent, not throw, and warn about the bad file", () => {
		// Arrange
		agentsDir = makeTmpAgentsDir();
		fs.writeFileSync(path.join(agentsDir, "good.md"), GOOD_MD);
		fs.writeFileSync(
			path.join(agentsDir, "bad.md"),
			`---
name: bad
description: foo: bar
---
Bad agent body.
`,
		);
		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

		// Act
		let agents: ReturnType<typeof loadAgentsFromDir> | undefined;
		let thrown: unknown;
		try {
			agents = loadAgentsFromDir(agentsDir, "user");
		} catch (err) {
			thrown = err;
		}

		// Assert
		expect(thrown).toBeUndefined();
		expect(agents).toHaveLength(1);
		expect(agents![0].name).toBe("good");
		expect(warnSpy).toHaveBeenCalled();
		const warnText = collectWarnText(warnSpy);
		expect(warnText).toContain("bad.md");
		expect(warnText).toMatch(/parse|frontmatter|YAML/i);
	});
});

describe("B: a directory containing only a bad file must not crash", () => {
	let agentsDir: string;

	afterEach(() => {
		vi.restoreAllMocks();
		if (agentsDir) fs.rmSync(path.dirname(path.dirname(agentsDir)), { recursive: true, force: true });
	});

	it("should return an empty array and not throw", () => {
		// Arrange
		agentsDir = makeTmpAgentsDir();
		fs.writeFileSync(
			path.join(agentsDir, "bad.md"),
			`---
name: bad
description: foo: bar
---
Bad agent body.
`,
		);
		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

		// Act
		let agents: ReturnType<typeof loadAgentsFromDir> | undefined;
		let thrown: unknown;
		try {
			agents = loadAgentsFromDir(agentsDir, "user");
		} catch (err) {
			thrown = err;
		}

		// Assert
		expect(thrown).toBeUndefined();
		expect(agents).toEqual([]);
		expect(warnSpy).toHaveBeenCalled();
	});
});

describe("C: description parsed as non-string (flow style) must be skipped", () => {
	let agentsDir: string;

	afterEach(() => {
		vi.restoreAllMocks();
		if (agentsDir) fs.rmSync(path.dirname(path.dirname(agentsDir)), { recursive: true, force: true });
	});

	it("should skip the agent and warn that description is not a string", () => {
		// Arrange
		agentsDir = makeTmpAgentsDir();
		fs.writeFileSync(
			path.join(agentsDir, "flow.md"),
			`---
name: flow
description: { foo: bar }
---
Flow-style description body.
`,
		);
		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

		// Act
		const agents = loadAgentsFromDir(agentsDir, "user");

		// Assert
		expect(agents).toEqual([]);
		expect(warnSpy).toHaveBeenCalled();
		const warnText = collectWarnText(warnSpy);
		expect(warnText).toMatch(/description/i);
		expect(warnText).toMatch(/string/i);
	});
});

describe("D: YAML error details must be propagated to the warning", () => {
	let agentsDir: string;

	afterEach(() => {
		vi.restoreAllMocks();
		if (agentsDir) fs.rmSync(path.dirname(path.dirname(agentsDir)), { recursive: true, force: true });
	});

	it("should not throw and the warning must name the offending file", () => {
		// Arrange
		agentsDir = makeTmpAgentsDir();
		fs.writeFileSync(
			path.join(agentsDir, "bad.md"),
			`---
name: bad
description: foo: bar: baz
---
Bad agent body.
`,
		);
		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

		// Act
		let thrown: unknown;
		try {
			loadAgentsFromDir(agentsDir, "user");
		} catch (err) {
			thrown = err;
		}

		// Assert
		expect(thrown).toBeUndefined();
		expect(warnSpy).toHaveBeenCalled();
		// Don't hardcode the yaml library's error wording (it changes across
		// versions); only require the warning to identify the offending file.
		expect(collectWarnText(warnSpy)).toContain("bad.md");
	});
});
