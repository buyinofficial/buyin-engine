/**
 * HandCore — 한 판의 규칙 (블라인드 · 딜 · 베팅 · 라운드 종료 · 런아웃 · 쇼다운 · 폴드승)
 *
 * 순수 상태 기계다. 시계·네트워크·DB 가 없고, 같은 입력이면 언제나 같은 결과가 나온다.
 * 그래서 검증기(verify.js)가 판 기록을 처음부터 다시 돌려 결과가 같은지 볼 수 있다.
 *
 * 계산 순서와 반올림은 이전 게임 서버와 한 줄 한 줄 같게 옮겼다(postBlinds · handleAction · checkRoundEnd ·
 * advanceStage · runItOut · showdown · resolveUncontestedWin · computePeekBoardCards). 소켓 서버는 화면 연출을 위해
 * 같은 판을 따라 계산하는데, 칩이 0.001 이라도 어긋나면 이 엔진이 그 액션을 거절하고 판을 무효로 한다.
 *
 * 카드를 언제 공개하는지는 이 엔진만 정한다:
 *   · 보드  — 그 베팅 라운드가 규칙대로 끝났을 때만 (advance)
 *   · 홀카드 — 본인에게는 판 시작 때 봉투로, 모두에게는 올인 런아웃·쇼다운에서 폴드하지 않은 사람 것만
 *   · 남은 보드(폴드승 뒤 보기) — 판이 끝난 뒤에만
 *
 * 누가 칩을 쓰는지도 이 엔진이 정한다. 칩이 움직이는 액션(콜·벳·레이즈·올인)은 그 회원의 서명이 있어야 한다.
 * 운영 서버가 혼자 할 수 있는 건 폴드와 체크(시간 초과·퇴장)뿐이고, 그것도 기록에 "운영 서버가 했다"로 남는다.
 */

const HandEvaluator = require('./HandEvaluator');
const PotManager = require('./PotManager');
const { roundMoney, floorMoney } = require('./money');
const { opening } = require('./cards');
const C = require('./crypto');

const ACTIONS = { FOLD: 'FOLD', CHECK: 'CHECK', CALL: 'CALL', BET: 'BET', RAISE: 'RAISE', ALL_IN: 'ALL_IN' };
const BETTING = ['preflop', 'flop', 'turn', 'river'];
const NEXT_STAGE = { preflop: 'flop', flop: 'turn', turn: 'river' };

class HandError extends Error {
    constructor(code, message) {
        super(message || code);
        this.code = code;
    }
}

