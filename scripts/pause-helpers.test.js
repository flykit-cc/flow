'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const HELPERS = path.join(__dirname, 'pause-helpers.sh');

function git(root, args) {
    return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: 'pipe' });
}

/** A temp git repo with one commit, a flow config, and staged-able files. */
function makeRepo() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'flow-pause-'));
    git(root, ['init', '-q', '-b', 'main']);
    git(root, ['config', 'user.email', 'test@example.com']);
    git(root, ['config', 'user.name', 'test']);
    fs.mkdirSync(path.join(root, '.flow'), { recursive: true });
    fs.writeFileSync(path.join(root, '.flow', 'config.md'), '# config\n');
    fs.writeFileSync(path.join(root, 'README.md'), 'seed\n');
    git(root, ['add', 'README.md']);
    git(root, ['commit', '-qm', 'seed']);
    return root;
}

function runFinish(root) {
    const titleFile = path.join(root, '.t');
    const bodyFile = path.join(root, '.b');
    fs.writeFileSync(titleFile, 'Test session\n');
    fs.writeFileSync(bodyFile, 'body\n');
    return execFileSync('bash', [HELPERS, 'finish', titleFile, bodyFile, 'chore: test', '--no-push'], {
        encoding: 'utf8',
        cwd: root,
        env: { ...process.env, CLAUDE_PROJECT_DIR: root },
        stdio: 'pipe',
    });
}

test('finish does not stage private paths', () => {
    const root = makeRepo();
    fs.writeFileSync(path.join(root, 'src.ts'), 'export const a = 1;\n');
    fs.mkdirSync(path.join(root, 'docs', 'superpowers'), { recursive: true });
    fs.writeFileSync(path.join(root, 'docs', 'superpowers', 'plan.md'), 'private\n');

    runFinish(root);

    const committed = git(root, ['show', '--name-only', '--format=', 'HEAD']).trim().split('\n');
    assert.ok(committed.includes('src.ts'), 'public file should be committed');
    assert.ok(!committed.some((f) => f.startsWith('docs/superpowers/')),
        'private file must not be committed');
});

test('finish aborts when a private path is already staged', () => {
    const root = makeRepo();
    fs.mkdirSync(path.join(root, '.claude'), { recursive: true });
    fs.writeFileSync(path.join(root, '.claude', 'settings.json'), '{}\n');
    git(root, ['add', '-f', '.claude/settings.json']);

    assert.throws(() => runFinish(root), (err) => {
        assert.equal(err.status, 2);
        assert.match(String(err.stderr), /private/i);
        return true;
    });
});

test('finish --land reports a rejected default-branch push and keeps the branch', () => {
    const root = makeRepo();
    const remote = fs.mkdtempSync(path.join(os.tmpdir(), 'flow-remote-'));
    execFileSync('git', ['init', '-q', '--bare', '-b', 'main', remote]);
    git(root, ['remote', 'add', 'origin', remote]);
    git(root, ['push', '-q', '-u', 'origin', 'main']);
    git(root, ['remote', 'set-head', 'origin', 'main']);
    git(root, ['checkout', '-q', '-b', 'feature']);
    // The remote accepts the feature branch but rejects any update to main.
    const hook = path.join(remote, 'hooks', 'pre-receive');
    fs.writeFileSync(hook, '#!/bin/sh\nwhile read o n ref; do [ "$ref" = refs/heads/main ] && { echo "main is protected" >&2; exit 1; }; done\nexit 0\n');
    fs.chmodSync(hook, 0o755);
    fs.writeFileSync(path.join(root, 'src.ts'), 'export const a = 1;\n');
    fs.writeFileSync(path.join(root, '.t'), 'Test session\n');
    fs.writeFileSync(path.join(root, '.b'), 'body\n');

    const out = execFileSync('bash', [HELPERS, 'finish', '.t', '.b', 'chore: test', '--land'], {
        encoding: 'utf8', cwd: root, env: { ...process.env, CLAUDE_PROJECT_DIR: root }, stdio: 'pipe',
    });

    assert.match(out, /^finish-ok$/m, 'a failed land must still reach the report');
    assert.match(out, /^land:LAND FAILED \(push main\): /m);
    assert.match(git(root, ['branch', '--list', 'feature']), /feature/, 'the branch is the only pushed copy of the work');
    assert.ok(fs.existsSync(path.join(root, '.flow', 'state', 'last-pause')), 'write-marker still runs');
});

