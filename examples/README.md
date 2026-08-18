<div align="right"><a href="README.en.md">English</a></div>

# 示例

`examples/pi/` 是 `~/.pi/agent/` 的镜像。把它复制到用户目录后，`pi` 就能识别这些 agent 和 skill。

> 使用前先用 `pi install npm:@wolido/async-subagent-isolation` 安装扩展。
>
> **v1.2.0 提示**：`subagent` 工具的 `action="status"` 已作为 cleanup 移除。在途任务信息改由 `[subagent-result]` 通知信封的“在途任务”块提供。

## 目录结构

```
examples/pi/agent/
├── master.md
├── subagent-isolation.json
├── agents/
│   ├── coder.md
│   ├── reviewer.md
│   └── writer.md
└── skills/
    ├── brainstorming/
    ├── systematic-debugging/
    └── writing-clearly-and-concisely/
```

## Agents

### 子 agent (`agents/`)

| Agent | 作用 | 工具 | Skill |
|-------|------|------|-------|
| `coder` | 写代码、改代码、跑验证 | `read, write, edit, bash, grep, find, ls` | `systematic-debugging` |
| `reviewer` | 只读评审，输出可操作的反馈 | `read, grep, find, ls` | _(无)_ |
| `writer` | 写文档、README、commit message、PR 描述 | `read, write, edit, grep, find, ls` | `writing-clearly-and-concisely` |

子 agent 通过 frontmatter 的 `skills:` 字段加载 skill。`coder` 用 `systematic-debugging` 先找根因再修复,`writer` 用 `writing-clearly-and-concisely` 打磨文字,`reviewer` 不带 skill,说明该字段可选。

### 主 agent (`master.md`)

`master.md` 是主 agent 的系统提示，负责理解需求、拆分任务并委派给子 agent。它通过 `--append-system-prompt` 加载，例如：

```bash
pi --append-system-prompt ~/.pi/agent/master.md --skill ~/.pi/agent/skills/brainstorming/
```

### 安装 agent

```bash
mkdir -p ~/.pi/agent/agents
cp examples/pi/agent/agents/*.md ~/.pi/agent/agents/
cp examples/pi/agent/master.md ~/.pi/agent/master.md
```

也可以放到项目级 `.pi/agents/` 目录，只对当前仓库生效。

## 为子 agent 指定模型（`subagent-isolation.json`）

[`subagent-isolation.json`](pi/agent/subagent-isolation.json) 是模型配置示例：所有子 agent 的 model 与 thinking 覆盖集中在一个文件里。JSON 不支持注释，字段语义由下表说明。

复制到 `~/.pi/agent/subagent-isolation.json`（用户级）或 `.pi/subagent-isolation.json`（项目级，覆盖用户级同名 key）：

```bash
cp examples/pi/agent/subagent-isolation.json ~/.pi/agent/
```

| 字段 | 语义 |
|------|------|
| `$models` | 可选。可用 model 列表，`/subagent-config` 编辑 model 时从中选择，列表为空或未配置时回退自由输入。项目级 `$models` 是合法数组时整体遮蔽用户级列表，写 `[]` 可显式清空 |
| `"coder": { "model": ..., "thinking": ... }` | 对象格式，完整配置 model 与 thinking。thinking 取 pi 官方 7 个等级之一：`off` / `minimal` / `low` / `medium` / `high` / `xhigh` / `max` |
| `"writer": "deepseek/deepseek-v4-flash"` | 旧格式字符串，等价于 `{ "model": "deepseek/deepseek-v4-flash" }`，只配置 model |
| `"reviewer": { "thinking": "low" }` | 只配置 thinking 的对象，演示字段级回退：entry 内未配字段回退 frontmatter |

优先级链从高到低：进程内存（`/subagent-config` 写入 `this process`，不落盘，进程退出或 `/reload` 后消失）> 项目级 json > 用户级 json > frontmatter。json 中配置的字段遮蔽 frontmatter 同名值；文件层级按整 key 合并——项目级 entry 存在时整体遮蔽用户级同 key entry，entry 内未配字段仍回退 frontmatter。

无需手写 JSON：`/subagent-config` 可交互编辑 model/thinking 与 `$models` 列表并写回。

## Skills (`skills/`)

| Skill | 使用者 | 说明 |
|-------|--------|------|
| [`brainstorming`](pi/agent/skills/brainstorming/SKILL.md) | 主 agent | 通过协作对话把想法变成完整设计 |
| [`systematic-debugging`](pi/agent/skills/systematic-debugging/SKILL.md) | `coder` | 修 bug 前先找根因（四阶段流程） |
| [`writing-clearly-and-concisely`](pi/agent/skills/writing-clearly-and-concisely/SKILL.md) | `writer` | 用简洁规则、AI 痕迹检测和人味注入打磨文字 |

安装：

```bash
mkdir -p ~/.pi/agent/skills
cp -r examples/pi/agent/skills/brainstorming ~/.pi/agent/skills/
cp -r examples/pi/agent/skills/systematic-debugging ~/.pi/agent/skills/
cp -r examples/pi/agent/skills/writing-clearly-and-concisely ~/.pi/agent/skills/
```

Skill 从 `~/.pi/agent/skills/`（用户级）或 `.pi/skills/`（项目级）加载。子 agent 在 frontmatter 中声明 `skills:` 后自动加载；主 agent 可在命令行用 `--skill` 加载：

```bash
pi --skill ~/.pi/agent/skills/brainstorming/
```

## 使用 `subagent` 调用

安装后，通过 `subagent` tool 调用：

```json
{
  "agent": "coder",
  "task": "把认证中间件重构为 async/await。"
}
```

```json
{
  "agent": "reviewer",
  "task": "评审 src/auth.ts 的改动是否正确、清晰。"
}
```

```json
{
  "agent": "writer",
  "task": "为认证中间件重构写一条简洁的 PR 描述。"
}
```
