import { getTableName } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { authSessions, loginTokens } from "../db/auth-schema.js";
import { MemoryAuthStore } from "./memory-store.js";
import type { MagicLinkMailer, MagicLinkMessage } from "./mailer.js";
import {
    AuthService,
    InvalidLoginTokenError,
    LOGIN_TOKEN_TTL_MS,
    SESSION_TTL_MS,
    UserDeletedError,
} from "./service.js";
import { hashSecret } from "./secret.js";

class RecordingMailer implements MagicLinkMailer {
    readonly sent: MagicLinkMessage[] = [];

    async sendMagicLink(message: MagicLinkMessage): Promise<void> {
        this.sent.push(message);
    }
}

function tokenFromUrl(url: string): string {
    const value = new URL(url).searchParams.get("token");
    if (!value) {
        throw new Error("magic link url is missing token");
    }
    return value;
}

function makeService(clock: { now: Date }) {
    const store = new MemoryAuthStore();
    const mailer = new RecordingMailer();
    const service = new AuthService({
        store,
        mailer,
        now: () => clock.now,
        appUrl: "https://app.dialy.test",
    });
    return { store, mailer, service };
}

describe("auth schema table names", () => {
    it("uses distinct SQL names that do not collide with chat sessions", () => {
        expect(getTableName(authSessions)).toBe("auth_sessions");
        expect(getTableName(loginTokens)).toBe("login_tokens");
    });
});

