/**
 * Subagent Tool - Delegate tasks to specialized agents
 *
 * Spawns a separate `pi` process for each subagent invocation,
 * giving it an isolated context window.
 *
 * Supports single mode: { agent: "name", task: "..." }
 *
 * Uses JSON mode to capture structured output from subagents.
 *
 * Modified: per-agent skill directory isolation via --no-skills --skill args.
 */

import { spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as crypto from "node:crypto";
import type { Message } from "@earendil-works/pi-ai";
import { StringEnum } from "@earendil-works/pi-ai";
import {
	DynamicBorder,
	type ExtensionAPI,
	type ExtensionContext,
	getMarkdownTheme,
	withFileMutationQueue,
	getAgentDir,
	parseFrontmatter,
} from "@earendil-works/pi-coding-agent";
import { Box, Container, Key, Markdown, matchesKey, SelectList, type SelectItem, Spacer, Text, truncateToWidth, visibleWidth, sliceByColumn } from "@earendil-works/pi-tui";
import { Type } from "typebox";

// ===== UUID v7 helper =====

/** Generate a UUID v7 (timestamp + random) without external dependencies. */
function uuidv7(): string {
	const timestamp = Date.now();
	const rand = crypto.randomBytes(10);
	const bytes = new Uint8Array(16);
	const view = new DataView(bytes.buffer);
	// high 16 bits of the 48-bit millisecond timestamp
	view.setUint16(0, Math.floor(timestamp / 0x100000000));
	// low 32 bits of the 48-bit millisecond timestamp
	view.setUint32(2, timestamp & 0xffffffff);
	// version = 7 (high nibble)
	bytes[6] = (rand[0] & 0x0f) | 0x70;
	bytes[7] = rand[1];
	// variant = 10xxxxxx
	bytes[8] = (rand[2] & 0x3f) | 0x80;
	bytes.set(rand.subarray(3), 9);

	let hex = "";
	for (const b of bytes) {
		hex += b.toString(16).padStart(2, "0");
	}
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

// ===== Inlined agents.ts with skills support =====

type AgentScope = "user" | "project" | "both";

/** Minimal model info for passing current model to subagents */
interface CurrentModel {
	provider: string;
	id: string;
}

interface AgentConfig {
	name: string;
	description: string;
	tools?: string[];
	model?: string;
	thinking?: string;
	skills?: string[];
	systemPrompt: string;
	source: "user" | "project";
	filePath: string;
}

interface AgentDiscoveryResult {
	agents: AgentConfig[];
	projectAgentsDir: string | null;
}

function parseListField(value: unknown): string[] | undefined {
	if (value === undefined || value === null) return undefined;
	if (Array.isArray(value)) {
		return (value as unknown[]).map(s => String(s).trim()).filter(Boolean);
	}
	if (typeof value === "string") {
		return value.split(",").map(s => s.trim()).filter(Boolean);
	}
	return undefined;
}

export function loadAgentsFromDir(dir: string, source: "user" | "project"): AgentConfig[] {
	const agents: AgentConfig[] = [];
	if (!fs.existsSync(dir)) return agents;
	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(dir, { withFileTypes: true });
	} catch {
		return agents;
	}
	for (const entry of entries) {
		if (!entry.name.endsWith(".md")) continue;
		if (!entry.isFile() && !entry.isSymbolicLink()) continue;
		const filePath = path.join(dir, entry.name);
		let content: string;
		try {
			content = fs.readFileSync(filePath, "utf-8");
		} catch {
			continue;
		}
		let frontmatter: Record<string, unknown>;
		let body: string;
		try {
			({ frontmatter, body } = parseFrontmatter<Record<string, unknown>>(content));
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			console.warn(`[async-subagent-isolation] failed to parse frontmatter in ${entry.name}: ${msg.slice(0, 200)}`);
			continue;
		}
		if (typeof frontmatter.name !== "string" || frontmatter.name.trim() === "") {
			console.warn(`[async-subagent-isolation] ${entry.name}: name must be a non-empty string, skipping.`);
			continue;
		}
		if (typeof frontmatter.description !== "string" || frontmatter.description.trim() === "") {
			console.warn(`[async-subagent-isolation] ${entry.name}: description must be a string (watch YAML flow objects like {foo:bar} or null/~), skipping.`);
			continue;
		}
		const tools = parseListField(frontmatter.tools);
		const hasSkills = "skills" in frontmatter;
		const skills = hasSkills ? parseListField(frontmatter.skills) ?? [] : undefined;
		const rawThinking = frontmatter.thinking;
		const thinking =
			typeof rawThinking === "string" && isThinkingLevel(rawThinking)
				? rawThinking
				: undefined;
		agents.push({
			name: frontmatter.name as string,
			description: frontmatter.description as string,
			tools: tools && tools.length > 0 ? tools : undefined,
			model: frontmatter.model as string | undefined,
			thinking,
			skills,
			systemPrompt: body,
			source,
			filePath,
		});
	}
	return agents;
}

function isDirectory(p: string): boolean {
	try {
		return fs.statSync(p).isDirectory();
	} catch {
		return false;
	}
}

function findNearestProjectAgentsDir(cwd: string): string | null {
	let currentDir = cwd;
	while (true) {
		const candidate = path.join(currentDir, ".pi", "agents");
		if (isDirectory(candidate)) return candidate;
		const parentDir = path.dirname(currentDir);
		if (parentDir === currentDir) return null;
		currentDir = parentDir;
	}
}

// ===== Thinking level / model override config =====

const THINKING_LEVELS = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);

/** Check whether a value is a valid thinking level (case-sensitive). */
export function isThinkingLevel(value: string): boolean {
	return typeof value === "string" && THINKING_LEVELS.has(value);
}

export interface ModelOverride {
	model?: string;
	thinking?: string;
}

/**
 * Normalize a raw override value from the config file.
 * - Non-empty string -> { model: value } (legacy format)
 * - Object -> keep only valid `model` (non-empty string) and `thinking`
 *   (valid thinking level) fields
 * - Anything else -> undefined
 */
export function normalizeOverride(value: unknown): ModelOverride | undefined {
	if (typeof value === "string") {
		const trimmed = value.trim();
		return trimmed ? { model: trimmed } : undefined;
	}
	if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
	const record = value as Record<string, unknown>;
	const result: ModelOverride = {};
	if (typeof record.model === "string") {
		const modelTrimmed = record.model.trim();
		if (modelTrimmed) result.model = modelTrimmed;
	}
	if (typeof record.thinking === "string" && isThinkingLevel(record.thinking)) result.thinking = record.thinking;
	return result.model !== undefined || result.thinking !== undefined ? result : undefined;
}

/**
 * Load a single model-overrides JSON file. Returns {} on any error
 * (missing/unreadable file, invalid JSON, or invalid values), logging a
 * warning to help troubleshoot configuration problems.
 */
export function loadModelOverridesFile(filePath: string): Record<string, ModelOverride> {
	try {
		const content = fs.readFileSync(filePath, "utf-8");
		const parsed: unknown = JSON.parse(content);
		if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
			console.warn(`[async-subagent-isolation] ${filePath}: expected a JSON object, ignoring.`);
			return {};
		}
		const overrides: Record<string, ModelOverride> = {};
		for (const [key, value] of Object.entries(parsed)) {
			const normalized = normalizeOverride(value);
			if (normalized) overrides[key] = normalized;
		}
		return overrides;
	} catch (err) {
		if (!(err instanceof Error && "code" in err && err.code === "ENOENT")) {
			console.warn(`[async-subagent-isolation] failed to load ${filePath}: ${err instanceof Error ? err.message : String(err)}`);
		}
		return {};
	}
}

/**
 * Load model overrides from the user-level config
 * (~/.pi/agent/subagent-isolation.json) merged with the nearest project-level
 * config (.pi/subagent-isolation.json found by walking up from cwd).
 * Project-level entries override user-level entries by key.
 */
export function loadModelOverrides(cwd: string): Record<string, ModelOverride> {
	const userOverrides = loadModelOverridesFile(path.join(getAgentDir(), "subagent-isolation.json"));
	let currentDir = cwd;
	while (true) {
		const candidate = path.join(currentDir, ".pi", "subagent-isolation.json");
		if (fs.existsSync(candidate)) {
			const projectOverrides = loadModelOverridesFile(candidate);
			return { ...userOverrides, ...projectOverrides };
		}
		const parentDir = path.dirname(currentDir);
		if (parentDir === currentDir) return userOverrides;
		currentDir = parentDir;
	}
}

export function discoverAgents(cwd: string, scope: AgentScope): AgentDiscoveryResult {
	const userDir = path.join(getAgentDir(), "agents");
	const projectAgentsDir = findNearestProjectAgentsDir(cwd);
	const userAgents = scope === "project" ? [] : loadAgentsFromDir(userDir, "user");
	const projectAgents =
		scope === "user" || !projectAgentsDir ? [] : loadAgentsFromDir(projectAgentsDir, "project");
	const agentMap = new Map<string, AgentConfig>();
	if (scope === "both") {
		for (const agent of userAgents) agentMap.set(agent.name, agent);
		for (const agent of projectAgents) agentMap.set(agent.name, agent);
	} else if (scope === "user") {
		for (const agent of userAgents) agentMap.set(agent.name, agent);
	} else {
		for (const agent of projectAgents) agentMap.set(agent.name, agent);
	}
	return { agents: Array.from(agentMap.values()), projectAgentsDir };
}

// ===== Original index.ts =====

const COLLAPSED_ITEM_COUNT = 10;

function formatTokens(count: number): string {
	if (count < 1000) return count.toString();
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1000000) return `${Math.round(count / 1000)}k`;
	return `${(count / 1000000).toFixed(1)}M`;
}

function formatPhase(phase: string): string {
	if (phase === "thinking") return "🤔 thinking...";
	if (phase === "waiting") return "⏳ waiting for next step...";
	if (phase.startsWith("tooling:")) {
		const tool = phase.slice(8);
		return `⚡ ${tool}...`;
	}
	return "(running...)";
}

function formatUsageStats(
	usage: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
		cost: number;
		contextTokens?: number;
		turns?: number;
	},
	model?: string,
): string {
	const parts: string[] = [];
	if (usage.turns) parts.push(`${usage.turns} turn${usage.turns > 1 ? "s" : ""}`);
	if (usage.input) parts.push(`↑${formatTokens(usage.input)}`);
	if (usage.output) parts.push(`↓${formatTokens(usage.output)}`);
	if (usage.cacheRead) parts.push(`R${formatTokens(usage.cacheRead)}`);
	if (usage.cacheWrite) parts.push(`W${formatTokens(usage.cacheWrite)}`);
	if (usage.cost) parts.push(`$${usage.cost.toFixed(4)}`);
	if (usage.contextTokens && usage.contextTokens > 0) {
		parts.push(`ctx:${formatTokens(usage.contextTokens)}`);
	}
	if (model) parts.push(model);
	return parts.join(" ");
}

function formatToolCall(
	toolName: string,
	args: Record<string, unknown>,
	themeFg: (color: any, text: string) => string,
): string {
	const shortenPath = (p: string) => {
		const home = os.homedir();
		return p.startsWith(home) ? `~${p.slice(home.length)}` : p;
	};

	switch (toolName) {
		case "bash": {
			// Flatten newlines so the preview stays on a single rendered line.
			const command = ((args.command as string) || "...").replace(/\n/g, "↵");
			const preview = command.length > 60 ? `${command.slice(0, 60)}...` : command;
			return themeFg("muted", "$ ") + themeFg("toolOutput", preview);
		}
		case "read": {
			const rawPath = (args.file_path || args.path || "...") as string;
			const filePath = shortenPath(rawPath);
			const offset = args.offset as number | undefined;
			const limit = args.limit as number | undefined;
			let text = themeFg("accent", filePath);
			if (offset !== undefined || limit !== undefined) {
				const startLine = offset ?? 1;
				const endLine = limit !== undefined ? startLine + limit - 1 : "";
				text += themeFg("warning", `:${startLine}${endLine ? `-${endLine}` : ""}`);
			}
			return themeFg("muted", "read ") + text;
		}
		case "write": {
			const rawPath = (args.file_path || args.path || "...") as string;
			const filePath = shortenPath(rawPath);
			const content = (args.content || "") as string;
			const lines = content.split("\n").length;
			let text = themeFg("muted", "write ") + themeFg("accent", filePath);
			if (lines > 1) text += themeFg("dim", ` (${lines} lines)`);
			return text;
		}
		case "edit": {
			const rawPath = (args.file_path || args.path || "...") as string;
			return themeFg("muted", "edit ") + themeFg("accent", shortenPath(rawPath));
		}
		case "ls": {
			const rawPath = (args.path || ".") as string;
			return themeFg("muted", "ls ") + themeFg("accent", shortenPath(rawPath));
		}
		case "find": {
			const pattern = (args.pattern || "*") as string;
			const rawPath = (args.path || ".") as string;
			return (
				themeFg("muted", "find ") +
				themeFg("accent", pattern) +
				themeFg("dim", ` in ${shortenPath(rawPath)}`)
			);
		}
		case "grep": {
			const pattern = (args.pattern || "") as string;
			const rawPath = (args.path || ".") as string;
			return (
				themeFg("muted", "grep ") +
				themeFg("accent", `/${pattern}/`) +
				themeFg("dim", ` in ${shortenPath(rawPath)}`)
			);
		}
		default: {
			let argsStr: string;
			try {
				argsStr = JSON.stringify(args);
			} catch {
				argsStr = "[unserializable]";
			}
			const preview = argsStr.length > 50 ? `${argsStr.slice(0, 50)}...` : argsStr;
			return themeFg("accent", toolName) + themeFg("dim", ` ${preview}`);
		}
	}
}

