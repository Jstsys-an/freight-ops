# Slack 雙模型橋接：GPT ↔ Claude 在討論串對話（MVP）

在 Slack 頻道 `@機器人 題目`，會看到兩個不同名字、不同頭像的回覆：先 **GPT** 回答，再 **Claude** 針對 GPT 的話接話。
整件事只靠一支 Supabase Edge Function 跟兩張小表，不用另外架 server。

---

## 架構圖

```
Slack 頻道
  │  使用者：@bridge 空運跟海運怎麼選？
  ▼
Slack Events API（app_mention）
  │  POST https://<project-ref>.supabase.co/functions/v1/slack-bridge
  ▼
Edge Function: slack-bridge
  ├─ 1. 驗 X-Slack-Signature（HMAC-SHA256，5 分鐘內）
  ├─ 2. slack_events 去重（event_id 撞到就略過）
  ├─ 3. 立刻回 200（Slack 只等 3 秒）
  └─ 4. EdgeRuntime.waitUntil(背景工作)
         ├─ slack_threads upsert（題目、回合上限）
         ├─ OpenAI  ──► chat.postMessage（username: GPT,    icon: GPT_ICON）
         ├─ Anthropic ─► chat.postMessage（username: Claude, icon: CLAUDE_ICON）
         └─ 每則回覆 append 到 slack_threads.turns，turn_count +1
```

相關檔案：

| 檔案 | 用途 |
|---|---|
| `supabase/functions/slack-bridge/index.ts` | 主程式（入口、Slack API、兩個模型、資料庫） |
| `supabase/functions/slack-bridge/verify.ts` | Slack 簽章驗證（純 Web Crypto，可單測） |
| `supabase/functions/slack-bridge/verify_test.ts` | 簽章驗證單元測試 |
| `supabase/functions/slack-bridge/deno.json` | 這支 function 的依賴（Supabase 建議每支 function 各一份） |
| `supabase/migrations/schema-v5-slack-bridge.sql` | `slack_events`、`slack_threads` 兩張表 |
| `.env.example` | 需要的環境變數清單 |

---

## 一、建 Slack App

到 https://api.slack.com/apps → **Create New App** → **From a manifest**，貼下面這份（頻道名稱、App 名稱可改）：

```yaml
display_information:
  name: bridge
  description: GPT 與 Claude 在討論串對話
features:
  bot_user:
    display_name: bridge
    always_online: true
oauth_config:
  scopes:
    bot:
      - app_mentions:read      # 收到被 @ 的事件
      - chat:write             # 發訊息
      - chat:write.customize   # 用自訂名字／頭像發訊息（GPT、Claude 就是靠這個）
settings:
  event_subscriptions:
    request_url: https://<project-ref>.supabase.co/functions/v1/slack-bridge
    bot_events:
      - app_mention
  org_deploy_enabled: false
  socket_mode_enabled: false
  token_rotation_enabled: false
```

建好後要拿兩個值：

| 要拿的值 | 位置 | 對應環境變數 |
|---|---|---|
| Signing Secret | Basic Information → App Credentials | `SLACK_SIGNING_SECRET` |
| Bot User OAuth Token（`xoxb-…`） | OAuth & Permissions → Install to Workspace 之後 | `SLACK_BOT_TOKEN` |

注意：**Request URL 要等 Edge Function 部署好才能存**（Slack 會先打一個 `url_verification` 來握手）。所以順序是：先部署（第二節）→ 再回 Slack 填 Request URL。

---

## 二、部署

### 1. 套 migration

到 Supabase Dashboard → SQL Editor，貼上 `supabase/migrations/schema-v5-slack-bridge.sql` 整段執行（可重複執行）。

### 2. 設定 secrets 並部署

```yaml
# 在 repo 根目錄執行（先 supabase login、supabase link --project-ref <project-ref>）
steps:
  - name: 設定 Edge Function 的環境變數（值不要寫進 repo）
    run: |
      supabase secrets set \
        SLACK_BOT_TOKEN=xoxb-... \
        SLACK_SIGNING_SECRET=... \
        OPENAI_API_KEY=sk-... \
        ANTHROPIC_API_KEY=sk-ant-...
      # 選填（有預設值）：
      # supabase secrets set OPENAI_MODEL=gpt-5.5 ANTHROPIC_MODEL=claude-opus-5-5 \
      #   GPT_ICON=:robot_face: CLAUDE_ICON=:sparkles: BRIDGE_MAX_TURNS=2
      # 或者整包從 .env 推：supabase secrets set --env-file .env

  - name: 部署（--no-verify-jwt：Slack 不會帶 Supabase JWT，改由程式自己驗 Slack 簽章）
    run: supabase functions deploy slack-bridge --no-verify-jwt

  - name: 確認
    run: supabase secrets list
```

另一種寫法是在 `supabase/config.toml` 固定設定，之後部署就不用每次帶旗標：

```toml
[functions.slack-bridge]
verify_jwt = false
```

> `SUPABASE_URL`、`SUPABASE_SERVICE_ROLE_KEY`（新版專案叫 `SUPABASE_SECRET_KEYS`）在 Edge Function 環境內建，不用自己設；程式兩種名稱都會認。

### 3. 回 Slack 填 Request URL

