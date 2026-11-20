const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { blobId, treeId } = require('../src/gitid');

// [GIT_IDS_0_10_25] the ids the engine shows for Q1 must be the ids git (and GitHub) give for the same files
test('blobId of an empty file is git\'s empty blob id', () => {
    assert.strictEqual(blobId(Buffer.alloc(0)), 'e69de29bb2d1d6434b8b29ae775ad8c2e48c5391');
});

test('treeId and blobId equal git for nested folders, sorting and binary files', (t) => {
    try { execFileSync('git', ['--version'], { stdio: 'ignore' }); } catch (_e) { t.skip('git not installed'); return; }
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gitid-'));
    const g = (...a) => execFileSync('git', ['-c', 'core.autocrlf=false', '-c', 'core.safecrlf=false', ...a], { cwd: dir }).toString().trim();
    try {
        g('init', '-q');
        const put = (f, b) => { fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true }); fs.writeFileSync(path.join(dir, f), b); };
        put('package.json', '{"name":"x"}\n');
        put('src/a.js', 'a\n');
        put('src/a-b.js', 'ab\n');           // '-' sorts before '/' and '.': checks the "name/" rule for folders
        put('src/a/z.js', 'z\n');
        put('src/a.b/y.js', 'y\n');
        put('src/public/font.woff2', Buffer.from([0, 1, 2, 255, 13, 10]));
        put('src/empty.txt', '');
        g('add', '-A');
        const tree = g('write-tree');
        assert.strictEqual(treeId(path.join(dir, 'src')), g('rev-parse', `${tree}:src`));
        assert.strictEqual(blobId(fs.readFileSync(path.join(dir, 'package.json'))), g('rev-parse', `${tree}:package.json`));
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('this checkout: treeId(src) equals git\'s id of the src folder as staged', (t) => {
    const root = path.join(__dirname, '..');
    let id = '';
    try { id = execFileSync('git', ['write-tree', '--prefix=src/'], { cwd: root, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim(); } catch (_e) { t.skip('not a git checkout with a clean index'); return; }
    const dirty = execFileSync('git', ['status', '--porcelain', '--', 'src'], { cwd: root }).toString().trim();
    if (dirty) { t.skip('src has uncommitted changes'); return; }
    assert.strictEqual(treeId(path.join(root, 'src')), id);
});
