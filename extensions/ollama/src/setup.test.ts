import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import type { WizardPrompter } from "openclaw/plugin-sdk/setup";
import { jsonResponse, requestBodyText, requestUrl } from "openclaw/plugin-sdk/test-env";
import { oversizedJsonResponse } from "openclaw/plugin-sdk/test-fixtures";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ensureOllamaModelPulled, promptAndConfigureOllama } from "./setup.js";
import { checkOllamaCloudAuth } from "./setup.runtime.js";
import {
  configureInteractive,
  createLocalPrompter,
  createOllamaFetchMock,
  startNonInteractive,
} from "./setup.test-support.js";

const fetchWithSsrFGuardMock = vi.hoisted(() =>
  vi.fn(async (params: { url: string; init?: RequestInit; signal?: AbortSignal }) => ({
    response: await globalThis.fetch(params.url, {
      ...params.init,
      ...(params.signal ? { signal: params.signal } : {}),
    }),
    finalUrl: params.url,
    release: async () => {},
  })),
);

vi.mock("openclaw/plugin-sdk/ssrf-runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/ssrf-runtime")>();
  return {
    ...actual,
    fetchWithSsrFGuard: fetchWithSsrFGuardMock,
  };
});

function mockCallArg(mock: { mock: { calls: unknown[][] } }, index = 0, argIndex = 0) {
  return mock.mock.calls.at(index)?.at(argIndex);
}

function createDefaultOllamaConfig(primary: string) {
  return {
    agents: { defaults: { model: { primary } } },
    models: { providers: { ollama: { baseUrl: "http://127.0.0.1:11434", models: [] } } },
  };
}

function ensurePulled(model: string, prompter: WizardPrompter) {
  return ensureOllamaModelPulled({ config: createDefaultOllamaConfig(model), model, prompter });
}

function pendingResponse(signal: AbortSignal | null | undefined) {
  return new Promise<Response>((_resolve, reject) => {
    if (!signal) {
      reject(new Error("expected setup abort signal"));
      return;
    }
    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  });
}

function startAbortableSetup(
  options: Parameters<typeof createOllamaFetchMock>[0],
  prompter: WizardPrompter,
  shouldPause: (url: string, body: string) => boolean,
) {
  const controller = new AbortController();
  const started = createDeferred<void>();
  const baseFetch = createOllamaFetchMock(options);
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      if (!shouldPause(requestUrl(input), requestBodyText(init?.body))) {
        return baseFetch(input, init);
      }
      started.resolve();
      return pendingResponse(init?.signal);
    }),
  );
  return {
    controller,
    started: started.promise,
    setup: promptAndConfigureOllama({ cfg: {}, prompter, signal: controller.signal }),
  };
}

function configuredModel(
  config: Parameters<typeof ensureOllamaModelPulled>[0]["config"],
  id: string,
) {
  return config.models?.providers?.ollama?.models?.find((model) => model.id === id);
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  fetchWithSsrFGuardMock.mockClear();
});

