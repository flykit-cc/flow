# {PROJECT_NAME}

## What This Is

> One paragraph: what this project does, who it's for, and why it exists. Replace this with your own.

## Stack

> Languages, frameworks, key libraries, runtime targets. Keep it short — link out for details.

- Language: {LANGUAGE}
- Framework: {FRAMEWORK}
- Runtime: {RUNTIME}

## Structure

> Map the directories that matter here — the ones a newcomer would guess wrong.
> Skip the obvious ones. Delete this section if the layout is self-evident.

```
./
  .flow/
    config.md           workflow + stack commands (read by /flow:*)
    local.md            machine-local overrides, never committed
  CLAUDE.md             this file
```

## Commands

The exact commands live in `.flow/config.md`. Use those, not hardcoded scripts.

| What | Field in `.flow/config.md` |
|------|------------------------------|
| Start dev | `dev_cmd` |
| Lint | `lint_cmd` |
| Typecheck | `typecheck_cmd` |
| Build | `build_cmd` |
| Test | `test_cmd` |
| Format | `format_cmd` |

If a command is missing, run `/flow:init` to set it.

## Key Patterns

> How this codebase prefers to do things. Add to this section as patterns emerge — each one saves a round of code review.

- (empty — fill in as you go)

## Coding Principles

- **Einstein** — make it as simple as possible, but no simpler.
- **DRY** — three uses, then extract. Two uses is a coincidence.
- **Boring is good** — prefer the well-known solution unless the problem is genuinely novel.
- **Comments explain why, not what** — if the code needs a comment to explain what it does, rewrite it.
- **Small functions, small files** — if it doesn't fit on one screen, split it.

## flow plugin

The `/flow:*` commands and agents are documented in the flow plugin's README.

## Known Pitfalls

> Patterns this codebase has been bitten by. Reviewers and `/flow:audit` check against these.
> Append to this list whenever `/flow:deep-review` surfaces a recurring issue.

- (empty — fill in as the team learns)
