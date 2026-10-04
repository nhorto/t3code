import { AgentMessageError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import * as AgentMessageService from "../../../agentMessages/AgentMessageService.ts";
import { readCaller } from "../../threadAccess.ts";
import { AgentMessageToolkit } from "./tools.ts";

export const AgentMessageHandlersLive = AgentMessageToolkit.toLayer({
  agent_message: (input) =>
    Effect.gen(function* () {
      const { scope, caller } = yield* readCaller();
      const target: AgentMessageService.AgentMessageTarget | null =
        input.threadId !== undefined && input.issue === undefined && input.spec === undefined
          ? { type: "thread", threadId: input.threadId, environmentId: input.environmentId }
          : input.issue !== undefined && input.threadId === undefined && input.spec === undefined
            ? { type: "issue", issue: input.issue }
            : input.spec !== undefined && input.threadId === undefined && input.issue === undefined
              ? { type: "spec", issue: input.spec }
              : null;
      if (target === null || (input.environmentId !== undefined && target.type !== "thread")) {
        return yield* new AgentMessageError({
          code: "invalid",
          message:
            "Give exactly one of threadId, issue, or spec; environmentId only goes with threadId.",
        });
      }
      const service = yield* AgentMessageService.AgentMessageService;
      const outcomes = yield* service.send(
        { target, text: input.text, urgent: input.urgent },
        {
          environmentId: scope.environmentId,
          threadId: scope.threadId,
          label: `${caller.title} · ${caller.modelSelection.model}`,
          runtimeMode: caller.runtimeMode,
          interactionMode: caller.interactionMode,
        },
      );
      return {
        messages: outcomes.map(({ message, delivery }) => ({
          id: message.id,
          environmentId: message.to.environmentId,
          threadId: message.to.threadId,
          threadTitle: message.to.label,
          status: message.status,
          delivery,
          error: message.error,
        })),
      };
    }),
});
