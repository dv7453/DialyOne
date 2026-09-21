import { randomUUID } from "node:crypto";

import { and, asc, eq, inArray, isNotNull, isNull, lte } from "drizzle-orm";

import {
    ApprovalRecordSchema,
    decodeTurnRouteArgs,
    encodeTurnRouteArgs,
    expireIfDue,
    turnRouteOf,
    type ApprovalExpiryStore,
    type ApprovalRecord,
    type ApprovalResolution,
    type ApprovalsStoreOptions,
    type ApprovalStatus,
    type CreateApprovalInput,
} from "../operator/approvals.js";
import { withDefaultExpiry } from "../operator/expiry.js";
import type { Database } from "./client.js";
import { approvals } from "./schema.js";

export const APPROVAL_STATUS_PENDING = "pending" as const;
export const APPROVAL_STATUS_APPROVED = "approved" as const;
export const APPROVAL_STATUS_DENIED = "denied" as const;
export const APPROVAL_STATUS_EXPIRED = "expired" as const;

const APPROVAL_STATUSES = new Set<ApprovalStatus>([
    APPROVAL_STATUS_PENDING,
    APPROVAL_STATUS_APPROVED,
    APPROVAL_STATUS_DENIED,
    APPROVAL_STATUS_EXPIRED,
]);

export function requireBoundUserId(userId: string): string {
    if (typeof userId !== "string" || userId === "") {
        throw new Error("PgApprovalsStore requires a bound userId; refusing unscoped access");
    }
    return userId;
}

