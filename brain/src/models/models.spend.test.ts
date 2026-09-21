import type { LanguageModelV4 } from "@ai-sdk/provider";
import { afterEach, describe, expect, it } from "vitest";

import { applySpendCap, configureLlmBudget, SpendExceededError } from "../llm/index.js";
import { InMemorySpendStore } from "../operator/spend-store.js";
import { createLanguageModel } from "./models.js";

afterEach(() => {
    configureLlmBudget(undefined);
});

describe("createLanguageModel spend cap", () => {
    it("throws SpendExceededError from a factory model once the ceiling is reached", async () => {
        configureLlmBudget({
            store: new InMemorySpendStore(),
            userId: "tenant-a",
            dailyCeilingNanos: 0n,
            now: () => new Date("2026-09-21T12:00:00.000Z"),
        });
        const model = createLanguageModel(
            { flavor: "openai", apiKey: "sk-test-not-used" },
            "gpt-4.1-mini",
        );
        expect(typeof model).not.toBe("string");
        const instance = model as LanguageModelV4;
        await expect(instance.doGenerate({ prompt: [] } as never)).rejects.toBeInstanceOf(
            SpendExceededError,
        );
    });

    it("does not double-wrap the same instance", () => {
        const inner = {
            specificationVersion: "v4",
            provider: "fake",
            modelId: "gpt-4.1-mini",
            supportedUrls: {},
            doGenerate: async () => {
                throw new Error("should not run");
            },
            doStream: async () => {
                throw new Error("should not run");
            },
        } as unknown as LanguageModelV4;
        const first = applySpendCap(inner);
        const second = applySpendCap(inner);
        const third = applySpendCap(first);
        expect(first).toBe(second);
        expect(third).toBe(first);
    });
});
