import { describe, expect, it } from "vitest";

import { MockCapabilityAdapter } from "./mock.js";

describe("MockCapabilityAdapter", () => {
  it("handles operator capabilities with default mocked results", async () => {
    const adapter = new MockCapabilityAdapter();

    await expect(adapter.execute("deploy.restart", { service: "web" }, { signalId: "sig-1" })).resolves.toMatchObject({
      ok: true,
      capability: "deploy.restart",
      data: { mocked: true },
    });
    expect(adapter.capabilities).toContain("mail.send");
    expect(adapter.getCalls()).toEqual([
      {
        capability: "deploy.restart",
        args: { service: "web" },
        ctx: { signalId: "sig-1" },
      },
    ]);
  });

  it("uses configurable responses", async () => {
    const adapter = new MockCapabilityAdapter(
      new Map([["mail.send", { ok: false, capability: "mail.send", error: "needs approval" }]]),
    );
    adapter.setResponse("deploy.health", { ok: true, capability: "deploy.health", data: { status: "ok" } });

    await expect(adapter.execute("mail.send", {}, {})).resolves.toEqual({
      ok: false,
      capability: "mail.send",
      error: "needs approval",
    });
    await expect(adapter.execute("deploy.health", {}, {})).resolves.toEqual({
      ok: true,
      capability: "deploy.health",
      data: { status: "ok" },
    });
  });
});
