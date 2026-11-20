/**
 * [WS_0_10_10] 테이블 웹소켓(/table/ws) — 실제 엔진 프로세스를 띄워 브라우저처럼 붙는다.
 *   1) 화면 CSP 가 이 TEE 의 wss:// 를 허용하고 다른 곳은 늘지 않았다
 *   2) 토큰 없이·틀린 토큰·인증 전 명령은 닫힌다(4401 / 1008)
 *   3) 두 명이 웹소켓만으로 앉아(키·무작위 값·준비·액션) 판을 끝까지 치고, 판 기록이 남는다
 *   4) 차례가 아닌 액션은 연결을 끊지 않고 { ok:false, code:'turn' } 로 답한다
 *   5) 가리지 않은 프레임·너무 큰 프레임·이진 프레임은 닫는다, ping 에는 pong
 *   6) 다른 업그레이드 주소는 끊는다
 */
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');
const { spawn } = require('child_process');
const C = require('../src/crypto');
const { signTicket } = require('../src/table/ticket');

const HAS_WS = typeof WebSocket === 'function';   // Node 22+

async function startEngine() {
    const consoleKeys = C.generateKeyPair();
    const port = 4100 + Math.floor(Math.random() * 400);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'buyin-ws-'));
    const srv = spawn(process.execPath, [path.join(__dirname, '..', 'src', 'server.js')], {
        env: { ...process.env, TEE_MODE: 'dev', TEE_PORT: String(port), TEE_RPC_TOKEN: 'test-token', TEE_RECORD_DIR: dir,
            TEE_CONSOLE_KEY: JSON.stringify(C.publicJwk(consoleKeys.publicKey)), TEE_CONSOLE_URL: '' },
        stdio: ['ignore', 'ignore', 'pipe'],
    });
    let err = '';
    srv.stderr.on('data', (c) => { err += c; });
    for (let i = 0; i < 150; i++) {
        try { await fetch(`http://127.0.0.1:${port}/info`); break; } catch (_e) { await new Promise((r) => setTimeout(r, 100)); }
    }
    return { port, consoleKeys, dir, srv, stderr: () => err };
}

const ROOM = { id: 'r-ws', name: 'WS', sb: 1, bb: 2, maxPlayers: 6, rake: { percent: 5, minPot: 4 }, turnSec: 20, endsAt: 0 };

function ticketFor(eng, i) {
    return signTicket({ v: 1, tid: 'tid_ws_' + i + '_' + crypto.randomBytes(4).toString('hex'), exp: Date.now() + 60000, room: ROOM,
        player: { sessionId: 'sess_ws_' + i + '_' + crypto.randomBytes(4).toString('hex'), odcId: 'w' + i, nickname: 'W' + i }, buyIn: 100, currency: 'USDT' },
    eng.consoleKeys.privateKey);
}

/** 앉기(POST /table/join) — 화면이 하는 것과 같다 */
async function join(eng, i) {
    const ticket = ticketFor(eng, i);
    const tb = JSON.parse(Buffer.from(ticket.split('.')[0], 'base64url'));
    const sig = C.generateKeyPair(), ecdh = C.generateKeyPair();
    const sigJ = C.publicJwk(sig.publicKey), ecdhJ = C.publicJwk(ecdh.publicKey);
    const r = await (await fetch(`http://127.0.0.1:${eng.port}/table/join`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ticket, auth: { sig: sigJ, proof: C.sign(sig.privateKey, C.msgJoin(tb.tid, C.fingerprint(sigJ))) } }) })).json();
    assert.ok(r.ok, JSON.stringify(r));
    return { ...r, sig, ecdh, sigJ, ecdhJ, odcId: tb.player.odcId };
}

