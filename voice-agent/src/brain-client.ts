/**
 * HTTP client for Dialy's brain. This worker does not own prompts, tools, or memory.
 *
 * ## SSE protocol, as implemented by `brain/src/host/chat.ts`
 *
 * `POST ${BRAIN_URL}/v1/chat/stream`, body `{ sessionId?, message, attachments? }`,
 * auth `Authorization: Bearer ${BRAIN_TOKEN}`.
 *
 * ```
 * event: delta
 * data: {"text":"નમસ્તે "}
 *
 * event: done
 * data: {"sessionId":"…","turnId":"…","status":"ok","text":"…"}
 * ```
 *
 * `error` carries `{"error":"…"}` and is always followed by `done` with
 * `status: "failed"`. `ask_human` carries `{sessionId, turnId, toolCallId, query,
 * options?}` and is also followed by `done`; on a call we speak the `query`, since
 * hanging silently while the brain waits on a question is the worst thing a voice
 * agent can do. Answering it currently requires a fresh turn — the brain has no
 * voice-side resume path yet.
 *
 * A non-JSON `data:` line is treated as raw text.
 */

/** Named SSE event for a spoken-text fragment. */
export const SSE_EVENT_DELTA = "delta";
/** Named SSE event that ends the turn. Further events are ignored. */
export const SSE_EVENT_DONE = "done";
/** Named SSE event that fails the turn. */
export const SSE_EVENT_ERROR = "error";
/** Named SSE event carrying a clarifying question the brain needs answered. */
export const SSE_EVENT_ASK_HUMAN = "ask_human";

const DELTA_JSON_KEYS = ["text", "delta", "content"] as const;

export interface BrainTurnInput {
  sessionId: string;
  text: string;
  signal?: AbortSignal;
}

export interface BrainClient {
  streamTurn(input: BrainTurnInput): AsyncIterable<string>;
}

export interface SseEvent {
  event: string;
  data: string;
}

/**
 * Incremental SSE parser. Events are delimited by a blank line. Incomplete
 * lines stay in the buffer so a chunk split mid-event still parses correctly.
 */
export class SseParser {
  private buffer = "";

  push(chunk: string): SseEvent[] {
    this.buffer += normalizeNewlines(chunk);
    const events: SseEvent[] = [];
    let sep = this.buffer.indexOf("\n\n");
    while (sep !== -1) {
      const block = this.buffer.slice(0, sep);
      this.buffer = this.buffer.slice(sep + 2);
      const parsed = parseSseBlock(block);
      if (parsed) events.push(parsed);
      sep = this.buffer.indexOf("\n\n");
    }
    return events;
  }

  /** Parse a trailing block that never received a terminating blank line. */
  flush(): SseEvent[] {
    const leftover = this.buffer.trimEnd();
    this.buffer = "";
    if (!leftover) return [];
    const parsed = parseSseBlock(leftover);
    return parsed ? [parsed] : [];
  }
}

export function parseSseBlock(block: string): SseEvent | null {
  let event = "message";
  const dataLines: string[] = [];

  for (const rawLine of block.split("\n")) {
    const line = rawLine;
    if (!line || line.startsWith(":")) continue;

    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);

    if (field === "event") {
      event = value;
    } else if (field === "data") {
      dataLines.push(value);
    }
  }

  if (dataLines.length === 0 && event === "message") return null;
  return { event, data: dataLines.join("\n") };
}

export function textFromDeltaData(data: string): string {
  const trimmed = data.trim();
  if (!trimmed || trimmed === "[DONE]") return "";

  try {
    const json: unknown = JSON.parse(trimmed);
    if (typeof json === "string") return json;
    if (json && typeof json === "object" && !Array.isArray(json)) {
      const record = json as Record<string, unknown>;
      for (const key of DELTA_JSON_KEYS) {
        const value = record[key];
        if (typeof value === "string" && value.length > 0) return value;
      }
    }
  } catch {
    return data;
  }
  return "";
}

