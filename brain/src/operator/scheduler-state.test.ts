import { describe, expect, it } from "vitest";

import { InMemorySchedulerStateStore, NoopTickLock } from "./scheduler-state.js";

describe("InMemorySchedulerStateStore", () => {
  it("returns undefined for keys that have never been written", async () => {
    const store = new InMemorySchedulerStateStore();

    expect(await store.getLastCronRun("morning-brief:0 8 * * *")).toBeUndefined();
    expect(await store.getLastProbeRun("deploy-sentinel:deploy.health")).toBeUndefined();
    expect(await store.getProbeUnhealthy("deploy-sentinel:deploy.health")).toBeUndefined();
  });

  it("round-trips last-run timestamps and probe-health flags", async () => {
    const store = new InMemorySchedulerStateStore();

    await store.setLastCronRun("morning-brief:0 8 * * *", 1_000);
    await store.setLastProbeRun("deploy-sentinel:deploy.health", 2_000);
    await store.setProbeUnhealthy("deploy-sentinel:deploy.health", true);

    expect(await store.getLastCronRun("morning-brief:0 8 * * *")).toBe(1_000);
    expect(await store.getLastProbeRun("deploy-sentinel:deploy.health")).toBe(2_000);
    expect(await store.getProbeUnhealthy("deploy-sentinel:deploy.health")).toBe(true);

    await store.setProbeUnhealthy("deploy-sentinel:deploy.health", false);
    expect(await store.getProbeUnhealthy("deploy-sentinel:deploy.health")).toBe(false);
  });

  it("keeps cron last-run, probe last-run, and probe-health in separate namespaces", async () => {
    const store = new InMemorySchedulerStateStore();
    const key = "same-playbook:same-slot";

    await store.setLastCronRun(key, 1);
    await store.setLastProbeRun(key, 2);
    await store.setProbeUnhealthy(key, true);

    expect(await store.getLastCronRun(key)).toBe(1);
    expect(await store.getLastProbeRun(key)).toBe(2);
    expect(await store.getProbeUnhealthy(key)).toBe(true);
  });
});

describe("NoopTickLock", () => {
  it("always acquires and release is a no-op", async () => {
    const lock = new NoopTickLock();

    expect(await lock.tryAcquire()).toBe(true);
    expect(await lock.tryAcquire()).toBe(true);
    await expect(lock.release()).resolves.toBeUndefined();
  });
});