/** 웹소켓 손님 — 이벤트를 모으고, 명령은 id 로 답을 기다린다 */
function wsClient(port) {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/table/ws`);
    const c = { ws, events: [], waiters: [], pend: new Map(), seq: 0, closed: null };
    ws.onmessage = (e) => {
        const m = JSON.parse(e.data);
        if (m.ev === 'res') { const f = c.pend.get(m.id); if (f) { c.pend.delete(m.id); f(m.res); } return; }
        c.events.push(m);
        c.waiters = c.waiters.filter((w) => !(w.pred(m) && (w.resolve(m), true)));
    };
    ws.onclose = (e) => { c.closed = { code: e.code, reason: e.reason }; for (const w of c.waiters) w.resolve(null); c.waiters = []; };
    c.opened = new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
    c.send = (obj) => ws.send(JSON.stringify(obj));
    c.cmd = (type, m = {}) => new Promise((resolve) => { const id = ++c.seq; c.pend.set(id, resolve); c.send({ ...m, t: 'cmd', id, type }); });
    c.wait = (pred, ms = 15000) => {
        const hit = c.events.find(pred);
        if (hit) return Promise.resolve(hit);
        return new Promise((resolve) => { const w = { pred, resolve }; c.waiters.push(w); setTimeout(() => { c.waiters = c.waiters.filter((x) => x !== w); resolve(null); }, ms); });
    };
    c.waitClose = async (ms = 5000) => { for (let i = 0; i < ms / 50 && !c.closed; i++) await new Promise((r) => setTimeout(r, 50)); return c.closed; };
    return c;
}

/** 손으로 웹소켓 핸드셰이크 — 규칙을 어기는 프레임을 보내 보기 위해 */
function rawWs(port, pathName = '/table/ws') {
    return new Promise((resolve, reject) => {
        const s = net.connect(port, '127.0.0.1');
        const key = crypto.randomBytes(16).toString('base64');
        let buf = Buffer.alloc(0), upgraded = false;
        const st = { s, frames: [], closed: false, status: '' };
        s.on('data', (d) => {
            buf = Buffer.concat([buf, d]);
            if (!upgraded) {
                const i = buf.indexOf('\r\n\r\n');
                if (i < 0) return;
                st.status = buf.subarray(0, buf.indexOf('\r\n')).toString();
                buf = buf.subarray(i + 4); upgraded = true;
                resolve(st);
            }
            while (buf.length >= 2) {
                let len = buf[1] & 0x7f, off = 2;
                if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); off = 4; }
                if (buf.length < off + len) return;
                st.frames.push({ op: buf[0] & 0x0f, data: buf.subarray(off, off + len) });
                buf = buf.subarray(off + len);
            }
        });
        s.on('close', () => { st.closed = true; if (!upgraded) resolve(st); });
        s.on('error', reject);
        s.write(`GET ${pathName} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`);
    });
}
function frame(op, payload, { mask = true, fin = true } = {}) {
    const p = Buffer.from(payload);
    const n = p.length;
    const b0 = (fin ? 0x80 : 0) | op, m = mask ? 0x80 : 0;
    let head;
    if (n < 126) head = Buffer.from([b0, m | n]);
    else if (n < 65536) { head = Buffer.from([b0, m | 126, 0, 0]); head.writeUInt16BE(n, 2); }
    else { head = Buffer.alloc(10); head[0] = b0; head[1] = m | 127; head.writeUInt32BE(0, 2); head.writeUInt32BE(n, 6); }
    if (!mask) return Buffer.concat([head, p]);
    const k = crypto.randomBytes(4);
    const out = Buffer.from(p); for (let i = 0; i < n; i++) out[i] ^= k[i & 3];
    return Buffer.concat([head, k, out]);
}
const closeCode = (st) => { const f = st.frames.find((x) => x.op === 0x8); return f && f.data.length >= 2 ? f.data.readUInt16BE(0) : null; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('웹소켓: 화면 CSP 는 이 TEE 의 wss:// 만 더한다', async () => {
    const eng = await startEngine();
    try {
        const r = await fetch(`http://127.0.0.1:${eng.port}/table/`);
        const csp = r.headers.get('content-security-policy');
        const connect = csp.split(';').map((x) => x.trim()).find((x) => x.startsWith('connect-src'));
        assert.strictEqual(csp.split(';').map((x) => x.trim()).find((x) => x.startsWith('frame-src')), 'frame-src https://buyinholdem.com', 'only the lobby buy-in page may be framed');   // [REBUY_IN_ROOM_0_10_15]
        assert.strictEqual(connect, `connect-src 'self' wss://127.0.0.1:${eng.port} https://resource.buyinholdem.com/buyin-table/sfx/ https://resource.buyinholdem.com/assets/table_skins/skins.json https://buyinholdem.com/chat-translate`);
        // Host 머리에 이상한 글자가 오면 wss 를 넣지 않는다(머리 주입 막기)
        const st = await new Promise((resolve) => {
            const s = net.connect(eng.port, '127.0.0.1'); let b = '';
            s.on('data', (d) => { b += d; }); s.on('close', () => resolve(b));
            s.write(`GET /table/ HTTP/1.1\r\nHost: evil.example;script-src *\r\nConnection: close\r\n\r\n`);
        });
        assert.ok(/connect-src 'self' https:\/\/resource/.test(st), 'bad Host → plain connect-src');
    } finally { eng.srv.kill(); }
});

