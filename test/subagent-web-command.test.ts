/**
 * 红阶段测试：`/subagent-web` 命令（在浏览器打开本地 subagent 会话追踪页）。
 * 命令尚未在 src/index.ts 注册，本文件整体红属预期（每个用例在
 * `expect(webCommand).toBeDefined()` 处失败，即「功能缺失」）。
 *
 * 行为契约（验收文案已锁定，文案与 spawn 参数逐字断言）：
 *  1. 注册命令 subagent-web，description 逐字：
 *     "Open the live subagent web view in the browser (usage: /subagent-web [taskId] [--stop] [--no-open])"
 *  2. 无参数（TUI）→ 确保服务启动（调 startWebServer），打开浏览器到
 *     http://127.0.0.1:<port>/?t=<token>#/
 *  3. 带 <taskId>（UUID 形）→ 打开 #/t/<taskId>；taskId 形状非法或会话目录
 *     （<agentDir>/subagent-sessions/<taskId>/）不存在 → warning 通知，
 *     不打开浏览器。
 *  4. --stop → 关闭服务；TUI 通知文案逐字 "Subagent web server stopped."；
 *     非 TUI console.log 同一句；不 spawn。
 *  5. --no-open → 只启动服务，不调打开器（不 spawn），一条含 URL 的通知。
 *  6. 非 TUI（mode "print"/"json"，hasUI:false）→ 启动服务并 console.log
 *     一行，逐字模板："[subagent-web] http://127.0.0.1:<port>/?t=<token>"
 *  7. 打开器按平台分支：
 *     darwin → spawn("open", [url, ...])；linux → spawn("xdg-open", [url])；
 *     win32 → spawn("cmd", ["/c", "start", "", url])；
 *     第三参 { detached: true, stdio: "ignore" } 且对返回对象调用 unref()。
 *  8. spawn 抛错 / 返回对象 emit("error") / 非零退出 → 退回通知 URL，
 *     不抛未捕获异常。
 *  9. Suggestion-8 接线：startWebServer 的 opts.validateTaskId 要么为
 *     undefined，要么对通用 v4 UUID 返回 null（接受）—— 读取路径不得再用 v7
 *     严格校验拒绝历史会话的非 v7 UUID。
 *
 * server 模块接口设定（供实现方对齐，mock 见下方 vi.mock）：
 *   src/web/server.ts 导出：
 *     - startWebServer(opts): Promise<{ port, url, token, close(): Promise<void> }>
 *       （真实模块已如此导出；本测试 mock 返回固定 handle：
 *         { port: 43210, url: "http://127.0.0.1:43210/?t=tok", token: "tok",
 *           close: vi.fn() }，便于逐字断言 URL）
 *     - getGlobalServer(): handle | null —— 返回当前进程内单例（无则 null）。
 *   命令实现约定：无参/--no-open/非 TUI 打开流程用 getGlobalServer() 判断
 *   是否已在运行（本测试在「未运行」状态下发起，因此 startWebServer 必被调用
 *   恰一次）；--stop 通过 getGlobalServer() 取单例并调用其 close()。
 *
 * 模块隔离：沿用 test/subagent-watch.test.ts 的成熟模式 ——
 *   vi.mock("@earendil-works/pi-coding-agent") 覆写 getAgentDir；
 *   vi.mock("node:child_process", () => ({ spawn: vi.fn() }))；
 *   vi.mock("../src/web/server.ts") 提供可控假 startWebServer/getGlobalServer；
 *   vi.resetModules() + 动态 import("../src/index.ts") 保证干净模块实例。
 * 实现方须以 "./web/server.js"（仓库既有 ESM .js 后缀惯例）导入 server 模块，
 * vitest 解析后与本 mock 路径指向同一模块。
 */

import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// ---------------------------------------------------------------------------
// 模块 mock（工厂被 vi.resetModules() 重跑；跨重跑的共享状态放 vi.hoisted）
// ---------------------------------------------------------------------------

/** 跨 mock 工厂重跑存活的 server 单例状态（镜像真实模块的 globalThis 单例语义）。 */
const webState = vi.hoisted(() => ({
	currentServer: null as null | {
		port: number;
		url: string;
		token: string;
		close: ReturnType<typeof vi.fn>;
	},
}));

