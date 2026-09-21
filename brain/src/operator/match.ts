import { CRON_SIGNAL_TYPE, PROBE_SIGNAL_TYPE, SCHEDULER_SOURCE } from "./scheduler.js";
import type { Playbook, Signal, Trigger } from "./types.js";

function readSignalPath(signal: Signal, path: string): unknown {
  if (path === "source") {
    return signal.source;
  }
  if (path === "type") {
    return signal.type;
  }
  // Playbooks match webhook "event" names against payload.event or signal.type
  if (path === "event") {
    return signal.payload.event ?? signal.payload.eventType ?? signal.type;
  }
  if (path === "id") {
    return signal.id;
  }
  if (path.startsWith("signal.")) {
    return readDottedPath({ signal }, path);
  }

  return signal.payload[path];
}

function readDottedPath(root: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>((current, segment) => {
    if (current && typeof current === "object" && segment in current) {
      return (current as Record<string, unknown>)[segment];
    }
    return undefined;
  }, root);
}

function valueMatches(actual: unknown, expected: unknown): boolean {
  if (Array.isArray(expected)) {
    return expected.some((candidate) => valueMatches(actual, candidate));
  }

  return actual === expected;
}

function matchConditions(signal: Signal, match: Record<string, unknown> | undefined): boolean {
  if (!match) {
    return true;
  }

  return Object.entries(match).every(([key, expected]) => valueMatches(readSignalPath(signal, key), expected));
}

function matchesWebhookTrigger(signal: Signal, trigger: Extract<Trigger, { type: "webhook" }>): boolean {
  return signal.source === trigger.source && matchConditions(signal, trigger.match);
}

function matchesEventTrigger(signal: Signal, trigger: Extract<Trigger, { type: "event" }>): boolean {
  if (trigger.source && signal.source !== trigger.source) {
    return false;
  }

  if (!trigger.eventType) {
    return true;
  }

  const payloadEventType = signal.payload.eventType ?? signal.payload.event;
  return signal.type === trigger.eventType || payloadEventType === trigger.eventType;
}

/**
 * Scheduler-emitted signals name the playbook that asked for them, so a probe
 * result is only ever triaged by the playbook that scheduled that probe.
 */
function matchesProbeTrigger(
  signal: Signal,
  trigger: Extract<Trigger, { type: "probe" }>,
  playbook: Playbook,
): boolean {
  return (
    signal.source === SCHEDULER_SOURCE &&
    signal.type === PROBE_SIGNAL_TYPE &&
    signal.payload.playbookId === playbook.id &&
    signal.payload.capability === trigger.capability
  );
}

function matchesCronTrigger(
  signal: Signal,
  trigger: Extract<Trigger, { type: "cron" }>,
  playbook: Playbook,
): boolean {
  return (
    signal.source === SCHEDULER_SOURCE &&
    signal.type === CRON_SIGNAL_TYPE &&
    signal.payload.playbookId === playbook.id &&
    signal.payload.expression === trigger.expression
  );
}

function matchesTrigger(signal: Signal, trigger: Trigger, playbook: Playbook): boolean {
  switch (trigger.type) {
    case "webhook":
      return matchesWebhookTrigger(signal, trigger);
    case "event":
      return matchesEventTrigger(signal, trigger);
    case "probe":
      return matchesProbeTrigger(signal, trigger, playbook);
    case "cron":
      return matchesCronTrigger(signal, trigger, playbook);
  }
}

export function matchPlaybooks(signal: Signal, playbooks: Playbook[]): Playbook[] {
  return playbooks.filter(
    (playbook) => playbook.enabled && playbook.triggers.some((trigger) => matchesTrigger(signal, trigger, playbook)),
  );
}
