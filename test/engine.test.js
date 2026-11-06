const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const Engine = require('../src/Engine');
const C = require('../src/crypto');
const cards = require('../src/cards');
const { verifyRecord } = require('../src/verify');

/** 브라우저 대신 — 회원 키 두 벌과 서명 */
function makePlayer(odcId) {
    const sig = C.generateKeyPair();
    const ecdh = C.generateKeyPair();
    return {
        odcId: String(odcId),
        sig, ecdh,
        sigJwk: C.publicJwk(sig.publicKey),
        ecdhJwk: C.publicJwk(ecdh.publicKey),
        signAct(handId, q, action, amount) { return C.sign(sig.privateKey, C.msgAction(handId, q, action, amount)); },
    };
}

function register(engine, tableId, p) {
    const sigFp = C.fingerprint(p.sigJwk), ecdhFp = C.fingerprint(p.ecdhJwk);
    const r = engine.call('registerKeys', { tableId, odcId: p.odcId, sig: p.sigJwk, ecdh: p.ecdhJwk, proof: C.sign(p.sig.privateKey, C.msgRegister(tableId, p.odcId, sigFp, ecdhFp)) });
    assert.ok(r.ok, r.error);
    const engineKey = C.importPublicJwk(engine.call('info').keys.sig);
    assert.ok(C.verify(engineKey, C.msgKeyConfirm(tableId, p.odcId, sigFp, ecdhFp), r.confirm), 'engine confirms the key');
    return r;
}

function setupTable(n, opts = {}) {
    const engine = new Engine(opts);
    const { tableId, seedCommit } = engine.call('openTable', {});
    const players = [];
    for (let i = 0; i < n; i++) {
        const p = makePlayer(100 + i);
        p.seat = i;
        register(engine, tableId, p);
        const hex = crypto.randomBytes(32).toString('hex');
        assert.ok(engine.call('addEntropy', { tableId, odcId: p.odcId, seedCommit, hex, sig: C.sign(p.sig.privateKey, C.msgEntropy(tableId, seedCommit, hex)) }).ok);
        players.push(p);
    }
    return { engine, tableId, players };
}

function start(engine, tableId, players, stacks, extra = {}) {
    const r = engine.call('startHand', {
        tableId, handNo: 1,
        seats: players.map((p, i) => ({ seat: p.seat, odcId: p.odcId, stack: stacks[i] })),
        dealer: players[0].seat,
        sb: players.length === 2 ? players[0].seat : players[1].seat,
        bb: players.length === 2 ? players[1].seat : players[2].seat,
        smallBlind: 1, bigBlind: 2, peek: true, ...extra,
    });
    assert.ok(r.ok, r.error);
    return r;
}

test('같은 씨앗·값이면 같은 덱, 약속과 공개가 맞는다', () => {
    const seed = cards.newSeed();
    const ent = [{ seat: 2, hex: 'aa'.repeat(16) }, { seat: 0, hex: 'bb'.repeat(16) }];
    const d1 = cards.shuffledDeck(seed, 'h1', ent);
    const d2 = cards.shuffledDeck(seed, 'h1', [...ent].reverse());
    assert.deepStrictEqual(d1, d2, '받은 순서와 무관');
    assert.strictEqual(new Set(d1).size, 52);
    assert.notDeepStrictEqual(d1, cards.shuffledDeck(seed, 'h1', [{ seat: 0, hex: 'bc'.repeat(16) }]), '회원 값이 바뀌면 덱이 바뀐다');
    const { commitments } = cards.commitDeck(seed, 'h1', d1);
    const op = cards.opening(seed, 'h1', d1, 7);
    assert.ok(cards.checkOpening('h1', commitments, op));
    assert.ok(!cards.checkOpening('h1', commitments, { ...op, c: op.c === 'As' ? 'Ks' : 'As' }), '다른 카드로는 약속이 맞지 않는다');
});

test('섞기 난수는 치우치지 않는다 (첫 장 분포)', () => {
    const counts = new Array(52).fill(0);
    const deck0 = cards.newDeck();
    const seed = cards.newSeed();
    const N = 26000;
    for (let i = 0; i < N; i++) counts[deck0.indexOf(cards.shuffledDeck(seed, 'h' + i, [])[51])]++;
    const exp = N / 52;
    const chi = counts.reduce((s, c) => s + (c - exp) ** 2 / exp, 0);
    assert.ok(chi < 100, `chi-square ${chi.toFixed(1)} (자유도 51, 99.99% 기준 약 100)`);
});

