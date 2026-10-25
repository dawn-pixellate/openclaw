import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { createApiKeyCredential } from "../auth-profiles/credential-fixtures.test-support.js";
import { makeAssistantMessageFixture } from "../test-helpers/assistant-message-fixtures.js";
import { createModelFallbackConfig } from "../test-helpers/model-fallback-config-fixture.js";
import { makeAttemptResult } from "./run.overflow-compaction.fixture.js";
import {
  MockedFailoverError,
  mockedClassifyFailoverReason,
  mockedEnsureAuthProfileStore,
  mockedEnsureAuthProfileStoreWithoutExternalProfiles,
  mockedFormatAssistantErrorText,
  mockedGlobalHookRunner,
  mockedIsFailoverAssistantError,
  mockedIsRateLimitAssistantError,
  mockedRunEmbeddedAttempt,
  mockedResolveAuthProfileOrder,
  createOverflowRunParams,
  resetSharedRunIntegrationHarnessMocks,
  warmRunOverflowCompactionHarness,
} from "./run.overflow-compaction.harness.js";
import { loadSharedRunIntegrationHarness } from "./run.shared-integration-harness.test-support.js";
import type { EmbeddedRunAttemptResult } from "./run/types.js";

let state: OpenClawTestState;
let runEmbeddedAgent: Awaited<ReturnType<typeof loadSharedRunIntegrationHarness>>;
const DEEPSEEK_ERROR_MESSAGE = "429 insufficient quota";
const COMPACTION_REMOVED_ERROR_MESSAGE = "current candidate model unavailable";
type CurrentAttemptAssistantWithError = NonNullable<
  EmbeddedRunAttemptResult["currentAttemptAssistant"]
> & { errorMessage: string };

function isCurrentAttemptAssistant(value: unknown): value is CurrentAttemptAssistantWithError {
  return (
    typeof value === "object" &&
    value !== null &&
    "provider" in value &&
    "model" in value &&
    "errorMessage" in value &&
    typeof value.errorMessage === "string"
  );
}

const makeCandidateAssistant = (overrides: Parameters<typeof makeAssistantMessageFixture>[0]) =>
  makeAssistantMessageFixture({
    provider: "deepseek",
    model: "deepseek-chat",
    content: [],
    ...overrides,
  });
const staleQuotaAssistant = () =>
  makeCandidateAssistant({
    provider: "openai",
    model: "gpt-5.4",
    errorMessage: "You exceeded your current OpenAI quota.",
  });

function setupDeepseekFallbackErrorMatchers() {
  const isDeepseek = (value: unknown) =>
    isCurrentAttemptAssistant(value) && value.provider === "deepseek";
  mockedIsFailoverAssistantError.mockImplementation(isDeepseek);
  mockedIsRateLimitAssistantError.mockImplementation(isDeepseek);
  mockedClassifyFailoverReason.mockReturnValue("rate_limit");
}

function captureFormattedAssistant() {
  let lastFormattedAssistant: unknown;
  mockedFormatAssistantErrorText.mockImplementation((...args: unknown[]) => {
    lastFormattedAssistant = args[0];
    if (!isCurrentAttemptAssistant(lastFormattedAssistant)) {
      return String(lastFormattedAssistant);
    }
    return `${lastFormattedAssistant.provider}/${lastFormattedAssistant.model}: ${lastFormattedAssistant.errorMessage}`;
  });
  return () => lastFormattedAssistant;
}

function makeCrossProviderFallbackConfig() {
  return createModelFallbackConfig("openai/gpt-5.4", [
    "deepseek/deepseek-chat",
    "google/gemini-2.5-flash",
  ]);
}

function makeFallbackRunParams(
  runId: string,
  ownedState = state,
  provider = "deepseek",
  model = "deepseek-chat",
) {
  return {
    ...createOverflowRunParams(ownedState),
    runId,
    config: makeCrossProviderFallbackConfig(),
    agentHarnessRuntimeOverride: "openclaw",
    provider,
    model,
    authProfileId: `${provider}:test`,
    authProfileIdSource: "user",
    modelFallbacksOverride: ["deepseek/deepseek-chat"],
  } satisfies Parameters<typeof runEmbeddedAgent>[0];
}

function useCrossProviderAuthFixture() {
  const store = {
    version: 1 as const,
    profiles: {
      "anthropic:test": createApiKeyCredential("anthropic", "fixture"),
      "deepseek:test": createApiKeyCredential("deepseek", "fixture"),
    },
  };
  mockedEnsureAuthProfileStore.mockReturnValue(store);
  mockedEnsureAuthProfileStoreWithoutExternalProfiles.mockReturnValue(store);
  mockedResolveAuthProfileOrder.mockImplementation((params?: unknown) => {
    const provider = (params as { provider?: string } | undefined)?.provider;
    return provider && `${provider}:test` in store.profiles ? [`${provider}:test`] : [];
  });
}

