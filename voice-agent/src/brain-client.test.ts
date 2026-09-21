import { describe, expect, it } from "vitest";
import {
  FakeBrainClient,
  SSE_EVENT_ASK_HUMAN,
  SSE_EVENT_DELTA,
  SSE_EVENT_DONE,
  SSE_EVENT_ERROR,
  SseBrainClient,
  SseParser,
  parseSseBlock,
  queryFromAskHumanData,
  textFromDeltaData,
} from "./brain-client.js";

function collect(iter: AsyncIterable<string>): Promise<string[]> {
  return (async () => {
    const out: string[] = [];
    for await (const part of iter) out.push(part);
    return out;
  })();
}

function fetchFromChunks(chunks: string[], status = 200): typeof fetch {
  return async () => {
    const encoder = new TextEncoder();
    let i = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (i >= chunks.length) {
          controller.close();
          return;
        }
        controller.enqueue(encoder.encode(chunks[i++]!));
      },
    });
    return new Response(stream, {
      status,
      headers: { "Content-Type": "text/event-stream" },
    });
  };
}

describe("SseParser split chunks", () => {
  it("parses a complete event from one chunk", () => {
    const parser = new SseParser();
    const events = parser.push(`event: ${SSE_EVENT_DELTA}\ndata: {"text":"kem cho"}\n\n`);
    expect(events).toEqual([{ event: SSE_EVENT_DELTA, data: '{"text":"kem cho"}' }]);
  });

  it("holds a split field name across buffer boundaries", () => {
    const parser = new SseParser();
    expect(parser.push("event: del")).toEqual([]);
    const events = parser.push(`ta\ndata: {"text":"hi"}\n\n`);
    expect(events).toEqual([{ event: SSE_EVENT_DELTA, data: '{"text":"hi"}' }]);
  });

  it("holds a split JSON payload across buffer boundaries", () => {
    const parser = new SseParser();
    expect(parser.push('event: delta\ndata: {"te')).toEqual([]);
    const events = parser.push('xt":"નમસ્તે"}\n\n');
    expect(events).toEqual([{ event: SSE_EVENT_DELTA, data: '{"text":"નમસ્તે"}' }]);
  });

  it("holds a blank-line separator split across chunks", () => {
    const parser = new SseParser();
    expect(parser.push("event: delta\ndata: a\n")).toEqual([]);
    expect(parser.push("\nevent: done\ndata: {}\n\n")).toEqual([
      { event: SSE_EVENT_DELTA, data: "a" },
      { event: SSE_EVENT_DONE, data: "{}" },
    ]);
  });

  it("parses several events packed into one chunk", () => {
    const parser = new SseParser();
    const events = parser.push(
      'event: delta\ndata: {"text":"a"}\n\nevent: delta\ndata: {"text":"b"}\n\nevent: done\ndata: {}\n\n',
    );
    expect(events.map((e) => e.event)).toEqual([
      SSE_EVENT_DELTA,
      SSE_EVENT_DELTA,
      SSE_EVENT_DONE,
    ]);
  });

  it("joins multiple data lines with a newline", () => {
    const event = parseSseBlock("event: delta\ndata: hello\ndata: world");
    expect(event).toEqual({ event: SSE_EVENT_DELTA, data: "hello\nworld" });
  });

  it("ignores comment lines", () => {
    const parser = new SseParser();
    const events = parser.push(": keep-alive\n\nevent: delta\ndata: x\n\n");
    expect(events).toEqual([{ event: SSE_EVENT_DELTA, data: "x" }]);
  });
});

describe("textFromDeltaData", () => {
  it("prefers text, then delta, then content", () => {
    expect(textFromDeltaData('{"text":"a","delta":"b"}')).toBe("a");
    expect(textFromDeltaData('{"delta":"b"}')).toBe("b");
    expect(textFromDeltaData('{"content":"c"}')).toBe("c");
  });

  it("treats a non-JSON payload as raw text", () => {
    expect(textFromDeltaData("plain")).toBe("plain");
  });
});

describe("SseBrainClient", () => {
  it("yields deltas and stops on done, including split chunks", async () => {
    const client = new SseBrainClient({
      baseUrl: "http://brain.test",
      token: "secret",
      fetch: fetchFromChunks([
        "event: del",
        'ta\ndata: {"text":"નમ"}\n\nevent: delta\ndata: {"text":"સ્તે"}\n\n',
        "event: done\ndata: {}\n\n",
      ]),
    });

    await expect(
      collect(client.streamTurn({ sessionId: "s1", text: "kem cho" })),
    ).resolves.toEqual(["નમ", "સ્તે"]);
  });

  it("POSTs to /v1/chat/stream with a bearer token", async () => {
    let url = "";
    let method = "";
    let auth = "";
    let body = "";

    const client = new SseBrainClient({
      baseUrl: "http://brain.test/",
      token: "tok-1",
      fetch: async (input, init) => {
        url = String(input);
        method = init?.method ?? "";
        auth = String((init?.headers as Record<string, string>).Authorization);
        body = String(init?.body);
        return fetchFromChunks(["event: done\ndata: {}\n\n"])(input, init);
      },
    });

    await collect(client.streamTurn({ sessionId: "room-9", text: "hello" }));
    expect(url).toBe("http://brain.test/v1/chat/stream");
    expect(method).toBe("POST");
    expect(auth).toBe("Bearer tok-1");
    expect(JSON.parse(body)).toEqual({ sessionId: "room-9", message: "hello" });
  });

  it("speaks the ask_human query rather than falling silent", async () => {
    const client = new SseBrainClient({
      baseUrl: "http://brain.test",
      token: "tok-1",
      fetch: fetchFromChunks([
        `event: ${SSE_EVENT_ASK_HUMAN}\ndata: {"sessionId":"s","turnId":"t","toolCallId":"c","query":"કયા ક્લાયન્ટને?"}\n\n`,
        `event: ${SSE_EVENT_DONE}\ndata: {"sessionId":"s","turnId":"t","status":"ok","text":""}\n\n`,
      ]),
    });

    await expect(collect(client.streamTurn({ sessionId: "s", text: "file it" }))).resolves.toEqual([
      "કયા ક્લાયન્ટને?",
    ]);
  });
});

describe("queryFromAskHumanData", () => {
  it("extracts the query and stays silent on anything else", () => {
    expect(queryFromAskHumanData('{"query":"which one?"}')).toBe("which one?");
    expect(queryFromAskHumanData("not json")).toBe("");
    expect(queryFromAskHumanData("{}")).toBe("");
  });

  it("throws on a named error event", async () => {
    const client = new SseBrainClient({
      baseUrl: "http://brain.test",
      token: "secret",
      fetch: fetchFromChunks([
        `event: ${SSE_EVENT_ERROR}\ndata: {"message":"nope"}\n\n`,
      ]),
    });

    await expect(
      collect(client.streamTurn({ sessionId: "s", text: "x" })),
    ).rejects.toThrow("nope");
  });
});

describe("FakeBrainClient", () => {
  it("yields canned deltas for tests", async () => {
    const client = new FakeBrainClient(["a", "b"]);
    await expect(collect(client.streamTurn({ sessionId: "s", text: "x" }))).resolves.toEqual([
      "a",
      "b",
    ]);
  });
});
