/**
 * Unit tests for worker.js utility functions
 * Tests extractTokenUsage, calculateActualPrice, and usdToMicroUsdc
 */

import { describe, it, expect } from "vitest";

// Copy of extractTokenUsage from worker.js for unit testing
function extractTokenUsage(responseBody) {
  try {
    const data = JSON.parse(responseBody);
    if (data.usage) {
      return {
        promptTokens: data.usage.prompt_tokens || 0,
        completionTokens: data.usage.completion_tokens || 0,
        totalTokens: data.usage.total_tokens || 0,
        // OpenRouter returns actual cost in USD
        cost: data.usage.cost ?? null,
      };
    }
    // Some APIs use different field names
    if (data.meta?.tokens) {
      return {
        promptTokens: data.meta.tokens.input || 0,
        completionTokens: data.meta.tokens.output || 0,
        totalTokens: (data.meta.tokens.input || 0) + (data.meta.tokens.output || 0),
        cost: null,
      };
    }
  } catch (e) {
    // Silently fail for tests
  }
  return null;
}

// Copy of usdToMicroUsdc from worker.js for unit testing
function usdToMicroUsdc(usdCost, markup = 1.0) {
  const microUsdc = Math.ceil(usdCost * 1_000_000 * markup);
  return String(microUsdc);
}

// Copy of calculateActualPrice from worker.js for unit testing
function calculateActualPrice(tokenUsage, pricePerToken, minPrice = "1") {
  const tokens = tokenUsage.totalTokens;
  const perToken = typeof pricePerToken === "string" ? parseInt(pricePerToken, 10) : pricePerToken;
  const min = typeof minPrice === "string" ? parseInt(minPrice, 10) : minPrice;
  
  // Calculate: tokens * pricePerToken, with minimum
  const calculated = Math.ceil(tokens * perToken);
  const actual = Math.max(calculated, min);
  
  return String(actual);
}

describe("extractTokenUsage", () => {
  it("should extract OpenAI format usage", () => {
    const response = JSON.stringify({
      id: "chatcmpl-123",
      choices: [{ message: { content: "Hello!" } }],
      usage: {
        prompt_tokens: 10,
        completion_tokens: 5,
        total_tokens: 15,
      },
    });

    const result = extractTokenUsage(response);

    expect(result).toEqual({
      promptTokens: 10,
      completionTokens: 5,
      totalTokens: 15,
      cost: null,
    });
  });

  it("should extract OpenRouter format with cost", () => {
    const response = JSON.stringify({
      id: "gen-123",
      choices: [{ message: { content: "Hello!" } }],
      usage: {
        prompt_tokens: 10,
        completion_tokens: 4,
        total_tokens: 14,
        cost: 0.00014, // OpenRouter returns cost in USD
      },
    });

    const result = extractTokenUsage(response);

    expect(result).toEqual({
      promptTokens: 10,
      completionTokens: 4,
      totalTokens: 14,
      cost: 0.00014,
    });
  });

  it("should extract alternative meta.tokens format", () => {
    const response = JSON.stringify({
      data: { content: "Hello!" },
      meta: {
        tokens: {
          input: 20,
          output: 10,
        },
      },
    });

    const result = extractTokenUsage(response);

    expect(result).toEqual({
      promptTokens: 20,
      completionTokens: 10,
      totalTokens: 30,
      cost: null,
    });
  });

  it("should return null for invalid JSON", () => {
    const result = extractTokenUsage("not valid json{");
    expect(result).toBeNull();
  });

  it("should return null for missing usage field", () => {
    const response = JSON.stringify({
      id: "chatcmpl-123",
      choices: [{ message: { content: "Hello!" } }],
      // No usage field
    });

    const result = extractTokenUsage(response);
    expect(result).toBeNull();
  });

  it("should handle zero tokens", () => {
    const response = JSON.stringify({
      usage: {
        prompt_tokens: 0,
        completion_tokens: 0,
        total_tokens: 0,
      },
    });

    const result = extractTokenUsage(response);

    expect(result).toEqual({
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      cost: null,
    });
  });

  it("should handle partial usage data", () => {
    const response = JSON.stringify({
      usage: {
        total_tokens: 100,
        // Missing prompt_tokens and completion_tokens
      },
    });

    const result = extractTokenUsage(response);

    expect(result).toEqual({
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 100,
      cost: null,
    });
  });

  it("should handle zero cost explicitly", () => {
    const response = JSON.stringify({
      usage: {
        prompt_tokens: 10,
        completion_tokens: 5,
        total_tokens: 15,
        cost: 0,
      },
    });

    const result = extractTokenUsage(response);

    expect(result).toEqual({
      promptTokens: 10,
      completionTokens: 5,
      totalTokens: 15,
      cost: 0,
    });
  });
});

