// Polyfill Buffer for CDP SDK compatibility
import { Buffer } from "node:buffer";
globalThis.Buffer = Buffer;

// Use CDP SDK for authentication (JWT generation)
import { generateJwt } from "@coinbase/cdp-sdk/auth";
import { sha256 } from "@noble/hashes/sha256";
import { keccak_256 } from "@noble/hashes/sha3";

// Use x402 SDK's HTTPFacilitatorClient
import { HTTPFacilitatorClient } from "@x402/core/server";

// Facilitator URLs
const CDP_FACILITATOR_URL = "https://api.cdp.coinbase.com/platform/v2/x402";
const TESTNET_FACILITATOR_URL = "https://x402.org/facilitator";

const MY_FACILITATOR_URL = "https://facilitator.x402instant.com";

function createMyFacilitatorClient(env) {
  return new HTTPFacilitatorClient({
    url: MY_FACILITATOR_URL,
    // Only add this if YOUR facilitator enforces bearer auth
    createAuthHeaders: env.FACILITATOR_AUTH_TOKEN
      ? async () => ({
          verify: { authorization: `Bearer ${env.FACILITATOR_AUTH_TOKEN}` },
          settle: { authorization: `Bearer ${env.FACILITATOR_AUTH_TOKEN}` },
          supported: { authorization: `Bearer ${env.FACILITATOR_AUTH_TOKEN}` },
        })
      : undefined,
  });
}

/* ----------------- Thirdweb Facilitator for "upto" scheme ----------------- */

// Thirdweb facilitator URL (their hosted service)
const THIRDWEB_FACILITATOR_URL = "https://x402.thirdweb.com";

/**
 * Create a Thirdweb-compatible facilitator client for "upto" scheme
 * Uses HTTP API directly since thirdweb SDK may not be available in Workers
 * Server wallet address comes from paymentRequirement.payTo (like CDP)
 */
function createThirdwebFacilitatorClient(env) {
  const secretKey = env.THIRDWEB_SECRET_KEY;
  
  if (!secretKey) {
    console.warn("Thirdweb credentials not configured. THIRDWEB_SECRET_KEY required for upto scheme.");
    return null;
  }
  
  return {
    url: THIRDWEB_FACILITATOR_URL,
    secretKey,
    
    /**
     * Verify payment for upto scheme
     * @param {Object} paymentPayload - The payment payload from client
     * @param {Object} paymentRequirement - The payment requirement (payTo is used as serverWalletAddress)
     * @returns {Promise<{isValid: boolean, invalidReason?: string}>}
     */
    async verify(paymentPayload, paymentRequirement) {
      // Use payTo from requirement as the server wallet address (like CDP does)
      const serverWalletAddress = paymentRequirement.payTo;
      
      const response = await fetch(`${THIRDWEB_FACILITATOR_URL}/v2/x402/verify`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-secret-key": secretKey,
        },
        body: JSON.stringify({
          paymentPayload,
          paymentRequirements: paymentRequirement,
          scheme: "upto",
          serverWalletAddress,
        }),
      });
      
      if (!response.ok) {
        const text = await response.text();
        console.error("Thirdweb verify failed:", response.status, text);
        return { isValid: false, invalidReason: `Thirdweb verify failed: ${response.status}` };
      }
      
      const result = await response.json();
      return result;
    },
    
    /**
     * Settle payment for upto scheme with actual amount
     * @param {Object} paymentPayload - The payment payload from client
     * @param {Object} paymentRequirement - The payment requirement (payTo is used as serverWalletAddress)
     * @param {string} actualAmount - The actual amount to settle (in token base units)
     * @returns {Promise<{success: boolean, transaction?: string, error?: string}>}
     */
    async settle(paymentPayload, paymentRequirement, actualAmount) {
      // Use payTo from requirement as the server wallet address (like CDP does)
      const serverWalletAddress = paymentRequirement.payTo;
      
      // For upto scheme, we pass the actual amount to settle
      const settleRequirement = {
        ...paymentRequirement,
        maxAmountRequired: actualAmount, // Settle for actual amount, not max
      };
      
      const response = await fetch(`${THIRDWEB_FACILITATOR_URL}/v2/x402/settle`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-secret-key": secretKey,
        },
        body: JSON.stringify({
          paymentPayload,
          paymentRequirements: settleRequirement,
          scheme: "upto",
          serverWalletAddress,
        }),
      });
      
      if (!response.ok) {
        const text = await response.text();
        console.error("Thirdweb settle failed:", response.status, text);
        return { success: false, error: `Thirdweb settle failed: ${response.status}` };
      }
      
      const result = await response.json();
      return { success: true, ...result };
    },
  };
}

/* ----------------- Token Counting Utilities ----------------- */

/**
 * Extract token usage and cost from OpenRouter/OpenAI API response
 * OpenRouter returns actual cost in usage.cost (in USD), which is more accurate
 * than calculating from tokens since it accounts for the actual model/provider used.
 * 
 * @param {string} responseBody - JSON response body from API
 * @returns {{promptTokens: number, completionTokens: number, totalTokens: number, cost: number|null} | null}
 */
function extractTokenUsage(responseBody) {
  try {
    const data = JSON.parse(responseBody);
    if (data.usage) {
      return {
        promptTokens: data.usage.prompt_tokens || 0,
        completionTokens: data.usage.completion_tokens || 0,
        totalTokens: data.usage.total_tokens || 0,
        // OpenRouter returns actual cost in USD (e.g., 0.00014)
        // This is more accurate than token-based calculation
        cost: data.usage.cost ?? null,
      };
    }
    // Some APIs use different field names
    if (data.meta?.tokens) {
      return {
        promptTokens: data.meta.tokens.input || 0,
        completionTokens: data.meta.tokens.output || 0,
        totalTokens: (data.meta.tokens.input || 0) + (data.meta.tokens.output || 0),
        cost: null, // Alternative format doesn't include cost
      };
    }
  } catch (e) {
    console.error("Failed to parse token usage:", e);
  }
  return null;
}

/**
 * Convert USD cost to micro-USDC (6 decimals)
 * @param {number} usdCost - Cost in USD (e.g., 0.00014)
 * @param {number} markup - Markup percentage (e.g., 1.1 for 10% markup)
 * @returns {string} - Cost in micro-USDC as string
 */
function usdToMicroUsdc(usdCost, markup = 1.0) {
  // Convert USD to micro-USDC (multiply by 1,000,000)
  // Apply markup and round up to nearest micro-USDC
  const microUsdc = Math.ceil(usdCost * 1_000_000 * markup);
  return String(microUsdc);
}

/**
 * Calculate actual price based on token usage
 * @param {{totalTokens: number}} tokenUsage - Token usage from response
 * @param {string|number} pricePerToken - Price per token in USDC micro-units (6 decimals)
 * @param {string|number} minPrice - Minimum price to charge (in USDC micro-units)
 * @returns {string} - Actual price in USDC micro-units as string
 */
function calculateActualPrice(tokenUsage, pricePerToken, minPrice = "1") {
  const tokens = tokenUsage.totalTokens;
  const perToken = typeof pricePerToken === "string" ? parseInt(pricePerToken, 10) : pricePerToken;
  const min = typeof minPrice === "string" ? parseInt(minPrice, 10) : minPrice;
  
  // Calculate: tokens * pricePerToken, with minimum
  const calculated = Math.ceil(tokens * perToken);
  const actual = Math.max(calculated, min);
  
  return String(actual);
}

/**
 * Safely parse JSON, returning null on failure
 * @param {string} str - String to parse
 * @returns {object|null} Parsed object or null
 */
function safeJsonParse(str) {
  try {
    return JSON.parse(str);
  } catch {
    return null;
  }
}

/* ----------------- EIP-55 Checksum Utilities ----------------- */

/**
 * Strip 0x prefix from hex string
 */
function strip0x(hex) {
  if (typeof hex !== "string") return hex;
  return hex.startsWith("0x") ? hex.slice(2) : hex;
}

/**
 * Convert address to EIP-55 checksummed format
 * @param {string} addr - Address to checksum (with or without 0x)
 * @returns {string} Checksummed address with 0x prefix
 */
function toChecksumAddress(addr) {
  if (!addr) return addr;
  const address = strip0x(addr).toLowerCase();
  if (address.length !== 40) {
    throw new Error(`Invalid address length: ${address.length}`);
  }
  
  // Compute keccak256 hash of lowercase address
  const hash = keccak_256(new TextEncoder().encode(address));
  const hashHex = Array.from(hash)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  
  // Build checksummed address
  let checksummed = "0x";
  for (let i = 0; i < 40; i++) {
    const char = address[i];
    const hashChar = hashHex[i];
    // Uppercase if hash nibble >= 8, otherwise keep lowercase
    checksummed += parseInt(hashChar, 16) >= 8 ? char.toUpperCase() : char;
  }
  
  return checksummed;
}

/**
 * Validate hex address format (0x + 40 hex chars)
 */
function isValidHexAddress(addr) {
  if (!addr || typeof addr !== "string") return false;
  return /^0x[a-fA-F0-9]{40}$/.test(addr);
}

