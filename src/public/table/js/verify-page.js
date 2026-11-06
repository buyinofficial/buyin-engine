/**
 * 내 판 기록 검증하기 — TEE 가 직접 내보내는 공개 화면. 운영 서버를 거치지 않는다.
 *
 *  1. 이 브라우저에 있는 내 키로 TEE 에 "내가 앉았던 판"을 묻는다(POST /records/mine, 내 키 서명). 운영 토큰이 필요 없다.
 *  2. 판을 고르면 TEE 사슬의 그 줄(기록·엔진 서명)을 받아 브라우저가 직접 확인한다.
 *     ① 사슬 — 줄 해시를 다시 계산하고 공개 영수증(/records/receipt)과 맞춘다
 *     ② 엔진 키 — 사슬의 엔진 키 줄과 TDX 증명서 report_data 가 맞나(지금 키는 증명서 원본까지)
 *     ③ 다시 돌리기 — 엔진 verify.js(지금 도는 그 파일)로 씨앗·섞기·카드 약속·액션·결과·서명 전부
 *     ④ 내 카드 — 판 도중 내 브라우저가 봉투를 열어 받은 카드와 기록이 같나
 */
import * as V from './vault.js';

const L = {
    ko: {
        title: '내 판 기록 검증하기', lead: '판이 끝난 뒤, 이 화면이 TEE 에서 내 판 기록을 직접 받아 내 브라우저에서 처음부터 다시 계산합니다. 운영 서버는 이 과정에 끼지 않습니다.',
        engineTitle: '지금 도는 게임 엔진', handsTitle: '내가 앉았던 판', handsNote: '이 브라우저에 있는 내 키로 TEE 에 직접 묻습니다. 다른 기기에서 앉은 판은 그 기기에서 보입니다.',
        detailTitle: '판', download: '기록 파일로 받기', cli: '받은 파일은 공개 소스에서 node src/verify.js 로 다시 확인할 수 있습니다.',
        foot: '이 화면과 확인 코드는 TEE 가 내보내는 공개 소스입니다 — github.com/buyinofficial/buyin-engine',
        noKeys: '이 브라우저에는 아직 BUY-IN 테이블 키가 없습니다. 테이블에 한 번 앉으면 생깁니다.', none: '아직 끝난 판이 없습니다.', loading: '확인 중…',
        chain: 'TEE 원본 사슬에 그대로 있다', chainD: (i, h) => `${i}번째 줄 · 줄 해시 ${h.slice(0, 12)}… 를 다시 계산했고 공개 영수증과 같습니다`,
        key: '엔진 키가 TEE 하드웨어 증명서에 묶여 있다', keyDev: '개발 모드 엔진 — 하드웨어 증명서가 없습니다',
        keyD: (fp, now) => `엔진 키 ${fp} · report_data 일치${now ? ' · 지금 증명서 원본(quote)까지 확인' : ''}`,
        replay: '엔진 서명 · 카드 섞기 · 액션 재생이 모두 맞다', replayD: (n) => `씨앗 약속 → 섞기 → 카드 약속 52개 → 액션 → 결과·칩, 서명 ${n}개`,
        mine: '내가 받은 카드와 기록이 같다', mineD: (c) => `판 도중 받은 카드 ${c}`, mineNone: '이 브라우저에 이 판의 카드가 남아 있지 않습니다(다른 기기·지운 기록)',
        seat: '자리', at: '끝난 시각', table: '테이블', version: '버전', mode: '모드', sigFp: '서명 키', att: '하드웨어 증명',
        attOk: 'Intel TDX 증명서와 키가 묶여 있음', attNone: '없음(개발 모드)', attBad: '증명서와 키가 다름', records: '보관된 판',
        chainLen: '기록 사슬 줄 수', rollback: '이 브라우저가 전에 본 것보다 적습니다(되돌리기 의심)',
    },
    en: {
        title: 'Verify my hands', lead: 'After a hand ends, this page fetches your hand record straight from the TEE and recomputes it in your browser. The operator is not involved.',
        engineTitle: 'Game engine running now', handsTitle: 'Hands I played', handsNote: 'Asked from the TEE with the key in this browser. Hands played on another device show up there.',
        detailTitle: 'Hand', download: 'Download the record', cli: 'You can re-check the file with node src/verify.js from the public source.',
        foot: 'This page and its checks are public source served by the TEE — github.com/buyinofficial/buyin-engine',
        noKeys: 'This browser has no BUY-IN table key yet. It is created the first time you sit at a table.', none: 'No finished hands yet.', loading: 'Checking…',
        chain: 'It is in the TEE record chain as is', chainD: (i, h) => `line ${i} · line hash ${h.slice(0, 12)}… recomputed and equal to the public receipt`,
        key: 'The engine key is bound to the TEE hardware attestation', keyDev: 'Development engine — no hardware attestation',
        keyD: (fp, now) => `engine key ${fp} · report_data matches${now ? ' · checked against the live quote' : ''}`,
        replay: 'Engine signature, shuffle and replay all check out', replayD: (n) => `seed commit → shuffle → 52 card commitments → actions → result and chips, ${n} signatures`,
        mine: 'The cards I received match the record', mineD: (c) => `cards received during the hand: ${c}`, mineNone: 'This browser no longer has the cards of this hand (other device or cleared)',
        seat: 'Seat', at: 'Ended', table: 'Table', version: 'Version', mode: 'Mode', sigFp: 'Signing key', att: 'Hardware attestation',
        attOk: 'key bound to the Intel TDX quote', attNone: 'none (development)', attBad: 'key differs from the quote', records: 'Hands stored',
        chainLen: 'Record chain lines', rollback: 'fewer than this browser saw before (possible rollback)',
    },
};
const lang = (navigator.language || 'en').startsWith('ko') ? 'ko' : 'en';
const t = (k) => L[lang][k] ?? L.en[k];
document.documentElement.lang = lang;

