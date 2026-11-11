/**
 * 테이블 서버 HTTP — 회원 브라우저가 TEE 와 직접 이야기하는 길.
 *
 *   GET  /table/                  테이블 화면 (src/public/table — 공개 소스, 이 TEE 가 내보낸다)
 *   GET  /table/<파일>            화면 파일(js·css·그림·글꼴)
 *   POST /table/join              { ticket, auth?: { sig, proof } } → { token, seat, tableId, seedCommit }
 *   GET  /table/events            이벤트 흐름(SSE, Authorization: Bearer <좌석 토큰>) — 접속하자마자 snapshot, 이후 판 진행
 *   POST /table/cmd               { token, type, ... } — 키 등록·무작위 값·액션·자리 비움·일어나기·추가 바이인 신청
 *   POST /table/topup             콘솔만(Authorization: Bearer <TEE_RPC_TOKEN>) [REBUY_2026_11_11]
 *                                 { ticket } 추가 바이인 영수증(콘솔 서명) → 칩 0 이고 신청해 둔 좌석에 칩
 *                                 { reject: { roomId, odcId } } 방장 거절·만료 → 신청 표시만 지운다
 *   GET  /table/verify.html       내 판 기록 검증하기 (공개 화면)
 *   GET  /table/engine/<파일>     검증 화면이 그대로 돌리는 엔진 소스(지금 도는 그 파일)
 *
 * 테이블 화면은 다른 사이트의 틀(iframe) 안에서 열리지 않는다(frame-ancestors 'none') — 운영 화면이 덮어씌우지 못하게.
 * 화면이 부를 수 있는 곳은 이 TEE 와, 받은 채팅 한 줄을 번역하는 주소 하나뿐이다(카드·게임 정보는 보내지 않는다).
 */

const fs = require('fs');
const crypto = require('crypto');
const path = require('path');

const PUBLIC_DIR = path.join(__dirname, '..', 'public', 'table');
const SRC_DIR = path.join(__dirname, '..');
/** 검증 화면이 브라우저에서 그대로 돌리는 엔진 파일 — 지금 이 TEE 에서 도는 바로 그 파일이다 */
const ENGINE_FILES = new Set(['verify.js', 'crypto.js', 'cards.js', 'HandCore.js', 'HandEvaluator.js', 'PotManager.js', 'money.js']);
const ENGINE_FILE_CACHE = new Map();
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json',
    '.svg': 'image/svg+xml', '.png': 'image/png', '.webp': 'image/webp', '.jpg': 'image/jpeg', '.woff2': 'font/woff2', '.mp3': 'audio/mpeg' };
const PAGE_HEADERS = {
    // 리소스 서버에서는 받기만 한다 — 그림·글꼴, 효과음(sfx/ 폴더만, fetch 로 받아 재생), 이모티콘·올인 영상(emo/·fx/ 폴더만)
    // 채팅 번역: 받은 채팅 글 한 줄만 운영 서버의 번역 주소 하나로 보낸다(app.js translateLine)
    'Content-Security-Policy': "default-src 'self'; img-src 'self' data: https://resource.buyinholdem.com; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self' https://resource.buyinholdem.com/buyin-table/sfx/ https://buyinholdem.com/chat-translate; media-src https://resource.buyinholdem.com/buyin-table/emo/ https://resource.buyinholdem.com/buyin-table/fx/; font-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
    'X-Frame-Options': 'DENY', 'Referrer-Policy': 'strict-origin',   // 리소스 서버는 이 TEE 화면에서 온 요청인지만 본다(경로·해시는 보내지 않는다)
    'X-Content-Type-Options': 'nosniff',
};
const MAX_BODY = 64 * 1024;
const { RateLimiter } = require('../limits');
// 요청 폭주 막기 — 입장은 전체, 명령은 좌석 토큰마다
const JOIN_LIMIT = new RateLimiter(30, 60);
const CMD_LIMIT = new RateLimiter(20, 40);
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
    // 화면 코드는 no-cache — 배포하면 브라우저가 바로 새 코드를 받는다(파일이 작다)
    res.writeHead(200, { 'Content-Type': type, 'Content-Length': data.length, 'Cache-Control': type.startsWith('text/html') ? 'no-store' : 'no-cache', ...PAGE_HEADERS });
    res.end(data);
    return true;
}

