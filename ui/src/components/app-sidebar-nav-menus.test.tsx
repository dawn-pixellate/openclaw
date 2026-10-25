import { createSignal } from "solid-js";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { i18n } from "../i18n/index.ts";
import { de } from "../i18n/locales/de.ts";
import { setupSidebarTest } from "../test-helpers/app-sidebar-setup.ts";
import {
  createGateway,
  createGatewayHarness,
  createSessions,
  mountSidebar,
} from "../test-helpers/app-sidebar.ts";
import {
  createGatewayRequestMock,
  createTestGatewayClient,
} from "../test-helpers/gateway-client.ts";
import { mountSolid as render } from "../test-helpers/mount-solid.ts";
import { flush, waitForSolid } from "../test-helpers/solid-settle.ts";
import { renderSidebarAgentMenu as AgentMenu } from "./app-sidebar-agent-menu.tsx";
import { SidebarDropdown, type SidebarDropdownProps } from "./app-sidebar-dropdown.tsx";
import { renderSidebarSessionSectionHeader as SectionHeader } from "./app-sidebar-session-section-header.tsx";
import { getAppSidebarOwner } from "./app-sidebar.tsx";

it("updates retained agent creation menu labels when the locale changes", async () => {
  await i18n.setLocale("en");
  onTestFinished(async () => {
    await i18n.setLocale("en");
    i18n.registerTranslation("de", de);
  });
  // This new action does not have a foreign catalog translation yet.
  i18n.registerTranslation("de", {
    ...de,
    agentChip: { createAgent: "Neuen Agenten erstellen" },
  });
  const view = render(() => (
    <AgentMenu
      activeId="main"
      agents={[]}
      identities={new Map()}
      openMode="click"
      position={{ x: 12, top: 30 }}
      basePath=""
      rosterMode={false}
      creationDisabledReason={null}
      resolveAvatarUrl={(url) => url}
      avatarErrorHandler={() => vi.fn()}
      agentUnreadCount={() => 0}
      onShowAllAgents={vi.fn()}
      onCreateAgent={vi.fn()}
      onPointerEnter={vi.fn()}
      onPointerLeave={vi.fn()}
      onAfterShow={vi.fn()}
      onSwitchAgent={vi.fn()}
      onClose={vi.fn()}
      onNavigate={vi.fn()}
    />
  ));
  flush();
  const menu = view.getByRole("menu", { hidden: true });
  const row = view.getByRole("menuitem", { name: "Create new agent", hidden: true });
  expect(row.getAttribute("data-value")).toBe("command:new-agent");

  await i18n.setLocale("de");
  await waitForSolid(() => {
    expect(row.getAttribute("aria-label")).toBe("Neuen Agenten erstellen");
    expect(row.textContent?.trim()).toBe("Neuen Agenten erstellen");
    expect(menu.querySelector('[data-value="command:new-agent"]')).toBe(row);
  });
  expect(view.getByRole("menu", { hidden: true })).toBe(menu);
});

const position = { x: 12, y: 30 };
function dropdown(overrides: Partial<SidebarDropdownProps>) {
  return render(() => (
    <SidebarDropdown
      position={position}
      class="sidebar-menu-test"
      label="Sidebar actions"
      onSelect={vi.fn()}
      onClose={vi.fn()}
      items={[{ id: "customize", label: "Customize" }]}
      {...overrides}
    />
  ));
}

it("uses current section actions while retaining the header", () => {
  const initialToggle = vi.fn();
  const currentToggle = vi.fn();
  const initialContext = vi.fn();
  const currentContext = vi.fn();
  const [current, setCurrent] = createSignal(false);
  const view = render(() => (
    <SectionHeader
      sectionId="work"
      sectionHeaders={new Map()}
      content="Work"
      draggable={false}
      onStartDrag={vi.fn()}
      onFinishDrag={vi.fn()}
      onContextMenu={current() ? currentContext : initialContext}
      status={{
        content: "Expand",
        label: "Expand work",
        expanded: false,
        onToggle: current() ? currentToggle : initialToggle,
      }}
    />
  ));
  const button = view.getByRole("button", { name: "Expand work" });
  const header = button.parentElement!;
  setCurrent(true);
  flush();
  button.click();
  header.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true }));
  expect(currentToggle).toHaveBeenCalledOnce();
  expect(currentContext).toHaveBeenCalledOnce();
  expect(initialToggle).not.toHaveBeenCalled();
  expect(initialContext).not.toHaveBeenCalled();
  expect(view.getByRole("button", { name: "Expand work" })).toBe(button);
});

