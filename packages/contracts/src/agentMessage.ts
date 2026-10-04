import * as Schema from "effect/Schema";

import {
  BacklogIssueId,
  EnvironmentId,
  IsoDateTime,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";
import { ProviderInteractionMode, RuntimeMode } from "./orchestration.ts";

/** Agent wakes a receiving thread accepts per rolling hour before messages are held. */
export const AGENT_MESSAGE_WAKES_PER_HOUR = 10;
/** Messages held for one receiving thread before further ones are refused. */
export const AGENT_MESSAGE_HELD_PER_THREAD = 50;
/** Longest message an agent may send. */
export const AGENT_MESSAGE_MAX_TEXT_LENGTH = 8_000;

export const AgentMessageId = TrimmedNonEmptyString.pipe(Schema.brand("AgentMessageId"));
export type AgentMessageId = typeof AgentMessageId.Type;

/**
 * pending: on its way to a thread on another machine, through the backlog hub.
 * delivered: in the receiver's thread. held: over the loop guard, waiting for the
 * user. released: a held message the user (or a user message) let through.
 * dismissed: a held message the user dropped. failed: could not be delivered.
 */
export const AgentMessageStatus = Schema.Literals([
  "pending",
  "delivered",
  "held",
  "released",
  "dismissed",
  "failed",
]);
export type AgentMessageStatus = typeof AgentMessageStatus.Type;

/** One message from an agent's thread to another thread. A spec broadcast logs one per receiver. */
export const AgentMessage = Schema.Struct({
  id: AgentMessageId,
  from: Schema.Struct({
    environmentId: EnvironmentId,
    threadId: ThreadId,
    label: Schema.String,
    /** The sender's machine, when it is not the machine that logged the message. */
    machine: Schema.optionalKey(Schema.String),
  }),
  to: Schema.Struct({
    environmentId: EnvironmentId,
    threadId: ThreadId,
    /** The receiving thread's title when the message was sent. */
    label: Schema.String,
  }),
  issueId: Schema.NullOr(BacklogIssueId),
  issueKey: Schema.NullOr(TrimmedNonEmptyString),
  text: Schema.String,
  urgent: Schema.Boolean,
  status: AgentMessageStatus,
  createdAt: IsoDateTime,
  deliveredAt: Schema.NullOr(IsoDateTime),
  error: Schema.NullOr(Schema.String),
});
export type AgentMessage = typeof AgentMessage.Type;

export class AgentMessageError extends Schema.TaggedError<AgentMessageError>()(
  "AgentMessageError",
  {
    /** remote: the receiver is on another machine. unavailable: the backlog could not be read. */
    code: Schema.Literals(["not_found", "conflict", "invalid", "remote", "denied", "unavailable"]),
    message: Schema.String,
  },
) {}

export const AgentMessageStreamEvent = Schema.Union([
  Schema.Struct({ type: Schema.Literal("snapshot"), messages: Schema.Array(AgentMessage) }),
  Schema.Struct({ type: Schema.Literal("messageUpserted"), message: AgentMessage }),
]);
export type AgentMessageStreamEvent = typeof AgentMessageStreamEvent.Type;

export const AgentMessagesSubscribeInput = Schema.Struct({});
export type AgentMessagesSubscribeInput = typeof AgentMessagesSubscribeInput.Type;

export const AgentMessageActionInput = Schema.Struct({ id: AgentMessageId });
export type AgentMessageActionInput = typeof AgentMessageActionInput.Type;

// Fleet relay: the hub is the post office for messages between machines. A
// machine sends through its hub, and keeps an inbox subscription open to the
// hub for messages addressed to its threads. The message keeps one id on
// every machine, so acks and feeds line up.

/** A message on its way between machines. */
export const AgentMessageEnvelope = Schema.Struct({
  id: AgentMessageId,
  from: Schema.Struct({
    environmentId: EnvironmentId,
    threadId: ThreadId,
    label: Schema.String,
    machine: Schema.String,
    /** The receiver refuses to wake a thread with broader modes than these. */
    runtimeMode: RuntimeMode,
    interactionMode: ProviderInteractionMode,
  }),
  to: Schema.Struct({ environmentId: EnvironmentId, threadId: ThreadId }),
  issueId: Schema.NullOr(BacklogIssueId),
  issueKey: Schema.NullOr(TrimmedNonEmptyString),
  text: Schema.String.check(Schema.isMaxLength(AGENT_MESSAGE_MAX_TEXT_LENGTH)),
  urgent: Schema.Boolean,
  createdAt: IsoDateTime,
});
export type AgentMessageEnvelope = typeof AgentMessageEnvelope.Type;

export const AgentMessageRelayReceipt = Schema.Struct({
  id: AgentMessageId,
  /** The receiving machine's name. */
  machine: Schema.String,
});
export type AgentMessageRelayReceipt = typeof AgentMessageRelayReceipt.Type;

/** What became of a relayed message on the receiving machine. */
export const AgentMessageAckInput = Schema.Struct({
  id: AgentMessageId,
  status: Schema.Literals(["delivered", "held", "released", "dismissed", "failed"]),
  /** The receiving thread's title. */
  toLabel: Schema.String,
  deliveredAt: Schema.NullOr(IsoDateTime),
  error: Schema.NullOr(Schema.String),
});
export type AgentMessageAckInput = typeof AgentMessageAckInput.Type;

export const AgentMessagesSubscribeInboxInput = Schema.Struct({
  environmentId: EnvironmentId,
  /** The subscribing machine's name, for messages that cannot reach it. */
  label: Schema.String,
});
export type AgentMessagesSubscribeInboxInput = typeof AgentMessagesSubscribeInboxInput.Type;

/** Messages waiting for the subscriber's threads, then what became of the ones it sent. */
export const AgentMessageInboxEvent = Schema.Union([
  Schema.Struct({ type: Schema.Literal("message"), message: AgentMessageEnvelope }),
  Schema.Struct({ type: Schema.Literal("status"), update: AgentMessageAckInput }),
]);
export type AgentMessageInboxEvent = typeof AgentMessageInboxEvent.Type;
