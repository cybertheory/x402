// Setup type definitions for built-in Supabase Runtime APIs
import "jsr:@supabase/functions-js/edge-runtime.d.ts";

// Coinbase Developer Platform SDK (CDP) v2 Server Wallets
// Using npm specifier which is supported in Supabase Edge Runtime (Deno 2)
// Docs: https://docs.cdp.coinbase.com/server-wallets/v2/introduction/quickstart
import { CdpClient } from "npm:@coinbase/cdp-sdk";
import { corsHeaders } from "../_shared/cors.ts";
// Use dynamic imports for large dependencies to reduce initial bundle size
// These will be loaded only when needed (for EVM chains)

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
    let chain: string | undefined;
    try {
      const body = await req.json().catch(() => null);
      if (body && typeof body.chain === "string") {
        chain = body.chain;
      }
    } catch {
      // Ignore JSON parse errors; treat as no chain specified.
    }

    // Prefer CDP_* envs, but fall back to COINBASE_* to match your current naming.
    const apiKeyId =
      Deno.env.get("CDP_API_KEY_ID") ?? Deno.env.get("COINBASE_API_KEY_ID");
    const apiKeySecret =
      Deno.env.get("CDP_API_KEY_SECRET") ?? Deno.env.get("COINBASE_API_SECRET");
    const walletSecret = Deno.env.get("CDP_WALLET_SECRET");

    if (!apiKeyId || !apiKeySecret || !walletSecret) {
      console.error("CDP API env vars not configured (need API_KEY_ID, API_KEY_SECRET, WALLET_SECRET)");
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

    // Create an account depending on requested chain:
    // - EVM (Base / Base Sepolia) -> evm account
    // - Solana -> solana account
    // Store both address and account ID for signing operations
    let address: string;
    let accountId: string | null = null;
    let splitAddress: string | null = null;
    
    if (chain === "solana") {
      const account = await cdp.solana.createAccount();
      address = account.address;
      accountId = account.id || null;
    } else {
      const account = await cdp.evm.createAccount();
      address = account.address;
      accountId = account.id || null;
      
      // For EVM chains (base, base-sepolia), create a 0xsplits contract
      if (chain === "base" || chain === "base-sepolia") {
        try {
          // Dynamically import large dependencies only when needed
          const viem = await import("npm:viem");
          const viemChains = await import("npm:viem/chains");
          const splitsSdk = await import("npm:@0xsplits/splits-sdk");
          
          const { createPublicClient, createWalletClient, http, custom } = viem;
          const { base, baseSepolia } = viemChains;
          const { SplitV2Client, SplitV2Type } = splitsSdk;
          
          // Determine chain ID and platform wallet address
          const chainId = chain === "base" ? 8453 : 84532;
          const platformWallet = chain === "base" 
            ? "0x6e560Fd994dA2f434E95Cde3CAA868FB0bbCA8Ba"
            : "0x3d5Bd6147A52D2e8A269fEA5B3cB5478284d125E";
          
          // Get the appropriate viem chain
          const viemChain = chain === "base" ? base : baseSepolia;
          
          // Create public client for reading chain state
          const publicClient = createPublicClient({
            chain: viemChain,
            transport: http(),
          });
          
          // Create an EIP-1193 compatible provider that wraps CDP
          const cdpProvider = {
            request: async ({ method, params }: any) => {
              if (method === "eth_sendTransaction") {
                // Use CDP to send the transaction
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
              if (method === "eth_signTypedData_v4") {
                // Use CDP to sign typed data
                const paramsObj = typeof params[1] === "string" ? JSON.parse(params[1]) : params[1];
                const signed = await cdp.evm.signTypedData({
                  networkId: chainId.toString(),
                  domain: paramsObj.domain,
                  types: paramsObj.types,
                  message: paramsObj.message,
                  primaryType: paramsObj.primaryType,
                });
                return signed.signature;
              }
              if (method === "personal_sign") {
                // Use CDP to sign message
                const message = params[0];
                const signed = await cdp.evm.signMessage({
                  networkId: chainId.toString(),
                  message,
                });
                return signed.signature;
              }
              // For other methods (eth_call, eth_getBalance, etc.), use the public client
              try {
                return await publicClient.request({ method, params } as any);
              } catch (e) {
                // If public client fails, try to get from RPC directly
                const httpTransport = http();
                return httpTransport.request({ method, params });
              }
            },
          };
          
          // Create a custom account that uses CDP for signing
          const cdpAccount = {
            address: address as any,
            type: "local" as const,
            async signMessage({ message }: { message: string }) {
              const signed = await cdp.evm.signMessage({
                networkId: chainId.toString(),
                message,
              });
              return signed.signature as `0x${string}`;
            },
            async signTypedData(typedData: any) {
              const signed = await cdp.evm.signTypedData({
                networkId: chainId.toString(),
                domain: typedData.domain,
                types: typedData.types,
                message: typedData.message,
                primaryType: typedData.primaryType,
              });
              return signed.signature as `0x${string}`;
            },
          } as any;
          
          // Create wallet client with CDP provider using custom transport
          const walletClient = createWalletClient({
            chain: viemChain,
            transport: custom(cdpProvider),
            account: cdpAccount,
          });
          
          // Create SplitV2Client
          const splitsClient = new SplitV2Client({
            chainId,
            publicClient: publicClient as any,
            walletClient: walletClient as any,
          });
          
          // Create split with 1% to platform, 99% to wallet
          // The min/max caps (0.00005 USDC min, 0.01 USDC max) are fee caps, not split percentages
          const splitArgs = {
            recipients: [
              {
                address: platformWallet as any,
                percentAllocation: 1.0, // 1% to platform
              },
              {
                address: address as any,
                percentAllocation: 99.0, // 99% to wallet
              },
            ],
            distributorFeePercent: 0.0,
            totalAllocationPercent: 100.0,
            splitType: SplitV2Type.Pull,
            ownerAddress: address as any,
            creatorAddress: address as any,
          };
          
          const split = await splitsClient.createSplit(splitArgs);
          splitAddress = split.address;
          
          console.log(`Created split contract: ${splitAddress} for wallet: ${address}`);
        } catch (splitError) {
          console.error("Failed to create split contract:", splitError);
          // Continue without split address - wallet creation succeeded
          // The split_address will be null in the database
        }
      }
    }

    return new Response(
      JSON.stringify({ 
        address,
        accountId: accountId || null,
        splitAddress: splitAddress || null,
      }), 
      {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      }
    );
  } catch (e) {
    console.error("cdp_create_server_wallet error", e);
    return new Response(JSON.stringify({ error: (e as Error).message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});

/* To invoke locally:

  1. Run `supabase start` (see: https://supabase.com/docs/reference/cli/supabase-start)
  2. Configure secrets (CDP_API_KEY_NAME, CDP_API_KEY_PRIVATE_KEY, CDP_NETWORK_ID) in
     the Supabase dashboard or via `supabase secrets set`.
  3. Make an HTTP request:

  curl -i --location --request POST 'http://127.0.0.1:54321/functions/v1/cdp_create_server_wallet' \
    --header 'Authorization: Bearer <anon-or-service-role-jwt>' \
    --header 'Content-Type: application/json'

*/


