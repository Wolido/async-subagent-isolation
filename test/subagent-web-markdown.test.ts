/**
 * 红阶段测试：`src/web/markdown.ts`（用户定稿之三、之四的页面渲染契约）+
 * `assets/vendor/` vendor 资产。模块/资产尚不存在，相关用例整体红属预期。
 *
 * 被测接口（固定签名，实现者照此实现）：
 *   export function escapeRawHtml(text: string): string
 *     —— 把文本里每个 `<` 替换为 `&lt;`（`>` 不动，保证 markdown 引用块 `>` 不被
 *        破坏）；非字符串输入（含 null / undefined）返回 ""。目的：markdown 里的
 *        原始 HTML 标签失效、按文本显示。
 *   export function isSafeHref(href: string): boolean
 *     —— trim 后匹配 /^(https?:|#)/i 时 true；其余（""、javascript:、data:、
 *        mailto:、//evil、相对路径）false；非字符串 false。
 *   export function isAllowedImageSrc(src: string): boolean
 *     —— 第 7 轮新增（markdown 远程图片不自动加载）：src trim 后以 "data:"
 *        （大小写不敏感）或恰好 "/api/image" / "/api/image?" 开头时 true
 *        （第 11 个字符只能是串尾或 `?` —— /api/imageX、/api/image.evil、
 *        /api/image%2f.. 等前缀混淆一律 false）；http:/https:/协议相对
 *        //host/相对路径/空串/javascript:/非字符串 false。page.ts 用
 *        .toString() 内联进 renderMarkdown，对 img[src] 逐个过滤，不通过的
 *        替换为 .remote-image 占位（页面侧用例见 test/subagent-web-page.test.ts
 *        的 F 组与契约 1 组）。
 *
 * 两个函数必须纯、自包含（无 import、无 this、无模块级引用）—— page.ts 会用
 * `.toString()` 把完整源码内联进单文件页面，故断言用「完整源码文本」锁同源内联。
 *
 * vendor 契约（之三：内联 marked + highlight.js，不发外部请求、不加 npm 依赖）：
 *   - assets/vendor/marked.min.js、assets/vendor/highlight.min.js、
 *     assets/vendor/NOTICE 存在；
 *   - 两份 vendor 保留各自许可证头；NOTICE 记录许可证与来源
 *     （pi-coding-agent export-html vendor 路径）；
 *   - PAGE_HTML 内联两份 vendor 全文（版本标记可见）、0 外部资源引用，
 *     且 vendor 内联不得用 `</script>` 破坏页面（<script> 与 </script> 标签
 *     计数相等；开标签按 /<script[\s>]/ 计 —— vendor 代码里的 `<script(` 正则
 *     字面量不是标签，不计入）。
 *
 * 之四：mermaid 不做渲染 —— PAGE_HTML 全字面 0 命中 "mermaid"（连注释也不得有）。
 *
 * 复审回归（reviewer 复审出的两处缺陷，修复前保持红）：
 *   R1（Critical）：页面不得在 hljs.highlightElement 之前 setAttribute
 *       ("data-highlighted", ...) —— highlight.js 用该属性做幂等标记（已标记
 *       直接 return），页面预置会让每次高亮都变成 no-op、代码块永不着色；
 *       该标记必须由 hljs 自己写入。与既有 hljs.highlightElement( 调用点用例
 *       同组相邻放置。
 *   R2（Important）：escapeRawHtml 必须 code-aware —— 围栏代码块（```/~~~）与
 *       行内 code span 内不转义，其余文本仍 `<`→`&lt;`；否则 marked 会在
 *       <code> 内把 & 再转一次造成双重转义（Array&lt;T&gt; → Array&amp;lt;T&gt;）。
 *       用 node:vm 沙箱加载 vendor marked.min.js（UMD）跑真实管线
 *       marked.parse(escapeRawHtml(input)) 锁定四类输入的渲染结果。
 *
 * 红阶段预期失败：首版红阶段（模块/资产/接线缺失）已随实现转绿；本轮新增
 * 复审回归 R1/R2 在缺陷修复前红，修复后转绿。
 *
 * 本轮（外链图片零请求修复 A）红阶段契约：markdown.ts 新增纯导出
 *   export function neutralizeRemoteMarkup(html: string): string
 *   —— 在 HTML 字符串层面（进入 innerHTML 之前）中和远程标记：<img> 中非白名单
 *   （isAllowedImageSrc 为 false）的 src 改写为 data-remote-src；删除
 *   srcset/imagesrcset/poster/style/background 属性；剔除
 *   <iframe>/<object>/<embed>/<video>/<audio>/<source>/<link>/<style> 元素；
 *   data: 与 /api/image 的 src 原样保留。函数自包含（只调用 isAllowedImageSrc），
 *   page.ts 以 .toString() 内联并在 wrap.innerHTML 赋值前包裹 marked.parse 产物
 *   （页面侧断言见 test/subagent-web-page.test.ts 文末 A 组）。
 * 对应用例见「neutralizeRemoteMarkup」describe（修复前整体红）。
 *
 * 本轮（Markdown 消毒加固，B）红阶段契约：neutralizeRemoteMarkup 两处加固：
 *   1. 未闭合标签 fail-open → fail-closed：旧实现 `if (tagEnd === -1) {
 *      out += source.slice(start); break; }` 会把未闭合标签的剩余原文（可能
 *      含 `<img src=http://…`，innerHTML 重解析即活标签）原样输出；改为把
 *      该 `<` 转义为 `&lt;` 并继续扫描（不放弃后续文本），确保不产生任何
 *      远端引用；
 *   2. 旁路封堵：blocked 列表增补 script / track / image；src 属性白名单校验
 *      从「仅 img」推广到所有标签（非 isAllowedImageSrc 的 src 一律改名为
 *      data-remote-src）；srcset/imagesrcset/poster/style/background 的删除
 *      保留（style 删除即封堵 CSS url()）。
 * 自包含契约不变（只引用 isAllowedImageSrc，被 .toString() 内联）；非字符串
 * / 无 `<` 原样返回、不抛。恶意输入集 + 断言辅助 assertNoRemoteRefs 见
 * 「neutralizeRemoteMarkup 消毒加固（本轮 B）」describe（修复前整体红）。
 *
 * 约定（沿仓库惯例，同 test/subagent-web-tail.test.ts）：globals:false 显式
 * import from "vitest"；纯函数/字符串级断言 + node:fs 读本地资产 + node:vm
 * 沙箱加载 vendor UMD，无 fixture、无网络、不引入新依赖。
 */

