/**
 * LAN-reachable HTTP surface for the headless host.
 * Default bind stays loopback; set BRAIN_HOST=0.0.0.0 for phone tests.
 * Optional BRAIN_TOKEN requires Authorization: Bearer … or x-brain-token.
 * When a database is configured, Bearer session tokens and the dialy_session
 * cookie identify a user; BRAIN_TOKEN remains a single-tenant admin fallback.
 */
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runWithAuthContext, type AuthContext } from "../auth/context.js";
import {
    clearSessionCookieHeader,
    headerValue,
    parseCookies,
    readBearerToken,
    sessionCookieHeader,
    SESSION_COOKIE_NAME,
} from "../auth/cookies.js";
import { MagicLinkRateLimiter } from "../auth/rate-limit.js";
import { safeEqual } from "../auth/secret.js";
import {
    AuthService,
    InvalidLoginTokenError,
    normalizeEmail,
    tryCreateAuthServiceFromEnv,
    type PublicUser,
} from "../auth/service.js";
import { getChannelsStatus } from "../channels/service.js";
import { WorkDir } from "../config/config.js";
import { createPgAccountData } from "../db/account-data.js";
import { getDb } from "../db/client.js";
import { hostState } from "./state.js";
import { hostLog } from "./logger.js";
import { AGENTMAIL_WEBHOOK_PATH } from "../agentmail/webhook.js";
import {
    getOperatorApprovals,
    getOperatorCapabilities,
    getOperatorJournal,
    getOperatorPlaybookErrors,
    getOperatorPlaybooks,
    getOperatorTrust,
    handleOperatorSignal,
    ingestOperatorAgentMailWebhook,
    ingestOperatorWebhook,
    resolveOperatorApproval,
} from "./operator-boot.js";
import { answerHostAskHuman, parseHostChatRequest, runHostChat, streamHostChat } from "./chat.js";
import { synthesizeSpeech, transcribeAudio } from "../voice/voice.js";
import { clientIpFromForwarded, readTrustedProxyHops } from "./client-ip.js";
import {
    mintVoiceAccessToken,
    parseVoiceTokenRequest,
    readLiveKitCredentials,
    VoiceTokenConfigError,
} from "./voice-token.js";

const CONFIG_DIR = path.join(WorkDir, "config");
const MAX_JSON_BODY = 1024 * 1024;
const MAX_VOICE_BODY = 32 * 1024 * 1024;
const MAX_TTS_TEXT_CHARS = 5000;
const PLANNED = {
    "GET /health": "liveness + uptime",
    "GET /v1/status": "boot, config presence, channels, model_idle (never secrets)",
    "POST /v1/auth/magic-link": "request an invite-only magic link (always 200)",
    "POST /v1/auth/session": "exchange a magic-link token for a session",
    "POST /v1/auth/logout": "revoke the current session and clear cookie",
    "GET /v1/me": "current user",
    "GET /v1/account/export": "DPDP portability: everything held about the current user",
    "POST /v1/account/delete": "DPDP erasure: hard-delete the current user and all their data",
    "POST /v1/operator/signal": "ingest Signal-like JSON into the operator engine",
    "POST /v1/operator/webhook/render": "Render service events (HMAC-signed, no bearer token)",
    "POST /v1/operator/webhook/github": "GitHub workflow/check events (HMAC-signed, no bearer token)",
    "POST /v1/operator/webhook/agentmail": "AgentMail inbound mail (Svix HMAC, no bearer token)",
    "GET /v1/operator/playbooks": "list loaded operator playbooks",
    "GET /v1/operator/capabilities": "adapter availability flags (no secrets)",
    "GET /v1/operator/approvals": "list pending approval actions",
    "POST /v1/operator/approvals/resolve": "approve or deny a pending action",
    "GET /v1/operator/journal": "recent operator journal entries (newest first)",
    "GET /v1/operator/trust": "trust ledger records for the bound tenant",
    "POST /v1/chat": "session chat (copilot) — settle on turn bus",
    "POST /v1/chat/stream": "session chat SSE (delta / ask_human / done / error)",
    "POST /v1/chat/answer": "answer ask_human mid-turn",
    "POST /v1/voice/token": "mint a LiveKit join token for the call UI",
    "POST /v1/voice/transcribe": "Deepgram STT (audioBase64)",
    "POST /v1/voice/speak": "ElevenLabs TTS (text → audioBase64)",
    "GET /v1/graph": "not implemented",
    "GET /v1/connections": "not implemented",
} as const;

