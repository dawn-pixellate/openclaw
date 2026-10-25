import { setImmediate as nextTurn } from "node:timers/promises";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { createTestWizardPrompter } from "openclaw/plugin-sdk/plugin-test-runtime";
import { jsonResponse, withServer } from "openclaw/plugin-sdk/test-env";
import { raceWithTimeout } from "openclaw/plugin-sdk/time-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  enrichOllamaModelsWithContext,
  fetchOllamaModels,
  readOllamaModelShowInfo,
} from "./provider-models.js";
import { pullOllamaModel } from "./setup-pull.js";
import { checkOllamaCloudAuth } from "./setup.runtime.js";

const fetchWithSsrFGuardMock = vi.hoisted(() => vi.fn());
const baseUrl = "http://127.0.0.1:11434";
const pull = (url: string) =>
  pullOllamaModel(
    url,
    "gemma4:e2b",
    createTestWizardPrompter({ progress: () => ({ update: vi.fn(), stop: vi.fn() }) }),
  );
const failedPull = async (url: string) => {
  await expect(pull(url)).resolves.toBe(false);
};
const unavailable = "ollama unavailable";
const diskFull = '{"error":"disk full"}\n';

afterEach(() => {
  fetchWithSsrFGuardMock.mockReset();
  vi.useRealTimers();
});

describe("Ollama setup response cleanup", () => {
  it.each([
    [
      "model inspection error",
      "/api/show",
      503,
      unavailable,
      (url: string) => readOllamaModelShowInfo(url, "gemma4:e2b").catch(() => undefined),
    ],
    ["model discovery error", "/api/tags", 503, unavailable, fetchOllamaModels],
    ["successful auth probe", "/api/me", 200, '{"status":"unused"}\n', checkOllamaCloudAuth],
    ["auth probe fallback", "/api/me", 503, unavailable, checkOllamaCloudAuth],
    ["pull response error", "/api/pull", 503, unavailable, failedPull],
    ["pull stream error", "/api/pull", 200, diskFull, failedPull],
  ] as const)(
    "releases %s without waiting for a captured clone and closes its socket",
    async (_name, path, status, body, run) => {
      const closed = createDeferred<void>();
      const responseReady = createDeferred<void>();
      const release = vi.fn(async () => {});
      let response: Response | undefined;
      let capture: Response | undefined;
      await withServer(
        (request, reply) => {
          expect(request.url).toBe(path);
          request.socket.once("close", () => closed.resolve());
          reply.writeHead(status, { "content-type": "application/json" });
          reply.write(body);
        },
        async (url) => {
          fetchWithSsrFGuardMock.mockImplementation(
            async (params: { url: string; init?: RequestInit; signal?: AbortSignal }) => {
              response = await fetch(params.url, { ...params.init, signal: params.signal });
              capture = response.clone();
              responseReady.resolve();
              return { response, finalUrl: params.url, release };
            },
          );
          try {
            const running = run(url);
            await responseReady.promise;
            const result = await raceWithTimeout(running, 500, () => {
              throw new Error("Ollama cleanup waited for a captured response clone");
            });
            if (path === "/api/tags") {
              expect(result).toEqual({ reachable: true, models: [] });
            }
            expect(response?.bodyUsed).toBe(true);
            expect(release).toHaveBeenCalledOnce();
          } finally {
            await capture?.body?.cancel().catch(() => undefined);
          }
          await raceWithTimeout(closed.promise, 2_000, () => {
            throw new Error("Ollama response socket was not closed");
          });
        },
      );
    },
  );

  it("joins sibling model-probe cleanup before rejecting with the original cancellation", async () => {
    const controller = new AbortController();
    const cancellation = new Error("model discovery canceled");
    const cleanups = [createDeferred<void>(), createDeferred<void>()] as const;
    const releases = cleanups.map((cleanup) => vi.fn(() => cleanup.promise));
    for (const release of releases) {
      fetchWithSsrFGuardMock.mockResolvedValueOnce({
        response: jsonResponse({ capabilities: ["completion"] }),
        finalUrl: "http://127.0.0.1:11434/api/show",
        release,
      });
    }
    let settled = false;
    const completed = enrichOllamaModelsWithContext(
      "http://127.0.0.1:11434",
      [{ name: "first-model" }, { name: "sibling-model" }],
      { signal: controller.signal },
    ).finally(() => {
      settled = true;
    });
    const rejected = expect(completed).rejects.toBe(cancellation);
    try {
      await vi.waitFor(() => {
        for (const release of releases) {
          expect(release).toHaveBeenCalledOnce();
        }
      });
      controller.abort(cancellation);
      cleanups[0].reject(new Error("first request closed"));
      await nextTurn();
      expect(settled).toBe(false);

      cleanups[1].reject(new Error("sibling request closed"));
      await rejected;
    } finally {
      for (const cleanup of cleanups) {
        cleanup.resolve();
      }
      await rejected;
    }
  });
});

