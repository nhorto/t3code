import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/unstable/reactivity";
import { useMemo } from "react";

import { agentMessageEnvironment } from "../../state/agentMessages";
import { useEnvironments } from "../../state/environments";
import {
  isAgentMessagesUnsupportedCause,
  type AgentMessageFeedSource,
} from "./agentMessages.logic";

function describeFailure(cause: Cause.Cause<unknown>): string {
  const error = Cause.squash(cause);
  return error instanceof Error && error.message.trim().length > 0
    ? error.message
    : "Messages could not be loaded.";
}

/** Every environment's feed in one derived atom keyed by the environment set, like the boards. */
const feedsAtom = Atom.family((key: string) =>
  Atom.make((get): ReadonlyArray<AgentMessageFeedSource> =>
    (JSON.parse(key) as ReadonlyArray<EnvironmentId>).map((environmentId) => {
      const result = get(agentMessageEnvironment.feed({ environmentId, input: {} }));
      const unsupported =
        result._tag === "Failure" && isAgentMessagesUnsupportedCause(result.cause);
      return {
        environmentId,
        // The last snapshot folded with its deltas; kept while the connection is down.
        feed: Option.getOrNull(AsyncResult.value(result)),
        error: result._tag === "Failure" && !unsupported ? describeFailure(result.cause) : null,
        unsupported,
      };
    }),
  ).pipe(Atom.withLabel(`mobile:agent-messages:feeds:${key}`)),
);

/**
 * Held counts summed across environments from the count-only stream, never the feeds. Each
 * server counts what it holds for its own threads, so a relayed message counts once. Servers
 * without the stream count as zero.
 */
const heldCountAtom = Atom.family((key: string) =>
  Atom.make((get): number => {
    let total = 0;
    for (const environmentId of JSON.parse(key) as ReadonlyArray<EnvironmentId>) {
      const result = get(agentMessageEnvironment.heldCount({ environmentId, input: {} }));
      total += Option.getOrElse(AsyncResult.value(result), () => 0);
    }
    return total;
  }).pipe(Atom.withLabel(`mobile:agent-messages:held:${key}`)),
);

/** Enabled, supported environments in a stable order, so the subscription key does not churn. */
function useMessagingEnvironmentKey(): string {
  const { environments } = useEnvironments();
  return useMemo(
    () =>
      JSON.stringify(
        environments
          .filter(
            (environment) =>
              environment.entry.enabled && environment.connection.phase !== "unsupported",
          )
          .map((environment) => environment.environmentId)
          .sort((left, right) => left.localeCompare(right)),
      ),
    [environments],
  );
}

/** Live agent message feeds for every enabled environment. */
export function useAgentMessageFeeds(): ReadonlyArray<AgentMessageFeedSource> {
  return useAtomValue(feedsAtom(useMessagingEnvironmentKey()));
}

/** Messages held for the user across every connected machine; drives the Backlog badges. */
export function useHeldAgentMessageCount(): number {
  return useAtomValue(heldCountAtom(useMessagingEnvironmentKey()));
}