/** 콘솔 토큰 확인 — 길이 차이로 새지 않게 해시로 비교한다 */
function tokenCheck(token) {
    const want = token ? crypto.createHash('sha256').update(String(token)).digest() : null;
    return (req) => {
        if (!want) return false;
        const h = String(req.headers.authorization || '');
        const given = h.startsWith('Bearer ') ? h.slice(7) : '';
        return !!given && crypto.timingSafeEqual(crypto.createHash('sha256').update(given).digest(), want);
    };
}

/** @returns {(req, res, url) => boolean} 테이블 경로를 처리했으면 true
 *  @param {object} [opts]  { token } 콘솔 토큰(TEE_RPC_TOKEN) — 추가 바이인 경로(/table/topup)만 쓴다. 없으면 그 경로는 닫힌다 */
function tableRoutes(tables, opts = {}) {
    const consoleOk = tokenCheck(opts.token);
    return function handle(req, res, url) {
        const p = url.pathname;
        if (!p.startsWith('/table')) return false;
        if (req.method === 'GET' && p === '/table') { res.writeHead(301, { Location: '/table/' }); res.end(); return true; }

        if (!tables && (p === '/table/join' || p === '/table/cmd' || p === '/table/events')) {
            json(res, 503, { ok: false, code: 'off', error: 'table server is not enabled on this engine' });
            return true;
        }
        if (req.method === 'POST' && p === '/table/topup') {
            if (!tables) { json(res, 503, { ok: false, code: 'off', error: 'table server is not enabled on this engine' }); return true; }
            if (!consoleOk(req)) { json(res, 401, { ok: false, code: 'auth', error: 'console only' }); return true; }
            readJson(req).then((m) => {
                try {
                    if (m && m.reject) return json(res, 200, tables.rebuyReject(m.reject.roomId, m.reject.odcId));
                    return json(res, 200, tables.topUp(m && m.ticket));
                } catch (e) {
                    return json(res, 400, { ok: false, code: e.code || 'error', error: e.message });
                }
            }, () => json(res, 400, { ok: false, error: 'bad json' }));
            return true;
        }
        if (req.method === 'POST' && (p === '/table/join' || p === '/table/cmd')) {
            readJson(req).then((m) => {
                const ok = p === '/table/join' ? JOIN_LIMIT.take() : CMD_LIMIT.take(String(m && m.token || ''));
                if (!ok) return json(res, 429, { ok: false, code: 'rate', error: 'too many requests' });
                try {
                    if (p === '/table/join') return json(res, 200, { ok: true, ...tables.join(m.ticket, m.auth) });
                    const { token, ...msg } = m;
                    return json(res, 200, tables.command(token, msg));
                } catch (e) {
                    return json(res, e.code === 'auth' ? 401 : 400, { ok: false, code: e.code || 'error', error: e.message });
                }
            }, () => json(res, 400, { ok: false, error: 'bad json' }));
            return true;
        }

        if (req.method === 'GET' && p === '/table/events') {
            const h = String(req.headers.authorization || '');
            const token = h.startsWith('Bearer ') ? h.slice(7) : '';   // 주소(쿼리)로는 받지 않는다
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
            // 파일 글자를 그대로 감싸기만 한다(CSP 가 eval 을 막으므로 <script> 로 싣는다). 가운데 줄은 저장소의 파일과 같다.
            // 이미지 안의 파일이라 바뀌지 않는다 — 처음 한 번만 읽는다
            let data = ENGINE_FILE_CACHE.get(ef[1]);
            if (!data) {
                data = Buffer.concat([Buffer.from(`__engineModule(${JSON.stringify(ef[1])}, function (require, module, exports, Buffer) {\n`),
                    fs.readFileSync(path.join(SRC_DIR, ef[1])), Buffer.from('\n});\n')]);
                ENGINE_FILE_CACHE.set(ef[1], data);
            }
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
