import { judgeDisagreed } from "./judge.js";
import { percentile, rate, scoreProgrammatic } from "./programmatic.js";
import type { AgentAdapter, EvalReport, EvalSuite, JudgeFn, TaskRecord } from "./types.js";

const TRUSTED_DESCRIPTION =
  "Share of tasks that are fact-complete, non-hallucinated, and under the latency budget. Programmatic ground truth — the judge cannot override this number.";

export function passedTrusted(
  record: Pick<TaskRecord, "programmatic" | "latencyMs" | "agentError">,
  latencyBudgetMs: number,
): boolean {
  if (record.agentError) return false;
  if (record.latencyMs > latencyBudgetMs) return false;
  return record.programmatic.taskSuccess && !record.programmatic.hallucinated;
}

export async function runEval(opts: {
  suite: EvalSuite;
  agent: AgentAdapter;
  judge?: JudgeFn;
  judgeId?: string;
  now?: () => Date;
}): Promise<EvalReport> {
  const now = opts.now ?? (() => new Date());
  const startedAt = now().toISOString();
  const tasks: TaskRecord[] = [];

  for (const task of opts.suite.tasks) {
    let replyText = "";
    let latencyMs = 0;
    let agentError: string | undefined;
    try {
      const reply = await opts.agent.complete(task);
      replyText = reply.text;
      latencyMs = reply.latencyMs;
      agentError = reply.error;
    } catch (error) {
      agentError = error instanceof Error ? error.message : String(error);
    }

    const programmatic = scoreProgrammatic(task, replyText);
    const judge = opts.judge
      ? await opts.judge({ task, reply: replyText }).catch((error) => ({
          taskSuccess: false,
          hallucinated: true,
          rationale: "Judge threw; fail closed.",
          confidence: 0,
          parseError: error instanceof Error ? error.message : String(error),
        }))
      : undefined;

    const record: TaskRecord = {
      taskId: task.id,
      agentId: opts.agent.id,
      reply: replyText,
      latencyMs,
      agentError,
      programmatic,
      judge,
      judgeDisagreed: judge ? judgeDisagreed(programmatic, judge) : false,
      passedTrusted: passedTrusted({ programmatic, latencyMs, agentError }, opts.suite.latencyBudgetMs),
    };
    tasks.push(record);
  }

  const latencies = tasks.map((task) => task.latencyMs);
  const judged = tasks.filter((task) => task.judge);
  const passed = tasks.filter((task) => task.passedTrusted).length;

  return {
    name: opts.suite.name,
    agentId: opts.agent.id,
    judgeId: opts.judgeId ?? (opts.judge ? "custom" : "none"),
    latencyBudgetMs: opts.suite.latencyBudgetMs,
    startedAt,
    finishedAt: now().toISOString(),
    tasks,
    trustedMetric: {
      name: "successAtLatency",
      value: rate(passed, tasks.length),
      passed,
      total: tasks.length,
      description: TRUSTED_DESCRIPTION,
    },
    axes: {
      taskSuccessRate: rate(tasks.filter((task) => task.programmatic.taskSuccess).length, tasks.length),
      hallucinationRate: rate(tasks.filter((task) => task.programmatic.hallucinated).length, tasks.length),
      p50LatencyMs: percentile(latencies, 50),
      p95LatencyMs: percentile(latencies, 95),
      judgeDisagreementRate: rate(judged.filter((task) => task.judgeDisagreed).length, judged.length || 0),
    },
  };
}
