# External webhook subscriber runbook

Operator runbook for wiring an **external system** to own conversation logic
on top of Wakit's messaging infrastructure. The pattern uses only existing
Wakit primitives — no new schema, no code changes required.

## How the pattern works

1. Inbound WhatsApp messages land in `public.messages` via
   `whatsapp-webhook`.
2. A `public.webhooks` row scoped to `(organization_id, organization_address,
   table_name='messages')` fans the new row out to the external subscriber
   via `notify_webhook()`.
3. The external subscriber composes a reply (using its own logic / LLM /
   tools / conversation state) and posts it back via PostgREST into
   `public.messages` with `agent_id = NULL`.
4. `pause_conversation_on_human_message` fires on that insert and refreshes
   `conversations.extra.paused`, suppressing Wakit's built-in `agent-client`
   on subsequent inbounds (gate 3 in
   `supabase/functions/agent-client/index.ts:188`).
5. For the very first inbound (before `extra.paused` is set), the
   organization must have **zero active AI agents** so that `agent-client`'s
   no-AI-agents short-circuit fires (gate 6 in
   `supabase/functions/agent-client/index.ts:304-315`). Both gates are
   load-bearing on different message events.
6. `whatsapp-dispatcher` continues to handle outbound delivery to Meta — the
   external subscriber writes the row, the dispatcher sends it.

## Prerequisites

Collect these values before running anything below. Stash them in your
secrets vault.

| Var | Description | Source |
|---|---|---|
| `ORG_ID` | UUID of the target organization in Wakit | `select id from public.organizations where name = '<org-name>'` |
| `ORG_ADDRESS` | WhatsApp `phone_number_id` for the org | `select address from public.organizations_addresses where organization_id = :ORG_ID and service = 'whatsapp'` |
| `SUBSCRIBER_WEBHOOK_URL` | Endpoint the external subscriber exposes for inbound events | Subscriber's own configuration |
| `WEBHOOK_BEARER_TOKEN` | Token the subscriber validates on incoming POSTs | Generate (e.g. `openssl rand -base64 32`); share via secrets vault |
| `SUBSCRIBER_API_KEY` | Wakit `api_keys.key` the subscriber uses for outbound writes | Provision a row in `api_keys` (role `member` or higher) before go-live |
| `SUPABASE_URL` | Project URL for the target env (dev or prod) | Supabase dashboard |
| `SUPABASE_SERVICE_ROLE_KEY` | Service-role (secret) key for the target env | Supabase dashboard → Project Settings → API Keys |

## How to substitute the `:VAR` placeholders below

Each SQL block below uses `psql`-style `:VAR` placeholders.

- **Option A — `psql -v`**: write the block to a `.sql` file and run

  ```bash
  psql "$DATABASE_URL" \
    -v ORG_ID="'<uuid>'" \
    -v ORG_ADDRESS="'<addr>'" \
    -v SUBSCRIBER_WEBHOOK_URL="'<url>'" \
    -v WEBHOOK_BEARER_TOKEN="'<token>'" \
    -v SUBSCRIBER_API_KEY="'<key>'" \
    -f step-N.sql
  ```

  Note the **single-quote wrapping** for UUID and text values — `psql -v` does
  textual substitution and does **not** auto-quote.

- **Option B — Supabase SQL editor**: copy the block into the SQL editor and
  use find-replace to substitute each `:VAR` token by hand. This is the
  pragmatic path for one-off cutovers.

The runbook is **operated, not scripted** — explicit substitution is
acceptable.

## Pre-cutover snapshot

Run this **before** any of the steps below, against the same env you're about
to mutate. Save the output to your secrets vault — the rollback procedure
depends on it.

```sql
-- Snapshot the current AI-agent posture so rollback can restore it.
select id, name, picture, ai, extra, created_at
from public.agents
where organization_id = :ORG_ID
  and ai = true;
```

## Step 1 — Confirm zero active AI agents

`agent-client`'s gate 6 short-circuits when the org has no active AI agents.
This is the **primary** suppression mechanism for the first inbound message
(before `extra.paused` is set). It must return `0`:

```sql
-- Must return 0
select count(*) from public.agents
where organization_id = :ORG_ID
  and ai = true
  and coalesce(extra->>'mode', 'active') <> 'inactive';
```

If non-zero, either:

- Delete the rows: `delete from public.agents where id = :AGENT_ID;`, **or**
- Mark them inactive via the wakit-ui editor: navigate to
  `Settings → AI Agents → <agent>` and set the agent's mode to `inactive`
  (this writes `extra->>'mode' = 'inactive'`).

Re-run the count query and confirm `0` before moving on.

## Step 2 — Insert the webhook row