/**
 * Check if address is EIP-55 checksummed
 */
function isChecksumAddress(addr) {
  if (!isValidHexAddress(addr)) return false;
  try {
    return addr === toChecksumAddress(addr);
  } catch {
    return false;
  }
}

/**
 * Create an authenticated HTTPFacilitatorClient for CDP mainnet
 * Uses HTTPFacilitatorClient with createAuthHeaders for JWT authentication
 */
function createMainnetFacilitatorClient(apiKeyId, apiKeySecret) {
  return new HTTPFacilitatorClient({
    url: CDP_FACILITATOR_URL,
    createAuthHeaders: async () => {
      // Generate JWT tokens for each endpoint
      const basePath = "/platform/v2/x402";
      
      const verifyJwt = await generateJwt({
        apiKeyId,
        apiKeySecret,
        requestMethod: "POST",
        requestHost: "api.cdp.coinbase.com",
        requestPath: `${basePath}/verify`,
        expiresIn: 120,
      });
      
      const settleJwt = await generateJwt({
        apiKeyId,
        apiKeySecret,
        requestMethod: "POST",
        requestHost: "api.cdp.coinbase.com",
        requestPath: `${basePath}/settle`,
        expiresIn: 120,
      });
      
      const supportedJwt = await generateJwt({
        apiKeyId,
        apiKeySecret,
        requestMethod: "GET",
        requestHost: "api.cdp.coinbase.com",
        requestPath: `${basePath}/supported`,
        expiresIn: 120,
      });
      
      return {
        verify: {
          authorization: `Bearer ${verifyJwt}`,
        },
        settle: {
          authorization: `Bearer ${settleJwt}`,
        },
        supported: {
          authorization: `Bearer ${supportedJwt}`,
        },
      };
    },
  });
}

/**
 * Create an HTTPFacilitatorClient for x402.org testnet facilitator
 * No authentication required
 */
function createTestnetFacilitatorClient() {
  return new HTTPFacilitatorClient({
    url: TESTNET_FACILITATOR_URL,
    // No createAuthHeaders - testnet facilitator doesn't require auth
  });
}

/**
 * Multi-tenant x402 gateway using Coinbase CDP facilitator for verify+settle.
 *
 * TENANT SELECTION (same as your original):
 *  - uses incoming Host header
 *  - loads JSON config from env.TENANTS at key `cfg:${host}`
 *
 * PAYMENT FLOW:
 *  - If route has price: return 402 with PAYMENT-REQUIRED (b64 JSON)
 *  - Client retries with PAYMENT-SIGNATURE (or legacy X-PAYMENT)
 *  - Worker calls CDP facilitator:
 *      POST https://api.cdp.coinbase.com/platform/v2/x402/verify
 *      POST https://api.cdp.coinbase.com/platform/v2/x402/settle
 *
 * REPLAY PROTECTION:
 *  - KV env.NONCES (optional) stores used nonces/hashes per-tenant
 *
 * REQUIRED BINDINGS:
 *  - env.TENANTS (KV): tenant configs by host
 *  - env.NONCES (KV): replay protection (recommended)
 *
 * REQUIRED SECRETS/ENV for CDP facilitator (global defaults, can be overridden per tenant):
 *  - env.CDP_API_KEY_ID
 *  - env.CDP_API_KEY_SECRET (CDP API key secret - the SDK handles format conversion)
 *
 * Docs:
 *  - CDP facilitator endpoints: POST /v2/x402/verify, POST /v2/x402/settle :contentReference[oaicite:3]{index=3}
 *  - Verify request includes paymentPayload + paymentRequirements :contentReference[oaicite:4]{index=4}
 */

// CDP API endpoints are now handled by SDK methods
// verifyX402Payment and settleX402Payment handle the correct paths automatically

/* ----------------- CORS helpers ----------------- */

function getCorsHeaders(request) {
  const origin = request.headers.get("origin");
  // Allow localhost for development - be more permissive
  const allowedOrigins = [
    "http://localhost:5173",
    "http://localhost:3000",
    "http://127.0.0.1:5173",
    "http://127.0.0.1:3000",
  ];
  
  // Check if origin is in allowed list or starts with localhost/127.0.0.1 (for development)
  const isLocalhost = origin && (
    origin.startsWith("http://localhost:") ||
    origin.startsWith("http://127.0.0.1:") ||
    allowedOrigins.includes(origin)
  );
  
  // For development: if it's localhost, use the origin; otherwise use "*" but don't set credentials
  // For production: you'd want to be more restrictive
  const allowOrigin = isLocalhost ? origin : "*";
  
  const headers = {
    "Access-Control-Allow-Origin": allowOrigin,
    "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS, PATCH",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, PAYMENT-SIGNATURE, payment-signature, X-PAYMENT, x-payment, Accept",
    "Access-Control-Expose-Headers": "PAYMENT-REQUIRED, X-PAYMENT-REQUIRED, PAYMENT-RESPONSE, X-PAYMENT-RESPONSE",
  };
  
  // Only set credentials if origin is explicitly allowed (required when using credentials: true)
  // When credentials is true, origin cannot be "*"
  if (isLocalhost) {
    headers["Access-Control-Allow-Credentials"] = "true";
  }
  
  return headers;
}

function addCorsHeaders(headers, request) {
  const corsHeaders = getCorsHeaders(request);
  const newHeaders = new Headers(headers);
  for (const [key, value] of Object.entries(corsHeaders)) {
    newHeaders.set(key, value);
  }
  return newHeaders;
}

