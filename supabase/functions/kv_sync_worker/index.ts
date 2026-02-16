// Follow this setup guide to integrate the Deno language server with your editor:
// https://deno.land/manual/getting_started/setup_your_environment
// This enables autocomplete, go to definition, etc.

// Setup type definitions for built-in Supabase Runtime APIs
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { putTenantConfigToKV } from "../_shared/cloudflare_kv.ts";
import { createClient, SupabaseClient } from "jsr:@supabase/supabase-js@2";

type TenantConfig = {
  tenantId: string;
  status: "active" | "inactive";
  origin: {
    url: string;
    hostOverride: string | null;
  } | null;
  defaultWallet: {
    address: string;
    chain: string;
  } | null;
  routes: Array<{
    id: string;
    pathPrefix: string;
    methods: string[];
    mode: string;
    contentType: "website" | "file" | "api" | null;
    origin: {
      url: string;
      hostOverride: string | null;
    } | null;
    price: {
      amount: string;
      asset: string;
      chain: string;
    } | null;
    wallet: {
      address: string;
      chain: string;
    } | null;
    fee: {
      bps: number | null;
      min: string | null;
      max: string | null;
    } | null;
  }>;
};

// Basic UUID v4 format check – enough to avoid `"null"` and other junk values
function isValidUuid(value: string | null | undefined): value is string {
  if (!value) return false;
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
    .test(value);
}

function getServiceClient(): SupabaseClient {
  const url = Deno.env.get("SUPABASE_URL");
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !key) {
    throw new Error("SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY not set");
  }

  return createClient(url, key, {
    auth: { persistSession: false },
  });
}

// Compile tenant config from Postgres tables
async function buildTenantConfig(tenantId: string): Promise<TenantConfig> {
  const client = getServiceClient();

  const { data: origins, error: originsError } = await client
    .from("origins")
    .select("id,url,host_override")
    .eq("tenant_id", tenantId)
    .order("created_at", { ascending: true });
  if (originsError) throw originsError;

  const origin = origins?.[0] ?? null;

  const { data: wallets, error: walletsError } = await client
    .from("wallets")
    .select("id,address,chain,is_default,split_address")
    .eq("tenant_id", tenantId)
    .order("created_at", { ascending: false }); // Match dropdown order (newest first)
  if (walletsError) throw walletsError;

  // Use first wallet (newest) as default if no explicit default is set
  // This matches the dropdown behavior where the first wallet is shown first
  const defaultWalletRaw =
    wallets?.find((w) => w.is_default) ??
    (wallets && wallets.length > 0 ? wallets[0] : null) ??
    null;
  
  // Use split_address if available, otherwise fall back to address
  const defaultWallet = defaultWalletRaw ? {
    address: defaultWalletRaw.split_address || defaultWalletRaw.address,
    chain: defaultWalletRaw.chain,
  } : null;

  const { data: routes, error: routesError } = await client
    .from("routes")
    .select(
      "id,path_prefix,methods,mode,content_type,price_amount,price_asset,price_chain,fee_bps,fee_min,fee_max, wallet:wallets(address,chain,split_address), origin:origins(url,host_override)",
    )
    .eq("tenant_id", tenantId);
  if (routesError) throw routesError;

  return {
    tenantId,
    status: "active",
    origin: origin && {
      url: origin.url,
      hostOverride: origin.host_override ?? origin.url,
    },
    defaultWallet: defaultWallet && {
      address: defaultWallet.address,
      chain: defaultWallet.chain,
    },
    routes:
      routes?.map((r) => {
        // Determine the wallet for this route (route-specific or default)
        // Use split_address if available, otherwise fall back to address
        const routeWallet = r.wallet
          ? {
              address: r.wallet.split_address || r.wallet.address,
              chain: r.wallet.chain,
            }
          : defaultWallet
          ? {
              address: defaultWallet.address,
              chain: defaultWallet.chain,
            }
          : null;

        // Validate and override: route chain must match wallet chain
        let routeChain = r.price_chain ?? "solana";
        if (routeWallet && routeWallet.chain !== routeChain) {
          console.warn(
            `Route ${r.id}: price_chain (${routeChain}) does not match wallet chain (${routeWallet.chain}). Overriding with wallet chain.`,
          );
          routeChain = routeWallet.chain;
        }

        // Handle methods: if array contains "ANY", treat as all methods
        let methods = r.methods ?? ["GET"];
        if (Array.isArray(methods) && methods.includes("ANY")) {
          // "ANY" means all HTTP methods - represent as ["ANY"] for worker to handle
          methods = ["ANY"];
        }

        // Route-specific origin (if set) overrides tenant default origin
        const routeOrigin = r.origin ? {
          url: r.origin.url,
          hostOverride: r.origin.host_override ?? r.origin.url,
        } : null;

        return {
          id: r.id,
          pathPrefix: r.path_prefix?.startsWith("/")
            ? r.path_prefix
            : `/${r.path_prefix ?? ""}`,
          methods: methods,
          mode: r.mode,
          contentType: r.content_type || null,
          // Route-specific origin takes precedence
          origin: routeOrigin,
          // For now we only support USDC, and the worker resolves the actual
          // on-chain address/mint from `chain` + env. Treat `price_asset` as a
          // display hint so legacy rows with NULL still show "USDC".
          price: r.price_amount
            ? {
                amount: String(r.price_amount),
                asset: r.price_asset ?? "USDC",
                chain: routeChain,
              }
            : null,
          wallet: routeWallet,
          fee: {
            bps: r.fee_bps ?? 100,
            min: r.fee_min != null ? String(r.fee_min) : "0.00005",
            max: r.fee_max != null ? String(r.fee_max) : "0.01",
          },
        };
      }) ?? [],
  };
}

