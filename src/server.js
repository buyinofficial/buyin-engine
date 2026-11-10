/**
 * 엔진 서버 — 운영 서버(소켓 서버)가 HTTP 로 부른다.
 *
 *   GET  /                    감사 보고서(markdown) — 사람·AI 가 이것만 읽어도 확인 방법과 지금 값이 나온다   누구나
 *   GET  /info                엔진 공개키·버전·증명서·기록 사슬 끝         누구나 (브라우저가 키·증명서를 직접 확인한다)
 *   GET  /records/head        기록 사슬 끝 { count, head, hands, first, sent, storage } 누구나 — 지금까지 남긴 기록의 지문·용량
 *   GET  /review/manifest     지금 이 엔진이 싣고 도는 파일 목록과 SHA-256(sha256sum 형식) 누구나 — GitHub 커밋의 파일과 대조
 *   GET  /ai.html · /review/manifest.json   위 감사 보고서·파일 목록의 HTML·JSON 판 — 평문(markdown·text)을 못 여는 AI 웹 열람기용, 내용은 같다
 *   GET  /records/keys        엔진 키 줄 전부(뜰 때마다 하나)            누구나 — 옛 기록을 옛 키로 검증
 *   GET  /records/results, /records/finished/<id>  콘솔만(토큰) — 끝난 판만(consoleApi.js, 기록 보관소만 받는다)
 *   /table/...                테이블 서버 — 회원이 TEE 와 직접 게임한다 (table/http.js)
 *
 * 환경 변수
 *   TEE_MODE            dev(기본) | dstack — dstack 은 Phala Cloud(dstack) TDX 안. 뜨기 전에 증명서를 받는다
 *   TEE_PORT            기본 3900
 *   TEE_HOST            기본 127.0.0.1. 컨테이너 안에서는 0.0.0.0 (밖에서는 TEE 게이트웨이 TLS 로만 들어온다)
 *   TEE_RPC_TOKEN       콘솔과 엔진 사이의 토큰 — 기록을 보낼 때 붙이고, 결과 조회(/records/results) 때 확인한다. dstack 모드에서는 반드시 있어야 한다(32자 이상). 암호화 환경변수로만 넣는다
 *   TEE_RECORD_DIR      판 기록 보관 폴더(TEE 데이터 디스크). dstack 모드에서는 반드시 있어야 한다
 *   TEE_CONSOLE_KEY     콘솔 좌석표 공개키(JWK JSON). 있으면 테이블 서버를 켠다. 배포 설정(측정됨)에 공개로 둔다
 *   TEE_DISCONNECT_GRACE_MS 연결이 끊긴 좌석이 탈락하기까지(기본 60000). 배포 설정(측정됨)에 공개로 둔다
 *   TEE_CONSOLE_URL     사슬에 쓴 줄(끝난 판·정산서 등)을 보내는 콘솔 주소 — 엔진이 밖으로 연결하는 유일한 곳(outbox.js). 배포 설정(측정됨)에 공개로 둔다
 *   TEE_RETENTION_DAYS  보낸 기록을 TEE 에 두는 날 수(기본 7, 최소 1). 지난 하루 파일은 지운다. 배포 설정(측정됨)에 공개로 둔다
 *   TEE_ALLOW_UNSIGNED  1 이면 키 없는 좌석의 평문 카드·서명 없는 액션 허용 (시험 전용, dev 모드만)
 *
 *
 * 판은 전부 이 TEE 안의 테이블 서버가 돌린다(TEE_CONSOLE_KEY). 운영 서버가 엔진을 부르는 길은 없다 — 판을 열거나, 액션을 넣거나,
 * 회원 키를 바꿔 끼우거나, 기록을 꺼내 가는 경로가 없다. 엔진은 사슬에 쓴 줄(끝난 판·정산서)을 콘솔로 보낼 뿐이다(outbox.js).
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
const { RateLimiter } = require('./limits');
const { Outbox } = require('./outbox');
const { consoleRoutes } = require('./consoleApi');
const { tableReport, tableRecordHtml } = require('./tableRecord');   // [TABLE_RECORD_2026_11_10]

// 요청 폭주 막기(서비스 거부 방지) — 넘치면 429
const LIMIT = {
    mine: new RateLimiter(20, 40),     // 내 판 기록(서명 확인 비용)
    table: new RateLimiter(20, 40),    // [TABLE_RECORD_2026_11_10] 테이블 공개 기록
};
// 모든 응답에 붙는 보안 헤더
const BASE_HEADERS = { 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' };

const MODE = process.env.TEE_MODE || 'dev';
const PORT = Number(process.env.TEE_PORT || 3900);
const HOST = process.env.TEE_HOST || '127.0.0.1';
const TOKEN = process.env.TEE_RPC_TOKEN || '';
const RECORD_DIR = process.env.TEE_RECORD_DIR || '';
const CONSOLE_URL = process.env.TEE_CONSOLE_URL || '';
/** [ATTEST_LINK_2026_11_10] 이 엔진의 증명서를 Phala 탐색기에 올려 독립 확인 주소를 보여 주는 페이지(공개, 배포 설정에 있다). 엔진은 이 주소를 글로 적기만 하고 연결하지 않는다 */
const ATTEST_LINKS = process.env.TEE_ATTEST_LINKS || '';
const RETENTION_DAYS = Math.max(1, Math.floor(Number(process.env.TEE_RETENTION_DAYS) || 7));
const CONSOLE_KEY = process.env.TEE_CONSOLE_KEY ? C.importPublicJwk(JSON.parse(process.env.TEE_CONSOLE_KEY)) : null;

