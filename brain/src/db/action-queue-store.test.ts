import { describe, expect, it } from "vitest";

import type { Database } from "./client.js";
import { actionQueue } from "./schema.js";
import {
    DEFAULT_CLAIM_LEASE_MS,
    DEFAULT_QUEUE_ATTEMPTS,
    PgActionQueue,
    QUEUE_STATUS_DEAD,
    QUEUE_STATUS_PENDING,
    QUEUE_STATUS_SUCCEEDED,
    ROW_LOCK_STRENGTH,
    SKIP_LOCKED,
    claimDueActionsUnscoped,
    createPgActionQueue,
    dateToIso,
    isoToDate,
    parseQueuedActionRow,
    requireBoundUserId,
    requireUnscopedClaimLimit,
} from "./action-queue-store.js";

const USER_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_USER_ID = "22222222-2222-4222-8222-222222222222";
const QUEUE_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OTHER_QUEUE_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

const enqueueInput = {
    capability: "mail.send",
    args: { to: "ada@example.com", subject: "hello" },
    maxAttempts: 5,
    nextAttemptAt: "2026-08-30T10:00:05.000Z",
    actionId: "act-1",
    playbookId: "inbox-triage",
    signalId: "sig-1",
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

type SelectMeta = {
    where?: unknown;
    orderBy?: unknown;
    limit?: number;
    for?: { strength: string; config?: unknown };
};

type UpdateCall = {
    set: Record<string, unknown>;
    where: unknown;
    returning: boolean;
};

type FakeDbApi = {
    insert(): { values(values: Record<string, unknown>): Promise<void> };
    select(): SelectChain;
    update(): {
        set(set: Record<string, unknown>): {
            where(where: unknown): Promise<Record<string, unknown>[]> & {
                returning(): Promise<Record<string, unknown>[]>;
            };
        };
    };
    transaction(fn: (tx: FakeDbApi) => Promise<unknown>): Promise<unknown>;
};

type SelectChain = {
    from(): SelectChain;
    where(where: unknown): SelectChain;
    orderBy(orderBy: unknown): SelectChain;
    limit(limit: number): SelectChain;
    for(strength: string, config?: unknown): Promise<Record<string, unknown>[]>;
    then(
        onFulfilled: (value: Record<string, unknown>[]) => unknown,
        onRejected?: (reason: unknown) => unknown,
    ): Promise<unknown>;
};

function createFakeDb(options: {
    selectQueue?: Record<string, unknown>[][];
    updateQueue?: Record<string, unknown>[][];
} = {}) {
    const selectQueue = [...(options.selectQueue ?? [])];
    const updateQueue = [...(options.updateQueue ?? [])];
    const inserts: Record<string, unknown>[] = [];
    const updates: UpdateCall[] = [];
    const selects: SelectMeta[] = [];
    const stats = { transactionCount: 0 };

    const nextSelect = () => (selectQueue.length > 0 ? selectQueue.shift()! : []);
    const nextUpdate = () => (updateQueue.length > 0 ? updateQueue.shift()! : []);

    const api: FakeDbApi = {
        insert() {
            return {
                values(values: Record<string, unknown>) {
                    inserts.push(values);
                    return Promise.resolve();
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
                    return chain;
                },
                for(strength: string, config?: unknown) {
                    meta.for = { strength, config };
                    return consume();
                },
                then(onFulfilled: (value: Record<string, unknown>[]) => unknown, onRejected?: (reason: unknown) => unknown) {
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
        transaction(fn: (tx: FakeDbApi) => Promise<unknown>) {
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

function queuedRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
        id: QUEUE_ID,
        userId: USER_ID,
        capability: "mail.send",
        actionId: "act-1",
        playbookId: "inbox-triage",
        signalId: "sig-1",
        args: { to: "ada@example.com", subject: "hello" },
        attempts: 1,
        maxAttempts: 5,
        nextAttemptAt: new Date("2026-08-30T10:00:05.000Z"),
        status: QUEUE_STATUS_PENDING,
        lastError: "HTTP 503",
        ...overrides,
    };
}

describe("requireBoundUserId", () => {
    it("rejects missing tenant ids instead of falling back", () => {
        expect(() => requireBoundUserId("")).toThrow(/bound userId/);
        expect(() => new PgActionQueue(createFakeDb().db, "")).toThrow(/bound userId/);
    });
});

describe("isoToDate / dateToIso", () => {
    it("round-trips millisecond timestamps without converting through seconds", () => {
        for (const iso of ["1970-01-01T00:00:00.001Z", "2026-08-30T10:00:05.000Z", "2026-01-01T08:00:30.123Z"]) {
            const date = isoToDate(iso);
            expect(date).toBeInstanceOf(Date);
            expect(dateToIso(date)).toBe(iso);
            expect(date?.getTime()).toBe(Date.parse(iso));
        }
    });

    it("returns undefined for missing or invalid values", () => {
        expect(isoToDate(undefined)).toBeUndefined();
        expect(isoToDate(null)).toBeUndefined();
        expect(isoToDate(Number.NaN)).toBeUndefined();
        expect(isoToDate(new Date(Number.NaN))).toBeUndefined();
        expect(isoToDate("")).toBeUndefined();
        expect(isoToDate("not-a-date")).toBeUndefined();
        expect(dateToIso("not-a-date")).toBeUndefined();
    });
});

describe("parseQueuedActionRow", () => {
    it("round-trips a well-formed row including millisecond nextAttemptAt", () => {
        expect(parseQueuedActionRow(queuedRow())).toEqual({
            id: QUEUE_ID,
            userId: USER_ID,
            capability: "mail.send",
            args: { to: "ada@example.com", subject: "hello" },
            attempts: 1,
            maxAttempts: 5,
            nextAttemptAt: "2026-08-30T10:00:05.000Z",
            status: QUEUE_STATUS_PENDING,
            lastError: "HTTP 503",
            actionId: "act-1",
            playbookId: "inbox-triage",
            signalId: "sig-1",
        });
    });

    it("returns undefined for malformed rows instead of throwing", () => {
        expect(parseQueuedActionRow(undefined)).toBeUndefined();
        expect(parseQueuedActionRow(null)).toBeUndefined();
        expect(parseQueuedActionRow(queuedRow({ actionId: "" }))).toBeUndefined();
        expect(parseQueuedActionRow(queuedRow({ playbookId: "" }))).toBeUndefined();
        expect(parseQueuedActionRow(queuedRow({ signalId: "" }))).toBeUndefined();
        expect(parseQueuedActionRow(queuedRow({ args: "nope" }))).toBeUndefined();
        expect(parseQueuedActionRow(queuedRow({ status: "running" }))).toBeUndefined();
        expect(parseQueuedActionRow(queuedRow({ attempts: "nope" }))).toBeUndefined();
        expect(parseQueuedActionRow(queuedRow({ nextAttemptAt: "not-a-date" }))).toBeUndefined();
        expect(parseQueuedActionRow(queuedRow({ id: 1 }))).toBeUndefined();
        expect(parseQueuedActionRow(queuedRow({ capability: "" }))).toBeUndefined();
    });
});

describe("PgActionQueue", () => {
    it("writes the bound userId and native identifier columns on every enqueued row", async () => {
        const { db, inserts } = createFakeDb();
        const queue = createPgActionQueue(db, USER_ID, {
            createId: () => QUEUE_ID,
        });

        await queue.enqueue(enqueueInput);

        expect(inserts).toHaveLength(1);
        expect(inserts[0]?.userId).toBe(USER_ID);
        expect(inserts[0]?.capability).toBe("mail.send");
        expect(inserts[0]?.actionId).toBe("act-1");
        expect(inserts[0]?.playbookId).toBe("inbox-triage");
        expect(inserts[0]?.signalId).toBe("sig-1");
        expect(inserts[0]?.attempts).toBe(DEFAULT_QUEUE_ATTEMPTS);
        expect(inserts[0]?.status).toBe(QUEUE_STATUS_PENDING);
        expect(inserts[0]?.args).toEqual({ to: "ada@example.com", subject: "hello" });
        expect(inserts[0]?.nextAttemptAt).toEqual(new Date("2026-08-30T10:00:05.000Z"));
        expect(inserts[0]?.userId).not.toBe(OTHER_USER_ID);
        void actionQueue.userId;
    });

    it("refuses to enqueue under a different tenant id", async () => {
        const { db, inserts } = createFakeDb();
        const queue = new PgActionQueue(db, USER_ID);

        await expect(queue.enqueue({ ...enqueueInput, userId: OTHER_USER_ID })).rejects.toThrow(/bound userId/);
        expect(inserts).toHaveLength(0);
    });

    it("claims due rows with FOR UPDATE SKIP LOCKED inside a transaction", async () => {
        const now = new Date("2026-08-30T10:00:05.000Z");
        const { db, selects, updates, stats } = createFakeDb({
            selectQueue: [[queuedRow()]],
        });
        const queue = new PgActionQueue(db, USER_ID, { now: () => now });

        const due = await queue.listDue(now);

        expect(stats.transactionCount).toBe(1);
        expect(selects).toHaveLength(1);
        expect(selects[0]?.for).toEqual({ strength: ROW_LOCK_STRENGTH, config: SKIP_LOCKED });
        expect(selects[0]?.limit).toBeUndefined();
        expect(containsPrimitive(selects[0]?.where, USER_ID)).toBe(true);
        expect(containsPrimitive(selects[0]?.where, QUEUE_STATUS_PENDING)).toBe(true);
        expect(containsPrimitive(selects[0]?.where, now)).toBe(true);
        expect(updates).toHaveLength(1);
        expect(updates[0]?.set).toEqual({
            nextAttemptAt: new Date(now.getTime() + DEFAULT_CLAIM_LEASE_MS),
        });
        expect(containsPrimitive(updates[0]?.where, USER_ID)).toBe(true);
        expect(containsPrimitive(updates[0]?.where, QUEUE_ID)).toBe(true);
        expect(due).toMatchObject([
            {
                id: QUEUE_ID,
                status: QUEUE_STATUS_PENDING,
                nextAttemptAt: "2026-08-30T10:00:05.000Z",
                userId: USER_ID,
                actionId: "act-1",
            },
        ]);
    });

    it("does not lease when nothing is due", async () => {
        const { db, updates, stats } = createFakeDb({ selectQueue: [[]] });
        const queue = new PgActionQueue(db, USER_ID);

        await expect(queue.listDue(new Date("2026-08-30T10:00:05.000Z"))).resolves.toEqual([]);
        expect(stats.transactionCount).toBe(1);
        expect(updates).toHaveLength(0);
    });

    it("skips malformed due rows instead of throwing", async () => {
        const { db, updates } = createFakeDb({
            selectQueue: [[{ id: "bad", args: { to: "ada@example.com" }, status: QUEUE_STATUS_PENDING }]],
        });
        const queue = new PgActionQueue(db, USER_ID);

        await expect(queue.listDue(new Date("2026-08-30T10:00:05.000Z"))).resolves.toEqual([]);
        expect(updates).toHaveLength(0);
    });

    it("scopes get/markSucceeded to the bound userId", async () => {
        const succeeded = queuedRow({ status: QUEUE_STATUS_SUCCEEDED, lastError: undefined });
        const { db, selects, updates } = createFakeDb({
            selectQueue: [[queuedRow()]],
            updateQueue: [[succeeded]],
        });
        const queue = new PgActionQueue(db, USER_ID);

        await expect(queue.get(QUEUE_ID)).resolves.toMatchObject({
            id: QUEUE_ID,
            userId: USER_ID,
        });
        await expect(queue.markSucceeded(QUEUE_ID)).resolves.toMatchObject({
            status: QUEUE_STATUS_SUCCEEDED,
        });
        expect(containsPrimitive(selects[0]?.where, USER_ID)).toBe(true);
        expect(updates[0]?.set).toEqual({ status: QUEUE_STATUS_SUCCEEDED });
        expect(containsPrimitive(updates[0]?.where, USER_ID)).toBe(true);
    });

    it("marks dead and reschedules only pending rows for the bound user", async () => {
        const dead = queuedRow({ status: QUEUE_STATUS_DEAD, lastError: "HTTP 401" });
        const rescheduled = queuedRow({
            attempts: 2,
            nextAttemptAt: new Date("2026-08-30T10:00:09.000Z"),
            lastError: "HTTP 502",
        });
        const { db, updates } = createFakeDb({
            updateQueue: [[dead], [rescheduled]],
        });
        const queue = new PgActionQueue(db, USER_ID);

        await expect(queue.markDead(QUEUE_ID, "HTTP 401")).resolves.toMatchObject({
            status: QUEUE_STATUS_DEAD,
            lastError: "HTTP 401",
        });
        await expect(
            queue.reschedule(QUEUE_ID, {
                attempts: 2,
                nextAttemptAt: "2026-08-30T10:00:09.000Z",
                lastError: "HTTP 502",
            }),
        ).resolves.toMatchObject({
            attempts: 2,
            nextAttemptAt: "2026-08-30T10:00:09.000Z",
        });
        expect(updates[0]?.set).toEqual({ status: QUEUE_STATUS_DEAD, lastError: "HTTP 401" });
        expect(updates[1]?.set.nextAttemptAt).toEqual(new Date("2026-08-30T10:00:09.000Z"));
        expect(containsPrimitive(updates[1]?.where, QUEUE_STATUS_PENDING)).toBe(true);
        expect(containsPrimitive(updates[1]?.where, USER_ID)).toBe(true);
    });

    it("does not expose an unscoped claim method on the tenant-bound store", () => {
        expect(Object.prototype.hasOwnProperty.call(PgActionQueue.prototype, "claimDueActionsUnscoped")).toBe(false);
        expect(Object.prototype.hasOwnProperty.call(PgActionQueue.prototype, "listDueUnscoped")).toBe(false);
    });
});

describe("claimDueActionsUnscoped", () => {
    it("rejects a missing or non-positive batch limit", () => {
        expect(() => requireUnscopedClaimLimit(0)).toThrow(/positive integer limit/);
        expect(() => requireUnscopedClaimLimit(-1)).toThrow(/positive integer limit/);
        expect(() => requireUnscopedClaimLimit(1.5)).toThrow(/positive integer limit/);
    });

    it("claims due rows across tenants with FOR UPDATE SKIP LOCKED and a batch limit", async () => {
        const now = new Date("2026-08-30T10:00:05.000Z");
        const other = queuedRow({
            id: OTHER_QUEUE_ID,
            userId: OTHER_USER_ID,
            actionId: "act-2",
        });
        const { db, selects, updates, stats } = createFakeDb({
            selectQueue: [[queuedRow(), other]],
        });

        const due = await claimDueActionsUnscoped(db, { now, limit: 25 });

        expect(stats.transactionCount).toBe(1);
        expect(selects).toHaveLength(1);
        expect(selects[0]?.for).toEqual({ strength: ROW_LOCK_STRENGTH, config: SKIP_LOCKED });
        expect(selects[0]?.limit).toBe(25);
        expect(containsPrimitive(selects[0]?.where, USER_ID)).toBe(false);
        expect(containsPrimitive(selects[0]?.where, OTHER_USER_ID)).toBe(false);
        expect(containsPrimitive(selects[0]?.where, QUEUE_STATUS_PENDING)).toBe(true);
        expect(containsPrimitive(selects[0]?.where, now)).toBe(true);
        expect(updates).toHaveLength(1);
        expect(updates[0]?.set).toEqual({
            nextAttemptAt: new Date(now.getTime() + DEFAULT_CLAIM_LEASE_MS),
        });
        expect(containsPrimitive(updates[0]?.where, USER_ID)).toBe(false);
        expect(containsPrimitive(updates[0]?.where, QUEUE_ID)).toBe(true);
        expect(containsPrimitive(updates[0]?.where, OTHER_QUEUE_ID)).toBe(true);
        expect(due).toEqual([
            {
                id: QUEUE_ID,
                userId: USER_ID,
                capability: "mail.send",
                args: { to: "ada@example.com", subject: "hello" },
                attempts: 1,
                maxAttempts: 5,
                nextAttemptAt: "2026-08-30T10:00:05.000Z",
                status: QUEUE_STATUS_PENDING,
                lastError: "HTTP 503",
                actionId: "act-1",
                playbookId: "inbox-triage",
                signalId: "sig-1",
            },
            {
                id: OTHER_QUEUE_ID,
                userId: OTHER_USER_ID,
                capability: "mail.send",
                args: { to: "ada@example.com", subject: "hello" },
                attempts: 1,
                maxAttempts: 5,
                nextAttemptAt: "2026-08-30T10:00:05.000Z",
                status: QUEUE_STATUS_PENDING,
                lastError: "HTTP 503",
                actionId: "act-2",
                playbookId: "inbox-triage",
                signalId: "sig-1",
            },
        ]);
    });

    it("throws before querying when the batch limit is invalid", async () => {
        const { db, selects, stats } = createFakeDb();
        await expect(claimDueActionsUnscoped(db, { limit: 0 })).rejects.toThrow(/positive integer limit/);
        expect(stats.transactionCount).toBe(0);
        expect(selects).toHaveLength(0);
    });
});
