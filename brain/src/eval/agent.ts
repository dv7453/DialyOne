import type { AgentAdapter, EvalTask } from "./types.js";

export type ScriptedVariant = "good" | "bad";

export function scriptedAgent(variant: ScriptedVariant): AgentAdapter {
  return {
    id: `scripted:${variant}`,
    complete: async (task: EvalTask) => {
      const text = task.replies[variant];
      const latencyMs = 8 + Math.min(40, Math.floor(text.length / 12));
      return { text, latencyMs };
    },
  };
}

export function throwingAgent(message = "agent exploded"): AgentAdapter {
  return {
    id: "scripted:throw",
    complete: async () => {
      throw new Error(message);
    },
  };
}

export function emptyAgent(): AgentAdapter {
  return {
    id: "scripted:empty",
    complete: async () => ({ text: "", latencyMs: 1 }),
  };
}

export function slowAgent(latencyMs: number, inner: AgentAdapter): AgentAdapter {
  return {
    id: `${inner.id}:slow`,
    complete: async (task) => {
      const reply = await inner.complete(task);
      return { ...reply, latencyMs };
    },
  };
}

/**
 * Optional live Dialy host. Off by default — needs a running brain and is
 * not used in unit tests (no paid models, no network).
 */
export function liveHostAgent(opts: {
  baseUrl: string;
  token?: string;
  fetchImpl?: typeof fetch;
}): AgentAdapter {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const baseUrl = opts.baseUrl.replace(/\/+$/, "");
  return {
    id: `live:${baseUrl}`,
    complete: async (task) => {
      const started = Date.now();
      const message = task.context ? `${task.user}\n\nContext:\n${task.context}` : task.user;
      const response = await fetchImpl(`${baseUrl}/v1/chat`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(opts.token ? { Authorization: `Bearer ${opts.token}` } : {}),
        },
        body: JSON.stringify({ message }),
      });
      const latencyMs = Date.now() - started;
      const body = (await response.json().catch(() => null)) as {
        text?: string | null;
        error?: string;
        status?: string;
      } | null;
      if (!response.ok) {
        return {
          text: "",
          latencyMs,
          error: body?.error || `live chat HTTP ${response.status}`,
        };
      }
      return { text: typeof body?.text === "string" ? body.text : "", latencyMs };
    },
  };
}
