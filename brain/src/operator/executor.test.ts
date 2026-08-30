import { describe, expect, it } from "vitest";

import { InMemoryApprovalsStore } from "./approvals.js";
import { MockCapabilityAdapter } from "./capabilities/mock.js";
import { CapabilityRegistry } from "./capabilities/registry.js";
import { executeEngineResult } from "./executor.js";
import { InMemoryJournal } from "./journal.js";
import type { EngineResult } from "./engine.js";

const engineResult: EngineResult = {
  signalId: "sig-1",
  matches: [
    {
      playbookId: "deploy-sentinel",
      triage: { class: "minor", reason: "retryable", via: "rule" },
      decision: { class: "minor", actions: [], reason: "matched" },
      actions: [
        {
          id: "act-auto",
          playbookId: "deploy-sentinel",
          capability: "deploy.restart",
          mode: "auto",
          args: { service: "web" },
          signalId: "sig-1",
          status: "pending",
        },
        {
          id: "act-approve",
          playbookId: "deploy-sentinel",
          capability: "code.draft_pr",
          mode: "approve",
          args: { title: "Fix deploy" },
          signalId: "sig-1",
          status: "pending",
        },
        {
          id: "act-log",
          playbookId: "deploy-sentinel",
          capability: "journal.log",
          mode: "log",
          signalId: "sig-1",
          status: "skipped",
        },
        {
          id: "act-escalate",
          playbookId: "deploy-sentinel",
          capability: "deploy.logs",
          mode: "escalate",
          args: { reason: "needs human" },
          signalId: "sig-1",
          status: "pending",
        },
      ],
    },
  ],
};

describe("executeEngineResult", () => {
  it("executes auto actions, queues approvals, logs skips, and escalates through notify", async () => {
    const mock = new MockCapabilityAdapter();
    const registry = new CapabilityRegistry().register(mock);
    const approvals = new InMemoryApprovalsStore({
      createId: () => "approval-1",
      now: () => "2026-08-30T10:00:00.000Z",
    });
    const journal = new InMemoryJournal();

    const summary = await executeEngineResult(engineResult, registry, approvals, journal);

    expect(summary.actions).toMatchObject([
      { actionId: "act-auto", capability: "deploy.restart", status: "executed" },
      { actionId: "act-approve", capability: "code.draft_pr", status: "pending_approval" },
      { actionId: "act-log", capability: "journal.log", status: "skipped" },
      { actionId: "act-escalate", capability: "deploy.logs", status: "executed" },
    ]);
    await expect(approvals.listPending()).resolves.toMatchObject([
      {
        id: "approval-1",
        actionId: "act-approve",
        capability: "code.draft_pr",
        status: "pending",
      },
    ]);
    expect(mock.getCalls().map((call) => call.capability)).toEqual(["deploy.restart", "notify.escalate"]);
    expect(journal.readAll().map((entry) => entry.kind)).toEqual(["outcome", "outcome", "outcome", "escalate", "outcome"]);
  });
});
