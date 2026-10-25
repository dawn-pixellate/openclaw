import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { For, Show, createMemo, createSignal, onSettled } from "solid-js";
import type { GatewaySessionRow } from "../api/types.ts";
import {
  compactApprovalCommand,
  summarizeApprovalScopeLabel,
} from "../app/approval-presentation.ts";
import type { ExecApprovalDecision, ExecApprovalRequest } from "../app/exec-approval.ts";
import { registerApprovalsEnglish } from "../i18n/locales/en-approvals.ts";
import { formatCountdown } from "../lib/format.ts";
import { registerEnglishCatalog, t } from "../lib/reactive/i18n.ts";
import { resolveSessionDisplayName } from "../lib/session-display.ts";
import { defineSolidBridge } from "../lib/solid-bridge.ts";
import type { JSX as SolidJSX } from "../types/solid-elements.d.ts";
import {
  ApprovalCountdown,
  approvalRemainingLabel,
  useApprovalClock,
} from "./approval-countdown.tsx";
import { createApprovalDecisionPresentation } from "./approval-decision-presentation.ts";
import {
  ExecApprovalBody,
  MobileExecApprovalBody,
  renderPluginBody,
} from "./exec-approval-content.tsx";
import { sidebarAttentionFocusRef } from "./sidebar-attention-focus.ts";
import { Icon } from "./solid/icon.tsx";

registerEnglishCatalog(registerApprovalsEnglish);

declare module "@solidjs/web" {
  namespace JSX {
    interface IntrinsicElements {
      "openclaw-approval-countdown": HTMLAttributes<HTMLElement>;
      "openclaw-sidebar-approval-row": HTMLAttributes<HTMLElement>;
    }
  }
}

const DEFAULT_EXEC_APPROVAL_DECISIONS = [
  "allow-once",
  "allow-always",
  "deny",
] as const satisfies readonly ExecApprovalDecision[];
const MOBILE_DECISION_ORDER = [
  "allow-always",
  "deny",
  "allow-once",
] as const satisfies readonly ExecApprovalDecision[];
const MODAL_DECISION_ORDER = [
  "deny",
  "allow-always",
  "allow-once",
] as const satisfies readonly ExecApprovalDecision[];

export type ExecApprovalCardProps = {
  approval: ExecApprovalRequest;
  sourceSession?: GatewaySessionRow;
  busy: boolean;
  connected: boolean;
  canGrant: boolean;
  error: string | null;
  variant: "inline" | "modal";
  /** The mobile composer opts in using native mobile presentation facts, not pane width. */
  presentation?: "mobile";
  queueCount?: number;
  renderPendingQueue?: () => SolidJSX.Element;
  onDecision: (approvalId: string, decision: ExecApprovalDecision) => void | Promise<void>;
  onDecisionReady?: (decide: ExecApprovalCardProps["onDecision"], deciding: () => boolean) => void;
};

export type SidebarApprovalRowProps = {
  approval: ExecApprovalRequest;
  busy: boolean;
  connected: boolean;
  canGrant: boolean;
  error: string | null;
  openSessionHref?: string;
  sessionTitle?: string | null;
  onDecision: (event: Event, approvalId: string, decision: ExecApprovalDecision) => void;
  onOpenSession?: (event: MouseEvent) => void;
};

function renderChip(kind: "plugin" | "agent", id?: string | null) {
  return id ? (
    <span class="exec-approval-chip mono" data-approval-chip={kind}>
      {id}
    </span>
  ) : undefined;
}

function approvalDecisionLabel(decision: ExecApprovalDecision, approval: ExecApprovalRequest) {
  const proposal = approval.kind === "exec" ? approval.request.streamProposal : undefined;
  if (proposal && decision !== "allow-always") {
    return t(
      decision === "deny"
        ? "execApproval.cancelWatcher"
        : proposal.operation === "add"
          ? "execApproval.startWatcher"
          : "execApproval.saveWatcher",
    );
  }
  if (approval.kind === "plugin" && Array.isArray(approval.pluginActions)) {
    for (const action of approval.pluginActions) {
      if (isRecord(action) && action.kind === "decision" && action.decision === decision) {
        const label = normalizeOptionalString(action.label);
        if (label) {
          return label;
        }
      }
    }
  }
  return t(
    decision === "allow-once"
      ? "execApproval.allowOnce"
      : decision === "allow-always"
        ? approval.kind === "exec"
          ? "execApproval.alwaysAllowHere"
          : "execApproval.alwaysAllow"
        : "execApproval.deny",
  );
}