export default {
  async fetch(request, env, ctx) {
    // Handle CORS preflight - must be first to avoid any processing
    if (request.method === "OPTIONS") {
      const corsHeaders = getCorsHeaders(request);
      // Add cache control for preflight
      corsHeaders["Access-Control-Max-Age"] = "86400"; // 24 hours
      return new Response(null, {
        status: 204,
        headers: corsHeaders,
      });
    }
    // --------- MULTI-TENANT LOOKUP (same pattern as your original) ----------
    const host = request.headers.get("host");
    const cfgKey = `cfg:${host}`;
    const cfgRaw = await env.TENANTS.get(cfgKey);
    if (!cfgRaw) {
      return new Response("Unknown tenant", {
        status: 404,
        headers: getCorsHeaders(request),
      });
    }

    let cfg;
    try {
      cfg = JSON.parse(cfgRaw);
    } catch {
      return new Response("Tenant config invalid JSON", {
        status: 500,
        headers: getCorsHeaders(request),
      });
    }

    if (cfg.status !== "active") {
      return new Response("Tenant disabled", {
        status: 403,
        headers: getCorsHeaders(request),
      });
    }

    // Optional bypass: if already authenticated, proxy
    if (hasAuthBypassHeaders(request)) {
      const resp = await proxyToOrigin(request, cfg, null, env, matchedRoute?.origin);
      // Forward origin headers as-is, don't add CORS (let origin handle it)
      return new Response(resp.body, {
        status: resp.status,
        statusText: resp.statusText,
        headers: resp.headers,
      });
    }

    // Route + pricing
    const url = new URL(request.url);
    const matchedRoute = matchRoute(cfg, url, request.method);

    const requiresPayment = Boolean(matchedRoute?.price);
    if (!requiresPayment) {
      const resp = await proxyToOrigin(request, cfg, null, env, matchedRoute?.origin);
      // Forward origin headers as-is, don't add CORS (let origin handle it)
      return new Response(resp.body, {
        status: resp.status,
        statusText: resp.statusText,
        headers: resp.headers,
      });
    }

    // Payment header: modern + legacy
    const paymentHeader =
      request.headers.get("PAYMENT-SIGNATURE") ||
      request.headers.get("payment-signature") ||
      request.headers.get("X-PAYMENT") ||
      request.headers.get("x-payment");

    // Build per-request/per-tenant PaymentRequired challenge
    const { paymentRequiredB64, paymentRequiredObj, selectedRequirement } =
      buildPaymentRequiredHeader(request, cfg, env);

    if (!paymentHeader) {
      return respond402(paymentRequiredObj, paymentRequiredB64, request);
    }

    // Parse PaymentPayload (client usually sends JSON; some send b64 JSON)
    const paymentPayload = parseMaybeB64Json(paymentHeader);
    if (!paymentPayload) {
      return respond402(
        { ...paymentRequiredObj, error: "malformed_payment_header" },
        paymentRequiredB64,
        request
      );
    }

    // Normalize payload to facilitator schema: {x402Version, scheme, network, payload}
    const normalizedPayload = normalizePaymentPayload(paymentPayload);
    
    // Log normalized payload for debugging
    console.log("Normalized payload for facilitator:", JSON.stringify(normalizedPayload, null, 2));

    // Replay protection key (tenant-scoped)
    const replayKey = await computeReplayKey(cfgKey, normalizedPayload);
    const replayCheck = await assertNotUsedAndMark(env, replayKey, 86400);
    if (!replayCheck.ok) {
      return respond402(
        { ...paymentRequiredObj, error: "payment_replay_detected" },
        paymentRequiredB64,
        request
      );
    }

    // CDP credentials (allow per-tenant override, else env defaults)
    const cdpKeyId = cfg?.cdp?.apiKeyId || env.CDP_API_KEY_ID;
    const cdpKeySecret = cfg?.cdp?.apiKeySecret || env.CDP_API_KEY_SECRET;

    if (!cdpKeyId || !cdpKeySecret) {
      return new Response("CDP credentials not configured", {
        status: 500,
        headers: getCorsHeaders(request),
      });
    }

    // CDP facilitator expects "base-sepolia" style network enums, not CAIP-2.
    // Use the exact selectedRequirement from accepts[] that matches the request route/resource
    const facilitatorRequirement = selectedRequirement;
    const facilitatorPayload = normalizedPayload;

    // Log parsed payment payload fields used for verify
    console.log("Parsed payment payload for verify:", {
      network: facilitatorPayload.network,
      asset: facilitatorPayload.payload?.authorization?.to || "N/A",
      payTo: facilitatorRequirement.payTo,
      amount: facilitatorPayload.payload?.authorization?.value || "N/A",
      resource: facilitatorRequirement.resource,
      scheme: facilitatorPayload.scheme,
    });

    // Log payment requirements being sent to facilitator
    console.log("Payment requirements for facilitator:", JSON.stringify(facilitatorRequirement, null, 2));
    console.log("Normalized payload for facilitator:", JSON.stringify(facilitatorPayload, null, 2));
    console.log("Normalized payload domain check:", {
      hasDomain: !!(facilitatorPayload.payload?.eip712Domain || facilitatorPayload.payload?.domain),
      domainKeys: facilitatorPayload.payload?.eip712Domain ? Object.keys(facilitatorPayload.payload.eip712Domain) : [],
      hasEip712Domain: !!facilitatorPayload.payload?.eip712Domain,
      hasDomainField: !!facilitatorPayload.payload?.domain,
    });
    
    // Validate payload structure before sending to facilitator
    if (!facilitatorPayload.x402Version || !facilitatorPayload.scheme || !facilitatorPayload.network || !facilitatorPayload.payload) {
      console.error("Invalid facilitator payload structure:", {
        hasX402Version: !!facilitatorPayload.x402Version,
        hasScheme: !!facilitatorPayload.scheme,
        hasNetwork: !!facilitatorPayload.network,
        hasPayload: !!facilitatorPayload.payload,
        payloadStructure: Object.keys(facilitatorPayload),
      });
      return respond402(
        {
          ...paymentRequiredObj,
          error: "invalid_payload_structure",
          invalidReason: "Payment payload missing required fields",
        },
        paymentRequiredB64,
        request
      );
    }
    
    // --------- Facilitator VERIFY & SETTLE using x402 SDK HTTPFacilitatorClient ----------
    // Select facilitator based on SCHEME first, then network
    const network = selectedRequirement.network;
    const scheme = selectedRequirement.scheme || "exact";
    
    // For "upto" scheme, use Thirdweb facilitator (supports variable pricing)
    // For "exact" scheme, use CDP or testnet facilitator
    let facilitator;
    let facilitatorUrl;
    let isUptoScheme = scheme === "upto";
    
    if (isUptoScheme) {
      // Use Thirdweb facilitator for "upto" scheme
      facilitator = createThirdwebFacilitatorClient(env);
      facilitatorUrl = THIRDWEB_FACILITATOR_URL;
      
      if (!facilitator) {
        return respond402(
          {
            ...paymentRequiredObj,
            error: "thirdweb_not_configured",
            invalidReason: "Upto scheme requires THIRDWEB_SECRET_KEY",
          },
          paymentRequiredB64,
          request
        );
      }
      
      console.log(`Using Thirdweb facilitator for upto scheme on network ${network}`);
    } else {
      // Use existing facilitators for "exact" scheme
      // Priority: our custom facilitator for Base networks, fallback to CDP/testnet
      if (network === "base" || network === "base-sepolia") {
        // Use our custom facilitator for all Base networks
        facilitator = createMyFacilitatorClient(env);
        facilitatorUrl = MY_FACILITATOR_URL;
        console.log(`Using custom facilitator ${facilitatorUrl} for exact scheme on network ${network}`);
      } else if (network === "solana-devnet") {
        facilitator = createTestnetFacilitatorClient();
        facilitatorUrl = TESTNET_FACILITATOR_URL;
        console.log(`Using ${facilitatorUrl} for exact scheme on network ${network}`);
      } else {
        facilitator = createMainnetFacilitatorClient(cdpKeyId, cdpKeySecret);
        facilitatorUrl = CDP_FACILITATOR_URL;
        console.log(`Using ${facilitatorUrl} for exact scheme on network ${network}`);
      }
    }

    // Check for network mismatch before verify
    if (facilitatorPayload.network !== facilitatorRequirement.network) {
      return respond402(
        {
          ...paymentRequiredObj,
          error: "invalid_payload_structure",
          invalidReason: `Network mismatch: payload=${facilitatorPayload.network} requirement=${facilitatorRequirement.network}`,
        },
        paymentRequiredB64,
        request
      );
    }

    // Debug log: exact facilitatorRequirement object being passed to verify
    console.log("facilitatorRequirement being sent to CDP verify:", {
      scheme: facilitatorRequirement.scheme,
      network: facilitatorRequirement.network,
      payTo: facilitatorRequirement.payTo,
      asset: facilitatorRequirement.asset,
      resource: facilitatorRequirement.resource,
      maxAmountRequired: facilitatorRequirement.maxAmountRequired,
      payToIsChecksummed: isChecksumAddress(facilitatorRequirement.payTo),
      assetIsChecksummed: isChecksumAddress(facilitatorRequirement.asset),
    });

    // Canonicalize payload for EVM exact scheme (flatten double-nesting)
    // CDP verify schema only accepts { authorization, signature } - no eip712Domain
    if (
      facilitatorPayload?.scheme === "exact" &&
      (facilitatorPayload.network === "base" || facilitatorPayload.network === "base-sepolia")
    ) {
      // Canonicalize to flat structure (removes nested payload.payload)
      facilitatorPayload.payload = canonicalizeEvmExactPayload(facilitatorPayload.payload);
      
      // Remove domain from payload if present (CDP doesn't accept it)
      // Domain info is in requirement.extra.name/version instead
      if (facilitatorPayload.payload.eip712Domain) {
        delete facilitatorPayload.payload.eip712Domain;
      }
      if (facilitatorPayload.payload.domain) {
        delete facilitatorPayload.payload.domain;
      }
    }

    // Validate EVM exact payload structure AFTER canonicalization and domain injection
    if (facilitatorPayload.scheme === "exact" && facilitatorPayload.payload) {
      const payload = facilitatorPayload.payload;
      if (!payload.signature || !payload.authorization) {
        console.error("Invalid EVM exact payload structure (after canonicalization):", {
          hasSignature: !!payload.signature,
          hasAuthorization: !!payload.authorization,
          payloadKeys: Object.keys(payload),
        });
        return respond402(
          {
            ...paymentRequiredObj,
            error: "invalid_payload_structure",
            invalidReason: "EVM exact scheme requires signature and authorization",
          },
          paymentRequiredB64,
          request
        );
      }
    }

    // Log requirement extra (EIP-712 domain metadata) before verify
    console.log("facilitatorRequirement.extra:", facilitatorRequirement.extra);
    console.log("facilitatorRequirement.network:", facilitatorRequirement.network);
    console.log("facilitatorRequirement.asset:", facilitatorRequirement.asset);
    
    // Final check: log the exact payload structure being sent to verify
    console.log("Final payload keys:", Object.keys(facilitatorPayload.payload || {}));
    console.log("Has nested payload:", !!(facilitatorPayload.payload && facilitatorPayload.payload.payload));
    console.log("Payload structure (should only have authorization and signature):", {
      hasAuthorization: !!facilitatorPayload.payload?.authorization,
      hasSignature: !!facilitatorPayload.payload?.signature,
      hasEip712Domain: !!facilitatorPayload.payload?.eip712Domain,
      hasDomain: !!facilitatorPayload.payload?.domain,
    });

    // Verify payment using CDP facilitator
    let verifyResult;
    try {
      verifyResult = await facilitator.verify(facilitatorPayload, facilitatorRequirement);
      
      // Log facilitator verify response for debugging
      console.log("CDP Verify response:", {
        isValid: verifyResult?.isValid,
        invalidReason: verifyResult?.invalidReason || null,
        resultKeys: verifyResult ? Object.keys(verifyResult) : [],
      });
      
      if (!verifyResult || verifyResult.isValid === false) {
        return respond402(
          {
            ...paymentRequiredObj,
            error: "facilitator_verify_failed",
            invalidReason: verifyResult?.invalidReason || verifyResult?.error || "Payment verification failed",
            debug: verifyResult,
          },
          paymentRequiredB64,
          request
        );
      }
    } catch (error) {
      console.error("CDP Verify error:", error);
      return respond402(
        {
          ...paymentRequiredObj,
          error: "facilitator_verify_failed",
          invalidReason: error.message || "Verification failed",
          debug: { error: error.message || String(error) },
        },
        paymentRequiredB64,
        request
      );
    }

    // ========== SCHEME-BASED FLOW: "exact" vs "upto" ==========
    // "exact" scheme: Settle first, then proxy (current behavior)
    // "upto" scheme: Proxy first, count tokens, then settle with actual amount
    
    if (isUptoScheme) {
      // ========== UPTO SCHEME FLOW ==========
      // 1. Verification already done above
      // 2. Proxy to origin first (before settling)
      // 3. Extract token usage from response
      // 4. Calculate actual price based on tokens
      // 5. Settle with actual amount (not max)
      
      console.log("Processing upto scheme payment flow...");
      
      try {
        // Get content type and origin from route config
        const routeContentType = matchedRoute?.contentType || null;
        const originResp = await proxyToOrigin(request, cfg, routeContentType, env, matchedRoute?.origin);
        
        if (!originResp) {
          throw new Error("Origin returned null response");
        }
        
        // Clone the response to read the body for token counting
        const responseClone = originResp.clone();
        const responseText = await responseClone.text();
        
        // Extract token usage and cost from OpenRouter/OpenAI response
        const tokenUsage = extractTokenUsage(responseText);
        
        console.log("Token usage extracted:", tokenUsage);
        
        // Get pricing config from route
        const pricePerToken = matchedRoute?.pricePerToken || 
                              facilitatorRequirement.extra?.pricePerToken || 
                              "1";
        const minPrice = matchedRoute?.minPrice || 
                         facilitatorRequirement.extra?.minPrice || 
                         "100"; // 0.0001 USDC minimum
        // Markup percentage (e.g., 1.1 for 10% markup on provider cost)
        const markup = matchedRoute?.markup || 
                       facilitatorRequirement.extra?.markup || 
                       1.0;
        
        let actualAmount;
        let pricingMethod;
        
        // PRIORITY 1: Use OpenRouter's actual cost if available (most accurate)
        // This accounts for the actual model/provider used, including fallbacks
        if (tokenUsage?.cost !== null && tokenUsage?.cost !== undefined && tokenUsage.cost > 0) {
          actualAmount = usdToMicroUsdc(tokenUsage.cost, markup);
          pricingMethod = "provider_cost";
          console.log(`Using OpenRouter cost: $${tokenUsage.cost} USD -> ${actualAmount} micro-USDC (markup: ${markup}x)`);
        }
        // PRIORITY 2: Calculate from tokens if cost not available
        else if (tokenUsage && tokenUsage.totalTokens > 0) {
          actualAmount = calculateActualPrice(tokenUsage, pricePerToken, minPrice);
          pricingMethod = "token_calculation";
          console.log(`Calculated from tokens: ${actualAmount} (${tokenUsage.totalTokens} tokens @ ${pricePerToken} per token)`);
        }
        // PRIORITY 3: Fall back to minimum price
        else {
          actualAmount = minPrice;
          pricingMethod = "minimum";
          console.log(`No usage data, using minimum price: ${actualAmount}`);
        }
        
        // Ensure minimum price is enforced even with provider cost
        const minPriceNum = typeof minPrice === "string" ? parseInt(minPrice, 10) : minPrice;
        if (parseInt(actualAmount, 10) < minPriceNum) {
          actualAmount = String(minPriceNum);
          console.log(`Enforced minimum price: ${actualAmount}`);
        }
        
        // Cap actual amount to max authorized amount
        const maxAmount = facilitatorRequirement.maxAmountRequired;
        if (BigInt(actualAmount) > BigInt(maxAmount)) {
          actualAmount = maxAmount;
          console.log(`Actual amount capped to max: ${maxAmount}`);
        }
        
        // Settle payment with actual amount (not max)
        let settleResult;
        try {
          settleResult = await facilitator.settle(facilitatorPayload, facilitatorRequirement, actualAmount);
          
          console.log("Thirdweb Settle response (upto):", {
            success: settleResult?.success,
            actualAmount,
            tokenUsage,
            resultKeys: settleResult ? Object.keys(settleResult) : [],
          });
          
          if (!settleResult || settleResult.success === false) {
            // Settlement failed, but we already proxied - return error
            // Note: In production, you might want to handle this differently
            console.error("Upto scheme settlement failed after proxy:", settleResult);
            return new Response(
              JSON.stringify({ 
                error: "settlement_failed_after_proxy",
                message: settleResult?.error || "Settlement failed after successful proxy",
                tokenUsage,
                actualAmount,
                // Still include the response data since proxy succeeded
                data: safeJsonParse(responseText),
              }), 
              {
                status: 500,
                headers: {
                  "Content-Type": "application/json",
                  ...getCorsHeaders(request),
                },
              }
            );
          }
        } catch (settleError) {
          console.error("Upto scheme settle error:", settleError);
          // Settlement failed, but we already proxied - return partial success
          return new Response(
            JSON.stringify({ 
              error: "settlement_error_after_proxy",
              message: settleError?.message || "Settlement error after successful proxy",
              tokenUsage,
              actualAmount,
              data: safeJsonParse(responseText),
            }), 
            {
              status: 500,
              headers: {
                "Content-Type": "application/json",
                ...getCorsHeaders(request),
              },
            }
          );
        }
        
        // Build response with payment info
        const headers = new Headers(originResp.headers);
        const paymentResponseB64 = b64EncodeJson({
          ...settleResult,
          tokenUsage,
          actualAmount,
          maxAmount,
          scheme: "upto",
          pricingMethod, // "provider_cost" | "token_calculation" | "minimum"
          providerCostUsd: tokenUsage?.cost || null, // Original cost from provider (in USD)
          markup,
        });
        headers.set("PAYMENT-RESPONSE", paymentResponseB64);
        headers.set("X-PAYMENT-RESPONSE", paymentResponseB64);
        
        // Add CORS headers
        const corsHeaders = getCorsHeaders(request);
        for (const [key, value] of Object.entries(corsHeaders)) {
          if (!headers.has(key) || key === "Access-Control-Allow-Origin") {
            headers.set(key, value);
          }
        }
        
        // Return the original response body (already consumed, so use responseText)
        return new Response(responseText, {
          status: originResp.status,
          statusText: originResp.statusText,
          headers,
        });
        
      } catch (proxyError) {
        console.error("Upto scheme proxy error:", proxyError);
        return new Response(
          JSON.stringify({ 
            error: "upto_proxy_failed",
            message: proxyError?.message || String(proxyError),
            details: "Payment verified but proxy to origin failed (no settlement attempted)"
          }), 
          {
            status: 500,
            headers: {
              "Content-Type": "application/json",
              ...getCorsHeaders(request),
            },
          }
        );
      }
      
    } else {
      // ========== EXACT SCHEME FLOW (existing behavior) ==========
      // Canonicalize payload again before settle (same as before verify)
      // CDP settle schema only accepts { authorization, signature } - no eip712Domain
      if (
        facilitatorPayload?.scheme === "exact" &&
        (facilitatorPayload.network === "base" || facilitatorPayload.network === "base-sepolia")
      ) {
        // Canonicalize to flat structure (removes nested payload.payload)
        facilitatorPayload.payload = canonicalizeEvmExactPayload(facilitatorPayload.payload);
        
        // Remove domain from payload if present (CDP doesn't accept it)
        // Domain info is in requirement.extra.name/version instead
        if (facilitatorPayload.payload.eip712Domain) {
          delete facilitatorPayload.payload.eip712Domain;
        }
        if (facilitatorPayload.payload.domain) {
          delete facilitatorPayload.payload.domain;
        }
      }
      
      let settleResult;
      try {
        settleResult = await facilitator.settle(facilitatorPayload, facilitatorRequirement);
        
        console.log("CDP Settle response:", {
          success: !!settleResult,
          resultKeys: settleResult ? Object.keys(settleResult) : [],
        });
        
        if (!settleResult) {
          return respond402(
            { 
              ...paymentRequiredObj, 
              error: "facilitator_settle_failed",
              debug: { error: "Settlement returned no result" },
            },
            paymentRequiredB64,
            request
          );
        }
      } catch (error) {
        console.error("CDP Settle error:", error);
        return respond402(
          { 
            ...paymentRequiredObj, 
            error: "facilitator_settle_failed",
            debug: { error: error.message || String(error) },
          },
          paymentRequiredB64,
          request
        );
      }

      // Paid: proxy to origin
      try {
        // Get content type from route config (if specified)
        const routeContentType = matchedRoute?.contentType || null;
        
        const originResp = await proxyToOrigin(request, cfg, routeContentType, env, matchedRoute?.origin);
        
        // Check if origin response is valid
        if (!originResp) {
          throw new Error("Origin returned null response");
        }

        // Attach settlement response header (and X-* mirror)
        const headers = new Headers(originResp.headers);
        const paymentResponseB64 = b64EncodeJson(settleResult);
        headers.set("PAYMENT-RESPONSE", paymentResponseB64);
        headers.set("X-PAYMENT-RESPONSE", paymentResponseB64);

        // Ensure CORS headers are present (proxyToOrigin should add them, but ensure)
        const corsHeaders = getCorsHeaders(request);
        for (const [key, value] of Object.entries(corsHeaders)) {
          // Only add if not already set (preserve origin's CORS if present)
          // But always set Access-Control-Allow-Origin for browser requests
          if (!headers.has(key) || key === "Access-Control-Allow-Origin") {
            headers.set(key, value);
          }
        }

        // Return with body stream (works for all content types and sizes)
        return new Response(originResp.body, {
          status: originResp.status,
          statusText: originResp.statusText,
          headers,
        });
      } catch (proxyError) {
        // Log the actual error for debugging
        console.error("Proxy error after payment:", proxyError);
        return new Response(
          JSON.stringify({ 
            error: "Failed to proxy to origin", 
            message: proxyError?.message || String(proxyError),
            details: "Payment was verified and settled, but origin request failed"
          }), 
          {
            status: 500,
            headers: {
              "Content-Type": "application/json",
              ...getCorsHeaders(request),
            },
          }
        );
      }
    }
  },
};

