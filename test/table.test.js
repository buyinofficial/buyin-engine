const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Engine = require('../src/Engine');
const C = require('../src/crypto');
const cards = require('../src/cards');
const { RecordStore, verifyChain } = require('../src/store');
const { verifyRecord } = require('../src/verify');
const { TableServer } = require('../src/table/TableServer');
const { signTicket } = require('../src/table/ticket');

/** 가짜 시계 — 타이머를 시간 순서대로 돌린다 */
function fakeClock() {
    let now = 1_800_000_000_000, seq = 0;
    const timers = new Map();
    return {
        now: () => now,
        setTimeout: (f, ms) => { const id = ++seq; timers.set(id, { at: now + ms, f }); return id; },
        clearTimeout: (id) => timers.delete(id),
        advance(ms) {
            const end = now + ms;
            for (;;) {
                let next = null;
                for (const [id, t] of timers) if (t.at <= end && (!next || t.at < next[1].at)) next = [id, t];
                if (!next) break;
                timers.delete(next[0]); now = next[1].at; next[1].f();
            }
            now = end;
        },
    };
}

/** 브라우저 대신 — 키 두 벌, 받은 이벤트, 연 홀카드 */
function client(server, ticket) {
    const sig = C.generateKeyPair(), ecdh = C.generateKeyPair();
    const me = { sig, ecdh, events: [], holes: {}, closeFns: [] };
    const tb = JSON.parse(Buffer.from(ticket.split('.')[0], 'base64url'));
    const sigJ = C.publicJwk(sig.publicKey);
    const j = server.join(ticket, { sig: sigJ, proof: C.sign(sig.privateKey, C.msgJoin(tb.tid, C.fingerprint(sigJ))) });
    Object.assign(me, j);
    me.conn = { send: (ev, data) => me.events.push([ev, data]), end: () => {}, onClose: (f) => me.closeFns.push(f) };
    server.subscribe(me.token, me.conn);
    const sigJwk = C.publicJwk(sig.publicKey), ecdhJwk = C.publicJwk(ecdh.publicKey);
    const odcId = JSON.parse(Buffer.from(ticket.split('.')[0], 'base64url')).player.odcId;
    me.odcId = odcId;
    const k = server.command(me.token, { type: 'keys', sig: sigJwk, ecdh: ecdhJwk, proof: C.sign(sig.privateKey, C.msgRegister(j.tableId, odcId, C.fingerprint(sigJwk), C.fingerprint(ecdhJwk))) });
    assert.ok(k.ok);
    // 브라우저처럼 — 지금 씨앗 약속에, 그리고 판이 열릴 때마다 다음 약속에 무작위 값을 낸다
    me.entropy = (seedCommit) => {
        const hex = crypto.randomBytes(32).toString('hex');
        try { server.command(me.token, { type: 'entropy', seedCommit, hex, sig: C.sign(sig.privateKey, C.msgEntropy(j.tableId, seedCommit, hex)) }); } catch (_e) { /* 자리를 떴다 */ }
    };
    const send0 = me.conn.send;
    me.conn.send = (ev, data) => { send0(ev, data); if (ev === 'hand' && data && data.nextSeedCommit && !me.noEntropy) me.entropy(data.nextSeedCommit); };
    me.entropy(k.seedCommit);
    return me;
}

