export const SESSION_COOKIE_NAME = "dialy_session";

export type CookieOptions = {
    httpOnly?: boolean;
    sameSite?: "lax" | "strict" | "none";
    secure?: boolean;
    path?: string;
    maxAgeSec?: number;
};

export function parseCookies(header: string | string[] | undefined): Record<string, string> {
    const raw = Array.isArray(header) ? header.join("; ") : header;
    const out: Record<string, string> = {};
    if (!raw) {
        return out;
    }
    for (const part of raw.split(";")) {
        const idx = part.indexOf("=");
        if (idx <= 0) {
            continue;
        }
        const name = part.slice(0, idx).trim();
        const value = part.slice(idx + 1).trim();
        if (!name) {
            continue;
        }
        try {
            out[name] = decodeURIComponent(value);
        } catch {
            out[name] = value;
        }
    }
    return out;
}

export function serializeCookie(name: string, value: string, options: CookieOptions = {}): string {
    const parts = [`${name}=${encodeURIComponent(value)}`];
    parts.push(`Path=${options.path ?? "/"}`);
    if (options.maxAgeSec !== undefined) {
        parts.push(`Max-Age=${Math.max(0, Math.floor(options.maxAgeSec))}`);
    }
    const sameSite = options.sameSite ?? "lax";
    parts.push(`SameSite=${sameSite.charAt(0).toUpperCase()}${sameSite.slice(1)}`);
    if (options.secure) {
        parts.push("Secure");
    }
    if (options.httpOnly !== false) {
        parts.push("HttpOnly");
    }
    return parts.join("; ");
}

export function sessionCookieHeader(token: string, expiresAt: Date, secure: boolean): string {
    const maxAgeSec = Math.max(0, Math.floor((expiresAt.getTime() - Date.now()) / 1000));
    return serializeCookie(SESSION_COOKIE_NAME, token, {
        httpOnly: true,
        sameSite: "lax",
        secure,
        path: "/",
        maxAgeSec,
    });
}

export function clearSessionCookieHeader(secure: boolean): string {
    return serializeCookie(SESSION_COOKIE_NAME, "", {
        httpOnly: true,
        sameSite: "lax",
        secure,
        path: "/",
        maxAgeSec: 0,
    });
}

export function readBearerToken(authorization: string | string[] | undefined): string | undefined {
    const header = Array.isArray(authorization) ? authorization[0] : authorization;
    if (!header) {
        return undefined;
    }
    if (header.length < 7 || header.slice(0, 7).toLowerCase() !== "bearer ") {
        return undefined;
    }
    const token = header.slice(7).trim();
    return token || undefined;
}

export function headerValue(value: string | string[] | undefined): string | undefined {
    if (typeof value === "string") {
        return value;
    }
    if (Array.isArray(value) && typeof value[0] === "string") {
        return value[0];
    }
    return undefined;
}
