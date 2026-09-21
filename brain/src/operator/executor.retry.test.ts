import { describe, expect, it } from "vitest";

import { InMemoryActionQueue } from "./action-queue.js";
import { InMemoryApprovalsStore } from "./approvals.js";
import type { CapabilityAdapter, CapabilityContext, CapabilityResult } from "./capabilities/types.js";
import { MockCapabilityAdapter } from "./capabilities/mock.js";
import { CapabilityRegistry } from "./capabilities/registry.js";
import { drainActionQueue, executeEngineResult } from "./executor.js";
import { InMemoryJournal } from "./journal.js";
import type { EngineResult } from "./engine.js";
import type { ActionRequest } from "./types.js";

const autoAction: ActionRequest = {
  id: "act-auto",
  playbookId: "deploy-sentinel",
  capability: "deploy.restart",
  mode: "auto",
  args: { service: "web" },
  signalId: "sig-1",
  status: "pending",
};

function engineFor(actions: ActionRequest[]): EngineResult {
  return {
    signalId: "sig-1",
    matches: [
      {
        playbookId: "deploy-sentinel",
        triage: { class: "minor", reason: "retryable", via: "rule" },
        decision: { class: "minor", actions: [], reason: "matched" },
        actions,
      },
    ],
  };
}

function registryWith(adapter: CapabilityAdapter): CapabilityRegistry {
  return new CapabilityRegistry().register(adapter);
}

class ScriptedAdapter implements CapabilityAdapter {
  readonly id = "scripted";
  readonly capabilities = ["deploy.restart", "notify.escalate"];
  private index = 0;

  constructor(private readonly script: Array<CapabilityResult | Error>) {}

  async isAvailable(): Promise<boolean> {
    return true;
  }

  async execute(capability: string, _args: Record<string, unknown>, _ctx: CapabilityContext): Promise<CapabilityResult> {
    const next = this.script[Math.min(this.index, this.script.length - 1)];
    this.index += 1;
    if (next instanceof Error) {
      throw next;
    }
    return { ...next, capability };
  }
}

