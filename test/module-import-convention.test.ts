/**
 * 导入约定静态守卫：src/** 内所有相对 import/export specifier 必须以 .ts 结尾
 * 且指向真实存在的文件（纯静态扫描，node:fs + node:path，不依赖任何外部 glob 包）。
 *
 * 背景：vitest/vite 会把相对导入中的 `.js` 映射到同名 `.ts`，所以在 vitest 下
 * `./a.js` 全绿；jiti 2.7.0 默认配置同样原生支持 `.js → .ts` 映射（已实测，见
 * test/extension-loads-under-jiti.test.ts），因此该冒烟测试无法拦截 `.js` 回归。
 * 本文件是 `.ts` 后缀约定的唯一守卫：直接静态扫描源码，不依赖任何运行时加载器，
 * 保证源码层面统一使用 .ts 后缀（本机其它可用多文件扩展一律用 .ts 后缀）。
 *
 * 覆盖形式：
 *   import { X } from "./a.ts"
 *   import type { Y } from "./a.ts"
 *   export ... from "./a.ts"
 *   import "./a.ts"              (side-effect)
 *   import("./a.ts")             (dynamic)
 * 只处理以 ./ 或 ../ 开头的相对 specifier；包导入（"vitest"、"node:fs"、
 * "@earendil-works/..." 等）忽略。
 */

import { describe, expect, it } from "vitest";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SRC_DIR = path.join(REPO_ROOT, "src");

/** 递归收集 src/ 下全部 .ts 文件（不引入外部 glob 包）。 */
function listTsFiles(dir: string): string[] {
	const out: string[] = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) out.push(...listTsFiles(full));
		else if (entry.name.endsWith(".ts")) out.push(full);
	}
	return out;
}

interface SpecifierHit {
	/** 相对仓库根的文件路径（失败信息可读）。 */
	file: string;
	/** 1-based 行号。 */
	line: number;
	specifier: string;
}

/** 从单行源码中抽取相对 specifier（./ 或 ../ 开头），带行号。 */
const RELATIVE_SPECIFIER_PATTERNS: RegExp[] = [
	// import { X } from "./a.ts" / import type { Y } from "./a.ts" / export ... from "./a.ts"
	/\bfrom\s*["'](\.{1,2}\/[^"']*)["']/g,
	// side-effect: import "./a.ts"
	/(?:^|\s)import\s+["'](\.{1,2}\/[^"']*)["']/g,
	// dynamic: import("./a.ts")
	/\bimport\s*\(\s*["'](\.{1,2}\/[^"']*)["']/g,
];

function relativeSpecifiersIn(absFile: string): SpecifierHit[] {
	const content = readFileSync(absFile, "utf8");
	const rel = path.relative(REPO_ROOT, absFile);
	const hits: SpecifierHit[] = [];
	content.split(/\r?\n/).forEach((lineText, i) => {
		for (const re of RELATIVE_SPECIFIER_PATTERNS) {
			re.lastIndex = 0;
			for (const m of lineText.matchAll(re)) {
				hits.push({ file: rel, line: i + 1, specifier: m[1] });
			}
		}
	});
	return hits;
}

/** 收集 src/ 下所有相对 specifier 的违规（文件:行号 + specifier）。 */
function collectViolations(check: (hit: SpecifierHit) => string | null): string[] {
	const violations: string[] = [];
	for (const absFile of listTsFiles(SRC_DIR)) {
		for (const hit of relativeSpecifiersIn(absFile)) {
			const reason = check(hit);
			if (reason !== null) {
				violations.push(`${hit.file}:${hit.line}  ${reason}  (${hit.specifier})`);
			}
		}
	}
	return violations;
}

describe("import convention: relative specifiers in src/", () => {
	it("should use .ts suffix in all relative import/export specifiers", () => {
		// Arrange + Act：逐条收集以 .js（或其它非 .ts）结尾的相对 specifier 违规
		const violations = collectViolations((hit) =>
			!hit.specifier.endsWith(".ts")
				? `relative specifier must end with .ts (jiti/loader-agnostic convention)`
				: null,
		);

		// Assert：任何一条违规都带 文件路径:行号，统一报出
		expect(violations).toEqual([]);
	});

	it("should resolve every relative .ts specifier to an existing file", () => {
		// Arrange + Act：把 .ts specifier 解析为相对该文件的绝对路径并 existsSync
		const violations = collectViolations((hit) => {
			if (!hit.specifier.endsWith(".ts")) return null; // 由上一个用例负责
			const target = path.resolve(path.dirname(path.join(REPO_ROOT, hit.file)), hit.specifier);
			return existsSync(target)
				? null
				: `relative specifier target does not exist (resolved: ${path.relative(REPO_ROOT, target)})`;
		});

		// Assert
		expect(violations).toEqual([]);
	});
});
