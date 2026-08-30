import { matchPlaybooks } from "./match.js";
import { decide } from "./policy.js";
import { triageSignal } from "./triage.js";
import type { JournalWriter } from "./journal.js";
import type { ActionRequest, Playbook, PolicyDecision, Signal, TriageResult } from "./types.js";

export interface EngineCapabilityRegistry {
  has?(capability: string): boolean;
}

export type EngineDeps = {
  journal: JournalWriter;
  capabilities?: EngineCapabilityRegistry;
  createActionId?: () => string;
};

export type EngineMatchResult = {
  playbookId: string;
  triage: TriageResult;
  decision: PolicyDecision;
  actions: ActionRequest[];
};

export type EngineResult = {
  signalId: string;
  matches: EngineMatchResult[];
};

function nowIso(): string {
  return new Date().toISOString();
}

function makeDefaultActionId(): () => string {
  let next = 1;
  return () => `action-${next++}`;
}

function actionStatusForMode(mode: ActionRequest["mode"]): ActionRequest["status"] {
  return mode === "log" ? "skipped" : "pending";
}

async function appendJournal(deps: EngineDeps, entry: Parameters<JournalWriter["append"]>[0]): Promise<void> {
  await deps.journal.append(entry);
}

export async function processSignal(signal: Signal, playbooks: Playbook[], deps: EngineDeps): Promise<EngineResult> {
  const createActionId = deps.createActionId ?? makeDefaultActionId();
  const matches = matchPlaybooks(signal, playbooks);
  const results: EngineMatchResult[] = [];

  await appendJournal(deps, {
    ts: nowIso(),
    kind: "signal",
    signalId: signal.id,
    data: { signal },
  });

  for (const playbook of matches) {
    const triage = await triageSignal(signal, playbook);
    const decision = decide(playbook, triage);
    const actions = decision.actions.map<ActionRequest>((action) => ({
      id: createActionId(),
      playbookId: playbook.id,
      capability: action.capability,
      mode: action.mode,
      args: action.args,
      signalId: signal.id,
      status: actionStatusForMode(action.mode),
    }));

    await appendJournal(deps, {
      ts: nowIso(),
      kind: "decision",
      playbookId: playbook.id,
      signalId: signal.id,
      data: { triage, decision },
    });

    for (const action of actions) {
      await appendJournal(deps, {
        ts: nowIso(),
        kind: "action",
        playbookId: playbook.id,
        signalId: signal.id,
        data: { action },
      });

      if (action.mode === "escalate") {
        await appendJournal(deps, {
          ts: nowIso(),
          kind: "escalate",
          playbookId: playbook.id,
          signalId: signal.id,
          data: { action },
        });
      }
    }

    results.push({
      playbookId: playbook.id,
      triage,
      decision,
      actions,
    });
  }

  return {
    signalId: signal.id,
    matches: results,
  };
}
