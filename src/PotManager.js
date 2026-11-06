/**
 * PotManager - 팟 및 사이드팟 계산
 *
 * 역할:
 * - 메인 팟 및 사이드 팟 계산
 * - 올인 상황에서 팟 분리
 * - 승자에게 팟 분배
 */

const HandEvaluator = require('./HandEvaluator');
const { roundMoney, splitEvenly } = require('./money');   // [DECIMAL_STAKES_2026_08_30][MONEY_3DP_2026_09_13]

class PotManager {
    /**
     * 사이드 팟 계산
     * @param {Array} players - [{ seat, player: { totalHandBet, isFolded } }]
     * @returns {Array} [{ amount, eligibleSeats }]
     */
    static calculateSidePots(players) {
        // 폴드하지 않은 플레이어만
        const activePlayers = players.filter(p => !p.player.isFolded);

        if (activePlayers.length === 0) {
            return [];
        }

        // 베팅 금액 기준 정렬
        const sortedByBet = [...activePlayers].sort(
            (a, b) => a.player.totalHandBet - b.player.totalHandBet
        );

        const pots = [];
        let previousBet = 0;

        for (let i = 0; i < sortedByBet.length; i++) {
            const currentPlayer = sortedByBet[i];
            const currentBet = currentPlayer.player.totalHandBet;

            if (currentBet > previousBet) {
                const betIncrement = currentBet - previousBet;

                // 이 금액을 낼 수 있는 플레이어들 (현재 플레이어 이상 베팅한 사람들)
                const eligibleSeats = [];
                let potAmount = 0;

                for (const player of players) {
                    // 폴드한 플레이어도 베팅한 금액은 팟에 포함
                    const contribution = Math.min(
                        Math.max(0, player.player.totalHandBet - previousBet),
                        betIncrement
                    );
                    potAmount += contribution;

                    // 자격이 있는 플레이어 (폴드 안함 + 이 금액 이상 베팅)
                    if (!player.player.isFolded && player.player.totalHandBet >= currentBet) {
                        eligibleSeats.push(player.seat);
                    }
                }

                if (potAmount > 0 && eligibleSeats.length > 0) {
                    pots.push({
                        amount: potAmount,
                        eligibleSeats
                    });
                }

                previousBet = currentBet;
            }
        }

        return pots;
    }

    /**
     * [#81643] 미매칭(uncalled) 올인/베팅 반환액 계산.
     * 전체 참여자(폴드 포함) 중 총 기여금이 유일한 최댓값인 non-folded 플레이어가 있다면,
     * 그 초과분(= 자신의 기여금 - 그 외 전원의 기여금 중 최댓값)은 어떤 팟에도 속하지 않고
     * 원 배팅자에게 그대로 돌려줘야 한다 (정통 홀덤 룰). 폴드한 플레이어가 최댓값을 가진 경우는
     * 그 초과분이 이미 죽은 돈(dead money)이므로 반환 대상이 아니다 — null 반환.
     * @param {Array} players - [{ seat, player: { totalHandBet, isFolded } }] 전체 참여자(폴드 포함)
     * @returns {{seat:number, amount:number, cappedTotalHandBet:number}|null}
     */
    static computeUncalledReturn(players) {
        if (!players || players.length < 2) return null;

        let globalMax = 0;
        for (const p of players) {
            if (p.player.totalHandBet > globalMax) globalMax = p.player.totalHandBet;
        }
        if (globalMax <= 0) return null;

        const atMax = players.filter(p => p.player.totalHandBet === globalMax);
        if (atMax.length !== 1) return null; // 최댓값 동률이면 반환 없음

        const candidate = atMax[0];
        if (candidate.player.isFolded) return null; // 폴드한 플레이어의 초과 기여금은 반환하지 않음

        let secondMax = 0;
        for (const p of players) {
            if (p.seat === candidate.seat) continue;
            if (p.player.totalHandBet > secondMax) secondMax = p.player.totalHandBet;
        }

        const amount = globalMax - secondMax;
        if (amount <= 0) return null;

        return { seat: candidate.seat, amount, cappedTotalHandBet: secondMax };
    }

