const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { spawn } = require('child_process');
const C = require('../src/crypto');

/** 테이블 모드(TEE_CONSOLE_KEY)에서는 운영 서버의 게임 RPC 가 닫힌다 — 토큰이 있어도 판을 열거나 액션·키를 넣을 수 없다 */
test('서버: 테이블 모드에서 /rpc 는 info 만 — 판 열기·키 등록·액션은 403', async () => {
    const k = C.generateKeyPair();
    const port = 3990 + Math.floor(Math.random() * 9);
    const srv = spawn(process.execPath, [path.join(__dirname, '..', 'src', 'server.js')], {
        env: { ...process.env, TEE_MODE: 'dev', TEE_PORT: String(port), TEE_RPC_TOKEN: 'test-token', TEE_CONSOLE_KEY: JSON.stringify(C.publicJwk(k.publicKey)), TEE_RECORD_DIR: '' },
        stdio: 'ignore',
    });
    try {
        const call = async (m) => {
            for (let i = 0; i < 40; i++) {
                try {
                    const r = await fetch(`http://127.0.0.1:${port}/rpc`, { method: 'POST', headers: { Authorization: 'Bearer test-token' }, body: JSON.stringify({ m, p: {} }) });
                    return { status: r.status, body: await r.json() };
                } catch (_e) { await new Promise((res) => setTimeout(res, 100)); }
            }
            throw new Error('server did not start');
        };
        assert.strictEqual((await call('info')).status, 200);
        for (const m of ['openTable', 'registerKeys', 'startHand', 'act', 'board', 'runout', 'finish', 'abortHand', 'closeTable']) {
            const r = await call(m);
            assert.strictEqual(r.status, 403, m);
            assert.strictEqual(r.body.code, 'table-mode', m);
        }
    } finally {
        srv.kill();
    }
});
