/**
 * Minimal loopback HTTP stub (no agent boot). Prefer `npm run start` for Spike A.
 * Kept for quick liveness without loading the full host.
 */
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const HOST = process.env.BRAIN_HOST ?? '127.0.0.1';
const PORT = Number(process.env.BRAIN_PORT ?? 8787);
const CONFIG_DIR = path.join(os.homedir(), '.rowboat', 'config');

const PLANNED = {
    'GET /health': 'liveness (stub — no schedulers)',
    'GET /v1/status': 'which local config files exist (never secrets)',
    'POST /v1/chat': 'not implemented — use npm run start + Spike B',
    'GET /v1/graph': 'not implemented — knowledge graph (src/knowledge)',
    'GET /v1/connections': 'not implemented — Gmail OAuth + Composio',
    'WS /v1/turns': 'not implemented — streaming agent events',
} as const;

function configPresent(filename: string): boolean {
    return fs.existsSync(path.join(CONFIG_DIR, filename));
}

function authorized(req: http.IncomingMessage): boolean {
    const token = process.env.BRAIN_TOKEN;
    if (!token) return true;
    const header = req.headers.authorization;
    if (typeof header === 'string' && header === `Bearer ${token}`) return true;
    const alt = req.headers['x-brain-token'];
    if (typeof alt === 'string' && alt === token) return true;
    return false;
}

function json(res: http.ServerResponse, status: number, body: unknown): void {
    const payload = JSON.stringify(body, null, 2);
    res.writeHead(status, {
        'content-type': 'application/json; charset=utf-8',
        'access-control-allow-origin': '*',
        'access-control-allow-methods': 'GET, OPTIONS',
        'access-control-allow-headers': 'content-type, authorization, x-brain-token',
    });
    res.end(payload);
}

function notImplemented(res: http.ServerResponse, route: string): void {
    json(res, 501, {
        error: 'not_implemented',
        route,
        hint: 'Use `npm run start` (src/host) for the headless Dialy host. Stub has no turn runtime.',
    });
}

const startedAt = Date.now();

const server = http.createServer((req, res) => {
    const method = req.method ?? 'GET';
    const url = new URL(req.url ?? '/', `http://${HOST}:${PORT}`);

    if (method === 'OPTIONS') {
        res.writeHead(204, {
            'access-control-allow-origin': '*',
            'access-control-allow-methods': 'GET, OPTIONS',
            'access-control-allow-headers': 'content-type, authorization, x-brain-token',
        });
        res.end();
        return;
    }

    if (!authorized(req)) {
        json(res, 401, { error: 'unauthorized' });
        return;
    }

    if (method === 'GET' && (url.pathname === '/' || url.pathname === '/health')) {
        json(res, 200, {
            service: 'brain',
            package: '@x/core',
            mode: 'stub',
            status: 'ok',
            uptimeSec: Math.floor((Date.now() - startedAt) / 1000),
            hint: 'Full host: npm run start (BRAIN_HOST=0.0.0.0 for phone)',
            routes: PLANNED,
        });
        return;
    }

    if (method === 'GET' && url.pathname === '/v1/status') {
        json(res, 200, {
            mode: 'stub',
            configDir: CONFIG_DIR,
            present: {
                models: configPresent('models.json'),
                composio: configPresent('composio.json'),
                elevenlabs: configPresent('elevenlabs.json'),
                sarvam: configPresent('sarvam.json'),
                deepgram: configPresent('deepgram.json'),
                exaSearch: configPresent('exa-search.json'),
            },
        });
        return;
    }

    if (url.pathname === '/v1/chat' || url.pathname === '/v1/graph' || url.pathname === '/v1/connections') {
        notImplemented(res, `${method} ${url.pathname}`);
        return;
    }

    json(res, 404, { error: 'not_found', path: url.pathname, routes: PLANNED });
});

server.listen(PORT, HOST, () => {
    console.log(`brain api stub listening on http://${HOST}:${PORT} (use npm run start for headless host)`);
});
