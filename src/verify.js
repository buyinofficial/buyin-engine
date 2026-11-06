/**
 * 판 기록 검증기 — 엔진이 서명한 판 기록을 받아 처음부터 다시 돌려 본다.
 *
 *   1. 엔진 서명이 맞나 (엔진 공개키는 증명서·info 에서 받는다)
 *   2. 씨앗이 판 전에 약속한 값(seedCommit)과 맞나
 *   3. 회원 무작위 값 서명이 맞나, 그 값들로 섞으면 기록의 덱이 그대로 나오나
 *   4. 카드 약속(deckCommit)이 맞나 — 판 도중 회원이 받은 약속과 같은 값이다
 *   5. 액션을 같은 규칙(HandCore)으로 다시 돌리면 서명 확인을 모두 통과하고, 홀카드·보드·결과·스택이 기록과 같나
 *
 * 사용: node src/verify.js 기록.json [엔진_서명키.json]
 *   기록.json 은 { record, sig } 또는 { record, sig, engineKey } 모양.
 */

const C = require('./crypto');
const cards = require('./cards');
const HandCore = require('./HandCore');

function verifyRecord(record, sig, engineSigJwk) {
    const errors = [];
    const fail = (m) => { errors.push(m); };

    try {
        if (engineSigJwk) {
            const key = C.importPublicJwk(engineSigJwk);
            if (!C.verify(key, C.stableStringify(record), sig)) fail('engine signature does not match');
            if (record.engine && record.engine.sigFp && record.engine.sigFp !== C.fingerprint(engineSigJwk)) fail('engine key fingerprint differs');
        } else {
            fail('no engine key given — signature not checked');
        }

        if (cards.seedCommitOf(record.seed) !== record.seedCommit) fail('seed does not match its commitment');

        const keyOf = new Map((record.seats || []).map(s => [String(s.odcId), s.keys]));
        for (const e of record.entropy || []) {
            const k = keyOf.get(String(e.odcId));
            if (!k || !k.sig) { fail(`entropy of ${e.odcId} has no key`); continue; }
            if (!C.verify(C.importPublicJwk(k.sig), C.msgEntropy(record.tableId, record.seedCommit, e.hex), e.sig)) fail(`entropy signature of ${e.odcId} is bad`);
        }

        const deck = cards.shuffledDeck(record.seed, record.handId, record.entropy);
        if (deck.join(',') !== (record.deck || []).join(',')) fail('deck is not the one made from seed + entropy');
        if (cards.commitDeck(record.seed, record.handId, deck).deckCommit !== record.deckCommit) fail('deck commitment differs');

        const core = new HandCore({
            handId: record.handId,
            seed: record.seed,
            deck,
            seats: record.seats.map(s => ({ seat: s.seat, odcId: s.odcId, stack: record.stacksStart[s.seat], sigJwk: s.keys ? s.keys.sig : null })),
            dealer: record.dealer, sb: record.sb, bb: record.bb,
            smallBlind: record.smallBlind, bigBlind: record.bigBlind,
            peek: record.peek, allowUnsigned: record.allowUnsigned, rake: record.rake,
        });
        for (const e of record.log || []) {
            if (e.k === 'board') { core.advance(); continue; }
            if (e.k === 'runout') { core.runout(); continue; }
            const a = e.auth || {};
            core.apply({
                k: e.k, q: e.q, seat: e.seat, action: e.action, amount: e.amount, reason: e.reason, res: e.res,
                sig: a.sig, pre: a.pre, rc: a.rc,
            });
        }
        const type = record.result && record.result.type;
        if (type === 'showdown') core.showdown();
        else if (type === 'uncontested') core.uncontested();
        else if (type === 'aborted') core.abort(record.result.reason);
        else fail(`unknown result type ${type}`);

        const s = core.summary();
        const same = (name, a, b) => { if (C.stableStringify(a) !== C.stableStringify(b)) fail(`${name} differs on replay`); };
        same('holes', s.holes, record.holes);
        same('board', s.board, record.board);
        same('stacksEnd', s.stacksEnd, record.stacksEnd);
        same('result', s.result, record.result);
        same('log', s.log, record.log);
    } catch (e) {
        fail(`replay failed: ${e.message}`);
    }
    return { ok: errors.length === 0, errors };
}

module.exports = { verifyRecord };

if (require.main === module) {
    const fs = require('fs');
    const file = process.argv[2];
    if (!file) {
        console.error('usage: node src/verify.js record.json [engine-sig-key.json]');
        process.exit(2);
    }
    const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
    const key = process.argv[3] ? JSON.parse(fs.readFileSync(process.argv[3], 'utf8')) : (doc.engineKey || null);
    const r = verifyRecord(doc.record, doc.sig, key);
    console.log(r.ok ? 'OK — hand verified' : 'FAILED\n  ' + r.errors.join('\n  '));
    process.exit(r.ok ? 0 : 1);
}
