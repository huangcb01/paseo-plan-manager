import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { DEFAULT_MAX_FILE_BYTES } from "../file-utils.server";
import type { ActiveTargets, Plan, Provider, Target, UsageSnapshot } from "../plans.shared";
import { PlanStore } from "../store.server";

function storedPlan(id: string, provider: Provider): Plan {
  return {
    id,
    label: `${provider} plan`,
    provider,
    ...(provider === "zhipu" ? { region: "cn" as const } : {}),
    credentialHint: "hidden",
    useProxy: provider === "codex",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

async function writeState(root: string, state: unknown): Promise<void> {
  await mkdir(root, { recursive: true });
  await writeFile(path.join(root, "plans.json"), `${JSON.stringify(state, null, 2)}\n`);
}

async function saveProviderPlan(store: PlanStore, provider: Provider, label: string): Promise<Plan> {
  if (provider === "codex") {
    return store.savePlan({
      label,
      provider,
      codexAuthMode: "content",
      authJsonContent: JSON.stringify({
        tokens: { access_token: "x.e30.x", refresh_token: `${label}-refresh` },
      }),
    });
  }
  return store.savePlan({
    label,
    provider,
    ...(provider === "zhipu" ? { region: "cn" as const } : {}),
    apiKey: `${label}-secret`,
  });
}

async function apply(store: PlanStore, planId: string, target: Target, applied = true): Promise<void> {
  await store.withPlanForApply(planId, target, async () => ({
    result: undefined,
    applied,
  }));
}

test("migrates each v3 OpenCode reference by exact Plan provider metadata", async () => {
  const plans = [
    storedPlan("not-a-provider-hint", "codex"),
    storedPlan("another-opaque-id", "zhipu"),
    storedPlan("final-opaque-id", "kimi"),
  ];

  for (const selected of plans) {
    const root = await mkdtemp(path.join(tmpdir(), "coding-plan-v3-routing-"));
    try {
      await writeState(root, {
        version: 3,
        plans,
        activeTargets: {
          opencode: selected.id,
          codex: plans[1].id,
          claude: "missing-plan",
        },
      });

      const store = new PlanStore(root);
      const active = await store.getActiveTargets();
      const state = JSON.parse(await readFile(path.join(root, "plans.json"), "utf8"));

      assert.equal(state.version, 5);
      assert.deepEqual(active, {
        opencode: {
          codex: selected.provider === "codex" ? selected.id : null,
          zhipu: selected.provider === "zhipu" ? selected.id : null,
          kimi: selected.provider === "kimi" ? selected.id : null,
        },
        ohmypi: { codex: null, zhipu: null, kimi: null },
        codex: plans[1].id,
        claude: null,
      });
      assert.deepEqual(state.activeTargets, active);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
});

test("successful applies coexist by OpenCode provider and replace only the same provider", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "coding-plan-active-apply-"));
  try {
    const store = new PlanStore(root);
    const codex = await saveProviderPlan(store, "codex", "Codex");
    const zhipuOne = await saveProviderPlan(store, "zhipu", "Zhipu one");
    const zhipuTwo = await saveProviderPlan(store, "zhipu", "Zhipu two");
    const kimi = await saveProviderPlan(store, "kimi", "Kimi");

    await apply(store, codex.id, "opencode");
    await apply(store, zhipuOne.id, "opencode");
    await apply(store, kimi.id, "opencode");
    await apply(store, zhipuOne.id, "codex");
    await apply(store, kimi.id, "claude");
    await apply(store, zhipuTwo.id, "opencode");

    const stable = await store.getActiveTargets();
    assert.deepEqual(stable, {
      opencode: { codex: codex.id, zhipu: zhipuTwo.id, kimi: kimi.id },
      ohmypi: { codex: null, zhipu: null, kimi: null },
      codex: zhipuOne.id,
      claude: kimi.id,
    });

    await apply(store, zhipuOne.id, "opencode", false);
    assert.deepEqual(await store.getActiveTargets(), stable);
    await assert.rejects(
      store.withPlanForApply(codex.id, "claude", async () => {
        throw new Error("apply failed");
      }),
      /apply failed/,
    );
    assert.deepEqual(await store.getActiveTargets(), stable);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("editing and deleting clear a Plan from every slot without disturbing other Plans", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "coding-plan-active-clear-"));
  try {
    const store = new PlanStore(root);
    const codex = await saveProviderPlan(store, "codex", "Codex");
    const zhipu = await saveProviderPlan(store, "zhipu", "Zhipu");
    const kimi = await saveProviderPlan(store, "kimi", "Kimi");

    await store.markActive("opencode", codex.id);
    await store.markActive("opencode", zhipu.id);
    await store.markActive("opencode", kimi.id);
    await store.markActive("codex", zhipu.id);
    await store.markActive("claude", kimi.id);
    await store.savePlan({
      id: zhipu.id,
      label: "Zhipu edited",
      provider: "zhipu",
      region: "cn",
    });

    assert.deepEqual(await store.getActiveTargets(), {
      opencode: { codex: codex.id, zhipu: null, kimi: kimi.id },
      ohmypi: { codex: null, zhipu: null, kimi: null },
      codex: null,
      claude: kimi.id,
    });

    await store.markActive("opencode", zhipu.id);
    await store.markActive("codex", codex.id);
    await store.markActive("claude", zhipu.id);
    await store.markActive("ohmypi", zhipu.id);
    await store.markActive("ohmypi", kimi.id);
    assert.equal(await store.deletePlan(zhipu.id), true);
    assert.deepEqual(await store.getActiveTargets(), {
      opencode: { codex: codex.id, zhipu: null, kimi: kimi.id },
      ohmypi: { codex: null, zhipu: null, kimi: kimi.id },
      codex: codex.id,
      claude: null,
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("v4 parsing rejects malformed, dangling, wrong-provider, and ambiguous references", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "coding-plan-v4-safety-"));
  try {
    const plans = [
      storedPlan("official", "codex"),
      storedPlan("glm", "zhipu"),
      storedPlan("moon", "kimi"),
      storedPlan("duplicate", "codex"),
      storedPlan("duplicate", "kimi"),
    ];
    await writeState(root, {
      version: 4,
      plans,
      activeTargets: {
        opencode: { codex: "official", zhipu: "moon", kimi: "missing-plan" },
        codex: 42,
        claude: "duplicate",
      },
    });

    const store = new PlanStore(root);
    const first = await store.getActiveTargets();
    assert.deepEqual(first, {
      opencode: { codex: "official", zhipu: null, kimi: null },
      ohmypi: { codex: null, zhipu: null, kimi: null },
      codex: null,
      claude: null,
    });

    (first as ActiveTargets).opencode.codex = null;
    (first as ActiveTargets).codex = "changed-outside-store";
    const second = await store.getActiveTargets();
    assert.notStrictEqual(first, second);
    assert.notStrictEqual(first.opencode, second.opencode);
    assert.deepEqual(second, {
      opencode: { codex: "official", zhipu: null, kimi: null },
      ohmypi: { codex: null, zhipu: null, kimi: null },
      codex: null,
      claude: null,
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("metadata-only edits preserve local history while credential changes clear it", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "coding-plan-history-edit-"));
  try {
    const store = new PlanStore(root);
    const plan = await saveProviderPlan(store, "kimi", "Kimi history");
    const usage: UsageSnapshot = {
      planId: plan.id,
      status: "ok",
      stale: false,
      fetchedAt: "2026-08-25T00:00:00.000Z",
      windows: [],
      quotaHistory: {
        source: "local",
        intervalSeconds: 300,
        points: [{
          sampledAt: "2026-08-25T00:00:00.000Z",
          windows: [{ id: "weekly", label: "每周", usedPercent: 10 }],
        }],
      },
    };
    await store.writeUsageCache([usage]);

    await store.savePlan({
      id: plan.id,
      label: "Kimi renamed",
      provider: "kimi",
      useProxy: true,
    });
    assert.deepEqual(await store.readUsageCache(), [usage]);

    await store.savePlan({
      id: plan.id,
      label: "Kimi replacement account",
      provider: "kimi",
      apiKey: "replacement-secret",
    });
    assert.deepEqual(await store.readUsageCache(), []);

    await unlink(path.join(root, "secrets", `${plan.id}.json`));
    const repaired = await store.savePlan({
      id: plan.id,
      label: "Kimi repaired",
      provider: "kimi",
      apiKey: "repaired-secret",
    });
    assert.equal(repaired.label, "Kimi repaired");
    assert.equal((await store.readSecret(plan.id)).kind, "api-key");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("cache merges do not roll provider activity or local samples backward", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "coding-plan-history-merge-"));
  try {
    const store = new PlanStore(root);
    const plan = await saveProviderPlan(store, "zhipu", "History merge");
    const expected = new Map([[plan.id, plan.updatedAt]]);
    const firstAt = new Date(Date.now() - 10 * 60_000).toISOString();
    const secondAt = new Date(Date.now() - 5 * 60_000).toISOString();
    const concurrentAt = new Date(Date.parse(secondAt) + 10_000).toISOString();
    const expiredAt = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString();
    const base: UsageSnapshot = {
      planId: plan.id,
      status: "ok",
      stale: false,
      fetchedAt: firstAt,
      windows: [],
      tokenActivity: {
        source: "provider",
        granularity: "day",
        points: [{ date: "2026-08-25", tokens: 500 }],
      },
      tokenActivityStale: false,
      quotaHistory: {
        source: "local",
        intervalSeconds: 300,
        points: [{
          sampledAt: firstAt,
          windows: [{ id: "weekly", label: "每周", usedPercent: 10 }],
        }],
      },
    };
    await store.mergeUsageCache([base], expected);
    await store.mergeUsageCache([{
      ...base,
      fetchedAt: secondAt,
      tokenActivity: {
        source: "provider",
        granularity: "day",
        points: [{ date: "2026-08-25", tokens: 100 }],
      },
      tokenActivityStale: true,
      tokenActivityError: "history request failed",
      quotaHistory: {
        source: "local",
        intervalSeconds: 300,
        points: [
          {
            sampledAt: expiredAt,
            windows: [{ id: "weekly", label: "每周", usedPercent: 5 }],
          },
          {
            sampledAt: secondAt,
            windows: [{ id: "weekly", label: "每周", usedPercent: 15 }],
          },
        ],
      },
    }], expected);

    await store.mergeUsageCache([{
      ...base,
      fetchedAt: firstAt,
      tokenActivity: {
        source: "provider",
        granularity: "day",
        points: [{ date: "2026-08-25", tokens: 50 }],
      },
    }], expected);
    await store.mergeUsageCache([{
      ...base,
      fetchedAt: concurrentAt,
      tokenActivityStale: true,
      tokenActivityError: "overlapping history request failed",
      quotaHistory: {
        source: "local",
        intervalSeconds: 300,
        points: [{
          sampledAt: concurrentAt,
          windows: [{ id: "weekly", label: "每周", usedPercent: 16 }],
        }],
      },
    }], expected);

    const [merged] = await store.readUsageCache();
    assert.equal(merged.tokenActivity?.points[0].tokens, 500);
    assert.equal(merged.tokenActivityStale, true);
    assert.deepEqual(
      merged.quotaHistory?.points.map((point) => point.sampledAt),
      [firstAt, secondAt],
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("usage cache recovers from oversized files and bounds retained history", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "coding-plan-cache-limit-"));
  try {
    const store = new PlanStore(root);
    const usagePath = path.join(root, "usage-cache.json");
    await writeFile(usagePath, Buffer.alloc(DEFAULT_MAX_FILE_BYTES + 1, 0x20));
    assert.deepEqual(await store.readUsageCache(), []);

    const start = Date.parse("2026-01-01T00:00:00.000Z");
    const usage: UsageSnapshot[] = Array.from({ length: 3 }, (_, planIndex) => {
      const points = Array.from({ length: 2_017 }, (_, index) => ({
        sampledAt: new Date(start + index * 5 * 60_000).toISOString(),
        windows: [
          { id: "5h", label: "5 小时", usedPercent: index % 101 },
          { id: "weekly", label: "每周", usedPercent: (index + planIndex) % 101 },
        ],
      }));
      return {
        planId: `large-history-${planIndex}`,
        status: "ok",
        stale: false,
        fetchedAt: points[points.length - 1].sampledAt,
        windows: [],
        quotaHistory: {
          source: "local",
          intervalSeconds: 300,
          points,
        },
      };
    });
    assert.ok(Buffer.byteLength(`${JSON.stringify(usage, null, 2)}\n`) > DEFAULT_MAX_FILE_BYTES);

    await store.writeUsageCache(usage);
    assert.ok((await stat(usagePath)).size <= DEFAULT_MAX_FILE_BYTES);
    const cached = await store.readUsageCache();
    assert.equal(cached.length, usage.length);
    cached.forEach((snapshot, index) => {
      assert.ok((snapshot.quotaHistory?.points.length ?? 0) < 2_017);
      assert.equal(
        snapshot.quotaHistory?.points.at(-1)?.sampledAt,
        usage[index].quotaHistory?.points.at(-1)?.sampledAt,
      );
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("snapshotPlans isolates a damaged credential from healthy Plans", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "coding-plan-snapshot-isolation-"));
  try {
    const store = new PlanStore(root);
    const damaged = await saveProviderPlan(store, "kimi", "Damaged");
    const healthy = await saveProviderPlan(store, "zhipu", "Healthy");
    await writeFile(path.join(root, "secrets", `${damaged.id}.json`), "{not-json\n");

    const snapshots = await store.snapshotPlans();
    const damagedSnapshot = snapshots.find((snapshot) => snapshot.plan.id === damaged.id);
    const healthySnapshot = snapshots.find((snapshot) => snapshot.plan.id === healthy.id);
    assert.ok(damagedSnapshot && "secretError" in damagedSnapshot);
    assert.ok(healthySnapshot && "secret" in healthySnapshot);
    if (healthySnapshot && "secret" in healthySnapshot) {
      assert.deepEqual(healthySnapshot.secret, { kind: "api-key", apiKey: "Healthy-secret" });
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("usage cache bounds non-Kimi history and drops an individually oversized snapshot", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "coding-plan-cache-fallbacks-"));
  try {
    const store = new PlanStore(root);
    const tokenPoints = Array.from({ length: 40_000 }, (_, index) => ({
      date: "2026-01-01",
      tokens: index,
      calls: index,
    }));
    const tokenHeavy: UsageSnapshot = {
      planId: "token-heavy",
      status: "ok",
      stale: false,
      fetchedAt: "2026-01-01T00:00:00.000Z",
      windows: [],
      tokenActivity: {
        source: "provider",
        granularity: "day",
        points: tokenPoints,
      },
    };

    await store.writeUsageCache([tokenHeavy]);
    const [cached] = await store.readUsageCache();
    assert.ok((cached.tokenActivity?.points.length ?? 0) < tokenPoints.length);
    assert.equal(cached.tokenActivity?.points.at(-1)?.tokens, tokenPoints.at(-1)?.tokens);

    const oversized: UsageSnapshot = {
      planId: "oversized-current-window",
      status: "ok",
      stale: false,
      fetchedAt: "2026-01-01T00:00:00.000Z",
      windows: [{ id: "large", label: "x".repeat(DEFAULT_MAX_FILE_BYTES), usedPercent: 1 }],
    };
    await store.writeUsageCache([oversized]);
    assert.deepEqual(await store.readUsageCache(), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
