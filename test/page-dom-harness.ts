/**
 * PAGE_HTML 主 <script> 的最小 DOM 执行环境（测试基础设施，零新增依赖）。
 *
 * 被测对象是 src/web/page.ts 导出的 PAGE_HTML：自包含单页，主脚本是页面里
 * 最后一个 <script> 块（前两个是内联 vendor：marked / highlight.js，不需要
 * 执行）。本 harness 用 node:vm 把主脚本跑在一个手写最小 DOM stub 上，只经
 * DOM 事件、location.hash、fetch、setInterval 与页面交互（state 在 IIFE 内
 * 不可外读，一切断言走可观测 DOM 读数）。
 *
 * stub 覆盖面（按主脚本实际用到的 API 手写；若脚本在别的入口缺失某个通用
 * DOM API，在此补齐通用实现，不允许为了跑通去弱化被测逻辑）：
 *   - 元素工厂 createElement / createTextNode / createDocumentFragment，
 *     children 树 + appendChild / insertBefore / removeChild / replaceChild /
 *     remove / firstChild / textContent（setter 清子树，与真 DOM 一致）；
 *   - className / classList(add|remove|toggle|contains) / dataset（data- 属性
 *     Proxy，camelCase ↔ data-attr 双向）/ setAttribute·getAttribute·
 *     removeAttribute / hidden / title / href / style.setProperty；
 *   - querySelector(All)：逗号列表 + 后代空格 + tag / #id / .class /
 *     [attr] / [attr="v"] 复合选择器；
 *   - getBoundingClientRect()：默认非零高度，可经 setRect 注入；
 *   - focus() 建模 HTML 规范的可聚焦性：只有「带数值 tabindex 属性」或
 *     「原生可聚焦标签（a[href] / button / input / select / textarea）」且已
 *     连接在文档树内的元素才把 document.activeElement 指向自己；对不可聚焦
 *     元素（如无 tabindex 的 div role="button"）focus() 是 no-op，activeElement
 *     保持原值（真浏览器落在 body）。每次 focus() 调用都会记入
 *     focusAttempts()（含调用瞬间的 focusable / tabindex 快照），用于断言
 *     「focus 何时被调用、彼时元素是否可聚焦」（如 restore 早于 tabindex 赋值）。
 *     元素被摘出文档树时 activeElement 回落到 body，与真浏览器一致；
 *     scrollTop / scrollHeight / clientHeight；
 *   - insertAdjacentHTML("beforeend", ...) 与 innerHTML setter：极简配对标签
 *     片段解析（页面只用两处：#back 按钮与「未找到该任务」卡片）；
 *   - addEventListener + 冒泡式事件派发（row → tree → … → document → window）。
 * 环境 stub：location（可写 hash，裸 "#" 归一为 ""，与浏览器一致）、
 * localStorage、fetch（按 pathname 注入应答）、setInterval/clearInterval +
 * setTimeout/clearTimeout（假时钟，永不自触发；advanceTreePoll 手动 tick）、
 * AbortController、URLSearchParams、URL、document.visibilityState =
 * "visible"、window.innerWidth = 1280、marked 最小桩（{ parse: s => String(s) }）。
 *
 * 行寻址/观测：rowAt / clickRowAt / pressRowAt / focusRowAt 按树序操作任意行
 *（含 taskless 行），rowIdentity 给任意 .node 行取跨重建稳定标识
 *（data-panel-key → 非空 data-task-id → .task-line 文本），activeElementRow 读
 * 当前持有焦点的树内行。
 *
 * 会引出网络/定时器副作用的控制 API 返回 Promise，内部把微任务队列排干
 * （setImmediate 两轮）后再返回，返回即可断言。
 */

import { createContext, runInContext } from "node:vm";
import { PAGE_HTML } from "../src/web/page.ts";

// ---------------------------------------------------------------------------
// 选择器迷你引擎：逗号列表 + 后代空格 + 复合选择器（tag/#id/.class/[attr]/[attr="v"]）
// ---------------------------------------------------------------------------

interface CompoundSelector {
	tag: string | null;
	id: string | null;
	classes: string[];
	attrs: Array<{ name: string; value: string | null }>;
}

