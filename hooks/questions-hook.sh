#!/usr/bin/env bash
# questions-hook.sh — inject question-queue rules + live state into Claude's
# context. Plain stdout ONLY: for SessionStart and UserPromptSubmit, stdout
# reaches the model. systemMessage does NOT (user-only) — do not use it here.
# Always exit 0: this hook must never block a prompt.
set -u

MODE="${1:-}"
PROJECT_DIR="${CLAUDE_PROJECT_DIR:-$PWD}"
[ -d "$PROJECT_DIR/.flow" ] || exit 0
HELPERS="$(cd "$(dirname "${BASH_SOURCE[0]}")/../scripts" && pwd)/questions-helpers.sh"
Q="$PROJECT_DIR/.flow/questions.md"

STATE="$(bash "$HELPERS" state-line "$Q" 2>/dev/null || true)"
WIP="$(bash "$HELPERS" wip-limit 2>/dev/null || echo 3)"

case "$MODE" in
    session-start)
        echo "[flow question queue]"
        [ -n "$STATE" ] && echo "$STATE"
        cat <<EOF
Rules: (1) A question for the user is ASKED by first writing a Q-block to .flow/questions.md — status backlog, or open only if fewer than ${WIP} are open or the answer invalidates in-flight work. (2) Present ONE question at a time, two turns: briefing as final text ending the turn (single topic, plain words, any formatting) closing with a handoff line; the AskUserQuestion dialog opens next turn and restates the decision — NEVER briefing text and a dialog in the same message. (3) Record the user's answer in the file the same turn it is given; set applied: when the change lands ('-' if none needed). (4) Never re-ask an answered question. (5) Subagents never ask the user — their reports carry a "Questions raised" section; file those on receipt.
Full protocol: flow plugin references/question-protocol.md
EOF
        ;;
    prompt)
        # Only when there is something to act on — not an all-zero line on
        # every prompt.
        case "$STATE" in
            ''|'questions: 0 open · 0 backlog') ;;
            *UNPARSEABLE*) echo "$STATE" ;;
            *) echo "$STATE — new questions are filed in .flow/questions.md first" ;;
        esac
        ;;
esac

# A `/flow:pause after` can outlive a compaction (SessionStart "compact"). The
# marker is what tells the model it is still mid-pause.
if [ "$MODE" = "session-start" ] && [ -f "$PROJECT_DIR/.flow/state/pause-pending" ]; then
    echo "[flow] /flow:pause pending ($(head -1 "$PROJECT_DIR/.flow/state/pause-pending")). If this session started it, carry on at its Step 2a; otherwise /flow:continue will offer to re-run it."
fi
exit 0
