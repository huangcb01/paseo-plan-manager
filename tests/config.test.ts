import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { parse } from "jsonc-parser";
import {
  patchClaudeSettings,
  patchClaudeState,
  patchCodexConfig,
  patchOpenCodeAuth,
  patchOpenCodeConfig,
  applyPlanToTarget,
} from "../config.server";
import type { Plan } from "../plans.shared";
import { PlanStore, type PlanSecret } from "../store.server";

function plan(provider: Plan["provider"]): Plan {
  return {
    id: `${provider}-1`,
    label: `${provider} plan`,
    provider,
    ...(provider === "zhipu" ? { region: "cn" as const } : {}),
    credentialHint: "hidden",
    useProxy: provider === "codex",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

test("patches one OpenCode provider while preserving comments and unrelated providers", () => {
  const source = `{
  // keep this comment
  "theme": "system",
  "provider": {
    "local": { "npm": "@ai-sdk/openai-compatible", "models": {} },
    "kimi": { "old": true }
  }
}\n`;
  const output = patchOpenCodeConfig(source, plan("kimi"), "kimi-for-coding");
  const parsed = parse(output) as Record<string, any>;

  assert.match(output, /keep this comment/);
  assert.equal(parsed.theme, "system");
  assert.ok(parsed.provider.local);
  assert.equal(parsed.provider.kimi.npm, "@ai-sdk/anthropic");
  assert.equal(parsed.provider.kimi.options.baseURL, "https://api.kimi.com/coding/v1");
  assert.equal(parsed.provider.kimi.options.apiKey, undefined);
  assert.equal(parsed.model, "kimi/kimi-for-coding");
});

test("patches OpenCode auth without deleting another provider", () => {
  const output = patchOpenCodeAuth(
    '{"local":{"type":"api","key":"keep"}}',
    plan("zhipu"),
    { kind: "api-key", apiKey: "secret" },
  );
  const parsed = JSON.parse(output);
  assert.equal(parsed.local.key, "keep");
  assert.deepEqual(parsed.zhipu, { type: "api", key: "secret" });
});

test("converts Codex OAuth auth to the OpenCode OAuth shape", () => {
  const payload = Buffer.from(JSON.stringify({ exp: 1_900_000_000 })).toString("base64url");
  const secret: PlanSecret = {
    kind: "codex-auth",
    auth: {
      tokens: {
        access_token: `x.${payload}.x`,
        refresh_token: "refresh",
        id_token: "x.e30.x",
        account_id: "acct_1",
      },
    },
  };
  const output = patchOpenCodeAuth(undefined, { ...plan("codex"), accountId: "acct_1" }, secret);
  const parsed = JSON.parse(output);
  assert.equal(parsed.openai.type, "oauth");
  assert.equal(parsed.openai.refresh, "refresh");
  assert.equal(parsed.openai.expires, 1_900_000_000_000);
  assert.equal(parsed.openai.accountId, "acct_1");
});

test("patches Codex root selection and replaces only its managed provider block", () => {
  const source = `# user comment
model = "old"

[mcp_servers.files]
command = "files"

# BEGIN paseo-coding-plan-manager
[model_providers.paseo-coding-plan]
base_url = "https://old.example"
# END paseo-coding-plan-manager
`;
  const output = patchCodexConfig(
    source,
    { ...plan("zhipu"), region: "global" },
    "glm-5.2",
    { apiKey: "zai-secret", modelCatalogPath: "/tmp/models.json" },
  );
  assert.match(output, /# user comment/);
  assert.match(output, /\[mcp_servers\.files\]/);
  assert.match(output, /model = "glm-5\.2"/);
  assert.match(output, /model_provider = "paseo-coding-plan"/);
  assert.match(output, /base_url = "https:\/\/api\.z\.ai\/api\/v1"/);
  assert.match(output, /experimental_bearer_token = "zai-secret"/);
  assert.match(output, /requires_openai_auth = false/);
  assert.match(output, /model_catalog_json = "\/tmp\/models\.json"/);
  assert.equal((output.match(/BEGIN paseo-coding-plan-manager/g) ?? []).length, 1);
});

test("patches only Claude env and keeps unrelated settings", () => {
  const source = JSON.stringify({
    permissions: { allow: ["Bash(git:*)"] },
    env: { KEEP_ME: "yes", ANTHROPIC_API_KEY: "old" },
  });
  const output = patchClaudeSettings(source, plan("kimi"), "kimi-secret", "kimi-for-coding");
  const parsed = JSON.parse(output);
  assert.deepEqual(parsed.permissions, { allow: ["Bash(git:*)"] });
  assert.equal(parsed.env.KEEP_ME, "yes");
  assert.equal(parsed.env.ANTHROPIC_AUTH_TOKEN, undefined);
  assert.equal(parsed.env.ANTHROPIC_API_KEY, "kimi-secret");
  assert.equal(parsed.env.ANTHROPIC_BASE_URL, "https://api.kimi.com/coding/");
  assert.equal(parsed.env.ANTHROPIC_DEFAULT_FABLE_MODEL, "kimi-for-coding");
  assert.equal(parsed.env.CLAUDE_CODE_SUBAGENT_MODEL, "kimi-for-coding");
  assert.equal(parsed.env.CLAUDE_CODE_MAX_CONTEXT_TOKENS, "262144");
});

test("refuses Chat-only Coding Plans in a direct Codex projection", () => {
  assert.throws(
    () => patchCodexConfig(undefined, plan("kimi"), "kimi-for-coding", { apiKey: "secret", modelCatalogPath: "/tmp/models.json" }),
    /conversion proxy/,
  );
  assert.throws(
    () => patchCodexConfig(undefined, { ...plan("zhipu"), region: "cn-dev" }, "glm-5.2", { apiKey: "secret", modelCatalogPath: "/tmp/models.json" }),
    /conversion proxy/,
  );
});

test("refuses a direct Codex OAuth projection to Claude Code", () => {
  assert.throws(
    () => patchClaudeSettings(undefined, plan("codex"), "unused", "gpt-5.6-sol"),
    /protocol-conversion proxy/,
  );
});

test("patches Claude onboarding state without deleting unrelated fields", () => {
  const output = patchClaudeState('{"theme":"dark","hasCompletedOnboarding":false}', plan("kimi"));
  assert.deepEqual(JSON.parse(output), {
    theme: "dark",
    hasCompletedOnboarding: true,
    penguinModeOrgEnabled: true,
  });
});

test("writes Claude onboarding state inside a custom CLAUDE_CONFIG_DIR profile", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "coding-plan-claude-"));
  const previousClaudeConfig = process.env.CLAUDE_CONFIG_DIR;
  const profile = path.join(root, "claude-profile");
  process.env.CLAUDE_CONFIG_DIR = profile;
  try {
    await mkdir(profile, { recursive: true });
    const statePath = path.join(profile, ".config.json");
    await writeFile(statePath, '{"keep":"value","hasCompletedOnboarding":false}\n');
    const store = new PlanStore(path.join(root, "store"));
    const saved = await store.savePlan({
      label: "Kimi",
      provider: "kimi",
      apiKey: "kimi-secret",
    });
    const result = await applyPlanToTarget(saved.id, "claude", "kimi-custom-model", store);
    assert.equal(result.applied, true);
    assert.ok(result.configPaths.includes(statePath));
    const state = JSON.parse(await readFile(statePath, "utf8"));
    assert.equal(state.keep, "value");
    assert.equal(state.hasCompletedOnboarding, true);
    assert.equal(state.penguinModeOrgEnabled, true);
    const settings = JSON.parse(await readFile(path.join(profile, "settings.json"), "utf8"));
    assert.equal(settings.env.ANTHROPIC_API_KEY, "kimi-secret");
    assert.equal(settings.env.ANTHROPIC_MODEL, "kimi-custom-model");
  } finally {
    if (previousClaudeConfig === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = previousClaudeConfig;
    await rm(root, { recursive: true, force: true });
  }
});

test("removes the managed bearer token when switching Codex back to OAuth", () => {
  const globalPlan = { ...plan("zhipu"), region: "global" as const };
  const thirdParty = patchCodexConfig(undefined, globalPlan, "glm-5.2", {
    apiKey: "secret",
    modelCatalogPath: "/tmp/models.json",
  });
  const official = patchCodexConfig(thirdParty, plan("codex"), "gpt-5.6-sol");
  assert.doesNotMatch(official, /secret|experimental_bearer_token|model_catalog_json/);
  assert.match(official, /model_provider = "openai"/);
});

test("does not write Chat-only Codex config and keeps Z.AI keys out of auth.json", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "coding-plan-config-"));
  const previousCodexHome = process.env.CODEX_HOME;
  process.env.CODEX_HOME = path.join(root, "codex");
  try {
    const store = new PlanStore(path.join(root, "store"));
    const kimi = await store.savePlan({
      label: "Kimi",
      provider: "kimi",
      apiKey: "kimi-secret",
    });
    const refused = await applyPlanToTarget(kimi.id, "codex", "kimi-for-coding", store);
    assert.equal(refused.applied, false);
    await assert.rejects(stat(path.join(root, "codex", "config.toml")), { code: "ENOENT" });

    const zai = await store.savePlan({
      label: "Z.AI",
      provider: "zhipu",
      region: "global",
      apiKey: "zai-secret",
    });
    const applied = await applyPlanToTarget(zai.id, "codex", "glm-custom-model", store);
    assert.equal(applied.applied, true);
    const config = await readFile(path.join(root, "codex", "config.toml"), "utf8");
    assert.match(config, /model = "glm-custom-model"/);
    assert.match(config, /https:\/\/api\.z\.ai\/api\/v1/);
    assert.match(config, /experimental_bearer_token = "zai-secret"/);
    await assert.rejects(stat(path.join(root, "codex", "auth.json")), { code: "ENOENT" });
  } finally {
    if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previousCodexHome;
    await rm(root, { recursive: true, force: true });
  }
});

