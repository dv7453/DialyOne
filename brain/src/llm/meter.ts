import { wrapLanguageModel, generateText as sdkGenerateText, streamText as sdkStreamText, generateObject as sdkGenerateObject } from "ai";
import type { LanguageModelV4, LanguageModelV4Middleware, LanguageModelV4Usage } from "@ai-sdk/provider";

import {
  BudgetTracker,
  spendBudgetOptions,
  type SpendBudgetOptions,
  type SpendReservation,
  type TokenEstimate,
} from "../operator/budget.js";
import type { SpendStore } from "../operator/spend-store.js";

let activeTracker: BudgetTracker | undefined;
const cappedModels = new WeakMap<object, object>();

export type ConfigureLlmBudgetInput = {
  store: SpendStore;
  userId?: string;
  dailyCeilingNanos?: bigint;
  now?: () => Date;
  tracker?: BudgetTracker;
};

export function configureLlmBudget(input: ConfigureLlmBudgetInput | undefined): void {
  if (!input) {
    activeTracker = undefined;
    return;
  }
  if (input.tracker) {
    activeTracker = input.tracker;
    return;
  }
  const spend: SpendBudgetOptions = spendBudgetOptions(input.store, {
    userId: input.userId,
    dailyCeilingNanos: input.dailyCeilingNanos,
    now: input.now,
  });
  activeTracker = new BudgetTracker({}, spend);
}

export function getLlmBudgetTracker(): BudgetTracker | undefined {
  return activeTracker;
}

export type MeteredCallInput = {
  modelId: string;
  userId?: string;
  estimate?: TokenEstimate;
};

export async function meterLlmCall<T>(
  input: MeteredCallInput,
  run: () => Promise<{ value: T; usage?: unknown }>,
): Promise<T> {
  const tracker = activeTracker;
  if (!tracker?.hasSpendEnforcement()) {
    return (await run()).value;
  }

  const reservation = await tracker.reserveCall({
    modelId: input.modelId,
    ...(input.userId ? { userId: input.userId } : {}),
    estimate: input.estimate,
  });
  try {
    const { value, usage } = await run();
    await tracker.settleCall(reservation, usage);
    return value;
  } catch (error) {
    await tracker.releaseCall(reservation);
    throw error;
  }
}

function v4Usage(usage: LanguageModelV4Usage): unknown {
  return usage;
}

async function settleOrKeep(tracker: BudgetTracker, reservation: SpendReservation | undefined, usage: unknown): Promise<void> {
  await tracker.settleCall(reservation, usage);
}

function spendMiddleware(): LanguageModelV4Middleware {
  return {
    specificationVersion: "v4",
    wrapGenerate: async ({ doGenerate, model }) => {
      const tracker = activeTracker;
      if (!tracker?.hasSpendEnforcement()) {
        return doGenerate();
      }
      const reservation = await tracker.reserveCall({
        modelId: model.modelId,
      });
      try {
        const result = await doGenerate();
        await settleOrKeep(tracker, reservation, v4Usage(result.usage));
        return result;
      } catch (error) {
        await tracker.releaseCall(reservation);
        throw error;
      }
    },
    wrapStream: async ({ doStream, model }) => {
      const tracker = activeTracker;
      if (!tracker?.hasSpendEnforcement()) {
        return doStream();
      }
      const reservation = await tracker.reserveCall({
        modelId: model.modelId,
      });
      try {
        const result = await doStream();
        let settled = false;
        const upstream = result.stream.getReader();
        const stream = new ReadableStream({
          async pull(controller) {
            try {
              const { done, value } = await upstream.read();
              if (done) {
                if (!settled) {
                  settled = true;
                  await tracker.settleCall(reservation);
                }
                controller.close();
                return;
              }
              if (value.type === "finish") {
                settled = true;
                await tracker.settleCall(reservation, v4Usage(value.usage));
              } else if (value.type === "error") {
                settled = true;
                await tracker.releaseCall(reservation);
              }
              controller.enqueue(value);
            } catch (error) {
              if (!settled) {
                settled = true;
                await tracker.releaseCall(reservation);
              }
              controller.error(error);
            }
          },
          async cancel(reason) {
            if (!settled) {
              settled = true;
              await tracker.releaseCall(reservation);
            }
            await upstream.cancel(reason);
          },
        });
        return { ...result, stream };
      } catch (error) {
        await tracker.releaseCall(reservation);
        throw error;
      }
    },
  };
}

export function applySpendCap(model: LanguageModelV4): LanguageModelV4 {
  const existing = cappedModels.get(model);
  if (existing) {
    return existing as LanguageModelV4;
  }
  const wrapped = wrapLanguageModel({
    model,
    middleware: spendMiddleware(),
  }) as LanguageModelV4;
  cappedModels.set(model, wrapped);
  cappedModels.set(wrapped, wrapped);
  return wrapped;
}

export async function generateText(
  ...args: Parameters<typeof sdkGenerateText>
): ReturnType<typeof sdkGenerateText> {
  const options = args[0];
  const model = options.model;
  if (typeof model === "string") {
    return meterLlmCall({ modelId: model }, async () => {
      const result = await sdkGenerateText(options);
      return { value: result, usage: result.usage };
    });
  }
  return sdkGenerateText({
    ...options,
    model: applySpendCap(model as LanguageModelV4) as typeof model,
  });
}

export function streamText(
  ...args: Parameters<typeof sdkStreamText>
): ReturnType<typeof sdkStreamText> {
  const options = args[0];
  const model = options.model;
  if (typeof model === "string") {
    return sdkStreamText(options);
  }
  return sdkStreamText({
    ...options,
    model: applySpendCap(model as LanguageModelV4) as typeof model,
  });
}

export async function generateObject(
  ...args: Parameters<typeof sdkGenerateObject>
): ReturnType<typeof sdkGenerateObject> {
  const options = args[0];
  const model = "model" in options ? options.model : undefined;
  if (typeof model === "string") {
    return meterLlmCall({ modelId: model }, async () => {
      const result = await sdkGenerateObject(options);
      return { value: result, usage: result.usage };
    });
  }
  if (model && typeof model === "object") {
    return sdkGenerateObject({
      ...options,
      model: applySpendCap(model as LanguageModelV4) as typeof model,
    } as typeof options);
  }
  return sdkGenerateObject(options);
}
