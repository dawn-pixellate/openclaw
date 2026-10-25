import { execFile, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import { expectFiles, expectMissingFiles, writeFiles } from "./service-files.test-support.js";
import { ManagedWorktreeService } from "./service.js";
import {
  materializeManagedWorktreeFixture,
  useManagedWorktreeTestRepository,
} from "./service.test-support.js";
import { readExactStateSnapshot } from "./snapshot-exact-state.js";

const exec = promisify(execFile);
async function git(cwd: string, ...args: string[]) {
  return (
    await exec("git", ["--no-optional-locks", "-C", cwd, ...args], { encoding: "utf8" })
  ).stdout.trim();
}
const sha256 = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

describe("managed exact-state retirement", () => {
  const initializeRepository = useManagedWorktreeTestRepository();
  const temps = useAutoCleanupTempDirTracker((cleanup) =>
    afterEach(() => {
      vi.restoreAllMocks();
      closeOpenClawStateDatabaseForTest();
      cleanup();
    }),
  );
  let repo: string;
  let stateDir: string;
  let env: NodeJS.ProcessEnv;
  let service: ManagedWorktreeService;
  type WorktreeRecord = Awaited<ReturnType<typeof materializeManagedWorktreeFixture>>;
  const fixture = (
    name: string,
    overrides: Partial<Parameters<typeof materializeManagedWorktreeFixture>[0]> = {},
  ) =>
    materializeManagedWorktreeFixture({
      env,
      repoRoot: repo,
      stateDir,
      name,
      now: 1_800_000_000_000,
      ownerKind: "manual",
      ...overrides,
    });
  const indexPath = async (checkout: string) =>
    path.resolve(checkout, await git(checkout, "rev-parse", "--git-path", "index"));
  const discardRecovery = (recoveryPath: string) =>
    git(repo, "worktree", "remove", "--force", recoveryPath);
  const indexBytes = async (checkout: string) => fs.readFile(await indexPath(checkout));
  const retire = async (
    record: WorktreeRecord,
    head: string,
    branchHead = head,
    indexSha256?: string,
  ) =>
    service.remove({
      id: record.id,
      reason: "exact metadata fixture",
      exactState: {
        ownerKind: record.ownerKind,
        ownerId: record.ownerId,
        createdAt: record.createdAt,
        lastActiveAt: record.lastActiveAt,
        head,
        branchHead,
        indexSha256: indexSha256 ?? sha256(await indexBytes(record.path)),
      },
    });
  beforeEach(async () => {
    const root = temps.make("openclaw-exact-state-");
    repo = await initializeRepository(root);
    stateDir = path.join(root, "state");
    env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
    service = new ManagedWorktreeService({
      env,
      getConfig: () => ({ worktreeAcceleration: false }),
    });
  });

  async function retiredFixture(name: string, prepare?: (checkout: string) => Promise<void>) {
    const created = await fixture(name);
    const head = await git(created.path, "rev-parse", "HEAD");
    await git(created.path, "checkout", "--detach", "HEAD");
    await prepare?.(created.path);
    const retired = await retire(created, head);
    await discardRecovery(retired.recoveryPath!);
    return { created, retired, head };
  }
  function afterRestoreFile(effect: () => Promise<void> | void, filename?: string) {
    const write = fs.writeFile;
    let injected = false;
    vi.spyOn(fs, "writeFile").mockImplementation(async (...args) => {
      const result = await write(...args);
      const target = args[0];
      if (
        !injected &&
        typeof target === "string" &&
        path.basename(path.dirname(target)) === "files" &&
        (!filename || path.basename(target) === filename)
      ) {
        injected = true;
        await effect();
      }
      return result;
    });
    return () => expect(injected).toBe(true);
  }

  it("round-trips detached HEAD, split index and work bytes", async () => {
    await fs.writeFile(path.join(repo, ".gitignore"), "saved.secret\ncache.tmp\n");
    await git(repo, "add", ".gitignore");
    await git(repo, "commit", "-m", "ignore fixture data");
    await fs.writeFile(path.join(repo, "saved.secret"), "provisioned secret\n");
    const created = await fixture("exact-state", {
      ownerKind: "session",
      ownerId: "exact-state-owner",
      provisionedPaths: ["saved.secret"],
    });
    const branchHead = await git(created.path, "rev-parse", "HEAD");
    await git(created.path, "checkout", "--detach", "HEAD~1");
    const head = await git(created.path, "rev-parse", "HEAD");
    await writeFiles(created.path, {
      ".gitignore": "saved.secret\ncache.tmp\n",
      ".gitattributes": "*.txt text eol=crlf\n*.utf16 working-tree-encoding=UTF-16LE\n",
      "raw.txt": "raw LF bytes\n",
      "encoded.utf16": Buffer.from([0x78, 0]),
      "README.md": "staged half\n",
      "staged-only.txt": "only reachable from index\n",
      "missing-parent/nested/staged-child.txt": "nested index-only bytes\n",
    });
    await git(created.path, "add", "README.md", "staged-only.txt", "missing-parent");
    await fs.rm(path.join(created.path, "missing-parent"), { recursive: true });
    const stagedBlob = await git(created.path, "rev-parse", ":staged-only.txt");
    await fs.writeFile(path.join(created.path, "README.md"), "unstaged half\n");
    await fs.rm(path.join(created.path, "staged-only.txt"));
    await writeFiles(created.path, {
      "untracked.sh": "#!/bin/sh\nprintf exact\n",
      "saved.secret": "saved ignored bytes\n",
      "cache.tmp": "discarded native cache\n",
    });
    await fs.chmod(path.join(created.path, "untracked.sh"), 0o751);
    if (process.platform !== "win32") {
      await fs.symlink("README.md", path.join(created.path, "readme-link"));
    }
    await fs.chmod(path.join(created.path, "saved.secret"), 0o600);
    await fs.utimes(path.join(created.path, "untracked.sh"), 1_600_000_000, 1_600_000_001);
    await git(created.path, "update-index", "--split-index");
    const indexSha256 = sha256(await indexBytes(created.path));
    const status = await git(created.path, "status", "--porcelain=v1", "-z");
    const staged = await git(created.path, "diff", "--cached", "--binary");
    const unstaged = await git(created.path, "diff", "--binary");
    const removed = await retire(created, head, branchHead, indexSha256);
    expect(removed.removed).toBe(true);
    await expect(fs.lstat(created.path)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await git(repo, "rev-parse", created.branch)).toBe(branchHead);
    expect(removed.recoveryRetainedUntil).toBeGreaterThan(Date.now());
    // The independent snapshot must keep index-only objects alive after losing the retained checkout.
    await discardRecovery(removed.recoveryPath!);
    await git(repo, "prune", "--expire=now");
    expect(await git(repo, "cat-file", "-p", stagedBlob)).toBe("only reachable from index");
    const restored = await service.restore({ id: created.id });
    expect(await git(restored.path, "rev-parse", "HEAD")).toBe(head);
    expect(await git(restored.path, "status", "--porcelain=v1", "-z")).toBe(status);
    expect(await git(restored.path, "diff", "--cached", "--binary")).toBe(staged);
    expect(await git(restored.path, "diff", "--binary")).toBe(unstaged);
    expect(
      await exec("git", ["-C", restored.path, "symbolic-ref", "-q", "HEAD"]).catch(() => null),
    ).toBeNull();
    expect(await git(repo, "rev-parse", restored.branch)).toBe(branchHead);
    expect(sha256(await indexBytes(restored.path))).toBe(indexSha256);
    await expectMissingFiles(restored.path, "missing-parent", "cache.tmp");
    if (process.platform !== "win32") {
      expect((await fs.stat(path.join(restored.path, "untracked.sh"))).mode & 0o777).toBe(0o751);
      expect((await fs.stat(path.join(restored.path, "saved.secret"))).mode & 0o777).toBe(0o600);
      expect(await fs.readlink(path.join(restored.path, "readme-link"))).toBe("README.md");
    }
    expect((await fs.stat(path.join(restored.path, "untracked.sh"))).mtimeMs).toBe(
      1_600_000_001_000,
    );
    await expectFiles(restored.path, {
      "saved.secret": "saved ignored bytes\n",
      "raw.txt": "raw LF bytes\n",
      "encoded.utf16": Buffer.from([0x78, 0]),
    });
    expect(restored.snapshotRef).toBe(removed.snapshotRef);
    expect(await git(repo, "rev-parse", `${removed.snapshotRef}^{commit}`)).toMatch(
      /^[a-f0-9]{40}$/u,
    );
  });
  it("retains resolve-undo and cache-tree objects without the original index", async () => {
    await git(repo, "commit", "--allow-empty", "-m", "recorded branch tip");
    const record = await fixture("resolve-undo");
    const branchHead = await git(record.path, "rev-parse", "HEAD");
    await git(record.path, "checkout", "--detach", "HEAD~1");
    const head = await git(record.path, "rev-parse", "HEAD");
    await fs.writeFile(path.join(record.path, "README.md"), "ours-only\n");
    await git(record.path, "add", "README.md");
    const ours = await git(record.path, "rev-parse", ":README.md");
    const oursTree = await git(record.path, "write-tree");
    await fs.writeFile(path.join(record.path, "README.md"), "theirs-only\n");
    await git(record.path, "add", "README.md");
    const theirs = await git(record.path, "rev-parse", ":README.md");
    const theirsTree = await git(record.path, "write-tree");
    await git(record.path, "read-tree", oursTree);
    await git(record.path, "read-tree", "-m", "-i", "HEAD", oursTree, theirsTree);
    await fs.writeFile(path.join(record.path, "README.md"), "resolved\n");
    await git(record.path, "add", "README.md");
    const cacheTree = await git(record.path, "write-tree");
    await git(record.path, "update-index", "--index-version=4");
    expect(await git(record.path, "ls-files", "--resolve-undo")).toContain(ours);
    const index = await indexBytes(record.path);
    const result = await retire(record, head, branchHead, sha256(index));
    await discardRecovery(result.recoveryPath!);
    await git(repo, "prune", "--expire=now");
    expect(await git(repo, "cat-file", "-p", ours)).toBe("ours-only");
    expect(await git(repo, "cat-file", "-p", theirs)).toBe("theirs-only");
    expect(await git(repo, "cat-file", "-t", cacheTree)).toBe("tree");
    const restored = await service.restore({ id: record.id });
    expect(await indexBytes(restored.path)).toEqual(index);
    await git(restored.path, "checkout", "-m", "README.md");
    expect(await git(restored.path, "ls-files", "--unmerged")).toContain(ours);
    expect(await git(restored.path, "ls-files", "--unmerged")).toContain(theirs);
    expect(await fs.readFile(path.join(restored.path, "README.md"), "utf8")).toContain("<<<<<<<");
  });
  it("refuses a fallback parent swapped to a symlink before publication", async () => {
    const { created } = await retiredFixture("parent-swap", async (checkout) => {
      await writeFiles(checkout, { "nested/child.txt": "captured bytes\n" });
    });
    const outside = path.join(stateDir, "outside");
    await fs.mkdir(outside);
    const temporaryName = createHash("sha256")
      .update(Buffer.from("nested/child.txt").toString("hex"))
      .digest("hex");
    const assertSwapped = afterRestoreFile(async () => {
      await fs.rename(
        path.join(created.path, "nested"),
        path.join(created.path, "original-nested"),
      );
      await fs.symlink(outside, path.join(created.path, "nested"), "dir");
    }, temporaryName);
    await expect(service.restore({ id: created.id })).rejects.toThrow(
      /changed|directory|unexpected/i,
    );
    assertSwapped();
    expect(await fs.readdir(outside)).toEqual([]);
  });
  it.each([false, true])(
    "rejects a replaced captured-missing parent (symlink=%s)",
    async (symlink) => {
      const { created, retired } = await retiredFixture("missing-parent", async (checkout) => {
        await writeFiles(checkout, { "missing-parent/staged.txt": "index only\n" });
        await git(checkout, "add", "missing-parent");
        await fs.rm(path.join(checkout, "missing-parent"), { recursive: true });
      });
      const outside = path.join(stateDir, "outside-parent");
      await fs.mkdir(outside);
      const target = path.join(created.path, "missing-parent");
      const assertInjected = afterRestoreFile(() => {
        if (symlink) {
          fsSync.symlinkSync(outside, target, process.platform === "win32" ? "junction" : "dir");
        } else {
          fsSync.writeFileSync(target, "concurrent bytes\n");
        }
      });
      await expect(service.restore({ id: created.id })).rejects.toThrow(
        /non-directory parent|ENOTDIR/i,
      );
      assertInjected();
      expect(await fs.readdir(outside)).toEqual([]);
      if (symlink) {
        expect(await fs.realpath(target)).toBe(await fs.realpath(outside));
      } else {
        expect(await fs.readFile(target, "utf8")).toBe("concurrent bytes\n");
      }
      expect(await git(repo, "rev-parse", retired.snapshotRef!)).toBeTruthy();
    },
  );

  it("does not apply restored metadata through an outside hard-link alias", async () => {
    const { created } = await retiredFixture("hardlink");
    const outside = path.join(stateDir, "outside-alias");
    const target = path.join(created.path, "README.md");
    const link = fsSync.linkSync;
    let linked = false;
    let originalMode = 0;
    let originalMtime = 0;
    vi.spyOn(fsSync, "linkSync").mockImplementation((...args) => {
      link(...args);
      if (!linked && String(args[1]) === target) {
        linked = true;
        link(target, outside);
        const observed = fsSync.statSync(outside);
        originalMode = observed.mode;
        originalMtime = observed.mtimeMs;
      }
    });
    await expect(service.restore({ id: created.id })).rejects.toThrow(/hard.link|shared.*inode/i);
    expect(linked).toBe(true);
    const final = await fs.stat(outside);
    expect(final.mode).toBe(originalMode);
    expect(final.mtimeMs).toBe(originalMtime);
  });

  it("reads raw high-bit Git snapshot names without treating them as traversal", async () => {
    const { retired, head } = await retiredFixture("raw-path");
    const snapshot = await git(repo, "rev-parse", retired.snapshotRef!);
    const snapshotTree = await git(repo, "rev-parse", snapshot + "^{tree}");
    const metadata = JSON.parse(await git(repo, "show", snapshot + "^2:manifest.json"));
    const manifestFile = path.join(stateDir, "raw-manifest.json");
    const commitTree = (tree: string, ...parents: string[]) =>
      git(repo, "commit-tree", tree, ...parents.flatMap((oid) => ["-p", oid]), "-m", "fixture");
    for (const raw of ["aeae", "2e2e", "2e676974"]) {
      metadata.files[0].path = raw;
      await fs.writeFile(manifestFile, JSON.stringify(metadata));
      const blob = await git(repo, "hash-object", "-w", manifestFile);
      const tree = spawnSync("git", ["-C", repo, "mktree"], {
        input: `100644 blob ${blob}\tmanifest.json\n`,
        encoding: "utf8",
      });
      expect(tree.status).toBe(0);
      const manifest = await commitTree(tree.stdout.trim(), head);
      const candidate = await commitTree(snapshotTree, head, manifest);
      const decoded = readExactStateSnapshot(repo, candidate, retired.snapshotRef!, undefined);
      if (raw === "aeae") {
        expect((await decoded)?.files[0]?.path).toBe(raw);
      } else {
        await expect(decoded).rejects.toThrow("Invalid path in exact-state snapshot");
      }
    }
  });
});
