/**
 * 판 기록 보관소 — 엔진이 서명한 판 기록을 TEE 디스크에 남긴다.
 *
 * TEE(dstack) 의 데이터 디스크는 TEE 안에서만 풀리는 키로 암호화된다. 운영자는 디스크를 읽거나 고칠 수 없다.
 * 그래도 "기록을 빼거나 바꾸지 않았다"를 밖에서 확인할 수 있게 기록을 사슬로 잇는다.
 *
 *   한 줄 = { i, prev, hash, kind, ... }            하루 파일 records-YYYY-MM-DD.jsonl 에 덧붙인다(append only)
 *   hash  = SHA-256( prev + "\n" + stableStringify(본문) )   본문 = 줄에서 i·prev·hash 를 뺀 나머지
 *   영수증(공개): 판 번호 → 사슬 위치·줄 해시·기록 해시. 카드는 없다 — 콘솔이 준 사본이 TEE 원본과 같은지 누구나 맞춰 본다
 *   내 판(회원 키로): 판 기록의 좌석 키 지문으로 색인 — 그 키로 서명한 회원만 자기 판 기록을 받는다
 *   kind  = "engine-key"  엔진이 뜰 때 공개키·증명서 report_data — 옛 기록을 옛 키로 검증할 수 있게
 *           "seat-in"     좌석표로 앉음(좌석표 번호·세션·바이인) — 같은 좌석표 재사용 금지, 재시작 정산
 *           "settle"      정산서(엔진 서명) — 금액만
 *           "hand"        { record, sig } — 엔진이 서명한 판 기록 (판이 끝난 뒤에만)
 *           "prune"       오래된 하루 파일을 지웠다 — 지운 범위(upTo), 그 끝 줄의 해시(lastHash), 파일 이름, 판 수
 *
 * 중간 줄을 지우거나 바꾸면 그 뒤 hash 가 모두 어긋난다(verifyChain). 지금 사슬 끝(head)은 /records/head 로 공개한다.
 * 쓰기는 이 파일만 한다(RULES.md 2장 예외): 정해진 폴더에, 덧붙이기만, 매번 fsync.
 *
 * 보관 기간(prune) — 디스크가 끝없이 차지 않게. 하루 파일은 아래가 모두 맞을 때만 지운다.
 *   1. 보관 기간(기본 90일)이 지난 날의 파일이다(오늘 파일은 지우지 않는다)
 *   2. 콘솔이 이미 가져갔다 — 콘솔은 저장한 다음 줄부터 /records?from=N 으로 읽는다. 그래서 N 앞은 콘솔에 있다(ack.json)
 *   3. 정산이 안 끝난 좌석(seat-in 뒤 settle 없음)의 줄이 없다 — 재시작 정산에 필요하다
 *   지울 때는 "prune" 줄을 먼저 사슬에 남기고, 남은 사슬이 이어지는 기준점(checkpoint.json: 다음 번호·앞 줄 해시·지운 파일의 엔진 키)을 쓴 뒤 지운다.
 *   지운 줄은 콘솔 DB 에 엔진 서명째로 남아 있어 언제든 다시 검증된다.
 */

const fs = require('fs');
const path = require('path');
const C = require('./crypto');

const GENESIS = '0'.repeat(64);
const DAY_MS = 24 * 60 * 60 * 1000;
const FILE_RE = /^records-(\d{4}-\d{2}-\d{2})\.jsonl$/;

function lineHash(prev, body) {
    return C.sha256hex(prev + '\n' + C.stableStringify(body));
}

function bodyOf(entry) {
    const { i: _i, prev: _p, hash: _h, ...body } = entry;
    return body;
}

function dayOf(ms) {
    return new Date(ms).toISOString().slice(0, 10);
}

/** 작은 상태 파일 — 임시 파일에 쓰고 바꿔 끼운다(중간에 꺼져도 반쪽 파일이 남지 않는다) */
function writeJsonAtomic(file, obj) {
    const tmp = file + '.tmp';
    const fd = fs.openSync(tmp, 'w');
    try {
        fs.writeSync(fd, JSON.stringify(obj));
        fs.fsyncSync(fd);
    } finally {
        fs.closeSync(fd);
    }
    fs.renameSync(tmp, file);
}

