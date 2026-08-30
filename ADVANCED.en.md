<div align="right"><a href="ADVANCED.md">中文</a></div>

# async-subagent-isolation advanced reference

This document covers low-level invocation, configuration fields, and environment variables for `async-subagent-isolation`. Most users can follow the natural-language Quick Start in the main README; refer to this file only when you need to construct `subagent` calls manually, reuse an isolated session, or tune runtime parameters.

> **v1.2.0 note**: the `subagent` tool's `action="status"` has been removed as a cleanup. In-flight task information is now provided by the `[subagent-result]` notification envelope's in-flight block, with no active-query entry point.

---

## Agent definition format

Agents are Markdown files (`.md`) in an agents directory. Frontmatter describes metadata; the body becomes the system prompt.

```markdown
---
name: coder
description: Writes clean TypeScript and handles refactors.
tools: read, edit, write, bash
model: claude-3-7-sonnet
skills: /path/to/skill1,/path/to/skill2
---

You are a senior TypeScript engineer. Prefer async/await and avoid callbacks.
```

## Frontmatter fields

| Field | Type | Description |
|-------|------|-------------|
| `name` | `string` | **Required.** Unique identifier used in tool calls. |
| `description` | `string` | **Required.** Short summary shown in discovery / error messages. |
| `tools` | `string[]` (comma-separated) | Optional tool whitelist for the subagent. |
| `model` | `string` | Optional model override, e.g. `claude-3-7-sonnet`. |
| `thinking` | `string` | Optional thinking level. One of `off \| minimal \| low \| medium \| high \| xhigh \| max`. |
| `skills` | `string[]` (comma-separated) | Optional skill path list. If present, global skills are disabled and only these are loaded. Paths can be absolute or relative to the working directory. |

## Subagent roster injection (system prompt)

The extension registers a `before_agent_start` hook that appends the discovered subagent roster to the end of the main agent's system prompt, leaving the existing content in front. The main agent thus sees every subagent's role each turn, and `master.md` no longer needs a hand-written agent table. Injected block format:

```
## Available Subagents

Delegate tasks to these specialized subagents via the `subagent` tool:

- coder — Writes and refactors code (project)
- writer — Writes docs and READMEs (user)
```

Behavior details:

- Line format: one agent per line, `name — description (source)`; the separator is a U+2014 em dash; source is `user` or `project`. Discovery semantics match `discoverAgents(cwd, "both")`: a project-level agent shadows a user-level one with the same name.
- Build and cache: the injection text is built on the first hook trigger (`ctx.cwd` is unavailable at factory time, so it cannot be built earlier) and then cached in the factory closure. Mid-session agent file edits do not change the injection; `/reload` re-executes the factory, producing a fresh closure that rebuilds the roster. An empty build is cached the same way: agent files added after an empty first build do not trigger a rebuild and only appear after `/reload`.
- Depth guard: no injection when `PI_SUBAGENT_DEPTH >= 1` (inside a subagent process); a subagent has no `subagent` tool surface, so the roster would be pure pollution.
- Silent skip: a missing `ctx.cwd` or a build failure settles the injection to empty silently (no throw, no injection), and later triggers within the same factory instance do not retry.
- Multi-line descriptions flattened: newlines, tabs and whitespace runs in a description collapse to single spaces, including multi-line text produced by YAML block scalars (`description: |`), so name, description and source marker always stay on one line.
- With no agents discovered, nothing is injected and the system prompt is returned unchanged.

## Per-subagent model & thinking level config (subagent-isolation.json)

Use `subagent-isolation.json` to assign a model and thinking level to each subagent. The file name is retained from the sync original, so both projects can share one config.

### Config file locations

| Scope | Path |
|-------|------|
| User-level | `~/.pi/agent/subagent-isolation.json` |
| Project-level | `.pi/subagent-isolation.json` (the nearest `.pi/` directory found by walking up from the working directory) |

The project-level file overrides the user-level file **per key**; keys not overridden keep their user-level value.

