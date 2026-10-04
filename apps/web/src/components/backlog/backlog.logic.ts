import {
  BacklogKey,
  compareBacklogIssuesForClaim,
  isBacklogIssueOnFrontier,
  isBacklogStatusClosed,
  type Backlog,
  type BacklogActivity,
  type BacklogId,
  type BacklogIssue,
  type BacklogIssueId,
  type BacklogIssuePriority,
  type BacklogIssueStatus,
  type BacklogIssueType,
  type EnvironmentId,
  type ProjectId,
} from "@t3tools/contracts";
import type { BacklogBoardState } from "@t3tools/client-runtime/state/backlog";
import type { EnvironmentConnectionPhase } from "@t3tools/client-runtime/connection";
import * as Schema from "effect/Schema";

import { buildProjectGroups, type ProjectGroupingSettings } from "../../logicalProject";
import type { Project } from "../../types";

// Environments

/**
 * What one environment's board can honestly claim. `stale` keeps the last snapshot on screen,
 * read-only, while its connection is down; `unavailable` has nothing to show at all.
 */
export type BacklogSourceStatus = "loading" | "live" | "stale" | "unavailable" | "error";

export function resolveBacklogSourceStatus(input: {
  readonly connectionPhase: EnvironmentConnectionPhase | null;
  readonly hasBoard: boolean;
  readonly failed: boolean;
}): BacklogSourceStatus {
  const connected = input.connectionPhase === "connected";
  if (input.hasBoard) return connected ? "live" : "stale";
  if (connected) return input.failed ? "error" : "loading";
  return input.connectionPhase === "connecting" || input.connectionPhase === "reconnecting"
    ? "loading"
    : "unavailable";
}

export interface BacklogSource {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly isPrimary: boolean;
  readonly status: BacklogSourceStatus;
  readonly board: BacklogBoardState | null;
  readonly error: string | null;
}

export function isBacklogSourceWritable(source: Pick<BacklogSource, "status">): boolean {
  return source.status === "live";
}

// Scope (the switcher)

export type BacklogScope =
  | { readonly kind: "all" }
  | { readonly kind: "inbox" }
  | { readonly kind: "project"; readonly projectKey: string }
  | {
      readonly kind: "backlog";
      readonly environmentId: EnvironmentId;
      readonly backlogId: BacklogId;
    };

export function backlogScopeKey(scope: BacklogScope): string {
  switch (scope.kind) {
    case "all":
    case "inbox":
      return scope.kind;
    case "project":
      return `project:${scope.projectKey}`;
    case "backlog":
      return `backlog:${scope.environmentId}:${scope.backlogId}`;
  }
}

/** Reads the `scope` search param. Anything unrecognised is the whole fleet. */
export function parseBacklogScope(raw: unknown): BacklogScope {
  if (typeof raw !== "string" || raw === "all") return { kind: "all" };
  if (raw === "inbox") return { kind: "inbox" };
  if (raw.startsWith("project:") && raw.length > "project:".length) {
    return { kind: "project", projectKey: raw.slice("project:".length) };
  }
  const backlog = /^backlog:([^:]+):(.+)$/.exec(raw);
  if (backlog) {
    return {
      kind: "backlog",
      environmentId: backlog[1] as EnvironmentId,
      backlogId: backlog[2] as BacklogId,
    };
  }
  return { kind: "all" };
}

export interface BacklogRef {
  readonly environmentId: EnvironmentId;
  readonly backlog: Backlog;
}

/** Where a new issue for an entry goes. The server creates a project's backlog on first use. */
export interface BacklogCreateTarget {
  readonly environmentId: EnvironmentId;
  readonly backlogId?: BacklogId;
  readonly projectId?: ProjectId;
}

export interface BacklogSwitcherEntry {
  readonly key: string;
  readonly scope: BacklogScope;
  readonly label: string;
  /** Machines behind the entry, shown only when its label alone would be ambiguous. */
  readonly machineLabel: string | null;
  readonly backlogs: ReadonlyArray<BacklogRef>;
  readonly openCount: number;
  /** Null while no environment that could take a new issue is reachable. */
  readonly createTarget: BacklogCreateTarget | null;
  /** The logical project's member checkouts, so a project page can link straight here. */
  readonly projectRefs: ReadonlyArray<{
    readonly environmentId: EnvironmentId;
    readonly projectId: ProjectId;
  }>;
}