test('웹소켓: 인증 — 틀린 토큰 4401, 인증 전 명령 1008, 깨진 JSON 1007', { skip: !HAS_WS && 'no global WebSocket' }, async () => {
    const eng = await startEngine();
    try {
        const a = wsClient(eng.port); await a.opened;
        a.send({ t: 'auth', token: 'nope' });
        const ev = await a.wait((m) => m.ev === 'error');
        assert.strictEqual(ev.data.code, 'auth');
        assert.strictEqual((await a.waitClose()).code, 4401);

        const b = wsClient(eng.port); await b.opened;
        b.send({ t: 'cmd', id: 1, type: 'act' });
        assert.strictEqual((await b.waitClose()).code, 1008);

        const c = wsClient(eng.port); await c.opened;
        c.ws.send('{not json');
        assert.strictEqual((await c.waitClose()).code, 1007);
    } finally { eng.srv.kill(); }
});

test('웹소켓: 두 명이 웹소켓만으로 판을 끝까지 친다(키·무작위 값·준비·액션), 차례 아닌 액션은 code turn', { skip: !HAS_WS && 'no global WebSocket', timeout: 60000 }, async () => {
    const eng = await startEngine();
    try {
        const players = [];
        for (let i = 0; i < 2; i++) {
            const j = await join(eng, i);
            const c = wsClient(eng.port); await c.opened;
            c.send({ t: 'auth', token: j.token });
            const snap = await c.wait((m) => m.ev === 'snapshot');
            assert.ok(snap, 'snapshot after auth');
            const k = await c.cmd('keys', { sig: j.sigJ, ecdh: j.ecdhJ,
                proof: C.sign(j.sig.privateKey, C.msgRegister(j.tableId, j.odcId, C.fingerprint(j.sigJ), C.fingerprint(j.ecdhJ))) });
            assert.ok(k.ok, 'keys ' + JSON.stringify(k));
            const ent = async (commit) => {
                const hex = crypto.randomBytes(32).toString('hex');
                return c.cmd('entropy', { seedCommit: commit, hex, sig: C.sign(j.sig.privateKey, C.msgEntropy(j.tableId, commit, hex)) });
            };
            const e1 = await ent(j.seedCommit);
            assert.ok(e1.ok, 'entropy ' + JSON.stringify(e1));
            players.push({ j, c, ent });
        }
        for (const p of players) { const r = await p.c.cmd('ready'); assert.ok(r.ok, 'ready ' + JSON.stringify(r)); }

        // 판이 열린다(준비 3초 카운트다운 뒤)
        const hand = await players[0].c.wait((m) => m.ev === 'hand' && m.data && m.data.handId, 20000);
        assert.ok(hand, 'hand started');
        const handId = hand.data.handId;
        for (const p of players) assert.ok(await p.c.wait((m) => m.ev === 'hole' && m.data.handId === handId && m.data.envelope), 'own sealed hole cards');

        // 차례가 아닌 쪽의 액션 — 연결은 그대로, 답은 code turn
        const t0 = await players[0].c.wait((m) => m.ev === 'turn' && m.data.handId === handId);
        const other = players.find((p) => p.j.seat !== t0.data.seat);
        const bad = await other.c.cmd('act', { q: t0.data.q, action: 'CALL', amount: 0, sig: C.sign(other.j.sig.privateKey, C.msgAction(handId, t0.data.q, 'CALL', 0)) });
        assert.strictEqual(bad.ok, false); assert.strictEqual(bad.code, 'turn');
        assert.strictEqual(other.c.closed, null, 'connection stays open after a refused action');

        // 차례마다 콜/체크 — 결과(result)가 올 때까지
        const seen = new Set();
        const deadline = Date.now() + 40000;
        let result = null;
        while (!result && Date.now() < deadline) {
            result = players[0].c.events.find((m) => m.ev === 'result' && m.data && m.data.handId === handId) || null;
            if (result) break;
            const turns = players[0].c.events.filter((m) => m.ev === 'turn' && m.data.handId === handId);
            const tr = turns[turns.length - 1];
            if (tr && !seen.has(tr.data.q)) {
                seen.add(tr.data.q);
                const p = players.find((x) => x.j.seat === tr.data.seat);
                const action = tr.data.toCall > 0 ? 'CALL' : 'CHECK';
                const t1 = Date.now();
                const r = await p.c.cmd('act', { q: tr.data.q, action, amount: 0, sig: C.sign(p.j.sig.privateKey, C.msgAction(handId, tr.data.q, action, 0)) });
                assert.ok(r.ok, `act ${action} q${tr.data.q} ` + JSON.stringify(r));
                assert.ok(Date.now() - t1 < 1000, 'local round trip under 1 s');
            }
            await sleep(30);
        }
        assert.ok(result, 'hand result arrived over the websocket');
        assert.ok(seen.size >= 4, 'several turns acted over the websocket (' + seen.size + ')');
        // 판 기록이 사슬에 남았다
        await sleep(300);
        const head = await (await fetch(`http://127.0.0.1:${eng.port}/records/head`)).json();
        assert.ok(head.count >= 2, 'record chain grew: ' + JSON.stringify(head));
        // 다음 판 씨앗 약속에도 무작위 값을 낼 수 있다(같은 연결로)
        if (hand.data.nextSeedCommit) { const e2 = await players[0].ent(hand.data.nextSeedCommit); assert.ok(e2.ok || e2.code, 'entropy reply'); }
        for (const p of players) p.c.ws.close();
    } finally { eng.srv.kill(); }
});

