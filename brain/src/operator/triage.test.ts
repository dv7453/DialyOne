import { describe, expect, it, vi } from "vitest";

import { applyRules, triageSignal } from "./triage.js";
import type { Playbook, Signal } from "./types.js";

const playbook: Playbook = {
  id: "deploy-sentinel",
  title: "Deploy sentinel",
  enabled: true,
  triggers: [],
  context: [],
  triage: {
    rules: [
      { when: "signal.payload.reason == 'oom'", class: "needs_human" },
      { when: "signal.payload.attempt < 2", class: "minor" },
    ],
    classes: ["minor", "needs_human", "ignore"],
    defaultClass: "ignore",
  },
  policy: {},
};

const signal: Signal = {
  id: "sig-1",
  source: "render",
  type: "webhook",
  createdAt: "2026-08-30T10:00:00.000Z",
  payload: { reason: "crashloop", attempt: 1 },
};

describe("applyRules", () => {
  it("evaluates equality and numeric comparisons against signal paths", () => {
    expect(applyRules(signal, playbook)).toMatchObject({
      class: "minor",
      via: "rule",
      confidence: 1,
    });

    expect(applyRules({ ...signal, payload: { reason: "oom", attempt: 4 } }, playbook)).toMatchObject({
      class: "needs_human",
      via: "rule",
    });
  });
});

describe("triageSignal", () => {
  it("uses the model classifier only when no rule matches", async () => {
    const modelClassify = vi.fn(async () => ({
      class: "needs_human",
      reason: "Model saw an unknown deploy failure.",
      via: "model" as const,
    }));

    await expect(triageSignal({ ...signal, payload: { reason: "unknown", attempt: 5 } }, playbook, { modelClassify })).resolves.toMatchObject({
      class: "needs_human",
      via: "model",
    });
    expect(modelClassify).toHaveBeenCalledTimes(1);
  });

  it("falls back to the configured default class", async () => {
    await expect(triageSignal({ ...signal, payload: { reason: "unknown", attempt: 5 } }, playbook)).resolves.toMatchObject({
      class: "ignore",
      via: "default",
    });
  });
});
