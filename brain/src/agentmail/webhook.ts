import express, { type Request, type Response, type Router } from "express";

import {
    FailureStreaks,
    WebhookDeduper,
    verifyRenderSignature,
    type NormalizedWebhook,
    type WebhookVerification,
} from "../host/webhooks.js";
import { classifyInboundEmail } from "./classify.js";

export const AGENTMAIL_WEBHOOK_PATH = "/v1/operator/webhook/agentmail";
export const AGENTMAIL_INBOUND_EVENTS = new Set([
    "message.received",
    "message.received.unauthenticated",
]);

type HeaderMap = Record<string, string | string[] | undefined>;

export type AgentMailSignal = {
    id: string;
    source: "gmail";
    type: string;
    createdAt: string;
    payload: Record<string, unknown>;
    raw?: unknown;
};

export type AgentMailWebhookIngestResult = {
    status: number;
    body: Record<string, unknown>;
};

export type AgentMailWebhookDeps = {
    secret?: string;
    onSignal?: (signal: AgentMailSignal) => Promise<unknown> | unknown;
    deduper?: WebhookDeduper;
    failureStreaks?: FailureStreaks;
    now?: () => Date;
};

function headerValue(headers: HeaderMap, name: string): string | undefined {
    const wanted = name.toLowerCase();
    for (const [key, value] of Object.entries(headers)) {
        if (key.toLowerCase() !== wanted) {
            continue;
        }
        return Array.isArray(value) ? value[0] : value;
    }
    return undefined;
}

