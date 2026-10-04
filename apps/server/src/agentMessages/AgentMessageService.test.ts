import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { assert, it } from "@effect/vitest";
import {
  AGENT_MESSAGE_WAKES_PER_HOUR,
  EnvironmentId,
  ProjectId,
  ThreadId,
  type AgentMessageStreamEvent,
  type BacklogActor,
  type ExecutionEnvironmentDescriptor,
  type OrchestrationV2ThreadShell,
  type RuntimeMode,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import * as BacklogService from "../backlog/BacklogService.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import * as ProjectService from "../project/ProjectService.ts";
import {
  AgentMessageService,
  formatAgentMessageForDelivery,
  layer,
  type AgentMessageSender,
} from "./AgentMessageService.ts";

const environmentId = EnvironmentId.make("environment-mac-mini");
const remoteEnvironmentId = EnvironmentId.make("environment-ex");

interface FakeThread {
  readonly projectId: string;
  readonly title: string;
  readonly runtimeMode: RuntimeMode;
  /** A busy thread has a running turn: default messages queue, urgent ones steer. */
  readonly busy: boolean;
}

const threads: Record<string, FakeThread> = {
  "thread-codex": {
    projectId: "project-wine",
    title: "Paywall",
    runtimeMode: "full-access",
    busy: false,
  },
  "thread-claude": {
    projectId: "project-wine",
    title: "Onboarding",
    runtimeMode: "full-access",
    busy: false,
  },
  "thread-other-project": {
    projectId: "project-notes",
    title: "Notes sync",
    runtimeMode: "full-access",
    busy: false,
  },
  "thread-busy": {
    projectId: "project-notes",
    title: "Long refactor",
    runtimeMode: "full-access",
    busy: true,
  },
  "thread-readonly": {
    projectId: "project-notes",
    title: "Reviewer",
    runtimeMode: "approval-required",
    busy: false,
  },
};

interface SentCall {
  readonly threadId: string;
  readonly mode: string;
  readonly senderThreadId: string | undefined;
  readonly text: string;
}

const makeLayer = (sent: SentCall[]) => {
  const threadManagement = Layer.mock(ThreadManagementService.ThreadManagementService)({
    getThreadShell: (threadId) => {
      const thread = threads[threadId];
      return Effect.succeed(
        thread === undefined
          ? null
          : ({
              id: threadId,
              projectId: ProjectId.make(thread.projectId),
              title: thread.title,
              runtimeMode: thread.runtimeMode,
              activeRunId: "run-1",
              archivedAt: null,
              deletedAt: null,
            } as unknown as OrchestrationV2ThreadShell),
      );
    },
    sendToThread: (input) =>
      Effect.sync(() => {
        sent.push({
          threadId: input.threadId,
          mode: input.mode,
          senderThreadId: input.senderThreadId,
          text: input.text,
        });
        const busy = threads[input.threadId]?.busy ?? false;
        return {
          delivery: !busy ? "started" : input.mode === "auto" ? "steered" : "queued",
        } as ThreadManagementService.ThreadManagementSendResult;
      }),
    streamDomainEvents: Stream.never,
  });
  const backlog = BacklogService.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        threadManagement,
        Layer.mock(ProjectService.ProjectService)({
          getShell: () => Effect.succeed(Option.none()),
        }),
      ),
    ),
  );
  return Layer.mergeAll(
    layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          threadManagement,
          backlog,
          Layer.mock(ServerEnvironment.ServerEnvironment)({
            getEnvironmentId: Effect.succeed(environmentId),
            getDescriptor: Effect.succeed({
              environmentId,
              label: "Mac Mini",
            } as ExecutionEnvironmentDescriptor),
          }),
        ),
      ),
    ),
    backlog,
  ).pipe(Layer.provide(Layer.mergeAll(NodeCrypto.layer, SqlitePersistenceMemory)));
};

const run = <A, E>(
  body: (
    sent: SentCall[],
  ) => Effect.Effect<A, E, AgentMessageService | BacklogService.BacklogService>,
) => {
  const sent: SentCall[] = [];
  return body(sent).pipe(Effect.provide(makeLayer(sent)));
};

const sender = (
  threadId: string,
  runtimeMode: RuntimeMode = "full-access",
): AgentMessageSender => ({
  environmentId,
  threadId: ThreadId.make(threadId),
  label: `${threads[threadId]?.title ?? threadId} · gpt-5`,
  runtimeMode,
});

const holder = (threadId: string, env: EnvironmentId = environmentId): BacklogActor => ({
  kind: "agent",
  environmentId: env,
  threadId: ThreadId.make(threadId),
  label: threadId,
});
const user: BacklogActor = { kind: "user", environmentId, threadId: null, label: "You" };

