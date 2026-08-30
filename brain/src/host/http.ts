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
    resolveOperatorApproval,
} from "./operator-boot.js";

const CONFIG_DIR = path.join(WorkDir, "config");

const PLANNED = {
    "GET /health": "liveness + uptime",
    "GET /v1/status": "boot, config presence, channels, model_idle (never secrets)",
    "POST /v1/operator/signal": "ingest Signal-like JSON into the operator engine",
    "GET /v1/operator/playbooks": "list loaded operator playbooks",
    "GET /v1/operator/capabilities": "adapter availability flags (no secrets)",
    "GET /v1/operator/approvals": "list pending approval actions",
    "POST /v1/operator/approvals/resolve": "approve or deny a pending action",
    "POST /v1/chat": "not implemented — Spike B+",
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

function readJsonBody(req: http.IncomingMessage): Promise<unknown> {
    return new Promise((resolve, reject) => {
        let raw = "";
        req.setEncoding("utf8");
        req.on("data", (chunk) => {
            raw += chunk;
            if (raw.length > 1024 * 1024) {
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

        if (!authorized(req)) {
            json(res, 401, { error: "unauthorized", hint: "set Authorization: Bearer $BRAIN_TOKEN" });
            return;
        }

        const pathname = url.pathname.replace(/\/+$/, "") || "/";

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

        if (
            pathname === "/v1/chat" ||
            pathname === "/v1/graph" ||
            pathname === "/v1/connections"
        ) {
            json(res, 501, {
                error: "not_implemented",
                route: `${method} ${url.pathname}`,
                hint: "Spike B wires chat / channel wake; this host is health + idle services only.",
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