import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import * as vm from "node:vm";
import { fileURLToPath } from "node:url";
import { PAGE_HTML } from "../src/web/page.ts";

const MARKED_VENDOR = fileURLToPath(new URL("../assets/vendor/marked.min.js", import.meta.url));
const HIGHLIGHT_VENDOR = fileURLToPath(new URL("../assets/vendor/highlight.min.js", import.meta.url));
const NOTICE_FILE = fileURLToPath(new URL("../assets/vendor/NOTICE", import.meta.url));

/** 动态加载被测模块：红阶段 src/web/markdown.ts 尚不存在，避免顶层 import 让本文件无法收集。 */
async function loadMarkdown() {
	return await import("../src/web/markdown.ts");
}

// ---------------------------------------------------------------------------
// escapeRawHtml（纯函数：markdown 中的原始 HTML 标签失效）
// ---------------------------------------------------------------------------

describe("escapeRawHtml（纯函数：原始 HTML 标签按文本显示）", () => {
	it("should replace every `<` with `&lt;` so a raw <script> tag renders as inert text", async () => {
		// Arrange
		const { escapeRawHtml } = await loadMarkdown();

		// Act
		const escaped = escapeRawHtml("<script>alert(1)</script>");

		// Assert: 结果里一个裸 `<` 都不剩（标签结构失效），且前缀为 &lt;script
		expect(escaped).not.toContain("<");
		expect(escaped).toContain("&lt;script");
		// 精确输出（按规范：只转 `<`，`>` 原样保留）
		expect(escaped).toBe("&lt;script>alert(1)&lt;/script>");
	});

	it("should keep `>` intact so markdown blockquote markers survive escaping", async () => {
		// Arrange
		const { escapeRawHtml } = await loadMarkdown();

		// Act
		const escaped = escapeRawHtml("> quoted line");

		// Assert: 引用块前导 `>` 不被转义，markdown 结构不被破坏
		expect(escaped).toBe("> quoted line");
	});

	it("should return an empty string for non-string input including null and undefined", async () => {
		// Arrange
		const { escapeRawHtml } = await loadMarkdown();

		// Act / Assert: 坏输入不抛错，一律回落空串
		expect(escapeRawHtml(null)).toBe("");
		expect(escapeRawHtml(undefined)).toBe("");
		expect(escapeRawHtml(42)).toBe("");
		expect(escapeRawHtml({ tag: "<b>" })).toBe("");
	});
});

// ---------------------------------------------------------------------------
// isSafeHref（纯函数：链接协议白名单）
// ---------------------------------------------------------------------------

