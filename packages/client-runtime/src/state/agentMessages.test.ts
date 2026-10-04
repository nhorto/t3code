import { AgentMessageId, EnvironmentId, ThreadId, type AgentMessage } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  AGENT_MESSAGE_FEED_LIMIT,
  EMPTY_AGENT_MESSAGE_FEED,
  countHeldAgentMessages,
  foldAgentMessageStreamEvent,
} from "./agentMessages.ts";

const environmentId = EnvironmentId.make("environment-a");

function message(id: string, minute: number, overrides: Partial<AgentMessage> = {}): AgentMessage {
  const hour = String(10 + Math.floor(minute / 60)).padStart(2, "0");
  const at = `2026-10-04T${hour}:${String(minute % 60).padStart(2, "0")}:00.000Z`;
  return {
    id: AgentMessageId.make(id),
    from: { environmentId, threadId: ThreadId.make("thread-codex"), label: "Paywall · gpt-5" },
    to: { environmentId, threadId: ThreadId.make("thread-claude"), label: "Onboarding" },
    issueId: null,
    issueKey: null,
    text: `message ${id}`,
    urgent: false,
    status: "delivered",
    createdAt: at,
    deliveredAt: at,
    error: null,
    ...overrides,
  };
}

describe("foldAgentMessageStreamEvent", () => {
  it("orders the snapshot newest first and applies upserts in place", () => {
    const snapshot = foldAgentMessageStreamEvent(EMPTY_AGENT_MESSAGE_FEED, {
      type: "snapshot",
      messages: [message("a", 1), message("b", 3, { status: "held", deliveredAt: null })],
    });
    expect(snapshot.messages.map((entry) => entry.id)).toEqual(["b", "a"]);
    expect(countHeldAgentMessages(snapshot)).toBe(1);

    const released = foldAgentMessageStreamEvent(snapshot, {
      type: "messageUpserted",
      message: message("b", 3, { status: "released" }),
    });
    expect(released.messages.map((entry) => [entry.id, entry.status])).toEqual([
      ["b", "released"],
      ["a", "delivered"],
    ]);
    expect(countHeldAgentMessages(released)).toBe(0);

    const added = foldAgentMessageStreamEvent(released, {
      type: "messageUpserted",
      message: message("c", 5),
    });
    expect(added.messages.map((entry) => entry.id)).toEqual(["c", "b", "a"]);
  });

  it("trims the oldest settled messages past the limit but keeps held ones", () => {
    const held = message("held", 0, { status: "held", deliveredAt: null });
    let state = foldAgentMessageStreamEvent(EMPTY_AGENT_MESSAGE_FEED, {
      type: "snapshot",
      messages: [held],
    });
    for (let index = 1; index <= AGENT_MESSAGE_FEED_LIMIT + 5; index++) {
      state = foldAgentMessageStreamEvent(state, {
        type: "messageUpserted",
        message: message(`m${index}`, index),
      });
    }
    expect(state.messages).toHaveLength(AGENT_MESSAGE_FEED_LIMIT + 1);
    expect(state.messages.at(-1)?.id).toBe("held");
    expect(state.messages.some((entry) => entry.id === "m5")).toBe(false);
    expect(state.messages.some((entry) => entry.id === "m6")).toBe(true);
  });
});
