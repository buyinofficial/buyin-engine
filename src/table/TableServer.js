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
const { opening } = require('../cards');

const START_DELAY_MS = 3000;       // 판과 판 사이
const RESULT_PAUSE_MS = 4000;      // 결과를 보여 주는 시간
const PICK_SEAT_MS = 90 * 1000;    // [SEAT_CHOOSE_0_10_26] 자리를 고르지 않으면 지금 자리로

/**
 * [SHOWDOWN_SEQ_0_10_4] 쇼다운 연출 시간 — 화면(app.js showdownPlan)이 카드를 한 자리씩 여는 데 쓰는 시간만큼 다음 판을 늦춘다.
 *   보통 쇼다운: 0.5초 뒤 0.4초 간격으로 한 자리씩(마지막 승자는 0.8초 더) → 뒤집기 0.6초 → 0.7초 뒤 승자·칩
 *   올인 런아웃: SHOWDOWN 1.6초 → 홀카드 0.4초 간격 → 뒤집기 0.6초 → 보드 플랍 2.4초·턴 2.8초·리버 2.6초(0.10.7, 긴장감) → 0.7초 뒤 승자·칩
 *   연출일 뿐 — 카드·칩·결과와 무관하다(결과는 이미 정해져 보낸 뒤다).
 */
/** [RUNOUT_TENSION_0_10_7] 런아웃 보드 단계 시간(ms) — 플랍→턴 2400, 턴→리버 2800, 리버 연출 2600. 화면 app.js RUNOUT 과 같은 값 */
const RUNOUT_STAGE_MS = [2400, 2800, 2600];
function runoutBoardMs(stages) {
    const k = Math.max(0, Math.min(3, Number(stages) || 0));
    return RUNOUT_STAGE_MS.slice(3 - k).reduce((a, b) => a + b, 0);
}
function showdownMs(n, runoutStages) {
    if (!(n > 0)) return 0;
    if (runoutStages !== null) return 1600 + (n - 1) * 400 + 600 + runoutBoardMs(runoutStages) + 700;
    return 500 + (n - 1) * 400 + (n > 1 ? 800 : 0) + 600 + 700;
}
const EMPTY_ROOM_MS = 10 * 60 * 1000;
/**
 * [READY_SESSION_0_10_6] 준비 게이트 · 게임 시간
 *   - 판은 바로 시작하지 않는다 — 앉은 회원(칩이 있는 자리)이 2명 이상이고 모두 「준비 완료」를 눌러야 첫 판이 시작된다.
 *   - 방 게임 시간(좌석표 room.sessionMin 분)은 첫 판 때부터 잰다. 끝나기 FINAL_WARN_MS 전에 「마지막 3판」을 미리 알리고,
 *     시간이 다 되면 그때 치던 판은 마저 치고 SESSION_FINAL_HANDS 판을 더 친 뒤 준비 게이트로 돌아간다(정산·퇴장 없음, 칩 그대로).
 *   - 판을 칠 사람이 2명 아래로 줄어도 준비 게이트로 돌아간다(새로 온 사람과 바로 시작하지 않게). 게임 시간은 그대로 흐른다.
 *   연출·진행 순서일 뿐 — 카드·칩·베팅 규칙·결과와 무관하고, 운영 서버가 대신 「준비」를 누를 길도 없다(좌석 토큰 명령).
 */
