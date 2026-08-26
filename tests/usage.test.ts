import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { PlanStore } from "../store.server";
import {
  appendKimiQuotaHistory,
  normalizeCodexUsage,
  normalizeCodexTokenActivity,
  normalizeKimiUsage,
  normalizeZhipuTokenActivity,
  normalizeZhipuUsage,
  refreshUsageSnapshots,
} from "../usage.server";

test("normalizes Codex primary, secondary, and additional windows", () => {
  const result = normalizeCodexUsage(
    {
      plan_type: "pro",
      rate_limit: {
        primary_window: {
          used_percent: 24,
          limit_window_seconds: 18_000,
          reset_at: 1_800_000_000,
        },
        secondary_window: {
          used_percent: 61.5,
          limit_window_seconds: 604_800,
          reset_at: 1_800_100_000,
        },
      },
      additional_rate_limits: [
        {
          limit_name: "Codex Spark",
          rate_limit: {
            primary_window: {
              used_percent: 9,
              limit_window_seconds: 3_600,
              reset_at: 1_800_000_100,
            },
          },
        },
      ],
      credits: { balance: "12.50" },
    },
    "codex-1",
  );

  assert.equal(result.planTier, "pro");
  assert.equal(result.balance, "12.50");
  assert.equal(result.windows.length, 3);
  assert.equal(result.windows[0].label, "5 小时");
  assert.equal(result.windows[1].label, "1 周");
  assert.equal(result.windows[1].usedPercent, 61.5);
  assert.match(result.windows[2].label, /Codex Spark/);
  assert.equal(result.windows[0].resetAt, "2027-01-15T08:00:00.000Z");
});

test("normalizes Codex individual spend controls and reached-only responses", () => {
  const result = normalizeCodexUsage(
    {
      plan_type: "business",
      spend_control: {
        reached: false,
        individual_limit: {
          limit: "11450",
          used: "4522.35",
          remaining: "6927.65",
          used_percent: 39,
          reset_at: 1_800_000_000,
        },
      },
    },
    "codex-business",
  );

  assert.deepEqual(result.windows, [{
    id: "spend-control",
    label: "个人额度",
    usedPercent: 39,
    used: "4522.35",
    limit: "11450",
    remaining: "6927.65",
    resetAt: "2027-01-15T08:00:00.000Z",
  }]);

  const reached = normalizeCodexUsage(
    { spendControl: { reached: true, individualLimit: null } },
    "codex-reached",
  );
  assert.deepEqual(reached.windows, [{
    id: "spend-control",
    label: "个人额度",
    usedPercent: 100,
  }]);

  const scalarLimit = normalizeCodexUsage(
    { plan_type: "business", spend_control: { reached: false, individual_limit: "50" } },
    "codex-scalar-limit",
  );
  assert.deepEqual(scalarLimit.windows, [{
    id: "spend-control",
    label: "个人额度",
    limit: "50",
  }]);
});

test("normalizes both GLM token windows and MCP quota", () => {
  const result = normalizeZhipuUsage(
    {
      success: true,
      code: 200,
      data: {
        level: "max",
        limits: [
          { type: "TOKENS_LIMIT", percentage: 10, nextResetTime: 1_800_000_000_000 },
          { type: "TOKENS_LIMIT", percentage: 42, nextResetTime: 1_800_100_000_000 },
          {
            type: "TIME_LIMIT",
            percentage: 25,
            currentValue: 5,
            usage: 20,
            remaining: 15,
            nextResetTime: 1_800_200_000_000,
          },
        ],
      },
    },
    "glm-1",
  );

  assert.equal(result.planTier, "max");
  assert.deepEqual(result.windows.map((window) => window.label), ["5 小时", "每周", "MCP 月度"]);
  assert.equal(result.windows[2].used, "5");
  assert.equal(result.windows[2].limit, "20");
  assert.equal(result.windows[2].remaining, "15");
});

test("classifies current GLM credit windows by unit instead of array order", () => {
  const result = normalizeZhipuUsage(
    {
      code: 200,
      data: {
        planName: "max",
        limits: [
          {
            type: "CREDIT_LIMIT",
            unit: 6,
            number: 1,
            usage: 140000,
            currentValue: 52000,
            remaining: 88000,
            percentage: 37,
            nextResetTime: 1_800_100_000_000,
          },
          {
            type: "CREDIT_LIMIT",
            unit: 3,
            number: 5,
            usage: 28000,
            currentValue: 7280,
            remaining: 20720,
            percentage: 26,
            nextResetTime: 1_800_000_000_000,
          },
        ],
      },
    },
    "glm-credit",
  );

  assert.equal(result.planTier, "max");
  assert.deepEqual(result.windows.map((window) => window.label), ["5 小时", "每周"]);
  assert.equal(result.windows[0].limit, "28000");
  assert.equal(result.windows[1].used, "52000");
});

