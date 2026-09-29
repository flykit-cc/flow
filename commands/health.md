---
description: Verify your workflow setup — config, hooks, required commands, PM backend connectivity.
allowed-tools: Bash, Read, Edit, Glob, Grep
---
# /flow:health

Sanity check. Run this after `/flow:init` and any time `/flow:*` commands feel broken.

Diagnostic, not a repair tool: report what is wrong and where the fix is, and change nothing —
with one exception, a blank `*_cmd` in config.md, which you fill in yourself (Check 1).

## Checks

Run each check and collect the result. Print a table at the end.

### 1. Config file

- Does `$CLAUDE_PROJECT_DIR/.flow/config.md` exist?
- Does it parse? (frontmatter or key:value lines as defined in the template)
- Are required fields present: `workflow_mode`, `pm_backend`, `dev_cmd`, `lint_cmd`, `build_cmd`, `test_cmd`?

A blank `*_cmd` is yours to fill per `${CLAUDE_PLUGIN_ROOT}/references/stack-command-inference.md`;
report it as `FIXED` with the command you wrote, or `OK` when the project has no such step.

### 2. CLAUDE.md freshness

- Does `$CLAUDE_PROJECT_DIR/CLAUDE.md` exist?
- Last committed more than 90 days ago (`git log -1 --format=%cr -- CLAUDE.md`)? Flag as stale.
- Does it reference commands or paths that no longer exist? Spot-check the Stack and Structure sections.

### 3. Hook wiring

flow's hooks are wired by the plugin itself, in `${CLAUDE_PLUGIN_ROOT}/hooks/hooks.json` — not
in the project's settings. Check that file is valid JSON and every script it runs parses:

```bash
H="${CLAUDE_PLUGIN_ROOT}/hooks"
jq empty "$H/hooks.json" || echo "hooks.json: INVALID"
for f in $(grep -o 'hooks/[a-z-]*\.sh' "$H/hooks.json" | sort -u); do
  bash -n "${CLAUDE_PLUGIN_ROOT}/$f" || echo "$f: SYNTAX ERROR"
done
```

Any flow hook (a `${CLAUDE_PLUGIN_ROOT}/hooks/…` or flow script path) found in
`$CLAUDE_PROJECT_DIR/.claude/settings.json` is a stale leftover from an older flow version:
flag it for the user to remove by hand.

### 4. Required commands

For each non-empty `*_cmd` in config.md, take the first token and check it is on `PATH` (`command -v <token>`). Report missing.

Also check `jq` specifically — it is not a `*_cmd`, so the loop above misses it:

```bash
command -v jq >/dev/null 2>&1 && echo "jq: ok" || echo "jq: MISSING"
```

If it is missing, report it as a **failure, not a warning**, and say plainly what it costs: all three hooks (`secret-guard`, `file-protection`, `auto-lint`) exit early without it, so secret-read blocking, write protection, and auto-lint are **silently disabled**. Nothing else in flow surfaces this — a user would otherwise believe they are protected when they are not. Fix: `brew install jq` / `apt install jq`.

### 5. PM backend connectivity

- **github**: `gh auth status` — pass if logged in
- **linear**: pass if a Linear MCP server is available — `claude mcp list`, or Linear MCP tools in this session
- **local**: check that `$CLAUDE_PROJECT_DIR/issues/` exists and is readable

### 6. Git state

- Is the repo a git repo? (`git rev-parse --is-inside-work-tree`)
- Is there an `origin` remote?
- Are there uncommitted changes? (informational only)

## Output

Print a table:

```
CHECK                          STATUS    NOTE
config.md                      FIXED     test_cmd was blank -> .venv/bin/pytest (23 passed)
CLAUDE.md freshness            STALE     last touched 124 days ago
hooks                          OK        hooks.json valid, scripts parse
commands on PATH               FAIL      `<missing>` not found
pm backend                     OK
git                            OK
```

End with a one-line summary: `N/M checks passed`. If anything failed, point at the fix (`/flow:init`, install missing tool, etc.) — and where the fix is something you can do, such as a blank `*_cmd`, do it rather than prescribe it.