function preferPrimary<T extends { readonly environmentId: EnvironmentId }>(
  candidates: ReadonlyArray<T>,
  writable: (environmentId: EnvironmentId) => boolean,
  primaryEnvironmentId: EnvironmentId | null,
): T | null {
  const usable = candidates.filter((candidate) => writable(candidate.environmentId));
  return (
    usable.find((candidate) => candidate.environmentId === primaryEnvironmentId) ??
    usable[0] ??
    null
  );
}

function countOpen(sources: ReadonlyArray<BacklogSource>, backlogs: ReadonlyArray<BacklogRef>) {
  let count = 0;
  for (const ref of backlogs) {
    const board = sources.find((source) => source.environmentId === ref.environmentId)?.board;
    if (!board) continue;
    for (const issue of board.issues) {
      if (issue.backlogId === ref.backlog.id && !isBacklogStatusClosed(issue.status)) count += 1;
    }
  }
  return count;
}

/**
 * The switcher across every connected environment: All, one merged Inbox, then one entry per
 * logical project (the same repository on several machines is one project), then any backlog
 * whose project this client cannot see.
 */
export function buildBacklogSwitcher(input: {
  readonly sources: ReadonlyArray<BacklogSource>;
  readonly projects: ReadonlyArray<Project>;
  readonly groupingSettings: ProjectGroupingSettings;
  readonly primaryEnvironmentId: EnvironmentId | null;
}): ReadonlyArray<BacklogSwitcherEntry> {
  const { sources, primaryEnvironmentId } = input;
  const labelByEnvironment = new Map(sources.map((source) => [source.environmentId, source.label]));
  const writable = (environmentId: EnvironmentId) =>
    sources.some(
      (source) => source.environmentId === environmentId && isBacklogSourceWritable(source),
    );

  const allBacklogs: BacklogRef[] = sources.flatMap((source) =>
    (source.board?.backlogs ?? []).map((backlog) => ({
      environmentId: source.environmentId,
      backlog,
    })),
  );
  const inboxes = allBacklogs.filter((ref) => ref.backlog.kind === "inbox");

  const primaryInbox = preferPrimary(inboxes, writable, primaryEnvironmentId);
  const inboxSource = preferPrimary(
    sources.filter((source) => source.board !== null),
    writable,
    primaryEnvironmentId,
  );
  const inboxTarget: BacklogCreateTarget | null = primaryInbox
    ? { environmentId: primaryInbox.environmentId, backlogId: primaryInbox.backlog.id }
    : inboxSource
      ? { environmentId: inboxSource.environmentId }
      : null;

  const groups = buildProjectGroups({
    projects: input.projects,
    settings: input.groupingSettings,
    preferredEnvironmentId: primaryEnvironmentId,
  });
  const groupKeyByProjectRef = new Map<string, string>();
  for (const group of groups) {
    for (const ref of group.memberProjectRefs) {
      groupKeyByProjectRef.set(`${ref.environmentId}:${ref.projectId}`, group.key);
    }
  }
  // Project ids are local to a machine; the repository is what names the same project
  // elsewhere, so a backlog homed on one machine serves the checkout on another.
  const groupKeysByRepository = new Map<string, string[]>();
  for (const project of input.projects) {
    const repositoryKey = project.repositoryIdentity?.canonicalKey;
    const groupKey = groupKeyByProjectRef.get(`${project.environmentId}:${project.id}`);
    if (!repositoryKey || groupKey === undefined) continue;
    const keys = groupKeysByRepository.get(repositoryKey) ?? [];
    if (!keys.includes(groupKey)) keys.push(groupKey);
    groupKeysByRepository.set(repositoryKey, keys);
  }
  const groupKeyForBacklog = (ref: BacklogRef): string | undefined => {
    const exact =
      ref.backlog.projectId === null
        ? undefined
        : groupKeyByProjectRef.get(`${ref.environmentId}:${ref.backlog.projectId}`);
    const byRepository =
      ref.backlog.repositoryKey === null
        ? undefined
        : groupKeysByRepository.get(ref.backlog.repositoryKey);
    if (byRepository === undefined || byRepository.length === 0) return exact;
    // Several groups share a repository when grouping splits it by path; the exact checkout wins.
    return exact !== undefined && byRepository.includes(exact) ? exact : byRepository[0];
  };
  const backlogsByGroup = new Map<string, BacklogRef[]>();
  const orphans: BacklogRef[] = [];
  for (const ref of allBacklogs) {
    if (ref.backlog.kind !== "project") continue;
    const groupKey = groupKeyForBacklog(ref);
    if (groupKey === undefined) {
      orphans.push(ref);
      continue;
    }
    const existing = backlogsByGroup.get(groupKey);
    if (existing) existing.push(ref);
    else backlogsByGroup.set(groupKey, [ref]);
  }

  const projectEntries = groups.map((group): BacklogSwitcherEntry & { machines: string[] } => {
    const backlogs = backlogsByGroup.get(group.key) ?? [];
    const existing = preferPrimary(backlogs, writable, primaryEnvironmentId);
    const ownProject = existing
      ? null
      : preferPrimary(group.memberProjectRefs, writable, primaryEnvironmentId);
    const machines = [
      ...new Set(
        (backlogs.length > 0 ? backlogs : group.memberProjectRefs).map(
          (ref) => labelByEnvironment.get(ref.environmentId) ?? "Unknown machine",
        ),
      ),
    ];
    return {
      key: backlogScopeKey({ kind: "project", projectKey: group.key }),
      scope: { kind: "project", projectKey: group.key },
      label: group.label,
      machineLabel: null,
      machines,
      backlogs,
      openCount: countOpen(sources, backlogs),
      createTarget: existing
        ? { environmentId: existing.environmentId, backlogId: existing.backlog.id }
        : ownProject
          ? { environmentId: ownProject.environmentId, projectId: ownProject.projectId }
          : null,
      projectRefs: group.memberProjectRefs,
    };
  });

  const orphanEntries = orphans.map((ref): BacklogSwitcherEntry & { machines: string[] } => ({
    key: backlogScopeKey({
      kind: "backlog",
      environmentId: ref.environmentId,
      backlogId: ref.backlog.id,
    }),
    scope: { kind: "backlog", environmentId: ref.environmentId, backlogId: ref.backlog.id },
    label: ref.backlog.title,
    machineLabel: null,
    machines: [labelByEnvironment.get(ref.environmentId) ?? "Unknown machine"],
    backlogs: [ref],
    openCount: countOpen(sources, [ref]),
    createTarget: writable(ref.environmentId)
      ? { environmentId: ref.environmentId, backlogId: ref.backlog.id }
      : null,
    projectRefs: [],
  }));

  // Name the machines only where two entries would otherwise read the same.
  const named = [...projectEntries, ...orphanEntries];
  const labelCounts = new Map<string, number>();
  for (const entry of named) {
    const label = entry.label.toLowerCase();
    labelCounts.set(label, (labelCounts.get(label) ?? 0) + 1);
  }
  const disambiguated = named.map(({ machines, ...entry }): BacklogSwitcherEntry => ({
    ...entry,
    machineLabel:
      (labelCounts.get(entry.label.toLowerCase()) ?? 0) > 1 ? machines.join(", ") : null,
  }));
  disambiguated.sort((left, right) => {
    const leftHas = left.backlogs.length > 0 ? 0 : 1;
    const rightHas = right.backlogs.length > 0 ? 0 : 1;
    if (leftHas !== rightHas) return leftHas - rightHas;
    return left.label.localeCompare(right.label, undefined, { sensitivity: "base" });
  });

  return [
    {
      key: "all",
      scope: { kind: "all" },
      label: "All backlogs",
      machineLabel: null,
      backlogs: allBacklogs,
      openCount: countOpen(sources, allBacklogs),
      createTarget: inboxTarget,
      projectRefs: [],
    },
    {
      key: "inbox",
      scope: { kind: "inbox" },
      label: "Inbox",
      machineLabel: null,
      backlogs: inboxes,
      openCount: countOpen(sources, inboxes),
      createTarget: inboxTarget,
      projectRefs: [],
    },
    ...disambiguated,
  ];
}

