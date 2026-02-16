// Setup type definitions for built-in Supabase Runtime APIs
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { corsHeaders } from "../_shared/cors.ts";
import { getTenantIdFromRequest } from "../_shared/auth.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { CdpClient } from "npm:@coinbase/cdp-sdk";
import { createPublicClient, createWalletClient, http, custom } from "npm:viem";
import * as viemChains from "npm:viem/chains";
import { x402Client } from "npm:@x402/core/client";
import { x402HTTPClient } from "npm:@x402/core/http";
import { registerExactEvmScheme } from "npm:@x402/evm/exact/client";

interface PaymentRequirement {
  scheme: string;
  network: string;
  asset: string;
  payTo: string;
  maxAmountRequired: string;
  resource?: string;
  description?: string;
  mimeType?: string;
  maxTimeoutSeconds?: number;
}

interface PaymentRequired {
  x402Version: number;
  accepts: PaymentRequirement[];
  error?: string;
  resource?: {
    uri: string;
    method?: string;
  };
}

function getChainConfig(chain: string): { chain: any; rpcUrl: string } | null {
  const alchemyKey = Deno.env.get("ALCHEMY_API_KEY");
  if (!alchemyKey) {
    throw new Error("ALCHEMY_API_KEY not configured");
  }

  const chainMap: Record<string, { chain: viem.Chain; rpcUrl: string }> = {
    "base": {
      chain: viemChains.base,
      rpcUrl: `https://base-mainnet.g.alchemy.com/v2/${alchemyKey}`,
    },
    "base-sepolia": {
      chain: viemChains.baseSepolia,
      rpcUrl: `https://base-sepolia.g.alchemy.com/v2/${alchemyKey}`,
    },
    "ethereum": {
      chain: viemChains.mainnet,
      rpcUrl: `https://eth-mainnet.g.alchemy.com/v2/${alchemyKey}`,
    },
    "ethereum-sepolia": {
      chain: viemChains.sepolia,
      rpcUrl: `https://eth-sepolia.g.alchemy.com/v2/${alchemyKey}`,
    },
    "arbitrum": {
      chain: viemChains.arbitrum,
      rpcUrl: `https://arb-mainnet.g.alchemy.com/v2/${alchemyKey}`,
    },
    "arbitrum-sepolia": {
      chain: viemChains.arbitrumSepolia,
      rpcUrl: `https://arb-sepolia.g.alchemy.com/v2/${alchemyKey}`,
    },
    "optimism": {
      chain: viemChains.optimism,
      rpcUrl: `https://opt-mainnet.g.alchemy.com/v2/${alchemyKey}`,
    },
    "optimism-sepolia": {
      chain: viemChains.optimismSepolia,
      rpcUrl: `https://opt-sepolia.g.alchemy.com/v2/${alchemyKey}`,
    },
    "polygon": {
      chain: viemChains.polygon,
      rpcUrl: `https://polygon-mainnet.g.alchemy.com/v2/${alchemyKey}`,
    },
    "polygon-mumbai": {
      chain: viemChains.polygonMumbai,
      rpcUrl: `https://polygon-mumbai.g.alchemy.com/v2/${alchemyKey}`,
    },
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
    // Verify API key or JWT and get tenant ID - this will throw if auth is missing or invalid
    const tenantId = await getTenantIdFromRequest(req);
    const body = await req.json();
    const { wallet_id, paymentRequired } = body;

    // Validate required fields
    if (!paymentRequired) {
      return new Response(
        JSON.stringify({ error: "Missing required field: paymentRequired" }),
        {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        }
      );
    }

    const paymentReq = paymentRequired as PaymentRequired;
    if (!paymentReq.accepts || paymentReq.accepts.length === 0) {
      return new Response(
        JSON.stringify({ error: "paymentRequired.accepts must have at least one requirement" }),
        {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        }
      );
    }

    const requirement = paymentReq.accepts[0];
    const network = requirement.network.toLowerCase();

    // Get chain config
    const chainConfig = getChainConfig(network);
    if (!chainConfig) {
      return new Response(
        JSON.stringify({ error: `Unsupported chain: ${network}` }),
        {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        }
      );
    }

    // Get Supabase service client to query wallets
    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    if (!supabaseUrl || !supabaseServiceKey) {
      throw new Error("Supabase configuration missing");
    }

    const supabase = createClient(supabaseUrl, supabaseServiceKey, {
      auth: { persistSession: false },
    });

    // Fetch wallet (or default if not provided)
    let wallet;
    if (wallet_id) {
      const { data: walletData, error: walletError } = await supabase
        .from("wallets")
        .select("id, address, chain, tenant_id, cdp_account_id, kind")
        .eq("id", wallet_id)
        .eq("tenant_id", tenantId)
        .single();

      if (walletError || !walletData) {
        return new Response(
          JSON.stringify({ error: "Wallet not found or access denied" }),
          {
            status: 404,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          }
        );
      }

      if (walletData.chain !== network) {
        return new Response(
          JSON.stringify({ error: `Wallet chain (${walletData.chain}) does not match payment requirement network (${network})` }),
          {
            status: 400,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          }
        );
      }

      wallet = walletData;
    } else {
      // Fetch default wallet for tenant
      const { data: wallets, error: walletsError } = await supabase
        .from("wallets")
        .select("id, address, chain, tenant_id, is_default, cdp_account_id, kind")
        .eq("tenant_id", tenantId)
        .eq("chain", network)
        .order("is_default", { ascending: false })
        .order("created_at", { ascending: false })
        .limit(1);

      if (walletsError) {
        throw new Error(`Failed to fetch wallets: ${walletsError.message}`);
      }

      if (!wallets || wallets.length === 0) {
        return new Response(
          JSON.stringify({ error: `No wallet found for chain ${network}. Please create a wallet first.` }),
          {
            status: 404,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          }
        );
      }

      wallet = wallets[0];
    }

    // Initialize CDP client for signing
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

    // Get chain ID
    const chainId = chainConfig.chain.id;

    // Create public client
    const publicClient = createPublicClient({
      chain: chainConfig.chain,
      transport: http(chainConfig.rpcUrl),
    });

    // Create CDP provider wrapper for signing
    const cdpProvider = {
      request: async ({ method, params }: any) => {
        if (method === "eth_signTypedData_v4" || method === "eth_signTypedData") {
          // Use CDP to sign typed data
          const paramsObj = typeof params[1] === "string" ? JSON.parse(params[1]) : params[1];
          const signParams: any = {
            address: wallet.address,  // Required by CDP SDK
            networkId: chainId.toString(),
            domain: paramsObj.domain,
            types: paramsObj.types,
            message: paramsObj.message,
            primaryType: paramsObj.primaryType,
          };
          
          // Add accountId if available (for server wallets)
          if (wallet.kind === "coinbase" && wallet.cdp_account_id) {
            signParams.accountId = wallet.cdp_account_id;
            console.log(`[wallet-pay] Using CDP account ID: ${wallet.cdp_account_id} for wallet ${wallet.id}`);
          }
          
          const signed = await cdp.evm.signTypedData(signParams);
          return signed.signature;
        }
        // For other methods, use public client
        return await publicClient.request({ method, params } as any);
      },
    };

    // Create CDP account wrapper
    const cdpAccount = {
      address: wallet.address as `0x${string}`,
      type: "local" as const,
    } as any;

    // Create wallet client with CDP provider
    const walletClient = createWalletClient({
      chain: chainConfig.chain,
      transport: custom(cdpProvider),
      account: cdpAccount,
    });

    // Create signer that uses CDP for EIP-712 signing
    const evmSigner = {
      address: wallet.address as `0x${string}`,
      signTypedData: async (message: {
        domain: Record<string, unknown>;
        types: Record<string, unknown>;
        primaryType: string;
        message: Record<string, unknown>;
      }): Promise<`0x${string}`> => {
        // Use CDP SDK directly for signing
      // If wallet has a CDP account ID, use it to specify which account to sign with
      const signParams: any = {
        address: wallet.address,  // Required by CDP SDK
        networkId: chainId.toString(),
        domain: message.domain,
        types: message.types,
        message: message.message,
        primaryType: message.primaryType,
      };
      
      // Add accountId if available (for server wallets)
      if (wallet.kind === "coinbase" && wallet.cdp_account_id) {
        signParams.accountId = wallet.cdp_account_id;
        console.log(`[wallet-pay] Using CDP account ID: ${wallet.cdp_account_id} for wallet ${wallet.id}`);
      }
      
      const signed = await cdp.evm.signTypedData(signParams);
      return signed.signature as `0x${string}`;
      },
    };

    // Create x402 client and register EVM exact scheme
    const coreClient = new x402Client();
    registerExactEvmScheme(coreClient, { signer: evmSigner });

    // Wrap with HTTP client for header encoding
    const client = new x402HTTPClient(coreClient);

    // Prepare payment required object - ensure resource is set
    const paymentRequiredForClient: any = {
      ...paymentReq,
      resource: paymentReq.resource || {
        uri: requirement.resource || '',
        method: 'GET',
      },
    };

    // Create payment payload - x402 client handles ERC-3009 signing
    const paymentPayload = await client.createPaymentPayload(paymentRequiredForClient);

    // Encode as header - returns base64 JSON string
    const paymentHeaders = client.encodePaymentSignatureHeader(paymentPayload);
    const paymentSignature = paymentHeaders['PAYMENT-SIGNATURE'] || 
                            paymentHeaders['payment-signature'] || 
                            paymentHeaders['X-PAYMENT'] || 
                            paymentHeaders['x-payment'];
    
    if (!paymentSignature) {
      throw new Error('Failed to extract payment signature from headers');
    }

    return new Response(
      JSON.stringify({
        success: true,
        signature: paymentSignature,
        wallet_id: wallet.id,
        wallet_address: wallet.address,
      }),
      {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      }
    );

  } catch (e) {
    console.error("wallet-pay error", e);
    return new Response(
      JSON.stringify({ error: (e as Error).message }),
      {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      }
    );
  }
});

