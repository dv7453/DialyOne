import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { access } from "node:fs/promises";

import { getTableName } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { authSessions, loginTokens } from "./auth-schema.js";
import {
    CREDENTIAL_EXPORT_COLUMNS,
    LOGIN_TOKEN_EXPORT_COLUMNS,
    PgAccountData,
    SESSION_EXPORT_COLUMNS,
    USER_FILESYSTEM_DIR,
    USER_ID_CASCADE_TABLES,
    createPgAccountData,
    describeUserIdForeignKeys,
    eraseUserFilesystem,
    exportTableNames,
    parseCredentialExportRow,
    parseLoginTokenExportRow,
    parseProfileRow,
    parseSessionExportRow,
    requireAccountUserId,
    tablesWithoutUserIdCascade,
    userFilesystemRoot,
} from "./account-data.js";
import type { Database } from "./client.js";
import {
    actionQueue,
    agentTasks,
    approvals,
    credentials,
    journal,
    openLoops,
    schedulerState,
    spendLedger,
    trustLedger,
    users,
} from "./schema.js";

const USER_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_USER_ID = "22222222-2222-4222-8222-222222222222";
const NOW = new Date("2026-09-21T12:00:00.000Z");

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
    columns?: unknown;
    from?: unknown;
    where?: unknown;
    limit?: number;
};

type DeleteCall = {
    from?: unknown;
    where?: unknown;
    returning: boolean;
};

function tableNameOf(table: unknown): string {
    try {
        return getTableName(table as Parameters<typeof getTableName>[0]);
    } catch {
        return "";
    }
}

