import type { ProviderRuntimeModel } from "openclaw/plugin-sdk/plugin-entry";
import { describe, expect, it } from "vitest";
import { createProviderDynamicModelContext as createContext } from "../test-support/provider-model-test-helpers.js";
import {
  isGoogleNativeVideoModelId,
  isGoogleTextGenerationModelId,
  isModernGoogleModel,
  resolveGoogleGeminiForwardCompatModel,
} from "./provider-models.js";

function template(
  provider: string,
  id: string,
  overrides: Partial<ProviderRuntimeModel> = {},
): ProviderRuntimeModel {
  return {
    id,
    name: id,
    provider,
    api: provider === "google-gemini-cli" ? "google-gemini-cli" : "google-generative-ai",
    baseUrl:
      provider === "google-gemini-cli"
        ? "https://cloudcode-pa.googleapis.com"
        : "https://generativelanguage.googleapis.com/v1beta",
    reasoning: false,
    input: ["text", "image"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 200_000,
    maxTokens: 64_000,
    ...overrides,
  } as ProviderRuntimeModel;
}

function resolveModel(providerId: string, modelId: string, models: ProviderRuntimeModel[]) {
  return resolveGoogleGeminiForwardCompatModel({
    providerId,
    ctx: createContext({ provider: providerId, modelId, models }),
  });
}

function expectResolution(
  provider: string,
  id: string,
  models: ProviderRuntimeModel[],
  fields: Partial<ProviderRuntimeModel>,
) {
  const model = resolveModel(provider, id, models);
  if (!model) {
    throw new Error("expected provider model");
  }
  for (const [key, value] of Object.entries({ provider, id, ...fields })) {
    expect(model[key as keyof ProviderRuntimeModel]).toEqual(value);
  }
}

describe("resolveGoogleGeminiForwardCompatModel", () => {
  it.each<[string, string, string, ProviderRuntimeModel[], Partial<ProviderRuntimeModel>]>([
    [
      "resolves stable gemini 2.5 flash-lite from direct google templates for Gemini CLI when available",
      "google-gemini-cli",
      "gemini-2.5-flash-lite",
      [template("google", "gemini-2.5-flash-lite")],
      { api: "google-generative-ai", reasoning: false },
    ],
    [
      "resolves stable gemini 2.5 flash-lite from Gemini CLI templates when direct google templates are unavailable",
      "google-gemini-cli",
      "gemini-2.5-flash-lite",
      [template("google-gemini-cli", "gemini-3.1-flash-lite", { contextWindow: 1_048_576 })],
      { api: "google-gemini-cli", contextWindow: 1_048_576, reasoning: false },
    ],
    [
      "resolves gemini 3.1 pro for google aliases via an alternate template provider",
      "google-vertex",
      "gemini-3.1-pro-preview",
      [template("google-gemini-cli", "gemini-3-pro-preview")],
      { api: "google-gemini-cli", reasoning: false },
    ],
    [
      "resolves newer Gemini 4 releases from the Gemini 4 Argon template",
      "google",
      "gemini-4-argon-preview-11-02",
      [template("google", "gemini-4-argon", { reasoning: true, contextWindow: 1_048_576 })],
      { reasoning: true, contextWindow: 1_048_576 },
    ],
    [
      "canonicalizes retired Gemini 3 Pro preview requests before cloning templates",
      "google",
      "gemini-3-pro-preview",
      [template("google", "gemini-3-pro-preview")],
      { id: "gemini-3.1-pro-preview", api: "google-generative-ai", reasoning: true },
    ],
    [
      "canonicalizes provider-qualified retired Gemini 3 Pro preview requests",
      "google",
      "google/gemini-3-pro-preview",
      [template("google", "gemini-3.1-pro-preview")],
      { id: "google/gemini-3.1-pro-preview", api: "google-generative-ai", reasoning: true },
    ],
    [
      "keeps Gemini CLI 3.1 clones sourced from CLI templates when both catalogs exist",
      "google-gemini-cli",
      "gemini-3.1-pro-preview",
      [
        template("google-gemini-cli", "gemini-3-pro-preview", {
          api: "google-gemini-cli",
          baseUrl: "https://cloudcode-pa.googleapis.com",
          contextWindow: 1_048_576,
        }),
        template("google", "gemini-3-pro-preview", {}),
      ],
      {
        api: "google-gemini-cli",
        baseUrl: "https://cloudcode-pa.googleapis.com",
        contextWindow: 1_048_576,
      },
    ],
    [
      "prefers current Gemini 3.1 Pro templates over retired Gemini 3 Pro templates",
      "google-gemini-cli",
      "gemini-3.1-pro-preview",
      [
        template("google-gemini-cli", "gemini-3-pro-preview", { contextWindow: 100_000 }),
        template("google-gemini-cli", "gemini-3.1-pro-preview", { contextWindow: 1_048_576 }),
      ],
      { contextWindow: 1_048_576 },
    ],
    [
      "preserves template reasoning metadata instead of forcing it on forward-compat clones",
      "google",
      "gemini-3.1-flash-preview",
      [template("google-gemini-cli", "gemini-3-flash-preview", { reasoning: true })],
      { api: "google-gemini-cli", reasoning: true },
    ],
    [
      "resolves gemini 3.1 flash from direct google templates",
      "google",
      "gemini-3.1-flash-preview",
      [template("google", "gemini-3-flash-preview", { reasoning: false })],
      { api: "google-generative-ai", reasoning: false },
    ],
    [
      "resolves canonical gemini 3 flash from older Google flash templates when the exact row is missing",
      "google",
      "gemini-3-flash-preview",
      [template("google", "gemini-2.5-flash", { contextWindow: 1_048_576, reasoning: true })],
      {
        api: "google-generative-ai",
        input: ["text", "image"],
        contextWindow: 1_048_576,
        reasoning: true,
      },
    ],
    [
      "resolves canonical Gemini CLI 3 flash from Google flash templates when the CLI row is missing",
      "google-gemini-cli",
      "gemini-3-flash-preview",
      [template("google", "gemini-2.5-flash", { contextWindow: 1_048_576 })],
      { api: "google-generative-ai", input: ["text", "image"], contextWindow: 1_048_576 },
    ],
    [
      "resolves Antigravity Gemini 3.1 pro customtools from the low template",
      "google-antigravity",
      "gemini-3.1-pro-preview-customtools",
      [
        template("google-antigravity", "gemini-3-pro-low", {
          api: "openai-completions",
          baseUrl: "https://antigravity.example/v1",
          contextWindow: 1_048_576,
          reasoning: true,
        }),
      ],
      {
        api: "openai-completions",
        baseUrl: "https://antigravity.example/v1",
        contextWindow: 1_048_576,
        reasoning: true,
      },
    ],
    [
      "falls back to the Antigravity high template when the low template is unavailable",
      "google-antigravity",
      "gemini-3.1-pro-preview",
      [
        template("google-antigravity", "gemini-3-pro-high", {
          api: "openai-completions",
          maxTokens: 65_536,
          reasoning: true,
        }),
      ],
      { api: "openai-completions", maxTokens: 65_536, reasoning: true },
    ],
    [
      "prefers the flash-lite template before the broader flash prefix",
      "google-vertex",
      "gemini-3.1-flash-lite",
      [
        template("google-gemini-cli", "gemini-3-flash-preview", { contextWindow: 128_000 }),
        template("google-gemini-cli", "gemini-3.1-flash-lite", { contextWindow: 1_048_576 }),
      ],
      { contextWindow: 1_048_576, reasoning: false },
    ],
    [
      "canonicalizes Gemma 4 26B shorthand before cloning templates",
      "google",
      "gemma-4-26b",
      [template("google", "gemini-3-flash-preview", { reasoning: false })],
      { id: "gemma-4-26b-a4b-it", api: "google-generative-ai", reasoning: true },
    ],
    [
      "preserves template reasoning for non-Gemma 4 gemma models",
      "google",
      "gemma-3-4b-it",
      [template("google", "gemini-3-flash-preview", { reasoning: false })],
      { reasoning: false },
    ],
  ])("%s", (_name, provider, id, models, fields) => {
    expectResolution(provider, id, models, fields);
  });

  it("resolves Gemini latest aliases from current Google templates", () => {
    const models = [
      template("google", "gemini-3-pro-preview", { reasoning: true }),
      template("google", "gemini-3-flash-preview", { reasoning: true }),
      template("google", "gemini-3.1-flash-lite", { reasoning: true }),
    ];

    for (const id of ["gemini-pro-latest", "gemini-flash-latest", "gemini-flash-lite-latest"]) {
      expectResolution("google", id, models, { api: "google-generative-ai", reasoning: true });
    }
  });

  it("resolves Antigravity Gemini 3.1 flash variants from the flash template", () => {
    const models = [
      template("google-antigravity", "gemini-3-flash", {
        api: "openai-completions",
        contextWindow: 1_048_576,
      }),
    ];

    for (const id of ["gemini-3.1-flash-preview", "gemini-3.1-flash-lite"]) {
      expectResolution("google-antigravity", id, models, {
        api: "openai-completions",
        contextWindow: 1_048_576,
      });
    }
  });

  it("returns undefined for Antigravity Gemini 3.1 models without a matching template", () => {
    const model = resolveModel("google-antigravity", "gemini-3.1-pro-preview-customtools", [
      template("google-antigravity", "claude-opus-4-6-thinking"),
    ]);

    expect(model).toBeUndefined();
  });

  it("treats current Gemini families as modern google models", () => {
    expect(isModernGoogleModel("gemini-2.5-pro")).toBe(true);
    expect(isModernGoogleModel("gemini-2.5-flash-lite")).toBe(true);
    expect(isModernGoogleModel("gemini-4-argon")).toBe(true);
    expect(isModernGoogleModel("gemini-1.5-pro")).toBe(false);
  });

  it("treats Gemini latest aliases as modern google models", () => {
    expect(isModernGoogleModel("gemini-pro-latest")).toBe(true);
    expect(isModernGoogleModel("gemini-flash-latest")).toBe(true);
    expect(isModernGoogleModel("gemini-flash-lite-latest")).toBe(true);
  });

  it("treats gemma models as modern google models", () => {
    expect(isModernGoogleModel("gemma-4-26b-a4b-it")).toBe(true);
    expect(isModernGoogleModel("gemma-3-4b-it")).toBe(true);
  });

  it.each([
    ["gemini-3.7-flash", "gemini-3-flash-preview"],
    ["gemini-3.5-flash-lite", "gemini-3.1-flash-lite"],
  ])("resolves future Gemini 3 text family %s from %s metadata", (modelId, templateId) => {
    expectResolution(
      "google",
      modelId,
      [template("google", templateId, { reasoning: true, contextWindow: 1_048_576 })],
      { reasoning: true, contextWindow: 1_048_576 },
    );
  });

  it("keeps non-chat Gemini surfaces out of text discovery and forward compatibility", () => {
    for (const modelId of [
      "gemini-3.1-flash-image",
      "gemini-3.1-flash-tts-preview",
      "gemini-3.8-flash-tts",
      "gemini-3.8-flash-lite-tts",
      "gemini-3.1-flash-live-preview",
      "gemini-2.5-flash-preview-native-audio-dialog",
    ]) {
      expect(isGoogleTextGenerationModelId(modelId)).toBe(false);
      expect(
        resolveModel("google", modelId, [template("google", "gemini-3-flash-preview")]),
      ).toBeUndefined();
    }
  });

  it("classifies only ordinary Gemini generation ids for native video", () => {
    for (const modelId of [
      "gemini-2.5-flash",
      "google/gemini-3.1-pro-preview",
      "models/gemini-flash-latest",
    ]) {
      expect(isGoogleNativeVideoModelId(modelId), modelId).toBe(true);
    }
    for (const modelId of [
      "gemma-4-26b-a4b-it",
      "tunedModels/gemini-2.5-flash",
      "gemini-3.1-flash-image",
      "gemini-2.5-computer-use-preview",
      "gemini-2.5-flash-tts-preview",
      "gemini-2.5-flash-live-preview",
    ]) {
      expect(isGoogleNativeVideoModelId(modelId), modelId).toBe(false);
    }
  });
});
