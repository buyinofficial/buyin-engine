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

/** 기본 보안 — 모든 응답에 보안 헤더, 요청 폭주는 429 */
test('서버: 보안 헤더(nosniff·no-referrer)와 요청 횟수 제한(429)', async () => {
    const port = 3980 + Math.floor(Math.random() * 9);
    const srv = spawn(process.execPath, [path.join(__dirname, '..', 'src', 'server.js')], {
        env: { ...process.env, TEE_MODE: 'dev', TEE_PORT: String(port), TEE_RPC_TOKEN: 'test-token', TEE_RECORD_DIR: require('fs').mkdtempSync(path.join(require('os').tmpdir(), 'buyin-sec-')) },
        stdio: 'ignore',
    });
    try {
        let info;
        for (let i = 0; i < 40; i++) { try { info = await fetch(`http://127.0.0.1:${port}/info`); break; } catch (_e) { await new Promise((r) => setTimeout(r, 100)); } }
        assert.strictEqual(info.headers.get('x-content-type-options'), 'nosniff');
        assert.strictEqual(info.headers.get('referrer-policy'), 'no-referrer');
        const codes = await Promise.all(Array.from({ length: 80 }, () => fetch(`http://127.0.0.1:${port}/records/mine`, { method: 'POST', body: '{}' }).then((r) => r.status)));
        assert.ok(codes.includes(429), 'burst of /records/mine is limited');
    } finally {
        srv.kill();
    }
});

/** 기록 관리 — 콘솔이 /records?from=N 으로 읽으면 N 앞은 콘솔에 있다. 그 위치와 용량·보관 기간이 공개된다 */
test('서버: 콘솔이 읽은 위치·기록 용량·보관 기간이 /records/head 와 /info 에 공개된다', async () => {
    const port = 3970 + Math.floor(Math.random() * 9);
    const srv = spawn(process.execPath, [path.join(__dirname, '..', 'src', 'server.js')], {
        env: { ...process.env, TEE_MODE: 'dev', TEE_PORT: String(port), TEE_RPC_TOKEN: 'test-token', TEE_RETENTION_DAYS: '30', TEE_RECORD_DIR: require('fs').mkdtempSync(path.join(require('os').tmpdir(), 'buyin-ret-')) },
        stdio: 'ignore',
    });
    try {
        let head;
        for (let i = 0; i < 40; i++) { try { head = await (await fetch(`http://127.0.0.1:${port}/records/head`)).json(); break; } catch (_e) { await new Promise((r) => setTimeout(r, 100)); } }
        assert.strictEqual(head.retentionDays, 30);
        assert.strictEqual(head.storage.acked, 0);
        assert.ok(head.storage.bytes > 0, 'engine key line is stored');
        // 토큰 없이 읽으면 위치가 바뀌지 않는다
        assert.strictEqual((await fetch(`http://127.0.0.1:${port}/records?from=1`)).status, 401);
        const r = await fetch(`http://127.0.0.1:${port}/records?from=1`, { headers: { Authorization: 'Bearer test-token' } });
        assert.strictEqual(r.status, 200);
        const info = await (await fetch(`http://127.0.0.1:${port}/info`)).json();
        assert.strictEqual(info.records.storage.acked, 1);
        assert.strictEqual(info.records.retentionDays, 30);
    } finally {
        srv.kill();
    }
});