test("refuses to overwrite Codex OAuth when a quoted TOML key selects keyring", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "coding-plan-keyring-"));
  const previousCodexHome = process.env.CODEX_HOME;
  process.env.CODEX_HOME = path.join(root, "target-codex");
  try {
    const sourceAuth = path.join(root, "source-auth.json");
    await writeFile(sourceAuth, JSON.stringify({
      tokens: {
        access_token: "x.e30.x",
        refresh_token: "refresh",
        id_token: "x.e30.x",
        account_id: "account",
      },
    }));
    const store = new PlanStore(path.join(root, "store"));
    const codexPlan = await store.savePlan({
      label: "Codex",
      provider: "codex",
      authFilePath: sourceAuth,
    });
    await mkdir(process.env.CODEX_HOME, { recursive: true });
    await writeFile(path.join(process.env.CODEX_HOME, "config.toml"), '"cli_auth_credentials_store" = "keyring"\n');
    const result = await applyPlanToTarget(codexPlan.id, "codex", "gpt-5.6-sol", store);
    assert.equal(result.applied, false);
    assert.match(result.message, /keyring/);
    await assert.rejects(stat(path.join(process.env.CODEX_HOME, "auth.json")), { code: "ENOENT" });
  } finally {
    if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previousCodexHome;
    await rm(root, { recursive: true, force: true });
  }
});