interface UsageStats {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	contextTokens: number;
	turns: number;
}

interface SingleResult {
	agent: string;
	agentSource: "user" | "project" | "unknown";
	task: string;
	exitCode: number;
	messages: Message[];
	stderr: string;
	usage: UsageStats;
	model?: string;
	stopReason?: string;
	errorMessage?: string;
	step?: number;
	phase: "idle" | "thinking" | `tooling:${string}` | "waiting";
	lastPhaseChange: number;
	thinkingBuffer?: string;
	sessionId: string;
	/** Wall-clock start of this run (Date.now() at runSingleAgent entry). */
	startedAt: number;
	/** Wall-clock finish, set when the run resolves; absent while running. */
	finishedAt?: number;
}

interface SubagentDetails {
	mode: "single";
	agentScope: AgentScope;
	projectAgentsDir: string | null;
	results: SingleResult[];
}

function getFinalOutput(messages: Message[]): string {
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i];
		if (msg.role === "assistant") {
			for (const part of msg.content) {
				if (part.type === "text") return part.text;
			}
		}
	}
	return "";
}

type DisplayItem = { type: "text"; text: string } | { type: "toolCall"; name: string; args: Record<string, any> };

function getDisplayItems(messages: Message[]): DisplayItem[] {
	const items: DisplayItem[] = [];
	for (const msg of messages) {
		if (msg.role === "assistant") {
			for (const part of msg.content) {
				if (part.type === "text") items.push({ type: "text", text: part.text });
				else if (part.type === "toolCall")
					items.push({ type: "toolCall", name: part.name, args: part.arguments });
			}
		}
	}
	return items;
}

function formatSubagentDiagnostics(result: SingleResult, maxTraceItems = 15): string {
	const lines: string[] = [];
	lines.push(`Agent: ${result.agent} (${result.agentSource})`);
	lines.push(`Exit code: ${result.exitCode}`);
	if (result.stopReason) lines.push(`Stop reason: ${result.stopReason}`);
	if (result.errorMessage) lines.push(`Error message: ${result.errorMessage}`);

	const stderr = result.stderr.trim();
	if (stderr) {
		lines.push(`Stderr:\n${stderr.slice(0, 800)}${stderr.length > 800 ? "\n..." : ""}`);
	}

	const items = getDisplayItems(result.messages);
	if (items.length > 0) {
		lines.push("Execution trace:");
		const start = Math.max(0, items.length - maxTraceItems);
		if (start > 0) lines.push(`  ... ${start} earlier items omitted`);
		for (let i = start; i < items.length; i++) {
			const item = items[i];
			if (item.type === "text") {
				const text = item.text.trim();
				if (text) {
					const firstLine = text.split("\n")[0];
					const preview = firstLine.slice(0, 120);
					lines.push(`  [text] ${preview}${firstLine.length > 120 ? "..." : ""}`);
				}
			} else {
				let argsStr: string;
				try {
					argsStr = JSON.stringify(item.args);
				} catch {
					argsStr = "[unserializable]";
				}
				const preview = argsStr.slice(0, 100);
				lines.push(`  [tool] ${item.name}: ${preview}${argsStr.length > 100 ? "..." : ""}`);
			}
		}
	}

	const finalOutput = getFinalOutput(result.messages);
	if (finalOutput && finalOutput !== result.errorMessage) {
		lines.push(`Final output:\n${finalOutput.trim().slice(0, 500)}${finalOutput.length > 500 ? "\n..." : ""}`);
	}

	return lines.join("\n");
}

async function writePromptToTempFile(
	agentName: string,
	prompt: string,
): Promise<{ dir: string; filePath: string }> {
	const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-subagent-"));
	const safeName = agentName.replace(/[^\w.-]+/g, "_");
	const filePath = path.join(tmpDir, `prompt-${safeName}.md`);
	await withFileMutationQueue(filePath, async () => {
		await fs.promises.writeFile(filePath, prompt, { encoding: "utf-8", mode: 0o600 });
	});
	return { dir: tmpDir, filePath };
}

function getPiInvocation(args: string[]): { command: string; args: string[] } {
	const currentScript = process.argv[1];
	if (currentScript && fs.existsSync(currentScript)) {
		return { command: process.execPath, args: [currentScript, ...args] };
	}

	const execName = path.basename(process.execPath).toLowerCase();
	const isGenericRuntime = /^(node|bun)(\.exe)?$/.test(execName);
	if (!isGenericRuntime) {
		return { command: process.execPath, args };
	}

	return { command: "pi", args };
}

// ===== Subagent progress widget =====

interface SubagentProgressUpdate {
	phase?: SingleResult["phase"];
	currentTool?: string;
	recentTools?: string[];
}

type SubagentProgressCallback = (update: SubagentProgressUpdate) => void;

interface AgentProgress {
	taskId: string;
	name: string;
	phase: SingleResult["phase"];
	currentTool?: string;
	recentTools: string[];
	startedAt: number;
}

const PROGRESS_WIDGET_KEY = "async-subagent-isolation-progress";
const MAX_WIDGET_LINES = 20;
const MAX_RECENT_TOOLS = 3;
// Cap for the dynamic name column: wide enough for typical agent names
// (existing tests require a 20-char name to render in full), small enough
// to leave room for the phase/elapsed columns on narrow terminals.
const MAX_NAME_WIDTH = 30;

/** Plain-text one-line summary of a tool call for the progress widget (no theme colors). */
function summarizeToolCall(toolName: string, args: Record<string, any>): string {
	const raw = ((args.file_path || args.path || args.command || args.pattern || "") as string).replace(/\n/g, "↵");
	const home = os.homedir();
	const shortened = raw.startsWith(home) ? `~${raw.slice(home.length)}` : raw;
	return truncateToWidth(shortened ? `${toolName} ${shortened}` : toolName, 60);
}

function getRecentToolSummaries(messages: Message[]): string[] {
	return getDisplayItems(messages)
		.filter((item): item is Extract<DisplayItem, { type: "toolCall" }> => item.type === "toolCall")
		.slice(-MAX_RECENT_TOOLS)
		.map((item) => summarizeToolCall(item.name, item.args));
}

/**
 * Fit an agent name into a fixed-width column: pad short names with spaces,
 * truncate over-long names with a "..." suffix. Unlike truncateToWidth this
 * never injects ANSI reset codes around the ellipsis (agent names carry no
 * styling), so every row keeps the phase/elapsed columns at the same raw
 * string offset as well as the same display column. Callers must pass
 * width >= 4 so the ellipsis fits.
 */
function fitNameColumn(name: string, width: number): string {
	const nameWidth = visibleWidth(name);
	if (nameWidth <= width) return name + " ".repeat(width - nameWidth);
	// strict: never keep a wide char that would straddle the cut boundary
	const cut = sliceByColumn(name, 0, width - 3, true);
	return cut + "..." + " ".repeat(Math.max(0, width - 3 - visibleWidth(cut)));
}

export function formatElapsed(startedAt: number): string {
	const totalSec = Math.max(0, Math.floor((Date.now() - startedAt) / 1000));
	const mm = String(Math.floor(totalSec / 60)).padStart(2, "0");
	const ss = String(totalSec % 60).padStart(2, "0");
	return `${mm}:${ss}`;
}

/**
 * Format a finished run's duration (milliseconds) for result notifications.
 * Unlike formatElapsed (a live "alive since" clock for the progress widget,
 * MM:SS only and overflowing past 99 minutes), this floors to whole seconds
 * and supports hours: < 1h -> "MM:SS", >= 1h -> "H:MM:SS" (hours not
 * zero-padded), 0/negative -> "00:00".
 */
export function formatDuration(ms: number): string {
	if (!Number.isFinite(ms)) return "00:00";
	const totalSec = Math.max(0, Math.floor(ms / 1000));
	const hours = Math.floor(totalSec / 3600);
	const mm = String(Math.floor((totalSec % 3600) / 60)).padStart(2, "0");
	const ss = String(totalSec % 60).padStart(2, "0");
	return hours > 0 ? `${hours}:${mm}:${ss}` : `${mm}:${ss}`;
}

/**
 * Tracks progress of all running subagents and renders it as a widget above
 * the editor. A single 1Hz interval drives widget refreshes; update() only
 * mutates in-memory state and never triggers a render.
 */
export class SubagentProgressManager {
	private agents = new Map<string, AgentProgress>();
	// Last progress timestamp per session, fed by update(); backs the cancel
	// challenge's "最近进度距今" line. Kept separate from AgentProgress so the
	// challenge can read it without touching widget render state.
	private lastActivityAt = new Map<string, number>();
	private timer: ReturnType<typeof setInterval> | null = null;
	private ctx: ExtensionContext | null = null;
	private widgetSet = false;

	register(ctx: ExtensionContext, sessionId: string, name: string): void {
		this.ctx = ctx;
		this.agents.set(sessionId, {
			taskId: sessionId,
			name,
			phase: "idle",
			recentTools: [],
			startedAt: Date.now(),
		});
		this.ensureTimer();
		this.refresh();
	}

	update(sessionId: string, update: SubagentProgressUpdate): void {
		const agent = this.agents.get(sessionId);
		if (!agent) return;
		if (update.phase !== undefined) agent.phase = update.phase;
		if (update.currentTool !== undefined) agent.currentTool = update.currentTool;
		if (update.recentTools !== undefined) agent.recentTools = update.recentTools;
		this.lastActivityAt.set(sessionId, Date.now());
	}

	/**
	 * Last update() time for a session, or undefined when the task has never
	 * reported progress (the cancel challenge renders that as "尚无进度上报").
	 */
	getLastActivityAt(sessionId: string): number | undefined {
		return this.lastActivityAt.get(sessionId);
	}

	unregister(sessionId: string): void {
		this.lastActivityAt.delete(sessionId);
		if (!this.agents.has(sessionId)) return;
		this.agents.delete(sessionId);
		if (this.agents.size === 0) {
			this.stopTimer();
			if (this.widgetSet && this.ctx?.hasUI) this.ctx.ui.setWidget(PROGRESS_WIDGET_KEY, undefined);
			this.widgetSet = false;
			this.ctx = null;
		} else {
			this.refresh();
		}
	}

	/**
	 * Drop every registered task (widget state and last-activity timestamps)
	 * and stop the refresh timer. Test-isolation hook only: the module-level
	 * singleton outlives individual tests, so a case that dispatches without
	 * finishing its tasks would otherwise leak state into later cases.
	 * Production teardown always goes through per-task unregister.
	 */
	resetForTests(): void {
		for (const id of [...this.agents.keys()]) this.unregister(id);
		this.lastActivityAt.clear();
	}

	refresh(): void {
		if (!this.ctx?.hasUI) return;
		const sorted = [...this.agents.values()].sort((a, b) => a.startedAt - b.startedAt);
		if (sorted.length === 0) return;
		// Over the row budget, truncate the earliest-started agents first
		// (total widget lines = maxAgentRows + 2 border lines).
		const maxAgentRows = Math.max(1, Math.min(process.stdout.rows || MAX_WIDGET_LINES, MAX_WIDGET_LINES));
		const visible = sorted.slice(-maxAgentRows);
		const total = sorted.length;
		// Name column width adapts to the longest visible agent name (capped),
		// so the phase and elapsed columns start at the same offset on every row.
		const nameColWidth = Math.min(MAX_NAME_WIDTH, Math.max(...visible.map((a) => visibleWidth(a.name))));
		// Note: the factory closes over `theme`; between a theme change and the next
		// refresh (≤1s) the widget may briefly use the stale theme. The 1Hz timer
		// replaces the factory on every tick, so this self-heals.
		this.ctx.ui.setWidget(PROGRESS_WIDGET_KEY, (_tui, theme) => {
			const borderColor = (s: string) => theme.fg("border", s);
			const bottomBorder = new DynamicBorder(borderColor);
			// Top horizontal separator with the agent count embedded in the line.
			const renderTopBorder = (width: number): string => {
				const label = ` Subagents (${total}) `;
				const labelWidth = visibleWidth(label);
				// Too narrow for the label: fall back to a plain separator. When
				// width = labelWidth + 1 the label still fits (leading "─" + label,
				// no trailing "─"); this asymmetric look is accepted on narrow
				// terminals.
				if (labelWidth + 1 > width) return bottomBorder.render(width)[0];
				return borderColor("─") + theme.fg("accent", label) + borderColor("─".repeat(width - labelWidth - 1));
			};
			const renderRow = (a: AgentProgress, width: number): string => {
				const nameCol = fitNameColumn(a.name, nameColWidth);
				const phaseCol = truncateToWidth(formatPhase(a.phase), 20, "...", true);
				const toolHint = a.recentTools.length > 0 ? `  → ${a.recentTools[a.recentTools.length - 1]}` : "";
				const line =
					`${theme.fg("success", "●")} ${theme.fg("dim", a.taskId)} ${nameCol} ${theme.fg("warning", phaseCol)} ${formatElapsed(a.startedAt)}` +
					(toolHint ? theme.fg("dim", toolHint) : "");
				return truncateToWidth(line, width);
			};
			// Stateless render: themed strings are rebuilt on every render() call,
			// so invalidate() has no cached state to rebuild. Note that render() is
			// not a pure function: the elapsed time (formatElapsed -> Date.now())
			// is computed live on each render.
			return {
				render: (width: number) => [
					renderTopBorder(width),
					...visible.map((a) => renderRow(a, width)),
					...bottomBorder.render(width),
				],
				invalidate: () => bottomBorder.invalidate(),
			};
		});
		this.widgetSet = true;
	}

