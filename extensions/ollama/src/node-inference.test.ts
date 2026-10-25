import type { IncomingMessage, ServerResponse } from "node:http";
import { text } from "node:stream/consumers";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { createTestPluginApi } from "openclaw/plugin-sdk/plugin-test-api";
import { withServer } from "openclaw/plugin-sdk/test-env";
import { describe, expect, it, vi } from "vitest";
import { createOllamaNodeInvokePolicy } from "./node-inference-registration.js";
import { createOllamaNodeHostCommands, createOllamaNodeInferenceTool } from "./node-inference.js";

const [OLLAMA_MODELS_COMMAND, OLLAMA_CHAT_COMMAND] = createOllamaNodeInvokePolicy().commands;
if (!OLLAMA_MODELS_COMMAND || !OLLAMA_CHAT_COMMAND) {
  throw new Error("Ollama node inference policy must register models and chat commands");
}

type NodeRuntime = OpenClawPluginApi["runtime"]["nodes"];
type NodeRow = Awaited<ReturnType<NodeRuntime["list"]>>["nodes"][number];
function nodeApi(nodes: NodeRow[], invoke: NodeRuntime["invoke"]) {
  return createTestPluginApi({
    runtime: { nodes: { list: async () => ({ nodes }), invoke } } as never,
  });
}

function inferenceNode(
  nodeId: string,
  invocableCommands?: string[],
  displayName?: string,
): NodeRow {
  return {
    nodeId,
    connected: true,
    commands: ["ollama.models", "ollama.chat"],
    ...(invocableCommands ? { invocableCommands } : {}),
    ...(displayName ? { displayName } : {}),
  };
}

function sendJson(response: ServerResponse, body: unknown): void {
  response.end(JSON.stringify(body));
}

async function readBody(request: IncomingMessage, body?: string): Promise<unknown> {
  return JSON.parse(body ?? (await text(request)));
}

async function withOllamaServer(
  run: (
    baseUrl: string,
    chatRequests: Record<string, unknown>[],
    showRequests: string[],
    requests: string[],
    canceled: string[],
  ) => Promise<void>,
  options?: {
    models: Array<Record<string, unknown>>;
    loadedModels?: Array<Record<string, unknown>> | false;
    stallPath?: string;
    stallCount?: number;
    delays?: Partial<Record<string, number>>;
    showContextWindow?: number;
    chatContent?: string;
  },
): Promise<void> {
  const chatRequests: Record<string, unknown>[] = [];
  const showRequests: string[] = [];
  const requests: string[] = [];
  const canceled: string[] = [];
  let stalls = 0;
  const handleRequest = async (request: IncomingMessage, response: ServerResponse) => {
    const path = request.url ?? "/";
    if (path !== "/api/ps") {
      requests.push(path);
    }
    if (path === options?.stallPath && stalls < (options?.stallCount ?? Infinity)) {
      stalls++;
      response.once("close", () => {
        if (!response.writableFinished) {
          canceled.push(path);
        }
      });
      return;
    }
    const bodyText = options?.delays && path !== "/api/tags" ? await text(request) : undefined;
    if (bodyText === "") {
      throw new Error("Ollama deadline test received an empty POST body");
    }
    const delay = options?.delays?.[path];
    if (delay !== undefined) {
      await new Promise<void>((resolve) => {
        setTimeout(resolve, delay);
      });
      if (response.destroyed) {
        return;
      }
    }
    response.setHeader("Content-Type", "application/json");
    if (request.url === "/api/tags") {
      return sendJson(response, {
        models: options?.models ?? [
          { name: "remote:cloud", size: 1, remote_host: "https://ollama.com", details: {} },
          { name: "remote-model-only:latest", size: 1, remote_model: "upstream-chat", details: {} },
          { name: "tagged-only:cloud", size: 1, details: {} },
          { name: "tagged-only:120b-cloud", size: 1, details: {} },
          {
            name: "chat:small",
            size: 500,
            modified_at: "2026-07-01T00:00:00Z",
            details: { family: "small", parameter_size: "0.5B", quantization_level: "Q4_K_M" },
          },
          { name: "chat:large", size: 5000, details: { family: "large" } },
          { name: "embedding:latest", size: 100, details: { family: "embed" } },
          { name: "unknown:latest", size: 50, details: { family: "unknown" } },
        ],
      });
    }
    if (request.url === "/api/ps" && options?.loadedModels !== false) {
      return sendJson(response, { models: options?.loadedModels ?? [{ name: "chat:large" }] });
    }
    if (request.url === "/api/show") {
      const body = (await readBody(request, bodyText)) as { model?: string };
      if (body.model) {
        showRequests.push(body.model);
      }
      if (body.model === "unknown:latest") {
        response.statusCode = 500;
        return sendJson(response, { error: "show failed" });
      }
      const embedding = body.model?.startsWith("embedding") === true;
      return sendJson(response, {
        capabilities: embedding ? ["embedding"] : ["completion", "tools"],
        model_info: embedding ? {} : { "test.context_length": options?.showContextWindow ?? 32768 },
      });
    }
    if (request.url === "/api/chat") {
      const body = (await readBody(request, bodyText)) as Record<string, unknown>;
      chatRequests.push(body);
      return sendJson(response, {
        model: body.model,
        message: { content: options?.chatContent ?? "local answer" },
        done_reason:
          (body.options as { num_predict?: unknown } | undefined)?.num_predict === 1
            ? "length"
            : "stop",
        prompt_eval_count: 8,
        eval_count: 3,
        load_duration: 2_500_000,
        total_duration: 12_750_000,
      });
    }
    response.statusCode = 404;
    response.end(JSON.stringify({ error: "not found" }));
  };
  await withServer(
    (request, response) => {
      void handleRequest(request, response);
    },
    (baseUrl) => run(baseUrl, chatRequests, showRequests, requests, canceled),
  );
}

