# Slack bridge：兩個 LLM 在 Slack 討論串輪流對話

讓 OpenAI（顯示為 **GPT**）與 Anthropic（顯示為 **Claude**）在同一個 Slack 討論串裡一來一回地對話，背後是一支 Supabase Edge Function（`supabase/functions/slack-bridge`）。

```
Slack 討論串 ──(@機器人)──▶ Edge Function
                              ├─ 1. 驗簽（verify.ts）
                              ├─ 2. slack_events 去重（event_id + 訊息 ts）
                              ├─ 3. 回 200，背景繼續
                              └─ 4. slack_thread_acquire：搶到這個串的處理權（鎖）才往下
                                     │
                     ┌───────────────┴───────────────┐
                 OpenAI（GPT）                 Anthropic（Claude）
                     └───────────────┬───────────────┘
                                     ▼
                         chat.postMessage 貼回同一串
                         （每句都用 slack_thread_append 原子寫回 slack_threads）
                                     ▼
                         結束（含錯誤）釋放鎖 processing_since = null
```

- 只在「被 @ 提到機器人」的討論串裡運作；忽略任何 bot 的訊息（防無限迴圈）。
- **安全閥**：每個討論串有回合上限（`MAX_ROUNDS`，預設 6；一回合 = GPT 一句 + Claude 一句）。數到上限就停手、改貼一則「回合上限已達」通知，不會無限對話、無限燒 API 額度。
- **跨實例鎖**：同一個串同時只會有一個實例在跑，不會兩邊各自算回合、互相覆蓋。

> 下列密鑰一律由你（使用者）自行設定，**絕不會**放進這個 repo 或任何 commit。

相關檔案：

| 檔案 | 用途 |
|---|---|
| `supabase/functions/slack-bridge/index.ts` | 主程式（入口、Slack API、兩個模型、資料庫、對話迴圈） |
| `supabase/functions/slack-bridge/verify.ts` | Slack 簽章驗證（純 Web Crypto，可單測） |
| `supabase/functions/slack-bridge/lib.ts` | 純函式：環境變數驗證、事件過濾、文字處理 |
| `supabase/functions/slack-bridge/*_test.ts` | 單元測試（`deno test supabase/functions/slack-bridge/`） |
| `supabase/functions/slack-bridge/deno.json` | 這支 function 的依賴（openai / @anthropic-ai/sdk / @supabase/supabase-js） |
| `supabase/migrations/schema-v5-slack.sql` | 建 `slack_threads`（歷史、輪到誰、回合數、上限） |
| `supabase/migrations/schema-v6-slack-bridge-hardening.sql` | 建 `slack_events`（去重）、加 `processing_since`（鎖）、兩個 SQL function |
| `.env.example` | 需要的環境變數清單 |

---

## 1. 建資料表

在 Supabase SQL Editor **依序**執行（都可重複執行，具冪等性）：

1. `supabase/migrations/schema-v5-slack.sql`：建 `slack_threads`。
2. `supabase/migrations/schema-v6-slack-bridge-hardening.sql`：建 `slack_events`、替 `slack_threads` 加 `processing_since`、建 `slack_thread_acquire` / `slack_thread_append` 兩個 function。

v6 一定要套，否則 Edge Function 呼叫 `rpc` 會找不到 function。

## 2. 建 Slack App 並設定 OAuth scopes

到 <https://api.slack.com/apps> 建立 App，於 **OAuth & Permissions → Scopes → Bot Token Scopes** 加入：

| Scope | 用途 |
| --- | --- |
| `chat:write` | 貼訊息 |
| `chat:write.customize` | 用 `username` + `icon_emoji` / `icon_url` 讓 GPT／Claude 顯示成不同身分 |
| `app_mentions:read` | 收到「被 @ 提到」事件 |
| `channels:history` | （選用）訂閱 `message.channels` 時才需要；私密頻道改用 `groups:history` |

安裝 App 到工作區後，複製 **Bot User OAuth Token**（`xoxb-...`）當作 `SLACK_BOT_TOKEN`，並到 **Basic Information → App Credentials** 複製 **Signing Secret** 當作 `SLACK_SIGNING_SECRET`。

## 3. 部署 Edge Function

```bash
supabase functions deploy slack-bridge --no-verify-jwt
```

`--no-verify-jwt`：Slack 不會帶 Supabase JWT，改由程式自己驗 Slack 簽章。也可以在 `supabase/config.toml` 固定：

```toml
[functions.slack-bridge]
verify_jwt = false
```

部署後函式網址長這樣（`<ref>` 是你的專案代號）：

```
https://<ref>.supabase.co/functions/v1/slack-bridge
```

## 4. 設定 Supabase Edge Secrets

