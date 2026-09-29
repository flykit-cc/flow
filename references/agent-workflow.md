# Agent workflow

How the `flow` plugin's agents coordinate. Read this before changing how commands spawn agents.

## The orchestrator pattern

The main Claude Code session is the **orchestrator**. It does not write code. It reads context, picks the right agent for the current phase, hands off, and decides what to do with the result.

Agents do the work. Each agent is narrow: it has one job, a self-contained brief, and one report. This keeps token budgets predictable and makes failures localized.

If you find the main agent editing source files directly, something has gone wrong — push the work into a `general-purpose` agent.

## The agent roster

`flow` ships exactly one custom agent — `reviewer` — plus the built-in agents and skills that
ship with Claude Code. Prefer the built-ins; only a custom agent definition is worth the
maintenance cost, and `reviewer`'s domain-specific checklist (BREAKS/SECURITY/MINOR, plan
adherence) earns its keep.

| Agent / skill | Input | Output | Owns |
|-------|-------|--------|------|
| `Explore` (built-in) | issue or task description, or a search query | inline report | reading code, mapping dependencies, locating symbols/patterns |
| `superpowers:writing-plans` (skill) | an investigation / requirements | a written plan | turning facts into a stepwise plan with file-level changes |
| `general-purpose` (built-in) | a plan (or a finding list) | edits on disk | implementation, including small refactors needed to land cleanly |
| `reviewer` (flow) | a diff range + file list | a returned report (the orchestrator saves it to `.flow/session/review-<bucket>.md`) | classifying findings as BREAKS / SECURITY / MINOR |
| `WebSearch` (built-in tool) | a question | inline synthesis | external docs, library references, RFCs |

CI checks (lint/typecheck/build/test) and issue filing are no longer separate agents — they're
inline steps in the commands that need them (`/flow:pause land`, `/flow:audit`), reading the
commands straight from `config.md`.

## Handoff via files

Handoffs live as files in `.flow/session/`. Agents that can write save their own; read-only agents (Explore, reviewer) return their report and the orchestrator saves it.

Why files: agents are spawned as separate `Agent` tool calls. The orchestrator is the only thing that persists between phases. Files are the lowest-friction handoff that survives an agent finishing.

Convention:

- One file per phase
- Markdown with a clear top-level structure (each agent's prompt enforces it)
- A handoff is spent once its phase lands. `/flow:continue` runs `continue-helpers.sh sweep-handoffs`, which moves every file older than `state/last-pause` (everything, with no marker) into `.flow/session/spent/` — never trust a handoff without that sweep; the helper's comment says why.

## Deterministic helper layer

Commands push their *mechanics* into shell helpers under `${CLAUDE_PLUGIN_ROOT}/scripts/` so the LLM only narrates and decides. Each helper is a black-box CLI with subcommands that print results to stdout — no tokens spent on git plumbing.

- `pause-helpers.sh` — `changed-files`, `diff-since-pause`, `write-marker`/`read-marker`, `log-block`, `trim-or-delete-progress`, `drift-check`, `save-memory`, `finish`. Used by `/flow:pause` (all modes, including `land`).
- `continue-helpers.sh` — `check-progress`, `sweep-handoffs`, `progress-age-days`, `last-log-titles`, `dev-server-state`, `deps-ok`. Used by `/flow:continue`.
- `issue-helpers.sh` — `version-check`, `dupe-search`. Used by `/flow:issue`. Deliberately depends on nothing under `.flow/`: the command must work when flow itself is misbehaving.
- `lib.sh` — sourced by the helpers *and* the hooks; the single place that parses `.flow/config.md` (`flow_extract`, `flow_secret_globs`, `flow_private_globs`, `flow_memory_path`, …). Everything stack-specific is read here, never hardcoded.

These helpers also touch a few session-state files, all under `.flow/`: `session-log.md` (append-only dated blocks) and `state/last-pause` (the pause marker).

## Shutdown

The orchestrator shuts an agent down via `SendMessage` the moment it reports — this is how `/flow:autopilot` keeps the team lean. `/flow:pause` does the same for anything still running and waits up to 30 seconds.

> Note for autopilot: do NOT use `TeamCreate` / `TeamDelete` / `TaskCreate` / `TaskUpdate` to manage agents. They write to `~/.claude/` and reset `bypassPermissions`, which breaks `mode: "auto"` autonomy. Spawn agents directly with the `Agent` tool and shut them down with `SendMessage`.

## File ownership for parallel implementers

In Agent Team mode (and in `/flow:autopilot`), multiple `general-purpose` agents run in parallel. The hard rule: **each one owns a disjoint set of files**.

The orchestrator partitions the planned changes by file and assigns each set to one agent. No two agents may write the same file. If the plan can't be partitioned this way (e.g. a single large file needs many changes), fall back to a single agent for that file.

This rule replaces the need for any locking or merge logic. If two agents want to edit the same file, the partition was wrong — re-plan.

## Errors

An agent that fails twice on the same input: file it as a question or ticket and don't retry again — the input is wrong, not the agent. Never `AskUserQuestion` about it directly.

## Questions raised (mandatory report section)

Subagents can never reach the user: no dialogs, no prompts. Every agent
prompt you dispatch must instruct: "If you hit a decision only the user can
make, do NOT guess silently and do NOT try to ask — put it in a final
`## Questions raised` section (empty section if none) and, where possible,
proceed on the most reversible assumption, marking it." On receipt, the main
loop files each raised question into `.flow/questions.md` (status backlog by
default) per `references/question-protocol.md`, then presents per queue rules.