test("normalizes Kimi weekly and all rate windows", () => {
  const result = normalizeKimiUsage(
    {
      usage: {
        used: "2500",
        limit: "10000",
        remaining: "7500",
        resetTime: "2027-01-01T00:00:00.123456789Z",
      },
      limits: [
        {
          window: { duration: 300, timeUnit: "TIME_UNIT_MINUTE" },
          detail: { remaining: "80", limit: "100", resetTime: "2027-01-01T01:00:00Z" },
        },
        {
          window: { duration: 1, timeUnit: "minute" },
          detail: { used: "3", limit: "10", resetTime: "2027-01-01T00:01:00Z" },
        },
      ],
      parallel: { limit: "4" },
    },
    "kimi-1",
  );

  assert.equal(result.parallelLimit, "4");
  assert.equal(result.windows.length, 3);
  assert.deepEqual(result.windows.map((window) => window.label), ["5 小时", "1 分钟", "每周"]);
  assert.equal(result.windows[0].usedPercent, 20);
  assert.equal(result.windows[1].usedPercent, 30);
  assert.equal(result.windows[2].usedPercent, 25);
  assert.equal(result.windows[2].resetAt, "2027-01-01T00:00:00.123Z");
});

test("rejects failed GLM envelopes", () => {
  assert.throws(
    () => normalizeZhipuUsage({ success: false, code: 401, data: {} }, "glm-1"),
    /rejected/,
  );
});

test("normalizes Codex daily token activity and merges duplicate dates", () => {
  const result = normalizeCodexTokenActivity({
    stats: {
      lifetime_tokens: 1000,
      daily_usage_buckets: [
        { start_date: "2026-08-24", tokens: 120 },
        { startDate: "2026-08-24", tokens: 30 },
        { start_date: "2026-08-25", tokens: "250" },
        { start_date: "invalid", tokens: 999 },
      ],
    },
  });

  assert.deepEqual(result, {
    source: "provider",
    granularity: "day",
    points: [
      { date: "2026-08-24", tokens: 150 },
      { date: "2026-08-25", tokens: 250 },
    ],
  });
});

test("accepts top-level Codex buckets but preserves cache on omitted or failed stats", () => {
  const topLevel = normalizeCodexTokenActivity({
    stats: { lifetime_tokens: 500 },
    daily_usage_buckets: [{ start_date: "2026-08-25", tokens: 500 }],
  });
  assert.deepEqual(topLevel.points, [{ date: "2026-08-25", tokens: 500 }]);
  assert.deepEqual(normalizeCodexTokenActivity({ stats: { daily_usage_buckets: null } }).points, []);
  assert.throws(
    () => normalizeCodexTokenActivity({ stats: { lifetime_tokens: 500 } }),
    /omitted daily buckets/,
  );
  assert.throws(
    () => normalizeCodexTokenActivity({
      metadata: { stats_error: "temporarily unavailable" },
      stats: { daily_usage_buckets: [] },
    }),
    /temporarily unavailable/,
  );
});

test("aggregates GLM hourly token and call buckets by calendar day", () => {
  const result = normalizeZhipuTokenActivity({
    code: 200,
    data: {
      x_time: [
        "2026-08-24 09:00:00",
        "2026-08-24 10:00:00",
        "2026-08-25 09:00:00",
      ],
      tokensUsage: [100, "250", 400],
      modelCallCount: [1, 2, 4],
    },
  });

  assert.deepEqual(result.points, [
    { date: "2026-08-24", tokens: 350, calls: 3 },
    { date: "2026-08-25", tokens: 400, calls: 4 },
  ]);
});

test("samples Kimi quota at most every five minutes and marks resets", () => {
  const start = Date.parse("2026-08-25T00:00:00.000Z");
  const kimiSnapshot = (used: number, resetTime: string) => normalizeKimiUsage({
    usage: { used, limit: 100, resetTime },
  }, "kimi-history");

  const first = appendKimiQuotaHistory(
    kimiSnapshot(10, "2026-09-01T00:00:00.000Z"),
    undefined,
    start,
  );
  assert.equal(first.quotaHistory?.points.length, 1);
  assert.equal(first.quotaHistory?.points[0].windows[0].usedPercent, 10);

  const throttled = appendKimiQuotaHistory(
    kimiSnapshot(20, "2026-09-01T00:00:00.000Z"),
    first,
    start + 4 * 60_000,
  );
  assert.equal(throttled.quotaHistory?.points.length, 1);

  const second = appendKimiQuotaHistory(
    kimiSnapshot(25, "2026-09-01T00:00:00.000Z"),
    throttled,
    start + 5 * 60_000,
  );
  assert.equal(second.quotaHistory?.points.length, 2);
  assert.equal(second.quotaHistory?.points[1].windows[0].reset, undefined);

  const reset = appendKimiQuotaHistory(
    kimiSnapshot(3, "2026-09-08T00:00:00.000Z"),
    second,
    start + 10 * 60_000,
  );
  assert.equal(reset.quotaHistory?.points.length, 3);
  assert.equal(reset.quotaHistory?.points[2].windows[0].usedPercent, 3);
  assert.equal(reset.quotaHistory?.points[2].windows[0].reset, true);
});

