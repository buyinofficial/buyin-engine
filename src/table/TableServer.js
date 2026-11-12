/**
 * 테이블 서버 — TEE 안에서 게임 진행 전부를 맡는다. 운영 게임서버를 거치지 않는다.
 *
 *   회원 ──좌석표(콘솔 서명)──▶ join ──▶ 좌석·토큰
 *   회원 ◀──이벤트(SSE)── 판 시작·내 홀카드 봉투·차례·액션·보드·결과      (카드는 TEE → 회원 직접)
 *   회원 ──명령(POST)──▶ 키 등록·무작위 값·액션(회원 서명)·자리 비움·일어나기
 *   콘솔 ◀── 정산서(엔진 서명, 금액만) · 판 기록(판이 끝난 뒤)                  (outbox)
 *
 * 차례·타이머·딜러 버튼·블라인드 위치를 여기서 정하고, 덱·카드·베팅 규칙·팟·결과는 엔진(Engine/HandCore)이 정한다.
 * 판은 strictOrder 로 시작한다 — 차례가 아닌 좌석의 액션은 엔진이 거절하고, 판 기록·verify 에도 그 규칙이 남는다.
 *
 * [REBUY_0_10_1] 올인으로 칩이 0 이 되면 종전처럼 바로 정산한다(정산서 cashOut 0) — 다만 자리는 HOLD_MS 동안 그 회원 몫으로
 *   잡아 둔다(「올인」 표시, 판에는 들지 않고 다른 회원이 앉지 못한다. 팁도 받지 않는다 — 이미 정산한 자리다).
 *   「바이인 신청」(rebuy 명령)은 모두에게 말풍선만 띄운다. 신청·방장 승인·잔액 잠금·좌석표는 처음 앉을 때와 같은 길이다
 *   (화면이 로비의 바이인 신청으로 간다) — 같은 회원의 새 좌석표가 오면 잡아 둔 그 자리에 앉히고 「바이인 완료」를 한 판 동안 보인다.
 *   칩을 넣는 다른 길은 없다: 칩은 언제나 좌석표(콘솔 서명, 한 번만)로만 들어온다. 잡아 둔 시간이 지나거나 나가면 자리를 비운다(정산은 이미 했다).
 */

const crypto = require('crypto');
const C = require('../crypto');
const { verifyTicket, TicketError } = require('./ticket');

const START_DELAY_MS = 3000;       // 판과 판 사이
const RESULT_PAUSE_MS = 4000;      // 결과를 보여 주는 시간

/**
 * [SHOWDOWN_SEQ_0_10_4] 쇼다운 연출 시간 — 화면(app.js showdownPlan)이 카드를 한 자리씩 여는 데 쓰는 시간만큼 다음 판을 늦춘다.
 *   보통 쇼다운: 0.5초 뒤 0.4초 간격으로 한 자리씩(마지막 승자는 0.8초 더) → 뒤집기 0.6초 → 0.7초 뒤 승자·칩
 *   올인 런아웃: SHOWDOWN 1.6초 → 홀카드 0.4초 간격 → 뒤집기 0.6초 → 보드 한 단계씩 1초 간격(마지막 0.9초) → 0.7초 뒤 승자·칩
 *   연출일 뿐 — 카드·칩·결과와 무관하다(결과는 이미 정해져 보낸 뒤다).
 */
function showdownMs(n, runoutStages) {
    if (!(n > 0)) return 0;
    if (runoutStages !== null) return 1600 + (n - 1) * 400 + 600 + (runoutStages > 0 ? (runoutStages - 1) * 1000 + 900 : 0) + 700;
    return 500 + (n - 1) * 400 + (n > 1 ? 800 : 0) + 600 + 700;
}
const EMPTY_ROOM_MS = 10 * 60 * 1000;
const DISCONNECT_GRACE_MS = 60 * 1000;
const HOLD_MS = 10 * 60 * 1000;         // [REBUY_0_10_1] 칩 0 좌석을 그 회원 몫으로 잡아 두는 시간(그 사이 바이인 신청·방장 승인)
const TIMEOUT_KICK = 3;                 // 연속 시간 초과가 이만큼이면 탈락(이전 게임 서버와 같다)
const TIME_BANK_START = 3;              // 타임뱅크 — 앉을 때 장수, 한 차례에 1장, 쓰면 +TIME_BANK_MS (이전 비밀방과 같다)
const TIME_BANK_MS = 20 * 1000;
const EMOTES = ['angry', 'sad', 'win', 'taunt', 'thanks', 'chill', 'sleepy', 'clap'];
const EMOTE_GAP_MS = 1500;
const CHAT_MAX = 200;                   // 채팅 — 0.4초 간격 + 5초에 5개, 200자. 저장·로그 없이 같은 방에만 전달
const CHAT_GAP_MS = 400;
const CHAT_WINDOW_MS = 5000;
const CHAT_PER_WINDOW = 5;
const TIP_TYPES = ['flower', 'kiss', 'confetti', 'cigarette', 'champagne'];   // 팁 — 이전 게임과 같다: 금액은 종류와 무관하게 그 방 BB 1개,
const TIP_COOLDOWN_MS = 3000;                                                   //   프리플랍에서만 보내고, 칩은 판이 끝난 뒤 옮긴다(모자라면 취소)
/** 「레이즈 중」 알림 최소 간격 */
const RAISING_GAP_MS = 300;
const MAX_CLIENTS_PER_SEAT = 3;          // 한 좌석에 붙는 이벤트 연결 상한(탭 여러 개 정도)   // 연결이 끊긴 뒤 이 시간 안에 다시 붙지 않으면 탈락(배포 설정 TEE_DISCONNECT_GRACE_MS)

class TableError extends Error {
    constructor(code, msg) { super(msg); this.code = code; }
}

const round3 = (n) => Math.round(n * 1000) / 1000;

