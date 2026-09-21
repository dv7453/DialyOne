import { EventEmitter } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import { describe, expect, it, vi, type Mock } from "vitest";
import type { TurnStreamEvent } from "@x/shared/dist/turns.js";
import { SpendExceededError } from "../llm/index.js";
import type { ISessions } from "../runtime/sessions/api.js";
import { TurnEventHub } from "../runtime/turns/event-hub.js";
import {
    HOST_CHAT_SPEND_CAP_MESSAGE,
    runHostChat,
    streamHostChat,
    type HostChatDeps,
} from "./chat.js";

function failedEvent(turnId: string, error: string): TurnStreamEvent {
    return {
        type: "turn_failed",
        turnId,
        ts: "2026-07-01T00:00:00Z",
        error,
        usage: {},
    } as unknown as TurnStreamEvent;
}

function parseSse(raw: string): Array<{ event: string; data: unknown }> {
    const items: Array<{ event: string; data: unknown }> = [];
    for (const block of raw.split("\n\n")) {
        if (!block.trim() || block.startsWith(":")) continue;
        const lines = block.split("\n");
        const event = lines.find((l) => l.startsWith("event:"))?.slice("event:".length).trim() ?? "message";
        const data = lines
            .filter((l) => l.startsWith("data:"))
            .map((l) => l.slice("data:".length).trimStart())
            .join("\n");
        items.push({ event, data: data ? JSON.parse(data) : null });
    }
    return items;
}

function fakeHttp(): {
    req: IncomingMessage;
    res: ServerResponse;
    chunks: string[];
} {
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
    return { req, res, chunks };
}

function spendExceeded(): SpendExceededError {
    return new SpendExceededError({
        userId: "tenant-a",
        day: "2026-09-21",
        spentNanos: 500n,
        reservedNanos: 0n,
        ceilingNanos: 500n,
        remainingNanos: 0n,
    });
}

function deps(sendMessage: Mock): { deps: HostChatDeps; bus: TurnEventHub } {
    const bus = new TurnEventHub();
    return {
        bus,
        deps: {
            sessions: {
                createSession: vi.fn(async () => "s1"),
                sendMessage,
            } as unknown as ISessions,
            turnEventBus: bus,
        },
    };
}

describe("host chat spend cap", () => {
    it("returns a distinct failed payload when sendMessage throws SpendExceededError", async () => {
        const { deps: chatDeps } = deps(vi.fn(async () => {
            throw spendExceeded();
        }));
        const result = await runHostChat({ message: "hi", sessionId: "s1" }, chatDeps);
        expect(result).toEqual({
            sessionId: "s1",
            turnId: "",
            status: "failed",
            text: null,
            error: HOST_CHAT_SPEND_CAP_MESSAGE,
        });
    });

    it("rewrites a turn_failed budget message instead of showing nanos", async () => {
        const { deps: chatDeps, bus } = deps(vi.fn(async () => {
            bus.publish({
                turnId: "t1",
                sessionId: "s1",
                event: failedEvent("t1", spendExceeded().message),
            });
            return { turnId: "t1" };
        }));
        const result = await runHostChat({ message: "hi", sessionId: "s1" }, chatDeps);
        expect(result.status).toBe("failed");
        expect(result.error).toBe(HOST_CHAT_SPEND_CAP_MESSAGE);
        expect(result.error).not.toMatch(/nanos/);
    });

    it("emits the existing error SSE event with the user-facing spend message", async () => {
        const http = fakeHttp();
        const { deps: chatDeps, bus } = deps(vi.fn(async () => {
            bus.publish({
                turnId: "t1",
                sessionId: "s1",
                event: failedEvent("t1", spendExceeded().message),
            });
            return { turnId: "t1" };
        }));
        await streamHostChat(http.req, http.res, { message: "hi", sessionId: "s1" }, chatDeps);
        const events = parseSse(http.chunks.join(""));
        expect(events.map((e) => e.event)).toEqual(["error", "done"]);
        expect(events[0]?.data).toEqual({ error: HOST_CHAT_SPEND_CAP_MESSAGE });
        expect(events[1]?.data).toMatchObject({
            status: "failed",
            error: HOST_CHAT_SPEND_CAP_MESSAGE,
        });
    });

    it("emits error SSE when sendMessage throws SpendExceededError", async () => {
        const http = fakeHttp();
        const { deps: chatDeps } = deps(vi.fn(async () => {
            throw spendExceeded();
        }));
        await streamHostChat(http.req, http.res, { message: "hi", sessionId: "s1" }, chatDeps);
        const events = parseSse(http.chunks.join(""));
        expect(events.map((e) => e.event)).toEqual(["error"]);
        expect(events[0]?.data).toEqual({ error: HOST_CHAT_SPEND_CAP_MESSAGE });
    });
});