class HandCore {
    /**
     * @param {object} o
     * @param {string} o.handId
     * @param {string} o.seed       이 판의 씨앗 (카드 salt 를 만든다)
     * @param {string[]} o.deck     섞인 덱 52장
     * @param {Array<{seat:number, odcId:string, stack:number, sigJwk?:object}>} o.seats  이 판에 카드를 받는 좌석 (좌석 번호 오름차순)
     * @param {number} o.dealer @param {number} o.sb @param {number} o.bb
     * @param {number} o.smallBlind @param {number} o.bigBlind
     * @param {boolean} [o.peek]    폴드승 뒤 남은 보드 보기를 줄지 (토너먼트는 false)
     * @param {boolean} [o.allowUnsigned]  키를 등록하지 않은 좌석의 서명 없는 액션을 받을지 (시험 전용)
     * @param {boolean} [o.strictOrder]  차례 순서를 엔진이 강제한다 — TEE 테이블 서버가 켠다. 판 기록에 남고 verify 도 같은 규칙으로 돈다
     * @param {{percent:number, minPot:number}} [o.rake]  테이블 레이크 규칙 — 판 시작 때 정해 공개한다(콘솔·파트너가 바꾸지 않는다)
     */
    constructor(o) {
        this.handId = String(o.handId);
        this.seed = o.seed;
        this.deck = o.deck.slice();
        this.next = this.deck.length - 1;     // 다음에 꺼낼 덱 위치 (끝에서부터)
        this.smallBlind = Number(o.smallBlind);
        this.bigBlind = Number(o.bigBlind);
        this.peek = !!o.peek;
        this.allowUnsigned = !!o.allowUnsigned;
        this.strictOrder = !!o.strictOrder;
        const rk = o.rake || {};
        this.rake = { percent: Number(rk.percent) || 0, minPot: Number(rk.minPot) || 0 };

        const list = [...o.seats].sort((a, b) => a.seat - b.seat);
        if (list.length < 2) throw new HandError('seats', 'at least two seats');
        this.order = list.map(s => s.seat);
        if (new Set(this.order).size !== this.order.length) throw new HandError('seats', 'duplicate seat');
        this.seats = new Map();
        for (const s of list) {
            const stack = Number(s.stack);
            if (!(stack > 0)) throw new HandError('seats', `seat ${s.seat} has no chips`);
            this.seats.set(s.seat, {
                seat: s.seat,
                odcId: String(s.odcId),
                stack,
                startStack: stack,
                currentBet: 0,
                totalHandBet: 0,
                isFolded: false,
                isAllIn: false,
                hole: [],
                sigKey: s.sigJwk ? C.importPublicJwk(s.sigJwk) : null,
            });
        }
        for (const k of ['dealer', 'sb', 'bb']) {
            if (!this.seats.has(o[k])) throw new HandError('seats', `${k} seat ${o[k]} not in hand`);
        }
        if (o.sb === o.bb) throw new HandError('seats', 'sb and bb are the same seat');
        this.dealer = o.dealer;
        this.sb = o.sb;
        this.bb = o.bb;
        // 차례 표시 — 마지막으로 차례를 쓴 좌석. 프리플랍은 BB 다음부터(헤즈업이면 딜러=SB 부터), 플랍부터는 딜러 다음부터
        this.pointer = o.bb;

        this.stage = 'preflop';
        this.pot = 0;
        this.currentBet = this.bigBlind;          // 이전 게임 서버 6단계와 같다 (BB 가 모자라 올인해도 테이블 베팅은 BB)
        this.lastRaiseAmount = this.bigBlind;
        this.acted = new Set();
        this.turns = 0;                            // 차례를 쓴 액션 수 — 서명에 들어가는 q
        this.board = [];                           // 공개된 보드의 덱 위치
        this.revealedHoles = new Set();            // 모두에게 공개된 홀카드 좌석
        this.log = [];
        this.usedNonces = new Set();
        this.result = null;

        this._postBlinds();
        this._dealHoles();
    }

    // ------------------------------------------------------------ 시작

    _postBlinds() {
        const sbP = this.seats.get(this.sb);
        const sbAmount = Math.min(sbP.stack, this.smallBlind);
        sbP.stack -= sbAmount;
        sbP.currentBet = sbAmount;
        sbP.totalHandBet = sbAmount;
        sbP.blind = sbAmount;
        this.pot += sbAmount;
        if (sbP.stack === 0) sbP.isAllIn = true;

        const bbP = this.seats.get(this.bb);
        const bbAmount = Math.min(bbP.stack, this.bigBlind);
        bbP.stack -= bbAmount;
        bbP.currentBet = bbAmount;
        bbP.totalHandBet = bbAmount;
        bbP.blind = bbAmount;
        this.pot += bbAmount;
        if (bbP.stack === 0) bbP.isAllIn = true;

        this.blinds = { sbSeat: this.sb, sbAmount, bbSeat: this.bb, bbAmount };
    }

    _pop() {
        if (this.next < 0) throw new HandError('deck', 'deck exhausted');
        return this.next--;
    }

    _dealHoles() {
        for (let round = 0; round < 2; round++) {
            for (const seat of this.order) this.seats.get(seat).hole.push(this._pop());
        }
    }

    open(index) {
        return opening(this.seed, this.handId, this.deck, index);
    }

    /** 본인만 받는 홀카드 (봉투에 넣는다) */
    holeOpenings(seat) {
        const p = this.seats.get(seat);
        return p ? p.hole.map(i => this.open(i)) : [];
    }

    // ------------------------------------------------------------ 상태

    _active() {
        return this.order.map(s => this.seats.get(s)).filter(p => !p.isFolded);
    }

    isBetting() {
        return BETTING.includes(this.stage);
    }