describe("executeEngineResult retry handling", () => {
  it("keeps a retryable failure terminal when no queue is supplied", async () => {
    const mock = new MockCapabilityAdapter({
      "deploy.restart": { ok: false, capability: "deploy.restart", error: "HTTP 503 Service Unavailable" },
    });
    const journal = new InMemoryJournal();

    const summary = await executeEngineResult(
      engineFor([autoAction]),
      registryWith(mock),
      new InMemoryApprovalsStore(),
      journal,
    );

    expect(summary.actions).toMatchObject([{ actionId: "act-auto", status: "failed" }]);
    expect(journal.readAll().map((entry) => entry.kind)).toEqual(["outcome"]);
    expect(journal.readAll()[0]?.data.status).toBe("failed");
  });

  it("schedules a retryable failure onto the queue and journals it distinctly", async () => {
    const mock = new MockCapabilityAdapter({
      "deploy.restart": { ok: false, capability: "deploy.restart", error: "HTTP 503 Service Unavailable" },
    });
    const queue = new InMemoryActionQueue({ createId: () => "q-1" });
    const journal = new InMemoryJournal();
    const now = () => new Date("2026-08-30T10:00:00.000Z");

    const summary = await executeEngineResult(
      engineFor([autoAction]),
      registryWith(mock),
      new InMemoryApprovalsStore(),
      journal,
      { queue, maxAttempts: 5, now },
    );

    expect(summary.actions).toMatchObject([{ actionId: "act-auto", status: "retry_scheduled" }]);
    const queued = await queue.get("q-1");
    expect(queued).toMatchObject({
      status: "pending",
      attempts: 1,
      maxAttempts: 5,
      capability: "deploy.restart",
      args: { service: "web" },
      lastError: "HTTP 503 Service Unavailable",
    });
    expect(queued && Date.parse(queued.nextAttemptAt)).toBeGreaterThan(now().getTime());
    expect(journal.readAll().map((entry) => entry.kind)).toEqual(["retry_scheduled", "outcome"]);
    expect(journal.readAll()[0]?.data).toMatchObject({
      attempt: 1,
      nextAttemptAt: queued?.nextAttemptAt,
      queuedActionId: "q-1",
    });
    expect(journal.readAll().some((entry) => entry.data.status === "failed")).toBe(false);
  });

  it("dead-letters a terminal failure and includes a human-readable explanation", async () => {
    const mock = new MockCapabilityAdapter({
      "deploy.restart": { ok: false, capability: "deploy.restart", error: "HTTP 401 Unauthorized" },
    });
    const queue = new InMemoryActionQueue({ createId: () => "q-1" });
    const journal = new InMemoryJournal();

    const summary = await executeEngineResult(
      engineFor([autoAction]),
      registryWith(mock),
      new InMemoryApprovalsStore(),
      journal,
      { queue, now: () => new Date("2026-08-30T10:00:00.000Z") },
    );

    expect(summary.actions).toMatchObject([{ actionId: "act-auto", status: "failed" }]);
    await expect(queue.get("q-1")).resolves.toMatchObject({ status: "dead", lastError: "HTTP 401 Unauthorized" });
    const dead = journal.readAll().find((entry) => entry.kind === "dead_letter");
    expect(dead?.data.explanation).toEqual(expect.stringContaining("not transient"));
    expect(dead?.data.explanation).toEqual(expect.stringContaining("HTTP 401 Unauthorized"));
    expect(dead?.data.explanation).toEqual(expect.stringContaining("did not run"));
  });

  it("dead-letters immediately when maxAttempts is 1 even if the error is retryable", async () => {
    const mock = new MockCapabilityAdapter({
      "deploy.restart": { ok: false, capability: "deploy.restart", error: "socket hang up" },
    });
    const queue = new InMemoryActionQueue({ createId: () => "q-1" });
    const journal = new InMemoryJournal();

    const summary = await executeEngineResult(
      engineFor([autoAction]),
      registryWith(mock),
      new InMemoryApprovalsStore(),
      journal,
      { queue, maxAttempts: 1 },
    );

    expect(summary.actions[0]?.status).toBe("failed");
    await expect(queue.get("q-1")).resolves.toMatchObject({ status: "dead" });
    expect(journal.readAll().some((entry) => entry.kind === "dead_letter")).toBe(true);
    expect(journal.readAll().find((entry) => entry.kind === "dead_letter")?.data.explanation).toEqual(
      expect.stringContaining("after 1 attempt"),
    );
  });

  it("treats a thrown network error as retryable when a queue is present", async () => {
    const thrown = new Error("socket hang up") as NodeJS.ErrnoException;
    thrown.code = "ECONNRESET";
    const queue = new InMemoryActionQueue({ createId: () => "q-1" });
    const journal = new InMemoryJournal();

    const summary = await executeEngineResult(
      engineFor([autoAction]),
      registryWith(new ScriptedAdapter([thrown])),
      new InMemoryApprovalsStore(),
      journal,
      { queue, maxAttempts: 3 },
    );

    expect(summary.actions[0]?.status).toBe("retry_scheduled");
    await expect(queue.get("q-1")).resolves.toMatchObject({ status: "pending", attempts: 1 });
  });
});

