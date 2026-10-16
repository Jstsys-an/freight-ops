-- ============================================================
-- 貨運行營運系統 v5 — Slack 雙模型橋接（GPT ↔ Claude）
-- 在 Supabase SQL Editor 貼上整段執行一次即可（可重複執行，具冪等性）
-- 前置需求：已執行過 full-schema.sql（需要 public.set_updated_at()）
--
-- 這次建了什麼、為什麼：
-- 1) slack_events：Slack 每個事件都有 event_id，Slack 會重送、也可能同一事件
--    從不同連線各送一次。Edge Function 收到事件先 insert 這張表，撞到
--    primary key 就代表處理過，直接略過，避免同一題被回兩次。
-- 2) slack_threads：每個 Slack 討論串一筆，記題目、每一則 AI 回覆（turns JSONB）、
--    目前回合數、回合上限。回合上限是安全閥，避免兩個模型互相接話接不完、
--    把 API 費用燒掉。之後要做「回合輪替」或「同步到 agent_alerts」都從這張表接。
-- 3) RLS：兩張表都開 RLS、但不建任何 policy。意思是：前端（anon / 登入使用者）
--    完全讀不到、寫不到；只有 Edge Function 用 service role key 才能操作。
--    這兩張表是機器人的內部帳本，不是給畫面用的。
-- ============================================================

-- ---------- 1. slack_events（事件去重） ----------
create table if not exists public.slack_events (
  event_id text primary key,
  received_at timestamptz not null default now()
);
alter table public.slack_events enable row level security;

-- ---------- 2. slack_threads（每個討論串的對話紀錄與安全閥） ----------
create table if not exists public.slack_threads (
  id uuid primary key default gen_random_uuid(),
  channel text not null,
  thread_ts text not null,
  topic text not null default '',
  turns jsonb not null default '[]'::jsonb,   -- [{speaker:'GPT'|'Claude', text, ts}, ...]
  turn_count int not null default 0,
  max_turns int not null default 2,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (channel, thread_ts)
);
alter table public.slack_threads enable row level security;

drop trigger if exists slack_threads_set_updated_at on public.slack_threads;
create trigger slack_threads_set_updated_at
  before update on public.slack_threads
  for each row execute function public.set_updated_at();

-- ---------- 3. RLS 政策：刻意不建 ----------
-- 開了 RLS 又沒有任何 policy = 預設全部拒絕；service role 不受 RLS 限制，
-- 所以只有 Edge Function（用 SUPABASE_SERVICE_ROLE_KEY）能讀寫。
-- 之後若要在前端畫面顯示對話紀錄，再補 select policy（例如 has_perm('slack.view')）。

-- ---------- 4. 清理（可選）：slack_events 只是去重用，保留 7 天就夠 ----------
-- 若已啟用 pg_cron（schema-v4 的保活排程已用到），可打開下面這段：
-- select cron.schedule(
--   'slack_events_cleanup',
--   '30 19 * * *',  -- 每天 UTC 19:30（台灣 03:30）
--   $$ delete from public.slack_events where received_at < now() - interval '7 days' $$
-- );
