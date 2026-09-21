import type { CallLanguage } from "./call-language";
import type { WebSettings } from "./settings";

export type VoiceToken = {
  serverUrl: string;
  participantToken: string;
  roomName: string;
  language: string;
};

export type VoiceTokenRequest = {
  roomName: string;
  identity: string;
  language: CallLanguage;
  sessionId?: string | null;
};

export type VoiceTokenErrorCode = "unreachable" | "missing" | "rejected" | "invalid";

export class VoiceTokenError extends Error {
  readonly code: VoiceTokenErrorCode;
  readonly status?: number;

  constructor(code: VoiceTokenErrorCode, status?: number) {
    super(code);
    this.name = "VoiceTokenError";
    this.code = code;
    this.status = status;
  }
}

type JsonObject = Record<string, unknown>;

function asObject(body: unknown): JsonObject {
  if (body && typeof body === "object" && !Array.isArray(body)) {
    return body as JsonObject;
  }
  return {};
}

function readString(obj: JsonObject, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = obj[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

export function parseVoiceToken(body: unknown): VoiceToken {
  const obj = asObject(body);
  const serverUrl = readString(obj, "server_url", "serverUrl");
  const participantToken = readString(obj, "participant_token", "participantToken", "token");
  const roomName = readString(obj, "room_name", "roomName") ?? "";
  const language = readString(obj, "language") ?? "";
  if (!serverUrl || !participantToken) {
    throw new VoiceTokenError("invalid");
  }
  return { serverUrl, participantToken, roomName, language };
}

function authHeaders(settings: WebSettings): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: "application/json",
    "Content-Type": "application/json",
  };
  if (settings.brainToken.trim()) {
    headers.Authorization = `Bearer ${settings.brainToken.trim()}`;
  }
  return headers;
}

function tokenPayload(input: VoiceTokenRequest): JsonObject {
  return {
    room_name: input.roomName,
    participant_identity: input.identity,
    language: input.language,
    sessionId: input.sessionId || undefined,
    participant_attributes: input.sessionId
      ? { sessionId: input.sessionId, language: input.language }
      : { language: input.language },
  };
}

async function postVoiceToken(url: string, headers: Record<string, string>, input: VoiceTokenRequest): Promise<VoiceToken> {
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      credentials: "include",
      headers,
      body: JSON.stringify(tokenPayload(input)),
    });
  } catch {
    throw new VoiceTokenError("unreachable");
  }

  const text = await res.text();
  let body: unknown = {};
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = { raw: text };
    }
  }

  if (res.status === 404 || res.status === 405) {
    throw new VoiceTokenError("missing", res.status);
  }
  if (!res.ok) {
    throw new VoiceTokenError(res.status >= 500 ? "unreachable" : "rejected", res.status);
  }
  return parseVoiceToken(body);
}

function shouldFallbackToDevServer(error: unknown): boolean {
  if (!(error instanceof VoiceTokenError)) return true;
  return error.code === "missing" || error.code === "unreachable";
}

export async function fetchVoiceToken(
  settings: WebSettings,
  input: VoiceTokenRequest,
): Promise<VoiceToken> {
  try {
    return await postVoiceToken(
      `${settings.brainUrl}/v1/voice/token`,
      authHeaders(settings),
      input,
    );
  } catch (error) {
    if (!shouldFallbackToDevServer(error) || !settings.voiceTokenUrl) {
      throw error;
    }
    return await postVoiceToken(
      `${settings.voiceTokenUrl.replace(/\/+$/, "")}/token`,
      { Accept: "application/json", "Content-Type": "application/json" },
      input,
    );
  }
}
