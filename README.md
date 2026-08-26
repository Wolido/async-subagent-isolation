<div align="right"><a href="README.en.md">English</a></div>

<div align="center"><img src="logo.svg" alt="async-subagent-isolation logo" width="150"></div>

# async-subagent-isolation

<div align="center">

[![TypeScript](https://img.shields.io/badge/TypeScript-3178C6?logo=typescript&logoColor=white)]()
[![Pi Package](https://img.shields.io/badge/Pi_Package-8B5CF6)]()
[![npm version](https://img.shields.io/npm/v/@wolido/async-subagent-isolation)](https://www.npmjs.com/package/@wolido/async-subagent-isolation)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

</div>

你的 AI agent 在长会话后开始“失忆”、输出质量下降，甚至擅自修改文件？这是上下文爆炸（context explosion）、上下文腐烂（context rot）与上下文污染（context pollution）的典型症状。**async-subagent-isolation** 是 [Pi Agent](https://github.com/earendil-works/pi) 的扩展，也是 [subagent-isolation](https://github.com/Wolido/subagent-isolation)（同步版）的**异步演进**，用子 agent 进程隔离解决这些问题。

核心约束不变：**主 agent 不能碰代码**。没有 `write`、没有 `edit`、没有 `bash`，只有 `read`、`grep`、`find`、`ls` 四个只读工具，外加一个 `subagent` 委派工具；修改文件、跑命令、执行逻辑的工作全部交给子 agent。两个核心卖点由此成立。一是 **skill 级的提示词隔离**：每个子 agent 跑在独立的 `pi` 进程里，有自己的 agent 定义文件（如 `coder.md`）和 skill 白名单，不继承主 agent 的提示词与 skills，主 agent 的 skill 一个都进不来。二是**分工模型**：主 agent 只做拆分、调度与验收，coder 写代码、writer 写文档、reviewer 评审，每个子 agent 只拿自己领域的那段上下文。关键区别在**异步**：TUI 模式下派发后**立即返回回执**（`Dispatched <agent>. taskId: <taskId>`），子 agent 在后台运行，完成后结果以 **[subagent-result] 系统通知**推回对话；主 agent 不被阻塞，可以并行派发多个任务、继续做其他工作。

---

## 你的 agent 是否出现了这些症状

下面五种症状都可以追溯到结构性根因，也都有结构性的解法：

| 症状 | 根因 | 本项目的解法 |
|------|------|--------------|
| 长会话后输出质量下降，忘记早期约定 | 上下文腐烂（又称上下文退化、上下文腐蚀）：上下文随会话不断膨胀，早期信息被淹没 | 上下文切割：主 agent 只保留“要做什么”和“结果是什么”，执行痕迹留在子 agent 的进程里 |
| 上下文里充斥无关的工具输出 | 上下文污染：子任务冗长的执行输出回流主 agent | 上下文隔离：子 agent 只拿到委派的那句话，看不到主 agent 的执行痕迹，只把结果送回 |
| agent 擅自修改文件、执行未授权命令 | 主 agent 权限过大，write/edit/bash 全在手上 | 最小权限：主 agent 被剥夺 write/edit/bash，只剩四个只读工具加委派 |
| 多个子任务互相干扰 | 缺乏进程隔离，子 agent 复用主 agent 的提示词和 skills | 进程隔离：每个子 agent 跑在独立的 pi 进程，提示词、skills、执行能力各自独立 |
| 等待子任务时主 agent 被阻塞，无法并行 | 同步委派语义：每次调用都阻塞到子 agent 完成 | 异步子 agent 委派：派发即返回回执，子 agent 后台运行，结果以系统通知推回 |

---

## 为什么现有方案不够

应对上下文腐烂通常走三条路：压缩、检索、加长窗口。它们都能缓解一时，但都没有改变腐烂发生的机制。

- **`/compact` 类上下文压缩是事后补救。** 等上下文烂了再压缩，压缩本身就在丢信息：早期约定、决策理由，往往正是后来要用的东西。压缩完上下文继续膨胀，下一次压缩接着丢。腐烂的节奏没变，只是从上一个压缩点重新计时。
- **RAG / 检索式记忆把问题换成了调参。** 历史存进向量库、按需取回，思路本身没错，但“取什么、取多少、什么时候取”成了新的调参负担。取回错误的片段比不取更糟：看似相关实则无关的上下文，比干净的上下文更容易带偏主 agent 的判断。
- **更长的上下文窗口只是把墙推远。** 窗口翻倍，塞满只是时间问题；每轮对话都带着全部历史发给模型，成本随长度先涨。窗口也治不了腐烂：Chroma 的 Context Rot 研究量化了这一点，输入变长后，模型性能在窗口塞满之前就开始退化。

三条路背后是同一个默认前提：一个 agent 扛下所有上下文。前提不动，解法就只能是给这个 agent 更多：更长的窗口、更大的记忆、更多的工具。async-subagent-isolation 换掉的是前提本身：把上下文切开，每个子 agent 管自己的一段，主 agent 只保留“要做什么”和“结果是什么”。

---

## 适用人群

本项目适合以下使用者：

- 长会话重度使用的独立开发者，想防止上下文腐烂和上下文膨胀，让主 agent 长期保持清醒
- 并行跑多类任务的重度用户，需要子 agent 上下文隔离，避免子任务输出造成上下文污染
- 对权限纪律有要求的团队技术负责人（tech lead），希望主 agent 保持最小权限（无 write/edit/bash），改不了文件也跑不了命令
- 构建多 agent 系统的架构师，需要 agent 进程隔离来搭建可靠工作流
- 追求并行吞吐的开发者，想要异步子 agent 委派，不想被同步阻塞卡住

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

启动后直接说需求，例如“把认证中间件重构为 async/await”，主 agent 会自动派 `coder` 子 agent。子 agent（coder、writer）通过 frontmatter 的 `skills:` 字段自动加载各自 skill，无需命令行指定；项目级 agent 放 `.pi/agents/` 即可。

---

## 和常规子 agent 的区别：为什么上下文隔离比提示词隔离更彻底

很多子 agent 实现只是“在主 agent 内部开一个工具调用”：子 agent 仍复用主 agent 的提示词和 skills，主 agent 也仍保留写文件、跑命令的能力——隔离是可选的、不彻底的。

async-subagent-isolation 做的是强制且完全的隔离：

- **进程完全隔离**：每个子 agent 启动独立的 `pi` 进程。
- **提示词完全隔离**：子 agent 有自己的 agent 定义文件（如 `coder.md`），不继承主 agent 的 `master.md`。
- **Skills 完全隔离**：主 agent 和每个子 agent 各自加载自己的 skill，互不干扰。
- **执行能力完全隔离（最小权限）**：主 agent 被剥夺 `write`/`edit`/`bash`，只能委派，无法自己执行。
- **独立可配置**：每个 agent 单独定义自己的 `tools` 和 `skills`，精确控制它能做什么、不能做什么。

此外，子 agent 只拿到委派的那一句话、看不到主 agent 的执行痕迹（上下文隔离），且不可再委派（递归深度限制为 1）。

与彻底隔离配套的，是两条互为支撑的设计决策。

**默认异步。** 派发即投递任务：调用即返回回执，任务在独立进程后台运行，结果由 `[subagent-result]` 系统通知推回。异步是默认语义，没有可选开关；主 agent 不被阻塞，可并行派发、继续规划，用户面对的始终只有调度者一个。

**排他性 skill 隔离。** 子 agent 的 skill 按白名单加载：全局一律关闭，只有逐条指定的 skill 能进入它的上下文。隔离发生在进程层，不靠提示词约束：每个子 agent 是独立 `pi` 进程，主 agent 的 skill 一个都进不来。隔离因此成为构造事实：子 agent 只有被允许的知识，专注域精确可控。

**意义：上下文切割。** 主 agent 只保留“要做什么”与“结果是什么”，子 agent 冗长的执行痕迹留在自己的进程与 session 里，不回流主 agent。上下文被切成小块、各管一段，主 agent 得以长期保持清醒，规划与验收不被细节淹没。异步与隔离都是默认值，可靠的分工由结构保证，不依赖纪律。

常规子 agent 是“分工”；async-subagent-isolation 是“彻底分家”。

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

同步版里，每次委派都阻塞等待，体验上你面对的是一个“智能体集群”：主 agent 派完活就沉默，等子 agent 干完才回来，中间是一段段接力执行的空白。异步版把这一点翻了过来，**你的对话对象始终只有主 agent 一个**。

主 agent 是调度者：理解需求、拆任务、派发、汇总结果。子 agent 是幕后工人，每个都在后台独立进程里跑，完成后用 `[subagent-result]` 通知把结果送回主 agent。你不直接和子 agent 对话，也不需要；查看结果用 `/subagent-result`，取消任务用 `/subagent-cancel`，中间过程交给调度者。

更关键的是**派发之后的自由**。任务在后台跑的时候，你可以继续和主 agent 聊天：细化需求、调整规划、商量下一步，或提出新任务。主 agent 不必干等，可以继续规划，甚至并行派发更多任务。前台对话与后台工作并行推进。

最后是**结果回来再验收**。子 agent 完成，通知到达，主 agent 处理并向你汇报。等待期间你可以随时查看进度 widget，但不必盯着。

一句话：同步版让你陷在“集群执行”的阻塞感里；异步版让你只面对调度者，后台工作与你自己的节奏并行。

---

## 异步工作流

这是与同步版最大的不同，也是核心使用方式（TUI 模式）。

### 1. 派发（`subagent` 工具）

主 agent 调用 `subagent`，为子 agent 启动独立的 `pi` 进程。非 TUI 模式（print/json）自动降级为同步——等待完成后直接返回结果，无通知。

### 2. 回执（立即返回）

TUI 模式下 `subagent` **立即返回派发回执**，不阻塞：

```
Dispatched coder. taskId: 01912345-6789-7abc-8def-0123456789ab
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
- 主 agent **忙碌**时，通知进入队列，在当前回合的工具调用执行完后、下一次 LLM 调用前送达（steer 投递），不等整个回合结束。
- 无论哪种送达方式，信封标题行下都带一条固定的**触发行**：提醒主 agent 这是任务完成通知而非用户新指令，消化前先锚定当前主线任务与进度（信封格式详见“通知信封与卡片”一节）。

结果自动到达，**无需轮询**。在途任务信息由 `[subagent-result]` 通知信封的“在途任务”块直接提供；`action="status"` 已在 v1.2.0 清理移除。

### 5. 查看全文（`/subagent-result`）

通知卡片只显示摘要。用 `/subagent-result <taskId>` 在全屏查看器中阅读完整返回：`↑↓`/`jk` 滚动、`Space`/`b` 翻页、`g`/`G` 首尾、`Enter`/`Esc`/`q` 关闭。不带参数时（TUI 模式）弹出选择列表，列出最近 5 个已结束的任务，`Enter` 打开所选任务。

### 完整流程一览

```
主 agent 派发 subagent
      │ 立即返回回执（Dispatched <agent>. taskId: <id>）
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
| `subagent` | 单入口工具（`action` 参数）；`action="dispatch"`（默认）异步派发任务（TUI 模式），非 TUI 自动降级同步 | 回执≠结果；结果以通知到达，勿轮询 |
| `subagent` `action="cancel"` | 主 agent 取消单个在途任务（两步确认：首次调用返回质询，`confirm:true` + 非空 `reason` 才执行） | 仅当任务明显错误或不再需要，勿因耗时久而取消 |

> **v1.2.0 提示**：`subagent` 工具的 `action="status"` 已作为 cleanup 移除。在途任务信息改由 `[subagent-result]` 通知信封的“在途任务”块提供，不再提供主动查询入口。

### 命令（用户使用）

| 命令 | 作用 |
|------|------|
| `/subagent-cancel <taskId>` | 取消单个运行中的后台任务（不带参数时弹出运行中任务的交互选择列表，Enter 取消所选） |
| `/subagent-cancel-all` | 一键取消全部运行中的后台任务 |
| `/subagent-result <taskId>` | 全屏查看某任务的完整返回（不带参数时弹出最近 5 个已结束任务的交互选择列表） |
| `/subagent-config [agent]` | 唯一的交互式配置入口：agent 选择菜单直接标注每个 agent 的生效 model/thinking，可编辑 description/tools/skills/body/model & thinking 五字段（name 只读）并管理可用 model 列表（带参数直进指定 agent） |

---

## 示例 agents

仓库 [`examples/pi/agent/agents/`](https://github.com/Wolido/async-subagent-isolation/tree/main/examples/pi/agent/agents) 提供三个可直接参考的 agent：

| Agent | 作用 | 可用工具 | 加载的 skill |
|-------|------|----------|-------------|
| [`coder`](https://github.com/Wolido/async-subagent-isolation/blob/main/examples/pi/agent/agents/coder.md) | 写代码、改代码、跑验证 | `read, write, edit, bash, grep, find, ls` | `systematic-debugging` |
| [`reviewer`](https://github.com/Wolido/async-subagent-isolation/blob/main/examples/pi/agent/agents/reviewer.md) | 只读评审，输出可操作的反馈 | `read, grep, find, ls` | _(无)_ |
| [`writer`](https://github.com/Wolido/async-subagent-isolation/blob/main/examples/pi/agent/agents/writer.md) | 写文档、改 README、生成 commit message | `read, write, edit, grep, find, ls` | `writing-clearly-and-concisely` |

复制到 `~/.pi/agent/agents/`（用户级）或 `.pi/agents/`（项目级，同名时 project 覆盖 user）即可使用，可按需修改或新建。修改或新建 agent 文件后运行 `/reload`，刷新注入主 agent 提示词的子 agent 清单（见“配置管理”一节）。

---

## 为子 agent 指定模型

模型有三个配置来源：agent 文件 frontmatter 的 `model:` / `thinking:` 字段、`subagent-isolation.json`（用户级/项目级），以及进程内存级临时覆盖（仅当前 pi 窗口进程生效）。前两者都支持，更推荐 json：所有 agent 的模型配置集中在一个文件里，不用逐个翻 agent 文件；`/subagent-config` 可交互编辑并写回；json 覆盖优先于 frontmatter，json 中配置的字段会遮蔽 frontmatter 同名值，frontmatter 里的配置被遮蔽时不生效、也不易察觉。进程内存层优先级最高，适合多窗口共享同一配置文件时只在本窗口临时调整（见下）。

可用 `subagent-isolation.json` 为每个子 agent 单独指定模型与 thinking level（配置文件名沿用同步版，两者可共享）：

```json
{
  "$models": ["deepseek/deepseek-v4-pro", "deepseek/deepseek-v4-flash"],
  "coder": { "model": "deepseek/deepseek-v4-pro", "thinking": "high" },
  "writer": "deepseek/deepseek-v4-flash"
}
```

文件放在 `~/.pi/agent/subagent-isolation.json`（用户级）或 `.pi/subagent-isolation.json`（项目级，覆盖用户级同名 key）。三种覆盖格式的完整示例见 `examples/pi/agent/subagent-isolation.json`。

**进程内存级临时覆盖。** 多个 pi 窗口共享同一份 `subagent-isolation.json` 时，某窗口工作过程中可以用 `/subagent-config` 把某个 subagent 的 model/thinking 临时写入 `this process`：覆盖只存在当前进程的内存里，不落盘、不写文件，进程退出或 `/reload` 后消失，其它窗口不受影响。优先级链为进程内存层 > 项目级 json > 用户级 json > frontmatter，整 key 遮蔽语义与文件层级一致——内存层 entry 存在时整体遮蔽低层同 key entry。进程覆盖生效时，`/subagent-config` 的菜单标注会在总览行尾附 `[saved: ...]` 片段显示配置文件里的原值（见下节）。`$models` 列表不受影响，仍是文件级（写入目标只有 user/project）。

顶层 `$models` 数组是可选的可用 model 列表（`$` 前缀避免与 agent 名冲突）：配置 model 覆盖时从列表中选择，列表为空或未配置时回退自由输入。项目级 `$models` 是合法数组时整体遮蔽用户级列表，写 `"$models": []` 可显式清空。无需手写 JSON：`/subagent-config` 提供列表管理入口（见下节）。

thinking 等级、优先级与合并规则详见 [ADVANCED.md](ADVANCED.md)。

---

## 配置管理：`/subagent-config`

TUI 模式下用 `/subagent-config` 统一管理子 agent 配置，全程交互，不用手动编辑文件：

1. 选择 agent：列表逐项带来源标记 `(user)` / `(project)`，并直接标注生效 model/thinking（格式 `<name> (<source>) — <model> (<thinking>)`，未配置显示 `not set`；该 agent 存在进程级覆盖时行尾追加 `(process)` 标识并附 `[saved: <model> (<source>) / <thinking> (<source>)]` 片段（显示配置文件中的低层原值，槽位无值显示 `not set`）；生效值按整 key 合并语义计算——进程内存 entry 遮蔽项目级/用户级同 key entry，项目级 entry 遮蔽用户级同 key entry，entry 内未配字段回退 frontmatter，与派发实际使用一致）；末尾固定一项 `Manage available model list ($models)`，进入可用 model 列表管理（查看当前列表及来源、添加、删除，写入目标可选用户级/项目级）。一个 agent 都没有时列表只剩该入口，`$models` 照常可管理。
2. 选择字段编辑：选中 agent 后直接进入字段选择，字段选项自带当前值标注（无详情通知，信息获取靠菜单标注）。可编辑 `description`、`tools`、`skills`、`body`、`model & thinking` 五个字段（model 与 thinking 合并为一个编辑项，一次写入两字段）；`name` 是只读身份标识，不在其中。

各字段的编辑方式：

| 字段 | 编辑方式 |
|------|----------|
| `description` | 单行输入，输入框预填当前值；改后需 `/reload` 才刷新注入清单 |
| `tools` / `skills` | 逗号分隔输入；输入空串即从 frontmatter 移除该 key |
| `body` | 在外部编辑器中编辑（`$EDITOR`，未设置回退 `$VISUAL`，再回退 vi）；取消、未改动、改完全空白都不写盘 |
| `model & thinking` | 合并为一个编辑项：进入子流程先选动作——`edit model & thinking`（标注当前生效值与各自来源）/ `clear model & thinking (reset to frontmatter)`；edit 分支依次为 model 值步（`$models` 列表非空时从列表选择、为空时自由输入并预填生效值）→ thinking 值步（官方 7 级 + `not set` 选项，当前生效标 (current)）→ 写入目标（`this process` / `user` / `project`）→ 一次写入两字段；clear 分支选写入目标后整条覆盖清除，反馈 model 与 thinking 各自回退值 |

`name` 是只读身份标识，不可编辑。

生效时机（reload 语义）：改 `description` 后需 `/reload` 才刷新注入清单（注入主 agent 系统提示词的子 agent 清单在启动时构建并缓存，见“安全与权限纪律”一节）；改 `tools` / `skills` / `body` / `model & thinking` 即时生效，每次派发都会重新发现 agent 并重读配置。

菜单标注实时刷新：写回成功后，字段选择与 agent 选择列表的标注（model/thinking 总览、来源、排序，含 `[saved: ...]` 片段）在同一命令会话内立即反映新值，无需退出重进命令。

`/subagent-config <name>` 带参数可跳过 agent 选择、直进该 agent 的配置；名字不存在会报错。非 TUI 模式下命令只提示用法，不弹对话框。

配置流程全程支持 ESC 逐级回退：编辑 → 字段选择 → agent 选择 → 退出，仅最顶层退出；model & thinking 子流程内值步或写入目标 ESC 回动作选择层，动作选择 ESC 回父流程的字段选择。任何回退路径零写入。

`/subagent-config` 是唯一的交互配置入口，model/thinking 覆盖与其余字段在同一流程内编辑，没有独立的快捷命令。

---

## 示例 skills

`examples/pi/agent/skills/` 提供三个 skill：`brainstorming`（主 agent 规划）、`systematic-debugging`（coder）、`writing-clearly-and-concisely`（writer）。复制到 `~/.pi/agent/skills/`（用户级）或 `.pi/skills/`（项目级）即可；子 agent 在 frontmatter 用 `skills:` 声明自动加载，主 agent 用 `--skill` 标志加载。

---

## 通知信封与卡片

`[subagent-result]` 通知是**自包含**的，一次带全主 agent 处理结果所需的全部信息：

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
<subagent's full result text>
```

- **触发行**：标题行下的固定引用行，所有信封逐字相同；提醒主 agent 这是任务完成通知，不是用户新指令，消化前先锚定当前主线任务与进度。
- **状态**：`succeeded` / `failed` / `timed out` / `cancelled`。
- **耗时**：子 agent 的真实运行时长（格式 `MM:SS`，≥1 小时为 `H:MM:SS`），四种状态都有；取消或内部错误（无结果返回）时从派发时刻起算。
- **在途任务块**：本任务结束时其余仍在运行的后台任务快照，送达时可能滞后；与本回合派发记录冲突时以派发记录为准。剩余不为 0 时，主 agent 不应向你汇报“全部完成”。
- **完整结果**：正文全量进入 LLM 上下文，不截断。

用户在 TUI 中看到的是**带底色的摘要卡片**（非全文）：succeeded 绿色（✓）、failed 红色（✗）、timed out / cancelled 黄色。卡片显示 agent、状态、taskId、耗时和用量摘要，并提示 `View full result: /subagent-result <taskId>`；完整结果保存在任务会话文件中。

触发行的设计意图、状态语义与取消来源区分等完整细节见 [ADVANCED.md](ADVANCED.md)。

---

## 安全与权限纪律：主 agent 不能碰代码

异步模式引入的几条纪律，内嵌在工具提示词和实现中，主 agent 自动遵守：

- **取消来源区分**：`cancelled` 有用户（`/subagent-cancel`）、主 agent（`subagent` 工具 `action="cancel"`）、会话关闭（`session_shutdown`）三种来源；用户取消**不得自动重试**，须先询问。
- **防轮询**：结果以通知自动到达；在途任务信息由 `[subagent-result]` 通知信封直接提供，不要主动查询。
- **通知消化流程**：`[subagent-result]` 是任务完成通知而非用户新指令；处理前先锚定当前主线任务与进度，对照派发记录消化，基于结果自主决定下一步；与主线冲突时暂缓优先，勿让通知改写主线计划。此纪律由信封触发行与工具描述中的“通知消化流程”条目共同内嵌。
- **防滥用取消**：`action="cancel"` 为两步确认（首次调用只返回含已运行时长/最近进度的质询回执，零副作用；`confirm:true` + 非空 `reason` 才执行，理由记入任务记录并随取消信封正文返回），且内嵌提示词——仅当任务明显错误或不再需要时取消，勿因耗时长而取消（后台任务本就预期长时间运行）。等待 = 不发起任何工具调用、直接结束回合；对在途任务不存在查询/催办/状态确认类动作（刻意设计）。
- **资源冲突纪律**：并行派发多个任务前，考虑它们是否会改同一批文件或代码区域；冲突时串行派发或先问用户。
- **子 agent 不可调用 subagent 工具**：子 agent（深度 ≥ 1）不可调用任何 `subagent` action（含 `action="cancel"`），深度限制为 1。
- **子 agent 清单注入**：启动时扩展把所有已发现子 agent（用户级 + 项目级）的 `name — description` 清单（含 user/project 来源标记）自动追加进主 agent 系统提示词，主 agent 每轮都能看到全部子 agent 的职责，`master.md` 无需再手写 agent 用法表。清单在启动（或 `/reload`）时构建并缓存：改了 agent 文件的 `name` / `description`，要 `/reload` 才会刷新。子 agent 进程内不注入（子 agent 没有 `subagent` 工具面，注入纯属污染）。
- **TUI 异步 / 非 TUI 同步降级**：只在 TUI 模式走异步路径；print/json 等非 TUI 模式降级为同步阻塞。

---

## 进阶用法

手写 `subagent` 调用、复用 `sessionId`、信封与在途任务块细节、`action="cancel"` 取消任务、清单注入缓存、配置写回保证、环境变量等见 [ADVANCED.md](ADVANCED.md)。

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
