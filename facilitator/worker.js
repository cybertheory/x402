import {
  createPublicClient,
  createWalletClient,
  http,
  parseSignature,
  isAddress,
  getAddress,
  recoverTypedDataAddress,
  BaseError,
  ContractFunctionExecutionError,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base, baseSepolia } from "viem/chains";

/**
 * x402 Facilitator (Cloudflare Worker) — EVM "exact" scheme
 *
 * Key points:
 * - Verifies by eth_call (simulateContract) against USDC-style EIP-3009 functions
 * - Supports both transferWithAuthorization and receiveWithAuthorization
 * - Adds strong diagnostics for the most common failure on Base Sepolia:
 *   token EIP-712 domain "name" differs from mainnet. (Onchain `name()` is what matters.)
 */

/* ----------------------------- Config helpers ----------------------------- */

const JSON_HEADERS = { "content-type": "application/json; charset=utf-8" };

function nowIso() {
  return new Date().toISOString();
}

function reqIdFrom(request) {
  return (
    request.headers.get("cf-ray") ||
    request.headers.get("cf-request-id") ||
    crypto.randomUUID()
  );
}

function debugEnabled(env) {
  return (
    String(env.DEBUG || env.X402_DEBUG || "").toLowerCase() === "true" ||
    String(env.DEBUG || env.X402_DEBUG || "") === "1"
  );
}

function dlog(env, reqId, msg, data = {}) {
  // Keep logs compact & structured for Workers log view.
  // Avoid logging raw signatures (privacy).
  const payload = { t: nowIso(), reqId, msg, ...data };
  console.log(JSON.stringify(payload));
}

function json(body, { reqId, status = 200, extraHeaders = {} } = {}) {
  const headers = new Headers({ ...JSON_HEADERS, ...extraHeaders });
  if (reqId) headers.set("x-request-id", reqId);
  return new Response(JSON.stringify(body, null, 2), { status, headers });
}

function unauthorized(reqId) {
  return json({ ok: false, error: "unauthorized" }, { reqId, status: 401 });
}

async function requireAuthIfConfigured(request, env) {
  const required = String(env.AUTH_TOKEN || env.FACILITATOR_AUTH_TOKEN || "");
  if (!required) return true;
  const got = request.headers.get("authorization") || "";
  const token = got.startsWith("Bearer ") ? got.slice("Bearer ".length) : got;
  return token === required;
}

function normalizeEvmAddress(addr) {
  try {
    if (!addr || typeof addr !== "string") return null;
    if (!isAddress(addr)) return null;
    return getAddress(addr);
  } catch {
    return null;
  }
}

function looksLikeBytes32(x) {
  return typeof x === "string" && /^0x[0-9a-fA-F]{64}$/.test(x);
}

function coerceBigIntString(x) {
  if (typeof x === "bigint") return x;
  if (typeof x === "number") return BigInt(x);
  if (typeof x !== "string") throw new Error("not a bigint-ish");
  // allow decimal strings
  if (/^[0-9]+$/.test(x)) return BigInt(x);
  // allow 0x...
  if (/^0x[0-9a-fA-F]+$/.test(x)) return BigInt(x);
  throw new Error("bad bigint string");
}

function safeErr(e) {
  if (!e) return { name: "UnknownError", message: "unknown error" };
  const out = {
    name: e?.name || "Error",
    message: e?.shortMessage || e?.message || String(e),
  };
  // include nested "cause" if helpful
  const cause = e?.cause;
  if (cause && typeof cause === "object") {
    out.cause = {
      name: cause?.name || "Cause",
      message: cause?.shortMessage || cause?.message || String(cause),
    };
  }
  return out;
}

/* -------------------------- x402 parsing (EVM) ---------------------------- */

/**
 * The x402 proxy/libs often send a base64 JSON blob that looks like:
 * {
 *   "x402Version": 1,
 *   "scheme": "exact",
 *   "network": "...",
 *   "payload": { "authorization": {...}, "signature": "0x..." }
 * }
 *
 * But some clients nest differently. This function tries to be flexible.
 */
