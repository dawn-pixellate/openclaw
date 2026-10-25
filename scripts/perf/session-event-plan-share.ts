/**
 * Real projection/broadcast owner, 66 legacy recipients across three authorization profiles.
 * Each recipient first receives its own ancestor certificate; measured root events need none.
 * Save the trusted comparison owners, then run five counterbalanced pairs in one process:
 * git show <base>:src/gateway/session-event-projection.ts > .local/base-projection.ts
 * git show <base>:src/gateway/session-ancestor-references.ts > .local/base-history.ts
 * git show <base>:src/gateway/server-connection-state.ts > .local/base-connection.ts
 * node --import ./scripts/tsx.mjs scripts/perf/session-event-plan-share.ts \
 *   --baseline-source .local/base-projection.ts --baseline-history-source .local/base-history.ts \
 *   --baseline-connection-source .local/base-connection.ts --publications 250 --pairs 5
 * CPU is untraced; sampled allocation runs separately and includes collected objects.
 * This owner measurement supplements, and does not replace, built-Gateway load testing.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdirSync, readFileSync } from "node:fs";
import { Session } from "node:inspector/promises";
import { registerHooks } from "node:module";
import path from "node:path";
import { setImmediate as yieldToLoop } from "node:timers/promises";
import { parseArgs } from "node:util";
import type { OpenClawConfig } from "../../src/config/types.openclaw.js";
import type { SerializedGatewayFrame } from "../../src/gateway/serialized-json.js";
import type { GatewayWsClient } from "../../src/gateway/server/ws-types.js";
import { parseStrictIntegerOption } from "../lib/strict-integer-option.ts";

const { values } = parseArgs({
  options: {
    "baseline-source": { type: "string" },
    "baseline-history-source": { type: "string" },
    "baseline-connection-source": { type: "string" },
    publications: { type: "string", default: "250" },
    pairs: { type: "string", default: "5" },
    clients: { type: "string", default: "66" },
    "sampling-interval": { type: "string", default: "16384" },
    "state-root": { type: "string", default: ".local/session-event-plan-share" },
  },
});
const integer = (key: "publications" | "pairs" | "clients" | "sampling-interval", min: number) =>
  parseStrictIntegerOption({ raw: values[key], fallback: min, min, label: `--${key}` });
const publications = integer("publications", 1);
const pairs = integer("pairs", 1);
const clientCount = integer("clients", 66);
const samplingInterval = integer("sampling-interval", 1024);
const ownerUrl = new URL("../../src/gateway/session-event-projection.ts", import.meta.url);
const historyUrl = new URL("../../src/gateway/session-ancestor-references.ts", import.meta.url);
const connectionUrl = new URL("../../src/gateway/server-connection-state.ts", import.meta.url);
const baselineUrl = (url: URL) => `${url.href}?plan-share-baseline`;
const sourceFiles = [
  { name: "projection", url: ownerUrl, file: values["baseline-source"] },
  { name: "history", url: historyUrl, file: values["baseline-history-source"] },
  { name: "connection", url: connectionUrl, file: values["baseline-connection-source"] },
];
const baselineSources = new Map(
  sourceFiles.map(({ name, url, file }) => {
    assert(file, `--baseline-${name === "projection" ? "" : `${name}-`}source is required`);
    return [baselineUrl(url), readFileSync(file, "utf8")];
  }),
);
const baselineUrls = new Map(sourceFiles.map(({ url }) => [url.href, baselineUrl(url)]));
const loadedBaseline = new Set<string>();
const sourceHash = (source: string) => createHash("sha256").update(source).digest("hex");
const hook = registerHooks({
  resolve(specifier, context, nextResolve) {
    const resolved = nextResolve(specifier, context);
    const url =
      context.parentURL && baselineSources.has(context.parentURL)
        ? baselineUrls.get(resolved.url)
        : undefined;
    return url ? { ...resolved, url } : resolved;
  },
  load(url, context, nextLoad) {
    const source = baselineSources.get(url);
    if (source !== undefined) {
      loadedBaseline.add(url);
      return { format: "module-typescript", source, shortCircuit: true };
    }
    return nextLoad(url, context);
  },
});
const baseline: typeof import("../../src/gateway/session-event-projection.js") = await import(
  baselineUrl(ownerUrl)
);
const baselineHistory: typeof import("../../src/gateway/session-ancestor-references.js") =
  await import(baselineUrl(historyUrl));
const baselineConnection: typeof import("../../src/gateway/server-connection-state.js") =
  await import(baselineUrl(connectionUrl));
assert.equal(loadedBaseline.size, sourceFiles.length, "baseline owner closure was not loaded");
hook.deregister();
const { prepareSessionEventProjection } =
  await import("../../src/gateway/session-event-projection.js");
const { createGatewayConnectionState } =
  await import("../../src/gateway/server-connection-state.js");
const { prepareGatewayRecipientProfile } = await import("../../src/gateway/expected-profile.js");
const { createSessionRowProjection } = await import("../../src/gateway/session-row-projection.js");
const { ConnectionSessionRows } = await import("../../src/gateway/session-ancestor-references.js");
const { replaceSessionEntrySync } = await import("../../src/config/sessions/session-accessor.js");
const { ensureProfileForEmail } = await import("../../src/state/user-profiles.js");
const { setUserProfileRole } = await import("../../src/state/user-profile-writes.worker.js");
const { createTestGatewayScheduler } =
  await import("../../src/test-utils/gateway-scheduler-clock.js");
const { withOpenClawTestState } = await import("../../src/test-utils/openclaw-test-state.js");

const temporaryRoot = path.resolve(values["state-root"]);
mkdirSync(temporaryRoot, { recursive: true });
const previousTmp = process.env.TMPDIR;
process.env.TMPDIR = temporaryRoot;
const now = Date.now;
Date.now = () => 1_000_000;
try {
  await withOpenClawTestState({ scenario: "minimal", prepareProfileCatalog: true }, async () => {
    const cfg: OpenClawConfig = {
      agents: { entries: { main: {} } },
      gateway: {
        roles: {
          default: "view",
          definitions: {
            view: {
              sessions: { others: "view" },
              agents: "*",
              scopes: ["operator.read", "operator.write"],
            },
            write: {
              sessions: { others: "write" },
              agents: "*",
              scopes: ["operator.read", "operator.write"],
            },
          },
        },
      },
    };
    const profiles = ["owner", "member", "viewer"].map((role) => {
      const profile = ensureProfileForEmail(`plan-share-${role}@example.test`);
      setUserProfileRole(profile.id, role === "member" ? "write" : "view");
      return profile;
    });
    const root = "agent:main:plan-share-root";
    const parent = "agent:main:plan-share-parent";
    const child = "agent:main:plan-share-child";
    for (const key of [root, parent, child]) {
      replaceSessionEntrySync(
        { agentId: "main", sessionKey: key },
        {
          sessionId: key,
          label: key,
          updatedAt: 1,
          visibility: "shared",
          createdActor: { type: "human", source: "profile", id: profiles[0]!.id },
          ...(key === child ? { parentSessionKey: parent } : {}),
        },
      );
    }
    const projection = await createSessionRowProjection({ cfg, modelCatalog: [] });
    const variants = [
      {
        name: "base",
        prepare: baseline.prepareSessionEventProjection,
        createConnection: baselineConnection.createGatewayConnectionState,
        rows: baselineHistory.ConnectionSessionRows,
      },
      {
        name: "candidate",
        prepare: prepareSessionEventProjection,
        createConnection: createGatewayConnectionState,
        rows: ConnectionSessionRows,
      },
    ].map(({ name, prepare, createConnection, rows }) => {
      const connection = createConnection({
        cfg,
        scheduler: createTestGatewayScheduler(),
        bootId: `plan-share-${name}`,
      });
      const detach = connection.attachSessionRowProjection(projection);
      const peers = Array.from({ length: clientCount }, (_, index) => {
        const profile = profiles[index % profiles.length]!;
        const received = {
          count: 0,
          bytes: 0,
          last: undefined as string | Buffer | SerializedGatewayFrame | undefined,
        };
        const socket = Object.assign(new EventEmitter(), {
          readyState: 1,
          bufferedAmount: 0,
          send(
            frame: string | Buffer | SerializedGatewayFrame,
            options?: { binary: false } | ((error?: Error) => void),
            done?: (error?: Error) => void,
          ) {
            received.count++;
            received.bytes +=
              typeof frame === "string" ? Buffer.byteLength(frame) : frame.byteLength;
            received.last = frame;
            (typeof options === "function" ? options : done)?.();
          },
          close() {},
          terminate() {},
        });
        const client: GatewayWsClient = {
          connId: `${name}-${index}`,
          socket,
          usesSharedGatewayAuth: false,
          authenticatedUserId: profile.id,
          authenticatedUserProfile: {
            profileId: profile.id,
            displayName: profile.displayName,
            avatarRevision: "1",
            hasAvatar: false,
            updatedAt: 1,
          },
          connect: {
            minProtocol: 1,
            maxProtocol: 1,
            client: {
              id: "openclaw-control-ui",
              version: "benchmark",
              platform: "benchmark",
              mode: "webchat",
            },
            role: "operator",
            scopes: ["operator.read", "operator.write"],
            caps: [],
          },
        };
        prepareGatewayRecipientProfile(client);
        connection.clients.add(client);
        connection.sessionMessageSubscribers.subscribe(client.connId, child);
        connection.sessionMessageSubscribers.subscribe(client.connId, root);
        for (let prior = 0; prior <= Math.floor(index / 3) % 3; prior++) {
          connection.broadcastToConnIds(
            "sessions.changed",
            { sessionKey: child, agentId: "main", reason: "send" },
            new Set([client.connId]),
          );
        }
        assert(received.count > 0, "recipient priming failed");
        return { client, received };
      });
      const payload = { sessionKey: root, agentId: "main", reason: "send" };
      return {
        name,
        rows,
        connection,
        detach,
        peers,
        publish() {
          connection.broadcast("sessions.changed", payload, {
            prepareSessionProjection: prepare(projection),
          });
        },
      };
    });
    const verify = () => {
      for (let index = 0; index < clientCount; index++) {
        const a = variants[0]!.peers[index]!.received;
        const b = variants[1]!.peers[index]!.received;
        assert.equal(a.count, b.count);
        assert.equal(a.last?.toString(), b.last?.toString(), `wire mismatch at recipient ${index}`);
      }
    };
    const run = async (variant: (typeof variants)[number], count: number) => {
      for (let index = 0; index < count; index++) {
        variant.publish();
        if ((index + 1) % 100 === 0) {
          await yieldToLoop();
        }
      }
    };
    const inspector = new Session();
    const measurements: unknown[] = [];
    try {
      const planCounts: Record<string, number> = {};
      for (const variant of variants) {
        // The count-only wrapper preserves each receiver with apply and restores the method.
        // oxlint-disable-next-line typescript/unbound-method
        const original = variant.rows.prototype.prepareDelivery;
        try {
          let count = 0;
          variant.rows.prototype.prepareDelivery = function (...args) {
            count++;
            return original.apply(this, args);
          };
          variant.publish();
          assert(count > 0, `${variant.name} connection did not use its measured history owner`);
          planCounts[variant.name] = count;
        } finally {
          variant.rows.prototype.prepareDelivery = original;
        }
      }
      verify();
      for (const variant of variants) {
        await run(variant, 50);
      }
      for (const phase of ["cpu", "allocation"] as const) {
        if (phase === "allocation") {
          inspector.connect();
        }
        for (let pair = 0; pair < pairs; pair++) {
          for (const variant of pair % 2 === 0 ? variants : variants.toReversed()) {
            await yieldToLoop();
            if (phase === "allocation") {
              await inspector.post("HeapProfiler.startSampling", {
                samplingInterval,
                includeObjectsCollectedByMajorGC: true,
                includeObjectsCollectedByMinorGC: true,
              });
            }
            const before = process.threadCpuUsage();
            const started = performance.now();
            await run(variant, publications);
            const elapsedMs = performance.now() - started;
            const cpu = process.threadCpuUsage(before);
            const profile =
              phase === "allocation"
                ? (await inspector.post("HeapProfiler.stopSampling")).profile
                : undefined;
            const allocatedBytes = profile?.samples.reduce((sum, sample) => sum + sample.size, 0);
            measurements.push({
              phase,
              pair,
              variant: variant.name,
              publications,
              elapsedMs,
              mainThreadCpuMsPerPublication: (cpu.user + cpu.system) / 1000 / publications,
              ...(allocatedBytes === undefined
                ? {}
                : { sampledAllocatedBytesPerPublication: allocatedBytes / publications }),
            });
          }
          verify();
        }
        if (phase === "allocation") {
          inspector.disconnect();
        }
      }
      console.log(
        JSON.stringify(
          {
            clientCount,
            audiences: profiles.length,
            publications,
            pairs,
            samplingInterval,
            planCounts,
            sourceSha256: {
              base: sourceHash(baselineSources.get(baselineUrl(ownerUrl))!),
              candidate: sourceHash(readFileSync(ownerUrl, "utf8")),
            },
            sourceClosureSha256: Object.fromEntries(
              sourceFiles.map(({ name, url }) => [
                name,
                {
                  base: sourceHash(baselineSources.get(baselineUrl(url))!),
                  candidate: sourceHash(readFileSync(url, "utf8")),
                },
              ]),
            ),
            measurements,
          },
          null,
          2,
        ),
      );
    } finally {
      inspector.disconnect();
      for (const variant of variants) {
        for (const { client } of variant.peers) {
          variant.connection.clients.delete(client);
        }
        variant.detach();
        await variant.connection.mentionInbox.dispose();
      }
      projection.dispose();
    }
  });
} finally {
  Date.now = now;
  if (previousTmp === undefined) {
    delete process.env.TMPDIR;
  } else {
    process.env.TMPDIR = previousTmp;
  }
}
