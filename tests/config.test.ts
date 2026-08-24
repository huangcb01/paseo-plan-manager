import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
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
  const models = provider === "zhipu"
    ? { opencode: "glm-5.1", codex: "glm-5.2", claude: "glm-5.1" }
    : provider === "kimi"
      ? { opencode: "kimi-for-coding", codex: "kimi-for-coding", claude: "kimi-for-coding" }
      : { opencode: "gpt-5.6-sol", codex: "gpt-5.6-sol", claude: "gpt-5.6-sol" };
  return {
    id: `${provider}-1`,
    label: `${provider} plan`,
    provider,
    ...(provider === "zhipu" ? { region: "cn" as const } : {}),
    credentialHint: "hidden",
    models,
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
  const output = patchOpenCodeConfig(source, plan("kimi"));
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
  const output = patchClaudeSettings(source, plan("kimi"), "kimi-secret");
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
    () => patchCodexConfig(undefined, plan("kimi"), { apiKey: "secret", modelCatalogPath: "/tmp/models.json" }),
    /conversion proxy/,
  );
  assert.throws(
    () => patchCodexConfig(undefined, { ...plan("zhipu"), region: "cn-dev" }, { apiKey: "secret", modelCatalogPath: "/tmp/models.json" }),
    /conversion proxy/,
  );
});

test("refuses a direct Codex OAuth projection to Claude Code", () => {
  assert.throws(() => patchClaudeSettings(undefined, plan("codex"), "unused"), /protocol-conversion proxy/);
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
      models: { opencode: "kimi-for-coding", codex: "kimi-for-coding", claude: "kimi-for-coding" },
    });
    const result = await applyPlanToTarget(saved.id, "claude", store);
    assert.equal(result.applied, true);
    assert.ok(result.configPaths.includes(statePath));
    const state = JSON.parse(await readFile(statePath, "utf8"));
    assert.equal(state.keep, "value");
    assert.equal(state.hasCompletedOnboarding, true);
    assert.equal(state.penguinModeOrgEnabled, true);
    const settings = JSON.parse(await readFile(path.join(profile, "settings.json"), "utf8"));
    assert.equal(settings.env.ANTHROPIC_API_KEY, "kimi-secret");
  } finally {
    if (previousClaudeConfig === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = previousClaudeConfig;
    await rm(root, { recursive: true, force: true });
  }
});

test("removes the managed bearer token when switching Codex back to OAuth", () => {
  const globalPlan = { ...plan("zhipu"), region: "global" as const };
  const thirdParty = patchCodexConfig(undefined, globalPlan, {
    apiKey: "secret",
    modelCatalogPath: "/tmp/models.json",
  });
  const official = patchCodexConfig(thirdParty, plan("codex"));
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
      models: { opencode: "kimi-for-coding", codex: "kimi-for-coding", claude: "kimi-for-coding" },
    });
    const refused = await applyPlanToTarget(kimi.id, "codex", store);
    assert.equal(refused.applied, false);
    await assert.rejects(stat(path.join(root, "codex", "config.toml")), { code: "ENOENT" });

    const zai = await store.savePlan({
      label: "Z.AI",
      provider: "zhipu",
      region: "global",
      apiKey: "zai-secret",
      models: { opencode: "glm-5.1", codex: "glm-5.3", claude: "glm-5.1" },
    });
    const applied = await applyPlanToTarget(zai.id, "codex", store);
    assert.equal(applied.applied, true);
    const config = await readFile(path.join(root, "codex", "config.toml"), "utf8");
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
      models: { opencode: "gpt-5.6-sol", codex: "gpt-5.6-sol", claude: "gpt-5.6-sol" },
    });
    await mkdir(process.env.CODEX_HOME, { recursive: true });
    await writeFile(path.join(process.env.CODEX_HOME, "config.toml"), '"cli_auth_credentials_store" = "keyring"\n');
    const result = await applyPlanToTarget(codexPlan.id, "codex", store);
    assert.equal(result.applied, false);
    assert.match(result.message, /keyring/);
    await assert.rejects(stat(path.join(process.env.CODEX_HOME, "auth.json")), { code: "ENOENT" });
  } finally {
    if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previousCodexHome;
    await rm(root, { recursive: true, force: true });
  }
});

test("fails closed instead of duplicating quoted Codex root keys", () => {
  assert.throws(
    () => patchCodexConfig('"model" = "user-model"\n', plan("codex")),
    /not valid TOML/,
  );
});

test("does not treat marker text inside a TOML value as a managed block", () => {
  const output = patchCodexConfig('note = "# BEGIN paseo-coding-plan-manager"\n', plan("codex"));
  assert.match(output, /note = "# BEGIN paseo-coding-plan-manager"/);
  assert.match(output, /model_provider = "openai"/);
});

test("fails closed for multiline TOML strings", () => {
  assert.throws(
    () => patchCodexConfig('note = """\nmodel = "not a root key"\n"""\n', plan("codex")),
    /multiline TOML strings/,
  );
});

test("uses the official mainland GLM Responses endpoint for Codex", () => {
  const output = patchCodexConfig(
    undefined,
    { ...plan("zhipu"), region: "cn" },
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
      models: { opencode: "gpt-5.6-sol", codex: "gpt-5.6-sol", claude: "gpt-5.6-sol" },
    });
    const result = await applyPlanToTarget(saved.id, "opencode", store);
    assert.equal(result.applied, true);
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
      models: { opencode: "kimi-for-coding", codex: "kimi-for-coding", claude: "kimi-for-coding" },
    });
    const expected = new Map([[saved.id, saved.updatedAt]]);
    await store.savePlan({
      id: saved.id,
      label: "Kimi new",
      provider: "kimi",
      models: saved.models,
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
