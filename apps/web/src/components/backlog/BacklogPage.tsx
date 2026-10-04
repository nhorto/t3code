import { isAtomCommandInterrupted } from "@t3tools/client-runtime/state/runtime";
import type {
  BacklogIssueId,
  BacklogIssuePriority,
  BacklogIssueStatus,
  BacklogIssueType,
  EnvironmentId,
} from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { ChevronDownIcon, SquareKanbanIcon, ListFilterIcon, PencilIcon } from "lucide-react";
import { useCallback, useMemo, useState } from "react";

import { isElectron } from "../../env";
import { useEscapeToGoBack } from "../../hooks/useNavigateBack";
import { backlogEnvironment, backlogFailureMessage } from "../../state/backlog";
import { useAtomCommand } from "../../state/use-atom-command";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "../ui/empty";
import { Input } from "../ui/input";
import {
  Menu,
  MenuCheckboxItem,
  MenuGroup,
  MenuGroupLabel,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
  MenuTrigger,
} from "../ui/menu";
import { SidebarInset } from "../ui/sidebar";
import { Skeleton } from "../ui/skeleton";
import { stackedThreadToast, toastManager } from "../ui/toast";
import {
  WorkspaceBreadcrumb,
  WorkspaceBreadcrumbItem,
  WorkspaceBreadcrumbSeparator,
} from "../WorkspaceBreadcrumb";
import { WorkspacePageHeader } from "../WorkspacePageHeader";
import {
  BACKLOG_PRIORITIES,
  BACKLOG_PRIORITY_LABELS,
  BACKLOG_TYPE_LABELS,
  BACKLOG_TYPES,
  EMPTY_BACKLOG_FILTERS,
  backlogScopeKey,
  backlogsSpanEnvironments,
  boardIssueKey,
  buildBacklogColumns,
  hasActiveBacklogFilters,
  isBacklogSourceWritable,
  normalizeBacklogKeyInput,
  type BacklogFilters,
  type BacklogRef,
  type BacklogScope,
  type BacklogSource,
  type BacklogSwitcherEntry,
  type BoardIssue,
  type PendingBacklogMove,
} from "./backlog.logic";
import { BacklogBoard } from "./BacklogBoard";
import { BacklogIssuePanel } from "./BacklogIssuePanel";
import { BacklogInlineQuickAdd } from "./BacklogQuickAdd";
import { useBacklogSwitcher } from "./useBacklogData";

export interface BacklogPageSearch {
  readonly scope?: string;
  readonly issueEnvironmentId?: EnvironmentId;
  readonly issueId?: BacklogIssueId;
}

function entryLabel(entry: BacklogSwitcherEntry): string {
  return entry.machineLabel ? `${entry.label} (${entry.machineLabel})` : entry.label;
}

/** The sources a scope reads: every machine for All and the Inbox, else those it touches. */
function sourcesForEntry(
  entry: BacklogSwitcherEntry,
  sources: ReadonlyArray<BacklogSource>,
): ReadonlyArray<BacklogSource> {
  if (entry.scope.kind === "all" || entry.scope.kind === "inbox") return sources;
  const environmentIds = new Set<EnvironmentId>([
    ...entry.backlogs.map((ref) => ref.environmentId),
    ...entry.projectRefs.map((ref) => ref.environmentId),
  ]);
  return sources.filter((source) => environmentIds.has(source.environmentId));
}

