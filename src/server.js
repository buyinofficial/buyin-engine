/**
 * 엔진 서버 — 운영 서버(소켓 서버)가 HTTP 로 부른다.
 *
 *   POST /rpc                 { m: 메서드, p: 인자 } → { ok, ... }      운영 서버만 (Authorization: Bearer <TEE_RPC_TOKEN>)
 *   GET  /                    감사 보고서(markdown) — 사람·AI 가 이것만 읽어도 확인 방법과 지금 값이 나온다   누구나
 *   GET  /info                엔진 공개키·버전·증명서·기록 사슬 끝         누구나 (브라우저가 키·증명서를 직접 확인한다)
 *   GET  /records/head        기록 사슬 끝 { count, head, hands }        누구나 — 지금까지 남긴 기록의 지문
 *   GET  /review/manifest     지금 이 엔진이 싣고 도는 파일 목록과 SHA-256(sha256sum 형식) 누구나 — GitHub 커밋의 파일과 대조
 *   GET  /records/keys        엔진 키 줄 전부(뜰 때마다 하나)            누구나 — 옛 기록을 옛 키로 검증
 *   GET  /records/hand/<id>   판 기록 한 줄 (사슬 위치·해시 포함)        운영 서버만 — 지난 판의 카드가 들어 있다
 *   GET  /records?from=&limit= 사슬 줄 내보내기(백업·감사)              운영 서버만 — 콘솔은 여기서 정산서·판 기록을 가져간다(TEE 는 밖으로 연결하지 않는다)
 *   /table/...                테이블 서버 — 회원이 TEE 와 직접 게임한다 (table/http.js)
 *
 * 환경 변수
 *   TEE_MODE            dev(기본) | dstack — dstack 은 Phala Cloud(dstack) TDX 안. 뜨기 전에 증명서를 받는다
 *   TEE_PORT            기본 3900
 *   TEE_HOST            기본 127.0.0.1. 컨테이너 안에서는 0.0.0.0 (밖에서는 TEE 게이트웨이 TLS 로만 들어온다)
 *   TEE_RPC_TOKEN       /rpc 접근 토큰. dstack 모드에서는 반드시 있어야 한다(32자 이상). 암호화 환경변수로만 넣는다
 *   TEE_RECORD_DIR      판 기록 보관 폴더(TEE 데이터 디스크). dstack 모드에서는 반드시 있어야 한다
 *   TEE_CONSOLE_KEY     콘솔 좌석표 공개키(JWK JSON). 있으면 테이블 서버를 켠다. 배포 설정(측정됨)에 공개로 둔다
 *   TEE_ALLOW_UNSIGNED  1 이면 키 없는 좌석의 평문 카드·서명 없는 액션 허용 (시험 전용, dev 모드만)
 *
 * 토큰은 "누가 RPC 를 부르나"만 정한다. 토큰이 있어도 카드를 보거나 회원 서명 없이 칩을 움직일 수는 없다(RULES.md 3장).
 *
 * 테이블 모드(TEE_CONSOLE_KEY 가 있을 때): 판은 전부 이 TEE 안의 테이블 서버가 돌린다. 그래서 /rpc 는 'info' 말고 모두 닫는다
 * — 운영 서버가 판을 열거나, 액션을 넣거나, 회원 키를 바꿔 끼우거나, 판을 무효로 하는 길이 없다.
 * 운영 서버에 남는 엔진 길은 끝난 판의 기록 읽기(/records, 토큰)뿐이다. 진행 중인 판은 사슬에 없다.
 */

const http = require('http');
const crypto = require('crypto');
const Engine = require('./Engine');
const { dstackAttestation } = require('./attest');
const { RecordStore } = require('./store');
const { auditReport } = require('./audit');
const C = require('./crypto');
const { TableServer } = require('./table/TableServer');
const { tableRoutes } = require('./table/http');

const MODE = process.env.TEE_MODE || 'dev';
const PORT = Number(process.env.TEE_PORT || 3900);
const HOST = process.env.TEE_HOST || '127.0.0.1';
const TOKEN = process.env.TEE_RPC_TOKEN || '';
const RECORD_DIR = process.env.TEE_RECORD_DIR || '';
const MAX_BODY = 1024 * 1024;
const CONSOLE_KEY = process.env.TEE_CONSOLE_KEY ? C.importPublicJwk(JSON.parse(process.env.TEE_CONSOLE_KEY)) : null;

if (MODE !== 'dev' && MODE !== 'dstack') throw new Error(`unknown TEE_MODE ${MODE}`);
if (MODE === 'dstack' && TOKEN.length < 32) throw new Error('TEE_RPC_TOKEN (32+ chars) is required in dstack mode');
if (MODE === 'dstack' && !RECORD_DIR) throw new Error('TEE_RECORD_DIR is required in dstack mode — hand records stay in the TEE');

