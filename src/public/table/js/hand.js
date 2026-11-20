/**
 * 진행 중 족보 표시 — 내 홀카드 + 깔린 보드에서 가장 좋은 패의 이름.
 * 화면 표시용일 뿐, 승패는 엔진(HandEvaluator)이 정한다. 문구는 운영 테이블과 같다("Pair, A's" · "High Card, A").
 */
const RANKS = '23456789TJQKA';
const NAME = (v) => (v === 10 ? '10' : RANKS[v - 2]);

function counts(vals) {
    const m = new Map();
    for (const v of vals) m.set(v, (m.get(v) || 0) + 1);
    return [...m.entries()].sort((a, b) => b[1] - a[1] || b[0] - a[0]);
}

function straightHigh(vals) {
    const u = [...new Set(vals)].sort((a, b) => b - a);
    if (u[0] === 14) u.push(1);
    for (let i = 0; i + 4 < u.length; i++) if (u[i] - u[i + 4] === 4) return u[i];
    return 0;
}

/** @param {string[]} cards 'Ah','Td' … (2~7장) @returns {string} */
export function liveHandName(cards) {
    const cs = cards.filter(Boolean).map((c) => ({ v: RANKS.indexOf(c[0]) + 2, s: c[1] }));
    if (cs.length < 2) return '';
    const vals = cs.map((c) => c.v);
    const bySuit = new Map();
    for (const c of cs) bySuit.set(c.s, [...(bySuit.get(c.s) || []), c.v]);
    const flush = [...bySuit.values()].find((v) => v.length >= 5);
    if (flush) {
        const sf = straightHigh(flush);
        if (sf === 14) return 'Royal Flush';
        if (sf) return `Straight Flush, ${NAME(sf)} high`;
    }
    const g = counts(vals);
    if (g[0][1] >= 4) return `Four of a Kind, ${NAME(g[0][0])}'s`;
    const trips = g.filter((x) => x[1] >= 3).map((x) => x[0]);
    const pairsAll = g.filter((x) => x[1] >= 2).map((x) => x[0]);
    if (trips.length && pairsAll.filter((v) => v !== trips[0]).length) return `Full House, ${NAME(trips[0])}'s over ${NAME(Math.max(...pairsAll.filter((v) => v !== trips[0])))}'s`;
    if (flush) return `Flush, ${NAME(Math.max(...flush))} high`;
    const st = straightHigh(vals);
    if (st) return `Straight, ${NAME(st)} high`;
    if (trips.length) return `Three of a Kind, ${NAME(trips[0])}'s`;
    const pairs = pairsAll.sort((a, b) => b - a);
    if (pairs.length >= 2) return `Two Pair, ${NAME(pairs[0])}'s & ${NAME(pairs[1])}'s`;
    if (pairs.length) return `Pair, ${NAME(pairs[0])}'s`;
    return `High Card, ${NAME(Math.max(...vals))}`;
}

/**
 * [OMAHA_0_10_23] 오마하 — 내 카드 2장 × 보드 3장 조합 중 가장 좋은 5장. 보드가 3장 미만이면 없다(오마하 족보는 보드 3장이 있어야 성립)
 * @returns {string[] | null} 가장 좋은 5장
 */
export function bestOmaha(hole, board) {
    const h = hole.filter(Boolean), b = board.filter(Boolean);
    if (h.length < 2 || b.length < 3) return null;
    let best = null, bestSet = null;
    for (let i = 0; i < h.length; i++) for (let j = i + 1; j < h.length; j++)
        for (let a = 0; a < b.length; a++) for (let c = a + 1; c < b.length; c++) for (let d = c + 1; d < b.length; d++) {
            const five = [h[i], h[j], b[a], b[c], b[d]];
            const sc = score5(five);
            if (!best || cmp(sc, best) > 0) { best = sc; bestSet = five; }
        }
    return bestSet;
}
/** [OMAHA_0_10_23] 진행 중 족보 이름 — 오마하면 홀 2 + 보드 3 으로 고른 5장의 이름, 아니면 종전(7장에서) */
export function handNameFor(hole, board, omaha) {
    if (!omaha) return liveHandName([...hole, ...board]);
    const five = bestOmaha(hole, board);
    return five ? liveHandName(five) : '';
}

