// ============================================================
// slack-bridge — 讓 GPT 與 Claude 在 Slack 討論串裡用不同名字／頭像對話（MVP）
//
// 觸發方式：在頻道 @機器人 提問（app_mention 事件）。
// 流程：
//   Slack 事件 → 驗簽章 → 去重 → 立刻回 200 →（背景）
//   OpenAI 回一則（名字 GPT）→ Anthropic 針對 GPT 的話接一則（名字 Claude）
//   → 每則都記到 slack_threads.turns。
//
// 部署：supabase functions deploy slack-bridge --no-verify-jwt
// 說明文件：docs/slack-bridge.md
// ============================================================
import OpenAI from "openai";
import Anthropic from "@anthropic-ai/sdk";
import { createClient } from "@supabase/supabase-js";
import { verifySlackSignature } from "./verify.ts";

// Supabase Edge Runtime 提供的全域物件：讓回應送出後背景工作繼續跑。
// 本機 `supabase functions serve` 預設回應完就關閉實例，見 docs/slack-bridge.md「本機測試」。
declare global {
  var EdgeRuntime: { waitUntil(promise: Promise<unknown>): void } | undefined;
}

// ---------- 環境變數（缺就直接 throw，部署後第一次呼叫就會在 log 看到） ----------
function mustEnv(name: string): string {
  const v = Deno.env.get(name);
  if (!v) throw new Error(`缺少環境變數 ${name}，請用 supabase secrets set 設定`);
  return v;
}

/** Supabase 內建的 service role key：新版叫 SUPABASE_SECRET_KEYS（JSON），舊版叫 SUPABASE_SERVICE_ROLE_KEY，兩種都接。 */
function serviceRoleKey(): string {
  const legacy = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (legacy) return legacy;
  const json = Deno.env.get("SUPABASE_SECRET_KEYS");
  if (json) {
    try {
      const parsed = JSON.parse(json) as Record<string, string>;
      if (parsed.default) return parsed.default;
    } catch { /* 往下丟統一的錯誤 */ }
  }
  throw new Error("找不到 SUPABASE_SERVICE_ROLE_KEY 或 SUPABASE_SECRET_KEYS（Edge Function 環境應內建）");
}

const ENV = {
  slackBotToken: mustEnv("SLACK_BOT_TOKEN"),
  slackSigningSecret: mustEnv("SLACK_SIGNING_SECRET"),
  openaiApiKey: mustEnv("OPENAI_API_KEY"),
  // 預設值依 openai-node 官方 README 範例；請依 OpenAI 官方模型清單調整
  openaiModel: Deno.env.get("OPENAI_MODEL") || "gpt-5.5",
  // 推理強度：聊天情境用 low 省時省錢；設成空字串就不送這個參數（非推理模型需要）
  openaiReasoningEffort: Deno.env.get("OPENAI_REASONING_EFFORT") ?? "low",
  anthropicApiKey: mustEnv("ANTHROPIC_API_KEY"),
  anthropicModel: Deno.env.get("ANTHROPIC_MODEL") || "claude-opus-5-5",
  gptIcon: Deno.env.get("GPT_ICON") || ":robot_face:",
  claudeIcon: Deno.env.get("CLAUDE_ICON") || ":sparkles:",
  maxTurns: Number(Deno.env.get("BRIDGE_MAX_TURNS") || "2"),
  supabaseUrl: mustEnv("SUPABASE_URL"),
  supabaseServiceKey: serviceRoleKey(),
};

const openai = new OpenAI({ apiKey: ENV.openaiApiKey });
const anthropic = new Anthropic({ apiKey: ENV.anthropicApiKey });
const supabase = createClient(ENV.supabaseUrl, ENV.supabaseServiceKey, {
  auth: { persistSession: false },
});

// ---------- 型別 ----------
interface SlackAppMentionEvent {
  type: "app_mention";
  user?: string;
  text: string;
  ts: string;
  channel: string;
  thread_ts?: string;
  bot_id?: string;
  subtype?: string;
}

interface SlackEnvelope {
  type: "url_verification" | "event_callback" | string;
  challenge?: string;
  event_id?: string;
  event?: SlackAppMentionEvent | { type: string; [k: string]: unknown };
}

type Speaker = "GPT" | "Claude";

interface Turn {
  speaker: Speaker;
  text: string;
  ts: string; // Slack 訊息 ts
}

interface ThreadRow {
  id: string;
  channel: string;
  thread_ts: string;
  topic: string;
  turns: Turn[];
  turn_count: number;
  max_turns: number;
}

// ---------- 1. Slack 文字處理 ----------
/** 去掉 `<@U123>`、`<@U123|name>` 這類 mention 標記，剩下的才是題目 */
export function stripMentions(text: string): string {
  return text.replace(/<@[A-Z0-9]+(\|[^>]*)?>/g, "").replace(/\s+/g, " ").trim();
}

