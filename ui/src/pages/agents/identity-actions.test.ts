import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { createApplicationConfigCapability } from "../../app/config.ts";
import type { ApplicationContext } from "../../app/context.ts";
import { uploadsDisabledMessage } from "../../lib/uploads.ts";
import * as avatarImage from "./avatar-image.ts";
import {
  resetIdentityDraft,
  saveIdentityDraft,
  selectIdentityAvatar,
  setIdentityAvatar,
  setIdentityDraftField,
} from "./identity-actions.ts";

const fileToAvatarDataUrlMock = vi.fn<typeof avatarImage.fileToAvatarDataUrl>();

beforeEach(() => {
  vi.spyOn(avatarImage, "fileToAvatarDataUrl").mockImplementation(fileToAvatarDataUrlMock);
});

afterEach(() => {
  fileToAvatarDataUrlMock.mockReset();
  vi.restoreAllMocks();
});

function host(): Parameters<typeof resetIdentityDraft>[0] {
  return {
    identityDraft: { name: null, emoji: null, avatar: null },
    identitySaving: false,
    identityOutcome: null,
  };
}

function saveWith<Args extends unknown[], Result>(
  state: ReturnType<typeof host>,
  runExternalMutation: (...args: Args) => Result,
  overrides: Partial<Parameters<typeof saveIdentityDraft>[0]> = {},
) {
  return saveIdentityDraft({
    host: state,
    expectedClient: { request: vi.fn() } as unknown as GatewayBrowserClient,
    agentId: "main",
    agents: {} as ApplicationContext["agents"],
    agentIdentity: {} as ApplicationContext["agentIdentity"],
    canDispatch: () => true,
    isCurrent: () => true,
    onSaved: vi.fn(),
    runtimeConfig: { runExternalMutation } as unknown as ApplicationContext["runtimeConfig"],
    ...overrides,
  });
}

function refreshCapabilities() {
  return {
    agents: {
      refreshList: vi.fn(async () => undefined),
    } as unknown as ApplicationContext["agents"],
    agentIdentity: {
      invalidate: vi.fn(),
      ensure: vi.fn(async () => undefined),
    } as unknown as ApplicationContext["agentIdentity"],
  };
}

