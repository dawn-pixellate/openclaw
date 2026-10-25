import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { withTimeout } from "openclaw/plugin-sdk/time-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("openclaw/plugin-sdk/memory-core-host-engine-embeddings", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("openclaw/plugin-sdk/memory-core-host-engine-embeddings")>();
  return {
    ...actual,
    withRemoteHttpResponse: (async (params) =>
      await params.onResponse(
        await fetch(params.url, params.init),
      )) satisfies typeof actual.withRemoteHttpResponse,
  };
});

import { createGeminiEmbeddingProvider } from "./embedding-provider.js";
import {
  createLegacyGeminiEmbeddingProvider,
  createGeminiRetryInfoPayload,
} from "./embedding-provider.test-support.js";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

function installFetchMock(
  handler: (input: RequestInfo | URL, init?: RequestInit) => unknown,
): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) =>
    Response.json(handler(input, init)),
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function fetchJsonBody(fetchMock: ReturnType<typeof vi.fn>, index: number): unknown {
  const init = fetchMock.mock.calls[index]?.[1] as RequestInit | undefined;
  const body = init?.body;
  if (typeof body !== "string") {
    throw new Error("Expected JSON string request body.");
  }
  return JSON.parse(body) as unknown;
}

function requireFirstFetchInput(fetchMock: ReturnType<typeof vi.fn>): RequestInfo | URL {
  const [call] = fetchMock.mock.calls;
  if (!call) {
    throw new Error("expected Gemini embedding fetch call");
  }
  return call[0] as RequestInfo | URL;
}

function axisVector(length: number, index = 0, value = 1): number[] {
  return Array.from({ length }, (_, offset) => (offset === index ? value : 0));
}

function createProvider(
  overrides: Partial<Parameters<typeof createGeminiEmbeddingProvider>[0]> = {},
) {
  return createGeminiEmbeddingProvider({
    config: {},
    provider: "gemini",
    remote: { apiKey: "test-key" },
    model: "gemini-embedding-2",
    dimensions: 768,
    fallback: "none",
    ...overrides,
  });
}

const embeddingUrl = (model: string) =>
  `https://generativelanguage.googleapis.com/v1beta/models/${model}:embedContent`;

function installAxisVectorFetchMock(dimensions: number) {
  return installFetchMock((input) => {
    const url = input instanceof URL ? input.href : typeof input === "string" ? input : input.url;
    return url.endsWith(":batchEmbedContents")
      ? { embeddings: [{ values: axisVector(dimensions) }] }
      : { embedding: { values: axisVector(dimensions) } };
  });
}

