import assert from "node:assert/strict";
import test from "node:test";
import {
  normalizeCodexUsage,
  normalizeKimiUsage,
  normalizeZhipuUsage,
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
          window: { duration: 5, timeUnit: "hours" },
          detail: { used: "20", limit: "100", resetTime: "2027-01-01T01:00:00Z" },
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
  assert.equal(result.windows[0].usedPercent, 25);
  assert.equal(result.windows[0].resetAt, "2027-01-01T00:00:00.123Z");
  assert.equal(result.windows[1].label, "5 hours");
  assert.equal(result.windows[2].usedPercent, 30);
});

test("rejects failed GLM envelopes", () => {
  assert.throws(
    () => normalizeZhipuUsage({ success: false, code: 401, data: {} }, "glm-1"),
    /rejected/,
  );
});