export function BacklogPage({
  search,
  scope,
}: {
  readonly search: BacklogPageSearch;
  readonly scope: BacklogScope;
}) {
  const navigate = useNavigate();
  const { sources, entries } = useBacklogSwitcher();
  const scopeKey = backlogScopeKey(scope);
  const entry =
    entries.find((candidate) => candidate.key === scopeKey) ??
    entries.find((candidate) => candidate.key === "all")!;
  const scopeMissing = entry.key !== scopeKey;

  const [filters, setFilters] = useState<BacklogFilters>(EMPTY_BACKLOG_FILTERS);
  const [showWontfix, setShowWontfix] = useState(false);
  const [pendingMoves, setPendingMoves] = useState<ReadonlyMap<string, PendingBacklogMove>>(
    () => new Map(),
  );

  const selected =
    search.issueEnvironmentId && search.issueId
      ? { environmentId: search.issueEnvironmentId, issueId: search.issueId }
      : null;
  const selectedKey = selected ? boardIssueKey(selected.environmentId, selected.issueId) : null;

  const updateSearch = useCallback(
    (patch: { [Key in keyof BacklogPageSearch]?: BacklogPageSearch[Key] | undefined }) => {
      void navigate({
        to: "/backlog",
        search: (previous: BacklogPageSearch) => {
          const next = { ...previous, ...patch };
          return Object.fromEntries(
            Object.entries(next).filter(([, value]) => value !== undefined),
          ) as BacklogPageSearch;
        },
        replace: true,
      });
    },
    [navigate],
  );
  const openIssue = useCallback(
    (environmentId: EnvironmentId, issueId: BacklogIssueId) =>
      updateSearch({ issueEnvironmentId: environmentId, issueId }),
    [updateSearch],
  );
  const closeIssue = useCallback(
    () => updateSearch({ issueEnvironmentId: undefined, issueId: undefined }),
    [updateSearch],
  );
  useEscapeToGoBack(selected ? closeIssue : undefined);

  const scopeSources = useMemo(() => sourcesForEntry(entry, sources), [entry, sources]);
  const columns = useMemo(
    () =>
      buildBacklogColumns({
        sources: scopeSources,
        backlogs: entry.backlogs,
        filters,
        showWontfix,
        pendingMoves,
      }),
    [entry.backlogs, filters, pendingMoves, scopeSources, showWontfix],
  );
  const showMachine = backlogsSpanEnvironments(entry.backlogs);

  const updateIssue = useAtomCommand(backlogEnvironment.updateIssue, {
    label: "backlog move issue",
    reportFailure: false,
  });
  const moveIssue = useCallback(
    (item: BoardIssue, status: BacklogIssueStatus) => {
      const key = boardIssueKey(item.environmentId, item.issue.id);
      setPendingMoves((current) =>
        new Map(current).set(key, { status, fromUpdatedAt: item.issue.updatedAt }),
      );
      void updateIssue({
        environmentId: item.environmentId,
        input: { issueId: item.issue.id, status },
      }).then((result) => {
        // On success the stream's newer row supersedes the pending move by itself.
        if (result._tag === "Success") return;
        setPendingMoves((current) => {
          const next = new Map(current);
          next.delete(key);
          return next;
        });
        if (!isAtomCommandInterrupted(result)) {
          toastManager.add(
            stackedThreadToast({
              type: "error",
              title: `Could not move ${item.issue.key}`,
              description: backlogFailureMessage(result),
            }),
          );
        }
      });
    },
    [updateIssue],
  );

  const loading =
    entry.backlogs.length === 0 && scopeSources.some((source) => source.status === "loading");
  const noSources = sources.length === 0;
  const unhealthy = scopeSources.filter(
    (source) => source.status !== "live" && source.status !== "loading",
  );
  const totalShown = columns.reduce((sum, column) => sum + column.issues.length, 0);
  const selectedSource = selected
    ? (sources.find((source) => source.environmentId === selected.environmentId) ?? null)
    : null;
  const singleBacklog = entry.backlogs.length === 1 ? entry.backlogs[0]! : null;

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-background">
        <WorkspacePageHeader electron={isElectron}>
          <WorkspaceBreadcrumb ariaLabel="Backlog breadcrumb">
            <WorkspaceBreadcrumbItem>
              <h1>Backlog</h1>
            </WorkspaceBreadcrumbItem>
            <WorkspaceBreadcrumbSeparator />
            <WorkspaceBreadcrumbItem current className="min-w-0 gap-2">
              <BacklogSwitcher
                entries={entries}
                current={entry}
                onSelect={(next) =>
                  updateSearch({
                    scope: next.key === "all" ? undefined : next.key,
                    issueEnvironmentId: undefined,
                    issueId: undefined,
                  })
                }
              />
              {singleBacklog ? (
                <BacklogKeyEditor
                  backlogRef={singleBacklog}
                  writable={scopeSources.some(
                    (source) =>
                      source.environmentId === singleBacklog.environmentId &&
                      isBacklogSourceWritable(source),
                  )}
                />
              ) : null}
            </WorkspaceBreadcrumbItem>
          </WorkspaceBreadcrumb>
        </WorkspacePageHeader>

        <div className="relative flex min-h-0 flex-1">
          <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-3 pt-3">
            <div className="flex flex-wrap items-center gap-2 px-5 sm:px-6">
              <BacklogInlineQuickAdd
                target={entry.createTarget}
                targetLabel={entry.scope.kind === "all" ? "Inbox" : entry.label}
              />
              <div className="flex items-center gap-2">
                <Input
                  size="sm"
                  type="search"
                  aria-label="Search by title or key"
                  placeholder="Search title or key"
                  className="w-48"
                  value={filters.query}
                  onChange={(event) =>
                    setFilters((current) => ({ ...current, query: event.target.value }))
                  }
                />
                <BacklogFilterMenu
                  filters={filters}
                  onChange={setFilters}
                  showWontfix={showWontfix}
                  onShowWontfix={setShowWontfix}
                />
              </div>
            </div>

            {scopeMissing ? (
              <p className="px-5 text-xs text-muted-foreground sm:px-6">
                That backlog is not on any connected machine. Showing all backlogs.
              </p>
            ) : null}
            {unhealthy.length > 0 ? (
              <div className="flex flex-col gap-1 px-5 sm:px-6">
                {unhealthy.map((source) => (
                  <p key={source.environmentId} className="text-xs text-muted-foreground">
                    {source.status === "stale"
                      ? `${source.label} is unreachable. Its issues show their last known state, read-only.`
                      : source.status === "error"
                        ? `Could not read the backlog on ${source.label}: ${source.error ?? "unknown error"}`
                        : `${source.label} is unavailable.`}
                  </p>
                ))}
              </div>
            ) : null}

            {noSources ? (
              <BacklogEmpty
                title="No environment connected"
                description="Connect to a T3 Code server to see its backlogs."
              />
            ) : loading ? (
              <div className="flex min-h-0 flex-1 gap-3 overflow-hidden px-5 sm:px-6">
                {columns.map((column) => (
                  <Skeleton key={column.status} className="h-48 w-72 shrink-0" />
                ))}
              </div>
            ) : totalShown === 0 && entry.backlogs.length === 0 ? (
              <BacklogEmpty
                title="Nothing here yet"
                description={
                  entry.createTarget
                    ? "Add the first idea or bug above."
                    : "No machine that can hold this backlog is connected."
                }
              />
            ) : totalShown === 0 && hasActiveBacklogFilters(filters) ? (
              <BacklogEmpty
                title="No matching issues"
                description="Clear the filters to see the whole board."
              />
            ) : (
              <BacklogBoard
                columns={columns}
                sources={scopeSources}
                showMachine={showMachine}
                selectedKey={selectedKey}
                onOpen={openIssue}
                onMove={moveIssue}
              />
            )}
          </div>
          {selected ? (
            <BacklogIssuePanel
              key={selectedKey}
              environmentId={selected.environmentId}
              issueId={selected.issueId}
              source={selectedSource}
              onClose={closeIssue}
              onOpenIssue={openIssue}
            />
          ) : null}
        </div>
      </div>
    </SidebarInset>
  );
}

