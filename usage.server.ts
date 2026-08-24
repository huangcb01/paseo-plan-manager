import { setTimeout as delay } from "node:timers/promises";
import type { Plan, UsageSnapshot, UsageWindow } from "./plans.shared";
import {
  codexAccountId,
  codexTokens,
  parseJwtPayload,
  type PlanSecret,
  type PlanStore,
  planStore,
} from "./store.server";

const MAX_RESPONSE_BYTES = 1024 * 1024;
const REQUEST_TIMEOUT_MS = 6_000;
const REFRESH_BUDGET_MS = 24_000;

class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly retryAfterMs?: number,
  ) {
    super(status === 401 || status === 403 ? "Authentication failed" : `Provider returned HTTP ${status}`);
  }
}

class ProviderPayloadError extends Error {}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function valueAt(object: Record<string, unknown>, ...keys: string[]): unknown {
  for (const key of keys) {
    if (object[key] !== undefined && object[key] !== null) return object[key];
  }
  return undefined;
}

function stringValue(value: unknown): string | undefined {
  if (typeof value === "string" && value.length > 0) return value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return undefined;
}

function numberValue(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function clampPercent(value: number | undefined): number | undefined {
  return value === undefined ? undefined : Math.max(0, Math.min(100, value));
}

function percentFrom(used: string | undefined, limit: string | undefined): number | undefined {
  const usedNumber = numberValue(used);
  const limitNumber = numberValue(limit);
  if (usedNumber === undefined || limitNumber === undefined || limitNumber <= 0) return undefined;
  return clampPercent((usedNumber / limitNumber) * 100);
}

function timestampIso(value: unknown, unit: "seconds" | "milliseconds" | "iso"): string | undefined {
  let milliseconds: number | undefined;
  if (unit === "iso" && typeof value === "string") {
    const normalized = value.replace(/(\.\d{3})\d+(Z|[+-]\d\d:\d\d)$/, "$1$2");
    milliseconds = Date.parse(normalized);
  } else {
    const numeric = numberValue(value);
    if (numeric !== undefined) milliseconds = unit === "seconds" ? numeric * 1000 : numeric;
  }
  if (milliseconds === undefined || !Number.isFinite(milliseconds)) return undefined;
  return new Date(milliseconds).toISOString();
}

function durationLabel(seconds: number | undefined, fallback: string): string {
  if (!seconds || seconds <= 0) return fallback;
  if (seconds % 604800 === 0) return `${seconds / 604800} 周`;
  if (seconds % 86400 === 0) return `${seconds / 86400} 天`;
  if (seconds % 3600 === 0) return `${seconds / 3600} 小时`;
  if (seconds % 60 === 0) return `${seconds / 60} 分钟`;
  return fallback;
}

async function readResponseJson(response: Response): Promise<unknown> {
  if (!response.body) throw new ProviderPayloadError("Provider returned an empty response");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_RESPONSE_BYTES) {
      await reader.cancel();
      throw new ProviderPayloadError("Provider response exceeded the size limit");
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new ProviderPayloadError("Provider returned invalid JSON");
  }
}

async function fetchJson(
  urlText: string,
  headers: Record<string, string>,
  allowedHosts: readonly string[],
  deadline: number,
): Promise<unknown> {
  const url = new URL(urlText);
  if (
    url.protocol !== "https:" ||
    !allowedHosts.includes(url.hostname) ||
    (url.port && url.port !== "443") ||
    url.username ||
    url.password
  ) {
    throw new Error("Refusing an unexpected provider URL");
  }

  let lastError: unknown;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error("Usage refresh deadline exceeded");
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), Math.min(REQUEST_TIMEOUT_MS, remaining));
    try {
      const response = await fetch(url, {
        method: "GET",
        headers,
        redirect: "manual",
        signal: controller.signal,
      });
      if (response.status < 200 || response.status >= 300) {
        await response.body?.cancel();
        const retryAfter = response.headers.get("retry-after");
        const retryAfterMs = retryAfter && /^\d+$/.test(retryAfter)
          ? Number(retryAfter) * 1000
          : undefined;
        throw new HttpError(response.status, retryAfterMs);
      }
      return await readResponseJson(response);
    } catch (error) {
      lastError = error;
      const status = error instanceof HttpError ? error.status : undefined;
      const retryable = !(error instanceof ProviderPayloadError) &&
        (status === 429 || (status !== undefined && status >= 500) || status === undefined);
      if (!retryable || attempt === 1 || Date.now() >= deadline) break;
      const wait = error instanceof HttpError && error.retryAfterMs !== undefined
        ? Math.min(error.retryAfterMs, 10_000)
        : 400 * 2 ** attempt + Math.floor(Math.random() * 200);
      await delay(Math.min(wait, Math.max(0, deadline - Date.now())));
    } finally {
      clearTimeout(timeout);
    }
  }

  if ((lastError as Error)?.name === "AbortError") throw new Error("Provider request timed out");
  throw lastError instanceof Error ? lastError : new Error("Provider request failed");
}

