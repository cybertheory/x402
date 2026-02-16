// Setup type definitions for built-in Supabase Runtime APIs
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { corsHeaders } from "../_shared/cors.ts";
import { getTenantId } from "../_shared/auth.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

// Generate a secure random API key
function generateApiKey(): string {
  // Generate a 32-byte random key and encode as base64url
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  const base64 = btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=/g, '');
  return `x402_${base64}`;
}

// Hash the API key for storage (using Web Crypto API)
async function hashApiKey(key: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(key);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  if (req.method !== "POST") {
    return new Response(
      JSON.stringify({ error: "Method not allowed" }),
      {
        status: 405,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      }
    );
  }

  try {
    // Get tenant ID from JWT
    const tenantId = await getTenantId(req);
    const body = await req.json();
    const { name, expires_in_days } = body;

    if (!name || typeof name !== "string" || name.trim().length === 0) {
      return new Response(
        JSON.stringify({ error: "name is required" }),
        {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        }
      );
    }

    // Generate API key
    const apiKey = generateApiKey();
    const keyPrefix = apiKey.substring(0, 12); // First 12 chars for display
    const keyHash = await hashApiKey(apiKey);

    // Calculate expiration if provided
    const expiresAt = expires_in_days 
      ? new Date(Date.now() + expires_in_days * 24 * 60 * 60 * 1000).toISOString()
      : null;

    // Get Supabase service client
    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    if (!supabaseUrl || !supabaseServiceKey) {
      throw new Error("Supabase configuration missing");
    }

    const supabase = createClient(supabaseUrl, supabaseServiceKey, {
      auth: { persistSession: false },
    });

    // Store hashed key in database
    const { data: apiKeyRecord, error: dbError } = await supabase
      .from("api_keys")
      .insert({
        tenant_id: tenantId,
        name: name.trim(),
        key_hash: keyHash,
        key_prefix: keyPrefix,
        is_active: true,
        expires_at: expiresAt,
      })
      .select()
      .single();

    if (dbError) {
      console.error("Database error:", dbError);
      throw new Error(`Failed to create API key: ${dbError.message}`);
    }

    // Return the API key (only shown once!)
    return new Response(
      JSON.stringify({
        success: true,
        api_key: apiKey, // Only returned on creation
        key_id: apiKeyRecord.id,
        key_prefix: keyPrefix,
        name: apiKeyRecord.name,
        expires_at: expiresAt,
        created_at: apiKeyRecord.created_at,
      }),
      {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      }
    );

  } catch (e) {
    console.error("create_api_key error", e);
    return new Response(
      JSON.stringify({ error: (e as Error).message }),
      {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      }
    );
  }
});