describe("AuthService", () => {
    it("does not leak whether an email exists and creates nothing for unknown addresses", async () => {
        const clock = { now: new Date("2026-09-21T10:00:00.000Z") };
        const { store, mailer, service } = makeService(clock);

        const known = await service.inviteUser({ email: "ca@example.com", displayName: "CA" });
        expect(known.email).toBe("ca@example.com");

        const unknown = await service.requestMagicLink("stranger@example.com");
        const knownRequest = await service.requestMagicLink("ca@example.com");

        expect(unknown).toEqual({ ok: true });
        expect(knownRequest).toEqual({ ok: true });
        expect(mailer.sent).toHaveLength(1);
        expect(mailer.sent[0]?.email).toBe("ca@example.com");
        expect(store.loginTokensByHash.size).toBe(1);
        expect(store.usersByEmail.has("stranger@example.com")).toBe(false);
        expect(await store.findUserByEmail("stranger@example.com")).toBeNull();
    });

    it("treats a deleted user like an unknown email when requesting a link", async () => {
        const clock = { now: new Date("2026-09-21T10:00:00.000Z") };
        const { store, mailer, service } = makeService(clock);
        const user = await service.inviteUser({ email: "gone@example.com" });
        store.markDeleted(user.id, clock.now);

        await expect(service.requestMagicLink("gone@example.com")).resolves.toEqual({ ok: true });
        expect(mailer.sent).toHaveLength(0);
        expect(store.loginTokensByHash.size).toBe(0);
    });

    it("stores only the hash of a magic-link token", async () => {
        const clock = { now: new Date("2026-09-21T10:00:00.000Z") };
        const { store, mailer, service } = makeService(clock);
        await service.inviteUser({ email: "ca@example.com" });
        await service.requestMagicLink("ca@example.com");
        const raw = tokenFromUrl(mailer.sent[0]!.magicLinkUrl);
        expect([...store.loginTokensByHash.keys()]).toEqual([hashSecret(raw)]);
        expect([...store.loginTokensByHash.keys()][0]).not.toBe(raw);
    });

    it("exchanges a magic-link token once and rejects replay", async () => {
        const clock = { now: new Date("2026-09-21T10:00:00.000Z") };
        const { mailer, service } = makeService(clock);
        await service.inviteUser({ email: "ca@example.com" });
        await service.requestMagicLink("CA@example.com");
        const raw = tokenFromUrl(mailer.sent[0]!.magicLinkUrl);

        const first = await service.consumeMagicLink(raw);
        expect(first.user.email).toBe("ca@example.com");
        expect(first.sessionToken).toMatch(/^[A-Za-z0-9_-]+$/);
        expect(first.expiresAt.getTime() - clock.now.getTime()).toBe(SESSION_TTL_MS);

        await expect(service.consumeMagicLink(raw)).rejects.toBeInstanceOf(InvalidLoginTokenError);
    });

    it("rejects an expired magic-link token", async () => {
        const clock = { now: new Date("2026-09-21T10:00:00.000Z") };
        const { mailer, service } = makeService(clock);
        await service.inviteUser({ email: "ca@example.com" });
        await service.requestMagicLink("ca@example.com");
        const raw = tokenFromUrl(mailer.sent[0]!.magicLinkUrl);

        clock.now = new Date(clock.now.getTime() + LOGIN_TOKEN_TTL_MS + 1);
        await expect(service.consumeMagicLink(raw)).rejects.toBeInstanceOf(InvalidLoginTokenError);
    });

    it("validates a session and rejects it after revoke", async () => {
        const clock = { now: new Date("2026-09-21T10:00:00.000Z") };
        const { store, mailer, service } = makeService(clock);
        const invited = await service.inviteUser({ email: "ca@example.com" });
        await service.requestMagicLink("ca@example.com");
        const session = await service.consumeMagicLink(tokenFromUrl(mailer.sent[0]!.magicLinkUrl));

        const validated = await service.validateSession(session.sessionToken);
        expect(validated?.user.id).toBe(invited.id);
        expect(validated?.sessionId).toBeTruthy();
        clock.now = new Date(clock.now.getTime() + 5_000);
        await service.validateSession(session.sessionToken);
        const stored = [...store.sessionsByHash.values()][0];
        expect(stored?.lastSeenAt.getTime()).toBe(clock.now.getTime());

        await expect(service.revokeSession(session.sessionToken)).resolves.toBe(true);
        await expect(service.validateSession(session.sessionToken)).resolves.toBeNull();
    });

    it("revokes every session for a user", async () => {
        const clock = { now: new Date("2026-09-21T10:00:00.000Z") };
        const { mailer, service } = makeService(clock);
        await service.inviteUser({ email: "ca@example.com" });
        await service.requestMagicLink("ca@example.com");
        const a = await service.consumeMagicLink(tokenFromUrl(mailer.sent[0]!.magicLinkUrl));
        await service.requestMagicLink("ca@example.com");
        const b = await service.consumeMagicLink(tokenFromUrl(mailer.sent[1]!.magicLinkUrl));

        await expect(service.revokeAllSessions(a.user.id)).resolves.toBe(2);
        await expect(service.validateSession(a.sessionToken)).resolves.toBeNull();
        await expect(service.validateSession(b.sessionToken)).resolves.toBeNull();
    });

    it("rejects a session whose user has been deleted", async () => {
        const clock = { now: new Date("2026-09-21T10:00:00.000Z") };
        const { store, mailer, service } = makeService(clock);
        const invited = await service.inviteUser({ email: "ca@example.com" });
        await service.requestMagicLink("ca@example.com");
        const session = await service.consumeMagicLink(tokenFromUrl(mailer.sent[0]!.magicLinkUrl));
        store.markDeleted(invited.id, clock.now);

        await expect(service.validateSession(session.sessionToken)).resolves.toBeNull();
        await expect(service.inviteUser({ email: "ca@example.com" })).rejects.toBeInstanceOf(UserDeletedError);
    });

    it("rejects an expired session", async () => {
        const clock = { now: new Date("2026-09-21T10:00:00.000Z") };
        const { mailer, service } = makeService(clock);
        await service.inviteUser({ email: "ca@example.com" });
        await service.requestMagicLink("ca@example.com");
        const session = await service.consumeMagicLink(tokenFromUrl(mailer.sent[0]!.magicLinkUrl));
        clock.now = new Date(clock.now.getTime() + SESSION_TTL_MS + 1);
        await expect(service.validateSession(session.sessionToken)).resolves.toBeNull();
    });

    it("invite is idempotent for an active email", async () => {
        const clock = { now: new Date("2026-09-21T10:00:00.000Z") };
        const { service } = makeService(clock);
        const first = await service.inviteUser({ email: "CA@Example.com", displayName: "One" });
        const second = await service.inviteUser({ email: "ca@example.com", displayName: "Two" });
        expect(second.id).toBe(first.id);
        expect(second.displayName).toBe("One");
    });
});