    /**
     * 지금 판이 어디에 있나 — 이전 게임 서버 와 같은 판단.
     *   continue    베팅이 남았다
     *   advance     이번 베팅 라운드가 끝났다 → 다음 보드
     *   showdown    리버 베팅이 끝났다
     *   runout      더 베팅할 사람이 없다 → 홀카드 공개 + 남은 보드
     *   uncontested 한 명만 남았다
     *   done / aborted
     */
    status() {
        if (this.stage === 'done' || this.stage === 'aborted') return this.stage;
        if (this.stage === 'runout') return 'showdown';
        const active = this._active();
        const betting = active.filter(p => !p.isAllIn);
        if (active.length === 1) return 'uncontested';
        if (betting.length === 0) return 'runout';
        if (betting.length === 1) {
            if (roundMoney(betting[0].currentBet) < roundMoney(this.currentBet)) return 'continue';
            return 'runout';
        }
        const allMatched = betting.every(p => roundMoney(p.currentBet) === roundMoney(this.currentBet));
        if (allMatched && betting.every(p => this.acted.has(p.seat))) {
            return this.stage === 'river' ? 'showdown' : 'advance';
        }
        return 'continue';
    }

    /**
     * 지금 차례인 좌석 — 베팅이 남았을 때(status=continue)만. 마지막 차례 좌석 다음부터 시계 방향으로,
     * 폴드·올인이 아니고 아직 행동하지 않았거나 콜할 금액이 남은 첫 좌석.
     */
    toAct() {
        if (!this.isBetting() || this.status() !== 'continue') return null;
        const n = this.order.length;
        const start = this.order.indexOf(this.pointer);
        for (let i = 1; i <= n; i++) {
            const p = this.seats.get(this.order[(start + i) % n]);
            if (p.isFolded || p.isAllIn) continue;
            if (!this.acted.has(p.seat) || roundMoney(p.currentBet) < roundMoney(this.currentBet)) return p.seat;
        }
        return null;
    }

    calculateMinRaise() {
        return this.currentBet + Math.max(this.lastRaiseAmount, this.bigBlind);
    }

    _callAmount(p) {
        const need = roundMoney(this.currentBet - p.currentBet);
        if (need <= 0) return 0;
        return Math.min(p.stack, need);
    }

    // ------------------------------------------------------------ 액션

    /**
     * 액션 하나를 받는다.
     * @param {object} e
     *   k      'act'(회원 서명) | 'pre'(미리 고른 행동) | 'rc'(레이즈 게이지 자동 레이즈) | 'host'(운영 서버 폴드·체크) | 'leave'(차례 밖 퇴장 폴드)
     *   seat, q(차례 번호 — leave 는 없음), action, amount
     *   sig    k='act' 의 회원 서명
     *   pre    k='pre' 이고 콜일 때 { p:'autoCall', nonce, sig }
     *   rc     k='rc' 의 { sig }
     *   res    운영 서버가 계산한 결과 { action, amount } — 엔진 계산과 다르면 거절한다
     *   reason 운영 서버 액션의 사유 (기록용)
     */
    apply(e) {
        if (!this.isBetting()) throw new HandError('stage', `not in a betting round (stage=${this.stage})`);
        const p = this.seats.get(Number(e.seat));
        if (!p) throw new HandError('seat', `seat ${e.seat} is not in this hand`);
        const k = String(e.k || '');

        if (k === 'leave') {
            if (p.isFolded || p.isAllIn) throw new HandError('state', 'leave: seat already folded or all-in');
            p.isFolded = true;
            const entry = { k, seat: p.seat, reason: e.reason || null, res: { action: ACTIONS.FOLD, amount: 0 } };
            this._checkRes(e, entry.res);
            this.log.push(entry);
            return { res: entry.res, status: this.status() };
        }

        if (!['act', 'pre', 'rc', 'host'].includes(k)) throw new HandError('kind', `unknown kind ${k}`);
        if (Number(e.q) !== this.turns) throw new HandError('turn', `stale turn q=${e.q} (engine ${this.turns})`);
        if (p.isFolded || p.isAllIn) throw new HandError('state', 'Invalid player state');
        if (this.strictOrder && p.seat !== this.toAct()) throw new HandError('turn', `seat ${p.seat} is not to act (seat ${this.toAct()} is)`);
        const action = String(e.action || '');
        const amount = Number(e.amount) || 0;
        const auth = this._authorize(k, p, e, action, amount);

        const res = this._resolve(p, action, amount);
        this._checkRes(e, res);
        this.turns++;
        this.pointer = p.seat;
        const entry = { k, q: Number(e.q), seat: p.seat, action, amount, res };
        if (auth) entry.auth = auth;
        if (e.reason) entry.reason = String(e.reason);
        this.log.push(entry);
        return { res, status: this.status() };
    }

