import { EventDispatcher } from "@larksuiteoapi/node-sdk";
import {
  createInboundDebouncer,
  resolveInboundDebounceMs,
} from "openclaw/plugin-sdk/channel-inbound-debounce";
import {
  createChannelIngressQueueForTests,
  observeChannelIngressQueueWrite,
} from "openclaw/plugin-sdk/channel-ingress-test-runtime";
import { hasControlCommand, isControlCommandMessage } from "openclaw/plugin-sdk/command-detection";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { createChannelReplayGuard } from "openclaw/plugin-sdk/persistent-dedupe";
import { createPluginRuntimeMock, createRuntimeEnv } from "openclaw/plugin-sdk/plugin-test-runtime";
import { closeOpenClawStateDatabaseAsync } from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { withOpenClawTestState } from "openclaw/plugin-sdk/test-state";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ClawdbotConfig, PluginRuntime } from "../runtime-api.js";
import { resolveFeishuAccount } from "./accounts.js";
import { createFeishuBroadcastIngressSettlement } from "./bot-broadcast.js";
import {
  parseFeishuMessageEvent,
  type handleFeishuMessage,
  type FeishuMessageEvent,
} from "./bot.js";
import { createFeishuTestEvent, withFeishuRuntimeDefaults } from "./bot.test-support.js";
import { createFeishuCardInteractionEnvelope } from "./card-interaction.js";
import type { FeishuMessageProcessingClaim } from "./dedup.js";
import { resolveFeishuMessageDedupeKey } from "./dedupe-key.js";
import type { FeishuIngressLifecycle } from "./feishu-ingress.js";
import {
  monitorSingleAccount,
  resolveReactionSyntheticEvent,
  type FeishuReactionCreatedEvent,
} from "./monitor.account.js";
import { createFeishuTestIngressQueue } from "./monitor.test-mocks.js";
import { createFeishuVcMeetingInvitedHandler } from "./monitor.vc-meeting-invited-handler.js";
import * as send from "./send.js";
import { getFeishuSyntheticDirectPreDispatchTarget } from "./synthetic-event-target.js";
import type { FeishuMessageInfo } from "./types.js";

type MessageParams = Parameters<typeof handleFeishuMessage>[0];
const meetingEvent = (event_id: string) => ({
  event_id,
  meeting: { meeting_no: "123456789" },
  inviter: { id: { open_id: "fixture-user" } },
  invite_time: "1712345678",
});

