/**
 * Engine — 테이블·회원 키·씨앗 약속·판을 관리하고, 운영 서버(소켓 서버)의 요청을 받는다.
 *
 * 운영 서버는 이 엔진을 믿지 않아도 되고, 이 엔진도 운영 서버를 믿지 않는다:
 *   · 홀카드는 회원 브라우저 키로 잠근 봉투로만 내보낸다. 운영 서버는 봉투를 전달만 한다.
 *   · 보드·남의 홀카드는 규칙상 공개할 때가 됐을 때만 내보낸다(HandCore).
 *   · 칩이 움직이는 액션은 회원 서명이 있어야 받는다.
 *   · 판이 끝나면 씨앗·덱·액션·결과 전체를 담은 기록에 엔진 키로 서명해 내준다. 누구나 verify.js 로 다시 돌려 볼 수 있다.
 *
 * TEE 안에서 돌 때는 엔진 키가 증명서(attestation)에 묶인다 — 이 키로 서명된 기록은 "공개된 그 코드"가 만든 것이다.
 * 일반 프로세스(개발 모드)에서는 증명서가 없다(info().mode = 'dev').
 */

const crypto = require('crypto');
const C = require('./crypto');
const cards = require('./cards');
const HandCore = require('./HandCore');
const pkg = require('../package.json');

const { HandError } = HandCore;

const MAX_SEATS = 10;
const MAX_ID_LEN = 64;
const MAX_MONEY = 1e12;

/** 유한한 양수이고 최소 단위(0.001) 아래 자리가 없는 금액 */
function validMoney(v) {
    const n = Number(v);
    return Number.isFinite(n) && n > 0 && n < MAX_MONEY && Math.abs(Math.round(n * 1000) - n * 1000) < 1e-6;
}

/** 판 하나가 이 시간 넘게 움직이지 않으면 버린다 (운영 서버가 죽은 경우) */
const HAND_IDLE_MS = 30 * 60 * 1000;
const TABLE_IDLE_MS = 6 * 60 * 60 * 1000;

class Engine {
    /**
     * @param {object} [opts]
     * @param {boolean} [opts.allowUnsigned]  키 없는 좌석의 서명 없는 액션·평문 카드 허용 (시험 전용 — 운영에서 켜지 말 것)
     * @param {string} [opts.mode]            'dev' | 'nitro' …  증명서 종류
     * @param {function} [opts.attest]        (publicKeys) => 증명서. TEE 에서만 준다
     */
    constructor(opts = {}) {
        this.allowUnsigned = !!opts.allowUnsigned;
        this.mode = opts.mode || 'dev';
        // RULES.md 2장 — 검사를 느슨하게 하는 시험 설정은 개발 모드에서만. TEE(운영) 모드에서 켜려 하면 뜨지 않는다.
        if (this.allowUnsigned && this.mode !== 'dev') throw new Error('allowUnsigned is only allowed in dev mode');
        this.attest = typeof opts.attest === 'function' ? opts.attest : null;
        this.sigKeys = C.generateKeyPair();
        this.ecdhKeys = C.generateKeyPair();
        this.sigJwk = C.publicJwk(this.sigKeys.publicKey);
        this.ecdhJwk = C.publicJwk(this.ecdhKeys.publicKey);
        this.startedAt = Date.now();
        this.tables = new Map();
        this.hands = new Map();
    }

    // ------------------------------------------------------------ 공개 정보

    info() {
        const keys = { sig: this.sigJwk, ecdh: this.ecdhJwk, sigFp: C.fingerprint(this.sigJwk), ecdhFp: C.fingerprint(this.ecdhJwk) };
        return {
            name: pkg.name,
            version: pkg.version,
            mode: this.mode,
            startedAt: this.startedAt,
            allowUnsigned: this.allowUnsigned,
            keys,
            attestation: this.attest ? this.attest(keys) : null,
        };
    }

    _signRecord(record) {
        return C.sign(this.sigKeys.privateKey, C.stableStringify(record));
    }

    // ------------------------------------------------------------ 테이블

    openTable({ meta } = {}) {
        this._gc();
        if (this.tables.size >= 5000) throw new HandError('busy', 'too many tables');
        const tableId = 't_' + crypto.randomBytes(9).toString('base64url');
        const seed = cards.newSeed();
        this.tables.set(tableId, {
            id: tableId,
            meta: meta && typeof meta === 'object' ? { roomId: String(meta.roomId || '').slice(0, 32) } : null,
            seed,
            seedCommit: cards.seedCommitOf(seed),
            entropy: new Map(),        // odcId → { hex, sig } (지금 씨앗 약속에 묶인 값)
            keys: new Map(),           // odcId → { sig, ecdh, sigKey, ecdhKey, sigFp, ecdhFp }
            handNo: 0,
            liveHandId: null,
            usedAt: Date.now(),
        });
        this._gc();
        return { tableId, seedCommit: cards.seedCommitOf(seed) };
    }

