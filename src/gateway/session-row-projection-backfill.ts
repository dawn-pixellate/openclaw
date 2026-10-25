import { AsyncLocalStorage } from "node:async_hooks";
import { isDeepStrictEqual } from "node:util";
import { yieldSessionListBackgroundWork } from "./session-projection-work.js";
import { identity, type EntryRow, type Row } from "./session-row-projection-record.js";
import {
  backfillSessionRowTranscriptFields,
  presentSessionRowTranscriptFields,
} from "./session-row-transcript-backfill.js";

export type SessionRowBackfill = {
  revision: ReturnType<typeof revision>;
  state: "pending" | "running" | "completed" | "not-needed";
  fields?: NonNullable<Awaited<ReturnType<typeof backfillSessionRowTranscriptFields>>>;
};

function revision(row: EntryRow, watermark: Row["retainedDatabaseFacts"]) {
  const { entry, materialized } = row;
  return {
    generation: row.generation,
    watermark: watermark?.activitySummaryWatermark,
    fallback: entry.fallbackNotice && {
      status: entry.status,
      lastRunId: entry.lastRunId,
      modelProvider: entry.modelProvider,
      model: entry.model,
      notice: entry.fallbackNotice,
      selectedModel: materialized?.source.selectedModel,
    },
  };
}

function transcriptParams(row: Row, entry: EntryRow["entry"]) {
  return {
    ...row.storeTarget,
    agentId: row.agentId,
    storeAgentId: row.storeTarget.agentId,
    sessionKey: row.key,
    sessionId: entry.sessionId,
    sessionEntry: entry,
    model: row.materialized && {
      selectedProvider: row.materialized.source.selectedModel.provider,
      selectedModel: row.materialized.source.selectedModel.model,
      config: row.materialized.source.cfg,
    },
  };
}

/** Optional transcript work never participates in row readiness or a foreground response. */
export function createSessionRowProjectionBackfill(params: {
  ready: () => Promise<void>;
  read: (id: string) => Row | undefined;
  current: (row: Row) => boolean;
  publish: (row: Row, fields: NonNullable<SessionRowBackfill["fields"]>) => void;
}) {
  const inOwnerContext = AsyncLocalStorage.snapshot();
  const queued = new Set<string>();
  let pending: Promise<void> | undefined;
  let started = false;
  let disposed = false;
  function publish(row: Row, state: SessionRowBackfill, facts = row.retainedDatabaseFacts) {
    if (facts?.transcriptAssistantMessage === "unknown") {
      facts.transcriptAssistantMessage = state.fields?.lastAssistantMessage ?? null;
    }
    params.publish(row, state.fields ?? {});
  }
  async function drain() {
    for (;;) {
      if (disposed || !queued.size) {
        return;
      }
      await yieldSessionListBackgroundWork();
      await params.ready();
      if (disposed) {
        return;
      }
      const id = queued.values().next().value;
      if (id === undefined) {
        continue;
      }
      queued.delete(id);
      const row = params.read(id);
      const captured = row?.transcriptBackfill;
      if (!row?.entry || !captured || captured.state !== "pending") {
        continue;
      }
      captured.state = "running";
      try {
        const fields = await backfillSessionRowTranscriptFields(transcriptParams(row, row.entry));
        const live = params.read(id);
        // A replacement/private-session revocation must not publish another session's text.
        if (!disposed && live?.entry && params.current(row)) {
          // Superseded reads must not restore previews cleared by broad invalidation.
          if (live.transcriptBackfill !== captured) {
            continue;
          }
          captured.state = fields ? "completed" : "not-needed";
          captured.fields = fields;
          publish(live, captured);
        }
      } catch {
        // A later owner publication retries optional fields; do not spin on a cold/error row.
        const live = params.read(id);
        if (live?.transcriptBackfill === captured) {
          live.transcriptBackfill = undefined;
        }
      }
    }
  }
  function start() {
    started = true;
    if (!disposed && !pending && queued.size) {
      pending = inOwnerContext(drain).finally(() => {
        pending = undefined;
      });
      void pending.then(start, () => {});
    }
  }
  return {
    start,
    prepare(row: EntryRow, facts: Row["retainedDatabaseFacts"]) {
      const id = identity(row);
      const next = revision(row, facts);
      if (facts?.transcriptPreview !== undefined && facts.transcriptTerminalModel !== undefined) {
        const fields = presentSessionRowTranscriptFields(transcriptParams(row, row.entry), {
          lastMessagePreview: facts.transcriptPreview,
          lastAssistantMessage:
            facts.transcriptAssistantMessage === "unknown"
              ? (row.lastAssistantMessage ?? null)
              : facts.transcriptAssistantMessage,
          terminalModel: facts.transcriptTerminalModel,
        });
        params.publish(row, fields);
        if (facts.transcriptAssistantMessage !== "unknown") {
          row.transcriptBackfill = { revision: next, state: "not-needed", fields };
          queued.delete(id);
          return;
        }
      }
      if (!isDeepStrictEqual(row.transcriptBackfill?.revision, next)) {
        row.transcriptBackfill = { revision: next, state: "pending" };
      }
      const state = row.transcriptBackfill!;
      if (state.state === "completed" || state.state === "not-needed") {
        publish(row, state, facts);
      } else if (state.state === "pending") {
        queued.add(id);
      }
      if (started) {
        start();
      }
    },
    suspend(this: void, id: string) {
      queued.delete(id);
    },
    remove(this: void, id: string) {
      const row = params.read(id);
      if (row) {
        row.transcriptBackfill = undefined;
      }
      queued.delete(id);
    },
    dispose() {
      disposed = true;
      queued.clear();
    },
  };
}
