/**
 * 판 기록 보관소 — 엔진이 서명한 판 기록을 TEE 디스크의 SQLite 파일(buyin.db) 하나에 남긴다.
 *
 * TEE(dstack) 의 데이터 디스크는 TEE 안에서만 풀리는 키로 암호화된다. 운영자는 디스크를 읽거나 고칠 수 없다.
 * SQLite 는 Node 에 들어 있는 node:sqlite 를 쓴다(외부 라이브러리 없음). SQLite 에는 계정·비밀번호가 없다 — 이 파일은
 * TEE 안의 이 프로그램만 연다. 숨길 설정값이 없으므로 스키마·SQL 은 모두 이 파일에 공개돼 있다.
 *
 * 그래도 "기록을 빼거나 바꾸지 않았다"를 밖에서 확인할 수 있게 기록을 사슬로 잇는다.
 *
 *   한 줄 = { i, prev, hash, kind, ... }
 *   hash  = SHA-256( prev + "\n" + stableStringify(본문) )   본문 = 줄에서 i·prev·hash 를 뺀 나머지
 *   영수증(공개): 판 번호 → 사슬 위치·줄 해시·기록 해시. 카드는 없다 — 콘솔이 준 사본이 TEE 원본과 같은지 누구나 맞춰 본다
 *   내 판(회원 키로): 판 기록의 좌석 키 지문으로 색인 — 그 키로 서명한 회원만 자기 판 기록을 받는다
 *   kind  = "engine-key"  엔진이 뜰 때 공개키·증명서 report_data — 옛 기록을 옛 키로 검증할 수 있게
 *           "seat-in"     좌석표로 앉음(좌석표 번호·세션·바이인) — 같은 좌석표 재사용 금지, 재시작 정산
 *           "settle"      정산서(엔진 서명) — 금액만
 *           "hand"        { record, sig } — 엔진이 서명한 판 기록 (판이 끝난 뒤에만)
 *
 * 덧붙이기만 한다: 줄을 고치는 UPDATE 는 트리거가 막는다. 지우기는 보관 기간 정리(prune)뿐이고, 콘솔로 아직 안 보낸 줄은
 * 트리거가 지우지 못하게 막는다. 뜰 때 사슬 전체를 다시 계산해 어긋나면 뜨지 않는다. 지금 사슬 끝(head)은 /records/head 로 공개한다.
 * 줄은 쓰자마자 콘솔로 보낸다(outbox.js). 진행 중인 판은 여기 없다 — 판이 끝나야 들어온다(Engine._closeHand → onRecord).
 * 쓰기는 이 파일만 한다(RULES.md 2장 예외): 정해진 폴더의 이 DB 파일에만.
 */

const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const C = require('./crypto');

const GENESIS = '0'.repeat(64);
const DB_FILE = 'buyin.db';

/** 스키마 — 게임 기록 보관용. 계정·비밀번호 없음 */
const SCHEMA = `
CREATE TABLE IF NOT EXISTS chain (
    i       INTEGER PRIMARY KEY,   -- 줄 번호(0 부터, 빈틈 없이)
    prev    TEXT    NOT NULL,      -- 앞 줄의 hash
    hash    TEXT    NOT NULL,      -- 이 줄의 hash
    kind    TEXT    NOT NULL,      -- engine-key | seat-in | settle | hand | tip
    at      INTEGER NOT NULL,      -- 쓴 시각(ms)
    hand_id TEXT,                  -- kind = hand 일 때 판 번호
    line    TEXT    NOT NULL       -- 줄 전체(JSON). hash 는 이 줄의 본문으로 계산된다
);
CREATE UNIQUE INDEX IF NOT EXISTS chain_hand ON chain(hand_id) WHERE hand_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS chain_kind ON chain(kind, i);
CREATE INDEX IF NOT EXISTS chain_at ON chain(at);
-- 내 판 기록: 좌석 서명 키 지문 → 판
CREATE TABLE IF NOT EXISTS seat_keys (
    sig_fp  TEXT    NOT NULL,
    i       INTEGER NOT NULL,
    hand_id TEXT    NOT NULL,
    PRIMARY KEY (sig_fp, i)
);
-- 콘솔로 보낸 위치(sent)
CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL);
-- 덧붙이기만: 줄은 고칠 수 없다
CREATE TRIGGER IF NOT EXISTS chain_no_update BEFORE UPDATE ON chain
BEGIN SELECT RAISE(ABORT, 'record chain is append-only'); END;
-- 콘솔로 아직 안 보낸 줄은 지울 수 없다
CREATE TRIGGER IF NOT EXISTS chain_keep_unsent BEFORE DELETE ON chain
WHEN OLD.i >= COALESCE((SELECT CAST(v AS INTEGER) FROM meta WHERE k = 'sent'), 0)
BEGIN SELECT RAISE(ABORT, 'records not yet sent to the console cannot be deleted'); END;
`;

