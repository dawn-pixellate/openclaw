import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { withEnvAsync } from "../../test-utils/env.js";
import {
  restoreMockSkillsHomeEnv,
  setMockSkillsHomeEnv,
  type SkillsHomeEnvSnapshot,
} from "../test-support/home-env.test-support.js";
import { createCanonicalFixtureSkill, makeSkill } from "../test-support/test-helpers.js";
import type { SkillEntry } from "../types.js";
import {
  formatSkillsCompactForPrompt as formatSkillsCompact,
  formatSkillsForPromptCore,
  type Skill,
} from "./skill-contract.js";
import { buildSkillSnapshot } from "./workspace-skill-prompt.js";

const buildWorkspaceSkillsPrompt = async (
  workspaceDir: string,
  opts?: Parameters<typeof buildSkillSnapshot>[1],
): Promise<string> => (await buildSkillSnapshot(workspaceDir, opts)).prompt;

function makeEntry(skill: Skill): SkillEntry {
  return {
    skill,
    frontmatter: {},
    exposure: {
      includeInRuntimeRegistry: true,
      includeInAvailableSkillsPrompt: true,
      userInvocable: true,
    },
  };
}

async function buildPrompt(
  skills: Skill[],
  limits: { maxChars?: number; maxCount?: number } = {},
): Promise<string> {
  return buildWorkspaceSkillsPrompt("/fake", {
    entries: skills.map(makeEntry),
    config: {
      skills: {
        limits: {
          maxSkillsPromptChars: limits.maxChars,
          maxSkillsInPrompt: limits.maxCount,
        },
      },
    },
  });
}

function requireIncludedCounts(prompt: string): [included: number, total: number] {
  const match = prompt.match(/included (\d+) of (\d+)/);
  if (!match) {
    throw new Error(`expected included count in prompt: ${prompt}`);
  }
  return [Number(match[1]), Number(match[2])];
}

const COMPACT_OMITTED_NOTICE =
  "⚠️ Skills catalog using compact format (descriptions omitted). Run `openclaw skills check` to audit.";
const COMPACT_SHORTENED_NOTICE =
  "⚠️ Skills catalog using compact format (descriptions shortened). Run `openclaw skills check` to audit.";

