/**
 * 돈 계산 — 최소 단위 0.001 (소켓 서버 src/game/money.js 와 같은 규칙).
 *
 * 엔진과 소켓 서버가 같은 판을 따로 계산하므로 반올림 규칙이 한 자리라도 다르면 칩이 어긋난다.
 * 그래서 이 파일은 소켓 서버의 money.js 에서 엔진이 쓰는 함수만 그대로 옮겼다. 바꾸면 양쪽을 같이 바꾼다.
 */

const MONEY_DECIMALS = 3;
const SCALE = 10 ** MONEY_DECIMALS;

function roundMoney(value) {
    const n = Number(value) || 0;
    return Math.round((n + Number.EPSILON) * SCALE) / SCALE;
}

function floorMoney(value) {
    const n = Number(value) || 0;
    return Math.floor(n * SCALE + 1e-6) / SCALE;
}

function splitEvenly(total, count) {
    if (!count || count < 1) return { share: 0, remainder: roundMoney(total) };
    const share = floorMoney(roundMoney(total) / count);
    const remainder = roundMoney(roundMoney(total) - share * count);
    return { share, remainder };
}

module.exports = { MONEY_DECIMALS, SCALE, roundMoney, floorMoney, splitEvenly };
