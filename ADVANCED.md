<div align="right"><a href="ADVANCED.en.md">English</a></div>

# async-subagent-isolation 进阶参考

这里收录 `async-subagent-isolation` 的底层调用方式、配置字段和环境变量。普通用户按照主 README 的 Quick Start 用自然语言即可；只有当你需要手动构造 `subagent` 调用、复用隔离会话或调整运行参数时才需要查看本文档。

---

## Agent 定义格式

Agent 是 agents 目录中的 Markdown 文件（`.md`）。frontmatter 描述元数据，正文成为系统提示。

```markdown
---
name: coder
description: 编写整洁的 TypeScript 并处理重构。
tools: read, edit, write, bash
model: claude-3-7-sonnet
skills: /path/to/skill1,/path/to/skill2
---

你是一名资深 TypeScript 工程师。优先使用 async/await，避免回调。
```

## Frontmatter 字段

| 字段 | 类型 | 说明 |
|------|------|------|
| `name` | `string` | **必填。** 工具调用时使用的唯一标识符。 |
| `description` | `string` | **必填。** 在 agent 列表和错误信息中显示的简短描述。 |
| `tools` | `string[]`（逗号分隔） | 可选的子 agent 工具白名单。 |
| `model` | `string` | 可选的模型覆盖，例如 `claude-3-7-sonnet`。 |
| `thinking` | `string` | 可选，思考等级。值为 `off \| minimal \| low \| medium \| high \| xhigh \| max`。 |
| `skills` | `string[]`（逗号分隔） | 可选的 skill 路径列表。若存在，则禁用全局 skills，仅加载列出的 skill。路径可绝对或相对于工作目录。 |

## 异步模式（TUI）

在 TUI 交互模式下，`subagent` 工具是**异步**的：调用后立即返回派发回执，子 agent 在后台运行，完成后结果以 `[subagent-result]` 系统通知推送到对话中。非 TUI 模式（print/json，包括 `mode` 为 `undefined`）则降级为同步——等待子 agent 完成后直接返回完整结果，无通知。

### 派发回执

TUI 模式下 `subagent` 立即返回如下回执（不是结果！）：

```
已派出 coder. taskId: 01912345-6789-7abc-8def-0123456789ab
```

关键点：

- **回执为单行。** 异步语义引导（不臆造结果、不轮询、结果以 `[subagent-result]` 通知到达）已内嵌于 `subagent` 工具的 `description` / `promptGuidelines`，回执本身保持单行。
- **回执 ≠ 结果。** 不要臆造结果。
- **taskId = sessionId。** 回执中的 `taskId` 就是 session ID，可直接复用。
- **不要轮询。** 结果自动以 `[subagent-result]` 通知到达；如需确认还有哪些任务在途（如 `/tree` 回退后），用 `subagent_status` 工具查询。

### [subagent-result] 信封格式

子 agent 完成后，结果以如下格式推送到对话：

```
## [subagent-result] coder 成功 (taskId: 01912345-6789-7abc-8def-0123456789ab)

- 状态: 成功
- 任务: 将认证中间件重构为使用 async/await。
- 耗时: 02:34 · 用量: 5 turns/↑12.5k/↓3.2k/$0.0042
- 会话: 01912345-6789-7abc-8def-0123456789ab

在途任务: 1
- 01912345-aaaa-7bbb-8ccc-0123456789ab (writer): 更新 README。

---
<子 agent 完整结果文本>
```

状态枚举：**成功**（exit=0）/ **失败**（exit≠0 或 stopReason=error）/ **超时**（activity_timeout 或 hard_timeout）/ **已取消**（aborted 或 killed_on_shutdown）。

"已取消"分三种情况，信封正文不同：
- 用户通过 `/subagent-cancel` 取消（cancelledBy: user）→ 正文注明"属用户主动操作。请勿自动重新派发；如需重新派发，先询问用户。"
- 主 agent 通过 `subagent_cancel` 工具取消（cancelledBy: agent）→ 正文注明"该任务已由主 agent 通过 subagent_cancel 工具取消。"
- 会话关闭（session_shutdown）终止（cancelledBy: 无）→ 正文注明"任务因会话关闭被终止（session_shutdown）。"

主 agent 收到状态为"已取消"的通知时，应区分来源：用户主动取消**不得自动重试**，必须先询问用户；agent 取消是自身决策，不应在无新信息时重新派发；会话关闭终止可在会话恢复后视情况重新派发。

