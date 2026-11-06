const test = require('node:test');
const assert = require('node:assert');
const Engine = require('../src/Engine');
const { reportDataFor, quoteReportData, checkInfoBinding } = require('../src/attest');

/** TDX quote 모양만 흉내 — report_data 자리에 값을 넣는다 (하드웨어 서명은 없다) */
function fakeQuote(reportDataHex) {
    const buf = Buffer.alloc(48 + 584 + 64);
    Buffer.from(reportDataHex.padEnd(128, '0'), 'hex').copy(buf, 48 + 520);
    return buf.toString('hex');
}

test('증명서: 엔진 공개키가 quote 의 report_data 에 묶인다', () => {
    let att = null;
    const engine = new Engine({ mode: 'dstack', attest: () => att });
    const keys = engine.call('info').keys;
    const rd = reportDataFor(keys);
    assert.match(rd, /^[0-9a-f]{64}$/);
    att = { type: 'dstack-tdx', reportData: rd, quote: fakeQuote(rd) };
    const info = engine.call('info');
    assert.deepStrictEqual(checkInfoBinding(info), []);
    assert.strictEqual(quoteReportData(Buffer.from(att.quote, 'hex').toString('base64')).slice(0, 64), rd, 'base64 quote too');
});

test('증명서: 다른 키의 증명서를 붙이면 들킨다', () => {
    const other = new Engine({ mode: 'dev' }).call('info').keys;
    let att = null;
    const engine = new Engine({ mode: 'dstack', attest: () => att });
    const rdOther = reportDataFor(other);
    att = { type: 'dstack-tdx', reportData: rdOther, quote: fakeQuote(rdOther) };
    const errors = checkInfoBinding(engine.call('info'));
    assert.ok(errors.some(e => /reportData differs/.test(e)));
    assert.ok(errors.some(e => /quote report_data differs/.test(e)));
});

test('증명서: 개발 모드는 증명서가 없다고 말한다', () => {
    const errors = checkInfoBinding(new Engine({ mode: 'dev' }).call('info'));
    assert.deepStrictEqual(errors, ['no attestation (engine is not running in a TEE)']);
});

test('RULES 2장 — TEE 모드에서 시험 설정을 켜면 엔진이 뜨지 않는다', () => {
    assert.throws(() => new Engine({ mode: 'dstack', allowUnsigned: true }), /only allowed in dev mode/);
});
