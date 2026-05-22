import { createClient } from "@supabase/supabase-js";

const TWILIO_API = "https://api.twilio.com/2010-04-01";
const TWILIO_CONTENT_API = "https://content.twilio.com/v1";

function twilioHeaders(accountSid: string, authToken: string) {
  return {
    Authorization: "Basic " + btoa(`${accountSid}:${authToken}`),
  };
}

async function twilioGet(url: string, accountSid: string, authToken: string) {
  const res = await fetch(url, { headers: twilioHeaders(accountSid, authToken) });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.message || `Twilio API error: ${res.status}`);
  }
  return res.json();
}

// Step 1: List WhatsApp senders only
async function listSenders(accountSid: string, authToken: string) {
  const account = await twilioGet(
    `${TWILIO_API}/Accounts/${accountSid}.json`,
    accountSid,
    authToken
  );

  const wa = await twilioGet(
    `https://messaging.twilio.com/v2/Channels/Senders?Channel=whatsapp&PageSize=50`,
    accountSid,
    authToken
  );

  const senders = (wa.senders || []).map((s: any) => ({
    phone: s.sender_id.replace("whatsapp:", ""),
    name: s.profile?.name || s.sender_id,
    sid: s.sid,
    status: s.status,
    quality: s.properties?.quality_rating,
    messaging_limit: s.properties?.messaging_limit,
    waba_id: s.configuration?.waba_id,
    webhook: {
      inbound_url: s.webhook?.callback_url || null,
      status_callback_url: s.webhook?.status_callback_url || null,
    },
  }));

  return {
    account: {
      name: account.friendly_name,
      status: account.status,
      created: account.date_created,
    },
    senders,
  };
}

// Count and classify messages by paginating
interface MessageCounts {
  total: number;
  template: number;    // messages with content_sid (template-based)
  freeform: number;    // messages without content_sid (free-form)
}

async function countMessages(
  url: string,
  accountSid: string,
  authToken: string
): Promise<MessageCounts> {
  const counts: MessageCounts = { total: 0, template: 0, freeform: 0 };
  let nextUrl: string | null = url;
  let pages = 0;

  while (nextUrl && pages < 50) {
    const data = await twilioGet(nextUrl, accountSid, authToken);
    for (const msg of data.messages || []) {
      counts.total++;
      if (msg.content_sid || msg.body?.startsWith("Your")) {
        // content_sid indicates a template message
        counts.template++;
      } else {
        counts.freeform++;
      }
    }
    const nextPage = data.next_page_uri;
    nextUrl = nextPage ? `https://api.twilio.com${nextPage}` : null;
    pages++;
  }

  return counts;
}

