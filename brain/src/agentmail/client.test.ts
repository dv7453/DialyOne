import { describe, expect, it } from "vitest";

import { AgentMailApiError, AgentMailClient, AGENTMAIL_API_BASE } from "./client.js";

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
    return new Response(JSON.stringify(body), {
        status,
        headers: { "Content-Type": "application/json", ...headers },
    });
}

function binaryResponse(bytes: string, contentType: string, status = 200): Response {
    return new Response(bytes, {
        status,
        headers: { "Content-Type": contentType },
    });
}

describe("AgentMailClient", () => {
    it("POSTs send with bearer auth, snake_case body, and Idempotency-Key", async () => {
        const calls: Array<{ url: string; init: RequestInit }> = [];
        const client = new AgentMailClient({
            apiKey: "am_test",
            fetchImpl: async (url, init) => {
                calls.push({ url: String(url), init: init ?? {} });
                return jsonResponse({ message_id: "msg_1", thread_id: "thd_1" });
            },
        });

        await client.sendMessage({
            inboxId: "agent@example.com",
            to: "client@example.com",
            cc: ["cc@example.com"],
            subject: "Missing documents",
            text: "Please send the GST certificate.",
            idempotencyKey: "sig-1",
        });

        expect(calls).toHaveLength(1);
        expect(calls[0].url).toBe(`${AGENTMAIL_API_BASE}/inboxes/agent%40example.com/messages/send`);
        expect(calls[0].init.method).toBe("POST");
        expect(calls[0].init.headers).toMatchObject({
            Authorization: "Bearer am_test",
            "Content-Type": "application/json",
            "Idempotency-Key": "sig-1",
        });
        expect(JSON.parse(String(calls[0].init.body))).toEqual({
            to: ["client@example.com"],
            cc: ["cc@example.com"],
            subject: "Missing documents",
            text: "Please send the GST certificate.",
        });
    });

    it("POSTs an in-thread reply with an encoded message id", async () => {
        const calls: Array<{ url: string; init: RequestInit }> = [];
        const client = new AgentMailClient({
            apiKey: "am_test",
            fetchImpl: async (url, init) => {
                calls.push({ url: String(url), init: init ?? {} });
                return jsonResponse({ message_id: "msg_2", thread_id: "thd_1" });
            },
        });

        await client.replyToMessage({
            inboxId: "inbox_1",
            messageId: "<abc123@agentmail.to>",
            text: "Following up.",
            replyAll: true,
        });

        expect(calls[0].url).toBe(
            `${AGENTMAIL_API_BASE}/inboxes/inbox_1/messages/${encodeURIComponent("<abc123@agentmail.to>")}/reply`,
        );
        expect(JSON.parse(String(calls[0].init.body))).toEqual({
            text: "Following up.",
            reply_all: true,
        });
    });

    it("creates a draft without hitting send endpoints", async () => {
        const urls: string[] = [];
        const client = new AgentMailClient({
            apiKey: "am_test",
            fetchImpl: async (url) => {
                urls.push(String(url));
                return jsonResponse({
                    inbox_id: "inbox_1",
                    draft_id: "draft_1",
                    labels: [],
                });
            },
        });

        const draft = await client.createDraft({
            inboxId: "inbox_1",
            to: "client@example.com",
            subject: "Docs",
            text: "Please send PAN.",
            inReplyTo: "msg_1",
        });

        expect(draft.draft_id).toBe("draft_1");
        expect(urls).toEqual([`${AGENTMAIL_API_BASE}/inboxes/inbox_1/drafts`]);
        expect(urls[0]).not.toContain("/send");
    });

    it("GETs a thread and searches messages", async () => {
        const urls: string[] = [];
        const client = new AgentMailClient({
            apiKey: "am_test",
            fetchImpl: async (url) => {
                urls.push(String(url));
                if (String(url).includes("/search")) {
                    return jsonResponse({ count: 1, messages: [] });
                }
                return jsonResponse({
                    inbox_id: "inbox_1",
                    thread_id: "thd_1",
                    labels: ["received"],
                    senders: ["a@b.com"],
                    recipients: ["agent@example.com"],
                    last_message_id: "msg_1",
                    message_count: 1,
                    messages: [],
                });
            },
        });

        await client.getThread("inbox_1", "thd_1");
        await client.searchMessages({ inboxId: "inbox_1", q: "GST certificate", limit: 10 });

        expect(urls[0]).toBe(`${AGENTMAIL_API_BASE}/inboxes/inbox_1/threads/thd_1`);
        expect(urls[1]).toBe(`${AGENTMAIL_API_BASE}/inboxes/inbox_1/messages/search?q=GST+certificate&limit=10`);
    });

    it("lists attachments from a thread and fetches via download_url", async () => {
        const urls: string[] = [];
        const client = new AgentMailClient({
            apiKey: "am_test",
            fetchImpl: async (url) => {
                const href = String(url);
                urls.push(href);
                if (href.includes("/threads/thd_1") && !href.includes("/attachments/")) {
                    return jsonResponse({
                        inbox_id: "inbox_1",
                        thread_id: "thd_1",
                        labels: [],
                        senders: [],
                        recipients: [],
                        last_message_id: "msg_1",
                        message_count: 1,
                        attachments: [{ attachment_id: "att_1", size: 12, filename: "pan.pdf" }],
                        messages: [
                            {
                                inbox_id: "inbox_1",
                                thread_id: "thd_1",
                                message_id: "msg_1",
                                labels: [],
                                timestamp: "2026-09-21T00:00:00Z",
                                from: "a@b.com",
                                to: ["agent@example.com"],
                                attachments: [{ attachment_id: "att_1", size: 12, filename: "pan.pdf" }],
                            },
                        ],
                    });
                }
                if (href.includes("/attachments/att_1")) {
                    return jsonResponse({
                        attachment_id: "att_1",
                        size: 12,
                        filename: "pan.pdf",
                        content_type: "application/pdf",
                        download_url: "https://files.example/pan.pdf",
                        expires_at: "2026-09-21T01:00:00Z",
                    });
                }
                if (href === "https://files.example/pan.pdf") {
                    return binaryResponse("pdf-bytes", "application/pdf");
                }
                throw new Error(`unexpected url ${href}`);
            },
        });

        const listed = await client.listAttachments({ inboxId: "inbox_1", threadId: "thd_1" });
        expect(listed).toEqual([{ attachment_id: "att_1", size: 12, filename: "pan.pdf" }]);

        const downloaded = await client.getAttachment({
            inboxId: "inbox_1",
            threadId: "thd_1",
            attachmentId: "att_1",
        });
        expect(downloaded.download_url).toBe("https://files.example/pan.pdf");
        expect(downloaded.content_base64).toBe(Buffer.from("pdf-bytes").toString("base64"));
        expect(urls.some((url) => url.endsWith("/threads/thd_1/attachments/att_1"))).toBe(true);
    });

    it("throws a typed error on non-2xx responses", async () => {
        const client = new AgentMailClient({
            apiKey: "am_test",
            fetchImpl: async () => jsonResponse({ message: "too many requests" }, 429, { "Retry-After": "7" }),
        });

        await expect(client.sendMessage({ inboxId: "inbox_1", to: "a@b.com", text: "hi" })).rejects.toMatchObject({
            name: "AgentMailApiError",
            status: 429,
            message: "too many requests",
            retryAfter: "7",
        } satisfies Partial<AgentMailApiError>);
    });
});
