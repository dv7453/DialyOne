import type { EvalTask, ProgrammaticScore } from "./types.js";

function normalize(value: string): string {
  return value
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

function escapeRe(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function includesFact(haystack: string, needle: string): boolean {
  const hay = normalize(haystack);
  const need = normalize(needle);
  if (!need) return true;
  const bounded = new RegExp(`(^|[^a-z0-9])${escapeRe(need)}(?=[^a-z0-9]|$)`);
  // Single/double-char facts must not match inside other tokens ("3" in "37").
  if (need.length <= 2) {
    return bounded.test(hay);
  }
  if (bounded.test(hay) || hay.includes(need)) return true;
  const compactHay = hay.replace(/[\s,]/g, "");
  const compactNeed = need.replace(/[\s,]/g, "");
  return compactNeed.length > 2 && compactHay.includes(compactNeed);
}

export function isNegatedClaim(haystack: string, needle: string): boolean {
  const hay = normalize(haystack);
  const need = normalize(needle);
  return new RegExp(
    `\\b(not|never|won't|wont|do not|don't|didn't|did not|nothing about|no mention of)\\s+${escapeRe(need)}\\b`,
  ).test(hay);
}

/**
 * Ground truth for the trusted metric. Does not ask an LLM.
 * Task success = every required fact appears. Hallucination = any forbidden claim.
 * Empty replies fail the task but are not hallucinations unless they also invent.
 */
export function scoreProgrammatic(task: EvalTask, reply: string): ProgrammaticScore {
  const text = reply ?? "";
  const missingFacts = task.mustInclude.filter((fact) => !includesFact(text, fact));
  const inventedClaims = task.mustNotClaim.filter(
    (claim) => includesFact(text, claim) && !isNegatedClaim(text, claim),
  );
  return {
    taskSuccess: missingFacts.length === 0 && text.trim().length > 0,
    hallucinated: inventedClaims.length > 0,
    missingFacts,
    inventedClaims,
  };
}

export function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[index] ?? 0;
}

export function mean(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

export function rate(passed: number, total: number): number {
  if (total <= 0) return 0;
  return passed / total;
}
