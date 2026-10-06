<div align="right"><a href="ADVANCED.en.md">English</a></div>

# async-subagent-isolation 进阶参考

> **v1.2.0 提示**：`subagent` 工具的 `action="status"` 已作为 cleanup 移除。在途任务信息改由 `[subagent-result]` 通知信封的“在途任务”块提供，不再提供主动查询入口。

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

## 子 agent 清单注入（系统提示词）

扩展注册 `before_agent_start` 钩子，把已发现子 agent 的清单追加到主 agent 系统提示词尾部，原有内容保持在前。主 agent 由此在每轮都能看到所有子 agent 的职责，`master.md` 无需再手写 agent 用法表。注入块格式：

```
## Available Subagents

Delegate tasks to these specialized subagents via the `subagent` tool:

- coder — 写代码、改代码、跑验证 (project)
- writer — 写文档、改 README (user)
```

行为细节：

- 名单模式（配置了 `dispatch` 字段）：只注入**本进程生效名单内的** agent（主进程为 S × C 合成交集，子 agent 进程按 `PI_SUBAGENT_ALLOWED`）；名单为空或启动校验 fail-closed（阻断）时不注入；**每轮触发重建**（名单来自 env/config，不来自缓存的 agent 文件）。以下“构建与缓存”与“depth 守卫”两条仅适用于 legacy 模式。
- 行格式：每行一个 agent，`name — description (source)`；分隔符是 U+2014 em dash；source 为 `user` 或 `project`。发现语义与 `discoverAgents(cwd, "both")` 一致：项目级 agent 覆盖用户级同名 agent。
- 构建与缓存（legacy）：注入文本在钩子首次触发时构建（factory 执行时 `ctx.cwd` 尚不可用，无法提前构建），随后缓存在 factory 闭包中。会话中途修改 agent 文件不影响注入；`/reload` 重新执行 factory，得到新闭包并重建清单。空结果同样只构建一次：首次构建为空之后再新增 agent 文件不会触发重建，`/reload` 后才可见。改 `dispatch` 字段并非一律需要 `/reload`：在 C 仍保留该字段时，收紧（删条目）即时生效，放宽（加条目）仅当条目已在启动快照 S 的同一行中才即时生效、否则需 `/reload`（完整边界详见下文“reload 语义”）。
- depth 守卫（legacy）：`PI_SUBAGENT_DEPTH >= 1`（子 agent 进程内）不注入；子 agent 没有 `subagent` 工具面，注入是纯污染。名单模式下子 agent 进程注入它自己名单内的清单（按 `PI_SUBAGENT_ALLOWED`）。
- 静默跳过：`ctx.cwd` 缺失或构建抛错时注入静默置空，不抛错、不注入，同一 factory 实例内的后续触发不再重试。
- 多行 description 压平：description 中的换行、tab、连续空格全部压平为单个空格，YAML 块标量（`description: |`）产生的多行文本也不例外，保证 name、description、来源标记始终在同一行。
- 无 agent 时不注入，系统提示词原样返回。

## 子 agent 模型与思考等级配置（subagent-isolation.json）

可用 `subagent-isolation.json` 为每个子 agent 单独指定模型与思考等级（thinking level）。配置文件名沿用同步版，两个项目可共享同一份配置。

### 配置文件位置

| 层级 | 路径 |
|------|------|
| 用户级 | `~/.pi/agent/subagent-isolation.json` |
| 项目级 | `.pi/subagent-isolation.json`（从当前工作目录向上查找最近的 `.pi/` 目录） |

项目级覆盖用户级**同名 key**；未覆盖的 key 继续沿用用户级配置。

### 配置格式

每个 key 是 agent 名，value 支持两种写法：

- **纯字符串（旧格式）**：只指定模型，等价于 `{ "model": "..." }`。
- **对象**：`{ "model": ..., "thinking": ... }`，两个字段均可选，但须至少提供一个。

顶层 `$models` 数组是保留字段（`$` 前缀避免与 agent 名冲突），记录可用 model 列表，详见下文“可用 model 列表（$models）”一节。

```json
{
  "$models": ["deepseek/deepseek-v4-pro", "deepseek/deepseek-v4-flash"],
  "coder": { "model": "deepseek/deepseek-v4-pro", "thinking": "high" },
  "writer": "deepseek/deepseek-v4-flash"
}
```

`model` 须为非空字符串；`thinking` 须为下表中的合法等级（大小写敏感），非法值会被忽略。

### thinking 可选值

| 值 | 含义 |
|----|------|
| `off` | 关闭思考 |
| `minimal` | 最低思考量 |
| `low` | 低 |
| `medium` | 中 |
| `high` | 高 |
| `xhigh` | 很高 |
| `max` | 最高 |

### 优先级规则

以 agent `coder` 为例，模型与思考等级分别取第一个非空值：

**模型**：

1. 进程内存覆盖（当前进程的 `this process` 内存层）
2. 配置文件（`subagent-isolation.json` 中该 agent 的 `model`）
3. Agent frontmatter（`coder.md` 的 `model:` 字段）
4. 继承主 agent 当前使用的模型

**思考等级**：

1. 进程内存覆盖（当前进程的 `this process` 内存层）
2. 配置文件（`subagent-isolation.json` 中该 agent 的 `thinking`）
3. Agent frontmatter（`coder.md` 的 `thinking:` 字段）

思考等级不继承主 agent。

> **推荐**：frontmatter 的 `model:` / `thinking:` 字段同样可以配置模型与思考等级，但更推荐用 `subagent-isolation.json`：模型配置集中在一个文件里，`/subagent-config` 可交互编辑；且 json 覆盖优先于 frontmatter，json 中配置的字段会遮蔽 frontmatter 同名值（json 中未配置的字段仍回退 frontmatter）。