describe("ollama setup", () => {
  it("Docker setup hints the host Ollama endpoint and uses it for blank input", async () => {
    vi.stubEnv("OPENCLAW_DOCKER_SETUP", "1");
    const text = vi.fn().mockResolvedValueOnce("");
    const { result } = await configureInteractive({ tags: ["llama3:8b"] }, { text });
    const baseUrlPrompt = mockCallArg(text) as {
      initialValue?: string;
      placeholder?: string;
      validate: (value: string) => string | undefined;
    };
    expect(baseUrlPrompt.initialValue).toBeUndefined();
    expect(baseUrlPrompt).toMatchObject({
      message: "Ollama base URL",
      placeholder: "http://host.docker.internal:11434",
    });
    expect(baseUrlPrompt.validate("https://ollama.com")).toContain("--auth-choice ollama-cloud");
    expect(result.config.models?.providers?.ollama?.baseUrl).toBe(
      "http://host.docker.internal:11434",
    );
  });

  it.each([true, false])(
    "uses hybrid cloud suggestions only when signed in: %s",
    async (signedIn) => {
      const { result, prompter } = await configureInteractive(
        {
          tags: ["llama3:8b"],
          meResponse: signedIn
            ? jsonResponse({ user: "signed-in" })
            : Response.json({ signin_url: "https://ollama.com/signin" }, { status: 401 }),
        },
        { select: vi.fn().mockResolvedValueOnce("cloud-local") },
      );
      const provider = result.config.models?.providers?.ollama;
      const ids = provider?.models?.map((m) => m.id) ?? [];
      expect(ids[0]).toBe("gemma4");
      expect(ids.at(-1)).toBe("llama3:8b");
      expect(ids.some((id) => id.endsWith(":cloud"))).toBe(signedIn);
      expect(provider).toMatchObject({ baseUrl: "http://127.0.0.1:11434", apiKey: "ollama-local" });
      if (!signedIn) {
        expect(prompter.note).toHaveBeenCalledWith(
          expect.stringContaining("https://ollama.com/signin"),
          "Ollama Cloud + Local",
        );
      }
    },
  );

  it("reports the configured host when the retry is still unreachable", async () => {
    const prompter = createLocalPrompter();
    prompter.confirm = vi.fn().mockResolvedValueOnce(true);
    const fetchMock = createOllamaFetchMock({ tagsError: new Error("down") });
    vi.stubGlobal("fetch", fetchMock);
    await expect(promptAndConfigureOllama({ cfg: {}, prompter })).rejects.toThrow(
      "Ollama is still not reachable at http://127.0.0.1:11434",
    );
  });

  it.each([true, false])(
    "offers a recommended pull and honors acceptance: %s",
    async (accepted) => {
      const progress = { update: vi.fn(), stop: vi.fn() };
      const { result, prompter, fetchMock } = await configureInteractive(
        {
          tags: ["llama3:8b"],
          show: { "gemma4:e4b": 131072 },
          capabilities: { "llama3:8b": ["generate"], "gemma4:e4b": ["tools"] },
          pullResponse: new Response(
            [
              '{"status":"pulling sha256:12345678","total":100,"completed":50}',
              '{"status":"pulling sha256:12345678","total":100,"completed":100}',
              '{"status":"success"}',
              "",
            ].join("\n"),
            { status: 200 },
          ),
        },
        {
          confirm: vi.fn().mockResolvedValueOnce(accepted),
          progress: vi.fn(() => progress),
        },
      );

      expect(prompter.confirm).toHaveBeenCalledWith(
        expect.objectContaining({ initialValue: false }),
      );
      const pullCall = fetchMock.mock.calls.find((call) =>
        requestUrl(call[0]).endsWith("/api/pull"),
      );
      if (!accepted) {
        expect(pullCall).toBeUndefined();
        return;
      }
      expect(pullCall).toBeDefined();
      expect(JSON.parse(requestBodyText(pullCall?.[1]?.body))).toEqual({ model: "gemma4:e4b" });
      expect(progress.update).toHaveBeenCalledWith("Downloading gemma4:e4b - pulling part - 50%");
      expect(progress.stop).toHaveBeenCalledWith("Downloaded gemma4:e4b");
      expect(configuredModel(result.config, "gemma4:e4b")).toMatchObject({
        contextWindow: 131072,
        compat: { supportsTools: true },
      });
      expect(result.defaultModel).toBe("ollama/gemma4:e4b");
    },
  );

  it("skips a broken model and continues setup when one inspection fails", async () => {
    const { result, prompter } = await configureInteractive(
      {
        tags: ["broken:20b", "gemma4:e4b"],
        showResponse: (model) =>
          model === "broken:20b"
            ? new Response("boom", { status: 500 })
            : jsonResponse({ capabilities: ["tools"] }),
      },
      { confirm: vi.fn() },
    );

    expect(prompter.confirm).not.toHaveBeenCalled();
    expect(prompter.note).toHaveBeenCalledWith(expect.stringContaining("broken:20b"), "Ollama");
    expect(configuredModel(result.config, "gemma4:e4b")).toMatchObject({
      compat: { supportsTools: true },
    });
    expect(configuredModel(result.config, "broken:20b")).toMatchObject({
      compat: { supportsTools: false },
    });
  });

  it("checks all installed Ollama models before offering a recommended pull", async () => {
    const tags = Array.from({ length: 201 }, (_, index) => `model-${index}`);
    const capabilities = Object.fromEntries(
      tags.map((name, index) => [name, index === 200 ? ["tools"] : ["generate"]]),
    );
    const { result, prompter } = await configureInteractive(
      { tags, capabilities },
      { confirm: vi.fn() },
    );

    expect(prompter.confirm).not.toHaveBeenCalled();
    expect(configuredModel(result.config, "model-200")).toMatchObject({
      compat: { supportsTools: true },
    });
  });

  it("aborts the exhaustive tools-capability scan with the setup session", async () => {
    const prompter = createLocalPrompter({ confirm: vi.fn() });
    const tags = Array.from({ length: 201 }, (_, index) => `model-${index}`);
    const capabilities = Object.fromEntries(tags.map((name) => [name, ["generate"]]));
    const { setup, started, controller } = startAbortableSetup(
      { tags, capabilities },
      prompter,
      (url, body) => url.endsWith("/api/show") && JSON.parse(body).model === "model-200",
    );
    await started;
    controller.abort();
    await expect(setup).rejects.toMatchObject({ name: "AbortError" });
    expect(prompter.confirm).not.toHaveBeenCalled();
  });

  it("aborts a recommended Ollama pull when the setup session is cancelled", async () => {
    const progress = { update: vi.fn(), stop: vi.fn() };
    const prompter = createLocalPrompter({
      confirm: vi.fn().mockResolvedValueOnce(true),
      progress: vi.fn(() => progress),
    });
    const { setup, started, controller } = startAbortableSetup(
      { tags: ["llama3:8b"], capabilities: { "llama3:8b": ["generate"] } },
      prompter,
      (url) => url.endsWith("/api/pull"),
    );
    await started;
    controller.abort();
    await expect(setup).rejects.toThrow("Failed to download recommended Ollama model");
    expect(progress.stop).toHaveBeenCalledWith(expect.stringContaining("Failed to download"));
  });

  describe("ensureOllamaModelPulled", () => {
    it("propagates failed selected-model pulls as wizard cancellation", async () => {
      vi.stubGlobal(
        "fetch",
        createOllamaFetchMock({
          tags: [],
          pullResponse: new Response('{"error":"disk full"}\n'),
        }),
      );
      const prompter = createLocalPrompter({
        progress: () => ({ update: vi.fn(), stop: vi.fn() }),
      });
      const pull = ensurePulled("ollama/gemma4", prompter);
      await expect(pull).rejects.toBeInstanceOf(Error);
      await expect(pull).rejects.toMatchObject({
        name: "WizardCancelledError",
        message: "Failed to download selected Ollama model",
      });
    });

    it.each([
      ["ollama/Gemma4", 1],
      ["ollama/kimi-k2.5:cloud", 0],
      ["openai/gpt-4o", 0],
    ] as const)("skips pull for %s", async (model, requests) => {
      const fetchMock = requests ? createOllamaFetchMock({ tags: ["gemma4:latest"] }) : vi.fn();
      vi.stubGlobal("fetch", fetchMock);
      await ensurePulled(model, createLocalPrompter());
      expect(fetchMock).toHaveBeenCalledTimes(requests);
    });
  });

  it("keeps ollama.com out of the local provider in non-interactive setup", async () => {
    const { fetchMock, configure } = startNonInteractive({ tags: ["kimi-k3"] });
    await expect(
      configure({ customBaseUrl: "https://ollama.com", customModelId: "kimi-k3" }),
    ).rejects.toThrow("--auth-choice ollama-cloud");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    ["downloaded", "llama3.2:latest", 0, 16_384, 16_384],
    ["past discovery limit", "gemma4:e2b", 200, 131_072, 32_768],
  ] as const)(
    "preserves a %s explicit model's capabilities",
    async (_label, modelId, preceding, contextWindow, contextTokens) => {
      const { fetchMock, configure } = startNonInteractive({
        tags: preceding
          ? [...Array.from({ length: preceding }, (_, index) => `other-${index}`), modelId]
          : [],
        fallbackCapabilities: preceding > 0,
        show: { [modelId]: contextWindow },
        capabilities: { [modelId]: ["completion", "tools", "vision", "thinking"] },
      });
      const result = await configure({ customModelId: `  OLLAMA/${modelId}  ` });
      if (!preceding) {
        const pullRequest = mockCallArg(fetchMock, 1, 1) as RequestInit | undefined;
        expect(JSON.parse(requestBodyText(pullRequest?.body))).toEqual({ model: modelId });
      }
      expect(result.agents?.defaults?.model).toEqual({ primary: `ollama/${modelId}` });
      const models = preceding
        ? [configuredModel(result, modelId)]
        : result.models?.providers?.ollama?.models;
      expect(models).toEqual([
        expect.objectContaining({
          id: modelId,
          input: ["text", "image"],
          reasoning: true,
          contextWindow,
          contextTokens,
          compat: expect.objectContaining({ supportsTools: true }),
        }),
      ]);
    },
  );

  it("accepts cloud model kimi-k2.5:cloud in non-interactive mode without pulling", async () => {
    const modelId = "kimi-k2.5:cloud";
    const { fetchMock, configure } = startNonInteractive({ tags: [] });
    const result = await configure({ customModelId: modelId });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result.models?.providers?.ollama?.models?.map((model) => model.id)).toContain(modelId);
    expect(result.agents?.defaults?.model).toEqual({ primary: `ollama/${modelId}` });
  });
});

