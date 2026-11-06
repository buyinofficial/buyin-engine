const test = require('node:test');
const assert = require('node:assert');
const { RateLimiter } = require('../src/limits');

test('요청 제한: 버킷만큼 통과하고, 시간이 지나면 다시 찬다(키마다 따로)', () => {
    let t = 0;
    const l = new RateLimiter(2, 3, () => t);
    assert.deepStrictEqual([l.take('a'), l.take('a'), l.take('a'), l.take('a')], [true, true, true, false]);
    assert.ok(l.take('b'), 'other key has its own bucket');
    t += 500;   // 0.5초 → 1개 참
    assert.ok(l.take('a'));
    assert.ok(!l.take('a'));
});
