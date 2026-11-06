/**
 * 증명서 — 엔진 공개키를 TEE 하드웨어 증명서(TDX quote)에 묶는다.
 *
 * report_data = SHA-256( stableStringify({ ecdh, sig }) )   엔진 공개키 두 개(JWK)
 *
 * 증명서를 받은 사람은 quote 의 report_data 앞 32바이트가 /info 의 엔진 공개키로 계산한 값과 같은지 본다.
 * 같으면 "이 공개키는 측정된(공개된) 그 코드가 TEE 안에서 만든 것"이다. 개인키는 엔진 밖으로 나가지 않는다.
 *
 * dstack(Phala Cloud) 게스트 에이전트에 유닉스 소켓으로 묻는다. 외부 패키지는 쓰지 않는다(RULES.md 6장).
 * 이 파일은 서버(server.js)에서만 쓴다 — 엔진 계산(Engine·HandCore)은 소켓·네트워크를 모른다.
 */

const http = require('http');
const fs = require('fs');
const C = require('./crypto');

const SOCKETS = ['/var/run/dstack.sock', '/run/dstack.sock', '/var/run/dstack/dstack.sock', '/run/dstack/dstack.sock'];

/** 엔진 공개키 → report_data (32바이트, hex) — 검증하는 쪽도 같은 함수를 쓴다 */
function reportDataFor(keys) {
    const text = C.stableStringify({ ecdh: pickJwk(keys.ecdh), sig: pickJwk(keys.sig) });
    return C.sha256(text).toString('hex');
}

function pickJwk(j) {
    return { crv: j.crv, kty: j.kty, x: j.x, y: j.y };
}

function findSocket() {
    return SOCKETS.find((p) => fs.existsSync(p)) || null;
}

function rpc(socketPath, path, payload, timeoutMs = 30000) {
    return new Promise((resolve, reject) => {
        const body = JSON.stringify(payload);
        const req = http.request({
            socketPath, path, method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), Host: 'dstack' },
            timeout: timeoutMs,
        }, (res) => {
            const chunks = [];
            res.on('data', (c) => chunks.push(c));
            res.on('end', () => {
                let out;
                try { out = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch (_e) { return reject(new Error(`dstack ${path}: bad response`)); }
                if (out && out.error) return reject(new Error(`dstack ${path}: ${out.error}`));
                resolve(out);
            });
        });
        req.on('timeout', () => req.destroy(new Error(`dstack ${path}: timed out`)));
        req.on('error', reject);
        req.end(body);
    });
}

/**
 * TDX 증명서를 받아 온다. 엔진이 뜰 때 한 번 — 엔진 키는 뜰 때 만들어지고 바뀌지 않는다.
 * @returns {Promise<object>} /info 의 attestation 자리에 그대로 들어간다
 */
async function dstackAttestation(keys) {
    const socketPath = findSocket();
    if (!socketPath) throw new Error('dstack socket not found — is /var/run/dstack.sock mounted?');
    const reportData = reportDataFor(keys);
    const quote = await rpc(socketPath, '/GetQuote', { report_data: reportData });
    let app = {};
    try {
        const info = await rpc(socketPath, '/Info', {});
        const tcb = typeof info.tcb_info === 'string' ? JSON.parse(info.tcb_info) : (info.tcb_info || {});
        app = { appId: info.app_id || null, instanceId: info.instance_id || null, composeHash: tcb.compose_hash || null };
    } catch (_e) { /* 앱 정보는 참고용 — 증명은 quote 가 한다 */ }
    return {
        type: 'dstack-tdx',
        reportData,
        quote: quote.quote,
        eventLog: quote.event_log,
        vmConfig: quote.vm_config || null,
        ...app,
    };
}

/**
 * TDX quote(v4) 안의 report_data 64바이트 — 헤더 48바이트 + TD 보고서 본문 안 520바이트 위치.
 * 하드웨어 서명 자체의 검증은 Intel DCAP(dcap-qvl) 또는 Phala 검증 API 로 한다(README).
 */
function quoteReportData(quote) {
    const buf = Buffer.from(String(quote).replace(/^0x/, ''), /^[0-9a-fA-F]+$/.test(String(quote).replace(/^0x/, '')) ? 'hex' : 'base64');
    if (buf.length < 48 + 520 + 64) throw new Error('quote too short');
    return buf.subarray(48 + 520, 48 + 520 + 64).toString('hex');
}

/**
 * /info 를 받은 쪽의 확인 — 엔진 공개키가 증명서에 묶여 있나.
 * @returns {string[]} 문제 목록 (비어 있으면 통과)
 */
function checkInfoBinding(info) {
    const errors = [];
    const a = info && info.attestation;
    if (!a) return ['no attestation (engine is not running in a TEE)'];
    const want = reportDataFor(info.keys);
    if (a.reportData !== want) errors.push('attestation reportData differs from the engine keys');
    try {
        if (!quoteReportData(a.quote).startsWith(want)) errors.push('quote report_data differs from the engine keys');
    } catch (e) { errors.push(`bad quote: ${e.message}`); }
    return errors;
}

module.exports = { reportDataFor, dstackAttestation, quoteReportData, checkInfoBinding };
