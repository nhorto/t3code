import { AgentMessageId, EnvironmentId, ThreadId, type AgentMessage } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { describe, expect, it } from "vite-plus/test";

import {
  agentMessageMachineLabel,
  agentMessagePreview,
  buildAgentMessageFeed,
  buildAgentMessageListItems,
  describeAgentMessageEnvironments,
  heldAgentMessagesSummary,
  isAgentMessagesUnsupportedCause,
  type AgentMessageFeedSource,
} from "./agentMessages.logic";

const mac = EnvironmentId.make("environment-mac");
const ex = EnvironmentId.make("environment-ex");

function message(id: string, minute: number, overrides: Partial<AgentMessage> = {}): AgentMessage {
  const at = `2026-10-04T10:${String(minute).padStart(2, "0")}:00.000Z`;
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

function source(
  environmentId: EnvironmentId,
  messages: ReadonlyArray<AgentMessage> | null,
  overrides: Partial<AgentMessageFeedSource> = {},
): AgentMessageFeedSource {
  return {
    environmentId,
    feed: messages === null ? null : { messages },
    error: null,
    unsupported: false,
    ...overrides,
  };
}

const labels = (environmentId: EnvironmentId) => (environmentId === mac ? "Mac" : "EX");

describe("buildAgentMessageFeed", () => {
  it("merges machines, lists held oldest first and the rest newest first", () => {
    const view = buildAgentMessageFeed({
      sources: [
        source(mac, [
          message("mac-held-late", 9, { status: "held" }),
          message("mac-new", 8),
          message("mac-old", 1),
        ]),
        source(ex, [message("ex-held-early", 3, { status: "held" }), message("ex-mid", 5)]),
        source(EnvironmentId.make("environment-loading"), null),
      ],
      machineLabel: labels,
    });
    expect(view.held.map((row) => row.message.id)).toEqual(["ex-held-early", "mac-held-late"]);
    expect(view.recent.map((row) => row.message.id)).toEqual(["mac-new", "ex-mid", "mac-old"]);
    expect(view.held[0]).toMatchObject({ environmentId: ex, machineLabel: "EX" });
  });

  it("shows a relayed message once, from the receiving machine that can release it", () => {
    const toEx = {
      to: { environmentId: ex, threadId: ThreadId.make("thread-ex"), label: "Receiver" },
    };
    const sent = message("relayed", 4, { ...toEx, status: "delivered" });
    const received = message("relayed", 4, {
      ...toEx,
      status: "held",
      from: { ...sent.from, machine: "Mac" },
    });
    for (const sources of [
      [source(mac, [sent]), source(ex, [received])],
      [source(ex, [received]), source(mac, [sent])],
    ]) {
      const view = buildAgentMessageFeed({ sources, machineLabel: labels });
      expect(view.recent).toEqual([]);
      expect(view.held.map((row) => [row.environmentId, row.message.status])).toEqual([
        [ex, "held"],
      ]);
      expect(agentMessageMachineLabel(view.held[0]!)).toBe("Mac → EX");
    }
  });
});

describe("buildAgentMessageListItems", () => {
  it("puts held under its own header and only labels recent when both exist", () => {
    const both = buildAgentMessageListItems(
      buildAgentMessageFeed({
        sources: [source(mac, [message("held", 2, { status: "held" }), message("a", 3)])],
        machineLabel: labels,
      }),
    );
    expect(both.map((item) => (item.type === "section" ? item.label : item.key))).toEqual([
      "Held for you",
      `${mac}:held`,
      "Recent",
      `${mac}:a`,
    ]);
    expect(both[1]).toMatchObject({ held: true, isFirst: true, isLast: true });

    const recentOnly = buildAgentMessageListItems(
      buildAgentMessageFeed({
        sources: [source(mac, [message("a", 3), message("b", 4)])],
        machineLabel: labels,
      }),
    );
    expect(recentOnly.every((item) => item.type === "message")).toBe(true);
    expect(
      recentOnly.map((item) => item.type === "message" && [item.isFirst, item.isLast]),
    ).toEqual([
      [true, false],
      [false, true],
    ]);
  });
});

describe("heldAgentMessagesSummary", () => {
  it("phrases the summary for one and many", () => {
    expect(heldAgentMessagesSummary(1)).toBe("1 agent message is held for you");
    expect(heldAgentMessagesSummary(3)).toBe("3 agent messages are held for you");
  });
});

describe("isAgentMessagesUnsupportedCause", () => {
  it("treats an unknown agent message RPC as an older server, not a failure", () => {
    expect(
      isAgentMessagesUnsupportedCause(Cause.die("Unknown request tag: agentMessages.subscribe")),
    ).toBe(true);
    expect(
      isAgentMessagesUnsupportedCause(
        Cause.die(new Error("Unknown request tag: agentMessages.subscribe")),
      ),
    ).toBe(true);
    expect(
      isAgentMessagesUnsupportedCause(Cause.die("Unknown request tag: backlog.subscribe")),
    ).toBe(false);
    expect(
      isAgentMessagesUnsupportedCause(Cause.fail("Unknown request tag: agentMessages.subscribe")),
    ).toBe(false);
  });
});

describe("describeAgentMessageEnvironments", () => {
  it("names unsupported servers quietly and explains failed or offline ones", () => {
    const old = EnvironmentId.make("environment-old");
    const broken = EnvironmentId.make("environment-broken");
    const result = describeAgentMessageEnvironments({
      environments: [
        { environmentId: mac, label: "Mac", connected: true },
        { environmentId: ex, label: "EX", connected: false },
        { environmentId: old, label: "Old box", connected: true },
        { environmentId: broken, label: "Broken", connected: true },
      ],
      sources: [
        source(mac, [message("a", 1)]),
        source(ex, [message("b", 2)]),
        source(old, null, { unsupported: true }),
        source(broken, null, { error: "denied" }),
      ],
    });
    expect(result.unsupportedLabels).toEqual(["Old box"]);
    expect(result.notices).toEqual([
      { environmentId: ex, label: "EX", message: "Offline. Showing its last messages." },
      { environmentId: broken, label: "Broken", message: "denied" },
    ]);
    expect(result.loading).toBe(false);
  });

  it("is loading while a connected machine has not sent its snapshot", () => {
    expect(
      describeAgentMessageEnvironments({
        environments: [
          { environmentId: mac, label: "Mac", connected: true },
          { environmentId: ex, label: "EX", connected: false },
        ],
        sources: [source(mac, null), source(ex, null)],
      }),
    ).toEqual({
      notices: [{ environmentId: ex, label: "EX", message: "Unavailable until it reconnects." }],
      unsupportedLabels: [],
      loading: true,
    });
  });
});

describe("agentMessagePreview", () => {
  it("flattens whitespace and cuts long text at a word", () => {
    expect(agentMessagePreview("  hello\n\n  there  ")).toBe("hello there");
    expect(agentMessagePreview("alpha beta gamma delta", 15)).toBe("alpha beta…");
  });
});
