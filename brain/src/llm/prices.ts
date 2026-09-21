/**
 * Token prices in nano-USD (1 USD = 1e9 nanos). Per-token nanos =
 * (USD per 1M tokens) * 1000, stored as integers so spend never
 * accumulates in floating point.
 *
 * Sources (2026-09): OpenAI developers.openai.com/api/docs/pricing;
 * Anthropic platform.claude.com/docs/en/about-claude/pricing;
 * Google ai.google.dev/gemini-api/docs/pricing; aggregator cross-check
 * modelpricing.ai / llmcosttracker.com for ids those pages omit.
 *
 * FALLBACK is gpt-5.4-pro / gpt-5.5-pro class ($30 / $180 per MTok).
 * An unknown id must never price as free.
 */

export type TokenPrice = {
  inputNanosPerToken: number;
  outputNanosPerToken: number;
};

export const NANOS_PER_USD = 1_000_000_000n;

/** $30 input / $180 output per 1M tokens. */
export const FALLBACK_PRICE: TokenPrice = {
  inputNanosPerToken: 30_000,
  outputNanosPerToken: 180_000,
};

function usdPerMtok(input: number, output: number): TokenPrice {
  return {
    inputNanosPerToken: Math.round(input * 1000),
    outputNanosPerToken: Math.round(output * 1000),
  };
}

const P = {
  gpt41mini: usdPerMtok(0.4, 1.6),
  gpt41nano: usdPerMtok(0.1, 0.4),
  gpt41: usdPerMtok(2, 8),
  gpt4oMini: usdPerMtok(0.15, 0.6),
  gpt4o: usdPerMtok(2.5, 10),
  gpt5: usdPerMtok(1.25, 10),
  gpt5mini: usdPerMtok(0.25, 2),
  gpt5nano: usdPerMtok(0.05, 0.4),
  gpt54: usdPerMtok(2.5, 15),
  gpt54mini: usdPerMtok(0.75, 4.5),
  gpt54nano: usdPerMtok(0.2, 1.25),
  gpt54pro: usdPerMtok(30, 180),
  gpt55: usdPerMtok(5, 30),
  gpt55pro: usdPerMtok(30, 180),
  gpt56sol: usdPerMtok(4, 20),
  gpt56terra: usdPerMtok(2, 12),
  gpt56luna: usdPerMtok(0.2, 1.2),
  gpt56cyber: usdPerMtok(12.5, 75),
  o4mini: usdPerMtok(1.1, 4.4),
  sonnet5: usdPerMtok(2, 10),
  sonnet46: usdPerMtok(3, 15),
  haiku45: usdPerMtok(1, 5),
  haiku35: usdPerMtok(0.8, 4),
  opus48: usdPerMtok(5, 25),
  opus41: usdPerMtok(15, 75),
  fable5: usdPerMtok(10, 50),
  gemini20flash: usdPerMtok(0.1, 0.4),
  gemini25flash: usdPerMtok(0.3, 2.5),
  gemini25flashLite: usdPerMtok(0.1, 0.4),
  gemini25pro: usdPerMtok(1.25, 10),
  gemini31flashLite: usdPerMtok(0.25, 1.5),
  gemini35flash: usdPerMtok(0.3, 2.5),
  gemini35pro: usdPerMtok(2, 12),
  kimiK26: usdPerMtok(0.95, 4),
  kimiK25: usdPerMtok(0.45, 2.25),
  grok4: usdPerMtok(3, 15),
  grok4fast: usdPerMtok(0.2, 0.5),
  llama70b: usdPerMtok(0.4, 0.4),
} as const;

