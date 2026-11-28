/**
 * 좌석표 — 콘솔(운영)이 회원 잔액을 잠근 뒤 발급하는 서명된 입장권.
 *
 *   ticket = base64url(JSON 본문) + "." + base64url(ECDSA P-256 서명, ieee-p1363)
 *   서명 대상 = 본문 base64url 문자열 그대로 (재직렬화 차이가 없게)
 *
 * 본문 {
 *   v: 1, tid: 좌석표 번호(한 번만 쓴다), exp: 만료(ms),
 *   room: { id, name, sb, bb, maxPlayers, rake: { percent, minPot, unit? }, turnSec, endsAt, sessionMin?, unit?, tip?, game? },
 *         game  (선택) [OMAHA_0_10_23] holdem(기본) · plo4 · plo5 — 오마하는 팟 리밋, 족보는 홀 2 + 보드 3. plo5 는 카드 수 때문에 8인까지
 *         rake.unit (선택) 칩 최소 단위 1 — 원화 방. 블라인드·바이인이 정수여야 하고, 레이크·나눠 갖는 팟을 1 단위로 버린다 [CHIP_UNIT_0_10_6]
 *         sessionMin (선택) 방 게임 시간(분, 0~720) — 모두 준비하면 첫 판부터 재고, 끝나면 마지막 3판 뒤 준비 대기로 돌아간다.
 *                    있으면 endsAt 으로 방을 닫지 않는다 [READY_SESSION_0_10_6]
 *         unit  (선택) 1바이인 금액 — 화면에 「바이인 신청」 금액으로 보여 줄 뿐, 엔진 계산에는 쓰지 않는다
 *   display: { currency, rate, chipRate?, rates? }   (선택) 화면 표시 환산 — 금액 × rate 를 currency 로 보여 준다. rates = 고를 수 있는 통화별 비율(KRW·USDT·VND)
 *         chipRate (선택) 칩 그림 환산 — 칩 더미를 금액 ÷ chipRate 로 나눠 그린다(원화 방 1 USDT = chipRate 원).
 *                  50만원이 1000짜리 칩 500개로 쌓이지 않게 테더 기준 칩으로 보인다. 그림뿐 — 게임·정산 금액에는 쓰지 않는다 [CHIP_VISUAL_0_10_7]
 *   player: { sessionId, odcId, nickname, avatar, country? },   // [IP_FLAG_0_10_44] country = 접속 IP 의 나라(ISO 두 글자, 콘솔이 정함) — 국기 그림만
 *   buyIn: 칩(=잠근 금액), currency
 *   watch: 1 (선택) — [WATCH_0_10_20] 관전 좌석표(방장). 자리·칩이 없고 판에 들지 않는다. buyIn 이 없다.
 *          받는 것은 모두에게 공개되는 이벤트·상태뿐(홀카드 봉투 없음), 할 수 있는 것은 채팅·나가기뿐이다
 *   topup: 1 (선택) — [TOPUP_0_10_30] 앉아 있는 자리에 칩을 더한다(게임 중 추가 바이인). player.sessionId 는 지금 앉은 세션이어야 하고,
 *          칩은 그 회원이 판에 들어 있으면 판이 끝난 뒤 들어간다. 자리·좌석 번호·고르기는 쓰지 않는다.
 *   hist: { bi, amt, net } (선택), carry (선택) — [ROOM_HIST_0_10_69] 표시용 이 방 지난 기록·들고 온 칩(프로필 창만)
 *          watch: 2 = [GUEST_WATCH_0_10_27] 방 코드로 들어온 관전 회원 — 받는 것은 같고, 할 수 있는 것은 나가기뿐(채팅 없음)
 * }
 *
 * 콘솔이 정할 수 있는 것은 "누가, 어느 방에, 얼마로 앉나"와 방 규칙뿐이다. 카드·차례·결과는 엔진이 정한다.
 * 콘솔 공개키는 배포 설정(docker-compose, 측정됨)의 TEE_CONSOLE_KEY 로 들어온다 — 누구나 어떤 키인지 본다.
 */

const C = require('../crypto');

const MAX_TICKET = 4096;

function b64uJson(s) {
    return JSON.parse(Buffer.from(String(s), 'base64url').toString('utf8'));
}

function money(n) {
    return Number.isFinite(n) && n > 0 && n < 1e12 && Math.abs(Math.round(n * 1000) - n * 1000) < 1e-6;
}

class TicketError extends Error {
    constructor(msg) { super(msg); this.code = 'ticket'; }
}

/**
 * @param {string} ticket
 * @param {KeyObject} consoleKey 콘솔 공개키
 * @param {number} now
 * @returns 검사를 통과한 본문
 */