    _checkRes(e, res) {
        if (!e.res) return;
        const a = String(e.res.action || '');
        const x = roundMoney(Number(e.res.amount) || 0);
        if (a !== res.action || x !== roundMoney(res.amount)) {
            throw new HandError('mismatch', `host computed ${a} ${x}, engine ${res.action} ${res.amount}`);
        }
    }

    /** 칩을 움직이는 액션에 회원 허락이 있는지 본다. 기록에 남길 허락 정보를 돌려준다 */
    _authorize(k, p, e, action, amount) {
        const moves = action === ACTIONS.CALL || action === ACTIONS.BET || action === ACTIONS.RAISE || action === ACTIONS.ALL_IN;
        const unsignedOk = this.allowUnsigned && !p.sigKey;
        switch (k) {
            case 'act': {
                if (unsignedOk && !e.sig) return { unsigned: true };
                if (!p.sigKey) throw new HandError('auth', 'no key registered for seat');
                if (!C.verify(p.sigKey, C.msgAction(this.handId, e.q, action, amount), e.sig)) throw new HandError('auth', 'bad action signature');
                return { sig: e.sig };
            }
            case 'pre': {
                if (![ACTIONS.CHECK, ACTIONS.FOLD, ACTIONS.CALL].includes(action)) throw new HandError('auth', 'pre-action can only check, fold or call');
                if (action !== ACTIONS.CALL) return null;
                const pre = e.pre || {};
                if (unsignedOk && !pre.sig) return { unsigned: true };
                if (!p.sigKey) throw new HandError('auth', 'no key registered for seat');
                if (pre.p !== 'autoCall') throw new HandError('auth', 'call needs an auto-call permission');
                const nonce = String(pre.nonce || '');
                if (!nonce || this.usedNonces.has(p.seat + ':' + nonce)) throw new HandError('auth', 'pre-action permission already used');
                if (!C.verify(p.sigKey, C.msgPreAction(this.handId, 'autoCall', nonce), pre.sig)) throw new HandError('auth', 'bad pre-action signature');
                this.usedNonces.add(p.seat + ':' + nonce);
                return { pre: { p: 'autoCall', nonce, sig: pre.sig } };
            }
            case 'rc': {
                if (action !== ACTIONS.RAISE && action !== ACTIONS.ALL_IN) throw new HandError('auth', 'raise-commit can only raise');
                const want = this._committedRaise(p);
                if (want.action !== action || roundMoney(want.amount) !== roundMoney(amount)) {
                    throw new HandError('auth', `raise-commit amount ${action} ${amount}, expected ${want.action} ${want.amount}`);
                }
                const rc = e.rc || {};
                if (unsignedOk && !rc.sig) return { unsigned: true };
                if (!p.sigKey) throw new HandError('auth', 'no key registered for seat');
                if (!C.verify(p.sigKey, C.msgRaiseCommit(this.handId, e.q), rc.sig)) throw new HandError('auth', 'bad raise-commit signature');
                return { rc: { sig: rc.sig } };
            }
            case 'host': {
                if (moves || (action !== ACTIONS.FOLD && action !== ACTIONS.CHECK)) throw new HandError('auth', 'host can only fold or check');
                return null;
            }
        }
        return null;
    }

    /** 이전 게임 서버 의 금액 — 팟의 25% 레이즈 (최소 레이즈 이상), 넘치면 올인 */
    _committedRaise(p) {
        const maxBet = p.stack + p.currentBet;
        const target = Math.max(roundMoney(this.currentBet + this.pot * 0.25), this.calculateMinRaise());
        return target >= maxBet ? { action: ACTIONS.ALL_IN, amount: 0 } : { action: ACTIONS.RAISE, amount: target };
    }

