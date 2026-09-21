import { describe, expect, it } from "vitest";

import { SpendExceededError } from "./budget.js";
import { classifyFailure } from "./retry.js";
import type { CapabilityResult } from "./capabilities/types.js";

function failed(error: string, extra: Partial<CapabilityResult> = {}): CapabilityResult {
  return { ok: false, capability: "deploy.restart", error, ...extra };
}

function spendError(spentNanos: bigint, ceilingNanos: bigint): SpendExceededError {
  return new SpendExceededError({
    userId: "tenant-a",
    day: "2026-09-21",
    spentNanos,
    reservedNanos: 0n,
    ceilingNanos,
    remainingNanos: 0n,
  });
}

describe("classifyFailure spend cap", () => {
  it("classifies SpendExceededError as terminal", () => {
    expect(classifyFailure(spendError(800n, 800n))).toBe("terminal");
  });

  it("is terminal even when the snapshot numbers look like HTTP 500/429", () => {
    const error = spendError(500n, 429n);
    expect(error.message).toMatch(/\b500\b/);
    expect(error.message).toMatch(/\b429\b/);
    expect(classifyFailure(error)).toBe("terminal");
    expect(classifyFailure(failed(error.message))).toBe("terminal");
  });

  it("is terminal when a capability result carries the budget message", () => {
    expect(classifyFailure(failed(spendError(800n, 800n).message))).toBe("terminal");
  });

  it("is terminal before rate-limit phrasing can mark the same error retryable", () => {
    const wrapped = new Error(`Rate limit exceeded; ${spendError(500n, 500n).message}`);
    expect(classifyFailure(wrapped)).toBe("terminal");
    expect(classifyFailure(failed(wrapped.message))).toBe("terminal");
  });

  it("is terminal when SpendExceededError is nested as a cause", () => {
    const outer = new Error("HTTP 429 Too Many Requests");
    (outer as Error & { cause: Error }).cause = spendError(500n, 500n);
    expect(classifyFailure(outer)).toBe("terminal");
  });
});
