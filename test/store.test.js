const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Engine = require('../src/Engine');
const C = require('../src/crypto');
const { RecordStore, verifyChain, GENESIS } = require('../src/store');
const { verifyRecord } = require('../src/verify');

function tmpDir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'buyin-records-')); }

/** 키 없는 시험 좌석 두 명 — 운영 서버가 SB 를 폴드시키고(시간 초과) 판을 끝낸다 */
function playFoldHand(engine) {
    const { tableId } = engine.call('openTable', {});
    const s = engine.call('startHand', { tableId, handNo: 1, seats: [{ seat: 0, odcId: 'a', stack: 10 }, { seat: 1, odcId: 'b', stack: 10 }], dealer: 0, sb: 0, bb: 1, smallBlind: 1, bigBlind: 2 });
    assert.ok(s.ok, s.error);
    const f = engine.call('act', { handId: s.handId, entry: { k: 'host', seat: 0, q: 0, action: 'FOLD', reason: 'timeout' } });
    assert.ok(f.ok, f.error);
    return { start: s, act: engine.call('finish', { handId: s.handId }) };
}

test('기록 보관소: 엔진 키 → 판 기록이 사슬로 남고, 다시 열어도 끝이 같다', () => {
    const dir = tmpDir();
    const store = new RecordStore(dir);
    const engine = new Engine({ mode: 'dev', allowUnsigned: true, onRecord: (rec, sig) => store.appendHand(rec, sig) });
    store.appendEngineKey(engine.call('info'));
    const { start, act } = playFoldHand(engine);
    assert.ok(act.ok, act.error);
    assert.ok(act.record && act.sig, 'hand closed with a record');

    assert.strictEqual(store.count, 2);
    const entry = store.getHand(start.handId);
    assert.ok(entry, 'hand is in the store');
    assert.strictEqual(entry.kind, 'hand');
    assert.deepStrictEqual(entry.record, act.record);
    // 보관된 기록은 엔진 키로 그대로 검증된다
    const key = store.engineKeys()[0].keys.sig;
    assert.deepStrictEqual(verifyRecord(entry.record, entry.sig, key).errors || [], []);

    const again = new RecordStore(dir);
    assert.strictEqual(again.count, 2);
    assert.strictEqual(again.head, store.head);
    assert.deepStrictEqual(verifyChain(again.range(0, 100), GENESIS, 0), []);
});

test('기록 보관소: 중간 줄을 고치면 다시 열 때 멈추고, 밖에서 받은 줄도 검사에 걸린다', () => {
    const dir = tmpDir();
    const store = new RecordStore(dir);
    const engine = new Engine({ mode: 'dev', allowUnsigned: true, onRecord: (rec, sig) => store.appendHand(rec, sig) });
    store.appendEngineKey(engine.call('info'));
    playFoldHand(engine);
    const entries = store.range(0, 10);
    const forged = JSON.parse(JSON.stringify(entries));
    forged[1].record.result = { tampered: true };
    assert.ok(verifyChain(forged).some((e) => /hash does not match/.test(e)));
    assert.ok(verifyChain([entries[1]]).some((e) => /expected index|prev hash/.test(e)), 'dropping the first line is detected');

    // 프로그램 안에서는 줄을 고칠 수 없다(트리거)
    assert.throws(() => store.db.prepare('UPDATE chain SET line = ? WHERE i = 1').run(JSON.stringify(forged[1])), /append-only/);
    store.close();
    // 트리거를 지우고 DB 를 직접 고쳐도 다시 열 때 사슬 검사에 걸려 뜨지 않는다
    const { DatabaseSync } = require('node:sqlite');
    const raw = new DatabaseSync(path.join(dir, 'buyin.db'));
    raw.exec('DROP TRIGGER chain_no_update');
    raw.prepare('UPDATE chain SET line = ? WHERE i = 1').run(JSON.stringify(forged[1]));
    raw.close();
    assert.throws(() => new RecordStore(dir), /record chain broken/);
});

test('기록 보관소: 기록을 남기지 못하면 판이 닫히지 않는다', () => {
    const engine = new Engine({ mode: 'dev', allowUnsigned: true, onRecord: () => { throw new Error('disk full'); } });
    const { act } = playFoldHand(engine);
    assert.strictEqual(act.ok, false);
    assert.match(act.error, /disk full/);
});

