/**
 * 红阶段回归测试：「bash 工具结果被 GFM 删除线划掉」缺陷
 * （修复方案 A'：toolResult 改走纯文本 textBlock() 路径，其余角色不动）。
 *
 * 根因（已定稿，不在此重新论证）：src/web/page.ts 的 renderMessage() 在
 * role === "toolResult" 分支以 markdown=true 调用 details(label, content,
 * "tool-result", true)，内容进入 renderMarkdown() → marked.parse(
 * escapeRawHtml(text))。marked v18 GFM 删除线单个 ~ 即定界，shell 提示符
 * student@debian:~$ 里的 ~ 一配对就把中间包成 <del>；同时换行被折叠、以
 * - / 1. / # / > 开头的行被重解释为列表/标题。bash 输出是逐字节工具事实，
 * 必须原样呈现，不得经 markdown 重解释。
 *
 * 本文件经 test/page-dom-harness.ts（node:vm + 手写最小 DOM stub，零新增依赖）
 * 真执行主 <script>：boot 到 #/t/task-a，经 fetch stub 的 /api/session 应答注入
 * {type:"message", message:{role:"toolResult", toolName:"bash", content}} 转录
 * 行（结构与 src/web/server.ts handleSessionRequest 透传的 JSONL 一致），断言
 * 渲染进 #transcript 的工具结果容器。marked 在 harness 里是恒等桩，故本文件锁
 * 的是 DOM 结构契约（内容容器 .text 而非 .text.markdown、textContent 逐字节、
 * 子树无 <del> 元素）；「真实 marked 会产出 <del>」的根因证明见
 * test/subagent-web-page.test.ts 文末字符串级契约组（修复前红，修复后绿）。
 *
 * 覆盖三种 toolResult 注入形态（reviewer 盲审补回归）：字符串 content（原用例）、
 * 数组 content（agent 协议标准形态，server.ts 将 JSONL 解析后的 message.content
 * 原样透传，数组不进任何结构变换），以及 isError:true 的错误分支
 * （容器 .error 类 + summary "(error)" 文案）。
 *
 * 预期：修复前本文件用例红（.entry.tool-result 的内容容器带 .markdown 类）；
 * coder 按方案 A' 落地后转绿。
 */

import { describe, expect, it } from "vitest";
import { createPageDomHarness, type DomEl, type PageDomHarness } from "./page-dom-harness.ts";

const API_V = 2;

/** bash 输出样本：含两个 ~（GFM 删除线定界符）与两个 $（提示符尾符），换行不得折叠。 */
const BASH_OUTPUT = "student@debian:~$ pwd\n/home/student\nstudent@debian:~$ ls -la";

function finishedNode(taskId: string): Record<string, unknown> {
	return {
		taskId,
		agent: "reviewer",
		status: "finished",
		task: "inspect " + taskId,
		startedAt: 1_700_000_000_000,
		finishedAt: 1_700_000_002_000,
		errorText: "",
		reason: "",
		children: [],
		childCount: 0,
	};
}

/**
 * boot 到 #/t/task-a 的转录页，/api/session 注入一条 bash toolResult
 * （与 src/web/server.ts 透传的 JSONL 转录行同形；content/isError 由调用方
 * 指定，覆盖字符串、数组两种协议形态与错误分支）。
 */
async function bootWithToolResult(content: unknown, isError: boolean, entryId: string): Promise<PageDomHarness> {
	const harness = createPageDomHarness({ hash: "#/t/task-a" });
	harness.setApi("/api/session", {
		status: 200,
		body: {
			apiVersion: API_V,
			taskId: "task-a",
			offset: 0,
			nextOffset: 128,
			size: 128,
			mtime: 0,
			links: [],
			entries: [
				{
					type: "message",
					id: entryId,
					parentId: null,
					timestamp: "2024-01-01T00:00:00.000Z",
					message: {
						role: "toolResult",
						toolCallId: "call-bash-1",
						toolName: "bash",
						content,
						isError,
				},
			},
			],
			malformed: 0,
			truncatedBefore: false,
			hasMore: false,
			entriesStartOffset: 0,
		},
	});
	await harness.boot({ apiVersion: API_V, nodes: [finishedNode("task-a")], truncated: { dropped: 0 } });
	return harness;
}

/** 取 #transcript 里唯一的 .entry.tool-result；缺失/多个都作为前置失败报出。 */
function toolResultEntry(harness: PageDomHarness): DomEl {
	const transcript = harness.byId("transcript");
	expect(transcript, "前置：#transcript 应存在").not.toBeNull();
	const entries = (transcript as DomEl).querySelectorAll(".entry.tool-result");
	expect(entries.length, "前置：转录区应恰有一条 .entry.tool-result").toBe(1);
	return entries[0] as DomEl;
}

