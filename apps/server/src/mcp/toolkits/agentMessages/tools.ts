import {
  AgentMessageError,
  AgentMessageId,
  AgentMessageStatus,
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
    "Send a message to another agent's thread on this machine, in any project and with any provider, and wake it. Use it to ask the agent holding a backlog issue a question (issue: WINE-12), to tell a chat that is waiting on you that its dependency is done (threadId), or to tell every agent working a spec about a plan change (spec: WINE-3 reaches the holder of every claimed child and of the spec). Give exactly one of threadId, issue, or spec. An idle receiver starts a turn at once; a busy one gets the message as its next turn; urgent steers it into the running turn, so use urgent only when the receiver must change course now. Replies arrive later as a new turn in your thread, so do not wait or poll for them. Each thread accepts at most 10 agent wakes an hour; beyond that messages are held until the user releases them. Use t3_thread_send instead for delegating work to threads you manage in your own project.",
  parameters: Schema.Struct({
    threadId: Schema.optional(
      ThreadId.annotate({
        description:
          "The receiving thread, in any project on this machine. Use the thread id from a message header to reply.",
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
    text: TrimmedNonEmptyString.annotate({
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