class TableServer {
    /**
     * @param {object} o
     * @param {Engine} o.engine
     * @param {RecordStore|null} o.store   좌석·정산 사건을 TEE 디스크 사슬에 남긴다(재시작 복구)
     * @param {KeyObject} o.consoleKey      좌석표 서명 확인용 콘솔 공개키
     * @param {function} o.outbox           (kind, payload) — 콘솔로 보낼 것 (정산서·판 기록)
     * @param {object} [o.clock]            시험용 { now, setTimeout, clearTimeout }
     */
    constructor(o) {
        this.engine = o.engine;
        this.store = o.store || null;
        this.consoleKey = o.consoleKey;
        this.outbox = o.outbox || (() => {});
        this.clock = o.clock || { now: () => Date.now(), setTimeout: (f, ms) => setTimeout(f, ms), clearTimeout: (t) => clearTimeout(t) };
        this.rooms = new Map();          // roomId → room
        this.tokens = new Map();         // token → { room, seat }
        this.usedTickets = new Set();
        this.liveSessions = new Set();   // sessionId — 같은 세션 두 번 앉기 금지
        this.disconnectGraceMs = Number(o.disconnectGraceMs) > 0 ? Number(o.disconnectGraceMs) : DISCONNECT_GRACE_MS;
        if (this.store) this._recover();
    }

    // ------------------------------------------------------------ 재시작 복구

    /**
     * 사슬을 읽어 쓴 좌석표를 다시 못 쓰게 하고, 정산서 없이 끝난 좌석(엔진 재시작)을 마지막으로 끝난 판의 스택으로 정산한다.
     * 재시작 때 진행 중이던 판은 기록이 없다 — 그 판에 건 칩은 판 전 스택으로 돌아간다.
     */
    _recover() {
        const open = new Map();      // sessionId → { seat-in 줄, 마지막 스택, 레이크, 판 수 }
        const active = new Map();    // tableId|odcId → sessionId (지금 앉아 있는 세션)
        for (const e of this.store.range(0, Number.MAX_SAFE_INTEGER)) {
            if (e.kind === 'player-bind') continue;   // 0.5.5 의 회원 키 고정 기록 — 더 쓰지 않는다
            if (e.kind === 'seat-in') {
                this.usedTickets.add(e.tid);
                open.set(e.sessionId, { e, stack: e.buyIn, rake: 0, hands: 0 });
                active.set(e.tableId + '|' + e.odcId, e.sessionId);
            } else if (e.kind === 'settle') {
                const x = open.get(e.note.sessionId);
                if (x) active.delete(x.e.tableId + '|' + x.e.odcId);
                open.delete(e.note.sessionId);
            } else if (e.kind === 'tip') {
                const a = open.get(e.fromSession), b = open.get(e.toSession);
                if (a && b) { a.stack = round3(a.stack - e.amount); b.stack = round3(b.stack + e.amount); }
            } else if (e.kind === 'hand' && e.record) {
                const r = e.record;
                for (const st of r.seats || []) {
                    const x = open.get(active.get(r.tableId + '|' + st.odcId));
                    if (!x) continue;
                    x.stack = r.stacksEnd[st.seat]; x.hands += 1;
                    const fee = ((r.result && r.result.rake && r.result.rake.perSeat) || []).find((f) => f.seat === st.seat);
                    if (fee) x.rake = round3(x.rake + fee.fee);
                }
            }
        }
        // 정산서 없이 끝난 좌석 — 엔진이 다시 떴다. 마지막으로 끝난 판의 스택으로 정산한다(그때 진행 중이던 판은 기록이 없어 무효)
        for (const [sessionId, x] of open) {
            const e = x.e;
            this._settle({ roomId: e.roomId, tid: e.tid, sessionId, odcId: e.odcId, buyIn: e.buyIn, currency: e.currency || '',
                cashOut: x.stack, rakePaid: x.rake, hands: x.hands, reason: 'engine-restart' });
        }
    }

    // ------------------------------------------------------------ 입장

