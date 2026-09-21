/** Explicit-dispatch name. Must match the name minted into join tokens. */
export const AGENT_NAME = "dialy-voice";

/**
 * Milliseconds to wait for in-flight voice jobs on SIGINT/SIGTERM.
 * `start` drains jobs; a phone call may still be speaking when the process is asked to exit.
 */
export const DRAIN_TIMEOUT_MS = 300_000;

export const DEFAULT_TOKEN_TTL = "10m";
export const DEFAULT_TOKEN_SERVER_PORT = 7890;
