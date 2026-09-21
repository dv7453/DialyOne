import { CronExpressionParser } from "cron-parser";

import type { CapabilityResult } from "./capabilities/types.js";
import type { Playbook } from "./types.js";

export const SCHEDULER_SOURCE = "scheduler";
export const CRON_SIGNAL_TYPE = "cron.tick";
export const PROBE_SIGNAL_TYPE = "probe.tick";

/** A cron occurrence older than this is treated as missed rather than replayed. */
const CRON_GRACE_MS = 2 * 60 * 1000;

const EVERY_UNITS: Record<string, number> = {
  ms: 1,
  s: 1000,
  m: 60 * 1000,
  h: 60 * 60 * 1000,
};

/** Parses a probe `every` spec such as `60s`, `5m` or `1h`. */
export function parseEvery(spec: string): number | null {
  const match = /^(\d+)\s*(ms|s|m|h)$/.exec(spec.trim().toLowerCase());
  if (!match) {
    return null;
  }

  const value = Number(match[1]);
  if (!Number.isFinite(value) || value <= 0) {
    return null;
  }

  return value * EVERY_UNITS[match[2]];
}

/**
 * Cron expressions in playbooks mean wall-clock time for the person being
 * served, not for the server. Hosts run in UTC, so an explicit zone keeps
 * "0 8 * * *" at 8am where the user lives.
 */
export function operatorTimeZone(): string | undefined {
  return process.env.DIALY_TZ || process.env.TZ || undefined;
}

export function isCronDue(expression: string, now: Date, lastRunAt: number | undefined, tz?: string): boolean {
  let previous: Date;
  try {
    previous = CronExpressionParser.parse(expression, { currentDate: now, ...(tz ? { tz } : {}) })
      .prev()
      .toDate();
  } catch {
    return false;
  }

  if (lastRunAt !== undefined && lastRunAt >= previous.getTime()) {
    return false;
  }

  return now.getTime() <= previous.getTime() + CRON_GRACE_MS;
}

function findSuspended(value: unknown, depth = 0): string | undefined {
  if (depth > 4 || !value || typeof value !== "object") {
    return undefined;
  }

  const record = value as Record<string, unknown>;
  if (typeof record.suspended === "string") {
    return record.suspended;
  }

  for (const nested of Object.values(record)) {
    const found = findSuspended(nested, depth + 1);
    if (found) {
      return found;
    }
  }

  return undefined;
}

/**
 * A probe only raises a signal when it finds trouble. A failed capability call
 * counts, and so does a Render service reporting itself suspended.
 */
export function readProbeHealth(result: CapabilityResult): { healthy: boolean; reason: string } {
  if (!result.ok) {
    return { healthy: false, reason: result.error ?? `${result.capability} probe failed.` };
  }

  const suspended = findSuspended(result.data);
  if (suspended && suspended !== "not_suspended") {
    return { healthy: false, reason: `Service is ${suspended}.` };
  }

  return { healthy: true, reason: `${result.capability} probe is healthy.` };
}

export type SchedulerSignal = {
  id: string;
  source: string;
  type: string;
  createdAt: string;
  payload: Record<string, unknown>;
};

export type OperatorSchedulerDeps = {
  listPlaybooks: () => Playbook[];
  emit: (signal: SchedulerSignal) => Promise<unknown>;
  runProbe: (capability: string, args: Record<string, unknown>) => Promise<CapabilityResult>;
  now?: () => Date;
  /** IANA zone for cron expressions; defaults to DIALY_TZ, then TZ. */
  timeZone?: string;
  onError?: (message: string, meta: Record<string, unknown>) => void;
};

export const DEFAULT_TICK_MS = 15_000;

export class OperatorScheduler {
  private readonly now: () => Date;
  private readonly timeZone: string | undefined;
  private timer: ReturnType<typeof setInterval> | undefined;
  private ticking = false;

  private readonly lastCronRun = new Map<string, number>();
  private readonly lastProbeRun = new Map<string, number>();
  private readonly probeUnhealthy = new Map<string, boolean>();

  constructor(private readonly deps: OperatorSchedulerDeps) {
    this.now = deps.now ?? (() => new Date());
    this.timeZone = deps.timeZone ?? operatorTimeZone();
  }

  start(intervalMs: number = DEFAULT_TICK_MS): void {
    if (this.timer) {
      return;
    }

    this.timer = setInterval(() => {
      void this.tick();
    }, intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (!this.timer) {
      return;
    }

    clearInterval(this.timer);
    this.timer = undefined;
  }

  async tick(): Promise<void> {
    if (this.ticking) {
      return;
    }

    this.ticking = true;
    try {
      for (const playbook of this.deps.listPlaybooks()) {
        if (!playbook.enabled) {
          continue;
        }

        for (const trigger of playbook.triggers) {
          if (trigger.type === "cron") {
            await this.runCron(playbook, trigger.expression);
          } else if (trigger.type === "probe") {
            await this.runProbe(playbook, trigger.every, trigger.capability);
          }
        }
      }
    } finally {
      this.ticking = false;
    }
  }

  private async runCron(playbook: Playbook, expression: string): Promise<void> {
    const key = `${playbook.id}:${expression}`;
    const now = this.now();
    if (!isCronDue(expression, now, this.lastCronRun.get(key), this.timeZone)) {
      return;
    }

    this.lastCronRun.set(key, now.getTime());
    await this.emit({
      id: `scheduler-cron-${playbook.id}-${now.getTime()}`,
      source: SCHEDULER_SOURCE,
      type: CRON_SIGNAL_TYPE,
      createdAt: now.toISOString(),
      payload: { playbookId: playbook.id, expression },
    });
  }

  private async runProbe(playbook: Playbook, every: string, capability: string): Promise<void> {
    const intervalMs = parseEvery(every);
    if (intervalMs === null) {
      this.deps.onError?.("operator scheduler ignored an unparseable probe interval", {
        playbookId: playbook.id,
        capability,
        every,
      });
      return;
    }

    const key = `${playbook.id}:${capability}`;
    const now = this.now();
    const last = this.lastProbeRun.get(key);
    if (last !== undefined && now.getTime() - last < intervalMs) {
      return;
    }

    this.lastProbeRun.set(key, now.getTime());

    let result: CapabilityResult;
    try {
      result = await this.deps.runProbe(capability, {});
    } catch (error) {
      result = {
        ok: false,
        capability,
        error: error instanceof Error ? error.message : String(error),
      };
    }

    // An unavailable adapter means the probe is unconfigured, not that the
    // watched service is down. Staying quiet avoids nightly false alarms.
    if (result.unavailable) {
      return;
    }

    const { healthy, reason } = readProbeHealth(result);
    const wasUnhealthy = this.probeUnhealthy.get(key) ?? false;
    this.probeUnhealthy.set(key, !healthy);

    // Edge-triggered: a service that stays down for an hour raises one signal,
    // not one per probe interval.
    if (healthy || wasUnhealthy) {
      return;
    }

    await this.emit({
      id: `scheduler-probe-${playbook.id}-${now.getTime()}`,
      source: SCHEDULER_SOURCE,
      type: PROBE_SIGNAL_TYPE,
      createdAt: now.toISOString(),
      payload: {
        playbookId: playbook.id,
        capability,
        healthy: false,
        reason,
        probe: result.data ?? null,
      },
    });
  }

  private async emit(signal: SchedulerSignal): Promise<void> {
    try {
      await this.deps.emit(signal);
    } catch (error) {
      this.deps.onError?.("operator scheduler failed to emit a signal", {
        signalId: signal.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}
