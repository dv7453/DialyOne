import { AgentMailApiError, AgentMailClient, type AgentMailClientConfig } from "../../../agentmail/client.js";
import type { CapabilityAdapter, CapabilityContext, CapabilityResult } from "../types.js";

type FetchLike = typeof fetch;

export type MailAdapterConfig = {
  apiKey?: string;
  inboxId?: string;
  fetchImpl?: FetchLike;
  client?: AgentMailClient;
  baseUrl?: string;
};

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

function asStringList(value: unknown): string[] | undefined {
  if (typeof value === "string" && value) {
    return [value];
  }
  if (!Array.isArray(value)) {
    return undefined;
  }
  const items = value.filter((item): item is string => typeof item === "string" && item.length > 0);
  return items.length ? items : undefined;
}

function fail(capability: string, error: string, data?: unknown): CapabilityResult {
  return data === undefined ? { ok: false, capability, error } : { ok: false, capability, error, data };
}

function fromCaught(capability: string, error: unknown): CapabilityResult {
  if (error instanceof AgentMailApiError) {
    return fail(capability, error.message, {
      status: error.status,
      body: error.body,
      retryAfter: error.retryAfter,
    });
  }
  return fail(capability, error instanceof Error ? error.message : String(error));
}

function buildDraftPayload(args: Record<string, unknown>, ctx: CapabilityContext): Record<string, unknown> {
  return {
    to: args.to ?? asStringList(args.to),
    cc: args.cc,
    bcc: args.bcc,
    subject: args.subject,
    body: args.body ?? args.text,
    html: args.html,
    intent: args.intent,
    tone: args.tone,
    inReplyTo: args.inReplyTo ?? args.messageId,
    threadId: args.threadId,
    inboxId: args.inboxId,
    draftId: args.draftId,
    signalId: ctx.signalId,
  };
}

function hasDraftContent(args: Record<string, unknown>): boolean {
  return Boolean(
    asString(args.to) ||
      asStringList(args.to) ||
      asString(args.subject) ||
      asString(args.body) ||
      asString(args.text) ||
      asString(args.html) ||
      asString(args.inReplyTo) ||
      asString(args.messageId),
  );
}

export class MailAdapter implements CapabilityAdapter {
  readonly id = "mail-agentmail";
  readonly capabilities = ["mail.draft", "mail.send", "mail.thread", "mail.attachments"];

  private readonly apiKey?: string;
  private readonly inboxId?: string;
  private readonly client: AgentMailClient;

  constructor(config: MailAdapterConfig = {}) {
    this.apiKey = config.apiKey ?? process.env.AGENTMAIL_API_KEY;
    this.inboxId = config.inboxId ?? process.env.AGENTMAIL_INBOX_ID;
    this.client =
      config.client ??
      new AgentMailClient({
        apiKey: this.apiKey,
        baseUrl: config.baseUrl,
        fetchImpl: config.fetchImpl,
      });
  }

  async isAvailable(): Promise<boolean> {
    return Boolean(this.apiKey && this.inboxId);
  }

  async execute(capability: string, args: Record<string, unknown>, ctx: CapabilityContext): Promise<CapabilityResult> {
    try {
      if (!(await this.isAvailable())) {
        return {
          ok: false,
          capability,
          unavailable: true,
          error: "Mail adapter requires AGENTMAIL_API_KEY and AGENTMAIL_INBOX_ID.",
        };
      }

      switch (capability) {
        case "mail.draft":
          return await this.draft(args, ctx);
        case "mail.send":
          return await this.send(args, ctx);
        case "mail.thread":
          return await this.thread(args, ctx);
        case "mail.attachments":
          return await this.attachments(args, ctx);
        default:
          return fail(capability, `Capability ${capability} is not supported by ${this.id}.`);
      }
    } catch (error) {
      return fromCaught(capability, error);
    }
  }

  private resolveInboxId(args: Record<string, unknown>): string | undefined {
    return asString(args.inboxId) ?? asString(args.inbox_id) ?? this.inboxId;
  }

  private async draft(args: Record<string, unknown>, ctx: CapabilityContext): Promise<CapabilityResult> {
    const capability = "mail.draft";
    const draft = buildDraftPayload(args, ctx);
    const inboxId = this.resolveInboxId(args);
    if (!hasDraftContent(args) || !inboxId) {
      return {
        ok: true,
        capability,
        data: { draft, provider: "agentmail", sent: false },
      };
    }

    const created = await this.client.createDraft({
      inboxId,
      to: asStringList(args.to) ?? asString(args.to),
      cc: asStringList(args.cc) ?? asString(args.cc),
      bcc: asStringList(args.bcc) ?? asString(args.bcc),
      subject: asString(args.subject),
      text: asString(args.body) ?? asString(args.text),
      html: asString(args.html),
      inReplyTo: asString(args.inReplyTo) ?? asString(args.messageId),
      replyAll: args.replyAll === true,
      clientId: asString(args.clientId),
    });

    return {
      ok: true,
      capability,
      data: {
        draft: { ...draft, draftId: created.draft_id, inboxId: created.inbox_id },
        provider: "agentmail",
        sent: false,
      },
    };
  }

