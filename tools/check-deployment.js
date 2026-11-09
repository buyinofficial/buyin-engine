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
 * 4. The engine reports the GitHub commit it was built from; the GitHub Release of its version lists the same image digest and
 *    commit (written by the build workflow, next to GitHub's signed build provenance); this checkout is at that commit.
 * 5. Every file the engine loads (/review/manifest) has the same SHA-256 as the file in this checkout.
 * 6. The server state is the repository: the deployment file the TEE measured is `deploy/docker-compose.yml` of a commit in
 *    this repository, the only values set outside the repository are the two secret tokens (TEE_RPC_TOKEN, CLOUDFLARE_API_TOKEN), and the OS image is `deploy/tee-os.txt`.
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
    // 3b. the image digest is the one GitHub built from the engine's commit (Release written by the workflow)
    try {
        const rel = await (await fetch(`https://api.github.com/repos/buyinofficial/buyin-engine/releases/tags/v${info.version}`, { headers: { Accept: 'application/vnd.github+json' } })).json();
        const body = String(rel.body || '');
        const ok = !!image && body.includes(image) && !!info.commit && body.includes(info.commit);
        step(ok, `GitHub Release v${info.version} lists this image digest and commit`, `${rel.html_url || 'no release'}${ok ? '' : ' — release body does not match'}\n      signed provenance: gh attestation verify oci://${image} --repo buyinofficial/buyin-engine`);
    } catch (e) { step(false, `GitHub Release v${info.version} lists this image digest and commit`, `GitHub API unreachable (${e.message})`); }

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

    // 6. server state = repository: deployment file, values set outside the repository, OS image
    let app = {};
    try { app = JSON.parse(a.appCompose); } catch (_e) { /* checked by step 3 */ }
    const git = (cmd) => execSync(cmd, { cwd: ROOT, stdio: ['ignore', 'pipe', 'ignore'] }).toString();
    let at = null;
    try {
        for (const c of git('git rev-list --all -- deploy/docker-compose.yml').trim().split('\n').filter(Boolean)) {
            if (git(`git show ${c}:deploy/docker-compose.yml`) === app.docker_compose_file) { at = c; break; }
        }
    } catch (_e) { /* not a git checkout */ }
    step(!!at, 'the deployment file the TEE measured is deploy/docker-compose.yml in this repository', at ? `commit ${at}` : 'no commit has this exact file');
    const envs = JSON.stringify([...(app.allowed_envs || [])].sort());
    // CLOUDFLARE_API_TOKEN: DNS-only token for buyinholdem.com, used by dstack-ingress to obtain the TLS certificate inside the TEE
    step(envs === '["CLOUDFLARE_API_TOKEN","TEE_RPC_TOKEN"]' && !app.pre_launch_script, 'nothing else is set outside the repository (only the two secret tokens, no pre-launch script)', `allowed_envs ${envs}`);
    let vm = a.vmConfig;
    try { vm = typeof vm === 'string' ? JSON.parse(vm) : vm; } catch (_e) { vm = null; }
    let declared = '';
    try { declared = git(`git show ${at || 'HEAD'}:deploy/tee-os.txt`).split('\n').filter((l) => l && !l.startsWith('#'))[0] || ''; } catch (_e) { /* missing */ }
    const [osName, osHash] = declared.trim().split(/\s+/);
    const osOk = !!vm && vm.image === osName && vm.os_image_hash === osHash;
    step(osOk, `the OS image is the one declared in deploy/tee-os.txt (${osName || 'none'})`,
        `TEE reports ${vm ? `${vm.image} ${vm.os_image_hash}` : 'no vm_config'}${/-dev-/.test(String(vm && vm.image)) ? '\n      NOTE: development OS — the operator can open an SSH debug shell; not for real-money play' : ''}`);

    console.log(failed ? `\n${failed} check(s) FAILED` : '\nall checks passed — the live engine is this repository at this commit');
    process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
