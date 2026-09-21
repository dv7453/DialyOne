import { createHash } from "node:crypto";
import type postgres from "postgres";

import type { TickLock } from "../operator/scheduler-state.js";

export const DEFAULT_TICK_LOCK_NAME = "operator-scheduler";

/**
 * postgres.js `Sql` is overload-heavy and awkward to fake. The lock only needs
 * `reserve()` plus a tagged-template connection with `release()`. Session-level
 * advisory locks are owned by the backend that acquired them — acquire and
 * unlock must run on that reserved connection, not on the pool.
 */
export type ReservedTickLockSql = {
    (strings: TemplateStringsArray, ...parameters: unknown[]): PromiseLike<unknown>;
    release(): void;
};

export type TickLockSql = {
    (strings: TemplateStringsArray, ...parameters: unknown[]): PromiseLike<unknown>;
    reserve(): Promise<ReservedTickLockSql>;
};

export function advisoryLockKeyPair(name: string): { key1: number; key2: number } {
    const digest = createHash("sha256").update(name, "utf8").digest();
    return {
        key1: digest.readInt32BE(0),
        key2: digest.readInt32BE(4),
    };
}

function readAcquiredFlag(rows: unknown): boolean {
    if (!Array.isArray(rows) || rows[0] == null || typeof rows[0] !== "object") {
        return false;
    }
    const row = rows[0] as Record<string, unknown>;
    const value = row.acquired ?? row.pg_try_advisory_lock;
    return value === true || value === "t" || value === "true";
}

function returnToPool(reserved: ReservedTickLockSql): void {
    try {
        reserved.release();
    } catch {
        // A dead connection must not leak out of release paths.
    }
}

export class PgTickLock implements TickLock {
    private readonly sql: TickLockSql;
    private readonly key1: number;
    private readonly key2: number;
    private reserved: ReservedTickLockSql | undefined;

    constructor(
        sql: postgres.Sql | TickLockSql,
        name: string = DEFAULT_TICK_LOCK_NAME,
    ) {
        const keys = advisoryLockKeyPair(name);
        this.key1 = keys.key1;
        this.key2 = keys.key2;
        // ReservedSql's helper overload is not PromiseLike; at runtime the
        // reserved connection is still the tagged-template client we query.
        this.sql = sql as TickLockSql;
    }

    async tryAcquire(): Promise<boolean> {
        if (this.reserved) {
            return true;
        }

        const reserved = await this.sql.reserve();
        try {
            const rows = await reserved`select pg_try_advisory_lock(${this.key1}::integer, ${this.key2}::integer) as acquired`;
            if (!readAcquiredFlag(rows)) {
                return false;
            }
            this.reserved = reserved;
            return true;
        } finally {
            if (this.reserved !== reserved) {
                returnToPool(reserved);
            }
        }
    }

    async release(): Promise<void> {
        const reserved = this.reserved;
        this.reserved = undefined;
        if (!reserved) {
            return;
        }

        try {
            await reserved`select pg_advisory_unlock(${this.key1}::integer, ${this.key2}::integer)`;
        } catch {
            // Session is gone; the backend drops the advisory lock with it.
        } finally {
            returnToPool(reserved);
        }
    }
}