if (MODE !== 'dev' && MODE !== 'dstack') throw new Error(`unknown TEE_MODE ${MODE}`);
if (MODE === 'dstack' && TOKEN.length < 32) throw new Error('TEE_RPC_TOKEN (32+ chars) is required in dstack mode');
if (MODE === 'dstack' && !RECORD_DIR) throw new Error('TEE_RECORD_DIR is required in dstack mode — hand records stay in the TEE');
if (MODE === 'dstack' && !CONSOLE_KEY) throw new Error('TEE_CONSOLE_KEY is required in dstack mode — every hand runs in the TEE table server');

// 기록 보관소를 먼저 연다 — 사슬이 깨져 있으면 여기서 멈춘다(뜨지 않는다)
const store = RECORD_DIR ? new RecordStore(RECORD_DIR) : null;

let attestation = null;
let explorerReport = null;   // [ATTEST_EXPLORER_2026_11_10] Phala 탐색기 보고서 주소 — 엔진이 직접 올린다
const engine = new Engine({
    allowUnsigned: process.env.TEE_ALLOW_UNSIGNED === '1',
    mode: MODE,
    attest: MODE === 'dstack' ? () => attestation : undefined,
    onRecord: store ? (record, sig) => { store.appendHand(record, sig); } : undefined,
});


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

function engineId() {
    const i = engine.call('info');
    return { name: i.name, version: i.version, commit: i.commit, sigFp: i.keys && i.keys.sigFp };
}

function info() {
    const i = engine.call('info');
    const out = { ...i, review: { files: MANIFEST.count, treeHash: MANIFEST.treeHash } };
    return store ? { ...out, records: { ...store.headInfo(), storage: store.storage(), retentionDays: RETENTION_DAYS, consoleUrl: CONSOLE_URL || null } } : out;
}

const consoleHandler = consoleRoutes({ store, token: TOKEN, send });

