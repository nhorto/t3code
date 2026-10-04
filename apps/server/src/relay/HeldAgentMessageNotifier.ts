import type {
  AgentMessage,
  AgentMessageStreamEvent,
  EnvironmentId,
  ThreadId,
} from "@t3tools/contracts";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import * as AgentMessageService from "../agentMessages/AgentMessageService.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import { forkParked } from "../serverActivation.ts";
import * as AgentAwarenessRelay from "./AgentAwarenessRelay.ts";

/** Held messages for one receiver within this window share one follow-up alert. */
export const HELD_AGENT_MESSAGE_COALESCE_WINDOW = Duration.minutes(1);
const PREVIEW_LENGTH = 100;
/** Message ids remembered so a re-published held message (hub redelivery) alerts once. */
const SEEN_LIMIT = 1_000;

/** The message text on one line, cut to about 100 characters. */
export function previewAgentMessageText(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat.length === 0) return "(empty message)";
  return flat.length <= PREVIEW_LENGTH ? flat : `${flat.slice(0, PREVIEW_LENGTH - 1).trimEnd()}…`;
}

/** One held message names its sender; a burst counts the messages held for the receiver. */
export function heldAgentMessageAlert(input: {
  readonly latest: AgentMessage;
  readonly count: number;
}): AgentAwarenessRelay.HeldAgentMessageAlert {
  const { latest, count } = input;
  const receiver = latest.to.label.trim() || latest.to.threadId;
  const sender = latest.from.label.trim() || latest.from.threadId;
  const preview = previewAgentMessageText(latest.text);
  return {
    threadId: latest.to.threadId,
    title:
      count === 1
        ? `Agent message held: ${sender} → ${receiver}`
        : `${count} messages held for ${receiver}`,
    body: count === 1 ? preview : `Latest from ${sender}: ${preview}`,
    count,
    messageId: latest.id,
  };
}

/** A message that just became held on this machine, which owns its loop guard. */
export function isNewlyHeldHere(
  event: AgentMessageStreamEvent,
  localEnvironmentId: EnvironmentId,
): event is Extract<AgentMessageStreamEvent, { type: "messageUpserted" }> {
  // The snapshot replays history; only live upserts are news.
  return (
    event.type === "messageUpserted" &&
    event.message.status === "held" &&
    event.message.to.environmentId === localEnvironmentId
  );
}

/**
 * Alerts once per held message, but a burst for the same receiver collapses:
 * the first message alerts at once and opens a window, messages held during
 * it are counted, and when it closes one alert reports the burst's total.
 * A window that closes with nothing new ends the burst.
 */
export const makeHeldAgentMessageCoalescer = Effect.fnUntraced(function* <R>(input: {
  readonly window: Duration.Input;
  readonly send: (
    alert: AgentAwarenessRelay.HeldAgentMessageAlert,
  ) => Effect.Effect<void, never, R>;
}) {
  const scope = yield* Effect.scope;
  const seen = new Set<string>();
  const bursts = new Map<ThreadId, { count: number; pending: AgentMessage | null }>();

  const openWindow = (threadId: ThreadId): Effect.Effect<void, never, R> =>
    Effect.sleep(input.window).pipe(
      Effect.andThen(closeWindow(threadId)),
      Effect.forkIn(scope),
      Effect.asVoid,
    );

  const closeWindow = (threadId: ThreadId): Effect.Effect<void, never, R> =>
    Effect.suspend(() => {
      const burst = bursts.get(threadId);
      if (burst === undefined) return Effect.void;
      if (burst.pending === null) {
        bursts.delete(threadId);
        return Effect.void;
      }
      const latest = burst.pending;
      burst.pending = null;
      return input
        .send(heldAgentMessageAlert({ latest, count: burst.count }))
        .pipe(Effect.andThen(openWindow(threadId)));
    });

  const offer = (message: AgentMessage): Effect.Effect<void, never, R> =>
    Effect.suspend(() => {
      if (seen.has(message.id)) return Effect.void;
      seen.add(message.id);
      if (seen.size > SEEN_LIMIT) seen.delete(seen.values().next().value!);
      const threadId = message.to.threadId;
      const burst = bursts.get(threadId);
      if (burst !== undefined) {
        burst.count += 1;
        burst.pending = message;
        return Effect.void;
      }
      bursts.set(threadId, { count: 1, pending: null });
      return input
        .send(heldAgentMessageAlert({ latest: message, count: 1 }))
        .pipe(Effect.andThen(openWindow(threadId)));
    });

  return { offer };
});

/** Watches the agent message log and alerts the user's phones when messages are held here. */
export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const agentMessages = yield* AgentMessageService.AgentMessageService;
    const relay = yield* AgentAwarenessRelay.AgentAwarenessRelay;
    const localEnvironmentId = yield* (yield* ServerEnvironment.ServerEnvironment).getEnvironmentId;
    const coalescer = yield* makeHeldAgentMessageCoalescer({
      window: HELD_AGENT_MESSAGE_COALESCE_WINDOW,
      send: relay.publishHeldAgentMessage,
    });
    yield* forkParked(
      agentMessages.subscribe().pipe(
        Stream.runForEach((event) =>
          isNewlyHeldHere(event, localEnvironmentId) ? coalescer.offer(event.message) : Effect.void,
        ),
        Effect.catchCause((cause) =>
          Effect.logWarning("Held agent message notifier stopped", { cause }),
        ),
      ),
    );
  }),
);
