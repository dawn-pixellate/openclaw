import fs from "node:fs";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { createNativeSessionCommitFinalizer } from "../../agents/harness/native-session/deletion-participant.js";
import { createEmptyPluginRegistry } from "../../plugins/registry-empty.js";
import {
  markPluginRegistryActive,
  markPluginRegistryRetired,
} from "../../plugins/registry-lifecycle.js";
import { withPluginRuntimeRegistryScope } from "../../plugins/runtime/gateway-request-scope.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { openOpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import {
  withOpenClawTestState,
  type OpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";
import { readSessionArchiveContentSync } from "./archive-compression.js";
import {
  applySessionEntryLifecycleMutation,
  applySessionEntryReplacements,
  loadSessionEntry,
  replaceSessionEntrySync,
} from "./session-accessor.js";
import { kickSessionEntryMaintenanceAfterWrite } from "./session-accessor.sqlite-maintenance-kick.js";
import * as maintenance from "./session-accessor.sqlite-maintenance.js";
import * as reclamationRun from "./session-accessor.sqlite-reclamation-run.js";
import { applySessionEntryCanonicalReplacements } from "./session-accessor.sqlite-replacement-projection.js";
import { resolveSqliteScope, toDatabaseOptions } from "./session-accessor.sqlite-scope.js";
import { replaceTranscriptEventsSync } from "./session-accessor.sqlite-transcript-write.test-support.js";
import { resolveMaintenanceConfigFromInput } from "./store-maintenance.js";
import type { SessionEntry } from "./types.js";

function storeFixture(state: OpenClawTestState) {
  const storePath = path.join(state.sessionsDir(), "sessions.json");
  const scope = (sessionKey: string) => ({ sessionKey, storePath });
  return {
    state,
    storePath,
    read: (key: string) => loadSessionEntry(scope(key)),
    database: (key: string) =>
      openOpenClawAgentDatabase(toDatabaseOptions(resolveSqliteScope(scope(key)))),
    archives: () =>
      fs.readdirSync(state.sessionsDir()).filter((name) => name.includes(".deleted.")),
    seed: (key: string, entry: SessionEntry, content?: string) => {
      replaceSessionEntrySync(scope(key), entry);
      if (content !== undefined) {
        replaceTranscriptEventsSync({ ...scope(key), sessionId: entry.sessionId }, [
          { type: "session", id: entry.sessionId, content },
        ]);
      }
    },
  };
}
const withStore = (run: (fixture: ReturnType<typeof storeFixture>) => Promise<void>) =>
  withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    try {
      await run(storeFixture(state));
    } finally {
      vi.restoreAllMocks();
    }
  });