function lineHash(prev, body) {
    return C.sha256hex(prev + '\n' + C.stableStringify(body));
}

function bodyOf(entry) {
    const { i: _i, prev: _p, hash: _h, ...body } = entry;
    return body;
}

/** 사슬 한 줄(끝난 판)의 결과 — 좌석·시작/끝 스택·레이크·기록 해시. 카드·덱·시드 없음 */
function resultOf(e) {
    const r = e.record;
    const rake = (r.result && r.result.rake && r.result.rake.perSeat) || [];
    return {
        i: e.i, handId: String(r.handId), tableId: r.tableId, endedAt: r.endedAt,
        type: r.result && r.result.type,
        seats: (r.seats || []).map((s) => ({
            seat: s.seat, odcId: String(s.odcId),
            start: r.stacksStart[s.seat], end: r.stacksEnd[s.seat],
            rake: (rake.find((f) => f.seat === s.seat) || {}).fee || 0,
        })),
        recordHash: C.sha256hex(C.stableStringify(r)),
        engineSigFp: r.engine && r.engine.sigFp,
    };
}

class RecordStore {
    /** @param {string} dir 보관 폴더 (TEE 데이터 디스크) */
    constructor(dir) {
        this.dir = dir;
        fs.mkdirSync(dir, { recursive: true });
        this.file = path.join(dir, DB_FILE);
        this.db = new DatabaseSync(this.file);
        this.db.exec('PRAGMA auto_vacuum = INCREMENTAL; PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL;');
        this.db.exec(SCHEMA);
        const q = (sql) => this.db.prepare(sql);
        this.sql = {
            insert: q('INSERT INTO chain (i, prev, hash, kind, at, hand_id, line) VALUES (?, ?, ?, ?, ?, ?, ?)'),
            seatKey: q('INSERT OR IGNORE INTO seat_keys (sig_fp, i, hand_id) VALUES (?, ?, ?)'),
            range: q('SELECT line FROM chain WHERE i >= ? ORDER BY i LIMIT ?'),
            hands: q("SELECT i, line FROM chain WHERE kind = 'hand' AND i >= ? ORDER BY i LIMIT ?"),
            hand: q('SELECT line FROM chain WHERE hand_id = ?'),
            // [TABLE_RECORD_2026_11_10] 판 번호는 '<tableId>.<판 번호>' — '.' 다음 글자 '/' 앞까지가 그 테이블의 판이다
            ofTable: q("SELECT i, line FROM chain WHERE kind = 'hand' AND hand_id >= ? AND hand_id < ? ORDER BY i LIMIT ?"),
            keys: q("SELECT line FROM chain WHERE kind = 'engine-key' ORDER BY i"),
            ofKey: q('SELECT hand_id FROM seat_keys WHERE sig_fp = ? ORDER BY i DESC LIMIT ?'),
            handCount: q("SELECT COUNT(*) AS n FROM chain WHERE kind = 'hand'"),
            setMeta: q('INSERT INTO meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v'),
            getMeta: q('SELECT v FROM meta WHERE k = ?'),
            oldest: q('SELECT MIN(at) AS at FROM chain'),
        };
        this.count = 0;
        this.head = GENESIS;
        this.first = 0;            // 남아 있는 첫 줄 번호(정리한 줄이 있으면 0 보다 크다)
        this.sent = 0;             // 콘솔로 보낸 위치 — 이 번호 앞은 콘솔에 있다
        this.onAppend = null;      // 새 줄을 쓴 뒤 부른다(콘솔로 보내기)
        this.hands = 0;            // 남아 있는 판 수(공개 /records/head — 요청마다 세지 않는다)
        this._importFiles();
        this._load();
    }

    /** 뜰 때 사슬을 처음부터 다시 계산해 끝(head)을 되살린다. 어긋나면 뜨지 않는다 */
    _load() {
        const s = this.sql.getMeta.get('sent');
        this.sent = s ? Number(s.v) || 0 : 0;
        let started = false;
        for (const row of this.db.prepare('SELECT i, prev, hash, line FROM chain ORDER BY i').iterate()) {
            const entry = JSON.parse(row.line);
            if (!started) { started = true; this.first = this.count = entry.i; this.head = entry.prev; }   // 오래된 줄을 정리했으면 거기서 시작
            if (row.i !== this.count || entry.i !== row.i || entry.prev !== this.head || row.prev !== entry.prev
                || entry.hash !== row.hash || entry.hash !== lineHash(entry.prev, bodyOf(entry))) {
                throw new Error(`record chain broken at #${row.i}`);
            }
            this.count += 1;
            this.head = entry.hash;
        }
        this.hands = this.sql.handCount.get().n;
    }