    join(ticketStr, auth) {
        const t = verifyTicket(ticketStr, this.consoleKey, this.clock.now());
        if (this.usedTickets.has(t.tid)) throw new TableError('ticket', 'ticket already used');
        if (this.liveSessions.has(t.player.sessionId)) throw new TableError('ticket', 'session already seated');
        let room = this.rooms.get(t.room.id);
        if (!room) room = this._openRoom(t.room);
        else if (!sameRules(room.rules, t.room)) throw new TableError('rules', 'ticket rules differ from the table');
        if (room.closing) throw new TableError('closed', 'table is closing');
        // 같은 회원이 이미 앉아 있다 — 본인 키로 서명한 새 세션이면 기존 자리를 탈락시킨다(정산 뒤 다시 앉는다). 다른 키면 기존 자리에 아무 일도 없다
        const existing = room.seats.find((x) => x && x.odcId === t.player.odcId);
        // [REBUY_0_10_1] 칩 0 으로 정산하고 잡아 둔 자기 자리 — 새 좌석표(새 바이인)로 그 자리에 다시 앉는다
        let back = -1, prevBi = 0;
        if (existing && existing.held) { back = existing.seat; prevBi = existing.bi || 0; this._release(room, existing, 'rebuy'); }
        else if (existing) {
            if (this._signedBy(t, auth, existing.boundFp)) {
                this._leave(room, existing, 'replaced');
                throw new TableError('replaced', 'previous session closed — join again after it is settled');
            }
            throw new TableError('seat', 'player already at this table');
        }
        const seat = back >= 0 ? back : room.seats.findIndex((s) => !s);
        if (seat < 0) throw new TableError('full', 'table is full');
        // 입장 서명(선택) — 이 브라우저의 서명 키. 같은 회원의 새 세션 판단과 '앉은 뒤 키가 바뀌면 탈락'의 기준이 된다
        let joinFp = null;
        try { const a = auth || {}; const fp = C.fingerprint(a.sig); if (C.verify(C.importPublicJwk(a.sig), C.msgJoin(t.tid, fp), a.proof)) joinFp = fp; } catch (_e) { /* 서명 없이 앉아도 된다 */ }

        // [BUYIN_UNITS_0_10_4] 화면 표시용 바이인 개수 — 이 좌석표가 1바이인(room.unit)의 몇 배인가, 이 자리에서 지금까지 합계(재바이인이면 더한다).
        //   좌석표에 이미 공개된 금액을 나눈 값일 뿐 — 칩·정산·판에는 쓰지 않는다. 1바이인이 없는 방은 0
        const unit = t.room.unit || 0;
        const biNew = unit > 0 ? Math.max(1, Math.round(t.buyIn / unit)) : 0;
        const token = crypto.randomBytes(24).toString('base64url');
        const s = {
            seat, token, tid: t.tid, sessionId: t.player.sessionId, odcId: t.player.odcId,
            nickname: t.player.nickname, avatar: t.player.avatar, buyIn: t.buyIn, currency: t.currency, display: t.display,
            stack: t.buyIn, rakePaid: 0, hands: 0, keys: false, sitout: false, timeouts: 0, leaving: false, boundFp: joinFp,
            rebuy: back >= 0 ? 'done' : null, held: false, unit, bi: prevBi + biNew, biNew,   // [REBUY_0_10_1] rebuy: null | 'asked'(말풍선) | 'done'(돌아옴, 한 판)
            timeBank: TIME_BANK_START, emoteAt: 0, chatRate: { last: 0, start: 0, n: 0 }, sigJwk: null, tipN: 0, tipAt: 0, tips: [], raisingAt: 0, darkNext: false,
            clients: new Set(), joinedAt: this.clock.now(),
        };
        // 좌석표는 사슬에 먼저 남긴다 — 이후 엔진이 다시 떠도 이 돈은 정산된다
        if (this.store) this.store.appendEvent('seat-in', { tid: t.tid, roomId: room.id, tableId: room.tableId, sessionId: s.sessionId, odcId: s.odcId, buyIn: s.buyIn, currency: s.currency });
        this.usedTickets.add(t.tid);
        this.liveSessions.add(s.sessionId);
        room.seats[seat] = s;
        room.emptySince = null;
        this.tokens.set(token, { room, seat });
        this._armGone(room, s);   // 화면이 붙기 전까지도 시간을 잰다
        this._broadcast(room, 'seat', { seat: this._publicSeat(room, s) });
        this._maybeStart(room);
        return { token, roomId: room.id, tableId: room.tableId, seat, seedCommit: room.seedCommit };
    }

    /** 이 좌석표 입장 서명이 이 키(지문)로 됐나 — 키를 고정하지 않고 확인만 */
    _signedBy(t, auth, fp) {
        try {
            const a = auth || {};
            return C.fingerprint(a.sig) === fp && C.verify(C.importPublicJwk(a.sig), C.msgJoin(t.tid, fp), a.proof);
        } catch (_e) { return false; }
    }

    /** 연결이 모두 끊긴 좌석 — 정해진 시간 안에 다시 붙지 않으면 탈락(진행 중인 판은 폴드, 올인이면 그대로 결과까지). 나머지 판은 계속된다 */
    _armGone(room, s) {
        if (s.goneTimer) this.clock.clearTimeout(s.goneTimer);
        if (s.held) { s.goneTimer = null; return; }   // [REBUY_0_10_1] 잡아 둔 자리는 HOLD_MS 로만 끝난다
        s.goneTimer = this.clock.setTimeout(() => {
            s.goneTimer = null;
            if (room.seats[s.seat] === s && !s.clients.size && !s.leaving) this._leave(room, s, 'disconnected');
        }, this.disconnectGraceMs);
    }

    _openRoom(rules) {
        const { tableId, seedCommit } = this.engine.call('openTable', { meta: { roomId: rules.id } });
        const room = {
            id: rules.id, rules, tableId, seedCommit, seats: new Array(rules.maxPlayers).fill(null),
            dealer: null, handNo: 0, hand: null, startTimer: null, closing: false, emptySince: this.clock.now(),
        };
        this.rooms.set(room.id, room);
        return room;
    }

    // ------------------------------------------------------------ 명령

    _auth(token) {
        const at = this.tokens.get(String(token || ''));
        if (!at) throw new TableError('auth', 'unknown token');
        const s = at.room.seats[at.seat];
        if (!s || s.token !== token) throw new TableError('auth', 'seat is gone');
        return { room: at.room, s };
    }

    command(token, msg) {
        const { room, s } = this._auth(token);
        const m = msg || {};
        switch (m.type) {
            case 'keys': return this._keys(room, s, m);
            case 'entropy': return this._entropy(room, s, m);
            case 'act': return this._act(room, s, m);
            case 'sitout': s.sitout = true; this._broadcast(room, 'seat', { seat: this._publicSeat(room, s) }); return { ok: true };
            case 'back': s.sitout = false; s.timeouts = 0; this._broadcast(room, 'seat', { seat: this._publicSeat(room, s) }); this._maybeStart(room); return { ok: true };
            case 'leave': return this._leave(room, s, 'left');
            case 'timebank': return this._timeBank(room, s);
            case 'emote': return this._emote(room, s, m);
            case 'chat': return this._chat(room, s, m);
            case 'tip': return this._tip(room, s, m);
            case 'raising': return this._raising(room, s, m);
            case 'dark': return this._dark(room, s, m);
            case 'rebuy': return this._rebuyAsk(room, s);
            default: throw new TableError('input', 'unknown command');
        }
    }

    _keys(room, s, m) {
        // 이 자리의 서명 키는 입장 때(또는 처음 등록 때)의 키여야 한다
        let fp = null;
        try { fp = C.fingerprint(m.sig); } catch (_e) { /* 아래에서 거절 */ }
        if (!fp || (s.boundFp && fp !== s.boundFp)) {
            // 앉은 뒤 인증값(서명 키)이 바뀌었다 — 그 자리는 탈락(폴드 후 정산)
            this._leave(room, s, 'auth-changed');
            throw new TableError('keys', 'signing key changed after sitting down');
        }
        const r = this.engine.call('registerKeys', { tableId: room.tableId, odcId: s.odcId, sig: m.sig, ecdh: m.ecdh, proof: m.proof });
        if (!r.ok) throw new TableError(r.code || 'keys', r.error);
        s.keys = true;
        s.boundFp = fp;
        s.sigJwk = m.sig;   // 팁 서명 확인용(칩이 움직이는 팁은 본인 서명이 있어야 한다)
        this._maybeStart(room);
        return { ok: true, sigFp: r.sigFp, ecdhFp: r.ecdhFp, confirm: r.confirm, seedCommit: r.seedCommit };
    }

