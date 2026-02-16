#!/usr/bin/env node
/**
 * End-to-end test for the custom x402 facilitator on Base mainnet.
 *
 * Flow:
 *   1. Hit x402 proxy → get 402
 *   2. Sign payment via Convex walletSigning:signPayment action (direct, no API key)
 *   3. Retry with PAYMENT-SIGNATURE → gateway → custom facilitator → verify → settle → OpenRouter
 *   4. Confirm chat response
 */

import * as https from "node:https";

// ─── Config ─────────────────────────────────────────────────────────────────
const CONVEX_URL = "https://marvelous-wolf-471.convex.cloud";
const X402_PROXY_URL = "https://rishabhspro.x402instant.com";
const FACILITATOR_URL = "https://facilitator.x402instant.com";
const USER_ID = "k579qks03y4x4k7gcqr74vrpnn808x40";
const WALLET_ID = "0x9a95677df6ed534bbb2521936eeca92b268b94db"; // Rishabh Mainnet Wallet (2.96 USDC)

// ─── Helpers ────────────────────────────────────────────────────────────────
function httpsRequest(url, opts) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = https.request(
      {
        hostname: u.hostname,
        port: 443,
        path: u.pathname + u.search,
        method: opts.method || "GET",
        headers: opts.headers || {},
      },
      (res) => {
        let body = "";
        res.on("data", (c) => (body += c));
        res.on("end", () => {
          const hdrs = {};
          for (const [k, v] of Object.entries(res.headers)) {
            hdrs[k] = Array.isArray(v) ? v[0] : v;
          }
          resolve({ status: res.statusCode, body, headers: hdrs });
        });
      }
    );
    req.on("error", reject);
    if (opts.body) req.write(opts.body);
    req.end();
  });
}

async function convexAction(functionPath, args) {
  const res = await fetch(`${CONVEX_URL}/api/action`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path: functionPath, args }),
  });
  const body = await res.json();
  if (body.status === "error") throw new Error(body.errorMessage);
  return body.value;
}

function ok(label) {
  console.log(`  ✓ ${label}`);
}
function fail(label) {
  console.log(`  ✗ ${label}`);
}

