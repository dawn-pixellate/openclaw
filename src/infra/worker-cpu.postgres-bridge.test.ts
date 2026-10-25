import { once } from "node:events";
import { MessageChannel } from "node:worker_threads";
import { expect, it } from "vitest";
import { createPostgresBridge } from "./postgres-sync/bridge-prestart.js";
import {
  closePostgresPool,
  createPostgresPoolEndpoints,
  postgresPoolTransferList,
} from "./postgres-sync/pool.js";
import { resolveRuntimeWorkerThreadExecArgv } from "./runtime-worker-url.js";
import {
  createCpuTrackedWorker,
  getTrackedWorkerPoolSnapshot,
  receiveWorkerMemoryPort,
  sampleTrackedWorkerMemory,
} from "./worker-cpu.js";
import {
  collectPostgresBridgeCounters,
  countPostgresBridges,
} from "./worker-postgres-bridge-census.js";

it("counts four physical services across direct and deeply nested logical bridges", async () => {
  const before = getTrackedWorkerPoolSnapshot();
  const baseline = before.postgresBridgeCount ?? 0;
  const { port1, port2 } = new MessageChannel();
  const direct = createPostgresBridge({
    url: "postgres://localhost/bridge_census_fixture",
    schema: "fixture",
    storeId: "fixture",
  });
  const postgresPool = createPostgresPoolEndpoints();
  const workerUrl = new URL("./worker-cpu.postgres-bridge.test-support.ts", import.meta.url);
  const parent = createCpuTrackedWorker(workerUrl, {
    workerData: { control: port2, depth: 2, postgresPool },
    transferList: [port2, ...postgresPoolTransferList(postgresPool)],
    execArgv: resolveRuntimeWorkerThreadExecArgv(workerUrl),
  });
  const attached = new Promise<void>((resolve, reject) => {
    parent.on("message", (message: unknown) => {
      if (receiveWorkerMemoryPort(parent, message)) {
        resolve();
      }
    });
    parent.once("error", reject);
  });
  const command = async (value: "create" | "close" | "nest" | "unnest") => {
    const reply = once(port1, "message");
    port1.postMessage(value);
    return (await reply)[0];
  };
  try {
    await attached;
    expect(await command("create")).toBe(1);
    expect(await command("create")).toBe(2);
    expect(getTrackedWorkerPoolSnapshot()).toMatchObject({
      workerCount: before.workerCount + 5,
      postgresBridgeCount: baseline + 4,
    });
    expect(sampleTrackedWorkerMemory().postgresBridgeCount).toBe(baseline + 4);

    // Logical close and host retirement preserve services used by other owners.
    expect(await command("close")).toBe(1);
    expect(getTrackedWorkerPoolSnapshot().postgresBridgeCount).toBe(baseline + 4);

    expect(await command("unnest")).toBe(0);
    expect(await command("nest")).toBe(0);
    expect(await command("create")).toBe(1);

    await parent.terminate();
    expect(sampleTrackedWorkerMemory().postgresBridgeCount).toBe(baseline + 4);
    direct.port.close();
    await closePostgresPool();
    expect(getTrackedWorkerPoolSnapshot()).toMatchObject({
      workerCount: before.workerCount,
      postgresBridgeCount: baseline,
    });
  } finally {
    port1.close();
    direct.port.close();
    await parent.terminate();
    await closePostgresPool();
  }
});

it("counts a shared counter once when multiple diagnostic sources forward it", () => {
  const descendant = { threadId: 9001, count: new Int32Array(new SharedArrayBuffer(4)) };
  Atomics.store(descendant.count, 0, 3);
  const forwarded = structuredClone(descendant);
  expect(forwarded.count.buffer).not.toBe(descendant.count.buffer);
  const counters = collectPostgresBridgeCounters(new Int32Array(new SharedArrayBuffer(4)), [
    { postgresBridgeCounters: [descendant] },
    { postgresBridgeCounters: [forwarded] },
  ]);
  expect(countPostgresBridges(counters)).toBe(3);
});