describe("meeting invitation ownership", () => {
  let guard: ReturnType<typeof createChannelReplayGuard<string | null | undefined>>;
  const invitation = {
    ...meetingEvent("evt_vc_123"),
    call_id: "call_vc_123",
    inviter: { id: { user_id: "u_inviter_1" } },
  };
  const createHandler = (abortSignal?: AbortSignal) =>
    createFeishuVcMeetingInvitedHandler({
      cfg: {},
      accountId: "test",
      autoJoin: true,
      fireAndForget: false,
      abortSignal,
      runtime: createRuntimeEnv(),
    });
  beforeEach(() => {
    guard = createChannelReplayGuard<string | null | undefined>({
      dedupe: { ttlMs: 86_400_000, memoryMaxSize: 1000 },
      buildReplayKey: (key) => key,
    });
    mocks.claim.mockImplementation(({ messageId, namespace }) =>
      guard.claim(messageId, { namespace }),
    );
  });

  it("releases failed invitations for redelivery and preserves adopted replay ownership after stop", async () => {
    let adopted: FeishuIngressLifecycle | undefined;
    mocks.handleMessage.mockRejectedValueOnce(new Error("pre-adoption failure"));
    mocks.handleMessage.mockImplementation(async ({ turnAdoptionLifecycle }) => {
      adopted = turnAdoptionLifecycle;
      await adopted?.onAdopted();
    });
    const controller = new AbortController();
    const handler = createHandler(controller.signal);
    await handler(invitation);
    await handler(invitation);
    await handler(invitation);
    expect(mocks.handleMessage).toHaveBeenCalledTimes(2);
    const event = mocks.handleMessage.mock.calls[0]![0].event;
    expect(getFeishuSyntheticDirectPreDispatchTarget(event)).toBe("user:u_inviter_1");
    expect(event.message.content).toContain("123456789");
    expect(event.message.content).toContain("call_vc_123");
    const key = resolveFeishuMessageDedupeKey(event);
    expect(key).not.toBe(event.message.message_id);
    expect(await guard.hasRecent(key, { namespace: "test" })).toBe(true);
    controller.abort();
    expect(adopted?.abortSignal.aborted).toBe(false);
    await createHandler()(invitation);
    expect(mocks.handleMessage).toHaveBeenCalledTimes(2);
  });

  it("does not dispatch malformed invite events", async () => {
    const handler = createHandler();
    await handler({ ...invitation, meeting: { topic: "Weekly sync" } });
    await handler({ ...invitation, inviter: { id: {} } });
    await handler({ ...invitation, meeting: { meeting_no: "not-a-meeting" } });
    expect(mocks.handleMessage).not.toHaveBeenCalled();
    expect(mocks.claim).not.toHaveBeenCalled();
  });

  it("falls back to /menu for unrelated bot menu keys", async () => {
    const sendCard = vi.spyOn(send, "sendCardFeishu");
    const { maybeHandleFeishuQuickActionMenu } =
      await vi.importActual<typeof import("./card-ux-launcher.js")>("./card-ux-launcher.js");
    mocks.menu.mockImplementation(maybeHandleFeishuQuickActionMenu);
    const { ready, close } = monitorAccount("application.bot.menu_v6");
    try {
      const invoke = await ready;
      await invoke({
        event_key: "custom-key",
        timestamp: "1700000000002",
        operator: { operator_id: { open_id: "ou_user1", user_id: "user_1", union_id: "union_1" } },
      });
      await vi.waitFor(() => expect(mocks.handleMessage).toHaveBeenCalledOnce());
      expect(mocks.handleMessage.mock.calls[0]?.[0]).toMatchObject({
        botOpenId: "fixture-bot",
        event: { message: { content: '{"text":"/menu custom-key"}' } },
      });
      expect(sendCard).not.toHaveBeenCalled();
    } finally {
      await close();
      sendCard.mockRestore();
    }
  });

  it("keeps meeting invitations inert until the live account opts in", async () => {
    const { ready, close } = monitorAccount("vc.bot.meeting_invited_v1");
    try {
      await expect((await ready)(invitation)).resolves.toBeUndefined();
      expect(mocks.handleMessage).not.toHaveBeenCalled();
    } finally {
      await close();
    }
  });

  it("abandons deferred invitation ownership when the account transport ends", async () => {
    let lifecycle: FeishuIngressLifecycle | undefined;
    mocks.handleMessage.mockImplementationOnce(async ({ turnAdoptionLifecycle }) => {
      lifecycle = turnAdoptionLifecycle;
      lifecycle?.onDeferred();
    });
    mocks.handleMessage.mockImplementation(async ({ turnAdoptionLifecycle }) => {
      await turnAdoptionLifecycle?.onAdopted();
    });
    const { ready, close } = monitorAccount("vc.bot.meeting_invited_v1", true);
    try {
      const invoke = await ready;
      await invoke(invitation);
      await vi.waitFor(() => expect(lifecycle).toBeDefined());
      const key = mocks.claim.mock.calls[0]?.[0].messageId;
      expect((await guard.claim(key, { namespace: "test" })).kind).toBe("inflight");
      await close();
      expect(lifecycle?.abortSignal.aborted).toBe(true);
      expect(() => lifecycle?.onAdopted()).toThrow();
      await invoke(invitation);
      expect(mocks.handleMessage).toHaveBeenCalledOnce();
      await createHandler()(invitation);
      expect(mocks.handleMessage).toHaveBeenCalledTimes(2);
      expect(await guard.hasRecent(key, { namespace: "test" })).toBe(true);
    } finally {
      await close();
    }
  });
});

function gated<T>(result: () => T | Promise<T>) {
  const started = createDeferred<void>();
  const gate = createDeferred<void>();
  return {
    started: started.promise,
    release: gate.resolve,
    run: async (): Promise<T> => {
      started.resolve();
      await gate.promise;
      return await result();
    },
  };
}

const mocks = vi.hoisted(() => ({
  register: vi.fn(),
  createDispatcher: vi.fn(),
  chatLookup: vi.fn(),
  runtime: vi.fn(),
  transport: vi.fn(),
  warmup: vi.fn(),
  claim: vi.fn(),
  menu: vi.fn(),
  handleMessage: vi.fn<typeof handleFeishuMessage>(),
  parseMessage: vi.fn(),
  stopBindings: vi.fn(),
  createBindings: vi.fn(),
}));