function BacklogEmpty({ title, description }: { title: string; description: string }) {
  return (
    <Empty>
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <SquareKanbanIcon />
        </EmptyMedia>
        <EmptyTitle>{title}</EmptyTitle>
        <EmptyDescription>{description}</EmptyDescription>
      </EmptyHeader>
    </Empty>
  );
}

function BacklogSwitcher({
  entries,
  current,
  onSelect,
}: {
  entries: ReadonlyArray<BacklogSwitcherEntry>;
  current: BacklogSwitcherEntry;
  onSelect: (entry: BacklogSwitcherEntry) => void;
}) {
  const fixed = entries.filter((entry) => entry.key === "all" || entry.key === "inbox");
  const withBacklog = entries.filter(
    (entry) => entry.key !== "all" && entry.key !== "inbox" && entry.backlogs.length > 0,
  );
  const withoutBacklog = entries.filter(
    (entry) => entry.key !== "all" && entry.key !== "inbox" && entry.backlogs.length === 0,
  );
  const item = (entry: BacklogSwitcherEntry) => (
    <MenuRadioItem key={entry.key} value={entry.key}>
      <span className="flex min-w-0 items-center gap-2">
        <span className="min-w-0 flex-1 truncate">{entryLabel(entry)}</span>
        {entry.openCount > 0 ? (
          <span className="text-xs text-muted-foreground tabular-nums">{entry.openCount}</span>
        ) : null}
      </span>
    </MenuRadioItem>
  );
  return (
    <Menu>
      <MenuTrigger
        aria-label={`Backlog: ${entryLabel(current)}`}
        render={<Button variant="ghost-muted" size="sm" />}
        className="min-w-0"
      >
        <span className="truncate">{entryLabel(current)}</span>
        <ChevronDownIcon aria-hidden />
      </MenuTrigger>
      <MenuPopup align="start" className="max-w-sm">
        <MenuRadioGroup
          value={current.key}
          onValueChange={(key) => {
            const next = entries.find((entry) => entry.key === key);
            if (next) onSelect(next);
          }}
        >
          {fixed.map(item)}
          {withBacklog.length > 0 ? (
            <>
              <MenuSeparator />
              <MenuGroup>
                <MenuGroupLabel>Projects</MenuGroupLabel>
                {withBacklog.map(item)}
              </MenuGroup>
            </>
          ) : null}
          {withoutBacklog.length > 0 ? (
            <>
              <MenuSeparator />
              <MenuGroup>
                <MenuGroupLabel>No issues yet</MenuGroupLabel>
                {withoutBacklog.map(item)}
              </MenuGroup>
            </>
          ) : null}
        </MenuRadioGroup>
      </MenuPopup>
    </Menu>
  );
}

