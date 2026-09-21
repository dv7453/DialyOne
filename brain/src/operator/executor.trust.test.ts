import { describe, expect, it } from "vitest";

import { InMemoryApprovalsStore } from "./approvals.js";
import type { CapabilityAdapter, CapabilityContext, CapabilityResult } from "./capabilities/types.js";
import { MockCapabilityAdapter } from "./capabilities/mock.js";
import { CapabilityRegistry } from "./capabilities/registry.js";
import { executeEngineResult } from "./executor.js";
import { InMemoryJournal } from "./journal.js";
import type { EngineResult } from "./engine.js";
import {
  InMemoryTrustLedger,
  consentToGrantAutonomy,
  type TrustKey,
  type TrustRecord,
} from "./trust.js";
import type { ActionRequest } from "./types.js";

const userId = "user-1";
const now = () => new Date("2026-09-21T05:00:00.000Z");

function action(overrides: Partial<ActionRequest> & Pick<ActionRequest, "id" | "capability" | "mode">): ActionRequest {
  return {
    playbookId: "inbox-draft",
    signalId: "sig-1",
    status: "pending",
    args: { title: "reminder" },
    ...overrides,
  };
}

function engineFor(actions: ActionRequest[]): EngineResult {
  return {
    signalId: "sig-1",
    matches: [
      {
        playbookId: "inbox-draft",
        triage: { class: "minor", reason: "matched", via: "rule" },
        decision: { class: "minor", actions: [], reason: "matched" },
        actions,
      },
    ],
  };
}

function registryWith(adapter = new MockCapabilityAdapter()): { registry: CapabilityRegistry; mock: MockCapabilityAdapter } {
  return { registry: new CapabilityRegistry().register(adapter), mock: adapter };
}

class TrackingAdapter implements CapabilityAdapter {
  readonly id = "tracking";
  readonly calls: string[] = [];

  constructor(readonly capabilities: string[]) {}

  async isAvailable(): Promise<boolean> {
    return true;
  }

  async execute(capability: string, _args: Record<string, unknown>, _ctx: CapabilityContext): Promise<CapabilityResult> {
    this.calls.push(capability);
    return { ok: true, capability };
  }
}

const draftKey: TrustKey = {
  userId,
  playbookId: "inbox-draft",
  capability: "mail.draft",
};

