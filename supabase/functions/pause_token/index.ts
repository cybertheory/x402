// Setup type definitions for built-in Supabase Runtime APIs
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { corsHeaders } from "../_shared/cors.ts";
import { getTenantId } from "../_shared/auth.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { CdpClient } from "npm:@coinbase/cdp-sdk";
import { createPublicClient, createWalletClient, http, custom, encodeFunctionData } from "npm:viem";
import * as viemChains from "npm:viem/chains";

const ERC20_PAUSABLE_ABI = [
  {
    type: "function",
    name: "pause",
    inputs: [],
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "unpause",
    inputs: [],
    outputs: [],
    stateMutability: "nonpayable",
  },
] as const;

function getChainConfig(chain: string): { chain: any; rpcUrl: string } | null {
  const alchemyKey = Deno.env.get("ALCHEMY_API_KEY");
  if (!alchemyKey) {
    throw new Error("ALCHEMY_API_KEY not configured");
  }

  const chainMap: Record<string, { chain: any; rpcUrl: string }> = {
    "base": { chain: viemChains.base, rpcUrl: `https://base-mainnet.g.alchemy.com/v2/${alchemyKey}` },
    "base-sepolia": { chain: viemChains.baseSepolia, rpcUrl: `https://base-sepolia.g.alchemy.com/v2/${alchemyKey}` },
    "ethereum": { chain: viemChains.mainnet, rpcUrl: `https://eth-mainnet.g.alchemy.com/v2/${alchemyKey}` },
    "ethereum-sepolia": { chain: viemChains.sepolia, rpcUrl: `https://eth-sepolia.g.alchemy.com/v2/${alchemyKey}` },
    "arbitrum": { chain: viemChains.arbitrum, rpcUrl: `https://arb-mainnet.g.alchemy.com/v2/${alchemyKey}` },
    "arbitrum-sepolia": { chain: viemChains.arbitrumSepolia, rpcUrl: `https://arb-sepolia.g.alchemy.com/v2/${alchemyKey}` },
    "optimism": { chain: viemChains.optimism, rpcUrl: `https://opt-mainnet.g.alchemy.com/v2/${alchemyKey}` },
    "optimism-sepolia": { chain: viemChains.optimismSepolia, rpcUrl: `https://opt-sepolia.g.alchemy.com/v2/${alchemyKey}` },
    "polygon": { chain: viemChains.polygon, rpcUrl: `https://polygon-mainnet.g.alchemy.com/v2/${alchemyKey}` },
    "polygon-mumbai": { chain: viemChains.polygonMumbai, rpcUrl: `https://polygon-mumbai.g.alchemy.com/v2/${alchemyKey}` },
  };

  return chainMap[chain] || null;
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
    // Verify JWT and get tenant ID - this will throw if JWT is missing or invalid
    const tenantId = await getTenantId(req);
    const body = await req.json();
    const { token_id, paused } = body;

    if (!token_id || typeof paused !== "boolean") {
      return new Response(
        JSON.stringify({ error: "Missing required fields: token_id, paused (boolean)" }),
        {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        }
      );
    }

    // Get Supabase client
    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    if (!supabaseUrl || !supabaseServiceKey) {
      throw new Error("Supabase configuration missing");
    }

    const supabase = createClient(supabaseUrl, supabaseServiceKey, {
      auth: { persistSession: false },
    });

    // Get token and verify tenant ownership
    const { data: token, error: tokenError } = await supabase
      .from("tokens")
      .select("*")
      .eq("id", token_id)
      .eq("tenant_id", tenantId)
      .single();

    if (tokenError || !token) {
      return new Response(
        JSON.stringify({ error: "Token not found or access denied" }),
        {
          status: 404,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        }
      );
    }

    // Initialize CDP client
    const apiKeyId = Deno.env.get("CDP_API_KEY_ID") ?? Deno.env.get("COINBASE_API_KEY_ID");
    const apiKeySecret = Deno.env.get("CDP_API_KEY_SECRET") ?? Deno.env.get("COINBASE_API_SECRET");
    const walletSecret = Deno.env.get("CDP_WALLET_SECRET");

    if (!apiKeyId || !apiKeySecret || !walletSecret) {
      return new Response(
        JSON.stringify({ error: "CDP API credentials not configured" }),
        {
          status: 500,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        }
      );
    }

    const cdp = new CdpClient({
      apiKeyId,
      apiKeySecret,
      walletSecret,
    });

    const chainConfig = getChainConfig(token.chain);
    if (!chainConfig) {
      throw new Error(`Unsupported chain: ${token.chain}`);
    }

    const chainId = chainConfig.chain.id;

    // Create clients
    const publicClient = createPublicClient({
      chain: chainConfig.chain,
      transport: http(chainConfig.rpcUrl),
    });

    const cdpProvider = {
      request: async ({ method, params }: any) => {
        if (method === "eth_sendTransaction") {
          const tx = params[0];
          const result = await cdp.evm.sendTransaction({
            networkId: chainId.toString(),
            transaction: {
              to: tx.to,
              value: tx.value || "0",
              data: tx.data || "0x",
              gas: tx.gas,
              gasPrice: tx.gasPrice,
              maxFeePerGas: tx.maxFeePerGas,
              maxPriorityFeePerGas: tx.maxPriorityFeePerGas,
              nonce: tx.nonce ? Number(tx.nonce) : undefined,
            },
          });
          return result.transactionHash;
        }
        return await publicClient.request({ method, params } as any);
      },
    };

    const cdpAccount = {
      address: token.deployer_address as `0x${string}`,
      type: "local" as const,
    } as any;

    const walletClient = createWalletClient({
      chain: chainConfig.chain,
      transport: custom(cdpProvider),
      account: cdpAccount,
    });

    // Encode pause/unpause function call
    const data = encodeFunctionData({
      abi: ERC20_PAUSABLE_ABI,
      functionName: paused ? "pause" : "unpause",
      args: [],
    });

    // Send transaction
    const hash = await walletClient.sendTransaction({
      account: cdpAccount,
      to: token.contract_address as `0x${string}`,
      data,
    });

    // Wait for receipt
    await publicClient.waitForTransactionReceipt({ hash });

    // Update database
    const { error: updateError } = await supabase
      .from("tokens")
      .update({ is_paused: paused })
      .eq("id", token_id);

    if (updateError) {
      console.error("Database update error:", updateError);
      // Don't fail the request if DB update fails - transaction already succeeded
    }

    return new Response(
      JSON.stringify({
        success: true,
        transaction_hash: hash,
        is_paused: paused,
      }),
      {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      }
    );

  } catch (e) {
    console.error("pause_token error", e);
    return new Response(
      JSON.stringify({ error: (e as Error).message }),
      {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      }
    );
  }
});