vi.mock("./client.js", () => ({
  createEventDispatcher: mocks.createDispatcher,
  createFeishuClient: () => ({ im: { chat: { get: mocks.chatLookup } } }),
}));
vi.mock("./runtime.js", () => ({ getFeishuRuntime: mocks.runtime }));
vi.mock("./monitor.transport.js", () => ({
  monitorWebSocket: mocks.transport,
  monitorWebhook: mocks.transport,
}));
vi.mock("./dedup.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./dedup.js")>()),
  warmupDedupFromPluginState: mocks.warmup,
  claimUnprocessedFeishuMessage: mocks.claim,
  hasProcessedFeishuMessage: vi.fn(async () => false),
}));
vi.mock("./card-ux-launcher.js", () => ({ maybeHandleFeishuQuickActionMenu: mocks.menu }));
vi.mock("./bot.js", () => ({
  handleFeishuMessage: mocks.handleMessage,
  parseFeishuMessageEvent: mocks.parseMessage,
}));
vi.mock("./thread-bindings.js", () => ({
  createFeishuThreadBindingManager: mocks.createBindings,
}));

beforeEach(() => {
  vi.resetAllMocks();
  mocks.warmup.mockResolvedValue(0);
  mocks.parseMessage.mockReturnValue({ content: "hello" });
  mocks.createDispatcher.mockImplementation(() => {
    const dispatcher = new EventDispatcher({});
    const register = dispatcher.register.bind(dispatcher);
    vi.spyOn(dispatcher, "register").mockImplementation((handlers) => {
      mocks.register(handlers);
      return register(handlers);
    });
    return dispatcher;
  });
  mockIngressQueue(createFeishuTestIngressQueue);
  mocks.menu.mockResolvedValue(true);
  mocks.createBindings.mockReturnValue({ stop: mocks.stopBindings });
});

function mockIngressQueue(openChannelIngressQueue: typeof createFeishuTestIngressQueue) {
  mocks.runtime.mockReturnValue(createPluginRuntimeMock({ state: { openChannelIngressQueue } }));
}

function startAccount(
  controller: AbortController,
  vcAutoJoin = false,
  options: Partial<Parameters<typeof monitorSingleAccount>[0]> = {},
) {
  const credentials = { appId: "fixture-app", appSecret: "fixture-secret", vcAutoJoin };
  const cfg = { channels: { feishu: { accounts: { test: credentials } } } };
  return monitorSingleAccount({
    cfg,
    account: resolveFeishuAccount({ cfg, accountId: "test" }),
    abortSignal: controller.signal,
    botOpenIdSource: { kind: "prefetched", botOpenId: "fixture-bot", source: "provider" },
    channelRuntime: createPluginRuntimeMock().channel,
    runtime: createRuntimeEnv(),
    ...options,
  });
}

const nextTurn = () =>
  new Promise<void>((resolve) => {
    setImmediate(resolve);
  });

function monitorAccount(
  eventType?: string,
  vcAutoJoin = false,
  options: Partial<Parameters<typeof monitorSingleAccount>[0]> = {},
) {
  const controller = new AbortController();
  const ready = createDeferred<(event: unknown) => Promise<unknown>>();
  mocks.register.mockImplementation(
    (handlers: Record<string, (event: unknown) => Promise<unknown>>) => {
      if (eventType) {
        const handler = handlers[eventType];
        if (!handler) {
          throw new Error(`Handler was not registered: ${eventType}`);
        }
        ready.resolve(handler);
      }
    },
  );
  const transportClosed = createDeferred<void>();
  mocks.transport.mockImplementation(
    async ({ eventDispatcher }: { eventDispatcher: EventDispatcher }) => {
      if (!eventType) {
        ready.resolve((event) => eventDispatcher.invoke(event));
      }
      if (!controller.signal.aborted) {
        await new Promise<void>((resolve) => {
          controller.signal.addEventListener("abort", () => resolve(), { once: true });
        });
      }
      transportClosed.resolve();
    },
  );
  let stopped = false;
  const monitor = startAccount(controller, vcAutoJoin, options).finally(() => {
    stopped = true;
  });
  void monitor.catch(ready.reject);
  return {
    ready: ready.promise,
    monitor,
    close: async (settle?: () => unknown) => {
      controller.abort();
      await settle?.();
      await monitor;
    },
    expectRunning: () => expect(stopped).toBe(false),
    expectStopping: async () => {
      controller.abort();
      await transportClosed.promise;
      await nextTurn();
      expect(stopped).toBe(false);
      expect(mocks.stopBindings).not.toHaveBeenCalled();
    },
  };
}

