import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { assert, it } from "@effect/vitest";
import {
  AGENT_MESSAGE_HELD_PER_THREAD,
  AGENT_MESSAGE_MAX_TEXT_LENGTH,
  AGENT_MESSAGE_WAKES_PER_HOUR,
  EnvironmentId,
  ProjectId,
  ThreadId,
  type AgentMessage,
  type AgentMessageStreamEvent,
  type BacklogActor,
  type ExecutionEnvironmentDescriptor,
  type ProviderInteractionMode,
  type RuntimeMode,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { localBacklogHome, type BacklogHome } from "../backlog/BacklogHome.ts";
import * as BacklogHubClient from "../backlog/BacklogHubClient.ts";
import { BacklogOrchestration, type BacklogThread } from "../backlog/BacklogOrchestration.ts";
import * as BacklogRouter from "../backlog/BacklogRouter.ts";
import * as BacklogService from "../backlog/BacklogService.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import * as AgentMessageRelay from "./AgentMessageRelay.ts";
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
  readonly interactionMode?: ProviderInteractionMode;
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
  "thread-planner": {
    projectId: "project-notes",
    title: "Planner",
    runtimeMode: "full-access",
    interactionMode: "plan",
    busy: false,
  },
};

/** A thread whose modes a test changes while messages wait for it. */
const switching: { -readonly [K in keyof FakeThread]: FakeThread[K] } = {
  projectId: "project-notes",
  title: "Switching",
  runtimeMode: "approval-required",
  busy: false,
};
threads["thread-switching"] = switching;

interface SentCall {
  readonly threadId: string;
  /** queue: waits for a busy thread's turn to end. auto: steers into it. */
  readonly mode: "queue" | "auto";
  readonly text: string;
}

/** A hub as a linked machine's fake client sees it: the hub's real services. */
interface FakeHub {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly backlog: BacklogService.BacklogService["Service"];
  readonly relay: AgentMessageRelay.AgentMessageRelay["Service"];
  /** Whether this machine can reach the hub right now. */
  readonly reachable: { current: boolean };
}

const fakeOrchestration = (
  machineThreads: Record<string, FakeThread>,
  sent: SentCall[],
  deliveries: Queue.Queue<SentCall>,
) =>
  Layer.mock(BacklogOrchestration)({
    getThread: (threadId) => {
      const thread = machineThreads[threadId];
      return Effect.succeed(
        thread === undefined
          ? null
          : ({
              id: threadId,
              projectId: ProjectId.make(thread.projectId),
              title: thread.title,
              model: "gpt-5",
              runtimeMode: thread.runtimeMode,
              interactionMode: thread.interactionMode ?? "default",
              archived: false,
              running: true,
              lastActiveAtMs: 0,
            } satisfies BacklogThread),
      );
    },
    getProject: () => Effect.succeed(Option.none()),
    deliver: (input) =>
      Effect.gen(function* () {
        const call: SentCall = {
          threadId: input.threadId,
          mode: input.urgent ? "auto" : "queue",
          text: input.text,
        };
        sent.push(call);
        yield* Queue.offer(deliveries, call);
        const busy = machineThreads[input.threadId]?.busy ?? false;
        return !busy ? "started" : input.urgent ? "steered" : "queued";
      }),
    userMessages: Stream.never,
  });

const hubDown = () => BacklogHubClient.unavailable("unreachable", "Geekom is unreachable.");

/** The fake fleet link: what the hub's RPC handlers would call, in process. */
const fakeHubClient = (hub: FakeHub | null) =>
  Layer.mock(BacklogHubClient.BacklogHubClient)({
    linkedHub: Effect.succeed(
      hub === null
        ? Option.none()
        : Option.some({ environmentId: hub.environmentId, label: hub.label }),
    ),
    home: hub === null ? ({} as BacklogHome) : localBacklogHome(hub.backlog),
    relayAgentMessage: (envelope) =>
      hub === null || !hub.reachable.current ? Effect.fail(hubDown()) : hub.relay.relay(envelope),
    ackAgentMessage: (input) =>
      hub === null || !hub.reachable.current ? Effect.fail(hubDown()) : hub.relay.ack(input),
    agentMessageInbox: (input) =>
      Stream.unwrap(
        Effect.sync(() =>
          hub === null || !hub.reachable.current
            ? Stream.fail(hubDown())
            : hub.relay.inbox(input).pipe(Stream.mapError(hubDown)),
        ),
      ),
  });

