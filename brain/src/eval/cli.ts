/**
 * Dialy eval CLI — scoring layer, not another agent.
 *
 *   cd brain && npm run eval
 *   npm run eval -- --agent bad
 *   npm run eval -- --compare
 *   npm run eval -- --voice
 *   npm run eval -- --judge grok    # needs XAI_API_KEY / GROK_API_KEY
 */
import fs from "node:fs";
import path from "node:path";

import { liveHostAgent, scriptedAgent } from "./agent.js";
import { grokApiKey, resolveJudge } from "./judge.js";
import { loadSuite, loadUtterances } from "./load.js";
import { compareReports, formatCompare, formatReport } from "./report.js";
import { runEval } from "./runner.js";
import { formatVoiceBakeoff, runVoiceBakeoff } from "./voice-bakeoff.js";

function arg(flag: string): string | undefined {
  const index = process.argv.indexOf(flag);
  if (index < 0) return undefined;
  return process.argv[index + 1];
}

function has(flag: string): boolean {
  return process.argv.includes(flag);
}

function writeJson(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

async function main(): Promise<void> {
  const suite = loadSuite();
  const outDir = arg("--out") ?? path.join(process.cwd(), "eval-out");

  if (has("--voice")) {
    const report = await runVoiceBakeoff(loadUtterances());
    writeJson(path.join(outDir, "voice-bakeoff.json"), report);
    console.log(formatVoiceBakeoff(report));
    return;
  }

  const judgeKind = arg("--judge") ?? (grokApiKey() && has("--live-judge") ? "grok" : "scripted");
  if (judgeKind === "grok" && !grokApiKey()) {
    throw new Error(" --judge grok needs XAI_API_KEY or GROK_API_KEY. Default is the scripted judge (free).");
  }
  const { id: judgeId, judge } = resolveJudge(judgeKind);

  const liveUrl = arg("--live");
  const good = liveUrl
    ? liveHostAgent({ baseUrl: liveUrl, token: process.env.BRAIN_TOKEN })
    : scriptedAgent("good");
  const bad = scriptedAgent("bad");

  if (has("--compare") || arg("--agent") === "compare") {
    const baseline = await runEval({ suite, agent: bad, judge, judgeId });
    const candidate = await runEval({ suite, agent: good, judge, judgeId });
    writeJson(path.join(outDir, "baseline.json"), baseline);
    writeJson(path.join(outDir, "candidate.json"), candidate);
    writeJson(path.join(outDir, "compare.json"), compareReports(baseline, candidate));
    console.log(formatReport(baseline));
    console.log("");
    console.log(formatReport(candidate));
    console.log("");
    console.log(formatCompare(compareReports(baseline, candidate)));
    return;
  }

  const variant = arg("--agent") === "bad" ? bad : good;
  const report = await runEval({ suite, agent: variant, judge, judgeId });
  writeJson(path.join(outDir, "report.json"), report);
  console.log(formatReport(report));
  if (report.trustedMetric.value < 1 && variant.id.startsWith("scripted:good")) {
    process.exitCode = 1;
  }
  if (variant.id.startsWith("scripted:bad") && report.trustedMetric.value !== 0) {
    process.exitCode = 1;
  }
}

try {
  await main();
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
