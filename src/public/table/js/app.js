/**
 * BUY-IN 테이블 화면 — TEE 가 직접 내보내고, TEE 하고만 이야기한다.
 *
 *   주소 조각 #t=<좌석표> → POST /table/join → SSE /table/events → POST /table/cmd
 *   내 홀카드는 내 브라우저 키로만 열리는 봉투로 오고, 판 시작 때 공개된 카드 약속과 맞춰 본다.
 *   액션·무작위 값은 내 서명 키로 서명해 보낸다 — 운영 서버는 이 흐름 어디에도 끼지 않는다.
 *
 * 화면 배치는 운영 게임 테이블에서 잰 값(좌석 위치·역할별 보정·칩 자리)을 그대로 쓴다.
 */
import * as V from './vault.js';
import { t, tn, setLang, applyStatic, getLang } from './i18n.js';
import { liveHandName, prettyRank, bigHandName } from './hand.js';

/** 디자인 리소스(배경·칩·아바타·딜러·카드 뒷면·글꼴)는 콘솔 리소스 서버에서 받는다 — 그림만 받고 아무것도 보내지 않는다.
 *  어떤 그림을 부르는지는 카드와 무관하다(칩은 공개된 베팅 금액, 카드 앞면은 글자로 그린다). CSP 가 이 주소의 그림·글꼴만 허용한다(table/http.js). */
const ASSET = 'https://resource.buyinholdem.com/buyin-table/';
/** 리소스를 바꿔 끼우면 이 값을 올린다 — 브라우저에 남은 예전 그림 대신 바로 새로 받는다 */
const AV = '?v=20261109';

const $ = (s, r = document) => r.querySelector(s);
const el = (tag, cls, html) => { const e = document.createElement(tag); if (cls) e.className = cls; if (html !== undefined) e.innerHTML = html; return e; };
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = (n) => { const v = Math.round((Number(n) || 0) * 1000) / 1000; return v.toLocaleString('en-US', { maximumFractionDigits: 3 }); };
/** 화면 금액 — 좌석표의 표시 환산(예: 칩 USDT → 원화). 게임 금액은 그대로 */
const rate = () => (S.me && S.me.display && S.me.display.rate) || 1;
const cur = () => (S.me && S.me.display && S.me.display.currency) || '';
const shown = (n) => { const v = (Number(n) || 0) * rate(); return rate() >= 10 ? Math.round(v) : Math.round(v * 100) / 100; };
const dm = (n) => fmt(shown(n));
const compact = (n) => { const v = shown(n); return v >= 10000 ? (Math.round(v / 10) / 100) + 'k' : fmt(v); };
const dmCur = (n) => `${compact(n)}${cur() ? ' ' + cur() : ''}`;

// ------------------------------------------------------------ 배치 (운영 테이블에서 잰 값)

/** PC 9석 기준 위치 — 메인 영역(가로 W, 세로 H) 비율 + px */
const PC_POS = [
    [[47, 55], [84, 20]], [[22, -35], [81, 20]], [[7, 45], [55, 0]], [[17, 15], [30, 0]], [[37, 15], [22, 7]],
    [[63, -5], [22, 8]], [[81, 0], [30, 0]], [[91, 0], [55, 0]], [[78, 0], [81, 20]],
];
const MOBILE_POS = [
    [[50, 0], [78, 0]], [[12, -3], [76, -120]], [[12, -3], [57, -75]], [[12, -3], [33, -5]], [[32, 0], [20, 10]],
    [[66, 0], [20, 10]], [[86, 3], [33, -5]], [[86, 3], [57, -75]], [[86, 3], [76, -120]],
];
/** 영웅이 아닌 좌석의 역할별 보정(px) */
const PC_ROLE_ADJ = { 1: [40, -60], 2: [0, -20], 3: [30, -60], 7: [0, -20], 8: [-30, -60] };
const PC_ROLE_ADJ_DEFAULT = [0, -60];
const ROLE_11 = [0, 1, 2, 2, 3, 4, 5, 6, 7, 7, 8];
/** 11석 위치(lib/seat-layout DESKTOP_SEAT_POSITIONS_11 과 같은 값) */
const PC_POS_11 = [
    [[47, 55], [84, 20]], [[22, -35], [81, 20]], [[7, 45], [62, 0]], [[7, 45], [42, 0]], [[17, 15], [26, 0]], [[37, 15], [22, 7]],
    [[63, -5], [22, 8]], [[81, 0], [26, 0]], [[91, 0], [42, 0]], [[91, 0], [62, 0]], [[78, 0], [81, 20]],
];
const POT_CENTER = [50, 38];

// ------------------------------------------------------------ 상태

const S = {
    ticket: '', token: '', keys: null, engine: null, att: 'checking', snap: null,
    room: null, tableId: '', me: null, seats: [], hand: null, turn: null,
    hole: null, holeOk: null, holeHandId: '', reveal: {}, bubbles: {}, winners: null,
    entropySentFor: '', sound: true, layout: 'pc', es: null, retry: 0, timerTick: null, raiseVal: 0,
    chat: [], tbUsed: '', chatAt: 0,
    // [TABLE_PARITY_2026_11_09] 예전 화면과 맞춘 것
    anim: {}, raising: null, raisingSent: '', preAct: '', emoteHand: '', tipGift: '', darkNext: false, darkHand: '',
    rabbit: null, banner: '', vol: 1, live: false, fire: new Map(), seen: {},
    // [SHOWDOWN_SEQ_0_10_4] 쇼다운 순차 공개 — sd: { handId, at:{좌석:여는 시각}, winAt, ranks } / 그동안 온 좌석 갱신은 sdQ 에 모았다가 승자 때
    sd: null, sdQ: [],
    // [BUYIN_UNITS_0_10_4] 「바이인 완료」를 처음 본 시각 — 자리·이름·합계마다 한 번만 띄운다
    rbSeen: {},
};
try { const v = Number(localStorage.getItem('buyin.vol')); if (v >= 0 && v <= 1 && localStorage.getItem('buyin.vol') !== null) S.vol = v; } catch (_e) { /* */ }
/** 다시 그려도 연출이 처음부터 다시 돌지 않게 — 시작 시각을 기억해 두고 남은 만큼만 돈다(음수 animation-delay) */
function animDelay(key, delaySec = 0) {
    if (!(key in S.anim)) S.anim[key] = Date.now() + delaySec * 1000;
    return ((S.anim[key] - Date.now()) / 1000).toFixed(3) + 's';
}
function animAge(key) { return key in S.anim ? (Date.now() - S.anim[key]) / 1000 : Infinity; }

// ------------------------------------------------------------ 카드

const SUIT = { s: '♠', h: '♥', d: '♦', c: '♣' };
/** 결과 때 이긴 다섯 장은 빛나게, 나머지는 흐리게 */
function winLook(code) {
    const w = S.winners && S.winners.cards;
    if (!w || !w.size || !code) return {};
    return w.has(code) ? { glow: true } : { dim: true };
}
function cardEl(code, opts = {}) {
    if (!code) { const b = el('div', 'card back'); return b; }
    const r = code[0] === 'T' ? '10' : code[0], s = code[1];
    const red = s === 'h' || s === 'd';
    const c = el('div', `card ${red ? 'red' : 'black'} ${s}${opts.dim ? ' dim' : ''}${opts.glow ? ' glow' : ''}${r === '10' ? ' ten' : ''}`);
    c.innerHTML = `<div class="corner"><span class="rank">${r}</span><span class="pip">${SUIT[s]}</span></div><span class="big">${SUIT[s]}</span>`;
    c.dataset.card = code;
    return c;
}
const codeOf = (x) => (typeof x === 'string' ? x : x && x.c) || null;
/** 앞뒤가 있는 카드 — cls(in-pc·in-m·river·fast·deal) 연출을 key 시각부터 이어서 돈다. 다 돈 뒤엔 앞면만 */
function flipEl(code, opts, key, cls, delaySec, durSec) {
    if (!cls || animAge(key) - delaySec > durSec + 0.2) return cardEl(code, opts);
    const f = el('div', 'flip ' + cls);
    f.style.animationDelay = animDelay(key, delaySec);
    f.appendChild(cardEl(code, opts));
    const b = cardEl(null); b.classList.add('bf'); f.appendChild(b);
    return f;
}

// ------------------------------------------------------------ 시작

async function boot() {
    const qs = new URLSearchParams(location.hash.slice(1));
    setLang(qs.get('lang') || navigator.language.slice(0, 2));
    applyStatic();
    S.ticket = qs.get('t') || sessionStorage.getItem('buyin.ticket') || '';
    if (history.replaceState) history.replaceState(null, '', location.pathname);   // 주소창·기록에 좌석표를 남기지 않는다
    layoutMode();
    addEventListener('resize', () => { layoutMode(); render(); });
    wireButtons();
    checkEngine();

    // [REBUY_0_10_2] 주소에 새 좌석표가 있으면 그것으로 앉는다 — 이 탭에 남은 예전 자리 토큰(재바이인 전 정산된 자리)은 버린다
    if (qs.get('t')) sessionStorage.removeItem('buyin.token');
    const saved = sessionStorage.getItem('buyin.token');
    if (saved) { S.token = saved; return listen(); }
    if (!S.ticket) return gate(t('noTicket'), true);
    gate(t('joining'));
    try {
        // 좌석표의 회원 ID 로 이 브라우저의 키를 꺼내 입장에 서명한다(같은 회원의 새 세션 판단에 쓴다)
        const body = JSON.parse(new TextDecoder().decode(V.fromB64u(S.ticket.split('.')[0])));
        S.keys = await V.loadKeys(String(body.player.odcId));
        const auth = { sig: S.keys.sigJwk, proof: await V.sign(S.keys, V.msg.join(body.tid, S.keys.sigFp)) };
        const r = await post('/table/join', { ticket: S.ticket, auth });
        if (!r.ok && r.code === 'replaced') {   // 같은 회원의 이전 접속을 정리하는 중 — 정산되면 이 좌석표로 다시 앉는다
            gate(t('replaced'));
            if ((S.retry = (S.retry || 0) + 1) <= 30) setTimeout(boot, 3000);
            return;
        }
        if (!r.ok) return gate(r.error || 'join failed');
        S.token = r.token; S.tableId = r.tableId;
        sessionStorage.setItem('buyin.token', r.token);
        sessionStorage.removeItem('buyin.ticket');
        listen();
    } catch (e) { gate(String(e.message || e)); }
}

async function post(path, body) {
    const res = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), cache: 'no-store' });
    const j = await res.json().catch(() => ({ ok: false, error: 'bad response' }));
    if (res.status === 401) { sessionStorage.removeItem('buyin.token'); }
    return j;
}
const cmd = (type, m = {}) => post('/table/cmd', { token: S.token, type, ...m });

/** 엔진이 TEE 하드웨어 증명서에 묶인 키를 쓰는지 — 화면이 스스로 확인한다 */
async function checkEngine() {
    try {
        const info = await (await fetch('/info', { cache: 'no-store' })).json();
        S.engine = info.keys;
        S.att = await V.checkAttestation(info);
    } catch (_e) { S.att = 'none'; }
    renderBadge();
}

/**
 * 이벤트 흐름 — fetch 스트림으로 SSE 를 읽는다. 좌석 토큰은 Authorization 헤더로만 보낸다(주소에 싣지 않는다).
 * 끊기면 잠시 뒤 다시 붙는다(snapshot 이 지금 상태를 다시 준다).
 */
function sseStream(token) {
    const handlers = new Map();
    const ctl = new AbortController();
    let closed = false;
    const es = { addEventListener: (ev, f) => handlers.set(ev, f), close: () => { closed = true; ctl.abort(); }, onopen: null };
    (async function run(delay) {
        if (delay) await new Promise((r) => setTimeout(r, delay));
        if (closed) return;
        try {
            const res = await fetch('/table/events', { headers: { Authorization: 'Bearer ' + token }, cache: 'no-store', signal: ctl.signal });
            if (es.onopen) es.onopen();
            const reader = res.body.getReader(), dec = new TextDecoder();
            let buf = '';
            for (;;) {
                const { value, done } = await reader.read();
                if (done) break;
                buf += dec.decode(value, { stream: true });
                let i;
                while ((i = buf.indexOf('\n\n')) >= 0) {
                    const block = buf.slice(0, i); buf = buf.slice(i + 2);
                    const ev = (block.match(/^event: (.*)$/m) || [])[1], data = (block.match(/^data: (.*)$/m) || [])[1];
                    const f = ev && handlers.get(ev);
                    if (f && data) f({ data });
                }
            }
        } catch (_e) { /* 끊김 — 아래에서 다시 */ }
        if (!closed) run(1500);
    })(0);
    return es;
}

