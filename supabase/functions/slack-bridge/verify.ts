// Slack 請求簽章驗證（Signing Secret）
// 文件：https://api.slack.com/authenticity/verifying-requests-from-slack
//
// 流程：
//   1. 取 header X-Slack-Request-Timestamp（秒），超過 5 分鐘就拒絕（防重放）。
//   2. basestring = `v0:${timestamp}:${rawBody}`，用 Signing Secret 做 HMAC-SHA256。
//   3. 組成 `v0=<hex>` 跟 header X-Slack-Signature 做「固定時間」比較，避免 timing attack。
//
// 只用 Web Crypto（crypto.subtle），不依賴任何 npm 套件，方便在 Edge Function 與單元測試共用。

/** 允許的時間差（秒）。Slack 官方建議 5 分鐘。 */
export const MAX_SKEW_SECONDS = 60 * 5;

const encoder = new TextEncoder();

/** 把 bytes 轉成小寫 hex 字串 */
function toHex(bytes: ArrayBuffer): string {
  return Array.from(new Uint8Array(bytes))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * 計算 Slack 簽章（含 `v0=` 前綴）。
 * 測試時也用這個函式算「預期值」，所以獨立匯出。
 */
export async function computeSlackSignature(
  signingSecret: string,
  timestamp: string,
  rawBody: string,
): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(signingSecret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const basestring = `v0:${timestamp}:${rawBody}`;
  const mac = await crypto.subtle.sign("HMAC", key, encoder.encode(basestring));
  return `v0=${toHex(mac)}`;
}

/**
 * 固定時間字串比較：不論在第幾個字元不同，花的時間都一樣。
 * 長度不同直接回 false（長度本身不是秘密）。
 */
export function constantTimeEqual(a: string, b: string): boolean {
  const ab = encoder.encode(a);
  const bb = encoder.encode(b);
  if (ab.length !== bb.length) return false;
  let diff = 0;
  for (let i = 0; i < ab.length; i++) diff |= ab[i] ^ bb[i];
  return diff === 0;
}

export interface VerifyInput {
  signingSecret: string;
  /** header X-Slack-Request-Timestamp 原文（秒） */
  timestamp: string | null;
  /** header X-Slack-Signature 原文（`v0=...`） */
  signature: string | null;
  /** 請求 body 原文（一定要是未經 JSON.parse 的原始字串） */
  rawBody: string;
  /** 現在時間（秒）。測試時可以注入固定值；預設取系統時間。 */
  nowSeconds?: number;
}

/**
 * 驗證 Slack 請求是否合法。
 * 回 true 才能繼續處理；回 false 應回 401。
 */
export async function verifySlackSignature(input: VerifyInput): Promise<boolean> {
  const { signingSecret, timestamp, signature, rawBody } = input;
  if (!signingSecret || !timestamp || !signature) return false;

  // timestamp 必須是整數秒，且跟現在差距在 5 分鐘內
  if (!/^\d+$/.test(timestamp)) return false;
  const now = input.nowSeconds ?? Math.floor(Date.now() / 1000);
  if (Math.abs(now - Number(timestamp)) > MAX_SKEW_SECONDS) return false;

  if (!signature.startsWith("v0=")) return false;

  const expected = await computeSlackSignature(signingSecret, timestamp, rawBody);
  return constantTimeEqual(expected, signature);
}
