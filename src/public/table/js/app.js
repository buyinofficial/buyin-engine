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
import { t, tn, tnm, setLang, applyStatic, getLang } from './i18n.js';
import { liveHandName, handNameFor, prettyRank, bigHandName, madeHand, localHand } from './hand.js';

/** 디자인 리소스(배경·칩·아바타·딜러·카드 뒷면·글꼴)는 콘솔 리소스 서버에서 받는다 — 그림만 받고 아무것도 보내지 않는다.
 *  어떤 그림을 부르는지는 카드와 무관하다(칩은 공개된 베팅 금액, 카드 앞면은 글자로 그린다). CSP 가 이 주소의 그림·글꼴만 허용한다(table/http.js). */
const ASSET = 'https://resource.buyinholdem.com/buyin-table/';
/** 리소스를 바꿔 끼우면 이 값을 올린다 — 브라우저에 남은 예전 그림 대신 바로 새로 받는다 */
const AV = '?v=20261113';   // [TIP_ROYAL_0_10_5] 팁 아이콘을 로열로 바꿨다 — 옛 그림이 캐시에 남지 않게

const $ = (s, r = document) => r.querySelector(s);
const el = (tag, cls, html) => { const e = document.createElement(tag); if (cls) e.className = cls; if (html !== undefined) e.innerHTML = html; return e; };

// ---- [SKIN_PICK_0_10_12] 테이블 스킨 — 관리자 「테이블 스킨」에 올린 그림을 설정에서 고른다(이 기기에만 저장)
//   목록은 리소스 서버 assets/table_skins/skins.json(콘솔이 관리자 저장 때마다 쓴다). 그림도 리소스 서버의 그 폴더만 쓴다.
//   고른 스킨은 경로까지 기억해 둬서, 목록을 받기 전에도 첫 화면부터 그 그림으로 뜬다. 그림이 안 열리면 기본 배경으로.
// [SKIN_MAIN_0_10_23] 메인 테이블 — 관리자가 정한 스킨(skins.json main). 회원이 고르지 않았으면 이 테이블. 다음 접속 첫 화면부터 뜨게 이 기기에 기억
const SKIN_MAIN_KEY = 'buyin.skinMain';
const SKIN_KEY = 'buyin.skin', SKIN_RE = /^assets\/table_skins\/[A-Za-z0-9._-]+\.(jpe?g|png|webp)$/i;
const skinPath = (p) => (typeof p === 'string' && SKIN_RE.test(p) ? p : null);
const SK = { list: null, loading: null, cur: (() => {
    try { const j = JSON.parse(localStorage.getItem(SKIN_KEY) || 'null'); return j && j.id ? { id: String(j.id), m: skinPath(j.m), d: skinPath(j.d) } : null; } catch (_e) { return null; }
})(), main: (() => {
    try { const j = JSON.parse(localStorage.getItem(SKIN_MAIN_KEY) || 'null'); return j && j.id ? { id: String(j.id), m: skinPath(j.m), d: skinPath(j.d) } : null; } catch (_e) { return null; }
})() };
const effSkin = () => SK.cur || SK.main;   // [SKIN_MAIN_0_10_23] 고른 스킨 → 없으면 메인 테이블 → 없으면 기본 그림
const defBg = (portrait) => ASSET + (portrait ? 'img/bg_mobile.jpg' : 'img/bg_pc.jpg') + AV;
function bgSrc(portrait) {
    const e = effSkin(), p = e && (portrait ? e.m : e.d);
    return p ? RES_ROOT + p : defBg(portrait);
}
function loadSkins() {
    if (SK.loading) return SK.loading;
    SK.loading = fetch(RES_ROOT + 'assets/table_skins/skins.json?t=' + Math.floor(Date.now() / 120000), { credentials: 'omit', cache: 'no-cache' })
        .then((r) => (r.ok ? r.json() : Promise.reject(new Error('http ' + r.status))))
        .then((j) => {
            const arr = Array.isArray(j && j.skins) ? j.skins : [];
            SK.list = arr.slice(0, 80).map((x) => ({ id: String(Number(x && x.id) || ''), name: String((x && x.name) || '').slice(0, 40), m: skinPath(x.m), d: skinPath(x.d), t: skinPath(x.t), p: !!x.p }))
                .filter((x) => x.id && (x.m || x.d));
            // [SKIN_MAIN_0_10_23] 메인 테이블이 바뀌었으면 맞춘다(목록에 없으면 없음)
            const mid = j && j.main != null ? String(Number(j.main) || '') : '';
            const ms = mid ? SK.list.find((x) => x.id === mid) : null;
            const nm = ms ? { id: ms.id, m: ms.m, d: ms.d } : null;
            if (JSON.stringify(nm) !== JSON.stringify(SK.main)) {
                SK.main = nm;
                try { if (nm) localStorage.setItem(SKIN_MAIN_KEY, JSON.stringify(nm)); else localStorage.removeItem(SKIN_MAIN_KEY); } catch (_e) { /* */ }
                if (!SK.cur) applyBg(true);
            }
            // 고른 스킨이 내려갔거나 그림이 바뀌었으면 맞춘다
            if (SK.cur) {
                const s = SK.list.find((x) => x.id === SK.cur.id);
                if (!s) setSkin(null, false); else if (s.m !== SK.cur.m || s.d !== SK.cur.d) setSkin(s, false);
            }
            return SK.list;
        })
        .catch(() => SK.list)
        .finally(() => { SK.loading = null; });
    return SK.loading;
}
function applyBg(fade) {
    const img = $('.bg-img'); if (!img) return;
    const portrait = S.layout !== 'pc', want = bgSrc(portrait), fallback = defBg(portrait);
    if (img.dataset.want === want) return;
    img.dataset.want = want;
    img.onerror = () => { if (img.src !== fallback) img.src = fallback; };
    if (!fade || !img.getAttribute('src')) { img.src = want; return; }
    // 바뀌는 그림을 위에 겹쳐 0.45초 동안 서서히 — 다 받은 뒤에 시작해 빈 화면이 끼지 않게
    const pre = new Image();
    pre.onload = () => {
        if (img.dataset.want !== want) return;
        img.parentNode.querySelectorAll('.bg-next').forEach((n) => n.remove());
        const top = el('img', 'bg-img bg-next'); top.alt = ''; top.src = want; img.after(top);
        requestAnimationFrame(() => requestAnimationFrame(() => top.classList.add('in')));
        setTimeout(() => { img.src = want; setTimeout(() => top.remove(), 60); }, 480);
    };
    pre.onerror = () => { img.src = fallback; };
    pre.src = want;
}
function setSkin(s, fade = true) {
    SK.cur = s ? { id: s.id, m: s.m, d: s.d } : null;
    try { if (SK.cur) localStorage.setItem(SKIN_KEY, JSON.stringify(SK.cur)); else localStorage.removeItem(SKIN_KEY); } catch (_e) { /* 사생활 보호 모드 — 이번 접속 동안만 */ }
    applyBg(fade);
    paintSkinRow();
    if (!$('#skin-pick').hidden) paintSkinMarks();
}
function skinThumb(s, pc) {
    if (!s && SK.main && (pc ? SK.main.d : SK.main.m)) { const ms = (SK.list || []).find((x) => x.id === SK.main.id); return RES_ROOT + (pc ? SK.main.d : ((ms && ms.t) || SK.main.m)); }   // [SKIN_MAIN_0_10_23] 「기본」 = 메인 테이블
    if (!s) return defBg(!pc);
    return RES_ROOT + (pc ? s.d : (s.t || s.m));
}
function paintSkinRow() {
    const row = $('.st-skin'); if (!row) return;
    const pc = S.layout === 'pc';
    const s = SK.cur && (SK.list || []).find((x) => x.id === SK.cur.id);
    $('.sk-name', row).textContent = s ? s.name : t('skinDefault');
    const e = effSkin(), usable = e && (pc ? e.d : e.m);
    $('.sk-cur', row).style.backgroundImage = `url('${usable ? RES_ROOT + usable : defBg(!pc)}')`;
}
function paintSkinMarks() {
    const id = SK.cur && !(SK.main && SK.cur.id === SK.main.id) ? SK.cur.id : '';   // [SKIN_MAIN_0_10_23] 메인 테이블을 골라 둔 회원도 「기본」에 표시
    document.querySelectorAll('#skin-pick .sp-card').forEach((c) => {
        const on = c.dataset.id === id;
        c.classList.toggle('on', on); c.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
}
function paintSkinPick() {
    const box = $('#skin-pick'), body = $('.sp-body', box), pc = S.layout === 'pc';
    box.classList.toggle('pc', pc);
    body.innerHTML = '';
    if (!SK.list) { body.appendChild(el('p', 'sp-note', '')).textContent = t(SK.loading ? 'skinLoading' : 'skinFail'); return; }
    const usable = SK.list.filter((x) => (pc ? x.d : x.m) && !(SK.main && x.id === SK.main.id));   // [SKIN_MAIN_0_10_23] 메인 테이블은 「기본」 칸으로 보인다
    const card = (s, big) => {
        const b = el('button', 'sp-card' + (big ? ' big' : '') + (s && s.p ? ' prem' : ''));
        b.type = 'button'; b.dataset.id = s ? s.id : '';
        const fig = el('span', 'sp-fig');
        const im = el('img'); im.alt = ''; im.loading = 'lazy'; im.decoding = 'async'; im.src = skinThumb(s, pc);
        im.onerror = () => { b.classList.add('broken'); };
        fig.appendChild(im);
        if (s && s.p) fig.appendChild(el('i', 'sp-crown', '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 18h18l-1.6-9.5-4.9 4.2L12 5.5l-2.5 7.2-4.9-4.2z"/></svg>'));
        fig.appendChild(el('i', 'sp-check', '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12.5l4.2 4.2L19 7"/></svg>'));
        b.appendChild(fig);
        b.appendChild(el('span', 'sp-name')).textContent = s ? s.name : t('skinDefault');
        b.onclick = () => setSkin(s);   // 소리 없음(운영 요청 11-16)
        return b;
    };
    const prem = usable.filter((x) => x.p), basic = usable.filter((x) => !x.p);
    if (prem.length) {
        body.appendChild(el('div', 'sp-sec prem')).textContent = t('skinPremium');
        const g = body.appendChild(el('div', 'sp-grid big'));
        for (const s of prem) g.appendChild(card(s, true));
    }
    body.appendChild(el('div', 'sp-sec')).textContent = t('skinBasic');
    const g = body.appendChild(el('div', 'sp-grid'));
    g.appendChild(card(null, false));
    for (const s of basic) g.appendChild(card(s, false));
    if (pc && !usable.length) body.appendChild(el('p', 'sp-note', '')).textContent = t('skinPcNone');
    paintSkinMarks();
}
function openSkinPick() {
    $('#settings').hidden = true;
    const box = $('#skin-pick'); box.hidden = false;
    paintSkinPick();
    loadSkins().then(() => { if (!box.hidden) paintSkinPick(); paintSkinRow(); });
}
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
/* [MAN_FMT_0_10_12] 한국어 화면은 만·억 단위 — 105,732 → 10만5732, 1,234,567,890 → 12억3456만7890 (정수·1만 이상만, 운영 요청).
   다른 언어와 소수(USDT)는 종전처럼 쉼표 */
const manKo = (v) => {
    const neg = v < 0; let x = Math.abs(v); let out = '';
    const eok = Math.floor(x / 1e8); x -= eok * 1e8;
    const man = Math.floor(x / 1e4); const rest = x - man * 1e4;
    if (eok) out += eok.toLocaleString('en-US') + '억';
    if (man) out += man + '만';
    if (rest) out += rest;
    return (neg ? '-' : '') + (out || '0');
};
const fmt = (n) => {
    const v = Math.round((Number(n) || 0) * 1000) / 1000;
    if (Number.isInteger(v) && Math.abs(v) >= 10000 && getLang() === 'ko' && cur() !== 'VND' && cur() !== 'USDT') return manKo(v);   // [VIEW_CUR_0_10_23] 만 단위는 원화만
    return v.toLocaleString('en-US', { maximumFractionDigits: 3 });
};
/** 화면 금액 — 좌석표의 표시 환산(예: 칩 USDT → 원화). 게임 금액은 그대로 */
/** [VIEW_CUR_0_10_23] 설정에서 고른 화면 통화(원화·테더·베트남동) — 좌석표 display.rates 에 있을 때만. 없으면 좌석표 기본 */
const viewRates = () => (S.me && S.me.display && S.me.display.rates) || null;
const viewPick = () => { const r = viewRates(); return S.viewCur && r && r[S.viewCur] > 0 ? S.viewCur : ''; };
const rate = () => { const v = viewPick(); return v ? viewRates()[v] : (S.me && S.me.display && S.me.display.rate) || 1; };
const cur = () => viewPick() || (S.me && S.me.display && S.me.display.currency) || '';
const shown = (n) => { const v = (Number(n) || 0) * rate(); return rate() >= 10 ? Math.round(v) : Math.round(v * 100) / 100; };
const dm = (n) => fmt(shown(n));
const compact = (n) => {
    const v = shown(n);
    if (cur() === 'VND' && Math.abs(v) >= 1e6) return (Math.round(v / 1e4) / 100).toLocaleString('en-US', { maximumFractionDigits: 2 }) + 'M';   // [VIEW_CUR_0_10_23] 동은 백만 단위
    return v >= 10000 && getLang() !== 'ko' ? (Math.round(v / 10) / 100) + 'k' : fmt(v);   // [MAN_FMT_0_10_12] 한국어는 k 대신 만 단위
};
/* [WON_LABEL_0_10_15] 원화는 「KRW」 대신 한국어 「원」, 다른 언어는 ₩ — 버튼·바이인 금액 */
/** [WON_LABEL_0_10_15] 금액 옆 통화 글자 — 원화는 「원」(한국어)·₩ */
const curLabel = () => (cur() === 'KRW' ? (getLang() === 'ko' ? '원' : '₩') : cur() === 'VND' ? '₫' : cur());
const dmCur = (n) => (cur() === 'KRW' ? (getLang() === 'ko' ? `${compact(n)}원` : `₩${compact(n)}`) : cur() === 'VND' ? `${compact(n)}₫` : `${compact(n)}${cur() ? ' ' + cur() : ''}`);

// ------------------------------------------------------------ 배치 (운영 테이블에서 잰 값)

/** PC 9석 기준 위치 — 메인 영역(가로 W, 세로 H) 비율 + px */
const PC_POS = [
    [[47, 55], [84, 20]], [[22, -35], [81, 20]], [[7, 45], [55, 0]], [[17, 15], [30, 0]], [[37, 15], [22, 7]],
    [[63, -5], [22, 8]], [[81, 0], [30, 0]], [[91, 0], [55, 0]], [[78, 0], [81, 20]],
];
// [SIDE_OUT_0_10_17] 양옆 열을 화폭 8px 씩 바깥으로(운영 요청 — 아주 조금 더 가장자리로). 이름 상자 여백 17·20px → 9·12px
// [SIDE_OUT2_0_10_18] 한 번 더 바깥으로(-16 / +17) — 여백 약 4·6px(잘리지 않는 선)
const MOBILE_POS = [
    [[50, 0], [78, 0]], [[12, -16], [76, -120]], [[12, -16], [57, -75]], [[12, -16], [33, -5]], [[32, 0], [20, 10]],
    [[66, 0], [20, 10]], [[86, 17], [33, -5]], [[86, 17], [57, -75]], [[86, 17], [76, -120]],
];
/**
 * [MOBILE_11_0_10_7] 모바일 11석 — 화폭(390x844) 좌표 그대로(px). 종전엔 모바일 배치가 9자리뿐이라 11인 방은 PC 전용이었다
 * (화면 자리 9·10 이 8 자리에 겹쳤다). 왼쪽 4 · 위 2 · 오른쪽 4, 영웅은 9석과 같은 아래 왼쪽.
 * 다른 자리는 MOBILE_11_SCALE 로 줄여 위아래 간격(약 112px)에 아바타·이름 상자가 겹치지 않게 하고, 왼쪽 맨 아래 자리는 채팅 버튼(위 565px) 위에서 끝난다.
 * 역할(받침 칩·아바타 안쪽 보정 방향)은 ROLE_11 로 9석 역할에 맞춘다
 */
// [MOBILE_11_NEAR_0_10_11] 양옆을 185~545(120px 간격)로 — 종전 175~512 는 아래 자리와 영웅 사이가 너무 비어 영웅만 멀어 보였다(운영 요청 11-16).
//   왼쪽 아래 채팅 버튼(565)이 가운데 채팅 창으로 바뀌어 그 자리까지 내려올 수 있다
const MOBILE_POS_11 = [   // [MOBILE_11_SPREAD] 테이블 윗부분까지 넓게 — 위 2자리는 레일 바로 안쪽(y 100)
    null, [31, 545], [31, 425], [31, 305], [31, 185], [128, 100],   // [SIDE_OUT_0_10_17] 양옆 열 44 → 36, 338 → 346 · [SIDE_OUT2_0_10_18] → 31 / 352
    [262, 100], [352, 185], [352, 305], [352, 425], [352, 545],
];
const MOBILE_11_SCALE = 0.92;
/** [SEATS6_0_10_23] 6인 방(오마하) — 화면 자리 → 9석 자리(-1 = 위 가운데: 4·5번 가운데). 영웅·왼쪽 2·위 1·오른쪽 2 */
const SIX_SLOT = [0, 2, 3, -1, 6, 7];
const MOBILE_TOP_MID = [[49, 0], [20, 10]];
const PC_TOP_MID = [[50, 5], [22, 8]];
/** 영웅이 아닌 좌석의 역할별 보정(px) */
const PC_ROLE_ADJ = { 1: [40, -60], 2: [0, -20], 3: [30, -60], 7: [0, -20], 8: [-30, -60] };
const PC_ROLE_ADJ_DEFAULT = [0, -60];
const ROLE_11 = [0, 1, 2, 2, 3, 4, 5, 6, 7, 7, 8];
/** 11석 위치(lib/seat-layout DESKTOP_SEAT_POSITIONS_11 과 같은 값) */
const PC_POS_11 = [   // [SEATS11_ORIG_0_10_9] 원본 lib/seat-layout DESKTOP_SEAT_POSITIONS_11 값 그대로(종전 2·3·4·7·8·9번이 조금 달랐다)
    [[47, 55], [84, 20]], [[22, -35], [81, 20]], [[5, 45], [66, 0]], [[6, 45], [44, 0]], [[19, 15], [27, 0]], [[37, 15], [22, 7]],
    [[63, -5], [22, 8]], [[80, 0], [27, 0]], [[92, 0], [44, 0]], [[92, 0], [66, 0]], [[78, 0], [81, 20]],
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
    tipQ: [], anim: {}, raising: null, raisingSent: '', preAct: '', emoteHand: '', tipGift: '', darkNext: false, darkHand: '',
    rabbit: null, banner: '', vol: 1, live: false, fire: new Map(), seen: {},
    // [SHOWDOWN_SEQ_0_10_4] 쇼다운 순차 공개 — sd: { handId, at:{좌석:여는 시각}, winAt, ranks } / 그동안 온 좌석 갱신은 sdQ 에 모았다가 승자 때
    sd: null, sdQ: [],
    // [BUYIN_UNITS_0_10_4] 「바이인 완료」를 처음 본 시각 — 자리·이름·합계마다 한 번만 띄운다
    rbSeen: {},
    // [READY_SESSION_0_10_6] 준비 대기실 · 게임 시간 — gate: 서버 'gate', session: 서버 'session', skew: 서버 시각 − 내 시각
    gate: null, gateShowAt: 0, session: null, skew: 0, rqBusy: false, gateEnded: false, nextSession: null,
};
S.zoom = 1;
/** [OM_SORT_0_10_23] 오마하 내 카드 정렬 — off(받은 순서) · rank(높은 숫자부터) · suit(같은 무늬끼리, 많은 무늬부터). 이 브라우저에 기억 */
S.omSort = 'rank';
try { const v = localStorage.getItem('buyin.omSort'); if (v === 'off' || v === 'rank' || v === 'suit') S.omSort = v; } catch (_e) { /* */ }
/** [SETTINGS2_0_10_23] 설정 스위치 — 목소리·내 차례 알림음은 기본 켬, 4색 카드·진동은 기본 끔 */
S.voiceOn = true; S.turnAlert = true; S.fourColor = false; S.vibrate = false;
try { const v = localStorage.getItem('buyin.viewCur'); if (v === 'KRW' || v === 'USDT' || v === 'VND') S.viewCur = v; } catch (_e) { /* */ }   // [VIEW_CUR_0_10_23]
for (const k of ['voiceOn', 'turnAlert', 'fourColor', 'vibrate']) { try { const v = localStorage.getItem('buyin.' + k); if (v === '1' || v === '0') S[k] = v === '1'; } catch (_e) { /* */ } }
try { if (S.fourColor) document.body.classList.add('four-color'); } catch (_e) { /* */ }
try { const z = Number(localStorage.getItem('buyin.zoom')); if (z >= 0.6 && z <= 1) S.zoom = z; } catch (_e) { /* */ }
try { const v = Number(localStorage.getItem('buyin.vol')); if (v >= 0 && v <= 1 && localStorage.getItem('buyin.vol') !== null) S.vol = v; } catch (_e) { /* */ }
/** 다시 그려도 연출이 처음부터 다시 돌지 않게 — 시작 시각을 기억해 두고 남은 만큼만 돈다(음수 animation-delay) */
function animDelay(key, delaySec = 0) {
    if (!(key in S.anim)) S.anim[key] = Date.now() + delaySec * 1000;
    return ((S.anim[key] - Date.now()) / 1000).toFixed(3) + 's';
}
function animAge(key) { return key in S.anim ? (Date.now() - S.anim[key]) / 1000 : Infinity; }

// ------------------------------------------------------------ 카드

const SUIT = { s: '♠', h: '♥', d: '♦', c: '♣' };
/**
 * [CARD_REF_0_10_23] 카드 앞면 — 운영이 준 참고 카드 그림(52×74px)을 픽셀로 재서 그대로 옮겼다.
 *   숫자  Liberation Serif Bold(OFL, Times 계열 굵은 세리프) 윤곽을 SVG 로 — 기기 글꼴과 상관없이 같은 모양. [왼쪽 잉크, 오른쪽 잉크, 경로], 기준선 y=0, 대문자 높이 ≈ 1352(단위 2048)
 *   무늬  참고 그림 비율로 새로 그린 경로(스페이드 몸통이 넓고, 클로버는 큰 잎 셋, 하트는 통통) — 상자에 꼭 맞는 viewBox
 *   자리·크기는 table.css [CARD_REF_0_10_23] (모두 카드 폭 기준 cqw)
 */
const RANK_GLYPH = {
    'A': [20, 1464, 'M428 -73L428 0L20 0L20 -73L120 -100L597 -1352L887 -1352L1362 -100L1464 -73L1464 0L867 0L867 -73L1022 -100L894 -447L379 -447L256 -100L428 -73ZM641 -1150L420 -557L856 -557L641 -1150Z'],
    '2': [86, 936, 'M936 0L86 0L86 -189Q172 -281 245 -354Q405 -512 479 -602.5Q553 -693 587.5 -790Q622 -887 622 -1011Q622 -1120 569 -1187Q516 -1254 428 -1254Q366 -1254 329 -1241Q292 -1228 261 -1202L218 -1008L131 -1008L131 -1313Q211 -1331 287.5 -1343.5Q364 -1356 454 -1356Q675 -1356 792.5 -1265Q910 -1174 910 -1006Q910 -901 875 -815.5Q840 -730 764.5 -649Q689 -568 464 -385Q378 -315 278 -226L936 -226L936 0Z'],
    '3': [77, 954, 'M954 -365Q954 -182 823 -81Q692 20 459 20Q273 20 89 -20L77 -345L169 -345L221 -130Q308 -81 403 -81Q524 -81 592 -158.5Q660 -236 660 -375Q660 -496 605.5 -560.5Q551 -625 429 -633L313 -640L313 -761L425 -769Q514 -775 556.5 -834.5Q599 -894 599 -1014Q599 -1126 548.5 -1190Q498 -1254 405 -1254Q351 -1254 316.5 -1237.5Q282 -1221 251 -1202L208 -1008L121 -1008L121 -1313Q223 -1339 297 -1347.5Q371 -1356 443 -1356Q894 -1356 894 -1026Q894 -890 822 -806Q750 -722 616 -702Q954 -661 954 -365Z'],
    '4': [28, 986, 'M852 -265L852 0L583 0L583 -265L28 -265L28 -428L632 -1348L852 -1348L852 -470L986 -470L986 -265L852 -265ZM583 -867Q583 -979 593 -1079L194 -470L583 -470L583 -867Z'],
    '5': [82, 949, 'M480 -793Q718 -793 833.5 -695Q949 -597 949 -399Q949 -197 823.5 -88.5Q698 20 464 20Q278 20 94 -20L82 -345L174 -345L226 -130Q265 -108 322 -94.5Q379 -81 425 -81Q655 -81 655 -389Q655 -549 596.5 -620.5Q538 -692 410 -692Q339 -692 280 -666L249 -653L149 -653L149 -1341L849 -1341L849 -1118L260 -1118L260 -766Q382 -793 480 -793Z'],
    '6': [70, 964, 'M964 -416Q964 -205 855 -92.5Q746 20 545 20Q315 20 192.5 -155Q70 -330 70 -662Q70 -878 134.5 -1035Q199 -1192 315 -1274Q431 -1356 582 -1356Q738 -1356 883 -1313L883 -1008L796 -1008L753 -1202Q684 -1254 602 -1254Q502 -1254 439.5 -1126Q377 -998 366 -768Q475 -815 582 -815Q765 -815 864.5 -712Q964 -609 964 -416ZM541 -81Q614 -81 642 -160Q670 -239 670 -397Q670 -538 631 -614Q592 -690 515 -690Q441 -690 364 -667L364 -662Q364 -81 541 -81Z'],
    '7': [117, 974, 'M204 -958L117 -958L117 -1341L974 -1341L974 -1262L453 0L214 0L779 -1118L250 -1118L204 -958Z'],
    '8': [68, 956, 'M925 -1011Q925 -901 871 -823.5Q817 -746 719 -711Q834 -668 895 -578Q956 -488 956 -362Q956 -172 846.5 -76Q737 20 506 20Q68 20 68 -362Q68 -490 130 -580Q192 -670 302 -711Q205 -748 152 -825Q99 -902 99 -1014Q99 -1178 207.5 -1270Q316 -1362 514 -1362Q708 -1362 816.5 -1268.5Q925 -1175 925 -1011ZM672 -362Q672 -516 632 -586Q592 -656 506 -656Q424 -656 388 -588Q352 -520 352 -362Q352 -207 388.5 -144Q425 -81 506 -81Q592 -81 632 -147Q672 -213 672 -362ZM641 -1011Q641 -1142 608 -1201.5Q575 -1261 508 -1261Q444 -1261 413.5 -1202Q383 -1143 383 -1011Q383 -875 413 -819Q443 -763 508 -763Q577 -763 609 -820.5Q641 -878 641 -1011Z'],
    '9': [56, 950, 'M56 -932Q56 -1136 173 -1246Q290 -1356 498 -1356Q733 -1356 841.5 -1191Q950 -1026 950 -674Q950 -448 886.5 -293Q823 -138 704 -59Q585 20 418 20Q252 20 107 -23L107 -328L194 -328L237 -134Q272 -109 320.5 -95Q369 -81 414 -81Q522 -81 582.5 -203.5Q643 -326 653 -558Q549 -521 446 -521Q265 -521 160.5 -629Q56 -737 56 -932ZM350 -928Q350 -642 506 -642Q582 -642 656 -660L656 -674Q656 -963 621.5 -1109Q587 -1255 500 -1255Q350 -1255 350 -928Z'],
    '1': [164, 918, 'M685 -110L918 -86L918 0L164 0L164 -86L396 -110L396 -1121L165 -1045L165 -1130L543 -1352L685 -1352L685 -110Z'],
    '0': [78, 946, 'M946 -676Q946 20 506 20Q294 20 186 -158Q78 -336 78 -676Q78 -1009 186 -1185.5Q294 -1362 514 -1362Q726 -1362 836 -1187.5Q946 -1013 946 -676ZM653 -676Q653 -988 618 -1124.5Q583 -1261 508 -1261Q434 -1261 402.5 -1129Q371 -997 371 -676Q371 -350 403 -215Q435 -80 508 -80Q582 -80 617.5 -218.5Q653 -357 653 -676Z'],
    'J': [91, 968, 'M501 -1242L329 -1268L329 -1341L968 -1341L968 -1268L816 -1242L816 -432Q816 -215 696 -97.5Q576 20 354 20Q279 20 206.5 11.5Q134 3 91 -10L91 -314L180 -314L210 -135Q229 -112 264 -99Q299 -86 341 -86Q410 -86 455.5 -134Q501 -182 501 -276L501 -1242Z'],
    'Q': [100, 1503, 'M100 -672Q100 -1356 797 -1356Q1141 -1356 1317 -1182.5Q1493 -1009 1493 -672Q1493 -175 1119 -32L1169 29Q1316 213 1421 213Q1473 213 1503 205L1503 291Q1482 301 1405.5 316.5Q1329 332 1267 332Q1194 332 1137.5 318.5Q1081 305 1032.5 276.5Q984 248 937.5 201.5Q891 155 785 20Q452 18 276 -158.5Q100 -335 100 -672ZM432 -672Q432 -353 519.5 -216.5Q607 -80 797 -80Q986 -80 1073.5 -217Q1161 -354 1161 -672Q1161 -989 1073.5 -1122Q986 -1255 797 -1255Q607 -1255 519.5 -1122Q432 -989 432 -672Z'],
    'K': [35, 1577, 'M1469 -1341L1469 -1268L1305 -1242L862 -851L1452 -100L1577 -73L1577 0L1139 0L638 -646L522 -546L522 -100L715 -73L715 0L35 0L35 -73L207 -100L207 -1242L35 -1268L35 -1341L695 -1341L695 -1268L522 -1242L522 -696L1133 -1242L1010 -1268L1010 -1341L1469 -1341Z']
};
const SUIT_SHAPE = {   // [SUIT_SMOOTH_0_10_23] 이음매마다 접선이 이어지는 매끈한 곡선(종전 손그림은 이음매가 꺾여 찌그러져 보였다), 좌우 대칭
    s: ['0 0 100 104', 'M50 0C56 14 74 28 88 40C96 47 100 55 100 64C100 78 89 88 75 88C66 88 58 84 53 78C55 90 59 98 68 104L32 104C41 98 45 90 47 78C42 84 34 88 25 88C11 88 0 78 0 64C0 55 4 47 12 40C26 28 44 14 50 0Z'],
    h: ['0 0 100 92', 'M50 92C22 69 0 52 0 28C0 12 12 0 27 0C38 0 46 6 50 15C54 6 62 0 73 0C88 0 100 12 100 28C100 52 78 69 50 92Z'],
    d: ['0 0 75 100', 'M37.5 0L75 50L37.5 100L0 50Z'],   // [DIAMOND_STRAIGHT_0_10_23] 운영 요청: 곡선 없이 직선 네 변 — 더 뾰족하게
    c: ['0 0 100 104', 'M27 24a23 23 0 1 0 46 0a23 23 0 1 0 -46 0ZM1 62a23 23 0 1 0 46 0a23 23 0 1 0 -46 0ZM53 62a23 23 0 1 0 46 0a23 23 0 1 0 -46 0ZM50 24L24 64L76 64ZM47 52C47 80 42 96 32 104L68 104C58 96 53 80 53 52Z'],
};
/** 카드 숫자 그림 — 높이는 CSS(대문자 높이), 폭은 글자 비율 그대로(em = 대문자 높이). 10 은 1·0 을 조금 붙여서 */
function rankSvg(r) {
    const parts = r === '10' ? ['1', '0'] : [r];
    let x = 0, d = '', left = null;
    parts.forEach((ch, i) => {
        const [x0, x1, p] = RANK_GLYPH[ch];
        const dx = i === 0 ? -x0 : x - x0 - 40;
        d += `<path transform="translate(${dx} 0)" d="${p}"/>`;
        if (left === null) left = 0;
        x = dx + x1;
    });
    return `<svg viewBox="0 -1352 ${x} 1352" style="width:${(x / 1352).toFixed(3)}em" aria-hidden="true">${d}</svg>`;
}
// [CARD_DEPTH_0_10_23] 바탕(그라데이션 색) + 위쪽 광택 한 겹 — 색은 table.css 가 url(#cgRed|#cgBlack|#cgShine)
const suitSvg = (s) => `<svg viewBox="${SUIT_SHAPE[s][0]}" aria-hidden="true"><path class="sf" d="${SUIT_SHAPE[s][1]}"/><path class="sh" d="${SUIT_SHAPE[s][1]}"/></svg>`;
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
    // [CARD_REF_0_10_23] 숫자·작은 무늬·큰 무늬를 카드에 바로(종전 .corner 는 화면 모서리 버튼 줄과 이름이 겹쳤다)
    c.innerHTML = `<span class="rank" aria-label="${r}">${rankSvg(r)}</span><span class="pip" aria-label="${SUIT[s]}">${suitSvg(s)}</span><span class="big">${suitSvg(s)}</span>`;
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
    // [FLIP_SAFE_0_10_11] 뒤집기가 끝나면 다시 그려 평범한 카드로 바꾼다 — 3D 가 눌리는 브라우저(아이폰 사파리 등)에서 뒷면이 앞면 위에 남지 않게
    renderAt(S.anim[key] + (delaySec + durSec + 0.25) * 1000);
    return f;
}
let renderAtT = 0, renderAtWhen = 0;
function renderAt(when) {
    const now = Date.now();
    if (when <= now) when = now + 30;
    if (renderAtT && renderAtWhen <= when) return;   // 더 이른 예약이 있으면 그것이 끝나고 다시 그릴 때 다음 것을 예약한다
    if (renderAtT) clearTimeout(renderAtT);
    renderAtWhen = when;
    renderAtT = setTimeout(() => { renderAtT = 0; renderAtWhen = 0; render(); }, when - now);
}

// ------------------------------------------------------------ 시작

async function boot() {
    const qs = new URLSearchParams(location.hash.slice(1));
    // [REBUY_IN_ROOM_0_10_15] 재바이인으로 다시 열 때는 주소에 언어가 없다 — 이 탭에 남긴 언어로
    let keepLang = ''; try { keepLang = sessionStorage.getItem('buyin.lang') || ''; } catch (_e) { /* */ }
    setLang(qs.get('lang') || keepLang || navigator.language.slice(0, 2));
    try { sessionStorage.setItem('buyin.lang', getLang()); } catch (_e) { /* */ }
    applyStatic();
    S.ticket = qs.get('t') || sessionStorage.getItem('buyin.ticket') || '';
    // [RESUME_0_10_11] 좌석표는 입장이 끝날 때까지 이 탭에 둔다(입장 중 새로고침해도 다시 쓴다). room = 로비가 알려 준 방(자리로 돌아오기)
    if (qs.get('t')) { try { sessionStorage.setItem('buyin.ticket', qs.get('t')); } catch (_e) { /* */ } }
    S.roomHint = qs.get('room') || '';
    // [REBUY_TOKEN_0_10_18] 로비 로그인 토큰 — 이 탭에만 두고, 바이인 창(로비)을 열 때 창 주소의 # 조각으로만 넘긴다(TEE 서버로는 보내지 않는다)
    if (qs.get('lt')) { try { sessionStorage.setItem('buyin.lt', qs.get('lt')); } catch (_e) { /* */ } }
    if (history.replaceState) history.replaceState(null, '', location.pathname);   // 주소창·기록에 좌석표를 남기지 않는다
    layoutMode();
    addEventListener('resize', () => { layoutMode(); render(); });
    document.addEventListener('focusout', () => setTimeout(() => { if (!typingOnPhone()) { layoutMode(); render(); } }, 350));   // [MOBILE_FIT_0_10_7] 키보드가 내려간 뒤 다시 맞춘다
    wireButtons();
    checkEngine();
    setInterval(tickClock, 500);   // [READY_SESSION_0_10_6] 게임 시간 · 시작 카운트다운

    // [REBUY_0_10_2] 주소에 새 좌석표가 있으면 그것으로 앉는다 — 이 탭에 남은 예전 자리 토큰(재바이인 전 정산된 자리)은 버린다
    if (qs.get('t')) sessionStorage.removeItem('buyin.token');
    const saved = sessionStorage.getItem('buyin.token');
    if (saved) { S.token = saved; return listen(); }
    if (!S.ticket) return reenter();
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
        S.watch = !!r.watch;   // [WATCH_0_10_20] 방장 관전 — 자리·칩 없음
        try { if (r.watch) sessionStorage.setItem('buyin.watch', '1'); else sessionStorage.removeItem('buyin.watch'); } catch (_e) { /* */ }
        sessionStorage.setItem('buyin.token', r.token);
        sessionStorage.removeItem('buyin.ticket');
        rememberSeat(String(body.room && body.room.id || r.roomId || ''), body.tid, String(body.player.odcId));   // [RESUME_0_10_11]
        listen();
    } catch (e) { gate(String(e.message || e)); }
}