function listen() {
    if (S.es) S.es.close();
    const es = S.es = sseStream(S.token);
    const on = (ev, f) => es.addEventListener(ev, (e) => { try { f(JSON.parse(e.data)); } catch (err) { console.error(ev, err); } });
    on('snapshot', onSnapshot);
    on('seat', (d) => {
        // [SHOWDOWN_SEQ_0_10_4] 카드를 여는 동안 온 좌석 갱신(칩·올인 딱지)은 승자 표시 때 — 결과를 먼저 알려 주지 않는다
        if (sdBusy()) { S.sdQ.push(d); return; }
        applySeat(d); render();
    });
    on('hand', onHand);
    on('hole', (d) => openHole(d));
    on('turn', (d) => {
        const fresh = !S.turn || S.turn.handId !== d.handId || S.turn.q !== d.q;
        S.turn = d; if (S.hand) { S.hand.toAct = d.seat; S.hand.q = d.q; }
        if (S.raising && S.raising.seat !== d.seat) S.raising = null;
        if (fresh && d.seat === mySeat()) {
            play('turn');
            if (S.preAct && S.hand && S.preAct === S.hand.handId) {   // 예약해 둔 체크/폴드 — 체크할 수 있으면 체크, 아니면 폴드
                S.preAct = '';
                const auto = d.toCall > 0 ? 'FOLD' : 'CHECK';
                setTimeout(() => act(auto), 150);
            }
        }
        render();
    });
    on('action', onAction);
    on('board', (d) => {
        if (!S.hand) return;
        checkPublic(d.handId, d.cards);
        markBoard(d.handId, S.hand.board.length, d.cards.length, false);
        S.hand.board.push(...d.cards); S.hand.stage = d.stage; clearBets(); play('card');
        if (S.tipGift && d.stage !== 'preflop') endTipPick();
        render();
    });
    on('raising', (d) => { S.raising = d.active ? { seat: d.seat, q: d.q } : null; render(); });
    on('dark', (d) => { S.darkNext = !!d.reserved; paintDark(); render(); });
    on('emote', showEmote);
    on('tip', (d) => { flyGift(d.from, d.to, d.type, d.amount); });
    on('tip-done', (d) => {
        for (const [seat, st] of Object.entries(d.stacks || {})) if (S.seats[seat]) S.seats[seat].stack = st;
        tipBadge(d.to, d.amount, t('tipDone'));
        render();
    });
    on('tip-cancel', (d) => { if (d.from === mySeat()) toast(t('tipCancel')); });
    on('chat', onChat);
    on('timebank', (d) => {
        if (d.seat === mySeat() && S.me) { S.me.timeBank = d.left; if (S.turn) S.tbUsed = S.turn.handId + ':' + S.turn.q; }
        floatTag(d.seat, '+' + Math.round(d.addedMs / 1000) + 's');
        render();
    });
    on('runout', onRunout);
    on('result', onResult);
    on('aborted', () => { S.hand = null; S.turn = null; S.sd = null; flushSeats(); render(); });
    on('settled', (d) => { sessionStorage.removeItem('buyin.token'); es.close(); gate(`${t('settled')} ${dmCur(d.cashOut)}`, true); });
    on('error', (d) => { if (d && d.code === 'auth') { sessionStorage.removeItem('buyin.token'); es.close(); gate(t('noTicket')); } else if (d && d.error) toast(d.error); });
    es.onopen = () => { S.retry = 0; };
}

// ------------------------------------------------------------ 이벤트

async function onSnapshot(d) {
    S.snap = d; S.room = d.room; S.tableId = d.tableId; S.me = d.me; S.seats = d.seats; S.engine = S.engine || d.engine;
    S.hand = d.hand ? { ...d.hand, board: [...d.hand.board] } : null;
    S.turn = d.turn; S.reveal = (d.hand && d.hand.reveal) || {};
    S.darkNext = !!d.me.darkNext;
    if (S.hand && (S.hand.dark || []).includes(d.me.seat)) S.darkHand = S.hand.handId;
    for (let k = 0; k < (S.hand ? S.hand.board.length : 0); k++) S.anim[`b:${S.hand.handId}:${k}`] = 0;   // 들어올 때 이미 깔린 카드는 연출 없이
    paintRoomLabel(); paintDark();
    hideGate();
    if (!d.me.keys || !S.keys || !S.keys.sigJwk) await registerKeys();
    if (d.hole && d.hole.envelope) await openHole(d.hole);
    await sendEntropy(d.hand ? d.hand.nextSeedCommit : d.seedCommit);
    S.live = true;   // 이제부터 오는 이벤트는 실시간 — 연출을 한다
    preloadPickImages();
    render();
}

async function registerKeys() {
    S.keys = await V.loadKeys(S.me.odcId || ('seat' + S.me.seat));
    const odcId = S.me.odcId;
    const proof = await V.sign(S.keys, V.msg.register(S.tableId, odcId, S.keys.sigFp, S.keys.ecdhFp));
    const r = await cmd('keys', { sig: S.keys.sigJwk, ecdh: S.keys.ecdhJwk, proof });
    if (!r.ok) return toast(r.error || 'key registration failed');
    // 엔진이 "이 두 키를 받았다"에 서명했나 — 운영 쪽이 키를 바꿔 끼우면 여기서 걸린다
    const okConfirm = S.engine && await V.verify(S.engine.sig, V.msg.keyConfirm(S.tableId, odcId, S.keys.sigFp, S.keys.ecdhFp), r.confirm);
    if (!okConfirm) S.att = 'mismatch';
    S.me.keys = true;
    renderBadge();
}

async function sendEntropy(seedCommit) {
    if (!seedCommit || !S.keys || S.entropySentFor === seedCommit) return;
    S.entropySentFor = seedCommit;
    const hex = V.randomHex(32);
    const sig = await V.sign(S.keys, V.msg.entropy(S.tableId, seedCommit, hex));
    const r = await cmd('entropy', { seedCommit, hex, sig });
    if (!r.ok && r.code !== 'stale') console.warn('entropy', r.error);
}

function onHand(h) {
    flushSeats();   // [SHOWDOWN_SEQ_0_10_4] 지난 판 연출 중에 모아 둔 좌석 갱신
    S.sd = null;
    S.hand = { ...h, board: [...h.board] };
    S.turn = null; S.reveal = {}; S.bubbles = {}; S.winners = null; S.hole = null; S.holeOk = null;
    S.raising = null; S.preAct = ''; S.rabbit = null; endTipPick();
    S.anim = {};   // 지난 판 연출 시각은 버린다
    if ((h.dark || []).includes(mySeat())) { S.darkHand = h.handId; S.darkNext = false; paintDark(); }
    for (const p of h.seats) {
        if (S.seats[p.seat]) S.seats[p.seat].stack = p.stack;
        if (p.bet > 0) S.bubbles[p.seat] = { a: 'BLIND', amt: p.bet, at: Date.now() };
    }
    sendEntropy(h.nextSeedCommit);
    paintRoomLabel();
    showBanner('GAME START', 2000); play('start'); play('card');
    render();
    dealFx(h);
}

/** 새로 깔린 보드 카드의 연출 — 플랍은 0.3초 간격, 턴은 바로, 리버는 크게 뒷면을 보였다가 뒤집는다. 올인 런아웃은 빠르게 */
function markBoard(handId, from, n, fast) {
    for (let i = 0; i < n; i++) {
        const k = from + i;
        const key = `b:${handId}:${k}`;
        if (key in S.anim) continue;
        const mobile = S.layout === 'mobile';
        const delay = fast ? i * 0.15 : (k < 3 ? i * 0.3 : 0);
        const cls = fast ? (k === 4 ? 'fast river-glow' : 'fast') : mobile ? 'in-m' : k === 4 ? 'river' : 'in-pc';
        const dur = fast ? 1.6 : mobile ? 0.6 : k === 4 ? 2.3 : 1.2;
        S.anim[key] = Date.now() + delay * 1000;
        S.anim[key + ':c'] = { cls, delay: 0, dur };
    }
}

async function openHole(d) {
    if (!d.envelope || !S.keys || !S.engine) return;
    try {
        const cards = await V.openEnvelope(S.keys, S.engine.ecdh, d.handId, d.envelope);
        const commits = S.hand && S.hand.handId === d.handId ? S.hand.commitments : null;
        let ok = !!commits;
        for (const c of cards) ok = ok && await V.checkOpening(d.handId, commits, c);
        S.hole = cards; S.holeOk = ok; S.holeHandId = d.handId;
        // 받자마자 0.38초 뒷면을 보였다가 뒤집는다(예전 화면). 들어올 때 이미 진행 중이던 판·모바일은 연출 없이
        const hk = `h:${d.handId}`;
        if (!(hk in S.anim)) S.anim[hk] = S.live && S.layout !== 'mobile' ? Date.now() + 250 : 0;
        V.saveHole(d.handId, cards);   // 판이 끝난 뒤 '내 판 기록 검증하기'가 기록과 맞춰 본다
    } catch (e) { S.holeOk = false; console.error('hole', e); }
    render();
}

const ACT_WORD = { FOLD: 'Fold', CHECK: 'Check', CALL: 'Call', BET: 'Bet', RAISE: 'Raise', ALL_IN: 'All-in', BLIND: '' };
function onAction(d) {
    if (!S.hand) return;
    const p = S.hand.seats.find((x) => x.seat === d.seat);
    if (p) { p.stack = d.stack; p.bet = d.bet; if (d.action === 'FOLD') p.folded = true; if (d.action === 'ALL_IN' || d.stack <= 0) p.allIn = true; }
    if (S.seats[d.seat]) S.seats[d.seat].stack = d.stack;
    S.hand.pot = d.pot; S.hand.currentBet = d.currentBet;
    S.bubbles[d.seat] = { a: d.action, amt: d.amount, at: Date.now() };
    if (S.raising && S.raising.seat === d.seat) S.raising = null;
    if (S.turn && S.turn.seat === d.seat) S.turn = null;
    if (d.seat === mySeat()) { hideActions(); if (d.action === 'FOLD' || d.action === 'ALL_IN') S.preAct = ''; }
    sfx(d.action);
    render();
}

/**
 * 공개된 카드(보드·런아웃·쇼다운·판 뒤 보기)도 판 시작 때 받은 카드 약속 52개와 대조한다 — 어긋나면 배지가 '확인 필요'
 * (내 홀카드는 openHole 에서 같은 방법으로 대조한다)
 */
async function checkPublic(handId, list) {
    const commits = S.hand && S.hand.handId === handId ? S.hand.commitments : null;
    for (const op of list || []) {
        if (!op || typeof op !== 'object') continue;
        if (!commits || !(await V.checkOpening(handId, commits, op))) { S.cardsOk = false; renderBadge(); return; }
    }
    if (S.cardsOk !== false) S.cardsOk = true;
}

function onResult(d) {
    if (!S.hand) return;
    checkPublic(d.handId, [...Object.values(d.holes || {}).flat(), ...(d.board || []), ...(d.peekBoard || [])]);
    // [SHOWDOWN_SEQ_0_10_4] 아직 안 연 홀카드 — 레이즈홀덤처럼 한 자리씩 연다(패자 먼저, 승자 마지막). 올인 런아웃이면 onRunout 이 이미 순서를 정했다
    const fresh = Object.keys(d.holes || {}).map(Number).filter((seat) => !S.reveal[seat] && seat !== mySeat());
    if (d.holes) Object.assign(S.reveal, d.holes);
    if (d.board) {
        const nb = d.board.map(codeOf);
        if (nb.length > S.hand.board.length) markBoard(d.handId, S.hand.board.length, nb.length - S.hand.board.length, true);
        S.hand.board = nb;
    }
    // 래빗 — 리버 전에 폴드로 끝난 판이면 남은 보드를 볼 수 있다(판은 이미 끝났다). 앉은 사람만, 버튼은 3초
    const peek = (d.peekBoard || []).map(codeOf).filter(Boolean);
    S.rabbit = peek.length && mySeat() >= 0 ? { handId: d.handId, cards: peek, until: Date.now() + 3000, open: false } : null;
    if (S.rabbit) setTimeout(() => { if (S.rabbit && !S.rabbit.open) render(); }, 3050);
    const r = d.result || {};
    const win = {};
    if (r.type === 'uncontested') win[r.winner] = (win[r.winner] || 0) + r.amount;
    else for (const w of r.winners || []) if (!w.isUncalledReturn) win[w.seat] = (win[w.seat] || 0) + (w.net || 0);
    const real = (r.winners || []).filter((w) => !w.isUncalledReturn);
    const cards = new Set(real.flatMap((w) => w.winningCards || []).map(codeOf));
    const hands = Object.fromEntries((r.hands || []).filter((h) => h.handRank).map((h) => [h.seat, prettyRank(h.handRank)]));
    const top = real.find((w) => hands[w.seat]);
    const winners = { seats: win, hands, cards, big: top ? bigHandName(hands[top.seat]) : '' };

    const hid = d.handId;
    const now = Date.now();
    let winAt = now;
    if (S.sd && S.sd.handId === hid) winAt = S.sd.winAt;   // 올인 런아웃 — 홀카드·보드 순서는 이미 정해졌다
    else if (fresh.length && d.type === 'showdown' && S.live) {
        // 보통 쇼다운 — 0.5초 뒤 0.4초 간격, 승자는 맨 뒤(0.8초 더). 다 뒤집히고(0.6초) 0.7초 뒤 승자·칩. 값은 TableServer showdownMs 와 같다
        const order = showOrder(fresh);
        const losers = order.filter((x) => !(win[x] > 0)), wins = order.filter((x) => win[x] > 0);
        const seq = [...losers, ...wins];
        const at = {};
        seq.forEach((seat, i) => { at[seat] = now + 500 + i * 400 + (i === seq.length - 1 && seq.length > 1 && win[seat] > 0 ? 800 : 0); });
        const last = Math.max(...Object.values(at));
        winAt = last + 600 + 700;
        S.sd = { handId: hid, at, winAt, ranks: hands };
        for (const seat of seq) setTimeout(() => { if (S.hand && S.hand.handId === hid) { play('card'); render(); } }, at[seat] - now);
    }

    // 결과 전 — 차례·베팅을 걷고 팟은 남긴다. 말풍선도 남긴다(운영 화면처럼 마지막 액션이 보인다)
    S.turn = null; S.hand.toAct = null;
    for (const p of S.hand.seats) p.bet = 0;
    hideActions();
    render();

    const apply = () => {
        if (!S.hand || S.hand.handId !== hid) return;
        if (S.darkHand === hid) showDarkReveal();
        for (const [seat, st] of Object.entries(d.stacks || {})) if (S.seats[seat]) S.seats[seat].stack = st;
        S.winners = winners;
        flushSeats();
        if (win[mySeat()] > 0) play('win');
        render();
        // 래빗을 열었으면 다음 판이 올 때까지 보드를 남긴다(예전 화면)
        const clear = () => {
            if (!S.hand || S.hand.handId !== hid) return;
            if (S.rabbit && S.rabbit.open) return;
            S.hand = null; S.winners = null; S.reveal = {}; S.hole = null; S.rabbit = null; S.sd = null; render();
        };
        setTimeout(clear, S.rabbit ? 4800 : 3800);
    };
    if (winAt > now + 20) setTimeout(apply, winAt - now); else apply();
}

