#!/usr/bin/env node
/**
 * Check that the design files the table page loads from the operator's resource server are exactly the files listed,
 * with SHA-256, in resources.sha256 of this repository.
 *
 *   node tools/check-resources.js            (uses ./resources.sha256 of this checkout)
 *
 * Why: images, sounds and videos are not inside the engine image (they are design work, not code). The page's code,
 * styles and the card font are inside the image and covered by tools/check-deployment.js. What a design file shows
 * never depends on a card (card faces are text drawn with the font served by the TEE), but this check lets anyone see
 * that the operator serves the published files and nothing else at those paths.
 * The resource server answers only requests made from the table page, so the request carries the page's address as Referer.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const LIST = path.join(__dirname, '..', 'resources.sha256');
const BASE = 'https://resource.buyinholdem.com/buyin-table/';
const REFERER = process.env.REFERER || 'https://tee.buyinholdem.com/table/';

(async () => {
    const rows = fs.readFileSync(LIST, 'utf8').split('\n').filter((l) => l && !l.startsWith('#'))
        .map((l) => { const m = l.match(/^([0-9a-f]{64})\s+(.+)$/); return m && { hash: m[1], file: m[2].trim() }; }).filter(Boolean);
    let bad = 0;
    for (const { hash, file } of rows) {
        let got = '';
        try {
            const r = await fetch(BASE + file, { headers: { Referer: REFERER }, signal: AbortSignal.timeout(30000) });
            got = r.ok ? crypto.createHash('sha256').update(Buffer.from(await r.arrayBuffer())).digest('hex') : `HTTP ${r.status}`;
        } catch (e) { got = e.message; }
        const ok = got === hash;
        if (!ok) bad++;
        console.log(`${ok ? 'PASS' : 'FAIL'}  ${file}${ok ? '' : `  expected ${hash.slice(0, 16)}…  got ${got.slice(0, 16)}`}`);
    }
    console.log(bad ? `\n${bad} of ${rows.length} file(s) differ from resources.sha256` : `\nall ${rows.length} design files match resources.sha256`);
    process.exit(bad ? 1 : 0);
})();