    _table(tableId) {
        const t = this.tables.get(String(tableId));
        if (!t) throw new HandError('table', 'unknown table');
        t.usedAt = Date.now();
        return t;
    }

    closeTable({ tableId }) {
        const t = this.tables.get(String(tableId));
        if (!t) return { ok: true };
        if (t.liveHandId) this.abortHand({ handId: t.liveHandId, reason: 'table closed' });
        this.tables.delete(t.id);
        return { ok: true };
    }

    /**
     * 회원 키 등록. 회원이 자기 서명 키로 "이 테이블에 이 두 키를 쓴다"에 서명해야 한다.
     * 키는 판을 시작할 때 고정된다 — 판 도중에 (운영 서버가) 키를 바꿔 끼워도 그 판의 홀카드 봉투·서명 확인은 처음 키 그대로라
     * 가로챌 것이 없다. 바뀐 키는 다음 판부터 쓰이고, 엔진 확인 서명이 화면에 가므로 회원은 자기 키가 아니면 알아챈다.
     */
    registerKeys({ tableId, odcId, sig, ecdh, proof }) {
        const t = this._table(tableId);
        const id = String(odcId);
        if (!id || id.length > MAX_ID_LEN) throw new HandError('input', 'bad player id');
        if (t.keys.size >= 500 && !t.keys.has(id)) throw new HandError('input', 'too many keys on this table');
        const sigKey = C.importPublicJwk(sig);
        const ecdhKey = C.importPublicJwk(ecdh);
        const sigFp = C.fingerprint(sig);
        const ecdhFp = C.fingerprint(ecdh);
        if (!C.verify(sigKey, C.msgRegister(t.id, id, sigFp, ecdhFp), proof)) throw new HandError('auth', 'bad registration proof');
        const prev = t.keys.get(id);
        const changed = !prev || prev.sigFp !== sigFp || prev.ecdhFp !== ecdhFp;
        // 진행 중인 판은 판을 시작할 때의 키를 그대로 쓴다(HandCore 가 좌석별로 들고 있고, 봉투도 그때 잠겼다).
        // 그래서 판 도중에 키가 바뀌어도 그 판의 카드·서명에는 아무 영향이 없다 — 새 키는 다음 판부터다.
        t.keys.set(id, { sig: C.publicJwk(sigKey), ecdh: C.publicJwk(ecdhKey), sigKey, ecdhKey, sigFp, ecdhFp });
        return {
            ok: true, changed, sigFp, ecdhFp,
            confirm: C.sign(this.sigKeys.privateKey, C.msgKeyConfirm(t.id, id, sigFp, ecdhFp)),
            seedCommit: t.seedCommit,
        };
    }

    /** 다음 판 섞기에 보탤 회원 무작위 값 — 지금 씨앗 약속에 서명으로 묶여 있어야 받는다 */
    addEntropy({ tableId, odcId, seedCommit, hex, sig }) {
        const t = this._table(tableId);
        const id = String(odcId);
        if (String(seedCommit) !== t.seedCommit) throw new HandError('stale', 'entropy is for another seed commit');
        if (!/^[0-9a-f]{32,128}$/.test(String(hex || ''))) throw new HandError('entropy', 'entropy must be 16..64 bytes hex');
        const k = t.keys.get(id);
        if (!k) throw new HandError('auth', 'no key registered');
        if (!C.verify(k.sigKey, C.msgEntropy(t.id, t.seedCommit, hex), sig)) throw new HandError('auth', 'bad entropy signature');
        t.entropy.set(id, { hex: String(hex), sig: String(sig) });
        return { ok: true };
    }

    // ------------------------------------------------------------ 판

