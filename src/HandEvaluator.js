/**
 * HandEvaluator - 텍사스 홀덤 핸드 평가 시스템
 *
 * 역할:
 * - 7장(홀카드 2장 + 커뮤니티 5장)에서 최고 5장 조합 찾기
 * - 핸드 랭킹 평가
 * - 핸드 간 비교
 */

// 핸드 랭킹 (높을수록 강함)
const HAND_RANKS = {
    HIGH_CARD: 1,
    ONE_PAIR: 2,
    TWO_PAIR: 3,
    THREE_OF_A_KIND: 4,
    STRAIGHT: 5,
    FLUSH: 6,
    FULL_HOUSE: 7,
    FOUR_OF_A_KIND: 8,
    STRAIGHT_FLUSH: 9,
    ROYAL_FLUSH: 10
};

const HAND_NAMES = {
    1: 'High Card',
    2: 'One Pair',
    3: 'Two Pair',
    4: 'Three of a Kind',
    5: 'Straight',
    6: 'Flush',
    7: 'Full House',
    8: 'Four of a Kind',
    9: 'Straight Flush',
    10: 'Royal Flush'
};

// 카드 값 (A가 14)
const CARD_VALUES = {
    '2': 2, '3': 3, '4': 4, '5': 5, '6': 6, '7': 7, '8': 8,
    '9': 9, 'T': 10, 'J': 11, 'Q': 12, 'K': 13, 'A': 14
};

class HandEvaluator {
    /**
     * 핸드 평가
     * @param {string[]} holeCards - 홀카드 2장 ['As', 'Kh']
     * @param {string[]} communityCards - 커뮤니티 5장 ['Qs', 'Js', 'Ts', '2d', '3c']
     * @returns {Object} { rank, rankName, score, bestCards, description }
     */
    static evaluate(holeCards, communityCards) {
        const allCards = [...holeCards, ...communityCards];

        // 모든 5장 조합 평가
        const combinations = this.getCombinations(allCards, 5);
        let bestHand = null;

        for (const combo of combinations) {
            const hand = this.evaluateFiveCards(combo);
            if (!bestHand || this.compareHands(hand, bestHand) > 0) {
                bestHand = hand;
            }
        }

        return bestHand;
    }

    /**
     * 5장 카드 평가
     */
    static evaluateFiveCards(cards) {
        const parsed = cards.map(c => this.parseCard(c));

        // 정렬 (높은 순)
        parsed.sort((a, b) => b.value - a.value);

        const suits = parsed.map(c => c.suit);
        const values = parsed.map(c => c.value);

        const isFlush = suits.every(s => s === suits[0]);
        const isStraight = this.checkStraight(values);
        const valueCounts = this.countValues(values);
        const counts = Object.values(valueCounts).sort((a, b) => b - a);

        let rank, score, description;

        // Royal Flush
        if (isFlush && isStraight && values[0] === 14 && values[4] === 10) {
            rank = HAND_RANKS.ROYAL_FLUSH;
            score = this.calculateScore(rank, values);
            description = 'Royal Flush';
        }
        // Straight Flush
        else if (isFlush && isStraight) {
            rank = HAND_RANKS.STRAIGHT_FLUSH;
            // A-2-3-4-5 스트레이트 처리
            const highCard = values[0] === 14 && values[1] === 5 ? 5 : values[0];
            score = this.calculateScore(rank, [highCard]);
            description = `Straight Flush, ${this.getValueName(highCard)} high`;
        }
        // Four of a Kind
        else if (counts[0] === 4) {
            rank = HAND_RANKS.FOUR_OF_A_KIND;
            const quadValue = this.getValueByCount(valueCounts, 4);
            const kicker = this.getValueByCount(valueCounts, 1);
            score = this.calculateScore(rank, [quadValue, kicker]);
            description = `Four of a Kind, ${this.getValueName(quadValue)}s`;
        }
        // Full House
        else if (counts[0] === 3 && counts[1] === 2) {
            rank = HAND_RANKS.FULL_HOUSE;
            const tripValue = this.getValueByCount(valueCounts, 3);
            const pairValue = this.getValueByCount(valueCounts, 2);
            score = this.calculateScore(rank, [tripValue, pairValue]);
            description = `Full House, ${this.getValueName(tripValue)}s full of ${this.getValueName(pairValue)}s`;
        }
        // Flush
        else if (isFlush) {
            rank = HAND_RANKS.FLUSH;
            score = this.calculateScore(rank, values);
            description = `Flush, ${this.getValueName(values[0])} high`;
        }
        // Straight
        else if (isStraight) {
            rank = HAND_RANKS.STRAIGHT;
            // A-2-3-4-5 스트레이트 처리
            const highCard = values[0] === 14 && values[1] === 5 ? 5 : values[0];
            score = this.calculateScore(rank, [highCard]);
            description = `Straight, ${this.getValueName(highCard)} high`;
        }
        // Three of a Kind
        else if (counts[0] === 3) {
            rank = HAND_RANKS.THREE_OF_A_KIND;
            const tripValue = this.getValueByCount(valueCounts, 3);
            const kickers = this.getValuesByCount(valueCounts, 1).slice(0, 2);
            score = this.calculateScore(rank, [tripValue, ...kickers]);
            description = `Three of a Kind, ${this.getValueName(tripValue)}s`;
        }
        // Two Pair
        else if (counts[0] === 2 && counts[1] === 2) {
            rank = HAND_RANKS.TWO_PAIR;
            const pairs = this.getValuesByCount(valueCounts, 2);
            const kicker = this.getValueByCount(valueCounts, 1);
            score = this.calculateScore(rank, [...pairs, kicker]);
            description = `Two Pair, ${this.getValueName(pairs[0])}s and ${this.getValueName(pairs[1])}s`;
        }
        // One Pair
        else if (counts[0] === 2) {
            rank = HAND_RANKS.ONE_PAIR;
            const pairValue = this.getValueByCount(valueCounts, 2);
            const kickers = this.getValuesByCount(valueCounts, 1).slice(0, 3);
            score = this.calculateScore(rank, [pairValue, ...kickers]);
            description = `Pair of ${this.getValueName(pairValue)}s`;
        }
        // High Card
        else {
            rank = HAND_RANKS.HIGH_CARD;
            score = this.calculateScore(rank, values);
            description = `High Card, ${this.getValueName(values[0])}`;
        }

        return {
            rank,
            rankName: HAND_NAMES[rank],
            score,
            bestCards: cards,
            description
        };
    }

