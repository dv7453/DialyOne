import { describe, expect, it } from "vitest";

import { currentBudgetUserId } from "../llm/index.js";
import { InMemoryActionQueue } from "../operator/action-queue.js";
import type { CapabilityAdapter, CapabilityContext, CapabilityResult } from "../operator/capabilities/types.js";
import { CapabilityRegistry } from "../operator/capabilities/registry.js";
import { InMemoryJournal } from "../operator/journal.js";
import { InMemoryTrustLedger } from "../operator/trust.js";
import { ActionQueueDrainWorker, drainDueActions } from "./operator-drain.js";

class RecordingAdapter implements CapabilityAdapter {
    readonly id = "journal";
    readonly capabilities = ["journal.log"];
    readonly budgetUsers: string[] = [];

    async isAvailable(): Promise<boolean> {
        return true;
    }

    async execute(capability: string, _args: Record<string, unknown>, _ctx: CapabilityContext): Promise<CapabilityResult> {
        this.budgetUsers.push(currentBudgetUserId());
        return { ok: true, capability };
    }
}

describe("drainDueActions", () => {
    it("rebinds LLM budget to each queued action's userId", async () => {
        const queue = new InMemoryActionQueue();
        const adapter = new RecordingAdapter();
        const registry = new CapabilityRegistry().register(adapter);
        const due = new Date(0).toISOString();
        await queue.enqueue({
            userId: "tenant-a",
            capability: "journal.log",
            args: {},
            maxAttempts: 1,
            nextAttemptAt: due,
            actionId: "a1",
            playbookId: "pb",
            signalId: "s1",
        });
        await queue.enqueue({
            userId: "tenant-b",
            capability: "journal.log",
            args: {},
            maxAttempts: 1,
            nextAttemptAt: due,
            actionId: "a2",
            playbookId: "pb",
            signalId: "s2",
        });

        await drainDueActions({
            backend: "local",
            queue,
            journal: new InMemoryJournal(),
            registry,
            trust: new InMemoryTrustLedger(),
        });

        expect(adapter.budgetUsers).toEqual(["tenant-a", "tenant-b"]);
    });

    it("refuses items that have no userId instead of executing under another tenant", async () => {
        const queue = new InMemoryActionQueue();
        const adapter = new RecordingAdapter();
        const errors: Array<{ message: string; meta: Record<string, unknown> }> = [];
        await queue.enqueue({
            capability: "journal.log",
            args: {},
            maxAttempts: 1,
            nextAttemptAt: new Date(0).toISOString(),
            actionId: "a1",
            playbookId: "pb",
            signalId: "s1",
        });

        await drainDueActions({
            backend: "local",
            queue,
            journal: new InMemoryJournal(),
            registry: new CapabilityRegistry().register(adapter),
            trust: new InMemoryTrustLedger(),
            onError: (message, meta) => errors.push({ message, meta }),
        });

        expect(adapter.budgetUsers).toEqual([]);
        expect(errors[0]?.message).toMatch(/without userId/);
    });

    it("does not overlap a slow drain with the next interval tick", async () => {
        const worker = new ActionQueueDrainWorker({
            backend: "local",
            queue: new InMemoryActionQueue(),
            journal: new InMemoryJournal(),
            registry: new CapabilityRegistry(),
            trust: new InMemoryTrustLedger(),
            intervalMs: 60_000,
        });
        const first = worker.tick();
        const second = worker.tick();
        await Promise.all([first, second]);
        worker.stop();
    });
});
