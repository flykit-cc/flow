# Question protocol

Rules for `.flow/questions.md` — the WIP-limited question queue. Read this
before asking the user anything, filing a question from an agent report, or
touching `/flow:continue`, `/flow:pause`, `/flow:questions`.

Compact state and a stub of these rules are injected every session via the
SessionStart/UserPromptSubmit hooks (plain stdout, never `systemMessage` —
the hook must reach Claude's context, not just the user's screen). This file
is the full version those hooks point to.

## File format

One block per question in `.flow/questions.md`:

```
## Q<n>
status: open | backlog | answered | assumed | retired
issue: #<gh-issue> | -
asks: <the question, one line>
context: <what's stuck / why this matters — may be several lines;
  continuation lines MUST be indented two spaces>
options: <A: consequence; B: consequence>       (optional)
recommendation: <option + why in one clause>     (optional)
answer: <the user's answer, verbatim-ish>        (filled when answered)
applied: <commit-hash | file-path | spec-updated | ->  (proof the answer landed;
  `-` = answer required no change (valid, not flagged); EMPTY = not yet
  applied — flagged loudly by /flow:pause)
retired-because: <one line>                      (only for retired)
```

- IDs are monotonic (`Q1, Q2, …`), never reused.
- Blank lines are always allowed, anywhere in the file.
- Continuation lines (e.g. a multi-line `context:`) MUST be indented two
  spaces — that's what keeps counting dumb: any unindented line is always
  either a known key, a `## Q<n>` header, or blank, never free text.
- Counting is `grep -c '^status: open'`.
- `applied: -` means the answer required no code/doc change — valid and
  terminal, never flagged. Empty or missing `applied:` on an `answered`
  block means not yet applied — flagged loudly by `/flow:pause`.
- **Write timing:** `answer:` is written the same turn the user gives it —
  never batched to pause time (a crash must not eat a given answer).
  `applied:` is set the moment the change lands (commit hash, file path, or
  `spec-updated`). `/flow:pause` only audits these two fields; it never
  backfills them.
- **Fail loud:** any unindented line that isn't a known key, a `## Q<n>`
  header, or blank makes the whole file UNPARSEABLE. Every hook and command
  touchpoint must emit `questions.md UNPARSEABLE — queue unreliable, fix
  .flow/questions.md` instead of exiting quietly or guessing a count. Broken
  must never look like fine.
- The file is private: only `.flow/config.md` is ever committed.

## Queue rules

- **WIP limit:** at most `question_wip` blocks may have `status: open` at
  once. Config key lives in `.flow/config.md`, default **3**.
- **Entry:** a new question always enters as `backlog` — unless a WIP slot
  is free (opens directly) or answering it would invalidate work in
  progress right now (jumps the queue; the open question it displaces
  returns to the top of backlog).
- **Promotion:** when an open question is answered or retired, promote the
  highest-priority backlog question. Priority order: architecture forks >
  only-user-knows facts > scope.
- **Taste questions are never asked.** Claude decides, records `status:
  assumed`; the user can override any time by editing the file or just
  saying so.
- **Never re-ask.** Check the file before asking anything — `answered` is
  settled unless the user reopens it.
- **Retirement:** a question whose issue closed or whose premise died is
  set to `retired` with `retired-because`. Happens at flow touchpoints
  (`continue`, `pause`, `questions` command) — never live, mid-work.
- **One on screen:** regardless of how many questions are open, show the
  user exactly one dialog at a time.
- **All blocked:** if every workable thread is blocked on open questions,
  stop and say exactly: "All remaining work waits on these N answers."

## Presenting a question

Text emitted in the same assistant message as a following tool call may
never render in the Claude Code UI. A dialog preceded by "briefing" text in
one message can arrive naked — the briefing exists only in the session log,
never on screen. Design around this, never against it.

**One dialog, nothing to read before it.** The dialog carries the whole
briefing, so the user reads and answers in one place, in one turn:

- `question` field: the context and the decision in 1–3 plain sentences,
  with its `Q<n>` id so the file can be cross-checked.
- Each option's `description`: that option's concrete consequence.
- Default: no `preview`. That gives the list style, a paragraph under each
  option. Use `preview` only when the decision needs a long briefing, a
  comparison table or a mockup; any `preview` switches the dialog to a
  side-by-side box. Then the recommended option's `preview` holds the full
  briefing, single topic, no jargon; other options' `preview`: what differs.
- Recommended option listed first, suffixed "(Recommended)".

No briefing turn and no "reply anything" handoff line. Text in the same
message before the dialog is allowed only if losing it costs nothing.

**Nothing is lost when the dialog closes:** the block in `questions.md`
already holds the briefing (`context:`, `options:`, `recommendation:`), and
the reply after the answer opens with one line naming what was picked.

If the user dismisses the dialog or answers in free text, record that
answer per the write-timing rule; never re-open the same dialog unasked.

## Subagents

- Subagents run in the background and cannot reach the user; hooks don't
  fire inside them. **Subagents never ask the user** — dispatch templates
  (`agent-workflow.md`, `agents/reviewer.md`) state this explicitly.
- Every agent report includes a **"Questions raised"** section (empty is
  fine; omitting the section is not).
- The main loop files whatever's in that section into `questions.md` on
  receipt — `backlog` by default — then presents per the Queue rules above.
- **Unattended modes (`/flow:autopilot`) file only, never present.**
  Autopilot bans `AskUserQuestion` after launch and has no one to brief;
  filed questions wait for the next interactive session.

## Chores

- **`/flow:continue`:** recap line ("Questions: 2 open · 5 answered · 4
  assumed"); retire questions whose issues closed
  meanwhile. If open questions exist, the recap turn ends with the top
  question's dialog, with the recap in its `question` field — or in the
  recommended option's `preview` only when the recap is long (see
  Presenting a question — no text before the dialog).
- **`/flow:pause`:** update the questions line in `session-progress.md`;
  flag any `answered` block with empty `applied:` loudly; retire questions
  whose issues it closes.
- **`/flow:questions`:** answer a round now (up to `question_wip` dialogs,
  one at a time); list the queue; reopen an answered question; retire or
  edit entries conversationally.
