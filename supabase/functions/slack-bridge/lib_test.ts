// lib.ts 單元測試：環境變數驗證、Slack 事件過濾、文字處理
// 執行：deno test supabase/functions/slack-bridge/
import {
  envChoice,
  envPositiveInt,
  envString,
  iconField,
  isHandledEvent,
  remainingMs,
  slackText,
  stripMentions,
} from "./lib.ts";

function assert(cond: boolean, msg: string) {
  if (!cond) throw new Error(msg);
}
function assertEq<T>(actual: T, expected: T, msg: string) {
  if (actual !== expected) throw new Error(`${msg}：got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`);
}

// ---------- envString ----------
Deno.test("envString：未設定 / 空白 / # 開頭 → 預設值", () => {
  assertEq(envString(undefined, "d"), "d", "undefined");
  assertEq(envString(null, "d"), "d", "null");
  assertEq(envString("", "d"), "d", "空字串");
  assertEq(envString("   ", "d"), "d", "空白");
  assertEq(envString("# 這是註解", "d"), "d", "# 開頭");
  assertEq(envString("#", "d"), "d", "只有 #");
});

Deno.test("envString：有值就回去頭尾空白後的值", () => {
  assertEq(envString(" gpt-5.5 ", "d"), "gpt-5.5", "trim");
  assertEq(envString(":robot_face:", "d"), ":robot_face:", "emoji");
});

// ---------- envPositiveInt ----------
Deno.test("envPositiveInt：正整數才接受", () => {
  assertEq(envPositiveInt("6", 3), 6, "6");
  assertEq(envPositiveInt(" 12 ", 3), 12, "trim");
  assertEq(envPositiveInt("1", 3), 1, "1");
});

Deno.test("envPositiveInt：0 / 負數 / 小數 / 文字 / 空 / # → 預設值", () => {
  assertEq(envPositiveInt("0", 3), 3, "0");
  assertEq(envPositiveInt("-2", 3), 3, "負數");
  assertEq(envPositiveInt("2.5", 3), 3, "小數");
  assertEq(envPositiveInt("abc", 3), 3, "文字");
  assertEq(envPositiveInt("6abc", 3), 3, "混雜");
  assertEq(envPositiveInt("", 3), 3, "空");
  assertEq(envPositiveInt(undefined, 3), 3, "undefined");
  assertEq(envPositiveInt("# 6", 3), 3, "# 開頭");
  assertEq(envPositiveInt("Infinity", 3), 3, "Infinity");
});

// ---------- envChoice ----------
Deno.test("envChoice：只接受清單內的值", () => {
  const allowed = ["low", "medium", "high"] as const;
  assertEq(envChoice("high", allowed, "low"), "high", "合法值");
  assertEq(envChoice("turbo", allowed, "low"), "low", "不合法值");
  assertEq(envChoice("", allowed, "low"), "low", "空");
  assertEq(envChoice("# low", allowed, "medium"), "medium", "# 開頭");
});

// ---------- isHandledEvent ----------
Deno.test("isHandledEvent：app_mention 與串內 message 要處理", () => {
  assert(isHandledEvent({ type: "app_mention", text: "<@U1> hi" }), "app_mention");
  assert(isHandledEvent({ type: "message", text: "hi", ts: "2.0", thread_ts: "1.0" }), "message");
});

Deno.test("isHandledEvent：任何 bot 訊息一律略過（防無限迴圈）", () => {
  assert(!isHandledEvent({ type: "message", bot_id: "B123", subtype: "bot_message", ts: "2.0", thread_ts: "1.0" }), "bot_message");
  assert(!isHandledEvent({ type: "app_mention", bot_id: "B123" }), "bot app_mention");
});

Deno.test("isHandledEvent：message_changed / message_deleted 略過", () => {
  assert(!isHandledEvent({ type: "message", subtype: "message_changed", ts: "2.0", thread_ts: "1.0" }), "message_changed");
  assert(!isHandledEvent({ type: "message", subtype: "message_deleted", ts: "2.0", thread_ts: "1.0" }), "message_deleted");
});

Deno.test("isHandledEvent：thread_broadcast / file_share 保留", () => {
  assert(isHandledEvent({ type: "message", subtype: "thread_broadcast", text: "x", ts: "2.0", thread_ts: "1.0" }), "thread_broadcast");
  assert(isHandledEvent({ type: "message", subtype: "file_share", text: "x", ts: "2.0", thread_ts: "1.0" }), "file_share");
});

Deno.test("isHandledEvent：其他型別 / 空值 → false", () => {
  assert(!isHandledEvent({ type: "reaction_added" }), "reaction_added");
  assert(!isHandledEvent(null), "null");
  assert(!isHandledEvent(undefined), "undefined");
});


