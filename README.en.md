<div align="right"><a href="README.md">中文</a></div>

<div align="center"><img src="logo.svg" alt="async-subagent-isolation logo" width="150"></div>

# async-subagent-isolation

<div align="center">

[![TypeScript](https://img.shields.io/badge/TypeScript-3178C6?logo=typescript&logoColor=white)]()
[![Pi Package](https://img.shields.io/badge/Pi_Package-8B5CF6)]()
[![npm version](https://img.shields.io/npm/v/@wolido/async-subagent-isolation)](https://www.npmjs.com/package/@wolido/async-subagent-isolation)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

</div>

Does your AI agent start "forgetting" after long sessions — output quality dropping, files changed that you never asked for? These are classic symptoms of context explosion, context rot, and context pollution. **async-subagent-isolation** is an extension for [Pi Agent](https://github.com/earendil-works/pi) and the **async evolution** of [subagent-isolation](https://github.com/Wolido/subagent-isolation) (the synchronous version), fixing them by isolating every subagent in its own process.

The core constraint is unchanged: **the main agent can't touch code**. No `write`, no `edit`, no `bash` — only the four read-only tools `read`, `grep`, `find`, `ls`, plus a `subagent` tool for delegation; all file changes, shell commands, and execution logic go to subagents. Two selling points follow. First, **skill-level prompt isolation**: every subagent runs in its own `pi` process with its own agent definition file (e.g. `coder.md`) and a skill whitelist, inheriting neither the main agent's prompt nor its skills — not a single one of the main agent's skills gets in. Second, **a division-of-labor model**: the main agent only splits, dispatches, and reviews; `coder` writes code, `writer` writes docs, `reviewer` reviews, and each subagent receives only the slice of context in its own domain. The key difference is **async**: in TUI mode, dispatch returns an **immediate receipt** (`Dispatched <agent>. taskId: <taskId>`), the subagent runs in the background, and the result arrives as a **[subagent-result] system notification**; the main agent never blocks and can dispatch multiple tasks in parallel while it keeps working.

---

## Is your agent showing these symptoms

All five symptoms trace back to structural root causes, and each has a structural fix:

| Symptom | Root cause | How this project fixes it |
|---------|------------|---------------------------|
| Output quality drops after long sessions; early agreements get forgotten | Context rot (also called context degradation): the context balloons over the session and early details get buried | Context partitioning: the main agent keeps only "what to do" and "what came back"; execution trails stay in the subagent's process |
| The context fills up with irrelevant tool output | Context pollution: verbose subtask output flows back into the main agent | Context isolation: a subagent receives only the delegated task, never sees the main agent's execution trail, and sends back just the result |
| The agent modifies files or runs unauthorized commands | The main agent holds write/edit/bash, too much power in one place | Least privilege: the main agent loses write/edit/bash and keeps only four read-only tools plus delegation |
| Multiple subtasks interfere with each other | No process isolation: subagents reuse the main agent's prompt and skills | Process isolation: every subagent runs in its own pi process, with its own prompt, skills, and execution ability |
| The main agent blocks while waiting on subtasks, with no parallelism | Synchronous delegation semantics: every call blocks until the subagent finishes | Async subagent delegation: dispatch returns a receipt immediately; the subagent runs in the background and reports back via notification |

---

## Why common workarounds fall short

The usual responses to context rot take three routes: compaction, retrieval, and longer windows. All three buy time; none changes the mechanism by which rot sets in.

- **`/compact`-style compaction is after-the-fact repair.** You compress once the context has already degraded, and compression itself loses information: early agreements and the reasoning behind decisions are often exactly what you need later. After compacting, the context swells again and the next round loses more. The rhythm of rot is unchanged — the clock just restarts from the last compaction point.
- **RAG / retrieval memory turns the problem into tuning.** Storing history in a vector database and fetching on demand is a reasonable idea, but "what to fetch, how much, and when" becomes a new tuning burden. Fetching the wrong fragment is worse than fetching nothing: context that looks relevant but isn't will derail the main agent's judgment more easily than a clean context.
- **A longer context window only moves the wall.** Double the window and filling it is a matter of time; every turn sends the entire history to the model, so cost climbs with length first. Nor does a bigger window cure rot: Chroma's Context Rot study measured this — performance starts degrading well before the window is full.

All three routes share one default premise: a single agent carries the entire context. With that premise fixed, every solution amounts to giving the agent more: a longer window, a bigger memory, more tools. async-subagent-isolation replaces the premise itself — cut the context into slices, let each subagent handle its own, and let the main agent keep only "what to do" and "what came back".

---

## Who this is for

This project fits if any of these describe you:

- Indie developers who live in long agent sessions, and want to prevent context rot and context bloat so the main agent stays clear-headed over the long run
- Heavy users running many subtasks in parallel, who need subagent context isolation so verbose subtask output never becomes context pollution
- Tech leads who hold the line on permission discipline, and want the main agent under least privilege (no write/edit/bash) so touching files or running commands is structurally impossible
- Architects building multi-agent systems, who need agent process isolation for reliable workflows
- Throughput-minded developers who want async subagent delegation without synchronous blocking

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

## How this differs from plain subagents: why context isolation goes deeper than prompt isolation

Many subagent implementations are just "spawn a tool call inside the main agent": the subagent still reuses the main agent's prompt and skills, and the main agent keeps write and shell access — isolation is optional and partial.

async-subagent-isolation enforces complete isolation:

- **Process isolation**: every subagent starts in its own `pi` process.
- **Prompt isolation**: each subagent has its own agent definition file (e.g. `coder.md`), not the main agent's `master.md`.
- **Skill isolation**: the main agent and each subagent load only their own skills, with no cross-contamination.
- **Execution isolation (least privilege)**: the main agent loses `write`, `edit`, and `bash`; it can only delegate.
- **Independent configuration**: each agent defines its own `tools` and `skills`, controlling exactly what it can and cannot do.

Beyond that, a subagent sees only the one task it was delegated — not the main agent's execution trail (context isolation) — and cannot delegate further (recursion depth capped at 1).

Two mutually reinforcing design decisions make this isolation the default behavior.

**Async by default.** Dispatch delivers a task: the call returns a receipt immediately, the task runs in an independent process in the background, and the result is pushed back as a `[subagent-result]` system notification. Async is the default semantics with no optional switch — the main agent never blocks, can dispatch in parallel and keep planning, and the user always faces the dispatcher alone.

**Exclusive skill isolation.** A subagent's skills load from a whitelist: everything is off by default, and only individually listed skills can enter its context. Isolation happens at the process level: each subagent is its own `pi` process, and none of the main agent's skills can get in. Isolation is therefore a structural fact: a subagent knows only what it is allowed to know, and its domain of focus is precisely controllable.

**Why it matters: context partitioning.** The main agent keeps only "what to do" and "what came back"; the subagent's long execution trail stays in its own process and session, never flowing back to the main agent. Context is cut into small slices, each handled by its own agent — the main agent stays clear-headed over the long run, and planning and review are never drowned in detail. Async and isolation are both defaults, so the division of labor does not depend on discipline.

Plain subagents split work. async-subagent-isolation splits everything.

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

## Async workflow

This is the biggest difference from the sync version, and the primary way to use it (TUI mode).

### 1. Dispatch (the `subagent` tool)

The main agent calls `subagent`, which spawns an isolated `pi` process. Non-TUI modes (print/json) automatically fall back to synchronous — they wait for the subagent and return the result directly, with no notification.

### 2. Receipt (returns immediately)

In TUI mode, `subagent` **returns a dispatch receipt immediately** and does not block:

```
Dispatched coder. taskId: 01912345-6789-7abc-8def-0123456789ab
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
- If the main agent is **busy**, it is queued and delivered with steer semantics — after the current assistant turn's tool calls finish, before the next LLM call — without waiting for the whole turn to end.
- Either way, the envelope carries a fixed **trigger line** right under the title, reminding the main agent that this is a completion notification rather than a new user instruction, and to anchor its current mainline task and progress before digesting it (see "Notification envelope and card" for the format).

Results arrive automatically — **no polling**. In-flight task information is provided directly by the `[subagent-result]` notification envelope; `action="status"` was removed as a cleanup in v1.2.0.

### 5. Read the full result (`/subagent-result`)

The notification card shows only a summary. Use `/subagent-result <taskId>` to read the full output in a full-screen viewer: `↑↓`/`jk` scroll, `Space`/`b` page, `g`/`G` top/bottom, `Enter`/`Esc`/`q` close. With no argument (TUI mode), an interactive picker lists the 5 most recently finished tasks and `Enter` opens the selected one.

### The flow at a glance

```
Main agent dispatches subagent
      │ immediate receipt (Dispatched <agent>. taskId: <id>)
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
| `subagent` `action="cancel"` | Main agent cancels one in-flight task (two-step confirmation: first call returns a challenge; `confirm:true` + a non-empty `reason` executes) | Only when clearly wrong or no longer needed; never for being slow |

> **v1.2.0 note**: the `subagent` tool's `action="status"` has been removed as a cleanup. In-flight task information is now provided by the `[subagent-result]` notification envelope's in-flight block, with no active-query entry point.

### Commands (for the user)

| Command | Purpose |
|---------|---------|
| `/subagent-cancel <taskId>` | Cancel one running background task (no argument opens an interactive picker of running tasks; Enter cancels the selection) |
| `/subagent-cancel-all` | Cancel all running background tasks at once |
| `/subagent-result <taskId>` | Read a task's full result in a full-screen viewer (no argument opens an interactive picker of the 5 most recent finished tasks) |
| `/subagent-config [agent]` | The single interactive config entry: the agent picker annotates each agent's effective model/thinking; edit the five fields description/tools/skills/body/model & thinking (name is read-only) and manage the available model list (with an argument, jumps straight to that agent) |

---

## Example agents

The GitHub repo ships three ready-to-reference agents in [`examples/pi/agent/agents/`](https://github.com/Wolido/async-subagent-isolation/tree/main/examples/pi/agent/agents):

| Agent | Purpose | Tools | Skill |
|-------|---------|-------|-------|
| [`coder`](https://github.com/Wolido/async-subagent-isolation/blob/main/examples/pi/agent/agents/coder.md) | Write, modify, and validate code | `read, write, edit, bash, grep, find, ls` | `systematic-debugging` |
| [`reviewer`](https://github.com/Wolido/async-subagent-isolation/blob/main/examples/pi/agent/agents/reviewer.md) | Read-only review with actionable feedback | `read, grep, find, ls` | _(none)_ |
| [`writer`](https://github.com/Wolido/async-subagent-isolation/blob/main/examples/pi/agent/agents/writer.md) | Write docs, READMEs, commit messages | `read, write, edit, grep, find, ls` | `writing-clearly-and-concisely` |

Copy the ones you need into `~/.pi/agent/agents/` (user-scoped) or `.pi/agents/` (project-scoped; project overrides user on name collisions). Feel free to modify them or create your own. After modifying or adding agent files, run `/reload` to refresh the subagent roster injected into the main agent's prompt (see "Configuration management").

---

## Per-subagent model configuration

Model configuration has three sources: the `model:` / `thinking:` fields in an agent file's frontmatter, `subagent-isolation.json` (user/project level), and process memory-level temporary overrides (effective in the current pi window only). Of the first two, the JSON file is the recommended one: all model settings live in one file instead of scattered across agent files, `/subagent-config` edits and writes it back interactively, and JSON overrides take precedence over frontmatter — a field set in JSON shadows the same frontmatter field, so a frontmatter value stops applying silently once an override exists. The process memory layer sits at the top of the priority chain, for temporary per-window adjustments when multiple windows share one config file (see below).

Use `subagent-isolation.json` to assign a model and thinking level per subagent (the file name is retained from the sync original, so both projects can share the same config):

```json
{
  "$models": ["deepseek/deepseek-v4-pro", "deepseek/deepseek-v4-flash"],
  "coder": { "model": "deepseek/deepseek-v4-pro", "thinking": "high" },
  "writer": "deepseek/deepseek-v4-flash"
}
```

Put it in `~/.pi/agent/subagent-isolation.json` (user-level) or `.pi/subagent-isolation.json` (project-level, which overrides user-level keys of the same name). A complete example with all three override formats is in `examples/pi/agent/subagent-isolation.json`.

**Process memory-level temporary overrides.** When multiple pi windows share the same `subagent-isolation.json`, a window can temporarily write one subagent's `model`/`thinking` to `this process` via `/subagent-config`: the override lives only in the current process's memory, nothing is written to disk, and it disappears when the process exits or on `/reload` — other windows are unaffected. The priority chain is process memory > project JSON > user JSON > frontmatter, with the same whole-key shadowing as the file layers: a process entry shadows lower-level entries of the same agent key wholesale. While a process override is active, the `/subagent-config` menu annotations append a `[saved: ...]` fragment showing the config-file original (see the next section). `$models` is unaffected — the available-model list stays file-level (its write targets are `user`/`project` only).

The optional top-level `$models` array is the available-model list (the `$` prefix avoids collisions with agent names): model overrides are picked from this list, with free-text input as the fallback when the list is empty or unconfigured. A valid project-level `$models` shadows the user-level list wholesale; `"$models": []` blanks it explicitly. No hand-editing required: `/subagent-config` has a list-management entry (see the next section).

Thinking levels, priority, and merge rules are in [ADVANCED.en.md](ADVANCED.en.md).

---

## Configuration management: `/subagent-config`

In TUI mode, `/subagent-config` manages all subagent configuration interactively, with no manual file editing:

1. Pick an agent: each entry carries a `(user)` / `(project)` source marker plus its effective model/thinking annotation (`<name> (<source>) — <model> (<thinking>)`, `not set` when unset; an agent with a process-level override gets a `(process)` badge plus a `[saved: <model> (<source>) / <thinking> (<source>)]` fragment (the config-file original below the process layer; `not set` for empty slots) at the end of its line; effective values follow the whole-key merge — a process-memory entry shadows the project/user entries of the same key, a project-level entry shadows the user-level entry of the same key, with unset fields falling back to frontmatter, identical to dispatch); the fixed last entry `Manage available model list ($models)` opens the available-model list management (view the current list with its source, add, remove, and choose user/project as the write target). With zero agents the picker degrades to just this entry, and `$models` stays manageable.
2. Pick a field to edit: selecting an agent goes straight to the field select, whose options carry the current-value annotations (no detail notice — information comes from the menu annotations). Five fields: `description`, `tools`, `skills`, `body`, `model & thinking` (model and thinking merged into one edit item that writes both fields); `name` is a read-only identity and is not among them.

How each field is edited:

| Field | How it is edited |
|-------|------------------|
| `description` | Single-line input prefilled with the current value; a successful edit asks for `/reload` to rebuild the injected roster |
| `tools` / `skills` | Comma-separated input; an empty input removes the key from the frontmatter |
| `body` | Opens in an external editor (`$EDITOR`, falling back to `$VISUAL`, then `vi`); cancel, unchanged, or whitespace-only results write nothing |
| `model & thinking` | Merged into one edit item: the subflow opens with an action layer — `edit model & thinking` (annotated with the current effective values and their sources) / `clear model & thinking (reset to frontmatter)`; the edit branch walks the model value step (`$models` select when the list is non-empty, free input prefilled with the effective value otherwise) → thinking value step (pi's official 7 levels plus a `not set` option, the currently effective one marked `(current)`) → write target (`this process` / `user` / `project`) → one write-back for both fields; the clear branch picks a write target, removes the whole override entry and reports each field's fallback |

`name` is a read-only identity and cannot be edited.

When edits take effect (reload semantics): `description` edits require `/reload` to rebuild the injected roster, because the subagent roster injected into the main agent's system prompt is built and cached at startup (see "Security and permission discipline"); `tools` / `skills` / `body` / `model & thinking` take effect immediately, since every dispatch re-discovers agents and re-reads the config.

Menu annotations refresh live as well: after a successful write-back, the field-select options and the agent picker's annotation (effective model/thinking, sources, ordering, and the `[saved: ...]` fragment) reflect the new values immediately within the same command session — no exit and re-entry required.

`/subagent-config <name>` with an argument skips the agent picker and jumps straight to that agent's config; an unknown name is an error. In non-TUI mode the command only prints a usage notice and opens no dialogs.

The flow supports ESC at every level: edit → field select → agent picker → exit, with only the top level exiting; inside the model & thinking subflow a value-step or write-target ESC returns to the action layer, and the action-layer ESC returns to the parent flow's field select. Every back-off path writes nothing.

`/subagent-config` is the only interactive config entry — model/thinking overrides are edited in the same flow as every other field, with no separate shortcut command.

---

## Example skills

`examples/pi/agent/skills/` ships three skills: `brainstorming` (main-agent planning), `systematic-debugging` (coder), and `writing-clearly-and-concisely` (writer). Copy them into `~/.pi/agent/skills/` (user scope) or `.pi/skills/` (project scope). Subagents load them automatically via the `skills:` frontmatter field; the main agent loads them with the `--skill` flag.

---

## Notification envelope and card

The `[subagent-result]` notification is **self-contained** — it carries everything the main agent needs to process the result in one message:

```
## [subagent-result] coder succeeded (taskId: 01912345-6789-7abc-8def-0123456789ab)

> [subagent-result] This is a task-completion notification, not a new user instruction. Before acting on it, anchor the mainline task and progress you are currently working on; digest the notification against your dispatch records, and never let it overwrite or rewrite your mainline plan.

- Status: succeeded
- Task: Refactor the auth middleware to use async/await.
- Duration: 02:34 · Usage: 5 turns/↑12.5k/↓3.2k/$0.0042
- Session: 01912345-6789-7abc-8def-0123456789ab

Other tasks in flight when this task ended: 1
- 01912345-aaaa-7bbb-8ccc-0123456789ab (writer): Update README.

---
<full subagent output>
```

- **Trigger line**: a fixed blockquote line under the title, verbatim-identical in every envelope; it reminds the main agent that this is a completion notification, not a new user instruction, and to anchor its current mainline task and progress before digesting it.
- **Status**: `succeeded` / `failed` / `timed out` / `cancelled`.
- **Duration**: the subagent's real run time (`MM:SS`, or `H:MM:SS` at 1h+), shown for all four states; for cancellations or internal errors with no result, it is measured from dispatch time.
- **In-flight block**: a snapshot of the other background tasks still running when this task ended; it may be stale by delivery time, and dispatch records prevail on conflict. While the count is non-zero, the main agent should not report "all done" to the user.
- **Full result**: the body enters the LLM context in full, untruncated.

In the TUI, the user sees a **tinted summary card** (not the full text): success green (✓), failure red (✗), timeout/cancelled yellow. The card shows the agent, status, taskId, duration, and usage summary, plus the hint `View full result: /subagent-result <taskId>`; the full text lives in the task's session file.

The trigger line's design rationale, status semantics, and cancel-origin distinctions are covered in [ADVANCED.en.md](ADVANCED.en.md).

---

## Security and permission discipline: the main agent can't touch code

Async mode introduces a few rules, baked into the tool prompts and implementation, that the main agent follows automatically:

- **Cancel-origin distinction**: `cancelled` has three origins — user (`/subagent-cancel`), main agent (`subagent` tool with `action="cancel"`), and session shutdown (`session_shutdown`). A user-initiated cancel must **never be auto-retried**; ask the user first.
- **No polling**: results arrive automatically as notifications; in-flight task information is provided directly by the `[subagent-result]` notification envelope, with no active-query entry point.
- **Notification digestion**: a `[subagent-result]` is a completion notification, not a new user instruction; the main agent anchors its current mainline task and progress before handling it, digests it against its own dispatch records, and decides the next step autonomously from the result. When a notification conflicts with the mainline, it defers rather than letting the notification rewrite the plan. The discipline is baked in twice: the envelope trigger line plus a "notification digestion" entry in the tool description.
- **Anti-abuse cancellation**: `action="cancel"` is a two-step confirmation (the first call only returns a zero-side-effect challenge with elapsed time and last progress; `confirm:true` + a non-empty `reason` executes, and the reason is recorded on the task and quoted in the cancelled envelope body), with prompt guidance — cancel only when the task is clearly wrong or no longer needed, never just because it's slow (background subagents are expected to run long). Waiting means making no tool call at all and ending the turn; there is deliberately no query, nag or status action for in-flight tasks.
- **Resource-conflict discipline**: before dispatching multiple tasks in parallel, consider whether they touch the same files or code areas; when in doubt, dispatch sequentially or ask the user.
- **Subagents cannot call the subagent tool**: a subagent (depth ≥ 1) can never call any `subagent` action (including `action="cancel"`); delegation depth is capped at 1.
- **Subagent roster injection**: at startup the extension appends every discovered subagent (user + project scope) to the main agent's system prompt as a `name — description` list with user/project source markers, so the main agent sees every subagent's role each turn and `master.md` no longer needs a hand-written agent table. The list is built and cached at startup (or `/reload`): after editing an agent file's `name` / `description`, `/reload` is required to refresh it. Nothing is injected inside subagent processes, where the `subagent` tool surface does not exist and the roster would be pure pollution.
- **TUI async / non-TUI sync fallback**: only TUI mode takes the async path; print/json and other non-TUI modes fall back to synchronous blocking.

---

## Advanced usage

Manual `subagent` calls, `sessionId` reuse, envelope and in-flight block details, `action="cancel"` cancellation, roster-injection caching, config write-back guarantees, and environment variables are covered in [ADVANCED.en.md](ADVANCED.en.md).

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