Event Subscriptions → Request URL 填 `https://<project-ref>.supabase.co/functions/v1/slack-bridge`，看到 **Verified** 就完成。若沒通過，先看 `supabase functions logs slack-bridge`，最常見是 `SLACK_SIGNING_SECRET` 貼錯。

---

## 三、測試

1. 把機器人加進頻道（在頻道打 `/invite @bridge`）。
2. 在頻道輸入：`@bridge 空運跟海運怎麼選？`
3. 預期在同一個討論串裡看到兩則回覆：
   - 名字 **GPT**、頭像 `:robot_face:`（或你設的 `GPT_ICON`）
   - 名字 **Claude**、頭像 `:sparkles:`（或你設的 `CLAUDE_ICON`），內容會針對 GPT 的回覆接話
4. 到 Supabase Table Editor 看 `slack_threads`：應有一筆，`turns` 有兩個元素、`turn_count = 2`。
5. 出錯時討論串會出現 `⚠️ bridge 錯誤：<原因>`，細節看 `supabase functions logs slack-bridge`。

### 本機測試（可選）

```yaml
steps:
  - run: deno test supabase/functions/slack-bridge/verify_test.ts     # 簽章驗證單元測試
  - run: deno check supabase/functions/slack-bridge/index.ts          # 型別檢查（需能連 npm registry）
  - run: supabase functions serve slack-bridge --no-verify-jwt --env-file .env
    note: |
      本機 serve 預設回應完就關掉實例，背景工作（EdgeRuntime.waitUntil）會被砍掉。
      要完整跑完請在 supabase/config.toml 加：
        [edge_runtime]
        policy = "per_worker"
```

---

## 四、安全閥

| 機制 | 說明 |
|---|---|
| 只在被 @ 時觸發 | 只訂閱 `app_mention`，頻道裡一般對話完全不會送到 function，也不會花錢。 |
| 每個討論串回合上限 | `slack_threads.max_turns`（建立時取 `BRIDGE_MAX_TURNS`，預設 2 = GPT 一則 + Claude 一則）。達上限後再 @ 會回「已達回合上限」，不再呼叫模型。想在同一串多聊幾輪，調高 `BRIDGE_MAX_TURNS` 或直接改該筆的 `max_turns`。 |
| 忽略機器人訊息 | `event.bot_id` 或 `event.subtype` 存在就略過，避免 GPT/Claude 的訊息（用機器人身分發的）又觸發自己。 |
| 簽章驗證 | 沒有正確 `X-Slack-Signature` 或 timestamp 超過 5 分鐘一律回 401。 |
| 去重 | `X-Slack-Retry-Num` 存在直接回 200；`slack_events.event_id` 撞到也略過。 |
| 回覆長度 | 兩個模型 `max_tokens` 都是 1024，提示詞要求 3 到 6 句，Slack 讀起來不會太長。 |

---

## 五、費用提醒

- 每次 @ 一題 = 1 次 OpenAI 呼叫 + 1 次 Anthropic 呼叫，兩邊都設了低推理強度（`reasoning.effort: low` / `output_config.effort: low`）與 1024 token 上限。
- 預設模型是兩家的旗艦等級，單則回覆費用大約落在幾分到十幾分美金；若要省，改 `OPENAI_MODEL` / `ANTHROPIC_MODEL` 成較小的模型。
- 模型名稱請以官方清單為準：OpenAI https://platform.openai.com/docs/models 、Anthropic https://platform.claude.com/docs/en/about-claude/models 。
- Supabase Edge Function 本身：免費方案每月有呼叫數與執行時間額度，這個用量（人手動 @）幾乎不會碰到。

---

## 六、已知限制與下一步

**已知限制（MVP）**

- 一次 @ 只各回一則，不會自動繼續來回；`max_turns` 預設 2，第二次在同一串 @ 會被安全閥擋下（要多聊請調高）。
- 沒有把 Slack 討論串的歷史訊息餵給模型，只有「題目」與「GPT 的回覆」。
- `OPENAI_MODEL` 預設值 `gpt-5.5` 取自 openai-node 官方 README 的範例（撰寫時官方模型頁無法連線），請依 OpenAI 官方模型清單調整。
- `OPENAI_REASONING_EFFORT` 預設 `low`；若改用不支援 reasoning 參數的模型，把它設成空字串。
- 背景工作上限受 Edge Function 的 wall-clock / CPU 限制，兩個模型各一則通常幾十秒內完成，不會碰到。
- `.github/scripts/backup-export.mjs` 的備份表清單尚未加入 `slack_events`、`slack_threads`（要備份對話紀錄的話再加）。

**下一步**

1. **回合輪替**：讓 Claude 回完後 GPT 再接、一直到 `max_turns`；`turns` 已經把每一棒存下來，只要把 `run()` 改成迴圈、把整段 `turns` 餵給下一個模型即可。
2. **同步到 `agent_alerts`**：每串對話結束時寫一筆摘要進既有的 `agent_alerts`，讓營運畫面看得到 AI 討論結果。
3. **讀討論串上下文**：用 `conversations.replies` 把人類在串裡的追問一起餵給模型（需加 scope `channels:history`）。
4. **前端檢視**：若要在系統畫面看 `slack_threads`，補 RLS select policy（例如 `has_perm('slack.view')`）。
