import { getCurrentUserId } from "../auth/context.js";
import {
    redactForTrace,
    resolveTraceRedactMode,
    type TraceRedactMode,
} from "./redact.js";

export type ObservationType = "span" | "generation" | "tool" | "agent";

export type ObservationHandle = {
    update(fields: Record<string, unknown>): void;
};

export type ObserveOptions = {
    name: string;
    asType?: ObservationType;
    input?: unknown;
    metadata?: Record<string, unknown>;
    userId?: string;
    sessionId?: string;
    turnId?: string;
    model?: string;
};

export type TraceBackend = {
    run<T>(opts: ObserveOptions, fn: (obs: ObservationHandle) => Promise<T>): Promise<T>;
};

type LangfuseRuntimeState = {
    enabled: boolean;
    initialized: boolean;
    importAttempted: boolean;
};

type LangfuseApi = {
    startActiveObservation: (
        name: string,
        fn: (span: { update: (fields: Record<string, unknown>) => void }) => unknown,
        options?: { asType?: ObservationType; parentSpanContext?: { traceId: string; spanId: string; traceFlags: number } },
    ) => unknown;
    propagateAttributes: (
        params: { userId?: string; sessionId?: string; metadata?: Record<string, string>; traceName?: string },
        fn: () => unknown,
    ) => unknown;
    createTraceId: (seed?: string) => Promise<string>;
};

type Processor = { forceFlush: () => Promise<void>; shutdown: () => Promise<void> };

let testBackend: TraceBackend | undefined;
let importAttempted = false;
let initialized = false;
let api: LangfuseApi | undefined;
let processor: Processor | undefined;
let flushTimer: ReturnType<typeof setTimeout> | undefined;

export function isTracingEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
    if ((env.DIALY_LANGFUSE ?? "").trim().toLowerCase() === "off") {
        return false;
    }
    const publicKey = env.LANGFUSE_PUBLIC_KEY?.trim() ?? "";
    const secretKey = env.LANGFUSE_SECRET_KEY?.trim() ?? "";
    return publicKey.length > 0 && secretKey.length > 0;
}

export function getLangfuseRuntimeState(): LangfuseRuntimeState {
    return {
        enabled: isTracingEnabled(),
        initialized,
        importAttempted,
    };
}

export function setTraceBackendForTests(backend: TraceBackend | undefined): void {
    testBackend = backend;
}

export function resetLangfuseForTests(): void {
    testBackend = undefined;
    importAttempted = false;
    initialized = false;
    api = undefined;
    processor = undefined;
    if (flushTimer) {
        clearTimeout(flushTimer);
        flushTimer = undefined;
    }
}

export async function safeObserve<T>(
    opts: ObserveOptions,
    fn: (obs: ObservationHandle) => Promise<T>,
): Promise<T> {
    const noop: ObservationHandle = { update() {} };
    if (testBackend) {
        let invoked = false;
        const mode = resolveTraceRedactMode();
        try {
            return await testBackend.run(opts, (obs) => {
                invoked = true;
                return fn({
                    update(fields) {
                        obs.update(prepareFields(fields, mode));
                    },
                });
            });
        } catch (error) {
            if (invoked) {
                throw error;
            }
            return fn(noop);
        }
    }
    if (!isTracingEnabled()) {
        return fn(noop);
    }

    let invoked = false;
    const invoke = (obs: ObservationHandle) => {
        invoked = true;
        return fn(obs);
    };

    try {
        const loaded = await ensureLangfuse();
        if (!loaded || !api) {
            return fn(noop);
        }
        const tracing = api;
        const mode = resolveTraceRedactMode();
        const userId = opts.userId ?? getCurrentUserId();
        const parent = opts.turnId ? await parentContext(tracing, opts.turnId) : undefined;
        const runObservation = () =>
            tracing.startActiveObservation(
                opts.name,
                async (span) => {
                    const obs: ObservationHandle = {
                        update(fields) {
                            try {
                                span.update(prepareFields(fields, mode));
                            } catch {
                                // Tracing must never fail the turn.
                            }
                        },
                    };
                    try {
                        span.update(
                            prepareFields(
                                {
                                    input: opts.input,
                                    ...(opts.model ? { model: opts.model } : {}),
                                    metadata: {
                                        ...opts.metadata,
                                        ...(opts.turnId ? { turnId: opts.turnId } : {}),
                                    },
                                },
                                mode,
                            ),
                        );
                    } catch {
                        // ignore
                    }
                    try {
                        return await invoke(obs);
                    } catch (error) {
                        try {
                            span.update({
                                level: "ERROR",
                                statusMessage: errorMessage(error).slice(0, 200),
                            });
                        } catch {
                            // ignore
                        }
                        throw error;
                    }
                },
                {
                    ...(opts.asType ? { asType: opts.asType } : {}),
                    ...(parent ? { parentSpanContext: parent } : {}),
                },
            );

        const result = await Promise.resolve(
            userId || opts.sessionId
                ? tracing.propagateAttributes(
                      {
                          ...(userId ? { userId: userId.slice(0, 200) } : {}),
                          ...(opts.sessionId ? { sessionId: opts.sessionId.slice(0, 200) } : {}),
                          traceName: opts.name.slice(0, 200),
                          metadata: stringMeta({
                              ...(opts.turnId ? { turnId: opts.turnId } : {}),
                          }),
                      },
                      runObservation,
                  )
                : runObservation(),
        );
        return result as T;
    } catch (error) {
        if (invoked) {
            throw error;
        }
        return fn(noop);
    } finally {
        scheduleFlush();
    }
}

