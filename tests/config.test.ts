import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { parse } from "jsonc-parser";
import {
  codexModelCatalog,
  patchClaudeSettings,
  patchClaudeState,
  patchCodexConfig,
  patchOpenCodeAuth,
  patchOpenCodeConfig,
  applyPlanToTarget,
} from "../config.server";
import {
  modelCapabilityParameters,
  type ModelCapabilityField,
  type ModelCapabilityParameters,
} from "../model-capabilities.shared";
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

function modelPatch(
  parameters: ModelCapabilityParameters,
  fields: ModelCapabilityField[],
) {
  return { parameters, fields };
}

test("patches one multi-model OpenCode provider while preserving comments and unrelated providers", () => {
  const source = `{
  // keep this comment
  "theme": "system",
  "provider": {
    "local": { "npm": "@ai-sdk/openai-compatible", "models": {} },
    "kimi": { "old": true }
  }
}\n`;
  const output = patchOpenCodeConfig(source, plan("kimi"), [
    " kimi-for-coding ",
    "kimi-latest",
    "kimi-for-coding",
  ]);
  const parsed = parse(output) as Record<string, any>;

  assert.match(output, /keep this comment/);
  assert.equal(parsed.theme, "system");
  assert.ok(parsed.provider.local);
  assert.deepEqual(parsed.provider.kimi, { old: true });
  assert.equal(parsed.provider["kimi-for-coding"].npm, "@ai-sdk/anthropic");
  assert.equal(parsed.provider["kimi-for-coding"].name, undefined);
  assert.equal(parsed.provider["kimi-for-coding"].options.baseURL, "https://api.kimi.com/coding/v1");
  assert.equal(parsed.provider["kimi-for-coding"].options.apiKey, undefined);
  assert.deepEqual(parsed.provider["kimi-for-coding"].models, {
    "kimi-for-coding": {
      limit: { context: 262_144, output: 32_768 },
      modalities: { input: ["text", "image", "video"], output: ["text"] },
      reasoning: true,
      attachment: true,
      tool_call: true,
      temperature: false,
    },
    "kimi-latest": {
      limit: { context: 262_144, output: 32_768 },
      modalities: { input: ["text"], output: ["text"] },
      reasoning: true,
      attachment: false,
      tool_call: true,
      temperature: false,
    },
  });
  assert.equal(parsed.model, "kimi-for-coding/kimi-for-coding");
});

test("removes the legacy custom OpenCode provider only when it is plugin-managed", () => {
  const legacy = {
    npm: "@ai-sdk/anthropic",
    name: "Kimi For Coding",
    options: { baseURL: "https://api.kimi.com/coding/v1", setCacheKey: true },
    models: { k3: { name: "k3" } },
  };
  const customized = JSON.parse(JSON.stringify(legacy));
  customized.options.baseURL = "https://kimi-proxy.example/v1";

  const migrated = parse(patchOpenCodeConfig(
    JSON.stringify({ provider: { kimi: legacy, local: { models: {} } } }),
    plan("kimi"),
    ["k3"],
  )) as Record<string, any>;
  assert.equal(migrated.provider.kimi, undefined);
  assert.equal(migrated.provider["kimi-for-coding"].npm, "@ai-sdk/anthropic");
  assert.deepEqual(migrated.provider.local.models, {});
  assert.equal(migrated.model, "kimi-for-coding/k3");

  const kept = parse(patchOpenCodeConfig(
    JSON.stringify({ provider: { kimi: customized } }),
    plan("kimi"),
    ["k3"],
  )) as Record<string, any>;
  assert.equal(kept.provider.kimi.options.baseURL, "https://kimi-proxy.example/v1");
  assert.equal(kept.provider["kimi-for-coding"].npm, "@ai-sdk/anthropic");
});

test("patches only managed fields inside an existing OpenCode provider", () => {
  const source = `{
  "provider": {
    "kimi-for-coding": {
      // preserve this provider comment
      "api": "https://user.example/v1",
      "env": ["USER_KIMI_KEY"],
      "options": { "timeout": 1234, "apiKey": "stale-inline-key" },
      "models": {
        "user-model": {
          "name": "User model",
          "headers": { "X-User": "keep" }
        },
        "kimi-for-coding": {
          "name": "User label",
          "limit": { "context": 1, "input": 999, "output": 2 },
          "headers": { "X-Selected": "keep" },
          "variants": { "fast": { "disabled": false } }
        }
      }
    }
  }
}\n`;
  const output = patchOpenCodeConfig(source, plan("kimi"), ["kimi-for-coding"]);
  const parsed = parse(output) as Record<string, any>;

  assert.match(output, /preserve this provider comment/);
  assert.equal(parsed.provider["kimi-for-coding"].api, "https://user.example/v1");
  assert.deepEqual(parsed.provider["kimi-for-coding"].env, ["USER_KIMI_KEY"]);
  assert.equal(parsed.provider["kimi-for-coding"].options.timeout, 1234);
  assert.equal(parsed.provider["kimi-for-coding"].options.apiKey, undefined);
  assert.deepEqual(parsed.provider["kimi-for-coding"].models["user-model"], {
    name: "User model",
    headers: { "X-User": "keep" },
  });
  assert.deepEqual(parsed.provider["kimi-for-coding"].models["kimi-for-coding"].headers, { "X-Selected": "keep" });
  assert.deepEqual(parsed.provider["kimi-for-coding"].models["kimi-for-coding"].variants, {
    fast: { disabled: false },
  });
  assert.deepEqual(parsed.provider["kimi-for-coding"].models["kimi-for-coding"].limit, {
    context: 262_144,
    input: 999,
    output: 32_768,
  });
  assert.equal(parsed.provider["kimi-for-coding"].models["kimi-for-coding"].name, "User label");
});