function extractEvmExactPayload(paymentPayload) {
  const outer = paymentPayload && typeof paymentPayload === "object" ? paymentPayload : {};
  const payload = outer.payload && typeof outer.payload === "object" ? outer.payload : outer;

  const inner = payload.payload && typeof payload.payload === "object" ? payload.payload : payload;

  const signature =
    (typeof payload.signature === "string" && payload.signature) ||
    (typeof inner.signature === "string" && inner.signature) ||
    null;

  const authorization =
    (payload.authorization && typeof payload.authorization === "object" && payload.authorization) ||
    (inner.authorization && typeof inner.authorization === "object" && inner.authorization) ||
    null;

  const domain =
    payload.eip712Domain ||
    payload.domain ||
    inner.eip712Domain ||
    inner.domain ||
    authorization?.eip712Domain ||
    authorization?.domain ||
    null;

  return { signature, authorization, domain };
}

/* -------------------------- Chains / RPC routing -------------------------- */

function getChainForNetwork(network) {
  if (network === "base") return base;
  if (network === "base-sepolia") return baseSepolia;
  return null;
}

function getRpcUrlForNetwork(env, network) {
  if (network === "base") return env.BASE_RPC_URL || env.BASE_MAINNET_RPC_URL;
  if (network === "base-sepolia") return env.BASE_SEPOLIA_RPC_URL;
  return null;
}

/* --------------------------- USDC / EIP-3009 ABI -------------------------- */

/**
 * Many USDC deployments (including Base mainnet) return no data ("0x") for these calls.
 * If you declare outputs incorrectly (e.g., bool), viem will throw.
 */