export function errorMessageFromData(data: string): string {
  const trimmed = data.trim();
  if (!trimmed) return "brain stream error";
  try {
    const json: unknown = JSON.parse(trimmed);
    if (typeof json === "string") return json;
    if (json && typeof json === "object" && !Array.isArray(json)) {
      const record = json as Record<string, unknown>;
      if (typeof record.error === "string") return record.error;
      if (typeof record.message === "string") return record.message;
    }
  } catch {
    return trimmed;
  }
  return trimmed;
}

export interface SseBrainClientOptions {
  baseUrl: string;
  token: string;
  fetch?: typeof fetch;
}

export class SseBrainClient implements BrainClient {
  private readonly baseUrl: string;
  private readonly token: string;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: SseBrainClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, "");
    this.token = opts.token;
    this.fetchImpl = opts.fetch ?? fetch;
  }

  async *streamTurn(input: BrainTurnInput): AsyncIterable<string> {
    const response = await this.fetchImpl(`${this.baseUrl}/v1/chat/stream`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.token}`,
        "Content-Type": "application/json",
        Accept: "text/event-stream",
      },
      body: JSON.stringify({
        sessionId: input.sessionId,
        message: input.text,
      }),
      signal: input.signal,
    });

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error(`brain stream HTTP ${response.status}${body ? `: ${body}` : ""}`);
    }
    if (!response.body) {
      throw new Error("brain stream response had no body");
    }

    const parser = new SseParser();
    for await (const chunk of readTextStream(response.body)) {
      for (const event of parser.push(chunk)) {
        const text = yieldSseEvent(event);
        if (text === END_TURN) return;
        if (text) yield text;
      }
    }
    for (const event of parser.flush()) {
      const text = yieldSseEvent(event);
      if (text === END_TURN) return;
      if (text) yield text;
    }
  }
}

const END_TURN = Symbol("end-turn");

function yieldSseEvent(event: SseEvent): string | typeof END_TURN {
  const named = event.event === "message" ? eventTypeFromData(event.data) : event.event;

  if (named === SSE_EVENT_DONE) return END_TURN;
  if (named === SSE_EVENT_ERROR) {
    throw new Error(errorMessageFromData(event.data));
  }
  if (named === SSE_EVENT_DELTA) {
    return textFromDeltaData(event.data);
  }
  if (named === SSE_EVENT_ASK_HUMAN) {
    return queryFromAskHumanData(event.data);
  }
  return "";
}

/**
 * The brain emits the question text only in `ask_human`, never as a delta, so
 * dropping this event leaves the caller listening to silence.
 */
export function queryFromAskHumanData(data: string): string {
  const trimmed = data.trim();
  if (!trimmed) return "";
  try {
    const json: unknown = JSON.parse(trimmed);
    if (json && typeof json === "object" && !Array.isArray(json)) {
      const record = json as Record<string, unknown>;
      if (typeof record.query === "string") return record.query;
    }
  } catch {
    return "";
  }
  return "";
}

function eventTypeFromData(data: string): string {
  try {
    const json: unknown = JSON.parse(data);
    if (json && typeof json === "object" && !Array.isArray(json)) {
      const type = (json as Record<string, unknown>).type;
      if (typeof type === "string") return type;
    }
  } catch {
    return "message";
  }
  return "message";
}

export class FakeBrainClient implements BrainClient {
  constructor(
    private readonly deltas:
      | readonly string[]
      | ((input: BrainTurnInput) => readonly string[] | Promise<readonly string[]>),
  ) {}

  async *streamTurn(input: BrainTurnInput): AsyncIterable<string> {
    const parts =
      typeof this.deltas === "function" ? await this.deltas(input) : this.deltas;
    for (const part of parts) {
      if (input.signal?.aborted) return;
      yield part;
    }
  }
}

function normalizeNewlines(chunk: string): string {
  return chunk.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

async function* readTextStream(body: ReadableStream<Uint8Array>): AsyncIterable<string> {
  const decoder = new TextDecoder();
  const reader = body.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      yield decoder.decode(value, { stream: true });
    }
    const tail = decoder.decode();
    if (tail) yield tail;
  } finally {
    reader.releaseLock();
  }
}
