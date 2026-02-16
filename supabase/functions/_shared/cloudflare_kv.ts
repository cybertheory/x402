import "jsr:@supabase/functions-js/edge-runtime.d.ts";
// @ts-ignore: Supabase Edge Functions use Deno's `npm:` specifier at runtime.
import Cloudflare from "npm:cloudflare";

type Env = {
  // Dedicated token for KV (Account → Workers KV Storage → Edit)
  // Falls back to CLOUDFLARE_API_TOKEN if not set
  CLOUDFLARE_KV_API_TOKEN?: string;
  // Fallback token (used for other Cloudflare APIs)
  CLOUDFLARE_API_TOKEN?: string;
  CLOUDFLARE_ACCOUNT_ID?: string;
  CLOUDFLARE_KV_NAMESPACE_ID?: string;
  // Optional: human-readable namespace name (e.g. "tenants").
  // If not provided, we will treat `CLOUDFLARE_KV_NAMESPACE_ID` as either
  // an ID *or* a title and fall back to a default of "tenants".
  CLOUDFLARE_KV_NAMESPACE_NAME?: string;
};

function getKvClient(env: Env) {
  // Try CLOUDFLARE_KV_API_TOKEN first, fall back to CLOUDFLARE_API_TOKEN
  const token = env.CLOUDFLARE_KV_API_TOKEN || env.CLOUDFLARE_API_TOKEN;
  if (!token) {
    throw new Error(
      "Neither CLOUDFLARE_KV_API_TOKEN nor CLOUDFLARE_API_TOKEN configured",
    );
  }
  
  const tokenSource = env.CLOUDFLARE_KV_API_TOKEN
    ? "CLOUDFLARE_KV_API_TOKEN"
    : "CLOUDFLARE_API_TOKEN (fallback)";
  console.log(`Cloudflare KV: Using token from ${tokenSource}`);
  
  return new Cloudflare({ apiToken: token });
}

// Cache namespace IDs so we don't list/create on every write during a single
// function instance lifetime.
const namespaceIdCache = new Map<string, string>();

function isLikelyNamespaceId(v?: string | null): v is string {
  if (!v) return false;
  const s = v.trim();
  // Cloudflare KV namespace IDs are typically 32 hex chars, but also support UUID format
  return /^[0-9a-f]{32}$/i.test(s) || /^[0-9a-f-]{36}$/i.test(s);
}

async function getOrCreateNamespaceId(
  env: Env,
  client: Cloudflare,
  accountId: string,
) {
  // accountId is already validated by the caller

  const raw =
    env.CLOUDFLARE_KV_NAMESPACE_ID ??
    env.CLOUDFLARE_KV_NAMESPACE_NAME ??
    "tenants";

  // If this looks like a namespace ID, use it directly (avoids needing account-level list permissions)
  if (isLikelyNamespaceId(raw)) {
    console.log("Cloudflare KV: Using provided namespace ID directly:", raw.substring(0, 8) + "...");
    return raw;
  }

  // Otherwise treat as a title (e.g. "tenants") and resolve/create it.
  const title = raw;
  const cacheKey = `${accountId}:${title}`;
  const cached = namespaceIdCache.get(cacheKey);
  if (cached) return cached;

  try {
    // Try to find an existing namespace by title using async iteration
    for await (const ns of client.kv.namespaces.list({ account_id: accountId })) {
      if (ns.title === title) {
        namespaceIdCache.set(cacheKey, ns.id);
        return ns.id;
      }
    }

    // Create if it doesn't exist (upsert semantics)
    const created = await client.kv.namespaces.create({
      account_id: accountId,
      title,
    });
    namespaceIdCache.set(cacheKey, created.id);
    return created.id;
  } catch (err: any) {
    console.error("Cloudflare KV: failed to resolve/create namespace", {
      error: err.message,
      status: err.status,
      accountId: accountId.substring(0, 8) + "...",
      namespace: title,
    });
    return null;
  }
}

export async function putTenantConfigToKV(
  env: Env,
  key: string,
  value: unknown,
) {
  // Try CLOUDFLARE_KV_API_TOKEN first, fall back to CLOUDFLARE_API_TOKEN
  const token = env.CLOUDFLARE_KV_API_TOKEN || env.CLOUDFLARE_API_TOKEN;
  const rawAccountId = env.CLOUDFLARE_ACCOUNT_ID;
  const accountId = rawAccountId && rawAccountId !== "undefined" && rawAccountId !== "null"
    ? rawAccountId.trim()
    : undefined;

  if (!token || !accountId) {
    console.warn("Cloudflare KV: missing token/account; skipping write", {
      hasToken: !!token,
      hasAccountId: !!accountId,
    });
    return;
  }

  const client = new Cloudflare({ apiToken: token });
  const namespaceId = await getOrCreateNamespaceId(env, client, accountId);
  if (!namespaceId) {
    // Detailed warning already logged in getOrCreateNamespaceId
    return;
  }

  try {
    // Cloudflare TS SDK: values.update(namespaceId, key, { account_id, value })
    // PUT /accounts/{account_id}/storage/kv/namespaces/{namespace_id}/values/{key}
    await client.kv.namespaces.values.update(namespaceId, key, {
      account_id: accountId,
      value: JSON.stringify(value),
    });
    console.log("Cloudflare KV: Successfully wrote key:", key);
  } catch (err: any) {
    console.error("Cloudflare KV write failed", {
      error: err.message,
      status: err.status,
      accountId: accountId.substring(0, 8) + "...",
      namespaceId: namespaceId.substring(0, 8) + "...",
      key,
    });
    // Never fail the edge request because of KV; treat this as best-effort.
    return;
  }
}


