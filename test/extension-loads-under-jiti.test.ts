/**
 * jiti 真实加载路径测试：用 pi 自带的 jiti 加载 src/index.ts（而非 vitest 的
 * import），复现 pi 加载扩展的真实路径。
 *
 * 本测试只做冒烟：验证当前全 .ts 的 src/index.ts 能被 jiti 真实加载、且默认导出
 * 是函数。注意：jiti 2.7.0 默认配置原生支持 `.js → .ts` 映射（已实测），所以
 * `.js` 后缀本身不会导致加载失败，本测试无法拦截「后缀被改回 .js」这一回归；
 * 该后缀约定的守卫在 test/module-import-convention.test.ts（C1 静态扫描）。
 *
 * jiti 的解析（不硬编码绝对路径）：
 * - brief 推荐的 `require.resolve("@earendil-works/pi-coding-agent/package.json")`
 *   在本环境抛 ERR_PACKAGE_PATH_NOT_EXPORTED——pi 包的 exports 只声明了
 *   "import" 条件、且未导出 ./package.json 子路径，CJS 侧无法解析。
 * - 退一步：按仓库 npm 扁平布局（package-lock.json / node_modules 扁平）从
 *   import.meta.url 推导仓库根，拼出 pi 包目录（相对路径推导，非硬编码绝对
 *   路径），再以 pi 包目录为锚点解析其私有依赖 jiti：
 *     require.resolve("jiti", { paths: [piPackageDir] })
 *   若该路径不存在，测试直接失败并给出明确诊断（不静默跳过）。
 *
 * jiti API 形态（实测 node_modules/@earendil-works/pi-coding-agent/node_modules/jiti
 * 为 jiti 2.7.0）：CJS/ESM 入口均只有命名导出 createJiti(id, opts?)（无默认导出），
 * 返回 jiti 实例；实例上有同步 require 风格调用与异步 .import(id, opts?)。
 * pi 的 loader（dist/core/extensions/loader.js）内部用法即
 * `createJiti(import.meta.url, {...}).import(extensionPath, { default: true })`。
 * 本测试用 `jiti.import(entry)` 取回模块 namespace 后断言 `ext.default`，
 * 与 pi 拿到的默认导出是同一对象（pi 只是多做了一层 { default: true } 解包）。
 *
 * 选项：使用默认配置创建实例。pi 实际额外传 moduleCache:false / virtualModules /
 * tsconfigPaths（或 alias），只影响缓存与包别名，不影响相对 specifier 的扩展名
 * 解析行为；为最小化与 brief「默认配置」要求的偏差，此处不传任何选项。
 */

import { describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ENTRY = path.join(REPO_ROOT, "src", "index.ts");

// jiti 2.7.0：命名导出 createJiti；实例的 .import() 返回模块 namespace。
type JitiInstance = ((id: string) => unknown) & {
	import: (id: string) => Promise<{ default?: unknown }>;
};

/**
 * 从 pi 的依赖树解析 jiti（路径全部由 import.meta.url 推导，无硬编码绝对路径）。
 * jiti 解析失败时抛错并附诊断，测试红而非静默跳过。
 */
function resolveJitiCreate(): (id: string) => JitiInstance {
	const piPackageDir = path.join(
		REPO_ROOT,
		"node_modules",
		"@earendil-works",
		"pi-coding-agent",
	);
	if (!existsSync(piPackageDir)) {
		throw new Error(
			`[jiti-diag] pi package dir not found at ${piPackageDir}; ` +
				`jiti cannot be resolved from pi's dependency tree (environment missing dependency?)`,
		);
	}
	try {
		const jitiPath = require.resolve("jiti", { paths: [piPackageDir] });
		// jiti 2.7.0 无默认导出，仅命名导出 createJiti（实测 lib/jiti.cjs）。
		const { createJiti } = require(jitiPath) as {
			createJiti: (id: string) => JitiInstance;
		};
		return createJiti;
	} catch (err) {
		throw new Error(
			`[jiti-diag] failed to resolve jiti from ${piPackageDir}: ${(err as Error).message}`,
		);
	}
}

describe("extension entry loads under pi's jiti loader", () => {
	it("should resolve jiti from pi's dependency tree", () => {
		// Arrange + Act：解析失败会抛错（含 [jiti-diag] 诊断），测试直接红
		const createJiti = resolveJitiCreate();

		// Assert
		expect(typeof createJiti).toBe("function");
	});

	it("should load src/index.ts with default-config jiti and expose a function default export", async () => {
		// Arrange：默认配置创建 jiti 实例（理由见文件头注释）
		const createJiti = resolveJitiCreate();
		const jiti = createJiti(import.meta.url);

		// Act：走 jiti 的真实加载路径（非 vitest import），加载过程抛错即红
		const ext = await jiti.import(ENTRY);

		// Assert：默认导出是扩展工厂函数
		expect(typeof ext.default).toBe("function");
	});
});
