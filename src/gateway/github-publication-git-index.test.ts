import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runCommandBuffered } from "../process/exec.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import {
  assertGitHubPublicationRefCasCompleted,
  recoverGitHubPublicationBranchAndIndex,
  updateGitHubPublicationBranchAndIndex,
} from "./github-publication-git-index.js";
import {
  assertSafeGitPublicationWorkspace,
  captureGitHubPublicationWorkspaceSnapshot,
  githubPublicationPushArgs,
  githubPublicationUpdateRefArgs,
  runPublicationCommand,
} from "./github-publication-git-transport.js";

let testState: OpenClawTestState;
let f: Awaited<ReturnType<typeof createFixture>>;
let directoryIndex = 0;
const REQUEST_ID = "11111111-1111-4111-8111-111111111111";
const rejectRefUpdate = async () => {
  throw new Error("update-ref must not run");
};
const rejects = (operation: Promise<unknown>, message: string) =>
  expect(operation).rejects.toThrow(message);

beforeEach(async () => {
  testState = await createOpenClawTestState({
    prefix: "openclaw-publication-index-",
    env: { XDG_CONFIG_HOME: undefined },
  });
  directoryIndex = 0;
  f = await createFixture();
});

afterEach(async () => {
  await testState.cleanup();
});

async function makeDirectory(label: string): Promise<string> {
  const directory = testState.path(`${label}-${directoryIndex++}`);
  await fs.mkdir(directory, { recursive: true });
  return directory;
}