	private ensureTimer(): void {
		if (this.timer) return;
		this.timer = setInterval(() => this.refresh(), 1000);
		this.timer.unref?.();
	}

	private stopTimer(): void {
		if (this.timer) {
			clearInterval(this.timer);
			this.timer = null;
		}
	}
}

const progressManager = new SubagentProgressManager();

/**
 * Test-isolation hook for the module-level progress singleton (see
 * SubagentProgressManager.resetForTests). Production code never calls this.
 */
export function resetProgressManagerForTests(): void {
	progressManager.resetForTests();
}

/**
 * Build the isolated session directory for a subagent.
 * All subagent sessions live under a dedicated root, independent of the main
 * agent's session directory and independent of cwd:
 *   ~/.pi/agent/subagent-sessions/<session-id>/
 */
function getSubagentSessionDir(sessionId: string): string {
	const root = path.resolve(path.join(getAgentDir(), "subagent-sessions"));
	const resolved = path.resolve(path.join(root, sessionId));
	const rel = path.relative(root, resolved);
	if (path.isAbsolute(rel) || rel === ".." || rel.startsWith(".." + path.sep) || resolved === root) {
		throw new Error(`Invalid sessionId: path traversal detected for "${sessionId}"`);
	}
	return resolved;
}

/**
 * Locate the session JSONL file for a finished subagent task.
 * A task's session dir may contain multiple .jsonl files (e.g. after a
 * resume); pick the most recently modified one. Returns null when the dir
 * does not exist, the taskId fails the traversal guard, or no .jsonl file
 * is present.
 */
export function findSessionFile(taskId: string): string | null {
	let sessionDir: string;
	try {
		sessionDir = getSubagentSessionDir(taskId);
	} catch {
		return null;
	}
	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(sessionDir, { withFileTypes: true });
	} catch {
		return null;
	}
	let newest: string | null = null;
	let newestMtime = -1;
	for (const entry of entries) {
		if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
		const filePath = path.join(sessionDir, entry.name);
		try {
			const mtime = fs.statSync(filePath).mtimeMs;
			if (mtime > newestMtime) {
				newestMtime = mtime;
				newest = filePath;
			}
		} catch {
			/* ignore unreadable entries */
		}
	}
	return newest;
}

/**
 * Extract the last assistant text from a pi session JSONL file. Lines look
 * like {"type":"message","message":{"role":"assistant","content":[{"type":"text","text":"..."}]}}.
 * Returns null when the file is unreadable or has no assistant text message.
 */
export function extractFinalAssistantText(filePath: string): string | null {
	let raw: string;
	try {
		raw = fs.readFileSync(filePath, "utf-8");
	} catch {
		return null;
	}
	let last: string | null = null;
	for (const line of raw.split("\n")) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		let record: any;
		try {
			record = JSON.parse(trimmed);
		} catch {
			continue; // skip malformed lines
		}
		if (record?.type !== "message" || record?.message?.role !== "assistant") continue;
		const parts = record.message.content;
		if (!Array.isArray(parts)) continue;
		const text = parts
			.filter((p: any) => p?.type === "text" && typeof p.text === "string")
			.map((p: any) => p.text)
			.join("\n");
		if (text) last = text;
	}
	return last;
}

/** Truncate a single-line-ish summary to maxLen chars, appending an ellipsis. */
function truncateSummary(text: string, maxLen: number): string {
	return text.length > maxLen ? `${text.slice(0, maxLen)}…` : text;
}

/**
 * Extract the full session transcript (方案 A) from a pi session JSONL file:
 * the task text (first user message) followed by the conversation in original
 * order — assistant texts, tool calls (`→ name args`) and tool results
 * (`← name: summary`). Returns null when the file is unreadable or contains
 * no assistant text (same contract as extractFinalAssistantText).
 */
export function extractSessionTranscript(filePath: string): string | null {
	let raw: string;
	try {
		raw = fs.readFileSync(filePath, "utf-8");
	} catch {
		return null;
	}
	let taskText: string | null = null;
	const entries: string[] = [];
	let hasAssistantText = false;
	for (const line of raw.split("\n")) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		let record: any;
		try {
			record = JSON.parse(trimmed);
		} catch {
			continue; // skip malformed lines
		}
		if (record?.type !== "message") continue;
		const message = record.message;
		const role = message?.role;
		const parts = message?.content;
		if (!Array.isArray(parts)) continue;
		const textOf = () =>
			parts
				.filter((p: any) => p?.type === "text" && typeof p.text === "string")
				.map((p: any) => p.text)
				.join("\n");
		if (role === "user") {
			// The first user message is the dispatched task ("Task: ...");
			// later user messages (follow-ups) are not shown.
			if (taskText === null) {
				const text = textOf();
				if (text) taskText = text;
			}
		} else if (role === "assistant") {
			for (const part of parts) {
				if (part?.type === "text" && typeof part.text === "string" && part.text.trim()) {
					hasAssistantText = true;
					entries.push(`[assistant] ${part.text}`);
				} else if (part?.type === "toolCall" && typeof part.name === "string") {
					const args = truncateSummary(JSON.stringify(part.arguments ?? {}), 200);
					entries.push(`→ ${part.name} ${args}`);
				}
			}
		} else if (role === "toolResult") {
			const text = textOf();
			if (text) {
				const toolName = typeof message.toolName === "string" ? `${message.toolName}: ` : "";
				entries.push(`← ${toolName}${truncateSummary(text, 500)}`);
			}
		}
		// other roles (thinking etc.) are skipped
	}
	if (!hasAssistantText) return null;
	const sections: string[] = [];
	// Plain-text section labels (not markdown headings): headings would invoke
	// theme closures that throw when the global theme is uninitialized (tests).
	if (taskText) sections.push(`任务原文\n\n${taskText}`);
	sections.push(`会话记录\n\n${entries.join("\n\n")}`);
	return sections.join("\n\n");
}

/**
 * Parse an integer environment variable with NaN fallback. Garbage values
 * (e.g. PI_SUBAGENT_DEPTH=abc) must fail safe to the fallback instead of
 * becoming NaN, which would silently bypass numeric guards.
 */
function parseEnvInt(raw: string | undefined, fallback: number): number {
	const parsed = parseInt(raw || String(fallback), 10);
	return Number.isNaN(parsed) ? fallback : parsed;
}

const UUID_V7_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** Validate an explicit sessionId. Returns an error message, or null when valid. */
function validateSessionId(sessionId: unknown): string | null {
	if (typeof sessionId !== "string") return `Invalid sessionId: must be a string, got ${typeof sessionId}`;
	const trimmed = sessionId.trim();
	if (trimmed === "") return "Invalid sessionId: must not be empty";
	if (trimmed === "." || trimmed === "..") return `Invalid sessionId: "${trimmed}" is not allowed`;
	if (!UUID_V7_PATTERN.test(trimmed))
		return "Invalid sessionId: expected a lowercase UUID v7 from a previous receipt. Only pass sessionId to resume (复用) an earlier taskId; omit it to generate a new one.";
	return null;
}