// ─── Main ───────────────────────────────────────────────────────────────────
async function main() {
  console.log("╔══════════════════════════════════════════════════════╗");
  console.log("║  x402 Custom Facilitator — E2E Test (Base Mainnet)  ║");
  console.log("╚══════════════════════════════════════════════════════╝\n");

  // ── Step 0: Check facilitator health ──────────────────────────────────
  console.log("0. Checking custom facilitator...");
  try {
    const health = await fetch(`${FACILITATOR_URL}/supported`);
    const supported = await health.json();
    console.log(`   ${FACILITATOR_URL}`);
    console.log(`   Schemes: ${JSON.stringify(supported.schemes)}`);
    ok("Facilitator is live\n");
  } catch (e) {
    fail(`Facilitator unreachable: ${e.message}\n`);
    process.exit(1);
  }

  // ── Step 1: Request to proxy → 402 ───────────────────────────────────
  console.log("1. Sending request to x402 proxy...");
  const chatBody = JSON.stringify({
    model: "openai/gpt-3.5-turbo",
    messages: [
      { role: "user", content: "Say 'Hello from x402 E2E test!' and nothing else." },
    ],
    max_tokens: 30,
  });

  const proxyUrl = `${X402_PROXY_URL}/chat/completions`;
  const initialRes = await httpsRequest(proxyUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Content-Length": Buffer.byteLength(chatBody).toString(),
    },
    body: chatBody,
  });

  console.log(`   Status: ${initialRes.status}`);
  if (initialRes.status !== 402) {
    fail(`Expected 402, got ${initialRes.status}`);
    console.log(`   Body: ${initialRes.body.slice(0, 500)}`);
    process.exit(1);
  }

  const paymentRequired = JSON.parse(initialRes.body);
  const accept = paymentRequired.accepts[0];
  console.log(`   Scheme: ${accept.scheme}  Network: ${accept.network}`);
  console.log(`   Amount: ${accept.maxAmountRequired} (${(Number(accept.maxAmountRequired) / 1e6).toFixed(4)} USDC)`);
  console.log(`   PayTo: ${accept.payTo}`);
  ok("Got 402 Payment Required\n");

  // ── Step 2: Sign payment via Convex directly ──────────────────────────
  console.log("2. Signing payment via Convex walletSigning:signPayment...");
  console.log(`   User: ${USER_ID}`);
  console.log(`   Wallet: ${WALLET_ID}`);

  let signResult;
  try {
    signResult = await convexAction("walletSigning:signPayment", {
      userId: USER_ID,
      walletId: WALLET_ID,
      paymentRequired,
    });
  } catch (e) {
    fail(`Convex action failed: ${e.message}`);
    process.exit(1);
  }

  console.log(`   Success: ${signResult.success}`);

  if (!signResult.success || !signResult.signature) {
    fail(`Signing failed: ${signResult.error}`);
    process.exit(1);
  }

  const signature = signResult.signature;
  console.log(`   Signature length: ${signature.length} chars`);

  // Decode and peek at the payload
  try {
    const decoded = JSON.parse(Buffer.from(signature, "base64").toString());
    console.log(`   Payload keys: ${Object.keys(decoded).join(", ")}`);
    if (decoded.authorization) {
      console.log(`   From: ${decoded.authorization.from}`);
      console.log(`   To:   ${decoded.authorization.to}`);
      console.log(`   Value: ${decoded.authorization.value}`);
    }
  } catch {
    console.log(`   (raw signature, not base64 JSON)`);
  }
  ok("Payment signed\n");

  // ── Step 3: Wait for CDP propagation ──────────────────────────────────
  console.log("3. Waiting 1.5s for CDP state propagation...");
  await new Promise((r) => setTimeout(r, 1500));
  ok("Ready\n");

  // ── Step 4: Retry with payment signature ──────────────────────────────
  console.log("4. Retrying with PAYMENT-SIGNATURE header...");
  console.log("   Gateway → custom facilitator verify → settle → OpenRouter\n");

  const retryRes = await httpsRequest(proxyUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Content-Length": Buffer.byteLength(chatBody).toString(),
      "PAYMENT-SIGNATURE": signature,
    },
    body: chatBody,
  });

  console.log(`   Response status: ${retryRes.status}`);

  // ── Step 5: Evaluate result ───────────────────────────────────────────
  if (retryRes.status === 200) {
    console.log("");
    ok("PAYMENT FLOW SUCCEEDED!\n");

    const result = JSON.parse(retryRes.body);
    console.log(`   Model: ${result.model}`);
    console.log(`   Response: ${result.choices?.[0]?.message?.content}`);
    if (result.usage) {
      console.log(`   Tokens: ${result.usage.prompt_tokens} prompt + ${result.usage.completion_tokens} completion = ${result.usage.total_tokens} total`);
    }

    // Check for payment response header
    const paymentResponse =
      retryRes.headers["payment-response"] ||
      retryRes.headers["x-payment-response"];
    if (paymentResponse) {
      try {
        const pr = JSON.parse(Buffer.from(paymentResponse, "base64").toString());
        console.log(`\n   Settlement TX: ${pr.transaction || pr.txHash || "N/A"}`);
        console.log(`   Payer: ${pr.payer || "N/A"}`);
        console.log(`   Network: ${pr.network || "N/A"}`);
      } catch {
        console.log(`   Payment response: ${paymentResponse.slice(0, 80)}...`);
      }
    }
  } else if (retryRes.status === 402) {
    fail("Still got 402 — payment verification or settlement failed\n");
    try {
      const errBody = JSON.parse(retryRes.body);
      console.log(`   Error: ${errBody.error || "unknown"}`);
      console.log(`   Reason: ${errBody.invalidReason || errBody.accepts?.[0]?.description || "unknown"}`);
      if (errBody.debug) console.log(`   Debug: ${JSON.stringify(errBody.debug, null, 2)}`);
    } catch {
      console.log(`   Raw: ${retryRes.body.slice(0, 500)}`);
    }
    process.exit(1);
  } else {
    fail(`Unexpected status: ${retryRes.status}\n`);
    console.log(`   Body: ${retryRes.body.slice(0, 500)}`);
    process.exit(1);
  }

  console.log("\n╔══════════════════════════════════════════════════╗");
  console.log("║              E2E TEST COMPLETE                   ║");
  console.log("╚══════════════════════════════════════════════════╝");
}

main().catch((e) => {
  console.error("\nFatal error:", e);
  process.exit(1);
});
