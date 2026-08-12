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

关键区别在**异步**：在 TUI 模式下，主 agent 派发子 agent 后**立即返回回执**（`已派出 <agent>. taskId: <taskId>`），不阻塞等待；子 agent 在后台独立进程运行，完成后结果以 **[subagent-result] 系统通知**推回对话。主 agent 空闲时通知直接触发处理，忙碌时排队。等待期间主 agent 可以并行派发多个任务、继续做其他工作。

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

**原项目继续作为同步版维护。** 需要同步阻塞语义（结果就在调用处返回）的用户，用原项目；需要异步并行、后台执行、派发即返回的用户，用本项目。

---

## 为什么需要这个

大模型的有效上下文不是无限的。当一个 agent 同时负责读代码、改文件、跑测试，工具调用痕迹、报错信息、中间结果会迅速堆积。总上下文超过模型能稳定处理的阈值后，推理质量会明显下降——关键信息被淹没、重复劳动增多、决策开始基于嘈杂的上下文。

子 agent 系统的核心目的就是把一个不断膨胀的上下文切成多块。每个 agent 只处理自己那一小块任务，避免单一会话被历史痕迹拖垮。

**异步进一步放大了这个收益**：主 agent 派发后不被子 agent 的执行过程占用回合，上下文里只留下"要做什么"和"结果是什么"；子 agent 漫长的执行痕迹全部留在它自己的进程里，不会污染主 agent 的上下文。

## 和常规子 agent 的区别

很多子 agent 实现只是"在主 agent 内部开一个工具调用"。子 agent 仍然复用主 agent 的提示词和 skills，主 agent 也仍然保留着写文件、跑命令的能力——隔离是可选的、不彻底的。

async-subagent-isolation 做的是强制且完全的隔离：

- **进程完全隔离**：每个子 agent 启动独立的 `pi` 进程。
- **提示词完全隔离**：子 agent 有自己的 agent 定义文件（如 `coder.md`），不继承主 agent 的 `master.md`。
- **Skills 完全隔离**：主 agent 和每个子 agent 各自加载自己的 skill，互不干扰。
- **执行能力完全隔离**：主 agent 被剥夺 `write`/`edit`/`bash`，只能委派，无法自己执行。
- **独立可配置**：每个 agent 单独定义自己的 `tools` 和 `skills`，精确控制它能做什么、不能做什么。

常规子 agent 是"分工"；async-subagent-isolation 是"彻底分家"。

---

## Before / After

| Before | After |
|--------|-------|
| 一个 agent 同时做规划和执行，上下文超过阈值后推理质量下降 | 主 agent 只规划委派，每个子 agent 只处理自己的任务片段 |
| 主 agent 仍保留写文件、跑命令能力，隔离不彻底 | 主 agent 被剥夺 `write`/`edit`/`bash`，子 agent 在独立进程中运行 |
| 所有 skill 和工具堆在一个 agent 里，互相干扰 | 每个子 agent 只加载自己需要的 skill 和 tools |
| 子 agent 执行时主 agent 只能干等，回合被阻塞 | 派发即返回，等待期可并行派发、继续其他工作 |

---

## 核心设计

| 角色 | 职责 | 运行位置 |
|------|------|----------|
| 主 agent | 理解需求、拆分任务、派发与汇总 | 你的 `pi` 主会话 |
| 子 agent | 读代码、改代码、跑验证并返回结果 | 独立的 `pi --mode json` 进程 |

四个层面的隔离：

- **进程隔离**：每个子 agent 启动新的 `pi --mode json` 进程，system prompt 写入临时文件并通过 `--append-system-prompt` 注入，互不污染。
- **上下文隔离**：子 agent 看不到主 agent 的执行痕迹，只拿到你委派的那一句话。
- **能力隔离**：通过 `tools` 和 `skills` 字段，给不同子 agent 配备不同的工具箱。
- **递归边界**：子 agent 不可再委派（深度限制为 1），任务范围始终可控。