/**
 * [RESUME_0_10_11] 좌석표·자리 토큰 없이 열린 화면(다른 탭, 휴대폰이 다시 연 탭, 로비의 「테이블로 돌아가기」, 입장 중 새로고침) —
 *   1) 이 브라우저가 앉아 있던 자리(localStorage, 12시간)면 같은 서명 키로 서명해 그 자리에 다시 붙는다(엔진 /table/resume)
 *   2) 그 자리가 정산돼 끝났으면 그 안내
 *   3) 방을 알면 로비의 그 방 입장 화면으로(자리가 살아 있으면 로비가 다시 보내고, 아니면 바이인 신청)
 *   4) 아무것도 모르면 종전 「입장권이 없습니다」
 */
const SEATS_KEY = 'buyin.seats', ENDED_KEY = 'buyin.ended';
function readJSON(k) { try { return JSON.parse(localStorage.getItem(k) || 'null'); } catch (_e) { return null; } }
function writeJSON(k, v) { try { if (v == null) localStorage.removeItem(k); else localStorage.setItem(k, JSON.stringify(v)); } catch (_e) { /* 사생활 보호 모드 */ } }
function rememberSeat(roomId, tid, odcId) {
    if (!roomId || !tid) return;
    const all = readJSON(SEATS_KEY) || {};
    all[roomId] = { tid, odcId, at: Date.now() };
    writeJSON(SEATS_KEY, all);
    const e = readJSON(ENDED_KEY); if (e && e.roomId === roomId) writeJSON(ENDED_KEY, null);
    S.seatRoom = roomId;
}
function forgetSeat(roomId, ended) {
    const all = readJSON(SEATS_KEY) || {};
    if (roomId && all[roomId]) { delete all[roomId]; writeJSON(SEATS_KEY, all); }
    if (ended && roomId) writeJSON(ENDED_KEY, { roomId, at: Date.now(), cash: ended.cash });
}
async function reenter() {
    const all = readJSON(SEATS_KEY) || {};
    const fresh = Object.entries(all).filter(([, v]) => v && Date.now() - v.at < 12 * 3600 * 1000).sort((a, b) => b[1].at - a[1].at);
    const pick = (S.roomHint && all[S.roomHint] ? [S.roomHint, all[S.roomHint]] : null) || fresh[0] || null;
    if (pick) {
        const [roomId, v] = pick;
        gate(t('joining'));
        try {
            S.keys = await V.loadKeys(String(v.odcId));
            const ts = Date.now();
            const proof = await V.sign(S.keys, V.msg.resume(v.tid, S.keys.sigFp, ts));
            const r = await post('/table/resume', { tid: v.tid, ts, auth: { sig: S.keys.sigJwk, proof } });
            if (r.ok) {
                S.token = r.token; S.tableId = r.tableId; S.seatRoom = roomId;
                sessionStorage.setItem('buyin.token', r.token);
                rememberSeat(roomId, v.tid, v.odcId);
                return listen();
            }
        } catch (_e) { /* 아래로 */ }
        forgetSeat(roomId);
    }
    const ended = readJSON(ENDED_KEY);
    const roomId = S.roomHint || (pick && pick[0]) || '';
    if (ended && (!roomId || ended.roomId === roomId) && Date.now() - ended.at < 30 * 60 * 1000) {
        return gate(ended.cash != null ? `${t('endedSeat')} ${dmCur(ended.cash)}` : t('endedSeat'), true);
    }
    // 로비의 그 방 화면으로 — 같은 방으로 1분 안에 두 번은 보내지 않는다(돌고 도는 것 막기)
    if (roomId) {
        let last = 0; try { last = Number(sessionStorage.getItem('buyin.autoBack.' + roomId) || 0); } catch (_e) { /* */ }
        if (Date.now() - last > 60 * 1000) {
            try { sessionStorage.setItem('buyin.autoBack.' + roomId, String(Date.now())); } catch (_e) { /* */ }
            gate(t('toRoom'));
            location.href = `${LOBBY_URL}/game/?room_id=${encodeURIComponent(roomId)}`;
            return;
        }
    }
    return gate(t('noTicket'), true);
}

async function post(path, body) {
    const res = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), cache: 'no-store' });
    const j = await res.json().catch(() => ({ ok: false, error: 'bad response' }));
    if (res.status === 401) { sessionStorage.removeItem('buyin.token'); }
    return j;
}
/**
 * [WS_0_10_10] 명령 — 웹소켓이 열려 있으면 그 연결로(새 연결을 맺지 않아 버튼이 바로 닿는다), 아니면 POST.
 * 웹소켓으로 보낸 명령이 8초 안에 답이 없으면 POST 로 한 번 더 보낸다(액션은 차례 번호 q 가 있어 두 번 처리되지 않는다).
 */
async function cmd(type, m = {}) {
    const es = S.es;
    if (es && es.cmd) {
        const r = await es.cmd(type, m);
        if (r) { if (r.code === 'auth') sessionStorage.removeItem('buyin.token'); return r; }
    }
    return post('/table/cmd', { token: S.token, type, ...m });
}

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
    let closed = false, ctl = null, lastByte = 0;
    const es = { addEventListener: (ev, f) => handlers.set(ev, f), close: () => { closed = true; if (ctl) ctl.abort(); clearInterval(dog); }, onopen: null };
    // [NET_LEAVE_0_10_9] 조용히 죽은 연결 감시 — 엔진은 15초마다 keep-alive 를 보낸다. 20초 동안 한 바이트도 없으면 끊고 다시 붙는다
    //   (휴대폰 망이 바뀌면 연결이 끊기지 않고 멈추기만 해, 화면이 멈춘 줄 몰랐다)
    const dog = setInterval(() => { if (ctl && lastByte && Date.now() - lastByte > 20000) { lastByte = 0; ctl.abort(); } }, 2000);
    (async function run(delay) {
        if (delay) await new Promise((r) => setTimeout(r, delay));
        if (closed) return;
        ctl = new AbortController();
        try {
            const res = await fetch('/table/events', { headers: { Authorization: 'Bearer ' + token }, cache: 'no-store', signal: ctl.signal });
            // [NET_LEAVE_0_10_9] 자리 토큰이 더는 맞지 않으면(정산·다른 기기) 계속 다시 붙지 않는다
            if (res.status === 401 || res.status === 403 || res.status === 404) { closed = true; clearInterval(dog); if (es.onfatal) es.onfatal(res.status); return; }
            lastByte = Date.now();
            if (es.onopen) es.onopen();
            const reader = res.body.getReader(), dec = new TextDecoder();
            let buf = '';
            for (;;) {
                const { value, done } = await reader.read();
                if (done) break;
                lastByte = Date.now();
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
        lastByte = 0;
        if (!closed && es.ondrop) es.ondrop();   // [NET_LEAVE_0_10_9]
        if (!closed) run(1500);
    })(0);
    return es;
}

/**
 * [WS_0_10_10] 웹소켓 — 이벤트와 명령을 연결 하나로. sseStream 과 같은 모양(addEventListener·close·onopen·ondrop·onfatal)에
 * cmd(type, m) 가 더 있다. 좌석 토큰은 연결 뒤 첫 메시지로 보낸다(주소에 싣지 않는다).
 * 서로 10초마다 한 줄씩 보내고, 25초 동안 아무것도 안 오면 끊고 다시 붙는다(휴대폰 망이 바뀌어 조용히 멈춘 연결).
 * 한 번도 열리지 않은 채 세 번 실패하면 onfallback — SSE + POST 로 돌아간다(웹소켓을 막는 망).
 */
function wsStream(token) {
    const handlers = new Map(), pend = new Map();
    let closed = false, ws = null, open = false, seq = 0, lastIn = 0, fails = 0;
    const es = {
        addEventListener: (ev, f) => handlers.set(ev, f),
        close: () => { closed = true; clearInterval(dog); if (ws) { try { ws.close(1000); } catch (_e) { /* */ } } },
        onopen: null,
        cmd(type, m) {
            if (!open || !ws) return Promise.resolve(null);
            const id = ++seq, w = ws;
            return new Promise((resolve) => {
                const tm = setTimeout(() => { pend.delete(id); resolve(null); }, 8000);
                pend.set(id, (r) => { clearTimeout(tm); resolve(r); });
                // [WS_RID_0_10_10] 요청 번호는 rid — 'id' 로 보내면 명령 내용의 id(이모티콘 종류)를 덮어써 엔진이 「unknown emote」로 거절했다
                try { w.send(JSON.stringify({ ...m, t: 'cmd', rid: id, type })); } catch (_e) { pend.delete(id); clearTimeout(tm); resolve(null); }
            });
        },
    };
    const dog = setInterval(() => {
        if (!ws || !open) return;
        if (Date.now() - lastIn > 25000) { try { ws.close(4000); } catch (_e) { /* */ } return; }
        try { ws.send('{"t":"ka"}'); } catch (_e) { /* */ }
    }, 10000);
    function connect(delay) {
        setTimeout(() => {
            if (closed) return;
            let w, opened = false;
            try { w = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/table/ws'); }
            catch (_e) { fails += 1; if (es.onfallback) { closed = true; clearInterval(dog); es.onfallback(); } return; }
            ws = w;
            w.onopen = () => {
                opened = true; open = true; fails = 0; lastIn = Date.now();
                w.send(JSON.stringify({ t: 'auth', token }));
                if (es.onopen) es.onopen();
            };
            w.onmessage = (e) => {
                lastIn = Date.now();
                let msg;
                try { msg = JSON.parse(e.data); } catch (_e) { return; }
                if (!msg || msg.ev === 'ka') return;
                if (msg.ev === 'res') { const f = pend.get(msg.id); if (f) { pend.delete(msg.id); f(msg.res); } return; }
                const f = handlers.get(msg.ev);
                if (f) f({ obj: msg.data });
            };
            w.onerror = () => { /* onclose 가 뒤따른다 */ };
            w.onclose = (e) => {
                if (ws === w) { ws = null; open = false; }
                for (const f of pend.values()) f(null);
                pend.clear();
                if (closed) return;
                // 좌석 토큰이 더는 맞지 않으면(정산·다른 기기) 다시 붙지 않는다 — SSE 의 401 과 같다
                if (e.code === 4401) { closed = true; clearInterval(dog); if (es.onfatal) es.onfatal(401); return; }
                if (!opened) fails += 1;
                if (fails >= 3 && es.onfallback) { closed = true; clearInterval(dog); es.onfallback(); return; }
                if (opened && es.ondrop) es.ondrop();
                connect(opened ? 1000 : 1500);
            };
        }, delay);
    }
    connect(0);
    return es;
}

function listen() {
    if (S.es) S.es.close();
    const useWs = !S.noWs && typeof WebSocket === 'function';
    const es = S.es = useWs ? wsStream(S.token) : sseStream(S.token);
    if (useWs) es.onfallback = () => { S.noWs = true; console.warn('[table] websocket unavailable — using SSE'); listen(); };
    // [NET_LEAVE_0_10_9] 연결 상태 — 원본처럼 8초 안이면 위쪽 작은 알약, 넘으면 전체 화면, 15초 넘으면 새로고침 버튼
    es.ondrop = () => { if (!S.offline) S.offline = Date.now(); paintNet(); };
    es.onfatal = () => { S.offline = 0; paintNet(); sessionStorage.removeItem('buyin.token'); forgetSeat(S.seatRoom); gate(t('netGone'), true); };
    const on = (ev, f) => es.addEventListener(ev, (e) => { try { f(e.obj !== undefined ? e.obj : JSON.parse(e.data)); } catch (err) { console.error(ev, err); } });
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
        if (d.seat !== mySeat()) { stopTurnSfx(); flushTips(); }   // [SFX_ORIG_0_10_9] · [TIP_DEFER_0_10_9]
        if (fresh && d.seat === mySeat()) {
            stopTurnSfx(); if (S.turnAlert) startTurnSfx();   // [SFX_ORIG_0_10_9] 내 차례 동안 반복 · [SETTINGS2_0_10_23] 끌 수 있다
            if (S.vibrate && typeof navigator.vibrate === 'function') { try { navigator.vibrate([70, 50, 70]); } catch (_e) { /* */ } }   // [SETTINGS2_0_10_23] 내 차례 진동(안드로이드)
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
        gatherBets();   // [CHIP_FLY_0_10_9] 걷기 전에 칩이 팟으로 들어가는 연출
        S.hand.board.push(...d.cards); S.hand.stage = d.stage; clearBets(); play('board');   // [SFX_BOARD_WIN_2026_11_13] 플랍·턴·리버 — 나눠 주는 소리(card)와 따로
        if (S.tipGift && d.stage === 'river') endTipPick();   // [TIP_TURN_0_10_11] 리버에서 닫는다
        render();
    });
    // [SHOW_CARDS_0_10_9] 폴드승한 사람이 보여 준 카드 — 판 시작 때 받은 카드 약속과 대조하고 그 자리에 앞면으로
    on('shown', (d) => {
        if (!S.hand || S.hand.handId !== d.handId) return;
        checkPublic(d.handId, d.cards || []);
        const cs = d.cards || [];
        S.reveal[d.seat] = d.which === 'both' ? cs : d.which === 'left' ? [cs[0], null] : [null, cs[0]];
        S.keepHand = d.handId;
        if (d.seat === mySeat()) S.canShow = '';
        render();
    });
    on('raise-time', (d) => { floatTag(d.seat, '+10s'); });   // [RAISE_TIME_0_10_9] 레이즈 바를 잡으면 한 차례 한 번 +10초(엔진)
    on('raising', (d) => { S.raising = d.active ? { seat: d.seat, q: d.q } : null; render(); });
    on('dark', (d) => { S.darkNext = !!d.reserved; paintDark(); render(); });
    // [DARK_PEEK_0_10_11] 다크인 사람이 플랍부터 자기 카드를 봤다 — 그 자리 다크 연출을 모두의 화면에서 끈다
    on('peek', (d) => {
        if (!S.hand || S.hand.handId !== d.handId) return;
        S.hand.dark = (S.hand.dark || []).filter((x) => x !== d.seat);
        if (d.seat === mySeat()) darkOpen(d.handId);
        render();
    });
    on('emote', showEmote);
    // [TIP_DEFER_0_10_9] 원본 — 내 차례 동안 온 팁 연출은 차례가 끝난 뒤 순서대로(큰 연출이 액션 버튼을 가리지 않게)
    on('tip', (d) => { if (S.turn && S.turn.seat === mySeat()) { S.tipQ.push(d); return; } flyGift(d.from, d.to, d.type, d.amount); });
    on('tip-done', (d) => {
        for (const [seat, st] of Object.entries(d.stacks || {})) if (S.seats[seat]) S.seats[seat].stack = st;
        // [TIP_HOUSE_0_10_12] 본사 팁은 받는 사람 칩이 늘지 않는다 — 받는 쪽 「+금액」 대신 보낸 나에게만 「-금액」
        if (d.house) { if (d.from === mySeat()) tipBadge(d.from, d.amount, t('tipDone'), '-'); }
        else tipBadge(d.to, d.amount, t('tipDone'));
        render();
    });
    on('tip-cancel', (d) => { if (d.from === mySeat()) toast(t('tipCancel'), 3200, 'warn'); });
    on('chat', onChat);
    on('watch', (d) => { S.watchInfo = d || null; renderWatch(); });   // [WATCH_0_10_20] 지금 관전 중인 방장
    on('timebank', (d) => {
        if (d.seat === mySeat() && S.me) { S.me.timeBank = d.left; if (S.turn) S.tbUsed = S.turn.handId + ':' + S.turn.q; }
        floatTag(d.seat, '+' + Math.round(d.addedMs / 1000) + 's');
        render();
    });
    on('gate', onGate);           // [READY_SESSION_0_10_6]
    on('session', onSession);
    on('runout', onRunout);
    on('result', onResult);
    on('aborted', () => { S.hand = null; S.turn = null; S.sd = null; flushSeats(); render(); });
    on('settled', (d) => { sessionStorage.removeItem('buyin.token'); forgetSeat(S.seatRoom, { cash: d.cashOut }); es.close(); gate(`${t(d.reason === 'away' ? 'awayLeft' : 'settled')} ${dmCur(d.cashOut)}`, true); });   // [AWAY_0_10_16] 자리 비움 10분   // [RESUME_0_10_11] 다시 열려도 「정산 끝」
    on('error', (d) => { if (d && d.code === 'auth') { sessionStorage.removeItem('buyin.token'); es.close(); gate(t('noTicket')); } else if (d && d.error) toast(d.error); });
    es.onopen = () => { S.retry = 0; S.offline = 0; paintNet(); };   // [NET_LEAVE_0_10_9] 다시 붙으면 연결 표시를 걷는다
}

// ------------------------------------------------------------ 이벤트

async function onSnapshot(d) {
    S.snap = d; S.room = d.room; if (d.room && d.room.id) S.seatRoom = String(d.room.id);   // [RESUME_0_10_11]
    S.tableId = d.tableId; S.me = d.me; S.seats = d.seats; S.engine = S.engine || d.engine;
    layoutMode();   // [MOBILE_FIT2_0_10_9] 11석이면 위쪽 자르기를 줄인다(방 크기는 여기서 안다)
    S.hand = d.hand ? { ...d.hand, board: [...d.hand.board] } : null;
    S.turn = d.turn; S.reveal = (d.hand && d.hand.reveal) || {};
    S.watch = !!d.me.watch;   // [WATCH_0_10_20]
    S.watchInfo = d.watch || null;
    document.body.classList.toggle('watching', S.watch);
    S.darkNext = !!d.me.darkNext;
    if (S.hand && (S.hand.dark || []).includes(d.me.seat)) S.darkHand = S.hand.handId;
    for (let k = 0; k < (S.hand ? S.hand.board.length : 0); k++) S.anim[`b:${S.hand.handId}:${k}`] = 0;   // 들어올 때 이미 깔린 카드는 연출 없이
    paintRoomLabel(); paintDark();
    hideGate();
    S.gate = d.gate || null; S.gateShowAt = 0;   // [READY_SESSION_0_10_6]
    S.session = d.session || null; if (S.session && S.session.serverNow) S.skew = S.session.serverNow - Date.now();
    if (S.gate && S.gate.serverNow) S.skew = S.gate.serverNow - Date.now();
    if (!S.watch) {   // [WATCH_0_10_20] 관전은 판에 들지 않는다 — 키 등록·무작위 값·홀카드 없음
        if (!d.me.keys || !S.keys || !S.keys.sigJwk) await registerKeys();
        if (d.hole && d.hole.envelope) await openHole(d.hole);
        await sendEntropy(d.hand ? d.hand.nextSeedCommit : d.seedCommit);
    } else openHostPop(false);   // 바이인 신청 목록을 미리 띄워 둔다(숨긴 채) — 새 신청 수를 배지로
    S.live = true;   // 이제부터 오는 이벤트는 실시간 — 연출을 한다
    // [PRELOAD_0_10_10] 입장하자마자 효과음을 받아 해독해 둔다(소리 장치는 첫 터치에 켜진다 — 종전엔 첫 터치에야 받기 시작해 첫 소리들이 늦거나 빠졌다)
    setTimeout(() => { if (audio()) preloadSfx(); }, 300);
    setTimeout(preloadImages, 1000);
    preloadPickImages();
    setTimeout(preloadRoyal, 2500);   // [TIP_ROYAL_0_10_5] 로열 팁 영상 — 자리 화면이 다 뜬 뒤
    setTimeout(preloadFxVideos, 1500);   // [VIDEO_RELEASE_0_10_9] 올인 불꽃·감정 영상
    setTimeout(mountShowdownFx, 1000);   // [WINNER_SD_VFX_0_10_9] SHOW DOWN 그림 미리 decode(원본 warmShowdownVfx)
    render();
}

async function registerKeys() {
    S.keys = await V.loadKeys(S.me.odcId || ('seat' + S.me.seat));
    const odcId = S.me.odcId;
    const proof = await V.sign(S.keys, V.msg.register(S.tableId, odcId, S.keys.sigFp, S.keys.ecdhFp));
    const r = await cmd('keys', { sig: S.keys.sigJwk, ecdh: S.keys.ecdhJwk, proof });
    if (!r.ok) return toastErr(r.error || 'key registration failed');
    // 엔진이 "이 두 키를 받았다"에 서명했나 — 운영 쪽이 키를 바꿔 끼우면 여기서 걸린다
    const okConfirm = S.engine && await V.verify(S.engine.sig, V.msg.keyConfirm(S.tableId, odcId, S.keys.sigFp, S.keys.ecdhFp), r.confirm);
    if (!okConfirm) S.att = 'mismatch';
    S.me.keys = true;
    renderBadge();
}

async function sendEntropy(seedCommit) {
    if (S.watch) return;   // [WATCH_0_10_20]
    if (!seedCommit || !S.keys || S.entropySentFor === seedCommit) return;
    S.entropySentFor = seedCommit;
    const hex = V.randomHex(32);
    const sig = await V.sign(S.keys, V.msg.entropy(S.tableId, seedCommit, hex));
    const r = await cmd('entropy', { seedCommit, hex, sig });
    if (!r.ok && r.code !== 'stale') console.warn('entropy', r.error);
}

function onHand(h) {
    stopTurnSfx();   // [SFX_ORIG_0_10_9]
    S.heroFlipAt = 0;   // [HERO_DEAL_FLIP_0_10_10]
    S.canShow = ''; S.keepHand = '';   // [SHOW_CARDS_0_10_9]
    flushSeats();   // [SHOWDOWN_SEQ_0_10_4] 지난 판 연출 중에 모아 둔 좌석 갱신
    S.sd = null;
    S.hand = { ...h, board: [...h.board] };
    // [SIDEPOT_0_10_9] 판 시작 스택(블라인드 포함) — 판 도중 사이드팟을 화면에서 나눠 보이는 데만 쓴다(지급은 엔진 결과)
    S.hand.start = Object.fromEntries(h.seats.map((p) => [p.seat, (Number(p.stack) || 0) + (Number(p.bet) || 0)]));
    S.winPots = null;
    S.turn = null; S.reveal = {}; S.bubbles = {}; S.winners = null; S.hole = null; S.holeOk = null;
    S.raising = null; S.preAct = ''; S.rabbit = null; endTipPick();
    S.anim = {};   // 지난 판 연출 시각은 버린다
    if ((h.dark || []).includes(mySeat())) { S.darkHand = h.handId; S.darkNext = false; paintDark(); }
    if (S.live && (h.dark || []).length) setTimeout(() => { for (const st of h.dark) darkBurst(st); }, 120);   // [ITD_ORIG_0_10_9] 판 시작 입장 연출
    for (const p of h.seats) {
        if (S.seats[p.seat]) S.seats[p.seat].stack = p.stack;
        if (p.bet > 0) S.bubbles[p.seat] = { a: 'BLIND', amt: p.bet, at: Date.now() };
    }
    sendEntropy(h.nextSeedCommit);
    paintRoomLabel();
    // [READY_SESSION_0_10_6] 마지막 판이면 「마지막 N / 3판」
    const ss = S.session;
    const fin = ss && ss.phase === 'final' && ss.finalNo > 0;
    showBanner(fin ? tnm('ssFinalN', ss.finalNo, ss.finalTotal) : 'GAME START', fin ? 2600 : 2000); play('start'); play('card');
    renderClock();
    renderNow();   // [RENDER_RAF_0_10_9] 딜 비행이 그려진 카드 자리를 잰다
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
        // [MOBILE_BOARD_0_10_9] 원본: 모바일도 리버는 뒷면 1.5배로 보였다가 뒤집는다, 모바일 플랍·턴은 1.2초
        const cls = fast ? (k === 4 ? 'fast river-glow' : 'fast') : k === 4 ? 'river' : mobile ? 'in-m' : 'in-pc';
        const dur = fast ? 1.6 : k === 4 ? 2.3 : 1.2;
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
        // [HERO_DEAL_FLIP_0_10_10] 뒷면으로 받고 뒤집기 — PC·모바일 모두(종전 모바일은 처음부터 앞면). 'deal' 은 0.71초 중 앞 0.38초가 뒷면이라
        //   뒤집기가 두 장 도착 뒤(heroFlipAt)에 시작되게 그만큼 당겨 둔다
        if (!(hk in S.anim)) S.anim[hk] = S.live ? Math.max(Date.now() + 250, (S.heroFlipAt && S.heroFlipAt > Date.now() - 5000 ? S.heroFlipAt : 0)) - 380 : 0;
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
    // [ACT_FAST_0_10_10] 누를 때 미리 띄운 내 말풍선이면 시각을 그대로(등장 연출이 두 번 돌지 않게) — 금액만 붙는다
    const ob = S.bubbles[d.seat];
    S.bubbles[d.seat] = { a: d.action, amt: d.amount, at: ob && ob.optimistic && d.seat === mySeat() ? ob.at : Date.now() };
    if (S.raising && S.raising.seat === d.seat) S.raising = null;
    if (S.turn && S.turn.seat === d.seat) S.turn = null;
    if (d.seat === mySeat()) { hideActions(); stopTurnSfx(); if (d.action === 'FOLD' || d.action === 'ALL_IN') S.preAct = ''; }
    // [SFX_ORIG_0_10_9] 내가 이미 누를 때 소리를 낸 액션이면(엔진 메아리) 건너뛴다. 시간 초과 자동 폴드·예약 체크 등은 그대로 소리
    const hs = d.seat === mySeat() && S.heroSfx;
    if (hs && hs.cls === sfxCls(d.action) && Date.now() - hs.at < 5000) S.heroSfx = null;
    else sfx(d.action, d.seat);
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
    // [WIN_FX_ALWAYS_0_10_23] 받은 금액(gross) — 나눠 가진 팟(찹)은 승자마다 순이익(net)이 0 이하일 수 있어(레이크), 종전엔 카드만 열고 승자 연출·칩 지급·승리음이 없었다
    const gross = {};
    if (r.type === 'uncontested') gross[r.winner] = (gross[r.winner] || 0) + (r.amount || 0);
    else for (const w of r.winners || []) if (!w.isUncalledReturn) gross[w.seat] = (gross[w.seat] || 0) + (Number(w.amount) || Math.max(0, w.net || 0));
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
        for (const seat of seq) setTimeout(() => { if (S.hand && S.hand.handId === hid) render(); }, at[seat] - now);   // [SD_NO_CARD_SFX_0_10_11] 패를 열 때 카드 나눠 주는 소리를 내지 않는다
    }

    // 결과 전 — 차례·베팅을 걷고 팟은 남긴다. 말풍선도 남긴다(운영 화면처럼 마지막 액션이 보인다)
    S.turn = null; S.hand.toAct = null; stopTurnSfx();
    setTimeout(flushTips, 300);   // [TIP_DEFER_FIX_0_10_10] 내 차례인 채로 판이 끝나도 미뤄 둔 팁 연출을 낸다
    gatherBets();   // [CHIP_FLY_0_10_9]
    for (const p of S.hand.seats) p.bet = 0;
    hideActions();
    render();

    const apply = () => {
        if (!S.hand || S.hand.handId !== hid) return;
        flushRender();   // [RENDER_RAF_0_10_9] 팟 자리를 재기 전에
        if (S.darkHand === hid) showDarkReveal();
        for (const [seat, st] of Object.entries(d.stacks || {})) if (S.seats[seat]) S.seats[seat].stack = st;
        S.winners = winners;
        payWinners(gross);   // [CHIP_FLY_0_10_9] · [WIN_FX_ALWAYS_0_10_23] 받은 금액으로(찹도 칩이 날아간다) 팟 칩이 승자에게 날아간다(그리기 전 — 팟 자리가 아직 있다)
        // [WINNER_SD_VFX_0_10_9] 경합 쇼다운 승자만(폴드승 제외 — 원본), 판당 한 번, 칩이 날아간 뒤
        // [SIDEPOT_0_10_9] 지급되는 팟 칸을 빛나게(원본 팟 패널) — 엔진 결과의 potIndex 그대로
        S.winPots = new Set((r.winners || []).filter((w) => !w.isUncalledReturn).map((w) => (typeof w.potIndex === 'number' ? w.potIndex : 0)));
        if (d.type === 'showdown' && S.vfxHand !== hid) {
            S.vfxHand = hid;
            // [SIDEPOT_0_10_9] 원본 WinnerVFX 변형 — 메인팟 = 금색 WINNER, 사이드팟만 = 초록 SIDE, 돌려받은 미콜만 = 은색 UNCALLED
            const kind = {};
            for (const w of r.winners || []) {
                const k = w.isUncalledReturn ? 'uncalled' : (w.potIndex > 0 ? 'side' : 'main');
                const rank = { main: 3, side: 2, uncalled: 1 };
                if (!kind[w.seat] || rank[k] > rank[kind[w.seat]]) kind[w.seat] = k;
            }
            for (const st of Object.keys(kind)) if (kind[st] === 'main' && !(gross[st] > 0)) delete kind[st];   // [WIN_FX_ALWAYS_0_10_23] 메인 팟에서 받은 게 있으면 승자 연출(찹 포함)
            setTimeout(() => { if (S.hand && S.hand.handId === hid) for (const [st, k] of Object.entries(kind)) winnerVfx(Number(st), hands[st] || '', k); }, 600);
        }
        flushSeats();
        if (Object.values(gross).some((v) => v > 0)) play('win');
        // [FX_SMALL_0_10_9] 원본 WinEffect — 내가 폴드승(경합 없이)으로 이기면 1.5초 뒤 꽃가루
        if (d.type !== 'showdown' && win[mySeat()] > 0) setTimeout(() => { if (S.hand && S.hand.handId === hid) confetti(); }, 1500);
        // [SHOW_CARDS_0_10_9] 폴드승이면 다음 판 전까지 「왼쪽 / 둘 다 / 오른쪽」으로 내 카드를 보여 줄 수 있다(인 더 다크 판은 제외)
        if (d.type !== 'showdown' && win[mySeat()] > 0 && S.darkHand !== hid) S.canShow = hid;   // [SFX_BOARD_WIN_2026_11_13] 승자 연출 — 종전엔 내가 이겼을 때만 났다
        render();
        // 래빗을 열었으면 다음 판이 올 때까지 보드를 남긴다(예전 화면)
        const clear = () => {
            if (!S.hand || S.hand.handId !== hid) return;
            // [SHOW_CARDS_0_10_9] 보여 준 카드는 다음 판까지 남긴다 — [SHOW_KEEP_FIX_0_10_10] 다음 판이 안 오면(대기실 등) 8초 뒤에는 걷는다
            if (S.keepHand === hid) { setTimeout(() => { if (S.hand && S.hand.handId === hid) { S.keepHand = ''; clear(); } }, 8000); return; }
            if (S.rabbit && S.rabbit.open) return;
            S.hand = null; S.winners = null; S.reveal = {}; S.hole = null; S.rabbit = null; S.sd = null; render();
        };
        setTimeout(clear, S.rabbit ? 4800 : 3800);
    };
    if (winAt > now + 20) setTimeout(apply, winAt - now); else apply();
}

