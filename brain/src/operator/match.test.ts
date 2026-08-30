import { describe, expect, it } from "vitest";

import { matchPlaybooks } from "./match.js";
import type { Playbook, Signal } from "./types.js";

const basePlaybook: Playbook = {
  id: "deploy-sentinel",
  title: "Deploy sentinel",
  enabled: true,
  triggers: [
    {
      type: "webhook",
      source: "render",
      match: { event: ["deploy.failed", "service.unhealthy"] },
    },
  ],
  context: [],
  triage: { rules: [], classes: ["minor", "needs_human"] },
  policy: {},
};

const signal: Signal = {
  id: "sig-1",
  source: "render",
  type: "webhook",
  createdAt: "2026-08-30T10:00:00.000Z",
  payload: { event: "deploy.failed" },
};

describe("matchPlaybooks", () => {
  it("matches webhook triggers by source and match conditions", () => {
    expect(matchPlaybooks(signal, [basePlaybook]).map((playbook) => playbook.id)).toEqual(["deploy-sentinel"]);
  });

  it("does not match disabled playbooks or probe triggers for inbound signals", () => {
    const disabled: Playbook = { ...basePlaybook, id: "disabled", enabled: false };
    const probeOnly: Playbook = {
      ...basePlaybook,
      id: "probe-only",
      triggers: [{ type: "probe", every: "60s", capability: "deploy.health" }],
    };

    expect(matchPlaybooks(signal, [disabled, probeOnly])).toEqual([]);
  });

  it("matches event triggers by source and event type", () => {
    const eventPlaybook: Playbook = {
      ...basePlaybook,
      id: "event-playbook",
      triggers: [{ type: "event", source: "github", eventType: "pull_request.opened" }],
    };

    const eventSignal: Signal = {
      ...signal,
      source: "github",
      type: "pull_request.opened",
      payload: {},
    };

    expect(matchPlaybooks(eventSignal, [eventPlaybook]).map((playbook) => playbook.id)).toEqual(["event-playbook"]);
  });

  it("matches webhook match.event against signal.type", () => {
    const typed: Signal = {
      id: "sig-2",
      source: "render",
      type: "deploy.failed",
      createdAt: "2026-08-30T10:00:00.000Z",
      payload: { attempt: 1 },
    };
    expect(matchPlaybooks(typed, [basePlaybook]).map((playbook) => playbook.id)).toEqual(["deploy-sentinel"]);
  });
});