/** The entry a project (thread, draft or project page) belongs to, else the Inbox. */
export function backlogEntryForProject(
  entries: ReadonlyArray<BacklogSwitcherEntry>,
  projectRef: { readonly environmentId: EnvironmentId; readonly projectId: ProjectId } | null,
): BacklogSwitcherEntry | null {
  const inbox = entries.find((entry) => entry.scope.kind === "inbox") ?? null;
  if (projectRef === null) return inbox;
  return (
    entries.find((entry) =>
      entry.projectRefs.some(
        (ref) =>
          ref.environmentId === projectRef.environmentId && ref.projectId === projectRef.projectId,
      ),
    ) ?? inbox
  );
}

// Board

export interface BoardIssue {
  readonly environmentId: EnvironmentId;
  readonly issue: BacklogIssue;
}

export const BACKLOG_BOARD_STATUSES = [
  "inbox",
  "backlog",
  "ready",
  "in_progress",
  "review",
  "done",
] as const satisfies ReadonlyArray<BacklogIssueStatus>;

export const BACKLOG_STATUS_LABELS: Record<BacklogIssueStatus, string> = {
  inbox: "Inbox",
  backlog: "Backlog",
  ready: "Ready",
  in_progress: "In Progress",
  review: "Review",
  done: "Done",
  wontfix: "Won't fix",
};

