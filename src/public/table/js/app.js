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
import { t, setLang, applyStatic } from './i18n.js';
import { liveHandName, prettyRank, bigHandName } from './hand.js';

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
};

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

    const saved = sessionStorage.getItem('buyin.token');
    if (saved) { S.token = saved; return listen(); }
    if (!S.ticket) return gate(t('noTicket'));
    gate(t('joining'));
    try {
        const r = await post('/table/join', { ticket: S.ticket });
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
    on('seat', (d) => { const x = d.seat; S.seats[x.seat] = x.empty ? null : x; if (S.me && x.seat === S.me.seat && !x.empty) Object.assign(S.me, x); render(); });
    on('hand', onHand);
    on('hole', (d) => openHole(d));
    on('turn', (d) => { S.turn = d; if (S.hand) { S.hand.toAct = d.seat; S.hand.q = d.q; } render(); });
    on('action', onAction);
    on('board', (d) => { if (!S.hand) return; S.hand.board.push(...d.cards); S.hand.stage = d.stage; clearBets(); render(); });
    on('runout', (d) => { if (!S.hand) return; Object.assign(S.reveal, d.holes || {}); for (const x of d.stages || []) S.hand.board.push(...x.cards); clearBets(); render(); });
    on('result', onResult);
    on('aborted', () => { S.hand = null; S.turn = null; render(); });
    on('settled', (d) => { sessionStorage.removeItem('buyin.token'); es.close(); gate(`${t('settled')} ${dmCur(d.cashOut)}`); });
    on('error', (d) => { if (d && d.code === 'auth') { sessionStorage.removeItem('buyin.token'); es.close(); gate(t('noTicket')); } else if (d && d.error) toast(d.error); });
    es.onopen = () => { S.retry = 0; };
}

// ------------------------------------------------------------ 이벤트

async function onSnapshot(d) {
    S.snap = d; S.room = d.room; S.tableId = d.tableId; S.me = d.me; S.seats = d.seats; S.engine = S.engine || d.engine;
    S.hand = d.hand ? { ...d.hand, board: [...d.hand.board] } : null;
    S.turn = d.turn; S.reveal = (d.hand && d.hand.reveal) || {};
    $('.room-label').textContent = `${d.room.name} · ${dm(d.room.sb)}/${dm(d.room.bb)}`;
    hideGate();
    if (!d.me.keys || !S.keys) await registerKeys();
    if (d.hole && d.hole.envelope) await openHole(d.hole);
    await sendEntropy(d.hand ? d.hand.nextSeedCommit : d.seedCommit);
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
    S.hand = { ...h, board: [...h.board] };
    S.turn = null; S.reveal = {}; S.bubbles = {}; S.winners = null; S.hole = null; S.holeOk = null;
    for (const p of h.seats) {
        if (S.seats[p.seat]) S.seats[p.seat].stack = p.stack;
        if (p.bet > 0) S.bubbles[p.seat] = { a: 'BLIND', amt: p.bet, at: Date.now() };
    }
    sendEntropy(h.nextSeedCommit);
    render();
}