Deno.test("isHandledEvent：根 message 在去重前略過，交由 app_mention 開串", () => {
  const root = { type: "message", channel: "C1", ts: "1.0", text: "<@U1> hi" };
  assert(!isHandledEvent(root), "沒有 thread_ts 的根訊息");
  assert(!isHandledEvent({ ...root, thread_ts: root.ts }), "thread_ts 等於 ts 的根訊息");
  assert(!isHandledEvent({ ...root, text: "ordinary message" }), "一般頻道訊息");
  assert(!isHandledEvent({ ...root, thread_ts: "" }), "空 thread_ts");
  assert(!isHandledEvent({ ...root, thread_ts: 123 }), "非字串 thread_ts");
  assert(!isHandledEvent({ ...root, thread_ts: "0.0", ts: undefined }), "缺少 ts");
  assert(isHandledEvent({ ...root, type: "app_mention" }), "根 mention");
  assert(isHandledEvent({ ...root, type: "app_mention", thread_ts: root.ts }), "明確的根 mention");
});

// 模擬 HTTP 入口的「先過濾，再 event_id / msg: 去重」次序。
// 不呼叫 Slack、模型或資料庫；驗證根 mention 不論先後及重送都只會進入一次。
Deno.test("isHandledEvent：根 mention 的兩種事件順序與重送都保留一次開串", () => {
  for (const thread_ts of [undefined, "1.0"]) {
    const root = { channel: "C1", ts: "1.0", thread_ts, text: "<@U1> hi" };
    const message = { event_id: "EvMessage", event: { ...root, type: "message" } };
    const mention = { event_id: "EvMention", event: { ...root, type: "app_mention" } };
    for (const deliveries of [[message, mention, message, mention], [mention, message, mention, message]]) {
      const seen = new Set<string>();
      const handled: string[] = [];
      for (const { event_id, event } of deliveries) {
        if (!isHandledEvent(event)) continue;
        if (seen.has(event_id)) continue;
        seen.add(event_id);
        const key = `msg:${event.channel}:${event.ts}`;
        if (seen.has(key)) continue;
        seen.add(key);
        handled.push(event.type);
      }
      assertEq(handled.length, 1, "只處理一次");
      assertEq(handled[0], "app_mention", "保留可建立新串的事件");
      assert(!seen.has("EvMessage"), "根 message 不消耗任何去重鍵");
    }
  }
});

Deno.test("isHandledEvent：串內追問與 mention 的 message 副本仍可去重", () => {
  const reply = { channel: "C1", ts: "2.0", thread_ts: "1.0", text: "<@U1> follow-up" };
  for (const types of [["message", "app_mention"], ["app_mention", "message"]]) {
    const seen = new Set<string>();
    let handled = 0;
    for (const type of types) {
      const event = { ...reply, type };
      assert(isHandledEvent(event), "串內事件保留");
      const key = `msg:${event.channel}:${event.ts}`;
      if (seen.has(key)) continue;
      seen.add(key);
      handled++;
    }
    assertEq(handled, 1, "串內同一訊息只處理一次");
  }
});

// ---------- stripMentions / iconField ----------
Deno.test("stripMentions：拿掉 <@U…> 與 <@U…|name>，壓掉多餘空白", () => {
  assertEq(stripMentions("<@U123ABC> 空運跟海運怎麼選？"), "空運跟海運怎麼選？", "基本");
  assertEq(stripMentions("<@U123ABC|bridge>  你好   <@U999>"), "你好", "含名稱與多個");
  assertEq(stripMentions(undefined), "", "undefined");
});

Deno.test("iconField：URL → icon_url；其他 → icon_emoji", () => {
  const u = iconField("https://example.com/a.png");
  assert("icon_url" in u && u.icon_url === "https://example.com/a.png", "url");
  const e = iconField(":robot_face:");
  assert("icon_emoji" in e && e.icon_emoji === ":robot_face:", "emoji");
});

// ---------- slackText ----------
Deno.test("slackText：只有內容 → 原文", () => {
  assertEq(slackText({ text: "你好" }), "你好", "只有內容");
});

Deno.test("slackText：內容加說明 → 說明另起一行", () => {
  assertEq(slackText({ text: "```\nconst x =", note: "（回覆過長被截斷）" }), "```\nconst x =\n```\n（回覆過長被截斷）", "內容＋說明會先閉合程式碼區塊");
  assertEq(slackText({ text: "```\nconst x =\n```", note: "（回覆過長被截斷）" }), "```\nconst x =\n```\n（回覆過長被截斷）", "已閉合的程式碼區塊不重複補上");
});

Deno.test("slackText：只有說明 → 說明", () => {
  assertEq(slackText({ text: "", note: "（Claude 這題婉拒回答：x）" }), "（Claude 這題婉拒回答：x）", "只有說明");
});

Deno.test("slackText：都空 → 佔位字", () => {
  assertEq(slackText({ text: "  " }), "（沒有產生內容）", "都空");
});

// ---------- remainingMs ----------
Deno.test("remainingMs：還有時間 → 剩餘毫秒", () => {
  assertEq(remainingMs(1000, 5000, 3000), 3000, "剩 3 秒");
});

Deno.test("remainingMs：已超時 → 0", () => {
  assertEq(remainingMs(1000, 5000, 9000), 0, "超時");
});
