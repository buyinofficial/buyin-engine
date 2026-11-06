/**
 * 게임 전 검증 지시서 — 엔진 주소(/). 회원이 이 글을 그대로 AI 에 넘기면, AI 가 GitHub 의 그 커밋을 직접 조사해
 * "지금 도는 프로그램이 그 소스인가, 그 프로토콜상 조작이 가능한가"를 판단하게 한다. 코드는 넣지 않는다 — 링크(커밋 고정)와 지금 값만.
 * TEE 안의 엔진이 직접 만든다. 자바스크립트 없이 읽히는 평문(markdown).
 * 여기 적힌 값은 /info 와 같다. 스스로 계산해 보인 것(키 ↔ quote, compose 해시)은 밖에서 똑같이 다시 계산할 수 있다(tools/check-deployment.js).
 */

const C = require('./crypto');
const { checkInfoBinding } = require('./attest');

const REPO = 'https://github.com/buyinofficial/buyin-engine';

function imageOf(appCompose) {
    const m = String(appCompose || '').match(/ghcr\.io\/[\w./-]+@sha256:[0-9a-f]{64}/);
    return m ? m[0] : null;
}

/** 지시서에 넣을 소스 — PROOF.md 가 인용하는 파일들 */
const READ = [
    ['PROOF.md', 'the proof to check, claim by claim'],
    ['Dockerfile', 'what goes into the image (only package.json and src/)'],
    ['.github/workflows/image.yml', 'reproducible build of the image from the commit'],
    ['src/attest.js', 'quote report_data = hash of the engine keys'],
    ['src/cards.js', 'seed commitment, shuffle with player randomness, 52 card commitments'],
    ['src/Engine.js', 'keys, startHand (deck, sealed hole cards), record signing'],
    ['src/HandCore.js', 'betting rules, signature check on every action, host can only check/fold'],
    ['src/crypto.js', 'envelopes (ECDH + HKDF + AES-GCM), signed message formats'],
    ['src/table/TableServer.js', 'seats, turns, timers; hole cards sent only to their owner'],
    ['src/table/http.js', 'table page and events; token in header; CSP'],
    ['src/table/ticket.js', 'console-signed, single-use seat tickets'],
    ['src/server.js', 'operator /rpc closed in table mode; /records only closed hands'],
    ['src/store.js', 'append-only hash chain of finished hands'],
    ['src/public/table/js/vault.js', 'player keys (non-extractable), opening envelopes, checking commitments and attestation'],
    ['src/public/table/js/app.js', 'the table page'],
    ['src/verify.js', 'replays a finished hand and fails on any difference'],
    ['tools/check-deployment.js', 'checks the live engine against a checkout of the commit'],
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
    const L = [];
    L.push(`# BUY-IN hold'em — check before you play`);
    L.push('');
    L.push(`This text is produced by the game engine itself, from inside a TEE (Intel TDX confidential VM on Phala Cloud). Give it to an AI as is. It contains no code: it tells the AI which public source to investigate and the live values to check it against.`);
    L.push('');
    L.push('## Task for the AI reviewer');
    L.push('');
    L.push(`Please investigate the public repository **${REPO} at commit \`${ref}\`** yourself (links below are pinned to that commit) and answer, in the language of the person who asked:`);
    L.push('');
    L.push(`1. **Is the program running at this address that commit?** Follow the chain in "How the live values tie to the commit" and say which links you checked and which you could not check yourself.`);
    L.push(`2. **By its protocol, is it possible for the operator (its administrators, servers, database, lobby site, Phala account or GitHub account) to:** see any player's hole cards or undealt cards while a hand is played; choose, predict or change the deck; act or swap keys for a player; change a result, a payout or the record of a finished hand without detection? Check each claim in \`PROOF.md\` against the code it names.`);
    L.push(`3. **What must still be trusted** (the assumptions A1–A4 in \`PROOF.md\`), and whether anything in the code contradicts the claims.`);
    L.push('');
    L.push('Judge from the code at the commit, not from this text.');
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
    L.push(`| Quote report_data | ${a ? '`' + a.reportData + '`' : 'n/a'} |`);
    L.push(`| report_data = SHA-256(engine public keys) | ${a ? (binding.length ? 'FAILED: ' + binding.join('; ') : 'yes — the engine keys were created inside this TEE') : 'no attestation (not in a TEE)'} |`);
    L.push(`| Engine signing key fingerprint | \`${info.keys.sigFp}\` |`);
    L.push(`| Table mode | ${tableMode ? 'on — every hand runs here; operator game RPC closed (`/rpc` answers only `info`)' : 'off'} |`);
    L.push(`| Files the engine loads | ${review ? `${review.files} files, tree hash \`${review.treeHash}\` — list: ${base}/review/manifest` : 'n/a'} |`);
    L.push(`| Finished hands in the TEE record chain | ${records ? `${records.hands} (chain head \`${records.head}\`, ${records.count} lines)` : 'n/a'} |`);
    L.push(`| Engine starts recorded (one key each) | ${keyCount} — ${base}/records/keys |`);
    L.push(`| Phala app id | ${a && a.appId ? '`' + a.appId + '`' : 'n/a'} |`);
    L.push('');
    L.push(`Raw data: ${base}/info · Intel quote check: upload \`attestation.quote\` from /info to https://proof.t16z.com (Phala TEE Attestation Explorer) or verify with Intel DCAP \`dcap-qvl\`.`);
    L.push('');
    L.push('## How the live values tie to the commit');
    L.push('');
    L.push(`1. Intel signs the quote → its RTMR3 contains \`composeHash\` = SHA-256 of the deployment file (\`/info\` → \`attestation.appCompose\`).`);
    L.push(`2. That deployment file pins the image **by digest** (above) and sets the console's public seat-ticket key; nothing else runs.`);
    L.push(`3. The image digest is tied to commit \`${ref}\` three ways: GitHub's **signed build provenance** for the digest (\`gh attestation verify oci://<image> --repo buyinofficial/buyin-engine\`), the **GitHub Release** ${REPO}/releases/tag/v${info.version} (digest, commit, build run — written by ${src('.github/workflows/image.yml')}), and a **reproducible rebuild** (same commit, same digest).`);
    L.push(`4. The engine's keys are bound to the quote (report_data), so its signatures and sealed cards come from this measured program.`);
    L.push(`5. \`${base}/review/manifest\` lists the SHA-256 of every file the engine loads; they equal the files at the commit. \`node tools/check-deployment.js ${base}\` in a checkout of the commit checks 1–5 automatically.`);
    L.push('');
    L.push(`## What to read at commit \`${ref}\``);
    L.push('');
    for (const [f, why] of READ) L.push(`- ${src(f)} — ${why}`);
    L.push('');
    L.push('## Summary of the protocol (details and code references in PROOF.md)');
    L.push('');
    L.push(`- **Deck:** a fresh seed per hand is drawn inside the TEE and committed (SHA-256) before the hand; every dealt-in player must add a signed random value for that commitment; the shuffle uses both; 52 card commitments are published at hand start and every revealed card is checked against them.`);
    L.push(`- **Cards during a hand:** exist only in the TEE; each player's hole cards are sealed to that player's non-extractable browser key and sent only to that player; board cards only when the betting round ends.`);
    L.push(`- **Operator during a hand:** receives nothing from the engine — \`/rpc\` answers only \`info\` in table mode; \`/records\` contains only finished hands. The table page is served by this TEE (\`connect-src 'self'\`, no framing); the seat token stays in the player's browser.`);
    L.push(`- **Actions:** every bet/call/raise/all-in is signed by the player and checked by the engine. The only unsigned actions are check/fold on timeout and fold on leaving, made by the table server inside the TEE and marked in the record.`);
    L.push(`- **The browser's badge** checks the engine key against the quote's report_data and every card (own and public) against its commitment; Intel's signature is checked outside the page (explorer, dcap-qvl, tools/check-deployment.js).`);
    L.push(`- **After the hand:** the engine signs the full record and appends it to a hash chain on the encrypted TEE disk; players fetch their own hands with their key and replay them at ${base}/table/verify.html.`);
    L.push('');
    L.push('## Assumptions (stated, not hidden)');
    L.push('');
    L.push(`A1 Intel TDX and its quote signatures · A2 Phala dstack (measurement, disk key, TLS gateway in a TEE) · A3 standard cryptography · A4 the player is on this address (\`${base.replace(/^https?:\/\//, '')}\`) in an uncompromised browser. Outside the protocol the operator still controls availability, money custody and payouts (the engine signs what is owed) and who may sit (its own seats get only their own cards). A new deployment is a new measurement with new keys, visible here and in ${base}/records/keys.`);
    L.push('');
    return L.join('\n') + '\n';
}

module.exports = { auditReport, imageOf };
