import { expectDefined } from "@openclaw/normalization-core";
import { clampThinkingLevel } from "openclaw/plugin-sdk/llm";
import type {
  ProviderRuntimeModel,
  ProviderWrapStreamFnContext,
} from "openclaw/plugin-sdk/plugin-entry";
import { jsonResponse, requestUrl } from "openclaw/plugin-sdk/test-env";
import { createRequireRecord } from "openclaw/plugin-sdk/test-fixtures";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createModel } from "../model.test-support.js";
import { ollamaProviderDiscovery } from "../provider-discovery.js";
import { resolveThinkingProfile } from "../provider-policy-api.js";
import { toDynamicOllamaModel } from "./provider-models.js";
import {
  createConfiguredOllamaCompatStreamWrapper,
  createOllamaStreamFn,
} from "./stream.runtime.js";

const baseUrl = "http://127.0.0.1:11434";
const requireRecord = createRequireRecord("object", "expected-label");
type ThinkingLevel = NonNullable<ProviderWrapStreamFnContext["thinkingLevel"]>;

afterEach(() => vi.unstubAllGlobals());

function mockOllama(modelId: string, thinking: unknown) {
  const metadata: { digest: string; thinking: unknown; parameterCount?: number } = {
    digest: "first",
    thinking,
  };
  let showCount = 0;
  const chatBodies: Record<string, unknown>[] = [];
  vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const pathname = new URL(requestUrl(input)).pathname;
    if (pathname === "/api/tags") {
      return jsonResponse({ models: [{ name: modelId, digest: metadata.digest }] });
    }
    if (pathname === "/api/show") {
      showCount++;
      return jsonResponse({
        model_info: {
          "test.context_length": 32768,
          "general.parameter_count": metadata.parameterCount,
        },
        capabilities: ["completion", "thinking"],
        ...(metadata.thinking === undefined ? {} : { thinking: metadata.thinking }),
      });
    }
    if (pathname !== "/api/chat" || typeof init?.body !== "string") {
      throw new Error(`Unexpected Ollama request: ${pathname}`);
    }
    chatBodies.push(requireRecord(JSON.parse(init.body), "Ollama chat request"));
    return jsonResponse({ message: { role: "assistant", content: "ok" }, done: true });
  });
  return {
    metadata,
    showCount: () => showCount,
    thoughts: () => chatBodies.map((body) => body.think),
    chatBodies,
    async discover(
      api: "ollama" | "openai-completions" = "ollama",
      configuredModel?: Parameters<typeof toDynamicOllamaModel>[0]["model"],
    ): Promise<ProviderRuntimeModel> {
      const ollama = { baseUrl, api, models: configuredModel ? [configuredModel] : [] };
      const result = await ollamaProviderDiscovery.catalog.run({
        config: { models: { providers: { ollama } } },
        agentDir: "/unused",
        env: { OLLAMA_API_KEY: "ollama-local" },
        resolveProviderApiKey: () => ({ apiKey: "ollama-local" }),
        resolveProviderAuth: () => ({ apiKey: "ollama-local", mode: "api_key", source: "env" }),
      });
      const provider = expectDefined(
        result && "provider" in result ? result.provider : undefined,
        "discovered provider",
      );
      const model = expectDefined(provider.models[0] ?? configuredModel, "thinking model");
      return toDynamicOllamaModel({ provider: "ollama", providerConfig: provider, model });
    },
  };
}

const chatContext = { messages: [{ role: "user" as const, content: "Hello", timestamp: 0 }] };

async function expectStop(stream: ReturnType<ReturnType<typeof createOllamaStreamFn>>) {
  expect((await (await stream).result()).stopReason).toBe("stop");
}

async function sendThinking(model: ProviderRuntimeModel, ...levels: ThinkingLevel[]) {
  for (const thinkingLevel of levels) {
    const streamFn = expectDefined(
      createConfiguredOllamaCompatStreamWrapper({
        provider: model.provider,
        modelId: model.id,
        model,
        thinkingLevel,
        streamFn: createOllamaStreamFn(baseUrl),
      }),
      "native Ollama stream wrapper",
    );
    await expectStop(streamFn(model, chatContext, {}));
  }
}

const levelsFor = (model: ProviderRuntimeModel) =>
  resolveThinkingProfile({ ...model, modelId: model.id }).levels.map(({ id }) => id);

