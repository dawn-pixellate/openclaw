import "./server-startup-module-mocks.test-support.js";
import assert from "node:assert/strict";
import { afterEach, expect, it, vi } from "vitest";
import { createOAuthManager } from "../agents/auth-profiles/oauth-manager.js";
import { mockOAuthProviderOperations } from "../agents/auth-profiles/oauth-native-provider.test-support.js";
import { loadPersistedAuthProfileStore } from "../agents/auth-profiles/persisted.js";
import { saveAuthProfileStore } from "../agents/auth-profiles/store-runtime.js";
import type { OAuthCredential } from "../agents/auth-profiles/types.js";
import { upsertSessionEntryCore } from "../config/sessions/session-accessor.sqlite-entry.js";
import { resolvePhysicalSessionStorePath } from "../config/sessions/session-store-path.js";
import { sqliteWorkerOwnerProbe as probe } from "../infra/sqlite-worker-owner-probe.test-support.js";
import { createGatewayUpdateLifecycle } from "../infra/update-check-lifecycle.js";
import * as bundledStamp from "../model-catalog/bundled-catalog-stamp.js";
import { refreshRemoteModelCatalog } from "../model-catalog/remote-refresh.js";
import { readRemoteModelCatalog } from "../model-catalog/remote-store.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import {
  handleSessionStateSessionDeleted,
  handleSessionStateSessionReset,
} from "../sessions/session-state-events.js";
import { upsertSessionUpstreamLink } from "../sessions/session-upstream-links.js";
import { readSessionUpstreamLinkInDatabase } from "../sessions/session-upstream-links.kernel.js";
import { openOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import * as stateWorker from "../state/openclaw-state-worker-store.js";
import { connectUserModelAccount, readUserModelAuthProfile } from "../state/user-model-accounts.js";
import "../test-utils/prepare-compiled-subprocesses.js";
import { ensureProfileForEmail } from "../state/user-profiles.js";
import { createGatewayCloseRace } from "./server-close.race.test-support.js";
import { runGatewayStartupObservers } from "./server-startup-observers.js";
import {
  withLocalWorkspaceStore,
  type LocalWorkspaceStore,
} from "./worker-environments/local-workspace-store.js";
import {
  localWorkspaceProjectionFixture,
  readLocalWorkspaceProjection,
} from "./worker-environments/local-workspace-store.test-support.js";

const { installGatewaySubagentModuleLoad } =
  await import("./server-startup-module-mocks.test-support.js");

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) {
    await cleanup();
  }
  vi.unstubAllGlobals();
});
async function prepareClosingGateway(signal: AbortSignal) {
  const race = await createGatewayCloseRace("gateway-catalog-write-close", signal);
  const { fixture, kernel } = race;
  const pending: Promise<unknown>[] = [];
  const startupModuleRestorers: Array<() => void> = [];
  cleanups.push(async () => {
    try {
      await race.dispose();
    } finally {
      for (const restore of startupModuleRestorers.toReversed()) {
        restore();
      }
    }
  });
  race.onCleanup(async () => {
    await Promise.allSettled(pending);
    vi.restoreAllMocks();
  });
  const options = { env: fixture.state.env };
  const [port] = fixture.kernels.keys();
  assert(port !== undefined);
  const shared = openOpenClawStateDatabase(options).db;
  const track = <T>(task: Promise<T>) => {
    pending.push(task);
    return task;
  };
  return {
    ...race,
    port,
    options,
    shared,
    startupModuleRestorers,
    track,
    trackConnection<T>(run: () => Promise<T>) {
      return track(kernel.connectionWork.track(run));
    },
    sql: (query: string) => openOpenClawStateDatabase(options).db.prepare(query),
    holdCommand(type: string) {
      probe.command(stateWorker, async (command, executeOptions, scope) => {
        if (command.type === type) {
          await race.block();
        }
        return scope.execute(command, executeOptions);
      });
    },
    admitted: race.waitForEntry,
    async beginClose(abortSignal = kernel.connectionWork.signal) {
      await race.close(abortSignal, undefined, { reason: "gateway-catalog-write-close" });
    },
  };
}

