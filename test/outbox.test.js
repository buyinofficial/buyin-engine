const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { RecordStore } = require('../src/store');
const { Outbox } = require('../src/outbox');

function tmpDir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'buyin-outbox-')); }
const hand = (id) => ({ handId: id, tableId: 't1', seats: [] });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/** 받은 줄을 번호대로만 받는 콘솔 — 빠지면 다음 번호를 답한다 */
function fakeConsole() {
    const c = { next: 0, got: [], fail: 0, calls: 0 };
    c.fetch = async (url, opt) => {
        c.calls += 1;
        assert.strictEqual(opt.headers.Authorization, 'Bearer tok');
        if (c.fail > 0) { c.fail -= 1; throw new Error('network down'); }
        const body = JSON.parse(opt.body);
        for (const e of body.entries) if (e.i === c.next) { c.got.push(e); c.next += 1; }
        return { ok: true, status: 200, json: async () => ({ ok: true, next: c.next }) };
    };
    return c;
}

test('보내기: 쓴 줄을 순서대로 콘솔에 보내고, 보낸 위치를 남긴다', async () => {
    const dir = tmpDir();
    const store = new RecordStore(dir);
    const con = fakeConsole();
    const box = new Outbox({ store, url: 'http://console/x', token: 'tok', fetch: con.fetch });
    box.start();
    for (let k = 0; k < 120; k++) store.appendHand(hand('h' + k), 'sig');
    for (let t = 0; t < 100 && con.next < 120; t++) await wait(20);
    box.stop();
    assert.strictEqual(con.next, 120);
    assert.deepStrictEqual(con.got.map((e) => e.i), [...Array(120).keys()]);
    assert.strictEqual(new RecordStore(dir).sent, 120, 'sent position survives a restart');
});

test('보내기: 실패하면 다시 보내고, 콘솔에 빠진 게 있으면 그 번호부터 다시 보낸다', async () => {
    const store = new RecordStore(tmpDir());
    const con = fakeConsole();
    con.fail = 1;
    const box = new Outbox({ store, url: 'http://console/x', token: 'tok', fetch: con.fetch });
    store.appendHand(hand('a'), 'sig');
    box.start();
    for (let t = 0; t < 200 && con.next < 1; t++) await wait(20);   // 첫 시도 실패 → 2초 뒤 다시
    assert.strictEqual(con.next, 1);
    // 콘솔이 #1 을 잃었다고 하자 — 다음 보낼 때 next=1 을 답하면 #1 부터 다시 보낸다
    store.appendHand(hand('b'), 'sig');
    for (let t = 0; t < 100 && con.next < 2; t++) await wait(20);
    con.next = 1; con.got = con.got.filter((e) => e.i < 1);
    store.appendHand(hand('c'), 'sig');
    for (let t = 0; t < 100 && con.next < 3; t++) await wait(20);
    box.stop();
    assert.deepStrictEqual(con.got.map((e) => e.i), [0, 1, 2]);
});

test('보관 기간: 지난 날이고 이미 보낸 하루 파일만 지운다, 다시 열어도 남은 사슬이 이어진다', () => {
    const dir = tmpDir();
    const store = new RecordStore(dir);
    for (let k = 0; k < 4; k++) store.appendHand(hand('h' + k), 'sig');
    // 앞 두 줄을 옛 날짜 파일로 옮긴다
    const today = store.files()[0];
    const lines = fs.readFileSync(path.join(dir, today), 'utf8').split('\n').filter(Boolean);
    fs.writeFileSync(path.join(dir, 'records-2020-01-01.jsonl'), lines.slice(0, 2).join('\n') + '\n');
    fs.writeFileSync(path.join(dir, today), lines.slice(2).join('\n') + '\n');
    const s = new RecordStore(dir);
    assert.deepStrictEqual(s.prune(90), [], 'not sent yet — kept');
    s.markSent(2);
    assert.deepStrictEqual(s.prune(90), ['records-2020-01-01.jsonl']);
    assert.strictEqual(s.getHand('h0'), null);
    assert.ok(s.getHand('h2'));
    const again = new RecordStore(dir);
    assert.strictEqual(again.count, 4);
    assert.strictEqual(again.first, 2);
    assert.strictEqual(again.head, s.head);
    assert.ok(again.storage().bytes > 0);
});

test('보내기: 평소에는 기록 파일을 다시 읽지 않는다(새 줄은 메모리 대기열에서)', async () => {
    const store = new RecordStore(tmpDir());
    const con = fakeConsole();
    let reads = 0;
    const range = store.range.bind(store);
    store.range = (...a) => { reads += 1; return range(...a); };
    const box = new Outbox({ store, url: 'http://console/x', token: 'tok', fetch: con.fetch });
    box.start();
    for (let t = 0; t < 50 && con.calls < 1; t++) await wait(10);
    const before = reads;
    for (let k = 0; k < 30; k++) { store.appendHand(hand('q' + k), 'sig'); await wait(5); }
    for (let t = 0; t < 100 && con.next < 30; t++) await wait(10);
    box.stop();
    assert.strictEqual(con.next, 30);
    assert.strictEqual(reads, before, 'no file reads while the queue follows the sent position');
});

test('보관소: 다시 열어도 판은 바이트 위치로 그 줄만 읽고, 엔진 키 목록이 같다', () => {
    const dir = tmpDir();
    const store = new RecordStore(dir);
    store.appendEngineKey({ name: 'e', version: 't', mode: 'dev', keys: { sig: { kty: 'EC', x: 'a' }, ecdh: { kty: 'EC', x: 'b' }, sigFp: 'A', ecdhFp: 'B' } });
    for (let k = 0; k < 20; k++) store.appendHand({ handId: 'z' + k, tableId: 't', seats: [], note: '한글 ' + 'x'.repeat(k) }, 'sig');
    const again = new RecordStore(dir);
    for (const id of ['z0', 'z7', 'z19']) assert.deepStrictEqual(again.getHand(id), store.getHand(id));
    assert.strictEqual(again.getHand('z7').record.note, '한글 xxxxxxx');
    assert.strictEqual(again.engineKeys().length, 1);
    assert.deepStrictEqual(again.range(15, 3).map((e) => e.i), [15, 16, 17]);
});