/**
 * [RUNOUT_TENSION_0_10_7] 올인 런아웃 보드 시간표(ms). 단계는 뒤에서부터 리버·턴·플랍(올인 시점에 따라 1~3단계).
 *   at: 런아웃 보드 시작부터 그 단계 시작, gap: 한 단계 안 카드 간격, flip: 시작부터 앞면이 보이기 시작하는 때(소리), dur: 연출 길이
 *   TableServer.showdownMs 의 RUNOUT_STAGE_MS 와 같은 값이어야 한다(플랍→턴 2400, 턴→리버 2800, 리버 꼬리 2600)
 */
const RUNOUT = {
    flop: { next: 2400, gap: 350, flip: 0, dur: 900, cls: 'sd-flop' },
    turn: { next: 2800, gap: 0, flip: 900, dur: 1600, cls: 'sd-turn' },
    river: { next: 2600, gap: 0, flip: 1500, dur: 2600, cls: 'sd-river' },
};
function runoutPlan(n) {
    const names = ['flop', 'turn', 'river'].slice(3 - Math.max(0, Math.min(3, n)));
    let at = 0;
    return names.map((nm) => { const p = { ...RUNOUT[nm], at }; at += RUNOUT[nm].next; return p; });
}
function runoutBoardMs(n) { return runoutPlan(n).reduce((a, p) => a + p.next, 0); }

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
    // [DARK_PEEK_0_10_11] 올인 런아웃 — 다크였던 내 패도 바로 연다(종전엔 결과 때 열렸다). 엔진도 이 판 다크를 끝낸다
    darkOpen(hid); S.hand.dark = [];
    gatherBets(); clearBets(); S.turn = null; S.hand.toAct = null; hideActions();   // [CHIP_FLY_0_10_9]
    const stages = d.stages || [];
    if (!S.live) {   // 들어오자마자 받은 이벤트 — 연출 없이
        for (const x of stages) S.hand.board.push(...x.cards);
        render();
        return;
    }
    const at = {};
    seats.forEach((seat, i) => { at[seat] = now + 1600 + i * 400; });
    for (const seat of seats) if (seat !== mySeat()) setTimeout(() => { if (S.hand && S.hand.handId === hid) render(); }, at[seat] - now);   // [SD_NO_CARD_SFX_0_10_11]
    const t0 = now + 1600 + Math.max(0, seats.length - 1) * 400 + 600;
    /* [RUNOUT_TENSION_0_10_7] 보드를 긴장감 있게 — 종전에는 플랍·턴·리버가 1초 간격으로 0.55초 만에 휙휙 열렸다.
       플랍: 한 장씩(0.35초 간격) 뒤집기 → 2.4초 쉬고 턴: 뒷면을 크게 보였다가 뒤집기 → 2.8초 쉬고 리버: 뒷면을 더 오래 보였다가 뒤집고 빛.
       단계 시간표는 RUNOUT 한 곳 — TableServer.showdownMs 와 같은 값(다음 판을 그만큼 늦춘다) */
    const plan = runoutPlan(stages.length);
    stages.forEach((x, j) => {
        const st = plan[j];
        const start = t0 + st.at;
        const from = S.hand.board.length;
        x.cards.forEach((_c, i) => {
            const k = from + i;
            const key = `b:${hid}:${k}`;
            S.anim[key] = start + i * st.gap;
            S.anim[key + ':c'] = { cls: st.cls, delay: 0, dur: st.dur / 1000 };
            S.anim[key + ':v'] = start + i * st.gap + st.flip;   // 앞면이 보이는 때 — 족보 글자가 뒷면일 때 미리 알려 주지 않게(shownBoard)
        });
        S.hand.board.push(...x.cards);
        // 소리는 카드가 실제로 뒤집히는 순간에
        setTimeout(() => { if (S.hand && S.hand.handId === hid) { play('board'); render(); } }, start + st.flip - now);   // [SFX_BOARD_WIN_2026_11_13] 런아웃 보드
        if (st.flip > 0) setTimeout(() => { if (S.hand && S.hand.handId === hid) render(); }, start - now);
    });
    const boardEnd = t0 + runoutBoardMs(stages.length);
    S.sd = { handId: hid, at, winAt: boardEnd + 700, ranks: null };   // 런아웃은 보드가 다 깔린 뒤에 족보 — 미리 알려 주지 않는다
    playShowdownFx(); play('showdown');   // 올인으로 베팅이 끝났다 — [WINNER_SD_VFX_0_10_9] 원본 SHOW DOWN 연출
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
    return h.board.filter((_c, k) => !(S.anim[`b:${h.handId}:${k}`] > now) && !(S.anim[`b:${h.handId}:${k}:v`] > now)).map(codeOf);
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
    if (shown.length > 2) m.classList.add('om', 'om' + shown.length);   // [OMAHA_0_10_23] 공개된 4·5장 — 겹쳐 펼침
    shown.forEach((c, i) => {
        const w = el('div', 'mc');
        const code = codeOf(c);
        w.appendChild(timed ? flipEl(code, winLook(code), `sd:${sd.handId}:${seat}:${i}`, 'sd', i * 0.12, 0.6) : cardEl(code, winLook(code)));
        m.appendChild(w);
    });
}

/**
 * [CHIP_FLY_0_10_9] 베팅 칩 → 팟 모으기(원본 TableBetChip 수거): 지금 화면의 베팅 칩 더미를 #fx 에 복제해 팟 가운데로
 * 0.55초 easeIn, 0.45배, 사라지며 들어간다. 스트리트가 바뀔 때·결과 직전에 부른다(그 뒤 clearBets 가 실제로 걷는다)
 */
function gatherBets() {
    if (!S.live || document.hidden) return;
    flushRender();   // [RENDER_RAF_0_10_9] 방금 온 베팅까지 그려진 자리에서 걷는다
    const pot = $('.pot-chips'), fx = $('#fx');
    if (!pot) return;
    const pr = pot.getBoundingClientRect(), px = pr.left + pr.width / 2, py = pr.top + pr.height / 2;
    document.querySelectorAll('#bets .bet .stack').forEach((st) => {
        const r = st.getBoundingClientRect();
        if (!r.width) return;
        const c = flyBox(st.firstElementChild ? st.firstElementChild.cloneNode(true) : st.cloneNode(true), r);
        if (!c) return;
        const k = c._k, dx = px - (r.left + r.width / 2), dy = py - (r.top + r.height / 2);
        c.animate([{ transform: `translate(0,0) scale(${k})`, opacity: 1 }, { transform: `translate(${dx}px,${dy}px) scale(${k * 0.45})`, opacity: 0 }],
            { duration: 550, easing: 'cubic-bezier(.55,0,1,.45)', fill: 'forwards' });
        setTimeout(() => c.remove(), 600);
    });
}
/** 칩 더미 복제본을 #fx 에 — 화면에 보이는 크기(rect)와 같게(모바일 화폭 배율·베팅 칩 배율까지) 가운데를 맞춰 둔다 */
function flyBox(node, rect) {
    const c = el('div', 'chip-fly');
    c.appendChild(node);
    $('#fx').appendChild(c);
    const w = c.offsetWidth, h = c.offsetHeight;
    if (!w || !h) { c.remove(); return null; }
    c._k = rect.width / w;
    c.style.left = (rect.left + rect.width / 2 - w / 2) + 'px'; c.style.top = (rect.top + rect.height / 2 - h / 2) + 'px';
    c.style.transform = `scale(${c._k})`;
    return c;
}
/**
 * [CHIP_FLY_0_10_9] 팟 → 승자 지급(원본 FlyingPotStack): 승자마다 220ms 간격으로 지급액만큼의 칩 더미가 팟 가운데서
 * 승자 아바타로 0.7초 포물선(1 → 1.05 → 0.65배)을 그리며 날아간다. 칩·금액은 이미 엔진이 정했다 — 그림뿐
 */
function payWinners(win) {
    if (!S.live || document.hidden) return;
    const pot = $('.pot-chips');
    if (!pot) return;
    const pr = pot.getBoundingClientRect(), px = pr.left + pr.width / 2, py = pr.top + pr.height / 2;
    const one = pot.querySelector('.chip-col'), unit = one ? one.getBoundingClientRect().width : (S.layout === 'mobile' ? 27 : 40);
    Object.entries(win).filter(([, v]) => v > 0).forEach(([seat, amt], i) => {
        setTimeout(() => {
            const r = avatarRect(Number(seat));
            if (!r) return;
            const stack = chipStackEl(amt, { single: true, cap: 6 });
            const c = flyBox(stack, { left: px - unit / 2, top: py - unit / 2, width: unit, height: unit });
            if (!c) return;
            // flyBox 는 폭을 칩 하나에 맞춘다 — 더미 폭이 칩 한 개(40px)일 때 배율 = unit/40
            const k = unit / 40; c.style.transform = `scale(${k})`;
            const tx = r.left + r.width / 2 - px, ty = r.top + r.height / 2 - py, lift = Math.min(-60, ty / 2 - 80);
            c.animate([
                { transform: `translate(0,0) scale(${k})`, opacity: 1 },
                { transform: `translate(${tx / 2}px,${lift}px) scale(${k * 1.05})`, opacity: 1, offset: 0.45 },
                { transform: `translate(${tx}px,${ty}px) scale(${k * 0.65})`, opacity: 0.2 },
            ], { duration: 700, easing: 'cubic-bezier(.55,0,1,.45)', fill: 'forwards' });
            setTimeout(() => c.remove(), 760);
        }, i * 220);
    });
}
function clearBets() {
    if (!S.hand) return;
    for (const p of S.hand.seats) p.bet = 0;
    S.bubbles = Object.fromEntries(Object.entries(S.bubbles).filter(([, b]) => b.a === 'FOLD' || b.a === 'ALL_IN'));
}

// ------------------------------------------------------------ 배치 계산

/** [MOBILE_FIT_0_10_7] 휴대폰에서 글을 쓰는 중인가 — 키보드가 올라오면 창 높이가 줄어 가로가 더 길어진다 */
function typingOnPhone() {
    const a = document.activeElement;
    return !!a && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA') && matchMedia('(pointer: coarse)').matches;
}
function layoutMode() {
    const tb = $('#table');
    // [MOBILE_FIT_0_10_7] 채팅을 쓰는 동안(키보드) 배치를 바꾸지 않는다 — 종전엔 키보드가 올라오면 세로 < 가로가 되어 PC 화면으로 바뀌었다
    if (S.layout && typingOnPhone()) return;
    const portrait = innerHeight > innerWidth;
    // [ROTATE_0_10_9] 휴대폰을 가로로 눕히면 원본처럼 「세로로 돌려 주세요」 — 종전엔 PC 배치가 작게 들어가 좌석·버튼이 겹쳤다
    const phone = matchMedia('(pointer: coarse)').matches && Math.min(screen.width, screen.height) < 768;
    $('#rotate').hidden = !(phone && !portrait);
    S.layout = portrait ? 'mobile' : 'pc';
    tb.classList.toggle('pc', !portrait);
    tb.classList.toggle('mobile', portrait);
    applyBg(false);   // [SKIN_PICK_0_10_12] 고른 테이블 스킨(없으면 기본)
    // 운영 화면: 높이 900 에서 0.742 배
    $('#actions').style.transform = portrait ? '' : `translateX(-50%) scale(${(0.742 * innerHeight / 900).toFixed(3)})`;
    $('#dark-dock').style.transform = $('#actions').style.transform;   // [DARK_BY_ACTIONS_0_10_11] 액션 줄과 같은 배율
    // 모바일: 390x844 화폭을 화면 안에 다 들어오게(가로·세로 중 작은 쪽에 맞춰) 늘리고 가운데.
    // [MOBILE_FIT_0_10_7] 종전엔 가로에만 맞춰, 주소창·아래 도구막대가 있는 휴대폰 브라우저(세로가 짧다)에서 아래 베팅 박스가 잘렸다
    // [ZOOM_FS_0_10_9] 원본 「화면 크기」(60~100%) — 모바일 화폭에만 곱한다. 기본 100%
    // [MOBILE_FIT2_0_10_9] 세로가 모자라면 먼저 화폭 맨 위의 빈 테이블(위쪽 자리 위)을 잘라 내고, 그래도 모자랄 때만 줄인다. 아래(버튼)는 화면 아래에 붙인다.
    //   종전(가로·세로 중 작은 쪽)은 주소창·도구막대가 있는 폰에서 양옆 여백이 커져 테이블이 작았다. 11석은 위쪽 자리가 높아 40px 까지만
    const crop = maxSeats() > 9 ? 40 : 100;
    const k = Math.min(innerWidth / 390, innerHeight / (844 - crop)) * (portrait ? S.zoom : 1);
    tb.style.setProperty('--k', k.toFixed(4));
    tb.style.setProperty('--oy', (844 * k <= innerHeight ? (innerHeight - 844 * k) / 2 : innerHeight - 844 * k).toFixed(1) + 'px');
    tb.style.setProperty('--ox', Math.max(0, (innerWidth - 390 * k) / 2).toFixed(1) + 'px');
}

const mySeat = () => (S.me ? S.me.seat : -1);
/** [OMAHA_0_10_23] 이 방이 오마하(PLO4·PLO5)인가 — 좌석표 room.game */
const isOmaha = () => !!(S.room && S.room.game && S.room.game !== 'holdem');
/** [OM_BACKS_0_10_23] 한 사람이 받는 홀카드 수 — 홀덤 2 · PLO4 4 · PLO5 5(남의 뒷면 카드·딜 연출이 이 수만큼) */
const holeN = () => (S.room && S.room.game === 'plo5' ? 5 : S.room && S.room.game === 'plo4' ? 4 : 2);
/** [OM_BACKS_0_10_23] 히어로 기준 오른쪽 자리(오른쪽 위·오른쪽·오른쪽 아래) — 카드를 프로필 왼쪽 위에 두어 왼쪽에서 연다 */
const rightSide = (a) => (a.role || 0) >= 5;
const gameLabel = () => (S.room && S.room.game === 'plo5' ? 'PLO5' : S.room && S.room.game === 'plo4' ? 'PLO4' : '');
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
        if (n > 9 && i > 0 && MOBILE_POS_11[i]) {   // [MOBILE_11_0_10_7]
            const [x, y] = MOBILE_POS_11[i];
            return { x, y, role: ROLE_11[i], scale: MOBILE_11_SCALE };
        }
        if (n === 6) {   // [SEATS6_0_10_23] 6인 방 — 9석 자리 중 고르게(위 가운데는 4·5번 사이)
            const k = SIX_SLOT[i];
            const [[xp, xo], [yp, yo]] = k < 0 ? MOBILE_TOP_MID : MOBILE_POS[k];
            return { x: 390 * xp / 100 + xo, y: 844 * yp / 100 + yo, role: k < 0 ? 4 : k, scale: 1 };
        }
        const [[xp, xo], [yp, yo]] = MOBILE_POS[Math.min(i, 8)];
        return { x: 390 * xp / 100 + xo, y: 844 * yp / 100 + yo, role: i, scale: 1 };
    }
    const iw = W - 4, ih = H - 4;
    const table = n > 9 ? PC_POS_11 : PC_POS;
    let role = n > 9 ? ROLE_11[i] : i;
    let pos = table[i] || PC_POS[0];
    if (n === 6) { const k = SIX_SLOT[i]; pos = k < 0 ? PC_TOP_MID : PC_POS[k]; role = k < 0 ? 4 : k; }   // [SEATS6_0_10_23]
    const [[xp, xo], [yp, yo]] = pos;
    return { x: 2 + iw * xp / 100 + xo, y: 2 + ih * yp / 100 + yo, role, scale: 1 };
}

// ------------------------------------------------------------ 그리기

/**
 * [RENDER_RAF_0_10_9] 그리기는 프레임당 한 번 — 이벤트(액션·좌석·차례·말풍선…)가 같은 프레임에 여러 개 와도 한 번만 다시 그린다
 * (종전엔 이벤트마다 바로 전체를 지우고 다시 만들어 저사양 폰에서 깜빡임·터치 지연이 났다). 화면 위치를 재는 곳은 flushRender() 뒤에 잰다.
 * 탭이 숨겨진 동안은 그리지 않고, 돌아오면 한 번 그린다.
 */