describe("Feishu account replay work ownership", () => {
  it.each(["message", "evicted-handler"] as const)(
    "joins %s settlement after transport ownership ends",
    (kind) =>
      withOpenClawTestState({ label: "feishu-deferred-commit" }, async ({ stateDir }) => {
        const deferred = createDeferred<FeishuIngressLifecycle>();
        const commit = gated(() => true);
        const evicted = createDeferred<boolean>();
        const claim: FeishuMessageProcessingClaim = {
          keys: ["deferred-message"],
          commit: vi.fn(commit.run),
          release: vi.fn(),
        };
        mocks.claim.mockResolvedValue({ kind: "claimed", handle: claim });
        mocks.handleMessage.mockImplementation(async ({ turnAdoptionLifecycle }: MessageParams) => {
          if (!turnAdoptionLifecycle) {
            throw new Error("Missing registered message lifecycle");
          }
          if (kind === "evicted-handler") {
            await claim.commit();
            return;
          }
          turnAdoptionLifecycle.onDeferred();
          deferred.resolve(turnAdoptionLifecycle);
        });
        const queueOptions = {
          channelId: "feishu",
          accountId: "test",
          stateDir,
        };
        const queue = createChannelIngressQueueForTests(queueOptions);
        mockIngressQueue(<T, TMetadata = unknown, TCompletedMetadata = unknown>() => {
          const ingressQueue = createChannelIngressQueueForTests<T, TMetadata, TCompletedMetadata>(
            queueOptions,
          );
          void observeChannelIngressQueueWrite(ingressQueue, "release").then(
            evicted.resolve,
            evicted.reject,
          );
          return ingressQueue;
        });
        const { ready, close, expectStopping } = monitorAccount();
        let adoption: Promise<void> | undefined;
        try {
          const invoke = await ready;
          if (kind === "evicted-handler") {
            await queue.listPending();
            vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
          }
          await invoke({
            schema: "2.0",
            header: {
              event_id: "evt-deferred-commit",
              event_type: "im.message.receive_v1",
            },
            event: {
              sender: { sender_id: { open_id: "fixture-user" }, sender_type: "user" },
              message: {
                message_id: "om-deferred-commit",
                chat_id: "oc-test",
                chat_type: "p2p",
                message_type: "text",
                content: JSON.stringify({ text: "hello" }),
              },
            },
          });
          if (kind === "evicted-handler") {
            await commit.started;
            await vi.advanceTimersByTimeAsync(5 * 60_000);
            vi.useRealTimers();
            await expect(evicted.promise).resolves.toBe(true);
          } else {
            const lifecycle = await deferred.promise;
            adoption = Promise.resolve(lifecycle.onAdopted());
          }
          await commit.started;
          if (kind !== "evicted-handler") {
            expect(await queue.listPending()).toEqual([]);
          }
          expect(await queue.listClaims()).toEqual([]);
          await expectStopping();
        } finally {
          vi.useRealTimers();
          commit.release();
          await close(() => adoption);
        }
        expect(claim.commit).toHaveBeenCalledOnce();
        if (kind === "evicted-handler") {
          expect(claim.release).toHaveBeenCalled();
        } else {
          expect(claim.release).not.toHaveBeenCalled();
        }
        expect(mocks.stopBindings).toHaveBeenCalledOnce();
      }),
  );

  it.each(["meeting", "card-broadcast"] as const)(
    "joins an accepted %s commit and rejects new events after shutdown",
    (kind) =>
      withOpenClawTestState({ label: `feishu-${kind}-commit` }, async ({ stateDir }) => {
        const guard = createChannelReplayGuard<string>({
          dedupe: {
            ttlMs: 60_000,
            memoryMaxSize: 0,
            pluginId: "feishu",
            stateMaxEntries: 10,
            env: { ...process.env, OPENCLAW_STATE_DIR: stateDir },
          },
          buildReplayKey: (key) => key,
        });
        const lookup = gated(() => ({ code: 0, data: { chat_type: "group" } }));
        mocks.chatLookup.mockImplementation(lookup.run);
        const claimed = await guard.claim(kind);
        if (claimed.kind !== "claimed") {
          throw new Error("Expected synthetic event replay claim");
        }
        const commit = gated(claimed.handle.commit);
        if (kind === "meeting") {
          mocks.claim.mockResolvedValue(claimed);
        }
        const processingFinished = createDeferred<void>();
        let broadcastLane: FeishuIngressLifecycle | undefined;
        let broadcastAdoption: Promise<void> | undefined;
        vi.spyOn(claimed.handle, "commit").mockImplementation(commit.run);
        mocks.handleMessage.mockImplementation(
          async ({ trackTask, turnAdoptionLifecycle }: MessageParams) => {
            try {
              if (kind === "card-broadcast") {
                const broadcast = createFeishuBroadcastIngressSettlement({
                  replayClaim: claimed.handle,
                  trackTask,
                });
                broadcastLane = broadcast.createLane().lifecycle;
                broadcastLane.onDeferred();
                await broadcast.onDispatchComplete();
                return;
              }
              await turnAdoptionLifecycle?.onAdopted();
            } finally {
              processingFinished.resolve();
            }
          },
        );
        const eventType = kind === "meeting" ? "vc.bot.meeting_invited_v1" : "card.action.trigger";
        const event =
          kind !== "meeting"
            ? {
                token: `fixture-${kind}-settlement`,
                operator: { open_id: "fixture-user" },
                action: {
                  tag: "button",
                  value: createFeishuCardInteractionEnvelope({
                    k: "quick",
                    a: "help",
                    q: "/help",
                    c: { u: "fixture-user", h: "oc-card-broadcast", e: Date.now() + 60_000 },
                  }),
                },
                context: { chat_id: "oc-card-broadcast" },
              }
            : meetingEvent("fixture-meeting");
        const { monitor, ready, close, expectStopping, expectRunning } = monitorAccount(
          eventType,
          true,
        );
        try {
          const handler = await ready;
          const acknowledgement = handler(event);
          await (kind !== "meeting" ? lookup.started : commit.started);
          await acknowledgement;
          await expectStopping();
          if (kind !== "meeting") {
            expect(mocks.handleMessage).not.toHaveBeenCalled();
            lookup.release();
            await processingFinished.promise;
            const dispatchResult = mocks.handleMessage.mock.results[0];
            if (!dispatchResult) {
              throw new Error("Expected broadcast message dispatch");
            }
            await expect(dispatchResult.value).resolves.toBeUndefined();
            await nextTurn();
            expectRunning();
            broadcastAdoption = Promise.resolve(broadcastLane?.onAdopted());
            await commit.started;
            await nextTurn();
            expectRunning();
          }
          commit.release();
          await monitor;
          expect(await guard.hasRecent(kind)).toBe(true);
          await handler({ ...event, token: "fixture-after-stop", event_id: "fixture-after-stop" });
          expect(mocks.handleMessage).toHaveBeenCalledOnce();
          expect(claimed.handle.commit).toHaveBeenCalledOnce();
        } finally {
          lookup.release();
          commit.release();
          await close(async () => {
            await processingFinished.promise;
            if (broadcastLane && !broadcastAdoption) {
              broadcastAdoption = Promise.resolve(broadcastLane.onAdopted());
            }
            await broadcastAdoption;
          });
        }
        expect(mocks.stopBindings).toHaveBeenCalledOnce();
      }),
  );

  it("does not start account resources after abort during dedupe warmup", async () => {
    const controller = new AbortController();
    const warmup = createDeferred<number>();
    mocks.warmup.mockReturnValue(warmup.promise);
    const monitor = startAccount(controller);
    controller.abort();
    warmup.resolve(1);
    await monitor;
    expect(mocks.register).not.toHaveBeenCalled();
    expect(mocks.transport).not.toHaveBeenCalled();
    expect(mocks.createBindings).not.toHaveBeenCalled();
  });

  it.each(["menu", "meeting"] as const)(
    "joins detached %s claim before retiring the account",
    async (kind) => {
      const reached = createDeferred<void>();
      const release = createDeferred<void>();
      const settled = createDeferred<void>();
      let claimStarted = false;
      const claim: FeishuMessageProcessingClaim = {
        keys: ["fixture-menu"],
        commit: vi.fn(async () => {
          settled.resolve();
          return true;
        }),
        release: vi.fn(() => settled.resolve()),
      };
      mocks.claim.mockImplementation(async () => {
        claimStarted = true;
        reached.resolve();
        await release.promise;
        return { kind: "claimed", handle: claim };
      });
      const { monitor, ready, close, expectStopping } = monitorAccount(
        kind === "meeting" ? "vc.bot.meeting_invited_v1" : "application.bot.menu_v6",
        kind === "meeting",
      );
      try {
        const menu = await ready;
        const acknowledgement = menu(
          kind === "meeting"
            ? meetingEvent("fixture-pending-meeting")
            : {
                event_key: "quick-actions",
                timestamp: "fixture-time",
                operator: { operator_id: { open_id: "fixture-user" } },
              },
        );
        await reached.promise;
        await expectStopping();
        release.resolve();
        await acknowledgement;
        await monitor;
        expect(mocks.stopBindings).toHaveBeenCalledOnce();
        expect(mocks.menu).not.toHaveBeenCalled();
        expect(mocks.handleMessage).not.toHaveBeenCalled();
        expect(claim.release).toHaveBeenCalledOnce();
        expect(claim.commit).not.toHaveBeenCalled();
      } finally {
        release.resolve();
        await close();
        if (claimStarted) {
          await settled.promise;
        }
      }
    },
  );
});

