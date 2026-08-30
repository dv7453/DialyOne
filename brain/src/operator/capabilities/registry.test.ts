import { describe, expect, it, vi } from "vitest";

import { CapabilityRegistry } from "./registry.js";
import type { CapabilityAdapter } from "./types.js";

describe("CapabilityRegistry", () => {
  it("registers adapters and executes matching capabilities", async () => {
    const execute = vi.fn(async (capability: string) => ({ ok: true, capability, data: { checked: true } }));
    const adapter: CapabilityAdapter = {
      id: "test",
      capabilities: ["deploy.health"],
      isAvailable: async () => true,
      execute,
    };

    const registry = new CapabilityRegistry().register(adapter);

    expect(registry.has("deploy.health")).toBe(true);
    await expect(registry.listAvailable()).resolves.toEqual(["deploy.health"]);
    await expect(registry.execute("deploy.health", { service: "api" }, { signalId: "sig-1" })).resolves.toEqual({
      ok: true,
      capability: "deploy.health",
      data: { checked: true },
    });
    expect(execute).toHaveBeenCalledWith("deploy.health", { service: "api" }, { signalId: "sig-1" });
  });

  it("returns unavailable results instead of throwing for missing or unavailable adapters", async () => {
    const registry = new CapabilityRegistry().register({
      id: "offline",
      capabilities: ["mail.send"],
      isAvailable: async () => false,
      execute: async (capability) => ({ ok: true, capability }),
    });

    await expect(registry.execute("unknown.capability")).resolves.toMatchObject({
      ok: false,
      capability: "unknown.capability",
      unavailable: true,
    });
    await expect(registry.execute("mail.send")).resolves.toMatchObject({
      ok: false,
      capability: "mail.send",
      unavailable: true,
    });
    await expect(registry.listAvailable()).resolves.toEqual([]);
  });
});
