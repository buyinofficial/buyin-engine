/**
 * [TEE_ENGINE_2026_11_06] 게임 엔진(tee-engine)과 브라우저 사이의 신뢰 장치.
 *
 * 카드는 운영 서버에 없다. 엔진이 덱을 섞고, 내 홀카드를 "내 브라우저 키"로 잠가 보낸다.
 * 이 파일이 하는 일:
 *   · 키 두 벌(서명 ECDSA P-256, 암호 ECDH P-256)을 만들어 IndexedDB 에 둔다. 개인키는 꺼낼 수 없는(non-extractable) 키다.
 *   · 테이블에 키를 등록하고, 엔진이 "이 키로 등록했다"고 서명한 확인을 엔진 공개키로 검사한다.
 *   · 홀카드 봉투를 연다 (ECDH → HKDF-SHA256 → AES-256-GCM).
 *   · 액션·자동 콜·레이즈 게이지 허락에 서명한다 — 운영 서버는 내 서명 없이 내 칩을 쓸 수 없다.
 *   · 받는 카드마다 판 시작 때 공개된 카드 약속과 맞춰 본다 — 판 도중 카드가 바뀌면 바로 드러난다.
 *
 * 서명·약속 문장 형식은 tee-engine/src/crypto.js · cards.js 와 글자 하나까지 같아야 한다.
 */
import { checkEngine } from './tee-attest';

export type Jwk = { kty: string; crv: string; x: string; y: string };
export type Opening = { i: number; c: string; s: string };
export type EngineInfo = { name?: string; version?: string; mode?: string; keys: { sig: Jwk; ecdh: Jwk; sigFp: string; ecdhFp: string }; attestation?: unknown };
export type Envelope = { v: number; iv: string; ct: string };

export type TeeStatus = {
    /** 엔진 모드 — 'dev' 는 일반 프로세스(하드웨어 증명 없음) */
    mode: string | null;
    /** 내 키가 이 테이블에 등록됐고 엔진 확인 서명이 맞다 */
    keysConfirmed: boolean;
    /** 약속과 맞춰 본 카드 수 (이번 접속 동안) */
    verifiedCards: number;
    /** 약속과 안 맞은 카드 수 — 0 이 아니면 경고 */
    mismatches: number;
    /** 봉투를 못 연 횟수 (다른 기기에서 키를 바꿨거나, 서버가 키를 바꿔 끼운 경우) */
    decryptFailures: number;
    /** 마지막 문제 설명 */
    lastProblem: string | null;
    /** 이 테이블 레이크 규칙 (엔진이 판 시작 때 받아 판 기록에 서명해 남긴 값) */
    rake: { percent: number; minPot: number } | null;
    /** [TEE_VERIFY_2026_11_06] 게임이 쓰는 엔진 키 ↔ TEE 증명서 — 브라우저가 TEE 엔진 /info 를 직접 받아 맞춘다.
     *  ok: 같은 키·증명서 확인 / mismatch: 운영 서버가 다른 엔진 키를 줬다(경고) / fail: 증명서를 못 받음 / none: 개발 모드 */
    attest: 'none' | 'checking' | 'ok' | 'mismatch' | 'fail';
};

const enc = new TextEncoder();

