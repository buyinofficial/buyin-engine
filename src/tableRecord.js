'use strict';
/**
 * [TABLE_RECORD_2026_11_10] 한 테이블의 공개 기록 — GET /records/table/<tableId>(.html)
 *
 *   판마다: 좌석 번호, 시작/끝 칩, 레이크, 사슬 위치, 영수증, 그리고 이 엔진이 지금 그 판 기록을 src/verify.js 로 다시 검증한 결과.
 *   검증은 엔진 서명 · 씨앗 = 판 전에 알린 약속(seedCommit) · 덱 = 씨앗 + 회원이 서명한 무작위 값으로 섞은 덱 ·
 *   카드 약속(deckCommit) · 모든 액션을 같은 규칙으로 다시 돌린 결과(홀카드·보드·결과·칩)가 기록과 같은지.
 *   카드·덱·씨앗·회원 번호는 내보내지 않는다 — 결과(통과/실패와 실패 이유)만.
 */
const { verifyRecord } = require('./verify');

/** @returns {{ hands: object[], allOk: boolean }} */
function tableReport(store, tableId) {
    const keyOf = new Map(store.engineKeys().map((l) => [l.keys && l.keys.sigFp, l.keys && l.keys.sig]));
    const hands = store.tableResults(tableId).map((h) => {
        const line = store.getHand(h.handId);
        const v = line ? verifyRecord(line.record, line.sig, keyOf.get(h.engineSigFp)) : { ok: false, errors: ['record not found'] };
        return { ...h, check: { ok: v.ok, errors: v.errors } };
    });
    // 판과 판 사이의 팁 — 보낸 사람이 자기 키로 서명한 줄. 회원 번호 대신 그 직전 판의 자리 번호로 보여 준다
    const seatOf = (odc, i) => {
        let seat = null;
        for (const h of hands) {
            if (h.i > i) break;
            const line = store.getHand(h.handId);
            const s = line && (line.record.seats || []).find((x) => String(x.odcId) === String(odc));
            if (s) seat = s.seat;
        }
        return seat;
    };
    const tips = store.tableTips(tableId).map((e) => ({ i: e.i, at: e.at, fromSeat: seatOf(e.fromOdc, e.i), toSeat: e.toSeat, amount: e.amount, type: e.type, signed: !!e.sig }));
    // [REBUY_2026_11_11] 추가 바이인 — 칩 0 좌석에 콘솔 서명 영수증으로 칩이 들어간 줄. 회원 번호 대신 자리 번호
    const topups = (store.tableTopups ? store.tableTopups(tableId) : []).map((e) => ({ i: e.i, at: e.at, seat: seatOf(e.odcId, e.i), amount: e.amount }));
    return { hands, tips, topups, allOk: hands.length > 0 && hands.every((h) => h.check.ok) };
}

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const n3 = (v) => (Math.round(Number(v || 0) * 1000) / 1000).toFixed(3);
const net = (s) => { const d = Math.round((Number(s.end) - Number(s.start)) * 1000) / 1000; return (d > 0 ? '+' : d < 0 ? '-' : '') + Math.abs(d).toFixed(3); };
const link = (u) => `<a href="${esc(u)}">${esc(u)}</a>`;

