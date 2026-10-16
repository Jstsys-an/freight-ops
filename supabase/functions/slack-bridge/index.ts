// ============================================================
// slack-bridge — 讓兩個 LLM（OpenAI「GPT」與 Anthropic「Claude」）在同一個
// Slack 討論串裡輪流對話的 Supabase Edge Function（Deno）。
//
// 運作流程：
//   1. Slack 把事件 POST 進來，先用 SLACK_SIGNING_SECRET 驗簽（擋重放）。
//   2. url_verification 挑戰直接回 challenge；event_callback 先回 200（3 秒內 ACK，
//      避免 Slack 重送），真正的模型呼叫與貼文放到背景工作（EdgeRuntime.waitUntil）。
//   3. 只處理「被 @ 提到機器人」的討論串；忽略機器人自己與其他 bot 的訊息（防無限迴圈）。
//   4. 以 thread_ts 為鍵，從 slack_threads 讀出對話歷史 / 輪到誰 / 已幾回合，
//      GPT ↔ Claude 輪流回話，每講一句就貼進 Slack 並把狀態寫回表。
//   5. 安全閥：每個串有回合上限（MAX_ROUNDS，預設 6）。數到上限就停手、
//      改貼一則「回合上限已達」通知，不再自動往下聊。
//
// 所有密鑰都從 Deno.env 讀，程式裡不寫死任何密鑰。
// 需要的 Edge Secrets（supabase secrets set ...，見 docs/slack-bridge.md）：
//   SLACK_BOT_TOKEN / SLACK_SIGNING_SECRET
//   OPENAI_API_KEY / OPENAI_MODEL（預設 gpt-4o）
//   ANTHROPIC_API_KEY / ANTHROPIC_MODEL（預設 claude-sonnet-4-5）
//   MAX_ROUNDS（預設 6）
//   SUPABASE_URL / SUPABASE_SERVICE_KEY（Edge Function 用 service role 讀寫 slack_threads）
// ============================================================

// ---------- 設定（全部來自環境變數，無預設密鑰） ----------
const SLACK_BOT_TOKEN = Deno.env.get("SLACK_BOT_TOKEN") ?? "";
const SLACK_SIGNING_SECRET = Deno.env.get("SLACK_SIGNING_SECRET") ?? "";
const OPENAI_API_KEY = Deno.env.get("OPENAI_API_KEY") ?? "";
const OPENAI_MODEL = Deno.env.get("OPENAI_MODEL") ?? "gpt-4o";
const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY") ?? "";
const ANTHROPIC_MODEL = Deno.env.get("ANTHROPIC_MODEL") ?? "claude-sonnet-4-5";
const MAX_ROUNDS_DEFAULT = Number(Deno.env.get("MAX_ROUNDS") ?? "6") || 6;
const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SUPABASE_SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_KEY") ?? "";

// 兩個模型在 Slack 裡的身分（用 chat:write.customize 覆寫顯示名稱與頭像）。
const IDENTITIES: Record<Provider, { username: string; icon_emoji: string }> = {
  gpt: { username: "GPT", icon_emoji: ":robot_face:" },
  claude: { username: "Claude", icon_emoji: ":sparkles:" },
};

type Provider = "gpt" | "claude";
type Speaker = "human" | Provider;

interface Turn {
  speaker: Speaker;
  content: string;
}

interface ThreadState {
  thread_ts: string;
  channel_id: string;
  history: Turn[];
  next_turn: Provider;
  round_count: number;
  max_rounds: number;
}

// ---------- 1. Slack 驗簽（v0 HMAC-SHA256，擋重放） ----------
async function verifySlackSignature(req: Request, rawBody: string): Promise<boolean> {
  const timestamp = req.headers.get("x-slack-request-timestamp") ?? "";
  const signature = req.headers.get("x-slack-signature") ?? "";
  if (!SLACK_SIGNING_SECRET || !timestamp || !signature) return false;

  // 時間戳超過 5 分鐘就拒絕（防重放攻擊）。
  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - Number(timestamp)) > 60 * 5) return false;

  const basestring = `v0:${timestamp}:${rawBody}`;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(SLACK_SIGNING_SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const macBuf = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(basestring));
  const expected = "v0=" + [...new Uint8Array(macBuf)].map((b) => b.toString(16).padStart(2, "0")).join("");
  return timingSafeEqual(expected, signature);
}

// 定時比較，避免用字串 === 比對 HMAC 洩漏時間資訊。
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// ---------- 2. slack_threads 讀寫（走 Supabase REST，service role 繞過 RLS） ----------
function restHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return {
    apikey: SUPABASE_SERVICE_KEY,
    Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
    "Content-Type": "application/json",
    ...extra,
  };
}