export async function flushLangfuse(): Promise<void> {
    if (!processor) {
        return;
    }
    try {
        await processor.forceFlush();
    } catch {
        // ignore
    }
}

export async function shutdownLangfuse(): Promise<void> {
    if (flushTimer) {
        clearTimeout(flushTimer);
        flushTimer = undefined;
    }
    if (!processor) {
        return;
    }
    try {
        await processor.shutdown();
    } catch {
        // ignore
    }
}

async function ensureLangfuse(): Promise<boolean> {
    if (initialized) {
        return true;
    }
    if (importAttempted) {
        return false;
    }
    importAttempted = true;
    if (!isTracingEnabled()) {
        return false;
    }

    const publicKey = process.env.LANGFUSE_PUBLIC_KEY?.trim() ?? "";
    const secretKey = process.env.LANGFUSE_SECRET_KEY?.trim() ?? "";
    const baseUrl =
        process.env.LANGFUSE_BASE_URL?.trim() ||
        process.env.LANGFUSE_HOST?.trim() ||
        undefined;

    try {
        const [{ LangfuseSpanProcessor }, tracing, { NodeTracerProvider }] = await Promise.all([
            import("@langfuse/otel"),
            import("@langfuse/tracing"),
            import("@opentelemetry/sdk-trace-node"),
        ]);
        const mode = resolveTraceRedactMode();
        const spanProcessor = new LangfuseSpanProcessor({
            publicKey,
            secretKey,
            ...(baseUrl ? { baseUrl } : {}),
            flushAt: 10,
            flushInterval: 1,
            timeout: 5,
            mediaUploadEnabled: false,
            mask: ({ data }: { data: unknown }) => {
                try {
                    return redactForTrace(data, mode);
                } catch {
                    return "[redacted]";
                }
            },
        });
        const provider = new NodeTracerProvider({
            spanProcessors: [spanProcessor],
        });
        tracing.setLangfuseTracerProvider(provider);
        processor = spanProcessor;
        api = {
            startActiveObservation: tracing.startActiveObservation as LangfuseApi["startActiveObservation"],
            propagateAttributes: tracing.propagateAttributes as LangfuseApi["propagateAttributes"],
            createTraceId: tracing.createTraceId,
        };
        initialized = true;
        return true;
    } catch {
        api = undefined;
        processor = undefined;
        initialized = false;
        return false;
    }
}

async function parentContext(
    tracing: LangfuseApi,
    turnId: string,
): Promise<{ traceId: string; spanId: string; traceFlags: number } | undefined> {
    try {
        const traceId = await tracing.createTraceId(`dialy-turn:${turnId}`);
        return {
            traceId,
            spanId: traceId.slice(0, 16),
            traceFlags: 1,
        };
    } catch {
        return undefined;
    }
}

function scheduleFlush(): void {
    if (!processor || flushTimer) {
        return;
    }
    flushTimer = setTimeout(() => {
        flushTimer = undefined;
        void processor?.forceFlush().catch(() => undefined);
    }, 50);
    flushTimer.unref?.();
}

function prepareFields(fields: Record<string, unknown>, mode: TraceRedactMode): Record<string, unknown> {
    const prepared: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(fields)) {
        if (value === undefined) {
            continue;
        }
        if (key === "model" && typeof value === "string") {
            prepared.model = value;
            continue;
        }
        if (key === "level" || key === "statusMessage" || key === "usageDetails" || key === "costDetails") {
            prepared[key] = value;
            continue;
        }
        prepared[key] = redactForTrace(value, mode);
    }
    return prepared;
}

function stringMeta(meta: Record<string, string | undefined>): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [key, value] of Object.entries(meta)) {
        if (!value) {
            continue;
        }
        out[key] = value.slice(0, 200);
    }
    return out;
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
