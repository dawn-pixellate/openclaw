/* @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.ts";
import type { ExecApprovalRequest } from "../app/exec-approval.ts";
import { i18n } from "../i18n/index.ts";
import { getRenderedModalDialog, installDialogPolyfill } from "../test-helpers/modal-dialog.ts";
import { mountSolid } from "../test-helpers/solid-render.tsx";
import { flush, waitForSolid } from "../test-helpers/solid-settle.ts";
import {
  ExecApproval,
  type ExecApprovalElement,
  type ExecApprovalProps,
} from "./exec-approval-solid.tsx";

let container: HTMLDivElement;
let restoreDialogPolyfill: () => void;
let update: ((props: { props: ExecApprovalProps }) => void) | undefined;
const query = (selector: string) => container.querySelector<HTMLElement>(selector);
const activeId = () => query(".exec-approval-card")?.getAttribute("data-approval-id");

function createExecRequest(overrides: Partial<ExecApprovalRequest> = {}): ExecApprovalRequest {
  return {
    id: "approval-1",
    kind: "exec",
    request: { command: "echo hello", ask: "on-request" },
    createdAtMs: Date.now() - 1_000,
    expiresAtMs: Date.now() + 60_000,
    ...overrides,
  };
}

async function renderApproval(
  requestOrQueue: ExecApprovalRequest | ExecApprovalRequest[] = createExecRequest(),
  overrides: Partial<Omit<ExecApprovalProps, "queue" | "onDecision">> & {
    onDecision?: Mock<ExecApprovalProps["onDecision"]>;
  } = {},
) {
  const queue = Array.isArray(requestOrQueue) ? requestOrQueue : [requestOrQueue];
  const onDecision = overrides.onDecision ?? vi.fn<ExecApprovalProps["onDecision"]>();
  const props: ExecApprovalProps = {
    queue,
    busy: overrides.busy ?? false,
    connected: overrides.connected ?? true,
    canGrant: overrides.canGrant ?? true,
    errors: overrides.errors ?? new Map(),
    onDecision,
  };
  if (update) {
    update({ props });
  } else {
    const view = mountSolid(ExecApproval, { props }, container);
    update = (next) => view.update(next);
  }
  const approval = container.querySelector<ExecApprovalElement>("openclaw-exec-approval");
  if (!approval) {
    throw new Error("Expected exec approval");
  }
  await approval.updateComplete;
  return { approval, onDecision };
}

async function renderOpenedApproval(
  requestOrQueue: ExecApprovalRequest | ExecApprovalRequest[] = createExecRequest(),
  overrides: Parameters<typeof renderApproval>[1] = {},
) {
  const rendered = await renderApproval(requestOrQueue, overrides);
  rendered.approval.show();
  await rendered.approval.updateComplete;
  return { ...rendered, ...(await getRenderedModalDialog(container)) };
}

function chord(key: string, init: KeyboardEventInit = {}): KeyboardEvent {
  return new KeyboardEvent("keydown", { key, metaKey: true, bubbles: true, ...init });
}

describe("openclaw-exec-approval", () => {
  beforeEach(async () => {
    restoreDialogPolyfill = installDialogPolyfill();
    await i18n.setLocale("en");
    container = document.createElement("div");
    document.body.append(container);
  });

  afterEach(async () => {
    update = undefined;
    vi.useRealTimers();
    container.remove();
    await i18n.setLocale("en");
    restoreDialogPolyfill();
    vi.restoreAllMocks();
  });

  it("uses one pending presentation for keyboard and button decisions", async () => {
    const pending = createDeferred();
    const onDecision = vi.fn<ExecApprovalProps["onDecision"]>(() => pending.promise);
    const { dialog } = await renderOpenedApproval(createExecRequest(), { onDecision });
    dialog.dispatchEvent(chord("Enter"));
    await waitForSolid(() => {
      expect(onDecision).toHaveBeenCalledOnce();
      expect(query(".exec-approval-actions button")?.hasAttribute("disabled")).toBe(true);
    });
    dialog.dispatchEvent(chord("Enter"));
    expect(onDecision).toHaveBeenCalledOnce();
    pending.resolve();
    await waitForSolid(() =>
      expect(query(".exec-approval-actions button")?.hasAttribute("disabled")).toBe(false),
    );
  });

  it("keeps the visible and accessible expiry countdowns synchronized", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"], now: 0 });
    const { dialog } = await renderOpenedApproval(createExecRequest({ expiresAtMs: 90_500 }));
    for (const [advance, remaining] of [
      [0, "01:31"],
      [1000, "01:30"],
    ] as const) {
      await vi.advanceTimersByTimeAsync(advance);
      flush();
      await getRenderedModalDialog(container);
      const label = `expires in ${remaining}`;
      expect([
        query(".exec-approval-countdown")?.textContent?.trim(),
        dialog.getAttribute("aria-description"),
      ]).toEqual([label, label]);
    }
  });

  it("releases the clock while a retained modal shows an expired approval", async () => {
    const intervals = vi.spyOn(globalThis, "setInterval");
    const cleared = vi.spyOn(globalThis, "clearInterval");
    let nowMs = 0;
    vi.spyOn(Date, "now").mockImplementation(() => nowMs);
    const request = createExecRequest({ expiresAtMs: -1 });
    const { dialog } = await renderOpenedApproval(request);
    const card = query(".exec-approval-card");
    const countdown = query(".exec-approval-countdown");
    expect(countdown?.textContent?.trim()).toBe("expired");
    expect(dialog.getAttribute("aria-description")).toBe("expired");
    expect(intervals.mock.calls.filter(([, delay]) => delay === 1_000)).toHaveLength(0);

    await renderApproval({ ...request, expiresAtMs: 2_000 });
    expect(query(".exec-approval-card")).toBe(card);
    expect(countdown?.textContent?.trim()).toBe("expires in 00:02");
    expect(dialog.getAttribute("aria-description")).toBe("expires in 00:02");
    const clockIntervals = intervals.mock.calls.flatMap(([tick, delay], index) =>
      delay === 1_000 ? [{ tick, handle: intervals.mock.results[index]?.value }] : [],
    );
    expect(clockIntervals).toHaveLength(1);
    const clock = clockIntervals[0];
    if (typeof clock?.tick !== "function") {
      throw new Error("Expected countdown interval");
    }
    nowMs = 2_000;
    clock.tick();
    flush();
    await getRenderedModalDialog(container);
    expect(query(".exec-approval-card")).toBe(card);
    expect(countdown?.textContent?.trim()).toBe("expired");
    expect(dialog.getAttribute("aria-description")).toBe("expired");
    expect(cleared).toHaveBeenCalledWith(clock.handle);
  });

  it("safely truncates queued commands and selects without changing queue order", async () => {
    const queue = [
      createExecRequest({ id: "approval-oldest", createdAtMs: 1 }),
      createExecRequest({
        id: "approval-newer",
        createdAtMs: 2,
        // The emoji straddles code unit 61; the summary must not leave half a surrogate.
        request: { command: `${"a".repeat(60)}🙂 --with-extra-arguments`, agentId: "worker" },
      }),
    ];
    const { approval, onDecision } = await renderOpenedApproval(queue);
    expect(query(".exec-approval-list__command")?.textContent).toBe(`${"a".repeat(60)}…`);
    expect(activeId()).toBe("approval-oldest");
    container.querySelector<HTMLButtonElement>(".exec-approval-list__item")?.click();
    await approval.updateComplete;

    expect(activeId()).toBe("approval-newer");
    expect(queue.map((entry) => entry.id)).toEqual(["approval-oldest", "approval-newer"]);
    container.querySelector<HTMLButtonElement>(".exec-approval-actions button:last-child")!.click();
    expect(onDecision).toHaveBeenCalledWith("approval-newer", "allow-once");
  });

  it.each([
    ["Enter", {}, "allow-once"],
    ["Enter", { shiftKey: true }, "allow-always"],
    ["в", { code: "KeyD", metaKey: false, ctrlKey: true }, "deny"],
    ["a", { metaKey: false }, null],
    ["Enter", { metaKey: false }, null],
    ["d", { metaKey: false }, null],
    ["Enter", { altKey: true }, null],
    ["Enter", { repeat: true }, null],
    ["Enter", { shiftKey: true, repeat: true }, null],
  ] as const)("handles %s with %j without unintended decisions", async (key, flags, decision) => {
    const { onDecision, modal } = await renderOpenedApproval();
    modal.dispatchEvent(chord(key, flags));
    expect(onDecision.mock.calls).toEqual(decision ? [["approval-1", decision]] : []);
  });

  it.each([true, false])(
    "disables decisions with approval access unavailable, connected=%s",
    async (connected) => {
      const { onDecision, modal } = await renderOpenedApproval(createExecRequest(), {
        canGrant: false,
        connected,
      });
      const buttons = Array.from(
        container.querySelectorAll<HTMLButtonElement>(".exec-approval-actions button"),
      );

      if (connected) {
        expect(container.querySelector(".exec-approval-warning")?.textContent?.trim()).toBe(
          "Review only. Sign in with approval access to record a decision.",
        );
      } else {
        expect(container.textContent).not.toContain("Sign in");
      }
      expect(buttons.every((button) => button.disabled)).toBe(true);

      buttons[0]?.click();
      modal.dispatchEvent(chord("Enter"));
      modal.dispatchEvent(chord("d"));

      expect(onDecision).not.toHaveBeenCalled();
    },
  );

  it("pins the displayed approval through arrivals and closes when the queue drains", async () => {
    const newer = createExecRequest({ id: "approval-newer", createdAtMs: 2_000 });
    const older = createExecRequest({ id: "approval-older", createdAtMs: 1_000 });
    const { approval } = await renderOpenedApproval([newer]);
    expect(activeId()).toBe("approval-newer");

    // A late oldest-first arrival must not replace the card being read.
    await renderApproval([older, newer]);
    await approval.updateComplete;
    expect(activeId()).toBe("approval-newer");

    await renderApproval([older]);
    await approval.updateComplete;
    expect(activeId()).toBe("approval-older");

    await renderApproval([]);
    expect(query("openclaw-modal-dialog")).toBeNull();
    await renderApproval([newer]);
    expect(query("openclaw-modal-dialog")).toBeNull();
  });

  it.each(["exec", "plugin"] as const)(
    "guards restricted %s shortcuts while busy or editing",
    async (kind) => {
      const restricted = createExecRequest({
        kind,
        request: { command: "echo hello", allowedDecisions: ["allow-once", "deny"] },
      });
      const onDecision = vi.fn();
      const rendered = await renderOpenedApproval(restricted, { busy: true, onDecision });
      rendered.modal.dispatchEvent(chord("Enter"));
      const cancel = new CustomEvent("modal-cancel", {
        bubbles: true,
        composed: true,
        cancelable: true,
      });
      expect(rendered.modal.dispatchEvent(cancel)).toBe(false);
      expect(cancel.defaultPrevented).toBe(true);

      await renderApproval(restricted, { onDecision });
      expect(
        [...container.querySelectorAll(".exec-approval-actions button > span")].map((label) =>
          label.textContent?.trim(),
        ),
      ).toEqual(["Deny", "Allow once"]);
      if (kind === "plugin") {
        expect(query(".exec-approval-warning")).toBeNull();
      }
      const refreshed = await getRenderedModalDialog(container);
      refreshed.modal.dispatchEvent(chord("Enter", { shiftKey: true }));
      const input = document.createElement("input");
      refreshed.modal.append(input);
      input.dispatchEvent(chord("d", { composed: true }));
      const editor = document.createElement("div");
      editor.setAttribute("contenteditable", "true");
      const editorChild = document.createElement("span");
      editor.append(editorChild);
      refreshed.modal.append(editor);
      editorChild.dispatchEvent(chord("Enter", { composed: true }));

      expect(onDecision).not.toHaveBeenCalled();
    },
  );

  // Settings Escape guards read this fact; a pending queue alone must not
  // report an open dialog now that approvals surface passively.
  it("records dialogOpen only while the dialog is explicitly open", async () => {
    const { approval, onDecision } = await renderApproval();
    const opener = document.createElement("button");
    container.append(opener);
    opener.focus();
    expect(approval.dialogOpen).toBe(false);
    expect(container.querySelector("openclaw-modal-dialog")).toBeNull();

    approval.show();
    await approval.updateComplete;
    expect(approval.dialogOpen).toBe(true);

    const { dialog } = await getRenderedModalDialog(container);
    expect(dialog.open).toBe(true);
    expect(dialog.contains(document.activeElement)).toBe(true);
    dialog.dispatchEvent(new Event("cancel", { cancelable: true }));
    await approval.updateComplete;
    expect(approval.dialogOpen).toBe(false);
    expect(container.querySelector("openclaw-modal-dialog")).toBeNull();
    expect(document.activeElement).toBe(opener);
    expect(onDecision).not.toHaveBeenCalled();

    approval.show();
    await approval.updateComplete;
    const reopened = await getRenderedModalDialog(container);
    expect(reopened.dialog.open).toBe(true);
    expect(approval.dialogOpen).toBe(true);
    expect(onDecision).not.toHaveBeenCalled();
  });
});
