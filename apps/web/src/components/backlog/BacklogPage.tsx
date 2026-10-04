import {
  isAtomCommandInterrupted,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import type {
  BacklogIssueId,
  BacklogIssuePriority,
  BacklogIssueStatus,
  BacklogIssueType,
  EnvironmentId,
} from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import {
  ChevronDownIcon,
  EllipsisIcon,
  SquareKanbanIcon,
  ListFilterIcon,
  MessagesSquareIcon,
  PencilIcon,
  WorkflowIcon,
} from "lucide-react";
import { useCallback, useMemo, useState } from "react";

import { isElectron } from "../../env";
import { useClientSettings } from "../../hooks/useSettings";
import { formatDayAwareTimestamp } from "../../timestampFormat";
import { useEscapeToGoBack } from "../../hooks/useNavigateBack";
import { useHeldAgentMessageCount } from "../../state/agentMessages";
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
  MenuItem,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
  MenuTrigger,
} from "../ui/menu";
import { SidebarInset } from "../ui/sidebar";
import { Skeleton } from "../ui/skeleton";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { Toggle, ToggleGroup } from "../ui/toggle-group";
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
  backlogOfflineNotice,
  backlogScopeKey,
  backlogsSpanEnvironments,
  boardHomeTargets,
  boardIssueKey,
  buildBacklogColumns,
  hasActiveBacklogFilters,
  isBacklogRefWritable,
  normalizeBacklogKeyInput,
  prunePendingBacklogMoves,
  type BacklogFilters,
  type BacklogRef,
  type BacklogScope,
  type BacklogSource,
  type BacklogSwitcherEntry,
  type BoardIssue,
  type PendingBacklogMove,
} from "./backlog.logic";
import { BacklogBoard } from "./BacklogBoard";
import { BacklogGraph } from "./BacklogGraph";
import { BacklogIssuePanel, confirmAction } from "./BacklogIssuePanel";
import { BacklogMessagesPanel } from "./BacklogMessagesPanel";
import { BacklogInlineQuickAdd } from "./BacklogQuickAdd";
import { useBacklogSwitcher } from "./useBacklogData";