function readJson(file) {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_e) { return null; }
}

class RecordStore {
    /**
     * @param {string} dir 보관 폴더 (TEE 데이터 디스크)
     * @param {{ now?: () => number }} [opts]  시계(시험용)
     */
    constructor(dir, opts = {}) {
        this.dir = dir;
        this.now = opts.now || (() => Date.now());
        fs.mkdirSync(dir, { recursive: true });
        this.count = 0;
        this.head = GENESIS;
        this.base = { i: 0, prev: GENESIS };   // 남은 사슬의 시작 — 지운 적이 없으면 처음부터
        this.prunedKeys = [];                  // 지운 파일에 있던 엔진 키 줄(옛 기록 검증용으로 계속 공개)
        this.acked = 0;                        // 콘솔이 가져간 위치 — 이 번호 앞의 줄은 콘솔에 있다
        this.fileStart = new Map();            // 파일 → 첫 줄 번호 (읽기를 빠르게)
        this.byHand = new Map();   // handId → { file, i }
        this.byKey = new Map();    // 회원 서명 키 지문 → [handId] (오래된 것부터)
        this._load();
    }

    files() {
        return fs.readdirSync(this.dir).filter((f) => FILE_RE.test(f)).sort();
    }

    /** 뜰 때 사슬을 기준점부터 읽어 끝(head)과 판 번호 색인을 되살린다. 어긋나면 뜨지 않는다 */
    _load() {
        const cp = readJson(path.join(this.dir, 'checkpoint.json'));
        if (cp) {
            this.base = { i: cp.next, prev: cp.prev };
            this.prunedKeys = cp.keys || [];
            this.count = cp.next;
            this.head = cp.prev;
        }
        const ack = readJson(path.join(this.dir, 'ack.json'));
        if (ack) this.acked = Number(ack.acked) || 0;
        for (const f of this.files()) {
            const lines = readLines(path.join(this.dir, f));
            // 기준점 앞의 줄만 든 파일 — 지우다 꺼진 것. 마저 지운다
            if (lines.length && lines[lines.length - 1].i < this.base.i) { fs.unlinkSync(path.join(this.dir, f)); continue; }
            for (const entry of lines) {
                if (entry.i < this.base.i) continue;
                if (entry.i !== this.count || entry.prev !== this.head || entry.hash !== lineHash(entry.prev, bodyOf(entry))) {
                    throw new Error(`record chain broken at ${f} #${entry.i}`);
                }
                if (!this.fileStart.has(f)) this.fileStart.set(f, entry.i);
                this.count += 1;
                this.head = entry.hash;
                if (entry.kind === 'hand' && entry.record) this._index(entry.record, f, entry.i);
            }
        }
        if (this.acked > this.count) this.acked = this.count;
    }

    _append(body) {
        const entry = { i: this.count, prev: this.head, hash: lineHash(this.head, body), ...body };
        const file = `records-${dayOf(this.now())}.jsonl`;
        const fd = fs.openSync(path.join(this.dir, file), 'a');
        try {
            fs.writeSync(fd, JSON.stringify(entry) + '\n');
            fs.fsyncSync(fd);
        } finally {
            fs.closeSync(fd);
        }
        if (!this.fileStart.has(file)) this.fileStart.set(file, entry.i);
        this.count += 1;
        this.head = entry.hash;
        return { entry, file };
    }

    /** 엔진이 뜰 때 — 공개키와 증명서 report_data 를 사슬에 남긴다 */
    appendEngineKey(info) {
        const a = info.attestation || null;
        return this._append({
            kind: 'engine-key', at: this.now(),
            engine: { name: info.name, version: info.version, mode: info.mode },
            keys: { sig: info.keys.sig, ecdh: info.keys.ecdh, sigFp: info.keys.sigFp, ecdhFp: info.keys.ecdhFp },
            attestation: a ? { type: a.type, reportData: a.reportData, appId: a.appId || null, composeHash: a.composeHash || null } : null,
        }).entry;
    }

