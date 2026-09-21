export type CapabilityResult = {
  ok: boolean;
  capability: string;
  data?: unknown;
  error?: string;
  unavailable?: boolean;
};

export type CapabilityContext = {
  signalId?: string;
  playbookId?: string;
};

export interface CapabilityAdapter {
  id: string;
  capabilities: string[];
  isAvailable(): Promise<boolean>;
  execute(capability: string, args: Record<string, unknown>, ctx: CapabilityContext): Promise<CapabilityResult>;
}
