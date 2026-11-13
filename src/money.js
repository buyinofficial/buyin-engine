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

/**
 * [CHIP_UNIT_0_10_6] 칩 최소 단위로 버린다 — 원화 방은 1(원), 그 밖은 0.001. unit 이 없거나 0.001 이하면 floorMoney 와 같다.
 * 원화 방에서 레이크·나눠 갖는 팟이 1원 아래로 쪼개지지 않게(스택이 언제나 정수 원) 엔진이 쓴다.
 */
function floorUnit(value, unit) {
    const u = Number(unit) || 0;
    if (!(u > 1 / SCALE)) return floorMoney(value);
    return roundMoney(Math.floor((Number(value) || 0) / u + 1e-9) * u);
}

function splitEvenly(total, count, unit) {
    if (!count || count < 1) return { share: 0, remainder: roundMoney(total) };
    const share = floorUnit(roundMoney(total) / count, unit);
    const remainder = roundMoney(roundMoney(total) - share * count);
    return { share, remainder };
}

module.exports = { MONEY_DECIMALS, SCALE, roundMoney, floorMoney, floorUnit, splitEvenly };