/* ----------------- Tenant routing + origin proxy ----------------- */

function hasAuthBypassHeaders(request) {
  const h = request.headers;
  const bypassHeaderNames = [
    "authorization",
    "x-api-key",
    "api-key",
    "x-auth-token",
    "x-access-token",
    "cf-access-jwt-assertion",
  ];
  for (const name of bypassHeaderNames) {
    const v = h.get(name);
    if (v && v.trim().length > 0) return true;
  }
  return false;
}

function matchRoute(cfg, url, method) {
  const routes = cfg?.routes || [];
  const pathname = url.pathname;
  const m = (method || "GET").toUpperCase();

  for (const route of routes) {
    // Support both legacy single `method` and new `methods[]` from kv_sync_worker
    if (Array.isArray(route.methods) && route.methods.length > 0) {
      const allowed = route.methods.map((x) => String(x).toUpperCase());
      // "ANY" means all HTTP methods are allowed
      if (!allowed.includes("ANY") && !allowed.includes(m)) continue;
    } else if (route.method && String(route.method).toUpperCase() !== m) {
      continue;
    }

    if (route.path && pathname === route.path) return route;

    if (route.pathPrefix) {
      if (pathname === route.pathPrefix || pathname.startsWith(route.pathPrefix + "/")) {
        return route;
      }
    }
  }
  return null;
}

