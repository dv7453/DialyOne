import { eq } from "drizzle-orm";

import type { SchedulerStateStore } from "../operator/scheduler-state.js";
import type { Database } from "./client.js";
import { schedulerState } from "./schema.js";

/** One table, three namespaces. Prefixes are the only collision barrier. */
export const CRON_KEY_PREFIX = "cron:";
export const PROBE_KEY_PREFIX = "probe:";
export const PROBE_HEALTH_KEY_PREFIX = "probe_health:";

export function cronStateKey(key: string): string {
    return `${CRON_KEY_PREFIX}${key}`;
}

export function probeStateKey(key: string): string {
    return `${PROBE_KEY_PREFIX}${key}`;
}

export function probeHealthStateKey(key: string): string {
    return `${PROBE_HEALTH_KEY_PREFIX}${key}`;
}

export function epochMsToDate(at: number): Date {
    return new Date(at);
}

export function dateToEpochMs(value: unknown): number | undefined {
    if (value == null) {
        return undefined;
    }
    if (value instanceof Date) {
        const ms = value.getTime();
        return Number.isFinite(ms) ? ms : undefined;
    }
    if (typeof value === "number") {
        return Number.isFinite(value) ? value : undefined;
    }
    if (typeof value === "string" && value !== "") {
        const ms = Date.parse(value);
        return Number.isFinite(ms) ? ms : undefined;
    }
    return undefined;
}

export function probeHealthPayload(unhealthy: boolean): { unhealthy: boolean } {
    return { unhealthy };
}

export function parseProbeUnhealthy(payload: unknown): boolean | undefined {
    if (payload == null || typeof payload !== "object" || Array.isArray(payload)) {
        return undefined;
    }
    const unhealthy = (payload as { unhealthy?: unknown }).unhealthy;
    if (typeof unhealthy === "boolean") {
        return unhealthy;
    }
    return undefined;
}

export class PgSchedulerStateStore implements SchedulerStateStore {
    constructor(private readonly db: Database) {}

    async getLastCronRun(key: string): Promise<number | undefined> {
        return this.getLastRun(cronStateKey(key));
    }

    async setLastCronRun(key: string, at: number): Promise<void> {
        await this.setLastRun(cronStateKey(key), at);
    }

    async getLastProbeRun(key: string): Promise<number | undefined> {
        return this.getLastRun(probeStateKey(key));
    }

    async setLastProbeRun(key: string, at: number): Promise<void> {
        await this.setLastRun(probeStateKey(key), at);
    }

    async getProbeUnhealthy(key: string): Promise<boolean | undefined> {
        const rows = await this.db
            .select({ payload: schedulerState.payload })
            .from(schedulerState)
            .where(eq(schedulerState.key, probeHealthStateKey(key)))
            .limit(1);
        if (rows.length === 0) {
            return undefined;
        }
        return parseProbeUnhealthy(rows[0]?.payload);
    }

    async setProbeUnhealthy(key: string, unhealthy: boolean): Promise<void> {
        const storageKey = probeHealthStateKey(key);
        const payload = probeHealthPayload(unhealthy);
        await this.db
            .insert(schedulerState)
            .values({ key: storageKey, payload })
            .onConflictDoUpdate({
                target: schedulerState.key,
                set: { payload },
            });
    }

    private async getLastRun(storageKey: string): Promise<number | undefined> {
        const rows = await this.db
            .select({ lastRunAt: schedulerState.lastRunAt })
            .from(schedulerState)
            .where(eq(schedulerState.key, storageKey))
            .limit(1);
        return dateToEpochMs(rows[0]?.lastRunAt);
    }

    private async setLastRun(storageKey: string, at: number): Promise<void> {
        const lastRunAt = epochMsToDate(at);
        await this.db
            .insert(schedulerState)
            .values({ key: storageKey, lastRunAt })
            .onConflictDoUpdate({
                target: schedulerState.key,
                set: { lastRunAt },
            });
    }
}
