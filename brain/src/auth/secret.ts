import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

export const SECRET_BYTES = 32;

export function generateSecret(): string {
    return randomBytes(SECRET_BYTES).toString("base64url");
}

export function hashSecret(token: string): string {
    return createHash("sha256").update(token, "utf8").digest("hex");
}

export function safeEqual(left: string, right: string): boolean {
    const a = Buffer.from(left, "utf8");
    const b = Buffer.from(right, "utf8");
    if (a.length !== b.length) {
        return false;
    }
    return timingSafeEqual(a, b);
}
