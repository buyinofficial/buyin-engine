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
    me.conn.send = (ev, data) => {
        send0(ev, data);
        if (ev === 'hand' && data && data.nextSeedCommit && !me.noEntropy) me.entropy(data.nextSeedCommit);
        // [READY_SESSION_0_10_6] 브라우저에서 「준비 완료」를 누르는 회원 — 게이트가 열리면 누른다(noReady 면 직접)
        if (ev === 'gate' && data && data.active && !me.noReady && !me.readyQueued && (data.players || []).some((x) => x.seat === me.seat && !x.ready)) {
            me.readyQueued = true;
            server.clock.setTimeout(() => { me.readyQueued = false; if (!me.noReady) { try { server.command(me.token, { type: 'ready' }); } catch (_e) { /* 자리를 떴다 */ } } }, 0);
        }
    };
    me.entropy(k.seedCommit);
    if (client.noReady) me.noReady = true;
    else { try { server.command(me.token, { type: 'ready' }); } catch (_e) { /* */ } }
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

/**
 * 다음 판이 시작될 때까지 시계를 민다 — 결과 4초 + 쇼다운 연출(최대 약 9초, [SHOWDOWN_SEQ_0_10_4]) + 다음 판 3초.
 * 종전엔 8초 고정이었다. 0.5초씩 밀어 판이 열리면 멈춘다(최대 20초 — 차례 시간 20초를 넘기지 않게)
 */
function waitHand(clock, getRoom) {
    for (let i = 0; i < 40; i++) {
        clock.advance(500);
        const room = getRoom();
        if (room && room.hand && !room.hand.__seen) { room.hand.__seen = true; return; }
    }
}

