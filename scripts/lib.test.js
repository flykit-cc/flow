'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const LIB = path.join(__dirname, 'lib.sh');

/** Make a temp project root containing .flow/config.md with `body`. */
function makeProject(body) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'flow-lib-'));
    fs.mkdirSync(path.join(root, '.flow'), { recursive: true });
    fs.writeFileSync(path.join(root, '.flow', 'config.md'), body);
    return root;
}

/** Source lib.sh with CLAUDE_PROJECT_DIR=root and run `snippet`. */
function sh(root, snippet) {
    return execFileSync('bash', ['-c', `set -u; . ${JSON.stringify(LIB)}; ${snippet}`], {
        encoding: 'utf8',
        env: { ...process.env, CLAUDE_PROJECT_DIR: root },
    }).trim();
}

/** Run `snippet` for its exit status only. */
function shStatus(root, snippet) {
    try {
        execFileSync('bash', ['-c', `set -u; . ${JSON.stringify(LIB)}; ${snippet}`], {
            encoding: 'utf8',
            env: { ...process.env, CLAUDE_PROJECT_DIR: root },
            stdio: 'pipe',
        });
        return 0;
    } catch (e) {
        return e.status;
    }
}

test('flow_private_globs falls back to a default when unset', () => {
    const root = makeProject('# empty\n');
    const out = sh(root, 'flow_private_globs');
    assert.match(out, /\.claude/);
    assert.match(out, /docs\/superpowers/);
});

test('flow_private_globs reads the configured value', () => {
    const root = makeProject('- private_globs: notes secrets-wip\n');
    assert.equal(sh(root, 'flow_private_globs'), 'notes secrets-wip');
});

test('flow_path_is_private matches a directory and its contents', () => {
    const root = makeProject('# empty\n');
    assert.equal(shStatus(root, `flow_path_is_private "${root}/.claude/config.md"`), 0);
    assert.equal(shStatus(root, `flow_path_is_private "${root}/docs/superpowers/plans/a.md"`), 0);
    assert.equal(shStatus(root, `flow_path_is_private "${root}/src/index.ts"`), 1);
});

test('flow_path_is_private accepts repo-relative paths', () => {
    const root = makeProject('# empty\n');
    assert.equal(shStatus(root, 'flow_path_is_private ".claude/settings.json"'), 0);
    assert.equal(shStatus(root, 'flow_path_is_private "src/index.ts"'), 1);
});

test('flow_path_is_private does not treat a glob as a substring match', () => {
    const root = makeProject('# empty\n');
    assert.equal(shStatus(root, 'flow_path_is_private "my.claudex"'), 1);
});

test('flow_path_is_private matches only whole path segments, not substrings', () => {
    const root = makeProject('# empty\n');
    for (const p of ['docs/superpowers/plan.md', '.claude/config.md']) {
        assert.equal(shStatus(root, `flow_path_is_private "${p}"`), 0, `${p} must be private`);
    }
    for (const p of ['my.claudex', 'src/.claudex/a.ts', 'notdocs/superpowers/a.md']) {
        assert.equal(shStatus(root, `flow_path_is_private "${p}"`), 1, `${p} must not be private`);
    }
});

// Only .flow/config.md is ever committed; everything else under .flow/ is
// private, even when config.md sets its own private_globs.
const FLOW_PRIVATE = ['.flow/session-log.md', '.flow/questions.md', '.flow/session-progress.md',
    '.flow/local.md', '.flow/state/pause-pending', '.flow/config.md.bak', '.flow/config'];

test('flow_path_is_private: all of .flow/ except config.md, whatever private_globs says', () => {
    for (const root of [makeProject('# empty\n'), makeProject('- private_globs: notes\n')]) {
        for (const p of FLOW_PRIVATE) {
            assert.equal(shStatus(root, `flow_path_is_private "${p}"`), 0, `${p} must be private`);
        }
        assert.equal(shStatus(root, 'flow_path_is_private ".flow/config.md"'), 1,
            'project config must be stageable');
    }
});

test('flow_path_is_secret matches name globs on the basename only', () => {
    const root = makeProject('# empty\n');
    for (const p of ['.env', '.env.local', 'config/.env', 'id_rsa', 'x.pem', 'secrets.json']) {
        assert.equal(shStatus(root, `flow_path_is_secret "${p}"`), 0, `${p} must be secret`);
    }
    for (const p of ['src/secretStore.ts', 'src/secrets/index.ts', 'config/app.env.ts']) {
        assert.equal(shStatus(root, `flow_path_is_secret "${p}"`), 1, `${p} must not be secret`);
    }
    const custom = makeProject('- secret_globs: *secret* config/keys/*\n');
    assert.equal(shStatus(custom, 'flow_path_is_secret "src/secrets/index.ts"'), 1);
    assert.equal(shStatus(custom, 'flow_path_is_secret "config/keys/a.txt"'), 0);
});

test('flow_stop_check_mode defaults to ask and rejects junk', () => {
    assert.equal(sh(makeProject('# empty\n'), 'flow_stop_check_mode'), 'ask');
    assert.equal(sh(makeProject('- stop_check: nonsense\n'), 'flow_stop_check_mode'), 'ask');
    assert.equal(sh(makeProject('- stop_check: never\n'), 'flow_stop_check_mode'), 'never');
    assert.equal(sh(makeProject('- stop_check: always\n'), 'flow_stop_check_mode'), 'always');
});

// 9. flow_extract must not return non-zero for a missing key — under
// `set -euo pipefail` (as continue-helpers.sh uses), a non-zero return from
// a bare `VAR="$(flow_extract key)"` aborts the whole script.
test('flow_extract returns 0 (success) when the key is missing', () => {
    const root = makeProject('# empty\n');
    const status = shStatus(root, 'set -euo pipefail; PORT="$(flow_extract dev_port)"; echo "ok:$PORT"');
    assert.equal(status, 0, 'a missing key must not abort a pipefail caller');
});

test('no agent file pins a model in frontmatter', () => {
    const agentsDir = path.join(__dirname, '..', 'agents');
    const offenders = [];
    for (const file of fs.readdirSync(agentsDir).filter((f) => f.endsWith('.md'))) {
        const text = fs.readFileSync(path.join(agentsDir, file), 'utf8');
        const fm = text.split('---')[1] || '';
        if (/^model:/m.test(fm)) offenders.push(file);
    }
    assert.deepEqual(offenders, [],
        `agents must read model tiers from config, not pin a model: ${offenders.join(', ')}`);
});
