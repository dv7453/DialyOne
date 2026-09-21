import { asc, desc, eq } from "drizzle-orm";

import type { JournalWriter } from "../operator/journal.js";
import { JournalEntrySchema, type JournalEntry } from "../operator/types.js";
import type { Database } from "./client.js";
import { journal } from "./schema.js";

export function requireBoundUserId(userId: string): string {
    if (typeof userId !== "string" || userId === "") {
        throw new Error("PgJournalWriter requires a bound userId; refusing unscoped access");
    }
    return userId;
}

export function createPgJournalWriter(db: Database, userId: string): PgJournalWriter {
    return new PgJournalWriter(db, userId);
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

export function parseJournalRow(row: unknown): JournalEntry | undefined {
    if (row == null || typeof row !== "object" || Array.isArray(row)) {
        return undefined;
    }
    const rec = row as Record<string, unknown>;
    const ts = dateToIso(rec.createdAt);
    if (!ts) {
        return undefined;
    }
    const candidate: Record<string, unknown> = {
        ts,
        kind: rec.kind,
        data: rec.payload,
    };
    if (rec.playbookId != null) {
        candidate.playbookId = rec.playbookId;
    }
    if (rec.signalId != null) {
        candidate.signalId = rec.signalId;
    }
    const parsed = JournalEntrySchema.safeParse(candidate);
    return parsed.success ? parsed.data : undefined;
}

export class PgJournalWriter implements JournalWriter {
    private readonly userId: string;

    constructor(
        private readonly db: Database,
        userId: string,
    ) {
        this.userId = requireBoundUserId(userId);
    }

    async append(entry: JournalEntry): Promise<void> {
        const parsed = JournalEntrySchema.parse(entry);
        // The caller's ts is the audit time the user will read. Leaving createdAt
        // to defaultNow() would stamp commit time, which can disagree with the
        // operator clock (retries, queue delay, clock skew).
        const createdAt = isoToDate(parsed.ts);
        if (!createdAt) {
            throw new Error("Journal entry ts is not a parseable timestamp");
        }
        await this.db.insert(journal).values({
            userId: this.userId,
            kind: parsed.kind,
            playbookId: parsed.playbookId,
            signalId: parsed.signalId,
            payload: parsed.data,
            createdAt,
        });
    }

    async readAll(): Promise<JournalEntry[]> {
        const rows = await this.db
            .select()
            .from(journal)
            .where(eq(journal.userId, this.userId))
            .orderBy(asc(journal.createdAt));
        const entries: JournalEntry[] = [];
        for (const row of rows) {
            const entry = parseJournalRow(row);
            if (entry) {
                entries.push(entry);
            }
        }
        return entries;
    }

    async list(limit: number): Promise<JournalEntry[]> {
        const n = Number.isFinite(limit) ? Math.max(0, Math.trunc(limit)) : 0;
        if (n === 0) {
            return [];
        }
        const rows = await this.db
            .select()
            .from(journal)
            .where(eq(journal.userId, this.userId))
            .orderBy(desc(journal.createdAt))
            .limit(n);
        const entries: JournalEntry[] = [];
        for (const row of rows) {
            const entry = parseJournalRow(row);
            if (entry) {
                entries.push(entry);
            }
        }
        return entries;
    }
}
