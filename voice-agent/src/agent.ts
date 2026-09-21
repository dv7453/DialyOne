import { config } from "dotenv";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  AutoSubscribe,
  type JobContext,
  type JobProcess,
  ServerOptions,
  cli,
  defineAgent,
  voice,
} from "@livekit/agents";
import * as sarvam from "@livekit/agents-plugin-sarvam";
import * as silero from "@livekit/agents-plugin-silero";
import { SseBrainClient } from "./brain-client.js";
import { BrainLLM } from "./brain-llm.js";
import { AGENT_NAME, DRAIN_TIMEOUT_MS } from "./constants.js";
import { resolveSessionLanguage, type SessionLanguage } from "./language.js";

config();

/**
 * Silero VAD durations in this Node plugin are **milliseconds**.
 * Python docs use seconds — passing `0.55` here would be 0.55 ms and break turn-taking.
 * These are the Node defaults; written out so they cannot be confused with the Python values.
 */
const SILERO_VAD_MS = {
  minSpeechDuration: 50,
  minSilenceDuration: 550,
  prefixPaddingDuration: 500,
  activationThreshold: 0.5,
} as const;

type ProcessData = {
  vad?: Awaited<ReturnType<typeof silero.VAD.load>>;
};

function createSarvamStt(language: SessionLanguage): sarvam.STT {
  return new sarvam.STT({
    languageCode: language,
    model: "saaras:v3",
    mode: "codemix",
  });
}

function createSarvamTts(language: SessionLanguage): sarvam.TTS {
  return new sarvam.TTS({
    targetLanguageCode: language,
    model: "bulbul:v3",
    speaker: "shubh",
  });
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is required`);
  }
  return value;
}

export default defineAgent({
  prewarm: async (proc: JobProcess<ProcessData>) => {
    proc.userData.vad = await silero.VAD.load({ ...SILERO_VAD_MS });
  },

  entry: async (ctx: JobContext<ProcessData>) => {
    const vad = ctx.proc.userData.vad;
    if (!vad) {
      throw new Error("Silero VAD was not loaded in prewarm");
    }

    await ctx.connect(undefined, AutoSubscribe.AUDIO_ONLY);
    const participant = await ctx.waitForParticipant();

    const language = resolveSessionLanguage({
      participantAttributes: participant.attributes,
      roomMetadata: ctx.room.metadata,
      jobMetadata: ctx.job.metadata,
    });

    const sessionId = ctx.room.name || ctx.job.id;
    const brain = new SseBrainClient({
      baseUrl: requireEnv("BRAIN_URL"),
      token: requireEnv("BRAIN_TOKEN"),
    });

    const session = new voice.AgentSession({
      vad,
      stt: createSarvamStt(language),
      tts: createSarvamTts(language),
      llm: new BrainLLM(brain, sessionId),
      turnHandling: { turnDetection: "vad" },
      userData: { language, sessionId, participantIdentity: participant.identity },
    });

    await session.start({
      room: ctx.room,
      agent: voice.Agent.create({
        instructions:
          "You are Dialy's voice channel. Spoken replies come from the brain; do not invent a persona here.",
      }),
    });

    session.generateReply();
  },
});

const thisFile = fileURLToPath(import.meta.url);
if (process.argv[1] && resolve(process.argv[1]) === thisFile) {
  cli.runApp(
    new ServerOptions({
      agent: thisFile,
      agentName: AGENT_NAME,
      drainTimeout: DRAIN_TIMEOUT_MS,
    }),
  );
}