function parseCompound(source: string): CompoundSelector {
	const match = /^([a-zA-Z][\w-]*|\*)?(#[\w-]+)?((?:\.[\w-]+|\[[^\]]+\])*)$/.exec(source);
	if (!match) {
		throw new Error(`page-dom-harness: unsupported selector part "${source}"`);
	}
	const compound: CompoundSelector = { tag: null, id: null, classes: [], attrs: [] };
	if (match[1] && match[1] !== "*") {
		compound.tag = match[1].toLowerCase();
	}
	if (match[2]) {
		compound.id = match[2].slice(1);
	}
	const tokenRe = /\.([\w-]+)|\[([\w-]+)(?:="([^"]*)")?\]/g;
	let token: RegExpExecArray | null;
	while ((token = tokenRe.exec(match[3])) !== null) {
		if (token[1]) {
			compound.classes.push(token[1]);
		} else {
			compound.attrs.push({ name: token[2], value: token[3] === undefined ? null : token[3] });
		}
	}
	return compound;
}

function matchesCompound(el: DomEl, compound: CompoundSelector): boolean {
	if (el.nodeType !== 1) {
		return false;
	}
	if (compound.tag !== null && el.tagName.toLowerCase() !== compound.tag) {
		return false;
	}
	if (compound.id !== null && el.getAttribute("id") !== compound.id) {
		return false;
	}
	for (const className of compound.classes) {
		if (!el.classList.contains(className)) {
			return false;
		}
	}
	for (const attr of compound.attrs) {
		const value = el.getAttribute(attr.name);
		if (value === null) {
			return false;
		}
		if (attr.value !== null && value !== attr.value) {
			return false;
		}
	}
	return true;
}

function matchesChain(el: DomEl, chain: CompoundSelector[]): boolean {
	if (!matchesCompound(el, chain[chain.length - 1])) {
		return false;
	}
	if (chain.length === 1) {
		return true;
	}
	const rest = chain.slice(0, -1);
	let ancestor = el.parentNode;
	while (ancestor) {
		if (matchesChain(ancestor, rest)) {
			return true;
		}
		ancestor = ancestor.parentNode;
	}
	return false;
}

function matchAllFrom(root: DomEl, selector: string): DomEl[] {
	const alternatives = selector.split(",").map((part) =>
		part
			.trim()
			.split(/\s+/)
			.filter((piece) => piece !== "")
			.map(parseCompound),
	);
	const out: DomEl[] = [];
	walkElements(root, (el) => {
		if (alternatives.some((chain) => matchesChain(el, chain))) {
			out.push(el);
		}
	});
	return out;
}

function* iterateElements(el: DomEl): Generator<DomEl> {
	if (el.nodeType === 1) {
		yield el;
	}
	for (const child of el.children) {
		yield* iterateElements(child);
	}
}

function walkElements(root: DomEl, visit: (el: DomEl) => void): void {
	for (const el of iterateElements(root)) {
		visit(el);
	}
}

// ---------------------------------------------------------------------------
// 事件
// ---------------------------------------------------------------------------

export interface StubEvent {
	type: string;
	key?: string;
	altKey?: boolean;
	button?: number;
	clientX?: number;
	pointerId?: number;
	defaultPrevented: boolean;
	preventDefault(): void;
}

/** 一次 focus() 调用的记录：focusable / tabindex 是调用瞬间的快照（时序证据）。 */
export interface FocusAttempt {
	el: DomEl;
	/** 调用瞬间该元素是否可聚焦（数值 tabindex 或原生可聚焦标签）。 */
	focusable: boolean;
	/** 调用瞬间该元素是否连接在文档树内。 */
	connected: boolean;
	/** 调用瞬间的 tabindex 属性值（无属性为 null）。 */
	tabindexAtCall: string | null;
}

export function makeEvent(type: string, props: Partial<StubEvent> = {}): StubEvent {
	const event: StubEvent = {
		type,
		defaultPrevented: false,
		preventDefault(): void {
			event.defaultPrevented = true;
		},
		...props,
	};
	return event;
}

// ---------------------------------------------------------------------------
// 最小 DOM：元素 / 文本 / 片段 / 文档
// ---------------------------------------------------------------------------

function dataAttrName(key: string): string {
	return "data-" + String(key).replace(/[A-Z]/g, (letter) => "-" + letter.toLowerCase());
}

/** 极简 HTML 片段解析：只支持配对标签 + 双引号属性 + 文本（页面两处均如此）。 */
function parseFragment(doc: StubDocument, html: string): DomEl[] {
	const roots: DomEl[] = [];
	const stack: DomEl[] = [];
	const tokens = String(html).match(/<[^>]*>|[^<]+/g) ?? [];
	for (const token of tokens) {
		if (token.startsWith("<")) {
			const close = /^<\/(\w+)\s*>$/.exec(token);
			if (close) {
				stack.pop();
				continue;
			}
			const open = /^<(\w+)((?:\s+[\w-]+(?:="[^"]*")?)*)\s*>$/.exec(token);
			if (!open) {
				throw new Error(`page-dom-harness: unsupported fragment token "${token}"`);
			}
			const el = doc.createElement(open[1]);
			const attrRe = /([\w-]+)(?:="([^"]*)")?/g;
			let attr: RegExpExecArray | null;
			while ((attr = attrRe.exec(open[2])) !== null) {
				el.setAttribute(attr[1], attr[2] ?? "");
			}
			const parent = stack[stack.length - 1];
			if (parent) {
				parent.appendChild(el);
			} else {
				roots.push(el);
			}
			stack.push(el);
			continue;
		}
		const parent = stack[stack.length - 1];
		if (parent) {
			parent.appendChild(doc.createTextNode(token));
		}
	}
	return roots;
}

export class DomEl {
	readonly tagName: string;
	readonly attributes = new Map<string, string>();
	children: DomEl[] = [];
	parentNode: DomEl | null = null;
	readonly listeners = new Map<string, Array<(event: StubEvent) => void>>();
	hidden = false;
	scrollTop = 0;
	scrollHeight = 0;
	clientHeight = 0;
	rect = { top: 0, bottom: 40, left: 0, right: 300, width: 300, height: 40 };
	nodeType = 1;
	textValue = "";
	readonly style: { setProperty(name: string, value: string): void; removeProperty(name: string): void } & Record<string, unknown> = {
		setProperty(): void {
			/* style writes are intentionally ignored by the stub */
		},
		removeProperty(): void {
			/* style writes are intentionally ignored by the stub */
		},
	};
	readonly dataset: Record<string, string | null>;
	ownerDocument: StubDocument;

	constructor(tagName: string, doc: StubDocument) {
		this.tagName = tagName.toUpperCase();
		this.ownerDocument = doc;
		this.dataset = new Proxy({} as Record<string, string | null>, {
			get: (target, key) => (typeof key === "string" ? this.getAttribute(dataAttrName(key)) : undefined),
			set: (target, key, value) => {
				if (typeof key === "string") {
					this.setAttribute(dataAttrName(key), String(value));
				}
				return true;
			},
			has: (target, key) => typeof key === "string" && this.getAttribute(dataAttrName(key)) !== null,
			deleteProperty: (target, key) => {
				if (typeof key === "string") {
					this.removeAttribute(dataAttrName(key));
				}
				return true;
			},
		});
	}

	// ---- 属性反射 ----
	get className(): string {
		return this.attributes.get("class") ?? "";
	}

	set className(value: string) {
		this.attributes.set("class", String(value));
	}

	get id(): string {
		return this.attributes.get("id") ?? "";
	}

	set id(value: string) {
		this.attributes.set("id", String(value));
	}

	get title(): string {
		return this.attributes.get("title") ?? "";
	}

	set title(value: string) {
		this.attributes.set("title", String(value));
	}

	get href(): string {
		return this.attributes.get("href") ?? "";
	}

	set href(value: string) {
		this.attributes.set("href", String(value));
	}

	readonly classList = {
		contains: (name: string): boolean => this.className.split(/\s+/).includes(name),
		add: (...names: string[]): void => {
			const tokens = this.className.split(/\s+/).filter((piece) => piece !== "");
			for (const name of names) {
				if (!tokens.includes(name)) {
					tokens.push(name);
				}
			}
			this.className = tokens.join(" ");
		},
		remove: (...names: string[]): void => {
			this.className = this.className
				.split(/\s+/)
				.filter((piece) => piece !== "" && !names.includes(piece))
				.join(" ");
		},
		toggle: (name: string, force?: boolean): boolean => {
			const present = this.classList.contains(name);
			const next = force === undefined ? !present : Boolean(force);
			if (next) {
				this.classList.add(name);
			} else {
				this.classList.remove(name);
			}
			return next;
		},
	};

	getAttribute(name: string): string | null {
		return this.attributes.has(name) ? (this.attributes.get(name) as string) : null;
	}

	setAttribute(name: string, value: string): void {
		this.attributes.set(name, String(value));
	}

	removeAttribute(name: string): void {
		this.attributes.delete(name);
	}

	hasAttribute(name: string): boolean {
		return this.attributes.has(name);
	}

	// ---- 文本 ----
	get textContent(): string {
		if (this.nodeType === 3 || this.nodeType === 8) {
			return this.textValue;
		}
		let out = this.textValue;
		for (const child of this.children) {
			out += child.textContent;
		}
		return out;
	}

	set textContent(value: string) {
		for (const child of this.children.slice()) {
			this.detachChildNode(child);
		}
		this.children = [];
		this.textValue = String(value);
	}

	get firstChild(): DomEl | null {
		return this.children[0] ?? null;
	}

	get innerHTML(): string {
		return this.textValue;
	}

	set innerHTML(value: string) {
		this.textContent = "";
		for (const node of parseFragment(this.ownerDocument, value)) {
			this.appendChild(node);
		}
	}

	// ---- 树操作 ----
	private detachChildNode(node: DomEl): void {
		const index = this.children.indexOf(node);
		if (index !== -1) {
			this.children.splice(index, 1);
			node.parentNode = null;
			const doc = this.ownerDocument;
			if (doc.activeElement === node || (doc.activeElement && isDescendantOf(node, doc.activeElement))) {
				doc.activeElement = doc.body;
			}
		}
	}

	appendChild(node: DomEl): DomEl {
		if (node.nodeType === 11) {
			for (const child of node.children.slice()) {
				this.appendChild(child);
			}
			node.children = [];
			return node;
		}
		if (node.parentNode) {
			node.parentNode.detachChildNode(node);
		}
		node.parentNode = this;
		node.ownerDocument = this.ownerDocument;
		this.children.push(node);
		return node;
	}

	insertBefore(node: DomEl, ref: DomEl | null): DomEl {
		if (!ref) {
			return this.appendChild(node);
		}
		if (node.nodeType === 11) {
			for (const child of node.children.slice()) {
				this.insertBefore(child, ref);
			}
			node.children = [];
			return node;
		}
		if (node.parentNode) {
			node.parentNode.detachChildNode(node);
		}
		const index = this.children.indexOf(ref);
		node.parentNode = this;
		node.ownerDocument = this.ownerDocument;
		this.children.splice(index === -1 ? this.children.length : index, 0, node);
		return node;
	}

	replaceChild(node: DomEl, oldNode: DomEl): DomEl {
		const index = this.children.indexOf(oldNode);
		if (index === -1) {
			throw new Error("page-dom-harness: replaceChild target is not a child");
		}
		this.detachChildNode(oldNode);
		if (node.parentNode) {
			node.parentNode.detachChildNode(node);
		}
		node.parentNode = this;
		node.ownerDocument = this.ownerDocument;
		this.children.splice(index, 0, node);
		return oldNode;
	}

	remove(): void {
		if (this.parentNode) {
			this.parentNode.detachChildNode(this);
		}
	}

	insertAdjacentHTML(_position: string, html: string): void {
		for (const node of parseFragment(this.ownerDocument, html)) {
			this.appendChild(node);
		}
	}

	// ---- 事件 ----
	addEventListener(type: string, listener: (event: StubEvent) => void): void {
		const bucket = this.listeners.get(type) ?? [];
		bucket.push(listener);
		this.listeners.set(type, bucket);
	}

	removeEventListener(type: string, listener: (event: StubEvent) => void): void {
		const bucket = this.listeners.get(type) ?? [];
		this.listeners.set(
			type,
			bucket.filter((entry) => entry !== listener),
		);
	}

	/** 派发事件：沿 parentNode 链冒泡，随后 document → window。 */
	dispatch(event: StubEvent): void {
		let node: DomEl | null = this;
		while (node) {
			const bucket = node.listeners.get(event.type);
			if (bucket) {
				for (const listener of bucket.slice()) {
					listener.call(node, event);
				}
			}
			node = node.parentNode;
		}
		this.ownerDocument.emit(event);
	}

	// ---- 几何 / 焦点 ----
	getBoundingClientRect(): { top: number; bottom: number; left: number; right: number; width: number; height: number } {
		return this.rect;
	}

	/** HTML 规范的可聚焦性子集：数值 tabindex 属性，或原生可聚焦标签（a 需 href）。 */
	isFocusable(): boolean {
		const tag = this.tagName.toLowerCase();
		if (tag === "a") {
			return this.hasAttribute("href");
		}
		if (tag === "button" || tag === "input" || tag === "select" || tag === "textarea") {
			return true;
		}
		const tabindex = this.getAttribute("tabindex");
		if (tabindex === null) {
			return false;
		}
		const trimmed = tabindex.trim();
		return trimmed !== "" && Number.isFinite(Number(trimmed));
	}

	/** 是否连接在 document.documentElement 下（焦点只对已连接元素生效）。 */
	isConnected(): boolean {
		let node: DomEl | null = this;
		while (node) {
			if (node === this.ownerDocument.documentElement) {
				return true;
			}
			node = node.parentNode;
		}
		return false;
	}

	/** 可聚焦且已连接才移动 activeElement；否则 no-op（activeElement 保持原值）。 */
	focus(_options?: { preventScroll?: boolean }): void {
		const focusable = this.isFocusable();
		const connected = this.isConnected();
		this.ownerDocument.noteFocusAttempt(this, focusable, connected);
		if (!focusable || !connected) {
			return;
		}
		this.ownerDocument.activeElement = this;
	}

	blur(): void {
		if (this.ownerDocument.activeElement === this) {
			this.ownerDocument.activeElement = this.ownerDocument.body;
		}
	}

	// ---- 查询 ----
	querySelectorAll(selector: string): DomEl[] {
		return matchAllFrom(this, selector);
	}

	querySelector(selector: string): DomEl | null {
		return this.querySelectorAll(selector)[0] ?? null;
	}
}

function isDescendantOf(root: DomEl, node: DomEl | null): boolean {
	let current = node;
	while (current) {
		if (current === root) {
			return true;
		}
		current = current.parentNode;
	}
	return false;
}

class StubDocument {
	readonly documentElement = new DomEl("html", this);
	readonly body = new DomEl("body", this);
	activeElement: DomEl;
	visibilityState = "visible";
	readonly listeners = new Map<string, Array<(event: StubEvent) => void>>();
	window!: WindowStub;
	readonly focusAttemptLog: FocusAttempt[] = [];

	constructor() {
		this.documentElement.appendChild(this.body);
		this.activeElement = this.body;
	}

	createElement(tag: string): DomEl {
		return new DomEl(tag, this);
	}

	createTextNode(text: string): DomEl {
		const node = new DomEl("#text", this);
		node.nodeType = 3;
		node.textValue = String(text);
		return node;
	}

	createDocumentFragment(): DomEl {
		const node = new DomEl("#fragment", this);
		node.nodeType = 11;
		return node;
	}

	getElementById(id: string): DomEl | null {
		for (const el of iterateElements(this.documentElement)) {
			if (el.getAttribute("id") === id) {
				return el;
			}
		}
		return null;
	}

	querySelectorAll(selector: string): DomEl[] {
		return matchAllFrom(this.documentElement, selector);
	}

	querySelector(selector: string): DomEl | null {
		return this.querySelectorAll(selector)[0] ?? null;
	}

	addEventListener(type: string, listener: (event: StubEvent) => void): void {
		const bucket = this.listeners.get(type) ?? [];
		bucket.push(listener);
		this.listeners.set(type, bucket);
	}

	/** 记录一次 focus() 调用（focusable / tabindex 为调用瞬间快照）。 */
	noteFocusAttempt(el: DomEl, focusable: boolean, connected: boolean): void {
		this.focusAttemptLog.push({ el, focusable, connected, tabindexAtCall: el.getAttribute("tabindex") });
	}

	/** 全部 focus() 调用记录（时序证据；测试可先取长度再断言增量）。 */
	focusAttempts(): FocusAttempt[] {
		return this.focusAttemptLog.slice();
	}

	emit(event: StubEvent): void {
		for (const listener of (this.listeners.get(event.type) ?? []).slice()) {
			listener.call(this, event);
		}
		if (this.window) {
			this.window.emit(event);
		}
	}
}

class WindowStub {
	innerWidth = 1280;
	innerHeight = 800;
	readonly listeners = new Map<string, Array<(event: StubEvent) => void>>();

	addEventListener(type: string, listener: (event: StubEvent) => void): void {
		const bucket = this.listeners.get(type) ?? [];
		bucket.push(listener);
		this.listeners.set(type, bucket);
	}

	removeEventListener(type: string, listener: (event: StubEvent) => void): void {
		const bucket = this.listeners.get(type) ?? [];
		this.listeners.set(
			type,
			bucket.filter((entry) => entry !== listener),
		);
	}

	emit(event: StubEvent): void {
		for (const listener of (this.listeners.get(event.type) ?? []).slice()) {
			listener.call(this, event);
		}
	}
}

// ---------------------------------------------------------------------------
// 页面骨架 + 环境 stub + 控制 API
// ---------------------------------------------------------------------------

/** 裸 "#" 归一为 ""（浏览器里空 fragment 的 location.hash 就是 ""）。 */
function normalizeFragment(raw: string): string {
	const value = String(raw);
	if (value === "") {
		return "";
	}
	const body = value.startsWith("#") ? value.slice(1) : value;
	return body === "" ? "" : "#" + body;
}

/** 主脚本 = PAGE_HTML 里最后一个 <script> 块（vendor 段在前，不执行）。 */
const MAIN_SCRIPT = (() => {
	const blocks = Array.from(PAGE_HTML.matchAll(/<script>([\s\S]*?)<\/script>/g), (match) => match[1]);
	if (blocks.length === 0) {
		throw new Error("page-dom-harness: no <script> block found in PAGE_HTML");
	}
	return blocks[blocks.length - 1] as string;
})();

export interface ApiStub {
	status?: number;
	body?: unknown;
	etag?: string | null;
}

export interface PageDomHarnessOptions {
	/** boot 前的初始 location.hash（默认 ""，即根列表）。 */
	hash?: string;
	/** location.search（token 走 ?t=，默认空）。 */
	search?: string;
}

export interface CrumbState {
	hidden: boolean;
	/** #crumbs 内 aria-current="page" 的当前段文本；无则 null。 */
	currentLabel: string | null;
	text: string;
}

export interface PageDomHarness {
	/** 执行主脚本（页面 boot() 立即运行），排干微任务后返回。tree 为 /api/tree 应答体（{apiVersion,nodes,...}）。 */
	boot(tree?: unknown): Promise<void>;
	/** 覆盖某 pathname 的 fetch 应答（默认 /api/tree、/api/session、/api/path 各有兜底）。 */
	setApi(pathname: string, api: ApiStub): void;
	/** 点击某 taskId 的 .node 行（面板切换/导航均走真实 click 监听器）。 */
	clickRow(taskId: string): void;
	/** 对某行派发 keydown（如 "Enter" / " "）。 */
	pressRow(taskId: string, key: string): void;
	/** 直接 focus 某行（roving tabindex 行的键盘焦点语义）。 */
	focusRow(taskId: string): void;
	/** 直接 focus 第 index 个 .node 行（taskless 行也适用；不可聚焦时 focus() 为 no-op）。 */
	focusRowAt(index: number): void;
	/** 写 location.hash 并触发 hashchange 监听（route 守卫的真实入口）。 */
	fireHashChange(hash: string): Promise<void>;
	/** 推进假时钟（TREE_EVERY 档）并触发一次 setInterval 回调（tick → refreshTree → fetch → renderTree）。 */
	advanceTreePoll(): Promise<void>;
	/** 只推进假时钟，不触发 tick。 */
	advanceMs(ms: number): void;
	rowIds(): string[];
	/** 树上 .node 行的总数（含 taskId 为空的行，rowIds() 会滤掉它们）。 */
	rowCount(): number;
	/** 按树序取第 index 个 .node-group 里的 .node 行；越界抛错并给出实际行数。 */
	rowAt(index: number): DomEl;
	/** 点击第 index 行（与 clickRow 同一真实 click 监听器，用于 taskId 为空的行）。 */
	clickRowAt(index: number): void;
	/** 对第 index 行派发 keydown（与 pressRow 同一真实 keydown 监听器）。 */
	pressRowAt(index: number, key: string): void;
	/** 第 index 个 .node-group 内的 .node-error 面板；该行无面板返回 null。 */
	panelAt(index: number): DomEl | null;
	/** 全树 .node-error 中 hidden === false 的数量（「至多一块展开」读数）。 */
	openPanelCount(): number;
	rowFor(taskId: string): DomEl | null;
	activeRowTaskId(): string | null;
	/** 该行下方的 .node-error 面板（与行同属一个 .node-group）；无面板/无行返回 null。 */
	panelFor(taskId: string): DomEl | null;
	/** document.activeElement（须仍连接在文档树内）对应的 .node 行 taskId；否则 null。 */
	activeElementTaskId(): string | null;
	/** document.activeElement 对应的树内 .node 行（不是树内行 / 已摘出文档树时 null）。 */
	activeElementRow(): DomEl | null;
	/** 任意 .node 行的跨重建稳定标识：data-panel-key → 非空 data-task-id → .task-line 文本；无标识 null。 */
	rowIdentity(row: DomEl | null): string | null;
	/** 按调用顺序返回全部 focus() 调用记录（focusable/tabindex 为调用瞬间快照）。 */
	focusAttempts(): FocusAttempt[];
	/** 按其 .node-error 的 .text 逐字文本定位行（跨重建稳定寻址；复合键碰撞行只能靠面板文本区分）。 */
	rowForPanelText(errorText: string): DomEl | null;
	treeScrollTop(): number;
	setTreeScrollTop(value: number): void;
	hash(): string;
	crumbState(): CrumbState;
	transcriptChildren(): DomEl[];
	transcriptText(): string;
	hasEmptyState(): boolean;
	requests(): string[];
	byId(id: string): DomEl | null;
	setRect(id: string, rect: Partial<DomEl["rect"]>): void;
	document: StubDocument;
}

const DEFAULT_API: Record<string, ApiStub> = {
	"/api/tree": { status: 200, body: { apiVersion: 2, nodes: [], truncated: { dropped: 0 } } },
	"/api/session": {
		status: 200,
		body: { apiVersion: 2, entries: [], nextOffset: 0, truncatedBefore: true, links: [] },
	},
	"/api/path": { status: 200, body: { found: true, path: [], node: null } },
};

async function drainMicrotasks(): Promise<void> {
	await new Promise<void>((resolve) => setImmediate(resolve));
	await new Promise<void>((resolve) => setImmediate(resolve));
}

export function createPageDomHarness(options: PageDomHarnessOptions = {}): PageDomHarness {
	const doc = new StubDocument();
	const windowStub = new WindowStub();
	doc.window = windowStub;

	// ---- 页面骨架（id / class 与 PAGE_HTML 的 <body> 对应，保证元素可连接） ----
	const html = doc.documentElement;
	const body = doc.body;
	const append = (parent: DomEl, tag: string, className: string | null, id: string | null): DomEl => {
		const el = doc.createElement(tag);
		if (className) {
			el.className = className;
		}
		if (id) {
			el.setAttribute("id", id);
		}
		parent.appendChild(el);
		return el;
	};
	const bannerEl = append(body, "div", "banner", "banner");
	bannerEl.hidden = true;
	const topbar = append(body, "header", "topbar", null);
	append(topbar, "div", "last-update", "last-update");
	const layoutEl = append(body, "main", "layout", null);
	const treeAside = append(layoutEl, "aside", "tree", "tree");
	const sidebarHead = append(treeAside, "div", "sidebar-head", null);
	const sidebarActions = append(sidebarHead, "div", "sidebar-actions", null);
	append(sidebarActions, "button", "icon-btn", "sidebar-collapse");
	const truncatedEl = append(treeAside, "div", "truncated-note", "truncated-note");
	truncatedEl.hidden = true;
	const treeEl = append(treeAside, "div", "tree-list", "tree-list");
	append(layoutEl, "div", "splitter", "splitter");
	const sidebarExpandEl = append(layoutEl, "button", "icon-btn sidebar-expand", "sidebar-expand");
	sidebarExpandEl.hidden = true;
	const transcriptWrap = append(layoutEl, "section", "transcript-wrap", null);
	const crumbsEl = append(transcriptWrap, "nav", "crumbs", "crumbs");
	crumbsEl.hidden = true;
	const transcriptHead = append(transcriptWrap, "div", "transcript-head", null);
	append(transcriptHead, "div", "pill", "status");
	const transcriptEl = append(transcriptWrap, "section", "transcript", "transcript");
	const newContentEl = append(body, "button", "new-content", "new-content");
	newContentEl.hidden = true;

	// ---- 几何默认值：容器非零高度、可注入；滚动量级使 clamp 不参与读数 ----
	treeEl.rect = { top: 0, bottom: 400, left: 0, right: 280, width: 280, height: 400 };
	treeEl.scrollHeight = 1000;
	treeEl.clientHeight = 400;
	transcriptEl.rect = { top: 0, bottom: 400, left: 0, right: 900, width: 900, height: 400 };
	transcriptEl.scrollHeight = 800;
	transcriptEl.clientHeight = 400;
	layoutEl.rect = { top: 0, bottom: 800, left: 0, right: 1280, width: 1280, height: 800 };

	// ---- 环境 stub ----
	const clock = { now: 1_700_000_000_000 };
	let nextTimerId = 0;
	const timeouts = new Map<number, { fn: () => void }>();
	const intervals = new Map<number, { fn: () => void }>();
	const storage = new Map<string, string>();
	const localStorageStub = {
		getItem: (key: string): string | null => (storage.has(key) ? (storage.get(key) as string) : null),
		setItem: (key: string, value: string): void => {
			storage.set(key, String(value));
		},
		removeItem: (key: string): void => {
			storage.delete(key);
		},
		clear: (): void => {
			storage.clear();
		},
	};
	const locationStub = {
		search: options.search ?? "",
		_fragment: normalizeFragment(options.hash ?? ""),
		get hash(): string {
			return this._fragment;
		},
		set hash(value: string) {
			this._fragment = normalizeFragment(value);
		},
	};
	const api: Record<string, ApiStub> = {};
	const requestLog: string[] = [];
	const fetchStub = async (url: string): Promise<{
		ok: boolean;
		status: number;
		headers: { get(name: string): string | null };
		json(): Promise<unknown>;
		blob(): Promise<unknown>;
	}> => {
		const pathname = String(url).split("?")[0] as string;
		requestLog.push(pathname);
		const responder = api[pathname] ?? DEFAULT_API[pathname];
		if (!responder) {
			return {
				ok: false,
				status: 404,
				headers: { get: (): string | null => null },
				json: async (): Promise<unknown> => ({}),
				blob: async (): Promise<unknown> => ({}),
			};
		}
		const status = responder.status ?? 200;
		return {
			ok: status >= 200 && status < 300,
			status,
			headers: {
				get: (name: string): string | null => (name === "ETag" ? responder.etag ?? null : null),
			},
			json: async (): Promise<unknown> => responder.body,
			blob: async (): Promise<unknown> => ({}),
		};
	};

	const sandbox: Record<string, unknown> = {
		document: doc,
		window: windowStub,
		location: locationStub,
		localStorage: localStorageStub,
		fetch: fetchStub,
		setTimeout: (fn: () => void): number => {
			const id = (nextTimerId += 1);
			timeouts.set(id, { fn });
			return id;
		},
		clearTimeout: (id: number): void => {
			timeouts.delete(id);
		},
		setInterval: (fn: () => void): number => {
			const id = (nextTimerId += 1);
			intervals.set(id, { fn });
			return id;
		},
		clearInterval: (id: number): void => {
			intervals.delete(id);
		},
		AbortController: globalThis.AbortController,
		URLSearchParams: globalThis.URLSearchParams,
		URL: globalThis.URL,
		Date: { now: (): number => clock.now },
		marked: { parse: (value: unknown): string => String(value) },
		console,
	};
	const context = createContext(sandbox);

	// ---- 控制 API ----
	let booted = false;

	const rowFor = (taskId: string): DomEl | null =>
		treeEl.querySelectorAll(".node").find((row) => row.dataset.taskId === taskId) ?? null;

	const rowAt = (index: number): DomEl => {
		const rows = treeEl.querySelectorAll(".node");
		const row = rows[index];
		if (!row) {
			throw new Error(`page-dom-harness: no .node row at index ${index} (rowCount: ${rows.length})`);
		}
		return row;
	};

	const panelAt = (index: number): DomEl | null => {
		const group = rowAt(index).parentNode;
		return group ? group.querySelector(".node-error") : null;
	};

	const harness: PageDomHarness = {
		async boot(tree?: unknown): Promise<void> {
			if (booted) {
				throw new Error("page-dom-harness: boot() called twice");
			}
			booted = true;
			if (tree !== undefined) {
				harness.setApi("/api/tree", { status: 200, body: tree });
			}
			runInContext(MAIN_SCRIPT, context, { filename: "page-main-script.js" });
			await drainMicrotasks();
		},

		setApi(pathname: string, stub: ApiStub): void {
			api[pathname] = stub;
		},

		clickRow(taskId: string): void {
			const row = rowFor(taskId);
			if (!row) {
				throw new Error(`page-dom-harness: no .node row for taskId "${taskId}" (rows: ${harness.rowIds().join(", ")})`);
			}
			row.dispatch(makeEvent("click"));
		},

		pressRow(taskId: string, key: string): void {
			const row = rowFor(taskId);
			if (!row) {
				throw new Error(`page-dom-harness: no .node row for taskId "${taskId}" (rows: ${harness.rowIds().join(", ")})`);
			}
			row.dispatch(makeEvent("keydown", { key }));
		},

		focusRow(taskId: string): void {
			const row = rowFor(taskId);
			if (!row) {
				throw new Error(`page-dom-harness: no .node row for taskId "${taskId}" (rows: ${harness.rowIds().join(", ")})`);
			}
			row.focus();
		},

		focusRowAt(index: number): void {
			rowAt(index).focus();
		},

		async fireHashChange(hash: string): Promise<void> {
			locationStub.hash = hash;
			windowStub.emit(makeEvent("hashchange"));
			await drainMicrotasks();
		},

		async advanceTreePoll(): Promise<void> {
			// TREE_EVERY = 3s：推进 4s 保证 refreshTree 的时间门打开。
			clock.now += 4000;
			for (const timer of Array.from(intervals.values())) {
				timer.fn();
			}
			await drainMicrotasks();
		},

		advanceMs(ms: number): void {
			clock.now += ms;
		},

		rowIds(): string[] {
			return treeEl
				.querySelectorAll(".node")
				.map((row) => String(row.dataset.taskId))
				.filter((id) => id !== "");
		},

		rowCount(): number {
			return treeEl.querySelectorAll(".node").length;
		},

		rowAt,

		clickRowAt(index: number): void {
			rowAt(index).dispatch(makeEvent("click"));
		},

		pressRowAt(index: number, key: string): void {
			rowAt(index).dispatch(makeEvent("keydown", { key }));
		},

		panelAt,

		openPanelCount(): number {
			return treeEl.querySelectorAll(".node-error").filter((panel) => panel.hidden === false).length;
		},

		rowFor,

		activeRowTaskId(): string | null {
			const row = treeEl.querySelectorAll(".node").find((candidate) => candidate.classList.contains("active")) ?? null;
			return row ? String(row.dataset.taskId) : null;
		},

		panelFor(taskId: string): DomEl | null {
			const row = rowFor(taskId);
			if (!row || !row.parentNode) {
				return null;
			}
			return row.parentNode.querySelector(".node-error");
		},

		activeElementTaskId(): string | null {
			const active = doc.activeElement;
			if (!active || active.nodeType !== 1 || !isDescendantOf(html, active)) {
				return null;
			}
			if (!active.classList.contains("node")) {
				return null;
			}
			const id = active.dataset.taskId;
			return typeof id === "string" && id !== "" ? id : null;
		},

		activeElementRow(): DomEl | null {
			const active = doc.activeElement;
			if (!active || active.nodeType !== 1 || !isDescendantOf(html, active)) {
				return null;
			}
			return active.classList.contains("node") ? active : null;
		},

		rowIdentity(row: DomEl | null): string | null {
			if (!row || row.nodeType !== 1 || !row.classList.contains("node")) {
				return null;
			}
			const panelKey = row.dataset.panelKey;
			if (typeof panelKey === "string" && panelKey !== "") {
				return "panel:" + panelKey;
			}
			const taskId = row.dataset.taskId;
			if (typeof taskId === "string" && taskId !== "") {
				return "task:" + taskId;
			}
			const taskLine = row.querySelector(".task-line");
			const text = taskLine ? taskLine.textContent : "";
			return text !== "" ? "taskline:" + text : null;
		},

		focusAttempts(): FocusAttempt[] {
			return doc.focusAttempts();
		},

		rowForPanelText(errorText: string): DomEl | null {
			return (
				treeEl.querySelectorAll(".node").find((row) => {
					const panel = row.parentNode ? row.parentNode.querySelector(".node-error") : null;
					const text = panel ? panel.querySelector(".text") : null;
					return text !== null && text.textContent === errorText;
				}) ?? null
			);
		},

		treeScrollTop(): number {
			return treeEl.scrollTop;
		},

		setTreeScrollTop(value: number): void {
			treeEl.scrollTop = value;
		},

		hash(): string {
			return locationStub.hash;
		},

		crumbState(): CrumbState {
			// 容器收起（hidden）即「无当前段」：renderCrumbs 的空任务分支只收起容器、
			// 不清旧子节点，与真浏览器的不可见语义一致。
			if (crumbsEl.hidden) {
				return { hidden: true, currentLabel: null, text: crumbsEl.textContent };
			}
			const current =
				crumbsEl.querySelectorAll("[aria-current]").find((el) => el.getAttribute("aria-current") === "page") ?? null;
			return {
				hidden: crumbsEl.hidden,
				currentLabel: current ? current.textContent : null,
				text: crumbsEl.textContent,
			};
		},

		transcriptChildren(): DomEl[] {
			return transcriptEl.children.slice();
		},

		transcriptText(): string {
			return transcriptEl.textContent;
		},

		hasEmptyState(): boolean {
			return transcriptEl.querySelector(".empty-state") !== null;
		},

		requests(): string[] {
			return requestLog.slice();
		},

		byId(id: string): DomEl | null {
			return doc.getElementById(id);
		},

		setRect(id: string, rect: Partial<DomEl["rect"]>): void {
			const el = doc.getElementById(id);
			if (!el) {
				throw new Error(`page-dom-harness: no element #${id}`);
			}
			el.rect = { ...el.rect, ...rect };
		},

		document: doc,
	};

	return harness;
}
