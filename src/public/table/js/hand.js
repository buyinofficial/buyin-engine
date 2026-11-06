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