function decisionClass(decision: ExecApprovalDecision) {
  return decision === "allow-once" ? "btn primary" : decision === "deny" ? "btn danger" : "btn";
}

function decisionShortcut(decision: ExecApprovalDecision) {
  return decision === "allow-once"
    ? "Ctrl/Cmd+Enter"
    : decision === "allow-always"
      ? "Ctrl/Cmd+Shift+Enter"
      : "Ctrl/Cmd+D";
}

export function resolveApprovalDecisions(
  active: ExecApprovalRequest,
): readonly ExecApprovalDecision[] {
  if (active.request.allowedDecisions?.length) {
    return active.request.allowedDecisions;
  }
  return active.kind === "exec" && active.request.ask === "always"
    ? ["allow-once", "deny"]
    : DEFAULT_EXEC_APPROVAL_DECISIONS;
}

export function approvalTitle(active: ExecApprovalRequest): string {
  if (active.kind === "exec" && active.request.streamProposal) {
    return active.request.streamProposal.name;
  }
  return active.kind !== "exec"
    ? (active.pluginTitle ?? t("execApproval.pluginApprovalNeeded"))
    : t("execApproval.execApprovalNeeded");
}

export function SidebarApprovalRow(props: SidebarApprovalRowProps) {
  const approval = createMemo(() => props.approval);
  const nowMs = useApprovalClock();
  const expired = () => approval().expiresAtMs <= nowMs();
  const command = createMemo(() => compactApprovalCommand(approval().request.command));
  const sessionTitle = createMemo(() => {
    const sessionKey = approval().request.sessionKey?.trim();
    return (
      props.sessionTitle ??
      (sessionKey ? resolveSessionDisplayName(sessionKey) : approvalTitle(approval()))
    );
  });
  const expiryUrgent = () => expired() || approval().expiresAtMs - nowMs() < 2 * 60_000;
  const expiryLabel = () => approvalRemainingLabel(approval().expiresAtMs, nowMs());
  const reviewOnlyMessage = () => t("execApproval.reviewOnly");
  const grantError = () => !props.canGrant && props.error === reviewOnlyMessage();
  return (
    <openclaw-sidebar-approval-row style={{ display: "contents" }}>
      <article
        class="sidebar-approval-row sidebar-issues-panel__details--warning"
        data-attention-kind="pendingApproval"
        data-approval-id={approval().id}
      >
        <span class="sidebar-issues-panel__icon sidebar-approval-row__icon" aria-hidden="true">
          <Icon name="shieldQuestion" />
        </span>
        <div class="sidebar-approval-row__content">
          <div
            ref={sidebarAttentionFocusRef("row-only")}
            class="sidebar-approval-row__header"
            data-issue-row-focus
            tabindex="-1"
          >
            <span class="sidebar-issues-panel__entity" title={sessionTitle()}>
              {sessionTitle()}
            </span>
            <openclaw-approval-countdown
              style={{ display: "contents" }}
              class={[
                "sidebar-approval-row__timer",
                { "sidebar-approval-row__timer--urgent": expiryUrgent() },
              ]}
              role="timer"
              aria-label={expiryLabel()}
              title={expiryLabel()}
            >
              {formatCountdown(approval().expiresAtMs, nowMs(), true)}
            </openclaw-approval-countdown>
          </div>
          <div class="sidebar-approval-row__command mono" title={approval().request.command}>
            <span aria-hidden="true">$ </span>
            {command()}
          </div>
          <Show when={approval().request.scope}>
            {(scope) => (
              <div class="exec-approval-scope">{summarizeApprovalScopeLabel(scope())}</div>
            )}
          </Show>
          <Show when={approval().request.warningText}>
            {(warning) => (
              <div class="sidebar-approval-row__message" role="note">
                {warning()}
              </div>
            )}
          </Show>
          <div
            class="sidebar-approval-row__actions"
            role="group"
            aria-label={t("approvalPage.actionsLabel")}
          >
            <For each={resolveApprovalDecisions(approval())}>
              {(decision) => {
                const label = createMemo(() => approvalDecisionLabel(decision, approval()));
                return (
                  <button
                    ref={sidebarAttentionFocusRef()}
                    type="button"
                    class={[
                      "btn btn--xs sidebar-approval-row__action",
                      `sidebar-approval-row__action--${decision}`,
                      { "btn--ghost": decision === "deny" },
                    ]}
                    aria-label={t("execApproval.decisionRequest", {
                      decision: label(),
                      command: command(),
                    })}
                    disabled={!props.connected || props.busy || !props.canGrant || expired()}
                    onClick={(event: Event) => props.onDecision(event, approval().id, decision)}
                  >
                    {label()}
                  </button>
                );
              }}
            </For>
            {props.openSessionHref && props.onOpenSession ? (
              <a
                ref={sidebarAttentionFocusRef()}
                class="sidebar-approval-row__open-session"
                href={props.openSessionHref}
                aria-label={t("sessionsView.openSession")}
                title={t("sessionsView.openSession")}
                onClick={(event) => props.onOpenSession?.(event)}
              >
                <Icon name="arrowUpRight" />
              </a>
            ) : undefined}
          </div>
          {props.connected && !props.canGrant ? (
            <div class="sidebar-approval-row__message" role={grantError() ? "alert" : "note"}>
              {reviewOnlyMessage()}
            </div>
          ) : undefined}
          {props.error && !grantError() ? (
            <div
              class="sidebar-approval-row__message sidebar-approval-row__message--error"
              role="alert"
            >
              {props.error}
            </div>
          ) : undefined}
        </div>
      </article>
    </openclaw-sidebar-approval-row>
  );
}