test("imports Codex auth from JSON content and keeps it on an empty edit", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "coding-plan-direct-auth-"));
  const previousCodexHome = process.env.CODEX_HOME;
  process.env.CODEX_HOME = path.join(root, "daemon-codex");
  try {
    const store = new PlanStore(root);
    const auth = {
      tokens: {
        access_token: "x.e30.x",
        refresh_token: "direct-refresh-token",
        id_token: "x.e30.x",
        account_id: "direct-account",
      },
      last_refresh: "2026-01-01T00:00:00.000Z",
    };
    const saved = await store.savePlan({
      label: "Direct Codex",
      provider: "codex",
      codexAuthMode: "content",
      authJsonContent: JSON.stringify(auth),
    });

    assert.equal(saved.authFilePath, undefined);
    assert.equal(saved.accountId, "direct-account");
    assert.equal(saved.useProxy, true);
    assert.equal("authJsonContent" in saved, false);
    assert.deepEqual(await store.readSecret(saved.id), { kind: "codex-auth", auth });

    await mkdir(process.env.CODEX_HOME, { recursive: true });
    await writeFile(path.join(process.env.CODEX_HOME, "auth.json"), JSON.stringify({
      tokens: {
        access_token: "x.e30.x",
        refresh_token: "unrelated-daemon-token",
      },
    }));

    const updated = await store.savePlan({
      id: saved.id,
      label: "Direct Codex renamed",
      provider: "codex",
      useProxy: false,
    });
    assert.equal(updated.authFilePath, undefined);
    assert.equal(updated.useProxy, false);
    assert.deepEqual(await store.readSecret(saved.id), { kind: "codex-auth", auth });
    await assert.rejects(
      store.savePlan({
        id: saved.id,
        label: "Do not switch implicitly",
        provider: "codex",
        codexAuthMode: "path",
      }),
      /Enter the path to Codex auth\.json/,
    );
    assert.deepEqual(await store.readSecret(saved.id), { kind: "codex-auth", auth });

    const state = JSON.parse(await readFile(path.join(root, "plans.json"), "utf8"));
    assert.equal(JSON.stringify(state).includes("direct-refresh-token"), false);
    assert.equal(JSON.stringify(state).includes("unrelated-daemon-token"), false);
  } finally {
    if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previousCodexHome;
    await rm(root, { recursive: true, force: true });
  }
});