it.each(
  ["session.entry-replacements", "session.lifecycle.mutate"].flatMap((operation) =>
    [false, true].map((split) => ({ operation, split })),
  ),
)(
  "commits $operation outside native preparation/finalization (split: $split)",
  async ({ operation, split }) => {
    await withStore(async ({ state, storePath, seed, read, database: openDatabase, archives }) => {
      const sourceKey = "agent:main:writer-source";
      const targetKey = split ? "agent:main:writer-target" : sourceKey;
      const source = { sessionId: "writer-source", updatedAt: 1, label: "before" };
      seed(sourceKey, source, "retained archive");
      const database = openDatabase(sourceKey);
      const rows = () =>
        database.db
          .prepare("SELECT session_key, label FROM session_nodes ORDER BY session_key")
          .all();
      const before = rows();
      const order: string[] = [];
      const registry = createEmptyPluginRegistry();
      registry.agentHarnesses.push({
        pluginId: "core",
        source: "runtime",
        harness: {
          id: "writer-owner",
          label: "Synthetic writer owner",
          supports: () => ({ supported: true }),
          runAttempt: async () => {
            throw new Error("unused");
          },
          withSessionDeletion: async (params, run) => {
            params.assertCurrent();
            expect(database.db.isTransaction).toBe(false);
            expect(rows()).toEqual(before);
            order.push("native:prepare");
            const result = await run(
              createNativeSessionCommitFinalizer({
                commit: () => {
                  expect(database.db.isTransaction).toBe(false);
                  expect(rows()).toEqual([{ session_key: targetKey, label: "after" }]);
                  order.push("native:commit");
                },
                rollback: () => {
                  order.push("native:rollback");
                },
              }),
            );
            order.push("native:release");
            return result;
          },
        },
      });
      markPluginRegistryActive(registry);
      const updated = {
        ...source,
        ...(split && operation !== "session.entry-replacements"
          ? { sessionId: "writer-target" }
          : {}),
        label: "after",
      };
      const resultToken = {};
      const prepared = () => {
        expect(rows()).toEqual(before);
        order.push("callback");
      };
      const replacement = { sessionKey: targetKey, entry: updated };
      const replacements = (canonical = false) => {
        prepared();
        return {
          result: resultToken,
          replacements: [{ ...replacement, previousSessionKeys: canonical ? [sourceKey] : [] }],
        };
      };
      try {
        await withPluginRuntimeRegistryScope(registry, async () => {
          if (operation === "session.entry-replacements") {
            const request = {
              storePath,
              sessionKeys: split ? [sourceKey, targetKey] : [sourceKey],
              update: async () => replacements(split),
            };
            const result = split
              ? await applySessionEntryCanonicalReplacements(request)
              : await applySessionEntryReplacements(request);
            expect(result).toBe(resultToken);
          } else {
            const result = await applySessionEntryLifecycleMutation({
              storePath,
              skipMaintenance: true,
              removals: split ? [{ sessionKey: sourceKey, archiveRemovedTranscript: true }] : [],
              upserts: [
                {
                  sessionKey: targetKey,
                  buildEntry: async () => {
                    prepared();
                    return updated;
                  },
                },
              ],
            });
            expect(result).toMatchObject({ afterCount: 1, removedEntries: split ? 1 : 0 });
            if (split) {
              expect(result.archivedTranscriptDirectories).toEqual([state.sessionsDir()]);
              const files = archives();
              expect(files).toHaveLength(1);
              expect(
                readSessionArchiveContentSync(path.join(state.sessionsDir(), files[0]!)),
              ).toContain("retained archive");
            }
          }
        });
        expect(read(targetKey)).toMatchObject(updated);
        expect(order).toEqual(
          split ? ["callback", "native:prepare", "native:commit", "native:release"] : ["callback"],
        );
        if (split) {
          expect(read(sourceKey)).toBeUndefined();
        }
      } finally {
        markPluginRegistryRetired(registry);
      }
    });
  },
);

it("coalesces automatic maintenance through native planning and finalization", async () => {
  await withStore(async ({ state, storePath, seed, read }) => {
    const staleKey = "agent:main:subagent:writer-stale";
    const activeKey = "agent:main:writer-active";
    seed(staleKey, { sessionId: "stale", updatedAt: 1 });
    seed(activeKey, { sessionId: "active", updatedAt: Date.now() });
    const finalize = maintenance.finalizeSessionEntryMaintenancePlansAfterWriterReleaseBestEffort;
    const finalized = createDeferredCore<Awaited<ReturnType<typeof finalize>>>();
    // Row deletion precedes archive publication; join the unchanged finalizer, including both.
    const finalizer = vi
      .spyOn(maintenance, "finalizeSessionEntryMaintenancePlansAfterWriterReleaseBestEffort")
      .mockImplementation((...args) => {
        const result = finalize(...args);
        finalized.resolve(result);
        return result;
      });
    const maintenanceSettled = createDeferredCore();
    const reclaim = reclamationRun.runSqliteSessionReclamation;
    vi.spyOn(reclamationRun, "runSqliteSessionReclamation").mockImplementation(async (params) => {
      const result = await reclaim(params);
      if (
        result.kind === "maintenance-age" ||
        (result.kind === "maintenance-plan" &&
          result.value.archived === 0 &&
          result.value.entryRemovals.length === 0 &&
          result.value.stateDeletePlans.length === 0)
      ) {
        // Empty plans carry their verified deadline without another age request.
        maintenanceSettled.resolve();
      }
      return result;
    });
    const request = {
      activeSessionKey: activeKey,
      archiveDirectory: state.sessionsDir(),
      scope: resolveSqliteScope({ sessionKey: activeKey, storePath }),
      storePath,
      maintenanceConfig: resolveMaintenanceConfigFromInput({
        mode: "enforce",
        // Native worker preparation must not age the active fixture into a second archive pass.
        pruneAfter: "30d",
        maxEntries: 100,
      }),
    };
    kickSessionEntryMaintenanceAfterWrite(request);
    kickSessionEntryMaintenanceAfterWrite(request);
    await finalized.promise;
    await maintenanceSettled.promise;
    expect(finalizer).toHaveBeenCalledOnce();
    expect(read(staleKey)).toBeUndefined();
    expect(read(activeKey)?.sessionId).toBe("active");
  });
});
