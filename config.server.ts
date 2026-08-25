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
    contextTokens: string;
    apiKeyField: "ANTHROPIC_API_KEY" | "ANTHROPIC_AUTH_TOKEN";
  };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
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
        contextTokens: "262144",
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
      contextTokens: "200000",
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

export function patchOpenCodeConfig(text: string | undefined, plan: Plan, selectedModels: readonly string[]): string {
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
  const providerConfig = {
    npm: projection.opencode.npm,
    name: projection.displayName,
    options: {
      baseURL: projection.opencode.baseUrl,
      setCacheKey: true,
    },
    models: Object.fromEntries(models.map((candidate) => [candidate, { name: candidate }])),
  };
  return editJsonc(source, [
    { path: ["provider", projection.providerId], value: providerConfig },
    { path: ["model"], value: `${projection.providerId}/${model}` },
  ]);
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
      if (new RegExp(`^\\s*${key}\\s*=`).test(line)) {
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
  options: { apiKey?: string; modelCatalogPath?: string } = {},
): string {
  const source = text ?? "";
  tomlObject(source, "Codex config.toml");
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
      model_catalog_json: undefined,
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

  result = upsertRootTomlKeys(result, {
    model_provider: "paseo-coding-plan",
    model,
    model_catalog_json: options.modelCatalogPath,
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

export function patchClaudeSettings(
  text: string | undefined,
  plan: Plan,
  apiKey: string,
  selectedModels: readonly string[],
): string {
  if (plan.provider === "codex") {
    throw new Error("Claude Code cannot use a ChatGPT Codex OAuth plan without a protocol-conversion proxy");
  }
  const settings = text?.trim() ? parseJsonObject(text, "Claude settings.json") : {};
  if (settings.env !== undefined && !isObject(settings.env)) {
    throw new Error("Claude settings.json env must be an object");
  }
  if (settings.modelPicker !== undefined && !isObject(settings.modelPicker)) {
    throw new Error("Claude settings.json modelPicker must be an object");
  }
  const env = isObject(settings.env) ? { ...settings.env } : {};
  const projection = providerProjection(plan);
  const models = normalizeModels(selectedModels, "Claude models");
  const model = models[0];
  const contextTokens = plan.provider === "kimi" && models.every((candidate) => /^(k3|k3\[1m\])$/.test(candidate))
    ? "1048576"
    : projection.claude.contextTokens;
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
    CLAUDE_CODE_AUTO_COMPACT_WINDOW: contextTokens,
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
    if (!pickerModels.has(option.model)) {
      pickerModels.add(option.model);
      options.push(option);
    }
  }
  for (const candidate of models) {
    if (!pickerModels.has(candidate)) {
      pickerModels.add(candidate);
      options.push({ model: candidate, label: candidate });
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

export function codexModelCatalog(selectedModels: readonly string[]): string {
  const models = normalizeModels(selectedModels, "Codex models");
  return `${JSON.stringify({
    models: models.map((model) => {
      const contextWindow = model === "glm-5.3" ? 1_048_576 : 204_800;
      return {
        slug: model,
        display_name: model,
        description: "Z.AI GLM Coding Plan",
        default_reasoning_level: "high",
        supported_reasoning_levels: [
          { effort: "low", description: "Light reasoning" },
          { effort: "high", description: "Enhanced reasoning" },
          { effort: "max", description: "Deep reasoning" },
        ],
        shell_type: "shell_command",
        visibility: "list",
        supported_in_api: true,
        priority: 0,
        base_instructions: "",
        supports_reasoning_summaries: true,
        default_reasoning_summary: "none",
        support_verbosity: false,
        apply_patch_tool_type: "freeform",
        truncation_policy: { mode: "bytes", limit: 10_000 },
        context_window: contextWindow,
        max_context_window: contextWindow,
        effective_context_window_percent: 95,
        supports_parallel_tool_calls: true,
        experimental_supported_tools: [],
        input_modalities: ["text"],
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
  const nextConfig = patchOpenCodeConfig(configText, plan, selectedModels);
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
    const nextConfig = patchCodexConfig(configText, plan, selectedModels);
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
  const catalogPath = path.join(directory, "paseo-coding-plan-models.json");
  const nextConfig = patchCodexConfig(configText, plan, selectedModels, {
    apiKey: secret.apiKey,
    modelCatalogPath: catalogPath,
  });
  await writePair(catalogPath, codexModelCatalog(selectedModels), configPath, nextConfig, {
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
  const nextSettings = patchClaudeSettings(settingsText, plan, secret.apiKey, selectedModels);
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
): Promise<ApplyResult> {
  const selectedModels = normalizeModels(models, "Target models");
  const status = await toolsAndPaths();
  const installed = status.tools[target].installed;
  return store.withPlanForApply(planId, target, async (plan, secret) => {
    const result = target === "opencode"
      ? await applyOpenCode(plan, secret, selectedModels, installed)
      : target === "codex"
        ? await applyCodex(plan, secret, selectedModels, installed)
        : await applyClaude(plan, secret, selectedModels, installed);
    return { result, applied: result.applied };
  });
}
