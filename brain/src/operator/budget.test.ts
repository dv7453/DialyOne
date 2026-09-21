import { describe, expect, it } from "vitest";

import {
  BudgetTracker,
  DEFAULT_DAILY_SPEND_CAP_USD,
  SpendExceededError,
  dailySpendCeilingNanos,
  isSpendExceededError,
  runWithBudgetUser,
  usdToNanos,
} from "./budget.js";
import { InMemorySpendStore } from "./spend-store.js";

function tracker(opts: {
  ceilingNanos: bigint;
  now?: () => Date;
  userId?: string;
  store?: InMemorySpendStore;
}): { tracker: BudgetTracker; store: InMemorySpendStore } {
  const store = opts.store ?? new InMemorySpendStore();
  return {
    store,
    tracker: new BudgetTracker({}, {
      store,
      userId: opts.userId ?? "founder",
      dailyCeilingNanos: opts.ceilingNanos,
      now: opts.now,
    }),
  };
}

describe("playbook call-count budget (existing API)", () => {
  it("does not exceed until counts pass the configured maxima", () => {
    const budget = new BudgetTracker({ max_model_calls: 1, max_tool_rounds: 1, on_exceed: "abort" });
    expect(budget.recordModelCall()).toEqual({ exceeded: false });
    expect(budget.recordModelCall()).toEqual({ exceeded: true, action: "abort" });
    expect(budget.recordToolRound()).toEqual({ exceeded: true, action: "abort" });
  });
});

describe("usdToNanos", () => {
  it("parses whole and fractional dollars without float math", () => {
    expect(usdToNanos("5")).toBe(5_000_000_000n);
    expect(usdToNanos("5.00")).toBe(5_000_000_000n);
    expect(usdToNanos("0.01")).toBe(10_000_000n);
    expect(usdToNanos(DEFAULT_DAILY_SPEND_CAP_USD)).toBe(5_000_000_000n);
  });

  it("defaults the daily ceiling to $5", () => {
    expect(dailySpendCeilingNanos({})).toBe(5_000_000_000n);
    expect(dailySpendCeilingNanos({ DIALY_DAILY_SPEND_CAP_USD: "2.5" })).toBe(2_500_000_000n);
  });
});

