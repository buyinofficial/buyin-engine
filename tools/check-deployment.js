#!/usr/bin/env node
/**
 * Check that the live BUY-IN engine is this repository, without trusting the operator.
 *
 *   git clone https://github.com/buyinofficial/buyin-engine && cd buyin-engine
 *   node tools/check-deployment.js <engine address>          (Node 18+, no dependencies)
 *
 * 1. The TDX quote is genuine Intel (uploaded to Phala's TEE Attestation Explorer, which checks Intel's signature).
 * 2. The quote's report_data = SHA-256 of the engine's public keys → those keys were made inside this TEE.
 * 3. SHA-256(appCompose) = composeHash (the value dstack measures into RTMR3) and the compose pins an image digest.
 * 4. The engine reports the GitHub commit it was built from; this checkout is checked out at that commit.
 * 5. Every file the engine loads (/review/manifest) has the same SHA-256 as the file in this checkout.
 * It prints PASS / FAIL per step and exits 1 on any FAIL.
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const BASE = String(process.argv[2] || '').replace(/\/+$/, '');
if (!/^https?:\/\//.test(BASE)) { console.error('usage: node tools/check-deployment.js https://<app-id>-3900.<dstack-gateway>'); process.exit(2); }
const ROOT = path.join(__dirname, '..');
const sha256 = (b) => crypto.createHash('sha256').update(b).digest('hex');
function stableStringify(v) {
    if (v === null || typeof v !== 'object') return JSON.stringify(v === undefined ? null : v);
    if (Array.isArray(v)) return '[' + v.map(stableStringify).join(',') + ']';
    return '{' + Object.keys(v).filter((k) => v[k] !== undefined).sort().map((k) => JSON.stringify(k) + ':' + stableStringify(v[k])).join(',') + '}';
}
const pub = (j) => ({ kty: j.kty, crv: j.crv, x: j.x, y: j.y });
let failed = 0;
const step = (ok, name, detail) => { if (!ok) failed++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '\n      ' + detail : ''}`); };

(async () => {
    const info = await (await fetch(BASE + '/info')).json();
    const a = info.attestation;
    console.log(`engine ${info.name} ${info.version}  mode=${info.mode}  commit=${info.commit}\n`);
    if (!a) { step(false, 'attestation present', 'no attestation — not running in a TEE'); process.exit(1); }

    // 1. Intel signature — Phala TEE Attestation Explorer verifies the quote against Intel's certificates
    try {
        const fd = new FormData();
        fd.append('hex', String(a.quote).replace(/^0x/, ''));
        const r = await (await fetch('https://proof.t16z.com/api/upload', { method: 'POST', body: fd })).json();
        step(!!(r && r.success && r.quote && r.quote.verified !== false), 'quote is a genuine Intel TDX quote', `report: https://proof.t16z.com/reports/${r && (r.checksum || r.id)}`);
    } catch (e) { step(false, 'quote is a genuine Intel TDX quote', `explorer unreachable (${e.message}) — verify with dcap-qvl instead`); }

    // 2. report_data binds the engine keys
    const want = sha256(stableStringify({ ecdh: pub(info.keys.ecdh), sig: pub(info.keys.sig) }));
    const q = String(a.quote).replace(/^0x/, '');
    step(q.slice(1136, 1200).toLowerCase() === want && a.reportData === want, 'quote report_data = SHA-256(engine public keys)', want);

    // 3. compose measured, image pinned by digest
    step(sha256(a.appCompose) === a.composeHash, 'SHA-256(appCompose) = composeHash (measured into RTMR3)', a.composeHash);
    const image = (String(a.appCompose).match(/ghcr\.io\/[\w./-]+@sha256:[0-9a-f]{64}/) || [])[0];
    step(!!image, 'compose pins the image by digest', image || 'no digest-pinned image');
    console.log(`      rebuild check: the image above must be the one GitHub Actions built from commit ${info.commit}\n      (https://github.com/buyinofficial/buyin-engine/actions?query=${info.commit}) or rebuild it yourself (README).`);

    // 4. this checkout is the engine's commit
    let head = '';
    try { head = execSync('git rev-parse HEAD', { cwd: ROOT }).toString().trim(); } catch (_e) { /* not a git checkout */ }
    step(!!info.commit && head === info.commit, 'this checkout is at the engine commit', `engine ${info.commit} · checkout ${head || '(not a git checkout)'}  →  git checkout ${info.commit}`);

    // 5. every loaded file matches this checkout
    const manifest = await (await fetch(BASE + '/review/manifest')).text();
    const bad = [];
    let n = 0;
    for (const line of manifest.trim().split('\n')) {
        const [h, f] = line.split(/\s+/);
        n++;
        let local = null;
        try { local = sha256(fs.readFileSync(path.join(ROOT, f))); } catch (_e) { /* missing */ }
        if (local !== h) bad.push(f);
    }
    step(bad.length === 0, `all ${n} files the engine loads match this checkout`, bad.length ? 'differ: ' + bad.join(', ') : `tree hash ${sha256(manifest)}`);

    console.log(failed ? `\n${failed} check(s) FAILED` : '\nall checks passed — the live engine is this repository at this commit');
    process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
