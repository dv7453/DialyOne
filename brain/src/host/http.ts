/**
 * LAN-reachable HTTP surface for the headless host.
 * Default bind stays loopback; set BRAIN_HOST=0.0.0.0 for phone tests.
 * Optional BRAIN_TOKEN requires Authorization: Bearer … or x-brain-token.
 */
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { getChannelsStatus } from "../channels/service.js";
import { WorkDir } from "../config/config.js";
import { hostState } from "./state.js";
import { hostLog } from "./logger.js";
import {
    getOperatorApprovals,
    getOperatorCapabilities,
    getOperatorPlaybookErrors,
    getOperatorPlaybooks,
    handleOperatorSignal,
    ingestOperatorWebhook,
    resolveOperatorApproval,
} from "./operator-boot.js";
import { answerHostAskHuman, runHostChat } from "./chat.js";
import { synthesizeSpeech, transcribeAudio } from "../voice/voice.js";

const CONFIG_DIR = path.join(WorkDir, "config");
const MAX_JSON_BODY = 1024 * 1024;
const MAX_VOICE_BODY = 32 * 1024 * 1024;
const MAX_TTS_TEXT_CHARS = 5000;

const PLANNED = {
    "GET /health": "liveness + uptime",
    "GET /v1/status": "boot, config presence, channels, model_idle (never secrets)",
    "POST /v1/operator/signal": "ingest Signal-like JSON into the operator engine",
    "POST /v1/operator/webhook/render": "Render service events (HMAC-signed, no bearer token)",
    "POST /v1/operator/webhook/github": "GitHub workflow/check events (HMAC-signed, no bearer token)",
    "GET /v1/operator/playbooks": "list loaded operator playbooks",
    "GET /v1/operator/capabilities": "adapter availability flags (no secrets)",
    "GET /v1/operator/approvals": "list pending approval actions",
    "POST /v1/operator/approvals/resolve": "approve or deny a pending action",
    "POST /v1/chat": "session chat (copilot) — settle on turn bus",
    "POST /v1/chat/answer": "answer ask_human mid-turn",
    "POST /v1/voice/transcribe": "Deepgram STT (audioBase64)",
    "POST /v1/voice/speak": "ElevenLabs TTS (text → audioBase64)",
    "GET /v1/graph": "not implemented",
    "GET /v1/connections": "not implemented",
} as const;

function configPresent(filename: string): boolean {
    return fs.existsSync(path.join(CONFIG_DIR, filename));
}

