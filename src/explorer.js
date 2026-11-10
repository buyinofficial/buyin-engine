'use strict';
/**
 * [ATTEST_EXPLORER_2026_11_10] 이 엔진이 자기 증명서(TDX quote — 공개 정보)를 Phala 의 TEE 증명 탐색기에 직접 올린다.
 *   탐색기가 Intel 서명을 확인하고 공개 보고서 주소를 준다 → 감사 보고서(/ai.html)에 그 주소를 적는다.
 *   운영자 서버를 거치지 않으므로, 읽는 사람(사람·AI)은 이 엔진의 글에서 바로 제3자 검증 결과로 간다.
 *   보내는 것은 quote 하나뿐이다(카드·기록·키 없음). 실패하면 10분마다 다시 시도한다.
 */
const EXPLORER = process.env.TEE_ATTEST_EXPLORER || 'https://proof.t16z.com';

function startExplorerUpload(getQuote, onReport) {
    let done = false;
    const once = async () => {
        if (done) return;
        const q = String(getQuote() || '').replace(/^0x/, '');
        if (!/^[0-9a-f]+$/i.test(q)) return;
        try {
            const fd = new FormData();
            fd.append('hex', q);
            const r = await fetch(EXPLORER + '/api/upload', { method: 'POST', body: fd, signal: AbortSignal.timeout(30000) });
            const j = await r.json();
            const id = String((j && (j.checksum || j.id)) || '');
            if (j && j.success && /^[0-9a-f]{32,128}$/.test(id)) {
                done = true;
                onReport({ page: `${EXPLORER}/reports/${id}`, id });
                console.log(`[tee-engine] quote submitted to ${EXPLORER} report=${id}`);
            }
        } catch (e) { console.error(`[tee-engine] explorer upload failed: ${e.message}`); }
    };
    once();
    const t = setInterval(() => { if (done) clearInterval(t); else once(); }, 10 * 60 * 1000);
    t.unref();
}

module.exports = { startExplorerUpload, EXPLORER };