**在途任务块**：信封元信息区的"在途任务"列表列出**其余**仍在运行的后台任务（本任务在构建信封前已从注册表移除，故不包含自身），格式与 `subagent_status` 工具一致——`在途任务: N` 加每行 `- taskId (agent名): 任务描述`，无在途任务时为"当前无在途任务。"。列表**不含耗时**（回答"还有什么在跑"，而非"跑了多久"）。主 agent 据此知道还有几个任务没回来：剩余不为 0 时，不要向用户汇报"全部完成"。

结果全量进入 LLM 上下文（不截断）。`details` 携带结构化数据（taskId、agent、status、exitCode、stopReason、usage、sessionId、完整输出），不参与 LLM 上下文，供程序消费。

### 通知投递

通知通过 `pi.sendMessage` 发送，`deliverAs: "followUp"` + `triggerTurn: true`：
- 主 agent 空闲时直接触发新的对话回合。
- 主 agent 忙碌时进入消息队列，待当前回合结束后触发。

主 agent 通过 promptGuidelines 被训练识别 `[subagent-result]` 前缀为系统通知（非用户请求）。

### 进度 widget

子 agent 运行时，TUI 编辑器上方会显示进度 widget，列出所有在飞任务。每行包含 taskId、agent 名称、当前阶段和耗时，例如：

```
● 01912345-abcd... coder    ⚡ read...         01:23
```

widget 行中的 taskId 可直接复制，用于 `/subagent-result` 查看结果或 `/subagent-cancel` 取消任务。

### subagent_status（在途任务查询）

主 agent 可主动查询仍在运行的后台任务，调用 `subagent_status` 工具（无参数），返回：

```
在途任务: 2
- 01912345-6789-7abc-8def-0123456789ab (coder): 将认证中间件重构为使用 async/await。
- 01912345-aaaa-7bbb-8ccc-0123456789ab (writer): 更新 README。
```

无在途任务时返回 `当前无在途任务。`。每行含 taskId、agent 名和任务描述，**不含耗时**。

用途场景：

- `/tree` 回退后回执丢失，确认还有哪些任务在途。
- 不确定剩余任务时快速核对，或选取 taskId 用于 `subagent_cancel`。

**不要用它轮询完成状态**：结果会自动以 `[subagent-result]` 通知到达，本工具只用于确认"还有什么在跑"，不应频繁调用。

### 取消后台任务

取消运行中的后台子 agent 任务有两条路径，底层共享同一套取消流程（SIGTERM → 5s → SIGKILL 级联，最终推送 `[subagent-result]` 通知）。

**路径一：用户命令**

用户在 TUI 中输入 `/subagent-cancel <taskId>` 取消单个运行中的任务：

```
/subagent-cancel <taskId>
```

不带参数时列出当前运行中的任务。取消来源标记为 `cancelledBy: "user"`。

一键取消所有运行中的任务：

```
/subagent-cancel-all
```

无参数。与 `/subagent-cancel` 按 taskId 取消单个任务不同，`/subagent-cancel-all` 取消全部运行中的任务。每个被取消任务照常推送各自的"已取消" `[subagent-result]` 通知（主 agent 会收到 N 个已取消信封）。成功时提示"已取消全部 N 个运行中任务"，无运行中任务时提示"无运行中任务可取消"。取消来源同样标记为 `cancelledBy: "user"`。

**路径二：主 agent `subagent_cancel` 工具**

主 agent 可调用 `subagent_cancel` 工具（参数 `taskId`）取消已派出的后台任务。取消来源标记为 `cancelledBy: "agent"`。取消成功后返回剩余在途任务列表（格式与 `subagent_status` 一致），被取消任务的最终结果稍后以 `[subagent-result]` 通知返回。

**使用纪律：** 主 agent 仅在以下情况使用 `subagent_cancel`：
- 任务明显错误（委派了错误的 agent、任务描述有误等）。
- 任务不再需要（用户需求变更、后续发现无需此步骤）。

**禁止**因等待时间长而取消——后台子 agent 本就预期长时间运行。取消的依据是"这个任务不该继续"，不是"等太久了"。

### /subagent-result

查看某后台任务的完整返回。仅限用户在 TUI 中使用：

```
/subagent-result <taskId>
```

