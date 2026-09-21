import { afterEach, describe, expect, it, vi } from "vitest";

import { processSignal } from "../operator/engine.js";
import { InMemoryJournal } from "../operator/journal.js";
import type { Playbook, Signal } from "../operator/types.js";
import {
    getLangfuseRuntimeState,
    resetLangfuseForTests,
    safeObserve,
    setTraceBackendForTests,
} from "./langfuse.js";

const playbook: Playbook = {
    id: "deploy-sentinel",
    title: "Deploy sentinel",
    enabled: true,
    triggers: [{ type: "webhook", source: "render", match: { event: ["deploy.failed"] } }],
    context: [],
    triage: {
        rules: [{ when: "signal.payload.attempt < 2", class: "minor" }],
        classes: ["minor", "needs_human"],
        defaultClass: "minor",
    },
    policy: {
        minor: [{ capability: "deploy.restart", mode: "approve" }],
        needs_human: [{ capability: "notify.escalate", mode: "auto" }],
    },
};

const signal: Signal = {
    id: "sig-1",
    source: "render",
    type: "webhook",
    createdAt: "2026-08-30T10:00:00.000Z",
    payload: { event: "deploy.failed", attempt: 1 },
};

afterEach(() => {
    resetLangfuseForTests();
    vi.unstubAllEnvs();
});

describe("Langfuse optional init", () => {
    it("does not initialise or import Langfuse when keys are missing", async () => {
        vi.stubEnv("LANGFUSE_PUBLIC_KEY", "");
        vi.stubEnv("LANGFUSE_SECRET_KEY", "");
        const journal = new InMemoryJournal();

        const result = await processSignal(signal, [playbook], { journal });

        expect(getLangfuseRuntimeState()).toEqual({
            enabled: false,
            initialized: false,
            importAttempted: false,
        });
        expect(result.signalId).toBe("sig-1");
        expect(result.matches[0]?.playbookId).toBe("deploy-sentinel");
        expect(journal.readAll().map((entry) => entry.kind)).toEqual([
            "signal",
            "decision",
            "action",
        ]);
    });

    it("leaves processSignal behaviour unchanged when tracing throws", async () => {
        setTraceBackendForTests({
            run: async () => {
                throw new Error("langfuse network timeout");
            },
        });
        const journal = new InMemoryJournal();
        const result = await processSignal(signal, [playbook], { journal });
        expect(result.matches[0]?.triage.class).toBe("minor");
        expect(journal.readAll()).toHaveLength(3);
    });

    it("does not fail a turn-shaped callback when tracing fails", async () => {
        setTraceBackendForTests({
            run: async () => {
                throw new Error("bad key");
            },
        });
        await expect(safeObserve({ name: "dialy.turn" }, async () => "reply")).resolves.toBe(
            "reply",
        );
    });

    it("redacts secrets on observation updates before they leave the process", async () => {
        const seen: Record<string, unknown>[] = [];
        setTraceBackendForTests({
            run: async (_opts, fn) =>
                fn({
                    update(fields) {
                        seen.push(fields);
                    },
                }),
        });

        await safeObserve(
            {
                name: "dialy.tool",
                input: { apiKey: "sk-live", body: "GST notice for client", sessionId: "s1" },
            },
            async (obs) => {
                obs.update({
                    output: {
                        token: "refresh-me",
                        turnId: "turn-1",
                        body: "filed",
                    },
                });
                return true;
            },
        );

        expect(seen[0]?.output).toMatchObject({
            token: "[redacted]:10",
            turnId: "turn-1",
            body: "[redacted]:5",
        });
        expect(JSON.stringify(seen)).not.toContain("sk-live");
        expect(JSON.stringify(seen)).not.toContain("refresh-me");
    });
});
