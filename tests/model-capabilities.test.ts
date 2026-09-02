import assert from "node:assert/strict";
import test from "node:test";
import {
  estimatedOpenCodeCompactionThreshold,
  isKnownCapabilityModel,
  modelCapabilityParameters,
  ModelCapabilityParametersSchema,
  ModelParameterOverrideSchema,
  targetModelCapabilityParameters,
} from "../model-capabilities.shared";

test("provides isolated known model defaults and OpenCode compaction estimates", () => {
  const parameters = modelCapabilityParameters("kimi", "kimi-for-coding");
  assert.deepEqual(parameters.limit, { context: 262_144, output: 32_768 });
  assert.equal(estimatedOpenCodeCompactionThreshold(parameters), 230_144);

  parameters.limit = { context: 150_000, input: 150_000, output: 30_000 };
  assert.equal(estimatedOpenCodeCompactionThreshold(parameters), 130_000);
  assert.deepEqual(modelCapabilityParameters("kimi", "kimi-for-coding").limit, {
    context: 262_144,
    output: 32_768,
  });
});

test("uses target-specific context defaults without mutating OpenCode metadata", () => {
  assert.equal(targetModelCapabilityParameters("zhipu", "opencode", "glm-5.3").limit.context, 1_000_000);
  assert.equal(targetModelCapabilityParameters("zhipu", "codex", "glm-5.3").limit.context, 1_048_576);
  assert.equal(targetModelCapabilityParameters("zhipu", "claude", "glm-5.3").limit.context, 200_000);
  assert.equal(targetModelCapabilityParameters("zhipu", "claude", "glm-5.3[1m]").limit.context, 1_000_000);
  assert.equal(targetModelCapabilityParameters("kimi", "claude", "k3").limit.context, 1_048_576);
});

test("narrows Oh My Pi input modalities to what omp can map", () => {
  assert.deepEqual(
    targetModelCapabilityParameters("kimi", "ohmypi", "k3").modalities.input,
    ["text", "image"],
  );
  assert.deepEqual(
    targetModelCapabilityParameters("kimi", "ohmypi", "kimi-for-coding").modalities.input,
    ["text", "image"],
  );
  assert.deepEqual(
    targetModelCapabilityParameters("zhipu", "ohmypi", "glm-5.3").modalities.input,
    ["text"],
  );
  assert.deepEqual(
    targetModelCapabilityParameters("kimi", "opencode", "k3").modalities.input,
    ["text", "image", "video"],
  );
});

test("marks unknown models and leaves sparse limit relationships to target projection", () => {
  assert.equal(isKnownCapabilityModel("zhipu", "glm-5.3"), true);
  assert.equal(isKnownCapabilityModel("zhipu", "private-glm"), false);
  const parameters = modelCapabilityParameters("zhipu", "private-glm");
  parameters.limit = { context: 200_000, input: 200_000, output: 131_072 };
  assert.equal(ModelCapabilityParametersSchema.safeParse(parameters).success, true);

  const invalid = structuredClone(parameters);
  invalid.limit.input = 100_000_001;
  const result = ModelCapabilityParametersSchema.safeParse(invalid);
  assert.equal(result.success, false);
});

test("validates a model parameter override envelope", () => {
  const parameters = modelCapabilityParameters("kimi", "kimi-for-coding");
  const valid = ModelParameterOverrideSchema.safeParse({
    model: "kimi-for-coding",
    parameters,
    fields: ["limit.context", "limit.context"],
  });
  assert.equal(valid.success, true);
  if (valid.success) assert.deepEqual(valid.data.fields, ["limit.context"]);

  const invalid = ModelParameterOverrideSchema.safeParse({ model: " ", parameters, fields: [] });
  assert.equal(invalid.success, false);
});
