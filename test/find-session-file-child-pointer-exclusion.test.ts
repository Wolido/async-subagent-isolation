/**
 * 红阶段测试：`src/index.ts` 的 `findSessionFile` 必须排除 sidecar 指针文件
 * `children.jsonl`（/subagent-result、已完成任务 picker、/subagent-web 服务共用
 * 的会话文件发现逻辑）。
 *
 * 缺陷背景：sidecar 指针文件名 `children.jsonl` 以 `.jsonl` 结尾，而
 * findSessionFile 选「目录内 mtime 最新的 .jsonl」——若任务目录里
 * children.jsonl 的 mtime 新于它自己的会话 .jsonl，就会被误当会话文件返回，
 * 下游读到的是指针记录而非会话内容。sidecar 必须被排除（文件名固定，不改名）。
 *
 * 用例：
 *   1. 目录内同时有会话 .jsonl（mtime 较旧）与 mtime 更新的 children.jsonl →
 *      返回会话 .jsonl 路径，不是 children.jsonl。
 *   2. 目录里只有 children.jsonl、没有任何会话 .jsonl → 返回 null（sidecar
 *      不被当会话文件）。
 *
 * 约定（沿仓库惯例，同 test/subagent-pointer-write.test.ts）：globals:false
 * 显式 import from "vitest"；vi.mock 把 getAgentDir 换成 vi.fn() 指向临时目录；
 * fixture 用 fs.mkdtempSync(os.tmpdir()) + afterEach 递归删除；mtime 全部显式
 * 设定，测试确定性不依赖真实时钟。
 */

import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { findSessionFile } from "../src/index.ts";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

vi.mock("@earendil-works/pi-coding-agent", async () => {
	const actual = await vi.importActual("@earendil-works/pi-coding-agent");
	return {
		...actual,
		getAgentDir: vi.fn(),
	};
});

/** 注入的固定时间戳：所有 mtime 相对它设定，不依赖真实时钟。 */
const NOW = 1_800_000_000_000;

/** uuid 形状的固定 taskId（version 4 形状，通过 getSubagentSessionDir 的遍历守卫）。 */
const TASK_ID = "019ffdd3-3eb5-733d-b481-a53e5292bd01";

function iso(ms: number): string {
	return new Date(ms).toISOString();
}

/** 设定路径 mtime。 */
function setMtime(p: string, mtimeMs: number): void {
	const d = new Date(mtimeMs);
	fs.utimesSync(p, d, d);
}

let tmpBase: string;
let agentDir: string;

beforeEach(() => {
	tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "find-session-file-sidecar-"));
	agentDir = path.join(tmpBase, "agent-dir");
	fs.mkdirSync(agentDir, { recursive: true });
	vi.mocked(getAgentDir).mockReturnValue(agentDir);
});

afterEach(() => {
	fs.rmSync(tmpBase, { recursive: true, force: true });
	vi.clearAllMocks();
});

/** 任务会话目录：<agentDir>/subagent-sessions/<TASK_ID>/。 */
function taskDir(): string {
	return path.join(agentDir, "subagent-sessions", TASK_ID);
}

// ================================================================
// 1. 会话 .jsonl 与更新的 children.jsonl 并存 → 返回会话文件
// ================================================================
describe("findSessionFile 的 sidecar 排除", () => {
	it("should return the session jsonl rather than the newer sidecar children.jsonl when both live in the task directory", () => {
		// Arrange: 会话 .jsonl（mtime = NOW−10s）+ children.jsonl（mtime = NOW−2s，更新）
		fs.mkdirSync(taskDir(), { recursive: true });
		const sessionFile = path.join(taskDir(), `${iso(NOW - 10_000)}_${TASK_ID}.jsonl`);
		fs.writeFileSync(
			sessionFile,
			JSON.stringify({ type: "session", sessionId: TASK_ID, timestamp: iso(NOW - 10_000) }) + "\n",
			"utf-8",
		);
		setMtime(sessionFile, NOW - 10_000);
		const sidecar = path.join(taskDir(), "children.jsonl");
		fs.writeFileSync(
			sidecar,
			JSON.stringify({
				childTaskId: "00000000-0000-4000-8000-000000000001",
				agent: "tester",
				task: "pointer target",
				startedAt: NOW - 9_000,
				depth: 2,
			}) + "\n",
			"utf-8",
		);
		setMtime(sidecar, NOW - 2_000);

		// Act
		const found = findSessionFile(TASK_ID);

		// Assert: 返回会话 .jsonl，不是 sidecar
		expect(found).toBe(sessionFile);
		expect(found).not.toBe(sidecar);
	});
});

// ================================================================
// 2. 目录里只有 children.jsonl → null
// ================================================================
describe("findSessionFile 对纯 sidecar 目录", () => {
	it("should return null when the task directory holds only the sidecar children.jsonl and no session file", () => {
		// Arrange: 只写 children.jsonl，没有任何会话 .jsonl
		fs.mkdirSync(taskDir(), { recursive: true });
		fs.writeFileSync(
			path.join(taskDir(), "children.jsonl"),
			JSON.stringify({
				childTaskId: "00000000-0000-4000-8000-000000000002",
				agent: "tester",
				task: "pointer target",
				startedAt: NOW - 9_000,
				depth: 2,
			}) + "\n",
			"utf-8",
		);

		// Act
		const found = findSessionFile(TASK_ID);

		// Assert: sidecar 不是会话文件 → null
		expect(found).toBeNull();
	});
});