async function git(
  cwd: string,
  args: string[],
  input?: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<string> {
  const result = await runCommandBuffered(["git", ...args], {
    cwd,
    env,
    ...(input === undefined ? {} : { input }),
    timeoutMs: 10_000,
    maxOutputBytes: 64 * 1024,
  });
  if (result.code !== 0) {
    throw new Error(result.stderr.toString("utf8") || `git ${args[0]} failed`);
  }
  return result.stdout.toString("utf8").trim();
}

async function createFixture() {
  const cwd = await makeDirectory("git");
  const commit = (tree: string, parent: string, message: string) =>
    git(cwd, ["commit-tree", tree, "-p", parent], message);
  const run = (...args: string[]) => git(cwd, args);
  const write = (name: string, value: string) => fs.writeFile(path.join(cwd, name), value);
  await git(cwd, ["init", "--initial-branch=main"]);
  await git(cwd, ["config", "user.name", "OpenClaw Test"]);
  await git(cwd, ["config", "user.email", "openclaw@example.test"]);
  await write("artifact.txt", "base\n");
  await run("add", "artifact.txt");
  await run("commit", "-m", "base");
  const previousHead = await run("rev-parse", "HEAD");
  await write("artifact.txt", "accepted\n");
  await run("add", "artifact.txt");
  const sourceIndexTree = await run("write-tree");
  const headCommit = await commit(
    sourceIndexTree,
    previousHead,
    `published\n\nOpenClaw-Publication: ${REQUEST_ID}\n`,
  );
  const params = {
    cwd,
    previousHead,
    sourceIndexTree,
    workspaceTree: sourceIndexTree,
    headCommit,
    requestId: REQUEST_ID,
    branch: "main",
    env: process.env,
    assertCurrent: () => undefined,
    assertCustody: () => undefined,
    run: async (
      argv: string[],
      options?: { cwd?: string; input?: string; env?: NodeJS.ProcessEnv },
    ) => await git(cwd, argv.slice(1), options?.input, options?.env),
  };
  return {
    ...params,
    git: run,
    write,
    file: (...parts: string[]) => path.join(cwd, ...parts),
    update: (
      overrides: Partial<Parameters<typeof updateGitHubPublicationBranchAndIndex>[0]> = {},
    ) => updateGitHubPublicationBranchAndIndex({ ...params, ...overrides }),
    recover: (
      overrides: Partial<Parameters<typeof recoverGitHubPublicationBranchAndIndex>[0]> = {},
    ) =>
      recoverGitHubPublicationBranchAndIndex({
        ...params,
        sourceHeadCommit: previousHead,
        ...overrides,
      }),
  };
}

const moveHead = async () => {
  await f.git("update-ref", "refs/heads/main", f.headCommit, f.previousHead);
};

async function interruptAcceptedUpdate() {
  await rejects(
    f.update({
      updateRef: async () => {
        await moveHead();
        throw new Error("response lost");
      },
    }),
    "workspace recovery is pending",
  );
}

describe("GitHub publication index update", () => {
  it("inherits the admitted environment while preserving explicit overrides and deletions", async () => {
    vi.stubEnv("OPENCLAW_PUBLICATION_INHERITED", "before-admission");
    vi.stubEnv("OPENCLAW_PUBLICATION_OVERRIDE", "inherited");
    vi.stubEnv("OPENCLAW_PUBLICATION_REMOVED", "inherited");
    const keys = [
      "OPENCLAW_PUBLICATION_INHERITED",
      "OPENCLAW_PUBLICATION_OVERRIDE",
      "OPENCLAW_PUBLICATION_REMOVED",
      "GIT_NO_REPLACE_OBJECTS",
      "OPENCLAW_CLI",
    ];
    try {
      for (const env of [
        undefined,
        { OPENCLAW_PUBLICATION_OVERRIDE: "explicit", OPENCLAW_PUBLICATION_REMOVED: undefined },
      ]) {
        const result = await runPublicationCommand(
          [
            process.execPath,
            "-e",
            `console.log(JSON.stringify(${JSON.stringify(keys)}.map(key => process.env[key] ?? null)))`,
          ],
          {
            env,
            beforeRun: () => {
              process.env.OPENCLAW_PUBLICATION_INHERITED = "admitted";
            },
          },
        );
        expect(result.code).toBe(0);
        expect(JSON.parse(result.stdout.toString("utf8"))).toEqual([
          "admitted",
          env ? "explicit" : "inherited",
          env ? null : "inherited",
          "1",
          "1",
        ]);
      }
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("pins a conditional push when the remote branch was created after admission", async () => {
    const remote = await makeDirectory("remote");
    await git(remote, ["init", "--bare", "--initial-branch=main"]);
    await f.git("push", remote, `${f.previousHead}:refs/heads/publication`);
    const push = githubPublicationPushArgs(remote, f.headCommit, "publication", "").slice(1);
    await expect(git(f.cwd, push)).rejects.toThrow();
    expect(await git(remote, ["rev-parse", "refs/heads/publication"])).toBe(f.previousHead);
    await git(remote, ["update-ref", "-d", "refs/heads/publication"]);
    await git(f.cwd, push);
    expect(await git(remote, ["rev-parse", "refs/heads/publication"])).toBe(f.headCommit);
  });

  it("publishes and recovers with worktree-scoped hooks without executing them", async () => {
    const remote = await makeDirectory("remote");
    const hooks = await makeDirectory("hooks");
    const marker = path.join(hooks, "invoked");
    const hookEnv = { ...process.env, OPENCLAW_PUBLICATION_HOOK_MARKER: marker };
    const run = (argv: string[]) => f.run(argv, { env: hookEnv });
    await git(remote, ["init", "--bare"]);
    for (const hook of ["pre-push", "post-index-change", "reference-transaction"]) {
      await fs.writeFile(
        path.join(hooks, hook),
        '#!/bin/sh\nprintf invoked > "$OPENCLAW_PUBLICATION_HOOK_MARKER"\nexit 97\n',
        { mode: 0o755 },
      );
    }
    await f.git("config", "--local", "extensions.worktreeConfig", "true");
    await f.git("config", "--worktree", "core.hooksPath", hooks);

    await expect(
      assertSafeGitPublicationWorkspace(
        f.cwd,
        async (argv, options) =>
          await runCommandBuffered(argv, {
            ...options,
            cwd: options?.cwd ?? f.cwd,
            timeoutMs: 10_000,
            maxOutputBytes: 64 * 1024,
          }),
      ),
    ).resolves.toBeUndefined();

    await rejects(
      f.update({
        env: hookEnv,
        updateRef: async () => {
          await run(githubPublicationUpdateRefArgs("main", f.headCommit, f.previousHead));
          throw new Error("response lost");
        },
      }),
      "workspace recovery is pending",
    );
    await fs.rm(f.file(".git", "index.lock"));
    const hardenedGit = ["git", "-c", `core.hooksPath=${os.devNull}`, "-c", "core.fsmonitor=false"];
    await run([...hardenedGit, "update-index", "--force-remove", "artifact.txt"]);
    await run([...hardenedGit, "add", "artifact.txt"]);
    await f.recover({
      run: async (argv, options) =>
        await git(f.cwd, argv.slice(1), options?.input, options?.env ?? hookEnv),
    });
    await run(githubPublicationPushArgs(remote, f.headCommit, "publication", ""));

    expect(await git(remote, ["rev-parse", "refs/heads/publication"])).toBe(f.headCommit);
    await expect(fs.access(marker)).rejects.toThrow();
  });

  it("rejects a filter from Git's default global attributes file", async () => {
    const globalAttributes = path.join(testState.home, ".config", "git", "attributes");
    await fs.mkdir(path.dirname(globalAttributes), { recursive: true });
    await fs.writeFile(globalAttributes, "*.secret filter=redact\n");

    await rejects(captureGitHubPublicationWorkspaceSnapshot(f), "unsupported Git clean filter");
  });

  it("rejects concurrent staged changes without moving HEAD or rewriting the index", async () => {
    await f.write("concurrent.txt", "keep staged\n");
    await f.git("add", "concurrent.txt");

    await rejects(f.update({ updateRef: rejectRefUpdate }), "workspace index changed");

    expect(await f.git("rev-parse", "HEAD")).toBe(f.previousHead);
    expect(await f.git("diff", "--cached", "--name-only")).toContain("concurrent.txt");
  });

  it.each([false, true])(
    "recovers the retained index when ambiguous CAS moved=%s",
    async (moved) => {
      const indexPath = f.file(".git", "index");
      const indexBefore = await fs.readFile(indexPath);
      await rejects(
        f.update({
          updateRef: async () => {
            if (moved) {
              await moveHead();
            }
            throw new Error("response lost");
          },
        }),
        "workspace recovery is pending",
      );
      expect(await f.git("rev-parse", "HEAD")).toBe(moved ? f.headCommit : f.previousHead);
      if (!moved) {
        expect(await fs.readFile(indexPath)).toEqual(indexBefore);
        expect((await fs.stat(f.file(".git", "index.lock"))).size).toBeGreaterThan(0);
        await f.update({ updateRef: moveHead });
      } else {
        await f.recover();
        expect(await f.git("write-tree")).toBe(f.workspaceTree);
        await expect(fs.stat(f.file(".git", "index.lock"))).rejects.toThrow();
      }
      expect(await f.git("rev-parse", "HEAD")).toBe(f.headCommit);
      expect(await f.git("status", "--porcelain")).toBe("");
    },
  );

  it("does not install a recovered index after custody changes during Git probes", async () => {
    await interruptAcceptedUpdate();

    let current = true;
    await rejects(
      f.recover({
        assertCustody: () => {
          if (!current) {
            throw new Error("publication authority changed");
          }
        },
        run: async (argv, options) => {
          const result = await git(f.cwd, argv.slice(1), options?.input, options?.env);
          if (argv[1] === "show") {
            current = false;
          }
          return result;
        },
      }),
      "publication authority changed",
    );
    await expect(fs.stat(f.file(".git", "index.lock"))).resolves.toBeDefined();
  });

  it("does not claim another Git operation's byte-identical index lock", async () => {
    const foreignIndex = f.file("foreign-index");
    await git(f.cwd, ["read-tree", f.headCommit], undefined, {
      ...process.env,
      GIT_INDEX_FILE: foreignIndex,
    });
    await fs.rename(foreignIndex, f.file(".git", "index.lock"));

    await rejects(f.update({ updateRef: rejectRefUpdate }), "locked by another operation");

    expect(await f.git("rev-parse", "HEAD")).toBe(f.previousHead);
    expect((await fs.stat(f.file(".git", "index.lock"))).size).toBeGreaterThan(0);
  });

  it.each([false, true])(
    "settles a definite ref CAS rejection (custody revoked: %s)",
    async (revoked) => {
      let current = true;
      await rejects(
        f.update({
          assertCustody() {
            if (!current) {
              throw new Error("Publication custody revoked");
            }
          },
          updateRef: async () => {
            const result = await runCommandBuffered(
              ["git", "update-ref", "refs/heads/main", f.headCommit, "f".repeat(40)],
              { cwd: f.cwd },
            );
            current = !revoked;
            assertGitHubPublicationRefCasCompleted(result);
          },
        }),
        "workspace branch changed before commit",
      );

      if (revoked) {
        await expect(fs.stat(f.file(".git", "index.lock"))).resolves.toBeDefined();
      } else {
        await expect(fs.stat(f.file(".git", "index.lock"))).rejects.toThrow();
      }
      const recoveries = (await fs.readdir(f.file(".git"))).filter((name) =>
        name.startsWith("index.openclaw-"),
      );
      expect(recoveries).toHaveLength(revoked ? 1 : 0);
      expect(await f.git("rev-parse", "HEAD")).toBe(f.previousHead);
    },
  );
});