export const BACKLOG_TYPE_LABELS: Record<BacklogIssueType, string> = {
  idea: "Idea",
  bug: "Bug",
  feature: "Feature",
};

export const BACKLOG_TYPES: ReadonlyArray<BacklogIssueType> = ["idea", "bug", "feature"];
export const BACKLOG_PRIORITIES: ReadonlyArray<BacklogIssuePriority> = ["p0", "p1", "p2", "p3"];

export const BACKLOG_PRIORITY_LABELS: Record<BacklogIssuePriority, string> = {
  p0: "P0",
  p1: "P1",
  p2: "P2",
  p3: "P3",
};

export interface BacklogFilters {
  readonly types: ReadonlyArray<BacklogIssueType>;
  /** "none" matches unprioritized issues. */
  readonly priorities: ReadonlyArray<BacklogIssuePriority | "none">;
  readonly frontierOnly: boolean;
  readonly query: string;
}

export const EMPTY_BACKLOG_FILTERS: BacklogFilters = {
  types: [],
  priorities: [],
  frontierOnly: false,
  query: "",
};

export function hasActiveBacklogFilters(filters: BacklogFilters): boolean {
  return (
    filters.types.length > 0 ||
    filters.priorities.length > 0 ||
    filters.frontierOnly ||
    filters.query.trim().length > 0
  );
}

export function matchesBacklogFilters(
  issue: BacklogIssue,
  filters: BacklogFilters,
  issuesById: ReadonlyMap<BacklogIssueId, Pick<BacklogIssue, "status">>,
): boolean {
  if (filters.types.length > 0 && !filters.types.includes(issue.type)) return false;
  if (filters.priorities.length > 0 && !filters.priorities.includes(issue.priority ?? "none")) {
    return false;
  }
  if (filters.frontierOnly && !isBacklogIssueOnFrontier(issue, issuesById)) return false;
  const query = filters.query.trim().toLowerCase();
  if (query.length > 0) {
    const key = issue.key.toLowerCase();
    if (!issue.title.toLowerCase().includes(query) && !key.includes(query)) return false;
  }
  return true;
}

/** A drag that has been sent but not yet confirmed by the board stream. */
export interface PendingBacklogMove {
  readonly status: BacklogIssueStatus;
  /** The row's `updatedAt` when the move was sent: any newer row is the server's answer. */
  readonly fromUpdatedAt: string;
}

export function boardIssueKey(environmentId: EnvironmentId, issueId: BacklogIssueId): string {
  return `${environmentId}:${issueId}`;
}

/** The status to draw a card in: the pending move until the server's row supersedes it. */
export function displayedBacklogStatus(
  item: BoardIssue,
  pendingMoves: ReadonlyMap<string, PendingBacklogMove>,
): BacklogIssueStatus {
  const pending = pendingMoves.get(boardIssueKey(item.environmentId, item.issue.id));
  return pending && pending.fromUpdatedAt === item.issue.updatedAt
    ? pending.status
    : item.issue.status;
}

