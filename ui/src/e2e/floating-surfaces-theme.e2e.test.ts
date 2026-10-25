import { writeFile } from "node:fs/promises";
import path from "node:path";
import { webkit, type Browser, type Locator, type Page } from "playwright";
import { expect, it } from "vitest";
import { takeControlUiScreenshotFrame } from "../test-helpers/control-ui-e2e-screenshot.ts";
import {
  controlUiBundledGatewayUrl,
  controlUiE2eWaitTimeoutMs,
  controlUiSessionUrl,
  installMockGateway,
} from "../test-helpers/control-ui-e2e.ts";
import { createControlUiSessionRow } from "../test-helpers/control-ui-session-fixtures.ts";
import { compactCronJobFixture } from "../test-helpers/cron.ts";
import { closeChatDetails, openChatDetails } from "./chat-details.test-support.ts";
import { seedChatSettings } from "./chat-layout-fixtures.test-support.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";
import { readThemedPopupPaint } from "./popup-theme.test-support.ts";
import { sessionPerson } from "./session-ownership-fixtures.test-support.ts";
import { sidebarCronJob } from "./sidebar-customization.test-support.ts";
import { themeConfigResponse } from "./theme-typography.test-support.ts";

const useWebKit = process.env.OPENCLAW_CONTROL_UI_E2E_BROWSER === "webkit";
let webkitBrowser: Browser | undefined;
const suite = createControlUiE2eSuite({
  name: "Floating surface theme roles",
  resources: {
    async run() {
      if (useWebKit) {
        webkitBrowser = await webkit.launch();
      }
    },
    async close() {
      await webkitBrowser?.close();
    },
  },
});
const themes = [
  ["claw", "dark"],
  ["claw", "light"],
  ["absolutely", "dark"],
  ["absolutely", "light"],
  ["crt", "dark"],
  ["beacon", "dark"],
] as const;
const sessionKey = "agent:main:overlay-workspace";
const hoveredKey = "agent:main:overlay-review";

async function capture(page: Page, name: string, surface: Locator, content: Locator[]) {
  if (process.env.OPENCLAW_CAPTURE_UI_PROOF !== "1") {
    return;
  }
  const frame = await takeControlUiScreenshotFrame(page, surface, content, {
    animations: "disabled",
    elements: [surface],
  });
  await writeFile(path.join(suite.artifactDir, `${name}.png`), frame.png);
  await writeFile(path.join(suite.artifactDir, `${name}-crop.png`), frame.elements[0]!.png);
}

async function inspectTheme(page: Page, theme: string, mode: "dark" | "light") {
  const palette = theme === "claw" ? mode : `${theme}${mode === "light" ? "-light" : ""}`;
  await expect.poll(() => page.locator("html").getAttribute("data-theme")).toBe(palette);
  if (theme !== "claw") {
    await expect
      .poll(() =>
        page
          .locator(`#openclaw-theme-palette-${theme}`)
          .evaluate((link) => link instanceof HTMLLinkElement && Boolean(link.sheet)),
      )
      .toBe(true);
  }
  const paint = await page.evaluate(() => {
    const root = document.documentElement;
    const css = getComputedStyle(root);
    return {
      theme: root.dataset.theme,
      mode: root.dataset.themeMode,
      stylesheets: [...document.querySelectorAll<HTMLLinkElement>('link[rel="stylesheet"]')].map(
        (link) => ({ href: link.href, loaded: Boolean(link.sheet) }),
      ),
      text: css.getPropertyValue("--text").trim(),
      popover: css.getPropertyValue("--popover").trim(),
      overlayBorder: css.getPropertyValue("--overlay-border").trim(),
      overlayShadow: css.getPropertyValue("--overlay-shadow").trim(),
      bodyColor: getComputedStyle(document.body).color,
    };
  });
  expect(paint.mode).toBe(mode);
  if (process.env.OPENCLAW_CAPTURE_UI_PROOF === "1") {
    await writeFile(
      path.join(suite.artifactDir, `${theme}-${mode}-palette.json`),
      JSON.stringify(paint, null, 2),
    );
  }
}