    /** 0.8 까지의 하루 파일(records-YYYY-MM-DD.jsonl)이 있으면 한 번 옮기고 지운다 — 사슬은 그대로 이어진다 */
    _importFiles() {
        const files = fs.readdirSync(this.dir).filter((f) => /^records-\d{4}-\d{2}-\d{2}\.jsonl$/.test(f)).sort();
        if (!files.length) return;
        if (this.db.prepare('SELECT COUNT(*) AS n FROM chain').get().n === 0) {
            this.db.exec('BEGIN');
            try {
                let n = null, head = null;
                for (const f of files) {
                    for (const l of fs.readFileSync(path.join(this.dir, f), 'utf8').split('\n')) {
                        if (!l) continue;
                        const e = JSON.parse(l);
                        if (n === null) { n = e.i; head = e.prev; }
                        if (e.i !== n || e.prev !== head || e.hash !== lineHash(e.prev, bodyOf(e))) throw new Error(`record chain broken at ${f} #${e.i}`);
                        this._insert(e);
                        n += 1; head = e.hash;
                    }
                }
                try { this.sql.setMeta.run('sent', String(Number(JSON.parse(fs.readFileSync(path.join(this.dir, 'sent.json'), 'utf8')).sent) || 0)); } catch (_e) { /* 없음 */ }
                this.db.exec('COMMIT');
            } catch (e) {
                this.db.exec('ROLLBACK');
                throw e;
            }
        }
        for (const f of files) fs.unlinkSync(path.join(this.dir, f));
        try { fs.unlinkSync(path.join(this.dir, 'sent.json')); } catch (_e) { /* 없음 */ }
    }

    _insert(entry) {
        const handId = entry.kind === 'hand' && entry.record ? String(entry.record.handId) : null;
        this.sql.insert.run(entry.i, entry.prev, entry.hash, entry.kind, Number(entry.at) || 0, handId, JSON.stringify(entry));
        if (handId) {
            for (const s of entry.record.seats || []) {
                if (s.keys && s.keys.sig) this.sql.seatKey.run(C.fingerprint(s.keys.sig), entry.i, handId);
            }
        }
    }

    _append(body) {
        const entry = { i: this.count, prev: this.head, hash: lineHash(this.head, body), ...body };
        this.db.exec('BEGIN');
        try {
            this._insert(entry);
            this.db.exec('COMMIT');   // synchronous = FULL — 디스크에 닿은 뒤에 돌아온다
        } catch (e) {
            this.db.exec('ROLLBACK');
            throw e;
        }
        this.count += 1;
        this.head = entry.hash;
        if (entry.kind === 'hand') this.hands += 1;
        if (this.onAppend) this.onAppend(entry);
        return entry;
    }

    /** 엔진이 뜰 때 — 공개키와 증명서 report_data 를 사슬에 남긴다 */
    appendEngineKey(info) {
        const a = info.attestation || null;
        return this._append({
            kind: 'engine-key', at: Date.now(),
            engine: { name: info.name, version: info.version, mode: info.mode },
            keys: { sig: info.keys.sig, ecdh: info.keys.ecdh, sigFp: info.keys.sigFp, ecdhFp: info.keys.ecdhFp },
            attestation: a ? { type: a.type, reportData: a.reportData, appId: a.appId || null, composeHash: a.composeHash || null } : null,
        });
    }

    /** 판이 끝났을 때 — 엔진이 서명한 기록. 실패하면 던진다(그 판은 무효가 된다) */
    appendHand(record, sig) {
        return this._append({ kind: 'hand', at: Date.now(), record, sig });
    }

    /** 테이블 서버 사건 — 'seat-in'(좌석표로 앉음), 'settle'(정산서), 'tip'(보낸 사람 서명이 붙은 팁, 판과 판 사이에 옮김).
     *  판 기록과 같은 사슬에 남아 재시작 뒤에도 돈이 정산된다 */
    appendEvent(kind, body) {
        if (!['seat-in', 'settle', 'tip'].includes(kind)) throw new Error('unknown event kind');
        return this._append({ kind, at: Date.now(), ...body });
    }

    /** 이 키로 앉았던 판 — 최근 것부터 */
    handsOfKey(sigFp, limit = 50) {
        return this.sql.ofKey.all(String(sigFp), limit).map((r) => r.hand_id);
    }