---

## 异步工作流

这是本项目与同步版最大的不同，也是核心使用方式（TUI 模式）。

### 1. 派发（`subagent` 工具）

主 agent 调用 `subagent` 工具，为子 agent 启动独立的 `pi` 进程。**非 TUI 模式（print/json）会自动降级为同步**——等待子 agent 完成后直接返回结果，无通知。

### 2. 回执（立即返回）

TUI 模式下 `subagent` **立即返回派发回执**，不阻塞：

```
已派出 coder. taskId: 01912345-6789-7abc-8def-0123456789ab
```

`taskId` 就是 session ID，之后可复用来继续同一任务。**回执不是结果**——不要臆造结果。

### 3. 后台执行 + 进度 widget

子 agent 在后台独立进程运行。TUI 编辑器上方会显示进度 widget，实时列出所有在飞任务（taskId、agent、当前阶段、耗时），例如：

```
● 01912345-abcd... coder    ⚡ read...         01:23
```

### 4. 结果通知（`[subagent-result]`）

子 agent 完成后，结果以 **`[subagent-result]` 系统通知**推送到对话。这是系统消息，不是用户请求：

- 主 agent **空闲**时，通知直接触发新的对话回合，立即处理。
- 主 agent **忙碌**时，通知进入队列，当前回合结束后再触发。

结果自动到达，**无需轮询**。如需确认还有哪些任务在途（例如 `/tree` 回退后回执丢失），用 `subagent_status` 工具查询。

### 5. 查看全文（`/subagent-result`）

通知卡片只显示摘要。用户用 `/subagent-result <taskId>` 在全屏查看器中阅读完整返回：`↑↓`/`jk` 滚动、`Space`/`b` 翻页、`g`/`G` 首尾、`Enter`/`Esc`/`q` 关闭。

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

### 信封（LLM 契约）

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

信封的完整格式、状态语义与取消来源区分见 [ADVANCED.md](ADVANCED.md)。

### 通知卡片（用户侧渲染）

用户在 TUI 中看到的是**带底色的摘要卡片**，不是完整结果全文：

- **成功**：绿色底色（✓）
- **失败**：红色底色（✗）
- **超时 / 已取消**：黄色底色

卡片只显示 agent、状态、taskId 和用量摘要，并提示 `查看全文: /subagent-result <taskId>`。完整结果全文保存在任务会话文件中，用 `/subagent-result` 查看。

---

## 设计纪律

异步模式引入的几条纪律，内嵌在工具提示词和实现中，主 agent 会自动遵守：

- **取消来源区分**：`已取消` 有三种来源——用户（`/subagent-cancel`）、主 agent（`subagent_cancel` 工具）、会话关闭（`session_shutdown`）。用户主动取消**不得自动重试**，须先询问用户。
- **防轮询**：结果自动以通知到达。`subagent_status` 只用于确认在途（如 `/tree` 回退后），不带耗时，也不鼓励频繁调用。
- **防滥用取消**：`subagent_cancel` 内嵌提示词——仅当任务明显错误或不再需要时取消，勿因耗时久而取消（后台任务本就预期长时间运行）。
- **资源冲突纪律**：并行派发多个任务前，考虑它们是否会改同一批文件或代码区域；冲突时串行派发或先问用户。
- **递归委派完全禁止**：子 agent（深度 ≥ 1）不可再派发 `subagent`，委派深度限制为 1。
- **TUI 异步 / 非 TUI 同步降级**：只在 TUI 模式走异步路径；print/json 等非 TUI 模式降级为同步阻塞，保证脚本化场景行为可预期。

---

## 前置条件：安装 Pi Agent

async-subagent-isolation 是一个 Pi Package，需要先安装 Pi Agent。

本扩展需要 Node.js >= 20（与 `package.json` 中的 `engines.node` 一致）。

### 方式一：一键安装（推荐 Linux / macOS）

