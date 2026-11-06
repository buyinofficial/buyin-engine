/**
 * 덱 · 섞기 · 카드 약속
 *
 * 섞기는 무작위 함수를 직접 부르지 않고 "씨앗"에서 결정적으로 만든다. 그래야 판이 끝난 뒤 누구나 같은 덱을 다시 만들어 볼 수 있다.
 *
 *   1. 엔진이 다음 판 씨앗(seed, 32바이트)을 미리 만들고 그 해시(seedCommit)만 먼저 알린다.
 *   2. 판 사이에 회원들이 무작위 값(entropy)을 보낸다. 씨앗은 이미 정해져 있으니 누구도 결과를 고를 수 없고,
 *      회원 값이 섞이니 엔진도 결과를 미리 정할 수 없다.
 *   3. 섞기 키 = HMAC(seed, [handId, 회원 값들]) → HMAC 카운터로 만든 난수로 피셔-예이츠.
 *   4. 카드마다 약속 C_i = SHA256(handId | i | 카드 | salt_i) 를 판 시작 때 공개한다. salt_i 는 씨앗에서 나온다.
 *      카드를 공개할 때는 (i, 카드, salt_i) 를 같이 준다 — 받은 사람이 C_i 와 맞춰 "판 도중 바뀌지 않았다"를 바로 확인한다.
 *   5. 판이 끝나면 씨앗을 공개한다(기록). seedCommit·덱·약속 전체를 누구나 다시 계산할 수 있다.
 *
 * 카드 표기와 덱 순서는 소켓 서버와 같다: 'As', 'Td', … (무늬 s h d c × 숫자 2…A). 딜은 덱 끝에서 꺼낸다(pop).
 */

const crypto = require('crypto');
const { sha256hex, stableStringify } = require('./crypto');

const SUITS = ['s', 'h', 'd', 'c'];
const RANKS = ['2', '3', '4', '5', '6', '7', '8', '9', 'T', 'J', 'Q', 'K', 'A'];

function newDeck() {
    const deck = [];
    for (const suit of SUITS) for (const rank of RANKS) deck.push(rank + suit);
    return deck;
}

function newSeed() {
    return crypto.randomBytes(32).toString('hex');
}

function seedCommitOf(seedHex) {
    return sha256hex(Buffer.from(seedHex, 'hex'));
}

/** 회원 값은 좌석 순으로 정렬해 섞는다 — 받은 순서가 결과를 바꾸지 않게 */
function shuffleKey(seedHex, handId, entropies) {
    const list = (entropies || []).map(e => [Number(e.seat), String(e.hex)]).sort((a, b) => a[0] - b[0]);
    return crypto.createHmac('sha256', Buffer.from(seedHex, 'hex'))
        .update(stableStringify(['pz-mix-v1', String(handId), list]))
        .digest();
}

/** HMAC-SHA256 카운터 난수 — 같은 키면 언제나 같은 순서의 수가 나온다 */
class Drbg {
    constructor(key) {
        this.key = key;
        this.counter = 0;
        this.buf = Buffer.alloc(0);
    }

    _u32() {
        if (this.buf.length < 4) {
            const block = crypto.createHmac('sha256', this.key).update('pz-drbg-v1|' + (this.counter++)).digest();
            this.buf = Buffer.concat([this.buf, block]);
        }
        const v = this.buf.readUInt32BE(0);
        this.buf = this.buf.subarray(4);
        return v;
    }

    /** 0 ≤ r < n, 치우침 없이 (거절 표본) */
    below(n) {
        const limit = Math.floor(0x100000000 / n) * n;
        for (;;) {
            const x = this._u32();
            if (x < limit) return x % n;
        }
    }
}

function shuffledDeck(seedHex, handId, entropies) {
    const deck = newDeck();
    const rng = new Drbg(shuffleKey(seedHex, handId, entropies));
    for (let i = deck.length - 1; i > 0; i--) {
        const j = rng.below(i + 1);
        [deck[i], deck[j]] = [deck[j], deck[i]];
    }
    return deck;
}

function saltOf(seedHex, handId, index) {
    return crypto.createHmac('sha256', Buffer.from(seedHex, 'hex'))
        .update('pz-salt-v1|' + handId + '|' + index)
        .digest().subarray(0, 16).toString('hex');
}

function cardCommitment(handId, index, card, salt) {
    return sha256hex('pz-card-v1|' + handId + '|' + index + '|' + card + '|' + salt);
}

/** 판 시작 때 공개하는 약속 52개와 그 묶음 해시 */
function commitDeck(seedHex, handId, deck) {
    const commitments = deck.map((card, i) => cardCommitment(handId, i, card, saltOf(seedHex, handId, i)));
    return { commitments, deckCommit: sha256hex(commitments.join(',')) };
}

/** 공개할 카드 한 장: { i, c, s } — 받은 쪽은 cardCommitment(handId, i, c, s) === commitments[i] 로 확인 */
function opening(seedHex, handId, deck, index) {
    return { i: index, c: deck[index], s: saltOf(seedHex, handId, index) };
}

function checkOpening(handId, commitments, op) {
    return !!op && Number.isInteger(op.i) && op.i >= 0 && op.i < 52
        && commitments[op.i] === cardCommitment(handId, op.i, op.c, op.s);
}

module.exports = {
    SUITS, RANKS, newDeck, newSeed, seedCommitOf, shuffleKey, Drbg, shuffledDeck,
    saltOf, cardCommitment, commitDeck, opening, checkOpening,
};
