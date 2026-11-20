/**
 * [WS_0_10_10] 웹소켓(RFC 6455) — 테이블 화면과 TEE 사이의 연결 하나.
 *
 * 외부 패키지 없이 Node 기본 `crypto` 만 쓴다(RULES.md: dependencies 0). 필요한 만큼만 구현한다:
 *   - 글자(text) 메시지와 이어 붙인 조각(continuation), ping → pong, close. 이진(binary) 메시지는 받지 않는다.
 *   - 확장(permessage-deflate 등)·하위 프로토콜은 협상하지 않는다.
 *   - 브라우저가 보내는 프레임은 반드시 가려져(masked) 있어야 한다. 한 메시지는 MAX_MESSAGE 바이트까지.
 *
 * 이 파일은 통로일 뿐이다 — 누가 어느 좌석인지는 좌석 토큰(첫 메시지)으로 TableServer 가 정하고,
 * 액션은 회원 키 서명이 있어야 엔진이 받는다. 카드·덱은 이 통로와 무관하게 엔진 안에 있다.
 */

const crypto = require('crypto');

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const MAX_MESSAGE = 64 * 1024;          // 한 메시지 상한(POST /table/cmd 의 MAX_BODY 와 같다)
const MAX_BUFFERED_OUT = 1024 * 1024;   // 받는 쪽이 못 따라오면(보낼 것이 1MB 넘게 쌓이면) 끊는다

/**
 * 업그레이드 요청을 받아 웹소켓으로 바꾼다. 형식이 틀리면 400 으로 닫고 null.
 * @returns {WsConn|null}
 */
function acceptWebSocket(req, socket, head) {
    const key = String(req.headers['sec-websocket-key'] || '');
    const okReq = req.method === 'GET'
        && String(req.headers.upgrade || '').toLowerCase() === 'websocket'
        && /^[A-Za-z0-9+/]{22}==$/.test(key)
        && String(req.headers['sec-websocket-version'] || '') === '13';
    if (!okReq) {
        socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
        return null;
    }
    const accept = crypto.createHash('sha1').update(key + GUID).digest('base64');
    socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n'
        + `Sec-WebSocket-Accept: ${accept}\r\n\r\n`);
    socket.setNoDelay(true);   // 버튼 한 번이 곧바로 나가게(작은 메시지를 모아 보내지 않는다)
    socket.setKeepAlive(true, 10000);
    socket.setTimeout(0);
    return new WsConn(socket, head);
}

class WsConn {
    constructor(socket, head) {
        this.socket = socket;
        this.buf = head && head.length ? Buffer.from(head) : Buffer.alloc(0);
        this.frag = null;           // 조각 메시지 모으는 중: Buffer[]
        this.fragSize = 0;
        this.closed = false;        // 닫기 시작함(더 보내지 않는다)
        this.gone = false;          // onClose 를 불렀다
        this.closeFns = [];
        this.onMessage = null;      // (text) => void
        this.lastIn = Date.now();
        socket.on('data', (c) => this._data(c));
        socket.on('close', () => this._gone());
        socket.on('end', () => this._gone());
        socket.on('error', () => this._gone());
        if (this.buf.length) setImmediate(() => this._parse());
    }

    onClose(f) {
        if (this.gone) { setImmediate(f); return; }
        this.closeFns.push(f);
    }

    /** 글자 메시지 하나를 보낸다 */
    send(text) {
        if (this.closed) return false;
        if (this.socket.writableLength > MAX_BUFFERED_OUT) { this.close(1008, 'slow consumer'); return false; }
        this._frame(0x1, Buffer.from(String(text), 'utf8'));
        return true;
    }

    /** 닫기 프레임을 보내고 연결을 닫는다(2초 안에 안 닫히면 끊는다) */
    close(code = 1000, reason = '') {
        if (this.closed) return;
        this.closed = true;
        const r = Buffer.from(String(reason).slice(0, 100), 'utf8');
        const p = Buffer.alloc(2 + r.length);
        p.writeUInt16BE(code, 0); r.copy(p, 2);
        try { this._frame(0x8, p); this.socket.end(); } catch (_e) { /* 이미 끊김 */ }
        setTimeout(() => this.socket.destroy(), 2000).unref();
        this._gone();
    }

