import { z } from "zod";

/** Axes Infer-style evals actually trust: did it do the job, did it invent, how long. */
export const EVAL_AXES = ["taskSuccess", "hallucination", "latency"] as const;
export type EvalAxis = (typeof EVAL_AXES)[number];

export const ZEvalTask = z.object({
  id: z.string().min(1),
  user: z.string().min(1),
  context: z.string().optional().default(""),
  mustInclude: z.array(z.string().min(1)).default([]),
  mustNotClaim: z.array(z.string().min(1)).default([]),
  replies: z.object({
    good: z.string().min(1),
    bad: z.string().min(1),
  }),
});

export type EvalTask = z.infer<typeof ZEvalTask>;

export const ZEvalSuite = z.object({
  name: z.string(),
  latencyBudgetMs: z.number().positive().default(8000),
  tasks: z.array(ZEvalTask).min(1),
});

export type EvalSuite = z.infer<typeof ZEvalSuite>;

export type AgentReply = {
  text: string;
  latencyMs: number;
  error?: string;
};

export type AgentAdapter = {
  id: string;
  complete: (task: EvalTask) => Promise<AgentReply>;
};

export type ProgrammaticScore = {
  taskSuccess: boolean;
  hallucinated: boolean;
  missingFacts: string[];
  inventedClaims: string[];
};

export type JudgeVerdict = {
  taskSuccess: boolean;
  hallucinated: boolean;
  rationale: string;
  confidence: number;
  raw?: string;
  parseError?: string;
};

export type JudgeFn = (input: {
  task: EvalTask;
  reply: string;
}) => Promise<JudgeVerdict>;

export type TaskRecord = {
  taskId: string;
  agentId: string;
  reply: string;
  latencyMs: number;
  agentError?: string;
  programmatic: ProgrammaticScore;
  judge?: JudgeVerdict;
  /** Judge and ground-truth facts disagree — the judge failure we log on purpose. */
  judgeDisagreed: boolean;
  passedTrusted: boolean;
};

export type EvalReport = {
  name: string;
  agentId: string;
  judgeId: string;
  latencyBudgetMs: number;
  startedAt: string;
  finishedAt: string;
  tasks: TaskRecord[];
  /** The one number a team should argue about. */
  trustedMetric: {
    name: "successAtLatency";
    value: number;
    passed: number;
    total: number;
    description: string;
  };
  axes: {
    taskSuccessRate: number;
    hallucinationRate: number;
    p50LatencyMs: number;
    p95LatencyMs: number;
    judgeDisagreementRate: number;
  };
};

export type CompareResult = {
  baseline: string;
  candidate: string;
  trustedDelta: number;
  improved: string[];
  regressed: string[];
  unchanged: string[];
};

export type VoiceUtterance = {
  id: string;
  text: string;
  language: string;
};

export type VoiceStageResult = {
  provider: string;
  utteranceId: string;
  latencyMs: number;
  estimatedCostUsd: number;
  quality: number;
  output: string;
  error?: string;
};

export type VoiceBakeoffReport = {
  name: string;
  stt: VoiceStageResult[];
  tts: VoiceStageResult[];
  summary: {
    stt: Array<{ provider: string; p50LatencyMs: number; totalCostUsd: number; meanQuality: number }>;
    tts: Array<{ provider: string; p50LatencyMs: number; totalCostUsd: number; meanQuality: number }>;
  };
  tradeoffs: string[];
};
