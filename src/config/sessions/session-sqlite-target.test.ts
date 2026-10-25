import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { resolveIncognitoOpenClawAgentSqlitePath } from "../../state/openclaw-agent-db.js";
import {
  prepareSqliteTargetFromSessionStorePath,
  resolveSqliteTargetFromSessionStorePath as resolveTarget,
} from "./session-sqlite-target.js";

const stores = (...parts: string[]) => path.resolve("tmp", "stores", ...parts);
const targetPath = (store: string, options: Parameters<typeof resolveTarget>[1] = {}) =>
  resolveTarget(store, options).path;

describe("resolveSqliteTargetFromSessionStorePath", () => {
  const tempDirs = useAutoCleanupTempDirTracker(afterEach);
  it.each(["(multiple)", "  (multiple)  ", "stores/{agentId}/sessions.json", ""])(
    "rejects non-concrete store selector %j before resolving or opening it",
    async (storePath) => {
      expect(() => resolveTarget(storePath)).toThrow(
        "Session storage requires a concrete store path",
      );
      await expect(prepareSqliteTargetFromSessionStorePath(storePath)).rejects.toThrow(
        "Session storage requires a concrete store path",
      );
    },
  );

  it.each([
    ["ops", "configured-default", []],
    ["main", "ambiguous-registry", ["main", "ops"]],
  ] as const)(
    "keeps exact locators shared with owner %s from %s",
    (agentId, ownerSource, owners) => {
      const databasePath = stores("shared.sqlite");
      expect(
        resolveTarget(databasePath, {
          agentId: ownerSource === "configured-default" ? "worker" : undefined,
          defaultAgentId: agentId,
          ...(owners.length
            ? {
                registeredDatabases: owners.map((owner) => ({
                  agentId: owner,
                  path: databasePath,
                })),
              }
            : {}),
        }),
      ).toMatchObject({ agentId, ownerSource, path: databasePath, shared: true });
    },
  );

  it("keeps an incognito sentinel owned by its requested agent", () => {
    const env = { OPENCLAW_STATE_DIR: tempDirs.make("openclaw-incognito-target-") };
    const databasePath = resolveIncognitoOpenClawAgentSqlitePath({ agentId: "ops", env });

    expect(
      resolveTarget(databasePath, {
        agentId: "ops",
        defaultAgentId: "main",
        env,
      }),
    ).toEqual({ agentId: "ops", path: databasePath });
  });

  it.each([
    ["main.json", "main", "main.sqlite"],
    ["ops.json", "ops", "ops.ops.sqlite"],
    ["sessions.json", "main", "openclaw-agent.sqlite"],
    ["sessions.json", "work", "openclaw-agent.work.sqlite"],
  ])("resolves custom store %s for %s to %s", (store, agentId, file) => {
    expect(targetPath(path.join("tmp", "stores", store), { agentId, defaultAgentId: "main" })).toBe(
      stores(file),
    );
  });

  it.each(["ops.sqlite", `${path.sep}ops.sqlite`, `ops.sqlite${path.sep}`])(
    "lets the registered owner retain the unsuffixed target through input spelling %j",
    (registeredSuffix) => {
      const missingDir = path.join(tempDirs.make("openclaw-registered-session-target-"), "future");
      const storePath = path.join(missingDir, "ops.json");
      const registeredDatabases = [
        { agentId: "ops", path: `${missingDir}${path.sep}${registeredSuffix}` },
      ];

      for (const [agentId, file] of [
        ["ops", "ops.sqlite"],
        ["main", "ops.main.sqlite"],
      ]) {
        expect(
          resolveTarget(storePath, { agentId, defaultAgentId: "main", registeredDatabases }),
        ).toMatchObject({
          path: path.join(missingDir, file),
          ownerSource: "database-registry",
          unsuffixedOwnerAgentId: "ops",
        });
      }
    },
  );

  it
    .runIf(process.platform !== "win32")
    .each([`missing${path.sep}${path.sep}ops.sqlite`, `missing${path.sep}ops.sqlite${path.sep}`])(
    "does not normalize a missing registered symlink target %j into ownership",
    (target) => {
      const dir = tempDirs.make("openclaw-registered-session-symlink-");
      const aliasPath = path.join(dir, "alias.sqlite");
      fs.symlinkSync(target, aliasPath);

      expect(
        resolveTarget(path.join(dir, "missing", "ops.json"), {
          agentId: "main",
          defaultAgentId: "main",
          registeredDatabases: [{ agentId: "ops", path: aliasPath }],
        }),
      ).toMatchObject({
        path: path.join(dir, "missing", "ops.sqlite"),
        ownerSource: "configured-default",
        unsuffixedOwnerAgentId: "main",
      });
    },
  );

  it.each([
    { extension: "sqlite", registeredAgentId: "ops" },
    { extension: "json", registeredAgentId: "main" },
  ])(
    "rejects inconclusive ownership for a $extension locator and retries after recovery",
    ({ extension, registeredAgentId }) => {
      const root = fs.realpathSync(tempDirs.make("openclaw-inconclusive-session-owner-"));
      const occupiedNames = Array.from("bcdefghijklmnopqrstuvwxyz0123456789");
      for (const name of occupiedNames) {
        fs.writeFileSync(path.join(root, name), "preserve");
      }
      const missingDirectory = path.join(root, "a");
      const resolve = () =>
        resolveTarget(path.join(missingDirectory, `shared.${extension}`), {
          agentId: "main",
          defaultAgentId: "main",
          registeredDatabases: [
            { agentId: registeredAgentId, path: path.join(missingDirectory, "unrelated.sqlite") },
          ],
        });

      expect(resolve).toThrow("Cannot determine whether database paths alias");
      expect(fs.readdirSync(root).toSorted()).toEqual(occupiedNames.toSorted());
      for (const name of occupiedNames) {
        fs.unlinkSync(path.join(root, name));
      }
      expect(resolve()).toMatchObject({
        agentId: "main",
        ownerSource: "configured-default",
        path: path.join(missingDirectory, "shared.sqlite"),
      });
      expect(fs.readdirSync(root)).toEqual([]);
    },
  );

  for (const [name, agentId, registrations, expectedFile] of [
    [
      "does not treat ambiguous suffix registration as ownership",
      "worker",
      [
        ["worker", "shared.worker.sqlite"],
        ["ops", "shared.worker.sqlite"],
      ],
      "shared.worker.2.sqlite",
    ],
    [
      "does not assign an ambiguously registered unsuffixed target to the default",
      "main",
      [
        ["main", "shared.sqlite"],
        ["ops", "shared.sqlite"],
      ],
      "shared.main.sqlite",
    ],
    [
      "searches past every occupied suffix for the first free target",
      "worker",
      Array.from({ length: 33 }, (_, offset) => {
        const index = offset + 1;
        const fileName = index === 1 ? "shared.worker.sqlite" : `shared.worker.${index}.sqlite`;
        return ["ops", fileName] as const;
      }),
      "shared.worker.34.sqlite",
    ],
    [
      "ignores a sparse huge suffix when the conventional suffix is free",
      "worker",
      [["ops", "shared.worker.2147483647.sqlite"]],
      "shared.worker.sqlite",
    ],
    [
      "does not treat noncanonical numeric suffix spellings as occupied indices",
      "worker",
      [
        ["ops", "shared.worker.sqlite"],
        ["ops", "shared.worker.02.sqlite"],
      ],
      "shared.worker.2.sqlite",
    ],
  ] as const) {
    it(name, () => {
      const registeredDatabases = registrations.map(([registeredAgentId, fileName]) => ({
        agentId: registeredAgentId,
        path: stores(fileName),
      }));

      expect(
        targetPath(path.join("tmp", "stores", "shared.json"), {
          agentId,
          defaultAgentId: "main",
          registeredDatabases,
        }),
      ).toBe(stores(expectedFile));
    });
  }

  it.runIf(process.platform !== "win32").each([
    ["worker", "shared.worker.sqlite", "shared.worker.2.sqlite"],
    ["main", "shared.sqlite", "shared.main.sqlite"],
  ])("treats dangling %s target symlinks as occupied", (agentId, occupied, expected) => {
    const dir = tempDirs.make("openclaw-session-symlink-");
    const storePath = path.join(dir, "shared.json");
    fs.symlinkSync(path.join(dir, "missing-target.sqlite"), path.join(dir, occupied));
    expect(targetPath(storePath, { agentId, defaultAgentId: "main" })).toBe(
      path.join(dir, expected),
    );
  });

  it("propagates non-missing target-directory inspection errors", () => {
    const dir = tempDirs.make("openclaw-session-suffix-inspection-");
    const blocker = path.join(dir, "not-a-directory");
    fs.writeFileSync(blocker, "blocked\n");

    expect(() =>
      resolveTarget(path.join(blocker, "shared.json"), {
        agentId: "worker",
        defaultAgentId: "main",
      }),
    ).toThrow(expect.objectContaining({ code: "ENOTDIR" }));
  });

  it.each(["sqlite", "json"])(
    "propagates path inspection errors for a registered %s locator",
    (extension) => {
      const dir = tempDirs.make("openclaw-registered-session-inspection-");
      const storePath = path.join(dir, `invalid\0.${extension}`);

      expect(() =>
        resolveTarget(storePath, {
          registeredDatabases: [
            { agentId: "main", path: path.join(dir, "invalid\0.sqlite") },
            { agentId: "main", path: path.join(dir, "invalid\0.main.sqlite") },
          ],
          isSameDatabasePath: (left, right) => left === right,
        }),
      ).toThrow(expect.objectContaining({ code: "ERR_INVALID_ARG_VALUE" }));
    },
  );
});
