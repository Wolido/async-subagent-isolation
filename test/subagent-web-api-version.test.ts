/**
 * 红阶段测试：`src/web/api-version.ts` —— web API 版本字面量模块（新契约第 7 轮）。
 *
 * 被测接口（固定签名）：
 *   export const API_VERSION = 2;
 *
 * 消费方：
 *   - src/web/server.ts：/api/tree 响应的 apiVersion 字段、/api/session 所有 200
 *     分支（forward 与 before/back）的 apiVersion 字段（server 侧由
 *     test/subagent-web-server.test.ts 经 HTTP 断言 `apiVersion === 2`）；
 *   - src/web/page.ts：后续 import 并把该字面量内联进页面脚本。
 *
 * 模块尚不存在时，本文件整体 import 失败属预期红。
 *
 * 约定（沿仓库惯例，同 test/subagent-web-tail.test.ts）：globals:false 显式
 * import from "vitest"。
 */

import { describe, expect, it } from "vitest";
import { API_VERSION } from "../src/web/api-version.ts";

describe("web API 版本常量", () => {
	it("should export API_VERSION as 2", () => {
		// Arrange + Act: 直接读取模块导出
		const version = API_VERSION;

		// Assert: 第 7 轮契约把 web API 版本定为 2（/api/tree 由数组改对象即 v2）
		expect(version).toBe(2);
	});
});
