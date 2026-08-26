/**
 * 文档链接守卫测试
 *
 * 背景：README 中指向同步版旧仓库 Wolido/subagent-isolation 的 examples 链接
 * 应改为指向本仓库 Wolido/async-subagent-isolation。本测试作为回归锁，防止
 * 修复时误删正当的旧仓库根引用，也防止修复不彻底。
 *
 * 规则：
 *   R1（禁止项）：文档/package.json/src 源码中不得出现指向旧仓库 examples 路径的链接。
 *   R2（保留项）：README.md / README.en.md 中指向旧仓库根的整链引用必须保留（≥2 处）。
 *   R3（自洽性）：修复后 examples 链接应指向本仓库，且 coder/reviewer/writer 齐备。
 *
 * 收紧记录（4 项盲区修补）：
 *   ① R2 整链匹配：从"URL 子串 + 前瞻"改为匹配完整 Markdown 链接字面量
 *      \[subagent-isolation\]\(https:\/\/github\.com\/Wolido\/subagent-isolation\)。
 *      URL 后紧跟 ) 才算链接结束，天然消除分支斜杠歧义；同时锁定显示文字，
 *      防止"显示文字被改而 URL 不动"时漏报。计数改为 matchAll 按出现次数，
 *      消除"两处引用挤在同一行时 count=1 误判"的隐患。
 *   ② 分支名斜杠歧义：R1/R3 的分支段从 [^/]+ 改为 [^)\s]*?（惰性），
 *      可跨斜杠匹配 feat/x 等分支名，同时不吞空格与右括号。
 *   ③ R1 扫描清单扩展：从 DOC_FILES 扩到"文档 + package.json + src/*.ts"。
 *      显式清单，绝不进入 test/（本文件自身字面包含 github.com/Wolido 字符串，
 *      自扫即假阳性）、node_modules、.git、package-lock.json、dist。
 *   ④ R1 全量收集：从 text.match() 只取每行第一处改为 matchAll 收集所有命中，
 *      消除"同一行两处非法链接只报一条"的隐患。
 */

import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";

// 以仓库根为基准解析路径
const REPO_ROOT = path.resolve(__dirname, "..");

/** 需要扫描的文档列表（相对于仓库根） */
const DOC_FILES = [
	"README.md",
	"README.en.md",
	"ADVANCED.md",
	"ADVANCED.en.md",
	"examples/README.md",
	"examples/README.en.md",
	"CHANGELOG.md",
] as const;

/**
 * R1 扫描清单：文档 + package.json + src/*.ts 源码。
 * 显式构建，绝不进入 test/（本文件自身字面包含 github.com/Wolido 字符串，自扫即假阳性）、
 * node_modules、.git、package-lock.json、dist。
 */
function getR1ScanFiles(): string[] {
	const files: string[] = [...DOC_FILES];
	files.push("package.json");
	// 仅扫描 src/ 下的 .ts 文件，受控递归，不涉及 test/ 等目录
	const srcDir = path.join(REPO_ROOT, "src");
	if (fs.existsSync(srcDir)) {
		for (const entry of fs.readdirSync(srcDir)) {
			if (entry.endsWith(".ts")) {
				files.push(path.join("src", entry));
			}
		}
	}
	return files;
}

/**
 * R1：指向旧仓库 examples 路径的链接（tree 或 blob）。
 * 分支段用 [^)\s]*? 惰性匹配（收紧②），可跨斜杠匹配 feat/x 等分支名，
 * 同时不吞空格与右括号，防止越界。
 */
const OLD_REPO_EXAMPLES_RE =
	/https:\/\/github\.com\/Wolido\/subagent-isolation\/(?:tree|blob)\/[^)\s]*?\/examples\//;
/** R1 用 g 标志版本（供 matchAll 使用，收紧④） */
const OLD_REPO_EXAMPLES_RE_G = new RegExp(OLD_REPO_EXAMPLES_RE.source, "g");

/**
 * R2：整链匹配 — 锁显示文字 [subagent-isolation] + URL 一体（收紧①）。
 * URL 后紧跟 ) 才算链接结束，天然消除分支斜杠歧义。
 */
const OLD_REPO_ROOT_LINK_RE =
	/\[subagent-isolation\]\(https:\/\/github\.com\/Wolido\/subagent-isolation\)/;
/** R2 用 g 标志版本（供 matchAll 使用） */
const OLD_REPO_ROOT_LINK_RE_G = new RegExp(OLD_REPO_ROOT_LINK_RE.source, "g");

/**
 * R3：指向本仓库 examples 路径的链接。
 * 分支段用 [^)\s]*? 惰性匹配（收紧②），可跨斜杠匹配 feat/x 等分支名。
 */
const NEW_REPO_EXAMPLES_RE =
	/https:\/\/github\.com\/Wolido\/async-subagent-isolation\/(?:tree|blob)\/[^)\s]*?\/examples\//;