function toggled<T>(values: ReadonlyArray<T>, value: T, on: boolean): ReadonlyArray<T> {
  return on
    ? [...values.filter((candidate) => candidate !== value), value]
    : values.filter((candidate) => candidate !== value);
}

function BacklogFilterMenu({
  filters,
  onChange,
  showWontfix,
  onShowWontfix,
}: {
  filters: BacklogFilters;
  onChange: (update: (current: BacklogFilters) => BacklogFilters) => void;
  showWontfix: boolean;
  onShowWontfix: (show: boolean) => void;
}) {
  const active = filters.types.length + filters.priorities.length + (filters.frontierOnly ? 1 : 0);
  return (
    <Menu>
      <MenuTrigger render={<Button variant="outline" size="sm" />} aria-label="Filters">
        <ListFilterIcon aria-hidden />
        Filters
        {active > 0 ? (
          <Badge size="sm" variant="secondary">
            {active}
          </Badge>
        ) : null}
      </MenuTrigger>
      <MenuPopup align="end">
        <MenuGroup>
          <MenuGroupLabel>Type</MenuGroupLabel>
          {BACKLOG_TYPES.map((type: BacklogIssueType) => (
            <MenuCheckboxItem
              key={type}
              checked={filters.types.includes(type)}
              onCheckedChange={(checked) =>
                onChange((current) => ({
                  ...current,
                  types: toggled(current.types, type, checked),
                }))
              }
            >
              {BACKLOG_TYPE_LABELS[type]}
            </MenuCheckboxItem>
          ))}
        </MenuGroup>
        <MenuSeparator />
        <MenuGroup>
          <MenuGroupLabel>Priority</MenuGroupLabel>
          {[...BACKLOG_PRIORITIES, "none" as const].map(
            (priority: BacklogIssuePriority | "none") => (
              <MenuCheckboxItem
                key={priority}
                checked={filters.priorities.includes(priority)}
                onCheckedChange={(checked) =>
                  onChange((current) => ({
                    ...current,
                    priorities: toggled(current.priorities, priority, checked),
                  }))
                }
              >
                {priority === "none" ? "No priority" : BACKLOG_PRIORITY_LABELS[priority]}
              </MenuCheckboxItem>
            ),
          )}
        </MenuGroup>
        <MenuSeparator />
        <MenuCheckboxItem
          variant="switch"
          checked={filters.frontierOnly}
          onCheckedChange={(checked) =>
            onChange((current) => ({ ...current, frontierOnly: checked }))
          }
        >
          Frontier only
        </MenuCheckboxItem>
        <MenuCheckboxItem variant="switch" checked={showWontfix} onCheckedChange={onShowWontfix}>
          Show won't fix
        </MenuCheckboxItem>
      </MenuPopup>
    </Menu>
  );
}

