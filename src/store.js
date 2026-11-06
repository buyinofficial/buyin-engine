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
 *           "player-bind" 회원 ID ↔ 회원 브라우저 서명 키 고정(처음 · 콘솔 서명 '새 기기' 좌석표로 바꿈) — 공개(/table/binding)
 *           "hand"        { record, sig } — 엔진이 서명한 판 기록 (판이 끝난 뒤에만)
 *
 * 중간 줄을 지우거나 바꾸면 그 뒤 hash 가 모두 어긋난다(verifyChain). 지금 사슬 끝(head)은 /records/head 로 공개한다.
 * 쓰기는 이 파일만 한다(RULES.md 2장 예외): 정해진 폴더에, 덧붙이기만, 매번 fsync.
 */

const fs = require('fs');
const path = require('path');
const C = require('./crypto');

const GENESIS = '0'.repeat(64);

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

class RecordStore {
    /** @param {string} dir 보관 폴더 (TEE 데이터 디스크) */
    constructor(dir) {
        this.dir = dir;
        fs.mkdirSync(dir, { recursive: true });
        this.count = 0;
        this.head = GENESIS;
        this.byHand = new Map();   // handId → { file, i }
        this.byKey = new Map();    // 회원 서명 키 지문 → [handId] (오래된 것부터)
        this._load();
    }

    files() {
        return fs.readdirSync(this.dir).filter((f) => /^records-\d{4}-\d{2}-\d{2}\.jsonl$/.test(f)).sort();
    }

    /** 뜰 때 사슬을 처음부터 읽어 끝(head)과 판 번호 색인을 되살린다. 어긋나면 뜨지 않는다 */
    _load() {
        for (const f of this.files()) {
            for (const entry of readLines(path.join(this.dir, f))) {
                if (entry.i !== this.count || entry.prev !== this.head || entry.hash !== lineHash(entry.prev, bodyOf(entry))) {
                    throw new Error(`record chain broken at ${f} #${entry.i}`);
                }
                this.count += 1;
                this.head = entry.hash;
                if (entry.kind === 'hand' && entry.record) this._index(entry.record, f, entry.i);
            }
        }
    }

    _append(body) {
        const entry = { i: this.count, prev: this.head, hash: lineHash(this.head, body), ...body };
        const file = `records-${dayOf(Date.now())}.jsonl`;
        const fd = fs.openSync(path.join(this.dir, file), 'a');
        try {
            fs.writeSync(fd, JSON.stringify(entry) + '\n');
            fs.fsyncSync(fd);
        } finally {
            fs.closeSync(fd);
        }
        this.count += 1;
        this.head = entry.hash;
        return { entry, file };
    }

    /** 엔진이 뜰 때 — 공개키와 증명서 report_data 를 사슬에 남긴다 */
    appendEngineKey(info) {
        const a = info.attestation || null;
        return this._append({
            kind: 'engine-key', at: Date.now(),
            engine: { name: info.name, version: info.version, mode: info.mode },
            keys: { sig: info.keys.sig, ecdh: info.keys.ecdh, sigFp: info.keys.sigFp, ecdhFp: info.keys.ecdhFp },
            attestation: a ? { type: a.type, reportData: a.reportData, appId: a.appId || null, composeHash: a.composeHash || null } : null,
        }).entry;
    }

    /** 판이 끝났을 때 — 엔진이 서명한 기록. 실패하면 던진다(그 판은 무효가 된다) */
    appendHand(record, sig) {
        const { entry, file } = this._append({ kind: 'hand', at: Date.now(), record, sig });
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
        if (!['seat-in', 'settle', 'player-bind'].includes(kind)) throw new Error('unknown event kind');
        return this._append({ kind, at: Date.now(), ...body }).entry;
    }

    headInfo() {
        return { count: this.count, head: this.head, hands: this.byHand.size };
    }

    getHand(handId) {
        const at = this.byHand.get(String(handId));
        if (!at) return null;
        for (const entry of readLines(path.join(this.dir, at.file))) if (entry.i === at.i) return entry;
        return null;
    }

    /** 엔진 키 줄 전부 — 옛 기록을 옛 키로 검증할 때 */
    engineKeys() {
        const out = [];
        for (const f of this.files()) for (const e of readLines(path.join(this.dir, f))) if (e.kind === 'engine-key') out.push(e);
        return out;
    }

    /** i 번째 줄부터 limit 줄 (내보내기·백업) */
    range(from, limit) {
        const out = [];
        for (const f of this.files()) {
            for (const e of readLines(path.join(this.dir, f))) {
                if (e.i < from) continue;
                out.push(e);
                if (out.length >= limit) return out;
            }
        }
        return out;
    }
}

function readLines(file) {
    const text = fs.readFileSync(file, 'utf8');
    return text.split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

/**
 * 밖에서 받은 줄 목록(처음부터, 또는 앞 줄의 hash 를 아는 중간부터)이 사슬로 맞는지 본다.
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