    /** 판이 끝났을 때 — 엔진이 서명한 기록. 실패하면 던진다(그 판은 무효가 된다) */
    appendHand(record, sig) {
        const { entry, file } = this._append({ kind: 'hand', at: this.now(), record, sig });
        this._index(record, file, entry.i);
        return entry;
    }

    _index(record, file, i) {
        const id = String(record.handId);
        this.byHand.set(id, { file, i });
        for (const s of record.seats || []) {
            if (!s.keys || !s.keys.sig) continue;
            const fp = C.fingerprint(s.keys.sig);
            if (!this.byKey.has(fp)) this.byKey.set(fp, []);
            this.byKey.get(fp).push(id);
        }
    }

    /** 이 키로 앉았던 판 — 최근 것부터 */
    handsOfKey(sigFp, limit = 50) {
        return (this.byKey.get(String(sigFp)) || []).slice(-limit).reverse();
    }

    /** 공개 영수증 — 카드 없이 사슬 위치와 해시만 */
    receipt(handId) {
        const e = this.getHand(handId);
        if (!e) return null;
        return { i: e.i, prev: e.prev, hash: e.hash, at: e.at, handId: String(e.record.handId), tableId: e.record.tableId,
            endedAt: e.record.endedAt, recordHash: C.sha256hex(C.stableStringify(e.record)), engineSigFp: e.record.engine && e.record.engine.sigFp };
    }

    /** 테이블 서버 사건 — 'seat-in'(좌석표로 앉음), 'settle'(정산서). 판 기록과 같은 사슬에 남아 재시작 뒤에도 돈이 정산된다 */
    appendEvent(kind, body) {
        if (!['seat-in', 'settle'].includes(kind)) throw new Error('unknown event kind');
        return this._append({ kind, at: this.now(), ...body }).entry;
    }

    headInfo() {
        return { count: this.count, head: this.head, hands: this.byHand.size, base: this.base.i };
    }

    getHand(handId) {
        const at = this.byHand.get(String(handId));
        if (!at) return null;
        for (const entry of readLines(path.join(this.dir, at.file))) if (entry.i === at.i) return entry;
        return null;
    }

    /** 엔진 키 줄 전부 — 옛 기록을 옛 키로 검증할 때(지운 파일에 있던 키도 포함) */
    engineKeys() {
        const out = this.prunedKeys.slice();
        for (const f of this.files()) for (const e of readLines(path.join(this.dir, f))) if (e.kind === 'engine-key' && e.i >= this.base.i) out.push(e);
        return out;
    }

    /** i 번째 줄부터 limit 줄 (내보내기·백업) — from 보다 앞에서 끝나는 파일은 읽지 않는다 */
    range(from, limit) {
        const out = [];
        const files = this.files();
        for (let k = 0; k < files.length; k++) {
            const next = this.fileStart.get(files[k + 1]);
            if (next !== undefined && next <= from) continue;
            for (const e of readLines(path.join(this.dir, files[k]))) {
                if (e.i < from || e.i < this.base.i) continue;
                out.push(e);
                if (out.length >= limit) return out;
            }
        }
        return out;
    }

    /**
     * 콘솔이 가져간 위치 — 콘솔은 저장을 마친 다음 줄부터 읽는다(/records?from=N). 그래서 N 앞은 콘솔에 있다.
     * 늘어날 때만 기록한다. 사슬 끝보다 앞설 수 없다.
     */
    ack(n) {
        const v = Math.min(Math.floor(Number(n) || 0), this.count);
        if (v <= this.acked) return this.acked;
        this.acked = v;
        writeJsonAtomic(path.join(this.dir, 'ack.json'), { acked: v, at: this.now() });
        return v;
    }

    /** 공개 용량 — 기록 크기·파일 수·가장 오래된 날·콘솔이 가져간 위치·디스크 남은 공간 */
    storage() {
        let bytes = 0;
        const files = this.files();
        for (const f of files) { try { bytes += fs.statSync(path.join(this.dir, f)).size; } catch (_e) { /* 막 지워짐 */ } }
        let disk = null;
        try {
            const s = fs.statfsSync(this.dir);
            disk = { totalBytes: s.blocks * s.bsize, freeBytes: s.bavail * s.bsize };
        } catch (_e) { /* statfs 없는 환경 */ }
        const m = files.length ? files[0].match(FILE_RE) : null;
        return { bytes, files: files.length, oldestDay: m ? m[1] : null, firstIndex: this.base.i, acked: this.acked, disk };
    }

