import * as fs from "fs/promises";
import * as path from "path";
import { WorkDir } from "../config/config.js";

export type SttProvider = "elevenlabs" | "deepgram";
export type TtsProvider = "sarvam" | "elevenlabs";

/** Cost-optimized pipeline: pick a vendor per stage, not one voice-agent SKU. */
export const VOICE_PIPELINE = {
    stt: "elevenlabs",
    llm: "assistantModel",
    tts: "sarvam",
} as const;

export interface VoiceConfig {
    deepgram: { apiKey: string } | null;
    elevenlabs: { apiKey: string; voiceId?: string } | null;
    sarvam: { apiKey: string; speaker?: string; languageCode?: string } | null;
}

export type VoiceFetch = typeof fetch;

const DEFAULT_VOICE_ID = "s3TPKV1kjDlVtZbl4Ksh";
const DEFAULT_SARVAM_SPEAKER = "anushka";
const DEFAULT_SARVAM_LANGUAGE = "en-IN";
const SARVAM_MAX_CHARS = 2400;
const ELEVENLABS_STT_URL = "https://api.elevenlabs.io/v1/speech-to-text";
const SARVAM_TTS_URL = "https://api.sarvam.ai/text-to-speech";

async function readJsonConfig(filename: string): Promise<Record<string, unknown> | null> {
    try {
        const configPath = path.join(WorkDir, "config", filename);
        const raw = await fs.readFile(configPath, "utf8");
        return JSON.parse(raw);
    } catch {
        return null;
    }
}

function asKey(value: unknown, env: string | undefined): string | null {
    if (typeof value === "string" && value.trim()) return value.trim();
    if (env && env.trim()) return env.trim();
    return null;
}

export async function getVoiceConfig(): Promise<VoiceConfig> {
    const dgConfig = await readJsonConfig("deepgram.json");
    const elConfig = await readJsonConfig("elevenlabs.json");
    const svConfig = await readJsonConfig("sarvam.json");

    const elevenKey = asKey(elConfig?.apiKey, process.env.ELEVENLABS_API_KEY);
    const sarvamKey = asKey(svConfig?.apiKey, process.env.SARVAM_API_KEY);
    const deepgramKey = asKey(dgConfig?.apiKey, process.env.DEEPGRAM_API_KEY);

    return {
        deepgram: deepgramKey ? { apiKey: deepgramKey } : null,
        elevenlabs: elevenKey
            ? {
                  apiKey: elevenKey,
                  voiceId:
                      (typeof elConfig?.voiceId === "string" && elConfig.voiceId) ||
                      process.env.ELEVENLABS_VOICE_ID ||
                      undefined,
              }
            : null,
        sarvam: sarvamKey
            ? {
                  apiKey: sarvamKey,
                  speaker:
                      (typeof svConfig?.speaker === "string" && svConfig.speaker) ||
                      process.env.SARVAM_SPEAKER ||
                      undefined,
                  languageCode:
                      (typeof svConfig?.languageCode === "string" && svConfig.languageCode) ||
                      process.env.SARVAM_LANGUAGE ||
                      undefined,
              }
            : null,
    };
}

export function pickVoiceProviders(config: VoiceConfig): {
    stt: SttProvider | null;
    tts: TtsProvider | null;
} {
    return {
        stt: config.elevenlabs ? "elevenlabs" : config.deepgram ? "deepgram" : null,
        tts: config.sarvam ? "sarvam" : config.elevenlabs ? "elevenlabs" : null,
    };
}

export async function getVoicePipeline(config?: VoiceConfig): Promise<{
    stages: typeof VOICE_PIPELINE;
    active: { stt: SttProvider | null; tts: TtsProvider | null };
}> {
    const resolved = config ?? (await getVoiceConfig());
    return { stages: VOICE_PIPELINE, active: pickVoiceProviders(resolved) };
}

function filenameFromMime(mimeType?: string): string {
    if (!mimeType) return "audio.webm";
    if (mimeType.includes("mpeg") || mimeType.includes("mp3")) return "audio.mp3";
    if (mimeType.includes("wav")) return "audio.wav";
    if (mimeType.includes("ogg") || mimeType.includes("opus")) return "audio.ogg";
    if (mimeType.includes("mp4") || mimeType.includes("m4a")) return "audio.m4a";
    return "audio.webm";
}

function chunkText(text: string, max = SARVAM_MAX_CHARS): string[] {
    const trimmed = text.trim();
    if (trimmed.length <= max) return [trimmed];
    const chunks: string[] = [];
    let remaining = trimmed;
    while (remaining.length > max) {
        let cut = remaining.lastIndexOf(" ", max);
        if (cut < Math.floor(max / 2)) cut = max;
        chunks.push(remaining.slice(0, cut).trim());
        remaining = remaining.slice(cut).trim();
    }
    if (remaining) chunks.push(remaining);
    return chunks;
}