/**
 * [SHOWDOWN_SEQ_0_10_4] 올인으로 베팅이 끝났다 — SHOWDOWN → 홀카드를 0.4초 간격으로 한 자리씩 → 보드를 한 단계씩(1초 간격, 리버는 빛나게) → 승자.
 * 레이즈홀덤 연출 순서 그대로(all_in_holecards → 런아웃). 결과(result)는 같은 순간 오지만 onResult 가 S.sd.winAt 까지 기다린다.
 */
function onRunout(d) {
    if (!S.hand) return;
    checkPublic(d.handId, [...Object.values(d.holes || {}).flat(), ...(d.stages || []).flatMap((x) => x.cards)]);
    const hid = d.handId;
    const now = Date.now();
    const seats = showOrder(Object.keys(d.holes || {}).map(Number));
    Object.assign(S.reveal, d.holes || {});
    clearBets(); S.turn = null; S.hand.toAct = null; hideActions();
    const stages = d.stages || [];
    if (!S.live) {   // 들어오자마자 받은 이벤트 — 연출 없이
        for (const x of stages) S.hand.board.push(...x.cards);
        render();
        return;
    }
    const at = {};
    seats.forEach((seat, i) => { at[seat] = now + 1600 + i * 400; });
    for (const seat of seats) if (seat !== mySeat()) setTimeout(() => { if (S.hand && S.hand.handId === hid) { play('card'); render(); } }, at[seat] - now);
    const t0 = now + 1600 + Math.max(0, seats.length - 1) * 400 + 600;
    stages.forEach((x, j) => {
        const start = t0 + j * 1000;
        const from = S.hand.board.length;
        x.cards.forEach((_c, i) => {
            const k = from + i;
            const key = `b:${hid}:${k}`;
            S.anim[key] = start + i * 150;
            S.anim[key + ':c'] = { cls: k === 4 ? 'fast river-glow' : 'fast', delay: 0, dur: 1.6 };
        });
        S.hand.board.push(...x.cards);
        setTimeout(() => { if (S.hand && S.hand.handId === hid) { play('card'); render(); } }, start - now);
    });
    const boardEnd = stages.length ? t0 + (stages.length - 1) * 1000 + 900 : t0;
    S.sd = { handId: hid, at, winAt: boardEnd + 700, ranks: null };   // 런아웃은 보드가 다 깔린 뒤에 족보 — 미리 알려 주지 않는다
    showBanner('SHOWDOWN', 4000, true); play('showdown');   // 올인으로 베팅이 끝났다 — 예전 화면의 SHOWDOWN
    render();
}

/** 여는 순서 — 딜러 다음 자리부터 시계 방향 */
function showOrder(list) {
    const d = S.hand ? S.hand.dealer : -1;
    return [...list].sort((a, b) => ((a - d - 1 + 64) % 64) - ((b - d - 1 + 64) % 64));
}
/** 이 자리 카드를 지금 보여 줘도 되나 — 순차 공개 중이면 그 자리 차례가 와야 */
function sdShown(seat) {
    if (!S.reveal[seat]) return false;
    const sd = S.sd;
    if (!sd || !S.hand || sd.handId !== S.hand.handId || !(seat in sd.at)) return true;
    return Date.now() >= sd.at[seat];
}
/** 승자 표시 전인가(순차 공개 중) */
function sdBusy() {
    return !!(S.sd && S.hand && S.sd.handId === S.hand.handId && !S.winners && Date.now() < S.sd.winAt + 50);
}
/** 지금 보이는 보드 — 런아웃 카드가 아직 안 깔렸으면 빼고(족보 글자가 미리 알려 주지 않게) */
function shownBoard() {
    const h = S.hand;
    if (!h) return [];
    const now = Date.now();
    return h.board.filter((_c, k) => !(S.anim[`b:${h.handId}:${k}`] > now)).map(codeOf);
}
function applySeat(d) {
    const x = d.seat;
    S.seats[x.seat] = x.empty ? null : x;
    if (S.me && x.seat === S.me.seat && !x.empty) Object.assign(S.me, x);
}
function flushSeats() {
    const q = S.sdQ; S.sdQ = [];
    for (const d of q) applySeat(d);
}
/** 순차 공개 때 뒤집으며 여는 카드(작은 카드) */
function sdCards(m, seat, shown) {
    const sd = S.sd, timed = sd && S.hand && sd.handId === S.hand.handId && seat in sd.at;
    shown.forEach((c, i) => {
        const w = el('div', 'mc');
        const code = codeOf(c);
        w.appendChild(timed ? flipEl(code, winLook(code), `sd:${sd.handId}:${seat}:${i}`, 'sd', i * 0.12, 0.6) : cardEl(code, winLook(code)));
        m.appendChild(w);
    });
}

function clearBets() {
    if (!S.hand) return;
    for (const p of S.hand.seats) p.bet = 0;
    S.bubbles = Object.fromEntries(Object.entries(S.bubbles).filter(([, b]) => b.a === 'FOLD' || b.a === 'ALL_IN'));
}

// ------------------------------------------------------------ 배치 계산

function layoutMode() {
    const tb = $('#table');
    const portrait = innerHeight > innerWidth;
    S.layout = portrait ? 'mobile' : 'pc';
    tb.classList.toggle('pc', !portrait);
    tb.classList.toggle('mobile', portrait);
    $('.bg-img').src = ASSET + (portrait ? 'img/bg_mobile.jpg' : 'img/bg_pc.jpg') + AV;
    // 운영 화면: 높이 900 에서 0.742 배
    $('#actions').style.transform = portrait ? '' : `translateX(-50%) scale(${(0.742 * innerHeight / 900).toFixed(3)})`;
    // 모바일: 390x844 화폭을 가로에 맞춰 늘리고 세로 가운데
    const k = innerWidth / 390;
    tb.style.setProperty('--k', k.toFixed(4));
    tb.style.setProperty('--oy', ((innerHeight - 844 * k) / 2).toFixed(1) + 'px');
}

const mySeat = () => (S.me ? S.me.seat : -1);
const maxSeats = () => (S.room ? S.room.maxPlayers : 9);

/** 화면 자리 → 실제 좌석. 내 자리가 늘 아래 가운데(화면 자리 0)에 온다 */
function screenIndex(seat) {
    const n = maxSeats(), me = Math.max(0, mySeat());
    return (seat - me + n) % n;
}

function anchor(seat) {
    const tb = $('#table'), W = tb.clientWidth, H = tb.clientHeight;
    const n = maxSeats(), i = screenIndex(seat);
    if (S.layout === 'mobile') {   // 화폭 좌표(390x844) — #stage 가 통째로 늘린다
        const [[xp, xo], [yp, yo]] = MOBILE_POS[Math.min(i, 8)];
        return { x: 390 * xp / 100 + xo, y: 844 * yp / 100 + yo, role: i, scale: 1 };
    }
    const iw = W - 4, ih = H - 4;
    const table = n > 9 ? PC_POS_11 : PC_POS;
    const role = n > 9 ? ROLE_11[i] : i;
    const [[xp, xo], [yp, yo]] = table[i] || PC_POS[0];
    return { x: 2 + iw * xp / 100 + xo, y: 2 + ih * yp / 100 + yo, role, scale: 1 };
}

// ------------------------------------------------------------ 그리기

function render() {
    renderBoard();
    renderSeats();
    renderBets();
    renderActions();
    renderRebuy();
    renderBadge();
}

/**
 * [REBUY_0_10_1] 칩을 다 잃은 내 자리(정산 0, 자리는 잡아 둠) — 「바이인 신청」을 누르면 말풍선을 띄우고
 * 로비의 바이인 신청(방장 승인 → 좌석표)으로 간다. 좌석표로 돌아오면 TEE 가 이 자리에 다시 앉힌다.
 * 금액은 방의 1바이인 금액(좌석표의 room.unit, 화면 표시용).
 */
function renderRebuy() {
    const bar = $('#rebuy-bar');
    const me = S.seats && S.seats[mySeat()];
    const out = !!(me && me.busted && !me.leaving && me.rebuy !== 'done');
    bar.hidden = !out;
    if (!out) return;
    $('.rb-msg', bar).textContent = t('rbLost');
    const unit = S.me && S.me.unit;
    $('.rb-go', bar).textContent = unit ? `${t('rbBtn')} · ${dmCur(unit)}` : t('rbBtn');
}

function renderBoard() {
    const h = S.hand;
    const pot = h ? h.pot : 0;
    const done = !!S.winners;
    $('.pot-total').textContent = dm(done ? 0 : pot);
    $('.pot-grid > div:first-child').classList.toggle('won', done);
    $('.main-v').textContent = dm(pot);
    const chips = $('.pot-chips');
    chips.innerHTML = '';
    if (pot > 0) chips.appendChild(chipStackEl(pot, { cap: 8 }));
    const board = $('.board');
    board.innerHTML = '';
    const cards = h ? h.board.map(codeOf) : [];
    const rb = S.rabbit && h && S.rabbit.handId === h.handId ? S.rabbit : null;
    for (let k = 0; k < 5; k++) {
        const slot = el('div', 'slot');
        if (cards[k]) {
            const key = `b:${h.handId}:${k}`, meta = S.anim[key + ':c'];
            slot.appendChild(meta ? flipEl(cards[k], winLook(cards[k]), key, meta.cls, 0, meta.dur) : cardEl(cards[k], winLook(cards[k])));
        } else if (rb && rb.open && rb.cards[k - cards.length]) {
            // 래빗 — 뒷면이 왼쪽 위 귀퉁이부터 넘어가며 남은 카드가 보인다
            slot.appendChild(cardEl(rb.cards[k - cards.length]));
            const pk = `rb:${h.handId}:${k}`;
            if (animAge(pk) < 3.5 || !(pk in S.anim)) {
                const cv = el('div', 'peek-cover');
                cv.style.backgroundImage = `url('${ASSET}img/card_back.jpg${AV}')`;
                cv.style.setProperty('--d', animDelay(pk, (k - cards.length) * 0.08));
                slot.appendChild(cv);
            }
        }
        board.appendChild(slot);
    }
    // RABBIT 버튼 — 3초 동안
    $('#board-area .rabbit')?.remove();
    if (rb && !rb.open && Date.now() < rb.until) {
        const btn = el('button', 'rabbit', esc(t('rabbit')));
        btn.type = 'button'; btn.dataset.testid = 'rabbit';
        btn.onclick = () => { rb.open = true; render(); };
        $('#board-area').appendChild(btn);
    }
    $('#table').classList.toggle('waiting', !h);
    // 판이 없고 앉은 사람이 둘보다 적으면 — 판이 시작되지 않는 이유를 알린다
    let wm = $('.wait-msg');
    if (!wm) { wm = el('div', 'wait-msg'); $('#board-area').appendChild(wm); }
    wm.textContent = !h && (S.seats || []).filter(Boolean).length < 2 ? t('waiting') : '';
    wm.hidden = !wm.textContent;
    let big = $('.win-hand');
    if (!big) { big = el('div', 'win-hand'); $('#board-area').appendChild(big); }
    big.textContent = (S.winners && S.winners.big) || '';
    big.hidden = !big.textContent;
}