/** Issues resolve here first, then on the hub, as BacklogRouter does. */
const fakeRouter = (hub: FakeHub | null) =>
  Layer.effect(
    BacklogRouter.BacklogRouter,
    Effect.gen(function* () {
      const local = yield* BacklogService.BacklogService;
      const getIssue = (ref: string) =>
        local.resolveIssueRef(ref).pipe(
          Effect.flatMap((issueId) => local.getIssue({ issueId })),
          Effect.catchIf(
            (error) => error.code === "not_found" && hub !== null,
            () =>
              hub!.backlog
                .resolveIssueRef(ref)
                .pipe(Effect.flatMap((issueId) => hub!.backlog.getIssue({ issueId }))),
          ),
        );
      return { getIssue } as unknown as BacklogRouter.BacklogRouter["Service"];
    }),
  );

/** One machine's agent messaging, with its own database and threads. */
const machineLayer = (options: {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly threads: Record<string, FakeThread>;
  readonly hub: FakeHub | null;
  readonly sent: SentCall[];
  readonly deliveries: Queue.Queue<SentCall>;
}) => {
  const threadManagement = fakeOrchestration(options.threads, options.sent, options.deliveries);
  return layer.pipe(
    Layer.provideMerge(Layer.mergeAll(AgentMessageRelay.layer, fakeRouter(options.hub))),
    Layer.provideMerge(BacklogService.layer),
    Layer.provideMerge(
      Layer.mergeAll(
        threadManagement,
        fakeHubClient(options.hub),
        Layer.mock(ServerEnvironment.ServerEnvironment)({
          getEnvironmentId: Effect.succeed(options.environmentId),
          getDescriptor: Effect.succeed({
            environmentId: options.environmentId,
            label: options.label,
          } as ExecutionEnvironmentDescriptor),
        }),
      ),
    ),
    Layer.provideMerge(Layer.mergeAll(NodeCrypto.layer, SqlitePersistenceMemory)),
  );
};

const run = <A, E>(
  body: (
    sent: SentCall[],
  ) => Effect.Effect<A, E, AgentMessageService | BacklogService.BacklogService>,
) =>
  Effect.gen(function* () {
    const sent: SentCall[] = [];
    const deliveries = yield* Queue.unbounded<SentCall>();
    return yield* body(sent).pipe(
      Effect.provide(
        machineLayer({
          environmentId,
          label: "Mac Mini",
          threads,
          hub: null,
          sent,
          deliveries,
        }),
      ),
    );
  });

const sender = (
  threadId: string,
  runtimeMode: RuntimeMode = "full-access",
  interactionMode: ProviderInteractionMode = "default",
): AgentMessageSender => ({
  environmentId,
  threadId: ThreadId.make(threadId),
  label: `${threads[threadId]?.title ?? threadId} · gpt-5`,
  runtimeMode,
  interactionMode,
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
        sent.map((call) => [call.threadId, call.mode]),
        [["thread-other-project", "queue"]],
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
      assert.include(remote.message, "not linked with this one");
      assert.include(remote.message, "Settings → Backlog");
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

      // A planning thread may wake another planning thread, but not one that edits.
      const planning = sender("thread-planner", "full-access", "plan");
      const editing = yield* service
        .send(
          { target: { type: "thread", threadId: ThreadId.make("thread-codex") }, text: "Go." },
          planning,
        )
        .pipe(Effect.flip);
      assert.equal(editing.code, "denied");
      assert.include(editing.message, "plan mode");
      assert.lengthOf(sent, 0);
      const [planned] = yield* service.send(
        { target: { type: "thread", threadId: ThreadId.make("thread-codex") }, text: "Plan." },
        sender("thread-planner", "full-access", "default"),
      );
      assert.equal(planned?.message.status, "delivered");
    }),
  ),
);