function verifyTicket(ticket, consoleKey, now = Date.now()) {
    const t = String(ticket || '');
    if (!t || t.length > MAX_TICKET) throw new TicketError('bad ticket');
    const dot = t.indexOf('.');
    if (dot <= 0) throw new TicketError('bad ticket');
    const body = t.slice(0, dot), sig = t.slice(dot + 1);
    if (!C.verify(consoleKey, body, sig)) throw new TicketError('ticket signature is not the console\'s');
    let p;
    try { p = b64uJson(body); } catch (_e) { throw new TicketError('bad ticket body'); }

    if (p.v !== 1) throw new TicketError('unknown ticket version');
    if (!/^[A-Za-z0-9_-]{8,64}$/.test(String(p.tid || ''))) throw new TicketError('bad ticket id');
    if (!(Number(p.exp) > now)) throw new TicketError('ticket expired');
    const r = p.room || {}, pl = p.player || {};
    const room = {
        id: String(r.id || ''), name: String(r.name || '').slice(0, 40),
        sb: Number(r.sb), bb: Number(r.bb), maxPlayers: Number(r.maxPlayers),
        rake: { percent: Number(r.rake && r.rake.percent) || 0, minPot: Number(r.rake && r.rake.minPot) || 0, ...(Number(r.rake && r.rake.unit) === 1 ? { unit: 1 } : {}),
            ...(r.rake && r.rake.cap !== undefined && r.rake.cap !== null && Number(r.rake.cap) !== 0 ? { cap: Number(r.rake.cap) } : {}) },   // [RAKE_CAP_0_10_29] 한 판 레이크 상한(칩)
        turnSec: Number(r.turnSec) || 20, endsAt: Number(r.endsAt) || 0,
        sessionMin: Math.max(0, Math.min(720, Math.floor(Number(r.sessionMin) || 0))),
        unit: money(Number(r.unit)) ? Number(r.unit) : 0,
        // [TIP_HOUSE_0_10_12] 팁 한 개 금액(칩) — 있으면 팁은 받는 사람이 아니라 본사로 간다(콘솔이 정한 값: 원화 방 1,000, USDT 방은 그만큼). 없으면 예전처럼 BB·받는 사람
        tip: money(Number(r.tip)) ? Number(r.tip) : 0,
        game: ['plo4', 'plo5'].includes(String(r.game || '')) ? String(r.game) : 'holdem',   // [OMAHA_0_10_23]
    };
    if (!/^[A-Za-z0-9_-]{1,32}$/.test(room.id)) throw new TicketError('bad room id');
    if (!money(room.sb) || !money(room.bb) || room.sb >= room.bb) throw new TicketError('bad blinds');
    if (!Number.isInteger(room.maxPlayers) || room.maxPlayers < 2 || room.maxPlayers > 11) throw new TicketError('bad table size');
    if (room.game === 'plo5' && room.maxPlayers > 8) throw new TicketError('bad table size');   // [OMAHA_0_10_23] 5장 × 9명 + 번·보드 8 > 52
    if (!(room.rake.percent >= 0 && room.rake.percent <= 20) || !(room.rake.minPot >= 0)) throw new TicketError('bad rake rule');
    if (room.rake.cap !== undefined && (!money(room.rake.cap) || (room.rake.unit === 1 && !Number.isInteger(room.rake.cap)))) throw new TicketError('bad rake cap');
    if (!(room.turnSec >= 5 && room.turnSec <= 120)) throw new TicketError('bad turn time');
    const player = {
        sessionId: String(pl.sessionId || ''), odcId: String(pl.odcId || ''),
        nickname: String(pl.nickname || '').slice(0, 24), avatar: String(pl.avatar || '').slice(0, 300),
        country: /^[A-Z]{2}$/.test(String(pl.country || '')) ? String(pl.country) : '',   // [IP_FLAG_0_10_44] 표시용 — 칩·카드와 무관
    };
    if (!/^[A-Za-z0-9_-]{8,64}$/.test(player.sessionId)) throw new TicketError('bad session id');
    if (!player.odcId || player.odcId.length > 64) throw new TicketError('bad player id');
    const guest = p.watch === 2;   // [GUEST_WATCH_0_10_27] 방 코드 관전 회원 — 보기만
    const watch = guest || p.watch === 1 || p.watch === true;   // [WATCH_0_10_20]
    const buyIn = watch ? 0 : Number(p.buyIn);
    if (!watch && !money(buyIn)) throw new TicketError('bad buy-in');
    // [CHIP_UNIT_0_10_6] 칩 단위 1(원화 방) — 블라인드·바이인이 정수여야 스택이 언제나 정수로 남는다
    if (room.rake.unit === 1 && ![room.sb, room.bb, ...(watch ? [] : [buyIn])].every(Number.isInteger)) throw new TicketError('amounts must be whole chips in this table');
    if (room.rake.unit === 1 && room.tip && !Number.isInteger(room.tip)) throw new TicketError('tip must be whole chips in this table');
    // 화면 표시용 환산(예: 칩은 USDT, 화면은 원화) — 게임·정산 금액에는 쓰지 않는다
    const d = p.display || {};
    const display = { currency: String(d.currency || p.currency || '').slice(0, 8), rate: Number(d.rate) > 0 && Number(d.rate) < 1e7 ? Number(d.rate) : 1 };
    if (Number(d.chipRate) > 1 && Number(d.chipRate) < 1e7) display.chipRate = Number(d.chipRate);   // [CHIP_VISUAL_0_10_7] 칩 그림만
    // [VIEW_CUR_0_10_23] 화면 통화 고르기 — 칩 1 → 그 통화 환산 비율(원화·테더·베트남동). 그림·글자뿐, 게임·정산에는 쓰지 않는다
    if (d.rates && typeof d.rates === 'object') {
        const rates = {};
        for (const k of ['KRW', 'USDT', 'VND']) { const v = Number(d.rates[k]); if (v > 0 && v < 1e7) rates[k] = v; }
        if (Object.keys(rates).length) display.rates = rates;
    }
    // [SEAT_PICK_0_10_25] 콘솔이 정한 자리(회원이 대기 중에 고른 자리) — 비어 있으면 그 자리에 앉힌다. 자리 번호일 뿐 카드·칩·순서 규칙과 무관
    const seat = !watch && Number.isInteger(p.seat) && p.seat >= 0 && p.seat < room.maxPlayers ? p.seat : -1;
    // [SEAT_CHOOSE_0_10_26] 들어와서 테이블의 빈자리를 직접 고른다(콘솔이 정한 좌석표만) — 고르기 전에는 판·준비에 들지 않는다
    const pick = !watch && (p.pick === 1 || p.pick === true);
    const topup = !watch && (p.topup === 1 || p.topup === true);   // [TOPUP_0_10_30]
    // [ROOM_HIST_0_10_69] 표시용 — 이 방에서 이 회원의 지난 기록(콘솔 장부): bi = 바이인 개수, amt = 새로 넣은 금액 합, net = 끝난 좌석 손익 합.
    //   carry = 이 좌석표 금액 중 지난 좌석에서 들고 온 칩(나갔다 다시 앉을 때 나갈 때 칩 그대로 — 새 바이인이 아니다).
    //   프로필 창의 바이인 개수·금액·손익이 나갔다 들어와도 이어지게 할 뿐 — 칩·판·정산에는 쓰지 않는다
    const hx = p.hist && typeof p.hist === 'object' ? p.hist : null;
    const fin = (v, lo, hi) => (Number.isFinite(Number(v)) && Number(v) >= lo && Number(v) <= hi ? Number(v) : 0);
    const hist = !watch && hx ? { bi: Math.floor(fin(hx.bi, 0, 10000)), amt: fin(hx.amt, 0, 1e12), net: fin(hx.net, -1e12, 1e12) } : null;
    const carry = !watch && !topup ? Math.min(buyIn, fin(p.carry, 0, 1e12)) : 0;
    return { ...(topup ? { topup: true } : {}), ...(hist ? { hist } : {}), ...(carry > 0 ? { carry } : {}), tid: String(p.tid), exp: Number(p.exp), room, player, buyIn, seat, pick, currency: String(p.currency || '').slice(0, 8), display, ...(watch ? { watch: true } : {}), ...(guest ? { guest: true } : {}) };
}