  private async send(args: Record<string, unknown>, ctx: CapabilityContext): Promise<CapabilityResult> {
    const capability = "mail.send";
    const draft = buildDraftPayload(args, ctx);
    if (args.confirmed !== true) {
      return fail(capability, "mail.send requires confirmed=true before any send-capable path is used.", {
        draft,
        needsApproval: true,
        sent: false,
      });
    }

    const inboxId = this.resolveInboxId(args);
    if (!inboxId) {
      return fail(capability, "mail.send requires an inbox id.", { draft, sent: false });
    }

    const idempotencyKey = asString(args.idempotencyKey) ?? asString(ctx.signalId);
    const draftId = asString(args.draftId);
    if (draftId) {
      const sent = await this.client.sendDraft({ inboxId, draftId, idempotencyKey });
      return {
        ok: true,
        capability,
        data: {
          draft,
          provider: "agentmail",
          sent: true,
          messageId: sent.message_id,
          threadId: sent.thread_id,
        },
      };
    }

    const replyTo = asString(args.inReplyTo) ?? asString(args.messageId);
    if (replyTo) {
      const sent = await this.client.replyToMessage({
        inboxId,
        messageId: replyTo,
        to: asStringList(args.to) ?? asString(args.to),
        cc: asStringList(args.cc) ?? asString(args.cc),
        bcc: asStringList(args.bcc) ?? asString(args.bcc),
        subject: asString(args.subject),
        text: asString(args.body) ?? asString(args.text),
        html: asString(args.html),
        replyAll: args.replyAll === true,
        idempotencyKey,
      });
      return {
        ok: true,
        capability,
        data: {
          draft,
          provider: "agentmail",
          sent: true,
          messageId: sent.message_id,
          threadId: sent.thread_id,
        },
      };
    }

    const to = asStringList(args.to) ?? asString(args.to);
    const text = asString(args.body) ?? asString(args.text);
    const html = asString(args.html);
    if (!to || (!text && !html)) {
      return fail(capability, "mail.send requires to and body, a draftId, or an inReplyTo message id.", {
        draft,
        sent: false,
      });
    }

    const sent = await this.client.sendMessage({
      inboxId,
      to,
      cc: asStringList(args.cc) ?? asString(args.cc),
      bcc: asStringList(args.bcc) ?? asString(args.bcc),
      subject: asString(args.subject),
      text,
      html,
      idempotencyKey,
    });

    return {
      ok: true,
      capability,
      data: {
        draft,
        provider: "agentmail",
        sent: true,
        messageId: sent.message_id,
        threadId: sent.thread_id,
      },
    };
  }

  private async thread(args: Record<string, unknown>, ctx: CapabilityContext): Promise<CapabilityResult> {
    const capability = "mail.thread";
    const inboxId = this.resolveInboxId(args);
    const threadId = asString(args.threadId) ?? asString(args.thread_id);
    if (!inboxId || !threadId) {
      return fail(capability, "mail.thread requires inboxId and threadId.", {
        args,
        signalId: ctx.signalId,
      });
    }

    const thread = await this.client.getThread(inboxId, threadId);
    const includeHistory = args.includeHistory !== false;
    return {
      ok: true,
      capability,
      data: {
        includeHistory,
        category: args.category,
        signalId: ctx.signalId,
        thread: {
          inboxId: thread.inbox_id,
          threadId: thread.thread_id,
          subject: thread.subject,
          senders: thread.senders,
          recipients: thread.recipients,
          messageCount: thread.message_count,
          lastMessageId: thread.last_message_id,
          messages: includeHistory
            ? (thread.messages ?? []).map((message) => ({
                messageId: message.message_id,
                from: message.from,
                to: message.to,
                subject: message.subject,
                text: message.extracted_text ?? message.text,
                html: message.html,
                timestamp: message.timestamp,
                attachments: message.attachments ?? [],
              }))
            : [],
        },
      },
    };
  }

  private async attachments(args: Record<string, unknown>, ctx: CapabilityContext): Promise<CapabilityResult> {
    const capability = "mail.attachments";
    const inboxId = this.resolveInboxId(args);
    const threadId = asString(args.threadId) ?? asString(args.thread_id);
    const messageId = asString(args.messageId) ?? asString(args.message_id);
    if (!inboxId || (!threadId && !messageId)) {
      return fail(capability, "mail.attachments requires inboxId and threadId or messageId.", {
        args,
        signalId: ctx.signalId,
      });
    }

    const metadataOnly = args.metadataOnly !== false;
    const listed = await this.client.listAttachments({ inboxId, threadId, messageId });
    const attachments = listed.map((attachment) => ({
      attachmentId: attachment.attachment_id,
      filename: attachment.filename,
      contentType: attachment.content_type,
      size: attachment.size,
      inline: attachment.content_disposition === "inline",
    }));

    if (metadataOnly) {
      return {
        ok: true,
        capability,
        data: { attachments, metadataOnly: true, signalId: ctx.signalId },
      };
    }

    const contents = [];
    for (const attachment of listed) {
      const downloaded = await this.client.getAttachment({
        inboxId,
        attachmentId: attachment.attachment_id,
        threadId,
        messageId,
      });
      contents.push({
        attachmentId: downloaded.attachment_id ?? attachment.attachment_id,
        filename: downloaded.filename ?? attachment.filename,
        contentType: downloaded.content_type ?? attachment.content_type,
        size: downloaded.size ?? attachment.size,
        downloadUrl: downloaded.download_url,
        contentBase64: downloaded.content_base64,
      });
    }

    return {
      ok: true,
      capability,
      data: { attachments, contents, metadataOnly: false, signalId: ctx.signalId },
    };
  }
}