function b64u(buf: ArrayBuffer | Uint8Array): string {
    const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
    let s = '';
    for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
    return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromB64u(s: string): Uint8Array {
    const t = s.replace(/-/g, '+').replace(/_/g, '/');
    const bin = atob(t + '==='.slice((t.length + 3) % 4));
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
}

function hex(buf: ArrayBuffer): string {
    return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
}

async function sha256(text: string): Promise<ArrayBuffer> {
    return crypto.subtle.digest('SHA-256', enc.encode(text));
}

/** 엔진 crypto.fingerprint 와 같다 — 정렬된 키 순서 JSON 의 SHA-256 앞 16바이트 */
export async function fingerprint(jwk: Jwk): Promise<string> {
    const text = '{' + ['crv', 'kty', 'x', 'y'].map(k => JSON.stringify(k) + ':' + JSON.stringify((jwk as Record<string, string>)[k])).join(',') + '}';
    return b64u(new Uint8Array(await sha256(text)).slice(0, 16));
}

// ---- 서명 문장 (tee-engine/src/crypto.js 와 같다)
const msgRegister = (tableId: string, odcId: string, sigFp: string, ecdhFp: string) => JSON.stringify(['pz-reg-v1', String(tableId), String(odcId), sigFp, ecdhFp]);
const msgKeyConfirm = (tableId: string, odcId: string, sigFp: string, ecdhFp: string) => JSON.stringify(['pz-key-v1', String(tableId), String(odcId), sigFp, ecdhFp]);
const msgAction = (handId: string, q: number, action: string, amount: number) => JSON.stringify(['pz-act-v1', String(handId), Number(q), String(action), Number(amount) || 0]);
const msgPreAction = (handId: string, pre: string, nonce: string) => JSON.stringify(['pz-pre-v1', String(handId), String(pre), String(nonce)]);
const msgRaiseCommit = (handId: string, q: number) => JSON.stringify(['pz-rc-v1', String(handId), Number(q)]);
const msgEntropy = (tableId: string, seedCommit: string, entropyHex: string) => JSON.stringify(['pz-ent-v1', String(tableId), String(seedCommit), String(entropyHex)]);

/** 카드 약속 확인 — tee-engine/src/cards.js cardCommitment */
export async function checkOpening(handId: string, commitments: string[], op: Opening): Promise<boolean> {
    if (!op || !Number.isInteger(op.i) || op.i < 0 || op.i >= 52 || !commitments || !commitments[op.i]) return false;
    return hex(await sha256('pz-card-v1|' + handId + '|' + op.i + '|' + op.c + '|' + op.s)) === commitments[op.i];
}

// ---- 키 보관 (IndexedDB, 꺼낼 수 없는 개인키)
type KeySet = { sig: CryptoKeyPair; ecdh: CryptoKeyPair; sigJwk: Jwk; ecdhJwk: Jwk; sigFp: string; ecdhFp: string };

const DB_NAME = 'pz-tee';
const STORE = 'keys';

function idb(): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
        const r = indexedDB.open(DB_NAME, 1);
        r.onupgradeneeded = () => { r.result.createObjectStore(STORE); };
        r.onsuccess = () => resolve(r.result);
        r.onerror = () => reject(r.error);
    });
}

async function idbGet<T>(key: string): Promise<T | undefined> {
    try {
        const db = await idb();
        return await new Promise<T | undefined>((resolve) => {
            const req = db.transaction(STORE, 'readonly').objectStore(STORE).get(key);
            req.onsuccess = () => resolve(req.result as T | undefined);
            req.onerror = () => resolve(undefined);
        });
    } catch { return undefined; }
}

async function idbPut(key: string, value: unknown): Promise<void> {
    try {
        const db = await idb();
        await new Promise<void>((resolve) => {
            const tx = db.transaction(STORE, 'readwrite');
            tx.objectStore(STORE).put(value, key);
            tx.oncomplete = () => resolve();
            tx.onerror = () => resolve();
        });
    } catch { /* 사생활 보호 모드 등 — 이번 접속 동안만 메모리 키로 */ }
}

function pubJwk(j: JsonWebKey): Jwk {
    return { kty: String(j.kty), crv: String(j.crv), x: String(j.x), y: String(j.y) };
}

async function makeKeys(): Promise<{ sig: CryptoKeyPair; ecdh: CryptoKeyPair }> {
    const sig = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify']) as CryptoKeyPair;
    const ecdh = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']) as CryptoKeyPair;
    return { sig, ecdh };
}

