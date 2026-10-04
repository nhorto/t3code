import { useAtomValue } from "@effect/atom-react";
import type { BacklogBoardState } from "@t3tools/client-runtime/state/backlog";
import { buildProjectGroups } from "@t3tools/client-runtime/state/project-grouping";
import type { EnvironmentId } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/unstable/reactivity";
import { useCallback, useMemo } from "react";

import { backlogEnvironment } from "../../state/backlog";
import { useProjects } from "../../state/entities";
import { useEnvironments } from "../../state/environments";
import { useMobileProjectGroupingSettings } from "../../state/project-grouping";
import {
  buildBacklogScopes,
  mergeBacklogIssuesById,
  type BacklogProjectGroup,
  type EnvironmentBacklogBoard,
} from "./backlog.logic";

interface EnvironmentBoardResult {
  readonly environmentId: EnvironmentId;
  readonly board: BacklogBoardState | null;
  readonly error: string | null;
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
      return {
        environmentId,
        board: Option.getOrNull(AsyncResult.value(result)),
        error: result._tag === "Failure" ? describeFailure(result.cause) : null,
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
 * Every connected environment's board, the picker scopes built over them,
 * and honest notices for environments that are offline or failed to load.
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
  const results = useAtomValue(backlogBoardsAtom(JSON.stringify(connectedEnvironmentIds)));
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
    () => buildBacklogScopes({ boards, projectGroups }),
    [boards, projectGroups],
  );
  const issuesById = useMemo(() => mergeBacklogIssuesById(boards), [boards]);
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
    const offline = environments
      .filter(
        (environment) => environment.entry.enabled && environment.connection.phase !== "connected",
      )
      .map((environment) => ({
        environmentId: environment.environmentId,
        label: environment.label,
        message: "Unavailable until it reconnects.",
      }));
    return [...failed, ...offline];
  }, [environments, labelById, results]);

  return {
    boards,
    scopes,
    issuesById,
    notices,
    connectedEnvironmentIds,
    environmentLabel,
    /** True until every connected environment has sent its first snapshot. */
    isLoading: results.some((result) => result.board === null && result.error === null),
  };
}