// 기록 보관소를 먼저 연다 — 사슬이 깨져 있으면 여기서 멈춘다(뜨지 않는다)
const store = RECORD_DIR ? new RecordStore(RECORD_DIR) : null;

let attestation = null;
const engine = new Engine({
    allowUnsigned: process.env.TEE_ALLOW_UNSIGNED === '1',
    mode: MODE,
    attest: MODE === 'dstack' ? () => attestation : undefined,
    onRecord: store ? (record, sig) => { store.appendHand(record, sig); } : undefined,
});

const tokenHash = TOKEN ? crypto.createHash('sha256').update(TOKEN).digest() : null;
function authorized(req) {
    if (!tokenHash) return true;
    const h = String(req.headers.authorization || '');
    const given = h.startsWith('Bearer ') ? h.slice(7) : '';
    return crypto.timingSafeEqual(crypto.createHash('sha256').update(given).digest(), tokenHash);
}

// 공개 GET 은 어느 사이트의 브라우저에서도 읽을 수 있다(쿠키 없음) — 회원 화면이 엔진을 직접 확인한다
const PUBLIC_HEADERS = { 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' };

function send(res, code, obj, extra) {
    const body = JSON.stringify(obj);
    res.writeHead(code, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), ...(extra || {}) });
    res.end(body);
}

/**
 * 지금 도는 파일 목록 — package.json 과 src/ 아래 모든 파일의 SHA-256 (sha256sum 출력과 같은 모양).
 * GitHub 의 그 커밋에서 `sha256sum package.json $(git ls-files src)` 를 돌린 결과와 같아야 한다. 뜰 때 한 번 계산한다.
 */
const fs = require('fs');
const path = require('path');
const MANIFEST = (() => {
    const root = path.join(__dirname, '..');
    const files = ['package.json'];
    const walk = (d) => { for (const f of fs.readdirSync(path.join(root, d), { withFileTypes: true })) { const r = d + '/' + f.name; if (f.isDirectory()) walk(r); else files.push(r); } };
    walk('src');
    files.sort();
    const lines = files.map((f) => `${crypto.createHash('sha256').update(fs.readFileSync(path.join(root, f))).digest('hex')}  ${f}`);
    const body = lines.join('\n') + '\n';
    return { body, treeHash: crypto.createHash('sha256').update(body).digest('hex'), count: files.length };
})();

function info() {
    const i = engine.call('info');
    const out = { ...i, review: { files: MANIFEST.count, treeHash: MANIFEST.treeHash } };
    return store ? { ...out, records: store.headInfo() } : out;
}

function handleGet(req, res) {
    const u = new URL(req.url, 'http://engine');
    const p = u.pathname;
    if (p === '/info') return send(res, 200, info(), PUBLIC_HEADERS);
    if (p === '/' || p === '/audit') {
        // 사람·AI 가 읽는 감사 보고서 (평문 markdown) — 값은 /info 와 같다
        const base = `https://${String(req.headers.host || '').replace(/[^\w.:-]/g, '')}`;
        const text = auditReport(engine.call('info'), store ? store.headInfo() : null, store ? store.engineKeys().length : 0, base, { tableMode: !!tables, review: { files: MANIFEST.count, treeHash: MANIFEST.treeHash } });
        res.writeHead(200, { 'Content-Type': 'text/markdown; charset=utf-8', ...PUBLIC_HEADERS });
        return res.end(text);
    }
    if (p === '/review/manifest') {
        res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', ...PUBLIC_HEADERS });
        return res.end(MANIFEST.body);
    }
    if (p === '/records/head') return store ? send(res, 200, { ok: true, ...store.headInfo() }, PUBLIC_HEADERS) : send(res, 404, { ok: false, error: 'no record store' }, PUBLIC_HEADERS);
    if (p === '/records/keys') return store ? send(res, 200, { ok: true, keys: store.engineKeys() }, PUBLIC_HEADERS) : send(res, 404, { ok: false, error: 'no record store' }, PUBLIC_HEADERS);
    const rc = p.match(/^\/records\/receipt\/([A-Za-z0-9_.:-]{1,128})$/);
    if (rc) {
        if (!store) return send(res, 404, { ok: false, error: 'no record store' }, PUBLIC_HEADERS);
        const r = store.receipt(rc[1]);
        return r ? send(res, 200, { ok: true, receipt: r, head: store.headInfo() }, PUBLIC_HEADERS) : send(res, 404, { ok: false, error: 'not found' }, PUBLIC_HEADERS);
    }
    if (p.startsWith('/records')) {
        if (!authorized(req)) return send(res, 401, { ok: false, error: 'unauthorized' });
        if (!store) return send(res, 404, { ok: false, error: 'no record store' });
        const m = p.match(/^\/records\/hand\/([A-Za-z0-9_.:-]{1,128})$/);
        if (m) {
            const entry = store.getHand(m[1]);
            return entry ? send(res, 200, { ok: true, entry }) : send(res, 404, { ok: false, error: 'not found' });
        }
        if (p === '/records') {
            const from = Math.max(0, Math.floor(Number(u.searchParams.get('from')) || 0));
            const limit = Math.min(1000, Math.max(1, Math.floor(Number(u.searchParams.get('limit')) || 100)));
            return send(res, 200, { ok: true, from, entries: store.range(from, limit), head: store.headInfo() });
        }
    }
    return send(res, 404, { ok: false, error: 'not found' });
}

