import type { Playbook, Signal, TriageResult } from "./types.js";

type Operator = "==" | "!=" | "<=" | ">=" | "<" | ">";

const RULE_PATTERN = /^\s*(signal(?:\.[A-Za-z0-9_-]+)+)\s*(==|!=|<=|>=|<|>)\s*(.+?)\s*$/;

function readPath(root: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>((current, segment) => {
    if (current && typeof current === "object" && segment in current) {
      return (current as Record<string, unknown>)[segment];
    }
    return undefined;
  }, root);
}

function parseLiteral(value: string): unknown {
  const trimmed = value.trim();
  const quoted = trimmed.match(/^(['"])(.*)\1$/);
  if (quoted) {
    return quoted[2];
  }
  if (trimmed === "true") {
    return true;
  }
  if (trimmed === "false") {
    return false;
  }
  if (trimmed === "null") {
    return null;
  }

  const number = Number(trimmed);
  if (!Number.isNaN(number) && trimmed !== "") {
    return number;
  }

  return trimmed;
}

function compareValues(left: unknown, operator: Operator, right: unknown): boolean {
  switch (operator) {
    case "==":
      return left === right;
    case "!=":
      return left !== right;
    case "<":
    case "<=":
    case ">":
    case ">=": {
      if (typeof left !== "number" || typeof right !== "number") {
        return false;
      }
      if (operator === "<") {
        return left < right;
      }
      if (operator === "<=") {
        return left <= right;
      }
      if (operator === ">") {
        return left > right;
      }
      return left >= right;
    }
  }
}

function evaluateRuleExpression(signal: Signal, expression: string): boolean {
  const match = expression.match(RULE_PATTERN);
  if (!match) {
    return false;
  }

  const [, leftPath, operator, rawRight] = match;
  const left = readPath({ signal }, leftPath);
  const right = parseLiteral(rawRight);
  return compareValues(left, operator as Operator, right);
}

export function applyRules(signal: Signal, playbook: Playbook): TriageResult | null {
  for (const rule of playbook.triage.rules) {
    if (!evaluateRuleExpression(signal, rule.when)) {
      continue;
    }

    return {
      class: rule.class,
      reason: rule.reason ?? `Matched rule: ${rule.when}`,
      confidence: 1,
      via: "rule",
    };
  }

  return null;
}

export async function triageSignal(
  signal: Signal,
  playbook: Playbook,
  opts: { modelClassify?: () => Promise<TriageResult> } = {},
): Promise<TriageResult> {
  const ruleResult = applyRules(signal, playbook);
  if (ruleResult) {
    return ruleResult;
  }

  if (opts.modelClassify) {
    return { ...(await opts.modelClassify()), via: "model" };
  }

  const defaultClass = playbook.triage.defaultClass ?? "needs_human";
  return {
    class: defaultClass,
    reason: `No triage rule matched; defaulted to ${defaultClass}.`,
    via: "default",
  };
}