vi.mock("@earendil-works/pi-coding-agent", async () => {
	const actual = await vi.importActual("@earendil-works/pi-coding-agent");
	return {
		...actual,
		getAgentDir: vi.fn(),
	};
});

vi.mock("node:child_process", () => ({
	spawn: vi.fn(),
}));

vi.mock("../src/web/server.ts", () => ({
	startWebServer: vi.fn(),
	getGlobalServer: vi.fn(() => webState.currentServer),
}));

// ---------------------------------------------------------------------------
// 锁定文案（逐字，来自验收契约）
// ---------------------------------------------------------------------------

const COMMAND_NAME = "subagent-web";
const COMMAND_DESCRIPTION =
	"Open the live subagent web view in the browser (usage: /subagent-web [taskId] [--stop] [--no-open])";
const STOP_MESSAGE = "Subagent web server stopped.";

/** 假服务的固定端口 / token（mock startWebServer 返回值，便于逐字断言 URL）。 */
const PORT = 43210;
const TOKEN = "tok";
const BASE_URL = `http://127.0.0.1:${PORT}/?t=${TOKEN}`;
const HOME_URL = `${BASE_URL}#/`;
const NON_TUI_LOG = `[subagent-web] ${BASE_URL}`;

const SPAWN_OPTIONS = { detached: true, stdio: "ignore" };

// ---------------------------------------------------------------------------
// Helpers（沿用 test/subagent-watch.test.ts 的既有模式）
// ---------------------------------------------------------------------------

/** Create a fake spawned process with a no-op unref(). */
function createFakeProc() {
	const proc = new EventEmitter() as any;
	proc.unref = vi.fn();
	proc.kill = vi.fn(() => true);
	proc.stdout = new EventEmitter();
	proc.stderr = new EventEmitter();
	return proc;
}

/** Build a mock pi object that captures all registration calls. */
function createMockPi() {
	const commandDefs: Map<string, any> = new Map();
	return {
		registerTool: vi.fn(),
		registerCommand: vi.fn((name: string, options: any) => {
			commandDefs.set(name, options);
		}),
		registerMessageRenderer: vi.fn(),
		on: vi.fn(),
		sendMessage: vi.fn(),
		_commandDefs: commandDefs,
	};
}

function createTuiCtx() {
	const notifyMock = vi.fn();
	return {
		ctx: { cwd: "/tmp", hasUI: true, mode: "tui" as const, ui: { notify: notifyMock, setWidget: vi.fn() } },
		notifyMock,
	};
}

function createNonTuiCtx(mode: "print" | "json") {
	const notifyMock = vi.fn();
	return {
		ctx: { cwd: "/tmp", hasUI: false, mode, ui: { notify: notifyMock, setWidget: vi.fn() } },
		notifyMock,
	};
}

/** Pin process.platform to the given value (restored in afterEach). */
function mockPlatform(platform: NodeJS.Platform): void {
	vi.spyOn(process, "platform", "get").mockReturnValue(platform);
}

/** Let pending microtasks + immediates settle (no fake timers in this suite). */
async function flushAsync(rounds = 5): Promise<void> {
	for (let i = 0; i < rounds; i++) {
		await new Promise((r) => setImmediate(r));
	}
}

