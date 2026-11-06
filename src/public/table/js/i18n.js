/** 테이블 화면 문구 — 6개 언어. 비어 있으면 영어 */
const T = {
    ko: { pot: '총 팟', potMain: '메인', uncalled: '미콜 베팅', fold: '폴드', check: '체크', call: '콜', raise: '레이즈', bet: '베팅', allin: '올인',
        leave: '나가기', sound: '소리', verify: '카드 검증', cardCheck: '카드 검증', verified: '검증됨', checking: '확인 중', warn: '확인 필요',
        waiting: '다른 참가자를 기다리는 중', joining: '테이블에 들어가는 중…', noTicket: '입장권이 없습니다. 로비에서 다시 들어와 주세요.',
        settled: '자리에서 일어났습니다. 정산 금액', leftAfter: '이번 판이 끝나면 일어납니다', confirmLeave: '나가기', sitout: '자리 비움', back: '돌아왔어요',
        quarter: '쿼터', half: '하프', full: '풀', attOk: 'TEE 증명서와 같은 엔진', attBad: '엔진 키가 증명서와 다름', timeout: '시간 초과', winner: 'WINNER',
        replaced: '이전 접속을 정리하는 중입니다 — 정산이 끝나면 자동으로 다시 앉습니다' },
    en: { pot: 'POT', potMain: 'MAIN', uncalled: 'UNCALLED', fold: 'Fold', check: 'Check', call: 'Call', raise: 'Raise', bet: 'Bet', allin: 'All-in',
        leave: 'Leave', sound: 'Sound', verify: 'Card check', cardCheck: 'Card check', verified: 'Verified', checking: 'Checking', warn: 'Check needed',
        waiting: 'Waiting for other players', joining: 'Joining the table…', noTicket: 'No seat ticket. Please enter again from the lobby.',
        settled: 'You left the table. Cash-out', leftAfter: 'You will leave after this hand', confirmLeave: 'Leave', sitout: 'Sit out', back: "I'm back",
        quarter: 'Quarter', half: 'Half', full: 'Pot', attOk: 'Engine matches the TEE attestation', attBad: 'Engine key differs from the attestation', timeout: 'Time out', winner: 'WINNER',
        replaced: 'Closing your previous session — you will sit again automatically once it is settled' },
    zh: { pot: '总底池', potMain: '主池', uncalled: '未跟注', fold: '弃牌', check: '过牌', call: '跟注', raise: '加注', bet: '下注', allin: '全下', leave: '离开', cardCheck: '牌验证', verified: '已验证', waiting: '等待其他玩家', joining: '正在入座…' },
    ja: { pot: 'ポット', potMain: 'メイン', uncalled: '未コール', fold: 'フォールド', check: 'チェック', call: 'コール', raise: 'レイズ', bet: 'ベット', allin: 'オールイン', leave: '退出', cardCheck: 'カード検証', verified: '検証済み', waiting: '他のプレイヤーを待っています', joining: '着席中…' },
    vi: { pot: 'TỔNG POT', potMain: 'CHÍNH', uncalled: 'CHƯA THEO', fold: 'Bỏ', check: 'Xem', call: 'Theo', raise: 'Tố', bet: 'Cược', allin: 'All-in', leave: 'Rời bàn', cardCheck: 'Kiểm tra bài', verified: 'Đã xác minh', waiting: 'Đang chờ người chơi khác', joining: 'Đang vào bàn…' },
    mn: { pot: 'НИЙТ ПОТ', potMain: 'ҮНДСЭН', uncalled: 'ДАГААГҮЙ', fold: 'Фолд', check: 'Чек', call: 'Колл', raise: 'Рэйз', bet: 'Бэт', allin: 'Олл-ин', leave: 'Гарах', cardCheck: 'Хөзөр шалгалт', verified: 'Баталгаажсан', waiting: 'Бусад тоглогчийг хүлээж байна', joining: 'Суудал руу орж байна…' },
};

let lang = 'ko';
export function setLang(l) { lang = T[l] ? l : 'en'; document.documentElement.lang = lang; }
export function t(k) { return (T[lang] && T[lang][k]) || T.en[k] || k; }
export function applyStatic(root = document) {
    for (const el of root.querySelectorAll('[data-i18n]')) el.textContent = t(el.getAttribute('data-i18n'));
    for (const el of root.querySelectorAll('[data-i18n-title]')) { el.title = t(el.getAttribute('data-i18n-title')); el.setAttribute('aria-label', el.title); }
}
