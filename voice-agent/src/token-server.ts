import { config } from "dotenv";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { DEFAULT_TOKEN_SERVER_PORT } from "./constants.js";
import { parseLanguageCode } from "./language.js";
import { mintAccessToken, readLiveKitCredentials } from "./token.js";

config();

export interface TokenRequestBody {
  room_name?: string;
  participant_identity?: string;
  participant_name?: string;
  participant_metadata?: string;
  participant_attributes?: Record<string, string>;
  language?: string;
}

export function parseTokenRequest(
  body: TokenRequestBody,
  query: URLSearchParams,
): {
  roomName: string;
  identity: string;
  name?: string;
  language?: string;
  metadata?: string;
  attributes?: Record<string, string>;
} {
  const roomName =
    body.room_name ?? query.get("room_name") ?? query.get("room") ?? `dialy-${Date.now()}`;
  const identity =
    body.participant_identity ??
    query.get("participant_identity") ??
    query.get("identity") ??
    `user-${Date.now()}`;
  const language =
    body.language ??
    body.participant_attributes?.language ??
    query.get("language") ??
    undefined;

  return {
    roomName,
    identity,
    name: body.participant_name ?? query.get("participant_name") ?? undefined,
    language: parseLanguageCode(language) ?? language,
    metadata: body.participant_metadata,
    attributes: body.participant_attributes,
  };
}

async function readJsonBody(req: IncomingMessage): Promise<TokenRequestBody> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }
  if (chunks.length === 0) return {};
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (!raw) return {};
  const parsed: unknown = JSON.parse(raw);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("JSON body must be an object");
  }
  return parsed as TokenRequestBody;
}

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Access-Control-Allow-Origin": process.env.TOKEN_CORS_ORIGIN ?? "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
  });
  res.end(body);
}

export function createTokenServer(): ReturnType<typeof createServer> {
  return createServer(async (req, res) => {
    try {
      const host = req.headers.host ?? "localhost";
      const url = new URL(req.url ?? "/", `http://${host}`);

      if (req.method === "OPTIONS") {
        res.writeHead(204, {
          "Access-Control-Allow-Origin": process.env.TOKEN_CORS_ORIGIN ?? "*",
          "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type, Authorization",
        });
        res.end();
        return;
      }

      if (req.method === "GET" && url.pathname === "/health") {
        sendJson(res, 200, { ok: true });
        return;
      }

      if (
        (req.method === "POST" || req.method === "GET") &&
        (url.pathname === "/token" || url.pathname === "/getToken")
      ) {
        const body = req.method === "POST" ? await readJsonBody(req) : {};
        const parsed = parseTokenRequest(body, url.searchParams);
        const minted = await mintAccessToken(parsed, readLiveKitCredentials());
        sendJson(res, 201, {
          server_url: minted.serverUrl,
          participant_token: minted.token,
          room_name: minted.roomName,
          language: minted.language,
        });
        return;
      }

      sendJson(res, 404, { error: "not found" });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const status = message.includes("required") ? 500 : 400;
      sendJson(res, status, { error: message });
    }
  });
}

function isExecutedDirectly(): boolean {
  const argvPath = process.argv[1];
  if (!argvPath) return false;
  return resolve(argvPath) === fileURLToPath(import.meta.url);
}

if (isExecutedDirectly()) {
  const port = Number(process.env.TOKEN_SERVER_PORT ?? DEFAULT_TOKEN_SERVER_PORT);
  const host = process.env.TOKEN_SERVER_HOST ?? "127.0.0.1";
  const server = createTokenServer();
  server.listen(port, host, () => {
    console.log(`Dialy voice token server listening on http://${host}:${port}/token`);
  });
}
