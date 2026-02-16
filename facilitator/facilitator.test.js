/**
 * Tests for the x402 custom facilitator (facilitator/worker.js)
 * Run with: npm run test:facilitator
 */

import { SELF } from "cloudflare:test";
import { describe, it, expect } from "vitest";

const BASE = "http://facilitator.test";

describe("x402 Facilitator", () => {
  describe("health", () => {
    it("GET / returns ok", async () => {
      const res = await SELF.fetch(`${BASE}/`);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toEqual({ ok: true });
    });

    it("GET /health returns ok", async () => {
      const res = await SELF.fetch(`${BASE}/health`);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toEqual({ ok: true });
    });
  });

  describe("supported", () => {
    it("GET /supported returns schemes and networks", async () => {
      const res = await SELF.fetch(`${BASE}/supported`);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.x402Version).toBe(1);
      expect(body.schemes).toBeDefined();
      expect(Array.isArray(body.schemes)).toBe(true);
      const exactScheme = body.schemes.find((s) => s.scheme === "exact");
      expect(exactScheme).toBeDefined();
      expect(exactScheme.networks).toContain("base");
      expect(exactScheme.networks).toContain("base-sepolia");
    });

    it("GET /x402/supported returns same", async () => {
      const res = await SELF.fetch(`${BASE}/x402/supported`);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.schemes).toBeDefined();
    });

    it("GET /v2/x402/supported returns same", async () => {
      const res = await SELF.fetch(`${BASE}/v2/x402/supported`);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.schemes).toBeDefined();
    });
  });

  describe("verify", () => {
    it("POST /verify with empty body returns 400 invalid_payload", async () => {
      const res = await SELF.fetch(`${BASE}/verify`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.isValid).toBe(false);
      expect(body.invalidReason).toBe("invalid_payload");
    });

    it("POST /verify with missing paymentRequirements returns 400", async () => {
      const res = await SELF.fetch(`${BASE}/verify`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          paymentPayload: { network: "base-sepolia" },
        }),
      });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.isValid).toBe(false);
      expect(body.invalidReason).toBe("invalid_payload");
    });

    it("POST /verify with invalid network returns 400", async () => {
      const res = await SELF.fetch(`${BASE}/verify`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          paymentRequirements: {
            network: "unsupported-network",
            asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
            payTo: "0x9A95677Df6ED534bbb2521936eEca92B268B94Db",
            maxAmountRequired: "1000000",
          },
          paymentPayload: {
            network: "unsupported-network",
            payload: {
              authorization: {
                from: "0x0000000000000000000000000000000000000001",
                to: "0x9A95677Df6ED534bbb2521936eEca92B268B94Db",
                value: "1000000",
                validAfter: "0",
                validBefore: "9999999999",
                nonce: "0x0000000000000000000000000000000000000000000000000000000000000001",
              },
              signature:
                "0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef12",
            },
          },
        }),
      });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.isValid).toBe(false);
      expect(body.invalidReason).toBe("invalid_network");
    });

    it("POST /verify with valid structure responds (200 or 400)", async () => {
      // Base Sepolia USDC - valid structure, invalid signature (hits real RPC)
      const res = await SELF.fetch(`${BASE}/verify`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          paymentRequirements: {
            scheme: "exact",
            network: "base-sepolia",
            asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
            payTo: "0x9A95677Df6ED534bbb2521936eEca92B268B94Db",
            maxAmountRequired: "1000000",
          },
          paymentPayload: {
            x402Version: 1,
            scheme: "exact",
            network: "base-sepolia",
            payload: {
              authorization: {
                from: "0x0000000000000000000000000000000000000001",
                to: "0x9A95677Df6ED534bbb2521936eEca92B268B94Db",
                value: "1000000",
                validAfter: "0",
                validBefore: "9999999999",
                nonce: "0x0000000000000000000000000000000000000000000000000000000000000001",
              },
              signature:
                "0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef12",
            },
          },
        }),
      });
      // 200 = reached RPC, got isValid: false; 400 = validation failed before RPC (e.g. bad signature format)
      expect([200, 400]).toContain(res.status);
      const body = await res.json();
      expect(body.isValid).toBe(false);
      expect(body.invalidReason).toBeDefined();
    });
  });

  describe("CORS", () => {
    it("OPTIONS returns 204 with CORS headers", async () => {
      const res = await SELF.fetch(`${BASE}/`, {
        method: "OPTIONS",
      });
      expect(res.status).toBe(204);
      expect(res.headers.get("access-control-allow-origin")).toBe("*");
      expect(res.headers.get("access-control-allow-methods")).toContain("POST");
    });
  });

  describe("404", () => {
    it("unknown path returns 404", async () => {
      const res = await SELF.fetch(`${BASE}/unknown`);
      expect(res.status).toBe(404);
      const body = await res.json();
      expect(body.ok).toBe(false);
      expect(body.error).toBe("not_found");
    });
  });
});