it("persists accepted catalog writes before closing the state writer", async ({ signal }) => {
  const context = await prepareClosingGateway(signal);
  const { fixture, kernel, shared } = context;
  const lifecycle = createGatewayUpdateLifecycle(kernel.scheduler);
  kernel.runtimeState.stopGatewayUpdateCheck = lifecycle.stop;
  const bundle = {
    schemaVersion: 2,
    sourceCommit: "synthetic",
    generatedAt: 1_753_500_000_000,
    providers: { anthropic: {} },
    models: [{ id: "catalog-close", provider: "anthropic", pricing: { status: "unknown" } }],
  };
  context.holdCommand("modelCatalog.remote.write");
  vi.spyOn(bundledStamp, "bundledCatalogGeneratedAt").mockReturnValue(bundle.generatedAt - 1);
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(JSON.stringify(bundle))),
  );
  const refreshing = context.track(
    lifecycle.run((catalogSignal) =>
      refreshRemoteModelCatalog({
        config: {},
        force: true,
        signal: catalogSignal,
        databaseOptions: { env: fixture.state.env },
      }),
    ),
  );
  await context.admitted(refreshing, "Catalog refresh settled before worker write");
  await context.beginClose(kernel.scheduler.signal);
  expect(lifecycle.signal.aborted).toBe(true);
  const lateWork = vi.fn(async () => undefined);
  await expect(lifecycle.run(lateWork)).rejects.toThrow();
  expect(lateWork).not.toHaveBeenCalled();
  expect(shared.isOpen).toBe(true);
  await expect(context.finish(refreshing)).resolves.toMatchObject({
    status: "updated",
    generatedAt: bundle.generatedAt,
  });
  expect(shared.isOpen).toBe(false);
  expect(
    JSON.parse(readRemoteModelCatalog({ env: fixture.state.env })?.bundle_json ?? "null"),
  ).toEqual(bundle);
});

it("joins notice cleanup and upstream deletion after close prelude", async ({ signal }) => {
  const context = await prepareClosingGateway(signal);
  const { fixture, port, kernel, options, shared, sql } = context;
  const watcher = "agent:main:subagent:startup-notice-watcher";
  const target = "agent:main:subagent:startup-notice-target";
  await upsertSessionEntryCore(
    { sessionKey: watcher, env: fixture.state.env },
    { sessionId: "startup-notice-watcher", updatedAt: Date.now() },
  );
  sql(
    `INSERT INTO session_watch_cursors
         (watcher_session_key, target_session_key, watcher_store_path, last_seen_sequence,
          notified_sequence, material_sequence, updated_at)
         VALUES (?, ?, ?, 1, 2, 3, ?)`,
  ).run(
    watcher,
    target,
    resolvePhysicalSessionStorePath({ sessionKey: watcher, env: fixture.state.env }),
    Date.now(),
  );
  context.holdCommand("sessionState.sweep");
  const logs = { info() {}, warn() {}, error() {} };
  await installGatewaySubagentModuleLoad(
    async () => {},
    () => {
      const settled = Promise.resolve();
      return { initial: settled, pending: new Map(), settled };
    },
    context.startupModuleRestorers,
  );
  const sentinel = vi
    .spyOn(await import("./server-update-sentinel.js"), "prepareLatestUpdateRestartSentinel")
    .mockResolvedValue(null);
  context.startupModuleRestorers.push(() => sentinel.mockRestore());
  // Startup tracks the original promise without lending its connection scope to storage.
  const operation = Promise.resolve().then(() =>
    runGatewayStartupObservers({
      registry: createEmptyPluginRegistry(),
      resolveGatewayContext: () => undefined,
      loadSubagentRegistryActivation: async () =>
        (await import("../agents/subagents/registry/subagent-registry.js"))
          .activateSubagentRegistry,
      createHookRunner: async (...args) =>
        (await import("../plugins/hooks.js")).createHookRunner(...args),
      refreshLatestUpdateRestartSentinel: async () =>
        (await import("./server-update-sentinel.js")).prepareLatestUpdateRestartSentinel(
          fixture.state.env,
        ),
      signal: kernel.connectionWork.signal,
      port,
      config: fixture.config,
      workspaceDir: fixture.state.workspaceDir,
      getCron: () => undefined,
      isClosing: () => kernel.lifecycle.closePreludeStarted,
      log: logs,
      logHooks: logs,
    }),
  );
  const sweeping = context.trackConnection(() => operation);
  await context.admitted(sweeping, "Startup observers settled before notice write");
  const resetWatcher = `${watcher}-reset`;
  const deletedTarget = `${target}-deleted`;
  expect(
    upsertSessionUpstreamLink(
      {
        sessionKey: deletedTarget,
        agentId: "main",
        catalogId: "codex",
        hostId: "gateway:local",
        threadId: "close",
        upstreamKind: "codex-app-server",
        upstreamRef: null,
        marker: null,
      },
      options,
    ),
  ).toBe(true);
  sql(
    "INSERT INTO session_watch_cursors (watcher_session_key, target_session_key, updated_at) VALUES (?, ?, ?)",
  ).run(resetWatcher, target, Date.now());
  sql(
    "INSERT INTO session_state_events (session_key, agent_id, kind, actor_type, occurred_at, summary) VALUES (?, 'main', 'adopted', 'human', ?, 'accepted deletion')",
  ).run(deletedTarget, Date.now());
  let cleanupSettled = false;
  const cleaning = context.trackConnection(async () => {
    await handleSessionStateSessionReset(resetWatcher, options);
    await handleSessionStateSessionDeleted(deletedTarget, "main", options);
    cleanupSettled = true;
  });
  await context.beginClose();
  expect(kernel.scheduler.signal.aborted).toBe(true);
  expect(shared.isOpen).toBe(true);
  expect(cleanupSettled).toBe(false);
  await context.finish(Promise.all([sweeping, cleaning]));
  expect(shared.isOpen).toBe(false);
  expect(
    sql(
      "SELECT notified_sequence FROM session_watch_cursors WHERE watcher_session_key = ? AND target_session_key = ?",
    ).get(watcher, target),
  ).toEqual({ notified_sequence: 3 });
  const reopened = openOpenClawStateDatabase(options).db;
  expect([
    readSessionUpstreamLinkInDatabase(reopened, deletedTarget, "main"),
    sql("SELECT 1 FROM session_watch_cursors WHERE watcher_session_key = ?").get(resetWatcher),
    sql("SELECT 1 FROM session_state_events WHERE session_key = ?").get(deletedTarget),
  ]).toEqual([undefined, undefined, undefined]);
});