describe("isSafeHref（纯函数：仅放行 http(s) 与页内锚点）", () => {
	it("should accept http, https and in-page # anchors after trimming when given a string", async () => {
		// Arrange
		const { isSafeHref } = await loadMarkdown();

		// Act / Assert: 白名单三类为 true，大小写不敏感，首尾空白先 trim
		expect(isSafeHref("https://example.com/path")).toBe(true);
		expect(isSafeHref("http://example.com")).toBe(true);
		expect(isSafeHref("HTTPS://EXAMPLE.COM")).toBe(true);
		expect(isSafeHref("#section-2")).toBe(true);
		expect(isSafeHref("  https://trimmed.example  ")).toBe(true);
	});

	it("should reject javascript:, data:, mailto:, protocol-relative and relative hrefs", async () => {
		// Arrange
		const { isSafeHref } = await loadMarkdown();

		// Act / Assert: 白名单之外一律 false
		expect(isSafeHref("")).toBe(false);
		expect(isSafeHref("javascript:alert(1)")).toBe(false);
		expect(isSafeHref("data:text/html;base64,PHNjcmlwdD4=")).toBe(false);
		expect(isSafeHref("mailto:a@b")).toBe(false);
		expect(isSafeHref("//evil.com")).toBe(false);
		expect(isSafeHref("/relative/path")).toBe(false);
	});

	it("should return false for non-string input", async () => {
		// Arrange
		const { isSafeHref } = await loadMarkdown();

		// Act / Assert: 非字符串不抛错，一律 false
		expect(isSafeHref(null)).toBe(false);
		expect(isSafeHref(undefined)).toBe(false);
		expect(isSafeHref(42)).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// isAllowedImageSrc（纯函数：markdown 图片图源白名单，第 7 轮新增——外部图片
// 不自动加载）。page.ts 以 .toString() 内联该函数并逐个过滤 img[src]，故同样
// 必须纯、自包含。
// ---------------------------------------------------------------------------

/** 取出被测函数；红阶段缺失时先给出明确的失败信息再抛 TypeError。 */
async function loadImageSrc(): Promise<(src: unknown) => boolean> {
	const mod = (await loadMarkdown()) as unknown as Record<string, unknown>;
	expect(typeof mod.isAllowedImageSrc, "markdown.ts must export isAllowedImageSrc(src: string): boolean").toBe("function");
	return mod.isAllowedImageSrc as (src: unknown) => boolean;
}

describe("isAllowedImageSrc（纯函数：仅放行 data: 与内部 /api/image）", () => {
	it("should accept data: URLs case-insensitively and /api/image paths including query strings after trimming", async () => {
		// Arrange
		const isAllowedImageSrc = await loadImageSrc();

		// Act / Assert: 两类白名单图源为 true —— data: 大小写不敏感，
		// /api/image 前缀含查询串，首尾空白先 trim
		expect(isAllowedImageSrc("data:image/png;base64,iVBORw0KGgo=")).toBe(true);
		expect(isAllowedImageSrc("DATA:image/png;base64,iVBORw0KGgo=")).toBe(true);
		expect(isAllowedImageSrc("  Data:image/gif;base64,R0lGOD  ")).toBe(true);
		expect(isAllowedImageSrc("/api/image?taskId=a&entry=0&block=1")).toBe(true);
		expect(isAllowedImageSrc("/api/image?x=1")).toBe(true);
		expect(isAllowedImageSrc("  /api/image  ")).toBe(true);
	});

	it("should reject http:, https:, protocol-relative and relative image sources", async () => {
		// Arrange
		const isAllowedImageSrc = await loadImageSrc();

		// Act / Assert: 一切外部/相对图源为 false（不自动发起请求的前提）
		expect(isAllowedImageSrc("http://evil.example/a.png")).toBe(false);
		expect(isAllowedImageSrc("https://cdn.example/a.png")).toBe(false);
		expect(isAllowedImageSrc("//cdn.example/a.png")).toBe(false);
		expect(isAllowedImageSrc("a.png")).toBe(false);
		expect(isAllowedImageSrc("./a.png")).toBe(false);
		expect(isAllowedImageSrc("/images/a.png")).toBe(false);
	});

	it("should reject empty, whitespace, javascript:, prefix-confusion and non-string sources", async () => {
		// Arrange
		const isAllowedImageSrc = await loadImageSrc();

		// Act / Assert: 空串/纯空白、危险协议、data 前缀混淆、非字符串一律 false
		expect(isAllowedImageSrc("")).toBe(false);
		expect(isAllowedImageSrc("   ")).toBe(false);
		expect(isAllowedImageSrc("javascript:alert(1)")).toBe(false);
		expect(isAllowedImageSrc("datax:image/png;base64,AA")).toBe(false);
		expect(isAllowedImageSrc("api/image?x=1")).toBe(false);
		expect(isAllowedImageSrc(null)).toBe(false);
		expect(isAllowedImageSrc(undefined)).toBe(false);
		expect(isAllowedImageSrc(42)).toBe(false);
	});

	it("should reject /api/image prefix confusion: /api/imageX, /api/image.evil and /api/image%2f.. must not pass", async () => {
		// Arrange
		const isAllowedImageSrc = await loadImageSrc();

		// Act / Assert（契约 2，独立审查缺口）: 内部端点白名单只认恰好
		// "/api/image" 或 "/api/image?" 开头（第 11 个字符为串尾或 `?`）——
		// 旧实现 indexOf("/api/image") === 0 前缀过宽，/api/imageX、
		// /api/image.evil 被误放行，可绕过白名单发起任意路径请求
		expect(isAllowedImageSrc("/api/imageX")).toBe(false);
		expect(isAllowedImageSrc("/api/image.evil")).toBe(false);
		expect(isAllowedImageSrc("/api/image%2f..")).toBe(false);
		expect(isAllowedImageSrc("/api/image/../session")).toBe(false);

		// 边界另一侧：恰好 /api/image 与 /api/image? 开头仍放行
		expect(isAllowedImageSrc("/api/image")).toBe(true);
		expect(isAllowedImageSrc("/api/image?taskId=abc&entry=0&block=1")).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// neutralizeRemoteMarkup（纯函数：字符串层面中和远程标记，外链图片不得发起
// 任何请求）。page.ts 以 .toString() 内联该函数，在 wrap.innerHTML 赋值前对
// marked.parse 产物做整串中和；故同样必须纯、自包含（只调用 isAllowedImageSrc）。
// ---------------------------------------------------------------------------

/** 取出被测函数；缺失时先给出明确的失败信息再报红。 */
async function loadNeutralizeRemoteMarkup(): Promise<(html: unknown) => string> {
	const mod = (await loadMarkdown()) as unknown as Record<string, unknown>;
	expect(typeof mod.neutralizeRemoteMarkup, "markdown.ts must export neutralizeRemoteMarkup(html: string): string").toBe("function");
	return mod.neutralizeRemoteMarkup as (html: unknown) => string;
}

describe("neutralizeRemoteMarkup（纯函数：字符串层面中和远程标记）", () => {
	it("should rewrite a remote img src to data-remote-src so no live http(s) img src survives", async () => {
		// Arrange
		const neutralizeRemoteMarkup = await loadNeutralizeRemoteMarkup();

		// Act
		const result = neutralizeRemoteMarkup('<p><img src="https://example.com/x.png" alt="x"></p>');

		// Assert: 无任何活的 http(s) img src —— 原 URL 被改写为 data-remote-src
		// （\ssrc 只匹配真正的属性起点；\bsrc 会因 `-` 词边界误命中 data-remote-src）
		const liveSrcPattern = /<img[^>]*\ssrc\s*=\s*["']https?:\/\//i;
		expect(result).not.toMatch(liveSrcPattern);
		// 原 URL 完整保留在 data-remote-src 属性上（占位锚点构造时取用）
		expect(result).toContain('data-remote-src="https://example.com/x.png"');
		// 自检：正则未被改废 —— 真正带空白前缀的活 src 仍必须命中
		expect('<img src="https://evil/x.png">').toMatch(liveSrcPattern);
	});

	it("should delete the srcset attribute carrying remote candidate URLs", async () => {
		// Arrange
		const neutralizeRemoteMarkup = await loadNeutralizeRemoteMarkup();

		// Act
		const result = neutralizeRemoteMarkup('<img src="data:image/png;base64,AA" srcset="https://a 1x, https://b 2x">');

		// Assert: srcset 整属性删除（否则 1x/2x 候选仍会发起远程请求）
		expect(result).not.toMatch(/\bsrcset\s*=/i);
	});

	it("should remove an <iframe> element and leave no iframe remnant", async () => {
		// Arrange
		const neutralizeRemoteMarkup = await loadNeutralizeRemoteMarkup();

		// Act
		const result = neutralizeRemoteMarkup('<p>hi</p><iframe src="https://evil.example/frame.html"></iframe>');

		// Assert: 元素整体剔除，不残留 iframe 字面
		expect(result).not.toMatch(/iframe/i);
	});

	it("should remove a <video> element and its poster attribute entirely", async () => {
		// Arrange
		const neutralizeRemoteMarkup = await loadNeutralizeRemoteMarkup();

		// Act
		const result = neutralizeRemoteMarkup('<video poster="https://evil.example/poster.jpg" src="https://evil.example/v.mp4"></video>');

		// Assert: 元素整体剔除，video 与 poster 都不残留
		expect(result).not.toMatch(/video/i);
		expect(result).not.toMatch(/poster/i);
	});

	it("should delete a style attribute that carries a remote background-image url", async () => {
		// Arrange
		const neutralizeRemoteMarkup = await loadNeutralizeRemoteMarkup();

		// Act
		const result = neutralizeRemoteMarkup('<div style="background-image:url(https://evil)">x</div>');

		// Assert: style 属性删除（含 url() 远程背景），evil 不再出现
		expect(result).not.toMatch(/\bstyle\s*=/i);
		expect(result).not.toMatch(/evil/);
	});

	it("should keep whitelisted data: and /api/image src attributes unchanged", async () => {
		// Arrange
		const neutralizeRemoteMarkup = await loadNeutralizeRemoteMarkup();

		// Act
		const result = neutralizeRemoteMarkup(
			'<img src="data:image/png;base64,AA"><img src="/api/image?taskId=x">'
		);

		// Assert: 白名单 src 原样保留，不被改写为 data-remote-src
		expect(result).toContain('src="data:image/png;base64,AA"');
		expect(result).toContain('src="/api/image?taskId=x"');
		expect(result).not.toMatch(/data-remote-src/);
	});

	it("should return a string and not throw for non-string or tag-free input", async () => {
		// Arrange
		const neutralizeRemoteMarkup = await loadNeutralizeRemoteMarkup();

		// Act / Assert: 坏输入不抛错、返回字符串；无标签纯文本原样返回
		expect(() => neutralizeRemoteMarkup(null)).not.toThrow();
		expect(typeof neutralizeRemoteMarkup(null)).toBe("string");
		expect(() => neutralizeRemoteMarkup(undefined)).not.toThrow();
		expect(typeof neutralizeRemoteMarkup(undefined)).toBe("string");
		expect(() => neutralizeRemoteMarkup(42)).not.toThrow();
		expect(typeof neutralizeRemoteMarkup(42)).toBe("string");
		expect(neutralizeRemoteMarkup("plain text with no tags")).toBe("plain text with no tags");
	});
});

// ---------------------------------------------------------------------------
// neutralizeRemoteMarkup 消毒加固（本轮 B，红阶段）：未闭合标签 fail-closed、
// blocked 增补（script/track/image）、src 白名单推广到所有标签。
// ---------------------------------------------------------------------------

/** blocked 元素名单（与冻结契约一致：整元素不得存活）。 */
const BLOCKED_TAGS = [
	"iframe", "object", "embed", "video", "audio", "source", "link",
	"style", "base", "meta", "form", "script", "track", "image",
];

/** 会发起请求/执行的属性名单：一律删除，不得以任何形式存活（大小写不敏感）。 */
const LIVE_ATTRS = ["srcset", "imagesrcset", "poster", "style", "background"];

/**
 * 断言 neutralizeRemoteMarkup 的输出里不存在任何「活的远端引用」。断言原文：
 *   1. 每个 `<` 都必须是一个完整 `<tag …>` / `</tag>` 的起点 —— 把带引号的
 *      完整标签全部剥掉后，剩余文本不得再含任何 `<`：未闭合标签必须被
 *      fail-closed 转义为 &lt;（否则残留的裸 `<img src=http://…` 进入
 *      innerHTML 会被重解析成活标签，重新发起远端请求）；
 *   2. 无 blocked 元素存活（iframe/object/embed/video/audio/source/link/
 *      style/base/meta/form/script/track/image）；
 *   3. 无 srcset / imagesrcset / poster / style / background 属性
 *      （属性名大小写不敏感；`(?:^|\s)` 保证不被 data-remote-src 的
 *      `-src` 子串误伤，也不误伤其它含 srcset 子串的属性名）；
 *   4. 每个存活的 src 属性值必须通过 isAllowedImageSrc 白名单（data: 与
 *      内部 /api/image）—— 其余远端 src 一律已被改名为 data-remote-src；
 *   5. 标签（属性上下文）内不得出现 url( 活引用 —— style 属性删除即封堵
 *      CSS url()；纯文本节点里的 url( 字符串不会发起请求（且 <style> 元素
 *      本身由第 2 条兜住），不在判据内；
 *   6. 标签内出现的 http(s) URL 只能挂在 data-remote-src 上（占位原值，
 *      不发起请求）。
 */
async function assertNoRemoteRefs(html: string): Promise<void> {
	// 白名单判据（4）调用被测模块的 isAllowedImageSrc（页面同源内联的同一函数）
	const isAllowedImageSrc = await loadImageSrc();
	// 带引号的标签解析：属性值里的 `>`（如 srcset="a > b"）不得截断标签；
	// 开标签与闭标签（`</tag>`）一并计入。
	const tagRe = /<(\/?)([A-Za-z][A-Za-z0-9]*)((?:"[^"]*"|'[^']*'|[^<>"'])*)>/g;
	const tags = [...html.matchAll(tagRe)];

	// 断言 1：完整标签剥掉后不得再有裸 `<`（未闭合标签必须已被转义）
	const stripped = html.replace(tagRe, "");
	expect(stripped, "a stray '<' survived: an unclosed tag must be escaped to &lt;").not.toMatch(/</);

	for (const tag of tags) {
		const name = tag[2].toLowerCase();

		// 断言 2：blocked 元素整体剔除
		expect(BLOCKED_TAGS, `blocked element <${name}> must be removed entirely`).not.toContain(name);

		const attrs = tag[3];

		// 断言 3：请求/执行型属性一律删除（大小写不敏感）
		for (const live of LIVE_ATTRS) {
			expect(attrs, `the ${live} attribute must be deleted (case-insensitive)`).not.toMatch(
				new RegExp(`(?:^|\\s)${live}\\s*=`, "i")
			);
		}

		// 断言 4：存活的 src 必须在白名单内（含大小写变体 SRC=）
		const src = /(?:^|\s)src\s*=\s*("[^"]*"|'[^']*'|[^\s"'=<>`]+)/i.exec(attrs);
		if (src !== null) {
			const value = src[1].replace(/^["']|["']$/g, "");
			expect(
				isAllowedImageSrc(value),
				`live src="${value}" must pass the isAllowedImageSrc whitelist (data: or /api/image)`
			).toBe(true);
		}

		// 断言 5：标签内不得有 url( 活引用（CSS background 等）
		expect(attrs, "no url(...) may survive inside a tag (CSS background etc.)").not.toMatch(/url\s*\(/i);

		// 断言 6：标签内的远端 URL 只能挂在 data-remote-src 上（占位原值）
		for (const [, attrName, value] of attrs.matchAll(
			/([A-Za-z_:][-A-Za-z0-9_:.]*)\s*=\s*("[^"]*"|'[^']*')/g
		)) {
			if (/https?:\/\//i.test(value)) {
				expect(
					attrName.toLowerCase(),
					`a remote URL may only survive under data-remote-src, found on ${attrName}=${value}`
				).toBe("data-remote-src");
			}
		}
	}
}

describe("neutralizeRemoteMarkup 消毒加固（本轮 B，红阶段）", () => {
	it("should fail closed on an unclosed <img src=\"http://…\"> tag and keep scanning the remaining markup", async () => {
		// Arrange
		const neutralizeRemoteMarkup = await loadNeutralizeRemoteMarkup();

		// Act: 未闭合标签（无 `>`）且 alt 引号未闭 —— 旧实现把剩余原文原样输出
		//（fail-open），裸 `<img src="http://evil/x.png"` 进入 innerHTML 即活标签；
		// 后续的 <b> 标签必须仍被处理（继续扫描，不放弃后续文本）
		const result = neutralizeRemoteMarkup(
			'<p>ok</p><img src="http://evil/x.png" alt=\'unterminated <b>text</b>'
		);

		// Assert: 无任何活的远端引用（fail-closed：`<` 转义为 &lt;）
		await assertNoRemoteRefs(result);
		expect(result, "the unclosed tag's '<' must be escaped to &lt;").toContain("&lt;img");
		expect(result, "no live <img may survive an unclosed tag").not.toMatch(/<img/i);
		// Assert: 转义未放弃后续扫描 —— 后面的 <b> 标签仍被当作标签处理
		expect(result, "scanning must continue past the escaped '<'").toContain("<b>text</b>");
		expect(result, "the text before the unclosed tag is preserved").toContain("<p>ok</p>");
	});

	it("should handle uppercase SRCSET, POSTER and STYLE variants on allowed elements", async () => {
		// Arrange
		const neutralizeRemoteMarkup = await loadNeutralizeRemoteMarkup();

		// Act: 属性名大小写变体（SRCSET/POSTER/STYLE）+ 大写 <STYLE> 元素
		const result = neutralizeRemoteMarkup(
			'<IMG SRCSET="http://evil/a.png 1x, http://evil/b.png 2x" SRC="/api/image?x=1" POSTER="http://evil/p.jpg">' +
			'<div STYLE="background:url(http://evil/bg.png)">x</div>' +
			'<STYLE>@import url(http://evil/x.css);</STYLE>'
		);

		// Assert: 变体不得成为旁路（断言辅助对属性名大小写不敏感）
		await assertNoRemoteRefs(result);
		expect(result, "an uppercase <STYLE> element must be removed").not.toMatch(/<style/i);
		expect(result, "the whitelisted /api/image src survives untouched (case-insensitive attr name)").toMatch(
			/src\s*=\s*"\/api\/image\?x=1"/i
		);
	});

	it("should neutralize <INPUT TYPE=\"IMAGE\" SRC=\"http://…\"> by renaming the non-whitelisted src on any tag, not just img", async () => {
		// Arrange
		const neutralizeRemoteMarkup = await loadNeutralizeRemoteMarkup();

		// Act: src 白名单必须推广到所有标签（input[type=image] 也带远端 src）
		const result = neutralizeRemoteMarkup('<INPUT TYPE="IMAGE" SRC="http://evil/x.png">');

		// Assert: 无活远端 src；原 URL 只能以 data-remote-src 占位存活
		await assertNoRemoteRefs(result);
		expect(result, "the remote src must be renamed to data-remote-src on every tag").toContain(
			'data-remote-src="http://evil/x.png"'
		);
	});

	it("should remove a <image> element entirely instead of treating it as an inert alias of <img>", async () => {
		// Arrange
		const neutralizeRemoteMarkup = await loadNeutralizeRemoteMarkup();

		// Act
		const result = neutralizeRemoteMarkup('<image src="http://evil/x.png">');

		// Assert
		await assertNoRemoteRefs(result);
		expect(result, "the image element must be removed, not kept with a renamed src").not.toMatch(/image/i);
	});

	it("should remove a <track> element entirely so its remote src never loads", async () => {
		// Arrange
		const neutralizeRemoteMarkup = await loadNeutralizeRemoteMarkup();

		// Act
		const result = neutralizeRemoteMarkup('<track src="http://evil/x.vtt" kind="captions">');

		// Assert
		await assertNoRemoteRefs(result);
		expect(result, "the track element must be removed entirely").not.toMatch(/track/i);
	});

	it("should remove a <script src=\"http://…\"> element entirely", async () => {
		// Arrange
		const neutralizeRemoteMarkup = await loadNeutralizeRemoteMarkup();

		// Act
		const result = neutralizeRemoteMarkup('<p>hi</p><script src="http://evil/x.js"></script>');

		// Assert
		await assertNoRemoteRefs(result);
		expect(result, "the script element must be removed entirely").not.toMatch(/script/i);
	});

	it("should remove a <style> element carrying an @import url( remote stylesheet", async () => {
		// Arrange
		const neutralizeRemoteMarkup = await loadNeutralizeRemoteMarkup();

		// Act
		const result = neutralizeRemoteMarkup('<p>hi</p><style>body{background:url(http://evil/x.png)} @import url(http://evil/x.css);</style>');

		// Assert: <style> 元素（含 @import 与 url() 的 CSS 上下文）整体不得存活；
		// 残留的纯文本无 CSS 上下文即惰性（断言辅助的 url( 判据限定在标签内）
		await assertNoRemoteRefs(result);
		expect(result, "the <style> element must be removed entirely").not.toMatch(/<style/i);
	});

	it("should delete a style attribute carrying background:url( on any element", async () => {
		// Arrange
		const neutralizeRemoteMarkup = await loadNeutralizeRemoteMarkup();

		// Act
		const result = neutralizeRemoteMarkup('<span style="background:url(http://evil/x.png) no-repeat">x</span>');

		// Assert: style 属性删除即封堵 CSS url() —— evil 不再出现
		await assertNoRemoteRefs(result);
		expect(result, "the style attribute must be deleted").not.toMatch(/\bstyle\s*=/i);
		expect(result, "the remote url must not survive anywhere").not.toMatch(/evil/);
	});

	it("should not let a `>` inside a quoted srcset attribute truncate the tag", async () => {
		// Arrange
		const neutralizeRemoteMarkup = await loadNeutralizeRemoteMarkup();

		// Act: 属性值内含 `>` —— 引号感知的标签扫描不得在此截断（否则
		// `b" …` 之后的原文被当作标签外文本处理，属性删除全部失效）
		const result = neutralizeRemoteMarkup('<img src="data:image/png;base64,AA" srcset="a > b">');

		// Assert
		await assertNoRemoteRefs(result);
		expect(result, "the whitelisted data: src survives").toContain('src="data:image/png;base64,AA"');
		expect(result, "the srcset attribute is deleted despite the '>' in its value").not.toMatch(/\bsrcset\s*=/i);
	});

	it("should neutralize nested and malformed quoting without letting any remote reference live", async () => {
		// Arrange
		const neutralizeRemoteMarkup = await loadNeutralizeRemoteMarkup();

		// Act: 对立引号嵌套 + 单引号 src + 未闭合引号 + 无 `>` 的尾部残片
		const result = neutralizeRemoteMarkup(
			"<div title='a \"b\" c'><img src='https://evil/z.png' alt=\"it's fine\"></div>" +
			'<img src="http://evil/y.png" alt="oops'
		);

		// Assert: 完整标签（z.png）按既有绿契约存活为 <img data-remote-src=…>，
		// 本处只锁尾部未闭合片段被转义、不得成为活标签
		await assertNoRemoteRefs(result);
		expect(result, "the single-quoted remote src is renamed").toContain('data-remote-src="https://evil/z.png"');
		expect(result, "the trailing unclosed fragment must be escaped to &lt;img").toContain('&lt;img src="http://evil/y.png" alt="oops');
		expect(result, "no LIVE <img src=\"http://evil/y.png\"> may survive the unclosed fragment").not.toMatch(/<img src="http:\/\/evil\/y\.png"/i);
	});

	it("should keep neutralizeRemoteMarkup self-contained: only isAllowedImageSrc referenced, never an import", async () => {
		// Arrange
		const neutralizeRemoteMarkup = await loadNeutralizeRemoteMarkup();

		// Act: 被 .toString() 内联进单文件页面 —— 源码内不得出现模块级引用
		const source = neutralizeRemoteMarkup.toString();

		// Assert: 自包含（只引用 isAllowedImageSrc），无 import/require/模块路径
		expect(source).toContain("isAllowedImageSrc(");
		expect(source, "the inlined function must stay module-free").not.toMatch(/\bimport\b|require\(/);
	});
});

// ---------------------------------------------------------------------------
// PAGE_HTML 内联渲染管线：escapeRawHtml / isSafeHref 同源内联 + marked + hljs
// ---------------------------------------------------------------------------

describe("PAGE_HTML 内联 markdown 渲染管线（字符串级契约）", () => {
	it("should inline the complete escapeRawHtml function source so page and module stay in sync", async () => {
		// 理由：PAGE_HTML 由 escapeRawHtml.toString() 内联生成，断言完整源码文本
		// 锁定「同源内联」，区分实现与手抄一份函数体的漂移退化。
		// 动态 import：红阶段 markdown.ts 尚不存在，避免拖垮本文件其它用例。
		const { escapeRawHtml } = await loadMarkdown();

		expect(PAGE_HTML).toContain(escapeRawHtml.toString());
	});

	it("should inline the complete isSafeHref function source so page and module stay in sync", async () => {
		const { isSafeHref } = await loadMarkdown();

		expect(PAGE_HTML).toContain(isSafeHref.toString());
	});

	it("should inline the complete isAllowedImageSrc function source so page and module stay in sync", async () => {
		// 第 7 轮 F：与 escapeRawHtml/isSafeHref 同模式，page.ts 以
		// isAllowedImageSrc.toString() 内联 —— 完整源码文本锁定同源内联
		const isAllowedImageSrc = await loadImageSrc();

		expect(PAGE_HTML).toContain(isAllowedImageSrc.toString());
	});

	it("should call isAllowedImageSrc( at a rendering call site outside the inlined definition", () => {
		// Arrange / Act: PAGE_HTML 为固定导出常量

		// Assert: 内联定义本身是 `function isAllowedImageSrc(`，负向后视排除，
		// 只认真正的调用点（renderMarkdown 里对 img[src] 的白名单过滤）
		expect(PAGE_HTML).toMatch(/(?<!function )isAllowedImageSrc\(/);
	});

	it("should parse markdown through marked.parse(escapeRawHtml( so raw HTML is escaped before rendering", () => {
		// Arrange / Act: PAGE_HTML 为固定导出常量

		// Assert: 渲染入口逐字 —— 先 escapeRawHtml 再 marked.parse
		expect(PAGE_HTML).toMatch(/marked\.parse\(escapeRawHtml\(/);
	});

	it("should call isSafeHref( at a rendering call site outside the inlined definition", () => {
		// Arrange / Act: PAGE_HTML 为固定导出常量

		// Assert: 内联的定义本身是 `function isSafeHref(`，负向后视把它排除，
		// 只认真正的调用点（链接渲染时的协议白名单校验）
		expect(PAGE_HTML).toMatch(/(?<!function )isSafeHref\(/);
	});

	it("should run code blocks through hljs.highlightElement( for syntax highlighting", () => {
		// Arrange / Act: PAGE_HTML 为固定导出常量

		// Assert: 代码块高亮调用点逐字（无语言时由 highlightElement 自动检测退化）
		expect(PAGE_HTML).toContain("hljs.highlightElement(");
	});

	it("should let highlight.js own the data-highlighted marker instead of pre-stamping it before the call", () => {
		// 回归 R1（reviewer 复审，Critical）：highlight.js 的 highlightElement
		// 首行即检查 data-highlighted 幂等标记、已标记直接 return；页面若在调用
		// 前自行 setAttribute("data-highlighted", "1")，每次高亮都变成 no-op、
		// 代码块永不着色。该标记只能由 hljs 在高亮完成时写入，页面禁止预置。
		// （调用点存在性由上一条用例锁定，此处成对放置便于定位。）
		expect(PAGE_HTML).toContain("hljs.highlightElement(");
		expect(PAGE_HTML).not.toMatch(/setAttribute\(\s*["']data-highlighted["']/);
	});

	it("should not mention mermaid anywhere in the page (no special diagram rendering)", () => {
		// Arrange / Act: PAGE_HTML 为固定导出常量

		// Assert: mermaid 不做渲染 —— 全字面 0 命中（含注释）
		expect(PAGE_HTML).not.toContain("mermaid");
	});
});

// ---------------------------------------------------------------------------
// 复审回归 R2：渲染管线真实执行 —— node:vm 沙箱加载 vendor marked（UMD），
// 按页面入口同序跑 marked.parse(escapeRawHtml(input))，锁定四类输入的输出
// ---------------------------------------------------------------------------

/**
 * 用 node:vm 沙箱加载 assets/vendor/marked.min.js（UMD 包），取出 marked.parse。
 * UMD 探测顺序 module/exports → define → globalThis/self；沙箱内补齐 self/
 * window 指向沙箱全局，使其落到 g["marked"] 分支、挂在沙箱全局上。
 */
function loadMarkedParse(): (source: string) => string {
	const code = readFileSync(MARKED_VENDOR, "utf-8");
	const sandbox = vm.createContext({}) as Record<string, unknown>;
	vm.runInContext("var self = globalThis; var window = globalThis;", sandbox);
	vm.runInContext(code, sandbox, { filename: "marked.min.js" });

	const marked = sandbox.marked as { parse?: unknown } | undefined;
	if (!marked || typeof marked.parse !== "function") {
		throw new Error("vendor marked.min.js did not expose marked.parse in the vm sandbox");
	}
	return marked.parse.bind(marked) as (source: string) => string;
}

/** 与页面渲染入口同序执行：marked.parse(escapeRawHtml(input))。 */
async function renderThroughPipeline(input: string): Promise<string> {
	const { escapeRawHtml } = await loadMarkdown();

	return loadMarkedParse()(escapeRawHtml(input));
}

describe("渲染管线真实执行（vendor marked + escapeRawHtml，回归缺陷 2）", () => {
	it("should render raw body HTML as inert text so no live tag reaches innerHTML", async () => {
		// Arrange / Act: 正文原始 HTML —— escapeRawHtml 先转 `<`，marked 输出
		const html = await renderThroughPipeline('<div onclick="x()">raw</div>');

		// Assert: 输出里没有活标签 <div（不分大小写），实体 &lt;div 按文本显示
		expect(html).not.toMatch(/<div/i);
		expect(html).toContain("&lt;div");
	});

	it("should render an inline code span single-escaped without double-escaping the angle brackets", async () => {
		// 回归 R2（reviewer 复审，Important）：escapeRawHtml 无条件盲转 `<` 时，
		// marked 会在 <code> 内把 & 再转一次 → 正确的 Array&lt;T&gt; 退化成
		// Array&amp;lt;T&gt;（双重转义）。修复方向：escapeRawHtml 为 code-aware
		// （code span 内不转义，由 marked 统一转义）。
		// 注：marked v18 在代码区会把 `>` 转成 `&gt;`（浏览器渲染文本仍是
		// Array<T>），故精确断言带 &gt; 的单次转义形态。
		const html = await renderThroughPipeline("`Array<T>`");

		expect(html).toContain("<code>Array&lt;T&gt;</code>");
		expect(html).not.toContain("&amp;lt;");
	});

	it("should render a fenced code block with its language class and single-escaped angle brackets", async () => {
		// 同回归 R2 的围栏分支：代码区内 `<` 不得先被 escapeRawHtml 转义，
		// 否则 marked 输出 &amp;lt; 双重转义；语言类名必须保留。
		const html = await renderThroughPipeline("```ts\nlet a: Array<T>; if (a < b) {}\n```");

		expect(html).toContain('<pre><code class="language-ts">');
		expect(html).toContain("Array&lt;T&gt;");
		expect(html).toContain("a &lt; b");
		expect(html).not.toContain("&amp;lt;");
	});

	it("should keep rendering a `>` line as a blockquote (escape must not touch `>`)", async () => {
		// code-aware 改造不得顺手转义 `>`，否则 markdown 引用块前导 `>` 被破坏
		const html = await renderThroughPipeline("> quoted");

		expect(html).toContain("<blockquote>");
	});
});

// ---------------------------------------------------------------------------
// assets/vendor 资产：内联 marked + highlight.js，无外部请求、无 npm 依赖
// ---------------------------------------------------------------------------

describe("assets/vendor 资产（自包含 vendor，无外部请求、无 npm 依赖）", () => {
	it("should ship marked.min.js, highlight.min.js and NOTICE under assets/vendor/", () => {
		// Arrange / Act: 本地资产路径

		// Assert: 三份 vendor 资产存在
		expect(existsSync(MARKED_VENDOR)).toBe(true);
		expect(existsSync(HIGHLIGHT_VENDOR)).toBe(true);
		expect(existsSync(NOTICE_FILE)).toBe(true);
	});

	it("should keep the marked license header with its marked v version string and MIT License", () => {
		// Arrange
		const content = readFileSync(MARKED_VENDOR, "utf-8");

		// Assert: 版本串与许可证头保留
		expect(content).toContain("marked v");
		expect(content).toContain("MIT License");
	});

	it("should keep the highlight.js license header as the exact literal Highlight.js v11.9.0", () => {
		// Arrange
		const content = readFileSync(HIGHLIGHT_VENDOR, "utf-8");

		// Assert: 版本标记逐字
		expect(content).toContain("Highlight.js v11.9.0");
	});

	it("should record both licenses and the pi-coding-agent export-html source path in NOTICE", () => {
		// Arrange
		const content = readFileSync(NOTICE_FILE, "utf-8");

		// Assert: 许可证标识 + 来源说明逐字
		expect(content).toContain("marked");
		expect(content).toContain("MIT");
		expect(content).toContain("highlight.js");
		expect(content).toContain("BSD-3-Clause");
		expect(content).toContain("pi-coding-agent");
		expect(content).toContain("export-html");
	});

	it("should inline both vendor bundles into PAGE_HTML without referencing any external http(s) resource", () => {
		// Arrange / Act: PAGE_HTML 为固定导出常量

		// Assert: 稳定版本标记可见（= vendor 全文被内联）+ 三类外部资源 0 引用
		expect(PAGE_HTML).toContain("marked v18.0.5");
		expect(PAGE_HTML).toContain("Highlight.js v11.9.0");
		expect(PAGE_HTML).not.toMatch(/<script[^>]*\ssrc\s*=\s*["']https?:\/\//i);
		expect(PAGE_HTML).not.toMatch(/<link[^>]*\shref\s*=\s*["']https?:\/\//i);
		expect(PAGE_HTML).not.toMatch(/<img[^>]*\ssrc\s*=\s*["']https?:\/\//i);
	});

	it("should keep the <script> and </script> tag counts equal so inlined vendor cannot break out of the page", () => {
		// Arrange / Act: 按标签形态计数 —— 开标签 /<script[\s>]/（vendor 代码里的
		// `<script(` 正则字面量不是标签，不计入），闭标签 /<\/script>/
		const openTags = (PAGE_HTML.match(/<script[\s>]/g) ?? []).length;
		const closeTags = (PAGE_HTML.match(/<\/script>/g) ?? []).length;

		// Assert: 数量相等 —— 任何跑出的裸 `</script>` 都会让闭标签多一个
		expect(openTags).toBe(closeTags);
	});
});
