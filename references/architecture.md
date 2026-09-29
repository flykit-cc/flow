# Architecture: how the plugin and your project layer together

The `flow` plugin is a **workflow backbone**. It does not know your stack. Your project's `.flow/` directory tells it everything stack-specific.

## The two layers

```
~/.claude/plugins/flow/             (the plugin — this repo)
  commands/                          slash commands (/flow:*)
  agents/                            agent definitions
  hooks/                             optional lifecycle hooks
  references/                        docs loaded on demand
  scripts/                           helper scripts called via ${CLAUDE_PLUGIN_ROOT}

<your-project>/.flow/                (written by /flow:init, removed by /flow:uninstall)
  config.md                          workflow + stack commands — SHAREABLE, commit it
  local.md                           machine-local overrides
  session-progress.md                CURRENT STATE ONLY — one Goal, one Paused at, one
                                     Next steps. Created by /flow:continue (cold start),
                                     rewritten whole (never appended) by /flow:pause in
                                     every mode — deleted once the goal is met with no
                                     open tasks, kept while tasks remain. History lives
                                     in session-log.md, never here.
  session-log.md                     dated session blocks, newest first (written by
                                     /flow:pause, all modes) — the only history file
  questions.md                       WIP-limited open-question queue (question-protocol.md)
  session/                           agent handoffs, one file per phase. Spent once the
                                     phase lands; /flow:continue drops anything older
                                     than state/last-pause instead of reading it
  session/spent/                     handoffs swept out of session/ by /flow:continue
  pause-title, pause-body            this pause's narration, consumed by `finish` —
                                     transient, never present between sessions
  state/last-pause                   pause marker (HEAD/branch/timestamp); also the
                                     freshness boundary for session/ handoffs
  state/pause-pending                a requested pause that has not completed yet;
                                     cleared by `finish`, surfaced by /flow:continue
  salvaged/                          a stuck agent's work, saved by /flow:pause; never
                                     swept, removed by /flow:uninstall only with --purge

<your-project>/
  CLAUDE.md                          yours. Seeded from the template only when absent;
                                     an existing one is never touched
  .claude/settings.json              Claude Code settings, hooks, MCP servers — flow
                                     does NOT manage this file
  issues/                            only when pm_backend = local
```

`.flow/config.md` is deliberately **shareable project truth** and the only file under `.flow/` that is ever committed: collaborators get the same stack setup. Everything else under `.flow/` is session state or machine-local, and private — `/flow:pause` never stages it. Durable cross-session memory lives outside the repo at `memory_path` (see config-template.md).

## Who owns what

**Plugin owns:**

- The set of commands (`/flow:init`, `/flow:continue`, etc.)
- The agent roster and how they hand off
- The templates for `config.md` and `CLAUDE.md`
- The handoff convention (`.flow/session/*.md`)

**Your project owns:**

- The actual values in `config.md` (which dev/lint/test commands to run)
- Whether to wire optional hooks and which
- Which MCP servers to configure
- The contents of `CLAUDE.md` (the template is a starting point, not the truth)
- The `Known Pitfalls` list — append-only, grown over time

The plugin reads from your project. Your project does not reach into the plugin. If you find yourself wanting to fork the plugin to change a command, first ask whether the change belongs in `config.md` or `settings.json` instead.

## Why `.flow/config.md` and not `.claude/settings.json`?

`settings.json` is owned by Claude Code itself — hooks, permissions, MCP servers, env vars. It has a strict schema.

`config.md` is owned by this plugin and is intentionally markdown so:

- Humans edit it without worrying about JSON syntax
- It can carry inline comments and explanations
- Values are descriptive (commands like `npm run build`) where JSON would feel cramped

Two files, two owners, no schema collision.

## Why `CLAUDE.md` lives at the project root

Claude Code reads `CLAUDE.md` from the project root automatically on every session. Putting it under `.claude/` would hide it. Some projects also keep a top-level `README.md` for humans and a `CLAUDE.md` for the AI — that's fine; they serve different audiences.

## Updating the plugin

Plugin updates ship via the marketplace. Your project's `.flow/config.md` and `CLAUDE.md` are unaffected — they are yours: `/flow:init` never overwrites a file that exists, and `/flow:uninstall` never touches `CLAUDE.md`.

The flip side: because nothing is overwritten, **a template change in a plugin update does not reach a project that was already initialised**. Re-running `/flow:init` will report `already exists, skipping` and change nothing. To adopt a new template, run `/flow:uninstall` first (it asks before dropping session state), then `/flow:init` again — and expect to re-apply any hand edits to `config.md`.