```bash
curl -fsSL https://pi.dev/install.sh | sh
```

### 方式二：通过 npm 全局安装

```bash
npm install -g --ignore-scripts @earendil-works/pi-coding-agent
```

安装完成后，你就可以在终端使用 `pi` 命令了。

---

## 30 秒快速开始

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

各 agent 的具体定义见 `examples/pi/agent/agents/` 目录，可按需修改。

### 3. 用自然语言指派任务

```bash
pi --tools read,grep,find,ls,subagent \
   --no-skills \
   --append-system-prompt ~/.pi/agent/master.md \
   --skill ~/.pi/agent/skills/brainstorming/
```

这条命令把主 agent 限制为只读工具 + subagent 委派，加载主 agent 提示词和 brainstorming skill。

为了方便日常使用，建议在 shell 配置里给它设一个 alias。比如在 `~/.zshrc` 中加入：

```bash
alias pp='pi --tools read,grep,find,ls,subagent --no-skills --append-system-prompt ~/.pi/agent/master.md --skill ~/.pi/agent/skills/brainstorming/'
```

之后直接输入 `pp` 即可启动主 agent。

启动后，直接对主 agent 说：

> 把认证中间件重构为 async/await。

主 agent 会自动通过 `subagent` tool 调用 `coder`。你不需要手写 JSON，也不需要关心 `sessionId`——扩展会处理隔离进程的启动和回收。

TUI 模式下，`subagent` 返回派发回执（`已派出 coder. taskId: <id>`），结果稍后以 `[subagent-result]` 通知到达——主 agent 收到后自动处理，无需你干预。如需复用会话，使用回执中的 `taskId`（即 session ID）。

---

## 示例 agents