/** 读取文件并按行返回，附带行号信息 */
function readLines(relPath: string): { line: number; text: string }[] {
	const abs = path.join(REPO_ROOT, relPath);
	if (!fs.existsSync(abs)) return [];
	const content = fs.readFileSync(abs, "utf-8");
	return content.split("\n").map((text, i) => ({ line: i + 1, text }));
}

/**
 * 扫描 R1 清单，收集所有命中的 URL（收紧④：matchAll 收集同行多处）。
 * 使用 OLD_REPO_EXAMPLES_RE_G（带 g 标志）确保不遗漏同行多处命中。
 * 注意：matchAll 每次创建新迭代器，无 lastIndex 状态残留问题。
 */
function scanForbiddenLinks(): { file: string; line: number; url: string }[] {
	const hits: { file: string; line: number; url: string }[] = [];
	for (const doc of getR1ScanFiles()) {
		for (const { line, text } of readLines(doc)) {
			for (const match of text.matchAll(OLD_REPO_EXAMPLES_RE_G)) {
				// 提取完整 URL（从匹配位置到下一个空格或 `)` 或 `]`）
				const start = match.index!;
				let end = text.length;
				for (let i = start; i < text.length; i++) {
					if (text[i] === " " || text[i] === ")" || text[i] === "]") {
						end = i;
						break;
					}
				}
				hits.push({ file: doc, line, url: text.slice(start, end) });
			}
		}
	}
	return hits;
}

