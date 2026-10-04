import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
  pointerWithin,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import type { BacklogIssueId, BacklogIssueStatus, EnvironmentId } from "@t3tools/contracts";
import { useMemo, useState, type ReactNode } from "react";

import { cn } from "../../lib/utils";
import {
  BACKLOG_STATUS_LABELS,
  backlogChildProgress,
  boardIssueKey,
  isBacklogSourceWritable,
  openBlockerKeys,
  type BacklogChildProgress,
  type BacklogColumn,
  type BacklogSource,
  type BoardIssue,
} from "./backlog.logic";
import {
  BacklogCard,
  BacklogCardOverlay,
  type BacklogCardProps,
  type BacklogDragData,
} from "./BacklogCard";

type CardDerivedProps = Omit<BacklogCardProps, "selected" | "readOnly" | "onOpen">;

interface SourceIndex {
  readonly source: BacklogSource;
  readonly childProgress: ReadonlyMap<BacklogIssueId, BacklogChildProgress>;
}

export interface BacklogBoardProps {
  readonly columns: ReadonlyArray<BacklogColumn>;
  readonly sources: ReadonlyArray<BacklogSource>;
  /** Name each card's machine: the visible issues come from more than one. */
  readonly showMachine: boolean;
  readonly selectedKey: string | null;
  readonly onOpen: (environmentId: EnvironmentId, issueId: BacklogIssueId) => void;
  readonly onMove: (item: BoardIssue, status: BacklogIssueStatus) => void;
}

/** The kanban: one droppable column per status, cards dragged between them. */
export function BacklogBoard({
  columns,
  sources,
  showMachine,
  selectedKey,
  onOpen,
  onMove,
}: BacklogBoardProps) {
  const sensors = useSensors(
    // A short travel before a drag keeps plain clicks opening the issue.
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor),
  );
  const [active, setActive] = useState<BacklogDragData | null>(null);
  const index = useMemo(
    () =>
      new Map(
        sources.map((source) => [
          source.environmentId,
          {
            source,
            childProgress: backlogChildProgress(source.board?.issues ?? []),
          } satisfies SourceIndex,
        ]),
      ),
    [sources],
  );
  const environmentLabels = useMemo(
    () => new Map(sources.map((source) => [source.environmentId, source.label] as const)),
    [sources],
  );

  const cardProps = (item: BoardIssue): CardDerivedProps => {
    const entry = index.get(item.environmentId);
    const progress = entry?.childProgress.get(item.issue.id);
    const claim = item.issue.claim;
    const claimMachine =
      claim?.actor.environmentId != null
        ? (environmentLabels.get(claim.actor.environmentId) ?? null)
        : null;
    return {
      issue: item.issue,
      environmentId: item.environmentId,
      machineLabel: showMachine ? (entry?.source.label ?? null) : null,
      blockerKeys: entry?.source.board
        ? openBlockerKeys(item.issue, entry.source.board.issuesById).join(", ")
        : "",
      childClosed: progress?.closed ?? 0,
      childTotal: progress?.total ?? 0,
      claimLabel: claim
        ? [claim.actor.label, claimMachine].filter((part) => part).join(" · ")
        : null,
    };
  };

  const onDragStart = (event: DragStartEvent) => {
    setActive((event.active.data.current as BacklogDragData | undefined) ?? null);
  };
  const onDragEnd = (event: DragEndEvent) => {
    setActive(null);
    const data = event.active.data.current as BacklogDragData | undefined;
    const status = event.over?.id as BacklogIssueStatus | undefined;
    if (!data || !status || status === data.issue.status) return;
    onMove({ environmentId: data.environmentId, issue: data.issue }, status);
  };

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={pointerWithin}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onDragCancel={() => setActive(null)}
    >
      <div className="flex min-h-0 flex-1 gap-3 overflow-x-auto px-5 pb-4 sm:px-6">
        {columns.map((column) => (
          <BacklogColumnView
            key={column.status}
            column={column}
            renderCard={(item) => {
              const key = boardIssueKey(item.environmentId, item.issue.id);
              const source = index.get(item.environmentId)?.source;
              return (
                <BacklogCard
                  key={key}
                  {...cardProps(item)}
                  selected={key === selectedKey}
                  readOnly={!source || !isBacklogSourceWritable(source)}
                  onOpen={onOpen}
                />
              );
            }}
          />
        ))}
      </div>
      {/* Transform-only motion; no drop animation, the card simply lands. */}
      <DragOverlay dropAnimation={null}>
        {active ? (
          <BacklogCardOverlay
            {...cardProps({ environmentId: active.environmentId, issue: active.issue })}
          />
        ) : null}
      </DragOverlay>
    </DndContext>
  );
}

function BacklogColumnView({
  column,
  renderCard,
}: {
  column: BacklogColumn;
  renderCard: (item: BoardIssue) => ReactNode;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: column.status });
  return (
    <section
      ref={setNodeRef}
      aria-label={BACKLOG_STATUS_LABELS[column.status]}
      className={cn(
        "flex min-h-0 w-72 shrink-0 flex-col rounded-xl border bg-muted/40",
        isOver && "border-ring bg-accent/40",
      )}
    >
      <header className="flex items-center gap-2 px-3 pt-2.5 pb-2 text-xs font-medium text-muted-foreground">
        <span className="text-foreground">{BACKLOG_STATUS_LABELS[column.status]}</span>
        <span className="tabular-nums">{column.issues.length}</span>
      </header>
      <div className="flex min-h-16 flex-1 flex-col gap-2 overflow-y-auto px-2 pb-2">
        {column.issues.map(renderCard)}
      </div>
    </section>
  );
}