test('finish consumes the narration files so a later pause cannot log stale text', () => {
    const root = makeRepo();
    const titleFile = path.join(root, '.flow', 'pause-title');
    const bodyFile = path.join(root, '.flow', 'pause-body');
    fs.writeFileSync(titleFile, 'Session one\n');
    fs.writeFileSync(bodyFile, '- did the first thing\n');

    execFileSync('bash', [HELPERS, 'finish', titleFile, bodyFile, 'chore: one', '--no-push'], {
        encoding: 'utf8', cwd: root, env: { ...process.env, CLAUDE_PROJECT_DIR: root }, stdio: 'pipe',
    });

    assert.ok(!fs.existsSync(titleFile), 'pause-title must not survive into the next pause');
    assert.ok(!fs.existsSync(bodyFile), 'pause-body must not survive into the next pause');
});

test('a second finish with no fresh narration fails loudly instead of relogging the old block', () => {
    const root = makeRepo();
    const titleFile = path.join(root, '.flow', 'pause-title');
    const bodyFile = path.join(root, '.flow', 'pause-body');
    fs.writeFileSync(titleFile, 'Session one\n');
    fs.writeFileSync(bodyFile, '- did the first thing\n');
    const finish = () => execFileSync('bash', [HELPERS, 'finish', titleFile, bodyFile, 'chore: x', '--no-push'], {
        encoding: 'utf8', cwd: root, env: { ...process.env, CLAUDE_PROJECT_DIR: root }, stdio: 'pipe',
    });

    finish();
    fs.writeFileSync(path.join(root, 'src.ts'), 'export const a = 1;\n');

    assert.throws(finish, /log-block needs/i);

    const log = fs.readFileSync(path.join(root, '.flow', 'session-log.md'), 'utf8');
    assert.equal(log.match(/Session one/g).length, 1,
        'the same narration must never be logged twice under two different dates');
});

test('an aborted finish mutates nothing — no log block, narration intact', () => {
    // The guards are the whole point of finish. Anything written or deleted before
    // they run is work done on a pause that was never allowed to happen: a history
    // block for a pause that did not occur, and (when the goal is met) a deleted
    // session-progress.md with no commit to show for it.
    const root = makeRepo();
    const titleFile = path.join(root, '.flow', 'pause-title');
    const bodyFile = path.join(root, '.flow', 'pause-body');
    fs.writeFileSync(titleFile, 'Session one\n');
    fs.writeFileSync(bodyFile, '- did a thing\n');
    // A progress file with nothing in flight — trim would delete it.
    fs.writeFileSync(path.join(root, '.flow', 'session-progress.md'), '# Session\n');
    fs.mkdirSync(path.join(root, '.claude'), { recursive: true });
    fs.writeFileSync(path.join(root, '.claude', 'settings.json'), '{}\n');
    git(root, ['add', '-f', '.claude/settings.json']);

    assert.throws(() => execFileSync('bash', [HELPERS, 'finish', titleFile, bodyFile, 'chore: x', '--no-push'], {
        encoding: 'utf8', cwd: root, env: { ...process.env, CLAUDE_PROJECT_DIR: root }, stdio: 'pipe',
    }), (err) => err.status === 2);

    assert.ok(!fs.existsSync(path.join(root, '.flow', 'session-log.md')),
        'a pause that was refused must not leave a block in the history log');
    assert.ok(fs.existsSync(titleFile) && fs.existsSync(bodyFile),
        'narration must survive so the retry does not have to reconstruct it');
    assert.ok(fs.existsSync(path.join(root, '.flow', 'session-progress.md')),
        'session state must not be destroyed by a pause that never committed');
});

