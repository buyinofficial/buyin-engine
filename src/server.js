/**
 * 엔진 서버 — 운영 서버(소켓 서버)가 HTTP 로 부른다.
 *
 *   POST /rpc   { m: 메서드, p: 인자 }  → { ok, ... }     운영 서버만 (Authorization: Bearer <TEE_RPC_TOKEN>)
 *   GET  /info  엔진 공개키·버전·증명서                     누구나 (브라우저가 봉투를 열고 서명·증명서를 확인한다)
 *
 * 환경 변수
 *   TEE_MODE            dev(기본) | dstack — dstack 은 Phala Cloud(dstack) TDX 안. 뜨기 전에 증명서를 받는다
 *   TEE_PORT            기본 3900
 *   TEE_HOST            기본 127.0.0.1. 컨테이너 안에서는 0.0.0.0 (밖에서는 TEE 게이트웨이 TLS 로만 들어온다)
 *   TEE_RPC_TOKEN       /rpc 접근 토큰. dstack 모드에서는 반드시 있어야 한다(32자 이상). 암호화 환경변수로만 넣는다
 *   TEE_ALLOW_UNSIGNED  1 이면 키 없는 좌석의 평문 카드·서명 없는 액션 허용 (시험 전용, dev 모드만)
 *
 * 토큰은 "누가 RPC 를 부르나"만 정한다. 토큰이 있어도 카드를 보거나 회원 서명 없이 칩을 움직일 수는 없다(RULES.md 3장).
 */

const http = require('http');
const crypto = require('crypto');
const Engine = require('./Engine');
const { dstackAttestation } = require('./attest');

const MODE = process.env.TEE_MODE || 'dev';
const PORT = Number(process.env.TEE_PORT || 3900);
const HOST = process.env.TEE_HOST || '127.0.0.1';
const TOKEN = process.env.TEE_RPC_TOKEN || '';
const MAX_BODY = 1024 * 1024;

if (MODE !== 'dev' && MODE !== 'dstack') throw new Error(`unknown TEE_MODE ${MODE}`);
if (MODE === 'dstack' && TOKEN.length < 32) throw new Error('TEE_RPC_TOKEN (32+ chars) is required in dstack mode');

let attestation = null;
const engine = new Engine({
    allowUnsigned: process.env.TEE_ALLOW_UNSIGNED === '1',
    mode: MODE,
    attest: MODE === 'dstack' ? () => attestation : undefined,
});

const tokenHash = TOKEN ? crypto.createHash('sha256').update(TOKEN).digest() : null;
function authorized(req) {
    if (!tokenHash) return true;
    const h = String(req.headers.authorization || '');
    const given = h.startsWith('Bearer ') ? h.slice(7) : '';
    return crypto.timingSafeEqual(crypto.createHash('sha256').update(given).digest(), tokenHash);
}

function send(res, code, obj) {
    const body = JSON.stringify(obj);
    res.writeHead(code, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
    res.end(body);
}

const server = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/info') return send(res, 200, engine.call('info'));
    if (req.method !== 'POST' || req.url !== '/rpc') return send(res, 404, { ok: false, error: 'not found' });
    if (!authorized(req)) { req.resume(); return send(res, 401, { ok: false, error: 'unauthorized' }); }
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
        size += c.length;
        if (size > MAX_BODY) { req.destroy(); return; }
        chunks.push(c);
    });
    req.on('end', () => {
        let msg;
        try { msg = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch (_e) { return send(res, 400, { ok: false, error: 'bad json' }); }
        send(res, 200, engine.call(msg && msg.m, msg && msg.p));
    });
});

server.keepAliveTimeout = 65000;

async function start() {
    if (MODE === 'dstack') {
        // 증명서 없이 뜨지 않는다 — 증명서 없는 엔진 키는 믿을 근거가 없다
        attestation = await dstackAttestation(engine.call('info').keys);
    }
    server.listen(PORT, HOST, () => {
        const info = engine.call('info');
        console.log(`[tee-engine] ${info.name} ${info.version} mode=${info.mode} listening ${HOST}:${PORT} sigFp=${info.keys.sigFp}`
            + `${attestation ? ` reportData=${attestation.reportData}` : ''}${tokenHash ? ' rpc=token' : ''}${engine.allowUnsigned ? ' ALLOW_UNSIGNED' : ''}`);
    });
}

start().catch((e) => {
    console.error(`[tee-engine] start failed: ${e.message}`);
    process.exit(1);
});
