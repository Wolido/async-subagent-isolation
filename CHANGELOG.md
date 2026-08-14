# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
