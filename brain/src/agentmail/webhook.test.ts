import crypto from "node:crypto";

import { describe, expect, it } from "vitest";

import { FailureStreaks, WebhookDeduper } from "../host/webhooks.js";
import {
    AGENTMAIL_WEBHOOK_PATH,
    createAgentMailWebhookRouter,
    ingestAgentMailWebhook,
    normalizeAgentMailEvent,
    registerAgentMailWebhook,
    verifyAgentMailSignature,
} from "./webhook.js";

const SECRET = "whsec_c2VjcmV0LXZhbHVlLWZvci10ZXN0cw==";
const NOW_SEC = 1_770_000_000;

function sign(id: string, timestamp: string, body: string): string {
    const key = Buffer.from(SECRET.slice("whsec_".length), "base64");
    return `v1,${crypto.createHmac("sha256", key).update(`${id}.${timestamp}.${body}`).digest("base64")}`;
}

function signedHeaders(body: string, id = "msg_svix_1"): Record<string, string> {
    const timestamp = String(NOW_SEC);
    return {
        "svix-id": id,
        "svix-timestamp": timestamp,
        "svix-signature": sign(id, timestamp, body),
    };
}

const clientDocsPayload = {
    type: "event",
    event_type: "message.received",
    event_id: "evt_docs_1",
    message: {
        inbox_id: "dialy@agentmail.to",
        thread_id: "thd_docs",
        message_id: "<docs@agentmail.to>",
        from: "Ravi <ravi@client.in>",
        to: ["Dialy <dialy@agentmail.to>"],
        subject: "Re: missing documents for GST filing",
        text: "Please send 2 missing documents. Due in 5 days.",
        labels: ["received"],
        attachments: [],
        created_at: "2026-09-21T05:00:00.000Z",
    },
    thread: {
        inbox_id: "dialy@agentmail.to",
        thread_id: "thd_docs",
        subject: "Re: missing documents for GST filing",
        message_count: 2,
    },
};

describe("verifyAgentMailSignature", () => {
    const rawBody = JSON.stringify({ event_type: "message.received" });

    it("accepts a valid Svix signature", () => {
        expect(
            verifyAgentMailSignature({
                secret: SECRET,
                headers: signedHeaders(rawBody),
                rawBody,
                nowSec: NOW_SEC,
            }),
        ).toEqual({ ok: true });
    });

    it("rejects a bad signature", () => {
        const result = verifyAgentMailSignature({
            secret: SECRET,
            headers: {
                ...signedHeaders(rawBody),
                "svix-signature": "v1,aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa=",
            },
            rawBody,
            nowSec: NOW_SEC,
        });
        expect(result).toMatchObject({ ok: false, reason: expect.stringContaining("signature") });
    });
});

describe("normalizeAgentMailEvent", () => {
    it("maps inbound mail onto the email.client_docs playbook shape", () => {
        const normalized = normalizeAgentMailEvent(clientDocsPayload);
        expect(normalized).toMatchObject({
            source: "gmail",
            type: "email.client_docs",
            failed: false,
            dedupeKey: "evt_docs_1",
            payload: {
                event: "email.client_docs",
                eventType: "email.client_docs",
                vendorEvent: "message.received",
                inboxId: "dialy@agentmail.to",
                threadId: "thd_docs",
                messageId: "<docs@agentmail.to>",
                from: "Ravi <ravi@client.in>",
                subject: "Re: missing documents for GST filing",
                missingDocs: 2,
                complete: false,
                deadlineDays: 5,
            },
        });
    });

    it("falls back to email.important for unclassified inbound mail", () => {
        const normalized = normalizeAgentMailEvent({
            event_type: "message.received",
            event_id: "evt_2",
            message: {
                inbox_id: "inbox_1",
                thread_id: "thd_2",
                message_id: "msg_2",
                from: "Investor <vc@fund.example>",
                to: ["agent@agentmail.to"],
                subject: "Quick hello from your investor",
                text: "Can we talk Tuesday?",
            },
        });
        expect(normalized).toMatchObject({
            source: "gmail",
            type: "email.important",
            payload: {
                event: "email.important",
                eventType: "email.important",
                fromInvestor: true,
                legal: false,
                newsletter: false,
            },
        });
    });

    it("ignores spam and non-inbound events", () => {
        expect(
            normalizeAgentMailEvent({
                event_type: "message.received.spam",
                event_id: "evt_spam",
                message: { subject: "missing documents", from: "spammer@example.com" },
            }),
        ).toBeNull();
        expect(normalizeAgentMailEvent({ event_type: "message.sent", event_id: "evt_sent" })).toBeNull();
    });

    it("accepts the python-style from_ field", () => {
        const normalized = normalizeAgentMailEvent({
            event_type: "message.received",
            event_id: "evt_from",
            message: {
                inbox_id: "inbox_1",
                thread_id: "thd_1",
                message_id: "msg_1",
                from_: ["sender@example.com"],
                to: ["agent@agentmail.to"],
                subject: "Hello",
                text: "Hi",
            },
        });
        expect(normalized?.payload.from).toBe("sender@example.com");
    });
});

describe("ingestAgentMailWebhook", () => {
    it("rejects a bad signature before parsing", async () => {
        const rawBody = JSON.stringify(clientDocsPayload);
        const result = await ingestAgentMailWebhook(
            { ...signedHeaders(rawBody), "svix-signature": "v1,bad" },
            rawBody,
            { secret: SECRET, now: () => new Date(NOW_SEC * 1000) },
        );
        expect(result.status).toBe(401);
        expect(result.body.error).toBe("invalid_signature");
    });

    it("normalizes, dedupes, and returns a gmail email.* signal", async () => {
        const rawBody = JSON.stringify(clientDocsPayload);
        const signals: unknown[] = [];
        const deps = {
            secret: SECRET,
            deduper: new WebhookDeduper(),
            failureStreaks: new FailureStreaks(),
            now: () => new Date(NOW_SEC * 1000),
            onSignal: (signal: unknown) => {
                signals.push(signal);
            },
        };

        const first = await ingestAgentMailWebhook(signedHeaders(rawBody), rawBody, deps);
        expect(first.status).toBe(202);
        expect(first.body).toMatchObject({
            ok: true,
            accepted: true,
            type: "email.client_docs",
        });
        expect(first.body.signal).toMatchObject({
            source: "gmail",
            type: "email.client_docs",
            payload: {
                event: "email.client_docs",
                missingDocs: 2,
                deadlineDays: 5,
                complete: false,
            },
        });

        const second = await ingestAgentMailWebhook(signedHeaders(rawBody), rawBody, deps);
        expect(second.status).toBe(200);
        expect(second.body.duplicate).toBe(true);
        expect(signals).toHaveLength(1);
    });
});

describe("registerAgentMailWebhook", () => {
    it("exports a router mounted on the operator webhook path", () => {
        const mounted: Array<{ path: string }> = [];
        const router = registerAgentMailWebhook(
            {
                use(path) {
                    mounted.push({ path });
                },
            },
            { secret: SECRET },
        );
        expect(mounted).toEqual([{ path: AGENTMAIL_WEBHOOK_PATH }]);
        expect(typeof createAgentMailWebhookRouter().use).toBe("function");
        expect(typeof router.use).toBe("function");
    });
});