function codexWindow(
  raw: unknown,
  id: string,
  fallbackLabel: string,
): UsageWindow | undefined {
  if (!isObject(raw)) return undefined;
  const windowSeconds = numberValue(valueAt(raw, "limit_window_seconds", "limitWindowSeconds"));
  const resetAt = timestampIso(valueAt(raw, "reset_at", "resetAt"), "seconds") ?? (() => {
    const after = numberValue(valueAt(raw, "reset_after_seconds", "resetAfterSeconds"));
    return after === undefined ? undefined : new Date(Date.now() + after * 1000).toISOString();
  })();
  const usedPercent = clampPercent(numberValue(valueAt(raw, "used_percent", "usedPercent")));
  return {
    id,
    label: durationLabel(windowSeconds, fallbackLabel),
    ...(usedPercent !== undefined ? { usedPercent } : {}),
    ...(resetAt ? { resetAt } : {}),
    ...(windowSeconds !== undefined ? { windowSeconds } : {}),
  };
}

export function normalizeCodexUsage(raw: unknown, planId: string): UsageSnapshot {
  if (!isObject(raw)) throw new Error("Codex usage response has an unexpected shape");
  if (raw.error !== undefined) throw new Error("Codex usage API rejected the request");
  if (
    valueAt(raw, "plan_type", "planType") === undefined &&
    valueAt(raw, "rate_limit", "rateLimit") === undefined &&
    raw.credits === undefined
  ) {
    throw new Error("Codex usage response does not contain quota data");
  }
  const windows: UsageWindow[] = [];
  const rateLimit = valueAt(raw, "rate_limit", "rateLimit");
  if (isObject(rateLimit)) {
    const primary = codexWindow(valueAt(rateLimit, "primary_window", "primaryWindow"), "primary", "主窗口");
    const secondary = codexWindow(
      valueAt(rateLimit, "secondary_window", "secondaryWindow"),
      "secondary",
      "次窗口",
    );
    if (primary) windows.push(primary);
    if (secondary) windows.push(secondary);
  }

  const additional = valueAt(raw, "additional_rate_limits", "additionalRateLimits");
  if (Array.isArray(additional)) {
    additional.forEach((entry, index) => {
      if (!isObject(entry)) return;
      const details = valueAt(entry, "rate_limit", "rateLimit");
      const name = stringValue(valueAt(entry, "limit_name", "limitName")) ?? `附加限额 ${index + 1}`;
      if (!isObject(details)) return;
      const primary = codexWindow(
        valueAt(details, "primary_window", "primaryWindow"),
        `additional-${index}-primary`,
        name,
      );
      const secondary = codexWindow(
        valueAt(details, "secondary_window", "secondaryWindow"),
        `additional-${index}-secondary`,
        `${name}（次窗口）`,
      );
      if (primary) windows.push({ ...primary, label: `${name} · ${primary.label}` });
      if (secondary) windows.push({ ...secondary, label: `${name} · ${secondary.label}` });
    });
  }

  const credits = valueAt(raw, "credits");
  const balance = isObject(credits) ? stringValue(credits.balance) : undefined;
  return {
    planId,
    status: "ok",
    stale: false,
    fetchedAt: new Date().toISOString(),
    windows,
    ...(stringValue(valueAt(raw, "plan_type", "planType"))
      ? { planTier: stringValue(valueAt(raw, "plan_type", "planType")) }
      : {}),
    ...(balance ? { balance } : {}),
  };
}