const $ = (s, r = document) => r.querySelector(s);
const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; };
const E = window.BuyinEngine;
const C = E.require('crypto.js');

const state = { keys: [], info: null, att: 'none', engineKeys: [] };

async function getJson(url, opts) {
    const r = await fetch(url, { cache: 'no-store', ...opts });
    return r.json().catch(() => ({ ok: false }));
}

/** 내 키로 서명한 요청 */
async function mine(k, handId) {
    const ts = Date.now();
    const proof = await V.sign(k, V.msg.mine(k.sigFp, ts, handId));
    return getJson('/records/mine', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sig: k.sigJwk, ts, proof, handId }) });
}

async function boot() {
    for (const n of document.querySelectorAll('[data-v]')) { const v = t(n.dataset.v); if (typeof v === 'string') n.textContent = v; }
    state.info = await getJson('/info');
    state.att = await V.checkAttestation(state.info);
    const keysRes = await getJson('/records/keys');
    state.engineKeys = keysRes.keys || [];
    renderEngine();
    state.keys = await V.existingKeys();
    const list = $('.hand-list');
    if (!state.keys.length) { list.append(el('li', 'empty', t('noKeys'))); return; }
    const rows = [];
    for (const k of state.keys) {
        const r = await mine(k);
        for (const h of (r.hands || [])) rows.push({ k, h });
    }
    rows.sort((a, b) => b.h.at - a.h.at);
    if (!rows.length) { list.append(el('li', 'empty', t('none'))); return; }
    for (const { k, h } of rows) {
        const li = el('li');
        const b = el('button', 'hand');
        b.type = 'button';
        b.dataset.hand = h.handId;
        b.append(el('span', 'when', new Date(h.endedAt || h.at).toLocaleString()), el('code', 'id', h.handId), el('span', 'tbl', `${t('table')} ${String(h.tableId).slice(0, 10)}`));
        b.onclick = () => openHand(k, h.handId);
        li.append(b);
        list.append(li);
    }
}

function renderEngine() {
    const i = state.info || {};
    const kv = $('.engine .kv');
    const add = (k, v, cls) => { kv.append(el('dt', '', k)); const d = el('dd', cls || '', v); kv.append(d); };
    add(t('version'), `${i.name || ''} ${i.version || ''}`);
    add(t('mode'), i.mode || '—');
    add(t('sigFp'), (i.keys && i.keys.sigFp) || '—');
    add(t('att'), state.att === 'ok' ? t('attOk') : state.att === 'mismatch' ? t('attBad') : t('attNone'), state.att === 'ok' ? 'ok' : state.att === 'mismatch' ? 'bad' : 'warn');
    if (i.records) add(t('records'), String(i.records.hands));
    // 되돌리기 감시 — 이 브라우저가 본 사슬 줄 수보다 줄어들면 경고(사슬은 늘기만 해야 한다)
    if (i.records) {
        let seen = 0;
        try { seen = Number(localStorage.getItem('buyin.chainSeen') || 0); } catch (_e) { /* 사생활 보호 모드 */ }
        const now = Number(i.records.count) || 0;
        if (seen && now < seen) add(t('chainLen'), `${now} < ${seen} — ${t('rollback')}`, 'bad');
        else add(t('chainLen'), `${now}${seen ? ` (≥ ${seen})` : ''}`, 'ok');
        try { localStorage.setItem('buyin.chainSeen', String(Math.max(seen, now))); } catch (_e) { /* 사생활 보호 모드 */ }
    }
}

const reportDataOf = (keys) => E.sha256hex(C.stableStringify({ ecdh: keys.ecdh, sig: keys.sig }));

