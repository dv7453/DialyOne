/**
 * Durable stand-in for the scheduler's in-memory Maps. Cron and probe last-run
 * timestamps are separate so a playbook that has both cannot collide on key.
 */
export interface SchedulerStateStore {
  getLastCronRun(key: string): Promise<number | undefined>;
  setLastCronRun(key: string, at: number): Promise<void>;
  getLastProbeRun(key: string): Promise<number | undefined>;
  setLastProbeRun(key: string, at: number): Promise<void>;
  getProbeUnhealthy(key: string): Promise<boolean | undefined>;
  setProbeUnhealthy(key: string, unhealthy: boolean): Promise<void>;
}

/**
 * Non-blocking tick mutex. A Postgres implementation should map onto
 * pg_try_advisory_lock / pg_advisory_unlock: try without waiting, then
 * release explicitly. Missing the lock means another process already owns
 * this tick.
 */
export interface TickLock {
  tryAcquire(): Promise<boolean>;
  release(): Promise<void>;
}

export class InMemorySchedulerStateStore implements SchedulerStateStore {
  private readonly lastCronRun = new Map<string, number>();
  private readonly lastProbeRun = new Map<string, number>();
  private readonly probeUnhealthy = new Map<string, boolean>();

  async getLastCronRun(key: string): Promise<number | undefined> {
    return this.lastCronRun.get(key);
  }

  async setLastCronRun(key: string, at: number): Promise<void> {
    this.lastCronRun.set(key, at);
  }

  async getLastProbeRun(key: string): Promise<number | undefined> {
    return this.lastProbeRun.get(key);
  }

  async setLastProbeRun(key: string, at: number): Promise<void> {
    this.lastProbeRun.set(key, at);
  }

  async getProbeUnhealthy(key: string): Promise<boolean | undefined> {
    return this.probeUnhealthy.get(key);
  }

  async setProbeUnhealthy(key: string, unhealthy: boolean): Promise<void> {
    this.probeUnhealthy.set(key, unhealthy);
  }
}

/** Always succeeds. Preserves single-process behaviour when no distributed lock is wired. */
export class NoopTickLock implements TickLock {
  async tryAcquire(): Promise<boolean> {
    return true;
  }

  async release(): Promise<void> {}
}
