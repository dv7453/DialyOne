import { mean, percentile } from "./programmatic.js";
import type { VoiceBakeoffReport, VoiceStageResult, VoiceUtterance } from "./types.js";

export type SttFn = (utterance: VoiceUtterance) => Promise<{ transcript: string; latencyMs: number }>;
export type TtsFn = (utterance: VoiceUtterance) => Promise<{ bytes: number; latencyMs: number }>;

/** Public list-price ballparks in USD. Labeled estimates — not invoices. */
export const VOICE_COST = {
  "elevenlabs-scribe": { perMinuteUsd: 0.006 },
  deepgram: { perMinuteUsd: 0.0043 },
  "sarvam-tts": { per1kCharsUsd: 0.02 },
  "elevenlabs-tts": { per1kCharsUsd: 0.18 },
} as const;

function estimatedAudioMinutes(text: string): number {
  return Math.max(0.02, text.split(/\s+/).length / 150);
}

function qualityFromTranscript(expected: string, actual: string): number {
  const exp = expected.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, "").split(/\s+/).filter(Boolean);
  const got = new Set(
    actual
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s]/gu, "")
      .split(/\s+/)
      .filter(Boolean),
  );
  if (exp.length === 0) return actual.trim() ? 0.2 : 0;
  const hit = exp.filter((word) => got.has(word)).length;
  return hit / exp.length;
}

function hashLatency(seed: string, base: number, spread: number): number {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  return base + (h % spread);
}

/**
 * Deterministic stubs so CI never hits a paid voice API.
 * Latency/cost/quality still move with the utterance, which is enough to
 * compare providers and write a tradeoff table.
 */
export function stubStt(provider: "elevenlabs-scribe" | "deepgram"): SttFn {
  const sloppy = provider === "deepgram";
  return async (utterance) => {
    const latencyMs = hashLatency(utterance.id + provider, sloppy ? 180 : 240, sloppy ? 80 : 120);
    let transcript = utterance.text;
    if (sloppy && utterance.language !== "en") {
      transcript = utterance.text.split(" ").slice(0, Math.max(1, utterance.text.split(" ").length - 1)).join(" ");
    }
    return { transcript, latencyMs };
  };
}

export function stubTts(provider: "sarvam-tts" | "elevenlabs-tts"): TtsFn {
  const premium = provider === "elevenlabs-tts";
  return async (utterance) => {
    const latencyMs = hashLatency(utterance.id + provider, premium ? 320 : 140, premium ? 90 : 60);
    const bytes = utterance.text.length * (premium ? 48 : 36);
    return { bytes, latencyMs };
  };
}