function handleGet(req, res) {
    const u = new URL(req.url, 'http://engine');
    const p = u.pathname;
    if (consoleHandler(req, res, u)) return;
    if (p === '/info') return send(res, 200, info(), PUBLIC_HEADERS);
    if (p === '/' || p === '/audit' || p === '/ai.html') {
        // 사람·AI 가 읽는 감사 보고서 (평문 markdown) — 값은 /info 와 같다.
        // /ai.html 은 같은 글을 HTML 로 감싼 것 — 일부 AI 웹 열람기는 text/markdown 을 읽지 못한다.
        const base = `https://${String(req.headers.host || '').replace(/[^\w.:-]/g, '')}`;
        const text = auditReport(engine.call('info'), store ? store.headInfo() : null, store ? store.engineKeys().length : 0, base, { tableMode: !!tables, review: { files: MANIFEST.count, treeHash: MANIFEST.treeHash }, attestLinks: ATTEST_LINKS, explorerReport });
        if (p === '/ai.html') {
            const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
            // 주소는 진짜 링크로 — AI 웹 도구가 64자리 해시가 든 주소를 옮겨 적다 틀리지 않고 그대로 따라가게
            const linkify = (h) => h.replace(/https:\/\/[^\s)`|<>"']+/g, (u) => { const clean = u.replace(/[.,;]+$/, ''); return `<a href="${clean}">${clean}</a>${u.slice(clean.length)}`; });
            const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">`
                + `<title>BUY-IN engine — audit report from inside the TEE</title></head>`
                + `<body><pre style="white-space:pre-wrap;word-break:break-word;font:14px/1.55 ui-monospace,Consolas,monospace;max-width:960px;margin:24px auto;padding:0 16px">${linkify(esc(text))}</pre></body></html>`;
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', ...PUBLIC_HEADERS });
            return res.end(html);
        }
        res.writeHead(200, { 'Content-Type': 'text/markdown; charset=utf-8', ...PUBLIC_HEADERS });
        return res.end(text);
    }
    if (p === '/review/manifest') {
        res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', ...PUBLIC_HEADERS });
        return res.end(MANIFEST.body);
    }
    if (p === '/review/manifest.json') {
        const files = MANIFEST.body.trim().split('\n').map((l) => { const [sha256, file] = l.split(/\s+/); return { path: file, sha256 }; });
        return send(res, 200, { ok: true, count: MANIFEST.count, treeHash: MANIFEST.treeHash, files }, PUBLIC_HEADERS);
    }
    if (p === '/records/head') return store ? send(res, 200, { ok: true, ...store.headInfo(), storage: store.storage(), retentionDays: RETENTION_DAYS }, PUBLIC_HEADERS) : send(res, 404, { ok: false, error: 'no record store' }, PUBLIC_HEADERS);
    if (p === '/records/keys') return store ? send(res, 200, { ok: true, keys: store.engineKeys() }, PUBLIC_HEADERS) : send(res, 404, { ok: false, error: 'no record store' }, PUBLIC_HEADERS);
    // [TABLE_RECORD_2026_11_10] 한 테이블의 끝난 판 결과 — 좌석 번호·시작/끝 칩·레이크·사슬 위치·기록 해시 + 판마다 덱·재생 검증 결과(카드·덱·씨앗·회원 번호 없음).
    //   회원이 운영 서버에서 받은 자기 게임 기록을 사람·AI 가 이 TEE 글과 글자 그대로 대조한다(.html 은 AI 웹 열람기용).
    const tb = p.match(/^\/records\/table\/([A-Za-z0-9_-]{1,40})(\.html)?$/);
    if (tb) {
        if (!LIMIT.table.take()) return send(res, 429, { ok: false, error: 'too many requests' }, PUBLIC_HEADERS);
        if (!store) return send(res, 404, { ok: false, error: 'no record store' }, PUBLIC_HEADERS);
        // 진행 중인 테이블은 없는 테이블과 똑같이 답한다 — 밖에서 지금 열린 게임을 알아낼 수 없게(닫힌 뒤에 열린다)
        const report = tables && tables.isOpen(tb[1]) ? { hands: [] } : tableReport(store, tb[1]);
        if (report.hands.length === 0) return send(res, 404, { ok: false, error: 'no finished table with this id — a table record opens after the table closes' }, PUBLIC_HEADERS);   // 판마다 src/verify.js 로 덱·재생 검증(결과만 내보낸다)
        if (!tb[2]) return send(res, 200, { ok: true, tableId: tb[1], engine: engineId(), ...report, head: store.headInfo() }, PUBLIC_HEADERS);
        const base = `https://${String(req.headers.host || '').replace(/[^\w.:-]/g, '')}`;
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', ...PUBLIC_HEADERS });
        return res.end(tableRecordHtml(tb[1], report, engineId(), base));
    }
    const rc = p.match(/^\/records\/receipt\/([A-Za-z0-9_.:-]{1,128})$/);
    if (rc) {
        if (!store) return send(res, 404, { ok: false, error: 'no record store' }, PUBLIC_HEADERS);
        // [TABLE_RECORD_2026_11_10] 열린 테이블의 판 영수증도 닫힌 뒤에 — 없는 판과 똑같이 404
        if (tables && tables.isOpen(String(rc[1]).split('.')[0])) return send(res, 404, { ok: false, error: 'not found' }, PUBLIC_HEADERS);
        const r = store.receipt(rc[1]);
        return r ? send(res, 200, { ok: true, receipt: r, head: store.headInfo() }, PUBLIC_HEADERS) : send(res, 404, { ok: false, error: 'not found' }, PUBLIC_HEADERS);
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
    if (!LIMIT.mine.take()) { req.resume(); return send(res, 429, { ok: false, error: 'too many requests' }); }
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

const server = http.createServer((req, res) => {
    for (const [k, v] of Object.entries(BASE_HEADERS)) res.setHeader(k, v);
    if (tableHandler && tableHandler(req, res, new URL(req.url, 'http://engine'))) return;
    if (req.method === 'OPTIONS') { res.writeHead(204, { ...PUBLIC_HEADERS, 'Access-Control-Allow-Methods': 'GET' }); return res.end(); }
    if (req.method === 'GET') return handleGet(req, res);
    if (req.method === 'POST' && req.url === '/records/mine') return handleMine(req, res);
    return send(res, 404, { ok: false, error: 'not found' });
});

// 느린 요청으로 연결을 붙잡아 두는 공격 막기 — 요청은 30초 안에, 머리글은 20초 안에 다 와야 한다(이벤트 흐름은 응답이 길 뿐 요청은 짧다)
server.keepAliveTimeout = 15000;
server.headersTimeout = 20000;
server.requestTimeout = 30000;
server.maxConnections = 4000;

async function start() {
    if (MODE === 'dstack') {
        // 증명서 없이 뜨지 않는다 — 증명서 없는 엔진 키는 믿을 근거가 없다
        attestation = await dstackAttestation(engine.call('info').keys);
        // 증명서를 Phala 탐색기에 직접 올려 제3자 검증 보고서 주소를 받는다(공개 quote 만 보낸다)
        require('./explorer').startExplorerUpload(() => attestation && attestation.quote, (r) => { explorerReport = r; });
    }
    // 이번에 뜬 엔진의 키를 사슬에 남긴다 — 이 키로 서명될 판 기록을 나중에도 검증할 수 있게
    if (store) store.appendEngineKey(engine.call('info'));
    // 테이블 서버 — 사슬에서 정산 안 된 좌석을 먼저 정산하고(재시작 복구) 연다
    if (CONSOLE_KEY) {
        tables = new TableServer({ engine, store, consoleKey: CONSOLE_KEY, disconnectGraceMs: Number(process.env.TEE_DISCONNECT_GRACE_MS) || undefined });
        setInterval(() => tables.sweep(), 30000).unref();
    }
    if (store) {
        // 사슬에 쓴 줄을 콘솔로 보낸다(실패하면 다시) — 콘솔이 엔진에서 꺼내 가는 길은 없다
        if (CONSOLE_URL) new Outbox({ store, url: CONSOLE_URL, token: TOKEN }).start();
        // 보관 기간이 지났고 이미 보낸 하루 파일은 지운다
        const prune = () => {
            try {
                const r = store.prune(RETENTION_DAYS);
                if (r.rows) console.log(`[tee-engine] removed ${r.rows} record line(s) older than ${RETENTION_DAYS} days, already sent`);
            } catch (e) { console.error(`[tee-engine] prune failed: ${e.message}`); }
        };
        prune();
        setInterval(prune, 60 * 60 * 1000).unref();
    }
    // 테이블 화면·검증 화면은 언제나 TEE 가 내보낸다(테이블 서버가 꺼져 있으면 앉기·명령만 닫힌다)
    tableHandler = tableRoutes(tables);
    server.listen(PORT, HOST, () => {
        const i = info();
        console.log(`[tee-engine] ${i.name} ${i.version} mode=${i.mode} listening ${HOST}:${PORT} sigFp=${i.keys.sigFp}`
            + `${attestation ? ` reportData=${attestation.reportData}` : ''}${CONSOLE_URL ? ' send=console' : ''}`
            + `${store ? ` records=${store.count}` : ''}${tables ? ' tables=on' : ''}${engine.allowUnsigned ? ' ALLOW_UNSIGNED' : ''}`);
    });
}

start().catch((e) => {
    console.error(`[tee-engine] start failed: ${e.message}`);
    process.exit(1);
});
