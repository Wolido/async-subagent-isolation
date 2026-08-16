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

Subagents split an ever-growing context into pieces, each handling its own slice; async keeps the main agent's context down to "what to do" and "what came back", while the subagent's long execution trail stays in its own process.

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

**The original project continues to be maintained as the synchronous version.** Use the original for synchronous, blocking semantics (results returned in place); use this project for async parallelism, background execution, and dispatch-and-return.

---

## Face the dispatcher, not the cluster

In the sync version, every delegation blocks, so the experience feels like facing a "swarm of agents": the main agent dispatches and goes silent until the subagent finishes, leaving you with stretches of relayed execution. The async version flips this — **your conversation is always with the main agent alone**.

The main agent is the dispatcher: it understands the request, splits it into tasks, dispatches them, and summarizes the results. Subagents are behind-the-scenes workers, each running in its own background process and reporting back through a `[subagent-result]` notification. You never talk to a subagent directly, and you shouldn't need to: read results with `/subagent-result`, cancel with `/subagent-cancel`, and leave everything in between to the dispatcher.

More important is **the freedom after dispatch**. While a task runs in the background, you keep talking to the main agent — refine the requirements, adjust the plan, discuss next steps, or raise a new task. The main agent doesn't wait idle; it can keep planning and even dispatch more tasks in parallel. Foreground conversation and background work move forward together.

Finally, **review when the result returns**. The subagent finishes, the notification arrives, and the main agent processes it and reports back. While you wait, you can check the progress widget, but you never have to watch.

In one line: sync traps you in the "swarm execution" block; async keeps you facing a single dispatcher while background work runs alongside your own pace.

---

## How this differs from plain subagents

Many subagent implementations are just "spawn a tool call inside the main agent": the subagent still reuses the main agent's prompt and skills, and the main agent keeps write and shell access — isolation is optional and partial.

async-subagent-isolation enforces complete isolation:

- **Process isolation**: every subagent starts in its own `pi` process.
- **Prompt isolation**: each subagent has its own agent definition file (e.g. `coder.md`), not the main agent's `master.md`.
- **Skill isolation**: the main agent and each subagent load only their own skills, with no cross-contamination.
- **Execution isolation**: the main agent loses `write`, `edit`, and `bash`; it can only delegate.
- **Independent configuration**: each agent defines its own `tools` and `skills`, controlling exactly what it can and cannot do.

Beyond that, a subagent sees only the one task it was delegated — not the main agent's execution trail (context isolation) — and cannot delegate further (recursion depth capped at 1).

Plain subagents split work. async-subagent-isolation splits everything.

---

## Uniqueness and significance

This project is built on two design decisions that support each other, and its significance comes from the two together.

**Async by default.** Dispatching is not handing over control — it's delivering a task: the call returns a receipt immediately, the task runs in an independent process in the background, and the result is pushed back as a `[subagent-result]` system notification. Async is the default semantics, not an optional switch — the main agent never blocks, can dispatch in parallel and keep planning, and the user always faces the dispatcher alone.

**Exclusive skill isolation.** A subagent's skills load from a whitelist: everything is off by default, and only individually listed skills can enter its context. Isolation happens at the process level, not the prompt level — each subagent is its own `pi` process, and none of the main agent's skills can get in. Isolation is therefore not an instruction but a structural fact: a subagent knows only what it is allowed to know, and its domain of focus is precisely controllable.

**Why it matters: context partitioning.** The main agent keeps only "what to do" and "what came back"; the subagent's long execution trail stays in its own process and session, never flowing back to the main agent. Context is cut into small slices, each handled by its own agent — the main agent stays clear-headed over the long run, and planning and review are never drowned in detail. Reliable division of labor is thus structure, not discipline: async and isolation are both defaults.

---

## Async workflow

This is the biggest difference from the sync version, and the primary way to use it (TUI mode).

### 1. Dispatch (the `subagent` tool)

The main agent calls `subagent`, which spawns an isolated `pi` process. Non-TUI modes (print/json) automatically fall back to synchronous — they wait for the subagent and return the result directly, with no notification.

### 2. Receipt (returns immediately)

In TUI mode, `subagent` **returns a dispatch receipt immediately** and does not block:

