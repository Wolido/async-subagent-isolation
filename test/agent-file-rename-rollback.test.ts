/**
 * 阶段 4 清理清单 4（改写）：updateAgentFile 改名功能已移除 —— name 是只读
 * 身份标识，不再可编辑。
 *
 * 背景：用户决策移除改名功能（/subagent-config 中 name 字段不再可编辑）。
 * 改名引发的一整串问题（文件重命名、冲突检测、unlink 回滚、filePath 刷新、
 * 二次 rename ENOENT）不再有 UI 入口，rename 分支整体移除。原契约（改名时
 * unlink(旧文件) 失败的回滚）随分支删除而作废——回滚测试钉死的
 * writeFileSync(新文件) → unlinkSync(旧文件) 序列不再存在。
 *
 * 本文件钉死的契约（红阶段，待 coder 实现）：
 *   updateAgentFile(filePath, { name }) —— 任何 name patch（含合法新名）都
 *   必须整体拒绝：
 *     1. 返回 { ok: false, error }（不抛异常、error 非空字符串）；
 *     2. 文件字节逐字不变；
 *     3. 不发生任何文件系统改动：不创建新文件、不重命名、不删除旧文件
 *        （目录内容与调用前完全一致）；
 *     4. name 与其它字段混在一起的 patch 同样整体拒绝（不半写）。
 *   控制用例：description patch 照常工作（回归，防过度删除）。
 */

import { describe, expect, it, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { updateAgentFile } from "../src/index.ts";

const OLD_CONTENT = "---\nname: old-agent\ndescription: old agent\n---\nYou are old.\n";

let tmpDir: string;
let oldPath: string;

beforeEach(() => {
	tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "rename-rejected-test-"));
	oldPath = path.join(tmpDir, "old-agent.md");
	fs.writeFileSync(oldPath, OLD_CONTENT, "utf-8");
});

afterEach(() => {
	fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("清理清单 4（改写）. updateAgentFile 拒绝任何 name patch（改名功能移除）", () => {
	it("should reject a valid name patch outright, leaving the directory byte-identical (不重命名、不新建、不删除)", () => {
		// Arrange
		const before = fs.readFileSync(oldPath, "utf-8");

		// Act: 合法新名（非空、无非法字符）也整体拒绝
		const result = updateAgentFile(oldPath, { name: "new-agent" });

		// Assert: ok:false + 可读 error + 不抛异常
		expect(result.ok, "任何 name patch 必须返回 ok:false（不得抛出异常）").toBe(false);
		expect(typeof (result as { error?: unknown }).error).toBe("string");
		expect((result as { error: string }).error.length).toBeGreaterThan(0);
		// 文件字节不变；目录无任何新文件（不得先写新文件再回滚的残留）
		expect(fs.readFileSync(oldPath, "utf-8"), "旧文件内容必须逐字保留").toBe(before);
		expect(fs.readdirSync(tmpDir), "目录内容必须与调用前完全一致（不得 rename/新建/删除）").toEqual(["old-agent.md"]);
	});

	it("should reject a name+description combined patch wholesale (不半写：合法 description 也不得写入)", () => {
		// Arrange
		const before = fs.readFileSync(oldPath, "utf-8");

		// Act: patch 同时含 name 与 description
		const result = updateAgentFile(oldPath, { name: "new-agent", description: "Should not land" });

		// Assert: 整体拒绝，description 不落盘、无任何文件系统改动
		expect(result.ok).toBe(false);
		expect(fs.readFileSync(oldPath, "utf-8")).toBe(before);
		expect(fs.readdirSync(tmpDir)).toEqual(["old-agent.md"]);
	});

	it("should still patch description normally (control: 非 name 字段不受影响)", () => {
		// Act
		const result = updateAgentFile(oldPath, { description: "updated description" });

		// Assert: 写回成功、语义正确、无重命名
		expect(result.ok).toBe(true);
		expect(fs.readFileSync(oldPath, "utf-8")).toContain("description: updated description");
		expect(fs.readdirSync(tmpDir)).toEqual(["old-agent.md"]);
	});
});
