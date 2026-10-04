import type { EnvironmentId } from "@t3tools/contracts";
import { useMemo, useState } from "react";

import { useClientSettings } from "../../hooks/useSettings";
import { selectProjectGroupingSettings } from "../../logicalProject";
import { useBacklogBoards } from "../../state/backlog";
import { useProjects } from "../../state/entities";
import { useEnvironments, usePrimaryEnvironmentId } from "../../state/environments";
import {
  buildBacklogSwitcherEntries,
  resolveBacklogSourceStatus,
  sameBacklogSwitcherSources,
  withBacklogOpenCounts,
  type BacklogSource,
  type BacklogSwitcherEntry,
} from "./backlog.logic";

export interface BacklogSources {
  readonly sources: ReadonlyArray<BacklogSource>;
  /** Machines whose server predates Backlog. They are left out of `sources` entirely. */
  readonly unsupportedLabels: ReadonlyArray<string>;
}

/** One board subscription per enabled environment, with its honest status. */
export function useBacklogSources(): BacklogSources {
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
    const sources: BacklogSource[] = [];
    const unsupportedLabels: string[] = [];
    for (const board of boards) {
      const environment = environmentById.get(board.environmentId);
      const label = environment?.label ?? "Unknown machine";
      if (board.unsupported) {
        unsupportedLabels.push(label);
        continue;
      }
      sources.push({
        environmentId: board.environmentId,
        label,
        isPrimary: board.environmentId === primaryEnvironmentId,
        status: resolveBacklogSourceStatus({
          connectionPhase: environment?.connection.phase ?? null,
          hasBoard: board.board !== null,
          failed: board.error !== null,
        }),
        board: board.board,
        error: board.error,
      });
    }
    return { sources, unsupportedLabels };
  }, [boards, environments, primaryEnvironmentId]);
}

/** The previous list while it builds the same switcher, so issue deltas skip the grouping. */
function useStableSwitcherSources(
  sources: ReadonlyArray<BacklogSource>,
): ReadonlyArray<BacklogSource> {
  const [stable, setStable] = useState(sources);
  if (stable === sources || sameBacklogSwitcherSources(stable, sources)) return stable;
  // React's "adjust state while rendering": re-renders at once, before anything commits.
  setStable(sources);
  return sources;
}

export function useBacklogSwitcher(): {
  readonly sources: ReadonlyArray<BacklogSource>;
  readonly unsupportedLabels: ReadonlyArray<string>;
  readonly entries: ReadonlyArray<BacklogSwitcherEntry>;
  readonly primaryEnvironmentId: EnvironmentId | null;
} {
  const { sources, unsupportedLabels } = useBacklogSources();
  const switcherSources = useStableSwitcherSources(sources);
  const projects = useProjects();
  const groupingSettings = useClientSettings(selectProjectGroupingSettings);
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const baseEntries = useMemo(
    () =>
      buildBacklogSwitcherEntries({
        sources: switcherSources,
        projects,
        groupingSettings,
        primaryEnvironmentId,
      }),
    [groupingSettings, primaryEnvironmentId, projects, switcherSources],
  );
  const entries = useMemo(
    () => withBacklogOpenCounts(baseEntries, sources),
    [baseEntries, sources],
  );
  return { sources, unsupportedLabels, entries, primaryEnvironmentId };
}
