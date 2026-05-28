/**
 * External webhook subscriber preflight.
 *
 * Read-only checks against a deployed Supabase env (dev or prod) to confirm an
 * organization is wired correctly to forward inbound `public.messages` events
 * to an external subscriber and accept its replies back via PostgREST. See
 * `docs/EXTERNAL-SUBSCRIBER-RUNBOOK.md` for the operational context.
 *
 * Required env vars:
 *   SUPABASE_URL                — project URL
 *   SUPABASE_SERVICE_ROLE_KEY   — service-role (secret) key
 *   ORG_ID                      — UUID of the target organization in Wakit
 *   ORG_ADDRESS                 — WhatsApp phone_number_id for the org
 *
 * Optional:
 *   SUBSCRIBER_WEBHOOK_URL      — if set, scopes the webhook lookup by url too
 *
 * Exit codes:
 *   0 — all assertions PASS
 *   1 — at least one assertion FAIL
 *   2 — invalid invocation (missing env var, etc.)
 *
 * Usage:
 *   deno run --allow-env --allow-net scripts/external-subscriber-preflight.ts
 */

// Use a fully-qualified ESM URL so the script can be invoked from the repo
// root without a `deno.json` import map (matches the version pinned in
// `supabase/functions/deno.json`).
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.54";

type Check = { name: string; ok: boolean; detail: string };

function requireEnv(name: string): string {
  const v = Deno.env.get(name);
  if (!v) {
    console.error(`ERROR: missing required env var ${name}`);
    Deno.exit(2);
  }
  return v;
}

async function main() {
  const SUPABASE_URL = requireEnv("SUPABASE_URL");
  const SUPABASE_SERVICE_ROLE_KEY = requireEnv("SUPABASE_SERVICE_ROLE_KEY");
  const ORG_ID = requireEnv("ORG_ID");
  const ORG_ADDRESS = requireEnv("ORG_ADDRESS");
  const SUBSCRIBER_WEBHOOK_URL = Deno.env.get("SUBSCRIBER_WEBHOOK_URL");

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false },
  });

  const checks: Check[] = [];

  // --- Webhook row ---------------------------------------------------------
  let webhookQuery = supabase
    .from("webhooks")
    .select("id, organization_address, table_name, operations, url, token")
    .eq("organization_id", ORG_ID)
    .eq("table_name", "messages");

  if (SUBSCRIBER_WEBHOOK_URL) {
    webhookQuery = webhookQuery.eq("url", SUBSCRIBER_WEBHOOK_URL);
  }

  const { data: webhooks, error: webhooksErr } = await webhookQuery;

  if (webhooksErr) {
    checks.push({
      name: "webhook row exists",
      ok: false,
      detail: `query failed: ${webhooksErr.message}`,
    });
  } else if (!webhooks || webhooks.length === 0) {
    checks.push({
      name: "webhook row exists",
      ok: false,
      detail:
        `no webhook row for ORG_ID=${ORG_ID} with table_name='messages'` +
        (SUBSCRIBER_WEBHOOK_URL ? ` and url=${SUBSCRIBER_WEBHOOK_URL}` : ""),
    });
  } else if (webhooks.length > 1) {
    checks.push({
      name: "webhook row exists",
      ok: false,
      detail:
        `expected exactly 1 webhook row, found ${webhooks.length}. ` +
        `Multiple rows match — set SUBSCRIBER_WEBHOOK_URL to disambiguate.`,
    });
  } else {
    const row = webhooks[0];
    checks.push({
      name: "webhook row exists",
      ok: true,
      detail: `id=${row.id} url=${row.url}`,
    });

    const ops = row.operations ?? [];
    const hasInsert = ops.includes("insert");
    const hasUpdate = ops.includes("update");
    checks.push({
      name: "webhook operations include insert+update",
      ok: hasInsert && hasUpdate,
      detail: `operations=${JSON.stringify(ops)}`,
    });

    const addr = row.organization_address;
    const addrOk = addr === null || addr === ORG_ADDRESS;
    checks.push({
      name: "webhook organization_address is NULL or matches ORG_ADDRESS",
      ok: addrOk,
      detail:
        `organization_address=${addr === null ? "NULL" : `"${addr}"`}, ` +
        `ORG_ADDRESS="${ORG_ADDRESS}"`,
    });
  }

  // --- Zero active AI agents ----------------------------------------------
  const { data: aiAgents, error: agentsErr } = await supabase
    .from("agents")
    .select("id, name, extra")
    .eq("organization_id", ORG_ID)
    .eq("ai", true);

  if (agentsErr) {
    checks.push({
      name: "zero active AI agents",
      ok: false,
      detail: `query failed: ${agentsErr.message}`,
    });
  } else {
    const activeAi = (aiAgents ?? []).filter((a) => {
      const mode =
        (a.extra && typeof a.extra === "object" && (a.extra as Record<string, unknown>)["mode"]) ??
        "active";
      return mode !== "inactive";
    });

    checks.push({
      name: "zero active AI agents",
      ok: activeAi.length === 0,
      detail:
        activeAi.length === 0
          ? "0 active AI agents"
          : `${activeAi.length} active AI agent(s): ${activeAi
              .map((a) => `${a.name} (${a.id})`)
              .join(", ")}`,
    });
  }

  // --- API key with role >= member ----------------------------------------
  const { data: keys, error: keysErr } = await supabase
    .from("api_keys")
    .select("id, role, name")
    .eq("organization_id", ORG_ID);

  if (keysErr) {
    checks.push({
      name: "API key exists with role >= member",
      ok: false,
      detail: `query failed: ${keysErr.message}`,
    });
  } else {
    const memberOrHigher = (keys ?? []).filter((k) =>
      ["member", "admin", "owner"].includes(k.role as string)
    );
    checks.push({
      name: "API key exists with role >= member",
      ok: memberOrHigher.length >= 1,
      detail: `found ${memberOrHigher.length} key(s) with role in {member,admin,owner}`,
    });
  }

  // --- Report --------------------------------------------------------------
  const allPass = checks.every((c) => c.ok);

  console.log("=== External subscriber preflight ===");
  console.log(`SUPABASE_URL=${SUPABASE_URL}`);
  console.log(`ORG_ID=${ORG_ID}`);
  console.log(`ORG_ADDRESS=${ORG_ADDRESS}`);
  if (SUBSCRIBER_WEBHOOK_URL) {
    console.log(`SUBSCRIBER_WEBHOOK_URL=${SUBSCRIBER_WEBHOOK_URL}`);
  }
  console.log("");
  for (const c of checks) {
    console.log(`${c.ok ? "PASS" : "FAIL"}  ${c.name}`);
    console.log(`      ${c.detail}`);
  }
  console.log("");
  console.log(allPass ? "PASS preflight ✔" : "FAIL preflight ✗");

  Deno.exit(allPass ? 0 : 1);
}

await main();
