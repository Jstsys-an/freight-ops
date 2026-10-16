# Slack channel isolation regression

Use a disposable/local PostgreSQL or Supabase database with the existing schema
prerequisites and migrations v5 and v6 installed. Never point these commands at
production. Run as the database owner (the test also inspects fixture rows).

```sh
psql "$TEST_DATABASE_URL" -X -v ON_ERROR_STOP=1 -f supabase/migrations/schema-v7-slack-channel-isolation.sql
# Rerun to exercise migration idempotence.
psql "$TEST_DATABASE_URL" -X -v ON_ERROR_STOP=1 -f supabase/migrations/schema-v7-slack-channel-isolation.sql
psql "$TEST_DATABASE_URL" -X -v ON_ERROR_STOP=1 -f supabase/tests/slack-channel-isolation.sql
```

The SQL test uses randomized channel IDs and rolls back all fixtures. It raises
an exception (nonzero psql exit) on failure. It exercises the actual RPCs rather
than a JavaScript model of their behavior:

- An idle thread in A does not opt channel B into the bridge.
- Identical timestamps can create two distinct rows with independent limits/history.
- Repeated mentions in one channel retain a single row and its configured limit.
- Locks, busy/capped/missing results, and stale-lock recovery stay channel-scoped.
- Append-by-UUID updates only the target history, turn, and round count.

Without v7, the first missing-channel assertion fails against v6.

## Deployment note

This change requires applying v7 after v6; changing historical migration files
alone would not repair installed databases. Existing row IDs, histories, RLS and
RPC execution privileges are preserved. The RPC arguments/return format are
unchanged, so no Edge Function code change is required.

For an approved rollout, pause/drain bridge processing before applying v7 so an
in-flight worker cannot continue using a row acquired by the old function.
Apply v7 as one transaction, then resume processing. If earlier migrations are
rerun, apply v7 last: v6 recreates the old function. This migration does not
attempt to identify or repair any previously mixed histories.

Verification of this patch must include running the commands above before merge.
A source inspection is not a PostgreSQL runtime test.
