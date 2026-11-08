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
 */

const crypto = require('crypto');
const C = require('../crypto');
const { verifyTicket, TicketError } = require('./ticket');

const START_DELAY_MS = 3000;       // 판과 판 사이
const RESULT_PAUSE_MS = 4000;      // 결과를 보여 주는 시간
const EMPTY_ROOM_MS = 10 * 60 * 1000;
const DISCONNECT_GRACE_MS = 60 * 1000;
const TIMEOUT_KICK = 3;                 // 연속 시간 초과가 이만큼이면 탈락(이전 게임 서버와 같다)
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
        if (existing) {
            if (this._signedBy(t, auth, existing.boundFp)) {
                this._leave(room, existing, 'replaced');
                throw new TableError('replaced', 'previous session closed — join again after it is settled');
            }
            throw new TableError('seat', 'player already at this table');
        }
        const seat = room.seats.findIndex((s) => !s);
        if (seat < 0) throw new TableError('full', 'table is full');
        // 입장 서명(선택) — 이 브라우저의 서명 키. 같은 회원의 새 세션 판단과 '앉은 뒤 키가 바뀌면 탈락'의 기준이 된다
        let joinFp = null;
        try { const a = auth || {}; const fp = C.fingerprint(a.sig); if (C.verify(C.importPublicJwk(a.sig), C.msgJoin(t.tid, fp), a.proof)) joinFp = fp; } catch (_e) { /* 서명 없이 앉아도 된다 */ }

        const token = crypto.randomBytes(24).toString('base64url');
        const s = {
            seat, token, tid: t.tid, sessionId: t.player.sessionId, odcId: t.player.odcId,
            nickname: t.player.nickname, avatar: t.player.avatar, buyIn: t.buyIn, currency: t.currency, display: t.display,
            stack: t.buyIn, rakePaid: 0, hands: 0, keys: false, sitout: false, timeouts: 0, leaving: false, boundFp: joinFp,
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

    _leave(room, s, reason) {
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
        this._afterHand(room);
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

    _afterHand(room) {
        for (const s of room.seats) {
            if (!s) continue;
            if (s.leaving) this._unseat(room, s, s.leaveReason || 'left');
            else if (s.stack <= 0) this._unseat(room, s, 'busted');
        }
        if (room.rules.endsAt && this.clock.now() >= room.rules.endsAt) return this._close(room, 'time');
        this.clock.setTimeout(() => this._maybeStart(room), RESULT_PAUSE_MS);
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
        for (const s of room.seats) if (s) this._unseat(room, s, 'table-' + reason);
        this.engine.call('closeTable', { tableId: room.tableId });
        this.rooms.delete(room.id);
    }

    /** 주기 정리 — 시간이 끝난 방, 오래 빈 방 */
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
        return { seat: s.seat, nickname: s.nickname, avatar: s.avatar, stack: s.stack, sitout: s.sitout, leaving: s.leaving, keys: s.keys, connected: s.clients.size > 0 };
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
            toAct: h.toAct, q: h.q, deadline: h.deadline,
        };
    }

    /** 접속하자마자 받는 현재 상태 — 남의 카드는 들어 있지 않다. 내 홀카드는 내 키로 잠긴 봉투로만 */
    snapshot(room, s) {
        const h = room.hand;
        return {
            room: { id: room.id, name: room.rules.name, sb: room.rules.sb, bb: room.rules.bb, maxPlayers: room.rules.maxPlayers, rake: room.rules.rake, turnSec: room.rules.turnSec, endsAt: room.rules.endsAt },
            tableId: room.tableId, seedCommit: room.seedCommit, engine: this.engine.call('info').keys,
            me: { seat: s.seat, odcId: s.odcId, nickname: s.nickname, stack: s.stack, buyIn: s.buyIn, currency: s.currency, display: s.display, keys: s.keys, sitout: s.sitout },
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