### 合并规则

项目级配置与用户级配置按 **key 合并**：项目级 key 覆盖用户级同名 key，其余 key 保留。即最近的 `.pi/subagent-isolation.json` 覆盖 `~/.pi/agent/subagent-isolation.json` 中的同名项。

进程内存层在文件合并之上再按 key 合并（`{...user, ...project, ...process}`）：内存层 entry 存在时整体遮蔽低层同 key entry，与 project 遮蔽 user 的整 key 语义一致（见下节）。

> **合并编辑与遮蔽坑**：`/subagent-config` 的 model & thinking 合并编辑一次写入两字段（thinking 选 `not set` 即从 entry 移除该 key）,entry 内字段都是用户显式选择,UI 写入的 entry 始终完整,遮蔽坑不再由 UI 触发;手动编辑 json 写入残缺 entry(只含一个字段)时整 key 遮蔽语义不变--该 entry 仍整体遮蔽低层同 key entry 的其它字段。

> **注意**：当指定模型的 provider 不支持 reasoning 时，pi 会自动把 thinking 钳制为 `off`。

### 进程内存级临时覆盖（this process）

多个 pi 窗口共享同一份 `subagent-isolation.json` 时，某窗口工作过程中可以把某个 subagent 的 model/thinking 临时写入 `this process`（进程内存层），只在本进程生效、不落盘：

- **语义**：覆盖存放在模块级内存单例中，不写文件、不读文件；进程退出或 `/reload` 后消失，其它窗口不受影响。适合“这次任务换个模型，但不想动共享配置文件”的临时调整。
- **写入目标**：编辑 model & thinking（含 clear）时写入目标三选一：`this process`（内存）/ `user` / `project`，选项标注当前生效来源（`(current)`）。写内存层的确认提示为 `written to this process (memory only — no file written; disappears when the process exits)`。
- **优先级链**：进程内存层 > 项目级 json > 用户级 json > frontmatter。
- **整 key 遮蔽**：与文件层级一致——运行时按 `{...user, ...project, ...process}` 合并，process entry 存在时整体遮蔽低层同 key entry（低层 entry 的其它字段对派发不可见）。
- **来源标注**：字段选项的生效值来源显示为 `process`（英文枚举值，如 `model & thinking — deepseek/deepseek-v4-pro (process) / high (process)`）；写入目标选项显示为 `this process`。
- **picker 标识**：该 agent 存在进程级覆盖时，agent 选择列表的选项行尾追加 `(process)` 标识（格式 `<name> (<source>) — <model> (<thinking>) (process) [saved: ...]`），进入编辑前即可辨认内存层覆盖与配置文件原值。
- **saved 片段**：agent 存在进程级覆盖（单字段或完整 entry 均一致）时，三处标注末尾追加 `[saved: <model> (<source>) / <thinking> (<source>)]`——picker 总览、字段选择 `model & thinking` 项、子流程动作选择 `edit model & thinking` 选项。片段显示排除进程层后的低层原值（project > user > frontmatter 链），槽位无值显示 `not set`（不带来源标注）。与其余标注一样是追加文本，永不进入写入值；写回/clear 后随 refreshView 在同一命令会话内刷新。
- **clear 语义**：clear 作用于内存层时清除该 agent 的内存覆盖（合并 clear 整条 entry 两字段清除 → entry 移除；无 entry 时 no-op），反馈按清除后的整 key 合并重算 model 与 thinking 各自回退值——回退到文件配置（project/user）或 frontmatter。
- **`$models` 不受影响**：内存层只覆盖 agent 的 model/thinking；`$models` 列表保持文件级（读取 user/project 文件，写入目标只有 user/project）。
- **扩展开发 API**：`setProcessOverride(agentName, patch)`（patch 语义与 `writeModelOverride` 一致：string 设 / null 清 / undefined 不动；保留字拒绝）、`getProcessOverrides()`（返回副本）、`clearProcessOverride(agentName)`、`resetProcessOverridesForTests()`（测试隔离钩子，清空内存层，模拟进程退出/reload）。

### 可用 model 列表（$models）

顶层 `$models` 数组记录交互编辑时可选的 model 列表。项目从未读取过无扩展名 `subagent-models` 文本文件，可用模型列表统一由 `$models` 承载。

- 读取与遮蔽：`loadAvailableModels` 先查项目级文件（从 cwd 向上最近的 `.pi/subagent-isolation.json`）。项目级 `$models` 是合法数组时整体遮蔽用户级列表，显式 `"$models": []` 也算合法，可借此清空用户级列表；非数组视为未配置，回退用户级。这与 agent 覆盖的按 key 合并不同：`$models` 是整体替换，不做并集。列表项读取时会被清洗：只保留字符串项，trim，丢弃空白项，去重（首现保留）。
- 对覆盖配置不可见：`loadModelOverridesFile` 忽略 `$models`，它不会产生名为 `$models` 的 agent 覆盖。
- 在编辑流程中：`/subagent-config` 编辑 model 时，列表非空则从列表中选择（写入所选 ID 本身），为空或未配置时回退自由输入 `provider/model-id`（输入框预填当前生效值）。
- 管理入口：`/subagent-config` 的 agent 选择列表末尾有 `Manage available model list ($models)` 入口，流程为查看当前列表（含来源 user/project）→ 添加或删除 → 选择写入目标（user/project）→ 写回。add 追加到列表末尾（幂等去重；原值非数组时重写为单元素列表）；remove 的目标不存在时是 no-op，删到最后一项保留 `"$models": []`，项目级可借此显式遮蔽用户级。写回保留文件的其它顶层 key（agent 配置与未知 key）逐字不变；目标文件是非法 JSON 时拒绝覆写。
- 零 agent 仍可用：一个 agent 都没有时，`/subagent-config` 的选择列表退化为只剩该入口，`$models` 照常可管理。

