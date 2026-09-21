import type postgres from "postgres";
import { describe, expect, it } from "vitest";

import {
    DEFAULT_TICK_LOCK_NAME,
    PgTickLock,
    advisoryLockKeyPair,
    type ReservedTickLockSql,
    type TickLockSql,
} from "./tick-lock.js";

function _assertPostgresSqlAssignable(sql: postgres.Sql): PgTickLock {
    return new PgTickLock(sql, DEFAULT_TICK_LOCK_NAME);
}

void _assertPostgresSqlAssignable;

type QueryCall = {
    target: object;
    sql: string;
    parameters: unknown[];
};

function interpolate(strings: TemplateStringsArray, parameters: unknown[]): string {
    return strings.reduce((acc, part, i) => acc + part + (i < parameters.length ? `$${i + 1}` : ""), "");
}

function createFakeSql(options: {
    acquire?: boolean | "throw";
    unlock?: "ok" | "throw";
    release?: "ok" | "throw";
    reserve?: "ok" | "throw";
} = {}) {
    const calls: QueryCall[] = [];
    let reserveCount = 0;
    let releaseCount = 0;

    const reserved = Object.assign(
        (strings: TemplateStringsArray, ...parameters: unknown[]) => {
            const sql = interpolate(strings, parameters);
            calls.push({ target: reserved, sql, parameters });
            if (sql.includes("pg_try_advisory_lock")) {
                if (options.acquire === "throw") {
                    return Promise.reject(new Error("acquire query failed"));
                }
                return Promise.resolve([{ acquired: options.acquire !== false }]);
            }
            if (sql.includes("pg_advisory_unlock")) {
                if (options.unlock === "throw") {
                    return Promise.reject(new Error("unlock query failed"));
                }
                return Promise.resolve([{ pg_advisory_unlock: true }]);
            }
            return Promise.resolve([]);
        },
        {
            release() {
                releaseCount += 1;
                if (options.release === "throw") {
                    throw new Error("reserved connection release failed");
                }
            },
        },
    ) as ReservedTickLockSql;

    const pool = Object.assign(
        (strings: TemplateStringsArray, ...parameters: unknown[]) => {
            const sql = interpolate(strings, parameters);
            calls.push({ target: pool, sql, parameters });
            return Promise.resolve([]);
        },
        {
            reserve() {
                reserveCount += 1;
                if (options.reserve === "throw") {
                    return Promise.reject(new Error("reserve failed"));
                }
                return Promise.resolve(reserved);
            },
        },
    ) as TickLockSql;

    return {
        pool,
        reserved,
        calls,
        reserveCount: () => reserveCount,
        releaseCount: () => releaseCount,
    };
}

describe("advisoryLockKeyPair", () => {
    it("derives a stable pair of signed 32-bit keys from the lock name", () => {
        const a = advisoryLockKeyPair("operator-scheduler");
        const b = advisoryLockKeyPair("operator-scheduler");
        const other = advisoryLockKeyPair("other-lock");

        expect(a).toEqual(b);
        expect(a).not.toEqual(other);
        expect(Number.isInteger(a.key1)).toBe(true);
        expect(Number.isInteger(a.key2)).toBe(true);
        expect(a.key1).toBeGreaterThanOrEqual(-0x80000000);
        expect(a.key1).toBeLessThanOrEqual(0x7fffffff);
        expect(a.key2).toBeGreaterThanOrEqual(-0x80000000);
        expect(a.key2).toBeLessThanOrEqual(0x7fffffff);
    });
});

describe("PgTickLock", () => {
    it("issues acquire and unlock on the same reserved connection, not the pool", async () => {
        const fake = createFakeSql();
        const lock = new PgTickLock(fake.pool, "operator-scheduler");
        const keys = advisoryLockKeyPair("operator-scheduler");

        expect(await lock.tryAcquire()).toBe(true);
        await lock.release();

        expect(fake.reserveCount()).toBe(1);
        expect(fake.releaseCount()).toBe(1);
        expect(fake.calls).toHaveLength(2);

        expect(fake.calls[0]?.target).toBe(fake.reserved);
        expect(fake.calls[1]?.target).toBe(fake.reserved);
        expect(fake.calls.some((call) => call.target === fake.pool)).toBe(false);

        expect(fake.calls[0]?.sql).toContain("pg_try_advisory_lock");
        expect(fake.calls[0]?.sql).not.toContain("pg_advisory_lock(");
        expect(fake.calls[0]?.parameters).toEqual([keys.key1, keys.key2]);

        expect(fake.calls[1]?.sql).toContain("pg_advisory_unlock");
        expect(fake.calls[1]?.parameters).toEqual([keys.key1, keys.key2]);
    });

    it("returns false when the lock is refused and still returns the reserved connection", async () => {
        const fake = createFakeSql({ acquire: false });
        const lock = new PgTickLock(fake.pool);

        expect(await lock.tryAcquire()).toBe(false);
        expect(fake.releaseCount()).toBe(1);
        expect(fake.calls).toHaveLength(1);
        expect(fake.calls[0]?.target).toBe(fake.reserved);
        expect(fake.calls[0]?.sql).toContain("pg_try_advisory_lock");
        expect(fake.calls.some((call) => call.sql.includes("pg_advisory_unlock"))).toBe(false);

        await expect(lock.release()).resolves.toBeUndefined();
        expect(fake.releaseCount()).toBe(1);
    });

    it("returns the reserved connection when the acquire query throws", async () => {
        const fake = createFakeSql({ acquire: "throw" });
        const lock = new PgTickLock(fake.pool);

        await expect(lock.tryAcquire()).rejects.toThrow("acquire query failed");
        expect(fake.releaseCount()).toBe(1);
        expect(fake.calls.some((call) => call.sql.includes("pg_advisory_unlock"))).toBe(false);
    });

    it("returns the reserved connection when unlock throws and does not throw from release", async () => {
        const fake = createFakeSql({ unlock: "throw" });
        const lock = new PgTickLock(fake.pool);

        expect(await lock.tryAcquire()).toBe(true);
        await expect(lock.release()).resolves.toBeUndefined();
        expect(fake.releaseCount()).toBe(1);
    });

    it("does not throw from release when returning the connection fails", async () => {
        const fake = createFakeSql({ release: "throw" });
        const lock = new PgTickLock(fake.pool);

        expect(await lock.tryAcquire()).toBe(true);
        await expect(lock.release()).resolves.toBeUndefined();
        expect(fake.releaseCount()).toBe(1);
    });

    it("treats release as a no-op when the lock was never acquired", async () => {
        const fake = createFakeSql();
        const lock = new PgTickLock(fake.pool, DEFAULT_TICK_LOCK_NAME);

        await expect(lock.release()).resolves.toBeUndefined();
        expect(fake.reserveCount()).toBe(0);
        expect(fake.releaseCount()).toBe(0);
        expect(fake.calls).toEqual([]);
    });

    it("does not throw from release when the connection died after acquire", async () => {
        const fake = createFakeSql({ unlock: "throw", release: "throw" });
        const lock = new PgTickLock(fake.pool);

        expect(await lock.tryAcquire()).toBe(true);
        await expect(lock.release()).resolves.toBeUndefined();
    });

    it("returns the reserved connection when acquire is refused even if release throws", async () => {
        const fake = createFakeSql({ acquire: false, release: "throw" });
        const lock = new PgTickLock(fake.pool);

        expect(await lock.tryAcquire()).toBe(false);
        expect(fake.releaseCount()).toBe(1);
        await expect(lock.release()).resolves.toBeUndefined();
    });
});
