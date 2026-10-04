import { useAtomValue } from "@effect/atom-react";
import {
  isBacklogUnsupportedCause,
  type BacklogBoardState,
} from "@t3tools/client-runtime/state/backlog";
import { buildProjectGroups } from "@t3tools/client-runtime/state/project-grouping";
import type { EnvironmentId } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/unstable/reactivity";
import { useCallback, useMemo } from "react";

import { relativeTime } from "../../lib/time";
import { backlogEnvironment } from "../../state/backlog";
import { useProjects } from "../../state/entities";
import { useEnvironments } from "../../state/environments";
import { useMobileProjectGroupingSettings } from "../../state/project-grouping";
import {
  backlogReadOnlyReason,
  buildBacklogScopes,
  mergeBacklogIssuesById,
  type BacklogEnvironmentAvailability,
  type BacklogProjectGroup,
  type EnvironmentBacklogBoard,
} from "./backlog.logic";

interface EnvironmentBoardResult {
  readonly environmentId: EnvironmentId;
  readonly board: BacklogBoardState | null;
  readonly error: string | null;
  /** The server predates Backlog: it does not know the backlog RPCs at all. */
  readonly unsupported: boolean;
}

function describeFailure(cause: Cause.Cause<unknown>): string {
  const error = Cause.squash(cause);
  return error instanceof Error && error.message.trim().length > 0
    ? error.message
    : "The backlog could not be loaded.";
}

/** Live boards for a set of environments, keyed by their JSON id list. */
const backlogBoardsAtom = Atom.family((environmentKey: string) =>
  Atom.make((get): ReadonlyArray<EnvironmentBoardResult> =>
    (JSON.parse(environmentKey) as EnvironmentId[]).map((environmentId) => {
      const result = get(backlogEnvironment.board({ environmentId, input: {} }));
      const unsupported = result._tag === "Failure" && isBacklogUnsupportedCause(result.cause);
      return {
        environmentId,
        board: Option.getOrNull(AsyncResult.value(result)),
        error: result._tag === "Failure" && !unsupported ? describeFailure(result.cause) : null,
        unsupported,
      };
    }),
  ).pipe(Atom.withLabel(`mobile:backlog:boards:${environmentKey}`)),
);

export interface BacklogEnvironmentNotice {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly message: string;
}

/**
 * Every environment's board, the picker scopes built over them, and honest
 * notices for environments that are offline or failed to load. An offline
 * environment shows the board this device last saved for it, read-only.
 * Environments whose server predates Backlog are left out, named only in
 * `unsupportedLabels`.
 */
export function useBacklogBoards() {
  const { environments } = useEnvironments();
  const projects = useProjects();
  const grouping = useMobileProjectGroupingSettings();
  const connectedEnvironmentIds = useMemo(
    () =>
      environments
        .filter((environment) => environment.connection.phase === "connected")
        .map((environment) => environment.environmentId),
    [environments],
  );
  // Sorted, so the subscription key does not change with connection order.
  const boardEnvironmentIds = useMemo(
    () =>
      environments
        .filter(
          (environment) =>
            environment.entry.enabled && environment.connection.phase !== "unsupported",
        )
        .map((environment) => environment.environmentId)
        .sort((left, right) => left.localeCompare(right)),
    [environments],
  );
  const results = useAtomValue(backlogBoardsAtom(JSON.stringify(boardEnvironmentIds)));
  const labelById = useMemo(
    () =>
      new Map(environments.map((environment) => [environment.environmentId, environment.label])),
    [environments],
  );
  const environmentLabel = useCallback(
    (environmentId: EnvironmentId) => labelById.get(environmentId) ?? null,
    [labelById],
  );
  const boards = useMemo<ReadonlyArray<EnvironmentBacklogBoard>>(
    () =>
      results.flatMap((result) =>
        result.board === null ? [] : [{ environmentId: result.environmentId, board: result.board }],
      ),
    [results],
  );
  const projectGroups = useMemo<ReadonlyArray<BacklogProjectGroup>>(
    () =>
      buildProjectGroups({ projects, settings: grouping }).map((group) => ({
        key: group.key,
        label: group.label,
        projectRefs: group.memberProjectRefs,
        repositoryKeys: [
          ...new Set(
            projects.flatMap((project) =>
              group.memberProjectRefs.some(
                (ref) =>
                  ref.environmentId === project.environmentId && ref.projectId === project.id,
              ) && project.repositoryIdentity?.canonicalKey
                ? [project.repositoryIdentity.canonicalKey]
                : [],
            ),
          ),
        ],
      })),
    [grouping, projects],
  );
  const scopes = useMemo(
    () => buildBacklogScopes({ boards, projectGroups, environmentLabel }),
    [boards, environmentLabel, projectGroups],
  );
  const issuesById = useMemo(() => mergeBacklogIssuesById(boards), [boards]);
  const unsupportedIds = useMemo(
    () => new Set(results.flatMap((result) => (result.unsupported ? [result.environmentId] : []))),
    [results],
  );
  const environmentAvailability = useMemo<ReadonlyArray<BacklogEnvironmentAvailability>>(() => {
    const resultById = new Map(results.map((result) => [result.environmentId, result]));
    return environments
      .filter(
        (environment) =>
          environment.entry.enabled &&
          environment.connection.phase !== "unsupported" &&
          !unsupportedIds.has(environment.environmentId),
      )
      .map((environment): BacklogEnvironmentAvailability => {
        const result = resultById.get(environment.environmentId);
        const phase = environment.connection.phase;
        const state =
          phase === "connected"
            ? result?.board && result.board.fromCache !== true
              ? "ready"
              : result?.error
                ? "failed"
                : "loading"
            : phase === "connecting" || phase === "reconnecting"
              ? "loading"
              : "offline";
        return { environmentId: environment.environmentId, label: environment.label, state };
      });
  }, [environments, results, unsupportedIds]);
  const unsupportedLabels = useMemo(
    () => [...unsupportedIds].map((environmentId) => labelById.get(environmentId) ?? "Environment"),
    [labelById, unsupportedIds],
  );
  const notices = useMemo<ReadonlyArray<BacklogEnvironmentNotice>>(() => {
    const failed = results.flatMap((result) =>
      result.board === null && result.error !== null
        ? [
            {
              environmentId: result.environmentId,
              label: labelById.get(result.environmentId) ?? "Environment",
              message: result.error,
            },
          ]
        : [],
    );
    const boardById = new Map(results.map((result) => [result.environmentId, result.board]));
    const offline = environments
      .filter(
        (environment) =>
          environment.entry.enabled &&
          environment.connection.phase !== "connected" &&
          environment.connection.phase !== "unsupported",
      )
      .map((environment) => {
        const board = boardById.get(environment.environmentId) ?? null;
        return {
          environmentId: environment.environmentId,
          label: environment.label,
          message:
            board === null
              ? "Unavailable until it reconnects."
              : (backlogReadOnlyReason({
                  connected: false,
                  board,
                  backlog: null,
                  label: environment.label,
                  formatTime: (iso) => `${relativeTime(iso)} ago`,
                }) ?? "Unavailable until it reconnects."),
        };
      });
    return [...failed, ...offline];
  }, [environments, labelById, results]);

  return {
    boards,
    scopes,
    issuesById,
    notices,
    unsupportedLabels,
    connectedEnvironmentIds,
    environmentAvailability,
    environmentLabel,
    /** True until every connected environment has sent its first snapshot. */
    isLoading: results.some(
      (result) =>
        result.board === null &&
        result.error === null &&
        connectedEnvironmentIds.includes(result.environmentId),
    ),
  };
}