- 不带参数时提示用法。
- 任务仍在运行 → 提示"任务仍在运行，完成后才能查看"。
- 无此任务记录 → 提示"无此任务记录: `<taskId>`"。
- 任务存在但无最终输出（可能已被终止） → 提示"任务无最终输出（未产生 assistant 文本，可能已被终止）"并附会话文件路径。
- 有输出时在全屏查看器中展示完整 Markdown 结果，按 Enter 或 Esc 关闭。

### session_shutdown

退出、切会话或 reload 时，自动 kill 所有在飞子进程并标记 `killed_on_shutdown`。对应的 `[subagent-result]` 通知正文为"任务因会话关闭被终止（session_shutdown）。"与用户主动取消的正文不同。注意：扩展 reload 或进程崩溃时，在飞任务不落盘、不补投；任务完成后若扩展已死，通知丢失（可查 session 记录）。

### TUI / 非 TUI 差异总结

| 行为 | TUI | 非 TUI（print/json） |
|------|-----|----------------------|
| execute 返回 | 立即返回派发回执 | 等待子 agent 完成后返回完整结果 |
| 结果投递 | `[subagent-result]` 系统通知 | 直接内联在返回值中 |
| /subagent-cancel | 可用 | 不可用（无 TUI 命令系统） |
| /subagent-cancel-all | 可用 | 不可用（无 TUI 命令系统） |
| 并行派发 | 支持（无依赖任务可同时派出） | 不支持（每次调用阻塞） |

## 手动调用

如果需要手动发起调用，JSON 格式如下：

```json
{
  "agent": "coder",
  "task": "将认证中间件重构为使用 async/await。"
}
```

> **注意**：`task` 字段必须非空，且建议按照 `master.md` 中的标准任务格式书写，包含：**背景、输入、要求、输出格式、验收标准**。空字符串或仅包含空白的 `task` 会被拒绝执行。

## sessionId 复用

### 非 TUI 模式

子 agent 完成后，返回结果末尾会附带 session ID：

```
<子 agent 的输出>

[subagent session: 01912345-6789-7abc-8def-0123456789ab]
```

下次继续同一任务时，传入 `sessionId` 即可复用隔离会话：

```json
{
  "agent": "coder",
  "task": "为重构后的认证中间件添加单元测试。",
  "sessionId": "01912345-6789-7abc-8def-0123456789ab"
}
```

> ⚠️ **并发提醒**：同一个 `sessionId` 不要同时用于多个并发的 `subagent` 调用，否则可能损坏 session 文件。请顺序复用，或确认子 agent 已完全退出。

### TUI 模式

派发回执中直接包含 `taskId`（即 session ID）。`[subagent-result]` 通知信封的 `- 会话:` 行也携带 sessionId——复用即可。无需等待子 agent 完成就已经拿到了。

## 环境变量

以下变量会自动传播到每个子 agent 进程：

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `PI_SUBAGENT_DEPTH` | `0` | 当前递归深度。每次嵌套调用自动递增。**深度限制为 1**——子 agent（depth ≥ 1）不可再派发 `subagent`，递归委派已被完全禁止。 |
| `PI_CURRENT_AGENT_NAME` | — | 当前 agent 名称，注入每个子 agent 进程。 |
| `PI_SUBAGENT_ACTIVITY_TIMEOUT_MS` | `600000`（10 分钟） | stdout 和 stderr 均无输出（无活动）时的最大允许时间。 |
| `PI_SUBAGENT_HARD_TIMEOUT_MS` | `0`（禁用） | 单次调用的绝对最大运行时长。设为正数（毫秒）启用。 |

## 超时与终止

- 活动超时 10 分钟：子 agent 的 stdout 和 stderr 长时间均无输出（无活动）会被终止。计时器自子进程启动即开始计时，stdout 或 stderr 任一有数据即重置。
- 硬超时默认禁用（`PI_SUBAGENT_HARD_TIMEOUT_MS=0`），不设绝对最大运行时长。如需启用，显式设置为正数毫秒值。
- 超时 kill 时结果中的 `stopReason` 为 `"activity_timeout"`（活动超时）或 `"hard_timeout"`（硬超时），会出现在诊断输出（`Stop reason: ...`）和 UI 徽标中，用于区分"超时被杀"与"子 agent 主动失败"。
- 收到 `AbortSignal` 时先发送 `SIGTERM`，5 秒后未退出则发送 `SIGKILL`。异步模式下，用户可通过 `/subagent-cancel <taskId>` 或 `/subagent-cancel-all` 触发取消。
