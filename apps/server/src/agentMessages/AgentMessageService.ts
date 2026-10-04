import {
  AGENT_MESSAGE_WAKES_PER_HOUR,
  AgentMessage,
  AgentMessageError,
  CommandId,
  MessageId,
  type AgentMessageActionInput,
  type AgentMessageStreamEvent,
  type BacklogActor,
  type BacklogError,
  type BacklogIssueId,
  type EnvironmentId,
  type RuntimeMode,
  type ThreadId,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import * as BacklogService from "../backlog/BacklogService.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import { resolveRuntimeMode } from "../mcp/OrchestratorMcpService.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import { forkParked } from "../serverActivation.ts";

/** How far back the loop guard counts agent wakes. */
const GUARD_WINDOW_MS = 60 * 60_000;
/** Recent messages in a feed snapshot; held messages are always included. */
const FEED_SNAPSHOT_LIMIT = 200;

/** The agent sending a message. Its runtime mode bounds which threads it may wake. */
export interface AgentMessageSender {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly label: string;
  readonly runtimeMode: RuntimeMode;
}

export type AgentMessageTarget =
  | {
      readonly type: "thread";
      readonly threadId: ThreadId;
      /** Omitted means this environment. */
      readonly environmentId?: EnvironmentId | undefined;
    }
  /** Whoever holds the claim on the issue. */
  | { readonly type: "issue"; readonly issue: string }
  /** Every holder of a claimed child of the spec, plus the spec's own holder. */
  | { readonly type: "spec"; readonly issue: string };

export interface AgentMessageSendInput {
  readonly target: AgentMessageTarget;
  readonly text: string;
  readonly urgent?: boolean | undefined;
}

export type AgentMessageDelivery = "started" | "queued" | "steered" | "restarted";

export interface AgentMessageOutcome {
  readonly message: AgentMessage;
  /** How the receiver got it; null when held or failed. */
  readonly delivery: AgentMessageDelivery | null;
}

export class AgentMessageService extends Context.Service<
  AgentMessageService,
  {
    /**
     * Resolves the target, logs one message per receiver, and wakes each
     * receiver unless its loop guard holds the message for the user. Fails
     * only when no receiver could be resolved, or when every delivery failed.
     */
    readonly send: (
      input: AgentMessageSendInput,
      sender: AgentMessageSender,
    ) => Effect.Effect<ReadonlyArray<AgentMessageOutcome>, AgentMessageError>;
    /** The user lets a held message through, past the loop guard. */
    readonly release: (
      input: AgentMessageActionInput,
    ) => Effect.Effect<AgentMessage, AgentMessageError>;
    /** The user drops a held message. */
    readonly dismiss: (
      input: AgentMessageActionInput,
    ) => Effect.Effect<AgentMessage, AgentMessageError>;
    /**
     * A user message to a thread resets its loop guard and releases the
     * messages held for it, oldest first, as far as the fresh guard allows.
     * Driven by the orchestrator's message events.
     */
    readonly noteUserMessage: (
      threadId: ThreadId,
      at: DateTime.DateTime,
    ) => Effect.Effect<ReadonlyArray<AgentMessage>>;
    /** Recent messages and every held one, then row deltas. */
    readonly subscribe: () => Stream.Stream<AgentMessageStreamEvent, AgentMessageError>;
  }
>()("t3/agentMessages/AgentMessageService") {}

interface MessageRow {
  readonly id: string;
  readonly from_environment_id: string;
  readonly from_thread_id: string;
  readonly from_label: string;
  readonly to_environment_id: string;
  readonly to_thread_id: string;
  readonly to_label: string;
  readonly issue_id: string | null;
  readonly issue_key: string | null;
  readonly text: string;
  readonly urgent: number;
  readonly status: string;
  readonly created_at: string;
  readonly delivered_at: string | null;
  readonly error: string | null;
}

interface Recipient {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
}

interface Topic {
  readonly issueId: BacklogIssueId | null;
  readonly issueKey: string | null;
}

const decodeMessage = Schema.decodeUnknownEffect(AgentMessage);
const decodeRow = (row: MessageRow) =>
  decodeMessage({
    id: row.id,
    from: {
      environmentId: row.from_environment_id,
      threadId: row.from_thread_id,
      label: row.from_label,
    },
    to: { environmentId: row.to_environment_id, threadId: row.to_thread_id, label: row.to_label },
    issueId: row.issue_id,
    issueKey: row.issue_key,
    text: row.text,
    urgent: row.urgent === 1,
    status: row.status,
    createdAt: row.created_at,
    deliveredAt: row.delivered_at,
    error: row.error,
  });

const isAgentMessageError = Schema.is(AgentMessageError);
const fail = (code: AgentMessageError["code"], message: string) =>
  Effect.fail(new AgentMessageError({ code, message }));

/** Storage and decode failures are defects; the error codes describe what the caller did. */
const agentMessageErrorsOnly = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.catch((error) => (isAgentMessageError(error) ? Effect.fail(error) : Effect.die(error))),
  );

