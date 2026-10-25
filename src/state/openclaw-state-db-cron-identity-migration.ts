import path from "node:path";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { sql } from "kysely";
import { resolveConfigDir } from "../infra/config-dir.js";
import { jsonPickObject, jsonValid } from "../infra/database-engine/json-values.js";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../infra/kysely-sync.js";
import type { EngineConnection } from "../infra/sql-connection.js";
import { getSqliteWorkerCronDefaultStoreKey } from "../infra/sqlite-worker-state-context.js";
import type { ConfigMachineStateDatabase } from "./config-machine-state-row.js";
import { tableExists } from "./openclaw-state-db-schema-helpers.js";
import type { DB } from "./openclaw-state-db.generated.js";

export const CRON_DEFAULT_STORE_KEY_STATE_KEY = "cron.defaultStoreKey";
export const CRON_DEFAULT_STORE_IDENTITY_SCHEMA_VERSION = 33;

export type CronStorePartitionInventory = {
  storeKey: string;
  jobs: number;
  scratch: number;
  receipts: number;
  history: number;
  quarantine: number;
  proactiveReceipts: number;
};

/** Capture the old selector before moving state; this value is never a path to open. */
export function resolveLegacyCronDefaultStoreKey(env: NodeJS.ProcessEnv): string {
  return path.resolve(resolveConfigDir(env), "cron", "jobs.json");
}

export function resolveCronIdentityMigrationDefaultStoreKey(env: NodeJS.ProcessEnv): string {
  return getSqliteWorkerCronDefaultStoreKey() ?? resolveLegacyCronDefaultStoreKey(env);
}

function readBindingRow(db: EngineConnection, sourceTables?: ReadonlySet<string>) {
  if (!(sourceTables?.has("config_machine_state") ?? tableExists(db, "config_machine_state"))) {
    return undefined;
  }
  return db
    .prepare("SELECT value_json FROM config_machine_state WHERE state_key = ?")
    .get(CRON_DEFAULT_STORE_KEY_STATE_KEY);
}

/** A malformed binding stays unresolved, so unrelated Gateway functions remain available. */
export function readCronDefaultStoreKeyInDatabase(db: EngineConnection): string | undefined {
  const row = readBindingRow(db);
  if (!row || typeof row.value_json !== "string") {
    return undefined;
  }
  try {
    const value: unknown = JSON.parse(row.value_json);
    return typeof value === "string" && value.length > 0 ? value : undefined;
  } catch {
    return undefined;
  }
}

const keyedTables = [
  ["cron_jobs", "jobs"],
  ["cron_job_scratch", "scratch"],
  ["cron_run_receipts", "receipts"],
] as const;
const quarantinePrefix = "cron.quarantine:";
const proactivePrefix = "automation-default:";

/** Offline migration/Doctor inventory; ordinary ready selectors only read the binding. */
export function readCronStorePartitionInventoryInDatabase(
  db: EngineConnection,
  sourceTables?: ReadonlySet<string>,
): CronStorePartitionInventory[] {
  const partitions = new Map<string, CronStorePartitionInventory>();
  const add = (
    key: unknown,
    field: keyof Omit<CronStorePartitionInventory, "storeKey">,
    count: number,
  ) => {
    if (typeof key !== "string" || key.length === 0) {
      return;
    }
    let partition = partitions.get(key);
    if (!partition) {
      partition = {
        storeKey: key,
        jobs: 0,
        scratch: 0,
        receipts: 0,
        history: 0,
        quarantine: 0,
        proactiveReceipts: 0,
      };
      partitions.set(key, partition);
    }
    partition[field] += count;
  };
  for (const [table, field] of keyedTables) {
    if (sourceTables?.has(table) ?? tableExists(db, table)) {
      for (const row of db
        .prepare(`SELECT store_key, count(*) AS count FROM ${table} GROUP BY store_key`)
        .all()) {
        add(row.store_key, field, Number(row.count));
      }
    }
  }
  if (sourceTables?.has("task_runs") ?? tableExists(db, "task_runs")) {
    const query = getNodeSqliteKysely<Pick<DB, "task_runs">>(db)
      .selectFrom("task_runs")
      .select((eb) => [
        /* kysely-allow-raw: Offline inventory projects only the retained partition identity. */
        sql<string | null>`CASE WHEN ${jsonValid(db, eb.ref("detail_json"))}
          THEN ${jsonPickObject(db, eb.ref("detail_json"), ["storeKey"])} END`.as("detail_json"),
      ])
      .where("runtime", "=", "cron");
    for (const row of executeSqliteQuerySync(db, query).rows) {
      if (typeof row.detail_json !== "string") {
        continue;
      }
      try {
        const detail: unknown = JSON.parse(row.detail_json);
        if (isRecord(detail)) {
          add(detail.storeKey, "history", 1);
        }
      } catch {
        // A malformed historical payload cannot establish a partition identity.
      }
    }
  }
  if (sourceTables?.has("diagnostic_events") ?? tableExists(db, "diagnostic_events")) {
    for (const row of db
      .prepare(
        "SELECT scope, count(*) AS count FROM diagnostic_events WHERE scope LIKE ? GROUP BY scope",
      )
      .all(`${quarantinePrefix}%`)) {
      if (typeof row.scope === "string") {
        add(row.scope.slice(quarantinePrefix.length), "quarantine", Number(row.count));
      }
    }
  }
  for (const row of db
    .prepare("SELECT state_key FROM config_machine_state WHERE state_key LIKE ?")
    .all(`${proactivePrefix}%`)) {
    if (typeof row.state_key === "string") {
      // Agent IDs contain no colon; partition keys may include a Windows drive letter.
      add(
        row.state_key.slice(proactivePrefix.length, row.state_key.lastIndexOf(":")),
        "proactiveReceipts",
        1,
      );
    }
  }
  return [...partitions.values()].toSorted((left, right) =>
    left.storeKey < right.storeKey ? -1 : left.storeKey > right.storeKey ? 1 : 0,
  );
}

