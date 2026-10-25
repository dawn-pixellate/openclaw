import type { ImageGenerationRequest } from "openclaw/plugin-sdk/image-generation";
import * as providerAuth from "openclaw/plugin-sdk/provider-auth";
import * as providerAuthRuntime from "openclaw/plugin-sdk/provider-auth-runtime";
import * as providerHttp from "openclaw/plugin-sdk/provider-http";
import type { ModelProviderConfig } from "openclaw/plugin-sdk/provider-model-shared";
import { jsonResponse, mockPinnedHostnameResolution } from "openclaw/plugin-sdk/test-env";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { googleImageGenerationProvider } from "./image-generation-provider.js";

function generateImage(overrides: Partial<ImageGenerationRequest> = {}) {
  return googleImageGenerationProvider.generateImage({
    provider: "google",
    model: "gemini-3.1-flash-image",
    prompt: "draw a cat",
    cfg: {},
    ...overrides,
  });
}

function googleImageConfig(provider: Omit<ModelProviderConfig, "models">) {
  return { models: { providers: { google: { ...provider, models: [] } } } };
}

function googleImagePayload(parts: unknown[]) {
  return { candidates: [{ content: { parts } }] };
}
function inlineImage(data: Buffer | string, mimeType = "image/png") {
  return { inlineData: { mimeType, data: Buffer.isBuffer(data) ? data.toString("base64") : data } };
}

let ssrfMock: { mockRestore: () => void } | undefined;

function installGoogleFetchMock(
  payload: unknown = googleImagePayload([inlineImage(Buffer.from("png-data"))]),
) {
  const fetchMock = vi.fn().mockResolvedValue(jsonResponse(payload));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function fetchRequest(fetchMock: ReturnType<typeof vi.fn>) {
  const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit | undefined];
  expect(typeof url).toBe("string");
  if (!init) {
    throw new Error("Expected fetch init");
  }
  return { ...init, body: typeof init.body === "string" ? init.body : undefined, url };
}

function expectGenerationRequest(
  fetchMock: ReturnType<typeof vi.fn>,
  model: string,
  parts: unknown[],
  imageConfig: object,
) {
  const request = fetchRequest(fetchMock);
  expect(request.url).toBe(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
  );
  expect(request.method).toBe("POST");
  expect(JSON.parse(request.body ?? "")).toEqual({
    contents: [{ role: "user", parts }],
    generationConfig: { responseModalities: ["TEXT", "IMAGE"], imageConfig },
  });
}

