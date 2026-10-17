// ============================================================
// slack-bridge — 讓兩個 LLM（OpenAI「GPT」與 Anthropic「Claude」）在同一個
// Slack 討論串裡輪流對話的 Supabase Edge Function（Deno）。
//
// 運作流程：
//   1. Slack 把事件 POST 進來，先用 SLACK_SIGNING_SECRET 驗簽（verify.ts，擋重放）。
//   2. url_verification 挑戰直接回 challenge；event_callback 先做 slack_events 去重
//      （event_id 與訊息本身各一把鍵），再回 200（3 秒內 ACK），真正的模型呼叫與貼文
//      放到背景工作（EdgeRuntime.waitUntil）。
//   3. 只處理「被 @ 提到機器人」的討論串；忽略任何 bot 的訊息（防無限迴圈）。
//   4. 以 thread_ts 為鍵，先在 DB 端取得這個串的「處理權」（slack_threads.processing_since，
//      跨實例鎖），拿到才讀歷史 / 輪到誰 / 已幾回合，GPT ↔ Claude 輪流回話，
//      每講一句就貼進 Slack 並用 SQL function 原子 append 回表。流程結束一定釋放鎖。
//   5. 安全閥：每個串有回合上限（MAX_ROUNDS，預設 6）。數到上限就停手、
//      改貼一則「回合上限已達」通知，不再自動往下聊。
//
// 所有密鑰都從 Deno.env 讀，程式裡不寫死任何密鑰。
// 需要的 Edge Secrets（supabase secrets set ...，見 docs/slack-bridge.md）：
//   SLACK_BOT_TOKEN / SLACK_SIGNING_SECRET
//   OPENAI_API_KEY / OPENAI_MODEL（預設 gpt-5.5）/ OPENAI_REASONING_EFFORT（預設 low）
//   ANTHROPIC_API_KEY / ANTHROPIC_MODEL（預設 claude-opus-5-5）
//   GPT_ICON / CLAUDE_ICON（emoji 或圖片 URL）
//   MAX_ROUNDS（預設 6）
//   RUN_BUDGET_SECONDS（預設 120；一次背景執行的總時間上限，到了就先暫停、釋放鎖）
//   SUPABASE_URL / service role key（Edge Function 環境內建，程式會自動找；見 serviceRoleKey）
// ============================================================
import OpenAI from "openai";
import Anthropic from "@anthropic-ai/sdk";
import { createClient } from "@supabase/supabase-js";
import { verifySlackSignature } from "./verify.ts";
import {
  envChoice,
  envPositiveInt,
  envString,
  iconField,
  isHandledEvent,
  type ProviderReply,
  remainingMs,
  slackText,
  stripMentions,
} from "./lib.ts";

// Supabase Edge Runtime 提供的全域物件：讓回應送出後背景工作繼續跑。
// 本機 `supabase functions serve` 預設回應完就關閉實例，見 docs/slack-bridge.md「本機測試」。
declare global {
  var EdgeRuntime: { waitUntil(promise: Promise<unknown>): void } | undefined;
}

// ---------- 設定（全部來自環境變數，無預設密鑰） ----------
// 密鑰類缺了就直接 throw：部署後第一次呼叫就會在 log 看到，不會默默用空字串去打 API。
function mustEnv(name: string): string {
  const v = envString(Deno.env.get(name), "");
  if (!v) throw new Error(`缺少環境變數 ${name}，請用 supabase secrets set 設定`);
  return v;
}

/**
 * service role key 的三種來源，依序找：
 *   1. SUPABASE_SERVICE_KEY（本專案 scripts/*.ps1 與 .env.example 既有的名稱，本機 serve 用）
 *   2. SUPABASE_SERVICE_ROLE_KEY（Edge Function 環境內建，舊版專案）
 *   3. SUPABASE_SECRET_KEYS（Edge Function 環境內建，新版專案，JSON）
 */