async function runSingleAgent(
	defaultCwd: string,
	agents: AgentConfig[],
	agentName: string,
	task: string,
	cwd: string | undefined,
	step: number | undefined,
	sessionId: string | undefined,
	signal: AbortSignal | undefined,
	progressCallback: SubagentProgressCallback | undefined,
	parentModel?: CurrentModel,
	modelOverrides?: Record<string, ModelOverride>,
	onProcSpawn?: (proc: ChildProcess) => void,
): Promise<SingleResult> {
	const startedAt = Date.now();
	let effectiveSessionId: string;
	if (sessionId !== undefined) {
		const trimmed = sessionId.trim();
		const invalidSessionIdMessage = validateSessionId(sessionId);
		if (invalidSessionIdMessage) {
			return {
				agent: agentName,
				agentSource: "unknown",
				task,
				exitCode: 1,
				messages: [],
				stderr: invalidSessionIdMessage,
				errorMessage: invalidSessionIdMessage,
				usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
				step,
				phase: "idle",
				lastPhaseChange: Date.now(),
				sessionId: trimmed,
				startedAt,
				finishedAt: Date.now(),
			};
		}
		effectiveSessionId = trimmed;
	} else {
		effectiveSessionId = uuidv7();
	}
	const agent = agents.find((a) => a.name === agentName);

	if (!agent) {
		const available = agents.map((a) => `"${a.name}"`).join(", ") || "none";
		return {
			agent: agentName,
			agentSource: "unknown",
			task,
			exitCode: 1,
			messages: [],
			stderr: `Unknown agent: "${agentName}". Available agents: ${available}.`,
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
			step,
			phase: "idle",
			lastPhaseChange: Date.now(),
			sessionId: effectiveSessionId,
			startedAt,
			finishedAt: Date.now(),
		};
	}

	// Model priority: config file override > agent frontmatter model > inherited parent model
	const override = modelOverrides?.[agent.name];
	const effectiveModel =
		override?.model || agent.model || (parentModel ? `${parentModel.provider}/${parentModel.id}` : undefined);
	// Thinking priority: config file override > agent frontmatter thinking
	const effectiveThinking = override?.thinking || agent.thinking;
	const args: string[] = ["--mode", "json", "-p", "--session-id", effectiveSessionId];
	if (effectiveModel) args.push("--model", effectiveModel);
	if (effectiveThinking) args.push("--thinking", effectiveThinking);
	if (agent.tools && agent.tools.length > 0) args.push("--tools", agent.tools.join(","));

	// Effective working directory: agent-specific cwd > session default.
	// Used both for resolving relative skill paths and as the spawned process cwd.
	const effectiveCwd = cwd ?? defaultCwd;

	// MODIFIED: inject per-agent skill isolation
	const skillWarnings: string[] = [];
	if (agent.skills !== undefined) {
		args.push("--no-skills");
		if (agent.skills.length > 0) {
			for (const skillPath of agent.skills) {
				const resolved = skillPath.startsWith("~/")
					? path.join(os.homedir(), skillPath.slice(2))
					: path.isAbsolute(skillPath)
						? skillPath
						: path.resolve(effectiveCwd, skillPath);

				// Reject relative skill paths that escape effectiveCwd
				if (!skillPath.startsWith("~/") && !path.isAbsolute(skillPath)) {
					const rel = path.relative(effectiveCwd, resolved);
					if (rel === ".." || rel.startsWith(".." + path.sep)) {
						skillWarnings.push(
							`[async-subagent-isolation] skill path "${skillPath}" resolves outside the agent base directory and was ignored.\n`,
						);
						continue;
					}
				}

				args.push("--skill", resolved);
			}
		}
	}

	// Isolate subagent sessions under a dedicated root independent of cwd and
	// the main agent's session directory.
	const subagentSessionDir = getSubagentSessionDir(effectiveSessionId);
	args.push("--session-dir", subagentSessionDir);

	let tmpPromptDir: string | null = null;
	let tmpPromptPath: string | null = null;

	const currentResult: SingleResult = {
		agent: agentName,
		agentSource: agent.source,
		task,
		exitCode: 0,
		messages: [],
		stderr: skillWarnings.join(""),
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
		model: effectiveModel,
		step,
		phase: "idle",
		lastPhaseChange: Date.now(),
		sessionId: effectiveSessionId,
		startedAt,
	};

	const emitProgress = () => {
		if (emitTimer) { clearTimeout(emitTimer); emitTimer = null; }
		if (progressCallback) {
			const phase = currentResult.phase;
			progressCallback({
				phase,
				currentTool: phase.startsWith("tooling:") ? phase.slice(8) : undefined,
				recentTools: getRecentToolSummaries(currentResult.messages),
			});
		}
	};

	let emitTimer: ReturnType<typeof setTimeout> | null = null;
	const throttledEmitProgress = () => {
		if (emitTimer) return;
		emitTimer = setTimeout(() => {
			emitTimer = null;
			emitProgress();
		}, 100);
	};

	// Notify immediately only on the first idle -> busy transition so the user
	// sees the subagent start; all later intermediate events are throttled.
	let hasNotifiedStart = false;

	try {
		if (agent.systemPrompt.trim()) {
			const tmp = await writePromptToTempFile(agent.name, agent.systemPrompt);
			tmpPromptDir = tmp.dir;
			tmpPromptPath = tmp.filePath;
			args.push("--append-system-prompt", tmpPromptPath);
		}

		args.push(`Task: ${task}`);
		let wasAborted = false;

		const POST_EXIT_GRACE_MS = 500;
		const ABORT_FORCE_TIMEOUT_MS = 2000;
		const DEFAULT_ACTIVITY_TIMEOUT_MS = 600_000;
		const DEFAULT_HARD_TIMEOUT_MS = 0;

		const exitCode = await new Promise<number>((resolve) => {
			const invocation = getPiInvocation(args);
			const currentDepth = parseEnvInt(process.env.PI_SUBAGENT_DEPTH, 0);
			const proc = spawn(invocation.command, invocation.args, {
				cwd: effectiveCwd,
				shell: false,
				stdio: ["ignore", "pipe", "pipe"],
				env: {
					...process.env,
					PI_SUBAGENT_DEPTH: String(currentDepth + 1),
					PI_CURRENT_AGENT_NAME: agent.name,
				},
			});
			onProcSpawn?.(proc);
			let buffer = "";
			let resolved = false;
			let exitCodeValue: number | null = null;
			let stdoutEnded = false;
			let postExitTimer: ReturnType<typeof setTimeout> | undefined;
			let sigkillTimer: ReturnType<typeof setTimeout> | undefined;
			let activityTimer: ReturnType<typeof setTimeout> | undefined;
			let lastActivityAt = Date.now();
			let hardTimer: ReturnType<typeof setTimeout> | undefined;
			let abortForceTimer: ReturnType<typeof setTimeout> | undefined;
			let killProc: (() => void) | undefined;

			const finalize = (code: number) => {
				if (resolved) return;
				resolved = true;
				currentResult.finishedAt = Date.now();
				if (postExitTimer) {
					clearTimeout(postExitTimer);
					postExitTimer = undefined;
				}
				if (sigkillTimer) {
					clearTimeout(sigkillTimer);
					sigkillTimer = undefined;
				}
				if (activityTimer) {
					clearTimeout(activityTimer);
					activityTimer = undefined;
				}
				if (hardTimer) {
					clearTimeout(hardTimer);
					hardTimer = undefined;
				}
				if (abortForceTimer) {
					clearTimeout(abortForceTimer);
					abortForceTimer = undefined;
				}
				if (emitTimer) {
					clearTimeout(emitTimer);
					emitTimer = null;
				}
				proc.stdout?.removeAllListeners();
				proc.stderr?.removeAllListeners();
				proc.removeAllListeners();
				if (signal && killProc) {
					signal.removeEventListener("abort", killProc);
				}
				if (buffer.trim()) processLineRaw(buffer);
				const effectiveCode =
					currentResult.stopReason === "error" || currentResult.errorMessage ? 1 : code;
				resolve(effectiveCode);
			};

			const maybeFinalizeAfterExit = () => {
				if (exitCodeValue !== null && stdoutEnded) {
					finalize(exitCodeValue);
				}
			};

			const processLineRaw = (line: string) => {
				if (!line.trim()) return;
				let event: any;
				try {
					event = JSON.parse(line);
				} catch {
					return;
				}

				if (event.type === "turn_start") {
					const wasIdle = currentResult.phase === "idle";
					currentResult.phase = "thinking";
					currentResult.lastPhaseChange = Date.now();
					currentResult.thinkingBuffer = "";
					resetActivityTimer();
					if (wasIdle && !hasNotifiedStart) {
						hasNotifiedStart = true;
						emitProgress();
					} else {
						throttledEmitProgress();
					}
				}

				// message_start: assistant message begins; typically no text yet, so just update phase
				if (event.type === "message_start") {
					currentResult.phase = "thinking";
					currentResult.lastPhaseChange = Date.now();
					resetActivityTimer();
					throttledEmitProgress();
				}

				if (event.type === "message_update" && event.assistantMessageEvent?.type === "text_delta") {
					const delta = event.assistantMessageEvent.delta as string;
					if (delta) {
						currentResult.thinkingBuffer = (currentResult.thinkingBuffer || "") + delta;
					}
					if (currentResult.thinkingBuffer && currentResult.thinkingBuffer.length > 2048) {
						// Keep last 2048 chars; try to keep whole lines if possible
						const idx = currentResult.thinkingBuffer.indexOf("\n", currentResult.thinkingBuffer.length - 2048);
						currentResult.thinkingBuffer = currentResult.thinkingBuffer.slice(idx >= 0 ? idx + 1 : -2048);
					}
					currentResult.phase = "thinking";
					currentResult.lastPhaseChange = Date.now();
					resetActivityTimer();
					throttledEmitProgress();
				}

				if (event.type === "tool_execution_start") {
					currentResult.phase = `tooling:${event.toolName}`;
					currentResult.lastPhaseChange = Date.now();
					resetActivityTimer();
					throttledEmitProgress();
				}

				if (event.type === "tool_execution_update") {
					currentResult.phase = `tooling:${event.toolName}`;
					resetActivityTimer();
					throttledEmitProgress();
				}

				if (event.type === "tool_execution_end") {
					if (event.message) {
						currentResult.messages.push(event.message as Message);
					}
					currentResult.phase = "waiting";
					currentResult.lastPhaseChange = Date.now();
					resetActivityTimer();
					throttledEmitProgress();
				}

				if (event.type === "turn_end") {
					currentResult.phase = "idle";
					currentResult.lastPhaseChange = Date.now();
					resetActivityTimer();
					throttledEmitProgress();
				}

				if (event.type === "message_end" && event.message) {
					const msg = event.message as Message;
					currentResult.messages.push(msg);
					resetActivityTimer();

					if (msg.role === "assistant") {
						currentResult.usage.turns++;
						const usage = msg.usage;
						if (usage) {
							currentResult.usage.input += usage.input || 0;
							currentResult.usage.output += usage.output || 0;
							currentResult.usage.cacheRead += usage.cacheRead || 0;
							currentResult.usage.cacheWrite += usage.cacheWrite || 0;
							currentResult.usage.cost += usage.cost?.total || 0;
							currentResult.usage.contextTokens = usage.totalTokens || 0;
						}
						if (!currentResult.model && msg.model) currentResult.model = msg.model;
						// A timeout stopReason is set by the activity/hard timers right before
						// finalize() flushes the leftover buffer through processLineRaw (which
						// bypasses the `resolved` guard in processLine). Never override it;
						// all other stopReasons keep the last-one-wins multi-turn semantics.
						if (
							msg.stopReason &&
							currentResult.stopReason !== "activity_timeout" &&
							currentResult.stopReason !== "hard_timeout"
						) {
							currentResult.stopReason = msg.stopReason;
						}
						if (msg.errorMessage) currentResult.errorMessage = msg.errorMessage;
						if (msg.stopReason === "error" || msg.errorMessage) {
							try {
								proc.kill("SIGKILL");
							} catch {
								/* ignore ESRCH */
							}
							emitProgress();
							finalize(1);
							return;
						}
					}
					emitProgress();
				}
			};
			const processLine = (line: string) => {
				if (resolved) return;
				processLineRaw(line);
			};

			const resetActivityTimer = () => {
				// Don't (re)arm after resolution, once abort started teardown, or after
				// the process exited: in those states an activity timeout is meaningless.
				if (resolved || wasAborted || exitCodeValue !== null) return;
				lastActivityAt = Date.now();
				if (activityTimer) clearTimeout(activityTimer);
				const activityMs = parseEnvInt(
					process.env.PI_SUBAGENT_ACTIVITY_TIMEOUT_MS,
					DEFAULT_ACTIVITY_TIMEOUT_MS,
				);
				if (activityMs > 0) {
					activityTimer = setTimeout(() => {
						currentResult.stopReason = "activity_timeout";
						const elapsed = Date.now() - lastActivityAt;
						const phase = currentResult.phase;
						const turns = currentResult.usage.turns;
						currentResult.stderr += `[async-subagent-isolation] activity timeout exceeded after ${Math.round(elapsed / 1000)}s idle (phase: ${phase}, turns: ${turns}), killing...\n`;
						try {
							proc.kill("SIGKILL");
						} catch {
							/* ignore ESRCH */
						}
						finalize(1);
					}, activityMs);
				}
			};

			const setupHardTimer = () => {
				// Don't arm after resolution, once abort started teardown, or after
				// the process exited (same guard as resetActivityTimer): a hard
				// timeout is meaningless in those states.
				if (resolved || wasAborted || exitCodeValue !== null) return;
				const hardMs = parseEnvInt(
					process.env.PI_SUBAGENT_HARD_TIMEOUT_MS,
					DEFAULT_HARD_TIMEOUT_MS,
				);
				if (hardMs > 0) {
					hardTimer = setTimeout(() => {
						currentResult.stopReason = "hard_timeout";
						const turns = currentResult.usage.turns;
						const phase = currentResult.phase;
						currentResult.stderr += `[async-subagent-isolation] hard timeout exceeded (phase: ${phase}, turns: ${turns}), killing...\n`;
						try {
							proc.kill("SIGKILL");
						} catch {
							/* ignore ESRCH */
						}
						finalize(1);
					}, hardMs);
				}
			};

			proc.stdout.on("data", (data) => {
				resetActivityTimer();
				buffer += data.toString();
				const lines = buffer.split("\n");
				buffer = lines.pop() || "";
				for (const line of lines) processLine(line);
			});

			proc.stdout.on("end", () => {
				stdoutEnded = true;
				maybeFinalizeAfterExit();
			});

			proc.stderr.on("data", (data) => {
				currentResult.stderr += data.toString();
				resetActivityTimer();
			});

			proc.on("exit", (code, signal) => {
				exitCodeValue = signal ? 1 : (code ?? 0);
				// The process is gone: disarm the timeout timers so they can't fire
				// during the post-exit grace window and mislabel a normal exit.
				if (activityTimer) {
					clearTimeout(activityTimer);
					activityTimer = undefined;
				}
				if (hardTimer) {
					clearTimeout(hardTimer);
					hardTimer = undefined;
				}
				maybeFinalizeAfterExit();
				if (!resolved) {
					postExitTimer = setTimeout(() => finalize(exitCodeValue ?? 0), POST_EXIT_GRACE_MS);
				}
			});

			proc.on("close", (code, signal) => {
				finalize(signal ? 1 : (code ?? 0));
			});

			proc.on("error", (err) => {
				currentResult.stderr += `[async-subagent-isolation] process error: ${err?.message ?? String(err)}\n`;
				finalize(1);
			});

			if (signal) {
				killProc = () => {
					wasAborted = true;
					// Abort takes over process teardown: disarm the timeout timers so
					// they can't fire during the SIGTERM grace period and mislabel the
					// abort as a timeout (or SIGKILL prematurely).
					if (activityTimer) {
						clearTimeout(activityTimer);
						activityTimer = undefined;
					}
					if (hardTimer) {
						clearTimeout(hardTimer);
						hardTimer = undefined;
					}
					try {
						proc.kill("SIGTERM");
					} catch {
						/* ignore ESRCH */
					}
					// Cancel/completion race — "cancel wins": if the process was
					// already exiting when the cancel arrived, the task is still
					// reported as cancelled (wasAborted -> rejection), never as a
					// success. This matches user intent (they asked to abort, so the
					// outcome is discarded) and avoids diffing partial results.
					if (exitCodeValue !== null || proc.exitCode !== null || proc.signalCode !== null) {
						finalize(1);
						return;
					}
					sigkillTimer = setTimeout(() => {
						try {
							if (proc.exitCode === null && proc.signalCode === null) {
								proc.kill("SIGKILL");
								abortForceTimer = setTimeout(() => {
									finalize(1);
								}, ABORT_FORCE_TIMEOUT_MS);
							}
						} catch {
							/* ignore ESRCH */
						}
					}, 5000);
				};
				if (signal.aborted) killProc();
				else signal.addEventListener("abort", killProc, { once: true });
			}

			setupHardTimer();
			resetActivityTimer();
		});

		currentResult.exitCode = exitCode;
		if (wasAborted) throw new Error("Subagent was aborted");
		return currentResult;
	} finally {
		if (tmpPromptPath)
			try {
				fs.unlinkSync(tmpPromptPath);
			} catch {
				/* ignore */
			}
		if (tmpPromptDir)
			try {
				fs.rmdirSync(tmpPromptDir);
			} catch {
				/* ignore */
			}
	}
}

// ===== Async dispatch mode (TUI) =====

/**
 * Maximum subagent delegation depth. Recursive delegation is blocked entirely:
 * a subagent (depth >= 1) can never spawn another subagent.
 */
const MAX_SUBAGENT_DEPTH = 1;

/** Envelope status words for a finished async subagent task. */
export const STATUS_WORDS = {
	success: "成功",
	failure: "失败",
	timeout: "超时",
	cancelled: "已取消",
} as const;

