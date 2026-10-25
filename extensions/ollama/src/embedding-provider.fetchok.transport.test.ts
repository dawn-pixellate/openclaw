// Real SSRF guard and loopback transport, including reflected-credential redaction.
import "openclaw/plugin-sdk/compiled-subprocess-testing";
import { createServer } from "node:http";
import { buffer as consumeBuffer } from "node:stream/consumers";
import { afterEach, describe, expect, it, vi } from "vitest";
import { listenOnLoopback } from "../../test-support/hanging-loopback-server.js";
import { createOllamaEmbeddingProvider } from "./embedding-provider.js";

type OllamaRequest = {
  method: string | undefined;
  url: string | undefined;
  authorization: string | undefined;
  proxyAuthorization: string | undefined;
  proxyAuth: string | undefined;
  body: string;
};

const servers: Array<{ close: () => Promise<void> }> = [];

function mixPercentEscapeCase(value: string): string {
  return value.replace(/%[0-9A-F]{2}/gu, (escape, offset: number) =>
    offset % 2 === 0 ? escape.toLowerCase() : escape,
  );
}

async function startOllamaServer(
  status: number,
  respond: string | ((request: OllamaRequest) => Record<string, unknown>),
) {
  const requests: OllamaRequest[] = [];
  const server = createServer((req, res) => {
    void (async () => {
      const bodyBuffer = await consumeBuffer(req);
      const request: OllamaRequest = {
        method: req.method,
        url: req.url,
        authorization: req.headers.authorization,
        proxyAuthorization: req.headers["proxy-authorization"],
        proxyAuth:
          typeof req.headers["x-proxy-auth"] === "string" ? req.headers["x-proxy-auth"] : undefined,
        body: bodyBuffer.toString("utf8"),
      };
      requests.push(request);
      res.writeHead(status, { "content-type": "application/json" });
      res.end(typeof respond === "string" ? respond : JSON.stringify(respond(request)));
    })();
  });

  const port = await listenOnLoopback(server);

  servers.push({
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  });

  return { baseUrl: `http://127.0.0.1:${port}`, requests };
}

type EmbeddingOptions = Parameters<typeof createOllamaEmbeddingProvider>[0];
function createOptions(baseUrl: string, remote: EmbeddingOptions["remote"] = {}): EmbeddingOptions {
  return {
    config: {},
    provider: "ollama",
    model: "test-embedding",
    fallback: "none",
    remote: { baseUrl, ...remote },
  };
}

async function captureEmbeddingError(options: EmbeddingOptions): Promise<Error | undefined> {
  const { provider } = await createOllamaEmbeddingProvider(options);
  try {
    await provider.embed("hello", { inputType: "query" });
  } catch (error) {
    return error as Error;
  }
  return undefined;
}

function expectRequest(
  server: Awaited<ReturnType<typeof startOllamaServer>>,
  headers: Partial<OllamaRequest>,
) {
  expect(server.requests).toEqual([
    {
      method: "POST",
      url: "/api/embed",
      authorization: undefined,
      proxyAuthorization: undefined,
      proxyAuth: undefined,
      body: JSON.stringify({ model: "test-embedding", input: "hello" }),
      ...headers,
    },
  ]);
}

function expectRedacted(error: Error | undefined, diagnostic: string, ...secrets: string[]) {
  expect(error?.message).toContain(diagnostic);
  for (const secret of secrets) {
    expect(error?.message).not.toContain(secret);
  }
}

function formEncode(value: string) {
  return new URLSearchParams([["value", value]]).toString().slice("value=".length);
}

