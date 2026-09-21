import { describe, expect, it } from "vitest";

import { consentToGrantAutonomy, type TrustKey } from "../operator/trust.js";
import { AutonomyGrantError } from "../operator/trust.js";
import type { Database } from "./client.js";
import { trustLedger } from "./schema.js";
import {
    PgTrustLedger,
    TRUST_CONFLICT_TARGET,
    createPgTrustLedger,
    dateToIso,
    incrementStreakSql,
    isoToDate,
    parseSeverity,
    parseTrustRow,
    requireExplicitUserConsent,
    requireTrustUserId,
} from "./trust-store.js";

const USER_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_USER_ID = "22222222-2222-4222-8222-222222222222";
const NOW = new Date("2026-09-21T05:00:00.000Z");

const key: TrustKey = {
    userId: USER_ID,
    playbookId: "inbox-draft",
    capability: "mail.draft",
};

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
    onConflict?: { target: unknown; set: Record<string, unknown> };
    returning: boolean;
};

type SelectMeta = {
    where?: unknown;
    limit?: number;
    orderBy?: unknown;
};

function createFakeDb(options: {
    selectQueue?: Record<string, unknown>[][];
    insertReturning?: Record<string, unknown>[][];
} = {}) {
    const selectQueue = [...(options.selectQueue ?? [])];
    const insertReturning = [...(options.insertReturning ?? [])];
    const inserts: InsertCall[] = [];
    const selects: SelectMeta[] = [];

    const nextSelect = () => (selectQueue.length > 0 ? selectQueue.shift()! : []);
    const nextInsert = () => (insertReturning.length > 0 ? insertReturning.shift()! : []);

    const api = {
        insert() {
            return {
                values(values: Record<string, unknown>) {
                    const call: InsertCall = { values, returning: false };
                    inserts.push(call);
                    return {
                        onConflictDoUpdate(onConflict: InsertCall["onConflict"]) {
                            call.onConflict = onConflict;
                            return {
                                returning() {
                                    call.returning = true;
                                    return Promise.resolve(nextInsert());
                                },
                            };
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
                orderBy(orderBy: unknown) {
                    meta.orderBy = orderBy;
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
    };

    return { db: api as unknown as Database, inserts, selects };
}

function trustRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
        id: "row-1",
        userId: USER_ID,
        playbookId: "inbox-draft",
        capability: "mail.draft",
        severity: "reversible",
        streak: 1,
        autonomyGranted: false,
        updatedAt: NOW,
        ...overrides,
    };
}

describe("requireTrustUserId", () => {
    it("rejects missing tenant ids instead of inventing a default", () => {
        expect(() => requireTrustUserId("")).toThrow(/userId/);
        expect(() => requireTrustUserId(undefined as unknown as string)).toThrow(/userId/);
    });
});

describe("requireExplicitUserConsent", () => {
    it("rejects a boolean so autonomy cannot be auto-granted", () => {
        expect(() => requireExplicitUserConsent(true as never)).toThrow(/ExplicitUserConsent/);
        expect(() => requireExplicitUserConsent(false as never)).toThrow(/ExplicitUserConsent/);
        expect(requireExplicitUserConsent(consentToGrantAutonomy())).toEqual(consentToGrantAutonomy());
    });
});

describe("isoToDate / dateToIso", () => {
    it("round-trips millisecond timestamps", () => {
        expect(dateToIso(isoToDate("2026-09-21T05:00:00.000Z"))).toBe("2026-09-21T05:00:00.000Z");
        expect(dateToIso(NOW)).toBe("2026-09-21T05:00:00.000Z");
    });

    it("returns undefined for missing or invalid values", () => {
        expect(isoToDate(undefined)).toBeUndefined();
        expect(isoToDate(null)).toBeUndefined();
        expect(isoToDate("")).toBeUndefined();
        expect(isoToDate("not-a-date")).toBeUndefined();
        expect(dateToIso({})).toBeUndefined();
    });
});

describe("parseTrustRow", () => {
    it("maps a well-formed row", () => {
        expect(parseTrustRow(trustRow())).toEqual({
            id: "row-1",
            userId: USER_ID,
            playbookId: "inbox-draft",
            capability: "mail.draft",
            severity: "reversible",
            streak: 1,
            autonomyGranted: false,
            updatedAt: "2026-09-21T05:00:00.000Z",
        });
    });

    it("returns undefined for malformed rows instead of throwing", () => {
        expect(parseTrustRow(undefined)).toBeUndefined();
        expect(parseTrustRow(null)).toBeUndefined();
        expect(parseTrustRow([])).toBeUndefined();
        expect(parseTrustRow({ ...trustRow(), streak: 1.5 })).toBeUndefined();
        expect(parseTrustRow({ ...trustRow(), severity: "mild" })).toBeUndefined();
        expect(parseTrustRow({ ...trustRow(), autonomyGranted: "yes" })).toBeUndefined();
        expect(parseTrustRow({ ...trustRow(), updatedAt: "nope" })).toBeUndefined();
        expect(parseTrustRow({ ...trustRow(), userId: "" })).toBeUndefined();
    });

    it("accepts a streak serialized as a decimal string", () => {
        expect(parseTrustRow(trustRow({ streak: "4" }))?.streak).toBe(4);
    });
});

describe("parseSeverity", () => {
    it("only accepts the three stored severities", () => {
        expect(parseSeverity("reversible")).toBe("reversible");
        expect(parseSeverity("consequential")).toBe("consequential");
        expect(parseSeverity("irreversible")).toBe("irreversible");
        expect(parseSeverity("other")).toBeUndefined();
        expect(parseSeverity(1)).toBeUndefined();
    });
});

describe("incrementStreakSql", () => {
    it("increments the column in SQL rather than a precomputed integer", () => {
        const expr = incrementStreakSql();
        expect(isSqlExpr(expr)).toBe(true);
        expect(containsPrimitive(expr, trustLedger.streak)).toBe(true);
    });
});

describe("PgTrustLedger", () => {
    it("returns undefined when a record is missing", async () => {
        const { db, selects } = createFakeDb({ selectQueue: [[]] });
        const ledger = createPgTrustLedger(db);

        await expect(ledger.get(key)).resolves.toBeUndefined();
        expect(containsPrimitive(selects[0]?.where, USER_ID)).toBe(true);
        expect(containsPrimitive(selects[0]?.where, OTHER_USER_ID)).toBe(false);
        expect(selects[0]?.limit).toBe(1);
    });

    it("upserts an approval as streak = streak + 1 against the unique key", async () => {
        const { db, inserts } = createFakeDb({
            insertReturning: [[trustRow({ streak: 1 })]],
        });
        const ledger = new PgTrustLedger(db, { now: () => NOW, createId: () => "row-1" });

        const record = await ledger.recordApproval(key);

        expect(record.streak).toBe(1);
        expect(record.autonomyGranted).toBe(false);
        expect(inserts).toHaveLength(1);
        expect(inserts[0]?.values).toMatchObject({
            id: "row-1",
            userId: USER_ID,
            playbookId: "inbox-draft",
            capability: "mail.draft",
            severity: "reversible",
            streak: 1,
            autonomyGranted: false,
            updatedAt: NOW,
        });
        expect(inserts[0]?.onConflict?.target).toEqual([...TRUST_CONFLICT_TARGET]);
        expect(isSqlExpr(inserts[0]?.onConflict?.set.streak)).toBe(true);
        expect(containsPrimitive(inserts[0]?.onConflict?.set.streak, trustLedger.streak)).toBe(true);
        expect(typeof inserts[0]?.onConflict?.set.streak).not.toBe("number");
        expect(inserts[0]?.returning).toBe(true);
        void trustLedger.userId;
    });

    it("does not write a JS-computed next streak, so two approvals cannot lose an increment", async () => {
        const { db, inserts } = createFakeDb({
            insertReturning: [[trustRow({ streak: 2 })]],
        });
        const ledger = new PgTrustLedger(db, { now: () => NOW, createId: () => "row-1" });

        await ledger.recordApproval(key);

        const set = inserts[0]?.onConflict?.set ?? {};
        expect(set.streak).not.toBe(2);
        expect(set.streak).not.toBe(1);
        expect(isSqlExpr(set.streak)).toBe(true);
        expect(containsPrimitive(set.streak, trustLedger.streak)).toBe(true);
    });

    it("resets streak on denial and on failure without clearing a grant", async () => {
        const granted = trustRow({ streak: 0, autonomyGranted: true });
        const { db, inserts } = createFakeDb({
            insertReturning: [[granted], [granted]],
        });
        const ledger = new PgTrustLedger(db, { now: () => NOW, createId: () => "row-1" });

        const denied = await ledger.recordDenial(key);
        const failed = await ledger.recordFailure(key);

        expect(denied.streak).toBe(0);
        expect(denied.autonomyGranted).toBe(true);
        expect(failed.autonomyGranted).toBe(true);
        expect(inserts[0]?.onConflict?.set).toMatchObject({ streak: 0, updatedAt: NOW });
        expect(inserts[0]?.onConflict?.set).not.toHaveProperty("autonomyGranted");
        expect(inserts[1]?.onConflict?.set).toMatchObject({ streak: 0 });
        expect(inserts[1]?.onConflict?.set).not.toHaveProperty("autonomyGranted");
    });

    it("grants only with explicit consent and does not accept a boolean", async () => {
        const { db, inserts } = createFakeDb({
            insertReturning: [[trustRow({ streak: 10, autonomyGranted: true })]],
        });
        const ledger = new PgTrustLedger(db, { now: () => NOW, createId: () => "row-1" });

        const granted = await ledger.grantAutonomy(key, consentToGrantAutonomy());
        expect(granted.autonomyGranted).toBe(true);
        expect(inserts[0]?.values.autonomyGranted).toBe(true);
        expect(inserts[0]?.onConflict?.set).toMatchObject({ autonomyGranted: true });

        await expect(ledger.grantAutonomy(key, true as never)).rejects.toThrow(/ExplicitUserConsent/);
        expect(inserts).toHaveLength(1);
    });

    it("throws on irreversible grant without writing a row", async () => {
        const { db, inserts } = createFakeDb();
        const ledger = new PgTrustLedger(db, { now: () => NOW });
        const payKey: TrustKey = { ...key, capability: "payment.send" };

        await expect(ledger.grantAutonomy(payKey, consentToGrantAutonomy())).rejects.toBeInstanceOf(
            AutonomyGrantError,
        );
        expect(inserts).toHaveLength(0);
    });

    it("revokes by clearing streak and the grant together", async () => {
        const { db, inserts } = createFakeDb({
            insertReturning: [[trustRow({ streak: 0, autonomyGranted: false })]],
        });
        const ledger = new PgTrustLedger(db, { now: () => NOW, createId: () => "row-1" });

        const revoked = await ledger.revokeAutonomy(key);
        expect(revoked).toMatchObject({ streak: 0, autonomyGranted: false });
        expect(inserts[0]?.onConflict?.set).toMatchObject({
            streak: 0,
            autonomyGranted: false,
            updatedAt: NOW,
        });
    });

    it("refuses to upsert without a userId", async () => {
        const { db, inserts } = createFakeDb();
        const ledger = new PgTrustLedger(db, { now: () => NOW });

        await expect(ledger.recordApproval({ ...key, userId: "" })).rejects.toThrow(/userId/);
        expect(inserts).toHaveLength(0);
    });

    it("lists only the constructor-bound tenant newest first and skips bad rows", async () => {
        const { db, selects } = createFakeDb({
            selectQueue: [
                [
                    trustRow({ id: "row-2", streak: 3, updatedAt: new Date("2026-09-21T06:00:00.000Z") }),
                    { ...trustRow(), id: "", capability: "mail.draft" },
                ],
            ],
        });
        const ledger = new PgTrustLedger(db, { userId: USER_ID });

        await expect(ledger.list()).resolves.toEqual([
            {
                id: "row-2",
                userId: USER_ID,
                playbookId: "inbox-draft",
                capability: "mail.draft",
                severity: "reversible",
                streak: 3,
                autonomyGranted: false,
                updatedAt: "2026-09-21T06:00:00.000Z",
            },
        ]);
        expect(selects).toHaveLength(1);
        expect(containsPrimitive(selects[0]?.where, USER_ID)).toBe(true);
        expect(containsPrimitive(selects[0]?.where, OTHER_USER_ID)).toBe(false);
        expect(selects[0]?.orderBy).toBeDefined();
        expect(selects[0]?.limit).toBeUndefined();
        void trustLedger.updatedAt;
    });

    it("refuses to list without a bound tenant rather than returning every user's rows", async () => {
        const { db, selects } = createFakeDb();
        const ledger = new PgTrustLedger(db);

        await expect(ledger.list()).rejects.toThrow(/userId/);
        expect(selects).toHaveLength(0);
    });
});
