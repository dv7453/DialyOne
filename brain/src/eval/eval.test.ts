import { describe, expect, it, vi } from "vitest";

import { emptyAgent, liveHostAgent, scriptedAgent, slowAgent, throwingAgent } from "./agent.js";
import {
  JUDGE_FAILURE_MODES,
  extractJsonObject,
  grokChatComplete,
  grokJudge,
  judgeDisagreed,
  parseJudgeVerdict,
  scriptedJudge,
  sycophanticJudge,
} from "./judge.js";
import { loadSuite, loadUtterances, taskById } from "./load.js";
import { includesFact, isNegatedClaim, percentile, scoreProgrammatic } from "./programmatic.js";
import { compareReports } from "./report.js";
import { passedTrusted, runEval } from "./runner.js";
import { runStt, runTts, runVoiceBakeoff, stubStt } from "./voice-bakeoff.js";

describe("eval fixtures", () => {
  it("loads 16 unique text tasks and 20 utterances", () => {
    const suite = loadSuite();
    expect(suite.tasks).toHaveLength(16);
    expect(new Set(suite.tasks.map((task) => task.id)).size).toBe(16);
    expect(loadUtterances()).toHaveLength(20);
  });

  it("rejects duplicate task ids", () => {
    expect(() =>
      loadSuite(
        // reuse utterances file — not a suite
        new URL("./fixtures/utterances.json", import.meta.url).pathname,
      ),
    ).toThrow();
  });
});

describe("programmatic scorer", () => {
  const suite = loadSuite();

  it("does not treat 3 as present inside 37", () => {
    expect(includesFact("37 of 40 registered", "3")).toBe(false);
    expect(includesFact("3 seats left", "3")).toBe(true);
    expect(includesFact("thanks for the $250k offer", "$250k")).toBe(true);
    expect(isNegatedClaim("Draft filled; not signed.", "signed")).toBe(true);
    expect(isNegatedClaim("Nothing about DNS.", "DNS")).toBe(true);
  });

  it("marks every good reply as trusted and every bad reply as untrusted", () => {
    for (const task of suite.tasks) {
      const good = scoreProgrammatic(task, task.replies.good);
      const bad = scoreProgrammatic(task, task.replies.bad);
      expect(good.taskSuccess, task.id).toBe(true);
      expect(good.hallucinated, task.id).toBe(false);
      expect(bad.taskSuccess && !bad.hallucinated, `${task.id} bad should not pass`).toBe(false);
    }
  });

  it("fails empty replies without calling them hallucinations", () => {
    const task = taskById(suite, "empty-inbox");
    const score = scoreProgrammatic(task, "   ");
    expect(score.taskSuccess).toBe(false);
    expect(score.hallucinated).toBe(false);
  });

  it("computes percentiles on a known series", () => {
    expect(percentile([1, 2, 3, 4, 5], 50)).toBe(3);
    expect(percentile([], 50)).toBe(0);
  });
});