const MODEL_PRICES: Record<string, TokenPrice> = {
  "gpt-4.1-mini": P.gpt41mini,
  "gpt-4.1-nano": P.gpt41nano,
  "gpt-4.1": P.gpt41,
  "gpt-4o-mini": P.gpt4oMini,
  "gpt-4o": P.gpt4o,
  "gpt-5": P.gpt5,
  "gpt-5.1": P.gpt5,
  "gpt-5-mini": P.gpt5mini,
  "gpt-5-nano": P.gpt5nano,
  "gpt-5.4": P.gpt54,
  "gpt-5.4-mini": P.gpt54mini,
  "gpt-5.4-nano": P.gpt54nano,
  "gpt-5.4-pro": P.gpt54pro,
  "gpt-5.5": P.gpt55,
  "gpt-5.5-pro": P.gpt55pro,
  "gpt-5.6-sol": P.gpt56sol,
  "gpt-5.6-terra": P.gpt56terra,
  "gpt-5.6-luna": P.gpt56luna,
  "gpt-5.6-cyber": P.gpt56cyber,
  "o4-mini": P.o4mini,
  "claude-sonnet-5": P.sonnet5,
  "claude-sonnet-4.6": P.sonnet46,
  "claude-sonnet-4-6": P.sonnet46,
  "claude-sonnet-4.5": P.sonnet46,
  "claude-sonnet-4-5": P.sonnet46,
  "claude-sonnet-4": P.sonnet46,
  "claude-3.5-sonnet": P.sonnet46,
  "claude-3-5-sonnet": P.sonnet46,
  "claude-haiku-4.5": P.haiku45,
  "claude-haiku-4-5": P.haiku45,
  "claude-3.5-haiku": P.haiku35,
  "claude-3-5-haiku": P.haiku35,
  "claude-opus-4.8": P.opus48,
  "claude-opus-4-8": P.opus48,
  "claude-opus-4.7": P.opus48,
  "claude-opus-4-7": P.opus48,
  "claude-opus-4.6": P.opus48,
  "claude-opus-4-6": P.opus48,
  "claude-opus-4.5": P.opus48,
  "claude-opus-4-5": P.opus48,
  "claude-opus-5": P.opus48,
  "claude-opus-4.1": P.opus41,
  "claude-opus-4-1": P.opus41,
  "claude-opus-4": P.opus41,
  "claude-fable-5": P.fable5,
  "claude-fable-5.1": P.fable5,
  "claude-mythos-5": P.fable5,
  "claude-mythos-5.1": P.fable5,
  "gemini-2.0-flash": P.gemini20flash,
  "gemini-2.0-flash-001": P.gemini20flash,
  "gemini-2.5-flash": P.gemini25flash,
  "gemini-2.5-flash-preview-05-20": P.gemini25flash,
  "gemini-2.5-flash-lite": P.gemini25flashLite,
  "gemini-2.5-pro": P.gemini25pro,
  "gemini-3.1-flash-lite": P.gemini31flashLite,
  "gemini-3.5-flash": P.gemini35flash,
  "gemini-3.5-flash-lite": P.gemini35flash,
  "gemini-3.5-pro": P.gemini35pro,
  "kimi-k2": P.kimiK26,
  "kimi-k2.5": P.kimiK25,
  "kimi-k2.6": P.kimiK26,
  "moonshot-v1-auto": P.kimiK26,
  "moonshot-v1-8k": P.kimiK26,
  "moonshot-v1-32k": P.kimiK26,
  "moonshot-v1-128k": P.kimiK26,
  "grok-4": P.grok4,
  "grok-4-fast": P.grok4fast,
  "grok-4-1-fast": P.grok4fast,
  "grok-4-1-fast-reasoning": P.grok4fast,
  "grok-3": P.grok4,
  "grok-3-mini": P.grok4fast,
  "grok-2": P.grok4,
  "llama-3.3-70b-instruct": P.llama70b,
  "llama3.3": P.llama70b,
};

export function normalizeModelId(modelId: string): string {
  let id = modelId.trim().toLowerCase();
  const slash = id.lastIndexOf("/");
  if (slash >= 0) {
    id = id.slice(slash + 1);
  }
  id = id.replace(/_/g, "-");
  id = id.replace(/-\d{8}$/, "");
  return id;
}

function lookupKeys(modelId: string): string[] {
  const id = normalizeModelId(modelId);
  const dashed = id.replace(/\./g, "-");
  const dotted = id.replace(/-/g, ".");
  return [...new Set([id, dashed, dotted])];
}

export function priceForModel(modelId: string): TokenPrice {
  for (const key of lookupKeys(modelId)) {
    const hit = MODEL_PRICES[key];
    if (hit) {
      return hit;
    }
  }
  return FALLBACK_PRICE;
}

export function isFallbackPrice(price: TokenPrice): boolean {
  return price === FALLBACK_PRICE
    || (
      price.inputNanosPerToken === FALLBACK_PRICE.inputNanosPerToken
      && price.outputNanosPerToken === FALLBACK_PRICE.outputNanosPerToken
    );
}

export type TokenCounts = {
  inputTokens: number;
  outputTokens: number;
};

function asNonNegInt(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return 0;
  }
  return Math.floor(value);
}

function nestedTotal(value: unknown): number {
  if (typeof value === "number") {
    return asNonNegInt(value);
  }
  if (value && typeof value === "object" && "total" in value) {
    return asNonNegInt((value as { total: unknown }).total);
  }
  return 0;
}

export function tokensFromUsage(usage: unknown): TokenCounts | undefined {
  if (!usage || typeof usage !== "object") {
    return undefined;
  }
  const record = usage as Record<string, unknown>;
  const inputTokens = nestedTotal(record.inputTokens);
  const outputTokens = nestedTotal(record.outputTokens);
  if (inputTokens > 0 || outputTokens > 0) {
    return { inputTokens, outputTokens };
  }
  const total = asNonNegInt(record.totalTokens);
  if (total > 0) {
    return { inputTokens: 0, outputTokens: total };
  }
  return undefined;
}

export function computeCostNanos(modelId: string, usage: TokenCounts): bigint {
  const price = priceForModel(modelId);
  return BigInt(usage.inputTokens) * BigInt(price.inputNanosPerToken)
    + BigInt(usage.outputTokens) * BigInt(price.outputNanosPerToken);
}