describe("executeEngineResult trust ramp", () => {
  it("leaves existing behaviour unchanged when no ledger is injected", async () => {
    const { registry, mock } = registryWith();
    const approvals = new InMemoryApprovalsStore({
      createId: () => "approval-1",
      now: () => "2026-09-21T05:00:00.000Z",
    });
    const journal = new InMemoryJournal();
    const actions = [
      action({ id: "act-auto", capability: "deploy.restart", mode: "auto", playbookId: "deploy-sentinel" }),
      action({ id: "act-approve", capability: "code.draft_pr", mode: "approve", playbookId: "deploy-sentinel" }),
      action({ id: "act-log", capability: "journal.log", mode: "log", playbookId: "deploy-sentinel", status: "skipped" }),
      action({ id: "act-escalate", capability: "deploy.logs", mode: "escalate", playbookId: "deploy-sentinel" }),
    ];

    const summary = await executeEngineResult(engineFor(actions), registry, approvals, journal);

    expect(summary.actions).toMatchObject([
      { actionId: "act-auto", status: "executed" },
      { actionId: "act-approve", status: "pending_approval" },
      { actionId: "act-log", status: "skipped" },
      { actionId: "act-escalate", status: "executed" },
    ]);
    expect(mock.getCalls().map((call) => call.capability)).toEqual(["deploy.restart", "notify.escalate"]);
    expect(journal.readAll().map((entry) => entry.kind)).toEqual(["outcome", "outcome", "outcome", "escalate", "outcome"]);
    expect(journal.readAll().some((entry) => String(entry.kind).startsWith("autonomy") || entry.kind === "streak_reset")).toBe(false);
  });

  it("increments streak on successful execute and resets it on terminal failure", async () => {
    const ledger = new InMemoryTrustLedger({ now, createId: () => "row-1" });
    const { registry } = registryWith(
      new MockCapabilityAdapter({
        "mail.draft": { ok: true, capability: "mail.draft" },
      }),
    );

    await executeEngineResult(
      engineFor([action({ id: "act-1", capability: "mail.draft", mode: "auto" })]),
      registry,
      new InMemoryApprovalsStore(),
      new InMemoryJournal(),
      { trust: ledger, userId, now },
    );
    await expect(ledger.get(draftKey)).resolves.toMatchObject({ streak: 1, autonomyGranted: false });

    const failing = new CapabilityRegistry().register(
      new MockCapabilityAdapter({
        "mail.draft": { ok: false, capability: "mail.draft", error: "SMTP 550" },
      }),
    );
    const journal = new InMemoryJournal();
    await executeEngineResult(
      engineFor([action({ id: "act-2", capability: "mail.draft", mode: "auto" })]),
      failing,
      new InMemoryApprovalsStore(),
      journal,
      { trust: ledger, userId, now },
    );

    await expect(ledger.get(draftKey)).resolves.toMatchObject({ streak: 0, autonomyGranted: false });
    expect(journal.readAll().some((entry) => entry.kind === "streak_reset")).toBe(true);
    expect(journal.readAll().find((entry) => entry.kind === "streak_reset")?.data.summary).toEqual(
      expect.stringContaining("stopped counting"),
    );
  });

  it("journals promotion as available at the reversible threshold without granting it", async () => {
    const ledger = new InMemoryTrustLedger({ now, createId: () => "row-1" });
    const { registry } = registryWith();
    const journal = new InMemoryJournal();

    for (let i = 0; i < 10; i += 1) {
      await executeEngineResult(
        engineFor([action({ id: `act-${i}`, capability: "mail.draft", mode: "auto" })]),
        registry,
        new InMemoryApprovalsStore(),
        journal,
        { trust: ledger, userId, now },
      );
    }

    const record = (await ledger.get(draftKey)) as TrustRecord;
    expect(record.streak).toBe(10);
    expect(record.autonomyGranted).toBe(false);
    const offers = journal.readAll().filter((entry) => entry.kind === "promotion_available");
    expect(offers).toHaveLength(1);
    expect(offers[0]?.data.summary).toEqual(expect.stringContaining("if you agree"));
  });

  it("skips approval and executes a granted reversible capability", async () => {
    const ledger = new InMemoryTrustLedger({ now, createId: () => "row-1" });
    await ledger.grantAutonomy(draftKey, consentToGrantAutonomy());
    await ledger.recordApproval(draftKey);
    const { registry, mock } = registryWith();
    const approvals = new InMemoryApprovalsStore({ createId: () => "approval-1" });
    const journal = new InMemoryJournal();

    const summary = await executeEngineResult(
      engineFor([action({ id: "act-1", capability: "mail.draft", mode: "approve" })]),
      registry,
      approvals,
      journal,
      { trust: ledger, userId, now },
    );

    expect(summary.actions).toMatchObject([{ actionId: "act-1", status: "executed" }]);
    await expect(approvals.listPending()).resolves.toEqual([]);
    expect(mock.getCalls().map((call) => call.capability)).toEqual(["mail.draft"]);
    expect(journal.readAll().map((entry) => entry.kind)).toEqual(["autonomy_used", "outcome"]);
    expect(journal.readAll()[0]?.data.summary).toEqual(expect.stringContaining("on its own"));
    await expect(ledger.get(draftKey)).resolves.toMatchObject({ streak: 2, autonomyGranted: true });
  });

  it("still requires approval for a granted irreversible capability even if the row is corrupt", async () => {
    const ledger = new InMemoryTrustLedger({
      now,
      seed: [
        {
          id: "corrupt-1",
          userId,
          playbookId: "inbox-draft",
          capability: "payment.send",
          severity: "irreversible",
          streak: 99,
          autonomyGranted: true,
          updatedAt: now().toISOString(),
        },
      ],
    });
    const adapter = new TrackingAdapter(["payment.send"]);
    const approvals = new InMemoryApprovalsStore({ createId: () => "approval-pay" });
    const journal = new InMemoryJournal();

    const summary = await executeEngineResult(
      engineFor([action({ id: "act-pay", capability: "payment.send", mode: "approve" })]),
      new CapabilityRegistry().register(adapter),
      approvals,
      journal,
      { trust: ledger, userId, now },
    );

    expect(summary.actions).toMatchObject([{ actionId: "act-pay", status: "pending_approval" }]);
    await expect(approvals.listPending()).resolves.toMatchObject([{ id: "approval-pay", capability: "payment.send" }]);
    expect(adapter.calls).toEqual([]);
    expect(journal.readAll().some((entry) => entry.kind === "autonomy_used")).toBe(false);
  });

  it("classifies an unknown capability as irreversible and never promotes or auto-executes it", async () => {
    const ledger = new InMemoryTrustLedger({
      now,
      seed: [
        {
          id: "unknown-1",
          userId,
          playbookId: "inbox-draft",
          capability: "mystery.wipe",
          severity: "irreversible",
          streak: 40,
          autonomyGranted: true,
          updatedAt: now().toISOString(),
        },
      ],
    });
    const approvals = new InMemoryApprovalsStore({ createId: () => "approval-unknown" });
    const adapter = new TrackingAdapter(["mystery.wipe"]);

    const summary = await executeEngineResult(
      engineFor([action({ id: "act-unknown", capability: "mystery.wipe", mode: "approve" })]),
      new CapabilityRegistry().register(adapter),
      approvals,
      new InMemoryJournal(),
      { trust: ledger, userId, now },
    );

    expect(summary.actions[0]?.status).toBe("pending_approval");
    expect(adapter.calls).toEqual([]);
  });
});
