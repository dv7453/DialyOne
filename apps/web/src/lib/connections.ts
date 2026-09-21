import type { AdapterFlags } from "../types";

export type ConnectorKey = "mail" | "calendar" | "github" | "render" | "telegram";

export type NeededConnection = {
  connector: ConnectorKey;
  capability?: string;
  source: "first_run" | "action";
};

export const CONNECTORS: readonly {
  key: ConnectorKey;
  flag: keyof AdapterFlags;
  icon: string;
  settingsKey: string;
}[] = [
  { key: "mail", flag: "mail", icon: "mail", settingsKey: "settings.connectors.mail" },
  { key: "calendar", flag: "calendar", icon: "calendar_today", settingsKey: "settings.connectors.calendar" },
  { key: "github", flag: "github", icon: "code", settingsKey: "settings.connectors.github" },
  { key: "render", flag: "render", icon: "cloud", settingsKey: "settings.connectors.render" },
  { key: "telegram", flag: "telegram", icon: "send", settingsKey: "settings.connectors.telegram" },
] as const;

const CAPABILITY_CONNECTOR: ReadonlyArray<readonly [string, ConnectorKey]> = [
  ["mail.", "mail"],
  ["calendar.", "calendar"],
  ["code.", "github"],
  ["deploy.", "render"],
  ["notify.", "telegram"],
];

const ADAPTER_CONNECTOR: Record<string, ConnectorKey> = {
  "mail-agentmail": "mail",
  mail: "mail",
  calendar: "calendar",
  "code-github": "github",
  github: "github",
  "deploy-render": "render",
  render: "render",
  notify: "telegram",
  telegram: "telegram",
};

export function connectorForCapability(capability: string): ConnectorKey | null {
  for (const [prefix, key] of CAPABILITY_CONNECTOR) {
    if (capability.startsWith(prefix)) return key;
  }
  return null;
}

export function connectorForAdapter(adapterId: string): ConnectorKey | null {
  return ADAPTER_CONNECTOR[adapterId] ?? null;
}

export function isConnectorLive(flags: AdapterFlags | null, key: ConnectorKey): boolean {
  if (!flags) return false;
  const meta = CONNECTORS.find((item) => item.key === key);
  return meta ? Boolean(flags[meta.flag]) : false;
}

/**
 * Brain executor copy when an adapter is missing or unarmed. Keep in lockstep
 * with `CapabilityRegistry.execute` in the brain.
 */
export function parseUnavailableConnection(message: string): {
  connector: ConnectorKey;
  capability?: string;
} | null {
  const unavailable = message.match(
    /Adapter ([^\s]+) is unavailable for capability ([^\s.]+)/i,
  );
  if (unavailable) {
    const adapterId = unavailable[1] ?? "";
    const capability = unavailable[2];
    const fromAdapter = connectorForAdapter(adapterId);
    const fromCap = capability ? connectorForCapability(capability) : null;
    const connector = fromAdapter ?? fromCap;
    if (connector) return { connector, capability };
  }
  const missing = message.match(/No adapter registered for capability ([^\s.]+)/i);
  if (missing?.[1]) {
    const connector = connectorForCapability(missing[1]);
    if (connector) return { connector, capability: missing[1] };
  }
  return null;
}
