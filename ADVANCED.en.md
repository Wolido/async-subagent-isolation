<div align="right"><a href="ADVANCED.md">中文</a></div>

# async-subagent-isolation advanced reference

This document covers low-level invocation, configuration fields, and environment variables for `async-subagent-isolation`. Most users can follow the natural-language Quick Start in the main README; refer to this file only when you need to construct `subagent` calls manually, reuse an isolated session, or tune runtime parameters.

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

## Async mode (TUI)

In TUI mode, the `subagent` tool is **asynchronous**: it returns a dispatch receipt immediately, the subagent runs in the background, and its result arrives later as a `[subagent-result]` system notification. Non-TUI modes (print/json, including `mode` `undefined`) fall back to synchronous — they wait for the subagent to finish and return the full result directly, with no notification.

### Dispatch receipt

In TUI mode, `subagent` returns this receipt immediately (it is NOT the result!):

```
Subagent "coder" 已派出 (dispatched). taskId: 01912345-6789-7abc-8def-0123456789ab
The subagent is running in the background. Its result will arrive later as a
[subagent-result] system notification (NOT a user request). Do not treat this
receipt as the result, do not fabricate results, and do not poll for status.
Reuse session id "01912345-6789-7abc-8def-0123456789ab" to continue this task later.
```

Key points:

- **The receipt is not the result.** Do not fabricate results.
- **taskId = sessionId.** The `taskId` in the receipt is the session ID; reuse it directly.
- **Do not poll.** Results arrive automatically as `[subagent-result]` notifications; to confirm which tasks are still in flight (e.g. after a `/tree` rewind), use the `subagent_status` tool.

### [subagent-result] envelope format

Once the subagent finishes, its result is pushed into the conversation:

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

Status enumeration: **成功** (success, exit=0) / **失败** (failure, exit≠0 or stopReason=error) / **超时** (timeout, activity_timeout or hard_timeout) / **已取消** (cancelled, aborted or killed_on_shutdown).

"Cancelled" has three sub-cases with different envelope bodies:
- User cancelled via `/subagent-cancel` (cancelledBy: user) → body states this is a deliberate user action; the main agent must NOT auto-retry and must ask the user before re-dispatching.
- Main agent cancelled via `subagent_cancel` tool (cancelledBy: agent) → body states the task was cancelled by the main agent via the subagent_cancel tool.
- Session shutdown killed the task (cancelledBy: none) → body states the task was terminated by session_shutdown.

When the main agent receives a "已取消" notification, it should distinguish the origin: a user cancel must never be auto-retried (ask the user first); an agent cancel is its own decision — do not re-dispatch without new information; a session-shutdown cancel can be re-dispatched after the session resumes, at the agent's discretion.

**In-flight block**: the "在途任务" list in the envelope's metadata section lists the **other** background tasks still running (this task is removed from the registry before the envelope is built, so it never appears in its own list). Its format matches the `subagent_status` tool — `在途任务: N` followed by one `- taskId (agent): task description` line per task, or `当前无在途任务。` when none remain. It deliberately carries **no elapsed time** (it answers "what is still running", not "how long has it run"). The main agent uses it to know how many tasks are still outstanding — while the count is non-zero, do not report "all done" to the user.

The full output enters the LLM context (not truncated). The `details` carries structured data (taskId, agent, status, exitCode, stopReason, usage, sessionId, full output) for programmatic consumption; it does not enter the LLM context.

### Notification delivery

Notifications are sent via `pi.sendMessage` with `deliverAs: "followUp"` + `triggerTurn: true`:
- When the main agent is idle, it triggers a new conversation turn immediately.
- When the main agent is busy, the notification is queued and triggers a turn after the current one finishes.

The main agent is trained (via `promptGuidelines`) to recognize the `[subagent-result]` prefix as a system notification, not a user request.

### Progress widget

While subagents run, a progress widget appears above the TUI editor, listing all in-flight tasks. Each row shows the taskId, agent name, current phase, and elapsed time:

```
● 01912345-abcd... coder    ⚡ read...         01:23
```

The taskId in the widget row can be copied for `/subagent-result` (view full result) or `/subagent-cancel` (cancel the task).

### subagent_status (in-flight query)