### Format

Each key is an agent name; the value can be either:

- **Plain string (legacy format)**: model only, equivalent to `{ "model": "..." }`.
- **Object**: `{ "model": ..., "thinking": ... }` — both fields optional, but at least one must be present.

The top-level `$models` array is a reserved field (the `$` prefix avoids collisions with agent names) recording the available-model list; see "The available-model list (`$models`)" below.

```json
{
  "$models": ["deepseek/deepseek-v4-pro", "deepseek/deepseek-v4-flash"],
  "coder": { "model": "deepseek/deepseek-v4-pro", "thinking": "high" },
  "writer": "deepseek/deepseek-v4-flash"
}
```

`model` must be a non-empty string; `thinking` must be a valid level from the table below (case-sensitive). Invalid values are ignored.

### Valid thinking levels

| Value | Meaning |
|-------|---------|
| `off` | Thinking off |
| `minimal` | Minimal thinking |
| `low` | Low thinking |
| `medium` | Medium thinking |
| `high` | High thinking |
| `xhigh` | Extra high thinking |
| `max` | Maximum thinking |

### Priority rules

For a subagent such as `coder`, the model and thinking level each resolve to the first non-empty value:

**Model**:

1. Process memory override (`this process` in the current process)
2. Config file (`model` for this agent in `subagent-isolation.json`)
3. Agent frontmatter (`model:` in `coder.md`)
4. Inherit the main agent's current model

**Thinking level**:

1. Process memory override (`this process` in the current process)
2. Config file (`thinking` for this agent in `subagent-isolation.json`)
3. Agent frontmatter (`thinking:` in `coder.md`)

The thinking level is not inherited from the main agent.

> **Recommendation**: the frontmatter `model:` / `thinking:` fields also work as a lower-priority source, but `subagent-isolation.json` is the recommended place: it keeps model settings in one file, `/subagent-config` edits it interactively, and JSON overrides take precedence over frontmatter — a field set in JSON shadows the same frontmatter field, so a frontmatter value stops applying silently once an override exists (fields not set in JSON still fall back to frontmatter).

### Merge rules

Project-level and user-level configs merge **per key**: a project-level key overrides the same key in the user-level file; all other keys are kept. In other words, the nearest `.pi/subagent-isolation.json` overrides matching keys in `~/.pi/agent/subagent-isolation.json`.

The process memory layer merges on top of the file layers per key (`{...user, ...project, ...process}`): when a process entry exists for a key, it shadows the lower layers' entries of the same key wholesale, with the same whole-key semantics as project shadowing user (see the next section).

> **Merged editing vs. whole-key shadowing**: the merged `model & thinking` edit in `/subagent-config` writes both fields in one patch (picking `not set` for thinking drops that key from the entry), so every UI-written entry is complete by explicit user choice and the shadowing pitfall is no longer reachable through the UI. Hand-edited JSON entries that omit a field still shadow the lower layers' entries of the same key wholesale, unchanged.

> **Note**: when the selected model's provider does not support reasoning, pi automatically clamps the thinking level to `off`.

### Process memory-level temporary overrides (`this process`)

When multiple pi windows share the same `subagent-isolation.json`, a window can temporarily write one subagent's `model`/`thinking` to `this process` (the process memory layer) — effective only in the current process, never written to disk:

