import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readlinkSync,
  readFileSync,
  readdirSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it } from "vitest";
import { restorePrepackArtifacts } from "../scripts/openclaw-postpack.mjs";
import {
  collectSourcePackWorkspaceDependencyErrors,
  resolvePrepackCommandStdio,
  runPrepackCommand,
} from "../scripts/openclaw-prepack.ts";
import { preparePackageDocsMap } from "../scripts/package-docs-map.mjs";
import {
  resolveRuntimeWorkerArgv,
  resolveRuntimeWorkerUrl,
} from "../src/infra/runtime-worker-url.js";
import { WORKER_BUNDLE_ARTIFACT_PATHS } from "../src/shared/worker-bundle-hash.js";
import { resolveTestNodeExecPath } from "../src/test-utils/node-process.js";
import { useAutoCleanupTempDirTracker } from "./helpers/temp-dir.js";
import { toolingTsEntrypoints } from "./scripts/tooling-ts-runtime.test-support.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const testNodeExecPath = resolveTestNodeExecPath();
const validChannelEntry =
  'export default { kind: "bundled-channel-entry", loadChannelPlugin() { return { id: "fixture-channel" }; } };\n';
const parentStore = "node_modules/.pnpm/fixture-parent@1.0.0/node_modules";
const piped: ["ignore", "pipe", "pipe"] = ["ignore", "pipe", "pipe"];
const read = (root: string, name: string) => readFileSync(path.join(root, name), "utf8");
function writeFiles(root: string, files: Record<string, string>) {
  for (const [name, contents] of Object.entries(files)) {
    const destination = path.join(root, name);
    mkdirSync(path.dirname(destination), { recursive: true });
    writeFileSync(destination, contents);
  }
}
function run(
  command: string,
  args: string[],
  cwd: string,
  options: { env?: NodeJS.ProcessEnv; timeout?: number } = {},
) {
  return spawnSync(command, args, { encoding: "utf8", stdio: piped, cwd, ...options });
}

const standaloneBundledChannelSmokeFiles = [
  "scripts/test-built-bundled-channel-entry-smoke.mts",
  "scripts/lib/build-smoke-env.mts",
  "scripts/lib/bundled-plugin-build-entries.mjs",
  "scripts/lib/bundled-plugin-paths.mjs",
  "scripts/lib/optional-bundled-clusters.mjs",
  "scripts/lib/package-root-args.mts",
  "scripts/lib/record-shared.mjs",
  "scripts/lib/root-package-bundled-plugin-excludes.mjs",
  "scripts/process-warning-filter.mts",
  "src/shared/non-packaged-plugin-dirs.ts",
];

function expectAbsent(root: string, ...names: string[]) {
  for (const name of names) {
    expect(existsSync(path.join(root, name)), name).toBe(false);
  }
}

function createBundledChannelSmokeFixture(
  entrySource: string,
  options: { prepared?: boolean } = {},
) {
  const rootDir = tempDirs.make("openclaw-prepack-standalone-smoke-");
  for (const relativePath of standaloneBundledChannelSmokeFiles) {
    const destination = path.join(rootDir, relativePath);
    mkdirSync(path.dirname(destination), { recursive: true });
    copyFileSync(path.join(process.cwd(), relativePath), destination);
  }

  const packageRoot = options.prepared ? rootDir : path.join(rootDir, "package");
  const extensionRoot = path.join(packageRoot, "dist", "extensions", "fixture-channel");
  writeFiles(packageRoot, { "package.json": '{"files":[]}\n' });
  writeFiles(extensionRoot, {
    "package.json": `${JSON.stringify({
      name: "@openclaw/fixture-channel",
      openclaw: { channel: true, extensions: ["./index.ts"] },
    })}\n`,
    "index.js": entrySource,
  });
  const parentRoot = path.join(packageRoot, parentStore, "fixture-parent");
  const siblingRoot = path.join(packageRoot, parentStore, "fixture-sibling");
  writeFiles(parentRoot, {
    "package.json":
      '{"name":"fixture-parent","version":"1.0.0","type":"module","exports":"./index.js"}\n',
    "index.js": 'import { value } from "fixture-sibling"; export const fixtureValue = value;\n',
  });
  writeFiles(siblingRoot, {
    "package.json":
      '{"name":"fixture-sibling","version":"1.0.0","type":"module","exports":"./index.js"}\n',
    "index.js": 'export const value = "fixture-channel";\n',
  });
  const nodeModulesRoot = path.join(packageRoot, "node_modules");
  symlinkSync(
    process.platform === "win32" ? parentRoot : path.relative(nodeModulesRoot, parentRoot),
    path.join(nodeModulesRoot, "fixture-parent"),
    process.platform === "win32" ? "junction" : "dir",
  );

  return {
    rootDir,
    packageRoot,
    dependencyFiles: {
      parent: read(parentRoot, "index.js"),
      sibling: read(siblingRoot, "index.js"),
    },
  };
}