export function normalizeZhipuUsage(raw: unknown, planId: string): UsageSnapshot {
  if (!isObject(raw)) throw new Error("GLM usage response has an unexpected shape");
  if (raw.success === false || (numberValue(raw.code) ?? 200) >= 400) {
    throw new Error("GLM usage API rejected the request");
  }
  const data = isObject(raw.data) ? raw.data : raw;
  if (!Array.isArray(data.limits)) throw new Error("GLM usage response does not contain quota limits");
  const limits = data.limits;
  const quotaWindows: Array<{ window: UsageWindow; unit?: number }> = [];
  const otherWindows: UsageWindow[] = [];
  limits.forEach((entry, index) => {
    if (!isObject(entry)) return;
    const type = (stringValue(entry.type) ?? `LIMIT_${index}`).toUpperCase();
    const unit = numberValue(entry.unit);
    let label = type;
    if (type === "TOKENS_LIMIT" || type === "CREDIT_LIMIT") {
      label = unit === 3 ? "5 小时" : unit === 6 ? "每周" : "额度窗口";
    } else if (type === "TIME_LIMIT") {
      label = "MCP 月度";
    }
    const used = stringValue(valueAt(entry, "currentValue", "current_value"));
    const limit = stringValue(entry.usage);
    const remaining = stringValue(entry.remaining);
    const usedPercent = clampPercent(numberValue(entry.percentage));
    const resetAt = timestampIso(valueAt(entry, "nextResetTime", "next_reset_time"), "milliseconds");
    const window: UsageWindow = {
      id: `${type.toLowerCase()}-${index}`,
      label,
      ...(usedPercent !== undefined ? { usedPercent } : {}),
      ...(used ? { used } : {}),
      ...(limit ? { limit } : {}),
      ...(remaining ? { remaining } : {}),
      ...(resetAt ? { resetAt } : {}),
    };
    if (type === "TOKENS_LIMIT" || type === "CREDIT_LIMIT") quotaWindows.push({ window, unit });
    else otherWindows.push(window);
  });
  const classified = [
    ...quotaWindows.filter((entry) => entry.unit === 3),
    ...quotaWindows.filter((entry) => entry.unit === 6),
    ...quotaWindows.filter((entry) => entry.unit !== 3 && entry.unit !== 6),
  ];
  let fallbackIndex = 0;
  const windows = [
    ...classified.map(({ window, unit }) => {
      if (unit === 3 || unit === 6) return window;
      const label = fallbackIndex === 0 ? "5 小时" : fallbackIndex === 1 ? "每周" : `额度窗口 ${fallbackIndex + 1}`;
      fallbackIndex += 1;
      return { ...window, label };
    }),
    ...otherWindows,
  ];
  return {
    planId,
    status: "ok",
    stale: false,
    fetchedAt: new Date().toISOString(),
    windows,
    ...(stringValue(valueAt(data, "level", "planName"))
      ? { planTier: stringValue(valueAt(data, "level", "planName")) }
      : {}),
  };
}

function kimiReset(value: unknown, detail: Record<string, unknown>): string | undefined {
  const absolute = timestampIso(value, "iso");
  if (absolute) return absolute;
  const relative = numberValue(valueAt(detail, "reset_in", "resetIn", "ttl"));
  return relative === undefined ? undefined : new Date(Date.now() + relative * 1000).toISOString();
}

function kimiWindow(raw: unknown, id: string, fallbackLabel: string): UsageWindow | undefined {
  if (!isObject(raw)) return undefined;
  const detail = isObject(raw.detail) ? raw.detail : raw;
  const used = stringValue(detail.used);
  const limit = stringValue(detail.limit);
  const remaining = stringValue(detail.remaining);
  const resetAt = kimiReset(valueAt(detail, "resetTime", "reset_time", "resetAt", "reset_at"), detail);
  const windowInfo = isObject(raw.window) ? raw.window : undefined;
  const duration = windowInfo ? numberValue(windowInfo.duration) : undefined;
  const unit = windowInfo ? stringValue(valueAt(windowInfo, "timeUnit", "time_unit")) : undefined;
  const label = duration && unit ? `${duration} ${unit}` : fallbackLabel;
  return {
    id,
    label,
    ...(used ? { used } : {}),
    ...(limit ? { limit } : {}),
    ...(remaining ? { remaining } : {}),
    ...(percentFrom(used, limit) !== undefined ? { usedPercent: percentFrom(used, limit) } : {}),
    ...(resetAt ? { resetAt } : {}),
  };
}

export function normalizeKimiUsage(raw: unknown, planId: string): UsageSnapshot {
  if (!isObject(raw)) throw new Error("Kimi usage response has an unexpected shape");
  if (raw.error !== undefined || raw.code === "access_terminated_error") {
    throw new Error("Kimi usage API rejected the request");
  }
  if (raw.usage === undefined && raw.limits === undefined && raw.parallel === undefined) {
    throw new Error("Kimi usage response does not contain quota data");
  }
  const windows: UsageWindow[] = [];
  const weekly = kimiWindow(raw.usage, "weekly", "每周");
  if (weekly) windows.push(weekly);
  if (Array.isArray(raw.limits)) {
    raw.limits.forEach((entry, index) => {
      const window = kimiWindow(entry, `window-${index}`, `限流窗口 ${index + 1}`);
      if (window) windows.push(window);
    });
  }
  const parallel = isObject(raw.parallel) ? stringValue(raw.parallel.limit) : undefined;
  return {
    planId,
    status: "ok",
    stale: false,
    fetchedAt: new Date().toISOString(),
    windows,
    ...(parallel ? { parallelLimit: parallel } : {}),
  };
}

function jwtExpiry(auth: Record<string, unknown>): number | undefined {
  const tokens = codexTokens(auth);
  const claims = parseJwtPayload(typeof tokens.access_token === "string" ? tokens.access_token : undefined);
  const expires = claims ? numberValue(claims.exp) : undefined;
  return expires === undefined ? undefined : expires * 1000;
}