describe("Gemini embedding provider", () => {
  const providerBaseUrl = "https://provider.example.test/v1beta";
  const config = {
    models: {
      providers: {
        google: {
          baseUrl: providerBaseUrl,
          apiKey: "provider-key",
          headers: { "X-Provider-Tenant": "provider-a" },
          models: [],
        },
      },
    },
  };

  it.each([
    {
      name: "provider-owned",
      remote: { baseUrl: providerBaseUrl },
      expectedApiKey: "provider-key",
      expectedHeaders: { "X-Provider-Tenant": "provider-a" },
    },
    {
      name: "remote-owned with a resolved env-looking literal",
      remote: {
        baseUrl: "https://remote.example.test/v1beta",
        apiKey: "GOOGLE_API_KEY",
        headers: { "X-Remote-Tenant": "remote-b" },
      },
      expectedApiKey: "GOOGLE_API_KEY",
      expectedHeaders: { "X-Remote-Tenant": "remote-b" },
    },
    {
      name: "query-distinct on the provider host",
      remote: {
        baseUrl: `${providerBaseUrl}?tenant=remote`,
        apiKey: "remote-tenant-key",
        headers: { "X-Remote-Tenant": "remote-b" },
      },
      expectedApiKey: "remote-tenant-key",
      expectedHeaders: { "X-Remote-Tenant": "remote-b" },
    },
  ])("binds Gemini credentials to the $name destination", async (testCase) => {
    vi.stubEnv("GOOGLE_API_KEY", testCase.remote.baseUrl === providerBaseUrl ? "" : "ambient-bait");
    const { client, provider } = await createProvider({
      config: config as never,
      provider: "google",
      remote: testCase.remote,
      model: "gemini-embedding-001",
      dimensions: undefined,
    });

    expect(client.apiKeys).toContain(testCase.expectedApiKey);
    expect(client.headers).toMatchObject(testCase.expectedHeaders);
    if (testCase.remote.baseUrl !== providerBaseUrl) {
      expect(client.apiKeys).toEqual([testCase.expectedApiKey]);
      expect(client.headers).not.toHaveProperty("X-Provider-Tenant");
    }
    if (testCase.remote.baseUrl.includes("?")) {
      const fetchMock = installFetchMock(() => ({ embedding: { values: [1, 0] } }));
      await expect(provider.embed("hello", { inputType: "query" })).resolves.toEqual([1, 0]);
      const fetchInput = requireFirstFetchInput(fetchMock);
      const requestUrl = new URL(
        typeof fetchInput === "string"
          ? fetchInput
          : fetchInput instanceof URL
            ? fetchInput.href
            : fetchInput.url,
      );
      expect(requestUrl.pathname).toBe("/v1beta/models/gemini-embedding-001:embedContent");
      expect(requestUrl.search).toBe("?tenant=remote");
    }
  });

  it("rejects an unauthenticated remote destination before provider-key fallback", async () => {
    await expect(
      createProvider({
        config: config as never,
        provider: "google",
        remote: { baseUrl: "https://remote.example.test/v1beta" },
        model: "gemini-embedding-001",
      }),
    ).rejects.toThrow(/memory\.search\.remote\.apiKey/);
  });

  it.each(["models/", "gemini/", "google/", "models/gemini/", "models/google/"])(
    "normalizes the %s model prefix through the provider request",
    async (prefix) => {
      const fetchMock = installFetchMock(() => ({
        embedding: { values: axisVector(768) },
      }));
      const { provider } = await createProvider({ model: `${prefix}gemini-embedding-2` });

      await provider.embed("query", { inputType: "query" });

      expect(requireFirstFetchInput(fetchMock)).toBe(embeddingUrl("gemini-embedding-2"));
    },
  );

  it.each([
    ["gemini-embedding-001", 128],
    ["gemini-embedding-2", 3072],
    ["gemini-embedding-2-preview", 512],
  ] as const)("supports %s with %i output dimensions", async (model, dimensions) => {
    const fetchMock = installAxisVectorFetchMock(dimensions);
    const { provider, client } = await createProvider({ model, dimensions });

    expect(client.outputDimensionality).toBe(dimensions);
    await expect(provider.embed("query", { inputType: "query" })).resolves.toHaveLength(dimensions);
    await expect(provider.embedBatch(["document"], { inputType: "document" })).resolves.toEqual([
      axisVector(dimensions),
    ]);
    expect(fetchJsonBody(fetchMock, 0)).toMatchObject({ outputDimensionality: dimensions });
    expect(fetchJsonBody(fetchMock, 1)).toMatchObject({
      requests: [{ outputDimensionality: dimensions }],
    });
    if (model === "gemini-embedding-2-preview") {
      expect(requireFirstFetchInput(fetchMock)).toBe(embeddingUrl(model));
      expect(fetchJsonBody(fetchMock, 0)).toEqual({
        content: { parts: [{ text: "query" }] },
        taskType: "RETRIEVAL_QUERY",
        outputDimensionality: dimensions,
      });
    }
  });

  it.each([
    ["gemini-embedding-001", 127],
    ["gemini-embedding-2", 512.5],
    ["gemini-embedding-2-preview", 3073],
  ] as const)(
    "rejects unsupported %s dimension %i before making a request",
    async (model, dimensions) => {
      await expect(createProvider({ model, dimensions })).rejects.toThrow(
        /integer between 128 and 3072/,
      );
    },
  );

  it.each([
    ["gemini-embedding-001", undefined],
    ["gemini-embedding-2", 3072],
    ["gemini-embedding-2-preview", 3072],
  ] as const)(
    "preserves the existing default dimension identity for %s",
    async (model, dimensions) => {
      const { client } = await createProvider({ model, dimensions: undefined });

      expect(client.outputDimensionality).toBe(dimensions);
    },
  );

  it("handles legacy and v2 request/response behavior", async () => {
    const fetchMock = installFetchMock((input) => {
      const url = input instanceof URL ? input.href : typeof input === "string" ? input : input.url;
      return url.endsWith(":batchEmbedContents")
        ? {
            embeddings: Array.from({ length: 2 }, () => ({
              values: axisVector(768, 2, 5),
            })),
          }
        : {
            embedding: {
              values: Array.from({ length: 768 }, (_, index) =>
                index === 0 ? 3 : index === 1 ? 4 : 0,
              ),
            },
          };
    });

    const { provider } = await createProvider({ taskType: "SEMANTIC_SIMILARITY" });

    await expect(provider.embed("   ", { inputType: "query" })).resolves.toStrictEqual([]);
    await expect(provider.embedBatch([], { inputType: "document" })).resolves.toStrictEqual([]);
    const queryEmbedding = await provider.embed("test query", { inputType: "query" });
    expect(queryEmbedding).toHaveLength(768);
    expect(queryEmbedding.slice(0, 3)).toEqual([0.6, 0.8, 0]);

    const media = [
      { text: "Image file: diagram.png", mimeType: "image/png", data: "img" },
      { text: "Audio file: note.wav", mimeType: "audio/wav", data: "aud" },
    ];
    const structuredBatch = await provider.embedBatch(
      media.map(({ text, mimeType, data }) => ({
        text,
        parts: [
          { type: "text", text },
          { type: "inline-data", mimeType, data },
        ],
      })),
      { inputType: "document" },
    );
    expect(structuredBatch).toEqual([axisVector(768, 2), axisVector(768, 2)]);

    expect(requireFirstFetchInput(fetchMock)).toBe(embeddingUrl("gemini-embedding-2"));
    expect(fetchJsonBody(fetchMock, 0)).toEqual({
      outputDimensionality: 768,
      content: { parts: [{ text: "task: sentence similarity | query: test query" }] },
    });
    expect(fetchJsonBody(fetchMock, 1)).toEqual({
      requests: media.map(({ text, mimeType, data }) => ({
        model: "models/gemini-embedding-2",
        content: { parts: [{ text }, { inlineData: { mimeType, data } }] },
        outputDimensionality: 768,
      })),
    });
  });

  it("rejects non-object successful embedding responses", async () => {
    installFetchMock(() => []);

    const { provider } = await createLegacyGeminiEmbeddingProvider();

    await expect(provider.embed("test query", { inputType: "query" })).rejects.toThrow(
      "gemini embeddings failed: malformed JSON response",
    );
  });

  it.each([
    ["1.500000001s", undefined, 1501, false],
    ["21.549315790s", "30", 30_000, false],
    ["-1s", undefined, undefined, false],
    ["NaNs", undefined, undefined, false],
    ["1.0000000001s", undefined, undefined, false],
    ["9007199254741s", undefined, undefined, false],
    ["1.500000001s", undefined, 1501, true],
  ] as const)(
    "parses RetryInfo %s / Retry-After %s => %s (clone failure: %s)",
    async (delay, retryAfter, expected, cloneFails) => {
      const fetchMock = vi.fn(async () => {
        const response = Response.json(createGeminiRetryInfoPayload(delay), {
          status: 429,
          headers: retryAfter ? { "Retry-After": retryAfter } : undefined,
        });
        if (cloneFails) {
          response.clone = () => {
            throw new Error("clone unsupported");
          };
        }
        return response;
      });
      vi.stubGlobal("fetch", fetchMock);
      const { provider } = await createLegacyGeminiEmbeddingProvider();

      await expect(provider.embed("test query", { inputType: "query" })).rejects.toMatchObject({
        status: 429,
        retryAfterMs: expected,
      });
      expect(fetchMock).toHaveBeenCalledOnce();
    },
  );

  it("decodes RetryInfo beyond the error preview while redacting reflected credentials", async () => {
    const credential = "tiny-reflected-value";
    const fetchMock = vi.fn(async () =>
      Response.json(
        {
          error: {
            // Padding pushes the RetryInfo detail well past core's 500-char
            // ProviderHttpError.errorBody preview, matching real ~1KB+ Gemini bodies.
            message: `echo ${credential} ${"quota exceeded ".repeat(40)}`,
            ...createGeminiRetryInfoPayload("5s").error,
          },
        },
        { status: 429 },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);
    const { provider } = await createLegacyGeminiEmbeddingProvider(credential);

    await expect(provider.embed("test query", { inputType: "query" })).rejects.toMatchObject({
      status: 429,
      retryAfterMs: 5000,
      message: expect.not.stringContaining(credential),
      errorBody: expect.not.stringContaining(credential),
    });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it.each(["original normalization", "cloned body read"] as const)(
    "releases both Google error response branches when cancelled during %s",
    async (phase) => {
      const readStarted = createDeferred<void>();
      const cancellationReleased = createDeferred<void>();
      const bodyControllerReady = createDeferred<ReadableStreamDefaultController<Uint8Array>>();
      const cancel = vi.fn(async () => await cancellationReleased.promise);
      const clones: Response[] = [];
      class ObservedErrorResponse extends Response {
        override clone(): Response {
          const clone = super.clone();
          clones.push(clone);
          return clone;
        }
      }
      const response = new ObservedErrorResponse(
        new ReadableStream<Uint8Array>(
          {
            start(controller) {
              bodyControllerReady.resolve(controller);
            },
            pull() {
              readStarted.resolve();
            },
            cancel,
          },
          { highWaterMark: 0 },
        ),
        { status: 429, headers: { "Retry-After": "30" } },
      );
      const bodyController = await bodyControllerReady.promise;
      const fetchMock = vi.fn(async () => response);
      vi.stubGlobal("fetch", fetchMock);
      const { provider } = await createLegacyGeminiEmbeddingProvider();
      const controller = new AbortController();
      const reason = new Error("caller stopped memory lookup");
      if (phase === "cloned body read") {
        vi.useFakeTimers();
      }
      const result = provider
        .embed("test query", { inputType: "query", signal: controller.signal })
        .then(
          (value) => value,
          (error: unknown) => error,
        );

      try {
        await readStarted.promise;
        expect(clones).toHaveLength(1);
        const clone = clones[0];
        if (!clone) {
          throw new Error("expected the provider's response clone");
        }
        if (phase === "cloned body read") {
          await vi.advanceTimersByTimeAsync(10_000);
          expect(response.body?.locked).toBe(false);
          expect(clone.body?.locked).toBe(true);
          vi.useRealTimers();
        } else {
          expect(response.body?.locked).toBe(true);
          expect(clone.bodyUsed).toBe(false);
        }

        controller.abort(reason);

        await expect(
          withTimeout(result, 1_000, { message: "Google body abort did not settle" }),
        ).resolves.toBe(reason);
        expect(cancel).toHaveBeenCalledOnce();
        expect(response.body?.locked).toBe(false);
        expect(clone.body?.locked).toBe(false);
        expect(clone.bodyUsed).toBe(true);
        expect(fetchMock).toHaveBeenCalledOnce();
      } finally {
        vi.useRealTimers();
        controller.abort(reason);
        bodyController.error(new Error("Google response fixture disposed"));
        cancellationReleased.resolve();
        await Promise.all(
          [response, ...clones].map(async (branch) => {
            if (!branch.body?.locked) {
              await branch.body?.cancel().catch(() => undefined);
            }
          }),
        );
        await withTimeout(result, 1_000, { message: "Google body cleanup did not settle" });
      }
    },
  );

  it.each([
    { label: "empty", values: [] },
    { label: "missing", values: undefined },
    { label: "null", values: null },
    { label: "string", values: "bad" },
    { label: "array-like", values: { 0: 1, length: 1 } },
    { label: "mixed", values: [1, "bad"] },
  ])("rejects $label vectors from direct and synchronous requests", async ({ values }) => {
    installFetchMock((input) => {
      const url = input instanceof URL ? input.href : typeof input === "string" ? input : input.url;
      return url.endsWith(":batchEmbedContents")
        ? { embeddings: [{ values }] }
        : { embedding: { values } };
    });
    const { provider } = await createLegacyGeminiEmbeddingProvider();
    await expect(provider.embed("test query", { inputType: "query" })).rejects.toThrow(
      "gemini embeddings failed: malformed JSON response",
    );
    await expect(provider.embedBatch(["one"], { inputType: "document" })).rejects.toThrow(
      "gemini embeddings failed: malformed JSON response",
    );
    await expect(
      provider.embedBatch([{ text: "one", parts: [{ type: "text", text: "one" }] }]),
    ).rejects.toThrow("gemini embeddings failed: malformed JSON response");
  });

  it("rejects batch embedding count mismatches", async () => {
    installFetchMock(() => ({ embeddings: [{ values: [1, 2] }] }));

    const { provider } = await createLegacyGeminiEmbeddingProvider();

    await expect(provider.embedBatch(["one", "two"], { inputType: "document" })).rejects.toThrow(
      "gemini embeddings failed: malformed JSON response",
    );
  });

  it("formats stable Gemini retrieval requests and honors explicit query instructions", async () => {
    const fetchMock = installAxisVectorFetchMock(768);
    const { provider } = await createProvider();

    await provider.embed("find this", { inputType: "query" });
    await provider.embed("custom: find this", {
      inputType: "query",
      queryInstructionApplied: true,
    });
    await provider.embedBatch(["custom: find this"], {
      inputType: "query",
      queryInstructionApplied: true,
    });
    await provider.embedBatch(["remember this"], {
      inputType: "document",
      queryInstructionApplied: true,
    });

    expect(fetchJsonBody(fetchMock, 0)).toEqual({
      content: { parts: [{ text: "task: search result | query: find this" }] },
      outputDimensionality: 768,
    });
    for (const index of [1, 2]) {
      expect(fetchJsonBody(fetchMock, index)).toEqual({
        content: { parts: [{ text: "custom: find this" }] },
        outputDimensionality: 768,
      });
    }
    expect(fetchJsonBody(fetchMock, 3)).toEqual({
      requests: [
        {
          content: { parts: [{ text: "title: none | text: remember this" }] },
          model: "models/gemini-embedding-2",
          outputDimensionality: 768,
        },
      ],
    });
  });

  it.each([
    ["QUESTION_ANSWERING", "question answering"],
    ["FACT_VERIFICATION", "fact checking"],
  ] as const)("keeps %s query and document instructions asymmetric", async (taskType, task) => {
    const fetchMock = installAxisVectorFetchMock(768);
    const { provider } = await createProvider({ taskType });

    await provider.embed("find this", { inputType: "query" });
    await provider.embedBatch(["remember this"], { inputType: "document" });

    expect(fetchJsonBody(fetchMock, 0)).toMatchObject({
      content: { parts: [{ text: `task: ${task} | query: find this` }] },
    });
    expect(fetchJsonBody(fetchMock, 1)).toMatchObject({
      requests: [{ content: { parts: [{ text: "title: none | text: remember this" }] } }],
    });
  });

  it("rejects Gemini 2 responses that drift from the requested dimensions", async () => {
    installAxisVectorFetchMock(3072);
    const { provider } = await createProvider();

    await expect(provider.embed("test query", { inputType: "query" })).rejects.toThrow(
      "gemini embeddings failed: expected 768 dimensions, received 3072",
    );
    await expect(provider.embedBatch(["test document"], { inputType: "document" })).rejects.toThrow(
      "gemini embeddings failed: expected 768 dimensions, received 3072",
    );
  });
});