let renderQ = 0;
function render() {
    if (renderQ) return;
    renderQ = requestAnimationFrame(() => { renderQ = 0; renderNow(); });
}
function flushRender() { if (renderQ) { cancelAnimationFrame(renderQ); renderQ = 0; renderNow(); } }
function renderNow() {
    renderShowPick();
    renderBoard();
    renderSeats();
    renderBets();
    renderActions();
    renderRebuy();
    renderAway();   // [AWAY_0_10_16]
    renderWatch();   // [WATCH_0_10_20]
    renderBadge();
    renderGate();
    renderClock();
    keepInside();   // [SIDE_OUT_0_10_17]
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

function openRebuyPop() {
    if (!S.token || !S.room) return;
    cmd('rebuy').catch(() => { /* 말풍선 「바이인요~」는 덤 */ });
    const pop = $('#rebuy-pop'), fr = $('#rebuy-pop .rp-frame');
    let lt = ''; try { lt = sessionStorage.getItem('buyin.lt') || ''; } catch (_e) { /* */ }
    const src = `${LOBBY_URL}/game/?room_id=${encodeURIComponent(S.room.id)}&embed=1&lang=${encodeURIComponent(getLang())}${lt ? '#lt=' + encodeURIComponent(lt) : ''}`;   // [REBUY_TOKEN_0_10_18]
    if (fr.getAttribute('src') !== src) { pop.classList.remove('loaded'); fr.onload = () => pop.classList.add('loaded'); fr.setAttribute('src', src); }
    pop.hidden = false;
}
function closeRebuyPop() { $('#rebuy-pop').hidden = true; }
/** [WATCH_0_10_20] 방장 관전 — 같은 창에 로비의 방장 신청 목록(/game/?room_id=&embed=1, 방장이면 목록·승인 화면). show=false 면 숨긴 채 불러만 둔다(배지) */
function openHostPop(show = true) {
    if (!S.room) return;
    const pop = $('#rebuy-pop'), fr = $('#rebuy-pop .rp-frame');
    pop.classList.add('host');
    $('#rebuy-pop .rp-title').textContent = t('watchReqTitle');
    let lt = ''; try { lt = sessionStorage.getItem('buyin.lt') || ''; } catch (_e) { /* */ }
    const src = `${LOBBY_URL}/game/?room_id=${encodeURIComponent(S.room.id)}&embed=1&lang=${encodeURIComponent(getLang())}${lt ? '#lt=' + encodeURIComponent(lt) : ''}`;
    if (!fr.getAttribute('src')) { pop.classList.remove('loaded'); fr.onload = () => pop.classList.add('loaded'); fr.setAttribute('src', src); }
    if (show) pop.hidden = false;
}
/**
 * [HOST_ALARM_0_10_22] 방장 관전 — 대기 중인 바이인 신청이 있으면 알림음(sfx/buyin_request)을 울리고, 소리가 끝나면 3초 뒤 다시.
 * 승인·거절로 대기 0 이 되면 멈춘다. 소리 장치는 화면을 한 번 누른 뒤에 켜진다(브라우저 규칙) — 그 전에는 1초마다 다시 시도
 */
let alarmOn = false;
function hostAlarm() {
    if (alarmOn || !(S.watch && (S.hostPending || 0) > 0)) return;
    alarmOn = true;
    const again = (ms) => setTimeout(() => { alarmOn = false; hostAlarm(); }, ms);
    const ctx = audio();
    if (!S.sound || !ctx || ctx.state !== 'running') { again(1000); return; }
    loadSfx('buyin_request').then((b) => {
        if (!b || !(S.watch && (S.hostPending || 0) > 0)) { alarmOn = false; return; }
        const src = ctx.createBufferSource(), g = ctx.createGain();
        g.gain.value = 0.9 * S.vol; src.buffer = b; src.connect(g).connect(ctx.destination);
        src.onended = () => again(3000);
        src.start();
    }).catch(() => again(3000));
}
function renderWatch() {
    const bar = $('#watch-bar'), pill = $('#watch-pill');
    if (bar) {
        bar.hidden = !S.watch;
        if (S.watch) { const n = S.hostPending || 0; const b = $('.wb-n', bar); b.textContent = n > 99 ? '99+' : String(n); b.hidden = !(n > 0); bar.classList.toggle('has', n > 0); }
    }
    if (pill) {
        const w = S.watchInfo;
        const on = !S.watch && !!(w && w.n > 0);
        pill.hidden = !on;
        if (on) $('.wp-t', pill).textContent = t('watchPill') + (w.names && w.names.length ? ' · ' + w.names.join(', ') : '');
    }
}

/** [AWAY_0_10_16] 내 자리 비움 — 가운데 안내(남은 시간) + 「돌아왔어요」 */
function renderAway() {
    const bar = $('#away-bar');
    const me = S.seats && S.seats[mySeat()];
    const on = !!(me && me.sitout && !me.leaving);
    bar.hidden = !on;
    if (!on) return;
    const left = Math.max(0, (me.awayUntil || 0) - (Date.now() + (S.skew || 0)));
    const mm = Math.floor(left / 60000), ss = Math.floor((left % 60000) / 1000);
    $('.aw-sub', bar).textContent = t('awaySub').replace('{m}', `${mm}:${String(ss).padStart(2, '0')}`);
}
function askAway() {
    if (!window.confirm(t('awayAsk'))) return;
    cmd('sitout').then((r) => { if (r && !r.ok) toastErr(r.error || ''); }).catch(() => { /* */ });
}

function renderBoard() {
    const h = S.hand;
    const pot = h ? h.pot : 0;
    const done = !!S.winners;
    $('.pot-total').textContent = dm(done ? 0 : pot);
    // [SIDEPOT_0_10_9] 원본 팟 패널 — MAIN / SIDE 1 / SIDE 2(셋 이상이면 +N) / 미콜 베팅. 판 도중은 낸 금액으로 나눠 보이고, 결과 때 지급되는 칸이 빛난다
    // 결과 때는 스택이 이미 지급돼 다시 나눌 수 없다 — 결과 직전의 나눔을 그대로 보인다
    let br = null;
    if (!done) { br = potBreakdown(); if (h) S.lastBr = { handId: h.handId, br }; }
    else if (S.lastBr && h && S.lastBr.handId === h.handId) br = S.lastBr.br;
    const cells = document.querySelectorAll('.pot-grid > div');
    cells.forEach((c, i) => c.classList.toggle('won', !!(done && (S.winPots ? S.winPots.has(i) || (i === 2 && [...S.winPots].some((x) => x > 2)) : i === 0))));
    $('.main-v').textContent = dm(br && br.pots.length ? br.pots[0] : pot);
    const sideV = (i) => (br && br.pots[i] ? dm(br.pots[i]) : '—');
    cells[1].querySelector('.pv').textContent = sideV(1);
    cells[2].querySelector('.pk').textContent = br && br.pots.length > 3 ? `+${br.pots.length - 2} POTS` : 'SIDE 2';
    cells[2].querySelector('.pv').textContent = br && br.pots.length > 3 ? dm(br.pots.slice(2).reduce((a, b) => a + b, 0)) : sideV(2);
    $('.pot-uncalled .pv').textContent = br && br.unc > 0 ? dm(br.unc) : '—';
    const chips = $('.pot-chips');
    chips.innerHTML = '';   // [NO_POT_CHIPS_0_10_11] 팟 상자 위 칩 더미는 그리지 않는다(운영 요청 11-15) — 자리는 지급 연출의 출발점으로 남긴다
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
    wm.textContent = !h && !gateOpen() && (S.seats || []).filter(Boolean).length < 2 ? t('waiting') : '';   // [READY_SESSION_0_10_6] 대기실이 대신 알린다
    wm.hidden = !wm.textContent;
    let big = $('.win-hand');
    if (!big) { big = el('div', 'win-hand'); $('#board-area').appendChild(big); }
    big.textContent = (S.winners && S.winners.big) || '';
    big.hidden = !big.textContent;
}

/** [SHOW_CARDS_0_10_9] 폴드승 뒤 내 카드 보여 주기 버튼(원본 Left / Both / Right) — 내 카드 바로 위 */
/** [SHOW_PICK_FIT_0_10_16] 아이폰 아래 홈 막대 높이(safe-area) — CSS env() 는 변수로 읽으면 계산되지 않아 숨은 요소로 잰다 */
let sabProbe = null;
function safeBottom() {
    if (!sabProbe) { sabProbe = el('div'); sabProbe.style.cssText = 'position:fixed;left:0;bottom:0;width:0;height:env(safe-area-inset-bottom, 0px);visibility:hidden;pointer-events:none'; document.body.appendChild(sabProbe); }
    return sabProbe.offsetHeight || 0;
}
function renderShowPick() {
    const box = $('#show-pick');
    const on = !!(S.canShow && S.hand && S.hand.handId === S.canShow);
    box.hidden = !on;
    if (!on) return;
    // [SHOW_PICK_DESIGN_0_10_12] 고르는 칸마다 내 두 장을 작게 — 보여 줄 카드는 앞면, 숨길 카드는 뒷면(무엇이 공개되는지 한눈에)
    const mine = S.hole && S.holeHandId === S.hand.handId ? S.hole.map(codeOf) : [];
    if (box.dataset.hid !== S.hand.handId) {
        box.dataset.hid = S.hand.handId;
        // [OMAHA_0_10_23] 오마하 — 한 장만 보여 주기는 없다(엔진도 both 만 받는다). 「모두 보여 주기」 하나, 작은 카드는 4·5장
        const om = isOmaha();
        box.classList.toggle('om', om);
        box.querySelectorAll('button[data-w]').forEach((b) => {
            const w = b.dataset.w;
            b.hidden = om && w !== 'both';
            if (w === 'both') { const tx = b.querySelector('.sp-t') || (() => { const x = el('span', 'sp-t'); [...b.childNodes].filter((n) => n.nodeType === 3).forEach((n) => n.remove()); b.appendChild(x); return x; })(); tx.textContent = om ? t('showAll') : t('showBoth'); b.removeAttribute('data-i18n'); }
            let mini = b.querySelector('.sp-minis');
            if (!mini) { mini = el('span', 'sp-minis'); b.prepend(mini); }
            mini.innerHTML = '';
            (om ? mine.map((_c, i) => i) : [0, 1]).forEach((i) => {
                const show = w === 'both' || (w === 'left' && i === 0) || (w === 'right' && i === 1);
                const c = show && mine[i] ? cardEl(mine[i]) : cardEl(null);
                c.classList.add('sp-mini', show ? 'up' : 'down');
                mini.appendChild(c);
            });
        });
    }
    requestAnimationFrame(() => {
        const hc = document.querySelector('#seats .seat.hero .hole') || document.querySelector('#seats .seat.hero .avatar');
        if (!hc) return;
        const r = hc.getBoundingClientRect();
        // 카드 아래 — 결과 뒤엔 액션 버튼이 없어 비어 있다(위는 RABBIT·족보 글자).
        // [SHOW_PICK_FIT_0_10_16] 휴대폰은 내 카드가 화면 아래라 상자가 잘렸다 — 아래에 자리가 없으면 카드 위로, 좌우도 화면 안으로
        const w = box.offsetWidth, hgt = box.offsetHeight, m = 8;
        const safeB = safeBottom();
        let top = r.bottom + 8;
        if (top + hgt > innerHeight - m - safeB) top = r.top - hgt - 10;
        top = Math.max(m, Math.min(innerHeight - m - safeB - hgt, top));
        const cx = Math.max(m + w / 2, Math.min(innerWidth - m - w / 2, r.left + r.width / 2));
        box.style.left = cx + 'px'; box.style.top = top + 'px';
    });
}
async function sendShow(which) {
    const hid = S.canShow;
    S.canShow = ''; renderShowPick();
    const r = await cmd('show', { which });
    if (!r.ok) { toastErr(r.error || ''); return; }
    S.keepHand = hid;
}

/**
 * [SIDEPOT_0_10_9] 판 도중 팟 나누기(표시용) — 자리마다 낸 금액 = 판 시작 스택 − 지금 스택.
 *   미콜 = 살아 있는 사람 중 가장 많이 낸 사람이 두 번째보다 더 낸 몫, 올인한 사람의 금액마다 팟 층을 나눈다.
 *   폴드한 사람이 낸 돈은 그 층까지 팟에 들어간다. 실제 지급은 엔진 결과(PotManager)가 정한다
 */
function potBreakdown() {
    const h = S.hand;
    if (!h || !h.start) return null;
    const r3 = (x) => Math.round(x * 1000) / 1000;
    const rows = h.seats.map((p) => ({ c: Math.max(0, r3((h.start[p.seat] || 0) - (Number(p.stack) || 0))), folded: !!p.folded, allIn: !!p.allIn || !(p.stack > 0) }));
    const live = rows.filter((x) => !x.folded).sort((a, b) => b.c - a.c);
    if (!live.length) return null;
    const unc = live.length >= 2 ? r3(live[0].c - live[1].c) : 0;
    const top = r3(live[0].c - unc);
    const levels = [...new Set(live.filter((x) => x.allIn && x.c < top).map((x) => x.c))].sort((a, b) => a - b);
    levels.push(top);
    const pots = [];
    let prev = 0;
    for (const L of levels) {
        let amt = 0;
        for (const x of rows) amt += Math.max(0, Math.min(x.c, L) - Math.min(x.c, prev));
        if (amt > 0) pots.push(r3(amt));
        prev = L;
    }
    const dead = rows.filter((x) => x.folded && x.c > top).reduce((a, x) => a + x.c - top, 0);
    if (pots.length && dead > 0) pots[pots.length - 1] = r3(pots[pots.length - 1] + dead);
    return { pots, unc };
}

/** 칩 더미 — 운영 ChipStack 규칙: 센트 정수로 큰 칩부터 나누고, PC 는 자릿수 밴드별 세로 더미를 가로로, 모바일은 한 줄 */
const CHIP_VALUES = [1000, 500, 100, 50, 10, 5, 1, 0.1];
const CHIP_FILE = { 1000: 'chip_1000', 500: 'chip_500', 100: 'chip_100', 50: 'chip_50', 10: 'chip_10', 5: 'chip_5', 1: 'chip_1', 0.1: 'chip_0_1' };
const cents = (n) => Math.round((Number(n) || 0) * 100);
const band = (v) => (v >= 1000 ? 3 : v >= 100 ? 2 : v >= 10 ? 1 : v >= 1 ? 0 : -1);
/** [CHIP_VISUAL_0_10_7] 칩 그림 환산 — 원화 방은 칩이 원이라 50만원이 1000짜리 칩 500개로 쌓였다. 좌석표 display.chipRate(1 USDT = 원)로 나눠
 *  테더 기준 칩으로 그린다. 그림뿐 — 금액 글자·게임 금액은 그대로 */
const chipRate = () => { const r = Number(S.me && S.me.display && S.me.display.chipRate); return r > 1 ? r : 1; };
function chipStackEl(amount, { single = false, cap = 0, dropKey = '' } = {}) {
    amount = (Number(amount) || 0) / chipRate();
    let left = Math.max(0, cents(amount));
    const all = [];
    for (const v of CHIP_VALUES) { const n = Math.floor(left / cents(v)); for (let i = 0; i < n; i++) all.push(v); left -= n * cents(v); }
    if (!all.length && cents(amount) > 0) all.push(0.1);
    let stacks = single ? [all] : [3, 2, 1, 0, -1].map((b) => all.filter((v) => band(v) === b)).filter((x) => x.length);
    if (cap) stacks = stacks.flatMap((st) => { const out = []; for (let i = 0; i < st.length; i += cap) out.push(st.slice(i, i + cap)); return out; });
    const box = el('div', 'chips');
    let n = 0;
    stacks.forEach((st, si) => {
        const col = el('div', 'chip-col');
        st.slice(0, 24).forEach((v, i) => {
            const c = el('div', 'chip');
            // [CHIP_DROP_0_10_9] 원본 ChipStack — 칩마다 위 34px·1.12배에서 떨어져 튕기며 쌓인다(묶음×0.06 + 칩×0.045초). 새로 생긴 칩만(키로 한 번)
            if (dropKey && S.live) {
                const key = `${dropKey}:${n++}`, fresh = !(key in S.anim);
                const d = animDelay(key, fresh ? si * 0.06 + i * 0.045 : 0);
                if (Date.now() - S.anim[key] < 700) { c.classList.add('drop'); c.style.animationDelay = d; }
            }
            const rot = ((i * 13 + si * 7) % 360) % 10 - 5, xo = (i % 3) - 1.5;
            c.style.zIndex = i; c.style.transform = `translateY(${-i * 4}px)`;
            const im = el('img'); im.src = `${ASSET}img/${CHIP_FILE[v]}.webp${AV}`; im.alt = ''; im.style.transform = `rotate(${rot}deg) translateX(${xo}px)`;
            c.appendChild(im); col.appendChild(c);
        });
        box.appendChild(col);
    });
    return box;
}

/**
 * [SIDE_OUT_0_10_17] 모바일 — 양옆 자리가 가장자리로 붙어, 자리보다 넓은 말풍선(올인 금액 등)·결과 글자가 화면 밖으로 나가지 않게 안쪽으로 민다
 */
function keepInside() {
    if (S.layout !== 'mobile') return;
    const m = 4, W = innerWidth;
    for (const b of document.querySelectorAll('#seats .bubble, #seats .rebuy-bubble, #seats .seat-note, #seats .raising, #seats .handrank')) {
        const r = b.getBoundingClientRect();
        if (!r.width || !b.offsetWidth) continue;
        const k = r.width / b.offsetWidth;
        const dx = r.left < m ? m - r.left : r.right > W - m ? W - m - r.right : 0;
        if (dx) b.style.left = ((parseFloat(b.style.left) || 0) + dx / k) + 'px';
    }
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
    for (const [seat, v] of S.fire) if (!isAllIn(seat)) { releaseVideo(v); S.fire.delete(seat); }   // [VIDEO_RELEASE_0_10_9] 올인이 끝난 자리의 불꽃은 디코더까지 돌려준다(종전: 멈추기만)
}

/** 기본 아바타 — 닉네임으로 여러 장 중 하나를 고른다(같은 회원은 어디서나 같은 얼굴). 그림은 리소스 서버에 있다 */
/* [AVATAR_ORIG_0_10_9] 원본 게임 캐릭터 8장(avatar_player_1~8.webp, 서로 다른 그림). 종전 avatar_1~6.png 는 모두 같은 그림이라 전원이 같은 얼굴이었다 */
const AVATAR_COUNT = 8;
function avatarFile(s) {
    const key = String((s && s.nickname) || '');
    let h = 0;
    for (let k = 0; k < key.length; k++) h = (h * 31 + key.charCodeAt(k)) >>> 0;
    return `avatar_player_${1 + (h % AVATAR_COUNT)}.webp`;
}

/**
 * [TEE_AVATAR_0_10_11] 좌석표 player.avatar — 게임서버가 자원 폴더 안 경로만 보낸다(profile-photos/… · characters/… · assets/avatars/…).
 * 리소스 서버 뿌리(ASSET 의 buyin-table/ 위)에 붙인다 — CSP 가 허용한 그 서버에서만. 정해진 폴더·모양이 아니면 쓰지 않는다
 */
const RES_ROOT = ASSET.replace(/buyin-table\/$/, '');
const AVATAR_RE = /^(profile-photos|characters|assets\/avatars)\/[A-Za-z0-9_.-]+\.(webp|png|jpe?g)$/i;
function ownAvatar(s) {
    const p = String((s && s.avatar) || '');
    return AVATAR_RE.test(p) && !p.includes('..') ? RES_ROOT + p : '';
}
function avatarEl(s, size, seat, ring = true) {
    const av = el('div', 'avatar');
    av.style.width = av.style.height = size + 'px';
    const im = el('img'); im.alt = '';
    // [ASSET_FALLBACK_0_10_10] 새 캐릭터 그림이 리소스 서버에 아직 없으면(운영 업로드 전) 예전 아바타로 — 깨진 그림을 보이지 않는다
    const base = ASSET + 'img/' + avatarFile(s) + AV;
    const own = ownAvatar(s);
    // [TEE_AVATAR_0_10_11] 로비에서 고른 프로필(본인 사진·캐릭터·프리셋) → 없거나 안 열리면 닉네임 캐릭터 → 예전 아바타
    im.onerror = () => { if (im.src !== base && own) { im.src = base; return; } im.onerror = null; im.src = ASSET + 'img/avatar.png' + AV; };
    im.src = own || base; av.appendChild(im);
    if (ring && S.turn && S.turn.seat === seat) {
        av.appendChild(turnRing(size));   // 모바일 영웅은 링 대신 차례 막대
        if (seat !== mySeat() || S.layout === 'mobile') av.appendChild(el('b', 'ring-sec' + (size < 100 ? ' sm' : '')));   // [HERO_RING_M_0_10_11] 모바일 영웅도   // [TURN_RING_0_10_9] 다른 자리 — 가운데 남은 초(원본)
    }
    if (isAllIn(seat)) av.appendChild(fireCore(seat));
    // 팁 받을 사람 고르기 — 선물을 고른 뒤 상대 아바타가 깜빡이고, 누르면 보낸다
    if (S.tipGift && seat !== mySeat()) {
        av.classList.add('tip-target');
        av.onclick = (e) => { e.stopPropagation(); const g = S.tipGift; endTipPick(); sendTip(seat, g); };
    } else if (S.seats && S.seats[seat]) {
        // [PROFILE_STATS_0_10_11] 프로필을 누르면 그 사람 손익·바이인 개수·금액
        av.classList.add('pf-tap');
        av.onclick = (e) => { e.stopPropagation(); openProfile(seat, av); };
    }
    return av;
}

const isAllIn = (seat) => { const p = S.hand && S.hand.seats.find((x) => x.seat === seat); return !!(p && p.allIn && !p.folded); };

/**
 * [VIDEO_RELEASE_0_10_9] 다 쓴 영상은 디코더를 바로 돌려준다(원본 ReleasingVideo) — 지우기만 하면 모바일에서 오래 할수록
 * 영상이 검게 나오거나 멈췄다. 멈추고, 주소를 떼고, load() 로 비운다
 */
function releaseVideo(v) {
    if (!v) return;
    try { v.pause(); v.removeAttribute('src'); v.load(); } catch (_e) { /* */ }
}
/** [VIDEO_RELEASE_0_10_9] 올인 불꽃·감정 영상을 미리 받아 둔다 — 첫 올인·첫 감정도 바로 재생(원본 preloadCriticalFx). 받기만 하고 틀지 않는다 */
const fxWarm = [];
function preloadFxVideos() {
    if (fxWarm.length) return;
    const v = document.createElement('video');
    v.muted = true; v.preload = 'auto'; v.playsInline = true; v.src = `${ASSET}fx/fire.webm${AV}`;
    fxWarm.push(v);
    setTimeout(() => releaseVideo(v), 20000);   // 불꽃은 브라우저 캐시면 충분
    for (const id of EMOTES) warmEmote(id);
}
/**
 * [EMOTE_FAST_0_10_10] 감정 영상은 받아 둔 영상 요소를 그대로 재생에 쓴다(종전: 20초 뒤 놓아 버려 캐시가 비면 그때 다시 받았다 — 모바일 지연).
 * 쓰고 나면 다음 번을 위해 다시 받아 둔다. 8개 × 약 0.3MB
 */
const emoWarm = new Map();
function warmEmote(id) {
    const v = document.createElement('video');
    v.muted = true; v.preload = 'auto'; v.playsInline = true; v.setAttribute('playsinline', '');
    v.src = `${ASSET}emo/emo_${id}.mp4${AV}`;
    emoWarm.set(id, v);
    return v;
}
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

/** [ITD_ORIG_0_10_9] 원본 DarkCrest — 초승달 + 감은 눈 */
const DARK_CREST = '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M15.5 3.2A8.6 8.6 0 1 0 20.8 15 7 7 0 0 1 15.5 3.2Z" fill="currentColor" opacity=".9"/>'
    + '<path d="M7.2 13.4c1.4 1.3 3.6 1.3 5 0" stroke="#1b0b33" stroke-width="1.6" stroke-linecap="round"/><path d="M8 15.1l-.6 1M12 15.1l.6 1M10 15.6v1.1" stroke="#1b0b33" stroke-width="1.2" stroke-linecap="round"/>'
    + '<circle cx="19.2" cy="5" r="1" fill="currentColor"/><circle cx="21.4" cy="8.6" r=".6" fill="currentColor"/></svg>';
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
        // [FX_SMALL_0_10_9] 원본 AllInEmberFX — 아바타 테두리(반지름)에서 고르게 나눈 각도 + 흔들림, 이동 거리 34~62px 고정(종전: 얼굴 안 0.28·무작위 각·크기 비례)
        for (let i = 0; i < 16; i++) {
            const a = (i / 16) * Math.PI * 2 + (rnd() - 0.5) * 0.35, d0 = size * 0.5, d1 = d0 + 34 + rnd() * 28, sz = 3 + rnd() * 4;
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
        const vl = el('div', 'itd-veil'); w.appendChild(vl);   // [ITD_ORIG_0_10_9] 원본 InTheDarkVeil — 보라 비네트 + 3.4초 금빛 사선 광택
        // [ITD_ORIG_0_10_9] 원본 InTheDarkAura — 숨 쉬는 보라 빛, 반대로 도는 금·보라 링 2개, 궤도 별 6개 + 역궤도 별 3개, 위쪽 문장 리본
        const au = el('div', 'itd-aura');
        // 다시 그려도 회전·반짝임이 처음부터 다시 돌지 않게 — 처음 켜진 시각 기준 음수 지연(el)
        const el0 = parseFloat(animDelay('aura:' + seat)) || 0;
        w.style.setProperty('--el', el0 + 's');   // 베일·오라 모두 이 값을 물려받는다
        const star = (deg, cls, base) => `<span class="itd-star${cls}" style="left:${(50 + 50 * Math.sin(deg * Math.PI / 180)).toFixed(2)}%;top:${(50 - 50 * Math.cos(deg * Math.PI / 180)).toFixed(2)}%;animation-delay:${(base + el0).toFixed(3)}s"></span>`;
        au.innerHTML = '<div class="itd-aura__bloom"></div><div class="itd-aura__ring"></div><div class="itd-aura__ring itd-aura__ring--thin"></div>'
            + '<div class="itd-aura__orbit">' + [0, 60, 120, 180, 240, 300].map((deg, i) => star(deg, i % 2 ? ' itd-star--violet' : '', i * 0.27)).join('') + '</div>'
            + '<div class="itd-aura__orbit itd-aura__orbit--rev">' + [30, 150, 270].map((deg, i) => star(deg, ' itd-star--violet itd-star--sm', 0.4 + i * 0.5)).join('') + '</div>'
            + `<div class="itd-ribbon" style="font-size:${small ? 7 : 9}px">${DARK_CREST}<span class="itd-ribbon__text">${esc(t('darkActive'))}</span></div>`;
        w.appendChild(au);
    }
    parent.appendChild(w);
}

/**
 * [TURN_RING_0_10_9] 차례 링 — 원본 PillBorderTimer: 바탕 링(흰 14%) 위에 금색 그라데이션, 남은 시간 44% 아래 주황·22% 아래 빨강 + 깜빡임·빛 번짐,
 * 둥근 끝. 값은 매 프레임(ringFrame)으로 부드럽게 줄인다(종전: 250ms 마다 뚝뚝, 단색).
 */
let ringSeq = 0;
const RING_STOPS = { gold: ['#FFE9A8', '#C8942A'], warn: ['#FFC069', '#E0821F'], urgent: ['#FF7A66', '#C11324'] };
function turnRing(size) {
    const ns = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('class', 'ring'); svg.setAttribute('viewBox', '0 0 100 100');
    const id = 'rg' + (++ringSeq);
    svg.innerHTML = `<defs><linearGradient id="${id}" x1="0%" y1="0%" x2="100%" y2="100%"><stop offset="0%"/><stop offset="100%"/></linearGradient></defs>`
        + `<circle class="ring-bg" cx="50" cy="50" r="47" fill="none" pathLength="100"/>`
        + `<circle class="ring-arc" cx="50" cy="50" r="47" fill="none" pathLength="100" stroke="url(#${id})" stroke-linecap="round"/>`;
    paintRing(svg, ringFrac());
    void size;
    return svg;
}
const ringFrac = () => (S.turn && S.room ? Math.min(1, Math.max(0, (S.turn.deadline - Date.now()) / (S.room.turnSec * 1000))) : 0);   // 타임뱅크로 늘면 가득 찬 채로
function paintRing(svg, frac) {
    const st = frac < 0.22 ? 'urgent' : frac < 0.44 ? 'warn' : 'gold';
    const arc = svg.querySelector('.ring-arc'), stops = svg.querySelectorAll('stop');
    arc.setAttribute('stroke-dasharray', `${(frac * 100).toFixed(2)} 100`);
    if (svg.dataset.st !== st) { svg.dataset.st = st; stops[0].setAttribute('stop-color', RING_STOPS[st][0]); stops[1].setAttribute('stop-color', RING_STOPS[st][1]); }
}
function ringFrame() {
    if (S.turn) {
        const f = ringFrac();
        document.querySelectorAll('svg.ring').forEach((r) => paintRing(r, f));
        const sec = String(Math.max(0, Math.ceil((S.turn.deadline - Date.now()) / 1000)));
        document.querySelectorAll('.ring-sec').forEach((b) => { if (b.textContent !== sec) b.textContent = sec; });
    }
    requestAnimationFrame(ringFrame);
}
requestAnimationFrame(ringFrame);

function nameboxEl(s, w, hgt, nmPx, stPx) {
    const nb = el('div', 'namebox');
    nb.style.width = w + 'px'; nb.style.height = hgt + 'px';
    nb.innerHTML = `<i class="flag"></i><i class="fade"></i><div class="info"><span class="nm" style="font-size:${nmPx}px;line-height:${Math.round(nmPx * 1.33)}px">${esc(s.nickname)}</span>`
        + `<span class="st" style="font-size:${stPx}px;line-height:${Math.round(stPx * 1.4)}px">${dm(s.stack)}</span></div>`;
    // [REBUY_2026_11_11] 칩 0 = 「올인」 딱지
    // [BUYIN_UNITS_0_10_4] 그 밖에는 이 자리 총 바이인 개수(「총 3바이인」) — 재바이인 직후 한 번 초록으로 반짝
    const fresh = rbDoneFresh(s);
    // [NO_BI_TAG_0_10_7] 「총 N바이인」 딱지는 뺐다(운영 요청) — 칩 0 의 「올인」 딱지만
    const tag = s.busted && s.rebuy !== 'done' ? ['out', t('rbAllin')] : null;
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
        // [OM_BACKS_0_10_23] 오른쪽 자리는 프로필 가운데(ox+81)를 기준으로 좌우를 뒤집어 왼쪽 위에(right 로 붙인다 — 자리 상자 폭이 0)
        const flip = rightSide(a), C = ox + 81;
        // flip: 앞면(공개)은 오른쪽 끝을 거울 자리에(translateX(-100%) — 글자가 뒤집히면 안 된다), 뒷면은 묶음을 통째로 거울(scaleX(-1)) — 왼쪽 자리와 똑같은 모양
        const place = (left, back) => { if (flip) { m.classList.add(back ? 'flipb' : 'flip'); m.style.left = (2 * C - left) + 'px'; } else m.style.left = left + 'px'; };
        if (shown) { m.className = 'mini shown' + (flip ? ' flip' : ''); sdCards(m, seat, shown); place(ox + 107); m.style.top = (oy + 48) + 'px'; }
        else if (!inHand.folded) { const n = holeN(); if (n > 2) m.classList.add('om', 'om' + n); for (let k = 0; k < n; k++) { const w = el('div', 'mc'); w.appendChild(cardEl(null)); dealIn(w, seat, k); m.appendChild(w); } place(ox + 98, true); m.style.top = (oy + 76) + 'px'; }
        if (m.children.length) node.appendChild(m);
    }
    bubbleFor(node, seat, ox + 81, oy - 34);   // [BUBBLE_CENTER_0_10_11] 프로필(아바타 ox+20, 폭 122) 가운데 — 종전 ox+66 은 15px 왼쪽
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
        showLift(hole, seat);
        if (cards.length <= 2) hole.querySelectorAll('.hc')[1] && (hole.querySelectorAll('.hc')[1].style.marginLeft = (54 - 86) + 'px');
        else {
            hole.style.left = ((28 + 120 - (OM_PC_W[cards.length] - 140) / 2) / sc) + 'px';   // [OMAHA_0_10_23] 4·5장 — 2장일 때와 같은 가운데
            if (!inHand.folded && !inDark() && S.holeHandId === S.hand.handId) sortButton(wrap, (28 + 120 + 70 + OM_PC_W[cards.length] / 2 + 8) / sc, (-157 + 80 + 4) / sc, false);   // [OM_SORT_0_10_23] 카드 오른쪽 위
        }
        wrap.appendChild(hole);
        const rank = !S.winners && !inHand.folded && !inDark() && heroFaceUp() ? (handNameFor(cards, shownBoard(), isOmaha()) || null) : null;   // [OMAHA_0_10_23]
        madeHandSfx(rank);   // [SHOWDOWN_SEQ_0_10_4] 아직 안 깔린 런아웃 카드는 빼고
        const mgd = madeGlow(hole, rank, cards);
        if (rank) { const hr = el('div', 'handrank' + rankTier(rank) + (mgd ? ' made-hand-rank' : ''), esc(rank)); hr.style.animationDelay = animDelay(`hr:${S.hand.handId}:${rank}`); if (mgd) hr.style.setProperty('--mg-d', mgd); hr.style.left = ((28 + 120 + 70) / sc) + 'px'; hr.style.top = ((-157 + 80 + 142) / sc) + 'px'; hr.style.transform = `translateX(-50%) scale(${1 / sc})`; hr.style.transformOrigin = '50% 0'; wrap.appendChild(hr); }
    }
    if (S.turn && S.turn.seat === seat) {
        const tm = el('div', 'timer');
        const left = Math.max(0, Math.ceil((S.turn.deadline - Date.now()) / 1000));
        tm.innerHTML = `<span><svg viewBox="0 0 24 24"><circle cx="12" cy="13" r="8"/><path d="M12 9v4l2 2M9 2h6"/></svg><b class="tsec">${left}</b></span>`;
        tm.style.left = ((-211 + 120) / sc - 25) + 'px'; tm.style.top = ((-95 + 80) / sc - 25) + 'px';
        wrap.appendChild(tm);
        timeBankButton(wrap, (-211 + 120) / sc - 25 - 60, (-95 + 80) / sc - 26);   // [TB_CHIP_0_10_12] 타이머 왼쪽 — 아래 이모티콘 버튼을 가리지 않게
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
    if (a.scale && a.scale !== 1) { node.style.transform = `scale(${a.scale})`; node.style.transformOrigin = '0 0'; }   // [MOBILE_11_0_10_7] 11석은 자리 묶음을 통째로 줄인다
    const av = avatarEl(s, 69, seat); av.style.left = '-34.5px'; av.style.top = '-34.5px'; node.appendChild(av);
    seatFx(node, seat, av, 69, true);
    const nb = nameboxEl(s, 74, 25, 8, 9); nb.style.left = '-37px'; nb.style.top = '25px'; node.appendChild(nb);
    const tag = blindTag(seat);
    if (tag) { const b = el('span', 'blind sm', tag); b.style.left = '-33px'; b.style.top = '27px'; node.appendChild(b); }
    if (S.hand && S.hand.dealer === seat) { const d = dealerEl(); d.classList.add('sm'); d.style.left = '-44px'; d.style.top = '17px'; node.appendChild(d); }
    if (inHand) {
        const shown = sdShown(seat) ? S.reveal[seat] : null;   // [SHOWDOWN_SEQ_0_10_4]
        const m = el('div', 'mini m');
        // [OM_BACKS_0_10_23] 오른쪽 열 자리는 아바타 왼쪽 위에(좌우 뒤집기, 아바타 가운데 = 0)
        const flip = rightSide(a);
        const place = (left, back) => { if (flip) { m.classList.add(back ? 'flipb' : 'flip'); m.style.left = (-left) + 'px'; } else m.style.left = left + 'px'; };
        if (shown) { m.classList.add('shown'); sdCards(m, seat, shown); place(10); m.style.top = '-12px'; }
        else if (!inHand.folded) { const n = holeN(); if (n > 2) m.classList.add('om', 'om' + n); for (let k = 0; k < n; k++) { const w = el('div', 'mc'); w.appendChild(cardEl(null)); dealIn(w, seat, k); m.appendChild(w); } place(17, true); m.style.top = '7px'; }
        if (m.children.length) node.appendChild(m);
    }
    bubbleFor(node, seat, 0, -54, 'sm');   // [BUBBLE_CENTER_0_10_11] 아바타 가운데(0)
    resultFor(node, seat, 0, 54, 0, 0, 'sm');
}

function heroSeatMobile(node, s, a, inHand) {
    const seat = s.seat;
    node.style.left = '0px'; node.style.top = '0px';   // 영웅 묶음은 화폭 왼쪽 아래 고정
    // [HERO_M_BIG_0_10_11] 프로필·이름 상자·아래 버튼 줄을 20% 키웠다(운영 요청 11-16). 아래 끝(버튼 줄 819)은 그대로, 버튼 줄은 이름 상자 폭에 맞춘다.
    //   차례 표시는 다른 자리처럼 프로필 둘레 원형 링 + 가운데 남은 초(종전: 카드 위 타이머 칩 + 가로 막대)
    const cx = 60, cy = 717, AV_M = 89;
    const av = avatarEl(s, AV_M, seat, true); av.style.left = (cx - AV_M / 2) + 'px'; av.style.top = (cy - AV_M / 2) + 'px'; node.appendChild(av);
    seatFx(node, seat, av, AV_M, true);
    const nb = nameboxEl(s, 92, 38, 13, 14); nb.style.left = '14px'; nb.style.top = '750px'; node.appendChild(nb);
    heroButtons(node, 14, 793, true);   // 프로필 아래 줄 — 감정·팁·다크(예전 화면)
    const tag = blindTag(seat);
    if (tag) { const b = el('span', 'blind sm', tag); b.style.left = '18px'; b.style.top = '753px'; node.appendChild(b); }
    if (S.hand && S.hand.dealer === seat) { const d = dealerEl(); d.classList.add('sm'); d.style.left = '4px'; d.style.top = '738px'; node.appendChild(d); }
    const cards = S.hole && S.hand && S.holeHandId === S.hand.handId ? S.hole.map(codeOf) : (S.reveal[seat] || []).map(codeOf);
    if (inHand && cards.length) {
        const hole = el('div', 'hole m' + (inHand.folded ? ' folded' : ''));
        hole.style.left = (cards.length > 2 ? 206.5 - OM_M_W[cards.length] / 2 : 155) + 'px'; hole.style.top = '684px';   // [OMAHA_0_10_23] 4·5장도 같은 가운데
        if (cards.length > 2 && !inHand.folded && !inDark() && S.holeHandId === S.hand.handId) sortButton(node, 206.5 + OM_M_W[cards.length] / 2 + 3, 690, true);   // [OM_SORT_0_10_23] 카드 오른쪽
        holeCards(hole, cards, inHand);
        showLift(hole, seat);
        node.appendChild(hole);
        const rank = !S.winners && !inHand.folded && !inDark() && heroFaceUp() ? (handNameFor(cards, shownBoard(), isOmaha()) || null) : null;   // [OMAHA_0_10_23]
        madeHandSfx(rank);
        const mgd = madeGlow(hole, rank, cards);
        if (rank) { const hr = el('div', 'handrank m' + rankTier(rank) + (mgd ? ' made-hand-rank' : ''), esc(rank)); hr.style.animationDelay = animDelay(`hr:${S.hand.handId}:${rank}`); if (mgd) hr.style.setProperty('--mg-d', mgd); hr.style.left = '208px'; hr.style.top = '642px'; node.appendChild(hr); }
    }
    // [HERO_TB_M_0_10_11] 타임 연장 칩 — 프로필 오른쪽 위, 칩을 눌러 쓴다
    if (S.turn && S.turn.seat === seat) timeBankButton(node, cx + 26, cy - 50, 'mc');
    if (!(S.winners && S.winners.big)) bubbleFor(node, seat, cx, cy - 72, 'sm');
    resultFor(node, seat, cx, 794, cx, cy - 8, 'sm');
}

function dealerEl() {
    const d = el('div', 'dealer'); const im = el('img'); im.src = ASSET + 'img/dealer.png' + AV; im.alt = 'D'; d.appendChild(im);
    return d;
}

/**
 * [RANK_AFTER_FLIP_0_10_11] 족보 알약은 내 두 장이 앞면으로 뒤집힌 뒤에 — 종전엔 카드가 날아오기도 전에(뒷면일 때) 먼저 떴다.
 * 'deal' 뒤집기(0.71초)의 앞면은 67% 지점, 둘째 카드는 0.12초 늦다 → 시작 + 0.6초. 그 전이면 그때 다시 그린다
 */
