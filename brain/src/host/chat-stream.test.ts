import { EventEmitter } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import { describe, expect, it, vi, type Mock } from "vitest";
import type { TurnStreamEvent } from "@x/shared/dist/turns.js";
import type { ISessions } from "../runtime/sessions/api.js";
import { TurnEventHub } from "../runtime/turns/event-hub.js";
import { streamHostChat, type HostChatDeps } from "./chat.js";

function completedEvent(turnId: string, text: string): TurnStreamEvent {
    return {
        type: "turn_completed",
        turnId,
        ts: "2026-07-01T00:00:00Z",
        output: { role: "assistant", content: text },
        finishReason: "stop",
        usage: {},
    } as unknown as TurnStreamEvent;
}

function failedEvent(turnId: string, error: string): TurnStreamEvent {
    return {
        type: "turn_failed",
        turnId,
        ts: "2026-07-01T00:00:00Z",
        error,
        usage: {},
    } as unknown as TurnStreamEvent;
}

function askEvent(turnId: string, question: string, options?: string[]): TurnStreamEvent {
    return {
        type: "turn_suspended",
        turnId,
        ts: "2026-07-01T00:00:00Z",
        pendingPermissions: [],
        pendingAsyncTools: [
            {
                toolCallId: "call_1",
                toolId: "builtin:ask-human",
                toolName: "ask-human",
                input: { question, ...(options ? { options } : {}) },
            },
        ],
        usage: {},
    } as unknown as TurnStreamEvent;
}

function textDelta(turnId: string, delta: string): TurnStreamEvent {
    return {
        type: "text_delta",
        turnId,
        modelCallIndex: 0,
        delta,
    };
}

type SseItem =
    | { kind: "comment"; text: string }
    | { kind: "event"; event: string; data: unknown };

function parseSse(raw: string): SseItem[] {
    const items: SseItem[] = [];
    for (const block of raw.split("\n\n")) {
        if (!block.trim()) continue;
        if (block.startsWith(":")) {
            items.push({ kind: "comment", text: block.slice(1).trim() });
            continue;
        }
        const lines = block.split("\n");
        const event = lines.find((l) => l.startsWith("event:"))?.slice("event:".length).trim() ?? "message";
        const data = lines
            .filter((l) => l.startsWith("data:"))
            .map((l) => l.slice("data:".length).trimStart())
            .join("\n");
        items.push({ kind: "event", event, data: data ? JSON.parse(data) : null });
    }
    return items;
}

function sseEvents(raw: string): Array<{ event: string; data: unknown }> {
    return parseSse(raw)
        .filter((item): item is Extract<SseItem, { kind: "event" }> => item.kind === "event")
        .map(({ event, data }) => ({ event, data }));
}

interface FakeHttp {
    req: IncomingMessage;
    res: ServerResponse;
    chunks: string[];
    writeImpl: Mock<(chunk: string | Uint8Array) => boolean>;
}

function fakeHttp(): FakeHttp {
    const req = new EventEmitter() as IncomingMessage;
    const chunks: string[] = [];
    let writableEnded = false;
    const res = new EventEmitter() as ServerResponse;
    const writeImpl = vi.fn((chunk: string | Uint8Array) => {
        if (writableEnded) throw new Error("write after end");
        chunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
        return true;
    });
    Object.defineProperty(res, "writableEnded", { get: () => writableEnded });
    res.writeHead = vi.fn() as ServerResponse["writeHead"];
    res.flushHeaders = vi.fn();
    res.write = writeImpl as unknown as ServerResponse["write"];
    res.end = ((chunk?: unknown) => {
        if (chunk) writeImpl(chunk as string | Uint8Array);
        writableEnded = true;
        res.emit("finish");
        return res;
    }) as ServerResponse["end"];
    return { req, res, chunks, writeImpl };
}

