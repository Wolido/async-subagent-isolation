/**
 * Self-contained HTML page for the subagent session viewer.
 *
 * The whole UI (styles + behaviour) is inlined: the page must work offline
 * and must be served by the local web server without any external asset.
 * The bearer token is read client-side from `location.search` (`?t=`), and
 * task selection uses the hash routes `#/` and `#/t/<taskId>` so navigation
 * never leaks the token through the Referer header.
 */

import { API_VERSION } from "./api-version.ts";
import { escapeRawHtml, isAllowedImageSrc, isSafeHref, neutralizeRemoteMarkup } from "./markdown.ts";
import { ancestorIds, backTarget, childSummary, crumbLabel, durationMs, lineageLabel, lineageRowId, parseSidebarAnchor, scrollTargetTaskId, serializeSidebarAnchor, sidebarRestoreScrollTop, sidebarScrollAnchor } from "./tree-view.ts";
import { HIGHLIGHT_JS, MARKED_JS } from "./vendor.ts";

export const PAGE_HTML: string = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Subagent sessions</title>
<style>
:root {
	color-scheme: light dark;
	--bg: #f6f7f9;
	--panel: #ffffff;
	--border: #d9dee5;
	--text: #1c2128;
	--muted: #5c6773;
	--accent: #2f6feb;
	--user: #e8f0fe;
	--assistant: #ffffff;
	--thinking: #f3eefc;
	--tool: #f0f2f5;
	--error: #c0392b;
	--link: #0969da;
	--splitter: #d9dee5;
	/* Spacing / font / line-height / radius scale */
	--sp-1: 4px;
	--sp-2: 8px;
	--sp-3: 12px;
	--sp-4: 16px;
	--sp-5: 24px;
	--sp-6: 32px;
	--fs-1: 11px;
	--fs-2: 12px;
	--fs-3: 13px;
	--fs-4: 15px;
	--lh-row: 20px;
	--r-1: 4px;
	--r-2: 6px;
	--r-3: 8px;
	--r-full: 999px;
	/* Interaction states */
	--hover-bg: #eef1f5;
	--selected-bg: #e7eefc;
	--active-bg: #dde8fc;
	--focus-ring: 2px solid var(--accent);
	--disabled-fg: #8b949e;
	--disabled-bg: #eef1f4;
	/* Status colours: fg for text/pills, dot for the tree markers */
	--st-running-fg: #1a7f37;
	--st-running-dot: #2e9e5b;
	--st-recent-fg: #9a6700;
	--st-recent-dot: #b07d0a;
	--st-finished-fg: #656d76;
	--st-finished-dot: #8b949e;
	--st-pending-fg: #6e56cf;
	--st-pending-dot: #6e56cf;
	--st-rejected-fg: #cf222e;
	--st-rejected-dot: #cf222e;
	--st-failed-fg: #82071e;
	--st-failed-dot: #82071e;
	--pill-finished-fg: #57606a;
}
@media (prefers-color-scheme: dark) {
	:root {
		--bg: #0d1117;
		--panel: #161b22;
		--border: #30363d;
		--text: #e6edf3;
		--muted: #8b949e;
		--accent: #58a6ff;
		--user: #12263f;
		--assistant: #161b22;
		--thinking: #241a3d;
		--tool: #1c2129;
		--error: #ff7b72;
		--link: #58a6ff;
		--splitter: #6e7681;
		--hover-bg: #21262d;
		--selected-bg: #1c2b45;
		--active-bg: #223a5e;
		--disabled-fg: #6e7681;
		--disabled-bg: #21262d;
		--st-running-fg: #3fb950;
		--st-running-dot: #56d364;
		--st-recent-fg: #d29922;
		--st-recent-dot: #e3b341;
		--st-finished-fg: #8b949e;
		--st-finished-dot: #6e7681;
		--st-pending-fg: #a371f7;
		--st-pending-dot: #a371f7;
		--st-rejected-fg: #ff7b72;
		--st-rejected-dot: #f85149;
		--st-failed-fg: #ffa198;
		--st-failed-dot: #f85149;
		--pill-finished-fg: #8b949e;
	}
	/* Error banner: darker fill in dark mode; --error stays the lighter text red. */
	.banner { background: #d1242f; }
	.new-content { color: #0d1117; }
}
* { box-sizing: border-box; }
/* Author display rules (e.g. .icon-btn { display: inline-flex }) would otherwise
   beat the UA's own [hidden] rule, leaving hidden elements visible. */
[hidden] { display: none !important; }
:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
html, body { height: 100%; margin: 0; }
body {
	background: var(--bg);
	color: var(--text);
	font: var(--fs-3)/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
	display: flex;
	flex-direction: column;
}
.banner { background: var(--error); color: #fff; padding: 8px 14px; font-weight: 600; }
.topbar {
	display: flex;
	align-items: center;
	justify-content: space-between;
	gap: 12px;
	padding: 10px 16px;
	background: var(--panel);
	border-bottom: 1px solid var(--border);
}
.title { font-weight: 700; letter-spacing: 0.02em; font-size: var(--fs-4); }
.pill {
	padding: 2px 10px;
	border: 1px solid var(--border);
	border-radius: var(--r-full);
	color: var(--muted);
	font-variant-numeric: tabular-nums;
}
.pill-running { color: var(--st-running-fg); border-color: var(--st-running-fg); }
.pill-recent { color: var(--st-recent-fg); border-color: var(--st-recent-fg); }
.pill-finished { color: var(--pill-finished-fg); }
.pill-pending { color: var(--st-pending-fg); border-color: var(--st-pending-fg); }
.pill-rejected { color: var(--st-rejected-fg); border-color: var(--st-rejected-fg); }
.pill-failed { color: var(--st-failed-fg); border-color: var(--st-failed-fg); }
.last-update { color: var(--muted); font-size: var(--fs-1); font-variant-numeric: tabular-nums; }
.last-update.error { color: var(--error); }
.layout {
	position: relative;
	flex: 1;
	min-height: 0;
	display: grid;
	grid-template-columns: var(--sidebar-width, 280px) 5px 1fr;
}
.layout > .tree { grid-column: 1; min-width: 0; }
.layout > .splitter { grid-column: 2; }
.layout > .transcript-wrap { grid-column: 3; min-width: 0; }
.layout.sidebar-collapsed { grid-template-columns: 0 0 1fr; }
.layout.sidebar-collapsed > .tree, .layout.sidebar-collapsed > .splitter { display: none; }
.layout.sidebar-collapsed .transcript-wrap { padding-top: 44px; }
.icon-btn {
	display: inline-flex;
	align-items: center;
	justify-content: center;
	min-width: 28px;
	min-height: 28px;
	padding: 2px 6px;
	border: none;
	border-radius: var(--r-2);
	background: transparent;
	color: var(--muted);
	font: inherit;
	line-height: 1;
	cursor: pointer;
	transition: background 120ms ease, color 120ms ease;
}
.icon-btn:hover { background: var(--tool); color: var(--text); }
.icon-btn:focus-visible { outline: var(--focus-ring); outline-offset: 1px; }
.icon-btn:disabled { color: var(--disabled-fg); background: var(--disabled-bg); cursor: default; }
.sidebar-expand {
	position: absolute;
	top: 10px;
	left: 10px;
	z-index: 10;
	background: var(--panel);
}
.splitter {
	position: relative;
	width: 5px;
	touch-action: none;
	cursor: col-resize;
	background: var(--splitter);
	transition: background 120ms ease;
}
.splitter:hover { background: var(--accent); }
.splitter:focus-visible { background: var(--accent); }
.splitter::after { content: ""; position: absolute; inset: 0 -4px; }
.tree {
	display: flex;
	flex-direction: column;
	min-height: 0;
	background: var(--panel);
	border-right: 1px solid var(--border);
}
.sidebar-head {
	display: flex;
	align-items: center;
	justify-content: space-between;
	gap: var(--sp-2);
	padding: 8px 8px 4px;
}
.sidebar-title {
	margin: 0;
	font-weight: 600;
	font-size: var(--fs-2);
	color: var(--muted);
	text-transform: uppercase;
	letter-spacing: 0.05em;
}
.sidebar-actions { display: flex; align-items: center; gap: 2px; }
.tree-list { flex: 1; min-height: 0; overflow: auto; padding: 6px 8px 8px; container-type: inline-size; }
/* 单行 32px；降级顺序 耗时 → taskId 短码 → 聚合徽章（容器变窄时按阈值依次触发：
   徽章 cap 收紧 ≤340px（9.2em）→ 耗时隐藏 ≤239px → taskId 短码隐藏 ≤219px →
   聚合徽章 cap ≤199px；徽章 14em 为全局常驻上限）；永不折行。
   谱系后缀（.lineage）可收缩但带 6em（≈66px）下限（max-width 9em），故 ≤340px
   容器内带后缀的行先让出 taskId 短码 / 耗时 / 聚合徽章（见下方 340px 块），
   ≤239px 才会整体隐藏。 */
@container (max-width: 239px) {
	/* <240px：先牺牲耗时；谱系后缀整体隐藏 */
	.elapsed { display: none; }
	.lineage { display: none; }
}
@container (max-width: 219px) {
	/* <220px：再牺牲 taskId 短码 */
	.tid { display: none; }
}
@container (max-width: 199px) {
	/* <200px：聚合徽章末级降级，压成省略号 */
	.child-summary { max-width: 6em; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
}
.truncated-note { padding: 0 8px 6px; color: var(--muted); font-size: var(--fs-1); }
.node {
	display: flex;
	flex-wrap: nowrap;
	align-items: center;
	gap: 6px;
	height: var(--sp-6);
	box-sizing: border-box;
	line-height: var(--lh-row);
	padding: 6px 8px;
	border-radius: var(--r-2);
	cursor: pointer;
	transition: background 120ms ease, color 120ms ease;
}
.node:hover { background: var(--hover-bg); }
.node:active { background: var(--active-bg); }
.node.active { background: var(--selected-bg); }
.node:focus-visible { outline: none; box-shadow: inset 0 0 0 1px var(--accent); }
.task-line {
	flex: 1 1 auto;
	min-width: 0;
	overflow: hidden;
	color: var(--muted);
	font-size: var(--fs-2);
	white-space: nowrap;
	text-overflow: ellipsis;
}
.child-summary {
	min-width: 0;
	overflow: hidden;
	text-overflow: ellipsis;
	white-space: nowrap;
	color: var(--muted);
	font-size: var(--fs-1);
}
.lineage {
	flex: 0 1 auto;
	min-width: 6em;
	max-width: 9em;
	white-space: nowrap;
	overflow: hidden;
	text-overflow: ellipsis;
	color: var(--muted);
	font-size: var(--fs-1);
}
.badge {
	box-sizing: border-box;
	flex: 0 0 auto;
	height: var(--lh-row);
	padding: 0 6px;
	border: 1px solid var(--border);
	border-radius: var(--r-1);
	background: var(--tool);
	font-size: var(--fs-1);
	font-weight: 600;
	max-width: 14em;
	white-space: nowrap;
	overflow: hidden;
	text-overflow: ellipsis;
}
/* 容器变窄时最先触发的降级（≤340px：徽章 cap 收紧为 9.2em；其后依次为
   ≤239px 隐藏耗时、≤219px 隐藏 taskId 短码、≤199px 聚合徽章 cap；徽章 14em
   为全局常驻上限）。实测：默认侧栏 tree-list 内容盒 263px 时，行内
   tid/elapsed 全显后每行仅余约 99px，14em 静态上限会横向溢出，故 340px
   及以下容器改用 9.2em（≈101.2px）—— engineer-legion（100.04px）完整，
   超长 agent 名省略号截断。置于基础规则之后，避免覆盖顺序反转。 */
@container (max-width: 340px) {
	.badge { max-width: 9.2em; }
	/* 完整 badge（宽 agent 名仍可达 9.2em≈101px）与可收缩后缀（6em–9em）同居一行时，
	   默认侧栏行（内容盒 263px）已容不下 taskId 短码 / 耗时 / 聚合徽章；三者本就是
	   低优先级降级列，在 ≤340px 容器内为带后缀的行让位（色点、badge、task-line、
	   后缀保留不隐藏；badge 保持 flex: 0 0 auto 完整显示）。 */
	.node:has(.lineage) .tid,
	.node:has(.lineage) .elapsed,
	.node:has(.lineage) .child-summary { display: none; }
}
@container (min-width: 340px) and (max-width: 440px) {
	.badge { max-width: 9.2em; }
	.node:has(.lineage) .tid,
	.node:has(.lineage) .elapsed,
	.node:has(.lineage) .child-summary { display: none; }
}
/* 宽侧栏（内容盒 >440px）行内空间充裕：后缀放宽回 12em，完整显示
   ↳ agent · taskId 短码（实测 scrollWidth ≈129px ≤ 132px）。 */
@container (min-width: 441px) {
	.lineage { max-width: 12em; }
}
.dot { display: inline-block; flex: 0 0 auto; width: 8px; height: 8px; border-radius: var(--r-full); }
.dot-running { background: var(--st-running-dot); }
.dot-recent { background: var(--st-recent-dot); }
.dot-finished { background: var(--st-finished-dot); }
.dot-pending { background: var(--st-pending-dot); }
.dot-rejected { background: var(--st-rejected-dot); }
.dot-failed { background: var(--st-failed-dot); }
.dot-root { background: var(--muted); }
.status-word { color: var(--muted); font-size: var(--fs-1); flex-shrink: 0; white-space: nowrap; }
.status-running { color: var(--st-running-fg); }
.status-recent { color: var(--st-recent-fg); }
.status-finished { color: var(--st-finished-fg); }
.status-pending { color: var(--st-pending-fg); }
.status-rejected { color: var(--st-rejected-fg); }
.status-failed { color: var(--st-failed-fg); }
.node-error {
	margin-top: var(--sp-1);
	padding: 6px 8px;
	border: 1px solid var(--error);
	border-radius: var(--r-2);
	background: var(--panel);
}
.node-error .text { max-height: 260px; overflow: auto; }
.open-session { color: var(--accent); font-size: var(--fs-1); }
.tid { color: var(--muted); font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: var(--fs-1); flex-shrink: 0; white-space: nowrap; }
/* 实测边界（700px 档、默认侧栏）：耗时列 "10h 32m"（45.16px）时行 scrollWidth
   270 > clientWidth 263（伸入行右内边距），但其右沿 277.91px 仍在 #tree-list
   滚动口 279px 内（树 279/279、scrollLeft 读写 0）——无横向滚动，余量 1.09px。
   极端耗时（如 3 位小时、"999m 59s"）由 max-width: 6em 封顶并省略号截断，
   不再撑破单行；≤239px 容器本列 display:none。 */
.elapsed { flex-shrink: 0; margin-left: auto; max-width: 6em; overflow: hidden; text-overflow: ellipsis; color: var(--muted); font-size: var(--fs-1); white-space: nowrap; }
.subagent-nav { margin: 4px 0 0; font-size: var(--fs-2); }
.subagent-waiting { color: var(--muted); }
.subagent-link { color: var(--link); text-decoration: none; }
.subagent-link:hover { text-decoration: underline; }
.transcript-wrap {
	display: flex;
	flex-direction: column;
	min-width: 0;
	overflow: hidden;
}
.crumbs {
	display: flex;
	flex-wrap: wrap;
	align-items: center;
	gap: var(--sp-2);
	min-height: var(--sp-5);
	padding: var(--sp-2) var(--sp-4);
	border-bottom: 1px solid var(--border);
	background: var(--panel);
	font-size: var(--fs-2);
}
.crumb { display: inline-flex; align-items: center; gap: 4px; max-width: 100%; min-width: 0; color: var(--link); text-decoration: none; }
.crumb:hover { text-decoration: underline; }
.crumb-label { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
.crumb-sep { color: var(--muted); }
.back-btn {
	display: inline-flex;
	align-items: center;
	padding: 2px 8px;
	border: 1px solid var(--border);
	border-radius: var(--r-1);
	background: var(--tool);
	color: var(--muted);
	font: inherit;
	cursor: pointer;
}
.back-btn:hover { color: var(--text); }
.transcript-head { position: sticky; top: 0; z-index: 3; display: flex; justify-content: flex-end; align-items: center; padding: 4px 0 4px 8px; background: var(--panel); }
.transcript { flex: 1; min-height: 0; overflow: auto; padding: var(--sp-4); display: flex; flex-direction: column; gap: var(--sp-3); }
.entry { padding: var(--sp-3); border: 1px solid var(--border); border-radius: var(--r-3); background: var(--assistant); }
.entry-header {
	margin-bottom: var(--sp-1);
	color: var(--muted);
	font-size: var(--fs-1);
	letter-spacing: 0.05em;
	text-transform: uppercase;
}
.entry.user { background: var(--user); }
.entry.thinking { background: var(--thinking); }
.entry.tool-call, .entry.tool-result { background: var(--tool); }
.entry .entry {
	margin-left: 14px;
	padding-left: 8px;
	border-left: 2px solid var(--border);
}
.entry.error { border-color: var(--error); }
.entry.error .entry-header, .entry.error summary { color: var(--error); }
.text { white-space: pre-wrap; word-break: break-word; }
.text code {
	padding: 0 4px;
	border-radius: 4px;
	background: var(--tool);
	font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
}
.text pre {
	margin: 6px 0;
	padding: 8px;
	overflow: auto;
	border: 1px solid var(--border);
	border-radius: 6px;
	background: var(--tool);
	white-space: pre;
}
.text pre code { padding: 0; background: none; }
details summary { cursor: pointer; color: var(--muted); }
.new-content {
	position: fixed;
	right: 18px;
	bottom: 18px;
	padding: 8px 14px;
	border: 1px solid var(--border);
	border-radius: var(--r-full);
	background: var(--accent);
	color: #fff;
	cursor: pointer;
	transition: background 120ms ease, color 120ms ease;
}
.image-block {
	display: flex;
	flex-direction: column;
	align-items: flex-start;
	gap: 6px;
	margin: 6px 0;
	padding: 8px;
	border: 1px dashed var(--border);
	border-radius: 6px;
	background: var(--tool);
}
.image-meta {
	color: var(--muted);
	font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
	font-size: 11px;
}
.image-preview { max-width: 100%; border: 1px solid var(--border); border-radius: 6px; }
.image-error { color: var(--error); font-size: 12px; }
.image-note { color: var(--muted); font-size: 12px; }
.load-image {
	padding: 4px 10px;
	border: 1px solid var(--border);
	border-radius: var(--r-full);
	background: var(--panel);
	color: var(--accent);
	font: inherit;
	cursor: pointer;
	transition: background 120ms ease, color 120ms ease;
}
.load-image:hover { background: var(--tool); }
.remote-image {
	display: inline-flex;
	flex-direction: column;
	gap: 4px;
	padding: 6px 10px;
	border: 1px dashed var(--border);
	border-radius: var(--r-2);
	background: var(--tool);
	color: var(--muted);
	font-size: var(--fs-2);
}
.remote-image a { color: var(--link); text-decoration: none; word-break: break-all; }
.remote-image a:hover { text-decoration: underline; }
.text.markdown { white-space: normal; }
.text.markdown p { margin: 0 0 8px; }
.text.markdown p:last-child { margin-bottom: 0; }
.text.markdown ul, .text.markdown ol { margin: 0 0 8px; padding-left: 20px; }
.text.markdown blockquote {
	margin: 0 0 8px;
	padding-left: 10px;
	border-left: 3px solid var(--border);
	color: var(--muted);
}
.text.markdown h1, .text.markdown h2, .text.markdown h3, .text.markdown h4 { margin: 10px 0 6px; font-size: 1.05em; }
.text.markdown table { border-collapse: collapse; margin: 6px 0; }
.text.markdown th, .text.markdown td { padding: 2px 8px; border: 1px solid var(--border); }
.text.markdown a { color: var(--link); }
.hljs { color: var(--text); background: none; }
.hljs-keyword, .hljs-selector-tag, .hljs-literal, .hljs-section { color: #cf222e; }
.hljs-string, .hljs-regexp, .hljs-addition { color: #0a3069; }
.hljs-comment, .hljs-quote { color: var(--muted); font-style: italic; }
.hljs-number, .hljs-symbol, .hljs-bullet { color: #953800; }
.hljs-title, .hljs-name, .hljs-title.class_, .hljs-title.function_ { color: #8250df; }
.hljs-attr, .hljs-attribute, .hljs-variable { color: #116329; }
.hljs-built_in, .hljs-type { color: #0550ae; }
.hljs-meta, .hljs-doctag { color: var(--muted); }
.hljs-deletion { color: var(--error); }
@media (prefers-color-scheme: dark) {
	.hljs-keyword, .hljs-selector-tag, .hljs-literal, .hljs-section { color: #ff7b72; }
	.hljs-string, .hljs-regexp, .hljs-addition { color: #a5d6ff; }
	.hljs-number, .hljs-symbol, .hljs-bullet { color: #ffa657; }
	.hljs-title, .hljs-name, .hljs-title.class_, .hljs-title.function_ { color: #d2a8ff; }
	.hljs-attr, .hljs-attribute, .hljs-variable { color: #7ee787; }
	.hljs-built_in, .hljs-type { color: #79c0ff; }
}
.empty-state {
	display: flex;
	align-items: center;
	justify-content: center;
	padding: var(--sp-6);
	color: var(--muted);
	text-align: center;
}
@media (prefers-reduced-motion: reduce) {
	* { transition: none; animation: none; }
}
</style>
</head>
<body>
<div id="banner" class="banner" role="alert" hidden></div>
<header class="topbar">
	<div class="title">Subagent sessions</div>
	<div id="last-update" class="last-update"></div>
</header>
<main class="layout">
	<aside id="tree" class="tree" aria-label="Session tree">
		<div class="sidebar-head">
			<h2 class="sidebar-title">Sessions</h2>
			<div class="sidebar-actions">
				<button id="sidebar-collapse" class="icon-btn" type="button" title="Collapse sidebar" aria-label="Collapse sidebar" aria-expanded="true" aria-controls="tree">&#171;</button>
			</div>
		</div>
		<div id="truncated-note" class="truncated-note" hidden></div>
		<div id="tree-list" class="tree-list" role="list" aria-label="Sessions"></div>
	</aside>
	<div id="splitter" class="splitter" role="separator" aria-orientation="vertical" aria-label="Resize sidebar" aria-valuemin="200" aria-valuetext="Sidebar width: 280px" aria-controls="transcript" tabindex="0"></div>
	<button id="sidebar-expand" class="icon-btn sidebar-expand" type="button" title="Expand sidebar" aria-label="Expand sidebar" aria-expanded="false" aria-controls="tree" hidden>&#187;</button>
	<section class="transcript-wrap">
		<nav id="crumbs" class="crumbs" aria-label="Breadcrumb" hidden></nav>
		<div class="transcript-head"><div id="status" class="pill">no task selected</div></div>
		<section id="transcript" class="transcript" aria-label="Transcript"></section>
	</section>
</main>
<button id="new-content" class="new-content" hidden>New content</button>
<script>
${MARKED_JS}
</script>
<script>
${HIGHLIGHT_JS}
</script>
<script>
(function () {
	"use strict";

	var BACKTICK = String.fromCharCode(96);
	var NL = String.fromCharCode(10);
	var TOKEN = new URLSearchParams(location.search).get("t") || "";
	var TASK_PREFIX = "#/t/";
	var ROOT_HASH = "#/";
	var POLL_MS = 1000;
	var TREE_EVERY = 3;
	// 用户口径：日志式，最新在底部。false 按传入顺序（服务端 startedAt 升序）
	// 渲染；置 true 才切回旧的「最新在上」倒序。
	var LIST_NEWEST_FIRST = false;
	var PAGE_API_VERSION = ${API_VERSION};
	var MAX_FAILURES = 5;
	var BACKOFF_MS = [1000, 2000, 4000, 8000, 16000, 30000];
	var REQUEST_TIMEOUT_MS = 10000;
	var SIDEBAR_MIN = 200;
	var SIDEBAR_MAX_RATIO = 0.6;
	var SIDEBAR_MAX_RATIO_MID = 0.45;
	var SIDEBAR_MID_THRESHOLD = 1000;
	var NARROW_MAX = 700;
	var SIDEBAR_STEP = 16;

	var treeEl = document.getElementById("tree-list");
	var transcriptEl = document.getElementById("transcript");
	var crumbsEl = document.getElementById("crumbs");
	var statusEl = document.getElementById("status");
	var bannerEl = document.getElementById("banner");
	var newContentEl = document.getElementById("new-content");
	var truncatedEl = document.getElementById("truncated-note");
	var lastUpdateEl = document.getElementById("last-update");
	var layoutEl = document.querySelector(".layout");
	var sidebarCollapseEl = document.getElementById("sidebar-collapse");
	var sidebarExpandEl = document.getElementById("sidebar-expand");
	var splitterEl = document.getElementById("splitter");

	var state = {
		taskId: null,
		// Key (node.taskId, or the composite key of a taskless row) of the row
		// whose error panel is currently open; null when every panel is closed.
		openPanelTaskId: null,
		routed: false,
		gen: 0,
		offset: 0,
		initialized: false,
		polling: false,
		treeFetching: false,
		waiting: false,
		follow: true,
		autoScrolledOnce: false,
		userScrolledSidebar: false,
		savedSidebarScroll: null,
		sidebarScrollInitialized: false,
		tree: [],
		truncated: null,
		expanded: {},
		lastOkMs: 0,
		lastError: "",
		mismatch: false,
		timer: null,
		failures: 0,
		retryAt: 0,
		lastTreeMs: 0,
		treeEtag: null,
		startOffset: 0,
		backfilling: false,
		beginningShown: false,
		topAnchor: null,
		links: [],
		path: [],
		pathFound: null,
		pathTask: null,
		pathFor: null,
		sidebarScrollPending: false
	};

	// Inlined verbatim from src/web/markdown.ts (function.toString()) so the
	// page sanitizer can never drift from the tested module.
	${escapeRawHtml.toString()}
	${isSafeHref.toString()}
	${isAllowedImageSrc.toString()}
	${neutralizeRemoteMarkup.toString()}

	// Inlined verbatim from src/web/tree-view.ts (function.toString()) so the
	// tested pure helpers can never drift from their unit tests.
	${childSummary.toString()}
	${ancestorIds.toString()}
	${backTarget.toString()}
	${scrollTargetTaskId.toString()}
	${sidebarScrollAnchor.toString()}
	${sidebarRestoreScrollTop.toString()}
	${parseSidebarAnchor.toString()}
	${serializeSidebarAnchor.toString()}
	${crumbLabel.toString()}
	${lineageRowId.toString()}
	${lineageLabel.toString()}
	${durationMs.toString()}

	function request(pathname, params, headers) {
		var search = new URLSearchParams();
		search.set("t", TOKEN);
		Object.keys(params || {}).forEach(function (key) { search.set(key, String(params[key])); });
		// Abort a hung request so the poll loop falls into the normal failure
		// path (backoff + offline banner) instead of stalling forever.
		var controller = new AbortController();
		var timer = setTimeout(function () { controller.abort(); }, REQUEST_TIMEOUT_MS);
		// Clear the abort timer as soon as headers arrive; leaving it running for
		// every successful poll would pile up idle 10s timers.
		return fetch(pathname + "?" + search.toString(), { headers: headers || {}, signal: controller.signal })
			.then(function (response) {
				clearTimeout(timer);
				return response;
			})
			.catch(function (error) {
				clearTimeout(timer);
				throw error;
			});
	}

	function el(tag, className, text) {
		var node = document.createElement(tag);
		if (className) { node.className = className; }
		if (text !== undefined && text !== null) { node.textContent = String(text); }
		return node;
	}

	function routeTaskId() {
		var hash = location.hash || "";
		if (hash.indexOf(TASK_PREFIX) !== 0) { return null; }
		var rest = hash.slice(TASK_PREFIX.length).split("?")[0].split("/")[0];
		if (!rest) { return null; }
		try {
			return decodeURIComponent(rest);
		} catch (error) {
			return null;
		}
	}

	function findNode(nodes, taskId) {
		for (var i = 0; i < nodes.length; i += 1) {
			if (nodes[i].taskId === taskId) { return nodes[i]; }
			var found = findNode(nodes[i].children || [], taskId);
			if (found) { return found; }
		}
		return null;
	}

	// Optimistic selection highlight: tree rows carry data-task-id, so the
	// active row can be switched synchronously (route/click) instead of only on
	// the next tree refresh. aria-current and the roving tabindex follow the
	// same "current row" notion.
	function highlightSelection() {
		var rowId = state.taskId !== null ? lineageRowId(state.taskId, state.pathFor === state.taskId ? state.path : [], ancestorIds(state.tree, state.taskId)) : null;
		var rows = treeEl.querySelectorAll(".node");
		for (var i = 0; i < rows.length; i += 1) {
			var selected = rowId !== null && rows[i].dataset.taskId === rowId;
			rows[i].classList.toggle("active", selected);
			if (selected) {
				rows[i].setAttribute("aria-current", "true");
				if (state.taskId !== null && rowId !== state.taskId) {
					var suffix = rows[i].querySelector(".lineage");
					if (!suffix) {
						suffix = el("span", "lineage", "");
						rows[i].appendChild(suffix);
					}
					suffix.textContent = lineageLabel((state.pathTask || findNode(state.tree, state.taskId) || {}).agent, state.taskId);
				} else {
					var topSuffix = rows[i].querySelector(".lineage");
					if (topSuffix) { topSuffix.remove(); }
				}
			} else {
				rows[i].removeAttribute("aria-current");
				var stale = rows[i].querySelector(".lineage");
				if (stale) { stale.remove(); }
			}
		}
		updateRovingTabindex();
	}

	function findLink(toolCallId) {
		if (!toolCallId || !Array.isArray(state.links)) { return null; }
		for (var i = 0; i < state.links.length; i += 1) {
			var link = state.links[i];
			if (link && link.toolCallId === toolCallId) { return link; }
		}
		return null;
	}

	function navStatus(link) {
		var node = link.childTaskId ? findNode(state.tree, link.childTaskId) : null;
		if (node && node.status) { return node.status; }
		// Not in the current tree (deep link, or the first tree fetch has not
		// landed yet): stay neutral and honest. A receipt only proves the task
		// was dispatched, so "running" is the fallback until the tree refresh
		// replaces it with the real status.
		return "running";
	}

	function navText(link) {
		return "→ open " + (link.agent || "subagent") + " (" + navStatus(link) + ")";
	}

	function navAnchor(link) {
		var anchor = el("a", "subagent-link", navText(link));
		anchor.href = TASK_PREFIX + encodeURIComponent(link.childTaskId);
		return anchor;
	}

	function navWaiting() {
		return el("span", "subagent-waiting", "waiting for receipt");
	}

	// Upgrade an existing nav container in place: a waiting item flips to a
	// link as soon as its receipt/pointer lands, and an existing link only has
	// its label/href refreshed (no re-created anchors on every poll).
	function updateNav(nav) {
		var link = findLink(nav.getAttribute("data-toolcall-id") || "");
		var anchor = nav.querySelector("a.subagent-link");
		if (!link) {
			if (!anchor) { return; }
			nav.textContent = "";
			nav.appendChild(navWaiting());
			return;
		}
		if (anchor) {
			anchor.textContent = navText(link);
			anchor.href = TASK_PREFIX + encodeURIComponent(link.childTaskId);
			return;
		}
		nav.textContent = "";
		nav.appendChild(navAnchor(link));
	}

	function applyNavLinks() {
		var navs = document.querySelectorAll(".subagent-nav");
		for (var i = 0; i < navs.length; i += 1) { updateNav(navs[i]); }
	}

	function subagentNav(part) {
		var nav = el("div", "subagent-nav");
		nav.setAttribute("data-toolcall-id", part.id || "");
		var link = findLink(part.id || "");
		nav.appendChild(link ? navAnchor(link) : navWaiting());
		return nav;
	}

	// Only a real dispatch deserves a nav item: a subagent toolCall without a
	// task (e.g. action:"cancel") has no receipt to wait for, so rendering one
	// would leave a permanent "waiting for receipt" item. Calls that already
	// have a receipt/pointer link keep rendering it regardless.
	function appendSubagentNav(parent, part) {
		if (part.name !== "subagent") { return; }
		if (findLink(part.id || "") === null) {
			var args = part.arguments || {};
			if (typeof args.task !== "string" || args.task === "") { return; }
		}
		parent.appendChild(subagentNav(part));
	}

	function formatMs(ms) {
		var seconds = Math.floor(ms / 1000);
		if (seconds < 60) { return seconds + "s"; }
		var minutes = Math.floor(seconds / 60);
		if (minutes < 60) { return minutes + "m " + (seconds % 60) + "s"; }
		var hours = Math.floor(minutes / 60);
		return hours + "h " + (minutes % 60) + "m";
	}

	function formatDuration(node) {
		var ms = durationMs(node, Date.now());
		return ms === null ? "—" : formatMs(ms);
	}

	function updateStatus() {
		updateStatusPill();
	}

	function updateStatusPill() {
		if (state.failures >= MAX_FAILURES) {
			statusEl.className = "pill";
			statusEl.textContent = "offline";
			return;
		}
		// A failed/rejected dispatch outranks the waiting state: the node may
		// come from the tree or from the deep-linked path metadata. pathTask
		// also backs the pill for tasks missing from the current tree
		// (finished/recent/pending deep links) instead of a permanent loading
		// state.
		var pillNode = state.taskId ? findNode(state.tree, state.taskId) : null;
		var pillMeta = pillNode || state.pathTask || null;
		var status = pillMeta && pillMeta.status ? pillMeta.status : null;
		// Path metadata carries no startedAt (only the task summary), so the
		// duration separator is gated: no start time, no trailing " | ".
		var duration = pillMeta && pillMeta.startedAt ? formatDuration(pillMeta) : "";
		if (status === "failed" || status === "rejected") {
			statusEl.className = "pill pill-" + status;
			statusEl.textContent = status + (duration ? " | " + duration : "");
			return;
		}
		if (state.pathFound === false) {
			statusEl.className = "pill";
			statusEl.textContent = "未找到该任务";
			return;
		}
		if (state.waiting) {
			statusEl.className = "pill";
			statusEl.textContent = "waiting for session file";
			return;
		}
		if (!pillNode && !pillMeta) {
			statusEl.className = "pill";
			statusEl.textContent = state.taskId ? "loading..." : "no task selected";
			return;
		}
		statusEl.className = "pill pill-" + (status || "finished");
		statusEl.textContent = (status || "finished") + (duration ? " | " + duration : "");
	}

	// One activation path shared by click and keyboard (Enter/Space) so a tree
	// row stays reachable without a pointer.
	function activateRow(node, unknownLink) {
		if (unknownLink) {
			statusEl.className = "pill pill-pending";
			statusEl.textContent = "waiting for receipt";
			return;
		}
		location.hash = TASK_PREFIX + encodeURIComponent(node.taskId);
	}

	// Error panel: the one-line reason summary and the verbatim full errorText
	// are rendered through textContent (never innerHTML, never truncated)
	// inside a panel that only exists for nodes carrying either. It starts
	// collapsed and a row click toggles it (no navigation, no request).
	function errorPanel(node) {
		var panel = el("div", "node-error");
		panel.hidden = true;
		if (node.reason) { panel.appendChild(el("div", "error-reason", node.reason)); }
		panel.appendChild(el("div", "text", node.errorText));
		if (node.status === "failed" && node.taskId) {
			var anchor = el("a", "open-session", "open session");
			anchor.href = TASK_PREFIX + encodeURIComponent(node.taskId);
			panel.appendChild(anchor);
		}
		return panel;
	}

	// Stable per-row key behind state.openPanelTaskId: the taskId when the row
	// has one. A taskless row (rejected/unknown dispatch, taskId "") gets a
	// composite key prefixed "~" (no taskId starts with that prefix, so the two
	// key spaces cannot collide) built from the fields that tell such rows apart;
	// the same node keeps the same key across rebuilds.
	function panelKey(node) {
		if (node.taskId) { return node.taskId; }
		return "~" + (node.agent || "") + "|" + (node.status || "") + "|" + (node.task || "") + "|" + (node.errorText || node.reason || "");
	}

	// Flat sidebar: only the root rows (the main session's direct dispatches)
	// are rendered; a task's children stay reachable through its page
	// breadcrumbs. Unknown nodes (no receipt, no pointer) have no taskId yet:
	// clicking one only shows a waiting state (no hash change, no request).
	function renderList(nodes) {
		// 日志式顺序：最旧在上、最新在下（服务端顺序），只有显式开启
		// LIST_NEWEST_FIRST 时才反转让最新一行落在顶部。
		var list = LIST_NEWEST_FIRST ? nodes.slice().reverse() : nodes;
		// One toggle shared by the row click and the Enter/Space keydown paths:
		// state.openPanelTaskId records which row's panel is open (row key, not
		// just taskId) so a full tree rebuild can re-open the same row's panel --
		// including taskless rows. Every other panel is hidden first, keeping at
		// most one panel open at a time (clicking another error row moves the
		// panel instead of opening a second one).
		var toggleErrorPanel = function (errorEl, key) {
			var wasOpen = state.openPanelTaskId === key;
			var panels = treeEl.querySelectorAll(".node-error");
			for (var p = 0; p < panels.length; p += 1) { panels[p].hidden = true; }
			if (wasOpen) {
				state.openPanelTaskId = null;
				return;
			}
			errorEl.hidden = false;
			state.openPanelTaskId = key;
		};
		// 行键：panelKey(node) 作为 base，再按同一 base 在本次渲染中的出现次序
		// 追加稳定序号后缀。两次逐字相同的 taskless 派发拿到的 base 相同，
		// 序号让同键行可区分（后缀 key 两两不同，所以一次渲染至多一行匹配
		// state.openPanelTaskId）；服务端渲染顺序（追加式）稳定，故同一节点
		// 跨重建拿到的行键逐字相同。
		var keyCounts = {};
		list.forEach(function (node) {
			var unknownLink = node.linkSource === "unknown" || !node.taskId;
			// 每个节点是一个 listitem 包裹组：.node 行与（可选的）.node-error
			// 同级挂在这里，保证 #tree-list 的直接子元素全部是
			// role="listitem"，同时 .node 仍是行/焦点/查询目标。
			var item = el("div", "node-group");
			item.setAttribute("role", "listitem");
			var row = el("div", "node" + (node.taskId === state.taskId ? " active" : ""));
			row.setAttribute("role", "button");
			row.dataset.taskId = node.taskId;
			row.setAttribute("aria-label", (node.agent || "subagent") + " · " + (node.status || "finished") + " · " + formatDuration(node));
			if (node.reason) { row.title = node.reason; }
			var dot = el("span", "dot dot-" + (node.status || "finished"));
			dot.setAttribute("aria-hidden", "true");
			dot.title = node.status || "finished";
			row.appendChild(dot);
			var statusWord = el("span", "status-word", node.status || "finished");
			statusWord.classList.add("status-" + (node.status || "finished"));
			row.appendChild(statusWord);
			row.appendChild(el("span", "badge", node.agent || "subagent"));
			row.appendChild(el("span", "tid", node.taskId ? node.taskId.slice(0, 8) : ""));
			row.appendChild(el("span", "elapsed", formatDuration(node)));
			var taskLine = el("div", "task-line", node.task || "");
			taskLine.title = node.task || "";
			row.appendChild(taskLine);
			var summary = childSummary(node.children);
			if (summary) { row.appendChild(el("span", "child-summary", summary)); }
			var baseKey = panelKey(node);
			var occurrence = keyCounts[baseKey] || 0;
			keyCounts[baseKey] = occurrence + 1;
			var key = baseKey + "#" + occurrence;
			var errorEl = (node.errorText || node.reason) ? errorPanel(node) : null;
			// 所有行都写稳定的行键（焦点恢复按它寻址）；有面板的行再把同一
			// 行键写成 data-panel-key 供面板挂载/切换使用。
			row.dataset.rowKey = key;
			if (errorEl) {
				row.dataset.panelKey = key;
				errorEl.hidden = !(key === state.openPanelTaskId);
			}
			row.addEventListener("click", function () {
				if (node.errorText || node.reason) {
					if (errorEl) { toggleErrorPanel(errorEl, key); }
					return;
				}
				activateRow(node, unknownLink);
			});
			row.addEventListener("keydown", function (event) {
				if (event.key === "ArrowDown") { moveFocus(row, 1, event); }
				else if (event.key === "ArrowUp") { moveFocus(row, -1, event); }
				else if (event.key === "Home") { var rows = treeEl.querySelectorAll(".node"); focusRow(rows[0], event); }
				else if (event.key === "End") { var rowsEnd = treeEl.querySelectorAll(".node"); focusRow(rowsEnd[rowsEnd.length - 1], event); }
				else if (event.key === "Enter" || event.key === " ") {
					event.preventDefault();
					if (node.errorText || node.reason) {
						if (errorEl) { toggleErrorPanel(errorEl, key); }
						return;
					}
					activateRow(node, unknownLink);
				}
			});
			// The error panel is a sibling block below the row: the row itself is a
			// single nowrap 32px flex line, so mounting it inside would inflate the
			// line and squeeze .task-line to zero width.
			item.appendChild(row);
			if (errorEl) { item.appendChild(errorEl); }
			treeEl.appendChild(item);
		});
	}

	// First render only: bring the newest activity into view inside the sidebar
	// container itself. A deep-linked selection wins (no auto scroll), a manual
	// scroll by the user disables it, and a row that is already visible is left
	// alone. Only treeEl.scrollTop is written so the transcript never moves.
	function autoScrollSidebar() {
		if (state.autoScrolledOnce || state.userScrolledSidebar || state.savedSidebarScroll) { return; }
		var rows = treeEl.querySelectorAll(".node");
		// An empty render has nothing to bring into view: keep the one-shot
		// opportunity for the first non-empty render instead of consuming it.
		if (rows.length === 0) { return; }
		var listRect = treeEl.getBoundingClientRect();
		// Collapsed sidebar (zero height): record a deferred scroll instead of
		// consuming the one-shot; applySidebar() replays it once expanded.
		if (listRect.height === 0) { state.sidebarScrollPending = true; return; }
		var targetId = scrollTargetTaskId(state.tree, state.taskId);
		if (!targetId) { state.autoScrolledOnce = true; return; }
		var row = null;
		for (var i = 0; i < rows.length; i += 1) {
			if (rows[i].dataset.taskId === targetId) { row = rows[i]; break; }
		}
		if (!row) { state.autoScrolledOnce = true; return; }
		var rowRect = row.getBoundingClientRect();
		if (rowRect.top >= listRect.top && rowRect.bottom <= listRect.bottom) {
			state.autoScrolledOnce = true;
			return;
		}
		treeEl.scrollTop = treeEl.scrollTop + (rowRect.top - listRect.top) - (listRect.height - rowRect.height) / 2;
		state.autoScrolledOnce = true;
	}

	function clearBanner() {
		bannerEl.hidden = true;
		bannerEl.textContent = "";
	}

	function showMismatchBanner() {
		state.mismatch = true;
		bannerEl.hidden = false;
		bannerEl.textContent = "页面代码与后端不匹配，请刷新（⌘⇧R）";
	}

	function updateLastUpdate() {
		if (!lastUpdateEl) { return; }
		if (state.failures > 0) {
			lastUpdateEl.className = "last-update error";
			lastUpdateEl.textContent = "更新失败（" + (state.lastError || "网络错误") + "）";
			return;
		}
		lastUpdateEl.className = "last-update";
		lastUpdateEl.textContent = "";
	}

	function noteFailure(reason) {
		state.failures += 1;
		state.lastError = reason || "网络错误";
		updateLastUpdate();
		var delay = BACKOFF_MS[Math.min(state.failures - 1, BACKOFF_MS.length - 1)];
		state.retryAt = Date.now() + delay;
		// A mismatch banner outranks the offline notice: while the page code
		// does not match the backend, the mismatch copy keeps showing.
		if (state.mismatch) { return; }
		if (state.failures >= MAX_FAILURES) {
			bannerEl.hidden = false;
			bannerEl.textContent = "Connection lost - retrying automatically; this page recovers on its own.";
			statusEl.className = "pill";
			statusEl.textContent = "offline";
		}
	}

	function noteSuccess() {
		state.lastOkMs = Date.now();
		state.failures = 0;
		state.retryAt = 0;
		state.lastError = "";
		updateLastUpdate();
		if (!state.mismatch) { clearBanner(); }
	}

	// Truncation hint: the tree endpoint reports how many top-level dispatches
	// were dropped; show the newest-N copy only while something was dropped.
	function updateTruncated() {
		if (!truncatedEl) { return; }
		var info = state.truncated || {};
		var dropped = typeof info.dropped === "number" ? info.dropped : 0;
		if (dropped > 0) {
			truncatedEl.textContent = "显示最新 " + info.showing + " / 共 " + info.total;
			truncatedEl.hidden = false;
		} else {
			truncatedEl.hidden = true;
		}
	}

	// ---- Sidebar tree: roving focus and keyboard nav ------------------------

	// Roving tabindex: exactly one tree row is tabbable ("0"), the rest are
	// "-1". The selected row owns the slot, or the first row when nothing is
	// selected; arrow/Home/End move both focus and the tabbable slot.
	function focusRow(row, event) {
		// preventDefault before the empty-row return: a no-op move on the first or
		// last row must not fall through to the container's default scroll.
		if (event) { event.preventDefault(); }
		if (!row) { return; }
		var rows = treeEl.querySelectorAll(".node");
		for (var i = 0; i < rows.length; i += 1) {
			if (rows[i] === row) { rows[i].setAttribute("tabindex", "0"); }
			else { rows[i].setAttribute("tabindex", "-1"); }
		}
		row.focus();
	}

	function updateRovingTabindex() {
		var rows = treeEl.querySelectorAll(".node");
		// The selected row owns the tab slot; when the selection has no visible
		// row (e.g. a deep task opened by link) fall back to the first row so
		// the list always keeps exactly one tab stop.
		var currentIndex = 0;
		if (state.taskId !== null) {
			for (var k = 0; k < rows.length; k += 1) {
				if (rows[k].dataset.taskId === state.taskId) { currentIndex = k; break; }
			}
		}
		for (var i = 0; i < rows.length; i += 1) {
			if (i === currentIndex) { rows[i].setAttribute("tabindex", "0"); }
			else { rows[i].setAttribute("tabindex", "-1"); }
		}
	}

	function moveFocus(row, delta, event) {
		// preventDefault even when the move has no target (first/last row): the
		// arrow key must not scroll the tree container instead.
		if (event) { event.preventDefault(); }
		var rows = treeEl.querySelectorAll(".node");
		var index = Array.prototype.indexOf.call(rows, row);
		if (index !== -1) { focusRow(rows[index + delta], event); }
	}

	function captureSidebarAnchor() {
		var rows = treeEl.querySelectorAll(".node");
		var listTop = treeEl.getBoundingClientRect().top;
		return sidebarScrollAnchor(rows, listTop, treeEl.scrollTop);
	}

	// Restore the sidebar scroll after a rebuild: the anchor row + its pixel
	// offset relative to the container top, falling back to the raw scrollTop
	// (clamped) when the row is gone. Only treeEl.scrollTop is written.
	function restoreSidebarAnchor(anchor) {
		if (!anchor) { return; }
		var rows = treeEl.querySelectorAll(".node");
		var listTop = treeEl.getBoundingClientRect().top;
		var max = treeEl.scrollHeight - treeEl.clientHeight;
		treeEl.scrollTop = sidebarRestoreScrollTop(anchor, rows, listTop, treeEl.scrollTop, max);
	}

	function persistSidebarScroll() {
		try {
			localStorage.setItem("asi-sidebar-scroll", serializeSidebarAnchor(captureSidebarAnchor()));
		} catch (error) {
			/* localStorage may be unavailable/throwing: in-memory scroll still works */
		}
	}

	// Full tree render: rebuild the flat root rows, then re-apply the
	// selection highlight and the page breadcrumbs.
	function renderTree() {
		var firstRender = !state.sidebarScrollInitialized;
		var anchor = captureSidebarAnchor();
		// B1: keep the keyboard focus on the same row across the rebuild.
		var focusedRowKey = null;
		var activeEl = document.activeElement;
		var activeIsTreeRow = false;
		for (var a = activeEl; a; a = a.parentNode) {
			if (a === treeEl) { activeIsTreeRow = true; break; }
		}
		if (activeIsTreeRow && activeEl.classList.contains("node") && activeEl.dataset.rowKey) {
			focusedRowKey = activeEl.dataset.rowKey;
		}
		treeEl.textContent = "";
		updateTruncated();
		renderList(state.tree);
		var listRect = treeEl.getBoundingClientRect();
		if (firstRender && treeEl.querySelectorAll(".node").length > 0 && listRect.height > 0) {
			state.sidebarScrollInitialized = true;
		}
		if (firstRender && state.sidebarScrollInitialized && state.savedSidebarScroll) {
			restoreSidebarAnchor(state.savedSidebarScroll);
		} else {
			restoreSidebarAnchor(anchor);
		}
		autoScrollSidebar();
		highlightSelection();
		// B1: restore only after highlightSelection() wrote the roving tabindex
		// (a rebuilt div role="button" has no tabindex yet, and focus() on an
		// unfocusable element is a no-op in real browsers). The scroll restore
		// above has already run, so focus({ preventScroll: true }) writes no scroll.
		if (focusedRowKey) {
			var rebuiltRows = treeEl.querySelectorAll(".node");
			for (var f = 0; f < rebuiltRows.length; f += 1) {
				if (rebuiltRows[f].dataset.rowKey === focusedRowKey) {
					rebuiltRows[f].focus({ preventScroll: true });
					break;
				}
			}
		}
		applyNavLinks();
		updateStatus();
		renderCrumbs();
	}

	// Breadcrumbs for the deep page: ← Back, the ancestor chain and the
	// current task. Rebuilt on every route/tree render; every crumb is a
	// same-page #/t/<id> hash link so the token never leaves the fragment.
	function renderCrumbs() {
		if (!state.taskId) {
			crumbsEl.hidden = true;
			return;
		}
		crumbsEl.hidden = false;
		crumbsEl.textContent = "";
		// The server path (when already fetched for this task) wins: it knows the
		// ancestors a cold deep link never saw in the client tree. Until it
		// lands, fall back to the client-side ancestor chain.
		var chain = state.pathFor === state.taskId ? state.path : ancestorIds(state.tree, state.taskId);
		// ← Back only makes sense at depth ≥ 2: a top-level task has no parent,
		// so the button is not rendered at all there.
		var back = backTarget(chain, []);
		if (back !== null) {
			crumbsEl.insertAdjacentHTML("beforeend", '<button id="back" class="back-btn" type="button">← Back</button>');
			var backEl = crumbsEl.querySelector("#back");
			if (backEl) { backEl.addEventListener("click", function () { goBack(); }); }
		}
		if (state.pathFor === state.taskId) {
			state.path.forEach(function (segment) {
				var id = segment.taskId || "";
				var crumb = el("a", "crumb");
				crumb.href = TASK_PREFIX + encodeURIComponent(id);
				var dot = el("span", "dot" + (segment.status ? " dot-" + segment.status : " dot-root"));
				dot.setAttribute("aria-hidden", "true");
				crumb.appendChild(dot);
				crumb.appendChild(el("span", "crumb-label", crumbLabel(segment.task, id)));
				crumbsEl.appendChild(crumb);
				var sep = el("span", "crumb-sep", "›");
				sep.setAttribute("aria-hidden", "true");
				crumbsEl.appendChild(sep);
			});
		} else {
			ancestorIds(state.tree, state.taskId).forEach(function (id) {
				var node = findNode(state.tree, id);
				var crumb = el("a", "crumb");
				crumb.href = TASK_PREFIX + encodeURIComponent(id);
				var dot = el("span", "dot" + (node && node.status ? " dot-" + node.status : " dot-root"));
				dot.setAttribute("aria-hidden", "true");
				crumb.appendChild(dot);
				crumb.appendChild(el("span", "crumb-label", crumbLabel(node && node.task, id)));
				crumbsEl.appendChild(crumb);
				var sep = el("span", "crumb-sep", "›");
				sep.setAttribute("aria-hidden", "true");
				crumbsEl.appendChild(sep);
			});
		}
		// A task the server cannot resolve has no current crumb of its own: the
		// not-found marker IS the current crumb, so aria-current="page" stays
		// unique instead of landing on two siblings.
		if (state.pathFound === false) {
			var missing = el("span", "crumb crumb-not-found", "未找到该任务");
			missing.setAttribute("aria-current", "page");
			crumbsEl.appendChild(missing);
			return;
		}
		var currentNode = state.pathTask || findNode(state.tree, state.taskId);
		var currentLabel = crumbLabel(currentNode && currentNode.task, state.taskId);
		var current = el("a", "crumb");
		current.href = TASK_PREFIX + encodeURIComponent(state.taskId);
		var currentDot = el("span", "dot" + (currentNode && currentNode.status ? " dot-" + currentNode.status : " dot-root"));
		currentDot.setAttribute("aria-hidden", "true");
		current.appendChild(currentDot);
		current.appendChild(el("span", "crumb-label", currentLabel));
		current.setAttribute("aria-current", "page");
		crumbsEl.appendChild(current);
	}

	// Back button / Alt+ArrowLeft: step up to the direct parent. The server
	// path carries the direct parent as its last segment; the client ancestor
	// chain (still used before /api/path lands) is the fallback. A top-level
	// task (depth ≤1) has no parent: the guard leaves the hash untouched.
	function goBack() {
		var path = state.pathFor === state.taskId ? state.path : ancestorIds(state.tree, state.taskId);
		// The direct parent is the last segment; the whole chain backstops a
		// chain whose last segment is empty.
		var target = backTarget(path.slice(-1), path);
		if (target === null) { return; }
		location.hash = TASK_PREFIX + encodeURIComponent(target);
	}

	// A cold deep link the server path cannot resolve lands on a not-found card
	// instead of an endless loading state; navigating away clears it.
	function showTaskNotFound() {
		if (state.pathFound === false) {
			transcriptEl.textContent = "";
			var wrap = el("div", "task-not-found");
			wrap.insertAdjacentHTML("beforeend", '<div>未找到该任务</div><a class="back-to-list" href="#/">返回任务列表</a>');
			transcriptEl.appendChild(wrap);
		}
	}

	// Cold deep link: the client tree only holds what has been fetched so far,
	// so the server resolves the full ancestor chain once per route. A failed
	// lookup stays "unknown" and is never retried in a loop.
	function ensurePath(taskId) {
		if (!taskId) { return; }
		request("/api/path", { taskId: taskId }).then(function (response) {
			if (!response.ok) { throw new Error("HTTP " + response.status); }
			return response.json();
		}).then(function (result) {
			if (state.taskId !== taskId) { return; }
			state.path = result && Array.isArray(result.path) ? result.path : [];
			state.pathFound = !!(result && result.found);
			state.pathTask = result && result.node ? result.node : null;
			state.pathFor = taskId;
			renderCrumbs();
			highlightSelection();
			updateStatus();
			if (state.pathFound === false) { showTaskNotFound(); }
		}).catch(function () {
			if (state.taskId !== taskId) { return; }
			state.path = [];
			state.pathFound = null;
			state.pathTask = null;
			renderCrumbs();
			updateStatus();
		});
	}

	function refreshTree() {
		if (state.treeFetching || Date.now() < state.retryAt) { return; }
		state.treeFetching = true;
		state.lastTreeMs = Date.now();
		var headers = {};
		if (state.treeEtag) { headers["If-None-Match"] = state.treeEtag; }
		request("/api/tree", {}, headers).then(function (response) {
			state.treeFetching = false;
			if (response.status === 304) {
				noteSuccess();
				return null;
			}
			if (!response.ok) { throw new Error("HTTP " + response.status); }
			var etag = response.headers.get("ETag");
			if (etag) { state.treeEtag = etag; }
			return response.json().then(function (data) {
				if (data && data.apiVersion !== PAGE_API_VERSION) { showMismatchBanner(); }
				noteSuccess();
				state.tree = Array.isArray(data.nodes) ? data.nodes : [];
				// The new tree drops every merged subtree, so the per-taskId
				// expand markers must be invalidated: a previously expanded task
				// can be lazily re-requested instead of silently losing children.
				state.expanded = {};
				state.truncated = data.truncated;
				renderTree();
				if (state.taskId) { maybeExpand(state.taskId); }
			});
		}).catch(function (error) {
			state.treeFetching = false;
			noteFailure(error && error.message ? error.message : "网络错误");
		});
	}

	// Deep subtree on demand: only running/recent nodes have their children
	// scanned in the first tree answer; every other node reports a childCount
	// with an empty children array. Opening such a task asks the server for its
	// subtree once per taskId and merges the answer in place.
	function maybeExpand(taskId) {
		taskId = taskId || state.taskId;
		if (!taskId || state.expanded[taskId]) { return; }
		var current = findNode(state.tree, taskId);
		if (current && current.children.length >= (current.childCount || 0)) { return; }
		state.expanded[taskId] = true;
		request("/api/tree", { expand: taskId }).then(function (response) {
			if (!response.ok) { throw new Error("HTTP " + response.status); }
			return response.json();
		}).then(function (result) {
			if (!result) { return; }
			if (result.apiVersion !== PAGE_API_VERSION) { showMismatchBanner(); return; }
			if (!result.expand) { return; }
			var node = findNode(state.tree, taskId);
			if (!node) { return; }
			node.children = result.expand.children;
			node.childCount = node.children.length;
			node.childSummary = childSummary(node.children);
			renderTree();
		}).catch(function () {
			// The marker stays set: a failed expand is not retried in a loop.
		});
	}

	function formatBytes(bytes) {
		var value = Number(bytes) || 0;
		if (value < 1024) { return value + " B"; }
		if (value < 1024 * 1024) { return (value / 1024).toFixed(1) + " KiB"; }
		return (value / (1024 * 1024)).toFixed(1) + " MiB";
	}

	// Image placeholders: the server strips base64, so the transcript only
	// holds metadata. The bytes are fetched on demand and shown via a blob URL
	// (never a data: URL), keeping the DOM free of base64 payloads.
	function imageBlock(part) {
		var wrap = el("div", "image-block");
		var meta = el("div", "image-meta", (part.mimeType || "image") + " - " + formatBytes(part.byteLength));
		// Metadata-only blocks (no usable imageRef) must not offer a button that
		// could never load: render the placeholder and stop.
		var ref = part.imageRef || {};
		if (ref.entryIndex == null || ref.block === undefined) {
			wrap.appendChild(meta);
			wrap.appendChild(el("div", "image-note", "image not available"));
			return wrap;
		}
		var errorEl = el("div", "image-error");
		errorEl.hidden = true;
		var button = el("button", "load-image", "Load image");
		button.addEventListener("click", function () {
			if (!state.taskId) {
				fail("no active task");
				return;
			}
			request("/api/image", { taskId: state.taskId, entry: ref.entryIndex, block: ref.block }).then(function (response) {
				if (!response.ok) { throw new Error("HTTP " + response.status); }
				return response.blob();
			}).then(function (blob) {
				var image = el("img", "image-preview");
				image.alt = "session image";
				var objectUrl = URL.createObjectURL(blob);
				image.src = objectUrl;
				// Keep the blob URL on the element so releaseImages() can revoke it
				// when this entry leaves the transcript.
				image.dataset.objectUrl = objectUrl;
				wrap.insertBefore(image, meta);
				button.hidden = true;
				errorEl.hidden = true;
			}).catch(function (error) {
				fail(error && error.message ? error.message : "request failed");
			});
		});
		function fail(reason) {
			errorEl.textContent = "Failed to load image (" + reason + ")";
			errorEl.hidden = false;
		}
		wrap.appendChild(meta);
		wrap.appendChild(button);
		wrap.appendChild(errorEl);
		return wrap;
	}

	// Revoke every blob URL created for images under the given root; the
	// marker is cleared on release so a node released twice never double-revokes.
	function releaseImages(root) {
		if (!root || !root.querySelectorAll) { return; }
		var images = root.querySelectorAll("[data-object-url]");
		for (var i = 0; i < images.length; i += 1) {
			var url = images[i].getAttribute("data-object-url");
			if (url) { URL.revokeObjectURL(url); }
			images[i].removeAttribute("data-object-url");
		}
	}

	// Assistant text is markdown: every raw "<" is escaped
	// before parsing, links outside the http(s)/# whitelist degrade to plain
	// text, and code blocks are highlighted. Without the inlined vendor bundles
	// the whole pipeline falls back to a plain pre-wrap block.
	function renderMarkdown(text) {
		var wrap = el("div", "text markdown");
		var value = text === undefined || text === null ? "" : String(text);
		try {
			wrap.innerHTML = neutralizeRemoteMarkup(marked.parse(escapeRawHtml(value)));
		} catch (error) {
			wrap.textContent = value;
			return wrap;
		}
		var anchors = wrap.querySelectorAll("a[href]");
		for (var i = 0; i < anchors.length; i += 1) {
			var anchor = anchors[i];
			var href = anchor.getAttribute("href") || "";
			if (!isSafeHref(href)) {
				// Unsafe protocol: keep the visible text, drop the anchor.
				anchor.parentNode.replaceChild(document.createTextNode(anchor.textContent || ""), anchor);
				continue;
			}
			anchor.setAttribute("rel", "noopener noreferrer");
			// External sources open in their own tab; same-page # anchors stay in
			// this tab so in-page navigation is not hijacked.
			if (/^https?:/i.test(href)) {
				anchor.setAttribute("target", "_blank");
			}
		}
		// Remote images must never auto-load: only data: URLs and the internal
		// /api/image endpoint keep their img elements; everything else becomes a
		// clickable placeholder that requests the source only on user action.
		var images = wrap.querySelectorAll("img[src], img[data-remote-src]");
		for (var k = 0; k < images.length; k += 1) {
			var image = images[k];
			var src = image.getAttribute("src") || image.getAttribute("data-remote-src") || "";
			if (isAllowedImageSrc(src)) { continue; }
			var placeholder = el("span", "remote-image");
			var label = image.getAttribute("alt") || src;
			// Only an http(s)/# src may become a live clickable anchor: a
			// javascript: / data: / empty src degrades to plain text.
			if (isSafeHref(src)) {
				var remote = el("a", null, label);
				remote.href = src;
				remote.target = "_blank";
				remote.setAttribute("rel", "noopener noreferrer");
				placeholder.appendChild(remote);
			} else {
				placeholder.textContent = label;
			}
			image.parentNode.replaceChild(placeholder, image);
		}
		var blocks = wrap.querySelectorAll("pre code");
		for (var j = 0; j < blocks.length; j += 1) {
			var block = blocks[j];
			try {
				if (typeof hljs === "undefined" || !hljs || typeof hljs.highlightElement !== "function") { continue; }
				// highlight.js writes its own data-highlighted idempotency marker;
				// pre-stamping it here would make highlightElement() return early.
				hljs.highlightElement(block);
			} catch (error) {
				/* highlighting is best-effort: keep the unhighlighted code */
			}
		}
		return wrap;
	}

	function renderContent(parent, content, markdown) {
		if (typeof content === "string") {
			parent.appendChild(markdown ? renderMarkdown(content) : textBlock(content));
			return;
		}
		if (!Array.isArray(content)) { return; }
		content.forEach(function (part) {
			if (!part) { return; }
			if (part.type === "text") {
				parent.appendChild(markdown ? renderMarkdown(part.text || "") : textBlock(part.text || ""));
			}
			else if (part.type === "image") { parent.appendChild(imageBlock(part)); }
			else if (part.type === "thinking") { parent.appendChild(details("thinking", part.thinking || part.text || "", "thinking")); }
			else if (part.type === "toolCall") {
				parent.appendChild(details("tool " + (part.name || "call"), JSON.stringify(part.arguments || {}, null, 2), "tool-call"));
				appendSubagentNav(parent, part);
			}
			else { parent.appendChild(summaryEntry(part.type || "part", "")); }
		});
	}

	function appendInline(parent, text) {
		var parts = text.split(BACKTICK);
		parts.forEach(function (part, index) {
			if (index % 2 === 1) { parent.appendChild(el("code", null, part)); }
			else if (part) { parent.appendChild(document.createTextNode(part)); }
		});
	}

	function textBlock(text) {
		var wrap = el("div", "text");
		var value = text === undefined || text === null ? "" : String(text);
		var fence = BACKTICK + BACKTICK + BACKTICK;
		value.split(fence).forEach(function (segment, index) {
			if (index % 2 === 1) {
				var body = segment;
				var firstBreak = body.indexOf(NL);
				if (firstBreak !== -1) { body = body.slice(firstBreak + 1); }
				if (body.charAt(body.length - 1) === NL) { body = body.slice(0, -1); }
				var pre = el("pre");
				var code = el("code", null, body);
				try {
					if (typeof hljs !== "undefined" && hljs && typeof hljs.highlightElement === "function") { hljs.highlightElement(code); }
				} catch (error) {
					/* highlighting is best-effort: keep the unhighlighted code */
				}
				pre.appendChild(code);
				wrap.appendChild(pre);
			} else if (segment) {
				appendInline(wrap, segment);
			}
		});
		return wrap;
	}

	function details(label, body, className, markdown) {
		var wrap = el("details", "entry " + className);
		wrap.appendChild(el("summary", null, label));
		if (Array.isArray(body)) { renderContent(wrap, body, markdown); }
		else { wrap.appendChild(markdown ? renderMarkdown(body) : textBlock(body)); }
		return wrap;
	}

	function summaryEntry(label, text) {
		var wrap = el("div", "entry");
		wrap.appendChild(el("div", "entry-header", label));
		if (text) { wrap.appendChild(el("div", "text", text)); }
		return wrap;
	}

	function oneLine(value) {
		var text;
		try {
			text = typeof value === "string" ? value : JSON.stringify(value);
		} catch (error) {
			text = String(value);
		}
		text = text || "";
		return text.length > 160 ? text.slice(0, 157) + "..." : text;
	}

	function renderMessage(entry) {
		var message = entry.message || {};
		var role = message.role || "message";
		// System content is stripped server-side already; never render it here
		// (the role fallback below would otherwise produce a visible card).
		if (role === "system") { return null; }
		if (role === "user") {
			var userWrap = el("div", "entry user");
			userWrap.appendChild(el("div", "entry-header", "task"));
			renderContent(userWrap, message.content);
			return userWrap;
		}
		if (role === "assistant") {
			var taskNode = state.taskId ? findNode(state.tree, state.taskId) : null;
			var assistantWrap = el("div", "entry assistant");
			assistantWrap.appendChild(el("div", "entry-header", (taskNode && taskNode.agent) || "agent"));
			var parts = Array.isArray(message.content) ? message.content : [{ type: "text", text: String(message.content || "") }];
			parts.forEach(function (part) {
				if (!part) { return; }
				if (part.type === "text") { assistantWrap.appendChild(renderMarkdown(part.text || "")); }
				else if (part.type === "image") { assistantWrap.appendChild(imageBlock(part)); }
				else if (part.type === "thinking") { assistantWrap.appendChild(details("thinking", part.thinking || part.text || "", "thinking")); }
				else if (part.type === "toolCall") {
					assistantWrap.appendChild(details("tool " + (part.name || "call"), JSON.stringify(part.arguments || {}, null, 2), "tool-call"));
					appendSubagentNav(assistantWrap, part);
				}
				else { assistantWrap.appendChild(summaryEntry(part.type || "part", "")); }
			});
			return assistantWrap;
		}
		if (role === "toolResult") {
			var label = "tool result · " + (message.toolName || "tool") + (message.isError ? " (error)" : "");
			var resultWrap = details(label, message.content, "tool-result");
			if (message.isError) { resultWrap.classList.add("error"); }
			return resultWrap;
		}
		var fallback = el("div", "entry");
		fallback.appendChild(el("div", "entry-header", role));
		renderContent(fallback, message.content);
		return fallback;
	}

	function renderEntry(entry) {
		if (!entry || typeof entry !== "object") { return summaryEntry("entry", String(entry)); }
		if (entry.type === "message" && entry.message) { return renderMessage(entry); }
		if (entry.type === "session") { return summaryEntry("session", entry.sessionId || "session header"); }
		if (entry.type === "system") { return null; }
		return summaryEntry(entry.type || "entry", oneLine(entry));
	}

	function nearBottom() {
		return transcriptEl.scrollHeight - transcriptEl.scrollTop - transcriptEl.clientHeight < 40;
	}

	function scrollToBottom() {
		transcriptEl.scrollTop = transcriptEl.scrollHeight;
		state.follow = true;
		newContentEl.hidden = true;
	}

	function showNewContent(count) {
		newContentEl.textContent = count > 0 ? "New content (" + count + ")" : "New content";
		newContentEl.hidden = false;
	}

	function clearTranscript() {
		// Revoke every blob URL created for images: this transcript is being
		// discarded entirely, nothing is kept detached.
		releaseImages(transcriptEl);
		transcriptEl.textContent = "";
		// Top anchor: backfillOlder() prepends older entries before it, so the
		// forward entries appended below keep their relative order.
		state.topAnchor = el("div", "top-anchor");
		transcriptEl.appendChild(state.topAnchor);
		// Bump the generation on every route/switch so any response captured by
		// an older poll or backfill (even for the same task ID after A -> B -> A)
		// is dropped.
		state.gen += 1;
		state.startOffset = 0;
		state.backfilling = false;
		state.beginningShown = false;
		state.links = [];
		state.offset = 0;
		state.initialized = false;
		state.waiting = false;
		state.polling = false;
		state.follow = true;
		newContentEl.hidden = true;
	}

	function appendEntry(node) {
		// renderEntry()/renderMessage() return null for skipped (system) entries:
		// appending null would throw, so the entry is simply dropped.
		if (!node) { return; }
		transcriptEl.appendChild(node);
	}

	function showBeginning() {
		if (state.beginningShown) { return; }
		state.beginningShown = true;
		transcriptEl.insertBefore(el("div", "beginning", "Beginning of session"), state.topAnchor);
	}

	// Auto backfill: the first forward response carries the file byte offset of
	// its first entry. Older entries are pulled backward in batches and
	// prepended above everything already loaded, until the cursor reaches 0.
	function backfillOlder() {
		if (state.backfilling || !state.taskId || state.startOffset <= 0) { return; }
		state.backfilling = true;
		var gen = state.gen;
		var taskId = state.taskId;
		var before = state.startOffset;
		request("/api/session", { taskId: taskId, before: before }).then(function (response) {
			if (state.gen !== gen || state.taskId !== taskId) { return null; }
			if (!response.ok) { throw new Error("HTTP " + response.status); }
			return response.json();
		}).then(function (result) {
			if (state.gen !== gen || state.taskId !== taskId || !result) { return; }
			var next = typeof result.entriesStartOffset === "number" ? result.entriesStartOffset : 0;
			var entries = result.entries || [];
			var follow = state.follow || nearBottom();
			var heightBefore = transcriptEl.scrollHeight;
			var frag = document.createDocumentFragment();
			entries.forEach(function (entry) {
				var rendered = renderEntry(entry);
				if (rendered) { frag.appendChild(rendered); }
			});
			var firstNew = frag.firstChild;
			transcriptEl.insertBefore(frag, state.topAnchor);
			// Move the anchor to the oldest prepended node: the next (even older)
			// batch then lands above this one instead of between it and the tail.
			if (firstNew) { state.topAnchor = firstNew; }
			// Keep the viewport stable across a prepend; followers stay at the bottom.
			transcriptEl.scrollTop += transcriptEl.scrollHeight - heightBefore;
			if (follow) { scrollToBottom(); }
			// Refresh nav links from the backfill response so entries rendered from
			// older chunks leave "waiting for receipt" without waiting for the next
			// forward poll.
			state.links = Array.isArray(result.links) ? result.links : state.links;
			applyNavLinks();
			state.startOffset = next;
			state.backfilling = false;
			if (next <= 0) {
				showBeginning();
				return;
			}
			// No backward progress: stop instead of re-requesting the same window.
			if (next >= before) { return; }
			backfillOlder();
		}).catch(function () {
			if (state.gen !== gen || state.taskId !== taskId) { return; }
			state.backfilling = false;
			noteFailure();
		});
	}

	function pollOnce() {
		if (state.polling || !state.taskId || Date.now() < state.retryAt) { return; }
		state.polling = true;
		// Capture the task, offset and generation so a response that lands after
		// the user switched tasks (even A -> B -> A, where the task ID matches
		// again) is dropped instead of corrupting the new transcript.
		var gen = state.gen;
		var taskId = state.taskId;
		var offset = state.offset;
		var params = { taskId: taskId, offset: offset };
		if (!state.initialized) { params.tail = "1"; }
		request("/api/session", params).then(function (response) {
			if (state.gen !== gen || state.taskId !== taskId) { return null; }
			if (response.status === 404) {
				// Session file not on disk yet: keep polling and show the waiting
				// state instead of stopping the whole page.
				state.polling = false;
				state.waiting = true;
				noteSuccess();
				updateStatus();
				return null;
			}
			if (!response.ok) { throw new Error("HTTP " + response.status); }
			return response.json().then(function (result) {
				if (state.gen !== gen || state.taskId !== taskId) { return; }
				if (result.apiVersion !== PAGE_API_VERSION) { showMismatchBanner(); }
				var firstResponse = !state.initialized;
				state.polling = false;
				state.waiting = false;
				state.initialized = true;
				noteSuccess();
				state.links = Array.isArray(result.links) ? result.links : [];
				state.offset = result.nextOffset;
				var entries = result.entries || [];
				entries.forEach(function (entry) { appendEntry(renderEntry(entry)); });
				if (firstResponse) {
					// Only the first response seeds the backfill cursor: later forward
					// polls advance the tail offset and must not move it forward.
					state.startOffset = typeof result.entriesStartOffset === "number" ? result.entriesStartOffset : 0;
					if (state.startOffset > 0) { backfillOlder(); }
					else if (!result.truncatedBefore) { showBeginning(); }
				}
				if (entries.length > 0) {
					if (state.follow) { scrollToBottom(); }
					else { showNewContent(entries.length); }
				}
				applyNavLinks();
				updateStatus();
			});
		}).catch(function (error) {
			if (state.gen !== gen || state.taskId !== taskId) { return; }
			state.polling = false;
			noteFailure(error && error.message ? error.message : "网络错误");
		});
	}

	// ---- Sidebar collapse / resize ------------------------------------------

	var sidebarState = { userCollapsed: false, width: 280, forceOpen: false };

	function narrowWindow() {
		return window.innerWidth < NARROW_MAX;
	}

	function sidebarCollapsed() {
		// Below NARROW_MAX the sidebar auto-collapses; forceOpen (an explicit
		// expand while narrow) overrides it so the sidebar can never get stuck
		// in a "collapsed and impossible to open" state.
		if (narrowWindow()) { return !sidebarState.forceOpen; }
		return sidebarState.userCollapsed;
	}

	function sidebarMaxRatio() {
		// 700-1000px windows give the sidebar at most 45% of the width; wider
		// windows keep the historical 60%.
		return window.innerWidth < SIDEBAR_MID_THRESHOLD ? SIDEBAR_MAX_RATIO_MID : SIDEBAR_MAX_RATIO;
	}

	function clampSidebarWidth(value) {
		var max = window.innerWidth * sidebarMaxRatio();
		return Math.max(SIDEBAR_MIN, Math.min(value, max));
	}

	function applySidebar() {
		var collapsed = sidebarCollapsed();
		var expanded = !collapsed;
		layoutEl.classList.toggle("sidebar-collapsed", collapsed);
		var width = clampSidebarWidth(sidebarState.width);
		document.documentElement.style.setProperty("--sidebar-width", width + "px");
		splitterEl.setAttribute("aria-valuenow", String(Math.round(width)));
		splitterEl.setAttribute("aria-valuemin", String(SIDEBAR_MIN));
		splitterEl.setAttribute("aria-valuemax", String(Math.max(SIDEBAR_MIN, Math.round(window.innerWidth * sidebarMaxRatio()))));
		splitterEl.setAttribute("aria-valuetext", "Sidebar width: " + Math.round(width) + "px");
		sidebarCollapseEl.setAttribute("aria-expanded", String(expanded));
		sidebarExpandEl.setAttribute("aria-expanded", String(expanded));
		// The collapse button lives in the sidebar itself (hidden while
		// collapsed); the expand button is its peer in the transcript area.
		sidebarExpandEl.hidden = !collapsed;
		// A collapsed or still-empty first render never consumed the saved
		// position (no measurable list geometry), so replay it only once the
		// sidebar is expanded AND the list actually has rows to anchor to.
		var rows = treeEl.querySelectorAll(".node");
		var listRect = treeEl.getBoundingClientRect();
		if (expanded && !state.sidebarScrollInitialized && state.savedSidebarScroll && rows.length > 0 && listRect.height > 0) {
			restoreSidebarAnchor(state.savedSidebarScroll);
			state.sidebarScrollInitialized = true;
		}
		// Replay the auto scroll that was deferred while the sidebar was
		// collapsed: only on an actual expand, once, and never against a user
		// who has scrolled the list manually.
		if (expanded && state.sidebarScrollPending && !state.userScrolledSidebar) {
			state.sidebarScrollPending = false;
			autoScrollSidebar();
		}
	}

	function persistSidebar() {
		try {
			localStorage.setItem("asi-sidebar-collapsed", sidebarState.userCollapsed ? "1" : "0");
			localStorage.setItem("asi-sidebar-width", String(sidebarState.width));
		} catch (error) {
			/* localStorage may be unavailable/throwing: layout still works */
		}
	}

	// The persist flag is only set for one-shot changes (keyboard resize, drag
	// end); the drag move path stays in memory so localStorage is not written
	// on every pointermove.
	function setSidebarWidth(width, persist) {
		sidebarState.width = clampSidebarWidth(width);
		applySidebar();
		if (persist) { persistSidebar(); }
	}

	function collapseSidebar() {
		if (narrowWindow()) { sidebarState.forceOpen = false; }
		else { sidebarState.userCollapsed = true; }
		applySidebar();
		persistSidebar();
		// Keep keyboard focus inside the visible UI: the collapse button just
		// left the layout, so hand focus to its peer expand button.
		sidebarExpandEl.focus();
	}

	function expandSidebar() {
		if (narrowWindow()) { sidebarState.forceOpen = true; }
		else { sidebarState.userCollapsed = false; }
		applySidebar();
		persistSidebar();
	}

	function initSidebar() {
		try {
			sidebarState.userCollapsed = localStorage.getItem("asi-sidebar-collapsed") === "1";
			var stored = Number(localStorage.getItem("asi-sidebar-width"));
			if (Number.isFinite(stored) && stored > 0) { sidebarState.width = stored; }
		} catch (error) {
			/* localStorage may be unavailable/throwing: keep the defaults */
		}
		applySidebar();
	}

	function wireSidebar() {
		sidebarCollapseEl.addEventListener("click", collapseSidebar);
		sidebarExpandEl.addEventListener("click", expandSidebar);
		var dragging = false;
		function endDrag() {
			if (!dragging) { return; }
			dragging = false;
			persistSidebar();
		}
		splitterEl.addEventListener("pointerdown", function (event) {
			dragging = true;
			event.preventDefault();
			// Capture the pointer so move/up events keep coming to the splitter
			// even when the cursor leaves the element or the window.
			try {
				splitterEl.setPointerCapture(event.pointerId);
			} catch (error) {
				/* capture is best-effort: the window listeners still handle the drag */
			}
		});
		window.addEventListener("pointermove", function (event) {
			if (!dragging) { return; }
			// No button held means the release happened outside the window and no
			// pointerup will arrive: end the drag instead of staying stuck.
			if (event.buttons === 0) { endDrag(); return; }
			setSidebarWidth(event.clientX - layoutEl.getBoundingClientRect().left);
		});
		window.addEventListener("pointerup", endDrag);
		splitterEl.addEventListener("pointercancel", endDrag);
		splitterEl.addEventListener("lostpointercapture", endDrag);
		splitterEl.addEventListener("keydown", function (event) {
			if (event.key === "Home") {
				event.preventDefault();
				setSidebarWidth(SIDEBAR_MIN, true);
			} else if (event.key === "End") {
				event.preventDefault();
				// End jumps to the maximum: SIDEBAR_MAX_RATIO_MID below the
				// SIDEBAR_MID_THRESHOLD, SIDEBAR_MAX_RATIO above it.
				setSidebarWidth(window.innerWidth * sidebarMaxRatio(), true);
			} else if (event.key === "ArrowLeft" && !event.altKey) {
				event.preventDefault();
				setSidebarWidth(sidebarState.width - SIDEBAR_STEP, true);
			} else if (event.key === "ArrowRight" && !event.altKey) {
				event.preventDefault();
				setSidebarWidth(sidebarState.width + SIDEBAR_STEP, true);
			}
		});
		window.addEventListener("resize", function () {
			// Leaving the narrow window drops the explicit override so the stored
			// user preference takes over again.
			if (!narrowWindow()) { sidebarState.forceOpen = false; }
			applySidebar();
		});
	}

	function route() {
		var nextTaskId = routeTaskId();
		// C-07: after the first route (boot calls route() directly), ignore any
		// hash that resolves to neither a task id nor the verbatim root route:
		// "" (bare "#" in the address bar), "#foo", "#/t/" and undecodable
		// ids must keep the current task/page untouched. The guard lives here
		// (not in the hashchange registration) so boot still routes normally.
		if (state.routed && nextTaskId === null && location.hash !== ROOT_HASH) { return; }
		state.routed = true;
		// A. A real route switch/clear collapses the error panel opened on the
		// previous page; ignored hashes returned before this point.
		state.openPanelTaskId = null;
		state.taskId = routeTaskId();
		// Reset the previous route's path verdict before rendering: a stale
		// "not found" must not leak into the next task's page.
		state.path = [];
		state.pathFound = null;
		state.pathTask = null;
		state.pathFor = null;
		// Deep link #/t/<id>: the crumbs render immediately, before the first
		// tree fetch, then renderTree refreshes the chain once the tree lands.
		renderCrumbs();
		highlightSelection();
		clearTranscript();
		if (state.taskId) {
			ensurePath(state.taskId);
			pollOnce();
			maybeExpand(state.taskId);
		} else {
			transcriptEl.appendChild(el("div", "empty-state", "Select a task in the tree, or open one with " + TASK_PREFIX + "<taskId>."));
		}
		// The tree may already be in memory: render it synchronously so the row
		// selection and crumb chain land in the DOM even when refreshTree() then
		// gets a 304 (no body, no renderTree call).
		if (state.tree.length > 0) { renderTree(); }
		refreshTree();
	}

	function tick() {
		if (document.visibilityState !== "visible") { return; }
		updateLastUpdate();
		if (Date.now() - state.lastTreeMs >= TREE_EVERY * 1000) { refreshTree(); }
		if (state.taskId) {
			updateStatus();
			pollOnce();
			// A failed backfill only clears the backfilling flag; retry it on the normal
			// poll cadence once its backoff window has elapsed.
			if (!state.backfilling && !state.beginningShown && state.startOffset > 0 && Date.now() >= state.retryAt) {
				backfillOlder();
			}
		}
	}

	function boot() {
		wireSidebar();
		initSidebar();
		try {
			state.savedSidebarScroll = parseSidebarAnchor(localStorage.getItem("asi-sidebar-scroll"));
		} catch (error) {
			state.savedSidebarScroll = null;
		}
		// Any manual interaction with the sidebar stops the one-shot auto scroll
		// from fighting the user (wheel, touch dragging, keyboard scrolling).
		treeEl.addEventListener("wheel", function () { state.userScrolledSidebar = true; });
		treeEl.addEventListener("touchstart", function () { state.userScrolledSidebar = true; });
		treeEl.addEventListener("keydown", function (event) {
			if (event.key === "ArrowUp" || event.key === "ArrowDown" || event.key === "PageUp" || event.key === "PageDown" || event.key === "Home" || event.key === "End") {
				state.userScrolledSidebar = true;
			}
		});
		treeEl.addEventListener("scroll", function () {
			persistSidebarScroll();
		});
		transcriptEl.addEventListener("scroll", function () {
			state.follow = nearBottom();
			if (state.follow) { newContentEl.hidden = true; }
		});
		newContentEl.addEventListener("click", scrollToBottom);
		window.addEventListener("hashchange", route);
		document.addEventListener("keydown", function (event) {
			if (event.altKey && event.key === "ArrowLeft") {
				event.preventDefault();
				goBack();
			}
		});
		document.addEventListener("visibilitychange", function () {
			if (document.visibilityState === "visible") {
				updateStatus();
				pollOnce();
				if (Date.now() - state.lastTreeMs >= TREE_EVERY * 1000) { refreshTree(); }
			}
		});
		state.timer = setInterval(tick, POLL_MS);
		route();
	}

	boot();
})();
</script>
</body>
</html>
`;