test('테이블: 좌석표로 앉아 판이 TEE 안에서만 돈다 — 카드는 본인 봉투로만, 칩·레이크 보존, 정산서 서명', () => {
    const rnd = (n) => crypto.randomInt(n);
    const env = setup(4);
    const { server, out, clock, players, engine } = env;
    const engineKey = C.importPublicJwk(engine.call('info').keys.sig);
    const corePub = engineKey && C.importPublicJwk(engine.call('info').keys.ecdh);
    let handsDone = 0;
    for (let g = 0; g < 40; g++) {
        waitHand(clock, () => server.rooms.get('r1'));   // 결과 4초 + 다음 판 3초
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

test('테이블: 차례 밖 액션·남의 토큰·옛 차례 번호는 거절, 시간 초과는 폴드만 하고 자리는 그대로, 연속 5번이면 탈락(판이 끝나면 정산)', () => {
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
    // 계속 방치하면 연속 5번째에 탈락해 정산된다 [TIMEOUT_KICK5_0_10_11]
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
    waitHand(clock, () => server.rooms.get('r1'));                       // 둘째 판 시작 → 진행 중에 "재시작"
    const room = server.rooms.get('r1');
    const stacksAfterFirst = room.seats.filter((s) => s && !s.held).map((s) => s.stack);   // [REBUY_0_10_1] 칩 0 으로 잡아 둔 자리는 이미 정산했다
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
    waitHand(clock, () => server.rooms.get('r1'));
    const r1 = server.rooms.get('r1').hand;
    assert.ok(r1 && r1.seats.length === 3, 'first hand: all three gave entropy');
    playOne(env, rnd);
    waitHand(clock, () => server.rooms.get('r1'));
    const r2 = server.rooms.get('r1').hand;
    assert.ok(r2, 'second hand started');
    assert.ok(!r2.seats.includes(players[2].seat), 'seat without entropy sits the hand out');
    // 판 기록의 entropy 에 판에 든 회원 전원의 값이 있다
    playOne(env, rnd);
    const rec = env.out.filter((x) => x.kind === 'hand-record').pop().record;
    assert.deepStrictEqual(rec.entropy.map((e) => e.odcId).sort(), rec.seats.map((s) => s.odcId).sort());
    // 다시 값을 내면 다음 판에 든다
    players[2].entropy(server.rooms.get('r1').seedCommit);
    waitHand(clock, () => server.rooms.get('r1'));
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
    waitHand(clock, () => server.rooms.get('r1'));
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
    const sign = (p, n, to, type, amount) => C.sign(p.sig.privateKey, C.msgTip(tableId, p.odcId, n, to.seat, type, amount));
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
    assert.ok(tipLine && tipLine.amount === 2 && C.verify(C.importPublicJwk(tipLine.sigJwk), C.msgTip(tableId, a.odcId, 1, b.seat, 'flower', 2), tipLine.sig), '사슬의 팁 줄은 보낸 사람 서명으로 확인된다');
    const rake = env.out.filter((x) => x.kind === 'hand-record').reduce((x, r) => x + ((r.record.result.rake && r.record.result.rake.totalRake) || 0), 0);
    const after = room.seats.filter(Boolean).reduce((x, s) => x + s.stack, 0);
    assert.ok(Math.abs(before - rake - after) < 1e-6, '방 전체 돈 = 이전 − 레이크');
    // [TIP_TURN_0_10_11] 리버에서는 거절(프리플랍·플랍·턴은 된다)
    waitHand(clock, () => server.rooms.get('r1'));
    if (room.hand) { room.hand.stage = 'river'; clock.advance(3100); assert.throws(() => server.command(a.token, { type: 'tip', to: b.seat, gift: 'kiss', n: 2, sig: sign(a, 2, b, 'kiss', 2) }), /river/);
        room.hand.stage = 'turn'; server.command(a.token, { type: 'tip', to: b.seat, gift: 'kiss', n: 2, sig: sign(a, 2, b, 'kiss', 2) }); }
});

test('테이블: 본사 팁 [TIP_HOUSE_0_10_12] — 좌석표 tip 금액(BB 아님)만 보낸 사람에게서 빠지고 받는 사람 칩은 그대로, 사슬에 house, 다시 떠도 같은 스택', () => {
    const env = setup(3, { tip: 1 });
    const { server, clock, players } = env;
    clock.advance(5000);
    const room = server.rooms.get('r1');
    const [a, b] = players;
    const sign = (n, amount) => C.sign(a.sig.privateKey, C.msgTip(room.tableId, a.odcId, n, b.seat, 'flower', amount));
    assert.throws(() => server.command(a.token, { type: 'tip', to: b.seat, gift: 'flower', n: 1, sig: sign(1, 2) }), /bad tip signature/, 'BB 로 서명하면 거절 — 금액은 좌석표 tip');
    const before = room.seats.filter(Boolean).reduce((x, s) => x + s.stack, 0);
    assert.ok(server.command(a.token, { type: 'tip', to: b.seat, gift: 'flower', n: 1, sig: sign(1, 1) }).ok);
    const handId = room.hand.handId;
    for (let i = 0; i < 6 && room.hand && room.hand.handId === handId; i++) clock.advance(21000);
    const done = b.events.find(([ev]) => ev === 'tip-done');
    assert.ok(done && done[1].house === true && done[1].amount === 1 && !(String(b.seat) in done[1].stacks), '받는 사람 스택은 알리지 않는다(그대로)');
    const rec = env.out.filter((x) => x.kind === 'hand-record').pop().record;
    assert.strictEqual(room.seats[a.seat].stack, Math.round((rec.stacksEnd[a.seat] - 1) * 1000) / 1000, '보낸 사람 -1');
    assert.strictEqual(room.seats[b.seat].stack, rec.stacksEnd[b.seat], '받는 사람 그대로');
    const tipLine = env.store.range(0, 1e9).find((e) => e.kind === 'tip');
    assert.ok(tipLine && tipLine.house === true && tipLine.amount === 1);
    const rake = env.out.filter((x) => x.kind === 'hand-record').reduce((x, r) => x + ((r.record.result.rake && r.record.result.rake.totalRake) || 0), 0);
    const after = room.seats.filter(Boolean).reduce((x, s) => x + s.stack, 0);
    assert.ok(Math.abs(before - rake - 1 - after) < 1e-6, '방 전체 돈 = 이전 − 레이크 − 본사 팁');
    const want = Object.fromEntries(room.seats.filter(Boolean).map((s) => [s.odcId, s.stack]));
    const out2 = [];
    new TableServer({ engine: new Engine({ mode: 'dev' }), store: new RecordStore(env.dir), consoleKey: env.consoleKeys.publicKey, outbox: (k, p) => out2.push({ kind: k, ...p }), clock });
    const got = Object.fromEntries(out2.filter((x) => x.kind === 'settle').map((x) => [x.note.odcId, x.note.cashOut]));
    assert.deepStrictEqual(got, want, '다시 떠서 정산해도 본사 팁이 빠진 스택');
});

test('테이블: 팁을 옮긴 뒤 엔진이 다시 떠도 정산서에 팁이 반영된다(사슬의 팁 줄로 다시 계산)', () => {
    const env = setup(2);
    const { server, clock, players } = env;
    clock.advance(5000);
    const room = server.rooms.get('r1');
    const [a, b] = players;
    const sig = C.sign(a.sig.privateKey, C.msgTip(room.tableId, a.odcId, 1, b.seat, 'champagne', 2));
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

test('테이블: 레이즈 중 — 내 차례에만 같은 방에 알린다(금액·카드 없음), 인더다크 — 한 판짜리 예약이 다음 판 시작 때 방에 알려지고 지워진다', () => {
    const env = setup(2);
    const { server, clock, players } = env;
    clock.advance(5000);
    const room = server.rooms.get('r1');
    const turn = lastTurn(players[0]);
    const me = players.find((p) => p.seat === turn.seat), other = players.find((p) => p.seat !== turn.seat);
    assert.ok(server.command(other.token, { type: 'raising', active: true }).ignored, '남의 차례엔 알리지 않는다');
    assert.ok(server.command(me.token, { type: 'raising', active: true }).ok);
    const ev = other.events.filter(([e]) => e === 'raising').map(([, d]) => d);
    assert.strictEqual(ev.length, 1);
    assert.deepStrictEqual(Object.keys(ev[0]).sort(), ['active', 'q', 'seat']);
    assert.strictEqual(ev[0].seat, me.seat);
    assert.ok(server.command(me.token, { type: 'raising', active: false }).ignored, '0.3초 안에 다시 보내면 무시');
    // 인더다크 예약 — 이번 판에는 없고, 다음 판에 들어간다
    assert.strictEqual(server.command(other.token, { type: 'dark', on: true }).reserved, true);
    assert.deepStrictEqual(room.hand.dark, [], '이번 판에는 쓰지 않는다');
    assert.ok(other.events.some(([e, d]) => e === 'dark' && d.reserved === true), '본인에게 예약을 알린다');
    assert.ok(!me.events.some(([e]) => e === 'dark'), '예약은 남에게 알리지 않는다');
    const first = room.hand.handId;
    server.command(me.token, { type: 'act', q: turn.q, action: 'FOLD', amount: 0, sig: C.sign(me.sig.privateKey, C.msgAction(turn.handId, turn.q, 'FOLD', 0)) });
    for (let i = 0; i < 6 && !(room.hand && room.hand.handId !== first); i++) clock.advance(3000);
    assert.ok(room.hand && room.hand.handId !== first, '다음 판');
    assert.deepStrictEqual(room.hand.dark, [other.seat]);
    const hev = [...me.events].reverse().find(([e]) => e === 'hand')[1];
    assert.deepStrictEqual(hev.dark, [other.seat], '판 시작 때 방에 알린다');
    assert.strictEqual(room.seats[other.seat].darkNext, false, '한 판짜리 — 다시 눌러야 한다');
    // [DARK_PEEK_0_10_11] 프리플랍에는 볼 수 없고, 다크가 아닌 사람도 못 한다. 플랍부터 보면 다크가 풀리고 방에 알린다
    assert.throws(() => server.command(other.token, { type: 'peek' }), /from the flop/);
    assert.throws(() => server.command(me.token, { type: 'peek' }), /not in the dark/);
    room.hand.stage = 'flop';
    assert.ok(server.command(other.token, { type: 'peek' }).ok);
    assert.deepStrictEqual(room.hand.dark, []);
    const pk = [...me.events].reverse().find(([e]) => e === 'peek');
    assert.ok(pk && pk[1].seat === other.seat && pk[1].handId === room.hand.handId, '본 것을 상대에게 알린다');
    assert.deepStrictEqual(Object.keys(pk[1]).sort(), ['handId', 'seat'], '카드는 보내지 않는다');
    assert.throws(() => server.command(other.token, { type: 'peek' }), /not in the dark/, '한 번만');
});

/** 두 사람이 서로 올인해 한 사람이 칩 0 이 될 때까지 판을 돌린다 — 칩 0 이 된 사람을 돌려준다 */
function bustOne(env) {
    const { server, players, clock } = env;
    for (let g = 0; g < 60; g++) {
        waitHand(clock, () => server.rooms.get('r1'));
        const room = server.rooms.get('r1');
        const out = players.find((p) => room.seats[p.seat] && room.seats[p.seat].stack <= 0);
        if (out) return out;
        if (!room.hand) continue;
        for (let guard = 0; guard < 50 && room.hand; guard++) {
            const h = room.hand;
            if (h.toAct === null) { clock.advance(10); continue; }
            const p = players.find((x) => x.seat === h.toAct);
            const t = lastTurn(p);
            const action = t.toCall > 0 ? 'CALL' : 'ALL_IN';
            assert.ok(server.command(p.token, { type: 'act', q: t.q, action, amount: 0, sig: C.sign(p.sig.privateKey, C.msgAction(t.handId, t.q, action, 0)) }).ok);
        }
    }
    assert.fail('nobody busted');
}

test('테이블: 올인으로 칩 0 — 바로 정산(0), 자리는 그 회원 몫으로 잡아 둠, 칩을 넣는 다른 길 없음, 새 좌석표로 그 자리에 돌아옴, 잡아 둔 시간·나가기, 재시작 [REBUY_0_10_1]', () => {
    const env = setup(2, { unit: 150 });
    const { server, store, out, clock, players, ticket, consoleKeys } = env;
    const loser = bustOne(env);
    const k = players.indexOf(loser);
    const winner = players.find((p) => p !== loser);
    const room = server.rooms.get('r1');
    const held = room.seats[loser.seat];
    assert.ok(held && held.held, '칩 0 이어도 자리는 남는다(잡아 둠)');
    const settles = () => out.filter((o) => o.kind === 'settle' && o.note.odcId === held.odcId);
    assert.strictEqual(settles().length, 1, '바로 정산한다');
    assert.strictEqual(settles()[0].note.cashOut, 0);
    assert.strictEqual(settles()[0].note.reason, 'busted');
    assert.ok(loser.events.some(([ev]) => ev === 'busted'));
    assert.strictEqual(server._publicSeat(room, held).busted, true);
    assert.strictEqual(server.snapshot(room, held).me.unit, 150, '좌석표의 1바이인 금액이 화면에 간다');
    const heldBi = held.bi;
    assert.ok(heldBi >= 1, '처음 앉은 바이인 개수');
    assert.ok(!('topUp' in server) && typeof server.topUp !== 'function', '칩을 넣는 경로가 없다');
    const kinds = new Set(store.range(0, 1e9).map((e) => e.kind));
    for (const kd of kinds) assert.ok(['engine-key', 'seat-in', 'settle', 'hand', 'tip'].includes(kd), '사슬 종류는 그대로: ' + kd);

    // 연결이 끊겨도 잡아 둔 자리는 그대로(회원은 로비에서 바이인 신청 중)
    for (const f of loser.closeFns) f();
    server.subscribe(held.token, { send: () => {}, end: () => {}, onClose: () => {} });
    clock.advance(5 * 60 * 1000);
    assert.strictEqual(room.seats[loser.seat], held, '끊김 유예가 지나도 잡아 둔다');

    // 「바이인 신청」 — 말풍선만(사슬·콘솔로 가는 것 없음). 칩이 있는 좌석은 못 한다
    const lines = store.range(0, 1e9).length;
    assert.ok(server.command(held.token, { type: 'rebuy' }).ok);
    assert.strictEqual(held.rebuy, 'asked');
    assert.ok(winner.events.some(([ev, d]) => ev === 'seat' && d.seat.seat === loser.seat && d.seat.rebuy === 'asked'), '같은 방 모두에게 말풍선');
    assert.strictEqual(store.range(0, 1e9).length, lines, '신청은 사슬에 줄을 남기지 않는다');
    assert.throws(() => server.command(winner.token, { type: 'rebuy' }), /no chips/);

    // 다른 회원은 그 자리에 못 앉고, 판이 돌면 그 자리로 팁도 못 보낸다
    const other = client(server, ticket(7));
    assert.notStrictEqual(other.seat, loser.seat, '잡아 둔 자리는 다른 회원이 못 쓴다');
    clock.advance(4000);
    assert.ok(room.hand && !room.hand.seats.includes(loser.seat), '잡아 둔 자리는 판에 들지 않는다');
    assert.throws(() => server.command(winner.token, { type: 'tip', to: loser.seat, gift: 'flower', n: 1, sig: 'x' }), /bad tip target/);
    env.players = [winner, other];
    playOne(env, () => 1);

    // 처음 앉을 때와 같은 좌석표(새 바이인, 같은 회원) → 잡아 둔 그 자리에 「바이인 완료」로 앉는다
    const oldToken = held.token;
    const back = client(server, ticket(k, 150));
    assert.strictEqual(back.seat, loser.seat, '그 자리로 돌아온다');
    const seat = room.seats[back.seat];
    assert.strictEqual(seat.rebuy, 'done');
    assert.strictEqual(seat.stack, 150);
    // [BUYIN_UNITS_0_10_4] 표시용 바이인 개수 — 이번 1개, 이 자리 합계는 처음 것 + 1
    assert.strictEqual(server._publicSeat(room, seat).biNew, 1);
    assert.strictEqual(server._publicSeat(room, seat).bi, heldBi + 1, '재바이인하면 합계에 더한다');
    // [PROFILE_STATS_0_10_11] 바이인 금액 합계 — 처음 좌석표 금액 + 재바이인 150
    const firstBuyIn = server._publicSeat(room, seat).biAmt - 150;
    assert.ok(firstBuyIn > 0, '처음 바이인 금액이 들어 있다');
    assert.strictEqual(seat.held, false);
    assert.throws(() => server.command(oldToken, { type: 'rebuy' }), /unknown token|seat is gone/, '예전 자리 토큰은 끝났다');
    assert.strictEqual(settles().length, 1, '돌아올 때 정산서를 다시 내지 않는다');
    env.players = [winner, other, back];
    for (let g = 0; g < 10 && seat.rebuy === 'done'; g++) { waitHand(clock, () => server.rooms.get('r1')); playOne(env, () => 1); }
    assert.notStrictEqual(seat.rebuy, 'done', '한 판을 치면 「바이인 완료」를 내린다');

    // 잡아 둔 시간이 지나면 자리를 비운다(정산서 다시 없음) / 나가기도 같다
    const env2 = setup(2);
    const l2 = bustOne(env2);
    const r2 = env2.server.rooms.get('r1');
    const n2 = env2.out.filter((o) => o.kind === 'settle').length;
    env2.clock.advance(10 * 60 * 1000 + 10);
    assert.strictEqual(r2.seats[l2.seat], null, '잡아 둔 시간이 지나면 비운다');
    assert.strictEqual(env2.out.filter((o) => o.kind === 'settle').length, n2, '정산서를 다시 내지 않는다');
    assert.ok(l2.events.some(([ev, d]) => ev === 'settled' && d.cashOut === 0));
    const env3 = setup(2);
    const l3 = bustOne(env3);
    const n3 = env3.out.filter((o) => o.kind === 'settle').length;
    assert.ok(env3.server.command(l3.token, { type: 'leave' }).ok);
    assert.strictEqual(env3.server.rooms.get('r1').seats[l3.seat], null);
    assert.strictEqual(env3.out.filter((o) => o.kind === 'settle').length, n3);

    // 엔진이 다시 떠도 칩 0 으로 끝난 세션은 다시 정산하지 않는다 — 앉아 있는 세션만(칩 합 = 정산 합)
    const total = room.seats.reduce((a, x) => a + (x ? x.stack : 0), 0);
    const out2 = [];
    new TableServer({ engine: env.engine, store, consoleKey: consoleKeys.publicKey, outbox: (kind, q) => out2.push({ kind, ...q }), clock });
    const again = out2.filter((o) => o.kind === 'settle').map((o) => o.note);
    assert.ok(!again.some((n) => n.sessionId === held.sessionId), '정산한 세션은 다시 정산하지 않는다');
    assert.strictEqual(Math.round(again.reduce((a, n) => a + n.cashOut, 0) * 1000) / 1000, Math.round(total * 1000) / 1000, '칩 합 = 정산 합');
});

test('테이블: 바이인 개수(표시용) — 좌석표 금액 ÷ 1바이인, 1바이인이 없는 방은 0 [BUYIN_UNITS_0_10_4]', () => {
    const env = setup(2, { unit: 100 });
    const room = env.server.rooms.get('r1');
    const three = client(env.server, env.ticket(5, 300));
    const s3 = room.seats[three.seat];
    assert.strictEqual(env.server._publicSeat(room, s3).bi, 3);
    assert.strictEqual(env.server._publicSeat(room, s3).biNew, 0, '처음 앉을 때는 「바이인 완료」가 아니다');
    assert.strictEqual(env.server.snapshot(room, s3).me.bi, 3);
    assert.strictEqual(s3.stack, 300, '칩은 좌석표 금액 그대로');
    const env2 = setup(2);
    const r2 = env2.server.rooms.get('r1');
    assert.strictEqual(env2.server._publicSeat(r2, r2.seats[env2.players[0].seat]).bi, 0);
});

/** [READY_SESSION_0_10_6] 「준비 완료」를 직접 누르는 회원들로 앉힌다 */
function setupManual(n, room = {}) {
    client.noReady = true;
    try { return setup(n, room); } finally { client.noReady = false; }
}
const ready = (env, p, on = true) => env.server.command(p.token, { type: 'ready', on });
const lastOf = (p, ev) => { const e = [...p.events].reverse().find((x) => x[0] === ev); return e && e[1]; };

test('테이블: 준비 게이트 — 2명이 앉아도 모두 「준비 완료」 전에는 시작하지 않고, 준비를 풀면 멈추고, 2명 아래로 줄면 다시 게이트 [READY_SESSION_0_10_6]', () => {
    const env = setupManual(3);
    const { server, clock, players } = env;
    const room = server.rooms.get('r1');
    clock.advance(20000);
    assert.ok(!room.hand && room.gate, '아무도 준비 안 함 — 시작 안 함');
    ready(env, players[0]); ready(env, players[1]);
    clock.advance(20000);
    assert.ok(!room.hand, '3명 중 2명만 준비 — 시작 안 함');
    const g = lastOf(players[2], 'gate');
    assert.strictEqual(g.active, true); assert.strictEqual(g.total, 3); assert.strictEqual(g.ready, 2);
    ready(env, players[2]);
    assert.ok(lastOf(players[0], 'gate').startsAt > clock.now(), '모두 준비 — 시작 카운트다운');
    ready(env, players[2], false);   // 카운트다운 중 취소
    clock.advance(5000);
    assert.ok(!room.hand && room.gate, '준비 취소 — 멈춤');
    ready(env, players[2]);
    clock.advance(3500);
    assert.ok(room.hand, '모두 준비 — 시작');
    assert.strictEqual(room.gate, false);
    assert.strictEqual(lastOf(players[0], 'gate').active, false);
    // 게이트가 닫힌 뒤 「준비」는 아무 일도 하지 않는다
    assert.deepStrictEqual(ready(env, players[0]), { ok: true, gate: false });
    // 판 도중 두 명이 나간다 → 판이 끝나면 1명만 남아 게이트로 돌아간다(새로 온 사람과 바로 시작하지 않는다)
    server.command(players[1].token, { type: 'leave' });
    server.command(players[2].token, { type: 'leave' });
    for (let i = 0; i < 100 && room.hand; i++) clock.advance(1000);
    assert.ok(!room.hand);
    assert.ok(room.gate, '1명 남음 — 준비 게이트');
    assert.strictEqual(room.seats.filter(Boolean).length, 1, '남은 사람은 그대로 앉아 있다');
    const p3 = client(server, env.ticket(7));
    clock.advance(20000);
    assert.ok(!room.hand, '새로 온 사람과 바로 시작하지 않는다');
    ready(env, players[0]); ready(env, p3);
    clock.advance(3500);
    assert.ok(room.hand, '둘 다 준비 — 시작');
});

test('테이블: 게임 시간 — 첫 판부터 재고, 3분 전 안내, 시간이 끝나면 마지막 3판 뒤 준비 게이트(정산·퇴장 없음), 다시 준비하면 새 시간 [READY_SESSION_0_10_6]', () => {
    const env = setupManual(2, { sessionMin: 10, endsAt: 1 });   // 옛 끝 시각(endsAt)이 지났어도 게임 시간이 있으면 방을 닫지 않는다
    const { server, clock, players, out } = env;
    const room = server.rooms.get('r1');
    assert.strictEqual(lastOf(players[0], 'snapshot').session.phase, 'idle');
    ready(env, players[0]); ready(env, players[1]);
    clock.advance(3500);
    assert.ok(room.hand);
    const st = lastOf(players[0], 'session');
    assert.strictEqual(st.event, 'start'); assert.strictEqual(st.phase, 'running');
    assert.strictEqual(st.endsAt - st.startedAt, 10 * 60000);
    // 판을 계속 친다 — 차례가 오면 체크/콜(둘 다 칩이 남게)
    const fold = () => {
        for (let g = 0; g < 50 && room.hand; g++) {
            const h = room.hand;
            if (h.toAct === null) { clock.advance(10); continue; }
            const p = players.find((x) => x.seat === h.toAct);
            const t = lastTurn(p);
            const action = t.toCall > 0 ? 'FOLD' : 'CHECK';
            server.command(p.token, { type: 'act', q: t.q, action, amount: 0, sig: C.sign(p.sig.privateKey, C.msgAction(t.handId, t.q, action, 0)) });
        }
    };
    const events = (ev) => players[0].events.filter((x) => x[0] === ev).map((x) => x[1]);
    let hands = 0;
    while (clock.now() < st.endsAt - 60000) { fold(); hands++; waitHand(clock, () => room); }
    assert.ok(events('session').some((x) => x.event === 'warn'), '3분 전 안내');
    assert.ok(!events('session').some((x) => x.event === 'time-up'));
    // 시간이 끝날 때까지 계속 — 끝난 뒤 마지막 3판
    while (!events('session').some((x) => x.event === 'time-up')) { fold(); hands++; waitHand(clock, () => room); }
    const finals = () => events('session').filter((x) => x.event === 'final-hand');
    for (let i = 0; i < 6 && !events('session').some((x) => x.event === 'ended'); i++) { fold(); waitHand(clock, () => room); }
    assert.deepStrictEqual(finals().map((x) => x.finalNo), [1, 2, 3], '마지막 1·2·3판');
    assert.ok(events('session').some((x) => x.event === 'ended'), '게임 끝');
    clock.advance(30000);
    assert.ok(!room.hand && room.gate, '준비 게이트로 돌아갔다 — 더 시작하지 않는다');
    assert.ok(server.rooms.get('r1') === room, '방은 그대로');
    assert.strictEqual(room.seats.filter(Boolean).length, 2, '아무도 내보내지 않는다');
    assert.strictEqual(out.filter((x) => x.kind === 'settle').length, 0, '정산서 없음');
    assert.strictEqual(lastOf(players[1], 'gate').active, true);
    // [RESEAT_0_10_27] 앉기 전처럼 자리를 다시 고른다 — 아직 안 고른 사람의 예전 자리도 먼저 고르면 앉는다
    const [A, B] = players.map((p) => room.seats[p.seat]);
    assert.ok(A.choosing && B.choosing && A.reseat && lastOf(players[0], 'reseat'), '둘 다 다시 고른다');
    const chips = [A.stack, B.stack], oldA = A.seat, oldB = B.seat;
    assert.throws(() => server.command(players[0].token, { type: 'ready' }), /choose a seat/);
    assert.strictEqual(server.command(players[0].token, { type: 'sit', seat: oldB }).seat, oldB);
    assert.ok(room.seats[oldB] === A && room.seats[oldA] === B && B.seat === oldA && B.choosing, '예전 자리는 임시로 맞바뀐다');
    assert.strictEqual(lastOf(players[1], 'moved').seat, oldA);
    assert.throws(() => server.command(players[1].token, { type: 'sit', seat: oldB }), /taken/, '이미 앉은 자리는 못 고른다');
    server.command(players[0].token, { type: 'ready' }); clock.advance(5000);
    assert.ok(!room.hand, '고르는 사람을 기다린다');
    assert.strictEqual(server.command(players[1].token, { type: 'sit', seat: 5 }).seat, 5);
    assert.ok(server.command(players[1].token, { type: 'repick' }).ok, '시작 전에는 다시 바꿀 수 있다');
    clock.advance(91000);
    assert.ok(!B.choosing && B.seat === 5, '90초 뒤 지금 자리로');
    assert.deepStrictEqual([A.stack, B.stack], chips, '칩은 그대로');
    players[0].seat = A.seat; players[1].seat = B.seat;
    // 다시 모두 준비 → 새 게임 시간
    ready(env, players[0]); ready(env, players[1]);
    clock.advance(3500);
    assert.ok(room.hand);
    const st2 = lastOf(players[0], 'session');
    assert.strictEqual(st2.event, 'start');
    assert.strictEqual(st2.endsAt - st2.startedAt, 10 * 60000);
    assert.ok(room.hand.seats.includes(5) && !A.reseat && !B.reseat);
    assert.throws(() => server.command(players[1].token, { type: 'repick' }), /no longer/, '게임이 시작되면 못 바꾼다');
    assert.ok(hands > 3);
});

test('[CHIP_VISUAL_0_10_7] 좌석표 display.chipRate — 칩 그림 환산만 받는다(범위 밖·없으면 빠진다)', () => {
    const { verifyTicket } = require('../src/table/ticket');
    const keys = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const base = (display) => signTicket({ v: 1, tid: 'tid_chip_' + crypto.randomBytes(4).toString('hex'), exp: Date.now() + 60000,
        room: { id: 'r1', name: 'won', sb: 1000, bb: 2000, maxPlayers: 9, rake: { percent: 5, minPot: 0, unit: 1 }, turnSec: 20 },
        player: { sessionId: 'sess_' + crypto.randomBytes(4).toString('hex'), odcId: 'u1', nickname: 'a' }, buyIn: 500000, currency: 'KRW', display }, keys.privateKey);
    const t1 = verifyTicket(base({ currency: 'KRW', rate: 1, chipRate: 1450 }), keys.publicKey);
    assert.deepStrictEqual(t1.display, { currency: 'KRW', rate: 1, chipRate: 1450 });
    assert.strictEqual(t1.buyIn, 500000, '게임 금액은 그대로(원)');
    assert.strictEqual(verifyTicket(base({ currency: 'KRW', rate: 1 }), keys.publicKey).display.chipRate, undefined);
    for (const bad of [0, 1, -5, 'x', 1e8]) assert.strictEqual(verifyTicket(base({ currency: 'KRW', rate: 1, chipRate: bad }), keys.publicKey).display.chipRate, undefined, String(bad));
});

test('[RAISE_TIME_0_10_9] 레이즈 바를 처음 잡으면 한 차례에 한 번 +10초 — 다른 사람·두 번째는 늘지 않는다', () => {
    const env = setup(2);
    const { server, players, clock } = env;
    clock.advance(10);
    const room = server.rooms.get('r1');
    for (const p of players) ready(env, p);
    clock.advance(3500);
    assert.ok(room.hand, '판 시작');
    const h = room.hand;
    const me = players.find((p) => p.seat === h.toAct), other = players.find((p) => p.seat !== h.toAct);
    const d0 = h.deadline;
    // 차례가 아닌 사람은 무시
    clock.advance(400);
    server.command(other.token, { type: 'raising', active: true });
    assert.strictEqual(h.deadline, d0);
    const r = server.command(me.token, { type: 'raising', active: true });
    assert.strictEqual(r.addedMs, 10000);
    assert.strictEqual(h.deadline, d0 + 10000);
    clock.advance(400);
    server.command(me.token, { type: 'raising', active: true });
    assert.strictEqual(h.deadline, d0 + 10000, '한 차례에 한 번');
    assert.ok(other.events.some(([ev, d]) => ev === 'raise-time' && d.seat === me.seat), '같은 방에 알린다');
});

test('[SHOW_CARDS_0_10_9] 폴드승 승자만 다음 판 전까지 한 번 카드를 보여 준다 — 보인 카드는 그 판 카드 약속과 맞고 자기 카드다', () => {
    const env = setup(2);
    const { server, players, clock, engine } = env;
    const corePub = C.importPublicJwk(engine.call('info').keys.ecdh);
    waitHand(clock, () => server.rooms.get('r1'));
    const room = server.rooms.get('r1');
    const h = room.hand, hid = h.handId;
    // 각자 자기 카드(봉투)
    const mine = {};
    for (const p of players) {
        const hole = [...p.events].reverse().find((x) => x[0] === 'hole' && x[1].handId === hid);
        mine[p.seat] = C.openEnvelope(p.ecdh.privateKey, corePub, hid, hole[1].envelope).cards.map((x) => x.c);
    }
    const pub = [...players[0].events].reverse().find((x) => x[0] === 'hand' && x[1].handId === hid)[1];
    // 판 도중에는 보여 줄 수 없다
    assert.throws(() => server.command(players[0].token, { type: 'show', which: 'both' }), /nothing to show/);
    const actor = players.find((x) => x.seat === h.toAct), winner = players.find((x) => x.seat !== h.toAct);
    const t = lastTurn(actor);
    server.command(actor.token, { type: 'act', q: t.q, action: 'FOLD', amount: 0, sig: C.sign(actor.sig.privateKey, C.msgAction(t.handId, t.q, 'FOLD', 0)) });
    assert.ok(!room.hand, '폴드승으로 끝');
    assert.throws(() => server.command(actor.token, { type: 'show', which: 'both' }), /nothing to show/, '진 사람은 못 보여 준다');
    assert.throws(() => server.command(winner.token, { type: 'show', which: 'middle' }), /bad show choice/);
    const r = server.command(winner.token, { type: 'show', which: 'left' });
    assert.strictEqual(r.cards, 1);
    const ev = [...actor.events].reverse().find((x) => x[0] === 'shown');
    assert.ok(ev && ev[1].seat === winner.seat && ev[1].handId === hid);
    assert.strictEqual(ev[1].cards.length, 1);
    for (const op of ev[1].cards) assert.ok(cards.checkOpening(hid, pub.commitments, op), '카드 약속과 맞는다');
    assert.strictEqual(ev[1].cards[0].c, mine[winner.seat][0], '자기 왼쪽 카드');
    // 보낸 카드 값만 비교한다(소금 hex 안에 카드 글자가 우연히 있을 수 있어 글자 검색은 하지 않는다)
    assert.ok(ev[1].cards.every((x) => !mine[actor.seat].includes(x.c)), '남의 카드는 없다');
    assert.deepStrictEqual(Object.keys(ev[1]).sort(), ['cards', 'handId', 'seat', 'which'], '덱·씨앗 같은 다른 값은 없다');
    assert.throws(() => server.command(winner.token, { type: 'show', which: 'right' }), /already shown/, '한 번만');
    // 다음 판이 시작되면 늦다
    waitHand(clock, () => server.rooms.get('r1'));
    assert.ok(room.hand);
    assert.throws(() => server.command(winner.token, { type: 'show', which: 'both' }), /nothing to show|too late/);
});

test('[RESUME_0_10_11] 앉은 자리로 돌아오기 — 같은 서명 키·5분 안의 서명에만 그 자리 토큰, 다른 키·옛 시각·없는 좌석표는 거절', () => {
    const env = setup(2);
    const { server, players, clock } = env;
    const p = players[0];
    const room = server.rooms.get('r1');
    const s = room.seats[p.seat];
    const sigJ = C.publicJwk(p.sig.publicKey), fp = C.fingerprint(sigJ);
    const ts = clock.now();
    const r = server.resume({ tid: s.tid, ts, auth: { sig: sigJ, proof: C.sign(p.sig.privateKey, C.msgResume(s.tid, fp, ts)) } });
    assert.strictEqual(r.token, p.token, '같은 자리 토큰');
    assert.strictEqual(r.seat, p.seat);
    const other = C.generateKeyPair(), oJ = C.publicJwk(other.publicKey);
    assert.throws(() => server.resume({ tid: s.tid, ts, auth: { sig: oJ, proof: C.sign(other.privateKey, C.msgResume(s.tid, C.fingerprint(oJ), ts)) } }), /not the key/);
    const old = ts - 6 * 60 * 1000;
    assert.throws(() => server.resume({ tid: s.tid, ts: old, auth: { sig: sigJ, proof: C.sign(p.sig.privateKey, C.msgResume(s.tid, fp, old)) } }), /stale/);
    assert.throws(() => server.resume({ tid: 'tid_none', ts, auth: { sig: sigJ, proof: C.sign(p.sig.privateKey, C.msgResume('tid_none', fp, ts)) } }), /gone/);
});

test('[AWAY_5MIN_0_10_11] 연결이 끊겨도 5분까지는 자리가 남는다(기본값)', () => {
    const env = setup(2);
    const { server, players, clock } = env;
    assert.strictEqual(server.disconnectGraceMs, 5 * 60 * 1000);
    const room = server.rooms.get('r1');
    const p = players[1];
    for (const f of p.closeFns) f();
    clock.advance(4 * 60 * 1000);
    assert.ok(room.seats[p.seat] && !room.seats[p.seat].leaving, '4분 뒤에도 자리가 있다');
});

test('[AWAY_0_10_16] 자리 비움 — 다음 판부터 카드를 받지 않고, 차례가 오면 바로 체크/폴드(시간 초과로 안 셈), 돌아오면 다음 판부터, 10분이 지나면 나가기(정산 away)', () => {
    const env = setup(3);
    const { server, players, clock } = env;
    clock.advance(5000);
    const room = server.rooms.get('r1');
    assert.ok(room.hand && room.hand.seats.length === 3, '세 명이 판에 든다');
    // 판 도중 자리 비움 — 끝나는 시각이 자리 정보에 실린다
    const a = players.find((p) => p.seat !== room.hand.toAct);
    const r = server.command(a.token, { type: 'sitout' });
    assert.ok(r.ok && r.sitout && r.awayUntil === clock.now() + 10 * 60 * 1000);
    assert.ok(server._publicSeat(room, room.seats[a.seat]).awayUntil > 0);
    playOne(env, () => 1);
    const st = room.seats[a.seat];
    assert.strictEqual(st.timeouts, 0, '자리 비움 중 자동 체크/폴드는 시간 초과로 세지 않는다');
    waitHand(clock, () => server.rooms.get('r1'));
    assert.ok(room.hand && !room.hand.seats.includes(a.seat) && room.hand.seats.length === 2, '다음 판은 자리 비움 없이 둘이서');
    // 돌아오면 다음 판부터
    const b = server.command(a.token, { type: 'back' });
    assert.ok(b.ok && !b.sitout && b.awayUntil === 0);
    assert.ok(!room.hand.seats.includes(a.seat), '지금 판에는 들지 않는다');
    playOne(env, () => 1);
    waitHand(clock, () => server.rooms.get('r1'));
    assert.ok(room.hand && room.hand.seats.includes(a.seat), '그다음 판부터 다시 든다');
    playOne(env, () => 1);
    // 다시 자리 비움 → 10분 → 나가기(정산 away)
    server.command(a.token, { type: 'sitout' });
    clock.advance(9 * 60 * 1000);
    assert.ok(room.seats[a.seat], '9분에는 자리가 있다');
    clock.advance(61 * 1000);
    for (let i = 0; i < 40 && room.seats[a.seat]; i++) { playOne(env, () => 1); clock.advance(1000); }
    assert.ok(!room.seats[a.seat], '10분이 지나면 자리를 정리한다');
    assert.ok(env.out.some((x) => x.kind === 'settle' && x.note.odcId === a.odcId && x.note.reason === 'away'), '정산 사유 away');
});

test('[AWAY_0_10_16] 자리 비움은 대기실 준비 인원에서 빠지고, 내 차례에 누르면 바로 넘어간다', () => {
    client.noReady = true;
    let env;
    try { env = setup(3); } finally { client.noReady = false; }
    const { server, players, clock } = env;
    const room = server.rooms.get('r1');
    assert.ok(room.gate, '대기실');
    server.command(players[2].token, { type: 'sitout' });
    assert.strictEqual(server._gatePlayers(room).length, 2, '자리 비움은 준비 인원에서 뺀다');
    server.command(players[0].token, { type: 'ready' }); server.command(players[1].token, { type: 'ready' });
    clock.advance(5000);
    assert.ok(room.hand && room.hand.seats.length === 2 && !room.hand.seats.includes(players[2].seat), '둘이서 시작');
    const turn = players.find((p) => p.seat === room.hand.toAct);
    const q0 = room.hand.q, h0 = room.hand.handId;
    server.command(turn.token, { type: 'sitout' });
    assert.ok(!room.hand || room.hand.handId !== h0 || room.hand.q !== q0 || room.hand.toAct !== turn.seat, '내 차례에 누르면 기다리지 않고 넘어간다(둘이면 폴드로 판이 끝난다)');
    assert.ok(env.out.some((x) => x.kind === 'hand-record' && x.record.handId === h0) || (room.hand && room.hand.handId === h0), '판은 이어지거나 끝났다');
});

test('[WATCH_0_10_20] 관전(방장) — 관전 좌석표로 자리 없이 들어와 공개 이벤트만 받는다(홀카드 봉투 없음), 채팅만(방장 표시), 회원들은 관전 중임을 본다, 최대 3명, 나가기', () => {
    const env = setup(2);
    const { server, clock, players, consoleKeys } = env;
    const room0 = server.rooms.get('r1');
    const R = room0.rules;
    const wticket = (i) => signTicket({ v: 1, tid: 'tidw_' + i + '_' + crypto.randomBytes(4).toString('hex'), exp: clock.now() + 60000, room: R,
        player: { sessionId: 'sessw_' + i + '_' + crypto.randomBytes(4).toString('hex'), odcId: 'h' + i, nickname: 'HOST' + i }, watch: 1, currency: 'USDT' }, consoleKeys.privateKey);
    const j = server.join(wticket(1));
    assert.ok(j.watch && j.token && j.tableId === room0.tableId);
    const ev = [];
    server.subscribe(j.token, { send: (e, d) => ev.push([e, d]), end: () => {}, onClose: () => {} });
    const snap = ev.find((x) => x[0] === 'snapshot')[1];
    assert.strictEqual(snap.me.seat, -1); assert.ok(snap.me.watch); assert.strictEqual(snap.hole, null);
    assert.ok(JSON.stringify(snap).indexOf('envelope') < 0, '관전 상태에 봉투가 없다');
    assert.ok(players[0].events.some((x) => x[0] === 'watch' && x[1].n === 1 && x[1].names[0] === 'HOST1'), '회원 화면에 관전 중 알림');
    clock.advance(5000);
    const room = server.rooms.get('r1');
    assert.ok(room.hand, '판이 시작됐다');
    assert.ok(ev.some((x) => x[0] === 'hand'), '공개 판 알림은 받는다');
    assert.ok(!ev.some((x) => x[0] === 'hole'), '홀카드 봉투는 받지 않는다');
    assert.ok(!room.hand.seats.includes(-1) && room.hand.seats.length === 2, '관전자는 판에 들지 않는다');
    // 채팅만
    const c = server.command(j.token, { type: 'chat', text: '매너 부탁드려요' });
    assert.ok(c.ok);
    const chat = players[1].events.filter((x) => x[0] === 'chat').pop()[1];
    assert.ok(chat.host === true && chat.seat === -1 && chat.nickname === 'HOST1');
    for (const type of ['act', 'sitout', 'tip', 'show', 'ready', 'emote', 'keys', 'timebank']) {
        assert.throws(() => server.command(j.token, { type, action: 'FOLD' }), /watchers can only chat/, type);
    }
    // 같은 좌석표는 한 번만, 최대 3명
    const w2 = server.join(wticket(2)), w3 = server.join(wticket(3));
    assert.throws(() => server.join(wticket(4)), /too many watchers/);
    // 나가기 → 토큰이 사라지고 회원 화면에 줄어든 수
    server.command(w3.token, { type: 'leave' });
    assert.throws(() => server.command(w3.token, { type: 'chat', text: 'x' }), /unknown token/);
    assert.strictEqual(players[0].events.filter((x) => x[0] === 'watch').pop()[1].n, 2);
    // 판은 관전과 무관하게 끝까지 — 칩 보존
    playOne(env, () => 1);
    assert.ok(env.out.some((x) => x.kind === 'hand-record'));
    assert.ok(w2.token);
});

test('[GUEST_WATCH_0_10_27] 방 코드 관전 회원 — 공개 이벤트만(봉투 없음), 나가기만 된다(채팅 없음), 방장 수와 따로 세고, 앉으면 관전이 끝난다', () => {
    const env = setup(2);
    const { server, clock, players, consoleKeys } = env;
    const R = server.rooms.get('r1').rules;
    const ticket = (who, extra) => signTicket({ v: 1, tid: 'tidg_' + crypto.randomBytes(6).toString('hex'), exp: clock.now() + 60000, room: R,
        player: { sessionId: 'sessg_' + crypto.randomBytes(6).toString('hex'), odcId: who, nickname: who }, currency: 'USDT', ...extra }, consoleKeys.privateKey);
    const j = server.join(ticket('g1', { watch: 2 }));
    const ev = [];
    server.subscribe(j.token, { send: (e, d) => ev.push([e, JSON.stringify(d)]), end: () => {}, onClose: () => {} });
    const snap = JSON.parse(ev.find((x) => x[0] === 'snapshot')[1]);
    assert.ok(snap.me.watch && snap.me.guest && snap.me.seat === -1 && snap.hole === null);
    const wi = players[0].events.filter((x) => x[0] === 'watch').pop()[1];
    assert.ok(wi.n === 0 && wi.guests === 1 && wi.names.length === 0, '방장 관전으로 세지 않는다');
    clock.advance(5000);
    assert.ok(server.rooms.get('r1').hand && ev.some((x) => x[0] === 'hand'));
    assert.ok(!ev.some((x) => x[0] === 'hole' || x[1].includes('envelope')), '봉투는 어디에도 없다');
    for (const type of ['chat', 'act', 'tip', 'ready', 'show', 'emote', 'keys']) {
        assert.throws(() => server.command(j.token, { type, text: 'x', action: 'FOLD' }), /watchers can only watch/, type);
    }
    for (let i = 2; i <= 20; i++) server.join(ticket('g' + i, { watch: 2 }));
    assert.throws(() => server.join(ticket('g21', { watch: 2 })), /too many watchers/);
    assert.ok(server.join(ticket('host', { watch: 1 })).token, '방장 관전 자리는 따로');
    assert.throws(() => server.join(ticket(players[0].odcId, { watch: 2 })), /already at this table/);
    server.command(server.join(ticket('g2', { watch: 2 })).token, { type: 'leave' });
    playOne(env, () => 1);
    assert.ok(env.out.some((x) => x.kind === 'hand-record'));
    server.join(ticket('g1', { buyIn: R.bb * 100 }));
    assert.throws(() => server.command(j.token, { type: 'leave' }), /unknown token/, '앉으면 관전이 끝난다');
});

/**
 * [LEAK_GAMES_0_10_24] 홀덤·PLO4·PLO5 — 판 도중 남의 카드가 어디에도 나가지 않는다(테이블 서버 그대로, 회원이 받은 모든 이벤트와 콘솔로 나간 모든 것).
 * 이벤트는 실제 연결처럼 받는 순간 글자로 바꿔 둔다(서버 객체를 그대로 들고 있으면 나중에 채워진 공개 칸이 예전 이벤트에 비친다).
 *  - 봉투를 열면 자기 카드가 2·4·5장, 판 시작 때 약속과 맞는다
 *  - 남의 카드는 공개 시점(올인 런아웃 runout, 쇼다운 결과 result, 화면 상태의 reveal)에만 — 그 밖의 칸에는 없다
 *  - 남의 카드가 공개된 뒤에는 그 판에 베팅 차례가 오지 않는다
 *  - 콘솔로 가는 판 기록(hand-record)은 그 판 결과가 테이블에 나간 뒤에만, 정산서(settle)에는 카드가 없다
 */
for (const [game, n, hole, maxPlayers] of [['holdem', 4, 2, 9], ['plo4', 4, 4, 9], ['plo5', 6, 5, 6]]) {
    test(`[LEAK_GAMES_0_10_24] ${game} — 판 도중 남의 카드는 공개 전엔 어떤 이벤트·콘솔 전송에도 없다, 기록은 결과 뒤에만`, () => {
        const rnd = (k) => crypto.randomInt(k);
        const env = setup(n, { game, maxPlayers });
        const { server, out, clock, players, engine } = env;
        const corePub = C.importPublicJwk(engine.call('info').keys.ecdh);
        let seq = 0;
        for (const p of players) {
            p.events.push = function (...xs) {
                for (const x of xs) { x[1] = JSON.parse(JSON.stringify(x[1] === undefined ? null : x[1])); x[2] = ++seq; }
                return Array.prototype.push.apply(this, xs);
            };
        }
        out.push = function (...xs) { for (const x of xs) x.__seq = ++seq; return Array.prototype.push.apply(this, xs); };
        let handsDone = 0;
        for (let g = 0; g < 30; g++) {
            waitHand(clock, () => server.rooms.get('r1'));
            const room = server.rooms.get('r1');
            if (!room || !room.hand) break;
            const hid = room.hand.handId;
            for (const p of players.filter((x) => room.seats[x.seat])) {
                const ev = [...p.events].reverse().find((x) => x[0] === 'hole' && x[1] && x[1].handId === hid);
                if (!ev) continue;
                const pay = C.openEnvelope(p.ecdh.privateKey, corePub, hid, ev[1].envelope);
                assert.strictEqual(pay.cards.length, hole, 'own hole cards');
                const pub = [...p.events].reverse().find((x) => x[0] === 'hand' && x[1] && x[1].handId === hid)[1];
                for (const op of pay.cards) assert.ok(cards.checkOpening(hid, pub.commitments, op));
                p.holes[hid] = pay.cards.map((x) => x.c);
            }
            playOne(env, rnd);
            handsDone++;
        }
        assert.ok(handsDone >= 1);
        let checked = 0;
        for (const p of players) {
            const byHand = {};
            for (const e of p.events) if (e[1] && e[1].handId) (byHand[e[1].handId] = byHand[e[1].handId] || []).push(e);
            for (const [hid, evs] of Object.entries(byHand)) {
                const others = players.filter((q) => q !== p && q.holes[hid]).flatMap((q) => q.holes[hid]);
                let revealed = false;
                for (const [ev, d] of evs) {
                    if (ev === 'result') break;
                    if (ev === 'runout' || ev === 'showdown' || (d.reveal && Object.keys(d.reveal).length)) revealed = true;
                    if (ev === 'runout' || ev === 'showdown') continue;
                    if (revealed && ev === 'turn') assert.fail(`${game}: betting turn after cards were revealed`);
                    const { reveal: _r, ...rest } = d;
                    const js = JSON.stringify(rest);
                    const board = d.board || [];
                    for (const c of others) assert.ok(board.includes(c) || !js.includes(`"${c}"`), `${game}: ${ev} carries another seat's card`);
                    checked++;
                }
            }
        }
        assert.ok(checked > 0);
        for (const o of out) {
            if (o.kind === 'hand-record') {
                const hid = o.record.handId;
                const res = players.flatMap((q) => q.events.filter((x) => x[0] === 'result' && x[1] && x[1].handId === hid).map((x) => x[2]));
                assert.ok(res.length && Math.min(...res) < o.__seq, `${game}: record of ${hid} sent before its result`);
                if (game !== 'holdem') assert.strictEqual(o.record.game, game);
            } else {
                assert.ok(!/"[2-9TJQKA][shdc]"/.test(JSON.stringify(o)), `${game}: ${o.kind} carries a card`);
            }
        }
        for (const p of players) if (server.rooms.get('r1') && server.rooms.get('r1').seats[p.seat]) server.command(p.token, { type: 'leave' });
        clock.advance(30000);
        assert.strictEqual(out.filter((x) => x.kind === 'settle').length, n);
        for (const r of out.filter((x) => x.kind === 'hand-record')) assert.deepStrictEqual(verifyRecord(r.record, r.sig, engine.call('info').keys.sig).errors, []);
    });
}

// [RESULT_HOLD_0_10_25] 올인 런아웃 결과 연출 동안 무엇이 _maybeStart 를 불러도 다음 판을 시작하지 않는다(승자 연출이 잘리지 않게)
test('테이블: 올인 런아웃 뒤 결과 연출이 끝나기 전에는 다음 판이 시작되지 않는다 [RESULT_HOLD_0_10_25]', () => {
    const env = setup(4);   // 한 명은 폴드 — 판 뒤에도 칠 사람이 2명 남아 다음 판이 열릴 수 있다
    const { server, clock, players } = env;
    waitHand(clock, () => server.rooms.get('r1'));
    const folder = players[3];
    const room = server.rooms.get('r1');
    assert.ok(room.hand);
    const hid = room.hand.handId;
    for (let guard = 0; guard < 20 && room.hand && room.hand.handId === hid; guard++) {
        const h = room.hand;
        if (h.toAct === null) { clock.advance(10); continue; }
        const p = players.find((x) => x.seat === h.toAct);
        const t = lastTurn(p);
        const action = p === folder ? 'FOLD' : t.toCall >= t.allIn ? 'CALL' : 'ALL_IN';
        const r = server.command(p.token, { type: 'act', q: t.q, action, amount: 0, sig: C.sign(p.sig.privateKey, C.msgAction(t.handId, t.q, action, 0)) });
        assert.ok(r.ok);
    }
    assert.ok(!room.hand || room.hand.handId !== hid, 'hand ended');
    const ranOut = players[0].events.some((e) => e[0] === 'runout' && e[1].handId === hid);
    assert.ok(ranOut, 'all-in preflop runs out');
    const endAt = clock.now();
    const hold = room.resumeAt - endAt;
    assert.ok(hold >= 4000 + 7800, 'result pause covers the runout board (' + hold + 'ms)');
    // 연출 도중 — 좌석·무작위 값 등이 부르는 것과 같다
    for (let k = 0; k < Math.floor(hold / 1000); k++) { server._maybeStart(room); clock.advance(1000); assert.ok(!room.hand, 'no new hand during the result show (' + (clock.now() - endAt) + 'ms)'); }
    // 결과를 보여 준 뒤에는 칠 사람이 남아 있으면(혹은 대기실) 예전처럼 이어진다
    clock.advance(hold + 4000 - (clock.now() - endAt));
    assert.ok(room.hand, 'next hand starts after the result show');
});

// [RESULT_HOLD_FIX_0_10_25] 연출 끝 타이머가 1ms 일찍 울려도(Node 실제 타이머) 판이 멈추지 않는다
test('테이블: 결과 연출 끝 타이머가 1ms 일찍 울려도 다음 판이 시작된다 [RESULT_HOLD_FIX_0_10_25]', () => {
    const env = setup(2);
    const { server, clock, players } = env;
    waitHand(clock, () => server.rooms.get('r1'));
    const room = server.rooms.get('r1');
    const hid = room.hand.handId;
    // 실제 Node 타이머처럼 늘 1ms 일찍 울리게
    const orig = server.clock.setTimeout;
    server.clock.setTimeout = (f, ms) => orig(f, ms > 1 ? ms - 1 : ms);
    // 한 명이 폴드 — 판이 끝나고 결과 연출 시간이 잡힌다
    const h = room.hand, p = players.find((x) => x.seat === h.toAct), t = lastTurn(p);
    assert.ok(server.command(p.token, { type: 'act', q: t.q, action: 'FOLD', amount: 0, sig: C.sign(p.sig.privateKey, C.msgAction(t.handId, t.q, 'FOLD', 0)) }).ok);
    assert.ok(!room.hand && room.resumeAt > clock.now());
    // 연출 끝 타이머가 1ms 일찍 울려도 — 아무도 다시 부르지 않는데 판이 열려야 한다
    clock.advance(room.resumeAt - clock.now() + 4000);
    assert.ok(room.hand && room.hand.handId !== hid, 'next hand started');
});

// [SEAT_PICK_0_10_25] 좌석표가 정한 자리(회원이 대기 중 고른 자리)가 비어 있으면 그 자리에, 찼으면 첫 빈자리에 앉는다
test('테이블: 좌석표의 자리로 앉는다 — 찼으면 첫 빈자리 [SEAT_PICK_0_10_25]', () => {
    const env = setup(0);
    const { server, consoleKeys, clock } = env;
    const R = { id: 'r1', name: 'T', sb: 1, bb: 2, maxPlayers: 6, rake: { percent: 5, minPot: 4 }, turnSec: 20, endsAt: 0 };
    const tk = (i, seat) => signTicket({ v: 1, tid: 'tid_s' + i + '_' + crypto.randomBytes(4).toString('hex'), exp: clock.now() + 60000, room: R,
        player: { sessionId: 'sess_s' + i + '_' + crypto.randomBytes(4).toString('hex'), odcId: 'us' + i, nickname: 'S' + i }, buyIn: 200, seat, currency: 'USDT' }, consoleKeys.privateKey);
    assert.strictEqual(server.join(tk(1, 4)).seat, 4);
    assert.strictEqual(server.join(tk(2, 4)).seat, 0, 'taken seat → first free');
    assert.strictEqual(server.join(tk(3, 99)).seat, 1, 'bad seat → first free');
    assert.strictEqual(server.join(tk(4)).seat, 2, 'no seat → first free');
});

// [SEAT_CHOOSE_0_10_26] 들어와서 빈자리를 고른다 — 고르기 전에는 판·준비에 들지 않고, 고르면 그 자리로 옮겨 준비할 수 있다. 판을 친 뒤에는 못 옮긴다
test('테이블: 들어와서 자리를 고른 뒤 준비 — 고르기 전에는 판에 들지 않는다 [SEAT_CHOOSE_0_10_26]', () => {
    const env = setup(0);
    const { server, consoleKeys, clock } = env;
    const R = { id: 'r1', name: 'T', sb: 1, bb: 2, maxPlayers: 6, rake: { percent: 5, minPot: 4 }, turnSec: 20, endsAt: 0 };
    const tk = (i, pick) => signTicket({ v: 1, tid: 'tid_c' + i + '_' + crypto.randomBytes(4).toString('hex'), exp: clock.now() + 60000, room: R,
        player: { sessionId: 'sess_c' + i + '_' + crypto.randomBytes(4).toString('hex'), odcId: 'uc' + i, nickname: 'C' + i }, buyIn: 200, ...(pick ? { pick: 1 } : {}), currency: 'USDT' }, consoleKeys.privateKey);
    const a = client(server, tk(1, true)), b = client(server, tk(2, true));
    const room = server.rooms.get('r1');
    assert.ok(room.seats[a.seat].choosing && room.seats[b.seat].choosing);
    clock.advance(6000);
    assert.ok(!room.hand, 'no hand while both are choosing');
    assert.throws(() => server.command(a.token, { type: 'ready' }), /choose a seat/);
    assert.throws(() => server.command(a.token, { type: 'sit', seat: b.seat }), /taken/);
    const r = server.command(a.token, { type: 'sit', seat: 4 });
    assert.strictEqual(r.seat, 4); a.seat = 4;
    assert.ok(!room.seats[0] || room.seats[0] === room.seats[b.seat], 'old seat freed');
    assert.ok(a.events.some((e) => e[0] === 'seat' && e[1].seat && e[1].seat.seat === 0 && e[1].seat.empty), 'old seat broadcast empty');
    server.command(b.token, { type: 'sit', seat: b.seat }); b.seat = room.seats.findIndex((x) => x && x.odcId === 'uc2');
    assert.throws(() => server.command(a.token, { type: 'sit', seat: 5 }), /already chosen/);
    // [SEAT_REPICK_0_10_26] 대기실에서 자리 바꾸기 — 첫 판 전이면 다시 고른다(준비 풀림)
    server.command(a.token, { type: 'ready' });
    assert.ok(server.command(a.token, { type: 'repick' }).ok);
    assert.ok(room.seats[4].choosing && !room.seats[4].ready);
    assert.strictEqual(server.command(a.token, { type: 'sit', seat: 5 }).seat, 5); a.seat = 5;
    for (const p of [a, b]) server.command(p.token, { type: 'ready' });
    waitHand(clock, () => server.rooms.get('r1'));
    assert.ok(room.hand && room.hand.seats.includes(5), 'plays from the chosen seat');
    assert.throws(() => server.command(a.token, { type: 'repick' }), /no longer/);   // 판을 친 뒤에는 못 바꾼다
    // 고르지 않으면 90초 뒤 지금 자리로
    const c = client(server, tk(3, true));
    assert.ok(room.seats[c.seat].choosing);
    clock.advance(91000);
    assert.ok(!room.seats[c.seat].choosing, 'auto-confirmed after 90s');
});

// [MINE_CHECK_0_10_26] 테이블이 열려 있는 동안 끝난 판 — 내 키로 물으면 엔진 검증 통과만(기록·카드는 닫힌 뒤)
test('테이블: 열린 테이블의 끝난 판은 엔진 검증 결과만 바로 준다 [MINE_CHECK_0_10_26]', () => {
    const { mineResponse } = require('../src/mine');
    const env = setup(2);
    const { server, clock, players, store } = env;
    waitHand(clock, () => server.rooms.get('r1'));
    const room = server.rooms.get('r1');
    const h = room.hand, p = players.find((x) => x.seat === h.toAct), t = lastTurn(p);
    assert.ok(server.command(p.token, { type: 'act', q: t.q, action: 'FOLD', amount: 0, sig: C.sign(p.sig.privateKey, C.msgAction(t.handId, t.q, 'FOLD', 0)) }).ok);
    const fp = C.fingerprint(C.publicJwk(players[0].sig.publicKey));
    const isOpen = (tid) => server.isOpen(tid);
    const [c1, list] = mineResponse(store, isOpen, fp);
    assert.strictEqual(c1, 200);
    const mineHand = list.hands.find((x) => x.handId === h.handId);
    assert.ok(mineHand && mineHand.open && mineHand.check && mineHand.check.ok, 'listed with a passing engine check');
    const [c2, b2] = mineResponse(store, isOpen, fp, h.handId);
    assert.strictEqual(c2, 409);
    assert.ok(b2.check.ok && !b2.entry, 'check only, no record');
    assert.ok(!/"[2-9TJQKA][shdc]"/.test(JSON.stringify(b2)) && !/"[2-9TJQKA][shdc]"/.test(JSON.stringify(list)), 'no card in the answers');
});

// [EMPTY_CLOSE] 모두 일어나면 10분 뒤 테이블을 닫는다(= 폴드 패가 든 판 기록이 참가자에게 열린다)
test('테이블: 모두 일어나고 10분이 지나면 닫는다 [EMPTY_CLOSE]', () => {
    const { server, players, clock } = setup(2);
    const room = server.rooms.get('r1');
    const tid = room.tableId;
    for (const p of players) if (room.seats[p.seat]) server.command(p.token, { type: 'leave' });
    assert.ok(room.seats.every((x) => !x), '모두 일어났다');
    clock.advance(9 * 60 * 1000 + 30 * 1000); server.sweep();
    assert.ok(server.isOpen(tid), '9분 30초에는 아직 열려 있다');
    clock.advance(31 * 1000); server.sweep();
    assert.ok(!server.isOpen(tid), '10분이 지나면 닫힌다');
});

test('테이블: 강퇴 — 콘솔 서명만, 치던 판은 끝까지 치고 판 뒤에 정산 [KICK_0_10_27]', () => {
    const env = setup(3);
    const { server, clock, players, out, consoleKeys } = env;
    const order = (tid, o = {}, key = consoleKeys.privateKey) => signTicket({ v: 1, typ: 'kick', tid, exp: clock.now() + 60000, ...o }, key);
    waitHand(clock, () => server.rooms.get('r1'));
    const room = server.rooms.get('r1');
    const p = players[1], s = room.seats[p.seat], tid = s.tid;
    assert.throws(() => server.kick(order(tid, {}, C.generateKeyPair().privateKey)), /signature/);
    assert.throws(() => server.kick(order(tid, { exp: clock.now() - 1 })), /expired/);
    assert.throws(() => server.kick(order(tid, { typ: 'x' })), /bad kick/);
    assert.throws(() => server.kick(env.ticket(9)), /bad kick/, '좌석표는 강퇴로 쓸 수 없다');
    assert.throws(() => server.join(order(tid)), /./, '강퇴 서명은 좌석표로 쓸 수 없다');
    assert.deepStrictEqual(server.kick(order('tid_none_0000')), { found: false, pending: false });
    const q = room.hand.q, act = room.hand.toAct;
    assert.deepStrictEqual(server.kick(order(tid)), { found: true, pending: true });
    assert.strictEqual(room.hand.toAct, act); assert.strictEqual(room.hand.q, q);
    assert.ok(!server._core(room.hand).seats.get(p.seat).isFolded, '폴드시키지 않는다');
    const before = room.seats.filter(Boolean).reduce((x, y) => x + y.stack, 0);
    playOne(env, () => 0);
    assert.strictEqual(room.seats[p.seat], null, '판이 끝나면 자리가 비었다');
    const note = out.filter((x) => x.kind === 'settle').map((x) => x.note).find((n) => n.tid === tid);
    assert.strictEqual(note.reason, 'kicked');
    const after = room.seats.filter(Boolean).reduce((x, y) => x + y.stack, 0) + note.cashOut + room.seats.filter(Boolean).reduce((x, y) => x + y.rakePaid, 0) + note.rakePaid;
    assert.ok(Math.abs(before - after) < 1e-6, '칩 보존');
    const o = players[0], s0 = room.seats[o.seat], t0 = s0.tid;
    assert.deepStrictEqual(server.kick(order(t0)), { found: true, pending: false });
    assert.strictEqual(room.seats[o.seat], null);
});