test('the secret abort names the file and does not tell you to unstage an unstaged one', () => {
    // The pre-flight fires before staging, so the usual offender is an untracked
    // working-tree file. Telling the user to `git reset` it sends them round a
    // loop that changes nothing, and not naming it leaves them guessing which.
    const root = makeRepo();
    const titleFile = path.join(root, '.flow', 'pause-title');
    const bodyFile = path.join(root, '.flow', 'pause-body');
    fs.writeFileSync(titleFile, 'Session one\n');
    fs.writeFileSync(bodyFile, '- body\n');
    fs.writeFileSync(path.join(root, ['.e', 'nv'].join('')), 'KEY=redacted\n');

    assert.throws(() => execFileSync('bash', [HELPERS, 'finish', titleFile, bodyFile, 'chore: x', '--no-push'], {
        encoding: 'utf8', cwd: root, env: { ...process.env, CLAUDE_PROJECT_DIR: root }, stdio: 'pipe',
    }), (err) => {
        const msg = String(err.stderr);
        assert.match(msg, /\.env/, 'must name the offending path');
        assert.doesNotMatch(msg, /staged secrets detected/,
            'must not claim the file is staged when the pre-flight caught it unstaged');
        return true;
    });
});

function run(root, args) {
    return execFileSync('bash', [HELPERS, ...args], {
        encoding: 'utf8',
        cwd: root,
        env: { ...process.env, CLAUDE_PROJECT_DIR: root },
        stdio: 'pipe',
    });
}

test('verification-mode defaults to ask and reflects config', () => {
    const root = makeRepo();
    assert.equal(run(root, ['verification-mode']).trim(), 'ask');

    fs.appendFileSync(path.join(root, '.flow', 'config.md'), '- stop_check: never\n');
    assert.equal(run(root, ['verification-mode']).trim(), 'never');
});

test('set-verification-mode persists the choice into config.md', () => {
    const root = makeRepo();
    const out = run(root, ['set-verification-mode', 'always']);
    assert.match(out, /stop_check set to always/);
    const config = fs.readFileSync(path.join(root, '.flow', 'config.md'), 'utf8');
    assert.match(config, /stop_check:\s*always/);
    assert.equal(run(root, ['verification-mode']).trim(), 'always');

    // Re-running with a different value replaces rather than duplicating the line.
    run(root, ['set-verification-mode', 'never']);
    const config2 = fs.readFileSync(path.join(root, '.flow', 'config.md'), 'utf8');
    assert.equal((config2.match(/stop_check\s*:/g) || []).length, 1);
    assert.equal(run(root, ['verification-mode']).trim(), 'never');
});

test('set-verification-mode rejects an unknown value', () => {
    const root = makeRepo();
    assert.throws(() => run(root, ['set-verification-mode', 'bogus']));
});

test('run-verification reports pass when build_cmd/test_cmd succeed', () => {
    const root = makeRepo();
    fs.appendFileSync(path.join(root, '.flow', 'config.md'), '- build_cmd: true\n- test_cmd: true\n');
    assert.equal(run(root, ['run-verification']).trim(), 'verification-passed:build+test');
});

test('run-verification never reports a pass when nothing is configured', () => {
    const root = makeRepo();
    fs.appendFileSync(path.join(root, '.flow', 'config.md'), '- build_cmd:\n- test_cmd:\n');

    const out = run(root, ['run-verification']).trim();
    assert.equal(out, 'verification-skipped:nothing-configured');
    assert.ok(!out.includes('passed'),
        'a project with nothing to run must not record a pass — that is how an unverified session ships');
});