export type HostHttpDeps = {
    auth?: AuthService | null;
    magicLinkLimiter?: MagicLinkRateLimiter;
    cookieSecure?: boolean;
    defaultUserId?: string;
};

type ResolvedIdentity =
    | { kind: "session"; ctx: AuthContext; user: PublicUser }
    | { kind: "static_token"; ctx: AuthContext | null; user: PublicUser | null }
    | { kind: "anonymous" }
    | { kind: "unauthorized" };

function configPresent(filename: string): boolean {
    return fs.existsSync(path.join(CONFIG_DIR, filename));
}

export function allowedOrigins(): string[] {
    return (process.env.DIALY_ALLOWED_ORIGINS ?? "")
        .split(",")
        .map((origin) => origin.trim())
        .filter(Boolean);
}

/**
 * A wildcard origin makes browsers drop credentials, so the session cookie can
 * only survive a cross-origin request when a concrete origin is echoed back.
 * Without an allowlist we keep the permissive lab behaviour, which works for
 * bearer tokens but not cookies.
 */
export function corsHeaders(origin?: string): http.OutgoingHttpHeaders {
    const base: http.OutgoingHttpHeaders = {
        "access-control-allow-methods": "GET, HEAD, POST, OPTIONS",
        "access-control-allow-headers": "content-type, authorization, x-brain-token",
    };
    const allowlist = allowedOrigins();
    if (allowlist.length === 0) {
        return { ...base, "access-control-allow-origin": "*" };
    }
    if (origin && allowlist.includes(origin)) {
        return {
            ...base,
            "access-control-allow-origin": origin,
            "access-control-allow-credentials": "true",
            vary: "origin",
        };
    }
    return { ...base, vary: "origin" };
}

function json(
    res: http.ServerResponse,
    status: number,
    body: unknown,
    method = "GET",
    extraHeaders?: http.OutgoingHttpHeaders,
    origin?: string,
): void {
    const payload = JSON.stringify(body, null, 2);
    const headers: http.OutgoingHttpHeaders = {
        "content-type": "application/json; charset=utf-8",
        "content-length": Buffer.byteLength(payload),
        ...corsHeaders(origin),
        ...extraHeaders,
    };
    res.writeHead(status, headers);
    // Uptime monitors often probe with HEAD — answer without a body.
    if (method === "HEAD") {
        res.end();
        return;
    }
    res.end(payload);
}

function readJsonBody(req: http.IncomingMessage, maxBytes = MAX_JSON_BODY): Promise<unknown> {
    return new Promise((resolve, reject) => {
        let raw = "";
        req.setEncoding("utf8");
        req.on("data", (chunk) => {
            raw += chunk;
            if (raw.length > maxBytes) {
                reject(new Error("request body too large"));
                req.destroy();
            }
        });
        req.on("end", () => {
            if (!raw.trim()) {
                resolve({});
                return;
            }
            try {
                resolve(JSON.parse(raw));
            } catch (error) {
                reject(error);
            }
        });
        req.on("error", reject);
    });
}

function readRawBody(req: http.IncomingMessage, maxBytes = MAX_JSON_BODY): Promise<string> {
    return new Promise((resolve, reject) => {
        let raw = "";
        req.setEncoding("utf8");
        req.on("data", (chunk) => {
            raw += chunk;
            if (raw.length > maxBytes) {
                reject(new Error("request body too large"));
                req.destroy();
            }
        });
        req.on("end", () => resolve(raw));
        req.on("error", reject);
    });
}

const WEBHOOK_ROUTES: Record<string, "render" | "github" | "agentmail"> = {
    "/v1/operator/webhook/render": "render",
    "/v1/operator/webhook/github": "github",
    [AGENTMAIL_WEBHOOK_PATH]: "agentmail",
};

