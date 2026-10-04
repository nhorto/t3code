import {
  groupBacklogIssuesByStatus,
  type BacklogBoardState,
} from "@t3tools/client-runtime/state/backlog";
import {
  BACKLOG_ISSUE_STATUSES,
  isBacklogIssueBlocked,
  isBacklogStatusClosed,
  type Backlog,
  type BacklogActivity,
  type BacklogCreateIssueInput,
  type BacklogId,
  type BacklogIssue,
  type BacklogIssueClaim,
  type BacklogIssueId,
  type BacklogIssuePriority,
  type BacklogIssueStatus,
  type BacklogIssueType,
  EnvironmentId,
  ProjectId,
} from "@t3tools/contracts";

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

export const ALL_BACKLOG_SCOPE_KEY = "all";
export const INBOX_BACKLOG_SCOPE_KEY = "inbox";

/** One environment's live board, once its snapshot has arrived. */
export interface EnvironmentBacklogBoard {
  readonly environmentId: EnvironmentId;
  readonly board: BacklogBoardState;
}

export interface BacklogProjectRef {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
}

/** A logical project: the same repository checked out on one or more environments. */
export interface BacklogProjectGroup {
  readonly key: string;
  readonly label: string;
  readonly projectRefs: ReadonlyArray<BacklogProjectRef>;
  /** Repository canonical keys of the checkouts, which match backlogs homed on other machines. */
  readonly repositoryKeys: ReadonlyArray<string>;
}

export interface ScopedBacklog {
  readonly environmentId: EnvironmentId;
  readonly backlog: Backlog;
}

/** An entry in the backlog picker: everything, the Inbox, or one logical project. */
export interface BacklogScope {
  readonly key: string;
  readonly kind: "all" | "inbox" | "project";
  readonly label: string;
  readonly backlogs: ReadonlyArray<ScopedBacklog>;
  readonly projectRefs: ReadonlyArray<BacklogProjectRef>;
}

export interface BoardIssueEntry {
  readonly environmentId: EnvironmentId;
  readonly issue: BacklogIssue;
}

function scopedKey(environmentId: EnvironmentId, id: string): string {
  return `${environmentId}\u0000${id}`;
}

function compareLabels(left: { readonly label: string }, right: { readonly label: string }) {
  return left.label.localeCompare(right.label, undefined, { sensitivity: "base" });
}

/**
 * Picker entries: All, Inbox, then one entry per logical project (merging the
 * same repository across environments). Each project backlog belongs to one
 * project: the checkout it was created for, else any project with the same
 * repository, since a backlog homed on one machine serves the repository's
 * checkouts on every machine. A backlog matching no listed project still gets
 * its own entry so its issues stay reachable.
 */
export function buildBacklogScopes(input: {
  readonly boards: ReadonlyArray<EnvironmentBacklogBoard>;
  readonly projectGroups: ReadonlyArray<BacklogProjectGroup>;
}): ReadonlyArray<BacklogScope> {
  const allBacklogs: ScopedBacklog[] = input.boards.flatMap(({ environmentId, board }) =>
    board.backlogs.map((backlog) => ({ environmentId, backlog })),
  );
  const inboxBacklogs = allBacklogs.filter((entry) => entry.backlog.kind === "inbox");
  const groupKeyByProjectRef = new Map<string, string>();
  const groupKeyByRepository = new Map<string, string>();
  for (const group of input.projectGroups) {
    for (const ref of group.projectRefs) {
      const refKey = scopedKey(ref.environmentId, ref.projectId);
      if (!groupKeyByProjectRef.has(refKey)) groupKeyByProjectRef.set(refKey, group.key);
    }
    for (const repositoryKey of group.repositoryKeys) {
      if (!groupKeyByRepository.has(repositoryKey))
        groupKeyByRepository.set(repositoryKey, group.key);
    }
  }
  const backlogsByGroupKey = new Map<string, ScopedBacklog[]>();
  const orphanScopes: BacklogScope[] = [];
  for (const entry of allBacklogs) {
    if (entry.backlog.kind !== "project") continue;
    const groupKey =
      (entry.backlog.projectId === null
        ? undefined
        : groupKeyByProjectRef.get(scopedKey(entry.environmentId, entry.backlog.projectId))) ??
      (entry.backlog.repositoryKey === null
        ? undefined
        : groupKeyByRepository.get(entry.backlog.repositoryKey));
    if (groupKey === undefined) {
      orphanScopes.push({
        key: `backlog:${entry.environmentId}:${entry.backlog.id}`,
        kind: "project",
        label: entry.backlog.title,
        backlogs: [entry],
        projectRefs: [],
      });
      continue;
    }
    const existing = backlogsByGroupKey.get(groupKey);
    if (existing) existing.push(entry);
    else backlogsByGroupKey.set(groupKey, [entry]);
  }
  const projectScopes: BacklogScope[] = input.projectGroups.map((group) => ({
    key: `project:${group.key}`,
    kind: "project",
    label: group.label,
    backlogs: backlogsByGroupKey.get(group.key) ?? [],
    projectRefs: group.projectRefs,
  }));

  return [
    {
      key: ALL_BACKLOG_SCOPE_KEY,
      kind: "all",
      label: "All backlogs",
      backlogs: allBacklogs,
      projectRefs: [],
    },
    {
      key: INBOX_BACKLOG_SCOPE_KEY,
      kind: "inbox",
      label: "Inbox",
      backlogs: inboxBacklogs,
      projectRefs: [],
    },
    ...[...projectScopes, ...orphanScopes].sort(compareLabels),
  ];
}