const usdcEip3009Abi = [
  {
    type: "function",
    name: "transferWithAuthorization",
    stateMutability: "nonpayable",
    inputs: [
      { name: "from", type: "address" },
      { name: "to", type: "address" },
      { name: "value", type: "uint256" },
      { name: "validAfter", type: "uint256" },
      { name: "validBefore", type: "uint256" },
      { name: "nonce", type: "bytes32" },
      { name: "v", type: "uint8" },
      { name: "r", type: "bytes32" },
      { name: "s", type: "bytes32" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "receiveWithAuthorization",
    stateMutability: "nonpayable",
    inputs: [
      { name: "from", type: "address" },
      { name: "to", type: "address" },
      { name: "value", type: "uint256" },
      { name: "validAfter", type: "uint256" },
      { name: "validBefore", type: "uint256" },
      { name: "nonce", type: "bytes32" },
      { name: "v", type: "uint8" },
      { name: "r", type: "bytes32" },
      { name: "s", type: "bytes32" },
    ],
    outputs: [],
  },
  { type: "function", name: "name", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
];

/* ---------------------------- Typed-data helpers -------------------------- */

/**
 * EIP-3009 typed data:
 * - Domain: (name, version, chainId, verifyingContract)
 * - Types: TransferWithAuthorization / ReceiveWithAuthorization
 */
function buildEip3009TypedData({ domainName, chainId, verifyingContract, primaryType, message }) {
  return {
    domain: {
      name: domainName,
      version: "2", // USDC FiatTokenV2_2 hardcodes "2"
      chainId: BigInt(chainId),
      verifyingContract,
    },
    types: {
      EIP712Domain: [
        { name: "name", type: "string" },
        { name: "version", type: "string" },
        { name: "chainId", type: "uint256" },
        { name: "verifyingContract", type: "address" },
      ],
      TransferWithAuthorization: [
        { name: "from", type: "address" },
        { name: "to", type: "address" },
        { name: "value", type: "uint256" },
        { name: "validAfter", type: "uint256" },
        { name: "validBefore", type: "uint256" },
        { name: "nonce", type: "bytes32" },
      ],
      ReceiveWithAuthorization: [
        { name: "from", type: "address" },
        { name: "to", type: "address" },
        { name: "value", type: "uint256" },
        { name: "validAfter", type: "uint256" },
        { name: "validBefore", type: "uint256" },
        { name: "nonce", type: "bytes32" },
      ],
    },
    primaryType,
    message,
  };
}

async function readTokenName(publicClient, tokenAddress) {
  try {
    const name = await publicClient.readContract({
      address: tokenAddress,
      abi: usdcEip3009Abi,
      functionName: "name",
      args: [],
    });
    if (typeof name === "string" && name.length > 0) return name;
  } catch {
    // ignore
  }
  return null;
}

/* ------------------------------ Reason mapping ---------------------------- */

function mapRevertToReason(message) {
  const m = String(message || "");
  if (m.includes("FiatTokenV2: invalid signature")) return "invalid_exact_evm_payload_signature";
  if (m.toLowerCase().includes("invalid signature")) return "invalid_exact_evm_payload_signature";
  if (m.toLowerCase().includes("expired")) return "authorization_expired";
  if (m.toLowerCase().includes("not yet valid")) return "authorization_not_yet_valid";
  if (m.toLowerCase().includes("used")) return "authorization_already_used";
  if (m.toLowerCase().includes("blacklist")) return "payer_or_payee_blacklisted";
  // viem common "returned no data" indicates wrong asset / non-contract / ABI mismatch
  if (
    m.includes("returned no data") ||
    m.includes("not a contract") ||
    m.includes("does not have the function")
  ) return "invalid_asset";
  return "invalid_payload";
}

/* --------------------------------- Routes -------------------------------- */

function supportedResponse() {
  return {
    x402Version: 1,
    schemes: [
      {
        scheme: "exact",
        networks: ["base", "base-sepolia"],
      },
    ],
  };
}

export default {
  async fetch(request, env, ctx) {
    const reqId = reqIdFrom(request);

    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: {
          "access-control-allow-origin": "*",
          "access-control-allow-methods": "GET,POST,OPTIONS",
          "access-control-allow-headers": "content-type,authorization",
          "access-control-max-age": "86400",
          "x-request-id": reqId,
        },
      });
    }

    const authed = await requireAuthIfConfigured(request, env);
    if (!authed) return unauthorized(reqId);

    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";

    const CORS = { "access-control-allow-origin": "*" };

    // Basic health
    if (path === "/" || path === "/health") {
      return json({ ok: true }, { reqId, extraHeaders: CORS });
    }

    // Supported endpoints
    if (
      request.method === "GET" &&
      (path === "/supported" || path === "/x402/supported" || path === "/v2/x402/supported")
    ) {
      return json(supportedResponse(), { reqId, extraHeaders: CORS });
    }

    if (
      request.method === "POST" &&
      (path === "/verify" || path === "/x402/verify" || path === "/v2/x402/verify")
    ) {
      return handleVerify(request, env, reqId, CORS);
    }

    if (
      request.method === "POST" &&
      (path === "/settle" || path === "/x402/settle" || path === "/v2/x402/settle")
    ) {
      return handleSettle(request, env, reqId, CORS);
    }

    return json({ ok: false, error: "not_found", path }, { reqId, status: 404, extraHeaders: CORS });
  },
};

/* ------------------------------ /verify logic ----------------------------- */