    /**
     * 끝난 판의 결과 — 콘솔이 받은 기록과 대조할 때. 카드·덱·시드는 넣지 않는다.
     * 사슬에는 끝난 판만 있다(Engine._closeHand → appendHand). 진행 중인 판은 여기서 읽을 수 없다.
     * @returns {{ entries: object[], next: number }} next = 다음에 조회할 줄 번호
     */
    results(from, limit) {
        const rows = this.sql.hands.all(Math.max(from, this.first), limit);
        const entries = rows.map((row) => resultOf(JSON.parse(row.line)));
        return { entries, next: rows.length === limit ? rows[rows.length - 1].i + 1 : this.count };
    }

    /**
     * [TABLE_RECORD_2026_11_10] 한 테이블의 끝난 판 결과 — 누구나 보는 공개 기록(GET /records/table/<id>).
     *   results() 와 같은 모양에서 회원 번호(odcId)를 뺀다 — 좌석 번호·칩·레이크·해시뿐, 카드·덱·시드·회원 번호 없음.
     */
    tableResults(tableId, limit = 1000) {
        const t = String(tableId);
        return this.sql.ofTable.all(t + '.', t + '/', limit).map((row) => {
            const r = resultOf(JSON.parse(row.line));
            return { ...r, handNo: Number(r.handId.slice(t.length + 1)) || null, seats: r.seats.map(({ odcId, ...s }) => s) };
        });
    }

    /** 공개 영수증 — 카드 없이 사슬 위치와 해시만 */
    receipt(handId) {
        const e = this.getHand(handId);
        if (!e) return null;
        return { i: e.i, prev: e.prev, hash: e.hash, at: e.at, handId: String(e.record.handId), tableId: e.record.tableId,
            endedAt: e.record.endedAt, recordHash: C.sha256hex(C.stableStringify(e.record)), engineSigFp: e.record.engine && e.record.engine.sigFp };
    }

    headInfo() {
        return { count: this.count, head: this.head, hands: this.hands, first: this.first, sent: this.sent };
    }

    /** 콘솔이 n 앞까지 받았다 */
    markSent(n) {
        const v = Math.min(Math.floor(Number(n) || 0), this.count);
        if (v <= this.sent) return;
        this.sent = v;
        this.sql.setMeta.run('sent', String(v));
    }

    /** 기록 크기와 디스크 남은 공간 (공개) */
    storage() {
        let bytes = 0;
        for (const f of [this.file, this.file + '-wal']) { try { bytes += fs.statSync(f).size; } catch (_e) { /* 없음 */ } }
        let freeBytes = null;
        try { const s = fs.statfsSync(this.dir); freeBytes = s.bavail * s.bsize; } catch (_e) { /* statfs 없음 */ }
        const o = this.sql.oldest.get();
        return { bytes, files: 1, oldestDay: o && o.at ? new Date(o.at).toISOString().slice(0, 10) : null, freeBytes };
    }

    /**
     * 보관 기간이 지났고 콘솔로 보낸 줄을 지운다(앞에서부터 이어서). 마지막 줄은 남긴다(사슬 끝을 잃지 않게).
     * @returns {{ rows: number }} 지운 줄 수
     */
    prune(days, now = Date.now()) {
        const cutoff = now - days * 24 * 60 * 60 * 1000;
        const young = this.db.prepare('SELECT MIN(i) AS i FROM chain WHERE at >= ?').get(cutoff).i;
        const upTo = Math.min(this.sent, this.count - 1, young === null ? this.count : young);
        if (upTo <= this.first) return { rows: 0 };
        this.db.exec('BEGIN');
        try {
            this.db.prepare('DELETE FROM seat_keys WHERE i < ?').run(upTo);
            this.db.prepare('DELETE FROM chain WHERE i < ?').run(upTo);
            this.db.exec('COMMIT');
        } catch (e) {
            this.db.exec('ROLLBACK');
            throw e;
        }
        const rows = upTo - this.first;
        this.first = upTo;
        this.hands = this.sql.handCount.get().n;
        this.db.exec('PRAGMA incremental_vacuum;');
        return { rows };
    }

    getHand(handId) {
        const row = this.sql.hand.get(String(handId));
        return row ? JSON.parse(row.line) : null;
    }

    /** 엔진 키 줄 전부 — 옛 기록을 옛 키로 검증할 때 */
    engineKeys() {
        return this.sql.keys.all().map((r) => JSON.parse(r.line));
    }

    /** i 번째 줄부터 limit 줄 */
    range(from, limit) {
        const n = Number.isFinite(limit) && limit < Number.MAX_SAFE_INTEGER ? limit : -1;
        return this.sql.range.all(Math.max(from, this.first), n).map((r) => JSON.parse(r.line));
    }

    close() { this.db.close(); }
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
