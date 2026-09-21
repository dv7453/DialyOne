/**
 * Host HTTP chat — same SessionsImpl path Telegram uses (ChannelBridge).
 */
import type { TurnStreamEvent } from "@x/shared/dist/turns.js";
import container from "../di/container.js";
import { assistantText } from "../runtime/assembly/headless.js";
import { ASK_HUMAN_TOOL } from "../runtime/turns/bridges/real-agent-resolver.js";
import type { ISessions } from "../runtime/sessions/api.js";
import type { ITurnEventBus } from "../runtime/turns/event-hub.js";
import { markIdle, markWake, recordInbound } from "./state.js";

const AGENT_ID = "copilot";
const TURN_TIMEOUT_MS = 10 * 60 * 1000;
const ASK_HUMAN_TOOL_ID = `builtin:${ASK_HUMAN_TOOL}`;

type Settled =
    | { kind: "completed"; text: string | null }
    | { kind: "failed"; error: string }
    | { kind: "cancelled" }
    | { kind: "ask_human"; toolCallId: string; query: string; options?: string[] }
    | { kind: "suspended" }
    | { kind: "timeout" };

function settleOf(event: TurnStreamEvent): Settled | null {
    switch (event.type) {
        case "turn_completed":
            return { kind: "completed", text: assistantText(event.output) };
        case "turn_failed":
            return { kind: "failed", error: event.error };
        case "turn_cancelled":
            return { kind: "cancelled" };
        case "turn_suspended": {
            const ask = event.pendingAsyncTools.find(
                (t) => t.toolId === ASK_HUMAN_TOOL_ID || t.toolName === ASK_HUMAN_TOOL,
            );
            if (ask) {
                const input = ask.input as { question?: unknown; options?: unknown } | null;
                const query =
                    typeof input?.question === "string" && input.question
                        ? input.question
                        : "Dialy needs your input.";
                const options = Array.isArray(input?.options)
                    ? input.options.filter((o): o is string => typeof o === "string")
                    : undefined;
                return { kind: "ask_human", toolCallId: ask.toolCallId, query, options };
            }
            if (event.pendingAsyncTools.length === 0 && event.pendingPermissions.length > 0) {
                return { kind: "suspended" };
            }
            return null;
        }
        default:
            return null;
    }
}

function watchBus(turnEventBus: ITurnEventBus): {
    waitFor: (turnId: string, timeoutMs: number) => Promise<Settled>;
    dispose: () => void;
} {
    const buffered: Array<{ turnId: string; settled: Settled }> = [];
    let waiter: { turnId: string; resolve: (settled: Settled) => void } | null = null;
    let cancelTimer: (() => void) | null = null;
    const unsubscribe = turnEventBus.subscribeAll((event) => {
        const settled = settleOf(event.event);
        if (!settled) return;
        if (waiter) {
            if (event.turnId === waiter.turnId) waiter.resolve(settled);
            return;
        }
        buffered.push({ turnId: event.turnId, settled });
    });
    return {
        waitFor: (turnId: string, timeoutMs: number): Promise<Settled> =>
            new Promise<Settled>((resolve) => {
                const hit = buffered.find((b) => b.turnId === turnId);
                if (hit) {
                    resolve(hit.settled);
                    return;
                }
                buffered.length = 0;
                const timer = setTimeout(() => resolve({ kind: "timeout" }), timeoutMs);
                cancelTimer = () => clearTimeout(timer);
                waiter = {
                    turnId,
                    resolve: (settled) => {
                        clearTimeout(timer);
                        resolve(settled);
                    },
                };
            }),
        dispose: () => {
            unsubscribe();
            cancelTimer?.();
        },
    };
}

export type HostChatAttachment = {
    name?: string;
    mimeType?: string;
    text?: string;
    summary?: string;
};

export type HostChatRequest = {
    sessionId?: string;
    message: string;
    attachments?: HostChatAttachment[];
};

export type HostChatResponse = {
    sessionId: string;
    turnId: string;
    status: "completed" | "failed" | "cancelled" | "ask_human" | "suspended" | "timeout";
    text: string | null;
    error?: string;
    askHuman?: { toolCallId: string; query: string; options?: string[] };
};