const descriptor = (values: unknown) => ({ values });
const graded = ["low", "medium", "high"];
const extended = [false, "low", "medium", "xhigh"];
const fallback = [false, "low", "high", "high"];
describe("Ollama discovered thinking contracts", () => {
  it("preserves manual settings with discovered mandatory thinking", async () => {
    const fixture = mockOllama("manual-mandatory-thinking:latest", descriptor([true]));
    fixture.metadata.parameterCount = 70_000_000_000;
    const settings = {
      name: "Manual thinking model",
      contextWindow: 8192,
      maxTokens: 2048,
      compat: { supportsTools: false },
    };
    const model = await fixture.discover("ollama", {
      ...createModel("manual-mandatory-thinking:latest", settings.name, { reasoning: true }),
      ...settings,
    });
    expect(model).toMatchObject({ ...settings, parameterCount: 70_000_000_000 });
    await sendThinking(model, "off", "high");
    expect(fixture.thoughts()).toEqual([true, true]);
  });

  it("keeps native boolean mappings off the legacy OpenAI-compatible transport", async () => {
    const fixture = mockOllama("thinking-openai-compatible:latest", { values: [false, true] });
    const model = await fixture.discover("openai-completions");
    expect(model.api).toBe("openai-completions");
    expect(model.thinkingLevelMap).toBeUndefined();
  });

  it.each<[string, unknown, unknown[]]>([
    ["boolean", descriptor([false, true]), [false, true, true, true]],
    ["graded xhigh", descriptor(extended), [false, "low", "xhigh", "xhigh"]],
    ["mandatory graded", descriptor(graded), ["low", "low", "high", "high"]],
    ["native max", descriptor([false, ...graded, "max"]), [false, "low", "high", "max"]],
    ["native minimal", descriptor([false, "minimal", "low", "high"]), fallback],
    ["missing descriptor", undefined, fallback],
    ["malformed descriptor", descriptor("xhigh"), fallback],
  ])("maps %s discovery to native requests", async (name, thinking, expected) => {
    const fixture = mockOllama(`thinking-${name.replaceAll(" ", "-")}:latest`, thinking);
    const model = await fixture.discover();
    if (name === "native minimal") {
      expect(clampThinkingLevel(model, "minimal")).toBe("minimal");
    }
    await sendThinking(model, "off", "low", "high", "max");
    expect(fixture.thoughts()).toEqual(expected);
    for (const body of fixture.chatBodies) {
      expect(body.options).not.toHaveProperty("think");
    }
    if (name === "graded xhigh") {
      await sendThinking(model, "xhigh");
      expect(fixture.thoughts().at(-1)).toBe("xhigh");
    }
  });

  it("preserves explicit think at off but lets enabled runtime levels win", async () => {
    const fixture = mockOllama("thinking-precedence:latest", descriptor(extended));
    const model = await fixture.discover();
    model.params = { think: "xhigh", thinking: "low" };
    await sendThinking(model, "off", "low");
    model.params = { think: false, thinking: "xhigh" };
    await sendThinking(model, "off");
    expect(fixture.thoughts()).toEqual(["xhigh", "low", false]);
  });

  it.each([
    ["thinking-disabled:latest", { values: extended }, true],
    ["glm-5.3", { values: [false], default: false }, false],
  ] as const)(
    "disables reasoning for %s despite advertised or cloud defaults",
    async (id, thinking, override) => {
      const fixture = mockOllama(id, thinking);
      const model = await fixture.discover();
      if (override) {
        model.reasoning = false;
      }
      expect(model.reasoning).toBe(false);
      expect(levelsFor(model)).toEqual(["off"]);
      await sendThinking(model, ...(override ? (["high", "off"] as const) : (["off"] as const)));
      expect(fixture.thoughts()).toEqual(override ? [undefined, false] : [false]);
    },
  );

  it("preserves configured effort over mandatory thinking in wrapped and direct calls", async () => {
    const fixture = mockOllama("thinking-mandatory-precedence:latest", { values: graded });
    const model = await fixture.discover();
    model.params = { think: "medium" };
    await sendThinking(model, "off");
    const streamFn = createOllamaStreamFn(baseUrl);
    await expectStop(streamFn(model, chatContext, { reasoning: "off" }));
    model.params = {};
    await expectStop(streamFn(model, chatContext, { reasoning: "off" }));
    expect(fixture.thoughts()).toEqual(["medium", "medium", "low"]);
  });

  it("reuses cached thinking metadata until the advertised model digest changes", async () => {
    const fixture = mockOllama("thinking-cache-version:latest", { values: [false, true] });
    await sendThinking(await fixture.discover(), "high");
    await sendThinking(await fixture.discover(), "high");
    expect(fixture.showCount()).toBe(1);

    fixture.metadata.digest = "second";
    fixture.metadata.thinking = { values: extended };
    await sendThinking(await fixture.discover(), "high");
    expect(fixture.thoughts()).toEqual([true, true, "xhigh"]);
    expect(fixture.showCount()).toBe(2);
  });
});