function createPreparedPrepackFixture(entrySource: string) {
  const { rootDir } = createBundledChannelSmokeFixture(entrySource, { prepared: true });
  symlinkSync(
    path.dirname(fileURLToPath(import.meta.resolve("tsx/package.json"))),
    path.join(rootDir, "node_modules/tsx"),
    "junction",
  );
  const workerSourceFiles = Object.fromEntries(
    WORKER_BUNDLE_ARTIFACT_PATHS.map((artifact) => [`dist/worker/${artifact}`, "export {};\n"]),
  ) as Record<string, string>;
  const sourceFiles = {
    "package.json": '{"name":"openclaw","version":"2026.8.1","type":"module","files":["dist"]}\n',
    "CHANGELOG.md": "# Changelog\n\n## 2026.8.1\n- Current release notes with enough detail.\n",
    "docs/page.md": "# Package docs\n",
    "dist/index.js": "export {};\n",
    "dist/control-ui/index.html": "<!doctype html>\n",
    "dist/control-ui/assets/fixture.js.br": "prepared asset fixture\n",
    "dist/control-ui/assets/fixture.js.gz": "prepared asset fixture\n",
    ...workerSourceFiles,
  };
  writeFiles(rootDir, sourceFiles);
  return { rootDir, sourceFiles };
}

function runStandaloneBundledChannelSmoke(entrySource: string) {
  const { dependencyFiles, rootDir, packageRoot } = createBundledChannelSmokeFixture(entrySource);
  const temporaryRoot = path.join(rootDir, "smoke-temp");
  mkdirSync(temporaryRoot);
  writeFileSync(
    path.join(temporaryRoot, "unrelated.txt"),
    "preserve caller-owned temporary sibling\n",
  );
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    TMPDIR: temporaryRoot,
    TMP: temporaryRoot,
    TEMP: temporaryRoot,
  };
  delete env.OPENCLAW_BUNDLED_CHANNEL_SMOKE_INSTALLED_LAYOUT;

  const result = run(
    testNodeExecPath,
    [
      path.join(rootDir, "scripts", "test-built-bundled-channel-entry-smoke.mts"),
      "--package-root",
      packageRoot,
    ],
    rootDir,
    { env },
  );
  return {
    result,
    temporaryEntries: readdirSync(temporaryRoot).toSorted(),
    sentinel: read(temporaryRoot, "unrelated.txt"),
    entrySource: read(packageRoot, "dist/extensions/fixture-channel/index.js"),
    dependencyFiles: {
      parent: read(packageRoot, `${parentStore}/fixture-parent/index.js`),
      sibling: read(packageRoot, `${parentStore}/fixture-sibling/index.js`),
    },
    dependencyLink: {
      target: readlinkSync(path.join(packageRoot, "node_modules/fixture-parent")),
      resolved: realpathSync(path.join(packageRoot, "node_modules/fixture-parent")),
    },
    originalDependencyFiles: dependencyFiles,
  };
}

it("preserves the result and releases its layout for source with outcome=valid", () => {
  const entrySource = `
        import assert from "node:assert/strict";
        import { realpathSync } from "node:fs";
        import { fileURLToPath } from "node:url";
        import { fixtureValue } from "fixture-parent";
          const modulePath = realpathSync(fileURLToPath(import.meta.url)).replaceAll("\\\\", "/");
          assert.ok(modulePath.includes("/node_modules/openclaw/dist/"));
        export default { kind: "bundled-channel-entry", loadChannelPlugin() { return { id: fixtureValue }; } };
      `;
  const observed = runStandaloneBundledChannelSmoke(entrySource);
  const { result } = observed;
  expect([result.error, result.signal, result.status], result.stderr).toEqual([undefined, null, 0]);
  expect(result.stdout).toContain("channel=1");
  expect(result.stdout.match(/\[build-smoke\]/gu)).toHaveLength(1);
  expect(observed).toMatchObject({
    entrySource,
    dependencyFiles: observed.originalDependencyFiles,
    sentinel: "preserve caller-owned temporary sibling\n",
    temporaryEntries: ["unrelated.txt"],
  });
  expect(observed.dependencyLink.target).toContain(".pnpm");
  expect(observed.dependencyLink.resolved).toContain(
    path.join(".pnpm", "fixture-parent@1.0.0", "node_modules", "fixture-parent"),
  );
});

