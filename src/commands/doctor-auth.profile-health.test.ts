import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { createOAuthRefreshCredential } from "../agents/auth-profiles/credential-fixtures.test-support.js";
import type { AuthProfileStore } from "../agents/auth-profiles/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import type { DoctorPrompter } from "./doctor-prompter.js";

const authProfileMocks = vi.hoisted(() => ({
  loadAuthProfileStoreForRuntime: vi.fn<
    typeof import("../agents/auth-profiles.js").loadAuthProfileStoreForRuntime
  >(() => {
    throw new Error("unexpected auth profile load");
  }),
  hasAnyAuthProfileStoreSource: vi.fn((_agentDir?: string) => false),
  hasLocalAuthProfileStoreSource: vi.fn((_agentDir?: string) => false),
  resolveApiKeyForProfile: vi.fn(),
}));

vi.mock("../agents/auth-profiles.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../agents/auth-profiles.js")>()),
  ...authProfileMocks,
}));

vi.mock("../agents/auth-profiles/doctor.js", () => ({
  formatAuthDoctorHint: vi.fn(async () => "Re-authenticate this profile."),
}));

import { collectAuthProfileHealthFindings, inspectAuthProfileHealth } from "./doctor-auth.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

describe("inspectAuthProfileHealth", () => {
  const now = 1_700_000_000_000;
  let tempDir: string;
  let mainDir: string;

  function configForAgents(...ids: string[]): OpenClawConfig {
    const entries = Object.fromEntries(
      ids.map((id) => [id, { agentDir: path.join(tempDir, `${id}-agent`) }]),
    );
    return { agents: { entries } };
  }

  beforeEach(() => {
    tempDir = tempDirs.make("openclaw-doctor-auth-");
    mainDir = path.join(tempDir, "main-agent");
    vi.spyOn(Date, "now").mockReturnValue(now);
    vi.stubEnv("OPENCLAW_STATE_DIR", tempDir);
    Object.values(authProfileMocks).forEach((mock) => mock.mockReset());
    authProfileMocks.hasAnyAuthProfileStoreSource.mockReturnValue(false);
    authProfileMocks.hasLocalAuthProfileStoreSource.mockReturnValue(false);
  });

  afterEach(() => {
    closeOpenClawStateDatabaseForTest();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  function useLocalStore(store: AuthProfileStore, onlyDir?: string): void {
    authProfileMocks.hasLocalAuthProfileStoreSource.mockImplementation(
      (agentDir) => agentDir !== undefined,
    );
    authProfileMocks.loadAuthProfileStoreForRuntime.mockImplementation((agentDir) =>
      onlyDir && agentDir !== onlyDir ? { version: 1, profiles: {} } : store,
    );
  }

  function inspect(cfg = configForAgents("main"), confirmAutoFix = vi.fn(async () => false)) {
    return inspectAuthProfileHealth({
      cfg,
      prompter: { confirmAutoFix } as unknown as DoctorPrompter,
      allowKeychainPrompt: false,
    });
  }

  function collect() {
    return collectAuthProfileHealthFindings({ cfg: configForAgents("main") });
  }

  const oauth = (provider: string, expires: number) =>
    createOAuthRefreshCredential({ provider, expires, access: "access", refresh: "refresh" });
  function expiredStore(...profileIds: string[]) {
    const profiles = Object.fromEntries(
      profileIds.map((id) => [id, oauth("openai-codex", now - 60_000)]),
    );
    return { version: 1, profiles } satisfies AuthProfileStore;
  }

  it("keeps expiring warnings for static and custom Claude CLI profiles", async () => {
    useLocalStore({
      version: 1,
      profiles: {
        "anthropic:static-cli": {
          type: "token",
          provider: "claude-cli",
          token: "token",
          expires: now + 3 * 60 * 60_000,
        },
        "anthropic:custom-cli": oauth("claude-cli", now + 3 * 60 * 60_000),
      },
    });

    const findings = await collect();

    expect(findings.map((finding) => finding.target)).toEqual([
      "anthropic:custom-cli",
      "anthropic:static-cli",
    ]);
  });

  it("maps disabled auth profiles to structured findings", async () => {
    useLocalStore({
      version: 1,
      profiles: {},
      usageStats: {
        "openai:billing": {
          disabledUntil: now + 5 * 60_000,
          disabledReason: "billing",
        },
      },
    } satisfies AuthProfileStore);

    const findings = await collect();

    expect(findings).toMatchObject([
      {
        checkId: "core/doctor/auth-profiles",
        message: "Auth profile openai:billing is disabled:billing (5m).",
        path: path.join(mainDir, "openclaw-agent.sqlite"),
        target: "openai:billing",
        fixHint: "Top up credits (provider billing) or switch provider.",
      },
    ]);
  });

  it("shows exact WHAM classification while retaining canonical recovery policy", async () => {
    useLocalStore({
      version: 1,
      profiles: {
        "openai:expired": oauth("openai", now + 365 * 24 * 60 * 60_000),
      },
      usageStats: {
        "openai:expired": {
          cooldownUntil: now + 5 * 60_000,
          cooldownReason: "auth",
          cooldownClassification: "wham_token_expired",
        },
      },
    } satisfies AuthProfileStore);

    const findings = await collect();

    expect(findings).toMatchObject([
      {
        message: "Auth profile openai:expired is cooldown:wham_token_expired (5m).",
        fixHint: expect.stringContaining("Re-authenticate with"),
      },
    ]);
  });
  it("skips external auth profile resolution when no auth source exists", async () => {
    const findings = await inspectAuthProfileHealth({
      cfg: {
        agents: { entries: { main: {} } },
        channels: { telegram: { enabled: true } },
      } as OpenClawConfig,
      prompter: {} as DoctorPrompter,
      allowKeychainPrompt: false,
    });

    expect(findings).toEqual([]);
    expect(authProfileMocks.loadAuthProfileStoreForRuntime).not.toHaveBeenCalled();
  });

  it("aggregates model auth diagnostics and labels strict agent subsets", async () => {
    const coderDir = path.join(tempDir, "coder-agent");
    useLocalStore({ version: 1, profiles: {} });
    authProfileMocks.loadAuthProfileStoreForRuntime.mockImplementation((agentDir) => {
      if (agentDir === mainDir || agentDir === coderDir) {
        const id = agentDir === mainDir ? "main" : "coder";
        return expiredStore("openai-codex:shared", `openai-codex:${id}`);
      }
      throw new Error(`unexpected agent dir: ${agentDir ?? "<default>"}`);
    });

    const findings = await inspect(configForAgents("main", "coder"));

    expect(findings).toMatchObject([
      {
        target: "openai-codex:coder",
        message: "Auth profile openai-codex:coder is expired (0m). (stores: Agent coder)",
        path: path.join(coderDir, "openclaw-agent.sqlite"),
      },
      {
        target: "openai-codex:main",
        message: "Auth profile openai-codex:main is expired (0m). (stores: Agent main)",
        path: path.join(mainDir, "openclaw-agent.sqlite"),
      },
      {
        target: "openai-codex:shared",
        message: "Auth profile openai-codex:shared is expired (0m).",
        fixHint: "Re-authenticate this profile.",
      },
    ]);
    expect(findings[2]?.path).toBeUndefined();
  });

  it("offers credential repair while the same profile is cooling down", async () => {
    useLocalStore({
      ...expiredStore("openai-codex:expired"),
      usageStats: { "openai-codex:expired": { cooldownUntil: now + 5 * 60_000 } },
    });
    const confirmAutoFix = vi.fn(async () => false);

    const findings = await inspect(configForAgents("main"), confirmAutoFix);

    expect(confirmAutoFix).toHaveBeenCalledOnce();
    for (const message of ["cooldown (5m)", "expired"]) {
      expect(findings).toContainEqual(
        expect.objectContaining({
          category: "fix-now",
          message: expect.stringContaining(message),
        }),
      );
    }
  });

  it("prints malformed API-key profile diagnostics", async () => {
    useLocalStore(
      {
        version: 1,
        profiles: {
          "zai:default": {
            type: "api_key",
            provider: "zai",
            key: "openclaw onboard --auth-choice zai-coding-global",
          },
        },
      },
      mainDir,
    );

    const findings = await inspect();

    expect(findings).toMatchObject([
      {
        target: "zai:default",
        category: "fix-now",
        requirement: "malformed_api_key",
        fixHint: "Paste the API key value, not an OpenClaw onboarding command.",
      },
    ]);
  });

  it.each([
    [
      "openai-codex:default",
      "OAuth token refresh failed for openai-codex: refresh_token_reused. Please try again or re-authenticate.",
      "- openai-codex:default: re-auth required [refresh_token_reused] — Run `openclaw models auth login --provider openai`.",
    ],
    [
      "openai-codex:default",
      "OAuth token refresh failed for openai-codex: temporary upstream issue. Please try again or re-authenticate.",
      "- openai-codex:default: OAuth refresh failed — Try again; if this persists, run `openclaw models auth login --provider openai`.",
    ],
    [
      "OpenAI Work Profile",
      "OAuth token refresh failed for openai: invalid_grant. Please try again or re-authenticate.",
      "- OpenAI Work Profile: re-auth required [invalid_grant] — Run `openclaw models auth login --provider openai --profile-id 'OpenAI Work Profile'`.",
    ],
    [
      "openai-codex:default",
      "OAuth token refresh failed for openai-codex`\nrm -rf /: invalid_grant. Please try again or re-authenticate.",
      "- openai-codex:default: re-auth required [invalid_grant] — Run `openclaw models auth login --provider openai`.",
    ],
  ])(
    "formats OAuth refresh failures through the doctor command path",
    async (profileId, message, expected) => {
      useLocalStore(expiredStore(profileId));
      authProfileMocks.resolveApiKeyForProfile.mockRejectedValue(new Error(message));

      const findings = await inspect(
        configForAgents("main"),
        vi.fn(async () => true),
      );

      expect(findings).toContainEqual(
        expect.objectContaining({
          category: "fix-now",
          message: expect.stringContaining(expected),
        }),
      );
    },
  );
});