function commandByName(baseUrl: string, command: string) {
  const entry = createOllamaNodeHostCommands({ baseUrl }).find(
    (candidate) => candidate.command === command,
  );
  if (!entry) {
    throw new Error(`missing ${command} test command`);
  }
  return entry;
}

function chat(baseUrl: string, params: Record<string, unknown>) {
  return commandByName(baseUrl, OLLAMA_CHAT_COMMAND).handle(JSON.stringify(params));
}

async function models(baseUrl: string): Promise<{
  provider: string;
  models: Array<Record<string, unknown>>;
}> {
  return JSON.parse(await commandByName(baseUrl, OLLAMA_MODELS_COMMAND).handle());
}

describe("Ollama node host inference", () => {
  it("discovers local chat models and ranks loaded models first", async () => {
    await withOllamaServer(async (baseUrl) => {
      const result = await models(baseUrl);

      expect(result.provider).toBe("ollama");
      expect(result.models.map((model) => model.name)).toEqual(["chat:large", "chat:small"]);
      expect(result.models[0]).toMatchObject({ loaded: true, contextWindow: 32768 });
      expect(result.models[1]).toMatchObject({
        loaded: false,
        family: "small",
        parameterSize: "0.5B",
        quantization: "Q4_K_M",
      });
    });
  });

  it("discovers a loaded local model beyond the completion model limit", async () => {
    const catalog = [
      ...Array.from({ length: 200 }, (_, index) => ({ name: `chat-${index}:latest` })),
      { name: "chat:loaded", size: 500 },
    ];

    await withOllamaServer(
      async (baseUrl, _chatRequests, showRequests) => {
        const result = await models(baseUrl);

        expect(result.provider).toBe("ollama");
        expect(result.models).toHaveLength(200);
        expect(result.models[0]).toMatchObject({ name: "chat:loaded", loaded: true });
        expect(showRequests[0]).toBe("chat:loaded");
        expect(showRequests).toHaveLength(200);
      },
      { models: catalog, loadedModels: [{ name: "chat:loaded" }] },
    );
  });

  it("runs bounded chat and returns compact usage", async () => {
    await withOllamaServer(async (baseUrl, chatRequests, showRequests) => {
      const result = JSON.parse(
        await chat(baseUrl, {
          model: "chat:small",
          prompt: "Summarize this",
          system: "Be concise",
          maxTokens: 64,
          temperature: 0.2,
        }),
      );

      expect(chatRequests).toEqual([
        {
          model: "chat:small",
          messages: [
            { role: "system", content: "Be concise" },
            { role: "user", content: "Summarize this" },
          ],
          stream: false,
          think: false,
          options: { num_predict: 64, temperature: 0.2 },
        },
      ]);
      expect(showRequests).toEqual(["chat:small"]);
      expect(result).toEqual({
        provider: "ollama",
        model: "chat:small",
        response: "local answer",
        usage: { promptTokens: 8, completionTokens: 3 },
        timings: { loadMs: 2.5, totalMs: 12.75 },
      });
    });
  });

  it("rejects remote and non-chat models before inference", async () => {
    await withOllamaServer(async (baseUrl, chatRequests) => {
      for (const model of [
        "remote:cloud",
        "remote-model-only:latest",
        "tagged-only:cloud",
        "tagged-only:120b-cloud",
        "embedding:latest",
      ]) {
        await expect(chat(baseUrl, { model, prompt: "hello" })).rejects.toThrow(
          "is not a local chat model",
        );
      }
      expect(chatRequests).toHaveLength(0);
    });
  });

  it("rejects a token-limited partial answer", async () => {
    await withOllamaServer(async (baseUrl) => {
      await expect(
        chat(baseUrl, { model: "chat:small", prompt: "long answer", maxTokens: 1 }),
      ).rejects.toThrow("reaching maxTokens (1)");
    });
  });

  it("registers a desktop and server pass-through policy", async () => {
    const policy = createOllamaNodeInvokePolicy();
    const invokeNode = vi.fn(async () => ({ ok: true as const, payload: { ok: true } }));

    expect(policy.commands).toEqual(["ollama.models", "ollama.chat"]);
    expect(policy.defaultPlatforms).toEqual(["macos", "linux", "windows"]);
    await expect(policy.handle({ invokeNode } as never)).resolves.toEqual({
      ok: true,
      payload: { ok: true },
    });
  });
});

