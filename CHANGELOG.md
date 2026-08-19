# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.6.2] - 2026-08-19

### Changed

- `/subagent-config` merges `model` and `thinking` into a single field: the field select goes from six entries to five (`description`, `tools`, `skills`, `body`, `model & thinking`), and the merged option annotates both slot values with their sources (`model & thinking — <model> (<source>) / <thinking> (<source>)`, `not set` placeholder for unset slots). Selecting it opens the reworked model/thinking subflow:
  - An action layer offers `edit model & thinking` (annotated with the current effective values and their sources) and `clear model & thinking (reset to frontmatter)`. The edit branch walks the model value step (`$models` select when the list is non-empty, free-text input prefilled with the effective value otherwise) → thinking value step (pi's official 7 levels plus a `not set` option; the currently effective level or the unset state is marked `(current)`; picking `not set` writes `thinking: null`, dropping the key from the entry) → write target (`this process` / `user` / `project`, the governing source marked `(current)`) → one patch writes both fields, so a UI write always produces a complete entry and can no longer accidentally shadow the other field into `not set` at a lower level. The clear branch picks a write target and removes the whole override entry, then reports the recomputed fallback for each field separately, with sources.
  - ESC semantics simplify to one rule inside the subflow: any value-step or write-target ESC returns to the action layer (collected values discarded, zero writes), and the action-layer ESC returns to the parent flow's field select.
- The underlying whole-key shadowing merge is unchanged: the UI now writes complete entries, so the shadowing pitfall is no longer reachable through the UI; a hand-edited JSON entry that omits a field still shadows the lower layers' entries of the same key wholesale, as before.
- All user- and main-agent-visible UI copy is now English (previously Chinese-primary with mixed Chinese/English): the envelope status words, the dispatch receipt, envelope labels and the in-flight block, slash-command prompts, the result viewer, the whole `/subagent-config` flow, and the tool description/promptGuidelines. The unset placeholder changes from `（未配置）` to `not set`.

### Added

- The agent picker now marks process-level overrides: an agent with a `this process` entry gets a ` (process)` badge at the end of its picker line (`<name> (<source>) — <model> (<thinking>) (process)`), so the memory layer's presence is visible before entering the edit flow.
- The saved fragment: when an agent has a process-level override (single-field or complete entry alike), the picker overview, the field-select `model & thinking` option, and the subflow's `edit model & thinking` option append `[saved: <model> (<source>) / <thinking> (<source>)]` showing the config-file original — the effective values recomputed without the process layer (project > user > frontmatter chain); a slot without a value renders as `not set` with no source annotation. Like the other menu annotations it is appended text that never enters a written value, and it refreshes with the live annotations after a write-back.

### Fixed

- Writing only one of `model`/`thinking` through `/subagent-config` could shadow the other field into `not set` at the same agent key: a single-field patch produced an entry that hid the other field's lower-level value under the whole-key merge. The merged edit always writes both fields with explicit choices, so UI writes keep entries complete and the pitfall is gone from the UI path.

## [1.6.1] - 2026-08-19

### Fixed

- `/subagent-config` menu annotations did not refresh after a write-back: the field-select options and the agent picker's overview annotation kept the pre-edit values until the command was exited and re-entered. After every successful write-back, `editAgentConfig` now recomputes the effective view — re-reading the user/project override files plus the process memory layer — and the live field values, so the field-select annotations and the agent picker's overview (source attribution, the `this process` memory layer, clear fallbacks, and picker ordering as JSON keys update) reflect the new values immediately within the same command session, with no exit and re-entry required:
  - Field-select options are rebuilt before every prompt, and picker options with their ordering are recomputed each round instead of once at command start, so a model/thinking write, a clear, or a text-field edit updates the annotations in place.
  - The no-write ESC back-off paths stay deterministic: they trigger no recompute, so their options and ordering stay identical to the previous build, pinned by the existing `toEqual` regression assertions.

## [1.6.0] - 2026-08-18

### Added

- Subagent roster injection into the main agent's system prompt: the extension now registers a `before_agent_start` hook that appends every discovered subagent (user + project scope) as a `name — description (source)` line (U+2014 em dash, source marker `user`/`project`) under an `## Available Subagents` heading, so the main agent sees what it can delegate to without a hand-written agent table in `master.md`.
  - The injection text is built lazily on the first hook trigger (`ctx.cwd` is unavailable at factory time) and cached in the factory closure: mid-session agent file edits do not change the injection, and `/reload` re-executes the factory to rebuild it. An empty build is cached the same way (an "attempted" sentinel), so agent files added afterwards only appear after `/reload`.
  - Depth guard: nothing is injected inside a subagent process (`PI_SUBAGENT_DEPTH >= 1`), where the `subagent` tool surface does not exist and the roster would be pure pollution. A missing/invalid `ctx.cwd` or a build failure settles the cache to an empty injection silently (no throw, no retry within the same factory instance); with no agents discovered, the system prompt is returned unchanged.
  - Multi-line descriptions (e.g. from YAML block scalars) are flattened to a single line with all whitespace runs collapsed to single spaces, so name, description and source marker always stay on one line.
- `/subagent-config [agent]`: the single interactive config entry (TUI) — the former `/subagent-models` command is removed, since `model`/`thinking` are two of its six fields. Agent picker with `(user)`/`(project)` source markers plus a per-agent effective model/thinking annotation (`<name> (<source>) — <model> (<thinking>)`, full-width `（未配置）` placeholder when unset; effective values follow the whole-key merge — a project-level entry shadows the user-level entry of the same key, unset fields fall back to frontmatter — identical to dispatch) → field editor for six fields: `description`, `tools`, `skills`, `body`, `model`, `thinking` (`name` is a read-only identity and not editable; field options carry current-value annotations).
  - `name` is read-only: any patch containing `name` is rejected outright (rename support was removed; the `name?` parameter remains in `updateAgentFile`'s signature only for type compatibility).
  - `body` opens in an external editor (`$EDITOR`, falling back to `$VISUAL`, then `vi`) via a temp file; cancel, unchanged (trailing-newline-only diffs included) and whitespace-only results write nothing. Editor launch failures and non-zero exits surface as distinguishable errors, separate from "unchanged".
  - Reload semantics: `description` edits hint that `/reload` is required (the injected roster is cached); `tools`/`skills`/`body`/`model`/`thinking` take effect immediately, because every dispatch re-discovers agents and re-reads the config.
  - ESC walks back one level at a time: edit → field select → agent picker → exit (only the top level exits; the picker level is skipped with a preselect argument). Inside the model/thinking subflow the field-level ESC returns to the parent flow's field select. Every back-off path writes nothing.
  - Text inputs prefill the current value (a custom prefilled input — `ui.custom` + pi-tui `Input` — in real TUI: Enter submits, an unchanged submit keeps the original value, Esc cancels); free-text model input prefills the current effective model.
  - `model`/`thinking` edits include `clear model (reset to frontmatter)` / `clear thinking (reset to frontmatter)` options. A file-layer clear re-reads the override files and recomputes the effective value under the whole-key merge for the result notice (with dual-level config the value falls back to the other level's JSON or stays unchanged — "frontmatter" is only claimed when the recomputed source really is frontmatter, or the chain reached frontmatter with no value, i.e. unconfigured); clearing the last field removes the whole agent key from the JSON.
  - `/subagent-config <name>` preselects an agent (unknown names are an error). Non-TUI mode falls back to a usage notify.
  - Agent file writes are surgical line-level edits (`updateAgentFile`): untouched frontmatter lines (unknown keys included) and the body stay byte-identical; an orphan-continuation guard refuses to patch keys whose current value is multi-line (block scalar or indented continuation) before any write, since line-level rewriting would orphan the continuation lines.
- `$models` available-model list: `subagent-isolation.json` gains a top-level `$models` array (the `$` prefix avoids collisions with agent names). The project never read an extensionless `subagent-models` plain-text file; the available-model list is carried solely by the `$models` field.
  - Read semantics (`loadAvailableModels`): a valid project-level `$models` array shadows the user-level list wholesale — an explicit `[]` included, so a project can blank the user list; a non-array `$models` counts as absent. Entries are cleaned (strings only, trimmed, blanks dropped, first-occurrence dedupe). `loadModelOverridesFile` ignores `$models`, so it never becomes an agent override.
  - Editing a model override now selects from `$models` when the list is non-empty (the chosen ID itself is written) and falls back to free-text input when empty or unconfigured.
  - `/subagent-config` carries a `Manage available model list ($models)` entry: view the current list with its source, add or remove entries, and choose the write target (user/project). Removing the last entry keeps `"$models": []` so a project level can explicitly shadow the user list; writes preserve every other top-level key verbatim and refuse to overwrite invalid JSON.
- Process memory-level temporary overrides: `/subagent-config`'s `model`/`thinking` edits (clear options included) now offer a three-way write target — `this process` (in-memory), `user`, `project` — so multiple pi windows sharing the same `subagent-isolation.json` can adjust one agent's model/thinking for the current window only, without touching the shared file.
  - The `this process` target keeps the override in a module-level in-memory singleton: no file is written or read, only the current process sees it, and it disappears on process exit or `/reload` (other windows are unaffected). The write notice reads `written to this process (memory only — no file written; disappears when the process exits)`.
  - The priority chain is now process memory > project JSON > user JSON > frontmatter, with the same whole-key shadowing as the file layers (`{...user, ...project, ...process}`): a process entry shadows lower-level entries of the same agent key wholesale.
  - Effective-value source attribution (field options) reports the literal `process` source (e.g. `model — deepseek/deepseek-v4-pro (process)`); the write-target select labels the option `this process` and marks the currently governing source with `(current)`.
  - Clearing at the memory layer removes that agent's in-memory override (a last-field clear drops the whole key; a missing entry is a no-op) and the result notice recomputes the effective value under the whole-key merge — falling back to the file configs (project/user) or frontmatter.
  - `$models` is unaffected: the available-model list stays file-level with its two write targets (`user`/`project`).
  - Extension-developer API: `setProcessOverride(agentName, patch)` (same patch semantics as `writeModelOverride`: string sets, null clears, undefined leaves untouched; reserved keys rejected), `getProcessOverrides()` (returns a copy), `clearProcessOverride(agentName)`, and `resetProcessOverridesForTests()` (test-isolation hook that empties the layer, simulating process exit/reload).
- Config write-back hardening (`writeModelOverride`): unknown top-level keys (`$schema`, `$models`, ...) and unknown in-entry fields are preserved verbatim; all validation runs before any IO, so invalid values or an unreadable/invalid target file are rejected as a whole without a half-written state; UTF-8 BOM prefixes are tolerated on read; reserved keys (`__proto__`, `constructor`, `prototype`) are rejected outright as prototype-pollution vectors.

### Changed

- Zero-agent behavior of `/subagent-config`: the command no longer exits early when no agents are discovered — the picker still opens with the `$models` management entry, so the available-model list stays manageable.
- Unified entry: `/subagent-config` is now the only interactive config command; the `/subagent-models` shortcut is removed (model/thinking are two of its six fields, so a separate command was redundant).
- Rename support removed: editing `name` is gone — the name is a read-only identity, and `updateAgentFile` rejects any patch containing `name` outright (even a valid new name, with no half-written mixed patch).
- Detail-view notification removed: selecting an agent no longer prints a configuration summary to the chat; the picker and field-select annotations carry the effective values and sources instead.
- The example master agent prompt (`examples/pi/agent/master.md`) now notes that its hand-written "可用子 Agent" table can be replaced by the automatically injected roster (the table is kept for its tools column).

## [1.5.1] - 2026-08-17

### Added

- The `[subagent-result]` envelope now opens with a fixed trigger line (a blockquoted meta-instruction), inserted verbatim right after the title line (`## [subagent-result] <agent> <status> (taskId: ...)`), before the metadata and in-flight blocks: `> [subagent-result] 任务完成通知，非用户新指令。处理前先锚定你当前正在执行的主线任务与进度；对照派发记录消化本通知，勿让通知覆盖或改写你的主线计划。`
  - Motivation: with steer delivery a notification lands mid-turn (after the current turn's tool calls, before the next LLM call), which can break the continuity of the main agent's in-flight turn plan. The line does three jobs in one pass — identity correction (this is a completion notification, not a new user instruction), mainline retention (anchor the mainline task and progress currently in flight before processing), and processing order (anchor the mainline first, then digest the notification against dispatch records).
  - The wording is deliberately unconditional, leaving no "the result is important, so interrupting the mainline is fine" loophole.
- New "notification digestion" entry in the `subagent` tool's `promptGuidelines`, carrying the same semantics into the tool description: a `[subagent-result]` is a completion notification, not a new user instruction; anchor the current mainline task and progress before handling it; digest it against your dispatch records; decide the next step autonomously from the result; when it conflicts with the mainline, defer rather than letting the notification rewrite your mainline plan.

### Changed

- The example master agent prompt (`examples/pi/agent/master.md`) now documents the digestion flow in its notification-handling rule (core rule 4) and async-work discipline: anchor the current mainline task and progress before digesting a `[subagent-result]` notification, and defer when it conflicts with the mainline.

## [1.5.0] - 2026-08-17

### Changed

- Agent-initiated cancellation (`subagent` tool, `action="cancel"`) is now a two-step confirmation, adding structural friction against the main agent reflexively cancelling healthy in-flight tasks: the first `action="cancel"` call (no `confirm`, or `confirm` not `true`) has zero side-effects and only returns a challenge receipt (`details.confirmRequired: true`) spelling out the agent name, task summary, elapsed time and last progress age (or "尚无进度上报" when the task never reported), plus a warning that cancelling discards all in-flight progress and cannot be undone. To actually cancel, call again with the same `taskId` + `confirm: true` + a non-empty `reason`.
  - New optional tool parameters: `confirm` (boolean, default `false`) and `reason` (string). With `confirm: true`, a missing or blank `reason` is an error with zero side-effects; the task-existence check still runs first, so an unknown taskId keeps returning the "无此运行中任务" error.
  - A confirmed cancel records the reason on the task record (`cancelReason`, full value) and quotes it in the `[subagent-result]` envelope body ("取消理由: ...", single-lined and capped at 200 chars).
  - `SubagentProgressManager` now tracks the last progress timestamp per task (`getLastActivityAt(sessionId)`), feeding the challenge's "最近进度距今" line.
  - Tool description / promptGuidelines updated: two-step cancel guidance, plus explicit waiting semantics — waiting means making no tool call at all and ending the turn; there is deliberately no query/nag/status action for in-flight tasks.
  - User paths (`/subagent-cancel`, `/subagent-cancel-all`, interactive picker) are unchanged: single-step, no confirmation required.

### Fixed

- `[subagent-result]` completion notifications could lag behind work dispatched later in the same turn, and the envelope's in-flight block used the absolute wording "当前无在途任务" for a build-time snapshot that may already be stale at delivery:
  - Notifications are now sent with `deliverAs: "steer"` (previously `"followUp"`; `triggerTurn: true` unchanged): pi delivers them after the current assistant turn's tool calls finish, before the next LLM call, instead of waiting for the entire agent run to end.
  - The in-flight block is now event-anchored to the envelope task's end event — "本任务结束时无其他在途任务。" / "本任务结束时，其他在途任务: N" — with no absolute "当前/此刻" claims and no clock times, so the main agent can order the snapshot against its own dispatch records.
  - New `promptGuidelines` entry: the in-flight block is a build-time snapshot that may be stale by delivery; when it conflicts with dispatch records the main agent issued itself this turn, the dispatch records prevail.
  - The `action="cancel"` confirmation receipt keeps its remaining-tasks list but with wording anchored to the cancel request (no task has ended at that point), no longer sharing the envelope's "本任务结束" anchor.

## [1.4.0] - 2026-08-16

### Added

- `/subagent-result` without a taskId (TUI mode) now opens an interactive picker listing the 5 most recently finished subagent tasks, latest first: `↑↓` moves the selection and `Enter` opens the same full-screen result viewer as the with-argument path. The picker is backed by a new in-memory record of finished tasks (capped at 50 entries), so the list starts empty after a pi restart or a new session; looking up an explicit taskId is unaffected.
- `/subagent-cancel` without a taskId (TUI mode) now opens an interactive picker listing all running tasks (no count limit): `Enter` cancels the selected task through the same cancel flow as the with-argument path.
- Both pickers dismiss on `Esc` / `q` / `Q` / `Ctrl+C` without taking any action or emitting a notification. (The selector is built on `ctx.ui.custom()` with a SelectList because the built-in `ctx.ui.select` cannot exit on `q`.) The with-taskId usage, `/subagent-cancel-all`, and the non-TUI fallbacks are unchanged.

### Fixed

- When a reused sessionId makes the same taskId finish more than once, the finished-task record is now deduplicated by taskId (the newest record replaces the older one), so a single task can no longer occupy multiple slots of the 50-entry history.

## [1.3.0] - 2026-08-15

### Added

- Added `formatDuration` for finished runs: milliseconds → `MM:SS`, or `H:MM:SS` at one hour and beyond (hours not zero-padded); 0/negative input renders as `00:00`.
- Added a required `durationMs` field (run time in milliseconds) to `SubagentResultDetails`: the real run time (`finishedAt - startedAt`) when a result exists, measured from dispatch time when the result is null (cancel or internal error).

### Changed

- The `[subagent-result]` envelope's `耗时` line now shows the real run duration (`formatDuration(durationMs)`) instead of the time since dispatch (`formatElapsed`). `formatElapsed` remains for the progress widget's live "alive since" clock; the two coexist with different semantics.
- The TUI notification card and the sync-mode rich rendering now show the run duration for all terminal states: success, failure, timeout, and cancelled.
- The example master agent prompt (`examples/pi/agent/master.md`) has been rewritten in a "task commander" style: the role is upgraded to team lead and quality gatekeeper with full ownership of deliverable quality (substandard results are never delivered), and new general-purpose management sections cover task orchestration principles, context handoff conventions, leaving solution design to subagents, async work discipline, and quality review with iteration. All plugin mechanics (the agent table, tool surface, the 8 core rules, dispatch examples, and isolation notes) are preserved verbatim, and the additions are generic rather than tied to any personal environment.

## [1.2.0] - 2026-08-14

### Removed

- Removed the `status` action from the `subagent` tool. In-flight task information is now provided only by the `[subagent-result]` notification envelope's in-flight block. Prompt/workflow authors who reference `action="status"` should remove those references; see README migration notes.

### Changed

- Updated tool schema, prompts, and documentation to reflect the `dispatch` / `cancel` action surface only.
- The `subagent` tool's `sessionId` parameter now strictly requires a lowercase UUID v7. The plugin previously accepted any string matching `^[A-Za-z0-9_.-]+$`, which let slug values like `"tester-status-remove"` slip through and render as opaque taskIds in the progress widget. The parameter is reserved for resuming a previously dispatched task, so it must be the UUID v7 returned in the dispatch receipt. Any other input (slug, UUID v4, uppercase, etc.) is rejected with an error message explaining the constraint. Omit `sessionId` to start a new task — the system auto-generates a UUID v7.

## [1.1.1] - 2026-08-14

### Fixed

- Wrapped agent frontmatter parsing in error handling so a single malformed agent Markdown file no longer prevents every other agent in the same directory from loading.
- Validated that agent `name` and `description` are non-empty strings; objects, arrays, numbers, booleans, null, and whitespace-only values are now skipped with a clear warning instead of being silently coerced.

## [1.1.0] - 2026-08-13

### Changed

- Merged the standalone `subagent_status` and `subagent_cancel` tools into the single `subagent` tool via an `action` parameter (`dispatch` by default, plus `status` and `cancel`); one `--tools` allowlist entry now exposes the full capability.
- Subagents can no longer invoke any `subagent` action (previously only dispatch was blocked).

### Removed

- Removed the separate `subagent_status` and `subagent_cancel` tool registrations; migrate allowlists and prompts to `subagent` with `action=status` / `action=cancel`.

### Fixed

- Fell back to plain-text rendering for status/cancel receipts that lack a results array.

## [1.0.1] - 2026-08-13

### Fixed

- Aligned the subagent name column in the progress widget.

## [1.0.0] - 2026-08-13

First stable npm release. No functional changes since 0.1.0.

## [0.1.0] - 2026-08-12

### Added

- Asynchronous evolution of subagent-isolation: background dispatch in TUI mode with `[subagent-result]` notifications.
- `subagent_status` and `subagent_cancel` tools, plus `/subagent-cancel`, `/subagent-cancel-all`, and `/subagent-result` commands.
- In-flight task ledger for tracking dispatched subagents.
- `/subagent-result` viewer rendering the original task and the full session transcript (assistant turns, tool calls, tool results) with vim/less-style keybindings (space/b/j/k/g/G, q to close).
- Status-colored `[subagent-result]` notification cards matching the dispatch receipt look.
- Full TDD test suite (180 tests).
