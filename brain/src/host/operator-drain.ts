import { claimDueActionsUnscoped, createPgActionQueue } from "../db/action-queue-store.js";
import { getDb } from "../db/client.js";
import { createPgJournalWriter } from "../db/journal-store.js";
import { runWithBudgetUser } from "../llm/index.js";
import type { ActionQueue, QueuedAction } from "../operator/action-queue.js";
import type { CapabilityRegistry } from "../operator/capabilities/registry.js";
import { drainActionQueue } from "../operator/executor.js";
import type { JournalWriter } from "../operator/journal.js";
import type { TrustLedger } from "../operator/trust.js";
import type { OperatorStoreBackend } from "./operator-stores.js";

export const DEFAULT_DRAIN_INTERVAL_MS = 15_000;
export const DEFAULT_DRAIN_BATCH_SIZE = 10;

export type DrainWorkerDeps = {
    backend: OperatorStoreBackend;
    queue: ActionQueue;
    journal: JournalWriter;
    registry: CapabilityRegistry;
    trust: TrustLedger;
    intervalMs?: number;
    batchSize?: number;
    onError?: (message: string, meta: Record<string, unknown>) => void;
};

export function readDrainIntervalMs(env: NodeJS.ProcessEnv = process.env): number {
    return readPositiveInt(env.OPERATOR_DRAIN_INTERVAL_MS, DEFAULT_DRAIN_INTERVAL_MS);
}

export function readDrainBatchSize(env: NodeJS.ProcessEnv = process.env): number {
    return readPositiveInt(env.OPERATOR_DRAIN_BATCH_SIZE, DEFAULT_DRAIN_BATCH_SIZE);
}

export function isDrainDisabled(env: NodeJS.ProcessEnv = process.env): boolean {
    return env.OPERATOR_DRAIN === "off";
}

export function queueWithDueItems(queue: ActionQueue, items: QueuedAction[]): ActionQueue {
    return {
        enqueue: (input) => queue.enqueue(input),
        listDue: async () => items,
        get: (id) => queue.get(id),
        markSucceeded: (id) => queue.markSucceeded(id),
        markDead: (id, lastError) => queue.markDead(id, lastError),
        reschedule: (id, input) => queue.reschedule(id, input),
    };
}

export async function drainDueActions(deps: DrainWorkerDeps): Promise<void> {
    const batchSize = deps.batchSize ?? DEFAULT_DRAIN_BATCH_SIZE;
    const items =
        deps.backend === "postgres"
            ? await claimDueActionsUnscoped(getDb(), { limit: batchSize })
            : (await deps.queue.listDue()).slice(0, batchSize);

    for (const item of items) {
        const userId = item.userId;
        if (!userId) {
            deps.onError?.("operator drain refusing queued action without userId", {
                queuedActionId: item.id,
            });
            continue;
        }

        const tenantQueue =
            deps.backend === "postgres" ? createPgActionQueue(getDb(), userId) : deps.queue;
        const tenantJournal =
            deps.backend === "postgres" ? createPgJournalWriter(getDb(), userId) : deps.journal;

        await runWithBudgetUser(userId, () =>
            drainActionQueue(queueWithDueItems(tenantQueue, [item]), deps.registry, tenantJournal, {
                trust: deps.trust,
            }),
        );
    }
}

export class ActionQueueDrainWorker {
    private timer: ReturnType<typeof setInterval> | undefined;
    private draining = false;
    private readonly intervalMs: number;

    constructor(private readonly deps: DrainWorkerDeps) {
        this.intervalMs = deps.intervalMs ?? DEFAULT_DRAIN_INTERVAL_MS;
    }

    start(): void {
        if (this.timer) {
            return;
        }
        this.timer = setInterval(() => {
            void this.tick();
        }, this.intervalMs);
        this.timer.unref?.();
    }

    stop(): void {
        if (!this.timer) {
            return;
        }
        clearInterval(this.timer);
        this.timer = undefined;
    }

    async tick(): Promise<void> {
        if (this.draining) {
            return;
        }
        this.draining = true;
        try {
            await drainDueActions(this.deps);
        } catch (error) {
            this.deps.onError?.("operator drain failed", {
                error: error instanceof Error ? error.message : String(error),
            });
        } finally {
            this.draining = false;
        }
    }
}

function readPositiveInt(raw: string | undefined, fallback: number): number {
    if (raw === undefined || raw === "") {
        return fallback;
    }
    const parsed = Number.parseInt(raw, 10);
    if (!Number.isFinite(parsed) || parsed < 1) {
        return fallback;
    }
    return parsed;
}
