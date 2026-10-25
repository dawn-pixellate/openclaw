import { writeFile } from "node:fs/promises";
import path from "node:path";
import type { Locator, Page, Route } from "playwright";
import { expect, it } from "vitest";
import { takeControlUiScreenshotFrame } from "../test-helpers/control-ui-e2e-screenshot.ts";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { seedChatSettings } from "./chat-layout-fixtures.test-support.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";
import { themeConfigResponse } from "./theme-typography.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Control UI avatar geometry" });
const photo =
  '<svg xmlns="http://www.w3.org/2000/svg" width="80" height="48"><rect width="80" height="48" fill="#388c88"/><circle cx="40" cy="24" r="14" fill="#f8d2a4"/></svg>';
const profile = {
  id: "11111111-1111-4111-8111-111111111111",
  displayName: "Alex Morgan",
  avatarMime: null,
  mergedInto: null,
  createdAt: 1,
  updatedAt: 2,
  emails: ["alex@example.test"],
  githubIdentity: null,
  hasAvatar: false,
};

async function measure(avatar: Locator) {
  return avatar.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    const radius = style.borderTopLeftRadius;
    return {
      width: rect.width,
      height: rect.height,
      circular: radius.endsWith("%")
        ? Number.parseFloat(radius) >= 50
        : Number.parseFloat(radius) >= Math.min(rect.width, rect.height) / 2,
      radius,
      outline: style.outlineColor,
      outlineWidth: style.outlineWidth,
      background: style.backgroundColor,
    };
  });
}

async function capture(page: Page, name: string, target: Locator) {
  if (process.env.OPENCLAW_CAPTURE_UI_PROOF !== "1") {
    return;
  }
  const frame = await takeControlUiScreenshotFrame(page, target, [target], {
    animations: "disabled",
    elements: [target],
    scrollTo: target,
  });
  await writeFile(path.join(suite.artifactDir, `${name}.png`), frame.png);
  await writeFile(path.join(suite.artifactDir, `${name}-crop.png`), frame.elements[0]!.png);
}

function expectCircle(value: Awaited<ReturnType<typeof measure>>, label: string) {
  expect.soft(value.width, `${label}: visible`).toBeGreaterThan(0);
  expect.soft(Math.abs(value.width - value.height), `${label}: square`).toBeLessThanOrEqual(1);
  expect.soft(value.circular, `${label}: circular`).toBe(true);
}