    /**
     * 카드 파싱
     */
    static parseCard(card) {
        const rank = card[0];
        const suit = card[1];
        return {
            rank,
            suit,
            value: CARD_VALUES[rank],
            original: card
        };
    }

    /**
     * 스트레이트 체크
     */
    static checkStraight(values) {
        // 일반 스트레이트
        let isNormalStraight = true;
        for (let i = 0; i < 4; i++) {
            if (values[i] - values[i + 1] !== 1) {
                isNormalStraight = false;
                break;
            }
        }

        // A-2-3-4-5 스트레이트 (휠)
        const isWheel = values[0] === 14 && values[1] === 5 &&
                        values[2] === 4 && values[3] === 3 && values[4] === 2;

        return isNormalStraight || isWheel;
    }

    /**
     * 값 카운트
     */
    static countValues(values) {
        const counts = {};
        for (const v of values) {
            counts[v] = (counts[v] || 0) + 1;
        }
        return counts;
    }

    /**
     * 특정 카운트의 값 가져오기
     */
    static getValueByCount(counts, targetCount) {
        for (const [value, count] of Object.entries(counts)) {
            if (count === targetCount) {
                return parseInt(value);
            }
        }
        return 0;
    }

    /**
     * 특정 카운트의 모든 값 가져오기 (높은 순)
     */
    static getValuesByCount(counts, targetCount) {
        const result = [];
        for (const [value, count] of Object.entries(counts)) {
            if (count === targetCount) {
                result.push(parseInt(value));
            }
        }
        return result.sort((a, b) => b - a);
    }

    /**
     * 점수 계산 (비교용)
     * 점수 = rank * 10^10 + value1 * 10^8 + value2 * 10^6 + ...
     */
    static calculateScore(rank, values) {
        let score = rank * Math.pow(10, 10);
        for (let i = 0; i < values.length && i < 5; i++) {
            score += values[i] * Math.pow(10, 8 - i * 2);
        }
        return score;
    }

    /**
     * 핸드 비교
     * @returns {number} 양수면 hand1 승, 음수면 hand2 승, 0이면 동점
     */
    static compareHands(hand1, hand2) {
        return hand1.score - hand2.score;
    }

    /**
     * 여러 핸드 중 승자 결정
     * @param {Array} players - [{ seat, holeCards }]
     * @param {string[]} communityCards
     * @returns {Array} 승자 목록 (동점 가능)
     */
    static determineWinners(players, communityCards) {
        const evaluatedHands = players.map(p => ({
            ...p,
            handResult: this.evaluate(p.holeCards, communityCards)
        }));

        // 최고 점수 찾기
        let maxScore = 0;
        for (const player of evaluatedHands) {
            if (player.handResult.score > maxScore) {
                maxScore = player.handResult.score;
            }
        }

        // 승자들 (동점 포함)
        return evaluatedHands.filter(p => p.handResult.score === maxScore);
    }

    /**
     * 조합 생성 (nCr)
     */
    static getCombinations(arr, r) {
        const result = [];

        function combine(start, combo) {
            if (combo.length === r) {
                result.push([...combo]);
                return;
            }

            for (let i = start; i < arr.length; i++) {
                combo.push(arr[i]);
                combine(i + 1, combo);
                combo.pop();
            }
        }

        combine(0, []);
        return result;
    }

    /**
     * 값 이름
     */
    static getValueName(value) {
        const names = {
            14: 'Ace', 13: 'King', 12: 'Queen', 11: 'Jack', 10: 'Ten',
            9: 'Nine', 8: 'Eight', 7: 'Seven', 6: 'Six', 5: 'Five',
            4: 'Four', 3: 'Three', 2: 'Two'
        };
        return names[value] || value;
    }
}

// 상수 내보내기
HandEvaluator.HAND_RANKS = HAND_RANKS;
HandEvaluator.HAND_NAMES = HAND_NAMES;

module.exports = HandEvaluator;
