import { assert, describe, it } from "@effect/vitest";
import {
  EnvironmentId,
  ThreadId,
  type AgentMessage,
  type AgentMessageStatus,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as TestClock from "effect/testing/TestClock";

import type { HeldAgentMessageAlert } from "./AgentAwarenessRelay.ts";
import {
  HELD_AGENT_MESSAGE_COALESCE_WINDOW,
  heldAgentMessageAlert,
  isNewlyHeldHere,
  makeHeldAgentMessageCoalescer,
  previewAgentMessageText,
} from "./HeldAgentMessageNotifier.ts";

const local = EnvironmentId.make("environment-mac-mini");
const remote = EnvironmentId.make("environment-ex");

function message(
  id: string,
  input: {
    readonly to?: string;
    readonly toLabel?: string;
    readonly from?: string;
    readonly text?: string;
    readonly status?: AgentMessageStatus;
    readonly toEnvironment?: EnvironmentId;
  } = {},
): AgentMessage {
  return {
    id: id as AgentMessage["id"],
    from: {
      environmentId: local,
      threadId: ThreadId.make("thread-codex"),
      label: input.from ?? "Codex: wine search",
    },
    to: {
      environmentId: input.toEnvironment ?? local,
      threadId: ThreadId.make(input.to ?? "thread-claude"),
      label: input.toLabel ?? "Claude: paywall",
    },
    issueId: null,
    issueKey: null,
    text: input.text ?? `Message ${id}`,
    urgent: false,
    status: input.status ?? "held",
    createdAt: "2026-10-04T12:00:00.000Z" as AgentMessage["createdAt"],
    deliveredAt: null,
    error: null,
  };
}

const makeHarness = Effect.gen(function* () {
  const sent: HeldAgentMessageAlert[] = [];
  const coalescer = yield* makeHeldAgentMessageCoalescer({
    window: HELD_AGENT_MESSAGE_COALESCE_WINDOW,
    send: (alert) => Effect.sync(() => void sent.push(alert)),
  });
  return { sent, offer: coalescer.offer };
});

describe("held agent message alerts", () => {
  it("names the sender and receiver for one message and previews its text", () => {
    const alert = heldAgentMessageAlert({
      latest: message("m1", { text: "Can you\n\nrerun the  tests?" }),
      count: 1,
    });
    assert.deepStrictEqual(alert, {
      threadId: ThreadId.make("thread-claude"),
      title: "Agent message held: Codex: wine search → Claude: paywall",
      body: "Can you rerun the tests?",
      count: 1,
      messageId: "m1",
    });
  });

  it("counts a burst for the receiver", () => {
    const alert = heldAgentMessageAlert({ latest: message("m3", { text: "Third" }), count: 3 });
    assert.strictEqual(alert.title, "3 messages held for Claude: paywall");
    assert.strictEqual(alert.body, "Latest from Codex: wine search: Third");
  });

  it("cuts the preview to about 100 characters", () => {
    const preview = previewAgentMessageText("x".repeat(500));
    assert.strictEqual(preview.length, 100);
    assert.isTrue(preview.endsWith("…"));
    assert.strictEqual(previewAgentMessageText("   "), "(empty message)");
  });

  it("only treats live held upserts for this machine's threads as news", () => {
    assert.isTrue(isNewlyHeldHere({ type: "messageUpserted", message: message("m1") }, local));
    assert.isFalse(
      isNewlyHeldHere(
        { type: "messageUpserted", message: message("m1", { status: "delivered" }) },
        local,
      ),
    );
    // The sender's copy of a message held on another machine.
    assert.isFalse(
      isNewlyHeldHere(
        { type: "messageUpserted", message: message("m1", { toEnvironment: remote }) },
        local,
      ),
    );
    assert.isFalse(isNewlyHeldHere({ type: "snapshot", messages: [message("m1")] }, local));
  });
});

describe("makeHeldAgentMessageCoalescer", () => {
  it.effect("alerts the first held message at once and folds a burst into one follow-up", () =>
    Effect.gen(function* () {
      const { sent, offer } = yield* makeHarness;

      yield* offer(message("m1"));
      assert.deepStrictEqual(
        sent.map((alert) => [alert.count, alert.messageId]),
        [[1, "m1"]],
      );

      yield* TestClock.adjust("20 seconds");
      yield* offer(message("m2"));
      yield* offer(message("m3"));
      assert.strictEqual(sent.length, 1);

      yield* TestClock.adjust("40 seconds");
      assert.deepStrictEqual(
        sent.map((alert) => [alert.count, alert.messageId]),
        [
          [1, "m1"],
          [3, "m3"],
        ],
      );
      assert.strictEqual(sent[1]!.title, "3 messages held for Claude: paywall");

      // A quiet window ends the burst; the next held message alerts on its own again.
      yield* TestClock.adjust("1 minute");
      assert.strictEqual(sent.length, 2);
      yield* offer(message("m4"));
      assert.deepStrictEqual(
        sent.map((alert) => [alert.count, alert.messageId]),
        [
          [1, "m1"],
          [3, "m3"],
          [1, "m4"],
        ],
      );
    }),
  );

  it.effect("sends nothing more when a burst is a single message", () =>
    Effect.gen(function* () {
      const { sent, offer } = yield* makeHarness;
      yield* offer(message("m1"));
      yield* TestClock.adjust("5 minutes");
      assert.strictEqual(sent.length, 1);
    }),
  );

  it.effect("keeps counting a burst that runs across several windows", () =>
    Effect.gen(function* () {
      const { sent, offer } = yield* makeHarness;
      yield* offer(message("m1"));
      yield* offer(message("m2"));
      yield* TestClock.adjust("1 minute");
      yield* offer(message("m3"));
      yield* TestClock.adjust("1 minute");
      assert.deepStrictEqual(
        sent.map((alert) => alert.count),
        [1, 2, 3],
      );
    }),
  );

  it.effect("coalesces per receiver", () =>
    Effect.gen(function* () {
      const { sent, offer } = yield* makeHarness;
      yield* offer(message("m1", { to: "thread-claude" }));
      yield* offer(message("m2", { to: "thread-cursor", toLabel: "Cursor: onboarding" }));
      assert.deepStrictEqual(
        sent.map((alert) => [alert.threadId, alert.count]),
        [
          ["thread-claude", 1],
          ["thread-cursor", 1],
        ],
      );
    }),
  );

  it.effect("alerts once for a held message published again", () =>
    Effect.gen(function* () {
      const { sent, offer } = yield* makeHarness;
      // The hub redelivers a relayed message until it hears back; the log republishes it.
      yield* offer(message("m1"));
      yield* offer(message("m1"));
      yield* TestClock.adjust("1 minute");
      assert.strictEqual(sent.length, 1);
    }),
  );
});