describe("node_inference agent tool", () => {
  it("uses a flat action enum supported by local model providers", () => {
    const tool = createOllamaNodeInferenceTool(createTestPluginApi());
    const action = (tool.parameters as { properties: { action: unknown } }).properties.action;

    expect(action).toMatchObject({ type: "string", enum: ["discover", "run"] });
    expect(action).not.toHaveProperty("anyOf");
    expect(action).not.toHaveProperty("oneOf");
  });

  it.each(["discover", "run"] as const)("routes %s only to authorized nodes", async (action) => {
    const discovery = action === "discover";
    const command = discovery ? OLLAMA_MODELS_COMMAND : OLLAMA_CHAT_COMMAND;
    const timeoutMs = discovery ? 90_000 : 120_000;
    const payload = discovery
      ? { provider: "ollama", models: [{ name: "chat:small", loaded: true }] }
      : { provider: "ollama", model: "chat:small", response: "done" };
    const params = discovery ? {} : { model: "chat:small", prompt: "answer fast", maxTokens: 32 };
    const invoke = vi.fn(async () => ({ payload }));
    const api = nodeApi(
      [
        inferenceNode("denied-node", discovery ? [] : [OLLAMA_MODELS_COMMAND]),
        inferenceNode(
          "allowed-node",
          discovery ? [command] : [OLLAMA_MODELS_COMMAND, command],
          discovery ? "Desk" : undefined,
        ),
      ],
      invoke,
    );
    const result = await createOllamaNodeInferenceTool(api).execute("call-authorized", {
      action,
      ...params,
    });
    expect(invoke).toHaveBeenCalledOnce();
    expect(invoke).toHaveBeenCalledWith({
      nodeId: "allowed-node",
      command,
      params: discovery ? params : { ...params, timeoutMs },
      timeoutMs,
      scopes: ["operator.write"],
    });
    if (discovery) {
      expect(result.details).toEqual({
        nodes: [{ nodeId: "allowed-node", displayName: "Desk", ok: true, ...payload }],
      });
    } else {
      expect(result.details).toMatchObject({ nodeId: "allowed-node", ...payload });
    }
  });
});

type AbortTestServer = {
  baseUrl: string;
  requests: string[];
  canceled: string[];
};

async function withAbortTestServer(
  stallPath: string,
  run: (server: AbortTestServer) => Promise<void>,
  options?: { stallCount?: number },
): Promise<void> {
  await withOllamaServer(
    (baseUrl, _chats, _shows, requests, canceled) => run({ baseUrl, requests, canceled }),
    {
      models: [{ name: "node-local:small", digest: "sha256:node-local-small", size: 512 }],
      loadedModels: false,
      showContextWindow: 8192,
      chatContent: "node-only inference",
      stallPath,
      ...options,
    },
  );
}

async function cancelRequest(
  server: AbortTestServer,
  path: string,
  controller: AbortController,
  inference: Promise<unknown>,
  reason: string,
) {
  await vi.waitFor(() => expect(server.requests).toContain(path));
  controller.abort(new Error(reason));
  await expect(inference).rejects.toThrow(reason);
  await vi.waitFor(() => expect(server.canceled).toContain(path));
}

