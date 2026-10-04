import {
  AGENT_MESSAGE_HELD_PER_THREAD,
  AGENT_MESSAGE_MAX_TEXT_LENGTH,
  AGENT_MESSAGE_WAKES_PER_HOUR,
  AgentMessage,
  AgentMessageError,
  BacklogError,
  type AgentMessageAckInput,
  type AgentMessageActionInput,
  type AgentMessageEnvelope,
  type AgentMessageInboxEvent,
  type AgentMessageStreamEvent,
  type BacklogActor,
  type BacklogIssueId,
  type EnvironmentId,
  type ProviderInteractionMode,
  type RuntimeMode,
  type ThreadId,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import * as BacklogHubClient from "../backlog/BacklogHubClient.ts";
import {
  AGENT_MESSAGE_ID_PREFIX,
  BacklogOrchestration,
  type BacklogThread,
} from "../backlog/BacklogOrchestration.ts";
import * as BacklogRouter from "../backlog/BacklogRouter.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import { forkParked } from "../serverActivation.ts";
import * as AgentMessageRelay from "./AgentMessageRelay.ts";

/** How far back the loop guard counts agent wakes. */
const GUARD_WINDOW_MS = 60 * 60_000;
/** Recent messages in a feed snapshot; held messages are always included. */
const FEED_SNAPSHOT_LIMIT = 200;
/** Wait before reopening the inbox after it ended or could not open. */
const INBOX_RETRY = "5 seconds";
/** How often a running inbox checks whether this machine was linked or unlinked. */
const INBOX_LINK_POLL = "10 seconds";

/**
 * The agent sending a message. Its runtime and interaction modes bound which
 * threads it may wake: never one with broader modes than its own.
 */
export interface AgentMessageSender {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly label: string;
  readonly runtimeMode: RuntimeMode;
  readonly interactionMode: ProviderInteractionMode;
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
  /** How the receiver got it; null when held, failed, or on its way to another machine. */
  readonly delivery: AgentMessageDelivery | null;
}

export class AgentMessageService extends Context.Service<
  AgentMessageService,
  {
    /**
     * Resolves the target, logs one message per receiver, and wakes each
     * receiver unless its loop guard holds the message for the user. A
     * receiver on another machine gets the message through the backlog hub
     * (status pending until that machine acks). Fails only when no receiver
     * could be resolved, or when every delivery failed.
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
    /** Messages held here for the user, recounted as the log changes. */
    readonly subscribeHeldCount: () => Stream.Stream<number, AgentMessageError>;
  }
>()("t3/agentMessages/AgentMessageService") {}

interface MessageRow {
  readonly id: string;
  readonly from_environment_id: string;
  readonly from_thread_id: string;
  readonly from_label: string;
  readonly from_machine: string | null;
  readonly from_runtime_mode: string | null;
  readonly from_interaction_mode: string | null;
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

/** Who sent a message being logged here: an agent on this machine, or one relayed in. */
interface Origin {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly label: string;
  readonly runtimeMode: RuntimeMode;
  readonly interactionMode: ProviderInteractionMode;
  /** Set for a relayed message: its id, time and machine stay what the sender gave. */
  readonly relayed: {
    readonly id: string;
    readonly createdAt: string;
    readonly machine: string;
  } | null;
}

type FailureCode = AgentMessageError["code"];

interface Admitted extends AgentMessageOutcome {
  /** Why the message failed, for the error send returns when every receiver failed. */
  readonly failureCode: FailureCode | null;
}

const decodeMessage = Schema.decodeUnknownEffect(AgentMessage);
const decodeRow = (row: MessageRow) =>
  decodeMessage({
    id: row.id,
    from: {
      environmentId: row.from_environment_id,
      threadId: row.from_thread_id,
      label: row.from_label,
      ...(row.from_machine === null ? {} : { machine: row.from_machine }),
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

const isBacklogError = Schema.is(BacklogError);
const fromBacklogError = (error: BacklogError) =>
  new AgentMessageError({ code: error.code, message: error.message });

/** Broader runtime modes rank higher; a sender may only wake threads it does not outrank. */
function runtimeModeRank(mode: RuntimeMode): number {
  switch (mode) {
    case "approval-required":
      return 0;
    case "auto-accept-edits":
      return 1;
    case "auto":
      return 2;
    case "full-access":
      return 3;
  }
}

function interactionModeRank(mode: ProviderInteractionMode): number {
  return mode === "plan" ? 0 : 1;
}

const describeError = (error: unknown): string => {
  if (typeof error === "object" && error !== null) {
    if ("message" in error && typeof error.message === "string" && error.message.length > 0) {
      return error.message;
    }
    if ("_tag" in error && typeof error._tag === "string") return error._tag;
  }
  return String(error);
};

/**
 * The attribution header every delivered message carries, so the receiver
 * knows how to answer. A sender on another machine is also addressed by its
 * environment id.
 */
export function formatAgentMessageForDelivery(
  message: Pick<AgentMessage, "from" | "issueKey" | "text" | "urgent">,
  machineLabel: string,
  receiverEnvironmentId: EnvironmentId = message.from.environmentId,
): string {
  const about = message.issueKey === null ? "" : `, about ${message.issueKey}`;
  const replyTo =
    message.from.environmentId === receiverEnvironmentId
      ? `threadId ${message.from.threadId}`
      : `threadId ${message.from.threadId} and environmentId ${message.from.environmentId}`;
  return [
    `${message.urgent ? "Urgent message" : "Message"} from another agent: ${message.from.label} on ${machineLabel} (thread ${message.from.threadId})${about}.`,
    `Reply with the agent_message tool to ${replyTo}.`,
    "",
    message.text,
  ].join("\n");
}

const notLinkedError = (threadId: ThreadId) =>
  `Thread ${threadId} is on another machine that is not linked with this one. Messages between machines go through a backlog hub: link both machines to the same hub under Settings → Backlog.`;

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
      from_machine TEXT,
      from_runtime_mode TEXT,
      from_interaction_mode TEXT,
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
  // Added after the table first shipped; older tables lack them.
  const columns = new Set(
    (yield* sql<{ name: string }>`PRAGMA table_info(agent_messages)`).map((column) => column.name),
  );
  for (const column of ["from_machine", "from_runtime_mode", "from_interaction_mode"]) {
    if (!columns.has(column)) {
      yield* sql.unsafe(`ALTER TABLE agent_messages ADD COLUMN ${column} TEXT`);
    }
  }
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
    const threads = yield* BacklogOrchestration;
    const backlog = yield* BacklogRouter.BacklogRouter;
    const hubClient = yield* BacklogHubClient.BacklogHubClient;
    const relayStore = yield* AgentMessageRelay.AgentMessageRelay;
    const serverEnvironment = yield* ServerEnvironment.ServerEnvironment;
    const events = yield* PubSub.unbounded<AgentMessageStreamEvent>();
    // Serializes the guard's count-then-insert so concurrent senders cannot
    // both take the last wake. Delivery itself runs outside the lock.
    const guardLock = yield* Semaphore.make(1);

    yield* ensureSchema;

    const localEnvironmentId = yield* serverEnvironment.getEnvironmentId;
    const localMachine = serverEnvironment.getDescriptor.pipe(
      Effect.map((descriptor) => descriptor.label),
    );
    const isLinked = hubClient.linkedHub.pipe(Effect.map(Option.isSome));

    const newId = crypto.randomUUIDv4.pipe(Effect.orDie);
    const nowIso = DateTime.now.pipe(Effect.map(DateTime.formatIso));

    const loadRow = Effect.fn("AgentMessageService.loadRow")(function* (id: string) {
      const rows = yield* sql<MessageRow>`SELECT * FROM agent_messages WHERE id = ${id}`;
      if (rows[0] === undefined) return yield* fail("not_found", "Message not found.");
      return yield* decodeRow(rows[0]);
    });

    /**
     * The hub: the linked one, or this machine's own post office when it is
     * not linked (it may be the hub for others).
     */
    const relayOut = (envelope: AgentMessageEnvelope) =>
      Effect.gen(function* () {
        if (yield* isLinked) {
          return yield* hubClient
            .relayAgentMessage(envelope)
            .pipe(
              Effect.mapError((error) =>
                isBacklogError(error)
                  ? new AgentMessageError({ code: "unavailable", message: error.message })
                  : error,
              ),
            );
        }
        return yield* relayStore.relay(envelope).pipe(
          Effect.mapError((error) =>
            error.code === "remote"
              ? new AgentMessageError({
                  code: "remote",
                  message: notLinkedError(envelope.to.threadId),
                })
              : error,
          ),
        );
      });

    const ackOut = (input: AgentMessageAckInput) =>
      Effect.gen(function* () {
        if (yield* isLinked) return yield* hubClient.ackAgentMessage(input);
        return yield* relayStore.ack(input);
      }).pipe(
        Effect.catch((error) =>
          Effect.logWarning("Could not report a relayed agent message's status", {
            id: input.id,
            error: error.message,
          }),
        ),
      );

    /** Tells the feed, and for a message relayed in, the sender through the hub. */
    const publish = (message: AgentMessage) =>
      PubSub.publish(events, { type: "messageUpserted", message }).pipe(
        Effect.andThen(
          message.from.environmentId === localEnvironmentId || message.status === "pending"
            ? Effect.void
            : ackOut({
                id: message.id,
                status: message.status,
                toLabel: message.to.label,
                deliveredAt: message.deliveredAt,
                error: message.error,
              }),
        ),
      );

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

    /**
     * Why the sender may not wake this thread, if it may not: the thread is
     * gone, or it runs with broader runtime or interaction modes than the
     * sender.
     */
    const permissionFailure = (
      sender: {
        readonly runtimeMode: RuntimeMode;
        readonly interactionMode: ProviderInteractionMode;
      },
      shell: BacklogThread | null,
    ): Effect.Effect<{ readonly code: FailureCode; readonly message: string } | null> => {
      if (shell === null) {
        return Effect.succeed({
          code: "not_found",
          message: "The receiving thread no longer exists.",
        });
      }
      const denied = (message: string) => Effect.succeed({ code: "denied" as const, message });
      if (runtimeModeRank(shell.runtimeMode) > runtimeModeRank(sender.runtimeMode)) {
        return denied(
          `This thread runs with narrower permissions (${sender.runtimeMode}) than the receiver (${shell.runtimeMode}), so it cannot wake it.`,
        );
      }
      if (
        interactionModeRank(shell.interactionMode) > interactionModeRank(sender.interactionMode)
      ) {
        return denied(
          `This thread is in ${sender.interactionMode} mode and the receiver is in ${shell.interactionMode} mode, so it cannot wake it.`,
        );
      }
      return Effect.succeed(null);
    };

    /** Hands the message to the receiver's thread and records how it went. */
    const dispatch = Effect.fn("AgentMessageService.dispatch")(function* (message: AgentMessage) {
      const attempt = Effect.gen(function* () {
        return yield* threads.deliver({
          threadId: message.to.threadId,
          key: `${AGENT_MESSAGE_ID_PREFIX}${message.id}`,
          text: formatAgentMessageForDelivery(
            message,
            message.from.machine ?? (yield* localMachine),
            localEnvironmentId,
          ),
          // An idle receiver starts either way. Busy: default waits for the
          // next turn; urgent steers into the running one.
          urgent: message.urgent,
        });
      });
      const delivery: AgentMessageDelivery | null = yield* attempt.pipe(
        Effect.catchCause((cause) =>
          Effect.gen(function* () {
            const squashed = Cause.squash(cause);
            yield* Effect.logWarning("Agent message delivery failed", { id: message.id, cause });
            yield* setStatus(message.id, { status: "failed", error: describeError(squashed) });
            return null;
          }),
        ),
      );
      const final = yield* loadRow(message.id);
      yield* publish(final);
      return { message: final, delivery } satisfies AgentMessageOutcome;
    });

    /**
     * Logs one message for a thread on this machine and decides held or
     * delivered under the guard. A relayed message seen before (the hub
     * redelivers until it hears back) is not logged twice; its status is
     * reported again instead.
     */
    const admit = Effect.fn("AgentMessageService.admit")(function* (input: {
      readonly origin: Origin;
      readonly recipient: Recipient;
      readonly topic: Topic;
      readonly text: string;
      readonly urgent: boolean;
    }) {
      const { origin, recipient, topic } = input;
      const shell = yield* threads.getThread(recipient.threadId);
      const refused = yield* permissionFailure(origin, shell);
      const id = origin.relayed?.id ?? (yield* newId);
      const admitted = yield* guardLock.withPermits(1)(
        Effect.gen(function* () {
          if (origin.relayed !== null) {
            const seen = yield* sql<{ id: string }>`SELECT id FROM agent_messages WHERE id = ${id}`;
            if (seen.length > 0) return { status: "seen" as const, failure: null };
          }
          const now = yield* nowIso;
          const held =
            refused === null
              ? ((yield* sql<{ count: number }>`
                  SELECT COUNT(*) AS count FROM agent_messages
                  WHERE to_thread_id = ${recipient.threadId} AND status = 'held'
                `)[0]?.count ?? 0)
              : 0;
          const failure =
            refused ??
            (held >= AGENT_MESSAGE_HELD_PER_THREAD
              ? {
                  code: "conflict" as const,
                  message: `${shell?.title ?? "The receiving thread"} already has ${AGENT_MESSAGE_HELD_PER_THREAD} messages waiting for the user. Wait for them to be released or dismissed.`,
                }
              : null);
          // Later messages wait behind a held one so the receiver never sees them out of order.
          const status: AgentMessage["status"] =
            failure !== null
              ? "failed"
              : held > 0 ||
                  (yield* wakesInWindow(recipient.threadId)) >= AGENT_MESSAGE_WAKES_PER_HOUR
                ? "held"
                : "delivered";
          yield* sql`
            INSERT INTO agent_messages (
              id, from_environment_id, from_thread_id, from_label, from_machine,
              from_runtime_mode, from_interaction_mode, to_environment_id, to_thread_id,
              to_label, issue_id, issue_key, text, urgent, status, created_at, delivered_at, error
            ) VALUES (
              ${id}, ${origin.environmentId}, ${origin.threadId}, ${origin.label},
              ${origin.relayed?.machine ?? null}, ${origin.runtimeMode}, ${origin.interactionMode},
              ${recipient.environmentId}, ${recipient.threadId},
              ${shell?.title ?? recipient.threadId}, ${topic.issueId}, ${topic.issueKey},
              ${input.text}, ${input.urgent ? 1 : 0}, ${status},
              ${origin.relayed?.createdAt ?? now}, ${status === "delivered" ? now : null},
              ${failure?.message ?? null}
            )
          `;
          return { status, failure };
        }),
      );
      const message = yield* loadRow(id);
      if (admitted.status !== "delivered") {
        yield* publish(message);
        return {
          message,
          delivery: null,
          failureCode: admitted.failure?.code ?? null,
        } satisfies Admitted;
      }
      const outcome = yield* dispatch(message);
      return {
        ...outcome,
        failureCode: outcome.message.status === "failed" ? "unavailable" : null,
      } satisfies Admitted;
    }, Effect.uninterruptible);

    /** Logs a message for a thread on another machine and hands it to the hub. */
    const sendRemote = Effect.fn("AgentMessageService.sendRemote")(function* (input: {
      readonly sender: AgentMessageSender;
      readonly recipient: Recipient;
      readonly topic: Topic;
      readonly text: string;
      readonly urgent: boolean;
    }) {
      const { sender, recipient, topic } = input;
      const id = yield* newId;
      const createdAt = yield* nowIso;
      const envelope: AgentMessageEnvelope = {
        id: id as AgentMessageEnvelope["id"],
        from: {
          environmentId: sender.environmentId,
          threadId: sender.threadId,
          label: sender.label,
          machine: yield* localMachine,
          runtimeMode: sender.runtimeMode,
          interactionMode: sender.interactionMode,
        },
        to: { environmentId: recipient.environmentId, threadId: recipient.threadId },
        issueId: topic.issueId,
        issueKey: topic.issueKey as AgentMessageEnvelope["issueKey"],
        text: input.text,
        urgent: input.urgent,
        createdAt: createdAt as AgentMessageEnvelope["createdAt"],
      };
      // The receiving thread's title arrives with the receiver's ack.
      yield* sql`
        INSERT INTO agent_messages (
          id, from_environment_id, from_thread_id, from_label, from_machine,
          to_environment_id, to_thread_id, to_label, issue_id, issue_key, text, urgent,
          status, created_at, delivered_at, error
        ) VALUES (
          ${id}, ${sender.environmentId}, ${sender.threadId}, ${sender.label}, null,
          ${recipient.environmentId}, ${recipient.threadId}, ${recipient.threadId},
          ${topic.issueId}, ${topic.issueKey}, ${input.text}, ${input.urgent ? 1 : 0},
          'pending', ${createdAt}, null, null
        )
      `;
      const relayed = yield* Effect.result(relayOut(envelope));
      // An ack can beat the relay's answer here; only a still-pending row may fail.
      if (relayed._tag === "Failure") {
        yield* sql`
          UPDATE agent_messages SET status = 'failed', error = ${relayed.failure.message}
          WHERE id = ${id} AND status = 'pending'
        `;
      }
      const message = yield* loadRow(id);
      yield* publish(message);
      return {
        message,
        delivery: null,
        failureCode:
          relayed._tag === "Failure" && message.status === "failed" ? relayed.failure.code : null,
      } satisfies Admitted;
    }, Effect.uninterruptible);

    const record = (input: {
      readonly sender: AgentMessageSender;
      readonly recipient: Recipient;
      readonly topic: Topic;
      readonly text: string;
      readonly urgent: boolean;
    }) =>
      input.recipient.environmentId === localEnvironmentId
        ? admit({ ...input, origin: { ...input.sender, relayed: null } })
        : sendRemote(input);

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
        // A thread on another machine is checked there, and reported back through the hub.
        if (recipient.environmentId === localEnvironmentId) {
          const shell = yield* threads.getThread(recipient.threadId);
          if (shell === null) {
            return yield* fail(
              "not_found",
              `Thread ${recipient.threadId} not found on this machine. For a thread on another machine, give its environmentId too.`,
            );
          }
        }
        return { recipients: [recipient], topic: { issueId: null, issueKey: null } };
      }

      // The issue may live here or on the hub; its claim names the holder's machine.
      const detail = yield* backlog.getIssue(target.issue).pipe(Effect.mapError(fromBacklogError));
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
        if (text.length > AGENT_MESSAGE_MAX_TEXT_LENGTH) {
          return yield* fail(
            "invalid",
            `The message is ${text.length} characters; keep it under ${AGENT_MESSAGE_MAX_TEXT_LENGTH}.`,
          );
        }
        const { recipients, topic } = yield* resolveRecipients(input.target, sender);
        const admitted = yield* Effect.forEach(recipients, (recipient) =>
          record({ sender, recipient, topic, text, urgent: input.urgent ?? false }),
        );
        if (admitted.every((outcome) => outcome.message.status === "failed")) {
          const first = admitted[0]!;
          return yield* fail(
            first.failureCode ?? "unavailable",
            first.message.error ?? "The message could not be delivered.",
          );
        }
        return admitted.map(({ message, delivery }) => ({ message, delivery }));
      }).pipe(agentMessageErrorsOnly);

    /** Held messages are released or dismissed on the receiving machine, which owns the guard. */
    const loadHeldHere = (id: string, verb: "released" | "dismissed") =>
      Effect.gen(function* () {
        const current = yield* loadRow(id);
        if (current.status !== "held") {
          return yield* fail(
            "conflict",
            `Only a held message can be ${verb === "released" ? "released" : "dismissed"}.`,
          );
        }
        if (current.to.environmentId !== localEnvironmentId) {
          return yield* fail(
            "remote",
            "This message is held on the receiving machine. Release or dismiss it there.",
          );
        }
        return current;
      });

    const release: AgentMessageService["Service"]["release"] = ({ id }) =>
      Effect.gen(function* () {
        const message = yield* guardLock.withPermits(1)(
          Effect.gen(function* () {
            yield* loadHeldHere(id, "released");
            yield* setStatus(id, { status: "released", deliveredAt: yield* nowIso });
            return yield* loadRow(id);
          }),
        );
        return (yield* dispatch(message)).message;
      }).pipe(Effect.uninterruptible, agentMessageErrorsOnly);

    const dismiss: AgentMessageService["Service"]["dismiss"] = ({ id }) =>
      Effect.gen(function* () {
        const message = yield* guardLock.withPermits(1)(
          Effect.gen(function* () {
            yield* loadHeldHere(id, "dismissed");
            yield* setStatus(id, { status: "dismissed" });
            return yield* loadRow(id);
          }),
        );
        yield* publish(message);
        return message;
      }).pipe(agentMessageErrorsOnly);

    /** A message relayed in for one of this machine's threads. */
    const receive = (envelope: AgentMessageEnvelope) =>
      Effect.gen(function* () {
        const outcome = yield* admit({
          origin: {
            environmentId: envelope.from.environmentId,
            threadId: envelope.from.threadId,
            label: envelope.from.label,
            runtimeMode: envelope.from.runtimeMode,
            interactionMode: envelope.from.interactionMode,
            relayed: {
              id: envelope.id,
              createdAt: envelope.createdAt,
              machine: envelope.from.machine,
            },
          },
          recipient: { environmentId: localEnvironmentId, threadId: envelope.to.threadId },
          topic: { issueId: envelope.issueId, issueKey: envelope.issueKey },
          text: envelope.text,
          urgent: envelope.urgent,
        }).pipe(Effect.catchIf(isAgentMessageError, Effect.die));
        return outcome;
      });

    /** What became of a message this machine sent to another one. */
    const applyRelayStatus = Effect.fn("AgentMessageService.applyRelayStatus")(function* (
      update: AgentMessageAckInput,
    ) {
      const rows = yield* sql<MessageRow>`
        SELECT * FROM agent_messages
        WHERE id = ${update.id} AND from_environment_id = ${localEnvironmentId}
          AND to_environment_id != ${localEnvironmentId}
      `;
      const row = rows[0];
      if (
        row === undefined ||
        (row.status === update.status &&
          row.to_label === update.toLabel &&
          row.delivered_at === update.deliveredAt &&
          row.error === update.error)
      ) {
        return;
      }
      yield* sql`
        UPDATE agent_messages SET
          status = ${update.status},
          to_label = ${update.toLabel.length > 0 ? update.toLabel : row.to_label},
          delivered_at = ${update.deliveredAt},
          error = ${update.error}
        WHERE id = ${update.id}
      `;
      yield* publish(yield* loadRow(update.id));
    });

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
            let budget = AGENT_MESSAGE_WAKES_PER_HOUR - (yield* wakesInWindow(threadId));
            if (budget <= 0) return { released: [], refused: [] };
            const held = yield* sql<MessageRow>`
              SELECT * FROM agent_messages WHERE to_thread_id = ${threadId} AND status = 'held'
              ORDER BY created_at, rowid
            `;
            // The user answered the thread, not each sender: a sender that may no
            // longer wake it (its modes changed since) is refused, not released.
            const shell = yield* threads.getThread(threadId);
            const deliveredAt = yield* nowIso;
            const released: AgentMessage[] = [];
            const refused: AgentMessage[] = [];
            for (const row of held) {
              if (budget <= 0) break;
              const failure =
                row.from_runtime_mode === null || row.from_interaction_mode === null
                  ? null
                  : yield* permissionFailure(
                      {
                        runtimeMode: row.from_runtime_mode as RuntimeMode,
                        interactionMode: row.from_interaction_mode as ProviderInteractionMode,
                      },
                      shell,
                    );
              if (failure !== null) {
                yield* setStatus(row.id, { status: "failed", error: failure.message });
                refused.push(yield* loadRow(row.id));
                continue;
              }
              yield* setStatus(row.id, { status: "released", deliveredAt });
              released.push(yield* loadRow(row.id));
              budget--;
            }
            return { released, refused };
          }),
        );
        yield* Effect.forEach(released.refused, publish, { discard: true });
        return yield* Effect.forEach(released.released, (message) =>
          dispatch(message).pipe(Effect.map((outcome) => outcome.message)),
        );
      }).pipe(Effect.uninterruptible, Effect.orDie);

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
      Stream.runForEach(threads.userMessages, (message) =>
        noteUserMessage(message.threadId, message.at).pipe(
          Effect.asVoid,
          // One bad release must not stop the watcher for every other thread.
          Effect.catchCause((cause) =>
            Effect.logWarning("Releasing held agent messages failed", { cause }),
          ),
        ),
      ).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("Agent message user-message watcher stopped", { cause }),
        ),
      ),
    );

    const subscribeHeldCount: AgentMessageService["Service"]["subscribeHeldCount"] = () =>
      Stream.unwrap(
        Effect.gen(function* () {
          const subscription = yield* PubSub.subscribe(events);
          // A sender's copy of a message held elsewhere is counted where it is held.
          const count = sql<{ count: number }>`
            SELECT COUNT(*) AS count FROM agent_messages
            WHERE status = 'held' AND to_environment_id = ${localEnvironmentId}
          `.pipe(
            Effect.map((rows) => rows[0]?.count ?? 0),
            Effect.orDie,
          );
          return Stream.concat(
            Stream.fromEffect(count),
            Stream.fromSubscription(subscription).pipe(Stream.mapEffect(() => count)),
          ).pipe(Stream.changes);
        }),
      );

    // This machine's inbox at the hub: messages for its threads, and acks for the
    // ones it sent. Unlinked, it reads its own post office, since it may be the
    // hub for others. Reopened whenever it ends, the link changes, or the hub drops.
    const handleInboxEvent = (event: AgentMessageInboxEvent) =>
      event.type === "message"
        ? event.message.to.environmentId === localEnvironmentId
          ? receive(event.message).pipe(Effect.asVoid)
          : Effect.void
        : applyRelayStatus(event.update);

    const linkChanged = (wasLinked: boolean): Effect.Effect<void> =>
      Effect.sleep(INBOX_LINK_POLL).pipe(
        Effect.andThen(isLinked),
        Effect.flatMap((linked) => (linked === wasLinked ? linkChanged(wasLinked) : Effect.void)),
      );

    const readInbox = Effect.gen(function* () {
      const linked = yield* isLinked;
      const input = { environmentId: localEnvironmentId, label: yield* localMachine };
      const inbox: Stream.Stream<AgentMessageInboxEvent, AgentMessageError | BacklogError> = linked
        ? hubClient.agentMessageInbox(input)
        : relayStore.inbox(input);
      yield* inbox.pipe(
        Stream.interruptWhen(linkChanged(linked)),
        Stream.runForEach((event) =>
          handleInboxEvent(event).pipe(
            // One bad message must not close the inbox; the hub redelivers it next time.
            Effect.catchCause((cause) =>
              Effect.logWarning("Handling a relayed agent message failed", { cause }),
            ),
          ),
        ),
      );
    });

    yield* forkParked(
      readInbox.pipe(
        Effect.catchCause((cause) => Effect.logDebug("Agent message inbox closed", { cause })),
        Effect.andThen(Effect.sleep(INBOX_RETRY)),
        Effect.forever,
      ),
    );

    return AgentMessageService.of({
      send,
      release,
      dismiss,
      noteUserMessage,
      subscribe,
      subscribeHeldCount,
    });
  }),
);

/** Agent messages with the fleet link they relay through, for the server runtime. */
export const fleetLayer = layer.pipe(
  Layer.provideMerge(Layer.merge(AgentMessageRelay.layer, BacklogRouter.fleetLayer)),
);