suite.define(() => {
  it.each(themes)(
    "uses the %s %s overlay roles without shrinking an empty Inbox",
    async (theme, mode) => {
      const options = {
        colorScheme: mode,
        locale: "en-US",
        reducedMotion: "reduce" as const,
        viewport: { width: 1440, height: 900 },
      };
      const context = useWebKit
        ? await webkitBrowser!.newContext(options)
        : await suite.newBrowserContext(options);
      const page = await context.newPage();
      page.setDefaultTimeout(controlUiE2eWaitTimeoutMs);
      try {
        const actor = sessionPerson("profile-ada", "Ada King");
        const jobs = Array.from({ length: 8 }, (_, index) =>
          sidebarCronJob({
            id: `overlay-job-${index}`,
            name: `Project report ${index + 1}`,
          }),
        );
        await seedChatSettings(page, suite.server.baseUrl, {
          gatewayUrl: controlUiBundledGatewayUrl(suite.server.baseUrl),
          theme,
          themeMode: mode,
        });
        const gateway = await installMockGateway(page, {
          sessionKey,
          agentModel: "example/demo-model",
          models: [
            { id: "demo-model", name: "Demo model", provider: "example", contextWindow: 100000 },
          ],
          sessions: [
            createControlUiSessionRow(sessionKey, "Workspace review", 2, {
              spawnedCwd: "/workspace/harbor",
              model: "demo-model",
              modelProvider: "example",
              createdActor: actor,
              owner: { actor },
              visibility: "shared",
              sharingRole: "owner",
            }),
            createControlUiSessionRow(hoveredKey, "Review the project report", 1, {
              model: "demo-model",
              modelProvider: "example",
              createdActor: actor,
              owner: { actor },
              participants: [{ identity: actor.identity, label: actor.label }],
              participantCount: 1,
            }),
          ],
          historyMessages: [
            {
              role: "assistant",
              content: [{ type: "text", text: "The project report is ready for review." }],
            },
          ],
          presenceUsers: [{ id: actor.id, name: actor.label, self: true }],
          methodResponses: {
            "config.get": themeConfigResponse(theme, mode),
            "cron.list": {
              jobs: jobs.map(compactCronJobFixture),
              snapshotRevision: "overlay-roles",
              total: jobs.length,
              offset: 0,
              limit: 50,
              hasMore: false,
              nextOffset: null,
            },
            "models.authStatus": { ts: 1, providers: [] },
          },
        });
        await page.goto(controlUiSessionUrl(suite.server.baseUrl, sessionKey));
        await page.getByRole("textbox", { name: "Chat composer", exact: true }).waitFor();
        await page
          .getByText("Demo model", { exact: true })
          .filter({ visible: true })
          .first()
          .waitFor();
        await inspectTheme(page, theme, mode);
        const prefix = `${theme}-${mode}`;

        const details = await openChatDetails(page);
        await capture(page, `${prefix}-details`, details, [details]);
        const detailsPaint = await readThemedPopupPaint(details, "surface");
        expect
          .soft(detailsPaint.actual.border, "Details uses the theme's overlay contour")
          .toBe(detailsPaint.expected.border);
        await closeChatDetails(page);

        await page
          .getByRole("button", { name: "Workspace actions for harbor", exact: true })
          .click();
        const workspaceMenu = page
          .locator(".chat-pane__workspace-menu > .oc-menu")
          .filter({ visible: true });
        await workspaceMenu.getByRole("menuitem", { name: "Copy path" }).waitFor();
        await capture(page, `${prefix}-menu`, workspaceMenu, [
          workspaceMenu.getByRole("menuitem", { name: "Copy path" }),
        ]);
        const menuPaint = await readThemedPopupPaint(workspaceMenu, "surface");
        expect
          .soft(menuPaint.actual.border, "Workspace menu uses the theme's overlay contour")
          .toBe(menuPaint.expected.border);
        await page.keyboard.press("Escape");

        await page.getByRole("button", { name: "Session sharing", exact: true }).click();
        const sharing = page.locator(".chat-pane__sharing-panel").filter({ visible: true });
        await sharing.waitFor();
        await capture(page, `${prefix}-sharing`, sharing, [sharing]);
        const sharingPaint = await readThemedPopupPaint(sharing, "surface");
        expect
          .soft(sharingPaint.actual, "Sharing retains the native overlay paint")
          .toEqual(sharingPaint.expected);
        await page.keyboard.press("Escape");

        const row = page.locator(`.sidebar-recent-session[data-session-key="${hoveredKey}"]`);
        await row.hover();
        const card = page.locator(".session-progress-hovercard");
        const badge = card.locator(".session-hovercard__attribution");
        await badge.waitFor();
        await capture(page, `${prefix}-hovercard`, card, [
          card.locator(".session-hovercard__title"),
          badge,
        ]);
        const cardPaint = await readThemedPopupPaint(card, "surface");
        expect
          .soft(cardPaint.actual.shadow, "Session hovercard follows the theme's overlay elevation")
          .toBe(cardPaint.expected.shadow);
        const badgeAlpha = await badge.evaluate((element) => {
          const color = getComputedStyle(element).backgroundColor;
          const slashAlpha = color.match(/\/\s*([\d.]+)\)/u)?.[1];
          const rgbaAlpha = color.match(/^rgba\([^,]+,[^,]+,[^,]+,\s*([\d.]+)\)/u)?.[1];
          return Number(slashAlpha ?? rgbaAlpha ?? 1);
        });
        expect
          .soft(badgeAlpha, "Attribution tint leaves the hovercard surface visible")
          .toBeGreaterThan(0);
        expect
          .soft(badgeAlpha, "Attribution tint does not create an opaque nested panel")
          .toBeLessThan(0.1);
        await page.getByRole("textbox", { name: "Chat composer", exact: true }).hover();

        await gateway.waitForRequest("cron.list");
        await page.locator(".sidebar-issues-button").click();
        const inbox = page.locator("#sidebar-issues-panel");
        const items = inbox.locator('[data-attention-kind="cronFailed"]');
        await expect.poll(() => items.count()).toBe(jobs.length);
        for (const remaining of [8, 1, 0]) {
          while ((await items.count()) > remaining) {
            const count = await items.count();
            await items.first().locator(".sidebar-issues-panel__dismiss").click();
            await expect.poll(() => items.count()).toBe(count - 1);
          }
          const content = remaining ? items.first() : inbox.locator(".sidebar-issues-panel__empty");
          await content.waitFor();
          await capture(page, `${prefix}-inbox-${remaining}`, inbox, [content]);
          expect
            .soft((await inbox.boundingBox())?.height, `Inbox height with ${remaining} items`)
            .toBe(500);
        }
        const inboxPaint = await readThemedPopupPaint(inbox, "surface");
        expect
          .soft(inboxPaint.actual, "Inbox shares the overlay surface, contour and elevation")
          .toEqual(inboxPaint.expected);
        for (const child of [".sidebar-issues-panel__header", ".sidebar-issues-panel__tabs"]) {
          expect
            .soft(
              await inbox
                .locator(child)
                .evaluate((element) => getComputedStyle(element).backgroundColor),
              child,
            )
            .toBe("rgba(0, 0, 0, 0)");
        }
        await page.setViewportSize({ width: 1440, height: 450 });
        await expect.poll(async () => (await inbox.boundingBox())?.height ?? 500).toBeLessThan(450);
        const clipped = await inbox.boundingBox();
        expect(clipped!.y).toBeGreaterThanOrEqual(0);
        expect(clipped!.y + clipped!.height).toBeLessThanOrEqual(450);
      } finally {
        await (useWebKit ? context.close() : suite.closeBrowserContext(context));
      }
    },
  );
});
