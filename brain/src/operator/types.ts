import { z } from "zod";

const UnknownRecordSchema = z.record(z.string(), z.unknown());

export const SignalSchema = z.object({
  id: z.string().min(1),
  source: z.string().min(1),
  type: z.string().min(1),
  createdAt: z.string().min(1),
  payload: UnknownRecordSchema,
  raw: z.unknown().optional(),
});

export const PolicyModeSchema = z.enum(["auto", "approve", "escalate", "log"]);
export const TriageClassSchema = z.string().min(1);

export const BudgetConfigSchema = z.object({
  max_model_calls: z.number().int().nonnegative().optional(),
  max_tool_rounds: z.number().int().nonnegative().optional(),
  on_exceed: z.enum(["escalate", "abort"]).optional(),
});

export const PolicyActionSchema = z.object({
  capability: z.string().min(1),
  mode: PolicyModeSchema,
  args: UnknownRecordSchema.optional(),
});

export const WebhookTriggerSchema = z.object({
  type: z.literal("webhook"),
  source: z.string().min(1),
  match: UnknownRecordSchema.optional(),
});

export const ProbeTriggerSchema = z.object({
  type: z.literal("probe"),
  every: z.string().min(1),
  capability: z.string().min(1),
});

export const CronTriggerSchema = z.object({
  type: z.literal("cron"),
  expression: z.string().min(1),
});

export const EventTriggerSchema = z.object({
  type: z.literal("event"),
  source: z.string().min(1).optional(),
  eventType: z.string().min(1).optional(),
});

export const TriggerSchema = z.discriminatedUnion("type", [
  WebhookTriggerSchema,
  ProbeTriggerSchema,
  CronTriggerSchema,
  EventTriggerSchema,
]);

export const ContextRequestSchema = z.object({
  capability: z.string().min(1),
  args: UnknownRecordSchema.optional(),
});

export const TriageRuleSchema = z.object({
  when: z.string().min(1),
  class: TriageClassSchema,
  reason: z.string().optional(),
});

export const TriageConfigSchema = z.object({
  rules: z.array(TriageRuleSchema).default([]),
  model: z.string().min(1).optional(),
  classes: z.array(TriageClassSchema).min(1),
  defaultClass: TriageClassSchema.optional(),
});

export const DigestConfigSchema = z.object({
  stack: z.array(TriageClassSchema).default([]),
  deliver: z.string().min(1).optional(),
});

export const PlaybookSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  enabled: z.boolean().default(true),
  triggers: z.array(TriggerSchema).default([]),
  context: z.array(ContextRequestSchema).default([]),
  triage: TriageConfigSchema,
  policy: z.record(TriageClassSchema, z.array(PolicyActionSchema)),
  digest: DigestConfigSchema.optional(),
  budget: BudgetConfigSchema.optional(),
});

export const TriageResultSchema = z.object({
  class: TriageClassSchema,
  reason: z.string().min(1),
  confidence: z.number().min(0).max(1).optional(),
  via: z.enum(["rule", "model", "default"]),
});

export const PolicyDecisionSchema = z.object({
  class: TriageClassSchema,
  actions: z.array(PolicyActionSchema),
  reason: z.string().min(1),
});

export const ActionRequestSchema = z.object({
  id: z.string().min(1),
  playbookId: z.string().min(1),
  capability: z.string().min(1),
  mode: PolicyModeSchema,
  args: UnknownRecordSchema.optional(),
  signalId: z.string().min(1),
  status: z.enum(["pending", "approved", "denied", "executed", "failed", "skipped"]),
});

export const JournalEntrySchema = z.object({
  ts: z.string().min(1),
  kind: z.enum([
    "signal",
    "decision",
    "action",
    "outcome",
    "escalate",
    "retry_scheduled",
    "dead_letter",
    "autonomy_used",
    "promotion_available",
    "autonomy_granted",
    "autonomy_revoked",
    "streak_reset",
    "expired",
  ]),
  playbookId: z.string().min(1).optional(),
  signalId: z.string().min(1).optional(),
  data: UnknownRecordSchema,
});

export type Signal = z.infer<typeof SignalSchema>;
export type PolicyMode = z.infer<typeof PolicyModeSchema>;
export type TriageClass = z.infer<typeof TriageClassSchema>;
export type BudgetConfig = z.infer<typeof BudgetConfigSchema>;
export type PolicyAction = z.infer<typeof PolicyActionSchema>;
export type WebhookTrigger = z.infer<typeof WebhookTriggerSchema>;
export type ProbeTrigger = z.infer<typeof ProbeTriggerSchema>;
export type CronTrigger = z.infer<typeof CronTriggerSchema>;
export type EventTrigger = z.infer<typeof EventTriggerSchema>;
export type Trigger = z.infer<typeof TriggerSchema>;
export type ContextRequest = z.infer<typeof ContextRequestSchema>;
export type TriageRule = z.infer<typeof TriageRuleSchema>;
export type TriageConfig = z.infer<typeof TriageConfigSchema>;
export type DigestConfig = z.infer<typeof DigestConfigSchema>;
export type Playbook = z.infer<typeof PlaybookSchema>;
export type TriageResult = z.infer<typeof TriageResultSchema>;
export type PolicyDecision = z.infer<typeof PolicyDecisionSchema>;
export type ActionRequest = z.infer<typeof ActionRequestSchema>;
export type JournalEntry = z.infer<typeof JournalEntrySchema>;
