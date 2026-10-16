// ============================================================
// Slack 雙模型橋接 — GPT ↔ Claude 接力（Supabase Edge Function / Deno）
//
// 流程：
//   Slack 事件 → 本函式 → 依輪次呼叫 OpenAI 或 Anthropic → chat.postMessage 回貼
//
// 做了什麼：
//   1) 驗證 Slack 簽章（HMAC-SHA256，含 5 分鐘重放保護），失敗回 401。
//   2) 回應 url_verification challenge（Slack 設定 Request URL 時用）。
//   3) 3 秒內先回 HTTP 200，模型呼叫丟到背景跑，避免 Slack 重送。
//   4) 忽略 bot 自己發的訊息（bot_id / subtype=bot_message），避免無限迴圈。
//   5) 只處理被 @app_mention 叫醒、且登記在 slack_threads 的討論串。
//   6) 依 next_turn 決定由 GPT 或 Claude 回話，從歷史組 prompt。
//   7) 用 chat.postMessage 覆寫 username + icon_url（chat:write.customize），
//      GPT 側顯示為「GPT」、Claude 側顯示為「Claude」，貼回同一個 thread_ts。
//   8) 寫回 slack_threads（append 歷史、翻轉輪次、round_count +1）。
//   9) 安全閥 MAX_ROUNDS：達到上限就停止自動接力並貼出提示。
//
// 需要的環境變數（見 .env.example；於 supabase secrets set 設定）：
//   SLACK_BOT_TOKEN, SLACK_SIGNING_SECRET,
//   OPENAI_API_KEY, ANTHROPIC_API_KEY,
//   OPENAI_MODEL（選填）, ANTHROPIC_MODEL（選填）, MAX_ROUNDS（選填）,
//   SUPABASE_URL, SUPABASE_SERVICE_KEY
// ============================================================

// ---------- 型別 ----------
interface HistoryItem {
  role: "human" | "gpt" | "claude"; // 這句話的作者
  name: string; // 顯示用名稱（Human / GPT / Claude）
  text: string;
}

interface ThreadRow {
  thread_ts: string;
  channel: string;
  history: HistoryItem[];
  next_turn: "gpt" | "claude";
  round_count: number;
  max_rounds: number;
}

// ---------- 環境變數 ----------
const SLACK_BOT_TOKEN = Deno.env.get("SLACK_BOT_TOKEN") ?? "";
const SLACK_SIGNING_SECRET = Deno.env.get("SLACK_SIGNING_SECRET") ?? "";
const OPENAI_API_KEY = Deno.env.get("OPENAI_API_KEY") ?? "";
const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY") ?? "";
const OPENAI_MODEL = Deno.env.get("OPENAI_MODEL") ?? "gpt-4o";
const ANTHROPIC_MODEL = Deno.env.get("ANTHROPIC_MODEL") ?? "claude-sonnet-5-5";
const DEFAULT_MAX_ROUNDS = parseInt(Deno.env.get("MAX_ROUNDS") ?? "6", 10) || 6;
const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SUPABASE_SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_KEY") ?? "";

// 回覆長度上限：Slack 訊息要短，模型回覆也不用太長。
// 留一點餘裕給 Claude 的 adaptive thinking（會計入 output tokens），避免被截斷。
const MAX_TOKENS = 2048;

// 兩側顯示設定（chat:write.customize）。
const PERSONAS = {
  gpt: { username: "GPT", icon_url: "https://platform.slack-edge.com/img/default_application_icon.png" },
  claude: { username: "Claude", icon_url: "https://platform.slack-edge.com/img/default_application_icon.png" },
} as const;

