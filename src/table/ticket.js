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
 *   player: { sessionId, odcId, nickname, avatar },
 *   buyIn: 칩(=잠근 금액), currency
 *   watch: 1 (선택) — [WATCH_0_10_20] 관전 좌석표(방장). 자리·칩이 없고 판에 들지 않는다. buyIn 이 없다.
 *          받는 것은 모두에게 공개되는 이벤트·상태뿐(홀카드 봉투 없음), 할 수 있는 것은 채팅·나가기뿐이다
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
        rake: { percent: Number(r.rake && r.rake.percent) || 0, minPot: Number(r.rake && r.rake.minPot) || 0, ...(Number(r.rake && r.rake.unit) === 1 ? { unit: 1 } : {}) },
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
    if (!(room.turnSec >= 5 && room.turnSec <= 120)) throw new TicketError('bad turn time');
    const player = {
        sessionId: String(pl.sessionId || ''), odcId: String(pl.odcId || ''),
        nickname: String(pl.nickname || '').slice(0, 24), avatar: String(pl.avatar || '').slice(0, 300),
    };
    if (!/^[A-Za-z0-9_-]{8,64}$/.test(player.sessionId)) throw new TicketError('bad session id');
    if (!player.odcId || player.odcId.length > 64) throw new TicketError('bad player id');
    const watch = p.watch === 1 || p.watch === true;   // [WATCH_0_10_20]
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
    return { tid: String(p.tid), exp: Number(p.exp), room, player, buyIn, seat, pick, currency: String(p.currency || '').slice(0, 8), display, ...(watch ? { watch: true } : {}) };
}

/** 시험·콘솔 구현 참고용 — 콘솔 개인키로 좌석표를 만든다 */
function signTicket(payload, consolePrivateKey) {
    const body = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
    return body + '.' + C.sign(consolePrivateKey, body);
}

module.exports = { verifyTicket, signTicket, TicketError };
