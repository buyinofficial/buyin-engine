/**
 * 엔진 소스(Node 용 CommonJS)를 브라우저에서 고치지 않고 그대로 돌리기 위한 최소 받침.
 *
 *   - /table/engine/<파일> 은 저장소 파일을 __engineModule(이름, function (require, module, exports, Buffer) { … }) 로 감싸기만 한 것
 *   - require('crypto') 대신 이 파일의 작은 crypto: SHA-256·HMAC(동기, 순수 JS), 공개키 가져오기, 서명 확인
 *   - 서명 확인은 브라우저(WebCrypto)에서 비동기라 동기 코드 안에서 바로 답할 수 없다.
 *     그래서 다시 돌리는 동안 확인할 서명을 모두 모아 두고(일단 '맞다'로 진행), 끝난 뒤 하나하나 실제로 확인한다.
 *     엔진 코드는 서명이 틀리면 거기서 멈추는(던지는) 것밖에 하지 않으므로, 모은 서명이 모두 맞으면 결과는 같다.
 */
(function () {
    'use strict';

    // ---------------------------------------------------------------- SHA-256 (FIPS 180-4)
    const K = new Uint32Array([
        0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
        0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
        0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
        0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
        0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
        0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2]);
    function sha256(bytes) {
        const n = bytes.length, total = ((n + 9 + 63) >> 6) << 6;
        const m = new Uint8Array(total);
        m.set(bytes); m[n] = 0x80;
        const bits = n * 8;
        const dv = new DataView(m.buffer);
        dv.setUint32(total - 8, Math.floor(bits / 0x100000000)); dv.setUint32(total - 4, bits >>> 0);
        const H = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
        const W = new Uint32Array(64);
        const rot = (x, r) => (x >>> r) | (x << (32 - r));
        for (let off = 0; off < total; off += 64) {
            for (let i = 0; i < 16; i++) W[i] = dv.getUint32(off + i * 4);
            for (let i = 16; i < 64; i++) {
                const s0 = rot(W[i - 15], 7) ^ rot(W[i - 15], 18) ^ (W[i - 15] >>> 3);
                const s1 = rot(W[i - 2], 17) ^ rot(W[i - 2], 19) ^ (W[i - 2] >>> 10);
                W[i] = (W[i - 16] + s0 + W[i - 7] + s1) >>> 0;
            }
            let [a, b, c, d, e, f, g, h] = H;
            for (let i = 0; i < 64; i++) {
                const t1 = (h + (rot(e, 6) ^ rot(e, 11) ^ rot(e, 25)) + ((e & f) ^ (~e & g)) + K[i] + W[i]) >>> 0;
                const t2 = ((rot(a, 2) ^ rot(a, 13) ^ rot(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) >>> 0;
                h = g; g = f; f = e; e = (d + t1) >>> 0; d = c; c = b; b = a; a = (t1 + t2) >>> 0;
            }
            H[0] += a; H[1] += b; H[2] += c; H[3] += d; H[4] += e; H[5] += f; H[6] += g; H[7] += h;
        }
        const out = new Uint8Array(32);
        const ov = new DataView(out.buffer);
        for (let i = 0; i < 8; i++) ov.setUint32(i * 4, H[i]);
        return out;
    }
    function hmac(key, msg) {
        let k = key.length > 64 ? sha256(key) : key;
        const kb = new Uint8Array(64); kb.set(k);
        const ipad = new Uint8Array(64 + msg.length), opad = new Uint8Array(64 + 32);
        for (let i = 0; i < 64; i++) { ipad[i] = kb[i] ^ 0x36; opad[i] = kb[i] ^ 0x5c; }
        ipad.set(msg, 64);
        opad.set(sha256(ipad), 64);
        return sha256(opad);
    }

    // ---------------------------------------------------------------- Buffer (엔진이 쓰는 만큼만)
    const enc = new TextEncoder();
    class Buf extends Uint8Array {
        static from(v, encoding) {
            if (typeof v === 'string') {
                if (encoding === 'hex') { const o = new Buf(v.length >> 1); for (let i = 0; i < o.length; i++) o[i] = parseInt(v.substr(i * 2, 2), 16); return o; }
                if (encoding === 'base64url' || encoding === 'base64') {
                    const t = v.replace(/-/g, '+').replace(/_/g, '/'); const bin = atob(t + '==='.slice((t.length + 3) % 4));
                    const o = new Buf(bin.length); for (let i = 0; i < bin.length; i++) o[i] = bin.charCodeAt(i); return o;
                }
                const b = enc.encode(v); const o = new Buf(b.length); o.set(b); return o;
            }
            const o = new Buf(v.length); o.set(v); return o;
        }
        static alloc(n) { return new Buf(n); }
        static concat(list) { const n = list.reduce((s, x) => s + x.length, 0); const o = new Buf(n); let p = 0; for (const x of list) { o.set(x, p); p += x.length; } return o; }
        static isBuffer(x) { return x instanceof Buf; }
        readUInt32BE(off) { return ((this[off] << 24) >>> 0) + (this[off + 1] << 16) + (this[off + 2] << 8) + this[off + 3]; }
        subarray(a, b) { const s = super.subarray(a, b); return new Buf(s.buffer, s.byteOffset, s.length); }
        toString(encoding) {
            if (encoding === 'hex') return [...this].map((x) => x.toString(16).padStart(2, '0')).join('');
            if (encoding === 'base64url' || encoding === 'base64') {
                let s = ''; for (let i = 0; i < this.length; i++) s += String.fromCharCode(this[i]);
                const b = btoa(s); return encoding === 'base64' ? b : b.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
            }
            return new TextDecoder().decode(this);
        }
    }
    const bytesOf = (x) => (typeof x === 'string' ? enc.encode(x) : x);

    // ---------------------------------------------------------------- crypto
    const pending = [];   // 다시 돌리는 동안 모은 서명 확인 { jwk, data, sig }
    const nodeCrypto = {
        createHash(alg) {
            if (alg !== 'sha256') throw new Error('only sha256');
            const parts = [];
            const h = { update(x) { parts.push(bytesOf(x)); return h; }, digest(e) { const d = Buf.from(sha256(Buf.concat(parts))); return e ? d.toString(e) : d; } };
            return h;
        },
        createHmac(alg, key) {
            if (alg !== 'sha256') throw new Error('only sha256');
            const parts = [];
            const h = { update(x) { parts.push(bytesOf(x)); return h; }, digest(e) { const d = Buf.from(hmac(bytesOf(key), Buf.concat(parts))); return e ? d.toString(e) : d; } };
            return h;
        },
        createPublicKey(o) {
            const j = o && o.key;
            return { type: 'public', jwk: { kty: j.kty, crv: j.crv, x: j.x, y: j.y }, export() { return this.jwk; } };
        },
        verify(_alg, data, key, sig) {
            pending.push({ jwk: key.key.jwk, data: Buf.from(data), sig: Buf.from(sig) });
            return true;
        },
        randomBytes(n) { const o = new Buf(n); crypto.getRandomValues(o); return o; },
    };

    // ---------------------------------------------------------------- 모듈
    const defs = new Map(), cache = new Map();
    window.__engineModule = (name, fn) => defs.set(name, fn);
    function req(name) {
        if (name === 'crypto') return nodeCrypto;
        const file = name.replace(/^\.\//, '') + (name.endsWith('.js') ? '' : '.js');
        if (cache.has(file)) return cache.get(file).exports;
        const fn = defs.get(file);
        if (!fn) throw new Error('engine file not loaded: ' + file);
        const module = { exports: {} };
        cache.set(file, module);
        fn(req, module, module.exports, Buf);
        return module.exports;
    }

    /** 엔진 verify.js 로 기록을 다시 돌리고, 모아 둔 서명을 WebCrypto 로 확인한다 */
    async function verifyWithEngine(record, sig, engineSigJwk) {
        pending.length = 0;
        const out = req('verify.js').verifyRecord(record, sig, engineSigJwk);
        const checks = pending.splice(0);
        let bad = 0;
        for (const c of checks) {
            try {
                const k = await crypto.subtle.importKey('jwk', { ...c.jwk, ext: true }, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
                if (!(await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, k, c.sig, c.data))) bad += 1;
            } catch (_e) { bad += 1; }
        }
        const errors = [...out.errors];
        if (bad) errors.push(`${bad} of ${checks.length} signatures are bad`);
        return { ok: errors.length === 0, errors, signatures: checks.length };
    }

    window.BuyinEngine = { require: req, verifyWithEngine, sha256hex: (s) => Buf.from(sha256(bytesOf(s))).toString('hex') };
})();
