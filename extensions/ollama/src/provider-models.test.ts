import { withTimeout } from "@openclaw/fs-safe/advanced";
import { expectDefined } from "@openclaw/normalization-core";
import { jsonResponse, requestUrl, withServer } from "openclaw/plugin-sdk/test-env";
import { oversizedJsonResponse } from "openclaw/plugin-sdk/test-fixtures";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildOllamaProvider,
  buildOllamaBaseUrlSsrFPolicy,
  enrichOllamaCompletionModels,
  enrichOllamaModelsWithContext,
  fetchLoadedOllamaModelNames,
  fetchOllamaModels,
  queryOllamaModelShowInfo,
  toDynamicOllamaModel,
  type OllamaTagModel,
} from "./provider-models.js";
const localUrl = "http://127.0.0.1:11434";
const completion = ["completion"];

afterEach(() => vi.unstubAllGlobals());

async function discoverModel(url = localUrl) {
  const provider = await buildOllamaProvider(url);
  const model = expectDefined(provider.models[0], "discovered model");
  return {
    model,
    runtime: toDynamicOllamaModel({ provider: "ollama", providerConfig: provider, model }),
  };
}

function stubDiscovery(models: OllamaTagModel[], show: unknown = {}) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request) =>
      jsonResponse(requestUrl(input).endsWith("/api/tags") ? { models } : show),
    ),
  );
}

