import {
  backlogFleet,
  groupBacklogIssuesByStatus,
  legacyBacklogInbox,
  type BacklogBoardState,
  type BacklogFleet,
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

/** One environment's board: live once its snapshot arrived, else the last copy this device saved. */
export interface EnvironmentBacklogBoard {
  readonly environmentId: EnvironmentId;
  readonly board: BacklogBoardState;
}

/**
 * Why an issue on this board cannot be changed right now, or null when it can: the
 * environment is out of reach (the board is its last known state), or the board moved.
 */
export function backlogReadOnlyReason(input: {
  readonly connected: boolean;
  readonly board: Pick<BacklogBoardState, "asOf" | "fromCache"> | null;
  readonly backlog: Pick<Backlog, "key" | "movedTo"> | null;
  readonly label: string;
  readonly formatTime: (iso: string) => string;
}): string | null {
  const movedTo = input.backlog?.movedTo;
  if (input.backlog !== null && movedTo !== undefined) {
    return `${input.backlog.key} moved to ${movedTo.label}. This copy is read-only.`;
  }
  if (input.connected && input.board?.fromCache !== true) return null;
  if (input.connected) return `Loading ${input.label}…`;
  const asOf = input.board?.asOf;
  return asOf === undefined
    ? `Offline — ${input.label} is not connected; changes are disabled.`
    : `Offline — showing ${input.label}'s board as of ${input.formatTime(asOf)}; changes are disabled.`;
}

/** A move leaves a redirect with the same backlog id; once the board itself is visible, drop it. */
function withoutSupersededRedirects(
  entries: ReadonlyArray<ScopedBacklog>,
): ReadonlyArray<ScopedBacklog> {
  const live = new Set(
    entries.filter((entry) => entry.backlog.movedTo === undefined).map((entry) => entry.backlog.id),
  );
  return entries.filter(
    (entry) => entry.backlog.movedTo === undefined || !live.has(entry.backlog.id),
  );
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

/**
 * An entry in the backlog picker: everything, the Inbox, one logical project, or an Inbox a
 * machine kept from before it was linked to a hub (listed while it holds open issues).
 */
export interface BacklogScope {
  readonly key: string;
  readonly kind: "all" | "inbox" | "project" | "legacyInbox";
  readonly label: string;
  readonly backlogs: ReadonlyArray<ScopedBacklog>;
  readonly projectRefs: ReadonlyArray<BacklogProjectRef>;
  /** On All and the Inbox: the hub whose Inbox is the one for every machine, when linked. */
  readonly fleet?: BacklogFleet | null;
  /** On a legacy Inbox: the hub its open issues move to. */
  readonly legacyInbox?: { readonly environmentId: EnvironmentId; readonly hubLabel: string };
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
  readonly environmentLabel?: (environmentId: EnvironmentId) => string | null;
}): ReadonlyArray<BacklogScope> {
  const allBacklogs = withoutSupersededRedirects(
    input.boards.flatMap(({ environmentId, board }) =>
      board.backlogs.map((backlog) => ({ environmentId, backlog })),
    ),
  );
  // With a hub there is one Inbox for every machine; a linked machine's own is legacy.
  const fleet = backlogFleet(input.boards);
  const linkedIds = new Set(
    input.boards.flatMap(({ environmentId, board }) => (board.linkedHub ? [environmentId] : [])),
  );
  const inboxBacklogs = allBacklogs.filter(
    (entry) => entry.backlog.kind === "inbox" && !linkedIds.has(entry.environmentId),
  );
  const legacyScopes = input.boards.flatMap(({ environmentId, board }): BacklogScope[] => {
    const legacy = legacyBacklogInbox(board);
    if (legacy === null || legacy.openCount === 0) return [];
    const machine = input.environmentLabel?.(environmentId) ?? "another machine";
    return [
      {
        key: `backlog:${environmentId}:${legacy.backlog.id}`,
        kind: "legacyInbox",
        label: `Inbox on ${machine} (legacy)`,
        backlogs: [{ environmentId, backlog: legacy.backlog }],
        projectRefs: [],
        legacyInbox: { environmentId, hubLabel: legacy.hub.label },
      },
    ];
  });
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
      fleet,
    },
    {
      key: INBOX_BACKLOG_SCOPE_KEY,
      kind: "inbox",
      label: "Inbox",
      backlogs: inboxBacklogs,
      projectRefs: [],
      fleet,
    },
    ...legacyScopes,
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

/** How far one environment's board has got, for deciding where a new issue may go. */
export interface BacklogEnvironmentAvailability {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  /** ready: connected and its snapshot arrived. */
  readonly state: "ready" | "loading" | "offline" | "failed";
}

export type BacklogCreateResolution =
  | { readonly target: BacklogCreateTarget; readonly blockedReason: null; readonly loading: false }
  | { readonly target: null; readonly blockedReason: string; readonly loading: boolean };

function blocked(blockedReason: string, loading = false): BacklogCreateResolution {
  return { target: null, blockedReason, loading };
}

function joinLabels(environments: ReadonlyArray<BacklogEnvironmentAvailability>): string {
  return [...new Set(environments.map((environment) => environment.label))].join(", ");
}

/**
 * Where an Inbox idea goes when a connected machine is linked to a hub: the hub's
 * Inbox, reached directly or through a linked machine, which forwards it.
 */
function resolveFleetInboxTarget(
  fleet: BacklogFleet,
  inboxes: ReadonlyArray<ScopedBacklog>,
  environments: ReadonlyArray<BacklogEnvironmentAvailability>,
): BacklogCreateResolution {
  const { hub, spokeEnvironmentIds } = fleet;
  const state = (environmentId: EnvironmentId) =>
    environments.find((environment) => environment.environmentId === environmentId)?.state;
  if (state(hub.environmentId) === "ready") {
    const hubInbox = inboxes.find(
      (entry) => entry.environmentId === hub.environmentId && entry.backlog.kind === "inbox",
    );
    return {
      target: {
        environmentId: hub.environmentId,
        input: hubInbox ? { backlogId: hubInbox.backlog.id } : {},
      },
      blockedReason: null,
      loading: false,
    };
  }
  const spoke = environments.find(
    (environment) =>
      environment.state === "ready" && spokeEnvironmentIds.has(environment.environmentId),
  );
  if (spoke) {
    return {
      target: { environmentId: spoke.environmentId, input: {} },
      blockedReason: null,
      loading: false,
    };
  }
  return state(hub.environmentId) === "loading"
    ? blocked(`Loading ${hub.label}…`, true)
    : blocked(`The Inbox lives on ${hub.label}, which is not connected.`);
}

/**
 * Where a new issue lands, in the order the environments are listed. The Inbox
 * (and "All") goes to the hub's Inbox when a machine is linked to one; otherwise
 * to an environment that already hosts an Inbox, else the first ready one. A
 * legacy Inbox takes nothing new. A project goes to the environment hosting its backlog. Without one,
 * the server creates it from a project id, which is only safe once every
 * environment with a checkout has sent its board: one still loading, or offline,
 * may hold the backlog already, and creating here would split the project.
 */
export function resolveBacklogCreateTarget(
  scope: BacklogScope,
  environments: ReadonlyArray<BacklogEnvironmentAvailability>,
): BacklogCreateResolution {
  if (scope.kind === "legacyInbox") {
    const hub = scope.legacyInbox ? `the ${scope.legacyInbox.hubLabel}` : "the hub's";
    return blocked(`New ideas go to ${hub} Inbox.`);
  }
  if (scope.kind !== "project" && scope.fleet) {
    return resolveFleetInboxTarget(scope.fleet, scope.backlogs, environments);
  }
  const ready = environments.filter((environment) => environment.state === "ready");
  const order = (environmentId: EnvironmentId) =>
    ready.findIndex((environment) => environment.environmentId === environmentId);
  const hosted = scope.backlogs
    .filter((entry) => order(entry.environmentId) !== -1 && entry.backlog.movedTo === undefined)
    .filter((entry) => (scope.kind === "project" ? true : entry.backlog.kind === "inbox"))
    .sort((left, right) => order(left.environmentId) - order(right.environmentId))[0];
  if (hosted) {
    return {
      target: { environmentId: hosted.environmentId, input: { backlogId: hosted.backlog.id } },
      blockedReason: null,
      loading: false,
    };
  }
  if (scope.kind !== "project") {
    const first = ready[0];
    if (first) {
      return {
        target: { environmentId: first.environmentId, input: {} },
        blockedReason: null,
        loading: false,
      };
    }
    const loading = environments.filter((environment) => environment.state === "loading");
    return loading.length > 0
      ? blocked(`Loading ${joinLabels(loading)}…`, true)
      : blocked("Connect an environment to add to the backlog.");
  }
  const movedTo = scope.backlogs.find((entry) => entry.backlog.movedTo !== undefined)?.backlog
    .movedTo;
  if (movedTo !== undefined) {
    return blocked(`${scope.label} moved to ${movedTo.label}, which is not connected.`);
  }
  if (scope.backlogs.length > 0) {
    return blocked(`The environment holding ${scope.label} is not connected.`);
  }
  // Environments this client does not follow (disabled, or without Backlog) cannot block.
  const checkoutIds = new Set(scope.projectRefs.map((ref) => ref.environmentId));
  const checkouts = environments.filter((environment) =>
    checkoutIds.has(environment.environmentId),
  );
  const loading = checkouts.filter((environment) => environment.state === "loading");
  if (loading.length > 0) return blocked(`Loading ${joinLabels(loading)}…`, true);
  const failed = checkouts.find((environment) => environment.state === "failed");
  if (failed) return blocked(`Could not read the backlog on ${failed.label}.`);
  const offline = checkouts.filter((environment) => environment.state === "offline");
  if (offline.length > 0) {
    return blocked(
      `${joinLabels(offline)} may hold this backlog and ${offline.length > 1 ? "are" : "is"} offline.`,
    );
  }
  const checkout = scope.projectRefs
    .filter((ref) => order(ref.environmentId) !== -1)
    .sort((left, right) => order(left.environmentId) - order(right.environmentId))[0];
  return checkout
    ? {
        target: { environmentId: checkout.environmentId, input: { projectId: checkout.projectId } },
        blockedReason: null,
        loading: false,
      }
    : blocked(`No connected environment has ${scope.label}. Reconnect one to add here.`);
}

/**
 * Projects on one environment that a move may target by project id, creating
 * their backlog there: no backlog anywhere yet, and every checkout has answered.
 */
export function creatableProjectIdsOn(
  scopes: ReadonlyArray<BacklogScope>,
  environments: ReadonlyArray<BacklogEnvironmentAvailability>,
  environmentId: EnvironmentId,
): ReadonlySet<ProjectId> {
  const ids = new Set<ProjectId>();
  for (const scope of scopes) {
    if (scope.kind !== "project" || scope.backlogs.length > 0) continue;
    if (resolveBacklogCreateTarget(scope, environments).target === null) continue;
    for (const ref of scope.projectRefs) {
      if (ref.environmentId === environmentId) ids.add(ref.projectId);
    }
  }
  return ids;
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
 * issue's environment, since backlogs elsewhere live in other databases. A
 * project without a backlog here is offered only when `creatableProjectIds`
 * allows it, so a move never creates a second backlog beside one elsewhere.
 */
export function backlogMoveTargets(
  board: BacklogBoardState,
  issue: Pick<BacklogIssue, "backlogId">,
  projects: ReadonlyArray<{ readonly id: ProjectId; readonly title: string }>,
  creatableProjectIds: ReadonlySet<ProjectId>,
): ReadonlyArray<BacklogMoveTarget> {
  const byLabel = (left: BacklogMoveTarget, right: BacklogMoveTarget) =>
    left.label.localeCompare(right.label, undefined, { sensitivity: "base" });
  const liveBacklogs = board.backlogs.filter((backlog) => backlog.movedTo === undefined);
  const backlogByProjectId = new Map(
    liveBacklogs.flatMap((backlog) =>
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
  // A machine linked to a hub offers no Inbox: its own is legacy.
  const inbox = board.linkedHub
    ? []
    : liveBacklogs.filter((backlog) => backlog.kind === "inbox").map(backlogTarget);
  const projectTargets = projects.flatMap((project): BacklogMoveTarget[] => {
    const backlog = backlogByProjectId.get(project.id);
    if (backlog) return [{ ...backlogTarget(backlog), label: project.title }];
    return creatableProjectIds.has(project.id)
      ? [{ key: `project:${project.id}`, label: project.title, patch: { projectId: project.id } }]
      : [];
  });
  const orphans = liveBacklogs
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
