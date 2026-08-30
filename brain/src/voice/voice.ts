import * as fs from 'fs/promises';
import * as path from 'path';
import { WorkDir } from '../config/config.js';

export interface VoiceConfig {
    deepgram: { apiKey: string } | null;
    elevenlabs: { apiKey: string; voiceId?: string } | null;
}

const DEFAULT_VOICE_ID = 's3TPKV1kjDlVtZbl4Ksh';

async function readJsonConfig(filename: string): Promise<Record<string, unknown> | null> {
    try {
        const configPath = path.join(WorkDir, 'config', filename);
        const raw = await fs.readFile(configPath, 'utf8');
        return JSON.parse(raw);
    } catch {
        return null;
    }
}

export async function getVoiceConfig(): Promise<VoiceConfig> {
    const dgConfig = await readJsonConfig('deepgram.json');
    const elConfig = await readJsonConfig('elevenlabs.json');

    return {
        deepgram: dgConfig?.apiKey ? { apiKey: dgConfig.apiKey as string } : null,
        elevenlabs: elConfig?.apiKey
            ? { apiKey: elConfig.apiKey as string, voiceId: elConfig.voiceId as string | undefined }
            : null,
    };
}

async function resolveTtsEndpoint(streaming: boolean, voiceIdOverride?: string): Promise<{ url: string; headers: Record<string, string> }> {
    const config = await getVoiceConfig();
    if (!config.elevenlabs) {
        throw new Error(`ElevenLabs not configured. Create ${path.join(WorkDir, 'config', 'elevenlabs.json')} with { "apiKey": "<your-key>" }`);
    }
    const voiceId = voiceIdOverride || config.elevenlabs.voiceId || DEFAULT_VOICE_ID;
    return {
        url: `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}${streaming ? '/stream' : ''}`,
        headers: {
            'xi-api-key': config.elevenlabs.apiKey,
            'Content-Type': 'application/json',
        },
    };
}

// Default stays flash: the streaming path feeds live voice mode where
// latency wins. Produced audio (the text-to-speech tool, app voice API)
// passes eleven_turbo_v2_5 for noticeably better quality.
function ttsRequestBody(text: string, modelId?: string): string {
    return JSON.stringify({
        text,
        model_id: modelId || 'eleven_flash_v2_5',
        voice_settings: {
            stability: 0.5,
            similarity_boost: 0.75,
        },
    });
}

export async function synthesizeSpeech(text: string, opts?: { voiceId?: string; modelId?: string }): Promise<{ audioBase64: string; mimeType: string }> {
    const { url, headers } = await resolveTtsEndpoint(false, opts?.voiceId);
    console.log('[voice] synthesizing speech, text length:', text.length);

    const response = await fetch(url, {
        method: 'POST',
        headers,
        body: ttsRequestBody(text, opts?.modelId),
    });

    if (!response.ok) {
        const errText = await response.text().catch(() => 'Unknown error');
        console.error('[voice] TTS API error:', response.status, errText);
        throw new Error(`TTS API error ${response.status}: ${errText}`);
    }

    const arrayBuffer = await response.arrayBuffer();
    const audioBase64 = Buffer.from(arrayBuffer).toString('base64');
    console.log('[voice] synthesized audio, base64 length:', audioBase64.length);
    return { audioBase64, mimeType: 'audio/mpeg' };
}

/**
 * Streaming synthesis: invokes `onChunk` with MP3 bytes as they arrive so
 * playback can start on the first chunk. Resolves when the stream ends;
 * rejects on HTTP/stream errors. Abort via the provided signal.
 */
export async function synthesizeSpeechStream(
    text: string,
    onChunk: (chunk: Buffer) => void,
    signal?: AbortSignal,
): Promise<void> {
    const { url, headers } = await resolveTtsEndpoint(true);
    console.log('[voice] streaming speech synthesis, text length:', text.length);

    const response = await fetch(url, {
        method: 'POST',
        headers,
        body: ttsRequestBody(text),
        signal: signal ?? null,
    });

    if (!response.ok) {
        const errText = await response.text().catch(() => 'Unknown error');
        console.error('[voice] TTS stream API error:', response.status, errText);
        throw new Error(`TTS API error ${response.status}: ${errText}`);
    }
    if (!response.body) {
        throw new Error('TTS API returned no body');
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

// ---------------------------------------------------------------------------
// Batch ASR — transcribe a complete audio buffer via a local Deepgram key.
const ASR_PARAMS = new URLSearchParams({
    model: 'nova-3',
    smart_format: 'true',
    punctuate: 'true',
    language: 'en',
});

export async function transcribeAudio(audio: Buffer, opts?: { mimeType?: string }): Promise<{ transcript: string }> {
    if (audio.length === 0) throw new Error('audio buffer is empty');
    console.log('[voice] transcribing audio, bytes:', audio.length);

    const config = await getVoiceConfig();
    if (!config.deepgram) {
        throw new Error(`Deepgram not configured. Create ${path.join(WorkDir, 'config', 'deepgram.json')} with { "apiKey": "<your-key>" }`);
    }

    // Local key: Deepgram's pre-recorded REST API (most robust for files).
    const response = await fetch(`https://api.deepgram.com/v1/listen?${ASR_PARAMS.toString()}`, {
        method: 'POST',
        headers: {
            'Authorization': `Token ${config.deepgram.apiKey}`,
            'Content-Type': opts?.mimeType || 'application/octet-stream',
        },
        body: new Uint8Array(audio),
    });
    if (!response.ok) {
        const errText = await response.text().catch(() => 'Unknown error');
        throw new Error(`ASR API error ${response.status}: ${errText}`);
    }
    const result = await response.json() as {
        results?: { channels?: Array<{ alternatives?: Array<{ transcript?: string }> }> };
    };
    const transcript = result.results?.channels?.[0]?.alternatives?.[0]?.transcript ?? '';
    return { transcript: transcript.trim() };
}

