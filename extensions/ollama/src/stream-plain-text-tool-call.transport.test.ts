// Real HTTP/SSRF/NDJSON proof for #122513 and the delta shape used by tool-call-repair.
import { createServer, type Server } from "node:http";
import { text } from "node:stream/consumers";
import type { Tool } from "openclaw/plugin-sdk/llm";
import { afterEach, describe, expect, it } from "vitest";
import { listenOnLoopback } from "../../test-support/hanging-loopback-server.js";
import { createModel } from "../model.test-support.js";
import { createOllamaStreamFn } from "./stream-api.js";

const FENCE = "```";

// Split at each opening bracket to exercise protected-range resolution mid-token.
function buildBracketDenseChunks(sections: number) {
  const chunks: string[] = ["Here is the configuration you asked for.\n\n", `${FENCE}toml\n`];
  for (let index = 0; index < sections; index += 1) {
    const id = String(index).padStart(2, "0");
    chunks.push("[", `read.section.${id}]\n`, `name = "section-${id}"\n`);
  }
  const fencedBody = '[read]\n{"path":"fenced.txt"}\n[/read]\n';
  chunks.push("[", fencedBody.slice(1));
  chunks.push(`${FENCE}\n`);
  const trailingCall = '[read]\n{"path":"real.txt"}\n[/read]\n';
  chunks.push("\n", "[", trailingCall.slice(1));
  return { chunks, text: chunks.join(""), fencedBody, trailingCall };
}

const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server[Symbol.asyncDispose]()));
});

type CapturedRequest = { tools?: Array<{ function?: { parameters?: unknown } }> };
async function streamRecords(records: readonly unknown[], tools: Tool[]) {
  const captured = Promise.withResolvers<CapturedRequest>();
  const server = createServer(async (req, res) => {
    if (!req.url?.endsWith("/api/chat")) {
      res.writeHead(404).end();
      return;
    }
    captured.resolve(JSON.parse(await text(req)));
    res.writeHead(200, { "content-type": "application/x-ndjson" });
    for (const record of records) {
      res.write(JSON.stringify(record) + "\n");
    }
    res.end();
  });
  servers.push(server);
  const port = await listenOnLoopback(server);
  const baseUrl = `http://127.0.0.1:${port}`;
  const stream = await createOllamaStreamFn(baseUrl)(
    {
      ...createModel("proof-model", "proof-model", { reasoning: true }),
      api: "ollama",
      provider: "ollama",
      baseUrl,
    },
    { messages: [{ role: "user", content: "config?", timestamp: 0 }], tools },
    {},
  );
  return { stream, request: captured.promise };
}

async function runThroughTransport(chunks: readonly string[], tools: Tool[]) {
  const record = (content: string, done = false) => ({
    message: { role: "assistant", content },
    done,
    ...(done ? { done_reason: "stop", prompt_eval_count: 1, eval_count: 1 } : {}),
  });
  const { stream } = await streamRecords(
    [...chunks.map((content) => record(content)), record("", true)],
    tools,
  );
  const events = await Array.fromAsync(stream);
  const deltas = events.filter((event) => event.type === "text_delta");
  const content = events.flatMap((event) => (event.type === "done" ? event.message.content : []));
  return {
    deltaText: deltas.map((event) => event.delta).join(""),
    doneText: content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join(""),
    errors: events.flatMap((event) => (event.type === "error" ? [event.error] : [])),
    partialCarryingDeltas: deltas.filter((event) => event.partial !== undefined).length,
    toolCallNames: content.flatMap((block) => (block.type === "toolCall" ? [block.name] : [])),
  };
}

const readTool = {
  name: "read",
  description: "Read a file",
  parameters: { type: "object", properties: { path: { type: "string" } } },
};

describe("plain-text tool-call compat wrapper over the real Ollama NDJSON transport", () => {
  it("keeps a bracket-dense fenced answer byte-identical while normalizing the unfenced call (#122513)", async () => {
    const payload = buildBracketDenseChunks(40);
    const run = await runThroughTransport(payload.chunks, [readTool]);

    expect(run.errors).toEqual([]);
    const fencedPortion = payload.text.slice(0, payload.text.indexOf(payload.trailingCall));
    expect(run.doneText.startsWith(fencedPortion)).toBe(true);
    expect(run.doneText).toContain(payload.fencedBody);
    // Outside the fence the same call must be normalized (scrubbed or promoted).
    expect(run.doneText).not.toContain('"path":"real.txt"');
    expect(run.deltaText).toBe(run.doneText);
  });

  it("passes the identical stream through untouched when no tools are configured (#122513)", async () => {
    const payload = buildBracketDenseChunks(40);
    const run = await runThroughTransport(payload.chunks, []);

    expect(run).toEqual({
      errors: [],
      doneText: payload.text,
      deltaText: payload.text,
      toolCallNames: [],
      partialCarryingDeltas: 0,
    });
  });
});

async function runToolCallScenario(tool: Tool, args: Record<string, unknown>) {
  const { stream, request } = await streamRecords(
    [
      {
        message: {
          role: "assistant",
          content: "",
          tool_calls: [{ id: "call_1", function: { name: tool.name, arguments: args } }],
        },
        done: true,
      },
    ],
    [tool],
  );
  return {
    request: await request,
    toolCall: (await stream.result()).content.find((block) => block.type === "toolCall"),
  };
}

const freeFormExecTool = {
  name: "exec",
  description: "Run a shell command",
  parameters: { type: "object", additionalProperties: true },
};

// Tool Search uses TypeBox's Type.Record(), which emits patternProperties for args.
const toolCallDispatcherTool = {
  name: "dispatch_action",
  description: "Call an exact Tool Search result id or name through OpenClaw.",
  parameters: {
    type: "object",
    required: ["id"],
    properties: {
      id: { type: "string", description: "Tool search result id or tool name." },
      args: { type: "object", patternProperties: { "^.*$": {} }, description: "Tool input." },
    },
  },
};

it.each([
  [freeFormExecTool, { command: "uname -r" }],
  [toolCallDispatcherTool, { id: "openclaw:core:exec", args: { command: "uname -r" } }],
] as const)(
  "preserves %s free-form schema and populated arguments over NDJSON (#157039)",
  async (tool, args) => {
    const schema = structuredClone(tool.parameters);
    const { request, toolCall } = await runToolCallScenario(tool, args);
    expect(request.tools?.[0]?.function?.parameters).toEqual(schema);
    expect(toolCall).toMatchObject({ name: tool.name, arguments: args });
  },
);
