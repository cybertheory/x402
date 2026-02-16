// Setup type definitions for built-in Supabase Runtime APIs
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { corsHeaders } from "../_shared/cors.ts";
import { getTenantId } from "../_shared/auth.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import {
  type Balance,
  isEtherscanSupported,
  fetchTokenBalances,
} from "../_shared/etherscan.ts";

type WalletBalanceResponse = {
  balances: Balance[];
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

// Fetch EVM wallet balances using Etherscan API
// Only fetches USDC token balance
async function fetchEvmBalances(
  address: string,
  chain: string,
  walletId: string
): Promise<Balance[]> {
  try {
    console.log(`[fetchEvmBalances] Starting USDC balance fetch for ${address} on ${chain} (wallet ${walletId})`);

    // Fetch USDC balance only
    const tokenBalances = await fetchTokenBalances(address, chain, walletId);
    console.log(`[fetchEvmBalances] Found ${tokenBalances.length} USDC balance(es)`);
    
    // Filter to only USDC
    const usdcBalances = tokenBalances.filter(b => b.token_symbol === "USDC");
    
    console.log(`[fetchEvmBalances] Returning ${usdcBalances.length} USDC balance(es)`);
    if (usdcBalances.length > 0) {
      console.log(`[fetchEvmBalances] USDC balance: ${usdcBalances[0].amount}`);
    }
    
    return usdcBalances;
  } catch (err) {
    console.error(`[fetchEvmBalances] FATAL ERROR fetching USDC balance for ${address} on ${chain}:`, err);
    console.error(`[fetchEvmBalances] Error details:`, err instanceof Error ? err.stack : String(err));
    throw new Error(`Failed to fetch USDC balance: ${err instanceof Error ? err.message : String(err)}`);
  }
}

// Fetch Solana wallet balances - USDC only
async function fetchSolanaBalances(
  address: string,
  walletId: string
): Promise<Balance[]> {
  const { Connection, PublicKey } = await import("npm:@solana/web3.js");

  const rpcUrl = getRpcUrl("solana");
  const connection = new Connection(rpcUrl, "confirmed");

  const balances: Balance[] = [];

  try {
    const publicKey = new PublicKey(address);

    // USDC mint address on Solana
    const usdcMint = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

    // Fetch SPL token balances - only USDC
    try {
      const tokenAccounts = await connection.getParsedTokenAccountsByOwner(publicKey, {
        programId: new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"),
      });

      for (const accountInfo of tokenAccounts.value) {
        const parsedInfo = accountInfo.account.data.parsed?.info;
        if (parsedInfo) {
          const mint = parsedInfo.mint;
          
          // Only process USDC
          if (mint === usdcMint) {
            const amount = parsedInfo.tokenAmount?.uiAmountString || "0";
            const decimals = parsedInfo.tokenAmount?.decimals || 6;

            balances.push({
              wallet_id: walletId,
              wallet_address: address,
              chain: "solana",
              token_symbol: "USDC",
              token_address: mint,
              amount,
              decimals,
              is_native: false,
            });
            break; // Found USDC, no need to continue
          }
        }
      }
      
      // If no USDC found, still return a zero balance entry
      if (balances.length === 0) {
        balances.push({
          wallet_id: walletId,
          wallet_address: address,
          chain: "solana",
          token_symbol: "USDC",
          token_address: usdcMint,
          amount: "0",
          decimals: 6,
          is_native: false,
        });
      }
    } catch (err) {
      console.warn(`Failed to fetch USDC balance for ${address}:`, err);
      // Return zero balance on error
      balances.push({
        wallet_id: walletId,
        wallet_address: address,
        chain: "solana",
        token_symbol: "USDC",
        token_address: usdcMint,
        amount: "0",
        decimals: 6,
        is_native: false,
      });
    }
  } catch (err) {
    console.error(`Error fetching Solana USDC balance for ${address}:`, err);
    throw err;
  }

  return balances;
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
    console.log("[get_wallet_balances] Starting request");
    const tenantId = await getTenantId(req);
    console.log("[get_wallet_balances] Tenant ID:", tenantId);

    // Get Supabase service client to query wallets
    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    
    if (!supabaseUrl || !supabaseServiceKey) {
      const error = "Supabase configuration missing";
      console.error("[get_wallet_balances] ERROR:", error);
      throw new Error(error);
    }

    console.log("[get_wallet_balances] Supabase URL:", supabaseUrl ? "Set" : "Missing");

    const supabase = createClient(supabaseUrl, supabaseServiceKey, {
      auth: { persistSession: false },
    });

    // Fetch all wallets for this tenant
    console.log("[get_wallet_balances] Fetching wallets for tenant:", tenantId);
    const { data: wallets, error: walletsError } = await supabase
      .from("wallets")
      .select("id, address, chain")
      .eq("tenant_id", tenantId);

    if (walletsError) {
      console.error("[get_wallet_balances] ERROR fetching wallets:", walletsError);
      throw new Error(`Failed to fetch wallets: ${walletsError.message}`);
    }

    console.log("[get_wallet_balances] Found wallets:", wallets?.length || 0);
    if (wallets && wallets.length > 0) {
      console.log("[get_wallet_balances] Wallet details:", JSON.stringify(wallets, null, 2));
    }

    if (!wallets || wallets.length === 0) {
      console.log("[get_wallet_balances] No wallets found, returning empty balances");
      return new Response(
        JSON.stringify({ balances: [] } as WalletBalanceResponse),
        {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        }
      );
    }

    // Fetch balances for all wallets in parallel
    console.log("[get_wallet_balances] Fetching balances for", wallets.length, "wallets");
    const balancePromises = wallets.map(async (wallet) => {
      try {
        console.log(`[get_wallet_balances] Fetching balance for wallet ${wallet.id} (${wallet.address}) on ${wallet.chain}`);
        
        if (wallet.chain === "solana") {
          return await fetchSolanaBalances(wallet.address, wallet.id);
        } else if (isEtherscanSupported(wallet.chain)) {
          return await fetchEvmBalances(wallet.address, wallet.chain, wallet.id);
        } else {
          console.warn(`[get_wallet_balances] Unsupported chain: ${wallet.chain}`);
          return [];
        }
      } catch (err) {
        console.error(`[get_wallet_balances] ERROR fetching balances for wallet ${wallet.id}:`, err);
        console.error(`[get_wallet_balances] Error stack for wallet ${wallet.id}:`, err instanceof Error ? err.stack : "No stack trace");
        // Return empty array instead of throwing to allow other wallets to be processed
        return [];
      }
    });

    const balanceArrays = await Promise.all(balancePromises);
    const allBalances = balanceArrays.flat();

    console.log("[get_wallet_balances] Total USDC balances:", allBalances.length);

    // Filter to only USDC (should already be filtered, but double-check)
    const usdcBalances = allBalances.filter(b => b.token_symbol === "USDC");

    console.log("[get_wallet_balances] Final USDC balances count:", usdcBalances.length);
    if (usdcBalances.length > 0) {
      console.log("[get_wallet_balances] Sample USDC balance:", JSON.stringify(usdcBalances[0], null, 2));
      console.log("[get_wallet_balances] USDC balance details:", JSON.stringify(usdcBalances, null, 2));
    }

    const response: WalletBalanceResponse = {
      balances: usdcBalances,
    };
    console.log("[get_wallet_balances] Returning response with", usdcBalances.length, "USDC balances");

    return new Response(JSON.stringify(response), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (error) {
    console.error("[get_wallet_balances] FATAL ERROR:", error);
    console.error("[get_wallet_balances] Error stack:", error instanceof Error ? error.stack : "No stack trace");
    const errorMessage = error instanceof Error ? error.message : "Internal server error";
    return new Response(
      JSON.stringify({
        balances: [],
        error: errorMessage,
      } as WalletBalanceResponse),
      {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      }
    );
  }
});