test("preserves capabilities already defined for a selected custom OpenCode model", () => {
  const source = JSON.stringify({
    provider: {
      "kimi-for-coding": {
        models: {
          "private-model": {
            name: "Private model",
            limit: { context: 777_777, output: 12_345 },
            modalities: { input: ["text", "pdf"], output: ["text"] },
            reasoning: false,
            attachment: true,
            tool_call: false,
            temperature: true,
          },
        },
      },
    },
  });
  const parsed = JSON.parse(patchOpenCodeConfig(source, plan("kimi"), ["private-model"]));

  assert.deepEqual(parsed.provider["kimi-for-coding"].models["private-model"], {
    name: "Private model",
    limit: { context: 777_777, output: 12_345 },
    modalities: { input: ["text", "pdf"], output: ["text"] },
    reasoning: false,
    attachment: true,
    tool_call: false,
    temperature: true,
  });
});

test("writes model-specific OpenCode limits and modalities", () => {
  const kimi = JSON.parse(patchOpenCodeConfig(undefined, plan("kimi"), ["k3", "k3-256k"]));
  assert.deepEqual(kimi.provider["kimi-for-coding"].models.k3.limit, { context: 1_048_576, output: 131_072 });
  assert.deepEqual(kimi.provider["kimi-for-coding"].models.k3.modalities.input, ["text", "image", "video"]);
  assert.equal(kimi.provider["kimi-for-coding"].models.k3.attachment, false);
  assert.equal(kimi.provider["kimi-for-coding"].models.k3.tool_call, true);
  assert.equal(kimi.provider["kimi-for-coding"].models.k3.temperature, false);

  const zhipu = JSON.parse(patchOpenCodeConfig(undefined, plan("zhipu"), ["glm-5.3"]));
  assert.deepEqual(zhipu.provider["zhipuai-coding-plan"].models["glm-5.3"].limit, {
    context: 1_000_000,
    output: 131_072,
  });
  assert.deepEqual(zhipu.provider["zhipuai-coding-plan"].models["glm-5.3"].modalities, {
    input: ["text"],
    output: ["text"],
  });
  assert.equal(zhipu.provider["zhipuai-coding-plan"].models["glm-5.3"].reasoning, true);
  assert.equal(zhipu.provider["zhipuai-coding-plan"].models["glm-5.3"].attachment, false);
  assert.equal(zhipu.provider["zhipuai-coding-plan"].models["glm-5.3"].tool_call, true);
  assert.equal(zhipu.provider["zhipuai-coding-plan"].models["glm-5.3"].temperature, true);
  assert.deepEqual(zhipu.provider["zhipuai-coding-plan"].models["glm-5.3"].interleaved, {
    field: "reasoning_content",
  });
  assert.equal(zhipu.model, "zhipuai-coding-plan/glm-5.3");
});

test("maps zhipu regions onto their native OpenCode coding plan providers", () => {
  const cn = JSON.parse(patchOpenCodeConfig(undefined, plan("zhipu"), ["glm-5.3"]));
  assert.equal(cn.provider["zhipuai-coding-plan"].options.baseURL, "https://open.bigmodel.cn/api/coding/paas/v4");
  assert.equal(cn.provider["zhipuai-coding-plan"].npm, "@ai-sdk/openai-compatible");

  const global = JSON.parse(patchOpenCodeConfig(undefined, { ...plan("zhipu"), region: "global" }, ["glm-5.3"]));
  assert.equal(global.provider["zai-coding-plan"].options.baseURL, "https://api.z.ai/api/coding/paas/v4");
  assert.equal(global.model, "zai-coding-plan/glm-5.3");

  const dev = JSON.parse(patchOpenCodeConfig(undefined, { ...plan("zhipu"), region: "cn-dev" }, ["glm-5.3"]));
  assert.equal(dev.provider["zhipuai-coding-plan"].options.baseURL, "https://dev.bigmodel.cn/api/coding/paas/v4");
});

