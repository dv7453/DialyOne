import { describe, expect, it } from "vitest";

import {
    ADAPTER_FLAG_CAPABILITIES,
    adapterFlagsFromStatuses,
    assertAdapterFlagCapabilities,
    type OperatorCapabilityStatus,
} from "./operator-boot.js";
import { CapabilityRegistry } from "../operator/capabilities/registry.js";
import type { CapabilityAdapter, CapabilityContext, CapabilityResult } from "../operator/capabilities/types.js";

class NamedAdapter implements CapabilityAdapter {
    constructor(
        readonly id: string,
        readonly capabilities: string[],
        private readonly available = true,
    ) {}

    async isAvailable(): Promise<boolean> {
        return this.available;
    }

    async execute(capability: string, _args: Record<string, unknown>, _ctx: CapabilityContext): Promise<CapabilityResult> {
        return { ok: true, capability };
    }
}

function statuses(entries: Array<Pick<OperatorCapabilityStatus, "id" | "capabilities" | "available">>): OperatorCapabilityStatus[] {
    return entries.map((entry) => ({
        id: entry.id,
        capabilities: entry.capabilities,
        available: entry.available,
    }));
}

const CONNECTED: OperatorCapabilityStatus[] = statuses([
    { id: "mail-renamed", capabilities: ["mail.draft", "mail.send", "mail.thread"], available: true },
    { id: "ship-it", capabilities: ["deploy.health", "deploy.logs", "deploy.restart"], available: true },
    { id: "prs", capabilities: ["code.draft_pr"], available: false },
    { id: "cal", capabilities: ["calendar.create"], available: true },
    { id: "pager", capabilities: ["notify.escalate"], available: true },
]);

describe("adapterFlagsFromStatuses", () => {
    it("derives flags from capabilities so an adapter rename still reports connected", () => {
        const flags = adapterFlagsFromStatuses(CONNECTED, false);
        expect(flags.mail).toBe(true);
        expect(flags.render).toBe(true);
        expect(flags.github).toBe(false);
        expect(flags.calendar).toBe(true);
        expect(flags.notify).toBe(true);
        expect(flags.telegram).toBe(false);
    });

    it("fails loudly when a flag capability is missing from the registry", () => {
        const withoutMail = CONNECTED.filter((adapter) => !adapter.capabilities.includes("mail.send"));
        expect(() => adapterFlagsFromStatuses(withoutMail, false)).toThrow(/mail/);
    });
});

describe("assertAdapterFlagCapabilities", () => {
    it("throws at boot when a flag capability was never registered", () => {
        const registry = new CapabilityRegistry().register(
            new NamedAdapter("only-notify", ["notify.escalate"]),
        );
        expect(() => assertAdapterFlagCapabilities(registry)).toThrow(
            /requires capability "deploy\.health" but none is registered/,
        );
    });

    it("accepts a registry that offers every flag capability under any adapter id", () => {
        const registry = new CapabilityRegistry();
        for (const capability of Object.values(ADAPTER_FLAG_CAPABILITIES)) {
            registry.register(new NamedAdapter(`adapter-for-${capability}`, [capability]));
        }
        expect(() => assertAdapterFlagCapabilities(registry)).not.toThrow();
    });
});