/** A project checkout from route params, or null when they are missing or malformed. */
export function parseBacklogProjectRef(
  params: { readonly environmentId?: string; readonly projectId?: string } | undefined,
): BacklogProjectRef | null {
  if (!params?.environmentId || !params.projectId) return null;
  try {
    return {
      environmentId: EnvironmentId.make(params.environmentId),
      projectId: ProjectId.make(params.projectId),
    };
  } catch {
    return null;
  }
}

/** The scope whose project includes this checkout, for opening a project's backlog. */
export function findBacklogScopeForProject(
  scopes: ReadonlyArray<BacklogScope>,
  ref: BacklogProjectRef,
): BacklogScope | null {
  return (
    scopes.find((scope) =>
      scope.projectRefs.some(
        (candidate) =>
          candidate.environmentId === ref.environmentId && candidate.projectId === ref.projectId,
      ),
    ) ?? null
  );
}

export function resolveBacklogScope(
  scopes: ReadonlyArray<BacklogScope>,
  key: string | null | undefined,
): BacklogScope {
  return scopes.find((scope) => scope.key === key) ?? scopes[0]!;
}

/** Issues in a scope across every loaded environment, each issue once. */
export function selectBacklogScopeIssues(
  boards: ReadonlyArray<EnvironmentBacklogBoard>,
  scope: BacklogScope,
): ReadonlyArray<BoardIssueEntry> {
  const backlogKeys = new Set(
    scope.backlogs.map((entry) => scopedKey(entry.environmentId, entry.backlog.id)),
  );
  const seen = new Set<BacklogIssueId>();
  const entries: BoardIssueEntry[] = [];
  for (const { environmentId, board } of boards) {
    for (const issue of board.issues) {
      if (seen.has(issue.id)) continue;
      if (scope.kind !== "all" && !backlogKeys.has(scopedKey(environmentId, issue.backlogId))) {
        continue;
      }
      seen.add(issue.id);
      entries.push({ environmentId, issue });
    }
  }
  return entries;
}

/** Every loaded issue by id, so blockers resolve across backlogs and environments. */
export function mergeBacklogIssuesById(
  boards: ReadonlyArray<EnvironmentBacklogBoard>,
): ReadonlyMap<BacklogIssueId, BacklogIssue> {
  const merged = new Map<BacklogIssueId, BacklogIssue>();
  for (const { board } of boards) {
    for (const issue of board.issues) {
      if (!merged.has(issue.id)) merged.set(issue.id, issue);
    }
  }
  return merged;
}

export interface BacklogIssueFilter {
  readonly query: string;
  readonly type: BacklogIssueType | null;
}

/** Matches every query word against the key or title; the type filter is exact. */
export function filterBacklogIssues(
  entries: ReadonlyArray<BoardIssueEntry>,
  filter: BacklogIssueFilter,
): ReadonlyArray<BoardIssueEntry> {
  const tokens = filter.query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  if (tokens.length === 0 && filter.type === null) return entries;
  return entries.filter(({ issue }) => {
    if (filter.type !== null && issue.type !== filter.type) return false;
    const haystack = `${issue.key} ${issue.title}`.toLocaleLowerCase();
    return tokens.every((token) => haystack.includes(token));
  });
}

