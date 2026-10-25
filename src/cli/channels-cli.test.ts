import { Command } from "commander";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChannelPluginCatalogEntry } from "../channels/plugins/catalog.js";
import { channelOmitsEnvBackedSetupOption } from "../channels/plugins/cli-add-options.js";
import type { PluginPackageChannel } from "../plugins/manifest.js";
import { mockProcessPlatform } from "../test-utils/vitest-spies.js";
import { registerChannelsCli } from "./channels-cli.js";

const mocks = vi.hoisted(() => ({
  bundled: vi.fn<() => readonly PluginPackageChannel[]>(() => []),
  catalog: vi.fn<() => ChannelPluginCatalogEntry[]>(() => []),
  add: vi.fn<typeof import("../commands/channels/add.js").channelsAddCommand>(
    async () => undefined,
  ),
  logs: vi.fn(async (_options: { channel?: string }) => undefined),
  deadLetters: {
    channelsDeadLettersListCommand: vi.fn(async (_options: { account?: string }) => undefined),
    channelsDeadLettersResubmitCommand: vi.fn(
      async (_eventId: string, _options: { account?: string }) => undefined,
    ),
  },
  resolve: vi.fn(async () => undefined),
  capabilities: vi.fn(async () => undefined),
  remove: vi.fn(async () => undefined),
  auth: {
    runChannelLogin: vi.fn(async () => undefined),
    runChannelLogout: vi.fn(async () => undefined),
  },
  runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() },
}));

vi.mock("../plugins/channel-catalog-registry.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../plugins/channel-catalog-registry.js")>()),
  listChannelCatalogEntries: () => mocks.bundled().map((channel) => ({ channel })),
}));

vi.mock("../channels/plugins/catalog.js", () => ({
  listRawChannelPluginCatalogEntries: mocks.catalog,
}));

// mock-isolation: Inspect CLI options without running commands or changing operator state.
vi.mock("../commands/channels/add.js", () => ({ channelsAddCommand: mocks.add }));
vi.mock("../commands/channels/logs.js", () => ({ channelsLogsCommand: mocks.logs }));
vi.mock("../commands/channels/resolve.js", () => ({ channelsResolveCommand: mocks.resolve }));
vi.mock("../commands/channels/capabilities.js", () => ({
  channelsCapabilitiesCommand: mocks.capabilities,
}));
vi.mock("../commands/channels/remove.js", () => ({ channelsRemoveCommand: mocks.remove }));
vi.mock("../commands/channels/dead-letters.js", () => mocks.deadLetters);
vi.mock("./channel-auth.js", () => mocks.auth);
vi.mock("../runtime.js", () => ({ defaultRuntime: mocks.runtime }));

function setupChannel(
  id: string,
  ...fields: NonNullable<PluginPackageChannel["setup"]>["fields"]
): PluginPackageChannel {
  return { id, setup: { fields } };
}

type SetupField = NonNullable<PluginPackageChannel["setup"]>["fields"][number];
function setupField(
  key: string,
  kind: "string" | "boolean",
  flags: string,
  extra: Partial<SetupField["cli"]> = {},
): SetupField {
  return { key, kind, cli: { flags, description: key, ...extra } };
}

const signalTransport = {
  key: "signalTransport",
  kind: "choice",
  choices: ["external-native", "container"],
  cli: { flags: "--signal-transport <kind>", description: "Signal transport kind" },
} satisfies NonNullable<PluginPackageChannel["setup"]>["fields"][number];
const matrixChannel = {
  id: "matrix",
  cliAddOptions: [{ flags: "--homeserver <url>", description: "Matrix homeserver URL" }],
};
const telegramChannel = setupChannel("telegram", setupField("token", "string", "--token <token>"));
const legacyArgs = ["channels", "add", "--channel", "legacy-chat", "--token", "test-token"];
function legacyChannel(
  flags: string,
  description: string,
  valueType?: "int",
): PluginPackageChannel {
  return {
    id: "legacy-chat",
    cliAddOptions: [{ flags, description, defaultValue: "", ...(valueType ? { valueType } : {}) }],
  };
}
function expectAddCall(options: unknown) {
  expect(mocks.add).toHaveBeenCalledWith(options, mocks.runtime, { hasFlags: true });
}

