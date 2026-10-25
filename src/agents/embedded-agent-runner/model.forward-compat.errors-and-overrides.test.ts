import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig, OpenClawConfigInput } from "../../config/config.js";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../../config/runtime-snapshot.js";
import { discoverAuthStorageFacts, discoverModelsAsync } from "../agent-model-discovery.js";
import {
  catalogCost,
  configuredPricingCases,
  staleCost,
} from "./model.configured-pricing.test-support.js";
import { createProviderRuntimeTestMock } from "./model.provider-runtime.test-support.js";

vi.mock("../../plugins/provider-runtime.js", () => ({
  applyProviderResolvedTransportWithPlugin: () => undefined,
  buildProviderUnknownModelHintWithPlugin: () => undefined,
  normalizeProviderResolvedModelWithPlugin: () => undefined,
  normalizeProviderTransportWithPlugin: () => undefined,
  prepareProviderDynamicModel: async () => {},
  runProviderDynamicModel: () => undefined,
  shouldPreferProviderRuntimeResolvedModel: () => false,
}));

vi.mock("../auth-profiles.js", () => ({
  loadAuthProfileStoreForRuntimeAsync: async () => ({ version: 1, profiles: {} }),
  resolveAuthProfileOrder: () => [],
}));

// mock-isolation: These resolver cases supply stores; do not initialize a runtime owner.
vi.mock("../prepared-model-runtime.js", () => {
  const unexpected = () => {
    throw new Error("Resolver fixture already supplied discovery stores");
  };
  return {
    getPreparedModelRuntimeSnapshot: unexpected,
    loadPreparedModelRuntimeSnapshot: unexpected,
  };
});

vi.mock("./model.static-catalog.js", () => ({
  resolveBundledProviderStaticCatalogModel: () => undefined,
  resolveBundledStaticCatalogModel: () => undefined,
  resolveManifestModelCatalogProviderAliasMetadata: ({
    provider,
    cfg,
  }: {
    provider: string;
    cfg?: { models?: { providers?: Record<string, { baseUrl?: string }> } };
  }) => ({
    provider,
    ...(provider === "azure-openai-responses" && cfg?.models?.providers?.[provider]?.baseUrl
      ? { transport: { api: "azure-openai-responses" as const } }
      : {}),
  }),
}));

vi.mock("../model-suppression.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../model-suppression.js")>();
  function suppressionError({
    provider,
    id,
    baseUrl,
  }: {
    provider?: string;
    id?: string;
    baseUrl?: string;
  }) {
    if (
      (provider !== "openai" && provider !== "azure-openai-responses") ||
      id?.trim().toLowerCase() !== "gpt-5.3-codex-spark" ||
      (provider === "openai" &&
        baseUrl &&
        new URL(baseUrl).hostname.toLowerCase() !== "api.openai.com")
    ) {
      return undefined;
    }
    return `Unknown model: ${provider}/gpt-5.3-codex-spark. gpt-5.3-codex-spark is available only through ChatGPT/Codex OAuth. Run \`openclaw models auth login --provider openai\` and use openai/gpt-5.3-codex-spark with that OAuth profile; OpenAI API-key auth cannot use this model.`;
  }
  return {
    ...actual,
    resolveBuiltInModelSuppressionFromManifest: (input: Parameters<typeof suppressionError>[0]) => {
      const errorMessage = suppressionError(input);
      return errorMessage ? { suppress: true, errorMessage } : undefined;
    },
    shouldUnconditionallySuppress: () => false,
    buildSuppressedBuiltInModelError: suppressionError,
  };
});

// mock-isolation: Fallback fixtures control discovery results without loading real credentials or model stores.
vi.mock("../agent-model-discovery.js", () => ({
  discoverAuthStorageFacts: vi.fn(() => ({ authStorage: { mocked: true } })),
  discoverModelsAsync: vi.fn(async () => ({ find: vi.fn(() => null) })),
}));

import { resolveModelAsync } from "./model.js";
import {
  buildOpenAICodexForwardCompatExpectation,
  makeModel,
  makeOpenClawConfigFixture,
  mockDiscoveredModel,
  mockOpenAICodexTemplateModel,
  resetMockDiscoverModels,
} from "./model.test-harness.js";

beforeEach(() => {
  resetMockDiscoverModels(discoverModelsAsync);
});
afterEach(clearRuntimeConfigSnapshot);

async function resolveModelForTest(provider: string, modelId: string, cfg?: OpenClawConfig) {
  const agentDir = "/tmp/agent";
  const { authStorage } = await discoverAuthStorageFacts(agentDir);
  const modelRegistry = await discoverModelsAsync(authStorage, agentDir, { config: cfg ?? {} });
  return resolveModelAsync(provider, modelId, agentDir, cfg, {
    authStorage,
    modelRegistry,
    runtimeHooks: createProviderRuntimeTestMock({
      handledDynamicProviders: ["google-antigravity", "zai", "openai"],
    }),
  });
}

const spark = "gpt-5.3-codex-spark";
const directRoute = { api: "openai-responses", baseUrl: "https://api.openai.com/v1" } as const;
const proxyRoute = { ...directRoute, baseUrl: "https://proxy.example/v1" };
const codexRuntime = {
  agents: { defaults: { models: { [`openai/${spark}`]: { agentRuntime: { id: "codex" } } } } },
} satisfies OpenClawConfig;
function configWithProvider(
  provider: string,
  overrides: NonNullable<NonNullable<OpenClawConfigInput["models"]>["providers"]>[string],
): OpenClawConfig {
  return makeOpenClawConfigFixture({
    models: { providers: { [provider]: { models: [], ...overrides } } },
  });
}
function mockSpark() {
  mockDiscoveredModel(discoverModelsAsync, {
    provider: "openai",
    modelId: spark,
    templateModel: { ...makeModel(spark), provider: "openai", ...directRoute },
  });
}
const resolveSpark = (cfg?: OpenClawConfig) => resolveModelForTest("openai", spark, cfg);

