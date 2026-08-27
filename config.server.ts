import { existsSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import {
  applyEdits,
  modify,
  parse,
  type ParseError,
  printParseErrorCode,
} from "jsonc-parser/lib/esm/main.js";
import { parse as parseToml } from "smol-toml";
import type { Plan, Target } from "./plans.shared";
import {
  CLAUDE_AUTO_COMPACT_MIN,
  CLAUDE_AUTO_COMPACT_MAX,
  isKnownCapabilityModel,
  modelCapabilityParameters,
  ModelParameterOverrideSchema,
  targetModelCapabilityParameters,
  type CapabilityProvider,
  type ModelCapabilityParameters,
  type ModelParameterPatch,
} from "./model-capabilities.shared";
import {
  atomicWriteFile,
  captureFile,
  expandHome,
  findExecutable,
  parseJsonObject,
  readTextIfExists,
  restoreFile,
} from "./file-utils.server";
import {
  codexAccountId,
  codexGeneration,
  codexIdentity,
  codexTokenIdentity,
  codexTokens,
  parseJwtPayload,
  type CodexSecret,
  type PlanSecret,
  type PlanStore,
  planStore,
} from "./store.server";

interface ToolStatus {
  installed: boolean;
  executable?: string;
}

export interface ToolAndPathState {
  tools: Record<Target, ToolStatus>;
  defaultPaths: {
    codexAuth: string;
    opencodeConfig: string;
    claudeSettings: string;
  };
}

export interface ApplyResult {
  planId: string;
  target: Target;
  applied: boolean;
  installed: boolean;
  configPaths: string[];
  restartRequired: boolean;
  message: string;
  warnings: string[];
}

interface ProviderProjection {
  providerId: "zhipu" | "kimi";
  displayName: string;
  opencode: { npm: string; baseUrl: string };
  codex: { baseUrl: string };
  claude: {
    baseUrl: string;
    apiKeyField: "ANTHROPIC_API_KEY" | "ANTHROPIC_AUTH_TOKEN";
  };
}

type ApiKeyProvider = CapabilityProvider;

function openCodeModelDefinition(
  provider: ApiKeyProvider,
  model: string,
  capabilities: ModelCapabilityParameters = modelCapabilityParameters(provider, model),
): Record<string, unknown> {
  return {
    name: model,
    limit: {
      context: capabilities.limit.context,
      ...(capabilities.limit.input !== undefined ? { input: capabilities.limit.input } : {}),
      output: capabilities.limit.output,
    },
    modalities: {
      input: [...capabilities.modalities.input],
      output: [...capabilities.modalities.output],
    },
    reasoning: capabilities.reasoning,
    attachment: capabilities.attachment,
    tool_call: capabilities.toolCall,
    temperature: capabilities.temperature,
    ...(capabilities.interleaved
      ? { interleaved: { field: capabilities.interleaved } }
      : {}),
  };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function validateSparseOpenCodeLimit(
  existingModel: Record<string, unknown>,
  override: ModelCapabilityParameters,
  editedFields: ReadonlySet<string>,
  description: string,
): void {
  if (![...editedFields].some((field) => field.startsWith("limit."))) return;
  const limit = isObject(existingModel.limit) ? { ...existingModel.limit } : {};
  if (limit.context === undefined) limit.context = override.limit.context;
  if (limit.output === undefined) limit.output = override.limit.output;
  if (editedFields.has("limit.context")) limit.context = override.limit.context;
  if (editedFields.has("limit.output")) limit.output = override.limit.output;
  if (editedFields.has("limit.input")) {
    if (override.limit.input === undefined) delete limit.input;
    else limit.input = override.limit.input;
  }

  validateOpenCodeLimit(limit, `${description} after applying edited fields`);
}

function validateOpenCodeLimit(limit: Record<string, unknown>, description: string): void {
  function token(field: "context" | "input" | "output", required = false): number | undefined {
    const value = limit[field];
    if (value === undefined && !required) return undefined;
    if (typeof value !== "number" || !Number.isInteger(value) || value <= 0 || value > 100_000_000) {
      throw new Error(`${description}.${field} must be a positive integer no greater than 100000000`);
    }
    return value;
  }

  const context = token("context", true) as number;
  const input = token("input");
  const output = token("output", true) as number;
  if (output > context) throw new Error(`${description}.output cannot exceed context`);
  if (input !== undefined && input > context) throw new Error(`${description}.input cannot exceed context`);
}

function nonEmpty(value: string, description: string): string {
  const result = value.trim();
  if (!result) throw new Error(`${description} cannot be empty`);
  return result;
}

function normalizeModels(values: readonly string[], description: string): string[] {
  if (!Array.isArray(values)) throw new Error(`${description} must be an array`);
  if (values.length === 0) throw new Error(`${description} must contain at least one model`);
  if (values.length > 16) throw new Error(`${description} cannot contain more than 16 models`);
  const models: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    if (typeof value !== "string") throw new Error(`${description} entries must be strings`);
    const model = nonEmpty(value, `${description} entry`);
    if (model.length > 256) throw new Error(`${description} entries cannot exceed 256 characters`);
    if (!seen.has(model)) {
      seen.add(model);
      models.push(model);
    }
  }
  return models;
}

export function providerProjection(plan: Plan): ProviderProjection {
  if (plan.provider === "kimi") {
    return {
      providerId: "kimi",
      displayName: "Kimi For Coding",
      opencode: { npm: "@ai-sdk/anthropic", baseUrl: "https://api.kimi.com/coding/v1" },
      codex: { baseUrl: "https://api.kimi.com/coding/v1" },
      claude: {
        baseUrl: "https://api.kimi.com/coding/",
        apiKeyField: "ANTHROPIC_API_KEY",
      },
    };
  }
  if (plan.provider !== "zhipu") throw new Error("Codex OAuth does not have an API-key projection");
  const host = plan.region === "global"
    ? "api.z.ai"
    : plan.region === "cn-dev"
      ? "dev.bigmodel.cn"
      : "open.bigmodel.cn";
  return {
    providerId: "zhipu",
    displayName: plan.region === "global" ? "Zhipu GLM Global" : "Zhipu GLM",
    opencode: {
      npm: "@ai-sdk/openai-compatible",
      baseUrl: `https://${host}/api/coding/paas/v4`,
    },
    codex: {
      baseUrl: plan.region === "global"
        ? "https://api.z.ai/api/v1"
        : plan.region === "cn"
          ? "https://open.bigmodel.cn/api/v1"
          : `https://${host}/api/coding/paas/v4`,
    },
    claude: {
      baseUrl: `https://${host}/api/anthropic`,
      apiKeyField: "ANTHROPIC_AUTH_TOKEN",
    },
  };
}

function jsoncValue(text: string, description: string): Record<string, unknown> {
  const errors: ParseError[] = [];
  const parsed: unknown = parse(text, errors, { allowTrailingComma: true, disallowComments: false });
  if (errors.length > 0) {
    throw new Error(`${description} is invalid: ${printParseErrorCode(errors[0].error)}`);
  }
  if (!isObject(parsed)) throw new Error(`${description} must contain a JSON object`);
  return parsed;
}

function editJsonc(
  text: string,
  changes: Array<{ path: (string | number)[]; value: unknown }>,
): string {
  let result = text;
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const tabSize = /^\s{4}\S/m.test(text) ? 4 : 2;
  for (const change of changes) {
    result = applyEdits(
      result,
      modify(result, change.path, change.value, {
        formattingOptions: { insertSpaces: true, tabSize, eol },
      }),
    );
  }
  jsoncValue(result, "Updated OpenCode config");
  return result.endsWith(eol) ? result : `${result}${eol}`;
}

export function patchOpenCodeConfig(
  text: string | undefined,
  plan: Plan,
  selectedModels: readonly string[],
  modelParameters?: ReadonlyMap<string, ModelParameterPatch>,
): string {
  const source = text?.trim() ? text : "{\n  \"$schema\": \"https://opencode.ai/config.json\"\n}\n";
  const parsed = jsoncValue(source, "OpenCode config");
  if (parsed.provider !== undefined && !isObject(parsed.provider)) {
    throw new Error("OpenCode config.provider must be an object");
  }

  const models = normalizeModels(selectedModels, "OpenCode models");
  const model = models[0];
  if (plan.provider === "codex") {
    return editJsonc(source, [
      { path: ["model"], value: `openai/${model}` },
    ]);
  }

  const projection = providerProjection(plan);
  const providers = isObject(parsed.provider) ? parsed.provider : {};
  const existingProvider = providers[projection.providerId];
  if (existingProvider !== undefined && !isObject(existingProvider)) {
    throw new Error(`OpenCode config.provider.${projection.providerId} must be an object`);
  }
  if (isObject(existingProvider) && existingProvider.options !== undefined && !isObject(existingProvider.options)) {
    throw new Error(`OpenCode config.provider.${projection.providerId}.options must be an object`);
  }
  if (isObject(existingProvider) && existingProvider.models !== undefined && !isObject(existingProvider.models)) {
    throw new Error(`OpenCode config.provider.${projection.providerId}.models must be an object`);
  }
  const existingModels = isObject(existingProvider) && isObject(existingProvider.models)
    ? existingProvider.models
    : {};
  for (const candidate of models) {
    const existingModel = Object.hasOwn(existingModels, candidate) ? existingModels[candidate] : undefined;
    if (existingModel !== undefined && !isObject(existingModel)) {
      throw new Error(`OpenCode config.provider.${projection.providerId}.models.${candidate} must be an object`);
    }
    if (isObject(existingModel)) {
      for (const field of ["limit", "modalities"] as const) {
        if (existingModel[field] !== undefined && !isObject(existingModel[field])) {
          throw new Error(`OpenCode config.provider.${projection.providerId}.models.${candidate}.${field} must be an object`);
        }
      }
    }
  }

  const changes: Array<{ path: (string | number)[]; value: unknown }> = [
    { path: ["provider", projection.providerId, "npm"], value: projection.opencode.npm },
    { path: ["provider", projection.providerId, "name"], value: projection.displayName },
    { path: ["provider", projection.providerId, "options", "baseURL"], value: projection.opencode.baseUrl },
    { path: ["provider", projection.providerId, "options", "setCacheKey"], value: true },
    { path: ["provider", projection.providerId, "options", "apiKey"], value: undefined },
  ];
  for (const candidate of models) {
    const existingModel = isObject(existingModels[candidate]) ? existingModels[candidate] : undefined;
    const parameterPatch = modelParameters?.get(candidate);
    const override = parameterPatch?.parameters;
    const editedFields = new Set<string>(parameterPatch?.fields ?? []);
    const knownModel = isKnownCapabilityModel(plan.provider, candidate);
    const managedModel = knownModel || override !== undefined;
    const definition = openCodeModelDefinition(plan.provider, candidate, override);
    const preserveCustomFields = Boolean(existingModel && parameterPatch && !knownModel);
    if (preserveCustomFields && existingModel && override) {
      validateSparseOpenCodeLimit(
        existingModel,
        override,
        editedFields,
        `OpenCode model ${candidate} limit`,
      );
    } else if (isObject(definition.limit)) {
      validateOpenCodeLimit(definition.limit, `OpenCode model ${candidate} limit`);
    }
    for (const [field, value] of Object.entries(definition)) {
      if (!managedModel && existingModel && Object.hasOwn(existingModel, field)) continue;
      const capabilityField = field === "tool_call" ? "toolCall" : field;
      if (
        preserveCustomFields &&
        field !== "limit" &&
        field !== "modalities" &&
        !editedFields.has(capabilityField)
      ) continue;
      if (
        managedModel &&
        (field === "limit" || field === "modalities") &&
        isObject(value) &&
        (isObject(existingModel?.[field]) || preserveCustomFields)
      ) {
        const existingNested = isObject(existingModel?.[field]) ? existingModel[field] : {};
        const groupEdited = [...editedFields].some((candidate) => candidate.startsWith(`${field}.`));
        const requiredFields = field === "limit" ? ["context", "output"] : ["input", "output"];
        for (const [nestedField, nestedValue] of Object.entries(value)) {
          const missingRequired = groupEdited &&
            requiredFields.includes(nestedField) &&
            !Object.hasOwn(existingNested, nestedField);
          if (
            preserveCustomFields &&
            !editedFields.has(`${field}.${nestedField}`) &&
            !missingRequired
          ) continue;
          changes.push({
            path: ["provider", projection.providerId, "models", candidate, field, nestedField],
            value: nestedValue,
          });
        }
        if (
          field === "limit" &&
          override &&
          override.limit.input === undefined &&
          (!preserveCustomFields || editedFields.has("limit.input"))
        ) {
          changes.push({
            path: ["provider", projection.providerId, "models", candidate, "limit", "input"],
            value: undefined,
          });
        }
        continue;
      }
      changes.push({ path: ["provider", projection.providerId, "models", candidate, field], value });
    }
    if (
      override?.interleaved === null &&
      (!preserveCustomFields || editedFields.has("interleaved"))
    ) {
      changes.push({
        path: ["provider", projection.providerId, "models", candidate, "interleaved"],
        value: undefined,
      });
    }
  }
  changes.push({ path: ["model"], value: `${projection.providerId}/${model}` });
  return editJsonc(source, changes);
}

function accessTokenExpiry(auth: Record<string, unknown>): number {
  const tokens = codexTokens(auth);
  const access = typeof tokens.access_token === "string" ? tokens.access_token : undefined;
  const claims = parseJwtPayload(access);
  const seconds = typeof claims?.exp === "number" ? claims.exp : Number(claims?.exp);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : 0;
}

function destinationGeneration(accessToken: string, explicitExpiry?: number): number {
  const claims = parseJwtPayload(accessToken);
  const jwtExpiry = Number(claims?.exp);
  return Math.max(
    Number.isFinite(jwtExpiry) ? jwtExpiry * 1000 : 0,
    explicitExpiry && Number.isFinite(explicitExpiry) ? explicitExpiry : 0,
  );
}

function absorbOpenCodeOAuth(
  plan: Plan,
  secret: CodexSecret,
  authText: string | undefined,
): void {
  if (!authText?.trim()) return;
  const auth = parseJsonObject(authText, "OpenCode auth.json");
  const destination = auth.openai;
  if (!isObject(destination) || destination.type !== "oauth") return;
  const access = typeof destination.access === "string" ? destination.access : undefined;
  const refresh = typeof destination.refresh === "string" ? destination.refresh : undefined;
  if (!access || !refresh) throw new Error("OpenCode OAuth credential is incomplete");

  const candidateTokens = codexTokens(secret.auth);
  if (candidateTokens.access_token === access && candidateTokens.refresh_token === refresh) return;
  const candidateIdentity = codexIdentity(secret.auth);
  const destinationIdentity = codexTokenIdentity(access);
  if (!candidateIdentity || !destinationIdentity) {
    throw new Error("Cannot safely compare the existing OpenCode OAuth credential identity");
  }
  if (candidateIdentity !== destinationIdentity) return;

  const candidateGeneration = codexGeneration(secret.auth);
  const targetGeneration = destinationGeneration(access, Number(destination.expires));
  if (targetGeneration === candidateGeneration && candidateTokens.refresh_token !== refresh) {
    throw new Error("OpenCode and stored OAuth credentials have conflicting refresh generations");
  }
  if (targetGeneration <= candidateGeneration) return;

  const updated = structuredClone(secret.auth);
  const tokens = codexTokens(updated);
  tokens.access_token = access;
  tokens.refresh_token = refresh;
  const accountId = plan.accountId ?? (typeof destination.accountId === "string" ? destination.accountId : undefined);
  if (accountId) tokens.account_id = accountId;
  updated.last_refresh = new Date().toISOString();
  secret.auth = updated;
}

function absorbCodexOAuth(
  plan: Plan,
  secret: CodexSecret,
  authText: string | undefined,
): void {
  if (!authText?.trim()) return;
  const destination = parseJsonObject(authText, "Codex auth.json");
  let destinationTokens: Record<string, unknown>;
  try {
    destinationTokens = codexTokens(destination);
  } catch {
    return;
  }
  const candidateTokens = codexTokens(secret.auth);
  if (
    candidateTokens.access_token === destinationTokens.access_token &&
    candidateTokens.refresh_token === destinationTokens.refresh_token
  ) return;
  const candidateIdentity = codexIdentity(secret.auth);
  const targetIdentity = codexIdentity(destination);
  if (!candidateIdentity || !targetIdentity) {
    throw new Error("Cannot safely compare the existing Codex OAuth credential identity");
  }
  if (candidateIdentity !== targetIdentity) return;
  const candidateGeneration = codexGeneration(secret.auth);
  const targetGeneration = codexGeneration(destination);
  if (targetGeneration === candidateGeneration && candidateTokens.refresh_token !== destinationTokens.refresh_token) {
    throw new Error("Codex and stored OAuth credentials have conflicting refresh generations");
  }
  if (targetGeneration <= candidateGeneration) return;
  const updated = structuredClone(destination);
  const tokens = codexTokens(updated);
  if (plan.accountId) tokens.account_id = plan.accountId;
  secret.auth = updated;
}

export function patchOpenCodeAuth(
  text: string | undefined,
  plan: Plan,
  secret: PlanSecret,
): string {
  const auth = text?.trim() ? parseJsonObject(text, "OpenCode auth.json") : {};
  if (plan.provider === "codex") {
    if (secret.kind !== "codex-auth") throw new Error("Codex OAuth credential is missing");
    const tokens = codexTokens(secret.auth);
    auth.openai = {
      type: "oauth",
      refresh: String(tokens.refresh_token),
      access: String(tokens.access_token),
      expires: accessTokenExpiry(secret.auth),
      ...(plan.accountId ?? codexAccountId(secret.auth)
        ? { accountId: plan.accountId ?? codexAccountId(secret.auth) }
        : {}),
    };
  } else {
    if (secret.kind !== "api-key") throw new Error("API key is missing");
    auth[providerProjection(plan).providerId] = { type: "api", key: secret.apiKey };
  }
  return `${JSON.stringify(auth, null, 2)}\n`;
}

const MANAGED_TOML_START = "# BEGIN paseo-coding-plan-manager";
const MANAGED_TOML_END = "# END paseo-coding-plan-manager";
const CODEX_MODEL_CATALOG_FILENAME = "paseo-coding-plan-models.json";

function isManagedCodexModelCatalog(value: unknown, expectedPath: string | undefined): boolean {
  if (typeof value !== "string" || expectedPath === undefined) return false;
  const configuredPath = value === "~" || value.startsWith("~/") || value.startsWith("~\\")
    ? expandHome(value)
    : path.isAbsolute(value)
      ? path.normalize(value)
      : path.resolve(path.dirname(expectedPath), value);
  return configuredPath === path.resolve(expectedPath);
}

function removeManagedToml(text: string): string {
  const startMatch = /^[\t ]*# BEGIN paseo-coding-plan-manager[\t ]*$/m.exec(text);
  if (!startMatch) return text;
  const start = startMatch.index;
  const remainder = text.slice(start + startMatch[0].length);
  const endMatch = /^[\t ]*# END paseo-coding-plan-manager[\t ]*$/m.exec(remainder);
  if (!endMatch) throw new Error("Codex config contains an unterminated Paseo managed block");
  const after = start + startMatch[0].length + endMatch.index + endMatch[0].length;
  return `${text.slice(0, start).trimEnd()}\n${text.slice(after).trimStart()}`;
}

function tomlString(value: string): string {
  return JSON.stringify(value);
}

function tomlObject(text: string, description: string): Record<string, unknown> {
  try {
    const parsed: unknown = parseToml(text);
    if (!isObject(parsed)) throw new Error("root is not an object");
    return parsed;
  } catch {
    throw new Error(`${description} is not valid TOML`);
  }
}

function upsertRootTomlKeys(
  text: string,
  values: Record<string, string | boolean | undefined>,
): string {
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const firstTable = lines.findIndex((line) => /^\s*\[/.test(line));
  const boundary = firstTable < 0 ? lines.length : firstTable;
  const remaining = new Set(
    Object.keys(values).filter((key) => values[key] !== undefined),
  );
  const prefix: string[] = [];

  for (let index = 0; index < boundary; index += 1) {
    const line = lines[index];
    let matched = false;
    for (const key of Object.keys(values)) {
      const bareKey = new RegExp(`^\\s*${key}\\s*=`).test(line);
      const removableQuotedKey = values[key] === undefined &&
        new RegExp(`^\\s*(?:"${key}"|'${key}')\\s*=`).test(line);
      if (bareKey || removableQuotedKey) {
        if (values[key] !== undefined && remaining.has(key)) {
          prefix.push(`${key} = ${typeof values[key] === "boolean" ? values[key] : tomlString(String(values[key]))}`);
          remaining.delete(key);
        }
        matched = true;
        break;
      }
    }
    if (!matched) prefix.push(line);
  }

  const additions = [...remaining].map((key) =>
    `${key} = ${typeof values[key] === "boolean" ? values[key] : tomlString(String(values[key]))}`,
  );
  const suffix = lines.slice(boundary);
  const combined = [...additions, ...prefix, ...suffix].join(eol).replace(new RegExp(`${eol}{3,}`, "g"), `${eol}${eol}`);
  return combined.trimEnd() ? `${combined.trimEnd()}${eol}` : "";
}

export function patchCodexConfig(
  text: string | undefined,
  plan: Plan,
  selectedModels: readonly string[],
  options: {
    apiKey?: string;
    modelCatalogPath?: string;
    modelParameters?: ReadonlyMap<string, ModelParameterPatch>;
  } = {},
): string {
  const source = text ?? "";
  const parsedSource = tomlObject(source, "Codex config.toml");
  if (source.includes('"""') || source.includes("'''")) {
    throw new Error("Codex config with multiline TOML strings cannot be safely patched");
  }
  let result = removeManagedToml(source);
  const models = normalizeModels(selectedModels, "Codex models");
  const model = models[0];
  if (plan.provider === "codex") {
    const updated = upsertRootTomlKeys(result, {
      model_provider: "openai",
      model,
      ...(isManagedCodexModelCatalog(parsedSource.model_catalog_json, options.modelCatalogPath)
        ? { model_catalog_json: undefined }
        : {}),
    });
    tomlObject(updated, "Updated Codex config.toml");
    return updated;
  }

  if (plan.provider !== "zhipu" || plan.region === "cn-dev") {
    throw new Error("This Coding Plan requires a Chat-to-Responses conversion proxy for Codex");
  }
  if (!options.apiKey || !options.modelCatalogPath) {
    throw new Error("Z.AI Codex projection requires an API key and model catalog path");
  }

  const defaultParameters = targetModelCapabilityParameters("zhipu", "codex", model);
  const parameterPatch = options.modelParameters?.get(model);
  const reasoning = parameterPatch?.fields.includes("reasoning")
    ? parameterPatch.parameters.reasoning
    : defaultParameters.reasoning;

  result = upsertRootTomlKeys(result, {
    model_provider: "paseo-coding-plan",
    model,
    model_catalog_json: options.modelCatalogPath,
    ...(!reasoning ? { model_reasoning_effort: undefined } : {}),
  });
  const projection = providerProjection(plan);
  const block = [
    MANAGED_TOML_START,
    "[model_providers.paseo-coding-plan]",
    `name = ${tomlString(projection.displayName)}`,
    `base_url = ${tomlString(projection.codex.baseUrl)}`,
    `experimental_bearer_token = ${tomlString(options.apiKey)}`,
    'wire_api = "responses"',
    "requires_openai_auth = false",
    MANAGED_TOML_END,
    "",
  ].join("\n");
  const updated = `${result.trimEnd()}\n\n${block}`;
  tomlObject(updated, "Updated Codex config.toml");
  return updated;
}

const CLAUDE_PROJECTED_MODEL_FIELDS = [
  "ANTHROPIC_DEFAULT_FABLE_MODEL",
  "ANTHROPIC_DEFAULT_HAIKU_MODEL",
  "ANTHROPIC_DEFAULT_SONNET_MODEL",
  "ANTHROPIC_DEFAULT_OPUS_MODEL",
  "CLAUDE_CODE_SUBAGENT_MODEL",
] as const;
const CLAUDE_MANAGED_MODEL_DESCRIPTION = "Managed by Paseo Coding Plan Manager";

function claudeProjectedProvider(env: Record<string, unknown>): ApiKeyProvider | undefined {
  const model = env.ANTHROPIC_MODEL;
  if (typeof model !== "string" || !CLAUDE_PROJECTED_MODEL_FIELDS.every((field) => env[field] === model)) {
    return undefined;
  }
  const baseUrl = env.ANTHROPIC_BASE_URL;
  if (baseUrl === "https://api.kimi.com/coding/") return "kimi";
  if (
    baseUrl === "https://api.z.ai/api/anthropic" ||
    baseUrl === "https://open.bigmodel.cn/api/anthropic" ||
    baseUrl === "https://dev.bigmodel.cn/api/anthropic"
  ) return "zhipu";
  return undefined;
}

function isLegacyGeneratedClaudeOption(
  option: Record<string, unknown>,
  previousProvider: ApiKeyProvider,
): boolean {
  return Object.keys(option).length === 2 &&
    option.label === option.model &&
    typeof option.model === "string" &&
    isKnownCapabilityModel(previousProvider, option.model);
}

function isManagedClaudeOption(option: Record<string, unknown>): boolean {
  return option.description === CLAUDE_MANAGED_MODEL_DESCRIPTION;
}

export function patchClaudeSettings(
  text: string | undefined,
  plan: Plan,
  apiKey: string,
  selectedModels: readonly string[],
  modelParameters?: ReadonlyMap<string, ModelParameterPatch>,
): string {
  if (plan.provider === "codex") {
    throw new Error("Claude Code cannot use a ChatGPT Codex OAuth plan without a protocol-conversion proxy");
  }
  const capabilityProvider = plan.provider;
  const settings = text?.trim() ? parseJsonObject(text, "Claude settings.json") : {};
  if (settings.env !== undefined && !isObject(settings.env)) {
    throw new Error("Claude settings.json env must be an object");
  }
  if (settings.modelPicker !== undefined && !isObject(settings.modelPicker)) {
    throw new Error("Claude settings.json modelPicker must be an object");
  }
  const env = isObject(settings.env) ? { ...settings.env } : {};
  const previousProvider = claudeProjectedProvider(env);
  const projection = providerProjection(plan);
  const models = normalizeModels(selectedModels, "Claude models");
  const model = models[0];
  const modelContexts = models.map((candidate) => ({
    model: candidate,
    context: modelParameters?.get(candidate)?.parameters.limit.context ??
      targetModelCapabilityParameters(capabilityProvider, "claude", candidate).limit.context,
  }));
  for (const candidate of modelContexts) {
    if (candidate.model.endsWith("[1m]") && candidate.context > CLAUDE_AUTO_COMPACT_MAX) {
      throw new Error("Claude [1m] model IDs have a fixed 1000000 token context");
    }
  }
  const contextValue = Math.min(...modelContexts.map((candidate) => candidate.context));
  const contextTokens = String(contextValue);
  const autoCompactTokens = String(Math.min(
    Math.max(contextValue, CLAUDE_AUTO_COMPACT_MIN),
    CLAUDE_AUTO_COMPACT_MAX,
  ));
  delete env.ANTHROPIC_API_KEY;
  delete env.ANTHROPIC_AUTH_TOKEN;
  const providerEnvironment: Record<string, string> = {
    ANTHROPIC_BASE_URL: projection.claude.baseUrl,
    ANTHROPIC_MODEL: model,
    ANTHROPIC_DEFAULT_FABLE_MODEL: model,
    ANTHROPIC_DEFAULT_HAIKU_MODEL: model,
    ANTHROPIC_DEFAULT_SONNET_MODEL: model,
    ANTHROPIC_DEFAULT_OPUS_MODEL: model,
    CLAUDE_CODE_SUBAGENT_MODEL: model,
    CLAUDE_CODE_EFFORT_LEVEL: "high",
    CLAUDE_CODE_MAX_CONTEXT_TOKENS: contextTokens,
    CLAUDE_CODE_AUTO_COMPACT_WINDOW: autoCompactTokens,
  };
  providerEnvironment[projection.claude.apiKeyField] = apiKey;
  Object.assign(env, providerEnvironment);
  const modelPicker = isObject(settings.modelPicker) ? { ...settings.modelPicker } : {};
  if (modelPicker.options !== undefined && !Array.isArray(modelPicker.options)) {
    throw new Error("Claude settings.json modelPicker.options must be an array");
  }
  if (
    modelPicker.replaceBuiltInOptions !== undefined &&
    typeof modelPicker.replaceBuiltInOptions !== "boolean"
  ) {
    throw new Error("Claude settings.json modelPicker.replaceBuiltInOptions must be a boolean");
  }
  const options: Record<string, unknown>[] = [];
  const pickerModels = new Set<string>();
  for (const option of modelPicker.options ?? []) {
    if (
      !isObject(option) ||
      typeof option.model !== "string" ||
      (option.label !== undefined && typeof option.label !== "string") ||
      (option.description !== undefined && typeof option.description !== "string")
    ) {
      throw new Error("Claude settings.json modelPicker.options entries must have compatible model, label, and description fields");
    }
    if (isManagedClaudeOption(option) || (previousProvider && isLegacyGeneratedClaudeOption(option, previousProvider))) {
      continue;
    }
    if (!pickerModels.has(option.model)) {
      pickerModels.add(option.model);
      options.push(option);
    }
  }
  for (const candidate of models) {
    if (!pickerModels.has(candidate)) {
      pickerModels.add(candidate);
      options.push({
        model: candidate,
        label: candidate,
        description: CLAUDE_MANAGED_MODEL_DESCRIPTION,
      });
    }
  }
  settings.env = env;
  settings.modelPicker = { ...modelPicker, options };
  return `${JSON.stringify(settings, null, 2)}\n`;
}

export function patchClaudeState(text: string | undefined, plan: Plan): string {
  const state = text?.trim() ? parseJsonObject(text, "Claude state file") : {};
  state.hasCompletedOnboarding = true;
  if (plan.provider === "kimi") state.penguinModeOrgEnabled = true;
  return `${JSON.stringify(state, null, 2)}\n`;
}

export function codexModelCatalog(
  selectedModels: readonly string[],
  modelParameters?: ReadonlyMap<string, ModelParameterPatch>,
): string {
  const models = normalizeModels(selectedModels, "Codex models");
  return `${JSON.stringify({
    models: models.map((model, priority) => {
      const parameterPatch = modelParameters?.get(model);
      const override = parameterPatch?.parameters;
      const editedFields = new Set(parameterPatch?.fields ?? []);
      const defaults = targetModelCapabilityParameters("zhipu", "codex", model);
      const reasoning = editedFields.has("reasoning") && override
        ? override.reasoning
        : defaults.reasoning;
      const inputModalities = editedFields.has("modalities.input") && override
        ? override.modalities.input.filter((modality) => (
            modality === "text" || modality === "image" || modality === "audio"
          ))
        : defaults.modalities.input;
      if (isKnownCapabilityModel("zhipu", model)) {
        if (!reasoning) throw new Error(`${model} requires reasoning in Codex`);
        if (inputModalities.length !== 1 || inputModalities[0] !== "text") {
          throw new Error(`${model} only supports text input in Codex`);
        }
      }
      const contextWindow = editedFields.has("limit.context") && override
        ? override.limit.context
        : defaults.limit.context;
      return {
        slug: model,
        display_name: model,
        description: "Z.AI GLM Coding Plan",
        ...(reasoning ? { default_reasoning_level: "max" } : {}),
        supported_reasoning_levels: reasoning && model === "glm-5.3"
          ? [
              { effort: "low", description: "Light reasoning" },
              { effort: "high", description: "Enhanced reasoning" },
              { effort: "max", description: "Deep reasoning" },
            ]
          : [],
        shell_type: "shell_command",
        visibility: "list",
        supported_in_api: true,
        priority,
        base_instructions: "",
        supports_reasoning_summary_parameter: reasoning,
        default_reasoning_summary: "none",
        support_verbosity: false,
        apply_patch_tool_type: "freeform",
        truncation_policy: { mode: "bytes", limit: 10_000 },
        context_window: contextWindow,
        max_context_window: contextWindow,
        effective_context_window_percent: 95,
        experimental_supported_tools: [],
        input_modalities: inputModalities.length ? inputModalities : ["text"],
      };
    }),
  }, null, 2)}\n`;
}

function opencodeConfigDirectory(): string {
  if (process.env.OPENCODE_CONFIG_DIR?.trim()) return expandHome(process.env.OPENCODE_CONFIG_DIR);
  const xdg = process.env.XDG_CONFIG_HOME?.trim()
    ? expandHome(process.env.XDG_CONFIG_HOME)
    : path.join(homedir(), ".config");
  return path.join(xdg, "opencode");
}

async function opencodeConfigPath(): Promise<string> {
  if (process.env.OPENCODE_CONFIG?.trim()) return expandHome(process.env.OPENCODE_CONFIG);
  const directory = opencodeConfigDirectory();
  const jsonc = path.join(directory, "opencode.jsonc");
  const json = path.join(directory, "opencode.json");
  if (existsSync(jsonc)) return jsonc;
  if (existsSync(json)) return json;
  return json;
}

function opencodeAuthPath(): string {
  const data = process.env.XDG_DATA_HOME?.trim()
    ? expandHome(process.env.XDG_DATA_HOME)
    : path.join(homedir(), ".local", "share");
  return path.join(data, "opencode", "auth.json");
}

function codexDirectory(): string {
  return process.env.CODEX_HOME?.trim() ? expandHome(process.env.CODEX_HOME) : path.join(homedir(), ".codex");
}

function claudeDirectory(): string {
  return process.env.CLAUDE_CONFIG_DIR?.trim()
    ? expandHome(process.env.CLAUDE_CONFIG_DIR)
    : path.join(homedir(), ".claude");
}

function claudeStatePath(): string {
  if (process.env.CLAUDE_CONFIG_DIR?.trim()) {
    const directory = expandHome(process.env.CLAUDE_CONFIG_DIR);
    const legacyState = path.join(directory, ".config.json");
    return existsSync(legacyState) ? legacyState : path.join(directory, ".claude.json");
  }
  return path.join(homedir(), ".claude.json");
}

export async function toolsAndPaths(): Promise<ToolAndPathState> {
  const [opencode, codex, claude, openCodeConfig] = await Promise.all([
    findExecutable("opencode"),
    findExecutable("codex"),
    findExecutable("claude"),
    opencodeConfigPath(),
  ]);
  return {
    tools: {
      opencode: { installed: Boolean(opencode), ...(opencode ? { executable: opencode } : {}) },
      codex: { installed: Boolean(codex), ...(codex ? { executable: codex } : {}) },
      claude: { installed: Boolean(claude), ...(claude ? { executable: claude } : {}) },
    },
    defaultPaths: {
      codexAuth: path.join(codexDirectory(), "auth.json"),
      opencodeConfig: openCodeConfig,
      claudeSettings: path.join(claudeDirectory(), "settings.json"),
    },
  };
}

interface PairWriteOptions {
  secondMode?: number;
  expectedFirst?: { text: string | undefined };
  expectedSecond?: { text: string | undefined };
}

function snapshotText(snapshot: Awaited<ReturnType<typeof captureFile>>): string | undefined {
  return snapshot.exists ? snapshot.contents?.toString("utf8") : undefined;
}

async function writePair(
  firstPath: string,
  firstContents: string,
  secondPath: string,
  secondContents: string,
  options: PairWriteOptions = {},
): Promise<void> {
  const [firstSnapshot, secondSnapshot] = await Promise.all([
    captureFile(firstPath),
    captureFile(secondPath),
  ]);
  if (options.expectedFirst && snapshotText(firstSnapshot) !== options.expectedFirst.text) {
    throw new Error(`Credential changed concurrently: ${firstPath}`);
  }
  if (options.expectedSecond && snapshotText(secondSnapshot) !== options.expectedSecond.text) {
    throw new Error(`Configuration changed concurrently: ${secondPath}`);
  }
  await atomicWriteFile(firstPath, firstContents, 0o600);
  try {
    await atomicWriteFile(secondPath, secondContents, options.secondMode);
  } catch (error) {
    try {
      await restoreFile(firstPath, firstSnapshot);
    } catch (rollbackError) {
      throw new AggregateError(
        [error, rollbackError],
        `Failed to update ${secondPath} and failed to restore ${firstPath}`,
      );
    }
    throw error;
  }
}

async function applyOpenCode(
  plan: Plan,
  secret: PlanSecret,
  models: readonly string[],
  modelParameters: ReadonlyMap<string, ModelParameterPatch>,
  installed: boolean,
): Promise<ApplyResult> {
  const selectedModels = normalizeModels(models, "OpenCode models");
  if (process.env.OPENCODE_CONFIG_CONTENT) {
    throw new Error("OPENCODE_CONFIG_CONTENT overrides files; refusing an ineffective switch");
  }
  if (process.env.OPENCODE_AUTH_CONTENT) {
    throw new Error("OPENCODE_AUTH_CONTENT overrides auth.json; refusing an ineffective switch");
  }
  const configPath = await opencodeConfigPath();
  const authPath = opencodeAuthPath();
  const [configText, authText] = await Promise.all([
    readTextIfExists(configPath),
    readTextIfExists(authPath),
  ]);
  if (plan.provider === "codex") {
    if (secret.kind !== "codex-auth") throw new Error("Codex OAuth credential is missing");
    absorbOpenCodeOAuth(plan, secret, authText);
  }
  const nextConfig = patchOpenCodeConfig(configText, plan, selectedModels, modelParameters);
  const nextAuth = patchOpenCodeAuth(authText, plan, secret);
  await writePair(authPath, nextAuth, configPath, nextConfig, {
    expectedFirst: { text: authText },
    expectedSecond: { text: configText },
  });
  const warnings = installed ? [] : ["未检测到 OpenCode；仅写入配置，没有安装 OpenCode。"];
  warnings.push("已运行的 OpenCode 进程可能需要重新加载配置或重启。");
  if (plan.provider === "codex") {
    warnings.push("OpenCode 与 Codex 不应同时刷新同一份旋转 OAuth refresh token；切换前请结束旧会话。");
  }
  return {
    planId: plan.id,
    target: "opencode",
    applied: true,
    installed,
    configPaths: [configPath, authPath],
    restartRequired: true,
    message: `已将 ${plan.label} 配置到 OpenCode。`,
    warnings,
  };
}

async function applyCodex(
  plan: Plan,
  secret: PlanSecret,
  models: readonly string[],
  modelParameters: ReadonlyMap<string, ModelParameterPatch>,
  installed: boolean,
): Promise<ApplyResult> {
  const selectedModels = normalizeModels(models, "Codex models");
  const directory = codexDirectory();
  const configPath = path.join(directory, "config.toml");
  const authPath = path.join(directory, "auth.json");
  const configText = await readTextIfExists(configPath);
  const parsedConfig = tomlObject(configText ?? "", "Codex config.toml");
  const warnings = ["Codex 配置投影尚未在本机做端到端测试。"];
  if (plan.provider === "codex") {
    if (secret.kind !== "codex-auth") throw new Error("Codex OAuth credential is missing");
    const credentialStore = typeof parsedConfig.cli_auth_credentials_store === "string"
      ? parsedConfig.cli_auth_credentials_store
      : undefined;
    if (credentialStore && credentialStore !== "file") {
      return {
        planId: plan.id,
        target: "codex",
        applied: false,
        installed,
        configPaths: [],
        restartRequired: false,
        message: `未写入 Codex：cli_auth_credentials_store=${credentialStore} 不使用 auth.json。`,
        warnings: ["请先由 Codex 自身切换到 file 凭据存储；插件不会修改系统钥匙串。"],
      };
    }
    const currentAuthText = await readTextIfExists(authPath);
    absorbCodexOAuth(plan, secret, currentAuthText);
    const auth = structuredClone(secret.auth);
    const tokens = codexTokens(auth);
    if (plan.accountId) tokens.account_id = plan.accountId;
    const nextAuth = `${JSON.stringify(auth, null, 2)}\n`;
    const nextConfig = patchCodexConfig(configText, plan, selectedModels, {
      modelCatalogPath: path.join(directory, CODEX_MODEL_CATALOG_FILENAME),
    });
    if (!installed) warnings.push("未检测到 Codex；仅写入配置，没有安装 Codex。");
    await writePair(authPath, nextAuth, configPath, nextConfig, {
      expectedFirst: { text: currentAuthText },
      expectedSecond: { text: configText },
    });
    return {
      planId: plan.id,
      target: "codex",
      applied: true,
      installed,
      configPaths: [configPath, authPath],
      restartRequired: true,
      message: `已将 ${plan.label} 配置到 Codex。`,
      warnings,
    };
  }

  if (plan.provider !== "zhipu" || plan.region === "cn-dev") {
    return {
      planId: plan.id,
      target: "codex",
      applied: false,
      installed,
      configPaths: [],
      restartRequired: false,
      message: "未写入 Codex：该 Plan 只提供 Chat Completions，而 Codex 要求 Responses API。",
      warnings: ["需要类似 CC Switch 的本地协议转换代理；本插件不内置代理。"],
    };
  }
  if (secret.kind !== "api-key") throw new Error("API key is missing");
  const catalogPath = path.join(directory, CODEX_MODEL_CATALOG_FILENAME);
  const nextConfig = patchCodexConfig(configText, plan, selectedModels, {
    apiKey: secret.apiKey,
    modelCatalogPath: catalogPath,
    modelParameters,
  });
  await writePair(catalogPath, codexModelCatalog(selectedModels, modelParameters), configPath, nextConfig, {
    secondMode: 0o600,
    expectedSecond: { text: configText },
  });
  if (!installed) warnings.push("未检测到 Codex；仅写入配置，没有安装 Codex。");
  return {
    planId: plan.id,
    target: "codex",
    applied: true,
    installed,
    configPaths: [configPath, catalogPath],
    restartRequired: true,
    message: `已将 ${plan.label} 配置到 Codex。`,
    warnings,
  };
}

async function applyClaude(
  plan: Plan,
  secret: PlanSecret,
  models: readonly string[],
  modelParameters: ReadonlyMap<string, ModelParameterPatch>,
  installed: boolean,
): Promise<ApplyResult> {
  const selectedModels = normalizeModels(models, "Claude models");
  if (plan.provider === "codex") {
    return {
      planId: plan.id,
      target: "claude",
      applied: false,
      installed,
      configPaths: [],
      restartRequired: false,
      message: "未写入 Claude Code：ChatGPT Codex OAuth 需要 Anthropic-to-Responses 协议转换代理。",
      warnings: ["插件不会写入一个确定不可用的直连配置。"],
    };
  }
  if (secret.kind !== "api-key") throw new Error("API key is missing");
  const settingsPath = path.join(claudeDirectory(), "settings.json");
  const statePath = claudeStatePath();
  const [settingsText, stateText] = await Promise.all([
    readTextIfExists(settingsPath),
    readTextIfExists(statePath),
  ]);
  const nextSettings = patchClaudeSettings(
    settingsText,
    plan,
    secret.apiKey,
    selectedModels,
    modelParameters,
  );
  const nextState = patchClaudeState(stateText, plan);
  await writePair(statePath, nextState, settingsPath, nextSettings, {
    secondMode: 0o600,
    expectedFirst: { text: stateText },
    expectedSecond: { text: settingsText },
  });
  const warnings = ["Claude Code 配置投影尚未在本机做端到端测试。"];
  if (!installed) warnings.push("未检测到 Claude Code；仅写入配置，没有安装 Claude Code。");
  if (selectedModels.length > 1) {
    warnings.push("多个候选模型需要 Claude Code 2.1.242 或更高版本的 model picker 支持。");
  }
  warnings.push("请新建 Claude Code 会话；已有会话不会可靠地切换认证信息。");
  return {
    planId: plan.id,
    target: "claude",
    applied: true,
    installed,
    configPaths: [settingsPath, statePath],
    restartRequired: true,
    message: `已将 ${plan.label} 配置到 Claude Code。`,
    warnings,
  };
}

export async function applyPlanToTarget(
  planId: string,
  target: Target,
  models: readonly string[],
  store: PlanStore = planStore,
  modelParameters: ReadonlyMap<string, ModelParameterPatch> = new Map(),
): Promise<ApplyResult> {
  const selectedModels = normalizeModels(models, "Target models");
  const supportedFields = target === "codex"
    ? new Set(["limit.context", "modalities.input", "reasoning"])
    : target === "claude"
      ? new Set(["limit.context"])
      : undefined;
  const validatedModelParameters = new Map<string, ModelParameterPatch>();
  for (const [model, parameterPatch] of modelParameters) {
    if (!selectedModels.includes(model)) {
      throw new Error("Model parameters can only target a selected model");
    }
    const parsed = ModelParameterOverrideSchema.safeParse({ model, ...parameterPatch });
    if (!parsed.success) {
      throw new Error(`Invalid model parameters for ${model}: ${parsed.error.issues[0]?.message ?? "invalid value"}`);
    }
    const editedFields = new Set(parsed.data.fields);
    for (const field of parsed.data.fields) {
      if (supportedFields && !supportedFields.has(field)) {
        throw new Error(`${target} does not map the ${field} capability field`);
      }
    }
    const parameters = parsed.data.parameters;
    if (
      target === "claude" &&
      model.endsWith("[1m]") &&
      parameters.limit.context > CLAUDE_AUTO_COMPACT_MAX
    ) {
      throw new Error("Claude [1m] model IDs have a fixed 1000000 token context");
    }
    if (target === "codex" && isKnownCapabilityModel("zhipu", model)) {
      if (editedFields.has("reasoning") && !parameters.reasoning) {
        throw new Error(`${model} requires reasoning in Codex`);
      }
      if (
        editedFields.has("modalities.input") &&
        (parameters.modalities.input.length !== 1 || parameters.modalities.input[0] !== "text")
      ) {
        throw new Error(`${model} only supports text input in Codex`);
      }
    }
    validatedModelParameters.set(model, {
      parameters,
      fields: parsed.data.fields,
    });
  }
  const status = await toolsAndPaths();
  const installed = status.tools[target].installed;
  return store.withPlanForApply(planId, target, async (plan, secret) => {
    const result = target === "opencode"
      ? await applyOpenCode(plan, secret, selectedModels, validatedModelParameters, installed)
      : target === "codex"
        ? await applyCodex(plan, secret, selectedModels, validatedModelParameters, installed)
        : await applyClaude(plan, secret, selectedModels, validatedModelParameters, installed);
    return { result, applied: result.applied };
  });
}
