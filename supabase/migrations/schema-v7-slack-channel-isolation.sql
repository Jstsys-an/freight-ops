-- v7: Slack timestamps identify messages within a channel, not globally.
-- Apply after schema-v6-slack-bridge-hardening.sql. Safe to run again.
-- Keep the index/constraint/function change atomic; existing rows and UUIDs stay intact.
begin;

create unique index if not exists slack_threads_channel_thread_ts_key
  on public.slack_threads (channel_id, thread_ts);

alter table public.slack_threads
  drop constraint if exists slack_threads_thread_ts_key;

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
    on conflict (channel_id, thread_ts) do nothing;
  end if;

  -- 關鍵的一道 update：鎖沒人拿（或已過期）且還沒到上限，才拿得到。
  update public.slack_threads
     set processing_since = now()
   where channel_id = p_channel
     and thread_ts = p_thread_ts
     and (processing_since is null or processing_since < now() - interval '10 minutes')
     and round_count < max_rounds
  returning * into v_row;

  if found then
    return jsonb_build_object('status', 'acquired', 'thread', to_jsonb(v_row));
  end if;

  select * into v_row from public.slack_threads
   where channel_id = p_channel and thread_ts = p_thread_ts;
  if not found then
    return jsonb_build_object('status', 'missing');
  end if;
  if v_row.round_count >= v_row.max_rounds then
    return jsonb_build_object('status', 'capped', 'thread', to_jsonb(v_row));
  end if;
  return jsonb_build_object('status', 'busy', 'thread', to_jsonb(v_row));
end;
$$;

-- CREATE OR REPLACE preserves the v6 function owner and execution privileges.
-- No RLS policies, grants, or append/release-by-UUID behavior are changed.
commit;