let stopDebounceMonitor: (() => Promise<void>) | undefined;
function makeReactionEvent(
  overrides: Partial<FeishuReactionCreatedEvent> = {},
): FeishuReactionCreatedEvent {
  return {
    message_id: "om_msg1",
    reaction_type: { emoji_type: "THUMBSUP" },
    operator_type: "user",
    user_id: { open_id: "ou_user1" },
    ...overrides,
  };
}
function fetchedMessage(overrides: Partial<FeishuMessageInfo> = {}): FeishuMessageInfo {
  return {
    messageId: "om_msg1",
    chatId: "oc_group_from_lookup",
    chatType: "group",
    senderOpenId: "ou_bot",
    content: "hello",
    contentType: "text",
    ...overrides,
  };
}
function resolveReaction(
  params: Partial<Parameters<typeof resolveReactionSyntheticEvent>[0]> & {
    fetchMessage?: typeof send.getMessageFeishu;
  } = {},
) {
  const { cfg = {}, fetchMessage = async () => fetchedMessage(), ...options } = params;
  vi.spyOn(send, "getMessageFeishu").mockImplementation(fetchMessage);
  return resolveReactionSyntheticEvent({
    cfg: withFeishuRuntimeDefaults(cfg),
    accountId: "default",
    event: makeReactionEvent(),
    botOpenId: "ou_bot",
    ...options,
  });
}