function setup(n, room = {}) {
    const consoleKeys = C.generateKeyPair();
    const clock = fakeClock();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'buyin-table-'));
    const store = new RecordStore(dir);
    const out = [];
    const engine = new Engine({ mode: 'dev', onRecord: (r, s) => store.appendHand(r, s) });
    store.appendEngineKey(engine.call('info'));
    const server = new TableServer({ engine, store, consoleKey: consoleKeys.publicKey, outbox: (kind, p) => out.push({ kind, ...p }), clock });
    const R = { id: 'r1', name: 'T', sb: 1, bb: 2, maxPlayers: 9, rake: { percent: 5, minPot: 4 }, turnSec: 20, endsAt: 0, ...room };
    const ticket = (i, buyIn = 200) => signTicket({ v: 1, tid: 'tid_' + i + '_' + crypto.randomBytes(4).toString('hex'), exp: clock.now() + 60000, room: R,
        player: { sessionId: 'sess_' + i + '_' + crypto.randomBytes(4).toString('hex'), odcId: 'u' + i, nickname: 'P' + i }, buyIn, currency: 'USDT' }, consoleKeys.privateKey);
    const players = [];
    for (let i = 0; i < n; i++) players.push(client(server, ticket(i)));
    return { server, engine, store, out, clock, players, ticket, consoleKeys, dir };
}

function lastTurn(p) { const e = [...p.events].reverse().find((x) => x[0] === 'turn'); return e && e[1]; }

/** 차례가 오면 무작위로 행동 — 회원 서명 */
function playOne(env, rnd) {
    const { server, players, clock } = env;
    for (let guard = 0; guard < 400; guard++) {
        const room = server.rooms.get('r1');
        if (!room || !room.hand) return;
        const h = room.hand;
        if (h.toAct === null) { clock.advance(10); continue; }
        const p = players.find((x) => x.seat === h.toAct);
        const t = lastTurn(p);
        const choices = t.toCall > 0 ? ['FOLD', 'CALL', 'CALL', 'RAISE', 'ALL_IN'] : ['CHECK', 'CHECK', 'BET', 'ALL_IN'];
        const action = choices[rnd(choices.length)];
        const amount = action === 'RAISE' || action === 'BET' ? Math.min(t.maxBet, t.minRaise + rnd(6)) : 0;
        const r = server.command(p.token, { type: 'act', q: t.q, action, amount, sig: C.sign(p.sig.privateKey, C.msgAction(t.handId, t.q, action, amount)) });
        assert.ok(r.ok);
    }
    assert.fail('hand did not end');
}