describe("checkOllamaCloudAuth", () => {
  it("bounds oversized 401 body and cancels the stream", async () => {
    const oversized = oversizedJsonResponse({ chunkCount: 64, chunkSize: 1024 * 1024 });

    fetchWithSsrFGuardMock.mockResolvedValueOnce({
      response: new Response(oversized.response.body, {
        status: 401,
        headers: { "Content-Type": "application/json" },
      }),
      finalUrl: "https://ollama.com/api/me",
      release: async () => {},
    });
    await expect(checkOllamaCloudAuth("https://ollama.com")).resolves.toEqual({
      signedIn: false,
      signinUrl: undefined,
    });

    expect(oversized.getReadCount()).toBeLessThan(64);
    expect(oversized.wasCanceled()).toBe(true);
  });
});

describe("Ollama non-interactive onboarding", () => {
  it("propagates unreachable guidance without exiting or persisting", async () => {
    const { configure, runtime, nextConfig } = startNonInteractive({
      tagsError: new Error("connect ECONNREFUSED"),
    });
    await expect(
      configure({ customBaseUrl: "http://127.0.0.1:11435", customModelId: "llama3.2:latest" }),
    ).rejects.toThrow(
      "Ollama could not be reached at http://127.0.0.1:11435.\nStart or restart the Ollama server for this address.\nIf Ollama is not installed on that machine, download it at https://ollama.com/download",
    );
    expect(runtime.error).not.toHaveBeenCalled();
    expect(runtime.exit).not.toHaveBeenCalled();
    expect(nextConfig).toEqual({});
  });

  it("rejects an explicitly selected embedding-only model despite advertised tools", async () => {
    const { configure, runtime, nextConfig } = startNonInteractive(
      {
        tags: ["embedding-model"],
        capabilities: { "embedding-model": ["embedding", "tools"] },
        fallbackCapabilities: true,
      },
      { agents: { defaults: { model: { primary: "ollama/qwen3:1.7b" } } } },
    );
    await expect(configure({ customModelId: "embedding-model" })).rejects.toThrow(
      "Ollama model embedding-model only supports embeddings. Choose a chat model instead.",
    );
    expect(nextConfig).toEqual({
      agents: { defaults: { model: { primary: "ollama/qwen3:1.7b" } } },
    });
    expect(runtime.exit).not.toHaveBeenCalled();
  });

  it("does not persist unavailable local models when the model pull ends before success", async () => {
    const { configure, runtime, nextConfig } = startNonInteractive({
      tags: [],
      pullResponse: new Response('{"status":"pulling manifest"}\n'),
      fallbackCapabilities: true,
    });
    await expect(configure({ customModelId: "missing-model" })).rejects.toThrow(
      "No Ollama chat models are available at http://127.0.0.1:11434.\nPull a chat model first, then re-run setup.",
    );
    expect(runtime.error).toHaveBeenCalledWith(
      "Failed to download missing-model: pull stream ended before success",
    );
    expect(runtime.log).not.toHaveBeenCalledWith("Downloaded missing-model");
    expect(runtime.exit).not.toHaveBeenCalled();
    expect(nextConfig).toEqual({});
  });

  it("handles embedding models before chat when a requested download fails", async () => {
    const embeddingNames = Array.from({ length: 201 }, (_, index) => `embedding-${index}`);
    const { configure, runtime } = startNonInteractive(
      {
        fallbackCapabilities: true,
        tags: [...embeddingNames, "qwen2.5-coder:7b"],
        capabilities: {
          ...Object.fromEntries(embeddingNames.map((name) => [name, ["embedding", "tools"]])),
          "qwen2.5-coder:7b": ["tools"],
        },
        pullResponse: new Response('{"error":"disk full"}\n', { status: 200 }),
      },
      {
        agents: {
          defaults: {
            model: { primary: "openai/gpt-5.6-luna", fallbacks: ["anthropic/claude-sonnet-4-6"] },
          },
        },
      },
    );
    const result = await configure({ customModelId: "missing-model" });
    expect(runtime.error).toHaveBeenCalledWith("Download failed: disk full");
    expect(result.agents?.defaults?.model).toEqual({
      primary: "ollama/qwen2.5-coder:7b",
      fallbacks: ["anthropic/claude-sonnet-4-6"],
    });
    expect(result.models?.providers?.ollama?.apiKey).toBe("ollama-local");
  });
});