function ExecApprovalCardContent(
  props: ExecApprovalCardProps & {
    deciding: () => boolean;
    pendingDecision: () => ExecApprovalDecision | undefined;
    decide: ExecApprovalCardProps["onDecision"];
  },
) {
  const active = createMemo(() => props.approval);
  const mobile = createMemo(
    () => props.presentation === "mobile" && props.variant === "inline" && active().kind === "exec",
  );
  const decisions = createMemo(() => {
    const eligible = resolveApprovalDecisions(active());
    // Right-aligned footers keep the primary decision at the trailing edge.
    const order = mobile()
      ? MOBILE_DECISION_ORDER
      : props.variant === "modal" || active().kind === "exec"
        ? MODAL_DECISION_ORDER
        : undefined;
    return order ? order.filter((item) => eligible.includes(item)) : eligible;
  });
  const reviewOnlyMessage = () => t("execApproval.reviewOnly");
  const grantError = () => !props.canGrant && props.error === reviewOnlyMessage();
  const rawSeverity = () => active().pluginSeverity?.trim().toLowerCase();
  const severity = () =>
    active().kind === "exec" || rawSeverity() === "warning" || rawSeverity() === "warn"
      ? "warning"
      : rawSeverity() === "danger" || rawSeverity() === "critical" || rawSeverity() === "error"
        ? "danger"
        : "info";
  const pluginId = () => (active().kind === "plugin" ? active().pluginId?.trim() : null);
  const agentId = () => (props.variant === "modal" ? active().request.agentId?.trim() : null);
  const commandAgent = () =>
    active().kind === "exec" ? active().request.agentId?.trim() : undefined;
  const title = () => {
    const agent = commandAgent();
    if (!agent) {
      return mobile() && !active().request.streamProposal
        ? t("execApproval.runCommand")
        : approvalTitle(active());
    }
    const proposal = active().request.streamProposal;
    return proposal
      ? t(
          proposal.operation === "add"
            ? "execApproval.agentStartWatcher"
            : "execApproval.agentChangeWatcher",
          { agent, name: proposal.name },
        )
      : t("execApproval.agentRunCommand", { agent });
  };
  const sourceSession = () => props.variant === "inline" && active().sourceSessionKey;
  const content = () => (
    <>
      <div class="exec-approval-header">
        <Show when={active().kind === "exec"}>
          <span class="exec-approval-agent" aria-hidden="true">
            {commandAgent()?.slice(0, 1).toUpperCase() ?? <Icon name="terminal" />}
          </span>
        </Show>
        <div class="exec-approval-heading">
          <div class="exec-approval-title">{title()}</div>
          {active().kind !== "exec" && (pluginId() || agentId()) ? (
            <div class="exec-approval-chips">
              {renderChip("plugin", pluginId())} {renderChip("agent", agentId())}
            </div>
          ) : undefined}
          <Show when={active().kind === "exec" && sourceSession()}>
            {(sessionKey) => (
              <div class="exec-approval-source">
                {t("execApproval.requestedBySession", {
                  session: resolveSessionDisplayName(sessionKey(), props.sourceSession),
                })}
              </div>
            )}
          </Show>
          <Show when={active().kind !== "exec"}>
            <ApprovalCountdown
              class="exec-approval-sub exec-approval-countdown"
              role="timer"
              expiresAtMs={active().expiresAtMs}
            />
          </Show>
        </div>
        <Show
          when={active().kind === "exec"}
          fallback={
            (props.queueCount ?? 0) > 1 ? (
              <div class="exec-approval-queue">
                {t("execApproval.pending", { count: String(props.queueCount) })}
              </div>
            ) : undefined
          }
        >
          <div class="exec-approval-header-status">
            <ApprovalCountdown
              class="exec-approval-sub exec-approval-countdown"
              role="timer"
              expiresAtMs={active().expiresAtMs}
            />
            {(props.queueCount ?? 0) > 1 ? (
              <div class="exec-approval-queue">
                {t("execApproval.pending", { count: String(props.queueCount) })}
              </div>
            ) : undefined}
          </div>
        </Show>
      </div>
      <Show when={active().kind !== "exec" && sourceSession()}>
        {(sessionKey) => (
          <div class="exec-approval-warning" role="note">
            {t("execApproval.requestedBySession", {
              session: resolveSessionDisplayName(sessionKey(), props.sourceSession),
            })}
          </div>
        )}
      </Show>
      <Show
        when={active().kind === "exec" && active().id}
        keyed
        fallback={renderPluginBody(active(), props.variant)}
      >
        {(_requestId) => (
          <Show
            when={mobile()}
            fallback={
              <ExecApprovalBody
                request={active().request}
                variant={props.variant}
                error={props.error}
              />
            }
          >
            <MobileExecApprovalBody request={active().request} />
          </Show>
        )}
      </Show>
      <div class="exec-approval-notes">
        {active().kind === "exec" && active().request.streamProposal ? (
          <p class="exec-approval-summary">
            {t(
              active().request.host === "sandbox"
                ? "execApproval.watcherSandboxSummary"
                : active().request.host === "gateway"
                  ? "execApproval.watcherGatewaySummary"
                  : "execApproval.watcherSummary",
            )}
          </p>
        ) : null}
        {active().kind === "exec" && active().request.warningText ? (
          <div class="exec-approval-warning" role="note">
            {active().request.warningText}
          </div>
        ) : null}
        {active().kind === "exec" && active().request.scope ? (
          <div class="exec-approval-scope">
            {summarizeApprovalScopeLabel(active().request.scope!)}
          </div>
        ) : undefined}
        {active().kind === "exec" &&
        (!mobile() || active().request.streamProposal) &&
        !decisions().includes("allow-always") ? (
          <div class="exec-approval-warning">
            {t(
              active().request.streamProposal
                ? "execApproval.watcherApprovalScope"
                : "execApproval.allowAlwaysUnavailable",
            )}
          </div>
        ) : undefined}
        {props.connected && !props.canGrant ? (
          <div
            class={grantError() ? "exec-approval-error" : "exec-approval-warning"}
            role={grantError() ? "alert" : "note"}
          >
            {reviewOnlyMessage()}
          </div>
        ) : undefined}
      </div>
      {active().kind !== "exec" && props.error && !grantError() ? (
        <div class="exec-approval-error" role="alert">
          {props.error}
        </div>
      ) : undefined}
      {props.renderPendingQueue?.()}
    </>
  );
  const actions = () => (
    <For each={decisions()}>
      {(decision) => {
        const label = createMemo(() =>
          mobile() && decision === "allow-always"
            ? t("execApproval.alwaysAllow")
            : approvalDecisionLabel(decision, active()),
        );
        const pending = () =>
          active().kind === "exec" && props.deciding() && props.pendingDecision() === decision;
        return (
          <button
            class={[
              mobile() && decision === "deny" ? "btn" : decisionClass(decision),
              {
                [`exec-approval-mobile-action--${decision}`]: mobile(),
                "exec-approval-action--pending": pending(),
              },
            ]}
            type="button"
            aria-label={label()}
            aria-busy={pending() ? "true" : undefined}
            disabled={!props.connected || props.deciding() || props.busy || !props.canGrant}
            title={
              props.variant === "modal" && props.connected && props.canGrant
                ? `${label()} (${decisionShortcut(decision)})`
                : label()
            }
            onClick={() => void props.decide(active().id, decision)}
          >
            <span>{label()}</span>
            <Show when={pending()}>
              <span class="btn__spinner exec-approval-spinner" aria-hidden="true" />
            </Show>
          </button>
        );
      }}
    </For>
  );
  const footer = () => (
    <Show
      when={props.variant === "modal"}
      fallback={<div class="exec-approval-actions">{actions()}</div>}
    >
      <openclaw-modal-actions class="exec-approval-actions">{actions()}</openclaw-modal-actions>
    </Show>
  );
  return (
    <>
      {" "}
      <div
        class={[
          "exec-approval-card",
          `exec-approval-card--${props.variant}`,
          `exec-approval-card--severity-${severity()}`,
          {
            "exec-approval-card--mobile": mobile(),
            "exec-approval-card--command": active().kind === "exec",
          },
        ]}
        data-approval-id={active().id}
      >
        <Show when={props.variant === "modal"} fallback={content()}>
          <div class="exec-approval-modal-content">{content()}</div>
        </Show>
        <Show when={active().kind === "exec"} fallback={footer()}>
          <div class="exec-approval-footer">
            <div class="exec-approval-status">
              <Show
                when={props.error && !grantError()}
                fallback={
                  active().request.security ? (
                    <span
                      class="exec-approval-security"
                      title={`${t("execApproval.labels.security")}: ${active().request.security}`}
                    >
                      <Icon name={active().request.security === "deny" ? "shieldLock" : "shield"} />
                      {active().request.security === "full"
                        ? t("execApproval.securityFull")
                        : active().request.security === "allowlist"
                          ? t("execApproval.securityAllowlist")
                          : active().request.security === "deny"
                            ? t("execApproval.securityDeny")
                            : active().request.security}
                    </span>
                  ) : undefined
                }
              >
                <div class="exec-approval-error" role="alert">
                  {props.error}
                </div>
              </Show>
            </div>
            {footer()}
          </div>
        </Show>
      </div>
    </>
  );
}

