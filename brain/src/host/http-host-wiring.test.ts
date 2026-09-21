import http from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { MagicLinkRateLimiter } from "../auth/rate-limit.js";
import { AGENTMAIL_WEBHOOK_PATH } from "../agentmail/webhook.js";
import { createHostHttpServer } from "./http.js";
import { createOperatorStores } from "./operator-stores.js";

const ENV_KEYS = [
    "DATABASE_URL",
    "BRAIN_TOKEN",
    "DIALY_DEFAULT_USER_ID",
    "BRAIN_ALLOW_ANONYMOUS",
    "NODE_ENV",
    "AGENTMAIL_WEBHOOK_SECRET",
    "LIVEKIT_URL",
    "LIVEKIT_API_KEY",
    "LIVEKIT_API_SECRET",
    "BRAIN_TRUSTED_PROXY_HOPS",
    "OPERATOR_SCHEDULER",
    "OPERATOR_DRAIN",
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
): Promise<{ status: number; body: unknown }> {
    const res = await fetch(`${baseUrl}${path}`, init);
    const text = await res.text();
    let body: unknown = text;
    try {
        body = text ? JSON.parse(text) : null;
    } catch {
        body = text;
    }
    return { status: res.status, body };
}

describe("host wiring HTTP", () => {
    let env: ReturnType<typeof snapshotEnv>;

    beforeEach(() => {
        env = snapshotEnv();
        delete process.env.DATABASE_URL;
        delete process.env.BRAIN_TOKEN;
        delete process.env.DIALY_DEFAULT_USER_ID;
        delete process.env.AGENTMAIL_WEBHOOK_SECRET;
        delete process.env.LIVEKIT_URL;
        delete process.env.LIVEKIT_API_KEY;
        delete process.env.LIVEKIT_API_SECRET;
        delete process.env.BRAIN_TRUSTED_PROXY_HOPS;
        process.env.OPERATOR_SCHEDULER = "off";
        process.env.OPERATOR_DRAIN = "off";
    });

    afterEach(() => {
        restoreEnv(env);
    });

    it("serves health with no environment configured", async () => {
        expect(() => createOperatorStores({})).not.toThrow();
        const server = createHostHttpServer({ auth: null });
        const { baseUrl, close } = await listen(server);
        try {
            const res = await jsonRequest(baseUrl, "/health");
            expect(res.status).not.toBe(401);
            expect(res.body).toMatchObject({ service: "brain", package: "@x/core" });
            const routes = (res.body as { routes?: Record<string, string> }).routes ?? {};
            expect(routes["POST /v1/operator/webhook/agentmail"]).toBeTruthy();
            expect(routes["POST /v1/voice/token"]).toBeTruthy();
        } finally {
            await close();
        }
    });

    it("rejects a bad AgentMail signature without requiring a bearer token", async () => {
        process.env.BRAIN_TOKEN = "lab-secret";
        process.env.AGENTMAIL_WEBHOOK_SECRET = "whsec_c2VjcmV0LXZhbHVlLWZvci10ZXN0cw==";
        const server = createHostHttpServer({ auth: null });
        const { baseUrl, close } = await listen(server);
        try {
            const res = await jsonRequest(baseUrl, AGENTMAIL_WEBHOOK_PATH, {
                method: "POST",
                headers: {
                    "content-type": "application/json",
                    "svix-id": "msg_1",
                    "svix-timestamp": "1770000000",
                    "svix-signature": "v1,aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa=",
                },
                body: "{not-valid-json",
            });
            expect(res.body).not.toMatchObject({ error: "unauthorized" });
            expect(res.status).toBe(401);
            expect(res.body).toMatchObject({ error: "invalid_signature" });
        } finally {
            await close();
        }
    });

    it("returns 503 for AgentMail when the webhook secret is unset, still without bearer auth", async () => {
        process.env.BRAIN_TOKEN = "lab-secret";
        const server = createHostHttpServer({ auth: null });
        const { baseUrl, close } = await listen(server);
        try {
            const res = await jsonRequest(baseUrl, AGENTMAIL_WEBHOOK_PATH, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: "{}",
            });
            expect(res.status).toBe(503);
            expect(res.body).toMatchObject({ error: "webhook_not_configured" });
        } finally {
            await close();
        }
    });

    it("errors cleanly on /v1/voice/token when LiveKit env is missing", async () => {
        process.env.BRAIN_TOKEN = "lab-secret";
        const server = createHostHttpServer({ auth: null });
        const { baseUrl, close } = await listen(server);
        try {
            const denied = await jsonRequest(baseUrl, "/v1/voice/token", {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ room_name: "r", participant_identity: "u" }),
            });
            expect(denied.status).toBe(401);

            const res = await jsonRequest(baseUrl, "/v1/voice/token", {
                method: "POST",
                headers: {
                    "content-type": "application/json",
                    authorization: "Bearer lab-secret",
                },
                body: JSON.stringify({ room_name: "r", participant_identity: "u", language: "gu-IN" }),
            });
            expect(res.status).toBe(503);
            expect(res.body).toMatchObject({ error: "voice_not_configured" });
        } finally {
            await close();
        }
    });

    it("does not let a spoofed X-Forwarded-For leftmost hop evade the magic-link limiter", async () => {
        const limiter = new MagicLinkRateLimiter({ windowMs: 60_000, maxPerEmail: 100, maxPerIp: 2 });
        const server = createHostHttpServer({ auth: null, magicLinkLimiter: limiter });
        const { baseUrl, close } = await listen(server);
        try {
            const post = (xff: string) =>
                jsonRequest(baseUrl, "/v1/auth/magic-link", {
                    method: "POST",
                    headers: { "content-type": "application/json", "x-forwarded-for": xff },
                    body: JSON.stringify({ email: `ca-${xff}@example.com` }),
                });
            const first = await post("9.9.9.9");
            const second = await post("8.8.8.8");
            const third = await post("7.7.7.7");
            expect(first.status).toBe(200);
            expect(second.status).toBe(200);
            expect(third.status).toBe(429);
            expect(third.body).toMatchObject({ error: "rate_limited" });
        } finally {
            await close();
        }
    });
});