it("joins workspace writes and releases leases after close prelude", async ({ signal }) => {
  let custody: LocalWorkspaceStore | undefined;
  const worktreeId = "local-workspace-close";
  const expectedProjection = { worktree_id: worktreeId, revision: 0 };
  const context = await prepareClosingGateway(signal);
  const { fixture, kernel, options, shared, sql } = context;
  context.holdCommand("localWorkspace.mutate");
  const writing = context.trackConnection(() =>
    withLocalWorkspaceStore({ worktreeId, ...options }, async (store) => {
      custody = store;
      return store.create(localWorkspaceProjectionFixture(worktreeId, fixture.state.workspaceDir));
    }),
  );
  await context.admitted(writing, "Workspace write settled before admission");
  await context.beginClose();
  expect(kernel.scheduler.signal.aborted).toBe(true);
  const lateWork = vi.fn(async () => undefined);
  await expect(
    withLocalWorkspaceStore({ worktreeId: "late-workspace", ...options }, lateWork),
  ).rejects.toThrow("run-end admission is closed");
  expect(lateWork).not.toHaveBeenCalled();
  expect(shared.isOpen).toBe(true);
  await expect(context.finish(writing)).resolves.toMatchObject(expectedProjection);
  expect(shared.isOpen).toBe(false);
  assert(custody);
  expect(custody.assertCurrent).toThrow();
  expect(await readLocalWorkspaceProjection(worktreeId, fixture.state.env)).toMatchObject(
    expectedProjection,
  );
  expect(
    sql("SELECT count(*) AS count FROM state_leases WHERE scope = ? AND lease_key = ?").get(
      "workspace.local-reconciliation",
      worktreeId,
    ),
  ).toEqual({ count: 0 });
});

it.for(["personal", "shared-peer"] as const)(
  "joins %s OAuth settlement after the close prelude cancels its observer",
  async (kind, { signal }) => {
    const context = await prepareClosingGateway(signal);
    const { fixture, kernel, shared } = context;
    const owner = ensureProfileForEmail("close-personal@example.test");
    const credential: OAuthCredential = {
      type: "oauth",
      provider: "synthetic",
      access: "synthetic-close-old",
      refresh: "synthetic-refresh-old",
      expires: 1,
    };
    const peerDir = fixture.state.agentDir("peer");
    const profileId =
      kind === "personal"
        ? connectUserModelAccount({
            ownerProfileId: owner.id,
            credential,
            assertCurrent() {},
          }).authProfileId
        : "synthetic:shared";
    if (kind === "shared-peer") {
      const store = { version: 1, profiles: { [profileId]: credential } };
      saveAuthProfileStore(store, peerDir);
      saveAuthProfileStore(store);
    }
    const replacement = {
      ...credential,
      access: "synthetic-close-new",
      refresh: "synthetic-refresh-new",
      expires: Date.now() + 600_000,
    };
    mockOAuthProviderOperations({
      refreshCredential: async () => {
        await context.block();
        return replacement;
      },
    });
    const manager = createOAuthManager();
    const resolving = context
      .trackConnection(() =>
        manager.resolveOAuthAccess({
          profileId,
          credential,
          store: { version: 1, profiles: { [profileId]: credential } },
          signal: kernel.connectionWork.signal,
        }),
      )
      .catch((error: unknown) => error);
    await context.admitted(resolving, "Refresh did not acquire its durable claim");
    await context.beginClose();
    expect(await resolving).toBeInstanceOf(Error);
    expect(shared.isOpen).toBe(true);
    await context.finish();
    expect(shared.isOpen).toBe(false);
    if (kind === "personal") {
      expect(readUserModelAuthProfile(profileId)?.credential).toEqual(replacement);
    } else {
      expect(loadPersistedAuthProfileStore()?.profiles[profileId]).toEqual(replacement);
      expect(loadPersistedAuthProfileStore(peerDir)?.profiles[profileId]).toBeUndefined();
    }
  },
);