// Step 2: Analyze selected numbers
async function analyzeNumbers(
  accountSid: string,
  authToken: string,
  phoneNumbers: string[]
) {
  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)
    .toISOString()
    .split("T")[0];
  const today = new Date().toISOString().split("T")[0];

  const results = [];

  // Meta fees per message (US pricing, approximate)
  const META_FEES = {
    utility_outside_window: 0.0085,
    marketing: 0.0305,
    freeform_inside_window: 0,
    authentication: 0,
  };
  const TWILIO_FEE = 0.005;

  // Get wakit plans from DB
  const adminClient = createClient(
    Deno.env.get("SUPABASE_URL")!,
    (Deno.env.get("SERVICE_ROLE_KEY") || Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!)
  );
  const { data: plans } = await adminClient
    .schema("billing")
    .from("plans")
    .select("id, price")
    .order("price");
  const { data: planProducts } = await adminClient
    .schema("billing")
    .from("plans_products")
    .select("plan_id, included")
    .eq("product_id", "messages");

  const planLimits = (planProducts || []).reduce((acc: any, pp: any) => {
    acc[pp.plan_id] = pp.included;
    return acc;
  }, {} as Record<string, number>);

  for (const phone of phoneNumbers) {
    const waPhone = `whatsapp:${phone}`;

    const outbound = await countMessages(
      `${TWILIO_API}/Accounts/${accountSid}/Messages.json?From=${encodeURIComponent(waPhone)}&DateSent%3E=${thirtyDaysAgo}&PageSize=100`,
      accountSid,
      authToken
    );

    const inbound = await countMessages(
      `${TWILIO_API}/Accounts/${accountSid}/Messages.json?To=${encodeURIComponent(waPhone)}&DateSent%3E=${thirtyDaysAgo}&PageSize=100`,
      accountSid,
      authToken
    );

    const totalMessages = outbound.total + inbound.total;

    // Twilio cost breakdown
    const twilioFee = totalMessages * TWILIO_FEE;

    // Estimate Meta fees from message classification
    // Inbound messages: always free (customer-initiated, inside service window)
    // Outbound free-form: inside service window = free
    // Outbound templates: assume utility rate as conservative estimate
    const metaFeeTemplates = outbound.template * META_FEES.utility_outside_window;
    const metaFeeFreeform = 0; // free-form inside window = $0
    const metaFeeTotal = metaFeeTemplates + metaFeeFreeform;

    const totalTwilioCost = twilioFee + metaFeeTotal;

    // Find best wakit plan
    let bestPlan = { id: "free", name: "Free", price: 0 };
    for (const plan of plans || []) {
      const limit = planLimits[plan.id] || 0;
      if (totalMessages <= limit || plan.id === "pro") {
        bestPlan = { id: plan.id, name: plan.id.charAt(0).toUpperCase() + plan.id.slice(1), price: Number(plan.price) };
        break;
      }
    }

    const totalWakitCost = bestPlan.price + metaFeeTotal;
    const savings = Math.max(0, totalTwilioCost - totalWakitCost);

    results.push({
      phone,
      period: `${thirtyDaysAgo} to ${today}`,
      messages: {
        total: totalMessages,
        outbound: outbound.total,
        inbound: inbound.total,
        outbound_templates: outbound.template,
        outbound_freeform: outbound.freeform,
      },
      twilio_cost: {
        twilio_fee: { per_message: TWILIO_FEE, total: twilioFee },
        meta_fee: { templates: metaFeeTemplates, freeform: metaFeeFreeform, total: metaFeeTotal },
        monthly_total: totalTwilioCost,
        currency: "USD",
      },
      wakit_cost: {
        plan: bestPlan,
        wakit_fee: bestPlan.price,
        meta_fee: metaFeeTotal,
        monthly_total: totalWakitCost,
      },
      savings: {
        monthly: savings,
        percentage: totalTwilioCost > 0
          ? Math.round((savings / totalTwilioCost) * 100)
          : 0,
        note: "Meta fees are identical in both — you pay them directly to Meta with wakit. The savings come from eliminating Twilio's $0.005/message platform fee.",
      },
    });
  }

  // Get content templates with body
  let templates: any[] = [];
  try {
    const content = await twilioGet(
      `${TWILIO_CONTENT_API}/Content?PageSize=100`,
      accountSid,
      authToken
    );
    templates = (content.contents || []).map((t: any) => ({
      sid: t.sid,
      name: t.friendly_name,
      types: Object.keys(t.types || {}),
      body: t.types?.["twilio/text"]?.body?.slice(0, 150) || null,
    }));
  } catch {
    // Content API may not be available
  }

  // Get webhook config per sender
  let senderWebhooks: Record<string, any> = {};
  try {
    const wa = await twilioGet(
      `https://messaging.twilio.com/v2/Channels/Senders?Channel=whatsapp&PageSize=50`,
      accountSid,
      authToken
    );
    for (const s of wa.senders || []) {
      const phone = s.sender_id.replace("whatsapp:", "");
      if (phoneNumbers.includes(phone)) {
        senderWebhooks[phone] = {
          inbound_url: s.webhook?.callback_url || null,
          status_callback_url: s.webhook?.status_callback_url || null,
          fallback_url: s.webhook?.fallback_url || null,
        };
      }
    }
  } catch {
    // ignore
  }

  return {
    numbers: results,
    templates,
    sender_webhooks: senderWebhooks,
    total_savings: {
      twilio_monthly: results.reduce((sum, r) => sum + r.twilio_cost.monthly_total, 0),
      wakit_monthly: Math.max(0, ...results.map((r) => r.wakit_cost.monthly_total)),
      saved_monthly: results.reduce((sum, r) => sum + r.savings.monthly, 0),
      breakdown: {
        twilio_platform_fee: results.reduce((sum, r) => sum + r.twilio_cost.twilio_fee.total, 0),
        meta_fee_both: results.reduce((sum, r) => sum + r.twilio_cost.meta_fee.total, 0),
        note: "Meta fees are identical in both platforms. Savings = Twilio platform fee ($0.005/msg) minus wakit plan cost.",
      },
    },
  };
}

// Step 3: Get webhook config for a number
async function getNumberConfig(
  accountSid: string,
  authToken: string,
  phoneNumber: string
) {
  const wa = await twilioGet(
    `https://messaging.twilio.com/v2/Channels/Senders?Channel=whatsapp&PageSize=50`,
    accountSid,
    authToken
  );

  const sender = (wa.senders || []).find(
    (s: any) => s.sender_id === `whatsapp:${phoneNumber}`
  );

  if (!sender) return null;

  return {
    phone: phoneNumber,
    name: sender.profile?.name,
    sid: sender.sid,
    status: sender.status,
    waba_id: sender.configuration?.waba_id,
    webhook: {
      inbound_url: sender.webhook?.callback_url || "Not configured",
      status_callback_url: sender.webhook?.status_callback_url || "Not configured",
    },
    wakit_equivalent: {
      inbound_messages: "Automatic — messages arrive via WhatsApp webhook to Supabase",
      status_updates: "Configure in Settings > Webhooks (table: messages, operation: update)",
    },
  };
}