test('웹소켓: 규칙을 어기는 프레임은 닫는다(가리지 않음 1002·너무 큼 1009·이진 1003), ping → pong, 다른 주소는 끊는다', async () => {
    const eng = await startEngine();
    try {
        const a = await rawWs(eng.port);
        assert.match(a.status, /101/);
        a.s.write(frame(0x9, 'hi'));                         // ping
        await sleep(200);
        const pong = a.frames.find((f) => f.op === 0xA);
        assert.ok(pong && pong.data.toString() === 'hi', 'pong echoes ping');
        a.s.write(frame(0x1, '{"t":"ka"}', { mask: false }));  // 가리지 않은 프레임
        await sleep(300);
        assert.strictEqual(closeCode(a), 1002);

        const b = await rawWs(eng.port);
        b.s.write(frame(0x1, 'x'.repeat(70 * 1024)));          // 64KB 넘음
        await sleep(300);
        assert.strictEqual(closeCode(b), 1009);

        const c = await rawWs(eng.port);
        c.s.write(frame(0x2, Buffer.from([1, 2, 3])));          // 이진
        await sleep(300);
        assert.strictEqual(closeCode(c), 1003);

        const d = await rawWs(eng.port);
        d.s.write(Buffer.concat([frame(0x1, '{"t":', { fin: false }), frame(0x0, '"ka"}')]));   // 조각 메시지는 이어 받는다
        await sleep(300);
        assert.strictEqual(closeCode(d), null, 'fragmented text accepted');
        d.s.destroy();

        const e = await rawWs(eng.port, '/records/head');
        await sleep(200);
        assert.ok(e.closed && !/101/.test(e.status), 'other upgrade paths are dropped');
    } finally { eng.srv.kill(); }
});

test('[WS_RID_0_10_10] 요청 번호 rid — 명령 내용의 id(이모티콘 종류)가 덮이지 않는다, 예전 id 요청 번호도 답은 온다', { skip: !HAS_WS && 'no global WebSocket', timeout: 30000 }, async () => {
    const eng = await startEngine();
    try {
        const cs = [];
        for (let i = 0; i < 2; i++) {
            const j = await join(eng, i);
            const c = wsClient(eng.port); await c.opened;
            c.send({ t: 'auth', token: j.token });
            assert.ok(await c.wait((m) => m.ev === 'snapshot'));
            cs.push(c);
        }
        const res = await new Promise((resolve) => { cs[0].pend.set(77, resolve); cs[0].send({ t: 'cmd', rid: 77, type: 'emote', id: 'angry' }); });
        assert.strictEqual(res.ok, true, '이모티콘 종류(id)가 그대로 간다');
        const ev = await cs[1].wait((m) => m.ev === 'emote');
        assert.ok(ev && ev.data.id === 'angry', '같은 방에 같은 종류');
        // 예전 화면(id = 요청 번호) — 답은 그 번호로 온다
        const old = await cs[0].cmd('chat', { text: 'hi' });
        assert.ok(old && (old.ok || old.code), '예전 방식에도 답');
    } finally { eng.srv.kill(); }
});
