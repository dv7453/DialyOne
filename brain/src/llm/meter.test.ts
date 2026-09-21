import type { LanguageModelV4, LanguageModelV4Usage } from "@ai-sdk/provider";
import { afterEach, describe, expect, it } from "vitest";

import {
  BudgetTracker,
  DEFAULT_RESERVE_INPUT_TOKENS,
  DEFAULT_RESERVE_OUTPUT_TOKENS,
  SpendExceededError,
} from "../operator/budget.js";
import { InMemorySpendStore } from "../operator/spend-store.js";
import { applySpendCap, configureLlmBudget, meterLlmCall } from "./meter.js";
import { computeCostNanos } from "./prices.js";

const usage = (inputTokens: number, outputTokens: number): LanguageModelV4Usage => ({
  inputTokens: { total: inputTokens, noCache: inputTokens, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: outputTokens, text: outputTokens, reasoning: undefined },
});

function fakeModel(modelId: string, inputTokens: number, outputTokens: number): LanguageModelV4 {
  return {
    specificationVersion: "v4",
    provider: "fake",
    modelId,
    supportedUrls: {},
    doGenerate: async () => ({
      content: [{ type: "text", text: "ok" }],
      finishReason: { unified: "stop", raw: "stop" },
      usage: usage(inputTokens, outputTokens),
      warnings: [],
    }),
    doStream: async () => ({
      stream: new ReadableStream({
        start(controller) {
          controller.enqueue({ type: "text-start", id: "t" });
          controller.enqueue({ type: "text-delta", id: "t", delta: "ok" });
          controller.enqueue({ type: "text-end", id: "t" });
          controller.enqueue({ type: "finish", finishReason: { unified: "stop", raw: "stop" }, usage: usage(inputTokens, outputTokens) });
          controller.close();
        },
      }),
    }),
  } as LanguageModelV4;
}

afterEach(() => {
  configureLlmBudget(undefined);
});

describe("meterLlmCall", () => {
  it("does not invoke the inner call when the ceiling is already reached", async () => {
    const store = new InMemorySpendStore();
    configureLlmBudget({
      store,
      userId: "u",
      dailyCeilingNanos: 800n,
      now: () => new Date("2026-09-21T12:00:00.000Z"),
    });
    await meterLlmCall(
      { modelId: "gpt-4.1-mini", estimate: { inputTokens: 2, outputTokens: 0 } },
      async () => ({ value: "first", usage: { inputTokens: 2, outputTokens: 0 } }),
    );

    let ran = false;
    await expect(meterLlmCall(
      { modelId: "gpt-4.1-mini", estimate: { inputTokens: 2, outputTokens: 0 } },
      async () => {
        ran = true;
        return { value: "second", usage: { inputTokens: 2, outputTokens: 0 } };
      },
    )).rejects.toBeInstanceOf(SpendExceededError);
    expect(ran).toBe(false);
  });

  it("records usage from the response after a successful call", async () => {
    const store = new InMemorySpendStore();
    const budget = new BudgetTracker({}, {
      store,
      userId: "u",
      dailyCeilingNanos: 10_000n,
      now: () => new Date("2026-09-21T12:00:00.000Z"),
    });
    configureLlmBudget({ store, tracker: budget });
    await meterLlmCall(
      { modelId: "gpt-4.1-mini", estimate: { inputTokens: 20, outputTokens: 0 } },
      async () => ({ value: "ok", usage: { inputTokens: 2, outputTokens: 1 } }),
    );
    const snap = await budget.snapshot();
    expect(snap?.spentNanos).toBe(2400n);
  });

  it("passes through unchanged when no store is configured", async () => {
    const value = await meterLlmCall(
      { modelId: "mystery-v9", estimate: { inputTokens: 1_000_000, outputTokens: 1_000_000 } },
      async () => ({ value: 42, usage: { inputTokens: 1_000_000, outputTokens: 1_000_000 } }),
    );
    expect(value).toBe(42);
  });

  it("releases the reservation when the inner call throws", async () => {
    const store = new InMemorySpendStore();
    const budget = new BudgetTracker({}, {
      store,
      userId: "u",
      dailyCeilingNanos: 800n,
      now: () => new Date("2026-09-21T12:00:00.000Z"),
    });
    configureLlmBudget({ store, tracker: budget });
    await expect(meterLlmCall(
      { modelId: "gpt-4.1-mini", estimate: { inputTokens: 2, outputTokens: 0 } },
      async () => {
        throw new Error("provider down");
      },
    )).rejects.toThrow("provider down");
    const snap = await budget.snapshot();
    expect(snap?.reservedNanos).toBe(0n);
    expect(snap?.spentNanos).toBe(0n);
    expect(snap?.remainingNanos).toBe(800n);
  });
});

describe("applySpendCap", () => {
  it("blocks doGenerate before the model runs when the cap is spent", async () => {
    const store = new InMemorySpendStore();
    const ceiling = computeCostNanos("gpt-4.1-mini", {
      inputTokens: DEFAULT_RESERVE_INPUT_TOKENS,
      outputTokens: DEFAULT_RESERVE_OUTPUT_TOKENS,
    });
    configureLlmBudget({
      store,
      userId: "u",
      dailyCeilingNanos: ceiling,
      now: () => new Date("2026-09-21T12:00:00.000Z"),
    });
    const first = applySpendCap(fakeModel("gpt-4.1-mini", 2, 0));
    await first.doGenerate({ prompt: [] } as never);

    let generated = false;
    const inner = applySpendCap({
      ...fakeModel("gpt-4.1-mini", 2, 0),
      doGenerate: async () => {
        generated = true;
        return {
          content: [{ type: "text", text: "nope" }],
          finishReason: { unified: "stop", raw: "stop" },
          usage: usage(2, 0),
          warnings: [],
        };
      },
    } as LanguageModelV4);
    await expect(inner.doGenerate({ prompt: [] } as never)).rejects.toBeInstanceOf(SpendExceededError);
    expect(generated).toBe(false);
  });

  it("is a no-op wrapper when budget is not configured", async () => {
    const model = applySpendCap(fakeModel("mystery-v9", 100, 100));
    const result = await model.doGenerate({ prompt: [], maxOutputTokens: 16 } as never);
    expect(result.finishReason.unified).toBe("stop");
  });
});
