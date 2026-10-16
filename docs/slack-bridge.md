# Slack bridge：兩個 LLM 在 Slack 討論串輪流對話

讓 OpenAI（顯示為 **GPT**）與 Anthropic（顯示為 **Claude**）在同一個 Slack 討論串裡一來一回地對話，背後是一支 Supabase Edge Function（`supabase/functions/slack-bridge`）。

```
Slack 討論串 ──(@機器人)──▶ Edge Function ──▶ 讀 slack_threads 狀態
                                     │
                     ┌───────────────┴───────────────┐
                 OpenAI（GPT）                 Anthropic（Claude）
                     └───────────────┬───────────────┘
                                     ▼
                         chat.postMessage 貼回同一串
                         （每句都寫回 slack_threads）
```

- 只在「被 @ 提到機器人」的討論串裡運作；忽略機器人自己與其他 bot 的訊息（防無限迴圈）。
- **安全閥**：每個討論串有回合上限（`MAX_ROUNDS`，預設 6）。數到上限就停手、改貼一則「回合上限已達」通知，不會無限對話、無限燒 API 額度。

> 下列密鑰一律由你（使用者）自行設定，**絕不會**放進這個 repo 或任何 commit。

---

## 1. 建資料表

在 Supabase SQL Editor 執行 `supabase/migrations/schema-v5-slack.sql`（可重複執行，具冪等性）。它會建立 `slack_threads` 表，記錄每個討論串的對話歷史、輪到誰、已幾回合。

## 2. 建 Slack App 並設定 OAuth scopes

到 <https://api.slack.com/apps> 建立 App，於 **OAuth & Permissions → Scopes → Bot Token Scopes** 加入：

| Scope | 用途 |
| --- | --- |
| `chat:write` | 貼訊息 |
| `chat:write.customize` | 用 `username` + `icon_emoji` 讓 GPT／Claude 顯示成不同身分 |
| `app_mentions:read` | 收到「被 @ 提到」事件 |
| `channels:history` | 讀公開頻道討論串訊息（私密頻道改用 `groups:history`） |

安裝 App 到工作區後，複製 **Bot User OAuth Token**（`xoxb-...`）當作 `SLACK_BOT_TOKEN`，並到 **Basic Information → App Credentials** 複製 **Signing Secret** 當作 `SLACK_SIGNING_SECRET`。

## 3. 部署 Edge Function

```bash
supabase functions deploy slack-bridge
```

部署後函式網址長這樣（`<ref>` 是你的專案代號）：

```
https://<ref>.functions.supabase.co/slack-bridge
```

## 4. 設定 Supabase Edge Secrets

函式只從環境變數讀密鑰，程式裡不寫死任何值。用 `supabase secrets set` 設定（變數名稱見 `.env.example`）：

```bash
supabase secrets set \
  SLACK_BOT_TOKEN=xoxb-你的-token \
  SLACK_SIGNING_SECRET=你的-signing-secret \
  OPENAI_API_KEY=sk-你的-openai-key \
  OPENAI_MODEL=gpt-4o \
  ANTHROPIC_API_KEY=sk-ant-你的-anthropic-key \
  ANTHROPIC_MODEL=claude-sonnet-4-5 \
  MAX_ROUNDS=6 \
  SUPABASE_URL=https://<ref>.supabase.co \
  SUPABASE_SERVICE_KEY=你的-service_role-secret
```

- `OPENAI_MODEL`、`ANTHROPIC_MODEL`、`MAX_ROUNDS` 都可視需要調整；不設的話程式內建預設值為
  `gpt-4o`、`claude-sonnet-4-5`、`6`。
- `SUPABASE_SERVICE_KEY` 是 service_role secret（Project Settings → API），會繞過 RLS，
  只設在 Edge Secrets，**不要**提交或外流。

## 5. 設定 Event Subscriptions

在 Slack App 的 **Event Subscriptions**：

1. 開啟 Enable Events。
2. **Request URL** 填上面的函式網址。Slack 會送一個 `url_verification` 挑戰，函式會自動回覆
   `challenge`，顯示 **Verified** 即成功。
3. 於 **Subscribe to bot events** 加入 `app_mention`（需要時再加 `message.channels`）。
4. 儲存後重新安裝 App 讓 scope 生效。

---

## 使用方式

在任一討論串 @ 機器人並說一句話，GPT 與 Claude 就會開始輪流接話，貼在同一串裡，直到達到
`MAX_ROUNDS` 回合上限才停止。

## 安全與額度提醒

- **回合上限是安全閥**：兩個 LLM 會互相接話，若不設限會無限對話、一直消耗 OpenAI／Anthropic 額度。
  到達 `MAX_ROUNDS` 就會自動停手並貼通知。要繼續請調高 `MAX_ROUNDS` 或重開新討論串。
- 函式會用 `SLACK_SIGNING_SECRET` 驗證每個請求的簽章，並拒絕時間戳超過 5 分鐘的請求（擋重放）。
- 所有密鑰都存在 Supabase Edge Secrets，不在本 repo 裡；`.env` 已被 `.gitignore` 排除。
