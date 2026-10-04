import { useAtomValue } from "@effect/atom-react";
import {
  createAgentMessageEnvironmentAtoms,
  type AgentMessageFeedState,
} from "@t3tools/client-runtime/state/agent-messages";
import type { EnvironmentId } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/unstable/reactivity";
import { useMemo } from "react";

import { connectionAtomRuntime } from "../connection/runtime";
import { useEnvironments } from "./environments";
import { formatEnvironmentQueryError } from "./query";

export const agentMessageEnvironment = createAgentMessageEnvironmentAtoms(connectionAtomRuntime);

export interface EnvironmentAgentMessageFeed {
  readonly environmentId: EnvironmentId;
  /** The last snapshot folded with its deltas; kept while the connection is down. */
  readonly feed: AgentMessageFeedState | null;
  readonly error: string | null;
}

/** Every environment's feed in one derived atom keyed by the environment set, like the boards. */
const feedsAtom = Atom.family((key: string) =>
  Atom.make((get): ReadonlyArray<EnvironmentAgentMessageFeed> => {
    const environmentIds = JSON.parse(key) as ReadonlyArray<EnvironmentId>;
    return environmentIds.map((environmentId) => {
      const result = get(agentMessageEnvironment.feed({ environmentId, input: {} }));
      return {
        environmentId,
        feed: Option.getOrNull(AsyncResult.value(result)),
        error: result._tag === "Failure" ? formatEnvironmentQueryError(result.cause) : null,
      };
    });
  }).pipe(Atom.withLabel(`web-agent-messages:feeds:${key}`)),
);

/** Enabled, supported environments in a stable order, so the subscription key does not churn. */
function useMessagingEnvironmentIds(): ReadonlyArray<EnvironmentId> {
  const { environments } = useEnvironments();
  return useMemo(
    () =>
      environments
        .filter(
          (environment) =>
            environment.entry.enabled && environment.connection.phase !== "unsupported",
        )
        .map((environment) => environment.environmentId)
        .toSorted((left, right) => left.localeCompare(right)),
    [environments],
  );
}

export function useAgentMessageFeeds(): ReadonlyArray<EnvironmentAgentMessageFeed> {
  const environmentIds = useMessagingEnvironmentIds();
  return useAtomValue(feedsAtom(JSON.stringify(environmentIds)));
}

/** Held counts summed across environments; subscribes to counts only, never the feeds. */
const heldCountAtom = Atom.family((key: string) =>
  Atom.make((get): number => {
    const environmentIds = JSON.parse(key) as ReadonlyArray<EnvironmentId>;
    let total = 0;
    for (const environmentId of environmentIds) {
      const result = get(agentMessageEnvironment.heldCount({ environmentId, input: {} }));
      total += Option.getOrElse(AsyncResult.value(result), () => 0);
    }
    return total;
  }).pipe(Atom.withLabel(`web-agent-messages:held-count:${key}`)),
);

/** Messages held for the user across every connected machine; drives the Backlog badge. */
export function useHeldAgentMessageCount(): number {
  const environmentIds = useMessagingEnvironmentIds();
  return useAtomValue(heldCountAtom(JSON.stringify(environmentIds)));
}
