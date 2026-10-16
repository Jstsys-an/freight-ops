# Slack 雙模型橋接（GPT ↔ Claude 接力）

在 Slack 討論串裡 @ 一下機器人，它就會讓 GPT 與 Claude 輪流接力對話，
兩邊各自以不同頭像／名稱回貼在同一條 thread。

## 架構簡圖

```
  Slack 使用者
      │ @app_mention / 在串內回話
      ▼
  Slack Events API ──(POST，帶簽章)──►  Supabase Edge Function
                                        (supabase/functions/slack-bridge)
                                          │  1. 驗簽（HMAC + 重放保護）
                                          │  2. 3 秒內先回 200
                                          │  3. 背景跑接力：
                                          ▼
                       ┌──────────────┴──────────────┐
                       ▼                              ▼
                OpenAI Chat API                 Anthropic Messages API
                   (GPT 輪)                         (Claude 輪)
                       └──────────────┬──────────────┘
                                      ▼
                         chat.postMessage 回貼同一 thread
                        （覆寫 username / icon：GPT 或 Claude）
                                      │
                                      ▼
                        寫回 slack_threads（歷史 / 輪次 / 次數）
```

狀態存在資料表 `slack_threads`（見 `supabase/migrations/schema-v5-slack.sql`）：
`history`（對話歷史）、`next_turn`（下一句換誰）、`round_count` / `max_rounds`（安全閥）。

## 部署步驟

1. 部署 Edge Function：

```bash
supabase functions deploy slack-bridge
```

2. 設定 Edge Function 的 secrets（名稱見 `.env.example`）：

```bash
supabase secrets set \
  SLACK_BOT_TOKEN=xoxb-... \
  SLACK_SIGNING_SECRET=... \
  OPENAI_API_KEY=... \
  ANTHROPIC_API_KEY=... \
  SUPABASE_URL=https://<project-ref>.supabase.co \
  SUPABASE_SERVICE_KEY=...
# 選填：OPENAI_MODEL / ANTHROPIC_MODEL / MAX_ROUNDS
```

3. 在 Supabase SQL Editor 執行一次 `supabase/migrations/schema-v5-slack.sql`
   （建立 `slack_threads` 表，具冪等性）。

4. 函式的對外網址會長這樣，之後貼到 Slack：

```
https://<project-ref>.supabase.co/functions/v1/slack-bridge
```

## Slack App 設定

1. **OAuth & Permissions → Bot Token Scopes** 加上：
   - `chat:write`
   - `chat:write.customize`（覆寫 username / icon 用）
   - `app_mentions:read`
   - `channels:history`（公開頻道）或 `groups:history`（私人頻道）

2. 安裝 App 到工作區，取得 **Bot User OAuth Token**（`xoxb-...`）填進 secrets。

3. **Event Subscriptions**：
   - 開啟 Enable Events。
   - **Request URL** 填上面那個 Edge Function 網址，Slack 會送 `url_verification`，
     本函式會自動回傳 challenge 通過驗證。
   - **Subscribe to bot events** 新增：`app_mention`
     （若也要支援人類在串內追問，再加 `message.channels` / `message.groups`）。

## 需要人工連的服務（secrets 清單）

以下都要由人去各服務後台拿到金鑰、再設進 Supabase Edge secrets：

- **Slack App**：建立 App、設好 scopes、安裝取得 `SLACK_BOT_TOKEN`，
  以及 Basic Information 的 `SLACK_SIGNING_SECRET`。
- **OpenAI**：`OPENAI_API_KEY`。
- **Anthropic**：`ANTHROPIC_API_KEY`。
- **Supabase**：`SUPABASE_URL` 與 `SUPABASE_SERVICE_KEY`（service_role secret）。

## 安全閥說明

- **MAX_ROUNDS（預設 6）**：兩個模型會互相接話，若不設限會無限對聊。
  達到上限就停止自動接力並貼出提示；人類在串內再回一句即可重新開跑。
- **簽章驗證**：每個請求都用 `SLACK_SIGNING_SECRET` 以 HMAC-SHA256 驗章，
  base string 為 `v0:{timestamp}:{raw_body}`；時間差超過 300 秒視為重放，一律 401。
- **忽略 bot 自己**：凡是帶 `bot_id` 或 `subtype=bot_message` 的事件都略過，
  避免兩個模型互貼造成的無限迴圈。