    /** 이전 게임 서버 의 액션별 처리와 같다 — 결과 액션과 실제로 낸 칩 */
    _resolve(p, action, amountIn) {
        if (!Object.values(ACTIONS).includes(action)) throw new HandError('action', 'Invalid action');
        if (action === ACTIONS.CHECK && this.currentBet > p.currentBet) throw new HandError('action', 'Cannot check, must call or fold');

        let amount = Number(amountIn);
        if (!isFinite(amount) || amount < 0) amount = 0;
        amount = roundMoney(amount);

        let betAmount = 0;
        let finalAction = action;

        switch (action) {
            case ACTIONS.FOLD:
                p.isFolded = true;
                break;

            case ACTIONS.CHECK:
                break;

            case ACTIONS.CALL:
                betAmount = this._callAmount(p);
                p.stack -= betAmount;
                p.stack = Math.max(0, p.stack);
                p.currentBet += betAmount;
                p.totalHandBet += betAmount;
                this.pot += betAmount;
                break;

            case ACTIONS.BET:
            case ACTIONS.RAISE: {
                const others = this._active().filter(o => o.seat !== p.seat);
                const raiseFacingPossible = others.some(o => !o.isAllIn && (o.stack || 0) > 0);
                if (!raiseFacingPossible) {
                    action = ACTIONS.CALL;
                    finalAction = ACTIONS.CALL;
                    betAmount = this._callAmount(p);
                    p.stack -= betAmount;
                    p.stack = Math.max(0, p.stack);
                    p.currentBet += betAmount;
                    p.totalHandBet += betAmount;
                    this.pot += betAmount;
                    break;
                }
                const minRaise = this.calculateMinRaise();
                const targetBet = amount || minRaise;
                const correctedBet = (targetBet < minRaise && p.stack + p.currentBet > minRaise) ? minRaise : targetBet;
                betAmount = Math.min(p.stack, roundMoney(correctedBet - p.currentBet));
                if (!(roundMoney(p.currentBet + Math.max(0, betAmount)) > roundMoney(this.currentBet))) {
                    const needR = roundMoney(this.currentBet - p.currentBet);
                    betAmount = needR > 0 ? Math.min(p.stack, needR) : 0;
                    action = needR <= 0 ? ACTIONS.CHECK : (betAmount >= p.stack ? ACTIONS.ALL_IN : ACTIONS.CALL);
                    finalAction = action;
                }
                p.stack -= betAmount;
                p.stack = Math.max(0, p.stack);
                p.currentBet += betAmount;
                p.totalHandBet += betAmount;
                this.pot += betAmount;
                if (roundMoney(p.currentBet) > roundMoney(this.currentBet)) {
                    this.lastRaiseAmount = p.currentBet - this.currentBet;
                    this.currentBet = p.currentBet;
                    this.acted = new Set();
                }
                break;
            }

            case ACTIONS.ALL_IN: {
                const othersAi = this._active().filter(o => o.seat !== p.seat);
                const raiseFacingPossibleAi = othersAi.some(o => !o.isAllIn && (o.stack || 0) > 0);
                if (!raiseFacingPossibleAi) {
                    betAmount = this._callAmount(p);
                    p.stack -= betAmount;
                    p.stack = Math.max(0, p.stack);
                    p.currentBet += betAmount;
                    p.totalHandBet += betAmount;
                    this.pot += betAmount;
                    finalAction = ACTIONS.CALL;
                    break;
                }
                betAmount = p.stack;
                p.currentBet += betAmount;
                p.totalHandBet += betAmount;
                p.stack = 0;
                this.pot += betAmount;
                if (p.currentBet > this.currentBet) {
                    this.lastRaiseAmount = p.currentBet - this.currentBet;
                    this.currentBet = p.currentBet;
                    this.acted = new Set();
                }
                break;
            }
        }

        if (p.stack === 0 && !p.isFolded) {
            p.isAllIn = true;
            if (action !== ACTIONS.ALL_IN) finalAction = ACTIONS.ALL_IN;
        }
        this.acted.add(p.seat);
        return { action: finalAction, amount: betAmount };
    }