function setupCompactionRemovedFallbackAttempt() {
  mockedIsFailoverAssistantError.mockImplementation((...args: unknown[]) => {
    const assistant = args[0];
    return isCurrentAttemptAssistant(assistant) && assistant.provider === "anthropic";
  });
  mockedClassifyFailoverReason.mockReturnValue("model_not_found");
  const assistant = makeAssistantMessageFixture({
    stopReason: "error",
    errorMessage: COMPACTION_REMOVED_ERROR_MESSAGE,
    provider: "anthropic",
    model: "test-model",
    content: [],
  });
  // The pinned profile may rotate to another same-provider credential before
  // the outer model fallback runs, so every credential attempt must fail alike.
  mockedRunEmbeddedAttempt.mockResolvedValue(
    makeAttemptResult({
      assistantTexts: [],
      lastAssistant: assistant,
      currentAttemptAssistant: undefined,
      currentAttemptCompletedAssistant: assistant,
    }),
  );
}

const runCompactionRemovedFallbackAttempt = (ownedState: OpenClawTestState) =>
  runEmbeddedAgent(
    makeFallbackRunParams(
      "run-compaction-fallback-error-context",
      ownedState,
      "anthropic",
      "test-model",
    ),
  );

describe("runEmbeddedAgent cross-provider fallback error handling", () => {
  beforeAll(async () => {
    runEmbeddedAgent = await loadSharedRunIntegrationHarness();
    const { withOpenClawTestState } = await import("../../test-utils/openclaw-test-state.js");
    await withOpenClawTestState({ label: "cross-provider-warmup" }, async (warmupState) => {
      const { setRuntimeConfigSnapshot } = await import("../../config/runtime-snapshot.js");
      setRuntimeConfigSnapshot(makeCrossProviderFallbackConfig());
      await warmRunOverflowCompactionHarness(runEmbeddedAgent, warmupState, {
        config: makeCrossProviderFallbackConfig(),
        agentHarnessRuntimeOverride: "openclaw",
        provider: "deepseek",
        model: "deepseek-chat",
      });
      setupCompactionRemovedFallbackAttempt();
      await runCompactionRemovedFallbackAttempt(warmupState).catch(() => undefined);
    });
  });

  beforeEach(async () => {
    resetSharedRunIntegrationHarnessMocks();
    const { createOpenClawTestState } = await import("../../test-utils/openclaw-test-state.js");
    state = await createOpenClawTestState({ label: "run.cross-provider-fallback-error-context" });
    const { setRuntimeConfigSnapshot } = await import("../../config/runtime-snapshot.js");
    setRuntimeConfigSnapshot(makeCrossProviderFallbackConfig());
    useCrossProviderAuthFixture();
    mockedGlobalHookRunner.hasHooks.mockImplementation(() => false);
  });

  afterEach(async () => {
    await state?.cleanup();
  });

  it("uses the current attempt assistant for fallback errors instead of stale session history", async () => {
    setupDeepseekFallbackErrorMatchers();
    mockedRunEmbeddedAttempt.mockResolvedValueOnce(
      makeAttemptResult({
        assistantTexts: [],
        lastAssistant: makeCandidateAssistant({
          errorMessage: "You have hit your ChatGPT usage limit (plus plan).",
          provider: "openai",
          model: "gpt-5.4",
        }),
        currentAttemptAssistant: makeCandidateAssistant({ errorMessage: DEEPSEEK_ERROR_MESSAGE }),
      }),
    );

    const promise = runEmbeddedAgent(
      makeFallbackRunParams("run-cross-provider-fallback-error-context"),
    );

    await expect(promise).rejects.toBeInstanceOf(MockedFailoverError);
    await expect(promise).rejects.toThrow("deepseek (deepseek-chat) returned a billing error");
    expect(mockedIsRateLimitAssistantError).toHaveBeenCalledTimes(1);
    expect(mockedIsRateLimitAssistantError.mock.calls.at(-1)?.[0]).toMatchObject({
      provider: "deepseek",
      model: "deepseek-chat",
      errorMessage: DEEPSEEK_ERROR_MESSAGE,
    });
  });

  it("uses the completed assistant when compaction removes the current attempt slice", async () => {
    const getLastFormattedAssistant = captureFormattedAssistant();
    setupCompactionRemovedFallbackAttempt();
    const promise = runCompactionRemovedFallbackAttempt(state);

    await expect(promise).rejects.toBeInstanceOf(MockedFailoverError);
    await expect(promise).rejects.toThrow(
      "⚠️ OpenClaw couldn't finish this reply. For details, open Settings → Logs in the Control UI or run `openclaw logs --follow` in your terminal.",
    );
    expect(mockedIsFailoverAssistantError).toHaveBeenCalledTimes(2);
    expect(getLastFormattedAssistant()).toMatchObject({
      provider: "anthropic",
      model: "test-model",
      errorMessage: COMPACTION_REMOVED_ERROR_MESSAGE,
    });
  });

  it("does not reuse a prior provider session assistant when the current candidate times out", async () => {
    const getLastFormattedAssistant = captureFormattedAssistant();
    mockedRunEmbeddedAttempt.mockResolvedValueOnce(
      makeAttemptResult({
        assistantTexts: [],
        terminal: { kind: "timeout", phase: "prompt", source: "runtime" },
        lastAssistant: staleQuotaAssistant(),
        currentAttemptAssistant: undefined,
      }),
    );

    const promise = runEmbeddedAgent(makeFallbackRunParams("run-stale-session-assistant-timeout"));

    await expect(promise).rejects.toBeInstanceOf(MockedFailoverError);
    await expect(promise).rejects.toThrow("LLM request timed out.");
    await expect(promise).rejects.not.toThrow("OpenAI quota");
    expect(getLastFormattedAssistant()).toBeUndefined();
  });

  it("does not reuse a prior provider session assistant for non-timeout failover", async () => {
    mockedIsFailoverAssistantError.mockImplementation((...args: unknown[]) => {
      const assistant = args[0];
      return isCurrentAttemptAssistant(assistant) && assistant.errorMessage.includes("quota");
    });
    const getLastFormattedAssistant = captureFormattedAssistant();
    mockedRunEmbeddedAttempt.mockResolvedValueOnce(
      makeAttemptResult({
        assistantTexts: [],
        lastAssistant: staleQuotaAssistant(),
        currentAttemptAssistant: undefined,
      }),
    );

    const result = await runEmbeddedAgent(
      makeFallbackRunParams("run-stale-session-assistant-non-timeout"),
    );

    expect(mockedIsFailoverAssistantError).toHaveBeenCalledWith(undefined);
    expect(getLastFormattedAssistant()).toBeUndefined();
    expect(result.meta.finalAssistantVisibleText).toBeUndefined();
    expect(result.meta.terminalReply).toEqual({ disposition: "empty" });
    expect(result.meta.agentMeta).toMatchObject({
      provider: "deepseek",
      model: "deepseek-chat",
    });
  });

  it("does not present stale successful-assistant errors as the current timeout", async () => {
    mockedRunEmbeddedAttempt.mockResolvedValueOnce(
      makeAttemptResult({
        assistantTexts: [],
        terminal: { kind: "timeout", phase: "prompt", source: "runtime" },
        currentAttemptAssistant: makeCandidateAssistant({
          stopReason: "stop",
          errorMessage: "500 stale provider diagnostic",
        }),
      }),
    );

    const promise = runEmbeddedAgent(
      makeFallbackRunParams("run-successful-assistant-stale-error-timeout"),
    );

    await expect(promise).rejects.toBeInstanceOf(MockedFailoverError);
    await expect(promise).rejects.toThrow("LLM request timed out.");
    await expect(promise).rejects.not.toThrow("500");
    await expect(promise).rejects.not.toThrow("stale provider diagnostic");
  });

  it("does not retry successful replies for stale unsupported-thinking errors", async () => {
    const helpers = await import("../embedded-agent-helpers/thinking.js");
    const thinking = await vi.importActual<typeof import("../embedded-agent-helpers/thinking.js")>(
      "../embedded-agent-helpers/thinking.js",
    );
    const thinkingMock = vi.mocked(helpers.pickFallbackThinkingLevel);
    const previousThinking = thinkingMock.getMockImplementation();
    thinkingMock.mockImplementation(thinking.pickFallbackThinkingLevel);
    try {
      mockedRunEmbeddedAttempt.mockResolvedValue(
        makeAttemptResult({
          assistantTexts: ["Successful reply"],
          currentAttemptAssistant: makeCandidateAssistant({
            stopReason: "stop",
            errorMessage: 'think value "high" is not supported for this model',
            content: [{ type: "text", text: "Successful reply" }],
          }),
        }),
      );

      const result = await runEmbeddedAgent({
        ...createOverflowRunParams(state),
        runId: "run-successful-assistant-stale-thinking",
        config: makeCrossProviderFallbackConfig(),
        agentHarnessRuntimeOverride: "openclaw",
        provider: "deepseek",
        model: "deepseek-chat",
        thinkLevel: "high",
        authProfileId: "deepseek:test",
        authProfileIdSource: "user",
      });

      expect(mockedRunEmbeddedAttempt).toHaveBeenCalledOnce();
      expect(result.meta.finalAssistantVisibleText).toBe("Successful reply");
    } finally {
      thinkingMock.mockReset();
      if (previousThinking) {
        thinkingMock.mockImplementation(previousThinking);
      }
    }
  });
});
