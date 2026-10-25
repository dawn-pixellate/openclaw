/* @vitest-environment jsdom */
import { createRouter, definePage } from "@openclaw/uirouter";
import { afterEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { RouteId } from "../../app-route-paths.ts";
import type { SolidRouteProps } from "../../app-route-types.tsx";
import type { ApplicationContext } from "../../app/context.ts";
import { RouterOutlet } from "../../app/router-outlet.tsx";
import { configSnapshot } from "../../lib/config/config-snapshot.test-support.ts";
import { createRuntimeConfigCapability } from "../../lib/config/runtime-config-capability.ts";
import { ApplicationProvider } from "../../lib/reactive/context.ts";
import { createTestGatewayClient } from "../../test-helpers/gateway-client.ts";
import { gatewayHelloForMethods } from "../../test-helpers/gateway-methods.ts";
import { mountSolid } from "../../test-helpers/mount-solid.ts";
import { waitForSolid } from "../../test-helpers/solid-settle.ts";
import {
  agentsCapability,
  agentsList,
  agentsRouteData,
  completeContext,
  gateway,
  pageContext,
  snapshot,
} from "./agents-page.test-support.ts";
import { AgentsPage } from "./agents-page.tsx";
import * as avatarImage from "./avatar-image.ts";
import type { GeneratedAvatar } from "./avatar-picker.tsx";
import type { AgentsRouteData } from "./route.ts";

afterEach(() => vi.restoreAllMocks());

function routeRequest(handlers: Record<string, (params: unknown) => unknown>) {
  return vi.fn((method: string, params?: unknown) => {
    if (method === "models.list") {
      return { models: [] };
    }
    const handler = handlers[method];
    if (!handler) {
      throw new Error(`Unexpected request: ${method}`);
    }
    return handler(params);
  });
}
function routeContext(request: Parameters<typeof createTestGatewayClient>[0], methods?: string[]) {
  const client = createTestGatewayClient(request);
  const currentGateway = gateway({
    ...snapshot(client),
    ...(methods ? { hello: gatewayHelloForMethods(methods) } : {}),
  });
  const agents = agentsCapability(async () => ({ agentId: "main", workspace: "", files: [] }));
  const context = pageContext(currentGateway, agents);
  completeContext(context);
  return { client, currentGateway, agents, context };
}
function mountRoute(
  context: ApplicationContext,
  panel: AgentsRouteData["panel"] = "overview",
  agentId = "main",
) {
  const routeData = {
    ...agentsRouteData(
      context.gateway,
      context.agents.state.agentsList,
      agentId,
      context.settingsAgentSelection,
    ),
    panel,
  };
  const router = createRouter<
    RouteId,
    ApplicationContext,
    { renderSolid: (props: SolidRouteProps) => ReturnType<typeof AgentsPage> }
  >({
    routes: [
      definePage({
        id: "agents",
        path: "/settings/agents",
        component: () => ({ renderSolid: () => <AgentsPage routeData={routeData} /> }),
      }),
      definePage({
        id: "about",
        path: "/next",
        component: () => ({ renderSolid: () => <section>Destination</section> }),
      }),
    ],
  });
  const routed = { ...context, router };
  const mounted = mountSolid(() => (
    <ApplicationProvider value={routed}>
      <button onClick={() => void router.navigate("about", routed)}>Leave</button>
      <RouterOutlet router={router} retryContext={routed} />
    </ApplicationProvider>
  ));
  const departed = () => {
    expect(mounted.getByText("Destination", { exact: true })).toBeTruthy();
    expect(mounted.container.querySelector("openclaw-agents-page")).toBeNull();
  };
  return {
    ...mounted,
    departed,
    enter: () => router.navigate("agents", routed),
    button: (name: string | RegExp) => mounted.getByRole<HTMLButtonElement>("button", { name }),
    async leave() {
      mounted.getByRole("button", { name: "Leave" }).click();
      await waitForSolid(departed);
    },
    dispose() {
      mounted.unmount();
      router.stop();
    },
  };
}

it.each(["save", "reload"] as const)(
  "leaves a held config %s before it settles",
  async (operation) => {
    const pending = createDeferred();
    const { agents, context } = routeContext(routeRequest({}), ["config.set"]);
    context.runtimeConfig.state.configFormDirty = true;
    const save = vi.fn(() => pending.promise.then(() => true));
    const reload = vi.fn(() => pending.promise);
    Object.assign(context.runtimeConfig, { save, discardDraft: reload });
    const view = mountRoute(context);
    try {
      await view.enter();
      const saveButton = await waitForSolid(() => view.button("Save"));
      const reloadButton = view.button("Reload Config");
      (operation === "save" ? saveButton : reloadButton).click();
      await waitForSolid(() =>
        expect([saveButton.disabled, reloadButton.disabled]).toEqual([true, true]),
      );
      expect(operation === "save" ? save : reload).toHaveBeenCalledOnce();
      if (operation === "reload") {
        expect(reload).toHaveBeenCalledWith({ reloadOnly: true });
      }
      await view.leave();
      expect(view.queryByRole("button", { name: "Reload Config" })).toBeNull();
      expect(agents.refreshList).not.toHaveBeenCalled();
      if (operation === "save") {
        pending.resolve();
        await waitForSolid(() => expect(agents.refreshList).toHaveBeenCalledOnce());
      } else {
        pending.reject(new Error("Retired config reload unavailable"));
        await pending.promise.catch(() => undefined);
      }
      view.departed();
      expect(view.container.querySelector('[role="alert"]')).toBeNull();
    } finally {
      pending.resolve();
      view.dispose();
    }
  },
);

it.each(["default", "file"] as const)(
  "lets an admitted %s write commit after departure",
  async (kind) => {
    const pending = createDeferred();
    let content = "Original instructions",
      revision = "initial";
    let persisted = {
      agents: {
        defaults: { systemAgent: { agentId: "main" } },
        entries: { main: {}, research: {} },
      },
    };
    const file = () => ({
      agentId: "main",
      workspace: "/synthetic/garden",
      file: {
        name: "AGENTS.md",
        path: "/synthetic/garden/AGENTS.md",
        missing: false,
        content,
        hash: "a".repeat(64),
      },
    });
    const request = routeRequest(
      kind === "default"
        ? {
            "config.get": () => configSnapshot(persisted, revision),
            "config.set": (params) =>
              pending.promise.then(() => {
                persisted = JSON.parse((params as { raw: string }).raw);
                revision = "saved";
                return { config: persisted, hash: revision };
              }),
          }
        : {
            "agents.files.get": file,
            "agents.files.set": (params) =>
              pending.promise.then(() => {
                content = (params as { content: string }).content;
                return file();
              }),
          },
    );
    const { currentGateway, context } = routeContext(
      request,
      kind === "file" ? ["agents.files.set"] : undefined,
    );
    const runtimeConfig = kind === "default" ? createRuntimeConfigCapability(currentGateway) : null;
    if (runtimeConfig) {
      const agents = agentsCapability(async () => ({
        agentId: "research",
        workspace: "",
        files: [],
      }));
      agents.state.agentsList = {
        ...agentsList,
        agents: [...agentsList.agents, { id: "research", name: "Research" }],
      };
      Object.assign(context, pageContext(currentGateway, agents), { runtimeConfig });
      completeContext(context);
      await runtimeConfig.ensureLoaded();
    } else {
      context.agents.ensureFiles = async () => ({
        agentId: "main",
        workspace: "/synthetic/garden",
        files: [file().file],
      });
    }
    const view = mountRoute(
      context,
      kind === "file" ? "files" : "overview",
      kind === "file" ? "main" : "research",
    );
    try {
      await view.enter();
      if (kind === "file") {
        const editor = await waitForSolid(() => {
          const input = view.container.querySelector<HTMLTextAreaElement>(".agent-file-textarea");
          expect(input?.value).toBe(content);
          return input!;
        });
        editor.value = "Saved after leaving";
        editor.dispatchEvent(new Event("input", { bubbles: true }));
      }
      const control = await waitForSolid(() =>
        view.button(kind === "file" ? /^Save$/ : /^Set Default$/),
      );
      control.click();
      await waitForSolid(() => expect(control.textContent).toContain("Saving"));
      expect(control.disabled).toBe(true);
      await view.leave();
      expect(kind === "file" ? content : persisted.agents.defaults.systemAgent.agentId).toBe(
        kind === "file" ? "Original instructions" : "main",
      );
      pending.resolve();
      await waitForSolid(() =>
        expect(kind === "file" ? content : runtimeConfig?.state.configSaving).toBe(
          kind === "file" ? "Saved after leaving" : false,
        ),
      );
      if (kind === "default") {
        expect(persisted.agents.defaults.systemAgent.agentId).toBe("research");
        expect(runtimeConfig?.state.configSnapshot?.hash).toBe("saved");
      }
      view.departed();
    } finally {
      pending.resolve();
      view.dispose();
      runtimeConfig?.dispose();
    }
  },
);

it("retires avatar generation when leaving its route", async () => {
  const pending = createDeferred<GeneratedAvatar>();
  const request = routeRequest({ "agents.avatar.generate": () => pending.promise });
  const { context } = routeContext(request, ["agents.update", "agents.avatar.generate"]);
  const convert = vi
    .spyOn(avatarImage, "svgToAvatarDataUrl")
    .mockResolvedValue({ ok: true, dataUrl: "data:image/png;base64,YXZhdGFy" });
  const view = mountRoute(context);
  try {
    await view.enter();
    (await waitForSolid(() => view.button("Edit avatar"))).click();
    (await waitForSolid(() => view.button(/^Generate$/))).click();
    const prompt = await waitForSolid(() =>
      view.getByRole<HTMLTextAreaElement>("textbox", { name: "Describe your blobster..." }),
    );
    prompt.value = "A patient gardener";
    prompt.dispatchEvent(new Event("input", { bubbles: true }));
    await waitForSolid(() =>
      expect(view.getAllByRole("button", { name: /^Generate$/ })).toHaveLength(2),
    );
    view.getAllByRole("button", { name: /^Generate$/ })[1]!.click();
    await waitForSolid(() =>
      expect(request).toHaveBeenCalledWith(
        "agents.avatar.generate",
        { agentId: "main", prompt: "A patient gardener" },
        { timeoutMs: 100_000 },
      ),
    );
    await view.leave();
    expect(view.queryByRole("textbox")).toBeNull();
    pending.resolve({ name: "Retired gardener", description: "Late result", svg: "<svg/>" });
    await pending.promise;
    await waitForSolid(view.departed);
    expect(convert).not.toHaveBeenCalled();
    expect(view.queryByText("Retired gardener")).toBeNull();
    expect(request.mock.calls.some(([method]) => method === "agents.update")).toBe(false);
  } finally {
    view.dispose();
    pending.reject(new Error("Retired synthetic generation"));
    await pending.promise.catch(() => undefined);
  }
});