describe("node-local Ollama inference cancellation", () => {
  it.each([
    { phase: "model discovery", path: "/api/tags" },
    { phase: "model capability verification", path: "/api/show" },
  ])("closes the node-local request when $phase is canceled", async ({ path }) => {
    await withAbortTestServer(path, async (server) => {
      const controller = new AbortController();
      const inference = commandByName(server.baseUrl, OLLAMA_CHAT_COMMAND).handle(
        JSON.stringify({ model: "node-local:small", prompt: "answer locally" }),
        undefined,
        { sendNodeEvent: async () => undefined, signal: controller.signal },
      );
      await cancelRequest(server, path, controller, inference, "node inference canceled");
    });
  });

  it("forwards an agent-tool cancellation through its paired node runtime", async () => {
    await withAbortTestServer("/api/chat", async (server) => {
      const controller = new AbortController();
      const invoke = vi.fn(
        async (params: { command: string; params?: unknown; signal?: AbortSignal }) => ({
          payloadJSON: await commandByName(server.baseUrl, OLLAMA_CHAT_COMMAND).handle(
            JSON.stringify(params.params),
            undefined,
            { sendNodeEvent: async () => undefined, signal: params.signal },
          ),
        }),
      );
      const api = nodeApi([inferenceNode("paired-node")], invoke);

      const inference = createOllamaNodeInferenceTool(api).execute(
        "paired-node-inference",
        {
          action: "run",
          model: "node-local:small",
          prompt: "answer only from the paired node",
        },
        controller.signal,
      );
      await cancelRequest(server, "/api/chat", controller, inference, "agent inference canceled");
      expect(invoke).toHaveBeenCalledWith(
        expect.objectContaining({
          nodeId: "paired-node",
          command: "ollama.chat",
          signal: controller.signal,
        }),
      );
    });
  });

  it("normalizes a pre-aborted agent-tool string reason before listing nodes", async () => {
    const list = vi.fn(async () => ({ nodes: [] }));
    const api = createTestPluginApi({ runtime: { nodes: { list, invoke: vi.fn() } } as never });

    const inference = createOllamaNodeInferenceTool(api).execute(
      "paired-node-inference",
      { action: "discover" },
      AbortSignal.abort("agent inference canceled"),
    );

    await expect(inference).rejects.toBeInstanceOf(Error);
    await expect(inference).rejects.toMatchObject({ message: "agent inference canceled" });
    expect(list).not.toHaveBeenCalled();
  });

  // Go through ollama.models without a timeout, because a timeout bypasses the
  // cache on its own. Keep the cache key stable and prove both cancellation
  // isolation and later successful reuse.
  it("does not poison shared model metadata after a canceled show request", async () => {
    await withAbortTestServer(
      "/api/show",
      async (server) => {
        const controller = new AbortController();
        const command = commandByName(server.baseUrl, OLLAMA_MODELS_COMMAND);
        const canceledDiscovery = command.handle(undefined, undefined, {
          sendNodeEvent: async () => undefined,
          signal: controller.signal,
        });
        await cancelRequest(
          server,
          "/api/show",
          controller,
          canceledDiscovery,
          "first discovery canceled",
        );

        const discovered: unknown = JSON.parse(await command.handle());
        expect(discovered).toMatchObject({
          provider: "ollama",
          models: [
            {
              name: "node-local:small",
              contextWindow: 8192,
              capabilities: ["completion", "tools"],
            },
          ],
        });
        expect(server.requests.filter((request) => request === "/api/show")).toHaveLength(2);
        expect(JSON.parse(await command.handle())).toEqual(discovered);
        expect(server.requests.filter((request) => request === "/api/show")).toHaveLength(2);
      },
      { stallCount: 1 },
    );
  });
});

const CHAT_MODEL = "deadline-model:latest";

async function withDelayedOllamaServer(
  delays: Partial<Record<"/api/tags" | "/api/show" | "/api/chat", number>>,
  run: (baseUrl: string, requestedPaths: string[]) => Promise<void>,
): Promise<void> {
  await withOllamaServer((baseUrl, _chats, _shows, requests) => run(baseUrl, requests), {
    models: [{ name: CHAT_MODEL }],
    loadedModels: false,
    chatContent: "within the requested deadline",
    delays,
  });
}

function runNodeChat(baseUrl: string, timeoutMs: number): Promise<string> {
  return chat(baseUrl, { model: CHAT_MODEL, prompt: "answer within the deadline", timeoutMs });
}

describe("Ollama node inference deadline", () => {
  it.each([
    ["/api/tags", ["/api/tags"]],
    ["/api/show", ["/api/tags", "/api/show"]],
    ["/api/chat", ["/api/tags", "/api/show", "/api/chat"]],
  ] as const)("bounds a stalled %s request by the inference deadline", async (slowPath, paths) => {
    await withDelayedOllamaServer({ [slowPath]: 900 }, async (baseUrl, requestedPaths) => {
      const startedAtMs = performance.now();

      await expect(runNodeChat(baseUrl, 250)).rejects.toThrow(/timed out|unavailable/);

      expect(performance.now() - startedAtMs).toBeLessThan(2_000);
      expect(requestedPaths).toEqual(paths);
    });
  });

  it("shares one deadline across successful catalog and model preflight", async () => {
    await withDelayedOllamaServer(
      { "/api/tags": 160, "/api/show": 160, "/api/chat": 160 },
      async (baseUrl, requestedPaths) => {
        const startedAtMs = performance.now();

        await expect(runNodeChat(baseUrl, 400)).rejects.toThrow(/timed out|unavailable/);

        expect(performance.now() - startedAtMs).toBeLessThan(2_000);
        expect(requestedPaths.slice(0, 2)).toEqual(["/api/tags", "/api/show"]);
      },
    );
  });
});
