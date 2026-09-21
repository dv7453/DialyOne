import http from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { SESSION_COOKIE_NAME } from "../auth/cookies.js";
import { MemoryAuthStore } from "../auth/memory-store.js";
import type { MagicLinkMailer, MagicLinkMessage } from "../auth/mailer.js";
import { MagicLinkRateLimiter } from "../auth/rate-limit.js";
import { AuthService } from "../auth/service.js";
import { allowAnonymous, corsHeaders, createHostHttpServer } from "./http.js";

class RecordingMailer implements MagicLinkMailer {
    readonly sent: MagicLinkMessage[] = [];

    async sendMagicLink(message: MagicLinkMessage): Promise<void> {
        this.sent.push(message);
    }
}

const ENV_KEYS = [
    "DATABASE_URL",
    "BRAIN_TOKEN",
    "DIALY_DEFAULT_USER_ID",
    "DIALY_APP_URL",
    "BRAIN_COOKIE_SECURE",
    "BRAIN_ALLOW_ANONYMOUS",
    "DIALY_ALLOWED_ORIGINS",
    "NODE_ENV",
] as const;

function snapshotEnv(): Record<(typeof ENV_KEYS)[number], string | undefined> {
    const out = {} as Record<(typeof ENV_KEYS)[number], string | undefined>;
    for (const key of ENV_KEYS) {
        out[key] = process.env[key];
    }
    return out;
}

function restoreEnv(snapshot: Record<(typeof ENV_KEYS)[number], string | undefined>): void {
    for (const key of ENV_KEYS) {
        const value = snapshot[key];
        if (value === undefined) {
            delete process.env[key];
        } else {
            process.env[key] = value;
        }
    }
}

function tokenFromUrl(url: string): string {
    const value = new URL(url).searchParams.get("token");
    if (!value) {
        throw new Error("magic link url is missing token");
    }
    return value;
}

function cookieValue(setCookie: string[] | undefined, name: string): string | undefined {
    if (!setCookie) {
        return undefined;
    }
    for (const header of setCookie) {
        if (header.startsWith(`${name}=`)) {
            const raw = header.split(";")[0]?.slice(name.length + 1) ?? "";
            return decodeURIComponent(raw);
        }
    }
    return undefined;
}

async function listen(server: http.Server): Promise<{ baseUrl: string; close: () => Promise<void> }> {
    await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", () => resolve());
    });
    const addr = server.address();
    if (!addr || typeof addr === "string") {
        throw new Error("expected tcp address");
    }
    return {
        baseUrl: `http://127.0.0.1:${addr.port}`,
        close: () =>
            new Promise((resolve, reject) => {
                server.close((error) => (error ? reject(error) : resolve()));
            }),
    };
}

async function jsonRequest(
    baseUrl: string,
    path: string,
    init: RequestInit = {},
): Promise<{ status: number; body: unknown; setCookie: string[] }> {
    const res = await fetch(`${baseUrl}${path}`, init);
    const text = await res.text();
    let body: unknown = text;
    try {
        body = text ? JSON.parse(text) : null;
    } catch {
        body = text;
    }
    return {
        status: res.status,
        body,
        setCookie: typeof res.headers.getSetCookie === "function" ? res.headers.getSetCookie() : [],
    };
}