export type BacklogListItem =
  | {
      readonly type: "section";
      readonly key: string;
      readonly status: BacklogIssueStatus;
      readonly label: string;
      readonly count: number;
      /** Null for open columns, which never collapse. */
      readonly collapsed: boolean | null;
    }
  | {
      readonly type: "issue";
      readonly key: string;
      readonly entry: BoardIssueEntry;
      readonly blocked: boolean;
      readonly isFirst: boolean;
      readonly isLast: boolean;
    };

/**
 * Flattens issues into status sections in board order. Empty columns are
 * skipped; closed columns start collapsed until the user expands them.
 */
export function buildBacklogListItems(input: {
  readonly entries: ReadonlyArray<BoardIssueEntry>;
  readonly issuesById: ReadonlyMap<BacklogIssueId, Pick<BacklogIssue, "status">>;
  readonly expandedClosedStatuses: ReadonlySet<BacklogIssueStatus>;
}): ReadonlyArray<BacklogListItem> {
  const entryById = new Map(input.entries.map((entry) => [entry.issue.id, entry]));
  const columns = groupBacklogIssuesByStatus(input.entries.map((entry) => entry.issue));
  const items: BacklogListItem[] = [];
  for (const status of BACKLOG_ISSUE_STATUSES) {
    const column = columns.get(status) ?? [];
    if (column.length === 0) continue;
    const closed = isBacklogStatusClosed(status);
    const collapsed = closed ? !input.expandedClosedStatuses.has(status) : null;
    items.push({
      type: "section",
      key: `section:${status}`,
      status,
      label: BACKLOG_STATUS_LABELS[status],
      count: column.length,
      collapsed,
    });
    if (collapsed) continue;
    column.forEach((issue, index) => {
      const entry = entryById.get(issue.id);
      if (!entry) return;
      items.push({
        type: "issue",
        key: `issue:${entry.environmentId}:${issue.id}`,
        entry,
        blocked: isBacklogIssueBlocked(issue, input.issuesById),
        isFirst: index === 0,
        isLast: index === column.length - 1,
      });
    });
  }
  return items;
}

export interface BacklogCreateTarget {
  readonly environmentId: EnvironmentId;
  readonly input: Pick<BacklogCreateIssueInput, "backlogId" | "projectId">;
}

/**
 * Where a new issue lands. The Inbox (and "All") goes to the first connected
 * environment that already hosts an Inbox, else the first connected one. A
 * project goes to the environment hosting its backlog, else to a connected
 * checkout of the project, which creates the backlog on first use.
 */
export function resolveBacklogCreateTarget(
  scope: BacklogScope,
  connectedEnvironmentIds: ReadonlyArray<EnvironmentId>,
): BacklogCreateTarget | null {
  const connectedOrder = (environmentId: EnvironmentId) =>
    connectedEnvironmentIds.indexOf(environmentId);
  const connectedBacklogs = scope.backlogs
    .filter((entry) => connectedOrder(entry.environmentId) !== -1)
    .filter((entry) => (scope.kind === "project" ? true : entry.backlog.kind === "inbox"))
    .slice()
    .sort(
      (left, right) => connectedOrder(left.environmentId) - connectedOrder(right.environmentId),
    );
  const hosted = connectedBacklogs[0];
  if (hosted) {
    return { environmentId: hosted.environmentId, input: { backlogId: hosted.backlog.id } };
  }
  if (scope.kind !== "project") {
    const environmentId = connectedEnvironmentIds[0];
    return environmentId === undefined ? null : { environmentId, input: {} };
  }
  const checkout = scope.projectRefs
    .filter((ref) => connectedOrder(ref.environmentId) !== -1)
    .slice()
    .sort(
      (left, right) => connectedOrder(left.environmentId) - connectedOrder(right.environmentId),
    )[0];
  return checkout
    ? { environmentId: checkout.environmentId, input: { projectId: checkout.projectId } }
    : null;
}