async function loadKeys(userId: string): Promise<KeySet> {
    const storeKey = 'u:' + userId;
    let pair = await idbGet<{ sig: CryptoKeyPair; ecdh: CryptoKeyPair }>(storeKey);
    if (!pair || !pair.sig || !pair.ecdh) {
        pair = await makeKeys();
        await idbPut(storeKey, pair);
    }
    const sigJwk = pubJwk(await crypto.subtle.exportKey('jwk', pair.sig.publicKey));
    const ecdhJwk = pubJwk(await crypto.subtle.exportKey('jwk', pair.ecdh.publicKey));
    return { sig: pair.sig, ecdh: pair.ecdh, sigJwk, ecdhJwk, sigFp: await fingerprint(sigJwk), ecdhFp: await fingerprint(ecdhJwk) };
}

async function sign(key: CryptoKey, text: string): Promise<string> {
    return b64u(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, enc.encode(text)));
}

async function verify(jwk: Jwk, text: string, sig: string): Promise<boolean> {
    try {
        const key = await crypto.subtle.importKey('jwk', { ...jwk, ext: true }, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
        return await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, fromB64u(sig) as BufferSource, enc.encode(text));
    } catch { return false; }
}

function randomHex(n: number): string {
    const a = new Uint8Array(n);
    crypto.getRandomValues(a);
    return hex(a.buffer);
}

type Send = (msg: { type: string; data?: unknown }) => boolean | void;

export class TeeClient {
    userId: string | null = null;
    tableId: string | null = null;
    engine: EngineInfo | null = null;
    handId: string | null = null;
    commitments: string[] = [];
    turn: { handId: string; q: number } | null = null;
    private keys: KeySet | null = null;
    private keysFor: string | null = null;
    private registeredTable: string | null = null;
    private registering: Promise<void> | null = null;
    private entropySentFor: string | null = null;
    status: TeeStatus = { mode: null, keysConfirmed: false, verifiedCards: 0, mismatches: 0, decryptFailures: 0, lastProblem: null, rake: null, attest: 'none' };
    private attestedFor: string | null = null;
    onStatus: ((s: TeeStatus) => void) | null = null;

    static supported(): boolean {
        return typeof window !== 'undefined' && !!(window.crypto && window.crypto.subtle) && typeof indexedDB !== 'undefined';
    }

    private emit(patch: Partial<TeeStatus>) {
        this.status = { ...this.status, ...patch };
        if (this.onStatus) this.onStatus(this.status);
    }

    private problem(msg: string, patch: Partial<TeeStatus> = {}) {
        console.warn('[TEE]', msg);
        this.emit({ ...patch, lastProblem: msg });
    }

    setUser(userId: string | number | null | undefined) {
        const id = userId == null ? null : String(userId);
        if (id !== this.userId) {
            this.userId = id;
            this.keys = null;
            this.keysFor = null;
            this.registeredTable = null;
            this.emit({ keysConfirmed: false });
        }
    }

    private async ensureKeys(): Promise<KeySet | null> {
        if (!this.userId || !TeeClient.supported()) return null;
        if (!this.keys || this.keysFor !== this.userId) {
            this.keys = await loadKeys(this.userId);
            this.keysFor = this.userId;
        }
        return this.keys;
    }

    /** 스냅샷·tee_info·hand_start 에 실린 테이블·엔진 정보를 받아 두고, 필요하면 키를 등록한다 */
    async onTableInfo(t: { tableId?: string | null; engine?: EngineInfo | null; seedCommit?: string; nextSeedCommit?: string } | null | undefined, send: Send) {
        if (!t || !t.tableId) return;
        if (t.engine && t.engine.keys) {
            this.engine = t.engine;
            if (this.status.mode !== (t.engine.mode || null)) this.emit({ mode: t.engine.mode || null });
            void this.checkAttestation();
        }
        if (t.tableId !== this.tableId) {
            this.tableId = t.tableId;
            this.registeredTable = null;
            this.entropySentFor = null;
            this.emit({ keysConfirmed: false });
        }
        await this.register(send);
        const sc = t.nextSeedCommit || t.seedCommit;
        if (sc) await this.sendEntropy(sc, send);
    }

