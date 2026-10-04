import { BacklogError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { BacklogOrchestration } from "../backlog/BacklogOrchestration.ts";
import * as McpInvocationContext from "./McpInvocationContext.ts";

/** The thread whose provider session made this MCP call. Every provider session may call. */
export const readCaller = Effect.fn("mcp.readCaller")(function* () {
  const scope = yield* McpInvocationContext.McpInvocationContext;
  const threads = yield* BacklogOrchestration;
  const caller = yield* threads.getThread(scope.threadId);
  if (caller === null) {
    return yield* new BacklogError({
      code: "not_found",
      message: "The calling thread was not found.",
    });
  }
  return { scope, caller };
});
