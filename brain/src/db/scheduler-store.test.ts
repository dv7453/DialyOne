import { describe, expect, it } from "vitest";

import type { Database } from "./client.js";
import { schedulerState } from "./schema.js";
import {
    CRON_KEY_PREFIX,
    PgSchedulerStateStore,
    PROBE_HEALTH_KEY_PREFIX,
    PROBE_KEY_PREFIX,
    cronStateKey,
    dateToEpochMs,
    epochMsToDate,
    parseProbeUnhealthy,
    probeHealthPayload,
    probeHealthStateKey,
    probeStateKey,
} from "./scheduler-store.js";

describe("scheduler state key prefixes", () => {
    const key = "morning-brief:0 8 * * *";

    it("keeps cron, probe, and probe-health in separate namespaces", () => {
        expect(CRON_KEY_PREFIX).toBe("cron:");
        expect(PROBE_KEY_PREFIX).toBe("probe:");
        expect(PROBE_HEALTH_KEY_PREFIX).toBe("probe_health:");

        expect(cronStateKey(key)).toBe(`cron:${key}`);
        expect(probeStateKey(key)).toBe(`probe:${key}`);
        expect(probeHealthStateKey(key)).toBe(`probe_health:${key}`);

        const storageKeys = [cronStateKey(key), probeStateKey(key), probeHealthStateKey(key)];
        expect(new Set(storageKeys).size).toBe(3);
    });
});

describe("epochMsToDate / dateToEpochMs", () => {
    it("round-trips millisecond timestamps without converting through seconds", () => {
        for (const at of [0, 1, 1_000, 1_700_000_000_123, Date.parse("2026-01-01T08:00:30.123Z")]) {
            const date = epochMsToDate(at);
            expect(date).toBeInstanceOf(Date);
            expect(dateToEpochMs(date)).toBe(at);
            expect(date.getTime()).toBe(at);
        }
    });

    it("returns undefined for missing or invalid values", () => {
        expect(dateToEpochMs(undefined)).toBeUndefined();
        expect(dateToEpochMs(null)).toBeUndefined();
        expect(dateToEpochMs(Number.NaN)).toBeUndefined();
        expect(dateToEpochMs(new Date(Number.NaN))).toBeUndefined();
        expect(dateToEpochMs({})).toBeUndefined();
        expect(dateToEpochMs("")).toBeUndefined();
        expect(dateToEpochMs("not-a-date")).toBeUndefined();
    });

    it("parses ISO strings and finite numbers defensively", () => {
        expect(dateToEpochMs("2026-01-01T08:00:30.123Z")).toBe(Date.parse("2026-01-01T08:00:30.123Z"));
        expect(dateToEpochMs(42)).toBe(42);
    });
});

describe("parseProbeUnhealthy", () => {
    it("reads a boolean unhealthy flag from payload", () => {
        expect(probeHealthPayload(true)).toEqual({ unhealthy: true });
        expect(probeHealthPayload(false)).toEqual({ unhealthy: false });
        expect(parseProbeUnhealthy({ unhealthy: true })).toBe(true);
        expect(parseProbeUnhealthy({ unhealthy: false })).toBe(false);
        expect(parseProbeUnhealthy({ unhealthy: false, extra: 1 })).toBe(false);
    });

    it("returns undefined for a missing row payload", () => {
        expect(parseProbeUnhealthy(undefined)).toBeUndefined();
        expect(parseProbeUnhealthy(null)).toBeUndefined();
    });

    it("does not throw on unexpected shapes", () => {
        expect(parseProbeUnhealthy("true")).toBeUndefined();
        expect(parseProbeUnhealthy(1)).toBeUndefined();
        expect(parseProbeUnhealthy(true)).toBeUndefined();
        expect(parseProbeUnhealthy([])).toBeUndefined();
        expect(parseProbeUnhealthy({ unhealthy: "true" })).toBeUndefined();
        expect(parseProbeUnhealthy({ unhealthy: 1 })).toBeUndefined();
        expect(parseProbeUnhealthy({ healthy: false })).toBeUndefined();
        expect(parseProbeUnhealthy({ unhealthy: null })).toBeUndefined();
    });
});