test('run-verification names which half ran when only one is configured', () => {
    const buildOnly = makeRepo();
    fs.appendFileSync(path.join(buildOnly, '.flow', 'config.md'), '- build_cmd: true\n- test_cmd:\n');
    assert.equal(run(buildOnly, ['run-verification']).trim(), 'verification-passed:build',
        'a missing test_cmd must stay visible in the record');

    const testOnly = makeRepo();
    fs.appendFileSync(path.join(testOnly, '.flow', 'config.md'), '- build_cmd:\n- test_cmd: true\n');
    assert.equal(run(testOnly, ['run-verification']).trim(), 'verification-passed:test');
});

test('run-verification still fails on a failing test_cmd when build passes', () => {
    const root = makeRepo();
    fs.appendFileSync(path.join(root, '.flow', 'config.md'), '- build_cmd: true\n- test_cmd: false\n');
    assert.throws(() => run(root, ['run-verification']), (err) => {
        assert.equal(err.status, 1);
        assert.match(String(err.stdout), /verification-failed:test/);
        return true;
    });
});

test('run-verification reports failure and exits non-zero when build_cmd fails', () => {
    const root = makeRepo();
    fs.appendFileSync(path.join(root, '.flow', 'config.md'), '- build_cmd: false\n- test_cmd: true\n');
    assert.throws(() => run(root, ['run-verification']), (err) => {
        assert.equal(err.status, 1);
        assert.match(String(err.stdout), /verification-failed:build/);
        return true;
    });
});

function helper(root, args, env = {}) {
    return execFileSync('bash', [HELPERS, ...args], {
        encoding: 'utf8',
        cwd: root,
        env: { ...process.env, CLAUDE_PROJECT_DIR: root, ...env },
        stdio: 'pipe',
    }).trim();
}

test('a finished goal with a Needs you section keeps session-progress.md', () => {
    const root = makeRepo();
    const progress = path.join(root, '.flow', 'session-progress.md');
    fs.writeFileSync(progress, '## Goal\n\n## Needs you\n- skipped: CLAUDE.md update (unattended)\n');

    assert.match(helper(root, ['trim-or-delete-progress']), /kept .*needs-you=y/);
    assert.ok(fs.existsSync(progress), 'the next session only learns what was skipped from this file');
});

test('a finished goal with an empty Needs you section is still deleted', () => {
    const root = makeRepo();
    const progress = path.join(root, '.flow', 'session-progress.md');
    fs.writeFileSync(progress, '## Goal\n\n## Needs you\n\n');

    assert.match(helper(root, ['trim-or-delete-progress']), /deleted/);
    assert.ok(!fs.existsSync(progress));
});

test('pause-pending set/read, and a successful finish clears it', () => {
    const root = makeRepo();
    assert.match(helper(root, ['pause-pending', 'set', 'after', 'sleep']), /set: after sleep/);
    assert.match(helper(root, ['pause-pending', 'read']), /^flags: after sleep\nstarted: \d{4}-/);

    fs.writeFileSync(path.join(root, 'src.ts'), 'x\n');
    runFinish(root);
    assert.strictEqual(helper(root, ['pause-pending', 'read']), '');
});

test('schedule-sleep does nothing off macOS', () => {
    const root = makeRepo();
    const marker = path.join(root, 'slept');
    const out = helper(root, ['schedule-sleep', '0'], { FLOW_UNAME: 'Linux', FLOW_SLEEP_CMD: `touch ${marker}` });
    assert.strictEqual(out, 'sleep-skipped:not-macos');
    assert.ok(!fs.existsSync(marker));
});

test('schedule-sleep on macOS fires after the delay, detached from the helper', async () => {
    const root = makeRepo();
    const marker = path.join(root, 'slept');
    const out = helper(root, ['schedule-sleep', '1'], { FLOW_UNAME: 'Darwin', FLOW_SLEEP_CMD: `touch ${marker}` });
    assert.match(out, /^sleep-scheduled:1s pid=\d+ \(cancel: kill \d+\)$/);
    assert.ok(!fs.existsSync(marker), 'must wait out the delay, not sleep immediately');

    const deadline = Date.now() + 6000;
    while (!fs.existsSync(marker) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 200));
    assert.ok(fs.existsSync(marker), 'the scheduled sleep must still fire after the helper has exited');
});