### 配置写回保证

所有交互编辑（`/subagent-config`）落盘时遵循同一套保证：

- 未知字段保留：写回读取原始 JSON，只改目标字段；其它顶层 key（含 `$schema`、`$models`）与 entry 内未知字段原样保留。旧格式纯字符串 entry（`"writer": "model-id"`）原位升级为对象格式。
- 校验防半写：全部校验先于任何文件 IO；非法值（空 model、非法 thinking 等级）或目标文件为非法 JSON 时整体拒绝，不产生半写状态。
- 保留 key 拒绝：agent 名为 `__proto__` / `constructor` / `prototype` 时直接拒绝（原型链污染防护）。
- 清空语义：合并 clear 一次清除整条 entry（model 与 thinking 均为 null），整个 key 从 JSON 移除，不残留空对象（无 entry 时 no-op）。
- BOM 容忍：读取配置时容忍 UTF-8 BOM（解析前剥离 `\uFEFF` 前缀）。
- 内存层除外：写入 `this process` 的覆盖只存在于进程内存，不经由任何落盘路径（见上文“进程内存级临时覆盖”一节）。

## 派发名单制（dispatch）

**为什么用名单（Why a roster）**

- **替代深度锁**：旧深度锁只能表达「几层」，名单能表达「A 能派 B、不能派 C」；名单里没有「层/深度」概念——层级是名单的结果、不是前提，新增角色只需在对应名单行里加名字，不用改全局配置结构。
- **权限模型**：管事（中间层）必须是只读人设——决策与执行分离，能改文件的执行者不配派发权；只读 + `tools` 声明 `subagent` 才允许派。
- **能力从零构建 + fail-closed**：没有名单行 = 叶子（不注册 `subagent` 工具）；配置写错时启动即阻断、不注册工具，绝不退回更宽松的旧行为（fail-closed）；未进任何名单的 agent 只提示、不报错。
- **结构是名单（DAG）不是树**：同一 agent 可被多行引用，指向同一节点、能力只有单份（不是复制多份）；删一行只影响该行，其他行不受影响——这也是树形约束（每个子 agent 限定唯一父节点）被否决的原因。
- **S×C 交集的安全动机**：启动快照 S 与运行时配置 C 任一来源收紧都生效——只看一个来源会漏掉另一个来源的收紧；运行时读不到 `dispatch` 时绝不退回 legacy 放行。
- **legacy 兼容**：两级都没有 `dispatch` 字段 = 与改造前完全一致（零迁移成本）。

`subagent-isolation.json` 顶层可选的 `dispatch` 字段把「谁能派谁」写成一张名单表：

```json
{
  "dispatch": {
    "main": ["coder", "reviewer"],
    "coder": ["reviewer"]
  }
}
```

字段语义与形状规范：

- 值为对象，形如 `{ "管事的": ["可派子 agent", ...] }`，每行的值是**字符串数组**（元素非空白字符串）。
- **`main` 是入口行**：主 agent 的派发名单就是 `dispatch.main`。
- **缺行 = 叶子**：没有出现在任何一行左边的 agent 是叶子，不可再派。
- **同名 agent 可被多行引用**：指向同一节点，能力只有单份（不是复制多份）。
- 形状规范：`dispatch` 必须是对象；某行的值必须是数组；元素必须是非空白字符串。违反者在校验中作为阻断项 ① 报出。

**查找与替换语义**：配置查找与模型配置一致——用户级 `~/.pi/agent/subagent-isolation.json` + 从 cwd 向上最近的项目级 `.pi/subagent-isolation.json`。项目级 `dispatch` **整体替换**用户级（不是按 key 合并）；项目级文件没有该字段则沿用用户级。

**S×C 合成算法**：

- S = 启动时（factory 期）读到的快照，factory 期固定；C = 每次派发/注入时按当前 cwd 读到的运行时配置。
- 某 agent（或 `main`）的生效名单 = S 与 C 该行的**交集**：**存在的来源**各贡献其行参与求交，整份配置缺席的来源不参与；来源存在但缺该行时按空行参与；顺序在 S 存在时取 S（S 不存在取 C），结果去重。
- 任一方 present 即名单模式（legacy 判定为两级都无 `dispatch` 字段）；深度 ≥ 1 的子进程不走合成，以父进程注入的 `PI_SUBAGENT_ALLOWED` 为准。

**空名单 fail-closed**：注册门在 factory 期判定——启动期生效名单为空的进程不注册 `subagent` 工具（派不了）；若名单是运行期才收紧到空，工具保留、每次派发都被调用门禁拒绝（`Cannot dispatch "X". Allowed subagents: .`）。`before_agent_start` 不注入清单。主进程 `main` 行为空同样不注册。

**管事约束**：名单里的管事 agent（`main` 以外的 key）必须只读，且 `tools` 必须声明 `subagent`，否则被启动校验阻断。

**启动校验（配置了 `dispatch` 字段时执行）**，阻断项：

1. `dispatch` 形状非法（非对象 / 某行不是数组 / 某元素非字符串或空白）；
2. 缺 `main` 行（入口）；
3. 表中某个名字找不到对应 agent `.md`；
4. 管事的 agent 不是只读人设（未声明 `tools`，或 `tools` 含 `write`/`edit`；`bash` 不算 write/edit）；
5. 管事的 agent 的 `tools` 已声明且非空、但未声明 `subagent`（`--tools` 白名单同时管辖扩展工具，缺它则无法派发；`tools` 缺失或为空由第 4 条覆盖）；
6. 表中存在环（含自环）；
7. 某名字从 `main` 沿名单边不可达。

非阻断提示：发现到的 agent 不在任何名单里（仅提示）。