```
已派出 coder. taskId: 01912345-6789-7abc-8def-0123456789ab
```

The `taskId` is the session ID; reuse it later to continue the same task. **The receipt is not the result** — do not fabricate results.

### 3. Background execution + progress widget

The subagent runs in a background process. A progress widget appears above the TUI editor, listing all in-flight tasks (taskId, agent, phase, elapsed time):

```
● 01912345-abcd... coder    ⚡ read...         01:23
```

### 4. Result notification (`[subagent-result]`)

When the subagent finishes, its result is pushed as a **`[subagent-result]` system notification** (a system message, not a user request):

- If the main agent is **idle**, the notification triggers a new turn immediately.
- If the main agent is **busy**, it is queued and triggers a turn after the current one finishes.

Results arrive automatically — **no polling**. In-flight task information is provided directly by the `[subagent-result]` notification envelope; `action="status"` was removed as a cleanup in v1.2.0.

### 5. Read the full result (`/subagent-result`)

The notification card shows only a summary. Use `/subagent-result <taskId>` to read the full output in a full-screen viewer: `↑↓`/`jk` scroll, `Space`/`b` page, `g`/`G` top/bottom, `Enter`/`Esc`/`q` close. With no argument (TUI mode), an interactive picker lists the 5 most recently finished tasks and `Enter` opens the selected one.

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
| `subagent` | Single-entry tool (`action` parameter); `action="dispatch"` (default) dispatches asynchronously (TUI mode), falls back to sync in non-TUI | Receipt ≠ result; results arrive as notifications, don't poll |
| `subagent` `action="cancel"` | Main agent cancels one in-flight task | Only when clearly wrong or no longer needed; never for being slow |

> **v1.2.0 note**: the `subagent` tool's `action="status"` has been removed as a cleanup. In-flight task information is now provided by the `[subagent-result]` notification envelope's in-flight block, with no active-query entry point.

### Commands (for the user)

| Command | Purpose |
|---------|---------|
| `/subagent-cancel <taskId>` | Cancel one running background task (no argument opens an interactive picker of running tasks; Enter cancels the selection) |
| `/subagent-cancel-all` | Cancel all running background tasks at once |
| `/subagent-result <taskId>` | Read a task's full result in a full-screen viewer (no argument opens an interactive picker of the 5 most recent finished tasks) |

---

## Notification envelope and card

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
- **Duration**: the subagent's real run time (process start to finish; `MM:SS`, or `H:MM:SS` at 1h+), shown for all four states. For cancellations or internal errors with no result, it is measured from dispatch time.
- **In-flight block**: lists the other background tasks still running (not itself), so the main agent knows how many are outstanding — while the count is non-zero, do not report "all done" to the user.
- **Full result**: the body enters the LLM context in full, untruncated.

In the TUI, the user sees a **tinted summary card**, not the full result: success green (✓), failure red (✗), timeout/cancelled yellow. The card shows the agent, status, taskId, duration, and usage summary (duration included for all four states), plus the hint `查看全文: /subagent-result <taskId>`; the full text lives in the task's session file.

See [ADVANCED.en.md](ADVANCED.en.md) for the complete envelope format, status semantics, and cancel-origin distinctions.

---

## Design discipline

Async mode introduces a few rules, baked into the tool prompts and implementation, that the main agent follows automatically:

- **Cancel-origin distinction**: `已取消` (cancelled) has three origins — user (`/subagent-cancel`), main agent (`subagent` tool with `action="cancel"`), and session shutdown (`session_shutdown`). A user-initiated cancel must **never be auto-retried**; ask the user first.
- **No polling**: results arrive automatically as notifications; in-flight task information is provided directly by the `[subagent-result]` notification envelope, with no active-query entry point.
- **Anti-abuse cancellation**: `action="cancel"` ships with prompt guidance — cancel only when the task is clearly wrong or no longer needed, never just because it's slow (background subagents are expected to run long).
- **Resource-conflict discipline**: before dispatching multiple tasks in parallel, consider whether they touch the same files or code areas; when in doubt, dispatch sequentially or ask the user.
- **Subagents cannot call the subagent tool**: a subagent (depth ≥ 1) can never call any `subagent` action (including `action="cancel"`); delegation depth is capped at 1.
- **TUI async / non-TUI sync fallback**: only TUI mode takes the async path; print/json and other non-TUI modes fall back to synchronous blocking.