describe("agent identity actions", () => {
  it.each(["accept", "replace", "reset"] as const)(
    "settles an uploaded avatar after %s",
    async (mode) => {
      const state = host();
      const upload = createDeferred<avatarImage.AvatarDataUrlResult>();
      const onSelected = vi.fn();
      fileToAvatarDataUrlMock.mockReturnValueOnce(upload.promise);
      selectIdentityAvatar(
        state,
        new File(["image"], "avatar.png", { type: "image/png" }),
        undefined,
        onSelected,
      );
      expect(onSelected).not.toHaveBeenCalled();
      if (mode === "replace") {
        setIdentityAvatar(state, "data:image/webp;base64,YXZhdGFy");
      }
      if (mode === "reset") {
        resetIdentityDraft(state);
      }
      upload.resolve({ ok: true, dataUrl: "data:image/png;base64,aA==" });
      await upload.promise;
      await Promise.resolve();
      expect(state.identityDraft.avatar).toBe(
        mode === "accept"
          ? "data:image/png;base64,aA=="
          : mode === "replace"
            ? "data:image/webp;base64,YXZhdGFy"
            : null,
      );
      expect(onSelected).toHaveBeenCalledTimes(mode === "accept" ? 1 : 0);
    },
  );

  it("rejects disabled avatar reads and results finishing after policy changes", async () => {
    const base = createApplicationConfigCapability({ resourceBasePath: "" });
    const config = { ...base, current: { ...base.current, uploadsEnabled: false } };
    const state = host();
    selectIdentityAvatar(state, {} as File, config);
    expect(fileToAvatarDataUrlMock).not.toHaveBeenCalled();
    expect((await state.identityOutcome)?.error).toBe(uploadsDisabledMessage());

    config.current.uploadsEnabled = true;
    const avatar = createDeferred<avatarImage.AvatarDataUrlResult>();
    fileToAvatarDataUrlMock.mockReturnValueOnce(avatar.promise);
    selectIdentityAvatar(state, {} as File, config);
    config.current.uploadsEnabled = false;
    avatar.resolve({ ok: true, dataUrl: "data:image/png;base64,aA==" });
    await Promise.resolve();
    expect(state.identityDraft.avatar).toBeNull();
    expect((await state.identityOutcome)?.error).toBe(uploadsDisabledMessage());
  });

  it("does not dispatch an already selected avatar after uploads are disabled", async () => {
    const base = createApplicationConfigCapability({ resourceBasePath: "" });
    const config = { ...base, current: { ...base.current, uploadsEnabled: false } };
    const state = host();
    state.identityDraft.avatar = "data:image/png;base64,aA==";
    const runExternalMutation = vi.fn();
    await saveWith(state, runExternalMutation, { config });
    expect(runExternalMutation).not.toHaveBeenCalled();
    expect((await state.identityOutcome)?.error).toBe(uploadsDisabledMessage());
  });
  it("keeps unsupported blank edits visible without sending an update", async () => {
    const state = host();
    state.identityDraft.name = "  ";
    const runExternalMutation = vi.fn();
    await saveWith(state, runExternalMutation);

    expect(runExternalMutation).not.toHaveBeenCalled();
    expect(state.identityDraft.name).toBe("  ");
  });

  it.each([
    ["unusable", "That image can't be used. Pick an image file up to 2 MB."],
    ["too-detailed", "That image is too detailed to store as an avatar"],
  ] as const)("explains a %s avatar rejection", async (reason, message) => {
    fileToAvatarDataUrlMock.mockResolvedValueOnce({ ok: false, reason });
    const state = host();

    selectIdentityAvatar(state, {} as File);
    await Promise.resolve();
    await Promise.resolve();

    expect((await state.identityOutcome)?.error).toContain(message);
    expect(state.identityDraft.avatar).toBeNull();
  });

  it("does not dispatch an identity update through a replacement client", async () => {
    const expectedClient = { request: vi.fn() } as unknown as GatewayBrowserClient;
    const request = vi.fn();
    const client = { request } as unknown as GatewayBrowserClient;
    const state = host();
    state.identityDraft.name = "Agent Smith";
    const runtimeConfig = {
      runExternalMutation: vi.fn(async (task) => {
        try {
          return {
            ok: true as const,
            value: await task(client),
            refresh: { ok: true as const },
          };
        } catch (error) {
          return { ok: false as const, reason: "error" as const, error: String(error) };
        }
      }),
    } as unknown as ApplicationContext["runtimeConfig"];

    await saveWith(state, runtimeConfig.runExternalMutation, { expectedClient });

    expect(request).not.toHaveBeenCalled();
    expect((await state.identityOutcome)?.error).toContain(
      "Connection changed before the agent identity update started.",
    );
  });

  it("preserves edits made while an autosave is in flight", async () => {
    const state = host();
    state.identityDraft.name = "First name";
    const { promise: pending, resolve: release } = createDeferred();
    const runExternalMutation = vi.fn(async () => {
      await pending;
      return { ok: true as const, value: {}, refresh: { ok: true as const } };
    });
    const saving = saveWith(state, runExternalMutation, refreshCapabilities());
    setIdentityDraftField(state, "name", "Second name");
    release();
    await saving;

    expect(state.identityDraft.name).toBe("Second name");
    expect(state.identitySaving).toBe(false);
  });

  it("clears a committed identity draft while surfacing a config refresh warning", async () => {
    const state = host();
    state.identityDraft.name = "Agent Smith";
    const runExternalMutation = vi.fn(async () => ({
      ok: true as const,
      value: {},
      refresh: { ok: false as const, error: "config.get failed after identity commit" },
    }));

    await saveWith(state, runExternalMutation, refreshCapabilities());

    expect(runExternalMutation).toHaveBeenCalledOnce();
    expect(state.identityDraft).toEqual({ name: null, emoji: null, avatar: null });
    expect((await state.identityOutcome)?.error).toContain(
      "config.get failed after identity commit",
    );
  });
});
