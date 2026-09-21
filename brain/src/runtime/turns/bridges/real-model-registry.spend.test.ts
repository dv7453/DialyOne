import type { LanguageModel } from "ai";
import type { LanguageModelV4, LanguageModelV4Usage } from "@ai-sdk/provider";
import { afterEach, describe, expect, it } from "vitest";

import { configureLlmBudget, SpendExceededError } from "../../../llm/index.js";
import { InMemorySpendStore } from "../../../operator/spend-store.js";
import { RealModelRegistry } from "./real-model-registry.js";

const usage = (inputTokens: number, outputTokens: number): LanguageModelV4Usage => ({
    inputTokens: { total: inputTokens, noCache: inputTokens, cacheRead: undefined, cacheWrite: undefined },
    outputTokens: { total: outputTokens, text: outputTokens, reasoning: undefined },
});

function fakeModel(): LanguageModelV4 {
    return {
        specificationVersion: "v4",
        provider: "fake",
        modelId: "gpt-4.1-mini",
        supportedUrls: {},
        doGenerate: async () => ({
            content: [{ type: "text", text: "should not run" }],
            finishReason: { unified: "stop", raw: "stop" },
            usage: usage(2, 0),
            warnings: [],
        }),
        doStream: async () => ({
            stream: new ReadableStream({
                start(controller) {
                    controller.enqueue({ type: "text-delta", id: "t", delta: "nope" });
                    controller.close();
                },
            }),
        }),
    } as LanguageModelV4;
}

afterEach(() => {
    configureLlmBudget(undefined);
});

describe("RealModelRegistry spend cap", () => {
    it("throws SpendExceededError from a resolved model once the ceiling is reached", async () => {
        configureLlmBudget({
            store: new InMemorySpendStore(),
            userId: "tenant-a",
            dailyCeilingNanos: 0n,
            now: () => new Date("2026-09-21T12:00:00.000Z"),
        });
        const inner = fakeModel();
        let generated = false;
        inner.doGenerate = async () => {
            generated = true;
            return {
                content: [{ type: "text", text: "nope" }],
                finishReason: { unified: "stop", raw: "stop" },
                usage: usage(2, 0),
                warnings: [],
            };
        };
        const registry = new RealModelRegistry({
            resolveProvider: async () => ({ flavor: "openai" }),
            createProviderImpl: (() => ({
                languageModel: () => inner as unknown as LanguageModel,
            })) as never,
            invoke: (options) => {
                return {
                    stream: (async function* () {
                        await (options.model as LanguageModelV4).doGenerate({ prompt: [] } as never);
                    })(),
                };
            },
        });
        const resolved = await registry.resolve({ provider: "openai", model: "gpt-4.1-mini" });
        await expect(async () => {
            for await (const _event of resolved.stream({
                systemPrompt: "SYS",
                messages: [{ role: "user", content: "hello" }] as never,
                tools: [],
                parameters: {},
                signal: new AbortController().signal,
            })) {
                // drain
            }
        }).rejects.toBeInstanceOf(SpendExceededError);
        expect(generated).toBe(false);
    });
});
