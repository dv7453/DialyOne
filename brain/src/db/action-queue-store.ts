import { randomUUID } from "node:crypto";

import { and, asc, eq, inArray, lte } from "drizzle-orm";

import type {
    ActionQueue,
    EnqueueActionInput,
    QueuedAction,
    QueuedActionStatus,
    RescheduleActionInput,
} from "../operator/action-queue.js";
import type { Database } from "./client.js";
import { actionQueue } from "./schema.js";

export const QUEUE_STATUS_PENDING = "pending" as const;
export const QUEUE_STATUS_SUCCEEDED = "succeeded" as const;
export const QUEUE_STATUS_DEAD = "dead" as const;
export const DEFAULT_QUEUE_ATTEMPTS = 1;
export const DEFAULT_CLAIM_LEASE_MS = 5 * 60 * 1000;
export const ROW_LOCK_STRENGTH = "update" as const;
export const SKIP_LOCKED = { skipLocked: true } as const;

const QUEUE_STATUSES = new Set<QueuedActionStatus>([
    QUEUE_STATUS_PENDING,
    QUEUE_STATUS_SUCCEEDED,
    QUEUE_STATUS_DEAD,
]);

export type PgActionQueueOptions = {
    createId?: () => string;
    now?: () => Date;
    claimLeaseMs?: number;
};

export function requireBoundUserId(userId: string): string {
    if (typeof userId !== "string" || userId === "") {
        throw new Error("PgActionQueue requires a bound userId; refusing unscoped access");
    }
    return userId;
}

