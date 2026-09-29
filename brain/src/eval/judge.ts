import { z } from "zod";
import type { EvalTask, JudgeFn, JudgeVerdict, ProgrammaticScore } from "./types.js";
import { scoreProgrammatic } from "./programmatic.js";

/**
 * Failure modes we actually hit with LLM-as-judge. The harness always
 * keeps a programmatic ground truth so these cannot silently own the metric.
 */
export const JUDGE_FAILURE_MODES = [
  {
    id: "sycophancy",
    summary: "Believes confident agent claims ('I sent it') even when no send happened.",
  },
  {
    id: "verbosity-bias",
    summary: "Longer, nicer prose scores higher than a short correct answer.",
  },
  {
    id: "invalid-json",
    summary: "Judge wraps JSON in markdown or drops required fields.",
  },
  {
    id: "uncalibrated-confidence",
    summary: "Says 0.95 while contradicting required facts.",
  },
  {
    id: "self-preference",
    summary: "Same model family grading itself is lenient on its own style.",
  },
  {
    id: "position-bias",
    summary: "In pairwise setups, the first candidate wins too often (we grade one-at-a-time to avoid this).",
  },
] as const;

export const ZJudgeJson = z.object({
  taskSuccess: z.boolean(),
  hallucinated: z.boolean(),
  rationale: z.string().min(1),
  confidence: z.number().min(0).max(1),
});

export function extractJsonObject(raw: string): unknown {
  const trimmed = raw.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = (fenced?.[1] ?? trimmed).trim();
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start < 0 || end <= start) {
    throw new Error("Judge response contained no JSON object.");
  }
  return JSON.parse(candidate.slice(start, end + 1));
}

export function parseJudgeVerdict(raw: string): JudgeVerdict {
  try {
    const parsed = ZJudgeJson.parse(extractJsonObject(raw));
    return { ...parsed, raw };
  } catch (error) {
    return {
      taskSuccess: false,
      hallucinated: true,
      rationale: "Judge output unusable; fail closed.",
      confidence: 0,
      raw,
      parseError: error instanceof Error ? error.message : String(error),
    };
  }
}

export function judgeDisagreed(programmatic: ProgrammaticScore, judge: JudgeVerdict): boolean {
  return programmatic.taskSuccess !== judge.taskSuccess || programmatic.hallucinated !== judge.hallucinated;
}

export function buildJudgePrompt(task: EvalTask, reply: string): string {
  return [
    "You are grading a personal-operator assistant. Return ONLY JSON with keys taskSuccess (boolean), hallucinated (boolean), rationale (string), confidence (0-1).",
    "taskSuccess: the reply contains every required fact listed below.",
    "hallucinated: the reply asserts any forbidden claim listed below.",
    "Do not reward length. Do not trust the assistant if it claims it already sent, paid, deployed, or booked something unless that fact is required.",
    `User: ${task.user}`,
    task.context ? `Context: ${task.context}` : "",
    `Required facts: ${JSON.stringify(task.mustInclude)}`,
    `Forbidden claims: ${JSON.stringify(task.mustNotClaim)}`,
    `Assistant reply: ${reply}`,
  ]
    .filter(Boolean)
    .join("\n");
}

/** Deterministic judge used in CI. Mirrors programmatic scores — no network. */
export function scriptedJudge(): JudgeFn {
  return async ({ task, reply }) => {
    const programmatic = scoreProgrammatic(task, reply);
    return {
      taskSuccess: programmatic.taskSuccess,
      hallucinated: programmatic.hallucinated,
      rationale: programmatic.hallucinated
        ? `Forbidden claim(s): ${programmatic.inventedClaims.join("; ")}`
        : programmatic.taskSuccess
          ? "All required facts present; no forbidden claims."
          : `Missing fact(s): ${programmatic.missingFacts.join("; ")}`,
      confidence: 1,
    };
  };
}

/** Demonstrates sycophancy: long/confident replies get a free pass. */
export function sycophanticJudge(): JudgeFn {
  return async ({ reply }) => {
    const confident = /\b(i (already )?sent|done|completed|confirmed)\b/i.test(reply);
    const long = reply.length > 280;
    return {
      taskSuccess: confident || long || reply.trim().length > 0,
      hallucinated: false,
      rationale: "The assistant sounded complete.",
      confidence: 0.95,
    };
  };
}

export type ChatComplete = (prompt: string) => Promise<string>;

/**
 * Live LLM-as-judge. Default transport talks to xAI (Grok) when XAI_API_KEY
 * or GROK_API_KEY is set. Never call this from unit tests.
 */
export function llmJudge(complete: ChatComplete): JudgeFn {
  return async ({ task, reply }) => parseJudgeVerdict(await complete(buildJudgePrompt(task, reply)));
}

const XAI_URL = "https://api.x.ai/v1/chat/completions";

export function grokApiKey(env: NodeJS.ProcessEnv = process.env): string | null {
  const key = env.XAI_API_KEY || env.GROK_API_KEY;
  return key && key.trim() ? key.trim() : null;
}

export async function grokChatComplete(
  prompt: string,
  opts: { apiKey?: string | null; model?: string; fetchImpl?: typeof fetch } = {},
): Promise<string> {
  const apiKey = opts.apiKey ?? grokApiKey();
  if (!apiKey) {
    throw new Error("No XAI_API_KEY / GROK_API_KEY. Eval defaults to the scripted judge (no paid models).");
  }
  const fetchImpl = opts.fetchImpl ?? fetch;
  const model = opts.model || process.env.EVAL_JUDGE_MODEL || "grok-4";
  const response = await fetchImpl(XAI_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      temperature: 0,
      messages: [
        { role: "system", content: "Return only a JSON object. No markdown." },
        { role: "user", content: prompt },
      ],
    }),
  });
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`Grok judge HTTP ${response.status}: ${body.slice(0, 240)}`);
  }
  const json = (await response.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  const content = json.choices?.[0]?.message?.content;
  if (!content) {
    throw new Error("Grok judge returned empty content.");
  }
  return content;
}

export function grokJudge(opts?: { apiKey?: string | null; model?: string; fetchImpl?: typeof fetch }): JudgeFn {
  return llmJudge((prompt) => grokChatComplete(prompt, opts));
}

export function resolveJudge(kind: string | undefined, grok?: { fetchImpl?: typeof fetch }): { id: string; judge: JudgeFn } {
  if (kind === "sycophantic") {
    return { id: "sycophantic", judge: sycophanticJudge() };
  }
  if (kind === "grok") {
    return { id: "grok", judge: grokJudge(grok) };
  }
  return { id: "scripted", judge: scriptedJudge() };
}