/** 칩 더미 — 운영 ChipStack 규칙: 센트 정수로 큰 칩부터 나누고, PC 는 자릿수 밴드별 세로 더미를 가로로, 모바일은 한 줄 */
const CHIP_VALUES = [1000, 500, 100, 50, 10, 5, 1, 0.1];
const CHIP_FILE = { 1000: 'chip_1000', 500: 'chip_500', 100: 'chip_100', 50: 'chip_50', 10: 'chip_10', 5: 'chip_5', 1: 'chip_1', 0.1: 'chip_0_1' };
const cents = (n) => Math.round((Number(n) || 0) * 100);
const band = (v) => (v >= 1000 ? 3 : v >= 100 ? 2 : v >= 10 ? 1 : v >= 1 ? 0 : -1);
function chipStackEl(amount, { single = false, cap = 0 } = {}) {
    let left = Math.max(0, cents(amount));
    const all = [];
    for (const v of CHIP_VALUES) { const n = Math.floor(left / cents(v)); for (let i = 0; i < n; i++) all.push(v); left -= n * cents(v); }
    if (!all.length && cents(amount) > 0) all.push(0.1);
    let stacks = single ? [all] : [3, 2, 1, 0, -1].map((b) => all.filter((v) => band(v) === b)).filter((x) => x.length);
    if (cap) stacks = stacks.flatMap((st) => { const out = []; for (let i = 0; i < st.length; i += cap) out.push(st.slice(i, i + cap)); return out; });
    const box = el('div', 'chips');
    stacks.forEach((st, si) => {
        const col = el('div', 'chip-col');
        st.slice(0, 24).forEach((v, i) => {
            const c = el('div', 'chip');
            const rot = ((i * 13 + si * 7) % 360) % 10 - 5, xo = (i % 3) - 1.5;
            c.style.zIndex = i; c.style.transform = `translateY(${-i * 4}px)`;
            const im = el('img'); im.src = `${ASSET}img/${CHIP_FILE[v]}.webp${AV}`; im.alt = ''; im.style.transform = `rotate(${rot}deg) translateX(${xo}px)`;
            c.appendChild(im); col.appendChild(c);
        });
        box.appendChild(col);
    });
    return box;
}

function renderSeats() {
    const box = $('#seats');
    box.innerHTML = '';
    const h = S.hand;
    for (let seat = 0; seat < maxSeats(); seat++) {
        const s = S.seats[seat];
        if (!s) continue;
        const a = anchor(seat);
        const hero = seat === mySeat();
        const inHand = h && h.seats.find((x) => x.seat === seat);
        const node = el('div', 'seat' + (hero ? ' hero' : '') + (inHand && inHand.folded ? ' folded' : '') + (s.sitout ? ' sitout' : '') + (s.busted && s.rebuy !== 'done' ? ' busted' : '')
            + (S.winners && S.winners.seats[seat] ? ' winner-glow' : ''));
        node.dataset.seat = seat;
        node.style.left = a.x + 'px';
        node.style.top = a.y + 'px';
        const draw = S.layout === 'mobile' ? (hero ? heroSeatMobile : otherSeatMobile) : (hero ? heroSeat : otherSeat);
        draw(node, s, a, inHand);
        box.appendChild(node);
    }
    for (const [seat, v] of S.fire) if (!isAllIn(seat) && !v.paused) v.pause();   // 올인이 끝난 자리의 불꽃은 멈춘다
}

/** 기본 아바타 — 닉네임으로 여러 장 중 하나를 고른다(같은 회원은 어디서나 같은 얼굴). 그림은 리소스 서버에 있다 */
const AVATAR_COUNT = 6;
function avatarFile(s) {
    const key = String((s && s.nickname) || '');
    let h = 0;
    for (let k = 0; k < key.length; k++) h = (h * 31 + key.charCodeAt(k)) >>> 0;
    return key ? `avatar_${1 + (h % AVATAR_COUNT)}.png` : 'avatar.png';
}

function avatarEl(s, size, seat, ring = true) {
    const av = el('div', 'avatar');
    av.style.width = av.style.height = size + 'px';
    const im = el('img'); im.alt = ''; im.src = ASSET + 'img/' + avatarFile(s) + AV; av.appendChild(im);
    if (ring && S.turn && S.turn.seat === seat) av.appendChild(turnRing(size));   // 모바일 영웅은 링 대신 차례 막대
    if (isAllIn(seat)) av.appendChild(fireCore(seat));
    // 팁 받을 사람 고르기 — 선물을 고른 뒤 상대 아바타가 깜빡이고, 누르면 보낸다
    if (S.tipGift && seat !== mySeat()) {
        av.classList.add('tip-target');
        av.onclick = (e) => { e.stopPropagation(); const g = S.tipGift; endTipPick(); sendTip(seat, g); };
    }
    return av;
}

const isAllIn = (seat) => { const p = S.hand && S.hand.seats.find((x) => x.seat === seat); return !!(p && p.allIn && !p.folded); };

/** 올인 불꽃 영상 — 좌석마다 하나를 두고 다시 그릴 때 옮겨 단다(처음부터 다시 틀지 않는다). 아바타 위에 screen 으로 겹친다 */
function fireCore(seat) {
    const core = el('div', 'ai-core');
    let v = S.fire.get(seat);
    if (!v) {
        v = document.createElement('video');
        v.muted = true; v.loop = true; v.playsInline = true; v.autoplay = true; v.setAttribute('playsinline', '');
        v.src = `${ASSET}fx/fire.webm${AV}`;
        S.fire.set(seat, v);
    }
    core.appendChild(v);
    setTimeout(() => { if (v.paused) v.play().catch(() => {}); }, 0);
    return core;
}

/** 아바타 밖 연출 — 올인 링·불씨, 인 더 다크 오라·리본. 아바타와 같은 자리·크기의 층 */
function seatFx(parent, seat, av, size, small = false) {
    const allIn = isAllIn(seat);
    const dark = S.hand && (S.hand.dark || []).includes(seat) && !S.winners;
    if (!allIn && !dark) return;
    const w = el('div', 'fxw');
    w.style.cssText = `position:absolute;left:${av.style.left};top:${av.style.top};width:${size}px;height:${size}px;pointer-events:none;z-index:25`;
    if (allIn) {
        const r = el('div', 'ai-ring'); r.style.animationDelay = animDelay('ring:' + seat); w.appendChild(r);
        const em = el('div', 'ai-embers');
        let seed = (seat + 1) * 2654435761 >>> 0;
        const rnd = () => { seed = (seed + 0x6D2B79F5) >>> 0; let t2 = seed; t2 = Math.imul(t2 ^ (t2 >>> 15), t2 | 1); t2 ^= t2 + Math.imul(t2 ^ (t2 >>> 7), t2 | 61); return ((t2 ^ (t2 >>> 14)) >>> 0) / 4294967296; };
        const k = size / 122;
        for (let i = 0; i < 16; i++) {
            const a = rnd() * Math.PI * 2, d0 = size * 0.28, d1 = d0 + (34 + rnd() * 28) * k, sz = 3 + rnd() * 4;
            const e = el('i');
            e.style.width = e.style.height = sz + 'px';
            e.style.setProperty('--x0', (Math.cos(a) * d0) + 'px'); e.style.setProperty('--y0', (Math.sin(a) * d0) + 'px');
            e.style.setProperty('--x1', (Math.cos(a) * d1) + 'px'); e.style.setProperty('--y1', (Math.sin(a) * d1) + 'px');
            e.style.setProperty('--dur', (1.15 + rnd() * 0.7).toFixed(2) + 's');
            e.style.setProperty('--del', animDelay('ember:' + seat + ':' + i, rnd() * 1.6));
            em.appendChild(e);
        }
        w.appendChild(em);
    }
    if (dark) {
        const au = el('div', 'dark-aura'); au.style.animationDelay = animDelay('aura:' + seat); w.appendChild(au);
        const rb = el('div', 'dark-ribbon' + (small ? ' sm' : ''), esc(t('darkActive')));
        rb.style.left = '50%'; rb.style.top = Math.round(size * 0.58) + 'px';   // 아바타 아래쪽 안 — 이름 상자를 가리지 않게
        w.appendChild(rb);
    }
    parent.appendChild(w);
}

function turnRing(size) {
    const ns = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('class', 'ring'); svg.setAttribute('viewBox', '0 0 100 100');
    const c = document.createElementNS(ns, 'circle');
    c.setAttribute('cx', 50); c.setAttribute('cy', 50); c.setAttribute('r', 48); c.setAttribute('fill', 'none');
    c.setAttribute('stroke', '#fbbf24'); c.setAttribute('stroke-width', 4); c.setAttribute('pathLength', 100);
    const left = Math.min(1, Math.max(0, (S.turn.deadline - Date.now()) / (S.room.turnSec * 1000)));   // 타임뱅크로 늘면 가득 찬 채로
    c.setAttribute('stroke-dasharray', `${(left * 100).toFixed(1)} 100`);
    c.classList.add('ring-arc');
    svg.appendChild(c);
    void size;
    return svg;
}

function nameboxEl(s, w, hgt, nmPx, stPx) {
    const nb = el('div', 'namebox');
    nb.style.width = w + 'px'; nb.style.height = hgt + 'px';
    nb.innerHTML = `<i class="flag"></i><i class="fade"></i><div class="info"><span class="nm" style="font-size:${nmPx}px;line-height:${Math.round(nmPx * 1.33)}px">${esc(s.nickname)}</span>`
        + `<span class="st" style="font-size:${stPx}px;line-height:${Math.round(stPx * 1.4)}px">${dm(s.stack)}</span></div>`;
    // [REBUY_2026_11_11] 칩 0 = 「올인」 딱지
    // [BUYIN_UNITS_0_10_4] 그 밖에는 이 자리 총 바이인 개수(「총 3바이인」) — 재바이인 직후 한 번 초록으로 반짝
    const fresh = rbDoneFresh(s);
    const tag = s.busted && s.rebuy !== 'done' ? ['out', t('rbAllin')] : s.bi > 0 ? ['bi' + (fresh ? ' done' : ''), tn('biTotal', s.bi)] : null;
    if (tag) {
        nb.classList.add('tagged');
        const b = el('span', 'seat-tag ' + tag[0] + (w < 100 ? ' sm' : ''), esc(tag[1])); b.dataset.testid = 'seat-tag-' + s.seat;
        if (fresh) b.style.animationDelay = rbDoneDelay(s);
        nb.appendChild(b);
    }
    return nb;
}

/** [BUYIN_UNITS_0_10_4] 「바이인 완료」를 지금 보여 줄까 — 그 자리·이름·합계로 처음 본 뒤 3.5초만 */
const RB_SHOW_MS = 3500;
const rbKey = (s) => `${s.seat}:${s.nickname}:${s.bi || 0}`;
function rbDoneFresh(s) {
    if (!s || s.rebuy !== 'done') return false;
    const k = rbKey(s);
    if (!(k in S.rbSeen)) { S.rbSeen[k] = Date.now(); setTimeout(render, RB_SHOW_MS + 60); }
    return Date.now() - S.rbSeen[k] < RB_SHOW_MS;
}
/** 다시 그려도 튀어나오는 연출이 처음부터 다시 돌지 않게 — 처음 본 시각부터 이어서 */
function rbDoneDelay(s) { return ((S.rbSeen[rbKey(s)] - Date.now()) / 1000).toFixed(3) + 's'; }

function blindTag(seat) {
    const h = S.hand;
    if (!h) return null;
    if (seat === h.bb) return 'BB';
    if (seat === h.sb && h.seats.length > 2) return 'SB';
    return null;
}

function otherSeat(node, s, a, inHand) {
    const seat = s.seat;
    const [dx, dy] = S.layout === 'pc' ? (PC_ROLE_ADJ[a.role] || PC_ROLE_ADJ_DEFAULT) : [0, 0];
    const ox = -66 + dx, oy = -77 + dy;   // 132x154 상자의 왼쪽 위
    const av = avatarEl(s, 122, seat); av.style.left = (ox + 20) + 'px'; av.style.top = (oy + 8) + 'px'; node.appendChild(av);
    seatFx(node, seat, av, 122);
    const nb = nameboxEl(s, 132, 48, 12, 14); nb.style.left = (ox + 15) + 'px'; nb.style.top = (oy + 106) + 'px'; node.appendChild(nb);
    const tag = blindTag(seat);
    if (tag) { const b = el('span', 'blind', tag); b.style.left = (ox + 20) + 'px'; b.style.top = (oy + 109) + 'px'; node.appendChild(b); }
    if (S.hand && S.hand.dealer === seat) { const d = dealerEl(); d.style.left = (ox + 2) + 'px'; d.style.top = (oy + 93) + 'px'; node.appendChild(d); }
    if (inHand) {
        const shown = sdShown(seat) ? S.reveal[seat] : null;   // [SHOWDOWN_SEQ_0_10_4] 그 자리 차례가 와야 연다
        const m = el('div', 'mini');
        if (shown) { m.className = 'mini shown'; sdCards(m, seat, shown); m.style.left = (ox + 107) + 'px'; m.style.top = (oy + 48) + 'px'; }
        else if (!inHand.folded) { for (let k = 0; k < 2; k++) { const w = el('div', 'mc'); w.appendChild(cardEl(null)); m.appendChild(w); } m.style.left = (ox + 98) + 'px'; m.style.top = (oy + 76) + 'px'; }
        if (m.children.length) node.appendChild(m);
    }
    bubbleFor(node, seat, ox + 66, oy - 34);
    resultFor(node, seat, ox + 81, oy + 160, ox + 81, oy + 69);
}