/** Quick-add starts on the board's project, or the Inbox when the board is not one project. */
export function defaultQuickAddScopeKey(boardScope: BacklogScope | null): string {
  return boardScope?.kind === "project" ? boardScope.key : INBOX_BACKLOG_SCOPE_KEY;
}

export interface BacklogMoveTarget {
  readonly key: string;
  readonly label: string;
  /** Existing backlogs move by id; a project without one moves by project, creating it. */
  readonly patch: { readonly backlogId: BacklogId } | { readonly projectId: ProjectId };
}

/**
 * Where an issue can move: the Inbox, then every project on the issue's
 * environment, plus any backlog whose project is gone. A move stays on the
 * issue's environment, since backlogs elsewhere live in other databases.
 */
export function backlogMoveTargets(
  board: BacklogBoardState,
  issue: Pick<BacklogIssue, "backlogId">,
  projects: ReadonlyArray<{ readonly id: ProjectId; readonly title: string }>,
): ReadonlyArray<BacklogMoveTarget> {
  const byLabel = (left: BacklogMoveTarget, right: BacklogMoveTarget) =>
    left.label.localeCompare(right.label, undefined, { sensitivity: "base" });
  const backlogByProjectId = new Map(
    board.backlogs.flatMap((backlog) =>
      backlog.kind === "project" && backlog.projectId !== null
        ? [[backlog.projectId, backlog] as const]
        : [],
    ),
  );
  const listedProjectIds = new Set(projects.map((project) => project.id));
  const backlogTarget = (backlog: Backlog): BacklogMoveTarget => ({
    key: `backlog:${backlog.id}`,
    label: backlog.title,
    patch: { backlogId: backlog.id },
  });
  const inbox = board.backlogs.filter((backlog) => backlog.kind === "inbox").map(backlogTarget);
  const projectTargets = projects.map((project): BacklogMoveTarget => {
    const backlog = backlogByProjectId.get(project.id);
    return backlog
      ? { ...backlogTarget(backlog), label: project.title }
      : { key: `project:${project.id}`, label: project.title, patch: { projectId: project.id } };
  });
  const orphans = board.backlogs
    .filter(
      (backlog) =>
        backlog.kind === "project" &&
        (backlog.projectId === null || !listedProjectIds.has(backlog.projectId)),
    )
    .map(backlogTarget);
  return [...inbox, ...[...projectTargets, ...orphans].sort(byLabel)].filter(
    (target) => !("backlogId" in target.patch) || target.patch.backlogId !== issue.backlogId,
  );
}

/** Reopening returns an issue to the column it would have started in. */
export function reopenBacklogStatus(backlog: Pick<Backlog, "kind"> | null): BacklogIssueStatus {
  return backlog?.kind === "inbox" ? "inbox" : "backlog";
}

export function findBacklog(board: BacklogBoardState | null, backlogId: BacklogId): Backlog | null {
  return board?.backlogs.find((backlog) => backlog.id === backlogId) ?? null;
}

/** "Claude · Geekom": who holds the claim and on which machine. */
export function describeBacklogClaim(
  claim: BacklogIssueClaim,
  environmentLabel: (environmentId: EnvironmentId) => string | null,
): string {
  const holder = claim.actor.label.trim() || (claim.actor.kind === "agent" ? "Agent" : "User");
  const machine =
    claim.actor.environmentId === null ? null : environmentLabel(claim.actor.environmentId);
  return machine ? `${holder} · ${machine}` : holder;
}

export function describeBacklogActivity(activity: BacklogActivity): string {
  if (activity.kind === "commented") return activity.text ?? "";
  if (activity.text && activity.text.trim().length > 0) return activity.text;
  if (activity.fromStatus !== null && activity.toStatus !== null) {
    return `${BACKLOG_STATUS_LABELS[activity.fromStatus]} → ${BACKLOG_STATUS_LABELS[activity.toStatus]}`;
  }
  switch (activity.kind) {
    case "created":
      return "Created";
    case "edited":
      return "Edited";
    case "status_changed":
      return activity.toStatus ? `Moved to ${BACKLOG_STATUS_LABELS[activity.toStatus]}` : "Moved";
    case "moved":
      return "Moved to another backlog";
    case "claimed":
      return "Claimed";
    case "released":
      return "Released";
    case "lease_expired":
      return "Claim expired";
    case "linked":
      return "Linked";
  }
}
