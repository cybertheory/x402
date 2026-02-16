import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient, SupabaseClient } from "jsr:@supabase/supabase-js@2";

/**
 * Get authenticated Supabase client from request headers
 * Verifies JWT token is present and valid (Supabase platform verifies JWT automatically)
 */
export function getAuthenticatedClient(req: Request): SupabaseClient {
  const authHeader = req.headers.get("Authorization");
  if (!authHeader) {
    throw new Error("Missing Authorization header - JWT token required");
  }

  // Verify it's a Bearer token
  if (!authHeader.startsWith("Bearer ")) {
    throw new Error("Invalid Authorization header format - must be 'Bearer <token>'");
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const supabaseAnonKey = Deno.env.get("SUPABASE_ANON_KEY");
  
  if (!supabaseUrl || !supabaseAnonKey) {
    throw new Error("SUPABASE_URL or SUPABASE_ANON_KEY not configured");
  }

  // Create client with JWT token - Supabase will verify the JWT automatically
  // If JWT is invalid, Supabase will reject the request before it reaches this code
  const client = createClient(supabaseUrl, supabaseAnonKey, {
    global: {
      headers: { Authorization: authHeader },
    },
  });

  return client;
}

/**
 * Hash an API key using SHA-256
 */
async function hashApiKey(key: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(key);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Validate API key and return tenant_id
 * Used for custom API key authentication (alternative to JWT)
 */
export async function getTenantIdFromApiKey(apiKey: string): Promise<string | null> {
  // Hash the provided API key
  const keyHash = await hashApiKey(apiKey);

  // Look up in database
  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !supabaseServiceKey) {
    throw new Error("Supabase configuration missing");
  }

  const supabase = createClient(supabaseUrl, supabaseServiceKey, {
    auth: { persistSession: false },
  });

  const { data: apiKeyRecord, error } = await supabase
    .from("api_keys")
    .select("tenant_id, is_active, expires_at, last_used_at")
    .eq("key_hash", keyHash)
    .eq("is_active", true)
    .single();

  if (error || !apiKeyRecord) {
    return null; // API key not found or inactive
  }

  // Check expiration
  if (apiKeyRecord.expires_at) {
    const expiresAt = new Date(apiKeyRecord.expires_at);
    if (expiresAt < new Date()) {
      return null; // API key expired
    }
  }

  // Update last_used_at
  await supabase
    .from("api_keys")
    .update({ last_used_at: new Date().toISOString() })
    .eq("key_hash", keyHash);

  return apiKeyRecord.tenant_id;
}

/**
 * Get tenant_id for the authenticated user
 * Verifies JWT and extracts tenant information
 */
export async function getTenantId(req: Request): Promise<string> {
  // This will throw if JWT is missing or invalid
  const client = getAuthenticatedClient(req);
  
  // Verify the user is authenticated by getting their user info
  const { data: { user }, error: userError } = await client.auth.getUser();
  
  if (userError || !user) {
    throw new Error(`Authentication failed: ${userError?.message || "User not found"}`);
  }
  
  // Call ensure_default_tenant RPC function (same as frontend)
  // This will create a tenant if one doesn't exist for the user
  const { data, error } = await client.rpc("ensure_default_tenant");
  
  if (error) {
    throw new Error(`Failed to get tenant: ${error.message}`);
  }
  
  if (!data) {
    throw new Error("No tenant found for user");
  }
  
  return data as string;
}

/**
 * Get tenant ID from either JWT or API key
 * Supports both authentication methods
 */
export async function getTenantIdFromRequest(req: Request): Promise<string> {
  const authHeader = req.headers.get("Authorization");
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    throw new Error("Missing or invalid Authorization header");
  }

  const token = authHeader.substring(7); // Remove "Bearer "

  // Try API key first (if it starts with x402_)
  if (token.startsWith("x402_")) {
    const tenantId = await getTenantIdFromApiKey(token);
    if (tenantId) {
      return tenantId;
    }
    throw new Error("Invalid or expired API key");
  }

  // Otherwise, treat as JWT
  return await getTenantId(req);
}






