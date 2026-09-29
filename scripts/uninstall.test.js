'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const SCRIPT = path.join(__dirname, 'uninstall.js');
const { plan } = require('./uninstall.js');

function run(target, extra = []) {
    return execFileSync('node', [SCRIPT, '--target', target, ...extra], {
        encoding: 'utf8',
        stdio: 'pipe',
    });
}

/** A project that looks like /flow:init ran in it. */
function makeProject(opts = {}) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'flow-uninstall-'));
    fs.mkdirSync(path.join(root, '.flow', 'state'), { recursive: true });
    fs.writeFileSync(path.join(root, '.flow', 'config.md'), '# flow config\n');
    fs.writeFileSync(path.join(root, '.flow', 'session-progress.md'), 'wip\n');
    fs.writeFileSync(path.join(root, '.flow', 'session-log.md'), '## history\n');
    fs.writeFileSync(path.join(root, '.flow', 'state', 'last-pause'), 'sha\n');
    if (opts.claudeMd) fs.writeFileSync(path.join(root, 'CLAUDE.md'), opts.claudeMd);
    if (opts.issues) {
        fs.mkdirSync(path.join(root, 'issues'), { recursive: true });
        for (const f of opts.issues) fs.writeFileSync(path.join(root, 'issues', f), 'x\n');
    }
    return root;
}

test('dry run by default — prints a plan and changes nothing', () => {
    const root = makeProject();
    const before = fs.readdirSync(path.join(root, '.flow')).sort();

    const out = run(root);
    assert.match(out, /Dry run/);
    assert.deepStrictEqual(fs.readdirSync(path.join(root, '.flow')).sort(), before);
});

test('--yes removes config, progress, state and session', () => {
    const root = makeProject();
    fs.mkdirSync(path.join(root, '.flow', 'session'));
    fs.writeFileSync(path.join(root, '.flow', 'session', 'audit.md'), 'x\n');
    run(root, ['--yes']);

    assert.ok(!fs.existsSync(path.join(root, '.flow', 'config.md')));
    assert.ok(!fs.existsSync(path.join(root, '.flow', 'session-progress.md')));
    assert.ok(!fs.existsSync(path.join(root, '.flow', 'state')));
    assert.ok(!fs.existsSync(path.join(root, '.flow', 'session')));
});

test('salvaged/ is kept without --purge and removed with it', () => {
    const kept = makeProject();
    fs.mkdirSync(path.join(kept, '.flow', 'salvaged'));
    run(kept, ['--yes']);
    assert.ok(fs.existsSync(path.join(kept, '.flow', 'salvaged')),
        'it may be the only copy of a stuck agent\'s work');

    const purged = makeProject();
    fs.mkdirSync(path.join(purged, '.flow', 'salvaged'));
    run(purged, ['--yes', '--purge']);
    assert.ok(!fs.existsSync(path.join(purged, '.flow', 'salvaged')));
});

test('--keep-progress spares the live session thread', () => {
    const root = makeProject();
    run(root, ['--yes', '--keep-progress']);

    assert.ok(fs.existsSync(path.join(root, '.flow', 'session-progress.md')),
        'the open session must survive when the user chose to keep it');
    assert.ok(!fs.existsSync(path.join(root, '.flow', 'config.md')),
        'everything else still goes');
});

test('session-progress.md is removed by default', () => {
    const root = makeProject();
    run(root, ['--yes']);
    assert.ok(!fs.existsSync(path.join(root, '.flow', 'session-progress.md')));
});

test('the plan lists session-progress as kept under --keep-progress', () => {
    const root = makeProject();
    const out = run(root, ['--keep-progress']);
    assert.match(out, /keep\s+.flow\/session-progress\.md/,
        'the dry run must show it being kept, so the choice is visible before applying');
});

test('session-log.md is kept without --purge and removed with it', () => {
    const kept = makeProject();
    run(kept, ['--yes']);
    assert.ok(fs.existsSync(path.join(kept, '.flow', 'session-log.md')),
        'history survives a plain uninstall');

    const purged = makeProject();
    run(purged, ['--yes', '--purge']);
    assert.ok(!fs.existsSync(path.join(purged, '.flow', 'session-log.md')));
});

test('CLAUDE.md is never touched — the user may have edited it', () => {
    const original = '# my-app\n\nSeeded by init, then edited.\n';
    const root = makeProject({ claudeMd: original });
    run(root, ['--yes', '--purge']);
    assert.strictEqual(fs.readFileSync(path.join(root, 'CLAUDE.md'), 'utf8'), original);
});

test('issues/ is removed when empty but never when it holds files', () => {
    const withFiles = makeProject({ issues: ['1.md'] });
    run(withFiles, ['--yes']);
    assert.ok(fs.existsSync(path.join(withFiles, 'issues', '1.md')),
        'issue files must never be deleted');

    const empty = makeProject({ issues: [] });
    run(empty, ['--yes']);
    assert.ok(!fs.existsSync(path.join(empty, 'issues')));
});

test('settings.json is never touched', () => {
    const root = makeProject();
    fs.mkdirSync(path.join(root, '.claude'), { recursive: true });
    const settings = '{"hooks":{}}\n';
    fs.writeFileSync(path.join(root, '.claude', 'settings.json'), settings);

    run(root, ['--yes']);
    assert.strictEqual(fs.readFileSync(path.join(root, '.claude', 'settings.json'), 'utf8'), settings);
});

test('a project without flow reports nothing to remove', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'flow-uninstall-bare-'));
    const out = run(root, ['--yes']);
    assert.match(out, /nothing to remove/);
});

test('plan() is pure — it reports without removing anything', () => {
    const root = makeProject();
    const before = fs.readdirSync(root).sort();
    const actions = plan(root, {});
    assert.ok(actions.length > 0);
    assert.deepStrictEqual(fs.readdirSync(root).sort(), before);
});

test('questions.md is kept by default — answered decisions are not regenerable', () => {
    const root = makeProject();
    fs.writeFileSync(path.join(root, '.flow', 'questions.md'), '## Q1\nstatus: answered\n');

    const removed = plan(root, {}).filter(
        (a) => a.kind === 'remove-file' && path.basename(a.path) === 'questions.md');
    assert.deepStrictEqual(removed, [],
        'removing the queue must never be a side effect of uninstalling');
});

test('the plan says questions.md was kept, so it is not silently left behind', () => {
    const root = makeProject();
    fs.writeFileSync(path.join(root, '.flow', 'questions.md'), '## Q1\nstatus: open\n');

    const kept = plan(root, {}).find(
        (a) => a.kind === 'keep' && path.basename(a.path) === 'questions.md');
    assert.ok(kept, 'a kept file must appear in the plan');
    assert.match(kept.note, /purge/, 'the note must say how to remove it');
});

test('--purge removes questions.md along with the log', () => {
    const root = makeProject();
    fs.writeFileSync(path.join(root, '.flow', 'questions.md'), '## Q1\nstatus: open\n');

    const removed = plan(root, { purge: true }).filter(
        (a) => a.kind === 'remove-file' && path.basename(a.path) === 'questions.md');
    assert.strictEqual(removed.length, 1);
});
