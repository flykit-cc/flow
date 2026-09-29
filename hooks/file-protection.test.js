'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const HOOK = path.join(__dirname, 'file-protection.sh');
// No config.md here, so the default secret_globs apply.
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'flow-fp-'));

function edit(rel) {
    return spawnSync('bash', [HOOK], {
        encoding: 'utf8',
        input: JSON.stringify({ tool_input: { file_path: path.join(ROOT, rel) } }),
        env: { ...process.env, CLAUDE_PROJECT_DIR: ROOT },
    }).status;
}

test('ordinary source whose name or directory mentions secrets/env is editable', () => {
    for (const f of ['src/secretStore.ts', 'src/secrets/index.ts', 'config/app.env.ts']) {
        assert.equal(edit(f), 0, f);
    }
});

test('env files and keys are blocked', () => {
    for (const f of ['.env', '.env.local', 'config/.env.prod', 'id_rsa', 'x.pem']) {
        assert.equal(edit(f), 2, f);
    }
});