/** AI 웹 열람기가 읽는 HTML — 주소는 진짜 링크 */
function tableRecordHtml(tableId, report, engine, base) {
    const { hands, allOk } = report;
    const tips = report.tips || [];
    const topups = report.topups || [];
    const handRow = (h) => `<tr><td>${h.handNo ?? ''}</td><td>${esc(h.handId)}</td><td>${new Date(h.endedAt).toISOString().replace('.000', '')}</td><td>#${h.i}</td><td>${esc(h.type || '')}</td><td>`
        + h.seats.map((s) => `seat ${s.seat}: ${n3(s.start)} &rarr; ${n3(s.end)} (${net(s)}), rake ${n3(s.rake)}`).join('<br>')
        + `</td><td>${h.check.ok ? '<b>PASS</b>' : '<b>FAIL</b>: ' + esc(h.check.errors.join('; '))}</td><td>${link(`${base}/records/receipt/${h.handId}`)}</td></tr>`;
    const tipRow = (t) => `<tr><td>tip</td><td></td><td>${new Date(t.at).toISOString().replace('.000', '')}</td><td>#${t.i}</td><td>tip</td><td>seat ${t.fromSeat ?? '?'} &rarr; seat ${t.toSeat}: ${n3(t.amount)} (${esc(t.type || '')}), signed by the sender's own key: ${t.signed ? 'yes' : 'no'}</td><td>between hands</td><td></td></tr>`;
    const topRow = (u) => `<tr><td>buy-in</td><td></td><td>${new Date(u.at).toISOString().replace('.000', '')}</td><td>#${u.i}</td><td>buy-in</td><td>seat ${u.seat ?? '?'}: +${n3(u.amount)} (the seat had 0 chips and asked for it; console-signed receipt)</td><td>between hands</td><td></td></tr>`;
    const rows = [...hands.map((h) => ({ i: h.i, h })), ...tips.map((t) => ({ i: t.i, t })), ...topups.map((u) => ({ i: u.i, u }))].sort((a, b) => a.i - b.i)
        .map((x) => (x.t ? tipRow(x.t) : x.u ? topRow(x.u) : handRow(x.h))).join('\n');
    const seats = [...new Set(hands.flatMap((h) => h.seats.map((s) => s.seat)))].sort((a, b) => a - b).map((seat) => {
        const mine = hands.filter((h) => h.seats.some((s) => s.seat === seat));
        const f = mine[0].seats.find((s) => s.seat === seat), l = mine[mine.length - 1].seats.find((s) => s.seat === seat);
        return `<li>seat ${seat}: ${mine.length} hand(s), first start ${n3(f.start)}, last end ${n3(l.end)}</li>`;
    }).join('');
    const passed = hands.filter((h) => h.check.ok).length;
    return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">`
        + `<title>BUY-IN table record ${esc(tableId)} — from inside the TEE</title>`
        + `<style>body{font:14px/1.55 ui-monospace,Consolas,monospace;max-width:1200px;margin:24px auto;padding:0 16px}table{border-collapse:collapse;width:100%}td,th{border:1px solid #999;padding:4px 6px;text-align:left;vertical-align:top}</style></head><body>`
        + `<h1>BUY-IN table record — produced inside the TEE</h1>`
        + `<p>Engine: ${esc(engine.name)} ${esc(engine.version)} · Source commit ${esc(engine.commit)} · engine key ${esc(engine.sigFp || '')}<br>`
        + `This page is served by the engine itself. Which public source this engine is, and its hardware attestation: ${link(base + '/ai.html')}</p>`
        + `<p>Table: <b>${esc(tableId)}</b> · finished hands recorded: <b>${hands.length}</b> · amounts in USDT · chips per seat at the start and end of each hand.</p>`
        + `<h2>Deck and replay check</h2>`
        + `<p>Hands that passed: <b>${passed} / ${hands.length}</b> · all passed: <b>${allOk ? 'YES' : 'NO'}</b></p>`
        + `<p>For every hand below, this engine has just re-checked the hand's record with src/verify.js (verifyRecord):<br>`
        + `1. the record is signed by the attested engine key;<br>`
        + `2. the seed matches the commitment (seedCommit) the engine announced before the hand, so the deck was fixed before anyone acted;<br>`
        + `3. every player's random value is signed by that player's own key, and shuffling with seed + those values (src/cards.js shuffledDeck) gives exactly the recorded deck, so neither the engine nor the operator could choose the deck alone;<br>`
        + `4. the card commitments (deckCommit) players received during the hand match that deck, so no card was swapped during the hand;<br>`
        + `5. replaying every action with the same rules (src/HandCore.js) gives the same hole cards, board, result and chips as the record.<br>`
        + `PASS means all five held. The cards, deck and seed themselves are not shown on this page; only the players of a hand can read them, signed with their own key, at ${link(base + '/table/verify.html')}.</p>`
        + `<p>Tips: ${tips.length}. A tip moves chips from one seat to another between hands (the "tip" rows, in chain order), so a seat's chips at the start of a hand can differ from its chips at the end of the previous hand by exactly those tips. Each tip is signed by the sender's own key and is a line in the same chain.</p>`
        + `<p>Buy-ins after going bust: ${topups.length}. A seat that lost all its chips stays at the table and can ask the host for another buy-in; the chips arrive between hands with a receipt signed by the console (the "buy-in" rows, in chain order), only for a seat that has 0 chips and asked for it.</p>`
        + `<p>Each hand is a line in this engine's hash chain; the receipt link gives its chain position and record hash. A finished hand line cannot be changed (src/store.js). Member numbers are not shown.</p>`
        + `<table><thead><tr><th>Hand no.</th><th>Hand ID</th><th>Ended (UTC)</th><th>Chain line</th><th>Result</th><th>Seat: start &rarr; end (net), rake</th><th>Deck and replay check</th><th>Receipt</th></tr></thead><tbody>\n${rows}\n</tbody></table>`
        + `<h2>Per seat</h2><ul>${seats || '<li>no finished hands</li>'}</ul></body></html>`;
}

module.exports = { tableReport, tableRecordHtml };