it.effect("refuses messages that are too long, and more than the held cap for one thread", () =>
  run((sent) =>
    Effect.gen(function* () {
      const service = yield* AgentMessageService;
      const target = { type: "thread", threadId: ThreadId.make("thread-claude") } as const;
      const tooLong = yield* service
        .send(
          { target, text: "x".repeat(AGENT_MESSAGE_MAX_TEXT_LENGTH + 1) },
          sender("thread-codex"),
        )
        .pipe(Effect.flip);
      assert.equal(tooLong.code, "invalid");

      for (
        let index = 0;
        index < AGENT_MESSAGE_WAKES_PER_HOUR + AGENT_MESSAGE_HELD_PER_THREAD;
        index++
      ) {
        yield* service.send({ target, text: `ping ${index}` }, sender("thread-codex"));
      }
      const overflow = yield* service
        .send({ target, text: "one more" }, sender("thread-codex"))
        .pipe(Effect.flip);
      assert.equal(overflow.code, "conflict");
      assert.include(overflow.message, `${AGENT_MESSAGE_HELD_PER_THREAD} messages waiting`);
      assert.lengthOf(sent, AGENT_MESSAGE_WAKES_PER_HOUR);
    }),
  ),
);

it.effect("a user message does not release held messages the sender may no longer send", () =>
  run((sent) =>
    Effect.gen(function* () {
      const service = yield* AgentMessageService;
      switching.runtimeMode = "approval-required";
      const target = { type: "thread", threadId: ThreadId.make("thread-switching") } as const;
      const narrow = sender("thread-readonly", "approval-required");
      for (let index = 0; index <= AGENT_MESSAGE_WAKES_PER_HOUR; index++) {
        yield* service.send({ target, text: `ping ${index}` }, narrow);
      }
      assert.lengthOf(sent, AGENT_MESSAGE_WAKES_PER_HOUR);
      // The receiver now runs with full access, which the sender cannot reach.
      switching.runtimeMode = "full-access";
      yield* TestClock.adjust("1 second");
      const released = yield* service.noteUserMessage(target.threadId, yield* DateTime.now);
      assert.lengthOf(released, 0);
      assert.lengthOf(sent, AGENT_MESSAGE_WAKES_PER_HOUR);
      const [snapshot] = yield* service.subscribe().pipe(Stream.take(1), Stream.runCollect);
      const refused =
        snapshot?.type === "snapshot"
          ? snapshot.messages.find(
              (message) => message.text === `ping ${AGENT_MESSAGE_WAKES_PER_HOUR}`,
            )
          : undefined;
      assert.equal(refused?.status, "failed");
      assert.include(refused?.error ?? "", "narrower permissions");
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

// Across the fleet: the Geekom is the hub; the EX and the Mac Mini are linked to it.

const geekom = EnvironmentId.make("environment-geekom");
const ex = remoteEnvironmentId;
const macMini = environmentId;

const fleetThread = (title: string): FakeThread => ({
  projectId: "project-wine",
  title,
  runtimeMode: "full-access",
  busy: false,
});

const buildMachine = (options: {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly threads: Record<string, FakeThread>;
  readonly hub: FakeHub | null;
}) =>
  Effect.gen(function* () {
    const sent: SentCall[] = [];
    const deliveries = yield* Queue.unbounded<SentCall>();
    const context = yield* Layer.build(machineLayer({ ...options, sent, deliveries }));
    return {
      service: Context.get(context, AgentMessageService),
      backlog: Context.get(context, BacklogService.BacklogService),
      relay: Context.get(context, AgentMessageRelay.AgentMessageRelay),
      sql: Context.get(context, SqlClient.SqlClient),
      sent,
      deliveries,
    };
  });

const fleet = (options: { readonly macReachable: boolean }) =>
  Effect.gen(function* () {
    const hub = yield* buildMachine({
      environmentId: geekom,
      label: "Geekom",
      threads: { "thread-geekom": fleetThread("Release") },
      hub: null,
    });
    const linkTo = (reachable: boolean): FakeHub => ({
      environmentId: geekom,
      label: "Geekom",
      backlog: hub.backlog,
      relay: hub.relay,
      reachable: { current: reachable },
    });
    const macLink = linkTo(options.macReachable);
    const exMachine = yield* buildMachine({
      environmentId: ex,
      label: "EX",
      threads: { "thread-ex": fleetThread("Paywall") },
      hub: linkTo(true),
    });
    const mac = yield* buildMachine({
      environmentId: macMini,
      label: "Mac Mini",
      threads: { "thread-mac": fleetThread("Onboarding") },
      hub: macLink,
    });
    // Both spokes have opened their inbox on the hub before, so the hub knows them.
    for (const [id, label] of [
      [ex, "EX"],
      [macMini, "Mac Mini"],
    ] as const) {
      yield* hub.sql`
        INSERT OR IGNORE INTO agent_message_relay_machines (environment_id, label, last_seen_at)
        VALUES (${id}, ${label}, '1970-01-01T00:00:00.000Z')
      `;
    }
    return { hub, ex: exMachine, mac, macLink };
  });

type Machine = Effect.Success<ReturnType<typeof buildMachine>>;

const fleetSender = (env: EnvironmentId, threadId: string, title: string): AgentMessageSender => ({
  environmentId: env,
  threadId: ThreadId.make(threadId),
  label: `${title} · gpt-5`,
  runtimeMode: "full-access",
  interactionMode: "default",
});
const exAgent = fleetSender(ex, "thread-ex", "Paywall");
const macAgent = fleetSender(macMini, "thread-mac", "Onboarding");

/** The machine's copy of a message once it reaches the status. */
const awaitStatus = (machine: Machine, id: string, status: AgentMessage["status"]) =>
  machine.service.subscribe().pipe(
    Stream.flatMap((event) =>
      Stream.fromIterable(event.type === "snapshot" ? event.messages : [event.message]),
    ),
    Stream.filter((message) => message.id === id && message.status === status),
    Stream.runHead,
    Effect.map(Option.getOrThrow),
  );

it.effect(
  "an agent on one spoke wakes an issue's holder on another, and the reply comes back",
  () =>
    Effect.gen(function* () {
      const { hub, ex: exMachine, mac } = yield* fleet({ macReachable: true });
      // The issue lives on the hub; the Mac Mini's thread holds it.
      const issue = yield* hub.backlog.createIssue({ title: "Paywall", status: "ready" }, user);
      yield* hub.backlog.claim({ issueId: issue.id }, holder("thread-mac", macMini));

      const [outcome] = yield* exMachine.service.send(
        { target: { type: "issue", issue: issue.key }, text: "Which SDK?" },
        exAgent,
      );
      assert.equal(outcome?.message.status, "pending");
      assert.equal(outcome?.message.to.environmentId, macMini);

      const woke = yield* Queue.take(mac.deliveries);
      assert.equal(woke.threadId, "thread-mac");
      assert.include(woke.text, "Paywall · gpt-5 on EX (thread thread-ex)");
      assert.include(woke.text, `about ${issue.key}`);
      assert.include(woke.text, "to threadId thread-ex and environmentId environment-ex.");
      const sentCopy = yield* awaitStatus(exMachine, outcome!.message.id, "delivered");
      assert.equal(sentCopy.to.label, "Onboarding");
      const receivedCopy = yield* awaitStatus(mac, outcome!.message.id, "delivered");
      assert.equal(receivedCopy.from.machine, "EX");

      const [reply] = yield* mac.service.send(
        {
          target: { type: "thread", threadId: ThreadId.make("thread-ex"), environmentId: ex },
          text: "RevenueCat.",
        },
        macAgent,
      );
      const answered = yield* Queue.take(exMachine.deliveries);
      assert.include(answered.text, "Onboarding · gpt-5 on Mac Mini");
      assert.isTrue(answered.text.endsWith("\n\nRevenueCat."));
      yield* awaitStatus(mac, reply!.message.id, "delivered");
    }),
);

it.effect("a message for the hub's own thread is delivered on the hub", () =>
  Effect.gen(function* () {
    const { hub, ex: exMachine } = yield* fleet({ macReachable: true });
    const [outcome] = yield* exMachine.service.send(
      {
        target: { type: "thread", threadId: ThreadId.make("thread-geekom"), environmentId: geekom },
        text: "Tag the release.",
      },
      exAgent,
    );
    const woke = yield* Queue.take(hub.deliveries);
    assert.equal(woke.threadId, "thread-geekom");
    const settled = yield* awaitStatus(exMachine, outcome!.message.id, "delivered");
    assert.equal(settled.to.label, "Release");
  }),
);

it.effect(
  "a message for an offline spoke waits at the hub and is delivered when it reconnects",
  () =>
    Effect.gen(function* () {
      const { ex: exMachine, mac, macLink } = yield* fleet({ macReachable: false });
      const [outcome] = yield* exMachine.service.send(
        {
          target: { type: "thread", threadId: ThreadId.make("thread-mac"), environmentId: macMini },
          text: "Schema landed.",
        },
        exAgent,
      );
      assert.equal(outcome?.message.status, "pending");
      assert.lengthOf(mac.sent, 0);

      macLink.reachable.current = true;
      yield* TestClock.adjust("5 seconds");
      const woke = yield* Queue.take(mac.deliveries);
      assert.include(woke.text, "Schema landed.");
      yield* awaitStatus(exMachine, outcome!.message.id, "delivered");
    }),
);

it.effect("a message for a spoke offline for a day is reported undeliverable", () =>
  Effect.gen(function* () {
    const { ex: exMachine, mac } = yield* fleet({ macReachable: false });
    const [outcome] = yield* exMachine.service.send(
      {
        target: { type: "thread", threadId: ThreadId.make("thread-mac"), environmentId: macMini },
        text: "Anyone there?",
      },
      exAgent,
    );
    yield* TestClock.adjust("23 hours");
    const [stillWaiting] = yield* exMachine.service
      .subscribe()
      .pipe(Stream.take(1), Stream.runCollect);
    assert.equal(
      stillWaiting?.type === "snapshot" ? stillWaiting.messages[0]?.status : null,
      "pending",
    );
    yield* TestClock.adjust("70 minutes");
    const failed = yield* awaitStatus(exMachine, outcome!.message.id, "failed");
    assert.equal(failed.error, "Undeliverable: Mac Mini stayed offline for 24 hours.");
    assert.lengthOf(mac.sent, 0);
  }),
);

it.effect("the receiving machine's loop guard holds relayed messages and the sender sees it", () =>
  Effect.gen(function* () {
    const { ex: exMachine, mac } = yield* fleet({ macReachable: true });
    const target = {
      type: "thread",
      threadId: ThreadId.make("thread-mac"),
      environmentId: macMini,
    } as const;
    const ids: string[] = [];
    for (let index = 0; index <= AGENT_MESSAGE_WAKES_PER_HOUR; index++) {
      const [outcome] = yield* exMachine.service.send({ target, text: `ping ${index}` }, exAgent);
      ids.push(outcome!.message.id);
    }
    for (let index = 0; index < AGENT_MESSAGE_WAKES_PER_HOUR; index++) {
      yield* Queue.take(mac.deliveries);
    }
    const heldId = ids.at(-1)!;
    yield* awaitStatus(mac, heldId, "held");
    yield* awaitStatus(exMachine, heldId, "held");
    assert.lengthOf(mac.sent, AGENT_MESSAGE_WAKES_PER_HOUR);

    // Only the receiving machine can let it through.
    const elsewhere = yield* exMachine.service
      .release({ id: heldId as AgentMessage["id"] })
      .pipe(Effect.flip);
    assert.equal(elsewhere.code, "remote");
    yield* mac.service.release({ id: heldId as AgentMessage["id"] });
    const woke = yield* Queue.take(mac.deliveries);
    assert.include(woke.text, `ping ${AGENT_MESSAGE_WAKES_PER_HOUR}`);
    yield* awaitStatus(exMachine, heldId, "released");
  }),
);