// Step 4: Import Twilio content templates as quick replies
async function importTemplates(
  accountSid: string,
  authToken: string,
  organizationId: string,
  supabase: any
) {
  // Fetch all Twilio content templates
  const content = await twilioGet(
    `${TWILIO_CONTENT_API}/Content?PageSize=100`,
    accountSid,
    authToken
  );

  const templates = content.contents || [];
  const imported = [];
  const skipped = [];

  for (const t of templates) {
    const name = t.friendly_name;
    // Get the body from the first text type
    const textType = t.types?.["twilio/text"];
    const body = textType?.body;

    if (!body) {
      skipped.push({ name, reason: "No text body found" });
      continue;
    }

    // Check if already exists
    const { data: existing } = await supabase
      .from("quick_replies")
      .select("id")
      .eq("organization_id", organizationId)
      .eq("name", name)
      .maybeSingle();

    if (existing) {
      skipped.push({ name, reason: "Already exists" });
      continue;
    }

    const { error } = await supabase
      .from("quick_replies")
      .insert({
        organization_id: organizationId,
        name,
        content: body,
      });

    if (error) {
      skipped.push({ name, reason: error.message });
    } else {
      imported.push({ name, content: body.slice(0, 100) + (body.length > 100 ? "..." : "") });
    }
  }

  return { imported: imported.length, skipped: skipped.length, details: { imported, skipped } };
}

// Step 5: Create wakit webhook from Twilio config
async function createWebhook(
  organizationId: string,
  organizationAddress: string | null,
  url: string,
  token: string | null,
  tableName: string,
  operations: string[],
  supabase: any
) {
  const { data, error } = await supabase
    .from("webhooks")
    .insert({
      organization_id: organizationId,
      organization_address: organizationAddress,
      table_name: tableName,
      operations,
      url,
      token,
    })
    .select()
    .single();

  if (error) throw new Error(error.message);
  return data;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, {
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Headers": "authorization, content-type, x-client-info, apikey",
      },
    });
  }

  try {
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_ANON_KEY")!,
      { global: { headers: { Authorization: req.headers.get("Authorization")! } } }
    );
    const { data: { user }, error: authError } = await supabase.auth.getUser();
    if (authError || !user) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401 });
    }

    const url = new URL(req.url);
    const path = url.pathname.split("/").pop();
    const body = await req.json();
    const { account_sid, auth_token } = body;

    if (!account_sid || !auth_token) {
      return new Response(JSON.stringify({ error: "account_sid and auth_token are required" }), { status: 400 });
    }

    let result;

    switch (path) {
      case "analyze":
        result = await listSenders(account_sid, auth_token);
        break;
      case "detail": {
        const { phone_numbers } = body;
        if (!phone_numbers?.length) {
          return new Response(JSON.stringify({ error: "phone_numbers array is required" }), { status: 400 });
        }
        result = await analyzeNumbers(account_sid, auth_token, phone_numbers);
        break;
      }
      case "config": {
        const { phone_number } = body;
        if (!phone_number) {
          return new Response(JSON.stringify({ error: "phone_number is required" }), { status: 400 });
        }
        result = await getNumberConfig(account_sid, auth_token, phone_number);
        break;
      }
      case "import-templates": {
        const { organization_id } = body;
        if (!organization_id) {
          return new Response(JSON.stringify({ error: "organization_id is required" }), { status: 400 });
        }
        const adminClient = createClient(
          Deno.env.get("SUPABASE_URL")!,
          (Deno.env.get("SERVICE_ROLE_KEY") || Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!)
        );
        result = await importTemplates(account_sid, auth_token, organization_id, adminClient);
        break;
      }
      case "create-webhook": {
        const { organization_id, organization_address, webhook_url, webhook_token, table_name, operations: ops } = body;
        if (!organization_id || !webhook_url) {
          return new Response(JSON.stringify({ error: "organization_id and webhook_url are required" }), { status: 400 });
        }
        const adminClient = createClient(
          Deno.env.get("SUPABASE_URL")!,
          (Deno.env.get("SERVICE_ROLE_KEY") || Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!)
        );
        result = await createWebhook(
          organization_id,
          organization_address || null,
          webhook_url,
          webhook_token || null,
          table_name || "messages",
          ops || ["insert", "update"],
          adminClient
        );
        break;
      }
      default:
        return new Response(JSON.stringify({ error: "Unknown action. Use: analyze, detail, config, import-templates, create-webhook" }), { status: 400 });
    }

    return new Response(JSON.stringify(result), {
      headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: (err as Error).message }), { status: 500 });
  }
});