async function handleVerify(request, env, reqId, CORS) {
  const started = Date.now();
  dlog(env, reqId, "verify.start", { path: "/verify" });

  let body;
  try {
    body = await request.json();
  } catch {
    return json(
      { isValid: false, payer: "unknown", invalidReason: "invalid_payload" },
      { reqId, status: 400, extraHeaders: CORS }
    );
  }

  const paymentRequirements = body?.paymentRequirements || body?.requirements || body?.accepts?.[0] || null;
  const paymentPayload = body?.paymentPayload || body?.payload || null;

  if (!paymentRequirements || !paymentPayload) {
    return json(
      { isValid: false, payer: "unknown", invalidReason: "invalid_payload" },
      { reqId, status: 400, extraHeaders: CORS }
    );
  }

  const network = paymentPayload?.network || paymentRequirements?.network;
  const chain = getChainForNetwork(network);
  const rpcUrl = getRpcUrlForNetwork(env, network);

  if (!chain || !rpcUrl) {
    return json(
      { isValid: false, payer: "unknown", invalidReason: "invalid_network" },
      { reqId, status: 400, extraHeaders: CORS }
    );
  }

  const asset = normalizeEvmAddress(paymentRequirements?.asset);
  const payTo = normalizeEvmAddress(paymentRequirements?.payTo);
  if (!asset || !payTo) {
    return json(
      { isValid: false, payer: "unknown", invalidReason: "invalid_payment_requirements" },
      { reqId, status: 400, extraHeaders: CORS }
    );
  }

  const { signature: sigIn, authorization: auth, domain: payloadDomain } = extractEvmExactPayload(paymentPayload);

  const payer = normalizeEvmAddress(auth?.from);
  const to = normalizeEvmAddress(auth?.to);

  if (!payer || !to || !sigIn) {
    return json(
      { isValid: false, payer: "unknown", invalidReason: "invalid_payload" },
      { reqId, status: 400, extraHeaders: CORS }
    );
  }

  if (to !== payTo) {
    return json(
      { isValid: false, payer, invalidReason: "invalid_payment_requirements" },
      { reqId, status: 400, extraHeaders: CORS }
    );
  }

  if (!looksLikeBytes32(auth?.nonce)) {
    return json(
      { isValid: false, payer, invalidReason: "invalid_payload" },
      { reqId, status: 400, extraHeaders: CORS }
    );
  }

  let value, maxAmountRequired, validAfter, validBefore;
  try {
    value = coerceBigIntString(auth?.value);
    maxAmountRequired = coerceBigIntString(paymentRequirements?.maxAmountRequired);
    validAfter = coerceBigIntString(auth?.validAfter);
    validBefore = coerceBigIntString(auth?.validBefore);
  } catch {
    return json(
      { isValid: false, payer, invalidReason: "invalid_payload" },
      { reqId, status: 400, extraHeaders: CORS }
    );
  }

  if (value <= 0n || value > maxAmountRequired) {
    return json(
      { isValid: false, payer, invalidReason: "invalid_payment_requirements" },
      { reqId, status: 400, extraHeaders: CORS }
    );
  }

  // Parse signature safely (don’t log it).
  let parsedSig;
  try {
    parsedSig = parseSignature(sigIn);
  } catch {
    return json(
      { isValid: false, payer, invalidReason: "invalid_payload" },
      { reqId, status: 400, extraHeaders: CORS }
    );
  }

  const publicClient = createPublicClient({ chain, transport: http(rpcUrl) });

  const baseDebug = {
    network,
    asset,
    payTo,
    payer,
    value: value.toString(),
    validAfter: validAfter.toString(),
    validBefore: validBefore.toString(),
    nonce: auth.nonce,
    sigFormat: "rsv65",
    rpcHost: (() => { try { return new URL(rpcUrl).host; } catch { return "unknown"; } })(),
  };

  async function trySim(mode) {
    const args = [
      payer,
      payTo,
      value,
      validAfter,
      validBefore,
      auth.nonce,
      parsedSig.v,
      parsedSig.r,
      parsedSig.s,
    ];

    return publicClient.simulateContract({
      address: asset,
      abi: usdcEip3009Abi,
      functionName: mode,
      args,
      account: payTo,
    });
  }

  // Attempt transfer first
  try {
    await trySim("transferWithAuthorization");
    dlog(env, reqId, "verify.ok", { ...baseDebug, mode: "transfer", ms: Date.now() - started });
    return json(
      debugEnabled(env) ? { isValid: true, payer, _debug: { ...baseDebug, mode: "transfer" } } : { isValid: true, payer },
      { reqId, extraHeaders: CORS }
    );
  } catch (e1) {
    const reason1 = mapRevertToReason(e1?.shortMessage || e1?.message || String(e1));
    dlog(env, reqId, "verify.transfer_failed", { ...baseDebug, reason1, err: safeErr(e1) });

    // Optional receiveWithAuthorization fallback
    const allowReceive =
      String(env.ALLOW_RECEIVE_WITH_AUTH || "") === "1" ||
      String(env.ALLOW_RECEIVE_WITH_AUTH || "").toLowerCase() === "true";

    if (allowReceive) {
      try {
        await trySim("receiveWithAuthorization");
        dlog(env, reqId, "verify.ok", { ...baseDebug, mode: "receive", ms: Date.now() - started });
        return json(
          debugEnabled(env) ? { isValid: true, payer, _debug: { ...baseDebug, mode: "receive" } } : { isValid: true, payer },
          { reqId, extraHeaders: CORS }
        );
      } catch (e2) {
        const reason2 = mapRevertToReason(e2?.shortMessage || e2?.message || String(e2));
        dlog(env, reqId, "verify.receive_failed", { ...baseDebug, reason2, err: safeErr(e2) });
      }
    }

    // Typed-data diagnostics (DEBUG only)
    if (debugEnabled(env)) {
      try {
        const chainId = chain.id;
        const expectedTokenName = await readTokenName(publicClient, asset);

        const domainNameCandidates = [
          expectedTokenName,
          payloadDomain?.name,
          paymentRequirements?.extra?.name,
        ].filter((x, i, arr) => typeof x === "string" && x.length > 0 && arr.indexOf(x) === i);

        const primaryTypes = ["TransferWithAuthorization", "ReceiveWithAuthorization"];
        const diag = { chainId, expectedTokenName, domainNameCandidates, recovered: {} };

        for (const domainName of domainNameCandidates) {
          for (const primaryType of primaryTypes) {
            const typedData = buildEip3009TypedData({
              domainName,
              chainId,
              verifyingContract: asset,
              primaryType,
              message: {
                from: payer,
                to: payTo,
                value,
                validAfter,
                validBefore,
                nonce: auth.nonce,
              },
            });

            try {
              const recovered = await recoverTypedDataAddress({
                domain: typedData.domain,
                types: typedData.types,
                primaryType: typedData.primaryType,
                message: typedData.message,
                signature: sigIn,
              });
              diag.recovered[`${domainName}:${primaryType}`] = recovered;
            } catch (e) {
              diag.recovered[`${domainName}:${primaryType}`] = { error: safeErr(e) };
            }
          }
        }

        dlog(env, reqId, "verify.typed_data_diag", { ...baseDebug, diag });
      } catch (e) {
        dlog(env, reqId, "verify.typed_data_diag_failed", { ...baseDebug, err: safeErr(e) });
      }
    }

    return json(
      debugEnabled(env)
        ? { isValid: false, payer, invalidReason: reason1, _debug: { ...baseDebug, reason1 } }
        : { isValid: false, payer, invalidReason: reason1 },
      { reqId, extraHeaders: CORS }
    );
  }
}