test('기록 보관소: 엔진 키 줄에 증명서 report_data 가 들어간다', () => {
    const store = new RecordStore(tmpDir());
    const keys = new Engine({ mode: 'dev' }).call('info').keys;
    const e = store.appendEngineKey({ name: 'x', version: '0', mode: 'dstack', keys, attestation: { type: 'dstack-tdx', reportData: 'ab'.repeat(32), quote: 'q', appId: 'app' } });
    assert.strictEqual(e.attestation.reportData, 'ab'.repeat(32));
    assert.strictEqual(e.attestation.quote, undefined, 'quote itself is not stored (it is large and re-fetchable)');
    assert.strictEqual(e.keys.sigFp, C.fingerprint(keys.sig));
});

test('기록 보관소: 공개 영수증은 카드 없이 위치·해시만, 내 판은 내 키 지문으로만 찾는다(다시 열어도)', () => {
    const dir = tmpDir();
    const store = new RecordStore(dir);
    const a = C.publicJwk(C.generateKeyPair().publicKey), b = C.publicJwk(C.generateKeyPair().publicKey);
    const rec = (handId, seats) => ({ v: 1, handId, tableId: 't1', endedAt: 1, engine: { sigFp: 'x' }, deck: ['As'], seats });
    store.appendHand(rec('h1', [{ seat: 0, odcId: 'a', keys: { sig: a } }, { seat: 1, odcId: 'b', keys: { sig: b } }]), 'sig1');
    store.appendHand(rec('h2', [{ seat: 0, odcId: 'a', keys: { sig: a } }, { seat: 1, odcId: 'c', keys: null }]), 'sig2');

    const r = store.receipt('h1');
    assert.strictEqual(r.handId, 'h1');
    assert.strictEqual(r.hash, store.getHand('h1').hash);
    assert.strictEqual(r.recordHash, C.sha256hex(C.stableStringify(store.getHand('h1').record)));
    assert.ok(!JSON.stringify(r).includes('"As"'), 'receipt has no cards');
    assert.strictEqual(store.receipt('nope'), null);

    assert.deepStrictEqual(store.handsOfKey(C.fingerprint(a)), ['h2', 'h1']);
    assert.deepStrictEqual(store.handsOfKey(C.fingerprint(b)), ['h1']);
    assert.deepStrictEqual(store.handsOfKey('someone-else'), []);
    const again = new RecordStore(dir);
    assert.deepStrictEqual(again.handsOfKey(C.fingerprint(a)), ['h2', 'h1']);
});

test('기록 보관소: 테이블 공개 기록은 그 테이블의 끝난 판만, 카드·회원 번호 없이 [TABLE_RECORD_2026_11_10]', () => {
    const store = new RecordStore(tmpDir());
    const rec = (handId, tableId) => ({ v: 1, handId, tableId, endedAt: 1, engine: { sigFp: 'x' }, deck: ['As'], seed: 'secretseed',
        seats: [{ seat: 0, odcId: '501', keys: null }, { seat: 3, odcId: '502', keys: null }],
        stacksStart: { 0: 10, 3: 10 }, stacksEnd: { 0: 9.5, 3: 10.45 }, result: { type: 'showdown', rake: { perSeat: [{ seat: 0, fee: 0.025 }, { seat: 3, fee: 0.025 }] } } });
    store.appendHand(rec('tA.1', 'tA'), 's1');
    store.appendHand(rec('tAB.1', 'tAB'), 's2');
    store.appendHand(rec('tA.2', 'tA'), 's3');
    const t = store.tableResults('tA');
    assert.deepStrictEqual(t.map((h) => h.handId), ['tA.1', 'tA.2']);
    assert.deepStrictEqual(t.map((h) => h.handNo), [1, 2]);
    assert.deepStrictEqual(t[0].seats, [{ seat: 0, start: 10, end: 9.5, rake: 0.025 }, { seat: 3, start: 10, end: 10.45, rake: 0.025 }]);
    const txt = JSON.stringify(t);
    assert.ok(!txt.includes('"As"') && !txt.includes('secretseed') && !txt.includes('501'), 'no cards, seed or member numbers');
    assert.strictEqual(t[0].recordHash, store.receipt('tA.1').recordHash);
    assert.deepStrictEqual(store.tableResults('nope'), []);
});