/** A deterministic UUID-shaped taskId (UUID v7 shape, like subagent-watch tests). */
function makeTaskId(n: number): string {
	return `019ffdd3-3eb5-733d-b481-a53e5292c${String(n).padStart(3, "0")}`;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("/subagent-web 命令（浏览器打开本地 subagent 会话追踪页）", () => {
	let tmpBase: string;
	let agentDir: string;
	let extension: (typeof import("../src/index.ts"))["default"];
	let webCommand: any;
	let webMod: (typeof import("../src/web/server.ts"));
	let spawnMock: ReturnType<typeof vi.fn>;
	let allProcs: any[];

	beforeEach(async () => {
		// 模块级状态隔离：干净模块实例（mock 工厂随之重跑，需重新取引用配置）
		vi.resetModules();

		tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "subagent-web-cmd-test-"));
		agentDir = path.join(tmpBase, "agent-dir");
		fs.mkdirSync(agentDir, { recursive: true });

		const piPkg = await import("@earendil-works/pi-coding-agent");
		vi.mocked(piPkg.getAgentDir).mockReturnValue(agentDir);

		const cp = await import("node:child_process");
		spawnMock = vi.mocked(cp.spawn);
		allProcs = [];
		spawnMock.mockImplementation((() => {
			const proc = createFakeProc();
			allProcs.push(proc);
			return proc;
		}) as any);

		// 假 server 模块：startWebServer 返回固定 handle 并写入单例状态；
		// getGlobalServer 读同一状态（close 后归零，镜像真实单例语义）
		webState.currentServer = null;
		webMod = await import("../src/web/server.ts");
		vi.mocked(webMod.startWebServer).mockImplementation(async () => {
			const handle = {
				port: PORT,
				url: BASE_URL,
				token: TOKEN,
				close: vi.fn(async () => {
					webState.currentServer = null;
				}),
			};
			webState.currentServer = handle;
			return handle;
		});

		// 加载扩展并取出 subagent-web 命令定义
		const mod = await import("../src/index.ts");
		extension = mod.default;
		const pi = createMockPi();
		extension(pi as any);
		webCommand = pi._commandDefs.get(COMMAND_NAME);
	});

	afterEach(() => {
		webState.currentServer = null;
		fs.rmSync(tmpBase, { recursive: true, force: true });
		vi.restoreAllMocks();
		vi.clearAllMocks();
	});

	// ================================================================
	// 用例 1 — 命令注册
	// ================================================================
	describe("用例 1 — 命令注册", () => {
		it("should register the subagent-web command with the exact locked description", () => {
			expect(webCommand, "功能缺失：未注册 subagent-web 命令").toBeDefined();
			expect(webCommand.description).toBe(COMMAND_DESCRIPTION);
		});
	});

	// ================================================================
	// 用例 2 — 无参数（TUI）：确保服务启动 + 打开器按平台分支
	// ================================================================
	describe("用例 2 — 无参数（TUI）", () => {
		it("should ensure the web server is started (startWebServer called once) when opened with no arguments", async () => {
			expect(webCommand, "功能缺失：未注册 subagent-web 命令").toBeDefined();
			const { ctx } = createTuiCtx();

			await webCommand.handler("", ctx);

			expect(vi.mocked(webMod.startWebServer), "无参打开应确保服务启动").toHaveBeenCalledTimes(1);
		});

		it("should open the browser with 'open' and the home URL (#/) on darwin, detached and unref'd", async () => {
			expect(webCommand, "功能缺失：未注册 subagent-web 命令").toBeDefined();
			mockPlatform("darwin");
			const { ctx } = createTuiCtx();

			await webCommand.handler("", ctx);

			expect(spawnMock, "无参打开应调用平台打开器").toHaveBeenCalledTimes(1);
			const [cmd, args, opts] = spawnMock.mock.calls[0] as any[];
			expect(cmd).toBe("open");
			expect(args[0], "打开 URL 应为 http://127.0.0.1:<port>/?t=<token>#/").toBe(HOME_URL);
			expect(args[0]).toContain("#/");
			expect(opts).toEqual(SPAWN_OPTIONS);
			expect(allProcs[0].unref, "打开器进程应 unref").toHaveBeenCalled();
		});

		it("should open the browser with 'xdg-open' and the exact URL on linux", async () => {
			expect(webCommand, "功能缺失：未注册 subagent-web 命令").toBeDefined();
			mockPlatform("linux");
			const { ctx } = createTuiCtx();

			await webCommand.handler("", ctx);

			expect(spawnMock).toHaveBeenCalledTimes(1);
			expect(spawnMock.mock.calls[0][0]).toBe("xdg-open");
			expect(spawnMock.mock.calls[0][1]).toEqual([HOME_URL]);
			expect(spawnMock.mock.calls[0][2]).toEqual(SPAWN_OPTIONS);
		});

		it("should open the browser with 'cmd /c start' and the exact URL on win32", async () => {
			expect(webCommand, "功能缺失：未注册 subagent-web 命令").toBeDefined();
			mockPlatform("win32");
			const { ctx } = createTuiCtx();

			await webCommand.handler("", ctx);

			expect(spawnMock).toHaveBeenCalledTimes(1);
			expect(spawnMock.mock.calls[0][0]).toBe("cmd");
			expect(spawnMock.mock.calls[0][1]).toEqual(["/c", "start", "", HOME_URL]);
			expect(spawnMock.mock.calls[0][2]).toEqual(SPAWN_OPTIONS);
		});
	});

	// ================================================================
	// 用例 3 — --stop：关闭服务，不 spawn
	// ================================================================
	describe("用例 3 — --stop", () => {
		it("should close the running server, notify with the exact locked message and not spawn (TUI)", async () => {
			expect(webCommand, "功能缺失：未注册 subagent-web 命令").toBeDefined();
			// Arrange: 一个正在运行的服务单例
			await vi.mocked(webMod.startWebServer)({} as any);
			const handle = webState.currentServer!;
			expect(handle, "应已就绪一个运行中的服务单例").not.toBeNull();
			vi.mocked(webMod.startWebServer).mockClear(); // Arrange 调用不计入断言
			const { ctx, notifyMock } = createTuiCtx();

			// Act
			await webCommand.handler("--stop", ctx);

			// Assert
			expect(vi.mocked(webMod.startWebServer), "--stop 不应再启动服务").not.toHaveBeenCalled();
			expect(handle.close, "--stop 应关闭正在运行的服务").toHaveBeenCalledTimes(1);
			expect(spawnMock, "--stop 不应调用打开器").not.toHaveBeenCalled();
			expect(notifyMock).toHaveBeenCalledTimes(1);
			expect(notifyMock.mock.calls[0][0]).toBe(STOP_MESSAGE);
		});

		it("should log the exact locked message and not spawn in non-TUI mode", async () => {
			expect(webCommand, "功能缺失：未注册 subagent-web 命令").toBeDefined();
			// Arrange: 一个正在运行的服务单例 + 非 TUI ctx
			await vi.mocked(webMod.startWebServer)({} as any);
			const handle = webState.currentServer!;
			vi.mocked(webMod.startWebServer).mockClear(); // Arrange 调用不计入断言
			const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
			const { ctx } = createNonTuiCtx("print");

			// Act
			await webCommand.handler("--stop", ctx);

			// Assert
			expect(handle.close).toHaveBeenCalledTimes(1);
			expect(spawnMock, "--stop 不应调用打开器").not.toHaveBeenCalled();
			expect(logSpy).toHaveBeenCalledTimes(1);
			expect(logSpy).toHaveBeenCalledWith(STOP_MESSAGE);
		});
	});

	// ================================================================
	// 用例 4 — --no-open：只启动服务
	// ================================================================
	describe("用例 4 — --no-open", () => {
		it("should start the web server, never spawn the opener, and notify a message containing the URL", async () => {
			expect(webCommand, "功能缺失：未注册 subagent-web 命令").toBeDefined();
			const { ctx, notifyMock } = createTuiCtx();

			await webCommand.handler("--no-open", ctx);

			expect(vi.mocked(webMod.startWebServer)).toHaveBeenCalledTimes(1);
			expect(spawnMock, "--no-open 不应调用打开器").not.toHaveBeenCalled();
			expect(
				notifyMock.mock.calls.some((c: any[]) => String(c[0]).includes(BASE_URL)),
				"--no-open 应有一条含 URL 的通知",
			).toBe(true);
		});
	});

	// ================================================================
	// 用例 5 — 非 TUI 模式：启动服务 + 逐字 console.log
	// ================================================================
	describe("用例 5 — 非 TUI 模式", () => {
		it("should start the server and log the exact locked URL line in print mode", async () => {
			expect(webCommand, "功能缺失：未注册 subagent-web 命令").toBeDefined();
			const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
			const { ctx } = createNonTuiCtx("print");

			await webCommand.handler("", ctx);

			expect(vi.mocked(webMod.startWebServer), "非 TUI 无参应启动服务").toHaveBeenCalledTimes(1);
			expect(logSpy).toHaveBeenCalledTimes(1);
			expect(logSpy).toHaveBeenCalledWith(NON_TUI_LOG);
		});

		it("should log the exact locked line with the task fragment when called in print mode with a valid taskId", async () => {
			expect(webCommand, "功能缺失：未注册 subagent-web 命令").toBeDefined();
			const taskId = makeTaskId(501);
			fs.mkdirSync(path.join(agentDir, "subagent-sessions", taskId), { recursive: true });
			const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
			const { ctx } = createNonTuiCtx("print");

			await webCommand.handler(taskId, ctx);

			expect(logSpy).toHaveBeenCalledTimes(1);
			expect(logSpy.mock.calls[0][0]).toBe(`[subagent-web] ${BASE_URL}#/t/${taskId}`);
		});

		it("should start the server and log the exact locked URL line in json mode", async () => {
			expect(webCommand, "功能缺失：未注册 subagent-web 命令").toBeDefined();
			const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
			const { ctx } = createNonTuiCtx("json");

			await webCommand.handler("", ctx);

			expect(vi.mocked(webMod.startWebServer), "非 TUI 无参应启动服务").toHaveBeenCalledTimes(1);
			expect(logSpy).toHaveBeenCalledTimes(1);
			expect(logSpy).toHaveBeenCalledWith(NON_TUI_LOG);
		});
	});

	// ================================================================
	// 用例 6 — 带合法 UUID taskId：打开 #/t/<taskId>
	// ================================================================
	describe("用例 6 — 带合法 UUID taskId", () => {
		it("should open the browser to the task route #/t/<taskId> when the session directory exists", async () => {
			expect(webCommand, "功能缺失：未注册 subagent-web 命令").toBeDefined();
			mockPlatform("darwin");
			const taskId = makeTaskId(601);
			fs.mkdirSync(path.join(agentDir, "subagent-sessions", taskId), { recursive: true });
			const { ctx } = createTuiCtx();

			await webCommand.handler(taskId, ctx);

			expect(spawnMock).toHaveBeenCalledTimes(1);
			expect(spawnMock.mock.calls[0][0]).toBe("open");
			expect(spawnMock.mock.calls[0][1][0], "打开 URL 应为 base#/t/<taskId>").toBe(`${BASE_URL}#/t/${taskId}`);
			expect(spawnMock.mock.calls[0][2]).toEqual(SPAWN_OPTIONS);
			expect(allProcs[0].unref, "打开器进程应 unref").toHaveBeenCalled();
		});
	});

	// ================================================================
	// 用例 7 — 非法 taskId：warning 通知，不打开浏览器
	// ================================================================
	describe("用例 7 — 非法 taskId", () => {
		it("should warn and not spawn when the taskId is not UUID-shaped", async () => {
			expect(webCommand, "功能缺失：未注册 subagent-web 命令").toBeDefined();
			const { ctx, notifyMock } = createTuiCtx();

			await webCommand.handler("not-a-uuid", ctx);

			expect(spawnMock, "非法 taskId 不应打开浏览器").not.toHaveBeenCalled();
			expect(notifyMock).toHaveBeenCalledTimes(1);
			expect(notifyMock).toHaveBeenCalledWith(expect.any(String), "warning");
		});

		it("should console.warn the same warning text as the TUI path and not spawn in non-TUI mode", async () => {
			expect(webCommand, "功能缺失：未注册 subagent-web 命令").toBeDefined();
			const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
			const { ctx } = createNonTuiCtx("print");

			await webCommand.handler("not-a-uuid", ctx);

			// 文案与 TUI 路径的 warning 通知同句（src/index.ts：`No subagent session found for taskId: ${taskId}`）
			expect(warnSpy, "非 TUI 非法 taskId 必须有可见警告").toHaveBeenCalledTimes(1);
			expect(warnSpy.mock.calls[0][0]).toBe("No subagent session found for taskId: not-a-uuid");
			expect(spawnMock, "非法 taskId 不应打开浏览器").not.toHaveBeenCalled();
		});

		it("should warn and not spawn when the session directory for a UUID-shaped taskId does not exist", async () => {
			expect(webCommand, "功能缺失：未注册 subagent-web 命令").toBeDefined();
			const taskId = makeTaskId(701); // 目录未创建
			const { ctx, notifyMock } = createTuiCtx();

			await webCommand.handler(taskId, ctx);

			expect(spawnMock, "会话目录不存在时不应打开浏览器").not.toHaveBeenCalled();
			expect(notifyMock).toHaveBeenCalledTimes(1);
			expect(notifyMock).toHaveBeenCalledWith(expect.any(String), "warning");
		});
	});

	// ================================================================
	// 用例 8 — 打开器失败：退回通知 URL，不抛未捕获异常
	// ================================================================
	describe("用例 8 — 打开器失败回退", () => {
		it("should fall back to notifying the URL when spawn throws synchronously", async () => {
			expect(webCommand, "功能缺失：未注册 subagent-web 命令").toBeDefined();
			spawnMock.mockImplementation((() => {
				throw new Error("spawn failed");
			}) as any);
			const { ctx, notifyMock } = createTuiCtx();

			// 不抛未捕获异常（若 handler 抛出，此处直接失败）
			await webCommand.handler("", ctx);

			expect(
				notifyMock.mock.calls.some((c: any[]) => String(c[0]).includes(BASE_URL)),
				"spawn 抛错应退回通知 URL",
			).toBe(true);
		});

		it("should fall back to notifying the URL when the spawned process emits 'error'", async () => {
			expect(webCommand, "功能缺失：未注册 subagent-web 命令").toBeDefined();
			const { ctx, notifyMock } = createTuiCtx();

			const handlerPromise = webCommand.handler("", ctx);
			await flushAsync();
			expect(allProcs.length, "打开器应已被 spawn").toBe(1);
			allProcs[0].emit("error", new Error("ENOENT"));
			await handlerPromise;
			await flushAsync();

			expect(
				notifyMock.mock.calls.some((c: any[]) => String(c[0]).includes(BASE_URL)),
				"打开器 error 事件应退回通知 URL",
			).toBe(true);
		});

		it("should notify the fallback URL exactly once when the process emits both 'error' and a non-zero 'exit'", async () => {
			expect(webCommand, "功能缺失：未注册 subagent-web 命令").toBeDefined();
			const { ctx, notifyMock } = createTuiCtx();

			const handlerPromise = webCommand.handler("", ctx);
			await flushAsync();
			expect(allProcs.length, "打开器应已被 spawn").toBe(1);
			allProcs[0].emit("error", new Error("ENOENT"));
			allProcs[0].emit("exit", 1, null);
			await handlerPromise;
			await flushAsync();

			expect(notifyMock, "error + 非零 exit 双触发只允许一条回退通知").toHaveBeenCalledTimes(1);
			expect(notifyMock.mock.calls[0][0]).toBe(`Could not open the browser — open this URL manually: ${HOME_URL}`);
			expect(String(notifyMock.mock.calls[0][0])).toContain(BASE_URL);
		});

		it("should fall back to notifying the URL when the spawned process exits non-zero", async () => {
			expect(webCommand, "功能缺失：未注册 subagent-web 命令").toBeDefined();
			const { ctx, notifyMock } = createTuiCtx();

			const handlerPromise = webCommand.handler("", ctx);
			await flushAsync();
			expect(allProcs.length, "打开器应已被 spawn").toBe(1);
			allProcs[0].emit("exit", 1, null);
			allProcs[0].emit("close", 1, null);
			await handlerPromise;
			await flushAsync();

			expect(
				notifyMock.mock.calls.some((c: any[]) => String(c[0]).includes(BASE_URL)),
				"非零退出应退回通知 URL",
			).toBe(true);
		});
	});

	// ================================================================
	// 用例 9 — Suggestion-8 接线：validateTaskId 接受通用 UUID
	// ================================================================
	describe("用例 9 — validateTaskId 接受通用 UUID", () => {
		it("should pass a validator that accepts a generic v4 UUID when starting the web server", async () => {
			expect(webCommand, "功能缺失：未注册 subagent-web 命令").toBeDefined();
			const { ctx } = createTuiCtx();

			// Act: 无参打开确保服务启动（捕获传入的 opts）
			await webCommand.handler("", ctx);

			// Assert
			expect(vi.mocked(webMod.startWebServer), "无参打开应确保服务启动").toHaveBeenCalledTimes(1);
			const opts = vi.mocked(webMod.startWebServer).mock.calls[0][0] as
				| { validateTaskId?: (taskId: unknown) => string | null }
				| undefined;
			const validateTaskId = opts?.validateTaskId;
			expect(
				validateTaskId === undefined || typeof validateTaskId === "function",
				"opts.validateTaskId 只能是 undefined 或校验函数",
			).toBe(true);
			// 通用 v4 UUID（历史会话形）必须被接受（null = 通过）；undefined = 无校验同样接受
			const genericV4 = "f47ac10b-58cc-4372-a567-0e02b2c3d479";
			const verdict = typeof validateTaskId === "function" ? validateTaskId(genericV4) : null;
			expect(verdict, "读取路径不得用 v7 严格校验拒绝历史会话的非 v7 UUID").toBeNull();
		});
	});
});
