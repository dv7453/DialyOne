export type AuthUserRecord = {
    id: string;
    email: string;
    displayName: string | null;
    locale: string;
    createdAt: Date;
    deletedAt: Date | null;
};

export type AuthSessionRecord = {
    id: string;
    userId: string;
    tokenHash: string;
    createdAt: Date;
    expiresAt: Date;
    lastSeenAt: Date;
    userAgent: string | null;
};

export type LoginTokenRecord = {
    id: string;
    userId: string;
    email: string;
    tokenHash: string;
    createdAt: Date;
    expiresAt: Date;
    consumedAt: Date | null;
};

export type InsertUserInput = {
    email: string;
    displayName?: string | null;
    locale?: string;
};

export type InsertLoginTokenInput = {
    userId: string;
    email: string;
    tokenHash: string;
    expiresAt: Date;
};

export type InsertSessionInput = {
    userId: string;
    tokenHash: string;
    expiresAt: Date;
    userAgent?: string | null;
};

export interface AuthStore {
    findUserByEmail(email: string): Promise<AuthUserRecord | null>;
    findUserById(id: string): Promise<AuthUserRecord | null>;
    insertUser(input: InsertUserInput): Promise<AuthUserRecord>;
    insertLoginToken(input: InsertLoginTokenInput): Promise<LoginTokenRecord>;
    consumeLoginToken(tokenHash: string, now: Date): Promise<LoginTokenRecord | null>;
    insertSession(input: InsertSessionInput): Promise<AuthSessionRecord>;
    findSessionByTokenHash(tokenHash: string): Promise<AuthSessionRecord | null>;
    touchSession(id: string, lastSeenAt: Date): Promise<void>;
    deleteSessionByTokenHash(tokenHash: string): Promise<boolean>;
    deleteSessionsByUserId(userId: string): Promise<number>;
}
