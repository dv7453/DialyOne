import { describe, expect, it } from "vitest";

import { InMemoryJournal } from "./journal.js";
import { PROMOTION_THRESHOLDS } from "./severity.js";
import {
  AutonomyGrantError,
  InMemoryTrustLedger,
  applyResolvedApprovalToTrust,
  consentToGrantAutonomy,
  grantEarnedAutonomy,
  revokeEarnedAutonomy,
  shouldOfferPromotion,
  type TrustKey,
  type TrustRecord,
} from "./trust.js";

const key: TrustKey = {
  userId: "user-1",
  playbookId: "inbox-draft",
  capability: "mail.draft",
};

const sendKey: TrustKey = { ...key, capability: "mail.send" };
const payKey: TrustKey = { ...key, capability: "payment.send" };
const unknownKey: TrustKey = { ...key, capability: "mystery.wipe" };

const now = () => new Date("2026-09-21T05:00:00.000Z");

async function approveTimes(ledger: InMemoryTrustLedger, target: TrustKey, count: number): Promise<TrustRecord> {
  let record: TrustRecord | undefined;
  for (let i = 0; i < count; i += 1) {
    record = await ledger.recordApproval(target);
  }
  if (!record) {
    throw new Error("expected at least one approval");
  }
  return record;
}

describe("InMemoryTrustLedger", () => {
  it("increments streak on approval and never auto-grants", async () => {
    const ledger = new InMemoryTrustLedger({ now, createId: () => "row-1" });

    const first = await ledger.recordApproval(key);
    expect(first).toMatchObject({
      id: "row-1",
      ...key,
      severity: "reversible",
      streak: 1,
      autonomyGranted: false,
    });

    const atThreshold = await approveTimes(ledger, key, PROMOTION_THRESHOLDS.reversible - 1);
    expect(atThreshold.streak).toBe(10);
    expect(atThreshold.autonomyGranted).toBe(false);
    expect(shouldOfferPromotion(atThreshold)).toBe(true);

    const past = await ledger.recordApproval(key);
    expect(past.streak).toBe(11);
    expect(past.autonomyGranted).toBe(false);
  });

  it("resets streak on denial and on failure without revoking a grant", async () => {
    const ledger = new InMemoryTrustLedger({ now });
    await approveTimes(ledger, key, 4);
    await grantEarnedAutonomy(ledger, key, consentToGrantAutonomy());

    const denied = await ledger.recordDenial(key);
    expect(denied.streak).toBe(0);
    expect(denied.autonomyGranted).toBe(true);

    await approveTimes(ledger, key, 3);
    const failed = await ledger.recordFailure(key);
    expect(failed.streak).toBe(0);
    expect(failed.autonomyGranted).toBe(true);
  });

  it("grants only with explicit consent and revoking starts the capability over", async () => {
    const ledger = new InMemoryTrustLedger({ now, createId: () => "row-1" });
    await approveTimes(ledger, key, 10);

    const granted = await ledger.grantAutonomy(key, consentToGrantAutonomy());
    expect(granted.autonomyGranted).toBe(true);
    expect(granted.streak).toBe(10);

    const revoked = await ledger.revokeAutonomy(key);
    expect(revoked).toMatchObject({ streak: 0, autonomyGranted: false });
    expect(shouldOfferPromotion(revoked)).toBe(false);
  });

  it("refuses to grant autonomy for irreversible capabilities", async () => {
    const ledger = new InMemoryTrustLedger({ now });
    await expect(ledger.grantAutonomy(payKey, consentToGrantAutonomy())).rejects.toBeInstanceOf(AutonomyGrantError);
    await expect(ledger.get(payKey)).resolves.toBeUndefined();
  });

  it("lists every stored record with the TrustRecord shape", async () => {
    const seed: TrustRecord[] = [
      {
        id: "row-1",
        userId: "user-1",
        playbookId: "inbox",
        capability: "mail.draft",
        severity: "reversible",
        streak: 3,
        autonomyGranted: false,
        updatedAt: "2026-09-21T05:00:00.000Z",
      },
      {
        id: "row-2",
        userId: "user-1",
        playbookId: "inbox",
        capability: "mail.send",
        severity: "consequential",
        streak: 1,
        autonomyGranted: true,
        updatedAt: "2026-09-21T06:00:00.000Z",
      },
    ];
    const ledger = new InMemoryTrustLedger({ seed });
    const records = await ledger.list();
    expect(records).toEqual(seed);
    records[0]!.streak = 99;
    await expect(
      ledger.get({ userId: "user-1", playbookId: "inbox", capability: "mail.draft" }),
    ).resolves.toMatchObject({ streak: 3 });
  });
});