---

## Prerequisites: install Pi Agent

Install Pi Agent first (Node.js >= 20 required):

```bash
curl -fsSL https://pi.dev/install.sh | sh
# or via npm:
npm install -g --ignore-scripts @earendil-works/pi-coding-agent
```

---

## Quick start

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

### 3. Start the main agent

```bash
pi --tools read,grep,find,ls,subagent \
   --no-skills \
   --append-system-prompt ~/.pi/agent/master.md \
   --skill ~/.pi/agent/skills/brainstorming/
```

This restricts the main agent to read-only tools plus `subagent` delegation (no `write`/`edit`/`bash`), and loads the main agent prompt and brainstorming skill. For daily use, add an alias:

```bash
alias pp='pi --tools read,grep,find,ls,subagent --no-skills --append-system-prompt ~/.pi/agent/master.md --skill ~/.pi/agent/skills/brainstorming/'
```

Then just say what you need — for example, "Refactor the auth middleware to use async/await." The main agent dispatches the `coder` subagent automatically. Subagents (`coder`, `writer`) load their own skills via the `skills:` frontmatter field — no CLI flag needed. For project-scoped agents, place them in `.pi/agents/`.

---

## Example agents

The GitHub repo ships three ready-to-reference agents in [`examples/pi/agent/agents/`](https://github.com/Wolido/subagent-isolation/tree/main/examples/pi/agent/agents):

| Agent | Purpose | Tools | Skill |
|-------|---------|-------|-------|
| [`coder`](https://github.com/Wolido/subagent-isolation/blob/main/examples/pi/agent/agents/coder.md) | Write, modify, and validate code | `read, write, edit, bash, grep, find, ls` | `systematic-debugging` |
| [`reviewer`](https://github.com/Wolido/subagent-isolation/blob/main/examples/pi/agent/agents/reviewer.md) | Read-only review with actionable feedback | `read, grep, find, ls` | _(none)_ |
| [`writer`](https://github.com/Wolido/subagent-isolation/blob/main/examples/pi/agent/agents/writer.md) | Write docs, READMEs, commit messages | `read, write, edit, grep, find, ls` | `writing-clearly-and-concisely` |

Copy the ones you need into `~/.pi/agent/agents/` (user-scoped) or `.pi/agents/` (project-scoped; project overrides user on name collisions). Feel free to modify them or create your own.

---

## Per-subagent model configuration

Use `subagent-isolation.json` to assign a model and thinking level per subagent (the file name is retained from the sync original, so both projects can share the same config):

```json
{
  "coder": { "model": "deepseek/deepseek-v4-pro", "thinking": "high" },
  "writer": "deepseek/deepseek-v4-flash"
}
```

Put it in `~/.pi/agent/subagent-isolation.json` (user-level) or `.pi/subagent-isolation.json` (project-level, which overrides user-level keys of the same name). Thinking levels, priority, and merge rules are in [ADVANCED.en.md](ADVANCED.en.md).

---

## Example skills

`examples/pi/agent/skills/` ships three skills: `brainstorming` (main-agent planning), `systematic-debugging` (coder), and `writing-clearly-and-concisely` (writer). Copy them into `~/.pi/agent/skills/` (user scope) or `.pi/skills/` (project scope). Subagents load them automatically via the `skills:` frontmatter field; the main agent loads them with the `--skill` flag.

---

## Advanced usage

Manual `subagent` calls, `sessionId` reuse, envelope and in-flight block details, `action="cancel"` cancellation, and environment variables are covered in [ADVANCED.en.md](ADVANCED.en.md).

---

## Project structure

- `src/index.ts` — main extension source
- `examples/pi/agent/` — example agent and skill definitions (`master.md`, `agents/`, `skills/`)
- `package.json` — npm package manifest
- `tsconfig.json` — TypeScript configuration
- `README.md` / `README.en.md` — documentation
- `ADVANCED.md` / `ADVANCED.en.md` — advanced reference
- `LICENSE` — MIT license

---

## License

MIT