test("applies explicit per-model OpenCode capabilities and clears optional fields", () => {
  const source = JSON.stringify({
    provider: {
      "kimi-for-coding": {
        models: {
          "kimi-for-coding": {
            limit: { context: 1, input: 1, output: 1 },
            interleaved: { field: "reasoning_content" },
          },
        },
      },
    },
  });
  const parameters = modelCapabilityParameters("kimi", "kimi-for-coding");
  parameters.limit = { context: 300_000, output: 50_000 };
  parameters.modalities = { input: ["text", "pdf"], output: ["text", "image"] };
  parameters.reasoning = false;
  parameters.attachment = false;
  parameters.toolCall = false;
  parameters.temperature = true;
  parameters.interleaved = null;

  const parsed = JSON.parse(patchOpenCodeConfig(
    source,
    plan("kimi"),
    ["kimi-for-coding"],
    new Map([["kimi-for-coding", modelPatch(parameters, [
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
    ])]]),
  ));
  const model = parsed.provider["kimi-for-coding"].models["kimi-for-coding"];
  assert.deepEqual(model.limit, { context: 300_000, output: 50_000 });
  assert.deepEqual(model.modalities, { input: ["text", "pdf"], output: ["text", "image"] });
  assert.equal(model.reasoning, false);
  assert.equal(model.attachment, false);
  assert.equal(model.tool_call, false);
  assert.equal(model.temperature, true);
  assert.equal(model.interleaved, undefined);
});

test("changes only explicitly edited fields on an existing unknown OpenCode model", () => {
  const source = JSON.stringify({
    provider: {
      "kimi-for-coding": {
        models: {
          "private-kimi": {
            name: "Private display name",
            limit: { context: 111_000, input: 100_000, output: 11_000, vendor: "keep" },
            modalities: { input: ["text", "pdf"], output: ["text", "audio"] },
            reasoning: false,
            attachment: true,
            tool_call: false,
            temperature: true,
            interleaved: { field: "reasoning" },
            vendor: { keep: true },
          },
        },
      },
    },
  });
  const parameters = modelCapabilityParameters("kimi", "private-kimi");

  const parsed = JSON.parse(patchOpenCodeConfig(
    source,
    plan("kimi"),
    ["private-kimi"],
    new Map([["private-kimi", modelPatch(parameters, [
      "limit.context",
      "limit.input",
      "reasoning",
      "interleaved",
    ])]]),
  ));
  assert.deepEqual(parsed.provider["kimi-for-coding"].models["private-kimi"], {
    name: "Private display name",
    limit: { context: 262_144, output: 11_000, vendor: "keep" },
    modalities: { input: ["text", "pdf"], output: ["text", "audio"] },
    reasoning: true,
    attachment: true,
    tool_call: false,
    temperature: true,
    vendor: { keep: true },
  });
});

test("rejects an unknown OpenCode limit patch that conflicts with preserved fields", () => {
  const source = JSON.stringify({
    provider: {
      "kimi-for-coding": {
        models: {
          "private-kimi": { limit: { context: 100_000, output: 50_000 } },
        },
      },
    },
  });
  const parameters = modelCapabilityParameters("kimi", "private-kimi");
  parameters.limit.output = 200_000;

  assert.throws(
    () => patchOpenCodeConfig(
      source,
      plan("kimi"),
      ["private-kimi"],
      new Map([["private-kimi", modelPatch(parameters, ["limit.output"])]]),
    ),
    /after applying edited fields\.output cannot exceed context/,
  );
});

test("validates sparse OpenCode limits against preserved or completed fields", () => {
  const withLargeContext = JSON.stringify({
    provider: { "kimi-for-coding": { models: { "private-kimi": { limit: { context: 1_000_000, output: 50_000 } } } } },
  });
  const outputParameters = modelCapabilityParameters("kimi", "private-kimi");
  outputParameters.limit.output = 500_000;
  const updated = JSON.parse(patchOpenCodeConfig(
    withLargeContext,
    plan("kimi"),
    ["private-kimi"],
    new Map([["private-kimi", modelPatch(outputParameters, ["limit.output"])]]),
  ));
  assert.deepEqual(updated.provider["kimi-for-coding"].models["private-kimi"].limit, {
    context: 1_000_000,
    output: 500_000,
  });

  const withoutLimit = JSON.stringify({
    provider: { "kimi-for-coding": { models: { "private-kimi": { vendor: "keep" } } } },
  });
  const contextParameters = modelCapabilityParameters("kimi", "private-kimi");
  contextParameters.limit.context = 300_000;
  const completed = JSON.parse(patchOpenCodeConfig(
    withoutLimit,
    plan("kimi"),
    ["private-kimi"],
    new Map([["private-kimi", modelPatch(contextParameters, ["limit.context"])]]),
  ));
  assert.deepEqual(completed.provider["kimi-for-coding"].models["private-kimi"], {
    vendor: "keep",
    limit: { context: 300_000, output: 32_768 },
  });
});