/** 시험·콘솔 구현 참고용 — 콘솔 개인키로 좌석표를 만든다 */
function signTicket(payload, consolePrivateKey) {
    const body = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
    return body + '.' + C.sign(consolePrivateKey, body);
}

/**
 * [KICK_0_10_27] 강퇴 — 콘솔이 서명한 한 자리(좌석표 tid)의 퇴장 요청. 카드·판·칩 금액은 담지 않는다.
 *   본문 { v: 1, typ: 'kick', tid, exp }  (좌석표와 같은 서명 방식, typ 이 달라 서로 바꿔 쓸 수 없다)
 */
function verifyKick(order, consoleKey, now = Date.now()) {
    const t = String(order || '');
    const dot = t.indexOf('.');
    if (!t || t.length > MAX_TICKET || dot <= 0) throw new TicketError('bad kick order');
    const body = t.slice(0, dot);
    if (!C.verify(consoleKey, body, t.slice(dot + 1))) throw new TicketError('kick order signature is not the console\'s');
    let p;
    try { p = b64uJson(body); } catch (_e) { throw new TicketError('bad kick order'); }
    if (!p || p.v !== 1 || p.typ !== 'kick' || !/^[A-Za-z0-9_-]{8,64}$/.test(String(p.tid || ''))) throw new TicketError('bad kick order');
    if (!(Number(p.exp) > now) || Number(p.exp) > now + 10 * 60 * 1000) throw new TicketError('kick order expired');
    return { tid: String(p.tid) };
}

