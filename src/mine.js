'use strict';
/**
 * [MINE_OPEN_0_9_23] POST /records/mine 의 답 — 그 판에 앉았던 회원 키로 서명한 요청에만.
 *   handId 없음 → 이 키로 앉았던 판 목록(영수증). 아직 열린 테이블의 판에는 open: true 를 붙인다.
 *   handId 있음 → 그 판의 사슬 줄 전체. 단 테이블이 아직 열려 있으면 주지 않는다(409 table open).
 *     판 기록에는 그 판 참가자 전원의 홀카드(폴드한 사람 것 포함)가 들어 있다 — 같은 상대와 계속 치는 동안
 *     앞 판에서 폴드한 상대 카드를 볼 수 없게, 검증은 테이블이 닫힌 뒤에 한다(공개 영수증·테이블 기록과 같은 기준).
 * @param {object} store   RecordStore
 * @param {(tableId: string) => boolean} isOpen  지금 열린 테이블인가
 * @param {string} fp       요청한 회원 서명 키 지문(서명 확인은 부르는 쪽)
 * @param {string} [handId]
 * @returns {[number, object]} HTTP 상태, 본문
 */
function mineResponse(store, isOpen, fp, handId) {
    const mine = store.handsOfKey(fp);
    const tableOf = (id) => { const r = store.receipt(id); return r && r.tableId ? String(r.tableId) : String(id).split('.')[0]; };
    if (!handId) {
        const hands = mine.map((id) => store.receipt(id)).filter(Boolean).map((r) => (isOpen(String(r.tableId)) ? { ...r, open: true } : r));
        return [200, { ok: true, sigFp: fp, hands }];
    }
    if (!mine.includes(String(handId))) return [404, { ok: false, error: 'not your hand' }];
    if (isOpen(tableOf(String(handId)))) return [409, { ok: false, open: true, error: 'table open — the record of this hand opens after the table closes' }];
    return [200, { ok: true, entry: store.getHand(handId) }];
}

module.exports = { mineResponse };