function heroSeat(node, s, a, inHand) {
    const seat = s.seat;
    const sc = 1;   // 잰 값이 이미 화면 크기(운영 화면의 0.9 배를 반영한 값)
    const wrap = el('div', 'hero-wrap');
    wrap.style.transform = 'translate(-120px,-80px)';
    wrap.style.transformOrigin = '0 0';
    wrap.style.left = '0px'; wrap.style.top = '0px';
    node.appendChild(wrap);
    // 기준점은 영웅 감싸개의 좌상단 — 운영 화면 1600x900 측정값을 감싸개 좌표로 되돌린 값
    const cx = (-102 + 120) / sc, cy = (-81 + 80) / sc;
    const av = avatarEl(s, 143, seat); av.style.left = (cx - 71.5) + 'px'; av.style.top = (cy - 71.5) + 'px'; wrap.appendChild(av);
    seatFx(wrap, seat, av, 143);
    const ny = (-9 + 80) / sc;
    const nb = nameboxEl(s, 167, 57, 16, 18); nb.style.left = (cx - 83.5) + 'px'; nb.style.top = (ny - 28.5) + 'px'; wrap.appendChild(nb);
    heroButtons(wrap, cx - 83.5 - 42, ny - 28.5, false);   // 이름 상자 왼쪽 세로칸 — 위 감정, 아래 팁(예전 화면)
    const tag = blindTag(seat);
    if (tag) { const b = el('span', 'blind', tag); b.style.left = (cx - 78) + 'px'; b.style.top = (ny - 24) + 'px'; wrap.appendChild(b); }
    if (S.hand && S.hand.dealer === seat) { const d = dealerEl(); d.style.left = (cx - 83.5 - 13) + 'px'; d.style.top = (ny - 28.5 - 13) + 'px'; wrap.appendChild(d); }
    const cards = S.hole && S.hand && S.holeHandId === S.hand.handId ? S.hole.map(codeOf) : (S.reveal[seat] || []).map(codeOf);
    if (inHand && cards.length) {
        const hole = el('div', 'hole' + (inHand.folded ? ' folded' : ''));
        hole.style.left = ((28 + 120) / sc) + 'px'; hole.style.top = ((-157 + 80) / sc) + 'px'; hole.style.transform = `scale(${1 / sc})`; hole.style.transformOrigin = '0 0';
        holeCards(hole, cards, inHand);
        hole.querySelectorAll('.hc')[1] && (hole.querySelectorAll('.hc')[1].style.marginLeft = (54 - 86) + 'px');
        wrap.appendChild(hole);
        const rank = !S.winners && !inHand.folded && !inDark() ? liveHandName([...cards, ...shownBoard()]) : null;   // [SHOWDOWN_SEQ_0_10_4] 아직 안 깔린 런아웃 카드는 빼고
        if (rank) { const hr = el('div', 'handrank', esc(rank)); hr.style.left = ((28 + 120 + 70) / sc) + 'px'; hr.style.top = ((-157 + 80 + 142) / sc) + 'px'; hr.style.transform = `translateX(-50%) scale(${1 / sc})`; hr.style.transformOrigin = '50% 0'; wrap.appendChild(hr); }
    }
    if (S.turn && S.turn.seat === seat) {
        const tm = el('div', 'timer');
        const left = Math.max(0, Math.ceil((S.turn.deadline - Date.now()) / 1000));
        tm.innerHTML = `<span><svg viewBox="0 0 24 24"><circle cx="12" cy="13" r="8"/><path d="M12 9v4l2 2M9 2h6"/></svg><b class="tsec">${left}</b></span>`;
        tm.style.left = ((-211 + 120) / sc - 25) + 'px'; tm.style.top = ((-95 + 80) / sc - 25) + 'px';
        wrap.appendChild(tm);
        timeBankButton(wrap, (-211 + 120) / sc - 31, (-95 + 80) / sc + 30);
    }
    // 결과 족보 글자(보드 아래)가 떠 있는 동안 내 말풍선은 숨긴다 — 같은 높이라 글자를 가린다.
    // 세로가 기준(900)보다 짧은 화면에서는 내 자리가 보드 쪽으로 올라와 말풍선이 카드에 닿는다 — 아바타 왼쪽 아래에 둔다
    if (!(S.winners && S.winners.big)) {
        if (innerHeight < 880) bubbleFor(wrap, seat, cx - 150, ny - 11, 'side');
        else bubbleFor(wrap, seat, cx, cy - 71.5 - 34);
    }
    resultFor(wrap, seat, cx, ny + 34, cx, cy);
}

// ------------------------------------------------------------ 모바일 좌석 (390x844 화폭 좌표, 운영 화면에서 잰 값)

/** 옆자리 아바타는 기준점보다 테이블 안쪽으로 조금 들어와 있다 */
function mobileAvatarX(a) {
    return a.x + (a.role >= 1 && a.role <= 3 ? 10 : a.role >= 6 ? -5 : 0);
}

function otherSeatMobile(node, s, a, inHand) {
    const seat = s.seat;
    node.style.left = mobileAvatarX(a) + 'px';
    const av = avatarEl(s, 69, seat); av.style.left = '-34.5px'; av.style.top = '-34.5px'; node.appendChild(av);
    seatFx(node, seat, av, 69, true);
    const nb = nameboxEl(s, 74, 25, 8, 9); nb.style.left = '-37px'; nb.style.top = '25px'; node.appendChild(nb);
    const tag = blindTag(seat);
    if (tag) { const b = el('span', 'blind sm', tag); b.style.left = '-33px'; b.style.top = '27px'; node.appendChild(b); }
    if (S.hand && S.hand.dealer === seat) { const d = dealerEl(); d.classList.add('sm'); d.style.left = '-44px'; d.style.top = '17px'; node.appendChild(d); }
    if (inHand) {
        const shown = sdShown(seat) ? S.reveal[seat] : null;   // [SHOWDOWN_SEQ_0_10_4]
        const m = el('div', 'mini m');
        if (shown) { m.classList.add('shown'); sdCards(m, seat, shown); m.style.left = '10px'; m.style.top = '-12px'; }
        else if (!inHand.folded) { for (let k = 0; k < 2; k++) { const w = el('div', 'mc'); w.appendChild(cardEl(null)); m.appendChild(w); } m.style.left = '17px'; m.style.top = '7px'; }
        if (m.children.length) node.appendChild(m);
    }
    bubbleFor(node, seat, 2, -54, 'sm');
    resultFor(node, seat, 0, 54, 0, 0, 'sm');
}

function heroSeatMobile(node, s, a, inHand) {
    const seat = s.seat;
    node.style.left = '0px'; node.style.top = '0px';   // 영웅 묶음은 화폭 왼쪽 아래 고정
    const cx = 56, cy = 731;
    const av = avatarEl(s, 74, seat, false); av.style.left = (cx - 37) + 'px'; av.style.top = (cy - 37) + 'px'; node.appendChild(av);
    seatFx(node, seat, av, 74, true);
    const nb = nameboxEl(s, 77, 32, 11, 12); nb.style.left = '18px'; nb.style.top = '758px'; node.appendChild(nb);
    heroButtons(node, 14, 795, true);   // 프로필 아래 줄 — 감정·팁·다크(예전 화면)
    const tag = blindTag(seat);
    if (tag) { const b = el('span', 'blind sm', tag); b.style.left = '21px'; b.style.top = '760px'; node.appendChild(b); }
    if (S.hand && S.hand.dealer === seat) { const d = dealerEl(); d.classList.add('sm'); d.style.left = '8px'; d.style.top = '748px'; node.appendChild(d); }
    const cards = S.hole && S.hand && S.holeHandId === S.hand.handId ? S.hole.map(codeOf) : (S.reveal[seat] || []).map(codeOf);
    if (inHand && cards.length) {
        const hole = el('div', 'hole m' + (inHand.folded ? ' folded' : ''));
        hole.style.left = '155px'; hole.style.top = '684px';
        holeCards(hole, cards, inHand);
        node.appendChild(hole);
        const rank = !S.winners && !inHand.folded && !inDark() ? liveHandName([...cards, ...shownBoard()]) : null;
        if (rank) { const hr = el('div', 'handrank m', esc(rank)); hr.style.left = '208px'; hr.style.top = '642px'; node.appendChild(hr); }
    }
    if (S.turn && S.turn.seat === seat) {
        const tm = el('div', 'timer m');
        const left = Math.max(0, Math.ceil((S.turn.deadline - Date.now()) / 1000));
        tm.innerHTML = `<span><svg viewBox="0 0 24 24"><circle cx="12" cy="13" r="8"/><path d="M12 9v4l2 2M9 2h6"/></svg><b class="tsec">${left}</b></span>`;
        tm.style.left = '102px'; tm.style.top = '617px';
        node.appendChild(tm);
        timeBankButton(node, 100, 671, 'm');
    }
    if (!(S.winners && S.winners.big)) bubbleFor(node, seat, cx, cy - 60, 'sm');
    resultFor(node, seat, cx, 794, cx, cy - 8, 'sm');
}

function dealerEl() {
    const d = el('div', 'dealer'); const im = el('img'); im.src = ASSET + 'img/dealer.png' + AV; im.alt = 'D'; d.appendChild(im); return d;
}

/** 내 카드 — 받을 때 뒷면→앞면 뒤집기, 인 더 다크 판에는 뒷면 + DARK 봉인(판이 끝나면 공개) */
const inDark = () => !!(S.hand && S.darkHand === S.hand.handId && !S.winners);
function holeCards(hole, cards, inHand) {
    const key = `h:${S.hand.handId}`;
    for (const c of cards) {
        const w = el('div', 'hc');
        if (inDark()) {
            w.appendChild(cardEl(null));
            const sl = el('div', 'dark-seal', `<b>${esc(t('darkSeal'))}</b>`); w.appendChild(sl);
        } else {
            const opts = inHand.folded ? { dim: true } : winLook(c);
            w.appendChild(S.anim[key] ? flipEl(c, opts, key, 'deal', 0, 0.71) : cardEl(c, opts));
        }
        hole.appendChild(w);
    }
}

/** 영웅 자리 옆 버튼 — 감정(판당 한 번)·팁(프리플랍)·(모바일) 인 더 다크 */
const SVG_SMILE = '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M8 14s1.5 2 4 2 4-2 4-2M9 9h.01M15 9h.01"/></svg>';
const SVG_GIFT = '<svg viewBox="0 0 24 24"><rect x="3" y="8" width="18" height="4" rx="1"/><path d="M12 8v13M19 12v7a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2v-7M7.5 8a2.5 2.5 0 0 1 0-5C11 3 12 8 12 8s1-5 4.5-5a2.5 2.5 0 0 1 0 5"/></svg>';
function heroButtons(parent, x, y, row) {
    const box = el('div', 'hero-btns' + (row ? ' row' : ''));
    box.style.left = x + 'px'; box.style.top = y + 'px';
    const emo = el('button', '', SVG_SMILE); emo.type = 'button'; emo.dataset.testid = 'hero-emote'; emo.title = t('emote');
    emo.onclick = (e) => { e.stopPropagation(); openEmotePick(emo); };
    box.appendChild(emo);
    const others = (S.seats || []).filter((x2) => x2 && x2.seat !== mySeat()).length;
    if (others) {
        const gift = el('button', '', SVG_GIFT); gift.type = 'button'; gift.dataset.testid = 'hero-tip'; gift.title = t('tipHint');
        gift.onclick = (e) => { e.stopPropagation(); openTipPick(gift); };
        box.appendChild(gift);
    }
    if (row) {
        const dk = el('button', 'dk-btn' + (S.darkNext ? ' on' : ''), S.darkNext ? 'NEXT' : 'DARK'); dk.type = 'button'; dk.dataset.testid = 'hero-dark'; dk.title = t('darkSub');
        dk.onclick = (e) => { e.stopPropagation(); toggleDark(); };
        box.appendChild(dk);
    }
    parent.appendChild(box);
}

function bubbleFor(parent, seat, cx, top, size = '') {
    // 레이즈 금액을 고르는 중 — 말풍선 자리에 「Raising…」
    if (S.raising && S.raising.seat === seat && S.turn && S.turn.seat === seat) {
        const r = el('div', 'raising' + (size === 'sm' ? ' sm' : ''), 'Raising<span class="dots"></span>');
        r.style.left = cx + 'px'; r.style.top = top + 'px';
        parent.appendChild(r);
        return;
    }
    const b = S.bubbles[seat];
    // [REBUY_2026_11_11] 바이인 신청 말풍선 — 「바이인요~」 → 승인되면 「바이인 완료!」
    //   [REBUY_0_10_3] 「바이인요~」는 직전 판 액션 말풍선(올인 등)이 남아 있어도 먼저 보인다(그 자리는 판에 들지 않는다)
    const st = S.seats && S.seats[seat];
    //   [BUYIN_UNITS_0_10_4] 「바이인 완료!」는 처음 본 뒤 3.5초 한 번만(종전엔 말풍선이 없을 때마다 — 차례마다 다시 떴다). 몇 바이인인지 함께
    const rb = st && (st.rebuy === 'asked' ? 'ask' : rbDoneFresh(st) ? 'done' : null);
    if (rb) {
        const n = el('div', 'rebuy-bubble ' + rb + (size ? ' ' + size : ''), esc(rb === 'ask' ? t('rbAsk') : st.biNew > 0 ? tn('rbDoneN', st.biNew) : t('rbDoneBubble')));
        n.dataset.testid = 'rebuy-bubble-' + seat;
        if (rb === 'done') n.style.animationDelay = rbDoneDelay(st);
        n.style.left = cx + 'px'; n.style.top = top + 'px';
        parent.appendChild(n);
        return;
    }
    if (!b) return;
    const word = ACT_WORD[b.a] ?? '';
    const withAmt = b.amt > 0 && b.a !== 'FOLD' && b.a !== 'CHECK';
    const node = el('div', 'bubble' + (b.a === 'FOLD' ? ' fold' : '') + (b.a === 'ALL_IN' ? ' allin' : '') + (size ? ' ' + size : ''));
    node.innerHTML = (withAmt ? '<i class="dot"></i>' : '') + [word, withAmt ? dm(b.amt) : ''].filter(Boolean).map(esc).join(' ');
    node.style.left = cx + 'px'; node.style.top = top + 'px'; node.style.transform = 'translateX(-50%)';
    parent.appendChild(node);
}

