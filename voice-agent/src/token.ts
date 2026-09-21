import {
  AccessToken,
  RoomAgentDispatch,
  RoomConfiguration,
  TokenVerifier,
  type VideoGrant,
} from "livekit-server-sdk";
import { AGENT_NAME, DEFAULT_TOKEN_TTL } from "./constants.js";
import {
  DEFAULT_LANGUAGE,
  parseLanguageCode,
  type SessionLanguage,
} from "./language.js";

export interface MintAccessTokenInput {
  roomName: string;
  identity: string;
  name?: string;
  /** BCP-47 (`gu-IN` / `hi-IN` / `en-IN`). Written to participant attributes. */
  language?: string;
  ttl?: number | string;
  metadata?: string;
  attributes?: Record<string, string>;
  /** When true (default), the join token dispatches `dialy-voice` into the room. */
  dispatchAgent?: boolean;
}

export interface LiveKitCredentials {
  apiKey: string;
  apiSecret: string;
  serverUrl: string;
}

export interface MintAccessTokenResult {
  token: string;
  serverUrl: string;
  roomName: string;
  identity: string;
  language: SessionLanguage;
}

export function readLiveKitCredentials(
  env: NodeJS.ProcessEnv = process.env,
): LiveKitCredentials {
  const apiKey = env.LIVEKIT_API_KEY;
  const apiSecret = env.LIVEKIT_API_SECRET;
  const serverUrl = env.LIVEKIT_URL;
  if (!apiKey || !apiSecret || !serverUrl) {
    throw new Error(
      "LIVEKIT_URL, LIVEKIT_API_KEY, and LIVEKIT_API_SECRET are required to mint tokens",
    );
  }
  return { apiKey, apiSecret, serverUrl };
}

export async function mintAccessToken(
  input: MintAccessTokenInput,
  creds: LiveKitCredentials,
): Promise<MintAccessTokenResult> {
  const language = parseLanguageCode(input.language) ?? DEFAULT_LANGUAGE;
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
    ttl: input.ttl ?? DEFAULT_TOKEN_TTL,
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
          agentName: AGENT_NAME,
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

export async function verifyAccessToken(
  token: string,
  creds: Pick<LiveKitCredentials, "apiKey" | "apiSecret">,
) {
  const verifier = new TokenVerifier(creds.apiKey, creds.apiSecret);
  return verifier.verify(token);
}