function isWav(buf: Buffer): boolean {
    return buf.length >= 12 && buf.subarray(0, 4).toString("ascii") === "RIFF";
}

function concatAudioBuffers(parts: Buffer[]): Buffer {
    if (parts.length === 1) return parts[0];
    if (parts.every(isWav)) {
        const out = Buffer.concat([parts[0], ...parts.slice(1).map((part) => part.subarray(44))]);
        if (out.length >= 44) {
            out.writeUInt32LE(out.length - 8, 4);
            out.writeUInt32LE(out.length - 44, 40);
        }
        return out;
    }
    return Buffer.concat(parts);
}

async function resolveTtsEndpoint(
    config: VoiceConfig,
    streaming: boolean,
    voiceIdOverride?: string,
): Promise<{ url: string; headers: Record<string, string> }> {
    if (!config.elevenlabs) {
        throw new Error(
            `ElevenLabs not configured. Create ${path.join(WorkDir, "config", "elevenlabs.json")} with { "apiKey": "<your-key>" }`,
        );
    }
    const voiceId = voiceIdOverride || config.elevenlabs.voiceId || DEFAULT_VOICE_ID;
    return {
        url: `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}${streaming ? "/stream" : ""}`,
        headers: {
            "xi-api-key": config.elevenlabs.apiKey,
            "Content-Type": "application/json",
        },
    };
}

function ttsRequestBody(text: string, modelId?: string): string {
    return JSON.stringify({
        text,
        model_id: modelId || "eleven_flash_v2_5",
        voice_settings: {
            stability: 0.5,
            similarity_boost: 0.75,
        },
    });
}

async function transcribeWithElevenLabs(
    audio: Buffer,
    apiKey: string,
    opts: { mimeType?: string; fetchImpl: VoiceFetch },
): Promise<{ transcript: string }> {
    const form = new FormData();
    form.append("model_id", "scribe_v1");
    const blob = new Blob([new Uint8Array(audio)], {
        type: opts.mimeType || "application/octet-stream",
    });
    form.append("file", blob, filenameFromMime(opts.mimeType));

    const response = await opts.fetchImpl(ELEVENLABS_STT_URL, {
        method: "POST",
        headers: { "xi-api-key": apiKey },
        body: form,
    });
    if (!response.ok) {
        const errText = await response.text().catch(() => "Unknown error");
        throw new Error(`ElevenLabs STT error ${response.status}: ${errText}`);
    }
    const result = (await response.json()) as { text?: string };
    return { transcript: (result.text ?? "").trim() };
}

async function transcribeWithDeepgram(
    audio: Buffer,
    apiKey: string,
    opts: { mimeType?: string; fetchImpl: VoiceFetch },
): Promise<{ transcript: string }> {
    const params = new URLSearchParams({
        model: "nova-3",
        smart_format: "true",
        punctuate: "true",
        language: "en",
    });
    const response = await opts.fetchImpl(`https://api.deepgram.com/v1/listen?${params.toString()}`, {
        method: "POST",
        headers: {
            Authorization: `Token ${apiKey}`,
            "Content-Type": opts.mimeType || "application/octet-stream",
        },
        body: new Uint8Array(audio),
    });
    if (!response.ok) {
        const errText = await response.text().catch(() => "Unknown error");
        throw new Error(`Deepgram ASR error ${response.status}: ${errText}`);
    }
    const result = (await response.json()) as {
        results?: { channels?: Array<{ alternatives?: Array<{ transcript?: string }> }> };
    };
    const transcript = result.results?.channels?.[0]?.alternatives?.[0]?.transcript ?? "";
    return { transcript: transcript.trim() };
}

async function synthesizeWithSarvam(
    text: string,
    config: NonNullable<VoiceConfig["sarvam"]>,
    opts: { languageCode?: string; fetchImpl: VoiceFetch },
): Promise<{ audioBase64: string; mimeType: string }> {
    const languageCode = opts.languageCode || config.languageCode || DEFAULT_SARVAM_LANGUAGE;
    const speaker = config.speaker || DEFAULT_SARVAM_SPEAKER;
    const chunks = chunkText(text);
    const buffers: Buffer[] = [];

    for (const chunk of chunks) {
        const response = await opts.fetchImpl(SARVAM_TTS_URL, {
            method: "POST",
            headers: {
                "api-subscription-key": config.apiKey,
                "Content-Type": "application/json",
            },
            body: JSON.stringify({
                text: chunk,
                target_language_code: languageCode,
                speaker,
                model: "bulbul:v2",
                speech_sample_rate: 22050,
                enable_preprocessing: true,
            }),
        });
        if (!response.ok) {
            const errText = await response.text().catch(() => "Unknown error");
            throw new Error(`Sarvam TTS error ${response.status}: ${errText}`);
        }
        const result = (await response.json()) as { audios?: string[] };
        const encoded = result.audios?.[0];
        if (!encoded) {
            throw new Error("Sarvam TTS returned no audio");
        }
        buffers.push(Buffer.from(encoded, "base64"));
    }

    const combined = concatAudioBuffers(buffers);
    const mimeType = isWav(combined) ? "audio/wav" : "audio/mpeg";
    return { audioBase64: combined.toString("base64"), mimeType };
}