function compareUpdatedDesc(left: BoardIssue, right: BoardIssue): number {
  if (left.issue.updatedAt !== right.issue.updatedAt) {
    return left.issue.updatedAt < right.issue.updatedAt ? 1 : -1;
  }
  return right.issue.number - left.issue.number;
}

export interface BacklogColumn {
  readonly status: BacklogIssueStatus;
  readonly issues: ReadonlyArray<BoardIssue>;
}

/**
 * Board columns for a scope. Ready reads in claim order (what an agent takes next comes first);
 * every other column is most recently touched first.
 */
export function buildBacklogColumns(input: {
  readonly sources: ReadonlyArray<BacklogSource>;
  readonly backlogs: ReadonlyArray<BacklogRef>;
  readonly filters: BacklogFilters;
  readonly showWontfix: boolean;
  readonly pendingMoves: ReadonlyMap<string, PendingBacklogMove>;
}): ReadonlyArray<BacklogColumn> {
  const statuses: ReadonlyArray<BacklogIssueStatus> = input.showWontfix
    ? [...BACKLOG_BOARD_STATUSES, "wontfix"]
    : BACKLOG_BOARD_STATUSES;
  const columns = new Map<BacklogIssueStatus, BoardIssue[]>(statuses.map((status) => [status, []]));
  const backlogIdsByEnvironment = new Map<EnvironmentId, Set<BacklogId>>();
  for (const ref of input.backlogs) {
    const ids = backlogIdsByEnvironment.get(ref.environmentId) ?? new Set<BacklogId>();
    ids.add(ref.backlog.id);
    backlogIdsByEnvironment.set(ref.environmentId, ids);
  }
  for (const source of input.sources) {
    const backlogIds = backlogIdsByEnvironment.get(source.environmentId);
    if (!backlogIds || !source.board) continue;
    for (const issue of source.board.issues) {
      if (!backlogIds.has(issue.backlogId)) continue;
      if (!matchesBacklogFilters(issue, input.filters, source.board.issuesById)) continue;
      const item = { environmentId: source.environmentId, issue };
      columns.get(displayedBacklogStatus(item, input.pendingMoves))?.push(item);
    }
  }
  return statuses.map((status) => {
    const issues = columns.get(status) ?? [];
    issues.sort(
      status === "ready"
        ? (left, right) => compareBacklogIssuesForClaim(left.issue, right.issue)
        : compareUpdatedDesc,
    );
    return { status, issues };
  });
}

/** Whether the visible issues come from more than one machine, so cards should name theirs. */
export function backlogsSpanEnvironments(backlogs: ReadonlyArray<BacklogRef>): boolean {
  const first = backlogs[0]?.environmentId;
  return backlogs.some((ref) => ref.environmentId !== first);
}

// Cards

/** Keys of the blockers still open. A blocker the board does not know reads as open. */
export function openBlockerKeys(
  issue: Pick<BacklogIssue, "blockedBy">,
  issuesById: ReadonlyMap<BacklogIssueId, Pick<BacklogIssue, "status" | "key">>,
): ReadonlyArray<string> {
  const keys: string[] = [];
  for (const blockerId of issue.blockedBy) {
    const blocker = issuesById.get(blockerId);
    if (blocker === undefined) keys.push("unknown issue");
    else if (!isBacklogStatusClosed(blocker.status)) keys.push(blocker.key);
  }
  return keys;
}

export interface BacklogChildProgress {
  readonly closed: number;
  readonly total: number;
}

/** Roll-up for every parent on a board: how many of its children are closed. */
export function backlogChildProgress(
  issues: ReadonlyArray<Pick<BacklogIssue, "parentId" | "status">>,
): ReadonlyMap<BacklogIssueId, BacklogChildProgress> {
  const progress = new Map<BacklogIssueId, { closed: number; total: number }>();
  for (const issue of issues) {
    if (issue.parentId === null) continue;
    const entry = progress.get(issue.parentId) ?? { closed: 0, total: 0 };
    entry.total += 1;
    if (isBacklogStatusClosed(issue.status)) entry.closed += 1;
    progress.set(issue.parentId, entry);
  }
  return progress;
}