describe("host HTTP auth", () => {
    let env: ReturnType<typeof snapshotEnv>;

    beforeEach(() => {
        env = snapshotEnv();
        delete process.env.DATABASE_URL;
        delete process.env.BRAIN_TOKEN;
        delete process.env.DIALY_DEFAULT_USER_ID;
        delete process.env.DIALY_APP_URL;
        delete process.env.BRAIN_COOKIE_SECURE;
    });

    afterEach(() => {
        restoreEnv(env);
    });

    it("boots and keeps BRAIN_TOKEN behaviour when no database is configured", async () => {
        process.env.BRAIN_TOKEN = "lab-secret";
        const server = createHostHttpServer({ auth: null });
        const { baseUrl, close } = await listen(server);
        try {
            // Liveness stays open for platform health checks; /v1/status is the
            // protected route that proves BRAIN_TOKEN is still enforced.
            const live = await jsonRequest(baseUrl, "/health");
            expect(live.status).not.toBe(401);
            expect(live.body).toMatchObject({ service: "brain", package: "@x/core" });

            const denied = await jsonRequest(baseUrl, "/v1/status");
            expect(denied.status).toBe(401);
            expect(denied.body).toMatchObject({ error: "unauthorized" });

            const ok = await jsonRequest(baseUrl, "/v1/status", {
                headers: { Authorization: "Bearer lab-secret" },
            });
            expect(ok.status).not.toBe(401);

            const alt = await jsonRequest(baseUrl, "/v1/status", {
                headers: { "x-brain-token": "lab-secret" },
            });
            expect(alt.status).not.toBe(401);

            const magic = await jsonRequest(baseUrl, "/v1/auth/magic-link", {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ email: "ca@example.com" }),
            });
            expect(magic.status).toBe(200);
            expect(magic.body).toEqual({ ok: true });

            const consume = await jsonRequest(baseUrl, "/v1/auth/session", {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ token: "not-a-real-token" }),
            });
            expect(consume.status).toBe(503);
            expect(consume.body).toMatchObject({ error: "auth_unavailable" });
        } finally {
            await close();
        }
    });

    it("allows every request when BRAIN_TOKEN is unset and no database is configured", async () => {
        const server = createHostHttpServer({ auth: null });
        const { baseUrl, close } = await listen(server);
        try {
            const res = await jsonRequest(baseUrl, "/health");
            expect(res.status).not.toBe(401);
            expect(res.body).toMatchObject({ service: "brain" });
        } finally {
            await close();
        }
    });

    it("does not require BRAIN_TOKEN on webhook routes", async () => {
        process.env.BRAIN_TOKEN = "lab-secret";
        const server = createHostHttpServer({ auth: null });
        const { baseUrl, close } = await listen(server);
        try {
            const res = await jsonRequest(baseUrl, "/v1/operator/webhook/github", {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: "{}",
            });
            expect(res.body).not.toMatchObject({ error: "unauthorized" });
            expect(res.status).toBe(503);
            expect(res.body).toMatchObject({ error: "webhook_not_configured" });
        } finally {
            await close();
        }
    });

    it("resolves the current user from a bearer session and from the httpOnly cookie", async () => {
        const store = new MemoryAuthStore();
        const mailer = new RecordingMailer();
        const service = new AuthService({ store, mailer, appUrl: "https://app.dialy.test" });
        const invited = await service.inviteUser({ email: "ca@example.com", displayName: "Ravi" });
        await service.requestMagicLink("ca@example.com");
        const magic = tokenFromUrl(mailer.sent[0]!.magicLinkUrl);

        const server = createHostHttpServer({ auth: service, cookieSecure: false });
        const { baseUrl, close } = await listen(server);
        try {
            const created = await jsonRequest(baseUrl, "/v1/auth/session", {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ token: magic }),
            });
            expect(created.status).toBe(200);
            const createdBody = created.body as { token: string; user: { id: string } };
            expect(createdBody.user.id).toBe(invited.id);
            const cookie = cookieValue(created.setCookie, SESSION_COOKIE_NAME);
            expect(cookie).toBe(createdBody.token);
            expect(created.setCookie[0]).toMatch(/HttpOnly/i);
            expect(created.setCookie[0]).toMatch(/SameSite=Lax/i);
            expect(created.setCookie[0]).not.toMatch(/Secure/i);

            const viaBearer = await jsonRequest(baseUrl, "/v1/me", {
                headers: { Authorization: `Bearer ${createdBody.token}` },
            });
            expect(viaBearer.status).toBe(200);
            expect(viaBearer.body).toMatchObject({
                id: invited.id,
                email: "ca@example.com",
                displayName: "Ravi",
                auth: "session",
            });

            const viaCookie = await jsonRequest(baseUrl, "/v1/me", {
                headers: { cookie: `${SESSION_COOKIE_NAME}=${cookie}` },
            });
            expect(viaCookie.status).toBe(200);
            expect(viaCookie.body).toMatchObject({ id: invited.id, auth: "session" });

            const replay = await jsonRequest(baseUrl, "/v1/auth/session", {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ token: magic }),
            });
            expect(replay.status).toBe(401);
            expect(replay.body).toMatchObject({ error: "invalid_token" });

            const logout = await jsonRequest(baseUrl, "/v1/auth/logout", {
                method: "POST",
                headers: { Authorization: `Bearer ${createdBody.token}` },
            });
            expect(logout.status).toBe(200);
            expect(cookieValue(logout.setCookie, SESSION_COOKIE_NAME)).toBe("");

            const after = await jsonRequest(baseUrl, "/v1/me", {
                headers: { Authorization: `Bearer ${createdBody.token}` },
            });
            expect(after.status).toBe(401);
        } finally {
            await close();
        }
    });

    it("returns the same magic-link response for unknown emails and does not send mail", async () => {
        const store = new MemoryAuthStore();
        const mailer = new RecordingMailer();
        const service = new AuthService({ store, mailer });
        await service.inviteUser({ email: "ca@example.com" });

        const server = createHostHttpServer({ auth: service });
        const { baseUrl, close } = await listen(server);
        try {
            const unknown = await jsonRequest(baseUrl, "/v1/auth/magic-link", {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ email: "unknown@example.com" }),
            });
            const known = await jsonRequest(baseUrl, "/v1/auth/magic-link", {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ email: "ca@example.com" }),
            });
            expect(unknown).toMatchObject({ status: 200, body: { ok: true } });
            expect(known).toMatchObject({ status: 200, body: { ok: true } });
            expect(mailer.sent).toHaveLength(1);
            expect(store.usersByEmail.has("unknown@example.com")).toBe(false);
        } finally {
            await close();
        }
    });

    it("rate-limits magic-link requests per email", async () => {
        const store = new MemoryAuthStore();
        const mailer = new RecordingMailer();
        const service = new AuthService({ store, mailer });
        const limiter = new MagicLinkRateLimiter({ windowMs: 60_000, maxPerEmail: 2, maxPerIp: 20 });
        const server = createHostHttpServer({ auth: service, magicLinkLimiter: limiter });
        const { baseUrl, close } = await listen(server);
        try {
            const body = JSON.stringify({ email: "ca@example.com" });
            const headers = { "content-type": "application/json" };
            const first = await jsonRequest(baseUrl, "/v1/auth/magic-link", { method: "POST", headers, body });
            const second = await jsonRequest(baseUrl, "/v1/auth/magic-link", { method: "POST", headers, body });
            const third = await jsonRequest(baseUrl, "/v1/auth/magic-link", { method: "POST", headers, body });
            expect(first.status).toBe(200);
            expect(second.status).toBe(200);
            expect(third.status).toBe(429);
            expect(third.body).toMatchObject({ error: "rate_limited" });
        } finally {
            await close();
        }
    });

    it("binds BRAIN_TOKEN to DIALY_DEFAULT_USER_ID when a session is absent", async () => {
        const store = new MemoryAuthStore();
        const mailer = new RecordingMailer();
        const service = new AuthService({ store, mailer });
        const invited = await service.inviteUser({ email: "admin@example.com", displayName: "Founder" });
        process.env.BRAIN_TOKEN = "admin-secret";
        process.env.DIALY_DEFAULT_USER_ID = invited.id;

        const server = createHostHttpServer({ auth: service, defaultUserId: invited.id });
        const { baseUrl, close } = await listen(server);
        try {
            const denied = await jsonRequest(baseUrl, "/v1/me");
            expect(denied.status).toBe(401);

            const me = await jsonRequest(baseUrl, "/v1/me", {
                headers: { Authorization: "Bearer admin-secret" },
            });
            expect(me.status).toBe(200);
            expect(me.body).toMatchObject({
                id: invited.id,
                email: "admin@example.com",
                auth: "static_token",
            });
        } finally {
            await close();
        }
    });
});