    /** [TEE_VERIFY_2026_11_06] 운영 서버가 알려 준 엔진 키가 TEE 증명서에 묶인 그 키인지 — 엔진 키가 바뀔 때마다 한 번 */
    private async checkAttestation() {
        const e = this.engine;
        if (!e || !e.keys) return;
        if (e.mode !== 'dstack') { if (this.status.attest !== 'none') this.emit({ attest: 'none' }); this.attestedFor = null; return; }
        if (this.attestedFor === e.keys.sigFp) return;
        this.attestedFor = e.keys.sigFp;
        this.emit({ attest: 'checking' });
        const r = await checkEngine();
        if (this.engine !== e) return;
        if (r.state === 'ok' && r.info.keys.sigFp === e.keys.sigFp && r.info.keys.ecdhFp === e.keys.ecdhFp) this.emit({ attest: 'ok' });
        else if (r.state === 'ok') this.problem('game engine key differs from the attested TEE engine key', { attest: 'mismatch' });
        else { this.attestedFor = null; this.emit({ attest: 'fail' }); }
    }

    /** 키 등록 (테이블마다 한 번, 엔진이 다시 뜨면 다시) */
    async register(send: Send, force = false) {
        if (!this.tableId || !this.userId) return;
        if (!force && this.registeredTable === this.tableId) return;
        if (this.registering) return this.registering;
        this.registering = (async () => {
            const k = await this.ensureKeys();
            if (!k || !this.tableId || !this.userId) return;
            const proof = await sign(k.sig.privateKey, msgRegister(this.tableId, this.userId, k.sigFp, k.ecdhFp));
            this.registeredTable = this.tableId;
            send({ type: 'tee_hello', data: { tableId: this.tableId, sig: k.sigJwk, ecdh: k.ecdhJwk, proof } });
        })().finally(() => { this.registering = null; });
        return this.registering;
    }

    /** 엔진의 등록 확인 — 엔진 공개키로 서명을 확인하고, 내 키 지문이 맞는지 본다 */
    async onRegistered(m: { ok?: boolean; tableId?: string; sigFp?: string; ecdhFp?: string; confirm?: string; seedCommit?: string; error?: string; code?: string }, send: Send) {
        if (!m.ok) {
            this.registeredTable = null;
            if (m.code === 'stale' && m.tableId) { this.tableId = m.tableId; await this.register(send, true); return; }
            this.problem('key registration failed: ' + (m.error || ''), { keysConfirmed: false });
            return;
        }
        const k = await this.ensureKeys();
        if (!k || !this.engine || !this.userId || !m.tableId || !m.confirm) return;
        const mine = m.sigFp === k.sigFp && m.ecdhFp === k.ecdhFp;
        const good = mine && await verify(this.engine.keys.sig, msgKeyConfirm(m.tableId, this.userId, k.sigFp, k.ecdhFp), m.confirm);
        if (!good) {
            this.problem(mine ? 'engine confirmation signature is invalid' : 'server registered a different key for me', { keysConfirmed: false });
            return;
        }
        this.emit({ keysConfirmed: true, lastProblem: null });
        if (m.seedCommit) await this.sendEntropy(m.seedCommit, send);
    }

    /** 다음 판 섞기에 보탤 무작위 값 — 엔진이 미리 약속한 씨앗에 묶는다 */
    async sendEntropy(seedCommit: string, send: Send) {
        if (!this.tableId || this.entropySentFor === seedCommit) return;
        const k = await this.ensureKeys();
        if (!k) return;
        this.entropySentFor = seedCommit;
        const h = randomHex(32);
        send({ type: 'tee_entropy', data: { seedCommit, hex: h, sig: await sign(k.sig.privateKey, msgEntropy(this.tableId, seedCommit, h)) } });
    }

    /** 판 시작 — 카드 약속을 받아 둔다 */
    onHandStart(t: { handId?: string; commitments?: string[]; rake?: { percent: number; minPot: number } } | null | undefined) {
        if (!t || !t.handId) return;
        if (t.rake && typeof t.rake.percent === 'number') this.emit({ rake: { percent: t.rake.percent, minPot: Number(t.rake.minPot) || 0 } });
        this.handId = t.handId;
        this.commitments = Array.isArray(t.commitments) ? t.commitments : [];
        this.turn = null;
    }

