import { describe, expect, it, vi } from "vitest";

import {
    pickVoiceProviders,
    synthesizeSpeech,
    transcribeAudio,
    VOICE_PIPELINE,
    type VoiceConfig,
} from "./voice.js";

const elevenOnly: VoiceConfig = {
    deepgram: null,
    elevenlabs: { apiKey: "el-key" },
    sarvam: null,
};

const fullStack: VoiceConfig = {
    deepgram: { apiKey: "dg-key" },
    elevenlabs: { apiKey: "el-key" },
    sarvam: { apiKey: "sv-key", languageCode: "gu-IN" },
};

describe("voice pipeline", () => {
    it("picks ElevenLabs STT and Sarvam TTS when both keys exist", () => {
        expect(VOICE_PIPELINE).toEqual({ stt: "elevenlabs", llm: "assistantModel", tts: "sarvam" });
        expect(pickVoiceProviders(fullStack)).toEqual({ stt: "elevenlabs", tts: "sarvam" });
    });

    it("falls back per stage when the preferred vendor is missing", () => {
        expect(pickVoiceProviders(elevenOnly)).toEqual({ stt: "elevenlabs", tts: "elevenlabs" });
        expect(
            pickVoiceProviders({
                deepgram: { apiKey: "dg" },
                elevenlabs: null,
                sarvam: { apiKey: "sv" },
            }),
        ).toEqual({ stt: "deepgram", tts: "sarvam" });
    });

    it("transcribes via ElevenLabs Scribe, not Deepgram, when both keys exist", async () => {
        const fetchImpl = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
            const url = String(input);
            expect(url).toContain("elevenlabs.io/v1/speech-to-text");
            return new Response(JSON.stringify({ text: "hello from scribe" }), {
                status: 200,
                headers: { "Content-Type": "application/json" },
            });
        });
        const { transcript } = await transcribeAudio(Buffer.from("audio"), {
            config: fullStack,
            fetchImpl: fetchImpl as unknown as typeof fetch,
        });
        expect(transcript).toBe("hello from scribe");
        expect(fetchImpl).toHaveBeenCalledTimes(1);
        const url = String(fetchImpl.mock.calls[0]?.[0]);
        expect(url).not.toContain("deepgram");
    });

    it("synthesizes via Sarvam, not ElevenLabs, when both keys exist", async () => {
        const wav = Buffer.alloc(48, 0);
        wav.write("RIFF", 0);
        wav.writeUInt32LE(40, 4);
        wav.write("WAVE", 8);
        const fetchImpl = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => {
            const url = String(_input);
            expect(url).toContain("api.sarvam.ai/text-to-speech");
            return new Response(JSON.stringify({ audios: [wav.toString("base64")] }), {
                status: 200,
                headers: { "Content-Type": "application/json" },
            });
        });
        const { mimeType, audioBase64 } = await synthesizeSpeech("kem cho", {
            config: fullStack,
            languageCode: "gu-IN",
            fetchImpl: fetchImpl as unknown as typeof fetch,
        });
        expect(mimeType).toBe("audio/wav");
        expect(audioBase64).toBe(wav.toString("base64"));
        const init = fetchImpl.mock.calls[0]?.[1];
        const body = JSON.parse(String(init?.body));
        expect(body.target_language_code).toBe("gu-IN");
        expect(String(fetchImpl.mock.calls[0]?.[0])).not.toContain("elevenlabs");
    });
});
