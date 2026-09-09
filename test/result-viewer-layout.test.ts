/**
 * 第三轮（返工）：/subagent-result 查看器契约 —— overlay 挂载 + 自尺寸手滚。
 *
 * reviewer 证据（上一版 renderLayoutFrame/dock harness 是假绿，已删除）：
 * - pi-tui getLayoutNode 只认 component[LAYOUT_NODE]()；Container 没有该方法
 *   （叶子节点）。
 * - pi showExtensionCustom 把 ui.custom 返回的组件 editorContainer.addChild(component)，
 *   而 editorContainer = new Container()，dock 里是 { component: editorContainer,
 *   shrink:1, minSize:3 } —— 布局引擎对叶子只调 render(width)，不递归。
 * - 因此 VStack/ScrollView 永远收不到 updateLayout（engineSized 恒 false）；
 *   忠实复刻实测 rows=24+widget 时首帧和按 G 都看不到最后一行，用户 bug 原样复现。
 *
 * 新方案（已核实）：overlay 挂载 —— ctx.ui.custom(factory, { overlay: true,
 * overlayOptions: { width: "100%", maxHeight: "100%", anchor: "top-left",
 * margin: 0 } })。showOverlay 会 setFocus(component)（键盘可达）；
 * TuiAltScreen/TuiMainScreen 的 doRender 都调 compositeOverlays；
 * parseSizeValue("100%", termHeight) = termHeight，overlay 行数 > maxHeight 才
 * slice —— 组件自尺寸 process.stdout.rows 行 = overlay 高度，不经过 dock、
 * 不会被裁。
 *
 * 组件契约（coder 待实现）：
 *   返回恰好 rows 行 = 顶边框 1 + 标题行 1 + 正文窗口 rows-3 + 底边框 1
 *   （短内容按内容行数收缩，行数 ≤ rows）。
 *   打开即定位到末尾（结果优先）；g/Home 顶部，G/End 底部。
 *   正文末尾空行需 trim（极小视口下最后一行必须是真实内容）。
 *   键位：↑/k、↓/j、PgUp/b、PgDn/Space、g/Home、G/End、Enter/Esc/q→onClose；
 *   tui 为 null 不崩。
 *   createResultViewer(options) -> { component, scrollToStart, scrollToEnd,
 *   scrollBy } 不变。
 *
 * 本文件只用 mock ctx + 直接的 component.render(80)/handleInput 观测行为，
 * 不含 renderLayoutFrame/dock 假路径。
 */

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import extension, { taskRegistry, createResultViewer } from "../src/index.ts";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