export type CronIdentityMigrationOptions = {
  previousVersion: number;
  legacyDefaultStoreKey: string;
  /** PostgreSQL schema migrations run before normal admission facts are published. */
  sourceTables?: ReadonlySet<string>;
  /** Only the state bootstrap owner may assert an empty newly created catalog. */
  fresh?: boolean;
  nowMs?: number;
};

export type StateCronIdentityMigrationOptions = {
  env: NodeJS.ProcessEnv;
};

export const stateCronIdentityMigration = {
  version: CRON_DEFAULT_STORE_IDENTITY_SCHEMA_VERSION,
  tables: ["config_machine_state"],
  columns: [],
  migrate: (
    db: EngineConnection,
    previousVersion: number,
    options: StateCronIdentityMigrationOptions,
  ) =>
    migrateCronDefaultStoreIdentity(db, {
      previousVersion,
      legacyDefaultStoreKey: resolveCronIdentityMigrationDefaultStoreKey(options.env),
    }),
  applied: "Introduced durable default cron partition selection (v33)",
};

/** Doctor owns the prompt and offline transaction; this owner validates and binds its choice. */
export function selectCronDefaultStoreIdentityInDatabase(
  db: EngineConnection,
  storeKey: string,
  nowMs = Date.now(),
): void {
  const current = readCronDefaultStoreKeyInDatabase(db);
  if (current === storeKey) {
    return;
  }
  if (current !== undefined) {
    throw new Error("The default cron partition is already bound; preserve its existing identity.");
  }
  const inventory = readCronStorePartitionInventoryInDatabase(db);
  if (
    storeKey.length === 0 ||
    (inventory.length > 0 && !inventory.some((partition) => partition.storeKey === storeKey))
  ) {
    throw new Error(
      "The selected cron partition is not in the persisted inventory; inspect it again before repairing.",
    );
  }
  executeSqliteQuerySync(
    db,
    getNodeSqliteKysely<ConfigMachineStateDatabase>(db)
      .insertInto("config_machine_state")
      .values({
        state_key: CRON_DEFAULT_STORE_KEY_STATE_KEY,
        value_json: JSON.stringify(storeKey),
        updated_at_ms: nowMs,
      })
      .onConflict((conflict) =>
        conflict
          .column("state_key")
          .doUpdateSet({ value_json: JSON.stringify(storeKey), updated_at_ms: nowMs }),
      ),
  );
}

/** Runs within the state owner's existing schema transaction, on both engines. */
export function migrateCronDefaultStoreIdentity(
  db: EngineConnection,
  options: CronIdentityMigrationOptions,
): boolean {
  if (
    options.previousVersion >= CRON_DEFAULT_STORE_IDENTITY_SCHEMA_VERSION ||
    readBindingRow(db, options.sourceTables)
  ) {
    return false;
  }
  let storeKey = options.fresh ? options.legacyDefaultStoreKey : undefined;
  if (!options.fresh) {
    // Normal upgrades with jobs use indexed existence reads instead of scanning retained history.
    const matched = keyedTables.some(
      ([table]) =>
        (options.sourceTables?.has(table) ?? tableExists(db, table)) &&
        db
          .prepare(`SELECT 1 FROM ${table} WHERE store_key = ? LIMIT 1`)
          .get(options.legacyDefaultStoreKey),
    );
    if (matched) {
      storeKey = options.legacyDefaultStoreKey;
    } else {
      const inventory = readCronStorePartitionInventoryInDatabase(db, options.sourceTables);
      if (inventory.some((partition) => partition.storeKey === options.legacyDefaultStoreKey)) {
        storeKey = options.legacyDefaultStoreKey;
      } else if (inventory.length === 0) {
        storeKey = options.legacyDefaultStoreKey;
      }
    }
  }
  // An old moved store has no provable default. Doctor can bind an explicit inventory choice.
  if (storeKey === undefined) {
    return false;
  }
  db.prepare(
    "INSERT INTO config_machine_state (state_key, value_json, updated_at_ms) VALUES (?, ?, ?)",
  ).run(CRON_DEFAULT_STORE_KEY_STATE_KEY, JSON.stringify(storeKey), options.nowMs ?? Date.now());
  return true;
}
