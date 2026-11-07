const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const Engine = require('../src/Engine');
const { RecordStore } = require('../src/store');

function tmpDir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'buyin-results-')); }

test('결과 조회: 진행 중인 판은 나오지 않고, 끝난 판만 카드 없이 나온다', () => {
    const store = new RecordStore(tmpDir());
    const engine = new Engine({ mode: 'dev', allowUnsigned: true, onRecord: (rec, sig) => store.appendHand(rec, sig) });
    store.appendEngineKey(engine.call('info'));
    const { tableId } = engine.call('openTable', {});
    const s = engine.call('startHand', { tableId, handNo: 1, seats: [{ seat: 0, odcId: 'a', stack: 10 }, { seat: 1, odcId: 'b', stack: 10 }], dealer: 0, sb: 0, bb: 1, smallBlind: 1, bigBlind: 2 });
    assert.ok(s.ok, s.error);

    // 판이 진행 중 — 사슬에 없으므로 결과에도 없다
    const during = store.results(0, 100);
    assert.deepStrictEqual(during.entries, []);
    assert.strictEqual(store.getHand(s.handId), null);

    assert.ok(engine.call('act', { handId: s.handId, entry: { k: 'host', seat: 0, q: 0, action: 'FOLD', reason: 'timeout' } }).ok);
    assert.ok(engine.call('finish', { handId: s.handId }).ok);

    const after = store.results(0, 100);
    assert.strictEqual(after.entries.length, 1);
    const r = after.entries[0];
    assert.strictEqual(r.handId, String(s.handId));
    assert.deepStrictEqual(r.seats.map((x) => [x.odcId, x.start, x.end]), [['a', 10, 9], ['b', 10, 11]]);
    assert.match(r.recordHash, /^[0-9a-f]{64}$/);
    // 카드·덱·시드는 없다
    const text = JSON.stringify(after);
    for (const k of ['holes', 'deck', 'seed', 'board', 'log', 'entropy']) assert.ok(!text.includes(`"${k}"`), k);
    assert.strictEqual(after.next, store.count);
});

test('결과 조회: 콘솔 토큰이 있어야 한다', async () => {
    const port = 3960 + Math.floor(Math.random() * 9);
    const srv = spawn(process.execPath, [path.join(__dirname, '..', 'src', 'server.js')], {
        env: { ...process.env, TEE_MODE: 'dev', TEE_PORT: String(port), TEE_RPC_TOKEN: 'test-token', TEE_RECORD_DIR: tmpDir() },
        stdio: 'ignore',
    });
    try {
        let r;
        for (let i = 0; i < 150; i++) { try { r = await fetch(`http://127.0.0.1:${port}/records/results`); break; } catch (_e) { await new Promise((ok) => setTimeout(ok, 100)); } }
        assert.strictEqual(r.status, 401);
        const ok = await fetch(`http://127.0.0.1:${port}/records/results?from=0`, { headers: { Authorization: 'Bearer test-token' } });
        assert.strictEqual(ok.status, 200);
        const body = await ok.json();
        assert.deepStrictEqual(body.entries, []);
        assert.strictEqual(body.next, 1, 'engine key line read, no hands');
        // 끝난 판의 전체 기록도 토큰이 있어야 하고, 없는 판은 404
        assert.strictEqual((await fetch(`http://127.0.0.1:${port}/records/finished/x1`)).status, 401);
        assert.strictEqual((await fetch(`http://127.0.0.1:${port}/records/finished/x1`, { headers: { Authorization: 'Bearer test-token' } })).status, 404);
        const head = await (await fetch(`http://127.0.0.1:${port}/records/head`)).json();
        assert.strictEqual(head.retentionDays, 7);
    } finally {
        srv.kill();
    }
});