/** The backlog's short key, renamable in place. Issue numbers never change. */
function BacklogKeyEditor({ backlogRef, writable }: { backlogRef: BacklogRef; writable: boolean }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [pending, setPending] = useState(false);
  const updateBacklog = useAtomCommand(backlogEnvironment.updateBacklog, {
    label: "backlog update key",
    reportFailure: false,
  });
  const normalized = normalizeBacklogKeyInput(draft);
  const save = async () => {
    if (normalized === null || pending) return;
    if (normalized === backlogRef.backlog.key) {
      setEditing(false);
      return;
    }
    setPending(true);
    const result = await updateBacklog({
      environmentId: backlogRef.environmentId,
      input: { backlogId: backlogRef.backlog.id, key: normalized },
    });
    setPending(false);
    if (result._tag === "Success") {
      setEditing(false);
      return;
    }
    if (!isAtomCommandInterrupted(result)) {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Could not rename the key",
          description: backlogFailureMessage(result),
        }),
      );
    }
  };

  if (!editing) {
    return (
      <Button
        size="xs"
        variant="ghost-muted"
        disabled={!writable}
        aria-label={
          writable
            ? `Rename key ${backlogRef.backlog.key}`
            : `Key ${backlogRef.backlog.key}, read-only while its machine is unreachable`
        }
        onClick={() => {
          setDraft(backlogRef.backlog.key);
          setEditing(true);
        }}
      >
        <span className="font-mono">{backlogRef.backlog.key}</span>
        {writable ? <PencilIcon aria-hidden /> : null}
      </Button>
    );
  }
  return (
    <div className="flex items-center gap-1.5">
      <Input
        size="compact"
        font="mono"
        autoFocus
        aria-label="Backlog key"
        aria-invalid={normalized === null}
        className="w-28"
        value={draft}
        onChange={(event) => setDraft(event.target.value.toUpperCase())}
        onBlur={() => {
          if (!pending) setEditing(false);
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            void save();
          }
          if (event.key === "Escape") {
            event.preventDefault();
            event.stopPropagation();
            setEditing(false);
          }
        }}
      />
      {normalized === null ? (
        <span className="text-xs text-destructive">A-Z and 0-9, letter first, up to 10</span>
      ) : null}
    </div>
  );
}
