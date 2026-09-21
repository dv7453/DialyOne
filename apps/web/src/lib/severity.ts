export type Severity = "reversible" | "consequential" | "irreversible";

/**
 * The brain sends `severity` on the approval; this table is only a fallback for
 * records issued before that field existed. It must stay fail-closed, because a
 * capability this copy has not heard of is one the brain considers irreversible.
 */
const EXACT: Readonly<Record<string, Severity>> = {
  "journal.log": "reversible",
  "mail.draft": "reversible",
  "calendar.create": "reversible",
  "notify.escalate": "reversible",
  "mail.send": "consequential",
  "code.draft_pr": "consequential",
  "deploy.health": "consequential",
  "deploy.logs": "consequential",
  "deploy.restart": "consequential",
};

const PREFIXES: ReadonlyArray<readonly [string, Severity]> = [
  ["calendar.", "reversible"],
  ["notify.", "reversible"],
  ["deploy.", "consequential"],
  ["code.", "consequential"],
  ["payment.", "irreversible"],
  ["money.", "irreversible"],
  ["bank.", "irreversible"],
  ["filing.", "irreversible"],
  ["delete.", "irreversible"],
  ["gst.", "irreversible"],
  ["tax.", "irreversible"],
  ["pay.", "irreversible"],
];

export function classifySeverity(capability: string): Severity {
  const exact = EXACT[capability];
  if (exact) return exact;
  for (const [prefix, severity] of PREFIXES) {
    if (capability.startsWith(prefix)) return severity;
  }
  return "irreversible";
}

export function isIrreversible(capability: string, severity?: Severity): boolean {
  return (severity ?? classifySeverity(capability)) === "irreversible";
}