test("updates proxy preference when a Codex source path is unavailable", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "coding-plan-missing-source-"));
  try {
    const sourceAuth = path.join(root, "source-auth.json");
    await writeFile(sourceAuth, JSON.stringify({
      tokens: {
        access_token: "x.e30.x",
        refresh_token: "preserved-refresh",
        id_token: "x.e30.x",
        account_id: "account",
      },
    }));
    const store = new PlanStore(path.join(root, "store"));
    const saved = await store.savePlan({
      label: "Path Codex",
      provider: "codex",
      codexAuthMode: "path",
      authFilePath: sourceAuth,
    });
    const originalSecret = await store.readSecret(saved.id);
    await unlink(sourceAuth);

    const updated = await store.savePlan({
      id: saved.id,
      label: saved.label,
      provider: "codex",
      codexAuthMode: "path",
      authFilePath: sourceAuth,
      useProxy: false,
    });

    assert.equal(updated.useProxy, false);
    assert.equal(updated.authFilePath, sourceAuth);
    assert.deepEqual(await store.readSecret(saved.id), originalSecret);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("syncs a newer path credential before switching to direct content", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "coding-plan-auth-switch-"));
  const jwt = (exp: number) => {
    const payload = Buffer.from(JSON.stringify({ sub: "same-user", exp })).toString("base64url");
    return `x.${payload}.x`;
  };
  try {
    const sourceAuth = path.join(root, "source-auth.json");
    await writeFile(sourceAuth, JSON.stringify({
      tokens: {
        access_token: jwt(1_900_000_000),
        refresh_token: "older-refresh",
        id_token: jwt(1_900_000_000),
        account_id: "account",
      },
    }));
    const store = new PlanStore(path.join(root, "store"));
    const saved = await store.savePlan({
      label: "Path Codex",
      provider: "codex",
      codexAuthMode: "path",
      authFilePath: sourceAuth,
    });
    await writeFile(sourceAuth, JSON.stringify({
      tokens: {
        access_token: jwt(1_900_003_600),
        refresh_token: "newer-refresh",
        id_token: jwt(1_900_003_600),
        account_id: "account",
      },
    }));

    const updated = await store.savePlan({
      id: saved.id,
      label: saved.label,
      provider: "codex",
      codexAuthMode: "content",
    });
    const secret = await store.readSecret(saved.id);

    assert.equal(updated.authFilePath, undefined);
    assert.equal(secret.kind, "codex-auth");
    if (secret.kind === "codex-auth") {
      assert.equal((secret.auth.tokens as Record<string, unknown>).refresh_token, "newer-refresh");
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects invalid direct Codex auth without creating a plan", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "coding-plan-invalid-auth-"));
  try {
    const store = new PlanStore(root);
    await assert.rejects(
      store.savePlan({
        label: "Broken Codex",
        provider: "codex",
        codexAuthMode: "content",
        authJsonContent: '{"tokens":',
      }),
      /Codex auth\.json content/,
    );
    assert.deepEqual(await store.listPlans(), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("keeps large direct Codex auth content readable", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "coding-plan-large-auth-"));
  try {
    const input = {
      label: "Large Codex",
      provider: "codex" as const,
      codexAuthMode: "content" as const,
      authJsonContent: JSON.stringify({
        tokens: {
          access_token: "x.e30.x",
          refresh_token: "r".repeat(500_000),
        },
      }),
    };
    const store = new PlanStore(root);
    const saved = await store.savePlan(input);
    const secret = await store.readSecret(saved.id);

    assert.equal(secret.kind, "codex-auth");
    if (secret.kind === "codex-auth") {
      assert.equal((secret.auth.tokens as Record<string, string>).refresh_token.length, 500_000);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("fails closed instead of duplicating quoted Codex root keys", () => {
  assert.throws(
    () => patchCodexConfig('"model" = "user-model"\n', plan("codex"), "gpt-5.6-sol"),
    /not valid TOML/,
  );
});

test("does not treat marker text inside a TOML value as a managed block", () => {
  const output = patchCodexConfig(
    'note = "# BEGIN paseo-coding-plan-manager"\n',
    plan("codex"),
    "gpt-5.6-sol",
  );
  assert.match(output, /note = "# BEGIN paseo-coding-plan-manager"/);
  assert.match(output, /model_provider = "openai"/);
});

test("fails closed for multiline TOML strings", () => {
  assert.throws(
    () => patchCodexConfig(
      'note = """\nmodel = "not a root key"\n"""\n',
      plan("codex"),
      "gpt-5.6-sol",
    ),
    /multiline TOML strings/,
  );
});

test("uses the official mainland GLM Responses endpoint for Codex", () => {
  const output = patchCodexConfig(
    undefined,
    { ...plan("zhipu"), region: "cn" },
    "glm-5.3",
    { apiKey: "cn-secret", modelCatalogPath: "/tmp/models.json" },
  );
  assert.match(output, /base_url = "https:\/\/open\.bigmodel\.cn\/api\/v1"/);
});

test("preserves a newer same-identity OpenCode OAuth generation", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "coding-plan-oauth-"));
  const previousXdgConfig = process.env.XDG_CONFIG_HOME;
  const previousXdgData = process.env.XDG_DATA_HOME;
  process.env.XDG_CONFIG_HOME = path.join(root, "config");
  process.env.XDG_DATA_HOME = path.join(root, "data");
  const jwt = (exp: number) => {
    const payload = Buffer.from(JSON.stringify({ sub: "same-user", exp })).toString("base64url");
    return `x.${payload}.x`;
  };
  try {
    const sourceAuth = path.join(root, "source-auth.json");
    await writeFile(sourceAuth, JSON.stringify({
      tokens: {
        access_token: jwt(1_900_000_000),
        refresh_token: "older-refresh",
        id_token: jwt(1_900_000_000),
        account_id: "account",
      },
      last_refresh: "2026-01-01T00:00:00.000Z",
    }));
    const opencodeAuth = path.join(root, "data", "opencode", "auth.json");
    await mkdir(path.dirname(opencodeAuth), { recursive: true });
    await writeFile(opencodeAuth, JSON.stringify({
      openai: {
        type: "oauth",
        access: jwt(1_900_003_600),
        refresh: "newer-refresh",
        expires: 1_900_003_600_000,
        accountId: "account",
      },
    }));

    const store = new PlanStore(path.join(root, "store"));
    const saved = await store.savePlan({
      label: "Codex",
      provider: "codex",
      authFilePath: sourceAuth,
    });
    const result = await applyPlanToTarget(saved.id, "opencode", "custom-openai-model", store);
    assert.equal(result.applied, true);
    const config = JSON.parse(
      await readFile(path.join(root, "config", "opencode", "opencode.json"), "utf8"),
    );
    assert.equal(config.model, "openai/custom-openai-model");
    const live = JSON.parse(await readFile(opencodeAuth, "utf8"));
    assert.equal(live.openai.refresh, "newer-refresh");
    const stored = await store.readSecret(saved.id);
    assert.equal(stored.kind, "codex-auth");
    if (stored.kind === "codex-auth") {
      assert.equal((stored.auth.tokens as Record<string, unknown>).refresh_token, "newer-refresh");
    }
  } finally {
    if (previousXdgConfig === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = previousXdgConfig;
    if (previousXdgData === undefined) delete process.env.XDG_DATA_HOME;
    else process.env.XDG_DATA_HOME = previousXdgData;
    await rm(root, { recursive: true, force: true });
  }
});

test("does not merge usage from a superseded plan revision", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "coding-plan-cache-"));
  try {
    const store = new PlanStore(root);
    const saved = await store.savePlan({
      label: "Kimi old",
      provider: "kimi",
      apiKey: "secret",
    });
    const expected = new Map([[saved.id, saved.updatedAt]]);
    await store.savePlan({
      id: saved.id,
      label: "Kimi new",
      provider: "kimi",
    });
    const accepted = await store.mergeUsageCache([
      {
        planId: saved.id,
        status: "ok",
        stale: false,
        fetchedAt: new Date().toISOString(),
        windows: [],
      },
    ], expected);
    assert.equal(accepted.has(saved.id), false);
    assert.deepEqual(await store.readUsageCache(), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("migrates v1 plans without retaining target models", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "coding-plan-migration-"));
  try {
    const currentPlan = plan("kimi");
    const legacyPlan: Record<string, unknown> = {
      ...currentPlan,
      models: {
        opencode: "custom-opencode-model",
        codex: "custom-codex-model",
        claude: "custom-claude-model",
      },
    };
    delete legacyPlan.useProxy;
    await mkdir(path.join(root, "secrets"), { recursive: true });
    await writeFile(path.join(root, "plans.json"), `${JSON.stringify({
      version: 1,
      plans: [legacyPlan],
      activeTargets: { opencode: currentPlan.id, codex: null, claude: null },
    }, null, 2)}\n`);
    await writeFile(path.join(root, "secrets", `${currentPlan.id}.json`), JSON.stringify({
      kind: "api-key",
      apiKey: "preserved-secret",
    }));

    const store = new PlanStore(root);
    const plans = await store.listPlans();
    const state = JSON.parse(await readFile(path.join(root, "plans.json"), "utf8"));

    assert.equal(plans.length, 1);
    assert.equal("models" in plans[0], false);
    assert.equal(state.version, 3);
    assert.equal("models" in state.plans[0], false);
    assert.equal(plans[0].useProxy, false);
    assert.equal((await store.getActiveTargets()).opencode, currentPlan.id);
    assert.deepEqual(await store.readSecret(currentPlan.id), {
      kind: "api-key",
      apiKey: "preserved-secret",
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("migrates v2 plans with provider-specific proxy defaults", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "coding-plan-proxy-migration-"));
  try {
    const legacyPlans = [plan("codex"), plan("zhipu")].map((current) => {
      const legacy = { ...current } as Record<string, unknown>;
      delete legacy.useProxy;
      return legacy;
    });
    await mkdir(root, { recursive: true });
    await writeFile(path.join(root, "plans.json"), `${JSON.stringify({
      version: 2,
      plans: legacyPlans,
      activeTargets: { opencode: "codex-1", codex: null, claude: null },
    }, null, 2)}\n`);

    const store = new PlanStore(root);
    const plans = await store.listPlans();
    const state = JSON.parse(await readFile(path.join(root, "plans.json"), "utf8"));

    assert.equal(state.version, 3);
    assert.equal(plans.find((item) => item.provider === "codex")?.useProxy, true);
    assert.equal(plans.find((item) => item.provider === "zhipu")?.useProxy, false);
    assert.equal((await store.getActiveTargets()).opencode, "codex-1");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("does not delete credentials when a v1 store cannot be migrated", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "coding-plan-invalid-migration-"));
  const secretPath = path.join(root, "secrets", "preserve-me.json");
  try {
    await mkdir(path.dirname(secretPath), { recursive: true });
    await writeFile(path.join(root, "plans.json"), JSON.stringify({
      version: 1,
      plans: [{ id: "broken-plan" }],
      activeTargets: {},
    }));
    await writeFile(secretPath, JSON.stringify({ kind: "api-key", apiKey: "preserved-secret" }));

    const store = new PlanStore(root);
    await store.initialize();

    assert.equal(JSON.parse(await readFile(secretPath, "utf8")).apiKey, "preserved-secret");
    await assert.rejects(store.listPlans(), /Unsupported or corrupt plan store/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