export interface BacklogPageSearch {
  readonly scope?: string;
  readonly issueEnvironmentId?: EnvironmentId;
  readonly issueId?: BacklogIssueId;
  /** Board when absent. */
  readonly view?: "graph";
  /** Shows the agent Messages feed beside the board while no issue is open. */
  readonly messages?: true;
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
  const { sources, unsupportedLabels, entries } = useBacklogSwitcher();
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
  // A move the stream has answered no longer holds its card; adjusted while rendering.
  const answeredMoves = prunePendingBacklogMoves(pendingMoves, sources);
  if (answeredMoves !== pendingMoves) setPendingMoves(answeredMoves);

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
  const closeMessages = useCallback(() => updateSearch({ messages: undefined }), [updateSearch]);
  const showMessages = search.messages === true && selected === null;
  useEscapeToGoBack(selected ? closeIssue : showMessages ? closeMessages : undefined);
  const heldMessages = useHeldAgentMessageCount();

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
  const sourceById = useMemo(
    () => new Map(sources.map((source) => [source.environmentId, source] as const)),
    [sources],
  );
  const timestampFormat = useClientSettings((settings) => settings.timestampFormat);
  const formatAsOf = (iso: string) => formatDayAwareTimestamp(iso, timestampFormat);
  const movedAway = entry.backlogs.flatMap((ref) =>
    ref.backlog.movedTo === undefined ? [] : [{ ref, movedTo: ref.backlog.movedTo }],
  );

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
                <>
                  <BacklogKeyEditor
                    backlogRef={singleBacklog}
                    writable={isBacklogRefWritable(singleBacklog, sourceById)}
                  />
                  <BacklogHomeMenu backlogRef={singleBacklog} sources={sources} />
                </>
              ) : null}
            </WorkspaceBreadcrumbItem>
          </WorkspaceBreadcrumb>
        </WorkspacePageHeader>

        <div className="relative flex min-h-0 flex-1">
          <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-3 pt-3">
            <div className="flex flex-wrap items-center gap-2 px-5 sm:px-6">
              <BacklogInlineQuickAdd
                target={entry.createTarget}
                blockedReason={entry.createBlockedReason}
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
                <ToggleGroup
                  aria-label="Backlog view"
                  variant="segmented"
                  value={[search.view ?? "board"]}
                  onValueChange={(value) => {
                    const next = value[0];
                    if (next === "board" || next === "graph") {
                      updateSearch({ view: next === "graph" ? "graph" : undefined });
                    }
                  }}
                >
                  <Toggle aria-label="Board view" value="board">
                    <SquareKanbanIcon aria-hidden />
                    Board
                  </Toggle>
                  <Toggle aria-label="Dependency graph view" value="graph">
                    <WorkflowIcon aria-hidden />
                    Graph
                  </Toggle>
                </ToggleGroup>
                <Button
                  variant="outline"
                  size="sm"
                  aria-pressed={showMessages}
                  onClick={() =>
                    updateSearch(
                      showMessages
                        ? { messages: undefined }
                        : { messages: true, issueEnvironmentId: undefined, issueId: undefined },
                    )
                  }
                >
                  <MessagesSquareIcon aria-hidden />
                  Messages
                  {heldMessages > 0 ? (
                    <Badge size="sm" variant="warning">
                      {heldMessages} held
                    </Badge>
                  ) : null}
                </Button>
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
                      ? backlogOfflineNotice(source, formatAsOf)
                      : source.status === "error"
                        ? `Could not read the backlog on ${source.label}: ${source.error ?? "unknown error"}`
                        : `${source.label} is unavailable.`}
                  </p>
                ))}
              </div>
            ) : null}
            {entry.legacyInbox ? (
              <LegacyInboxNotice
                environmentId={entry.legacyInbox.environmentId}
                hubLabel={entry.legacyInbox.hubLabel}
                machineLabel={
                  sourceById.get(entry.legacyInbox.environmentId)?.label ?? "This machine"
                }
                openCount={entry.openCount}
                writable={singleBacklog !== null && isBacklogRefWritable(singleBacklog, sourceById)}
                onEmptied={() => updateSearch({ scope: "inbox" })}
              />
            ) : null}
            {movedAway.map(({ ref, movedTo }) => (
              <p
                key={`${ref.environmentId}:${ref.backlog.id}`}
                className="px-5 text-xs text-muted-foreground sm:px-6"
              >
                {ref.backlog.key} moved to {movedTo.label}. This copy on{" "}
                {sourceById.get(ref.environmentId)?.label ?? "its old machine"} is read-only;
                connect to {movedTo.label} to work on it.
              </p>
            ))}
            {unsupportedLabels.length > 0 ? (
              <p className="px-5 text-xs text-muted-foreground sm:px-6">
                {unsupportedLabels.join(", ")} {unsupportedLabels.length > 1 ? "don't" : "doesn't"}{" "}
                support Backlog yet.
              </p>
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
                    : (entry.createBlockedReason ??
                      "No machine that can hold this backlog is connected.")
                }
              />
            ) : totalShown === 0 && hasActiveBacklogFilters(filters) ? (
              <BacklogEmpty
                title="No matching issues"
                description="Clear the filters to see the whole board."
              />
            ) : search.view === "graph" ? (
              <BacklogGraph
                columns={columns}
                sources={scopeSources}
                selectedKey={selectedKey}
                onOpen={openIssue}
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
              entries={entries}
              onClose={closeIssue}
              onOpenIssue={openIssue}
            />
          ) : showMessages ? (
            <BacklogMessagesPanel onClose={closeMessages} />
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
  // Legacy Inboxes sit under the Inbox until they are empty.
  const legacy = entries.filter((entry) => entry.legacyInbox !== null);
  const projects = entries.filter(
    (entry) => entry.key !== "all" && entry.key !== "inbox" && entry.legacyInbox === null,
  );
  const withBacklog = projects.filter((entry) => entry.backlogs.length > 0);
  const withoutBacklog = projects.filter((entry) => entry.backlogs.length === 0);
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
          {legacy.map(item)}
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

/**
 * An Inbox a machine kept from before it was linked to a hub. Moving re-creates each open issue on
 * the hub's Inbox and closes it here with a note saying where it went.
 */
function LegacyInboxNotice({
  environmentId,
  hubLabel,
  machineLabel,
  openCount,
  writable,
  onEmptied,
}: {
  environmentId: EnvironmentId;
  hubLabel: string;
  machineLabel: string;
  openCount: number;
  writable: boolean;
  onEmptied: () => void;
}) {
  const [pending, setPending] = useState(false);
  const moveInbox = useAtomCommand(backlogEnvironment.moveInboxToHub, {
    label: "backlog move inbox to hub",
    reportFailure: false,
  });
  const move = async () => {
    const issues = openCount === 1 ? "its open issue" : `its ${openCount} open issues`;
    if (
      !(await confirmAction(
        `Move ${issues} to the ${hubLabel} Inbox? Each is closed here as won't fix with a note saying where it went.`,
      ))
    ) {
      return;
    }
    setPending(true);
    const result = await moveInbox({ environmentId, input: {} });
    setPending(false);
    if (result._tag === "Success") {
      const { moved, skipped } = result.value;
      toastManager.add({
        type: skipped.length > 0 ? "warning" : "success",
        title: `Moved ${moved.length} ${moved.length === 1 ? "issue" : "issues"} to the ${hubLabel} Inbox`,
        ...(skipped.length > 0
          ? {
              description: `${skipped.join(", ")} stayed: an agent holds ${skipped.length === 1 ? "it" : "them"}. Move again once released.`,
            }
          : {}),
      });
      if (skipped.length === 0) onEmptied();
      return;
    }
    if (!isAtomCommandInterrupted(result)) {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: `Could not move to the ${hubLabel} Inbox`,
          description: backlogFailureMessage(result),
        }),
      );
    }
  };
  return (
    <div className="flex flex-wrap items-center gap-2 px-5 sm:px-6">
      <p className="text-xs text-muted-foreground">
        {machineLabel} is linked to {hubLabel}, whose Inbox is the one for every machine. This is
        its old Inbox.
      </p>
      <Button
        size="xs"
        variant="outline"
        disabled={!writable || pending}
        onClick={() => void move()}
      >
        Move to {hubLabel} Inbox
      </Button>
    </div>
  );
}

