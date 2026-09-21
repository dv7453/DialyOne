/**
 * Host HTTP chat — same SessionsImpl path Telegram uses (ChannelBridge).
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import type { TurnBusEvent, TurnStreamEvent } from "@x/shared/dist/turns.js";
import { getCurrentUserId } from "../auth/context.js";
import container from "../di/container.js";
import { isSpendExceededError, runWithBudgetUser } from "../llm/index.js";
import { assistantText } from "../runtime/assembly/headless.js";
import { ASK_HUMAN_TOOL } from "../runtime/turns/bridges/real-agent-resolver.js";
import type { ISessions } from "../runtime/sessions/api.js";
import type { ITurnEventBus } from "../runtime/turns/event-hub.js";
import { markIdle, markWake, recordInbound } from "./state.js";

const AGENT_ID = "copilot";
const TURN_TIMEOUT_MS = 10 * 60 * 1000;
const ASK_HUMAN_TOOL_ID = `builtin:${ASK_HUMAN_TOOL}`;
const MAX_PENDING_SSE_FRAMES = 32;

export const HOST_CHAT_SSE_HEARTBEAT_MS = 15_000;
export const HOST_CHAT_SPEND_CAP_MESSAGE =
    "You've reached today's AI spend limit. It resets at midnight UTC.";

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

export type HostChatDeps = {
    sessions: ISessions;
    turnEventBus: ITurnEventBus;
};

export type HostChatSseDelta = { text: string };
export type HostChatSseAskHuman = {
    sessionId: string;
    turnId: string;
    toolCallId: string;
    query: string;
    options?: string[];
};
export type HostChatSseError = { error: string };

export function parseHostChatRequest(body: unknown): HostChatRequest {
    const record = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
    const message = typeof record.message === "string" ? record.message : "";
    const sessionId = typeof record.sessionId === "string" ? record.sessionId : undefined;
    const attachments = Array.isArray(record.attachments)
        ? (record.attachments as Array<Record<string, unknown>>).map((a) => ({
              name: typeof a.name === "string" ? a.name : undefined,
              mimeType: typeof a.mimeType === "string" ? a.mimeType : undefined,
              text: typeof a.text === "string" ? a.text : undefined,
              summary: typeof a.summary === "string" ? a.summary : undefined,
          }))
        : undefined;
    return { sessionId, message, attachments };
}

function resolveDeps(deps?: HostChatDeps): HostChatDeps {
    return (
        deps ?? {
            sessions: container.resolve<ISessions>("sessions"),
            turnEventBus: container.resolve<ITurnEventBus>("turnEventBus"),
        }
    );
}

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

function responseFromSettled(sessionId: string, turnId: string, settled: Settled): HostChatResponse {
    switch (settled.kind) {
        case "completed":
            return {
                sessionId,
                turnId,
                status: "completed",
                text: settled.text,
            };
        case "failed":
            return {
                sessionId,
                turnId,
                status: "failed",
                text: null,
                error: userFacingChatError(settled.error),
            };
        case "cancelled":
            return {
                sessionId,
                turnId,
                status: "cancelled",
                text: null,
            };
        case "ask_human":
            return {
                sessionId,
                turnId,
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
                turnId,
                status: "suspended",
                text: "Waiting for your approval.",
            };
        case "timeout":
            return {
                sessionId,
                turnId,
                status: "timeout",
                text: null,
                error: "Turn timed out waiting for the model.",
            };
    }
}

function requireChatInput(input: HostChatRequest): string {
    const message = typeof input.message === "string" ? input.message.trim() : "";
    if (!message && !(input.attachments && input.attachments.length > 0)) {
        throw new Error("message is required (or provide attachments)");
    }
    return message;
}

function withChatBudgetUser<T>(fn: () => T): T {
    const userId = getCurrentUserId();
    if (!userId) {
        return fn();
    }
    return runWithBudgetUser(userId, fn);
}

function isSpendCapFailure(error: unknown): boolean {
    if (isSpendExceededError(error)) {
        return true;
    }
    if (typeof error === "string") {
        return isSpendCapText(error);
    }
    if (error instanceof Error) {
        return error.name === "SpendExceededError" || isSpendCapText(`${error.name} ${error.message}`);
    }
    return false;
}

function isSpendCapText(text: string): boolean {
    const lower = text.toLowerCase();
    return lower.includes("daily spend cap reached") || lower.includes("spendexceedederror");
}

function userFacingChatError(error: string): string {
    return isSpendCapFailure(error) ? HOST_CHAT_SPEND_CAP_MESSAGE : error;
}

function spendCapChatResponse(sessionId: string, turnId: string): HostChatResponse {
    return {
        sessionId,
        turnId,
        status: "failed",
        text: null,
        error: HOST_CHAT_SPEND_CAP_MESSAGE,
    };
}

export async function runHostChat(
    input: HostChatRequest,
    deps?: HostChatDeps,
): Promise<HostChatResponse> {
    return withChatBudgetUser(() => executeHostChat(input, deps));
}

async function executeHostChat(
    input: HostChatRequest,
    deps?: HostChatDeps,
): Promise<HostChatResponse> {
    const message = requireChatInput(input);
    const { sessions, turnEventBus } = resolveDeps(deps);

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
            return responseFromSettled(sessionId, sent.turnId, settled);
        } finally {
            markIdle();
        }
    } catch (error) {
        if (isSpendCapFailure(error)) {
            return spendCapChatResponse(sessionId, "");
        }
        throw error;
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
    return withChatBudgetUser(() => executeHostAskHuman(input));
}

async function executeHostAskHuman(input: {
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
                    error: userFacingChatError(settled.error),
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
    } catch (error) {
        if (isSpendCapFailure(error)) {
            return spendCapChatResponse(input.sessionId, input.turnId);
        }
        throw error;
    } finally {
        markIdle();
        watcher.dispose();
    }
}

function sseFrame(event: string, data: unknown): string {
    return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

function writeSseHeaders(res: ServerResponse): void {
    res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
        "access-control-allow-origin": "*",
        "access-control-allow-headers": "content-type, authorization, x-brain-token",
    });
    res.flushHeaders();
    res.socket?.setNoDelay?.(true);
}

function waitForDrain(res: ServerResponse, signal: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
        if (signal.aborted || res.writableEnded) {
            resolve();
            return;
        }
        const done = () => {
            res.off("drain", done);
            signal.removeEventListener("abort", done);
            resolve();
        };
        res.once("drain", done);
        signal.addEventListener("abort", done, { once: true });
    });
}

export async function streamHostChat(
    req: IncomingMessage,
    res: ServerResponse,
    input: HostChatRequest,
    deps?: HostChatDeps,
): Promise<void> {
    return withChatBudgetUser(() => executeStreamHostChat(req, res, input, deps));
}

async function executeStreamHostChat(
    req: IncomingMessage,
    res: ServerResponse,
    input: HostChatRequest,
    deps?: HostChatDeps,
): Promise<void> {
    const message = requireChatInput(input);
    const { sessions, turnEventBus } = resolveDeps(deps);

    recordInbound("http-chat");
    const sessionId =
        typeof input.sessionId === "string" && input.sessionId
            ? input.sessionId
            : await sessions.createSession();
    const content = buildUserContent(message || "(see attachments)", input.attachments);

    writeSseHeaders(res);

    const abort = new AbortController();
    let writeChain = Promise.resolve();
    let pendingFrames = 0;
    let accepting = true;
    let dropPending = false;
    let shuttingDown = false;
    let unsubscribe: () => void = () => undefined;
    let heartbeat: ReturnType<typeof setInterval> | undefined;
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    let targetTurnId: string | null = null;
    let terminalQueued = false;
    const buffered: TurnBusEvent[] = [];

    const enqueue = (chunk: string, droppable: boolean): void => {
        if (!accepting || res.writableEnded) return;
        if (droppable && pendingFrames >= MAX_PENDING_SSE_FRAMES) return;
        pendingFrames++;
        writeChain = writeChain.then(
            async () => {
                pendingFrames--;
                if (dropPending || res.writableEnded) return;
                try {
                    const ok = res.write(chunk);
                    if (!ok) await waitForDrain(res, abort.signal);
                } catch {
                    dropPending = true;
                }
            },
            () => {
                pendingFrames--;
            },
        );
    };

    const cleanup = (): void => {
        if (heartbeat !== undefined) {
            clearInterval(heartbeat);
            heartbeat = undefined;
        }
        if (timeoutHandle !== undefined) {
            clearTimeout(timeoutHandle);
            timeoutHandle = undefined;
        }
        unsubscribe();
        unsubscribe = () => undefined;
        markIdle();
        req.off("close", onRequestClose);
    };

    let resolveDone!: () => void;
    const done = new Promise<void>((resolve) => {
        resolveDone = resolve;
    });

    const closeStream = (discardQueue: boolean): void => {
        if (shuttingDown) return;
        shuttingDown = true;
        accepting = false;
        cleanup();
        if (discardQueue) {
            dropPending = true;
            if (!abort.signal.aborted) abort.abort();
        }
        void writeChain
            .catch(() => undefined)
            .finally(() => {
                if (!abort.signal.aborted) abort.abort();
                if (!res.writableEnded) {
                    try {
                        res.end();
                    } catch {
                        // connection already gone
                    }
                }
                resolveDone();
            });
    };

    const onRequestClose = (): void => {
        closeStream(true);
    };

    const emitTerminal = (settled: Settled, turnId: string): void => {
        if (terminalQueued || shuttingDown) return;
        terminalQueued = true;
        const payload = responseFromSettled(sessionId, turnId, settled);
        if (settled.kind === "ask_human") {
            const ask: HostChatSseAskHuman = {
                sessionId,
                turnId,
                toolCallId: settled.toolCallId,
                query: settled.query,
                options: settled.options,
            };
            enqueue(sseFrame("ask_human", ask), false);
        }
        if (settled.kind === "failed") {
            enqueue(
                sseFrame("error", {
                    error: payload.error ?? userFacingChatError(settled.error),
                } satisfies HostChatSseError),
                false,
            );
        }
        enqueue(sseFrame("done", payload), false);
        closeStream(false);
    };

    const dispatch = (busEvent: TurnBusEvent): void => {
        if (shuttingDown || terminalQueued) return;
        if (targetTurnId && busEvent.turnId !== targetTurnId) return;
        const event = busEvent.event;
        if (event.type === "text_delta") {
            if (event.delta) {
                enqueue(sseFrame("delta", { text: event.delta } satisfies HostChatSseDelta), true);
            }
            return;
        }
        const settled = settleOf(event);
        if (!settled || !targetTurnId) return;
        emitTerminal(settled, targetTurnId);
    };

    const onBusEvent = (busEvent: TurnBusEvent): void => {
        if (shuttingDown || terminalQueued) return;
        if (!targetTurnId) {
            if (busEvent.event.type === "text_delta" || settleOf(busEvent.event)) {
                buffered.push(busEvent);
            }
            return;
        }
        dispatch(busEvent);
    };

    req.on("close", onRequestClose);
    heartbeat = setInterval(() => {
        enqueue(": ping\n\n", true);
    }, HOST_CHAT_SSE_HEARTBEAT_MS);
    heartbeat.unref?.();
    timeoutHandle = setTimeout(() => {
        emitTerminal({ kind: "timeout" }, targetTurnId ?? "");
    }, TURN_TIMEOUT_MS);
    timeoutHandle.unref?.();

    // Live fan-out only — TurnEventHub does not replay. Deltas are not durable
    // (no offset), so subscribeAll must be attached before sendMessage or the
    // first tokens can vanish between startTrackedAdvance and this await.
    unsubscribe = turnEventBus.subscribeAll(onBusEvent);

    try {
        const sent = await Promise.race([
            sessions.sendMessage(
                sessionId,
                { role: "user", content },
                {
                    agent: { agentId: AGENT_ID },
                    autoPermission: true,
                },
            ),
            done.then(() => null),
        ]);
        if (!sent || shuttingDown) {
            await done;
            return;
        }
        targetTurnId = sent.turnId;
        markWake(sent.turnId);
        const pending = buffered.splice(0);
        for (const event of pending) {
            dispatch(event);
        }
        await done;
    } catch (error) {
        if (!shuttingDown) {
            const messageText = isSpendCapFailure(error)
                ? HOST_CHAT_SPEND_CAP_MESSAGE
                : error instanceof Error
                  ? error.message
                  : String(error);
            enqueue(sseFrame("error", { error: messageText } satisfies HostChatSseError), false);
            closeStream(false);
        }
        await done;
    }
}