export type SubagentTaskStatus = keyof typeof STATUS_WORDS;

/** A background subagent task, keyed in the registry by taskId (= sessionId). */
export interface AsyncSubagentTask {
	taskId: string;
	agentName: string;
	task: string;
	startedAt: number;
	/**
	 * Per-task abort controller. The turn-level signal ends with the
	 * dispatching turn and would wrongly kill the background process, so async
	 * tasks always get their own controller; cancellation reuses the existing
	 * SIGTERM -> 5s -> SIGKILL abort cascade in runSingleAgent.
	 */
	abortController: AbortController;
	/** "running" while in flight; "cancelled" / "killed_on_shutdown" once teardown started. */
	status: "running" | "cancelled" | "killed_on_shutdown";
	/**
	 * Who cancelled the task: "user" via /subagent-cancel, "agent" via the
	 * subagent tool's action="cancel". Set by cancelTask so the result envelope can name
	 * the cancel's origin; undefined for non-cancelled endings.
	 */
	cancelledBy?: "user" | "agent";
	/**
	 * Why the task was cancelled, supplied by the confirming cancel call
	 * (action="cancel" + confirm:true requires a non-empty reason). Recorded
	 * so the cancellation stays auditable: the [subagent-result] envelope body
	 * quotes it (single-lined and capped at 200 chars). Undefined for user
	 * cancels and non-cancelled endings.
	 */
	cancelReason?: string;
	/**
	 * Child process handle, set once runSingleAgent has spawned. Lets the
	 * session_shutdown handler SIGKILL directly: on "quit" the main process
	 * exits before the 5s SIGKILL-escalation timer inside runSingleAgent can
	 * fire, so without this backstop a SIGTERM-ignoring child would be orphaned.
	 */
	proc?: ChildProcess;
}

/**
 * Registry of in-flight async subagent tasks (module-level, keyed by taskId).
 * Entries are removed once the task's completion notification has been sent.
 */
export const taskRegistry = new Map<string, AsyncSubagentTask>();

/**
 * Cancel a running async subagent task: mark it cancelled, record who
 * cancelled it (for the envelope), and fire its abort controller — reusing
 * the SIGTERM -> 5s -> SIGKILL cascade in runSingleAgent. Shared by the
 * /subagent-cancel command and the subagent tool's action="cancel". Returns false when
 * no running task with that id exists.
 */
function cancelTask(taskId: string, cancelledBy: "user" | "agent", reason?: string): boolean {
	const task = taskRegistry.get(taskId);
	if (!task || task.status !== "running") return false;
	task.status = "cancelled";
	task.cancelledBy = cancelledBy;
	if (reason) task.cancelReason = reason;
	task.abortController.abort();
	return true;
}

/** Truncate a task description for the envelope's 任务 line (default: 200 chars). */
export function truncateTaskDescription(task: string, maxLen = 200): string {
	const oneLine = task.replace(/\s+/g, " ").trim();
	return oneLine.length > maxLen ? `${oneLine.slice(0, maxLen)}...` : oneLine;
}

/**
 * Format the in-flight task list (status === "running") for the result
 * envelope's 在途 block. The list is a build-time snapshot; since the
 * notification may be delivered after the main agent has dispatched new
 * tasks, the wording is anchored to this envelope's task-end event (an
 * event the main agent can order against its own dispatch records) instead
 * of an absolute "right now" claim. Deliberately carries no elapsed time
 * or clock time: the list answers "what was still running when this task
 * ended", not "how long has it run" or "what time is it".
 */
export function formatActiveTasks(): string {
	const running = [...taskRegistry.values()].filter((t) => t.status === "running");
	if (running.length === 0) return "本任务结束时无其他在途任务。";
	const lines = running.map((t) => `- ${t.taskId} (${t.agentName}): ${truncateTaskDescription(t.task)}`);
	return `本任务结束时，其他在途任务: ${running.length}\n${lines.join("\n")}`;
}

/**
 * Remaining in-flight list for the action="cancel" confirmation receipt.
 * NOT shared with the envelope block (formatActiveTasks): at this point no
 * task has ended — the cancel was merely requested and the cancelled task's
 * result arrives later — so a "本任务结束" anchor would be wrong here. The
 * receipt is returned synchronously in the same turn, so anchoring the
 * snapshot to the cancel request itself is accurate.
 */
function formatRemainingTasksAfterCancelRequest(): string {
	const running = [...taskRegistry.values()].filter((t) => t.status === "running");
	if (running.length === 0) return "取消请求发出后，已无其他在途任务。";
	const lines = running.map((t) => `- ${t.taskId} (${t.agentName}): ${truncateTaskDescription(t.task)}`);
	return `取消请求发出后，其余在途任务: ${running.length}\n${lines.join("\n")}`;
}

/** A finished async task, recorded when completeAsyncTask removes it from the registry. */
interface CompletedTaskRecord {
	taskId: string;
	agentName: string;
	status: SubagentTaskStatus;
	finishedAt: number;
}

/**
 * Recently finished async tasks in completion order (latest last), backing the
 * no-argument /subagent-result picker. Bounded so a long session cannot grow
 * it without limit; entries whose session file is gone are filtered at read
 * time by listViewableFinishedTasks.
 */
const completedTasks: CompletedTaskRecord[] = [];
const COMPLETED_TASKS_KEEP = 50;

/** Record a finished task (called once per task from completeAsyncTask). */
function recordCompletedTask(task: AsyncSubagentTask, status: SubagentTaskStatus): void {
	// A reused sessionId finishes repeatedly: drop its older record first so
	// the latest finish wins and one task cannot occupy multiple slots.
	for (let i = completedTasks.length - 1; i >= 0; i--) {
		if (completedTasks[i].taskId === task.taskId) completedTasks.splice(i, 1);
	}
	completedTasks.push({ taskId: task.taskId, agentName: task.agentName, status, finishedAt: Date.now() });
	if (completedTasks.length > COMPLETED_TASKS_KEEP) {
		completedTasks.splice(0, completedTasks.length - COMPLETED_TASKS_KEEP);
	}
}

/**
 * Latest-first finished tasks whose session transcript still exists on disk
 * (a task without a session file has nothing to show in the result viewer).
 * completedTasks holds at most one record per taskId (recordCompletedTask
 * dedupes), so no further deduplication is needed here.
 */
function listViewableFinishedTasks(limit: number): CompletedTaskRecord[] {
	const result: CompletedTaskRecord[] = [];
	for (let i = completedTasks.length - 1; i >= 0 && result.length < limit; i--) {
		const record = completedTasks[i];
		if (!findSessionFile(record.taskId)) continue;
		result.push(record);
	}
	return result;
}

/** Build a picker item whose label carries the full taskId (a 36-char UUID). */
function taskPickerItem(taskId: string, description: string): SelectItem {
	return { value: taskId, label: taskId, description };
}

/**
 * Interactive task picker (TUI only): a SelectList in a Container with
 * DynamicBorder framing (tui.md Pattern 1). Resolves with the selected item's
 * value (taskId), or undefined on Esc / q. Neither pi's select() nor
 * SelectList handles "q", so the wrapper's handleInput intercepts it before
 * delegating to the list.
 */
async function pickTaskInteractively(
	ui: ExtensionContext["ui"],
	title: string,
	items: SelectItem[],
): Promise<string | undefined> {
	return ui.custom<string | undefined>((tui, theme, _kb, done) => {
		const container = new Container();
		container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
		container.addChild(new Text(theme.fg("accent", theme.bold(title)), 1, 0));
		const selectList = new SelectList(
			items,
			Math.min(items.length, 10),
			{
				selectedPrefix: (t) => theme.fg("accent", t),
				selectedText: (t) => theme.fg("accent", t),
				description: (t) => theme.fg("muted", t),
				scrollInfo: (t) => theme.fg("dim", t),
				noMatch: (t) => theme.fg("warning", t),
			},
			// The label is a 36-char UUID taskId; the default 32-char primary
			// column would truncate it, so widen the column to fit.
			{ minPrimaryColumnWidth: 40, maxPrimaryColumnWidth: 40 },
		);
		selectList.onSelect = (item) => done(item.value);
		selectList.onCancel = () => done(undefined);
		container.addChild(selectList);
		container.addChild(new Text(theme.fg("dim", "↑↓ 选择 · Enter 确认 · Esc/q 退出"), 1, 0));
		container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
		return {
			render: (w) => container.render(w),
			invalidate: () => container.invalidate(),
			handleInput: (data) => {
				// Key.shift("q") covers Shift+q / Caps Lock "Q"; matchesKey
				// lowercases its keyId, so "Q" alone would be a no-op alias.
				if (matchesKey(data, "q") || matchesKey(data, Key.shift("q"))) {
					done(undefined);
					return;
				}
				selectList.handleInput(data);
				tui.requestRender();
			},
		};
	});
}

/** Derive the envelope status from a finished SingleResult. */
function getTaskStatus(result: SingleResult): SubagentTaskStatus {
	const stopReason = result.stopReason;
	if (stopReason === "aborted" || stopReason === "killed_on_shutdown") return "cancelled";
	if (stopReason === "activity_timeout" || stopReason === "hard_timeout") return "timeout";
	if (result.exitCode !== 0 || stopReason === "error") return "failure";
	return "success";
}

/** Structured payload carried by the subagent-result message's details field. */
export interface SubagentResultDetails {
	taskId: string;
	agent: string;
	status: string;
	exitCode: number | null;
	stopReason?: string;
	/** Present only on cancelled tasks: who cancelled ("user" | "agent"). */
	cancelledBy?: "user" | "agent";
	/**
	 * Run duration in milliseconds (>= 0): the real run time
	 * (finishedAt - startedAt) when a result exists; measured from the
	 * dispatch time (task.startedAt) when result is null (cancel/internal
	 * error).
	 */
	durationMs: number;
	usage: UsageStats;
	sessionId: string;
	output: string;
}

/**
 * Cap for details.output. The full output already lives in the envelope
 * content; the structured details field carries only a bounded copy so a
 * huge result is not stored twice at full length.
 */
const DETAILS_OUTPUT_MAX_CHARS = 16 * 1024;

/**
 * Build the [subagent-result] notification envelope: a markdown content text
 * carrying the full, untruncated result, plus structured details (details.output
 * is capped at DETAILS_OUTPUT_MAX_CHARS; content always keeps the full text).
 */
/**
 * Empty-body fallback for an aborted task, keyed on the abort's origin so the
 * main agent can tell a deliberate user cancel, an agent-initiated cancel and
 * a session shutdown apart (and does not auto-retry a user cancel).
 */
function abortedFallbackBody(stopReason?: string, cancelledBy?: "user" | "agent", cancelReason?: string): string {
	if (stopReason === "killed_on_shutdown") return "任务因会话关闭被终止（session_shutdown）。";
	if (cancelledBy === "agent") {
		const base = "该任务已由主 agent 通过 subagent 工具（action=cancel）取消。";
		// Single-line and cap the reason: it is model-controlled text inlined
		// into a notification body. The full value stays on the task record.
		return cancelReason ? `${base}取消理由: ${truncateTaskDescription(cancelReason, 200)}` : base;
	}
	return "该任务已由用户通过 /subagent-cancel 取消，属用户主动操作。请勿自动重新派发；如需重新派发，先询问用户。";
}

export function buildResultEnvelope(
	task: AsyncSubagentTask,
	result: SingleResult | null,
	status: SubagentTaskStatus,
	stopReason?: string,
	errorMessage?: string,
): { content: string; details: SubagentResultDetails } {
	const statusWord = STATUS_WORDS[status];
	const output = result ? getFinalOutput(result.messages) : "";
	const usage: UsageStats =
		result?.usage ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 };
	const sessionId = result?.sessionId ?? task.taskId;
	// Real run time when the subagent produced a result; for a null result
	// (user/agent cancel, session shutdown, internal error) the run never
	// reported back, so measure from the dispatch time instead.
	const durationMs = result
		? Math.max(0, (result.finishedAt ?? Date.now()) - result.startedAt)
		: Math.max(0, Date.now() - task.startedAt);
	let body = output;
	if (!body && result) body = result.errorMessage || result.stderr.trim();
	// Only genuine failures are labelled "内部错误"; a user cancel or session
	// shutdown rejection is an expected abort, so it gets a note carrying the
	// abort's origin (user cancel vs session shutdown).
	if (!body && errorMessage) body = status === "failure" ? `内部错误: ${errorMessage}` : abortedFallbackBody(stopReason, task.cancelledBy, task.cancelReason);
	const lines = [
		`## [subagent-result] ${task.agentName} ${statusWord} (taskId: ${task.taskId})`,
		"",
		`- 状态: ${statusWord}`,
		`- 任务: ${truncateTaskDescription(task.task)}`,
		`- 耗时: ${formatDuration(durationMs)} · 用量: ${formatUsageStats(usage, result?.model) || "-"}`,
		`- 会话: ${sessionId}`,
		"",
		// 在途 block: completeAsyncTask deletes this task from the registry
		// before building the envelope, so the list naturally excludes self.
		formatActiveTasks(),
		"",
		"---",
		body || (status === "cancelled" ? abortedFallbackBody(stopReason, task.cancelledBy, task.cancelReason) : "(no output)"),
	];
	return {
		content: lines.join("\n"),
		details: {
			taskId: task.taskId,
			agent: task.agentName,
			status: statusWord,
			exitCode: result?.exitCode ?? null,
			stopReason,
			cancelledBy: task.cancelledBy,
			durationMs,
			usage,
			sessionId,
			output:
				output.length > DETAILS_OUTPUT_MAX_CHARS
					? `${output.slice(0, DETAILS_OUTPUT_MAX_CHARS)}\n... (truncated; full output in content)`
					: output,
		},
	};
}

