/**
 * 테이블 서버 HTTP — 회원 브라우저가 TEE 와 직접 이야기하는 길.
 *
 *   GET  /table/                  테이블 화면 (src/public/table — 공개 소스, 이 TEE 가 내보낸다)
 *   GET  /table/<파일>            화면 파일(js·css·그림·글꼴)
 *   POST /table/join              { ticket, auth?: { sig, proof } } → { token, seat, tableId, seedCommit }
 *   POST /table/resume            { tid, ts, auth: { sig, proof } } → 같은 키로 앉은 자리의 { token, seat, tableId, seedCommit } [RESUME_0_10_11]
 *   POST /table/kick              { order } — 콘솔이 서명한 강퇴. 치던 판이 끝난 뒤 정산·퇴장 [KICK_0_10_27]
 *   GET  /table/events            이벤트 흐름(SSE, Authorization: Bearer <좌석 토큰>) — 접속하자마자 snapshot, 이후 판 진행
 *   POST /table/cmd               { token, type, ... } — 키 등록·무작위 값·액션·자리 비움·일어나기
 *   GET  /table/ws  (Upgrade)     [WS_0_10_10] 웹소켓 — 위 두 길(이벤트·명령)을 연결 하나로. 화면은 이것을 먼저 쓰고,
 *                                 열리지 않으면 SSE + POST 로 돌아간다. 메시지:
 *                                   화면 → TEE  {t:'auth', token}  (처음 한 번 — 좌석 토큰은 주소에 싣지 않는다)
 *                                               {t:'cmd', id, type, ...}  → TEE → 화면 {ev:'res', id, res}
 *                                               {t:'ka'}  (10초마다 — 살아 있다)
 *                                   TEE → 화면  {ev, data}  (SSE 와 같은 이벤트) · {ev:'ka'}
 *                                 좌석 토큰이 맞지 않으면 {ev:'error'} 후 닫기 코드 4401.
 *   GET  /table/verify.html       내 판 기록 검증하기 (공개 화면)
 *   GET  /table/engine/<파일>     검증 화면이 그대로 돌리는 엔진 소스(지금 도는 그 파일)
 *
 * 테이블 화면은 다른 사이트의 틀(iframe) 안에서 열리지 않는다(frame-ancestors 'none') — 운영 화면이 덮어씌우지 못하게.
 * 화면이 부를 수 있는 곳은 이 TEE 와, 받은 채팅 한 줄을 번역하는 주소 하나뿐이다(카드·게임 정보는 보내지 않는다).
 */

const fs = require('fs');
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
    'Content-Security-Policy': "default-src 'self'; img-src 'self' data: https://resource.buyinholdem.com; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self' https://resource.buyinholdem.com/buyin-table/sfx/ https://resource.buyinholdem.com/assets/table_skins/skins.json https://buyinholdem.com/chat-translate; media-src https://resource.buyinholdem.com/buyin-table/emo/ https://resource.buyinholdem.com/buyin-table/fx/; font-src 'self'; frame-src https://buyinholdem.com; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
    'X-Frame-Options': 'DENY', 'Referrer-Policy': 'strict-origin',   // 리소스 서버는 이 TEE 화면에서 온 요청인지만 본다(경로·해시는 보내지 않는다)
    'X-Content-Type-Options': 'nosniff',
};
const MAX_BODY = 64 * 1024;
const { RateLimiter } = require('../limits');
// 요청 폭주 막기 — 입장은 전체, 명령은 좌석 토큰마다
const JOIN_LIMIT = new RateLimiter(30, 60);
const KICK_LIMIT = new RateLimiter(10, 40);   // [KICK_0_10_27]
const CMD_LIMIT = new RateLimiter(20, 40);
const KEEPALIVE_MS = 15000;
const { acceptWebSocket } = require('./ws');
const WS_KA_MS = 10000;          // [WS_0_10_10] 서로 10초마다 한 줄 — 중간 장비가 쉬는 연결을 끊지 않게
const WS_DEAD_MS = 35000;        // 이만큼 아무것도 안 오면 죽은 연결로 보고 닫는다(좌석은 TableServer 의 끊김 유예를 따른다)
const WS_AUTH_MS = 10000;        // 업그레이드 뒤 이 안에 좌석 토큰이 와야 한다

