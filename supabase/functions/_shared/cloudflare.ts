import "jsr:@supabase/functions-js/edge-runtime.d.ts";
// @ts-ignore: Supabase Edge Functions use Deno's `npm:` specifier at runtime.
import Cloudflare from "npm:cloudflare";

type Env = {
  // Separate token for zone-level SaaS APIs (e.g. custom hostnames)
  CLOUDFLARE_API_TOKEN?: string;
  CLOUDFLARE_ACCOUNT_ID?: string;
  CLOUDFLARE_ZONE_ID?: string;
};

function getClient(env: Env) {
  const token = env.CLOUDFLARE_API_TOKEN;
  if (!token) {
    throw new Error("CLOUDFLARE_API_TOKEN not configured");
  }
  return new Cloudflare({ apiToken: token });
}

export async function createCustomHostname(env: Env, hostname: string) {
  const zoneId = env.CLOUDFLARE_ZONE_ID;
  if (!zoneId) {
    throw new Error("CLOUDFLARE_ZONE_ID not configured");
  }

  const client = getClient(env);

  try {
    // Cloudflare TS SDK wrapper around
    // POST /zones/{zone_id}/custom_hostnames
    const result = await client.customHostnames.create({
      zone_id: zoneId,
      hostname,
      ssl: { method: "http", type: "dv" },
    });
    return result;
  } catch (err) {
    console.error("Cloudflare create custom hostname failed", err);
    throw new Error("Cloudflare create custom hostname failed");
  }
}

export async function getCustomHostname(env: Env, id: string) {
  const zoneId = env.CLOUDFLARE_ZONE_ID;
  if (!zoneId) {
    throw new Error("CLOUDFLARE_ZONE_ID not configured");
  }

  const client = getClient(env);

  try {
    // Cloudflare TS SDK wrapper around
    // GET /zones/{zone_id}/custom_hostnames/{id}
    const result = await client.customHostnames.get({
      zone_id: zoneId,
      custom_hostname_id: id,
    });
    return result;
  } catch (err) {
    console.error("Cloudflare get custom hostname failed", err);
    throw new Error("Cloudflare get custom hostname failed");
  }
}