function createFakeDb(options: {
    rowsByTable?: Record<string, Record<string, unknown>[]>;
    deleteRowsByTable?: Record<string, Record<string, unknown>[]>;
} = {}) {
    const rowsByTable = { ...(options.rowsByTable ?? {}) };
    const deleteRowsByTable = { ...(options.deleteRowsByTable ?? {}) };
    const selects: SelectMeta[] = [];
    const deletes: DeleteCall[] = [];
    const stats = { transactionCount: 0 };

    const api = {
        select(columns?: unknown) {
            const meta: SelectMeta = { columns };
            let consumed = false;
            const consume = () => {
                if (!consumed) {
                    consumed = true;
                    selects.push(meta);
                }
                const name = tableNameOf(meta.from);
                return Promise.resolve(rowsByTable[name] ?? []);
            };
            const chain = {
                from(table: unknown) {
                    meta.from = table;
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
        delete(table?: unknown) {
            return {
                where(where: unknown) {
                    const call: DeleteCall = { from: table, where, returning: false };
                    deletes.push(call);
                    const rows = deleteRowsByTable[tableNameOf(table)] ?? [];
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
        transaction(fn: (tx: unknown) => Promise<unknown>) {
            stats.transactionCount += 1;
            return fn(api);
        },
    };

    return { db: api as unknown as Database, selects, deletes, stats };
}

describe("requireAccountUserId", () => {
    it("rejects missing tenant ids instead of inventing a default", () => {
        expect(() => requireAccountUserId("")).toThrow(/userId/);
        expect(() => userFilesystemRoot("/tmp", "")).toThrow(/userId/);
    });
});

describe("userId foreign keys", () => {
    it("cascades from every tenant table; only users itself has no user_id FK", () => {
        const report = describeUserIdForeignKeys();
        expect(report.map((row) => row.table).sort()).toEqual(
            [
                "credentials",
                "approvals",
                "journal",
                "trust_ledger",
                "open_loops",
                "agent_tasks",
                "scheduler_state",
                "action_queue",
                "spend_ledger",
                "auth_sessions",
                "login_tokens",
            ].sort(),
        );
        expect(tablesWithoutUserIdCascade()).toEqual([]);
        expect(report.find((row) => row.table === "scheduler_state")?.nullable).toBe(true);
        expect(USER_ID_CASCADE_TABLES).toHaveLength(11);
        void users.id;
    });
});

describe("parse export rows", () => {
    it("drops credential ciphertext and auth token hashes", () => {
        expect(
            parseCredentialExportRow({
                id: "c1",
                provider: "gmail",
                createdAt: NOW,
                updatedAt: NOW,
                encryptedPayload: "secret",
            }),
        ).toBeUndefined();
        expect(
            parseCredentialExportRow({
                id: "c1",
                provider: "gmail",
                createdAt: NOW,
                updatedAt: NOW,
            }),
        ).toEqual({
            id: "c1",
            provider: "gmail",
            createdAt: NOW.toISOString(),
            updatedAt: NOW.toISOString(),
        });
        expect(
            parseSessionExportRow({
                id: "s1",
                createdAt: NOW,
                expiresAt: NOW,
                lastSeenAt: NOW,
                userAgent: "Dialy",
                tokenHash: "abc",
            }),
        ).toBeUndefined();
        expect(
            parseLoginTokenExportRow({
                id: "t1",
                email: "ada@example.com",
                createdAt: NOW,
                expiresAt: NOW,
                consumedAt: null,
                tokenHash: "abc",
            }),
        ).toBeUndefined();
    });

    it("parses a profile and returns undefined for junk", () => {
        expect(
            parseProfileRow({
                id: USER_ID,
                email: "ada@example.com",
                displayName: "Ada",
                locale: "en",
                createdAt: NOW,
                deletedAt: null,
            }),
        ).toEqual({
            id: USER_ID,
            email: "ada@example.com",
            displayName: "Ada",
            locale: "en",
            createdAt: NOW.toISOString(),
            deletedAt: null,
        });
        expect(parseProfileRow({ email: "ada@example.com" })).toBeUndefined();
    });
});

describe("PgAccountData.exportUser", () => {
    it("selects every user-scoped table and omits secrets from the credential projection", async () => {
        const { db, selects } = createFakeDb({
            rowsByTable: {
                users: [
                    {
                        id: USER_ID,
                        email: "ada@example.com",
                        displayName: "Ada",
                        locale: "en",
                        createdAt: NOW,
                        deletedAt: null,
                    },
                ],
                credentials: [
                    {
                        id: "c1",
                        provider: "gmail",
                        createdAt: NOW,
                        updatedAt: NOW,
                    },
                ],
                approvals: [
                    {
                        id: "a1",
                        userId: USER_ID,
                        actionId: "act",
                        playbookId: "pb",
                        capability: "mail.send",
                        args: {},
                        status: "pending",
                        createdAt: NOW,
                    },
                ],
                journal: [{ id: "j1", userId: USER_ID, kind: "outcome", payload: { ok: true }, createdAt: NOW }],
                trust_ledger: [
                    {
                        id: "t1",
                        userId: USER_ID,
                        playbookId: "pb",
                        capability: "mail.draft",
                        severity: "reversible",
                        streak: 3,
                        autonomyGranted: false,
                        updatedAt: NOW,
                    },
                ],
                open_loops: [
                    {
                        id: "o1",
                        userId: USER_ID,
                        intent: "send",
                        knownArgs: {},
                        missingArgs: [],
                        status: "open",
                        createdAt: NOW,
                    },
                ],
                agent_tasks: [
                    {
                        id: "g1",
                        userId: USER_ID,
                        provider: "claude",
                        prompt: "hi",
                        status: "done",
                        createdAt: NOW,
                        updatedAt: NOW,
                    },
                ],
                action_queue: [
                    {
                        id: "q1",
                        userId: USER_ID,
                        capability: "mail.send",
                        actionId: "act",
                        playbookId: "pb",
                        signalId: "sig",
                        args: {},
                        attempts: 1,
                        maxAttempts: 5,
                        nextAttemptAt: NOW,
                        status: "pending",
                        createdAt: NOW,
                        updatedAt: NOW,
                    },
                ],
                scheduler_state: [{ key: "cron:x", userId: USER_ID, lastRunAt: NOW, payload: null }],
                spend_ledger: [
                    {
                        id: "sp1",
                        userId: USER_ID,
                        day: "2026-09-21",
                        reservedNanos: 0n,
                        spentNanos: 5_000_000_000n,
                        reservedUpdatedAt: NOW,
                        createdAt: NOW,
                        updatedAt: NOW,
                    },
                ],
                auth_sessions: [
                    {
                        id: "s1",
                        createdAt: NOW,
                        expiresAt: NOW,
                        lastSeenAt: NOW,
                        userAgent: "Dialy",
                    },
                ],
                login_tokens: [
                    {
                        id: "lt1",
                        email: "ada@example.com",
                        createdAt: NOW,
                        expiresAt: NOW,
                        consumedAt: null,
                    },
                ],
            },
        });
        const store = createPgAccountData(db, { now: () => NOW });
        const exported = await store.exportUser(USER_ID);

        const fromNames = selects.map((select) => tableNameOf(select.from)).sort();
        expect(fromNames).toEqual(exportTableNames().sort());
        expect(exported.profile?.email).toBe("ada@example.com");
        expect(exported.credentials).toEqual([
            {
                id: "c1",
                provider: "gmail",
                createdAt: NOW.toISOString(),
                updatedAt: NOW.toISOString(),
            },
        ]);
        expect(exported.approvals).toHaveLength(1);
        expect(exported.journal).toHaveLength(1);
        expect(exported.trustLedger).toHaveLength(1);
        expect(exported.openLoops).toHaveLength(1);
        expect(exported.agentTasks).toHaveLength(1);
        expect(exported.actionQueue).toHaveLength(1);
        expect(exported.schedulerState).toHaveLength(1);
        expect(exported.spend).toEqual([
            expect.objectContaining({
                day: "2026-09-21",
                reservedNanos: "0",
                spentNanos: "5000000000",
            }),
        ]);
        expect(exported.sessions).toHaveLength(1);
        expect(exported.loginTokens).toHaveLength(1);
        expect(JSON.stringify(exported)).not.toMatch(/encryptedPayload|encrypted_payload|tokenHash|token_hash/);

        const credentialSelect = selects.find((select) => tableNameOf(select.from) === "credentials");
        expect(credentialSelect?.columns).toBe(CREDENTIAL_EXPORT_COLUMNS);
        expect(Object.keys(CREDENTIAL_EXPORT_COLUMNS)).toEqual(["id", "provider", "createdAt", "updatedAt"]);
        expect(SESSION_EXPORT_COLUMNS).not.toHaveProperty("tokenHash");
        expect(LOGIN_TOKEN_EXPORT_COLUMNS).not.toHaveProperty("tokenHash");

        for (const select of selects) {
            if (tableNameOf(select.from) === "users") {
                expect(containsPrimitive(select.where, USER_ID)).toBe(true);
                expect(select.limit).toBe(1);
            } else {
                expect(containsPrimitive(select.where, USER_ID)).toBe(true);
            }
            expect(containsPrimitive(select.where, OTHER_USER_ID)).toBe(false);
        }
        void credentials.encryptedPayload;
        void authSessions.tokenHash;
        void loginTokens.tokenHash;
        void approvals.id;
        void journal.id;
        void trustLedger.id;
        void openLoops.id;
        void agentTasks.id;
        void actionQueue.id;
        void schedulerState.key;
        void spendLedger.id;
    });

    it("is safe to export a user with no rows", async () => {
        const { db } = createFakeDb();
        const store = new PgAccountData(db, { now: () => NOW });
        const exported = await store.exportUser(USER_ID);
        expect(exported.profile).toBeUndefined();
        expect(exported.credentials).toEqual([]);
        expect(exported.sessions).toEqual([]);
        expect(exported.userId).toBe(USER_ID);
    });
});

describe("PgAccountData.deleteUser", () => {
    it("hard-deletes the user after revoking sessions and magic links", async () => {
        const { db, deletes, stats } = createFakeDb({
            deleteRowsByTable: {
                login_tokens: [{ id: "lt1" }, { id: "lt2" }],
                auth_sessions: [{ id: "s1" }],
                users: [{ id: USER_ID }],
            },
        });
        const store = new PgAccountData(db, { now: () => NOW });
        const result = await store.deleteUser(USER_ID);

        expect(stats.transactionCount).toBe(1);
        expect(result).toEqual({
            erased: true,
            revokedSessions: 1,
            revokedLoginTokens: 2,
        });
        expect(deletes.map((call) => tableNameOf(call.from))).toEqual([
            "login_tokens",
            "auth_sessions",
            "users",
        ]);
        expect(deletes.every((call) => call.returning)).toBe(true);
        expect(containsPrimitive(deletes[0]?.where, USER_ID)).toBe(true);
        expect(containsPrimitive(deletes[1]?.where, USER_ID)).toBe(true);
        expect(containsPrimitive(deletes[2]?.where, USER_ID)).toBe(true);
    });

    it("is idempotent when the user is already gone", async () => {
        const { db, deletes } = createFakeDb({
            deleteRowsByTable: {
                login_tokens: [],
                auth_sessions: [],
                users: [],
            },
        });
        const store = new PgAccountData(db);

        const first = await store.deleteUser(USER_ID);
        const second = await store.deleteUser(USER_ID);

        expect(first).toEqual({ erased: false, revokedSessions: 0, revokedLoginTokens: 0 });
        expect(second).toEqual({ erased: false, revokedSessions: 0, revokedLoginTokens: 0 });
        expect(deletes).toHaveLength(6);
    });
});

describe("eraseUserFilesystem", () => {
    it("removes only users/<userId> and is safe to run twice", async () => {
        const workDir = await mkdtemp(path.join(tmpdir(), "dialy-erase-"));
        const root = userFilesystemRoot(workDir, USER_ID);
        await mkdir(root, { recursive: true });
        await writeFile(path.join(root, "note.md"), "personal");
        await mkdir(path.join(workDir, "knowledge"), { recursive: true });
        await writeFile(path.join(workDir, "knowledge", "shared.md"), "lab");

        expect(root).toBe(path.join(workDir, USER_FILESYSTEM_DIR, USER_ID));

        await eraseUserFilesystem(workDir, USER_ID);
        await eraseUserFilesystem(workDir, USER_ID);

        await expect(access(root)).rejects.toThrow();
        await access(path.join(workDir, "knowledge", "shared.md"));
    });
});