function getChannelAddOptionFlags(program: Command): string[] {
  const channels = program.commands.find((command) => command.name() === "channels");
  const add = channels?.commands.find((command) => command.name() === "add");
  return add?.options.map((option) => option.flags) ?? [];
}

async function runChannelsCli(
  args: string[],
  program = new Command().name("openclaw").enablePositionalOptions().exitOverride(),
) {
  await registerChannelsCli(program, ["node", "openclaw", ...args]);
  await program.parseAsync(args, { from: "user" });
  return program;
}

describe("registerChannelsCli", () => {
  const originalArgv = [...process.argv];

  afterEach(() => {
    process.argv = [...originalArgv];
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  it("loads channel-specific add options only for channels add invocations", async () => {
    process.argv = ["node", "openclaw", "channels"];
    await registerChannelsCli(new Command().name("openclaw"));

    expect(mocks.bundled).not.toHaveBeenCalled();
    expect(mocks.catalog).not.toHaveBeenCalled();

    process.argv = ["node", "openclaw", "channels", "add", "clickclack", "--help"];
    await registerChannelsCli(new Command().name("openclaw"));

    expect(mocks.bundled).toHaveBeenCalledTimes(1);
    expect(mocks.catalog).toHaveBeenCalledTimes(1);
  });

  it.each([
    [["--account", "ops", "list"], "ops"],
    [["--account", "parent", "list", "--account", "leaf"], "leaf"],
    [["--account", "", "resubmit", "event-1"], ""],
    [["list", "--account", ""], ""],
  ] as const)("passes dead-letter account options %j", async (args, expected) => {
    await runChannelsCli(["channels", "dead-letters", ...args, "--channel", "telegram"]);
    const options = args.some((arg) => arg === "resubmit")
      ? mocks.deadLetters.channelsDeadLettersResubmitCommand.mock.calls[0]?.[1]
      : mocks.deadLetters.channelsDeadLettersListCommand.mock.calls[0]?.[0];
    expect(options?.account).toBe(expected);
  });

  it("distinguishes an explicit all channels logs filter", async () => {
    await runChannelsCli(["channels", "logs", "--channel", "all"]);
    expect(mocks.logs.mock.calls[0]?.[0]?.channel).toBe("all");
  });

  it.each([
    ["capabilities", "--agent ops capabilities"],
    ["remove", "--agent ops remove"],
    ["resolve", "--agent ops resolve room"],
    ["add", "add --agent ops"],
  ] as const)("forwards --agent to channels %s", async (leaf, args) => {
    await runChannelsCli(["channels", ...args.split(" "), "--channel", "telegram"]);
    expect(mocks[leaf]).toHaveBeenCalledWith(
      expect.objectContaining({ agent: "ops" }),
      mocks.runtime,
      ...(leaf === "add" ? [{ hasFlags: false }] : leaf === "remove" ? [{ hasFlags: true }] : []),
    );
  });

  it("switches the env-backed add hint only for a selected channel without --use-env", async () => {
    mocks.bundled.mockReturnValue([
      setupChannel("telegram", setupField("useEnv", "boolean", "--use-env")),
      setupChannel("signal", setupField("httpUrl", "string", "--http-url <url>")),
      { id: "irc", cliAddOptions: [{ flags: "--token <token>", description: "IRC token" }] },
    ]);
    const registeredFlags = async (channelId: string) => {
      const program = new Command().name("openclaw");
      await registerChannelsCli(program, [
        ..."node openclaw channels add --channel".split(" "),
        channelId,
        "--help",
      ]);
      return getChannelAddOptionFlags(program);
    };

    expect(await registeredFlags("telegram")).toContain("--use-env");
    expect(await registeredFlags("signal")).not.toContain("--use-env");
    expect(await registeredFlags("irc")).toContain("--use-env");
    // Unknown or unselected channels retain the generic hint.
    expect(
      ["signal", "telegram", "irc", "unlisted", " \t "].map(channelOmitsEnvBackedSetupOption),
    ).toEqual([true, false, false, false, false]);

    mocks.bundled.mockReturnValue([]);
  });

  it("keeps generic add help limited to the shared control envelope", async () => {
    const program = new Command().name("openclaw");

    await registerChannelsCli(program, ["node", "openclaw", "channels", "add", "-h"]);

    expect(getChannelAddOptionFlags(program)).toEqual([
      "--channel <name>",
      "--agent <id>",
      "--account <id>",
      "--name <name>",
    ]);
    expect(mocks.bundled).not.toHaveBeenCalled();
  });

  it("forwards only explicitly supplied setup options", async () => {
    mocks.bundled.mockReturnValueOnce([
      setupChannel(
        "signal",
        signalTransport,
        setupField("useEnv", "boolean", "--use-env", { defaultValue: false }),
        setupField("autoDiscover", "boolean", "--auto-discover", {
          negatedFlags: "--no-auto-discover",
        }),
      ),
    ]);

    await runChannelsCli(
      "channels add --channel signal --signal-transport container --no-auto-discover".split(" "),
    );

    expectAddCall({
      channel: "signal",
      signalTransport: "container",
      autoDiscover: false,
      agent: undefined,
    });
  });

  it.each([
    ["integer default", "--limit <n>", "int", [], {}],
    ["explicit integer blank", "--limit <n>", "int", ["--limit", ""], { limit: "" }],
    ["text default", "--note <text>", undefined, [], { note: "" }],
  ] as const)("preserves legacy %s", async (label, flags, valueType, args, expected) => {
    mocks.bundled.mockReturnValueOnce([legacyChannel(flags, "Legacy option", valueType)]);
    await runChannelsCli([...legacyArgs, ...args]);
    expectAddCall(
      expect.objectContaining({ channel: "legacy-chat", token: "test-token", ...expected }),
    );
    if (label === "integer default") {
      expect(mocks.add.mock.calls[0]?.[0]).not.toHaveProperty("limit");
    }
  });

  it.each(["completion", "Windows launcher"] as const)(
    "loads channel-specific options for %s",
    async (mode) => {
      mocks.bundled.mockReturnValueOnce([matrixChannel]);
      if (mode === "completion") {
        process.argv = ["node", "openclaw", "completion", "--write-state"];
      } else {
        mockProcessPlatform("win32");
        process.argv = [
          "C:\\Program Files\\nodejs\\node.exe",
          "C:\\Program Files\\nodejs\\node.exe",
          "C:\\repo\\openclaw.js",
          "channels",
          "add",
          "--channel",
          "matrix",
          "--homeserver",
          "https://matrix.example.org",
        ];
      }
      const program = new Command().name("openclaw");
      await registerChannelsCli(program, process.argv, {
        includeSetupOptions: mode === "completion",
      });
      expect(mocks.bundled).toHaveBeenCalledTimes(1);
      expect(getChannelAddOptionFlags(program)).toContain("--homeserver <url>");
    },
  );

  it.each([
    ["--token tok telegram", {}, 2],
    ["--account work telegram --token tok", { account: "work" }, 1],
  ] as const)("finds a positional channel in %s", async (args, expected, reads) => {
    for (let read = 0; read < reads; read++) {
      mocks.bundled.mockReturnValueOnce([telegramChannel]);
    }
    await runChannelsCli(["channels", "add", ...args.split(" ")]);
    expectAddCall(expect.objectContaining({ channel: "telegram", token: "tok", ...expected }));
  });

  it("keeps conflicting all-channel flag arities before a positional channel ambiguous", async () => {
    mocks.bundled.mockReturnValueOnce([
      setupChannel("chat-a", setupField("mode", "string", "--mode <mode>")),
      setupChannel("telegram", setupField("mode", "boolean", "--mode")),
    ]);

    const args = ["channels", "add", "--mode", "telegram"];
    const program = new Command().name("openclaw").exitOverride();
    program.configureOutput({ writeErr: () => {} });
    await registerChannelsCli(program, ["node", "openclaw", ...args]);

    await expect(program.parseAsync(args, { from: "user" })).rejects.toMatchObject({
      code: "commander.unknownOption",
      message: expect.stringContaining("unknown option '--mode'"),
    });
    expect(mocks.add).not.toHaveBeenCalled();
  });
});