async function openHole(d) {
    if (!d.envelope || !S.keys || !S.engine) return;
    try {
        const cards = await V.openEnvelope(S.keys, S.engine.ecdh, d.handId, d.envelope);
        const commits = S.hand && S.hand.handId === d.handId ? S.hand.commitments : null;
        let ok = !!commits;
        for (const c of cards) ok = ok && await V.checkOpening(d.handId, commits, c);
        S.hole = cards; S.holeOk = ok; S.holeHandId = d.handId;
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
    if (S.turn && S.turn.seat === d.seat) S.turn = null;
    if (d.seat === mySeat()) hideActions();
    sfx(d.action);
    render();
}

function onResult(d) {
    if (!S.hand) return;
    if (d.holes) Object.assign(S.reveal, d.holes);
    if (d.board) S.hand.board = d.board.map(codeOf);
    S.hand.peekBoard = d.peekBoard;
    for (const [seat, st] of Object.entries(d.stacks || {})) if (S.seats[seat]) S.seats[seat].stack = st;
    const r = d.result || {};
    const win = {};
    if (r.type === 'uncontested') win[r.winner] = (win[r.winner] || 0) + r.amount;
    else for (const w of r.winners || []) if (!w.isUncalledReturn) win[w.seat] = (win[w.seat] || 0) + (w.net || 0);
    const real = (r.winners || []).filter((w) => !w.isUncalledReturn);
    const cards = new Set(real.flatMap((w) => w.winningCards || []).map(codeOf));
    const hands = Object.fromEntries((r.hands || []).filter((h) => h.handRank).map((h) => [h.seat, prettyRank(h.handRank)]));
    const top = real.find((w) => hands[w.seat]);
    S.winners = { seats: win, hands, cards, big: top ? bigHandName(hands[top.seat]) : '' };
    S.turn = null; S.hand.toAct = null;
    for (const p of S.hand.seats) p.bet = 0;   // 말풍선은 남긴다(운영 화면처럼 마지막 액션이 보인다)
    hideActions();
    render();
    const hid = d.handId;
    setTimeout(() => { if (S.hand && S.hand.handId === hid) { S.hand = null; S.winners = null; S.reveal = {}; S.hole = null; render(); } }, 3800);
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
    $('.bg-img').src = portrait ? 'img/bg_mobile.jpg' : 'img/bg_pc.jpg';
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
    renderBadge();
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
    const peek = h && h.peekBoard ? h.peekBoard.map(codeOf) : [];
    for (let k = 0; k < 5; k++) {
        const slot = el('div', 'slot');
        if (cards[k]) slot.appendChild(cardEl(cards[k], winLook(cards[k])));
        else if (peek[k - cards.length]) slot.appendChild(cardEl(peek[k - cards.length], { dim: true }));
        board.appendChild(slot);
    }
    $('#table').classList.toggle('waiting', !h);
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
            const im = el('img'); im.src = `img/${CHIP_FILE[v]}.webp`; im.alt = ''; im.style.transform = `rotate(${rot}deg) translateX(${xo}px)`;
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
        const node = el('div', 'seat' + (hero ? ' hero' : '') + (inHand && inHand.folded ? ' folded' : '') + (s.sitout ? ' sitout' : '')
            + (S.winners && S.winners.seats[seat] ? ' winner-glow' : ''));
        node.dataset.seat = seat;
        node.style.left = a.x + 'px';
        node.style.top = a.y + 'px';
        const draw = S.layout === 'mobile' ? (hero ? heroSeatMobile : otherSeatMobile) : (hero ? heroSeat : otherSeat);
        draw(node, s, a, inHand);
        box.appendChild(node);
    }
}

function avatarEl(s, size, seat, ring = true) {
    const av = el('div', 'avatar');
    av.style.width = av.style.height = size + 'px';
    const im = el('img'); im.alt = ''; im.src = 'img/avatar.png'; av.appendChild(im);
    if (ring && S.turn && S.turn.seat === seat) av.appendChild(turnRing(size));   // 모바일 영웅은 링 대신 차례 막대
    return av;
}

