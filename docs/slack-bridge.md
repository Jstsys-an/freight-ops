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

> **現況（2026-10-17）**：決定全部離開 Supabase。這支 bridge 從沒部署過（Edge Functions 0 個，`slack_threads` / `slack_events` 不存在，v5～v7 都沒套用）。新家定案後照下面「平台無關的設計規格」重寫，不硬搬。下面第 1～5 節是 Supabase 版的部署步驟，**僅供參考**。

## 平台無關的設計規格（新家照這段做）

換後端時只換「存放與鎖」的實作；下面四項保證不能少。

**直接沿用、不用改的檔案**：`verify.ts`（Slack 簽章驗證，只用 Web Crypto）、`lib.ts`（純函式：環境變數、事件過濾、文字處理）和兩份 `*_test.ts`。
**要重寫的**：`index.ts` 裡 5 處資料庫呼叫（`slack_events` insert、`slack_thread_acquire`、`slack_thread_append`、`slack_threads` 釋放鎖、`agent_alerts` insert），以及下面四項在新家的實作。

### 資料模型

```yaml
thread:                       # 一個 Slack 討論串一筆
  key: [channel_id, thread_ts]   # 兩欄合起來才唯一（頻道隔離）
  history: "[{role, name, content}, ...]"
  next_turn: gpt | claude
  round_count: 整數，GPT→Claude 算一回合
  max_rounds: 整數，建串時寫入（預設 MAX_ROUNDS=6）
  processing_since: 時間或空值      # 鎖
event:                        # 去重用，保留 7 天即可
  key: event_id               # Slack event_id，或 msg:<channel>:<ts>
  received_at: 時間
```

### 四項保證

| # | 要保證什麼 | 為什麼 | 怎麼測 |
|---|---|---|---|
| 1 去重 | 同一個 `event_id` 只處理一次；同一則訊息的 `app_mention` 和 `message` 兩個事件（`event_id` 不同）用 `msg:<channel>:<ts>` 再擋一次 | Slack 3 秒沒拿到 200 就重送；同一則 @ 會發兩個事件 | 同一個 payload 連送兩次，只產生一輪回覆；重送不看 `X-Slack-Retry-Num` 短路，第一次寫失敗時重送要能補上 |
| 2 串鎖 | 同一串同時只有一個實例在處理；搶鎖、檢查回合上限在**同一個原子操作**裡完成；10 分鐘沒釋放自動過期；結束（含錯誤）一定釋放 | 多實例同時跑會各自算回合、互相覆蓋歷史 | 兩個請求同時打同一串，只有一個 `acquired`，另一個回「⏳ 正在處理中」；殺掉處理中的實例，10 分鐘後能重新搶到 |
| 3 串記錄 | 每一句用一個原子操作完成：追加歷史＋翻 `next_turn`＋（翻回 gpt 時）`round_count + 1` | 先讀再寫會被插隊，導致歷史掉句或回合數算錯 | 並行追加 N 句，歷史剛好 N 句、回合數正確 |
| 4 頻道隔離 | 唯一鍵是 `(channel_id, thread_ts)`，鎖、歷史、回合數都依這組鍵 | 不同頻道的 `thread_ts` 可能相同 | 兩個頻道用同一個 `thread_ts`，各自獨立計數、互不干擾 |

新家如果是 Postgres：v6 的 `slack_thread_append` 和 v7 的 `slack_thread_acquire` 改幾行就能用（原檔在 `supabase/migrations/`，資料封存在 Jstsys-FOD）。不是 Postgres：去重用「唯一鍵＋插入失敗即略過」，串鎖用「條件更新＋租約時間」，概念一樣。

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

部署目前 main 前，在 Supabase SQL Editor **依序**執行 v5 → v6 → v7；已完成的 migration 不必重跑：

1. `supabase/migrations/schema-v5-slack.sql`：建 `slack_threads`。
2. `supabase/migrations/schema-v6-slack-bridge-hardening.sql`：建 `slack_events`、替 `slack_threads` 加 `processing_since`、建 `slack_thread_acquire` / `slack_thread_append` 兩個 function。

3. `supabase/migrations/schema-v7-slack-channel-isolation.sql`：將唯一鍵改為 `(channel_id, thread_ts)`，並更新 `slack_thread_acquire`，讓不同頻道的歷史、鎖與回合數互相隔離。

v6 提供必要的 RPC；v7 是目前版本的必要部署前置。套用 v7 前須暫停 bridge 並等待既有工作結束。**套過 v7 後，不可單獨重跑 v6**：v6 會把 RPC 改回 `ON CONFLICT (thread_ts)`，但 v7 已移除該單欄唯一限制，會導致呼叫失敗。若需重跑舊 migration，須在 bridge 暫停期間依序完成，最後重跑 v7，再恢復服務。合併程式碼不代表資料庫已套用 migration。

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

## 最小測試 checklist（照著勾就能跑）

### 前置（先確認這些都完成）

