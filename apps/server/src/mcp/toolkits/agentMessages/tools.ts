import {
  AGENT_MESSAGE_MAX_TEXT_LENGTH,
  AgentMessageError,
  AgentMessageId,
  AgentMessageStatus,
  EnvironmentId,
  OrchestratorMcpFailure,
  ThreadId,
  TrimmedNonEmptyString,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/unstable/ai";

import * as AgentMessageService from "../../../agentMessages/AgentMessageService.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

const AgentMessageTool = Tool.make("agent_message", {
  failure: Schema.Union([OrchestratorMcpFailure, AgentMessageError]),
  failureMode: "return",
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    ThreadManagementService.ThreadManagementService,
    AgentMessageService.AgentMessageService,
  ],
  description:
    "Send a message to another agent's thread, in any project, with any provider, on this machine or another machine linked to the same backlog hub, and wake it. Use it to ask the agent holding a backlog issue a question (issue: WINE-12), to tell a chat that is waiting on you that its dependency is done (threadId), or to tell every agent working a spec about a plan change (spec: WINE-3 reaches the holder of every claimed child and of the spec). Give exactly one of threadId, issue, or spec. An idle receiver starts a turn at once; a busy one gets the message as its next turn; urgent steers it into the running turn, so use urgent only when the receiver must change course now. Replies arrive later as a new turn in your thread, so do not wait or poll for them. A message for another machine travels through the backlog hub and comes back with status pending; it is delivered when that machine is online, or reported failed after 24 hours. Each thread accepts at most 10 agent wakes an hour; beyond that messages are held until the user releases them. Use t3_thread_send instead for delegating work to threads you manage in your own project.",
  parameters: Schema.Struct({
    threadId: Schema.optional(
      ThreadId.annotate({
        description:
          "The receiving thread, in any project. Use the thread id from a message header to reply.",
      }),
    ),
    environmentId: Schema.optional(
      EnvironmentId.annotate({
        description:
          "With threadId: the machine the thread runs on, when it is not this one. Copy it from a message header to reply across machines.",
      }),
    ),
    issue: Schema.optional(
      TrimmedNonEmptyString.annotate({
        description: "A backlog issue key such as WINE-12: messages the agent holding its claim.",
      }),
    ),
    spec: Schema.optional(
      TrimmedNonEmptyString.annotate({
        description:
          "A parent spec issue key such as WINE-3: messages every agent holding a claimed child, plus the spec's holder.",
      }),
    ),
    text: TrimmedNonEmptyString.check(Schema.isMaxLength(AGENT_MESSAGE_MAX_TEXT_LENGTH)).annotate({
      description:
        "The message. Make it self-contained: the receiver sees who sent it and how to reply, but not your conversation.",
    }),
    urgent: Schema.optional(
      Schema.Boolean.annotate({
        description: "Steer into the receiver's running turn instead of waiting for it to finish.",
      }),
    ),
  }),
  success: Schema.Struct({
    messages: Schema.Array(
      Schema.Struct({
        id: AgentMessageId,
        environmentId: EnvironmentId,
        threadId: ThreadId,
        threadTitle: Schema.String,
        status: AgentMessageStatus,
        delivery: Schema.NullOr(Schema.Literals(["started", "queued", "steered", "restarted"])),
        error: Schema.NullOr(Schema.String),
      }),
    ),
  }),
})
  .annotate(Tool.Title, "Message another agent")
  .annotate(Tool.Destructive, false);

export const AgentMessageToolkit = Toolkit.make(AgentMessageTool);
