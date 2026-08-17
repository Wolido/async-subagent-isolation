# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
