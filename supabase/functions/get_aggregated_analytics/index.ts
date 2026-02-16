// Setup type definitions for built-in Supabase Runtime APIs
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { corsHeaders } from "../_shared/cors.ts";
import { getTenantId } from "../_shared/auth.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

type AggregatedAnalytics = {
  total_balance: string;
  total_balance_by_chain: Record<string, string>;
  total_balance_by_token: Record<string, string>;
  transaction_count_to: number;
  transaction_count_from: number;
  total_volume_to: string;
  total_volume_from: string;
  wallet_count: number;
  error?: string;
};

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
    console.log("[get_aggregated_analytics] Starting request");
    const tenantId = await getTenantId(req);
    console.log("[get_aggregated_analytics] Tenant ID:", tenantId);
    
    let body: any = {};
    try {
      const bodyText = await req.text();
      console.log("[get_aggregated_analytics] Request body text:", bodyText);
      if (bodyText) {
        body = JSON.parse(bodyText);
      }
    } catch (err) {
      console.warn("[get_aggregated_analytics] Failed to parse body, using empty object:", err);
      body = {};
    }
    
    const chainFilter = body?.chain;
    const tokenFilter = body?.token;
    console.log("[get_aggregated_analytics] Raw body:", JSON.stringify(body, null, 2));
    console.log("[get_aggregated_analytics] Filters - chain:", chainFilter, "token:", tokenFilter);

    // Get Supabase service client
    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    
    if (!supabaseUrl || !supabaseServiceKey) {
      const error = "Supabase configuration missing";
      console.error("[get_aggregated_analytics] ERROR:", error);
      throw new Error(error);
    }

    console.log("[get_aggregated_analytics] Supabase URL:", supabaseUrl ? "Set" : "Missing");

    const supabase = createClient(supabaseUrl, supabaseServiceKey, {
      auth: { persistSession: false },
    });

    // Fetch all wallets for this tenant
    console.log("[get_aggregated_analytics] Fetching wallets for tenant:", tenantId);
    const { data: wallets, error: walletsError } = await supabase
      .from("wallets")
      .select("id, address, chain")
      .eq("tenant_id", tenantId);

    if (walletsError) {
      console.error("[get_aggregated_analytics] ERROR fetching wallets:", walletsError);
      throw new Error(`Failed to fetch wallets: ${walletsError.message}`);
    }

    console.log("[get_aggregated_analytics] Found wallets:", wallets?.length || 0);
    if (wallets && wallets.length > 0) {
      console.log("[get_aggregated_analytics] Wallet details:", JSON.stringify(wallets, null, 2));
    }

    // Call get_wallet_balances to get all balances
    // We'll make an internal HTTP call to the edge function
    const authHeader = req.headers.get("Authorization");
    let balances: Array<{
      wallet_id: string;
      wallet_address: string;
      chain: string;
      token_symbol: string;
      token_address: string | null;
      amount: string;
      decimals: number;
      is_native: boolean;
    }> = [];

    if (!authHeader) {
      console.warn("[get_aggregated_analytics] No Authorization header found");
    } else {
      try {
        const balanceUrl = `${supabaseUrl}/functions/v1/get_wallet_balances`;
        console.log("[get_aggregated_analytics] Calling get_wallet_balances:", balanceUrl);
        
        const balanceResponse = await fetch(balanceUrl, {
          method: "POST",
          headers: {
            "Authorization": authHeader,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({}),
        });

        console.log("[get_aggregated_analytics] Balance response status:", balanceResponse.status);
        
        if (balanceResponse.ok) {
          const balanceData = await balanceResponse.json();
          console.log("[get_aggregated_analytics] Balance response data:", JSON.stringify(balanceData, null, 2));
          balances = balanceData.balances || [];
          console.log("[get_aggregated_analytics] Parsed balances count:", balances.length);
          
          if (balanceData.error) {
            console.error("[get_aggregated_analytics] Balance fetch returned error:", balanceData.error);
          }
        } else {
          const errorText = await balanceResponse.text();
          console.error("[get_aggregated_analytics] Balance fetch failed:", balanceResponse.status, errorText);
        }
      } catch (err) {
        console.error("[get_aggregated_analytics] ERROR fetching balances:", err);
        throw new Error(`Failed to fetch balances: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    // Apply filters (only filter if not "All")
    console.log("[get_aggregated_analytics] Balances before filtering:", balances.length);
    if (balances.length > 0) {
      console.log("[get_aggregated_analytics] Sample balance before filter:", JSON.stringify(balances[0], null, 2));
    }
    
    let filteredBalances = balances;
    
    if (chainFilter && chainFilter !== "All" && chainFilter !== "all") {
      filteredBalances = filteredBalances.filter((b) => b.chain === chainFilter);
      console.log("[get_aggregated_analytics] After chain filter:", filteredBalances.length);
    }

    if (tokenFilter && tokenFilter !== "All" && tokenFilter !== "all") {
      filteredBalances = filteredBalances.filter(
        (b) => b.token_symbol.toUpperCase() === tokenFilter.toUpperCase()
      );
      console.log("[get_aggregated_analytics] After token filter:", filteredBalances.length);
    }

    console.log("[get_aggregated_analytics] Final balances to aggregate:", filteredBalances.length);
    if (filteredBalances.length > 0) {
      console.log("[get_aggregated_analytics] Sample balance:", JSON.stringify(filteredBalances[0], null, 2));
    } else {
      console.warn("[get_aggregated_analytics] No balances to aggregate after filtering!");
    }

    // Aggregate balances - sum across all chains and tokens
    let totalBalance = 0;
    let usdcBalance = 0;
    const balanceByChain: Record<string, number> = {};
    const balanceByToken: Record<string, number> = {};

    console.log("[get_aggregated_analytics] Starting aggregation for", filteredBalances.length, "balances");
    
    for (const balance of filteredBalances) {
      const amount = parseFloat(balance.amount) || 0;
      totalBalance += amount;

      // Sum by chain (aggregate across all chains)
      balanceByChain[balance.chain] = (balanceByChain[balance.chain] || 0) + amount;
      
      // Sum by token (aggregate across all tokens)
      balanceByToken[balance.token_symbol] = (balanceByToken[balance.token_symbol] || 0) + amount;
      
      // Track USDC separately
      if (balance.token_symbol === "USDC") {
        usdcBalance += amount;
        console.log("[get_aggregated_analytics] USDC balance found:", amount, "on", balance.chain);
      }
    }
    
    console.log("[get_aggregated_analytics] Aggregation results:");
    console.log("  - Total balance:", totalBalance);
    console.log("  - USDC balance:", usdcBalance);
    console.log("  - Balance by chain:", JSON.stringify(balanceByChain, null, 2));
    console.log("  - Balance by token:", JSON.stringify(balanceByToken, null, 2));
    
    // Ensure USDC is always in balanceByToken (even if zero)
    if (balanceByToken["USDC"] === undefined) {
      balanceByToken["USDC"] = usdcBalance;
      console.log("[get_aggregated_analytics] Added USDC to balanceByToken:", usdcBalance);
    }

    // Format balances as strings
    const formatBalance = (val: number) => {
      if (val === 0) return "0";
      if (val < 0.01) return val.toFixed(6);
      if (val < 1) return val.toFixed(4);
      return val.toFixed(2);
    };

    const totalBalanceByChain: Record<string, string> = {};
    for (const [chain, amount] of Object.entries(balanceByChain)) {
      totalBalanceByChain[chain] = formatBalance(amount);
    }

    const totalBalanceByToken: Record<string, string> = {};
    // Sort tokens: USDC first, then others alphabetically
    const sortedTokens = Object.entries(balanceByToken).sort((a, b) => {
      if (a[0] === "USDC") return -1;
      if (b[0] === "USDC") return 1;
      return a[0].localeCompare(b[0]);
    });
    
    for (const [token, amount] of sortedTokens) {
      totalBalanceByToken[token] = formatBalance(amount);
    }
    
    // Ensure USDC is always present (even if zero)
    if (!totalBalanceByToken["USDC"]) {
      totalBalanceByToken["USDC"] = "0.0000";
    }

    // For transaction counts and volumes, we would need to query transactions
    // For now, return placeholder values - these should be calculated from actual transaction data
    // In a production system, you'd want to cache or index this data

    const analytics: AggregatedAnalytics = {
      total_balance: formatBalance(totalBalance),
      total_balance_by_chain: totalBalanceByChain,
      total_balance_by_token: totalBalanceByToken,
      transaction_count_to: 0, // TODO: Calculate from actual transactions
      transaction_count_from: 0, // TODO: Calculate from actual transactions
      total_volume_to: "0", // TODO: Calculate from actual transactions
      total_volume_from: "0", // TODO: Calculate from actual transactions
      wallet_count: wallets?.length || 0,
    };

    console.log("[get_aggregated_analytics] Final analytics response:", JSON.stringify(analytics, null, 2));

    return new Response(JSON.stringify(analytics), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (error) {
    console.error("get_aggregated_analytics error:", error);
    return new Response(
      JSON.stringify({
        total_balance: "0",
        total_balance_by_chain: {},
        total_balance_by_token: {},
        transaction_count_to: 0,
        transaction_count_from: 0,
        total_volume_to: "0",
        total_volume_from: "0",
        wallet_count: 0,
        error: error instanceof Error ? error.message : "Internal server error",
      } as AggregatedAnalytics),
      {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      }
    );
  }
});

