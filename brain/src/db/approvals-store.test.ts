import { describe, expect, it } from "vitest";

import type { Database } from "./client.js";
import { approvals } from "./schema.js";
import { TURN_ROUTE_ARG } from "../operator/approvals.js";
import {
    APPROVAL_STATUS_APPROVED,
    APPROVAL_STATUS_DENIED,
    APPROVAL_STATUS_EXPIRED,
    APPROVAL_STATUS_PENDING,
    PgApprovalsStore,
    createPgApprovalsStore,
    dateToIso,
    isApprovalExpired,
    isoToDate,
    parseApprovalRow,
    requireBoundUserId,
    statusForResolution,
} from "./approvals-store.js";

const USER_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_USER_ID = "22222222-2222-4222-8222-222222222222";

const approvalInput = {
    actionId: "act-1",
    playbookId: "deploy-sentinel",
    capability: "deploy.restart",
    args: { service: "web" },
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
            return fn(api);
        },
    };

    return { db: api as unknown as Database, inserts, updates, selects };
}

function pendingRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
        id: "approval-1",
        userId: USER_ID,
        actionId: "act-1",
        playbookId: "deploy-sentinel",
        capability: "deploy.restart",
        args: { service: "web" },
        signalId: "sig-1",
        status: APPROVAL_STATUS_PENDING,
        createdAt: new Date("2026-08-30T10:00:00.000Z"),
        expiresAt: null,
        decidedAt: null,
        ...overrides,
    };
}

describe("requireBoundUserId", () => {
    it("rejects missing tenant ids instead of falling back", () => {
        expect(() => requireBoundUserId("")).toThrow(/bound userId/);
        expect(() => new PgApprovalsStore(createFakeDb().db, "")).toThrow(/bound userId/);
    });
});