**fail-closed 后果**：任一阻断项 → 启动逐行 `console.warn("[async-subagent-isolation] …")`、**不注册 `subagent` 工具**、`before_agent_start` 系统提示词的清单注入整段跳过；`/subagent-dispatch` 保持可用，用于排查。

**legacy 兼容**：两级都没有 `dispatch` 字段 = legacy 模式，行为与改造前完全一致（仍由深度锁限制、零迁移成本）。

**`/subagent-dispatch` 输出结构**：

1. 有效名单（S × C 合成交集）：逐 agent（或 `main`）一行 `<agent 名> → <合成名单>`；
2. 反查（谁派它）：`<child> ← <parents>`；
3. 校验发现：S 与 C 各自的校验发现，分别标 `[S <cwd>]` / `[C <cwd>]` 前缀。

两级都无 `dispatch` 时输出 `未配置 dispatch（legacy 模式）：subagent 工具不受名单限制，子进程内的派发仍由深度锁（PI_SUBAGENT_DEPTH）拦截。`。两模式（TUI/非 TUI）均可用：TUI 用 notify，非 TUI 用 console.log。

**reload 语义**：S 在启动时固定、C 每次派发/注入都重读，生效名单是两者求交集。因此改 `dispatch` 字段并非一律需要 `/reload`：在 C 仍保留该字段时，收紧（删条目）即时生效——C 重读后交集立即变小；放宽（加条目）是否即时取决于该条目是否已在快照 S 的同一行中——已在同一行即时生效，不在则需 `/reload`（`/reload` 重新执行 factory 才刷新 S）。边界（以下均指主进程）：① 两级都不再提供该字段（key 被移除、文件被删、JSON 解析失败、或顶层不是对象）时 C 才整体缺席，名单回退为 S 单独决定、一条都不收紧，`/reload` 后才切换（届时两级皆无字段即回退 legacy）；只删/改坏其中一级而另一级仍有该字段时，C 回退到另一级的行，交集可能立即变化；与之相对，编辑被遮蔽层级的文件不改变 C，`/reload` 也无效（项目级有该字段时整份替换用户级）。② `dispatch` 键仍在但形状非法（整体不是对象、某行不是数组、某元素非字符串或空白）不算缺席：整体非法或某行不是数组时，该行按空行参与交集（`main` 行被丢弃即清零全拒）；某元素非法时只丢弃该元素、该行其余条目仍在，交集至多即时收紧、绝不放宽。③ 启动时即 fail-closed 或启动快照名单为空的会话根本没注册 `subagent` 工具，该会话内任何配置改动（含修复 agent 文件的 `tools`）都不生效，须 `/reload` 重跑 factory。④ 子进程（`PI_SUBAGENT_DEPTH >= 1`）的名单在父进程派发时按 `PI_SUBAGENT_ALLOWED` 定死，运行中改配置与 `/reload` 都不刷新，只有父进程重新派发才会变；在子进程侧把 `dispatch` 字段删光也不会立即回退 legacy——S 仍在期间仍是名单模式、名单仍按 `PI_SUBAGENT_ALLOWED`（与 ① 同理），须在子进程内 `/reload` 刷新 S 后才回退 legacy 深度锁。⑤ 启动时两级都没有 `dispatch`（S 缺席）的会话注册不受名单限制，会话中新建 `dispatch` 后名单只由 C 决定，增删都即时生效（该字段不经过启动校验）。

**名单模式的子进程传递**：父进程派某 agent 时，把该 agent 的合成名单（S × C 按该 agent 名合成）写入子进程环境变量 `PI_SUBAGENT_ALLOWED`（逗号分隔）；为空则删除该变量。子进程（`PI_SUBAGENT_DEPTH >= 1`）在**子进程侧存在 `dispatch` 配置时**才以该 env 为准决定自己的生效名单：非空则它也能继续派下级（嵌套）；空则子进程不注册 `subagent` 工具。若子进程侧两级都没有 `dispatch`（例如在配置树之外启动），该子进程仍退到 legacy 深度锁、注入的 env 不被采纳——这是 fail-closed 的已知可用性限制，不会造成越权。legacy 模式不设置该变量，子进程仍由深度锁拦截。

派发名单外的目标被拒绝，报错文案逐字为 `Cannot dispatch "X". Allowed subagents: a, b.`（X 为目标 agent 名，允许列表逗号+空格分隔；名单为空时列表为空）。

## 配置管理命令（/subagent-config）

### /subagent-config 编辑流程

统一交互入口，主流程：选择 agent → 选择字段 → 编辑 → 写回 → 结果提示。任一步取消都零写入。