// ============================================================
// 進入點：先驗證、先 ACK，再把工作丟到背景。
// ============================================================
Deno.serve(async (req: Request): Promise<Response> => {
  if (req.method !== "POST") {
    return new Response("method not allowed", { status: 405 });
  }

  // 簽章驗證要用「原始 body」字串，所以先讀 text，不要先 json()。
  const rawBody = await req.text();
  const timestamp = req.headers.get("x-slack-request-timestamp") ?? "";
  const signature = req.headers.get("x-slack-signature") ?? "";

  if (!(await verifySlackSignature(rawBody, timestamp, signature))) {
    return new Response("invalid signature", { status: 401 });
  }

  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return new Response("bad request", { status: 400 });
  }

  // Slack 設定 Request URL 時會送 url_verification，原樣回傳 challenge。
  if (payload.type === "url_verification") {
    return new Response(JSON.stringify({ challenge: payload.challenge }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }

  // 其餘事件：把實際處理丟到背景，3 秒內先回 200 避免 Slack 重送。
  if (payload.type === "event_callback") {
    const work = handleEvent(payload).catch((err) =>
      console.error("[slack-bridge] handleEvent error:", err)
    );
    // Supabase Edge Runtime 支援 waitUntil；沒有就讓它 fire-and-forget。
    const edgeRuntime = (globalThis as { EdgeRuntime?: { waitUntil(p: Promise<unknown>): void } }).EdgeRuntime;
    if (edgeRuntime?.waitUntil) {
      edgeRuntime.waitUntil(work);
    }
    return new Response("ok", { status: 200 });
  }

  return new Response("ignored", { status: 200 });
});

// ============================================================
// 簽章驗證：base string = v0:{timestamp}:{raw_body}，HMAC-SHA256，
// 與 x-slack-signature 比對；時間差超過 300 秒視為重放，拒絕。
// ============================================================
async function verifySlackSignature(
  rawBody: string,
  timestamp: string,
  signature: string,
): Promise<boolean> {
  if (!SLACK_SIGNING_SECRET || !timestamp || !signature) return false;

  const ts = parseInt(timestamp, 10);
  if (!Number.isFinite(ts)) return false;
  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - ts) > 300) return false; // 重放保護

  const baseString = `v0:${timestamp}:${rawBody}`;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(SLACK_SIGNING_SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const macBytes = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(baseString));
  const expected = "v0=" + toHex(new Uint8Array(macBytes));

  return timingSafeEqual(expected, signature);
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("");
}

// 定長比對，避免時間側通道。長度不同直接 false。
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

// ============================================================
// 事件處理：決定要不要開新串、要不要接力，然後跑接力迴圈。
// ============================================================
async function handleEvent(payload: Record<string, unknown>): Promise<void> {
  const event = payload.event as Record<string, unknown> | undefined;
  if (!event) return;

  // 忽略 bot 自己（含兩個模型互貼）發的訊息，否則會無限迴圈。
  if (event.bot_id || event.subtype === "bot_message") return;

  const type = event.type as string;
  const channel = event.channel as string;
  // 討論串根 ts：有 thread_ts 用 thread_ts，否則用自己的 ts（開新串）。
  const threadTs = (event.thread_ts as string) ?? (event.ts as string);
  if (!channel || !threadTs) return;

  if (type === "app_mention") {
    // 被 @ 叫醒：登記討論串並以提及內容當開場白，接著開始接力。
    const seed = stripMention(event.text as string ?? "");
    await upsertThreadSeed(threadTs, channel, seed);
    await relayLoop(threadTs);
    return;
  }

  if (type === "message") {
    // 一般訊息：只在「已登記且由人類發話」時，把人類輸入併入並續跑接力。
    const existing = await getThread(threadTs);
    if (!existing) return; // 不是橋接管理的串，略過
    const text = (event.text as string ?? "").trim();
    if (!text) return;
    await appendHumanTurn(existing, text);
    await relayLoop(threadTs);
    return;
  }
}

// 去掉開頭的 <@BOTID> 提及，留下真正的訊息。
function stripMention(text: string): string {
  return text.replace(/<@[^>]+>/g, "").trim();
}

