// Setup type definitions for built-in Supabase Runtime APIs
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { corsHeaders } from "../_shared/cors.ts";

Deno.serve(async (req) => {
  // Handle CORS preflight
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
    const body = await req.json().catch(() => null);
    const address = (body?.address ?? "").trim();
    const chain = typeof body?.chain === "string" ? body.chain : "base-sepolia";

    if (!address) {
      return new Response(
        JSON.stringify({ error: "address is required" }),
        {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        }
      );
    }

    // Validate address format (basic Ethereum address check)
    if (!/^0x[a-fA-F0-9]{40}$/.test(address)) {
      return new Response(
        JSON.stringify({ error: "Invalid Ethereum address format" }),
        {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        }
      );
    }

    // Only support base-sepolia for now
    if (chain !== "base-sepolia") {
      return new Response(
        JSON.stringify({ error: "Only base-sepolia testnet is supported" }),
        {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        }
      );
    }

    // Get Circle faucet API key from environment variables
    // In Supabase Edge Functions, environment variables are set via:
    // - `supabase secrets set CIRCLE_FAUCET_API_KEY=your-key` (for production)
    // - `supabase secrets set CIRCLE_FAUCET_API_KEY=your-key` (for local dev)
    // These are accessed via Deno.env.get() - NOT from .env files
    // 
    // API Key Format: Circle API Keys are formatted as "PREFIX:ID:SECRET"
    // - All three parts are required
    // - Get it from: Circle Console → API & Client Keys → Create API Key
    // - Must be a testnet API key
    const circleApiKey = Deno.env.get("CIRCLE_FAUCET_API_KEY");
    
    if (!circleApiKey) {
      return new Response(
        JSON.stringify({
          success: false,
          message: "Circle faucet API key not configured. Please set CIRCLE_FAUCET_API_KEY in Supabase secrets using: supabase secrets set CIRCLE_FAUCET_API_KEY=your-key",
          error: "Missing API key",
        }),
        {
          status: 500,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        }
      );
    }

    // Circle's testnet faucet API endpoint
    // API Documentation: https://developers.circle.com
    // Endpoint: POST /v1/faucet/drips
    const circleFaucetUrl = "https://api.circle.com/v1/faucet/drips";
    
    // Generate a unique request ID for tracking
    const requestId = crypto.randomUUID();
    
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      // Circle API Key format: "PREFIX:ID:SECRET" (all three parts required)
      "Authorization": `Bearer ${circleApiKey}`,
      // Optional: X-Request-Id for tracking (useful when communicating with Circle Support)
      "X-Request-Id": requestId,
    };

    // Call Circle's testnet faucet API
    // Request body format per Circle API documentation:
    // - address: required (Ethereum address)
    // - blockchain: required (BASE-SEPOLIA for Base Sepolia testnet)
    // - usdc: optional boolean (default false) - request USDC testnet tokens
    // - native: optional boolean (default false) - request native testnet tokens
    // - eurc: optional boolean (default false) - request EURC testnet tokens
    const requestBody = {
      address: address,
      blockchain: "BASE-SEPOLIA", // Circle uses uppercase with hyphen format
      usdc: true, // Request USDC testnet tokens
      native: false, // Don't request native tokens (ETH)
      eurc: false, // Don't request EURC tokens
    };

    const response = await fetch(circleFaucetUrl, {
      method: "POST",
      headers,
      body: JSON.stringify(requestBody),
    });

    // Circle API returns 204 No Content on success
    if (response.status === 204) {
      return new Response(
        JSON.stringify({
          success: true,
          message: "USDC testnet tokens requested successfully from Circle faucet",
          requestId: requestId,
        }),
        {
          status: 200,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        }
      );
    }

    // Handle error responses
    if (!response.ok) {
      const errorText = await response.text();
      let errorData;
      
      try {
        errorData = JSON.parse(errorText);
      } catch {
        errorData = { message: errorText || response.statusText };
      }
      
      console.error("Circle faucet API error:", errorData);
      
      return new Response(
        JSON.stringify({
          success: false,
          message: errorData.message || `Faucet request failed: ${response.statusText}`,
          error: errorData.code ? `Error ${errorData.code}` : errorData.message || response.statusText,
          requestId: requestId,
        }),
        {
          status: response.status,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        }
      );
    }

    // Fallback for unexpected success responses
    const data = await response.json().catch(() => null);
    
    return new Response(
      JSON.stringify({
        success: true,
        message: "USDC requested successfully from Circle faucet",
        data: data,
        requestId: requestId,
      }),
      {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      }
    );
  } catch (error) {
    console.error("request_usdc_faucet error:", error);
    return new Response(
      JSON.stringify({
        success: false,
        message: error instanceof Error ? error.message : "Internal server error",
        error: "Internal server error",
      }),
      {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      }
    );
  }
});