export function createPgActionQueue(
    db: Database,
    userId: string,
    options?: PgActionQueueOptions,
): PgActionQueue {
    return new PgActionQueue(db, userId, options);
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

export function dateToIso(value: unknown): string | undefined {
    const date = value instanceof Date ? value : isoToDate(value);
    if (!date) {
        return undefined;
    }
    const ms = date.getTime();
    return Number.isFinite(ms) ? date.toISOString() : undefined;
}

function parseCapabilityArgs(payload: unknown): Record<string, unknown> | undefined {
    if (payload == null) {
        return {};
    }
    if (typeof payload !== "object" || Array.isArray(payload)) {
        return undefined;
    }
    return payload as Record<string, unknown>;
}

function parseFiniteInt(value: unknown): number | undefined {
    if (typeof value === "number" && Number.isFinite(value) && Number.isInteger(value)) {
        return value;
    }
    if (typeof value === "string" && value !== "") {
        const n = Number(value);
        if (Number.isFinite(n) && Number.isInteger(n)) {
            return n;
        }
    }
    return undefined;
}

export function parseQueuedActionRow(row: unknown): QueuedAction | undefined {
    if (row == null || typeof row !== "object" || Array.isArray(row)) {
        return undefined;
    }
    const rec = row as Record<string, unknown>;
    if (typeof rec.id !== "string" || rec.id === "") {
        return undefined;
    }
    if (typeof rec.capability !== "string" || rec.capability === "") {
        return undefined;
    }
    if (typeof rec.actionId !== "string" || rec.actionId === "") {
        return undefined;
    }
    if (typeof rec.playbookId !== "string" || rec.playbookId === "") {
        return undefined;
    }
    if (typeof rec.signalId !== "string" || rec.signalId === "") {
        return undefined;
    }
    if (typeof rec.status !== "string" || !QUEUE_STATUSES.has(rec.status as QueuedActionStatus)) {
        return undefined;
    }
    const args = parseCapabilityArgs(rec.args);
    const attempts = parseFiniteInt(rec.attempts);
    const maxAttempts = parseFiniteInt(rec.maxAttempts);
    const nextAttemptAt = dateToIso(rec.nextAttemptAt);
    if (args === undefined || attempts === undefined || maxAttempts === undefined || !nextAttemptAt) {
        return undefined;
    }
    const record: QueuedAction = {
        id: rec.id,
        capability: rec.capability,
        args: { ...args },
        attempts,
        maxAttempts,
        nextAttemptAt,
        status: rec.status as QueuedActionStatus,
        actionId: rec.actionId,
        playbookId: rec.playbookId,
        signalId: rec.signalId,
    };
    if (typeof rec.userId === "string" && rec.userId !== "") {
        record.userId = rec.userId;
    }
    if (typeof rec.lastError === "string") {
        record.lastError = rec.lastError;
    }
    return record;
}

export type ClaimedQueuedAction = QueuedAction & { userId: string };

type ClaimDueScope = { kind: "tenant"; userId: string } | { kind: "unscoped"; limit: number };

type ClaimDueActionRowsParams = {
    now: Date;
    claimLeaseMs: number;
    scope: ClaimDueScope;
};

function dueWhere(now: Date, userId: string | undefined) {
    const parts = [eq(actionQueue.status, QUEUE_STATUS_PENDING), lte(actionQueue.nextAttemptAt, now)];
    if (userId !== undefined) {
        parts.push(eq(actionQueue.userId, userId));
    }
    return and(...parts);
}

function leaseWhere(ids: string[], userId: string | undefined) {
    const parts = [eq(actionQueue.status, QUEUE_STATUS_PENDING), inArray(actionQueue.id, ids)];
    if (userId !== undefined) {
        parts.push(eq(actionQueue.userId, userId));
    }
    return and(...parts);
}

/**
 * Shared FOR UPDATE SKIP LOCKED + nextAttemptAt lease used by the tenant-bound
 * store and the unscoped drain claimer. `scope` is a discriminant so omitting
 * userId cannot silently become a cross-tenant read.
 *
 * Locks die at commit, and drainActionQueue executes after the claim returns,
 * so we also lease nextAttemptAt out of the due window. Without the lease,
 * a second worker would pick up the same mail.send after commit.
 */
async function claimDueActionRows(db: Database, params: ClaimDueActionRowsParams): Promise<QueuedAction[]> {
    const userId = params.scope.kind === "tenant" ? params.scope.userId : undefined;
    const limit = params.scope.kind === "unscoped" ? params.scope.limit : undefined;
    const leaseUntil = new Date(params.now.getTime() + params.claimLeaseMs);
    return db.transaction(async (tx) => {
        const ordered = tx
            .select()
            .from(actionQueue)
            .where(dueWhere(params.now, userId))
            .orderBy(asc(actionQueue.nextAttemptAt));
        const due =
            limit !== undefined
                ? await ordered.limit(limit).for(ROW_LOCK_STRENGTH, SKIP_LOCKED)
                : await ordered.for(ROW_LOCK_STRENGTH, SKIP_LOCKED);

        const claimed: QueuedAction[] = [];
        const ids: string[] = [];
        for (const row of due) {
            const parsed = parseQueuedActionRow(row);
            if (!parsed) {
                continue;
            }
            claimed.push(parsed);
            ids.push(parsed.id);
        }
        if (ids.length > 0) {
            await tx
                .update(actionQueue)
                .set({ nextAttemptAt: leaseUntil })
                .where(leaseWhere(ids, userId));
        }
        return claimed;
    });
}

export function requireUnscopedClaimLimit(limit: number): number {
    if (typeof limit !== "number" || !Number.isInteger(limit) || limit < 1) {
        throw new Error("claimDueActionsUnscoped requires a positive integer limit");
    }
    return limit;
}

export type ClaimDueActionsUnscopedOptions = {
    limit: number;
    now?: Date;
    claimLeaseMs?: number;
};

/**
 * Claims due action_queue rows across every tenant in one query.
 *
 * This deliberately bypasses the userId scope that PgActionQueue enforces.
 * It exists only for the background drain worker. Request-scoped code must
 * construct a PgActionQueue bound to the authenticated user. Each result
 * includes `userId` so the worker can re-bind tenant context per action
 * before execute / markSucceeded.
 */
export async function claimDueActionsUnscoped(
    db: Database,
    options: ClaimDueActionsUnscopedOptions,
): Promise<ClaimedQueuedAction[]> {
    const limit = requireUnscopedClaimLimit(options.limit);
    const claimed = await claimDueActionRows(db, {
        now: options.now ?? new Date(),
        claimLeaseMs: options.claimLeaseMs ?? DEFAULT_CLAIM_LEASE_MS,
        scope: { kind: "unscoped", limit },
    });
    const withUser: ClaimedQueuedAction[] = [];
    for (const row of claimed) {
        if (typeof row.userId !== "string" || row.userId === "") {
            continue;
        }
        withUser.push(row as ClaimedQueuedAction);
    }
    return withUser;
}

export class PgActionQueue implements ActionQueue {
    private readonly userId: string;
    private readonly createId: () => string;
    private readonly now: () => Date;
    private readonly claimLeaseMs: number;

    constructor(
        private readonly db: Database,
        userId: string,
        options: PgActionQueueOptions = {},
    ) {
        this.userId = requireBoundUserId(userId);
        this.createId = options.createId ?? randomUUID;
        this.now = options.now ?? (() => new Date());
        this.claimLeaseMs = options.claimLeaseMs ?? DEFAULT_CLAIM_LEASE_MS;
    }

    async enqueue(input: EnqueueActionInput): Promise<QueuedAction> {
        if (input.userId !== undefined && input.userId !== this.userId) {
            throw new Error("EnqueueActionInput.userId does not match the bound userId");
        }
        const nextAttemptAt = isoToDate(input.nextAttemptAt);
        if (!nextAttemptAt) {
            throw new Error("nextAttemptAt is not a parseable timestamp");
        }
        const args = { ...(input.args ?? {}) };
        const record: QueuedAction = {
            id: input.id ?? this.createId(),
            userId: this.userId,
            capability: input.capability,
            args,
            attempts: input.attempts ?? DEFAULT_QUEUE_ATTEMPTS,
            maxAttempts: input.maxAttempts,
            nextAttemptAt: dateToIso(nextAttemptAt) ?? input.nextAttemptAt,
            status: input.status ?? QUEUE_STATUS_PENDING,
            actionId: input.actionId,
            playbookId: input.playbookId,
            signalId: input.signalId,
        };
        if (input.lastError !== undefined) {
            record.lastError = input.lastError;
        }
        await this.db.insert(actionQueue).values({
            id: record.id,
            userId: this.userId,
            capability: record.capability,
            actionId: record.actionId,
            playbookId: record.playbookId,
            signalId: record.signalId,
            args,
            attempts: record.attempts,
            maxAttempts: record.maxAttempts,
            nextAttemptAt,
            status: record.status,
            lastError: record.lastError,
        });
        return { ...record, args: { ...record.args } };
    }

    async listDue(now: Date = this.now()): Promise<QueuedAction[]> {
        return claimDueActionRows(this.db, {
            now,
            claimLeaseMs: this.claimLeaseMs,
            scope: { kind: "tenant", userId: this.userId },
        });
    }

    async get(id: string): Promise<QueuedAction | undefined> {
        const rows = await this.db
            .select()
            .from(actionQueue)
            .where(and(eq(actionQueue.id, id), eq(actionQueue.userId, this.userId)))
            .limit(1);
        const parsed = parseQueuedActionRow(rows[0]);
        return parsed ? { ...parsed, args: { ...parsed.args } } : undefined;
    }

    async markSucceeded(id: string): Promise<QueuedAction | undefined> {
        const updated = await this.db
            .update(actionQueue)
            .set({ status: QUEUE_STATUS_SUCCEEDED })
            .where(and(eq(actionQueue.id, id), eq(actionQueue.userId, this.userId)))
            .returning();
        const parsed = parseQueuedActionRow(updated[0]);
        return parsed ? { ...parsed, args: { ...parsed.args } } : undefined;
    }

    async markDead(id: string, lastError?: string): Promise<QueuedAction | undefined> {
        const set: { status: "dead"; lastError?: string } = { status: QUEUE_STATUS_DEAD };
        if (lastError !== undefined) {
            set.lastError = lastError;
        }
        const updated = await this.db
            .update(actionQueue)
            .set(set)
            .where(and(eq(actionQueue.id, id), eq(actionQueue.userId, this.userId)))
            .returning();
        const parsed = parseQueuedActionRow(updated[0]);
        return parsed ? { ...parsed, args: { ...parsed.args } } : undefined;
    }

    async reschedule(id: string, input: RescheduleActionInput): Promise<QueuedAction | undefined> {
        const nextAttemptAt = isoToDate(input.nextAttemptAt);
        if (!nextAttemptAt) {
            throw new Error("nextAttemptAt is not a parseable timestamp");
        }
        const set: {
            attempts: number;
            nextAttemptAt: Date;
            lastError?: string;
        } = {
            attempts: input.attempts,
            nextAttemptAt,
        };
        if (input.lastError !== undefined) {
            set.lastError = input.lastError;
        }
        const updated = await this.db
            .update(actionQueue)
            .set(set)
            .where(
                and(
                    eq(actionQueue.id, id),
                    eq(actionQueue.userId, this.userId),
                    eq(actionQueue.status, QUEUE_STATUS_PENDING),
                ),
            )
            .returning();
        const parsed = parseQueuedActionRow(updated[0]);
        return parsed ? { ...parsed, args: { ...parsed.args } } : undefined;
    }
}
