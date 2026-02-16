// Setup type definitions for built-in Supabase Runtime APIs
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { corsHeaders } from "../_shared/cors.ts";
import { getTenantId } from "../_shared/auth.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { CdpClient } from "npm:@coinbase/cdp-sdk";
import { createPublicClient, createWalletClient, http, custom, encodeDeployData, parseUnits } from "npm:viem";
import * as viemChains from "npm:viem/chains";

// ERC-20 Pausable Token ABI for deployment
const ERC20_PAUSABLE_ABI = [
  {
    type: "constructor",
    inputs: [
      { name: "name", type: "string" },
      { name: "symbol", type: "string" },
      { name: "decimals", type: "uint8" },
      { name: "initialSupply", type: "uint256" },
      { name: "maxSupply", type: "uint256" },
    ],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "mint",
    inputs: [
      { name: "to", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
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

// ERC-20 Pausable contract bytecode
// IMPORTANT: This must be set via ERC20_CONTRACT_BYTECODE environment variable
// You MUST compile a real ERC-20 Pausable contract and set the bytecode as an environment variable.
// 
// To get proper bytecode:
// 1. Write a Solidity contract using OpenZeppelin's ERC20Pausable
// 2. Compile it (e.g., using Hardhat, Foundry, or Remix)
// 3. Set ERC20_CONTRACT_BYTECODE environment variable with the compiled bytecode
// 4. Update ERC20_PAUSABLE_ABI to match your contract's ABI
//
// Example contract structure:
// ```solidity
// // SPDX-License-Identifier: MIT
// pragma solidity ^0.8.20;
// import "@openzeppelin/contracts/token/ERC20/extensions/ERC20Pausable.sol";
// import "@openzeppelin/contracts/access/Ownable.sol";
// 
// contract MyToken is ERC20Pausable, Ownable {
//   uint256 public maxSupply;
//   
//   constructor(
//     string memory name,
//     string memory symbol,
//     uint8 decimals,
//     uint256 initialSupply,
//     uint256 _maxSupply
//   ) ERC20(name, symbol) {
//     maxSupply = _maxSupply;
//     _mint(msg.sender, initialSupply);
//   }
//   
//   function mint(address to, uint256 amount) public onlyOwner {
//     require(maxSupply == 0 || totalSupply() + amount <= maxSupply, "Exceeds max supply");
//     _mint(to, amount);
//   }
// }
// ```
//
// Set via: supabase secrets set ERC20_CONTRACT_BYTECODE=0x...
function getContractBytecode(): `0x${string}` | null {
  const bytecode = Deno.env.get("ERC20_CONTRACT_BYTECODE");
  if (!bytecode || !bytecode.startsWith("0x")) {
    return null;
  }
  return bytecode as `0x${string}`;
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
    // Verify JWT and get tenant ID - this will throw if JWT is missing or invalid
    const tenantId = await getTenantId(req);
    const body = await req.json();
    const { name, symbol, decimals, initial_supply, max_supply, chain, wallet_id, external_address } = body;

    // Validate required fields
    if (!name || !symbol || !chain || decimals === undefined || !initial_supply) {
      return new Response(
        JSON.stringify({ error: "Missing required fields: name, symbol, decimals, initial_supply, chain" }),
        {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        }
      );
    }

    // Validate wallet selection
    if (!wallet_id && !external_address) {
      return new Response(
        JSON.stringify({ error: "Either wallet_id or external_address must be provided" }),
        {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        }
      );
    }

    // Get chain config
    const chainConfig = getChainConfig(chain);
    if (!chainConfig) {
      return new Response(
        JSON.stringify({ error: `Unsupported chain: ${chain}` }),
        {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        }
      );
    }

    // Get deployer address
    let deployerAddress: string;
    let deployerWalletId: string | null = null;

    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    if (!supabaseUrl || !supabaseServiceKey) {
      throw new Error("Supabase configuration missing");
    }

    const supabase = createClient(supabaseUrl, supabaseServiceKey, {
      auth: { persistSession: false },
    });

    if (wallet_id) {
      // Get wallet from database
      const { data: wallet, error: walletError } = await supabase
        .from("wallets")
        .select("address, chain, tenant_id")
        .eq("id", wallet_id)
        .eq("tenant_id", tenantId)
        .single();

      if (walletError || !wallet) {
        return new Response(
          JSON.stringify({ error: "Wallet not found or access denied" }),
          {
            status: 404,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          }
        );
      }

      if (wallet.chain !== chain) {
        return new Response(
          JSON.stringify({ error: `Wallet chain (${wallet.chain}) does not match token chain (${chain})` }),
          {
            status: 400,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          }
        );
      }

      deployerAddress = wallet.address;
      deployerWalletId = wallet_id;
    } else {
      // Validate external address format
      if (!/^0x[a-fA-F0-9]{40}$/.test(external_address)) {
        return new Response(
          JSON.stringify({ error: "Invalid Ethereum address format" }),
          {
            status: 400,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          }
        );
      }
      deployerAddress = external_address;
    }

    // For external wallets, we can't sign without private key
    // For now, only support x402Instant wallets (CDP)
    if (!wallet_id) {
      return new Response(
        JSON.stringify({ error: "External wallet deployment not yet supported. Please use an x402Instant wallet." }),
        {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        }
      );
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

    // Create CDP provider wrapper
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
        // For other methods, use public client
        return await publicClient.request({ method, params } as any);
      },
    };

    // Create CDP account wrapper
    const cdpAccount = {
      address: deployerAddress as `0x${string}`,
      type: "local" as const,
    } as any;

    // Create wallet client with CDP provider
    const walletClient = createWalletClient({
      chain: chainConfig.chain,
      transport: custom(cdpProvider),
      account: cdpAccount,
    });

    // Get contract bytecode from environment variable
    const contractBytecode = getContractBytecode();
    if (!contractBytecode) {
      return new Response(
        JSON.stringify({ 
          error: "ERC-20 contract bytecode not configured",
          message: "The ERC20_CONTRACT_BYTECODE environment variable must be set with compiled contract bytecode. Please compile an ERC20Pausable contract and set it via: supabase secrets set ERC20_CONTRACT_BYTECODE=0x..."
        }),
        {
          status: 501,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        }
      );
    }

    // Encode constructor parameters
    const decimalsNum = Number(decimals);
    const initialSupplyBigInt = parseUnits(initial_supply.toString(), decimalsNum);
    const maxSupplyBigInt = max_supply ? parseUnits(max_supply.toString(), decimalsNum) : BigInt(0);

    // Encode deployment data
    const deploymentData = encodeDeployData({
      abi: ERC20_PAUSABLE_ABI,
      bytecode: contractBytecode,
      args: [name, symbol, decimalsNum, initialSupplyBigInt, maxSupplyBigInt],
    });

    // Deploy contract
    const hash = await walletClient.sendTransaction({
      account: cdpAccount,
      data: deploymentData,
    });

    // Wait for transaction receipt
    const receipt = await publicClient.waitForTransactionReceipt({ hash });

    if (!receipt.contractAddress) {
      throw new Error("Contract deployment failed - no contract address in receipt");
    }

    const contractAddress = receipt.contractAddress;

    // Store token in database
    const { data: token, error: dbError } = await supabase
      .from("tokens")
      .insert({
        tenant_id: tenantId,
        name,
        symbol,
        decimals: decimalsNum,
        initial_supply: initial_supply.toString(),
        max_supply: max_supply ? max_supply.toString() : null,
        contract_address: contractAddress,
        chain,
        deployer_wallet_id: deployerWalletId,
        deployer_address: deployerAddress,
        is_paused: false,
      })
      .select()
      .single();

    if (dbError) {
      console.error("Database error:", dbError);
      throw new Error(`Failed to store token: ${dbError.message}`);
    }

    return new Response(
      JSON.stringify({
        success: true,
        token_id: token.id,
        contract_address: contractAddress,
        transaction_hash: hash,
      }),
      {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      }
    );

  } catch (e) {
    console.error("create_token error", e);
    return new Response(
      JSON.stringify({ error: (e as Error).message }),
      {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      }
    );
  }
});