The main agent can actively query still-running background tasks via the `subagent_status` tool (no parameters), which returns:

```
在途任务: 2
- 01912345-6789-7abc-8def-0123456789ab (coder): 将认证中间件重构为使用 async/await。
- 01912345-aaaa-7bbb-8ccc-0123456789ab (writer): 更新 README。
```

With no in-flight tasks it returns `当前无在途任务。`. Each line carries the taskId, agent name, and task description, with **no elapsed time**.

Use cases:

- After a `/tree` rewind loses the receipts, confirm which tasks are still in flight.
- When unsure how many tasks remain, or to pick a taskId for `subagent_cancel`.

**Do not use it to poll for completion**: results arrive automatically as `[subagent-result]` notifications. This tool only confirms "what is still running" — it should not be called frequently.

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

Takes no arguments. Unlike `/subagent-cancel`, which cancels a single task by taskId, this cancels every running task. Each cancelled task still emits its own "已取消" `[subagent-result]` notification (the main agent receives N cancelled envelopes). On success it notifies "已取消全部 N 个运行中任务"; with no running tasks it notifies "无运行中任务可取消". The cancel source is likewise recorded as `cancelledBy: "user"`.

**Path 2: Main agent `subagent_cancel` tool**

The main agent can call the `subagent_cancel` tool (parameter `taskId`) to cancel a dispatched background task. The cancel source is recorded as `cancelledBy: "agent"`. On success, the tool returns the remaining in-flight task list (same format as `subagent_status`); the cancelled task's final result arrives later as a `[subagent-result]` notification.

**Usage discipline:** The main agent should only use `subagent_cancel` when:
- The task is clearly wrong (wrong agent, incorrect task description, etc.).
- The task is no longer needed (requirement change, later discovery that this step is unnecessary).

**Do NOT** cancel merely because the task is taking a long time — background subagents are expected to run long. The criterion for cancellation is "this task should not continue", not "it's been a while".

### /subagent-result

View the full final result of a background task. User-only, from the TUI:

```
/subagent-result <taskId>
```

- Without arguments, prints usage.
- Task still running → "任务仍在运行，完成后才能查看".
- No record found → "无此任务记录: `<taskId>`".
- Task exists but produced no final output (likely killed) → "任务无最终输出（未产生 assistant 文本，可能已被终止）" with the session file path.
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

The dispatch receipt contains the `taskId` (which is the session ID). The `[subagent-result]` envelope also carries the sessionId on the `- 会话:` line — just reuse it. No need to wait for the subagent to finish; you already have the session ID from the receipt.

## Environment variables

These variables are propagated into every subagent process automatically:

| Variable | Default | Description |
|----------|---------|-------------|
| `PI_SUBAGENT_DEPTH` | `0` | Current recursion depth. Auto-incremented per nested call. **Depth limit is 1** — a subagent (depth ≥ 1) cannot dispatch `subagent`; recursive delegation is blocked entirely. |
| `PI_CURRENT_AGENT_NAME` | — | Name of the current agent, injected into every subagent process. |
| `PI_SUBAGENT_ACTIVITY_TIMEOUT_MS` | `600000` (10 min) | Max idle time with no output on either stdout or stderr before the subagent is killed. |
| `PI_SUBAGENT_HARD_TIMEOUT_MS` | `0` (disabled) | Absolute maximum runtime for a single call. Set a positive value (ms) to enable. |

## Timeouts and termination

- Activity timeout: 10 minutes — subagent is killed if neither stdout nor stderr produces output (no activity). The timer starts as soon as the child process spawns and resets whenever either stream receives data.
- Hard timeout: disabled by default (`PI_SUBAGENT_HARD_TIMEOUT_MS=0`), no absolute maximum runtime. Set a positive value in milliseconds to enable.
- When a timeout kills the subagent, the result's `stopReason` is `"activity_timeout"` (activity timeout) or `"hard_timeout"` (hard timeout). It appears in the diagnostic output (`Stop reason: ...`) and as a UI badge, distinguishing "killed by timeout" from "subagent failed on its own".
- On `AbortSignal`, `SIGTERM` is sent; `SIGKILL` follows after 5 seconds if still running. In async mode, users can trigger cancellation with `/subagent-cancel <taskId>` or `/subagent-cancel-all`.