const SESSION_FINAL_HANDS = 3;
const FINAL_WARN_MS = 3 * 60 * 1000;
const DISCONNECT_GRACE_MS = 5 * 60 * 1000;   // [AWAY_5MIN_0_10_11] 60초 → 5분 — 휴대폰에서 다른 앱·탭을 쓰다 돌아와도 자리가 남게(운영 요청 11-16). 끊긴 동안 차례는 체크/폴드, 횟수에 안 넣음
const HOLD_MS = 10 * 60 * 1000;         // [REBUY_0_10_1] 칩 0 좌석을 그 회원 몫으로 잡아 두는 시간(그 사이 바이인 신청·방장 승인)
const AWAY_MS = 10 * 60 * 1000;          // [AWAY_0_10_16] 자리 비움이 이만큼 이어지면 나가기(정산)
const TIMEOUT_KICK = 5;                 // 연속 시간 초과가 이만큼이면 탈락 — [TIMEOUT_KICK5_0_10_11] 3 → 5(운영 요청 11-16)
const TIME_BANK_START = 3;              // 타임뱅크 — 앉을 때 장수, 한 차례에 1장, 쓰면 +TIME_BANK_MS (이전 비밀방과 같다)
const TIME_BANK_MS = 20 * 1000;
const EMOTES = ['angry', 'sad', 'win', 'taunt', 'thanks', 'chill', 'sleepy', 'clap'];
const EMOTE_GAP_MS = 1500;
const CHAT_MAX = 200;                   // 채팅 — 0.4초 간격 + 5초에 5개, 200자. 저장·로그 없이 같은 방에만 전달
const CHAT_GAP_MS = 400;
const CHAT_WINDOW_MS = 5000;
const CHAT_PER_WINDOW = 5;
const TIP_TYPES = ['flower', 'kiss', 'confetti', 'cigarette', 'champagne'];   // 팁 — 이전 게임과 같다: 금액은 종류와 무관하게 그 방 BB 1개,
const TIP_STAGES = ['preflop', 'flop', 'turn'];   // [TIP_TURN_0_10_11] 리버에서는 팁을 받지 않는다
const TIP_COOLDOWN_MS = 3000;                                                   //   프리플랍에서만 보내고, 칩은 판이 끝난 뒤 옮긴다(모자라면 취소)
/** 「레이즈 중」 알림 최소 간격 */
const RAISING_GAP_MS = 300;
/** [RAISE_TIME_0_10_9] 레이즈 바를 처음 잡으면 차례 시간 + — 원본 게임(한 차례에 한 번, 모든 자리 같은 규칙). 칩·카드와 무관 */
const RAISE_ADD_MS = 10 * 1000;
const MAX_WATCHERS = 3;                  // [WATCH_0_10_20] 한 방 관전자(방장) 상한 — 한 방 방장은 최대 3명
const WATCH_GONE_MS = 2 * 60 * 1000;     // 관전 화면 연결이 모두 끊긴 뒤 이 시간이 지나면 관전 토큰을 지운다
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
                if (e.house) { if (a) a.stack = round3(a.stack - e.amount); }   // [TIP_HOUSE_0_10_12] 본사 팁 — 보낸 사람만
                else if (a && b) { a.stack = round3(a.stack - e.amount); b.stack = round3(b.stack + e.amount); }
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
        if (t.watch) return this._joinWatch(t);   // [WATCH_0_10_20] 관전(방장) — 자리·칩 없음
        if (this.liveSessions.has(t.player.sessionId)) throw new TableError('ticket', 'session already seated');
        let room = this.rooms.get(t.room.id);
        if (!room) room = this._openRoom(t.room);
        else if (!sameRules(room.rules, t.room)) throw new TableError('rules', 'ticket rules differ from the table');
        if (room.closing) throw new TableError('closed', 'table is closing');
        // 같은 회원이 이미 앉아 있다 — 본인 키로 서명한 새 세션이면 기존 자리를 탈락시킨다(정산 뒤 다시 앉는다). 다른 키면 기존 자리에 아무 일도 없다
        const existing = room.seats.find((x) => x && x.odcId === t.player.odcId);
        // [REBUY_0_10_1] 칩 0 으로 정산하고 잡아 둔 자기 자리 — 새 좌석표(새 바이인)로 그 자리에 다시 앉는다
        let back = -1, prevBi = 0, prevBiAmt = 0;
        if (existing && existing.held) { back = existing.seat; prevBi = existing.bi || 0; prevBiAmt = existing.biAmt || 0; this._release(room, existing, 'rebuy'); }
        else if (existing) {
            if (this._signedBy(t, auth, existing.boundFp)) {
                this._leave(room, existing, 'replaced');
                throw new TableError('replaced', 'previous session closed — join again after it is settled');
            }
            throw new TableError('seat', 'player already at this table');
        }
        // [SEAT_PICK_0_10_25] 잡아 둔 자기 자리(재바이인) → 좌석표가 정한 자리(비어 있으면) → 첫 빈자리
        const seat = back >= 0 ? back : (t.seat >= 0 && !room.seats[t.seat] ? t.seat : room.seats.findIndex((s) => !s));
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
            rebuy: back >= 0 ? 'done' : null, held: false, unit, bi: prevBi + biNew, biNew, biAmt: round3(prevBiAmt + t.buyIn),   // [PROFILE_STATS_0_10_11] 이 자리에 들어온 바이인 금액 합계(표시용)
            // [REBUY_0_10_1] rebuy: null | 'asked'(말풍선) | 'done'(돌아옴, 한 판)
            timeBank: TIME_BANK_START, emoteAt: 0, chatRate: { last: 0, start: 0, n: 0 }, sigJwk: null, tipN: 0, tipAt: 0, tips: [], raisingAt: 0, darkNext: false,
            clients: new Set(), joinedAt: this.clock.now(), ready: false,   // [READY_SESSION_0_10_6]
            choosing: !!t.pick && back < 0,   // [SEAT_CHOOSE_0_10_26] 자리를 고르는 중(잡아 둔 자기 자리로 돌아오면 고르지 않는다)
            pickable: !!t.pick && back < 0, dealt: false,   // [SEAT_REPICK_0_10_26] 첫 판 전에는 대기실에서 자리를 다시 고를 수 있다
        };
        // 좌석표는 사슬에 먼저 남긴다 — 이후 엔진이 다시 떠도 이 돈은 정산된다
        if (this.store) this.store.appendEvent('seat-in', { tid: t.tid, roomId: room.id, tableId: room.tableId, sessionId: s.sessionId, odcId: s.odcId, buyIn: s.buyIn, currency: s.currency });
        this.usedTickets.add(t.tid);
        this.liveSessions.add(s.sessionId);
        room.seats[seat] = s;
        room.emptySince = null;
        this.tokens.set(token, { room, seat });
        this._armGone(room, s);   // 화면이 붙기 전까지도 시간을 잰다
        if (s.choosing) {   // [SEAT_CHOOSE_0_10_26] 90초 안에 고르지 않으면 지금 자리로 앉힌다(자리를 붙잡고 있지 않게)
            this.clock.setTimeout(() => { if (room.seats[s.seat] === s && s.choosing) this._sit(room, s, { seat: s.seat }); }, PICK_SEAT_MS);
        }
        this._broadcast(room, 'seat', { seat: this._publicSeat(room, s) });
        this._broadcastGate(room);
        this._maybeStart(room);
        return { token, roomId: room.id, tableId: room.tableId, seat, seedCommit: room.seedCommit };
    }

    /**
     * [RESUME_0_10_11] 앉아 있는 자리로 돌아오기 — 화면이 다시 열렸거나 다른 탭에서 열어 좌석 토큰이 없을 때.
     * 그 좌석표(tid)로 앉을 때 묶은 서명 키(boundFp)로 서명한 요청에만 그 자리의 토큰을 돌려준다(5분 안의 시각).
     * 새로 앉히거나 칩을 움직이지 않는다 — 이미 있는 자리에 다시 붙을 뿐. 키 없이 앉은 자리(boundFp 없음)는 돌아올 수 없다
     */
    resume(m) {
        const tid = String((m && m.tid) || '');
        const ts = Number(m && m.ts);
        const a = (m && m.auth) || {};
        if (!tid || !Number.isFinite(ts) || Math.abs(this.clock.now() - ts) > 5 * 60 * 1000) throw new TableError('resume', 'bad or stale resume request');
        let found = null;
        for (const room of this.rooms.values()) {
            const s = room.seats.find((x) => x && x.tid === tid);
            if (s) { found = { room, s }; break; }
        }
        if (!found || found.s.leaving) throw new TableError('resume', 'seat is gone');
        const { room, s } = found;
        let ok = false;
        try {
            const fp = C.fingerprint(a.sig);
            ok = !!s.boundFp && fp === s.boundFp && C.verify(C.importPublicJwk(a.sig), C.msgResume(tid, fp, ts), a.proof);
        } catch (_e) { ok = false; }
        if (!ok) throw new TableError('resume', 'not the key this seat was taken with');
        return { token: s.token, roomId: room.id, tableId: room.tableId, seat: s.seat, seedCommit: room.seedCommit };
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
            gate: true, session: null, sessionTimers: [],   // [READY_SESSION_0_10_6]
            watchers: new Map(),   // [WATCH_0_10_20] 관전 토큰 → 관전자
        };
        this.rooms.set(room.id, room);
        return room;
    }

    // ------------------------------------------------------------ 명령

    // ------------------------------------------------------------ 관전 [WATCH_0_10_20]

    /**
     * 관전(방장) — 콘솔이 서명한 관전 좌석표(watch)로 들어온다. 자리·칩이 없고 판에 들지 않는다.
     * 받는 것: 모두에게 방송되는 이벤트(_broadcast)와 공개 상태(snapshotWatch) — 홀카드 봉투는 자리마다(_send)라 오지 않는다.
     * 할 수 있는 것: 채팅·나가기. 앉은 회원들은 누가 관전 중인지 본다(watch 이벤트)
     */
    _joinWatch(t) {
        let room = this.rooms.get(t.room.id);
        if (!room) room = this._openRoom(t.room);
        else if (!sameRules(room.rules, t.room)) throw new TableError('rules', 'ticket rules differ from the table');
        if (room.closing) throw new TableError('closed', 'table is closing');
        if (room.seats.some((x) => x && x.odcId === t.player.odcId)) throw new TableError('seat', 'player already at this table');
        for (const w of [...room.watchers.values()]) if (w.odcId === t.player.odcId) this._dropWatch(room, w);   // 같은 방장의 예전 관전 화면
        if (room.watchers.size >= MAX_WATCHERS) throw new TableError('full', 'too many watchers');
        const token = crypto.randomBytes(24).toString('base64url');
        const w = { watch: true, token, tid: t.tid, odcId: t.player.odcId, nickname: t.player.nickname, avatar: t.player.avatar,
            currency: t.currency, display: t.display, clients: new Set(), chatRate: { last: 0, start: 0, n: 0 }, goneTimer: null, joinedAt: this.clock.now() };
        this.usedTickets.add(t.tid);
        room.watchers.set(token, w);
        this.tokens.set(token, { room, watch: w });
        this._armWatchGone(room, w);
        this._broadcast(room, 'watch', this._watchInfo(room));
        return { token, roomId: room.id, tableId: room.tableId, watch: true, seedCommit: room.seedCommit };
    }

    _watchInfo(room) {
        const list = [...(room.watchers || new Map()).values()];
        return { n: list.length, names: list.map((w) => w.nickname) };
    }

    _armWatchGone(room, w) {
        if (w.goneTimer) this.clock.clearTimeout(w.goneTimer);
        w.goneTimer = this.clock.setTimeout(() => { w.goneTimer = null; if (!w.clients.size) this._dropWatch(room, w); }, WATCH_GONE_MS);
    }

    _dropWatch(room, w) {
        if (!room.watchers || !room.watchers.has(w.token)) return { ok: true };
        if (w.goneTimer) { this.clock.clearTimeout(w.goneTimer); w.goneTimer = null; }
        room.watchers.delete(w.token);
        this.tokens.delete(w.token);
        for (const c of w.clients) c.end();
        this._broadcast(room, 'watch', this._watchInfo(room));
        return { ok: true };
    }

    _watchCommand(room, w, m) {
        switch (m.type) {
            case 'chat': return this._chat(room, w, m);
            case 'leave': return this._dropWatch(room, w);
            default: throw new TableError('watch', 'watchers can only chat');
        }
    }

    /** 관전 화면이 붙자마자 받는 공개 상태 — snapshot 과 같지만 내 자리·홀카드가 없다 */
    snapshotWatch(room, w) {
        const snap = this.snapshot(room, null);
        snap.me = { seat: -1, watch: true, odcId: w.odcId, nickname: w.nickname, currency: w.currency, display: w.display };
        snap.hole = null;
        return snap;
    }

    _auth(token) {
        const at = this.tokens.get(String(token || ''));
        if (!at) throw new TableError('auth', 'unknown token');
        if (at.watch) throw new TableError('watch', 'watchers can only chat');   // [WATCH_0_10_20]
        const s = at.room.seats[at.seat];
        if (!s || s.token !== token) throw new TableError('auth', 'seat is gone');
        return { room: at.room, s };
    }

    command(token, msg) {
        const wt = this.tokens.get(String(token || ''));
        if (wt && wt.watch) return this._watchCommand(wt.room, wt.watch, msg || {});   // [WATCH_0_10_20]
        const { room, s } = this._auth(token);
        const m = msg || {};
        switch (m.type) {
            case 'keys': return this._keys(room, s, m);
            case 'entropy': return this._entropy(room, s, m);
            case 'act': return this._act(room, s, m);
            case 'ready': return this._ready(room, s, m);   // [READY_SESSION_0_10_6]
            case 'sit': return this._sit(room, s, m);   // [SEAT_CHOOSE_0_10_26]
            case 'repick': return this._repick(room, s);   // [SEAT_REPICK_0_10_26]
            case 'sitout': return this._sitout(room, s, true);    // [AWAY_0_10_16]
            case 'back': return this._sitout(room, s, false);
            case 'leave': return this._leave(room, s, 'left');
            case 'timebank': return this._timeBank(room, s);
            case 'emote': return this._emote(room, s, m);
            case 'chat': return this._chat(room, s, m);
            case 'tip': return this._tip(room, s, m);
            case 'raising': return this._raising(room, s, m);
            case 'dark': return this._dark(room, s, m);
            case 'show': return this._show(room, s, m);
            case 'peek': return this._peek(room, s);   // [DARK_PEEK_0_10_11]
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
        // [CHIP_UNIT_0_10_6] 원화 방 — 베팅은 1원 단위(서명된 금액을 바꿀 수 없으니 받지 않는다)
        if (room.rules.rake.unit === 1 && !Number.isInteger(Number(m.amount) || 0)) throw new TableError('input', 'amount must be whole chips');
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
        // [RAISE_TIME_0_10_9] 레이즈 금액을 고르기 시작하면 한 차례에 한 번 +10초(원본 RAISE_TIME_ADD). 차례 시간만 늘고 액션·칩은 그대로
        if (m.active && h.timer && h.raiseAddQ !== h.q) {
            h.raiseAddQ = h.q;
            h.deadline += RAISE_ADD_MS;
            const seat = h.toAct, q = h.q;
            this.clock.clearTimeout(h.timer);
            h.timer = this.clock.setTimeout(() => this._timeout(room, seat, q), Math.max(0, h.deadline - this.clock.now()));
            this._broadcast(room, 'turn', this._turnInfo(room));
            this._broadcast(room, 'raise-time', { seat, addedMs: RAISE_ADD_MS });
            return { ok: true, addedMs: RAISE_ADD_MS, deadline: h.deadline };
        }
        return { ok: true };
    }

    /**
     * [SHOW_CARDS_0_10_9] 폴드승한 사람이 자기 카드를 보여 준다 — 'left' | 'right' | 'both', 결과 뒤 다음 판 전까지 한 번.
     * 칩·결과와 무관하고 판은 끝났다. 보내는 것은 그 카드의 opening(덱 위치·카드·소금)뿐이라 화면이 판 시작 때 받은 카드 약속과 대조한다
     * (운영 서버가 다른 카드를 끼워 넣을 수 없다). 다른 사람 카드·덱·씨앗은 보내지 않는다.
     */
    _show(room, s, m) {
        const sh = room.showable;
        if (!sh || sh.seat !== s.seat) throw new TableError('show', 'nothing to show');
        if (sh.shown) throw new TableError('show', 'already shown');
        if (this.clock.now() > sh.until || room.hand) throw new TableError('show', 'too late to show');
        const which = String(m.which || '');
        // [OMAHA_0_10_23] 오마하(홀카드 4·5장)는 「모두 보여 주기」만 — 내 카드 전부
        const many = sh.hole.length > 2;
        const pick = which === 'both' ? sh.hole.map((_c, k) => k) : many ? null : which === 'left' ? [0] : which === 'right' ? [1] : null;
        if (!pick) throw new TableError('input', 'bad show choice');
        const cards = pick.map((k) => opening(sh.seed, sh.handId, sh.deck, sh.deck.indexOf(sh.hole[k])));
        sh.shown = true;
        this._broadcast(room, 'shown', { handId: sh.handId, seat: s.seat, which, cards });
        return { ok: true, cards: cards.length };
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
    /**
     * [DARK_PEEK_0_10_11] 인 더 다크 판에서 플랍부터 내 카드를 본다 — 카드는 원래 내 브라우저에 있다(봉투). 엔진이 하는 일은
     * 「이 자리는 이제 다크가 아니다」를 모두에게 알리는 것뿐(상대가 알 수 있게). 카드·판 진행·돈은 바뀌지 않는다
     */
    _peek(room, s) {
        const h = room.hand;
        if (!h || !(h.dark || []).includes(s.seat)) throw new TableError('input', 'not in the dark');
        if (h.stage === 'preflop') throw new TableError('input', 'you can look from the flop');
        h.dark = h.dark.filter((x) => x !== s.seat);
        this._broadcast(room, 'peek', { handId: h.handId, seat: s.seat });
        return { ok: true };
    }

    /** 채팅 — 제어문자 제거·200자, 도배 제한. 같은 방 좌석에 전달만 하고 저장·로그·콘솔 전송은 없다 */
    _chat(room, s, m) {
        const text = String(m.text == null ? '' : m.text).replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, CHAT_MAX);
        if (!text) throw new TableError('input', 'empty message');
        const now = this.clock.now(), r = s.chatRate;
        if (now - r.start > CHAT_WINDOW_MS) { r.start = now; r.n = 0; }
        if (now - r.last < CHAT_GAP_MS || r.n >= CHAT_PER_WINDOW) throw new TableError('rate', 'too fast');
        r.last = now; r.n += 1;
        // [WATCH_0_10_20] 관전 중인 방장 채팅 — 자리 없음(seat -1), host 표시(화면이 밝은 금빛으로)
        this._broadcast(room, 'chat', s.watch ? { seat: -1, host: true, nickname: s.nickname, text, at: now } : { seat: s.seat, nickname: s.nickname, text, at: now });
        return { ok: true };
    }

    /**
     * 팁 — 칩이 움직이므로 보내는 사람의 서명(msgTip, 좌석마다 1부터 하나씩 느는 번호)이 있어야 한다.
     * 받으면 연출만 바로 알리고, 칩은 판이 끝난 뒤(_settleTips) 옮긴다. 그때 스택이 모자라거나 한쪽이 일어나면 취소.
     */
    _tip(room, s, m) {
        const h = room.hand;
        if (!h || !TIP_STAGES.includes(h.stage)) throw new TableError('tip', 'tips cannot be sent on the river');   // [TIP_TURN_0_10_11] 프리플랍·플랍·턴까지, 리버부터는 막는다
        if (s.leaving) throw new TableError('tip', 'you are leaving the table');
        const to = room.seats[Number(m.to)];
        if (!to || to === s || to.held) throw new TableError('input', 'bad tip target');   // [REBUY_0_10_1] 정산한 자리는 받지 않는다
        if (to.leaving) throw new TableError('tip', 'that player is leaving the table');
        const type = String(m.gift || '');   // 명령 이름이 type 이라 팁 종류는 gift
        if (!TIP_TYPES.includes(type)) throw new TableError('input', 'unknown tip type');
        const n = Number(m.n);
        if (!Number.isInteger(n) || n !== s.tipN + 1) throw new TableError('tip', 'stale tip number');
        // [TIP_HOUSE_0_10_12] 좌석표에 팁 금액이 있으면 그 금액(원화 방 1,000원)이고 칩은 본사로 — 받는 사람에게는 연출만
        const house = room.rules.tip > 0;
        const amount = house ? room.rules.tip : room.rules.bb;
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
        s.tips.push({ to, toSeat: to.seat, type, amount, n, sig: String(m.sig), house });
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
                // [TIP_HOUSE_0_10_12] 본사 팁은 받는 사람이 그사이 일어나도 보낸 사람 칩으로 낸다(받는 사람 칩은 안 바뀐다)
                const ok = room.seats[s.seat] === s && !s.leaving && s.stack >= x.amount && (x.house || (room.seats[x.toSeat] === to && !to.leaving && !to.held));
                if (ok && this.store) {
                    this.store.appendEvent('tip', { tableId: room.tableId, roomId: room.id, fromSession: s.sessionId, toSession: to.sessionId,
                        fromOdc: s.odcId, toOdc: to.odcId, toSeat: x.toSeat, n: x.n, type: x.type, amount: x.amount, sigJwk: s.sigJwk, sig: x.sig, ...(x.house ? { house: true } : {}) });
                }
                if (!ok) { this._broadcast(room, 'tip-cancel', { from: s.seat, to: x.toSeat, amount: x.amount }); continue; }
                s.stack = round3(s.stack - x.amount);
                if (!x.house) to.stack = round3(to.stack + x.amount);
                const stacks = { [s.seat]: s.stack };
                if (!x.house) stacks[x.toSeat] = to.stack;
                this._broadcast(room, 'tip-done', { from: s.seat, to: x.toSeat, type: x.type, amount: x.amount, house: !!x.house, stacks });
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
        s.held = true; s.rebuy = null; s.tips = []; this._clearAway(s);
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
        this._seatsChanged(room);   // [READY_SESSION_0_10_6]
    }

    /** 「바이인 신청」 — 같은 방 모두에게 말풍선만. 신청·승인·좌석표는 처음 앉을 때와 같은 길(화면이 로비로 간다). 사슬·콘솔로 가는 것 없음 */
    _rebuyAsk(room, s) {
        if (!s.held) throw new TableError('rebuy', 'only a seat with no chips can ask for a buy-in');
        if (s.rebuy !== 'asked') { s.rebuy = 'asked'; this._broadcast(room, 'seat', { seat: this._publicSeat(room, s) }); }
        return { ok: true, roomId: room.id };
    }

    /**
     * [AWAY_0_10_16] 자리 비움 — 다음 판부터 카드를 받지 않는다(진행 중인 판은 내 차례가 오면 바로 체크/폴드, 시간 초과로 세지 않는다).
     * 「돌아왔어요」로 풀면 다음 판부터 다시 든다. AWAY_MS(10분) 동안 풀지 않으면 나가기(정산) — 이유 'away'.
     * 칩·카드와 무관해 좌석 토큰만으로 된다. 끝나는 시각(awayUntil)은 모두에게 보인다(자리 표시용)
     */
    _sitout(room, s, on) {
        if (s.held || s.leaving) throw new TableError('sitout', 'this seat cannot sit out now');
        if (on) {
            if (!s.sitout) { s.sitout = true; s.awayUntil = this.clock.now() + (this.awayMs || AWAY_MS); }
            s.ready = false;
            if (s.awayTimer) this.clock.clearTimeout(s.awayTimer);
            s.awayTimer = this.clock.setTimeout(() => {
                s.awayTimer = null;
                if (room.seats[s.seat] === s && s.sitout && !s.leaving && !s.held) this._leave(room, s, 'away');
            }, Math.max(0, s.awayUntil - this.clock.now()));
        } else {
            this._clearAway(s);
            s.timeouts = 0;
        }
        this._broadcast(room, 'seat', { seat: this._publicSeat(room, s) });
        if (room.gate) this._broadcastGate(room);
        const h = room.hand;
        if (on && h && h.toAct === s.seat) this._timeout(room, s.seat, h.q);   // 지금 내 차례면 기다리지 않는다
        else this._maybeStart(room);
        return { ok: true, sitout: s.sitout, awayUntil: s.awayUntil || 0 };
    }

    _clearAway(s) {
        s.sitout = false; s.awayUntil = 0;
        if (s.awayTimer) { this.clock.clearTimeout(s.awayTimer); s.awayTimer = null; }
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
        return room.seats.filter((s) => s && s.keys && s.entropyFor === room.seedCommit && !s.sitout && !s.leaving && s.stack > 0 && !s.choosing);   // [SEAT_CHOOSE_0_10_26]
    }

    _maybeStart(room) {
        if (room.hand || room.closing) return;
        // [READY_SESSION_0_10_6] 준비 게이트 — 모두 준비해야 시작한다. 시작을 기다리는 동안 누가 준비를 풀면 멈춘다
        if (room.gate && !this._gateReady(room)) {
            if (room.startTimer) { this.clock.clearTimeout(room.startTimer); room.startTimer = null; room.startAt = 0; this._broadcastGate(room); }
            return;
        }
        if (room.startTimer) return;
        // [RESULT_HOLD_0_10_25] 지난 판 결과 연출(올인 런아웃·카드 공개·승자) 동안은 시작하지 않는다 — 종전엔 그 사이에 무작위 값·좌석·자리 비움 등이
        //   _maybeStart 를 부르면 3초 뒤 바로 다음 판이 시작돼 승자 연출이 잘렸다. 연출이 끝나는 때(_afterHand 의 타이머)가 다시 부른다
        //   [RESULT_HOLD_FIX_0_10_25] Node 타이머는 Date.now() 보다 1ms 먼저 울리는 일이 잦다(약 15%) — 그때 그냥 돌아가면 아무도 다시 부르지 않아
        //   판이 영영 시작되지 않았다(「게임이 끝났는데 시작을 안 한다」). 남은 시간 뒤에 스스로 다시 부른다
        const wait = room.resumeAt ? room.resumeAt - this.clock.now() : 0;
        if (wait > 0) {
            if (!room.resumeTimer) room.resumeTimer = this.clock.setTimeout(() => { room.resumeTimer = null; this._maybeStart(room); }, wait + 5);
            return;
        }
        if (this._eligible(room).length < 2) return;
        room.startAt = this.clock.now() + START_DELAY_MS;
        room.startTimer = this.clock.setTimeout(() => { room.startTimer = null; room.startAt = 0; this._startHand(room); }, START_DELAY_MS);
        if (room.gate) this._broadcastGate(room);   // 화면이 「곧 시작」을 센다
    }

    // ------------------------------------------------------------ 준비 게이트 · 게임 시간 [READY_SESSION_0_10_6]

    /** 준비 게이트에 드는 자리 — 칩이 있고 일어나는 중이 아닌 자리(올인으로 잡아 둔 자리는 빠진다) */
    _gatePlayers(room) {
        return room.seats.filter((s) => s && !s.held && !s.leaving && !s.sitout && s.stack > 0 && !s.choosing);   // [SEAT_CHOOSE_0_10_26] 자리를 고르는 중이면 준비 목록에 아직 없다   // [AWAY_0_10_16] 자리 비움은 대기실 준비에서 뺀다
    }

    /** 2명 이상이 모두 준비했고, 모두 이번 판에 들 수 있다(키·무작위 값) */
    _gateReady(room) {
        const g = this._gatePlayers(room);
        return g.length >= 2 && g.every((s) => s.ready && s.keys && s.entropyFor === room.seedCommit);
    }

    /**
     * [SEAT_CHOOSE_0_10_26] 들어온 회원이 테이블의 빈자리를 고른다 — 고르는 중(choosing)일 때만, 판에 든 적이 없을 때만.
     * 지금 자리를 고르면 그대로 앉는다. 자리 번호만 바뀐다 — 칩·카드·판과 무관(아직 어느 판에도 들지 않았다).
     * 이미 판을 친 자리는 옮길 수 없다(블라인드 피하기 막음)
     */
    _sit(room, s, m) {
        if (!s.choosing) throw new TableError('sit', 'seat already chosen');
        const to = Number(m && m.seat);
        if (!Number.isInteger(to) || to < 0 || to >= room.rules.maxPlayers) throw new TableError('sit', 'bad seat');
        if (to !== s.seat) {
            if (room.seats[to]) throw new TableError('sit', 'seat is taken');
            const from = s.seat;
            room.seats[from] = null;
            room.seats[to] = s;
            s.seat = to;
            this.tokens.set(s.token, { room, seat: to });
            this._broadcast(room, 'seat', { seat: { seat: from, empty: true } });
        }
        s.choosing = false;
        this._broadcast(room, 'seat', { seat: this._publicSeat(room, s) });
        this._broadcastGate(room);
        this._maybeStart(room);
        return { ok: true, seat: s.seat };
    }

    /**
     * [SEAT_REPICK_0_10_26] 대기실에서 「자리 바꾸기」 — 들어와서 자리를 고른 회원이 아직 어느 판에도 들지 않았을 때만 다시 고르는 중으로.
     * 준비는 풀린다. 판을 한 번이라도 친 자리는 바꿀 수 없다(블라인드 피하기 막음)
     */
    _repick(room, s) {
        if (!s.pickable || s.dealt) throw new TableError('sit', 'seat can no longer be changed');
        if (room.hand && room.hand.seats.includes(s.seat)) throw new TableError('sit', 'in a hand');
        if (s.choosing) return { ok: true, seat: s.seat };
        s.choosing = true; s.ready = false;
        if (room.startTimer && room.gate) { this.clock.clearTimeout(room.startTimer); room.startTimer = null; room.startAt = 0; }
        this.clock.setTimeout(() => { if (room.seats[s.seat] === s && s.choosing) this._sit(room, s, { seat: s.seat }); }, PICK_SEAT_MS);
        this._broadcast(room, 'seat', { seat: this._publicSeat(room, s) });
        this._broadcastGate(room);
        this._maybeStart(room);
        return { ok: true, seat: s.seat };
    }

    /** 「준비 완료」/「준비 취소」 — 게이트가 열려 있을 때만. 칩·카드와 무관해 좌석 토큰만으로 된다 */
    _ready(room, s, m) {
        if (!room.gate) return { ok: true, gate: false };
        if (s.held || s.leaving || !(s.stack > 0)) throw new TableError('ready', 'this seat cannot play now');
        if (s.choosing) throw new TableError('ready', 'choose a seat first');   // [SEAT_CHOOSE_0_10_26]
        s.ready = m.on !== false;
        if (s.ready) { this._clearAway(s); s.timeouts = 0; }
        this._broadcastGate(room);
        this._maybeStart(room);
        return { ok: true, ready: s.ready };
    }

    _gateInfo(room, delayMs = 0) {
        if (!room.gate) return { active: false };
        const players = this._gatePlayers(room).map((s) => ({ seat: s.seat, nickname: s.nickname, ready: !!s.ready }));
        return {
            active: true, players, total: players.length, ready: players.filter((x) => x.ready).length, need: 2,
            sessionMin: room.rules.sessionMin || 0, startsAt: room.startTimer ? room.startAt : 0, serverNow: this.clock.now(), delayMs,
        };
    }

    _broadcastGate(room, delayMs = 0) {
        this._broadcast(room, 'gate', this._gateInfo(room, delayMs));
    }

    /** 준비 게이트로 돌아간다 — 모두 다시 「준비 완료」를 눌러야 다음 판이 시작된다(자리·칩은 그대로) */
    _rearmGate(room, delayMs = 0) {
        room.gate = true;
        if (room.startTimer) { this.clock.clearTimeout(room.startTimer); room.startTimer = null; room.startAt = 0; }
        for (const s of room.seats) if (s) s.ready = false;
        this._broadcastGate(room, delayMs);
    }

    /** 자리가 바뀌었다(나감·비움) — 판을 칠 사람이 2명 아래면 게이트로, 게이트면 목록을 새로 알리고 시작을 다시 본다 */
    _seatsChanged(room) {
        if (room.closing || room.settling) return;
        // [RESULT_HOLD_0_10_25] 결과 연출 중이면 대기실도 연출이 끝난 뒤에 띄운다
        if (!room.hand && !room.gate && this._gatePlayers(room).length < 2) this._rearmGate(room, Math.max(0, (room.resumeAt || 0) - this.clock.now()));
        else if (room.gate) this._broadcastGate(room);
        if (room.gate) this._maybeStart(room);
    }

    _sessionInfo(room) {
        const min = room.rules.sessionMin || 0;
        if (!min) return null;
        const ss = room.session;
        return {
            minutes: min, phase: !ss ? 'idle' : ss.finalLeft === null ? 'running' : 'final',
            startedAt: ss ? ss.startedAt : 0, endsAt: ss ? ss.endsAt : 0, serverNow: this.clock.now(),
            finalTotal: SESSION_FINAL_HANDS, finalNo: ss ? ss.finalNo : 0, finalLeft: ss ? ss.finalLeft : null, warnMs: FINAL_WARN_MS,
        };
    }

    _broadcastSession(room, event) {
        const info = this._sessionInfo(room);
        if (info) this._broadcast(room, 'session', { ...info, event });
    }

    _clearSessionTimers(room) {
        for (const x of room.sessionTimers) this.clock.clearTimeout(x);
        room.sessionTimers = [];
    }

    /** 판이 시작될 때 — 첫 판이면 게임 시간을 잰다. 마지막 판 차례면 하나를 쓴다 */
    _sessionOnHandStart(room) {
        const min = room.rules.sessionMin || 0;
        if (!min) return;
        const now = this.clock.now();
        if (!room.session) {
            const ms = min * 60000;
            room.session = { startedAt: now, endsAt: now + ms, finalLeft: null, finalNo: 0, warned: ms <= FINAL_WARN_MS };
            this._clearSessionTimers(room);
            if (ms > FINAL_WARN_MS) room.sessionTimers.push(this.clock.setTimeout(() => this._sessionWarn(room), ms - FINAL_WARN_MS));
            room.sessionTimers.push(this.clock.setTimeout(() => this._sessionTimeUp(room), ms));
            this._broadcastSession(room, 'start');
            return;
        }
        const ss = room.session;
        if (ss.finalLeft !== null && ss.finalLeft > 0) {
            ss.finalNo = SESSION_FINAL_HANDS - ss.finalLeft + 1;
            ss.finalLeft -= 1;
            this._broadcastSession(room, 'final-hand');
        }
    }

    /** 끝나기 3분 전 — 「곧 마지막 3판」 안내 */
    _sessionWarn(room) {
        const ss = room.session;
        if (!ss || ss.warned || ss.finalLeft !== null || this.rooms.get(room.id) !== room) return;
        ss.warned = true;
        this._broadcastSession(room, 'warn');
    }

    /** 시간이 다 됐다 — 지금 치는 판은 마저 치고, 다음 판부터 마지막 3판 */
    _sessionTimeUp(room) {
        const ss = room.session;
        if (!ss || ss.finalLeft !== null || this.rooms.get(room.id) !== room) return;
        ss.finalLeft = SESSION_FINAL_HANDS;
        ss.finalNo = 0;
        this._broadcastSession(room, 'time-up');
    }

    /** 마지막 판까지 끝났다 — 아무도 내보내지 않고 준비 게이트로 돌아간다. 다음 게임은 다시 모두 준비하면 새 게임 시간으로 */
    _endSession(room, delayMs) {
        this._clearSessionTimers(room);
        room.session = null;
        this._broadcast(room, 'session', { ...this._sessionInfo(room), event: 'ended' });
        this._rearmGate(room, delayMs);
    }

    _nextSeat(list, from) {
        const seats = list.map((s) => s.seat).sort((a, b) => a - b);
        return seats.find((x) => x > from) ?? seats[0];
    }

    _startHand(room) {
        room.showable = null;   // [SHOW_CARDS_0_10_9] 지난 판 카드 보여 주기는 다음 판이 시작되면 끝
        if (room.hand || room.closing) return;
        if (this._timeOver(room)) return this._close(room, 'time');
        if (room.gate && !this._gateReady(room)) { this._broadcastGate(room); return; }   // [READY_SESSION_0_10_6]
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
            rake: room.rules.rake, strictOrder: true, game: room.rules.game || 'holdem',   // [OMAHA_0_10_23]
        });
        if (!r.ok) { this._broadcast(room, 'error', { error: r.error }); return; }
        room.seedCommit = r.nextSeedCommit;
        for (const p of players) if (!p.dealt) { p.dealt = true; if (p.pickable) this._broadcast(room, 'seat', { seat: this._publicSeat(room, p) }); }   // [SEAT_REPICK_0_10_26] 판에 들었다 — 이제 자리를 못 바꾼다
        // [READY_SESSION_0_10_6] 게이트를 닫고 게임 시간을 잰다(첫 판) / 마지막 판이면 하나를 쓴다 — 화면이 판보다 먼저 알도록 판 알림 전에
        if (room.gate) { room.gate = false; for (const x of room.seats) if (x) x.ready = false; this._broadcastGate(room); }
        this._sessionOnHandStart(room);
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
                if (s && (s.leaving || s.sitout)) this._timeout(room, seat, q);   // 탈락이 정해진 좌석·자리 비움은 기다리지 않는다
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
                h.dark = [];   // [DARK_PEEK_0_10_11] 올인 런아웃이면 모두 패를 연다 — 다크도 끝(다시 들어온 화면도 같게)
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
            toCall: Math.min(toCall, p.stack), minRaise: core.calculateMinRaise(), maxBet: round3(core.maxRaiseTo(p)),   // [OMAHA_0_10_23] 팟 리밋이면 팟 한도
            allIn: round3(p.stack + p.currentBet), potLimit: !!core.potLimit,
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
        const sitout = !!(s && !leaving && s.sitout);   // [AWAY_0_10_16] 자리 비움 — 방치가 아니다(횟수에 넣지 않는다)
        const away = !!(s && !leaving && (!s.clients.size || sitout));
        const p = this._core(h).seats.get(seat);
        const action = away && p && this._core(h).currentBet <= p.currentBet ? 'CHECK' : 'FOLD';
        const r = this.engine.call('act', { handId: h.handId, entry: { k: 'host', seat, q, action, reason: leaving ? (s.leaveReason || 'left') : sitout ? 'sitout' : away ? 'disconnected' : 'timeout' } });
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
        // [SHOW_CARDS_0_10_9] 폴드승 승자는 다음 판 전까지 자기 홀카드를 골라 보여 줄 수 있다(원본 왼쪽/둘 다/오른쪽).
        //   판은 이미 끝났고 서명된 판 기록(씨앗 포함)이 남은 뒤다 — 보여 줄 카드의 opening 만 만든다(화면이 카드 약속과 대조한다)
        room.showable = null;
        if (f.type === 'uncontested' && f.result && Number.isInteger(f.result.winner) && rec.holes && rec.holes[f.result.winner]) {
            room.showable = { handId: h.handId, seat: f.result.winner, seed: rec.seed, deck: rec.deck, hole: rec.holes[f.result.winner], until: this.clock.now() + RESULT_PAUSE_MS, shown: false };
        }
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
        room.settling = true;   // [READY_SESSION_0_10_6] 아래에서 한꺼번에 게이트를 본다(자리마다 따로 보지 않게)
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
        room.settling = false;
        if (this._timeOver(room)) return this._close(room, 'time');
        // [READY_SESSION_0_10_6] 마지막 판까지 끝났으면 / 칠 사람이 2명 아래면 준비 게이트로 — 결과 연출이 끝난 뒤 화면에 띄운다
        const pause = RESULT_PAUSE_MS + extraMs;
        room.resumeAt = this.clock.now() + pause;   // [RESULT_HOLD_0_10_25]
        const ss = room.session;
        if (ss && ss.finalLeft === 0 && ss.finalNo > 0) this._endSession(room, pause);
        else if (!room.gate && this._gatePlayers(room).length < 2) this._rearmGate(room, pause);
        this.clock.setTimeout(() => this._maybeStart(room), pause);
    }

    /**
     * 옛 방식 — 좌석표의 끝 시각(room.endsAt)이 지나면 방을 닫고 모두 정산한다.
     * [READY_SESSION_0_10_6] 게임 시간(room.sessionMin)이 있는 좌석표면 끝 시각으로 닫지 않는다(마지막 3판 뒤 준비 게이트)
     */
    _timeOver(room) {
        return !room.rules.sessionMin && !!room.rules.endsAt && this.clock.now() >= room.rules.endsAt;
    }

    // ------------------------------------------------------------ 일어나기 · 정산 · 닫기

    _unseat(room, s, reason) {
        if (s.goneTimer) { this.clock.clearTimeout(s.goneTimer); s.goneTimer = null; }
        if (s.awayTimer) { this.clock.clearTimeout(s.awayTimer); s.awayTimer = null; }   // [AWAY_0_10_16]
        room.seats[s.seat] = null;
        this.tokens.delete(s.token);
        this.liveSessions.delete(s.sessionId);
        this._settle({ roomId: room.id, tid: s.tid, sessionId: s.sessionId, odcId: s.odcId, buyIn: s.buyIn, currency: s.currency,
            cashOut: s.stack, rakePaid: s.rakePaid, hands: s.hands, reason });
        this._send(s, 'settled', { cashOut: s.stack, reason });
        for (const c of s.clients) c.end();
        this._broadcast(room, 'seat', { seat: { seat: s.seat, empty: true } });
        if (room.seats.every((x) => !x)) room.emptySince = this.clock.now();
        this._seatsChanged(room);   // [READY_SESSION_0_10_6]
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
        room.closing = true;
        if (room.startTimer) { this.clock.clearTimeout(room.startTimer); room.startTimer = null; }
        this._clearSessionTimers(room);   // [READY_SESSION_0_10_6]
        for (const s of room.seats) if (s) (s.held ? this._release(room, s, 'table-' + reason) : this._unseat(room, s, 'table-' + reason));
        for (const w of [...(room.watchers || new Map()).values()]) this._dropWatch(room, w);   // [WATCH_0_10_20]
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
            if (this._timeOver(room) && !room.hand) this._close(room, 'time');
            else if (room.emptySince && now - room.emptySince > EMPTY_ROOM_MS) this._close(room, 'empty');
        }
    }

    // ------------------------------------------------------------ 이벤트

    subscribe(token, client) {
        const wt = this.tokens.get(String(token || ''));
        if (wt && wt.watch) {   // [WATCH_0_10_20]
            const { room, watch: w } = wt;
            if (w.clients.size >= MAX_CLIENTS_PER_SEAT) throw new TableError('busy', 'too many connections for this watcher');
            w.clients.add(client);
            if (w.goneTimer) { this.clock.clearTimeout(w.goneTimer); w.goneTimer = null; }
            client.onClose(() => { w.clients.delete(client); if (!w.clients.size && room.watchers.get(w.token) === w) this._armWatchGone(room, w); });
            client.send('snapshot', this.snapshotWatch(room, w));
            return true;
        }
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
        if (room.watchers) for (const w of room.watchers.values()) this._send(w, event, data);   // [WATCH_0_10_20] 관전자는 방송(공개)만 받는다
    }

    _publicSeat(room, s) {
        return { seat: s.seat, nickname: s.nickname, avatar: s.avatar, stack: s.stack, sitout: s.sitout, awayUntil: s.sitout ? (s.awayUntil || 0) : 0, leaving: s.leaving, keys: s.keys, connected: s.clients.size > 0,
            busted: !!s.held || (this._busted(s) && !(room.hand && room.hand.seats.includes(s.seat))), rebuy: s.rebuy,
            bi: s.bi || 0, biNew: s.rebuy === 'done' ? (s.biNew || 0) : 0, biAmt: s.biAmt || 0, choosing: !!s.choosing, repick: !!(s.pickable && !s.dealt) };   // [SEAT_CHOOSE_0_10_26]   // [PROFILE_STATS_0_10_11] 프로필 창 — 바이인 합계(좌석표에 이미 공개된 금액의 합)   // [BUYIN_UNITS_0_10_4] 표시용 — 합계·방금 받은 개수   // [REBUY_0_10_1]
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
            room: { id: room.id, name: room.rules.name, game: room.rules.game || 'holdem', sb: room.rules.sb, bb: room.rules.bb, maxPlayers: room.rules.maxPlayers, rake: room.rules.rake, turnSec: room.rules.turnSec, endsAt: room.rules.endsAt, sessionMin: room.rules.sessionMin || 0, tip: room.rules.tip || 0 },
            tableId: room.tableId, seedCommit: room.seedCommit, engine: this.engine.call('info').keys,
            me: s && { seat: s.seat, odcId: s.odcId, nickname: s.nickname, stack: s.stack, buyIn: s.buyIn, unit: s.unit, bi: s.bi || 0, rebuy: s.rebuy, currency: s.currency, display: s.display, keys: s.keys, sitout: s.sitout, awayUntil: s.sitout ? (s.awayUntil || 0) : 0, timeBank: s.timeBank, tipN: s.tipN, darkNext: s.darkNext, ready: !!s.ready, choosing: !!s.choosing },
            seats: room.seats.map((x) => (x ? this._publicSeat(room, x) : null)),
            hand: this._publicHand(room),
            hole: s && h && h.seats.includes(s.seat) ? { handId: h.handId, envelope: h.envelopes[s.seat] || null } : null,
            turn: h && h.toAct !== null ? this._turnInfo(room) : null,
            gate: this._gateInfo(room), session: this._sessionInfo(room),   // [READY_SESSION_0_10_6]
            watch: this._watchInfo(room),   // [WATCH_0_10_20] 지금 관전 중인 방장
        };
    }
}

function sameRules(a, b) {
    return (a.game || 'holdem') === (b.game || 'holdem') && a.sb === b.sb && a.bb === b.bb && a.maxPlayers === b.maxPlayers && a.rake.percent === b.rake.percent && a.rake.minPot === b.rake.minPot && (a.rake.unit || 0) === (b.rake.unit || 0) && a.turnSec === b.turnSec;
}

module.exports = { TableServer, TableError, TicketError };