async function setupDebounceMonitor() {
  const cfg = withFeishuRuntimeDefaults({
    messages: { inbound: { debounceMs: 0, byChannel: { feishu: 20 } } },
    channels: { feishu: { enabled: true, appId: "cli_test", appSecret: "secret_test" } },
  });
  mocks.runtime.mockReturnValue({
    state: { openChannelIngressQueue: createFeishuTestIngressQueue },
    channel: {
      commands: { isControlCommandMessage },
      debounce: { createInboundDebouncer, resolveInboundDebounceMs },
      text: { hasControlCommand },
    },
  } as unknown as PluginRuntime);
  const account = monitorAccount(undefined, false, {
    cfg,
    account: resolveFeishuAccount({ cfg, accountId: "default" }),
    botOpenIdSource: { kind: "prefetched", botOpenId: "ou_bot" },
    // Exercise installed-runtime fallback from a partial injected runtime.
    channelRuntime: { runtimeContexts: {} } as unknown as PluginRuntime["channel"],
  });
  stopDebounceMonitor = account.close;
  return { invoke: await account.ready };
}
type FeishuMention = NonNullable<FeishuMessageEvent["message"]["mentions"]>[number];
function createTextEvent(params: {
  messageId: string;
  text: string;
  mentions?: FeishuMention[];
  threadId?: string;
}): FeishuMessageEvent {
  return createFeishuTestEvent({
    ...params,
    senderOpenId: "ou_sender",
    senderType: "user",
    chatId: "oc_group_1",
    chatType: "group",
    message: {
      mentions: params.mentions,
      ...(params.threadId ? { thread_id: params.threadId } : {}),
    },
  });
}
function mention(openId: string, name: string, key = "@_user_1"): FeishuMention {
  return { key, id: { open_id: openId }, name };
}
async function enqueueText(
  dispatcher: Pick<EventDispatcher, "invoke">,
  ...messages: Array<Parameters<typeof createTextEvent>[0]>
) {
  for (const message of messages) {
    await dispatcher.invoke({
      schema: "2.0",
      header: { event_type: "im.message.receive_v1", event_id: message.messageId },
      event: createTextEvent(message),
    });
    await Promise.resolve();
    await Promise.resolve();
  }
}
function dispatchedMessage(index = 0) {
  const call = mocks.handleMessage.mock.calls[index]?.[0];
  if (!call) {
    throw new Error("missing Feishu message dispatch");
  }
  return call;
}
function parsedDispatch() {
  expect(mocks.handleMessage).toHaveBeenCalledTimes(1);
  const { event, preparedContent } = dispatchedMessage();
  return { dispatched: event, parsed: parseFeishuMessageEvent(event, "ou_bot", preparedContent) };
}
async function debounceMessages(...messages: Array<Parameters<typeof createTextEvent>[0]>) {
  await enqueueText(await setupDebounceMonitor(), ...messages);
  await vi.advanceTimersByTimeAsync(25);
}

function setDedupPassThroughMocks() {
  mocks.claim.mockResolvedValue({
    kind: "claimed",
    handle: { keys: ["test"], commit: async () => true, release: () => undefined },
  });
}