    _entropy(room, s, m) {
        const r = this.engine.call('addEntropy', { tableId: room.tableId, odcId: s.odcId, seedCommit: m.seedCommit, hex: m.hex, sig: m.sig });
        if (!r.ok) throw new TableError(r.code || 'entropy', r.error);
        s.entropyFor = String(m.seedCommit);   // 이 씨앗 약속으로 섞는 판에 들 수 있다
        this._maybeStart(room);
        return { ok: true };
    }

    _act(room, s, m) {
        const h = room.hand;
        if (!h || h.toAct !== s.seat) throw new TableError('turn', 'not your turn');
        if (Number(m.q) !== h.q) throw new TableError('turn', 'stale turn');
        const r = this.engine.call('act', { handId: h.handId, entry: { k: 'act', seat: s.seat, q: h.q, action: String(m.action || ''), amount: Number(m.amount) || 0, sig: m.sig } });
        if (!r.ok) throw new TableError(r.code || 'act', r.error);
        s.timeouts = 0;
        this._afterAction(room, s.seat, r.res, 'act');
        return { ok: true, res: r.res };
    }

    /** 타임뱅크 1장 — 내 차례에, 한 차례에 한 번, 남은 시간 + TIME_BANK_MS. 칩·카드와 무관해 좌석 토큰만으로 된다 */
    _timeBank(room, s) {
        const h = room.hand;
        if (!h || h.toAct !== s.seat || !h.timer) throw new TableError('turn', 'not your turn');
        if (s.timeBank <= 0) throw new TableError('timebank', 'no time bank left');
        if (h.timeBankQ === h.q) throw new TableError('timebank', 'time bank already used this turn');
        s.timeBank -= 1;
        h.timeBankQ = h.q;
        h.deadline += TIME_BANK_MS;
        const seat = h.toAct, q = h.q;
        this.clock.clearTimeout(h.timer);
        h.timer = this.clock.setTimeout(() => this._timeout(room, seat, q), Math.max(0, h.deadline - this.clock.now()));
        this._broadcast(room, 'turn', this._turnInfo(room));
        this._broadcast(room, 'timebank', { seat, left: s.timeBank, addedMs: TIME_BANK_MS });
        return { ok: true, left: s.timeBank, deadline: h.deadline };
    }

    /** 감정 이모티콘 — 정해진 목록만, 같은 방 좌석에 전달만 한다(기록·로그 없음) */
    _emote(room, s, m) {
        const id = String(m.id || '');
        if (!EMOTES.includes(id)) throw new TableError('input', 'unknown emote');
        const now = this.clock.now();
        if (now - s.emoteAt < EMOTE_GAP_MS) throw new TableError('rate', 'too fast');
        s.emoteAt = now;
        this._broadcast(room, 'emote', { seat: s.seat, id });
        return { ok: true };
    }

    /**
     * 「레이즈 중」 — 내 차례에 레이즈 금액을 고르는 동안 같은 방에 알린다(예전 게임의 raise_adjusting). 금액·카드는 없다.
     * 내 차례일 때만, 0.3초에 한 번까지. 차례가 끝나면 화면이 스스로 지운다.
     */
    _raising(room, s, m) {
        const h = room.hand;
        if (!h || h.toAct !== s.seat) return { ok: true, ignored: true };
        const now = this.clock.now();
        if (now - s.raisingAt < RAISING_GAP_MS) return { ok: true, ignored: true };
        s.raisingAt = now;
        this._broadcast(room, 'raising', { seat: s.seat, active: !!m.active, q: h.q });
        return { ok: true };
    }

    /**
     * 인더다크 — 다음 판 내 패를 보지 않고 친다(예전 게임과 같은 한 판짜리 예약). 판 시작 때 예약한 좌석을 방에 알리고,
     * 화면은 그 판 동안 내 패를 가린다. 베팅 규칙·카드는 그대로다(남의 카드가 새지도, 내 카드를 운영자가 보지도 않는다).
     */
    _dark(room, s, m) {
        s.darkNext = !!m.on;
        this._send(s, 'dark', { reserved: s.darkNext });
        return { ok: true, reserved: s.darkNext };
    }