Deno.serve(async (req) => {
  const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!SUPABASE_SERVICE_ROLE_KEY) {
    console.warn(
      "SUPABASE_SERVICE_ROLE_KEY not set; kv_sync_worker will be a no-op",
    );
  }

  try {
    const client = getServiceClient();
    const env = Deno.env.toObject();
    
    // Debug logging to verify env vars are being read
    console.log("kv_sync_worker: Checking Cloudflare env vars", {
      hasAccountId: !!env.CLOUDFLARE_ACCOUNT_ID,
      accountIdLength: env.CLOUDFLARE_ACCOUNT_ID?.length ?? 0,
      accountIdPreview: env.CLOUDFLARE_ACCOUNT_ID
        ? `${env.CLOUDFLARE_ACCOUNT_ID.substring(0, 8)}...`
        : "undefined",
      hasKvToken: !!env.CLOUDFLARE_KV_API_TOKEN,
      hasNamespaceId: !!env.CLOUDFLARE_KV_NAMESPACE_ID,
    });

    // Optional override via env for manual debugging
    const overrideTenantIdRaw = Deno.env.get("KV_SYNC_TENANT_ID");
    const overrideTenantId = isValidUuid(overrideTenantIdRaw)
      ? overrideTenantIdRaw
      : undefined;
    if (overrideTenantIdRaw && !overrideTenantId) {
      console.error(
        "kv_sync_worker: KV_SYNC_TENANT_ID is not a valid UUID, ignoring:",
        overrideTenantIdRaw,
      );
    }

    // Determine which tenant IDs to sync.
    // Priority:
    //  1. Explicit tenantIds[] in JSON body
    //  2. Single tenantId in JSON body
    //  3. tenantId query param
    //  4. KV_SYNC_TENANT_ID env var (manual debugging)
    const url = new URL(req.url);
    let tenantIds: string[] = [];

    // From JSON body
    try {
      if (req.method !== "GET" && req.headers.get("content-length") !== "0") {
        const body = await req.json().catch(() => null) as
          | { tenantId?: string; tenantIds?: string[] }
          | null;
        if (Array.isArray(body?.tenantIds)) {
          tenantIds.push(
            ...body!.tenantIds.filter((t) => isValidUuid(t)),
          );
        } else if (body?.tenantId && isValidUuid(body.tenantId)) {
          tenantIds.push(body.tenantId);
        }
      }
    } catch (e) {
      console.error("kv_sync_worker: failed to parse JSON body", e);
    }

    // From query param
    const qpTenantId = url.searchParams.get("tenantId");
    if (qpTenantId && isValidUuid(qpTenantId)) {
      tenantIds.push(qpTenantId);
    }

    // From env override
    if (!tenantIds.length && overrideTenantId) {
      tenantIds.push(overrideTenantId);
    }

    // Deduplicate
    tenantIds = Array.from(new Set(tenantIds));

    if (tenantIds.length === 0) {
      return new Response(
        JSON.stringify({
          ok: false,
          error:
            "No valid tenantId provided. Pass tenantId / tenantIds in JSON body or ?tenantId= query param.",
        }),
        {
          status: 400,
          headers: { "Content-Type": "application/json" },
        },
      );
    }

    let processed = 0;

    for (const tenantId of tenantIds) {
      try {
        const cfg = await buildTenantConfig(tenantId);

        // Compute hostnames: Mode A subdomain + any custom domains
        const { data: tenantRow } = await client
          .from("tenants")
          .select("slug")
          .eq("id", tenantId)
          .maybeSingle();

        const { data: domainRows } = await client
          .from("domains")
          .select("hostname,status")
          .eq("tenant_id", tenantId);

        const hostnames = new Set<string>();
        if (tenantRow?.slug) {
          hostnames.add(`${tenantRow.slug}.x402instant.com`);
        }
        for (const d of domainRows ?? []) {
          // keep all non-deleted domains; refine to status='active' later if desired
          if (d.hostname) hostnames.add(d.hostname);
        }

        for (const host of hostnames) {
          const key = `cfg:${host}`;
          await putTenantConfigToKV(env, key, {
            tenantId: cfg.tenantId,
            status: cfg.status,
            origin: cfg.origin && {
              url: cfg.origin.url,
              hostOverride: cfg.origin.hostOverride,
            },
            defaultWallet: cfg.defaultWallet,
            routes: cfg.routes,
          });
        }

        processed += 1;
      } catch (inner) {
        console.error("kv_sync_worker tenant error", tenantId, inner);
      }
    }

    return new Response(JSON.stringify({ ok: true, processed }), {
      headers: { "Content-Type": "application/json" },
    });
  } catch (e) {
    console.error("kv_sync_worker error", e);
    return new Response(
      JSON.stringify({ ok: false, error: (e as Error).message }),
      { status: 500, headers: { "Content-Type": "application/json" } },
    );
  }
});

/* To invoke locally:

  1. Run `supabase start` (see: https://supabase.com/docs/reference/cli/supabase-start)
  2. Make an HTTP request:

  curl -i --location --request POST 'http://127.0.0.1:54321/functions/v1/kv_sync_worker' \
    --header 'Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0' \
    --header 'Content-Type: application/json' \
    --data '{"name":"Functions"}'

*/
