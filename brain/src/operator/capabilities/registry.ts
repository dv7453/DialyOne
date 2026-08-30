import type { CapabilityAdapter, CapabilityContext, CapabilityResult } from "./types.js";

export class CapabilityRegistry {
  private readonly adaptersByCapability = new Map<string, CapabilityAdapter>();

  register(adapter: CapabilityAdapter): this {
    for (const capability of adapter.capabilities) {
      this.adaptersByCapability.set(capability, adapter);
    }

    return this;
  }

  has(capability: string): boolean {
    return this.adaptersByCapability.has(capability);
  }

  getAdapter(capability: string): CapabilityAdapter | undefined {
    return this.adaptersByCapability.get(capability);
  }

  async execute(
    capability: string,
    args: Record<string, unknown> = {},
    ctx: CapabilityContext = {},
  ): Promise<CapabilityResult> {
    const adapter = this.getAdapter(capability);
    if (!adapter) {
      return {
        ok: false,
        capability,
        unavailable: true,
        error: `No adapter registered for capability ${capability}.`,
      };
    }

    if (!(await adapter.isAvailable())) {
      return {
        ok: false,
        capability,
        unavailable: true,
        error: `Adapter ${adapter.id} is unavailable for capability ${capability}.`,
      };
    }

    return adapter.execute(capability, args, ctx);
  }

  async listAvailable(): Promise<string[]> {
    const available: string[] = [];
    const seenAdapters = new Map<CapabilityAdapter, Promise<boolean>>();

    for (const [capability, adapter] of this.adaptersByCapability.entries()) {
      let availability = seenAdapters.get(adapter);
      if (!availability) {
        availability = adapter.isAvailable();
        seenAdapters.set(adapter, availability);
      }

      if (await availability) {
        available.push(capability);
      }
    }

    return available;
  }
}
