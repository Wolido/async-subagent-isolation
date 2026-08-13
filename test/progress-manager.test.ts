import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { visibleWidth } from "@earendil-works/pi-tui";
import { SubagentProgressManager, formatElapsed } from "../src/index.ts";

const WIDGET_KEY = "async-subagent-isolation-progress";

function createMockCtx(hasUI = true) {
	return {
		hasUI,
		ui: { setWidget: vi.fn() },
	} as any;
}

function createMockTheme() {
	return {
		fg: vi.fn((color: string, text: string) => text),
		bg: vi.fn((color: string, text: string) => text),
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

function getLastFactory(setWidgetMock: ReturnType<typeof vi.fn>) {
	const calls = setWidgetMock.mock.calls.filter(
		([key, value]: [unknown, unknown]) => key === WIDGET_KEY && typeof value === "function",
	);
	expect(calls.length).toBeGreaterThan(0);
	return calls[calls.length - 1][1] as (tui: unknown, theme: unknown) => { render(width: number): string[]; invalidate(): void };
}

function renderLastWidget(setWidgetMock: ReturnType<typeof vi.fn>, theme: unknown, width = 80) {
	const factory = getLastFactory(setWidgetMock);
	const component = factory({}, theme);
	expect(typeof component.render).toBe("function");
	return component.render(width);
}

describe("formatElapsed", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	it("pads seconds on the left (5s -> 00:05)", () => {
		expect(formatElapsed(Date.now() - 5_000)).toBe("00:05");
	});

	it("formats minutes and seconds (65s -> 01:05)", () => {
		expect(formatElapsed(Date.now() - 65_000)).toBe("01:05");
	});

	it("clamps negative values to zero", () => {
		expect(formatElapsed(Date.now() + 5_000)).toBe("00:00");
	});
});

describe("SubagentProgressManager", () => {
	let mockTheme: ReturnType<typeof createMockTheme>;

	beforeEach(() => {
		vi.useFakeTimers();
		mockTheme = createMockTheme();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("should set a component factory widget on register and render horizontal separators", () => {
		const manager = new SubagentProgressManager();
		const ctx = createMockCtx();

		manager.register(ctx, "s1", "agent-a");

		expect(ctx.ui.setWidget).toHaveBeenCalledWith(WIDGET_KEY, expect.any(Function));
		const lines = renderLastWidget(ctx.ui.setWidget, mockTheme, 80);

		expect(lines.length).toBeGreaterThanOrEqual(3);
		expect(lines[0]).toContain("Subagents (1)");
		expect(lines[0]).not.toMatch(/[┌┐└┘│]/);
		expect(lines[lines.length - 1]).not.toMatch(/[┌┐└┘│]/);
		expect(lines[lines.length - 1].replace(/─/g, "")).toBe("");

		const dataLines = lines.slice(1, -1);
		expect(dataLines.length).toBe(1);
		expect(dataLines[0]).toContain("●");
		expect(dataLines[0]).toContain("agent-a");
		expect(dataLines[0]).toContain("00:00");

		manager.unregister("s1");
	});

	it("should update only in memory and render the new phase on the next tick", () => {
		const manager = new SubagentProgressManager();
		const ctx = createMockCtx();
		manager.register(ctx, "s1", "agent-a");
		ctx.ui.setWidget.mockClear();

		manager.update("s1", { phase: "thinking" });

		expect(ctx.ui.setWidget).not.toHaveBeenCalled();

		vi.advanceTimersByTime(1000);

		expect(ctx.ui.setWidget).toHaveBeenCalledTimes(1);
		expect(ctx.ui.setWidget).toHaveBeenCalledWith(WIDGET_KEY, expect.any(Function));
		const lines = renderLastWidget(ctx.ui.setWidget, mockTheme, 80);
		const dataLines = lines.slice(1, -1);
		expect(dataLines[0]).toContain("thinking");

		manager.unregister("s1");
	});

	it("should stop the timer and clear the widget when the last agent unregisters", () => {
		const manager = new SubagentProgressManager();
		const ctx = createMockCtx();
		manager.register(ctx, "s1", "agent-a");
		manager.unregister("s1");

		expect((manager as any).timer).toBeNull();
		expect(ctx.ui.setWidget).toHaveBeenLastCalledWith(WIDGET_KEY, undefined);
	});

	it("should share one timer across concurrent registrations and refresh on non-last unregister", () => {
		const manager = new SubagentProgressManager();
		const ctx = createMockCtx();
		manager.register(ctx, "s1", "agent-a");
		const timer = (manager as any).timer;

		manager.register(ctx, "s2", "agent-b");
		manager.register(ctx, "s3", "agent-c");

		expect((manager as any).timer).toBe(timer);

		ctx.ui.setWidget.mockClear();
		manager.unregister("s2");

		expect((manager as any).timer).toBe(timer);
		expect(ctx.ui.setWidget).toHaveBeenCalledWith(WIDGET_KEY, expect.any(Function));

		manager.unregister("s1");
		manager.unregister("s3");

		expect((manager as any).timer).toBeNull();
		expect(ctx.ui.setWidget).toHaveBeenLastCalledWith(WIDGET_KEY, undefined);
	});

	it("should include a green dot, name, phase, elapsed, and recent tool summary on each agent row", () => {
		const manager = new SubagentProgressManager();
		const ctx = createMockCtx();
		manager.register(ctx, "s1", "agent-a");
		manager.update("s1", {
			phase: "tooling:bash",
			recentTools: ["bash ls -la", "read ~/file.md"],
		});

		vi.advanceTimersByTime(1000);

		const lines = renderLastWidget(ctx.ui.setWidget, mockTheme, 80);
		const dataLines = lines.slice(1, -1);

		expect(dataLines[0]).toContain("●");
		expect(mockTheme.fg).toHaveBeenCalledWith("success", "●");
		expect(dataLines[0]).toContain("agent-a");
		expect(dataLines[0]).toContain("bash");
		expect(dataLines[0]).toContain("00:01");
		expect(dataLines[0]).toContain("read ~/file.md");

		manager.unregister("s1");
	});

	it("should sort agents by startedAt and truncate earliest-started agents when over line budget", () => {
		const manager = new SubagentProgressManager();
		const ctx = createMockCtx();
		const originalRows = process.stdout.rows;
		process.stdout.rows = 4;

		try {
			const names: string[] = [];
			for (let i = 0; i < 6; i++) {
				names.push(`agent-${i}`);
				manager.register(ctx, `s${i}`, `agent-${i}`);
				vi.advanceTimersByTime(1);
			}

			const lines = renderLastWidget(ctx.ui.setWidget, mockTheme, 80);
			const dataLines = lines.slice(1, -1);

			expect(dataLines.length).toBeLessThanOrEqual(4);
			expect(dataLines[dataLines.length - 1]).toContain("agent-5");
			expect(lines.some((line) => line.includes("agent-0"))).toBe(false);
		} finally {
			process.stdout.rows = originalRows;
		}

		for (let i = 0; i < 6; i++) {
			manager.unregister(`s${i}`);
		}
	});

	it("should keep every rendered line within the requested width even with wide characters", () => {
		const manager = new SubagentProgressManager();
		const ctx = createMockCtx();
		manager.register(ctx, "s1", "🚀 火箭");
		manager.update("s1", {
			phase: "tooling:bash",
			recentTools: ["bash 你好世界.md"],
		});

		vi.advanceTimersByTime(1000);

		const lines = renderLastWidget(ctx.ui.setWidget, mockTheme, 40);

		for (const line of lines) {
			expect(visibleWidth(line)).toBeLessThanOrEqual(40);
		}

		manager.unregister("s1");
	});

	it("should reflect the current agent count in the top label", () => {
		const manager = new SubagentProgressManager();
		const ctx = createMockCtx();
		manager.register(ctx, "s1", "agent-a");
		manager.register(ctx, "s2", "agent-b");

		vi.advanceTimersByTime(1000);

		const lines = renderLastWidget(ctx.ui.setWidget, mockTheme, 80);
		expect(lines[0]).toContain("Subagents (2)");

		manager.unregister("s1");
		manager.unregister("s2");
	});
});

describe("SubagentProgressManager — taskId visibility in widget rows", () => {
	let mockTheme: ReturnType<typeof createMockTheme>;

	beforeEach(() => {
		vi.useFakeTimers();
		mockTheme = createMockTheme();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("should include the taskId (sessionId) in the rendered row for a registered agent", () => {
		const taskId = "019f3a2b-4c5d-6e7f-8a9b-0c1d2e3f4a5b";
		const manager = new SubagentProgressManager();
		const ctx = createMockCtx();

		manager.register(ctx, taskId, "researcher");

		vi.advanceTimersByTime(1000);

		const lines = renderLastWidget(ctx.ui.setWidget, mockTheme, 120);
		const dataLines = lines.slice(1, -1);

		expect(dataLines.length).toBe(1);
		expect(dataLines[0]).toContain(taskId);

		manager.unregister(taskId);
	});

	it("should display each agent's own taskId when multiple agents are registered", () => {
		const taskId1 = "019f3a2b-aaaa-bbbb-cccc-111111111111";
		const taskId2 = "019f3a2b-dddd-eeee-ffff-222222222222";
		const manager = new SubagentProgressManager();
		const ctx = createMockCtx();

		manager.register(ctx, taskId1, "alpha");
		manager.register(ctx, taskId2, "beta");

		vi.advanceTimersByTime(1000);

		const lines = renderLastWidget(ctx.ui.setWidget, mockTheme, 120);
		const dataLines = lines.slice(1, -1);

		expect(dataLines.length).toBe(2);

		// Each row must contain its own taskId
		const rowWithAlpha = dataLines.find((line) => line.includes("alpha"));
		const rowWithBeta = dataLines.find((line) => line.includes("beta"));
		expect(rowWithAlpha).toBeDefined();
		expect(rowWithBeta).toBeDefined();
		expect(rowWithAlpha!).toContain(taskId1);
		expect(rowWithBeta!).toContain(taskId2);

		manager.unregister(taskId1);
		manager.unregister(taskId2);
	});

	it("should display short non-uuid taskIds (e.g. 'task-1') in the rendered row", () => {
		const taskId = "task-1";
		const manager = new SubagentProgressManager();
		const ctx = createMockCtx();

		manager.register(ctx, taskId, "worker");

		vi.advanceTimersByTime(1000);

		const lines = renderLastWidget(ctx.ui.setWidget, mockTheme, 120);
		const dataLines = lines.slice(1, -1);

		expect(dataLines.length).toBe(1);
		expect(dataLines[0]).toContain(taskId);

		manager.unregister(taskId);
	});
});

describe("SubagentProgressManager — full agent name display (red phase)", () => {
	let mockTheme: ReturnType<typeof createMockTheme>;

	beforeEach(() => {
		vi.useFakeTimers();
		mockTheme = createMockTheme();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("should display full agent name when name exceeds 8 characters (currently truncated)", () => {
		const manager = new SubagentProgressManager();
		const ctx = createMockCtx();
		const longName = "diagrammer"; // 10 chars, exceeds 8-char limit

		manager.register(ctx, "task-1", longName);

		vi.advanceTimersByTime(1000);

		const lines = renderLastWidget(ctx.ui.setWidget, mockTheme, 120);
		const dataLines = lines.slice(1, -1);

		// Red phase: should contain the FULL name "diagrammer", not truncated
		// Currently FAILS because name is truncated to 8 chars
		expect(dataLines[0]).toContain(longName);

		manager.unregister("task-1");
	});

	it("should display full agent name for very-long-agent-name (currently truncated)", () => {
		const manager = new SubagentProgressManager();
		const ctx = createMockCtx();
		const longName = "very-long-agent-name"; // 20 chars

		manager.register(ctx, "task-2", longName);

		vi.advanceTimersByTime(1000);

		const lines = renderLastWidget(ctx.ui.setWidget, mockTheme, 120);
		const dataLines = lines.slice(1, -1);

		// Red phase: should contain the FULL name, not truncated
		// Currently FAILS because name is truncated to 8 chars
		expect(dataLines[0]).toContain(longName);

		manager.unregister("task-2");
	});

	it("should keep taskId fully visible alongside full agent name (regression lock)", () => {
		const taskId = "019f3a2b-4c5d-6e7f-8a9b-0c1d2e3f4a5b";
		const longName = "diagrammer";
		const manager = new SubagentProgressManager();
		const ctx = createMockCtx();

		manager.register(ctx, taskId, longName);

		vi.advanceTimersByTime(1000);

		const lines = renderLastWidget(ctx.ui.setWidget, mockTheme, 120);
		const dataLines = lines.slice(1, -1);

		// Green: taskId should remain fully visible
		expect(dataLines[0]).toContain(taskId);

		manager.unregister(taskId);
	});

	it("should respect width constraint even with long agent names", () => {
		const manager = new SubagentProgressManager();
		const ctx = createMockCtx();
		const longName = "very-long-agent-name";
		const taskId = "019f3a2b-4c5d-6e7f-8a9b-0c1d2e3f4a5b";

		manager.register(ctx, taskId, longName);

		vi.advanceTimersByTime(1000);

		const lines = renderLastWidget(ctx.ui.setWidget, mockTheme, 80);

		// Green: width constraint should still be respected
		for (const line of lines) {
			expect(visibleWidth(line)).toBeLessThanOrEqual(80);
		}

		manager.unregister(taskId);
	});
});

describe("SubagentProgressManager — aligned columns in widget rows", () => {
	let mockTheme: ReturnType<typeof createMockTheme>;

	// Same-length (36-char) UUID-like taskIds so only the name length varies
	// between rows and cannot skew the column-position assertions below.
	const TASK_1 = "019f3a2b-aaaa-bbbb-cccc-111111111111";
	const TASK_2 = "019f3a2b-aaaa-bbbb-cccc-222222222222";
	const TASK_3 = "019f3a2b-aaaa-bbbb-cccc-333333333333";

	beforeEach(() => {
		vi.useFakeTimers();
		mockTheme = createMockTheme();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	/** Column (0-based) where the phase text starts in a rendered row. */
	const phaseIndex = (row: string) => row.indexOf("⚡");

	/** The raw text between the end of `name` and the phase column. */
	const gapAfterName = (row: string, name: string) => {
		const nameStart = row.indexOf(name);
		return row.slice(nameStart + name.length, phaseIndex(row));
	};

	/** The raw text between the end of `taskId` and the phase glyph (padded name column + one separator space). */
	const nameRegion = (row: string, taskId: string) => {
		const taskEnd = row.indexOf(taskId) + taskId.length;
		return row.slice(taskEnd + 1, row.indexOf("⚡"));
	};

	/**
	 * Display column (0-based, in visibleWidth units) where the phase text
	 * starts in a rendered row. Unlike `phaseIndex` (a raw string offset), this
	 * is correct even when the name column contains wide chars (CJK/emoji).
	 */
	const phaseDisplayCol = (row: string) => visibleWidth(row.slice(0, row.indexOf("⚡")));

	it("should align the phase column and elapsed column across rows with different name lengths", () => {
		const manager = new SubagentProgressManager();
		const ctx = createMockCtx();
		const names = ["coder", "magi-sage", "diagrammer"];
		const taskIds = [TASK_1, TASK_2, TASK_3];

		taskIds.forEach((id, i) => manager.register(ctx, id, names[i]));
		taskIds.forEach((id) => manager.update(id, { phase: "tooling:read" }));

		vi.advanceTimersByTime(1000);

		const lines = renderLastWidget(ctx.ui.setWidget, mockTheme, 120);
		const dataLines = lines.slice(1, -1);

		expect(dataLines.length).toBe(3);

		const phaseColumns = dataLines.map(phaseIndex);
		const elapsedColumns = dataLines.map((row) => row.indexOf("00:01"));

		for (const col of phaseColumns) expect(col).toBeGreaterThanOrEqual(0);
		for (const col of elapsedColumns) expect(col).toBeGreaterThanOrEqual(0);

		// Red phase: the raw, unpadded name column shifts the phase text (and
		// therefore the elapsed MM:SS) to a different column on every row.
		expect(new Set(phaseColumns).size).toBe(1);
		expect(new Set(elapsedColumns).size).toBe(1);

		taskIds.forEach((id) => manager.unregister(id));
	});

	it("should pad short names with spaces so the phase column aligns with the longest name", () => {
		const manager = new SubagentProgressManager();
		const ctx = createMockCtx();

		manager.register(ctx, TASK_1, "coder");
		manager.register(ctx, TASK_2, "magi-sage");
		manager.register(ctx, TASK_3, "diagrammer");
		[TASK_1, TASK_2, TASK_3].forEach((id) => manager.update(id, { phase: "tooling:read" }));

		vi.advanceTimersByTime(1000);

		const lines = renderLastWidget(ctx.ui.setWidget, mockTheme, 120);
		const dataLines = lines.slice(1, -1);

		const diagrammerRow = dataLines.find((row) => row.includes("diagrammer"))!;
		const coderRow = dataLines.find((row) => row.includes("coder"))!;

		// The longest name stays fully visible (10 chars, well under the cap).
		expect(diagrammerRow).toContain("diagrammer");
		// Exactly one separator space between the full name and the phase column.
		expect(gapAfterName(diagrammerRow, "diagrammer")).toBe(" ");

		// The short name is padded with spaces up to the longest name's width, so
		// both rows start their phase text at the same column.
		expect(phaseIndex(coderRow)).toBe(phaseIndex(diagrammerRow));

		// The padding is real: the gap after "coder" is wider than one separator.
		const gap = gapAfterName(coderRow, "coder");
		expect(gap).toMatch(/^ *$/);
		expect(gap.length).toBeGreaterThan(1);

		[TASK_1, TASK_2, TASK_3].forEach((id) => manager.unregister(id));
	});

	it("should not leave a large fixed-width gap after a single short name", () => {
		const manager = new SubagentProgressManager();
		const ctx = createMockCtx();

		manager.register(ctx, TASK_1, "coder");
		manager.update(TASK_1, { phase: "tooling:read" });

		vi.advanceTimersByTime(1000);

		const lines = renderLastWidget(ctx.ui.setWidget, mockTheme, 120);
		const dataLines = lines.slice(1, -1);
		const row = dataLines[0];

		// The name column width derives from the visible agents (here: only
		// "coder"), so the phase glyph must sit right after "coder" + one
		// separator — not after a fixed width like 20 chars (which would leave a
		// ~16-char blank run). Already holds pre-fix; it is a regression lock
		// against a naive fixed-width name column.
		const gap = gapAfterName(row, "coder");
		expect(gap).toMatch(/^ *$/);
		expect(gap.length).toBeLessThanOrEqual(2);

		manager.unregister(TASK_1);
	});

	it("should widen the name column dynamically when a longer agent is added and keep rows aligned", () => {
		const manager = new SubagentProgressManager();
		const ctx = createMockCtx();

		manager.register(ctx, TASK_1, "coder");
		manager.update(TASK_1, { phase: "tooling:read" });
		vi.advanceTimersByTime(1000);

		const linesBefore = renderLastWidget(ctx.ui.setWidget, mockTheme, 120);
		const gapBefore = gapAfterName(linesBefore.slice(1, -1)[0], "coder");

		manager.register(ctx, TASK_2, "diagrammer");
		manager.update(TASK_2, { phase: "tooling:read" });
		vi.advanceTimersByTime(1000);

		const linesAfter = renderLastWidget(ctx.ui.setWidget, mockTheme, 120);
		const dataLinesAfter = linesAfter.slice(1, -1);

		const coderRow = dataLinesAfter.find((row) => row.includes("coder"))!;
		const diagrammerRow = dataLinesAfter.find((row) => row.includes("diagrammer"))!;

		// The name column grows with the longest visible name...
		const gapAfter = gapAfterName(coderRow, "coder");
		expect(gapAfter.length).toBeGreaterThan(gapBefore.length);

		// ...and both rows stay aligned on the phase column.
		expect(phaseIndex(coderRow)).toBe(phaseIndex(diagrammerRow));

		[TASK_1, TASK_2].forEach((id) => manager.unregister(id));
	});

	it("should truncate over-long names with an ellipsis and keep remaining rows aligned", () => {
		const manager = new SubagentProgressManager();
		const ctx = createMockCtx();
		const longName = "a-very-very-long-agent-name-exceeding-limit"; // 42 chars

		manager.register(ctx, TASK_1, longName);
		manager.register(ctx, TASK_2, "coder");
		[TASK_1, TASK_2].forEach((id) => manager.update(id, { phase: "tooling:read" }));

		vi.advanceTimersByTime(1000);

		const lines = renderLastWidget(ctx.ui.setWidget, mockTheme, 120);
		const dataLines = lines.slice(1, -1);

		const longRow = dataLines.find((row) => row.includes(longName.slice(0, 10)))!;
		const coderRow = dataLines.find((row) => row.includes("coder"))!;

		// The over-long name must NOT appear in full...
		expect(longRow).not.toContain(longName);
		// ...it must be cut down with an ellipsis (… or ...).
		expect(longRow).toMatch(/\.\.\.|…/);
		// The truncated row still aligns with the other rows.
		expect(phaseIndex(longRow)).toBe(phaseIndex(coderRow));

		[TASK_1, TASK_2].forEach((id) => manager.unregister(id));
	});

	it("should keep every rendered line within the requested width in all alignment scenarios", () => {
		const manager = new SubagentProgressManager();
		const ctx = createMockCtx();
		const longName = "a-very-very-long-agent-name-exceeding-limit";

		manager.register(ctx, TASK_1, "coder");
		manager.register(ctx, TASK_2, "magi-sage");
		manager.register(ctx, TASK_3, longName);
		[TASK_1, TASK_2, TASK_3].forEach((id) => manager.update(id, { phase: "tooling:read" }));

		vi.advanceTimersByTime(1000);

		// Regression lock: the alignment fix (dynamic name column + truncation
		// cap) must never push a rendered line past the requested widget width.
		for (const width of [120, 80, 40]) {
			const lines = renderLastWidget(ctx.ui.setWidget, mockTheme, width);
			for (const line of lines) {
				expect(visibleWidth(line)).toBeLessThanOrEqual(width);
			}
		}

		[TASK_1, TASK_2, TASK_3].forEach((id) => manager.unregister(id));
	});

	it("should fully display a 30-char name and truncate a 31-char name to 27 chars plus ellipsis at the MAX_NAME_WIDTH=30 cap", () => {
		const manager = new SubagentProgressManager();
		const ctx = createMockCtx();
		const name30 = "a".repeat(30);
		const name31 = "b".repeat(31);

		manager.register(ctx, TASK_1, name30);
		manager.register(ctx, TASK_2, name31);
		manager.register(ctx, TASK_3, "coder");
		[TASK_1, TASK_2, TASK_3].forEach((id) => manager.update(id, { phase: "tooling:read" }));

		vi.advanceTimersByTime(1000);

		const lines = renderLastWidget(ctx.ui.setWidget, mockTheme, 120);
		const dataLines = lines.slice(1, -1);

		const row30 = dataLines.find((row) => row.includes(name30))!;
		const row31 = dataLines.find((row) => row.includes("b".repeat(27)))!;
		const coderRow = dataLines.find((row) => row.includes("coder"))!;

		// Regression lock for MAX_NAME_WIDTH=30: a 30-char name fits the cap in
		// full, with no ellipsis and (being exactly the cap width) no padding —
		// the name region is just the name plus the separator space.
		expect(row30).toContain(name30);
		// The name region is the name plus the separator space — no ellipsis,
		// no padding. (Scoped to the name region, not the whole row: the phase
		// column itself ends with "...", e.g. "⚡ read...".)
		expect(nameRegion(row30, TASK_1)).toBe(name30 + " ");

		// A 31-char name exceeds the cap: cut to 27 chars + "..." (30 cols in
		// total), never shown in full.
		expect(nameRegion(row31, TASK_2)).toBe("b".repeat(27) + "..." + " ");
		expect(row31).not.toContain(name31);

		// Mixed with a short name, all rows still start their phase text at the
		// same column (pure ASCII: raw offset == display column).
		expect(phaseIndex(row30)).toBe(phaseIndex(row31));
		expect(phaseIndex(row31)).toBe(phaseIndex(coderRow));

		[TASK_1, TASK_2, TASK_3].forEach((id) => manager.unregister(id));
	});

	it("should align the phase column by display width across emoji and CJK names and keep truncated rows aligned", () => {
		const manager = new SubagentProgressManager();
		const ctx = createMockCtx();
		const cjkName = "中".repeat(20); // 40 display cols > MAX_NAME_WIDTH=30

		manager.register(ctx, TASK_1, "coder");
		manager.register(ctx, TASK_2, "🚀 火箭"); // emoji 2 cols, CJK 2 cols, space 1 col
		manager.register(ctx, TASK_3, cjkName);
		[TASK_1, TASK_2, TASK_3].forEach((id) => manager.update(id, { phase: "tooling:read" }));

		vi.advanceTimersByTime(1000);

		const lines = renderLastWidget(ctx.ui.setWidget, mockTheme, 120);
		const dataLines = lines.slice(1, -1);

		expect(dataLines.length).toBe(3);

		const coderRow = dataLines.find((row) => row.includes("coder"))!;
		const emojiRow = dataLines.find((row) => row.includes("🚀 火箭"))!;
		const cjkRow = dataLines.find((row) => row.includes("中"))!;

		// The narrow emoji name (7 display cols) fits in full.
		expect(emojiRow).toContain("🚀 火箭");

		// The over-wide CJK name (40 display cols) is truncated with an ellipsis
		// and padded back up to the cap: every name region is exactly 30 display
		// cols plus the separator space.
		const cjkRegion = nameRegion(cjkRow, TASK_3);
		expect(cjkRegion).toMatch(/^中+\.\.\. +$/);
		expect(visibleWidth(cjkRegion)).toBe(31);
		expect(cjkRow).not.toContain(cjkName);

		// The phase column aligns by *display* column across all rows. Raw
		// offsets differ (a CJK char occupies 2 display cols), so this must use
		// visibleWidth-based positioning, not indexOf.
		const phaseCols = dataLines.map(phaseDisplayCol);
		for (const col of phaseCols) expect(col).toBeGreaterThanOrEqual(0);
		expect(new Set(phaseCols).size).toBe(1);

		// The truncated row keeps the same name-region width as the untruncated
		// rows, so truncation does not break display-column alignment.
		expect(visibleWidth(nameRegion(coderRow, TASK_1))).toBe(31);
		expect(visibleWidth(nameRegion(emojiRow, TASK_2))).toBe(31);
		expect(visibleWidth(cjkRegion)).toBe(31);

		// No rendered line may exceed the requested widget width.
		for (const line of lines) {
			expect(visibleWidth(line)).toBeLessThanOrEqual(120);
		}

		[TASK_1, TASK_2, TASK_3].forEach((id) => manager.unregister(id));
	});
});
