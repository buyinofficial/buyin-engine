const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { RecordStore, verifyChain } = require('../src/store');

const DAY = 24 * 60 * 60 * 1000;

function tmpDir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'buyin-retention-')); }

/** 날짜를 옮길 수 있는 시계 */
function clockAt(iso) {
    const c = { t: Date.parse(iso) };
    c.now = () => c.t;
    c.days = (n) => { c.t += n * DAY; };
    return c;
}

const KEY = { name: 'buyin-engine', version: 't', mode: 'dev', keys: { sig: { kty: 'EC', x: 'a' }, ecdh: { kty: 'EC', x: 'b' }, sigFp: 'fpA', ecdhFp: 'fpB' } };
const hand = (id) => ({ handId: id, tableId: 't1', seats: [], engine: { sigFp: 'fpA' } });

/** 하루에 판 두 개씩, n 일 동안 */
function fill(store, clock, n) {
    for (let d = 0; d < n; d++) {
        store.appendHand(hand(`h${d}a`), 'sig');
        store.appendHand(hand(`h${d}b`), 'sig');
        clock.days(1);
    }
}

test('보관 기간: 콘솔이 가져가지 않은 기록은 기간이 지나도 지우지 않는다', () => {
    const clock = clockAt('2026-01-01T12:00:00Z');
    const store = new RecordStore(tmpDir(), { now: clock.now });
    store.appendEngineKey(KEY);
    fill(store, clock, 5);
    clock.days(100);
    assert.strictEqual(store.prune(90), null);
    assert.strictEqual(store.headInfo().hands, 10);
});

test('보관 기간: 기간이 지나고 콘솔이 가져간 하루 파일만 지우고, 정리 줄을 남기고, 다시 열어도 사슬이 이어진다', () => {
    const dir = tmpDir();
    const clock = clockAt('2026-01-01T12:00:00Z');
    const store = new RecordStore(dir, { now: clock.now });
    store.appendEngineKey(KEY);              // #0 (1월 1일)
    fill(store, clock, 3);                   // #1~#6 (1월 1~3일)
    clock.days(89);                          // 4월 3일 — 1월 1~2일 파일이 90일을 넘는다
    store.appendHand(hand('late'), 'sig');   // #7
    store.ack(5);                            // 콘솔은 #0~#4 를 가져갔다(1월 3일 #5·#6 은 아직)

    const r = store.prune(90);
    assert.ok(r, 'pruned');
    assert.deepStrictEqual(r.files, ['records-2026-01-01.jsonl', 'records-2026-01-02.jsonl']);
    assert.strictEqual(r.upTo, 5);
    assert.strictEqual(r.hands, 4);
    assert.ok(!fs.existsSync(path.join(dir, 'records-2026-01-01.jsonl')));
    assert.ok(fs.existsSync(path.join(dir, 'records-2026-01-03.jsonl')), 'not yet taken by the console — kept');

    // 정리 줄이 사슬 끝에 있고, 남은 사슬은 기준점에서 이어진다
    const rest = store.range(0, 1000);
    assert.strictEqual(rest[0].i, 5);
    const last = rest[rest.length - 1];
    assert.strictEqual(last.kind, 'prune');
    assert.strictEqual(last.upTo, 5);
    assert.deepStrictEqual(verifyChain(rest, last.lastHash, 5), []);
    assert.strictEqual(store.headInfo().base, 5);
    assert.strictEqual(store.getHand('h0a'), null);
    assert.ok(store.getHand('h2a'));
    // 지운 파일의 엔진 키는 계속 공개된다
    assert.strictEqual(store.engineKeys().filter((e) => e.keys.sigFp === 'fpA').length, 1);

    // 다시 열어도 같은 끝, 같은 기준점
    const again = new RecordStore(dir, { now: clock.now });
    assert.strictEqual(again.count, store.count);
    assert.strictEqual(again.head, store.head);
    assert.strictEqual(again.headInfo().base, 5);
    assert.strictEqual(again.acked, 5);
    assert.strictEqual(again.engineKeys().length, 1);
});

test('보관 기간: 정산이 안 끝난 좌석이 있는 날부터는 지우지 않는다(재시작 정산에 필요)', () => {
    const clock = clockAt('2026-01-01T12:00:00Z');
    const store = new RecordStore(tmpDir(), { now: clock.now });
    store.appendHand(hand('d1'), 'sig');                                     // #0 1월 1일
    clock.days(1);
    store.appendEvent('seat-in', { tid: 'T', sessionId: 'S', tableId: 't1', odcId: 'p', buyIn: 10 });   // #1 1월 2일
    clock.days(1);
    store.appendHand(hand('d3'), 'sig');                                     // #2 1월 3일
    clock.days(100);
    store.appendHand(hand('now'), 'sig');                                    // #3
    store.ack(4);
    const r = store.prune(90);
    assert.deepStrictEqual(r.files, ['records-2026-01-01.jsonl'], 'stops before the open seat');
    // 정산서가 남으면 다음 정리에서 지워진다
    store.appendEvent('settle', { note: { sessionId: 'S', tid: 'T' }, sig: 'x' });
    store.ack(store.count);
    const r2 = store.prune(90);
    assert.deepStrictEqual(r2.files, ['records-2026-01-02.jsonl', 'records-2026-01-03.jsonl']);
});

test('보관 기간: 가져간 위치는 사슬 끝을 넘지 않고 줄지 않는다, 용량이 공개된다', () => {
    const clock = clockAt('2026-01-01T12:00:00Z');
    const store = new RecordStore(tmpDir(), { now: clock.now });
    store.appendHand(hand('a'), 'sig');
    assert.strictEqual(store.ack(999), 1);
    assert.strictEqual(store.ack(0), 1);
    const s = store.storage();
    assert.ok(s.bytes > 0);
    assert.strictEqual(s.files, 1);
    assert.strictEqual(s.oldestDay, '2026-01-01');
    assert.strictEqual(s.acked, 1);
});

test('읽기: from 앞에서 끝나는 파일은 건너뛰어도 결과가 같다', () => {
    const clock = clockAt('2026-01-01T12:00:00Z');
    const store = new RecordStore(tmpDir(), { now: clock.now });
    fill(store, clock, 4);
    assert.deepStrictEqual(store.range(5, 10).map((e) => e.i), [5, 6, 7]);
    assert.deepStrictEqual(store.range(0, 3).map((e) => e.i), [0, 1, 2]);
});