/**
 * [WS_0_10_10] 화면 CSP — connect-src 에 이 TEE 의 wss:// 주소를 넣는다. CSP3 의 'self' 는 같은 호스트 wss 를 포함하지만
 * 그렇지 않은 옛 브라우저(구형 Safari 등)가 있어 요청의 Host 를 그대로 적는다. Host 는 호스트 이름 글자만 받는다.
 * 화면이 연결할 수 있는 곳은 여전히 이 TEE 하나다(운영 서버 주소는 들어가지 않는다).
 */
function pageHeaders(req) {
    const host = String((req && req.headers && req.headers.host) || '');
    if (!/^[A-Za-z0-9.-]{1,253}(:\d{1,5})?$/.test(host)) return PAGE_HEADERS;
    const csp = PAGE_HEADERS['Content-Security-Policy'].replace("connect-src 'self'", `connect-src 'self' wss://${host}`);
    return { ...PAGE_HEADERS, 'Content-Security-Policy': csp };
}

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

/**
 * [CACHE_BUST_0_10_9] 화면 파일 주소에 빌드 번호를 넣는다 — index.html 의 __BUILD__ 를 이 이미지의 커밋으로 바꾸고,
 * /table/v/<빌드>/... 는 같은 파일로 내준다. 앞단(Cloudflare 등)이 .js/.css 를 몇 시간 캐시해도 배포하면 주소가 바뀌어
 * 새 코드를 받는다(개발 TEE 앞의 Cloudflare 가 app.js 를 4시간 캐시해 새 HTML + 옛 app.js 가 섞였다).
 * app.js 의 import('./i18n.js') 같은 상대 주소도 같은 버전 경로를 따른다. 화면 파일만 — 엔진 계산과 무관
 */
const BUILD = (() => {
    const c = String(process.env.BUYIN_COMMIT || '');
    if (/^[0-9a-f]{7,40}$/i.test(c)) return c.slice(0, 12);
    let v = '0';
    try { v = require('../../package.json').version; } catch (_e) { /* */ }
    return (v + '-' + Date.now().toString(36)).replace(/[^A-Za-z0-9._-]/g, '');
})();

