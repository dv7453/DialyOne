export { AgentMailApiError, AgentMailClient, AGENTMAIL_API_BASE } from "./client.js";
export type {
    AgentMailAttachment,
    AgentMailAttachmentDownload,
    AgentMailClientConfig,
    AgentMailDraft,
    AgentMailMessage,
    AgentMailOutgoingAttachment,
    AgentMailSearchResult,
    AgentMailSendResult,
    AgentMailThread,
    CreateDraftInput,
    ReplyMessageInput,
    SearchMessagesInput,
    SendDraftInput,
    SendMessageInput,
} from "./client.js";
export { classifyInboundEmail, EMAIL_SIGNAL_TYPES } from "./classify.js";
export type { EmailSignalType, InboundEmailFields } from "./classify.js";
export {
    AGENTMAIL_INBOUND_EVENTS,
    AGENTMAIL_WEBHOOK_PATH,
    createAgentMailWebhookRouter,
    ingestAgentMailWebhook,
    normalizeAgentMailEvent,
    registerAgentMailWebhook,
    verifyAgentMailSignature,
} from "./webhook.js";
export type {
    AgentMailSignal,
    AgentMailWebhookDeps,
    AgentMailWebhookIngestResult,
    ExpressLike,
} from "./webhook.js";
