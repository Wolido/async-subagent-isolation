<div align="right"><a href="README.en.md">English</a></div>

<div align="center"><img src="logo.svg" alt="async-subagent-isolation logo" width="150"></div>

# async-subagent-isolation

<div align="center">

[![TypeScript](https://img.shields.io/badge/TypeScript-3178C6?logo=typescript&logoColor=white)]()
[![Pi Package](https://img.shields.io/badge/Pi_Package-8B5CF6)]()
[![npm version](https://img.shields.io/npm/v/@wolido/async-subagent-isolation)](https://www.npmjs.com/package/@wolido/async-subagent-isolation)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

</div>

**async-subagent-isolation** 是 [Pi Agent](https://github.com/earendil-works/pi) 的扩展，也是 [subagent-isolation](https://github.com/Wolido/subagent-isolation)（同步版）的**异步演进**。

核心约束不变：**主 agent 不能碰代码**。没有 `write`、没有 `edit`、没有 `bash`，只有 `read`、`grep`、`find`、`ls` 四个只读工具，外加一个 `subagent` 工具用来委派任务。所有修改文件、跑命令、执行逻辑的工作都交给子 agent——每个子 agent 跑在独立的 `pi` 进程中，有自己的 system prompt 和 skills，主 agent 与子 agent、子 agent 与子 agent 之间进程完全隔离。

关键区别在**异步**：TUI 模式下，主 agent 派发子 agent 后**立即返回回执**（`已派出 <agent>. taskId: <taskId>`），不阻塞等待；子 agent 在后台独立进程运行，完成后结果以 **[subagent-result] 系统通知**推回对话。主 agent 空闲时通知直接触发处理，忙碌时排队。等待期间主 agent 可以并行派发多个任务、继续做其他工作。

子 agent 把不断膨胀的上下文切成小块、各管一段；异步让主 agent 的上下文只保留"要做什么"和"结果是什么"，子 agent 冗长的执行痕迹留在自己的进程里，不污染主 agent。

---

## 同步版 vs 异步版

本项目是 [subagent-isolation](https://github.com/Wolido/subagent-isolation) 的异步演进，两者目标一致——把执行能力从主 agent 剥离、放进隔离的 `pi` 进程；区别只在委派语义：

| | 同步版（原项目） | 异步版（本项目） |
|---|---|---|
| 派发后 | 阻塞等待子 agent 完成 | **立即返回回执**（含 `taskId`） |
| 结果呈现 | 在工具返回值处直接内联 | 以 `[subagent-result]` 系统通知到达 |
| 并行 | 每次调用阻塞，只能串行 | 可并行派发多个任务 |
| 等待期 | 主 agent 回合被占用 | 等待期间继续其他工作 |
| 结果是否阻塞主 agent 回合 | 阻塞 | 不阻塞 |

**原项目继续作为同步版维护。** 需要同步阻塞语义（结果就在调用处返回）用原项目；需要异步并行、后台执行、派发即返回用本项目。

---

## 直接面对调度者

同步版里，每次委派都阻塞等待，体验上你面对的是一个"智能体集群"：主 agent 派完活就沉默，等子 agent 干完才回来，中间是一段段接力执行的空白。异步版把这一点翻了过来，**你的对话对象始终只有主 agent 一个**。

主 agent 是调度者：理解需求、拆任务、派发、汇总结果。子 agent 是幕后工人，每个都在后台独立进程里跑，完成后用 `[subagent-result]` 通知把结果送回主 agent。你不直接和子 agent 对话，也不需要；查看结果用 `/subagent-result`，取消任务用 `/subagent-cancel`，中间过程交给调度者。

更关键的是**派发之后的自由**。任务在后台跑的时候，你可以继续和主 agent 聊天：细化需求、调整规划、商量下一步，或提出新任务。主 agent 不必干等，可以继续规划，甚至并行派发更多任务。前台对话与后台工作并行推进。

最后是**结果回来再验收**。子 agent 完成，通知到达，主 agent 处理并向你汇报。等待期间你可以随时查看在途状态（进度 widget 或 `subagent_status`），但不必盯着。

一句话：同步版让你陷在"集群执行"的阻塞感里；异步版让你只面对调度者，后台工作与你自己的节奏并行。

---

## 和常规子 agent 的区别

很多子 agent 实现只是"在主 agent 内部开一个工具调用"：子 agent 仍复用主 agent 的提示词和 skills，主 agent 也仍保留写文件、跑命令的能力——隔离是可选的、不彻底的。

async-subagent-isolation 做的是强制且完全的隔离：

- **进程完全隔离**：每个子 agent 启动独立的 `pi` 进程。
- **提示词完全隔离**：子 agent 有自己的 agent 定义文件（如 `coder.md`），不继承主 agent 的 `master.md`。
- **Skills 完全隔离**：主 agent 和每个子 agent 各自加载自己的 skill，互不干扰。
- **执行能力完全隔离**：主 agent 被剥夺 `write`/`edit`/`bash`，只能委派，无法自己执行。
- **独立可配置**：每个 agent 单独定义自己的 `tools` 和 `skills`，精确控制它能做什么、不能做什么。

此外，子 agent 只拿到委派的那一句话、看不到主 agent 的执行痕迹（上下文隔离），且不可再委派（递归深度限制为 1）。

常规子 agent 是"分工"；async-subagent-isolation 是"彻底分家"。

---

## 异步工作流

这是与同步版最大的不同，也是核心使用方式（TUI 模式）。

### 1. 派发（`subagent` 工具）

主 agent 调用 `subagent`，为子 agent 启动独立的 `pi` 进程。非 TUI 模式（print/json）自动降级为同步——等待完成后直接返回结果，无通知。

### 2. 回执（立即返回）

TUI 模式下 `subagent` **立即返回派发回执**，不阻塞：

```
已派出 coder. taskId: 01912345-6789-7abc-8def-0123456789ab
```

`taskId` 就是 session ID，之后可复用来继续同一任务。**回执不是结果**——不要臆造结果。

### 3. 后台执行 + 进度 widget

子 agent 在后台独立进程运行。TUI 编辑器上方显示进度 widget，实时列出所有在飞任务（taskId、agent、当前阶段、耗时）：

```
● 01912345-abcd... coder    ⚡ read...         01:23
```

### 4. 结果通知（`[subagent-result]`）

子 agent 完成后，结果以 **`[subagent-result]` 系统通知**推送到对话（系统消息，不是用户请求）：

- 主 agent **空闲**时，通知直接触发新的对话回合，立即处理。
- 主 agent **忙碌**时，通知进入队列，当前回合结束后再触发。

结果自动到达，**无需轮询**。如需确认还有哪些任务在途（例如 `/tree` 回退后回执丢失），用 `subagent_status` 工具查询。

### 5. 查看全文（`/subagent-result`）

通知卡片只显示摘要。用 `/subagent-result <taskId>` 在全屏查看器中阅读完整返回：`↑↓`/`jk` 滚动、`Space`/`b` 翻页、`g`/`G` 首尾、`Enter`/`Esc`/`q` 关闭。

### 完整流程一览

```
主 agent 派发 subagent
      │ 立即返回回执（已派出 <agent>. taskId: <id>）
      ▼
子 agent 在后台独立进程运行（进度 widget 实时显示）
      │
      ▼
完成后推 [subagent-result] 系统通知 ──► 主 agent 空闲直接处理 / 忙碌排队
      │
      ▼
用户 /subagent-result <taskId> 查看完整返回
```

---

## 工具与命令面

### 工具（主 agent 使用）

| 工具 | 作用 | 关键约束 |
|------|------|----------|
| `subagent` | 异步派发任务（TUI 模式）；非 TUI 自动降级同步 | 回执≠结果；结果以通知到达，勿轮询 |
| `subagent_status` | 查询在途任务（taskId、agent、任务描述，**无耗时**） | 仅确认"还有什么在跑"，勿用它轮询完成 |
| `subagent_cancel` | 主 agent 取消单个在途任务 | 仅当任务明显错误或不再需要，勿因耗时久而取消 |

### 命令（用户使用）

| 命令 | 作用 |
|------|------|
| `/subagent-cancel <taskId>` | 取消单个运行中的后台任务（不带参数时列出运行中任务） |
| `/subagent-cancel-all` | 一键取消全部运行中的后台任务 |
| `/subagent-result <taskId>` | 全屏查看某任务的完整返回 |

---

## 通知信封与卡片

`[subagent-result]` 通知是**自包含**的，一次带全主 agent 处理结果所需的全部信息：

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

- **状态**：`成功` / `失败` / `超时` / `已取消`。
- **在途任务块**：列出其余仍在运行的后台任务（不含自身），让主 agent 知道还有几个任务没回来——剩余不为 0 时，不要向用户汇报"全部完成"。
- **完整结果**：正文全量进入 LLM 上下文，不截断。

用户在 TUI 中看到的是**带底色的摘要卡片**，不是全文：成功绿色（✓）、失败红色（✗）、超时/已取消黄色。卡片只显示 agent、状态、taskId 和用量摘要，并提示 `查看全文: /subagent-result <taskId>`；完整结果保存在任务会话文件中。

信封完整格式、状态语义与取消来源区分见 [ADVANCED.md](ADVANCED.md)。

---

## 设计纪律

异步模式引入的几条纪律，内嵌在工具提示词和实现中，主 agent 自动遵守：

- **取消来源区分**：`已取消` 有用户（`/subagent-cancel`）、主 agent（`subagent_cancel`）、会话关闭（`session_shutdown`）三种来源；用户取消**不得自动重试**，须先询问。
- **防轮询**：结果以通知自动到达；`subagent_status` 只用于确认在途（如 `/tree` 回退后），不带耗时、不鼓励频繁调用。
- **防滥用取消**：`subagent_cancel` 内嵌提示词——仅当任务明显错误或不再需要时取消，勿因耗时长而取消（后台任务本就预期长时间运行）。
- **资源冲突纪律**：并行派发多个任务前，考虑它们是否会改同一批文件或代码区域；冲突时串行派发或先问用户。
- **递归委派完全禁止**：子 agent（深度 ≥ 1）不可再派发 `subagent`，深度限制为 1。
- **TUI 异步 / 非 TUI 同步降级**：只在 TUI 模式走异步路径；print/json 等非 TUI 模式降级为同步阻塞。

---

## 前置条件：安装 Pi Agent

先安装 Pi Agent（需 Node.js >= 20）：

```bash
curl -fsSL https://pi.dev/install.sh | sh
# 或通过 npm：
npm install -g --ignore-scripts @earendil-works/pi-coding-agent
```

---

## 快速开始

### 1. 安装扩展

```bash
pi install npm:@wolido/async-subagent-isolation
```

### 2. 复制示例 agent 与 skill

```bash
cp examples/pi/agent/agents/*.md ~/.pi/agent/agents/
cp examples/pi/agent/master.md ~/.pi/agent/master.md
cp -r examples/pi/agent/skills/* ~/.pi/agent/skills/
```

### 3. 启动主 agent

```bash
pi --tools read,grep,find,ls,subagent \
   --no-skills \
   --append-system-prompt ~/.pi/agent/master.md \
   --skill ~/.pi/agent/skills/brainstorming/
```

这条命令把主 agent 限制为只读工具 + `subagent` 委派（剥夺 `write`/`edit`/`bash`），并加载主 agent 提示词和 brainstorming skill。日常使用可设 alias：

```bash
alias pp='pi --tools read,grep,find,ls,subagent --no-skills --append-system-prompt ~/.pi/agent/master.md --skill ~/.pi/agent/skills/brainstorming/'
```

启动后直接说需求，例如"把认证中间件重构为 async/await"，主 agent 会自动派 `coder` 子 agent。子 agent（coder、writer）通过 frontmatter 的 `skills:` 字段自动加载各自 skill，无需命令行指定；项目级 agent 放 `.pi/agents/` 即可。

---

## 示例 agents

仓库 [`examples/pi/agent/agents/`](https://github.com/Wolido/subagent-isolation/tree/main/examples/pi/agent/agents) 提供三个可直接参考的 agent：

| Agent | 作用 | 可用工具 | 加载的 skill |
|-------|------|----------|-------------|
| [`coder`](https://github.com/Wolido/subagent-isolation/blob/main/examples/pi/agent/agents/coder.md) | 写代码、改代码、跑验证 | `read, write, edit, bash, grep, find, ls` | `systematic-debugging` |
| [`reviewer`](https://github.com/Wolido/subagent-isolation/blob/main/examples/pi/agent/agents/reviewer.md) | 只读评审，输出可操作的反馈 | `read, grep, find, ls` | _(无)_ |
| [`writer`](https://github.com/Wolido/subagent-isolation/blob/main/examples/pi/agent/agents/writer.md) | 写文档、改 README、生成 commit message | `read, write, edit, grep, find, ls` | `writing-clearly-and-concisely` |

复制到 `~/.pi/agent/agents/`（用户级）或 `.pi/agents/`（项目级，同名时 project 覆盖 user）即可使用，可按需修改或新建。

---

## 为子 agent 指定模型

可用 `subagent-isolation.json` 为每个子 agent 单独指定模型与 thinking level（配置文件名沿用同步版，两者可共享）：

```json
{
  "coder": { "model": "deepseek/deepseek-v4-pro", "thinking": "high" },
  "writer": "deepseek/deepseek-v4-flash"
}
```

文件放在 `~/.pi/agent/subagent-isolation.json`（用户级）或 `.pi/subagent-isolation.json`（项目级，覆盖用户级同名 key）。thinking 等级、优先级与合并规则详见 [ADVANCED.md](ADVANCED.md)。

---

## 示例 skills

`examples/pi/agent/skills/` 提供三个 skill：`brainstorming`（主 agent 规划）、`systematic-debugging`（coder）、`writing-clearly-and-concisely`（writer）。复制到 `~/.pi/agent/skills/`（用户级）或 `.pi/skills/`（项目级）即可；子 agent 在 frontmatter 用 `skills:` 声明自动加载，主 agent 用 `--skill` 标志加载。

---

## 进阶用法

手写 `subagent` 调用、复用 `sessionId`、信封与在途任务块细节、`subagent_status` 查询、取消任务、环境变量等见 [ADVANCED.md](ADVANCED.md)。

---

## 项目结构

- `src/index.ts` — 扩展主源码
- `examples/pi/agent/` — 示例 agent 和 skill 定义（`master.md`、`agents/`、`skills/`）
- `package.json` — npm 包清单
- `tsconfig.json` — TypeScript 配置
- `README.md` / `README.en.md` — 说明文档
- `ADVANCED.md` / `ADVANCED.en.md` — 进阶参考
- `LICENSE` — MIT 许可证

---

## License

MIT
