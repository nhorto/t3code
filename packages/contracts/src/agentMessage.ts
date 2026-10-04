import * as Schema from "effect/Schema";

import {
  BacklogIssueId,
  EnvironmentId,
  IsoDateTime,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";

/** Agent wakes a receiving thread accepts per rolling hour before messages are held. */
export const AGENT_MESSAGE_WAKES_PER_HOUR = 10;

export const AgentMessageId = TrimmedNonEmptyString.pipe(Schema.brand("AgentMessageId"));
export type AgentMessageId = typeof AgentMessageId.Type;

/**
 * delivered: in the receiver's thread. held: over the loop guard, waiting for the
 * user. released: a held message the user (or a user message) let through.
 * dismissed: a held message the user dropped. failed: could not be delivered.
 */
export const AgentMessageStatus = Schema.Literals([
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