/** 결과 — 이름 상자 아래 "Pair, 8's +805", 이긴 사람 아바타 위 WINNER */
function resultFor(parent, seat, cx, top, ax, ay, size = '') {
    // [SHOWDOWN_SEQ_0_10_4] 보통 쇼다운은 카드를 연 자리부터 족보 글자 — 승자·금액은 다 연 뒤에
    if (!S.winners) {
        const rk = S.sd && S.sd.ranks && S.hand && S.sd.handId === S.hand.handId && seat !== mySeat() && sdShown(seat) ? S.sd.ranks[seat] : '';
        if (rk) { const n = el('div', 'seat-note sd-rank' + (size ? ' ' + size : ''), esc(rk)); n.style.left = cx + 'px'; n.style.top = top + 'px'; parent.appendChild(n); }
        return;
    }
    const won = S.winners.seats[seat];
    const hand = S.reveal[seat] || seat === mySeat() ? S.winners.hands[seat] : '';
    if (hand || won) {
        const n = el('div', 'seat-note' + (size ? ' ' + size : ''), (hand ? esc(hand) : '') + (won ? ` <b>+${dm(won)}</b>` : ''));
        n.style.left = cx + 'px'; n.style.top = top + 'px';
        parent.appendChild(n);
    }
    if (won) {
        const w = el('div', 'winner-tag' + (size ? ' ' + size : ''), (hand ? `<small>${esc(bigHandName(hand))}</small>` : '') + '<b>' + 'WINNER'.split('').map((c, i) => `<span style="--i:${i}">${c}</span>`).join('') + '</b>');
        w.style.left = ax + 'px'; w.style.top = (ay + 18) + 'px';
        parent.appendChild(w);
    }
}

/** 판에 건 칩 — PC 는 이름 상자 가장자리(팟 쪽)에 붙인다. 영웅 칩은 16px 위 */
function renderBets() {
    const box = $('#bets');
    box.innerHTML = '';
    if (!S.hand) return;
    for (const p of S.hand.seats) {
        if (!(p.bet > 0)) continue;
        const a = anchor(p.seat);
        const hero = p.seat === mySeat();
        let x, y;
        if (S.layout === 'pc') {
            if (hero) { x = a.x - 185 - 6 - 20 - 52; y = a.y - 30; }   // 영웅 이름 상자 왼쪽 — 감정·팁 버튼 줄 바깥
            else {
                const [dx, dy] = PC_ROLE_ADJ[a.role] || PC_ROLE_ADJ_DEFAULT;
                const leftSide = a.role >= 1 && a.role <= 4;
                const nbx = a.x + dx, nby = a.y + dy + 106 - 77 + 24;
                x = leftSide ? nbx + 81 + 6 + 20 : nbx - 51 - 6 - 20; y = nby;   // 이름 상자(상자 +15px) 팟 쪽 가장자리
            }
        } else if (hero) { x = 208; y = 548; }   // 모바일 화폭 — 영웅 칩은 판 가운데 아래
        else {
            const r = a.role, side = r <= 3 ? 1 : r >= 6 ? -1 : 0;
            const cx = mobileAvatarX(a);
            x = cx + side * 54; y = a.y + (side ? 47 : 80);
            if (r === 2 || r === 3 || r === 6 || r === 7) { x = cx + side * 62; y = a.y + 12; }
        }
        const b = el('div', 'bet');
        b.dataset.seat = p.seat;
        b.style.left = x + 'px'; b.style.top = y + 'px';
        const st = el('div', 'stack');
        st.style.transform = `scale(${S.layout === 'mobile' ? 0.65 : 0.85})`;
        st.appendChild(chipStackEl(Math.max(0.1, Math.round(p.bet * 100) / 100), { single: S.layout === 'mobile' }));
        b.appendChild(st);
        b.appendChild(el('div', 'amt', compact(p.bet)));
        box.appendChild(b);
    }
}

// ------------------------------------------------------------ 액션

function renderActions() {
    const box = $('#actions');   // act 라고 부르면 아래 프리셋의 act() 호출을 가린다
    const tr = S.turn;
    const meP = S.hand && S.hand.seats.find((x) => x.seat === mySeat());
    $('.room-label').classList.toggle('hide', S.layout === 'mobile');
    if (!tr || tr.seat !== mySeat() || !S.hand) {
        // 예약 액션 — 판에 들어 있고 아직 폴드·올인 전이면 폴드 자리가 「체크/폴드」 예약 버튼(예전 화면)
        if (S.hand && meP && !meP.folded && !meP.allIn && !S.winners) {
            box.hidden = false; box.classList.add('pre');
            const f = $('.a-fold');
            f.querySelector('.t').textContent = t('preCheckFold');
            let s2 = f.querySelector('.s'); if (!s2) { s2 = el('span', 's'); f.appendChild(s2); }
            const on = S.preAct === S.hand.handId;
            s2.textContent = on ? t('reserved') : '';
            f.classList.toggle('reserved', on);
            $('.a-call .t').textContent = t('call'); $('.a-call .s').textContent = '';
            $('.a-raise .t').textContent = t('raise'); $('.a-raise .s').textContent = '';
            $('.room-label').classList.add('hide');
        } else { box.hidden = true; box.classList.remove('pre'); }
        return;
    }
    box.hidden = false; box.classList.remove('pre');
    $('.a-fold').classList.remove('reserved');
    $('.a-fold .t').textContent = t('fold'); const fs = $('.a-fold .s'); if (fs) fs.textContent = '';
    $('.room-label').classList.add('hide');
    const me = S.hand.seats.find((x) => x.seat === mySeat());
    const call = $('.a-call'), raise = $('.a-raise');
    const stackAll = tr.maxBet;
    if (tr.toCall > 0) { call.querySelector('.t').textContent = tr.toCall >= me.stack ? t('allin') : t('call'); call.querySelector('.s').textContent = dmCur(tr.toCall); call.dataset.act = tr.toCall >= me.stack ? 'ALL_IN' : 'CALL'; }
    else { call.querySelector('.t').textContent = t('check'); call.querySelector('.s').textContent = ''; call.dataset.act = 'CHECK'; }
    const minTo = Math.min(stackAll, tr.currentBet > 0 ? tr.currentBet + tr.minRaise : Math.max(tr.minRaise, S.room.bb));
    const canRaise = stackAll > tr.currentBet && me.stack > tr.toCall;
    raise.disabled = !canRaise;
    const g = $('.gauge-input');
    g.min = minTo; g.max = stackAll; g.step = S.room.bb >= 1 ? 1 : 0.01;
    if (!(S.raiseVal >= minTo && S.raiseVal <= stackAll) || box.dataset.q !== String(tr.q)) S.raiseVal = minTo;
    box.dataset.q = tr.q;
    g.value = S.raiseVal;
    paintRaise();
    const pre = $('.presets');
    pre.innerHTML = '';
    const pot = S.hand.pot;
    const mobile = S.layout === 'mobile';
    const presets = mobile
        ? [[t('allin'), stackAll], [t('full'), pot + tr.currentBet], [t('half'), pot * 0.5 + tr.currentBet], [t('quarter'), pot * 0.25 + tr.currentBet]]
        : [['25%', pot * 0.25 + tr.currentBet], ['50%', pot * 0.5 + tr.currentBet], ['100%', pot + tr.currentBet], [t('allin'), stackAll]];
    for (const [label, val] of presets) {
        const v = Math.max(minTo, Math.min(stackAll, Math.round(val * 100) / 100));
        const b = el('button', '', `<span>${esc(label)}</span><small>${esc(dmCur(v))}</small>`);
        b.type = 'button';
        b.disabled = !canRaise;
        // 모바일은 누르면 바로 베팅(이전 게임 화면과 같다), PC 는 금액만 잡고 베팅 버튼으로 확정
        b.onclick = () => {
            S.raiseVal = v; g.value = v; paintRaise();
            if (mobile) act(raise.dataset.act, v); else raisingOn();
        };
        pre.appendChild(b);
    }
}

function paintRaise() {
    const tr = S.turn; if (!tr) return;
    const g = $('.gauge-input'), raise = $('.a-raise');
    const min = Number(g.min), max = Number(g.max), v = S.raiseVal;
    const ratio = max > min ? (v - min) / (max - min) : 1;
    const well = $('.gauge-well');
    $('.gauge-fill').style.width = (ratio * 100) + '%';
    const left = 27 + ratio * (well.clientWidth || 300) - 16;
    $('.gauge-handle').style.left = left + 'px';
    const allin = v >= max;
    raise.querySelector('.t').textContent = allin ? t('allin') : (tr.currentBet > 0 ? t('raise') : t('bet'));
    raise.querySelector('.s').textContent = dmCur(v);
    const gb = $('.gauge-bubble'); gb.hidden = false; gb.querySelector('b').textContent = compact(v); gb.querySelector('.cur').textContent = cur(); gb.style.left = (left + 16) + 'px';
    raise.dataset.act = allin ? 'ALL_IN' : (tr.currentBet > 0 ? 'RAISE' : 'BET');
}

function hideActions() { $('#actions').hidden = true; }

/** 「레이즈 중」 — 내 차례에 레이즈 금액을 만지기 시작하면 한 번 알린다(같은 방 모두의 화면에 내 자리 위 Raising…) */
function raisingOn() {
    const tr = S.turn;
    if (!tr || tr.seat !== mySeat()) return;
    const key = tr.handId + ':' + tr.q;
    if (S.raisingSent === key) return;
    S.raisingSent = key;
    cmd('raising', { active: true }).catch(() => {});
}

async function act(action, amount) {
    const tr = S.turn;
    if (!tr || tr.seat !== mySeat() || !S.keys) return;
    // 같은 차례는 한 번만 — 서명하는 동안 다시 눌러도 두 번 보내지 않는다
    if (S.acting === tr.handId + ':' + tr.q) return;
    S.acting = tr.handId + ':' + tr.q;
    hideActions();
    const amt = action === 'RAISE' || action === 'BET' ? Number(amount) : 0;
    const sig = await V.sign(S.keys, V.msg.action(tr.handId, tr.q, action, amt));
    const r = await cmd('act', { q: tr.q, action, amount: amt, sig });
    if (!r.ok) { toast(r.error || 'action failed'); render(); }
}