    /** 채팅 — 제어문자 제거·200자, 도배 제한. 같은 방 좌석에 전달만 하고 저장·로그·콘솔 전송은 없다 */
    _chat(room, s, m) {
        const text = String(m.text == null ? '' : m.text).replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, CHAT_MAX);
        if (!text) throw new TableError('input', 'empty message');
        const now = this.clock.now(), r = s.chatRate;
        if (now - r.start > CHAT_WINDOW_MS) { r.start = now; r.n = 0; }
        if (now - r.last < CHAT_GAP_MS || r.n >= CHAT_PER_WINDOW) throw new TableError('rate', 'too fast');
        r.last = now; r.n += 1;
        this._broadcast(room, 'chat', { seat: s.seat, nickname: s.nickname, text, at: now });
        return { ok: true };
    }

    /**
     * 팁 — 칩이 움직이므로 보내는 사람의 서명(msgTip, 좌석마다 1부터 하나씩 느는 번호)이 있어야 한다.
     * 받으면 연출만 바로 알리고, 칩은 판이 끝난 뒤(_settleTips) 옮긴다. 그때 스택이 모자라거나 한쪽이 일어나면 취소.
     */
    _tip(room, s, m) {
        const h = room.hand;
        if (!h || h.stage !== 'preflop') throw new TableError('tip', 'tips can be sent only during the pre-flop');
        if (s.leaving) throw new TableError('tip', 'you are leaving the table');
        const to = room.seats[Number(m.to)];
        if (!to || to === s || to.held) throw new TableError('input', 'bad tip target');   // [REBUY_0_10_1] 정산한 자리는 받지 않는다
        if (to.leaving) throw new TableError('tip', 'that player is leaving the table');
        const type = String(m.gift || '');   // 명령 이름이 type 이라 팁 종류는 gift
        if (!TIP_TYPES.includes(type)) throw new TableError('input', 'unknown tip type');
        const n = Number(m.n);
        if (!Number.isInteger(n) || n !== s.tipN + 1) throw new TableError('tip', 'stale tip number');
        const amount = room.rules.bb;
        let ok = false;
        try { ok = !!s.sigJwk && C.verify(C.importPublicJwk(s.sigJwk), C.msgTip(room.tableId, s.odcId, n, to.seat, type, amount), m.sig); } catch (_e) { ok = false; }
        if (!ok) throw new TableError('tip', 'bad tip signature');   // 'auth' 가 아니다 — 좌석 토큰은 멀쩡하다
        const now = this.clock.now();
        if (now - s.tipAt < TIP_COOLDOWN_MS) throw new TableError('rate', 'too fast');
        // 지금 가진 칩 — 판에 든 좌석은 판 안의 스택. 이미 예약한 팁까지 더해 본다(같은 칩을 두 번 약속하지 않는다)
        const p = h.seats.includes(s.seat) ? this._core(h).seats.get(s.seat) : null;
        const live = p ? p.stack : s.stack;
        const queued = s.tips.reduce((a, x) => a + x.amount, 0);
        if (live < round3(queued + amount)) throw new TableError('tip', 'not enough chips');
        s.tipN = n; s.tipAt = now;
        s.tips.push({ to, toSeat: to.seat, type, amount, n, sig: String(m.sig) });
        this._broadcast(room, 'tip', { from: s.seat, to: to.seat, type, amount, queued: true });
        return { ok: true, n };
    }

    /** 판이 끝난 뒤 예약된 팁을 옮긴다 — 사슬에 먼저 남기고(서명 포함) 스택을 바꾼다 */
    _settleTips(room) {
        for (const s of room.seats) {
            if (!s || !s.tips.length) continue;
            const list = s.tips;
            s.tips = [];
            for (const x of list) {
                const to = x.to;
                const ok = room.seats[s.seat] === s && !s.leaving && room.seats[x.toSeat] === to && !to.leaving && !to.held && s.stack >= x.amount;
                if (ok && this.store) {
                    this.store.appendEvent('tip', { tableId: room.tableId, roomId: room.id, fromSession: s.sessionId, toSession: to.sessionId,
                        fromOdc: s.odcId, toOdc: to.odcId, toSeat: x.toSeat, n: x.n, type: x.type, amount: x.amount, sigJwk: s.sigJwk, sig: x.sig });
                }
                if (!ok) { this._broadcast(room, 'tip-cancel', { from: s.seat, to: x.toSeat, amount: x.amount }); continue; }
                s.stack = round3(s.stack - x.amount);
                to.stack = round3(to.stack + x.amount);
                this._broadcast(room, 'tip-done', { from: s.seat, to: x.toSeat, type: x.type, amount: x.amount, stacks: { [s.seat]: s.stack, [x.toSeat]: to.stack } });
            }
        }
    }

    // ------------------------------------------------------------ 올인 뒤 재바이인 [REBUY_0_10_1]

    /** 칩이 0 인 좌석인가 — 판에 들 수 없다(「올인」 표시) */
    _busted(s) {
        return !(s.stack > 0);
    }

    /**
     * 칩 0 — 종전처럼 바로 정산한다(정산서 cashOut 0, 사슬·콘솔). 자리는 HOLD_MS 동안 그 회원 몫으로 둔다:
     * 화면은 붙어 있어 「바이인 신청」·나가기를 누를 수 있고, 판에는 들지 않으며, 다른 회원이 앉거나 팁을 보낼 수 없다.
     */
    _hold(room, s) {
        if (s.held) return;
        this._settle({ roomId: room.id, tid: s.tid, sessionId: s.sessionId, odcId: s.odcId, buyIn: s.buyIn, currency: s.currency,
            cashOut: 0, rakePaid: s.rakePaid, hands: s.hands, reason: 'busted' });
        this.liveSessions.delete(s.sessionId);
        s.held = true; s.rebuy = null; s.tips = []; s.sitout = false;
        if (s.goneTimer) { this.clock.clearTimeout(s.goneTimer); s.goneTimer = null; }
        s.holdTimer = this.clock.setTimeout(() => { s.holdTimer = null; if (room.seats[s.seat] === s) this._release(room, s, 'busted'); }, HOLD_MS);
        this._send(s, 'busted', { holdMs: HOLD_MS });
        this._broadcast(room, 'seat', { seat: this._publicSeat(room, s) });
    }

    /** 잡아 둔 자리를 비운다 — 정산은 _hold 때 이미 했다(정산서를 다시 내지 않는다) */
    _release(room, s, reason) {
        if (s.holdTimer) { this.clock.clearTimeout(s.holdTimer); s.holdTimer = null; }
        if (s.goneTimer) { this.clock.clearTimeout(s.goneTimer); s.goneTimer = null; }
        room.seats[s.seat] = null;
        this.tokens.delete(s.token);
        if (reason !== 'rebuy') this._send(s, 'settled', { cashOut: 0, reason });
        for (const c of s.clients) c.end();
        this._broadcast(room, 'seat', { seat: { seat: s.seat, empty: true } });
        if (room.seats.every((x) => !x)) room.emptySince = this.clock.now();
    }

    /** 「바이인 신청」 — 같은 방 모두에게 말풍선만. 신청·승인·좌석표는 처음 앉을 때와 같은 길(화면이 로비로 간다). 사슬·콘솔로 가는 것 없음 */
    _rebuyAsk(room, s) {
        if (!s.held) throw new TableError('rebuy', 'only a seat with no chips can ask for a buy-in');
        if (s.rebuy !== 'asked') { s.rebuy = 'asked'; this._broadcast(room, 'seat', { seat: this._publicSeat(room, s) }); }
        return { ok: true, roomId: room.id };
    }

    _leave(room, s, reason) {
        if (s.held) { this._release(room, s, reason); return { ok: true }; }   // [REBUY_0_10_1] 이미 정산한 자리
        const h = room.hand;
        const inHand = h && h.seats.includes(s.seat);
        s.leaveReason = s.leaveReason || reason;
        if (inHand) {
            s.leaving = true;
            const p = this._core(h).seats.get(s.seat);
            if (p && !p.isFolded && !p.isAllIn) {
                const r = this.engine.call('act', { handId: h.handId, entry: { k: 'leave', seat: s.seat, reason } });
                if (r.ok) this._afterAction(room, s.seat, r.res, 'leave');
            }
            this._broadcast(room, 'seat', { seat: this._publicSeat(room, s) });
            return { ok: true, pending: true };   // 판이 끝나면 정산
        }
        this._unseat(room, s, reason);
        return { ok: true };
    }

    // ------------------------------------------------------------ 판 진행

    /**
     * 다음 판에 들 좌석 — 키를 등록했고, 이번 씨앗 약속(room.seedCommit)에 자기 무작위 값을 냈다.
     * 덱은 TEE 의 씨앗 + 판에 든 모든 회원의 무작위 값으로 섞인다(cards.shuffleKey). 값을 내지 않은 좌석은 그 판을 쉰다.
     */
    _eligible(room) {
        return room.seats.filter((s) => s && s.keys && s.entropyFor === room.seedCommit && !s.sitout && !s.leaving && s.stack > 0);
    }

    _maybeStart(room) {
        if (room.hand || room.startTimer || room.closing) return;
        if (this._eligible(room).length < 2) return;
        room.startTimer = this.clock.setTimeout(() => { room.startTimer = null; this._startHand(room); }, START_DELAY_MS);
    }

    _nextSeat(list, from) {
        const seats = list.map((s) => s.seat).sort((a, b) => a - b);
        return seats.find((x) => x > from) ?? seats[0];
    }

    _startHand(room) {
        if (room.hand || room.closing) return;
        if (room.rules.endsAt && this.clock.now() >= room.rules.endsAt) return this._close(room, 'time');
        const players = this._eligible(room);
        if (players.length < 2) return;
        const dealer = room.dealer === null ? players[0].seat : this._nextSeat(players, room.dealer);
        const sb = players.length === 2 ? dealer : this._nextSeat(players, dealer);
        const bb = this._nextSeat(players, sb);
        room.dealer = dealer;
        room.handNo += 1;
        const r = this.engine.call('startHand', {
            tableId: room.tableId, handNo: room.handNo,
            seats: players.map((s) => ({ seat: s.seat, odcId: s.odcId, stack: s.stack })),
            dealer, sb, bb, smallBlind: room.rules.sb, bigBlind: room.rules.bb, peek: true,
            rake: room.rules.rake, strictOrder: true,
        });
        if (!r.ok) { this._broadcast(room, 'error', { error: r.error }); return; }
        room.seedCommit = r.nextSeedCommit;
        const h = room.hand = {
            handId: r.handId, seats: players.map((s) => s.seat), dealer, sb, bb, q: r.turn, toAct: null, deadline: 0, timer: null,
            commitments: r.commitments, deckCommit: r.deckCommit, seedCommit: r.seedCommit, envelopes: r.envelopes,
            board: [], reveal: {}, stage: 'preflop',
        };
        for (const s of players) s.hands += 1;
        h.dark = players.filter((s) => s.darkNext).map((s) => s.seat);   // 인더다크 — 한 판짜리 예약을 쓴다
        for (const s of players) s.darkNext = false;
        this._broadcast(room, 'hand', this._publicHand(room));
        for (const s of players) this._send(s, 'hole', { handId: h.handId, envelope: r.envelopes[s.seat] || null });
        this._drive(room);
    }

    _core(h) {
        return this.engine.hands.get(h.handId).core;
    }

    /** 엔진 상태를 따라 다음 일을 한다 — 차례 주기, 보드, 런아웃, 끝 */
    _drive(room) {
        const h = room.hand;
        if (!h) return;
        const core = this._core(h);
        for (;;) {
            const st = core.status();
            if (st === 'continue') {
                // 차례 밖 퇴장처럼 차례가 그대로면 시간도 그대로
                if (h.timer && h.toAct === core.toAct() && h.q === core.turns) return;
                h.toAct = core.toAct();
                h.q = core.turns;
                h.deadline = this.clock.now() + room.rules.turnSec * 1000;
                if (h.timer) this.clock.clearTimeout(h.timer);
                const seat = h.toAct, q = h.q;
                h.timer = this.clock.setTimeout(() => this._timeout(room, seat, q), room.rules.turnSec * 1000);
                this._broadcast(room, 'turn', this._turnInfo(room));
                const s = room.seats[seat];
                if (s && s.leaving) this._timeout(room, seat, q);   // 탈락이 정해진 좌석은 기다리지 않는다
                return;
            }
            if (st === 'advance') {
                const r = this.engine.call('board', { handId: h.handId });
                if (!r.ok) return this._abort(room, r.error);
                h.board.push(...r.cards); h.stage = r.stage;
                this._broadcast(room, 'board', { handId: h.handId, stage: r.stage, cards: r.cards });
                continue;
            }
            if (st === 'runout') {
                const r = this.engine.call('runout', { handId: h.handId });
                if (!r.ok) return this._abort(room, r.error);
                Object.assign(h.reveal, r.holes || {});
                for (const x of r.stages || []) h.board.push(...x.cards);
                h.runout = { n: Object.keys(r.holes || {}).length, stages: (r.stages || []).length };   // [SHOWDOWN_SEQ_0_10_4] 연출 시간 계산용
                this._broadcast(room, 'runout', { handId: h.handId, holes: r.holes, stages: r.stages });
                continue;
            }
            return this._finish(room);
        }
    }

    _turnInfo(room) {
        const h = room.hand, core = this._core(h);
        const p = core.seats.get(h.toAct);
        const toCall = round3(Math.max(0, core.currentBet - p.currentBet));
        return {
            handId: h.handId, seat: h.toAct, q: h.q, deadline: h.deadline,
            toCall: Math.min(toCall, p.stack), minRaise: core.calculateMinRaise(), maxBet: round3(p.stack + p.currentBet),
            pot: core.pot, currentBet: core.currentBet,
        };
    }

    _timeout(room, seat, q) {
        const h = room.hand;
        if (!h || h.toAct !== seat || h.q !== q) return;
        // 자기 차례에 시간 안에 행동하지 않았다 → 이번 판은 폴드, 자리는 그대로(다음 판에도 든다).
        //   연속 TIMEOUT_KICK 번이면 그때 탈락(판이 끝나면 정산 후 자리에서 뺀다). 직접 한 번 행동하면 횟수는 0(_act).
        //   연결이 끊긴 좌석은 방치가 아니다 — 체크할 수 있으면 체크, 아니면 폴드하고 횟수에 넣지 않는다(끊김 유예가 따로 정리).
        //   이전 게임 서버(TurnManager._applyTimeout)와 같은 정책이다. 일어날 좌석은 기다리지 않고 폴드
        const s = room.seats[seat];
        const leaving = !!(s && s.leaving);
        const away = !!(s && !leaving && !s.clients.size);
        const p = this._core(h).seats.get(seat);
        const action = away && p && this._core(h).currentBet <= p.currentBet ? 'CHECK' : 'FOLD';
        const r = this.engine.call('act', { handId: h.handId, entry: { k: 'host', seat, q, action, reason: leaving ? (s.leaveReason || 'left') : away ? 'disconnected' : 'timeout' } });
        if (!r.ok) return this._abort(room, r.error);
        if (s && !leaving && !away && ++s.timeouts >= TIMEOUT_KICK) {
            s.leaving = true;
            s.leaveReason = 'timeout';
            this._broadcast(room, 'seat', { seat: this._publicSeat(room, s) });
        }
        this._afterAction(room, seat, r.res, 'host');
    }

    _afterAction(room, seat, res, kind) {
        const h = room.hand;
        if (h.timer && h.toAct === seat) { this.clock.clearTimeout(h.timer); h.timer = null; }
        const core = this._core(h);
        const p = core.seats.get(seat);
        this._broadcast(room, 'action', { handId: h.handId, seat, kind, action: res.action, amount: res.amount, stack: p.stack, bet: p.currentBet, pot: core.pot, currentBet: core.currentBet });
        this._drive(room);
    }

    _finish(room) {
        const h = room.hand;
        if (h.timer) { this.clock.clearTimeout(h.timer); h.timer = null; }
        const f = this.engine.call('finish', { handId: h.handId });
        if (!f.ok) return this._abort(room, f.error);
        const rec = f.record;
        for (const seat of h.seats) {
            const s = room.seats[seat];
            if (s) s.stack = round3(rec.stacksEnd[seat]);
        }
        for (const x of (rec.result && rec.result.rake && rec.result.rake.perSeat) || []) {
            const s = room.seats[x.seat]; if (s) s.rakePaid = round3(s.rakePaid + x.fee);
        }
        this._broadcast(room, 'result', {
            handId: h.handId, type: f.type, holes: f.holes || null, board: f.board || null, peekBoard: f.peekBoard || null,
            result: f.result, stacks: rec.stacksEnd,
        });
        // 판이 끝난 뒤에만 기록을 콘솔로 — 원본은 TEE 사슬(Engine.onRecord 가 이미 남겼다)
        this.outbox('hand-record', { roomId: room.id, record: rec, sig: f.sig });
        room.hand = null;
        // [SHOWDOWN_SEQ_0_10_4] 카드를 순서대로 여는 동안은 다음 판을 시작하지 않는다
        const sdMs = f.type === 'showdown'
            ? (h.runout ? showdownMs(h.runout.n, h.runout.stages) : showdownMs(Object.keys(f.holes || {}).length, null)) : 0;
        this._afterHand(room, h.seats, sdMs);
    }

    _abort(room, reason) {
        const h = room.hand;
        if (!h) return;
        if (h.timer) { this.clock.clearTimeout(h.timer); h.timer = null; }
        this.engine.call('abortHand', { handId: h.handId, reason: String(reason || 'aborted') });
        // 판 무효 — 스택은 판 전 그대로(room.seats[].stack 은 판이 끝날 때만 바뀐다)
        this._broadcast(room, 'aborted', { handId: h.handId, reason: String(reason || '') });
        room.hand = null;
        this._afterHand(room);
    }

    _afterHand(room, played = [], extraMs = 0) {
        this._settleTips(room);
        for (const s of room.seats) {
            if (!s) continue;
            if (s.leaving) { this._unseat(room, s, s.leaveReason || 'left'); continue; }
            if (s.held) continue;
            // [REBUY_0_10_1] 칩 0 — 정산하고 자리는 잡아 둔다(「올인」). 돌아온 뒤 한 판을 치면 「바이인 완료」 표시를 내린다
            const shown = s.rebuy === 'done' && played.includes(s.seat);
            if (shown) s.rebuy = null;
            if (this._busted(s)) this._hold(room, s);
            else if (shown) this._broadcast(room, 'seat', { seat: this._publicSeat(room, s) });
        }
        if (room.rules.endsAt && this.clock.now() >= room.rules.endsAt) return this._close(room, 'time');
        this.clock.setTimeout(() => this._maybeStart(room), RESULT_PAUSE_MS + extraMs);
    }

    // ------------------------------------------------------------ 일어나기 · 정산 · 닫기

    _unseat(room, s, reason) {
        if (s.goneTimer) { this.clock.clearTimeout(s.goneTimer); s.goneTimer = null; }
        room.seats[s.seat] = null;
        this.tokens.delete(s.token);
        this.liveSessions.delete(s.sessionId);
        this._settle({ roomId: room.id, tid: s.tid, sessionId: s.sessionId, odcId: s.odcId, buyIn: s.buyIn, currency: s.currency,
            cashOut: s.stack, rakePaid: s.rakePaid, hands: s.hands, reason });
        this._send(s, 'settled', { cashOut: s.stack, reason });
        for (const c of s.clients) c.end();
        this._broadcast(room, 'seat', { seat: { seat: s.seat, empty: true } });
        if (room.seats.every((x) => !x)) room.emptySince = this.clock.now();
    }

    /** 정산서 — 금액만. 엔진 키로 서명하고 사슬에 먼저 남긴 뒤 콘솔로 보낸다 */
    _settle(n) {
        const note = { v: 1, kind: 'settle', ...n, cashOut: round3(n.cashOut), at: this.clock.now(), engineSigFp: this.engine.call('info').keys.sigFp };
        const sig = this.engine.signNote(note);
        if (this.store) this.store.appendEvent('settle', { note, sig });
        this.outbox('settle', { note, sig });
    }

    _close(room, reason) {
        if (room.hand) { room.closing = true; return; }
        if (room.startTimer) { this.clock.clearTimeout(room.startTimer); room.startTimer = null; }
        for (const s of room.seats) if (s) (s.held ? this._release(room, s, 'table-' + reason) : this._unseat(room, s, 'table-' + reason));
        this.engine.call('closeTable', { tableId: room.tableId });
        this.rooms.delete(room.id);
    }

    /** 주기 정리 — 시간이 끝난 방, 오래 빈 방 */
    /** [TABLE_RECORD_2026_11_10] 이 테이블이 아직 열려 있나 — 열린 테이블의 기록은 밖에 내보내지 않는다 */
    isOpen(tableId) {
        for (const r of this.rooms.values()) if (r.tableId === String(tableId)) return true;
        return false;
    }

    sweep() {
        const now = this.clock.now();
        for (const room of [...this.rooms.values()]) {
            if (room.rules.endsAt && now >= room.rules.endsAt && !room.hand) this._close(room, 'time');
            else if (room.emptySince && now - room.emptySince > EMPTY_ROOM_MS) this._close(room, 'empty');
        }
    }

    // ------------------------------------------------------------ 이벤트

    subscribe(token, client) {
        const { room, s } = this._auth(token);
        if (s.clients.size >= MAX_CLIENTS_PER_SEAT) throw new TableError('busy', 'too many connections for this seat');
        s.clients.add(client);
        if (s.goneTimer) { this.clock.clearTimeout(s.goneTimer); s.goneTimer = null; }   // 다시 붙었다
        client.onClose(() => {
            s.clients.delete(client);
            if (!s.clients.size && room.seats[s.seat] === s) this._armGone(room, s);
        });
        client.send('snapshot', this.snapshot(room, s));
        return true;
    }

    _send(s, event, data) {
        for (const c of s.clients) c.send(event, data);
    }

    _broadcast(room, event, data) {
        for (const s of room.seats) if (s) this._send(s, event, data);
    }

    _publicSeat(room, s) {
        return { seat: s.seat, nickname: s.nickname, avatar: s.avatar, stack: s.stack, sitout: s.sitout, leaving: s.leaving, keys: s.keys, connected: s.clients.size > 0,
            busted: !!s.held || (this._busted(s) && !(room.hand && room.hand.seats.includes(s.seat))), rebuy: s.rebuy,
            bi: s.bi || 0, biNew: s.rebuy === 'done' ? (s.biNew || 0) : 0 };   // [BUYIN_UNITS_0_10_4] 표시용 — 합계·방금 받은 개수   // [REBUY_0_10_1]
    }

    _publicHand(room) {
        const h = room.hand;
        if (!h) return null;
        const core = this._core(h);
        return {
            handId: h.handId, dealer: h.dealer, sb: h.sb, bb: h.bb, stage: h.stage,
            seats: h.seats.map((seat) => { const p = core.seats.get(seat); return { seat, stack: p.stack, bet: p.currentBet, folded: p.isFolded, allIn: p.isAllIn }; }),
            pot: core.pot, currentBet: core.currentBet, board: h.board, reveal: h.reveal,
            commitments: h.commitments, deckCommit: h.deckCommit, seedCommit: h.seedCommit, nextSeedCommit: room.seedCommit,
            toAct: h.toAct, q: h.q, deadline: h.deadline, dark: h.dark || [],
        };
    }

    /** 접속하자마자 받는 현재 상태 — 남의 카드는 들어 있지 않다. 내 홀카드는 내 키로 잠긴 봉투로만 */
    snapshot(room, s) {
        const h = room.hand;
        return {
            room: { id: room.id, name: room.rules.name, sb: room.rules.sb, bb: room.rules.bb, maxPlayers: room.rules.maxPlayers, rake: room.rules.rake, turnSec: room.rules.turnSec, endsAt: room.rules.endsAt },
            tableId: room.tableId, seedCommit: room.seedCommit, engine: this.engine.call('info').keys,
            me: { seat: s.seat, odcId: s.odcId, nickname: s.nickname, stack: s.stack, buyIn: s.buyIn, unit: s.unit, bi: s.bi || 0, rebuy: s.rebuy, currency: s.currency, display: s.display, keys: s.keys, sitout: s.sitout, timeBank: s.timeBank, tipN: s.tipN, darkNext: s.darkNext },
            seats: room.seats.map((x) => (x ? this._publicSeat(room, x) : null)),
            hand: this._publicHand(room),
            hole: h && h.seats.includes(s.seat) ? { handId: h.handId, envelope: h.envelopes[s.seat] || null } : null,
            turn: h && h.toAct !== null ? this._turnInfo(room) : null,
        };
    }
}

function sameRules(a, b) {
    return a.sb === b.sb && a.bb === b.bb && a.maxPlayers === b.maxPlayers && a.rake.percent === b.rake.percent && a.rake.minPot === b.rake.minPot && a.turnSec === b.turnSec;
}

module.exports = { TableServer, TableError, TicketError };
