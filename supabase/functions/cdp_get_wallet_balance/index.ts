// Setup type definitions for built-in Supabase Runtime APIs
import "jsr:@supabase/functions-js/edge-runtime.d.ts";

// Coinbase Developer Platform SDK (CDP) v2 Server Wallets
// Using npm specifier which is supported in Supabase Edge Runtime (Deno 2)
// Docs: https://docs.cdp.coinbase.com/server-wallets/v2/using-the-wallet-api/token-balances
import { CdpClient } from "npm:@coinbase/cdp-sdk";
import { corsHeaders } from "../_shared/cors.ts";

type BalanceResponse = {
  address: string;
  chain?: string;
  // Display-friendly total balance string, e.g. "0.00 USDC" or "—"
  displayBalance: string;
  // Raw data for debugging/future use
  // deno-lint-ignore no-explicit-any
  raw?: any;
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }
  if (req.method !== "POST") {
    return new Response("Method not allowed", {
      status: 405,
      headers: corsHeaders,
    });
  }

  try {
    const body = await req.json().catch(() => null);
    const address = (body?.address ?? "").trim();
    const chain = typeof body?.chain === "string" ? body.chain : undefined;

    if (!address) {
      return new Response(
        JSON.stringify({ error: "address is required" }),
        {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        },
      );
    }

    // Prefer CDP_* envs, but fall back to COINBASE_* to match your current naming.
    const apiKeyId =
      Deno.env.get("CDP_API_KEY_ID") ?? Deno.env.get("COINBASE_API_KEY_ID");
    const apiKeySecret =
      Deno.env.get("CDP_API_KEY_SECRET") ?? Deno.env.get("COINBASE_API_SECRET");
    const walletSecret = Deno.env.get("CDP_WALLET_SECRET");

    if (!apiKeyId || !apiKeySecret || !walletSecret) {
      console.error(
        "CDP API env vars not configured (need API_KEY_ID, API_KEY_SECRET, WALLET_SECRET)",
      );
      return new Response(
        JSON.stringify({
          error:
            "CDP API credentials not configured; set CDP_API_KEY_ID, CDP_API_KEY_SECRET, CDP_WALLET_SECRET or COINBASE_* equivalents",
        }),
        {
          status: 500,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        },
      );
    }

    // Initialize the v2 CDP client (API key ID + secret + wallet secret)
    const cdp = new CdpClient({
      apiKeyId,
      apiKeySecret,
      walletSecret,
    });

    // Map chain to CDP SDK network format
    // CDP SDK expects "base-mainnet" for Base mainnet and "base-sepolia" for Base Sepolia
    const getNetworkFromChain = (chain?: string): string | undefined => {
      if (!chain) return undefined;
      const c = chain.toLowerCase();
      if (c === "base") return "base-mainnet";
      if (c === "base-sepolia") return "base-sepolia";
      // For other EVM chains, return as-is or undefined
      // CDP SDK may support other network formats
      return c;
    };

    const network = getNetworkFromChain(chain);

    // Fetch token balances for the address using the appropriate chain helper.
    // deno-lint-ignore no-explicit-any
    let balances: any[] = [];
    if (chain === "solana") {
      const result = await cdp.solana.listTokenBalances({ address });
      balances = Array.isArray((result as any)?.balances)
        ? (result as any).balances
        : [];
    } else {
      // Default to EVM helper for Base / Base Sepolia / other EVM chains.
      // Pass network parameter to scope balances by network
      const result = await cdp.evm.listTokenBalances({
        address,
        ...(network ? { network } : {}),
      });
      balances = Array.isArray((result as any)?.balances)
        ? (result as any).balances
        : [];
    }

    let displayBalance = "—";
    if (Array.isArray(balances) && balances.length > 0) {
      // Try to find a USDC-like balance first, otherwise default to the first asset.
      const primary =
        balances.find((b) =>
          typeof b?.token?.symbol === "string" &&
          b.token.symbol.toUpperCase().includes("USDC")
        ) ?? balances[0];

      const amount =
        primary?.amount?.amount ??
        primary?.amount ??
        null;
      const symbol = primary?.token?.symbol ?? primary?.token?.contractAddress ??
        "";

      if (amount != null) {
        displayBalance = `${String(amount)}${symbol ? " " + symbol : ""}`;
      }
    }

    const res: BalanceResponse = {
      address,
      chain,
      displayBalance,
      raw: { balances },
    };

    return new Response(JSON.stringify(res), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e) {
    console.error("cdp_get_wallet_balance error", e);
    return new Response(JSON.stringify({ error: (e as Error).message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});


