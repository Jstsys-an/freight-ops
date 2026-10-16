-- Run only against a disposable/local database with schema v5, v6 and v7 applied.
-- psql "$TEST_DATABASE_URL" -X -v ON_ERROR_STOP=1 -f supabase/tests/slack-channel-isolation.sql
-- Every fixture is rolled back; an assertion raises an exception and exits nonzero.
begin;

do $test$
declare
  channel_a text := 'test-a-' || gen_random_uuid()::text;
  channel_b text := 'test-b-' || gen_random_uuid()::text;
  channel_c text := 'test-c-' || gen_random_uuid()::text;
  shared_ts text := '1700000000.000001';
  a jsonb;
  b jsonb;
  result jsonb;
  before_a jsonb;
  a_id uuid;
  b_id uuid;
begin
  -- A pre-existing conversation must not opt another channel into the bridge.
  a := public.slack_thread_acquire(channel_a, shared_ts, 2, true);
  if a->>'status' is distinct from 'acquired'
     or a#>>'{thread,channel_id}' is distinct from channel_a then
    raise exception 'A should acquire its own thread: %', a;
  end if;
  a_id := (a#>>'{thread,id}')::uuid;
  perform public.slack_thread_append(a_id, '{"speaker":"human","content":"A only"}', false);
  update public.slack_threads set processing_since = null where id = a_id;
  select to_jsonb(t) into before_a from public.slack_threads t where id = a_id;

  result := public.slack_thread_acquire(channel_b, shared_ts, 6, false);
  if result is distinct from '{"status":"missing"}'::jsonb then
    raise exception 'Non-mention in B must be missing even when A is idle: %', result;
  end if;
  if (select to_jsonb(t) from public.slack_threads t where id = a_id) is distinct from before_a then
    raise exception 'Missing lookup in B changed A';
  end if;

  -- Mention in B must create a separate row despite the identical timestamp.
  b := public.slack_thread_acquire(channel_b, shared_ts, 3, true);
  b_id := (b#>>'{thread,id}')::uuid;
  if b->>'status' is distinct from 'acquired'
     or b#>>'{thread,channel_id}' is distinct from channel_b
     or b_id is null or b_id = a_id
     or b#>'{thread,history}' is distinct from '[]'::jsonb
     or b#>>'{thread,max_rounds}' is distinct from '3' then
    raise exception 'B must acquire an independent empty conversation: %', b;
  end if;
  if (select to_jsonb(t) from public.slack_threads t where id = a_id) is distinct from before_a then
    raise exception 'Creating B changed A';
  end if;

  -- Same-channel conflict must not create a duplicate or change configured limits.
  result := public.slack_thread_acquire(channel_b, shared_ts, 99, true);
  if result->>'status' is distinct from 'busy'
     or result#>>'{thread,id}' is distinct from b_id::text
     or result#>>'{thread,max_rounds}' is distinct from '3' then
    raise exception 'Repeated B mention must return its busy row: %', result;
  end if;
  if (select count(*) from public.slack_threads
      where channel_id = channel_b and thread_ts = shared_ts) <> 1 then
    raise exception 'Duplicate same-channel thread';
  end if;

  -- A can acquire while B is locked: the lock/update and history are channel-scoped.
  result := public.slack_thread_acquire(channel_a, shared_ts, 6, false);
  if result->>'status' is distinct from 'acquired'
     or result#>>'{thread,id}' is distinct from a_id::text
     or result#>'{thread,history}' is distinct from '[{"speaker":"human","content":"A only"}]'::jsonb then
    raise exception 'A should retain its own history while B is busy: %', result;
  end if;
  result := public.slack_thread_acquire(channel_a, shared_ts, 6, false);
  if result->>'status' is distinct from 'busy'
     or result#>>'{thread,id}' is distinct from a_id::text then
    raise exception 'Same-channel lock must still work: %', result;
  end if;

  -- Existing UUID-based append remains isolated, including turn/round accounting.
  perform public.slack_thread_append(b_id, '{"speaker":"gpt","content":"B GPT"}', true);
  result := public.slack_thread_append(b_id, '{"speaker":"claude","content":"B Claude"}', true);
  if result->>'round_count' is distinct from '1'
     or result->>'next_turn' is distinct from 'gpt'
     or jsonb_array_length(result->'history') <> 2
     or (select history from public.slack_threads where id = a_id)
        is distinct from '[{"speaker":"human","content":"A only"}]'::jsonb
     or (select round_count from public.slack_threads where id = a_id) <> 0 then
    raise exception 'Appending B must not affect A: %', result;
  end if;

  -- Distinguish busy and capped for two rows with the same timestamp.
  update public.slack_threads set round_count = max_rounds, processing_since = null where id = a_id;
  result := public.slack_thread_acquire(channel_a, shared_ts, 99, true);
  if result->>'status' is distinct from 'capped'
     or result#>>'{thread,id}' is distinct from a_id::text then
    raise exception 'A should be capped: %', result;
  end if;
  result := public.slack_thread_acquire(channel_b, shared_ts, 6, false);
  if result->>'status' is distinct from 'busy'
     or result#>>'{thread,id}' is distinct from b_id::text then
    raise exception 'A cap must not hide B busy state: %', result;
  end if;
  result := public.slack_thread_acquire(channel_c, shared_ts, 6, false);
  if result is distinct from '{"status":"missing"}'::jsonb then
    raise exception 'Unknown channel must not receive busy/capped row or history: %', result;
  end if;

  -- Stale lock recovery still applies to exactly the requested channel.
  select to_jsonb(t) into before_a from public.slack_threads t where id = a_id;
  update public.slack_threads set processing_since = now() - interval '11 minutes' where id = b_id;
  result := public.slack_thread_acquire(channel_b, shared_ts, 6, false);
  if result->>'status' is distinct from 'acquired'
     or result#>>'{thread,id}' is distinct from b_id::text
     or result#>>'{thread,round_count}' is distinct from '1' then
    raise exception 'B should recover its stale lock: %', result;
  end if;
  if (select to_jsonb(t) from public.slack_threads t where id = a_id) is distinct from before_a then
    raise exception 'Recovering B changed A';
  end if;
end;
$test$;

rollback;
