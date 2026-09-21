import { getDb } from "../db/client.js";
import { ConsoleMagicLinkMailer, type MagicLinkMailer } from "./mailer.js";
import { PgAuthStore } from "./pg-store.js";
import { generateSecret, hashSecret } from "./secret.js";
import type { AuthStore, AuthUserRecord } from "./store.js";

export const LOGIN_TOKEN_TTL_MS = 15 * 60 * 1000;
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_EMAIL_LENGTH = 320;

export type PublicUser = {
    id: string;
    email: string | null;
    displayName: string | null;
    locale: string;
};

export type SessionAuth = {
    sessionToken: string;
    expiresAt: Date;
    user: PublicUser;
};

export type ValidatedSession = {
    sessionId: string;
    user: PublicUser;
};

export class InvalidEmailError extends Error {
    constructor(message = "invalid email") {
        super(message);
        this.name = "InvalidEmailError";
    }
}

export class InvalidLoginTokenError extends Error {
    constructor(message = "invalid or expired login token") {
        super(message);
        this.name = "InvalidLoginTokenError";
    }
}

export class UserDeletedError extends Error {
    constructor(message = "user is deleted") {
        super(message);
        this.name = "UserDeletedError";
    }
}

export type AuthServiceOptions = {
    store: AuthStore;
    mailer?: MagicLinkMailer;
    now?: () => Date;
    appUrl?: string;
    loginTokenTtlMs?: number;
    sessionTtlMs?: number;
};

export class AuthService {
    private readonly store: AuthStore;
    private readonly mailer: MagicLinkMailer;
    private readonly now: () => Date;
    private readonly appUrl: string;
    private readonly loginTokenTtlMs: number;
    private readonly sessionTtlMs: number;

    constructor(options: AuthServiceOptions) {
        this.store = options.store;
        this.mailer = options.mailer ?? new ConsoleMagicLinkMailer();
        this.now = options.now ?? (() => new Date());
        this.appUrl = (options.appUrl ?? "http://127.0.0.1:5173").replace(/\/+$/, "");
        this.loginTokenTtlMs = options.loginTokenTtlMs ?? LOGIN_TOKEN_TTL_MS;
        this.sessionTtlMs = options.sessionTtlMs ?? SESSION_TTL_MS;
    }

    async inviteUser(input: { email: string; displayName?: string | null; locale?: string }): Promise<PublicUser> {
        const email = normalizeEmail(input.email);
        if (!email) {
            throw new InvalidEmailError();
        }
        const existing = await this.store.findUserByEmail(email);
        if (existing) {
            if (existing.deletedAt) {
                throw new UserDeletedError();
            }
            return toPublicUser(existing);
        }
        const created = await this.store.insertUser({
            email,
            displayName: input.displayName ?? null,
            locale: input.locale ?? "en",
        });
        if (created.deletedAt) {
            throw new UserDeletedError();
        }
        return toPublicUser(created);
    }

    async requestMagicLink(email: string): Promise<{ ok: true }> {
        const normalized = normalizeEmail(email);
        if (!normalized) {
            return { ok: true };
        }
        const user = await this.store.findUserByEmail(normalized);
        if (!user || user.deletedAt) {
            return { ok: true };
        }
        const raw = generateSecret();
        const expiresAt = new Date(this.now().getTime() + this.loginTokenTtlMs);
        await this.store.insertLoginToken({
            userId: user.id,
            email: normalized,
            tokenHash: hashSecret(raw),
            expiresAt,
        });
        const magicLinkUrl = `${this.appUrl}/login?token=${encodeURIComponent(raw)}`;
        try {
            await this.mailer.sendMagicLink({ email: normalized, magicLinkUrl, expiresAt });
        } catch (error) {
            console.error("[dialy-auth] magic link delivery failed", error);
        }
        return { ok: true };
    }

    async consumeMagicLink(
        token: string,
        opts?: { userAgent?: string | null },
    ): Promise<SessionAuth> {
        if (!token) {
            throw new InvalidLoginTokenError();
        }
        const login = await this.store.consumeLoginToken(hashSecret(token), this.now());
        if (!login) {
            throw new InvalidLoginTokenError();
        }
        const user = await this.store.findUserById(login.userId);
        if (!user || user.deletedAt) {
            throw new InvalidLoginTokenError();
        }
        const sessionToken = generateSecret();
        const expiresAt = new Date(this.now().getTime() + this.sessionTtlMs);
        await this.store.insertSession({
            userId: user.id,
            tokenHash: hashSecret(sessionToken),
            expiresAt,
            userAgent: opts?.userAgent ?? null,
        });
        return { sessionToken, expiresAt, user: toPublicUser(user) };
    }

    async validateSession(token: string): Promise<ValidatedSession | null> {
        if (!token) {
            return null;
        }
        const session = await this.store.findSessionByTokenHash(hashSecret(token));
        if (!session || session.expiresAt.getTime() <= this.now().getTime()) {
            return null;
        }
        const user = await this.store.findUserById(session.userId);
        if (!user || user.deletedAt) {
            return null;
        }
        try {
            await this.store.touchSession(session.id, this.now());
        } catch {
            // lastSeenAt is diagnostic; a failed touch must not reject a valid session.
        }
        return { sessionId: session.id, user: toPublicUser(user) };
    }

    async revokeSession(token: string): Promise<boolean> {
        if (!token) {
            return false;
        }
        return this.store.deleteSessionByTokenHash(hashSecret(token));
    }

    async revokeAllSessions(userId: string): Promise<number> {
        return this.store.deleteSessionsByUserId(userId);
    }

    async getUserById(id: string): Promise<PublicUser | null> {
        const user = await this.store.findUserById(id);
        if (!user || user.deletedAt) {
            return null;
        }
        return toPublicUser(user);
    }

    async getUserRecord(id: string): Promise<AuthUserRecord | null> {
        return this.store.findUserById(id);
    }
}

export function normalizeEmail(email: string): string | null {
    const trimmed = email.trim().toLowerCase();
    if (!trimmed || trimmed.length > MAX_EMAIL_LENGTH || !EMAIL_RE.test(trimmed)) {
        return null;
    }
    return trimmed;
}

export function isDatabaseConfigured(): boolean {
    return Boolean(process.env.DATABASE_URL);
}

export function tryCreateAuthServiceFromEnv(): AuthService | null {
    if (!isDatabaseConfigured()) {
        return null;
    }
    try {
        return new AuthService({
            store: new PgAuthStore(getDb()),
            mailer: new ConsoleMagicLinkMailer(),
            appUrl: process.env.DIALY_APP_URL ?? process.env.APP_URL ?? "http://127.0.0.1:5173",
        });
    } catch {
        return null;
    }
}

function toPublicUser(user: AuthUserRecord): PublicUser {
    return {
        id: user.id,
        email: user.email,
        displayName: user.displayName,
        locale: user.locale,
    };
}
