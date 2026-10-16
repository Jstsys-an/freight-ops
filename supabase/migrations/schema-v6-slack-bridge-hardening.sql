-- ============================================================
-- 貨運行營運系統 v6 — Slack 橋接強化（去重、跨實例鎖、原子 append）
-- 在 Supabase SQL Editor 貼上整段執行一次即可（可重複執行，具冪等性）
-- 前置需求：已執行過 schema-v5-slack.sql（建 slack_threads）
--
-- 這次建了什麼、為什麼：
-- 1) slack_events：Slack 每個事件都有 event_id，Slack 3 秒沒收到 200 會重送、同一則 @
--    訊息也可能同時以 app_mention 與 message 兩個事件送來。Edge Function 收到事件先
--    insert 這張表（event_id 與 msg:<channel>:<ts> 各一筆），撞到 primary key 就代表處理過，
--    直接略過，避免同一題被回兩次。
-- 2) slack_threads.processing_since：跨實例鎖。Edge Function 可能同時有多個實例在跑，
--    若兩個實例同時讀到同一串的狀態、各自呼叫模型，round_count 會互相覆蓋、回合上限失效。
--    所以改成「先在 DB 端用一道 update 搶到處理權（slack_thread_acquire），搶到才叫模型」；
--    流程結束（含錯誤）把 processing_since 清回 null。超過 10 分鐘沒清（實例被砍）視為過期，
--    可以被重新搶走。
-- 3) slack_thread_append：把「append 一則到 history、翻 next_turn、round_count +1」做成
--    一道 update，避免讀-改-寫之間被別人插隊。
-- 4) RLS：slack_events 開 RLS、不建 policy（只有 service role 能碰）；
--    兩個 function 只授權 service_role 執行，前端 anon / authenticated 叫不到。
-- ============================================================

-- ---------- 1. slack_events（事件去重） ----------
create table if not exists public.slack_events (
  event_id text primary key,                 -- Slack event_id，或 msg:<channel>:<ts>
  received_at timestamptz not null default now()
);
alter table public.slack_events enable row level security;
-- 開了 RLS 又沒有任何 policy = 預設全部拒絕；service role 不受 RLS 限制，只有 Edge Function 能讀寫。

-- ---------- 2. slack_threads 加鎖欄位 ----------
alter table public.slack_threads
  add column if not exists processing_since timestamptz;  -- null = 沒人在處理

comment on column public.slack_threads.processing_since is
  'Edge Function 取得處理權的時間；null 代表閒置。超過 10 分鐘視為過期鎖，可被重新取得。';

-- ---------- 3. slack_thread_acquire：搶處理權（跨實例鎖） ----------
-- 回傳 jsonb：{ status: 'acquired' | 'busy' | 'capped' | 'missing', thread: <slack_threads 列> }
--   acquired：搶到了，thread 是最新狀態，呼叫端要負責在結束時把 processing_since 清回 null
--   busy    ：別的實例正在處理（鎖未過期）
--   capped  ：round_count 已達 max_rounds
--   missing ：串不存在且 p_create = false（不是被 @ 的訊息，不開新串）
create or replace function public.slack_thread_acquire(
  p_channel    text,
  p_thread_ts  text,
  p_max_rounds int,
  p_create     boolean
)
returns jsonb
language plpgsql
as $$
declare
  v_row public.slack_threads;
begin
  if p_create then
    insert into public.slack_threads (thread_ts, channel_id, max_rounds)
    values (p_thread_ts, p_channel, greatest(coalesce(p_max_rounds, 6), 1))
    on conflict (thread_ts) do nothing;
  end if;

  -- 關鍵的一道 update：鎖沒人拿（或已過期）且還沒到上限，才拿得到。
  update public.slack_threads
     set processing_since = now()
   where thread_ts = p_thread_ts
     and (processing_since is null or processing_since < now() - interval '10 minutes')
     and round_count < max_rounds
  returning * into v_row;

  if found then
    return jsonb_build_object('status', 'acquired', 'thread', to_jsonb(v_row));
  end if;

  select * into v_row from public.slack_threads where thread_ts = p_thread_ts;
  if not found then
    return jsonb_build_object('status', 'missing');
  end if;
  if v_row.round_count >= v_row.max_rounds then
    return jsonb_build_object('status', 'capped', 'thread', to_jsonb(v_row));
  end if;
  return jsonb_build_object('status', 'busy', 'thread', to_jsonb(v_row));
end;
$$;

-- ---------- 4. slack_thread_append：原子 append + 翻 next_turn + round_count ----------
-- p_turn   ：{ speaker: 'human' | 'gpt' | 'claude', content: text }
-- p_advance：true = 這是模型的發言，翻到下一位；從 'claude' 翻回 'gpt' 代表一回合結束，round_count +1
--            false = 人類的發言，只 append、不翻
-- 回傳更新後的整列（jsonb）。
create or replace function public.slack_thread_append(
  p_id      uuid,
  p_turn    jsonb,
  p_advance boolean default false
)
returns jsonb
language plpgsql
as $$
declare
  v_row public.slack_threads;
begin
  update public.slack_threads
     set history     = history || jsonb_build_array(p_turn),
         next_turn   = case
                         when p_advance and next_turn = 'gpt' then 'claude'
                         when p_advance then 'gpt'
                         else next_turn
                       end,
         round_count = case
                         when p_advance and next_turn = 'claude' then round_count + 1
                         else round_count
                       end
   where id = p_id
  returning * into v_row;

  if not found then
    raise exception 'slack_threads % 不存在', p_id;
  end if;
  return to_jsonb(v_row);
end;
$$;

-- ---------- 5. 權限：兩個 function 只給 service_role ----------
revoke all on function public.slack_thread_acquire(text, text, int, boolean) from public, anon, authenticated;
revoke all on function public.slack_thread_append(uuid, jsonb, boolean)      from public, anon, authenticated;
grant execute on function public.slack_thread_acquire(text, text, int, boolean) to service_role;
grant execute on function public.slack_thread_append(uuid, jsonb, boolean)      to service_role;

-- ---------- 6. 清理（可選）：slack_events 只是去重用，保留 7 天就夠 ----------
-- 若已啟用 pg_cron（schema-v4 的保活排程已用到），可打開下面這段：
-- select cron.schedule(
--   'slack_events_cleanup',
--   '30 19 * * *',  -- 每天 UTC 19:30（台灣 03:30）
--   $$ delete from public.slack_events where received_at < now() - interval '7 days' $$
-- );