function heroFaceUp() {
    const t0 = S.hand && S.anim[`h:${S.hand.handId}`];
    if (!t0) return true;
    const at = t0 + 600;
    if (Date.now() >= at) return true;
    renderAt(at);
    return false;
}
/** 내 카드 — 받을 때 뒷면→앞면 뒤집기, 인 더 다크 판에는 뒷면 + DARK 봉인(판이 끝나면 공개) */
const inDark = () => !!(S.hand && S.darkHand === S.hand.handId && !S.winners);
/** [OM_SORT_0_10_23] 정렬 순서(받은 카드 번호 배열). rank = 높은 숫자부터(같으면 무늬 묶음) · suit = 같은 무늬끼리(장수 많은 무늬 → 높은 카드 순), 무늬 안은 높은 숫자부터 */
const RANK_V = { A: 14, K: 13, Q: 12, J: 11, T: 10 };
const rankV = (c) => RANK_V[c[0]] || Number(c[0]) || 0;
function omOrder(cards) {
    const idx = cards.map((_c, i) => i);
    if (S.omSort === 'off') return idx;
    const SU = 'shdc';
    if (S.omSort === 'rank') return idx.sort((a, b) => rankV(cards[b]) - rankV(cards[a]) || SU.indexOf(cards[a][1]) - SU.indexOf(cards[b][1]));
    const cnt = {}, top = {};
    cards.forEach((c) => { cnt[c[1]] = (cnt[c[1]] || 0) + 1; top[c[1]] = Math.max(top[c[1]] || 0, rankV(c)); });
    return idx.sort((a, b) => {
        const sa = cards[a][1], sb = cards[b][1];
        if (sa !== sb) return (cnt[sb] - cnt[sa]) || (top[sb] - top[sa]) || SU.indexOf(sa) - SU.indexOf(sb);
        return rankV(cards[b]) - rankV(cards[a]);
    });
}
const SVG_SORT = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 4v16M3.5 16.5 7 20l3.5-3.5M17 20V4M13.5 7.5 17 4l3.5 3.5"/></svg>';
/** [OM_SORT_0_10_23] 정렬 버튼 — 한 번 누를 때마다 숫자순 → 무늬순 → 받은 순서. 지금 방식을 글자로 보인다 */
function sortButton(parent, x, y, mobile) {
    const b = el('button', 'om-sort' + (mobile ? ' m' : ''), `${SVG_SORT}<span>${esc(t(S.omSort === 'rank' ? 'sortRank' : S.omSort === 'suit' ? 'sortSuit' : 'sortOff'))}</span>`);
    b.type = 'button'; b.dataset.testid = 'om-sort'; b.title = t('sortHint');
    b.style.left = x + 'px'; b.style.top = y + 'px';
    b.onclick = (e) => {
        e.stopPropagation();
        S.omSort = S.omSort === 'rank' ? 'suit' : S.omSort === 'suit' ? 'off' : 'rank';
        try { localStorage.setItem('buyin.omSort', S.omSort); } catch (_e) { /* */ }
        S.omSortAt = Date.now();
        play('board', 0.6);   // [OM_SORT_WAVE_0_10_23] 카드 뒤집히는 소리(보드 오픈과 같은 소리) — 종전 나눠 주는 소리
        renderNow();
    };
    parent.appendChild(b);
}
/** [OMAHA_0_10_23] 내 카드 4·5장 묶음 폭 — table.css .hole.om4/.om5 와 같은 값(PC 86px 카드 40·34 간격, 모바일 46px 카드 30·24 간격) */
const OM_PC_W = { 4: 86 + 3 * 40, 5: 86 + 4 * 34 };
const OM_M_W = { 4: 46 + 3 * 30, 5: 46 + 4 * 24 };
function holeCards(hole, cards, inHand) {
    const key = `h:${S.hand.handId}`;
    if (cards.length > 2) hole.classList.add('om', 'om' + cards.length);   // [OMAHA_0_10_23] 내 카드 4·5장 — 겹쳐 펼친다
    // [OM_SORT_0_10_23] 오마하 정렬 — 그리는 순서만 바꾼다(번호 idx·연출 키·보여 주기·빛은 받은 순서 번호 그대로, data-i)
    const order = cards.length > 2 && !inDark() ? omOrder(cards) : cards.map((_c, i) => i);
    // [OM_SORT_WAVE_0_10_23] 정렬 웨이브 — 한 번만. 다시 그려도 처음부터 다시 돌지 않게 누른 시각부터 지난 만큼 음수 지연(종전엔 400ms 안에 한 번 더 그려지면 두 번 움직였다)
    const sortAge = S.omSortAt ? Date.now() - S.omSortAt : 1e9;
    let pos = 0;
    order.forEach((idx) => {
        const c = cards[idx];
        const w = el('div', 'hc');
        w.dataset.i = String(idx);
        if (sortAge < 800) { w.classList.add('om-wave'); w.style.animationDelay = `${((pos * 70) - sortAge) / 1000}s`; }
        pos += 1;
        // [HERO_DEAL_FLIP_0_10_10] 딜 비행이 도착하기 전에는 숨긴다(visibility — 3D 뒤집기를 깨지 않는다)
        const dk = `dlh:${S.hand.handId}:${idx}`;
        if (dk in S.anim && Date.now() - S.anim[dk] < 400) { w.classList.add('dlh'); w.style.animationDelay = animDelay(dk); }
        if (inDark()) {
            w.appendChild(cardEl(null));
            // [ITD_ORIG_0_10_9] 원본 InTheDarkSeal — 보라 베일 + 문장 밀랍 봉인
            const sl = el('div', 'itd-seal', `<div class="itd-seal__veil"></div><div class="itd-seal__wax">${DARK_CREST}<span>${esc(t('darkSeal'))}</span></div>`); w.appendChild(sl);
            // [DARK_PEEK_0_10_11] 플랍부터는 눌러서 내 카드를 본다(보는 순간 내 다크 연출이 모두에게서 꺼진다)
            if (S.hand.stage !== 'preflop' && !inHand.folded) {
                w.classList.add('peekable'); w.dataset.testid = 'dark-peek-' + idx; w.onclick = peekDark;
                if (idx === cards.length - 1) w.appendChild(el('div', 'peek-hint', esc(t('darkPeek'))));
            }
        } else {
            const opts = inHand.folded ? { dim: true } : winLook(c);
            const kk = key + ':' + idx;   // 카드마다 0.12초 차이로 뒤집는다(시각은 카드별 키로 기억)
            if (S.anim[key] && !(kk in S.anim)) S.anim[kk] = S.anim[key] + idx * 120;
            w.appendChild(S.anim[key] ? flipEl(c, opts, kk, 'deal', 0, 0.71) : cardEl(c, opts));
        }
        hole.appendChild(w);
    });
}

/** 영웅 자리 옆 버튼 — 감정(판당 한 번)·팁(프리플랍)·(모바일) 인 더 다크 */
const SVG_SMILE = '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M8 14s1.5 2 4 2 4-2 4-2M9 9h.01M15 9h.01"/></svg>';
/** [CHAT_M_0_10_7] 모바일 채팅 버튼 — 이모지(💬)는 기기 글꼴마다 모양이 다르거나 네모로 깨졌다. 다른 버튼과 같은 선 아이콘으로 */
const SVG_CHAT = '<svg viewBox="0 0 24 24"><path d="M21 12a8 8 0 0 1-11.6 7.1L4 20.5l1.4-4.6A8 8 0 1 1 21 12z"/><path d="M8.5 12h.01M12 12h.01M15.5 12h.01"/></svg>';
/** [AWAY_0_10_16] 자리 비움 — 커피 잔 */
const SVG_AWAY = '<svg viewBox="0 0 24 24"><path d="M4 9h13v5a5 5 0 0 1-5 5H9a5 5 0 0 1-5-5z"/><path d="M17 10h1.5a2.5 2.5 0 0 1 0 5H17M8 2.5c-.6.8-.6 1.7 0 2.5M12 2.5c-.6.8-.6 1.7 0 2.5"/></svg>';
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
    // [AWAY_PF_0_10_18] 자리 비움 버튼은 내 프로필(아바타를 누르면 나오는 창)로 옮겼다
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
    // [AWAY_0_10_16] 자리 비움 — 그 자리 위에 「자리 비움 중」(모두의 화면)
    if (st && st.sitout && !st.leaving) {
        const n = el('div', 'rebuy-bubble away' + (size ? ' ' + size : ''), esc(t('awayBubble')));
        n.dataset.testid = 'away-bubble-' + seat;
        n.style.left = cx + 'px'; n.style.top = top + 'px';
        parent.appendChild(n);
        return;
    }
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
    // [FX_SMALL_0_10_9] 원본 액션 말풍선 — 0.3초 페이드 + 10px 아래에서 올라오기(액션마다 한 번, 다시 그려도 이어서)
    if (S.hand) { node.classList.add('pop'); node.style.animationDelay = animDelay(`bub:${S.hand.handId}:${seat}:${b.at}`); }
    parent.appendChild(node);
}

/** 결과 — 이름 상자 아래 "Pair, 8's +805", 이긴 사람 아바타 위 WINNER */
function resultFor(parent, seat, cx, top, ax, ay, size = '') {
    // [SHOWDOWN_SEQ_0_10_4] 보통 쇼다운은 카드를 연 자리부터 족보 글자 — 승자·금액은 다 연 뒤에
    if (!S.winners) {
        const rk = S.sd && S.sd.ranks && S.hand && S.sd.handId === S.hand.handId && seat !== mySeat() && sdShown(seat) ? S.sd.ranks[seat] : '';
        if (rk) { const n = el('div', 'seat-note sd-rank' + (size ? ' ' + size : ''), esc(localHand(rk, getLang())));   /* [HAND_I18N_0_10_12] */ n.style.left = cx + 'px'; n.style.top = top + 'px'; parent.appendChild(n); }
        return;
    }
    const won = S.winners.seats[seat];
    const hand = S.reveal[seat] || seat === mySeat() ? S.winners.hands[seat] : '';
    // [HAND_I18N_0_10_12] 다른 플레이어 족보 글자는 화면 언어로, 내(영웅) 것은 영어 그대로
    const handTxt = hand ? (seat === mySeat() ? hand : localHand(hand, getLang())) : '';
    if (hand || won) {
        const n = el('div', 'seat-note' + (size ? ' ' + size : ''), (hand ? esc(handTxt) : '') + (won ? ` <b>+${dm(won)}</b>` : ''));
        n.style.left = cx + 'px'; n.style.top = top + 'px';
        parent.appendChild(n);
    }
    if (won && !(S.vfxHand && S.hand && S.vfxHand === S.hand.handId)) {   // [WINNER_SD_VFX_0_10_9] 경합 쇼다운은 원본 WINNER 연출이 대신한다
        const w = el('div', 'winner-tag' + (size ? ' ' + size : ''), (hand ? `<small>${esc(seat === mySeat() || getLang() === 'en' ? bigHandName(hand) : localHand(hand, getLang()))}</small>` : '') + '<b>' + 'WINNER'.split('').map((c, i) => `<span style="--i:${i}">${c}</span>`).join('') + '</b>');
        w.style.left = ax + 'px'; w.style.top = (ay + 18) + 'px';
        parent.appendChild(w);
    }
}

/** 판에 건 칩 — PC 는 이름 상자 가장자리(팟 쪽)에 붙인다. 영웅 칩은 16px 위 */
function renderBets() {
    // [NO_BET_AMOUNT_0_10_11] 자리 앞 베팅 금액 알약도 뺐다(운영 요청 11-15) — 금액은 액션 말풍선에만. 칩 그림은 0.10.10 에서 이미 뺐다
    $('#bets').innerHTML = '';
}

// ------------------------------------------------------------ 액션