function buildUserContent(message: string, attachments?: HostChatAttachment[]): string {
    const parts = [message.trim()];
    if (attachments?.length) {
        const blocks = attachments.map((a, i) => {
            const label = a.name || a.summary || `attachment-${i + 1}`;
            const body = a.text?.trim() || a.summary?.trim() || "(binary / no text extract)";
            return `--- Attached: ${label}${a.mimeType ? ` (${a.mimeType})` : ""} ---\n${body}`;
        });
        parts.push(blocks.join("\n\n"));
    }
    return parts.filter(Boolean).join("\n\n");
}

export async function runHostChat(input: HostChatRequest): Promise<HostChatResponse> {
    const message = typeof input.message === "string" ? input.message.trim() : "";
    if (!message && !(input.attachments && input.attachments.length > 0)) {
        throw new Error("message is required (or provide attachments)");
    }

    const sessions = container.resolve<ISessions>("sessions");
    const turnEventBus = container.resolve<ITurnEventBus>("turnEventBus");

    recordInbound("http-chat");
    const sessionId =
        typeof input.sessionId === "string" && input.sessionId
            ? input.sessionId
            : await sessions.createSession();

    const content = buildUserContent(message || "(see attachments)", input.attachments);
    const watcher = watchBus(turnEventBus);

    try {
        const sent = await sessions.sendMessage(
            sessionId,
            { role: "user", content },
            {
                agent: { agentId: AGENT_ID },
                autoPermission: true,
            },
        );
        markWake(sent.turnId);
        try {
            const settled = await watcher.waitFor(sent.turnId, TURN_TIMEOUT_MS);
            switch (settled.kind) {
                case "completed":
                    return {
                        sessionId,
                        turnId: sent.turnId,
                        status: "completed",
                        text: settled.text,
                    };
                case "failed":
                    return {
                        sessionId,
                        turnId: sent.turnId,
                        status: "failed",
                        text: null,
                        error: settled.error,
                    };
                case "cancelled":
                    return {
                        sessionId,
                        turnId: sent.turnId,
                        status: "cancelled",
                        text: null,
                    };
                case "ask_human":
                    return {
                        sessionId,
                        turnId: sent.turnId,
                        status: "ask_human",
                        text: settled.query,
                        askHuman: {
                            toolCallId: settled.toolCallId,
                            query: settled.query,
                            options: settled.options,
                        },
                    };
                case "suspended":
                    return {
                        sessionId,
                        turnId: sent.turnId,
                        status: "suspended",
                        text: null,
                        error: "Turn suspended pending desktop permission — try again or use Telegram.",
                    };
                case "timeout":
                    return {
                        sessionId,
                        turnId: sent.turnId,
                        status: "timeout",
                        text: null,
                        error: "Turn timed out waiting for the model.",
                    };
            }
        } finally {
            markIdle();
        }
    } finally {
        watcher.dispose();
    }
}

export async function answerHostAskHuman(input: {
    sessionId: string;
    turnId: string;
    toolCallId: string;
    text: string;
}): Promise<HostChatResponse> {
    const sessions = container.resolve<ISessions>("sessions");
    const turnEventBus = container.resolve<ITurnEventBus>("turnEventBus");
    const watcher = watchBus(turnEventBus);
    markWake(input.turnId);
    try {
        const settledPromise = watcher.waitFor(input.turnId, TURN_TIMEOUT_MS);
        const settled = await Promise.race([
            settledPromise,
            sessions
                .respondToAskHuman(input.turnId, input.toolCallId, input.text)
                .then(() => settledPromise),
        ]);
        switch (settled.kind) {
            case "completed":
                return {
                    sessionId: input.sessionId,
                    turnId: input.turnId,
                    status: "completed",
                    text: settled.text,
                };
            case "failed":
                return {
                    sessionId: input.sessionId,
                    turnId: input.turnId,
                    status: "failed",
                    text: null,
                    error: settled.error,
                };
            case "ask_human":
                return {
                    sessionId: input.sessionId,
                    turnId: input.turnId,
                    status: "ask_human",
                    text: settled.query,
                    askHuman: {
                        toolCallId: settled.toolCallId,
                        query: settled.query,
                        options: settled.options,
                    },
                };
            default:
                return {
                    sessionId: input.sessionId,
                    turnId: input.turnId,
                    status: settled.kind === "timeout" ? "timeout" : "cancelled",
                    text: null,
                    error: settled.kind === "timeout" ? "Turn timed out." : undefined,
                };
        }
    } finally {
        markIdle();
        watcher.dispose();
    }
}
