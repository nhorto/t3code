import { AgentMessageId, EnvironmentId, ThreadId, type AgentMessage } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  agentMessagePreview,
  buildAgentMessageFeed,
  countHeldAgentMessageRows,
} from "./agentMessages.logic";

const mac = EnvironmentId.make("environment-mac");
const ex = EnvironmentId.make("environment-ex");

function message(id: string, minute: number, overrides: Partial<AgentMessage> = {}): AgentMessage {
  const hour = String(10 + Math.floor(minute / 60)).padStart(2, "0");
  const at = `2026-10-04T${hour}:${String(minute % 60).padStart(2, "0")}:00.000Z`;
  return {
    id: AgentMessageId.make(id),
    from: { environmentId: mac, threadId: ThreadId.make("thread-a"), label: "A" },
    to: { environmentId: mac, threadId: ThreadId.make("thread-b"), label: "B" },
    issueId: null,
    issueKey: null,
    text: id,
    urgent: false,
    status: "delivered",
    createdAt: at,
    deliveredAt: at,
    error: null,
    ...overrides,
  };
}

describe("buildAgentMessageFeed", () => {
  it("merges machines, lists held oldest first and the rest newest first", () => {
    const sources = [
      {
        environmentId: mac,
        feed: {
          messages: [
            message("mac-held-late", 9, { status: "held" }),
            message("mac-new", 8),
            message("mac-old", 1),
          ],
        },
      },
      {
        environmentId: ex,
        feed: { messages: [message("ex-held-early", 2, { status: "held" }), message("ex", 5)] },
      },
      { environmentId: EnvironmentId.make("environment-loading"), feed: null },
    ];
    const view = buildAgentMessageFeed({
      sources,
      machineLabel: (environmentId) => (environmentId === mac ? "Mac Mini" : "EX"),
    });
    expect(view.held.map((row) => [row.message.id, row.machineLabel])).toEqual([
      ["ex-held-early", "EX"],
      ["mac-held-late", "Mac Mini"],
    ]);
    expect(view.recent.map((row) => row.message.id)).toEqual(["mac-new", "ex", "mac-old"]);
    expect(countHeldAgentMessageRows(sources)).toBe(2);
  });
});

describe("agentMessagePreview", () => {
  it("collapses whitespace and cuts long text at a word", () => {
    expect(agentMessagePreview("Schema\n\nlanded.  Go ahead.")).toBe("Schema landed. Go ahead.");
    expect(agentMessagePreview("one two three four five", 16)).toBe("one two three…");
  });
});
