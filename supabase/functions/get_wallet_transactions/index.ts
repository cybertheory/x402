// Setup type definitions for built-in Supabase Runtime APIs
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { corsHeaders } from "../_shared/cors.ts";
import { getTenantId } from "../_shared/auth.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import {
  type Transaction,
  isEtherscanSupported,
  fetchTransactions as fetchEtherscanTransactions,
} from "../_shared/etherscan.ts";

type TransactionResponse = {
  transactions: Transaction[];
  total: number;
  limit: number;
  offset: number;
  error?: string;
};

// Get RPC URL for Solana only (EVM chains now use Etherscan APIs)
function getRpcUrl(chain: string): string {
  if (chain !== "solana") {
    throw new Error(`RPC URL only needed for Solana. Use Etherscan API for ${chain}`);
  }

  const customUrl = Deno.env.get("SOLANA_RPC_URL");
  if (customUrl) return customUrl;

  return "https://api.mainnet-beta.solana.com";
}

// Fetch EVM transactions using Etherscan API
async function fetchEvmTransactions(
  address: string,
  chain: string,
  direction: "to" | "from",
  limit: number,
  offset: number
): Promise<Transaction[]> {
  try {
    console.log(`[fetchEvmTransactions] Fetching transactions for ${address} on ${chain}`);
    console.log(`[fetchEvmTransactions] Direction: ${direction}, Limit: ${limit}, Offset: ${offset}`);
    console.log(`[fetchEvmTransactions] Using Etherscan API`);

    const transactions = await fetchEtherscanTransactions(
      address,
      chain,
      direction,
      limit,
      offset
    );

    console.log(`[fetchEvmTransactions] Found ${transactions.length} transactions`);
    return transactions;
  } catch (err) {
    console.error(`[fetchEvmTransactions] ERROR fetching transactions for ${address} on ${chain}:`, err);
    console.error(`[fetchEvmTransactions] Error details:`, err instanceof Error ? err.stack : String(err));
    return [];
  }
}

// Fetch Solana transactions (skip for now per requirements, but keep structure)
async function fetchSolanaTransactions(
  address: string,
  direction: "to" | "from",
  limit: number,
  offset: number
): Promise<Transaction[]> {
  // Skip Solana for now - return empty array
  console.log(`[fetchSolanaTransactions] Solana transactions not yet supported, returning empty array`);
  return [];
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
    console.log("[get_wallet_transactions] Starting request");
    const tenantId = await getTenantId(req);
    console.log("[get_wallet_transactions] Tenant ID:", tenantId);

    const body = await req.json().catch(() => ({}));
    
    const walletId = body?.wallet_id;
    const direction = body?.direction || "to";
    const chain = body?.chain;
    const token = body?.token;
    const limit = Math.min(Number(body?.limit) || 50, 100);
    const offset = Number(body?.offset) || 0;

    console.log("[get_wallet_transactions] Request params:", {
      walletId,
      direction,
      chain,
      token,
      limit,
      offset,
    });

    if (!walletId) {
      return new Response(
        JSON.stringify({ error: "wallet_id is required" }),
        {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        }
      );
    }

    if (direction !== "to" && direction !== "from") {
      return new Response(
        JSON.stringify({ error: "direction must be 'to' or 'from'" }),
        {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        }
      );
    }

    // Get Supabase service client to query wallet
    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    
    if (!supabaseUrl || !supabaseServiceKey) {
      throw new Error("Supabase configuration missing");
    }

    const supabase = createClient(supabaseUrl, supabaseServiceKey, {
      auth: { persistSession: false },
    });

    // Fetch wallet
    console.log("[get_wallet_transactions] Fetching wallet:", walletId);
    const { data: wallet, error: walletError } = await supabase
      .from("wallets")
      .select("id, address, chain")
      .eq("id", walletId)
      .eq("tenant_id", tenantId)
      .single();

    if (walletError || !wallet) {
      console.error("[get_wallet_transactions] Wallet not found:", walletError);
      return new Response(
        JSON.stringify({ error: "Wallet not found" }),
        {
          status: 404,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        }
      );
    }

    console.log("[get_wallet_transactions] Found wallet:", JSON.stringify(wallet, null, 2));

    // Filter by chain if provided
    if (chain && wallet.chain !== chain) {
      console.log("[get_wallet_transactions] Chain filter mismatch, returning empty");
      return new Response(
        JSON.stringify({ transactions: [], total: 0, limit, offset } as TransactionResponse),
        {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        }
      );
    }

    // Fetch transactions
    let transactions: Transaction[] = [];
    
    if (wallet.chain === "solana") {
      console.log("[get_wallet_transactions] Fetching Solana transactions (skipped)");
      transactions = await fetchSolanaTransactions(
        wallet.address,
        direction,
        limit,
        offset
      );
    } else if (isEtherscanSupported(wallet.chain)) {
      console.log("[get_wallet_transactions] Fetching EVM transactions via Etherscan");
      transactions = await fetchEvmTransactions(
        wallet.address,
        wallet.chain,
        direction,
        limit,
        offset
      );
    } else {
      console.error(`[get_wallet_transactions] Unsupported chain: ${wallet.chain}`);
      transactions = [];
    }

    console.log("[get_wallet_transactions] Raw transactions count:", transactions.length);

    // Filter by token if provided
    if (token && token !== "All") {
      const beforeFilter = transactions.length;
      transactions = transactions.filter(
        (tx) => tx.token_symbol.toUpperCase() === token.toUpperCase()
      );
      console.log(`[get_wallet_transactions] After token filter (${token}): ${transactions.length} (was ${beforeFilter})`);
    }

    const response: TransactionResponse = {
      transactions,
      total: transactions.length,
      limit,
      offset,
    };

    console.log("[get_wallet_transactions] Returning response with", transactions.length, "transactions");

    return new Response(JSON.stringify(response), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (error) {
    console.error("[get_wallet_transactions] FATAL ERROR:", error);
    console.error("[get_wallet_transactions] Error stack:", error instanceof Error ? error.stack : "No stack trace");
    return new Response(
      JSON.stringify({
        transactions: [],
        total: 0,
        limit: 0,
        offset: 0,
        error: error instanceof Error ? error.message : "Internal server error",
      } as TransactionResponse),
      {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      }
    );
  }
});