函式只從環境變數讀密鑰，程式裡不寫死任何值。用 `supabase secrets set` 設定（變數名稱與說明見 `.env.example`）：

```bash
supabase secrets set \
  SLACK_BOT_TOKEN=xoxb-你的-token \
  SLACK_SIGNING_SECRET=你的-signing-secret \
  OPENAI_API_KEY=sk-你的-openai-key \
  ANTHROPIC_API_KEY=sk-ant-你的-anthropic-key
# 選填（有預設值）：
# supabase secrets set OPENAI_MODEL=gpt-5.5 OPENAI_REASONING_EFFORT=low \
#   ANTHROPIC_MODEL=claude-opus-5-5 GPT_ICON=:robot_face: CLAUDE_ICON=:sparkles: MAX_ROUNDS=6
# 或整包從 .env 推：supabase secrets set --env-file .env
```

| 變數 | 必填 | 預設 | 說明 |
|---|---|---|---|
| `SLACK_BOT_TOKEN` | 是 | — | Bot User OAuth Token |
| `SLACK_SIGNING_SECRET` | 是 | — | 驗簽用 |
| `OPENAI_API_KEY` | 是 | — | |
| `OPENAI_MODEL` | 否 | `gpt-5.5` | 依 OpenAI 官方模型清單調整 |
| `OPENAI_REASONING_EFFORT` | 否 | `low` | `none`/`minimal`/`low`/`medium`/`high`/`xhigh`/`max`；非推理模型填 `off` 不送參數 |
| `ANTHROPIC_API_KEY` | 是 | — | |
| `ANTHROPIC_MODEL` | 否 | `claude-opus-5-5` | |
| `GPT_ICON` / `CLAUDE_ICON` | 否 | `:robot_face:` / `:sparkles:` | emoji 或圖片 URL（`https://` 開頭自動改用 `icon_url`） |
| `MAX_ROUNDS` | 否 | `6` | 正整數；建立新串時寫進 `slack_threads.max_rounds` |

**環境變數驗證規則**（`lib.ts`）：沒設、空白、或以 `#` 開頭的值一律視為未設定、用預設值；`MAX_ROUNDS` 必須是正整數（`0`、負數、小數、文字都會退回預設 6）；`OPENAI_REASONING_EFFORT` 不在清單內會退回 `low`。必填的密鑰缺了，函式啟動時直接 throw，`supabase functions logs slack-bridge` 會看到「缺少環境變數 …」。

- `SUPABASE_URL` 與 service role key 在 Edge Function 環境**內建**（`SUPABASE_SERVICE_ROLE_KEY`，新版專案叫 `SUPABASE_SECRET_KEYS`），不用設、也不能用 `secrets set` 設 `SUPABASE_` 開頭的變數。本機 `serve` 時程式也接受 `.env` 裡既有的 `SUPABASE_SERVICE_KEY`。
- service role key 會繞過 RLS，只設在 Edge Secrets 或本機 `.env`，**不要**提交或外流。

## 5. 設定 Event Subscriptions

在 Slack App 的 **Event Subscriptions**：

1. 開啟 Enable Events。
2. **Request URL** 填上面的函式網址。Slack 會送一個 `url_verification` 挑戰，函式會自動回覆
   `challenge`，顯示 **Verified** 即成功（要等函式部署好才能存）。
3. 於 **Subscribe to bot events** 加入 `app_mention`。要讓人類在串裡的追問也進對話，再加
   `message.channels`（需要 `channels:history` scope）。
4. 儲存後重新安裝 App 讓 scope 生效。

---

## 使用方式

在任一討論串 @ 機器人並說一句話，GPT 與 Claude 就會開始輪流接話，貼在同一串裡，直到達到
`MAX_ROUNDS` 回合上限才停止。有訂閱 `message.channels` 的話，人類在同一串裡再說話會被加進歷史、再接著聊（仍受同一個回合上限管）。

## 運作細節

### 去重與 Slack 重送

- 每個事件先 insert `slack_events`（`event_id` 為 primary key），撞到 `23505` 就略過。
- Slack 3 秒沒收到 200 會重送同一事件（帶 `X-Slack-Retry-Num`）。**重送不看 header 短路**，一樣走
  `event_id` 去重：第一次沒寫成功（例如 DB 暫時失敗）重送才有機會補上。
- 同一則 @ 訊息，Slack 會同時發 `app_mention` 與 `message` 兩個事件（`event_id` 不同），所以
  另外用 `msg:<channel>:<ts>` 再去重一次，只處理先到的那個。
- `slack_events` 只是去重用，v6 migration 底部有可選的 pg_cron 清理（保留 7 天）。

### 跨實例鎖（thread 鎖）

