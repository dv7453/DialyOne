import { describe, expect, it } from "vitest";

import { decide } from "./policy.js";
import type { Playbook } from "./types.js";

const playbook: Playbook = {
  id: "deploy-sentinel",
  title: "Deploy sentinel",
  enabled: true,
  triggers: [],
  context: [],
  triage: { rules: [], classes: ["minor", "needs_human"] },
  policy: {
    minor: [
      { capability: "deploy.restart", mode: "approve" },
      { capability: "code.draft_pr", mode: "approve", args: { branch: "fix/deploy" } },
    ],
  },
};

describe("decide", () => {
  it("returns configured policy actions for the triage class", () => {
    expect(decide(playbook, { class: "minor", reason: "Retryable failure.", via: "rule" })).toEqual({
      class: "minor",
      actions: playbook.policy.minor,
      reason: "Policy matched triage class minor.",
    });
  });

  it("escalates when no policy exists for the triage class", () => {
    expect(decide(playbook, { class: "needs_human", reason: "Unknown failure.", via: "default" })).toMatchObject({
      class: "needs_human",
      actions: [{ capability: "notify.escalate", mode: "escalate", args: { missingPolicyFor: "needs_human" } }],
    });
  });
});
