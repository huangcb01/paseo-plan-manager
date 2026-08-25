import { defineRpc } from "@getpaseo/plugin/server";
import { z } from "zod";

export const ProviderSchema = z.enum(["codex", "zhipu", "kimi"]);
export const TargetSchema = z.enum(["opencode", "codex", "claude"]);
export const ZhipuRegionSchema = z.enum(["cn", "global", "cn-dev"]);
export const CodexAuthModeSchema = z.enum(["path", "content"]);

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

export const UsageSnapshotSchema = z.object({
  planId: z.string(),
  status: z.enum(["ok", "error"]),
  stale: z.boolean(),
  fetchedAt: z.string(),
  planTier: z.string().optional(),
  windows: z.array(UsageWindowSchema),
  parallelLimit: z.string().optional(),
  balance: z.string().optional(),
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
  activeTargets: z.object({
    opencode: z.string().nullable(),
    codex: z.string().nullable(),
    claude: z.string().nullable(),
  }),
  tools: z.object({
    opencode: ToolStatusSchema,
    codex: ToolStatusSchema,
    claude: ToolStatusSchema,
  }),
  defaultPaths: z.object({
    codexAuth: z.string(),
    opencodeConfig: z.string(),
    claudeSettings: z.string(),
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

export const ApplyPlanInputSchema = z.object({
  planId: z.string(),
  target: TargetSchema,
  models: z.array(z.string().trim().min(1).max(256))
    .min(1)
    .max(16)
    .transform((models) => [...new Set(models)]),
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
export type Plan = z.infer<typeof PlanSchema>;
export type SavePlanInput = z.infer<typeof SavePlanInputSchema>;
export type ApplyPlanInput = z.infer<typeof ApplyPlanInputSchema>;
export type UsageWindow = z.infer<typeof UsageWindowSchema>;
export type UsageSnapshot = z.infer<typeof UsageSnapshotSchema>;
export type Dashboard = z.infer<typeof DashboardSchema>;
export type ApplyPlanResult = z.infer<typeof ApplyPlanResultSchema>;