describe("usdToMicroUsdc", () => {
  it("should convert USD to micro-USDC", () => {
    // $0.00014 -> 140 micro-USDC
    const result = usdToMicroUsdc(0.00014);
    expect(result).toBe("140");
  });

  it("should apply markup correctly", () => {
    // $0.00014 * 1.1 (10% markup) -> 154 micro-USDC
    const result = usdToMicroUsdc(0.00014, 1.1);
    expect(result).toBe("154");
  });

  it("should round up fractional micro-USDC", () => {
    // $0.000001 -> 1 micro-USDC (ceil)
    const result = usdToMicroUsdc(0.000001);
    expect(result).toBe("1");
  });

  it("should handle larger amounts", () => {
    // $1.00 -> 1,000,000 micro-USDC
    const result = usdToMicroUsdc(1.0);
    expect(result).toBe("1000000");
  });

  it("should handle typical AI API costs", () => {
    // $0.002 (typical GPT-3.5 response) -> 2000 micro-USDC
    const result = usdToMicroUsdc(0.002);
    expect(result).toBe("2000");
  });

  it("should handle 20% markup", () => {
    // $0.001 * 1.2 = $0.0012 -> 1200 micro-USDC
    const result = usdToMicroUsdc(0.001, 1.2);
    expect(result).toBe("1200");
  });

  it("should return string", () => {
    const result = usdToMicroUsdc(0.00014);
    expect(typeof result).toBe("string");
  });

  it("should handle very small costs with ceiling", () => {
    // $0.0000001 -> 1 micro-USDC (minimum 1 due to ceiling)
    const result = usdToMicroUsdc(0.0000001);
    expect(result).toBe("1");
  });
});

describe("calculateActualPrice", () => {
  it("should calculate basic price: 100 tokens * 10 = 1000", () => {
    const result = calculateActualPrice({ totalTokens: 100 }, 10, 1);
    expect(result).toBe("1000");
  });

  it("should enforce minimum price: 5 tokens * 1 = 5, but min is 100", () => {
    const result = calculateActualPrice({ totalTokens: 5 }, 1, 100);
    expect(result).toBe("100");
  });

  it("should handle string inputs for pricePerToken", () => {
    const result = calculateActualPrice({ totalTokens: 50 }, "20", "10");
    expect(result).toBe("1000");
  });

  it("should use ceiling for fractional tokens", () => {
    // 7 tokens * 3 = 21, Math.ceil should still be 21
    const result = calculateActualPrice({ totalTokens: 7 }, 3, 1);
    expect(result).toBe("21");
  });

  it("should handle large token counts", () => {
    const result = calculateActualPrice({ totalTokens: 10000 }, 10, 100);
    expect(result).toBe("100000");
  });

  it("should return string result", () => {
    const result = calculateActualPrice({ totalTokens: 100 }, 10, 1);
    expect(typeof result).toBe("string");
  });

  it("should handle zero tokens with minimum price", () => {
    const result = calculateActualPrice({ totalTokens: 0 }, 10, 100);
    expect(result).toBe("100");
  });

  it("should use default minPrice of 1 if not provided", () => {
    const result = calculateActualPrice({ totalTokens: 0 }, 10);
    expect(result).toBe("1");
  });

  it("should calculate correctly when result equals minimum", () => {
    // 10 tokens * 10 = 100, minPrice = 100 -> should be 100
    const result = calculateActualPrice({ totalTokens: 10 }, 10, 100);
    expect(result).toBe("100");
  });

  it("should calculate correctly when result exceeds minimum", () => {
    // 100 tokens * 10 = 1000, minPrice = 100 -> should be 1000
    const result = calculateActualPrice({ totalTokens: 100 }, 10, 100);
    expect(result).toBe("1000");
  });
});
