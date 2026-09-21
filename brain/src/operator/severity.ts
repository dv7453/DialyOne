export type Severity = "reversible" | "consequential" | "irreversible";

export type SeverityOverrides = Readonly<Record<string, Severity>>;

export const PROMOTION_THRESHOLDS = {
  reversible: 10,
  consequential: 30,
} as const;

export const DEFAULT_CAPABILITY_SEVERITY: Readonly<Record<string, Severity>> = {
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

export const DEFAULT_SEVERITY_PREFIXES: ReadonlyArray<readonly [string, Severity]> = [
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

export function classifySeverity(capability: string, overrides?: SeverityOverrides): Severity {
  const overridden = overrides?.[capability];
  if (overridden) {
    return overridden;
  }

  const exact = DEFAULT_CAPABILITY_SEVERITY[capability];
  if (exact) {
    return exact;
  }

  for (const [prefix, severity] of DEFAULT_SEVERITY_PREFIXES) {
    if (capability.startsWith(prefix)) {
      return severity;
    }
  }

  // Nobody has thought about this capability. Fail closed.
  return "irreversible";
}

export function canEverPromote(severity: Severity): severity is Exclude<Severity, "irreversible"> {
  return severity !== "irreversible";
}

export function promotionThreshold(severity: Severity): number | undefined {
  if (!canEverPromote(severity)) {
    return undefined;
  }
  return PROMOTION_THRESHOLDS[severity];
}
