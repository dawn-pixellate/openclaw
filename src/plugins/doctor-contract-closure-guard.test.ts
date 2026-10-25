// Doctor contract closure guard tests keep enumeration paths dependency-light.
import fs from "node:fs";
import path from "node:path";
import * as ts from "typescript/ast";
import { afterAll, describe, expect, it } from "vitest";
import { createNativeTypeScriptParser } from "../../scripts/lib/native-typescript.mts";
import { toLine, visitModuleSpecifiers } from "../../scripts/lib/ts-guard-utils.mts";
import { resolvePluginDoctorContractArtifact } from "./doctor-contract-artifact.js";
import { loadBundledPluginManifestRegistry } from "./manifest-registry-build.js";

const REPO_ROOT = path.resolve(import.meta.dirname, "../..");
const parser = createNativeTypeScriptParser();
afterAll(() => parser.close());
const SOURCE_MODULE_EXTENSIONS = [".ts", ".mts", ".cts", ".js", ".mjs", ".cjs"] as const;
const FORBIDDEN_SPECIFIER = "openclaw/plugin-sdk/agent-runtime";
type ClosureKind = "doctor-contract" | "legacy-setup";
// Doctor enumeration must stay dependency-light. Legacy setup also forbids the second group.
const FORBIDDEN_SPECIFIER_RULES = new Map([
  ...[
    "matrix-js-sdk/lib/matrix.js",
    "openclaw/plugin-sdk/provider-model-shared",
    "openclaw/plugin-sdk/acp-runtime",
    "openclaw/plugin-sdk/conversation-runtime",
    "openclaw/plugin-sdk/provider-auth",
    "openclaw/plugin-sdk/channel-secret-basic-runtime",
    "openclaw/plugin-sdk/plugin-state-store-runtime",
    "openclaw/plugin-sdk/session-store-runtime",
    "openclaw/plugin-sdk/channel-outbound",
    "openclaw/plugin-sdk/memory-core-host-engine-schema",
  ].map((specifier) => [specifier, false] as const),
  ...[
    FORBIDDEN_SPECIFIER,
    "openclaw/plugin-sdk/doctor-repair-runtime",
    "openclaw/plugin-sdk/runtime-doctor",
    "openclaw/plugin-sdk/ssrf-runtime",
    "openclaw/plugin-sdk/logging-core",
    "openclaw/plugin-sdk/realtime-voice",
    "openclaw/plugin-sdk/memory-host-core",
  ].map((specifier) => [specifier, true] as const),
]);
const LEGACY_SETUP_PROPERTIES = new Set([
  "legacyStateMigrations",
  "legacySessionSurface",
  "legacySessionSurfaces",
]);

type ClosureEntry = {
  pluginId: string;
  pluginRoot: string;
  entryPath: string;
  kind: ClosureKind;
};

type ModuleReference = { kind: string; line: number; specifier: string };

function formatRepoPath(filePath: string): string {
  return path.relative(REPO_ROOT, filePath).split(path.sep).join("/");
}

function isInsideRoot(rootPath: string, filePath: string): boolean {
  const relativePath = path.relative(rootPath, filePath);
  return !relativePath.startsWith(`..${path.sep}`) && !path.isAbsolute(relativePath);
}

function resolveRelativeSourceModule(importerPath: string, specifier: string): string | null {
  const targetPath = path.resolve(path.dirname(importerPath), specifier);
  const targetExtension = path.extname(targetPath);
  const candidates = SOURCE_MODULE_EXTENSIONS.some((extension) => extension === targetExtension)
    ? SOURCE_MODULE_EXTENSIONS.map(
        (extension) => `${targetPath.slice(0, -targetExtension.length)}${extension}`,
      )
    : !targetExtension
      ? SOURCE_MODULE_EXTENSIONS.flatMap((extension) => [
          `${targetPath}${extension}`,
          path.join(targetPath, `index${extension}`),
        ])
      : [];
  return candidates.find((candidate) => fs.existsSync(candidate)) ?? null;
}

function propertyNameText(name: ts.PropertyName): string | null {
  return ts.isIdentifier(name) || ts.isStringLiteralLikeNode(name) ? name.text : null;
}