describe("drainActionQueue", () => {
  it("re-executes due actions and marks them succeeded", async () => {
    const queue = new InMemoryActionQueue({ createId: () => "q-1" });
    await queue.enqueue({
      capability: "deploy.restart",
      args: { service: "web" },
      attempts: 1,
      maxAttempts: 5,
      nextAttemptAt: "2026-08-30T10:00:00.000Z",
      lastError: "HTTP 503",
      actionId: "act-auto",
      playbookId: "deploy-sentinel",
      signalId: "sig-1",
    });
    const journal = new InMemoryJournal();

    const summary = await drainActionQueue(
      queue,
      registryWith(new MockCapabilityAdapter()),
      journal,
      { now: () => new Date("2026-08-30T10:00:00.000Z") },
    );

    expect(summary).toEqual({ processed: 1, succeeded: 1, rescheduled: 0, dead: 0 });
    await expect(queue.get("q-1")).resolves.toMatchObject({ status: "succeeded" });
    expect(journal.readAll().map((entry) => entry.kind)).toEqual(["outcome"]);
    expect(journal.readAll()[0]?.data).toMatchObject({ status: "executed", via: "retry" });
  });

  it("reschedules a still-retryable failure and increments attempts", async () => {
    const queue = new InMemoryActionQueue({ createId: () => "q-1" });
    await queue.enqueue({
      capability: "deploy.restart",
      args: { service: "web" },
      attempts: 1,
      maxAttempts: 5,
      nextAttemptAt: "2026-08-30T10:00:00.000Z",
      lastError: "HTTP 503",
      actionId: "act-auto",
      playbookId: "deploy-sentinel",
      signalId: "sig-1",
    });
    const mock = new MockCapabilityAdapter({
      "deploy.restart": { ok: false, capability: "deploy.restart", error: "HTTP 502 Bad Gateway" },
    });
    const journal = new InMemoryJournal();
    const now = () => new Date("2026-08-30T10:00:00.000Z");

    const summary = await drainActionQueue(queue, registryWith(mock), journal, { now });

    expect(summary).toEqual({ processed: 1, succeeded: 0, rescheduled: 1, dead: 0 });
    const queued = await queue.get("q-1");
    expect(queued).toMatchObject({ status: "pending", attempts: 2, lastError: "HTTP 502 Bad Gateway" });
    expect(queued && Date.parse(queued.nextAttemptAt)).toBeGreaterThan(now().getTime());
    expect(journal.readAll()[0]).toMatchObject({
      kind: "retry_scheduled",
      data: { attempt: 2, queuedActionId: "q-1" },
    });
  });

  it("dead-letters when attempts are exhausted", async () => {
    const queue = new InMemoryActionQueue({ createId: () => "q-1" });
    await queue.enqueue({
      capability: "deploy.restart",
      args: { service: "web" },
      attempts: 2,
      maxAttempts: 3,
      nextAttemptAt: "2026-08-30T10:00:00.000Z",
      lastError: "HTTP 503",
      actionId: "act-auto",
      playbookId: "deploy-sentinel",
      signalId: "sig-1",
    });
    const mock = new MockCapabilityAdapter({
      "deploy.restart": { ok: false, capability: "deploy.restart", error: "ETIMEDOUT" },
    });
    const journal = new InMemoryJournal();

    const summary = await drainActionQueue(queue, registryWith(mock), journal, {
      now: () => new Date("2026-08-30T10:00:00.000Z"),
    });

    expect(summary).toEqual({ processed: 1, succeeded: 0, rescheduled: 0, dead: 1 });
    await expect(queue.get("q-1")).resolves.toMatchObject({ status: "dead", lastError: "ETIMEDOUT" });
    const dead = journal.readAll().find((entry) => entry.kind === "dead_letter");
    expect(dead?.data.explanation).toEqual(expect.stringContaining("after 3 attempt"));
    expect(dead?.data.explanation).toEqual(expect.stringContaining("did not run"));
  });

  it("dead-letters a terminal failure discovered on drain even if attempts remain", async () => {
    const queue = new InMemoryActionQueue({ createId: () => "q-1" });
    await queue.enqueue({
      capability: "deploy.restart",
      args: { service: "web" },
      attempts: 1,
      maxAttempts: 5,
      nextAttemptAt: "2026-08-30T10:00:00.000Z",
      lastError: "HTTP 503",
      actionId: "act-auto",
      playbookId: "deploy-sentinel",
      signalId: "sig-1",
    });
    const mock = new MockCapabilityAdapter({
      "deploy.restart": { ok: false, capability: "deploy.restart", error: "HTTP 404 Not Found" },
    });
    const journal = new InMemoryJournal();

    const summary = await drainActionQueue(queue, registryWith(mock), journal);

    expect(summary.dead).toBe(1);
    await expect(queue.get("q-1")).resolves.toMatchObject({ status: "dead" });
    expect(journal.readAll()[0]?.data.explanation).toEqual(expect.stringContaining("not transient"));
  });

  it("skips actions that are not yet due", async () => {
    const queue = new InMemoryActionQueue({ createId: () => "q-1" });
    await queue.enqueue({
      capability: "deploy.restart",
      args: { service: "web" },
      attempts: 1,
      maxAttempts: 5,
      nextAttemptAt: "2026-08-30T10:05:00.000Z",
      actionId: "act-auto",
      playbookId: "deploy-sentinel",
      signalId: "sig-1",
    });
    const mock = new MockCapabilityAdapter();

    const summary = await drainActionQueue(queue, registryWith(mock), new InMemoryJournal(), {
      now: () => new Date("2026-08-30T10:00:00.000Z"),
    });

    expect(summary.processed).toBe(0);
    expect(mock.getCalls()).toEqual([]);
  });
});
