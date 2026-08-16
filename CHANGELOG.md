# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