function wireButtons() {
    $('.a-fold').onclick = () => {
        if ($('#actions').classList.contains('pre')) {   // 예약 켜고 끄기
            if (!S.hand) return;
            S.preAct = S.preAct === S.hand.handId ? '' : S.hand.handId;
            renderActions();
            return;
        }
        act('FOLD');
    };
    $('.a-call').onclick = (e) => act(e.currentTarget.dataset.act);
    $('.a-raise').onclick = (e) => act(e.currentTarget.dataset.act, S.raiseVal);
    $('.gauge-input').oninput = (e) => { S.raiseVal = Number(e.target.value); paintRaise(); raisingOn(); };
    $('.gauge-input').addEventListener('pointerdown', raisingOn);
    $('.rb-go').onclick = async () => {   // [REBUY_0_10_1] 말풍선 → 로비의 바이인 신청(처음 앉을 때와 같은 신청·승인·좌석표)
        if (!S.token || !S.room) return;
        try { await cmd('rebuy'); } catch (_e) { /* 말풍선은 덤 */ }
        sessionStorage.removeItem('buyin.token');   // 정산된 자리 — 돌아올 때는 새 좌석표로 앉는다
        location.href = `${LOBBY_URL}/game/?room_id=${encodeURIComponent(S.room.id)}`;
    };
    $('#btn-leave').onclick = async () => {
        if (!S.token) return;
        const r = await cmd('leave');
        if (r.ok && r.pending) toast(t('leftAfter'));
    };
    $('#btn-sound').onclick = (e) => { S.sound = !S.sound; e.currentTarget.classList.toggle('on', !S.sound); if (S.sound) play('check'); };
    // 설정 — 소리 크기(예전 화면의 설정 창)
    const vol = $('#st-vol');
    const paintVol = () => { vol.value = S.vol; $('.st-vv').textContent = Math.round(S.vol * 100); };
    const setVol = (v) => { S.vol = Math.max(0, Math.min(1, Number(v) || 0)); try { localStorage.setItem('buyin.vol', String(S.vol)); } catch (_e) { /* */ } paintVol(); };
    $('#btn-settings').onclick = () => { paintVol(); $('#settings').hidden = false; };
    vol.oninput = () => setVol(vol.value);
    vol.onchange = () => play('check');
    document.querySelectorAll('.st-pre button').forEach((b) => { b.onclick = () => { setVol(b.dataset.v); play('check'); }; });
    $('.st-x').onclick = () => { $('#settings').hidden = true; };
    $('#settings').onclick = (e) => { if (e.target.id === 'settings') $('#settings').hidden = true; };
    // 채팅 — PC 왼쪽 아래 패널(머리줄을 누르면 펼침), 모바일 💬
    $('#chat .chat-head').onclick = () => {
        const c = $('#chat'); c.classList.toggle('closed');
        if (!c.classList.contains('closed')) { $('#chat .chat-head .dot').hidden = true; renderChat(); $('#chat .chat-input').focus(); }
    };
    $('#btn-chat-m').onclick = (e) => { e.stopPropagation(); $('#chat-m').hidden = false; $('#btn-chat-m .dot').hidden = true; renderChat(); $('#chat-m .chat-input').focus(); };
    $('#chat-m .chat-x').onclick = () => { $('#chat-m').hidden = true; };
    for (const root of ['#chat', '#chat-m']) {
        $(root + ' .chat-send').onclick = () => sendChat(root);
        $(root + ' .chat-input').onkeydown = (e) => { if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); sendChat(root); } };
    }
    $('#btn-dark').onclick = () => toggleDark();
    $('.room-label').onclick = () => {
        const txt = $('.room-label').textContent;
        try { navigator.clipboard.writeText(txt).then(() => toast(t('copied'), 1500), () => toast(txt, 1500)); } catch (_e) { toast(txt, 1500); }
    };
    $('#tip-target .tt-x').onclick = () => endTipPick();
    document.addEventListener('pointerdown', (e) => {
        if (!e.target.closest('#emote-pick, .hero-btns')) $('#emote-pick').hidden = true;
        if (!e.target.closest('#tip-pick, .hero-btns')) $('#tip-pick').hidden = true;
        if (S.tipGift && !e.target.closest('.avatar.tip-target, #tip-target, #tip-pick, .hero-btns')) endTipPick();
        if (!$('#chat-m').hidden && !e.target.closest('#chat-m, #btn-chat-m')) $('#chat-m').hidden = true;
    });
    // 소리는 처음 손댈 때 켜진다(브라우저 규칙). 앱에 돌아온 뒤에도 첫 터치에서 다시 살린다
    document.addEventListener('pointerdown', () => { if (audio()) preloadSfx(); }, { passive: true });
    $('#btn-verify').onclick = () => window.open('verify.html', '_blank', 'noopener');
    // 들어온 화면(로비)으로 — 이 화면은 새 주소를 알 필요 없이 브라우저 기록으로 돌아간다
    $('.gate-back').onclick = () => { if (history.length > 1) history.back(); else window.close(); };
    $('.verify-badge button').onclick = () => showProof();
    S.timerTick = setInterval(() => {
        const dots = '.'.repeat(Math.floor(Date.now() / 400) % 4);
        document.querySelectorAll('.raising .dots').forEach((d) => { d.textContent = dots; });
        const bar = $('.turnbar');
        bar.hidden = !(S.turn && S.layout === 'mobile' && S.turn.seat === mySeat());
        if (!S.turn) return;
        if (!bar.hidden) bar.firstChild.style.width = (Math.min(1, Math.max(0, (S.turn.deadline - Date.now()) / (S.room.turnSec * 1000))) * 100).toFixed(1) + '%';
        const left = Math.max(0, (S.turn.deadline - Date.now()) / 1000);
        const secEl = $('.tsec'); if (secEl) secEl.textContent = Math.ceil(left);
        const frac = S.room ? Math.min(1, left / S.room.turnSec) : 0;
        document.querySelectorAll('.ring-arc').forEach((c) => c.setAttribute('stroke-dasharray', `${(frac * 100).toFixed(1)} 100`));
    }, 250);
}

// ------------------------------------------------------------ 확인 표시

function renderBadge() {
    const b = $('.verify-badge');
    const bad = S.att === 'mismatch' || S.holeOk === false || S.cardsOk === false;
    const ok = S.att === 'ok' && S.holeOk !== false && S.cardsOk !== false;
    b.classList.toggle('warn', bad);
    $('.vb-state').textContent = bad ? t('warn') : ok ? t('verified') : t('checking');
}

function showProof() {
    const lines = [
        `${t('cardCheck')}: ${S.holeOk === null ? '—' : S.holeOk ? t('verified') : t('warn')}`,
        `TEE: ${S.att === 'ok' ? t('attOk') : S.att === 'mismatch' ? t('attBad') : t('checking')}`,
    ];
    if (S.engine) lines.push(`engine sig ${S.engine.sigFp || ''}`);
    if (S.keys) lines.push(`my key ${S.keys.sigFp}`);
    if (S.hand) lines.push(`hand ${S.hand.handId}`, `deck ${String(S.hand.deckCommit || '').slice(0, 16)}…`);
    toast(lines.join('\n'), 6000);
}

// ------------------------------------------------------------ 알림 · 소리

let toastTimer = null;
function toast(msg, ms = 2600) {
    const n = $('#toast');
    n.textContent = msg; n.style.whiteSpace = 'pre-line'; n.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { n.hidden = true; }, ms);
}
/** 안내 화면. back = 자리가 닫혔다 — 들어온 화면(로비)으로 돌아가는 버튼을 보인다 */
function gate(msg, back = false) {
    $('.gate-msg').textContent = msg;
    $('.gate-back').hidden = !back;
    $('#gate').hidden = false;
}

function hideGate() { $('#gate').hidden = true; }

// 효과음 — 이전 게임과 같은 파일(리소스 서버 sfx/)을 받아 Web Audio 로 재생한다. 받기만 하고 아무것도 보내지 않는다
let actx = null;
const sfxBuf = new Map();
const SFX_ALL = ['fold', 'check', 'call', 'bet', 'raise', 'allin', 'minichip', 'raise_chip', 'allin_chip', 'card', 'turn', 'win', 'start', 'showdown'];
const ACT_SFX = { FOLD: ['fold'], CHECK: ['check'], CALL: ['call', 'minichip'], BET: ['bet', 'raise_chip'], RAISE: ['raise', 'raise_chip'], ALL_IN: ['allin', 'allin_chip'] };
function audio() {
    try {
        if (actx && actx.state !== 'running' && actx.state !== 'suspended') { actx.close().catch(() => {}); actx = null; }   // iOS 'interrupted' — 새로 만든다
        if (!actx) actx = new (window.AudioContext || window.webkitAudioContext)();
        if (actx.state === 'suspended') actx.resume().catch(() => {});
        return actx;
    } catch (_e) { return null; }
}
function loadSfx(name) {
    if (!sfxBuf.has(name)) {
        sfxBuf.set(name, fetch(`${ASSET}sfx/${name}.mp3${AV}`)
            .then((r) => { if (!r.ok) throw new Error('sfx ' + r.status); return r.arrayBuffer(); })
            .then((ab) => audio().decodeAudioData(ab))   // 약속(promise) 형태만 — 콜백과 같이 쓰면 실패가 따로 새어 나간다
            .catch(() => { sfxBuf.delete(name); return null; }));
    }
    return sfxBuf.get(name);
}
let preloaded = false;
function preloadSfx() { if (preloaded) return; preloaded = true; for (const n of SFX_ALL) loadSfx(n); }
function play(name, vol = 0.6) {
    if (!S.sound) return;
    const ctx = audio();
    if (!ctx || ctx.state !== 'running') return;   // 아직 손대기 전 — 쌓아 두지 않는다(풀릴 때 한꺼번에 나지 않게)
    loadSfx(name).then((b) => {
        if (!b || !S.sound) return;
        const src = ctx.createBufferSource(), g = ctx.createGain();
        g.gain.value = vol * S.vol; src.buffer = b; src.connect(g).connect(ctx.destination); src.start();
    });
}
function sfx(action) { for (const n of ACT_SFX[action] || []) play(n); }

// ------------------------------------------------------------ 이모티콘 · 채팅 · 타임뱅크 (카드·칩과 무관 — TEE 가 같은 방에 전달만 한다)

const EMOTES = ['angry', 'sad', 'win', 'taunt', 'thanks', 'chill', 'sleepy', 'clap'];
const rateMsg = (r) => (r.code === 'rate' ? t('tooFast') : (r.error || ''));

/** 감정·선물 그림은 들어오자마자 미리 받아 둔다 — 창을 처음 열 때 빈 타일로 보이지 않게 */
const pickImgs = [];
function preloadPickImages() {
    if (pickImgs.length) return;
    for (const id of EMOTES) { const im = new Image(); im.src = `${ASSET}emo/emo_${id}.jpg${AV}`; pickImgs.push(im); }
    for (const id of GIFTS) { const im = new Image(); im.src = `${ASSET}tip/${id}.png${AV}`; pickImgs.push(im); }
}

/** 감정 고르기 — 이름 상자 옆 버튼에서 연다. 2열 그림 타일(예전 화면), 한 판에 한 번. 타일은 한 번만 만들어 다시 쓴다 */
function openEmotePick(anchorEl) {
    const box = $('#emote-pick');
    if (!box.hidden) { box.hidden = true; return; }
    $('#tip-pick').hidden = true;
    if (box.childElementCount) { placePop(box, anchorEl); return; }
    for (const id of EMOTES) {
        const b = el('button', '', `<img alt="" src="${ASSET}emo/emo_${id}.jpg${AV}"><small>${esc(t('emo_' + id))}</small>`);
        b.type = 'button'; b.dataset.emote = id;
        b.onclick = async () => {
            box.hidden = true;
            if (S.hand && S.emoteHand === S.hand.handId) return toast(t('emoOnce'));
            const r = await cmd('emote', { id });
            if (!r.ok) return toast(rateMsg(r));
            if (S.hand) S.emoteHand = S.hand.handId;
        };
        box.appendChild(b);
    }
    placePop(box, anchorEl);
}

/** 버튼 옆에 띄운다 — PC 는 버튼 왼쪽 세로 가운데, 모바일은 버튼 위 */
function placePop(box, anchorEl) {
    box.hidden = false;
    const r = anchorEl.getBoundingClientRect(), bw = box.offsetWidth, bh = box.offsetHeight;
    let x, y;
    if (S.layout === 'mobile') { x = r.left; y = r.top - bh - 8; }
    else { x = r.left - bw - 10; y = r.top + r.height / 2 - bh / 2; }
    box.style.left = Math.max(8, Math.min(innerWidth - bw - 8, x)) + 'px';
    box.style.top = Math.max(8, Math.min(innerHeight - bh - 8, y)) + 'px';
}

/** 좌석 아바타의 화면 위치 — 효과는 좌석 그림과 따로 #fx 층에 띄운다(좌석은 이벤트마다 다시 그려진다) */
function avatarRect(seat) {
    const a = document.querySelector(`#seats .seat[data-seat="${seat}"] .avatar`);
    return a ? a.getBoundingClientRect() : null;
}

/** 감정 — 그 사람 아바타 원 안에서 영상이 한 번 돈다(예전 화면과 같은 파일) */
function showEmote(d) {
    const r = avatarRect(d.seat);
    if (!r || !EMOTES.includes(d.id)) return;
    const box = el('div', 'emo-fx');
    box.dataset.emote = d.id;
    box.style.left = r.left + 'px'; box.style.top = r.top + 'px'; box.style.width = r.width + 'px'; box.style.height = r.height + 'px';
    const v = document.createElement('video');
    v.muted = true; v.playsInline = true; v.autoplay = true; v.setAttribute('playsinline', '');
    v.onended = () => box.remove();
    v.onerror = () => box.remove();
    v.src = `${ASSET}emo/emo_${d.id}.mp4${AV}`;
    box.appendChild(v);
    $('#fx').appendChild(box);
    setTimeout(() => box.remove(), 4500);
}

function floatTag(seat, text) {
    const r = avatarRect(seat);
    if (!r) return;
    const b = el('div', 'tag-fx');
    b.textContent = text;
    b.style.left = (r.left + r.width / 2) + 'px'; b.style.top = (r.top + r.height / 2) + 'px';
    $('#fx').appendChild(b);
    setTimeout(() => b.remove(), 1600);
}

// ------------------------------------------------------------ 채팅 (받는 사람 언어로 번역 — 예전 화면과 같은 번역기)

