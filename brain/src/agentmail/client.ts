export const AGENTMAIL_API_BASE = "https://api.agentmail.to/v0";

type FetchLike = typeof fetch;

export class AgentMailApiError extends Error {
    readonly status: number;
    readonly body: unknown;
    readonly retryAfter?: string;

    constructor(message: string, status: number, body?: unknown, retryAfter?: string) {
        super(message);
        this.name = "AgentMailApiError";
        this.status = status;
        this.body = body;
        this.retryAfter = retryAfter;
    }
}

export type AgentMailClientConfig = {
    apiKey?: string;
    baseUrl?: string;
    fetchImpl?: FetchLike;
};

export type AgentMailOutgoingAttachment = {
    filename?: string;
    contentType?: string;
    contentDisposition?: "inline" | "attachment";
    contentId?: string;
    content?: string;
    url?: string;
};

export type SendMessageInput = {
    inboxId: string;
    to?: string | string[];
    cc?: string | string[];
    bcc?: string | string[];
    replyTo?: string | string[];
    subject?: string;
    text?: string;
    html?: string;
    labels?: string[];
    attachments?: AgentMailOutgoingAttachment[];
    idempotencyKey?: string;
};

export type ReplyMessageInput = SendMessageInput & {
    messageId: string;
    replyAll?: boolean;
};

export type CreateDraftInput = SendMessageInput & {
    inReplyTo?: string;
    forwardOf?: string;
    replyAll?: boolean;
    clientId?: string;
};

export type SendDraftInput = {
    inboxId: string;
    draftId: string;
    addLabels?: string | string[];
    removeLabels?: string | string[];
    idempotencyKey?: string;
};

export type SearchMessagesInput = {
    inboxId: string;
    q: string;
    limit?: number;
    pageToken?: string;
    before?: string;
    after?: string;
};

export type AgentMailAttachment = {
    attachment_id: string;
    size: number;
    filename?: string;
    content_type?: string;
    content_disposition?: "inline" | "attachment";
    content_id?: string;
};

export type AgentMailSendResult = {
    message_id: string;
    thread_id: string;
};

export type AgentMailDraft = {
    inbox_id: string;
    draft_id: string;
    labels: string[];
    to?: string[];
    cc?: string[];
    bcc?: string[];
    subject?: string;
    text?: string;
    html?: string;
    in_reply_to?: string;
    attachments?: AgentMailAttachment[];
    created_at?: string;
    updated_at?: string;
};

export type AgentMailMessage = {
    inbox_id: string;
    thread_id: string;
    message_id: string;
    labels: string[];
    timestamp: string;
    from: string;
    to: string[];
    subject?: string;
    preview?: string;
    text?: string;
    html?: string;
    extracted_text?: string;
    attachments?: AgentMailAttachment[];
    in_reply_to?: string;
    created_at?: string;
    updated_at?: string;
};

export type AgentMailThread = {
    inbox_id: string;
    thread_id: string;
    labels: string[];
    senders: string[];
    recipients: string[];
    last_message_id: string;
    message_count: number;
    subject?: string;
    preview?: string;
    messages: AgentMailMessage[];
    attachments?: AgentMailAttachment[];
};

export type AgentMailSearchResult = {
    count: number;
    messages: AgentMailMessage[];
    limit?: number;
    next_page_token?: string;
};

export type AgentMailAttachmentDownload = {
    attachment_id?: string;
    filename?: string;
    content_type?: string;
    size?: number;
    download_url?: string;
    expires_at?: string;
    content_base64?: string;
};

function asList(value: string | string[] | undefined): string[] | undefined {
    if (value === undefined) {
        return undefined;
    }
    return Array.isArray(value) ? value : [value];
}

function compact<T extends Record<string, unknown>>(value: T): Record<string, unknown> {
    return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined));
}

function encodeAttachment(attachment: AgentMailOutgoingAttachment): Record<string, unknown> {
    return compact({
        filename: attachment.filename,
        content_type: attachment.contentType,
        content_disposition: attachment.contentDisposition,
        content_id: attachment.contentId,
        content: attachment.content,
        url: attachment.url,
    });
}

function encodeRecipients(input: {
    to?: string | string[];
    cc?: string | string[];
    bcc?: string | string[];
    replyTo?: string | string[];
    subject?: string;
    text?: string;
    html?: string;
    labels?: string[];
    attachments?: AgentMailOutgoingAttachment[];
}): Record<string, unknown> {
    return compact({
        to: asList(input.to),
        cc: asList(input.cc),
        bcc: asList(input.bcc),
        reply_to: asList(input.replyTo),
        subject: input.subject,
        text: input.text,
        html: input.html,
        labels: input.labels,
        attachments: input.attachments?.map(encodeAttachment),
    });
}

