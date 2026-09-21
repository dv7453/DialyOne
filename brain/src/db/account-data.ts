import { rm } from "node:fs/promises";
import path from "node:path";

import { eq, getTableName } from "drizzle-orm";
import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";

import { authSessions, loginTokens } from "./auth-schema.js";
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

export const USER_FILESYSTEM_DIR = "users";

export const USER_ID_CASCADE_TABLES = [
    credentials,
    approvals,
    journal,
    trustLedger,
    openLoops,
    agentTasks,
    schedulerState,
    actionQueue,
    spendLedger,
    authSessions,
    loginTokens,
] as const;

export type CredentialExport = {
    id: string;
    provider: string;
    createdAt: string;
    updatedAt: string;
};

export type SessionExport = {
    id: string;
    createdAt: string;
    expiresAt: string;
    lastSeenAt: string;
    userAgent: string | null;
};

export type LoginTokenExport = {
    id: string;
    email: string;
    createdAt: string;
    expiresAt: string;
    consumedAt: string | null;
};

export type UserProfileExport = {
    id: string;
    email: string;
    displayName: string | null;
    locale: string;
    createdAt: string;
    deletedAt: string | null;
};

export type UserDataExport = {
    userId: string;
    exportedAt: string;
    profile: UserProfileExport | undefined;
    credentials: CredentialExport[];
    approvals: Record<string, unknown>[];
    journal: Record<string, unknown>[];
    trustLedger: Record<string, unknown>[];
    openLoops: Record<string, unknown>[];
    agentTasks: Record<string, unknown>[];
    actionQueue: Record<string, unknown>[];
    schedulerState: Record<string, unknown>[];
    spend: Record<string, unknown>[];
    sessions: SessionExport[];
    loginTokens: LoginTokenExport[];
};

export type DeleteUserResult = {
    erased: boolean;
    revokedSessions: number;
    revokedLoginTokens: number;
};

export type PgAccountDataOptions = {
    now?: () => Date;
};

