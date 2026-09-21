import { and, eq, gt, isNull } from "drizzle-orm";

import type { Database } from "../db/client.js";
import { authSessions, loginTokens } from "../db/auth-schema.js";
import { users } from "../db/schema.js";
import type {
    AuthSessionRecord,
    AuthStore,
    AuthUserRecord,
    InsertLoginTokenInput,
    InsertSessionInput,
    InsertUserInput,
    LoginTokenRecord,
} from "./store.js";

function asDate(value: Date | string): Date {
    return value instanceof Date ? value : new Date(value);
}

function toUser(row: typeof users.$inferSelect): AuthUserRecord {
    return {
        id: row.id,
        email: row.email,
        displayName: row.displayName ?? null,
        locale: row.locale,
        createdAt: asDate(row.createdAt),
        deletedAt: row.deletedAt ? asDate(row.deletedAt) : null,
    };
}

function toLoginToken(row: typeof loginTokens.$inferSelect): LoginTokenRecord {
    return {
        id: row.id,
        userId: row.userId,
        email: row.email,
        tokenHash: row.tokenHash,
        createdAt: asDate(row.createdAt),
        expiresAt: asDate(row.expiresAt),
        consumedAt: row.consumedAt ? asDate(row.consumedAt) : null,
    };
}

function toSession(row: typeof authSessions.$inferSelect): AuthSessionRecord {
    return {
        id: row.id,
        userId: row.userId,
        tokenHash: row.tokenHash,
        createdAt: asDate(row.createdAt),
        expiresAt: asDate(row.expiresAt),
        lastSeenAt: asDate(row.lastSeenAt),
        userAgent: row.userAgent ?? null,
    };
}

function isUniqueViolation(error: unknown): boolean {
    return (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        (error as { code: unknown }).code === "23505"
    );
}

export class PgAuthStore implements AuthStore {
    constructor(private readonly db: Database) {}

    async findUserByEmail(email: string): Promise<AuthUserRecord | null> {
        const rows = await this.db.select().from(users).where(eq(users.email, email)).limit(1);
        return rows[0] ? toUser(rows[0]) : null;
    }

    async findUserById(id: string): Promise<AuthUserRecord | null> {
        const rows = await this.db.select().from(users).where(eq(users.id, id)).limit(1);
        return rows[0] ? toUser(rows[0]) : null;
    }

    async insertUser(input: InsertUserInput): Promise<AuthUserRecord> {
        try {
            const rows = await this.db
                .insert(users)
                .values({
                    email: input.email,
                    displayName: input.displayName ?? null,
                    locale: input.locale ?? "en",
                })
                .returning();
            const row = rows[0];
            if (!row) {
                throw new Error("insert user returned no row");
            }
            return toUser(row);
        } catch (error) {
            if (!isUniqueViolation(error)) {
                throw error;
            }
            const existing = await this.findUserByEmail(input.email);
            if (!existing) {
                throw error;
            }
            return existing;
        }
    }

    async insertLoginToken(input: InsertLoginTokenInput): Promise<LoginTokenRecord> {
        const rows = await this.db
            .insert(loginTokens)
            .values({
                userId: input.userId,
                email: input.email,
                tokenHash: input.tokenHash,
                expiresAt: input.expiresAt,
            })
            .returning();
        const row = rows[0];
        if (!row) {
            throw new Error("insert login token returned no row");
        }
        return toLoginToken(row);
    }

    async consumeLoginToken(tokenHash: string, now: Date): Promise<LoginTokenRecord | null> {
        const rows = await this.db
            .update(loginTokens)
            .set({ consumedAt: now })
            .where(
                and(
                    eq(loginTokens.tokenHash, tokenHash),
                    isNull(loginTokens.consumedAt),
                    gt(loginTokens.expiresAt, now),
                ),
            )
            .returning();
        return rows[0] ? toLoginToken(rows[0]) : null;
    }

    async insertSession(input: InsertSessionInput): Promise<AuthSessionRecord> {
        const rows = await this.db
            .insert(authSessions)
            .values({
                userId: input.userId,
                tokenHash: input.tokenHash,
                expiresAt: input.expiresAt,
                userAgent: input.userAgent ?? null,
            })
            .returning();
        const row = rows[0];
        if (!row) {
            throw new Error("insert session returned no row");
        }
        return toSession(row);
    }

    async findSessionByTokenHash(tokenHash: string): Promise<AuthSessionRecord | null> {
        const rows = await this.db
            .select()
            .from(authSessions)
            .where(eq(authSessions.tokenHash, tokenHash))
            .limit(1);
        return rows[0] ? toSession(rows[0]) : null;
    }

    async touchSession(id: string, lastSeenAt: Date): Promise<void> {
        await this.db.update(authSessions).set({ lastSeenAt }).where(eq(authSessions.id, id));
    }

    async deleteSessionByTokenHash(tokenHash: string): Promise<boolean> {
        const rows = await this.db
            .delete(authSessions)
            .where(eq(authSessions.tokenHash, tokenHash))
            .returning({ id: authSessions.id });
        return rows.length > 0;
    }

    async deleteSessionsByUserId(userId: string): Promise<number> {
        const rows = await this.db
            .delete(authSessions)
            .where(eq(authSessions.userId, userId))
            .returning({ id: authSessions.id });
        return rows.length;
    }
}