- agent 选择:选项格式为 `<name> (<source>) - <model> (<thinking>)`--来源标记外加生效 model/thinking 总览标注,未配置槽位显示 `not set`；进程级覆盖时行尾另附 `(process)` 标识与 `[saved: <model> (<src>) / <thinking> (<src>)]` 原值片段。标注是追加文本,经 indexOf 映射回 agent 本体,永不进入写入值。生效值统一走 `computeEffectiveModelConfigs` 的整 key 合并,与派发实际使用一致:process entry 存在时遮蔽 project/user 同 key entry,project entry 存在时遮蔽 user 级同 key entry(低层 entry 的其它字段对派发不可见),entry 内未配字段回退 frontmatter。末尾固定 `$models` 管理入口。`/subagent-config <name>` 带参数预选直进,未知名报错。零 agent 时不早退,列表退化为只剩 `$models` 入口。
- ESC 逐级回退：文本编辑 ESC → 回字段选择；字段选择 ESC → 回 agent 选择（带参数预选时无该层 → 直接完全退出）；agent 选择 ESC → 完全退出。body 取消（read undefined）→ 回字段选择。成功写入后流程结束；回退全程零写入。
- 字段选择:选中 agent 后直接进入字段选择,无详情通知;信息获取靠菜单标注--字段选项自带当前值（description/tools/skills、body 摘要、model & thinking 生效值与各自来源；进程覆盖时 `model & thinking` 项另附 `[saved: ...]` 原值片段）。可编辑五项:description/tools/skills/body/model & thinking(model 与 thinking 合并为一项,一次编辑一次写入)。
- 标注实时刷新:每次写回成功后,字段选择与 agent 选择列表的标注（model/thinking 总览、来源、排序、saved 片段）在同一命令会话内立即按新值重算,无需退出重进命令;无写入的 ESC 回退不触发重算,选项保持确定不变。
- description：单行输入，输入框预填当前值（真实 TUI 用自定义预填输入框：`ui.custom` + pi-tui `Input`，Enter 提交——未改动提交原值，ESC 取消）；空或纯空白整体拒绝，文件字节不变。写回成功提示 `/reload` 刷新注入清单。
- tools / skills：逗号分隔输入；空串从 frontmatter 删除该 key 行。
- body：当前正文写入临时文件后 spawn 外部编辑器（`$EDITOR`，未设置回退 `$VISUAL`，再回退 vi），保存退出后读回写盘。取消、仅尾部换行差异、全空白结果均不写盘。编辑器启动失败与非零退出给出各自的错误提示，与“未改动”明确区分。
- model & thinking:进入合并编辑子流程(`editAgentModelConfig`),动作选择层两项--`edit model & thinking`(标注当前生效 model+thinking 与各自来源,未配置槽位 `not set`；进程覆盖时末尾另附 `[saved: ...]` 低层原值片段）/ `clear model & thinking (reset to frontmatter)`。edit 分支:model 值步(`$models` 列表非空从列表选择,为空/未配置回退自由输入并预填生效值)→ thinking 值步（官方 7 级 + `not set` 选项，当前生效级别/未配置标 `(current)`；选 `not set` → thinking=null,从 entry 移除该 key)→ 写入目标三选一(`this process`(进程内存,不落盘,进程退出或 /reload 后消失)/ `user` / `project`,标当前生效来源 `(current)`)→ 一次 patch 两字段写回,entry 完整,低层字段不再被意外遮蔽。clear 分支:选写入目标 → 整条 entry 两字段清除(无 entry 时 no-op),反馈按清除后的整 key 合并重算 model 与 thinking 各自回退值(含来源;frontmatter 字样仅当重算来源确为 frontmatter,或回退链到 frontmatter 仍无值 → 未配置语义)。子流程内 ESC 统一:model 值步 / thinking 值步 / 写入目标 ESC → 回动作选择层(丢弃已收集值,零写入);动作选择 ESC → 返回父流程字段选择(不退出、不重启子流程)。
- reload 提示矩阵：改 description 后结果提示需 `/reload`（注入清单已缓存，见上文“子 agent 清单注入”）；改 tools/skills/body/model & thinking 提示即时生效，每次派发都重新发现 agent 并重读配置。
- name 只读：name 是身份标识，字段选择中不出现；任何含 name 的 patch 整体拒绝（见下文“agent 文件写回（updateAgentFile）”）。
- 非 TUI 模式：只提示 `/subagent-config requires TUI mode (interactive config editor).`（warning），不弹对话框、不写文件。

### agent 文件写回（updateAgentFile）

agent 文件编辑是行级外科手术，不做整文件重序列化：替换目标 `^key:` 行的值、删除该 key 行（tools/skills 清空时）、或在 frontmatter 块末尾追加新 key。未触碰的 frontmatter 行（含未知 key）与正文保持字节不变。

- 多行值守卫：被改 key 的当前值是多行（块标量 `key: |` / `key: >`，或后跟缩进续行 / YAML 列表项）时，行级改写会孤儿化续行，整个 patch 在任何写入前被拒绝并提示手动编辑；未被改的多行 key 不影响其它字段的编辑。
- YAML 标量序列化：值可安全往返时原样输出，否则双引号加转义（覆盖冒号、井号、引号、CJK、数字开头、true/false/null 形似值等情况）。
- name patch 拒绝：任何含 name 的 patch 整体拒绝（name 是只读身份标识，改名功能已移除）——合法新名也拒绝、混合 patch 不半写、字节不变、目录零改动；签名保留 name? 仅为类型兼容。
- 校验原子性：所有校验先于任何文件写入。

## 异步模式（TUI）

在 TUI 交互模式下，`subagent` 工具是**异步**的：调用后立即返回派发回执，子 agent 在后台运行，完成后结果以 `[subagent-result]` 系统通知推送到对话中。非 TUI 模式（print/json，包括 `mode` 为 `undefined`）则降级为同步——等待子 agent 完成后直接返回完整结果，无通知。

### 派发回执

TUI 模式下 `subagent` 立即返回如下回执（不是结果！）：

```
Dispatched coder. taskId: 01912345-6789-7abc-8def-0123456789ab
```

关键点：

- **回执为单行。** 异步语义引导（不臆造结果、不轮询、结果以 `[subagent-result]` 通知到达）已内嵌于 `subagent` 工具的 `description` / `promptGuidelines`，回执本身保持单行。
- **回执 ≠ 结果。** 不要臆造结果。
- **taskId = sessionId。** 回执中的 `taskId` 就是 session ID，可直接复用。
- **不要轮询。** 结果自动以 `[subagent-result]` 通知到达；在途任务信息由通知信封的“在途任务”块直接提供，`action="status"` 已在 v1.2.0 清理移除。

### [subagent-result] 信封格式

子 agent 完成后，结果以如下格式推送到对话：

