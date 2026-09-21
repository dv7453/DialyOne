import { describe, expect, it } from "vitest";

import {
  computeCostNanos,
  FALLBACK_PRICE,
  priceForModel,
  tokensFromUsage,
} from "./prices.js";

describe("priceForModel", () => {
  it("prices gpt-4.1-mini at $0.40 / $1.60 per MTok", () => {
    expect(priceForModel("gpt-4.1-mini")).toEqual({
      inputNanosPerToken: 400,
      outputNanosPerToken: 1600,
    });
  });

  it("strips provider prefixes and dotted/dashed aliases", () => {
    expect(priceForModel("openai/gpt-4.1-mini")).toEqual(priceForModel("gpt-4.1-mini"));
    expect(priceForModel("anthropic/claude-opus-4.8")).toEqual(priceForModel("claude-opus-4-8"));
    expect(priceForModel("google/gemini-3.5-flash")).toEqual(priceForModel("gemini-3.5-flash"));
  });

  it("covers configured OpenAI, Anthropic, Gemini, Codex, Kimi, and Grok ids", () => {
    expect(priceForModel("gpt-5.4").inputNanosPerToken).toBe(2500);
    expect(priceForModel("gpt-5.6-sol").outputNanosPerToken).toBe(20_000);
    expect(priceForModel("claude-sonnet-5")).toEqual({
      inputNanosPerToken: 2000,
      outputNanosPerToken: 10_000,
    });
    expect(priceForModel("claude-haiku-4.5").inputNanosPerToken).toBe(1000);
    expect(priceForModel("gemini-2.0-flash-001").inputNanosPerToken).toBe(100);
    expect(priceForModel("moonshotai/kimi-k2.5").inputNanosPerToken).toBe(450);
    expect(priceForModel("x-ai/grok-4-fast").outputNanosPerToken).toBe(500);
  });

  it("uses the pessimistic fallback for unrecognised models", () => {
    expect(priceForModel("totally-unknown-sku-xyz")).toEqual(FALLBACK_PRICE);
    expect(priceForModel("")).toEqual(FALLBACK_PRICE);
  });
});

describe("computeCostNanos", () => {
  it("computes integer nano-USD from real token counts", () => {
    expect(computeCostNanos("gpt-4.1-mini", { inputTokens: 1_000_000, outputTokens: 0 })).toBe(400_000_000n);
    expect(computeCostNanos("gpt-4.1-mini", { inputTokens: 0, outputTokens: 1_000_000 })).toBe(1_600_000_000n);
    expect(computeCostNanos("gpt-4.1-mini", { inputTokens: 2, outputTokens: 3 })).toBe(2n * 400n + 3n * 1600n);
  });

  it("charges the fallback rate for an unknown model", () => {
    expect(computeCostNanos("mystery-v9", { inputTokens: 1, outputTokens: 1 })).toBe(
      BigInt(FALLBACK_PRICE.inputNanosPerToken) + BigInt(FALLBACK_PRICE.outputNanosPerToken),
    );
  });
});

describe("tokensFromUsage", () => {
  it("reads flat AI SDK usage", () => {
    expect(tokensFromUsage({ inputTokens: 10, outputTokens: 4, totalTokens: 14 })).toEqual({
      inputTokens: 10,
      outputTokens: 4,
    });
  });

  it("reads nested V4 usage totals", () => {
    expect(tokensFromUsage({
      inputTokens: { total: 8, noCache: 8 },
      outputTokens: { total: 2, text: 2 },
    })).toEqual({ inputTokens: 8, outputTokens: 2 });
  });

  it("treats total-only usage as output so an unknown split is not free", () => {
    expect(tokensFromUsage({ totalTokens: 12 })).toEqual({ inputTokens: 0, outputTokens: 12 });
  });
});
