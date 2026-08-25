import { createHash, randomUUID } from "node:crypto";
import { homedir } from "node:os";
import path from "node:path";
import { readdir, unlink } from "node:fs/promises";
import type {
  ActiveTargets,
  Plan,
  Provider,
  SavePlanInput,
  Target,
  UsageSnapshot,
  ZhipuRegion,
} from "./plans.shared";
import {
  atomicWriteFile,
  captureFile,
  ensurePrivateDirectory,
  expandHome,
  parseJsonObject,
  paseoCodingPlanHome,
  readTextIfExists,
  restoreFile,
} from "./file-utils.server";

interface StoreState {
  version: 4;
  plans: Plan[];
  activeTargets: ActiveTargets;
}

type LegacyPlanV2 = Omit<Plan, "useProxy">;

interface LegacyPlanV1 extends LegacyPlanV2 {
  models: Record<Target, string>;
}

export interface CodexSecret {
  kind: "codex-auth";
  auth: Record<string, unknown>;
}

export interface ApiKeySecret {
  kind: "api-key";
  apiKey: string;
}

export type PlanSecret = CodexSecret | ApiKeySecret;
const MAX_SECRET_FILE_BYTES = 1024 * 1024;

function serializeSecret(secret: PlanSecret): string {
  const text = `${JSON.stringify(secret, null, 2)}\n`;
  if (Buffer.byteLength(text, "utf8") > MAX_SECRET_FILE_BYTES) {
    throw new Error("Coding Plan credential is too large");
  }
  return text;
}

export interface PlanSnapshot {
  plan: Plan;
  secret: PlanSecret;
}

const PROVIDERS = ["codex", "zhipu", "kimi"] as const satisfies readonly Provider[];