// ============================================================
// 接力迴圈：輪流叫 GPT / Claude 回話，直到達到 max_rounds。
// 因為 bot 自己的訊息會被忽略，接力必須在同一次背景執行裡跑完。
// ============================================================
async function relayLoop(threadTs: string): Promise<void> {
  // 每一輪都重新讀取最新狀態，確保 round_count / history 正確。
  for (;;) {
    const thread = await getThread(threadTs);
    if (!thread) return;

    if (thread.round_count >= thread.max_rounds) {
      await postMessage(
        thread.channel,
        threadTs,
        thread.next_turn, // 用下一位的身分貼提示即可
        `已達自動接力上限（${thread.max_rounds} 則）。要繼續的話，直接在這串回一句話叫我。`,
      );
      return;
    }

    const side = thread.next_turn;
    let reply: string;
    try {
      reply = side === "gpt" ? await callOpenAI(thread) : await callAnthropic(thread);
    } catch (err) {
      console.error(`[slack-bridge] ${side} call failed:`, err);
      await postMessage(thread.channel, threadTs, side, `（${side.toUpperCase()} 這一輪出錯了，先停下來。）`);
      return;
    }

    reply = (reply ?? "").trim();
    if (!reply) return;

    await postMessage(thread.channel, threadTs, side, reply);
    await appendModelTurn(thread, side, reply);
    // 迴圈會再讀一次最新狀態，繼續換另一邊，直到達上限。
  }
}

// ============================================================
// slack_threads 資料存取（PostgREST，service_role 金鑰）
// ============================================================
function dbHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return {
    apikey: SUPABASE_SERVICE_KEY,
    Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
    "content-type": "application/json",
    ...extra,
  };
}

async function getThread(threadTs: string): Promise<ThreadRow | null> {
  const url = `${SUPABASE_URL}/rest/v1/slack_threads?thread_ts=eq.${encodeURIComponent(threadTs)}&select=*`;
  const r = await fetch(url, { headers: dbHeaders() });
  if (!r.ok) {
    console.error("[slack-bridge] getThread failed:", r.status, await r.text());
    return null;
  }
  const rows = (await r.json()) as ThreadRow[];
  return rows[0] ?? null;
}

// 開新串：若已存在就不覆寫（避免重複事件洗掉進行中的對話）。
async function upsertThreadSeed(threadTs: string, channel: string, seed: string): Promise<void> {
  const existing = await getThread(threadTs);
  if (existing) return;

  const row = {
    thread_ts: threadTs,
    channel,
    history: seed ? [{ role: "human", name: "Human", text: seed }] : [],
    next_turn: "gpt",
    round_count: 0,
    max_rounds: DEFAULT_MAX_ROUNDS,
  };
  const r = await fetch(`${SUPABASE_URL}/rest/v1/slack_threads`, {
    method: "POST",
    headers: dbHeaders({ Prefer: "resolution=ignore-duplicates" }),
    body: JSON.stringify(row),
  });
  if (!r.ok) console.error("[slack-bridge] upsertThreadSeed failed:", r.status, await r.text());
}

// 人類在串裡補話：append 歷史，並把 round_count 歸零讓接力可以重新開跑。
async function appendHumanTurn(thread: ThreadRow, text: string): Promise<void> {
  const history = [...thread.history, { role: "human", name: "Human", text }];
  await patchThread(thread.thread_ts, { history, round_count: 0 });
}

// 模型回話後：append 歷史、翻轉輪次、round_count +1。
async function appendModelTurn(thread: ThreadRow, side: "gpt" | "claude", text: string): Promise<void> {
  const history = [...thread.history, { role: side, name: PERSONAS[side].username, text }];
  await patchThread(thread.thread_ts, {
    history,
    next_turn: side === "gpt" ? "claude" : "gpt",
    round_count: thread.round_count + 1,
  });
}

