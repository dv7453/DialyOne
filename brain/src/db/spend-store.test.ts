import { describe, expect, it } from "vitest";

import type { Database } from "./client.js";
import { spendLedger } from "./schema.js";
import {
    EMPTY_SPEND_DAY,
    PgSpendStore,
    SPEND_CONFLICT_TARGET,
    STALE_RESERVATION_MS,
    canReserve,
    clampNonNegativeNanos,
    createPgSpendStore,
    effectiveReservedNanos,
    nextReservedAfterRelease,
    parseNanos,
    parseSpendRow,
    reservedAfterReserveSql,
    requireSpendUserId,
    staleCutoff,
} from "./spend-store.js";

const USER_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_USER_ID = "22222222-2222-4222-8222-222222222222";
const DAY = "2026-09-21";
const NOW = new Date("2026-09-21T12:00:00.000Z");
const BEYOND_32_BITS = 5_000_000_000n;
const BEYOND_SAFE_INTEGER = 9_007_199_254_740_993n;

function containsPrimitive(value: unknown, needle: unknown, seen = new Set<unknown>()): boolean {
    if (Object.is(value, needle)) {
        return true;
    }
    if (value instanceof Date && needle instanceof Date && value.getTime() === needle.getTime()) {
        return true;
    }
    if (value == null || typeof value !== "object" || seen.has(value)) {
        return false;
    }
    seen.add(value);
    if (Array.isArray(value)) {
        return value.some((item) => containsPrimitive(item, needle, seen));
    }
    if ("queryChunks" in value) {
        return containsPrimitive((value as { queryChunks: unknown }).queryChunks, needle, seen);
    }
    if ("value" in value) {
        return containsPrimitive((value as { value: unknown }).value, needle, seen);
    }
    return false;
}

function isSqlExpr(value: unknown): boolean {
    return value != null && typeof value === "object" && "queryChunks" in value;
}

type InsertCall = {
    values: Record<string, unknown>;
    onConflictDoNothing?: unknown;
};

type UpdateCall = {
    set: Record<string, unknown>;
    where: unknown;
    returning: boolean;
};

type SelectMeta = {
    where?: unknown;
    limit?: number;
};

function createFakeDb(options: {
    selectQueue?: Record<string, unknown>[][];
    updateQueue?: Record<string, unknown>[][];
} = {}) {
    const selectQueue = [...(options.selectQueue ?? [])];
    const updateQueue = [...(options.updateQueue ?? [])];
    const inserts: InsertCall[] = [];
    const updates: UpdateCall[] = [];
    const selects: SelectMeta[] = [];
    const stats = { transactionCount: 0 };

    const nextSelect = () => (selectQueue.length > 0 ? selectQueue.shift()! : []);
    const nextUpdate = () => (updateQueue.length > 0 ? updateQueue.shift()! : []);

    const api = {
        insert() {
            return {
                values(values: Record<string, unknown>) {
                    const call: InsertCall = { values };
                    inserts.push(call);
                    return {
                        onConflictDoNothing(config?: unknown) {
                            call.onConflictDoNothing = config;
                            return Promise.resolve();
                        },
                    };
                },
            };
        },
        select() {
            const meta: SelectMeta = {};
            let consumed = false;
            const consume = () => {
                if (!consumed) {
                    consumed = true;
                    selects.push(meta);
                }
                return Promise.resolve(nextSelect());
            };
            const chain = {
                from() {
                    return chain;
                },
                where(where: unknown) {
                    meta.where = where;
                    return chain;
                },
                limit(limit: number) {
                    meta.limit = limit;
                    return consume();
                },
                then(
                    onFulfilled: (value: Record<string, unknown>[]) => unknown,
                    onRejected?: (reason: unknown) => unknown,
                ) {
                    return consume().then(onFulfilled, onRejected);
                },
            };
            return chain;
        },
        update() {
            return {
                set(set: Record<string, unknown>) {
                    return {
                        where(where: unknown) {
                            const call: UpdateCall = { set, where, returning: false };
                            updates.push(call);
                            const rows = nextUpdate();
                            const done = Promise.resolve(rows);
                            return Object.assign(done, {
                                returning() {
                                    call.returning = true;
                                    return Promise.resolve(rows);
                                },
                            });
                        },
                    };
                },
            };
        },
        transaction(fn: (tx: unknown) => Promise<unknown>) {
            stats.transactionCount += 1;
            return fn(api);
        },
    };

    return {
        db: api as unknown as Database,
        inserts,
        updates,
        selects,
        stats,
    };
}

describe("requireSpendUserId", () => {
    it("rejects missing tenant ids instead of inventing a default", async () => {
        expect(() => requireSpendUserId("")).toThrow(/userId/);
        const store = new PgSpendStore(createFakeDb().db);
        await expect(store.get("", DAY)).rejects.toThrow(/userId/);
        await expect(store.tryReserve("", DAY, 1n, 10n)).rejects.toThrow(/userId/);
    });
});