function emptyActiveTargets(): ActiveTargets {
  return {
    opencode: { codex: null, zhipu: null, kimi: null },
    codex: null,
    claude: null,
  };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function defaultCodexAuthPath(): string {
  const codexHome = process.env.CODEX_HOME?.trim()
    ? expandHome(process.env.CODEX_HOME)
    : path.join(homedir(), ".codex");
  return path.join(codexHome, "auth.json");
}

export function parseJwtPayload(token: string | undefined): Record<string, unknown> | undefined {
  if (!token) return undefined;
  const parts = token.split(".");
  if (parts.length !== 3) return undefined;
  try {
    const payload: unknown = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
    return isObject(payload) ? payload : undefined;
  } catch {
    return undefined;
  }
}

export function codexTokens(auth: Record<string, unknown>): Record<string, unknown> {
  const tokens = auth.tokens;
  if (!isObject(tokens)) throw new Error("Codex auth.json does not contain a tokens object");
  if (typeof tokens.access_token !== "string" || !tokens.access_token) {
    throw new Error("Codex auth.json does not contain an access token");
  }
  if (typeof tokens.refresh_token !== "string" || !tokens.refresh_token) {
    throw new Error("Codex auth.json does not contain a refresh token");
  }
  return tokens;
}

export function codexAccountId(auth: Record<string, unknown>): string | undefined {
  const tokens = codexTokens(auth);
  if (typeof tokens.account_id === "string" && tokens.account_id) return tokens.account_id;

  const claims = parseJwtPayload(
    typeof tokens.id_token === "string" ? tokens.id_token : String(tokens.access_token),
  );
  if (!claims) return undefined;
  if (typeof claims.chatgpt_account_id === "string") return claims.chatgpt_account_id;
  const namespaced = claims["https://api.openai.com/auth"];
  if (isObject(namespaced) && typeof namespaced.chatgpt_account_id === "string") {
    return namespaced.chatgpt_account_id;
  }
  const organizations = claims.organizations;
  if (Array.isArray(organizations) && isObject(organizations[0])) {
    const id = organizations[0].id;
    if (typeof id === "string") return id;
  }
  return undefined;
}

export function codexTokenIdentity(token: string | undefined): string | undefined {
  const claims = parseJwtPayload(token);
  if (!claims) return undefined;
  const namespaced = claims["https://api.openai.com/auth"];
  if (isObject(namespaced) && typeof namespaced.chatgpt_user_id === "string") {
    return `user:${namespaced.chatgpt_user_id}`;
  }
  if (typeof claims.chatgpt_user_id === "string") return `user:${claims.chatgpt_user_id}`;
  if (typeof claims.sub === "string") return `sub:${claims.sub}`;
  return undefined;
}

export function codexIdentity(auth: Record<string, unknown>): string | undefined {
  const tokens = codexTokens(auth);
  return codexTokenIdentity(
    typeof tokens.id_token === "string" ? tokens.id_token : undefined,
  ) ?? codexTokenIdentity(
    typeof tokens.access_token === "string" ? tokens.access_token : undefined,
  );
}

export function codexGeneration(auth: Record<string, unknown>): number {
  const tokens = codexTokens(auth);
  const access = typeof tokens.access_token === "string" ? tokens.access_token : undefined;
  const expires = Number(parseJwtPayload(access)?.exp);
  const refreshed = Date.parse(typeof auth.last_refresh === "string" ? auth.last_refresh : "");
  return Math.max(Number.isFinite(expires) ? expires * 1000 : 0, Number.isFinite(refreshed) ? refreshed : 0);
}

function credentialHint(provider: Provider, secret: PlanSecret, accountId?: string): string {
  if (secret.kind === "codex-auth") {
    const suffix = accountId ? accountId.slice(-8) : "account";
    return `OAuth ...${suffix}`;
  }
  const fingerprint = createHash("sha256").update(secret.apiKey).digest("hex").slice(0, 6);
  const suffix = secret.apiKey.length >= 8 ? `...${secret.apiKey.slice(-4)}` : "credential";
  return `${provider === "zhipu" ? "GLM" : "Kimi"} ${suffix} (${fingerprint})`;
}

function validatePlanMetadata(value: unknown): value is LegacyPlanV2 {
  if (!isObject(value)) return false;
  if (typeof value.id !== "string" || typeof value.label !== "string") return false;
  if (!(["codex", "zhipu", "kimi"] as unknown[]).includes(value.provider)) return false;
  if (typeof value.credentialHint !== "string") return false;
  if (typeof value.createdAt !== "string" || typeof value.updatedAt !== "string") return false;
  if (value.region !== undefined && !(["cn", "global", "cn-dev"] as unknown[]).includes(value.region)) return false;
  if (value.authFilePath !== undefined && typeof value.authFilePath !== "string") return false;
  if (value.accountId !== undefined && typeof value.accountId !== "string") return false;
  return true;
}

function validatePlan(value: unknown): value is Plan {
  if (!validatePlanMetadata(value)) return false;
  const record = value as unknown as Record<string, unknown>;
  return typeof record.useProxy === "boolean" && !("models" in record);
}

function validateLegacyPlanV2(value: unknown): value is LegacyPlanV2 {
  return validatePlanMetadata(value) && !("useProxy" in value) && !("models" in value);
}

function validateLegacyPlanV1(value: unknown): value is LegacyPlanV1 {
  if (!validatePlanMetadata(value)) return false;
  const models = (value as unknown as Record<string, unknown>).models;
  return isObject(models) && ["opencode", "codex", "claude"].every(
    (key) => typeof models[key] === "string",
  );
}

function referencedPlan(plans: readonly Plan[], value: unknown): Plan | undefined {
  if (typeof value !== "string") return undefined;
  let match: Plan | undefined;
  for (const plan of plans) {
    if (plan.id !== value) continue;
    if (match) return undefined;
    match = plan;
  }
  return match;
}

function migrateActiveTargets(value: unknown, plans: readonly Plan[]): ActiveTargets {
  const active = isObject(value) ? value : {};
  const migrated = emptyActiveTargets();
  const opencodePlan = referencedPlan(plans, active.opencode);
  if (opencodePlan) migrated.opencode[opencodePlan.provider] = opencodePlan.id;
  migrated.codex = referencedPlan(plans, active.codex)?.id ?? null;
  migrated.claude = referencedPlan(plans, active.claude)?.id ?? null;
  return migrated;
}

function parseActiveTargets(value: unknown, plans: readonly Plan[]): ActiveTargets {
  const active = isObject(value) ? value : {};
  const opencode = isObject(active.opencode) ? active.opencode : {};
  const parsed = emptyActiveTargets();
  for (const provider of PROVIDERS) {
    const plan = referencedPlan(plans, opencode[provider]);
    parsed.opencode[provider] = plan?.provider === provider ? plan.id : null;
  }
  parsed.codex = referencedPlan(plans, active.codex)?.id ?? null;
  parsed.claude = referencedPlan(plans, active.claude)?.id ?? null;
  return parsed;
}

function cloneActiveTargets(active: ActiveTargets): ActiveTargets {
  return {
    opencode: { ...active.opencode },
    codex: active.codex,
    claude: active.claude,
  };
}

function setActiveTarget(active: ActiveTargets, target: Target, plan: Plan): void {
  if (target === "opencode") active.opencode[plan.provider] = plan.id;
  else active[target] = plan.id;
}

function clearActivePlan(active: ActiveTargets, planId: string): void {
  for (const provider of PROVIDERS) {
    if (active.opencode[provider] === planId) active.opencode[provider] = null;
  }
  if (active.codex === planId) active.codex = null;
  if (active.claude === planId) active.claude = null;
}

function addProxyDefault(plan: LegacyPlanV2): Plan {
  return { ...plan, useProxy: plan.provider === "codex" };
}

function migrateLegacyPlanV1(plan: LegacyPlanV1): Plan {
  const current = { ...plan } as Record<string, unknown>;
  delete current.models;
  return addProxyDefault(current as LegacyPlanV2);
}

function validateUsage(value: unknown): value is UsageSnapshot {
  if (
    !isObject(value) ||
    typeof value.planId !== "string" ||
    (value.status !== "ok" && value.status !== "error") ||
    typeof value.stale !== "boolean" ||
    typeof value.fetchedAt !== "string" ||
    !Array.isArray(value.windows) ||
    !value.windows.every((window) => (
      isObject(window) &&
      typeof window.id === "string" &&
      typeof window.label === "string"
    ))
  ) {
    return false;
  }
  if (value.tokenActivity !== undefined) {
    if (
      !isObject(value.tokenActivity) ||
      value.tokenActivity.source !== "provider" ||
      value.tokenActivity.granularity !== "day" ||
      !Array.isArray(value.tokenActivity.points) ||
      !value.tokenActivity.points.every((point) => (
        isObject(point) &&
        typeof point.date === "string" &&
        typeof point.tokens === "number" &&
        Number.isFinite(point.tokens) &&
        point.tokens >= 0 &&
        (point.calls === undefined || (
          typeof point.calls === "number" && Number.isInteger(point.calls) && point.calls >= 0
        ))
      ))
    ) {
      return false;
    }
  }
  if (value.quotaHistory !== undefined) {
    if (
      !isObject(value.quotaHistory) ||
      value.quotaHistory.source !== "local" ||
      typeof value.quotaHistory.intervalSeconds !== "number" ||
      !Number.isInteger(value.quotaHistory.intervalSeconds) ||
      value.quotaHistory.intervalSeconds <= 0 ||
      !Array.isArray(value.quotaHistory.points) ||
      !value.quotaHistory.points.every((point) => (
        isObject(point) &&
        typeof point.sampledAt === "string" &&
        Array.isArray(point.windows) &&
        point.windows.every((window) => (
          isObject(window) &&
          typeof window.id === "string" &&
          typeof window.label === "string" &&
          typeof window.usedPercent === "number" &&
          Number.isFinite(window.usedPercent) &&
          window.usedPercent >= 0 &&
          window.usedPercent <= 100 &&
          (window.reset === undefined || typeof window.reset === "boolean")
        ))
      ))
    ) {
      return false;
    }
  }
  return (
    (value.tokenActivityStale === undefined || typeof value.tokenActivityStale === "boolean") &&
    (value.tokenActivityError === undefined || typeof value.tokenActivityError === "string") &&
    (value.error === undefined || typeof value.error === "string")
  );
}

function mergeCachedUsage(current: UsageSnapshot | undefined, incoming: UsageSnapshot): UsageSnapshot {
  if (!current) return incoming;
  const currentTime = Date.parse(current.fetchedAt);
  const incomingTime = Date.parse(incoming.fetchedAt);
  const incomingIsOlder = Number.isFinite(currentTime) &&
    Number.isFinite(incomingTime) &&
    incomingTime < currentTime;
  let merged = incomingIsOlder ? current : incoming;
  if (!incomingIsOlder && incoming.tokenActivityStale && current.tokenActivity) {
    merged = {
      ...merged,
      tokenActivity: current.tokenActivity,
      tokenActivityStale: true,
    };
  }
  if (current.quotaHistory && incoming.quotaHistory) {
    const points = new Map(current.quotaHistory.points.map((point) => [point.sampledAt, point]));
    for (const point of incoming.quotaHistory.points) points.set(point.sampledAt, point);
    const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
    const intervalMs = incoming.quotaHistory.intervalSeconds * 1000;
    const sorted = [...points.values()]
      .filter((point) => {
        const timestamp = Date.parse(point.sampledAt);
        return Number.isFinite(timestamp) && timestamp >= cutoff;
      })
      .sort((left, right) => left.sampledAt.localeCompare(right.sampledAt));
    const sampled: typeof sorted = [];
    for (const point of sorted) {
      const last = sampled[sampled.length - 1];
      if (!last || Date.parse(point.sampledAt) - Date.parse(last.sampledAt) >= intervalMs) {
        sampled.push(point);
      }
    }
    const maxPoints = Math.ceil(
      (7 * 24 * 60 * 60) / incoming.quotaHistory.intervalSeconds,
    ) + 1;
    merged = {
      ...merged,
      quotaHistory: {
        ...incoming.quotaHistory,
        points: sampled.slice(-maxPoints),
      },
    };
  } else if (current.quotaHistory && !incoming.quotaHistory) {
    const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
    const points = current.quotaHistory.points.filter((point) => {
      const timestamp = Date.parse(point.sampledAt);
      return Number.isFinite(timestamp) && timestamp >= cutoff;
    });
    if (points.length) {
      merged = { ...merged, quotaHistory: { ...current.quotaHistory, points } };
    } else if (merged.quotaHistory) {
      const { quotaHistory: _expired, ...withoutQuotaHistory } = merged;
      merged = withoutQuotaHistory;
    }
  }
  return merged;
}

export class PlanStore {
  readonly root: string;
  private queue: Promise<void> = Promise.resolve();
  private initialization?: Promise<void>;

  constructor(root = paseoCodingPlanHome()) {
    this.root = root;
  }

  private get statePath(): string {
    return path.join(this.root, "plans.json");
  }

  private get usagePath(): string {
    return path.join(this.root, "usage-cache.json");
  }

  private secretPath(planId: string): string {
    if (!/^[a-z0-9-]+$/.test(planId)) throw new Error("Invalid plan ID");
    return path.join(this.root, "secrets", `${planId}.json`);
  }

  async initialize(): Promise<void> {
    if (!this.initialization) {
      this.initialization = (async () => {
        const secretsDirectory = path.join(this.root, "secrets");
        await ensurePrivateDirectory(this.root);
        await ensurePrivateDirectory(secretsDirectory);

        const stateText = await readTextIfExists(this.statePath);
        let validPlanIds: Set<string> | undefined;
        if (!stateText) {
          validPlanIds = new Set();
        } else {
          let parsed: Record<string, unknown> | undefined;
          try {
            parsed = parseJsonObject(stateText, this.statePath);
          } catch {
            // Never delete credentials when the metadata file cannot be trusted.
          }
          if (parsed?.version === 4 && Array.isArray(parsed.plans) && parsed.plans.every(validatePlan)) {
            validPlanIds = new Set(parsed.plans.map((plan) => plan.id));
          } else if (
            parsed?.version === 3 &&
            Array.isArray(parsed.plans) &&
            parsed.plans.every(validatePlan)
          ) {
            const plans = parsed.plans.map((plan) => structuredClone(plan));
            const migrated: StoreState = {
              version: 4,
              plans,
              activeTargets: migrateActiveTargets(parsed.activeTargets, plans),
            };
            await atomicWriteFile(this.statePath, `${JSON.stringify(migrated, null, 2)}\n`, 0o600);
            validPlanIds = new Set(plans.map((plan) => plan.id));
          } else if (
            parsed?.version === 2 &&
            Array.isArray(parsed.plans) &&
            parsed.plans.every(validateLegacyPlanV2)
          ) {
            const plans = parsed.plans.map(addProxyDefault);
            const migrated: StoreState = {
              version: 4,
              plans,
              activeTargets: migrateActiveTargets(parsed.activeTargets, plans),
            };
            await atomicWriteFile(this.statePath, `${JSON.stringify(migrated, null, 2)}\n`, 0o600);
            validPlanIds = new Set(migrated.plans.map((plan) => plan.id));
          } else if (
            parsed?.version === 1 &&
            Array.isArray(parsed.plans) &&
            parsed.plans.every(validateLegacyPlanV1)
          ) {
            const plans = parsed.plans.map(migrateLegacyPlanV1);
            const migrated: StoreState = {
              version: 4,
              plans,
              activeTargets: migrateActiveTargets(parsed.activeTargets, plans),
            };
            await atomicWriteFile(this.statePath, `${JSON.stringify(migrated, null, 2)}\n`, 0o600);
            validPlanIds = new Set(migrated.plans.map((plan) => plan.id));
          }
        }
        if (validPlanIds) {
          const entries = await readdir(secretsDirectory, { withFileTypes: true });
          await Promise.all(entries.map(async (entry) => {
            const match = entry.isFile() ? entry.name.match(/^([a-z0-9-]+)\.json$/) : undefined;
            if (match && !validPlanIds.has(match[1])) {
              await unlink(path.join(secretsDirectory, entry.name));
            }
          }));
        }
      })().catch((error) => {
        this.initialization = undefined;
        throw error;
      });
    }
    await this.initialization;
  }

  private async exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.queue;
    let release!: () => void;
    this.queue = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }

  private async readState(): Promise<StoreState> {
    await this.initialize();
    const text = await readTextIfExists(this.statePath);
    if (!text) return { version: 4, plans: [], activeTargets: emptyActiveTargets() };
    const parsed = parseJsonObject(text, this.statePath);
    if (parsed.version !== 4 || !Array.isArray(parsed.plans) || !parsed.plans.every(validatePlan)) {
      throw new Error(`Unsupported or corrupt plan store: ${this.statePath}`);
    }
    const plans = parsed.plans.map((plan) => structuredClone(plan));
    return {
      version: 4,
      plans,
      activeTargets: parseActiveTargets(parsed.activeTargets, plans),
    };
  }

  private async writeState(state: StoreState): Promise<void> {
    await atomicWriteFile(this.statePath, `${JSON.stringify(state, null, 2)}\n`, 0o600);
  }

  async listPlans(): Promise<Plan[]> {
    const state = await this.readState();
    return [...state.plans].sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  }

  async getPlan(planId: string): Promise<Plan> {
    const plan = (await this.readState()).plans.find((candidate) => candidate.id === planId);
    if (!plan) throw new Error("Coding Plan not found");
    return plan;
  }

  async getActiveTargets(): Promise<ActiveTargets> {
    return cloneActiveTargets((await this.readState()).activeTargets);
  }

  async markActive(target: Target, planId: string): Promise<void> {
    await this.exclusive(async () => {
      const state = await this.readState();
      const plan = referencedPlan(state.plans, planId);
      if (!plan) throw new Error("Coding Plan not found");
      setActiveTarget(state.activeTargets, target, plan);
      await this.writeState(state);
    });
  }

  private async readSecretFile(planId: string): Promise<PlanSecret> {
    const text = await readTextIfExists(this.secretPath(planId), MAX_SECRET_FILE_BYTES);
    if (!text) throw new Error("Coding Plan credential is missing");
    const parsed = parseJsonObject(text, "Coding Plan credential");
    if (parsed.kind === "api-key" && typeof parsed.apiKey === "string" && parsed.apiKey) {
      return { kind: "api-key", apiKey: parsed.apiKey };
    }
    if (parsed.kind === "codex-auth" && isObject(parsed.auth)) {
      codexTokens(parsed.auth);
      return { kind: "codex-auth", auth: parsed.auth };
    }
    throw new Error("Coding Plan credential has an unsupported format");
  }

  async readSecret(planId: string): Promise<PlanSecret> {
    return this.readSecretFile(planId);
  }

  private async newerCodexSource(plan: Plan, secret: CodexSecret): Promise<CodexSecret> {
    if (!plan.authFilePath) return secret;
    try {
      const sourceText = await readTextIfExists(plan.authFilePath, 1024 * 1024);
      if (!sourceText) return secret;
      const source = parseJsonObject(sourceText, "Codex auth.json");
      codexTokens(source);
      const storedIdentity = codexIdentity(secret.auth);
      const sourceIdentity = codexIdentity(source);
      if (!storedIdentity || !sourceIdentity || storedIdentity !== sourceIdentity) return secret;
      if (codexGeneration(source) <= codexGeneration(secret.auth)) return secret;
      const sourceTokens = codexTokens(source);
      if (plan.accountId) sourceTokens.account_id = plan.accountId;
      return { kind: "codex-auth", auth: source };
    } catch {
      return secret;
    }
  }

  private async syncCodexSource(plan: Plan, secret: CodexSecret): Promise<CodexSecret> {
    const next = await this.newerCodexSource(plan, secret);
    if (next !== secret) {
      await atomicWriteFile(this.secretPath(plan.id), serializeSecret(next), 0o600);
    }
    return next;
  }

  async syncCodexSecretFromSource(planId: string): Promise<CodexSecret> {
    return this.exclusive(async () => {
      const state = await this.readState();
      const plan = state.plans.find((candidate) => candidate.id === planId);
      if (!plan || plan.provider !== "codex") throw new Error("Codex plan not found");
      const secret = await this.readSecretFile(planId);
      if (secret.kind !== "codex-auth") throw new Error("Codex credential is missing");
      return this.syncCodexSource(plan, secret);
    });
  }

  async withPlanForApply<T>(
    planId: string,
    target: Target,
    operation: (plan: Plan, secret: PlanSecret) => Promise<{
      result: T;
      applied: boolean;
      updatedSecret?: PlanSecret;
    }>,
  ): Promise<T> {
    return this.exclusive(async () => {
      const state = await this.readState();
      const plan = state.plans.find((candidate) => candidate.id === planId);
      if (!plan) throw new Error("Coding Plan not found");
      let secret = await this.readSecretFile(planId);
      if (plan.provider === "codex") {
        if (secret.kind !== "codex-auth") throw new Error("Codex credential is missing");
        secret = await this.syncCodexSource(plan, secret);
      }
      const outcome = await operation(plan, secret);
      if (outcome.updatedSecret) {
        await atomicWriteFile(
          this.secretPath(plan.id),
          serializeSecret(outcome.updatedSecret),
          0o600,
        );
      } else if (outcome.applied && secret.kind === "codex-auth") {
        await atomicWriteFile(
          this.secretPath(plan.id),
          serializeSecret(secret),
          0o600,
        );
      }
      if (outcome.applied) {
        setActiveTarget(state.activeTargets, target, plan);
        await this.writeState(state);
      }
      return outcome.result;
    });
  }

  async replaceCodexSecret(planId: string, auth: Record<string, unknown>): Promise<void> {
    codexTokens(auth);
    await this.exclusive(async () => {
      const plan = (await this.readState()).plans.find((candidate) => candidate.id === planId);
      if (!plan || plan.provider !== "codex") throw new Error("Plan is not a Codex plan");
      await atomicWriteFile(
        this.secretPath(planId),
        serializeSecret({ kind: "codex-auth", auth }),
        0o600,
      );
    });
  }

  async savePlan(input: SavePlanInput): Promise<Plan> {
    return this.exclusive(async () => {
      const state = await this.readState();
      const existing = input.id
        ? state.plans.find((candidate) => candidate.id === input.id)
        : undefined;
      if (input.id && !existing) throw new Error("Coding Plan not found");
      let storedSecret: PlanSecret | undefined;
      if (existing) {
        try {
          storedSecret = await this.readSecretFile(existing.id);
        } catch {
          // A replacement credential below can repair a missing or corrupt secret.
        }
      }

      const id = existing?.id ?? `${input.provider}-${randomUUID()}`;
      let secret: PlanSecret;
      let authFilePath: string | undefined;
      let accountId: string | undefined;
      let region: ZhipuRegion | undefined;

      if (input.provider === "codex") {
        let current: CodexSecret | undefined;
        if (existing?.provider === "codex") {
          const stored = storedSecret;
          if (!stored || stored.kind !== "codex-auth") throw new Error("Codex credential is missing");
          current = await this.newerCodexSource(existing, stored);
        }

        const authMode = input.codexAuthMode ?? (
          input.authJsonContent?.trim()
            ? "content"
            : input.authFilePath?.trim()
              ? "path"
              : existing
                ? existing.authFilePath ? "path" : "content"
                : "path"
        );
        let auth: Record<string, unknown>;
        if (authMode === "content") {
          if (input.authJsonContent?.trim()) {
            auth = parseJsonObject(input.authJsonContent, "Codex auth.json content");
          } else if (current) {
            auth = structuredClone(current.auth);
          } else {
            throw new Error("Enter the contents of Codex auth.json");
          }
        } else {
          const requestedPath = input.authFilePath?.trim() || existing?.authFilePath;
          if (!requestedPath && existing) {
            throw new Error("Enter the path to Codex auth.json");
          }
          authFilePath = expandHome(requestedPath || defaultCodexAuthPath());
          const text = await readTextIfExists(authFilePath, 1024 * 1024);
          const unchangedExistingPath = current && existing?.authFilePath &&
            expandHome(existing.authFilePath) === authFilePath;
          if (text) {
            auth = parseJsonObject(text, "Codex auth.json");
          } else if (unchangedExistingPath && current) {
            auth = structuredClone(current.auth);
          } else {
            throw new Error(`Codex auth file not found: ${authFilePath}`);
          }
        }

        const tokens = codexTokens(auth);
        accountId = input.accountId?.trim() || codexAccountId(auth);
        if (accountId) tokens.account_id = accountId;
        secret = { kind: "codex-auth", auth };
        if (current) {
          if (
            codexIdentity(current.auth) &&
            codexIdentity(current.auth) === codexIdentity(auth) &&
            codexGeneration(current.auth) > codexGeneration(auth)
          ) {
            const preserved = structuredClone(current.auth);
            const preservedTokens = codexTokens(preserved);
            if (accountId) preservedTokens.account_id = accountId;
            secret = { kind: "codex-auth", auth: preserved };
          }
        }
      } else {
        const providedKey = input.apiKey?.trim();
        if (providedKey) {
          secret = { kind: "api-key", apiKey: providedKey };
        } else if (existing?.provider === input.provider) {
          const current = storedSecret;
          if (!current || current.kind !== "api-key") throw new Error("Enter an API key for this plan");
          secret = current;
        } else {
          throw new Error("Enter an API key for this plan");
        }
        if (input.provider === "zhipu") region = input.region ?? existing?.region ?? "cn";
      }

      const now = new Date().toISOString();
      const plan: Plan = {
        id,
        label: input.label.trim(),
        provider: input.provider,
        credentialHint: credentialHint(input.provider, secret, accountId),
        useProxy: input.useProxy ?? (
          existing?.provider === input.provider
            ? existing.useProxy
            : input.provider === "codex"
        ),
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
        ...(region ? { region } : {}),
        ...(authFilePath ? { authFilePath } : {}),
        ...(accountId ? { accountId } : {}),
      };

      const secretPath = this.secretPath(id);
      const previousSecret = await captureFile(secretPath);
      const clearUsage = Boolean(existing && (
        existing.provider !== plan.provider ||
        existing.region !== plan.region ||
        !storedSecret ||
        serializeSecret(storedSecret) !== serializeSecret(secret)
      ));
      const previousUsage = clearUsage ? await this.readUsageCache() : undefined;
      await atomicWriteFile(secretPath, serializeSecret(secret), 0o600);
      const index = state.plans.findIndex((candidate) => candidate.id === id);
      if (index >= 0) state.plans[index] = plan;
      else state.plans.push(plan);
      if (existing) clearActivePlan(state.activeTargets, id);
      try {
        if (previousUsage) {
          await this.writeUsageCache(previousUsage.filter((snapshot) => snapshot.planId !== id));
        }
        await this.writeState(state);
      } catch (error) {
        const rollbackErrors: unknown[] = [];
        try {
          await restoreFile(secretPath, previousSecret);
        } catch (rollbackError) {
          rollbackErrors.push(rollbackError);
        }
        if (previousUsage) {
          try {
            await this.writeUsageCache(previousUsage);
          } catch (rollbackError) {
            rollbackErrors.push(rollbackError);
          }
        }
        if (rollbackErrors.length) {
          throw new AggregateError(
            [error, ...rollbackErrors],
            "Failed to save Coding Plan metadata and restore cached data",
          );
        }
        throw error;
      }
      return plan;
    });
  }

  async deletePlan(planId: string): Promise<boolean> {
    return this.exclusive(async () => {
      const state = await this.readState();
      const nextPlans = state.plans.filter((plan) => plan.id !== planId);
      const existed = nextPlans.length !== state.plans.length;
      state.plans = nextPlans;
      clearActivePlan(state.activeTargets, planId);
      await this.writeState(state);
      await unlink(this.secretPath(planId)).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error;
      });

      const usage = (await this.readUsageCache()).filter((snapshot) => snapshot.planId !== planId);
      await this.writeUsageCache(usage);
      return existed;
    });
  }

  async readUsageCache(): Promise<UsageSnapshot[]> {
    const text = await readTextIfExists(this.usagePath);
    if (!text) return [];
    const parsed: unknown = JSON.parse(text);
    if (!Array.isArray(parsed) || !parsed.every(validateUsage)) {
      throw new Error(`Corrupt usage cache: ${this.usagePath}`);
    }
    return parsed;
  }

  async writeUsageCache(usage: UsageSnapshot[]): Promise<void> {
    await this.initialize();
    await atomicWriteFile(this.usagePath, `${JSON.stringify(usage, null, 2)}\n`, 0o600);
  }

  async mergeUsageCache(
    usage: UsageSnapshot[],
    expectedUpdatedAt: ReadonlyMap<string, string>,
  ): Promise<Set<string>> {
    return this.exclusive(async () => {
      const state = await this.readState();
      const validPlans = new Set(
        state.plans
          .filter((plan) => expectedUpdatedAt.get(plan.id) === plan.updatedAt)
          .map((plan) => plan.id),
      );
      const merged = new Map((await this.readUsageCache()).map((snapshot) => [snapshot.planId, snapshot]));
      for (const snapshot of usage) {
        if (validPlans.has(snapshot.planId)) {
          merged.set(snapshot.planId, mergeCachedUsage(merged.get(snapshot.planId), snapshot));
        }
      }
      const currentPlanIds = new Set(state.plans.map((plan) => plan.id));
      await this.writeUsageCache(
        [...merged.values()].filter((snapshot) => currentPlanIds.has(snapshot.planId)),
      );
      return validPlans;
    });
  }

  async snapshotPlans(planId?: string): Promise<PlanSnapshot[]> {
    return this.exclusive(async () => {
      const state = await this.readState();
      const plans = planId
        ? state.plans.filter((plan) => plan.id === planId)
        : state.plans;
      if (planId && plans.length === 0) throw new Error("Coding Plan not found");
      const snapshots: PlanSnapshot[] = [];
      for (const plan of plans) {
        let secret = await this.readSecretFile(plan.id);
        if (plan.provider === "codex") {
          if (secret.kind !== "codex-auth") throw new Error("Codex credential is missing");
          secret = await this.syncCodexSource(plan, secret);
        }
        snapshots.push({ plan: structuredClone(plan), secret: structuredClone(secret) });
      }
      return snapshots.sort((left, right) => left.plan.createdAt.localeCompare(right.plan.createdAt));
    });
  }
}

export const planStore = new PlanStore();