async function openHand(k, handId) {
    const box = $('.detail');
    box.hidden = false;
    $('.hid', box).textContent = handId;
    const ol = $('.checks', box);
    ol.innerHTML = '';
    $('.cards-row', box).innerHTML = '';
    const row = (title) => { const li = el('li', 'check run'); li.append(el('b', '', title), el('span', 'd', t('loading'))); ol.append(li); return (ok, d) => { li.className = 'check ' + (ok === true ? 'ok' : ok === false ? 'bad' : 'warn'); $('.d', li).textContent = d; }; };
    for (const b of document.querySelectorAll('.hand')) b.classList.toggle('on', b.dataset.hand === handId);

    const r = await mine(k, handId);
    const entry = r.entry;
    const setChain = row(t('chain')), setKey = row(t('key')), setReplay = row(t('replay')), setMine = row(t('mine'));
    if (!entry) { setChain(false, r.error || 'not found'); return; }
    const rec = entry.record;
    window.__lastEntry = { entry, engineSigJwk: null };   // 시험·디버그용(읽기만)

    // ① 사슬 — 줄 해시 다시 계산 + 공개 영수증
    const lineHash = E.sha256hex(entry.prev + '\n' + C.stableStringify({ kind: entry.kind, at: entry.at, record: rec, sig: entry.sig }));
    const rc = await getJson('/records/receipt/' + encodeURIComponent(handId));
    const chainOk = lineHash === entry.hash && rc.ok && rc.receipt.hash === entry.hash && rc.receipt.i === entry.i
        && rc.receipt.recordHash === E.sha256hex(C.stableStringify(rec));
    setChain(chainOk, chainOk ? t('chainD')(entry.i, entry.hash) : 'hash mismatch');

    // ② 엔진 키 — 사슬의 엔진 키 줄(그 판을 서명한 키)과 증명서
    const fp = rec.engine && rec.engine.sigFp;
    const ek = state.engineKeys.find((x) => x.keys && x.keys.sigFp === fp);
    let engineSigJwk = ek ? ek.keys.sig : null;
    window.__lastEntry.engineSigJwk = engineSigJwk;
    if (!ek) setKey(false, 'engine key not in the chain');
    else if (!ek.attestation) setKey(null, t('keyDev'));
    else {
        const now = state.info && state.info.keys && state.info.keys.sigFp === fp;
        const ok = ek.attestation.reportData === reportDataOf(ek.keys) && (!now || state.att === 'ok');
        setKey(ok, ok ? t('keyD')(fp, now) : 'report_data mismatch');
    }

    // ③ 다시 돌리기 — 엔진 verify.js 그대로
    try {
        const v = await E.verifyWithEngine(rec, entry.sig, engineSigJwk);
        setReplay(v.ok, v.ok ? t('replayD')(v.signatures) : v.errors.join(' · '));
    } catch (e) { setReplay(false, String(e.message || e)); }

    // ④ 내 카드
    const seat = (rec.seats || []).find((s) => s.keys && s.keys.sig && s.keys.sig.x === k.sigJwk.x && s.keys.sig.y === k.sigJwk.y);
    const saved = await V.getHole(handId);
    const recHole = seat && rec.holes ? (rec.holes[seat.seat] || []).map((x) => (typeof x === 'string' ? x : x.c)) : [];
    if (!saved) setMine(null, t('mineNone'));
    else {
        const got = saved.cards.map((x) => x.c);
        const ok = got.join(',') === recHole.join(',');
        setMine(ok, ok ? t('mineD')(got.join(' ')) : `${got.join(' ')} ≠ ${recHole.join(' ')}`);
    }

    // 카드 한 줄
    const cards = $('.cards-row', box);
    const chip = (label, list) => { const g = el('div', 'grp'); g.append(el('span', 'lbl', label)); for (const c of list) g.append(el('span', 'pc ' + ('hd'.includes(c[1]) ? 'red' : ''), c.replace('T', '10').replace(/[shdc]$/, (s) => ({ s: '♠', h: '♥', d: '♦', c: '♣' }[s])))); cards.append(g); };
    if (seat) chip(`${t('seat')} ${seat.seat}`, recHole);
    chip('Board', (rec.board || []).map((x) => (typeof x === 'string' ? x : x.c)));

    $('.dl', box).onclick = () => {
        const blob = new Blob([JSON.stringify({ record: rec, sig: entry.sig, engineKey: engineSigJwk, chain: { i: entry.i, prev: entry.prev, hash: entry.hash, at: entry.at } }, null, 1)], { type: 'application/json' });
        const a = el('a'); a.href = URL.createObjectURL(blob); a.download = `buyin-hand-${handId}.json`; a.click();
        setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    };
}

boot();
