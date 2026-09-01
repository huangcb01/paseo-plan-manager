import { z } from "zod";

export type CapabilityProvider = "zhipu" | "kimi";
export type CapabilityTarget = "opencode" | "codex" | "claude" | "ohmypi";

export const CLAUDE_AUTO_COMPACT_MIN = 100_000;
export const CLAUDE_AUTO_COMPACT_MAX = 1_000_000;

export const ModelModalitySchema = z.enum(["text", "audio", "image", "video", "pdf"]);
export const ModelInterleavedFieldSchema = z.enum([
  "reasoning",
  "reasoning_content",
  "reasoning_text",
]);
export const ModelCapabilityFieldSchema = z.enum([
  "limit.context",
  "limit.input",
  "limit.output",
  "modalities.input",
  "modalities.output",
  "reasoning",
  "attachment",
  "toolCall",
  "temperature",
  "interleaved",
]);

const TokenLimitSchema = z.number().int().positive().max(100_000_000);
const ModalitiesSchema = z.array(ModelModalitySchema)
  .min(1)
  .max(ModelModalitySchema.options.length)
  .transform((values) => [...new Set(values)]);

export const ModelCapabilityParametersSchema = z.object({
  limit: z.object({
    context: TokenLimitSchema,
    input: TokenLimitSchema.optional(),
    output: TokenLimitSchema,
  }),
  modalities: z.object({
    input: ModalitiesSchema,
    output: ModalitiesSchema,
  }),
  reasoning: z.boolean(),
  attachment: z.boolean(),
  toolCall: z.boolean(),
  temperature: z.boolean(),
  interleaved: ModelInterleavedFieldSchema.nullable(),
});

export const ModelParameterOverrideSchema = z.object({
  model: z.string().trim().min(1).max(256),
  parameters: ModelCapabilityParametersSchema,
  fields: z.array(ModelCapabilityFieldSchema)
    .min(1)
    .max(ModelCapabilityFieldSchema.options.length)
    .transform((values) => [...new Set(values)]),
});

export type ModelModality = z.infer<typeof ModelModalitySchema>;
export type ModelInterleavedField = z.infer<typeof ModelInterleavedFieldSchema>;
export type ModelCapabilityField = z.infer<typeof ModelCapabilityFieldSchema>;
export type ModelCapabilityParameters = z.infer<typeof ModelCapabilityParametersSchema>;
export type ModelParameterOverride = z.infer<typeof ModelParameterOverrideSchema>;
export type ModelParameterPatch = Pick<ModelParameterOverride, "parameters" | "fields">;

// These values mirror the models.dev records consumed by OpenCode.
const DEFAULT_MODEL_CAPABILITIES: Record<CapabilityProvider, ModelCapabilityParameters> = {
  zhipu: {
    limit: { context: 204_800, output: 131_072 },
    modalities: { input: ["text"], output: ["text"] },
    reasoning: true,
    attachment: false,
    toolCall: true,
    temperature: true,
    interleaved: "reasoning_content",
  },
  kimi: {
    limit: { context: 262_144, output: 32_768 },
    modalities: { input: ["text"], output: ["text"] },
    reasoning: true,
    attachment: false,
    toolCall: true,
    temperature: false,
    interleaved: null,
  },
};

const MODEL_CAPABILITIES: Record<CapabilityProvider, Record<string, ModelCapabilityParameters>> = {
  zhipu: {
    "glm-5.1": {
      limit: { context: 200_000, output: 131_072 },
      modalities: { input: ["text"], output: ["text"] },
      reasoning: true,
      attachment: false,
      toolCall: true,
      temperature: true,
      interleaved: "reasoning_content",
    },
    "glm-5.3": {
      limit: { context: 1_000_000, output: 131_072 },
      modalities: { input: ["text"], output: ["text"] },
      reasoning: true,
      attachment: false,
      toolCall: true,
      temperature: true,
      interleaved: "reasoning_content",
    },
    "glm-5-turbo": {
      limit: { context: 200_000, output: 131_072 },
      modalities: { input: ["text"], output: ["text"] },
      reasoning: true,
      attachment: false,
      toolCall: true,
      temperature: true,
      interleaved: "reasoning_content",
    },
    "glm-4.7": {
      limit: { context: 204_800, output: 131_072 },
      modalities: { input: ["text"], output: ["text"] },
      reasoning: true,
      attachment: false,
      toolCall: true,
      temperature: true,
      interleaved: "reasoning_content",
    },
  },
  kimi: {
    "kimi-for-coding": {
      limit: { context: 262_144, output: 32_768 },
      modalities: { input: ["text", "image", "video"], output: ["text"] },
      reasoning: true,
      attachment: true,
      toolCall: true,
      temperature: false,
      interleaved: null,
    },
    "kimi-for-coding-highspeed": {
      limit: { context: 262_144, output: 32_768 },
      modalities: { input: ["text", "image", "video"], output: ["text"] },
      reasoning: true,
      attachment: true,
      toolCall: true,
      temperature: false,
      interleaved: null,
    },
    k3: {
      limit: { context: 1_048_576, output: 131_072 },
      modalities: { input: ["text", "image", "video"], output: ["text"] },
      reasoning: true,
      attachment: false,
      toolCall: true,
      temperature: false,
      interleaved: null,
    },
    "k3-256k": {
      limit: { context: 262_144, output: 131_072 },
      modalities: { input: ["text", "image"], output: ["text"] },
      reasoning: true,
      attachment: false,
      toolCall: true,
      temperature: false,
      interleaved: null,
    },
  },
};

export function canonicalCapabilityModel(provider: CapabilityProvider, model: string): string {
  const withoutContextSuffix = model.endsWith("[1m]") ? model.slice(0, -4) : model;
  return Object.hasOwn(MODEL_CAPABILITIES[provider], withoutContextSuffix)
    ? withoutContextSuffix
    : model;
}

export function isKnownCapabilityModel(provider: CapabilityProvider, model: string): boolean {
  return Object.hasOwn(MODEL_CAPABILITIES[provider], canonicalCapabilityModel(provider, model));
}

export function modelCapabilityParameters(
  provider: CapabilityProvider,
  model: string,
): ModelCapabilityParameters {
  const canonical = canonicalCapabilityModel(provider, model);
  const parameters = MODEL_CAPABILITIES[provider][canonical] ?? DEFAULT_MODEL_CAPABILITIES[provider];
  return structuredClone(parameters);
}

export function targetModelCapabilityParameters(
  provider: CapabilityProvider,
  target: CapabilityTarget,
  model: string,
): ModelCapabilityParameters {
  const parameters = modelCapabilityParameters(provider, model);
  if (target === "codex") {
    parameters.limit.context = model === "glm-5.3" ? 1_048_576 : 204_800;
    parameters.modalities.input = ["text"];
  } else if (target === "claude") {
    parameters.limit.context = model.endsWith("[1m]") || (provider === "kimi" && model === "k3")
      ? provider === "kimi" && model === "k3"
        ? 1_048_576
        : 1_000_000
      : provider === "kimi"
        ? 262_144
        : 200_000;
  }
  return parameters;
}

export function estimatedOpenCodeCompactionThreshold(parameters: ModelCapabilityParameters): number {
  const maxOutput = Math.min(parameters.limit.output, 32_000) || 32_000;
  if (parameters.limit.input !== undefined) {
    return Math.max(0, parameters.limit.input - Math.min(20_000, maxOutput));
  }
  return Math.max(0, parameters.limit.context - maxOutput);
}
