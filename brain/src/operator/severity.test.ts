import { describe, expect, it } from "vitest";

import {
  DEFAULT_CAPABILITY_SEVERITY,
  canEverPromote,
  classifySeverity,
  promotionThreshold,
  PROMOTION_THRESHOLDS,
} from "./severity.js";

describe("classifySeverity", () => {
  it("classifies the default table and prefix families", () => {
    expect(classifySeverity("journal.log")).toBe("reversible");
    expect(classifySeverity("mail.draft")).toBe("reversible");
    expect(classifySeverity("calendar.create")).toBe("reversible");
    expect(classifySeverity("notify.escalate")).toBe("reversible");
    expect(classifySeverity("notify.ping")).toBe("reversible");
    expect(classifySeverity("mail.send")).toBe("consequential");
    expect(classifySeverity("code.draft_pr")).toBe("consequential");
    expect(classifySeverity("code.merge")).toBe("consequential");
    expect(classifySeverity("deploy.restart")).toBe("consequential");
    expect(classifySeverity("deploy.rollback")).toBe("consequential");
    expect(classifySeverity("composio.execute")).toBe("consequential");
    expect(classifySeverity("composio.gmail")).toBe("consequential");
    expect(classifySeverity("payment.send")).toBe("irreversible");
    expect(classifySeverity("gst.file")).toBe("irreversible");
    expect(classifySeverity("delete.inbox")).toBe("irreversible");
  });

  it("treats unknown capabilities as irreversible", () => {
    expect(classifySeverity("mystery.wipe")).toBe("irreversible");
    expect(classifySeverity("web.fetch")).toBe("irreversible");
  });

  it("lets an exact override win over the default table", () => {
    expect(classifySeverity("mail.send", { "mail.send": "reversible" })).toBe("reversible");
    expect(classifySeverity("journal.log", { "journal.log": "irreversible" })).toBe("irreversible");
  });

  it("covers every built-in exact mapping", () => {
    for (const [capability, severity] of Object.entries(DEFAULT_CAPABILITY_SEVERITY)) {
      expect(classifySeverity(capability)).toBe(severity);
    }
  });
});

describe("promotion thresholds", () => {
  it("promotes reversible at 10 and consequential at 30", () => {
    expect(PROMOTION_THRESHOLDS.reversible).toBe(10);
    expect(PROMOTION_THRESHOLDS.consequential).toBe(30);
    expect(promotionThreshold("reversible")).toBe(10);
    expect(promotionThreshold("consequential")).toBe(30);
  });

  it("makes irreversible promotion explicit rather than Infinity", () => {
    expect(canEverPromote("reversible")).toBe(true);
    expect(canEverPromote("consequential")).toBe(true);
    expect(canEverPromote("irreversible")).toBe(false);
    expect(promotionThreshold("irreversible")).toBeUndefined();
  });
});