GitHub 仓库的 [`examples/pi/agent/agents/`](https://github.com/Wolido/subagent-isolation/tree/main/examples/pi/agent/agents) 提供了三个可直接参考的 agent：

| Agent | 作用 | 可用工具 | 加载的 skill |
|-------|------|----------|-------------|
| [`coder`](https://github.com/Wolido/subagent-isolation/blob/main/examples/pi/agent/agents/coder.md) | 写代码、改代码、跑验证 | `read, write, edit, bash, grep, find, ls` | `systematic-debugging` |
| [`reviewer`](https://github.com/Wolido/subagent-isolation/blob/main/examples/pi/agent/agents/reviewer.md) | 只读评审，输出可操作的反馈 | `read, grep, find, ls` | _(无)_ |
| [`writer`](https://github.com/Wolido/subagent-isolation/blob/main/examples/pi/agent/agents/writer.md) | 写文档、改 README、生成 commit message | `read, write, edit, grep, find, ls` | `writing-clearly-and-concisely` |

把它们复制到 `~/.pi/agent/agents/`（用户级）或项目内的 `.pi/agents/`（项目级）即可使用。

如果你已经克隆了仓库，可以直接复制：

```bash
cp examples/pi/agent/agents/*.md ~/.pi/agent/agents/
```

也可以单独从 GitHub 下载（以 `coder` 为例）：

```bash
curl -fsSL https://raw.githubusercontent.com/Wolido/subagent-isolation/main/examples/pi/agent/agents/coder.md \
  -o ~/.pi/agent/agents/coder.md
```

> 这些只是示例，你可以根据自己的需求修改或新建 agent。

Agent 搜索规则：

- `user` 作用域：`~/.pi/agent/agents/`
- `project` 作用域：`.pi/agents/`（从工作目录向上搜索）
- 默认合并两个作用域，project 同名时覆盖 user

---

## 主 agent 推荐配置

主 agent 应该是一个纯粹的规划者：只读代码、做判断、委派任务。所有写文件、跑命令、改代码的具体操作都交给子 agent，每个子 agent 在独立的 pi 进程中运行。这样主 agent 的上下文只会保留"要做什么"和"结果是什么"，不会被工具调用细节污染。

主 agent 的系统提示示例见 `examples/pi/agent/master.md`，复制到 `~/.pi/agent/master.md` 即可：

```bash
cp examples/pi/agent/master.md ~/.pi/agent/master.md
```

然后使用以下命令启动主 agent：

```bash
pi --tools read,grep,find,ls,subagent \
   --no-skills \
   --append-system-prompt ~/.pi/agent/master.md \
   --skill ~/.pi/agent/skills/brainstorming/
```

各参数含义：

- `--tools read,grep,find,ls,subagent`：只允许读、搜、列目录和委派子 agent。没有 `write`、`edit`、`bash`，主 agent 不能自己改代码或跑命令。
- `--no-skills`：不加载默认 skills，保持主 agent 上下文干净。
- `--append-system-prompt ~/.pi/agent/master.md`：把主 agent 的系统提示追加到默认提示后。
- `--skill ~/.pi/agent/skills/brainstorming/`：加载 brainstorming skill，主 agent 用它做任务规划。

子 agent（`coder`、`writer`）通过 frontmatter 中的 `skills:` 字段自动加载各自的 skill，无需在启动命令中指定。

如果只想在当前项目生效，把 agent 放到 `.pi/agents/` 目录即可；扩展会在调用 `subagent` 时自动加载这些项目级 agent。

---

## 为子 agent 指定模型

不同子 agent 适合不同模型。如果你的主 agent 默认使用 Kimi K3（$3/$15 per M token），给 `coder`、`writer`、`reviewer` 全部用 Kimi K3 成本会很高。`coder` 需要强推理能力，适合 DeepSeek V4 Pro（$0.44/$0.87，性价比高）；`writer` 和 `reviewer` 任务较轻，用最便宜的 DeepSeek V4 Flash（$0.14/$0.28）就够了。把昂贵模型留给主 agent 做规划，能显著降低成本。

除了模型，你还可以为子 agent 指定 **thinking level**（思考深度）。模型决定"谁来想"，thinking level 决定"想多深"——两者相互独立。`coder` 需要深入推理，适合 `high`；`reviewer` 只做简单检查，`off` 或 `low` 即可，能省推理时间。你也可以在便宜模型上提高 thinking level，以低成本获得不错的思考深度。

> **注意**：如果子 agent 使用的模型不支持 reasoning（如部分轻量模型），Pi 会自动将 thinking level 钳制为 `off`，配置不生效。

### 配置文件

通过 `subagent-isolation.json` 为每个子 agent 单独指定模型和 thinking level（该配置文件名沿用同步版原项目，两者可共享配置）：

- **用户级**：`~/.pi/agent/subagent-isolation.json`
- **项目级**：`.pi/subagent-isolation.json`（从工作目录向上搜索）

格式为 JSON key-value map，key 是 agent 名。value 支持两种写法：

- **纯字符串**（旧格式，仍然有效）：直接写模型名称，不设置 thinking level。
- **对象**：`{ "model": "模型名", "thinking": "思考等级" }`，可同时指定两者。

```json
{
  "coder": { "model": "deepseek/deepseek-v4-pro", "thinking": "high" },
  "writer": "deepseek/deepseek-v4-flash",
  "reviewer": { "model": "deepseek/deepseek-v4-flash", "thinking": "off" }
}
```

`thinking` 可选值及含义：

| 值 | 含义 |
|---|---|
| `off` | 无思考，直接回答（最快最省） |
| `minimal` | 轻量思考 |
| `low` | 浅层思考 |
| `medium` | 平衡模式 |
| `high` | 深度思考 |
| `xhigh` | 更深层思考 |
| `max` | 最大思考深度 |

选择建议：复杂推理（写代码、架构设计）用 `high` 或以上；简单任务（格式检查、文案润色）用 `off` 或 `low`；不确定时用 `medium`。

这样配置后，主 agent 仍使用默认的 Kimi K3 做规划和决策，`coder` 使用 DeepSeek V4 Pro 处理代码修改，`writer` 和 `reviewer` 使用最便宜的 DeepSeek V4 Flash。整体成本大幅降低——大部分工作由低价模型完成，只有规划和复杂推理才用到高价模型。

### 优先级规则

model 和 thinking 的优先级相同（从高到低）：

1. `subagent-isolation.json` 中的配置
2. Agent frontmatter 中的 `model` / `thinking` 字段
3. 继承父 agent 的配置

两个维度独立生效。比如只在 frontmatter 中指定 `model`，在配置文件中单独覆盖 `thinking`——各自走完整的优先级链。

### 合并规则

项目级配置覆盖用户级同名 key。例如用户级为 `coder` 指定 `deepseek/deepseek-v4-pro`，项目级为 `coder` 指定 `kimi-coding/k3`，则项目中使用 Kimi K3。

> **注意**：纯字符串旧格式仍然有效，无需修改现有配置。不指定 `thinking` 时，子 agent 按优先级规则继承 thinking level。

---

## 示例 skills

GitHub 仓库的 [`examples/pi/agent/skills/`](https://github.com/Wolido/subagent-isolation/tree/main/examples/pi/agent/skills) 提供了三个可直接使用的 skill：

| Skill | 使用者 | 描述 |
|-------|--------|------|
| [`brainstorming`](https://github.com/Wolido/subagent-isolation/tree/main/examples/pi/agent/skills/brainstorming) | 主 agent | 通过协作对话把想法变成完整设计 |
| [`systematic-debugging`](https://github.com/Wolido/subagent-isolation/tree/main/examples/pi/agent/skills/systematic-debugging) | `coder` | 修 bug 前先找根因（四阶段流程） |
| [`writing-clearly-and-concisely`](https://github.com/Wolido/subagent-isolation/tree/main/examples/pi/agent/skills/writing-clearly-and-concisely) | `writer` | 用简洁规则、AI 痕迹检测和人味注入打磨文字 |

把这些 skill 复制到 `~/.pi/agent/skills/`：

```bash
mkdir -p ~/.pi/agent/skills
cp -r examples/pi/agent/skills/brainstorming ~/.pi/agent/skills/
cp -r examples/pi/agent/skills/systematic-debugging ~/.pi/agent/skills/
cp -r examples/pi/agent/skills/writing-clearly-and-concisely ~/.pi/agent/skills/
```

Skill 的加载方式有两种：

- **子 agent**：在 frontmatter 中用 `skills:` 字段声明（如 coder 的 `skills: systematic-debugging`），pi 启动子 agent 时自动加载。
- **主 agent**：在命令行用 `--skill` 标志加载（如 `--skill ~/.pi/agent/skills/brainstorming/`）。

Skill 搜索规则与 agent 相同：`~/.pi/agent/skills/`（用户级）和 `.pi/skills/`（项目级），子 agent 会根据 `skills:` 字段中的名称在这两个目录中查找匹配的 skill。

---

## 进阶用法

如果需要手写 `subagent` 调用、复用 `sessionId`、了解异步信封格式与在途任务块、使用 `subagent_status` 查询在途任务、`/subagent-cancel` 或 `/subagent-cancel-all` 取消任务或调整环境变量，请参阅 [ADVANCED.md](ADVANCED.md)。

---

## 项目结构

- `src/index.ts` — 扩展主源码
- `examples/pi/agent/` — 示例 agent 和 skill 定义
  - `master.md` — 主 agent 系统提示
  - `agents/` — 子 agent 定义
  - `skills/` — skill 定义
- `package.json` — npm 包清单
- `tsconfig.json` — TypeScript 配置
- `README.md` / `README.en.md` — 说明文档
- `ADVANCED.md` / `ADVANCED.en.md` — 进阶参考
- `LICENSE` — MIT 许可证

---

## License

MIT
