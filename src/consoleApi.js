/**
 * 콘솔 확인 API — 콘솔이 받은 기록을 다시 확인할 때. 콘솔 토큰(TEE_RPC_TOKEN)이 있어야 한다.
 *
 *   GET /records/results?from=&limit=   끝난 판의 결과(좌석·시작/끝 스택·레이크·기록 해시). 카드·덱·시드 없음
 *   GET /records/finished/<판번호>       끝난 판의 서명된 전체 기록(진행 로그·카드 포함 — 판이 끝난 뒤라 공개 가능)
 *
 * 진행 중인 판에는 닿을 수 없다 — 이 파일은 기록 보관소(store.js)만 받는다. 엔진(Engine.js)이나 테이블 서버(table/)는
 * 여기 들어오지 않는다. 기록 보관소에는 판이 끝나야 기록이 들어간다(Engine._closeHand → onRecord → RecordStore.appendHand).
 */

const crypto = require('crypto');
const { RateLimiter } = require('./limits');

const LIMIT = new RateLimiter(5, 20);

/**
 * @param {{ store: import('./store').RecordStore | null, token: string, send: Function }} o
 * @returns {(req, res, u: URL) => boolean} 이 파일이 맡는 경로면 응답하고 true
 */
function consoleRoutes({ store, token, send }) {
    const tokenHash = token ? crypto.createHash('sha256').update(token).digest() : null;
    const authed = (req) => {
        if (!tokenHash) return false;
        const h = String(req.headers.authorization || '');
        const given = h.startsWith('Bearer ') ? h.slice(7) : '';
        return crypto.timingSafeEqual(crypto.createHash('sha256').update(given).digest(), tokenHash);
    };
    return (req, res, u) => {
        const p = u.pathname;
        const fin = p.match(/^\/records\/finished\/([A-Za-z0-9_.:-]{1,128})$/);
        if (p !== '/records/results' && !fin) return false;
        if (!LIMIT.take()) { send(res, 429, { ok: false, error: 'too many requests' }); return true; }
        if (!authed(req)) { send(res, 401, { ok: false, error: 'unauthorized' }); return true; }
        if (!store) { send(res, 404, { ok: false, error: 'no record store' }); return true; }
        if (fin) {
            const e = store.getHand(fin[1]);
            send(res, e ? 200 : 404, e ? { ok: true, entry: e } : { ok: false, error: 'not found' });
            return true;
        }
        const from = Math.max(0, Math.floor(Number(u.searchParams.get('from')) || 0));
        const limit = Math.min(500, Math.max(1, Math.floor(Number(u.searchParams.get('limit')) || 200)));
        send(res, 200, { ok: true, first: store.first, head: store.count, ...store.results(from, limit) });
        return true;
    };
}

module.exports = { consoleRoutes };
