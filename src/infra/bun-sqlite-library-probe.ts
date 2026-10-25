import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { resolveRuntimeScriptEnv } from "../../cli-invocation.mjs";
import { BUN_SQLITE_LIBRARY_PROBE_SOURCE } from "./bun-sqlite-library-probe.generated.js";
import { runtimeProcessScriptEntrypoints } from "./runtime-process-manifest.js";
import { materializeRuntimeProcessScriptFile } from "./runtime-process-script-file.js";

export type SqliteLibraryProbe = { version: string; extensionLoadingSupported: boolean };

/** Each candidate gets a fresh process because Bun's SQLite selection is one-shot. */
export function probeBunSqliteLibrary(candidate: string): SqliteLibraryProbe {
  const script = materializeRuntimeProcessScriptFile({
    fileName: runtimeProcessScriptEntrypoints.bunSqliteLibraryProbe.fileName,
    source: BUN_SQLITE_LIBRARY_PROBE_SOURCE,
  });
  try {
    const env: NodeJS.ProcessEnv = {};
    for (const key of ["SystemRoot", "SYSTEMROOT", "WINDIR", "TEMP", "TMP", "TMPDIR"]) {
      if (process.env[key]) {
        env[key] = process.env[key];
      }
    }
    const result = spawnSync(
      process.execPath,
      ["--no-install", fileURLToPath(script.url), candidate],
      {
        env: resolveRuntimeScriptEnv(env),
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 5_000,
        killSignal: "SIGKILL",
        maxBuffer: 4_096,
      },
    );
    if (result.error) {
      throw result.error;
    }
    let facts: unknown;
    try {
      facts = JSON.parse(result.stdout);
    } catch {
      throw new Error("SQLite library probe returned invalid output");
    }
    if (!isRecord(facts) || facts.protocol !== 1) {
      throw new Error("SQLite library probe returned invalid output");
    }
    if (result.status !== 0) {
      throw new Error(
        typeof facts.error === "string"
          ? facts.error.slice(0, 512)
          : `SQLite library probe failed (${result.signal ?? result.status})`,
      );
    }
    if (
      typeof facts.version !== "string" ||
      facts.version.length > 64 ||
      typeof facts.extensionLoadingSupported !== "boolean"
    ) {
      throw new Error("SQLite library probe returned invalid output");
    }
    return { version: facts.version, extensionLoadingSupported: facts.extensionLoadingSupported };
  } finally {
    script.dispose();
  }
}