/** 번역은 게임서버의 번역 주소에 받은 글 한 줄만 보낸다(카드·게임 정보 없음). 결과가 원문과 같으면 원문만 */
const TRANSLATE_URL = 'https://buyinholdem.com/chat-translate';
const LOBBY_URL = 'https://buyinholdem.com';   // [REBUY_0_10_1] 재바이인 — 로비의 바이인 신청 화면
async function translateLine(m) {
    if (m.seat === mySeat() || m.trTried) return;
    m.trTried = true;
    try {
        const res = await fetch(TRANSLATE_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: m.text, to: getLang() }), cache: 'no-store' });
        const j = await res.json();
        if (j && j.ok && j.text && j.text.trim() !== m.text.trim()) {
            m.tr = j.text; m.showTr = true;
            renderChat();
            const b = document.querySelector(`.chat-fx[data-id="${m.id}"]`);
            if (b) b.textContent = short(m.tr);
        }
    } catch (_e) { /* 번역이 안 되면 원문만 */ }
}
const short = (s) => (s.length > 12 ? s.slice(0, 12) + '…' : s);
const hhmm = (ms) => { const d = new Date(ms); return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0'); };

function onChat(d) {
    const m = { ...d, id: (d.at || Date.now()) + '-' + d.seat };
    S.chat.push(m);
    if (S.chat.length > 100) S.chat.shift();
    const dockOpen = !$('#chat').classList.contains('closed'), mOpen = !$('#chat-m').hidden;
    if (d.seat !== mySeat()) {
        if (!dockOpen) $('#chat .chat-head .dot').hidden = false;
        if (!mOpen) $('#btn-chat-m .dot').hidden = false;
    }
    renderChat();
    translateLine(m);
    if (d.seat === mySeat()) return;   // 내 말은 내 자리에 말풍선을 띄우지 않는다(예전 화면)
    const r = avatarRect(d.seat);
    if (!r) return;
    const b = el('div', 'chat-fx');
    b.dataset.id = m.id;
    b.textContent = short(m.tr || d.text);   // 글자로만 넣는다(HTML 로 해석하지 않는다)
    b.style.left = (r.left + r.width / 2) + 'px'; b.style.top = (r.top - (S.layout === 'mobile' ? 6 : 10)) + 'px';
    $('#fx').appendChild(b);
    setTimeout(() => b.remove(), 4000);
}

function renderChat() {
    for (const box of document.querySelectorAll('#chat .chat-lines, #chat-m .chat-lines')) {
        box.innerHTML = '';
        for (const m of S.chat) {
            const line = el('div', 'chat-line' + (m.seat === mySeat() ? ' me' : ''));
            const n = el('b'); n.textContent = m.nickname;
            const x = el('span'); x.textContent = m.tr && m.showTr ? m.tr : m.text;
            line.append(n, x);
            const tm = el('span', 'tm'); tm.textContent = hhmm(m.at || Date.now()); line.appendChild(tm);
            if (m.tr) {
                const tg = el('button', 'tr'); tg.type = 'button'; tg.textContent = m.showTr ? t('translated') : t('original');
                tg.onclick = () => { m.showTr = !m.showTr; renderChat(); };
                line.appendChild(tg);
            }
            box.appendChild(line);
        }
        box.scrollTop = box.scrollHeight;
    }
}

async function sendChat(root = '#chat') {
    const i = $(root + ' .chat-input');
    const text = i.value.trim();
    if (!text) return;
    if (Date.now() - S.chatAt < 400) return toast(t('tooFast'));
    S.chatAt = Date.now();
    const r = await cmd('chat', { text: text.slice(0, 200) });
    if (r.ok) i.value = ''; else toast(rateMsg(r));
}

// ------------------------------------------------------------ 팁 (칩이 움직인다 — 내 서명 키로 서명해 보낸다. 금액은 그 방 BB 1개, 프리플랍에서만)

const GIFTS = ['flower', 'kiss', 'confetti', 'cigarette', 'champagne'];

/** 이름 상자 옆 선물 버튼 → 아이콘 3열에서 하나 고르기 → 받을 사람 고르기(예전 화면) */
function openTipPick(anchorEl) {
    const box = $('#tip-pick');
    if (!box.hidden) { box.hidden = true; return; }
    $('#emote-pick').hidden = true;
    if (!S.room) return;
    box.innerHTML = '';
    box.appendChild(el('div', 'tip-head', `<b>${esc(t('tipHint'))}</b><span>${esc(dmCur(S.room.bb))}</span>`));
    const grid = el('div', 'tip-grid');
    const can = S.hand && S.hand.stage === 'preflop' && !S.winners;
    for (const id of GIFTS) {
        const b = el('button', '', `<img alt="" src="${ASSET}tip/${id}.png${AV}"><small>${esc(t('gift_' + id))}</small>`);
        b.type = 'button'; b.dataset.gift = id; b.disabled = !can;
        b.onclick = (e) => { e.stopPropagation(); box.hidden = true; startTipPick(id); };
        grid.appendChild(b);
    }
    box.appendChild(grid);
    if (!can) box.appendChild(el('div', 'tip-note', esc(t('tipPreflop'))));
    placePop(box, anchorEl);
}

function startTipPick(gift) {
    S.tipGift = gift;
    $('#tip-target .tt-msg').textContent = `${t('gift_' + gift)} · ${t('tipPick')}`;
    $('#tip-target').hidden = false;
    render();
}
function endTipPick() {
    if (!S.tipGift && $('#tip-target').hidden) return;
    S.tipGift = '';
    $('#tip-target').hidden = true;
    render();
}

async function sendTip(seat, gift) {
    const to = S.seats[seat];
    if (!to || !S.keys || !S.me || !S.room) return;
    const n = (S.me.tipN || 0) + 1;
    const sig = await V.sign(S.keys, V.msg.tip(S.tableId, S.me.odcId, n, seat, gift, S.room.bb));
    const r = await cmd('tip', { to: seat, gift, n, sig });
    if (r.ok) S.me.tipN = n;
    else toast(r.code === 'rate' ? t('tooFast') : (r.error || ''));
}

/** 선물이 보낸 사람 아바타에서 받는 사람 아바타로 포물선을 그리며 날아가고, 받는 자리 위에 금액이 떠오른다 */
function flyGift(from, to, gift, amount) {
    const a = avatarRect(from), b = avatarRect(to);
    if (!a || !b || !GIFTS.includes(gift)) return;
    const g = el('div', 'gift-fx', `<img alt="" src="${ASSET}tip/${gift}.png${AV}">`);
    const x0 = a.left + a.width / 2, y0 = a.top + a.height / 2, x1 = b.left + b.width / 2, y1 = b.top + b.height / 2;
    const top = Math.min(y0, y1) - 60;
    g.style.left = '0px'; g.style.top = '0px';
    $('#fx').appendChild(g);
    const at = (x, y, s) => `translate(${x - 28}px, ${y - 28}px) scale(${s})`;
    g.animate([
        { transform: at(x0, y0, 0.5), opacity: 0, offset: 0 },
        { transform: at((x0 + x1) / 2, top, 1.1), opacity: 1, offset: 0.45 },
        { transform: at(x1, y1, 1), opacity: 1, offset: 0.75 },
        { transform: at(x1, y1, 1.5), opacity: 0, offset: 1 },
    ], { duration: 1500, easing: 'ease-in-out', fill: 'forwards' });
    setTimeout(() => g.remove(), 1600);
    setTimeout(() => tipBadge(to, amount != null ? amount : (S.room && S.room.bb), t('tipQueued')), 1100);
}

function tipBadge(seat, amount, status) {
    const r = avatarRect(seat);
    if (!r) return;
    const b = el('div', 'tip-badge', `<b>+${esc(dm(amount))}</b><small>${esc(status)}</small>`);
    b.style.left = (r.left + r.width / 2) + 'px'; b.style.top = (r.top - 26) + 'px';   // 말풍선(베팅 표시) 위로
    $('#fx').appendChild(b);
    setTimeout(() => b.remove(), 3100);
}

// ------------------------------------------------------------ 인 더 다크 (다음 판 내 패를 보지 않고 친다 — 한 판짜리 예약)

async function toggleDark() {
    const r = await cmd('dark', { on: !S.darkNext });
    if (r.ok) { S.darkNext = !!r.reserved; paintDark(); render(); } else toast(r.error || '');
}
function paintDark() {
    const b = $('#btn-dark');
    b.classList.toggle('on', S.darkNext);
    $('.dk-sub').textContent = S.darkNext ? t('darkOn') : t('darkSub');
}
/** 판이 끝나면 이번 판 내 패를 4.5초 보여 준다(예전 화면) */
function showDarkReveal() {
    const cards = S.hole && S.holeHandId === S.darkHand ? S.hole.map(codeOf) : [];
    S.darkHand = '';
    if (!cards.length) return;
    const box = $('#dark-reveal'), row = $('.dr-cards', box);
    row.innerHTML = '';
    for (const c of cards) { const w = el('div'); w.appendChild(cardEl(c)); row.appendChild(w); }
    box.hidden = false;
    setTimeout(() => { box.hidden = true; }, 4500);
}

// ------------------------------------------------------------ GAME START · SHOWDOWN · 카드 나눠 주기 · 방·핸드 번호

let bannerTimer = null;
function showBanner(title, ms, showdown = false) {
    if (!S.live) return;
    const bn = $('#banner');
    bn.querySelectorAll('.sd-img').forEach((x) => x.remove());
    $('.bn-title', bn).textContent = title;
    bn.classList.toggle('long', ms > 2500);
    if (showdown) {
        for (const [f, anim] of [['show', 'sd-left'], ['down', 'sd-right']]) {
            const im = el('img', 'sd-img'); im.alt = ''; im.src = `${ASSET}fx/${f}.webp${AV}`; im.style.setProperty('--anim', anim);
            bn.appendChild(im);
        }
    }
    bn.hidden = true; void bn.offsetWidth; bn.hidden = false;   // 애니메이션을 처음부터
    clearTimeout(bannerTimer);
    bannerTimer = setTimeout(() => { bn.hidden = true; }, ms);
}

/** 판 시작 — 팟 가운데서 SB 부터 시계 방향으로 한 장씩 두 바퀴 날아간다(110ms 간격, 0.62초) */
function dealFx(h) {
    if (!S.live || document.hidden) return;
    const pot = $('.pot-panel');
    if (!pot) return;
    const pr = pot.getBoundingClientRect();
    const x0 = pr.left + pr.width / 2, y0 = pr.top + pr.height / 2;
    const order = [...h.seats.map((p) => p.seat)].sort((a, b) => a - b);
    const start = order.indexOf(h.sb) >= 0 ? order.indexOf(h.sb) : 0;
    const seq = [...order.slice(start), ...order.slice(0, start)];
    const mobile = S.layout === 'mobile';
    const w = mobile ? 22 : 40, hh = mobile ? 31 : 56;
    let i = 0;
    for (let round = 0; round < 2; round++) {
        for (const seat of seq) {
            const delay = (i++) * 110;
            setTimeout(() => {
                const r = avatarRect(seat);
                if (!r) return;
                const x1 = r.left + r.width / 2, y1 = r.top + r.height / 2;
                const c = el('div', 'deal-fx');
                c.style.width = w + 'px'; c.style.height = hh + 'px';
                c.style.backgroundImage = `url('${ASSET}img/card_back.jpg${AV}')`;
                c.style.left = '0px'; c.style.top = '0px';
                $('#fx').appendChild(c);
                const at = (x, y, s, rot) => `translate(${x - w / 2}px, ${y - hh / 2}px) scale(${s}) rotate(${rot}deg)`;
                const midY = Math.min(y0, y1) - innerHeight * 0.06;
                c.animate([
                    { transform: at(x0, y0, 0.45, 0), opacity: 0, offset: 0 },
                    { transform: at((x0 + x1) / 2, midY, 0.8, 4), opacity: 1, offset: 0.5 },
                    { transform: at(x1, y1, 1, 8), opacity: 1, offset: 0.8 },
                    { transform: at(x1, y1, 1, 8), opacity: 0, offset: 1 },
                ], { duration: 620, easing: 'ease-out', fill: 'forwards' });
                setTimeout(() => c.remove(), 680);
            }, delay);
        }
    }
}

/** 방·핸드 번호 — 예전 화면처럼 `Room #방 · Hand #6자리`(판 번호 그대로가 아니라 해시) */
function paintRoomLabel() {
    const lb = $('.room-label');
    if (!S.room) return;
    let hash = '';
    if (S.hand) {
        let x = 0x811c9dc5;
        const s = `hp_v1_${S.room.id}_${S.hand.handId}`;
        for (let k = 0; k < s.length; k++) { x ^= s.charCodeAt(k); x = Math.imul(x, 0x01000193) >>> 0; }
        hash = x.toString(36).toUpperCase().padStart(6, '0').slice(-6);
    }
    lb.textContent = `Room #${S.room.id}` + (hash ? ` · Hand #${hash}` : '');
}

/** 타임뱅크 — 내 차례에, 한 차례에 한 장, 남은 장수가 있을 때만 보인다 */
function timeBankButton(parent, x, y, size = '') {
    const tr = S.turn;
    if (!S.me || !(S.me.timeBank > 0) || !tr || tr.seat !== mySeat()) return;
    const key = tr.handId + ':' + tr.q;
    if (S.tbUsed === key) return;
    const b = el('button', 'tb' + (size ? ' ' + size : ''), `+20s <small>×${S.me.timeBank}</small>`);
    b.type = 'button'; b.dataset.testid = 'timebank'; b.title = t('timeBank');
    b.style.left = x + 'px'; b.style.top = y + 'px';
    b.onclick = async (e) => {
        e.stopPropagation();
        S.tbUsed = key; b.remove();
        const r = await cmd('timebank');
        if (!r.ok) { S.tbUsed = ''; toast(r.error || ''); render(); }
    };
    parent.appendChild(b);
}

boot();