/** 엔진 족보 문구("Pair of 8s", "Two Pair, As and Ks", "Full House, 7s full of 2s") → 화면 문구("Pair, 8's" …) */
export function prettyRank(desc) {
    const d = String(desc || '').trim();
    const WORD = { Two: '2', Three: '3', Four: '4', Five: '5', Six: '6', Seven: '7', Eight: '8', Nine: '9', Ten: '10', Jack: 'J', Queen: 'Q', King: 'K', Ace: 'A', T: '10' };
    const v = (x) => `${WORD[x] || x}'s`;
    let m;
    const one = (x) => WORD[x] || x;
    if ((m = d.match(/^High Card, (\w+)$/))) return `High Card, ${one(m[1])}`;
    if ((m = d.match(/^(Straight Flush|Flush|Straight), (\w+) high$/))) return `${m[1]}, ${one(m[2])} high`;
    if ((m = d.match(/^Pair of (\w+?)s$/))) return `Pair, ${v(m[1])}`;
    if ((m = d.match(/^Two Pair, (\w+?)s and (\w+?)s$/))) return `Two Pair, ${v(m[1])} & ${v(m[2])}`;
    if ((m = d.match(/^Three of a Kind, (\w+?)s$/))) return `Three of a Kind, ${v(m[1])}`;
    if ((m = d.match(/^Four of a Kind, (\w+?)s$/))) return `Four of a Kind, ${v(m[1])}`;
    if ((m = d.match(/^Full House, (\w+?)s full of (\w+?)s$/))) return `Full House, ${v(m[1])} over ${v(m[2])}`;
    return d;
}

const BIG = [[/royal/i, 'ROYAL FLUSH'], [/straight flush/i, 'STRAIGHT FLUSH'], [/four of a kind/i, 'FOUR OF A KIND'], [/full house/i, 'FULL HOUSE'],
    [/flush/i, 'FLUSH'], [/straight/i, 'STRAIGHT'], [/three of a kind/i, 'THREE OF A KIND'], [/two pair/i, 'TWO PAIR'], [/pair/i, 'ONE PAIR'], [/high card/i, 'HIGH CARD']];
