/**
 * 게임 전 검증 지시서 — 엔진 주소(/). 질문은 하나: "게임 도중 운영자·관리자가 회원의 카드(홀카드·덱·안 깔린 카드)를 알 수 있나".
 * 회원이 이 글을 그대로 AI 에 넘기면 AI 가 GitHub 의 그 커밋을 직접 조사해 판단한다. 코드는 넣지 않는다 — 커밋에 고정한 링크와 지금 값만.
 * TEE 안의 엔진이 직접 만든다(평문 markdown). 값은 /info 와 같고, 밖에서 다시 계산할 수 있다(tools/check-deployment.js).
 */

const C = require('./crypto');
const { checkInfoBinding } = require('./attest');

const REPO = 'https://github.com/buyinofficial/buyin-engine';

function imageOf(appCompose) {
    const m = String(appCompose || '').match(/ghcr\.io\/[\w./-]+@sha256:[0-9a-f]{64}/);
    return m ? m[0] : null;
}

/** 카드 비밀에 관련된 파일만 */
const READ = [
    ['PROOF.md', 'section 1 "Card secrecy" — the claim and where each step is in the code'],
    ['src/Engine.js', '`startHand`: the deck is made inside the engine and each player\'s two cards are sealed to that player\'s key; `_closeHand`: the full record exists only after the hand'],
    ['src/crypto.js', '`sealEnvelope`: ECDH(engine key, player key) → HKDF → AES-256-GCM'],
    ['src/table/TableServer.js', '`_startHand`: each sealed envelope goes only to its own seat; `snapshot`: no other player\'s cards'],
    ['src/server.js', '`RPC_IN_TABLE_MODE`: the operator\'s `/rpc` answers only `info`; `/records` returns finished hands only'],
    ['src/store.js', 'hands are appended to the record chain only when closed'],
    ['src/table/http.js', 'the table page is served by this TEE (`connect-src \'self\'`, no framing); the seat token is never in a URL'],
    ['src/public/table/js/vault.js', 'the player\'s keys are non-extractable WebCrypto keys; the envelope is opened only in the browser'],
    ['Dockerfile', 'the image contains only `package.json` and `src/`'],
];