    /**
     * 보관 기간이 지난 하루 파일을 지운다(위 머리말의 조건 세 가지). 오래된 파일부터 이어서만 지운다.
     * @param {number} days 보관 일수
     * @returns {null | { upTo, files, hands }} 지운 것
     */
    prune(days) {
        const now = this.now();
        const cutoff = dayOf(now - days * DAY_MS);   // 이 날보다 앞선 날의 파일만
        const today = `records-${dayOf(now)}.jsonl`;

        // 정산이 안 끝난 좌석의 첫 줄 — 그 줄부터는 남긴다
        const open = new Map();   // sessionId → seat-in 줄 번호
        for (const e of this.range(this.base.i, Number.MAX_SAFE_INTEGER)) {
            if (e.kind === 'seat-in') open.set(e.sessionId, e.i);
            else if (e.kind === 'settle' && e.note) open.delete(e.note.sessionId);
        }
        let safe = this.acked;
        for (const i of open.values()) safe = Math.min(safe, i);

        const victims = [];
        let last = null, hands = 0;
        const keys = [];
        for (const f of this.files()) {
            const day = f.match(FILE_RE)[1];
            if (f === today || day >= cutoff) break;
            const lines = readLines(path.join(this.dir, f)).filter((e) => e.i >= this.base.i);
            if (!lines.length) { victims.push(f); continue; }
            if (lines[lines.length - 1].i >= safe) break;
            victims.push(f);
            last = lines[lines.length - 1];
            for (const e of lines) {
                if (e.kind === 'hand') hands += 1;
                if (e.kind === 'engine-key') keys.push(e);
            }
        }
        if (!last) return null;

        const upTo = last.i + 1;
        // 1) 사슬에 남긴다  2) 기준점을 쓴다  3) 지운다 — 어디서 꺼져도 다시 뜰 때 이어진다(_load)
        this._append({ kind: 'prune', at: now, upTo, lastHash: last.hash, files: victims, hands, retentionDays: days });
        const cp = { next: upTo, prev: last.hash, keys: this.prunedKeys.concat(keys), at: now };
        writeJsonAtomic(path.join(this.dir, 'checkpoint.json'), cp);
        this.base = { i: cp.next, prev: cp.prev };
        this.prunedKeys = cp.keys;
        for (const f of victims) {
            fs.unlinkSync(path.join(this.dir, f));
            this.fileStart.delete(f);
        }
        const gone = new Set(victims);
        for (const [id, at] of this.byHand) if (gone.has(at.file)) this.byHand.delete(id);
        for (const [fp, ids] of this.byKey) {
            const left = ids.filter((id) => this.byHand.has(id));
            if (left.length) this.byKey.set(fp, left); else this.byKey.delete(fp);
        }
        return { upTo, files: victims, hands };
    }
}

function readLines(file) {
    const text = fs.readFileSync(file, 'utf8');
    return text.split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

/**
 * 밖에서 받은 줄 목록(처음부터, 또는 앞 줄의 hash 를 아는 중간부터)이 사슬로 맞는지 본다.
 * 정리한 뒤에는 남은 사슬이 checkpoint 의 앞 줄 해시(= prune 줄의 lastHash)에서 이어진다.
 * @returns {string[]} 문제 목록 (비어 있으면 통과)
 */
function verifyChain(entries, startPrev = GENESIS, startIndex = 0) {
    const errors = [];
    let prev = startPrev, i = startIndex;
    for (const e of entries) {
        if (e.i !== i) errors.push(`#${e.i}: expected index ${i}`);
        if (e.prev !== prev) errors.push(`#${e.i}: prev hash does not match`);
        if (e.hash !== lineHash(e.prev, bodyOf(e))) errors.push(`#${e.i}: hash does not match its content`);
        prev = e.hash; i = e.i + 1;
    }
    return errors;
}

module.exports = { RecordStore, verifyChain, lineHash, GENESIS };