async function synthesizeWithElevenLabs(
    text: string,
    config: VoiceConfig,
    opts: { voiceId?: string; modelId?: string; fetchImpl: VoiceFetch },
): Promise<{ audioBase64: string; mimeType: string }> {
    const { url, headers } = await resolveTtsEndpoint(config, false, opts.voiceId);
    const response = await opts.fetchImpl(url, {
        method: "POST",
        headers,
        body: ttsRequestBody(text, opts.modelId),
    });
    if (!response.ok) {
        const errText = await response.text().catch(() => "Unknown error");
        throw new Error(`ElevenLabs TTS error ${response.status}: ${errText}`);
    }
    const arrayBuffer = await response.arrayBuffer();
    return {
        audioBase64: Buffer.from(arrayBuffer).toString("base64"),
        mimeType: "audio/mpeg",
    };
}

export async function synthesizeSpeech(
    text: string,
    opts?: {
        voiceId?: string;
        modelId?: string;
        languageCode?: string;
        config?: VoiceConfig;
        fetchImpl?: VoiceFetch;
    },
): Promise<{ audioBase64: string; mimeType: string }> {
    const config = opts?.config ?? (await getVoiceConfig());
    const fetchImpl = opts?.fetchImpl ?? fetch;
    const picked = pickVoiceProviders(config);
    console.log("[voice] synthesizing speech, text length:", text.length, "tts:", picked.tts);

    if (picked.tts === "sarvam" && config.sarvam) {
        return synthesizeWithSarvam(text, config.sarvam, { languageCode: opts?.languageCode, fetchImpl });
    }
    if (picked.tts === "elevenlabs") {
        return synthesizeWithElevenLabs(text, config, {
            voiceId: opts?.voiceId,
            modelId: opts?.modelId,
            fetchImpl,
        });
    }
    throw new Error(
        `No TTS configured. Create ${path.join(WorkDir, "config", "sarvam.json")} (preferred) or elevenlabs.json with { "apiKey": "<your-key>" }`,
    );
}

export async function synthesizeSpeechStream(
    text: string,
    onChunk: (chunk: Buffer) => void,
    signal?: AbortSignal,
    opts?: { config?: VoiceConfig; fetchImpl?: VoiceFetch; languageCode?: string },
): Promise<void> {
    const config = opts?.config ?? (await getVoiceConfig());
    const fetchImpl = opts?.fetchImpl ?? fetch;
    const picked = pickVoiceProviders(config);
    console.log("[voice] streaming speech synthesis, text length:", text.length, "tts:", picked.tts);

    if (picked.tts === "sarvam") {
        const { audioBase64 } = await synthesizeSpeech(text, {
            config,
            fetchImpl,
            languageCode: opts?.languageCode,
        });
        onChunk(Buffer.from(audioBase64, "base64"));
        return;
    }

    const { url, headers } = await resolveTtsEndpoint(config, true);
    const response = await fetchImpl(url, {
        method: "POST",
        headers,
        body: ttsRequestBody(text),
        signal: signal ?? null,
    });

    if (!response.ok) {
        const errText = await response.text().catch(() => "Unknown error");
        throw new Error(`ElevenLabs TTS stream error ${response.status}: ${errText}`);
    }
    if (!response.body) {
        throw new Error("TTS API returned no body");
    }

    const reader = response.body.getReader();
    for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value && value.byteLength > 0) {
            onChunk(Buffer.from(value));
        }
    }
}

export async function transcribeAudio(
    audio: Buffer,
    opts?: { mimeType?: string; config?: VoiceConfig; fetchImpl?: VoiceFetch },
): Promise<{ transcript: string }> {
    if (audio.length === 0) throw new Error("audio buffer is empty");
    const config = opts?.config ?? (await getVoiceConfig());
    const fetchImpl = opts?.fetchImpl ?? fetch;
    const picked = pickVoiceProviders(config);
    console.log("[voice] transcribing audio, bytes:", audio.length, "stt:", picked.stt);

    if (picked.stt === "elevenlabs" && config.elevenlabs) {
        return transcribeWithElevenLabs(audio, config.elevenlabs.apiKey, {
            mimeType: opts?.mimeType,
            fetchImpl,
        });
    }
    if (picked.stt === "deepgram" && config.deepgram) {
        return transcribeWithDeepgram(audio, config.deepgram.apiKey, {
            mimeType: opts?.mimeType,
            fetchImpl,
        });
    }
    throw new Error(
        `No STT configured. Create ${path.join(WorkDir, "config", "elevenlabs.json")} (preferred) or deepgram.json with { "apiKey": "<your-key>" }`,
    );
}