test('홀카드 봉투는 본인 키로만 열리고 약속과 맞는다', () => {
    const { engine, tableId, players } = setupTable(3);
    const h = start(engine, tableId, players, [100, 100, 100]);
    const corePub = C.importPublicJwk(engine.call('info').keys.ecdh);
    for (const p of players) {
        const env = h.envelopes[p.seat];
        assert.ok(!env.plain, '평문이 아니다');
        const payload = C.openEnvelope(p.ecdh.privateKey, corePub, h.handId, env);
        assert.strictEqual(payload.cards.length, 2);
        for (const op of payload.cards) assert.ok(cards.checkOpening(h.handId, h.commitments, op));
        const other = players[(p.seat + 1) % 3];
        assert.throws(() => C.openEnvelope(other.ecdh.privateKey, corePub, h.handId, env), '남의 키로는 못 연다');
    }
    assert.strictEqual(h.entropySeats.length, 3, '세 사람 값이 다 섞였다');
});

test('라운드가 끝나기 전에는 보드를 내주지 않는다', () => {
    const { engine, tableId, players } = setupTable(3);
    const h = start(engine, tableId, players, [100, 100, 100]);
    const r = engine.call('board', { handId: h.handId });
    assert.strictEqual(r.ok, false);
    assert.match(r.error, /not due/);
});

test('서명이 없거나 틀린 콜은 거절, 운영 서버는 폴드·체크만', () => {
    const { engine, tableId, players } = setupTable(3);
    const h = start(engine, tableId, players, [100, 100, 100]);
    const [p0] = players;
    let r = engine.call('act', { handId: h.handId, entry: { k: 'act', seat: p0.seat, q: 0, action: 'CALL', amount: 0 } });
    assert.strictEqual(r.ok, false, '서명 없음');
    r = engine.call('act', { handId: h.handId, entry: { k: 'act', seat: p0.seat, q: 0, action: 'CALL', amount: 0, sig: players[1].signAct(h.handId, 0, 'CALL', 0) } });
    assert.strictEqual(r.ok, false, '남의 서명');
    r = engine.call('act', { handId: h.handId, entry: { k: 'host', seat: p0.seat, q: 0, action: 'CALL', amount: 0 } });
    assert.strictEqual(r.ok, false, '운영 서버 콜');
    r = engine.call('act', { handId: h.handId, entry: { k: 'act', seat: p0.seat, q: 1, action: 'CALL', amount: 0, sig: p0.signAct(h.handId, 1, 'CALL', 0) } });
    assert.strictEqual(r.ok, false, '다른 차례 번호');
    r = engine.call('act', { handId: h.handId, entry: { k: 'act', seat: p0.seat, q: 0, action: 'CALL', amount: 0, sig: p0.signAct(h.handId, 0, 'CALL', 0), res: { action: 'CALL', amount: 2 } } });
    assert.ok(r.ok, r.error);
    r = engine.call('act', { handId: h.handId, entry: { k: 'host', seat: players[1].seat, q: 1, action: 'FOLD', reason: 'timeout' } });
    assert.ok(r.ok, r.error);
});