function readErrorMessage(body: unknown, fallback: string): string {
    if (body && typeof body === "object") {
        const record = body as Record<string, unknown>;
        if (typeof record.message === "string" && record.message) {
            return record.message;
        }
        if (typeof record.error === "string" && record.error) {
            return record.error;
        }
    }
    return fallback;
}

export class AgentMailClient {
    private readonly apiKey?: string;
    private readonly baseUrl: string;
    private readonly fetchImpl: FetchLike;

    constructor(config: AgentMailClientConfig = {}) {
        this.apiKey = config.apiKey ?? process.env.AGENTMAIL_API_KEY;
        this.baseUrl = (config.baseUrl ?? process.env.AGENTMAIL_API_BASE ?? AGENTMAIL_API_BASE).replace(/\/+$/, "");
        this.fetchImpl = config.fetchImpl ?? fetch;
    }

    isConfigured(): boolean {
        return Boolean(this.apiKey);
    }

    async sendMessage(input: SendMessageInput): Promise<AgentMailSendResult> {
        return this.requestJson<AgentMailSendResult>(
            "POST",
            `/inboxes/${encodeURIComponent(input.inboxId)}/messages/send`,
            encodeRecipients(input),
            input.idempotencyKey,
        );
    }

    async replyToMessage(input: ReplyMessageInput): Promise<AgentMailSendResult> {
        return this.requestJson<AgentMailSendResult>(
            "POST",
            `/inboxes/${encodeURIComponent(input.inboxId)}/messages/${encodeURIComponent(input.messageId)}/reply`,
            compact({
                ...encodeRecipients(input),
                reply_all: input.replyAll,
            }),
            input.idempotencyKey,
        );
    }

    async createDraft(input: CreateDraftInput): Promise<AgentMailDraft> {
        return this.requestJson<AgentMailDraft>(
            "POST",
            `/inboxes/${encodeURIComponent(input.inboxId)}/drafts`,
            compact({
                ...encodeRecipients(input),
                in_reply_to: input.inReplyTo,
                forward_of: input.forwardOf,
                reply_all: input.replyAll,
                client_id: input.clientId,
            }),
        );
    }

    async sendDraft(input: SendDraftInput): Promise<AgentMailSendResult> {
        return this.requestJson<AgentMailSendResult>(
            "POST",
            `/inboxes/${encodeURIComponent(input.inboxId)}/drafts/${encodeURIComponent(input.draftId)}/send`,
            compact({
                add_labels: asList(input.addLabels),
                remove_labels: asList(input.removeLabels),
            }),
            input.idempotencyKey,
        );
    }

    async getThread(inboxId: string, threadId: string): Promise<AgentMailThread> {
        return this.requestJson<AgentMailThread>(
            "GET",
            `/inboxes/${encodeURIComponent(inboxId)}/threads/${encodeURIComponent(threadId)}`,
        );
    }

    async getMessage(inboxId: string, messageId: string): Promise<AgentMailMessage> {
        return this.requestJson<AgentMailMessage>(
            "GET",
            `/inboxes/${encodeURIComponent(inboxId)}/messages/${encodeURIComponent(messageId)}`,
        );
    }

    async searchMessages(input: SearchMessagesInput): Promise<AgentMailSearchResult> {
        const params = new URLSearchParams();
        params.set("q", input.q);
        if (input.limit !== undefined) {
            params.set("limit", String(input.limit));
        }
        if (input.pageToken) {
            params.set("page_token", input.pageToken);
        }
        if (input.before) {
            params.set("before", input.before);
        }
        if (input.after) {
            params.set("after", input.after);
        }
        return this.requestJson<AgentMailSearchResult>(
            "GET",
            `/inboxes/${encodeURIComponent(input.inboxId)}/messages/search?${params.toString()}`,
        );
    }

    async listAttachments(input: {
        inboxId: string;
        threadId?: string;
        messageId?: string;
    }): Promise<AgentMailAttachment[]> {
        if (input.messageId) {
            const message = await this.getMessage(input.inboxId, input.messageId);
            return message.attachments ?? [];
        }
        if (!input.threadId) {
            throw new AgentMailApiError("listAttachments requires threadId or messageId.", 400);
        }
        const thread = await this.getThread(input.inboxId, input.threadId);
        const seen = new Map<string, AgentMailAttachment>();
        for (const attachment of thread.attachments ?? []) {
            seen.set(attachment.attachment_id, attachment);
        }
        for (const message of thread.messages ?? []) {
            for (const attachment of message.attachments ?? []) {
                seen.set(attachment.attachment_id, attachment);
            }
        }
        return [...seen.values()];
    }

