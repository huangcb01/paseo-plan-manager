import { defineRpc } from "@getpaseo/plugin/server";
import { z } from "zod";
import {
  CLAUDE_AUTO_COMPACT_MAX,
  isKnownCapabilityModel,
  ModelParameterOverrideSchema,
} from "./model-capabilities.shared";

export const ProviderSchema = z.enum(["codex", "zhipu", "kimi"]);
export const TargetSchema = z.enum(["opencode", "codex", "claude", "ohmypi"]);
export const ZhipuRegionSchema = z.enum(["cn", "global", "cn-dev"]);
export const CodexAuthModeSchema = z.enum(["path", "content"]);

export const ActiveTargetsSchema = z.object({
  opencode: z.object({
    codex: z.string().nullable(),
    zhipu: z.string().nullable(),
    kimi: z.string().nullable(),
  }),
  ohmypi: z.object({
    codex: z.string().nullable(),
    zhipu: z.string().nullable(),
    kimi: z.string().nullable(),
  }),
  codex: z.string().nullable(),
  claude: z.string().nullable(),
});

export const PlanSchema = z.object({
  id: z.string(),
  label: z.string(),
  provider: ProviderSchema,
  region: ZhipuRegionSchema.optional(),
  authFilePath: z.string().optional(),
  accountId: z.string().optional(),
  credentialHint: z.string(),
  useProxy: z.boolean(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export const UsageWindowSchema = z.object({
  id: z.string(),
  label: z.string(),
  usedPercent: z.number().optional(),
  used: z.string().optional(),
  limit: z.string().optional(),
  remaining: z.string().optional(),
  resetAt: z.string().optional(),
  windowSeconds: z.number().optional(),
});

export const TokenActivityPointSchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  tokens: z.number().nonnegative(),
  calls: z.number().int().nonnegative().optional(),
});

export const TokenActivitySchema = z.object({
  source: z.literal("provider"),
  granularity: z.literal("day"),
  points: z.array(TokenActivityPointSchema),
});

export const QuotaSampleWindowSchema = z.object({
  id: z.string(),
  label: z.string(),
  usedPercent: z.number().min(0).max(100),
  resetAt: z.string().optional(),
  reset: z.boolean().optional(),
});

export const QuotaSampleSchema = z.object({
  sampledAt: z.string(),
  windows: z.array(QuotaSampleWindowSchema),
});

export const QuotaHistorySchema = z.object({
  source: z.literal("local"),
  intervalSeconds: z.number().int().positive(),
  points: z.array(QuotaSampleSchema),
});

export const UsageSnapshotSchema = z.object({
  planId: z.string(),
  status: z.enum(["ok", "error"]),
  stale: z.boolean(),
  fetchedAt: z.string(),
  planTier: z.string().optional(),
  windows: z.array(UsageWindowSchema),
  parallelLimit: z.string().optional(),
  balance: z.string().optional(),
  tokenActivity: TokenActivitySchema.optional(),
  tokenActivityStale: z.boolean().optional(),
  tokenActivityError: z.string().optional(),
  quotaHistory: QuotaHistorySchema.optional(),
  error: z.string().optional(),
});

export const ApplyPlanResultSchema = z.object({
  planId: z.string(),
  target: TargetSchema,
  applied: z.boolean(),
  installed: z.boolean(),
  configPaths: z.array(z.string()),
  restartRequired: z.boolean(),
  message: z.string(),
  warnings: z.array(z.string()),
});

const ToolStatusSchema = z.object({
  installed: z.boolean(),
  executable: z.string().optional(),
});

export const DashboardSchema = z.object({
  plans: z.array(PlanSchema),
  usage: z.array(UsageSnapshotSchema),
  activeTargets: ActiveTargetsSchema,
  tools: z.object({
    opencode: ToolStatusSchema,
    codex: ToolStatusSchema,
    claude: ToolStatusSchema,
    ohmypi: ToolStatusSchema,
  }),
  defaultPaths: z.object({
    codexAuth: z.string(),
    opencodeConfig: z.string(),
    claudeSettings: z.string(),
    ohmypiModels: z.string(),
    ohmypiConfig: z.string(),
  }),
  storagePath: z.string(),
});

export const SavePlanInputSchema = z.object({
  id: z.string().optional(),
  label: z.string().trim().min(1).max(100),
  provider: ProviderSchema,
  region: ZhipuRegionSchema.optional(),
  codexAuthMode: CodexAuthModeSchema.optional(),
  authFilePath: z.string().trim().max(4096).optional(),
  authJsonContent: z.string().max(512 * 1024).optional(),
  accountId: z.string().trim().max(256).optional(),
  apiKey: z.string().max(8192).optional(),
  useProxy: z.boolean().optional(),
});

export const OHMPI_MODEL_PARAMETER_FIELDS = new Set([
  "limit.context",
  "limit.output",
  "modalities.input",
  "reasoning",
  "toolCall",
]);

export function targetModelParameterFields(target: Target): Set<string> | undefined {
  if (target === "codex") return new Set(["limit.context", "modalities.input", "reasoning"]);
  if (target === "claude") return new Set(["limit.context"]);
  if (target === "ohmypi") return new Set(OHMPI_MODEL_PARAMETER_FIELDS);
  return undefined;
}

export const ApplyPlanInputSchema = z.object({
  planId: z.string(),
  target: TargetSchema,
  models: z.array(z.string().trim().min(1).max(256))
    .min(1)
    .max(16)
    .transform((models) => [...new Set(models)]),
  modelParameters: z.array(ModelParameterOverrideSchema).max(16).optional(),
}).superRefine((input, context) => {
  const supportedFields = targetModelParameterFields(input.target);
  const seen = new Set<string>();
  for (const [index, override] of (input.modelParameters ?? []).entries()) {
    const editedFields = new Set(override.fields);
    if (!input.models.includes(override.model)) {
      context.addIssue({
        code: "custom",
        path: ["modelParameters", index, "model"],
        message: "Model parameters can only target a selected model",
      });
    }
    if (seen.has(override.model)) {
      context.addIssue({
        code: "custom",
        path: ["modelParameters", index, "model"],
        message: "Model parameters cannot contain duplicate models",
      });
    }
    for (const [fieldIndex, field] of override.fields.entries()) {
      if (supportedFields && !supportedFields.has(field)) {
        context.addIssue({
          code: "custom",
          path: ["modelParameters", index, "fields", fieldIndex],
          message: `${input.target} does not map the ${field} capability field`,
        });
      }
    }
    if (
      input.target === "claude" &&
      override.model.endsWith("[1m]") &&
      override.parameters.limit.context > CLAUDE_AUTO_COMPACT_MAX
    ) {
      context.addIssue({
        code: "custom",
        path: ["modelParameters", index, "parameters", "limit", "context"],
        message: "Claude [1m] model IDs have a fixed 1000000 token context",
      });
    }
    if (
      input.target === "ohmypi" &&
      editedFields.has("modalities.input") &&
      override.parameters.modalities.input.some((modality) => modality !== "text" && modality !== "image")
    ) {
      context.addIssue({
        code: "custom",
        path: ["modelParameters", index, "parameters", "modalities", "input"],
        message: "Oh My Pi only maps text and image input modalities",
      });
    }
    if (input.target === "codex" && isKnownCapabilityModel("zhipu", override.model)) {
      if (editedFields.has("reasoning") && !override.parameters.reasoning) {
        context.addIssue({
          code: "custom",
          path: ["modelParameters", index, "parameters", "reasoning"],
          message: `${override.model} requires reasoning in Codex`,
        });
      }
      if (
        editedFields.has("modalities.input") &&
        (override.parameters.modalities.input.length !== 1 ||
          override.parameters.modalities.input[0] !== "text")
      ) {
        context.addIssue({
          code: "custom",
          path: ["modelParameters", index, "parameters", "modalities", "input"],
          message: `${override.model} only supports text input in Codex`,
        });
      }
    }
    seen.add(override.model);
  }
});

export const getDashboard = defineRpc({
  name: "coding-plans.dashboard.get",
  input: z.object({}),
  output: DashboardSchema,
});

export const savePlan = defineRpc({
  name: "coding-plans.plan.save",
  input: SavePlanInputSchema,
  output: PlanSchema,
});

export const deletePlan = defineRpc({
  name: "coding-plans.plan.delete",
  input: z.object({ planId: z.string() }),
  output: z.object({ deleted: z.boolean() }),
});

export const refreshUsage = defineRpc({
  name: "coding-plans.usage.refresh",
  input: z.object({ planId: z.string().optional() }),
  output: z.object({ usage: z.array(UsageSnapshotSchema) }),
});

export const applyPlan = defineRpc({
  name: "coding-plans.target.apply",
  input: ApplyPlanInputSchema,
  output: ApplyPlanResultSchema,
});

export type Provider = z.infer<typeof ProviderSchema>;
export type Target = z.infer<typeof TargetSchema>;
export type ZhipuRegion = z.infer<typeof ZhipuRegionSchema>;
export type CodexAuthMode = z.infer<typeof CodexAuthModeSchema>;
export type ActiveTargets = z.infer<typeof ActiveTargetsSchema>;
export type Plan = z.infer<typeof PlanSchema>;
export type SavePlanInput = z.infer<typeof SavePlanInputSchema>;
export type ApplyPlanInput = z.infer<typeof ApplyPlanInputSchema>;
export type UsageWindow = z.infer<typeof UsageWindowSchema>;
export type TokenActivityPoint = z.infer<typeof TokenActivityPointSchema>;
export type TokenActivity = z.infer<typeof TokenActivitySchema>;
export type QuotaSampleWindow = z.infer<typeof QuotaSampleWindowSchema>;
export type QuotaSample = z.infer<typeof QuotaSampleSchema>;
export type QuotaHistory = z.infer<typeof QuotaHistorySchema>;
export type UsageSnapshot = z.infer<typeof UsageSnapshotSchema>;
export type Dashboard = z.infer<typeof DashboardSchema>;
export type ApplyPlanResult = z.infer<typeof ApplyPlanResultSchema>;
