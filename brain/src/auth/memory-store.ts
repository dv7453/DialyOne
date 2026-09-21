import { randomUUID } from "node:crypto";

import type {
    AuthSessionRecord,
    AuthStore,
    AuthUserRecord,
    InsertLoginTokenInput,
    InsertSessionInput,
    InsertUserInput,
    LoginTokenRecord,
} from "./store.js";

export class MemoryAuthStore implements AuthStore {
    readonly usersById = new Map<string, AuthUserRecord>();
    readonly usersByEmail = new Map<string, string>();
    readonly loginTokensByHash = new Map<string, LoginTokenRecord>();
    readonly sessionsByHash = new Map<string, AuthSessionRecord>();

    markDeleted(userId: string, at: Date = new Date()): void {
        const user = this.usersById.get(userId);
        if (user) {
            user.deletedAt = at;
        }
    }

    async findUserByEmail(email: string): Promise<AuthUserRecord | null> {
        const id = this.usersByEmail.get(email);
        return id ? (this.usersById.get(id) ?? null) : null;
    }

    async findUserById(id: string): Promise<AuthUserRecord | null> {
        return this.usersById.get(id) ?? null;
    }

    async insertUser(input: InsertUserInput): Promise<AuthUserRecord> {
        if (this.usersByEmail.has(input.email)) {
            throw new Error("email already exists");
        }
        const user: AuthUserRecord = {
            id: randomUUID(),
            email: input.email,
            displayName: input.displayName ?? null,
            locale: input.locale ?? "en",
            createdAt: new Date(),
            deletedAt: null,
        };
        this.usersById.set(user.id, user);
        this.usersByEmail.set(user.email, user.id);
        return { ...user };
    }

    async insertLoginToken(input: InsertLoginTokenInput): Promise<LoginTokenRecord> {
        const record: LoginTokenRecord = {
            id: randomUUID(),
            userId: input.userId,
            email: input.email,
            tokenHash: input.tokenHash,
            createdAt: new Date(),
            expiresAt: input.expiresAt,
            consumedAt: null,
        };
        this.loginTokensByHash.set(record.tokenHash, record);
        return { ...record };
    }

    async consumeLoginToken(tokenHash: string, now: Date): Promise<LoginTokenRecord | null> {
        const record = this.loginTokensByHash.get(tokenHash);
        if (!record || record.consumedAt || record.expiresAt.getTime() <= now.getTime()) {
            return null;
        }
        record.consumedAt = now;
        return { ...record };
    }

    async insertSession(input: InsertSessionInput): Promise<AuthSessionRecord> {
        const now = new Date();
        const record: AuthSessionRecord = {
            id: randomUUID(),
            userId: input.userId,
            tokenHash: input.tokenHash,
            createdAt: now,
            expiresAt: input.expiresAt,
            lastSeenAt: now,
            userAgent: input.userAgent ?? null,
        };
        this.sessionsByHash.set(record.tokenHash, record);
        return { ...record };
    }

    async findSessionByTokenHash(tokenHash: string): Promise<AuthSessionRecord | null> {
        const record = this.sessionsByHash.get(tokenHash);
        return record ? { ...record } : null;
    }

    async touchSession(id: string, lastSeenAt: Date): Promise<void> {
        for (const record of this.sessionsByHash.values()) {
            if (record.id === id) {
                record.lastSeenAt = lastSeenAt;
                return;
            }
        }
    }

    async deleteSessionByTokenHash(tokenHash: string): Promise<boolean> {
        return this.sessionsByHash.delete(tokenHash);
    }

    async deleteSessionsByUserId(userId: string): Promise<number> {
        let count = 0;
        for (const [hash, session] of this.sessionsByHash) {
            if (session.userId === userId) {
                this.sessionsByHash.delete(hash);
                count += 1;
            }
        }
        return count;
    }
}