describe("isoToDate / dateToIso", () => {
    it("round-trips millisecond timestamps without converting through seconds", () => {
        for (const iso of ["1970-01-01T00:00:00.000Z", "2026-01-01T08:00:30.123Z", "2026-08-30T10:00:05.001Z"]) {
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
        expect(isoToDate({})).toBeUndefined();
        expect(isoToDate("")).toBeUndefined();
        expect(isoToDate("not-a-date")).toBeUndefined();
        expect(dateToIso(undefined)).toBeUndefined();
        expect(dateToIso("not-a-date")).toBeUndefined();
    });
});

describe("parseApprovalRow", () => {
    it("maps columns including decidedAt back to resolvedAt", () => {
        expect(
            parseApprovalRow({
                ...pendingRow({
                    status: APPROVAL_STATUS_APPROVED,
                    decidedAt: new Date("2026-08-30T10:01:00.123Z"),
                }),
            }),
        ).toEqual({
            id: "approval-1",
            actionId: "act-1",
            playbookId: "deploy-sentinel",
            capability: "deploy.restart",
            args: { service: "web" },
            signalId: "sig-1",
            status: APPROVAL_STATUS_APPROVED,
            createdAt: "2026-08-30T10:00:00.000Z",
            resolvedAt: "2026-08-30T10:01:00.123Z",
        });
    });

    it("lifts turn routing out of args so capability preview stays clean", () => {
        expect(
            parseApprovalRow(
                pendingRow({
                    args: {
                        service: "web",
                        [TURN_ROUTE_ARG]: { sessionId: "session-1", turnId: "turn-1", toolCallId: "tc-1" },
                    },
                }),
            ),
        ).toEqual({
            id: "approval-1",
            actionId: "act-1",
            playbookId: "deploy-sentinel",
            capability: "deploy.restart",
            args: { service: "web" },
            signalId: "sig-1",
            status: APPROVAL_STATUS_PENDING,
            createdAt: "2026-08-30T10:00:00.000Z",
            sessionId: "session-1",
            turnId: "turn-1",
            toolCallId: "tc-1",
        });
    });

    it("reads expiresAt from the column, not from args jsonb", () => {
        expect(
            parseApprovalRow(
                pendingRow({
                    expiresAt: new Date("2026-08-30T11:00:00.000Z"),
                    args: { service: "web" },
                }),
            )?.expiresAt,
        ).toBe("2026-08-30T11:00:00.000Z");
    });

    it("returns undefined for malformed rows instead of throwing", () => {
        expect(parseApprovalRow(undefined)).toBeUndefined();
        expect(parseApprovalRow(null)).toBeUndefined();
        expect(parseApprovalRow("row")).toBeUndefined();
        expect(parseApprovalRow(pendingRow({ playbookId: "" }))).toBeUndefined();
        expect(parseApprovalRow(pendingRow({ args: "nope" }))).toBeUndefined();
        expect(parseApprovalRow(pendingRow({ status: "running" }))).toBeUndefined();
        expect(parseApprovalRow(pendingRow({ createdAt: "not-a-date" }))).toBeUndefined();
        expect(parseApprovalRow(pendingRow({ id: 1 }))).toBeUndefined();
        expect(parseApprovalRow(pendingRow({ expiresAt: "not-a-date" }))).toBeUndefined();
    });
});

describe("isApprovalExpired / statusForResolution", () => {
    it("treats expiresAt equal to now as expired, matching FileApprovalsStore", () => {
        const now = "2026-08-30T10:00:00.000Z";
        const record = parseApprovalRow(pendingRow({ expiresAt: new Date(now) }))!;
        expect(isApprovalExpired(record, now)).toBe(true);
        expect(isApprovalExpired(record, "2026-08-30T09:59:59.999Z")).toBe(false);
        expect(statusForResolution("approve")).toBe(APPROVAL_STATUS_APPROVED);
        expect(statusForResolution("deny")).toBe(APPROVAL_STATUS_DENIED);
    });
});

describe("PgApprovalsStore", () => {
    it("writes the bound userId and native columns on every created row", async () => {
        const { db, inserts } = createFakeDb();
        const store = createPgApprovalsStore(db, USER_ID, {
            createId: () => "approval-1",
            now: () => "2026-08-30T10:00:00.000Z",
        });

        await store.create(approvalInput);

        expect(inserts).toHaveLength(1);
        expect(inserts[0]?.userId).toBe(USER_ID);
        expect(inserts[0]?.actionId).toBe("act-1");
        expect(inserts[0]?.playbookId).toBe("deploy-sentinel");
        expect(inserts[0]?.capability).toBe("deploy.restart");
        expect(inserts[0]?.signalId).toBe("sig-1");
        expect(inserts[0]?.status).toBe(APPROVAL_STATUS_PENDING);
        expect(inserts[0]?.args).toEqual({ service: "web" });
        expect(inserts[0]?.createdAt).toEqual(new Date("2026-08-30T10:00:00.000Z"));
        // deploy.restart is consequential: 24h, not open-ended. A card with no
        // expiry would pin its suspended turn open forever.
        expect(inserts[0]?.expiresAt).toEqual(new Date("2026-08-31T10:00:00.000Z"));
    });

    it("packs turn routing into args jsonb without a schema migration", async () => {
        const { db, inserts } = createFakeDb();
        const store = createPgApprovalsStore(db, USER_ID, {
            createId: () => "approval-1",
            now: () => "2026-09-21T06:00:00.000Z",
        });

        const record = await store.create({
            ...approvalInput,
            sessionId: "session-1",
            turnId: "turn-1",
            toolCallId: "tc-1",
        });

        expect(record).toMatchObject({
            sessionId: "session-1",
            turnId: "turn-1",
            toolCallId: "tc-1",
            args: { service: "web" },
        });
        expect(inserts[0]?.args).toEqual({
            service: "web",
            [TURN_ROUTE_ARG]: { sessionId: "session-1", turnId: "turn-1", toolCallId: "tc-1" },
        });
    });

    it("persists expiresAt as a timestamptz column", async () => {
        const { db, inserts } = createFakeDb();
        const store = createPgApprovalsStore(db, USER_ID, {
            createId: () => "approval-1",
            now: () => "2026-08-30T10:00:00.000Z",
        });

        await store.create({ ...approvalInput, expiresAt: "2026-08-30T11:00:00.000Z" });

        expect(inserts[0]?.expiresAt).toEqual(new Date("2026-08-30T11:00:00.000Z"));
        expect(inserts[0]?.args).toEqual({ service: "web" });
    });

    it("scopes reads to the bound userId", async () => {
        const { db, selects } = createFakeDb({ selectQueue: [[pendingRow()]] });
        const store = new PgApprovalsStore(db, USER_ID);

        await store.get("approval-1");

        expect(selects).toHaveLength(1);
        expect(containsPrimitive(selects[0]?.where, USER_ID)).toBe(true);
        expect(containsPrimitive(selects[0]?.where, OTHER_USER_ID)).toBe(false);
        expect(containsPrimitive(selects[0]?.where, "approval-1")).toBe(true);
    });

    it("resolves a pending approval with a conditional pending→decided UPDATE", async () => {
        const decided = pendingRow({
            status: APPROVAL_STATUS_APPROVED,
            decidedAt: new Date("2026-08-30T10:00:00.000Z"),
        });
        const { db, updates } = createFakeDb({
            selectQueue: [[pendingRow()]],
            updateQueue: [[decided]],
        });
        const store = new PgApprovalsStore(db, USER_ID, { now: () => "2026-08-30T10:00:00.000Z" });

        const resolved = await store.resolve("approval-1", "approve");

        expect(resolved).toMatchObject({
            id: "approval-1",
            status: APPROVAL_STATUS_APPROVED,
            resolvedAt: "2026-08-30T10:00:00.000Z",
        });
        expect(updates).toHaveLength(1);
        expect(updates[0]?.set).toEqual({
            status: APPROVAL_STATUS_APPROVED,
            decidedAt: new Date("2026-08-30T10:00:00.000Z"),
        });
        expect(updates[0]?.returning).toBe(true);
        expect(containsPrimitive(updates[0]?.where, USER_ID)).toBe(true);
        expect(containsPrimitive(updates[0]?.where, APPROVAL_STATUS_PENDING)).toBe(true);
        expect(containsPrimitive(updates[0]?.where, "approval-1")).toBe(true);
        expect(updates[0]?.where).toBeTruthy();
        void approvals.id;
    });

    it("returns the existing decision when the same approval is resolved twice", async () => {
        const approved = pendingRow({
            status: APPROVAL_STATUS_APPROVED,
            decidedAt: new Date("2026-08-30T10:00:00.000Z"),
        });
        const { db, updates } = createFakeDb({
            selectQueue: [[approved]],
        });
        const store = new PgApprovalsStore(db, USER_ID, { now: () => "2026-08-30T10:05:00.000Z" });

        const second = await store.resolve("approval-1", "deny");

        expect(second).toMatchObject({
            id: "approval-1",
            status: APPROVAL_STATUS_APPROVED,
            resolvedAt: "2026-08-30T10:00:00.000Z",
        });
        expect(updates).toHaveLength(0);
    });

    it("distinguishes the first pending→approved transition from a second resolve", async () => {
        const decided = pendingRow({
            status: APPROVAL_STATUS_APPROVED,
            decidedAt: new Date("2026-08-30T10:00:00.000Z"),
        });
        const firstDb = createFakeDb({
            selectQueue: [[pendingRow()]],
            updateQueue: [[decided]],
        });
        const firstStore = new PgApprovalsStore(firstDb.db, USER_ID, { now: () => "2026-08-30T10:00:00.000Z" });

        const first = await firstStore.resolveTransition("approval-1", "approve");
        expect(first).toEqual({
            transitioned: true,
            record: {
                id: "approval-1",
                actionId: "act-1",
                playbookId: "deploy-sentinel",
                capability: "deploy.restart",
                args: { service: "web" },
                signalId: "sig-1",
                status: APPROVAL_STATUS_APPROVED,
                createdAt: "2026-08-30T10:00:00.000Z",
                resolvedAt: "2026-08-30T10:00:00.000Z",
            },
        });

        const secondDb = createFakeDb({
            selectQueue: [[decided]],
        });
        const secondStore = new PgApprovalsStore(secondDb.db, USER_ID, { now: () => "2026-08-30T10:05:00.000Z" });
        const second = await secondStore.resolveTransition("approval-1", "deny");

        expect(second?.transitioned).toBe(false);
        expect(second?.record.status).toBe(APPROVAL_STATUS_APPROVED);
        expect(second?.record.resolvedAt).toBe("2026-08-30T10:00:00.000Z");
        expect(secondDb.updates).toHaveLength(0);
        expect(first?.transitioned).not.toBe(second?.transitioned);
    });

    it("treats a lost pending-update race as already resolved, not as a second transition", async () => {
        const approved = pendingRow({
            status: APPROVAL_STATUS_APPROVED,
            decidedAt: new Date("2026-08-30T10:00:00.000Z"),
        });
        const { db, updates } = createFakeDb({
            selectQueue: [[pendingRow()], [approved]],
            updateQueue: [[]],
        });
        const store = new PgApprovalsStore(db, USER_ID, { now: () => "2026-08-30T10:00:01.000Z" });

        const second = await store.resolveTransition("approval-1", "approve");

        expect(second).toMatchObject({
            transitioned: false,
            record: { status: APPROVAL_STATUS_APPROVED, resolvedAt: "2026-08-30T10:00:00.000Z" },
        });
        expect(updates).toHaveLength(1);
        expect(updates[0]?.set.status).toBe(APPROVAL_STATUS_APPROVED);
        expect(second?.record.status).not.toBe(APPROVAL_STATUS_DENIED);
    });

    it("expires a pending approval instead of approving it after expiresAt", async () => {
        const row = pendingRow({ expiresAt: new Date("2026-08-30T09:59:00.000Z") });
        const expired = { ...row, status: APPROVAL_STATUS_EXPIRED };
        const { db, updates } = createFakeDb({
            selectQueue: [[row]],
            updateQueue: [[expired]],
        });
        const store = new PgApprovalsStore(db, USER_ID, { now: () => "2026-08-30T10:00:00.000Z" });

        await expect(store.get("approval-1")).resolves.toMatchObject({ status: APPROVAL_STATUS_EXPIRED });
        // decidedAt is stamped here so the reaper does not later see this as a
        // stranded row it still has to resume.
        expect(updates[0]?.set).toEqual({
            status: APPROVAL_STATUS_EXPIRED,
            decidedAt: new Date("2026-08-30T10:00:00.000Z"),
        });
        expect(containsPrimitive(updates[0]?.where, APPROVAL_STATUS_PENDING)).toBe(true);
    });

    describe("expireDue", () => {
        const NOW = "2026-08-30T10:00:00.000Z";

        it("claims overdue rows with UPDATE ... RETURNING so two brains cannot both reap one card", async () => {
            const overdue = {
                ...pendingRow({ expiresAt: new Date("2026-08-30T09:00:00.000Z") }),
                status: APPROVAL_STATUS_EXPIRED,
                decidedAt: new Date(NOW),
            };
            const { db, updates } = createFakeDb({ updateQueue: [[overdue], []] });
            const store = new PgApprovalsStore(db, USER_ID, { now: () => NOW });

            const reaped = await store.expireDue();

            expect(reaped).toHaveLength(1);
            expect(reaped[0]).toMatchObject({
                id: "approval-1",
                status: APPROVAL_STATUS_EXPIRED,
                resolvedAt: NOW,
            });
            // The claim is the transition itself: scoped to pending, so a second
            // instance running the same statement gets zero rows back.
            expect(updates[0]?.returning).toBe(true);
            expect(updates[0]?.set).toEqual({
                status: APPROVAL_STATUS_EXPIRED,
                decidedAt: new Date(NOW),
            });
            expect(containsPrimitive(updates[0]?.where, APPROVAL_STATUS_PENDING)).toBe(true);
            expect(containsPrimitive(updates[0]?.where, USER_ID)).toBe(true);
        });

        it("returns nothing on a second tick once the rows are already claimed", async () => {
            const { db } = createFakeDb({ updateQueue: [[], []] });
            const store = new PgApprovalsStore(db, USER_ID, { now: () => NOW });

            await expect(store.expireDue()).resolves.toEqual([]);
        });

        it("picks up rows a read path expired without stamping decidedAt", async () => {
            // listPending/get can flip a row to expired. Before decidedAt was
            // stamped those rows had no resolvedAt, so the reaper never saw them
            // and their suspended turns stayed open.
            const stranded = {
                ...pendingRow({ expiresAt: new Date("2026-08-30T09:00:00.000Z") }),
                status: APPROVAL_STATUS_EXPIRED,
                decidedAt: null,
            };
            const { db, updates } = createFakeDb({ updateQueue: [[], [stranded]] });
            const store = new PgApprovalsStore(db, USER_ID, { now: () => NOW });

            const reaped = await store.expireDue();

            expect(reaped).toHaveLength(1);
            expect(reaped[0]?.resolvedAt).toBe(NOW);
            expect(updates[1]?.set).toEqual({ decidedAt: new Date(NOW) });
            expect(containsPrimitive(updates[1]?.where, USER_ID)).toBe(true);
        });

        it("never reaps another tenant's cards", async () => {
            const foreign = {
                ...pendingRow({ expiresAt: new Date("2026-08-30T09:00:00.000Z") }),
                userId: OTHER_USER_ID,
                status: APPROVAL_STATUS_EXPIRED,
                decidedAt: new Date(NOW),
            };
            const { db, updates } = createFakeDb({ updateQueue: [[foreign], []] });
            const store = new PgApprovalsStore(db, USER_ID, { now: () => NOW });

            await store.expireDue();

            for (const call of updates) {
                expect(containsPrimitive(call.where, USER_ID)).toBe(true);
                expect(containsPrimitive(call.where, OTHER_USER_ID)).toBe(false);
            }
        });
    });

    it("does not throw when a stored row cannot be parsed", async () => {
        const { db } = createFakeDb({
            selectQueue: [[{ id: "approval-1", args: { service: "web" } }]],
        });
        const store = new PgApprovalsStore(db, USER_ID);

        await expect(store.get("approval-1")).resolves.toBeUndefined();
    });
});
