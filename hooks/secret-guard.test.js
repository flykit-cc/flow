'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { execFileSync } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const HOOK = path.join(__dirname, 'secret-guard.sh');
// A project with no config.md, so the default secret_globs apply — not the
// config of whatever project the tests happen to run inside.
// It holds real secret-named files: for grep/rg/sed/awk a secret-looking word
// only counts when the file exists, so the block cases need them on disk.
const PROJECT = fs.mkdtempSync(path.join(os.tmpdir(), 'flow-sg-'));
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'flow-sg-home-'));
for (const f of ['.env', '.env.local', 'credentials.json', 'config/secrets.yml', 'config/.env', 'x.pem']) {
    fs.mkdirSync(path.dirname(path.join(PROJECT, f)), { recursive: true });
    fs.writeFileSync(path.join(PROJECT, f), 'API_KEY=sk-test\n');
}
fs.mkdirSync(path.join(HOME, '.ssh'));
fs.writeFileSync(path.join(HOME, '.ssh', 'id_rsa'), 'key\n');
const ENV = { ...process.env, CLAUDE_PROJECT_DIR: PROJECT, HOME };

function runHook(input) {
    try {
        const stdout = execFileSync('bash', [HOOK], {
            encoding: 'utf8',
            input: JSON.stringify({ cwd: PROJECT, ...input }),
            stdio: 'pipe',
            env: ENV,
        });
        return { code: 0, stdout };
    } catch (err) {
        return { code: err.status, stdout: err.stdout, stderr: err.stderr };
    }
}

function bashCommand(command) {
    return runHook({ tool_name: 'Bash', tool_input: { command } });
}

function readFile(filePath) {
    return runHook({ tool_name: 'Read', tool_input: { file_path: filePath } });
}

// Commands that merely mention a secret glob as a substring (a jq filter,
// a grep search term, an ordinary source file whose name happens to
// contain "key") must be allowed — they don't read a secret file.
const MUST_ALLOW = [
    'cat package.json | jq .key',
    'grep -rn secret src/',
    'cat package.json | jq .key',
    'rg "api_key" --files-with-matches',
    'cat src/keyboard.ts',
    'cat src/config.ts',
    'grep -rn "process.env" src/',
    'sed -n 1,20p config/app.env.ts',
    'cat src/secrets/index.ts',
];

for (const cmd of MUST_ALLOW) {
    test(`Bash allowed: ${cmd}`, () => {
        const { code } = bashCommand(cmd);
        assert.equal(code, 0, `expected allowed, got exit ${code}`);
    });
}

// Commands that actually read a secret-looking file must still be blocked.
const MUST_BLOCK = [
    'cat .env',
    'cat ~/.ssh/id_rsa',
    'grep -r . credentials.json',
    'cat config/secrets.yml',
    'grep -rn "process.env" .env',
    'grep -e FOO .env.local',
    'sed -n 1p x.pem',
    // The pattern arrives through an option, so the secret is a plain operand.
    'grep -r -f .env .',
    'grep -f .env x',
    'grep --file=.env x',
    'grep -f.env x',
    'rg -uu -f .env',
    'grep --regexp=A .env',
    'grep -eKEY .env',
    'grep -iea .env',
    'sed -nep .env',
    'sed --expression=p .env',
    'awk --source={print} .env',
    'awk -f .env x',
    'cd config && grep KEY .env',
];

for (const cmd of MUST_BLOCK) {
    test(`Bash blocked: ${cmd}`, () => {
        const { code, stderr } = bashCommand(cmd);
        assert.equal(code, 2, `expected blocked, got exit ${code}`);
        assert.match(stderr || '', /secret-guard/);
    });
}

test('Read: secret file path is blocked', () => {
    const { code } = readFile('/repo/.env');
    assert.equal(code, 2);
});

test('Read: ordinary file path is allowed', () => {
    const { code } = readFile('/repo/src/config.ts');
    assert.equal(code, 0);
});

test('Read: a "secret" directory or file-name fragment is not a secret file', () => {
    assert.equal(readFile('/repo/src/secrets/index.ts').code, 0);
    assert.equal(readFile('/repo/src/secretStore.ts').code, 0);
});

test('Read: .env.example-style placeholders are not secrets', () => {
    for (const p of ['/repo/.env.example', '/repo/.env.sample', '/repo/.env.template']) {
        assert.equal(readFile(p).code, 0, p);
    }
});

test('Read: env files and keys are blocked', () => {
    for (const p of ['/repo/.env.local', '/repo/id_rsa', '/repo/x.pem']) {
        assert.equal(readFile(p).code, 2, p);
    }
});

test('Bash: command with no secret-looking tokens at all is allowed', () => {
    const { code } = bashCommand('ls -la src/');
    assert.equal(code, 0);
});

test('Bash: reading a secret through a pipeline is still blocked', () => {
    const { code } = bashCommand('cat .env | grep FOO');
    assert.equal(code, 2);
});

// The plugin's own source ships publicly on GitHub and provably holds no
// secrets, but several of its filenames contain "secret", so the *secret*
// glob blocks reading them. That friction teaches evasion — the fix is to
// exempt the plugin's own tree, not to loosen the glob for user files.
test('reading the plugin\'s own source is allowed even when the name matches', () => {
    const own = path.join(__dirname, ['sec', 'ret', '-guard.sh'].join(''));
    assert.strictEqual(readFile(own).code, 0, 'the guard must not block its own source');
});

test('a reader command pointed at the plugin\'s own source is allowed', () => {
    const own = path.join(__dirname, ['sec', 'ret', '-guard.sh'].join(''));
    assert.strictEqual(bashCommand(`grep -n jq ${own}`).code, 0);
});

test('a real secret file outside the plugin is still blocked', () => {
    const env = path.join('/tmp', 'some-project', ['.e', 'nv'].join(''));
    assert.strictEqual(readFile(env).code, 2, 'user secrets must still be blocked');
});

test('secret globs are matched literally, not expanded against the cwd', () => {
    // `for glob in $(flow_secret_globs)` is unquoted, so bash applies PATHNAME
    // EXPANSION to the pattern list. Run from a directory containing a file that
    // matches one of the globs and that glob is REPLACED by the concrete
    // filenames, silently dropping the pattern — the guard then lets real
    // secrets through.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flow-globexp-'));
    fs.writeFileSync(path.join(dir, 'other.pem'), 'x');

    let code = 0;
    try {
        execFileSync('bash', [HOOK], {
            encoding: 'utf8', cwd: dir, stdio: 'pipe', env: ENV,
            input: JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'cat config/server.pem' } }),
        });
    } catch (err) { code = err.status; }

    assert.strictEqual(code, 2, 'a cwd holding a glob-matching file must not disarm the guard');
});