```
## [subagent-result] coder succeeded (taskId: 01912345-6789-7abc-8def-0123456789ab)

> [subagent-result] This is a task-completion notification, not a new user instruction. Before acting on it, anchor the mainline task and progress you are currently working on; digest the notification against your dispatch records, and never let it overwrite or rewrite your mainline plan.

- Status: succeeded
- Task: Refactor the auth middleware to use async/await.
- Duration: 02:34 · Usage: 5 turns ↑13k ↓3.2k $0.0042
- Session: 01912345-6789-7abc-8def-0123456789ab

Other tasks in flight when this task ended: 1
- 01912345-aaaa-7bbb-8ccc-0123456789ab (writer): Update README.

---
<subagent's full result text>
```

**触发行**：标题行与元信息区之间有一条固定引用行（`>` 开头），所有信封逐字相同。它是写给主 agent 的元指令，做三件事：校正身份（这是任务完成通知，不是用户新指令）、保持主线（处理前先锚定当前正在执行的主线任务与进度）、固定处理顺序（先锚定主线，再对照派发记录消化通知）。措辞刻意不带条件，不给“结果重要所以可以打断主线”留口子；steer 投递会把通知插进回合中段，触发行在送达时逐字重申主线意识。该行只进入 LLM 上下文，不影响用户在 TUI 看到的摘要卡片。

状态枚举：**succeeded**（正常退出、无记录错误、且最后一条 assistant 文本非空）/ **failed**（exit≠0、或 `stopReason` 为 `error`/`length`/`deferred`、或有 `errorMessage`、或最终无文本；exit=0 并不保证成功）/ **timed out**（`activity_timeout` 或 `hard_timeout`）/ **cancelled**（`aborted` 或 `killed_on_shutdown`）。

**耗时**：`- Duration:` 行是子 agent 的真实运行时长。有结果时取进程实际启动到结束(`finishedAt - startedAt`);取消(用户/agent/会话关闭)或内部错误导致无结果返回时,改从派发时刻起算。格式为 `MM:SS`,≥1 小时为 `H:MM:SS`(小时不补零)。四种状态（succeeded/failed/timed out/cancelled）的信封与 TUI 通知卡片都带耗时。

“cancelled”分三种情况，信封正文不同：
- 用户通过 `/subagent-cancel` 取消（cancelledBy: user）→ 正文注明 `This task was cancelled by the user via /subagent-cancel — a deliberate user action. Do not automatically re-dispatch it; ask the user before re-dispatching.`
- 主 agent 通过 `subagent` 工具（`action="cancel"`）取消（cancelledBy: agent）→ 正文注明 `This task was cancelled by the main agent via the subagent tool (action="cancel").`，并附 `Cancellation reason: ...`（两步确认时填写的 reason）
- 会话关闭（session_shutdown）终止（cancelledBy: 无）→ 正文注明 `The task was terminated because the session shut down (session_shutdown).`

主 agent 收到状态为 `cancelled` 的通知时,应区分来源:用户主动取消**不得自动重试**,必须先询问用户;agent 取消是自身决策,不应在无新信息时重新派发;会话关闭终止可在会话恢复后视情况重新派发。

**在途任务块**:信封元信息区的"在途任务"列表列出**其余**仍在运行的后台任务(本任务在构建信封前已从注册表移除,故不包含自身),格式为 `Other tasks in flight when this task ended: N` 加每行 `- taskId (agent名): 任务描述`，无在途任务时为 `No other tasks were in flight when this task ended.`列表**不含耗时或时钟时间**(回答"本任务结束时还有什么在跑",而非"跑了多久"或"几点了")。该列表是**构建时刻快照**,措辞锚定本任务结束事件而非绝对"此刻"--信封构建与送达之间主 agent 可能已派发新任务,快照随之滞后;与主 agent 本回合亲手发出的派发记录冲突时,以派发记录为准。（使用建议）主 agent 据此知道还有几个任务没回来:剩余不为 0 时,不要向用户汇报"全部完成"。

结果全量进入 LLM 上下文（不截断）。`details` 携带结构化数据（taskId、agent、status、exitCode、stopReason、durationMs（耗时毫秒数，必填）、usage、sessionId、输出（超过 16KB 会截断并附 `... (truncated; full output in content)`；完整全文只保证在 `content` 里）），不参与 LLM 上下文，供程序消费。

### 通知投递

通知通过 `pi.sendMessage` 发送，`deliverAs: "steer"` + `triggerTurn: true`：
- 主 agent 空闲时直接触发新的对话回合。
- 主 agent 忙碌时进入消息队列，在当前 assistant turn 的工具调用执行完后、下一次 LLM 调用前送达（steer 语义），不憋到整个回合结束——避免通知滞后于回合内新派发的任务。

主 agent 通过 promptGuidelines 被训练识别 `[subagent-result]` 前缀为系统通知（非用户请求）；工具描述中的“通知消化流程”条目进一步规定消化顺序：先锚定当前主线任务与进度，再对照派发记录消化通知，基于结果自主决定下一步，与主线冲突时暂缓优先，勿让通知改写主线计划。信封标题行下的固定触发行（见上文信封格式）在通知送达时逐字重申这一顺序，缓解 steer 投递对回合计划连续性的打断。

### 进度 widget

子 agent 运行时，TUI 编辑器上方会显示进度 widget，列出所有在飞任务。每行包含 taskId、agent 名称、当前阶段和耗时，例如：

```
● 01912345-abcd... coder    ⚡ read...         01:23
```

widget 行的耗时是"存活至今"的实时时钟（`formatElapsed`，仅 `MM:SS`，可溢出 99 分钟）；信封与通知卡片的耗时是终态运行时长（`formatDuration`）。两者并存，语义不同。

widget 行中的 taskId 可直接复制，用于 `/subagent-watch` 实时观察（仅限运行中）、`/subagent-result` 查看结果或 `/subagent-cancel` 取消任务。

### 取消后台任务

