/**
 * 테이블 서버 HTTP — 회원 브라우저가 TEE 와 직접 이야기하는 길.
 *
 *   GET  /table/                  테이블 화면 (src/public/table — 공개 소스, 이 TEE 가 내보낸다)
 *   GET  /table/<파일>            화면 파일(js·css·그림·글꼴)
 *   POST /table/join              { ticket } → { token, seat, tableId, seedCommit }
 *   GET  /table/events?token=     이벤트 흐름(SSE) — 접속하자마자 snapshot, 이후 판 진행
 *   POST /table/cmd               { token, type, ... } — 키 등록·무작위 값·액션·자리 비움·일어나기
 *   GET  /table/verify.html       내 판 기록 검증하기 (공개 화면)
 *   GET  /table/engine/<파일>     검증 화면이 그대로 돌리는 엔진 소스(지금 도는 그 파일)
 *
 * 테이블 화면은 다른 사이트의 틀(iframe) 안에서 열리지 않는다(frame-ancestors 'none') — 운영 화면이 덮어씌우지 못하게.
 * 화면이 부를 수 있는 곳은 이 TEE 뿐이다(connect-src 'self').
 */

const fs = require('fs');
const path = require('path');

const PUBLIC_DIR = path.join(__dirname, '..', 'public', 'table');
const SRC_DIR = path.join(__dirname, '..');
/** 검증 화면이 브라우저에서 그대로 돌리는 엔진 파일 — 지금 이 TEE 에서 도는 바로 그 파일이다 */
const ENGINE_FILES = new Set(['verify.js', 'crypto.js', 'cards.js', 'HandCore.js', 'HandEvaluator.js', 'PotManager.js', 'money.js']);
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json',
    '.svg': 'image/svg+xml', '.png': 'image/png', '.webp': 'image/webp', '.jpg': 'image/jpeg', '.woff2': 'font/woff2', '.mp3': 'audio/mpeg' };
const PAGE_HEADERS = {
    'Content-Security-Policy': "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; font-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
    'X-Frame-Options': 'DENY', 'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff',
};
const MAX_BODY = 64 * 1024;
const KEEPALIVE_MS = 15000;

function readJson(req) {
    return new Promise((resolve, reject) => {
        let size = 0; const chunks = [];
        req.on('data', (c) => { size += c.length; if (size > MAX_BODY) { req.destroy(); reject(new Error('too large')); } else chunks.push(c); });
        req.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); } catch (e) { reject(e); } });
        req.on('error', reject);
    });
}

function json(res, code, obj) {
    const body = JSON.stringify(obj);
    res.writeHead(code, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), 'Cache-Control': 'no-store' });
    res.end(body);
}

function serveFile(res, rel) {
    const file = path.normalize(path.join(PUBLIC_DIR, rel || 'index.html'));
    if (!file.startsWith(PUBLIC_DIR + path.sep) && file !== PUBLIC_DIR) return false;
    let data;
    try { data = fs.readFileSync(fs.statSync(file).isDirectory() ? path.join(file, 'index.html') : file); } catch (_e) { return false; }
    const type = TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': type, 'Content-Length': data.length, 'Cache-Control': type.startsWith('text/html') ? 'no-store' : 'public, max-age=3600', ...PAGE_HEADERS });
    res.end(data);
    return true;
}

/** @returns {(req, res, url) => boolean} 테이블 경로를 처리했으면 true */
function tableRoutes(tables) {
    return function handle(req, res, url) {
        const p = url.pathname;
        if (!p.startsWith('/table')) return false;
        if (req.method === 'GET' && p === '/table') { res.writeHead(301, { Location: '/table/' }); res.end(); return true; }

        if (!tables && (p === '/table/join' || p === '/table/cmd' || p === '/table/events')) {
            json(res, 503, { ok: false, code: 'off', error: 'table server is not enabled on this engine' });
            return true;
        }
        if (req.method === 'POST' && (p === '/table/join' || p === '/table/cmd')) {
            readJson(req).then((m) => {
                try {
                    if (p === '/table/join') return json(res, 200, { ok: true, ...tables.join(m.ticket) });
                    const { token, ...msg } = m;
                    return json(res, 200, tables.command(token, msg));
                } catch (e) {
                    return json(res, e.code === 'auth' ? 401 : 400, { ok: false, code: e.code || 'error', error: e.message });
                }
            }, () => json(res, 400, { ok: false, error: 'bad json' }));
            return true;
        }

        if (req.method === 'GET' && p === '/table/events') {
            const token = url.searchParams.get('token') || '';
            let ka = null;
            const client = {
                send: (ev, data) => res.write(`event: ${ev}\ndata: ${JSON.stringify(data)}\n\n`),
                end: () => { clearInterval(ka); res.end(); },
                onClose: (f) => req.on('close', () => { clearInterval(ka); f(); }),
            };
            res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
            try {
                tables.subscribe(token, client);
            } catch (e) {
                client.send('error', { code: e.code || 'error', error: e.message });
                res.end();
                return true;
            }
            ka = setInterval(() => res.write(': keep-alive\n\n'), KEEPALIVE_MS);
            return true;
        }

        const ef = p.match(/^\/table\/engine\/([A-Za-z]+\.js)$/);
        if (req.method === 'GET' && ef && ENGINE_FILES.has(ef[1])) {
            // 파일 글자를 그대로 감싸기만 한다(CSP 가 eval 을 막으므로 <script> 로 싣는다). 가운데 줄은 저장소의 파일과 같다
            const data = Buffer.concat([Buffer.from(`__engineModule(${JSON.stringify(ef[1])}, function (require, module, exports, Buffer) {\n`),
                fs.readFileSync(path.join(SRC_DIR, ef[1])), Buffer.from('\n});\n')]);
            res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8', 'Content-Length': data.length, 'Cache-Control': 'no-store', ...PAGE_HEADERS });
            res.end(data);
            return true;
        }
        if (req.method === 'GET' && p.startsWith('/table/')) {
            if (serveFile(res, decodeURIComponent(p.slice('/table/'.length)))) return true;
            json(res, 404, { ok: false, error: 'not found' });
            return true;
        }
        return false;
    };
}

module.exports = { tableRoutes };