    /**
     * 새 판. 운영 서버가 좌석·스택·버튼 위치를 넘긴다. 엔진이 블라인드를 걷고 카드를 나눈다.
     * @returns 판 번호, 공개 약속, 좌석별 홀카드 봉투, 다음 판 씨앗 약속
     */
    startHand({ tableId, handNo, seats, dealer, sb, bb, smallBlind, bigBlind, peek, rake }) {
        const t = this._table(tableId);
        if (t.liveHandId) {
            const live = this.hands.get(t.liveHandId);
            if (live && live.core.stage !== 'done' && live.core.stage !== 'aborted') throw new HandError('busy', 'previous hand is still running');
        }
        // RULES.md 5장 — 운영 서버가 보낸 값은 전부 의심한다
        if (!Array.isArray(seats) || seats.length < 2 || seats.length > MAX_SEATS) throw new HandError('input', 'seats must be 2..10');
        const list = seats.map(s => ({ seat: Number(s && s.seat), odcId: String(s && s.odcId), stack: Number(s && s.stack) }));
        for (const s of list) {
            if (!Number.isInteger(s.seat) || s.seat < 0 || s.seat >= MAX_SEATS) throw new HandError('input', 'bad seat');
            if (!s.odcId || s.odcId.length > MAX_ID_LEN) throw new HandError('input', 'bad player id');
            if (!validMoney(s.stack)) throw new HandError('input', 'bad stack');
        }
        if (new Set(list.map(s => s.odcId)).size !== list.length) throw new HandError('input', 'same player twice');
        if (!validMoney(smallBlind) || !validMoney(bigBlind) || Number(smallBlind) >= Number(bigBlind)) throw new HandError('input', 'bad blinds');
        // 레이크는 테이블 규칙 — 0~20%, 최소 팟 0 이상. 판 기록에 그대로 남아 누구나 확인한다
        const rakeRule = { percent: Number(rake && rake.percent) || 0, minPot: Number(rake && rake.minPot) || 0 };
        if (!(rakeRule.percent >= 0 && rakeRule.percent <= 20) || !(rakeRule.minPot >= 0 && rakeRule.minPot < MAX_MONEY)) throw new HandError('input', 'bad rake rule');
        // 키가 없는 좌석(접속 안 한 토너먼트 참가자 등)도 판에는 들어간다 — 카드는 아무에게도 안 나가고(봉투 없음),
        // 칩이 나가는 액션은 서명이 없으니 할 수 없다. 운영 서버가 대신 할 수 있는 건 체크·폴드뿐이다.
        for (const s of list) {
            const k = t.keys.get(s.odcId);
            s.sigJwk = k ? k.sig : null;
        }

        t.handNo += 1;
        const handId = t.id + '.' + t.handNo;
        const seed = t.seed;
        const seedCommit = t.seedCommit;
        const entropy = [];
        for (const s of list) {
            const e = t.entropy.get(s.odcId);
            if (e) entropy.push({ seat: s.seat, odcId: s.odcId, hex: e.hex, sig: e.sig });
        }
        const deck = cards.shuffledDeck(seed, handId, entropy);
        const { commitments, deckCommit } = cards.commitDeck(seed, handId, deck);

        const core = new HandCore({
            handId, seed, deck, seats: list, dealer: Number(dealer), sb: Number(sb), bb: Number(bb),
            smallBlind, bigBlind, peek: !!peek, allowUnsigned: this.allowUnsigned, rake: rakeRule,
        });

        // 다음 판 씨앗은 지금 정해 약속만 알린다 — 이번 판 동안 회원들이 그 약속에 무작위 값을 보탠다
        t.seed = cards.newSeed();
        t.seedCommit = cards.seedCommitOf(t.seed);
        t.entropy = new Map();
        t.liveHandId = handId;

        const envelopes = {};
        for (const s of list) {
            const k = t.keys.get(s.odcId);
            const payload = { h: handId, seat: s.seat, cards: core.holeOpenings(s.seat) };
            if (k) envelopes[s.seat] = C.sealEnvelope(this.ecdhKeys.privateKey, k.ecdhKey, handId, payload);
            else if (this.allowUnsigned) envelopes[s.seat] = { v: 0, plain: payload };   // dev 시험 전용 평문
            else envelopes[s.seat] = null;                                                // 키 없음 — 카드는 엔진 안에만
        }

        this.hands.set(handId, {
            table: t, core, handNo: Number(handNo) || t.handNo, seedCommit, entropy, deckCommit, commitments,
            startedAt: Date.now(), usedAt: Date.now(),
            keys: Object.fromEntries(list.map(s => [s.seat, t.keys.get(s.odcId) ? { sig: t.keys.get(s.odcId).sig, ecdh: t.keys.get(s.odcId).ecdh } : null])),
        });
        this._gc();
        return {
            handId,
            seedCommit,
            deckCommit,
            commitments,
            entropySeats: entropy.map(e => e.seat),
            blinds: core.blinds,
            rake: core.rake,
            envelopes,
            nextSeedCommit: t.seedCommit,
            turn: core.turns,
        };
    }

    _hand(handId) {
        const h = this.hands.get(String(handId));
        if (!h) throw new HandError('hand', 'unknown hand');
        h.usedAt = Date.now();
        return h;
    }