function collectLegacySetupSpecifiers(setupEntryPath: string): string[] {
  const source = fs.readFileSync(setupEntryPath, "utf8");
  const sourceFile = parser.parseSourceFile(setupEntryPath, source);
  const specifiers = new Set<string>();

  const visit = (node: ts.Node) => {
    if (
      ts.isPropertyAssignment(node) &&
      LEGACY_SETUP_PROPERTIES.has(propertyNameText(node.name) ?? "") &&
      ts.isObjectLiteralExpression(node.initializer)
    ) {
      for (const property of node.initializer.properties) {
        if (
          ts.isPropertyAssignment(property) &&
          propertyNameText(property.name) === "specifier" &&
          ts.isStringLiteralLikeNode(property.initializer)
        ) {
          specifiers.add(property.initializer.text);
        }
      }
    }
    node.forEachChild(visit);
  };
  visit(sourceFile);
  return [...specifiers].toSorted();
}

function hasStaticValue(node: ts.Node): boolean {
  if (ts.isImportDeclaration(node)) {
    const clause = node.importClause;
    const bindings = clause?.namedBindings;
    return Boolean(
      !clause ||
      (clause.phaseModifier !== ts.SyntaxKind.TypeKeyword &&
        (clause.name ||
          (bindings &&
            (ts.isNamespaceImport(bindings) ||
              bindings.elements.some((element) => !element.isTypeOnly))))),
    );
  }
  if (ts.isExportDeclaration(node)) {
    const clause = node.exportClause;
    return (
      !node.isTypeOnly &&
      (!clause ||
        ts.isNamespaceExport(clause) ||
        clause.elements.some((element) => !element.isTypeOnly))
    );
  }
  return ts.isImportEqualsDeclaration(node) && !node.isTypeOnly;
}

function collectStaticValueReferences(filePath: string, source: string): ModuleReference[] {
  const sourceFile = parser.parseSourceFile(filePath, source);
  const references: ModuleReference[] = [];
  visitModuleSpecifiers(
    sourceFile,
    ({ kind, node, specifier, specifierNode }) => {
      if (hasStaticValue(node)) {
        references.push({ kind, line: toLine(sourceFile, specifierNode), specifier });
      }
    },
    { includeCommonJs: true },
  );
  return references;
}

const referencesByFile = new Map<string, ModuleReference[]>();
function fileReferences(filePath: string) {
  let references = referencesByFile.get(filePath);
  if (!references) {
    references = collectStaticValueReferences(filePath, fs.readFileSync(filePath, "utf8"));
    referencesByFile.set(filePath, references);
  }
  return references;
}

function collectClosureEntries(): ClosureEntry[] {
  const entries: ClosureEntry[] = [];
  const env = {
    ...process.env,
    OPENCLAW_BUNDLED_PLUGINS_DIR: path.join(REPO_ROOT, "extensions"),
  };
  for (const record of loadBundledPluginManifestRegistry({ env }).plugins) {
    const pluginRoot = path.resolve(record.rootDir);
    const doctorContractPath = resolvePluginDoctorContractArtifact({
      ...record,
      rootDir: pluginRoot,
      sourcePreferred: true,
    })?.modulePath;
    // A declaration listing no surface gates the artifact off every enumeration
    // path, exactly as `resolvePluginDoctorContracts` does, so its closure cost
    // is never paid. Absent declarations still load eagerly and are enforced.
    const declaresAnyDoctorSurface =
      !record.doctorContract ||
      Object.values(record.doctorContract).some((value) => value ?? false);
    if (doctorContractPath && declaresAnyDoctorSurface) {
      entries.push({
        pluginId: record.id,
        pluginRoot,
        entryPath: doctorContractPath,
        kind: "doctor-contract",
      });
    }

    if (record.channels.length === 0) {
      continue;
    }
    const packageJsonPath = path.join(pluginRoot, "package.json");
    if (!fs.existsSync(packageJsonPath)) {
      continue;
    }
    const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf8")) as {
      openclaw?: { setupEntry?: unknown };
    };
    const setupEntry = packageJson.openclaw?.setupEntry;
    if (typeof setupEntry !== "string") {
      continue;
    }
    const setupEntryPath = path.resolve(pluginRoot, setupEntry);
    for (const specifier of collectLegacySetupSpecifiers(setupEntryPath)) {
      const entryPath = resolveRelativeSourceModule(setupEntryPath, specifier);
      if (entryPath && isInsideRoot(pluginRoot, entryPath)) {
        entries.push({ pluginId: record.id, pluginRoot, entryPath, kind: "legacy-setup" });
      }
    }
  }
  return entries;
}