describe("shouldOfferPromotion", () => {
  it("becomes offerable at exactly the threshold per severity and never for irreversible", async () => {
    const ledger = new InMemoryTrustLedger({ now });

    const reversibleNine = await approveTimes(ledger, key, PROMOTION_THRESHOLDS.reversible - 1);
    expect(shouldOfferPromotion(reversibleNine)).toBe(false);
    const reversibleTen = await ledger.recordApproval(key);
    expect(shouldOfferPromotion(reversibleTen)).toBe(true);

    const consequentialTwentyNine = await approveTimes(ledger, sendKey, PROMOTION_THRESHOLDS.consequential - 1);
    expect(shouldOfferPromotion(consequentialTwentyNine)).toBe(false);
    const consequentialThirty = await ledger.recordApproval(sendKey);
    expect(shouldOfferPromotion(consequentialThirty)).toBe(true);

    const unknown = await approveTimes(ledger, unknownKey, 100);
    expect(unknown.severity).toBe("irreversible");
    expect(shouldOfferPromotion(unknown)).toBe(false);

    const granted = await ledger.grantAutonomy(key, consentToGrantAutonomy());
    expect(shouldOfferPromotion(granted)).toBe(false);
  });
});

describe("applyResolvedApprovalToTrust", () => {
  it("records a successful approval toward the streak and journals when promotion becomes available", async () => {
    const ledger = new InMemoryTrustLedger({ now, createId: () => "row-1" });
    const journal = new InMemoryJournal();
    await approveTimes(ledger, key, 9);

    const record = await applyResolvedApprovalToTrust(ledger, {
      userId: key.userId,
      approval: { id: "approval-1", playbookId: key.playbookId, capability: key.capability, signalId: "sig-1" },
      decision: "approve",
      execution: { ok: true },
      journal,
      now,
    });

    expect(record.streak).toBe(10);
    expect(record.autonomyGranted).toBe(false);
    expect(journal.readAll()).toEqual([
      expect.objectContaining({
        kind: "promotion_available",
        playbookId: key.playbookId,
        signalId: "sig-1",
        data: expect.objectContaining({
          summary: expect.stringContaining("without asking"),
          streak: 10,
          threshold: 10,
        }),
      }),
    ]);
  });

  it("resets the streak when the user denies or the approved action fails", async () => {
    const ledger = new InMemoryTrustLedger({ now });
    await approveTimes(ledger, key, 6);
    const journal = new InMemoryJournal();

    const denied = await applyResolvedApprovalToTrust(ledger, {
      userId: key.userId,
      approval: { playbookId: key.playbookId, capability: key.capability, signalId: "sig-1" },
      decision: "deny",
      journal,
      now,
    });
    expect(denied.streak).toBe(0);
    expect(journal.readAll()[0]).toMatchObject({
      kind: "streak_reset",
      data: { cause: "denied", summary: expect.stringContaining("said no") },
    });

    await approveTimes(ledger, key, 2);
    const failed = await applyResolvedApprovalToTrust(ledger, {
      userId: key.userId,
      approval: { playbookId: key.playbookId, capability: key.capability },
      decision: "approve",
      execution: { ok: false },
    });
    expect(failed.streak).toBe(0);
  });
});

describe("grantEarnedAutonomy / revokeEarnedAutonomy", () => {
  it("journals grant and revoke in plain language", async () => {
    const ledger = new InMemoryTrustLedger({ now, createId: () => "row-1" });
    const journal = new InMemoryJournal();

    const granted = await grantEarnedAutonomy(ledger, key, consentToGrantAutonomy(), { journal, now });
    expect(granted.autonomyGranted).toBe(true);
    expect(journal.readAll()[0]).toMatchObject({
      kind: "autonomy_granted",
      data: { summary: expect.stringContaining("without asking") },
    });

    const revoked = await revokeEarnedAutonomy(ledger, key, { journal, now });
    expect(revoked).toMatchObject({ streak: 0, autonomyGranted: false });
    expect(journal.readAll()[1]).toMatchObject({
      kind: "autonomy_revoked",
      data: { summary: expect.stringContaining("starting from scratch") },
    });
  });
});
