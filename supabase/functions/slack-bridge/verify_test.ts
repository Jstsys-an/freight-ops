// 簽章驗證單元測試
// 執行：deno test supabase/functions/slack-bridge/verify_test.ts
//
// 測試資料：secret / timestamp / body 取自 Slack 官方文件的公開範例（不是真實金鑰）。
// 預期簽章 EXPECTED_SIG 不是抄文件，而是用兩套獨立實作各算一次、結果一致後貼進來：
//   Python: hmac.new(secret, f"v0:{ts}:{body}", hashlib.sha256).hexdigest()
//   Node:   crypto.createHmac("sha256", secret).update(`v0:${ts}:${body}`).digest("hex")
// 這樣可以確認 verify.ts 的 Web Crypto 版本跟標準 HMAC-SHA256 算法一致。
import {
  computeSlackSignature,
  constantTimeEqual,
  verifySlackSignature,
} from "./verify.ts";

const SECRET = "8f742231b10e8888abcd99yyyzzz85a5";
const TIMESTAMP = "1531420618";
const BODY =
  "token=xyzz0WbapA4vBCDEFasx0q6G&team_id=T1DC2JH3J&team_domain=testteamnow&channel_id=G8PSS9T3V&channel_name=foobar&user_id=U2CERLKJA&user_name=roadrunner&command=%2Fwebhook-collect&text=&response_url=https%3A%2F%2Fhooks.slack.com%2Fcommands%2FT1DC2JH3J%2F397700885554%2F96rGlfmibIGlgcZRskXaIFfN&trigger_id=398738663015.47445629121.803a0bc887a14d10d2c447fce8b6703c";
const EXPECTED_SIG =
  "v0=a2114d57b48eac39b9ad189dd8316235a7b4a8d21a10bd27519666489c69b503";

function assert(cond: boolean, msg: string) {
  if (!cond) throw new Error(msg);
}

Deno.test("computeSlackSignature 算出的簽章要跟獨立實作（Python/Node）算出的一致", async () => {
  const sig = await computeSlackSignature(SECRET, TIMESTAMP, BODY);
  assert(sig === EXPECTED_SIG, `簽章不符：${sig}`);
});

Deno.test("verifySlackSignature：正確簽章、時間在 5 分鐘內 → true", async () => {
  const ok = await verifySlackSignature({
    signingSecret: SECRET,
    timestamp: TIMESTAMP,
    signature: EXPECTED_SIG,
    rawBody: BODY,
    nowSeconds: Number(TIMESTAMP) + 60,
  });
  assert(ok, "應該通過");
});

Deno.test("verifySlackSignature：簽章被竄改 → false", async () => {
  const bad = EXPECTED_SIG.slice(0, -1) + "4";
  const ok = await verifySlackSignature({
    signingSecret: SECRET,
    timestamp: TIMESTAMP,
    signature: bad,
    rawBody: BODY,
    nowSeconds: Number(TIMESTAMP) + 60,
  });
  assert(!ok, "應該拒絕");
});

Deno.test("verifySlackSignature：body 被竄改 → false", async () => {
  const ok = await verifySlackSignature({
    signingSecret: SECRET,
    timestamp: TIMESTAMP,
    signature: EXPECTED_SIG,
    rawBody: BODY + "&x=1",
    nowSeconds: Number(TIMESTAMP) + 60,
  });
  assert(!ok, "應該拒絕");
});

Deno.test("verifySlackSignature：timestamp 超過 5 分鐘 → false（防重放）", async () => {
  const ok = await verifySlackSignature({
    signingSecret: SECRET,
    timestamp: TIMESTAMP,
    signature: EXPECTED_SIG,
    rawBody: BODY,
    nowSeconds: Number(TIMESTAMP) + 60 * 5 + 1,
  });
  assert(!ok, "應該拒絕");
});

Deno.test("verifySlackSignature：缺 header → false", async () => {
  const ok = await verifySlackSignature({
    signingSecret: SECRET,
    timestamp: null,
    signature: EXPECTED_SIG,
    rawBody: BODY,
  });
  assert(!ok, "應該拒絕");
  const ok2 = await verifySlackSignature({
    signingSecret: SECRET,
    timestamp: TIMESTAMP,
    signature: null,
    rawBody: BODY,
  });
  assert(!ok2, "應該拒絕");
});

Deno.test("constantTimeEqual：相同 / 不同 / 長度不同", () => {
  assert(constantTimeEqual("abc", "abc"), "相同應為 true");
  assert(!constantTimeEqual("abc", "abd"), "不同應為 false");
  assert(!constantTimeEqual("abc", "abcd"), "長度不同應為 false");
});