Edge Function 可能同時有多個實例在跑。呼叫模型之前，先用 `slack_thread_acquire` 在 DB 端搶處理權：

```sql
update slack_threads set processing_since = now()
 where thread_ts = $2
   and (processing_since is null or processing_since < now() - interval '10 minutes')
   and round_count < max_rounds
returning *;
```

- 搶到（`acquired`）才讀歷史、叫模型；每一句都用 `slack_thread_append` 一道 update 寫回
  （append history、翻 `next_turn`、翻回 gpt 時 `round_count + 1`），不會讀-改-寫被插隊。
- 搶不到：別的實例正在處理 → 在串裡回「⏳ 這個討論串正在處理中，請稍候再試。」（那句話不會進歷史，
  等這輪跑完再說一次即可）；已達上限 → 回「🛑 已達回合上限」。
- 流程結束（含錯誤）一定把 `processing_since` 清回 `null`；實例被砍沒清到的話，10 分鐘後鎖自動過期。

### 事件過濾

`lib.ts` 的 `isHandledEvent`：

| 條件 | 結果 |
|---|---|
| `event.bot_id` 存在（任何 bot，含機器人自己用 username 覆寫發的） | 略過（防無限迴圈） |
| `subtype` 是 `message_changed` / `message_deleted` | 略過（不是新發言） |
| `subtype` 是 `thread_broadcast` / `file_share` 等 | **保留**（仍是人的新發言） |
| `type` 不是 `app_mention` / `message` | 略過 |

不是 @ 的 `message` 事件，只有在該串已存在（之前被 @ 過）時才會處理；否則靜默略過。

### 頭像與名稱

`username` 固定為 `GPT` / `Claude`；頭像由 `GPT_ICON` / `CLAUDE_ICON` 決定，`https://` 開頭用 `icon_url`，否則當 emoji 用 `icon_emoji`。需要 `chat:write.customize` scope。

### 模型呼叫

- OpenAI：Responses API（`openai.responses.create`），`max_output_tokens: 1024`，`reasoning.effort` 由 `OPENAI_REASONING_EFFORT` 決定。
- Anthropic：`anthropic.beta.messages.create`，`max_tokens: 1024`，`thinking: { type: "adaptive" }`，`output_config: { effort: "low" }`，並開啟 server-side fallback（`betas: ["server-side-fallback-2026-07-01"]` + `fallbacks: "default"`）；回應先看 `stop_reason === "refusal"`，婉拒時貼「（Claude 這題婉拒回答：…）」而不是空訊息。
- 兩邊都是「系統指示 + 一則 user 訊息（整串逐字稿）」的寫法，不會踩到 user/assistant 必須交替的限制。

### agent_alerts 側寫

模型呼叫失敗、背景處理失敗、回合上限已達，都會 best-effort 寫一筆 `agent_alerts`（`session = 'slack-bridge'`），在網站「執行紀錄」頁看得到；寫失敗不影響 Slack 對話。

---

## 本機測試

```yaml
steps:
  - run: deno test supabase/functions/slack-bridge/
    note: verify_test.ts（簽章）+ lib_test.ts（環境變數驗證、事件過濾）
  - run: deno lint supabase/functions/slack-bridge/
  - run: deno check supabase/functions/slack-bridge/index.ts
    note: 型別檢查（需能連 npm registry）
  - run: supabase functions serve slack-bridge --no-verify-jwt --env-file .env
    note: |
      本機 serve 預設回應完就關掉實例，背景工作（EdgeRuntime.waitUntil）會被砍掉。
      要完整跑完請在 supabase/config.toml 加：
        [edge_runtime]
        policy = "per_worker"
```

## 安全與額度提醒

- **回合上限是安全閥**：兩個 LLM 會互相接話，若不設限會無限對話、一直消耗 OpenAI／Anthropic 額度。
  到達 `MAX_ROUNDS` 就會自動停手並貼通知。要繼續請調高 `MAX_ROUNDS`（只影響新串）、直接改該筆的
  `slack_threads.max_rounds`，或重開新討論串。
- 函式會用 `SLACK_SIGNING_SECRET` 驗證每個請求的簽章（`verify.ts`），並拒絕時間戳超過 5 分鐘的請求（擋重放）。
- 兩個模型每句最多 1024 token、推理強度 low；預設模型是兩家的旗艦等級，要省就改 `OPENAI_MODEL` / `ANTHROPIC_MODEL`。
- 所有密鑰都存在 Supabase Edge Secrets，不在本 repo 裡；`.env` 已被 `.gitignore` 排除。

## 已知限制

- 鎖被占用時人類說的那句話不會進歷史（只回 ⏳ 提示）。