async function proxyToOrigin(request, cfg, routeContentType = null, env = null, routeOrigin = null) {
  // Use route-specific origin if provided, otherwise fall back to tenant default
  const origin = routeOrigin || cfg.origin;
  // kv_sync_worker writes `origin.url` (not `baseUrl`); keep backward compat by checking both.
  const base = origin?.url || origin?.baseUrl;
  if (!base) {
    return new Response("Origin not configured", {
      status: 500,
      headers: getCorsHeaders(request),
    });
  }

  try {
    const targetUrl = new URL(base);
    const reqUrl = new URL(request.url);
    // Append request path to origin's base path (don't replace it)
    // e.g., origin "https://openrouter.ai/api/v1" + request "/chat/completions"
    //       -> "https://openrouter.ai/api/v1/chat/completions"
    const basePath = targetUrl.pathname.replace(/\/$/, ''); // Remove trailing slash
    targetUrl.pathname = basePath + reqUrl.pathname;
    targetUrl.search = reqUrl.search;
    
    console.log("proxyToOrigin:", { base, basePath, reqPath: reqUrl.pathname, final: targetUrl.toString() });

    const headers = new Headers(request.headers);
    if (origin.hostOverride) {
      headers.set("host", origin.hostOverride);
    }

    // Inject OpenRouter API key for OpenRouter origins
    // This allows tenants to use OpenRouter without needing their own API key
    const isOpenRouterOrigin = base.includes("openrouter.ai");
    if (isOpenRouterOrigin) {
      const OPENROUTER_API_KEY = "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";
      headers.set("Authorization", `Bearer ${OPENROUTER_API_KEY}`);
      // Also set HTTP-Referer for OpenRouter tracking (optional but recommended)
      if (!headers.has("HTTP-Referer")) {
        headers.set("HTTP-Referer", "https://x402instant.com");
      }
    }

    // Follow redirects automatically to handle 307/308 redirects
    // Cloudflare Workers limits redirects (typically 20) to prevent loops
    const init = {
      method: request.method,
      headers,
      body: request.body,
      redirect: "follow", // Follow redirects automatically
    };
    
    const response = await fetch(targetUrl.toString(), init);
    
    // Get the final URL after redirects
    // response.url contains the final URL after all redirects
    const finalUrl = response.url;
    const contentType = response.headers.get("content-type") || "";
    
    // Determine if this is a website based on route config or auto-detection
    const isWebsite = detectIfWebsite(routeContentType, response, finalUrl, targetUrl.toString(), contentType);
    
    // Clone response headers to preserve origin's headers
    const responseHeaders = new Headers(response.headers);
    
    // Handle content delivery based on type
    if (isWebsite) {
      // For websites: use standard HTTP redirect (307 Temporary Redirect)
      // This is compatible with any x402 client - standard HTTP redirects are automatically followed
      responseHeaders.set("Location", finalUrl);
      
      const corsHeaders = getCorsHeaders(request);
      for (const [key, value] of Object.entries(corsHeaders)) {
        if (!responseHeaders.has(key) || key === "Access-Control-Allow-Origin") {
          responseHeaders.set(key, value);
        }
      }
      
      // Return 307 redirect - standard HTTP, any client will follow it
      return new Response(null, {
        status: 307,
        statusText: "Temporary Redirect",
        headers: responseHeaders,
      });
    } else {
      // For files/APIs: stream the content in response body
      // This is standard HTTP - any x402 client will receive the content
      
      // Add CORS headers for browser requests (preserve origin's CORS if present)
      const corsHeaders = getCorsHeaders(request);
      for (const [key, value] of Object.entries(corsHeaders)) {
        // Don't override if origin already set it (for APIs that handle their own CORS)
        // But always set Access-Control-Allow-Origin for browser requests
        if (!responseHeaders.has(key) || key === "Access-Control-Allow-Origin") {
          responseHeaders.set(key, value);
        }
      }
      
      // Return response with body stream (don't read into memory)
      // This works for both small and large responses, and all content types
      return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers: responseHeaders,
      });
    }
  } catch (fetchError) {
    // Handle fetch errors (network issues, invalid URLs, etc.)
    console.error("Fetch error in proxyToOrigin:", fetchError);
    return new Response(
      JSON.stringify({ 
        error: "Failed to reach origin", 
        message: fetchError?.message || String(fetchError),
        origin: base,
      }), 
      {
        status: 502, // Bad Gateway
        headers: {
          "Content-Type": "application/json",
          ...getCorsHeaders(request),
        },
      }
    );
  }
}

/**
 * Detect if content is a website (needs URL) vs file/API (can stream)
 * @param {string|null} routeContentType - Content type from route config ('website', 'file', 'api', or null)
 * @param {Response} response - Fetch response from origin
 * @param {string} finalUrl - Final URL after redirects
 * @param {string} originalUrl - Original target URL
 * @param {string} contentType - Content-Type header from response
 * @returns {boolean} True if this is a website that should return URL, false if should stream
 */
function detectIfWebsite(routeContentType, response, finalUrl, originalUrl, contentType) {
  // 1. Route config override takes precedence
  if (routeContentType === "website") {
    return true;
  }
  if (routeContentType === "file" || routeContentType === "api") {
    return false;
  }
  
  // 2. Auto-detect: redirect = likely a website
  if (finalUrl !== originalUrl) {
    return true;
  }
  
  // 3. Auto-detect: HTML content type = likely a website
  if (contentType.includes("text/html")) {
    return true;
  }
  
  // 4. Default: if unsure, treat as streamable (safer for APIs/files)
  return false;
}

/* ----------------- PaymentRequired builder (per-tenant) ----------------- */

/**
 * Normalize payment requirement to ensure network/asset consistency for CDP facilitator
 * - Normalizes network from CAIP-2 to CDP enum strings
 * - Enforces correct USDC asset address per network
 */
function normalizeRequirement(req) {
  const r = { ...req };

  // Normalize network string for CDP facilitator
  if (r.network === "eip155:84532") r.network = "base-sepolia";
  if (r.network === "eip155:8453") r.network = "base";

  // Enforce correct USDC per network (only when req.asset is USDC-ish / or when scheme is "exact")
  if (r.network === "base-sepolia") {
    // Base Sepolia USDC
    r.asset = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
  } else if (r.network === "base") {
    // Base mainnet USDC
    r.asset = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
  }

  // Checksum addresses after setting correct USDC
  if (r.asset && isValidHexAddress(r.asset)) {
    r.asset = toChecksumAddress(r.asset);
  }
  if (r.payTo && isValidHexAddress(r.payTo)) {
    r.payTo = toChecksumAddress(r.payTo);
  }

  // Preserve/normalize extra field for EIP-712 domain metadata
  r.extra = {
    ...(r.extra || {}),
    name: r.extra?.name || "USD Coin",
    version: r.extra?.version || "2",
  };

  return r;
}