/** 큰 글씨 — "8 ONE PAIR", "A,K TWO PAIR" */
export function bigHandName(pretty) {
    const d = String(pretty || '');
    const hit = BIG.find(([re]) => re.test(d));
    if (!hit) return '';
    const label = hit[1];
    if (label === 'ROYAL FLUSH') return label;
    const ranks = [...new Set((d.split(',')[1] || '').split(/[\s,&]+/).map((x) => x.replace(/'s$/, '').replace(/^high$|^over$/i, '')).filter(Boolean))];
    const pre = label === 'TWO PAIR' || label === 'FULL HOUSE' ? ranks.slice(0, 2).join(',') : ranks[0];
    return pre ? `${pre} ${label}` : label;
}

/**
 * [MADE_GLOW_0_10_9] 원본 made-hand-fx — 7장(내 2 + 보드)에서 가장 좋은 5장을 고르고, 트리플 이상이면 그 5장에 든 내 홀카드 위치를 돌려준다.
 * 화면 빛 연출용(승패는 엔진). @param {string[]} hole 내 카드 2장 @param {string[]} board 깔린 보드 @returns {{ tier: number, hole: number[] } | null}
 */
export function madeHand(hole, board, omaha = false) {
    if (omaha) {   // [OMAHA_0_10_23] 오마하 — 쓰인 내 카드는 언제나 정확히 2장
        const five = bestOmaha(hole, board);
        if (!five) return null;
        const sc = score5(five);
        if (sc[0] < 3) return null;
        return { tier: sc[0] - 2, hole: hole.map((c, i) => (five.includes(c) ? i : -1)).filter((i) => i >= 0) };
    }
    const all = [...hole, ...board].filter(Boolean);
    if (hole.length < 2 || all.length < 5) return null;
    let best = null, bestSet = null;
    const n = all.length;
    for (let a = 0; a < n; a++) for (let b = a + 1; b < n; b++) for (let c = b + 1; c < n; c++) for (let d = c + 1; d < n; d++) for (let e = d + 1; e < n; e++) {
        const five = [all[a], all[b], all[c], all[d], all[e]];
        const sc = score5(five);
        if (!best || cmp(sc, best) > 0) { best = sc; bestSet = five; }
    }
    if (!best || best[0] < 3) return null;   // 트리플 이상만(원본 madeHandTier ≥ 1)
    return { tier: best[0] - 2, hole: hole.map((c, i) => (bestSet.includes(c) ? i : -1)).filter((i) => i >= 0) };
}
function cmp(x, y) { for (let i = 0; i < Math.max(x.length, y.length); i++) { const d = (x[i] || 0) - (y[i] || 0); if (d) return d; } return 0; }
/** 5장 점수 [종류, 비교값…] — 8 스트레이트 플러시, 7 포카드, 6 풀하우스, 5 플러시, 4 스트레이트, 3 트리플, 2 투페어, 1 원페어, 0 하이 */
function score5(five) {
    const vals = five.map((c) => RANKS.indexOf(c[0]) + 2).sort((x, y) => y - x);
    const flush = five.every((c) => c[1] === five[0][1]);
    const st = straightHigh(vals);
    if (flush && st) return [8, st];
    const g = counts(vals);
    if (g[0][1] === 4) return [7, g[0][0], g[1][0]];
    if (g[0][1] === 3 && g[1][1] === 2) return [6, g[0][0], g[1][0]];
    if (flush) return [5, ...vals];
    if (st) return [4, st];
    if (g[0][1] === 3) return [3, g[0][0], ...g.slice(1).map((x) => x[0])];
    if (g[0][1] === 2 && g[1][1] === 2) return [2, g[0][0], g[1][0], g[2][0]];
    if (g[0][1] === 2) return [1, g[0][0], ...g.slice(1).map((x) => x[0])];
    return [0, ...vals];
}

/* [HAND_I18N_0_10_12] 다른 플레이어 족보 글자를 화면 언어로 — 「Pair, 8's」 → 「원페어 8」. 영웅(내) 족보 상자는 영어 그대로(운영 요청).
   영어·몽골어(용어가 굳지 않았다)는 영어 그대로. 입력은 prettyRank / liveHandName 문구 */
const HAND_WORDS = {
    ko: { 'High Card': '하이카드', Pair: '원페어', 'Two Pair': '투페어', 'Three of a Kind': '트리플', Straight: '스트레이트', Flush: '플러시', 'Full House': '풀하우스', 'Four of a Kind': '포카드', 'Straight Flush': '스트레이트 플러시', 'Royal Flush': '로열 플러시', high: '하이' },
    ja: { 'High Card': 'ハイカード', Pair: 'ワンペア', 'Two Pair': 'ツーペア', 'Three of a Kind': 'スリーカード', Straight: 'ストレート', Flush: 'フラッシュ', 'Full House': 'フルハウス', 'Four of a Kind': 'フォーカード', 'Straight Flush': 'ストレートフラッシュ', 'Royal Flush': 'ロイヤルフラッシュ', high: 'ハイ' },
    zh: { 'High Card': '高牌', Pair: '一对', 'Two Pair': '两对', 'Three of a Kind': '三条', Straight: '顺子', Flush: '同花', 'Full House': '葫芦', 'Four of a Kind': '四条', 'Straight Flush': '同花顺', 'Royal Flush': '皇家同花顺', high: '' },
    vi: { 'High Card': 'Mậu thầu', Pair: 'Đôi', 'Two Pair': 'Thú', 'Three of a Kind': 'Sám cô', Straight: 'Sảnh', Flush: 'Thùng', 'Full House': 'Cù lũ', 'Four of a Kind': 'Tứ quý', 'Straight Flush': 'Thùng phá sảnh', 'Royal Flush': 'Thùng phá sảnh lớn', high: '' },
};
export function localHand(pretty, lang) {
    const W = HAND_WORDS[lang];
    const d = String(pretty || '').trim();
    if (!W || !d) return d;
    const m = d.match(/^(Royal Flush|Straight Flush|Four of a Kind|Full House|Three of a Kind|Two Pair|High Card|Straight|Flush|Pair)(?:,\s*(.*))?$/);
    if (!m) return d;
    const name = W[m[1]] || m[1];
    if (!m[2]) return name;
    const highOnly = /\bhigh$/.test(m[2]);
    const ranks = m[2].replace(/\s*high$/, '').split(/\s*(?:&|over)\s*/).map((x) => x.replace(/'s$/, '').trim()).filter(Boolean);
    const tail = ranks.join('·') + (highOnly && W.high ? ' ' + W.high : '');
    return `${name} ${tail}`.trim();
}