describe("toolResult 渲染（bash 输出不得被 markdown 重解释，真 DOM 执行）", () => {
	it("should render bash tool output through the plain-text block: .text without .markdown, verbatim newlines/~/$, and no <del> in the subtree", async () => {
		// Arrange：深链 #/t/task-a，/api/session 注入含两个 ~ 的 bash 输出（字符串形态）
		const harness = await bootWithToolResult(BASH_OUTPUT, false, "msg-bash-1");

		// Act：route() → pollOnce() → renderEntry() → renderMessage() 渲染进
		// #transcript（harness 恒等 marked 桩不影响结构断言）
		const entry = toolResultEntry(harness);

		// Assert（a，修复前此处红）：内容容器是 .text 而非 .text.markdown ——
		// toolResult 走纯文本 textBlock() 路径，不得带 markdown 类
		// （marked v18 GFM 删除线单个 ~ 即定界，提示符里的 ~ 会被包成 <del>）
		const textEl = entry.querySelector(".text");
		expect(textEl, ".entry.tool-result 内应有 .text 内容容器").not.toBeNull();
		expect((textEl as DomEl).classList.contains("text"), "内容容器必须带 .text 类").toBe(true);
		expect(
			(textEl as DomEl).classList.contains("markdown"),
			"toolResult 内容容器不得带 .markdown 类（修复方案 A'：改走纯文本 textBlock 路径，不走 renderMarkdown）",
		).toBe(false);

		// Assert（b）：textContent 逐字节原样 —— 换行不折叠、~ 与提示符 $ 保留
		expect((textEl as DomEl).textContent, "bash 输出必须逐字节原样（换行不折叠）").toBe(BASH_OUTPUT);
		expect((textEl as DomEl).textContent, "换行必须保留").toContain("\n");
		expect((textEl as DomEl).textContent, "~ 必须原样保留（GFM 删除线定界符）").toContain("~");
		expect(
			((textEl as DomEl).textContent.match(/\$/g) ?? []).length,
			"两个提示符 $ 都必须原样保留",
		).toBe(2);

		// Assert（c）：子树内不得出现 <del> 元素（结构兜底 —— 无论 marked
		// 版本如何，纯文本路径不可能产出 <del>）
		expect(
			entry.querySelectorAll("del").length,
			"工具结果容器子树内不得存在 <del> 元素（bash 输出不得被删除线划掉）",
		).toBe(0);
	});

	it("should render array-shaped text content through the plain-text block: .text without .markdown and byte-for-byte textContent", async () => {
		// Arrange：content 为 agent 协议标准数组形态 —— server.ts 把 JSONL 解析后的
		// message.content 原样透传（stripImages 仅替换 image part，text part 不变），
		// 客户端 details() 对数组走 renderContent → textBlock 纯文本路径
		const arrayContent = [{ type: "text", text: BASH_OUTPUT }];
		const harness = await bootWithToolResult(arrayContent, false, "msg-bash-array");

		// Act：同主用例渲染链路
		const entry = toolResultEntry(harness);

		// Assert：数组形态的内容容器同样是 .text 而非 .text.markdown ——
		// renderContent 的 text part 分支不得因 markdown 开关缺席而退化
		const textEl = entry.querySelector(".text");
		expect(textEl, ".entry.tool-result 内应有 .text 内容容器（数组形态 content）").not.toBeNull();
		expect((textEl as DomEl).classList.contains("text"), "内容容器必须带 .text 类").toBe(true);
		expect(
			(textEl as DomEl).classList.contains("markdown"),
			"数组形态 toolResult 内容容器不得带 .markdown 类（text part 必须走纯文本 textBlock 路径）",
		).toBe(false);

		// Assert：textContent 逐字节等于原串 —— 换行与 ~ 均不得被折叠/重解释
		expect((textEl as DomEl).textContent, "数组 text part 必须逐字节原样渲染").toBe(BASH_OUTPUT);
		expect((textEl as DomEl).textContent, "换行必须保留").toContain("\n");
		expect((textEl as DomEl).textContent, "~ 必须原样保留（GFM 删除线定界符）").toContain("~");
	});

	it("should flag isError tool results with the .error class and an '(error)' summary label", async () => {
		// Arrange：isError:true 的 bash toolResult（content 仍走纯文本路径）
		const harness = await bootWithToolResult("bash: bogus: command not found", true, "msg-bash-err");

		// Act
		const entry = toolResultEntry(harness);

		// Assert（a）：容器 classList 含 error 类
		expect(
			entry.classList.contains("error"),
			"isError:true 的 .entry.tool-result 容器必须带 .error 类",
		).toBe(true);

		// Assert（b）：summary 文案含 "(error)" —— 与 page.ts label 拼接契约一致
		const summary = entry.querySelector("summary");
		expect(summary, ".entry.tool-result 内应有 <summary> 元素").not.toBeNull();
		expect(
			(summary as DomEl).textContent,
			"summary 文案必须含 '(error)' 错误标记",
		).toContain("(error)");
	});
});
