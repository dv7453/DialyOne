import path from "node:path";

import { createPgActionQueue, type PgActionQueueOptions } from "../db/action-queue-store.js";
import { createPgApprovalsStore } from "../db/approvals-store.js";
import { getDb, getSql, type Database } from "../db/client.js";
import { createPgJournalWriter } from "../db/journal-store.js";
import { PgSchedulerStateStore } from "../db/scheduler-store.js";
import { PgTickLock, type TickLockSql } from "../db/tick-lock.js";
import { WorkDir } from "../config/config.js";
import { InMemoryActionQueue, type ActionQueue } from "../operator/action-queue.js";
import { FileApprovalsStore, type ApprovalExpiryStore } from "../operator/approvals.js";
import { Journal, type JournalWriter } from "../operator/journal.js";
import {
    InMemorySchedulerStateStore,
    NoopTickLock,
    type SchedulerStateStore,
    type TickLock,
} from "../operator/scheduler-state.js";

export type OperatorStoreBackend = "local" | "postgres";

export type OperatorStores = {
    backend: OperatorStoreBackend;
    /** Bound tenant for Postgres stores. Unset on the local (file/memory) path. */
    userId: string | undefined;
    approvals: ApprovalExpiryStore;
    journal: JournalWriter;
    queue: ActionQueue;
    schedulerState: SchedulerStateStore;
    tickLock: TickLock;
};

export type CreateOperatorStoresDeps = {
    getDb?: () => Database;
    getSql?: () => ReturnType<typeof getSql> | TickLockSql;
    workDir?: string;
    queueOptions?: PgActionQueueOptions;
};

export function isPostgresConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
    return Boolean(env.DATABASE_URL);
}

export function requirePostgresTenantUserId(env: NodeJS.ProcessEnv = process.env): string {
    const userId = env.DIALY_DEFAULT_USER_ID;
    if (typeof userId !== "string" || userId === "") {
        throw new Error(
            "DATABASE_URL is set but DIALY_DEFAULT_USER_ID is missing; Postgres stores are tenant-bound and refuse a null tenant",
        );
    }
    return userId;
}

/**
 * Single switch for operator persistence. Postgres when DATABASE_URL is set,
 * otherwise the file/in-memory stores the host used before this wiring.
 */
export function createOperatorStores(
    env: NodeJS.ProcessEnv = process.env,
    deps: CreateOperatorStoresDeps = {},
): OperatorStores {
    if (!isPostgresConfigured(env)) {
        const workDir = deps.workDir ?? WorkDir;
        return {
            backend: "local",
            userId: undefined,
            approvals: new FileApprovalsStore(path.join(workDir, "storage", "approvals.json")),
            journal: new Journal(path.join(workDir, "logs", "operator.jsonl")),
            queue: new InMemoryActionQueue(),
            schedulerState: new InMemorySchedulerStateStore(),
            tickLock: new NoopTickLock(),
        };
    }

    const userId = requirePostgresTenantUserId(env);
    const db = (deps.getDb ?? getDb)();
    const sql = (deps.getSql ?? getSql)();
    return {
        backend: "postgres",
        userId,
        approvals: createPgApprovalsStore(db, userId),
        journal: createPgJournalWriter(db, userId),
        queue: createPgActionQueue(db, userId, deps.queueOptions),
        schedulerState: new PgSchedulerStateStore(db),
        tickLock: new PgTickLock(sql),
    };
}