describe("Google image-generation provider", () => {
  beforeEach(() => {
    ssrfMock = mockPinnedHostnameResolution();
    vi.spyOn(providerAuthRuntime, "resolveApiKeyForProvider").mockResolvedValue({
      apiKey: "google-test-key",
      source: "env",
      mode: "api-key",
    });
  });

  afterEach(() => {
    ssrfMock?.mockRestore();
    ssrfMock = undefined;
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("generates image buffers from the Gemini generateContent API", async () => {
    const imageBytes = Buffer.from([0xfb, 0xff, 0x50, 0x4e, 0x47]);
    const fetchMock = installGoogleFetchMock(
      googleImagePayload([{ text: "generated" }, inlineImage(imageBytes.toString("base64url"))]),
    );

    const result = await generateImage({ size: "1536x1024" });

    expectGenerationRequest(fetchMock, "gemini-3.1-flash-image", [{ text: "draw a cat" }], {
      aspectRatio: "3:2",
      imageSize: "2K",
    });
    expect(result).toEqual({
      images: [{ buffer: imageBytes, mimeType: "image/png", fileName: "image-1.png" }],
      model: "gemini-3.1-flash-image",
    });
  });

  it("passes request SSRF policy to the provider HTTP helper", async () => {
    const postJsonRequest = vi
      .spyOn(providerHttp, "postJsonResponse")
      .mockResolvedValue(googleImagePayload([inlineImage(Buffer.from("png-data"))]));

    await generateImage({ ssrfPolicy: { allowRfc2544BenchmarkRange: true } });

    expect(postJsonRequest.mock.calls[0]?.[0].ssrfPolicy).toEqual({
      allowRfc2544BenchmarkRange: true,
    });
  });

  it.each([
    ["wrong shape", { candidates: { content: { parts: [] } } }],
    ["invalid base64", googleImagePayload([inlineImage("not-base64!")])],
    ["mixed alphabets", googleImagePayload([inlineImage("aGVsbG8+_")])],
  ])("rejects malformed Gemini image responses: %s", async (_label, payload) => {
    installGoogleFetchMock(payload);
    await expect(generateImage({})).rejects.toThrow("Google image generation response malformed");
  });

  it("accepts OAuth JSON auth and inline_data responses", async () => {
    vi.spyOn(providerAuthRuntime, "resolveApiKeyForProvider").mockResolvedValue({
      apiKey: JSON.stringify({ token: "oauth-token" }),
      source: "profile",
      mode: "token",
    });
    const fetchMock = installGoogleFetchMock(
      googleImagePayload([
        {
          inline_data: {
            mime_type: "image/jpeg",
            data: Buffer.from("jpg-data").toString("base64"),
          },
        },
      ]),
    );

    const result = await generateImage({ prompt: "draw a dog" });

    const request = fetchRequest(fetchMock);
    expect(request.headers).toBeInstanceOf(Headers);
    expect(new Headers(request.headers).get("authorization")).toBe("Bearer oauth-token");
    expect(result).toEqual({
      images: [
        { buffer: Buffer.from("jpg-data"), mimeType: "image/jpeg", fileName: "image-1.jpg" },
      ],
      model: "gemini-3.1-flash-image",
    });
  });

  it.each([3, 1])("accepts %i images above generic JSON/configured media caps", async (count) => {
    const image = Buffer.alloc(4 * 1024 * 1024, 1);
    installGoogleFetchMock(
      googleImagePayload(Array.from({ length: count }, () => inlineImage(image))),
    );
    const result = await generateImage({
      cfg: count === 1 ? { agents: { defaults: { mediaMaxMb: 0.5 } } } : {},
    });
    expect(result.images.map((item) => item.buffer.byteLength)).toEqual(
      Array(count).fill(image.byteLength),
    );
  });

  const reference = {
    buffer: Buffer.from("reference-bytes"),
    mimeType: "image/png",
    fileName: "reference.png",
  };
  it.each([
    [
      { resolution: "4K", inputImages: [reference] },
      [inlineImage(reference.buffer)],
      { imageSize: "4K" },
    ],
    [{ aspectRatio: "9:16" }, [], { aspectRatio: "9:16" }],
  ] satisfies Array<[Partial<ImageGenerationRequest>, unknown[], object]>)(
    "sends explicit image settings without a default: %j",
    async (overrides, parts, imageConfig) => {
      const fetchMock = installGoogleFetchMock();
      await generateImage({ model: "gemini-3-pro-image", ...overrides });
      expectGenerationRequest(
        fetchMock,
        "gemini-3-pro-image",
        [...parts, { text: "draw a cat" }],
        imageConfig,
      );
    },
  );

  it("honors configured private-network opt-in for Google image generation", async () => {
    installGoogleFetchMock();
    const postJsonRequestSpy = vi.spyOn(providerHttp, "postJsonResponse");

    await generateImage({
      prompt: "draw a fox",
      cfg: googleImageConfig({
        baseUrl: "https://generativelanguage.googleapis.com/v1beta",
        request: { allowPrivateNetwork: true },
      }),
    });

    expect(postJsonRequestSpy.mock.calls[0]?.[0].allowPrivateNetwork).toBe(true);
  });

  it("still reports not configured with a custom endpoint and no credentials", async () => {
    vi.spyOn(providerAuth, "isProviderApiKeyConfiguredAsync").mockResolvedValue(false);

    const provider = googleImageGenerationProvider;
    expect(
      await provider.isConfiguredAsync?.({
        agentDir: "/tmp/agent",
        cfg: googleImageConfig({ baseUrl: "https://gateway.example.test/gemini/v1beta" }),
      }),
    ).toBe(false);
  });
});
