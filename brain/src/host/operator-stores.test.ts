import os from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import { PgActionQueue } from "../db/action-queue-store.js";
import { PgApprovalsStore } from "../db/approvals-store.js";
import type { Database } from "../db/client.js";
import { PgJournalWriter } from "../db/journal-store.js";
import { PgSchedulerStateStore } from "../db/scheduler-store.js";
import { PgTickLock, type TickLockSql } from "../db/tick-lock.js";
import { InMemoryActionQueue } from "../operator/action-queue.js";
import { FileApprovalsStore } from "../operator/approvals.js";
import { Journal } from "../operator/journal.js";
import { InMemorySchedulerStateStore, NoopTickLock } from "../operator/scheduler-state.js";
import { createOperatorStores, isPostgresConfigured, requirePostgresTenantUserId } from "./operator-stores.js";

function env(values: Record<string, string | undefined>): NodeJS.ProcessEnv {
    return { ...values };
}

describe("createOperatorStores", () => {
    it("uses file and memory stores when DATABASE_URL is unset", () => {
        const getDb = vi.fn(() => {
            throw new Error("getDb must not be called without DATABASE_URL");
        });
        const getSql = vi.fn(() => {
            throw new Error("getSql must not be called without DATABASE_URL");
        });
        const workDir = path.join(os.tmpdir(), `dialy-stores-${process.pid}`);
        const stores = createOperatorStores(env({}), { getDb, getSql, workDir });

        expect(isPostgresConfigured(env({}))).toBe(false);
        expect(stores.backend).toBe("local");
        expect(stores.userId).toBeUndefined();
        expect(stores.approvals).toBeInstanceOf(FileApprovalsStore);
        expect(stores.journal).toBeInstanceOf(Journal);
        expect(stores.queue).toBeInstanceOf(InMemoryActionQueue);
        expect(stores.schedulerState).toBeInstanceOf(InMemorySchedulerStateStore);
        expect(stores.tickLock).toBeInstanceOf(NoopTickLock);
        expect(getDb).not.toHaveBeenCalled();
        expect(getSql).not.toHaveBeenCalled();
    });

    it("uses Postgres stores bound to DIALY_DEFAULT_USER_ID when DATABASE_URL is set", () => {
        const db = { kind: "drizzle" } as unknown as Database;
        const sql = { kind: "postgres-js" } as unknown as TickLockSql;
        const getDb = vi.fn(() => db);
        const getSql = vi.fn(() => sql);

        const stores = createOperatorStores(
            env({ DATABASE_URL: "postgres://localhost/dialy", DIALY_DEFAULT_USER_ID: "user-ca" }),
            { getDb, getSql },
        );

        expect(stores.backend).toBe("postgres");
        expect(stores.userId).toBe("user-ca");
        expect(stores.approvals).toBeInstanceOf(PgApprovalsStore);
        expect(stores.journal).toBeInstanceOf(PgJournalWriter);
        expect(stores.queue).toBeInstanceOf(PgActionQueue);
        expect(stores.schedulerState).toBeInstanceOf(PgSchedulerStateStore);
        expect(stores.tickLock).toBeInstanceOf(PgTickLock);
        expect(getDb).toHaveBeenCalledOnce();
        expect(getSql).toHaveBeenCalledOnce();
    });

    it("refuses Postgres without a bound tenant userId", () => {
        expect(() =>
            createOperatorStores(env({ DATABASE_URL: "postgres://localhost/dialy" }), {
                getDb: () => {
                    throw new Error("getDb should not run");
                },
            }),
        ).toThrow(/DIALY_DEFAULT_USER_ID/);
        expect(() => requirePostgresTenantUserId(env({ DATABASE_URL: "postgres://localhost/dialy" }))).toThrow(
            /DIALY_DEFAULT_USER_ID/,
        );
    });
});
