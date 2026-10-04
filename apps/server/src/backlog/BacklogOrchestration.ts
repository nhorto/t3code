import {
  CommandId,
  MessageId,
  type OrchestrationProjectShell,
  type OrchestrationThreadShell,
  type ProjectId,
  type ProviderInteractionMode,
  type RuntimeMode,
  type ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import * as OrchestrationEngine from "../orchestration/Services/OrchestrationEngine.ts";
import * as ProjectionSnapshotQuery from "../orchestration/Services/ProjectionSnapshotQuery.ts";

/** What the backlog and agent messages need to know about one thread on this machine. */
export interface BacklogThread {
  readonly id: ThreadId;
  readonly projectId: ProjectId;
  readonly title: string;
  readonly model: string;
  readonly runtimeMode: RuntimeMode;
  readonly interactionMode: ProviderInteractionMode;
  readonly archived: boolean;
  /** A turn is starting or running. */
  readonly running: boolean;
  /** When the thread last changed or finished a turn, in epoch milliseconds. */
  readonly lastActiveAtMs: number;
}

/**
 * How a message reached its thread. started: the idle thread began a turn.
 * queued: the thread was busy, and the message waits for its turn to end.
 * steered: the message went into the running turn.
 */
export type BacklogDelivery = "started" | "queued" | "steered";

export interface BacklogDeliverInput {
  readonly threadId: ThreadId;
  /** Stable per message, so a retried delivery is deduplicated by command receipts. */
  readonly key: string;
  readonly text: string;
  /** Steer into a running turn instead of waiting for it to end. */
  readonly urgent: boolean;
}

/**
 * The thread and project reads, and the message delivery, that the backlog and
 * agent messages use, over this server's orchestration (protocol 1). Keeping
 * them behind one service lets the backlog code stay the same on servers whose
 * orchestration differs.
 */
export class BacklogOrchestration extends Context.Service<
  BacklogOrchestration,
  {
    /** A thread that has not been deleted, or null. */
    readonly getThread: (threadId: ThreadId) => Effect.Effect<BacklogThread | null>;
    /** Every thread that is not deleted or archived. */
    readonly listActiveThreads: () => Effect.Effect<ReadonlyArray<BacklogThread>>;
    readonly getProject: (
      projectId: ProjectId,
    ) => Effect.Effect<Option.Option<OrchestrationProjectShell>>;
    readonly listProjects: () => Effect.Effect<ReadonlyArray<OrchestrationProjectShell>>;
    /**
     * Sends text into a thread as a user turn. A busy thread gets it when its
     * running turn ends, unless urgent; that wait is held in memory, so a
     * restart before the turn ends drops it.
     */
    readonly deliver: (
      input: BacklogDeliverInput,
    ) => Effect.Effect<BacklogDelivery, BacklogDeliveryError>;
    /** Messages a person sent to a thread from a client, as they are sent. */
    readonly userMessages: Stream.Stream<{
      readonly threadId: ThreadId;
      readonly at: DateTime.DateTime;
    }>;
  }
>()("t3/backlog/BacklogOrchestration") {}

export class BacklogDeliveryError extends Data.TaggedError("BacklogDeliveryError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

/** Message ids of delivered agent messages; a user message never carries one. */
export const AGENT_MESSAGE_ID_PREFIX = "agent-message:";

export const toBacklogThread = (shell: OrchestrationThreadShell): BacklogThread => {
  const status = shell.session?.status;
  return {
    id: shell.id,
    projectId: shell.projectId,
    title: shell.title,
    model: shell.modelSelection.model,
    runtimeMode: shell.runtimeMode,
    interactionMode: shell.interactionMode,
    archived: shell.archivedAt !== null,
    running: status === "running" || status === "starting",
    lastActiveAtMs: Math.max(
      DateTime.makeUnsafe(shell.updatedAt).epochMilliseconds,
      shell.latestTurn?.completedAt
        ? DateTime.makeUnsafe(shell.latestTurn.completedAt).epochMilliseconds
        : 0,
    ),
  };
};

export const make = Effect.gen(function* () {
  const projections = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
  const engine = yield* OrchestrationEngine.OrchestrationEngineService;
  const nowIso = DateTime.now.pipe(Effect.map(DateTime.formatIso));
  // Deliveries waiting for a turn to end stop with the server.
  const waiting = yield* Effect.scope;

  const readShell = (threadId: ThreadId) =>
    projections.getThreadShellById(threadId).pipe(Effect.map(Option.getOrNull), Effect.orDie);

  const getThread = (threadId: ThreadId) =>
    readShell(threadId).pipe(
      Effect.map((shell) => (shell === null ? null : toBacklogThread(shell))),
    );

  const startTurn = (shell: OrchestrationThreadShell, input: BacklogDeliverInput) =>
    Effect.gen(function* () {
      yield* engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make(input.key),
        threadId: shell.id,
        message: {
          messageId: MessageId.make(input.key),
          role: "user",
          text: input.text,
          attachments: [],
        },
        runtimeMode: shell.runtimeMode,
        interactionMode: shell.interactionMode,
        createdAt: yield* nowIso,
      });
    }).pipe(
      Effect.mapError(
        (cause) =>
          new BacklogDeliveryError({
            message: "The message could not be sent to the thread.",
            cause,
          }),
      ),
    );

  /**
   * Waits for the thread's running turn to end, then starts the next one with
   * the message. Subscribed before the first read so an ending turn is not missed.
   */
  const deliverAfterTurn = (input: BacklogDeliverInput) =>
    Effect.scoped(
      Effect.gen(function* () {
        const events = yield* engine.subscribeDomainEvents;
        const current = yield* readShell(input.threadId);
        const settled =
          current === null || !toBacklogThread(current).running
            ? current
            : yield* events.pipe(
                Stream.filter(
                  (event) =>
                    event.aggregateId === input.threadId &&
                    (event.type === "thread.session-set" || event.type === "thread.deleted"),
                ),
                Stream.mapEffect(() => readShell(input.threadId)),
                Stream.filter((shell) => shell === null || !toBacklogThread(shell).running),
                Stream.runHead,
                Effect.map(Option.getOrNull),
              );
        if (settled === null) {
          return yield* Effect.logWarning(
            "A queued agent message was dropped: its thread was deleted",
            { threadId: input.threadId },
          );
        }
        yield* startTurn(settled, input);
      }),
    ).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("A queued agent message could not be delivered", {
          threadId: input.threadId,
          cause,
        }),
      ),
    );

  const deliver = (input: BacklogDeliverInput) =>
    Effect.gen(function* () {
      const shell = yield* readShell(input.threadId);
      if (shell === null) {
        return yield* new BacklogDeliveryError({
          message: "The receiving thread no longer exists.",
        });
      }
      const running = toBacklogThread(shell).running;
      if (!running || input.urgent) {
        yield* startTurn(shell, input);
        return running ? ("steered" as const) : ("started" as const);
      }
      yield* Effect.forkIn(deliverAfterTurn(input), waiting);
      return "queued" as const;
    });

  const userMessages = engine.streamDomainEvents.pipe(
    Stream.filter(
      (event) =>
        event.type === "thread.message-sent" &&
        event.payload.role === "user" &&
        event.metadata.historyImport !== true &&
        !event.payload.messageId.startsWith(AGENT_MESSAGE_ID_PREFIX),
    ),
    Stream.map((event) => {
      const payload = event.payload as { threadId: ThreadId; createdAt: string };
      return { threadId: payload.threadId, at: DateTime.makeUnsafe(payload.createdAt) };
    }),
  );

  return BacklogOrchestration.of({
    getThread,
    listActiveThreads: () =>
      projections.getShellSnapshot().pipe(
        Effect.map((snapshot) =>
          snapshot.threads.filter((shell) => shell.archivedAt === null).map(toBacklogThread),
        ),
        Effect.orDie,
      ),
    getProject: (projectId) => projections.getProjectShellById(projectId).pipe(Effect.orDie),
    listProjects: () => projections.getProjectShells().pipe(Effect.orDie),
    deliver,
    userMessages,
  });
});

export const layer = Layer.effect(BacklogOrchestration, make);