    // ------------------------------------------------------------ 보드

    _resetStreet() {
        for (const p of this.seats.values()) p.currentBet = 0;
        this.currentBet = 0;
        this.lastRaiseAmount = 0;
        this.acted = new Set();
        this.pointer = this.dealer;
    }

    _dealBoard(n) {
        this._pop();   // 번 카드
        const out = [];
        for (let i = 0; i < n; i++) {
            const idx = this._pop();
            this.board.push(idx);
            out.push(idx);
        }
        return out;
    }

    /** 이번 베팅 라운드가 끝났으면 다음 보드를 깐다. 끝나지 않았으면 거절 — 미리 보드를 볼 방법이 없다 */
    advance() {
        const st = this.status();
        if (st !== 'advance') throw new HandError('reveal', `board not due (status=${st}, stage=${this.stage})`);
        this._resetStreet();
        const dealt = this._dealBoard(this.stage === 'preflop' ? 3 : 1);
        this.stage = NEXT_STAGE[this.stage];
        this.log.push({ k: 'board', stage: this.stage });
        return { stage: this.stage, cards: dealt.map(i => this.open(i)) };
    }

    /** 더 베팅할 사람이 없을 때 — 폴드하지 않은 사람 홀카드 공개 + 남은 보드 */
    runout() {
        const st = this.status();
        if (st !== 'runout') throw new HandError('reveal', `runout not due (status=${st})`);
        const holes = this._revealActiveHoles();
        const stages = [];
        while (this.board.length < 5) {
            const n = this.board.length === 0 ? 3 : 1;
            const dealt = this._dealBoard(n);
            stages.push({ stage: this.board.length === 3 ? 'flop' : (this.board.length === 4 ? 'turn' : 'river'), cards: dealt.map(i => this.open(i)) });
        }
        this.stage = 'runout';
        this.log.push({ k: 'runout' });
        return { holes, stages };
    }

    _revealActiveHoles() {
        const holes = {};
        for (const p of this._active()) {
            this.revealedHoles.add(p.seat);
            holes[p.seat] = p.hole.map(i => this.open(i));
        }
        return holes;
    }

    // ------------------------------------------------------------ 끝

    _cards(indices) {
        return indices.map(i => this.deck[i]);
    }

    /**
     * 레이크 — 소켓 서버 FeeService.settlePotRake 의 금액 계산과 같은 규칙 (2026-11-06 엔진으로 옮김).
     *   기준 = 사람마다 max(맞춘 베팅, 블라인드). 맞추지 못한 베팅(언콜)은 빼고, 블라인드는 언콜이어도 넣는다.
     *   쇼다운에서는 비긴 팟(동점 분할)을 레이크에서 뺀다(rakeBase). 최소 팟 미만이면 0.
     *   총액 = floor(기준 × 비율), 사람별 몫 = floor(기준 × 비율), 끝자리 차이는 마지막 사람이 맡는다.
     *   누가 레이크를 얼마 냈는지만 정한다. 그 레이크를 파트너·총판에게 어떻게 나누는지는 콘솔 몫이다.
     */
    _rakeFor(rakeBase) {
        const bettors = this.order.map(s => this.seats.get(s)).filter(p => p.totalHandBet > 0);
        const perSeat = bettors.map(p => {
            let maxOther = 0;
            for (const o of bettors) if (o.seat !== p.seat && o.totalHandBet > maxOther) maxOther = o.totalHandBet;
            const matched = Math.min(p.totalHandBet, maxOther);
            return { seat: p.seat, totalHandBet: p.totalHandBet, matched, uncalled: p.totalHandBet - matched, basis: Math.max(matched, p.blind || 0), fee: 0 };
        });
        const contestedPot = perSeat.reduce((s, x) => s + x.basis, 0);
        let feeBase = contestedPot;
        if (rakeBase !== undefined && rakeBase !== null) feeBase = Math.max(0, Math.min(contestedPot, Number(rakeBase)));
        const out = { percent: this.rake.percent, minPot: this.rake.minPot, contestedPot, feeBase, totalRake: 0, effectiveRate: 0, perSeat };
        if (!(this.rake.percent > 0) || feeBase <= 0 || !perSeat.length || !contestedPot || contestedPot < this.rake.minPot) return out;
        const floorTotal = floorMoney(feeBase * this.rake.percent / 100);
        if (floorTotal <= 0) return out;
        const attrRate = contestedPot > 0 ? (floorTotal / contestedPot) : 0;
        const basisSum = perSeat.reduce((s, x) => s + x.basis, 0);
        let accumulated = 0;
        for (let i = 0; i < perSeat.length; i++) {
            const x = perSeat[i];
            let fee;
            if (i === perSeat.length - 1) {
                fee = roundMoney(floorMoney(basisSum * attrRate) - accumulated);
                if (fee < 0) fee = 0;
            } else {
                fee = floorMoney(x.basis * attrRate);
            }
            accumulated = roundMoney(accumulated + fee);
            x.fee = fee;
        }
        out.totalRake = perSeat.reduce((s, x) => s + x.fee, 0);
        out.effectiveRate = feeBase > 0 ? (floorTotal / feeBase) : 0;
        return out;
    }

