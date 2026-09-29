---
description: Pause cleanly — shut down agents, decide on build/test verification, save state + memory, run drift-check, commit and (by default) push. "local" skips push; "land" runs CI checks, closes issues, and ships — ff-merging in solo mode, opening a PR in team mode. "after" waits for in-flight agents to finish first; "sleep" puts the Mac to sleep once the pause fully succeeds.
allowed-tools: Bash, Read, Write, Edit, Glob, Grep, SendMessage, AskUserQuestion
---
# /flow:pause

Stop work cleanly so it can be resumed with `/flow:continue`. The mechanics live in `${CLAUDE_PLUGIN_ROOT}/scripts/pause-helpers.sh`; this command only narrates and decides.

| Invocation | What happens |
|---|---|
| `/flow:pause` | save state + commit + push current branch |
| `/flow:pause local` | save state + commit, **no push** |
| `/flow:pause land` | save state + run CI checks + commit + push + close issues, then: **solo** — rebase onto the default branch, ff-merge, delete branch; **team** — open a PR |
| `/flow:pause after` | let running agents **finish** (no shutdown first), then pause with their results in the handoff (Step 2) |
| `/flow:pause sleep` | pause, then — only if every step succeeded — put the Mac to sleep after 30s (`sleep=<secs>` to change; Step 13) |

Flags are space-separated args. `local` and `land` are mutually exclusive (land implies push). `after` and `sleep` combine with either and with each other — `/flow:pause after sleep` is "finish this, save, and sleep" for walking away. `land` is the only mode that ships — it's where CI checks and issue closing apply; whether it ff-merges or opens a PR depends on `workflow_mode`. Every invocation decides whether to run build/test verification first, per `stop_check` (Step 4).

**Unattended** — with `after` or `sleep`, or when delegated from `/flow:autopilot` — nobody is at the keyboard:
- Never call `AskUserQuestion`; each step that would ask says its safe default.
- Anything the user must learn on return goes under `## Needs you` in `.flow/session-progress.md`, as `- ` bullets. The chat report is gone by the next session; that section is what `/flow:continue` shows first.
- A **refused land** (failing checks, nothing configured) still saves the work as a plain pause — but on the default branch with `--no-push`, so unverified code never reaches it. Off the default branch, push as usual.

## Step 1: Load config

Read `$CLAUDE_PROJECT_DIR/.flow/config.md`. Capture `workflow_mode`, `pm_backend` (+ `pm_*`), `memory_path`, `known_pitfalls_path`, `stop_check`. If the invocation is `land`, also capture `lint_cmd`, `typecheck_cmd`, `build_cmd`, `test_cmd`.

## Step 2: Shut down running agents

