import { describe, expect, it } from "vitest";

import { approvalExpiresAt, approvalTtlMs, withDefaultExpiry } from "./expiry.js";

describe("approval TTL", () => {
  it("gives CAs a working-day window that grows shorter with severity", () => {
    const env = {};
    expect(approvalTtlMs("reversible", env)).toBe(48 * 60 * 60 * 1000);
    expect(approvalTtlMs("consequential", env)).toBe(24 * 60 * 60 * 1000);
    expect(approvalTtlMs("irreversible", env)).toBe(8 * 60 * 60 * 1000);
  });

  it("honours per-severity env overrides over the global fallback", () => {
    const env = {
      DIALY_APPROVAL_TTL_HOURS: "12",
      DIALY_APPROVAL_TTL_IRREVERSIBLE_HOURS: "2",
    };
    expect(approvalTtlMs("consequential", env)).toBe(12 * 60 * 60 * 1000);
    expect(approvalTtlMs("irreversible", env)).toBe(2 * 60 * 60 * 1000);
  });

  it("stamps expiresAt from createdAt without overwriting an explicit value", () => {
    const now = "2026-09-21T06:00:00.000Z";
    expect(
      withDefaultExpiry(
        { actionId: "a", playbookId: "p", capability: "mail.draft" },
        now,
        {},
      ).expiresAt,
    ).toBe(approvalExpiresAt(now, "reversible", {}));
    expect(
      withDefaultExpiry(
        {
          actionId: "a",
          playbookId: "p",
          capability: "mail.send",
          expiresAt: "2026-09-21T07:00:00.000Z",
        },
        now,
        {},
      ).expiresAt,
    ).toBe("2026-09-21T07:00:00.000Z");
  });
});
