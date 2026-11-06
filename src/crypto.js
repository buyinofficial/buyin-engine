/**
 * 암호 도구 — 엔진·검증기가 같이 쓴다. 브라우저(WebCrypto)와 같은 형식만 쓴다.
 *
 *   키        P-256 (서명 ECDSA, 암호 ECDH). 주고받을 때는 JWK {kty, crv, x, y}.
 *   서명      ECDSA P-256 + SHA-256, r||s 64바이트(IEEE P1363) → base64url. 브라우저 WebCrypto 의 기본 형식이다.
 *   홀카드    ECDH(엔진 키, 회원 키) → HKDF-SHA256(salt=handId, info='pz-hole-v1') → AES-256-GCM
 *   서명 대상 아래 msg* 함수가 만드는 JSON 배열 문자열. 배열이라 키 순서 문제가 없다.
 */

const crypto = require('crypto');

const CURVE = 'prime256v1';

function b64u(buf) {
    return Buffer.from(buf).toString('base64url');
}

function fromB64u(s) {
    return Buffer.from(String(s || ''), 'base64url');
}

function sha256(data) {
    return crypto.createHash('sha256').update(data).digest();
}

function sha256hex(data) {
    return sha256(data).toString('hex');
}

/** 키 순서를 고정한 JSON — 서명·해시 대상이 언제 만들어도 같은 글자가 되게 */
function stableStringify(v) {
    if (v === null || typeof v !== 'object') return JSON.stringify(v === undefined ? null : v);
    if (Array.isArray(v)) return '[' + v.map(stableStringify).join(',') + ']';
    const keys = Object.keys(v).filter(k => v[k] !== undefined).sort();
    return '{' + keys.map(k => JSON.stringify(k) + ':' + stableStringify(v[k])).join(',') + '}';
}

// ---------------------------------------------------------------- 키

function generateKeyPair() {
    return crypto.generateKeyPairSync('ec', { namedCurve: CURVE });
}

/** 공개키를 {kty, crv, x, y} 만 남긴 JWK 로 */
function publicJwk(keyObject) {
    const pub = keyObject.type === 'private' ? crypto.createPublicKey(keyObject) : keyObject;
    const j = pub.export({ format: 'jwk' });
    return { kty: j.kty, crv: j.crv, x: j.x, y: j.y };
}

/** 브라우저가 보낸 JWK 를 공개키로. P-256 이 아니면 거절한다 */
function importPublicJwk(jwk) {
    if (!jwk || jwk.kty !== 'EC' || jwk.crv !== 'P-256' || typeof jwk.x !== 'string' || typeof jwk.y !== 'string') {
        throw new Error('bad key: P-256 JWK required');
    }
    return crypto.createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y }, format: 'jwk' });
}

/** 키 지문 — 공개키 JWK 의 SHA-256 앞 16바이트 */
function fingerprint(jwk) {
    return b64u(sha256(stableStringify({ crv: jwk.crv, kty: jwk.kty, x: jwk.x, y: jwk.y })).subarray(0, 16));
}

// ---------------------------------------------------------------- 서명

function sign(privateKey, text) {
    return b64u(crypto.sign('sha256', Buffer.from(text, 'utf8'), { key: privateKey, dsaEncoding: 'ieee-p1363' }));
}

function verify(publicKey, text, sig) {
    try {
        const raw = fromB64u(sig);
        if (raw.length !== 64) return false;
        return crypto.verify('sha256', Buffer.from(text, 'utf8'), { key: publicKey, dsaEncoding: 'ieee-p1363' }, raw);
    } catch (_e) {
        return false;
    }
}

// ---------------------------------------------------------------- 서명 대상 (브라우저 lib/tee-client.ts 와 같아야 한다)

/** 회원이 키를 이 테이블에 등록한다 (자기 서명 키로) */
function msgRegister(tableId, odcId, sigFp, ecdhFp) {
    return JSON.stringify(['pz-reg-v1', String(tableId), String(odcId), sigFp, ecdhFp]);
}

/** 엔진이 "이 회원의 키로 등록했다"를 확인해 준다 (엔진 서명 키로) */
function msgKeyConfirm(tableId, odcId, sigFp, ecdhFp) {
    return JSON.stringify(['pz-key-v1', String(tableId), String(odcId), sigFp, ecdhFp]);
}

/** 회원 액션 — q 는 이 판에서 몇 번째 차례인지(엔진이 센다). 같은 서명을 다른 차례에 못 쓴다 */
function msgAction(handId, q, action, amount) {
    return JSON.stringify(['pz-act-v1', String(handId), Number(q), String(action), Number(amount) || 0]);
}

/** 미리 고른 행동(자동 콜 등) 허락 — nonce 는 한 번만 쓴다 */
function msgPreAction(handId, preAction, nonce) {
    return JSON.stringify(['pz-pre-v1', String(handId), String(preAction), String(nonce)]);
}

/** 레이즈 게이지를 연 채 시간이 다 되면 자동 레이즈를 허락한다 (그 차례 q 에만) */
function msgRaiseCommit(handId, q) {
    return JSON.stringify(['pz-rc-v1', String(handId), Number(q)]);
}

/** 다음 판 섞기에 보태는 무작위 값 — 그 판의 씨앗 약속(seedCommit)에 묶인다 */
function msgEntropy(tableId, seedCommit, entropyHex) {
    return JSON.stringify(['pz-ent-v1', String(tableId), String(seedCommit), String(entropyHex)]);
}

// ---------------------------------------------------------------- 홀카드 봉투

function _envelopeKey(corePrivateKey, playerEcdhPublic, handId) {
    const shared = crypto.diffieHellman({ privateKey: corePrivateKey, publicKey: playerEcdhPublic });
    return Buffer.from(crypto.hkdfSync('sha256', shared, Buffer.from(String(handId), 'utf8'), Buffer.from('pz-hole-v1', 'utf8'), 32));
}

/** 회원만 열 수 있는 봉투. 브라우저는 ct 끝 16바이트를 GCM 태그로 읽는다(WebCrypto 형식) */
function sealEnvelope(corePrivateKey, playerEcdhPublic, handId, payload) {
    const key = _envelopeKey(corePrivateKey, playerEcdhPublic, handId);
    const iv = crypto.randomBytes(12);
    const c = crypto.createCipheriv('aes-256-gcm', key, iv);
    const ct = Buffer.concat([c.update(Buffer.from(JSON.stringify(payload), 'utf8')), c.final(), c.getAuthTag()]);
    return { v: 1, iv: b64u(iv), ct: b64u(ct) };
}

/** 시험·검증용 — 회원 쪽 개인키로 봉투를 연다 (ECDH 는 대칭이라 키 자리만 바뀐다) */
function openEnvelope(playerPrivateKey, corePublicKey, handId, env) {
    const key = _envelopeKey(playerPrivateKey, corePublicKey, handId);
    const raw = fromB64u(env.ct);
    const d = crypto.createDecipheriv('aes-256-gcm', key, fromB64u(env.iv));
    d.setAuthTag(raw.subarray(raw.length - 16));
    const pt = Buffer.concat([d.update(raw.subarray(0, raw.length - 16)), d.final()]);
    return JSON.parse(pt.toString('utf8'));
}

module.exports = {
    b64u, fromB64u, sha256, sha256hex, stableStringify,
    generateKeyPair, publicJwk, importPublicJwk, fingerprint,
    sign, verify,
    msgRegister, msgKeyConfirm, msgAction, msgPreAction, msgRaiseCommit, msgEntropy,
    sealEnvelope, openEnvelope,
};