describe("spend ceiling", () => {
  it("blocks a call before the inner work runs once the ceiling is already reached", async () => {
    const { tracker: budget } = tracker({ ceilingNanos: 800n });
    const reservation = await budget.reserveCall({
      modelId: "gpt-4.1-mini",
      estimate: { inputTokens: 2, outputTokens: 0 },
    });
    await budget.settleCall(reservation, { inputTokens: 2, outputTokens: 0 });

    let ran = false;
    await expect(budget.reserveCall({
      modelId: "gpt-4.1-mini",
      estimate: { inputTokens: 2, outputTokens: 0 },
    })).rejects.toSatisfy((error: unknown) => {
      expect(ran).toBe(false);
      expect(error).toBeInstanceOf(SpendExceededError);
      expect(isSpendExceededError(error)).toBe(true);
      return true;
    });
    expect(ran).toBe(false);

    const snap = await budget.snapshot();
    expect(snap?.spentNanos).toBe(800n);
    expect(snap?.remainingNanos).toBe(0n);
  });

  it("is distinguishable from a generic failure by type and name", async () => {
    const { tracker: budget } = tracker({ ceilingNanos: 1n });
    try {
      await budget.reserveCall({
        modelId: "mystery-v9",
        estimate: { inputTokens: 1, outputTokens: 1 },
      });
      throw new Error("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(SpendExceededError);
      expect((error as Error).name).toBe("SpendExceededError");
      expect(error instanceof TypeError).toBe(false);
    }
  });

  it("records actual token counts from the response, not the reservation estimate", async () => {
    const { tracker: budget } = tracker({ ceilingNanos: 10_000n });
    const reservation = await budget.reserveCall({
      modelId: "gpt-4.1-mini",
      estimate: { inputTokens: 20, outputTokens: 0 },
    });
    expect(reservation?.reservedNanos).toBe(8000n);
    await budget.settleCall(reservation, { inputTokens: 2, outputTokens: 1 });
    const snap = await budget.snapshot();
    expect(snap?.spentNanos).toBe(2n * 400n + 1n * 1600n);
    expect(snap?.reservedNanos).toBe(0n);
    expect(snap?.remainingNanos).toBe(10_000n - 2400n);
  });

  it("rolls over committed spend at UTC midnight", async () => {
    let now = new Date("2026-09-21T23:59:59.000Z");
    const { tracker: budget } = tracker({
      ceilingNanos: 800n,
      now: () => now,
    });
    const reservation = await budget.reserveCall({
      modelId: "gpt-4.1-mini",
      estimate: { inputTokens: 2, outputTokens: 0 },
    });
    await budget.settleCall(reservation, { inputTokens: 2, outputTokens: 0 });
    expect((await budget.snapshot())?.day).toBe("2026-09-21");
    expect((await budget.snapshot())?.spentNanos).toBe(800n);

    now = new Date("2026-09-22T00:00:00.000Z");
    const next = await budget.snapshot();
    expect(next?.day).toBe("2026-09-22");
    expect(next?.spentNanos).toBe(0n);
    expect(next?.remainingNanos).toBe(800n);
    await expect(budget.reserveCall({
      modelId: "gpt-4.1-mini",
      estimate: { inputTokens: 2, outputTokens: 0 },
    })).resolves.toMatchObject({ day: "2026-09-22" });
  });

  it("prevents concurrent reservations from collectively exceeding the cap", async () => {
    const { tracker: budget } = tracker({ ceilingNanos: 1600n });
    const estimate = { inputTokens: 2, outputTokens: 0 };
    const results = await Promise.allSettled(
      Array.from({ length: 5 }, () => budget.reserveCall({ modelId: "gpt-4.1-mini", estimate })),
    );
    const accepted = results.filter((result) => result.status === "fulfilled");
    const blocked = results.filter(
      (result) => result.status === "rejected" && result.reason instanceof SpendExceededError,
    );
    expect(accepted).toHaveLength(2);
    expect(blocked).toHaveLength(3);
    const snap = await budget.snapshot();
    expect(snap?.reservedNanos).toBe(1600n);
    expect(snap?.spentNanos).toBe(0n);
    expect(snap?.remainingNanos).toBe(0n);
  });

  it("does not change behaviour when no spend store is configured", async () => {
    const budget = new BudgetTracker({ max_model_calls: 2 });
    expect(budget.hasSpendEnforcement()).toBe(false);
    await expect(budget.reserveCall({ modelId: "gpt-4.1-mini" })).resolves.toBeUndefined();
    await expect(budget.settleCall(undefined, { inputTokens: 99, outputTokens: 99 })).resolves.toBeUndefined();
    await expect(budget.snapshot()).resolves.toBeUndefined();
    expect(budget.recordModelCall()).toEqual({ exceeded: false });
    expect(budget.recordModelCall()).toEqual({ exceeded: false });
    expect(budget.recordModelCall()).toEqual({ exceeded: true, action: "escalate" });
  });

  it("uses the ALS user id when the tracker has no frozen user", async () => {
    const store = new InMemorySpendStore();
    const budget = new BudgetTracker({}, {
      store,
      dailyCeilingNanos: 800n,
      now: () => new Date("2026-09-21T12:00:00.000Z"),
    });
    await runWithBudgetUser("tenant-a", async () => {
      const reservation = await budget.reserveCall({
        modelId: "gpt-4.1-mini",
        estimate: { inputTokens: 2, outputTokens: 0 },
      });
      await budget.settleCall(reservation, { inputTokens: 2, outputTokens: 0 });
    });
    await expect(store.get("tenant-a", "2026-09-21")).resolves.toMatchObject({ committedNanos: 800n });
    await expect(store.get("local", "2026-09-21")).resolves.toMatchObject({ committedNanos: 0n });
  });
});
