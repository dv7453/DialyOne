import type { BudgetConfig } from "./types.js";

export type BudgetExceeded = {
  exceeded: boolean;
  action?: NonNullable<BudgetConfig["on_exceed"]>;
};

export class BudgetTracker {
  private modelCalls = 0;
  private toolRounds = 0;

  constructor(private readonly config: BudgetConfig = {}) {}

  recordModelCall(): BudgetExceeded {
    this.modelCalls += 1;
    return this.checkExceeded();
  }

  recordToolRound(): BudgetExceeded {
    this.toolRounds += 1;
    return this.checkExceeded();
  }

  checkExceeded(): BudgetExceeded {
    const modelExceeded = this.config.max_model_calls !== undefined && this.modelCalls > this.config.max_model_calls;
    const toolExceeded = this.config.max_tool_rounds !== undefined && this.toolRounds > this.config.max_tool_rounds;

    if (!modelExceeded && !toolExceeded) {
      return { exceeded: false };
    }

    return { exceeded: true, action: this.config.on_exceed ?? "escalate" };
  }
}