export function requireAccountUserId(userId: string): string {
    if (typeof userId !== "string" || userId === "") {
        throw new Error("account data operations require a userId; refusing unscoped access");
    }
    return userId;
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

export function userFilesystemRoot(workDir: string, userId: string): string {
    return path.join(workDir, USER_FILESYSTEM_DIR, requireAccountUserId(userId));
}

export async function eraseUserFilesystem(workDir: string, userId: string): Promise<void> {
    await rm(userFilesystemRoot(workDir, userId), { recursive: true, force: true });
}

export type UserIdForeignKeyReport = {
    table: string;
    onDelete: string | undefined;
    nullable: boolean;
};

export function describeUserIdForeignKeys(): UserIdForeignKeyReport[] {
    return USER_ID_CASCADE_TABLES.map((table) => {
        const config = getTableConfig(table as PgTable);
        const userFk = config.foreignKeys.find((fk) =>
            fk.reference().columns.some((column) => column.name === "user_id"),
        );
        const userIdColumn = config.columns.find((column) => column.name === "user_id");
        return {
            table: config.name,
            onDelete: userFk?.onDelete,
            nullable: userIdColumn?.notNull === false,
        };
    });
}

export function tablesWithoutUserIdCascade(): string[] {
    return describeUserIdForeignKeys()
        .filter((row) => row.onDelete !== "cascade")
        .map((row) => row.table);
}

function jsonNanos(value: unknown): string | undefined {
    if (typeof value === "bigint") {
        return value.toString();
    }
    if (typeof value === "number" && Number.isSafeInteger(value)) {
        return String(value);
    }
    if (typeof value === "string" && /^-?\d+$/.test(value)) {
        return value;
    }
    return undefined;
}

function jsonDate(value: unknown): string | null | undefined {
    if (value == null) {
        return value === undefined ? undefined : null;
    }
    return dateToIso(value);
}

function asRecord(row: unknown): Record<string, unknown> | undefined {
    if (row == null || typeof row !== "object" || Array.isArray(row)) {
        return undefined;
    }
    return row as Record<string, unknown>;
}

export function parseProfileRow(row: unknown): UserProfileExport | undefined {
    const rec = asRecord(row);
    if (!rec) {
        return undefined;
    }
    if (typeof rec.id !== "string" || rec.id === "") {
        return undefined;
    }
    if (typeof rec.email !== "string" || rec.email === "") {
        return undefined;
    }
    const createdAt = dateToIso(rec.createdAt);
    if (!createdAt) {
        return undefined;
    }
    if (typeof rec.locale !== "string") {
        return undefined;
    }
    let displayName: string | null = null;
    if (rec.displayName != null) {
        if (typeof rec.displayName !== "string") {
            return undefined;
        }
        displayName = rec.displayName;
    }
    let deletedAt: string | null = null;
    if (rec.deletedAt != null) {
        const parsed = dateToIso(rec.deletedAt);
        if (!parsed) {
            return undefined;
        }
        deletedAt = parsed;
    }
    return {
        id: rec.id,
        email: rec.email,
        displayName,
        locale: rec.locale,
        createdAt,
        deletedAt,
    };
}

export function parseCredentialExportRow(row: unknown): CredentialExport | undefined {
    const rec = asRecord(row);
    if (!rec) {
        return undefined;
    }
    if (typeof rec.id !== "string" || rec.id === "") {
        return undefined;
    }
    if (typeof rec.provider !== "string" || rec.provider === "") {
        return undefined;
    }
    const createdAt = dateToIso(rec.createdAt);
    const updatedAt = dateToIso(rec.updatedAt);
    if (!createdAt || !updatedAt) {
        return undefined;
    }
    if ("encryptedPayload" in rec) {
        return undefined;
    }
    return { id: rec.id, provider: rec.provider, createdAt, updatedAt };
}

export function parseSessionExportRow(row: unknown): SessionExport | undefined {
    const rec = asRecord(row);
    if (!rec) {
        return undefined;
    }
    if (typeof rec.id !== "string" || rec.id === "") {
        return undefined;
    }
    const createdAt = dateToIso(rec.createdAt);
    const expiresAt = dateToIso(rec.expiresAt);
    const lastSeenAt = dateToIso(rec.lastSeenAt);
    if (!createdAt || !expiresAt || !lastSeenAt) {
        return undefined;
    }
    if ("tokenHash" in rec) {
        return undefined;
    }
    let userAgent: string | null = null;
    if (rec.userAgent != null) {
        if (typeof rec.userAgent !== "string") {
            return undefined;
        }
        userAgent = rec.userAgent;
    }
    return { id: rec.id, createdAt, expiresAt, lastSeenAt, userAgent };
}

export function parseLoginTokenExportRow(row: unknown): LoginTokenExport | undefined {
    const rec = asRecord(row);
    if (!rec) {
        return undefined;
    }
    if (typeof rec.id !== "string" || rec.id === "") {
        return undefined;
    }
    if (typeof rec.email !== "string") {
        return undefined;
    }
    const createdAt = dateToIso(rec.createdAt);
    const expiresAt = dateToIso(rec.expiresAt);
    if (!createdAt || !expiresAt) {
        return undefined;
    }
    if ("tokenHash" in rec) {
        return undefined;
    }
    let consumedAt: string | null = null;
    if (rec.consumedAt != null) {
        const parsed = dateToIso(rec.consumedAt);
        if (!parsed) {
            return undefined;
        }
        consumedAt = parsed;
    }
    return { id: rec.id, email: rec.email, createdAt, expiresAt, consumedAt };
}

function mapRows<T>(rows: unknown[], parse: (row: unknown) => T | undefined): T[] {
    const out: T[] = [];
    for (const row of rows) {
        const parsed = parse(row);
        if (parsed) {
            out.push(parsed);
        }
    }
    return out;
}

function publicRow(row: unknown, omit: ReadonlySet<string> = new Set()): Record<string, unknown> | undefined {
    const rec = asRecord(row);
    if (!rec) {
        return undefined;
    }
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(rec)) {
        if (omit.has(key)) {
            continue;
        }
        if (value instanceof Date) {
            const iso = dateToIso(value);
            if (!iso) {
                return undefined;
            }
            out[key] = iso;
            continue;
        }
        if (typeof value === "bigint") {
            out[key] = value.toString();
            continue;
        }
        out[key] = value;
    }
    return out;
}

export const CREDENTIAL_EXPORT_COLUMNS = {
    id: credentials.id,
    provider: credentials.provider,
    createdAt: credentials.createdAt,
    updatedAt: credentials.updatedAt,
} as const;

export const SESSION_EXPORT_COLUMNS = {
    id: authSessions.id,
    createdAt: authSessions.createdAt,
    expiresAt: authSessions.expiresAt,
    lastSeenAt: authSessions.lastSeenAt,
    userAgent: authSessions.userAgent,
} as const;

export const LOGIN_TOKEN_EXPORT_COLUMNS = {
    id: loginTokens.id,
    email: loginTokens.email,
    createdAt: loginTokens.createdAt,
    expiresAt: loginTokens.expiresAt,
    consumedAt: loginTokens.consumedAt,
} as const;

export function spendExportRow(row: unknown): Record<string, unknown> | undefined {
    const rec = asRecord(row);
    if (!rec) {
        return undefined;
    }
    const reservedNanos = jsonNanos(rec.reservedNanos);
    const spentNanos = jsonNanos(rec.spentNanos);
    if (reservedNanos === undefined || spentNanos === undefined) {
        return undefined;
    }
    const createdAt = jsonDate(rec.createdAt);
    const updatedAt = jsonDate(rec.updatedAt);
    const reservedUpdatedAt = jsonDate(rec.reservedUpdatedAt);
    if (!createdAt || !updatedAt || !reservedUpdatedAt) {
        return undefined;
    }
    const exported: Record<string, unknown> = {
        reservedNanos,
        spentNanos,
        createdAt,
        updatedAt,
        reservedUpdatedAt,
    };
    if (typeof rec.id === "string") {
        exported.id = rec.id;
    }
    if (typeof rec.day === "string") {
        exported.day = rec.day;
    }
    return exported;
}