/* ------------------------------ /settle logic ----------------------------- */

async function handleSettle(request, env, reqId, CORS) {
  const started = Date.now();
  dlog(env, reqId, "settle.start", { path: "/settle" });

  let body;
  try {
    body = await request.json();
  } catch {
    return json(
      { success: false, payer: "unknown", transaction: "unknown", network: "unknown", errorReason: "invalid_payload" },
      { reqId, status: 400, extraHeaders: CORS }
    );
  }

  const paymentRequirements = body?.paymentRequirements || body?.requirements || body?.accepts?.[0] || null;
  const paymentPayload = body?.paymentPayload || body?.payload || null;

  if (!paymentRequirements || !paymentPayload) {
    return json(
      { success: false, payer: "unknown", transaction: "unknown", network: "unknown", errorReason: "invalid_payload" },
      { reqId, status: 400, extraHeaders: CORS }
    );
  }

  const network = paymentPayload?.network || paymentRequirements?.network;
  const chain = getChainForNetwork(network);
  const rpcUrl = getRpcUrlForNetwork(env, network);
  if (!chain || !rpcUrl) {
    return json(
      { success: false, payer: "unknown", transaction: "unknown", network: network || "unknown", errorReason: "invalid_network" },
      { reqId, status: 400, extraHeaders: CORS }
    );
  }

  const asset = normalizeEvmAddress(paymentRequirements?.asset);
  const payTo = normalizeEvmAddress(paymentRequirements?.payTo);
  if (!asset || !payTo) {
    return json(
      { success: false, payer: "unknown", transaction: "unknown", network, errorReason: "invalid_payment_requirements" },
      { reqId, status: 400, extraHeaders: CORS }
    );
  }

  const { signature: sigIn, authorization: auth } = extractEvmExactPayload(paymentPayload);
  const payer = normalizeEvmAddress(auth?.from);
  const to = normalizeEvmAddress(auth?.to);

  if (!payer || !to || !sigIn) {
    return json(
      { success: false, payer: "unknown", transaction: "unknown", network, errorReason: "invalid_payload" },
      { reqId, status: 400, extraHeaders: CORS }
    );
  }

  if (to !== payTo) {
    return json(
      { success: false, payer, transaction: "unknown", network, errorReason: "invalid_payment_requirements" },
      { reqId, status: 400, extraHeaders: CORS }
    );
  }

  let value, validAfter, validBefore;
  try {
    value = coerceBigIntString(auth?.value);
    validAfter = coerceBigIntString(auth?.validAfter);
    validBefore = coerceBigIntString(auth?.validBefore);
  } catch {
    return json(
      { success: false, payer, transaction: "unknown", network, errorReason: "invalid_payload" },
      { reqId, status: 400, extraHeaders: CORS }
    );
  }

  let parsedSig;
  try {
    parsedSig = parseSignature(sigIn);
  } catch {
    return json(
      { success: false, payer, transaction: "unknown", network, errorReason: "invalid_payload" },
      { reqId, status: 400, extraHeaders: CORS }
    );
  }

  const relayerPk = String(env.RELAYER_PRIVATE_KEY || env.PRIVATE_KEY || "");
  if (!/^0x[0-9a-fA-F]{64}$/.test(relayerPk)) {
    return json(
      { success: false, payer, transaction: "unknown", network, errorReason: "relayer_not_configured" },
      { reqId, status: 500, extraHeaders: CORS }
    );
  }

  const account = privateKeyToAccount(relayerPk);
  const publicClient = createPublicClient({ chain, transport: http(rpcUrl) });
  const walletClient = createWalletClient({ chain, transport: http(rpcUrl), account });

  const baseDebug = {
    network,
    asset,
    payTo,
    payer,
    value: value.toString(),
    validAfter: validAfter.toString(),
    validBefore: validBefore.toString(),
    nonce: auth?.nonce,
    relayer: account.address,
    rpcHost: (() => { try { return new URL(rpcUrl).host; } catch { return "unknown"; } })(),
  };

  const allowReceive =
    String(env.ALLOW_RECEIVE_WITH_AUTH || "") === "1" ||
    String(env.ALLOW_RECEIVE_WITH_AUTH || "").toLowerCase() === "true";

  const fn = allowReceive ? "receiveWithAuthorization" : "transferWithAuthorization";

  try {
    await publicClient.simulateContract({
      address: asset,
      abi: usdcEip3009Abi,
      functionName: fn,
      args: [payer, payTo, value, validAfter, validBefore, auth.nonce, parsedSig.v, parsedSig.r, parsedSig.s],
      account: payTo,
    });

    const hash = await walletClient.writeContract({
      address: asset,
      abi: usdcEip3009Abi,
      functionName: fn,
      args: [payer, payTo, value, validAfter, validBefore, auth.nonce, parsedSig.v, parsedSig.r, parsedSig.s],
    });

    dlog(env, reqId, "settle.ok", { ...baseDebug, fn, tx: hash, ms: Date.now() - started });

    return json(
      debugEnabled(env)
        ? { success: true, payer, transaction: hash, network, _debug: { ...baseDebug, fn } }
        : { success: true, payer, transaction: hash, network },
      { reqId, extraHeaders: CORS }
    );
  } catch (e) {
    const reason = mapRevertToReason(e?.shortMessage || e?.message || String(e));
    dlog(env, reqId, "settle.failed", { ...baseDebug, fn, reason, err: safeErr(e) });

    return json(
      debugEnabled(env)
        ? { success: false, payer, transaction: "unknown", network, errorReason: reason, _debug: { ...baseDebug, fn, err: safeErr(e) } }
        : { success: false, payer, transaction: "unknown", network, errorReason: reason },
      { reqId, status: 200, extraHeaders: CORS }
    );
  }
}