function renderActions() {
    const box = $('#actions');   // act 라고 부르면 아래 프리셋의 act() 호출을 가린다
    const tr = S.turn;
    const meP = S.hand && S.hand.seats.find((x) => x.seat === mySeat());
    $('.room-label').classList.toggle('hide', S.layout === 'mobile');
    $('.a-fold').disabled = false; $('.a-call').disabled = false;   // [RAISE_ORIG_0_10_9] 게이지 잠금은 내 차례에서만 다시 건다
    if (!tr || tr.seat !== mySeat() || !S.hand) {
        S.mGauge = false; $('.mgauge').hidden = true; $('.presets').style.visibility = '';
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
    // [OMAHA_0_10_23] 팟 리밋 — 최대 베팅이 팟 한도이고 칩이 더 많으면 그 끝은 「올인」이 아니라 「팟」(엔진이 ALL_IN 을 한도까지 레이즈로 바꾼다)
    const capped = !!tr.potLimit && (Number(tr.allIn) || 0) > stackAll;
    S.rzCapped = capped;
    if (tr.toCall > 0) { call.querySelector('.t').textContent = tr.toCall >= me.stack ? t('allin') : t('call'); call.querySelector('.s').textContent = dmCur(tr.toCall); call.dataset.act = tr.toCall >= me.stack ? 'ALL_IN' : 'CALL'; }
    else { call.querySelector('.t').textContent = t('check'); call.querySelector('.s').textContent = ''; call.dataset.act = 'CHECK'; }
    // [MINRAISE_TO_0_10_23] 엔진 minRaise 는 「레이즈 후 합계」(HandCore.calculateMinRaise = 현재 베팅 + 직전 레이즈 폭)다.
    //   종전엔 현재 베팅을 한 번 더 더해 최소 레이즈가 BB 2,000 앞에서 6,000(3BB)으로 보였다(엔진은 4,000 을 받는다). 팟 리밋에서는 최소가 최대와 같아졌다
    const minTo = Math.min(stackAll, Math.max(tr.minRaise, S.room.bb));
    const canRaise = stackAll > tr.currentBet && me.stack > tr.toCall;
    raise.disabled = !canRaise;
    const g = $('.gauge-input');
    // [RAISE_ORIG_0_10_9] 게이지는 0~1000 위치 — 금액은 원본처럼 비선형(위치 0/.4/.7/.9/1 = 금액 0/25/50/75/100%)
    S.rz = { min: minTo, max: stackAll };
    g.min = 0; g.max = 1000; g.step = 1;
    if (box.dataset.q !== String(tr.q) || !(S.raiseVal >= minTo && S.raiseVal <= stackAll)) { S.raiseVal = minTo; S.raiseRatio = 0; S.mGauge = false; }
    box.dataset.q = tr.q;
    g.value = Math.round((S.raiseRatio || 0) * 1000);
    const mobileGauge = S.layout === 'mobile' && S.mGauge && canRaise;
    $('.mgauge').hidden = !mobileGauge;
    $('.presets').style.visibility = mobileGauge ? 'hidden' : '';
    $('.a-fold').disabled = !!mobileGauge; call.disabled = !!mobileGauge;   // 원본: 게이지를 연 동안은 레이즈에 들어간 상태
    paintRaise();
    const pre = $('.presets');
    pre.innerHTML = '';
    const pot = S.hand.pot;
    const mobile = S.layout === 'mobile';
    // [PLO_PRESET_0_10_23] 오마하(팟 리밋) — 팟 25·50·75·100%. 팟 % 레이즈 = 현재 베팅 + %×(팟 + 콜 금액) → 100% 가 곧 팟 한도(엔진 maxRaiseTo).
    //   팟 한도가 내 칩보다 크면 100% 는 올인이라 「올인」. 모바일은 위가 큰 금액(종전 모바일 순서와 같다)
    const potPart = (f) => tr.currentBet + f * (pot + tr.toCall);
    const omPresets = [['25%', potPart(0.25)], ['50%', potPart(0.5)], ['75%', potPart(0.75)], [capped ? '100%' : t('allin'), stackAll]];
    const presets = isOmaha() ? (mobile ? omPresets.slice().reverse() : omPresets) : mobile
        ? [[capped ? t('potMax') : t('allin'), stackAll], [t('full'), pot + tr.currentBet], [t('half'), pot * 0.5 + tr.currentBet], [t('quarter'), pot * 0.25 + tr.currentBet]]
        : [['25%', pot * 0.25 + tr.currentBet], ['50%', pot * 0.5 + tr.currentBet], ['100%', pot + tr.currentBet], [capped ? t('potMax') : t('allin'), stackAll]];
    for (const [label, val] of presets) {
        const v = Math.max(minTo, Math.min(stackAll, wholeChips() ? Math.round(val) : Math.round(val * 100) / 100));   // [CHIP_UNIT_0_10_6] 원화 방은 1원 단위
        const b = el('button', '', `<span>${esc(label)}</span><small>${esc(dmCur(v))}</small>`);
        b.type = 'button';
        b.disabled = !canRaise;
        // [ALLIN_CALL_0_10_22] 상대 올인이 내 칩보다 커서 레이즈할 수 없을 때 — 올인 프리셋은 「가진 칩 전부로 콜(올인)」로 켜 둔다(종전엔 꺼져 눌리지 않았다)
        if (!canRaise && label === t('allin') && tr.toCall > 0) {
            b.disabled = false;
            b.querySelector('small').textContent = dmCur(Math.min(tr.toCall, me.stack));
            b.onclick = () => act(call.dataset.act);
            pre.appendChild(b);
            continue;
        }
        // 누르면 바로 베팅(이전 게임 화면과 같다). [PRESET_DIRECT_0_10_7] PC 도 바로 — 종전 PC 는 금액만 잡고 베팅 버튼을 한 번 더 눌러야 했다.
        //   레이즈 바(게이지)를 끄는 것은 종전대로 금액만 잡고 베팅 버튼으로 확정
        b.onclick = () => {
            S.raiseVal = v; S.raiseRatio = ratioAtRaise(v); g.value = Math.round(S.raiseRatio * 1000); paintRaise();
            act(raise.dataset.act, v);
        };
        pre.appendChild(b);
    }
}

/** [RAISE_ORIG_0_10_9] 원본 raiseAtRatio / ratioAtRaise — 4:3:2:1 비선형 구간. 양 끝(최소 레이즈·올인)은 그대로 */
const GAUGE_STOPS = [0, 0.4, 0.7, 0.9, 1], AMOUNT_STOPS = [0, 0.25, 0.5, 0.75, 1];
function raiseAtRatio(r) {
    const { min, max } = S.rz || { min: 0, max: 0 };
    if (r <= 0.001) return min;
    if (r >= 0.999) return max;
    for (let i = 0; i < 4; i++) {
        if (r <= GAUGE_STOPS[i + 1]) {
            const t2 = (r - GAUGE_STOPS[i]) / (GAUGE_STOPS[i + 1] - GAUGE_STOPS[i]);
            const raw = min + (max - min) * (AMOUNT_STOPS[i] + (AMOUNT_STOPS[i + 1] - AMOUNT_STOPS[i]) * t2);
            const v = wholeChips() || (S.room && S.room.bb >= 1) ? Math.round(raw) : Math.round(raw * 100) / 100;
            return Math.max(min, Math.min(max, v));
        }
    }
    return max;
}
function ratioAtRaise(v) {
    const { min, max } = S.rz || { min: 0, max: 0 };
    if (!(max > min)) return 0;
    const a = Math.max(0, Math.min(1, (v - min) / (max - min)));
    for (let i = 0; i < 4; i++) if (a <= AMOUNT_STOPS[i + 1]) return GAUGE_STOPS[i] + (GAUGE_STOPS[i + 1] - GAUGE_STOPS[i]) * ((a - AMOUNT_STOPS[i]) / (AMOUNT_STOPS[i + 1] - AMOUNT_STOPS[i]));
    return 1;
}
function setRaiseRatio(r) {
    S.raiseRatio = Math.max(0, Math.min(1, r));
    S.raiseVal = raiseAtRatio(S.raiseRatio);
    $('.gauge-input').value = Math.round(S.raiseRatio * 1000);
    paintRaise(); raisingOn();
}
/** ± 3BB (원본 bumpRaise) — 지금 금액에서 3BB 씩, 위치는 같은 비선형 표로 */
function bumpRaise(dir) {
    const bb = (S.room && S.room.bb) || 1, { min, max } = S.rz || { min: 0, max: 0 };
    const v = Math.max(min, Math.min(max, S.raiseVal + dir * bb * 3));
    S.raiseVal = v; S.raiseRatio = ratioAtRaise(v); $('.gauge-input').value = Math.round(S.raiseRatio * 1000);
    paintRaise(); raisingOn();
}
function paintRaise() {
    const tr = S.turn; if (!tr) return;
    const raise = $('.a-raise');
    const max = (S.rz && S.rz.max) || 0, v = S.raiseVal;
    const ratio = S.raiseRatio || 0;
    // [RAISE_ORIG_0_10_9] 모바일 세로 게이지
    const mg = $('.mgauge');
    if (mg && !mg.hidden) {
        mg.querySelector('.mg-fill').style.height = (ratio * 100) + '%';
        mg.querySelector('.mg-handle').style.bottom = `calc(${(ratio * 100).toFixed(2)}% - 14px)`;
        const bx = mg.querySelector('.mg-box');
        bx.querySelector('b').textContent = compact(v); bx.querySelector('.cur').textContent = curLabel();
        bx.classList.toggle('allin', v >= max);
    }
    // [RAISE_FIRE_0_10_9] 원본 올인 게이지 — 끝에 닿으면 바가 달아오르고 불길·불티, 금액 상자는 「ALL-IN」 간판(PC·모바일)
    const hot = max > 0 && v >= max && !S.rzCapped;   // [OMAHA_0_10_23] 팟 한도 끝은 불꽃 없음(올인이 아니다)
    $('.gauge').classList.toggle('rz-hot', hot); if (mg) mg.classList.toggle('rz-hot', hot);
    document.querySelectorAll('.gauge-bubble, .mg-box').forEach((b) => { b.classList.toggle('rz-allin-box', hot); const l = b.querySelector('.rz-allin-label'); if (l) { l.textContent = hot ? t('allin').toUpperCase() : ''; l.hidden = !hot; } });
    const well = $('.gauge-well');
    $('.gauge-fill').style.width = (ratio * 100) + '%';
    const left = 27 + ratio * (well.clientWidth || 300) - 16;
    $('.gauge-handle').style.left = left + 'px';
    const allin = v >= max;
    raise.querySelector('.t').textContent = allin ? (S.rzCapped ? (isOmaha() ? t('potFull') : t('potMax')) : t('allin')) : (tr.currentBet > 0 && !(S.layout === 'mobile' && S.mGauge) ? t('raise') : t('bet'));
    raise.querySelector('.s').textContent = dmCur(v);
    const gb = $('.gauge-bubble'); gb.hidden = false; gb.querySelector('b').textContent = compact(v); gb.querySelector('.cur').textContent = curLabel(); gb.style.left = (left + 16) + 'px';
    // [PLO_SFX_0_10_23] 팟 한도 끝(칩이 더 남음)은 올인이 아니다 — 레이즈/베팅으로 보내 올인 소리·말풍선이 나지 않게(종전엔 ALL_IN 을 보내 엔진이 레이즈로 바꿨지만 내 화면은 올인 소리)
    raise.dataset.act = allin && !S.rzCapped ? 'ALL_IN' : (tr.currentBet > 0 ? 'RAISE' : 'BET');
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

/** [CHIP_UNIT_0_10_6] 칩 단위 1(원화 방) */
const wholeChips = () => !!(S.room && S.room.rake && S.room.rake.unit === 1);

async function act(action, amount) {
    if (S.dragRaise && !['RAISE', 'BET', 'ALL_IN'].includes(action)) return;   // [RAISE_ON_RELEASE_0_10_12] 레이즈 바를 잡고 있는 동안 체크·콜·폴드 없음
    const tr = S.turn;
    if (!tr || tr.seat !== mySeat() || !S.keys) return;
    // 같은 차례는 한 번만 — 서명하는 동안 다시 눌러도 두 번 보내지 않는다
    const key = tr.handId + ':' + tr.q;
    if (S.acting === key) return;
    S.acting = key;
    hideActions();
    stopTurnSfx();   // [SFX_ORIG_0_10_9]
    setTimeout(flushTips, 400);   // [TIP_DEFER_0_10_9]
    sfx(action, mySeat()); S.heroSfx = { cls: sfxCls(action), at: Date.now() };   // [SFX_ORIG_0_10_9] 누르는 즉시 내 소리
    // [ACT_FAST_0_10_10] 누르는 즉시 내 자리 말풍선(금액은 엔진 응답 때 붙는다) — 서버 왕복 동안 반응이 없어 보이지 않게. 실패하면 되돌린다
    const prevBubble = S.bubbles[mySeat()];
    S.bubbles[mySeat()] = { a: action, amt: 0, at: Date.now(), optimistic: true }; render();
    let amt = action === 'RAISE' || action === 'BET' ? Number(amount) : 0;
    if (wholeChips()) amt = Math.round(amt);   // [CHIP_UNIT_0_10_6] 원화 방 — 엔진이 1원 아래 베팅을 받지 않는다
    // [ACT_UNLOCK_0_10_10] 실패하면 같은 차례에 다시 누를 수 있게 잠금을 푼다(전에는 한 번 실패하면 그 차례 버튼이 잠겨 시간 초과로 폴드됐다).
    //   연결 문제(답 없음·네트워크 오류)면 한 번 더 보낸다 — 같은 차례 번호(q)라 엔진이 두 번 처리하지 않는다
    let r = null;
    try {
        const sig = await V.sign(S.keys, V.msg.action(tr.handId, tr.q, action, amt));
        const send = () => cmd('act', { q: tr.q, action, amount: amt, sig }).catch(() => null);
        r = await send();
        if (!r && S.turn && S.turn.handId === tr.handId && S.turn.q === tr.q) r = await send();
    } catch (_e) { r = null; }
    if (r && r.ok) return;
    if (S.bubbles[mySeat()] && S.bubbles[mySeat()].optimistic) { if (prevBubble) S.bubbles[mySeat()] = prevBubble; else delete S.bubbles[mySeat()]; }   // [ACT_FAST_0_10_10]
    if (S.acting === key) S.acting = '';
    if (r && r.code === 'turn') { render(); return; }   // 이미 지나간 차례(앞서 보낸 것이 먼저 닿음) — 알림 없이 지금 상태로
    toastErr(r ? (r.error || 'action failed') : t('netRetry'));
    render();
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
    $('.a-raise').onclick = (e) => {
        // [RAISE_ORIG_0_10_9] 모바일: 첫 탭 = 세로 게이지 열기(원본 openRaiseGauge), 두 번째 탭 = 그 금액으로 확정. 종전엔 첫 탭에 최소 금액이 바로 나갔다
        if (S.layout === 'mobile' && !S.mGauge) { S.mGauge = true; S.raiseRatio = 0; S.raiseVal = (S.rz && S.rz.min) || S.raiseVal; raisingOn(); renderActions(); return; }
        S.mGauge = false;
        act(e.currentTarget.dataset.act, S.raiseVal);
    };
    $('.gauge-input').oninput = (e) => setRaiseRatio(Number(e.target.value) / 1000);
    /* [RAISE_ON_RELEASE_0_10_12] 레이즈 바를 잡는 순간 체크·콜·폴드는 막고, 놓는 그 자리 금액으로 바로 레이즈(운영 요청 — 두 번 누르지 않는다).
       PC 가로 바·모바일 세로 게이지 모두. 모바일 ± 버튼으로 맞춘 금액은 종전처럼 레이즈 버튼으로 낸다 */
    const startDrag = () => { if (!S.turn || S.turn.seat !== mySeat()) return; S.dragRaise = true; $('#actions').classList.add('dragging'); raisingOn(); };
    const fireRaise = () => {
        if (!S.dragRaise) return;
        S.dragRaise = false; $('#actions').classList.remove('dragging');
        const r = $('.a-raise');
        if (!S.turn || S.turn.seat !== mySeat() || r.disabled) return;
        S.mGauge = false;
        act(r.dataset.act, S.raiseVal);
    };
    S.fireRaise = fireRaise;
    $('.gauge-input').addEventListener('pointerdown', (e) => { if (e.button === 0 || e.pointerType !== 'mouse') startDrag(); });
    window.addEventListener('pointerup', () => { if (S.dragRaise && !S.mgDrag) fireRaise(); });
    window.addEventListener('pointercancel', () => { if (S.dragRaise && !S.mgDrag) { S.dragRaise = false; $('#actions').classList.remove('dragging'); } });
    // [RAISE_ORIG_0_10_9] 모바일 세로 게이지 — 끌기(아래 = 최소, 위 = 올인)
    const track = $('.mg-track');
    // [MG_KNOB_0_10_11] 조절기(손잡이)를 잡으면 튀지 않고 잡은 자리 그대로 끌린다 — 손잡이 둘레 32px 안이면 「잡기」(값 그대로, 손가락과의 차이를 기억),
    //   그 밖을 누르면 그 자리로 옮긴 뒤 끌기. 막대·손잡이 둘레(CSS ::before)가 모두 잡는 자리, 손잡이가 막대 밖으로 나온 아래 끝(최소 금액)도 잡힌다
    const fromY = (y) => { const r = track.getBoundingClientRect(); return 1 - (y - r.top) / r.height; };
    let grabDy = 0, dragId = null;
    track.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        try { track.setPointerCapture(e.pointerId); } catch (_e) { /* */ }
        dragId = e.pointerId;
        const hr = $('.mg-handle').getBoundingClientRect(), hy = hr.top + hr.height / 2;
        if (Math.abs(e.clientY - hy) <= 32) grabDy = hy - e.clientY;   // 손잡이를 잡았다 — 값을 바꾸지 않는다
        else { grabDy = 0; setRaiseRatio(fromY(e.clientY)); }
        track.classList.add('grab');
        S.mgDrag = true; startDrag();   // [RAISE_ON_RELEASE_0_10_12]
    });
    track.addEventListener('pointermove', (e) => { if (e.pointerId === dragId) { e.preventDefault(); setRaiseRatio(fromY(e.clientY + grabDy)); } });
    const endDrag = (e) => {
        if (e.pointerId !== dragId) return;
        dragId = null; track.classList.remove('grab');
        S.mgDrag = false;
        if (e.type === 'pointerup') fireRaise(); else if (S.dragRaise) { S.dragRaise = false; $('#actions').classList.remove('dragging'); }   // 손을 떼면 그 금액으로 바로
    };
    for (const ev of ['pointerup', 'pointercancel', 'lostpointercapture']) track.addEventListener(ev, endDrag);
    track.onclick = () => {};   // 터치 보정(가까운 버튼으로 끌려가기)이 막대도 누를 수 있는 것으로 보게 — 없으면 손잡이 근처 탭이 − 버튼으로 갔다
    // [MG_TOUCH_0_10_11] ± 버튼 — click 은 손가락이 조금만 움직여도(스크롤·확대 제스처로 보고) 사라졌다. 누르는 순간(pointerdown) 바로 올리고,
    //   누르고 있으면 0.4초 뒤부터 계속 올린다. 손가락이 버튼 밖으로 살짝 밀려도 끝까지 이 버튼(pointer capture)
    for (const [sel, dir] of [['.mg-plus', 1], ['.mg-minus', -1]]) {
        const b = $(sel);
        let rep = 0, hold = 0;
        const stop = () => { clearTimeout(hold); clearInterval(rep); hold = rep = 0; b.classList.remove('down'); };
        b.addEventListener('pointerdown', (e) => {
            e.preventDefault(); stop();
            try { b.setPointerCapture(e.pointerId); } catch (_e) { /* */ }
            b.classList.add('down'); bumpRaise(dir);
            hold = setTimeout(() => { rep = setInterval(() => bumpRaise(dir), 110); }, 400);
        });
        for (const ev of ['pointerup', 'pointercancel', 'lostpointercapture']) b.addEventListener(ev, stop);
        b.onclick = (e) => { if (e.detail === 0) bumpRaise(dir); };   // 키보드(Enter)로 누른 것만 — 터치·마우스는 pointerdown 에서 이미 했다
    }
    $('.gauge-input').addEventListener('pointerdown', raisingOn);
    /* [REBUY_IN_ROOM_0_10_15] 올인 뒤 바이인 신청 — 로비로 옮기지 않고 테이블 위 창에서 한다(판은 뒤에서 계속 보인다).
       창 안은 로비의 같은 신청 화면(/game/?room_id=&embed=1 — 처음 앉을 때와 같은 신청·방장 승인·좌석표). 회원 로그인은 로비 쪽에만 있다.
       승인되면 로비가 새 좌석표 주소를 이 화면(같은 TEE 주소)으로만 보내고, 그 좌석표로 이 자리에 다시 앉는다 */
    $('.rb-go').onclick = () => openRebuyPop();
    // [HOST_DESK_0_10_23] 방장 관리 창(로비 화면) — 같은 창을 열고 탭을 고른다: 신청 / 손익표 / 회원 초대. 창은 한 번 띄운 뒤 그대로라 탭은 메시지로
    const hostTab = (tab) => {
        openHostPop(true);
        const fr = $('#rebuy-pop .rp-frame');
        const msg = tab === 'invite' ? { src: 'buyin-tee', type: 'focus-invite' } : { src: 'buyin-tee', type: 'host-tab', tab };
        const send = () => { try { fr.contentWindow.postMessage(msg, new URL(LOBBY_URL).origin); } catch (_e) { /* */ } };
        if ($('#rebuy-pop').classList.contains('loaded')) send(); else fr.addEventListener('load', () => setTimeout(send, 600), { once: true });
        setTimeout(send, 1500);
    };
    $('#watch-bar .wb-req').onclick = () => hostTab('requests');   // [WATCH_0_10_20]
    $('#watch-bar .wb-led').onclick = () => hostTab('ledger');     // [HOST_DESK_0_10_23] 회원 손익·바이인 개수
    $('#watch-bar .wb-inv').onclick = () => hostTab('invite');     // [WATCH_INVITE_0_10_22]
    $('#away-bar .aw-back').onclick = async () => {   // [AWAY_0_10_16] 자리 비움 풀기 — 다음 판부터
        const r = await cmd('back');
        if (r && !r.ok) toastErr(r.error || '');
    };
    for (const b of document.querySelectorAll('.rb-lobby, .rp-lobby')) b.onclick = () => { void leaveThenLobby(); };   // [BUST_LEAVE_0_10_23]
    $('#rebuy-pop .rp-x').onclick = () => closeRebuyPop();
    $('#rebuy-pop').addEventListener('click', (e) => { if (e.target.id === 'rebuy-pop') closeRebuyPop(); });
    addEventListener('message', (e) => {
        if (e.origin !== new URL(LOBBY_URL).origin) return;
        const d = e.data || {};
        if (d.src !== 'buyin-lobby') return;
        if (d.type === 'close') closeRebuyPop();
        else if (d.type === 'host-pending') {   // [WATCH_0_10_20] 대기 중인 바이인 신청 수(방장 관전)
            const n = Math.max(0, Number(d.n) || 0);
            if (S.watch && n > (S.hostPending || 0) && S.live) toast(t('watchNew'), 3000);
            S.hostPending = n; renderWatch();
            if (S.watch) hostAlarm();   // [HOST_ALARM_0_10_22] 승인 전까지 바이인 신청 알림음 반복
        }
        else if (d.type === 'lobby') void leaveThenLobby();   // [BUST_LEAVE_0_10_23]
        else if (d.type === 'ticket' && typeof d.url === 'string') {
            let u; try { u = new URL(d.url); } catch (_e) { return; }
            if (u.origin !== location.origin || !u.pathname.startsWith('/table/')) return;   // 이 TEE 의 테이블 화면 좌석표만
            const nt = new URLSearchParams(u.hash.slice(1)).get('t');
            if (!nt) return;
            // 좌석표는 이 탭의 입장 대기 칸에 넣고 다시 연다(boot 가 읽는다) — 주소 #t= 만 바꾸는 이동은 브라우저마다 다시 열리지 않거나 좌석표를 잃었다
            try { sessionStorage.removeItem('buyin.token'); sessionStorage.setItem('buyin.ticket', nt); } catch (_e) { return; }
            location.reload();
        }
    });
    $('.rq-btn').onclick = async () => {   // [READY_SESSION_0_10_6] 준비 완료 / 준비 취소
        const g = S.gate, mine = g && (g.players || []).find((x) => x.seat === mySeat());
        if (!mine || S.rqBusy) return;
        S.rqBusy = true; renderGate();
        try {
            const r = await cmd('ready', { on: !mine.ready });
            if (!r.ok) toastErr(r.error || '');   // [READY_NO_SFX_0_10_7] 준비 완료에 체크 소리를 내지 않는다 — 카운트다운 뒤 게임 시작 소리만
        } finally { S.rqBusy = false; renderGate(); }
    };
    document.addEventListener('click', (e) => { if (!e.target.closest('#pf-pop')) closeProfile(); });   // [PROFILE_STATS_0_10_11]
    $('#btn-leave').onclick = () => askLeave();   // [NET_LEAVE_0_10_9]
    document.querySelectorAll('#show-pick button').forEach((b) => { b.onclick = (e) => { e.stopPropagation(); sendShow(b.dataset.w); }; });   // [SHOW_CARDS_0_10_9]
    $('#leave-ask .la-no').onclick = () => { $('#leave-ask').hidden = true; };
    $('#leave-ask .la-yes').onclick = () => doLeave();
    $('#net-over .net-reload').onclick = () => location.reload();
    // [NET_LEAVE_0_10_9] 브라우저 뒤로가기도 나가기 확인으로(원본 popstate 가로채기)
    try { history.pushState({ table: 1 }, ''); S.pushed = true; } catch (_e) { /* */ }
    addEventListener('popstate', () => {
        if (S.leaving) return;   // [GATE_BACK_0_10_11] 로비로 가는 중 — 가로채지 않는다
        if (S.token && $('.gate-back').hidden) { try { history.pushState({ table: 1 }, ''); } catch (_e) { /* */ } askLeave(); }
        else goLobby();   // 정산·연결 끝 화면에서 뒤로가기 = 로비로
    });
    $('#btn-sound').onclick = (e) => { S.sound = !S.sound; e.currentTarget.classList.toggle('on', !S.sound); if (S.sound) { if (!(S.vol > 0)) setVol(0.6); play('check'); } else stopTurnSfx(); };
    // 설정 — 소리 크기(예전 화면의 설정 창)
    const vol = $('#st-vol');
    const paintVol = () => { vol.value = S.vol; $('.st-vv').textContent = Math.round(S.vol * 100); vol.style.setProperty('--p', (S.vol * 100) + '%'); };   // [SETTINGS2_0_10_23] 채운 막대
    // [FX_SMALL_0_10_9] 소리 버튼과 볼륨을 하나로(원본) — 0 이면 꺼짐 표시, 올리면 다시 켜짐
    const setVol = (v) => { S.vol = Math.max(0, Math.min(1, Number(v) || 0)); try { localStorage.setItem('buyin.vol', String(S.vol)); } catch (_e) { /* */ } paintVol(); S.sound = S.vol > 0; $('#btn-sound').classList.toggle('on', !S.sound); if (!S.sound) stopTurnSfx(); if (typeof paintSw === 'function') paintSw(); };
    // [SETTINGS2_0_10_23] 「소리 되살리기」 버튼 대신 — 앱을 오갔다 돌아오면(화면이 다시 보이면) 소리 장치를 스스로 되살린다(iOS interrupted·suspended)
    document.addEventListener('visibilitychange', () => { if (!document.hidden && S.sound && actx && actx.state !== 'running') audio(); });
    // [SETTINGS2_0_10_23] 스위치 — 소리(전체) · 캐릭터 목소리 · 내 차례 알림음 · 4색 카드 · 내 차례 진동. 이 기기에 기억
    const paintSw = () => {
        const on = { sound: S.sound, voiceOn: S.voiceOn, turnAlert: S.turnAlert, fourColor: S.fourColor, vibrate: S.vibrate };
        document.querySelectorAll('#settings .st-sw').forEach((b) => b.setAttribute('aria-checked', on[b.dataset.k] ? 'true' : 'false'));
        $('#settings .st-voice').classList.toggle('off', !S.voiceOn);
        $('#settings .st-slider:not(.st-zrow)').classList.toggle('off', !S.sound);
        document.body.classList.toggle('four-color', !!S.fourColor);
    };
    $('#settings .st-vib').hidden = typeof navigator.vibrate !== 'function';
    // [VIEW_CUR_0_10_23] 화면 통화 — 원화 · 테더 · 베트남동. 고르면 테이블 모든 금액이 환율대로 바뀐다(게임·정산은 그대로). 이 기기에 기억
    const paintCur = () => {
        const r = viewRates(), on = cur();
        const row = $('#settings .st-cur');
        row.hidden = !r || Object.keys(r).length < 2;
        row.querySelectorAll('button').forEach((b) => { b.hidden = !(r && r[b.dataset.c] > 0); b.classList.toggle('on', b.dataset.c === on); });
        const ex = $('#settings .st-cur-ex');
        if (ex && r && S.room) { const bb = S.room.bb || 0; ex.textContent = 'BB ' + dmCur(bb); }
    };
    $('#settings .st-cur').querySelectorAll('button').forEach((b) => {
        b.onclick = () => { S.viewCur = b.dataset.c; try { localStorage.setItem('buyin.viewCur', S.viewCur); } catch (_e) { /* */ } paintCur(); render(); paintVol(); };
    });
    document.querySelectorAll('#settings .st-sw').forEach((b) => {
        b.onclick = () => {
            const k = b.dataset.k;
            if (k === 'sound') { if (S.sound) { S.sound = false; stopTurnSfx(); } else { if (!(S.vol > 0)) setVol(0.6); S.sound = true; audio(); play('check'); } $('#btn-sound').classList.toggle('on', !S.sound); }
            else {
                S[k] = !S[k];
                try { localStorage.setItem('buyin.' + k, S[k] ? '1' : '0'); } catch (_e) { /* */ }
                if (k === 'turnAlert' && !S[k]) stopTurnSfx();
                if (k === 'voiceOn' && S[k]) { audio(); play('check'); }
                if (k === 'vibrate' && S[k]) { try { navigator.vibrate(40); } catch (_e) { /* */ } }
                if (k === 'fourColor') render();
            }
            paintSw();
        };
    });
    paintSw();
    // [ZOOM_FS_0_10_9] 화면 크기 · 전체화면(원본 설정·HUD)
    const zoom = $('#st-zoom');
    const paintZoom = () => { zoom.value = S.zoom; $('.st-zv').textContent = Math.round(S.zoom * 100) + '%'; zoom.style.setProperty('--p', ((S.zoom - 0.6) / 0.4 * 100) + '%'); $('.st-zrow').hidden = S.layout !== 'mobile'; };
    zoom.oninput = () => { S.zoom = Math.max(0.6, Math.min(1, Number(zoom.value) || 1)); try { localStorage.setItem('buyin.zoom', String(S.zoom)); } catch (_e) { /* */ } paintZoom(); layoutMode(); render(); };
    const fsOk = !!(document.fullscreenEnabled || document.webkitFullscreenEnabled);
    const fsBtn = $('#btn-fs');
    fsBtn.hidden = !(fsOk && matchMedia('(pointer: coarse)').matches);
    fsBtn.onclick = () => {
        const d = document, on = d.fullscreenElement || d.webkitFullscreenElement;
        try {
            if (on) (d.exitFullscreen || d.webkitExitFullscreen).call(d);
            else { const r = d.documentElement; (r.requestFullscreen || r.webkitRequestFullscreen).call(r); }
        } catch (_e) { /* 막힌 브라우저 */ }
    };
    for (const ev of ['fullscreenchange', 'webkitfullscreenchange']) document.addEventListener(ev, () => { fsBtn.classList.toggle('on', !!(document.fullscreenElement || document.webkitFullscreenElement)); setTimeout(() => { layoutMode(); render(); }, 120); });
    $('#btn-settings').onclick = () => { paintVol(); paintZoom(); paintSkinRow(); paintSw(); paintCur(); $('#settings').hidden = false; };
    // [SKIN_PICK_0_10_12] 설정 › 테이블 → 스킨 고르기 창(휴대폰은 아래에서 올라오는 시트, PC 는 오른쪽 패널 — 테이블이 보이는 채로 바로 바뀐다)
    $('.st-skin').onclick = () => openSkinPick();
    $('#skin-pick .sp-x').onclick = () => { $('#skin-pick').hidden = true; };
    $('#skin-pick').onclick = (e) => { if (e.target.id === 'skin-pick') $('#skin-pick').hidden = true; };
    loadSkins().then(() => paintSkinRow());
    vol.oninput = () => setVol(vol.value);
    vol.onchange = () => play('check');
    // [SFX_ORIG_0_10_9] 캐릭터 목소리 — 고르면 check 로 미리 듣기(원본 previewVoiceCheck)
    const paintVoice = () => document.querySelectorAll('.st-voice button').forEach((b) => b.classList.toggle('on', b.dataset.v === VOICE));
    document.querySelectorAll('.st-voice button').forEach((b) => {
        b.onclick = () => { VOICE = VOICES.includes(b.dataset.v) ? b.dataset.v : 'male'; try { localStorage.setItem('buyin.voice', VOICE); } catch (_e) { /* */ } paintVoice(); audio(); play('check'); };
    });
    paintVoice();
    $('.st-x').onclick = () => { $('#settings').hidden = true; };
    $('#settings').onclick = (e) => { if (e.target.id === 'settings') $('#settings').hidden = true; };
    // 채팅 — PC 왼쪽 아래 패널(머리줄을 누르면 펼침), 모바일 💬
    $('#chat .chat-head').onclick = () => {
        const c = $('#chat'); c.classList.toggle('closed');
        if (!c.classList.contains('closed')) { $('#chat .chat-head .dot').hidden = true; renderChat(); $('#chat .chat-input').focus(); }
    };
    { const bm = $('#btn-chat-m'), dot = bm.querySelector('.dot'); bm.innerHTML = SVG_CHAT; if (dot) bm.appendChild(dot); }   // [CHAT_M_0_10_7]
    $('#btn-chat-m').onclick = (e) => { e.stopPropagation(); openChatM(); };
    // [CHAT_FEED_INPUT_0_10_11] 가운데 채팅 창의 입력 줄에 바로 쓴다(종전: 위쪽 채팅 창이 따로 열렸다). 글 줄을 눌러도 입력칸으로
    //   휴대폰 키보드가 입력칸을 덮지 않게 — 쓰는 동안 입력 줄만 보이는 화면(visualViewport)의 키보드 바로 위에 붙인다
    {
        const f = $('#chat-feed .cf-form'), inp = $('#chat-feed .cf-input');
        const vv = window.visualViewport;
        const place = () => {
            // 키보드가 실제로 떠 있을 때만(보이는 높이가 화면 높이의 72% 아래) — 키보드를 내린 채 초점만 남으면 제자리로(액션 버튼을 덮지 않게)
            const kb = vv && document.activeElement === inp && matchMedia('(pointer: coarse)').matches && vv.height < screen.height * 0.72;
            if (!kb) { f.classList.remove('lift'); f.style.top = ''; return; }
            f.classList.add('lift');
            f.style.top = Math.round(vv.offsetTop + vv.height - f.offsetHeight - 8) + 'px';
        };
        inp.addEventListener('focus', () => { place(); setTimeout(place, 250); setTimeout(place, 600); });
        inp.addEventListener('blur', () => { f.classList.remove('lift'); f.style.top = ''; });
        if (vv) { vv.addEventListener('resize', place); vv.addEventListener('scroll', place); }
    }
    $('#chat-m .chat-x').onclick = () => { $('#chat-m').hidden = true; };
    /* [CHAT_SEND_IOS_0_10_14] 아이폰 — 「보내기」를 누르는 순간 입력칸 초점이 먼저 풀려(키보드가 내려가며 입력 줄이 제자리로 내려가고,
       예전에는 버튼도 숨었다) 누름이 빈 곳에 떨어졌다. 버튼을 눌러도 초점을 놓지 않고, 손을 떼는 순간 바로 보낸다(키보드는 그대로) */
    for (const btn of document.querySelectorAll('.chat-send')) {
        const root = '#' + btn.closest('#chat, #chat-m, #chat-feed, #ready-q').id;   // [GATE_CHAT_0_10_23] 대기실 채팅도
        btn.addEventListener('mousedown', (e) => e.preventDefault());
        btn.addEventListener('touchstart', (e) => { e.preventDefault(); btn.classList.add('press'); }, { passive: false });
        btn.addEventListener('touchcancel', () => btn.classList.remove('press'));
        btn.addEventListener('touchend', (e) => {
            e.preventDefault(); btn.classList.remove('press');
            const tch = e.changedTouches && e.changedTouches[0], r = btn.getBoundingClientRect();
            if (tch && (tch.clientX < r.left - 12 || tch.clientX > r.right + 12 || tch.clientY < r.top - 12 || tch.clientY > r.bottom + 12)) return;   // 손가락을 밖으로 끌어 뗐으면 보내지 않는다
            sendChat(root);
        }, { passive: false });
    }
    for (const input of document.querySelectorAll('.chat-input')) {
        const sync = () => input.closest('.chat-form').classList.toggle('has-text', !!input.value.trim());
        input.addEventListener('input', sync); sync();
    }
    for (const root of ['#chat', '#chat-m', '#chat-feed', '#ready-q']) {   // [GATE_CHAT_0_10_23] 대기실 채팅도 같은 보내기
        // [NET_LEAVE_0_10_9] form submit 으로 보낸다 — 안드로이드 한글 입력 중에는 Enter 가 'Unidentified'(229)로 와 keydown 으로는 안 보내졌다(원본 RoomChat 수정과 같다)
        $(root + ' .chat-form').onsubmit = (e) => { e.preventDefault(); sendChat(root); };
        $(root + ' .chat-input').onkeydown = (e) => { if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); sendChat(root); } };
    }
    $('#btn-dark').onclick = () => toggleDark();
    // [DBL_CHECK_0_10_12] PC — 테이블 빈 곳을 두 번 누르면 체크(내 차례이고 체크할 수 있을 때만). 버튼·좌석·카드·채팅 위에서는 하지 않는다
    document.addEventListener('dblclick', (e) => {
        if (S.layout !== 'pc' || !e.target.closest('#table') || e.target.closest('button, input, textarea, a, .seat, #actions, #dark-dock, #chat, .hero, .hole, #emote-pick, #tip-pick, #pf-pop, #settings, #skin-pick, #ready-q, #gate')) return;
        const tr = S.turn;
        if (!tr || tr.seat !== mySeat() || !S.keys || tr.toCall > 0 || $('#actions').hidden || gateOpen()) return;
        try { const sel = window.getSelection(); if (sel) sel.removeAllRanges(); } catch (_e) { /* */ }
        const fx = el('div', 'dbl-check'); fx.textContent = t('check');
        fx.style.left = e.clientX + 'px'; fx.style.top = e.clientY + 'px';
        document.body.appendChild(fx); setTimeout(() => fx.remove(), 700);
        act('CHECK');
    });
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
    $('.gate-back').onclick = () => goLobby();
    $('.verify-badge button').onclick = () => showProof();
    S.timerTick = setInterval(() => {
        const dots = '.'.repeat(Math.floor(Date.now() / 400) % 4);
        document.querySelectorAll('.raising .dots').forEach((d) => { d.textContent = dots; });
        const bar = $('.turnbar');
        bar.hidden = true;   // [HERO_RING_M_0_10_11] 모바일 영웅도 프로필 원형 링으로 — 가로 막대는 쓰지 않는다
        if (!S.turn) return;
        if (!bar.hidden) bar.firstChild.style.width = (Math.min(1, Math.max(0, (S.turn.deadline - Date.now()) / (S.room.turnSec * 1000))) * 100).toFixed(1) + '%';
        const left = Math.max(0, (S.turn.deadline - Date.now()) / 1000);
        const secEl = $('.tsec'); if (secEl) secEl.textContent = Math.ceil(left);
    }, 250);
}

// ------------------------------------------------------------ 확인 표시

function renderBadge() {
    const b = $('.verify-badge');
    const bad = S.att === 'mismatch' || S.holeOk === false || S.cardsOk === false;
    const ok = S.att === 'ok' && S.holeOk !== false && S.cardsOk !== false;
    b.classList.toggle('warn', bad);
    b.hidden = !bad;   // [VB_HIDE_0_10_11] 평소엔 숨긴다(운영 요청 11-16) — 확인이 실패했을 때만 빨간 경고로. 검증 화면은 오른쪽 위 방패 버튼
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
/**
 * [NOTIFY_ORIG_0_10_9] 원본 GameNotificationModal 처럼 종류(error 빨강 · warn 주황 · info 금색)와 남은 시간 막대.
 * 오류 문구(엔진이 거절한 이유)는 error, 그 밖은 info
 */
function toast(msg, ms = 2600, kind = 'info') {
    const n = $('#toast');
    n.className = 'tk-' + kind;
    n.innerHTML = '';
    const tx = el('span', 'tk-t'); tx.textContent = msg; tx.style.whiteSpace = 'pre-line';
    const bar = el('i', 'tk-bar'); bar.style.animationDuration = ms + 'ms';
    n.append(tx, bar);
    n.hidden = true; void n.offsetWidth; n.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { n.hidden = true; }, ms);
}
const toastErr = (msg) => toast(msg, 3200, 'error');
/** 안내 화면. back = 자리가 닫혔다 — 들어온 화면(로비)으로 돌아가는 버튼을 보인다 */
function gate(msg, back = false) {
    $('.gate-msg').textContent = msg;
    $('.gate-back').hidden = !back;
    $('#gate').hidden = false;
}

function hideGate() { $('#gate').hidden = true; }

/**
 * [GATE_BACK_0_10_11] 「로비로 돌아가기」 — 종전 history.back() 은 뒤로가기 가로채기용으로 넣어 둔 기록 한 칸만 지워 같은 화면에 남았다
 * (그 뒤 가로채기가 다시 걸려 멈춘 것처럼 보였다). 로비가 연 창이면 닫고, 아니면 넣어 둔 칸까지 건너 돌아가고, 0.8초 안에 못 가면 로비 주소로
 */
/**
 * [BUST_LEAVE_0_10_23] 올인으로 칩이 0 이 돼 자리가 잡혀 있는(바이인 대기) 회원·관전 방장이 「로비로」를 누르면 — 자리를 풀고(나가기) 로비로.
 * 종전엔 주소만 옮겨 10분 동안 「올인 0」 자리로 남아 있었다(운영 제보). 칩이 남은 회원은 이 버튼이 없다(나가기 확인을 거친다)
 */
async function leaveThenLobby() {
    if (S.leaving) return;
    const me = (S.seats || []).find((x) => x && x.seat === mySeat());
    if (S.token && (S.watch || (me && me.busted))) {
        try { await Promise.race([cmd('leave'), new Promise((r) => setTimeout(r, 1500))]); } catch (_e) { /* 끊겼어도 로비로 */ }
    }
    S.leaving = true; S.token = '';
    location.href = LOBBY_URL + '/';
}
function goLobby() {
    if (S.leaving) return;
    S.leaving = true; S.token = '';
    const fallback = () => { location.href = LOBBY_URL + '/'; };
    try { if (window.opener && !window.opener.closed) { window.close(); setTimeout(fallback, 400); return; } } catch (_e) { /* */ }
    const steps = S.pushed ? 2 : 1;
    if (history.length > steps) {
        addEventListener('pagehide', () => clearTimeout(fb), { once: true });
        const fb = setTimeout(fallback, 800);
        history.go(-steps);
    } else fallback();
}

/** [NET_LEAVE_0_10_9] 연결 끊김 표시 — 종전엔 조용히 다시 붙기만 해 화면이 멈춘 줄 몰랐다 */
function paintNet() {
    const off = S.offline ? Date.now() - S.offline : 0;
    $('#net-pill').hidden = !(off > 1200 && off < 8000);
    $('#net-over').hidden = !(off >= 8000);
    $('#net-over .net-reload').hidden = !(off >= 15000);
}
setInterval(() => { if (S.offline) paintNet(); }, 500);

/** [NET_LEAVE_0_10_9] 나가기 확인 — 원본 게임 메뉴처럼 바로 나가지 않고 묻는다. 판 중이면 판이 끝난 뒤 일어난다(엔진 규칙 그대로) */
function askLeave() {
    if (!S.token) { history.back(); return; }
    if (S.watch) { cmd('leave').catch(() => { /* */ }).finally(() => { try { sessionStorage.removeItem('buyin.token'); sessionStorage.removeItem('buyin.watch'); } catch (_e) { /* */ } location.href = LOBBY_URL + '/'; }); return; }   // [WATCH_0_10_20] 관전은 정산 없이 바로
    const inHand = !!(S.hand && S.hand.seats.some((p) => p.seat === mySeat() && !p.folded) && !S.winners);
    $('#leave-ask .la-sub').textContent = inHand ? t('leaveAskHand') : t('leaveAskSub');
    $('#leave-ask').hidden = false;
}
async function doLeave() {
    $('#leave-ask').hidden = true;
    if (!S.token) return;
    const r = await cmd('leave');
    if (r.ok && r.pending) { S.leaveReserved = true; $('#btn-leave').classList.add('reserved'); toast(t('leftAfter')); }
}

// 효과음 — 이전 게임과 같은 파일(리소스 서버 sfx/)을 받아 Web Audio 로 재생한다. 받기만 하고 아무것도 보내지 않는다
let actx = null;
const sfxBuf = new Map();
const SFX_ALL = ['fold', 'check', 'call', 'bet', 'raise', 'allin', 'minichip', 'raise_chip', 'allin_chip', 'card', 'board', 'turn', 'win', 'start', 'showdown',   // [SFX_BOARD_WIN_2026_11_13] board = 보드 카드 오픈
    'tip_flower', 'tip_confetti', 'tip_champagne', 'tip_cigarette',   // [TIP_ROYAL_0_10_5] 로열 팁 효과음(영상과 0초부터 같이)
    'hero_check_drag_v2', 'hand-rank'];   // [SFX_ORIG_0_10_9] 원본 게임: 내 체크 추가음, 족보(트리플 이상) 효과음
/**
 * [SFX_ORIG_0_10_9] 액션 소리 — 원본 게임(useGameSound·page.tsx)과 같게.
 *   BET = bet 보이스만(볼륨 2.2배), RAISE = raise 보이스만 — 종전엔 raise_chip 을 같이 내 베팅 소리가 두 번 났다(원본 주석 그대로).
 *   CALL = call + minichip, ALL_IN = allin + allin_chip, 내가 CHECK 하면 hero_check_drag_v2 를 더한다.
 */
const ACT_SFX = { FOLD: [['fold']], CHECK: [['check']], CALL: [['call'], ['minichip']], BET: [['bet', 2.2]], RAISE: [['raise']], ALL_IN: [['allin'], ['allin_chip']] };
/** [SFX_ORIG_0_10_9] 캐릭터 목소리 — 남1(기본, sfx/ 바로 아래) · 남2(sfx/male2/) · 여(sfx/female/). 액션 보이스 6개만 바뀐다(원본 VOICE_ACTION_LIST) */
const VOICE_ACT = new Set(['bet', 'raise', 'call', 'check', 'fold', 'allin']);
const VOICES = ['male', 'male2', 'female'];
let VOICE = 'male';
try { const v = localStorage.getItem('buyin.voice'); if (VOICES.includes(v)) VOICE = v; } catch (_e) { /* */ }
const sfxPath = (name) => (VOICE !== 'male' && VOICE_ACT.has(name) ? `${VOICE}/${name}` : name);
function audio() {
    try {
        if (actx && actx.state !== 'running' && actx.state !== 'suspended') { actx.close().catch(() => {}); actx = null; }   // iOS 'interrupted' — 새로 만든다
        if (!actx) actx = new (window.AudioContext || window.webkitAudioContext)();
        if (actx.state === 'suspended') actx.resume().catch(() => {});
        return actx;
    } catch (_e) { return null; }
}
function loadSfx(name) {
    const path = sfxPath(name);
    if (!sfxBuf.has(path)) {
        sfxBuf.set(path, fetch(`${ASSET}sfx/${path}.mp3${AV}`)
            .then((r) => { if (!r.ok) throw new Error('sfx ' + r.status); return r.arrayBuffer(); })
            .then((ab) => audio().decodeAudioData(ab))   // 약속(promise) 형태만 — 콜백과 같이 쓰면 실패가 따로 새어 나간다
            // [ASSET_FALLBACK_0_10_10] 남2·여 목소리 파일이 없으면(운영 업로드 전) 기본 목소리로
            .catch(() => { sfxBuf.delete(path); return path !== name ? loadSfxBase(name) : null; }));
    }
    return sfxBuf.get(path);
}
function loadSfxBase(name) {
    if (!sfxBuf.has(name)) {
        sfxBuf.set(name, fetch(`${ASSET}sfx/${name}.mp3${AV}`).then((r) => { if (!r.ok) throw new Error('sfx ' + r.status); return r.arrayBuffer(); })
            .then((ab) => audio().decodeAudioData(ab)).catch(() => { sfxBuf.delete(name); return null; }));
    }
    return sfxBuf.get(name);
}
let preloaded = false;
function preloadSfx() { if (preloaded) return; preloaded = true; for (const n of SFX_ALL) loadSfx(n); }
/** [PRELOAD_0_10_10] 처음 그릴 때 받던 그림(칩·카드 뒷면·딜러·캐릭터)을 미리 — 첫 베팅 칩·첫 딜이 늦게 뜨지 않게 */
const imgWarm = [];
function preloadImages() {
    if (imgWarm.length) return;
    const files = [...Object.values(CHIP_FILE).map((f) => `img/${f}.webp`), 'img/card_back.jpg', 'img/dealer.png',
        ...Array.from({ length: AVATAR_COUNT }, (_, i) => `img/avatar_player_${i + 1}.webp`)];
    for (const f of files) { const im = new Image(); im.decoding = 'async'; im.src = `${ASSET}${f}${AV}`; imgWarm.push(im); }
}
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
/**
 * [SFX_ORIG_0_10_9] 액션 소리 한 번 — 같은 자리의 같은 부류(공격·올인·콜·체크·폴드)는 350ms 안에 한 번, 공격(BET/RAISE)은 700ms 안에 한 번(원본 ACTION_SFX_ONCE).
 *   내 액션은 누르는 즉시 소리를 내고(heroSfx) 엔진이 돌려준 같은 액션은 소리만 건너뛴다 — 서명·왕복을 기다리면 늦게 들렸다
 */