    act({ handId, entry }) {
        const h = this._hand(handId);
        const r = h.core.apply(entry || {});
        return { ok: true, res: r.res, status: r.status, turn: h.core.turns };
    }

    /** 다음 보드 — 이번 베팅 라운드가 규칙대로 끝났을 때만 */
    board({ handId }) {
        const h = this._hand(handId);
        const r = h.core.advance();
        return { ok: true, stage: r.stage, cards: r.cards, status: h.core.status(), turn: h.core.turns };
    }

    runout({ handId }) {
        const h = this._hand(handId);
        return { ok: true, ...h.core.runout() };
    }

    /** 쇼다운 또는 폴드승으로 판을 끝낸다. 결과와 서명된 판 기록을 함께 준다 */
    finish({ handId }) {
        const h = this._hand(handId);
        const st = h.core.status();
        let out;
        if (st === 'showdown') {
            const r = h.core.showdown();
            out = { type: 'showdown', holes: r.holes, board: r.board, result: r.result };
        } else if (st === 'uncontested') {
            const r = h.core.uncontested();
            out = { type: 'uncontested', result: r.result, peekBoard: r.peekBoard };
        } else {
            throw new HandError('finish', `hand cannot finish now (status=${st})`);
        }
        const { record, sig } = this._closeHand(h);
        return { ok: true, ...out, record, sig };
    }

    abortHand({ handId, reason }) {
        const h = this.hands.get(String(handId));
        if (!h) return { ok: true, missing: true };
        if (h.core.stage === 'done') return { ok: false, error: 'hand already finished' };
        h.core.abort(reason || 'aborted');
        const { record, sig } = this._closeHand(h);
        return { ok: true, record, sig };
    }

    _closeHand(h) {
        const s = h.core.summary();
        const record = {
            v: 1,
            engine: { name: pkg.name, version: pkg.version, mode: this.mode, sigFp: C.fingerprint(this.sigJwk) },
            tableId: h.table.id,
            handId: h.core.handId,
            handNo: h.handNo,
            startedAt: h.startedAt,
            endedAt: Date.now(),
            seats: s.order.map(seat => ({ seat, odcId: h.core.seats.get(seat).odcId, keys: h.keys[seat] })),
            seed: h.core.seed,
            seedCommit: h.seedCommit,
            entropy: h.entropy,
            deck: h.core.deck,
            deckCommit: h.deckCommit,
            dealer: s.dealer, sb: s.sb, bb: s.bb, smallBlind: s.smallBlind, bigBlind: s.bigBlind, peek: h.core.peek, rake: h.core.rake,
            allowUnsigned: h.core.allowUnsigned,
            blinds: s.blinds,
            holes: s.holes,
            board: s.board,
            stacksStart: s.stacksStart,
            stacksEnd: s.stacksEnd,
            log: s.log,
            result: s.result,
            nextSeedCommit: h.table.seedCommit,
        };
        if (h.table.liveHandId === h.core.handId) h.table.liveHandId = null;
        this.hands.delete(h.core.handId);
        return { record, sig: this._signRecord(record) };
    }

    _gc() {
        const now = Date.now();
        for (const [id, h] of this.hands) {
            if (now - h.usedAt > HAND_IDLE_MS) {
                if (h.table.liveHandId === id) h.table.liveHandId = null;
                this.hands.delete(id);
            }
        }
        for (const [id, t] of this.tables) {
            if (now - t.usedAt > TABLE_IDLE_MS && !t.liveHandId) this.tables.delete(id);
        }
    }

    /**
     * RPC 진입점 — 서버(server.js)와 같은 프로세스 연결(소켓 서버 시험) 둘 다 이걸 부른다.
     * 오류는 던지지 않고 { ok:false, error, code } 로 돌려준다.
     */
    call(method, params) {
        const fn = Engine.METHODS[method];
        if (!fn) return { ok: false, code: 'method', error: `unknown method ${method}` };
        try {
            const r = this[fn](params || {});
            return r && r.ok === undefined ? { ok: true, ...r } : r;
        } catch (e) {
            return { ok: false, code: e.code || 'error', error: e.message };
        }
    }
}

Engine.METHODS = {
    info: 'info',
    openTable: 'openTable',
    closeTable: 'closeTable',
    registerKeys: 'registerKeys',
    addEntropy: 'addEntropy',
    startHand: 'startHand',
    act: 'act',
    board: 'board',
    runout: 'runout',
    finish: 'finish',
    abortHand: 'abortHand',
};

module.exports = Engine;