**With `after`, first run Step 2a.** Then: if background agents are running (or sitting idle, like `/flow:autopilot`'s teammates), send each a shutdown via `SendMessage` and wait up to 30s for them to flush their handoff files. See `${CLAUDE_PLUGIN_ROOT}/references/agent-workflow.md`.

### Step 2a: `after` only — wait for in-flight work

The point of `after` is that the work **completes** and the pause captures its result — so no fixed timeout: agents legitimately run for hours.

1. **Wait on** background agents and background shells expected to end (a build, a test run). **Never** the dev server or any other long-running server. If nothing qualifies, go straight to the shutdown above.
2. **Arm it**, so a compaction cannot lose it (a hook re-announces it at session start):
   ```bash
   "${CLAUDE_PLUGIN_ROOT}/scripts/pause-helpers.sh" pause-pending set <flags>   # e.g. after sleep
   ```
   `finish` clears it. On Step 3's fast-exit, run `pause-pending clear` yourself. A failed `finish` keeps it on purpose — that pause did not happen.
3. Print **one** line naming what you are waiting on, then stay quiet.
4. **Check-ins.** A hung agent never wakes you, so keep one timer: Bash with `run_in_background: true` and `exec sleep 1200` (~20 min). Only a timer firing is a check-in; re-arm it then, while anything is still running. An agent finishing is not a check-in — just write its result to a file (Step 9 names it), since the chat will not survive. Once the wait is over (item 7), any timer that still fires is stale: ignore it.
5. **Stuck ≠ slow.** At each check-in, note each item's output size (transcript, output file) in the marker file. An item whose output has not grown for **40+ minutes** is stuck; one still producing output is not. **Keep a stuck item's work:** ask the agent to write what it has to `$CLAUDE_PROJECT_DIR/.flow/salvaged/<name>.md` (or copy its last output there yourself, credentials redacted), stop waiting on it, and record it both as an open task and under `## Needs you`. For a stuck shell, record its command and last output lines. `.flow/salvaged/` is never committed and never swept.
6. An agent's question for the user goes into `.flow/questions.md` — it never blocks the pause.
7. When nothing is left to wait on, do the shutdown above, then Step 3.

## Step 3: Mechanical prep (shell, no LLM)

```bash
HELPERS="${CLAUDE_PLUGIN_ROOT}/scripts/pause-helpers.sh"
"$HELPERS" changed-files       # uncommitted paths
"$HELPERS" diff-since-pause    # commits since the last pause marker
"$HELPERS" read-marker         # for the report
"$HELPERS" drift-check         # heuristic doc-drift warnings (non-blocking)
```

**No-op fast-exit:** if `changed-files` is empty, `.flow/session-progress.md` has no open tasks, and nothing meaningful happened this session (results collected in Step 2a count as meaningful), print `Nothing to pause — working tree clean, no session state to save.` and stop. With `after`, clear the marker first; with `sleep`, still run Step 13.

## Step 4: Verification decision

This decision must never block the pause on a dialog — the user pausing is often the user leaving the computer. Resolve it from config and session context:

```bash
"$HELPERS" verification-mode    # ask | always | never
```

- **`always`** — run verification now (Step 4a), no prompt.
- **`never`** — skip, no prompt. Record `Verification: not run` for Step 9.
- **`ask` (default, incl. unset)** — the agent decides from what it already knows; no `AskUserQuestion`, ever:
  - **Fresh green run exists:** if `build_cmd`/`test_cmd` already ran green in this session and nothing changed since (no commits, no edits after that run), reuse it — record `Verification: passed (<what ran>, ran earlier this session, unchanged since)`. Applies to `land` too: re-running an identical suite proves nothing.
  - **Otherwise, plain `pause`/`pause local`:** skip, record `Verification: not run`. This is safe by design — `/flow:continue` surfaces any non-passed line on the next resume, and a checkpoint may legitimately save unverified WIP.
  - **Otherwise, `land`:** run verification now (Step 4a), no prompt — shipping wants a fresh green stamp.

  Users who want different behavior set it in config (`stop_check: always` / `never`), by hand or via `"$HELPERS" set-verification-mode <mode>`.

Unattended runs decide the same way — `ask` never prompts in any mode.

### Step 4a: Run verification (if the decision was to run it)

```bash
"$HELPERS" run-verification    # runs build_cmd + test_cmd; exits non-zero on failure
```

The first output line names what actually ran. Record it verbatim — never flatten it to a
bare "passed", because that is exactly how an unverified session gets filed as a verified one.

- **`verification-passed:build+test`** — record `Verification: passed (build+test)`. Continue.
- **`verification-passed:build`** (or `:test`) — only one was configured. Record
  `Verification: passed (build only, no test_cmd configured)`. Continue, but say the missing
  half out loud in the Step 12 report: a project shipping with no `test_cmd` should know it.
- **`verification-skipped:nothing-configured`** — neither `build_cmd` nor `test_cmd` is set,
  so **nothing ran**. This is not a pass. Record
  `Verification: skipped (no build_cmd or test_cmd configured)`.
  - Plain `pause`/`pause local`: continue, mention it once.
  - **`land`:** stop and ask. Shipping with no verification at all may be fine for a docs-only
    repo, but it must be a decision the user makes, not a green light they were handed. If
    they proceed, keep the `skipped` wording in the record — do not upgrade it to `passed`.
    **Unattended:** a refused land (see top) — record `land not run: no build_cmd or
    test_cmd configured` under `## Needs you`.
- **Fails:** report the failure concisely (which command, key error lines). Never silently pause on a failing build.
  - **Plain `pause`/`pause local`:** do not block on a question — pause anyway (a checkpoint may legitimately save broken WIP), record `Verification: failed (<build_cmd|test_cmd>)` for Step 9, and lead the Step 12 report with the failure so it's the first thing seen on return.
  - **`land`:** ask whether to fix now or abort landing — do not land on a failing build. If aborted, record `Verification: failed (<build_cmd|test_cmd>)` for Step 9 and stop before Step 9 (finish). **Unattended:** a refused land (see top) — record `land aborted: <cmd> failed` under `## Needs you`.

## Step 5: `land` only — run remaining CI checks

Run each non-empty command directly, from `$CLAUDE_PROJECT_DIR`, in order — `lint_cmd`, `typecheck_cmd` (build/test were handled by Step 4):

```bash
[ -n "$lint_cmd" ] && eval "$lint_cmd"
[ -n "$typecheck_cmd" ] && eval "$typecheck_cmd"
```

If either fails, stop. Report the failures to the user and ask whether to fix now or abort. Do not land on a failing lint/typecheck. **Unattended:** a refused land (see top) — record `land aborted: <cmd> failed` under `## Needs you`. Skip this step entirely for plain `/flow:pause` and `/flow:pause local` — those are checkpoints, not ships.

## Step 6: Narrate + memory candidates (main agent, silent)

The main agent holds the conversation; subagents don't — so do this directly, and do NOT print the narration in chat:

- **Body:** concrete bullets of what was done this session, cross-checked against `diff-since-pause`. Write to `$CLAUDE_PROJECT_DIR/.flow/pause-body` via the Write tool.
- **Title:** a one-line session title (no em-dashes). Write to `$CLAUDE_PROJECT_DIR/.flow/pause-title`.
- **Memory candidates** (only if `memory_path` is set): durable cross-session rules — architecture decisions, external-API gotchas, surprising findings. **Cap at 4.** Skip ephemeral single-file edits and anything already in memory.

## Step 7: Auto-save memory — do NOT ask

If `memory_path` is set and there are candidates: read its `MEMORY.md` index (small, one Read), dedup each candidate (`new` / `duplicate` / `extends`), then **write the memory files and update `MEMORY.md` directly**. Never gate this behind an approval question — work that was actually done is worth remembering; asking is pure friction. The only filter is relevance. Then:

```bash
"$HELPERS" save-memory "<memory_path>/MEMORY.md" <written-file>...
```

If `memory_path` is unset, skip memory entirely.

## Step 8: `land` only — update CLAUDE.md if structure changed

If new top-level directories, new commands, or new conventions were introduced this session, update `$CLAUDE_PROJECT_DIR/CLAUDE.md` to reflect them. Ask the user to confirm changes. **Unattended:** don't edit it; record `skipped: CLAUDE.md update — <what changed>` under `## Needs you`. Skip for plain `pause`/`pause local`.

## Step 9: Settle .flow/session-progress.md

Do this **before** the final commit, not after.

**Read `$CLAUDE_PROJECT_DIR/.flow/session-progress.md` first — always, even if you think you remember it.** After a long session or a compaction the file is no longer in context, and this step rewrites it wholesale. Every `- [ ]` in that file is carried forward verbatim unless this session actually completed it. Never reconstruct the task list from memory.

Then **rewrite the whole file with `Write`** (not `Edit`, never append). It holds **current state only** — exactly one Goal, one `Paused at`, one `Next steps`. What was *done* belongs in `.flow/session-log.md`, which Step 10 writes for you; duplicating it here is what grows the file until `/flow:continue` resumes from a stale block.

- **Goal accomplished and no open tasks remain** — regardless of `land`, `local`, or plain pause: clear the Goal, Paused at, and Next steps sections. The `finish` helper in Step 10 then deletes the file. A finished goal must not leave a resume file for `/flow:continue` to pick up, and a checkpoint pause is no less finished than a landed one.
- **Open tasks remain**: keep Goal and the open tasks, rewrite `Paused at` and `Next steps` to *this* pause. The helper keeps the file, and the next session resumes from exactly this state.

**Resume-ready is the contract.** The rewritten file must let a fresh session with **zero chat history** carry on — this is what every pause means, not an option. Whenever open tasks remain, it must hold:

- every open decision **with its options and your recommendation** — not just "decide X"
- every artifact produced but not yet delivered (drafts, generated files), **with its path** and whether it was sent. Paths must be durable: a file in a session scratchpad or `/tmp` is gone next session, so move it into the project (under `.flow/salvaged/`, always private, if it must not be committed) and record that path
- external state git cannot see — "draft saved in mailbox Y, not sent", "form submitted", "waiting on Z's reply"
- rules and preferences the user stated this session that the next session must obey
- the exact next 1–3 actions, in order, with anything time-bound flagged

**`## Needs you`** — `- ` bullets for anything the user must see on return and could not be asked about now: stuck agents (Step 2a), anything unattended mode skipped or refused, results of agents that finished during Step 2a (with the file holding each). Carry forward every existing entry this session did not resolve — `/flow:continue` only shows them, it never removes them; this rewrite is the one place they are dropped. Leave the section out when empty. The file is **kept** while it has entries, even if the goal is done.

**Self-check before Step 10:** *could a new session act on every open task using only this file and the paths it names?* If not, fix the file first.

Also write the verification outcome from Step 4/4a as its own line — one of `Verification: passed (build+test)`, `Verification: passed (<what ran>, ran earlier this session, unchanged since)`, `Verification: passed (build only, no test_cmd configured)`, `Verification: skipped (no build_cmd or test_cmd configured)`, `Verification: not run`, or `Verification: failed (test_cmd)`. `/flow:continue` surfaces anything that is not a clean pass on resume. Keep the qualifier: `passed (build only…)` and `skipped` must never be shortened to `passed`.

Questions chores (skip when `.flow/questions.md` is absent):
- Write the questions state line into session-progress.md (from `${CLAUDE_PLUGIN_ROOT}/scripts/questions-helpers.sh state-line ...`).
- AUDIT, never backfill: if `counts` reports `pending_apply > 0`, list those `Q<n>` ids loudly in the pause report — an answered question whose change never landed is a lost answer in the making.
- Retire questions whose `issue:` this pause just closed (`retired-because: issue closed`).

**`land`:** capture the file's current content now, before trimming — it lists the issues Step 10.5/11 close and drafts the team PR body, and the file may be gone by then.

## Step 10: One-shot finish (shell)

If `land` and there were prior `wip:` commits on this branch, first ask the user whether to keep them or squash interactively (do not auto-squash). **Unattended:** keep them.

```bash
"$HELPERS" finish "$CLAUDE_PROJECT_DIR/.flow/pause-title" "$CLAUDE_PROJECT_DIR/.flow/pause-body" "chore: <title>" $MODE_FLAG $CLOSE_ARG
```

- `$MODE_FLAG`: `--no-push` for `local`; for `land`, `--land` when `workflow_mode: solo` (ff-merge onto the default branch), **empty** when `workflow_mode: team` (push the feature branch only — Step 10.5 opens a PR instead of merging); empty otherwise. Never pass `--land` in team mode: the helper's `--land` path always rebases and ff-merges onto the default branch unconditionally, which would bypass review. A refused unattended land is a plain pause — `--no-push` if on the default branch.
- `$CLOSE_ARG` (only with `land`, and only if this branch closes exactly one issue): `--close "<token>"` where `<token>` is the backend's close keyword you construct from `pm_backend` — e.g. `Closes #42` (github/local) or `Closes ENG-7` (linear). The script never guesses tracker prefixes; you supply the exact token. If the session touched more than one issue, leave `$CLOSE_ARG` empty and close all of them explicitly in Step 11 instead — the commit-message trailer only auto-closes one.

If `finish` exits non-zero (staged secrets, a failing pre-commit hook), surface the error verbatim and don't retry — skip to Step 12. A `PUSH FAILED` / `LAND FAILED` line is a failure too, even though it exits 0: skip 10.5 and 11. With `after`, leave the marker: that pause did not happen, and `/flow:continue` will offer to re-run it.

## Step 10.5: `land` + `workflow_mode: team` only — open the PR

Solo mode already shipped via the ff-merge in Step 10 — skip this step entirely. In team mode, `finish` only pushed the feature branch; open the PR now:

```bash
gh pr create --title "<title>" --body-file - <<'EOF'
<PR body>
EOF
```

Draft the PR body from the `.flow/session-progress.md` content captured in Step 9 (Goal, what shipped, key decisions) plus the narration you wrote in Step 6 (`finish` has consumed the file by now), and one `Closes #<n>` line per issue worked this session, so they close when the PR merges. For a non-github `pm_backend`, use the backend's equivalent (e.g. note in the report that Linear/local tracking has no PR concept and the branch was pushed for manual review). Print the PR URL in the final report.

Then `git checkout <default> && git pull`, so the next session starts from the default branch instead of piling onto the PR'd one.

## Step 11: `land` + `workflow_mode: solo` only — close issues

In team mode, skip this step: the PR's `Closes` lines close them on merge.

Read the issues worked in this session from `.flow/session-progress.md` (captured before Step 9 trimmed it). For each one not already closed by the commit-message trailer in Step 10, close it explicitly using the commit `finish` reported (for a solo land, the hash in its `land: landed … at <sha>` line — rebasing changed it):

- **github**: `gh issue close <num> --comment "Resolved by <branch> / <commit-sha>"`
- **linear**: use the Linear MCP server to transition the issue to Done
- **local**: move the issue file from `issues/` to `issues/closed/`

Skip this step for plain `pause`/`pause local` — only `land` ships.

## Step 12: Report

Parse the `commit:` / `push:` / `land:` / `trim:` lines from `finish` and print a tight report (Goal, Progress, Verification, Memory n written, Commit, Push, Land if set, PR URL if `land` + team mode, Issues closed if `land`, Drift warnings if any, Questions pending-apply flagged if any (the `Q<n>` ids from Step 9's audit), Next step). Include drift-check warnings verbatim if it flagged anything — informational, non-blocking. If `## Needs you` has entries, list them right after any failure. Any failure leads the report.

**Unattended, anything failed in Steps 10–11** (finish, push, land, PR, an issue close): whether or not a commit was made, append it as a `- ` bullet under `## Needs you` in `.flow/session-progress.md` in the working tree — recreate the file with just that section if `finish` deleted it. `/flow:continue` reads the working tree; it needs no commit.

## Step 13: `sleep` only — put the Mac to sleep

This is the **last** action, after the report, never earlier. Run it only if the whole pause succeeded: verification did not fail (any mode), `finish`, if it ran, printed `finish-ok` with no `PUSH FAILED`/`LAND FAILED`, and — for `land` — it actually landed (`land: skipped (not on a feature branch)` is the normal solo result from the default branch, a success): lint/typecheck passed, the PR opened (team), every issue closed. A stuck agent whose work was salvaged does not block sleep — it is recorded under `## Needs you`. If anything failed, don't sleep: the user has to find the error on return, on an awake screen. Say `Not sleeping: <what failed>` as the report's last line.

On success:

1. Schedule it:
   ```bash
   "$HELPERS" schedule-sleep 30    # or the <secs> from sleep=<secs>, a whole number
   ```
   macOS only (`pmset sleepnow`); anywhere else it prints `sleep-skipped:not-macos` and does nothing — then stop here.
2. On `sleep-scheduled:…`, stop the dev server — nothing uses it while the machine sleeps: `"${CLAUDE_PLUGIN_ROOT}/scripts/continue-helpers.sh" dev-server-state` → on `running:<pid>`, `kill <pid>`.
3. Make the `sleep-scheduled:<secs>s pid=<pid> (cancel: kill <pid>)` line the report's last line, so the user can still cancel.
