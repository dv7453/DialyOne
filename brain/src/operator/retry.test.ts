import { describe, expect, it } from "vitest";

import { classifyFailure, retryDelayMs, RETRY_BASE_MS, RETRY_MAX_DELAY_MS } from "./retry.js";
import type { CapabilityResult } from "./capabilities/types.js";

function failed(error: string, extra: Partial<CapabilityResult> = {}): CapabilityResult {
  return { ok: false, capability: "deploy.restart", error, ...extra };
}

function errno(code: string, message = code): NodeJS.ErrnoException {
  const error = new Error(message) as NodeJS.ErrnoException;
  error.code = code;
  return error;
}

describe("classifyFailure", () => {
  it.each([
    ["ECONNRESET in message", failed("read ECONNRESET"), "retryable"],
    ["ETIMEDOUT in message", failed("connect ETIMEDOUT 1.2.3.4:443"), "retryable"],
    ["ENOTFOUND in message", failed("getaddrinfo ENOTFOUND api.example.com"), "retryable"],
    ["socket hang up", failed("socket hang up"), "retryable"],
    ["HTTP 408", failed("HTTP 408 Request Timeout"), "retryable"],
    ["HTTP 429", failed("HTTP 429 Too Many Requests"), "retryable"],
    ["HTTP 500", failed("HTTP 500 Internal Server Error"), "retryable"],
    ["HTTP 502", failed("HTTP/1.1 502 Bad Gateway"), "retryable"],
    ["HTTP 503", failed("HTTP 503 Service Unavailable"), "retryable"],
    ["HTTP 504", failed("status: 504"), "retryable"],
    ["axios status code 503", failed("Request failed with status code 503"), "retryable"],
    ["bare 429", failed("429"), "retryable"],
    ["rate limit phrase", failed("Rate limit exceeded, slow down"), "retryable"],
    ["too many requests", failed("too many requests from this client"), "retryable"],
    ["JSON statusCode 500", failed('{"statusCode": 500, "error": "boom"}'), "retryable"],
  ] as const)("%s is retryable", (_name, input, expected) => {
    expect(classifyFailure(input)).toBe(expected);
  });

  it.each([
    ["HTTP 400", failed("HTTP 400 Bad Request"), "terminal"],
    ["HTTP 401", failed("HTTP 401 Unauthorized"), "terminal"],
    ["HTTP 403", failed("403 Forbidden"), "terminal"],
    ["HTTP 404", failed("status 404 Not Found"), "terminal"],
    ["HTTP 409", failed("HTTP 409 Conflict"), "terminal"],
    ["HTTP 422", failed("statusCode: 422 Unprocessable"), "terminal"],
    ["validation error", failed("args.service is required"), "terminal"],
    ["unclassifiable", failed("something went sideways"), "terminal"],
    ["empty error", failed(""), "terminal"],
    ["unavailable without a retry signal", failed("Adapter render is unavailable for capability deploy.restart.", { unavailable: true }), "terminal"],
    ["missing adapter", failed("No adapter registered for capability deploy.restart.", { unavailable: true }), "terminal"],
  ] as const)("%s is terminal", (_name, input, expected) => {
    expect(classifyFailure(input)).toBe(expected);
  });

  it("classifies Node errno exceptions as retryable", () => {
    expect(classifyFailure(errno("ECONNRESET", "read ECONNRESET"))).toBe("retryable");
    expect(classifyFailure(errno("ETIMEDOUT"))).toBe("retryable");
    expect(classifyFailure(errno("ENOTFOUND", "getaddrinfo ENOTFOUND host"))).toBe("retryable");
  });

  it("classifies thrown fetch failures and nested causes", () => {
    expect(classifyFailure(new TypeError("fetch failed"))).toBe("retryable");
    const nested = new Error("request aborted");
    (nested as NodeJS.ErrnoException).code = "ECONNRESET";
    const outer = new Error("fetch failed");
    (outer as Error & { cause: Error }).cause = nested;
    expect(classifyFailure(outer)).toBe("retryable");
  });

  it("reads numeric status fields on thrown objects", () => {
    expect(classifyFailure({ status: 503, message: "upstream down" })).toBe("retryable");
    expect(classifyFailure({ statusCode: 429 })).toBe("retryable");
    expect(classifyFailure({ response: { status: 401 }, message: "nope" })).toBe("terminal");
    expect(classifyFailure({ response: { status: 408 } })).toBe("retryable");
  });

  it("does not treat port numbers as HTTP 4xx", () => {
    expect(classifyFailure(failed("connect to 10.0.0.1:443 failed: policy denied"))).toBe("terminal");
  });

  it("defaults a successful CapabilityResult to terminal because there is nothing to retry", () => {
    expect(classifyFailure({ ok: true, capability: "deploy.restart" })).toBe("terminal");
  });
});

describe("retryDelayMs", () => {
  it("grows exponentially from a 1s base", () => {
    const none = () => 0;
    expect(retryDelayMs(1, none)).toBe(RETRY_BASE_MS);
    expect(retryDelayMs(2, none)).toBe(2_000);
    expect(retryDelayMs(3, none)).toBe(4_000);
    expect(retryDelayMs(4, none)).toBe(8_000);
    expect(retryDelayMs(1, none)).toBeLessThan(retryDelayMs(2, none));
    expect(retryDelayMs(2, none)).toBeLessThan(retryDelayMs(3, none));
  });

  it("caps the exponential wait at 60s", () => {
    const none = () => 0;
    expect(retryDelayMs(7, none)).toBe(RETRY_MAX_DELAY_MS);
    expect(retryDelayMs(20, none)).toBe(RETRY_MAX_DELAY_MS);
  });

  it("adds up to 20% jitter on top of the capped delay", () => {
    expect(retryDelayMs(1, () => 1)).toBe(1_200);
    expect(retryDelayMs(7, () => 1)).toBe(72_000);
    const sampled = Array.from({ length: 20 }, () => retryDelayMs(1));
    expect(sampled.every((ms) => ms >= 1_000 && ms <= 1_200)).toBe(true);
  });

  it("treats non-positive attempts as the first retry", () => {
    expect(retryDelayMs(0, () => 0)).toBe(RETRY_BASE_MS);
    expect(retryDelayMs(-3, () => 0)).toBe(RETRY_BASE_MS);
  });
});
