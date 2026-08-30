import type { Playbook, PolicyDecision, TriageResult } from "./types.js";

export function decide(playbook: Playbook, triage: TriageResult): PolicyDecision {
  const actions = playbook.policy[triage.class];

  if (!actions) {
    return {
      class: triage.class,
      actions: [
        {
          capability: "notify.escalate",
          mode: "escalate",
          args: { missingPolicyFor: triage.class },
        },
      ],
      reason: `No policy configured for triage class ${triage.class}; escalating.`,
    };
  }

  return {
    class: triage.class,
    actions,
    reason: `Policy matched triage class ${triage.class}.`,
  };
}
