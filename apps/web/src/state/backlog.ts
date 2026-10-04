import { useAtomValue } from "@effect/atom-react";
import {
  createBacklogEnvironmentAtoms,
  type BacklogBoardState,
} from "@t3tools/client-runtime/state/backlog";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type { BacklogIssueId, EnvironmentId } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/unstable/reactivity";

import { connectionAtomRuntime } from "../connection/runtime";
import { formatEnvironmentQueryError } from "./query";

export const backlogEnvironment = createBacklogEnvironmentAtoms(connectionAtomRuntime);

export interface EnvironmentBacklogBoard {
  readonly environmentId: EnvironmentId;
  /** The last snapshot folded with its deltas; kept while the connection is down. */
  readonly board: BacklogBoardState | null;
  readonly error: string | null;
}

/**
 * Every environment's live board read at once. React cannot subscribe to a list of atoms whose
 * length changes, so the fan-out happens in one derived atom keyed by the environment set.
 */
const boardsAtom = Atom.family((key: string) =>
  Atom.make((get): ReadonlyArray<EnvironmentBacklogBoard> => {
    const environmentIds = JSON.parse(key) as ReadonlyArray<EnvironmentId>;
    return environmentIds.map((environmentId) => {
      const result = get(backlogEnvironment.board({ environmentId, input: {} }));
      return {
        environmentId,
        board: Option.getOrNull(AsyncResult.value(result)),
        error: result._tag === "Failure" ? formatEnvironmentQueryError(result.cause) : null,
      };
    });
  }).pipe(Atom.withLabel(`web-backlog:boards:${key}`)),
);

export function useBacklogBoards(
  environmentIds: ReadonlyArray<EnvironmentId>,
): ReadonlyArray<EnvironmentBacklogBoard> {
  return useAtomValue(boardsAtom(JSON.stringify(environmentIds)));
}

const EMPTY_DETAIL_ATOM = Atom.make(AsyncResult.initial(false)).pipe(
  Atom.withLabel("web-backlog:issue-detail:none"),
);

export function useBacklogIssueDetail(
  target: { readonly environmentId: EnvironmentId; readonly issueId: BacklogIssueId } | null,
) {
  const result = useAtomValue(
    target === null
      ? EMPTY_DETAIL_ATOM
      : backlogEnvironment.issueDetail({
          environmentId: target.environmentId,
          input: { issueId: target.issueId },
        }),
  );
  return {
    detail: target === null ? null : Option.getOrNull(AsyncResult.value(result)),
    error: result._tag === "Failure" ? formatEnvironmentQueryError(result.cause) : null,
  };
}

/** A command failure as one line for a toast: the server's own message when it sent one. */
export function backlogFailureMessage(result: Parameters<typeof squashAtomCommandFailure>[0]) {
  const error = squashAtomCommandFailure(result);
  if (error instanceof Error && error.message.trim().length > 0) return error.message;
  if (typeof error === "object" && error !== null && "message" in error) {
    const message = (error as { message: unknown }).message;
    if (typeof message === "string" && message.trim().length > 0) return message;
  }
  return "The environment could not apply the change.";
}