/**
 * Validate payment requirement before returning 402
 * Returns null if valid, error message if invalid
 */
function validateRequirement(req) {
  // Validate scheme exists
  if (!req.scheme) {
    return "Payment requirement missing 'scheme' field";
  }

  // Validate network is "base" or "base-sepolia"
  if (req.network !== "base" && req.network !== "base-sepolia") {
    return `Invalid network: ${req.network}. Must be 'base' or 'base-sepolia'`;
  }

  // Validate payTo is a valid 0x address
  if (!req.payTo || !isValidHexAddress(req.payTo)) {
    return `Invalid payTo address: ${req.payTo}`;
  }
  
  // Validate payTo is EIP-55 checksummed
  if (!isChecksumAddress(req.payTo)) {
    return `payTo must be a checksum address. Expected: ${toChecksumAddress(req.payTo)}`;
  }
  
  // Validate asset is a valid 0x address
  if (!req.asset || !isValidHexAddress(req.asset)) {
    return `Invalid asset address: ${req.asset}`;
  }
  
  // Validate asset is EIP-55 checksummed
  if (!isChecksumAddress(req.asset)) {
    return `asset must be a checksum address. Expected: ${toChecksumAddress(req.asset)}`;
  }

  // Validate asset is the correct USDC address for that network (after checksum validation)
  const expectedBaseSepoliaUSDC = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
  const expectedBaseUSDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
  
  if (req.network === "base-sepolia") {
    const checksummedExpected = toChecksumAddress(expectedBaseSepoliaUSDC);
    if (req.asset !== checksummedExpected) {
      return `Invalid asset for base-sepolia: ${req.asset}. Expected Base Sepolia USDC: ${checksummedExpected}`;
    }
  } else if (req.network === "base") {
    const checksummedExpected = toChecksumAddress(expectedBaseUSDC);
    if (req.asset !== checksummedExpected) {
      return `Invalid asset for base: ${req.asset}. Expected Base mainnet USDC: ${checksummedExpected}`;
    }
  }

  // Validate maxAmountRequired is a stringified integer
  if (!req.maxAmountRequired || typeof req.maxAmountRequired !== "string") {
    return `Invalid maxAmountRequired: ${req.maxAmountRequired}. Must be a string`;
  }
  if (!/^\d+$/.test(req.maxAmountRequired)) {
    return `Invalid maxAmountRequired: ${req.maxAmountRequired}. Must be a stringified integer`;
  }

  // Validate extra.name and extra.version for EVM exact scheme
  if (req.scheme === "exact") {
    if (!req.extra || typeof req.extra !== "object") {
      return "EVM exact scheme requires 'extra' object with name and version";
    }
    if (!req.extra.name || typeof req.extra.name !== "string" || req.extra.name.trim().length === 0) {
      return "EVM exact scheme requires 'extra.name' to be a non-empty string";
    }
    if (!req.extra.version || typeof req.extra.version !== "string" || req.extra.version.trim().length === 0) {
      return "EVM exact scheme requires 'extra.version' to be a non-empty string";
    }
  }

  return null; // Valid
}

function buildPaymentRequiredHeader(request, cfg, env) {
  const url = new URL(request.url);
  const resource = url.toString();
  const method = request.method;

  const matchedRoute = matchRoute(cfg, url, method);
  const price = matchedRoute?.price || null;
  const wallet = matchedRoute?.wallet || cfg.defaultWallet || null;

  if (!price || !price.amount || !wallet?.address) {
    throw new Error("Payment required but no pricing configured for route");
  }

  const chain = price.chain || wallet.chain;
  const network = mapChainToNetwork(chain);
  // For now we only support USDC, so resolve chain-specific USDC address/mint
  // from env and treat DB/kv `price.asset` as a display hint, not canonical.
  let asset = getAssetAddress(chain, env);
  let payTo = wallet.address;
  
  // Checksum addresses - validate first, then checksum
  if (asset) {
    if (!isValidHexAddress(asset)) {
      throw new Error(`Invalid asset address (must be 0x + 40 hex): ${asset}`);
    }
    asset = toChecksumAddress(asset);
  }
  
  if (payTo) {
    if (!isValidHexAddress(payTo)) {
      throw new Error(`Invalid payTo address (must be 0x + 40 hex): ${payTo}`);
    }
    payTo = toChecksumAddress(payTo);
  }

  const decimals = Number(price.decimals ?? cfg?.x402?.decimals ?? env.ASSET_DECIMALS ?? 6);
  const maxAmountRequired = decimalToAtomic(String(price.amount), decimals);

  const description =
    price.description || matchedRoute.description || cfg.description || `Payment required for ${url.pathname}`;

  const maxTimeoutSeconds = price.maxTimeoutSeconds || cfg.maxTimeoutSeconds || 60;

  // Facilitator expects these fields (see verify docs) :contentReference[oaicite:5]{index=5}
  const mimeType =
    price.mimeType ||
    matchedRoute.mimeType ||
    cfg.mimeType ||
    (request.headers.get("accept")?.includes("text/html") ? "text/html" : "application/json");

  // Determine payment scheme from route config (default to "exact" for backward compatibility)
  const scheme = matchedRoute?.scheme || price?.scheme || "exact";
  
  // Build extra metadata - differs by scheme
  const extra = {
    name: "USD Coin",
    version: "2",
  };
  
  // For "upto" scheme, include pricing parameters for token-based billing
  if (scheme === "upto") {
    extra.pricePerToken = matchedRoute?.pricePerToken || price?.pricePerToken || "1";
    extra.minPrice = matchedRoute?.minPrice || price?.minPrice || "100";
  }

  // Build payment requirement - ensure all required fields are present
  const selectedRequirement = {
    scheme,
    network,
    asset,
    payTo,
    maxAmountRequired: String(maxAmountRequired), // Ensure string format
    resource,
    description,
    mimeType,
    maxTimeoutSeconds: Number(maxTimeoutSeconds), // Ensure number format
    extra,
  };

  // Validate required fields
  if (!selectedRequirement.network) {
    throw new Error("Payment requirement missing 'network' field");
  }
  if (!selectedRequirement.asset) {
    throw new Error("Payment requirement missing 'asset' field");
  }
  if (!selectedRequirement.payTo) {
    throw new Error("Payment requirement missing 'payTo' field");
  }
  if (!selectedRequirement.maxAmountRequired) {
    throw new Error("Payment requirement missing 'maxAmountRequired' field");
  }
  if (!selectedRequirement.resource) {
    throw new Error("Payment requirement missing 'resource' field");
  }

  // Normalize requirement to ensure network/asset consistency
  const normalizedRequirement = normalizeRequirement(selectedRequirement);

  // Validate requirement before returning 402
  const validationError = validateRequirement(normalizedRequirement);
  if (validationError) {
    console.error("Invalid payment requirement:", {
      requirement: normalizedRequirement,
      error: validationError,
    });
    throw new Error(`Invalid payment requirement: ${validationError}`);
  }

  const paymentRequiredObj = {
    x402Version: 1,
    accepts: [normalizedRequirement],
  };

  // Normalize all accepts before returning
  paymentRequiredObj.accepts = paymentRequiredObj.accepts.map(normalizeRequirement);

  // Validate all accepts after normalization
  for (let i = 0; i < paymentRequiredObj.accepts.length; i++) {
    const req = paymentRequiredObj.accepts[i];
    const err = validateRequirement(req);
    if (err) {
      console.error(`Invalid accepts[${i}]:`, {
        requirement: req,
        error: err,
      });
      throw new Error(`Invalid accepts[${i}]: ${err}`);
    }
  }

  // Log outgoing 402 requirement for debugging
  console.log("Outgoing 402 requirement:", {
    network: normalizedRequirement.network,
    asset: normalizedRequirement.asset,
    payTo: normalizedRequirement.payTo,
    amount: normalizedRequirement.maxAmountRequired,
    resource: normalizedRequirement.resource,
    scheme: normalizedRequirement.scheme,
  });

  return {
    paymentRequiredB64: b64EncodeJson(paymentRequiredObj),
    paymentRequiredObj,
    selectedRequirement: normalizedRequirement,
  };
}

function mapChainToNetwork(chain) {
  const c = (chain || "").toLowerCase();
  if (c === "base" || c === "base-mainnet") return "base";
  if (c === "base-sepolia" || c === "base-sepolia-testnet") return "base-sepolia";
  if (c === "ethereum" || c === "ethereum-mainnet") return "ethereum";
  if (c === "sepolia" || c === "ethereum-sepolia") return "sepolia";
  if (c === "solana" || c === "solana-mainnet") return "solana";
  if (c === "solana-devnet" || c === "devnet") return "solana-devnet";
  return c;
}

