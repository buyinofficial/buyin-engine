/** 테이블 화면 문구 — 6개 언어. 비어 있으면 영어 */
const T = {
    ko: { /* [REBUY_2026_11_11] */ rbAllin: "올인", rbDone: "바이인 완료", rbAsk: "바이인요~", rbDoneBubble: "바이인 완료!", rbLost: "칩을 모두 잃었어요 — 방장에게 바이인을 신청할 수 있어요", rbBtn: "바이인 신청", rbWait: "방장 승인을 기다리는 중…", rbCancel: "신청 취소", rbRejected: "방장이 바이인 신청을 거절했어요", rbToast: "바이인 완료 — 다음 판부터 참여합니다",
        toLobby: '로비로 돌아가기', pot: '총 팟', potMain: '메인', uncalled: '미콜 베팅', fold: '폴드', check: '체크', call: '콜', raise: '레이즈', bet: '베팅', allin: '올인',
        leave: '나가기', sound: '소리', verify: '카드 검증', cardCheck: '카드 검증', verified: '검증됨', checking: '확인 중', warn: '확인 필요',
        waiting: '다른 참가자를 기다리는 중', joining: '테이블에 들어가는 중…', noTicket: '입장권이 없습니다. 로비에서 다시 들어와 주세요.',
        settled: '자리에서 일어났습니다. 정산 금액', leftAfter: '이번 판이 끝나면 일어납니다', confirmLeave: '나가기', sitout: '자리 비움', back: '돌아왔어요',
        quarter: '쿼터', half: '하프', full: '풀', attOk: 'TEE 증명서와 같은 엔진', attBad: '엔진 키가 증명서와 다름', timeout: '시간 초과', winner: 'WINNER',
        replaced: '이전 접속을 정리하는 중입니다 — 정산이 끝나면 자동으로 다시 앉습니다',
        emote: '이모티콘', chat: '채팅', send: '보내기', chatPh: '메시지 입력 (200자)', tooFast: '조금 천천히 보내 주세요', timeBank: '타임뱅크 +20초',
        emo_angry: '부글부글', emo_sad: '씁쓸하네', emo_win: '승리!', emo_taunt: '쫄~?', emo_thanks: '감사감사', emo_chill: '여유만만', emo_sleepy: '나른해', emo_clap: '박수',
        tipHint: '팁 보내기', tipPreflop: '팁은 프리플랍에서만 보낼 수 있어요', tipCancel: '스택이 모자라거나 상대가 떠나 팁이 취소됐어요',
        gift_flower: '장미', gift_kiss: '키스', gift_confetti: '축하', gift_cigarette: '시가', gift_champagne: '샴페인',
        settings: '설정', volume: '소리 크기', chatTitle: '초대방 채팅', translated: '번역됨', original: '원문', tipPick: '받을 사람을 선택하세요', tipQueued: '핸드 종료 후 전달', tipDone: '전달 완료',
        darkTitle: '인 더 다크', darkSub: '다음 판 패 안 보기', darkOn: '다음 판 예약됨', darkActive: 'IN THE DARK', darkMyHand: '이번 판 내 패', darkSeal: 'DARK',
        preCheckFold: '체크/폴드', reserved: '예약됨', rabbit: 'RABBIT', copied: '복사됨 ✓', emoOnce: '이모티콘은 한 판에 한 번' },
    en: { /* [REBUY_2026_11_11] */ rbAllin: "ALL-IN OUT", rbDone: "BOUGHT IN", rbAsk: "Buy-in pls~", rbDoneBubble: "Bought in!", rbLost: "You are out of chips — ask the host for a buy-in", rbBtn: "Ask for buy-in", rbWait: "Waiting for the host…", rbCancel: "Cancel", rbRejected: "The host declined your buy-in request", rbToast: "Buy-in done — you play from the next hand",
        toLobby: 'Back to lobby', pot: 'POT', potMain: 'MAIN', uncalled: 'UNCALLED', fold: 'Fold', check: 'Check', call: 'Call', raise: 'Raise', bet: 'Bet', allin: 'All-in',
        leave: 'Leave', sound: 'Sound', verify: 'Card check', cardCheck: 'Card check', verified: 'Verified', checking: 'Checking', warn: 'Check needed',
        waiting: 'Waiting for other players', joining: 'Joining the table…', noTicket: 'No seat ticket. Please enter again from the lobby.',
        settled: 'You left the table. Cash-out', leftAfter: 'You will leave after this hand', confirmLeave: 'Leave', sitout: 'Sit out', back: "I'm back",
        quarter: 'Quarter', half: 'Half', full: 'Pot', attOk: 'Engine matches the TEE attestation', attBad: 'Engine key differs from the attestation', timeout: 'Time out', winner: 'WINNER',
        replaced: 'Closing your previous session — you will sit again automatically once it is settled',
        emote: 'Emotes', chat: 'Chat', send: 'Send', chatPh: 'Message (200 chars)', tooFast: 'Please slow down a little', timeBank: 'Time bank +20s',
        emo_angry: 'Grr', emo_sad: 'Ouch', emo_win: 'Win!', emo_taunt: 'Scared?', emo_thanks: 'Thanks', emo_chill: 'Chill', emo_sleepy: 'Sleepy', emo_clap: 'Clap',
        tipHint: 'Send a tip', tipPreflop: 'Tips can be sent only during the pre-flop', tipCancel: 'Tip cancelled (not enough chips or the player left)',
        gift_flower: 'Rose', gift_kiss: 'Kiss', gift_confetti: 'Cheers', gift_cigarette: 'Cigar', gift_champagne: 'Champagne',
        settings: 'Settings', volume: 'Volume', chatTitle: 'Table chat', translated: 'Translated', original: 'Original', tipPick: 'Choose who gets the tip', tipQueued: 'Delivered after the hand', tipDone: 'Delivered',
        darkTitle: 'In the dark', darkSub: 'Next hand without looking', darkOn: 'Reserved for next hand', darkActive: 'IN THE DARK', darkMyHand: 'My cards this hand', darkSeal: 'DARK',
        preCheckFold: 'Check/Fold', reserved: 'Reserved', rabbit: 'RABBIT', copied: 'Copied ✓', emoOnce: 'One emote per hand' },
    zh: { /* [REBUY_2026_11_11] */ rbAllin: "全下出局", rbDone: "已买入", rbAsk: "求买入~", rbDoneBubble: "买入完成!", rbLost: "筹码已输光 — 可以向房主申请买入", rbBtn: "申请买入", rbWait: "等待房主批准…", rbCancel: "取消申请", rbRejected: "房主拒绝了买入申请", rbToast: "买入完成 — 从下一手开始参与",
        toLobby: '返回大厅', pot: '总底池', potMain: '主池', uncalled: '未跟注', fold: '弃牌', check: '过牌', call: '跟注', raise: '加注', bet: '下注', allin: '全下', leave: '离开', cardCheck: '牌验证', verified: '已验证', waiting: '等待其他玩家', joining: '正在入座…' },
    ja: { /* [REBUY_2026_11_11] */ rbAllin: "オールイン", rbDone: "バイイン完了", rbAsk: "バイインお願い~", rbDoneBubble: "バイイン完了!", rbLost: "チップがなくなりました — ホストにバイインを申請できます", rbBtn: "バイイン申請", rbWait: "ホストの承認待ち…", rbCancel: "申請取消", rbRejected: "ホストがバイイン申請を断りました", rbToast: "バイイン完了 — 次のハンドから参加します",
        toLobby: 'ロビーへ戻る', pot: 'ポット', potMain: 'メイン', uncalled: '未コール', fold: 'フォールド', check: 'チェック', call: 'コール', raise: 'レイズ', bet: 'ベット', allin: 'オールイン', leave: '退出', cardCheck: 'カード検証', verified: '検証済み', waiting: '他のプレイヤーを待っています', joining: '着席中…' },
    vi: { /* [REBUY_2026_11_11] */ rbAllin: "HẾT CHIP", rbDone: "ĐÃ BUY-IN", rbAsk: "Cho buy-in nha~", rbDoneBubble: "Buy-in xong!", rbLost: "Bạn đã hết chip — có thể xin chủ phòng buy-in", rbBtn: "Xin buy-in", rbWait: "Đang chờ chủ phòng duyệt…", rbCancel: "Hủy", rbRejected: "Chủ phòng đã từ chối buy-in", rbToast: "Buy-in xong — chơi từ ván sau",
        toLobby: 'Về sảnh', pot: 'TỔNG POT', potMain: 'CHÍNH', uncalled: 'CHƯA THEO', fold: 'Bỏ', check: 'Xem', call: 'Theo', raise: 'Tố', bet: 'Cược', allin: 'All-in', leave: 'Rời bàn', cardCheck: 'Kiểm tra bài', verified: 'Đã xác minh', waiting: 'Đang chờ người chơi khác', joining: 'Đang vào bàn…' },
    mn: { /* [REBUY_2026_11_11] */ rbAllin: "ОЛЛ-ИН", rbDone: "БАЙ-ИН ХИЙСЭН", rbAsk: "Бай-ин өгөөч~", rbDoneBubble: "Бай-ин боллоо!", rbLost: "Чип дууслаа — эзнээс бай-ин хүсэж болно", rbBtn: "Бай-ин хүсэх", rbWait: "Эзний зөвшөөрлийг хүлээж байна…", rbCancel: "Цуцлах", rbRejected: "Эзэн бай-ин хүсэлтийг татгалзлаа", rbToast: "Бай-ин боллоо — дараагийн гараас тоглоно",
        toLobby: 'Лобби руу буцах', pot: 'НИЙТ ПОТ', potMain: 'ҮНДСЭН', uncalled: 'ДАГААГҮЙ', fold: 'Фолд', check: 'Чек', call: 'Колл', raise: 'Рэйз', bet: 'Бэт', allin: 'Олл-ин', leave: 'Гарах', cardCheck: 'Хөзөр шалгалт', verified: 'Баталгаажсан', waiting: 'Бусад тоглогчийг хүлээж байна', joining: 'Суудал руу орж байна…' },
};

let lang = 'ko';
export function setLang(l) { lang = T[l] ? l : 'en'; document.documentElement.lang = lang; }
export function getLang() { return lang; }
export function t(k) { return (T[lang] && T[lang][k]) || T.en[k] || k; }
export function applyStatic(root = document) {
    for (const el of root.querySelectorAll('[data-i18n]')) el.textContent = t(el.getAttribute('data-i18n'));
    for (const el of root.querySelectorAll('[data-i18n-title]')) { el.title = t(el.getAttribute('data-i18n-title')); el.setAttribute('aria-label', el.title); }
    for (const el of root.querySelectorAll('[data-i18n-ph]')) el.placeholder = t(el.getAttribute('data-i18n-ph'));
}
