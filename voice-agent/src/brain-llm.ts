import {
  APIConnectionError,
  APIStatusError,
  DEFAULT_API_CONNECT_OPTIONS,
  llm,
  type APIConnectOptions,
} from "@livekit/agents";
import type { BrainClient } from "./brain-client.js";

/**
 * LiveKit LLM adapter that forwards each user turn to the brain and streams
 * text deltas into TTS. No prompts, tools, or memory live here.
 *
 * Empty `text` (typical of the opening `generateReply` with no user speech)
 * is forwarded as-is so the brain can greet. That empty-text convention is
 * provisional and must be reconciled with the brain.
 */
export class BrainLLM extends llm.LLM {
  readonly labelName = "dialy.BrainLLM";

  constructor(
    private readonly client: BrainClient,
    private readonly sessionId: string,
  ) {
    super();
  }

  label(): string {
    return this.labelName;
  }

  override get model(): string {
    return "brain";
  }

  override get provider(): string {
    return "dialy-brain";
  }

  chat({
    chatCtx,
    connOptions = DEFAULT_API_CONNECT_OPTIONS,
  }: {
    chatCtx: llm.ChatContext;
    toolCtx?: llm.ToolContextLike;
    connOptions?: APIConnectOptions;
    parallelToolCalls?: boolean;
    toolChoice?: llm.ToolChoice;
    extraKwargs?: Record<string, unknown>;
  }): llm.LLMStream {
    return new BrainLLMStream(this, {
      chatCtx,
      connOptions,
      client: this.client,
      sessionId: this.sessionId,
    });
  }
}

/**
 * The opening `generateReply()` fires before the caller has said anything, but
 * the brain rejects an empty `message`. Send a sentinel the persona can greet on
 * rather than an empty string, which fails the request outright.
 */
export const CALL_OPENING_MESSAGE = "[call connected]";

class BrainLLMStream extends llm.LLMStream {
  private readonly client: BrainClient;
  private readonly sessionId: string;

  constructor(
    llmInstance: BrainLLM,
    opts: {
      chatCtx: llm.ChatContext;
      connOptions: APIConnectOptions;
      client: BrainClient;
      sessionId: string;
    },
  ) {
    super(llmInstance, { chatCtx: opts.chatCtx, connOptions: opts.connOptions });
    this.client = opts.client;
    this.sessionId = opts.sessionId;
  }

  protected async run(): Promise<void> {
    const requestId = crypto.randomUUID();
    const text = extractUserText(this.chatCtx) || CALL_OPENING_MESSAGE;

    try {
      for await (const delta of this.client.streamTurn({
        sessionId: this.sessionId,
        text,
        signal: this.abortController.signal,
      })) {
        if (this.abortController.signal.aborted) return;
        if (!delta) continue;
        this.queue.put({
          id: requestId,
          delta: { role: "assistant", content: delta },
        });
      }
    } catch (error) {
      if (this.abortController.signal.aborted) return;
      throw toLlmApiError(error);
    }
  }
}

export function extractUserText(chatCtx: {
  items: ReadonlyArray<{ type?: string; role?: string; textContent?: string }>;
}): string {
  for (let i = chatCtx.items.length - 1; i >= 0; i--) {
    const item = chatCtx.items[i];
    if (item && item.type === "message" && item.role === "user") {
      return item.textContent?.trim() ?? "";
    }
  }
  return "";
}

function toLlmApiError(error: unknown): Error {
  if (error instanceof APIStatusError || error instanceof APIConnectionError) {
    return error;
  }
  const message = error instanceof Error ? error.message : String(error);
  const http = /HTTP (\d{3})/.exec(message);
  if (http) {
    const statusCode = Number(http[1]);
    return new APIStatusError({
      message,
      options: { statusCode, retryable: statusCode >= 500 },
    });
  }
  return new APIConnectionError({ message, options: { retryable: true } });
}