test('finish never commits .flow/salvaged, even when config sets its own private_globs', () => {
    const root = makeRepo();
    fs.writeFileSync(path.join(root, '.flow', 'config.md'), '- private_globs: .claude\n');
    fs.mkdirSync(path.join(root, '.flow', 'salvaged'), { recursive: true });
    fs.writeFileSync(path.join(root, '.flow', 'salvaged', 'impl.md'), 'raw transcript\n');
    fs.writeFileSync(path.join(root, 'src.ts'), 'x\n');

    runFinish(root);
    const committed = git(root, ['show', '--name-only', '--format=', 'HEAD']);
    assert.ok(committed.includes('src.ts'));
    assert.ok(!committed.includes('.flow/salvaged'), 'salvaged agent output must never be committed');
});

test('a finish that dies at commit keeps pause-pending — that pause did not happen', () => {
    const root = makeRepo();
    const hook = path.join(root, '.git', 'hooks', 'pre-commit');
    fs.writeFileSync(hook, '#!/bin/sh\nexit 1\n', { mode: 0o755 });
    helper(root, ['pause-pending', 'set', 'after']);
    fs.writeFileSync(path.join(root, 'src.ts'), 'x\n');

    assert.throws(() => runFinish(root));
    assert.match(helper(root, ['pause-pending', 'read']), /^flags: after/);
});

test('schedule-sleep rejects a non-numeric delay', () => {
    const root = makeRepo();
    assert.throws(() => helper(root, ['schedule-sleep', '30s'], { FLOW_UNAME: 'Darwin', FLOW_SLEEP_CMD: 'true' }));
});

test('changed-files leaves out private paths, so salvaged work cannot block the no-op exit', () => {
    const root = makeRepo();
    fs.mkdirSync(path.join(root, '.flow', 'salvaged'), { recursive: true });
    fs.writeFileSync(path.join(root, '.flow', 'salvaged', 'impl.md'), 'x\n');
    fs.writeFileSync(path.join(root, 'src.ts'), 'x\n');
    const out = helper(root, ['changed-files']).split('\n');
    assert.ok(out.includes('src.ts'));
    assert.ok(!out.some((f) => f.startsWith('.flow/salvaged')));
});

test('finish stops tracking .flow files committed before the config.md-only rule, keeping them on disk', () => {
    const root = makeRepo();
    const log = path.join(root, '.flow', 'session-log.md');
    fs.writeFileSync(log, 'old history\n');
    git(root, ['add', '-f', '.flow/session-log.md', '.flow/config.md']);
    git(root, ['commit', '-qm', 'legacy: committed flow state']);
    fs.writeFileSync(path.join(root, 'src.ts'), 'x\n');

    runFinish(root);
    const tracked = git(root, ['ls-files', '.flow']).trim().split('\n');
    assert.deepStrictEqual(tracked, ['.flow/config.md'], 'only config.md stays tracked');
    assert.ok(fs.existsSync(log), 'the file itself must survive on disk');
});

test('after a pause, flow state never shows as untracked — only config.md is visible to git', () => {
    const root = makeRepo();
    fs.writeFileSync(path.join(root, '.flow', 'questions.md'), '# q\n');
    fs.writeFileSync(path.join(root, 'src.ts'), 'x\n');
    runFinish(root);
    assert.strictEqual(git(root, ['status', '--porcelain']).trim(), '', 'a clean pause leaves a clean tree');
});

test('finish commits .env.example but refuses a real .env', () => {
    const root = makeRepo();
    fs.writeFileSync(path.join(root, '.env.example'), 'API_KEY=\n');
    runFinish(root);
    assert.ok(git(root, ['show', '--name-only', '--format=', 'HEAD']).includes('.env.example'));

    fs.writeFileSync(path.join(root, '.env'), 'API_KEY=sk-live\n');
    assert.throws(() => runFinish(root), (err) => err.status === 2 && /secret_globs/.test(String(err.stderr)));
});
