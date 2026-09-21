import { and, eq, sql, type SQL } from "drizzle-orm";

import type { SpendDayRecord, SpendStore } from "../operator/spend-store.js";
import type { Database } from "./client.js";
import { spendLedger } from "./schema.js";

export const SPEND_CONFLICT_TARGET = [spendLedger.userId, spendLedger.day] as const;
export const STALE_RESERVATION_MS = 30 * 60 * 1000;
export const EMPTY_SPEND_DAY: SpendDayRecord = { committedNanos: 0n, reservedNanos: 0n };

export type PgSpendStoreOptions = {
    now?: () => Date;
    staleReservationMs?: number;
};

export function requireSpendUserId(userId: string): string {
    if (typeof userId !== "string" || userId === "") {
        throw new Error("PgSpendStore requires a userId; refusing unscoped access");
    }
    return userId;
}

export function createPgSpendStore(db: Database, options?: PgSpendStoreOptions): PgSpendStore {
    return new PgSpendStore(db, options);
}

export function clampNonNegativeNanos(value: bigint): bigint {
    return value < 0n ? 0n : value;
}

export function parseNanos(value: unknown): bigint | undefined {
    if (typeof value === "bigint") {
        return value;
    }
    if (typeof value === "number") {
        if (!Number.isSafeInteger(value)) {
            return undefined;
        }
        return BigInt(value);
    }
    if (typeof value === "string" && /^-?\d+$/.test(value)) {
        try {
            return BigInt(value);
        } catch {
            return undefined;
        }
    }
    return undefined;
}

export function canReserve(
    committedNanos: bigint,
    reservedNanos: bigint,
    amount: bigint,
    ceilingNanos: bigint,
): boolean {
    const used = committedNanos + reservedNanos;
    return used < ceilingNanos && used + amount <= ceilingNanos;
}

export function nextReservedAfterRelease(reservedNanos: bigint, releaseNanos: bigint): bigint {
    return reservedNanos > releaseNanos ? reservedNanos - releaseNanos : 0n;
}

export function staleCutoff(now: Date, staleMs: number = STALE_RESERVATION_MS): Date {
    return new Date(now.getTime() - staleMs);
}

export function isReservationStale(
    reservedUpdatedAt: Date | undefined,
    now: Date,
    staleMs: number = STALE_RESERVATION_MS,
): boolean {
    if (!reservedUpdatedAt) {
        return false;
    }
    const ms = reservedUpdatedAt.getTime();
    if (!Number.isFinite(ms)) {
        return false;
    }
    return now.getTime() - ms >= staleMs;
}

export function effectiveReservedNanos(params: {
    reservedNanos: bigint;
    reservedUpdatedAt: Date | undefined;
    now: Date;
    staleMs?: number;
}): bigint {
    if (params.reservedNanos <= 0n) {
        return 0n;
    }
    if (isReservationStale(params.reservedUpdatedAt, params.now, params.staleMs ?? STALE_RESERVATION_MS)) {
        return 0n;
    }
    return params.reservedNanos;
}

export function isoToDate(value: unknown): Date | undefined {
    if (value instanceof Date) {
        const ms = value.getTime();
        return Number.isFinite(ms) ? value : undefined;
    }
    if (typeof value === "number") {
        return Number.isFinite(value) ? new Date(value) : undefined;
    }
    if (typeof value === "string" && value !== "") {
        const ms = Date.parse(value);
        return Number.isFinite(ms) ? new Date(ms) : undefined;
    }
    return undefined;
}

export function parseSpendRow(row: unknown): SpendDayRecord | undefined {
    if (row == null || typeof row !== "object" || Array.isArray(row)) {
        return undefined;
    }
    const rec = row as Record<string, unknown>;
    const committedNanos = parseNanos(rec.spentNanos ?? rec.committedNanos);
    const reservedNanos = parseNanos(rec.reservedNanos);
    if (committedNanos === undefined || reservedNanos === undefined) {
        return undefined;
    }
    return { committedNanos, reservedNanos };
}

export function parseSpendRowWithStamp(row: unknown): {
    record: SpendDayRecord;
    reservedUpdatedAt: Date | undefined;
} | undefined {
    const record = parseSpendRow(row);
    if (!record) {
        return undefined;
    }
    const rec = row as Record<string, unknown>;
    return { record, reservedUpdatedAt: isoToDate(rec.reservedUpdatedAt) };
}

export function effectiveReservedSql(staleBefore: Date): SQL {
    return sql`(CASE WHEN ${spendLedger.reservedUpdatedAt} < ${staleBefore} THEN 0::bigint ELSE ${spendLedger.reservedNanos} END)`;
}

export function reservedAfterReserveSql(amount: bigint, staleBefore: Date): SQL {
    return sql`(CASE WHEN ${spendLedger.reservedUpdatedAt} < ${staleBefore} THEN ${amount} ELSE ${spendLedger.reservedNanos} + ${amount} END)`;
}