it("retires sidebar hover callbacks with the mounted menu", async () => {
  const enter = vi.fn();
  const leave = vi.fn();
  const view = dropdown({ onPointerEnter: enter, onPointerLeave: leave });
  const menu = view.getByRole("menu", { hidden: true });
  for (const mounted of [true, false]) {
    if (!mounted) {
      view.unmount();
    }
    menu.dispatchEvent(new Event("pointerenter"));
    menu.dispatchEvent(new Event("pointerleave"));
    expect(enter).toHaveBeenCalledOnce();
    expect(leave).toHaveBeenCalledOnce();
  }
});

it("returns to the durable trigger without consuming native Tab", async () => {
  const anchor = document.createElement("button");
  document.body.append(anchor);
  onTestFinished(() => anchor.remove());
  const close = vi.fn();
  const view = dropdown({ anchor, onClose: close });
  const item = view.getByRole("menuitem", { name: "Customize", hidden: true });
  await waitForSolid(() => expect(document.activeElement).toBe(item));
  const tab = new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true });
  item.dispatchEvent(tab);
  expect(tab.defaultPrevented).toBe(false);
  expect(document.activeElement).toBe(anchor);
  expect(close).toHaveBeenCalledExactlyOnceWith(false);
});

describe("sidebar rail pin menu", () => {
  setupSidebarTest();

  it("keeps personal pinning and navigation usable in an offline session menu", async () => {
    const key = "agent:main:review";
    const gateway = createGatewayHarness(
      createTestGatewayClient((method) => {
        throw new Error(`Unexpected offline request: ${method}`);
      }),
    );
    gateway.publish({ phase: "reconnecting", client: null, hello: null });
    const { sidebar } = await mountSidebar(gateway.gateway, createSessions("main", [key]));
    const pin = vi
      .spyOn(sidebar.sessionOrganizer, "setPersonalSessionPin")
      .mockImplementation(() => {});
    await sidebar.sidebarMenus.preloadMenuRenderer();
    sidebar.sidebarMenus.openSessionMenu(
      sidebar.findSidebarMenuSessionByKey(key)!,
      position.x,
      position.y,
    );
    const action = (value: string) =>
      sidebar.querySelector<HTMLButtonElement>(`[data-value="${value}"]`)!;
    await waitForSolid(() => expect(action("rename")).not.toBeNull());
    expect(action("rename").disabled).toBe(true);
    expect(action("toggle-unread").disabled).toBe(true);
    expect(action("copy-session-link").disabled).toBe(false);
    expect(action("toggle-pin").disabled).toBe(false);
    action("toggle-pin").click();
    await waitForSolid(() => expect(pin).toHaveBeenCalledExactlyOnceWith(key, true));
  });

  it.each([
    ["before", 1, "route:usage"],
    ["after", 1, "route:agents"],
    ["remove", 0, "route:usage"],
    ["remove", 2, "route:agents"],
  ] as const)(
    "closes the rail pin menu before %s dispatch at position %i",
    async (action, index, target) => {
      const entries: readonly [string, string, string] = [
        "route:usage",
        "route:sessions",
        "route:agents",
      ];
      const { sidebar } = await mountSidebar(
        createGateway(createTestGatewayClient(createGatewayRequestMock())),
        createSessions("main", []),
      );
      sidebar.sidebarEntries = entries;
      await sidebar.updateComplete;
      const host = getAppSidebarOwner(sidebar.hostElement)!;
      const menus = sidebar.sidebarMenus;
      await menus.preloadMenuRenderer();
      const trigger = menus.railPins.get(entries[index])!;
      menus.openRailPinMenu(entries[index], "Pinned item", position.x, position.y, trigger);
      const assertClosed = () => {
        expect(menus.triggers.has("railPin")).toBe(false);
      };
      const move = vi
        .spyOn(host.sessionOrganizer, "writeSidebarEntryAt")
        .mockImplementation(assertClosed);
      const remove = vi
        .spyOn(host.sessionOrganizer, "removeSidebarEntry")
        .mockImplementation(assertClosed);
      await waitForSolid(() =>
        expect(sidebar.querySelector(".sidebar-rail-pin-menu")).not.toBeNull(),
      );
      const menu = sidebar.querySelector(".sidebar-rail-pin-menu")!;
      expect(menu.querySelector('[data-value="before"]')?.hasAttribute("disabled")).toBe(
        index === 0,
      );
      expect(menu.querySelector('[data-value="after"]')?.hasAttribute("disabled")).toBe(
        index === 2,
      );
      expect(menus.triggers.get("railPin")).toBe(trigger);
      menu.querySelector<HTMLButtonElement>(`[data-value="${action}"]`)!.click();
      await waitForSolid(() => expect(action === "remove" ? remove : move).toHaveBeenCalledOnce());
      if (action === "remove") {
        expect(remove).toHaveBeenCalledExactlyOnceWith(target);
        expect(move).not.toHaveBeenCalled();
      } else {
        expect(move).toHaveBeenCalledExactlyOnceWith("route:sessions", target, action);
        expect(remove).not.toHaveBeenCalled();
      }
    },
  );
});