it.effect("messages a thread in another project and wraps the text with how to reply", () =>
  run((sent) =>
    Effect.gen(function* () {
      const service = yield* AgentMessageService;
      const [outcome] = yield* service.send(
        {
          target: { type: "thread", threadId: ThreadId.make("thread-other-project") },
          text: "Schema landed.",
        },
        sender("thread-codex"),
      );
      assert.equal(outcome?.message.status, "delivered");
      assert.equal(outcome?.message.to.label, "Notes sync");
      assert.equal(outcome?.delivery, "started");
      assert.deepEqual(
        sent.map((call) => [call.threadId, call.mode, call.senderThreadId]),
        [["thread-other-project", "queue", "thread-codex"]],
      );
      assert.equal(sent[0]?.text, formatAgentMessageForDelivery(outcome!.message, "Mac Mini"));
      assert.include(sent[0]!.text, "Paywall · gpt-5 on Mac Mini (thread thread-codex)");
      assert.include(sent[0]!.text, "Reply with the agent_message tool to threadId thread-codex.");
      assert.isTrue(sent[0]!.text.endsWith("\n\nSchema landed."));

      const missing = yield* service
        .send(
          { target: { type: "thread", threadId: ThreadId.make("thread-gone") }, text: "Hi" },
          sender("thread-codex"),
        )
        .pipe(Effect.flip);
      assert.equal(missing.code, "not_found");
      const remote = yield* service
        .send(
          {
            target: {
              type: "thread",
              threadId: ThreadId.make("thread-elsewhere"),
              environmentId: remoteEnvironmentId,
            },
            text: "Hi",
          },
          sender("thread-codex"),
        )
        .pipe(Effect.flip);
      assert.equal(remote.code, "remote");
      assert.include(remote.message, "fleet messaging");
    }),
  ),
);

it.effect("reaches an issue's holder and explains an unclaimed issue", () =>
  run((sent) =>
    Effect.gen(function* () {
      const backlog = yield* BacklogService.BacklogService;
      const service = yield* AgentMessageService;
      const claimed = yield* backlog.createIssue({ title: "Paywall", status: "ready" }, user);
      const unclaimed = yield* backlog.createIssue({ title: "Icons", status: "ready" }, user);
      yield* backlog.claim({ issueId: claimed.id }, holder("thread-claude"));

      const [outcome] = yield* service.send(
        { target: { type: "issue", issue: claimed.key.toLowerCase() }, text: "Which SDK?" },
        sender("thread-codex"),
      );
      assert.equal(outcome?.message.to.threadId, "thread-claude");
      assert.equal(outcome?.message.issueKey, claimed.key);
      assert.include(sent[0]!.text, `about ${claimed.key}`);

      const nobody = yield* service
        .send(
          { target: { type: "issue", issue: unclaimed.key }, text: "Hi" },
          sender("thread-codex"),
        )
        .pipe(Effect.flip);
      assert.equal(nobody.code, "not_found");
      assert.include(nobody.message, "not claimed");

      const self = yield* service
        .send(
          { target: { type: "issue", issue: claimed.key }, text: "Hi" },
          sender("thread-claude"),
        )
        .pipe(Effect.flip);
      assert.equal(self.code, "invalid");
    }),
  ),
);

it.effect(
  "broadcasts a spec to every claimed child's holder and the spec's, except the sender",
  () =>
    run((sent) =>
      Effect.gen(function* () {
        const backlog = yield* BacklogService.BacklogService;
        const service = yield* AgentMessageService;
        const spec = yield* backlog.createIssue({ title: "Onboarding", status: "ready" }, user);
        const children = yield* backlog.createChildren(
          {
            parentId: spec.id,
            children: [
              { title: "A", status: "ready" },
              { title: "B", status: "ready" },
              { title: "C", status: "ready" },
              { title: "Unclaimed", status: "ready" },
            ],
          },
          user,
        );
        yield* backlog.claim({ issueId: spec.id }, holder("thread-claude"));
        yield* backlog.claim({ issueId: children[0]!.id }, holder("thread-other-project"));
        yield* backlog.claim({ issueId: children[1]!.id }, holder("thread-codex"));
        // A second claim by the same thread is still one receiver.
        yield* backlog.claim({ issueId: children[2]!.id }, holder("thread-other-project"));

        const outcomes = yield* service.send(
          { target: { type: "spec", issue: spec.key }, text: "We switched to RevenueCat." },
          sender("thread-codex"),
        );
        assert.deepEqual(
          outcomes.map((outcome) => [outcome.message.to.threadId, outcome.message.issueKey]),
          [
            ["thread-other-project", spec.key],
            ["thread-claude", spec.key],
          ],
        );
        assert.deepEqual(
          sent.map((call) => call.threadId),
          ["thread-other-project", "thread-claude"],
        );
      }),
    ),
);

it.effect("queues for a busy receiver by default and steers when urgent", () =>
  run((sent) =>
    Effect.gen(function* () {
      const service = yield* AgentMessageService;
      const target = { type: "thread", threadId: ThreadId.make("thread-busy") } as const;
      const [queued] = yield* service.send(
        { target, text: "When you can." },
        sender("thread-codex"),
      );
      const [steered] = yield* service.send(
        { target, text: "Stop, the API changed.", urgent: true },
        sender("thread-codex"),
      );
      assert.equal(queued?.delivery, "queued");
      assert.equal(steered?.delivery, "steered");
      assert.isTrue(steered?.message.urgent);
      assert.deepEqual(
        sent.map((call) => call.mode),
        ["queue", "auto"],
      );
      assert.isTrue(sent[1]!.text.startsWith("Urgent message from another agent"));
    }),
  ),
);

