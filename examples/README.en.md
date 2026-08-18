<div align="right"><a href="README.md">中文</a></div>

# Examples

`examples/pi/` mirrors `~/.pi/agent/`. Copy it to your user directory so `pi` can discover these agents and skills.

> Install the extension first with `pi install npm:@wolido/async-subagent-isolation`.
>
> **v1.2.0 note**: the `subagent` tool's `action="status"` has been removed as a cleanup. In-flight task information is now provided by the `[subagent-result]` notification envelope's in-flight block.

## Directory structure

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

### Subagents (`agents/`)

| Agent | Purpose | Tools | Skill |
|-------|---------|-------|-------|
| `coder` | Write, modify, and validate code | `read, write, edit, bash, grep, find, ls` | `systematic-debugging` |
| `reviewer` | Read-only review with actionable feedback | `read, grep, find, ls` | _(none)_ |
| `writer` | Write docs, READMEs, commit messages, PR descriptions | `read, write, edit, grep, find, ls` | `writing-clearly-and-concisely` |

Subagents load skills via the `skills:` frontmatter field. `coder` uses `systematic-debugging` to find root causes before fixing, `writer` uses `writing-clearly-and-concisely` to refine prose, and `reviewer` uses no skill, showing that the field is optional.

### Main agent (`master.md`)

`master.md` is the main agent system prompt. It understands requests, splits tasks, and delegates to subagents. Load it with `--append-system-prompt`, for example:

```bash
pi --append-system-prompt ~/.pi/agent/master.md --skill ~/.pi/agent/skills/brainstorming/
```

### Install agents

```bash
mkdir -p ~/.pi/agent/agents
cp examples/pi/agent/agents/*.md ~/.pi/agent/agents/
cp examples/pi/agent/master.md ~/.pi/agent/master.md
```

You can also place them in a project-level `.pi/agents/` directory so they only apply to the current repository.

## Per-subagent model configuration (`subagent-isolation.json`)

[`subagent-isolation.json`](pi/agent/subagent-isolation.json) is a model-configuration example: all subagent `model`/`thinking` overrides live in one file. JSON has no comments, so the field semantics are explained in the table below.

Copy it to `~/.pi/agent/subagent-isolation.json` (user level) or `.pi/subagent-isolation.json` (project level, which overrides user-level keys of the same name):

```bash
cp examples/pi/agent/subagent-isolation.json ~/.pi/agent/
```

| Field | Semantics |
|-------|-----------|
| `$models` | Optional. Available-model list; `/subagent-config` picks models from it when editing `model`, falling back to free-text input when empty or unconfigured. A valid project-level `$models` shadows the user-level list wholesale; `[]` blanks it explicitly |
| `"coder": { "model": ..., "thinking": ... }` | Object format with both fields set. `thinking` takes one of pi's 7 official levels: `off` / `minimal` / `low` / `medium` / `high` / `xhigh` / `max` |
| `"writer": "deepseek/deepseek-v4-flash"` | Legacy string format, equivalent to `{ "model": "deepseek/deepseek-v4-flash" }`, sets only the model |
| `"reviewer": { "thinking": "low" }` | Object with only `thinking` set, demonstrating field-level fallback: unset fields inside an entry fall back to frontmatter |

Priority chain, highest first: process memory (`/subagent-config` writing to `this process` — nothing on disk, gone when the process exits or on `/reload`) > project JSON > user JSON > frontmatter. A field set in JSON shadows the same frontmatter field; file levels merge by whole key — when a project entry exists it shadows the user entry of the same key entirely, while unset fields inside the entry still fall back to frontmatter.

No hand-editing required: `/subagent-config` edits `model`/`thinking` and the `$models` list interactively and writes them back.

## Skills (`skills/`)

| Skill | Used by | Description |
|-------|---------|-------------|
| [`brainstorming`](pi/agent/skills/brainstorming/SKILL.md) | Main agent | Turn ideas into fully formed designs through collaborative dialogue |
| [`systematic-debugging`](pi/agent/skills/systematic-debugging/SKILL.md) | `coder` | Find root cause before attempting any fix (4-phase process) |
| [`writing-clearly-and-concisely`](pi/agent/skills/writing-clearly-and-concisely/SKILL.md) | `writer` | Refine prose with clarity rules, AI-pattern detection, and voice injection |

Install:

```bash
mkdir -p ~/.pi/agent/skills
cp -r examples/pi/agent/skills/brainstorming ~/.pi/agent/skills/
cp -r examples/pi/agent/skills/systematic-debugging ~/.pi/agent/skills/
cp -r examples/pi/agent/skills/writing-clearly-and-concisely ~/.pi/agent/skills/
```

Skills are discovered from `~/.pi/agent/skills/` (user scope) or `.pi/skills/` (project scope). Subagents auto-load skills declared in their frontmatter; the main agent can load one via `--skill`:

```bash
pi --skill ~/.pi/agent/skills/brainstorming/
```

## Calling subagents

Once installed, invoke a subagent through the `subagent` tool:

```json
{
  "agent": "coder",
  "task": "Refactor the auth middleware to use async/await."
}
```

```json
{
  "agent": "reviewer",
  "task": "Review the changes in src/auth.ts for correctness and clarity."
}
```

```json
{
  "agent": "writer",
  "task": "Write a concise PR description for the auth middleware refactor."
}
```
