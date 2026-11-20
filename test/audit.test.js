const test = require('node:test');
const assert = require('node:assert');
const { auditReport } = require('../src/audit');
const Engine = require('../src/Engine');

// [FRESH_LINKS_0_10_26] every address of the engine itself in the report carries the deployment tag,
// so an AI web tool cannot answer from an old copy of an earlier deployment
test('self links carry ?v=<composeHash prefix>', () => {
    const info = { ...new Engine({ mode: 'dev' }).call('info'), commit: 'c0ffee', attestation: { composeHash: 'ab'.repeat(32), appCompose: '{}' } };
    const base = 'https://tee.example';
    const text = auditReport(info, { hands: 1 }, 0, base, { review: { files: 1, treeHash: 'x', git: { src: 's', packageJson: 'p' } } });
    const self = text.match(/https:\/\/tee\.example\/[^\s)`|]*/g) || [];
    assert.ok(self.length >= 5, 'report links its own pages');
    for (const u of self) assert.ok(u.includes('?v=' + 'ab'.repeat(8)), 'untagged self link: ' + u);
    assert.ok(text.includes('?v=' + 'ab'.repeat(8) + '` (it changes with every deployment)'));
});
