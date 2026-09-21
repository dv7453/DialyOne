import { describe, expect, it } from "vitest";

import type { JournalEntry } from "../operator/types.js";
import type { Database } from "./client.js";
import { journal } from "./schema.js";
import {
    PgJournalWriter,
    createPgJournalWriter,
    dateToIso,
    isoToDate,
    parseJournalRow,
    requireBoundUserId,
} from "./journal-store.js";

const USER_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_USER_ID = "22222222-2222-4222-8222-222222222222";

const entry: JournalEntry = {
    ts: "2026-08-30T10:00:30.123Z",
    kind: "outcome",
    playbookId: "deploy-sentinel",
    signalId: "sig-1",
    data: { status: "executed", capability: "deploy.restart" },
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
};

function createFakeDb(options: { selectQueue?: Record<string, unknown>[][] } = {}) {
    const selectQueue = [...(options.selectQueue ?? [])];
    const inserts: Record<string, unknown>[] = [];
    const selects: SelectMeta[] = [];

    const nextSelect = () => (selectQueue.length > 0 ? selectQueue.shift()! : []);

    const api = {
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
                    return consume();
                },
                then(onFulfilled: (value: Record<string, unknown>[]) => unknown, onRejected?: (reason: unknown) => unknown) {
                    return consume().then(onFulfilled, onRejected);
                },
            };
            return chain;
        },
    };

    return { db: api as unknown as Database, inserts, selects };
}

describe("requireBoundUserId", () => {
    it("rejects missing tenant ids instead of falling back", () => {
        expect(() => requireBoundUserId("")).toThrow(/bound userId/);
        expect(() => new PgJournalWriter(createFakeDb().db, "")).toThrow(/bound userId/);
    });
});

describe("isoToDate / dateToIso", () => {
    it("round-trips millisecond timestamps without converting through seconds", () => {
        for (const iso of ["1970-01-01T00:00:00.000Z", "2026-01-01T08:00:30.123Z", entry.ts]) {
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
        expect(dateToIso({})).toBeUndefined();
    });
});

describe("parseJournalRow", () => {
    it("maps createdAt back onto ts and payload onto data", () => {
        expect(
            parseJournalRow({
                id: "j-1",
                userId: USER_ID,
                kind: "outcome",
                playbookId: "deploy-sentinel",
                signalId: "sig-1",
                payload: { status: "executed" },
                createdAt: new Date("2026-08-30T10:00:30.123Z"),
            }),
        ).toEqual({
            ts: "2026-08-30T10:00:30.123Z",
            kind: "outcome",
            playbookId: "deploy-sentinel",
            signalId: "sig-1",
            data: { status: "executed" },
        });
    });

    it("returns undefined for malformed rows instead of throwing", () => {
        expect(parseJournalRow(undefined)).toBeUndefined();
        expect(parseJournalRow(null)).toBeUndefined();
        expect(parseJournalRow([])).toBeUndefined();
        expect(parseJournalRow({ kind: "outcome", payload: {}, createdAt: "nope" })).toBeUndefined();
        expect(parseJournalRow({ kind: "not-a-kind", payload: {}, createdAt: new Date() })).toBeUndefined();
        expect(parseJournalRow({ kind: "outcome", payload: "nope", createdAt: new Date() })).toBeUndefined();
        expect(parseJournalRow({ kind: "outcome", payload: {}, createdAt: new Date(), playbookId: 1 })).toBeUndefined();
    });
});

describe("PgJournalWriter", () => {
    it("persists the caller's ts as createdAt and stamps the bound userId", async () => {
        const { db, inserts } = createFakeDb();
        const writer = createPgJournalWriter(db, USER_ID);

        await writer.append(entry);

        expect(inserts).toHaveLength(1);
        expect(inserts[0]).toEqual({
            userId: USER_ID,
            kind: "outcome",
            playbookId: "deploy-sentinel",
            signalId: "sig-1",
            payload: { status: "executed", capability: "deploy.restart" },
            createdAt: new Date("2026-08-30T10:00:30.123Z"),
        });
        expect(inserts[0]?.userId).not.toBe(OTHER_USER_ID);
        expect(inserts[0]?.createdAt).toEqual(isoToDate(entry.ts));
        void journal.userId;
    });

    it("reads with the (userId, createdAt) index order and skips bad rows", async () => {
        const { db, selects } = createFakeDb({
            selectQueue: [
                [
                    {
                        kind: "outcome",
                        playbookId: "deploy-sentinel",
                        signalId: "sig-1",
                        payload: { ok: true },
                        createdAt: new Date("2026-08-30T10:00:30.123Z"),
                    },
                    { kind: "outcome", payload: "bad", createdAt: new Date() },
                ],
            ],
        });
        const writer = new PgJournalWriter(db, USER_ID);

        await expect(writer.readAll()).resolves.toEqual([
            {
                ts: "2026-08-30T10:00:30.123Z",
                kind: "outcome",
                playbookId: "deploy-sentinel",
                signalId: "sig-1",
                data: { ok: true },
            },
        ]);
        expect(selects).toHaveLength(1);
        expect(containsPrimitive(selects[0]?.where, USER_ID)).toBe(true);
        expect(selects[0]?.orderBy).toBeDefined();
    });

    it("refuses to append an unparseable audit timestamp rather than using the database clock", async () => {
        const { db, inserts } = createFakeDb();
        const writer = new PgJournalWriter(db, USER_ID);

        await expect(
            writer.append({
                ts: "whenever",
                kind: "outcome",
                data: {},
            }),
        ).rejects.toThrow(/parseable timestamp/);
        expect(inserts).toHaveLength(0);
    });

    it("lists newest first for the bound tenant only, skipping bad rows", async () => {
        const { db, selects } = createFakeDb({
            selectQueue: [
                [
                    {
                        kind: "outcome",
                        playbookId: "inbox",
                        signalId: "sig-2",
                        payload: { n: 2 },
                        createdAt: new Date("2026-08-30T11:00:00.000Z"),
                    },
                    { kind: "outcome", payload: "bad", createdAt: new Date() },
                    {
                        kind: "outcome",
                        playbookId: "inbox",
                        signalId: "sig-1",
                        payload: { n: 1 },
                        createdAt: new Date("2026-08-30T10:00:00.000Z"),
                    },
                ],
            ],
        });
        const writer = new PgJournalWriter(db, USER_ID);

        await expect(writer.list(40)).resolves.toEqual([
            {
                ts: "2026-08-30T11:00:00.000Z",
                kind: "outcome",
                playbookId: "inbox",
                signalId: "sig-2",
                data: { n: 2 },
            },
            {
                ts: "2026-08-30T10:00:00.000Z",
                kind: "outcome",
                playbookId: "inbox",
                signalId: "sig-1",
                data: { n: 1 },
            },
        ]);
        expect(selects).toHaveLength(1);
        expect(containsPrimitive(selects[0]?.where, USER_ID)).toBe(true);
        expect(containsPrimitive(selects[0]?.where, OTHER_USER_ID)).toBe(false);
        expect(selects[0]?.orderBy).toBeDefined();
        expect(selects[0]?.limit).toBe(40);
    });

    it("does not query when the list limit is zero", async () => {
        const { db, selects } = createFakeDb();
        const writer = new PgJournalWriter(db, USER_ID);
        await expect(writer.list(0)).resolves.toEqual([]);
        expect(selects).toHaveLength(0);
    });
});
