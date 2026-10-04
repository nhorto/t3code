import type { EnvironmentId } from "@t3tools/contracts";
import { useMemo } from "react";

import { useClientSettings } from "../../hooks/useSettings";
import { selectProjectGroupingSettings } from "../../logicalProject";
import { useBacklogBoards } from "../../state/backlog";
import { useProjects } from "../../state/entities";
import { useEnvironments, usePrimaryEnvironmentId } from "../../state/environments";
import {
  buildBacklogSwitcher,
  resolveBacklogSourceStatus,
  type BacklogSource,
  type BacklogSwitcherEntry,
} from "./backlog.logic";

/** One board subscription per enabled environment, with its honest status. */
export function useBacklogSources(): ReadonlyArray<BacklogSource> {
  const { environments } = useEnvironments();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  // Sorted, so the subscription key does not change with connection order.
  const environmentIds = useMemo(
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
  const boards = useBacklogBoards(environmentIds);
  return useMemo(() => {
    const environmentById = new Map(
      environments.map((environment) => [environment.environmentId, environment] as const),
    );
    return boards.map((board): BacklogSource => {
      const environment = environmentById.get(board.environmentId);
      return {
        environmentId: board.environmentId,
        label: environment?.label ?? "Unknown machine",
        isPrimary: board.environmentId === primaryEnvironmentId,
        status: resolveBacklogSourceStatus({
          connectionPhase: environment?.connection.phase ?? null,
          hasBoard: board.board !== null,
          failed: board.error !== null,
        }),
        board: board.board,
        error: board.error,
      };
    });
  }, [boards, environments, primaryEnvironmentId]);
}

export function useBacklogSwitcher(): {
  readonly sources: ReadonlyArray<BacklogSource>;
  readonly entries: ReadonlyArray<BacklogSwitcherEntry>;
  readonly primaryEnvironmentId: EnvironmentId | null;
} {
  const sources = useBacklogSources();
  const projects = useProjects();
  const groupingSettings = useClientSettings(selectProjectGroupingSettings);
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const entries = useMemo(
    () => buildBacklogSwitcher({ sources, projects, groupingSettings, primaryEnvironmentId }),
    [groupingSettings, primaryEnvironmentId, projects, sources],
  );
  return { sources, entries, primaryEnvironmentId };
}
