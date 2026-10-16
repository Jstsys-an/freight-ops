-- ============================================================
-- 貨運行營運系統 v5 — Slack 雙模型橋接（GPT ↔ Claude 接力）
-- 在 Supabase SQL Editor 貼上整段執行一次即可（可重複執行，具冪等性）
-- 前置需求：已執行過 schema-v2.sql（profiles / is_active / is_admin / has_perm）
--          與 schema-v3.sql（set_updated_at 等）
--
-- 這次建了什麼、為什麼：
-- 1) slack_threads：記錄每一條被 @app_mention 叫醒的 Slack 討論串。
--    橋接的 Edge Function（supabase/functions/slack-bridge）用這張表
--    保存整串對話歷史（history）、現在輪到哪一邊講（next_turn），
--    以及已經接力幾次（round_count）。兩個模型會互相回話，所以要有
--    一個安全閥 max_rounds，避免 GPT 跟 Claude 無限對聊。
-- 2) RLS：這張表只由 Edge Function 以 service_role 金鑰讀寫（service_role
--    會略過 RLS），所以一般使用者沒有寫入政策；僅開放 admin 唯讀查看，
--    方便在後台稽核對話內容。沿用 schema-v2.sql 的 is_admin() 機制。
-- ============================================================

-- ---------- 1. slack_threads（Slack 討論串對話狀態） ----------
create table if not exists public.slack_threads (
  thread_ts   text primary key,                       -- Slack 討論串根訊息的 ts，當主鍵
  channel     text not null,                          -- 所在頻道 ID
  history     jsonb not null default '[]'::jsonb,     -- 對話歷史：[{role, name, text}, ...]
  next_turn   text not null default 'gpt'             -- 下一句換誰講：'gpt' 或 'claude'
                check (next_turn in ('gpt','claude')),
  round_count int not null default 0,                 -- 已接力的模型回覆數（安全閥用）
  max_rounds  int not null default 6,                 -- 本串的接力上限（可逐串覆寫）
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
alter table public.slack_threads enable row level security;

create index if not exists slack_threads_channel_idx
  on public.slack_threads (channel);
create index if not exists slack_threads_updated_at_idx
  on public.slack_threads (updated_at);

-- updated_at 自動更新（沿用 schema-v3.sql 的 set_updated_at()）
drop trigger if exists slack_threads_set_updated_at on public.slack_threads;
create trigger slack_threads_set_updated_at
  before update on public.slack_threads
  for each row execute function public.set_updated_at();

-- ---------- 2. RLS 政策 ----------
-- 寫入（insert/update/delete）全部交給 Edge Function 的 service_role 金鑰，
-- service_role 會略過 RLS，因此這裡不開放一般使用者寫入。
-- 僅提供 admin 唯讀，方便後台稽核。
drop policy if exists slack_threads_select on public.slack_threads;
create policy slack_threads_select on public.slack_threads
  for select using (public.is_admin());