async function patchThread(threadTs: string, patch: Record<string, unknown>): Promise<void> {
  const url = `${SUPABASE_URL}/rest/v1/slack_threads?thread_ts=eq.${encodeURIComponent(threadTs)}`;
  const r = await fetch(url, {
    method: "PATCH",
    headers: dbHeaders({ Prefer: "return=minimal" }),
    body: JSON.stringify(patch),
  });
  if (!r.ok) console.error("[slack-bridge] patchThread failed:", r.status, await r.text());
}

// ============================================================
// 模型呼叫
// ============================================================

// 把歷史轉成 {role, content} 序列，並合併連續同 role（Anthropic 需要交替）。
function buildTurns(history: HistoryItem[], self: "gpt" | "claude"): { role: "user" | "assistant"; content: string }[] {
  const turns: { role: "user" | "assistant"; content: string }[] = [];
  for (const item of history) {
    const isSelf = item.role === self;
    const role: "user" | "assistant" = isSelf ? "assistant" : "user";
    // 對方 / 人類的話加上名字前綴，模型才知道是誰在講。
    const content = isSelf ? item.text : `${item.name}: ${item.text}`;
    const last = turns[turns.length - 1];
    if (last && last.role === role) {
      last.content += "\n\n" + content;
    } else {
      turns.push({ role, content });
    }
  }
  return turns;
}

function systemPrompt(self: "gpt" | "claude"): string {
  const other = self === "gpt" ? "Claude" : "GPT";
  return `你正在 Slack 討論串裡與 ${other} 接力對話，你的身分是 ${self === "gpt" ? "GPT" : "Claude"}。` +
    `請針對目前對話內容接話，回覆精簡、聚焦、使用繁體中文。不要重複對方已經講過的內容。`;
}

// GPT：OpenAI Chat Completions API
async function callOpenAI(thread: ThreadRow): Promise<string> {
  const messages = [
    { role: "system", content: systemPrompt("gpt") },
    ...buildTurns(thread.history, "gpt"),
  ];
  const r = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ model: OPENAI_MODEL, messages, max_tokens: MAX_TOKENS }),
  });
  if (!r.ok) throw new Error(`OpenAI ${r.status}: ${await r.text()}`);
  const data = await r.json();
  return data?.choices?.[0]?.message?.content ?? "";
}

// Claude：Anthropic Messages API
async function callAnthropic(thread: ThreadRow): Promise<string> {
  const messages = buildTurns(thread.history, "claude");
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: ANTHROPIC_MODEL,
      max_tokens: MAX_TOKENS,
      // 聊天接力求快求短，用 low effort 降低思考深度與延遲。
      output_config: { effort: "low" },
      system: systemPrompt("claude"),
      messages,
    }),
  });
  if (!r.ok) throw new Error(`Anthropic ${r.status}: ${await r.text()}`);
  const data = await r.json();
  // 被安全機制擋下時會是 refusal，給個友善提示。
  if (data?.stop_reason === "refusal") return "（這一輪我這邊無法回應。）";
  // content 可能含 thinking 區塊，只取 text。
  const textBlock = (data?.content as { type: string; text?: string }[] | undefined)
    ?.find((b) => b.type === "text");
  return textBlock?.text ?? "";
}

// ============================================================
// 回貼 Slack：覆寫 username + icon_url（需要 chat:write.customize）
// ============================================================
async function postMessage(
  channel: string,
  threadTs: string,
  side: "gpt" | "claude",
  text: string,
): Promise<void> {
  const persona = PERSONAS[side];
  const r = await fetch("https://slack.com/api/chat.postMessage", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${SLACK_BOT_TOKEN}`,
      "content-type": "application/json; charset=utf-8",
    },
    body: JSON.stringify({
      channel,
      thread_ts: threadTs,
      text,
      username: persona.username,
      icon_url: persona.icon_url,
    }),
  });
  const data = await r.json();
  if (!data?.ok) console.error("[slack-bridge] postMessage failed:", data);
}