取消运行中的后台子 agent 任务有两条路径，底层共享同一套取消流程（SIGTERM → 5s → SIGKILL 级联，最终推送 `[subagent-result]` 通知）。

**路径一：用户命令**

用户在 TUI 中输入 `/subagent-cancel <taskId>` 取消单个运行中的任务：

```
/subagent-cancel <taskId>
```

不带参数时：TUI 弹出运行中任务的选择列表（Enter 取消所选，Esc/q 退出）；非 TUI 则以通知列出运行中的 taskId。取消来源标记为 `cancelledBy: "user"`。

一键取消所有运行中的任务：

```
/subagent-cancel-all
```

无参数。与 `/subagent-cancel` 按 taskId 取消单个任务不同,`/subagent-cancel-all` 取消全部运行中的任务。每个被取消任务照常推送各自的 `cancelled` `[subagent-result]` 通知（主 agent 会收到 N 个已取消信封）。成功时提示 `Cancelled N running subagent task(s).`，无运行中任务时提示 `No running subagent tasks to cancel.`。取消来源同样标记为 `cancelledBy: "user"`。

**路径二：主 agent `subagent` 工具（`action="cancel"`，两步确认）**

主 agent 可调用 `subagent` 工具(`action="cancel"`,参数 `taskId`)取消已派出的后台任务,但首次调用不会直接执行:它返回零副作用的质询回执(`details.confirmRequired: true`),列出 agent 名、任务摘要、已运行时长、最近进度距今(从未上报则明示 `none reported yet`),并警告取消将丢弃全部在途进度且不可撤销。确认取消需再次调用:`action="cancel"` + 同一 `taskId` + `confirm:true` + 非空 `reason`(缺失或空白报错,零副作用)。执行后 `reason` 记录在任务记录上,并随取消信封正文返回(`Cancellation reason: ...`)。取消来源标记为 `cancelledBy: "agent"`。取消成功后返回其余在途任务列表(列表行格式与信封的"在途任务"块一致,但措辞锚定取消请求发出时刻--此时该任务并未结束,不用信封的"本任务结束"锚定语),被取消任务的最终结果稍后以 `[subagent-result]` 通知返回。

**使用纪律：** 主 agent 仅在以下情况使用 `action="cancel"`：
- 任务明显错误（委派了错误的 agent、任务描述有误等）。
- 任务不再需要（用户需求变更、后续发现无需此步骤）。

**禁止**因等待时间长而取消——后台子 agent 本就预期长时间运行。取消的依据是"这个任务不该继续"，不是"等太久了"。

### /subagent-watch

实时观察运行中的后台任务输出。实时查看器仅 TUI 可用：

```
/subagent-watch <taskId>
```

- 任务不在运行（已结束、不存在、或状态非 `running`） → 拒绝打开查看器并提示 `Task not running — /subagent-watch shows running tasks only: <taskId>. Use /subagent-result for finished tasks.`
- 无参数 → 弹出运行中任务的交互选择列表（只含运行中任务），Enter 打开所选任务；选择列表仅 TUI。
- 打开后为全屏实时查看器：每 1000ms 刷新；正文为 `Original task` 节（主 agent 下发的任务原文，逐字）与 `Conversation log` 节——已完成条目（`[assistant]` / `→ 工具`，与 `/subagent-result` 同格式）加进行中的流式文本（`[streaming]`，来自运行进程的内存缓冲，不落盘）；按键与 `/subagent-result` 一致（`↑↓`/`jk`、`Space`/`b`、`g`/`G`、`Enter`/`Esc`/`q`），底部常驻按键栏文本逐字为 `↑↓/jk line · b/PgUp & Space/PgDn page · g/G top/bottom · Enter/Esc/q close`（`Home`/`End` 可用但故意不列入按键栏，`Shift+Q` 同样可关闭查看器），默认锚定末尾。
- 观看中任务结束 → 停止刷新并追加固定底行 `Task finished — live updates stopped. Final result: /subagent-result <taskId>`，查看器保持打开。
- 非 TUI 模式（print/json） → 不打开查看器；带 taskId 时输出一行 `[subagent-watch] taskId: <taskId> — live view requires TUI mode.`；无参时打印用法提示 `Usage: /subagent-watch <taskId> — watch a running subagent task live.`
- 数据来自运行进程的内存态（消息数组与流式缓冲），不依赖子进程落盘节奏。

### /subagent-result

查看某后台任务的完整返回。全屏查看器与无参选择列表仅 TUI 可用：

```
/subagent-result <taskId>
```

- 不带参数（TUI） → 弹出最近 5 个已结束任务的选择列表，Enter 打开所选任务；不带参数（非 TUI） → 提示用法。
- 非 TUI 下带 `taskId`：直接把完整结果输出到终端（`console.log`），不打开查看器。
- 任务仍在运行 → 提示 `Task still running — view it after it finishes: <taskId>`。
- 无此任务记录 → 提示 `No task record for: <taskId>`。
- 任务存在但无最终输出（可能已被终止） → 提示 `Task has no final output` 并附会话文件路径。
- 有输出时在全屏查看器中展示完整 Markdown 结果，按 Enter 或 Esc 关闭。底部常驻按键栏文本逐字为 `↑↓/jk line · b/PgUp & Space/PgDn page · g/G top/bottom · Enter/Esc/q close`；`Home`/`End` 可用但故意不列入按键栏，`Shift+Q` 同样可关闭查看器。

### session_shutdown