export class PgAccountData {
    private readonly now: () => Date;

    constructor(
        private readonly db: Database,
        options: PgAccountDataOptions = {},
    ) {
        this.now = options.now ?? (() => new Date());
    }

    async exportUser(userId: string): Promise<UserDataExport> {
        const id = requireAccountUserId(userId);
        const [
            profileRows,
            credentialRows,
            approvalRows,
            journalRows,
            trustRows,
            loopRows,
            taskRows,
            queueRows,
            schedulerRows,
            spendRows,
            sessionRows,
            tokenRows,
        ] = await Promise.all([
            this.db.select().from(users).where(eq(users.id, id)).limit(1),
            this.db.select(CREDENTIAL_EXPORT_COLUMNS).from(credentials).where(eq(credentials.userId, id)),
            this.db.select().from(approvals).where(eq(approvals.userId, id)),
            this.db.select().from(journal).where(eq(journal.userId, id)),
            this.db.select().from(trustLedger).where(eq(trustLedger.userId, id)),
            this.db.select().from(openLoops).where(eq(openLoops.userId, id)),
            this.db.select().from(agentTasks).where(eq(agentTasks.userId, id)),
            this.db.select().from(actionQueue).where(eq(actionQueue.userId, id)),
            this.db.select().from(schedulerState).where(eq(schedulerState.userId, id)),
            this.db.select().from(spendLedger).where(eq(spendLedger.userId, id)),
            this.db.select(SESSION_EXPORT_COLUMNS).from(authSessions).where(eq(authSessions.userId, id)),
            this.db.select(LOGIN_TOKEN_EXPORT_COLUMNS).from(loginTokens).where(eq(loginTokens.userId, id)),
        ]);

        return {
            userId: id,
            exportedAt: this.now().toISOString(),
            profile: parseProfileRow(profileRows[0]),
            credentials: mapRows(credentialRows, parseCredentialExportRow),
            approvals: mapRows(approvalRows, (row) => publicRow(row)),
            journal: mapRows(journalRows, (row) => publicRow(row)),
            trustLedger: mapRows(trustRows, (row) => publicRow(row)),
            openLoops: mapRows(loopRows, (row) => publicRow(row)),
            agentTasks: mapRows(taskRows, (row) => publicRow(row)),
            actionQueue: mapRows(queueRows, (row) => publicRow(row)),
            schedulerState: mapRows(schedulerRows, (row) => publicRow(row)),
            spend: mapRows(spendRows, spendExportRow),
            sessions: mapRows(sessionRows, parseSessionExportRow),
            loginTokens: mapRows(tokenRows, parseLoginTokenExportRow),
        };
    }

    /**
     * Hard-DELETE the user row. Soft `deletedAt` leaves email and display name
     * in place, which is deactivation, not DPDP erasure. Child tables cascade.
     * Sessions and magic links are deleted first so a live cookie cannot outlive
     * the account even if a later migration dropped a cascade.
     */
    async deleteUser(userId: string): Promise<DeleteUserResult> {
        const id = requireAccountUserId(userId);
        return this.db.transaction(async (tx) => {
            const tokens = await tx
                .delete(loginTokens)
                .where(eq(loginTokens.userId, id))
                .returning({ id: loginTokens.id });
            const sessions = await tx
                .delete(authSessions)
                .where(eq(authSessions.userId, id))
                .returning({ id: authSessions.id });
            const removed = await tx.delete(users).where(eq(users.id, id)).returning({ id: users.id });
            return {
                erased: removed.length > 0,
                revokedSessions: sessions.length,
                revokedLoginTokens: tokens.length,
            };
        });
    }

    async eraseUser(userId: string, workDir: string): Promise<DeleteUserResult> {
        const result = await this.deleteUser(userId);
        await eraseUserFilesystem(workDir, userId);
        return result;
    }
}

export function createPgAccountData(db: Database, options?: PgAccountDataOptions): PgAccountData {
    return new PgAccountData(db, options);
}

export function exportTableNames(): string[] {
    return [
        getTableName(users),
        getTableName(credentials),
        getTableName(approvals),
        getTableName(journal),
        getTableName(trustLedger),
        getTableName(openLoops),
        getTableName(agentTasks),
        getTableName(actionQueue),
        getTableName(schedulerState),
        getTableName(spendLedger),
        getTableName(authSessions),
        getTableName(loginTokens),
    ];
}