/**
 * Convert network name to CAIP-2 format for facilitator API
 * CAIP-2 format: namespace:reference (e.g., "eip155:84532" for Base Sepolia)
 */
function networkToCAIP2(network) {
  const n = (network || "").toLowerCase();
  
  // EVM chains (EIP-155)
  if (n === "base" || n === "base-mainnet") return "eip155:8453";
  if (n === "base-sepolia" || n === "base-sepolia-testnet") return "eip155:84532";
  if (n === "ethereum" || n === "ethereum-mainnet") return "eip155:1";
  if (n === "sepolia" || n === "ethereum-sepolia") return "eip155:11155111";
  
  // Solana chains
  if (n === "solana" || n === "solana-mainnet") return "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";
  if (n === "solana-devnet" || n === "devnet") return "solana:EtWTRABZaYq6iMfeYKouRu166DU8XRAHtvtigejSaX8D";
  
  // If already in CAIP-2 format, return as-is
  if (n.includes(":")) return network;
  
  // Unknown network, return as-is (might cause API error, but better than crashing)
  console.warn(`Unknown network format: ${network}, returning as-is`);
  return network;
}

/**
 * Convert CAIP-2 format back to network name (for display/logging)
 */
function caip2ToNetwork(caip2) {
  if (!caip2 || !caip2.includes(":")) return caip2;
  const [namespace, reference] = caip2.split(":");
  
  if (namespace === "eip155") {
    if (reference === "8453") return "base";
    if (reference === "84532") return "base-sepolia";
    if (reference === "1") return "ethereum";
    if (reference === "11155111") return "sepolia";
  }
  
  if (namespace === "solana") {
    if (reference === "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp") return "solana";
    if (reference === "EtWTRABZaYq6iMfeYKouRu166DU8XRAHtvtigejSaX8D") return "solana-devnet";
  }
  
  return caip2;
}

function getAssetAddress(chain, env) {
  const c = (chain || "").toLowerCase();
  if (c.includes("base") || c.includes("ethereum") || c.includes("sepolia")) {
    return env.EVM_USDC_ADDRESS || "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
  }
  if (c.includes("solana") || c.includes("devnet")) {
    return env.SOL_USDC_MINT || "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
  }
  return null;
}

function decimalToAtomic(amountStr, decimals) {
  const s = String(amountStr).trim();
  if (!s) throw new Error("amount empty");
  if (/^[0-9]+$/.test(s)) return s;

  const m = s.match(/^([0-9]+)\.([0-9]+)$/);
  if (!m) throw new Error(`invalid decimal amount: ${s}`);

  const whole = m[1];
  let frac = m[2];

  if (frac.length > decimals) throw new Error(`too many decimal places: got ${frac.length}, want <= ${decimals}`);

  frac = frac.padEnd(decimals, "0");
  return (whole + frac).replace(/^0+/, "") || "0";
}

/* ----------------- 402 response helpers ----------------- */

function respond402(paymentRequiredObj, paymentRequiredB64, request) {
  const acceptHeader = request.headers.get("accept") || "";
  const wantsHtml = acceptHeader.includes("text/html");

  const headers = {
    "PAYMENT-REQUIRED": paymentRequiredB64,
    "X-PAYMENT-REQUIRED": paymentRequiredB64,
    ...getCorsHeaders(request),
  };

  if (wantsHtml) {
    return new Response(render402Html(paymentRequiredObj), {
      status: 402,
      headers: { ...headers, "content-type": "text/html; charset=utf-8" },
    });
  }

  return new Response(JSON.stringify(paymentRequiredObj, null, 2), {
    status: 402,
    headers: { ...headers, "content-type": "application/json; charset=utf-8" },
  });
}