/** Build the dispatch receipt returned immediately by execute() in TUI mode. */
function buildDispatchReceipt(agentName: string, taskId: string): string {
	// Async-semantics guidance (don't poll, don't fabricate, result arrives as a
	// [subagent-result] notification) lives in the tool description /
	// promptGuidelines; the receipt stays a single line.
	return `已派出 ${agentName}. taskId: ${taskId}`;
}

/**
 * Build the two-step-confirmation challenge for action="cancel" (first call,
 * confirm !== true): a zero-side-effect receipt spelling out what a cancel
 * would destroy — agent, task summary, elapsed time, last progress — plus the
 * exact second-call shape. The main agent must confirm deliberately instead
 * of reflexively cancelling a healthy in-flight task.
 */
function buildCancelChallenge(task: AsyncSubagentTask): string {
	const lastActivityAt = progressManager.getLastActivityAt(task.taskId);
	let progressLine: string;
	if (lastActivityAt === undefined) {
		progressLine = "- 最近进度: 尚无进度上报（no progress reported yet）。";
	} else {
		// Read the clock once and derive both language phrases from that single
		// value — two Date.now() reads could straddle a second boundary and
		// disagree ("5 秒前 (6s ago)").
		const ageSec = Math.max(0, Math.floor((Date.now() - lastActivityAt) / 1000));
		// Under an hour, plain seconds read best; past that, fold into
		// formatDuration (H:MM:SS) instead of a huge second count.
		progressLine =
			ageSec < 3600
				? `- 最近进度更新: ${ageSec} 秒前 (last activity ${ageSec}s ago)。`
				: `- 最近进度更新: ${formatDuration(ageSec * 1000)} 前 (last activity ${formatDuration(ageSec * 1000)} ago)。`;
	}
	return [
		`取消确认请求 (cancel confirmation required): 任务 ${task.taskId} 仍在运行；本次调用未取消任何东西。`,
		`- agent: ${task.agentName}`,
		`- 任务: ${truncateTaskDescription(task.task)}`,
		`- 已运行: ${formatDuration(Date.now() - task.startedAt)} (elapsed since dispatch)`,
		progressLine,
		"",
		"⚠️ 取消将丢弃该任务的全部在途进度，且不可撤销（cancelling discards all in-flight progress and cannot be undone）。",
		`如确认取消，再次调用 subagent 工具: action="cancel" + taskId="${task.taskId}" + confirm:true + reason（reason 必填，说明取消理由）。`,
	].join("\n");
}

/**
 * Finalize an async task: unregister progress, drop it from the registry, and
 * push the [subagent-result] notification. Called exactly once per task, on
 * both success (result) and abort (result === null; the task record carries
 * whether it was a user cancel or a session shutdown).
 */
function completeAsyncTask(pi: ExtensionAPI, task: AsyncSubagentTask, result: SingleResult | null, error?: unknown): void {
	// unregister is best-effort: a widget failure must not skip registry
	// cleanup or the result notification, nor become an unhandled rejection
	// in the .then chain that invoked us.
	try {
		progressManager.unregister(task.taskId);
	} catch {
		/* progress widget is non-critical */
	}
	taskRegistry.delete(task.taskId);
	// result === null means runSingleAgent rejected. Abort rejections carry
	// the reason on the task record (user cancel / session shutdown); a
	// rejection with the task still "running" is an internal failure (e.g.
	// the prompt temp-file write failed) and must not be misreported as a
	// cancellation.
	const status: SubagentTaskStatus = !result
		? task.status === "running"
			? "failure"
			: "cancelled"
		: task.status !== "running"
			? "cancelled"
			: getTaskStatus(result);
	const stopReason =
		result?.stopReason ??
		(task.status === "killed_on_shutdown"
			? "killed_on_shutdown"
			: task.status === "cancelled"
				? "aborted"
				: !result
					? "internal_error"
					: undefined);
	// Record the finish for the no-argument /subagent-result picker before the
	// notification goes out; failures of the picker list must not affect this.
	recordCompletedTask(task, status);
	// Carry the rejection reason into the envelope so internal failures
	// (e.g. the prompt temp-file write failed) are diagnosable instead of
	// showing a bare "(no output)".
	const errorMessage = !result && error ? (error instanceof Error ? error.message : String(error)) : undefined;
	try {
		// buildResultEnvelope is pure and low-risk, but a throw here would
		// become an unhandled rejection in the .then chain — keep it inside
		// the same guard as sendMessage.
		const envelope = buildResultEnvelope(task, result, status, stopReason, errorMessage);
		pi.sendMessage(
			{ customType: "subagent-result", content: envelope.content, display: true, details: envelope.details },
			{ deliverAs: "steer", triggerTurn: true },
		);
	} catch {
		// The session may already be gone (e.g. after session_shutdown); the
		// task is finished either way, so notification errors are swallowed.
	}
}

const AgentScopeSchema = StringEnum(["user", "project", "both"] as const, {
	description: 'Which agent directories to use. Default: "both". Use "user" or "project" to limit scope.',
	default: "both",
});

// Union-of-literals (anyOf + const) rather than StringEnum so the emitted
// JSON Schema enumerates each action as its own const branch.
const SubagentActionSchema = Type.Union(
	[Type.Literal("dispatch"), Type.Literal("cancel")],
	{
		description:
			'Action to perform. "dispatch" (default): delegate the task to a subagent. "cancel": cancel a running background task by taskId.',
		default: "dispatch",
	},
);

