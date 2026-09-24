// Builtin tools: voice domain. Same per-stage pipeline as in-app voice
// (ElevenLabs Scribe STT → LLM → Sarvam TTS, with Deepgram / ElevenLabs fallbacks).

import { z } from "zod";
import * as files from "../../../filesystem/files.js";
import { BuiltinToolsSchema } from "../types.js";

// voice/voice.js reaches di/container (via auth/tokens), which circles back
// to the catalog through the agent resolver — import it lazily so this
// domain can never trip the cycle regardless of evaluation order (same
// lesson as the skills/index ↔ models/defaults cycle).

export const MAX_TTS_TEXT_CHARS = 5000;
const MAX_TRANSCRIBE_BYTES = 100 * 1024 * 1024;

export const voiceTools: z.infer<typeof BuiltinToolsSchema> = {
    'text-to-speech': {
        permission: "file-boundary",
        description: "Convert text to spoken audio via Dialy's voice pipeline (Sarvam TTS, ElevenLabs fallback) and save it. Returns the saved path. Use for narration or audio versions of notes. Pass an ElevenLabs voiceId only when the Sarvam stage is not configured.",
        inputSchema: z.object({
            text: z.string().min(1).max(MAX_TTS_TEXT_CHARS)
                .describe(`The text to speak (max ${MAX_TTS_TEXT_CHARS} chars — synthesize long content one segment per call)`),
            outputPath: z.string().optional()
                .describe("Where to save the audio (workspace-relative or absolute). Default: media/tts/tts-<timestamp>."),
            voiceId: z.string().optional()
                .describe("ElevenLabs voice id when falling back to ElevenLabs TTS. Omit for Sarvam / default voice."),
            languageCode: z.string().optional()
                .describe("Sarvam target language (en-IN, hi-IN, gu-IN). Defaults to config / en-IN."),
        }),
        execute: async ({ text, outputPath, voiceId, languageCode }: { text: string; outputPath?: string; voiceId?: string; languageCode?: string }) => {
            try {
                const { synthesizeSpeech } = await import("../../../voice/voice.js");
                const { audioBase64, mimeType } = await synthesizeSpeech(text, { voiceId, modelId: 'eleven_turbo_v2_5', languageCode });
                const buffer = Buffer.from(audioBase64, 'base64');
                const ext = mimeType.includes('wav') ? 'wav' : 'mp3';
                const target = outputPath
                    || `media/tts/tts-${new Date().toISOString().replace(/[:.]/g, '-')}.${ext}`;
                const result = await files.writeBuffer(target, buffer);
                return { success: true, path: result.path, resolvedPath: result.resolvedPath, mimeType, bytes: buffer.length };
            } catch (e) {
                return { success: false, error: e instanceof Error ? e.message : String(e) };
            }
        },
    },
    'transcribe-audio': {
        permission: "file-boundary",
        description: "Transcribe an audio file to text via Dialy's STT stage (ElevenLabs Scribe, Deepgram fallback). Handles common formats (wav, mp3, ogg/opus, webm).",
        inputSchema: z.object({
            path: z.string().describe("The audio file to transcribe (workspace-relative or absolute)"),
        }),
        execute: async ({ path: inputPath }: { path: string }) => {
            try {
                const { buffer, path: originalPath } = await files.readBuffer(inputPath);
                if (buffer.length === 0) return { success: false, error: `File is empty: ${inputPath}` };
                if (buffer.length > MAX_TRANSCRIBE_BYTES) {
                    return { success: false, error: `File exceeds ${MAX_TRANSCRIBE_BYTES / (1024 * 1024)} MB: ${inputPath}` };
                }
                const { transcribeAudio } = await import("../../../voice/voice.js");
                const { transcript } = await transcribeAudio(buffer);
                return { success: true, path: originalPath, transcript };
            } catch (e) {
                return { success: false, error: e instanceof Error ? e.message : String(e) };
            }
        },
    },
};