vi.mock("@earendil-works/pi-coding-agent", async () => {
	const actual = await vi.importActual("@earendil-works/pi-coding-agent");
	return {
		...actual,
		getAgentDir: vi.fn(),
	};
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const WIDTH = 80;

/** 最小 theme 替身：实现只应依赖 fg/bold/dim 这类纯文本包装。 */
const themeStub = {
	fg: (_color: string, text: string) => text,
	bold: (text: string) => text,
	dim: (text: string) => text,
};

/** 注入 process.stdout.rows 并在 finally 还原（与 progress-manager 既有写法一致）。 */
function withRows(rows: number, fn: () => void): void {
	const originalRows = process.stdout.rows;
	try {
		process.stdout.rows = rows;
		fn();
	} finally {
		process.stdout.rows = originalRows;
	}
}

/**
 * 长转录：首行 AA-START-MARKER、末行 ZZ-END-MARKER（普通段落行，Markdown
 * 渲染后仍可见），中间 LINE-xxx 唯一编号，内容必然溢出任意测试窗口。
 */
function makeViewerText(lineCount: number): string {
	const lines: string[] = ["AA-START-MARKER"];
	for (let i = 1; i < lineCount - 1; i++) {
		lines.push(`LINE-${String(i).padStart(3, "0")}`);
	}
	lines.push("[assistant] ZZ-END-MARKER: final answer");
	return lines.join("\n");
}

/** 从 render 输出中取出正文窗口行（去掉顶边框、标题行、底边框各 1 行）。 */
function bodyLines(rendered: string[]): string[] {
	return rendered.slice(2, rendered.length - 1);
}

function createViewer(text: string, onClose: () => void = () => {}, tui: any = null) {
	return createResultViewer({ text, taskId: "task-0000", theme: themeStub, tui, onClose });
}

/** 捕获 /subagent-result handler 调用的 ui.custom(factory, options)。 */
function createMockPi() {
	const commandDefs: Map<string, any> = new Map();
	return {
		registerTool: vi.fn(),
		registerCommand: vi.fn((name: string, options: any) => {
			commandDefs.set(name, options);
		}),
		registerMessageRenderer: vi.fn(),
		on: vi.fn(),
		sendMessage: vi.fn(),
		_commandDefs: commandDefs,
	};
}

/** 写一个最小 session 文件（assistant 纯文本，保证 extractSessionTranscript 非空）。 */
function writeSessionFile(sessionDir: string, taskId: string, text: string): string {
	fs.mkdirSync(sessionDir, { recursive: true });
	const filePath = path.join(sessionDir, `1700000000000_${taskId}.jsonl`);
	const content = JSON.stringify({
		type: "message",
		message: { role: "assistant", content: [{ type: "text", text }] },
	});
	fs.writeFileSync(filePath, content + "\n", "utf-8");
	return filePath;
}

describe("/subagent-result overlay 查看器（第三轮返工，红阶段）", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "result-viewer-overlay-"));
		vi.mocked(getAgentDir).mockReturnValue(tempDir);
		taskRegistry.clear();
	});

	afterEach(() => {
		fs.rmSync(tempDir, { recursive: true, force: true });
		taskRegistry.clear();
		vi.restoreAllMocks();
	});

	it("should mount the viewer as a fullscreen overlay (overlay:true + overlayOptions)", async () => {
		// Arrange
		const taskId = "mount-overlay-contract";
		writeSessionFile(path.join(tempDir, "subagent-sessions", taskId), taskId, makeViewerText(40));
		let capturedOptions: any = undefined;
		const customMock = vi.fn(async (cb: any, options?: any) => {
			capturedOptions = options;
			const theme = { fg: (_c: string, s: string) => s, bold: (s: string) => s };
			cb(null, theme, null, () => {});
		});
		const ctx = { hasUI: true, mode: "tui" as const, ui: { notify: vi.fn(), custom: customMock } };

		// Act
		const pi = createMockPi();
		extension(pi as any);
		const commandDef = pi._commandDefs.get("subagent-result");
		expect(commandDef).toBeDefined();
		await commandDef.handler(taskId, ctx);

		// Assert：必须用 overlay 挂载（不经过 dock/editorContainer，避免被布局裁底）
		expect(customMock).toHaveBeenCalledTimes(1);
		expect(capturedOptions?.overlay).toBe(true);
		expect(capturedOptions?.overlayOptions).toEqual({
			width: "100%",
			maxHeight: "100%",
			anchor: "top-left",
			margin: 0,
		});
	});

	// ------------------------------------------------------------------
	// 自尺寸：返回恰好 rows 行；首帧（不交互）即定位到末尾
	// ------------------------------------------------------------------
	for (const rows of [24, 40, 60]) {
		it(`should render exactly rows lines and open at the end (rows=${rows})`, () => {
			withRows(rows, () => {
				const viewer = createViewer(makeViewerText(200));
				const out = viewer.component.render(WIDTH);

				// 自尺寸：整体 ≤ rows 且 == rows（长转录装满整整一屏）
				expect(out.length).toBeLessThanOrEqual(rows);
				expect(out.length).toBe(rows);

				// 打开即定位到末尾：末行标记可见、首行标记不可见
				const joined = out.join("\n");
				expect(joined).toContain("ZZ-END-MARKER");
				expect(joined).not.toContain("AA-START-MARKER");
			});
		});
	}

	// ------------------------------------------------------------------
	// 尾行可达（核心回归）：scrollToEnd/G 后最后一行动画可见；scrollToStart/g 回顶
	// ------------------------------------------------------------------
	it("should reach the tail via scrollToEnd and G, and the head via scrollToStart and g", () => {
		withRows(50, () => {
			const viewer = createViewer(makeViewerText(200));

			// 打开即末尾 → scrollToEnd 后末行可见、首行不可见
			viewer.scrollToEnd();
			const atEnd = viewer.component.render(WIDTH).join("\n");
			expect(atEnd).toContain("ZZ-END-MARKER");
			expect(atEnd).not.toContain("AA-START-MARKER");

			// 按 G：仍停在末尾
			viewer.component.handleInput("G");
			expect(viewer.component.render(WIDTH).join("\n")).toContain("ZZ-END-MARKER");

			// scrollToStart 回到顶部
			viewer.scrollToStart();
			const atStart = viewer.component.render(WIDTH).join("\n");
			expect(atStart).toContain("AA-START-MARKER");
			expect(atStart).not.toContain("ZZ-END-MARKER");

			// 先 G 到底，再 g 回顶
			viewer.component.handleInput("G");
			viewer.component.handleInput("g");
			expect(viewer.component.render(WIDTH).join("\n")).toContain("AA-START-MARKER");
		});
	});

	// ------------------------------------------------------------------
	// 极小视口 rows=6：末行必须是真实内容（ZZ-END-MARKER），不是 Markdown 尾随空白
	// ------------------------------------------------------------------
	it("should show ZZ-END-MARKER as the last body line at a 6-row viewport", () => {
		withRows(6, () => {
			const viewer = createViewer(makeViewerText(200));
			viewer.scrollToEnd();
			const out = viewer.component.render(WIDTH);

			// 6 行：顶边框 + 标题 + 正文 3 行 + 底边框
			expect(out.length).toBe(6);
			const body = bodyLines(out);
			expect(body).toHaveLength(3);
			// 尾随空行必须被 trim：最后一行正文是 ZZ-END-MARKER 而非空白
			expect(body[body.length - 1]).toContain("ZZ-END-MARKER");
		});
	});

	// ------------------------------------------------------------------
	// 键位：j/k 不关窗；PgUp/PgDn/Space/b 生效；q/Enter/Esc 关闭；tui=null 不崩
	// ------------------------------------------------------------------
	it("should not close on j / k while scrolling", () => {
		withRows(50, () => {
			const onClose = vi.fn();
			const viewer = createViewer(makeViewerText(200), onClose);
			viewer.component.handleInput("j");
			viewer.component.handleInput("k");
			expect(onClose).not.toHaveBeenCalled();
		});
	});

	it("should page with PgUp / PgDn / Space / b", () => {
		withRows(50, () => {
			const viewer = createViewer(makeViewerText(200));

			// 到顶，PgDn 向下翻一页 → 首行消失
			viewer.component.handleInput("g");
			expect(viewer.component.render(WIDTH).join("\n")).toContain("AA-START-MARKER");
			viewer.component.handleInput("\x1b[6~"); // PgDn
			expect(viewer.component.render(WIDTH).join("\n")).not.toContain("AA-START-MARKER");

			// PgUp 翻回顶部
			viewer.component.handleInput("\x1b[5~"); // PgUp
			expect(viewer.component.render(WIDTH).join("\n")).toContain("AA-START-MARKER");

			// Space（PageDown 替代键）向下翻页
			viewer.component.handleInput(" ");
			expect(viewer.component.render(WIDTH).join("\n")).not.toContain("AA-START-MARKER");

			// b（PageUp 替代键）翻回顶部
			viewer.component.handleInput("b");
			expect(viewer.component.render(WIDTH).join("\n")).toContain("AA-START-MARKER");
		});
	});

	it("should close on q / Enter / Esc", () => {
		withRows(50, () => {
			for (const data of ["q", "\r", "\x1b"]) {
				const onClose = vi.fn();
				const viewer = createViewer(makeViewerText(200), onClose);
				viewer.component.handleInput(data);
				expect(onClose).toHaveBeenCalledTimes(1);
			}
		});
	});

	it("should not crash on keys when tui is null", () => {
		withRows(50, () => {
			const viewer = createViewer(makeViewerText(200), () => {}, null);
			viewer.component.handleInput("j");
			viewer.component.handleInput("g");
			expect(viewer.component.render(WIDTH).join("\n")).toContain("AA-START-MARKER");
		});
	});

	it("should not crash and show the last line for a 2-line short text", () => {
		withRows(50, () => {
			const viewer = createViewer("AA-START-MARKER\n[assistant] ZZ-END-MARKER: ok");
			const out = viewer.component.render(WIDTH);
			expect(out.length).toBeLessThanOrEqual(50);
			expect(out.join("\n")).toContain("ZZ-END-MARKER");
			expect(out.join("\n")).toContain("AA-START-MARKER");
			viewer.scrollToEnd();
			expect(viewer.component.render(WIDTH).join("\n")).toContain("ZZ-END-MARKER");
		});
	});

	// ------------------------------------------------------------------
	// scrollBy（约定与旧实现一致：正数向下/向末尾）
	// ------------------------------------------------------------------
	it("should move with scrollBy relative lines", () => {
		withRows(50, () => {
			const viewer = createViewer(makeViewerText(200));
			viewer.scrollToEnd();
			viewer.scrollBy(-100000);
			expect(viewer.component.render(WIDTH).join("\n")).toContain("AA-START-MARKER");
			viewer.scrollBy(100000);
			expect(viewer.component.render(WIDTH).join("\n")).toContain("ZZ-END-MARKER");
		});
	});
});