function mockPull(body: BodyInit, update: () => void = vi.fn()) {
  const release = vi.fn(async () => {});
  fetchWithSsrFGuardMock.mockResolvedValue({ response: new Response(body), release });
  const progress = { update, stop: vi.fn() };
  const prompter = createTestWizardPrompter({ progress: () => progress });
  return async (ok: boolean, message: unknown = "Downloaded gemma4:e2b") => {
    await expect(pullOllamaModel(baseUrl, "gemma4:e2b", prompter)).resolves.toBe(ok);
    expect(progress.stop).toHaveBeenCalledWith(message);
    expect(release).toHaveBeenCalledOnce();
  };
}

vi.mock("openclaw/plugin-sdk/ssrf-runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/ssrf-runtime")>();
  return { ...actual, fetchWithSsrFGuard: fetchWithSsrFGuardMock };
});

describe("Ollama onboarding model pulls", () => {
  it("clears the response timer after a successful pull", async () => {
    vi.useFakeTimers();
    await mockPull('{"status":"success"}\n')(true);
    const signal: AbortSignal = fetchWithSsrFGuardMock.mock.calls[0][0].signal;
    expect(signal).toBeInstanceOf(AbortSignal);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(signal.aborted).toBe(false);
  });

  it("fails a stalled stream at the idle deadline", async () => {
    vi.useFakeTimers();
    const check = mockPull(new ReadableStream<Uint8Array>());
    const result = check(
      false,
      "Failed to download gemma4:e2b: Ollama pull stalled: no data received for 300s",
    );
    await vi.advanceTimersByTimeAsync(300_000);
    await result;
  });

  it("requires a success terminal after model progress", async () => {
    const body = '{"status":"pulling abcdef123456","total":100,"completed":40}\n';
    await mockPull(body)(false, "Failed to download gemma4:e2b: pull stream ended before success");
  });

  it.each<[string, BodyInit]>([
    ["unterminated success", '{"status":"success"}'],
    ["malformed progress before success", 'null\nnot valid json\n{"status":"success"}'],
    [
      "tolerantly decoded progress before success",
      new Uint8Array([
        ...new TextEncoder().encode('{"status":"pulling '),
        0xff,
        ...new TextEncoder().encode('"}\n{"status":"success"}'),
      ]),
    ],
  ])("accepts %s", async (_label, body) => {
    await mockPull(body)(true);
  });

  it.each([
    { status: "pulling manifest" },
    { status: "pulling abcdef123456", total: 100, completed: 40 },
  ])("reports progress failures instead of a successful pull for %j", async (chunk) => {
    const check = mockPull(
      `${JSON.stringify(chunk)}\n{"status":"success"}\n`,
      vi.fn(() => {
        throw new Error("progress display failed");
      }),
    );
    await check(false, "Failed to download gemma4:e2b: progress display failed");
  });

  it("coerces non-Error stream failures through the shared error contract", async () => {
    const check = mockPull(
      new ReadableStream<Uint8Array>({
        pull(controller) {
          controller.error({ code: "OLLAMA_PULL_INTERRUPTED" });
        },
      }),
    );
    await check(
      false,
      expect.stringContaining("Failed to download gemma4:e2b: Non-Error rejection"),
    );
  });
});
