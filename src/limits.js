/**
 * 요청 폭주 막기 — 키(전체 또는 좌석 토큰)마다 토큰 버킷. 넘치면 호출한 쪽이 429 로 돌려보낸다.
 * 서비스 거부를 막는 장치일 뿐 카드·판 진행에는 손대지 않는다.
 */

class RateLimiter {
    /**
     * @param {number} perSec  초당 채워지는 수
     * @param {number} burst   한꺼번에 쓸 수 있는 최대
     * @param {() => number} [now]
     */
    constructor(perSec, burst, now = () => Date.now()) {
        this.perSec = perSec;
        this.burst = burst;
        this.now = now;
        this.buckets = new Map();   // key → { tokens, at }
    }

    take(key = '*') {
        const t = this.now();
        let b = this.buckets.get(key);
        if (!b) { b = { tokens: this.burst, at: t }; this.buckets.set(key, b); }
        b.tokens = Math.min(this.burst, b.tokens + ((t - b.at) / 1000) * this.perSec);
        b.at = t;
        if (b.tokens < 1) return false;
        b.tokens -= 1;
        if (this.buckets.size > 10000) this._gc(t);
        return true;
    }

    _gc(t) {
        for (const [k, b] of this.buckets) if (t - b.at > 60000) this.buckets.delete(k);
    }
}

module.exports = { RateLimiter };