export function canReserveSql(amount: bigint, ceiling: bigint, staleBefore: Date): SQL {
    const used = effectiveReservedSql(staleBefore);
    return sql`${used} + ${spendLedger.spentNanos} < ${ceiling} AND ${used} + ${spendLedger.spentNanos} + ${amount} <= ${ceiling}`;
}

export function reservedAfterReleaseSql(releaseNanos: bigint, staleBefore: Date): SQL {
    return sql`GREATEST(0::bigint, ${effectiveReservedSql(staleBefore)} - ${releaseNanos})`;
}

export function spentAfterSettleSql(actualNanos: bigint): SQL {
    return sql`${spendLedger.spentNanos} + ${actualNanos}`;
}

/**
 * Reservations are `reserved_nanos = reserved_nanos + amount` (or the stale
 * CASE) inside one UPDATE whose WHERE is the ceiling check. Two concurrent
 * callers serialize on the `(user_id, day)` row; they cannot both pass a
 * JS-side read of the same remaining budget.
 */
export class PgSpendStore implements SpendStore {
    private readonly now: () => Date;
    private readonly staleReservationMs: number;

    constructor(
        private readonly db: Database,
        options: PgSpendStoreOptions = {},
    ) {
        this.now = options.now ?? (() => new Date());
        this.staleReservationMs = options.staleReservationMs ?? STALE_RESERVATION_MS;
    }

    async get(userId: string, day: string): Promise<SpendDayRecord> {
        requireSpendUserId(userId);
        const now = this.now();
        const staleBefore = staleCutoff(now, this.staleReservationMs);
        return this.db.transaction(async (tx) => {
            await tx
                .update(spendLedger)
                .set({
                    reservedNanos: 0n,
                    reservedUpdatedAt: now,
                    updatedAt: now,
                })
                .where(
                    and(
                        eq(spendLedger.userId, userId),
                        eq(spendLedger.day, day),
                        sql`${spendLedger.reservedNanos} > 0 AND ${spendLedger.reservedUpdatedAt} < ${staleBefore}`,
                    ),
                );
            const rows = await tx
                .select()
                .from(spendLedger)
                .where(and(eq(spendLedger.userId, userId), eq(spendLedger.day, day)))
                .limit(1);
            return parseSpendRow(rows[0]) ?? { ...EMPTY_SPEND_DAY };
        });
    }

    async tryReserve(userId: string, day: string, nanos: bigint, ceilingNanos: bigint): Promise<boolean> {
        requireSpendUserId(userId);
        const amount = clampNonNegativeNanos(nanos);
        const now = this.now();
        const staleBefore = staleCutoff(now, this.staleReservationMs);
        return this.db.transaction(async (tx) => {
            await tx
                .insert(spendLedger)
                .values({
                    userId,
                    day,
                    reservedNanos: 0n,
                    spentNanos: 0n,
                    reservedUpdatedAt: now,
                    createdAt: now,
                    updatedAt: now,
                })
                .onConflictDoNothing({
                    target: [...SPEND_CONFLICT_TARGET],
                });
            const updated = await tx
                .update(spendLedger)
                .set({
                    reservedNanos: reservedAfterReserveSql(amount, staleBefore),
                    reservedUpdatedAt: now,
                    updatedAt: now,
                })
                .where(
                    and(
                        eq(spendLedger.userId, userId),
                        eq(spendLedger.day, day),
                        canReserveSql(amount, ceilingNanos, staleBefore),
                    ),
                )
                .returning();
            return updated.length > 0;
        });
    }

    async settle(userId: string, day: string, reservedNanos: bigint, actualNanos: bigint): Promise<void> {
        requireSpendUserId(userId);
        const reserved = clampNonNegativeNanos(reservedNanos);
        const actual = clampNonNegativeNanos(actualNanos);
        const now = this.now();
        const staleBefore = staleCutoff(now, this.staleReservationMs);
        await this.db.transaction(async (tx) => {
            await tx
                .insert(spendLedger)
                .values({
                    userId,
                    day,
                    reservedNanos: 0n,
                    spentNanos: 0n,
                    reservedUpdatedAt: now,
                    createdAt: now,
                    updatedAt: now,
                })
                .onConflictDoNothing({
                    target: [...SPEND_CONFLICT_TARGET],
                });
            await tx
                .update(spendLedger)
                .set({
                    reservedNanos: reservedAfterReleaseSql(reserved, staleBefore),
                    spentNanos: spentAfterSettleSql(actual),
                    reservedUpdatedAt: now,
                    updatedAt: now,
                })
                .where(and(eq(spendLedger.userId, userId), eq(spendLedger.day, day)));
        });
    }

    async release(userId: string, day: string, reservedNanos: bigint): Promise<void> {
        requireSpendUserId(userId);
        const reserved = clampNonNegativeNanos(reservedNanos);
        const now = this.now();
        const staleBefore = staleCutoff(now, this.staleReservationMs);
        await this.db
            .update(spendLedger)
            .set({
                reservedNanos: reservedAfterReleaseSql(reserved, staleBefore),
                reservedUpdatedAt: now,
                updatedAt: now,
            })
            .where(and(eq(spendLedger.userId, userId), eq(spendLedger.day, day)));
    }
}
