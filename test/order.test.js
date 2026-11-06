const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const Engine = require('../src/Engine');
const C = require('../src/crypto');
const { verifyRecord } = require('../src/verify');

function player(id) {
    const sig = C.generateKeyPair(), ecdh = C.generateKeyPair();
    return { odcId: String(id), sig, ecdh, sigJwk: C.publicJwk(sig.publicKey), ecdhJwk: C.publicJwk(ecdh.publicKey) };
}

function table(n) {
    const engine = new Engine();
    const { tableId } = engine.call('openTable', {});
    const ps = [];
    for (let i = 0; i < n; i++) {
        const p = player(200 + i); p.seat = i;
        const sigFp = C.fingerprint(p.sigJwk), ecdhFp = C.fingerprint(p.ecdhJwk);
        assert.ok(engine.call('registerKeys', { tableId, odcId: p.odcId, sig: p.sigJwk, ecdh: p.ecdhJwk, proof: C.sign(p.sig.privateKey, C.msgRegister(tableId, p.odcId, sigFp, ecdhFp)) }).ok);
        ps.push(p);
    }
    return { engine, tableId, ps };
}

const rnd = (n) => crypto.randomInt(n);

test('차례 순서(strictOrder): 프리플랍 첫 차례·플랍 첫 차례·헤즈업', () => {
    for (const n of [2, 3, 6]) {
        const { engine, tableId, ps } = table(n);
        const dealer = 0, sb = n === 2 ? 0 : 1, bb = n === 2 ? 1 : 2;
        const h = engine.call('startHand', { tableId, handNo: 1, seats: ps.map((p) => ({ seat: p.seat, odcId: p.odcId, stack: 100 })), dealer, sb, bb, smallBlind: 1, bigBlind: 2, strictOrder: true });
        assert.ok(h.ok, h.error);
        const core = engine.hands.get(h.handId).core;
        assert.strictEqual(core.toAct(), n === 2 ? 0 : (bb + 1) % n, `${n}명 프리플랍 첫 차례`);
        // 차례가 아닌 좌석은 거절
        const wrong = (core.toAct() + 1) % n;
        const bad = engine.call('act', { handId: h.handId, entry: { k: 'host', seat: wrong, q: 0, action: 'FOLD', reason: 'x' } });
        assert.strictEqual(bad.ok, false); assert.match(bad.error, /not to act/);
        // 모두 콜·체크 → 플랍 첫 차례는 딜러 다음
        let q = 0;
        while (core.status() === 'continue') {
            const s = core.toAct(); const pl = ps[s];
            const need = core.currentBet - core.seats.get(s).currentBet;
            const action = need > 0 ? 'CALL' : 'CHECK';
            assert.ok(engine.call('act', { handId: h.handId, entry: { k: 'act', seat: s, q, action, amount: 0, sig: C.sign(pl.sig.privateKey, C.msgAction(h.handId, q, action, 0)) } }).ok);
            q++;
        }
        assert.ok(engine.call('board', { handId: h.handId }).ok);
        assert.strictEqual(core.toAct(), n === 2 ? 1 : 1, `${n}명 플랍 첫 차례 = 딜러 다음`);
    }
});

test('차례 순서(strictOrder): 무작위 판 600개 — toAct 만 따라가면 끝까지 가고 칩 보존·기록 재현', () => {
    for (let g = 0; g < 600; g++) {
        const n = 2 + rnd(5);
        const { engine, tableId, ps } = table(n);
        const stacks = ps.map(() => 20 + rnd(200));
        const dealer = rnd(n); const sb = n === 2 ? dealer : (dealer + 1) % n; const bb = (sb + 1) % n;
        const h = engine.call('startHand', { tableId, handNo: 1, seats: ps.map((p, i) => ({ seat: p.seat, odcId: p.odcId, stack: stacks[i] })), dealer, sb, bb, smallBlind: 1, bigBlind: 2, strictOrder: true });
        assert.ok(h.ok, h.error);
        const core = engine.hands.get(h.handId).core;
        let q = 0, guard = 0;
        for (;;) {
            const st = core.status();
            if (st === 'continue') {
                const s = core.toAct(); assert.notStrictEqual(s, null, 'continue 인데 차례가 없다');
                const p = core.seats.get(s); const need = core.currentBet - p.currentBet;
                const choices = need > 0 ? ['FOLD', 'CALL', 'RAISE', 'ALL_IN'] : ['CHECK', 'BET', 'ALL_IN'];
                const action = choices[rnd(choices.length)];
                const amount = action === 'RAISE' || action === 'BET' ? core.calculateMinRaise() + rnd(10) : 0;
                const r = engine.call('act', { handId: h.handId, entry: { k: 'act', seat: s, q, action, amount, sig: C.sign(ps[s].sig.privateKey, C.msgAction(h.handId, q, action, amount)) } });
                assert.ok(r.ok, r.error); q++;
            } else if (st === 'advance') assert.ok(engine.call('board', { handId: h.handId }).ok);
            else if (st === 'runout') assert.ok(engine.call('runout', { handId: h.handId }).ok);
            else break;
            assert.ok(++guard < 500, 'hand never ends');
        }
        const f = engine.call('finish', { handId: h.handId });
        assert.ok(f.ok, f.error);
        const sum = (o) => Object.values(o).reduce((a, b) => a + b, 0);
        const rk = f.record.result && f.record.result.rake; const rake = rk ? rk.totalRake : 0;
        assert.ok(Math.abs(sum(f.record.stacksStart) - sum(f.record.stacksEnd) - rake) < 1e-6, 'chips conserved');
        assert.strictEqual(f.record.strictOrder, true);
        const v = verifyRecord(f.record, f.sig, engine.call('info').keys.sig);
        assert.deepStrictEqual(v.errors, []);
    }
});