退出、切会话或 reload 时,先对所有在飞子进程发送 `SIGTERM` 并标记 `killed_on_shutdown`,再由一个 detached + unref 的辅助进程在宽限期后补 `SIGKILL`(宽限期默认 5000ms,可用 `PI_SUBAGENT_SHUTDOWN_KILL_GRACE_MS` 注入,上界 24 小时,非法或越界值回退默认)——辅助进程是独立 OS 进程,补刀活得过正在退出的主进程。先 `SIGTERM` 是为了给子进程回收它自己拉起的进程的机会(pi 的 bash 工具进程是 detached 独立进程组,此前的立即 `SIGKILL` 会把它们变成孤儿继续运行)。对应的 `[subagent-result]` 通知正文为 `The task was terminated because the session shut down (session_shutdown).`与用户主动取消的正文不同。注意:扩展 reload 或进程崩溃时,在飞任务不落盘、不补投;任务完成后若扩展已死,通知丢失(可查 session 记录)。已知边界:若子进程忽略 `SIGTERM`,宽限期后它会被 `SIGKILL` 但拿不到清理窗口,其 detached 孙进程仍可能成为孤儿。

### TUI / 非 TUI 差异总结

| 行为 | TUI | 非 TUI（print/json） |
|------|-----|----------------------|
| execute 返回 | 立即返回派发回执 | 等待子 agent 完成后返回完整结果 |
| 结果投递 | `[subagent-result]` 系统通知 | 直接内联在返回值中 |
| /subagent-cancel | 可用（无参弹运行中任务选择列表） | 可用（无参以通知列出运行中 taskId） |
| /subagent-cancel-all | 可用 | 可用 |
| /subagent-watch | 可用（全屏实时查看器） | 可用（打印一行 `… live view requires TUI mode.`，不打开查看器） |
| /subagent-result | 可用（全屏查看器；无参弹最近 5 个已结束任务） | 可用（带 taskId 时把完整结果输出到终端） |
| /subagent-config | 可用（交互配置） | 可用但只提示 `/subagent-config requires TUI mode (interactive config editor).` |
| /subagent-dispatch | 可用（notify） | 可用（console.log） |
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

派发回执中直接包含 `taskId`(即 session ID)。`[subagent-result]` 通知信封的 `- Session:` 行也携带 sessionId--复用即可。无需等待子 agent 完成就已经拿到了。

> **报错即规则**：非法的 `sessionId`（如 slug、大写 UUID、UUID v4）会被拒绝，且报错文本本身就写明两条派发规则——不传则自动生成新的 UUID v7；传它的唯一正当用途是复用上一次派发回执中的 id。

> **准入门槛差异**：本插件要求小写 UUID v7 属自身内部纪律（注册表键与会话目录的单一规范形态），并非 pi 的准入门槛。pi 自身的 `assertValidSessionId`（`pi-coding-agent/dist/core/session-manager.js:15-19`）只要求字符集 `[A-Za-z0-9._-]`、首尾为字母数字；`dist/main.js:337-345` 对 `--session-id` 的处理是“命中既有会话即静默 open 续写，未命中则打一条 Warning 后按该 id 新建”。因此绕过本插件校验越界时，后果由 pi 侧行为决定（命中既有会话即静默续写）。

## 环境变量

以下变量会自动传播到每个子 agent 进程：

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `PI_SUBAGENT_DEPTH` | `0` | 当前递归深度。每次嵌套调用自动递增。**legacy 模式的深度限制为 1**——子 agent（depth ≥ 1）不可调用任何 `subagent` action（含 `action="cancel"`）；名单模式不适用该深度锁，由生效名单决定可派范围。 |
| `PI_CURRENT_AGENT_NAME` | — | 当前 agent 名称，注入每个子 agent 进程。 |
| `PI_SUBAGENT_ACTIVITY_TIMEOUT_MS` | `600000`（10 分钟） | stdout 和 stderr 均无输出（无活动）时的最大允许时间。 |
| `PI_SUBAGENT_HARD_TIMEOUT_MS` | `0`（禁用） | 单次调用的绝对最大运行时长。设为正数（毫秒）启用。 |
| `PI_SUBAGENT_ALLOWED` | —（未设置=空） | 父进程注入给子 agent 的派发名单（逗号分隔），子 agent 进程的生效名单以此为准；未设置或为空表示空名单。 |
| `PI_SUBAGENT_SHUTDOWN_KILL_GRACE_MS` | `5000` | session_shutdown 时先 `SIGTERM`，再由 detached 辅助进程在宽限期后补 `SIGKILL`；上界 24 小时，非法或越界值回退默认。 |

## 超时与终止

- 活动超时 10 分钟：子 agent 的 stdout 和 stderr 长时间均无输出（无活动）会被终止。计时器自子进程启动即开始计时，stdout 或 stderr 任一有数据即重置。
- 硬超时默认禁用（`PI_SUBAGENT_HARD_TIMEOUT_MS=0`），不设绝对最大运行时长。如需启用，显式设置为正数毫秒值。
- 嵌套等待期活性上报：同步派发下级 agent 期间，父进程会持续经工具进度通道上报活性（子 agent 进度 + 静默期周期心跳），因此「中间层在等下级」不会被上游的活动超时误判为静默。活动超时语义不变：仍只看**直接子进程**的 stdout/stderr 是否真静默。
- 超时 kill 时结果中的 `stopReason` 为 `"activity_timeout"`（活动超时）或 `"hard_timeout"`（硬超时），会出现在诊断输出（`Stop reason: ...`）和 UI 徽标中，用于区分"超时被杀"与"子 agent 主动失败"。
- 收到 `AbortSignal` 时先发送 `SIGTERM`，5 秒后未退出则发送 `SIGKILL`；超时终止同样 SIGTERM 优先。异步模式下，用户可通过 `/subagent-cancel <taskId>` 或 `/subagent-cancel-all` 触发取消。
- 终止顺序：超时杀路径为 SIGTERM → 5000ms 宽限 → SIGKILL（与取消杀共用 `SIGTERM_GRACE_MS = 5000`）；finalize 延迟到进程退出后执行。
