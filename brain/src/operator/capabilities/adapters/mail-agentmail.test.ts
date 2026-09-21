import { describe, expect, it } from "vitest";

import { MailAdapter } from "./mail-agentmail.js";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function createAdapter(fetchImpl: typeof fetch) {
  return new MailAdapter({
    apiKey: "am_test",
    inboxId: "dialy@agentmail.to",
    fetchImpl,
  });
}

describe("MailAdapter", () => {
  it("is unavailable without AgentMail credentials", async () => {
    const adapter = new MailAdapter({ apiKey: "", inboxId: "", fetchImpl: async () => jsonResponse({}) });
    await expect(adapter.isAvailable()).resolves.toBe(false);
    await expect(adapter.execute("mail.draft", {}, {})).resolves.toMatchObject({
      ok: false,
      unavailable: true,
      capability: "mail.draft",
    });
  });

  it("drafts locally for playbook intent args and never sends", async () => {
    const urls: string[] = [];
    const adapter = createAdapter(async (url) => {
      urls.push(String(url));
      return jsonResponse({});
    });

    const result = await adapter.execute("mail.draft", { intent: "request-missing-docs" }, { signalId: "sig-1" });
    expect(result).toMatchObject({
      ok: true,
      capability: "mail.draft",
      data: { provider: "agentmail", sent: false, draft: { intent: "request-missing-docs", signalId: "sig-1" } },
    });
    expect(urls).toEqual([]);
  });

  it("creates a remote draft without calling send", async () => {
    const urls: string[] = [];
    const adapter = createAdapter(async (url, init) => {
      urls.push(`${init?.method ?? "GET"} ${String(url)}`);
      return jsonResponse({ inbox_id: "dialy@agentmail.to", draft_id: "draft_9", labels: [] });
    });

    const result = await adapter.execute(
      "mail.draft",
      { to: "ravi@client.in", subject: "Missing docs", body: "Please send PAN and GST." },
      { signalId: "sig-2" },
    );

    expect(result.ok).toBe(true);
    expect(result.data).toMatchObject({ sent: false, draft: { draftId: "draft_9" } });
    expect(urls).toEqual(["POST https://api.agentmail.to/v0/inboxes/dialy%40agentmail.to/drafts"]);
    expect(urls.some((url) => url.includes("/send"))).toBe(false);
  });

  it("refuses mail.send until confirmed=true", async () => {
    const urls: string[] = [];
    const adapter = createAdapter(async (url) => {
      urls.push(String(url));
      return jsonResponse({});
    });

    const result = await adapter.execute(
      "mail.send",
      { to: "ravi@client.in", body: "Please send PAN." },
      { signalId: "sig-3" },
    );
    expect(result).toMatchObject({
      ok: false,
      capability: "mail.send",
      data: { sent: false, needsApproval: true },
    });
    expect(urls).toEqual([]);
  });

  it("sends only after confirmed=true", async () => {
    const adapter = createAdapter(async (url, init) => {
      expect(String(url)).toContain("/messages/send");
      expect(init?.headers).toMatchObject({ "Idempotency-Key": "sig-4" });
      return jsonResponse({ message_id: "msg_sent", thread_id: "thd_sent" });
    });

    const result = await adapter.execute(
      "mail.send",
      { confirmed: true, to: "ravi@client.in", subject: "Follow-up", body: "Please send PAN." },
      { signalId: "sig-4" },
    );
    expect(result).toMatchObject({
      ok: true,
      capability: "mail.send",
      data: { sent: true, messageId: "msg_sent", threadId: "thd_sent" },
    });
  });

  it("returns a failed CapabilityResult when AgentMail errors", async () => {
    const adapter = createAdapter(async () => jsonResponse({ message: "validation failed" }, 400));
    await expect(
      adapter.execute(
        "mail.send",
        { confirmed: true, to: "ravi@client.in", body: "Please send PAN." },
        {},
      ),
    ).resolves.toMatchObject({
      ok: false,
      capability: "mail.send",
      error: "validation failed",
      data: { status: 400 },
    });
  });

  it("loads mail.thread and lists mail.attachments metadata without downloading", async () => {
    const urls: string[] = [];
    const adapter = createAdapter(async (url) => {
      urls.push(String(url));
      return jsonResponse({
        inbox_id: "dialy@agentmail.to",
        thread_id: "thd_docs",
        labels: ["received"],
        senders: ["ravi@client.in"],
        recipients: ["dialy@agentmail.to"],
        last_message_id: "msg_1",
        message_count: 2,
        subject: "Docs",
        attachments: [{ attachment_id: "att_1", size: 10, filename: "pan.pdf", content_type: "application/pdf" }],
        messages: [
          {
            inbox_id: "dialy@agentmail.to",
            thread_id: "thd_docs",
            message_id: "msg_1",
            labels: ["received"],
            timestamp: "2026-09-21T00:00:00Z",
            from: "ravi@client.in",
            to: ["dialy@agentmail.to"],
            subject: "Docs",
            text: "Please send PAN.",
            attachments: [{ attachment_id: "att_1", size: 10, filename: "pan.pdf" }],
          },
        ],
      });
    });

    const thread = await adapter.execute(
      "mail.thread",
      { threadId: "thd_docs", includeHistory: true },
      { signalId: "sig-5" },
    );
    expect(thread).toMatchObject({
      ok: true,
      capability: "mail.thread",
      data: {
        thread: {
          threadId: "thd_docs",
          messageCount: 2,
          messages: [{ messageId: "msg_1", from: "ravi@client.in" }],
        },
      },
    });

    const attachments = await adapter.execute(
      "mail.attachments",
      { threadId: "thd_docs", metadataOnly: true },
      { signalId: "sig-5" },
    );
    expect(attachments).toMatchObject({
      ok: true,
      capability: "mail.attachments",
      data: {
        metadataOnly: true,
        attachments: [{ attachmentId: "att_1", filename: "pan.pdf" }],
      },
    });
    expect(urls.every((url) => !url.includes("/attachments/att_1"))).toBe(true);
  });

  it("fails mail.thread without throwing when ids are missing", async () => {
    const adapter = createAdapter(async () => jsonResponse({}));
    await expect(adapter.execute("mail.thread", {}, {})).resolves.toMatchObject({
      ok: false,
      capability: "mail.thread",
      error: "mail.thread requires inboxId and threadId.",
    });
  });
});