    onTurn(t: { handId: string; q: number } | null | undefined) {
        if (t && t.handId) this.turn = { handId: t.handId, q: Number(t.q) };
    }

    /** 공개된 카드들을 약속과 맞춰 본다 */
    async verifyOpenings(ops: Opening[] | null | undefined, handId?: string | null) {
        const h = handId || this.handId;
        if (!ops || !ops.length || !h || !this.commitments.length || h !== this.handId) return true;
        let okCount = 0, bad = 0;
        for (const op of ops) {
            if (await checkOpening(h, this.commitments, op)) okCount++; else bad++;
        }
        if (bad) this.problem(`${bad} card(s) do not match the deck commitment`, { verifiedCards: this.status.verifiedCards + okCount, mismatches: this.status.mismatches + bad });
        else this.emit({ verifiedCards: this.status.verifiedCards + okCount });
        return bad === 0;
    }

    /** 내 홀카드 봉투를 연다 → 카드 문자열. 열지 못하면 null */
    async openHole(env: Envelope | null | undefined, handId: string | null | undefined): Promise<string[] | null> {
        if (!env || !handId || !this.engine) return null;
        try {
            const k = await this.ensureKeys();
            if (!k) return null;
            const corePub = await crypto.subtle.importKey('jwk', { ...this.engine.keys.ecdh, ext: true }, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
            const shared = await crypto.subtle.deriveBits({ name: 'ECDH', public: corePub }, k.ecdh.privateKey, 256);
            const hk = await crypto.subtle.importKey('raw', shared, 'HKDF', false, ['deriveKey']);
            const aes = await crypto.subtle.deriveKey(
                { name: 'HKDF', hash: 'SHA-256', salt: enc.encode(String(handId)), info: enc.encode('pz-hole-v1') },
                hk, { name: 'AES-GCM', length: 256 }, false, ['decrypt']);
            const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromB64u(env.iv) as BufferSource }, aes, fromB64u(env.ct) as BufferSource);
            const payload = JSON.parse(new TextDecoder().decode(pt)) as { h: string; cards: Opening[] };
            if (payload.h !== handId) throw new Error('envelope is for another hand');
            await this.verifyOpenings(payload.cards, handId);
            return payload.cards.map(o => o.c);
        } catch (e) {
            this.problem('could not open my hole cards: ' + ((e as Error)?.message || e), { decryptFailures: this.status.decryptFailures + 1 });
            return null;
        }
    }

    /** 액션 서명 — 마지막으로 받은 내 차례(handId, q)에 묶는다 */
    async signAction(action: string, amount: number): Promise<{ sig: string } | null> {
        const k = await this.ensureKeys();
        if (!k || !this.turn) return null;
        return { sig: await sign(k.sig.privateKey, msgAction(this.turn.handId, this.turn.q, action, Number(amount) || 0)) };
    }

    /** 자동 콜 허락 (이번 판, 한 번) */
    async signPreAction(pre: string): Promise<{ p: string; nonce: string; sig: string } | null> {
        if (pre !== 'autoCall') return null;
        const k = await this.ensureKeys();
        if (!k || !this.handId) return null;
        const nonce = randomHex(8);
        return { p: 'autoCall', nonce, sig: await sign(k.sig.privateKey, msgPreAction(this.handId, 'autoCall', nonce)) };
    }

    /** 레이즈 게이지를 연 채 시간이 다 되면 자동 레이즈해도 된다는 허락 (이 차례에만) */
    async signRaiseCommit(): Promise<{ sig: string } | null> {
        const k = await this.ensureKeys();
        if (!k || !this.turn) return null;
        return { sig: await sign(k.sig.privateKey, msgRaiseCommit(this.turn.handId, this.turn.q)) };
    }
}
