/**
 * 회원 브라우저의 금고 — 이 TEE 주소에서만 쓰는 회원 키와 카드 확인.
 *
 *  - 키 두 벌(서명 ECDSA P-256, 암호 ECDH P-256)을 이 주소의 IndexedDB 에 둔다. 개인키는 꺼낼 수 없는 키다.
 *  - 홀카드 봉투: ECDH(내 키 × 엔진 키) → HKDF-SHA256(salt=판 번호, info='pz-hole-v1') → AES-256-GCM.
 *  - 받은 카드는 판 시작 때 공개된 카드 약속 52개와 맞춰 본다.
 *  - 서명 문장은 엔진 src/crypto.js 와 글자 하나까지 같다.
 */

const enc = new TextEncoder();

export function b64u(buf) {
    const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
    let s = '';
    for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
    return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function fromB64u(s) {
    const t = String(s).replace(/-/g, '+').replace(/_/g, '/');
    const bin = atob(t + '==='.slice((t.length + 3) % 4));
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
}

const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
const sha256 = (text) => crypto.subtle.digest('SHA-256', enc.encode(text));

export function stableStringify(v) {
    if (v === null || typeof v !== 'object') return JSON.stringify(v === undefined ? null : v);
    if (Array.isArray(v)) return '[' + v.map(stableStringify).join(',') + ']';
    return '{' + Object.keys(v).filter((k) => v[k] !== undefined).sort().map((k) => JSON.stringify(k) + ':' + stableStringify(v[k])).join(',') + '}';
}

/** 엔진 crypto.fingerprint 와 같다 */
export async function fingerprint(jwk) {
    return b64u(new Uint8Array(await sha256(stableStringify({ crv: jwk.crv, kty: jwk.kty, x: jwk.x, y: jwk.y }))).slice(0, 16));
}

// ---- 서명 문장 (엔진 src/crypto.js)
export const msg = {
    register: (tableId, odcId, sigFp, ecdhFp) => JSON.stringify(['pz-reg-v1', String(tableId), String(odcId), sigFp, ecdhFp]),
    keyConfirm: (tableId, odcId, sigFp, ecdhFp) => JSON.stringify(['pz-key-v1', String(tableId), String(odcId), sigFp, ecdhFp]),
    action: (handId, q, action, amount) => JSON.stringify(['pz-act-v1', String(handId), Number(q), String(action), Number(amount) || 0]),
    entropy: (tableId, seedCommit, entropyHex) => JSON.stringify(['pz-ent-v1', String(tableId), String(seedCommit), String(entropyHex)]),
    mine: (sigFp, ts, handId) => JSON.stringify(['pz-mine-v1', String(sigFp), Number(ts), String(handId || '')]),
};

/** 카드 약속 확인 — 엔진 src/cards.js */
export async function checkOpening(handId, commitments, op) {
    if (!op || !Number.isInteger(op.i) || op.i < 0 || op.i >= 52 || !commitments || !commitments[op.i]) return false;
    return hex(await sha256('pz-card-v1|' + handId + '|' + op.i + '|' + op.c + '|' + op.s)) === commitments[op.i];
}

// ---- 키 보관 · 내가 받은 홀카드(판이 끝난 뒤 검증 화면이 기록과 맞춰 본다)
const DB = 'buyin-table', STORE = 'keys', HOLES = 'holes';
function idb() {
    return new Promise((resolve, reject) => {
        const r = indexedDB.open(DB, 2);
        r.onupgradeneeded = () => {
            if (!r.result.objectStoreNames.contains(STORE)) r.result.createObjectStore(STORE);
            if (!r.result.objectStoreNames.contains(HOLES)) r.result.createObjectStore(HOLES);
        };
        r.onsuccess = () => resolve(r.result);
        r.onerror = () => reject(r.error);
    });
}
async function idbGet(key, store = STORE) {
    try { const db = await idb(); return await new Promise((res) => { const q = db.transaction(store, 'readonly').objectStore(store).get(key); q.onsuccess = () => res(q.result); q.onerror = () => res(undefined); }); } catch (_e) { return undefined; }
}
async function idbPut(key, value, store = STORE) {
    try { const db = await idb(); await new Promise((res) => { const tx = db.transaction(store, 'readwrite'); tx.objectStore(store).put(value, key); tx.oncomplete = res; tx.onerror = res; }); } catch (_e) { /* 사생활 보호 모드 — 이번 접속 동안만 */ }
}
async function idbKeys(store) {
    try { const db = await idb(); return await new Promise((res) => { const q = db.transaction(store, 'readonly').objectStore(store).getAllKeys(); q.onsuccess = () => res(q.result || []); q.onerror = () => res([]); }); } catch (_e) { return []; }
}

/** 판 도중 받은 내 홀카드(봉투를 연 그대로) */
export const saveHole = (handId, cards) => idbPut(String(handId), { cards, at: Date.now() }, HOLES);
export const getHole = (handId) => idbGet(String(handId), HOLES);

/** 이 브라우저에 있는 회원 키 전부 — 검증 화면용(새로 만들지 않는다) */
export async function existingKeys() {
    const out = [];
    for (const k of await idbKeys(STORE)) {
        const pair = await idbGet(k);
        if (!pair || !pair.sig) continue;
        const sigJwk = pubJwk(await crypto.subtle.exportKey('jwk', pair.sig.publicKey));
        out.push({ odcId: String(k).replace(/^u:/, ''), sig: pair.sig, sigJwk, sigFp: await fingerprint(sigJwk) });
    }
    return out;
}

const pubJwk = (j) => ({ kty: String(j.kty), crv: String(j.crv), x: String(j.x), y: String(j.y) });

export async function loadKeys(odcId) {
    const key = 'u:' + odcId;
    let pair = await idbGet(key);
    if (!pair || !pair.sig || !pair.ecdh) {
        pair = {
            sig: await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify']),
            ecdh: await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']),
        };
        await idbPut(key, pair);
    }
    const sigJwk = pubJwk(await crypto.subtle.exportKey('jwk', pair.sig.publicKey));
    const ecdhJwk = pubJwk(await crypto.subtle.exportKey('jwk', pair.ecdh.publicKey));
    return { sig: pair.sig, ecdh: pair.ecdh, sigJwk, ecdhJwk, sigFp: await fingerprint(sigJwk), ecdhFp: await fingerprint(ecdhJwk) };
}

export async function sign(keys, text) {
    return b64u(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, keys.sig.privateKey, enc.encode(text)));
}

