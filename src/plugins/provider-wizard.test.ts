// Covers provider setup wizard prompts supplied by plugins.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createWizardPrompter } from "../../test/helpers/wizard-prompter.js";
import {
  buildProviderPluginMethodChoice,
  resolveProviderModelPickerEntries,
  resolveProviderPluginChoiceCore,
  runProviderModelSelectedHookCore,
} from "./provider-wizard.js";
import type { ProviderAuthMethod, ProviderPlugin } from "./types.js";

const resolvePluginProvidersCore = vi.hoisted(() => vi.fn<() => ProviderPlugin[]>(() => []));
vi.mock("./providers.runtime.js", () => ({
  isPluginProvidersLoadInFlight: () => false,
  resolvePluginProvidersCore,
}));

const DEFAULT_WORKSPACE_DIR = "/tmp/workspace";

function makeProvider(overrides: Partial<ProviderPlugin> & Pick<ProviderPlugin, "id" | "label">) {
  return {
    auth: [],
    ...overrides,
  } satisfies ProviderPlugin;
}

function auth(id: string, wizard?: ProviderAuthMethod["wizard"]): ProviderAuthMethod {
  return { id, label: id, kind: "custom", run: vi.fn(), ...(wizard ? { wizard } : {}) };
}

describe("manifest auth choice dispatch", () => {
  const manifestChoice = {
    pluginId: "moonshot",
    providerId: "moonshot",
    methodId: "api-key-cn",
    choiceId: "moonshot-api-key-cn",
  };
  const provider = makeProvider({
    id: "moonshot",
    pluginId: "moonshot",
    label: "Moonshot",
    auth: [
      auth("api-key"),
      auth("api-key-cn", {
        groupLabel: "Moonshot",
        modelSelection: { allowKeepCurrent: false },
      }),
    ],
  });

  it("resolves the declared method without a duplicate runtime choice ID", () => {
    expect(
      resolveProviderPluginChoiceCore({
        providers: [{ ...provider, pluginId: "other-plugin" }, provider],
        choice: manifestChoice.choiceId,
        manifestChoice,
      }),
    ).toEqual({ provider, method: provider.auth[1], wizard: provider.auth[1]?.wizard });
  });

  it.each([manifestChoice.choiceId, buildProviderPluginMethodChoice(provider.id, "api-key-cn")])(
    "keeps manifest-owned utility selection on the resolved setup method: %s",
    (choice) => {
      const resolved = resolveProviderPluginChoiceCore({
        providers: [provider],
        choice,
        manifestChoice: { ...manifestChoice, modelTarget: "utility" },
      });
      expect(resolved?.wizard).toMatchObject({
        modelTarget: "utility",
        modelSelection: { allowKeepCurrent: false },
      });
    },
  );

  it.each([
    { pluginId: "other-plugin", providerId: "other-provider", methodId: "api-key-cn" },
    { pluginId: "other-plugin", providerId: "moonshot", methodId: "api-key" },
    { pluginId: "moonshot", providerId: "moonshot", methodId: "api-key-cn" },
  ])(
    "preserves explicit provider-method targets over a conflicting manifest choice: %j",
    (identity) => {
      const choice = buildProviderPluginMethodChoice(provider.id, "api-key");
      expect(
        resolveProviderPluginChoiceCore({
          providers: [{ ...provider, id: "other-provider", pluginId: "other-plugin" }, provider],
          choice,
          manifestChoice: {
            ...manifestChoice,
            ...identity,
            choiceId: choice,
            modelTarget: "utility",
          },
        }),
      ).toEqual({ provider, method: provider.auth[0] });
    },
  );

  it.each([
    { pluginId: "other-plugin" },
    { providerId: "other-provider" },
    { methodId: "missing" },
    { methodId: "" },
    { choiceId: "other-choice" },
  ])("rejects an unmatched manifest identity: %j", (override) => {
    const conflictingRuntime = {
      ...provider,
      auth: provider.auth.map((method) =>
        Object.assign({}, method, { wizard: { choiceId: manifestChoice.choiceId } }),
      ),
    };
    expect(
      resolveProviderPluginChoiceCore({
        providers: [conflictingRuntime],
        choice: manifestChoice.choiceId,
        manifestChoice: { ...manifestChoice, ...override },
      }),
    ).toBeNull();
  });

  it("preserves exact manifest choice dispatch when a provider has the same bare ID", () => {
    const other = { ...provider, id: "other-provider", pluginId: "other-plugin" };
    expect(
      resolveProviderPluginChoiceCore({
        providers: [provider, other],
        choice: provider.id,
        manifestChoice: {
          ...manifestChoice,
          pluginId: other.pluginId,
          providerId: other.id,
          choiceId: provider.id,
        },
      }),
    ).toEqual({ provider: other, method: other.auth[1], wizard: other.auth[1]?.wizard });
  });
});

function createHomeEnv() {
  return { OPENCLAW_HOME: "/tmp/openclaw-home" };
}

