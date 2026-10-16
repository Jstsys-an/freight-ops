-- ============================================================
-- 貨運行營運系統 v5 — Slack 橋接（兩個 LLM 在同一個 Slack 討論串輪流對話）
-- 在 Supabase SQL Editor 貼上整段執行一次即可（可重複執行，具冪等性）
-- 前置需求：已執行過 schema-v2.sql（profiles / is_active / is_admin / has_perm）
--          與 schema-v3.sql（set_updated_at() / agent_alerts 等）
--
-- 這次建了什麼、為什麼：
-- 1) slack_threads：記錄每一個 Slack 討論串（以 thread_ts 為鍵）的對話狀態——
--    完整訊息歷史（history, JSONB）、輪到誰講（next_turn：'gpt' 或 'claude'）、
--    已來回幾回合（round_count），以及這個串的回合上限（max_rounds）。
--    supabase/functions/slack-bridge Edge Function 用 service_role key 讀寫這張表，
--    service role 會繞過 RLS，所以下面的政策只是把一般使用者擋在外面
--    （比照 schema-v3.sql 的 agent_alerts：只有 admin 能從前台看，service role 照常讀寫）。
-- 2) 回合上限（max_rounds）是安全閥：兩個 LLM 會互相 @ 對方，若不設限會無限對話、
--    一直消耗 API 額度。Edge Function 數到上限就停手、改貼一則「回合上限已達」通知。
-- ============================================================

-- ---------- 1. slack_threads（Slack 討論串對話狀態） ----------
create table if not exists public.slack_threads (
  id uuid primary key default gen_random_uuid(),
  thread_ts text not null unique,            -- Slack 討論串根訊息的 ts，當作這個串的唯一鍵
  channel_id text not null,                  -- 這個串所在的頻道 / DM id
  history jsonb not null default '[]'::jsonb,-- 訊息歷史：[{ role, name, content }, ...]
  next_turn text not null default 'gpt'      -- 下一個該回話的模型
    check (next_turn in ('gpt','claude')),
  round_count int not null default 0,        -- 已經來回幾回合（GPT→Claude 算一回合）
  max_rounds int not null default 6,         -- 這個串的回合上限（安全閥，可逐串覆寫）
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.slack_threads enable row level security;

create index if not exists slack_threads_channel_id_idx
  on public.slack_threads (channel_id);

-- updated_at 自動更新（沿用 schema-v3.sql 建好的 set_updated_at()）
drop trigger if exists slack_threads_set_updated_at on public.slack_threads;
create trigger slack_threads_set_updated_at
  before update on public.slack_threads
  for each row execute function public.set_updated_at();

-- ---------- 2. RLS 政策 ----------
-- Edge Function 走 service_role key，service role 會繞過 RLS，所以不需要替它開政策。
-- 這裡只替「前台一般使用者」設限：比照 agent_alerts，只有 admin 能看，一般使用者寫不進去。
drop policy if exists slack_threads_select on public.slack_threads;
create policy slack_threads_select on public.slack_threads
  for select using (public.is_admin());

drop policy if exists slack_threads_update on public.slack_threads;
create policy slack_threads_update on public.slack_threads
  for update using (public.is_admin()) with check (public.is_admin());

drop policy if exists slack_threads_delete on public.slack_threads;
create policy slack_threads_delete on public.slack_threads
  for delete using (public.is_admin());