type InsertCall = {
    values: Record<string, unknown>;
    onConflict: { target: unknown; set: Record<string, unknown> };
};

function createFakeDb(rows: Record<string, unknown>[] = []) {
    const inserts: InsertCall[] = [];
    const db = {
        insert() {
            return {
                values(values: Record<string, unknown>) {
                    return {
                        onConflictDoUpdate(onConflict: InsertCall["onConflict"]) {
                            inserts.push({ values, onConflict });
                            return Promise.resolve();
                        },
                    };
                },
            };
        },
        select() {
            return {
                from() {
                    return {
                        where() {
                            return {
                                limit() {
                                    return Promise.resolve(rows);
                                },
                            };
                        },
                    };
                },
            };
        },
    };

    return { db: db as unknown as Database, inserts };
}

describe("PgSchedulerStateStore", () => {
    it("upserts last-run timestamps as Dates under prefixed keys", async () => {
        const { db, inserts } = createFakeDb();
        const store = new PgSchedulerStateStore(db);

        await store.setLastCronRun("morning-brief:0 8 * * *", 1_000);
        await store.setLastProbeRun("deploy-sentinel:deploy.health", 2_000);

        expect(inserts).toHaveLength(2);
        expect(inserts[0]?.values).toEqual({
            key: "cron:morning-brief:0 8 * * *",
            lastRunAt: new Date(1_000),
        });
        expect(inserts[0]?.onConflict.target).toBe(schedulerState.key);
        expect(inserts[0]?.onConflict.set).toEqual({ lastRunAt: new Date(1_000) });

        expect(inserts[1]?.values).toEqual({
            key: "probe:deploy-sentinel:deploy.health",
            lastRunAt: new Date(2_000),
        });
        expect(inserts[1]?.onConflict.target).toBe(schedulerState.key);
        expect(inserts[1]?.onConflict.set).toEqual({ lastRunAt: new Date(2_000) });
    });

    it("upserts probe health as jsonb { unhealthy } under a distinct key", async () => {
        const { db, inserts } = createFakeDb();
        const store = new PgSchedulerStateStore(db);

        await store.setProbeUnhealthy("deploy-sentinel:deploy.health", true);

        expect(inserts).toHaveLength(1);
        expect(inserts[0]?.values).toEqual({
            key: "probe_health:deploy-sentinel:deploy.health",
            payload: { unhealthy: true },
        });
        expect(inserts[0]?.onConflict.target).toBe(schedulerState.key);
        expect(inserts[0]?.onConflict.set).toEqual({ payload: { unhealthy: true } });
    });

    it("converts lastRunAt back to epoch milliseconds", async () => {
        const { db } = createFakeDb([{ lastRunAt: new Date(5_000) }]);
        const store = new PgSchedulerStateStore(db);

        expect(await store.getLastCronRun("any")).toBe(5_000);
        expect(await store.getLastProbeRun("any")).toBe(5_000);
    });

    it("returns undefined when a last-run row is missing", async () => {
        const { db } = createFakeDb([]);
        const store = new PgSchedulerStateStore(db);

        expect(await store.getLastCronRun("missing")).toBeUndefined();
        expect(await store.getLastProbeRun("missing")).toBeUndefined();
        expect(await store.getProbeUnhealthy("missing")).toBeUndefined();
    });

    it("returns undefined for a malformed probe-health payload instead of throwing", async () => {
        const { db } = createFakeDb([{ payload: { unhealthy: "yes" } }]);
        const store = new PgSchedulerStateStore(db);

        expect(await store.getProbeUnhealthy("deploy-sentinel:deploy.health")).toBeUndefined();
    });

    it("reads a well-formed probe-health flag", async () => {
        const { db } = createFakeDb([{ payload: { unhealthy: true } }]);
        const store = new PgSchedulerStateStore(db);

        expect(await store.getProbeUnhealthy("deploy-sentinel:deploy.health")).toBe(true);
    });
});