async function useRealParser() {
  const actual = await vi.importActual<typeof import("./bot.js")>("./bot.js");
  mocks.parseMessage.mockImplementation(actual.parseFeishuMessageEvent);
}
afterEach(async () => {
  try {
    const results = await Promise.allSettled([stopDebounceMonitor?.()]);
    results.push(...(await Promise.allSettled([closeOpenClawStateDatabaseAsync()])));
    const errors = results.flatMap((result) =>
      result.status === "rejected" ? [result.reason] : [],
    );
    if (errors.length === 1) {
      throw errors[0];
    }
    if (errors.length > 1) {
      throw new AggregateError(errors, "Feishu reaction test cleanup failed");
    }
    stopDebounceMonitor = undefined;
    vi.restoreAllMocks();
  } finally {
    vi.useRealTimers();
  }
});

describe("resolveReactionSyntheticEvent", () => {
  beforeEach(useRealParser);
  it.each([
    {
      name: "app self-reactions",
      params: { event: makeReactionEvent({ operator_type: "app" }) },
    },
    {
      name: "Typing reactions",
      params: { event: makeReactionEvent({ reaction_type: { emoji_type: "Typing" } }) },
    },
    { name: "unavailable bot identity", params: { botOpenId: undefined } },
    {
      name: "disabled notifications",
      params: {
        cfg: { channels: { feishu: { reactionNotifications: "off" } } } as ClawdbotConfig,
      },
    },
  ])("filters $name", async ({ params }) => {
    const fetchMessage = vi.fn(async () => fetchedMessage());
    expect(await resolveReaction({ fetchMessage, ...params })).toBeNull();
    expect(fetchMessage).not.toHaveBeenCalled();
  });

  it("filters reactions on non-bot messages", async () => {
    expect(
      await resolveReaction({
        fetchMessage: async () => fetchedMessage({ senderOpenId: "ou_other", senderType: "user" }),
      }),
    ).toBeNull();
  });

  it("preserves reaction actors and lookup chat context without an open_id", async () => {
    const result = await resolveReaction({
      event: makeReactionEvent({ user_id: { user_id: "u_actor_only" }, chat_type: "bogus" }),
    });
    expect(result?.sender.sender_id).toEqual({ user_id: "u_actor_only" });
    expect(result?.message).toMatchObject({
      chat_id: "oc_group_from_lookup",
      chat_type: "group",
    });
    expect(parseFeishuMessageEvent(result!, "ou_bot").senderOpenId).toBe("u_actor_only");
  });

  it("preserves the real reply anchor and topic ownership for deleted reactions", async () => {
    const result = await resolveReaction({
      action: "deleted",
      event: makeReactionEvent({ chat_id: "oc_group_from_event", chat_type: "topic_group" }),
      fetchMessage: async () =>
        fetchedMessage({ chatType: "private", rootId: "om_topic_root", threadId: "omt_topic" }),
    });
    expect(result?.message).toMatchObject({
      reply_target_message_id: "om_msg1",
      typing_target_message_id: "om_msg1",
      chat_id: "oc_group_from_event",
      chat_type: "topic_group",
      root_id: "om_topic_root",
      thread_id: "omt_topic",
    });
    expect(parseFeishuMessageEvent(result!, "ou_bot")).toMatchObject({
      replyTargetMessageId: "om_msg1",
      rootId: "om_topic_root",
      threadId: "omt_topic",
    });
  });

  it("drops unverified reactions when sender verification times out", async () => {
    vi.useFakeTimers();
    const pending = resolveReaction({
      fetchMessage: () => new Promise<never>(() => {}),
    });
    await vi.advanceTimersByTimeAsync(1_500);
    await expect(pending).resolves.toBeNull();
  });

  it("falls back to sender p2p chat when lookup returns empty chat_id", async () => {
    const result = await resolveReaction({
      fetchMessage: async () => fetchedMessage({ chatId: "", chatType: "p2p" }),
    });
    expect(result?.message).toMatchObject({ chat_id: "p2p:ou_user1", chat_type: "p2p" });
  });

  it("drops reactions without chat context when lookup does not provide chat_type", async () => {
    expect(
      await resolveReaction({
        fetchMessage: async () => fetchedMessage({ chatType: undefined }),
      }),
    ).toBeNull();
  });

  it("logs and drops reactions when lookup throws", async () => {
    const log = vi.fn();
    const result = await resolveReaction({
      accountId: "acct1",
      fetchMessage: async () => {
        throw new Error("boom");
      },
      logger: log,
    });
    expect(result).toBeNull();
    expect(log).toHaveBeenCalledWith(
      "feishu[acct1]: ignoring reaction on non-bot/unverified message om_msg1 (sender: unknown)",
    );
  });
});