/**
 * [BOMB_TEST_0_10_31] 시험용 「다음 판 붐팟 1회」 — 콘솔이 서명한 주문 { v:1, typ:'bomb-test', roomId, exp }. 개발 엔진(TEE_MODE=dev)만 받는다(TableServer.bombTest)
 */
function verifyBombTest(order, consoleKey, now = Date.now()) {
    const t = String(order || '');
    const dot = t.indexOf('.');
    if (!t || t.length > MAX_TICKET || dot <= 0) throw new TicketError('bad bomb-test order');
    const body = t.slice(0, dot);
    if (!C.verify(consoleKey, body, t.slice(dot + 1))) throw new TicketError('bomb-test order signature is not the console\'s');
    let p;
    try { p = b64uJson(body); } catch (_e) { throw new TicketError('bad bomb-test order'); }
    if (!p || p.v !== 1 || p.typ !== 'bomb-test' || !/^[A-Za-z0-9_-]{1,32}$/.test(String(p.roomId || ''))) throw new TicketError('bad bomb-test order');
    if (!(Number(p.exp) > now) || Number(p.exp) > now + 10 * 60 * 1000) throw new TicketError('bomb-test order expired');
    // [BOMB_COUNT_0_10_69] 붐팟 판 수(1~20, 없으면 1) — 방장이 횟수를 정해 붐팟만 여러 판
    const count = Number.isInteger(p.count) && p.count >= 1 && p.count <= 20 ? p.count : 1;
    return { roomId: String(p.roomId), count };
}

/**
 * [STOP_NEXT_0_10_69] 「다음 판 뒤 게임 종료 · 모두 대기」 — 콘솔이 서명한 주문 { v:1, typ:'stop-next', roomId, exp, cancel? }.
 *   방장이 인게임 관리 창에서 누른다. 칩·카드·좌석은 건드리지 않는다 — 지금 판이 끝나면 게임 시간을 끝내고 준비 대기실로(아무도 정산하지 않는다)
 */
function verifyStopNext(order, consoleKey, now = Date.now()) {
    const t = String(order || '');
    const dot = t.indexOf('.');
    if (!t || t.length > MAX_TICKET || dot <= 0) throw new TicketError('bad stop order');
    const body = t.slice(0, dot);
    if (!C.verify(consoleKey, body, t.slice(dot + 1))) throw new TicketError('stop order signature is not the console\'s');
    let p;
    try { p = b64uJson(body); } catch (_e) { throw new TicketError('bad stop order'); }
    if (!p || p.v !== 1 || p.typ !== 'stop-next' || !/^[A-Za-z0-9_-]{1,32}$/.test(String(p.roomId || ''))) throw new TicketError('bad stop order');
    if (!(Number(p.exp) > now) || Number(p.exp) > now + 10 * 60 * 1000) throw new TicketError('stop order expired');
    return { roomId: String(p.roomId), cancel: p.cancel === 1 || p.cancel === true };
}

/**
 * [AVATAR_LIVE_0_10_32] 게임 중 프로필 그림 바꾸기 — 콘솔이 서명한 주문 { v:1, typ:'avatar', tid, avatar, exp }.
 *   avatar 는 리소스 서버 안 경로(좌석표 player.avatar 와 같은 모양) — 칩·카드와 무관, 그 좌석의 그림만
 */
function verifyAvatar(order, consoleKey, now = Date.now()) {
    const t = String(order || '');
    const dot = t.indexOf('.');
    if (!t || t.length > MAX_TICKET || dot <= 0) throw new TicketError('bad avatar order');
    const body = t.slice(0, dot);
    if (!C.verify(consoleKey, body, t.slice(dot + 1))) throw new TicketError('avatar order signature is not the console\'s');
    let p;
    try { p = b64uJson(body); } catch (_e) { throw new TicketError('bad avatar order'); }
    if (!p || p.v !== 1 || p.typ !== 'avatar' || !/^[A-Za-z0-9_-]{8,64}$/.test(String(p.tid || ''))) throw new TicketError('bad avatar order');
    const avatar = String(p.avatar || '');
    if (avatar.length > 300 || avatar.includes('..') || !/^[A-Za-z0-9_\-./]*$/.test(avatar)) throw new TicketError('bad avatar path');
    if (!(Number(p.exp) > now) || Number(p.exp) > now + 10 * 60 * 1000) throw new TicketError('avatar order expired');
    return { tid: String(p.tid), avatar };
}

module.exports = { verifyKick, verifyBombTest, verifyStopNext, verifyAvatar, verifyTicket, signTicket, TicketError };
