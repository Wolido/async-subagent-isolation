<div align="right"><a href="README.md">中文</a></div>

<div align="center"><img src="logo.svg" alt="async-subagent-isolation logo" width="150"></div>

# async-subagent-isolation

<div align="center">

[![TypeScript](https://img.shields.io/badge/TypeScript-3178C6?logo=typescript&logoColor=white)]()
[![Pi Package](https://img.shields.io/badge/Pi_Package-8B5CF6)]()
[![npm version](https://img.shields.io/npm/v/@wolido/async-subagent-isolation)](https://www.npmjs.com/package/@wolido/async-subagent-isolation)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

</div>

**async-subagent-isolation** is an extension for [Pi Agent](https://github.com/earendil-works/pi) and the **async evolution** of [subagent-isolation](https://github.com/Wolido/subagent-isolation) (the synchronous version).

The core constraint is unchanged: **the main agent can't touch code**. No `write`, no `edit`, no `bash` — only the four read-only tools `read`, `grep`, `find`, `ls`, plus a `subagent` tool for delegation. All file changes, shell commands, and execution logic go to subagents, each running in its own `pi` process with its own system prompt and skills. No shared state between the main agent and subagents, or between subagents.

The key difference is **async**: in TUI mode, the main agent dispatches a subagent and gets an **immediate receipt** (`已派出 <agent>. taskId: <taskId>`) without blocking. The subagent runs in a background process; when it finishes, the result arrives as a **[subagent-result] system notification**. If the main agent is idle the notification triggers processing right away; if busy, it queues. Meanwhile the main agent can dispatch multiple tasks in parallel and keep working.

---

## Sync vs async

This project is the async evolution of [subagent-isolation](https://github.com/Wolido/subagent-isolation). Both share the same goal — strip execution from the main agent and run it in isolated `pi` processes. The only difference is delegation semantics:

| | Sync (original) | Async (this project) |
|---|---|---|
| After dispatch | Blocks until the subagent finishes | **Returns a receipt immediately** (with `taskId`) |
| Result delivery | Inlined in the tool return value | Arrives as a `[subagent-result]` system notification |
| Parallelism | Each call blocks — serial only | Multiple tasks can be dispatched in parallel |
| Waiting period | Main agent's turn is occupied | Main agent continues other work |
| Result blocks the turn | Yes | No |

**The original project continues to be maintained as the synchronous version.** If you need synchronous, blocking semantics (results returned in place), use the original. If you need async parallelism and background execution, use this project.

---

## Why this matters

A model's effective context is not unlimited. When one agent reads code, edits files, and runs tests all at once, tool traces, errors, and intermediate results pile up fast. Once total context exceeds the threshold the model can handle reliably, reasoning quality drops — key details get drowned, work gets repeated, and decisions are made from noisy context.

The point of a subagent system is to split that ever-growing context into smaller pieces. Each agent handles only its own slice, so no single conversation is dragged down by historical noise.

**Async amplifies this benefit**: the main agent's turn is not occupied by the subagent's execution. Its context keeps only "what to do" and "what came back"; the subagent's long execution trail stays inside its own process and never pollutes the main agent's context.

## How this differs from plain subagents

Many subagent implementations are just "spawn a tool call inside the main agent." The subagent still reuses the main agent's prompt and skills, and the main agent still keeps write and shell access — isolation is optional and partial.

async-subagent-isolation enforces complete isolation:

- **Process isolation**: every subagent starts in its own `pi` process.
- **Prompt isolation**: each subagent has its own agent definition file (e.g., `coder.md`), not the main agent's `master.md`.
- **Skill isolation**: the main agent and each subagent load only their own skills, with no cross-contamination.
- **Execution isolation**: the main agent loses `write`, `edit`, and `bash`; it can only delegate.
- **Independent configuration**: each agent defines its own `tools` and `skills`, controlling exactly what it can and cannot do.

Plain subagents split work. async-subagent-isolation splits everything.

---

## Before / After

| Before | After |
|--------|-------|
| One agent plans and executes; context growth degrades reasoning | Main agent only plans and delegates; each subagent handles its own slice |
| Main agent keeps write and shell access; isolation is partial | Main agent loses `write`, `edit`, and `bash`; subagents run in isolated processes |
| All skills and tools pile up in one agent and interfere | Each subagent loads only the skills and tools it needs |
| Main agent idles while the subagent runs; the turn is blocked | Dispatch returns immediately; you can parallelize and keep working |

---

## Core design

| Role | Responsibility | Where it runs |
|------|----------------|---------------|
| Main agent | Understand requests, split tasks, delegate, and summarize | Your main `pi` session |
| Subagent | Read, edit, run checks, and return results | Isolated `pi --mode json` process |

Four levels of isolation:

- **Process isolation**: every subagent spawns a fresh `pi --mode json` process. Its system prompt is written to a temp file and injected via `--append-system-prompt`, so subagents never pollute each other.
- **Context isolation**: the subagent sees only the task you delegated, not the tool-call trail from the main agent.
- **Capability isolation**: the `tools` and `skills` fields give each subagent a precise, minimal toolbox.
- **Recursion boundary**: subagents cannot delegate further (depth limit = 1), keeping task scope manageable.

---

## Async workflow

This is the biggest difference from the sync version, and the primary way to use it (TUI mode).

### 1. Dispatch (the `subagent` tool)

The main agent calls the `subagent` tool, which spawns an isolated `pi` process for the subagent. **Non-TUI modes (print/json) automatically fall back to synchronous** — they wait for the subagent to finish and return the result directly, with no notification.

### 2. Receipt (returns immediately)

In TUI mode, `subagent` **returns a dispatch receipt immediately** and does not block:

```
已派出 coder. taskId: 01912345-6789-7abc-8def-0123456789ab
```

The `taskId` is the session ID; reuse it later to continue the same task. **The receipt is not the result** — do not fabricate results.

### 3. Background execution + progress widget

The subagent runs in a background process. A progress widget appears above the TUI editor, listing all in-flight tasks in real time (taskId, agent, current phase, elapsed time):

```
● 01912345-abcd... coder    ⚡ read...         01:23
```

### 4. Result notification (`[subagent-result]`)

When the subagent finishes, its result is pushed into the conversation as a **`[subagent-result]` system notification** — a system message, not a user request:

- If the main agent is **idle**, the notification triggers a new turn immediately.
- If the main agent is **busy**, the notification is queued and triggers a turn after the current one finishes.

Results arrive automatically — **no polling**. To confirm which tasks are still in flight (e.g. after a `/tree` rewind loses the receipts), use the `subagent_status` tool.

### 5. Read the full result (`/subagent-result`)

The notification card shows only a summary. The user reads the full result in a full-screen viewer via `/subagent-result <taskId>`: `↑↓`/`jk` scroll, `Space`/`b` page, `g`/`G` top/bottom, `Enter`/`Esc`/`q` close.

### The flow at a glance

```
Main agent dispatches subagent
      │ immediate receipt (已派出 <agent>. taskId: <id>)
      ▼
Subagent runs in a background process (progress widget updates live)
      │
      ▼
On completion, a [subagent-result] notification is pushed ──► processed now if idle, queued if busy
      │
      ▼
User runs /subagent-result <taskId> to read the full output
```

---

## Tools and commands

### Tools (for the main agent)

| Tool | Purpose | Key constraint |
|------|---------|----------------|
| `subagent` | Async dispatch (TUI mode); falls back to sync in non-TUI | Receipt ≠ result; results arrive as notifications, don't poll |
| `subagent_status` | List in-flight tasks (taskId, agent, description, **no elapsed time**) | Only confirm "what's still running"; never poll with it |
| `subagent_cancel` | Main agent cancels one in-flight task | Only when clearly wrong or no longer needed; never for being slow |

### Commands (for the user)

| Command | Purpose |
|---------|---------|
| `/subagent-cancel <taskId>` | Cancel one running background task (lists running tasks with no argument) |
| `/subagent-cancel-all` | Cancel all running background tasks at once |
| `/subagent-result <taskId>` | Read a task's full result in a full-screen viewer |

---

## Notification envelope and card

### Envelope (the LLM contract)

The `[subagent-result]` notification is **self-contained** — it carries everything the main agent needs to process the result in one message:

```
## [subagent-result] coder 成功 (taskId: 01912345-6789-7abc-8def-0123456789ab)

- 状态: 成功
- 任务: 将认证中间件重构为使用 async/await。
- 耗时: 02:34 · 用量: 5 turns/↑12.5k/↓3.2k/$0.0042
- 会话: 01912345-6789-7abc-8def-0123456789ab

在途任务: 1
- 01912345-aaaa-7bbb-8ccc-0123456789ab (writer): 更新 README。

---
<full subagent output>
```

- **Status**: `成功` (success) / `失败` (failure) / `超时` (timeout) / `已取消` (cancelled).
- **In-flight block**: lists the other background tasks still running (not itself), so the main agent knows how many are outstanding — while the count is non-zero, do not report "all done" to the user.
- **Full result**: the body enters the LLM context in full, untruncated.

See [ADVANCED.en.md](ADVANCED.en.md) for the complete envelope format, status semantics, and cancel-origin distinctions.

### Notification card (user-facing rendering)

In the TUI, the user sees a **tinted summary card**, not the full result:

- **Success**: green background (✓)
- **Failure**: red background (✗)
- **Timeout / cancelled**: yellow background

The card shows only the agent, status, taskId, and usage summary, plus the hint `查看全文: /subagent-result <taskId>`. The full result text lives in the task's session file; read it with `/subagent-result`.

---

## Design discipline

Async mode introduces a few rules, baked into the tool prompts and implementation, that the main agent follows automatically:

- **Cancel-origin distinction**: `已取消` (cancelled) has three origins — user (`/subagent-cancel`), main agent (`subagent_cancel` tool), and session shutdown (`session_shutdown`). A user-initiated cancel must **never be auto-retried**; ask the user first.
- **No polling**: results arrive automatically as notifications. `subagent_status` exists only to confirm what's in flight (e.g. after a `/tree` rewind), carries no elapsed time, and is not meant to be called frequently.
- **Anti-abuse cancellation**: `subagent_cancel` ships with prompt guidance — cancel only when the task is clearly wrong or no longer needed, never just because it's taking long (background subagents are expected to run long).
- **Resource-conflict discipline**: before dispatching multiple tasks in parallel, consider whether they touch the same files or code areas; when in doubt, dispatch sequentially or ask the user.
- **Recursion blocked entirely**: a subagent (depth ≥ 1) can never dispatch `subagent`; delegation depth is capped at 1.
- **TUI async / non-TUI sync fallback**: only TUI mode takes the async path; print/json and other non-TUI modes fall back to synchronous blocking, keeping scripted scenarios predictable.

---

## Prerequisites: install Pi Agent

async-subagent-isolation is a Pi Package, so you need Pi Agent first.

This extension requires Node.js >= 20 (matching `engines.node` in `package.json`).

### Option 1: one-line install (recommended for Linux / macOS)

```bash
curl -fsSL https://pi.dev/install.sh | sh
```

### Option 2: install via npm globally

```bash
npm install -g --ignore-scripts @earendil-works/pi-coding-agent
```

Once installed, the `pi` command is available in your terminal.

---

## 30-second quick start

### 1. Install the extension

```bash
pi install npm:@wolido/async-subagent-isolation
```

### 2. Copy the example agents and skills

```bash
cp examples/pi/agent/agents/*.md ~/.pi/agent/agents/
cp examples/pi/agent/master.md ~/.pi/agent/master.md
cp -r examples/pi/agent/skills/* ~/.pi/agent/skills/
```

See `examples/pi/agent/agents/` for the agent definitions; customize as needed.

### 3. Assign the task in natural language

```bash
pi --tools read,grep,find,ls,subagent \
   --no-skills \
   --append-system-prompt ~/.pi/agent/master.md \
   --skill ~/.pi/agent/skills/brainstorming/
```

This restricts the main agent to read-only tools plus subagent delegation, loads the main agent prompt, and activates the brainstorming skill.

For daily use, add an alias to your shell config. For example, in `~/.zshrc`:

```bash
alias pp='pi --tools read,grep,find,ls,subagent --no-skills --append-system-prompt ~/.pi/agent/master.md --skill ~/.pi/agent/skills/brainstorming/'
```

Then just type `pp` to start the main agent.

Then tell the main agent:

> Refactor the auth middleware to use async/await.

The main agent will automatically call the `coder` subagent via the `subagent` tool. You don't need to write JSON or worry about `sessionId` — the extension handles spawning and cleanup.

In TUI mode, `subagent` returns a dispatch receipt (`已派出 coder. taskId: <id>`); the result arrives later as a `[subagent-result]` notification — the main agent processes it automatically, no intervention needed. Reuse the `taskId` (the session ID) from the receipt if you need to continue the same task.

---

## Example agents

The GitHub repo ships three ready-to-reference agents in [`examples/pi/agent/agents/`](https://github.com/Wolido/subagent-isolation/tree/main/examples/pi/agent/agents):

| Agent | Purpose | Tools | Skill |
|-------|---------|-------|-------|
| [`coder`](https://github.com/Wolido/subagent-isolation/blob/main/examples/pi/agent/agents/coder.md) | Write, modify, and validate code | `read, write, edit, bash, grep, find, ls` | `systematic-debugging` |
| [`reviewer`](https://github.com/Wolido/subagent-isolation/blob/main/examples/pi/agent/agents/reviewer.md) | Read-only review with actionable feedback | `read, grep, find, ls` | _(none)_ |
| [`writer`](https://github.com/Wolido/subagent-isolation/blob/main/examples/pi/agent/agents/writer.md) | Write docs, READMEs, commit messages | `read, write, edit, grep, find, ls` | `writing-clearly-and-concisely` |

Copy the `.md` files you need into `~/.pi/agent/agents/` (user-scoped) or `.pi/agents/` (project-scoped).

If you have already cloned the repo, copy them directly:

```bash
cp examples/pi/agent/agents/*.md ~/.pi/agent/agents/
```

Or download a single file from GitHub (using `coder` as an example):

```bash
curl -fsSL https://raw.githubusercontent.com/Wolido/subagent-isolation/main/examples/pi/agent/agents/coder.md \
  -o ~/.pi/agent/agents/coder.md
```

> These are examples only. Feel free to modify them or create your own.

Agent discovery rules:

- `user` scope: `~/.pi/agent/agents/`
- `project` scope: `.pi/agents/` (searched upward from the working directory)
- Default merges both scopes; project overrides user on name collisions

---

## Recommended main agent setup

The main agent should be a pure planner: read code, make decisions, delegate tasks. All concrete work — writing files, running commands, editing code — is handled by subagents, each running in its own isolated pi process. This keeps the main agent's context focused on what to do and what came back, rather than being polluted by tool-call traces.

Use `examples/pi/agent/master.md` as the main agent system prompt — copy it to `~/.pi/agent/master.md`:

```bash
cp examples/pi/agent/master.md ~/.pi/agent/master.md
```

Then start the main agent with:

```bash
pi --tools read,grep,find,ls,subagent \
   --no-skills \
   --append-system-prompt ~/.pi/agent/master.md \
   --skill ~/.pi/agent/skills/brainstorming/
```

What each flag does:

- `--tools read,grep,find,ls,subagent`: read, search, list, and delegate only. No `write`, `edit`, or `bash`, so the main agent cannot modify files or run commands itself.
- `--no-skills`: disables default skill loading to keep the main agent context clean.
- `--append-system-prompt ~/.pi/agent/master.md`: appends the main agent system prompt to the default prompt.
- `--skill ~/.pi/agent/skills/brainstorming/`: loads the brainstorming skill for task planning.

Subagents (`coder`, `writer`) load their own skills via the `skills:` frontmatter field — no CLI flag needed.

If you only want them for the current project, place them in `.pi/agents/`; the extension will load these project-level agents when invoking `subagent`.

---

## Per-subagent model configuration

Different subagents suit different models. If your main agent defaults to Kimi K3 ($3/$15 per M token), running `coder`, `writer`, and `reviewer` all on Kimi K3 gets expensive fast. `coder` needs strong reasoning — use DeepSeek V4 Pro ($0.44/$0.87, great value). `writer` and `reviewer` handle lighter tasks — DeepSeek V4 Flash ($0.14/$0.28) is the cheapest and works fine. Reserve the expensive model for the main agent's planning.

Beyond model choice, you can also set a **thinking level** (reasoning depth) per subagent. The model determines *who* thinks; the thinking level determines *how deeply* — they're independent. `coder` benefits from deep reasoning (`high`); `reviewer` only needs quick checks, so `off` or `low` saves time. You can also pair a cheap model with a higher thinking level to get decent reasoning at low cost.

> **Note**: if the subagent's model doesn't support reasoning (e.g. some lightweight models), Pi automatically clamps the thinking level to `off` — the setting has no effect.

### Configuration file

Use `subagent-isolation.json` to assign a model and thinking level per subagent. (The file name is retained from the sync original, so both projects can share the same config):

- **User-level**: `~/.pi/agent/subagent-isolation.json`
- **Project-level**: `.pi/subagent-isolation.json` (searched upward from the working directory)

The file is a JSON key-value map. Key = agent name. The value supports two formats:

- **Plain string** (legacy format, still supported): just the model name, no thinking level.
- **Object**: `{ "model": "model-name", "thinking": "thinking-level" }` to specify both.

```json
{
  "coder": { "model": "deepseek/deepseek-v4-pro", "thinking": "high" },
  "writer": "deepseek/deepseek-v4-flash",
  "reviewer": { "model": "deepseek/deepseek-v4-flash", "thinking": "off" }
}
```

Allowed `thinking` values and what they mean:

| Value | Meaning |
|---|---|
| `off` | No reasoning, respond directly (fastest, cheapest) |
| `minimal` | Light reasoning |
| `low` | Shallow reasoning |
| `medium` | Balanced |
| `high` | Deep reasoning |
| `xhigh` | Deeper reasoning |
| `max` | Maximum reasoning depth |

Guidance: complex reasoning (coding, architecture design) → `high` or above; simple tasks (format checks, copy editing) → `off` or `low`; when unsure, start with `medium`.

With this setup, the main agent still uses the default Kimi K3 for planning and decisions. `coder` uses DeepSeek V4 Pro for code changes. `writer` and `reviewer` use the cheapest DeepSeek V4 Flash. Overall cost drops significantly — most work runs on cheap models; only planning and complex reasoning hit the expensive one.

### Priority

Both `model` and `thinking` follow the same priority chain (highest to lowest):

1. `subagent-isolation.json` configuration
2. Agent frontmatter `model` / `thinking` field
3. Inherit from the parent agent

The two dimensions are independent. For example, you can set `model` in frontmatter and override only `thinking` in the config file — each follows its own priority chain.

### Merge rules

Project-level configuration overrides user-level keys of the same name. For example, if user-level sets `coder` to `deepseek/deepseek-v4-pro` and project-level sets `coder` to `kimi-coding/k3`, the project uses Kimi K3.

> **Note**: the plain-string legacy format is still fully supported — no changes needed to existing configs. When `thinking` is not specified, the subagent inherits it according to the priority rules above.

---

## Example skills

The GitHub repo ships three ready-to-use skills in [`examples/pi/agent/skills/`](https://github.com/Wolido/subagent-isolation/tree/main/examples/pi/agent/skills):

| Skill | Used by | Description |
|-------|---------|-------------|
| [`brainstorming`](https://github.com/Wolido/subagent-isolation/tree/main/examples/pi/agent/skills/brainstorming) | Main agent | Turn ideas into fully formed designs through collaborative dialogue |
| [`systematic-debugging`](https://github.com/Wolido/subagent-isolation/tree/main/examples/pi/agent/skills/systematic-debugging) | `coder` | Find root cause before attempting any fix (4-phase process) |
| [`writing-clearly-and-concisely`](https://github.com/Wolido/subagent-isolation/tree/main/examples/pi/agent/skills/writing-clearly-and-concisely) | `writer` | Refine prose with clarity rules, AI-pattern detection, and voice injection |

Copy them to `~/.pi/agent/skills/`:

```bash
mkdir -p ~/.pi/agent/skills
cp -r examples/pi/agent/skills/brainstorming ~/.pi/agent/skills/
cp -r examples/pi/agent/skills/systematic-debugging ~/.pi/agent/skills/
cp -r examples/pi/agent/skills/writing-clearly-and-concisely ~/.pi/agent/skills/
```

Skills can be loaded in two ways:

- **Subagents**: declare in the `skills:` frontmatter field (e.g. coder's `skills: systematic-debugging`). Pi loads them automatically when spawning the subagent.
- **Main agent**: load via the `--skill` CLI flag (e.g. `--skill ~/.pi/agent/skills/brainstorming/`).

Skill discovery mirrors agent discovery: `~/.pi/agent/skills/` (user scope) and `.pi/skills/` (project scope). Pi resolves skill names in the `skills:` field against these directories.

---

## Advanced usage

If you need to construct `subagent` calls manually, reuse a `sessionId`, understand the async envelope format and its in-flight task block, query in-flight tasks with `subagent_status`, cancel tasks with `/subagent-cancel` or `/subagent-cancel-all`, or tune environment variables, see [ADVANCED.en.md](ADVANCED.en.md).

---

## Project structure

- `src/index.ts` — main extension source
- `examples/pi/agent/` — example agent and skill definitions
  - `master.md` — main agent system prompt
  - `agents/` — subagent definitions
  - `skills/` — skill definitions
- `package.json` — npm package manifest
- `tsconfig.json` — TypeScript configuration
- `README.md` / `README.en.md` — documentation
- `ADVANCED.md` / `ADVANCED.en.md` — advanced reference
- `LICENSE` — MIT license

---

## License

MIT