async function loadThread(threadTs: string): Promise<ThreadState | null> {
  const url = `${SUPABASE_URL}/rest/v1/slack_threads?thread_ts=eq.${encodeURIComponent(threadTs)}&select=*&limit=1`;
  const r = await fetch(url, { headers: restHeaders() });
  if (!r.ok) return null;
  const rows = await r.json().catch(() => []);
  return Array.isArray(rows) && rows.length ? (rows[0] as ThreadState) : null;
}

// upsert：同一個 thread_ts 已存在就更新，否則新增（on_conflict=thread_ts）。
async function saveThread(state: ThreadState): Promise<void> {
  const url = `${SUPABASE_URL}/rest/v1/slack_threads?on_conflict=thread_ts`;
  const body = {
    thread_ts: state.thread_ts,
    channel_id: state.channel_id,
    history: state.history,
    next_turn: state.next_turn,
    round_count: state.round_count,
    max_rounds: state.max_rounds,
  };
  await fetch(url, {
    method: "POST",
    headers: restHeaders({ Prefer: "resolution=merge-duplicates,return=minimal" }),
    body: JSON.stringify(body),
  });
}

// ---------- 3. Slack 貼文（chat.postMessage，用 username + icon_emoji 覆寫身分） ----------
async function postToSlack(channel: string, threadTs: string, text: string, who: Provider | null): Promise<void> {
  const payload: Record<string, unknown> = { channel, thread_ts: threadTs, text };
  if (who) {
    payload.username = IDENTITIES[who].username;
    payload.icon_emoji = IDENTITIES[who].icon_emoji;
  }
  await fetch("https://slack.com/api/chat.postMessage", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${SLACK_BOT_TOKEN}`,
      "Content-Type": "application/json; charset=utf-8",
    },
    body: JSON.stringify(payload),
  });
}

// ---------- 4. 呼叫模型 ----------
// 把整串對話整理成一段逐字稿，交給輪到的模型續寫。兩家 API 都用這種「系統指示 + 單則
// user 訊息（內含逐字稿）」的寫法，最穩、不會踩到 user/assistant 必須交替的限制。
function buildTranscript(history: Turn[]): string {
  const label: Record<Speaker, string> = { human: "人類", gpt: "GPT", claude: "Claude" };
  return history.map((t) => `${label[t.speaker]}：${t.content}`).join("\n");
}

function systemPrompt(me: Provider): string {
  const other = me === "gpt" ? "Claude" : "GPT";
  const myName = me === "gpt" ? "GPT" : "Claude";
  return [
    `你是「${myName}」，正在 Slack 討論串裡和另一個 AI「${other}」以及人類輪流對話。`,
    `現在輪到你（${myName}）發言。請用繁體中文，直接給出你這一輪的回應即可，`,
    `不要加上自己的名字當開頭，不要複述整段對話，保持精簡、聚焦、有推進。`,
  ].join("");
}

async function callOpenAI(history: Turn[]): Promise<string> {
  const r = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: OPENAI_MODEL,
      messages: [
        { role: "system", content: systemPrompt("gpt") },
        { role: "user", content: `${buildTranscript(history)}\n\n換你（GPT）回應：` },
      ],
    }),
  });
  if (!r.ok) throw new Error(`OpenAI ${r.status}: ${await r.text()}`);
  const j = await r.json();
  return (j?.choices?.[0]?.message?.content ?? "").trim();
}

async function callAnthropic(history: Turn[]): Promise<string> {
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: ANTHROPIC_MODEL,
      max_tokens: 1024,
      system: systemPrompt("claude"),
      messages: [
        { role: "user", content: `${buildTranscript(history)}\n\n換你（Claude）回應：` },
      ],
    }),
  });
  if (!r.ok) throw new Error(`Anthropic ${r.status}: ${await r.text()}`);
  const j = await r.json();
  const block = Array.isArray(j?.content) ? j.content.find((c: { type?: string }) => c?.type === "text") : null;
  return (block?.text ?? "").trim();
}

async function callProvider(who: Provider, history: Turn[]): Promise<string> {
  return who === "gpt" ? await callOpenAI(history) : await callAnthropic(history);
}

// ---------- 5. agent_alerts 側寫（best-effort，失敗不影響主流程） ----------
// 比照 scripts/notify.ps1 寫入既有的 agent_alerts 表，讓活動出現在網站「執行紀錄」頁。
async function bestEffortAlert(level: string, title: string, body: string): Promise<void> {
  try {
    if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) return;
    await fetch(`${SUPABASE_URL}/rest/v1/agent_alerts`, {
      method: "POST",
      headers: restHeaders({ Prefer: "return=minimal" }),
      body: JSON.stringify({ level, title, body, session: "slack-bridge" }),
    });
  } catch {
    // 側寫失敗就算了，不讓它拖垮 Slack 對話。
  }
}

// ---------- 6. 對話主迴圈 ----------
// 從目前狀態開始，GPT ↔ Claude 一來一回，直到回合上限。每講一句就貼進 Slack、寫回表。
async function runConversation(state: ThreadState): Promise<void> {
  // 一回合 = GPT 講一句 + Claude 講一句。next_turn 從 'claude' 翻回 'gpt' 時 round_count +1。
  while (state.round_count < state.max_rounds) {
    const who = state.next_turn;
    let reply = "";
    try {
      reply = await callProvider(who, state.history);
    } catch (err) {
      await postToSlack(state.channel_id, state.thread_ts, `⚠️ ${IDENTITIES[who].username} 回應失敗：${String(err)}`, null);
      await bestEffortAlert("info", "Slack bridge 模型呼叫失敗", String(err));
      return;
    }
    if (!reply) reply = "（沒有產生內容）";

    await postToSlack(state.channel_id, state.thread_ts, reply, who);
    state.history.push({ speaker: who, content: reply });

    // 翻到下一位；若翻回 gpt 代表一回合結束。
    state.next_turn = who === "gpt" ? "claude" : "gpt";
    if (state.next_turn === "gpt") state.round_count += 1;
    await saveThread(state);
  }

  // 安全閥：到達回合上限，貼一則通知後停手。
  await postToSlack(
    state.channel_id,
    state.thread_ts,
    `🛑 回合上限已達（${state.max_rounds} 回合），已停止自動對話。需要繼續請調整 MAX_ROUNDS 或重開討論串。`,
    null,
  );
  await bestEffortAlert("info", "Slack bridge 回合上限已達", `thread_ts=${state.thread_ts}, rounds=${state.round_count}`);
}

// ---------- 7. 事件處理 ----------
// 回傳 true 代表這個事件值得啟動對話。
function isHandledEvent(event: Record<string, unknown>): boolean {
  if (!event) return false;
  // 忽略機器人自己或其他 bot（防無限迴圈）；忽略訊息編輯/刪除等 subtype。
  if (event.bot_id) return false;
  if (event.subtype) return false;
  const type = event.type as string;
  return type === "app_mention" || type === "message";
}

// 把 Slack 訊息裡的 <@U123> 之類的提及拿掉，只留人類真正說的話。
function stripMentions(text: string): string {
  return (text ?? "").replace(/<@[^>]+>/g, "").trim();
}

async function handleEvent(event: Record<string, unknown>): Promise<void> {
  const channel = event.channel as string;
  // 用討論串根訊息的 ts 當鍵；若訊息本身就是根訊息，thread_ts 可能缺省，退回 ts。
  const threadTs = (event.thread_ts as string) || (event.ts as string);
  const userText = stripMentions(event.text as string);
  if (!channel || !threadTs) return;

  let state = await loadThread(threadTs);
  const isMention = (event.type as string) === "app_mention";

  if (!state) {
    // 只在「被 @ 提到機器人」時才開新串，避免機器人對所有訊息都插話。
    if (!isMention) return;
    state = {
      thread_ts: threadTs,
      channel_id: channel,
      history: [],
      next_turn: "gpt",
      round_count: 0,
      max_rounds: MAX_ROUNDS_DEFAULT,
    };
  }

  // 把人類這句話加進歷史。
  if (userText) state.history.push({ speaker: "human", content: userText });
  await saveThread(state);

  // 已達上限：不再自動往下聊（安全閥）。
  if (state.round_count >= state.max_rounds) {
    await postToSlack(channel, threadTs, `🛑 這個討論串已達回合上限（${state.max_rounds} 回合）。`, null);
    return;
  }

  await runConversation(state);
}

// ---------- 8. HTTP 入口 ----------
Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return new Response("ok", { status: 200 });

  const rawBody = await req.text();

  // 先驗簽，驗不過直接擋掉。
  if (!(await verifySlackSignature(req, rawBody))) {
    return new Response("invalid signature", { status: 401 });
  }

  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return new Response("bad request", { status: 400 });
  }

  // Slack 設定 Request URL 時的挑戰驗證。
  if (payload.type === "url_verification") {
    return new Response(JSON.stringify({ challenge: payload.challenge }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }

  // Events API：3 秒內先回 200（避免 Slack 重送），模型呼叫與貼文放背景。
  if (payload.type === "event_callback") {
    const event = payload.event as Record<string, unknown>;
    if (isHandledEvent(event)) {
      // EdgeRuntime.waitUntil 讓背景工作在回應送出後繼續跑完。
      const task = handleEvent(event).catch((err) => bestEffortAlert("info", "Slack bridge 背景處理失敗", String(err)));
      // deno-lint-ignore no-explicit-any
      const edge = (globalThis as any).EdgeRuntime;
      if (edge && typeof edge.waitUntil === "function") edge.waitUntil(task);
      else await task;
    }
    return new Response("ok", { status: 200 });
  }

  return new Response("ok", { status: 200 });
});