const SubagentParams = Type.Object({
	action: Type.Optional(SubagentActionSchema),
	agent: Type.Optional(Type.String({ description: "Name of the agent to invoke (required for action=dispatch)" })),
	task: Type.Optional(Type.String({ description: "Task to delegate (required for action=dispatch). Must be non-empty and include background, input, requirements, output format, and acceptance criteria." })),
	taskId: Type.Optional(Type.String({
		description: "taskId of the running background subagent task to cancel (required for action=cancel; from the dispatch receipt).",
	})),
	confirm: Type.Optional(Type.Boolean({
		description:
			'Set true to actually execute an action=cancel after reviewing the challenge returned by the first call. Default: false — the first action=cancel call only returns a challenge (confirmRequired) and cancels nothing.',
		default: false,
	})),
	reason: Type.Optional(Type.String({
		description:
			"Why the task is being cancelled (required and must be non-empty when confirm=true). Recorded on the task and quoted in the [subagent-result] envelope.",
	})),
	sessionId: Type.Optional(Type.String({
		pattern: "^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$",
		description: "仅用于复用此前 dispatch 回执返回的 UUID v7；省略则自动生成",
	})),
	agentScope: Type.Optional(AgentScopeSchema),
	confirmProjectAgents: Type.Optional(
		Type.Boolean({ description: "Prompt before running project-local agents. Default: false.", default: false }),
	),
	cwd: Type.Optional(Type.String({ description: "Working directory for the agent process" })),
});

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "subagent",
		label: "Subagent",
		description: [
			"Delegate a task to a specialized subagent with isolated context.",
			"",
			"ACTIONS (action parameter, default \"dispatch\"):",
			"- dispatch: delegate the task (async in TUI mode, blocking otherwise).",
			"- cancel: request cancellation of a running background task by taskId (two-step: the first call returns a challenge; confirm:true + reason executes).",
			"- sessionId: only set when resuming (复用) a previously dispatched task. Must be the UUID v7 from a previous dispatch receipt. Omit otherwise; a new UUID v7 is generated automatically.",
			"",
			"ASYNC (TUI mode): returns immediately with a dispatch receipt (taskId + session id).",
			"The result arrives later as a system notification message prefixed with",
			"[subagent-result] — that is a system notification, NOT a user request.",
			"- Do NOT treat the receipt as the result. Do NOT fabricate results.",
			"- Do NOT poll for results; they arrive automatically.",
			"- Continue with independent work, or end the turn. Process the result when",
			"  the [subagent-result] notification arrives. Reuse the session id from the",
			"  receipt to continue the same task later.",
			"",
			"CANCEL DISCIPLINE: cancel a task (action=\"cancel\") only when it is clearly",
			"wrong (错误) or no longer needed (不再需要). Agent-initiated cancel is a",
			"two-step confirmation: the first action=\"cancel\" call only returns a",
			"challenge (confirmRequired) with elapsed time and last progress, and",
			"cancels nothing; to actually cancel, call action=\"cancel\" again with the",
			"same taskId + confirm:true + a non-empty reason (理由). Do NOT cancel just",
			"because it is taking a long time — background subagents are expected to",
			"run long; be patient (耐心等待) and let the [subagent-result]",
			"notification arrive.",
			"",
			"WAITING: 对在途任务不存在查询/催办/状态确认类动作（no query, nag or status",
			"action for in-flight tasks）——没有提供这类动作是刻意设计。等待 = 不发",
			"起任何工具调用，直接结束回合（waiting means no tool call: end the turn）。",
			"",
			"SYNC (non-TUI modes): waits for the subagent to finish and returns the full",
			"result directly (no notification follows).",
			"",
			"Task must be non-empty and include background, input, requirements, output",
			"format, and acceptance criteria.",
		].join("\n"),
		promptSnippet:
			"Delegate a task to a specialized subagent in an isolated process (async dispatch in TUI mode, blocking otherwise).",
		promptGuidelines: [
			"subagent: In TUI mode this tool is asynchronous — it returns a dispatch receipt, not the result; the real result arrives later as a [subagent-result] system notification, so never fabricate results and never poll.",
			"subagent: A message prefixed with [subagent-result] is a system notification carrying a finished subagent result, not a user request; process it in the context of the task that dispatched it.",
			"subagent: Dispatch subagents driven by task dependencies — delegate only work whose result you actually need, prefer reusing the session id from the receipt to continue a previous subagent task, and keep independent work in the main context.",
			"subagent: The session id is the lowercase UUID v7 returned in the dispatch receipt (e.g. `019ffdd3-3eb5-733d-b481-a53e5292bd00`). Passing any other string (slug, UUID v4, etc.) is rejected; only pass sessionId when resuming a previously dispatched task.",
			"subagent: A [subagent-result] notification with status 已取消 (cancelled) can come from the user (/subagent-cancel) or from you (action=\"cancel\"); the envelope body states the source. A user-initiated cancel is a deliberate user action, so do NOT automatically retry or re-dispatch it; ask the user before re-dispatching.",
			"subagent: Cancelling a background task is a two-step confirmation: the first action=\"cancel\" call only returns a challenge (confirmRequired) and cancels nothing; to actually cancel, call again with the same taskId + confirm:true + a non-empty reason explaining why. Never cancel just because a task runs long.",
			"subagent: Waiting for a background task means making NO tool call at all and ending the turn (等待 = 不发起任何工具调用、直接结束回合); there is deliberately no query, nag or status action for in-flight tasks — results arrive on their own as [subagent-result] notifications.",
			"subagent: Before dispatching multiple tasks in parallel, consider whether they touch the same files or code areas — parallel tasks modifying the same files can conflict. When in doubt, dispatch sequentially or ask the user.",
			"subagent: The in-flight block in a [subagent-result] envelope is a build-time snapshot (构建时刻快照) anchored to that task's end event and may be stale (可能滞后) by the time you process the notification; if it conflicts with dispatch records you issued yourself this turn, trust your dispatch records (冲突时以派发记录为准).",
		],
		parameters: SubagentParams,

		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			// Single-entry action dispatch (default "dispatch").
			const action = (params.action as string | undefined) ?? "dispatch";

			// Depth gate runs BEFORE any action dispatch: a subagent (depth >= 1)
			// is blocked from every action — dispatch spawns a nested subagent, and
			// cancel would let it kill the parent's in-flight tasks. The tool surface
			// simply does not exist inside a subagent.
			const currentDepth = parseEnvInt(process.env.PI_SUBAGENT_DEPTH, 0);
			if (currentDepth >= MAX_SUBAGENT_DEPTH) {
				const agentName = process.env.PI_CURRENT_AGENT_NAME || "current agent";
				return {
					content: [{
						type: "text",
						text: `Subagent tool is blocked: depth limit reached (depth: ${currentDepth}, max: ${MAX_SUBAGENT_DEPTH}). Agent \`${agentName}\` runs inside a subagent and cannot invoke subagent actions (dispatch/cancel).`,
					}],
					details: {
						mode: "single",
						agentScope: (params.agentScope ?? "both") as AgentScope,
						projectAgentsDir: null,
						results: [],
					} as SubagentDetails,
					isError: true,
				};
			}

			if (action === "cancel") {
				const taskId = typeof params.taskId === "string" ? params.taskId.trim() : "";
				if (!taskId) {
					return {
						content: [{ type: "text", text: 'Missing or empty required parameter: "taskId" (taskId 必填，不能为空).' }],
						details: { taskId: "", cancelled: false },
						isError: true,
					};
				}
				// Only registry (async/TUI) tasks are cancellable; sync-mode tasks are
				// awaited inline and never enter the registry. Existence is checked
				// BEFORE the confirm/reason gates so a wrong id always fails the same
				// way regardless of confirmation state.
				const task = taskRegistry.get(taskId);
				if (!task || task.status !== "running") {
					return {
						content: [{ type: "text", text: `无此运行中任务: ${taskId} (no running subagent task with this id).` }],
						details: { taskId, cancelled: false },
						isError: true,
					};
				}
				// Two-step confirmation: the first call (confirm !== true) only
				// returns a challenge spelling out what would be destroyed — zero
				// side-effects (no status change, no abort, no notification). This
				// structural friction exists because the main agent used to fire
				// reflexive cancels at healthy in-flight tasks.
				if (params.confirm !== true) {
					return {
						content: [{ type: "text", text: buildCancelChallenge(task) }],
						details: { taskId, cancelled: false, confirmRequired: true },
					};
				}
				// A confirmed cancel must justify itself: the reason is recorded on
				// the task record and quoted in the [subagent-result] envelope body.
				const reason = typeof params.reason === "string" ? params.reason.trim() : "";
				if (!reason) {
					return {
						content: [{ type: "text", text: 'Missing or empty required parameter: "reason" (confirm:true 时 reason 必填，不能为空).' }],
						details: { taskId, cancelled: false },
						isError: true,
					};
				}
				cancelTask(taskId, "agent", reason);
				return {
					content: [{ type: "text", text: `已发送取消请求: ${taskId} (cancel request sent); 结果稍后以 [subagent-result] 通知返回。\n${formatRemainingTasksAfterCancelRequest()}` }],
					details: { taskId, cancelled: true },
				};
			}

			if (action !== "dispatch") {
				return {
					content: [{ type: "text", text: `Invalid action: "${action}". Must be one of "dispatch" (default), "cancel".` }],
					details: {
						mode: "single",
						agentScope: (params.agentScope ?? "both") as AgentScope,
						projectAgentsDir: null,
						results: [],
					} as SubagentDetails,
					isError: true,
				};
			}

			const agentName = params.agent;
			const task = typeof params.task === "string" ? params.task.trim() : "";

			if (!agentName) {
				return {
					content: [
						{
							type: "text",
							text: 'Missing required parameter: "agent". Please specify the name of the agent to invoke.',
						},
					],
					details: {
						mode: "single",
						agentScope: (params.agentScope ?? "both") as AgentScope,
						projectAgentsDir: null,
						results: [],
					} as SubagentDetails,
					isError: true,
				};
			}

			if (!task) {
				return {
					content: [
						{
							type: "text",
							text: 'Missing or empty required parameter: "task". The task must be non-empty and should include the five-section structure from master.md: 背景 (background), 输入 (input), 要求 (requirements), 输出格式 (output format), and 验收标准 (acceptance criteria).',
						},
					],
					details: {
						mode: "single",
						agentScope: (params.agentScope ?? "both") as AgentScope,
						projectAgentsDir: null,
						results: [],
					} as SubagentDetails,
					isError: true,
				};
			}

			// Validate an explicit sessionId up front: in async mode the failure
			// must surface before the dispatch receipt, not after it.
			if (params.sessionId !== undefined) {
				const invalidSessionIdMessage = validateSessionId(params.sessionId);
				if (invalidSessionIdMessage) {
					return {
						content: [{ type: "text", text: invalidSessionIdMessage }],
						details: {
							mode: "single",
							agentScope: (params.agentScope ?? "both") as AgentScope,
							projectAgentsDir: null,
							results: [],
						} as SubagentDetails,
						isError: true,
					};
				}
			}

			const agentScope: AgentScope = params.agentScope ?? "both";
			const discovery = discoverAgents(ctx.cwd, agentScope);
			const agents = discovery.agents;
			const modelOverrides = loadModelOverrides(ctx.cwd);
			const confirmProjectAgents = params.confirmProjectAgents ?? false;

			const makeDetails = (results: SingleResult[]): SubagentDetails => ({
				mode: "single",
				agentScope,
				projectAgentsDir: discovery.projectAgentsDir,
				results,
			});

			if ((agentScope === "project" || agentScope === "both") && confirmProjectAgents && ctx.hasUI) {
				const projectAgent = agents.find((a) => a.name === params.agent && a.source === "project");

				if (projectAgent) {
					const dir = discovery.projectAgentsDir ?? "(unknown)";
					const ok = await ctx.ui.confirm(
						"Run project-local agents?",
						`Agents: ${projectAgent.name}\nSource: ${dir}\n\nProject agents are repo-controlled. Only continue for trusted repositories.`,
					);
					if (!ok)
						return {
							content: [{ type: "text", text: "Canceled: project-local agents not approved." }],
							details: makeDetails([]),
						};
				}
			}

			// The tool area is rendered only once, when execute() returns the final
			// result. Live progress goes through the progress manager's widget, not
			// the TUI render pipeline.
			const effectiveSessionId = params.sessionId?.trim() ?? uuidv7();

			// Refuse to clobber an in-flight async task with the same id (the
			// receipt encourages sessionId reuse, so the model can legitimately
			// re-send one). Overwriting the registry entry would orphan the first
			// process, break its completion callback and /subagent-cancel, and mix
			// two writers into the same session directory.
			if (ctx.mode === "tui" && taskRegistry.has(effectiveSessionId)) {
				return {
					content: [
						{
							type: "text",
							text: `A background subagent task with id "${effectiveSessionId}" is already running (同 sessionId 的任务仍在运行). Wait for its [subagent-result] notification, cancel it with /subagent-cancel ${effectiveSessionId}, or omit sessionId to start a new task.`,
						},
					],
					details: makeDetails([]),
					isError: true,
				};
			}

			progressManager.register(ctx, effectiveSessionId, agentName);

			// TUI mode: dispatch asynchronously. execute() returns a receipt
			// immediately; the finished result is pushed later as a
			// [subagent-result] notification via pi.sendMessage. Non-TUI modes
			// (mode undefined included) fall through to the sync path below.
			if (ctx.mode === "tui") {
				const taskRecord: AsyncSubagentTask = {
					taskId: effectiveSessionId,
					agentName,
					task,
					startedAt: Date.now(),
					// Per-task controller: the turn-level `signal` fires when the
					// dispatching turn ends, which would wrongly kill the
					// background subagent.
					abortController: new AbortController(),
					status: "running",
				};
				taskRegistry.set(effectiveSessionId, taskRecord);
				runSingleAgent(
					ctx.cwd,
					agents,
					agentName,
					task,
					params.cwd,
					undefined,
					effectiveSessionId,
					taskRecord.abortController.signal,
					(update) => progressManager.update(effectiveSessionId, update),
					ctx.model,
					modelOverrides,
					(proc) => {
						taskRecord.proc = proc;
						// Shutdown may have fired while the prompt temp file was being
						// written (no proc handle existed yet); apply the session_shutdown
						// SIGKILL backstop now.
						if (taskRecord.status === "killed_on_shutdown") {
							try {
								proc.kill("SIGKILL");
							} catch {
								/* ignore ESRCH */
							}
						}
					},
				).then(
					(result) => completeAsyncTask(pi, taskRecord, result),
					// Rejections: abort (cancel/shutdown — the reason is on the task
					// record) or an internal failure; completeAsyncTask maps the record
					// to the right status.
					(err) => completeAsyncTask(pi, taskRecord, null, err),
				);
				return {
					content: [{ type: "text", text: buildDispatchReceipt(agentName, effectiveSessionId) }],
					details: makeDetails([]),
				};
			}

			try {
				const result = await runSingleAgent(
					ctx.cwd,
					agents,
					agentName,
					task,
					params.cwd,
					undefined,
					effectiveSessionId,
					signal,
					(update) => progressManager.update(effectiveSessionId, update),
					ctx.model,
					modelOverrides,
				);
				const isError = result.exitCode !== 0 || result.stopReason === "error" || result.stopReason === "aborted";
				if (isError) {
					const diagnostics = formatSubagentDiagnostics(result) + `\n\n[subagent session: ${result.sessionId}]`;
					return {
						content: [{ type: "text", text: diagnostics }],
						details: makeDetails([result]),
						isError: true,
					};
				}
				const rawOutput = getFinalOutput(result.messages);
				const outputText = rawOutput
					? `${rawOutput}\n\n[subagent session: ${result.sessionId}]`
					: `[subagent session: ${result.sessionId}]`;
				return {
					content: [{ type: "text", text: outputText }],
					details: makeDetails([result]),
				};
			} finally {
				progressManager.unregister(effectiveSessionId);
			}
		},

		renderCall(args, theme, context) {
			const component = context.lastComponent instanceof Text ? context.lastComponent : new Text("", 0, 0);
			if (context.isPartial) {
				// Still executing: render nothing so the tool row is invisible.
				component.setText("");
				return component;
			}
			const agentName = args.agent || "...";
			const text =
				theme.fg("toolTitle", theme.bold("subagent ")) +
				theme.fg("accent", agentName);
			component.setText(text);
			return component;
		},

		renderResult(result, { expanded }, theme, context) {
			const details = result.details as SubagentDetails | undefined;
			// cancel receipts carry no `results` array (taskId+cancelled instead)
			// — fall back to the plain-text content instead of throwing on
			// details.results.length.
			if (!details || !Array.isArray(details.results) || details.results.length === 0) {
				return new Text(result.content?.[0]?.type === "text" ? result.content[0].text : "(no output)", 0, 0);
			}

			const mdTheme = getMarkdownTheme();

			const renderDisplayItems = (items: DisplayItem[], limit?: number) => {
				const toShow = limit ? items.slice(-limit) : items;
				const skipped = limit && items.length > limit ? items.length - limit : 0;
				let text = "";
				if (skipped > 0) text += theme.fg("muted", `... ${skipped} earlier items\n`);
				for (const item of toShow) {
					if (item.type === "text") {
						const preview = expanded ? item.text : item.text.split("\n").slice(0, 3).join("\n");
						text += `${theme.fg("toolOutput", preview)}\n`;
					} else {
						text += `${theme.fg("muted", "→ ") + formatToolCall(item.name, item.args, theme.fg.bind(theme))}\n`;
					}
				}
				return text.trimEnd();
			};

			if (details.mode === "single" && details.results.length === 1) {
				const r = details.results[0];
				const isError = r.exitCode !== 0 || r.stopReason === "error" || r.stopReason === "aborted";
				const icon = isError ? theme.fg("error", "✗") : theme.fg("success", "✓");
				const displayItems = getDisplayItems(r.messages);
				const finalOutput = getFinalOutput(r.messages);
				// Run duration, shown only when both timestamps are present (older
				// results lack them); a typeof check keeps 0ms runs visible and
				// missing fields from rendering "NaN".
				const durationStr =
					typeof r.startedAt === "number" && Number.isFinite(r.startedAt) &&
					typeof r.finishedAt === "number" && Number.isFinite(r.finishedAt)
						? formatDuration(r.finishedAt - r.startedAt)
						: null;

				if (expanded) {
					const container = new Container();
					let header = `${icon} ${theme.fg("toolTitle", theme.bold(r.agent))}${theme.fg("muted", ` (${r.agentSource})`)}`;
					if (isError && r.stopReason) header += ` ${theme.fg("error", `[${r.stopReason}]`)}`;
					if (r.phase !== "idle") header += ` ${theme.fg("warning", formatPhase(r.phase))}`;
					header += ` ${theme.fg("muted", `[session: ${r.sessionId}]`)}`;
					if (durationStr) header += ` ${theme.fg("dim", durationStr)}`;
					container.addChild(new Text(header, 0, 0));
					if (isError && r.errorMessage)
						container.addChild(new Text(theme.fg("error", `Error: ${r.errorMessage}`), 0, 0));
					if (r.thinkingBuffer) {
						container.addChild(new Spacer(1));
						container.addChild(new Text(theme.fg("muted", "─── Thinking ───"), 0, 0));
						const lines = r.thinkingBuffer.trim().split("\n");
						const recent = lines.slice(-5).join("\n");
						container.addChild(new Text(theme.fg("dim", recent), 0, 0));
					}
					container.addChild(new Spacer(1));
					container.addChild(new Text(theme.fg("muted", "─── Task ───"), 0, 0));
					container.addChild(new Text(theme.fg("dim", r.task), 0, 0));
					container.addChild(new Spacer(1));
					container.addChild(new Text(theme.fg("muted", "─── Output ───"), 0, 0));
					if (displayItems.length === 0 && !finalOutput) {
						container.addChild(new Text(theme.fg("muted", "(no output)"), 0, 0));
					} else {
						for (const item of displayItems) {
							if (item.type === "toolCall")
								container.addChild(
									new Text(
										theme.fg("muted", "→ ") + formatToolCall(item.name, item.args, theme.fg.bind(theme)),
										0,
										0,
									),
								);
						}
						if (finalOutput) {
							container.addChild(new Spacer(1));
							container.addChild(new Markdown(finalOutput.trim(), 0, 0, mdTheme));
						}
					}
					const usageStr = formatUsageStats(r.usage, r.model);
					if (usageStr) {
						container.addChild(new Spacer(1));
						container.addChild(new Text(theme.fg("dim", usageStr), 0, 0));
					}
					return container;
				}

				let text = `${icon} ${theme.fg("toolTitle", theme.bold(r.agent))}${theme.fg("muted", ` (${r.agentSource})`)}`;
				if (isError && r.stopReason) text += ` ${theme.fg("error", `[${r.stopReason}]`)}`;
				if (r.phase !== "idle") text += ` ${theme.fg("warning", formatPhase(r.phase))}`;
				text += ` ${theme.fg("muted", `[session: ${r.sessionId}]`)}`;
				if (durationStr) text += ` ${theme.fg("dim", durationStr)}`;
				if (isError && r.errorMessage) text += `\n${theme.fg("error", `Error: ${r.errorMessage}`)}`;
				if (displayItems.length === 0) {
					if (!isError || !r.errorMessage) text += `\n${theme.fg("muted", "(no output)")}`;
				} else {
					text += `\n${renderDisplayItems(displayItems, COLLAPSED_ITEM_COUNT)}`;
					if (displayItems.length > COLLAPSED_ITEM_COUNT) text += `\n${theme.fg("muted", "(Ctrl+O to expand)")}`;
				}
				const usageStr = formatUsageStats(r.usage, r.model);
				if (usageStr) text += `\n${theme.fg("dim", usageStr)}`;
				const component = context.lastComponent instanceof Text ? context.lastComponent : new Text("", 0, 0);
				component.setText(text);
				return component;
			}

			return new Text(theme.fg("muted", "(no subagent result)"), 0, 0);
		}
	});

	// /subagent-cancel <taskId> is the user's cancel path.
	// (Optional-call guards keep minimal mock `pi` objects in tests working.)
	pi.registerCommand?.("subagent-cancel", {
		description: "Cancel a running background subagent task (usage: /subagent-cancel <taskId>)",
		handler: async (args, cmdCtx) => {
			let taskId = (args ?? "").trim();
			if (!taskId) {
				const runningTasks = [...taskRegistry.values()].filter((t) => t.status === "running");
				// TUI with running tasks: interactive picker (Enter cancels, Esc/q
				// dismisses without doing anything). Non-TUI and the empty case keep
				// the original notify fallback.
				if (cmdCtx.hasUI && cmdCtx.mode === "tui" && runningTasks.length > 0) {
					const items: SelectItem[] = runningTasks.map((t) =>
						taskPickerItem(t.taskId, `${t.agentName}: ${truncateTaskDescription(t.task, 60)}`),
					);
					const picked = await pickTaskInteractively(cmdCtx.ui, "取消运行中任务 (cancel subagent task)", items);
					if (picked === undefined) return;
					taskId = picked;
				} else {
					// No argument: list the running tasks so the user knows what to cancel.
					const running = runningTasks.map((t) => t.taskId);
					const hint = running.length > 0 ? ` Running tasks: ${running.join(", ")}.` : " No running tasks.";
					cmdCtx.ui?.notify?.(`No running subagent task with id "(none)".${hint}`, "warning");
					return;
				}
			}
			if (!cancelTask(taskId, "user")) {
				cmdCtx.ui?.notify?.(`No running subagent task with id "${taskId}".`, "warning");
				return;
			}
			cmdCtx.ui?.notify?.(`Subagent task ${taskId} cancelled.`, "info");
		},
	});

	// /subagent-cancel-all cancels every running background subagent task at once.
	// Each task goes through the shared cancelTask path (cancelledBy = "user"), so
	// the abort -> SIGTERM cascade and the per-task cancelled envelope are
	// identical to cancelling them one by one via /subagent-cancel.
	pi.registerCommand?.("subagent-cancel-all", {
		description: "Cancel all running background subagent tasks (usage: /subagent-cancel-all)",
		handler: async (_args, cmdCtx) => {
			const running = [...taskRegistry.values()].filter((t) => t.status === "running");
			if (running.length === 0) {
				cmdCtx.ui?.notify?.("无运行中任务可取消 (no running subagent tasks).", "info");
				return;
			}
			let cancelled = 0;
			for (const task of running) {
				if (cancelTask(task.taskId, "user")) cancelled++;
			}
			cmdCtx.ui?.notify?.(`已取消全部 ${cancelled} 个运行中任务 (cancelled ${cancelled} running subagent task(s)).`, "info");
		},
	});

	// Read-back belongs to the user only: /subagent-result <taskId> prints the
	// full final assistant text of a finished background subagent task. The
	// notification card stays minimal on purpose; the full result lives in the
	// task's session file under subagent-sessions/<taskId>/.
	pi.registerCommand?.("subagent-result", {
		description: "Show the full final result of a background subagent task (usage: /subagent-result <taskId>)",
		handler: async (args, cmdCtx) => {
			let taskId = (args ?? "").trim();
			if (!taskId) {
				// TUI: interactive picker over the most recent finished tasks (Enter
				// opens the same viewer as the with-argument path below, Esc/q
				// dismisses without doing anything). Non-TUI keeps the usage hint.
				if (cmdCtx.hasUI && cmdCtx.mode === "tui") {
					const recent = listViewableFinishedTasks(5);
					if (recent.length === 0) {
						cmdCtx.ui?.notify?.("没有已运行结束的子 agent 任务记录 (no finished subagent tasks)。", "warning");
						return;
					}
					const items: SelectItem[] = recent.map((r) => taskPickerItem(r.taskId, `${r.agentName} · ${STATUS_WORDS[r.status]}`));
					const picked = await pickTaskInteractively(cmdCtx.ui, "查看已结束任务结果 (subagent result)", items);
					if (picked === undefined) return;
					taskId = picked;
				} else {
					cmdCtx.ui?.notify?.("Usage: /subagent-result <taskId> — 查看某子 agent 的完整返回。", "warning");
					return;
				}
			}
			// Refuse mid-flight reads: while the task is in the registry its
			// session file only holds a partial snapshot.
			if (taskRegistry.has(taskId)) {
				cmdCtx.ui?.notify?.(`任务仍在运行，完成后才能查看: ${taskId}`, "warning");
				return;
			}
			const file = findSessionFile(taskId);
			if (!file) {
				cmdCtx.ui?.notify?.(`无此任务记录: ${taskId}`, "warning");
				return;
			}
			const text = extractSessionTranscript(file);
			if (!text) {
				cmdCtx.ui?.notify?.(`任务无最终输出（未产生 assistant 文本，可能已被终止）: ${taskId}\n会话文件: ${file}`, "warning");
				return;
			}
			// pi discards a command handler's return value, so the full text is
			// shown in a fullscreen read-only viewer (same pattern as the
			// summarize example); outside the TUI fall back to console.log.
			if (cmdCtx.hasUI && cmdCtx.mode === "tui") {
				await cmdCtx.ui.custom((tui, theme, _kb, done) => {
					const border = new DynamicBorder((s: string) => theme.fg("accent", s));
					// Title row doubles as the key-hint row (the footer row was pushed
					// off-screen). Truncated from the tail at render time so the front
					// keys stay visible when the combined line exceeds the width.
					const titleText =
						theme.fg("accent", theme.bold(`Subagent Result: ${taskId}`)) +
						theme.fg("dim", "  ↑↓/jk 滚动 · Space/b 翻页 · g/G 首尾 · Enter/Esc/q 关闭");
					const md = new Markdown(text.trim(), 1, 1, getMarkdownTheme());
					// Scroll state: render(width) slices the fully-rendered markdown
					// lines to the visible window; handleInput moves the window.
					let scrollOffset = 0;
					let lastWidth = 80;
					// Overhead: top border + title + bottom border = 3 rows.
					const visibleHeight = () => Math.max(1, (process.stdout.rows || 24) - 3);
					const maxScroll = () => Math.max(0, md.render(lastWidth).length - visibleHeight());
					return {
						render: (width: number) => {
							lastWidth = width;
							scrollOffset = Math.min(scrollOffset, maxScroll());
							const body = md.render(width).slice(scrollOffset, scrollOffset + visibleHeight());
							const title = new Text(truncateToWidth(titleText, width - 2), 1, 0);
							return [
								...border.render(width),
								...title.render(width),
								...body,
								...border.render(width),
							];
						},
						invalidate: () => md.invalidate(),
						handleInput: (data: string) => {
							if (matchesKey(data, Key.enter) || matchesKey(data, Key.escape) || matchesKey(data, "q") || matchesKey(data, Key.shift("q"))) {
								done(undefined);
								return;
							}
							if (matchesKey(data, Key.up) || matchesKey(data, "k")) {
								scrollOffset = Math.max(0, scrollOffset - 1);
							} else if (matchesKey(data, Key.down) || matchesKey(data, "j")) {
								scrollOffset = Math.min(maxScroll(), scrollOffset + 1);
							} else if (matchesKey(data, Key.pageUp) || matchesKey(data, "b")) {
								// 整页翻页：一页 = 当前可见行数
								scrollOffset = Math.max(0, scrollOffset - visibleHeight());
							} else if (matchesKey(data, Key.pageDown) || matchesKey(data, Key.space)) {
								scrollOffset = Math.min(maxScroll(), scrollOffset + visibleHeight());
							} else if (matchesKey(data, Key.home) || matchesKey(data, "g")) {
								scrollOffset = 0;
							} else if (matchesKey(data, Key.end) || matchesKey(data, Key.shift("g"))) {
								scrollOffset = maxScroll();
							} else {
								return;
							}
							tui?.requestRender?.();
						},
					};
				});
			} else {
				console.log(`\n[subagent-result] taskId: ${taskId}\n\n${text}\n`);
			}
		},
	});

	// Kill all in-flight background subagents when the session goes away
	// (quit / reload / session switch).
	pi.on?.("session_shutdown", async () => {
		for (const task of taskRegistry.values()) {
			if (task.status === "running") {
				task.status = "killed_on_shutdown";
				task.abortController.abort();
			}
			// SIGKILL backstop: abort() only sends SIGTERM, and the 5s SIGKILL
			// escalation timer inside runSingleAgent never fires when the main
			// process quits right after shutdown — a SIGTERM-ignoring child would
			// be orphaned. The session is going away either way, so skip the
			// grace period and SIGKILL any still-alive process immediately —
			// including already-cancelled tasks still inside their SIGTERM grace
			// window.
			const proc = task.proc;
			if (proc && proc.exitCode === null && proc.signalCode === null) {
				try {
					proc.kill("SIGKILL");
				} catch {
					/* ignore ESRCH */
				}
			}
		}
	});

	// Render [subagent-result] notifications as a minimal card: the full result
	// text stays in the envelope content (LLM context) but is NOT rendered in
	// the UI; the user can read it with /subagent-result <taskId>.
	pi.registerMessageRenderer?.("subagent-result", (message, _options, theme) => {
		try {
			const details = message.details as SubagentResultDetails | undefined;
			const status = details?.status ?? "";
			const isOk = status === STATUS_WORDS.success;
			const icon = isOk ? theme.fg("success", "✓") : theme.fg("error", "✗");
			let text = `${icon} ${theme.fg("toolTitle", theme.bold(details?.agent ?? "subagent"))}`;
			if (status) text += ` ${theme.fg(isOk ? "success" : "error", status)}`;
			if (details?.taskId) text += ` ${theme.fg("muted", `(taskId: ${details.taskId})`)}`;
			const usageStr = details ? formatUsageStats(details.usage) : "";
			if (usageStr) text += ` ${theme.fg("dim", usageStr)}`;
			// durationMs is typed as a number and 0 is a valid duration, so the
			// presence check must not be falsy-based; old-shape details without
			// it simply omit the duration.
			if (typeof details?.durationMs === "number" && Number.isFinite(details.durationMs))
				text += ` ${theme.fg("dim", `耗时 ${formatDuration(details.durationMs)}`)}`;
			if (details?.taskId) text += `\n${theme.fg("muted", `查看全文: /subagent-result ${details.taskId}`)}`;
			// Background tint mirrors the dispatch-receipt tool rows: success and
			// failure reuse the tool-row colors; timeout, cancelled and unknown
			// states fall back to the neutral pending tint.
			const bg = isOk ? "toolSuccessBg" : status === STATUS_WORDS.failure ? "toolErrorBg" : "toolPendingBg";
			const box = new Box(1, 0, (s) => theme.bg(bg, s));
			box.addChild(new Text(text, 0, 0));
			return box;
		} catch {
			// Rendering must never break the session; fall back to raw content.
			return new Text(typeof message.content === "string" ? message.content : "", 0, 0);
		}
	});
}