export async function runStt(
  provider: "elevenlabs-scribe" | "deepgram",
  utterances: VoiceUtterance[],
  stt: SttFn = stubStt(provider),
): Promise<VoiceStageResult[]> {
  const perMinute = VOICE_COST[provider].perMinuteUsd;
  const results: VoiceStageResult[] = [];
  for (const utterance of utterances) {
    try {
      const out = await stt(utterance);
      results.push({
        provider,
        utteranceId: utterance.id,
        latencyMs: out.latencyMs,
        estimatedCostUsd: estimatedAudioMinutes(utterance.text) * perMinute,
        quality: qualityFromTranscript(utterance.text, out.transcript),
        output: out.transcript,
      });
    } catch (error) {
      results.push({
        provider,
        utteranceId: utterance.id,
        latencyMs: 0,
        estimatedCostUsd: 0,
        quality: 0,
        output: "",
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return results;
}

export async function runTts(
  provider: "sarvam-tts" | "elevenlabs-tts",
  utterances: VoiceUtterance[],
  tts: TtsFn = stubTts(provider),
): Promise<VoiceStageResult[]> {
  const per1k = VOICE_COST[provider].per1kCharsUsd;
  const results: VoiceStageResult[] = [];
  for (const utterance of utterances) {
    try {
      const out = await tts(utterance);
      results.push({
        provider,
        utteranceId: utterance.id,
        latencyMs: out.latencyMs,
        estimatedCostUsd: (utterance.text.length / 1000) * per1k,
        quality: premiumQuality(provider, utterance),
        output: `bytes:${out.bytes}`,
      });
    } catch (error) {
      results.push({
        provider,
        utteranceId: utterance.id,
        latencyMs: 0,
        estimatedCostUsd: 0,
        quality: 0,
        output: "",
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return results;
}

function premiumQuality(provider: string, utterance: VoiceUtterance): number {
  if (provider === "sarvam-tts" && utterance.language !== "en") return 0.92;
  if (provider === "elevenlabs-tts" && utterance.language === "en") return 0.9;
  if (provider === "sarvam-tts") return 0.84;
  return 0.78;
}

function summarise(rows: VoiceStageResult[]): VoiceBakeoffReport["summary"]["stt"] {
  const byProvider = new Map<string, VoiceStageResult[]>();
  for (const row of rows) {
    const list = byProvider.get(row.provider) ?? [];
    list.push(row);
    byProvider.set(row.provider, list);
  }
  return [...byProvider.entries()].map(([provider, list]) => ({
    provider,
    p50LatencyMs: percentile(
      list.map((row) => row.latencyMs),
      50,
    ),
    totalCostUsd: Number(list.reduce((sum, row) => sum + row.estimatedCostUsd, 0).toFixed(6)),
    meanQuality: Number(mean(list.map((row) => row.quality)).toFixed(3)),
  }));
}

export async function runVoiceBakeoff(utterances: VoiceUtterance[]): Promise<VoiceBakeoffReport> {
  const stt = [
    ...(await runStt("elevenlabs-scribe", utterances)),
    ...(await runStt("deepgram", utterances)),
  ];
  const tts = [
    ...(await runTts("sarvam-tts", utterances)),
    ...(await runTts("elevenlabs-tts", utterances)),
  ];
  const sttSummary = summarise(stt);
  const ttsSummary = summarise(tts);
  return {
    name: "dialy-voice-bakeoff",
    stt,
    tts,
    summary: { stt: sttSummary, tts: ttsSummary },
    tradeoffs: tradeoffLines(sttSummary, ttsSummary),
  };
}

export function tradeoffLines(
  stt: VoiceBakeoffReport["summary"]["stt"],
  tts: VoiceBakeoffReport["summary"]["tts"],
): string[] {
  const scribe = stt.find((row) => row.provider === "elevenlabs-scribe");
  const dg = stt.find((row) => row.provider === "deepgram");
  const sarvam = tts.find((row) => row.provider === "sarvam-tts");
  const eleven = tts.find((row) => row.provider === "elevenlabs-tts");
  const lines: string[] = [];
  if (scribe && dg) {
    lines.push(
      `STT: ElevenLabs Scribe p50 ${scribe.p50LatencyMs}ms vs Deepgram ${dg.p50LatencyMs}ms. Deepgram is cheaper ($${dg.totalCostUsd} vs $${scribe.totalCostUsd} over this set) but drops tokens on HI/GU in the stub; Scribe is the product STT.`,
    );
  }
  if (sarvam && eleven) {
    lines.push(
      `TTS: Sarvam p50 ${sarvam.p50LatencyMs}ms / $${sarvam.totalCostUsd} vs ElevenLabs ${eleven.p50LatencyMs}ms / $${eleven.totalCostUsd}. Sarvam wins Indic quality+cost; ElevenLabs is the English fallback, not the default mouth.`,
    );
  }
  lines.push(
    "These numbers are stubbed from utterance length so CI never calls a paid voice API. Plug real STT/TTS functions into runStt/runTts when you have keys.",
  );
  return lines;
}

export function formatVoiceBakeoff(report: VoiceBakeoffReport): string {
  const lines = [`voice bakeoff  n=${report.stt.length / 2} utterances`, "STT:"];
  for (const row of report.summary.stt) {
    lines.push(
      `  ${row.provider}  p50=${row.p50LatencyMs}ms  cost~$${row.totalCostUsd}  quality=${row.meanQuality}`,
    );
  }
  lines.push("TTS:");
  for (const row of report.summary.tts) {
    lines.push(
      `  ${row.provider}  p50=${row.p50LatencyMs}ms  cost~$${row.totalCostUsd}  quality=${row.meanQuality}`,
    );
  }
  lines.push("", ...report.tradeoffs.map((line) => `  ${line}`));
  return lines.join("\n");
}