test('키는 판 시작 때 고정 — 판 도중에 바꿔 끼운 키로는 그 판에서 아무것도 못 한다', () => {
    const { engine, tableId, players } = setupTable(2);
    const h = start(engine, tableId, players, [100, 100]);
    const thief = makePlayer(players[0].odcId);   // 같은 회원 이름으로 다른 키 (운영 서버가 바꿔 끼운 경우)
    const sigFp = C.fingerprint(thief.sigJwk), ecdhFp = C.fingerprint(thief.ecdhJwk);
    const r = engine.call('registerKeys', { tableId, odcId: thief.odcId, sig: thief.sigJwk, ecdh: thief.ecdhJwk, proof: C.sign(thief.sig.privateKey, C.msgRegister(tableId, thief.odcId, sigFp, ecdhFp)) });
    assert.ok(r.ok && r.changed, '등록은 된다 (다음 판부터)');
    const corePub = C.importPublicJwk(engine.call('info').keys.ecdh);
    assert.throws(() => C.openEnvelope(thief.ecdh.privateKey, corePub, h.handId, h.envelopes[players[0].seat]), '이번 판 봉투는 못 연다');
    const bad = engine.call('act', { handId: h.handId, entry: { k: 'act', seat: players[0].seat, q: 0, action: 'CALL', amount: 0, sig: thief.signAct(h.handId, 0, 'CALL', 0) } });
    assert.strictEqual(bad.ok, false, '이번 판에서는 새 키 서명이 안 먹는다');
    const good = engine.call('act', { handId: h.handId, entry: { k: 'act', seat: players[0].seat, q: 0, action: 'CALL', amount: 0, sig: players[0].signAct(h.handId, 0, 'CALL', 0) } });
    assert.ok(good.ok, '판 시작 때 키는 그대로 유효');
});

test('미리 고른 자동 콜은 허락 서명이 있어야 하고 한 번만 쓴다', () => {
    const { engine, tableId, players } = setupTable(3);
    const h = start(engine, tableId, players, [100, 100, 100]);
    const p0 = players[0];
    const nonce = 'n1';
    const pre = { p: 'autoCall', nonce, sig: C.sign(p0.sig.privateKey, C.msgPreAction(h.handId, 'autoCall', nonce)) };
    let r = engine.call('act', { handId: h.handId, entry: { k: 'pre', seat: p0.seat, q: 0, action: 'CALL', pre } });
    assert.ok(r.ok, r.error);
    // 같은 허락을 다시 쓰려 하면 (다른 차례라도) 거절
    engine.call('act', { handId: h.handId, entry: { k: 'act', seat: 1, q: 1, action: 'CALL', amount: 0, sig: players[1].signAct(h.handId, 1, 'CALL', 0) } });
    engine.call('act', { handId: h.handId, entry: { k: 'act', seat: 2, q: 2, action: 'RAISE', amount: 6, sig: players[2].signAct(h.handId, 2, 'RAISE', 6) } });
    r = engine.call('act', { handId: h.handId, entry: { k: 'pre', seat: p0.seat, q: 3, action: 'CALL', pre } });
    assert.strictEqual(r.ok, false);
});

/** 무작위로 한 판을 끝까지 — 회원은 서명으로, 가끔 운영 서버 폴드·퇴장 */
function playRandom(engine, h, players, rnd) {
    const core = engine.hands.get(h.handId).core;
    let guard = 0;
    for (;;) {
        if (++guard > 500) throw new Error('loop');
        const st = core.status();
        if (st === 'advance') { assert.ok(engine.call('board', { handId: h.handId }).ok); continue; }
        if (st === 'runout') { assert.ok(engine.call('runout', { handId: h.handId }).ok); continue; }
        if (st === 'showdown' || st === 'uncontested') return engine.call('finish', { handId: h.handId });
        const live = core.order.map(s => core.seats.get(s)).filter(p => !p.isFolded && !p.isAllIn);
        if (rnd() < 0.03) {
            const v = live[Math.floor(rnd() * live.length)];
            assert.ok(engine.call('act', { handId: h.handId, entry: { k: 'leave', seat: v.seat, reason: 'left' } }).ok);
            continue;
        }
        // 차례 순서는 운영 서버 몫 — 여기서는 아직 맞추지 않았거나 행동하지 않은 사람 아무나
        const cand = live.filter(p => !core.acted.has(p.seat) || p.currentBet < core.currentBet);
        const p = cand[Math.floor(rnd() * cand.length)];
        const pl = players.find(x => x.seat === p.seat);
        const canCheck = core.currentBet <= p.currentBet;
        const x = rnd();
        let action, amount = 0;
        if (x < 0.15) action = 'FOLD';
        else if (x < 0.5) action = canCheck ? 'CHECK' : 'CALL';
        else if (x < 0.85) { action = 'RAISE'; amount = Math.round((core.currentBet + core.bigBlind * (1 + rnd() * 6)) * 1000) / 1000; }
        else action = 'ALL_IN';
        const q = core.turns;
        let entry;
        if (rnd() < 0.1 && (action === 'FOLD' || action === 'CHECK')) entry = { k: 'host', seat: p.seat, q, action, reason: 'timeout' };
        else entry = { k: 'act', seat: p.seat, q, action, amount, sig: pl.signAct(h.handId, q, action, amount) };
        const r = engine.call('act', { handId: h.handId, entry });
        assert.ok(r.ok, `${action} ${amount}: ${r.error}`);
    }
}