function serviceRoleKey(): string {
  const direct = envString(Deno.env.get("SUPABASE_SERVICE_KEY"), "") ||
    envString(Deno.env.get("SUPABASE_SERVICE_ROLE_KEY"), "");
  if (direct) return direct;
  const json = envString(Deno.env.get("SUPABASE_SECRET_KEYS"), "");
  if (json) {
    try {
      const parsed = JSON.parse(json) as Record<string, string>;
      if (parsed.default) return parsed.default;
    } catch { /* 往下丟統一的錯誤 */ }
  }
  throw new Error("找不到 SUPABASE_SERVICE_KEY / SUPABASE_SERVICE_ROLE_KEY / SUPABASE_SECRET_KEYS");
}

const REASONING_EFFORTS = ["off", "none", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

const ENV = {
  slackBotToken: mustEnv("SLACK_BOT_TOKEN"),
  slackSigningSecret: mustEnv("SLACK_SIGNING_SECRET"),
  openaiApiKey: mustEnv("OPENAI_API_KEY"),
  openaiModel: envString(Deno.env.get("OPENAI_MODEL"), "gpt-5.5"),
  // 推理強度：聊天情境用 low 省時省錢；設成 off 就不送這個參數（非推理模型需要）
  openaiReasoningEffort: envChoice(Deno.env.get("OPENAI_REASONING_EFFORT"), REASONING_EFFORTS, "low"),
  anthropicApiKey: mustEnv("ANTHROPIC_API_KEY"),
  anthropicModel: envString(Deno.env.get("ANTHROPIC_MODEL"), "claude-opus-5-5"),
  gptIcon: envString(Deno.env.get("GPT_ICON"), ":robot_face:"),
  claudeIcon: envString(Deno.env.get("CLAUDE_ICON"), ":sparkles:"),
  maxRounds: envPositiveInt(Deno.env.get("MAX_ROUNDS"), 6),
  // Edge Function 背景工作有執行時間上限，被砍掉時 finally 不會跑、鎖會卡住；先在上限前自己停。
  runBudgetMs: envPositiveInt(Deno.env.get("RUN_BUDGET_SECONDS"), 120) * 1000,
  supabaseUrl: mustEnv("SUPABASE_URL"),
  supabaseServiceKey: serviceRoleKey(),
};

interface RunDeadline {
  startedAt: number;
  budgetMs: number;
}

const CLEANUP_RESERVE_MS = 10_000;
const IO_TIMEOUT_MS = 10_000;
const MODEL_FOLLOWUP_RESERVE_MS = IO_TIMEOUT_MS * 2;
const NOTICE_TIMEOUT_MS = 3_000;
const ALERT_TIMEOUT_MS = 2_000;
const RELEASE_TIMEOUT_MS = 3_000;

function requestTimeoutMs(
  deadline: RunDeadline,
  reserveMs = 0,
  maxTimeoutMs = Number.POSITIVE_INFINITY,
): number {
  const timeoutMs = Math.min(
    remainingMs(deadline.startedAt, deadline.budgetMs, Date.now()) - reserveMs,
    maxTimeoutMs,
  );
  if (timeoutMs <= 0) throw new Error("Slack bridge 執行時間已到");
  return timeoutMs;
}

const openai = new OpenAI({ apiKey: ENV.openaiApiKey });
const anthropic = new Anthropic({ apiKey: ENV.anthropicApiKey });
const supabase = createClient(ENV.supabaseUrl, ENV.supabaseServiceKey, {
  auth: { persistSession: false },
});

// 兩個模型在 Slack 裡的身分（用 chat:write.customize 覆寫顯示名稱與頭像）。
type Provider = "gpt" | "claude";
type Speaker = "human" | Provider;

const IDENTITIES: Record<Provider, { username: string; icon: string }> = {
  gpt: { username: "GPT", icon: ENV.gptIcon },
  claude: { username: "Claude", icon: ENV.claudeIcon },
};

// ---------- 型別 ----------
interface Turn {
  speaker: Speaker;
  content: string;
}

/** slack_threads 一列（schema-v5-slack.sql + schema-v6 的 processing_since） */
interface ThreadRow {
  id: string;
  thread_ts: string;
  channel_id: string;
  history: Turn[];
  next_turn: Provider;
  round_count: number;
  max_rounds: number;
  processing_since: string | null;
}

interface SlackEvent {
  type: string;
  user?: string;
  text?: string;
  ts?: string;
  channel?: string;
  thread_ts?: string;
  bot_id?: string;
  subtype?: string;
  [k: string]: unknown;
}

interface SlackEnvelope {
  type: "url_verification" | "event_callback" | string;
  challenge?: string;
  event_id?: string;
  event?: SlackEvent;
}

// ---------- 1. Slack 貼文（chat.postMessage） ----------
interface PostMessageOptions {
  channel: string;
  thread_ts: string;
  text: string;
  /** 不給就用機器人本身的名字／頭像 */
  as?: Provider;
}

/** chat.postMessage；需要 scope chat:write，自訂名字／頭像另需 chat:write.customize */
async function postMessage(
  opts: PostMessageOptions,
  deadline: RunDeadline,
  reserveMs = CLEANUP_RESERVE_MS,
  maxTimeoutMs = IO_TIMEOUT_MS,
): Promise<string> {
  const body: Record<string, unknown> = {
    channel: opts.channel,
    thread_ts: opts.thread_ts,
    text: opts.text,
  };
  if (opts.as) {
    const id = IDENTITIES[opts.as];
    Object.assign(body, { username: id.username }, iconField(id.icon));
  }
  const res = await fetch("https://slack.com/api/chat.postMessage", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${ENV.slackBotToken}`,
      "Content-Type": "application/json; charset=utf-8",
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(requestTimeoutMs(deadline, reserveMs, maxTimeoutMs)),
  });
  const data = await res.json() as { ok: boolean; ts?: string; error?: string };
  if (!data.ok) throw new Error(`Slack chat.postMessage 失敗：${data.error ?? "unknown"}`);
  return data.ts ?? "";
}

/** 貼錯誤／提示訊息；連貼文都失敗就只記 log，不再往外丟 */
async function postNotice(channel: string, threadTs: string, text: string, deadline: RunDeadline): Promise<void> {
  try {
    await postMessage({ channel, thread_ts: threadTs, text }, deadline, 0, NOTICE_TIMEOUT_MS);
  } catch (err) {
    console.error("slack-bridge：通知訊息發不出去：", err);
  }
}

// ---------- 2. 呼叫模型 ----------
// 把整串對話整理成一段逐字稿，交給輪到的模型續寫。兩家 API 都用「系統指示 + 單則
// user 訊息（內含逐字稿）」的寫法，最穩、不會踩到 user/assistant 必須交替的限制。
function buildTranscript(history: Turn[]): string {
  const label: Record<Speaker, string> = { human: "人類", gpt: "GPT", claude: "Claude" };
  return history.map((t) => `${label[t.speaker]}：${t.content}`).join("\n");
}

function systemPrompt(me: Provider): string {
  const other = me === "gpt" ? "Claude" : "GPT";
  const myName = IDENTITIES[me].username;
  return [
    `你是「${myName}」，正在 Slack 討論串裡和另一個 AI「${other}」以及人類輪流對話。`,
    `現在輪到你（${myName}）發言。請用繁體中文，直接給出你這一輪的回應即可，`,
    `不要加上自己的名字當開頭，不要複述整段對話，保持精簡、聚焦、有推進。`,
  ].join("");
}

/** OpenAI（Responses API） */
async function callOpenAI(history: Turn[], timeout: number): Promise<ProviderReply> {
  const res = await openai.responses.create({
    model: ENV.openaiModel,
    instructions: systemPrompt("gpt"),
    input: `${buildTranscript(history)}\n\nGPT 的回應：`,
    max_output_tokens: 1024,
    ...(ENV.openaiReasoningEffort !== "off"
      ? { reasoning: { effort: ENV.openaiReasoningEffort as OpenAI.ReasoningEffort } }
      : {}),
  }, { timeout, maxRetries: 0 });
  const text = (res.output_text ?? "").trim();

  // 推理也算在 max_output_tokens 裡：沒講完時要註明，而不是當成完整回覆。
  if (res.status === "incomplete") {
    const reason = res.incomplete_details?.reason;
    return { text, note: reason === "max_output_tokens" ? "（回覆過長被截斷）" : `（回覆未完成：${reason ?? "原因不明"}）` };
  }
  return { text };
}

/** Anthropic（Messages API，beta：server-side fallback） */
async function callAnthropic(history: Turn[], timeout: number): Promise<ProviderReply> {
  const res = await anthropic.beta.messages.create({
    model: ENV.anthropicModel,
    max_tokens: 4096,
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    thinking: { type: "adaptive" },
    output_config: { effort: "low" },
    system: systemPrompt("claude"),
    messages: [
      { role: "user", content: `${buildTranscript(history)}\n\nClaude 的回應：` },
    ],
  }, { timeout, maxRetries: 0 });

  // 先看 stop_reason 再讀 content：婉拒時 content 可能是空的或只有片段。
  if (res.stop_reason === "refusal") {
    const why = res.stop_details?.explanation ?? "安全政策";
    return { text: "", note: `（Claude 這題婉拒回答：${why}）` };
  }

  const text = res.content
    .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text")
    .map((b) => b.text)
    .join("\n")
    .trim();

  // 思考也算在 max_tokens 裡；對話太長也會被切。兩種都可能只剩半句或空的，要註明而不是當成正常回覆。
  if (res.stop_reason === "max_tokens" || res.stop_reason === "model_context_window_exceeded") {
    return { text, note: "（回覆過長被截斷）" };
  }
  return { text };
}

async function callProvider(who: Provider, history: Turn[], timeout: number): Promise<ProviderReply> {
  return who === "gpt" ? await callOpenAI(history, timeout) : await callAnthropic(history, timeout);
}

// ---------- 3. 資料庫（supabase-js，service role 繞過 RLS） ----------

/** slack_events 去重：insert 撞 primary key（23505）就代表處理過，回 false */
async function markOnce(key: string): Promise<boolean> {
  const { error } = await supabase.from("slack_events").insert({ event_id: key });
  if (!error) return true;
  if (error.code === "23505") return false; // unique_violation
  throw new Error(`slack_events 寫入失敗：${error.message}`);
}

type AcquireStatus = "acquired" | "busy" | "capped" | "missing";
interface AcquireResult {
  status: AcquireStatus;
  thread?: ThreadRow;
}

/**
 * 取得這個討論串的處理權（跨實例鎖）。對應 schema-v6 的 SQL function slack_thread_acquire：
 *   update slack_threads set processing_since = now()
 *    where thread_ts = $2
 *      and (processing_since is null or processing_since < now() - interval '10 minutes')
 *      and round_count < max_rounds
 *   returning *
 * 拿不到會回 busy（別的實例正在處理）/ capped（已達上限）/ missing（串不存在且不建）。
 * p_create = true 時，串不存在會先建一筆（round_count 0、max_rounds = MAX_ROUNDS）。
 */
async function acquireThread(
  channel: string,
  threadTs: string,
  create: boolean,
  deadline: RunDeadline,
): Promise<AcquireResult> {
  const { data, error } = await supabase.rpc("slack_thread_acquire", {
    p_channel: channel,
    p_thread_ts: threadTs,
    p_max_rounds: ENV.maxRounds,
    p_create: create,
  }).abortSignal(AbortSignal.timeout(requestTimeoutMs(deadline, CLEANUP_RESERVE_MS, IO_TIMEOUT_MS)));
  if (error) throw new Error(`slack_thread_acquire 失敗：${error.message}`);
  return data as AcquireResult;
}

/**
 * 原子 append 一則到 history；advance = true 時同時翻 next_turn，
 * 翻回 gpt 代表一回合結束，round_count +1（都在 SQL function slack_thread_append 內一次做完）。
 */
async function appendTurn(
  threadId: string,
  turn: Turn,
  advance: boolean,
  deadline: RunDeadline,
): Promise<ThreadRow> {
  const { data, error } = await supabase.rpc("slack_thread_append", {
    p_id: threadId,
    p_turn: turn,
    p_advance: advance,
  }).abortSignal(AbortSignal.timeout(requestTimeoutMs(deadline, CLEANUP_RESERVE_MS, IO_TIMEOUT_MS)));
  if (error) throw new Error(`slack_thread_append 失敗：${error.message}`);
  return data as ThreadRow;
}

/** 釋放鎖（processing_since = null）。流程結束（含錯誤）一定呼叫。 */
async function releaseThread(threadId: string, deadline: RunDeadline): Promise<void> {
  const { error } = await supabase
    .from("slack_threads")
    .update({ processing_since: null })
    .eq("id", threadId)
    .abortSignal(AbortSignal.timeout(requestTimeoutMs(deadline, 0, RELEASE_TIMEOUT_MS)));
  if (error) console.error("slack-bridge：釋放鎖失敗：", error.message);
}

// ---------- 4. agent_alerts 側寫（best-effort，失敗不影響主流程） ----------
// 比照 scripts/notify.ps1 寫入既有的 agent_alerts 表，讓活動出現在網站「執行紀錄」頁。
async function bestEffortAlert(
  level: string,
  title: string,
  body: string,
  deadline: RunDeadline,
): Promise<void> {
  try {
    await supabase.from("agent_alerts")
      .insert({ level, title, body, session: "slack-bridge" })
      .abortSignal(AbortSignal.timeout(requestTimeoutMs(deadline, 0, ALERT_TIMEOUT_MS)));
  } catch {
    // 側寫失敗就算了，不讓它拖垮 Slack 對話。
  }
}

// ---------- 5. 對話主迴圈 ----------
// 從目前狀態開始，GPT ↔ Claude 一來一回，直到回合上限。每講一句就貼進 Slack、寫回表。
// 呼叫端已持有鎖；這裡只管講話。
async function runConversation(thread: ThreadRow, deadline: RunDeadline): Promise<void> {
  // 一回合 = GPT 講一句 + Claude 講一句。next_turn 從 'claude' 翻回 'gpt' 時 round_count +1。
  while (thread.round_count < thread.max_rounds) {
    const who = thread.next_turn;
    // 剩不到 30 秒就不開新的一句：留時間給回覆寫入、通知與釋放鎖。
    const timeLeft = remainingMs(deadline.startedAt, deadline.budgetMs, Date.now());
    if (timeLeft <= CLEANUP_RESERVE_MS + MODEL_FOLLOWUP_RESERVE_MS) {
      await postNotice(thread.channel_id, thread.thread_ts, "⏸ 這次執行時間已到，先暫停。在討論串回覆或 @ 我就會接著繼續。", deadline);
      return;
    }
    // SDK 預設失敗會重試、每次重試都重算 timeout，會超出剩餘時間，所以呼叫時關掉重試。
    let reply: ProviderReply;
    try {
      reply = await callProvider(
        who,
        thread.history,
        requestTimeoutMs(deadline, CLEANUP_RESERVE_MS + MODEL_FOLLOWUP_RESERVE_MS),
      );
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      await postNotice(thread.channel_id, thread.thread_ts, `⚠️ ${IDENTITIES[who].username} 回應失敗：${reason.slice(0, 300)}`, deadline);
      await bestEffortAlert("info", "Slack bridge 模型呼叫失敗", `thread_ts=${thread.thread_ts}, who=${who}: ${reason}`, deadline);
      return;
    }
    // Slack 看得到說明；歷史只存模型真正說的話，免得之後兩個模型把說明當成對話內容。
    await postMessage({ channel: thread.channel_id, thread_ts: thread.thread_ts, text: slackText(reply), as: who }, deadline);
    thread = await appendTurn(thread.id, { speaker: who, content: reply.text || "（沒有產生內容）" }, true, deadline);
  }

  // 安全閥：到達回合上限，貼一則通知後停手。
  await postNotice(
    thread.channel_id,
    thread.thread_ts,
    `🛑 回合上限已達（${thread.max_rounds} 回合），已停止自動對話。需要繼續請調整 MAX_ROUNDS 或重開討論串。`,
    deadline,
  );
  await bestEffortAlert("info", "Slack bridge 回合上限已達", `thread_ts=${thread.thread_ts}, rounds=${thread.round_count}`, deadline);
}

// ---------- 6. 事件處理（背景執行） ----------
async function handleEvent(event: SlackEvent, deadline: RunDeadline): Promise<void> {
  const channel = event.channel ?? "";
  // 用討論串根訊息的 ts 當鍵；若訊息本身就是根訊息，thread_ts 可能缺省，退回 ts。
  const threadTs = event.thread_ts || event.ts || "";
  if (!channel || !threadTs) return;
  const userText = stripMentions(event.text);
  const isMention = event.type === "app_mention";

  // 只在「被 @ 提到機器人」時才開新串，避免機器人對所有訊息都插話。
  const acquired = await acquireThread(channel, threadTs, isMention, deadline);
  if (acquired.status === "missing") return;
  if (acquired.status === "busy") {
    await postNotice(channel, threadTs, "⏳ 這個討論串正在處理中，請稍候再試。", deadline);
    return;
  }
  if (acquired.status === "capped") {
    await postNotice(channel, threadTs, `🛑 這個討論串已達回合上限（${acquired.thread?.max_rounds ?? ENV.maxRounds} 回合）。`, deadline);
    return;
  }

  let thread = acquired.thread!;
  try {
    // 把人類這句話加進歷史（不翻 next_turn）。
    if (userText) thread = await appendTurn(thread.id, { speaker: "human", content: userText }, false, deadline);
    await runConversation(thread, deadline);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    console.error("slack-bridge 錯誤：", err);
    await postNotice(channel, threadTs, `⚠️ bridge 錯誤：${reason.slice(0, 300)}`, deadline);
    await bestEffortAlert("info", "Slack bridge 背景處理失敗", `thread_ts=${threadTs}: ${reason}`, deadline);
  } finally {
    await releaseThread(thread.id, deadline);
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

// ---------- 7. HTTP 入口 ----------
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

  if (payload.type !== "event_callback" || !payload.event) return new Response("ok");
  const event = payload.event;
  if (!isHandledEvent(event)) return new Response("ok");

  // 去重（兩把鍵都寫 slack_events，撞到就略過）：
  //   1. event_id：Slack 3 秒沒收到 200 會重送，重送也走這條，不看 X-Slack-Retry-Num。
  //   2. 訊息本身（channel:ts）：同一則 @ 訊息，Slack 會同時發 app_mention 與 message 兩個事件
  //      （event_id 不同），只處理第一個通過過濾的；根 message 已由 isHandledEvent
  //      略過，讓可開新串的 app_mention 保留這把鍵。
  if (payload.event_id && !(await markOnce(payload.event_id))) return new Response("ok");
  if (event.channel && event.ts && !(await markOnce(`msg:${event.channel}:${event.ts}`))) return new Response("ok");

  // 先回 200，實際工作丟背景
  const pending = runInBackground(() => {
    const deadline = { startedAt: Date.now(), budgetMs: ENV.runBudgetMs };
    return handleEvent(event, deadline).catch((err) =>
      bestEffortAlert("info", "Slack bridge 背景處理失敗", String(err), deadline)
    );
  });
  if (pending) await pending; // 只有在沒有 EdgeRuntime 的環境才會走到這
  return new Response("ok");
});