const sfxCls = (a) => (a === 'ALL_IN' ? 'ALLIN' : a === 'BET' || a === 'RAISE' ? 'AGGR' : a);
const sfxLast = new Map();
let aggrAt = 0;
function sfx(action, seat = -1) {
    const cls = sfxCls(action), key = seat + '|' + cls, now = Date.now();
    if (now - (sfxLast.get(key) || 0) < 350) return;
    sfxLast.set(key, now);
    if (cls === 'AGGR') { if (now - aggrAt < 700) return; aggrAt = now; }
    for (const [n, k] of ACT_SFX[action] || []) { if (!S.voiceOn && VOICE_ACT.has(n)) continue; play(n, 0.6 * (k || 1)); }   // [SETTINGS2_0_10_23] 목소리 끄면 칩 소리만
    if (action === 'CHECK' && seat >= 0 && seat === mySeat()) play('hero_check_drag_v2');
}
/** [FX_SMALL_0_10_9] 원본 족보 알약 — 0.2초 팝인, 스트레이트 이상 반짝임·맥박(스트레이트 플러시 자주, 로열 장미색) */
function rankTier(rank) {
    if (/^Royal/.test(rank)) return ' hr-royal';
    if (/^Straight Flush/.test(rank)) return ' hr-sf';
    if (/^(Four|Full|Flush|Straight)/.test(rank)) return ' hr-hi';
    return '';
}
/**
 * [MADE_GLOW_0_10_9] 원본 made-hand-vfx — 판 진행 중 내 족보가 트리플 이상이면 그 족보에 쓰인 내 홀카드에 금빛 안쪽 테두리(유지) +
 * 0.8초 유리 광택(한 번), 족보 글자 알약 0.8초 빛(한 번). 쇼다운·올인 런아웃·인 더 다크·결과 때는 없다(원본과 같다)
 */
/** [SHOW_LIFT_0_10_15] 내가 「카드 보여 주기」로 연 카드 — 살짝 위로 올라가 은은하게 빛난다(다른 사람에게 보이고 있다는 표시) */
function showLift(hole, seat) {
    const rv = S.reveal[seat], h = S.hand;
    if (!rv || !h || seat !== mySeat()) return;
    const at = (i) => hole.querySelector(`.hc[data-i="${i}"]`);   // [OM_SORT_0_10_23] 정렬해도 받은 순서 번호로
    rv.forEach((c, i) => { const x = at(i); if (c && x) { x.classList.add('shown-up'); x.style.setProperty('--su-d', animDelay(`su:${h.handId}:${i}`)); } });
}
function madeGlow(hole, rank, cards) {
    const h = S.hand;
    if (!h || !rank || S.winners || (S.sd && S.sd.handId === h.handId)) return null;
    const mh = madeHand(cards, shownBoard(), isOmaha());   // [OMAHA_0_10_23]
    if (!mh) return null;
    const key = `mg:${h.handId}:${rank}`, d = animDelay(key);
    for (const i of (isOmaha() ? mh.hole : [0, 1])) {   // 원본 madeHoleCards — 홀덤(2장)은 두 장 모두, [OMAHA_0_10_23] 오마하는 족보에 쓰인 2장만
        const c = hole.querySelector(`.hc[data-i="${i}"]`); if (!c) continue;   // [OM_SORT_0_10_23]
        c.classList.add('made-hand-card', 'made-hand-card--lit'); c.style.setProperty('--mg-d', d);
    }
    pearlFx(hole, `${h.handId}`);
    return d;   // 족보 알약은 만들 때 이 시각으로 빛(made-hand-rank)
}
/**
 * [PEARL_FX_0_10_15] 트리플 이상 — 종전 주황 불빛 대신 진주빛 VFX: 카드 둘레 진주 광택 테두리(천천히 흐르는 무지갯빛) +
 * 카드 아래에서 진주알·반짝이가 흩날리며 떠오른다. 판마다 같은 씨앗·같은 시작 시각이라 다시 그려도 끊기지 않는다(animDelay)
 */
function pearlFx(hole, key) {
    // [MADE_BURST_0_10_23] 트리플 이상이 된 순간 한 번 — 빛 번짐(bloom)·고리 + 금·흰빛 입자 26개가 사방으로 흩어진다. 다 돈 뒤엔 아무것도 남지 않는다
    //   (종전 진주 입자는 끝없이 떠올라 비눗방울처럼 보였다). 시작 시각은 animDelay — 다시 그려도 이어서, 끝났으면 그대로 끝
    const d = animDelay(`mb:${key}`);
    if (animAge(`mb:${key}`) > 2.2) return;
    const w = el('div', 'made-burst');
    w.style.setProperty('--d', d);
    w.appendChild(el('span', 'mb-bloom'));
    const ring = el('span', 'mb-ring'); w.appendChild(ring);
    let seed = 0; for (const ch of key) seed = (seed * 31 + ch.charCodeAt(0)) >>> 0;
    const rnd = () => { seed = (seed + 0x6D2B79F5) >>> 0; let t2 = seed; t2 = Math.imul(t2 ^ (t2 >>> 15), t2 | 1); t2 ^= t2 + Math.imul(t2 ^ (t2 >>> 7), t2 | 61); return ((t2 ^ (t2 >>> 14)) >>> 0) / 4294967296; };
    const n = 26, mobile = S.layout === 'mobile';
    for (let i = 0; i < n; i++) {
        const kind = i % 5 === 4 ? 's' : i % 3 === 0 ? 'w' : 'g';
        const p = el('i', kind);
        const ang = (i / n) * Math.PI * 2 + (rnd() - 0.5) * 0.5;
        const dist = (mobile ? 46 : 80) + rnd() * (mobile ? 46 : 80);
        p.style.setProperty('--tx', (Math.cos(ang) * dist).toFixed(1) + 'px');
        p.style.setProperty('--ty', (Math.sin(ang) * dist * 0.8 - 12 - rnd() * 18).toFixed(1) + 'px');
        p.style.setProperty('--sz', (kind === 's' ? 9 + rnd() * 6 : kind === 'w' ? 2 + rnd() * 2 : 3 + rnd() * 3).toFixed(1) + 'px');
        p.style.setProperty('--rot', Math.round((rnd() - 0.5) * 180) + 'deg');
        p.style.setProperty('--dur', (1.3 + rnd() * 0.6).toFixed(2) + 's');
        w.appendChild(p);
    }
    hole.appendChild(w);
}
/**
 * [SFX_ORIG_0_10_9] 족보 효과음 — 판 진행 중 내 족보가 트리플 이상이 되면 판당 한 번(원본 made-hand-fx: 쇼다운·올인 런아웃 제외)
 */
function madeHandSfx(rank) {
    const h = S.hand;
    if (!h || !rank || !S.live || S.winners || (S.sd && S.sd.handId === h.handId)) return;
    if (!/^(Royal|Straight Flush|Four|Full|Flush|Straight|Three)/.test(rank)) return;
    if (S.rankSfx === h.handId) return;
    S.rankSfx = h.handId;
    play('hand-rank');
}
/** [SFX_ORIG_0_10_9] 내 차례 알림음 — 원본처럼 내가 액션하거나 차례가 끝날 때까지 반복(loop) */
let turnSrc = null;
function startTurnSfx() {
    if (turnSrc || !S.sound || !(S.vol > 0)) return;
    const ctx = audio();
    if (!ctx || ctx.state !== 'running') return;
    const want = S.turn && S.turn.handId + ':' + S.turn.q;
    loadSfx('turn').then((b) => {
        if (!b || turnSrc || !S.turn || S.turn.seat !== mySeat() || S.turn.handId + ':' + S.turn.q !== want) return;
        const src = ctx.createBufferSource(), g = ctx.createGain();
        src.buffer = b; src.loop = true; g.gain.value = 0.6 * S.vol; src.connect(g).connect(ctx.destination); src.start();
        turnSrc = src;
    });
}
function stopTurnSfx() { if (turnSrc) { try { turnSrc.stop(); } catch (_e) { /* */ } turnSrc = null; } }

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
            if (S.hand && S.emoteHand === S.hand.handId) return toast(t('emoOnce'), 2600, 'warn');
            // [EMOTE_FAST_0_10_10] 누르는 즉시 내 자리에서 — 서버 왕복을 기다리지 않는다(거절되면 걷는다)
            showEmote({ seat: mySeat(), id }); S.emoSelf = { id, at: Date.now() };
            const r = await cmd('emote', { id });
            if (!r || !r.ok) { S.emoSelf = null; document.querySelectorAll(`.emo-fx[data-seat="${mySeat()}"]`).forEach((x) => x.remove()); return toast(rateMsg(r || {}), 2600, 'warn'); }
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
    // [EMOTE_FAST_0_10_10] 내 이모티콘은 누를 때 이미 띄웠다 — 서버에서 돌아온 같은 것은 건너뛴다
    if (d.seat === mySeat() && S.emoSelf && S.emoSelf.id === d.id && Date.now() - S.emoSelf.at < 4000) { S.emoSelf = null; return; }
    const r = avatarRect(d.seat);
    if (!r || !EMOTES.includes(d.id)) return;
    const box = el('div', 'emo-fx');
    box.dataset.emote = d.id; box.dataset.seat = d.seat;
    box.style.left = r.left + 'px'; box.style.top = r.top + 'px'; box.style.width = r.width + 'px'; box.style.height = r.height + 'px';
    // 영상이 첫 장면을 낼 때까지 그 이모티콘 그림(받아 둔 썸네일)을 먼저 — 빈 원으로 기다리지 않는다
    box.style.backgroundImage = `url('${ASSET}emo/emo_${d.id}.jpg${AV}')`;
    const pooled = emoWarm.get(d.id);
    const v = pooled && pooled.readyState >= 2 ? pooled : document.createElement('video');
    if (v === pooled) { emoWarm.delete(d.id); try { v.currentTime = 0; } catch (_e) { /* */ } setTimeout(() => warmEmote(d.id), 5000); }
    v.muted = true; v.playsInline = true; v.autoplay = true; v.setAttribute('playsinline', '');
    v.classList.add('emo-v');
    v.addEventListener('playing', () => v.classList.add('on'), { once: true });
    // [VIDEO_RELEASE_0_10_9] 0.25초 페이드아웃(원본 EmotionCircleFX) 뒤 디코더 반납
    let gone = false;
    const done = () => { if (gone) return; gone = true; box.classList.add('out'); setTimeout(() => { releaseVideo(v); box.remove(); }, 260); };
    v.onended = done;
    v.onerror = done;
    if (v !== pooled) v.src = `${ASSET}emo/emo_${d.id}.mp4${AV}`;
    box.appendChild(v);
    $('#fx').appendChild(box);
    const p = v.play(); if (p && p.catch) p.catch(() => {});
    setTimeout(done, 4500);
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
    if ((m.host ? (S.watch && m.nickname === (S.me && S.me.nickname)) : m.seat === mySeat()) || m.trTried) return;
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
    const m = { ...d, id: (d.at || Date.now()) + '-' + d.seat, rcv: Date.now() };
    S.chat.push(m);
    if (S.chat.length > 100) S.chat.shift();
    const dockOpen = !$('#chat').classList.contains('closed'), mOpen = !$('#chat-m').hidden;
    if (d.seat !== mySeat()) {
        if (!dockOpen) $('#chat .chat-head .dot').hidden = false;
        if (!mOpen) $('#btn-chat-m .dot').hidden = false;
    }
    renderChat();
    translateLine(m);
    return;   // [NO_CHAT_BUBBLE_0_10_15] 채팅 말풍선은 띄우지 않는다(운영 요청) — 채팅 창·가운데 채팅 줄에만. 아래는 예전 말풍선(쓰지 않음)
    // eslint-disable-next-line no-unreachable
    if (d.seat === mySeat()) {
        // [CHAT_SELF_0_10_9] 원본 RoomChat — 모바일은 내가 보낸 글이 채팅 버튼 옆에 4초(창을 닫아도 보낸 게 보이게)
        if (S.layout === 'mobile') {
            const r = $('#btn-chat-m').getBoundingClientRect();
            if (!r.width) return;   // [CHAT_FEED_0_10_11] 채팅 버튼 대신 테이블 가운데 채팅 창이 있으면 거기 보인다
            const b = el('div', 'chat-fx self'); b.textContent = short(d.text);
            b.style.left = (r.right + 6) + 'px'; b.style.top = (r.top + r.height / 2) + 'px';
            $('#fx').appendChild(b);
            setTimeout(() => b.remove(), 4000);
        }
        return;
    }
    const r = avatarRect(d.seat);
    if (!r) return;
    const b = el('div', 'chat-fx');
    b.dataset.id = m.id;
    b.textContent = short(m.tr || d.text);   // 글자로만 넣는다(HTML 로 해석하지 않는다)
    b.style.left = (r.left + r.width / 2) + 'px'; b.style.top = (r.top - (S.layout === 'mobile' ? 6 : 10)) + 'px';
    $('#fx').appendChild(b);
    // [CHAT_M_0_10_7] 가장자리 자리의 말풍선이 화면 밖으로 잘렸다(왼쪽 자리 앞글자가 안 보였다) — 화면 안으로 민다
    const w = b.offsetWidth, cx = r.left + r.width / 2, m8 = 6;
    if (w) b.style.left = Math.max(m8 + w / 2, Math.min(innerWidth - m8 - w / 2, cx)) + 'px';
    setTimeout(() => b.remove(), 4000);
}

/**
 * [CHAT_FEED_0_10_11] 모바일 — 테이블 가운데 아래 빈 자리(보드·BUY-IN 글자 아래, 내 카드 위)에 늘 보이는 채팅 창.
 * 최근 4줄 + 「메시지 입력」 줄. 누르면 위쪽 채팅 창(키보드와 겹치지 않는 자리, CHAT_M_0_10_7)이 열린다.
 * 새 글이 없으면 20초 뒤 흐리게(판을 가리지 않게)
 */
let feedDim = 0;
/** [GATE_CHAT_0_10_23] 대기실 채팅 줄 — 최근 5개(사라지지 않는다), 맨 아래로 */
function renderGateChat() {
    const box = $('#ready-q .rq-lines');
    if (!box) return;
    box.innerHTML = '';
    for (const m of S.chat.slice(-5)) {
        const line = el('div', 'rq-line' + (m.host ? ' host' : m.seat === mySeat() ? ' me' : ''));
        if (m.host) line.appendChild(el('i', 'host-tag', esc(t('hostTag'))));
        const n = el('b'); n.textContent = m.nickname;
        const x = el('span'); x.textContent = m.tr && m.showTr ? m.tr : (m.tr || m.text);
        line.append(n, x);
        box.appendChild(line);
    }
    box.scrollTop = box.scrollHeight;
}
function renderFeed() {
    renderGateChat();
    const box = $('#chat-feed .cf-lines');
    if (!box) return;
    box.innerHTML = '';
    // [FEED_1MIN_0_10_15] 모바일 가운데 채팅 줄은 1분 뒤 사라진다(채팅 창의 기록은 그대로). 마지막 0.6초에 흐려진다
    const FEED_MS = 60000, now = Date.now();
    const last = S.chat.filter((m) => now - (m.rcv || now) < FEED_MS).slice(-4);
    clearTimeout(S.feedExp);
    if (last.length) S.feedExp = setTimeout(renderFeed, Math.max(200, FEED_MS - (now - (last[0].rcv || now)) + 30));
    last.forEach((m, i) => {
        const line = el('div', 'cf-line' + (m.host ? ' host' : m.seat === mySeat() ? ' me' : '') + (i < last.length - 2 ? ' old' : ''));
        const n = el('b'); n.textContent = m.nickname;
        if (m.host) line.appendChild(el('i', 'host-tag', esc(t('hostTag'))));   // [WATCH_0_10_20] 방장 채팅 — 밝은 금빛
        const x = el('span'); x.textContent = m.tr && m.showTr ? m.tr : (m.tr || m.text);
        line.append(n, x);
        line.style.setProperty('--cf-out', Math.max(0, (FEED_MS - (now - (m.rcv || now))) / 1000 - 0.6).toFixed(2) + 's');
        box.appendChild(line);
    });
    const f = $('#chat-feed');
    f.classList.remove('idle');
    clearTimeout(feedDim);
    if (last.length) feedDim = setTimeout(() => f.classList.add('idle'), 20000);
}
function openChatM() { $('#chat-m').hidden = false; $('#btn-chat-m .dot').hidden = true; renderChat(); $('#chat-m .chat-input').focus(); }