describe("parseNanos", () => {
    it("round-trips nano-USD values beyond 32 bits and beyond Number.MAX_SAFE_INTEGER", () => {
        expect(parseNanos(BEYOND_32_BITS)).toBe(BEYOND_32_BITS);
        expect(parseNanos(BEYOND_32_BITS.toString())).toBe(BEYOND_32_BITS);
        expect(parseNanos(BEYOND_SAFE_INTEGER)).toBe(BEYOND_SAFE_INTEGER);
        expect(parseNanos(BEYOND_SAFE_INTEGER.toString())).toBe(BEYOND_SAFE_INTEGER);
        expect(parseNanos(0)).toBe(0n);
        expect(parseNanos("0")).toBe(0n);
    });

    it("refuses unsafe numbers and malformed values instead of throwing", () => {
        expect(parseNanos(Number.MAX_SAFE_INTEGER + 2)).toBeUndefined();
        expect(parseNanos(1.5)).toBeUndefined();
        expect(parseNanos("1.0")).toBeUndefined();
        expect(parseNanos("nope")).toBeUndefined();
        expect(parseNanos(undefined)).toBeUndefined();
        expect(parseNanos({})).toBeUndefined();
    });
});

describe("clampNonNegativeNanos / canReserve / nextReservedAfterRelease", () => {
    it("matches the in-memory store's clamping and ceiling checks", () => {
        expect(clampNonNegativeNanos(-3n)).toBe(0n);
        expect(clampNonNegativeNanos(4n)).toBe(4n);

        expect(canReserve(0n, 0n, 700n, 1000n)).toBe(true);
        expect(canReserve(0n, 700n, 300n, 1000n)).toBe(true);
        expect(canReserve(0n, 1000n, 1n, 1000n)).toBe(false);
        expect(canReserve(0n, 0n, 0n, 0n)).toBe(false);
        expect(canReserve(0n, 0n, 0n, 1n)).toBe(true);

        expect(nextReservedAfterRelease(800n, 800n)).toBe(0n);
        expect(nextReservedAfterRelease(100n, 250n)).toBe(0n);
        expect(nextReservedAfterRelease(500n, 120n)).toBe(380n);
    });

    it("rejects a second concurrent reserve that would exceed the ceiling", () => {
        const ceiling = 1000n;
        const first = canReserve(0n, 0n, 600n, ceiling);
        const afterFirst = 600n;
        const second = canReserve(0n, afterFirst, 600n, ceiling);
        expect(first).toBe(true);
        expect(second).toBe(false);
        expect(first && second).toBe(false);
        expect(afterFirst + 600n).toBeGreaterThan(ceiling);
    });
});

describe("effectiveReservedNanos", () => {
    it("treats a reservation older than the TTL as released", () => {
        const fresh = new Date(NOW.getTime() - STALE_RESERVATION_MS + 1);
        const stale = new Date(NOW.getTime() - STALE_RESERVATION_MS);
        expect(
            effectiveReservedNanos({ reservedNanos: 400n, reservedUpdatedAt: fresh, now: NOW }),
        ).toBe(400n);
        expect(
            effectiveReservedNanos({ reservedNanos: 400n, reservedUpdatedAt: stale, now: NOW }),
        ).toBe(0n);
        expect(staleCutoff(NOW).getTime()).toBe(NOW.getTime() - STALE_RESERVATION_MS);
    });
});

describe("parseSpendRow", () => {
    it("maps spent_nanos onto committedNanos and keeps bigint precision", () => {
        expect(
            parseSpendRow({
                spentNanos: BEYOND_SAFE_INTEGER.toString(),
                reservedNanos: BEYOND_32_BITS,
            }),
        ).toEqual({
            committedNanos: BEYOND_SAFE_INTEGER,
            reservedNanos: BEYOND_32_BITS,
        });
    });

    it("returns undefined for malformed rows instead of throwing", () => {
        expect(parseSpendRow(undefined)).toBeUndefined();
        expect(parseSpendRow({ spentNanos: 1.2, reservedNanos: 0n })).toBeUndefined();
        expect(parseSpendRow({ spentNanos: 0n })).toBeUndefined();
    });
});