describe("allowAnonymous", () => {
    let env: ReturnType<typeof snapshotEnv>;

    beforeEach(() => {
        env = snapshotEnv();
        delete process.env.BRAIN_ALLOW_ANONYMOUS;
        delete process.env.DATABASE_URL;
        delete process.env.NODE_ENV;
    });

    afterEach(() => {
        restoreEnv(env);
    });

    it("permits an unauthenticated loopback lab host", () => {
        expect(allowAnonymous()).toBe(true);
    });

    it("refuses when a missing BRAIN_TOKEN would expose production", () => {
        process.env.NODE_ENV = "production";
        expect(allowAnonymous()).toBe(false);
    });

    it("refuses whenever a database makes the host multi-tenant", () => {
        process.env.DATABASE_URL = "postgres://localhost/dialy";
        expect(allowAnonymous()).toBe(false);
    });

    it("yields only to an explicit opt-in", () => {
        process.env.NODE_ENV = "production";
        process.env.DATABASE_URL = "postgres://localhost/dialy";
        process.env.BRAIN_ALLOW_ANONYMOUS = "1";
        expect(allowAnonymous()).toBe(true);
    });
});

describe("corsHeaders", () => {
    let env: ReturnType<typeof snapshotEnv>;

    beforeEach(() => {
        env = snapshotEnv();
        delete process.env.DIALY_ALLOWED_ORIGINS;
    });

    afterEach(() => {
        restoreEnv(env);
    });

    it("stays wildcard and credential-free without an allowlist", () => {
        const headers = corsHeaders("https://app.dialy.in");
        expect(headers["access-control-allow-origin"]).toBe("*");
        expect(headers["access-control-allow-credentials"]).toBeUndefined();
    });

    it("echoes an allowed origin so the session cookie survives", () => {
        process.env.DIALY_ALLOWED_ORIGINS = "https://app.dialy.in, http://127.0.0.1:5173";
        const headers = corsHeaders("https://app.dialy.in");
        expect(headers["access-control-allow-origin"]).toBe("https://app.dialy.in");
        expect(headers["access-control-allow-credentials"]).toBe("true");
        expect(headers.vary).toBe("origin");
    });

    it("omits the origin header entirely for a stranger", () => {
        process.env.DIALY_ALLOWED_ORIGINS = "https://app.dialy.in";
        const headers = corsHeaders("https://evil.example");
        expect(headers["access-control-allow-origin"]).toBeUndefined();
        expect(headers["access-control-allow-credentials"]).toBeUndefined();
    });
});