test("maps supported custom-model capabilities into the Codex model catalog", () => {
  const parameters = modelCapabilityParameters("zhipu", "private-glm");
  parameters.limit.context = 500_000;
  parameters.modalities.input = ["text", "image", "video"];
  parameters.reasoning = false;

  const catalog = JSON.parse(codexModelCatalog(
    ["private-glm"],
    new Map([["private-glm", modelPatch(parameters, [
      "limit.context",
      "modalities.input",
      "reasoning",
    ])]]),
  ));
  const [model] = catalog.models;
  assert.equal(model.context_window, 500_000);
  assert.equal(model.max_context_window, 500_000);
  assert.deepEqual(model.input_modalities, ["text", "image"]);
  assert.equal(model.default_reasoning_level, undefined);
  assert.deepEqual(model.supported_reasoning_levels, []);
  assert.equal(model.supports_reasoning_summary_parameter, false);
  assert.equal(model.supports_reasoning_summaries, undefined);
  assert.equal(model.shell_type, "shell_command");
  assert.equal(model.apply_patch_tool_type, "freeform");
  assert.equal(model.supports_parallel_tool_calls, undefined);
});

test("uses only declared dirty fields when generating a Codex model entry", () => {
  const parameters = modelCapabilityParameters("zhipu", "private-glm");
  parameters.limit.context = 100_000_000;
  parameters.reasoning = false;
  const catalog = JSON.parse(codexModelCatalog(
    ["private-glm"],
    new Map([["private-glm", modelPatch(parameters, ["reasoning"])]]),
  ));

  assert.equal(catalog.models[0].context_window, 204_800);
  assert.equal(catalog.models[0].default_reasoning_level, undefined);
});

test("leaves the OpenCode built-in OpenAI catalog untouched for Codex OAuth", () => {
  const source = '{"provider":{"openai":{"models":{"official":{"name":"Official"}}}}}';
  const parsed = JSON.parse(patchOpenCodeConfig(source, plan("codex"), ["gpt-default", "gpt-extra"]));
  assert.equal(parsed.model, "openai/gpt-default");
  assert.deepEqual(parsed.provider.openai.models, { official: { name: "Official" } });
});

test("rejects invalid model lists from direct apply callers", async () => {
  await assert.rejects(applyPlanToTarget("unused", "opencode", []), /at least one model/);
  await assert.rejects(
    applyPlanToTarget("unused", "opencode", Array.from({ length: 17 }, () => "duplicate")),
    /more than 16 models/,
  );
  await assert.rejects(applyPlanToTarget("unused", "opencode", ["x".repeat(257)]), /256 characters/);
  await assert.rejects(
    applyPlanToTarget(
      "unused",
      "opencode",
      ["kimi-for-coding"],
      undefined,
      new Map([["k3", modelPatch(modelCapabilityParameters("kimi", "k3"), ["limit.context"])]]),
    ),
    /only target a selected model/,
  );
  const claudeParameters = modelCapabilityParameters("zhipu", "glm-5.3[1m]");
  claudeParameters.limit.context = 1_100_000;
  await assert.rejects(
    applyPlanToTarget(
      "unused",
      "claude",
      ["glm-5.3[1m]"],
      undefined,
      new Map([["glm-5.3[1m]", modelPatch(claudeParameters, ["limit.context"])]]),
    ),
    /fixed 1000000 token context/,
  );
  const codexParameters = modelCapabilityParameters("zhipu", "glm-5.3");
  codexParameters.toolCall = false;
  await assert.rejects(
    applyPlanToTarget(
      "unused",
      "codex",
      ["glm-5.3"],
      undefined,
      new Map([["glm-5.3", modelPatch(codexParameters, ["toolCall"])]]),
    ),
    /does not map the toolCall capability field/,
  );
  const noReasoning = modelCapabilityParameters("zhipu", "glm-5.3");
  noReasoning.reasoning = false;
  await assert.rejects(
    applyPlanToTarget(
      "unused",
      "codex",
      ["glm-5.3"],
      undefined,
      new Map([["glm-5.3", modelPatch(noReasoning, ["reasoning"])]]),
    ),
    /requires reasoning in Codex/,
  );
  const multimodal = modelCapabilityParameters("zhipu", "glm-5.3");
  multimodal.modalities.input = ["text", "image"];
  await assert.rejects(
    applyPlanToTarget(
      "unused",
      "codex",
      ["glm-5.3"],
      undefined,
      new Map([["glm-5.3", modelPatch(multimodal, ["modalities.input"])]]),
    ),
    /only supports text input in Codex/,
  );
});