test('테이블: 좌석표로 앉아 판이 TEE 안에서만 돈다 — 카드는 본인 봉투로만, 칩·레이크 보존, 정산서 서명', () => {
    const rnd = (n) => crypto.randomInt(n);
    const env = setup(4);
    const { server, out, clock, players, engine } = env;
    const engineKey = C.importPublicJwk(engine.call('info').keys.sig);
    const corePub = engineKey && C.importPublicJwk(engine.call('info').keys.ecdh);
    let handsDone = 0;
    for (let g = 0; g < 40; g++) {
        clock.advance(8000);   // 결과 4초 + 다음 판 3초
        const room = server.rooms.get('r1');
        if (!room || !room.hand) break;
        const hid = room.hand.handId;
        // 각자 받은 봉투는 자기 키로만 열리고 약속과 맞는다. 남의 홀카드는 어떤 이벤트에도 없다
        for (const p of players.filter((x) => room.seats[x.seat])) {
            const hole = [...p.events].reverse().find((x) => x[0] === 'hole' && x[1].handId === hid);
            if (!hole) continue;
            const pay = C.openEnvelope(p.ecdh.privateKey, corePub, hid, hole[1].envelope);
            const pub = [...p.events].reverse().find((x) => x[0] === 'hand' && x[1].handId === hid)[1];
            for (const op of pay.cards) assert.ok(cards.checkOpening(hid, pub.commitments, op));
            p.holes[hid] = pay.cards.map((x) => x.c);
        }
        playOne(env, rnd);
        handsDone++;
    }
    const left = server.rooms.get('r1') ? server.rooms.get('r1').seats.filter((x) => x && x.stack > 0).length : 0;
    assert.ok(handsDone >= 1 && (handsDone === 40 || left < 2), `hands ${handsDone}, players left ${left}`);
    assert.strictEqual(env.out.filter((x) => x.kind === 'hand-record').length, handsDone, '판마다 기록이 콘솔로 간다');
    // 판 도중 남의 카드가 나간 적 없다: 'hole' 이벤트는 받는 사람 자기 좌석 것뿐, 공개 홀카드는 런아웃·쇼다운 결과에만
    for (const p of players) {
        for (const [ev, d] of p.events) {
            if (ev === 'hole' && d.envelope) assert.doesNotThrow(() => C.openEnvelope(p.ecdh.privateKey, corePub, d.handId, d.envelope));
            if (ev === 'hand' || ev === 'turn' || ev === 'action' || ev === 'board') assert.ok(!JSON.stringify(d).match(/"holes?"\s*:\s*\{"\d+"/), `${ev} carries hole cards`);
        }
    }
    // 모두 일어난다 → 정산서 합 = 바이인 합 − 레이크
    for (const p of players) if (server.rooms.get('r1') && server.rooms.get('r1').seats[p.seat]) server.command(p.token, { type: 'leave' });
    clock.advance(30000);
    const settles = out.filter((x) => x.kind === 'settle');
    assert.strictEqual(settles.length, 4);
    const records = out.filter((x) => x.kind === 'hand-record');
    const rake = records.reduce((s, r) => s + ((r.record.result.rake && r.record.result.rake.totalRake) || 0), 0);
    const cashOut = settles.reduce((s, x) => s + x.note.cashOut, 0);
    assert.ok(Math.abs(4 * 200 - cashOut - rake) < 1e-6, `buy-in 800 = cash-out ${cashOut} + rake ${rake}`);
    assert.ok(Math.abs(settles.reduce((s, x) => s + x.note.rakePaid, 0) - rake) < 1e-6, '세션별 레이크 합 = 판 기록 레이크 합');
    for (const s of settles) assert.ok(C.verify(engineKey, 'buyin-note-v1|' + C.stableStringify(s.note), s.sig), '정산서 엔진 서명');
    for (const r of records) {
        assert.strictEqual(r.record.strictOrder, true);
        assert.deepStrictEqual(verifyRecord(r.record, r.sig, engine.call('info').keys.sig).errors, []);
    }
    assert.deepStrictEqual(verifyChain(env.store.range(0, 1e9)), []);
});

test('테이블: 차례 밖 액션·남의 토큰·옛 차례 번호는 거절, 시간 초과는 폴드만 하고 자리는 그대로, 연속 3번이면 탈락(판이 끝나면 정산)', () => {
    const env = setup(3);
    const { server, clock, players } = env;
    clock.advance(5000);
    const h = server.rooms.get('r1').hand;
    const turn = lastTurn(players[0]);
    const other = players.find((p) => p.seat !== turn.seat);
    assert.throws(() => server.command(other.token, { type: 'act', q: turn.q, action: 'FOLD', amount: 0, sig: C.sign(other.sig.privateKey, C.msgAction(turn.handId, turn.q, 'FOLD', 0)) }), /not your turn/);
    assert.throws(() => server.command('nope', { type: 'act' }), /unknown token/);
    const actor = players.find((p) => p.seat === turn.seat);
    assert.throws(() => server.command(actor.token, { type: 'act', q: turn.q + 5, action: 'FOLD', amount: 0, sig: 'x' }), /stale turn/);
    // 아무도 안 움직이면 — 차례마다 시간 초과 → 폴드, 마지막 한 명이 팟을 가져가고 판이 끝난다. 아무도 일어나지 않는다
    const room = server.rooms.get('r1');
    for (let i = 0; i < 4 && !env.out.some((x) => x.kind === 'hand-record'); i++) clock.advance(21000);
    assert.ok(env.out.some((x) => x.kind === 'hand-record'), '판은 끝까지 갔다');
    clock.advance(10000);
    assert.strictEqual(env.out.filter((x) => x.kind === 'settle').length, 0, '한 번 시간 초과로는 일어나지 않는다');
    assert.strictEqual(room.seats.filter(Boolean).length, 3);
    assert.ok(room.hand && room.hand.handId !== h.handId, '다음 판이 시작됐다');
    // 직접 한 번 행동하면 횟수는 0
    const t2 = lastTurn(players[0]);
    const keeper = players.find((p) => p.seat === t2.seat);
    server.command(keeper.token, { type: 'act', q: t2.q, action: 'FOLD', amount: 0, sig: C.sign(keeper.sig.privateKey, C.msgAction(t2.handId, t2.q, 'FOLD', 0)) });
    assert.strictEqual(room.seats[keeper.seat].timeouts, 0);
    // 계속 방치하면 연속 3번째에 탈락해 정산된다
    for (let i = 0; i < 60 && room.seats.filter(Boolean).length > 1; i++) clock.advance(21000);
    const settled = env.out.filter((x) => x.kind === 'settle');
    assert.ok(settled.filter((x) => x.note.reason === 'timeout').length >= 2, '연속 시간 초과한 사람은 탈락해 정산된다');
    assert.ok(room.seats.filter(Boolean).length <= 1);
});

test('테이블: 좌석표 — 콘솔 서명·만료·재사용·규칙 불일치', () => {
    const env = setup(2);
    const { server, ticket, clock, consoleKeys } = env;
    const t = ticket(7);
    const kp = C.generateKeyPair(), jwk = C.publicJwk(kp.publicKey);
    server.join(t, { sig: jwk, proof: C.sign(kp.privateKey, C.msgJoin(JSON.parse(Buffer.from(t.split('.')[0], 'base64url')).tid, C.fingerprint(jwk))) });
    assert.throws(() => server.join(t), /already used/);
    const forged = signTicket({ v: 1, tid: 'tid_forged_1', exp: clock.now() + 1000, room: { id: 'r1', sb: 1, bb: 2, maxPlayers: 9, rake: { percent: 5, minPot: 4 }, turnSec: 20 }, player: { sessionId: 'sess_forged_1', odcId: 'evil' }, buyIn: 1e6 }, C.generateKeyPair().privateKey);
    assert.throws(() => server.join(forged), /not the console/);
    const expired = signTicket({ v: 1, tid: 'tid_exp_00001', exp: clock.now() - 1, room: { id: 'r1', sb: 1, bb: 2, maxPlayers: 9, rake: { percent: 5, minPot: 4 }, turnSec: 20 }, player: { sessionId: 'sess_exp_0001', odcId: 'x9' }, buyIn: 10 }, consoleKeys.privateKey);
    assert.throws(() => server.join(expired), /expired/);
    const other = signTicket({ v: 1, tid: 'tid_rules_0001', exp: clock.now() + 1000, room: { id: 'r1', sb: 1, bb: 2, maxPlayers: 9, rake: { percent: 10, minPot: 4 }, turnSec: 20 }, player: { sessionId: 'sess_rules_001', odcId: 'x8' }, buyIn: 10 }, consoleKeys.privateKey);
    assert.throws(() => server.join(other), /rules differ/);
});

test('테이블: 엔진이 다시 떠도 좌석의 돈은 마지막으로 끝난 판 스택으로 정산되고, 쓴 좌석표는 다시 못 쓴다', () => {
    const rnd = (n) => crypto.randomInt(n);
    const env = setup(2);
    const { server, clock, store, ticket } = env;
    clock.advance(5000); playOne(env, rnd);
    clock.advance(8000);                       // 둘째 판 시작 → 진행 중에 "재시작"
    const room = server.rooms.get('r1');
    const stacksAfterFirst = room.seats.filter(Boolean).map((s) => s.stack);
    const usedTid = [...server.usedTickets][0];
    // 새 엔진·새 테이블 서버가 같은 사슬을 연다
    const out2 = [];
    const engine2 = new Engine({ mode: 'dev' });
    const server2 = new TableServer({ engine: engine2, store: new RecordStore(env.dir), consoleKey: env.consoleKeys.publicKey, outbox: (k, p) => out2.push({ kind: k, ...p }), clock });
    const settles = out2.filter((x) => x.kind === 'settle');
    assert.strictEqual(settles.length, stacksAfterFirst.length, '재시작 때 앉아 있던 좌석 수만큼(이미 일어난 좌석은 정산 끝)');
    assert.deepStrictEqual(settles.map((x) => x.note.cashOut).sort(), stacksAfterFirst.sort(), '진행 중이던 판은 무효 — 판 전 스택');
    assert.ok(settles.every((x) => x.note.reason === 'engine-restart'));
    assert.ok(server2.usedTickets.has(usedTid));
    void store; void ticket;
});

test('테이블: 이번 씨앗 약속에 무작위 값을 낸 좌석만 판에 든다 — 덱은 TEE 씨앗 + 판에 든 모든 회원의 값', () => {
    const rnd = () => 1;   // 콜·체크만 — 아무도 파산하지 않게
    const env = setup(3);
    const { server, clock, players } = env;
    players[2].noEntropy = true;   // 셋째는 다음 판부터 값을 내지 않는다
    clock.advance(8000);
    const r1 = server.rooms.get('r1').hand;
    assert.ok(r1 && r1.seats.length === 3, 'first hand: all three gave entropy');
    playOne(env, rnd);
    clock.advance(8000);
    const r2 = server.rooms.get('r1').hand;
    assert.ok(r2, 'second hand started');
    assert.ok(!r2.seats.includes(players[2].seat), 'seat without entropy sits the hand out');
    // 판 기록의 entropy 에 판에 든 회원 전원의 값이 있다
    playOne(env, rnd);
    const rec = env.out.filter((x) => x.kind === 'hand-record').pop().record;
    assert.deepStrictEqual(rec.entropy.map((e) => e.odcId).sort(), rec.seats.map((s) => s.odcId).sort());
    // 다시 값을 내면 다음 판에 든다
    players[2].entropy(server.rooms.get('r1').seedCommit);
    clock.advance(8000);
    assert.ok(server.rooms.get('r1').hand.seats.includes(players[2].seat), 'back in after giving entropy');
});

test('테이블: 같은 회원이 본인 키로 새 세션에 들어오면 기존 자리 탈락(정산 뒤 다시 앉음), 앉은 뒤 서명 키가 바뀌어도 탈락', () => {
    const env = setup(0);
    const { server, consoleKeys, clock } = env;
    const R = { id: 'r1', name: 'T', sb: 1, bb: 2, maxPlayers: 9, rake: { percent: 5, minPot: 4 }, turnSec: 20, endsAt: 0 };
    const mk = () => signTicket({ v: 1, tid: 'tid_x_' + crypto.randomBytes(4).toString('hex'), exp: clock.now() + 60000, room: R,
        player: { sessionId: 'sess_x_' + crypto.randomBytes(4).toString('hex'), odcId: 'p1', nickname: 'P' }, buyIn: 100, currency: 'USDT' }, consoleKeys.privateKey);
    const auth = (tk, kp) => { const tb = JSON.parse(Buffer.from(tk.split('.')[0], 'base64url')); const jwk = C.publicJwk(kp.publicKey); return { sig: jwk, proof: C.sign(kp.privateKey, C.msgJoin(tb.tid, C.fingerprint(jwk))) }; };
    const me = C.generateKeyPair(), other = C.generateKeyPair();
    const t1 = mk(); const j1 = server.join(t1, auth(t1, me));
    // 다른 키로 같은 회원이 들어오려 하면 기존 자리는 그대로, 새 접속만 거절
    const t2 = mk(); assert.throws(() => server.join(t2, auth(t2, other)), /already at this table/);
    assert.ok(server.rooms.get('r1').seats.some((s) => s && s.token === j1.token));
    // 본인 키로 새 세션 → 기존 자리 탈락, 정산 뒤 같은 좌석표로 다시 앉는다
    const t3 = mk(); assert.throws(() => server.join(t3, auth(t3, me)), /previous session closed/);
    assert.ok(env.out.some((x) => x.kind === 'settle' && x.note.reason === 'replaced'));
    const j3 = server.join(t3, auth(t3, me)); assert.ok(j3.token);
    // 앉은 뒤 다른 서명 키로 바꿔 끼우면 그 자리 탈락
    const ecdh = C.generateKeyPair(); const oj = C.publicJwk(other.publicKey), ej = C.publicJwk(ecdh.publicKey);
    assert.throws(() => server.command(j3.token, { type: 'keys', sig: oj, ecdh: ej, proof: C.sign(other.privateKey, C.msgRegister(j3.tableId, 'p1', C.fingerprint(oj), C.fingerprint(ej))) }), /signing key changed/);
    assert.ok(env.out.some((x) => x.kind === 'settle' && x.note.reason === 'auth-changed'));
});

test('테이블: 한 명이 나가거나 끊겨도 판은 이어진다 — 끊긴 채 시간이 지나면 탈락, 올인이면 결과까지 유지', () => {
    const env = setup(3);
    const { server, clock, players } = env;
    server.disconnectGraceMs = 60000;
    clock.advance(5000);
    const room = server.rooms.get('r1');
    const h1 = room.hand.handId;
    // 차례가 아닌 사람이 나간다 → 그 사람만 폴드, 판은 계속
    const quitter = players.find((p) => p.seat !== room.hand.toAct);
    const r = server.command(quitter.token, { type: 'leave' });
    assert.ok(r.pending, '판 도중 나가기 — 판이 끝나면 정산');
    playOne(env, () => 1);
    assert.ok(env.out.some((x) => x.kind === 'hand-record' && x.record.handId === h1), '나머지끼리 판을 끝냈다');
    assert.ok(env.out.some((x) => x.kind === 'settle' && x.note.odcId === quitter.odcId));
    // 다음 판이 남은 두 명으로 시작된다
    clock.advance(8000);
    assert.ok(room.hand && room.hand.seats.length === 2, 'next hand with the remaining two');
    // 한 명이 끊긴다(화면 연결 닫힘) → 60초 안에 안 돌아오면 탈락, 판은 계속
    const left = players.filter((p) => room.seats[p.seat]);
    const drop = left[0];
    for (const f of drop.closeFns) f();
    clock.advance(61000);
    assert.ok(env.out.some((x) => x.kind === 'settle' && x.note.odcId === drop.odcId && x.note.reason === 'disconnected'), '끊긴 채 시간이 지나 탈락');
});

test('테이블: 한 좌석에 붙는 이벤트 연결은 3개까지', () => {
    const env = setup(1);
    const { server, players } = env;
    const p = players[0];
    const conn = () => ({ send: () => {}, end: () => {}, onClose: () => {} });
    server.subscribe(p.token, conn()); server.subscribe(p.token, conn());   // 이미 1개 + 2개 = 3개
    assert.throws(() => server.subscribe(p.token, conn()), /too many connections/);
});

test('테이블: 타임뱅크 — 앉을 때 3장, 내 차례에 한 차례 한 장, 마감 +20초, 남의 차례엔 안 됨', () => {
    const env = setup(2);
    const { server, clock, players } = env;
    clock.advance(5000);
    const room = server.rooms.get('r1');
    const turn = lastTurn(players[0]);
    const me = players.find((p) => p.seat === turn.seat), other = players.find((p) => p.seat !== turn.seat);
    assert.throws(() => server.command(other.token, { type: 'timebank' }), /not your turn/);
    const before = room.hand.deadline;
    const r = server.command(me.token, { type: 'timebank' });
    assert.strictEqual(r.left, 2);
    assert.strictEqual(room.hand.deadline, before + 20000);
    assert.throws(() => server.command(me.token, { type: 'timebank' }), /already used this turn/);
    assert.ok(other.events.some(([ev, d]) => ev === 'timebank' && d.seat === me.seat && d.left === 2), '같은 방에 알린다');
    // 원래 마감(20초)이 지나도 시간 초과가 아니다 — 늘어난 마감에서만
    clock.advance(25000);
    assert.strictEqual(room.hand.toAct, me.seat, '아직 내 차례');
    clock.advance(16000);
    assert.notStrictEqual(room.hand && room.hand.handId === turn.handId && room.hand.toAct, me.seat);
    assert.strictEqual(server.snapshot(room, room.seats[me.seat]).me.timeBank, 2);
});

test('테이블: 이모티콘·채팅 — 같은 방 좌석에만 전달, 목록 밖·빈 글·도배는 거절, 기록·콘솔로 가지 않는다', () => {
    const env = setup(2);
    const { server, clock, players, out } = env;
    const [a, b] = players;
    assert.ok(server.command(a.token, { type: 'emote', id: 'clap' }).ok);
    assert.ok(b.events.some(([ev, d]) => ev === 'emote' && d.seat === a.seat && d.id === 'clap'));
    assert.throws(() => server.command(a.token, { type: 'emote', id: 'clap' }), /too fast/);
    assert.throws(() => server.command(a.token, { type: 'emote', id: '<img>' }), /unknown emote/);
    clock.advance(500);
    assert.ok(server.command(a.token, { type: 'chat', text: '  안녕\u0000하세요  ' + 'x'.repeat(300) }).ok);
    const msg = b.events.find(([ev]) => ev === 'chat')[1];
    assert.strictEqual(msg.seat, a.seat);
    assert.ok(msg.text.startsWith('안녕 하세요') && msg.text.length === 200, '제어문자 없애고 200자');
    assert.throws(() => server.command(a.token, { type: 'chat', text: 'again' }), /too fast/);
    assert.throws(() => server.command(a.token, { type: 'chat', text: '   ' }), /empty/);
    for (let i = 0; i < 5; i++) { clock.advance(450); server.command(b.token, { type: 'chat', text: 'm' + i }); }
    clock.advance(450);
    assert.throws(() => server.command(b.token, { type: 'chat', text: 'sixth' }), /too fast/, '5초에 5개까지');
    assert.ok(!out.some((x) => JSON.stringify(x).includes('안녕')), '콘솔로 나가지 않는다');
    assert.ok(!JSON.stringify(env.store.range(0, 1e9)).includes('안녕'), '기록 사슬에 남지 않는다');
});

test('테이블: 팁 — 본인 서명·번호 필수, 프리플랍에서만, BB 1개, 판이 끝난 뒤 옮김(사슬에 서명째 남음), 방 전체 돈은 그대로', () => {
    const env = setup(3);
    const { server, clock, players } = env;
    clock.advance(5000);
    const room = server.rooms.get('r1');
    const [a, b] = players;
    const tableId = room.tableId;
    const sign = (p, n, to, type, amount) => C.sign(p.sig.privateKey, C.msgTip(tableId, p.odcId, n, to.odcId, type, amount));
    const before = room.seats.filter(Boolean).reduce((x, s) => x + s.stack, 0);
        assert.throws(() => server.command(a.token, { type: 'tip', to: b.seat, gift: 'flower', n: 1, sig: sign(b, 1, b, 'flower', 2) }), /bad tip signature/, '남의 키로는 못 보낸다');
    assert.throws(() => server.command(a.token, { type: 'tip', to: b.seat, gift: 'flower', n: 1, sig: sign(a, 1, b, 'flower', 99) }), /bad tip signature/, '금액은 서버가 정한다(BB)');
    assert.throws(() => server.command(a.token, { type: 'tip', to: a.seat, gift: 'flower', n: 1, sig: sign(a, 1, a, 'flower', 2) }), /bad tip target/);
    assert.throws(() => server.command(a.token, { type: 'tip', to: b.seat, gift: 'gold', n: 1, sig: sign(a, 1, b, 'gold', 2) }), /unknown tip type/);
    assert.ok(server.command(a.token, { type: 'tip', to: b.seat, gift: 'flower', n: 1, sig: sign(a, 1, b, 'flower', 2) }).ok);
    assert.ok(b.events.some(([ev, d]) => ev === 'tip' && d.from === a.seat && d.to === b.seat && d.amount === 2));
    assert.throws(() => server.command(a.token, { type: 'tip', to: b.seat, gift: 'flower', n: 1, sig: sign(a, 1, b, 'flower', 2) }), /stale tip number/, '같은 서명 다시 쓰기 불가');
    assert.throws(() => server.command(a.token, { type: 'tip', to: b.seat, gift: 'kiss', n: 2, sig: sign(a, 2, b, 'kiss', 2) }), /too fast/);
    // 판이 끝나기 전에는 칩이 그대로
    const aStack = room.seats[a.seat].stack, bStack = room.seats[b.seat].stack;
    const handId = room.hand.handId;
    for (let i = 0; i < 6 && room.hand && room.hand.handId === handId; i++) clock.advance(21000);
    const done = b.events.find(([ev]) => ev === 'tip-done');
    assert.ok(done, '판이 끝나면 옮긴다');
    const rec = env.out.filter((x) => x.kind === 'hand-record').pop().record;
    assert.strictEqual(room.seats[a.seat].stack, Math.round((rec.stacksEnd[a.seat] - 2) * 1000) / 1000);
    assert.strictEqual(room.seats[b.seat].stack, Math.round((rec.stacksEnd[b.seat] + 2) * 1000) / 1000);
    void aStack; void bStack;
    const tipLine = env.store.range(0, 1e9).find((e) => e.kind === 'tip');
    assert.ok(tipLine && tipLine.amount === 2 && C.verify(C.importPublicJwk(tipLine.sigJwk), C.msgTip(tableId, a.odcId, 1, b.odcId, 'flower', 2), tipLine.sig), '사슬의 팁 줄은 보낸 사람 서명으로 확인된다');
    const rake = env.out.filter((x) => x.kind === 'hand-record').reduce((x, r) => x + ((r.record.result.rake && r.record.result.rake.totalRake) || 0), 0);
    const after = room.seats.filter(Boolean).reduce((x, s) => x + s.stack, 0);
    assert.ok(Math.abs(before - rake - after) < 1e-6, '방 전체 돈 = 이전 − 레이크');
    // 프리플랍이 아니면 거절
    clock.advance(8000);
    if (room.hand) { room.hand.stage = 'flop'; clock.advance(3100); assert.throws(() => server.command(a.token, { type: 'tip', to: b.seat, gift: 'kiss', n: 2, sig: sign(a, 2, b, 'kiss', 2) }), /pre-flop/); }
});

test('테이블: 팁을 옮긴 뒤 엔진이 다시 떠도 정산서에 팁이 반영된다(사슬의 팁 줄로 다시 계산)', () => {
    const env = setup(2);
    const { server, clock, players } = env;
    clock.advance(5000);
    const room = server.rooms.get('r1');
    const [a, b] = players;
    const sig = C.sign(a.sig.privateKey, C.msgTip(room.tableId, a.odcId, 1, b.odcId, 'champagne', 2));
    assert.ok(server.command(a.token, { type: 'tip', to: b.seat, gift: 'champagne', n: 1, sig }).ok);
    const handId = room.hand.handId;
    for (let i = 0; i < 6 && room.hand && room.hand.handId === handId; i++) clock.advance(21000);
    assert.ok(b.events.some(([ev]) => ev === 'tip-done'));
    const want = Object.fromEntries(room.seats.filter(Boolean).map((s) => [s.odcId, s.stack]));
    const out2 = [];
    new TableServer({ engine: new Engine({ mode: 'dev' }), store: new RecordStore(env.dir), consoleKey: env.consoleKeys.publicKey, outbox: (k, p) => out2.push({ kind: k, ...p }), clock });
    const got = Object.fromEntries(out2.filter((x) => x.kind === 'settle').map((x) => [x.note.odcId, x.note.cashOut]));
    assert.deepStrictEqual(got, want);
});