function turnRing(size) {
    const ns = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('class', 'ring'); svg.setAttribute('viewBox', '0 0 100 100');
    const c = document.createElementNS(ns, 'circle');
    c.setAttribute('cx', 50); c.setAttribute('cy', 50); c.setAttribute('r', 48); c.setAttribute('fill', 'none');
    c.setAttribute('stroke', '#fbbf24'); c.setAttribute('stroke-width', 4); c.setAttribute('pathLength', 100);
    const left = Math.max(0, (S.turn.deadline - Date.now()) / (S.room.turnSec * 1000));
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
    return nb;
}

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
    const nb = nameboxEl(s, 132, 48, 12, 14); nb.style.left = (ox + 15) + 'px'; nb.style.top = (oy + 106) + 'px'; node.appendChild(nb);
    const tag = blindTag(seat);
    if (tag) { const b = el('span', 'blind', tag); b.style.left = (ox + 20) + 'px'; b.style.top = (oy + 109) + 'px'; node.appendChild(b); }
    if (S.hand && S.hand.dealer === seat) { const d = dealerEl(); d.style.left = (ox + 2) + 'px'; d.style.top = (oy + 93) + 'px'; node.appendChild(d); }
    if (inHand) {
        const shown = S.reveal[seat];
        const m = el('div', 'mini');
        if (shown) { m.className = 'mini shown'; for (const c of shown) { const w = el('div', 'mc'); w.appendChild(cardEl(codeOf(c), winLook(codeOf(c)))); m.appendChild(w); } m.style.left = (ox + 107) + 'px'; m.style.top = (oy + 48) + 'px'; }
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
    const ny = (-9 + 80) / sc;
    const nb = nameboxEl(s, 167, 57, 16, 18); nb.style.left = (cx - 83.5) + 'px'; nb.style.top = (ny - 28.5) + 'px'; wrap.appendChild(nb);
    const tag = blindTag(seat);
    if (tag) { const b = el('span', 'blind', tag); b.style.left = (cx - 78) + 'px'; b.style.top = (ny - 24) + 'px'; wrap.appendChild(b); }
    if (S.hand && S.hand.dealer === seat) { const d = dealerEl(); d.style.left = (cx - 83.5 - 13) + 'px'; d.style.top = (ny - 28.5 - 13) + 'px'; wrap.appendChild(d); }
    const cards = S.hole && S.hand && S.holeHandId === S.hand.handId ? S.hole.map(codeOf) : (S.reveal[seat] || []).map(codeOf);
    if (inHand && cards.length) {
        const hole = el('div', 'hole' + (inHand.folded ? ' folded' : ''));
        hole.style.left = ((28 + 120) / sc) + 'px'; hole.style.top = ((-157 + 80) / sc) + 'px'; hole.style.transform = `scale(${1 / sc})`; hole.style.transformOrigin = '0 0';
        for (const c of cards) { const w = el('div', 'hc'); w.appendChild(cardEl(c, inHand.folded ? { dim: true } : winLook(c))); hole.appendChild(w); }
        hole.querySelectorAll('.hc')[1] && (hole.querySelectorAll('.hc')[1].style.marginLeft = (54 - 86) + 'px');
        wrap.appendChild(hole);
        const rank = !S.winners && !inHand.folded ? liveHandName([...cards, ...(S.hand.board || []).map(codeOf)]) : null;
        if (rank) { const hr = el('div', 'handrank', esc(rank)); hr.style.left = ((28 + 120 + 70) / sc) + 'px'; hr.style.top = ((-157 + 80 + 142) / sc) + 'px'; hr.style.transform = `translateX(-50%) scale(${1 / sc})`; hr.style.transformOrigin = '50% 0'; wrap.appendChild(hr); }
    }
    if (S.turn && S.turn.seat === seat) {
        const tm = el('div', 'timer');
        const left = Math.max(0, Math.ceil((S.turn.deadline - Date.now()) / 1000));
        tm.innerHTML = `<span><svg viewBox="0 0 24 24"><circle cx="12" cy="13" r="8"/><path d="M12 9v4l2 2M9 2h6"/></svg><b class="tsec">${left}</b></span>`;
        tm.style.left = ((-211 + 120) / sc - 25) + 'px'; tm.style.top = ((-95 + 80) / sc - 25) + 'px';
        wrap.appendChild(tm);
    }
    bubbleFor(wrap, seat, cx, cy - 71.5 - 34);
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
    const nb = nameboxEl(s, 74, 25, 8, 9); nb.style.left = '-37px'; nb.style.top = '25px'; node.appendChild(nb);
    const tag = blindTag(seat);
    if (tag) { const b = el('span', 'blind sm', tag); b.style.left = '-33px'; b.style.top = '27px'; node.appendChild(b); }
    if (S.hand && S.hand.dealer === seat) { const d = dealerEl(); d.classList.add('sm'); d.style.left = '-44px'; d.style.top = '17px'; node.appendChild(d); }
    if (inHand) {
        const shown = S.reveal[seat];
        const m = el('div', 'mini m');
        if (shown) { m.classList.add('shown'); for (const c of shown) { const w = el('div', 'mc'); w.appendChild(cardEl(codeOf(c), winLook(codeOf(c)))); m.appendChild(w); } m.style.left = '10px'; m.style.top = '-12px'; }
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
    const nb = nameboxEl(s, 77, 32, 11, 12); nb.style.left = '18px'; nb.style.top = '758px'; node.appendChild(nb);
    const tag = blindTag(seat);
    if (tag) { const b = el('span', 'blind sm', tag); b.style.left = '21px'; b.style.top = '760px'; node.appendChild(b); }
    if (S.hand && S.hand.dealer === seat) { const d = dealerEl(); d.classList.add('sm'); d.style.left = '8px'; d.style.top = '748px'; node.appendChild(d); }
    const cards = S.hole && S.hand && S.holeHandId === S.hand.handId ? S.hole.map(codeOf) : (S.reveal[seat] || []).map(codeOf);
    if (inHand && cards.length) {
        const hole = el('div', 'hole m' + (inHand.folded ? ' folded' : ''));
        hole.style.left = '155px'; hole.style.top = '684px';
        for (const c of cards) { const w = el('div', 'hc'); w.appendChild(cardEl(c, inHand.folded ? { dim: true } : winLook(c))); hole.appendChild(w); }
        node.appendChild(hole);
        const rank = !S.winners && !inHand.folded ? liveHandName([...cards, ...(S.hand.board || []).map(codeOf)]) : null;
        if (rank) { const hr = el('div', 'handrank m', esc(rank)); hr.style.left = '208px'; hr.style.top = '642px'; node.appendChild(hr); }
    }
    if (S.turn && S.turn.seat === seat) {
        const tm = el('div', 'timer m');
        const left = Math.max(0, Math.ceil((S.turn.deadline - Date.now()) / 1000));
        tm.innerHTML = `<span><svg viewBox="0 0 24 24"><circle cx="12" cy="13" r="8"/><path d="M12 9v4l2 2M9 2h6"/></svg><b class="tsec">${left}</b></span>`;
        tm.style.left = '102px'; tm.style.top = '617px';
        node.appendChild(tm);
    }
    bubbleFor(node, seat, cx, cy - 60, 'sm');
    resultFor(node, seat, cx, 794, cx, cy - 8, 'sm');
}

function dealerEl() {
    const d = el('div', 'dealer'); const im = el('img'); im.src = 'img/dealer.png'; im.alt = 'D'; d.appendChild(im); return d;
}

function bubbleFor(parent, seat, cx, top, size = '') {
    const b = S.bubbles[seat];
    if (!b) return;
    const word = ACT_WORD[b.a] ?? '';
    const withAmt = b.amt > 0 && b.a !== 'FOLD' && b.a !== 'CHECK';
    const node = el('div', 'bubble' + (b.a === 'FOLD' ? ' fold' : '') + (size ? ' ' + size : ''));
    node.innerHTML = (withAmt ? '<i class="dot"></i>' : '') + [word, withAmt ? dm(b.amt) : ''].filter(Boolean).map(esc).join(' ');
    node.style.left = cx + 'px'; node.style.top = top + 'px'; node.style.transform = 'translateX(-50%)';
    parent.appendChild(node);
}

/** 결과 — 이름 상자 아래 "Pair, 8's +805", 이긴 사람 아바타 위 WINNER */
function resultFor(parent, seat, cx, top, ax, ay, size = '') {
    if (!S.winners) return;
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
            if (hero) { x = a.x - 185 - 6 - 20; y = a.y - 30; }   // 영웅 이름 상자 왼쪽 가장자리, 16px 위
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
    const act = $('#actions');
    const tr = S.turn;
    if (!tr || tr.seat !== mySeat() || !S.hand) { act.hidden = true; return; }
    act.hidden = false;
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
    if (!(S.raiseVal >= minTo && S.raiseVal <= stackAll) || act.dataset.q !== String(tr.q)) S.raiseVal = minTo;
    act.dataset.q = tr.q;
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
        b.onclick = () => { S.raiseVal = v; g.value = v; paintRaise(); };
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

async function act(action, amount) {
    const tr = S.turn;
    if (!tr || tr.seat !== mySeat() || !S.keys) return;
    const amt = action === 'RAISE' || action === 'BET' ? Number(amount) : 0;
    const sig = await V.sign(S.keys, V.msg.action(tr.handId, tr.q, action, amt));
    hideActions();
    const r = await cmd('act', { q: tr.q, action, amount: amt, sig });
    if (!r.ok) { toast(r.error || 'action failed'); render(); }
}

function wireButtons() {
    $('.a-fold').onclick = () => act('FOLD');
    $('.a-call').onclick = (e) => act(e.currentTarget.dataset.act);
    $('.a-raise').onclick = (e) => act(e.currentTarget.dataset.act, S.raiseVal);
    $('.gauge-input').oninput = (e) => { S.raiseVal = Number(e.target.value); paintRaise(); };
    $('#btn-leave').onclick = async () => {
        if (!S.token) return;
        const r = await cmd('leave');
        if (r.ok && r.pending) toast(t('leftAfter'));
    };
    $('#btn-sound').onclick = (e) => { S.sound = !S.sound; e.currentTarget.classList.toggle('on', !S.sound); };
    $('#btn-verify').onclick = () => window.open('verify.html', '_blank', 'noopener');
    $('.verify-badge button').onclick = () => showProof();
    S.timerTick = setInterval(() => {
        const bar = $('.turnbar');
        bar.hidden = !(S.turn && S.layout === 'mobile' && S.turn.seat === mySeat());
        if (!S.turn) return;
        if (!bar.hidden) bar.firstChild.style.width = (Math.max(0, (S.turn.deadline - Date.now()) / (S.room.turnSec * 1000)) * 100).toFixed(1) + '%';
        const left = Math.max(0, (S.turn.deadline - Date.now()) / 1000);
        const secEl = $('.tsec'); if (secEl) secEl.textContent = Math.ceil(left);
        const frac = S.room ? left / S.room.turnSec : 0;
        document.querySelectorAll('.ring-arc').forEach((c) => c.setAttribute('stroke-dasharray', `${(frac * 100).toFixed(1)} 100`));
    }, 250);
}

// ------------------------------------------------------------ 확인 표시

function renderBadge() {
    const b = $('.verify-badge');
    const bad = S.att === 'mismatch' || S.holeOk === false;
    const ok = S.att === 'ok' && S.holeOk !== false;
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
function gate(msg) { $('.gate-msg').textContent = msg; $('#gate').hidden = false; }
function hideGate() { $('#gate').hidden = true; }

let actx = null;
function sfx(action) {
    if (!S.sound) return;
    try {
        actx = actx || new AudioContext();
        const o = actx.createOscillator(), g = actx.createGain();
        o.frequency.value = action === 'FOLD' ? 220 : action === 'CHECK' ? 440 : 660;
        g.gain.setValueAtTime(0.06, actx.currentTime); g.gain.exponentialRampToValueAtTime(0.0001, actx.currentTime + 0.12);
        o.connect(g).connect(actx.destination); o.start(); o.stop(actx.currentTime + 0.13);
    } catch (_e) { /* 소리 없이 */ }
}

boot();