export function createPgApprovalsStore(
    db: Database,
    userId: string,
    options?: ApprovalsStoreOptions,
): PgApprovalsStore {
    return new PgApprovalsStore(db, userId, options);
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

export function parseApprovalRow(row: unknown): ApprovalRecord | undefined {
    if (row == null || typeof row !== "object" || Array.isArray(row)) {
        return undefined;
    }
    const rec = row as Record<string, unknown>;
    if (typeof rec.playbookId !== "string" || rec.playbookId === "") {
        return undefined;
    }
    const createdAt = dateToIso(rec.createdAt);
    if (typeof rec.status !== "string" || !APPROVAL_STATUSES.has(rec.status as ApprovalStatus) || !createdAt) {
        return undefined;
    }
    const parsedArgs = parseCapabilityArgs(rec.args);
    if (parsedArgs === undefined) {
        return undefined;
    }
    const { args, route } = decodeTurnRouteArgs(parsedArgs);
    const candidate: Record<string, unknown> = {
        id: rec.id,
        actionId: rec.actionId,
        playbookId: rec.playbookId,
        capability: rec.capability,
        status: rec.status,
        createdAt,
    };
    if (args && Object.keys(args).length > 0) {
        candidate.args = args;
    }
    if (route) {
        candidate.turnId = route.turnId;
        candidate.toolCallId = route.toolCallId;
        if (route.sessionId) {
            candidate.sessionId = route.sessionId;
        }
    }
    if (rec.signalId != null) {
        if (typeof rec.signalId !== "string" || rec.signalId === "") {
            return undefined;
        }
        candidate.signalId = rec.signalId;
    }
    if (rec.expiresAt != null && rec.expiresAt !== "") {
        const expiresAt = dateToIso(rec.expiresAt);
        if (!expiresAt) {
            return undefined;
        }
        candidate.expiresAt = expiresAt;
    }
    const resolvedAt = dateToIso(rec.decidedAt);
    if (resolvedAt !== undefined) {
        candidate.resolvedAt = resolvedAt;
    }
    const parsed = ApprovalRecordSchema.safeParse(candidate);
    return parsed.success ? parsed.data : undefined;
}

export function isApprovalExpired(record: ApprovalRecord, nowIso: string): boolean {
    if (record.status !== APPROVAL_STATUS_PENDING || !record.expiresAt) {
        return false;
    }
    return !(Date.parse(record.expiresAt) > Date.parse(nowIso));
}

export function statusForResolution(resolution: ApprovalResolution): "approved" | "denied" {
    return resolution === "approve" ? APPROVAL_STATUS_APPROVED : APPROVAL_STATUS_DENIED;
}

/**
 * `transitioned` is true only when this call performed pending → approved/denied.
 * A second resolve of the same row returns the existing decision with
 * `transitioned: false` — the caller must not execute the capability again.
 */
export type ApprovalResolveOutcome = {
    record: ApprovalRecord;
    transitioned: boolean;
};

export class PgApprovalsStore implements ApprovalExpiryStore {
    private readonly userId: string;
    private readonly createId: () => string;
    private readonly now: () => string;

    constructor(
        private readonly db: Database,
        userId: string,
        options: ApprovalsStoreOptions = {},
    ) {
        this.userId = requireBoundUserId(userId);
        this.createId = options.createId ?? randomUUID;
        this.now = options.now ?? (() => new Date().toISOString());
    }

    async create(input: CreateApprovalInput): Promise<ApprovalRecord> {
        const createdAt = this.now();
        // A card with no expiry pins its suspended turn open forever, so every
        // create gets a severity-derived TTL unless the caller set one.
        const record = ApprovalRecordSchema.parse({
            ...withDefaultExpiry(input, createdAt),
            id: this.createId(),
            status: APPROVAL_STATUS_PENDING,
            createdAt,
        });
        await this.db.insert(approvals).values({
            id: record.id,
            userId: this.userId,
            actionId: record.actionId,
            playbookId: record.playbookId,
            capability: record.capability,
            args: encodeTurnRouteArgs(record.args, turnRouteOf(record)),
            signalId: record.signalId,
            status: record.status,
            createdAt: isoToDate(record.createdAt) ?? new Date(),
            expiresAt: isoToDate(record.expiresAt),
        });
        return record;
    }

    async get(id: string): Promise<ApprovalRecord | undefined> {
        const record = await this.readOne(id);
        if (!record) {
            return undefined;
        }
        return this.persistExpiry(record);
    }

    async listPending(): Promise<ApprovalRecord[]> {
        const rows = await this.db
            .select()
            .from(approvals)
            .where(and(eq(approvals.userId, this.userId), eq(approvals.status, APPROVAL_STATUS_PENDING)))
            .orderBy(asc(approvals.createdAt));
        const now = this.now();
        const pending: ApprovalRecord[] = [];
        const expiredIds: string[] = [];
        for (const row of rows) {
            const record = parseApprovalRow(row);
            if (!record) {
                continue;
            }
            if (isApprovalExpired(record, now)) {
                expiredIds.push(record.id);
                continue;
            }
            pending.push(record);
        }
        if (expiredIds.length > 0) {
            await this.db
                .update(approvals)
                .set({ status: APPROVAL_STATUS_EXPIRED, decidedAt: isoToDate(now) ?? new Date() })
                .where(
                    and(
                        eq(approvals.userId, this.userId),
                        eq(approvals.status, APPROVAL_STATUS_PENDING),
                        inArray(approvals.id, expiredIds),
                    ),
                );
        }
        return pending;
    }

    async resolve(id: string, resolution: ApprovalResolution): Promise<ApprovalRecord | undefined> {
        const outcome = await this.resolveTransition(id, resolution);
        return outcome?.record;
    }

    async resolveTransition(
        id: string,
        resolution: ApprovalResolution,
    ): Promise<ApprovalResolveOutcome | undefined> {
        const existing = await this.get(id);
        if (!existing) {
            return undefined;
        }
        if (existing.status !== APPROVAL_STATUS_PENDING) {
            return { record: existing, transitioned: false };
        }

        const decidedAt = isoToDate(this.now()) ?? new Date();
        const updated = await this.db
            .update(approvals)
            .set({ status: statusForResolution(resolution), decidedAt })
            .where(
                and(
                    eq(approvals.id, id),
                    eq(approvals.userId, this.userId),
                    eq(approvals.status, APPROVAL_STATUS_PENDING),
                ),
            )
            .returning();
        const parsed = parseApprovalRow(updated[0]);
        if (parsed) {
            return { record: parsed, transitioned: true };
        }
        const raced = await this.readOne(id);
        if (!raced) {
            return undefined;
        }
        return { record: raced, transitioned: false };
    }

    /**
     * Claims overdue cards for the reaper. The UPDATE ... RETURNING is the claim:
     * only the instance that performs the pending → expired transition sees the
     * row, so two brains cannot both deny the same suspended turn.
     *
     * The second pass picks up rows that `listPending`/`get` already flipped to
     * expired without stamping `decidedAt` — those have no resolvedAt, so the
     * reaper never saw them and their turns would stay suspended.
     */
    async expireDue(): Promise<ApprovalRecord[]> {
        const nowIso = this.now();
        const now = isoToDate(nowIso) ?? new Date();

        const claimed = await this.db
            .update(approvals)
            .set({ status: APPROVAL_STATUS_EXPIRED, decidedAt: now })
            .where(
                and(
                    eq(approvals.userId, this.userId),
                    eq(approvals.status, APPROVAL_STATUS_PENDING),
                    isNotNull(approvals.expiresAt),
                    lte(approvals.expiresAt, now),
                ),
            )
            .returning();

        const stranded = await this.db
            .update(approvals)
            .set({ decidedAt: now })
            .where(
                and(
                    eq(approvals.userId, this.userId),
                    eq(approvals.status, APPROVAL_STATUS_EXPIRED),
                    isNull(approvals.decidedAt),
                ),
            )
            .returning();

        const out: ApprovalRecord[] = [];
        for (const row of [...claimed, ...stranded]) {
            const record = parseApprovalRow(row);
            if (record) {
                out.push(expireIfDue(record, nowIso));
            }
        }
        return out;
    }

    private async readOne(id: string): Promise<ApprovalRecord | undefined> {
        const rows = await this.db
            .select()
            .from(approvals)
            .where(and(eq(approvals.id, id), eq(approvals.userId, this.userId)))
            .limit(1);
        return parseApprovalRow(rows[0]);
    }

    private async persistExpiry(record: ApprovalRecord): Promise<ApprovalRecord> {
        const nowIso = this.now();
        if (!isApprovalExpired(record, nowIso)) {
            return record;
        }
        const updated = await this.db
            .update(approvals)
            .set({ status: APPROVAL_STATUS_EXPIRED, decidedAt: isoToDate(nowIso) ?? new Date() })
            .where(
                and(
                    eq(approvals.id, record.id),
                    eq(approvals.userId, this.userId),
                    eq(approvals.status, APPROVAL_STATUS_PENDING),
                ),
            )
            .returning();
        const parsed = parseApprovalRow(updated[0]);
        if (parsed) {
            return parsed;
        }
        return (await this.readOne(record.id)) ?? { ...record, status: APPROVAL_STATUS_EXPIRED };
    }
}