describe("Ollama embedding provider real transport", () => {
  afterEach(async () => {
    vi.unstubAllEnvs();
    await Promise.all(servers.splice(0).map((server) => server.close()));
  });

  it("redacts bare authorization credentials reflected under unknown fields", async () => {
    const authorizationCredential = "v9M2q7L4n8R6t1W5c3K0";
    const proxyAuthorizationCredential = "p4Z8m1D7s5J2x9Q6h3V0";
    const server = await startOllamaServer(429, (request) => ({
      error: "rate limit exceeded",
      upstreamEcho: request.authorization?.replace(/^\S+\s+/u, ""),
      proxyUpstreamEcho: request.proxyAuthorization?.replace(/^\S+\s+/u, ""),
    }));

    const error = await captureEmbeddingError(
      createOptions(server.baseUrl, {
        headers: {
          Authorization: `Bearer ${authorizationCredential}`,
          "Proxy-Authorization": `Basic ${proxyAuthorizationCredential}`,
        },
      }),
    );
    expectRequest(server, {
      authorization: `Bearer ${authorizationCredential}`,
      proxyAuthorization: `Basic ${proxyAuthorizationCredential}`,
    });
    expect(error?.message).toContain("Ollama embed HTTP 429");
    expectRedacted(
      error,
      "rate limit exceeded",
      authorizationCredential,
      proxyAuthorizationCredential,
    );
  });

  it("redacts a form-serialized custom SecretRef header from embed errors", async () => {
    const proxyAuth = "proxy AAAAUNIQUEOLLAMA~PROXYSECRET XXXX11112222";
    const formEncodedProxyAuth = formEncode(proxyAuth);
    const reflectedFormEncodedProxyAuth = mixPercentEscapeCase(formEncodedProxyAuth);
    vi.stubEnv("OLLAMA_PROXY_AUTH", proxyAuth);
    const server = await startOllamaServer(403, (request) => ({
      error: "forbidden",
      upstreamEcho: request.proxyAuth
        ? mixPercentEscapeCase(formEncode(request.proxyAuth))
        : undefined,
    }));

    const ollama = {
      baseUrl: server.baseUrl,
      models: [],
      headers: {
        "X-Proxy-Auth": { source: "env" as const, provider: "default", id: "OLLAMA_PROXY_AUTH" },
      },
    };
    const error = await captureEmbeddingError({
      ...createOptions(server.baseUrl),
      remote: undefined,
      config: { models: { providers: { ollama } } },
    });

    expectRequest(server, { proxyAuth });
    expect(error?.message).toContain("Ollama embed HTTP 403");
    expectRedacted(
      error,
      "forbidden",
      proxyAuth,
      formEncodedProxyAuth,
      reflectedFormEncodedProxyAuth,
      "UNIQUEOLLAMAPROXYSECRET",
    );
  });

  it("redacts a configured header prefix split by the 8 KiB error cap", async () => {
    const proxyAuth = "embedding-boundary-credential-secret";
    const retainedPrefix = proxyAuth.slice(0, -5);
    const safeMarker = "bounded embedding diagnostic: ";
    const body = `${safeMarker}${"x".repeat(8 * 1024 - safeMarker.length - retainedPrefix.length)}${proxyAuth} trailing text`;
    const server = await startOllamaServer(429, body);

    const error = await captureEmbeddingError(
      createOptions(server.baseUrl, { headers: { "X-Proxy-Auth": proxyAuth } }),
    );

    expectRedacted(error, safeMarker, retainedPrefix, proxyAuth);
  });

  it.each([undefined, 2])("normalizes vectors with outputDimensionality=%s", async (dimensions) => {
    const apiKey = "ollama_test_success_credential";
    const proxyAuth = "ollama_test_success_proxy_credential";
    const server = await startOllamaServer(200, () => ({
      embeddings: [dimensions === undefined ? [3, 4] : [3, 4, 12]],
    }));
    const { provider } = await createOllamaEmbeddingProvider({
      ...createOptions(server.baseUrl, { apiKey, headers: { "X-Proxy-Auth": proxyAuth } }),
      dimensions,
    });

    const vector = await provider.embed("hello", { inputType: "query" });

    expectRequest(server, { authorization: `Bearer ${apiKey}`, proxyAuth });
    expect(vector).toHaveLength(2);
    expect(vector[0]).toBeCloseTo(0.6, 5);
    expect(vector[1]).toBeCloseTo(0.8, 5);
  });
});
