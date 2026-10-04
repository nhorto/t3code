import { assert, it } from "@effect/vitest";
import {
  ThreadId,
  type OrchestrationCommand,
  type OrchestrationEvent,
  type OrchestrationThreadShell,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Stream from "effect/Stream";

import * as OrchestrationEngine from "../orchestration/Services/OrchestrationEngine.ts";
import * as ProjectionSnapshotQuery from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { BacklogOrchestration, layer } from "./BacklogOrchestration.ts";

const threadId = ThreadId.make("thread-receiver");

const shell = (status: "running" | "ready") =>
  ({
    id: threadId,
    projectId: "project-wine",
    title: "Paywall",
    modelSelection: { instanceId: "codex", model: "gpt-5" },
    runtimeMode: "auto-accept-edits",
    interactionMode: "default",
    archivedAt: null,
    updatedAt: "2026-10-04T10:00:00.000Z",
    latestTurn: null,
    session: { status },
  }) as unknown as OrchestrationThreadShell;

const event = (type: string, payload: Record<string, unknown> = {}, metadata = {}) =>
  ({ type, aggregateId: threadId, payload, metadata }) as unknown as OrchestrationEvent;

/** One receiving thread whose session the test moves, and the commands sent to it. */
const harness = (options: { readonly status: "running" | "ready" }) =>
  Effect.gen(function* () {
    let current = shell(options.status);
    const events = yield* PubSub.unbounded<OrchestrationEvent>();
    const dispatched: OrchestrationCommand[] = [];
    const firstDispatch = yield* Deferred.make<OrchestrationCommand>();
    // Built in the test's scope: queued deliveries wait in the service's scope.
    const context = yield* Layer.build(
      layer.pipe(
        Layer.provide(
          Layer.mergeAll(
            Layer.mock(ProjectionSnapshotQuery.ProjectionSnapshotQuery)({
              getThreadShellById: () => Effect.sync(() => Option.some(current)),
            }),
            Layer.mock(OrchestrationEngine.OrchestrationEngineService)({
              dispatch: (command) =>
                Effect.sync(() => dispatched.push(command)).pipe(
                  Effect.andThen(Deferred.succeed(firstDispatch, command)),
                  Effect.as({ sequence: dispatched.length }),
                ),
              subscribeDomainEvents: PubSub.subscribe(events).pipe(
                Effect.map(Stream.fromSubscription),
              ),
              streamDomainEvents: Stream.empty,
            }),
          ),
        ),
      ),
    );
    const service = Context.get(context, BacklogOrchestration);
    const endTurn = Effect.sync(() => {
      current = shell("ready");
    }).pipe(Effect.andThen(PubSub.publish(events, event("thread.session-set"))));
    return { service, dispatched, firstDispatch, endTurn };
  });

const input = (urgent: boolean) => ({
  threadId,
  key: "agent-message:m-1",
  text: "Message from another agent: schema landed.",
  urgent,
});

it.effect("starts a turn on an idle thread with the thread's own modes", () =>
  Effect.gen(function* () {
    const { service, dispatched } = yield* harness({ status: "ready" });
    assert.equal(yield* service.deliver(input(false)), "started");
    assert.equal(dispatched.length, 1);
    assert.deepInclude(dispatched[0], {
      type: "thread.turn.start",
      commandId: "agent-message:m-1",
      threadId,
      runtimeMode: "auto-accept-edits",
      interactionMode: "default",
    });
  }).pipe(Effect.scoped),
);

it.effect("steers an urgent message into a running turn", () =>
  Effect.gen(function* () {
    const { service, dispatched } = yield* harness({ status: "running" });
    assert.equal(yield* service.deliver(input(true)), "steered");
    assert.equal(dispatched.length, 1);
  }).pipe(Effect.scoped),
);

it.effect("holds a default message for a busy thread until its turn ends", () =>
  Effect.gen(function* () {
    const { service, dispatched, firstDispatch, endTurn } = yield* harness({ status: "running" });
    assert.equal(yield* service.deliver(input(false)), "queued");
    assert.equal(dispatched.length, 0);
    yield* endTurn;
    const sent = yield* Deferred.await(firstDispatch);
    assert.equal(sent.type, "thread.turn.start");
    assert.equal(dispatched.length, 1);
  }).pipe(Effect.scoped),
);

it.effect("reports only user messages a person sent", () =>
  Effect.gen(function* () {
    const sent = (messageId: string, role = "user", metadata = {}) =>
      event(
        "thread.message-sent",
        { threadId, messageId, role, createdAt: "2026-10-04T10:00:00.000Z" },
        metadata,
      );
    const service = yield* BacklogOrchestration.pipe(
      Effect.provide(
        layer.pipe(
          Layer.provide(
            Layer.mergeAll(
              Layer.mock(ProjectionSnapshotQuery.ProjectionSnapshotQuery)({}),
              Layer.mock(OrchestrationEngine.OrchestrationEngineService)({
                streamDomainEvents: Stream.make(
                  sent("agent-message:m-1"),
                  sent("assistant-1", "assistant"),
                  sent("imported-1", "user", { historyImport: true }),
                  event("thread.session-set"),
                  sent("user-1"),
                ),
              }),
            ),
          ),
        ),
      ),
    );
    const messages = yield* Stream.runCollect(service.userMessages);
    assert.deepEqual(
      messages.map((message) => message.threadId),
      [threadId],
    );
  }).pipe(Effect.scoped),
);