function serveFile(req, res, rel) {
    const file = path.normalize(path.join(PUBLIC_DIR, rel || 'index.html'));
    if (!file.startsWith(PUBLIC_DIR + path.sep) && file !== PUBLIC_DIR) return false;
    let data;
    try { data = fs.readFileSync(fs.statSync(file).isDirectory() ? path.join(file, 'index.html') : file); } catch (_e) { return false; }
    const type = TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream';
    if (type.startsWith('text/html')) data = Buffer.from(data.toString('utf8').split('__BUILD__').join(BUILD));   // [CACHE_BUST_0_10_9]
    // 화면 코드는 no-cache — 배포하면 브라우저가 바로 새 코드를 받는다(파일이 작다)
    res.writeHead(200, { 'Content-Type': type, 'Content-Length': data.length, 'Cache-Control': type.startsWith('text/html') ? 'no-store' : 'no-cache', ...pageHeaders(req) });
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
        if (req.method === 'POST' && p === '/table/resume') {   // [RESUME_0_10_11] 같은 키로 앉은 자리에 다시 붙기
            readJson(req).then((m) => {
                if (!tables) return json(res, 503, { ok: false, code: 'off', error: 'table server is not enabled on this engine' });
                if (!JOIN_LIMIT.take()) return json(res, 429, { ok: false, code: 'rate', error: 'too many requests' });
                try { return json(res, 200, { ok: true, ...tables.resume(m) }); } catch (e) { return json(res, 400, { ok: false, code: e.code || 'error', error: e.message }); }
            }, () => json(res, 400, { ok: false, error: 'bad json' }));
            return true;
        }
        if (req.method === 'POST' && p === '/table/kick') {   // [KICK_0_10_27] 콘솔 서명 강퇴 — 판이 끝난 뒤 정산·퇴장
            readJson(req).then((m) => {
                if (!tables) return json(res, 503, { ok: false, code: 'off', error: 'table server is not enabled on this engine' });
                if (!KICK_LIMIT.take()) return json(res, 429, { ok: false, code: 'rate', error: 'too many requests' });
                try { return json(res, 200, { ok: true, ...tables.kick(m && m.order) }); } catch (e) { return json(res, 400, { ok: false, code: e.code || 'error', error: e.message }); }
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
            const vb = p.match(/^\/table\/v\/[A-Za-z0-9._-]{1,40}\/(.+)$/);   // [CACHE_BUST_0_10_9] 빌드 번호가 붙은 주소 = 같은 파일
            if (serveFile(req, res, decodeURIComponent(vb ? vb[1] : p.slice('/table/'.length)))) return true;
            json(res, 404, { ok: false, error: 'not found' });
            return true;
        }
        return false;
    };
}

/**
 * [WS_0_10_10] /table/ws 업그레이드 — 처리했으면 true(다른 주소는 false, 서버가 끊는다).
 * 좌석 토큰은 첫 메시지로만 받는다(주소·쿠키 없음 — 다른 사이트가 이 연결을 대신 열어도 토큰이 없으면 아무것도 못 한다).
 * 명령은 POST /table/cmd 와 같은 함수(TableServer.command)·같은 횟수 제한(CMD_LIMIT)을 지난다.
 */
function tableUpgrade(tables) {
    return function upgrade(req, socket, head) {
        let p;
        try { p = new URL(req.url, 'http://engine').pathname; } catch (_e) { return false; }
        if (p !== '/table/ws') return false;
        if (!tables) { socket.end('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\nContent-Length: 0\r\n\r\n'); return true; }
        const ws = acceptWebSocket(req, socket, head);
        if (!ws) return true;
        const out = (obj) => ws.send(JSON.stringify(obj));
        let token = '', client = null;
        const authTimer = setTimeout(() => ws.close(1008, 'auth timeout'), WS_AUTH_MS);
        const ka = setInterval(() => {
            if (Date.now() - ws.lastIn > WS_DEAD_MS) return ws.close(1001, 'idle');
            out({ ev: 'ka' });
        }, WS_KA_MS);
        ws.onClose(() => { clearTimeout(authTimer); clearInterval(ka); });
        ws.onMessage = (text) => {
            let m;
            try { m = JSON.parse(text); } catch (_e) { return ws.close(1007, 'bad json'); }
            if (!m || typeof m !== 'object') return ws.close(1007, 'bad json');
            if (m.t === 'ka') return;
            if (!client) {
                if (m.t !== 'auth') return ws.close(1008, 'auth first');
                clearTimeout(authTimer);
                token = String(m.token || '');
                client = {
                    send: (ev, data) => out({ ev, data }),
                    end: () => ws.close(1000, 'end'),
                    onClose: (f) => ws.onClose(f),
                };
                try {
                    tables.subscribe(token, client);
                } catch (e) {
                    out({ ev: 'error', data: { code: e.code || 'error', error: e.message } });
                    ws.close(e.code === 'auth' ? 4401 : 4400, String(e.code || 'error'));
                }
                return;
            }
            if (m.t !== 'cmd') return;
            // [WS_RID_0_10_10] 요청 번호는 rid. 명령 내용의 id(이모티콘 종류 등)는 그대로 둔다 — 예전 화면은 id 를 요청 번호로 썼으니 rid 가 없으면 종전대로
            const hasRid = m.rid !== undefined;
            const id = hasRid ? m.rid : m.id;
            const { t: _t, rid: _rid, token: _tok, ...rest } = m;   // 좌석은 처음 받은 토큰으로만 정한다
            const msg = hasRid ? rest : (({ id: _id, ...x }) => x)(rest);
            let res;
            if (!CMD_LIMIT.take(token)) res = { ok: false, code: 'rate', error: 'too many requests' };
            else {
                try { res = tables.command(token, msg); }
                catch (e) { res = { ok: false, code: e.code || 'error', error: e.message }; }
            }
            out({ ev: 'res', id, res });
        };
        return true;
    };
}

module.exports = { tableRoutes, tableUpgrade };