describe("resolveModel forward-compat errors and overrides", () => {
  it.each(configuredPricingCases)(
    "resolves authored $name cost over the complete discovered schedule",
    async ({
      expected,
      sourceModels = [],
      provider = "pricing-fixture",
      modelId = "priced-model",
    }) => {
      const model = {
        ...makeModel(modelId),
        api: "openai-completions" as const,
        input: ["text", "image"] as Array<"text" | "image">,
        contextWindow: 8192,
        maxTokens: 512,
        compat: { supportsTools: false },
        cost: staleCost,
      };
      const providerConfig = { baseUrl: "https://models.example/v1", models: [model] };
      const runtime: OpenClawConfig = { models: { providers: { [provider]: providerConfig } } };
      const source = {
        models: {
          providers: {
            [` ${provider.toUpperCase()} `]: { ...providerConfig, models: sourceModels },
          },
        },
      } as unknown as OpenClawConfig;
      const catalogModel = {
        ...model,
        id: modelId,
        provider,
        baseUrl: providerConfig.baseUrl,
        cost: catalogCost,
      };
      mockDiscoveredModel(discoverModelsAsync, { provider, modelId, templateModel: catalogModel });
      setRuntimeConfigSnapshot(runtime, source);

      for (const cfg of [runtime, structuredClone(runtime)]) {
        const result = await resolveModelForTest(provider, modelId, cfg);
        expect(result.error).toBeUndefined();
        expect(result.model).toMatchObject({
          provider,
          id: modelId,
          input: model.input,
          contextWindow: 8192,
          maxTokens: 512,
          compat: { supportsTools: false },
        });
        expect(result.model?.cost).toEqual(expected);
      }
    },
  );

  it("resolves suppressed openai gpt-5.3-codex-spark through model-scoped Codex runtime", async () => {
    mockOpenAICodexTemplateModel(discoverModelsAsync);
    const result = await resolveSpark(codexRuntime);
    expect(result.error).toBeUndefined();
    expect(result.model).toMatchObject(buildOpenAICodexForwardCompatExpectation(spark));
  });

  it("keeps model-scoped Codex runtime blocked for explicit OpenAI API-key provider config", async () => {
    mockOpenAICodexTemplateModel(discoverModelsAsync);
    const result = await resolveSpark({
      ...codexRuntime,
      ...configWithProvider("openai", { ...directRoute, auth: "api-key" }),
    });
    expect(result.model).toBeUndefined();
    expect(result.error).toContain("OpenAI API-key auth cannot use this model");
  });

  it("rejects configured direct openai gpt-5.3-codex-spark rows", async () => {
    const result = await resolveSpark(
      configWithProvider("openai", {
        ...directRoute,
        models: [{ ...makeModel(spark), ...directRoute }],
      }),
    );
    expect(result.model).toBeUndefined();
    expect(result.error).toContain("ChatGPT/Codex OAuth");
    expect(result.error).toContain("OpenAI API-key auth cannot use this model");
  });

  it("keeps registry openai gpt-5.3-codex-spark rows on custom provider endpoints", async () => {
    mockSpark();
    const result = await resolveSpark(configWithProvider("openai", proxyRoute));
    expect(result.error).toBeUndefined();
    expect(result.model).toMatchObject({ provider: "openai", id: spark, ...proxyRoute });
  });

  it("uses retained azure alias transport defaults for provider-level deployment names", async () => {
    const baseUrl = "https://example.openai.azure.com/openai/v1";
    const result = await resolveModelForTest(
      "azure-openai-responses",
      "customer-gpt-deployment",
      configWithProvider("azure-openai-responses", { baseUrl }),
    );
    expect(result.error).toBeUndefined();
    expect(result.model).toMatchObject({
      provider: "azure-openai-responses",
      id: "customer-gpt-deployment",
      api: "azure-openai-responses",
      baseUrl,
    });
  });

  it("uses codex fallback when inline model omits api (#39682)", async () => {
    mockOpenAICodexTemplateModel(discoverModelsAsync);
    const result = await resolveModelForTest(
      "openai",
      "gpt-5.4",
      configWithProvider("openai", {
        baseUrl: "https://custom.example.com",
        headers: { "X-Custom-Auth": "token-123" },
        models: [makeModel("gpt-5.4")],
      }),
    );
    expect(result.error).toBeUndefined();
    expect(result.model).toMatchObject({
      api: "openai-chatgpt-responses",
      baseUrl: "https://custom.example.com",
      id: "gpt-5.4",
      provider: "openai",
    });
    expect(result.model?.headers).toEqual({ "X-Custom-Auth": "token-123" });
  });

  it("includes auth hint for unknown ollama models (#17328)", async () => {
    const result = await resolveModelForTest("ollama", "gemma3:4b");
    expect(result.model).toBeUndefined();
    expect(result.error).toContain("Unknown model: ollama/gemma3:4b");
    expect(result.error).toContain("OLLAMA_API_KEY");
    expect(result.error).toContain("docs.openclaw.ai/providers/ollama");
  });
});