describe("applySkillsPromptLimits (via buildWorkspaceSkillsPrompt)", () => {
  let envSnapshot: SkillsHomeEnvSnapshot;

  beforeEach(() => {
    envSnapshot = setMockSkillsHomeEnv("/Users/openclaw-test-user");
  });

  afterEach(() => restoreMockSkillsHomeEnv(envSnapshot));

  it("keeps eligible discovery independent from the prompt budget and hidden skills", async () => {
    const visible = makeSkill("alpha");
    const omitted = makeSkill("zulu");
    const hidden = makeEntry(makeSkill("hidden"));
    hidden.exposure!.includeInAvailableSkillsPrompt = false;
    const snapshot = await buildSkillSnapshot("/fake", {
      entries: [makeEntry(visible), makeEntry(omitted), hidden],
      config: { skills: { limits: { maxSkillsInPrompt: 1 } } },
    });

    expect(snapshot.resolvedSkills).toEqual([visible]);
    expect(snapshot.discoverySkills).toEqual([visible, omitted]);
    expect(snapshot.prompt).toContain("<name>alpha</name>");
    expect(snapshot.prompt).not.toContain("<name>zulu</name>");
    expect(snapshot.prompt).not.toContain("<name>hidden</name>");
    expect(snapshot.skills.map((skill) => skill.name)).toContain("hidden");
  });

  it("tier 2: compact when full exceeds budget but compact fits", async () => {
    const skills = Array.from({ length: 20 }, (_, i) => makeSkill(`skill-${i}`, "A".repeat(800)));
    const fullLen = formatSkillsForPromptCore(skills).length;
    const compactLen = formatSkillsCompact(skills).length;
    const budget = `${COMPACT_SHORTENED_NOTICE}\n${formatSkillsCompact(skills)}`.length;
    expect(fullLen).toBeGreaterThan(budget);
    expect(compactLen).toBeLessThan(budget);
    const prompt = await buildPrompt(skills, { maxChars: budget });
    expect(prompt).toContain("<description>");
    expect(prompt).toContain("compact format (descriptions shortened)");
    expect(prompt).not.toContain("included");
    expect(prompt).toContain("skill-0");
    expect(prompt).toContain("skill-19");
  });

  it("tier 3: compact + binary search when compact also exceeds budget", async () => {
    const skills = Array.from({ length: 100 }, (_, i) => makeSkill(`skill-${i}`, "description"));
    const prompt = await buildPrompt(skills, { maxChars: 2000 });
    expect(prompt.length).toBeLessThanOrEqual(2000);
    expect(prompt).toContain("compact format");
    expect(prompt).toContain("skill-0");
    const [included, total] = requireIncludedCounts(prompt);
    expect(included).toBeLessThan(total);
    expect(total).toBe(skills.length);
    expect(prompt.match(/<skill>/g)?.length ?? 0).toBe(included);
  });

  it("preserves every identity before allocating description budget", async () => {
    const skills = Array.from({ length: 50 }, (_, i) => makeSkill(`skill-${i}`, "A".repeat(800)));
    const identityCatalog = formatSkillsCompact(skills, { descriptionMaxChars: 0 });
    const budget = `${COMPACT_OMITTED_NOTICE}\n${identityCatalog}`.length;
    expect(formatSkillsForPromptCore(skills).length).toBeGreaterThan(budget);

    const prompt = await buildPrompt(skills, { maxChars: budget });

    expect(prompt.length).toBeLessThanOrEqual(budget);
    expect(prompt).toContain(COMPACT_OMITTED_NOTICE);
    expect(prompt).not.toContain("<description>");
    expect(prompt).not.toContain("included");
    expect(prompt).toContain("skill-0");
    expect(prompt).toContain("skill-49");
  });

  it("uses leftover compact budget for descriptions without dropping identities", async () => {
    const skills = Array.from({ length: 8 }, (_, i) => makeSkill(`skill-${i}`, "A".repeat(800)));
    const identityCatalog = formatSkillsCompact(skills, { descriptionMaxChars: 0 });
    const budget = `${COMPACT_OMITTED_NOTICE}\n${identityCatalog}`.length + 500;

    const prompt = await buildPrompt(skills, { maxChars: budget });

    expect(prompt.length).toBeLessThanOrEqual(budget);
    expect(prompt).toContain(COMPACT_SHORTENED_NOTICE);
    expect(prompt).toContain("<description>");
    expect(prompt).not.toContain("included");
    expect(prompt.match(/<skill>/g)).toHaveLength(skills.length);
  });

  it("count truncation + compact: shows included X of Y with compact note", async () => {
    const skills = Array.from({ length: 30 }, (_, i) => makeSkill(`skill-${i}`, "A".repeat(800)));
    const tenSkills = skills.slice(0, 10);
    const fullLen = formatSkillsForPromptCore(tenSkills).length;
    const truncatedNotice =
      "⚠️ Skills truncated: included 10 of 30 (compact format, descriptions shortened). Run `openclaw skills check` to audit.";
    const budget = `${truncatedNotice}\n${formatSkillsCompact(tenSkills)}`.length;
    expect(fullLen).toBeGreaterThan(budget);
    const prompt = await buildPrompt(skills, { maxChars: budget, maxCount: 10 });
    expect(prompt).toContain("included 10 of 30");
    expect(prompt).toContain("compact format, descriptions shortened");
    expect(prompt).toContain("<description>");
  });

  it.each([0, 1, 10, 64])(
    "never exceeds a tiny configured prompt budget of %i",
    async (maxChars) => {
      const prompt = await buildPrompt([makeSkill("only-one", "desc")], { maxChars });

      expect(prompt.length).toBeLessThanOrEqual(maxChars);
      expect(prompt).toBe("");
    },
  );

  it("drops an oversized optional remote note before discarding a complete fitting skill catalog", async () => {
    const skill = makeSkill("weather", "Get weather data");
    const maxChars = formatSkillsForPromptCore([skill]).length;
    const remoteNote = `REMOTE_NOTE_${"x".repeat(maxChars + 512)}`;
    const prompt = await buildWorkspaceSkillsPrompt("/fake", {
      entries: [makeEntry(skill)],
      config: { skills: { limits: { maxSkillsPromptChars: maxChars } } },
      eligibility: {
        remote: {
          platforms: [],
          hasBin: () => false,
          hasAnyBin: () => false,
          note: remoteNote,
        },
      },
    });

    expect(prompt.length).toBeLessThanOrEqual(maxChars);
    expect(prompt).toContain("<name>weather</name>");
    expect(prompt).toContain("</available_skills>");
    expect(prompt).not.toContain("REMOTE_NOTE_");
  });

  it.each(["full", "compact", "count-limited", "empty"])(
    "preserves exact %s catalog bytes at the optional remote-note boundary",
    async (format) => {
      const skill = makeSkill(
        "weather",
        format === "compact" ? "A".repeat(800) : "Get weather data",
      );
      const skills = format === "empty" ? [] : [skill];
      const remoteNote = "Remote node skills are available.";
      const notice =
        format === "compact"
          ? COMPACT_SHORTENED_NOTICE
          : format === "count-limited"
            ? "⚠️ Skills truncated: included 1 of 2. Run `openclaw skills check` to audit."
            : "";
      const catalog =
        format === "compact" ? formatSkillsCompact(skills) : formatSkillsForPromptCore(skills);
      const withoutNote = [notice, catalog].filter(Boolean).join("\n");
      const withNote = [remoteNote, withoutNote].filter(Boolean).join("\n");
      const entries = (format === "count-limited" ? [...skills, makeSkill("zoo")] : skills).map(
        makeEntry,
      );

      for (const delta of [-1, 0, 1]) {
        const prompt = await buildWorkspaceSkillsPrompt("/fake", {
          entries,
          config: {
            skills: {
              limits: { maxSkillsInPrompt: 1, maxSkillsPromptChars: withNote.length + delta },
            },
          },
          eligibility: {
            remote: {
              platforms: ["linux"],
              hasBin: () => false,
              hasAnyBin: () => false,
              note: remoteNote,
            },
          },
        });

        expect(prompt).toBe(delta < 0 ? withoutNote : withNote);
        expect(prompt.length).toBeLessThanOrEqual(withNote.length + delta);
      }
    },
  );

  it("budget check uses compacted home-dir paths, not canonical paths", async () => {
    const home = os.homedir();
    const skills = Array.from({ length: 30 }, (_, i) =>
      makeSkill(
        `skill-${i}`,
        "A".repeat(800),
        `${home}/.openclaw/workspace/skills/skill-${i}/SKILL.md`,
      ),
    );
    const compactedSkills = skills.map((s) => ({
      ...s,
      filePath: s.filePath.replace(home, "~"),
    }));
    const compactedCompactLen = formatSkillsCompact(compactedSkills, {
      descriptionMaxChars: 0,
    }).length;
    const canonicalCompactLen = formatSkillsCompact(skills, { descriptionMaxChars: 0 }).length;
    expect(canonicalCompactLen).toBeGreaterThan(compactedCompactLen);
    const budget =
      Math.floor((compactedCompactLen + canonicalCompactLen) / 2) +
      COMPACT_OMITTED_NOTICE.length +
      1;
    const prompt = await buildPrompt(skills, { maxChars: budget });
    expect(prompt).toContain("skill-0");
    expect(prompt).toContain("skill-29");
    expect(prompt).not.toContain("included");
    expect(prompt).toContain("compact format");
    expect(prompt).toContain("~/");
    expect(prompt).not.toContain(home);
  });

  it("skills are sorted alphabetically regardless of entry insertion order", async () => {
    // Regression: #64167.
    const entries = ["zoo", "apple", "mango", "banana"].map((n) =>
      makeEntry(makeSkill(n, `${n} skill`)),
    );
    const prompt = await buildWorkspaceSkillsPrompt("/fake", {
      entries,
      config: { skills: { limits: { maxSkillsPromptChars: 50_000 } } },
    });
    const nameMatches = [...prompt.matchAll(/<name>(\w+)<\/name>/g)].map((m) => m[1]);
    expect(nameMatches).toEqual(["apple", "banana", "mango", "zoo"]);
  });

  it("resolvedSkills in snapshot keeps canonical paths, not compacted", async () => {
    const home = os.homedir();
    const skills = Array.from({ length: 5 }, (_, i) =>
      makeSkill(`skill-${i}`, "A skill", `${home}/.openclaw/workspace/skills/skill-${i}/SKILL.md`),
    );
    const snapshot = await buildSkillSnapshot("/fake", {
      entries: skills.map(makeEntry),
    });
    expect(snapshot.prompt).toContain("~/");
    expect(snapshot.resolvedSkills).toHaveLength(5);
    for (const skill of snapshot.resolvedSkills ?? []) {
      expect(skill.filePath).toContain(home);
      expect(skill.filePath).not.toMatch(/^~\//);
    }
  });
});

describe("compactSkillPaths", () => {
  const promptAt = (
    workspace: string,
    dir: string,
    name = "test-skill",
    description = "A test skill",
  ) =>
    buildWorkspaceSkillsPrompt(workspace, {
      entries: [
        makeEntry(
          createCanonicalFixtureSkill({
            name,
            description,
            filePath: path.join(dir, "SKILL.md"),
            baseDir: dir,
            source: "test",
          }),
        ),
      ],
    });

  it("refreshes home prefixes for each prompt catalog", async () => {
    for (const name of ["first-home", "second-home"]) {
      const home = path.join(path.parse(os.homedir()).root, "openclaw-compact-test", name);
      const prompt = await withEnvAsync({ HOME: home, OPENCLAW_HOME: undefined }, () =>
        promptAt(home, path.join(home, "skills", "dynamic-home"), "dynamic-home"),
      );
      expect(prompt).toContain("<location>~/skills/dynamic-home/SKILL.md</location>");
      expect(prompt).not.toContain(home);
    }
  });

  it.each(["skills", "plugin-skills"])(
    "does not compact explicit state-root %s paths to OS-home tilde paths",
    async (folder) => {
      const root = path.parse(os.homedir()).root;
      const home = path.join(root, "data");
      const state = path.join(home, ".openclaw");
      const dir = path.join(state, folder, "test-skill");
      const prompt = await withEnvAsync(
        {
          HOME: home,
          OPENCLAW_HOME: home,
          OPENCLAW_STATE_DIR: state,
          OPENCLAW_CONFIG_PATH: path.join(state, "openclaw.json"),
        },
        () => promptAt(path.join(root, "workspace"), dir),
      );
      expect(prompt).toContain(`<location>${path.join(dir, "SKILL.md")}</location>`);
      expect(prompt).not.toContain(`~/.openclaw/${folder}/test-skill/SKILL.md`);
    },
  );

  it("compacts managed skill paths when OS-home tilde reaches the same path", async () => {
    const home = os.homedir();
    const state = path.join(home, ".openclaw");
    const dir = path.join(state, "skills", "test-skill");
    const prompt = await withEnvAsync(
      {
        HOME: home,
        OPENCLAW_STATE_DIR: state,
        OPENCLAW_HOME: undefined,
      },
      () => promptAt(path.join(home, "workspace"), dir),
    );
    expect(prompt).toContain("<location>~/.openclaw/skills/test-skill/SKILL.md</location>");
    expect(prompt).not.toContain(`<location>${path.join(dir, "SKILL.md")}</location>`);
  });

  it("preserves POSIX literal backslashes after home compaction", async () => {
    const home = os.homedir();
    const prompt = await promptAt(home, path.join(home, ".openclaw-test-skills\\literal-skill"));
    const location = prompt.match(/<location>([^<]+)<\/location>/)?.[1];
    expect(location).toContain("~/");
    expect(location).toContain("\\literal-skill");
  });

  it("preserves paths outside home directory", async () => {
    const root = path.join(path.parse(os.homedir()).root, "openclaw-external-skills");
    const dir = path.join(root, "skills", "test-skill");
    const prompt = await promptAt(root, dir);
    expect(prompt).toMatch(/<location>[^<]+SKILL\.md<\/location>/);
    expect(prompt).toContain(path.join(dir, "SKILL.md"));
  });

  it("loads skills when the shared state database is unavailable", async () => {
    const root = fsSync.realpathSync(
      fsSync.mkdtempSync(path.join(os.tmpdir(), "openclaw-skill-load-")),
    );
    const blocker = path.join(root, "state-blocker");
    fsSync.writeFileSync(blocker, "not a directory", "utf8");
    const workspace = path.join(root, "workspace");
    try {
      const prompt = await withEnvAsync({ OPENCLAW_STATE_DIR: path.join(blocker, "state") }, () =>
        promptAt(
          workspace,
          path.join(workspace, "skills", "available-skill"),
          "available-skill",
          "Available despite missing lifecycle state",
        ),
      );
      expect(prompt).toContain("available-skill");
      expect(prompt).toContain("Available despite missing lifecycle state");
    } finally {
      fsSync.rmSync(root, { recursive: true, force: true });
    }
  });
});