export async function verify(jwk, text, sig) {
    try {
        const k = await crypto.subtle.importKey('jwk', { ...jwk, ext: true }, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
        return await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, k, fromB64u(sig), enc.encode(text));
    } catch (_e) { return false; }
}

export function randomHex(n) {
    const a = new Uint8Array(n); crypto.getRandomValues(a); return hex(a.buffer);
}

/** 내 홀카드 봉투를 연다 → [{i,c,s}] (약속 확인은 부르는 쪽에서) */
export async function openEnvelope(keys, engineEcdhJwk, handId, env) {
    const corePub = await crypto.subtle.importKey('jwk', { ...engineEcdhJwk, ext: true }, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
    const shared = await crypto.subtle.deriveBits({ name: 'ECDH', public: corePub }, keys.ecdh.privateKey, 256);
    const hk = await crypto.subtle.importKey('raw', shared, 'HKDF', false, ['deriveKey']);
    const aes = await crypto.subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: enc.encode(String(handId)), info: enc.encode('pz-hole-v1') }, hk, { name: 'AES-GCM', length: 256 }, false, ['decrypt']);
    const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromB64u(env.iv) }, aes, fromB64u(env.ct));
    const payload = JSON.parse(new TextDecoder().decode(pt));
    if (payload.h !== handId) throw new Error('envelope is for another hand');
    return payload.cards;
}

/** 엔진 키가 이 TEE 의 하드웨어 증명서에 묶였나 — report_data = SHA-256(stableStringify({ecdh, sig})) */
export async function checkAttestation(info) {
    const a = info && info.attestation;
    if (!a || info.mode !== 'dstack') return 'none';
    const want = hex(await sha256(stableStringify({ ecdh: pubJwk(info.keys.ecdh), sig: pubJwk(info.keys.sig) })));
    if (a.reportData !== want) return 'mismatch';
    const q = String(a.quote).replace(/^0x/, '');
    const rd = /^[0-9a-fA-F]+$/.test(q) ? q.slice(1136, 1200).toLowerCase() : '';
    return rd === want ? 'ok' : 'mismatch';
}