function inspectRelativeClosure(
  entryPath: string,
  root: string,
  inspect: (filePath: string, reference: ModuleReference) => string | undefined,
  followSdk = false,
  visited = new Set<string>(),
): string[] {
  const violations: string[] = [];
  const pending = [entryPath];

  while (pending.length > 0) {
    const filePath = pending.pop();
    if (!filePath || visited.has(filePath)) {
      continue;
    }
    visited.add(filePath);
    for (const reference of fileReferences(filePath)) {
      const violation = inspect(filePath, reference);
      if (violation) {
        violations.push(violation);
        continue;
      }
      const specifier = reference.specifier;
      const sdk = "openclaw/plugin-sdk/";
      const resolvedPath = specifier.startsWith(".")
        ? resolveRelativeSourceModule(filePath, specifier)
        : followSdk && specifier.startsWith(sdk)
          ? resolveRelativeSourceModule(
              path.join(REPO_ROOT, "src/plugin-sdk/entrypoint-anchor.ts"),
              `./${specifier.slice(sdk.length)}`,
            )
          : null;
      if (resolvedPath && isInsideRoot(root, resolvedPath)) {
        pending.push(resolvedPath);
      }
    }
  }

  return violations;
}

function collectForbiddenClosureImports(entry: ClosureEntry): string[] {
  return inspectRelativeClosure(entry.entryPath, entry.pluginRoot, (filePath, reference) => {
    const legacyToo = FORBIDDEN_SPECIFIER_RULES.get(reference.specifier);
    return legacyToo !== undefined && (entry.kind === "doctor-contract" || legacyToo)
      ? `${entry.pluginId}: ${formatRepoPath(filePath)}:${reference.line} imports ${reference.specifier}; use a focused subpath or defer the import until migration`
      : undefined;
  });
}

function collectHeavyRuntimeDoctorMigrationImports(): string[] {
  const entryPath = path.join(REPO_ROOT, "src/plugin-sdk/runtime-doctor-migrations.ts");
  const forbiddenPrefixes = ["src/plugin-state/plugin-state-store", "src/state/openclaw-state-db"];
  return inspectRelativeClosure(entryPath, REPO_ROOT, (filePath, reference) => {
    const resolvedPath = resolveRelativeSourceModule(filePath, reference.specifier);
    const repoPath =
      resolvedPath && isInsideRoot(REPO_ROOT, resolvedPath)
        ? formatRepoPath(resolvedPath)
        : undefined;
    return repoPath && forbiddenPrefixes.some((prefix) => repoPath.startsWith(prefix))
      ? `${formatRepoPath(filePath)}:${reference.line} reaches heavy doctor dependency ${repoPath}`
      : undefined;
  });
}

describe("doctor contract import closures", () => {
  it("classifies only static value module edges", () => {
    const source = [
      `import type { A } from "${FORBIDDEN_SPECIFIER}";`,
      `import { type B } from "${FORBIDDEN_SPECIFIER}";`,
      `export type { C } from "${FORBIDDEN_SPECIFIER}";`,
      `export { type D } from "${FORBIDDEN_SPECIFIER}";`,
      `type E = import("${FORBIDDEN_SPECIFIER}").E;`,
      `const lazy = () => import("${FORBIDDEN_SPECIFIER}");`,
      `import { type F, value } from "${FORBIDDEN_SPECIFIER}";`,
      `export { type G, otherValue } from "${FORBIDDEN_SPECIFIER}";`,
    ].join("\n");

    expect(collectStaticValueReferences("fixture.ts", source)).toEqual([
      { kind: "import", line: 7, specifier: FORBIDDEN_SPECIFIER },
      { kind: "export", line: 8, specifier: FORBIDDEN_SPECIFIER },
    ]);
  });

  it("keeps broad agent runtime and heavy doctor barrels off doctor enumeration paths", () => {
    const violations = collectClosureEntries().flatMap(collectForbiddenClosureImports).toSorted();
    expect(violations).toStrictEqual([]);
  });

  it("keeps the runtime doctor migration helper off state DB and plugin-state graphs", () => {
    expect(collectHeavyRuntimeDoctorMigrationImports()).toStrictEqual([]);
  });

  it("keeps kysely statically unreachable from every plugin closure", () => {
    // All roots share the same repository boundary, so inspect each module once.
    const visited = new Set<string>();
    const violations = collectClosureEntries().flatMap((entry) =>
      inspectRelativeClosure(
        entry.entryPath,
        REPO_ROOT,
        (filePath, { specifier, line }) =>
          specifier === "kysely" || specifier.startsWith("kysely/")
            ? `${entry.pluginId}: ${formatRepoPath(filePath)}:${line} imports ${specifier}`
            : undefined,
        true,
        visited,
      ),
    );
    expect(violations).toStrictEqual([]);
  });
});