describe("文档链接守卫", () => {
	// ──────────────────────────────────────────────
	// R1：禁止项 — 不得出现指向旧仓库 examples 路径的链接
	// ──────────────────────────────────────────────
	it("R1: 所有扫描文件中不得出现指向旧仓库 examples 路径的链接", () => {
		const hits = scanForbiddenLinks();
		if (hits.length > 0) {
			const details = hits
				.map((h) => `  ${h.file}:${h.line}  →  ${h.url}`)
				.join("\n");
			throw new Error(
				`R1 失败：发现 ${hits.length} 处指向旧仓库 examples 的链接：\n${details}`,
			);
		}
		expect(hits).toHaveLength(0);
	});

	// ──────────────────────────────────────────────
	// R2：保留项 — 旧仓库根整链引用必须仍然存在（防误删）
	// ──────────────────────────────────────────────
	describe("R2: README 中指向旧仓库根的正当整链引用必须保留", () => {
		for (const doc of ["README.md", "README.en.md"] as const) {
			it(`${doc} 应保留至少 2 处 [subagent-isolation](...) 整链引用`, () => {
				const content = fs.readFileSync(path.join(REPO_ROOT, doc), "utf-8");
				// 收紧①：按出现次数（matchAll）而非按行计数
				const matches = [...content.matchAll(OLD_REPO_ROOT_LINK_RE_G)];
				const count = matches.length;
				expect(
					count,
					`${doc} 中 [subagent-isolation](https://github.com/Wolido/subagent-isolation) 整链引用不足 2 处（实际 ${count} 处），` +
						"修复 examples 链接时请勿删除正当的同步版原项目引用",
				).toBeGreaterThanOrEqual(2);
			});
		}
	});

	// ──────────────────────────────────────────────
	// R3：自洽性 — 修复后 examples 链接应指向本仓库且齐备
	// ──────────────────────────────────────────────
	describe("R3: 修复后 examples 链接应指向本仓库且 agent 文件齐备", () => {
		for (const doc of ["README.md", "README.en.md"] as const) {
			it(`${doc} 应包含指向本仓库 examples 的链接`, () => {
				const lines = readLines(doc);
				const hasNewExamplesLink = lines.some(({ text }) =>
					NEW_REPO_EXAMPLES_RE.test(text),
				);
				expect(
					hasNewExamplesLink,
					`${doc} 缺少指向 github.com/Wolido/async-subagent-isolation 的 examples 链接`,
				).toBe(true);
			});

			it(`${doc} 应包含 coder.md 链接`, () => {
				const lines = readLines(doc);
				const hasCoder = lines.some(({ text }) =>
					/async-subagent-isolation\/[^)]*coder\.md/.test(text),
				);
				expect(hasCoder, `${doc} 缺少 coder.md 链接`).toBe(true);
			});

			it(`${doc} 应包含 reviewer.md 链接`, () => {
				const lines = readLines(doc);
				const hasReviewer = lines.some(({ text }) =>
					/async-subagent-isolation\/[^)]*reviewer\.md/.test(text),
				);
				expect(hasReviewer, `${doc} 缺少 reviewer.md 链接`).toBe(true);
			});

			it(`${doc} 应包含 writer.md 链接`, () => {
				const lines = readLines(doc);
				const hasWriter = lines.some(({ text }) =>
					/async-subagent-isolation\/[^)]*writer\.md/.test(text),
				);
				expect(hasWriter, `${doc} 缺少 writer.md 链接`).toBe(true);
			});
		}
	});

	// ──────────────────────────────────────────────
	// 收紧验证：正则行为单元测试（证明盲区已闭合）
	// ──────────────────────────────────────────────
	describe("收紧验证：R2 整链匹配（收紧①）", () => {
		it("应匹配完整的 [subagent-isolation](...) 链接", () => {
			expect(
				OLD_REPO_ROOT_LINK_RE.test(
					"[subagent-isolation](https://github.com/Wolido/subagent-isolation)",
				),
			).toBe(true);
		});

		it("不应匹配显示文字被改的链接（盲区①闭合）", () => {
			// 显示文字从 [subagent-isolation] 改为 [sync-version]，URL 不动
			expect(
				OLD_REPO_ROOT_LINK_RE.test(
					"[sync-version](https://github.com/Wolido/subagent-isolation)",
				),
			).toBe(false);
		});

		it("不应匹配 URL 后带路径的链接（分支斜杠歧义消除）", () => {
			// URL 后跟 /tree/main 等路径，不是合法的根引用
			expect(
				OLD_REPO_ROOT_LINK_RE.test(
					"[subagent-isolation](https://github.com/Wolido/subagent-isolation/tree/main)",
				),
			).toBe(false);
		});
	});

	describe("收紧验证：分支名斜杠歧义（收紧②）", () => {
		it("R1 应匹配带斜杠分支名的旧仓库 examples 链接", () => {
			expect(
				OLD_REPO_EXAMPLES_RE.test(
					"https://github.com/Wolido/subagent-isolation/tree/feat/x/examples/pi/agent/agents",
				),
			).toBe(true);
		});

		it("R1 应匹配常规分支名（无斜杠）", () => {
			expect(
				OLD_REPO_EXAMPLES_RE.test(
					"https://github.com/Wolido/subagent-isolation/tree/main/examples/pi/agent/agents",
				),
			).toBe(true);
		});

		it("R1 应匹配 blob 类型链接", () => {
			expect(
				OLD_REPO_EXAMPLES_RE.test(
					"https://github.com/Wolido/subagent-isolation/blob/dev/examples/agent/agents",
				),
			).toBe(true);
		});

		it("R3 应匹配带斜杠分支名的本仓库 examples 链接", () => {
			expect(
				NEW_REPO_EXAMPLES_RE.test(
					"https://github.com/Wolido/async-subagent-isolation/tree/feat/x/examples/pi/agent/agents",
				),
			).toBe(true);
		});

		it("R1 不应越过右括号匹配（防止越界）", () => {
			// URL 在 ) 后还有内容，正则不应越过 )
			const text = "[label](https://github.com/Wolido/subagent-isolation/tree/main/examples/pi) extra";
			const match = text.match(OLD_REPO_EXAMPLES_RE);
			expect(match).not.toBeNull();
			// 匹配应在 /examples/ 后停止，不包含 ) 或 extra
			expect(match![0]).toBe(
				"https://github.com/Wolido/subagent-isolation/tree/main/examples/",
			);
		});
	});

	describe("收紧验证：R1 扫描清单扩展（收紧③）", () => {
		it("扫描清单应包含 package.json", () => {
			expect(getR1ScanFiles()).toContain("package.json");
		});

		it("扫描清单应包含 src/*.ts 文件", () => {
			const files = getR1ScanFiles();
			const srcFiles = files.filter((f) => f.startsWith("src/"));
			expect(srcFiles.length).toBeGreaterThan(0);
			for (const f of srcFiles) {
				expect(f).toMatch(/\.ts$/);
			}
		});

		it("扫描清单不应包含 test/ 目录", () => {
			const files = getR1ScanFiles();
			for (const f of files) {
				expect(f.startsWith("test/")).toBe(false);
				expect(f.startsWith("node_modules/")).toBe(false);
				expect(f.startsWith(".git/")).toBe(false);
				expect(f).not.toBe("package-lock.json");
				expect(f.startsWith("dist/")).toBe(false);
			}
		});

		it("当前仓库 R1 对 package.json + src/*.ts 判为 0 命中", () => {
			const hits = scanForbiddenLinks();
			const codeHits = hits.filter(
				(h) => h.file === "package.json" || h.file.startsWith("src/"),
			);
			expect(codeHits).toHaveLength(0);
		});
	});

	describe("收紧验证：R1 全量收集（收紧④）", () => {
		it("matchAll 应收集同行多处命中", () => {
			const text =
				"[a](https://github.com/Wolido/subagent-isolation/tree/main/examples/pi) [b](https://github.com/Wolido/subagent-isolation/blob/dev/examples/agent)";
			const matches = [...text.matchAll(OLD_REPO_EXAMPLES_RE_G)];
			expect(matches.length).toBe(2);
		});

		it("matchAll 应收集单行单处命中", () => {
			const text =
				"[a](https://github.com/Wolido/subagent-isolation/tree/main/examples/pi)";
			const matches = [...text.matchAll(OLD_REPO_EXAMPLES_RE_G)];
			expect(matches.length).toBe(1);
		});

		it("matchAll 应返回空数组当无命中", () => {
			const text = "no forbidden links here";
			const matches = [...text.matchAll(OLD_REPO_EXAMPLES_RE_G)];
			expect(matches.length).toBe(0);
		});
	});
});
