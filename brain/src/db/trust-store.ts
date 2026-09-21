import { randomUUID } from "node:crypto";

import { and, desc, eq, sql, type SQL } from "drizzle-orm";

import { canEverPromote, classifySeverity, type Severity } from "../operator/severity.js";
import {
    AutonomyGrantError,
    type ExplicitUserConsent,
    type TrustKey,
    type TrustLedger,
    type TrustRecord,
} from "../operator/trust.js";
import type { Database } from "./client.js";
import { trustLedger } from "./schema.js";

export const TRUST_CONFLICT_TARGET = [
    trustLedger.userId,
    trustLedger.playbookId,
    trustLedger.capability,
] as const;

const SEVERITIES = new Set<Severity>(["reversible", "consequential", "irreversible"]);

export type PgTrustLedgerOptions = {
    now?: () => Date;
    createId?: () => string;
    /** Constructor-bound tenant. `list()` refuses to run without this. */
    userId?: string;
};

export function requireTrustUserId(userId: string): string {
    if (typeof userId !== "string" || userId === "") {
        throw new Error("PgTrustLedger requires a userId; refusing unscoped access");
    }
    return userId;
}

export function createPgTrustLedger(db: Database, options?: PgTrustLedgerOptions): PgTrustLedger {
    return new PgTrustLedger(db, options);
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

export function parseSeverity(value: unknown): Severity | undefined {
    if (typeof value === "string" && SEVERITIES.has(value as Severity)) {
        return value as Severity;
    }
    return undefined;
}

export function incrementStreakSql() {
    return sql`${trustLedger.streak} + 1`;
}

export function requireExplicitUserConsent(consent: ExplicitUserConsent): ExplicitUserConsent {
    if (consent == null || typeof consent !== "object" || Array.isArray(consent)) {
        throw new Error(
            "grantAutonomy requires ExplicitUserConsent from consentToGrantAutonomy(); a boolean is not consent",
        );
    }
    return consent;
}

export function parseTrustRow(row: unknown): TrustRecord | undefined {
    if (row == null || typeof row !== "object" || Array.isArray(row)) {
        return undefined;
    }
    const rec = row as Record<string, unknown>;
    if (typeof rec.id !== "string" || rec.id === "") {
        return undefined;
    }
    if (typeof rec.userId !== "string" || rec.userId === "") {
        return undefined;
    }
    if (typeof rec.playbookId !== "string" || rec.playbookId === "") {
        return undefined;
    }
    if (typeof rec.capability !== "string" || rec.capability === "") {
        return undefined;
    }
    const severity = parseSeverity(rec.severity);
    const streak = parseFiniteInt(rec.streak);
    const updatedAt = dateToIso(rec.updatedAt);
    if (severity === undefined || streak === undefined || !updatedAt) {
        return undefined;
    }
    if (typeof rec.autonomyGranted !== "boolean") {
        return undefined;
    }
    return {
        id: rec.id,
        userId: rec.userId,
        playbookId: rec.playbookId,
        capability: rec.capability,
        severity,
        streak,
        autonomyGranted: rec.autonomyGranted,
        updatedAt,
    };
}

type TrustConflictSet = {
    streak?: number | SQL;
    autonomyGranted?: boolean;
    severity: Severity;
    updatedAt: Date;
};

/**
 * `ON CONFLICT … SET streak = streak + 1` is the increment. Computing the next
 * streak in JS and writing it back is a lost-update race under concurrency.
 */
export class PgTrustLedger implements TrustLedger {
    private readonly now: () => Date;
    private readonly createId: () => string;
    private readonly userId: string | undefined;

    constructor(
        private readonly db: Database,
        options: PgTrustLedgerOptions = {},
    ) {
        this.now = options.now ?? (() => new Date());
        this.createId = options.createId ?? (() => randomUUID());
        this.userId = options.userId !== undefined ? requireTrustUserId(options.userId) : undefined;
    }

    async get(key: TrustKey): Promise<TrustRecord | undefined> {
        requireTrustUserId(key.userId);
        const rows = await this.db
            .select()
            .from(trustLedger)
            .where(
                and(
                    eq(trustLedger.userId, key.userId),
                    eq(trustLedger.playbookId, key.playbookId),
                    eq(trustLedger.capability, key.capability),
                ),
            )
            .limit(1);
        return parseTrustRow(rows[0]);
    }

    async list(): Promise<TrustRecord[]> {
        const userId = requireTrustUserId(this.userId ?? "");
        const rows = await this.db
            .select()
            .from(trustLedger)
            .where(eq(trustLedger.userId, userId))
            .orderBy(desc(trustLedger.updatedAt));
        const records: TrustRecord[] = [];
        for (const row of rows) {
            const parsed = parseTrustRow(row);
            if (parsed) {
                records.push(parsed);
            }
        }
        return records;
    }

    async recordApproval(key: TrustKey): Promise<TrustRecord> {
        return this.upsert(key, {
            insertStreak: 1,
            insertAutonomyGranted: false,
            set: { streak: incrementStreakSql() },
        });
    }

    async recordDenial(key: TrustKey): Promise<TrustRecord> {
        return this.resetStreak(key);
    }

    async recordFailure(key: TrustKey): Promise<TrustRecord> {
        return this.resetStreak(key);
    }

    async grantAutonomy(key: TrustKey, consent: ExplicitUserConsent): Promise<TrustRecord> {
        requireExplicitUserConsent(consent);
        const severity = classifySeverity(key.capability);
        if (!canEverPromote(severity)) {
            throw new AutonomyGrantError(key.capability);
        }
        return this.upsert(key, {
            insertStreak: 0,
            insertAutonomyGranted: true,
            set: { autonomyGranted: true },
        });
    }

    async revokeAutonomy(key: TrustKey): Promise<TrustRecord> {
        return this.upsert(key, {
            insertStreak: 0,
            insertAutonomyGranted: false,
            set: { streak: 0, autonomyGranted: false },
        });
    }

    private async resetStreak(key: TrustKey): Promise<TrustRecord> {
        return this.upsert(key, {
            insertStreak: 0,
            insertAutonomyGranted: false,
            set: { streak: 0 },
        });
    }

    private async upsert(
        key: TrustKey,
        spec: {
            insertStreak: number;
            insertAutonomyGranted: boolean;
            set: Omit<TrustConflictSet, "severity" | "updatedAt">;
        },
    ): Promise<TrustRecord> {
        requireTrustUserId(key.userId);
        const severity = classifySeverity(key.capability);
        const updatedAt = this.now();
        const conflictSet: TrustConflictSet = {
            ...spec.set,
            severity,
            updatedAt,
        };
        const inserted = await this.db
            .insert(trustLedger)
            .values({
                id: this.createId(),
                userId: key.userId,
                playbookId: key.playbookId,
                capability: key.capability,
                severity,
                streak: spec.insertStreak,
                autonomyGranted: spec.insertAutonomyGranted,
                updatedAt,
            })
            .onConflictDoUpdate({
                target: [...TRUST_CONFLICT_TARGET],
                set: conflictSet,
            })
            .returning();
        const parsed = parseTrustRow(inserted[0]);
        if (parsed) {
            return parsed;
        }
        const existing = await this.get(key);
        if (existing) {
            return existing;
        }
        throw new Error("trust_ledger upsert did not return a parseable row");
    }
}