async function fetchPlanUsage(
  plan: Plan,
  secret: PlanSecret,
  deadline: number,
): Promise<UsageSnapshot> {
  if (plan.provider === "codex") {
    if (secret.kind !== "codex-auth") throw new Error("Codex credential is missing");
    const expiresAt = jwtExpiry(secret.auth);
    if (expiresAt !== undefined && expiresAt <= Date.now()) {
      throw new Error("Codex access token has expired; run Codex with this account, then re-import auth.json");
    }
    const tokens = codexTokens(secret.auth);
    const accessToken = String(tokens.access_token);
    const accountId = plan.accountId ?? codexAccountId(secret.auth);
    const idToken = typeof tokens.id_token === "string" ? tokens.id_token : undefined;
    const claims = parseJwtPayload(idToken);
    const namespaced = claims?.["https://api.openai.com/auth"];
    const fedramp = isObject(namespaced) && namespaced.chatgpt_account_is_fedramp === true;
    const raw = await fetchJson(
      "https://chatgpt.com/backend-api/wham/usage",
      {
        Authorization: `Bearer ${accessToken}`,
        "User-Agent": "paseo-coding-plan-manager/0.1.0",
        ...(accountId ? { "ChatGPT-Account-ID": accountId } : {}),
        ...(fedramp ? { "X-OpenAI-Fedramp": "true" } : {}),
      },
      ["chatgpt.com"],
      deadline,
    );
    return normalizeCodexUsage(raw, plan.id);
  }

  if (secret.kind !== "api-key") throw new Error("API key is missing");
  if (plan.provider === "kimi") {
    const raw = await fetchJson(
      "https://api.kimi.com/coding/v1/usages",
      {
        Authorization: `Bearer ${secret.apiKey}`,
        Accept: "application/json",
        "User-Agent": "KimiCLI/1.6 paseo-coding-plan-manager/0.1.0",
      },
      ["api.kimi.com"],
      deadline,
    );
    return normalizeKimiUsage(raw, plan.id);
  }

  const host = plan.region === "global"
    ? "api.z.ai"
    : plan.region === "cn-dev"
      ? "dev.bigmodel.cn"
      : "open.bigmodel.cn";
  const raw = await fetchJson(
    `https://${host}/api/monitor/usage/quota/limit`,
    {
      Authorization: secret.apiKey,
      "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
      Accept: "application/json",
    },
    ["open.bigmodel.cn", "dev.bigmodel.cn", "api.z.ai"],
    deadline,
  );
  return normalizeZhipuUsage(raw, plan.id);
}

function safeError(error: unknown): string {
  const message = error instanceof Error ? error.message : "Usage refresh failed";
  return message.replace(/[\r\n]+/g, " ").slice(0, 300);
}

export async function cachedUsage(store: PlanStore = planStore): Promise<UsageSnapshot[]> {
  const cache = await store.readUsageCache();
  const staleBefore = Date.now() - 90_000;
  return cache.map((snapshot) => ({
    ...snapshot,
    stale: Date.parse(snapshot.fetchedAt) < staleBefore,
  }));
}

export async function refreshUsageSnapshots(
  planId?: string,
  store: PlanStore = planStore,
): Promise<UsageSnapshot[]> {
  const snapshots = await store.snapshotPlans(planId);
  const plans = snapshots.map((snapshot) => snapshot.plan);
  const previous = await store.readUsageCache();
  const previousByPlan = new Map(previous.map((snapshot) => [snapshot.planId, snapshot]));

  const deadline = Date.now() + REFRESH_BUDGET_MS;
  const results = new Array<UsageSnapshot>(snapshots.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(4, snapshots.length) }, async () => {
    while (cursor < snapshots.length) {
      const index = cursor;
      cursor += 1;
      const snapshot = snapshots[index];
      const plan = snapshot.plan;
      try {
        results[index] = await fetchPlanUsage(plan, snapshot.secret, deadline);
      } catch (error) {
        const cached = previousByPlan.get(plan.id);
        if (cached) {
          results[index] = { ...cached, status: "error", stale: true, error: safeError(error) };
          continue;
        }
        results[index] = {
          planId: plan.id,
          status: "error",
          stale: true,
          fetchedAt: new Date().toISOString(),
          windows: [],
          error: safeError(error),
        };
      }
    }
  });
  await Promise.all(workers);

  const startedPlans = new Map(plans.map((plan) => [plan.id, plan.updatedAt]));
  const successful = results.filter((snapshot) => snapshot.status === "ok");
  const currentPlanIds = await store.mergeUsageCache(successful, startedPlans);
  return results.filter((snapshot) => currentPlanIds.has(snapshot.planId));
}
