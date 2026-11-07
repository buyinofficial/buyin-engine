const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { spawn } = require('child_process');
const C = require('../src/crypto');

/** 운영 서버가 엔진을 부르는 길은 없다 — /rpc 는 토큰이 있어도 404, 기록 내보내기도 404 */
test('서버: 운영 서버 경로가 없다 — /rpc(판 열기·키 등록·액션·info)와 /records 내보내기는 404', async () => {
    const k = C.generateKeyPair();
    const port = 3990 + Math.floor(Math.random() * 9);
    const srv = spawn(process.execPath, [path.join(__dirname, '..', 'src', 'server.js')], {
        env: { ...process.env, TEE_MODE: 'dev', TEE_PORT: String(port), TEE_RPC_TOKEN: 'test-token', TEE_CONSOLE_KEY: JSON.stringify(C.publicJwk(k.publicKey)), TEE_RECORD_DIR: '' },
        stdio: 'ignore',
    });
    try {
        for (let i = 0; i < 150; i++) { try { await fetch(`http://127.0.0.1:${port}/info`); break; } catch (_e) { await new Promise((r) => setTimeout(r, 100)); } }
        for (const m of ['info', 'openTable', 'registerKeys', 'startHand', 'act', 'finish', 'abortHand', 'closeTable']) {
            const r = await fetch(`http://127.0.0.1:${port}/rpc`, { method: 'POST', headers: { Authorization: 'Bearer test-token' }, body: JSON.stringify({ m, p: {} }) });
            assert.strictEqual(r.status, 404, m);
        }
        const ex = await fetch(`http://127.0.0.1:${port}/records?from=0`, { headers: { Authorization: 'Bearer test-token' } });
        assert.strictEqual(ex.status, 404);
    } finally {
        srv.kill();
    }
});

/** 기본 보안 — 모든 응답에 보안 헤더, 요청 폭주는 429 */
test('서버: 보안 헤더(nosniff·no-referrer)와 요청 횟수 제한(429)', async () => {
    const port = 3980 + Math.floor(Math.random() * 9);
    const srv = spawn(process.execPath, [path.join(__dirname, '..', 'src', 'server.js')], {
        env: { ...process.env, TEE_MODE: 'dev', TEE_PORT: String(port), TEE_RPC_TOKEN: 'test-token', TEE_RECORD_DIR: require('fs').mkdtempSync(path.join(require('os').tmpdir(), 'buyin-sec-')) },
        stdio: 'ignore',
    });
    try {
        let info;
        for (let i = 0; i < 150; i++) { try { info = await fetch(`http://127.0.0.1:${port}/info`); break; } catch (_e) { await new Promise((r) => setTimeout(r, 100)); } }
        assert.strictEqual(info.headers.get('x-content-type-options'), 'nosniff');
        assert.strictEqual(info.headers.get('referrer-policy'), 'no-referrer');
        const codes = await Promise.all(Array.from({ length: 80 }, () => fetch(`http://127.0.0.1:${port}/records/mine`, { method: 'POST', body: '{}' }).then((r) => r.status)));
        assert.ok(codes.includes(429), 'burst of /records/mine is limited');
    } finally {
        srv.kill();
    }
});