    /** 쇼다운 — 이전 게임 서버 의 팟 분배·레이크 차감과 같다 */
    showdown() {
        const st = this.status();
        if (st !== 'showdown') throw new HandError('reveal', `showdown not due (status=${st})`);
        const holes = this._revealActiveHoles();
        const boardCards = this._cards(this.board);
        const potPlayers = [];
        for (const seat of this.order) {
            const p = this.seats.get(seat);
            if (p.totalHandBet > 0) {
                potPlayers.push({ seat, player: { hand: this._cards(p.hole), totalHandBet: p.totalHandBet, isFolded: p.isFolded } });
            }
        }
        const winners = PotManager.calculateWinners(potPlayers, boardCards, this.pot);

        // 비긴 팟(두 명 이상이 나눈 팟)은 레이크 없음 — 한 명이 가져간 팟 금액만 레이크 기준
        const seatsByPot = new Map();
        for (const w of winners) {
            if (w.isUncalledReturn) continue;
            const idx = (typeof w.potIndex === 'number') ? w.potIndex : 0;
            if (!seatsByPot.has(idx)) seatsByPot.set(idx, new Set());
            seatsByPot.get(idx).add(w.seat);
        }
        let rakeBase = 0;
        for (const w of winners) {
            if (w.isUncalledReturn) continue;
            const idx = (typeof w.potIndex === 'number') ? w.potIndex : 0;
            if (seatsByPot.get(idx).size >= 2) w.isChop = true;
            else rakeBase += (w.amount || 0);
        }
        const rake = this._rakeFor(rakeBase);

        // 승자 몫에서 레이크를 뗀다 — 반올림 차이는 마지막 진짜 승자가 맡는다 (언콜 반환·비긴 팟은 그대로)
        //   금액이 0 인 팟의 승자는 맡지 않는다. 소수 오차(192.2 vs 192.19999…)로 생긴 0원 사이드 팟이 마지막이면
        //   남은 레이크가 음수 지급으로 잘려, 장부 레이크보다 칩에서 적게 떼였다(소켓 서버 시절부터 있던 어긋남 — 11-06 발견).
        let lastReal = -1;
        winners.forEach((w, i) => { if (!w.isUncalledReturn && !w.isChop && (w.amount || 0) > 0.0005) lastReal = i; });
        let distributed = 0;
        winners.forEach((w, i) => {
            let net;
            if (w.isUncalledReturn || w.isChop) net = w.amount || 0;
            else if (i === lastReal) net = (w.amount || 0) - (rake.totalRake - distributed);
            else {
                const share = floorMoney((w.amount || 0) * rake.effectiveRate);
                distributed += share;
                net = (w.amount || 0) - share;
            }
            if (net < 0) net = 0;
            w.net = net;
            this.seats.get(w.seat).stack += net;
        });

        const hands = this._active().map(p => {
            let handRank = null;
            if (p.hole.length === 2 && boardCards.length === 5) {
                const ev = HandEvaluator.evaluate(this._cards(p.hole), boardCards);
                handRank = ev ? (ev.description || ev.rankName) : null;
            }
            return { seat: p.seat, handRank };
        });
        this.stage = 'done';
        this.result = {
            type: 'showdown',
            pot: this.pot,
            board: boardCards,
            rake,
            winners: winners.map(w => ({
                seat: w.seat, amount: w.amount, net: w.net, potIndex: w.potIndex, isSidePot: !!w.isSidePot,
                isUncalledReturn: !!w.isUncalledReturn, isChop: !!w.isChop, potLabel: w.potLabel || null, handRank: w.handRank || null,
                winningCards: w.winningCards || null, eligibleSeats: w.eligibleSeats || null, reason: w.reason || null,
            })),
            hands,
        };
        return { holes, board: this.board.map(i => this.open(i)), result: this.result };
    }