/**
 * 내 판 기록 — 운영 토큰 없이, 그 판에 앉았던 회원 키의 서명으로만 준다.
 *   { sig: 회원 서명 공개키 JWK, ts, proof = sign(msgMine(지문, ts, handId)), handId? }
 *   handId 가 없으면 이 키로 앉았던 판 목록(최근 50), 있으면 그 판의 사슬 줄 전체(카드 포함 — 판이 끝난 뒤의 기록뿐이다)
 */
const MINE_WINDOW_MS = 5 * 60 * 1000;
function handleMine(req, res) {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => { size += c.length; if (size > 16 * 1024) req.destroy(); else chunks.push(c); });
    req.on('end', () => {
        let m;
        try { m = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch (_e) { return send(res, 400, { ok: false, error: 'bad json' }); }
        if (!store) return send(res, 404, { ok: false, error: 'no record store' });
        let fp;
        try {
            const key = C.importPublicJwk(m.sig);
            fp = C.fingerprint(m.sig);
            if (!(Math.abs(Date.now() - Number(m.ts)) < MINE_WINDOW_MS)) return send(res, 400, { ok: false, error: 'stale request' });
            if (!C.verify(key, C.msgMine(fp, m.ts, m.handId), m.proof)) return send(res, 401, { ok: false, error: 'bad proof' });
        } catch (_e) { return send(res, 400, { ok: false, error: 'bad key' }); }
        const mine = store.handsOfKey(fp);
        if (!m.handId) {
            const hands = mine.map((id) => store.receipt(id)).filter(Boolean);
            return send(res, 200, { ok: true, sigFp: fp, hands });
        }
        if (!mine.includes(String(m.handId))) return send(res, 404, { ok: false, error: 'not your hand' });
        return send(res, 200, { ok: true, entry: store.getHand(m.handId) });
    });
}

let tables = null, tableHandler = null;
/** 테이블 모드에서 운영 서버가 부를 수 있는 엔진 메서드 — 공개 정보뿐 */
const RPC_IN_TABLE_MODE = new Set(['info']);

const server = http.createServer((req, res) => {
    if (tableHandler && tableHandler(req, res, new URL(req.url, 'http://engine'))) return;
    if (req.method === 'OPTIONS') { res.writeHead(204, { ...PUBLIC_HEADERS, 'Access-Control-Allow-Methods': 'GET' }); return res.end(); }
    if (req.method === 'GET') return handleGet(req, res);
    if (req.method === 'POST' && req.url === '/records/mine') return handleMine(req, res);
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
        if (tables && !RPC_IN_TABLE_MODE.has(String(msg && msg.m))) {
            return send(res, 403, { ok: false, code: 'table-mode', error: 'game RPC is closed: every hand runs inside the TEE table server (src/table)' });
        }
        send(res, 200, engine.call(msg && msg.m, msg && msg.p));
    });
});

server.keepAliveTimeout = 65000;

async function start() {
    if (MODE === 'dstack') {
        // 증명서 없이 뜨지 않는다 — 증명서 없는 엔진 키는 믿을 근거가 없다
        attestation = await dstackAttestation(engine.call('info').keys);
    }
    // 이번에 뜬 엔진의 키를 사슬에 남긴다 — 이 키로 서명될 판 기록을 나중에도 검증할 수 있게
    if (store) store.appendEngineKey(engine.call('info'));
    // 테이블 서버 — 사슬에서 정산 안 된 좌석을 먼저 정산하고(재시작 복구) 연다
    if (CONSOLE_KEY) {
        tables = new TableServer({ engine, store, consoleKey: CONSOLE_KEY });
        setInterval(() => tables.sweep(), 30000).unref();
    }
    // 테이블 화면·검증 화면은 언제나 TEE 가 내보낸다(테이블 서버가 꺼져 있으면 앉기·명령만 닫힌다)
    tableHandler = tableRoutes(tables);
    server.listen(PORT, HOST, () => {
        const i = info();
        console.log(`[tee-engine] ${i.name} ${i.version} mode=${i.mode} listening ${HOST}:${PORT} sigFp=${i.keys.sigFp}`
            + `${attestation ? ` reportData=${attestation.reportData}` : ''}${tokenHash ? ' rpc=token' : ''}`
            + `${store ? ` records=${store.count}` : ''}${tables ? ' tables=on' : ''}${engine.allowUnsigned ? ' ALLOW_UNSIGNED' : ''}`);
    });
}

start().catch((e) => {
    console.error(`[tee-engine] start failed: ${e.message}`);
    process.exit(1);
});