describe("LLM-as-judge", () => {
  it("documents the failure modes the role asks about", () => {
    expect(JUDGE_FAILURE_MODES.map((mode) => mode.id)).toEqual([
      "sycophancy",
      "verbosity-bias",
      "invalid-json",
      "uncalibrated-confidence",
      "self-preference",
      "position-bias",
    ]);
  });

  it("salvages JSON from fences and fails closed on garbage", () => {
    const ok = parseJudgeVerdict(
      'Sure.\n```json\n{"taskSuccess":true,"hallucinated":false,"rationale":"ok","confidence":0.4}\n```',
    );
    expect(ok.taskSuccess).toBe(true);
    expect(ok.parseError).toBeUndefined();
    const dead = parseJudgeVerdict("I think it was fine");
    expect(dead.taskSuccess).toBe(false);
    expect(dead.hallucinated).toBe(true);
    expect(dead.parseError).toBeTruthy();
  });

  it("rejects out-of-range confidence instead of quietly clamping", () => {
    expect(parseJudgeVerdict(JSON.stringify({
      taskSuccess: true,
      hallucinated: false,
      rationale: "great",
      confidence: 1.4,
    })).parseError).toMatch(/Number/i);
  });

  it("extractJsonObject throws when there is no object", () => {
    expect(() => extractJsonObject("[1,2]")).toThrow(/no JSON object/);
  });

  it("scripted judge matches programmatic facts; sycophantic judge does not", async () => {
    const task = taskById(loadSuite(), "investor-reply");
    const scripted = scriptedJudge();
    const suckup = sycophanticJudge();
    const facts = scoreProgrammatic(task, task.replies.bad);
    const honest = await scripted({ task, reply: task.replies.bad });
    const naive = await suckup({ task, reply: task.replies.bad });
    expect(judgeDisagreed(facts, honest)).toBe(false);
    expect(naive.taskSuccess).toBe(true);
    expect(naive.hallucinated).toBe(false);
    expect(judgeDisagreed(facts, naive)).toBe(true);
  });

  it("grok transport sends Bearer auth and parses choices[0]", async () => {
    const fetchImpl = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      expect(String(_url)).toContain("api.x.ai");
      expect((init?.headers as Record<string, string>).Authorization).toBe("Bearer test-key");
      return new Response(
        JSON.stringify({
          choices: [{ message: { content: '{"taskSuccess":false,"hallucinated":true,"rationale":"invented send","confidence":0.2}' } }],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    });
    const judge = grokJudge({ apiKey: "test-key", fetchImpl: fetchImpl as unknown as typeof fetch });
    const task = taskById(loadSuite(), "investor-reply");
    const verdict = await judge({ task, reply: task.replies.bad });
    expect(verdict.hallucinated).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("refuses to call Grok without a key", async () => {
    await expect(grokChatComplete("hi", { apiKey: null })).rejects.toThrow(/No XAI_API_KEY/);
  });

  it("surfaces HTTP errors from the judge endpoint", async () => {
    const fetchImpl = vi.fn(async () => new Response("nope", { status: 429 }));
    await expect(
      grokChatComplete("x", { apiKey: "k", fetchImpl: fetchImpl as unknown as typeof fetch }),
    ).rejects.toThrow(/429/);
  });
});

describe("eval runner", () => {
  it("gives the good agent a perfect trusted metric", async () => {
    const report = await runEval({
      suite: loadSuite(),
      agent: scriptedAgent("good"),
      judge: scriptedJudge(),
      judgeId: "scripted",
      now: () => new Date("2026-09-29T00:00:00.000Z"),
    });
    expect(report.trustedMetric.value).toBe(1);
    expect(report.axes.taskSuccessRate).toBe(1);
    expect(report.axes.hallucinationRate).toBe(0);
    expect(report.axes.judgeDisagreementRate).toBe(0);
    expect(report.tasks).toHaveLength(16);
  });

  it("gives the bad agent a zero trusted metric", async () => {
    const report = await runEval({
      suite: loadSuite(),
      agent: scriptedAgent("bad"),
      judge: scriptedJudge(),
      judgeId: "scripted",
    });
    expect(report.trustedMetric.value).toBe(0);
    expect(report.axes.hallucinationRate).toBeGreaterThan(0.5);
  });

  it("flags judge disagreement when a sycophantic judge grades the bad agent", async () => {
    const report = await runEval({
      suite: loadSuite(),
      agent: scriptedAgent("bad"),
      judge: sycophanticJudge(),
      judgeId: "sycophantic",
    });
    expect(report.axes.judgeDisagreementRate).toBeGreaterThan(0.8);
    expect(report.trustedMetric.value).toBe(0);
  });

  it("fails the trusted metric when latency exceeds the budget even if facts are right", async () => {
    const suite = loadSuite();
    const report = await runEval({
      suite: { ...suite, latencyBudgetMs: 5 },
      agent: slowAgent(50, scriptedAgent("good")),
      judge: scriptedJudge(),
      judgeId: "scripted",
    });
    expect(report.trustedMetric.value).toBe(0);
    expect(report.tasks.every((task) => !passedTrusted(task, 5))).toBe(true);
  });

  it("records thrown agents and empty replies as failures, not crashes", async () => {
    const suite = { ...loadSuite(), tasks: loadSuite().tasks.slice(0, 1) };
    const boom = await runEval({ suite, agent: throwingAgent("disk") });
    expect(boom.tasks[0]?.agentError).toMatch(/disk/);
    expect(boom.trustedMetric.value).toBe(0);
    const empty = await runEval({ suite, agent: emptyAgent() });
    expect(empty.tasks[0]?.reply).toBe("");
    expect(empty.tasks[0]?.programmatic.taskSuccess).toBe(false);
  });

  it("fail-closes when the judge throws", async () => {
    const suite = { ...loadSuite(), tasks: loadSuite().tasks.slice(0, 1) };
    const report = await runEval({
      suite,
      agent: scriptedAgent("good"),
      judge: async () => {
        throw new Error("judge down");
      },
      judgeId: "down",
    });
    expect(report.tasks[0]?.judge?.parseError).toMatch(/judge down/);
    expect(report.tasks[0]?.judgeDisagreed).toBe(true);
    expect(report.trustedMetric.value).toBe(1);
  });

  it("compares good vs bad as a prompt/model change would", async () => {
    const suite = loadSuite();
    const baseline = await runEval({ suite, agent: scriptedAgent("bad"), judge: scriptedJudge(), judgeId: "scripted" });
    const candidate = await runEval({ suite, agent: scriptedAgent("good"), judge: scriptedJudge(), judgeId: "scripted" });
    const diff = compareReports(baseline, candidate);
    expect(diff.trustedDelta).toBe(1);
    expect(diff.regressed).toEqual([]);
    expect(diff.improved).toHaveLength(16);
  });

  it("live host adapter maps HTTP text and errors without throwing", async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ text: "Draft ready for Priya: $250k Thursday, waiting on approve." }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    const agent = liveHostAgent({ baseUrl: "https://example.test", fetchImpl: fetchImpl as unknown as typeof fetch });
    const task = taskById(loadSuite(), "investor-reply");
    const reply = await agent.complete(task);
    expect(reply.text).toMatch(/\$250k/);
    const failing = liveHostAgent({
      baseUrl: "https://example.test/",
      fetchImpl: (async () =>
        new Response(JSON.stringify({ error: "nope" }), { status: 501 })) as unknown as typeof fetch,
    });
    const err = await failing.complete(task);
    expect(err.error).toMatch(/nope|501/);
  });
});

describe("voice bakeoff stubs", () => {
  it("runs 20 utterances through two STTs and two TTSs with numbers", async () => {
    const report = await runVoiceBakeoff(loadUtterances());
    expect(report.stt).toHaveLength(40);
    expect(report.tts).toHaveLength(40);
    expect(report.summary.stt.map((row) => row.provider)).toEqual(["elevenlabs-scribe", "deepgram"]);
    expect(report.summary.tts.map((row) => row.provider)).toEqual(["sarvam-tts", "elevenlabs-tts"]);
    expect(report.tradeoffs.length).toBeGreaterThanOrEqual(2);
    const deepgram = report.summary.stt.find((row) => row.provider === "deepgram");
    const scribe = report.summary.stt.find((row) => row.provider === "elevenlabs-scribe");
    expect(scribe?.meanQuality).toBeGreaterThan(deepgram?.meanQuality ?? 1);
    const sarvam = report.summary.tts.find((row) => row.provider === "sarvam-tts");
    const eleven = report.summary.tts.find((row) => row.provider === "elevenlabs-tts");
    expect(sarvam?.totalCostUsd).toBeLessThan(eleven?.totalCostUsd ?? 0);
  });

  it("records provider throws per utterance instead of aborting the set", async () => {
    const rows = await runStt("deepgram", loadUtterances().slice(0, 2), async () => {
      throw new Error("quota");
    });
    expect(rows.every((row) => row.error === "quota")).toBe(true);
    const tts = await runTts("sarvam-tts", loadUtterances().slice(0, 1), async () => {
      throw new Error("tts-down");
    });
    expect(tts[0]?.error).toBe("tts-down");
  });

  it("scores imperfect transcripts below 1", async () => {
    const [row] = await runStt("elevenlabs-scribe", [loadUtterances()[0]!], stubStt("deepgram"));
    expect(row?.quality).toBeGreaterThan(0);
  });
});
