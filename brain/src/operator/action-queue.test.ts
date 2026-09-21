import { describe, expect, it } from "vitest";

import { InMemoryActionQueue } from "./action-queue.js";

const baseInput = {
  capability: "deploy.restart",
  args: { service: "web" },
  maxAttempts: 5,
  actionId: "act-1",
  playbookId: "deploy-sentinel",
  signalId: "sig-1",
};

describe("InMemoryActionQueue", () => {
  it("enqueues a failed action and lists it only once it is due", async () => {
    const now = new Date("2026-08-30T10:00:00.000Z");
    const queue = new InMemoryActionQueue({
      createId: () => "q-1",
      now: () => now,
    });

    const queued = await queue.enqueue({
      ...baseInput,
      attempts: 1,
      nextAttemptAt: "2026-08-30T10:00:05.000Z",
      lastError: "HTTP 503",
    });

    expect(queued).toMatchObject({
      id: "q-1",
      status: "pending",
      attempts: 1,
      capability: "deploy.restart",
      args: { service: "web" },
    });
    await expect(queue.listDue(now)).resolves.toEqual([]);
    await expect(queue.listDue(new Date("2026-08-30T10:00:05.000Z"))).resolves.toMatchObject([
      { id: "q-1", status: "pending" },
    ]);
  });

  it("returns due actions in nextAttemptAt order", async () => {
    const queue = new InMemoryActionQueue({
      createId: (() => {
        let n = 0;
        return () => `q-${++n}`;
      })(),
    });

    await queue.enqueue({
      ...baseInput,
      actionId: "later",
      nextAttemptAt: "2026-08-30T10:00:10.000Z",
    });
    await queue.enqueue({
      ...baseInput,
      actionId: "sooner",
      nextAttemptAt: "2026-08-30T10:00:01.000Z",
    });

    const due = await queue.listDue(new Date("2026-08-30T10:00:10.000Z"));
    expect(due.map((item) => item.actionId)).toEqual(["sooner", "later"]);
  });

  it("marks a record succeeded and drops it from the due list", async () => {
    const queue = new InMemoryActionQueue({ createId: () => "q-1" });
    await queue.enqueue({
      ...baseInput,
      nextAttemptAt: "2026-08-30T10:00:00.000Z",
    });

    await expect(queue.markSucceeded("q-1")).resolves.toMatchObject({ id: "q-1", status: "succeeded" });
    await expect(queue.listDue(new Date("2026-08-30T11:00:00.000Z"))).resolves.toEqual([]);
    await expect(queue.get("q-1")).resolves.toMatchObject({ status: "succeeded" });
  });

  it("marks a record dead with the last error", async () => {
    const queue = new InMemoryActionQueue({ createId: () => "q-1" });
    await queue.enqueue({
      ...baseInput,
      nextAttemptAt: "2026-08-30T10:00:00.000Z",
    });

    await expect(queue.markDead("q-1", "HTTP 401 Unauthorized")).resolves.toMatchObject({
      id: "q-1",
      status: "dead",
      lastError: "HTTP 401 Unauthorized",
    });
    await expect(queue.listDue(new Date("2026-08-30T11:00:00.000Z"))).resolves.toEqual([]);
  });

  it("reschedules a pending record and hides it until the new time", async () => {
    const queue = new InMemoryActionQueue({ createId: () => "q-1" });
    await queue.enqueue({
      ...baseInput,
      attempts: 1,
      nextAttemptAt: "2026-08-30T10:00:00.000Z",
      lastError: "HTTP 503",
    });

    const updated = await queue.reschedule("q-1", {
      attempts: 2,
      nextAttemptAt: "2026-08-30T10:00:04.000Z",
      lastError: "HTTP 502",
    });

    expect(updated).toMatchObject({
      attempts: 2,
      nextAttemptAt: "2026-08-30T10:00:04.000Z",
      lastError: "HTTP 502",
      status: "pending",
    });
    await expect(queue.listDue(new Date("2026-08-30T10:00:00.000Z"))).resolves.toEqual([]);
    await expect(queue.listDue(new Date("2026-08-30T10:00:04.000Z"))).resolves.toMatchObject([{ id: "q-1", attempts: 2 }]);
  });

  it("does not reschedule succeeded or dead records", async () => {
    const queue = new InMemoryActionQueue({
      createId: (() => {
        let n = 0;
        return () => `q-${++n}`;
      })(),
    });
    await queue.enqueue({
      ...baseInput,
      id: "q-1",
      nextAttemptAt: "2026-08-30T10:00:00.000Z",
    });
    await queue.enqueue({
      ...baseInput,
      id: "q-2",
      actionId: "act-2",
      nextAttemptAt: "2026-08-30T10:00:00.000Z",
    });
    await queue.markSucceeded("q-1");
    await queue.markDead("q-2");

    await expect(
      queue.reschedule("q-1", { attempts: 2, nextAttemptAt: "2026-08-30T10:01:00.000Z" }),
    ).resolves.toBeUndefined();
    await expect(
      queue.reschedule("q-2", { attempts: 2, nextAttemptAt: "2026-08-30T10:01:00.000Z" }),
    ).resolves.toBeUndefined();
  });

  it("returns undefined when updating a missing id", async () => {
    const queue = new InMemoryActionQueue();
    await expect(queue.get("missing")).resolves.toBeUndefined();
    await expect(queue.markSucceeded("missing")).resolves.toBeUndefined();
    await expect(queue.markDead("missing")).resolves.toBeUndefined();
    await expect(
      queue.reschedule("missing", { attempts: 2, nextAttemptAt: "2026-08-30T10:00:00.000Z" }),
    ).resolves.toBeUndefined();
  });

  it("clones records so callers cannot mutate the store", async () => {
    const queue = new InMemoryActionQueue({ createId: () => "q-1" });
    const queued = await queue.enqueue({
      ...baseInput,
      nextAttemptAt: "2026-08-30T10:00:00.000Z",
    });
    queued.args.service = "mutated";
    queued.status = "dead";

    await expect(queue.get("q-1")).resolves.toMatchObject({
      status: "pending",
      args: { service: "web" },
    });
  });

  it("can enqueue directly into the dead-letter state", async () => {
    const queue = new InMemoryActionQueue({ createId: () => "q-dead" });
    const queued = await queue.enqueue({
      ...baseInput,
      nextAttemptAt: "2026-08-30T10:00:00.000Z",
      status: "dead",
      lastError: "HTTP 400 Bad Request",
    });
    expect(queued.status).toBe("dead");
    await expect(queue.listDue(new Date("2026-08-30T11:00:00.000Z"))).resolves.toEqual([]);
  });
});