function staticBrainToken(): string | undefined {
    const token = process.env.BRAIN_TOKEN;
    return token ? token : undefined;
}

function cookieSecureDefault(): boolean {
    if (process.env.BRAIN_COOKIE_SECURE === "1" || process.env.BRAIN_COOKIE_SECURE === "true") {
        return true;
    }
    if (process.env.BRAIN_COOKIE_SECURE === "0" || process.env.BRAIN_COOKIE_SECURE === "false") {
        return false;
    }
    return process.env.NODE_ENV === "production";
}

function matchesStaticBrainToken(req: http.IncomingMessage): {
    bearerIsStatic: boolean;
    headerIsStatic: boolean;
} {
    const expected = staticBrainToken();
    if (!expected) {
        return { bearerIsStatic: false, headerIsStatic: false };
    }
    const bearer = readBearerToken(req.headers.authorization);
    const alt = headerValue(req.headers["x-brain-token"]);
    return {
        bearerIsStatic: Boolean(bearer && safeEqual(bearer, expected)),
        headerIsStatic: Boolean(alt && safeEqual(alt, expected)),
    };
}

function presentedSessionToken(req: http.IncomingMessage, bearerIsStatic: boolean): string | undefined {
    const bearer = readBearerToken(req.headers.authorization);
    if (bearer && !bearerIsStatic) {
        return bearer;
    }
    const cookies = parseCookies(req.headers.cookie);
    const fromCookie = cookies[SESSION_COOKIE_NAME];
    return fromCookie || undefined;
}

export function clientIp(req: http.IncomingMessage): string {
    return clientIpFromForwarded(
        headerValue(req.headers["x-forwarded-for"]),
        req.socket.remoteAddress,
        readTrustedProxyHops(),
    );
}

function meBody(user: PublicUser, auth: "session" | "static_token"): Record<string, unknown> {
    return {
        id: user.id,
        email: user.email || null,
        displayName: user.displayName,
        locale: user.locale,
        auth,
    };
}

function stubMe(userId: string): PublicUser {
    return { id: userId, email: null, displayName: null, locale: "en" };
}

async function resolveIdentity(
    req: http.IncomingMessage,
    auth: AuthService | null,
    defaultUserId: string | undefined,
): Promise<ResolvedIdentity> {
    const staticMatch = matchesStaticBrainToken(req);
    const sessionToken = presentedSessionToken(req, staticMatch.bearerIsStatic);
    if (sessionToken && auth) {
        const session = await auth.validateSession(sessionToken);
        if (session) {
            return {
                kind: "session",
                ctx: {
                    userId: session.user.id,
                    sessionId: session.sessionId,
                    via: "session",
                },
                user: session.user,
            };
        }
    }
    if (staticMatch.bearerIsStatic || staticMatch.headerIsStatic) {
        if (defaultUserId && auth) {
            const record = await auth.getUserRecord(defaultUserId);
            if (record?.deletedAt) {
                return { kind: "static_token", ctx: null, user: null };
            }
            if (record) {
                return {
                    kind: "static_token",
                    ctx: { userId: record.id, via: "static_token" },
                    user: {
                        id: record.id,
                        email: record.email,
                        displayName: record.displayName,
                        locale: record.locale,
                    },
                };
            }
        }
        if (defaultUserId) {
            return {
                kind: "static_token",
                ctx: { userId: defaultUserId, via: "static_token" },
                user: stubMe(defaultUserId),
            };
        }
        return { kind: "static_token", ctx: null, user: null };
    }
    if (!staticBrainToken() && allowAnonymous()) {
        return { kind: "anonymous" };
    }
    return { kind: "unauthorized" };
}

/**
 * Unauthenticated access exists only for the loopback lab host. A deployment that
 * forgets BRAIN_TOKEN must fail closed rather than serving every tenant's data to
 * anyone who finds the URL, so production and any database-backed (multi-tenant)
 * boot refuse it unless someone opts in deliberately.
 */
export function allowAnonymous(): boolean {
    if (process.env.BRAIN_ALLOW_ANONYMOUS === "1") {
        return true;
    }
    return process.env.NODE_ENV !== "production" && !process.env.DATABASE_URL;
}

