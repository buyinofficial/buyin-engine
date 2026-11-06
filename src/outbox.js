/**
 * 기록 보내기 — 사슬에 쓴 줄을 콘솔로 보낸다. 엔진이 밖으로 연결하는 곳은 여기 한 곳, 주소는 TEE_CONSOLE_URL(배포 설정, 측정됨)뿐이다.
 *
 * 보내는 것은 사슬에 이미 쓴 줄뿐이다: 엔진 키, 앉음(좌석표 번호·바이인), 정산서(금액), 끝난 판의 서명된 기록.
 * 진행 중인 판은 사슬에 없으므로 보낼 수도 없다.
 *
 *   POST TEE_CONSOLE_URL   Authorization: Bearer <TEE_RPC_TOKEN>
 *     { entries: [줄...], head: 사슬 끝 번호, at: 지금 }      → { ok, next }
 *   콘솔은 받은 번호를 보고 다음에 받을 번호(next)를 답한다. 빠진 게 있으면 next 가 앞이고, 여기서 그 번호부터 다시 보낸다.
 *   실패하면 잠시 뒤 다시 보낸다. 보낼 게 없어도 30초마다 사슬 끝만 알린다(콘솔이 빠진 게 없는지 본다).
 */

const BATCH = 50;
const IDLE_MS = 30 * 1000;
const RETRY_MIN_MS = 2 * 1000;
const RETRY_MAX_MS = 60 * 1000;

class Outbox {
    /**
     * @param {object} o
     * @param {import('./store').RecordStore} o.store
     * @param {string} o.url     콘솔 주소
     * @param {string} o.token   콘솔이 확인하는 토큰
     * @param {typeof fetch} [o.fetch]
     */
    constructor(o) {
        this.store = o.store;
        this.url = o.url;
        this.token = o.token;
        this.fetch = o.fetch || fetch;
        this.busy = false;
        this.retryMs = RETRY_MIN_MS;
        this.timer = null;
        this.lastError = null;
        o.store.onAppend = () => this.kick();
    }

    start() { this.kick(); }

    stop() { if (this.timer) clearTimeout(this.timer); this.timer = null; }

    _later(ms) {
        if (this.timer) clearTimeout(this.timer);
        this.timer = setTimeout(() => { this.timer = null; this.kick(); }, ms);
        if (this.timer.unref) this.timer.unref();
    }

    /** 보낼 것을 보낸다 — 한 번에 하나씩만 돈다 */
    kick() {
        if (this.busy) { this.again = true; return; }
        this.busy = true;
        this.again = false;
        this._send().then((more) => {
            this.busy = false;
            this.lastError = null;
            this.retryMs = RETRY_MIN_MS;
            if (more || this.again) this.kick(); else this._later(IDLE_MS);
        }, (e) => {
            this.busy = false;
            this.lastError = e.message;
            this._later(this.retryMs);
            this.retryMs = Math.min(RETRY_MAX_MS, this.retryMs * 2);
        });
    }

    /** @returns {Promise<boolean>} 더 보낼 게 남았나 */
    async _send() {
        const entries = this.store.range(this.store.sent, BATCH);
        const r = await this.fetch(this.url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.token}` },
            body: JSON.stringify({ entries, head: this.store.count, at: Date.now() }),
            signal: AbortSignal.timeout(15000),
        });
        const body = await r.json().catch(() => ({}));
        if (!r.ok || typeof body.next !== 'number') throw new Error(`console ${r.status} ${body.error || ''}`.trim());
        if (body.next < this.store.sent) {
            // 콘솔에 빠진 게 있다 — 그 번호부터 다시 보낸다
            this.store.sent = Math.max(this.store.first, body.next);
            return true;
        }
        const before = this.store.sent;
        this.store.markSent(body.next);
        // 나아갔고 남은 게 있으면 바로 이어서. 콘솔이 받지 못하고 멈춰 있으면(next 그대로) 30초 뒤 다시
        return this.store.sent > before && this.store.sent < this.store.count;
    }

    status() {
        return { url: this.url, sent: this.store.sent, head: this.store.count, lastError: this.lastError };
    }
}

module.exports = { Outbox };