function renderChat() {
    renderFeed();
    for (const box of document.querySelectorAll('#chat .chat-lines, #chat-m .chat-lines')) {
        box.innerHTML = '';
        for (const m of S.chat) {
            const line = el('div', 'chat-line' + (m.host ? ' host' : m.seat === mySeat() ? ' me' : ''));
            const n = el('b'); n.textContent = m.nickname;
            if (m.host) line.appendChild(el('i', 'host-tag', esc(t('hostTag'))));   // [WATCH_0_10_20]
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
    if (Date.now() - S.chatAt < 400) return toast(t('tooFast'), 2600, 'warn');
    S.chatAt = Date.now();
    const r = await cmd('chat', { text: text.slice(0, 200) });
    if (r.ok) { i.value = ''; i.closest('.chat-form').classList.remove('has-text'); } else toast(rateMsg(r), 2600, 'warn');
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
    box.appendChild(el('div', 'tip-head', `<b>${esc(t('tipHint'))}</b><span>${esc(dmCur(tipAmount()))}</span>`));
    const grid = el('div', 'tip-grid');
    const can = S.hand && ['preflop', 'flop', 'turn'].includes(S.hand.stage) && !S.winners;   // [TIP_TURN_0_10_11] 리버부터 막는다
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

/** [TIP_HOUSE_0_10_12] 팁 한 개 — 좌석표의 tip(원화 방 1,000원, 본사로), 없으면 예전처럼 BB */
function tipAmount() { return S.room && S.room.tip > 0 ? S.room.tip : (S.room ? S.room.bb : 0); }
async function sendTip(seat, gift) {
    const to = S.seats[seat];
    if (!to || !S.keys || !S.me || !S.room) return;
    const n = (S.me.tipN || 0) + 1;
    const sig = await V.sign(S.keys, V.msg.tip(S.tableId, S.me.odcId, n, seat, gift, tipAmount()));
    const r = await cmd('tip', { to: seat, gift, n, sig });
    if (r.ok) S.me.tipN = n;
    else if (r.code === 'rate') toast(t('tooFast'), 2600, 'warn'); else toastErr(r.error || '');
}

/**
 * [TIP_ROYAL_0_10_5] 로열 팁 VFX — 꽃(장미 한 송이)·폭죽·샴페인·시가. 키스는 종전 연출.
 *   0 ~ 1.05초  로열 아이콘이 보낸 사람 → 받는 사람으로 금빛 꼬리를 끌며 포물선 비행(실제 좌석 위치를 따라간다)
 *   1.05초 ~     받는 사람 자리에서 투명 영상(VP9 알파, 960×540, 리소스 서버 fx/tip_*.webm)을 도착 장면부터 재생
 *                — 영상 안 도착점 (0.69, 0.46) 을 받는 사람 아바타 중심에 맞춘다(화면 밖으로 나가면 안쪽으로 민다)
 *   효과음(sfx/tip_*.mp3)은 0초부터 — 영상 시간표(코르크·따르기·축포·점화)와 그대로 맞는다
 *   연출일 뿐 — 칩·서명·금액과 무관하다(팁 자체는 sendTip/TableServer._tip). 영상이 안 되면 아이콘 연출로 끝난다.
 */
/* [TIP_CENTER_0_10_7] c = 도착 뒤 연출의 실제 중심, box = 도착 뒤 연출이 그려지는 영역(영상 비율) — 영상 알파에서 잰 값.
   연출 중심(c)을 받는 사람 프로필 원 중앙에 맞춘다(종전: 머리 위 공중 — 누구에게 보냈는지 애매했다) */
const ROYAL = {
    flower: { ms: 4800, c: [0.70, 0.47], box: [0.58, 0.27, 0.79, 0.65] },
    confetti: { ms: 5200, c: [0.69, 0.42], box: [0.47, 0.18, 0.91, 0.63] },
    champagne: { ms: 6800, c: [0.68, 0.40], box: [0.47, 0.12, 0.82, 0.64] },
    cigarette: { ms: 6200, c: [0.69, 0.47], box: [0.54, 0.29, 0.83, 0.70] },
};
const ROYAL_ARRIVE = 1.05;               // 영상 속 전달 구간(초) — 이 뒤부터 받는 자리에서 재생
const ROYAL_TO = { x: 0.69, y: 0.46 };   // 영상 속 도착점(화면 비율)
const royalVid = new Map();
/**
 * [TIP_WEBP_0_10_7] 아이폰(iOS 의 모든 브라우저)·맥 사파리는 투명 WebM(VP9 알파)을 못 튼다 — 종전에는 영상 대신 도착 섬광만 보이고 끝났다.
 *   그 브라우저는 같은 장면을 도착 뒤부터 자른 투명 애니메이션 WebP(fx/tip_*.webp, 720×406·20fps·한 번 재생)로 보여 준다.
 *   다른 브라우저도 영상이 안 되면 WebP 로 물러선다. 움직이는 그림은 같은 주소면 처음부터 다시 돌지 않으므로 팁마다 새 주소(&n=)를 미리 받아 둔다
 */
const ua = navigator.userAgent || '';
const NO_ALPHA_WEBM = /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1)
    || (/Safari\//.test(ua) && !/Chrome|Chromium|CriOS|Edg|OPR|Firefox|FxiOS|SamsungBrowser/.test(ua));
const royalImg = new Map();
let royalImgN = 0;
function preloadRoyalImg(id) {
    const im = new Image();
    im.decoding = 'async'; im.alt = '';
    im.src = `${ASSET}fx/tip_${id}.webp${AV}&n=${Date.now().toString(36)}${++royalImgN}`;
    royalImg.set(id, im);
    return im;
}
function takeRoyalImg(id) {
    const im = royalImg.get(id) || preloadRoyalImg(id);
    setTimeout(() => preloadRoyalImg(id), 8000);   // 다음 팁용 — 이번 연출이 끝난 뒤 받는다
    royalImg.delete(id);
    return im;
}
/** 영상을 미리 받아 둔다 — 처음 팁에서 기다리지 않게(판에 앉은 뒤 조용할 때 한 번) */
function preloadRoyal() {
    for (const id of Object.keys(ROYAL)) {
        if (NO_ALPHA_WEBM) { if (!royalImg.has(id)) preloadRoyalImg(id); continue; }
        if (royalVid.has(id)) continue;
        const v = document.createElement('video');
        v.muted = true; v.playsInline = true; v.preload = 'auto'; v.setAttribute('playsinline', '');
        v.src = `${ASSET}fx/tip_${id}.webm${AV}`;
        royalVid.set(id, v);
    }
}

function flushTips() {
    const q = S.tipQ.splice(0);
    q.forEach((d, i) => setTimeout(() => flyGift(d.from, d.to, d.type, d.amount), i * 700));
}
function flyGift(from, to, gift, amount) {
    const a = avatarRect(from), b = avatarRect(to);
    if (!a || !b || !GIFTS.includes(gift)) return;
    const badge = () => (S.room && S.room.tip > 0 ? (from === mySeat() ? tipBadge(from, amount != null ? amount : tipAmount(), t('tipQueued'), '-') : null) : tipBadge(to, amount != null ? amount : tipAmount(), t('tipQueued')));   // [TIP_HOUSE_0_10_12]
    const reduce = window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (ROYAL[gift] && S.live && !document.hidden && !reduce) return royalTip(a, b, gift, badge);   // 금액 딱지는 연출이 끝난 뒤(병·꽃을 가리지 않게)
    setTimeout(badge, 1100);
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
}

function royalTip(a, b, gift, after) {
    const fx = $('#fx');
    const mobile = S.layout === 'mobile';
    /* [TIP_BIG_0_10_7] 연출 크기 — 종전(폭 0.64)은 소품이 아바타 크기로 묻혔다.
       [TIP_CENTER_0_10_7] 0.10.7 첫 안(PC ×0.95·모바일 ×1.9)에서 30% 줄이고(운영 요청), 연출 중심을 받는 사람 프로필 원 중앙에 맞춘다.
       연출 영역이 화면 밖으로 나가면 안쪽으로 민다. 날아가는 아이콘은 영상 속 도착점(ROYAL_TO)으로 — 영상 소품과 이어지게 */
    const R = ROYAL[gift];
    // [TIP_AVATAR_0_10_10] 영상 폭 = 받는 사람 아바타 지름 × 5.2 — 소품(샴페인·장미…)이 아바타의 약 1~2배(운영 요청: PC 는 아직 커서 프로필 크기에 맞게).
    //   종전 화면 폭 기준(PC ×0.665 = 1064px)은 PC 에서 아바타의 약 3배였다. 화면이 아주 작으면 화면 폭 1.4배를 넘지 않게
    const W = Math.max(220, Math.min(b.width * 5.2, innerWidth * 1.4));
    const H = W * 540 / 960;
    const cx1 = b.left + b.width / 2, cy1 = b.top + b.height / 2;   // 프로필 원 중앙
    let left = cx1 - R.c[0] * W, top = cy1 - R.c[1] * H;
    const pad = 6;
    left += Math.max(0, pad - (left + R.box[0] * W)) - Math.max(0, left + R.box[2] * W - (innerWidth - pad));
    top += Math.max(0, pad - (top + R.box[1] * H)) - Math.max(0, top + R.box[3] * H - (innerHeight - pad));
    const x0 = a.left + a.width / 2, y0 = a.top + a.height / 2, x1 = left + ROYAL_TO.x * W, y1 = top + ROYAL_TO.y * H;
    const arrive = ROYAL_ARRIVE * 1000;
    play('tip_' + gift, 0.8);

    // 1) 비행 — 로열 아이콘 + 금빛 꼬리(점점 작아지는 불티) + 도착 섬광
    const size = Math.round(b.width * 0.72);   // [TIP_AVATAR_0_10_10] 날아가는 아이콘도 아바타 크기 기준(영상 속 소품과 맞춘다)
    const lift = Math.max(70, Math.hypot(x1 - x0, y1 - y0) * 0.35);
    const cx = (x0 + x1) / 2, cy = Math.min(y0, y1) - lift;
    const pt = (k) => ({ x: (1 - k) * (1 - k) * x0 + 2 * (1 - k) * k * cx + k * k * x1, y: (1 - k) * (1 - k) * y0 + 2 * (1 - k) * k * cy + k * k * y1 });
    const ico = el('div', 'royal-ico', `<img alt="" src="${ASSET}tip/${gift}.png${AV}">`);
    ico.style.width = ico.style.height = size + 'px';
    fx.appendChild(ico);
    const frames = [];
    for (let i = 0; i <= 12; i++) {
        const k = i / 12, p = pt(k);
        frames.push({ transform: `translate(${p.x - size / 2}px, ${p.y - size / 2}px) rotate(${(1 - k) * -14}deg) scale(${0.55 + 0.6 * Math.sin(Math.PI * k) + 0.35 * k})`, opacity: k < 0.08 ? k / 0.08 : 1, offset: k });
    }
    ico.animate(frames, { duration: arrive, easing: 'cubic-bezier(.45,.05,.35,1)', fill: 'forwards' });
    const trail = setInterval(() => {
        const r = ico.getBoundingClientRect();
        const s = el('i', 'royal-spark');
        s.style.left = (r.left + r.width / 2 + (Math.random() - 0.5) * size * 0.4) + 'px';
        s.style.top = (r.top + r.height / 2 + (Math.random() - 0.5) * size * 0.4) + 'px';
        s.style.setProperty('--d', (6 + Math.random() * 8).toFixed(1) + 'px');
        fx.appendChild(s);
        setTimeout(() => s.remove(), 900);
    }, 28);

    // 2) 영상 — 도착 장면부터, 받는 사람 머리 위에(자리·크기는 위에서 정했다)
    const wrap = el('div', 'royal-vfx');
    wrap.style.cssText = `left:${left}px;top:${top}px;width:${W}px;height:${H}px`;
    let done = false;
    const end = () => {
        if (done) return; done = true;
        clearInterval(trail);
        if (after) after();
        wrap.classList.add('out');
        setTimeout(() => { releaseVideo(wrap.querySelector('video')); wrap.remove(); }, 450);   // [VIDEO_RELEASE_0_10_9]
    };
    /** [TIP_WEBP_0_10_7] 움직이는 WebP — 도착 장면부터 잘라 둔 그림이라 붙이는 순간부터 돈다 */
    const showImg = () => {
        const im = takeRoyalImg(gift);
        wrap.innerHTML = ''; wrap.appendChild(im);
        if (!wrap.isConnected) fx.appendChild(wrap);
        im.addEventListener('error', () => end(), { once: true });
        setTimeout(end, ROYAL[gift].ms - arrive + 300);
    };
    if (NO_ALPHA_WEBM) {
        setTimeout(() => {
            clearInterval(trail);
            ico.remove();
            const burst = el('div', 'royal-land'); burst.style.left = x1 + 'px'; burst.style.top = y1 + 'px';
            fx.appendChild(burst); setTimeout(() => burst.remove(), 1000);
            showImg();
        }, arrive);
        return;
    }
    const src = royalVid.get(gift);
    const v = document.createElement('video');
    v.muted = true; v.playsInline = true; v.preload = 'auto'; v.setAttribute('playsinline', '');
    v.src = src ? src.currentSrc || src.src : `${ASSET}fx/tip_${gift}.webm${AV}`;
    wrap.appendChild(v);
    const ready = new Promise((res) => {
        const seek = () => { try { v.currentTime = ROYAL_ARRIVE; } catch (_e) { /* */ } };
        if (v.readyState >= 1) seek(); else v.addEventListener('loadedmetadata', seek, { once: true });
        v.addEventListener('seeked', () => res(true), { once: true });
        v.addEventListener('error', () => res(false), { once: true });
        setTimeout(() => res(v.readyState >= 2), arrive + 1500);
    });

    setTimeout(async () => {
        clearInterval(trail);
        ico.remove();
        const burst = el('div', 'royal-land'); burst.style.left = x1 + 'px'; burst.style.top = y1 + 'px';
        fx.appendChild(burst); setTimeout(() => burst.remove(), 1000);
        const ok = await ready;
        if (!ok) { showImg(); return; }   // [TIP_WEBP_0_10_7] 영상을 못 받으면 같은 장면의 움직이는 WebP 로(종전: 도착 섬광으로 끝)
        fx.appendChild(wrap);
        v.play().catch(() => showImg());
        v.addEventListener('ended', end, { once: true });
        setTimeout(end, ROYAL[gift].ms - arrive + 400);   // 영상 끝 투명 여백 — 늦어도 이 시각에 걷는다
    }, arrive);
}

function tipBadge(seat, amount, status, sign = '+') {
    const r = avatarRect(seat);
    if (!r) return;
    const b = el('div', 'tip-badge', `<b>${sign}${esc(dm(amount))}</b><small>${esc(status)}</small>`);
    b.style.left = (r.left + r.width / 2) + 'px'; b.style.top = (r.top - 26) + 'px';   // 말풍선(베팅 표시) 위로
    $('#fx').appendChild(b);
    setTimeout(() => b.remove(), 3100);
}

// ------------------------------------------------------------ 인 더 다크 (다음 판 내 패를 보지 않고 친다 — 한 판짜리 예약)

async function toggleDark() {
    const r = await cmd('dark', { on: !S.darkNext });
    if (r.ok) { S.darkNext = !!r.reserved; paintDark(); render(); } else toastErr(r.error || '');
}
function paintDark() {
    const b = $('#btn-dark');
    b.classList.toggle('on', S.darkNext);
    $('.dk-sub').textContent = S.darkNext ? t('darkOn') : t('darkSub');
}
/**
 * [PROFILE_STATS_0_10_11] 프로필 창 — 이 자리에 들어온 바이인(개수·금액 합계)과 지금 손익(스택 − 바이인 합계).
 * 엔진이 공개한 좌석 정보(좌석표 금액·스택)로 계산만 한다 — 스택은 실시간이라 이번 판에 건 칩은 빠진 값
 */
let pfTimer = 0;
function openProfile(seat, av) {
    const s = S.seats && S.seats[seat];
    const box = $('#pf-pop');
    if (!s || !box) return;
    if (!box.hidden && box.dataset.seat === String(seat)) { closeProfile(); return; }
    const amt = s.biAmt || 0, net = Math.round(((s.stack || 0) - amt) * 1000) / 1000;
    const sign = net > 0 ? '+' : net < 0 ? '−' : '';
    box.innerHTML = `<div class="pf-name">${esc(s.nickname || '')}</div>`
        + `<div class="pf-row"><span>${esc(t('pfBuyIn'))}</span><b>${s.bi > 0 ? esc(tn('pfBuyInN', s.bi)) + ' · ' : ''}${esc(dmCur(amt))}</b></div>`
        + `<div class="pf-row"><span>${esc(t('pfNet'))}</span><b class="${net < 0 ? 'neg' : net > 0 ? 'pos' : ''}">${sign}${esc(dmCur(Math.abs(net)))}</b></div>`
        + `<div class="pf-note">${esc(t('pfNote'))}</div>`
        // [AWAY_PF_0_10_18] 내 프로필에 자리 비움 / 돌아왔어요
        + (seat === mySeat() && !s.leaving && !(s.busted && s.rebuy !== 'done') && !s.held
            ? `<button type="button" class="pf-away${s.sitout ? ' on' : ''}" data-testid="pf-away">${SVG_AWAY}<span>${esc(s.sitout ? t('awayBack') : t('awayBtn'))}</span></button>` : '');
    box.dataset.seat = String(seat);
    const pa = box.querySelector('.pf-away');
    if (pa) pa.onclick = async (e) => {
        e.stopPropagation(); closeProfile();
        if (s.sitout) { const r = await cmd('back'); if (r && !r.ok) toastErr(r.error || ''); }
        else askAway();
    };
    box.hidden = false;
    const r = av.getBoundingClientRect(), bw = box.offsetWidth, bh = box.offsetHeight;
    let x = r.left + r.width / 2 - bw / 2, y = r.top - bh - 8;
    if (y < 6) y = r.bottom + 8;
    x = Math.max(6, Math.min(innerWidth - bw - 6, x)); y = Math.max(6, Math.min(innerHeight - bh - 6, y));
    box.style.left = x + 'px'; box.style.top = y + 'px';
    clearTimeout(pfTimer); pfTimer = setTimeout(closeProfile, 6000);
}
function closeProfile() { const b = $('#pf-pop'); if (b) b.hidden = true; clearTimeout(pfTimer); }

/** [DARK_PEEK_0_10_11] 다크 판에서 내 카드를 연다 — 뒷면에서 앞면으로 뒤집으며(받을 때와 같은 연출) */
function darkOpen(hid) {
    if (S.darkHand !== hid) return;
    S.darkHand = '';
    const hk = `h:${hid}`;
    S.anim[hk] = Date.now() - 300;
    delete S.anim[hk + ':0']; delete S.anim[hk + ':1'];
}
let peeking = false;
async function peekDark(e) {
    if (e) e.stopPropagation();
    if (peeking || !inDark() || !S.hand || S.hand.stage === 'preflop') return;
    peeking = true;
    const hid = S.hand.handId;
    try {
        const r = await cmd('peek');
        if (r.ok) { darkOpen(hid); if (S.hand) S.hand.dark = (S.hand.dark || []).filter((x) => x !== mySeat()); render(); }
        else toastErr(r.error || '');
    } finally { peeking = false; }
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

/**
 * [WINNER_SD_VFX_0_10_9] SHOW DOWN 연출 — 원본 ShowdownVFX 그대로(fx.css): SHOW·DOWN 이 위아래에서 날아와 가운데서 부딪히고
 * 오라·후광·충격 코어·금빛 구슬(PC 48 / 모바일 16~24), 3초. 원본처럼 늘 깔아 두고(opacity 0) 그림을 미리 decode 해 둔 뒤 클래스만 켠다.
 * 종전 TEE 화면: 검은 띠 + 「SHOWDOWN」 글자 + 두 그림 나란히, 4초.
 */
const SHOWDOWN_MS = 3000;
let sdRoot = null, sdTimer = null;
function pearlBudget() {
    const w = innerWidth, coarse = matchMedia('(pointer: coarse)').matches || matchMedia('(max-width: 640px)').matches;
    if (!coarse && w >= 900) return 48;
    if (coarse && w <= 390) return 16;
    return coarse ? 24 : 40;
}
function mountShowdownFx() {
    if (sdRoot) return sdRoot;
    sdRoot = el('div', 'showdown-vfx'); sdRoot.setAttribute('aria-hidden', 'true');
    const n = pearlBudget();
    let pearls = '';
    for (let i = 0; i < n; i++) {
        const a = (i / n) * Math.PI * 2, rx = 11 + ((i * 17) % 27), ry = 7 + ((i * 13) % 20);
        pearls += `<i style="--x:${(50 + Math.cos(a) * rx).toFixed(2)}%;--y:${(52 + Math.sin(a) * ry).toFixed(2)}%;--drift-x:${-42 + ((i * 29) % 84)}px;--drift-y:${-28 - ((i * 31) % 96)}px;`
            + `--delay:${(0.62 + (i % 9) * 0.035).toFixed(3)}s;--duration:${(1.65 + (i % 6) * 0.08).toFixed(2)}s;--size:${2 + (i % 5)}px"></i>`;
    }
    sdRoot.innerHTML = '<div class="showdown-vfx__stage"><div class="showdown-vfx__center-aura"></div><div class="showdown-vfx__gold-halo"><i></i></div>'
        + '<div class="showdown-vfx__impact-core"></div><div class="showdown-vfx__title-glow"></div><div class="showdown-vfx__title-lockup">'
        + `<img class="showdown-vfx__image showdown-vfx__image--show" alt="" draggable="false" decoding="async" src="${ASSET}fx/show.webp${AV}">`
        + `<img class="showdown-vfx__image showdown-vfx__image--down" alt="" draggable="false" decoding="async" src="${ASSET}fx/down.webp${AV}">`
        + `</div><div class="showdown-vfx__gold-pearl-field">${pearls}</div></div>`;
    document.body.appendChild(sdRoot);
    sdRoot.querySelectorAll('img').forEach((im) => { if (im.decode) im.decode().catch(() => {}); });
    return sdRoot;
}
function playShowdownFx() {
    if (!S.live || document.hidden) return;
    const r = mountShowdownFx();
    r.classList.remove('showdown-vfx--playing');
    clearTimeout(sdTimer);
    requestAnimationFrame(() => requestAnimationFrame(() => r.classList.add('showdown-vfx--playing')));
    sdTimer = setTimeout(() => r.classList.remove('showdown-vfx--playing'), SHOWDOWN_MS);
}

/**
 * [WINNER_SD_VFX_0_10_9] 승자 WINNER 연출 — 원본 WinnerVFX 그대로(fx.css): 폭발 빛 → 회전 광선 → 충격파 3겹 → 문장 보석 → 양 날개 →
 * 「WINNER」 글자가 하나씩 내려앉고 밑줄 → 금가루 34개 → 바닥 빛. 원본처럼 440px(모바일 264px) 판을 아바타 크기에 맞춰 줄여 아바타 위에 띄운다.
 * 판당 한 번, 경합 쇼다운에서 넣은 칩보다 많이 딴 승자만(폴드승 제외 — 원본). 칩이 날아간 뒤(0.6초).
 */
const WINNER_DUST = Array.from({ length: 34 }, (_, i) => `<i style="--x:${8 + ((i * 37) % 84)}%;--y:${28 + ((i * 23) % 48)}%;--delay:${(0.75 + (i % 9) * 0.065).toFixed(3)}s;--size:${2 + (i % 4)}px;--travel:${-95 - (i % 7) * 24}px"></i>`).join('');
function winnerVfx(seat, handName, variant = 'main') {
    if (!S.live || document.hidden) return;
    const r = avatarRect(seat);
    if (!r) return;
    const mobile = S.layout === 'mobile';
    const base = mobile ? 264 : 440, k = (mobile ? 0.4 : 0.25) * (r.width / (mobile ? 77 : 122));
    const box = el('div', 'winner-fx-anchor');
    // [WINNER_CENTER_0_10_10] 좌우 가운데 = 그 자리 프로필(아바타 + 이름 상자) 묶음의 가운데. 종전엔 원본 화면 보정(+아바타 12~13%)을
    //   그대로 옮겨 오른쪽으로 밀렸다
    const nb = document.querySelector(`#seats .seat[data-seat="${seat}"] .namebox`);
    const nr = nb ? nb.getBoundingClientRect() : null;
    const cxL = Math.min(r.left, nr ? nr.left : r.left), cxR = Math.max(r.right, nr ? nr.right : r.right);
    box.style.left = ((cxL + cxR) / 2) + 'px';
    box.style.top = (r.top + r.height / 2 + r.height * 0.26) + 'px';
    const title = variant === 'side' ? 'SIDE' : variant === 'uncalled' ? 'UNCALLED' : 'WINNER';
    const loc = seat !== mySeat() && localHand(handName, getLang()) !== String(handName || '').trim();   // [HAND_I18N_0_10_12]
    const sub = variant === 'side' ? 'SIDE POT' : variant === 'uncalled' ? 'UNCALLED POT' : (loc ? localHand(handName, getLang()) : winHandLabel(handName));
    box.innerHTML = `<div class="winner-fx-scale" style="width:${base}px;transform:translate(-50%,-50%) scale(${k.toFixed(3)})">`
        + `<section class="winner-vfx winner-vfx--overlay winner-vfx--${variant}"><div class="winner-vfx__sequence">`
        + '<div class="winner-vfx__burst"></div><div class="winner-vfx__rays"></div><div class="winner-vfx__shockwaves"><i></i><i></i><i></i></div>'
        + '<div class="winner-vfx__crest"><span class="winner-vfx__crest-gem"></span><span class="winner-vfx__crest-line winner-vfx__crest-line--left"></span><span class="winner-vfx__crest-line winner-vfx__crest-line--right"></span></div>'
        + '<div class="winner-vfx__wings"><div class="winner-vfx__wing winner-vfx__wing--left"><i></i><i></i><i></i></div><div class="winner-vfx__wing winner-vfx__wing--right"><i></i><i></i><i></i></div></div>'
        + `<div class="winner-vfx__lockup">${sub ? `<p class="winner-vfx__hand">${esc(sub)}</p>` : ''}<h2 class="winner-vfx__title" aria-label="${title}">`
        + title.split('').map((c, i) => `<span style="--letter:${i}">${c}</span>`).join('') + '</h2><span class="winner-vfx__underline"><i></i></span></div>'
        + `<div class="winner-vfx__dust">${WINNER_DUST}</div><div class="winner-vfx__floor-glow"></div></div></section></div>`;
    $('#fx').appendChild(box);
    setTimeout(() => { box.classList.add('out'); setTimeout(() => box.remove(), 400); }, 3300);
}
/** 원본 winningHandName — 「A FLUSH」, 「10,7 TWO PAIR」 처럼 숫자 + 족보 */
function winHandLabel(desc) {
    const v = String(desc || '').trim();
    if (!v) return '';
    const L = [[/royal/i, 'ROYAL FLUSH'], [/straight\s*flush/i, 'STRAIGHT FLUSH'], [/four\s*of\s*a\s*kind/i, 'FOUR OF A KIND'], [/full\s*house/i, 'FULL HOUSE'],
        [/\bflush\b/i, 'FLUSH'], [/\bstraight\b/i, 'STRAIGHT'], [/three\s*of\s*a\s*kind/i, 'THREE OF A KIND'], [/two\s*pair/i, 'TWO PAIR'], [/pair/i, 'ONE PAIR'], [/high\s*card/i, 'HIGH CARD']];
    const label = (L.find(([re]) => re.test(v)) || [])[1] || '';
    if (!label) return '';
    const W = { ace: 'A', king: 'K', queen: 'Q', jack: 'J', ten: '10', nine: '9', eight: '8', seven: '7', six: '6', five: '5', four: '4', three: '3', two: '2' };
    const c = v.indexOf(','), src = c >= 0 ? v.slice(c + 1) : v;
    const toks = [];
    for (let w of src.split(/[\s,&]+/)) {
        w = w.replace(/[,.]$/, '').replace(/'s$/i, '').replace(/s$/i, '');
        const tk = /^(A|K|Q|J|10|[2-9])$/i.test(w) ? w.toUpperCase() : (W[w.toLowerCase()] || '');
        if (tk && !toks.includes(tk)) toks.push(tk);
    }
    if (label === 'ROYAL FLUSH' || !toks.length) return label;
    return `${label === 'TWO PAIR' || label === 'FULL HOUSE' ? toks.slice(0, 2).join(',') : toks[0]} ${label}`;
}

/**
 * [ITD_ORIG_0_10_9] 인 더 다크 판 시작 — 원본 InTheDarkBurst: 충격파 2겹(0.55→2.6배, 1.1초) + 금빛 광선 12줄 + 「IN THE DARK」 글자(1.9배에서 내려앉기, 2.1초)
 */
function darkBurst(seat) {
    const r = avatarRect(seat);
    if (!r || document.hidden) return;
    const b = el('div', 'itd-burst itd-burst--fx');
    b.style.left = r.left + 'px'; b.style.top = r.top + 'px'; b.style.width = r.width + 'px'; b.style.height = r.height + 'px';
    b.innerHTML = '<div class="itd-burst__wave"></div><div class="itd-burst__wave d2"></div>'
        + Array.from({ length: 12 }, (_, i) => `<div class="itd-burst__ray" style="--rot:${i * 30}deg;--d:${(0.05 + (i % 3) * 0.05).toFixed(2)}s"></div>`).join('')
        + '<div class="itd-burst__title">IN THE DARK</div>';
    $('#fx').appendChild(b);
    setTimeout(() => { b.classList.add('out'); setTimeout(() => b.remove(), 420); }, 2300);
}

/**
 * [FX_SMALL_0_10_9] 전체 화면 꽃가루 — 원본 WinEffect(canvas-confetti: 가운데 50개 + 좌우에서 0.5초 간격 2초).
 * 외부 라이브러리 금지라 canvas 에 직접 그린다
 */
function confetti() {
    if (!S.live || document.hidden || (window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches)) return;
    const cv = document.createElement('canvas'); cv.className = 'confetti-fx';
    const dpr = Math.min(2, devicePixelRatio || 1); cv.width = innerWidth * dpr; cv.height = innerHeight * dpr;
    document.body.appendChild(cv);
    const ctx = cv.getContext('2d'); ctx.scale(dpr, dpr);
    const COL = ['#fbbf24', '#f59e0b', '#fde68a', '#ef4444', '#3b82f6', '#22c55e', '#ffffff', '#a855f7'];
    const parts = [];
    const burst = (x, y, n, ang, spread, speed) => {
        for (let i = 0; i < n; i++) {
            const a = (ang + (Math.random() - 0.5) * spread) * Math.PI / 180, v = speed * (0.6 + Math.random() * 0.6);
            parts.push({ x, y, vx: Math.cos(a) * v, vy: -Math.sin(a) * v, w: 6 + Math.random() * 6, h: 4 + Math.random() * 4, r: Math.random() * 6, vr: (Math.random() - 0.5) * 0.4, c: COL[(Math.random() * COL.length) | 0], life: 0 });
        }
    };
    burst(innerWidth / 2, innerHeight * 0.6, 50, 90, 70, 13);
    let side = 0;
    const sides = setInterval(() => { burst(0, innerHeight * 0.65, 18, 60, 55, 14); burst(innerWidth, innerHeight * 0.65, 18, 120, 55, 14); if (++side >= 4) clearInterval(sides); }, 500);
    const t0 = performance.now();
    const step = (now) => {
        ctx.clearRect(0, 0, innerWidth, innerHeight);
        for (const p of parts) {
            p.life++; p.vy += 0.28; p.vx *= 0.985; p.vy *= 0.985; p.x += p.vx; p.y += p.vy; p.r += p.vr;
            ctx.save(); ctx.translate(p.x, p.y); ctx.rotate(p.r); ctx.globalAlpha = Math.max(0, 1 - p.life / 160);
            ctx.fillStyle = p.c; ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h * Math.abs(Math.cos(p.r * 2))); ctx.restore();
        }
        if (now - t0 < 4200) requestAnimationFrame(step); else { clearInterval(sides); cv.remove(); }
    };
    requestAnimationFrame(step);
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
    const now0 = Date.now();
    const rounds = holeN(), gap = rounds > 2 ? 70 : 110;   // [OM_BACKS_0_10_23] 오마하는 4·5바퀴 — 간격을 줄여 전체 시간이 길어지지 않게
    for (let round = 0; round < rounds; round++) {
        for (const seat of seq) {
            const delay = (i++) * gap;
            // [DEAL_ORIG_0_10_9] 원본 FlyingCards — 실제 카드는 비행이 끝나기 0.13초 전에 나타난다(미리 보이지 않게)
            if (seat !== mySeat()) S.anim[`dl:${h.handId}:${seat}:${round}`] = now0 + delay + 620 - 130;
            else {   // [HERO_DEAL_FLIP_0_10_10] 내 카드 — 비행이 도착할 때 뒷면으로 나타나고, 두 장이 다 오면 뒤집는다
                S.anim[`dlh:${h.handId}:${round}`] = now0 + delay + 620 - 130;
                if (round === rounds - 1) S.heroFlipAt = now0 + delay + 620 + 250;
            }
            setTimeout(() => {
                // [DEAL_ORIG_0_10_9] 목적지 = 그 자리의 실제 카드(round 번째 장) — 종전엔 아바타 가운데
                const card = document.querySelector(`#seats .seat[data-seat="${seat}"] .mini .mc:nth-child(${round + 1})`)
                    || (seat === mySeat() ? document.querySelectorAll('#seats .seat.hero .hole .hc, #seats .seat.hero .hole .flip')[round] : null);
                const r = card ? card.getBoundingClientRect() : avatarRect(seat);
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
    renderSeats();   // [DEAL_ORIG_0_10_9] 방금 정한 도착 시각으로 상대 카드를 숨겨 다시 그린다
}

/** [DEAL_ORIG_0_10_9] 상대 뒷면 카드 — 딜 비행이 도착할 때 나타난다(그 전엔 숨김). 다시 그려도 같은 시각 기준 */
function dealIn(w, seat, k) {
    if (!S.hand) return;
    const key = `dl:${S.hand.handId}:${seat}:${k}`;
    if (!(key in S.anim) || Date.now() - S.anim[key] > 400) return;
    w.classList.add('dl'); w.style.animationDelay = animDelay(key);
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
    // [OMAHA_0_10_23] 오마하 방 표시(왼쪽 위) + 처음 한 번 규칙 안내(내 카드 2장 + 바닥 3장, 팟 리밋)
    const gt = $('#game-tag'), gl = gameLabel();
    gt.hidden = !gl;
    if (gl) {
        gt.textContent = gl; gt.title = t('omahaHint');
        if (!S.omahaHinted) { S.omahaHinted = true; toast(t('omahaHint'), 5200); }
    }
}

/** 타임뱅크 — 내 차례에, 한 차례에 한 장, 남은 장수가 있을 때만 보인다 */
const TB_CHIP_SVG = '<svg class="tbc" viewBox="0 0 100 100" aria-hidden="true"><circle cx="50" cy="50" r="49" class="rim"/><g class="inl"><rect x="45" y="1.8" width="10" height="12.5" rx="2.6" transform="rotate(0 50 50)"/><rect x="45" y="1.8" width="10" height="12.5" rx="2.6" transform="rotate(60 50 50)"/><rect x="45" y="1.8" width="10" height="12.5" rx="2.6" transform="rotate(120 50 50)"/><rect x="45" y="1.8" width="10" height="12.5" rx="2.6" transform="rotate(180 50 50)"/><rect x="45" y="1.8" width="10" height="12.5" rx="2.6" transform="rotate(240 50 50)"/><rect x="45" y="1.8" width="10" height="12.5" rx="2.6" transform="rotate(300 50 50)"/></g><circle cx="50" cy="50" r="48.2" class="rimline"/><circle cx="50" cy="50" r="36.2" class="ring"/><circle cx="50" cy="50" r="34.6" class="face"/><g class="tick"><line x1="50.00" y1="20.40" x2="50.00" y2="17.60" class=\"mj\"/><line x1="64.80" y1="24.37" x2="66.20" y2="21.94"/><line x1="75.63" y1="35.20" x2="78.06" y2="33.80"/><line x1="79.60" y1="50.00" x2="82.40" y2="50.00" class=\"mj\"/><line x1="75.63" y1="64.80" x2="78.06" y2="66.20"/><line x1="64.80" y1="75.63" x2="66.20" y2="78.06"/><line x1="50.00" y1="79.60" x2="50.00" y2="82.40" class=\"mj\"/><line x1="35.20" y1="75.63" x2="33.80" y2="78.06"/><line x1="24.37" y1="64.80" x2="21.94" y2="66.20"/><line x1="20.40" y1="50.00" x2="17.60" y2="50.00" class=\"mj\"/><line x1="24.37" y1="35.20" x2="21.94" y2="33.80"/><line x1="35.20" y1="24.37" x2="33.80" y2="21.94"/></g><text x="50" y="55.5" class="v">+20</text><text x="50" y="66.5" class="u">SEC</text></svg>';
function timeBankButton(parent, x, y, size = '') {
    const tr = S.turn;
    if (!S.me || !(S.me.timeBank > 0) || !tr || tr.seat !== mySeat()) return;
    const key = tr.handId + ':' + tr.q;
    if (S.tbUsed === key) return;
    // [TB_CHIP2_0_10_23] 타임 칩 — 고급 카지노 칩 한 장(운영 요청 「난잡하다 → 깔끔하게, 타임칩 느낌 정확히」).
    //   짙은 남흑 테두리 + 아이보리 인레이 6 · 얇은 금 링 · 안쪽 시계 눈금 12 · 금빛 +20 / SEC · 남은 장수는 금 테 작은 배지.
    //   움직임은 나타날 때 한 번 + 4.5초마다 은은한 광택 한 번뿐(종전: 빛 회전·빛 숨쉬기·떠다님·점선·모래시계가 한꺼번에)
    const b = el('button', 'tb tbchip' + (size ? ' ' + size : ''), `${TB_CHIP_SVG}<i class="tbc-shine"></i><span class="tb-n">×${S.me.timeBank}</span>`);
    b.type = 'button'; b.dataset.testid = 'timebank'; b.title = t('timeBank');
    b.style.left = x + 'px'; b.style.top = y + 'px';
    b.onclick = async (e) => {
        e.stopPropagation();
        S.tbUsed = key; b.remove();
        const r = await cmd('timebank');
        if (!r.ok) { S.tbUsed = ''; toastErr(r.error || ''); render(); }
    };
    parent.appendChild(b);
}

// ------------------------------------------------------------ 준비 대기실 · 게임 시간 [READY_SESSION_0_10_6]

/**
 * 준비 게이트 — 앉은 회원이 모두 「준비 완료」를 눌러야 TEE 가 첫 판을 연다. 게임 시간이 끝나 마지막 3판을 다 치거나
 * 칠 사람이 2명 아래로 줄면 다시 열린다(아무도 내보내지 않는다). 결과 연출 중이면 delayMs 뒤에 띄운다.
 */
function onGate(d) {
    if (d.serverNow) S.skew = d.serverNow - Date.now();
    const was = gateOpen();
    S.gate = d;
    if (!d.active) { S.gateShowAt = 0; S.gateEnded = false; renderGate(); return; }
    if (!was && d.delayMs > 0) {
        S.gateShowAt = Date.now() + d.delayMs;
        setTimeout(() => { renderGate(); render(); }, d.delayMs + 30);
    } else if (!was) S.gateShowAt = 0;
    renderGate();
}

function gateOpen() { return !!(S.gate && S.gate.active); }

function onSession(d) {
    if (d.serverNow) S.skew = d.serverNow - Date.now();
    S.nextSession = null;
    // [SESSION_BANNER_0_10_9] 원본 SessionClockHud — 첫 판에서 「게임 시작 · N분」
    if (d.event === 'start' && d.endsAt && d.startedAt) notice(tn('ssStart', Math.round((d.endsAt - d.startedAt) / 60000)), 2600, 'start');
    if (d.event === 'warn') { notice(t('ssWarn'), 7000, 'warn'); play('turn'); }
    else if (d.event === 'time-up') { notice(t('ssTimeUp'), 6000, 'final'); play('turn'); }
    else if (d.event === 'ended') {   // 마지막 판 결과를 보여 주는 동안은 「마지막 3 / 3」 그대로 — 대기실이 뜰 때 바꾼다
        S.gateEnded = true;
        if (S.session && S.session.phase === 'final') { S.nextSession = d; return; }
    }
    S.session = d;
    renderClock();
}

function renderGate() {
    const box = $('#ready-q');
    const g = S.gate;
    const show = !!(g && g.active) && Date.now() >= S.gateShowAt && !!S.room;
    if (box.hidden === show) {
        $('#table').classList.toggle('gate-open', show);
        if (show) {   // 대기실이 뜬다 — 지난 판 말풍선을 걷고, 미뤄 둔 게임 시간(준비 대기)을 보인다
            S.bubbles = {};
            if (S.nextSession) { S.session = S.nextSession; S.nextSession = null; }
            box.hidden = false;
            render();
        }
    }
    box.hidden = !show;
    if (!show) return;
    const sub = $('.rq-sub', box);   // 게임 시간이 끝나 돌아왔으면 「게임이 끝났습니다」를 먼저
    sub.classList.toggle('ended', S.gateEnded);
    sub.innerHTML = S.gateEnded ? t('ssEnded').split('\n').map((x, i) => i ? esc(x) : `<b>${esc(x)}</b>`).join('<br>') : esc(t('rqSub'));
    const min = g.sessionMin || 0;
    $('.rq-time', box).textContent = min ? tn('rqTime', min) : t('rqNoLimit');
    $('.rq-final', box).textContent = min ? t('rqFinal') : '';
    $('.rq-final', box).hidden = !min;
    const list = $('.rq-list', box);
    list.innerHTML = '';
    for (const p of g.players || []) {
        const me = p.seat === mySeat();
        const li = el('li', (p.ready ? 'on' : '') + (me ? ' me' : ''));
        li.appendChild(el('i', 'dot'));
        const nm = el('span', 'nm'); nm.textContent = p.nickname || ('#' + (p.seat + 1)); li.appendChild(nm);
        if (me) li.appendChild(el('em', '', esc(t('rqMe'))));
        li.appendChild(el('b', '', esc(p.ready ? t('rqIsReady') : t('rqWaitP'))));
        list.appendChild(li);
    }
    $('.rq-count', box).textContent = tnm('rqCount', g.ready || 0, g.total || 0);
    const mine = (g.players || []).find((x) => x.seat === mySeat());
    const btn = $('.rq-btn', box);
    btn.hidden = !mine;
    if (mine) {
        btn.textContent = mine.ready ? t('rqCancel') : t('rqReady');
        btn.classList.toggle('on', !!mine.ready);
        btn.disabled = S.rqBusy;
    }
    const left = g.startsAt ? Math.ceil((g.startsAt - (Date.now() + S.skew)) / 1000) : 0;
    const note = $('.rq-note', box);
    note.classList.toggle('go', left > 0);
    note.textContent = left > 0 ? tn('rqStart', left) : !mine ? (S.watch ? ((g.total || 0) < 2 ? t('rqNeed') : '') : t('rqOut')) : (g.total || 0) < 2 ? t('rqNeed') : '';
    box.classList.toggle('counting', left > 0);
    if (!box.dataset.chat) { box.dataset.chat = '1'; renderGateChat(); }   // [GATE_CHAT_0_10_23] 처음 뜰 때 지난 대화
}

const two = (n) => String(n).padStart(2, '0');
function fmtDur(ms) {
    const sec = Math.max(0, Math.ceil(ms / 1000));
    const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), x = sec % 60;
    return h ? `${h}:${two(m)}:${two(x)}` : `${two(m)}:${two(x)}`;
}

/** 왼쪽 위 게임 시간 — 남은 시간(링이 줄어든다) → 3분 전 경고색 → 마지막 판 N / 3 → 준비 대기 */
function renderClock() {
    const box = $('#game-clock');
    const ss = S.session;
    if (!ss || !ss.minutes) { box.hidden = true; return; }
    box.hidden = false;
    const now = Date.now() + S.skew;
    let mode, k, v, frac;
    if (ss.phase === 'running') {
        const left = Math.max(0, ss.endsAt - now);
        mode = left <= (ss.warnMs || 180000) ? 'warn' : 'run';
        k = mode === 'warn' ? t('gcSoon') : t('gcTime');
        v = fmtDur(left);
        frac = ss.endsAt > ss.startedAt ? left / (ss.endsAt - ss.startedAt) : 0;
    } else if (ss.phase === 'final') {
        mode = 'final';
        k = t('gcFinal');
        v = `${ss.finalNo || '–'} / ${ss.finalTotal}`;
        frac = ss.finalTotal ? (ss.finalTotal - (ss.finalNo || 0)) / ss.finalTotal : 0;
    } else {
        mode = 'idle'; k = t('gcIdle'); v = fmtDur(ss.minutes * 60000); frac = 1;
    }
    box.className = mode;
    $('.gc-k', box).textContent = k;
    $('.gc-v', box).textContent = v;
    $('.gc-arc', box).style.strokeDasharray = `${Math.max(0, Math.min(1, frac)) * 100} 100`;
    const pips = box.querySelectorAll('.gc-pips i');
    pips.forEach((p, i) => p.classList.toggle('on', mode === 'final' && i < (ss.finalNo || 0)));
}

function tickClock() {
    if (S.seats && S.seats[mySeat()] && S.seats[mySeat()].sitout) renderAway();   // [AWAY_0_10_16] 남은 시간
    if (S.session && S.session.phase === 'running') {
        renderClock();
        // [SESSION_BANNER_0_10_9] 원본 — 끝나기 1분 전 한 번
        const left = S.session.endsAt - (Date.now() + (S.skew || 0));
        const key = S.session.startedAt + ':1m';
        if (left > 0 && left <= 60000 && S.warn1 !== key) { S.warn1 = key; notice(t('ss1m'), 5000, 'warn'); }
    }
    if (gateOpen() && (S.gate.startsAt || S.gateShowAt)) renderGate();
}

/** 큰 안내 띠 — 3분 전 · 시간 종료 · 게임 끝. 첫 줄은 굵게 */
let noticeTimer = null;
function notice(text, ms, kind = '') {
    if (!S.live) return;
    const n = $('#notice');
    const [a, ...b] = String(text).split('\n');
    $('.nt-k', n).textContent = a;
    $('.nt-v', n).textContent = b.join(' ');
    n.className = kind;
    n.hidden = true; void n.offsetWidth; n.hidden = false;
    clearTimeout(noticeTimer);
    noticeTimer = setTimeout(() => { n.hidden = true; }, ms);
}

boot();
