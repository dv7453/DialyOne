import {
    AccessToken,
    RoomAgentDispatch,
    RoomConfiguration,
    TokenVerifier,
    type VideoGrant,
} from "livekit-server-sdk";

/** Must match the voice-agent worker's AGENT_NAME or the agent never joins. */
export const VOICE_AGENT_NAME = "dialy-voice";
export const DEFAULT_VOICE_TOKEN_TTL = "10m";
export const DEFAULT_CALL_LANGUAGE = "gu-IN";

export const SUPPORTED_CALL_LANGUAGES = ["gu-IN", "hi-IN", "en-IN"] as const;
export type CallLanguage = (typeof SUPPORTED_CALL_LANGUAGES)[number];

const LANGUAGE_ALIASES: Record<string, CallLanguage> = {
    gu: "gu-IN",
    "gu-in": "gu-IN",
    gujarati: "gu-IN",
    hi: "hi-IN",
    "hi-in": "hi-IN",
    hindi: "hi-IN",
    en: "en-IN",
    "en-in": "en-IN",
    "en-us": "en-IN",
    "en-gb": "en-IN",
    english: "en-IN",
};

export type LiveKitCredentials = {
    apiKey: string;
    apiSecret: string;
    serverUrl: string;
};

export type MintVoiceTokenInput = {
    roomName: string;
    identity: string;
    name?: string;
    language?: string;
    ttl?: number | string;
    metadata?: string;
    attributes?: Record<string, string>;
    dispatchAgent?: boolean;
};

export type MintVoiceTokenResult = {
    token: string;
    serverUrl: string;
    roomName: string;
    identity: string;
    language: CallLanguage;
};

export class VoiceTokenConfigError extends Error {
    constructor(message = "LIVEKIT_URL, LIVEKIT_API_KEY, and LIVEKIT_API_SECRET are required to mint tokens") {
        super(message);
        this.name = "VoiceTokenConfigError";
    }
}

export function parseCallLanguage(raw: string | undefined | null): CallLanguage | undefined {
    if (raw == null) {
        return undefined;
    }
    const key = raw.trim().toLowerCase();
    if (!key) {
        return undefined;
    }
    for (const lang of SUPPORTED_CALL_LANGUAGES) {
        if (lang.toLowerCase() === key) {
            return lang;
        }
    }
    return LANGUAGE_ALIASES[key];
}

export function readLiveKitCredentials(env: NodeJS.ProcessEnv = process.env): LiveKitCredentials {
    const apiKey = env.LIVEKIT_API_KEY;
    const apiSecret = env.LIVEKIT_API_SECRET;
    const serverUrl = env.LIVEKIT_URL;
    if (!apiKey || !apiSecret || !serverUrl) {
        throw new VoiceTokenConfigError();
    }
    return { apiKey, apiSecret, serverUrl };
}

export async function mintVoiceAccessToken(
    input: MintVoiceTokenInput,
    creds: LiveKitCredentials,
): Promise<MintVoiceTokenResult> {
    const language = parseCallLanguage(input.language) ?? DEFAULT_CALL_LANGUAGE;
    const attributes: Record<string, string> = {
        ...input.attributes,
        language,
        "user.language": language,
    };

    const at = new AccessToken(creds.apiKey, creds.apiSecret, {
        identity: input.identity,
        name: input.name ?? input.identity,
        metadata: input.metadata ?? JSON.stringify({ language }),
        attributes,
        ttl: input.ttl ?? DEFAULT_VOICE_TOKEN_TTL,
    });

    const grant: VideoGrant = {
        room: input.roomName,
        roomJoin: true,
        canPublish: true,
        canSubscribe: true,
        canPublishData: true,
        canUpdateOwnMetadata: true,
    };
    at.addGrant(grant);

    if (input.dispatchAgent !== false) {
        at.roomConfig = new RoomConfiguration({
            metadata: JSON.stringify({ language }),
            agents: [
                new RoomAgentDispatch({
                    agentName: VOICE_AGENT_NAME,
                    metadata: JSON.stringify({ language }),
                }),
            ],
        });
    }

    return {
        token: await at.toJwt(),
        serverUrl: creds.serverUrl,
        roomName: input.roomName,
        identity: input.identity,
        language,
    };
}

export async function verifyVoiceAccessToken(
    token: string,
    creds: Pick<LiveKitCredentials, "apiKey" | "apiSecret">,
) {
    const verifier = new TokenVerifier(creds.apiKey, creds.apiSecret);
    return verifier.verify(token);
}

export type VoiceTokenRequestBody = {
    roomName: string;
    identity: string;
    name?: string;
    language?: string;
    metadata?: string;
    attributes?: Record<string, string>;
};

export function parseVoiceTokenRequest(body: unknown): VoiceTokenRequestBody | { error: string } {
    const record = body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
    const roomName = typeof record.room_name === "string" ? record.room_name.trim() : "";
    const identity = typeof record.participant_identity === "string" ? record.participant_identity.trim() : "";
    if (!roomName || !identity) {
        return { error: "Body must include room_name and participant_identity." };
    }

    const language =
        (typeof record.language === "string" ? record.language : undefined) ??
        stringAttribute(record.participant_attributes, "language");
    const attributes = stringAttributes(record.participant_attributes);
    const sessionId = typeof record.sessionId === "string" && record.sessionId.trim() ? record.sessionId.trim() : undefined;
    if (sessionId) {
        attributes.sessionId = sessionId;
    }

    return {
        roomName,
        identity,
        name: typeof record.participant_name === "string" ? record.participant_name : undefined,
        language,
        metadata: typeof record.participant_metadata === "string" ? record.participant_metadata : undefined,
        attributes,
    };
}

function stringAttribute(value: unknown, key: string): string | undefined {
    const attrs = stringAttributes(value);
    return attrs[key];
}

function stringAttributes(value: unknown): Record<string, string> {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        return {};
    }
    const out: Record<string, string> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
        if (typeof item === "string") {
            out[key] = item;
        }
    }
    return out;
}