describe("provider wizard boundaries", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useRealTimers();
  });

  it.each([
    {
      name: "uses explicit setup choice ids and bound method ids",
      provider: makeProvider({
        id: "vllm",
        label: "vLLM",
        auth: [auth("local"), auth("cloud")],
        wizard: {
          setup: {
            choiceId: "self-hosted-vllm",
            methodId: "local",
            choiceLabel: "vLLM local",
            groupId: "local-runtimes",
            groupLabel: "Local runtimes",
          },
        },
      }),
      choice: "self-hosted-vllm",
      resolveWizard: (provider: ProviderPlugin) => provider.wizard?.setup,
    },
    {
      name: "resolves choices from method-level wizard metadata",
      provider: makeProvider({
        id: "openai",
        label: "OpenAI",
        auth: [
          auth("api-key", {
            choiceId: "openai-api-key",
            choiceLabel: "OpenAI API key",
            groupId: "openai",
            groupLabel: "OpenAI",
            onboardingScopes: ["text-inference", "image-generation"],
            modelAllowlist: {
              allowedKeys: ["openai/fixture"],
              initialSelections: ["openai/fixture"],
              message: "Fixture models",
            },
          }),
        ],
      }),
      choice: "openai-api-key",
      resolveWizard: (provider: ProviderPlugin) => provider.auth[0]?.wizard,
    },
  ] as const)("$name", ({ provider, choice, resolveWizard }) => {
    expect(
      resolveProviderPluginChoiceCore({
        providers: [provider],
        choice,
      }),
    ).toEqual({
      provider,
      method: provider.auth[0],
      wizard: resolveWizard(provider),
    });
  });

  it("builds model-picker entries from plugin metadata and provider-method choices", () => {
    const provider = makeProvider({
      id: "sglang",
      label: "SGLang",
      auth: [auth("server"), auth("cloud")],
      wizard: {
        modelPicker: {
          label: "SGLang server",
          hint: "OpenAI-compatible local runtime",
          methodId: "server",
        },
      },
    });
    const config = {};
    const env = createHomeEnv();
    const params = { config, workspaceDir: DEFAULT_WORKSPACE_DIR, env };
    resolvePluginProvidersCore.mockReturnValue([provider]);
    expect(resolveProviderModelPickerEntries(params)).toEqual([
      {
        value: buildProviderPluginMethodChoice("sglang", "server"),
        label: "SGLang server",
        hint: "OpenAI-compatible local runtime",
      },
    ]);
    expect(resolvePluginProvidersCore).toHaveBeenCalledTimes(1);
    expect(resolvePluginProvidersCore).toHaveBeenCalledWith({
      ...params,
      mode: "setup",
    });
  });

  it("uses the prepared matching provider when the runtime inventory does not contain it", async () => {
    const onModelSelected = vi.fn(async () => {});
    const preparedProvider = makeProvider({ id: "VLLM", label: "vLLM", onModelSelected });
    const prompter = createWizardPrompter();
    await runProviderModelSelectedHookCore({
      config: {},
      model: "vllm/fixture-model",
      prompter,
      env: createHomeEnv(),
      preparedProvider,
    });
    expect(onModelSelected).toHaveBeenCalledOnce();
    expect(onModelSelected).toHaveBeenCalledWith({
      config: {},
      model: "vllm/fixture-model",
      prompter,
      agentDir: undefined,
      workspaceDir: undefined,
    });
    expect(resolvePluginProvidersCore).not.toHaveBeenCalled();
  });

  it("resolves a different model owner instead of using the prepared authentication provider", async () => {
    const matchingHook = vi.fn(async () => {});
    const otherHook = vi.fn(async () => {});
    resolvePluginProvidersCore.mockReturnValue([
      makeProvider({
        id: "ollama",
        label: "Ollama",
        onModelSelected: otherHook,
      }),
      makeProvider({
        id: "vllm",
        label: "vLLM",
        onModelSelected: matchingHook,
      }),
    ]);

    const env = createHomeEnv();
    await runProviderModelSelectedHookCore({
      config: {},
      model: "vllm/qwen3-coder",
      prompter: {} as never,
      agentDir: "/tmp/agent",
      workspaceDir: "/tmp/workspace",
      env,
      preparedProvider: makeProvider({ id: "ollama", label: "Ollama", onModelSelected: otherHook }),
    });

    expect(resolvePluginProvidersCore).toHaveBeenCalledTimes(1);
    expect(resolvePluginProvidersCore).toHaveBeenCalledWith({
      config: {},
      workspaceDir: DEFAULT_WORKSPACE_DIR,
      env,
      mode: "setup",
      providerRefs: ["vllm"],
    });
    expect(matchingHook).toHaveBeenCalledWith({
      config: {},
      model: "vllm/qwen3-coder",
      prompter: {},
      agentDir: "/tmp/agent",
      workspaceDir: "/tmp/workspace",
    });
    expect(otherHook).not.toHaveBeenCalled();
  });
});