    /** 한 명만 남았을 때 — 이전 게임 서버 의 분배·레이크 차감과 같다 */
    uncontested() {
        const st = this.status();
        if (st !== 'uncontested') throw new HandError('reveal', `not uncontested (status=${st})`);
        const winner = this._active()[0];
        const rake = this._rakeFor(null);
        const bettors = this.order.map(s => this.seats.get(s)).filter(p => p.totalHandBet > 0);
        const returns = [];
        for (const p of bettors) {
            if (p.seat === winner.seat) continue;
            let maxOther = 0;
            for (const o of bettors) if (o.seat !== p.seat && o.totalHandBet > maxOther) maxOther = o.totalHandBet;
            const uncalled = p.totalHandBet - Math.min(p.totalHandBet, maxOther);
            if (!(uncalled > 0.0005)) continue;
            const amt = roundMoney(uncalled);
            p.stack = roundMoney((Number(p.stack) || 0) + amt);
            returns.push({ seat: p.seat, amount: amt });
        }
        const returnTotal = roundMoney(returns.reduce((s, r) => s + r.amount, 0));
        const amount = roundMoney(this.pot - (Number(rake.totalRake) || 0) - returnTotal);
        winner.stack += amount;
        const peekBoard = this.peek ? this._peekBoard() : [];
        this.stage = 'done';
        this.result = { type: 'uncontested', pot: this.pot, winner: winner.seat, amount, gross: roundMoney(this.pot - returnTotal), returns, rake, board: this._cards(this.board) };
        return { result: this.result, peekBoard };
    }

    /** 이전 게임 서버 — 판이 끝난 뒤 "깔렸을 보드" (번 카드 규칙 포함) */
    _peekBoard() {
        let ccLen = this.board.length;
        if (ccLen >= 5) return [];
        let next = this.next;
        const out = [];
        const burnAndTake = (n) => {
            if (next + 1 < n + 1) return false;
            next--;
            for (let i = 0; i < n; i++) out.push(next--);
            ccLen += n;
            return true;
        };
        if (ccLen === 0 && !burnAndTake(3)) return [];
        if (ccLen === 3 && !burnAndTake(1)) return [];
        if (ccLen === 4 && !burnAndTake(1)) return [];
        return out.map(i => this.open(i));
    }

    abort(reason) {
        if (this.stage === 'done' || this.stage === 'aborted') return;
        this.stage = 'aborted';
        this.result = { type: 'aborted', reason: String(reason || ''), refunds: this.order.map(s => ({ seat: s, stack: this.seats.get(s).startStack })) };
    }

    /** 판이 끝난 뒤 공개해도 되는 전체 — 기록에 들어간다 */
    summary() {
        return {
            order: this.order,
            dealer: this.dealer, sb: this.sb, bb: this.bb,
            smallBlind: this.smallBlind, bigBlind: this.bigBlind,
            blinds: this.blinds,
            holes: Object.fromEntries(this.order.map(s => [s, this._cards(this.seats.get(s).hole)])),
            board: this._cards(this.board),
            stacksStart: Object.fromEntries(this.order.map(s => [s, this.seats.get(s).startStack])),
            stacksEnd: Object.fromEntries(this.order.map(s => [s, this.seats.get(s).stack])),
            log: this.log,
            result: this.result,
        };
    }
}

HandCore.ACTIONS = ACTIONS;
HandCore.HandError = HandError;

module.exports = HandCore;
