// lib.ts 單元測試：環境變數驗證、Slack 事件過濾、文字處理
// 執行：deno test supabase/functions/slack-bridge/
import {
  envChoice,
  envPositiveInt,
  envString,
  iconField,
  isHandledEvent,
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
Deno.test("isHandledEvent：app_mention 與一般 message 要處理", () => {
  assert(isHandledEvent({ type: "app_mention", text: "<@U1> hi" }), "app_mention");
  assert(isHandledEvent({ type: "message", text: "hi" }), "message");
});

Deno.test("isHandledEvent：任何 bot 訊息一律略過（防無限迴圈）", () => {
  assert(!isHandledEvent({ type: "message", bot_id: "B123", subtype: "bot_message" }), "bot_message");
  assert(!isHandledEvent({ type: "app_mention", bot_id: "B123" }), "bot app_mention");
});

Deno.test("isHandledEvent：message_changed / message_deleted 略過", () => {
  assert(!isHandledEvent({ type: "message", subtype: "message_changed" }), "message_changed");
  assert(!isHandledEvent({ type: "message", subtype: "message_deleted" }), "message_deleted");
});

Deno.test("isHandledEvent：thread_broadcast / file_share 保留", () => {
  assert(isHandledEvent({ type: "message", subtype: "thread_broadcast", text: "x" }), "thread_broadcast");
  assert(isHandledEvent({ type: "message", subtype: "file_share", text: "x" }), "file_share");
});

Deno.test("isHandledEvent：其他型別 / 空值 → false", () => {
  assert(!isHandledEvent({ type: "reaction_added" }), "reaction_added");
  assert(!isHandledEvent(null), "null");
  assert(!isHandledEvent(undefined), "undefined");
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