// Editing

const isBacklogKey = Schema.is(BacklogKey);

/** Uppercases a typed key; null when it is not a valid BacklogKey. */
export function normalizeBacklogKeyInput(value: string): string | null {
  const candidate = value.trim().toUpperCase();
  return isBacklogKey(candidate) ? candidate : null;
}

/** Issues on the same backlog that may block `issue`: never itself, never twice. */
export function blockerCandidates(
  issue: Pick<BacklogIssue, "id" | "backlogId" | "blockedBy">,
  issues: ReadonlyArray<BacklogIssue>,
): ReadonlyArray<BacklogIssue> {
  return issues
    .filter(
      (candidate) =>
        candidate.backlogId === issue.backlogId &&
        candidate.id !== issue.id &&
        !issue.blockedBy.includes(candidate.id),
    )
    .toSorted((left, right) => left.number - right.number);
}

/** One line for an activity entry; comments carry their own text and render separately. */
export function describeBacklogActivity(
  activity: Pick<BacklogActivity, "kind" | "text" | "fromStatus" | "toStatus">,
): string {
  const move =
    activity.fromStatus && activity.toStatus
      ? `${BACKLOG_STATUS_LABELS[activity.fromStatus]} → ${BACKLOG_STATUS_LABELS[activity.toStatus]}`
      : activity.toStatus
        ? BACKLOG_STATUS_LABELS[activity.toStatus]
        : null;
  switch (activity.kind) {
    case "created":
      return "created the issue";
    case "edited":
      return activity.text ?? "edited the issue";
    case "status_changed":
      return move ? `moved it ${move}` : "changed the status";
    case "moved":
      return activity.text ?? "moved it to another backlog";
    case "claimed":
      return "claimed it";
    case "released":
      return move
        ? `released it to ${BACKLOG_STATUS_LABELS[activity.toStatus ?? "ready"]}`
        : "released it";
    case "lease_expired":
      return "claim expired; returned to Ready";
    case "commented":
      return "commented";
    case "linked":
      return activity.text ?? "linked work";
  }
}

/** Where Reopen sends a closed issue: back to triage in the Inbox, else the project backlog. */
export function reopenStatusFor(backlogKind: Backlog["kind"]): BacklogIssueStatus {
  return backlogKind === "inbox" ? "inbox" : "backlog";
}

export interface BacklogMoveTarget {
  readonly value: string;
  readonly label: string;
  readonly input: { readonly backlogId: BacklogId } | { readonly projectId: ProjectId };
}

/**
 * Where an issue can move on its own machine: any other backlog there, or a project there that
 * has no backlog yet (the server creates it on the move). Inbox first, then by name.
 */
export function backlogMoveTargets(input: {
  readonly currentBacklogId: BacklogId;
  readonly backlogs: ReadonlyArray<Backlog>;
  readonly projects: ReadonlyArray<Pick<Project, "id" | "title">>;
}): ReadonlyArray<BacklogMoveTarget> {
  const projectsWithBacklog = new Set(input.backlogs.map((backlog) => backlog.projectId));
  const existing = input.backlogs
    .filter((backlog) => backlog.id !== input.currentBacklogId)
    .map((backlog): BacklogMoveTarget => ({
      value: `backlog:${backlog.id}`,
      label: backlog.kind === "inbox" ? "Inbox" : `${backlog.title} (${backlog.key})`,
      input: { backlogId: backlog.id },
    }));
  const fresh = input.projects
    .filter((project) => !projectsWithBacklog.has(project.id))
    .map((project): BacklogMoveTarget => ({
      value: `project:${project.id}`,
      label: project.title,
      input: { projectId: project.id },
    }));
  return [...existing, ...fresh].toSorted((left, right) => {
    const leftInbox = left.label === "Inbox" ? 0 : 1;
    const rightInbox = right.label === "Inbox" ? 0 : 1;
    if (leftInbox !== rightInbox) return leftInbox - rightInbox;
    return left.label.localeCompare(right.label, undefined, { sensitivity: "base" });
  });
}