function harness(send?: (publish: (event: TurnStreamEvent) => void) => Promise<{ turnId: string }>): {
    http: FakeHttp;
    bus: TurnEventHub;
    deps: HostChatDeps;
    sessions: { createSession: ReturnType<typeof vi.fn>; sendMessage: ReturnType<typeof vi.fn> };
    publish: (event: TurnStreamEvent, turnId?: string) => void;
    raw: () => string;
} {
    const bus = new TurnEventHub();
    const publish = (event: TurnStreamEvent, turnId = "t1") =>
        bus.publish({ turnId, sessionId: "s1", event });
    const sessions = {
        createSession: vi.fn(async () => "s1"),
        sendMessage: vi.fn(async () => {
            if (send) return send(publish);
            return { turnId: "t1" };
        }),
    };
    const http = fakeHttp();
    const deps: HostChatDeps = {
        sessions: sessions as unknown as ISessions,
        turnEventBus: bus,
    };
    return {
        http,
        bus,
        deps,
        sessions,
        publish,
        raw: () => http.chunks.join(""),
    };
}

describe("streamHostChat", () => {
    it("emits deltas in order and a done event with the terminal payload", async () => {
        const h = harness(async (publish) => {
            publish(textDelta("t1", "Hel"));
            publish(textDelta("t1", "lo"));
            publish(completedEvent("t1", "Hello"));
            return { turnId: "t1" };
        });

        await streamHostChat(h.http.req, h.http.res, { message: "hi", sessionId: "s1" }, h.deps);

        expect(h.sessions.createSession).not.toHaveBeenCalled();
        expect(h.http.res.writeHead).toHaveBeenCalledWith(
            200,
            expect.objectContaining({
                "Content-Type": "text/event-stream",
                "Cache-Control": "no-cache",
                Connection: "keep-alive",
                "X-Accel-Buffering": "no",
            }),
        );
        expect(h.http.res.flushHeaders).toHaveBeenCalled();
        expect(h.http.res.writableEnded).toBe(true);

        const events = sseEvents(h.raw());
        expect(events.map((e) => e.event)).toEqual(["delta", "delta", "done"]);
        expect(events[0]?.data).toEqual({ text: "Hel" });
        expect(events[1]?.data).toEqual({ text: "lo" });
        expect(events[2]?.data).toEqual({
            sessionId: "s1",
            turnId: "t1",
            status: "completed",
            text: "Hello",
        });
    });

    it("emits ask_human then done when the turn suspends for a question", async () => {
        const h = harness(async (publish) => {
            publish(askEvent("t1", "Pick a time", ["now", "later"]));
            return { turnId: "t1" };
        });

        await streamHostChat(h.http.req, h.http.res, { message: "schedule this" }, h.deps);

        const events = sseEvents(h.raw());
        expect(events.map((e) => e.event)).toEqual(["ask_human", "done"]);
        expect(events[0]?.data).toEqual({
            sessionId: "s1",
            turnId: "t1",
            toolCallId: "call_1",
            query: "Pick a time",
            options: ["now", "later"],
        });
        expect(events[1]?.data).toEqual({
            sessionId: "s1",
            turnId: "t1",
            status: "ask_human",
            text: "Pick a time",
            askHuman: {
                toolCallId: "call_1",
                query: "Pick a time",
                options: ["now", "later"],
            },
        });
        expect(h.http.res.writableEnded).toBe(true);
    });

    it("emits done (not a new event name) when the turn suspends for a tool permission", async () => {
        const h = harness(async (publish) => {
            publish({
                type: "turn_suspended",
                turnId: "t1",
                ts: "2026-07-01T00:00:00Z",
                pendingPermissions: [
                    {
                        toolCallId: "tc-mail",
                        toolName: "mail.send",
                        request: { kind: "tool", toolName: "mail.send" },
                    },
                ],
                pendingAsyncTools: [],
                usage: {},
            } as unknown as TurnStreamEvent);
            return { turnId: "t1" };
        });

        await streamHostChat(h.http.req, h.http.res, { message: "send the email" }, h.deps);

        const events = sseEvents(h.raw());
        expect(events.map((e) => e.event)).toEqual(["done"]);
        expect(events[0]?.data).toEqual({
            sessionId: "s1",
            turnId: "t1",
            status: "suspended",
            text: "Waiting for your approval.",
        });
        expect(h.http.res.writableEnded).toBe(true);
    });

    it("unsubscribes and clears the heartbeat on client disconnect", async () => {
        const intervalHandle = { unref: vi.fn() } as unknown as NodeJS.Timeout;
        const setIntervalSpy = vi.spyOn(globalThis, "setInterval").mockReturnValue(intervalHandle);
        const clearIntervalSpy = vi.spyOn(globalThis, "clearInterval");

        const h = harness();
        const running = streamHostChat(
            h.http.req,
            h.http.res,
            { message: "hi", sessionId: "s1" },
            h.deps,
        );

        await vi.waitFor(() => expect(h.sessions.sendMessage).toHaveBeenCalled());
        h.publish(textDelta("t1", "partial"));
        await vi.waitFor(() => expect(h.raw()).toContain("partial"));

        const writesAfterDelta = h.http.writeImpl.mock.calls.length;
        expect(setIntervalSpy).toHaveBeenCalled();

        h.http.req.emit("close");
        await running;

        expect(clearIntervalSpy).toHaveBeenCalledWith(intervalHandle);
        expect(h.http.res.writableEnded).toBe(true);

        h.publish(textDelta("t1", "after-close"));
        h.publish(completedEvent("t1", "should not appear"));
        await Promise.resolve();
        await Promise.resolve();

        expect(h.http.writeImpl.mock.calls.length).toBe(writesAfterDelta);
        expect(h.raw()).not.toContain("after-close");
        expect(h.raw()).not.toContain("should not appear");
        expect(sseEvents(h.raw()).some((e) => e.event === "done")).toBe(false);
    });

    it("emits an error event and closes the stream when the turn fails", async () => {
        const h = harness(async (publish) => {
            publish(textDelta("t1", "almost"));
            publish(failedEvent("t1", "model exploded"));
            return { turnId: "t1" };
        });

        await streamHostChat(h.http.req, h.http.res, { message: "hi", sessionId: "s1" }, h.deps);

        const events = sseEvents(h.raw());
        expect(events.map((e) => e.event)).toEqual(["delta", "error", "done"]);
        expect(events[1]?.data).toEqual({ error: "model exploded" });
        expect(events[2]?.data).toEqual({
            sessionId: "s1",
            turnId: "t1",
            status: "failed",
            text: null,
            error: "model exploded",
        });
        expect(h.http.res.writableEnded).toBe(true);
    });

    it("emits an error event when sendMessage throws", async () => {
        const h = harness();
        h.sessions.sendMessage.mockRejectedValueOnce(new Error("session locked"));

        await streamHostChat(h.http.req, h.http.res, { message: "hi", sessionId: "s1" }, h.deps);

        const events = sseEvents(h.raw());
        expect(events.map((e) => e.event)).toEqual(["error"]);
        expect(events[0]?.data).toEqual({ error: "session locked" });
        expect(h.http.res.writableEnded).toBe(true);
    });

    it("waits for drain instead of queueing unboundedly when write returns false", async () => {
        const h = harness();
        let backpressured = true;
        h.http.writeImpl.mockImplementation((chunk: string | Uint8Array) => {
            h.http.chunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
            return !backpressured;
        });

        const running = streamHostChat(
            h.http.req,
            h.http.res,
            { message: "hi", sessionId: "s1" },
            h.deps,
        );
        await vi.waitFor(() => expect(h.sessions.sendMessage).toHaveBeenCalled());

        h.publish(textDelta("t1", "one"));
        await vi.waitFor(() => expect(h.raw()).toContain("one"));
        const writesBlocked = h.http.writeImpl.mock.calls.length;

        h.publish(textDelta("t1", "two"));
        h.publish(completedEvent("t1", "one two"));
        await Promise.resolve();
        await Promise.resolve();
        expect(h.http.writeImpl.mock.calls.length).toBe(writesBlocked);
        expect(h.raw()).not.toContain("two");

        backpressured = false;
        h.http.res.emit("drain");
        await running;

        const events = sseEvents(h.raw());
        expect(events.map((e) => e.event)).toEqual(["delta", "delta", "done"]);
        expect(h.http.res.writableEnded).toBe(true);
    });
});