    async getAttachment(input: {
        inboxId: string;
        attachmentId: string;
        messageId?: string;
        threadId?: string;
        followDownload?: boolean;
    }): Promise<AgentMailAttachmentDownload> {
        const followDownload = input.followDownload !== false;
        let path: string;
        if (input.messageId) {
            path = `/inboxes/${encodeURIComponent(input.inboxId)}/messages/${encodeURIComponent(input.messageId)}/attachments/${encodeURIComponent(input.attachmentId)}`;
        } else if (input.threadId) {
            path = `/inboxes/${encodeURIComponent(input.inboxId)}/threads/${encodeURIComponent(input.threadId)}/attachments/${encodeURIComponent(input.attachmentId)}`;
        } else {
            throw new AgentMailApiError("getAttachment requires messageId or threadId.", 400);
        }

        const response = await this.rawRequest(path, { method: "GET" });
        const buffer = Buffer.from(await response.arrayBuffer());
        if (!response.ok) {
            let parsed: unknown = buffer.toString("utf8");
            try {
                parsed = JSON.parse(buffer.toString("utf8")) as unknown;
            } catch {
                parsed = buffer.toString("utf8");
            }
            throw new AgentMailApiError(
                readErrorMessage(parsed, `AgentMail request failed with status ${response.status}.`),
                response.status,
                parsed,
                response.headers.get("retry-after") ?? undefined,
            );
        }

        const contentType = response.headers.get("content-type") ?? "";
        if (contentType.includes("application/json")) {
            const record = JSON.parse(buffer.toString("utf8")) as Record<string, unknown>;
            const downloadUrl = typeof record.download_url === "string" ? record.download_url : undefined;
            let contentBase64: string | undefined;
            if (followDownload && downloadUrl) {
                contentBase64 = await this.fetchBinaryAsBase64(downloadUrl);
            }
            return {
                attachment_id: typeof record.attachment_id === "string" ? record.attachment_id : input.attachmentId,
                filename: typeof record.filename === "string" ? record.filename : undefined,
                content_type: typeof record.content_type === "string" ? record.content_type : undefined,
                size: typeof record.size === "number" ? record.size : undefined,
                download_url: downloadUrl,
                expires_at: typeof record.expires_at === "string" ? record.expires_at : undefined,
                content_base64: contentBase64,
            };
        }

        return {
            attachment_id: input.attachmentId,
            content_type: contentType || undefined,
            size: buffer.byteLength,
            content_base64: buffer.toString("base64"),
        };
    }

    private async fetchBinaryAsBase64(url: string): Promise<string> {
        const response = await this.fetchImpl(url);
        const buffer = Buffer.from(await response.arrayBuffer());
        if (!response.ok) {
            throw new AgentMailApiError(
                `AgentMail attachment download failed with status ${response.status}.`,
                response.status,
            );
        }
        return buffer.toString("base64");
    }

    private async requestJson<T>(
        method: string,
        path: string,
        body?: Record<string, unknown>,
        idempotencyKey?: string,
    ): Promise<T> {
        const { body: parsed } = await this.request(path, {
            method,
            body: body && method !== "GET" ? JSON.stringify(body) : undefined,
            headers: compact({
                ...(method !== "GET" ? { "Content-Type": "application/json" } : {}),
                ...(idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {}),
            }) as Record<string, string>,
        });
        return parsed as T;
    }

    private async rawRequest(path: string, init: RequestInit): Promise<Response> {
        if (!this.apiKey) {
            throw new AgentMailApiError("AgentMail API key is not configured.", 401);
        }

        const url = path.startsWith("http") ? path : `${this.baseUrl}${path.startsWith("/") ? path : `/${path}`}`;
        return this.fetchImpl(url, {
            ...init,
            headers: {
                Accept: "application/json",
                Authorization: `Bearer ${this.apiKey}`,
                ...(init.headers ?? {}),
            },
        });
    }

    private async request(
        path: string,
        init: RequestInit,
    ): Promise<{ response: Response; body: unknown }> {
        const response = await this.rawRequest(path, init);

        const rawText = await response.text();
        const contentType = response.headers.get("content-type") ?? "";
        let parsed: unknown = rawText;
        if (rawText && contentType.includes("application/json")) {
            try {
                parsed = JSON.parse(rawText) as unknown;
            } catch {
                parsed = rawText;
            }
        } else if (!rawText) {
            parsed = undefined;
        }

        if (!response.ok) {
            throw new AgentMailApiError(
                readErrorMessage(parsed, `AgentMail request failed with status ${response.status}.`),
                response.status,
                parsed,
                response.headers.get("retry-after") ?? undefined,
            );
        }

        return { response, body: parsed };
    }
}