test("uses stable Kimi rate-window IDs and ignores small reset-time jitter", () => {
  const fiveHour = {
    window: { duration: 300, timeUnit: "TIME_UNIT_MINUTE" },
    detail: { used: 20, limit: 100, resetTime: "2026-08-25T05:00:00.000Z" },
  };
  const oneMinute = {
    window: { duration: 1, timeUnit: "TIME_UNIT_MINUTE" },
    detail: { used: 1, limit: 10, resetTime: "2026-08-25T00:01:00.000Z" },
  };
  const firstOrder = normalizeKimiUsage({ limits: [fiveHour, oneMinute] }, "kimi-stable");
  const secondOrder = normalizeKimiUsage({ limits: [oneMinute, fiveHour] }, "kimi-stable");
  assert.deepEqual(
    new Map(firstOrder.windows.map((window) => [window.label, window.id])),
    new Map(secondOrder.windows.map((window) => [window.label, window.id])),
  );
  assert.equal(firstOrder.windows[0].id, "window-5-hour");

  const start = Date.parse("2026-08-25T00:00:00.000Z");
  const initial = appendKimiQuotaHistory(firstOrder, undefined, start);
  const jittered = normalizeKimiUsage({
    limits: [{
      ...fiveHour,
      detail: { ...fiveHour.detail, used: 30, resetTime: "2026-08-25T05:00:30.000Z" },
    }],
  }, "kimi-stable");
  const next = appendKimiQuotaHistory(jittered, initial, start + 5 * 60_000);
  assert.equal(next.quotaHistory?.points[1].windows[0].reset, undefined);
});

test("enforces the refresh deadline before snapshot work", async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), "coding-plan-refresh-deadline-"));
  try {
    const store = new PlanStore(root);
    const plan = await store.savePlan({
      label: "Deadline",
      provider: "kimi",
      apiKey: "valid-request-value",
    });
    let first = true;
    context.mock.method(Date, "now", () => {
      if (first) {
        first = false;
        return 0;
      }
      return 29_000;
    });

    await assert.rejects(
      refreshUsageSnapshots(plan.id, store),
      /Usage refresh deadline exceeded/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects deadline results before returning unvalidated Plan revisions", async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), "coding-plan-refresh-revision-deadline-"));
  try {
    const store = new PlanStore(root);
    const plan = await store.savePlan({
      label: "Deadline revision",
      provider: "kimi",
      apiKey: "credential-before-corruption",
    });
    await writeFile(path.join(root, "secrets", `${plan.id}.json`), "{not-json\n");
    const times = [0, 0, 0, 24_000];
    context.mock.method(Date, "now", () => times.shift() ?? 24_000);

    await assert.rejects(
      refreshUsageSnapshots(plan.id, store),
      /Usage refresh deadline exceeded/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("isolates broken secrets and redacts CR/LF request failures", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "coding-plan-header-safety-"));
  try {
    const store = new PlanStore(root);
    const damaged = await store.savePlan({
      label: "Damaged credential",
      provider: "kimi",
      apiKey: "damaged-before-corruption",
    });
    await writeFile(path.join(root, "secrets", `${damaged.id}.json`), "{not-json\n");
    const secret = "safe-prefix\r\nAuthorization: Bearer leaked-secret";
    const plan = await store.savePlan({
      label: "Invalid header",
      provider: "kimi",
      apiKey: secret,
    });

    const results = await refreshUsageSnapshots(undefined, store);
    const damagedResult = results.find((result) => result.planId === damaged.id);
    const result = results.find((candidate) => candidate.planId === plan.id);
    assert.equal(damagedResult?.status, "error");
    assert.match(damagedResult?.error ?? "", /not valid JSON/);
    assert.ok(result);
    assert.equal(result.status, "error");
    assert.equal(result.error, "Provider credential contains invalid line breaks");
    assert.doesNotMatch(result.error ?? "", /safe-prefix|leaked-secret|Authorization|Bearer/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
