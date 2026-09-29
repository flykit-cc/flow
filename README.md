# flow

A Claude Code plugin that turns ad-hoc coding sessions into a disciplined, multi-agent workflow: investigate, plan, implement, review, ship.

## Install

```
/plugin marketplace add flykit-cc/plugins
/plugin install flow@flykit
```

Then, inside any project:

```
/flow:init
```

This creates `.flow/config.md` (project-level config) and `CLAUDE.md` (project memory) from templates, plus an `issues/` directory for the local PM backend. Your dev/lint/test/build commands are filled in for you: detected from whichever manifest declares them, and where none does — a script-style repo with a venv and a `tests/` directory, say — inferred from the repo and verified by running them. You are not handed a config file to complete by hand.

## Commands

| Command              | Purpose                                                                 |
| -------------------- | ----------------------------------------------------------------------- |
| `/flow:init`         | One-time setup. Drops config and memory templates into the project.     |
| `/flow:uninstall`    | Remove what `init` created, so you can start clean or re-init. Dry-run by default. |
| `/flow:continue`     | Resume an in-progress session from `.flow/session-progress.md`, or start a new one if none exists. |
| `/flow:questions`    | Work the open-question queue in `.flow/questions.md` — answer a round, list it, reopen or retire an entry. |
| `/flow:status`       | Read-only "where am I / what's running / what next" — git state, in-flight agents, PR/CI. Changes nothing. |
| `/flow:issue`        | Report a flow bug or feature request from any project; checks your version first, never posts without showing you the body. |
| `/flow:pause`        | Snapshot current state to `.flow/session-progress.md`; `land` also ships — CI checks, issue closing, then ff-merge (solo) or a PR (team); `after` lets running agents finish first; `sleep` puts the Mac to sleep once it succeeds. |
| `/flow:audit`        | Scan for smells, security holes, stale docs, and dead code; file the findings you pick as issues. |
| `/flow:cleanup`      | Run `format_cmd` and `lint_cmd` with auto-fix; report what remains.     |
| `/flow:health`       | Inspect the project's flow setup and report missing pieces (and fill in any blank `*_cmd`). |
| `/flow:deep-review`  | Spawn the reviewer agent with extra rigor on the working diff.          |
| `/flow:flawz`        | Pressure-test a plan/spec/design for real flaws before you act on it.   |
| `/flow:autopilot`    | Autonomous multi-sprint loop: agent team, deep-review, push, repeat.    |

## Agents

`flow` ships one custom agent; everything else routes through Claude Code's built-ins.

| Agent / skill                  | Role                                                                   |
| ------------------------------ | ----------------------------------------------------------------------- |
| `reviewer` (flow)              | Review the diff: BREAKS / SECURITY / MINOR. Plan-adherence check.      |
| `Explore` (built-in)           | Trace a problem to its root cause, or search the codebase.             |
| `general-purpose` (built-in)   | Execute a plan exactly. No scope creep.                                |
| `superpowers:writing-plans`    | Turn an investigation into a precise, ordered implementation plan.     |
| `WebSearch` (built-in tool)    | External research with cited sources.                                  |

Agents hand off through files in `.flow/session/` (e.g. `investigation.md`, `plan.md`); read-only agents return a report the orchestrator saves. Each is spawned with no conversation history — its instructions are self-contained. CI checks and issue filing are inline steps in the commands that need them, not separate agents.

## How `config.md` works

`flow` reads project-specific settings from `$CLAUDE_PROJECT_DIR/.flow/config.md`. Fields:

| Field                  | Purpose                                                |
| ---------------------- | ------------------------------------------------------ |
| `workflow_mode`        | `solo` or `team`                                       |
| `pm_backend`           | `github`, `linear`, or `local`                         |
| `pm_github_owner`      | GitHub org/user (if `pm_backend: github`)              |
| `pm_github_repo`       | GitHub repo name                                       |
| `pm_linear_team`       | Linear team key (if `pm_backend: linear`)              |
| `dev_cmd`              | Project's dev/server command                           |
| `lint_cmd`             | Linter command                                         |
| `typecheck_cmd`        | Type-checker command                                   |
| `build_cmd`            | Build command                                          |
| `test_cmd`             | Test command                                           |
| `format_cmd`           | Formatter command                                      |
| `known_pitfalls_path`  | Path (relative to project root) to a pitfalls doc      |
| `dev_port`             | Dev server port (lets `/flow:continue` detect a running server) |
| `memory_path`          | Cross-session memory dir (`/flow:pause` auto-saves here) |
| `stop_check`           | Pause-time build/test verification: `ask` (default), `always`, `never` |
| `private_globs`        | Extra paths `/flow:pause` never commits (default `.claude docs/superpowers`) |
| `secret_globs`         | Space-separated globs for files the hooks must never read/write/commit |
| `question_wip`         | Max questions open at once in `.flow/questions.md` (default 3) |
| `schema_glob` / `docs_glob` / `route_pattern` | Optional drift-check heuristics tuning |

