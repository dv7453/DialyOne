import { describe, expect, it, vi } from "vitest";

import {
  OperatorScheduler,
  isCronDue,
  parseEvery,
  readProbeHealth,
  type SchedulerSignal,
} from "./scheduler.js";
import type { CapabilityResult } from "./capabilities/types.js";
import { PlaybookSchema, type Playbook } from "./types.js";

function playbook(overrides: Partial<Playbook> & { id: string }): Playbook {
  return PlaybookSchema.parse({
    title: overrides.id,
    triage: { classes: ["minor"], defaultClass: "minor" },
    policy: { minor: [] },
    ...overrides,
  });
}

const probePlaybook = playbook({
  id: "deploy-sentinel",
  triggers: [{ type: "probe", every: "60s", capability: "deploy.health" }],
});

const cronPlaybook = playbook({
  id: "morning-brief",
  triggers: [{ type: "cron", expression: "0 8 * * *" }],
});

function harness(result: () => CapabilityResult, playbooks: Playbook[] = [probePlaybook]) {
  const emitted: SchedulerSignal[] = [];
  let clock = new Date("2026-01-01T09:00:00.000Z");
  const scheduler = new OperatorScheduler({
    listPlaybooks: () => playbooks,
    emit: async (signal) => {
      emitted.push(signal);
    },
    runProbe: async () => result(),
    now: () => clock,
    timeZone: "UTC",
  });

  return {
    emitted,
    scheduler,
    advance(ms: number) {
      clock = new Date(clock.getTime() + ms);
    },
  };
}

const healthy: CapabilityResult = { ok: true, capability: "deploy.health", data: { service: { service: { suspended: "not_suspended" } } } };
const down: CapabilityResult = { ok: false, capability: "deploy.health", error: "Render service health request failed with status 500." };

describe("parseEvery", () => {
  it("parses supported units", () => {
    expect(parseEvery("60s")).toBe(60_000);
    expect(parseEvery("5m")).toBe(300_000);
    expect(parseEvery("1h")).toBe(3_600_000);
    expect(parseEvery("250ms")).toBe(250);
  });

  it("rejects malformed or zero intervals", () => {
    expect(parseEvery("soon")).toBeNull();
    expect(parseEvery("0s")).toBeNull();
    expect(parseEvery("10d")).toBeNull();
  });
});

describe("isCronDue", () => {
  const expression = "0 8 * * *";

  it("fires inside the grace window when it has not run for this occurrence", () => {
    const now = new Date("2026-01-01T08:00:30.000Z");
    expect(isCronDue(expression, now, undefined, "UTC")).toBe(true);
  });

  it("does not fire twice for the same occurrence", () => {
    const now = new Date("2026-01-01T08:00:30.000Z");
    const lastRun = new Date("2026-01-01T08:00:05.000Z").getTime();
    expect(isCronDue(expression, now, lastRun, "UTC")).toBe(false);
  });

  it("treats a long-past occurrence as missed rather than replaying it", () => {
    const now = new Date("2026-01-01T15:00:00.000Z");
    expect(isCronDue(expression, now, undefined, "UTC")).toBe(false);
  });

  it("resolves the expression in the configured zone, not the host zone", () => {
    // 08:00 in Kolkata is 02:30 UTC.
    const now = new Date("2026-01-01T02:30:20.000Z");
    expect(isCronDue(expression, now, undefined, "Asia/Kolkata")).toBe(true);
    expect(isCronDue(expression, now, undefined, "UTC")).toBe(false);
  });

  it("returns false for an unparseable expression", () => {
    expect(isCronDue("not a cron", new Date(), undefined, "UTC")).toBe(false);
  });
});

describe("readProbeHealth", () => {
  it("treats a failed capability call as unhealthy", () => {
    expect(readProbeHealth(down).healthy).toBe(false);
  });

  it("treats a suspended service as unhealthy", () => {
    const suspended: CapabilityResult = {
      ok: true,
      capability: "deploy.health",
      data: { service: { service: { suspended: "suspended" } } },
    };
    expect(readProbeHealth(suspended)).toEqual({ healthy: false, reason: "Service is suspended." });
  });

  it("treats a running service as healthy", () => {
    expect(readProbeHealth(healthy).healthy).toBe(true);
  });
});

describe("OperatorScheduler probes", () => {
  it("stays silent while the service is healthy", async () => {
    const h = harness(() => healthy);
    await h.scheduler.tick();
    h.advance(60_000);
    await h.scheduler.tick();

    expect(h.emitted).toEqual([]);
  });

  it("emits one signal on the transition into unhealthy, not once per tick", async () => {
    let current = healthy;
    const h = harness(() => current);

    await h.scheduler.tick();
    current = down;
    h.advance(60_000);
    await h.scheduler.tick();
    h.advance(60_000);
    await h.scheduler.tick();
    h.advance(60_000);
    await h.scheduler.tick();

    expect(h.emitted).toHaveLength(1);
    expect(h.emitted[0]).toMatchObject({
      source: "scheduler",
      type: "probe.tick",
      payload: { playbookId: "deploy-sentinel", capability: "deploy.health", healthy: false },
    });
  });

  it("re-arms after a recovery so the next outage is reported", async () => {
    let current = down;
    const h = harness(() => current);

    await h.scheduler.tick();
    current = healthy;
    h.advance(60_000);
    await h.scheduler.tick();
    current = down;
    h.advance(60_000);
    await h.scheduler.tick();

    expect(h.emitted).toHaveLength(2);
  });

  it("respects the configured interval", async () => {
    const run = vi.fn(async () => healthy);
    let clock = new Date("2026-01-01T09:00:00.000Z");
    const scheduler = new OperatorScheduler({
      listPlaybooks: () => [probePlaybook],
      emit: async () => undefined,
      runProbe: run,
      now: () => clock,
      timeZone: "UTC",
    });

    await scheduler.tick();
    clock = new Date(clock.getTime() + 15_000);
    await scheduler.tick();
    expect(run).toHaveBeenCalledTimes(1);

    clock = new Date(clock.getTime() + 45_000);
    await scheduler.tick();
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("stays silent when the probe adapter is unconfigured", async () => {
    const h = harness(() => ({ ok: false, capability: "deploy.health", unavailable: true, error: "no credentials" }));
    await h.scheduler.tick();

    expect(h.emitted).toEqual([]);
  });

  it("skips disabled playbooks", async () => {
    const disabled = playbook({
      id: "deploy-sentinel",
      enabled: false,
      triggers: [{ type: "probe", every: "60s", capability: "deploy.health" }],
    });
    const h = harness(() => down, [disabled]);
    await h.scheduler.tick();

    expect(h.emitted).toEqual([]);
  });
});

describe("OperatorScheduler cron", () => {
  it("emits a cron tick naming the playbook and expression", async () => {
    const emitted: SchedulerSignal[] = [];
    const scheduler = new OperatorScheduler({
      listPlaybooks: () => [cronPlaybook],
      emit: async (signal) => {
        emitted.push(signal);
      },
      runProbe: async () => healthy,
      now: () => new Date("2026-01-01T08:00:30.000Z"),
      timeZone: "UTC",
    });

    await scheduler.tick();
    await scheduler.tick();

    expect(emitted).toHaveLength(1);
    expect(emitted[0]).toMatchObject({
      source: "scheduler",
      type: "cron.tick",
      payload: { playbookId: "morning-brief", expression: "0 8 * * *" },
    });
  });
});