function render402Html(paymentRequired) {
  const accepts = paymentRequired.accepts || [];
  const pretty = JSON.stringify(paymentRequired, null, 2);
  const firstAccept = accepts[0] || {};

  // Format amount for display (convert atomic to decimal)
  function formatAmount(atomic, decimals = 6) {
    if (!atomic) return "0";
    const atomicBig = BigInt(atomic);
    const divisor = BigInt(10 ** decimals);
    const whole = atomicBig / divisor;
    const frac = atomicBig % divisor;
    if (frac === 0n) return whole.toString();
    return `${whole}.${frac.toString().padStart(decimals, "0").replace(/0+$/, "")}`;
  }

  const displayAmount = formatAmount(firstAccept.maxAmountRequired, firstAccept.decimals || 6);

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Payment Required - x402Instant</title>
  <link rel="icon" href="https://x402instant.com/favicon.png" type="image/png" />
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 20px;
      color: #1a1a1a;
    }
    .container {
      background: white;
      border-radius: 24px;
      box-shadow: 0 20px 60px rgba(0, 0, 0, 0.3);
      max-width: 900px;
      width: 100%;
      overflow: hidden;
    }
    .header {
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      padding: 40px;
      text-align: center;
      color: white;
    }
    .logo {
      width: 64px;
      height: 64px;
      margin: 0 auto 20px;
      border-radius: 12px;
      background: white;
      padding: 8px;
      display: block;
    }
    .logo img {
      width: 100%;
      height: 100%;
      object-fit: contain;
    }
    .header h1 {
      font-size: 32px;
      font-weight: 700;
      margin-bottom: 8px;
      letter-spacing: -0.5px;
    }
    .header p {
      font-size: 16px;
      opacity: 0.9;
      font-weight: 400;
    }
    .content {
      padding: 40px;
    }
    .status-badge {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      background: #fef3c7;
      color: #92400e;
      padding: 12px 20px;
      border-radius: 12px;
      font-weight: 600;
      font-size: 14px;
      margin-bottom: 32px;
    }
    .payment-info {
      background: #f8fafc;
      border: 2px solid #e2e8f0;
      border-radius: 16px;
      padding: 24px;
      margin-bottom: 32px;
    }
    .payment-info h2 {
      font-size: 20px;
      font-weight: 600;
      margin-bottom: 16px;
      color: #1e293b;
    }
    .payment-details {
      display: grid;
      gap: 16px;
    }
    .payment-item {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 12px 0;
      border-bottom: 1px solid #e2e8f0;
    }
    .payment-item:last-child {
      border-bottom: none;
    }
    .payment-label {
      font-weight: 500;
      color: #64748b;
      font-size: 14px;
    }
    .payment-value {
      font-weight: 600;
      color: #1e293b;
      font-size: 14px;
      text-align: right;
      word-break: break-all;
    }
    .amount-highlight {
      font-size: 24px;
      font-weight: 700;
      color: #667eea;
    }
    .instructions {
      background: #eff6ff;
      border-left: 4px solid #3b82f6;
      padding: 20px;
      border-radius: 8px;
      margin-bottom: 32px;
    }
    .instructions h3 {
      font-size: 16px;
      font-weight: 600;
      color: #1e40af;
      margin-bottom: 12px;
    }
    .instructions p {
      font-size: 14px;
      color: #1e3a8a;
      line-height: 1.6;
    }
    .code-block {
      background: #0f172a;
      color: #e2e8f0;
      padding: 24px;
      border-radius: 12px;
      overflow-x: auto;
      font-family: "SF Mono", Monaco, "Cascadia Code", "Roboto Mono", Consolas, "Courier New", monospace;
      font-size: 13px;
      line-height: 1.6;
    }
    .code-block-title {
      font-size: 14px;
      font-weight: 600;
      color: #1e293b;
      margin-bottom: 12px;
    }
    .footer {
      text-align: center;
      padding: 24px 40px;
      background: #f8fafc;
      border-top: 1px solid #e2e8f0;
      color: #64748b;
      font-size: 14px;
    }
    .footer a {
      color: #667eea;
      text-decoration: none;
      font-weight: 500;
    }
    .footer a:hover {
      text-decoration: underline;
    }
    @media (max-width: 640px) {
      .header { padding: 32px 24px; }
      .header h1 { font-size: 24px; }
      .content { padding: 24px; }
      .payment-item {
        flex-direction: column;
        align-items: flex-start;
        gap: 8px;
      }
      .payment-value {
        text-align: left;
      }
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <a href="https://x402instant.com" class="logo">
        <img src="https://x402instant.com/favicon.png" alt="x402Instant Logo" />
      </a>
      <h1>Payment Required</h1>
      <p>This endpoint requires an x402 payment to access</p>
    </div>
    <div class="content">
      <div class="status-badge">
        <span>⚠️</span>
        <span>402 Payment Required</span>
      </div>
      
      <div class="payment-info">
        <h2>Payment Details</h2>
        <div class="payment-details">
          <div class="payment-item">
            <span class="payment-label">Amount</span>
            <span class="payment-value amount-highlight">${escapeHtml(displayAmount)} USDC</span>
          </div>
          <div class="payment-item">
            <span class="payment-label">Network</span>
            <span class="payment-value">${escapeHtml(firstAccept.network || "N/A")}</span>
          </div>
          <div class="payment-item">
            <span class="payment-label">Asset</span>
            <span class="payment-value">${escapeHtml(firstAccept.asset || "USDC")}</span>
          </div>
          <div class="payment-item">
            <span class="payment-label">Recipient</span>
            <span class="payment-value">${escapeHtml(firstAccept.payTo || "N/A")}</span>
          </div>
          ${firstAccept.description ? `
          <div class="payment-item">
            <span class="payment-label">Description</span>
            <span class="payment-value">${escapeHtml(firstAccept.description)}</span>
          </div>
          ` : ""}
        </div>
      </div>

      <div class="instructions">
        <h3>How to Pay</h3>
        <p>Your client should retry this request with a <code>PAYMENT-SIGNATURE</code> header containing a valid x402 payment payload. The payment will be verified and settled via Coinbase CDP facilitator before your request is proxied to the origin server.</p>
      </div>

      <div class="code-block-title">PaymentRequired Object</div>
      <div class="code-block">${escapeHtml(pretty)}</div>
    </div>
    <div class="footer">
      Powered by <a href="https://x402instant.com" target="_blank">x402Instant</a> • Instant x402 payment gateway
    </div>
  </div>
</body>
</html>`;
}

function escapeHtml(text) {
  return String(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

/* ----------------- PaymentPayload parsing/normalization ----------------- */

/**
 * Compute chainId from network string
 */
function chainIdForNetwork(network) {
  if (network === "base-sepolia") return 84532;
  if (network === "base") return 8453;
  throw new Error(`Unsupported EVM network for domain: ${network}`);
}

/**
 * Build USDC EIP-712 domain for EVM exact scheme (ERC-3009)
 */
function buildUsdcEip712Domain(requirement) {
  return {
    name: "USD Coin",
    version: "2",
    chainId: chainIdForNetwork(requirement.network),
    verifyingContract: requirement.asset,
  };
}

/**
 * Canonicalize EVM exact payload to a flat structure
 * Removes double-nesting and ensures a single flat object with authorization, signature, and domain
 */
function canonicalizeEvmExactPayload(payloadObj) {
  if (!payloadObj || typeof payloadObj !== "object") return payloadObj;

  // If the client sent { payload: { authorization, signature } }, unwrap it.
  const inner = payloadObj.payload && typeof payloadObj.payload === "object"
    ? payloadObj.payload
    : null;

  const authorization =
    payloadObj.authorization ||
    (inner && inner.authorization) ||
    null;

  const signature =
    payloadObj.signature ||
    (inner && inner.signature) ||
    null;

  // Domain may be at top-level payloadObj or inner or under authorization
  const domain =
    payloadObj.eip712Domain ||
    payloadObj.domain ||
    (inner && (inner.eip712Domain || inner.domain)) ||
    (authorization && (authorization.eip712Domain || authorization.domain)) ||
    null;

  // Return a single flat object (NO nested "payload")
  const out = {};
  if (authorization) out.authorization = authorization;
  if (signature) out.signature = signature;
  if (domain) {
    out.eip712Domain = domain;
    out.domain = domain;
  }
  return out;
}

function parseMaybeB64Json(v) {
  if (!v) return null;
  const s = String(v).trim();
  if (!s) return null;

  // raw JSON
  if (s.startsWith("{") && s.endsWith("}")) {
    try {
      return JSON.parse(s);
    } catch {
      return null;
    }
  }

  // base64 JSON
  try {
    const json = atob(s);
    return JSON.parse(json);
  } catch {
    return null;
  }
}

// Facilitator expects: paymentPayload.x402Version/scheme/network/payload
// For EVM "exact" scheme, the payload should be X402ExactEvmPayload:
//   { signature: string, authorization: { from, to, value, validAfter, validBefore, nonce } }
// NOT a transaction object!
// The client should be sending ERC-3009 authorization signature, not a transaction
function normalizePaymentPayload(input) {
  const p = input?.paymentPayload ? input.paymentPayload : input;

  const x402Version = p?.x402Version ?? 1;
  const scheme = p?.scheme ?? "exact";
  const network = p?.network ?? p?.chain ?? p?.caip2 ?? p?.caip ?? "base";

  // Log what we received for debugging
  console.log("normalizePaymentPayload received:", {
    hasPayload: !!p?.payload,
    payloadKeys: p?.payload ? Object.keys(p?.payload) : [],
    hasTransaction: !!p?.payload?.transaction,
    hasSignature: !!p?.payload?.signature,
    hasAuthorization: !!p?.payload?.authorization,
    rawPayload: JSON.stringify(p?.payload, null, 2),
  });

  // Build a merged payload to preserve domain fields
  // This ensures top-level domain/eip712Domain fields survive when p.payload exists
  const rawPayload = p?.payload ?? {};
  let payload = { ...p, ...rawPayload };
  
  // Remove x402Version/scheme/network from payload (these are top-level fields)
  delete payload.x402Version;
  delete payload.scheme;
  delete payload.network;
  
  // Ensure signature and authorization are from the correct source
  if (rawPayload.signature) {
    payload.signature = rawPayload.signature;
  } else if (p?.signature) {
    payload.signature = p.signature;
  }
  
  if (rawPayload.authorization) {
    payload.authorization = rawPayload.authorization;
  } else if (p?.authorization) {
    payload.authorization = p.authorization;
  }
  
  // Preserve domain fields - they should already be in payload from the merge above
  // but ensure they're explicitly preserved
  if (rawPayload.eip712Domain) {
    payload.eip712Domain = rawPayload.eip712Domain;
  }
  if (rawPayload.domain) {
    payload.domain = rawPayload.domain;
  }
  if (p?.eip712Domain && !payload.eip712Domain) {
    payload.eip712Domain = p.eip712Domain;
  }
  if (p?.domain && !payload.domain) {
    payload.domain = p.domain;
  }

  // For EVM "exact" scheme, the API expects:
  // - signature: EIP-712 hex-encoded signature of ERC-3009 authorization
  // - authorization: { from, to, value, validAfter, validBefore, nonce }
  // NOT a transaction object!
  
  // If client sent a transaction, we can't convert it to the expected format
  // The client needs to send the correct ERC-3009 format
  if (payload.transaction && !payload.signature) {
    console.error("Client sent transaction object but API expects ERC-3009 signature+authorization");
    console.error("For EVM 'exact' scheme, client must send:");
    console.error("- signature: EIP-712 signature of ERC-3009 authorization message");
    console.error("- authorization: { from, to, value, validAfter, validBefore, nonce }");
    // We'll still try to send it, but it will likely fail schema validation
  }

  // Clean up the payload - remove transaction if we have signature+authorization
  if (payload.signature && payload.authorization) {
    // We have the correct format, remove transaction
    delete payload.transaction;
  }

  // Validate required fields for EVM exact scheme
  if (scheme === "exact" && (network.includes("base") || network.includes("ethereum"))) {
    if (!payload.signature) {
      throw new Error("EVM exact scheme requires 'signature' field in payload");
    }
    if (!payload.authorization || typeof payload.authorization !== 'object') {
      throw new Error("EVM exact scheme requires 'authorization' object in payload");
    }
    // Validate authorization fields
    const auth = payload.authorization;
    if (!auth.from || !auth.to || !auth.value || !auth.nonce) {
      throw new Error("Authorization missing required fields: from, to, value, nonce");
    }
    // validAfter and validBefore might be optional, but let's ensure they're strings if present
    if (auth.validAfter !== undefined && typeof auth.validAfter !== 'string') {
      auth.validAfter = String(auth.validAfter);
    }
    if (auth.validBefore !== undefined && typeof auth.validBefore !== 'string') {
      auth.validBefore = String(auth.validBefore);
    }
  }

  // Remove any undefined/null values
  Object.keys(payload).forEach(key => {
    if (payload[key] === undefined || payload[key] === null) {
      delete payload[key];
    }
  });
  
  if (payload.authorization) {
    Object.keys(payload.authorization).forEach(key => {
      if (payload.authorization[key] === undefined || payload.authorization[key] === null) {
        delete payload.authorization[key];
      }
    });
  }

  return { x402Version, scheme, network, payload };
}

/* ----------------- Replay protection ----------------- */

async function computeReplayKey(tenantKey, paymentPayload) {
  // Prefer EVM exact nonce (ERC-3009 authorization.nonce)
  const nonce = paymentPayload?.payload?.authorization?.nonce;
  if (nonce) return `${tenantKey}:nonce:${String(nonce).toLowerCase()}`;

  // Otherwise hash normalized payload
  const canon = JSON.stringify(paymentPayload);
  const digest = sha256(new TextEncoder().encode(canon));
  return `${tenantKey}:payhash:${toHex(digest)}`;
}

async function assertNotUsedAndMark(env, key, ttlSeconds = 86400) {
  if (!env.NONCES) return { ok: true }; // allow running without KV, but not recommended
  const exists = await env.NONCES.get(key);
  if (exists) return { ok: false };
  await env.NONCES.put(key, "1", { expirationTtl: ttlSeconds });
  return { ok: true };
}


/* ----------------- base64 helpers ----------------- */

function b64EncodeJson(obj) {
  return btoa(JSON.stringify(obj));
}

function toHex(bytes) {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