- **Semantics**: the override lives in a module-level in-memory singleton; no file is written or read. It disappears on process exit or `/reload`, and other windows are unaffected. It is meant for temporary adjustments — a different model for this task, without touching the shared config file.
- **Write target**: editing `model & thinking` (clear included) offers a three-way write target: `this process` (memory) / `user` / `project`, with the currently governing source marked `(current)`. The in-memory write notice reads `written to this process (memory only — no file written; disappears when the process exits)`.
- **Priority chain**: process memory > project JSON > user JSON > frontmatter.
- **Whole-key shadowing**: same as the file layers — the runtime merge is `{...user, ...project, ...process}`; when a process entry exists for a key, it shadows the lower layers' entries of the same key wholesale (the lower entry's other fields are invisible to dispatch).
- **Source attribution**: the effective-value source in the field options shows the literal `process` enum (e.g. `model & thinking — deepseek/deepseek-v4-pro (process) / high (process)`); the write-target option is labeled `this process`.
- **Picker badge**: an agent with a process-level override gets a ` (process)` badge and a `[saved: ...]` fragment at the end of its picker line (`<name> (<source>) — <model> (<thinking>) (process) [saved: ...]`), so the memory layer's presence — and the config-file original — are visible before entering the edit flow.
- **Saved fragment**: whenever an agent has a process-level override (single-field or complete entry alike), three annotations append `[saved: <model> (<source>) / <thinking> (<source>)]` — the picker overview, the field-select `model & thinking` option, and the subflow's `edit model & thinking` option. The fragment shows the config-file original: the effective values recomputed without the process layer (project > user > frontmatter chain); a slot without a value renders as `not set` with no source annotation. Like the other annotations it is appended text that never enters a written value, and it refreshes with the live annotations after a write-back within the same command session.
- **Clear semantics**: clearing at the memory layer removes that agent's in-memory override (the merged clear nulls both fields, dropping the whole entry; a missing entry is a no-op) and the result notice recomputes each field's fallback separately — model and thinking, each with its source — under the whole-key merge, falling back to the file configs (project/user) or frontmatter.
- **`$models` unaffected**: the memory layer only overrides an agent's `model`/`thinking`; the `$models` list stays file-level (read from the user/project files, with only `user`/`project` write targets).
- **Extension-developer API**: `setProcessOverride(agentName, patch)` (same patch semantics as `writeModelOverride`: string sets, null clears, undefined leaves untouched; reserved keys rejected), `getProcessOverrides()` (returns a copy), `clearProcessOverride(agentName)`, and `resetProcessOverridesForTests()` (test-isolation hook that empties the layer, simulating process exit/reload).

### The available-model list (`$models`)

The top-level `$models` array records the models offered during interactive editing. The project never read an extensionless `subagent-models` plain-text file; the available-model list is carried solely by the `$models` field.

- Read and shadowing: `loadAvailableModels` checks the project-level file first (the nearest `.pi/subagent-isolation.json` walking up from cwd). A valid project-level `$models` array shadows the user-level list wholesale — an explicit `"$models": []` counts as valid and blanks the user list; a non-array counts as absent and falls back to the user level. Unlike the per-key merge of agent overrides, `$models` is a wholesale replacement, never a union. Entries are cleaned on read: strings only, trimmed, blanks dropped, deduped (first occurrence wins).
- Invisible to overrides: `loadModelOverridesFile` ignores `$models`, so it never produces an agent override named `$models`.
- In edit flows: when `/subagent-config` edits a model, a non-empty list turns the value step into a select (the chosen ID itself is written); an empty or unconfigured list falls back to free-text input (`provider/model-id`, prefilled with the current effective value).
- Management entry: the agent picker of `/subagent-config` ends with a `Manage available model list ($models)` entry — view the current list (with its user/project source) → add or remove → choose the write target (user/project) → write back. Add appends to the end of the list (idempotent dedupe; a non-array base is rewritten as a single-item list); remove is a no-op when the target is absent, and removing the last entry keeps `"$models": []` so a project level can explicitly shadow the user list. Write-back preserves every other top-level key (agent entries and unknown keys) verbatim and refuses to overwrite an invalid-JSON file.
- Usable with zero agents: with no agents discovered, the `/subagent-config` picker degrades to just this entry and `$models` stays manageable.

### Config write-back guarantees

All interactive edits (`/subagent-config`) write to disk under the same guarantees:

- Unknown fields preserved: write-back reads the raw JSON and changes only the target fields; other top-level keys (`$schema`, `$models`, ...) and unknown in-entry fields survive verbatim. Legacy plain-string entries (`"writer": "model-id"`) are upgraded to object form in place.
- Validation before half-writes: all validation runs before any file IO; invalid values (empty model, invalid thinking level) or an invalid-JSON target file are rejected as a whole, with no half-written state.
- Reserved keys rejected: agent names `__proto__` / `constructor` / `prototype` are refused outright (prototype-pollution vectors).
- Clear semantics: the merged clear nulls both fields at once, so the whole key is removed from the JSON (a missing entry is a no-op), leaving no empty objects behind.
- BOM tolerance: config reads tolerate a UTF-8 BOM (the `\uFEFF` prefix is stripped before parsing).
- The memory layer is exempt: overrides written to `this process` live only in process memory and never go through any disk-write path (see "Process memory-level temporary overrides" above).

## Configuration commands (/subagent-config)

### The /subagent-config edit flow

One unified interactive entry. Main flow: pick an agent → pick a field → edit → write back → result notice. Cancelling at any step writes nothing.

- Agent picker: entries are `<name> (<source>) - <model> (<thinking>)` - the source marker plus an effective model/thinking annotation, with `not set` in unset slots; a process-level override appends a `(process)` badge and a `[saved: ...]` original-value fragment at the end of the line; the annotation is appended text mapped back to the agent entry via indexOf and never enters a written value. Effective values come from `computeEffectiveModelConfigs`' whole-key merge, identical to dispatch: a process entry shadows the project/user entries of the same key, a project-level entry shadows the user-level entry of the same key (the lower entry's other fields are invisible to dispatch), and unset fields inside the entry fall back to frontmatter. The `$models` management entry is fixed at the end. `/subagent-config <name>` preselects and jumps straight in; an unknown name is an error. With zero agents the command does not exit early: the picker degrades to just the `$models` entry.
- ESC walks back one level at a time: text-edit ESC → field select; field-select ESC → agent picker (skipped entirely with a preselect argument → full exit); agent-picker ESC → full exit. Body cancel (read undefined) → field select. The flow ends on a successful write; every back-off path writes nothing.
- Field select: picking an agent goes straight to the field select, with no detail notification; information comes from the menu annotations - each field option carries its current value (description/tools/skills, body summary, effective model & thinking with sources; a process override appends a `[saved: ...]` original-value fragment to the `model & thinking` option). Five fields: `description`, `tools`, `skills`, `body`, `model & thinking` (model and thinking merged into one item, edited and written together).
- Annotations refresh live: after every successful write-back, the field-select options and the agent picker's annotation (model/thinking overview, sources, ordering, and the saved fragment) are recomputed within the same command session - no exit and re-entry required; the no-write ESC back-off paths trigger no recompute and keep their options deterministic.
- description: single-line input prefilled with the current value (a custom prefilled input — `ui.custom` + pi-tui `Input` — in real TUI: Enter submits, an unchanged submit keeps the original value, Esc cancels); empty or whitespace-only input is rejected as a whole and the file stays byte-identical. A successful write asks for `/reload` to rebuild the injected roster.
- tools / skills: comma-separated input; an empty input deletes the key line from the frontmatter.
- body: the current body is written to a temp file and opened in an external editor (`$EDITOR`, falling back to `$VISUAL`, then `vi`), then read back and written to disk after the editor exits. Cancel, trailing-newline-only differences, and whitespace-only results all write nothing. Editor launch failures and non-zero exits each get their own error notice, clearly distinguishable from "unchanged".
- model & thinking: enters the merged editing subflow (`editAgentModelConfig`), whose action layer offers `edit model & thinking` (annotated with the current effective model+thinking and their sources, `not set` in unset slots; a process override appends the `[saved: ...]` original-value fragment) and `clear model & thinking (reset to frontmatter)`. The edit branch walks the model value step (`$models` select when the list is non-empty, free-text input prefilled with the effective value otherwise) → thinking value step (pi's official 7 levels plus a `not set` option; the currently effective level or unset state is marked `(current)`; picking `not set` writes `thinking: null`, dropping the key from the entry) → write target (`this process` (in-memory, nothing written to disk, gone on process exit or `/reload`) / `user` / `project`, the currently governing source marked `(current)`) → one patch writes both fields, so the entry is always complete and can no longer accidentally shadow the other field at a lower level. The clear branch picks a write target, clears both fields of the whole entry (a missing entry is a no-op), and reports the recomputed fallback for each field separately with its source ("frontmatter" is only claimed when the recomputed source really is frontmatter, or the chain reached frontmatter with no value, i.e. unconfigured). ESC inside the subflow follows one rule: a model-value-step, thinking-value-step or write-target ESC returns to the action layer (collected values discarded, zero writes), and the action-layer ESC returns to the parent flow's field select (no exit, no subflow restart).
- Reload hint matrix: after description edits the result notice asks for `/reload` (the injected roster is cached; see "Subagent roster injection" above); tools/skills/body/model & thinking edits report immediate effect, because every dispatch re-discovers agents and re-reads the config.
- name is read-only: `name` is the agent's identity and does not appear in the field select; any patch containing `name` is rejected outright (see "Agent file write-back (updateAgentFile)" below).
- Non-TUI mode: usage notice (warning) only — no dialogs, no writes.

### Agent file write-back (updateAgentFile)

Agent file edits are surgical line-level operations, never a whole-file re-serialization: replace the value of the target `^key:` line, delete that key's line (when tools/skills is cleared), or append a new key at the end of the frontmatter block. Untouched frontmatter lines (unknown keys included) and the body stay byte-identical.

- Multi-line value guard: when the patched key's current value is multi-line (a block scalar `key: |` / `key: >`, or indented continuation lines / YAML list items), line-level rewriting would orphan the continuation lines, so the whole patch is refused before any write with a hint to edit the file manually; multi-line keys that are not being patched do not affect other fields.
- YAML scalar serialization: a value is emitted plain when it round-trips safely, otherwise double-quoted with escapes (covering colons, hashes, quotes, CJK, leading digits, true/false/null lookalikes, and similar cases).
- Name patches rejected: any patch containing `name` is rejected outright (name is a read-only identity; rename support was removed) — even a valid new name is refused, a mixed patch is never half-written, files stay byte-identical, and no directory changes occur; the `name?` parameter remains in the signature only for type compatibility.
- Validation atomicity: all checks run before any file write.

## Async mode (TUI)

In TUI mode, the `subagent` tool is **asynchronous**: it returns a dispatch receipt immediately, the subagent runs in the background, and its result arrives later as a `[subagent-result]` system notification. Non-TUI modes (print/json, including `mode` `undefined`) fall back to synchronous — they wait for the subagent to finish and return the full result directly, with no notification.

### Dispatch receipt

In TUI mode, `subagent` returns this receipt immediately (it is NOT the result!):

```
Dispatched coder. taskId: 01912345-6789-7abc-8def-0123456789ab
```

Key points:

- **The receipt is a single line.** The async-semantics guidance (don't fabricate results, don't poll, results arrive as a `[subagent-result]` notification) is embedded in the `subagent` tool's `description` / `promptGuidelines`; the receipt itself stays a single line.
- **The receipt is not the result.** Do not fabricate results.
- **taskId = sessionId.** The `taskId` in the receipt is the session ID; reuse it directly.
- **Do not poll.** Results arrive automatically as `[subagent-result]` notifications; in-flight task information is provided directly by the notification envelope's in-flight block. `action="status"` was removed as a cleanup in v1.2.0.

### [subagent-result] envelope format

Once the subagent finishes, its result is pushed into the conversation:

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

**Trigger line**: between the title line and the metadata block sits a fixed blockquote line (`>` prefix), verbatim-identical in every envelope. It is a meta-instruction addressed to the main agent and does three jobs: identity correction (this is a completion notification, not a new user instruction), mainline retention (anchor the mainline task and progress currently in flight before processing), and a fixed processing order (anchor the mainline first, then digest the notification against dispatch records). The wording is deliberately unconditional, leaving no "the result is important, so interrupting the mainline is fine" loophole; since steer delivery inserts notifications mid-turn, the line restates mainline awareness verbatim at delivery. It enters only the LLM context and does not affect the summary card shown to the user in the TUI.

Status enumeration: **succeeded** (exit=0) / **failed** (exit≠0 or stopReason=error) / **timed out** (activity_timeout or hard_timeout) / **cancelled** (aborted or killed_on_shutdown).

**Duration**: the `- Duration:` line shows the subagent's real run time. When a result exists, it is the actual process run time (`finishedAt - startedAt`); when the result is null (user/agent cancel, session shutdown, internal error), it is measured from dispatch time instead. The format is `MM:SS`, or `H:MM:SS` at one hour and beyond (hours not zero-padded). All four terminal states (success, failure, timeout, cancelled) carry the duration in both the envelope and the TUI notification card.

"Cancelled" has three sub-cases with different envelope bodies:
- User cancelled via `/subagent-cancel` (cancelledBy: user) → body states this is a deliberate user action; the main agent must NOT auto-retry and must ask the user before re-dispatching.
- Main agent cancelled via the `subagent` tool with `action="cancel"` (cancelledBy: agent) → body states the task was cancelled by the main agent via the subagent tool (action=cancel), followed by `Cancellation reason: ...` (the reason given at the confirmation step).
- Session shutdown killed the task (cancelledBy: none) → body states the task was terminated by session_shutdown.

When the main agent receives a “cancelled” notification, it should distinguish the origin: a user cancel must never be auto-retried (ask the user first); an agent cancel is its own decision - do not re-dispatch without new information; a session-shutdown cancel can be re-dispatched after the session resumes, at the agent's discretion.

**In-flight block**: the in-flight list in the envelope's metadata section lists the **other** background tasks still running (this task is removed from the registry before the envelope is built, so it never appears in its own list). Its format is `Other tasks in flight when this task ended: N` followed by one `- taskId (agent): task description` line per task, or `No other tasks were in flight when this task ended.` when none remain. It deliberately carries **no elapsed time and no clock time** (it answers "what else was running when this task ended", not "how long has it run" or "what time is it"). The block is a **build-time snapshot** whose wording is anchored to this task's end event rather than an absolute "now" - between envelope construction and delivery the main agent may have dispatched new tasks, making the snapshot stale; on conflict with dispatch records the main agent issued itself this turn, the dispatch records prevail. The main agent uses it to know how many tasks are still outstanding - while the count is non-zero, do not report "all done" to the user.

The full output enters the LLM context (not truncated). The `details` carries structured data (taskId, agent, status, exitCode, stopReason, durationMs (required, run time in milliseconds), usage, sessionId, full output) for programmatic consumption; it does not enter the LLM context.

### Notification delivery

Notifications are sent via `pi.sendMessage` with `deliverAs: "steer"` + `triggerTurn: true`:
- When the main agent is idle, it triggers a new conversation turn immediately.
- When the main agent is busy, the notification is queued and delivered after the current assistant turn's tool calls finish, before the next LLM call (steer semantics) — it is not held back until the whole turn ends, so it cannot lag behind tasks dispatched later in the same turn.

The main agent is trained (via `promptGuidelines`) to recognize the `[subagent-result]` prefix as a system notification, not a user request; a "notification digestion" entry in the tool description further fixes the digestion order: anchor the current mainline task and progress first, then digest the notification against dispatch records, decide the next step autonomously from the result, and defer when it conflicts with the mainline rather than letting the notification rewrite the mainline plan. The fixed trigger line under the envelope title (see the envelope format above) restates this order verbatim at delivery, mitigating steer delivery's interruption of turn-plan continuity.

### Progress widget

While subagents run, a progress widget appears above the TUI editor, listing all in-flight tasks. Each row shows the taskId, agent name, current phase, and elapsed time:

```
● 01912345-abcd... coder    ⚡ read...         01:23
```

The widget's time is a live "alive since" clock (`formatElapsed`, `MM:SS` only, overflowing past 99 minutes); the envelope and notification card show the final run duration (`formatDuration`). The two coexist with different semantics.

The taskId in the widget row can be copied for `/subagent-result` (view full result) or `/subagent-cancel` (cancel the task).

### Cancelling background tasks

Cancelling a running background subagent task has two paths, both sharing the same underlying cancel flow (SIGTERM → 5s → SIGKILL cascade, followed by a `[subagent-result]` notification).

**Path 1: User commands**

From the TUI, the user enters `/subagent-cancel <taskId>` to cancel a single running task:

```
/subagent-cancel <taskId>
```

Without arguments, lists currently running tasks. The cancel source is recorded as `cancelledBy: "user"`.

To cancel all running tasks at once:

```
/subagent-cancel-all
```

Takes no arguments. Unlike `/subagent-cancel`, which cancels a single task by taskId, this cancels every running task. Each cancelled task still emits its own `cancelled` `[subagent-result]` notification (the main agent receives N cancelled envelopes). On success it notifies `Cancelled N running subagent task(s).`; with no running tasks it notifies `No running subagent tasks to cancel.` The cancel source is likewise recorded as `cancelledBy: "user"`.

**Path 2: Main agent `subagent` tool with `action="cancel"` (two-step confirmation)**

The main agent can call the `subagent` tool with `action="cancel"` (parameter `taskId`) to cancel a dispatched background task, but the first call does not execute: it returns a zero-side-effect challenge receipt (`details.confirmRequired: true`) listing the agent name, task summary, elapsed time and last progress age (or `none reported yet` when never reported), plus a warning that cancelling discards all in-flight progress and cannot be undone. To actually cancel, call again with `action="cancel"` + the same `taskId` + `confirm:true` + a non-empty `reason` (a missing or blank reason is an error with zero side-effects). On execution the reason is recorded on the task record and quoted in the cancelled envelope body (`Cancellation reason: ...`). The cancel source is recorded as `cancelledBy: "agent"`. On success, the tool returns the remaining in-flight task list (same per-line format as the `[subagent-result]` envelope's in-flight block, but anchored to the moment the cancel request was issued - the task has not ended at that point, so the envelope's "本任务结束" anchor wording is not used); the cancelled task's final result arrives later as a `[subagent-result]` notification.

**Usage discipline:** The main agent should only use `action="cancel"` when:
- The task is clearly wrong (wrong agent, incorrect task description, etc.).
- The task is no longer needed (requirement change, later discovery that this step is unnecessary).

**Do NOT** cancel merely because the task is taking a long time — background subagents are expected to run long. The criterion for cancellation is "this task should not continue", not "it's been a while".

### /subagent-result

View the full final result of a background task. User-only, from the TUI:

```
/subagent-result <taskId>
```

- Without arguments, prints usage.
- Task still running → `Task still running — view it after it finishes`.
- No record found → `No task record for: <taskId>`.
- Task exists but produced no final output (likely killed) → `Task has no final output` with the session file path.
- When output exists, displays the full Markdown result in a full-screen viewer; press Enter or Esc to close.

### session_shutdown

On quit, session switch, or reload, all in-flight subprocesses are killed and marked `killed_on_shutdown`. The corresponding `[subagent-result]` notification body says the task was terminated by session_shutdown — distinct from a user cancel. Note: on extension reload or process crash, in-flight tasks are not persisted or re-delivered. If the extension is dead when a task completes, the notification is lost (session log can still be inspected).

### TUI vs non-TUI summary

| Behavior | TUI | Non-TUI (print/json) |
|----------|-----|----------------------|
| execute returns | Dispatch receipt immediately | Full result after subagent finishes |
| Result delivery | `[subagent-result]` system notification | Inline in the return value |
| /subagent-cancel | Available | Not available (no TUI command system) |
| /subagent-cancel-all | Available | Not available (no TUI command system) |
| Parallel dispatch | Supported (independent tasks can be dispatched together) | Not supported (each call blocks) |

## Manual invocation

To make a manual call, use JSON like this:

```json
{
  "agent": "coder",
  "task": "Refactor the auth middleware to use async/await."
}
```

> **Note**: The `task` field must be non-empty, and it is recommended to follow the standard task format in `master.md`: **background, input, requirements, output format, acceptance criteria**. A `task` that is empty or contains only whitespace will be rejected.

## Reusing a sessionId

### Non-TUI mode

When the subagent finishes, its output ends with a session ID:

```
<subagent output>

[subagent session: 01912345-6789-7abc-8def-0123456789ab]
```

To continue the same isolated session, pass the `sessionId`:

```json
{
  "agent": "coder",
  "task": "Add unit tests for the refactored auth middleware.",
  "sessionId": "01912345-6789-7abc-8def-0123456789ab"
}
```

> ⚠️ **Concurrency note**: reusing the same `sessionId` from multiple concurrent `subagent` calls can corrupt the session file. Use it sequentially, or make sure the subagent process has fully exited before reuse.

### TUI mode

The dispatch receipt contains the `taskId` (which is the session ID). The `[subagent-result]` envelope also carries the sessionId on the `- Session:` line — just reuse it. No need to wait for the subagent to finish; you already have the session ID from the receipt.

> **The error states the rules**: an illegal `sessionId` (a slug, an uppercase UUID, a UUID v4, …) is rejected with a message that itself spells out both dispatch rules — omit `sessionId` to auto-generate a fresh UUID v7, and pass it only to resume the id from a previous dispatch receipt.

> **Admission-threshold difference**: this plugin's lowercase-UUID-v7 requirement is its own internal discipline (a single canonical form for registry keys and session directories), not pi's admission gate. pi's own `assertValidSessionId` (`pi-coding-agent/dist/core/session-manager.js:15-19`) only requires the character set `[A-Za-z0-9._-]` with alphanumeric first/last characters; `dist/main.js:337-345` handles `--session-id` as "silently open and resume on an exact hit, otherwise print a Warning and create a new session with that id". So if you bypass this plugin's validation, the consequences are defined by pi's behavior (an exact hit silently resumes the existing session).

## Environment variables

These variables are propagated into every subagent process automatically:

| Variable | Default | Description |
|----------|---------|-------------|
| `PI_SUBAGENT_DEPTH` | `0` | Current recursion depth. Auto-incremented per nested call. **Depth limit is 1** — a subagent (depth ≥ 1) cannot call any `subagent` action (including `action="cancel"`). |
| `PI_CURRENT_AGENT_NAME` | — | Name of the current agent, injected into every subagent process. |
| `PI_SUBAGENT_ACTIVITY_TIMEOUT_MS` | `600000` (10 min) | Max idle time with no output on either stdout or stderr before the subagent is killed. |
| `PI_SUBAGENT_HARD_TIMEOUT_MS` | `0` (disabled) | Absolute maximum runtime for a single call. Set a positive value (ms) to enable. |

## Timeouts and termination

- Activity timeout: 10 minutes — subagent is killed if neither stdout nor stderr produces output (no activity). The timer starts as soon as the child process spawns and resets whenever either stream receives data.
- Hard timeout: disabled by default (`PI_SUBAGENT_HARD_TIMEOUT_MS=0`), no absolute maximum runtime. Set a positive value in milliseconds to enable.
- When a timeout kills the subagent, the result's `stopReason` is `"activity_timeout"` (activity timeout) or `"hard_timeout"` (hard timeout). It appears in the diagnostic output (`Stop reason: ...`) and as a UI badge, distinguishing "killed by timeout" from "subagent failed on its own".
- On `AbortSignal`, `SIGTERM` is sent; `SIGKILL` follows after 5 seconds if still running. In async mode, users can trigger cancellation with `/subagent-cancel <taskId>` or `/subagent-cancel-all`.