    /**
     * 승자 계산 및 팟 분배
     * @param {Array} activePlayers - [{ seat, player: { hand, totalHandBet, isFolded } }] 전체 참여자(폴드 포함)
     * @param {string[]} communityCards
     * @param {number} totalPot - 총 팟 금액 (검증용)
     * @returns {Array} [{ seat, amount, handRank, winningCards }]
     */
    static calculateWinners(activePlayers, communityCards, totalPot) {
        const results = [];

        // 1명만 남은 경우 (모두 폴드) — 남은 한 명이 전체 팟을 그대로 가져가므로
        // uncalled bet 구분이 무의미함 (반환이든 승리든 결과가 같음).
        const nonFolded = activePlayers.filter(p => !p.player.isFolded);
        if (nonFolded.length === 1) {
            return [{
                seat: nonFolded[0].seat,
                amount: totalPot,
                handRank: null,
                winningCards: null,
                reason: 'uncontested',
                potIndex: 0
            }];
        }

        // [#81643] 경쟁자 없는 최상위 기여금(미매칭 올인/베팅)은 팟 계산에서 제외하고 원 배팅자에게 반환.
        //   반환 후 남은(capped) 기여금 기준으로만 사이드팟을 계산해야 정통 규칙(폴드 플레이어의
        //   초과 기여금은 반환하지 않음)이 자연스럽게 보존된다.
        const uncalledReturn = this.computeUncalledReturn(activePlayers);
        let potPlayers = activePlayers;
        if (uncalledReturn) {
            potPlayers = activePlayers.map(p => (
                p.seat === uncalledReturn.seat
                    ? { seat: p.seat, player: { ...p.player, totalHandBet: uncalledReturn.cappedTotalHandBet } }
                    : p
            ));
            results.push({
                seat: uncalledReturn.seat,
                amount: uncalledReturn.amount,
                handRank: null,
                winningCards: null,
                reason: 'uncalled_return',
                isSidePot: false,
                isUncalledReturn: true,
                potLabel: 'RETURNED',
                potIndex: -1,
                eligibleSeats: [uncalledReturn.seat]
            });
        }

        // [FOLD_EXCESS_RETURN_2026_11_01] 폴드한 사람이 살아 있는 사람의 최대 베팅보다 더 낸 부분은
        //   겨룰 사람이 없어 calculateSidePots 의 어느 팟에도 안 잡히고 사라졌다
        //   (대회 46 핸드 13001116: SB 2000 폴드 · BB 900 올인 → 1,100 소실, 09-24 핸드 8975252 790.25 도 같은 모양).
        //   낸 사람에게 반환으로 돌려준다. 파트너 정산(GameEngine matchedBet/uncalledReturn)은 이미 이 몫을
        //   돌려주는 계산이라 칩과 지갑이 같아진다. 살아 있는 베팅 안쪽의 죽은 돈은 그대로 팟에 남는다.
        let liveMax = 0;
        for (const p of potPlayers) {
            if (!p.player.isFolded && p.player.totalHandBet > liveMax) liveMax = p.player.totalHandBet;
        }
        potPlayers = potPlayers.map(p => {
            if (!p.player.isFolded || !(p.player.totalHandBet > liveMax)) return p;
            const amount = roundMoney(p.player.totalHandBet - liveMax);
            if (amount > 0) {
                results.push({
                    seat: p.seat,
                    amount,
                    handRank: null,
                    winningCards: null,
                    reason: 'uncalled_return',
                    isSidePot: false,
                    isUncalledReturn: true,
                    potLabel: 'RETURNED',
                    potIndex: -1,
                    eligibleSeats: [p.seat]
                });
            }
            return { seat: p.seat, player: { ...p.player, totalHandBet: liveMax } };
        });

        // 사이드 팟 계산 (반환분을 제외한 capped 기여금 기준)
        const pots = this.calculateSidePots(potPlayers);

        // 각 팟별로 승자 결정
        for (let potIndex = 0; potIndex < pots.length; potIndex++) {
            const pot = pots[potIndex];
            // 해당 팟에 자격 있는 플레이어들
            const eligiblePlayers = activePlayers.filter(
                p => pot.eligibleSeats.includes(p.seat) && !p.player.isFolded
            );

            if (eligiblePlayers.length === 0) continue;

            // 핸드 평가
            const playersWithHands = eligiblePlayers.map(p => ({
                seat: p.seat,
                holeCards: p.player.hand
            }));

            const winners = HandEvaluator.determineWinners(playersWithHands, communityCards);

            // 팟 분배 (동점 시 균등 분배)
            // [DECIMAL_STAKES_2026_08_30] 칩이 소수가 되면서 나눗셈이 센트 아래로 떨어진다.
            // 몫은 센트 단위로 버리고 나머지는 아래에서 첫 승자에게 준다 — 사라지는 돈이 없다.
            const { share: shareAmount, remainder: splitRemainder } = splitEvenly(pot.amount, winners.length);
            let remainder = splitRemainder;

            for (let i = 0; i < winners.length; i++) {
                const winner = winners[i];
                // 나머지는 첫 번째 승자에게 (딜러에서 시계방향 가장 빠른 사람)
                const amount = roundMoney(shareAmount + (i === 0 ? remainder : 0));

                // [#81372 순차 사이드팟 지급] 같은 좌석이 여러 팟에서 이겨도
                // 팟별 지급 정보(단계별 연출용)를 보존하기 위해 합산하지 않고 팟마다 별도 결과로 남긴다.
                // 좌석별 합계가 필요한 소비처(정산/파트너 콜백 등)는 potIndex 기준으로 직접 합산해야 한다.
                results.push({
                    seat: winner.seat,
                    amount,
                    handRank: winner.handResult.description || winner.handResult.rankName,
                    winningCards: winner.handResult.bestCards,
                    description: winner.handResult.description,
                    isSidePot: potIndex > 0,
                    potLabel: potIndex === 0 ? 'MAIN POT' : `SIDE POT ${potIndex}`,
                    potIndex,
                    eligibleSeats: pot.eligibleSeats
                });
            }
        }

        return results;
    }

    /**
     * 팟 상태 스냅샷 (UI 표시용)
     */
    static getPotSnapshot(players) {
        const pots = this.calculateSidePots(players);

        if (pots.length === 0) {
            return { mainPot: 0, sidePots: [] };
        }

        // 첫 번째 팟이 메인 팟
        const mainPot = pots[0].amount;
        const sidePots = pots.slice(1).map((pot, index) => ({
            id: index + 1,
            amount: pot.amount,
            eligibleSeats: pot.eligibleSeats
        }));

        return {
            mainPot,
            sidePots,
            total: pots.reduce((sum, pot) => sum + pot.amount, 0)
        };
    }

    /**
     * 팟 분배 검증 (디버그용)
     */
    static validateDistribution(players, results) {
        // 총 베팅 금액
        const totalBet = players.reduce((sum, p) => sum + p.player.totalHandBet, 0);

        // 총 분배 금액
        const totalDistributed = results.reduce((sum, r) => sum + r.amount, 0);

        if (totalBet !== totalDistributed) {
            console.warn(`[POT] Validation failed: bet=${totalBet}, distributed=${totalDistributed}`);
            return false;
        }

        return true;
    }
}

module.exports = PotManager;