```sql
insert into public.webhooks (
  organization_id,
  organization_address,
  table_name,
  operations,
  url,
  token
)
values (
  :ORG_ID,
  :ORG_ADDRESS,                  -- NULL if the org has only one address and you want catch-all
  'messages',
  array['insert','update']::public.webhook_operation[],
  :SUBSCRIBER_WEBHOOK_URL,
  :WEBHOOK_BEARER_TOKEN
);
```

**UI alternative**: `Settings → Webhooks → Add`, fill URL, table = `messages`,
operations = `insert + update`, token, `organization_address`. Leaving
`organization_address` empty preserves catch-all behavior (the form sanitizes
`""` → `NULL`).

> [!IMPORTANT]
> `notify_webhook()` has no `direction` filter, so the external subscriber
> will receive webhook POSTs for the outbound rows it inserts itself. The
> subscriber MUST dedupe by `data.direction === 'outgoing'` and discard its
> own echoes — otherwise it will loop on every reply it sends.

## Step 3 — Verify the API key

The subscriber's API key must already exist for the org. Provision a row in
`public.api_keys` with `role >= 'member'` before go-live and verify with:

```sql
select id, role, name from public.api_keys
where organization_id = :ORG_ID
  and key = :SUBSCRIBER_API_KEY;
-- Expected: 1 row, role in {'member','admin','owner'}.
```

If `0` rows: the key isn't provisioned. Stop and provision it before
continuing. The subscriber's outbound writes will 401 otherwise.

## Step 4 — Smoke test (preflight script)

Read-only check against the deployed env. Confirms steps 1–3 actually
landed:

```bash
SUPABASE_URL=<env> \
SUPABASE_SERVICE_ROLE_KEY=<env> \
ORG_ID=<uuid> \
ORG_ADDRESS=<phone_number_id> \
SUBSCRIBER_WEBHOOK_URL=<url> \
deno run --allow-env --allow-net scripts/external-subscriber-preflight.ts
```

Expected output:

```
PASS preflight ✔
```

…plus a printed summary of the webhook row + agent posture + API-key count.

On `FAIL`, the script prints the specific assertion that failed and exits
with status `1`. Fix the underlying state and re-run.

## Step 5 — Real WhatsApp smoke (manual, dev/staging only)

**Do not run this in prod** without explicit cutover sign-off.

Send a message to the org's WhatsApp number from a test phone. Within ~10
seconds you should observe:

1. **The subscriber logs the inbound** — check the subscriber's own
   observability.
2. **No Wakit reply** — query the latest `public.messages` row:
   ```sql
   select id, direction, agent_id, "timestamp"
   from public.messages
   where conversation_id = (
     select id from public.conversations
     where organization_id = :ORG_ID
     order by updated_at desc limit 1
   )
   order by "timestamp" desc limit 5;
   ```
   You should see the `incoming` row, and **no `outgoing` row** until the
   subscriber replies.
3. **After the subscriber replies**, `extra.paused` is stamped:
   ```sql
   select extra->>'paused' as paused_at
   from public.conversations
   where id = <conversation_id>;
   ```
   `paused_at` should be an ISO timestamp within the last minute.

If step 2 shows an `outgoing` row with a non-null `agent_id` (i.e. Wakit
replied), either gate 6 (no AI agents) or gate 3 (paused) failed. Re-run the
preflight script to diagnose.

## Rollback

Two-step rollback. **Step 1** detaches the subscriber. **Step 2** restores
the AI-agent posture from the snapshot you took above.

```sql
-- 1. Detach the subscriber from inbound flow:
delete from public.webhooks
where organization_id = :ORG_ID
  and url = :SUBSCRIBER_WEBHOOK_URL;

-- 2. Restore the AI-agent posture from the snapshot (manual — re-insert each row):
--    Re-create each agent from the snapshot you took at "Pre-cutover snapshot":
--      insert into public.agents (id, organization_id, name, picture, ai, extra, created_at)
--      values (...the snapshotted values...);
--    OR, if Step 1 only set extra->>'mode'='inactive' (didn't delete), restore via:
--      update public.agents set extra = extra - 'mode' where id = :SNAPSHOTTED_AGENT_ID;
```

If no AI agents existed pre-cutover, after the rollback inbound messages
will sit unanswered until manual intervention — that is the **steady state**
for an org with no active AI agents and no external subscriber.

## References

- Webhooks schema: `supabase/schemas/03_models/03-07_webhooks.sql`
- `notify_webhook()` trigger function: `supabase/schemas/02_functions/02-03_trigger_functions.sql`
- `agent-client` gates: `supabase/functions/agent-client/index.ts:188` (paused) and `:304-315` (no AI agents)
- `pause_conversation_on_human_message` trigger: `supabase/schemas/03_models/03-05_messages.sql:117-135`
- Per-address webhook scoping migration: `supabase/migrations/20260506000002_webhooks_per_address.sql`