describe("ollama provider models", () => {
  it.each([
    { tagSize: "1.5B", expected: 1_500_000_000 },
    { tagSize: "494M", expected: 494_000_000 },
    { tagSize: "1.2T", expected: 1_200_000_000_000 },
    { tagSize: "4B", showCount: 70_000_000_000, expected: 70_000_000_000 },
    { showSize: "32.8B", expected: 32_800_000_000 },
    { tagSize: "unknown", expected: undefined },
  ])(
    "keeps total parameter metadata through discovery: %j",
    async ({ tagSize, showCount, showSize, expected }) => {
      stubDiscovery([{ name: "custom-model", details: { parameter_size: tagSize } }], {
        capabilities: completion,
        model_info: { "general.parameter_count": showCount },
        details: { parameter_size: showSize },
      });
      const { model, runtime } = await discoverModel();
      expect([model.parameterCount, runtime.parameterCount]).toEqual([expected, expected]);
    },
  );

  it("keeps strict node discovery closed when remote completion is only inferred", async () => {
    stubDiscovery([]);
    const model = { name: "remote", remote_model: "upstream", capabilities: ["tools"] };
    await expect(
      enrichOllamaCompletionModels(localUrl, [model], { requireCompletionCapability: true }),
    ).resolves.toEqual([]);
  });

  it("reads loaded models from /api/ps with remote auth", async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      expect(requestUrl(input)).toBe("https://ollama.example.com/api/ps");
      expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer private-key");
      return jsonResponse({
        models: [{ name: "qwen3.5:4b" }, { model: "llama3.3:70b" }, { name: "   " }, {}],
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      fetchLoadedOllamaModelNames("https://ollama.example.com/v1", {
        apiKey: "private-key",
      }),
    ).resolves.toEqual({
      reachable: true,
      models: ["qwen3.5:4b", "llama3.3:70b"],
    });
  });

  it("scopes cached show metadata by credential", async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = requestUrl(input);
      if (url.endsWith("/api/tags")) {
        return jsonResponse({ models: [{ name: "private-model", digest: "stable" }] });
      }
      const apiKey = new Headers(init?.headers).get("Authorization");
      return jsonResponse({
        model_info: {
          "private.context_length": apiKey === "Bearer account-a" ? 16_000 : 32_000,
        },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const [first, second, third] = await Promise.all(
      ["account-a", "account-b", "account-a"].map(
        async (apiKey) => await buildOllamaProvider("https://ollama.example.com", { apiKey }),
      ),
    );

    expect([first, second, third].map((provider) => provider?.models[0]?.contextWindow)).toEqual([
      16_000, 32_000, 16_000,
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(5);
  });

  it.each<[name: string, url: string, maxTokens: number, remote?: Partial<OllamaTagModel>]>([
    ["local-model", localUrl, 8192],
    ["minimax-m3", localUrl, 8192],
    ["kimi-k3", localUrl, 8192],
    ["minimax-m3", "https://ollama.com", 524_288],
    ["minimax-m3-cloud", localUrl, 524_288],
    ["kimi-k3", "https://ollama.com", 1_048_576],
    ["glm-5.2:cloud", localUrl, 131_072],
    ["unknown:cloud", localUrl, 262_144],
    ["unknown", "https://ollama.com", 262_144],
    ["remote-stub", localUrl, 262_144, { remote_host: "https://ollama.com" }],
    ["remote-model-stub", localUrl, 262_144, { remote_model: "upstream-model" }],
  ])("discovers %s output limits at %s", async (name, url, maxTokens, remote) => {
    stubDiscovery([{ name, ...remote }], {
      capabilities: completion,
      model_info: name.endsWith("-cloud") ? {} : { "test.context_length": 262_144 },
    });
    expect((await discoverModel(url)).runtime).toMatchObject({
      id: name,
      maxTokens,
      ...(name.endsWith("-cloud") ? { contextWindow: 524_288 } : {}),
    });
  });

  it("uses Modelfile num_ctx when it expands the discovered context window", async () => {
    const models = [{ name: "llama3-32k:latest" }];
    stubDiscovery(models, {
      model_info: { "llama.context_length": 8192 },
      parameters: 'stop "<|eot_id|>"\nnum_ctx 32768\nnum_keep 5',
      capabilities: completion,
    });
    expect(await enrichOllamaModelsWithContext(localUrl, models)).toEqual([
      { name: "llama3-32k:latest", contextWindow: 32768, capabilities: completion },
    ]);
  });

  it.each(["tags", "show"])("closes a real failed %s discovery socket", async (endpoint) => {
    let closed: Promise<void> | undefined;
    await withServer(
      (request, response) => {
        expect(request.url).toBe(`/api/${endpoint}`);
        closed = new Promise<void>((resolve) => {
          request.socket.once("close", resolve);
        });
        response.writeHead(503, { "content-type": "text/plain" });
        // Only client cancellation can close this unfinished response.
        response.write("ollama unavailable");
      },
      async (baseUrl) => {
        const result =
          endpoint === "tags"
            ? await fetchOllamaModels(baseUrl)
            : await queryOllamaModelShowInfo(baseUrl, "llama3:8b");
        expect(result).toEqual(
          endpoint === "tags" ? { reachable: true, models: [] } : { showInspectionFailed: true },
        );
        await withTimeout(expectDefined(closed, "failed discovery socket"), 2_000, {
          message: "Failed discovery socket was not closed",
        });
      },
    );
  });

  it.each([
    [200, "deepseek-r1:671b", { remote_host: "https://ollama.example" }, ["vision"], true],
    [500, "remote-chat:latest", { remote_model: "upstream-chat" }, ["tools"], false],
  ] as const)(
    "preserves remote list metadata after inspection HTTP %i",
    async (status, name, remote, capabilities, reasoning) => {
      const listed = {
        name,
        ...remote,
        details: { context_length: 32_768 },
        capabilities,
      };
      await withServer(
        (request, response) => {
          expect(["/api/tags", "/api/show"]).toContain(request.url);
          const tags = request.url === "/api/tags";
          response.writeHead(tags ? 200 : status, { "Content-Type": "application/json" });
          response.end(
            JSON.stringify(
              tags ? { models: [listed] } : status === 200 ? {} : { error: "show failed" },
            ),
          );
        },
        async (baseUrl) => {
          expect((await discoverModel(baseUrl)).model).toMatchObject({
            id: listed.name,
            contextWindow: 32_768,
            input: status === 200 ? ["text", "image"] : ["text"],
            compat: { supportsTools: true },
            reasoning,
          });
        },
      );
    },
  );

  it.each(["tags", "show"] as const)(
    "bounds %s discovery JSON and cancels oversized streams",
    async (endpoint) => {
      // Advertise 32 MiB, twice the shared JSON cap, and observe early cancellation.
      const oversized = oversizedJsonResponse({ chunkCount: 32, chunkSize: 1024 * 1024 });
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => oversized.response),
      );
      const result =
        endpoint === "tags"
          ? await fetchOllamaModels(localUrl)
          : await queryOllamaModelShowInfo(localUrl, "evil-model:latest");
      expect(result).toEqual(
        endpoint === "tags" ? { reachable: false, models: [] } : { showInspectionFailed: true },
      );
      expect(oversized.wasCanceled()).toBe(true);
      expect(oversized.getReadCount()).toBeLessThan(32);
    },
  );
});

describe("Ollama model discovery failures", () => {
  it.each([503, "offline", "invalid-json", "missing-models"])(
    "preserves advisory discovery while strict catalogs reject %s",
    async (failure) => {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => {
          if (failure === "offline") {
            throw new Error("Ollama endpoint unavailable");
          }
          return new Response(failure === "invalid-json" ? "{" : "{}", {
            status: typeof failure === "number" ? failure : 200,
          });
        }),
      );

      await expect(buildOllamaProvider(localUrl, { quiet: true })).resolves.toMatchObject({
        models: [],
      });
      await expect(buildOllamaProvider(localUrl, { discoveryMode: "strict" })).rejects.toThrow();
    },
  );
});

describe("buildOllamaBaseUrlSsrFPolicy", () => {
  it.each([
    [localUrl, "127.0.0.1"],
    ["http://192.168.1.10:11434", "192.168.1.10"],
    ["https://ollama.example.com/v1", "ollama.example.com"],
  ])("pins requests to the configured HTTP(S) hostname %s", (url, hostname) => {
    expect(buildOllamaBaseUrlSsrFPolicy(url)).toEqual({
      hostnameAllowlist: [hostname],
      allowPrivateNetwork: true,
    });
  });

  it.each(["", "ftp://ollama.example.com", "not-a-url", "http://metadata.google.internal"])(
    "rejects empty, invalid or blocked base URL %s",
    (url) => {
      expect(buildOllamaBaseUrlSsrFPolicy(url)).toBeUndefined();
    },
  );
});
