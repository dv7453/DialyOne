import { describe, expect, it } from "vitest";

import { processSignal } from "./engine.js";
import { InMemoryJournal } from "./journal.js";
import type { Playbook, Signal } from "./types.js";

const playbook: Playbook = {
  id: "deploy-sentinel",
  title: "Deploy sentinel",
  enabled: true,
  triggers: [
    {
      type: "webhook",
      source: "render",
      match: { event: ["deploy.failed", "service.unhealthy"] },
    },
  ],
  context: [{ capability: "deploy.logs", args: { lines: 200 } }],
  triage: {
    rules: [
      { when: "signal.payload.reason == 'oom'", class: "needs_human" },
      { when: "signal.payload.attempt < 2", class: "minor" },
    ],
    model: "triage",
    classes: ["minor", "needs_human", "ignore"],
  },
  policy: {
    minor: [
      { capability: "deploy.restart", mode: "approve" },
      { capability: "code.draft_pr", mode: "approve" },
    ],
    needs_human: [{ capability: "notify.escalate", mode: "auto" }],
    ignore: [{ capability: "journal.log", mode: "auto" }],
  },
  digest: { stack: ["minor"], deliver: "0 8 * * *" },
  budget: { max_model_calls: 3, max_tool_rounds: 6, on_exceed: "escalate" },
};

const signal: Signal = {
  id: "sig-1",
  source: "render",
  type: "webhook",
  createdAt: "2026-08-30T10:00:00.000Z",
  payload: { event: "deploy.failed", reason: "crashloop", attempt: 1 },
};

describe("processSignal", () => {
  it("matches, triages, decides, and returns planned action requests without executing APIs", async () => {
    const journal = new InMemoryJournal();
    let nextAction = 1;

    const result = await processSignal(signal, [playbook], {
      journal,
      createActionId: () => `act-${nextAction++}`,
    });

    expect(result).toEqual({
      signalId: "sig-1",
      matches: [
        {
          playbookId: "deploy-sentinel",
          triage: {
            class: "minor",
            reason: "Matched rule: signal.payload.attempt < 2",
            confidence: 1,
            via: "rule",
          },
          decision: {
            class: "minor",
            actions: playbook.policy.minor,
            reason: "Policy matched triage class minor.",
          },
          actions: [
            {
              id: "act-1",
              playbookId: "deploy-sentinel",
              capability: "deploy.restart",
              mode: "approve",
              args: undefined,
              signalId: "sig-1",
              status: "pending",
            },
            {
              id: "act-2",
              playbookId: "deploy-sentinel",
              capability: "code.draft_pr",
              mode: "approve",
              args: undefined,
              signalId: "sig-1",
              status: "pending",
            },
          ],
        },
      ],
    });
    expect(journal.readAll().map((entry) => entry.kind)).toEqual(["signal", "decision", "action", "action"]);
  });
});