it.effect("does not let a narrower sandbox wake a broader one", () =>
  run((sent) =>
    Effect.gen(function* () {
      const service = yield* AgentMessageService;
      const denied = yield* service
        .send(
          {
            target: { type: "thread", threadId: ThreadId.make("thread-codex") },
            text: "Run this.",
          },
          sender("thread-readonly", "approval-required"),
        )
        .pipe(Effect.flip);
      assert.equal(denied.code, "denied");
      assert.lengthOf(sent, 0);
    }),
  ),
);

it.effect("holds the 11th wake in an hour until the user releases it, then the window rolls", () =>
  run((sent) =>
    Effect.gen(function* () {
      const service = yield* AgentMessageService;
      const target = { type: "thread", threadId: ThreadId.make("thread-claude") } as const;
      for (let index = 0; index < AGENT_MESSAGE_WAKES_PER_HOUR; index++) {
        yield* TestClock.adjust("1 minute");
        const [outcome] = yield* service.send(
          { target, text: `ping ${index}` },
          sender("thread-codex"),
        );
        assert.equal(outcome?.message.status, "delivered");
      }
      const [held] = yield* service.send({ target, text: "ping 10" }, sender("thread-codex"));
      assert.equal(held?.message.status, "held");
      assert.isNull(held?.message.deliveredAt);
      assert.lengthOf(sent, AGENT_MESSAGE_WAKES_PER_HOUR);
      // Later messages wait behind the held one so the receiver never sees them out of order.
      yield* TestClock.adjust("2 hours");
      const [behind] = yield* service.send({ target, text: "ping 11" }, sender("thread-codex"));
      assert.equal(behind?.message.status, "held");

      const released = yield* service.release({ id: held!.message.id });
      assert.equal(released.status, "released");
      assert.isNotNull(released.deliveredAt);
      assert.include(sent.at(-1)!.text, "ping 10");
      const again = yield* service.release({ id: held!.message.id }).pipe(Effect.flip);
      assert.equal(again.code, "conflict");

      const dismissed = yield* service.dismiss({ id: behind!.message.id });
      assert.equal(dismissed.status, "dismissed");
      assert.lengthOf(sent, AGENT_MESSAGE_WAKES_PER_HOUR + 1);

      // Nothing is held now and the earlier wakes are over an hour old.
      const [fresh] = yield* service.send({ target, text: "ping 12" }, sender("thread-codex"));
      assert.equal(fresh?.message.status, "delivered");
    }),
  ),
);

it.effect("a user message resets the guard and releases what was held", () =>
  run((sent) =>
    Effect.gen(function* () {
      const service = yield* AgentMessageService;
      const target = { type: "thread", threadId: ThreadId.make("thread-claude") } as const;
      for (let index = 0; index < AGENT_MESSAGE_WAKES_PER_HOUR + 2; index++) {
        yield* service.send({ target, text: `ping ${index}` }, sender("thread-codex"));
      }
      assert.lengthOf(sent, AGENT_MESSAGE_WAKES_PER_HOUR);

      yield* TestClock.adjust("1 second");
      const released = yield* service.noteUserMessage(target.threadId, yield* DateTime.now);
      assert.deepEqual(
        released.map((message) => [message.text, message.status]),
        [
          ["ping 10", "released"],
          ["ping 11", "released"],
        ],
      );
      assert.lengthOf(sent, AGENT_MESSAGE_WAKES_PER_HOUR + 2);
      yield* TestClock.adjust("1 second");
      const [next] = yield* service.send({ target, text: "after" }, sender("thread-codex"));
      assert.equal(next?.message.status, "delivered");
    }),
  ),
);

it.effect("streams a snapshot of the log, then each change", () =>
  run(() =>
    Effect.gen(function* () {
      const service = yield* AgentMessageService;
      const target = { type: "thread", threadId: ThreadId.make("thread-claude") } as const;
      yield* service.send({ target, text: "first" }, sender("thread-codex"));

      const subscribed = yield* Deferred.make<void>();
      const collected = yield* service.subscribe().pipe(
        Stream.tap((event) =>
          event.type === "snapshot" ? Deferred.succeed(subscribed, undefined) : Effect.void,
        ),
        Stream.take(2),
        Stream.runCollect,
        Effect.forkChild,
      );
      yield* Deferred.await(subscribed);
      yield* service.send({ target, text: "second" }, sender("thread-codex"));

      const describe = (event: AgentMessageStreamEvent) =>
        event.type === "snapshot"
          ? `snapshot ${event.messages.map((message) => message.text).join(",")}`
          : `upserted ${event.message.text} ${event.message.status}`;
      assert.deepEqual(Array.from(yield* Fiber.join(collected), describe), [
        "snapshot first",
        "upserted second delivered",
      ]);
    }),
  ),
);
