// slack-bridge 的純函式（不碰網路、不碰 Deno.env），獨立出來方便單元測試。
// 執行：deno test supabase/functions/slack-bridge/

// ---------- 環境變數解析 ----------
// 規則：
//   - 沒設、空白、或以 `#` 開頭（dotenv 類工具把等號後面的註解當成值）→ 視為未設定，用預設值。
//   - 數值類必須是正整數（Number.isInteger(n) && n > 0），否則用預設值。

/** 字串類環境變數：未設定 / 空白 / `#` 開頭 → 回預設值 */
export function envString(raw: string | undefined | null, fallback: string): string {
  const v = (raw ?? "").trim();
  if (!v || v.startsWith("#")) return fallback;
  return v;
}

/** 正整數環境變數：非正整數（含小數、負數、0、文字）→ 回預設值 */
export function envPositiveInt(raw: string | undefined | null, fallback: number): number {
  const v = envString(raw, "");
  if (!v) return fallback;
  if (!/^\d+$/.test(v)) return fallback;
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

/** 列舉類環境變數：不在允許清單內 → 回預設值 */
export function envChoice<T extends string>(
  raw: string | undefined | null,
  allowed: readonly T[],
  fallback: T,
): T {
  const v = envString(raw, "");
  return (allowed as readonly string[]).includes(v) ? (v as T) : fallback;
}

// ---------- Slack 事件過濾 ----------

/** 這些 subtype 一律略過：編輯、刪除（不是新的發言） */
export const IGNORED_SUBTYPES: readonly string[] = ["message_changed", "message_deleted"];

export interface SlackEventLike {
  type?: unknown;
  subtype?: unknown;
  bot_id?: unknown;
  [k: string]: unknown;
}

/**
 * 回 true 代表這個事件值得處理。
 *  - 忽略任何 bot 的訊息（含機器人自己用 username 覆寫發的）→ 防無限迴圈。
 *  - 忽略 message_changed / message_deleted；保留 thread_broadcast、file_share 等（它們仍是人的新發言）。
 *  - app_mention 可開新串；message 只收真正的串內回覆。
 *    根訊息的 message 必須在去重前略過，避免搶走 app_mention 的 msg: 鍵。
 */
export function isHandledEvent(event: SlackEventLike | null | undefined): boolean {
  if (!event || typeof event !== "object") return false;
  if (event.bot_id) return false;
  if (typeof event.subtype === "string" && IGNORED_SUBTYPES.includes(event.subtype)) return false;
  if (event.type === "app_mention") return true;
  return event.type === "message" &&
    typeof event.thread_ts === "string" && event.thread_ts.length > 0 &&
    typeof event.ts === "string" && event.ts.length > 0 &&
    event.thread_ts !== event.ts;
}

// ---------- Slack 文字 / 貼文欄位 ----------

/** 去掉 `<@U123>`、`<@U123|name>` 這類 mention 標記，剩下的才是人真正說的話 */
export function stripMentions(text: string | undefined | null): string {
  return (text ?? "").replace(/<@[A-Z0-9]+(\|[^>]*)?>/g, "").replace(/\s+/g, " ").trim();
}

/** Slack 的 icon 設定：給 http(s) URL 就當圖片（icon_url），否則當 emoji（icon_emoji，例如 :robot_face:） */
export function iconField(icon: string): { icon_url: string } | { icon_emoji: string } {
  return /^https?:\/\//.test(icon) ? { icon_url: icon } : { icon_emoji: icon };
}

// ---------- 模型回覆 ----------

/** 模型這一輪的結果：text 存進對話歷史；note 只貼到 Slack（截斷、婉拒等說明），不進歷史 */
export interface ProviderReply {
  text: string;
  note?: string;
}

/** 組出要貼到 Slack 的文字：說明另起一行，避免黏進程式碼區塊；兩者都空就給佔位字 */
export function slackText(reply: ProviderReply): string {
  const text = reply.text.trim();
  const note = (reply.note ?? "").trim();
  if (text && note) {
    const displayText = (text.match(/```/g)?.length ?? 0) % 2 ? `${text}\n\`\`\`` : text;
    return `${displayText}\n${note}`;
  }
  return text || note || "（沒有產生內容）";
}

// ---------- 執行時間 ----------

/** 從 startedAt 起算、總預算 budgetMs，到 now 還剩幾毫秒（不會小於 0） */
export function remainingMs(startedAt: number, budgetMs: number, now: number): number {
  return Math.max(0, startedAt + budgetMs - now);
}