export function listLanIPv4(): string[] {
    const out: string[] = [];
    for (const addrs of Object.values(os.networkInterfaces())) {
        if (!addrs) continue;
        for (const a of addrs) {
            if (a.family === "IPv4" && !a.internal) out.push(a.address);
        }
    }
    return out;
}

export function createHostHttpServer(deps: HostHttpDeps = {}): http.Server {
    let resolvedAuth: AuthService | null | undefined = Object.prototype.hasOwnProperty.call(deps, "auth")
        ? (deps.auth ?? null)
        : undefined;
    const limiter = deps.magicLinkLimiter ?? new MagicLinkRateLimiter();
    const cookieSecure = deps.cookieSecure ?? cookieSecureDefault();
    const defaultUserId = () => deps.defaultUserId ?? process.env.DIALY_DEFAULT_USER_ID ?? undefined;

    function getAuth(): AuthService | null {
        if (resolvedAuth !== undefined) {
            return resolvedAuth;
        }
        resolvedAuth = tryCreateAuthServiceFromEnv();
        return resolvedAuth;
    }

    return http.createServer((req, res) => {
        void handleRequest(req, res).catch((error) => {
            if (!res.headersSent) {
                json(res, 500, {
                    error: "internal_error",
                    message: error instanceof Error ? error.message : String(error),
                });
            }
        });
    });

    function respondHealth(res: http.ServerResponse, method: string): void {
        const uptimeSec = Math.floor((Date.now() - hostState.startedAt) / 1000);
        json(
            res,
            hostState.bootOk ? 200 : 503,
            {
                service: "brain",
                package: "@x/core",
                status: hostState.bootOk ? "ok" : "booting_or_failed",
                bootOk: hostState.bootOk,
                uptimeSec,
                model_idle: hostState.modelIdle,
                routes: PLANNED,
            },
            method,
        );
    }

    async function handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
        const method = req.method ?? "GET";
        const host = process.env.BRAIN_HOST ?? "127.0.0.1";
        const port = Number(process.env.BRAIN_PORT ?? process.env.PORT ?? 8787);
        const url = new URL(req.url ?? "/", `http://${host}:${port}`);

        if (method === "OPTIONS") {
            res.writeHead(204, corsHeaders(req.headers.origin));
            res.end();
            return;
        }

        const pathname = url.pathname.replace(/\/+$/, "") || "/";
        const webhookVendor = WEBHOOK_ROUTES[pathname];

        // Webhook senders cannot present BRAIN_TOKEN; those routes authenticate
        // by HMAC (Render/GitHub) or Svix (AgentMail) inside the ingest functions.
        if (webhookVendor) {
            if (method !== "POST") {
                json(res, 405, { error: "method_not_allowed", path: pathname });
                return;
            }

            const rawBody = await readRawBody(req);
            try {
                const result =
                    webhookVendor === "agentmail"
                        ? await ingestOperatorAgentMailWebhook(req.headers, rawBody)
                        : await ingestOperatorWebhook(webhookVendor, req.headers, rawBody);
                json(res, result.status, result.body);
            } catch (error) {
                json(res, 400, {
                    error: "invalid_webhook",
                    message: error instanceof Error ? error.message : String(error),
                });
            }
            return;
        }

        // Liveness is unauthenticated: a platform health check cannot present a
        // bearer token, and a 401 there reads as "down" and triggers a restart
        // loop. Nothing here is a secret; /v1/status keeps the config detail.
        if ((method === "GET" || method === "HEAD") && (pathname === "/" || pathname === "/health")) {
            respondHealth(res, method);
            return;
        }

        if (method === "POST" && pathname === "/v1/auth/magic-link") {
            await handleMagicLink(req, res);
            return;
        }

        if (method === "POST" && pathname === "/v1/auth/session") {
            await handleCreateSession(req, res);
            return;
        }

        const identity = await resolveIdentity(req, getAuth(), defaultUserId());
        if (identity.kind === "unauthorized") {
            json(res, 401, { error: "unauthorized", hint: "set Authorization: Bearer $BRAIN_TOKEN" });
            return;
        }

        const ctx =
            identity.kind === "session"
                ? identity.ctx
                : identity.kind === "static_token"
                  ? identity.ctx
                  : null;
        const dispatch = (): Promise<void> =>
            dispatchProtected(req, res, method, pathname, url, identity);
        if (ctx) {
            await runWithAuthContext(ctx, dispatch);
            return;
        }
        await dispatch();
    }

    async function handleMagicLink(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
        let body: unknown;
        try {
            body = await readJsonBody(req);
        } catch (error) {
            json(res, 400, {
                error: "invalid_json",
                message: error instanceof Error ? error.message : String(error),
            });
            return;
        }
        const record = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
        const email = typeof record.email === "string" ? normalizeEmail(record.email) : null;
        if (!email) {
            json(res, 400, { error: "invalid_email" });
            return;
        }
        const limited = limiter.hit(email, clientIp(req));
        if (!limited.allowed) {
            json(
                res,
                429,
                { error: "rate_limited", retryAfterSec: limited.retryAfterSec },
                "GET",
                { "retry-after": String(limited.retryAfterSec) },
            );
            return;
        }
        const auth = getAuth();
        if (!auth) {
            json(res, 200, { ok: true });
            return;
        }
        await auth.requestMagicLink(email);
        json(res, 200, { ok: true });
    }

    async function handleCreateSession(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
        const auth = getAuth();
        if (!auth) {
            json(res, 503, { error: "auth_unavailable" });
            return;
        }
        let body: unknown;
        try {
            body = await readJsonBody(req);
        } catch (error) {
            json(res, 400, {
                error: "invalid_json",
                message: error instanceof Error ? error.message : String(error),
            });
            return;
        }
        const record = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
        const token = typeof record.token === "string" ? record.token : "";
        if (!token) {
            json(res, 400, { error: "invalid_token" });
            return;
        }
        try {
            const session = await auth.consumeMagicLink(token, {
                userAgent: headerValue(req.headers["user-agent"]) ?? null,
            });
            json(
                res,
                200,
                {
                    token: session.sessionToken,
                    expiresAt: session.expiresAt.toISOString(),
                    user: session.user,
                },
                "GET",
                { "set-cookie": sessionCookieHeader(session.sessionToken, session.expiresAt, cookieSecure) },
            );
        } catch (error) {
            if (error instanceof InvalidLoginTokenError) {
                json(res, 401, { error: "invalid_token" });
                return;
            }
            throw error;
        }
    }

    /**
     * DPDP portability and erasure. Both act on the caller's own account only —
     * there is no user id in the request, because accepting one would let any
     * authenticated user export or erase somebody else's data.
     */
    async function handleAccountData(
        req: http.IncomingMessage,
        res: http.ServerResponse,
        method: string,
        pathname: string,
        identity: Exclude<ResolvedIdentity, { kind: "unauthorized" }>,
    ): Promise<void> {
        const wantsExport = pathname === "/v1/account/export";
        if (wantsExport ? method !== "GET" && method !== "HEAD" : method !== "POST") {
            json(res, 405, { error: "method_not_allowed", path: pathname }, method);
            return;
        }
        if (!process.env.DATABASE_URL) {
            json(res, 503, { error: "account_data_unavailable" }, method);
            return;
        }
        const userId = identity.kind === "anonymous" ? undefined : identity.ctx?.userId;
        if (!userId) {
            json(res, 401, { error: "unauthenticated" }, method);
            return;
        }

        const account = createPgAccountData(getDb());
        if (wantsExport) {
            const dump = await account.exportUser(userId);
            // The dump is the portability artefact; `user` and `trust` mirror the
            // shapes the app already renders so a reader is not left parsing it.
            json(
                res,
                200,
                {
                    ...dump,
                    user: dump.profile
                        ? {
                              id: dump.profile.id,
                              email: dump.profile.email || null,
                              displayName: dump.profile.displayName,
                              locale: dump.profile.locale,
                              auth: identity.kind === "session" ? "session" : "static_token",
                          }
                        : null,
                    trust: dump.trustLedger,
                },
                method,
            );
            return;
        }

        // Erasure is irreversible, so it takes an explicit confirm rather than
        // happening on a bare POST.
        let body: unknown;
        try {
            body = await readJsonBody(req);
        } catch {
            body = null;
        }
        const confirmed = (body as { confirm?: unknown } | null)?.confirm === true;
        if (!confirmed) {
            json(res, 400, { error: "confirm_required" }, method);
            return;
        }

        // Erasure must take the filesystem with it, or personal data outlives the
        // database row it was deleted from.
        const result = await account.eraseUser(userId, WorkDir);
        json(res, 200, { ok: true, ...result }, "GET", {
            "set-cookie": clearSessionCookieHeader(cookieSecure),
        });
    }

    async function dispatchProtected(
        req: http.IncomingMessage,
        res: http.ServerResponse,
        method: string,
        pathname: string,
        url: URL,
        identity: Exclude<ResolvedIdentity, { kind: "unauthorized" }>,
    ): Promise<void> {
        if (method === "POST" && pathname === "/v1/auth/logout") {
            const staticMatch = matchesStaticBrainToken(req);
            const token = presentedSessionToken(req, staticMatch.bearerIsStatic);
            const auth = getAuth();
            if (token && auth) {
                await auth.revokeSession(token);
            }
            json(res, 200, { ok: true }, "GET", { "set-cookie": clearSessionCookieHeader(cookieSecure) });
            return;
        }

        if ((method === "GET" || method === "HEAD") && pathname === "/v1/me") {
            if (identity.kind === "session") {
                json(res, 200, meBody(identity.user, "session"), method);
                return;
            }
            if (identity.kind === "static_token" && identity.user) {
                json(res, 200, meBody(identity.user, "static_token"), method);
                return;
            }
            json(res, 401, { error: "unauthenticated" }, method);
            return;
        }

        if (pathname === "/v1/account/export" || pathname === "/v1/account/delete") {
            await handleAccountData(req, res, method, pathname, identity);
            return;
        }

        if (method === "GET" && pathname === "/v1/status") {
            let channels;
            try {
                channels = getChannelsStatus();
            } catch {
                channels = { error: "channels_unavailable" };
            }
            try {
                const caps = await getOperatorCapabilities();
                json(res, 200, {
                    configDir: CONFIG_DIR,
                    bootOk: hostState.bootOk,
                    bootError: hostState.bootError ?? null,
                    uptimeSec: Math.floor((Date.now() - hostState.startedAt) / 1000),
                    model_idle: hostState.modelIdle,
                    lastWakeAt: hostState.lastWakeAt
                        ? new Date(hostState.lastWakeAt).toISOString()
                        : null,
                    lastIdleAt: hostState.lastIdleAt
                        ? new Date(hostState.lastIdleAt).toISOString()
                        : null,
                    lastInboundAt: hostState.lastInboundAt
                        ? new Date(hostState.lastInboundAt).toISOString()
                        : null,
                    lastInboundChannel: hostState.lastInboundChannel,
                    lastTurnId: hostState.lastTurnId,
                    lastModelCallAt: hostState.lastModelCallAt
                        ? new Date(hostState.lastModelCallAt).toISOString()
                        : null,
                    services: hostState.services,
                    http: hostState.http,
                    lanIpv4: listLanIPv4(),
                    channels,
                    operator: {
                        playbooks: getOperatorPlaybooks().length,
                        playbookErrors: getOperatorPlaybookErrors().length,
                    },
                    operatorAdapters: caps.flags,
                    present: {
                        models: configPresent("models.json"),
                        composio: configPresent("composio.json"),
                        channels: configPresent("channels.json"),
                        elevenlabs: configPresent("elevenlabs.json"),
                        deepgram: configPresent("deepgram.json"),
                        exaSearch: configPresent("exa-search.json"),
                        mcp: configPresent("mcp.json"),
                    },
                });
            } catch (error) {
                json(res, 500, {
                    error: "status_failed",
                    message: error instanceof Error ? error.message : String(error),
                });
            }
            return;
        }

        if (method === "GET" && pathname === "/v1/operator/capabilities") {
            try {
                const caps = await getOperatorCapabilities();
                json(res, 200, caps);
            } catch (error) {
                json(res, 500, {
                    error: "operator_capabilities_failed",
                    message: error instanceof Error ? error.message : String(error),
                });
            }
            return;
        }

        if (method === "GET" && pathname === "/v1/operator/playbooks") {
            json(res, 200, {
                playbooks: getOperatorPlaybooks(),
                errors: getOperatorPlaybookErrors(),
            });
            return;
        }

        if (method === "GET" && pathname === "/v1/operator/approvals") {
            try {
                const approvals = await getOperatorApprovals();
                json(res, 200, { approvals });
            } catch (error) {
                json(res, 500, {
                    error: "operator_approvals_failed",
                    message: error instanceof Error ? error.message : String(error),
                });
            }
            return;
        }

        if (method === "GET" && pathname === "/v1/operator/journal") {
            try {
                const entries = await getOperatorJournal(url.searchParams.get("limit"));
                json(res, 200, { entries });
            } catch (error) {
                json(res, 500, {
                    error: "operator_journal_failed",
                    message: error instanceof Error ? error.message : String(error),
                });
            }
            return;
        }

        if (method === "GET" && pathname === "/v1/operator/trust") {
            try {
                const records = await getOperatorTrust();
                json(res, 200, { records });
            } catch (error) {
                json(res, 500, {
                    error: "operator_trust_failed",
                    message: error instanceof Error ? error.message : String(error),
                });
            }
            return;
        }

        if (method === "POST" && pathname === "/v1/operator/approvals/resolve") {
            try {
                const body = await readJsonBody(req);
                const record = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
                const approvalId = typeof record.approvalId === "string" ? record.approvalId : "";
                const decision =
                    record.decision === "approve" || record.decision === "deny"
                        ? record.decision
                        : null;
                if (!approvalId || !decision) {
                    json(res, 400, {
                        error: "invalid_approval_resolve",
                        message: "Body must include approvalId and decision ('approve'|'deny').",
                    });
                    return;
                }
                const result = await resolveOperatorApproval(approvalId, decision);
                json(res, result.ok ? 200 : 404, result);
            } catch (error) {
                json(res, 400, {
                    error: "invalid_approval_resolve",
                    message: error instanceof Error ? error.message : String(error),
                });
            }
            return;
        }

        if (method === "POST" && pathname === "/v1/operator/signal") {
            try {
                const body = await readJsonBody(req);
                const result = await handleOperatorSignal(body);
                json(res, 200, result);
            } catch (error) {
                json(res, 400, {
                    error: "invalid_operator_signal",
                    message: error instanceof Error ? error.message : String(error),
                });
            }
            return;
        }

        if (method === "POST" && pathname === "/v1/chat") {
            try {
                const body = await readJsonBody(req);
                const result = await runHostChat(parseHostChatRequest(body));
                json(res, 200, result);
            } catch (error) {
                json(res, 400, {
                    error: "chat_failed",
                    message: error instanceof Error ? error.message : String(error),
                });
            }
            return;
        }

        if (method === "POST" && pathname === "/v1/chat/stream") {
            try {
                const body = await readJsonBody(req);
                await streamHostChat(req, res, parseHostChatRequest(body));
            } catch (error) {
                if (res.headersSent) {
                    return;
                }
                json(res, 400, {
                    error: "chat_failed",
                    message: error instanceof Error ? error.message : String(error),
                });
            }
            return;
        }

        if (method === "POST" && pathname === "/v1/chat/answer") {
            try {
                const body = await readJsonBody(req);
                const record = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
                const sessionId = typeof record.sessionId === "string" ? record.sessionId : "";
                const turnId = typeof record.turnId === "string" ? record.turnId : "";
                const toolCallId = typeof record.toolCallId === "string" ? record.toolCallId : "";
                const text = typeof record.text === "string" ? record.text : "";
                if (!sessionId || !turnId || !toolCallId || !text.trim()) {
                    json(res, 400, {
                        error: "invalid_chat_answer",
                        message: "Body must include sessionId, turnId, toolCallId, and text.",
                    });
                    return;
                }
                const result = await answerHostAskHuman({ sessionId, turnId, toolCallId, text });
                json(res, 200, result);
            } catch (error) {
                json(res, 400, {
                    error: "chat_answer_failed",
                    message: error instanceof Error ? error.message : String(error),
                });
            }
            return;
        }

        if (method === "POST" && pathname === "/v1/voice/token") {
            try {
                const body = await readJsonBody(req);
                const parsed = parseVoiceTokenRequest(body);
                if ("error" in parsed) {
                    json(res, 400, { error: "invalid_voice_token", message: parsed.error });
                    return;
                }
                const minted = await mintVoiceAccessToken(parsed, readLiveKitCredentials());
                json(res, 200, {
                    server_url: minted.serverUrl,
                    participant_token: minted.token,
                    room_name: minted.roomName,
                    language: minted.language,
                });
            } catch (error) {
                if (error instanceof VoiceTokenConfigError) {
                    json(res, 503, { error: "voice_not_configured", message: error.message });
                    return;
                }
                json(res, 500, {
                    error: "voice_token_failed",
                    message: error instanceof Error ? error.message : String(error),
                });
            }
            return;
        }

        if (method === "POST" && pathname === "/v1/voice/transcribe") {
            try {
                const body = await readJsonBody(req, MAX_VOICE_BODY);
                const record = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
                const audioBase64 = typeof record.audioBase64 === "string" ? record.audioBase64 : "";
                if (!audioBase64) {
                    json(res, 400, {
                        error: "bad_request",
                        message: '"audioBase64" is required',
                    });
                    return;
                }
                const mimeType =
                    typeof record.mimeType === "string" && record.mimeType
                        ? record.mimeType
                        : undefined;
                const audio = Buffer.from(audioBase64, "base64");
                if (audio.length === 0) {
                    json(res, 400, {
                        error: "bad_request",
                        message: '"audioBase64" is not valid base64 audio',
                    });
                    return;
                }
                const { transcript } = await transcribeAudio(audio, { mimeType });
                json(res, 200, { transcript });
            } catch (error) {
                json(res, 503, {
                    error: "voice_error",
                    message: error instanceof Error ? error.message : String(error),
                });
            }
            return;
        }

        if (method === "POST" && pathname === "/v1/voice/speak") {
            try {
                const body = await readJsonBody(req);
                const record = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
                const text = typeof record.text === "string" ? record.text.trim() : "";
                if (!text) {
                    json(res, 400, {
                        error: "bad_request",
                        message: '"text" is required',
                    });
                    return;
                }
                if (text.length > MAX_TTS_TEXT_CHARS) {
                    json(res, 400, {
                        error: "too_large",
                        message: `"text" exceeds ${MAX_TTS_TEXT_CHARS} chars`,
                    });
                    return;
                }
                const voiceId =
                    typeof record.voiceId === "string" && record.voiceId
                        ? record.voiceId
                        : undefined;
                const { audioBase64, mimeType } = await synthesizeSpeech(text, {
                    voiceId,
                    modelId: "eleven_turbo_v2_5",
                });
                json(res, 200, { audioBase64, mimeType });
            } catch (error) {
                json(res, 503, {
                    error: "voice_error",
                    message: error instanceof Error ? error.message : String(error),
                });
            }
            return;
        }

        if (pathname === "/v1/graph" || pathname === "/v1/connections") {
            json(res, 501, {
                error: "not_implemented",
                route: `${method} ${url.pathname}`,
            });
            return;
        }

        json(res, 404, { error: "not_found", path: url.pathname, routes: PLANNED });
    }
}

export function listenHostHttp(server: http.Server): Promise<{ host: string; port: number }> {
    const host = process.env.BRAIN_HOST ?? "127.0.0.1";
    const port = Number(process.env.BRAIN_PORT ?? process.env.PORT ?? 8787);
    return new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, host, () => {
            hostState.http = { host, port };
            const lans = listLanIPv4();
            hostLog.info(`http listening on http://${host}:${port}`, { lanIpv4: lans });
            if (host === "0.0.0.0" || host === "::") {
                for (const ip of lans) {
                    console.log(`[brain-host] phone URL: http://${ip}:${port}/health`);
                }
            }
            resolve({ host, port });
        });
    });
}