    _gone() {
        if (this.gone) return;
        this.gone = true;
        this.closed = true;
        const fns = this.closeFns; this.closeFns = [];
        for (const f of fns) { try { f(); } catch (_e) { /* */ } }
    }

    _frame(op, payload) {
        const n = payload.length;
        let h;
        if (n < 126) { h = Buffer.alloc(2); h[1] = n; }
        else if (n < 65536) { h = Buffer.alloc(4); h[1] = 126; h.writeUInt16BE(n, 2); }
        else { h = Buffer.alloc(10); h[1] = 127; h.writeUInt32BE(0, 2); h.writeUInt32BE(n, 6); }
        h[0] = 0x80 | op;   // 서버가 보내는 프레임은 가리지 않는다(RFC 6455 5.1)
        this.socket.write(Buffer.concat([h, payload]));
    }

    _data(chunk) {
        if (this.closed) return;
        this.lastIn = Date.now();
        this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
        if (this.buf.length > MAX_MESSAGE + 14) {
            // 아직 다 안 온 프레임이 상한을 넘는지는 머리에서 본다(_parse) — 여기서는 터무니없이 쌓이는 것만 막는다
            if (this.buf.length > 4 * MAX_MESSAGE) return this.close(1009, 'too big');
        }
        this._parse();
    }

    _parse() {
        while (!this.closed) {
            const b = this.buf;
            if (b.length < 2) return;
            const fin = (b[0] & 0x80) !== 0, op = b[0] & 0x0f;
            if (b[0] & 0x70) return this.close(1002, 'rsv');            // 확장을 협상하지 않았다
            if (!(b[1] & 0x80)) return this.close(1002, 'unmasked');    // 브라우저 프레임은 반드시 가려져 있다
            let len = b[1] & 0x7f, off = 2;
            if (len === 126) { if (b.length < 4) return; len = b.readUInt16BE(2); off = 4; }
            else if (len === 127) {
                if (b.length < 10) return;
                if (b.readUInt32BE(2) !== 0) return this.close(1009, 'too big');
                len = b.readUInt32BE(6); off = 10;
            }
            if (len > MAX_MESSAGE) return this.close(1009, 'too big');
            if (b.length < off + 4 + len) return;                        // 프레임이 아직 다 안 왔다
            const mask = b.subarray(off, off + 4);
            const data = Buffer.from(b.subarray(off + 4, off + 4 + len));
            for (let i = 0; i < len; i++) data[i] ^= mask[i & 3];
            this.buf = b.subarray(off + 4 + len);

            if (op >= 0x8) {                                             // 제어 프레임
                if (!fin || len > 125) return this.close(1002, 'bad control');
                if (op === 0x8) return this.close(1000);
                if (op === 0x9) { this._frame(0xA, data); continue; }    // ping → pong
                if (op === 0xA) continue;                                // pong
                return this.close(1002, 'bad opcode');
            }
            if (op === 0x1) {
                if (this.frag) return this.close(1002, 'bad fragment');
                if (fin) this._text(data);
                else { this.frag = [data]; this.fragSize = len; }
            } else if (op === 0x0) {
                if (!this.frag) return this.close(1002, 'bad fragment');
                this.fragSize += len;
                if (this.fragSize > MAX_MESSAGE) return this.close(1009, 'too big');
                this.frag.push(data);
                if (fin) { const all = Buffer.concat(this.frag); this.frag = null; this.fragSize = 0; this._text(all); }
            } else if (op === 0x2) {
                return this.close(1003, 'text only');
            } else {
                return this.close(1002, 'bad opcode');
            }
        }
    }

    _text(buf) {
        if (!this.onMessage) return;
        try { this.onMessage(buf.toString('utf8')); } catch (_e) { this.close(1011, 'error'); }
    }
}

module.exports = { acceptWebSocket, MAX_MESSAGE };