test("patches OpenCode auth without deleting another provider", () => {
  const output = patchOpenCodeAuth(
    '{"local":{"type":"api","key":"keep"}}',
    plan("zhipu"),
    { kind: "api-key", apiKey: "secret" },
  );
  const parsed = JSON.parse(output);
  assert.equal(parsed.local.key, "keep");
  assert.deepEqual(parsed["zhipuai-coding-plan"], { type: "api", key: "secret" });
  assert.equal(parsed.zhipu, undefined);
});

test("removes legacy OpenCode auth entries listed by the caller", () => {
  const output = patchOpenCodeAuth(
    '{"zhipu":{"type":"api","key":"old"},"kimi":{"type":"api","key":"old"},"local":{"type":"api","key":"keep"}}',
    plan("zhipu"),
    { kind: "api-key", apiKey: "secret" },
    ["zhipu"],
  );
  const parsed = JSON.parse(output);
  assert.equal(parsed.zhipu, undefined);
  assert.deepEqual(parsed.kimi, { type: "api", key: "old" });
  assert.equal(parsed.local.key, "keep");
  assert.deepEqual(parsed["zhipuai-coding-plan"], { type: "api", key: "secret" });
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
    ["glm-5.2", "glm-5.3"],
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

test("removes a root reasoning effort for a custom non-reasoning Codex model", () => {
  const parameters = modelCapabilityParameters("zhipu", "private-glm");
  parameters.reasoning = false;
  for (const key of ["model_reasoning_effort", '"model_reasoning_effort"', "'model_reasoning_effort'"]) {
    const output = patchCodexConfig(
      `${key} = "high"\n`,
      plan("zhipu"),
      ["private-glm"],
      {
        apiKey: "zai-secret",
        modelCatalogPath: "/tmp/models.json",
        modelParameters: new Map([["private-glm", modelPatch(parameters, ["reasoning"])]]),
      },
    );
    assert.doesNotMatch(output, /model_reasoning_effort/);
  }
});

test("writes every selected Zhipu model with its Codex catalog metadata", () => {
  const catalog = JSON.parse(codexModelCatalog(["glm-5.3", "glm-5-turbo", "glm-5.3"]));
  assert.deepEqual(catalog.models.map((model: Record<string, unknown>) => model.slug), ["glm-5.3", "glm-5-turbo"]);
  assert.equal(catalog.models[0].context_window, 1_048_576);
  assert.equal(catalog.models[1].context_window, 204_800);
  assert.equal(catalog.models[0].default_reasoning_level, "max");
  assert.deepEqual(
    catalog.models[0].supported_reasoning_levels.map((level: Record<string, unknown>) => level.effort),
    ["low", "high", "max"],
  );
  assert.equal(catalog.models[1].default_reasoning_level, "max");
  assert.deepEqual(catalog.models[1].supported_reasoning_levels, []);
  assert.equal(catalog.models[0].supports_reasoning_summary_parameter, true);
});

test("patches only Claude env and keeps unrelated settings", () => {
  const source = JSON.stringify({
    permissions: { allow: ["Bash(git:*)"] },
    env: { KEEP_ME: "yes", ANTHROPIC_API_KEY: "old" },
    modelPicker: {
      replaceBuiltInOptions: true,
      options: [
        { model: "existing-model", label: "Existing", description: "Keep this row" },
        { model: "kimi-for-coding", label: "User label" },
      ],
    },
  });
  const output = patchClaudeSettings(source, plan("kimi"), "kimi-secret", [
    "kimi-for-coding",
    "kimi-latest",
    "kimi-latest",
  ]);
  const parsed = JSON.parse(output);
  assert.deepEqual(parsed.permissions, { allow: ["Bash(git:*)"] });
  assert.equal(parsed.env.KEEP_ME, "yes");
  assert.equal(parsed.env.ANTHROPIC_AUTH_TOKEN, undefined);
  assert.equal(parsed.env.ANTHROPIC_API_KEY, "kimi-secret");
  assert.equal(parsed.env.ANTHROPIC_BASE_URL, "https://api.kimi.com/coding/");
  assert.equal(parsed.env.ANTHROPIC_DEFAULT_FABLE_MODEL, "kimi-for-coding");
  assert.equal(parsed.env.CLAUDE_CODE_SUBAGENT_MODEL, "kimi-for-coding");
  assert.equal(parsed.env.CLAUDE_CODE_MAX_CONTEXT_TOKENS, "262144");
  assert.equal(parsed.modelPicker.replaceBuiltInOptions, true);
  assert.deepEqual(parsed.modelPicker.options, [
    { model: "existing-model", label: "Existing", description: "Keep this row" },
    { model: "kimi-for-coding", label: "User label" },
    {
      model: "kimi-latest",
      label: "kimi-latest",
      description: "Managed by Paseo Coding Plan Manager",
    },
  ]);
});

test("keeps Claude model capacity separate from its 1M auto-compact ceiling", () => {
  const k3Only = JSON.parse(patchClaudeSettings(undefined, plan("kimi"), "secret", ["k3"]));
  const allLarge = JSON.parse(patchClaudeSettings(undefined, plan("kimi"), "secret", ["k3", "k3[1m]"]));
  const mixed = JSON.parse(patchClaudeSettings(undefined, plan("kimi"), "secret", ["k3", "kimi-for-coding"]));
  const glmLarge = JSON.parse(patchClaudeSettings(undefined, plan("zhipu"), "secret", ["glm-5.3[1m]"]));
  assert.equal(k3Only.env.CLAUDE_CODE_MAX_CONTEXT_TOKENS, "1048576");
  assert.equal(k3Only.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW, "1000000");
  assert.equal(allLarge.env.CLAUDE_CODE_MAX_CONTEXT_TOKENS, "1000000");
  assert.equal(allLarge.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW, "1000000");
  assert.equal(mixed.env.CLAUDE_CODE_MAX_CONTEXT_TOKENS, "262144");
  assert.equal(glmLarge.env.CLAUDE_CODE_MAX_CONTEXT_TOKENS, "1000000");
  assert.equal(glmLarge.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW, "1000000");
});

test("allows a sub-100K Claude model while clamping its configured compact window", () => {
  const parameters = modelCapabilityParameters("kimi", "private-kimi");
  parameters.limit.context = 64_000;
  const parsed = JSON.parse(patchClaudeSettings(
    undefined,
    plan("kimi"),
    "secret",
    ["private-kimi"],
    new Map([["private-kimi", modelPatch(parameters, ["limit.context"])]]),
  ));

  assert.equal(parsed.env.CLAUDE_CODE_MAX_CONTEXT_TOKENS, "64000");
  assert.equal(parsed.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW, "100000");
});

test("maps per-model context overrides to Claude's smallest global context", () => {
  const k3 = modelCapabilityParameters("kimi", "k3");
  const coding = modelCapabilityParameters("kimi", "kimi-for-coding");
  k3.limit.context = 900_000;
  coding.limit.context = 180_000;
  coding.limit.output = 32_000;
  const parsed = JSON.parse(patchClaudeSettings(
    undefined,
    plan("kimi"),
    "secret",
    ["k3", "kimi-for-coding"],
    new Map([
      ["k3", modelPatch(k3, ["limit.context"])],
      ["kimi-for-coding", modelPatch(coding, ["limit.context"])],
    ]),
  ));

  assert.equal(parsed.env.CLAUDE_CODE_MAX_CONTEXT_TOKENS, "180000");
  assert.equal(parsed.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW, "180000");
});

test("removes stale generated Claude models when switching providers", () => {
  const initial = JSON.stringify({
    modelPicker: {
      replaceBuiltInOptions: true,
      options: [
        { model: "user-model", label: "User model", description: "Keep this row" },
        { model: "glm-5.3", label: "Pinned GLM", description: "User-managed row" },
      ],
    },
  });
  const zhipu = patchClaudeSettings(initial, plan("zhipu"), "zhipu-secret", ["glm-5.1", "glm-4.7"]);
  const kimi = JSON.parse(patchClaudeSettings(zhipu, plan("kimi"), "kimi-secret", [
    "kimi-for-coding",
    "k3",
  ]));

  assert.equal(kimi.modelPicker.replaceBuiltInOptions, true);
  assert.deepEqual(kimi.modelPicker.options, [
    { model: "user-model", label: "User model", description: "Keep this row" },
    { model: "glm-5.3", label: "Pinned GLM", description: "User-managed row" },
    {
      model: "kimi-for-coding",
      label: "kimi-for-coding",
      description: "Managed by Paseo Coding Plan Manager",
    },
    { model: "k3", label: "k3", description: "Managed by Paseo Coding Plan Manager" },
  ]);
});

test("replaces only marked Claude picker options on same-provider reapply", () => {
  const source = patchClaudeSettings(undefined, plan("kimi"), "secret", [
    "kimi-for-coding",
    "k3",
  ]);
  const parsed = JSON.parse(patchClaudeSettings(source, plan("kimi"), "secret", ["k3-256k"]));

  assert.deepEqual(parsed.modelPicker.options, [{
    model: "k3-256k",
    label: "k3-256k",
    description: "Managed by Paseo Coding Plan Manager",
  }]);
});

test("fails closed for incompatible Claude model picker settings", () => {
  assert.throws(
    () => patchClaudeSettings('{"modelPicker":[]}', plan("kimi"), "secret", ["kimi-for-coding"]),
    /modelPicker must be an object/,
  );
  assert.throws(
    () => patchClaudeSettings('{"modelPicker":{"options":{}}}', plan("kimi"), "secret", ["kimi-for-coding"]),
    /modelPicker\.options must be an array/,
  );
});

test("refuses Chat-only Coding Plans in a direct Codex projection", () => {
  assert.throws(
    () => patchCodexConfig(undefined, plan("kimi"), ["kimi-for-coding"], { apiKey: "secret", modelCatalogPath: "/tmp/models.json" }),
    /conversion proxy/,
  );
  assert.throws(
    () => patchCodexConfig(undefined, { ...plan("zhipu"), region: "cn-dev" }, ["glm-5.2"], { apiKey: "secret", modelCatalogPath: "/tmp/models.json" }),
    /conversion proxy/,
  );
});

test("refuses a direct Codex OAuth projection to Claude Code", () => {
  assert.throws(
    () => patchClaudeSettings(undefined, plan("codex"), "unused", ["gpt-5.6-sol"]),
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
    const result = await applyPlanToTarget(saved.id, "claude", ["kimi-custom-model", "kimi-backup-model"], store);
    assert.equal(result.applied, true);
    assert.ok(result.configPaths.includes(statePath));
    const state = JSON.parse(await readFile(statePath, "utf8"));
    assert.equal(state.keep, "value");
    assert.equal(state.hasCompletedOnboarding, true);
    assert.equal(state.penguinModeOrgEnabled, true);
    const settings = JSON.parse(await readFile(path.join(profile, "settings.json"), "utf8"));
    assert.equal(settings.env.ANTHROPIC_API_KEY, "kimi-secret");
    assert.equal(settings.env.ANTHROPIC_MODEL, "kimi-custom-model");
    assert.deepEqual(settings.modelPicker.options, [
      {
        model: "kimi-custom-model",
        label: "kimi-custom-model",
        description: "Managed by Paseo Coding Plan Manager",
      },
      {
        model: "kimi-backup-model",
        label: "kimi-backup-model",
        description: "Managed by Paseo Coding Plan Manager",
      },
    ]);
    assert.ok(result.warnings.some((warning) => warning.includes("2.1.242")));
  } finally {
    if (previousClaudeConfig === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = previousClaudeConfig;
    await rm(root, { recursive: true, force: true });
  }
});

test("removes the managed bearer token when switching Codex back to OAuth", () => {
  const globalPlan = { ...plan("zhipu"), region: "global" as const };
  const thirdParty = patchCodexConfig(undefined, globalPlan, ["glm-5.2"], {
    apiKey: "secret",
    modelCatalogPath: "/tmp/paseo-coding-plan-models.json",
  });
  const official = patchCodexConfig(thirdParty, plan("codex"), ["gpt-5.6-sol"], {
    modelCatalogPath: "/tmp/paseo-coding-plan-models.json",
  });
  assert.doesNotMatch(official, /secret|experimental_bearer_token|model_catalog_json/);
  assert.match(official, /model_provider = "openai"/);
});

test("preserves a user Codex model catalog when switching back to OAuth", () => {
  const source = `model_provider = "paseo-coding-plan"
model = "glm-5.3"
model_catalog_json = "/tmp/user/paseo-coding-plan-models.json"

# BEGIN paseo-coding-plan-manager
[model_providers.paseo-coding-plan]
experimental_bearer_token = "managed-secret"
# END paseo-coding-plan-manager
`;
  const output = patchCodexConfig(source, plan("codex"), ["gpt-5.6-sol"], {
    modelCatalogPath: "/tmp/codex/paseo-coding-plan-models.json",
  });

  assert.match(output, /model_catalog_json = "\/tmp\/user\/paseo-coding-plan-models\.json"/);
  assert.doesNotMatch(output, /managed-secret|experimental_bearer_token/);
  assert.match(output, /model_provider = "openai"/);
});

test("removes a relative Codex catalog only when it resolves to the managed path", () => {
  const source = `model_provider = "paseo-coding-plan"
model = "glm-5.3"
model_catalog_json = "paseo-coding-plan-models.json"
`;
  const output = patchCodexConfig(source, plan("codex"), ["gpt-5.6-sol"], {
    modelCatalogPath: "/tmp/codex/paseo-coding-plan-models.json",
  });

  assert.doesNotMatch(output, /model_catalog_json/);
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
    const refused = await applyPlanToTarget(kimi.id, "codex", ["kimi-for-coding"], store);
    assert.equal(refused.applied, false);
    await assert.rejects(stat(path.join(root, "codex", "config.toml")), { code: "ENOENT" });

    const zai = await store.savePlan({
      label: "Z.AI",
      provider: "zhipu",
      region: "global",
      apiKey: "zai-secret",
    });
    const applied = await applyPlanToTarget(zai.id, "codex", ["glm-custom-model", "glm-5.3"], store);
    assert.equal(applied.applied, true);
    const config = await readFile(path.join(root, "codex", "config.toml"), "utf8");
    assert.match(config, /model = "glm-custom-model"/);
    assert.match(config, /https:\/\/api\.z\.ai\/api\/v1/);
    assert.match(config, /experimental_bearer_token = "zai-secret"/);
    const catalog = JSON.parse(await readFile(path.join(root, "codex", "paseo-coding-plan-models.json"), "utf8"));
    assert.deepEqual(catalog.models.map((model: Record<string, unknown>) => model.slug), ["glm-custom-model", "glm-5.3"]);
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
    const result = await applyPlanToTarget(codexPlan.id, "codex", ["gpt-5.6-sol"], store);
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
    () => patchCodexConfig('"model" = "user-model"\n', plan("codex"), ["gpt-5.6-sol"]),
    /not valid TOML/,
  );
});

test("does not treat marker text inside a TOML value as a managed block", () => {
  const output = patchCodexConfig(
    'note = "# BEGIN paseo-coding-plan-manager"\n',
    plan("codex"),
    ["gpt-5.6-sol"],
  );
  assert.match(output, /note = "# BEGIN paseo-coding-plan-manager"/);
  assert.match(output, /model_provider = "openai"/);
});

test("fails closed for multiline TOML strings", () => {
  assert.throws(
    () => patchCodexConfig(
      'note = """\nmodel = "not a root key"\n"""\n',
      plan("codex"),
      ["gpt-5.6-sol"],
    ),
    /multiline TOML strings/,
  );
});

test("uses the official mainland GLM Responses endpoint for Codex", () => {
  const output = patchCodexConfig(
    undefined,
    { ...plan("zhipu"), region: "cn" },
    ["glm-5.3"],
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
    const result = await applyPlanToTarget(saved.id, "opencode", ["custom-openai-model", "unused-catalog-model"], store);
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

test("migrates a legacy custom OpenCode provider to the native coding plan provider", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "coding-plan-native-"));
  const previousXdgConfig = process.env.XDG_CONFIG_HOME;
  const previousXdgData = process.env.XDG_DATA_HOME;
  process.env.XDG_CONFIG_HOME = path.join(root, "config");
  process.env.XDG_DATA_HOME = path.join(root, "data");
  try {
    const configDir = path.join(root, "config", "opencode");
    await mkdir(configDir, { recursive: true });
    await writeFile(path.join(configDir, "opencode.jsonc"), JSON.stringify({
      provider: {
        zhipu: {
          npm: "@ai-sdk/openai-compatible",
          name: "Zhipu GLM",
          options: { baseURL: "https://open.bigmodel.cn/api/coding/paas/v4", setCacheKey: true },
          models: { "glm-5.3": { name: "glm-5.3" } },
        },
      },
    }));
    const opencodeAuth = path.join(root, "data", "opencode", "auth.json");
    await mkdir(path.dirname(opencodeAuth), { recursive: true });
    await writeFile(opencodeAuth, JSON.stringify({
      "zhipuai-coding-plan": { type: "api", key: "native-key" },
      zhipu: { type: "api", key: "legacy-key" },
    }));

    const store = new PlanStore(path.join(root, "store"));
    const saved = await store.savePlan({
      label: "GLM",
      provider: "zhipu",
      region: "cn",
      apiKey: "plan-key",
    });
    const result = await applyPlanToTarget(saved.id, "opencode", ["glm-5.3"], store);
    assert.equal(result.applied, true);
    assert.ok(result.warnings.some((warning) => warning.includes("zhipuai-coding-plan") && warning.includes("zhipu")));

    const config = JSON.parse(
      await readFile(path.join(configDir, "opencode.jsonc"), "utf8"),
    );
    assert.equal(config.provider.zhipu, undefined);
    assert.equal(config.provider["zhipuai-coding-plan"].npm, "@ai-sdk/openai-compatible");
    assert.deepEqual(config.provider["zhipuai-coding-plan"].models["glm-5.3"].limit, {
      context: 1_000_000,
      output: 131_072,
    });
    assert.equal(config.model, "zhipuai-coding-plan/glm-5.3");

    const live = JSON.parse(await readFile(opencodeAuth, "utf8"));
    assert.equal(live.zhipu, undefined);
    assert.deepEqual(live["zhipuai-coding-plan"], { type: "api", key: "plan-key" });
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
    assert.equal(state.version, 4);
    assert.equal("models" in state.plans[0], false);
    assert.equal(plans[0].useProxy, false);
    assert.deepEqual((await store.getActiveTargets()).opencode, {
      codex: null,
      zhipu: null,
      kimi: currentPlan.id,
    });
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

    assert.equal(state.version, 4);
    assert.equal(plans.find((item) => item.provider === "codex")?.useProxy, true);
    assert.equal(plans.find((item) => item.provider === "zhipu")?.useProxy, false);
    assert.deepEqual((await store.getActiveTargets()).opencode, {
      codex: "codex-1",
      zhipu: null,
      kimi: null,
    });
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