const decisionLifetimes = new WeakMap<
  HTMLElement,
  { retire: () => void; update: (props: ExecApprovalCardProps | undefined) => void }
>();

export const ExecApprovalCard = defineSolidBridge<{ props?: ExecApprovalCardProps }>(
  "openclaw-exec-approval-card",
  (props, host) => {
    host.style.display = "contents";
    const presentation = createApprovalDecisionPresentation();
    const [pendingDecision, setPendingDecision] = createSignal<ExecApprovalDecision>();
    let approvalId = props.props?.approval.id;
    decisionLifetimes.set(host, {
      retire: presentation.retire,
      update(next) {
        if (next?.approval.id !== approvalId || !next?.busy || !next.connected || !next.canGrant) {
          presentation.retire();
        }
        approvalId = next?.approval.id;
      },
    });
    const decide: ExecApprovalCardProps["onDecision"] = (id, decision) => {
      setPendingDecision(decision);
      return presentation.run(props.props?.onDecision(id, decision));
    };
    onSettled(() => {
      props.props?.onDecisionReady?.(decide, presentation.deciding);
      return () => {
        presentation.retire();
        decisionLifetimes.delete(host);
      };
    });
    return (
      <>
        {props.props && (
          <ExecApprovalCardContent
            {...props.props}
            deciding={presentation.deciding}
            pendingDecision={pendingDecision}
            decide={decide}
          />
        )}
      </>
    );
  },
  {
    properties: { props: { default: undefined, attribute: false } },
    propertyChanged: (host) => decisionLifetimes.get(host)?.update(host.props),
    disconnected: (host) => decisionLifetimes.get(host)?.retire(),
  },
);