function json(res: http.ServerResponse, status: number, body: unknown, method = "GET"): void {
    const payload = JSON.stringify(body, null, 2);
    const headers: http.OutgoingHttpHeaders = {
        "content-type": "application/json; charset=utf-8",
        "content-length": Buffer.byteLength(payload),
        "access-control-allow-origin": "*",
        "access-control-allow-methods": "GET, HEAD, POST, OPTIONS",
        "access-control-allow-headers": "content-type, authorization, x-brain-token",
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

const WEBHOOK_ROUTES: Record<string, "render" | "github"> = {
    "/v1/operator/webhook/render": "render",
    "/v1/operator/webhook/github": "github",
};

function authorized(req: http.IncomingMessage): boolean {
    const token = process.env.BRAIN_TOKEN;
    if (!token) return true;
    const header = req.headers.authorization;
    if (typeof header === "string" && header === `Bearer ${token}`) return true;
    const alt = req.headers["x-brain-token"];
    if (typeof alt === "string" && alt === token) return true;
    return false;
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

export function createHostHttpServer(): http.Server {
    return http.createServer((req, res) => {
        const method = req.method ?? "GET";
        const host = process.env.BRAIN_HOST ?? "127.0.0.1";
        const port = Number(process.env.BRAIN_PORT ?? process.env.PORT ?? 8787);
        const url = new URL(req.url ?? "/", `http://${host}:${port}`);

        if (method === "OPTIONS") {
            res.writeHead(204, {
                "access-control-allow-origin": "*",
                "access-control-allow-methods": "GET, HEAD, POST, OPTIONS",
                "access-control-allow-headers": "content-type, authorization, x-brain-token",
            });
            res.end();
            return;
        }

        const pathname = url.pathname.replace(/\/+$/, "") || "/";
        const webhookVendor = WEBHOOK_ROUTES[pathname];

        // Webhook senders cannot present BRAIN_TOKEN; those routes authenticate
        // by HMAC signature inside ingestOperatorWebhook instead.
        if (!webhookVendor && !authorized(req)) {
            json(res, 401, { error: "unauthorized", hint: "set Authorization: Bearer $BRAIN_TOKEN" });
            return;
        }

        if (webhookVendor) {
            if (method !== "POST") {
                json(res, 405, { error: "method_not_allowed", path: pathname });
                return;
            }

            void readRawBody(req)
                .then((rawBody) => ingestOperatorWebhook(webhookVendor, req.headers, rawBody))
                .then((result) => json(res, result.status, result.body))
                .catch((error) => {
                    json(res, 400, {
                        error: "invalid_webhook",
                        message: error instanceof Error ? error.message : String(error),
                    });
                });
            return;
        }

        if ((method === "GET" || method === "HEAD") && (pathname === "/" || pathname === "/health")) {
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
            return;
        }

        if (method === "GET" && pathname === "/v1/status") {
            let channels;
            try {
                channels = getChannelsStatus();
            } catch {
                channels = { error: "channels_unavailable" };
            }
            void getOperatorCapabilities()
                .then((caps) => {
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
                })
                .catch((error) => {
                    json(res, 500, {
                        error: "status_failed",
                        message: error instanceof Error ? error.message : String(error),
                    });
                });
            return;
        }

        if (method === "GET" && pathname === "/v1/operator/capabilities") {
            void getOperatorCapabilities()
                .then((caps) => json(res, 200, caps))
                .catch((error) => {
                    json(res, 500, {
                        error: "operator_capabilities_failed",
                        message: error instanceof Error ? error.message : String(error),
                    });
                });
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
            void getOperatorApprovals()
                .then((approvals) => json(res, 200, { approvals }))
                .catch((error) => {
                    json(res, 500, {
                        error: "operator_approvals_failed",
                        message: error instanceof Error ? error.message : String(error),
                    });
                });
            return;
        }

        if (method === "POST" && pathname === "/v1/operator/approvals/resolve") {
            void readJsonBody(req)
                .then(async (body) => {
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
                })
                .catch((error) => {
                    json(res, 400, {
                        error: "invalid_approval_resolve",
                        message: error instanceof Error ? error.message : String(error),
                    });
                });
            return;
        }

        if (method === "POST" && pathname === "/v1/operator/signal") {
            void readJsonBody(req)
                .then((body) => handleOperatorSignal(body))
                .then((result) => json(res, 200, result))
                .catch((error) => {
                    json(res, 400, {
                        error: "invalid_operator_signal",
                        message: error instanceof Error ? error.message : String(error),
                    });
                });
            return;
        }

        if (method === "POST" && pathname === "/v1/chat") {
            void readJsonBody(req)
                .then(async (body) => {
                    const record = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
                    const message = typeof record.message === "string" ? record.message : "";
                    const sessionId =
                        typeof record.sessionId === "string" ? record.sessionId : undefined;
                    const attachments = Array.isArray(record.attachments)
                        ? (record.attachments as Array<Record<string, unknown>>).map((a) => ({
                              name: typeof a.name === "string" ? a.name : undefined,
                              mimeType: typeof a.mimeType === "string" ? a.mimeType : undefined,
                              text: typeof a.text === "string" ? a.text : undefined,
                              summary: typeof a.summary === "string" ? a.summary : undefined,
                          }))
                        : undefined;
                    const result = await runHostChat({ sessionId, message, attachments });
                    json(res, 200, result);
                })
                .catch((error) => {
                    json(res, 400, {
                        error: "chat_failed",
                        message: error instanceof Error ? error.message : String(error),
                    });
                });
            return;
        }

        if (method === "POST" && pathname === "/v1/chat/answer") {
            void readJsonBody(req)
                .then(async (body) => {
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
                })
                .catch((error) => {
                    json(res, 400, {
                        error: "chat_answer_failed",
                        message: error instanceof Error ? error.message : String(error),
                    });
                });
            return;
        }

        if (method === "POST" && pathname === "/v1/voice/transcribe") {
            void readJsonBody(req, MAX_VOICE_BODY)
                .then(async (body) => {
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
                })
                .catch((error) => {
                    json(res, 503, {
                        error: "voice_error",
                        message: error instanceof Error ? error.message : String(error),
                    });
                });
            return;
        }

        if (method === "POST" && pathname === "/v1/voice/speak") {
            void readJsonBody(req)
                .then(async (body) => {
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
                })
                .catch((error) => {
                    json(res, 503, {
                        error: "voice_error",
                        message: error instanceof Error ? error.message : String(error),
                    });
                });
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
    });
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