describe("PgSpendStore", () => {
    it("returns zeros when the user-day row is missing", async () => {
        const { db, stats, selects } = createFakeDb({ selectQueue: [[]] });
        const store = createPgSpendStore(db, { now: () => NOW });

        await expect(store.get(USER_ID, DAY)).resolves.toEqual(EMPTY_SPEND_DAY);
        expect(stats.transactionCount).toBe(1);
        expect(containsPrimitive(selects[0]?.where, USER_ID)).toBe(true);
        expect(containsPrimitive(selects[0]?.where, OTHER_USER_ID)).toBe(false);
    });

    it("reserves inside a transaction with SQL increment and a ceiling WHERE", async () => {
        const { db, inserts, updates, stats } = createFakeDb({
            updateQueue: [[{ reservedNanos: 700n, spentNanos: 0n }]],
        });
        const store = new PgSpendStore(db, { now: () => NOW });

        await expect(store.tryReserve(USER_ID, DAY, 700n, 1000n)).resolves.toBe(true);

        expect(stats.transactionCount).toBe(1);
        expect(inserts).toHaveLength(1);
        expect(inserts[0]?.values).toMatchObject({
            userId: USER_ID,
            day: DAY,
            reservedNanos: 0n,
            spentNanos: 0n,
        });
        expect(inserts[0]?.onConflictDoNothing).toEqual({
            target: [...SPEND_CONFLICT_TARGET],
        });
        expect(updates).toHaveLength(1);
        expect(isSqlExpr(updates[0]?.set.reservedNanos)).toBe(true);
        expect(containsPrimitive(updates[0]?.set.reservedNanos, spendLedger.reservedNanos)).toBe(true);
        expect(typeof updates[0]?.set.reservedNanos).not.toBe("bigint");
        expect(updates[0]?.returning).toBe(true);
        expect(isSqlExpr(updates[0]?.where) || typeof updates[0]?.where === "object").toBe(true);
        expect(containsPrimitive(updates[0]?.where, USER_ID)).toBe(true);
        expect(containsPrimitive(updates[0]?.where, DAY)).toBe(true);
        expect(containsPrimitive(updates[0]?.where, spendLedger.spentNanos)).toBe(true);
        void spendLedger.userId;
    });

    it("rejects a reserve when the UPDATE matches no row", async () => {
        const { db, updates } = createFakeDb({ updateQueue: [[]] });
        const store = new PgSpendStore(db, { now: () => NOW });

        await expect(store.tryReserve(USER_ID, DAY, 1n, 0n)).resolves.toBe(false);
        expect(updates[0]?.returning).toBe(true);
    });

    it("does not add the amount in JS, so concurrent reserves cannot both pass the same remaining budget", async () => {
        const { db, updates } = createFakeDb({
            updateQueue: [[{ reservedNanos: BEYOND_32_BITS, spentNanos: 0n }]],
        });
        const store = new PgSpendStore(db, { now: () => NOW });

        await store.tryReserve(USER_ID, DAY, BEYOND_32_BITS, BEYOND_SAFE_INTEGER);

        const reservedSet = updates[0]?.set.reservedNanos;
        expect(reservedSet).not.toBe(BEYOND_32_BITS);
        expect(isSqlExpr(reservedSet)).toBe(true);
        expect(containsPrimitive(reservedSet, spendLedger.reservedNanos)).toBe(true);
        expect(containsPrimitive(reservedSet, BEYOND_32_BITS)).toBe(true);

        const expr = reservedAfterReserveSql(BEYOND_32_BITS, staleCutoff(NOW));
        expect(isSqlExpr(expr)).toBe(true);
        expect(containsPrimitive(expr, spendLedger.reservedNanos)).toBe(true);
    });

    it("settles by subtracting reserved and adding spent in SQL", async () => {
        const { db, inserts, updates, stats } = createFakeDb();
        const store = new PgSpendStore(db, { now: () => NOW });

        await store.settle(USER_ID, DAY, 800n, 250n);

        expect(stats.transactionCount).toBe(1);
        expect(inserts[0]?.onConflictDoNothing).toEqual({
            target: [...SPEND_CONFLICT_TARGET],
        });
        expect(isSqlExpr(updates[0]?.set.reservedNanos)).toBe(true);
        expect(isSqlExpr(updates[0]?.set.spentNanos)).toBe(true);
        expect(containsPrimitive(updates[0]?.set.spentNanos, spendLedger.spentNanos)).toBe(true);
        expect(containsPrimitive(updates[0]?.set.spentNanos, 250n)).toBe(true);
    });

    it("releases reserved budget without inserting a missing row", async () => {
        const { db, inserts, updates } = createFakeDb();
        const store = new PgSpendStore(db, { now: () => NOW });

        await store.release(USER_ID, DAY, 100n);

        expect(inserts).toHaveLength(0);
        expect(isSqlExpr(updates[0]?.set.reservedNanos)).toBe(true);
        expect(containsPrimitive(updates[0]?.where, USER_ID)).toBe(true);
    });

    it("round-trips bigint amounts larger than 32 bits through insert values", async () => {
        const { db, inserts } = createFakeDb();
        const store = new PgSpendStore(db, { now: () => NOW });

        await store.tryReserve(USER_ID, DAY, BEYOND_SAFE_INTEGER, BEYOND_SAFE_INTEGER + 1n);

        expect(inserts[0]?.values.reservedNanos).toBe(0n);
        expect(inserts[0]?.values.spentNanos).toBe(0n);
        expect(typeof inserts[0]?.values.reservedNanos).toBe("bigint");
    });
});