describe("Feishu inbound debounce regressions", () => {
  beforeEach(async () => {
    await useRealParser();
    vi.useFakeTimers();
    mocks.handleMessage.mockClear();
  });

  it("keeps root-less topic threads in separate debounce buckets", async () => {
    setDedupPassThroughMocks();
    await debounceMessages(
      { messageId: "om_topic_a", text: "topic alpha", threadId: "omt_topic_a" },
      { messageId: "om_topic_b", text: "topic beta", threadId: "omt_topic_b" },
    );
    expect(mocks.handleMessage).toHaveBeenCalledTimes(2);
    expect(
      mocks.handleMessage.mock.calls.map(([{ event }]) => ({
        threadId: event.message.thread_id,
        text: JSON.parse(event.message.content).text,
      })),
    ).toEqual([
      { threadId: "omt_topic_a", text: "topic alpha" },
      { threadId: "omt_topic_b", text: "topic beta" },
    ]);
  });

  it("dispatches a bare abort trigger without flushing pending text", async () => {
    setDedupPassThroughMocks();
    const dispatcher = await setupDebounceMonitor();
    await enqueueText(dispatcher, { messageId: "om_1", text: "first" });
    expect(mocks.handleMessage).not.toHaveBeenCalled();
    await enqueueText(dispatcher, { messageId: "om_stop", text: "stop" });
    await Promise.resolve();
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(mocks.handleMessage).toHaveBeenCalledTimes(1);
    expect(dispatchedMessage().event.message.message_id).toBe("om_stop");
    expect(JSON.parse(dispatchedMessage().event.message.content)).toEqual({ text: "stop" });
    await vi.advanceTimersByTimeAsync(25);
    expect(mocks.handleMessage).toHaveBeenCalledTimes(2);
    expect(dispatchedMessage(1).event.message.message_id).toBe("om_1");
    expect(JSON.parse(dispatchedMessage(1).event.message.content)).toEqual({ text: "first" });
  });

  it("preserves only the bot mention across separate messages ending without mentions", async () => {
    setDedupPassThroughMocks();
    await debounceMessages(
      {
        messageId: "om_user_mention",
        text: "@alice first",
        mentions: [mention("ou_alice", "alice")],
      },
      { messageId: "om_bot_mention", text: "@bot second", mentions: [mention("ou_bot", "bot")] },
      { messageId: "om_plain_last", text: "plain follow-up" },
    );
    const { dispatched, parsed } = parsedDispatch();
    expect(parsed.mentionedBot).toBe(true);
    expect(parsed.mentionTargets).toBeUndefined();
    expect(dispatched.message.mentions?.map((entry) => entry.id.open_id)).toEqual(["ou_bot"]);
  });

  it("normalizes each debounced message once without mixing per-message mention keys", async () => {
    setDedupPassThroughMocks();
    await debounceMessages(
      {
        messageId: "om_literal_first",
        text: "@_bot @_user_1 first",
        mentions: [mention("ou_bot", "Bot", "@_bot"), mention("ou_alice", "Alice @_user_10")],
      },
      {
        messageId: "om_literal_last",
        text: "@_bot @_user_1 @_user_10thanks",
        mentions: [
          mention("ou_bot", "Bot", "@_bot"),
          mention("ou_bob", "Bob"),
          mention("ou_carol", "Carol", "@_user_10"),
        ],
      },
    );
    const { dispatched, parsed } = parsedDispatch();
    expect(dispatched.message.message_id).toBe("om_literal_last");
    expect(parsed.content).toBe(
      '<at user_id="ou_bot">Bot</at> <at user_id="ou_alice">Alice @_user_10</at> first\n<at user_id="ou_bot">Bot</at> <at user_id="ou_bob">Bob</at> <at user_id="ou_carol">Carol</at>thanks',
    );
    expect(parsed.mentionedBot).toBe(true);
    expect(parsed.mentionTargets?.map((target) => target.openId)).toEqual(["ou_bob", "ou_carol"]);
  });

  it("excludes duplicates at admission and keeps the latest message as the batch anchor", async () => {
    mocks.claim.mockImplementation(async ({ messageId }) =>
      messageId === "om_old"
        ? { kind: "duplicate" }
        : {
            kind: "claimed",
            handle: {
              keys: [messageId ?? "test"],
              commit: async () => true,
              release: () => undefined,
            },
          },
    );
    await debounceMessages(
      { messageId: "om_old", text: "stale" },
      { messageId: "om_new_1", text: "first" },
      { messageId: "om_old", text: "stale" },
      { messageId: "om_new_2", text: "second" },
      { messageId: "om_old", text: "stale" },
    );
    const { dispatched, parsed } = parsedDispatch();
    expect(dispatched.message.message_id).toBe("om_new_2");
    expect(parsed.content).toBe("first\nsecond");
  });
});
