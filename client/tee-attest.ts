/**
 * [TEE_VERIFY_2026_11_06] 브라우저가 TEE 엔진을 직접 확인한다 — 로비 검증 센터(PzLobby)와 게임 카드 검증 배지(TeeClient)가 같이 쓴다.
 *
 * 엔진(Phala TEE)의 공개 /info 를 운영 서버를 거치지 않고 바로 받아,
 *   report_data = SHA-256( stableStringify({ ecdh, sig }) )   ← 엔진 공개키 두 개 (buyin-engine src/attest.js 와 같은 계산)
 * 가 하드웨어 증명서(TDX quote) 안의 report_data 와 같은지 브라우저에서 계산해 본다.
 * 같으면 "이 키는 측정된 그 코드가 TEE 안에서 만든 키"다. quote 자체가 진짜 Intel 하드웨어 서명인지는
 * 증명 보고서(trust.phala.com) 또는 Phala·Intel 검증기로 확인한다(검증 센터의 「증명서 보기」).
 */

export const ENGINE_URL = "https://b51e283808f74696162569696b1af768340cd054-3900.dstack-pha1-prod5.phala.network";
export const ENGINE_REPO = "https://github.com/buyinofficial/buyin-engine";

type Jwk = { kty: string; crv: string; x: string; y: string };
export type EngineInfo = {
  name: string; version: string; mode: string;
  keys: { sig: Jwk; ecdh: Jwk; sigFp: string; ecdhFp: string };
  attestation: null | { type: string; reportData: string; quote: string; appId?: string | null; composeHash?: string | null };
  records?: { count: number; head: string; hands: number };
};

export type EngineCheck =
  | { state: "checking" }
  | { state: "ok"; info: EngineInfo }
  | { state: "fail"; info?: EngineInfo; reason: string };

/** 엔진 src/crypto.js stableStringify 와 같다 — 키 이름 정렬, undefined 제외 */
function stableStringify(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v === undefined ? null : v);
  if (Array.isArray(v)) return "[" + v.map(stableStringify).join(",") + "]";
  const o = v as Record<string, unknown>;
  const keys = Object.keys(o).filter((k) => o[k] !== undefined).sort();
  return "{" + keys.map((k) => JSON.stringify(k) + ":" + stableStringify(o[k])).join(",") + "}";
}

const pick = (j: Jwk) => ({ crv: j.crv, kty: j.kty, x: j.x, y: j.y });

async function sha256hex(text: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** TDX quote(v4) 안 report_data — 헤더 48바이트 + TD 보고서 본문 520바이트 위치의 64바이트 */
function quoteReportData(quote: string): string {
  const q = quote.replace(/^0x/, "");
  if (/^[0-9a-fA-F]+$/.test(q)) return q.slice((48 + 520) * 2, (48 + 520 + 64) * 2).toLowerCase();
  const bin = atob(q);
  let out = "";
  for (let i = 48 + 520; i < 48 + 520 + 64 && i < bin.length; i++) out += bin.charCodeAt(i).toString(16).padStart(2, "0");
  return out;
}

export async function checkEngine(signal?: AbortSignal): Promise<EngineCheck> {
  let info: EngineInfo;
  try {
    const r = await fetch(ENGINE_URL + "/info", { cache: "no-store", signal });
    info = await r.json();
  } catch {
    return { state: "fail", reason: "unreachable" };
  }
  try {
    if (!info.attestation || info.mode !== "dstack") return { state: "fail", info, reason: "no-attestation" };
    const want = await sha256hex(stableStringify({ ecdh: pick(info.keys.ecdh), sig: pick(info.keys.sig) }));
    if (info.attestation.reportData !== want) return { state: "fail", info, reason: "key-mismatch" };
    if (!quoteReportData(info.attestation.quote).startsWith(want)) return { state: "fail", info, reason: "quote-mismatch" };
    return { state: "ok", info };
  } catch {
    return { state: "fail", info, reason: "bad-attestation" };
  }
}

export const trustUrl = (appId?: string | null) => (appId ? `https://trust.phala.com/app/${appId}` : "https://trust.phala.com");
export const short = (s?: string | null, n = 10) => (s ? (s.length > n * 2 + 1 ? `${s.slice(0, n)}…${s.slice(-4)}` : s) : "—");
