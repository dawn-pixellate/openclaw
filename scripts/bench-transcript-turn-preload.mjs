import { channel } from "node:diagnostics_channel";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { DatabaseSync, StatementSync } from "node:sqlite";
import workerThreads from "node:worker_threads";
const output = process.env.OPENCLAW_TURN_TRACE;
if (output) {
  const record = (value) =>
    fs.appendFileSync(
      output,
      JSON.stringify({ ...value, at: performance.timeOrigin + performance.now() }) + "\n",
    );
  const observeSqlite = (sql, run) => {
    try {
      return run();
    } finally {
      record({
        engine: "sqlite",
        threadId: workerThreads.threadId,
        sql,
      });
    }
  };
  // Read-only routing handles are raw DatabaseSync objects. Count native
  // executions too, instead of counting only the writer's EngineConnection.
  for (const method of ["all", "get", "run"]) {
    StatementSync.prototype[method] = new Proxy(StatementSync.prototype[method], {
      apply(target, receiver, args) {
        return observeSqlite(receiver.sourceSQL, () => Reflect.apply(target, receiver, args));
      },
    });
  }
  // oxlint-disable-next-line typescript/unbound-method -- The proxy forwards the original receiver through Reflect.apply.
  StatementSync.prototype.iterate = new Proxy(StatementSync.prototype.iterate, {
    apply(target, receiver, args) {
      const iterator = Reflect.apply(target, receiver, args);
      const next = iterator.next;
      let counted = false;
      // Creating an iterator does not execute SQL. Count its first step only;
      // completion timing and outcomes are outside this work-count observer.
      iterator.next = function (...nextArgs) {
        const step = () => Reflect.apply(next, this, nextArgs);
        if (counted) {
          return step();
        }
        counted = true;
        return observeSqlite(receiver.sourceSQL, step);
      };
      return iterator;
    },
  });
  // oxlint-disable-next-line typescript/unbound-method -- The proxy forwards the original receiver through Reflect.apply.
  DatabaseSync.prototype.exec = new Proxy(DatabaseSync.prototype.exec, {
    apply(target, receiver, args) {
      return observeSqlite(args[0], () => Reflect.apply(target, receiver, args));
    },
  });
  const OriginalWorker = workerThreads.Worker;
  workerThreads.Worker = class extends OriginalWorker {
    constructor(filename, options = {}) {
      const execArgv = options.execArgv ?? process.execArgv;
      super(filename, {
        ...options,
        execArgv: execArgv.includes(import.meta.url)
          ? execArgv
          : [...execArgv, "--import", import.meta.url],
      });
    }
  };
  syncBuiltinESMExports();
  channel("openclaw.database.statement").subscribe((value) => {
    if (value.engine !== "sqlite") {
      record(value);
    }
  });
}