Hooks and helper scripts read these values. Nothing is hardcoded — `flow` adapts to your stack. See `references/config-template.md` for the full annotated template, and `references/stack-command-inference.md` for how the `*_cmd` values get worked out when no manifest declares them.

### What gets committed

`.flow/config.md` is shareable project truth and the only file under `.flow/` that flow ever commits. Everything else under `.flow/` — `local.md`, the session files, `state/`, `session/`, `salvaged/` — is private: `/flow:pause` never stages it. `private_globs` adds more private paths (default `.claude docs/superpowers`).

## Hooks

| Hook                | When                       | What                                                                  |
| ------------------- | -------------------------- | --------------------------------------------------------------------- |
| `session-context`   | UserPromptSubmit           | Surfaces branch + dirty file count + current goal.                    |
| `questions-hook`    | SessionStart, UserPromptSubmit | Injects the question-queue's rules at session start, and its open/backlog counts on a prompt when anything is pending. |
| `auto-lint`         | PostToolUse (Write/Edit)   | Runs `format_cmd` + `lint_cmd` on the touched file.                   |
| `file-protection`   | PreToolUse (Write/Edit)    | Blocks writes to env files, lockfiles, `.git/`, and `secret_globs`.   |
| `secret-guard`      | PreToolUse (Read/Bash)     | Blocks reading secret files via the Read tool or shell `cat`/`grep`.  |

Most hooks fail open when `.flow/config.md` is missing, so `flow` is safe to install even before you run `/flow:init`.

Gating expensive or destructive commands (deploys, `terraform apply`, `rm -rf`, ...) is handled by Claude Code's native `permissions.ask`, not a flow hook — see "Approval for costly or destructive commands" in `SETUP.md`.

The lifecycle commands push their mechanics into deterministic shell helpers under `scripts/` (`pause-helpers.sh`, `continue-helpers.sh`, sharing `lib.sh` for config parsing), so the LLM only narrates and decides. `/flow:pause` auto-saves cross-session memory (when `memory_path` is set) and runs a non-blocking doc `drift-check`. Every invocation ends a session through the same `finish` helper: it writes the session's block to `.flow/session-log.md`, consumes the narration files so a later pause can never relog them under a new date, then deletes `.flow/session-progress.md` only when nothing is left in flight (open tasks, or a `## Needs you` entry left by an unattended pause, keep the file, so the next session resumes them). `land` additionally runs CI checks, closes issues, and rebases + ff-merges onto the default branch (solo) or opens a PR (team).

The two session files have strictly separate jobs: `session-log.md` is the dated history, appended to forever; `session-progress.md` holds **current state only** — one Goal, one `Paused at`, one `Next steps` — and is rewritten whole by every pause rather than appended to. `/flow:continue` verifies that on resume (`check-progress` flags a file carrying more than one Goal or `Paused at`) and trims it back, so a progress file cannot quietly grow into a log that buries the newest state. It applies the same freshness rule to agent handoffs: `sweep-handoffs` moves anything in `.flow/session/` older than the last pause into `.flow/session/spent/`, so a previous session's `plan.md` is never mistaken for the current one.

## Question queue

`.flow/questions.md` holds questions that need the user's input, so they survive session boundaries instead of being asked once and forgotten. At most `question_wip` (default 3) can be `open` at a time; the rest wait in `backlog` and get promoted as open questions are answered or retired. `/flow:questions` works the queue — answer a round (one dialog at a time), list it, reopen or retire an entry. The `questions-hook` injects the queue's rules at session start and its counts on any prompt while something is pending, so Claude knows what's waiting without re-reading the file. Subagents never ask the user directly; their reports carry a "Questions raised" section that gets filed into the queue when the report comes back. `/flow:continue` and `/flow:pause` retire questions whose issues have closed. Full contract: `references/question-protocol.md`.

## Learn more

- [SETUP.md](./SETUP.md) — post-install walkthrough and troubleshooting.
- `references/` — deeper docs (loaded on demand by commands).

## License

MIT — see repo root.