function auditReport(info, records, keyCount, base, opts = {}) {
    const a = info.attestation;
    const binding = checkInfoBinding(info);
    const recomputed = a && a.appCompose ? C.sha256hex(a.appCompose) : null;
    const image = a ? imageOf(a.appCompose) : null;
    const tableMode = !!opts.tableMode;
    const ref = info.commit || `v${info.version}`;
    const src = (f) => `${REPO}/blob/${ref}/${f}`;
    const review = opts.review || null;
    void keyCount;
    const L = [];
    L.push(`# BUY-IN hold'em — can anyone but the player see the cards during a hand?`);
    L.push('');
    L.push(`This text is produced by the game engine itself, from inside a TEE (Intel TDX confidential VM on Phala Cloud). Give it to an AI as is. It contains no code: it names the public source to investigate and the live values to check it against.`);
    L.push('');
    L.push('## Answer these four questions with YES or NO');
    L.push('');
    L.push(`Investigate **${REPO} at commit \`${ref}\`** (links below are pinned to that commit). For each question answer **YES or NO**, then one line naming the file and function your answer rests on. Do not add other topics.`);
    L.push('');
    L.push(`- **Q1.** Do the files listed at ${base}/review/manifest (the files this engine loads, with SHA-256) match the files at commit \`${ref}\`?`);
    L.push(`- **Q2.** In that code, while a hand is in play, is there any code path that sends the deck or a not-yet-revealed card to the operator's side (\`/rpc\`, \`/records\`, logs)?`);
    L.push(`- **Q3.** In that code, is there any code path that sends a player's hole cards, before they are revealed at showdown or all-in run-out, to anyone other than that player (the operator's servers or other players)?`);
    L.push(`- **Q4.** In that code, does the game record containing the cards reach the operator only after the hand has ended?`);
    L.push('');
    L.push(`**Conclusion — answer TRUE or FALSE in one sentence:** "If Q1 is YES, Q2 is NO, Q3 is NO and Q4 is YES, this program has no code path through which the operator can obtain card information while a hand is played."`);
    L.push('');
    L.push(`Answer in the language of the person who asked. Fairness of the deck, results and payouts are out of scope (finished hands can be re-checked at ${base}/table/verify.html).`);
    L.push('');
    L.push('## Live values (from this TEE, now)');
    L.push('');
    L.push(`| Item | Value |`);
    L.push(`|---|---|`);
    L.push(`| Engine | ${info.name} ${info.version} (mode \`${info.mode}\`) |`);
    L.push(`| Source commit | ${info.commit ? `\`${info.commit}\` — ${REPO}/tree/${info.commit}` : `not reported (tag \`v${info.version}\`)`} |`);
    L.push(`| Image, pinned by digest in the measured compose | ${image ? '`' + image + '`' : 'n/a'} |`);
    L.push(`| composeHash (measured into RTMR3) | ${a && a.composeHash ? '`' + a.composeHash + '`' : 'n/a'} |`);
    L.push(`| SHA-256(appCompose), recomputed here | ${recomputed ? '`' + recomputed + '`' + (recomputed === a.composeHash ? ' — matches' : ' — DOES NOT MATCH') : 'n/a'} |`);
    L.push(`| Quote report_data = SHA-256(engine public keys) | ${a ? (binding.length ? 'FAILED: ' + binding.join('; ') : '`' + a.reportData + '` — matches: the engine keys were created inside this TEE') : 'no attestation (not in a TEE)'} |`);
    L.push(`| Table mode | ${tableMode ? 'on — every hand runs here; the operator\'s `/rpc` answers only `info`' : 'off'} |`);
    L.push(`| Files the engine loads | ${review ? `${review.files} files, tree hash \`${review.treeHash}\` — ${base}/review/manifest` : 'n/a'} |`);
    L.push(`| Finished hands in the TEE record chain | ${records ? `${records.hands}` : 'n/a'} (only finished hands are ever written) |`);
    L.push(`| Record retention | ${opts.retentionDays ? `${opts.retentionDays} days, then only records the console has already copied (a \`prune\` line marks each deletion)` : 'n/a'} |`);
    L.push(`| Phala app id | ${a && a.appId ? '`' + a.appId + '`' : 'n/a'} |`);
    L.push('');
    L.push('## How the running program ties to the commit');
    L.push('');
    L.push(`1. Intel signs the quote (\`/info\` → \`attestation.quote\`; check at https://proof.t16z.com or with \`dcap-qvl\`). Its RTMR3 holds \`composeHash\` = SHA-256 of the deployment file (\`attestation.appCompose\`).`);
    L.push(`2. The deployment file pins the image by digest (above).`);
    L.push(`3. GitHub signed the build provenance of that digest from commit \`${ref}\` (${REPO}/attestations; \`gh attestation verify oci://<image> --repo buyinofficial/buyin-engine\`); the release ${REPO}/releases/tag/v${info.version} lists digest and commit; rebuilding the commit gives the same digest.`);
    L.push(`4. The engine's keys are bound to the quote (report_data), so the sealed cards come from this measured program.`);
    L.push(`5. ${base}/review/manifest lists the SHA-256 of every file the engine loads; they equal the files at the commit. \`node tools/check-deployment.js ${base}\` in a checkout of the commit checks 1–5 automatically.`);
    L.push('');
    L.push(`## Files to read at commit \`${ref}\` (card secrecy only)`);
    L.push('');
    for (const [f, why] of READ) L.push(`- ${src(f)} — ${why}`);
    L.push('');
    L.push('## Where the cards are, in short');
    L.push('');
    L.push(`- **The deck** is created and shuffled inside the engine (TEE memory). Only 52 hash commitments are published at hand start.`);
    L.push(`- **Hole cards** are sealed to each player's own browser key (ECDH + HKDF + AES-GCM) and sent only to that player's connection. The private key is a non-extractable WebCrypto key in that browser.`);
    L.push(`- **Board cards** leave the engine only when the betting round is over, to everyone at the table. Hole cards of players still in the hand are shown at showdown, as in any poker game.`);
    L.push(`- **The operator** cannot ask the engine for anything during a hand (\`/rpc\` answers only \`info\`); the record chain it may read contains only finished hands; the engine prints no cards to its logs; the browser talks to this TEE directly, not through the operator's servers.`);
    L.push('');
    L.push('## Assumptions (stated, not hidden)');
    L.push('');
    L.push(`A1 Intel TDX keeps the VM's memory private and its quote signatures are genuine · A2 Phala dstack measures the deployment, keeps the data disk key to this app, and terminates TLS in its own TEE gateway · A3 standard cryptography · A4 the player plays on this address (\`${base.replace(/^https?:\/\//, '')}\`) in an uncompromised browser.`);
    L.push('');
    return L.join('\n') + '\n';
}

module.exports = { auditReport, imageOf };