/**
 * Moving a board's home to another connected machine, or bringing back a board whose move did
 * not land. Every issue keeps its key and history.
 */
function BacklogHomeMenu({
  backlogRef,
  sources,
}: {
  backlogRef: BacklogRef;
  sources: ReadonlyArray<BacklogSource>;
}) {
  const [pending, setPending] = useState(false);
  const moveBacklog = useAtomCommand(backlogEnvironment.moveBacklog, {
    label: "backlog move board",
    reportFailure: false,
  });
  const restoreBacklog = useAtomCommand(backlogEnvironment.restoreBacklog, {
    label: "backlog restore board",
    reportFailure: false,
  });
  const targets = boardHomeTargets(backlogRef, sources);
  const { backlog, environmentId } = backlogRef;
  const home = sources.find((source) => source.environmentId === environmentId);
  const restorable = backlog.movedTo !== undefined && home !== undefined && home.status === "live";
  if (targets.length === 0 && !restorable) return null;

  const run = async <A, E>(
    confirmation: string,
    action: () => Promise<AtomCommandResult<A, E>>,
    done: string,
    failed: string,
  ) => {
    if (!(await confirmAction(confirmation))) return;
    setPending(true);
    const result = await action();
    setPending(false);
    if (result._tag === "Success") {
      toastManager.add({ type: "success", title: done });
      return;
    }
    if (!isAtomCommandInterrupted(result)) {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: failed,
          description: backlogFailureMessage(result),
        }),
      );
    }
  };

  return (
    <Menu>
      <MenuTrigger
        aria-label={`${backlog.key} board actions`}
        disabled={pending}
        render={<Button variant="ghost-muted" size="icon-xs" />}
      >
        <EllipsisIcon aria-hidden />
      </MenuTrigger>
      <MenuPopup align="start">
        {targets.map((target) => (
          <MenuItem
            key={target.environmentId}
            onClick={() => {
              void run(
                `Move ${backlog.key} to ${target.label}? Its issues, numbers and history move with it, and this machine keeps a read-only copy that points there.`,
                () =>
                  moveBacklog({
                    from: environmentId,
                    backlogId: backlog.id,
                    to: { environmentId: target.environmentId, label: target.label },
                  }),
                `Moved ${backlog.key} to ${target.label}`,
                `Could not move ${backlog.key}`,
              );
            }}
          >
            Move board to {target.label}
          </MenuItem>
        ))}
        {restorable ? (
          <MenuItem
            onClick={() => {
              void run(
                `Make ${backlog.key} live on ${home.label} again? Only do this if the board never arrived on ${backlog.movedTo?.label}; otherwise move it back from there.`,
                () => restoreBacklog({ environmentId, input: { backlogId: backlog.id } }),
                `${backlog.key} lives on ${home.label} again`,
                `Could not restore ${backlog.key}`,
              );
            }}
          >
            Restore board on {home.label}
          </MenuItem>
        ) : null}
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