- [ ] Slack App 已授權 `chat:write` / `chat:write.customize` / `app_mentions:read`；若訂閱 `message.channels` 再加 `channels:history`（私密頻道改用 `message.groups` / `groups:history`），scope 更新後重新安裝 App，並將 bot 加入測試頻道
- [ ] 已設定四個自訂 Edge secrets：`SLACK_BOT_TOKEN` / `SLACK_SIGNING_SECRET` / `OPENAI_API_KEY` / `ANTHROPIC_API_KEY`
- [ ] 確認使用含 `serviceRoleKey()` fallback 的目前程式：託管環境自帶 `SUPABASE_URL` 與 `SUPABASE_SERVICE_ROLE_KEY`，或 `SUPABASE_SECRET_KEYS` JSON 的 `default` key；不要手動設定保留的 `SUPABASE_` secrets。本機才使用既有 `.env` 的 `SUPABASE_SERVICE_KEY`（不可提交或列印密鑰）
- [ ] 部署前已依序套用 `supabase/migrations/schema-v5-slack.sql` → `supabase/migrations/schema-v6-slack-bridge-hardening.sql` → `supabase/migrations/schema-v7-slack-channel-isolation.sql`：確認 `slack_threads`、`slack_events`、`processing_since`、兩個 RPC 與 `(channel_id, thread_ts)` 唯一鍵都存在，`slack_thread_acquire` 依頻道與時間戳查找，且兩個 RPC 僅授權 `service_role`
- [ ] 部署前確認 `verify.ts` 驗簽仍啟用且 `SLACK_SIGNING_SECRET` 已設定；Slack 不帶 Supabase JWT，僅此 webhook 使用 `supabase functions deploy slack-bridge --no-verify-jwt`，或第 3 節的 `[functions.slack-bridge] verify_jwt = false`。不要關閉 Slack 簽章驗證，也不要套用到其他函式

> 頻道隔離修正已合併（[PR #18](https://github.com/tienan8952-source/freight-ops/pull/18)），但實際 migration 與 runtime 驗證仍須由部署者確認。依第 1 節暫停 bridge、等待既有工作結束，再套用 v7；不可單獨重跑 v6，任何舊 migration 重跑後都須以 v7 收尾。完成後應驗證不同頻道相同 `thread_ts` 的歷史、鎖與回合數互不影響。

設定依據：[Supabase 環境變數](https://supabase.com/docs/guides/functions/secrets)與[外部 webhook 驗證](https://supabase.com/docs/guides/functions/auth#external-webhooks)。

### Step 1 — URL 驗證

- [ ] Event Subscriptions 填入 Request URL 後顯示 Verified ✅
  - 失敗 → 確認網址正確、函式能回 `url_verification` 的 `challenge`

### Step 2 — 最小 @ 開場（建議先把 `MAX_ROUNDS` 設 2，再開全新 thread；既有串保留原本上限）

- [ ] 在測試頻道送出一則**全新的頻道根訊息**，內容 @ 機器人並說一句話，以這則訊息建立測試串；不要在尚未註冊的既有 thread 內首次 @ 啟動
- [ ] 後續追問回覆在這則根訊息的 thread 內（需訂閱對應 `message` 事件，且仍受忙碌鎖與回合上限限制）
- [ ] 3 秒內 Slack 沒出現「失敗／重試」
- [ ] GPT 先回，頭像／名稱顯示為 GPT
- [ ] Claude 接回，頭像／名稱顯示為 Claude
- [ ] 達到 `MAX_ROUNDS` 後自動停（貼出上限提示），沒有無限互聊

### Step 3 — 驗紀錄

- [ ] `slack_threads` 的 `channel_id` / `thread_ts` 對應測試串，`history` 與 `round_count` 有更新；完成或出錯後 `processing_since` 回到 `null`
- [ ] `slack_events` 有對應 `event_id` 與 `msg:<channel>:<ts>` 去重紀錄；同一事件重送不會多回一輪
- [ ] （選填）站內「🤖 執行紀錄」頁有看到對應 `agent_alerts`

### 常見錯誤速查

- **401 Unauthorized** → 先區分來源：Supabase gateway 的 JWT／Authorization 錯誤發生在 handler 前，檢查此 webhook 的 `verify_jwt` 部署設定；handler 回 `invalid signature` 才檢查 `SLACK_SIGNING_SECRET`、`X-Slack-Signature`、原始 request body 與時間差（>300 秒會拒絕）。不要用移除驗簽來排錯
- **Slack 一直重送同一事件** → 沒在 3 秒內回 200；先查 ACK 前的驗簽與 `slack_events` DB 寫入錯誤／延遲，再查 Edge Runtime 是否正常延續背景工作
- **兩個模型停不下來** → `MAX_ROUNDS` 沒生效，或「忽略 bot 自己」邏輯沒作用
- **頭像／名稱沒換** → 少了 `chat:write.customize`，或 `postMessage` 沒帶 `username` / `icon_url`
- **完全沒回話** → 檢查 `OPENAI_API_KEY` / `ANTHROPIC_API_KEY` 是否正確、看 Edge Function log
