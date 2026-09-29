import type { CompareResult, EvalReport } from "./types.js";

export function compareReports(baseline: EvalReport, candidate: EvalReport): CompareResult {
  const baselinePass = new Map(baseline.tasks.map((task) => [task.taskId, task.passedTrusted]));
  const improved: string[] = [];
  const regressed: string[] = [];
  const unchanged: string[] = [];

  for (const task of candidate.tasks) {
    const before = baselinePass.get(task.taskId);
    if (before === undefined) {
      unchanged.push(task.taskId);
      continue;
    }
    if (!before && task.passedTrusted) improved.push(task.taskId);
    else if (before && !task.passedTrusted) regressed.push(task.taskId);
    else unchanged.push(task.taskId);
  }

  return {
    baseline: baseline.agentId,
    candidate: candidate.agentId,
    trustedDelta: candidate.trustedMetric.value - baseline.trustedMetric.value,
    improved,
    regressed,
    unchanged,
  };
}

export function formatReport(report: EvalReport): string {
  const lines = [
    `eval ${report.name}  agent=${report.agentId}  judge=${report.judgeId}`,
    `trusted successAtLatency=${report.trustedMetric.value.toFixed(3)} (${report.trustedMetric.passed}/${report.trustedMetric.total})  budget=${report.latencyBudgetMs}ms`,
    `axes taskSuccess=${report.axes.taskSuccessRate.toFixed(3)}  hallucination=${report.axes.hallucinationRate.toFixed(3)}  p50=${report.axes.p50LatencyMs}ms  p95=${report.axes.p95LatencyMs}ms  judgeDisagree=${report.axes.judgeDisagreementRate.toFixed(3)}`,
    "",
  ];
  for (const task of report.tasks) {
    const mark = task.passedTrusted ? "PASS" : "FAIL";
    const hall = task.programmatic.hallucinated ? " hallu" : "";
    const disagree = task.judgeDisagreed ? " JUDGE≠FACTS" : "";
    const err = task.agentError ? ` err=${task.agentError}` : "";
    lines.push(`  ${mark} ${task.taskId}  ${task.latencyMs}ms${hall}${disagree}${err}`);
  }
  return lines.join("\n");
}

export function formatCompare(compare: CompareResult): string {
  const sign = compare.trustedDelta >= 0 ? "+" : "";
  return [
    `compare ${compare.baseline} → ${compare.candidate}  trustedDelta=${sign}${compare.trustedDelta.toFixed(3)}`,
    `  improved: ${compare.improved.join(", ") || "—"}`,
    `  regressed: ${compare.regressed.join(", ") || "—"}`,
  ].join("\n");
}
