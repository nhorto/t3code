import { WS_METHODS, type AgentMessage, type AgentMessageStreamEvent } from "@t3tools/contracts";
import * as Stream from "effect/Stream";
import type { Atom } from "effect/unstable/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import {
  createAtomCommandScheduler,
  createEnvironmentRpcCommand,
  createEnvironmentRpcSubscriptionAtomFamily,
} from "./runtime.ts";

/** Messages kept per environment beyond the held ones, matching the server's snapshot. */
export const AGENT_MESSAGE_FEED_LIMIT = 200;

/** One environment's agent message log, newest first. */
export interface AgentMessageFeedState {
  readonly messages: ReadonlyArray<AgentMessage>;
}

export const EMPTY_AGENT_MESSAGE_FEED: AgentMessageFeedState = { messages: [] };

const newestFirst = (left: AgentMessage, right: AgentMessage) =>
  left.createdAt === right.createdAt ? 0 : left.createdAt < right.createdAt ? 1 : -1;

/** Drops the oldest settled messages past the limit; held ones always stay. */
function trimFeed(messages: ReadonlyArray<AgentMessage>): ReadonlyArray<AgentMessage> {
  if (messages.length <= AGENT_MESSAGE_FEED_LIMIT) return messages;
  let kept = 0;
  return messages.filter(
    (message) => message.status === "held" || ++kept <= AGENT_MESSAGE_FEED_LIMIT,
  );
}

/** Apply one stream event. */
export function foldAgentMessageStreamEvent(
  state: AgentMessageFeedState,
  event: AgentMessageStreamEvent,
): AgentMessageFeedState {
  switch (event.type) {
    case "snapshot":
      return { messages: [...event.messages].sort(newestFirst) };
    case "messageUpserted": {
      const exists = state.messages.some((message) => message.id === event.message.id);
      const messages = exists
        ? state.messages.map((message) =>
            message.id === event.message.id ? event.message : message,
          )
        : [event.message, ...state.messages].sort(newestFirst);
      return { messages: trimFeed(messages) };
    }
  }
}

export function countHeldAgentMessages(state: AgentMessageFeedState | null): number {
  return state === null ? 0 : state.messages.filter((message) => message.status === "held").length;
}

export function createAgentMessageEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  const scheduler = createAtomCommandScheduler();
  const serialPerEnvironment = {
    mode: "serial",
    key: ({ environmentId }: { readonly environmentId: string }) => environmentId,
  } as const;

  return {
    /** Live log for one environment: recent messages and every held one. */
    feed: createEnvironmentRpcSubscriptionAtomFamily(runtime, {
      label: "environment-data:agent-messages:feed",
      tag: WS_METHODS.agentMessagesSubscribe,
      // Drop scan's seed so the feed stays loading until the snapshot, never falsely empty.
      transform: (stream) =>
        stream.pipe(
          Stream.scan(EMPTY_AGENT_MESSAGE_FEED, foldAgentMessageStreamEvent),
          Stream.drop(1),
        ),
    }),
    /** Held messages only, for badges; much lighter than the feed. */
    heldCount: createEnvironmentRpcSubscriptionAtomFamily(runtime, {
      label: "environment-data:agent-messages:held-count",
      tag: WS_METHODS.agentMessagesSubscribeHeldCount,
    }),
    release: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:agent-messages:release",
      tag: WS_METHODS.agentMessagesRelease,
      scheduler,
      concurrency: serialPerEnvironment,
    }),
    dismiss: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:agent-messages:dismiss",
      tag: WS_METHODS.agentMessagesDismiss,
      scheduler,
      concurrency: serialPerEnvironment,
    }),
  };
}