// ---------- 2. Slack API ----------
interface PostMessageOptions {
  channel: string;
  thread_ts: string;
  text: string;
  /** 不給就用機器人本身的名字／頭像 */
  as?: Speaker;
}

/** Slack 的 icon 設定：給 http(s) URL 就當圖片，否則當 emoji（例如 :robot_face:） */
function iconField(icon: string): { icon_url: string } | { icon_emoji: string } {
  return /^https?:\/\//.test(icon) ? { icon_url: icon } : { icon_emoji: icon };
}

/** chat.postMessage；需要 scope chat:write，自訂名字／頭像另需 chat:write.customize */
async function postMessage(opts: PostMessageOptions): Promise<string> {
  const body: Record<string, unknown> = {
    channel: opts.channel,
    thread_ts: opts.thread_ts,
    text: opts.text,
  };
  if (opts.as === "GPT") Object.assign(body, { username: "GPT" }, iconField(ENV.gptIcon));
  if (opts.as === "Claude") Object.assign(body, { username: "Claude" }, iconField(ENV.claudeIcon));

  const res = await fetch("https://slack.com/api/chat.postMessage", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${ENV.slackBotToken}`,
      "Content-Type": "application/json; charset=utf-8",
    },
    body: JSON.stringify(body),
  });
  const data = await res.json() as { ok: boolean; ts?: string; error?: string };
  if (!data.ok) throw new Error(`Slack chat.postMessage 失敗：${data.error ?? "unknown"}`);
  return data.ts ?? "";
}

// ---------- 3. 兩個模型 ----------
const GPT_INSTRUCTIONS = [
  "你是 GPT，正在 Slack 討論串裡跟另一個 AI（Claude）對話，旁邊有人類在看。",
  "請用繁體中文、白話、精簡（3 到 6 句以內）直接回答題目，給出你的觀點與理由。",
  "不要自我介紹，不要加標題，不要用 Markdown 標題符號。",
].join("\n");

/** 呼叫 OpenAI（Responses API）：回答題目 */
async function askGpt(topic: string): Promise<string> {
  const res = await openai.responses.create({
    model: ENV.openaiModel,
    instructions: GPT_INSTRUCTIONS,
    input: topic,
    max_output_tokens: 1024,
    ...(ENV.openaiReasoningEffort
      ? { reasoning: { effort: ENV.openaiReasoningEffort as OpenAI.ReasoningEffort } }
      : {}),
  });
  const text = res.output_text?.trim();
  if (!text) throw new Error("OpenAI 回覆是空的");
  return text;
}

const CLAUDE_SYSTEM = [
  "你是 Claude，正在 Slack 討論串裡跟另一個 AI（GPT）對話，旁邊有人類在看。",
  "使用者先丟了一個題目，GPT 已經回答過一輪；請針對 GPT 的回覆接話：同意的地方簡短帶過，",
  "不同意或可以補充的地方具體說明。繁體中文、白話、精簡（3 到 6 句以內）。",
  "不要自我介紹，不要加標題，不要用 Markdown 標題符號。",
].join("\n");

/** 呼叫 Anthropic：看過題目與 GPT 的回覆後接話 */
async function askClaude(topic: string, gptReply: string): Promise<string> {
  const res = await anthropic.beta.messages.create({
    model: ENV.anthropicModel,
    max_tokens: 1024,
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    thinking: { type: "adaptive" },
    output_config: { effort: "low" },
    system: CLAUDE_SYSTEM,
    messages: [
      {
        role: "user",
        content: `題目：${topic}\n\nGPT 的回覆：\n${gptReply}\n\n請接話。`,
      },
    ],
  });

  if (res.stop_reason === "refusal") {
    const why = res.stop_details?.explanation ?? "安全政策";
    return `（Claude 這題婉拒回答：${why}）`;
  }

  const text = res.content
    .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text")
    .map((b) => b.text)
    .join("\n")
    .trim();
  if (!text) throw new Error("Anthropic 回覆是空的");
  return text;
}

// ---------- 4. 資料庫 ----------
/** 以 event_id 去重：insert 撞 primary key 就代表處理過，回 false */
async function markEventOnce(eventId: string): Promise<boolean> {
  const { error } = await supabase.from("slack_events").insert({ event_id: eventId });
  if (!error) return true;
  if (error.code === "23505") return false; // unique_violation
  throw new Error(`slack_events 寫入失敗：${error.message}`);
}

/** 取得或建立這個討論串的紀錄 */
async function getOrCreateThread(channel: string, threadTs: string, topic: string): Promise<ThreadRow> {
  const { error: upsertErr } = await supabase
    .from("slack_threads")
    .upsert(
      { channel, thread_ts: threadTs, topic, turns: [], turn_count: 0, max_turns: ENV.maxTurns },
      { onConflict: "channel,thread_ts", ignoreDuplicates: true },
    );
  if (upsertErr) throw new Error(`slack_threads upsert 失敗：${upsertErr.message}`);

  const { data, error } = await supabase
    .from("slack_threads")
    .select("id, channel, thread_ts, topic, turns, turn_count, max_turns")
    .eq("channel", channel)
    .eq("thread_ts", threadTs)
    .single();
  if (error || !data) throw new Error(`slack_threads 讀取失敗：${error?.message ?? "no row"}`);
  return data as ThreadRow;
}

/** 把一則回覆記進 turns，turn_count +1 */
async function appendTurn(thread: ThreadRow, turn: Turn): Promise<ThreadRow> {
  const turns = [...(thread.turns ?? []), turn];
  const turnCount = (thread.turn_count ?? 0) + 1;
  const { error } = await supabase
    .from("slack_threads")
    .update({ turns, turn_count: turnCount })
    .eq("id", thread.id);
  if (error) throw new Error(`slack_threads 更新失敗：${error.message}`);
  return { ...thread, turns, turn_count: turnCount };
}

// ---------- 5. 主流程（背景執行） ----------
async function run(event: SlackAppMentionEvent): Promise<void> {
  const channel = event.channel;
  const threadTs = event.thread_ts ?? event.ts;
  try {
    const topic = stripMentions(event.text);
    if (!topic) {
      await postMessage({ channel, thread_ts: threadTs, text: "請在 @ 我之後附上題目，例如：`@bridge 空運跟海運怎麼選？`" });
      return;
    }

    let thread = await getOrCreateThread(channel, threadTs, topic);

    // 安全閥：每個討論串最多 max_turns 則 AI 回覆
    const capReached = () => thread.turn_count >= thread.max_turns;
    if (capReached()) {
      await postMessage({ channel, thread_ts: threadTs, text: `這個討論串已達回合上限（${thread.max_turns} 則），請另開新討論串。` });
      return;
    }

    // 第一棒：GPT
    const gptReply = await askGpt(topic);
    const gptTs = await postMessage({ channel, thread_ts: threadTs, text: gptReply, as: "GPT" });
    thread = await appendTurn(thread, { speaker: "GPT", text: gptReply, ts: gptTs });

    if (capReached()) return;

    // 第二棒：Claude 接話
    const claudeReply = await askClaude(topic, gptReply);
    const claudeTs = await postMessage({ channel, thread_ts: threadTs, text: claudeReply, as: "Claude" });
    thread = await appendTurn(thread, { speaker: "Claude", text: claudeReply, ts: claudeTs });
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    console.error("slack-bridge 錯誤：", err);
    try {
      await postMessage({ channel, thread_ts: threadTs, text: `⚠️ bridge 錯誤：${reason.slice(0, 200)}` });
    } catch (postErr) {
      console.error("連錯誤訊息都發不出去：", postErr);
    }
  }
}

/** 回應送出後繼續在背景跑；沒有 EdgeRuntime（例如本機）就退回直接 await */
function runInBackground(task: () => Promise<void>): Promise<void> | void {
  if (typeof EdgeRuntime !== "undefined" && EdgeRuntime) {
    EdgeRuntime.waitUntil(task());
    return;
  }
  return task();
}

// ---------- 6. HTTP 入口 ----------
Deno.serve(async (req: Request): Promise<Response> => {
  if (req.method !== "POST") return new Response("method not allowed", { status: 405 });

  // 一定要先拿原始字串做簽章，不能先 JSON.parse
  const rawBody = await req.text();
  const ok = await verifySlackSignature({
    signingSecret: ENV.slackSigningSecret,
    timestamp: req.headers.get("X-Slack-Request-Timestamp"),
    signature: req.headers.get("X-Slack-Signature"),
    rawBody,
  });
  if (!ok) return new Response("invalid signature", { status: 401 });

  let payload: SlackEnvelope;
  try {
    payload = JSON.parse(rawBody) as SlackEnvelope;
  } catch {
    return new Response("bad json", { status: 400 });
  }

  // Slack 設定 Request URL 時的握手
  if (payload.type === "url_verification") {
    return new Response(payload.challenge ?? "", { headers: { "Content-Type": "text/plain" } });
  }

  // Slack 3 秒沒收到 200 會重送；重送的我們一律略過（第一次已經在背景處理）
  if (req.headers.get("X-Slack-Retry-Num")) return new Response("ok");

  if (payload.type !== "event_callback" || !payload.event || payload.event.type !== "app_mention") {
    return new Response("ok");
  }
  const event = payload.event as SlackAppMentionEvent;

  // 忽略機器人自己（含我們用 username 發的訊息）與各種 subtype（編輯、刪除…）
  if (event.bot_id || event.subtype) return new Response("ok");

  // event_id 去重（Slack 偶爾會用不同連線重送同一事件）
  if (payload.event_id) {
    const first = await markEventOnce(payload.event_id);
    if (!first) return new Response("ok");
  }

  // 先回 200，實際工作丟背景
  const pending = runInBackground(() => run(event));
  if (pending) await pending; // 只有在沒有 EdgeRuntime 的環境才會走到這
  return new Response("ok");
});