suite.define(() => {
  it.each([
    ["claw", "dark", "dark"],
    ["claw", "light", "light"],
    ["crt", "dark", "crt"],
  ] as const)(
    "keeps user image, loading and fallback frames circular in %s %s",
    async (theme, mode, resolved) => {
      await suite.withPage(
        { viewport: { width: 1440, height: 900 }, colorScheme: mode },
        async ({ page }) => {
          await seedChatSettings(page, suite.server.baseUrl, { theme, themeMode: mode });
          const pending: Route[] = [];
          await page.route("**/api/users/photo/avatar*", (route) =>
            route.fulfill({ body: photo, contentType: "image/svg+xml" }),
          );
          await page.route("**/api/users/failed/avatar*", (route) => {
            pending.push(route);
          });
          await installMockGateway(page, {
            agentModel: "example/demo-model",
            models: [
              { id: "demo-model", name: "Demo model", provider: "example", contextWindow: 128000 },
            ],
            sessions: [
              {
                key: "agent:main:main",
                kind: "global",
                model: "demo-model",
                modelProvider: "example",
              },
            ],
            presenceUsers: [
              {
                id: profile.id,
                identity: { type: "profile", id: profile.id },
                self: true,
                name: profile.displayName,
                watchedSessions: ["agent:main:main"],
              },
              {
                id: "photo",
                identity: { type: "profile", id: "photo" },
                name: "Photo Person",
                avatarUrl: "/api/users/photo/avatar",
                watchedSessions: ["agent:main:main"],
              },
            ],
            methodResponses: {
              "config.get": themeConfigResponse(theme, mode),
              "users.self": { profile },
            },
            historyMessages: ["photo", "failed", "initials"].map((id, index) => ({
              role: "user",
              content: [
                {
                  type: "text",
                  text: [
                    "The photo is ready.",
                    "This photo is still loading.",
                    "Initials identify this person.",
                  ][index],
                },
              ],
              timestamp: 1_800_000_000_000 + index * 60_000,
              __openclaw: {
                senderIdentity: { type: "profile", id },
                senderName:
                  id === "initials"
                    ? "Sam Rivera"
                    : id === "photo"
                      ? "Photo Person"
                      : "Pending Person",
                ...(id === "initials" ? {} : { senderProfileAvatarUrl: `/api/users/${id}/avatar` }),
              },
            })),
          });
          await page.goto(`${suite.server.baseUrl}chat`);
          await expect.poll(() => page.locator("html").getAttribute("data-theme")).toBe(resolved);
          if (theme === "crt") {
            await expect
              .poll(() =>
                page
                  .locator("#openclaw-theme-palette-crt")
                  .evaluate((link: HTMLLinkElement) => Boolean(link.sheet)),
              )
              .toBe(true);
          }
          await expect.poll(() => pending.length).toBeGreaterThan(0);
          const slots = page.locator(".chat-group.user .chat-avatar-slot");
          await expect.poll(() => slots.count()).toBe(2);
          await expect.poll(() => slots.first().getAttribute("data-avatar-state")).toBe("loaded");
          const loaded = await measure(slots.first());
          const loading = await measure(slots.nth(1));
          const image = await measure(slots.first().locator("img"));
          const initials = await measure(page.locator('.chat-avatar[aria-label="Sam Rivera"]'));
          const themeEvidence = await page.evaluate(() => ({
            theme: document.documentElement.dataset.theme,
            background: getComputedStyle(document.body).backgroundColor,
            text: getComputedStyle(document.body).color,
            sheets: [...document.querySelectorAll<HTMLLinkElement>('link[rel="stylesheet"]')].map(
              (link) => ({ href: link.href, loaded: Boolean(link.sheet) }),
            ),
          }));
          await capture(page, `${theme}-${mode}-pending`, page.locator(".chat-thread-inner"));
          await Promise.all(
            pending.map((route) => route.fulfill({ status: 404, body: "Missing fixture photo" })),
          );
          await expect.poll(() => slots.nth(1).getAttribute("data-avatar-state")).toBe("failed");
          const fallback = await measure(slots.nth(1));
          const fallbackFace = await measure(slots.nth(1).locator(".chat-avatar:visible"));
          await capture(page, `${theme}-${mode}-fallback`, page.locator(".chat-thread-inner"));
          console.info(
            "avatar geometry",
            JSON.stringify({
              themeEvidence,
              loaded,
              loading,
              image,
              initials,
              fallback,
              fallbackFace,
            }),
          );
          for (const [label, value] of Object.entries({
            loaded,
            loading,
            image,
            initials,
            fallback,
            fallbackFace,
          })) {
            expectCircle(value, label);
          }
          expect.soft(fallback.width).toBe(loading.width);
          expect.soft(fallback.height).toBe(loading.height);
          await page.setViewportSize({ width: 390, height: 844 });
          await capture(page, `${theme}-${mode}-mobile`, page.locator(".chat-thread-inner"));
          const people = page.getByRole("button", { name: "People", exact: true });
          await people.waitFor();
          expectCircle(
            await measure(people.locator(".chat-author-avatar").first()),
            "mobile people grid",
          );
          await people.click();
          const peopleBody = page.locator(".chat-mobile-people");
          await peopleBody.waitFor();
          await capture(page, `${theme}-${mode}-mobile-people`, peopleBody);
          for (const avatar of await peopleBody.locator(".chat-author-avatar:visible").all()) {
            expectCircle(await measure(avatar), "mobile person");
          }
          await page.goto(`${suite.server.baseUrl}settings/profile`);
          const preview = page.locator(".profile-hero__avatar");
          await preview.waitFor();
          await capture(page, `${theme}-${mode}-profile`, preview);
          expectCircle(await measure(preview), "profile preview");
          expectCircle(await measure(preview.locator(".viewer-avatar")), "profile identity");
        },
      );
    },
  );

  it("centers the agent emoji within the picker and profile preview in CRT", async () => {
    await suite.withPage({ viewport: { width: 1440, height: 900 } }, async ({ page }) => {
      await seedChatSettings(page, suite.server.baseUrl, { theme: "crt", themeMode: "dark" });
      await installMockGateway(page, {
        agentModel: "example/demo-model",
        models: [
          { id: "demo-model", name: "Demo model", provider: "example", contextWindow: 128000 },
        ],
        methodResponses: {
          "config.get": themeConfigResponse("crt", "dark"),
          "agents.list": {
            defaultId: "main",
            mainKey: "main",
            scope: "agent",
            agents: [
              { id: "main", name: "Rocket" },
              { id: "writer", name: "Writer" },
            ],
          },
          "agent.identity.get": {
            agentId: "main",
            avatar: "",
            avatarStatus: "none",
            emoji: "🚀",
            name: "Rocket",
          },
        },
      });
      await page.goto(`${suite.server.baseUrl}settings/agents/main/overview`);
      await expect.poll(() => page.locator("html").getAttribute("data-theme")).toBe("crt");
      await expect
        .poll(() =>
          page
            .locator("#openclaw-theme-palette-crt")
            .evaluate((link: HTMLLinkElement) => Boolean(link.sheet)),
        )
        .toBe(true);
      const picker = page.locator(
        ".settings-sidebar__agent .agent-select__trigger .agent-select__avatar",
      );
      const preview = page.locator(".agent-identity-editor__avatar .identity-avatar--agent");
      await picker.locator('.identity-avatar__text[data-avatar="🚀"]').waitFor();
      await capture(page, "crt-agent-picker", picker);
      for (const [label, avatar] of [
        ["picker", picker],
        ["preview", preview],
      ] as const) {
        expectCircle(await measure(avatar), label);
        const offset = await avatar.evaluate((element) => {
          const outer = element.getBoundingClientRect();
          const text = element.querySelector(".identity-avatar__text")!.getBoundingClientRect();
          return {
            x: text.x + text.width / 2 - outer.x - outer.width / 2,
            y: text.y + text.height / 2 - outer.y - outer.height / 2,
          };
        });
        console.info("agent emoji center", { label, offset });
        expect.soft(Math.abs(offset.x), `${label} horizontal center`).toBeLessThanOrEqual(1);
        expect.soft(Math.abs(offset.y), `${label} vertical center`).toBeLessThanOrEqual(1);
      }
      await capture(page, "crt-agent-preview", preview);
      await picker.locator("..").click();
      const option = page.getByRole("menuitemradio", { name: "Rocket", exact: true });
      await option.waitFor();
      expectCircle(await measure(option.locator(".agent-select__avatar")), "picker option");
    });
  });
});