it.each([false, true])(
  "does not mutate an incumbent docs map when smoke is invalid=%s",
  async (invalid) => {
    const { rootDir, sourceFiles } = createPreparedPrepackFixture(
      invalid ? "export default [];\n" : validChannelEntry,
    );
    await preparePackageDocsMap(rootDir);
    const receiptPath = path.join(rootDir, ".artifacts/package-docs-map/receipt.json");
    const receipt = readFileSync(receiptPath, "utf8");
    const ownerUrl = resolveRuntimeWorkerUrl(toolingTsEntrypoints.prepack);
    const result = run(
      testNodeExecPath,
      [
        ...resolveRuntimeWorkerArgv(ownerUrl, testNodeExecPath).slice(0, -1),
        "--input-type=module",
        "--eval",
        `import { preparePrepackArtifacts } from ${JSON.stringify(ownerUrl.href)}; await preparePrepackArtifacts();`,
      ],
      rootDir,
      {
        timeout: 30_000,
        env: {
          ...process.env,
          // The source smoke fixture retains the package's standalone loader contract.
          TSX_TSCONFIG_PATH: path.resolve("tsconfig.json"),
        },
      },
    );

    expect([result.error, result.signal]).toEqual([undefined, null]);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(invalid ? "AssertionError" : "PACKAGE_DOCS_MAP_ACTIVE");
    expectAbsent(rootDir, ".openclaw-lifecycle-pending", "dist/postinstall-inventory.json");
    for (const [name, contents] of Object.entries(sourceFiles)) {
      expect(readFileSync(path.join(rootDir, name), "utf8")).toBe(contents);
    }
    expect(readFileSync(receiptPath, "utf8")).toBe(receipt);
    await restorePrepackArtifacts(rootDir);
    expect(existsSync(receiptPath)).toBe(false);
  },
);

it("prepares existing artifacts without invoking build or updater commands", () => {
  const { rootDir, sourceFiles } = createPreparedPrepackFixture(validChannelEntry);
  writeFiles(rootDir, {
    "package.json": JSON.stringify({
      ...JSON.parse(sourceFiles["package.json"]),
      devDependencies: { "@openclaw/session-url-contract": "workspace:*" },
      scripts: { "build:package": "exit 91", "update:compat:check": "exit 92" },
    }),
  });
  const result = run(
    testNodeExecPath,
    resolveRuntimeWorkerArgv(
      resolveRuntimeWorkerUrl(toolingTsEntrypoints.prepack),
      testNodeExecPath,
    ),
    rootDir,
    {
      timeout: 30_000,
      env: {
        ...process.env,
        TSX_TSCONFIG_PATH: path.resolve("tsconfig.json"),
        OPENCLAW_PREPACK_PREPARED: "1",
      },
    },
  );
  expect([result.error, result.signal, result.status], result.stderr).toEqual([undefined, null, 0]);
});

it("rejects plain source packing unless workspace dependencies are prepared", () => {
  const rootDir = tempDirs.make("openclaw-source-pack-workspace-");
  const aiDir = path.join(rootDir, "packages", "ai");
  const rootPackageJson = {
    dependencies: { "@openclaw/ai": "workspace:*" },
    name: "openclaw-source-pack-regression",
  };
  writeFiles(rootDir, {
    "package.json": `${JSON.stringify(rootPackageJson, null, 2)}\n`,
    "packages/ai/package.json": '{"name":"@openclaw/ai"}\n',
  });
  const errors = (env: NodeJS.ProcessEnv = {}) =>
    collectSourcePackWorkspaceDependencyErrors(rootPackageJson, env);
  expect(errors()).toEqual([
    "plain root packing cannot safely resolve @openclaw/ai from workspace:*: pnpm rewrites the workspace dependency to an exact version without bundling the package",
    "use `node scripts/package-openclaw-for-docker.mjs --allow-unreleased-changelog` for a self-contained source package; official npm release automation prepares and publishes @openclaw/ai separately",
  ]);
  expect(errors({ OPENCLAW_PREPACK_PREPARED: "1" })).toEqual([]);
  const workspaceErrors = (overrides: NodeJS.ProcessEnv = {}) =>
    errors({
      npm_command: "pack",
      OCM_INTERNAL_NPM_BIN: path.join(rootDir, "scripts", "ocm-npm-workspace-deps.mts"),
      OPENCLAW_OCM_WORKSPACE_DEPENDENCY_DIRS: aiDir,
      ...overrides,
    });
  expect(workspaceErrors()).toEqual([]);
  expect(workspaceErrors({ OPENCLAW_OCM_WORKSPACE_DEPENDENCY_DIRS: rootDir })).toHaveLength(2);
  const wrongAdapter = path.join(rootDir, "scripts", "other-npm-wrapper.mjs");
  expect(workspaceErrors({ OCM_INTERNAL_NPM_BIN: wrongAdapter })).toHaveLength(2);
  expect(workspaceErrors({ npm_command: "publish" })).toHaveLength(2);
});

it("keeps prepack child stdout off npm pack JSON stdout", () => {
  const jsonMode = { npm_config_json: "true" };
  expect(resolvePrepackCommandStdio({ stdio: "inherit" }, jsonMode)).toEqual([
    "inherit",
    2,
    "inherit",
  ]);
  expect(resolvePrepackCommandStdio({ stdio: piped }, jsonMode)).toEqual([
    "ignore",
    "pipe",
    "pipe",
  ]);
});

it("bounds commands that ignore termination", () => {
  const startedAt = Date.now();
  const result = runPrepackCommand(
    testNodeExecPath,
    ["--eval", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);"],
    { stdio: piped, timeout: 100 },
  );

  expect(result.error).toBeInstanceOf(Error);
  expect(Date.now() - startedAt).toBeLessThan(2500);
});
