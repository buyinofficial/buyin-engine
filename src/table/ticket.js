/**
 * 좌석표 — 콘솔(운영)이 회원 잔액을 잠근 뒤 발급하는 서명된 입장권.
 *
 *   ticket = base64url(JSON 본문) + "." + base64url(ECDSA P-256 서명, ieee-p1363)
 *   서명 대상 = 본문 base64url 문자열 그대로 (재직렬화 차이가 없게)
 *
 * 본문 {
 *   v: 1, tid: 좌석표 번호(한 번만 쓴다), exp: 만료(ms),
 *   room: { id, name, sb, bb, maxPlayers, rake: { percent, minPot }, turnSec, endsAt },
 *   display: { currency, rate }   (선택) 화면 표시 환산 — 금액 × rate 를 currency 로 보여 준다
 *   rebind: true                  (선택) 이 회원의 브라우저 키를 새 기기 키로 바꾼다 — 공개 기록에 남고 옛 기기에 보인다
 *   player: { sessionId, odcId, nickname, avatar },
 *   buyIn: 칩(=잠근 금액), currency
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
        rake: { percent: Number(r.rake && r.rake.percent) || 0, minPot: Number(r.rake && r.rake.minPot) || 0 },
        turnSec: Number(r.turnSec) || 20, endsAt: Number(r.endsAt) || 0,
    };
    if (!/^[A-Za-z0-9_-]{1,32}$/.test(room.id)) throw new TicketError('bad room id');
    if (!money(room.sb) || !money(room.bb) || room.sb >= room.bb) throw new TicketError('bad blinds');
    if (!Number.isInteger(room.maxPlayers) || room.maxPlayers < 2 || room.maxPlayers > 11) throw new TicketError('bad table size');
    if (!(room.rake.percent >= 0 && room.rake.percent <= 20) || !(room.rake.minPot >= 0)) throw new TicketError('bad rake rule');
    if (!(room.turnSec >= 5 && room.turnSec <= 120)) throw new TicketError('bad turn time');
    const player = {
        sessionId: String(pl.sessionId || ''), odcId: String(pl.odcId || ''),
        nickname: String(pl.nickname || '').slice(0, 24), avatar: String(pl.avatar || '').slice(0, 300),
    };
    if (!/^[A-Za-z0-9_-]{8,64}$/.test(player.sessionId)) throw new TicketError('bad session id');
    if (!player.odcId || player.odcId.length > 64) throw new TicketError('bad player id');
    const buyIn = Number(p.buyIn);
    if (!money(buyIn)) throw new TicketError('bad buy-in');
    // 화면 표시용 환산(예: 칩은 USDT, 화면은 원화) — 게임·정산 금액에는 쓰지 않는다
    const d = p.display || {};
    const display = { currency: String(d.currency || p.currency || '').slice(0, 8), rate: Number(d.rate) > 0 && Number(d.rate) < 1e7 ? Number(d.rate) : 1 };
    return { tid: String(p.tid), exp: Number(p.exp), room, player, buyIn, currency: String(p.currency || '').slice(0, 8), display, rebind: p.rebind === true };
}

/** 시험·콘솔 구현 참고용 — 콘솔 개인키로 좌석표를 만든다 */
function signTicket(payload, consolePrivateKey) {
    const body = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
    return body + '.' + C.sign(consolePrivateKey, body);
}

module.exports = { verifyTicket, signTicket, TicketError };