function mulberry(seed) {
    let a = seed >>> 0;
    return () => {
        a = (a + 0x6D2B79F5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

test('무작위 판 3000개 — 칩 보존(레이크 포함), 기록 서명·재현 검증 통과', () => {
    const rnd = mulberry(20261106);
    let showdowns = 0, uncontested = 0, rakedHands = 0;
    for (let i = 0; i < 3000; i++) {
        const n = 2 + Math.floor(rnd() * 8);
        const { engine, tableId, players } = setupTable(n);
        const stacks = players.map(() => Math.round((5 + rnd() * 300) * 10) / 10);
        const rake = i % 2 ? { percent: 4.7, minPot: 1 } : undefined;   // 반은 레이크 있는 테이블
        const h = start(engine, tableId, players, stacks, { smallBlind: 0.5, bigBlind: 1, rake });
        const f = playRandom(engine, h, players, rnd);
        assert.ok(f.ok, f.error);
        if (f.type === 'showdown') showdowns++; else uncontested++;
        const rk = f.record.result.rake;
        const taken = rk ? rk.totalRake : 0;
        if (rk) {
            assert.ok(Math.abs(rk.perSeat.reduce((s, x) => s + x.fee, 0) - taken) < 1e-9, '사람별 레이크 합 = 총 레이크');
            assert.ok(rk.perSeat.every(x => x.fee >= 0 && x.fee <= x.basis + 1e-9), '낸 금액보다 많이 떼지 않는다');
            if (!rake) assert.strictEqual(taken, 0, '레이크 없는 테이블');
            else assert.ok(taken <= rk.feeBase * 0.047 + 1e-9, '규칙 비율을 넘지 않는다');
            if (taken > 0) rakedHands++;
        }
        const before = Object.values(f.record.stacksStart).reduce((s, v) => s + v, 0);
        const after = Object.values(f.record.stacksEnd).reduce((s, v) => s + v, 0);
        assert.ok(Math.abs(before - after - taken) < 1e-6, `chips ${before} → ${after} + rake ${taken}`);
        const v = verifyRecord(f.record, f.sig, engine.call('info').keys.sig);
        assert.ok(v.ok, v.errors.join('; '));
    }
    assert.ok(showdowns > 300 && uncontested > 300, `showdown ${showdowns} / uncontested ${uncontested}`);
    assert.ok(rakedHands > 300, `레이크 뗀 판 ${rakedHands}`);
});

test('기록을 고치면 검증이 실패한다', () => {
    const rnd = mulberry(7);
    const { engine, tableId, players } = setupTable(3);
    const h = start(engine, tableId, players, [50, 50, 50]);
    const f = playRandom(engine, h, players, rnd);
    const key = engine.call('info').keys.sig;
    assert.ok(verifyRecord(f.record, f.sig, key).ok);
    const swapped = JSON.parse(JSON.stringify(f.record));
    const holes = swapped.holes[players[0].seat];
    holes[0] = holes[0] === 'As' ? 'Ks' : 'As';
    assert.strictEqual(verifyRecord(swapped, f.sig, key).ok, false, '홀카드 바꿈');
    const seed2 = JSON.parse(JSON.stringify(f.record));
    seed2.seed = cards.newSeed();
    const r2 = verifyRecord(seed2, C.sign(engine.sigKeys.privateKey, C.stableStringify(seed2)), key);
    assert.strictEqual(r2.ok, false, '씨앗 바꿈 — 엔진이 다시 서명해도 약속과 안 맞는다');
});

test('폴드승: 남은 보드 보기와 못 맞춘 베팅 반환', () => {
    const { engine, tableId, players } = setupTable(3);
    const h = start(engine, tableId, players, [100, 100, 100]);
    const [p0, p1, p2] = players;
    let q = 0;
    const act = (p, action, amount = 0) => {
        const r = engine.call('act', { handId: h.handId, entry: { k: 'act', seat: p.seat, q, action, amount, sig: p.signAct(h.handId, q, action, amount) } });
        q++;
        assert.ok(r.ok, r.error);
        return r;
    };
    act(p0, 'RAISE', 10);
    act(p1, 'FOLD');
    act(p2, 'FOLD');
    const f = engine.call('finish', { handId: h.handId });
    assert.ok(f.ok, f.error);
    assert.strictEqual(f.type, 'uncontested');
    assert.strictEqual(f.result.winner, p0.seat);
    assert.strictEqual(f.result.amount, 13);
    assert.strictEqual(f.peekBoard.length, 5, '프리플랍 폴드승 — 다섯 장');
    for (const op of f.peekBoard) assert.ok(cards.checkOpening(h.handId, h.commitments, op));
    assert.deepStrictEqual(f.record.stacksEnd, { 0: 103, 1: 99, 2: 98 });
});

test('키를 안 등록한 좌석: 봉투 없음, 칩이 나가는 액션 불가, 체크·폴드만', () => {
    const engine = new Engine();
    const { tableId } = engine.call('openTable', {});
    const p = makePlayer('a');
    register(engine, tableId, p);
    const r = engine.call('startHand', { tableId, handNo: 1, seats: [{ seat: 0, odcId: 'a', stack: 10 }, { seat: 1, odcId: 'b', stack: 10 }], dealer: 0, sb: 0, bb: 1, smallBlind: 1, bigBlind: 2 });
    assert.ok(r.ok, r.error);
    assert.ok(r.envelopes[0] && !r.envelopes[0].plain, '키 있는 좌석은 봉투');
    assert.strictEqual(r.envelopes[1], null, '키 없는 좌석은 카드가 안 나간다');
    assert.ok(engine.call('act', { handId: r.handId, entry: { k: 'act', seat: 0, q: 0, action: 'CALL', amount: 0, sig: p.signAct(r.handId, 0, 'CALL', 0) } }).ok);
    assert.strictEqual(engine.call('act', { handId: r.handId, entry: { k: 'act', seat: 1, q: 1, action: 'RAISE', amount: 6 } }).ok, false, '서명 없는 레이즈');
    assert.ok(engine.call('act', { handId: r.handId, entry: { k: 'host', seat: 1, q: 1, action: 'CHECK', reason: 'absent' } }).ok, '운영 서버 체크');
});

test('RULES 2·5장 — 운영 모드에서 시험 설정 금지, 이상한 입력 거절', () => {
    assert.throws(() => new Engine({ allowUnsigned: true, mode: 'nitro' }), /dev mode/);
    const { engine, tableId, players } = setupTable(2);
    const base = { tableId, handNo: 1, dealer: 0, sb: 0, bb: 1, smallBlind: 1, bigBlind: 2 };
    const seats = (a, b) => [{ seat: 0, odcId: players[0].odcId, stack: a }, { seat: 1, odcId: players[1].odcId, stack: b }];
    for (const [label, p] of [
        ['음수 스택', { ...base, seats: seats(-5, 10) }],
        ['NaN 스택', { ...base, seats: seats('x', 10) }],
        ['무한 스택', { ...base, seats: seats(Infinity, 10) }],
        ['0.0001 단위', { ...base, seats: seats(10.0001, 10) }],
        ['SB ≥ BB', { ...base, seats: seats(10, 10), smallBlind: 2, bigBlind: 2 }],
        ['좌석 번호', { ...base, seats: [{ seat: 99, odcId: players[0].odcId, stack: 10 }, { seat: 1, odcId: players[1].odcId, stack: 10 }] }],
        ['같은 회원 두 자리', { ...base, seats: [{ seat: 0, odcId: players[0].odcId, stack: 10 }, { seat: 1, odcId: players[0].odcId, stack: 10 }] }],
        ['좌석 없음', { ...base, seats: null }],
    ]) {
        const r = engine.call('startHand', p);
        assert.strictEqual(r.ok, false, label);
    }
    assert.ok(engine.call('startHand', { ...base, seats: seats(10, 10) }).ok, '정상 입력은 통과');
});