const fromBacklogError = (error: BacklogError) =>
  new AgentMessageError({ code: error.code, message: error.message });

const describeError = (error: unknown): string => {
  if (typeof error === "object" && error !== null) {
    if ("message" in error && typeof error.message === "string" && error.message.length > 0) {
      return error.message;
    }
    if ("_tag" in error && typeof error._tag === "string") return error._tag;
  }
  return String(error);
};

/** The attribution header every delivered message carries, so the receiver knows how to answer. */
export function formatAgentMessageForDelivery(
  message: Pick<AgentMessage, "from" | "issueKey" | "text" | "urgent">,
  machineLabel: string,
): string {
  const about = message.issueKey === null ? "" : `, about ${message.issueKey}`;
  return [
    `${message.urgent ? "Urgent message" : "Message"} from another agent: ${message.from.label} on ${machineLabel} (thread ${message.from.threadId})${about}.`,
    `Reply with the agent_message tool to threadId ${message.from.threadId}.`,
    "",
    message.text,
  ].join("\n");
}

const REMOTE_ERROR =
  "That thread is on another machine. Messaging across machines needs fleet messaging, which is not available yet.";

// Fork-only feature: tables are created idempotently rather than through a
// numbered migration, for the reason given in BacklogService.ts.
const ensureSchema = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE IF NOT EXISTS agent_messages (
      id TEXT PRIMARY KEY,
      from_environment_id TEXT NOT NULL,
      from_thread_id TEXT NOT NULL,
      from_label TEXT NOT NULL,
      to_environment_id TEXT NOT NULL,
      to_thread_id TEXT NOT NULL,
      to_label TEXT NOT NULL,
      issue_id TEXT,
      issue_key TEXT,
      text TEXT NOT NULL,
      urgent INTEGER NOT NULL,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL,
      delivered_at TEXT,
      error TEXT
    )
  `;
  yield* sql`CREATE INDEX IF NOT EXISTS agent_messages_receiver ON agent_messages (to_thread_id, status, delivered_at)`;
  yield* sql`CREATE INDEX IF NOT EXISTS agent_messages_created ON agent_messages (created_at)`;
  yield* sql`
    CREATE TABLE IF NOT EXISTS agent_message_user_marks (
      thread_id TEXT PRIMARY KEY,
      last_user_message_at TEXT NOT NULL
    )
  `;
});

export const layer = Layer.effect(
  AgentMessageService,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const crypto = yield* Crypto.Crypto;
    const threads = yield* ThreadManagementService.ThreadManagementService;
    const backlog = yield* BacklogService.BacklogService;
    const serverEnvironment = yield* ServerEnvironment.ServerEnvironment;
    const events = yield* PubSub.unbounded<AgentMessageStreamEvent>();
    // Serializes the guard's count-then-insert so concurrent senders cannot
    // both take the last wake. Delivery itself runs outside the lock.
    const guardLock = yield* Semaphore.make(1);

    yield* ensureSchema;

    const localEnvironmentId = yield* serverEnvironment.getEnvironmentId;
    const machineLabel = (environmentId: EnvironmentId) =>
      environmentId === localEnvironmentId
        ? serverEnvironment.getDescriptor.pipe(Effect.map((descriptor) => descriptor.label))
        : Effect.succeed("another machine");

    const newId = crypto.randomUUIDv4.pipe(Effect.orDie);
    const nowIso = DateTime.now.pipe(Effect.map(DateTime.formatIso));

    const loadRow = Effect.fn("AgentMessageService.loadRow")(function* (id: string) {
      const rows = yield* sql<MessageRow>`SELECT * FROM agent_messages WHERE id = ${id}`;
      if (rows[0] === undefined) return yield* fail("not_found", "Message not found.");
      return yield* decodeRow(rows[0]);
    });

    const publish = (message: AgentMessage) =>
      PubSub.publish(events, { type: "messageUpserted", message });

    /** Omitted deliveredAt and error keep their stored values. */
    const setStatus = (
      id: string,
      update: {
        readonly status: AgentMessage["status"];
        readonly deliveredAt?: string;
        readonly error?: string;
      },
    ) =>
      sql`
        UPDATE agent_messages SET
          status = ${update.status},
          delivered_at = COALESCE(${update.deliveredAt ?? null}, delivered_at),
          error = COALESCE(${update.error ?? null}, error)
        WHERE id = ${id}
      `;

    /** Agent wakes this thread has taken in the guard window. */
    const wakesInWindow = Effect.fn("AgentMessageService.wakesInWindow")(function* (
      threadId: ThreadId,
    ) {
      const now = yield* DateTime.now;
      const hourAgo = DateTime.formatIso(DateTime.subtract(now, { milliseconds: GUARD_WINDOW_MS }));
      const marks = yield* sql<{ last_user_message_at: string }>`
        SELECT last_user_message_at FROM agent_message_user_marks WHERE thread_id = ${threadId}
      `;
      const lastUser = marks[0]?.last_user_message_at;
      const since = lastUser !== undefined && lastUser > hourAgo ? lastUser : hourAgo;
      const rows = yield* sql<{ count: number }>`
        SELECT COUNT(*) AS count FROM agent_messages
        WHERE to_thread_id = ${threadId}
          AND status IN ('delivered', 'released')
          AND delivered_at >= ${since}
      `;
      return rows[0]?.count ?? 0;
    });

    /** Hands the message to the receiver's thread and records how it went. */
    const dispatch = Effect.fn("AgentMessageService.dispatch")(function* (message: AgentMessage) {
      const attempt = Effect.gen(function* () {
        const shell = yield* threads.getThreadShell(message.to.threadId);
        if (shell === null || shell.deletedAt !== null) {
          return yield* Effect.fail("The receiving thread no longer exists.");
        }
        const result = yield* threads.sendToThread({
          projectId: shell.projectId,
          commandId: CommandId.make(`agent-message:${message.id}`),
          threadId: message.to.threadId,
          senderThreadId: message.from.threadId,
          messageId: MessageId.make(`agent-message:${message.id}`),
          text: formatAgentMessageForDelivery(
            message,
            yield* machineLabel(message.from.environmentId),
          ),
          attachments: [],
          // An idle receiver starts either way. Busy: default waits for the
          // next turn; urgent steers into the running one.
          mode: message.urgent ? "auto" : "queue",
          createdBy: "agent",
          creationSource: "mcp",
        });
        return result.delivery;
      });
      const delivery = yield* attempt.pipe(
        Effect.catchCause((cause) =>
          Effect.gen(function* () {
            const error = describeError(Cause.squash(cause));
            yield* Effect.logWarning("Agent message delivery failed", { id: message.id, cause });
            yield* setStatus(message.id, { status: "failed", error });
            return null;
          }),
        ),
      );
      const final = yield* loadRow(message.id);
      yield* publish(final);
      return { message: final, delivery } satisfies AgentMessageOutcome;
    });

    /** Logs one message and decides held or delivered under the guard. */
    const record = Effect.fn("AgentMessageService.record")(function* (input: {
      readonly sender: AgentMessageSender;
      readonly recipient: Recipient;
      readonly topic: Topic;
      readonly text: string;
      readonly urgent: boolean;
    }) {
      const { sender, recipient, topic } = input;
      const shell =
        recipient.environmentId === localEnvironmentId
          ? yield* threads.getThreadShell(recipient.threadId).pipe(Effect.orElseSucceed(() => null))
          : null;
      const failure =
        recipient.environmentId !== localEnvironmentId
          ? REMOTE_ERROR
          : shell === null || shell.deletedAt !== null
            ? "The receiving thread no longer exists."
            : yield* resolveRuntimeMode(sender.runtimeMode, shell.runtimeMode).pipe(
                Effect.as(null),
                Effect.catch(() =>
                  Effect.succeed(
                    `This thread runs with narrower permissions (${sender.runtimeMode}) than the receiver (${shell.runtimeMode}), so it cannot wake it.`,
                  ),
                ),
              );
      const id = yield* newId;
      const status = yield* guardLock.withPermits(1)(
        Effect.gen(function* () {
          const createdAt = yield* nowIso;
          const status: AgentMessage["status"] =
            failure !== null
              ? "failed"
              : (yield* sql<{ id: string }>`
                    SELECT id FROM agent_messages
                    WHERE to_thread_id = ${recipient.threadId} AND status = 'held' LIMIT 1
                  `).length > 0 ||
                  (yield* wakesInWindow(recipient.threadId)) >= AGENT_MESSAGE_WAKES_PER_HOUR
                ? "held"
                : "delivered";
          yield* sql`
            INSERT INTO agent_messages (
              id, from_environment_id, from_thread_id, from_label, to_environment_id,
              to_thread_id, to_label, issue_id, issue_key, text, urgent, status,
              created_at, delivered_at, error
            ) VALUES (
              ${id}, ${sender.environmentId}, ${sender.threadId}, ${sender.label},
              ${recipient.environmentId}, ${recipient.threadId}, ${shell?.title ?? recipient.threadId},
              ${topic.issueId}, ${topic.issueKey}, ${input.text}, ${input.urgent ? 1 : 0},
              ${status}, ${createdAt}, ${status === "delivered" ? createdAt : null}, ${failure}
            )
          `;
          return status;
        }),
      );
      const message = yield* loadRow(id);
      if (status !== "delivered") {
        yield* publish(message);
        return { message, delivery: null } satisfies AgentMessageOutcome;
      }
      return yield* dispatch(message);
    });

    const resolveRecipients = Effect.fn("AgentMessageService.resolveRecipients")(function* (
      target: AgentMessageTarget,
      sender: AgentMessageSender,
    ) {
      const isSender = (recipient: Recipient) =>
        recipient.environmentId === sender.environmentId && recipient.threadId === sender.threadId;
      const holder = (actor: BacklogActor): Recipient | null =>
        actor.kind === "agent" && actor.threadId !== null
          ? { environmentId: actor.environmentId ?? localEnvironmentId, threadId: actor.threadId }
          : null;

      if (target.type === "thread") {
        const recipient = {
          environmentId: target.environmentId ?? localEnvironmentId,
          threadId: target.threadId,
        };
        if (isSender(recipient)) return yield* fail("invalid", "That is your own thread.");
        if (recipient.environmentId === localEnvironmentId) {
          const shell = yield* threads
            .getThreadShell(recipient.threadId)
            .pipe(Effect.orElseSucceed(() => null));
          if (shell === null || shell.deletedAt !== null) {
            return yield* fail(
              "not_found",
              `Thread ${recipient.threadId} not found on this machine.`,
            );
          }
        } else {
          return yield* fail("remote", REMOTE_ERROR);
        }
        return { recipients: [recipient], topic: { issueId: null, issueKey: null } };
      }

      const detail = yield* backlog.resolveIssueRef(target.issue).pipe(
        Effect.flatMap((issueId) => backlog.getIssue({ issueId })),
        Effect.mapError(fromBacklogError),
      );
      const topic: Topic = { issueId: detail.issue.id, issueKey: detail.issue.key };
      if (target.type === "issue") {
        const recipient = detail.issue.claim === null ? null : holder(detail.issue.claim.actor);
        if (recipient === null) {
          return yield* fail(
            "not_found",
            `${detail.issue.key} is not claimed by an agent, so nobody holds it to message.`,
          );
        }
        if (isSender(recipient))
          return yield* fail("invalid", `You hold ${detail.issue.key} yourself.`);
        return { recipients: [recipient], topic };
      }

      const seen = new Set<string>();
      const recipients: Recipient[] = [];
      for (const issue of [...detail.children, detail.issue]) {
        const recipient = issue.claim === null ? null : holder(issue.claim.actor);
        if (recipient === null || isSender(recipient)) continue;
        const key = `${recipient.environmentId}\u0000${recipient.threadId}`;
        if (seen.has(key)) continue;
        seen.add(key);
        recipients.push(recipient);
      }
      if (recipients.length === 0) {
        return yield* fail(
          "not_found",
          `No other agent holds ${detail.issue.key} or a claimed child of it.`,
        );
      }
      return { recipients, topic };
    });

    const send: AgentMessageService["Service"]["send"] = (input, sender) =>
      Effect.gen(function* () {
        const text = input.text.trim();
        if (text.length === 0) return yield* fail("invalid", "The message is empty.");
        const { recipients, topic } = yield* resolveRecipients(input.target, sender);
        const outcomes = yield* Effect.forEach(recipients, (recipient) =>
          record({ sender, recipient, topic, text, urgent: input.urgent ?? false }),
        );
        if (outcomes.every((outcome) => outcome.message.status === "failed")) {
          const first = outcomes[0]!.message;
          return yield* fail(
            first.error === REMOTE_ERROR
              ? "remote"
              : first.error?.includes("narrower permissions")
                ? "denied"
                : "unavailable",
            first.error ?? "The message could not be delivered.",
          );
        }
        return outcomes;
      }).pipe(agentMessageErrorsOnly);

    const release: AgentMessageService["Service"]["release"] = ({ id }) =>
      Effect.gen(function* () {
        const message = yield* guardLock.withPermits(1)(
          Effect.gen(function* () {
            const current = yield* loadRow(id);
            if (current.status !== "held") {
              return yield* fail("conflict", "Only a held message can be released.");
            }
            yield* setStatus(id, { status: "released", deliveredAt: yield* nowIso });
            return yield* loadRow(id);
          }),
        );
        return (yield* dispatch(message)).message;
      }).pipe(agentMessageErrorsOnly);

    const dismiss: AgentMessageService["Service"]["dismiss"] = ({ id }) =>
      Effect.gen(function* () {
        const message = yield* guardLock.withPermits(1)(
          Effect.gen(function* () {
            const current = yield* loadRow(id);
            if (current.status !== "held") {
              return yield* fail("conflict", "Only a held message can be dismissed.");
            }
            yield* setStatus(id, { status: "dismissed" });
            return yield* loadRow(id);
          }),
        );
        yield* publish(message);
        return message;
      }).pipe(agentMessageErrorsOnly);

    const noteUserMessage: AgentMessageService["Service"]["noteUserMessage"] = (threadId, at) =>
      Effect.gen(function* () {
        const released = yield* guardLock.withPermits(1)(
          Effect.gen(function* () {
            const atIso = DateTime.formatIso(at);
            yield* sql`
              INSERT INTO agent_message_user_marks (thread_id, last_user_message_at)
              VALUES (${threadId}, ${atIso})
              ON CONFLICT (thread_id) DO UPDATE SET last_user_message_at =
                MAX(last_user_message_at, excluded.last_user_message_at)
            `;
            const budget = AGENT_MESSAGE_WAKES_PER_HOUR - (yield* wakesInWindow(threadId));
            if (budget <= 0) return [];
            const held = yield* sql<{ id: string }>`
              SELECT id FROM agent_messages WHERE to_thread_id = ${threadId} AND status = 'held'
              ORDER BY created_at, rowid LIMIT ${budget}
            `;
            const deliveredAt = yield* nowIso;
            return yield* Effect.forEach(held, (row) =>
              setStatus(row.id, { status: "released", deliveredAt }).pipe(
                Effect.andThen(loadRow(row.id)),
              ),
            );
          }),
        );
        return yield* Effect.forEach(released, (message) =>
          dispatch(message).pipe(Effect.map((outcome) => outcome.message)),
        );
      }).pipe(Effect.orDie);

    const subscribe: AgentMessageService["Service"]["subscribe"] = () =>
      Stream.unwrap(
        Effect.gen(function* () {
          // Subscribe first so a change landing during the snapshot is buffered, not lost.
          const subscription = yield* PubSub.subscribe(events);
          const snapshot = sql<MessageRow>`
            SELECT * FROM agent_messages
            WHERE status = 'held' OR id IN (
              SELECT id FROM agent_messages ORDER BY created_at DESC, rowid DESC
              LIMIT ${FEED_SNAPSHOT_LIMIT}
            )
            ORDER BY created_at DESC, rowid DESC
          `.pipe(
            Effect.flatMap((rows) => Effect.forEach(rows, decodeRow)),
            Effect.map((messages): AgentMessageStreamEvent => ({ type: "snapshot", messages })),
            Effect.orDie,
          );
          return Stream.concat(Stream.fromEffect(snapshot), Stream.fromSubscription(subscription));
        }),
      );

    // Any user message to a thread resets its guard and releases what it held.
    yield* forkParked(
      Stream.runForEach(threads.streamDomainEvents, (event) =>
        event.type === "message.updated" &&
        event.payload.role === "user" &&
        event.payload.createdBy === "user" &&
        (event.payload.creationSource === "web" || event.payload.creationSource === "mobile")
          ? noteUserMessage(event.payload.threadId, event.payload.createdAt).pipe(
              Effect.asVoid,
              // One bad release must not stop the watcher for every other thread.
              Effect.catchCause((cause) =>
                Effect.logWarning("Releasing held agent messages failed", { cause }),
              ),
            )
          : Effect.void,
      ).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("Agent message user-message watcher stopped", { cause }),
        ),
      ),
    );

    return AgentMessageService.of({ send, release, dismiss, noteUserMessage, subscribe });
  }),
);