function asRecord(value: unknown): Record<string, unknown> {
    return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function asString(value: unknown): string | undefined {
    return typeof value === "string" && value ? value : undefined;
}

function asStringList(value: unknown): string[] {
    if (typeof value === "string" && value) {
        return [value];
    }
    if (!Array.isArray(value)) {
        return [];
    }
    return value.filter((item): item is string => typeof item === "string" && item.length > 0);
}

function firstAddress(value: unknown): string | undefined {
    const list = asStringList(value);
    return list[0] ?? asString(value);
}

export function verifyAgentMailSignature(input: {
    secret: string;
    headers: HeaderMap;
    rawBody: string;
    nowSec?: number;
}): WebhookVerification {
    return verifyRenderSignature({
        secret: input.secret,
        id: headerValue(input.headers, "svix-id"),
        timestamp: headerValue(input.headers, "svix-timestamp"),
        signature: headerValue(input.headers, "svix-signature"),
        rawBody: input.rawBody,
        nowSec: input.nowSec,
    });
}

function attachmentSummaries(value: unknown): Array<Record<string, unknown>> {
    if (!Array.isArray(value)) {
        return [];
    }
    return value.map((item) => {
        const attachment = asRecord(item);
        return {
            attachmentId: asString(attachment.attachment_id) ?? asString(attachment.attachmentId),
            filename: asString(attachment.filename),
            contentType: asString(attachment.content_type) ?? asString(attachment.contentType),
            size: typeof attachment.size === "number" ? attachment.size : undefined,
            inline: attachment.content_disposition === "inline" || attachment.inline === true,
        };
    });
}

export function normalizeAgentMailEvent(raw: unknown): NormalizedWebhook | null {
    const body = asRecord(raw);
    const eventType = asString(body.event_type);
    if (!eventType || !AGENTMAIL_INBOUND_EVENTS.has(eventType)) {
        return null;
    }

    const message = asRecord(body.message);
    const thread = asRecord(body.thread);
    const from = firstAddress(message.from) ?? firstAddress(message.from_);
    const to = asStringList(message.to);
    const subject = asString(message.subject);
    const text = asString(message.text) ?? asString(message.extracted_text);
    const html = asString(message.html);
    const preview = asString(message.preview);
    const attachments = attachmentSummaries(message.attachments);
    const classified = classifyInboundEmail({
        subject,
        text,
        html,
        preview,
        from,
        attachmentCount: attachments.length,
    });

    const inboxId = asString(message.inbox_id) ?? asString(thread.inbox_id);
    const threadId = asString(message.thread_id) ?? asString(thread.thread_id);
    const messageId = asString(message.message_id);
    const eventId = asString(body.event_id);

    return {
        source: "gmail",
        type: classified.type,
        failed: false,
        dedupeKey: eventId ?? messageId,
        payload: {
            event: classified.type,
            eventType: classified.type,
            vendorEvent: eventType,
            vendorEventId: eventId,
            inboxId,
            threadId,
            messageId,
            from,
            to,
            cc: asStringList(message.cc),
            subject,
            text,
            html,
            preview,
            labels: asStringList(message.labels),
            attachments,
            createdAt: asString(message.created_at) ?? asString(message.timestamp),
            ...classified.payload,
        },
    };
}

function rawBodyFromExpress(req: Request): string | { error: string } {
    if (Buffer.isBuffer(req.body)) {
        return req.body.toString("utf8");
    }
    if (typeof req.body === "string") {
        return req.body;
    }
    return { error: "raw body required for AgentMail signature verification" };
}

const defaultDeduper = new WebhookDeduper();
const defaultStreaks = new FailureStreaks();

export async function ingestAgentMailWebhook(
    headers: HeaderMap,
    rawBody: string,
    deps: AgentMailWebhookDeps = {},
): Promise<AgentMailWebhookIngestResult> {
    const secret = deps.secret ?? process.env.AGENTMAIL_WEBHOOK_SECRET;
    if (!secret) {
        return {
            status: 503,
            body: { error: "webhook_not_configured", message: "AGENTMAIL_WEBHOOK_SECRET is not set." },
        };
    }

    const now = deps.now ?? (() => new Date());
    const verification = verifyAgentMailSignature({
        secret,
        headers,
        rawBody,
        nowSec: Math.floor(now().getTime() / 1000),
    });
    if (!verification.ok) {
        return { status: 401, body: { error: "invalid_signature", message: verification.reason } };
    }

    let parsed: unknown;
    try {
        parsed = rawBody.trim() ? JSON.parse(rawBody) : {};
    } catch (error) {
        return {
            status: 400,
            body: { error: "invalid_json", message: error instanceof Error ? error.message : String(error) },
        };
    }

    const normalized = normalizeAgentMailEvent(parsed);
    if (!normalized) {
        return { status: 200, body: { ok: true, ignored: true, reason: "event is not operator-relevant" } };
    }

    const deliveryId =
        normalized.dedupeKey ??
        headerValue(headers, "svix-id") ??
        asString(asRecord(parsed).event_id);
    const deduper = deps.deduper ?? defaultDeduper;
    if (deduper.isDuplicate(deliveryId)) {
        return { status: 200, body: { ok: true, duplicate: true, deliveryId } };
    }

    const streaks = deps.failureStreaks ?? defaultStreaks;
    const attempt = streaks.record(asString(normalized.payload.inboxId), normalized.failed);
    const createdAt = now().toISOString();
    const signal: AgentMailSignal = {
        id: `webhook-agentmail-${deliveryId ?? Date.now()}`,
        source: "gmail",
        type: normalized.type,
        createdAt,
        payload: { ...normalized.payload, attempt },
        raw: parsed,
    };

    if (deps.onSignal) {
        void Promise.resolve(deps.onSignal(signal)).catch(() => undefined);
    }

    return {
        status: 202,
        body: {
            ok: true,
            accepted: true,
            signalId: signal.id,
            type: signal.type,
            attempt,
            signal,
        },
    };
}

export function createAgentMailWebhookRouter(deps: AgentMailWebhookDeps = {}): Router {
    const router = express.Router();
    router.post("/", express.raw({ type: "application/json" }), (req: Request, res: Response) => {
        const rawBody = rawBodyFromExpress(req);
        if (typeof rawBody !== "string") {
            res.status(400).json({ error: "invalid_body", message: rawBody.error });
            return;
        }

        void ingestAgentMailWebhook(req.headers, rawBody, deps)
            .then((result) => {
                res.status(result.status).json(result.body);
            })
            .catch((error) => {
                res.status(400).json({
                    error: "invalid_webhook",
                    message: error instanceof Error ? error.message : String(error),
                });
            });
    });
    return router;
}

export type ExpressLike = {
    use: (path: string, router: Router) => unknown;
};

export function registerAgentMailWebhook(
    app: ExpressLike,
    deps: AgentMailWebhookDeps = {},
    path = AGENTMAIL_WEBHOOK_PATH,
): Router {
    const router = createAgentMailWebhookRouter(deps);
    app.use(path, router);
    return router;
}
