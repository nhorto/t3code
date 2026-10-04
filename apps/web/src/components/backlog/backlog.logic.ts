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
import {
  backlogFleet,
  type BacklogBoardState,
  type BacklogFleet,
} from "@t3tools/client-runtime/state/backlog";
import type { EnvironmentConnectionPhase } from "@t3tools/client-runtime/connection";
import * as Schema from "effect/Schema";

import { buildProjectGroups, type ProjectGroupingSettings } from "../../logicalProject";
import type { Project } from "../../types";

// Environments

/**
 * What one environment's board can honestly claim. `stale` keeps the last snapshot on screen,
 * read-only, while its connection is down (from this session, or saved by an earlier one);
 * `unavailable` has nothing to show at all. A saved copy shown while the connection comes up is
 * `loading`: visible and read-only, without an offline notice.
 */
export type BacklogSourceStatus = "loading" | "live" | "stale" | "unavailable" | "error";

export function resolveBacklogSourceStatus(input: {
  readonly connectionPhase: EnvironmentConnectionPhase | null;
  readonly hasBoard: boolean;
  readonly failed: boolean;
  /** The board is this client's saved copy, not yet confirmed by the environment. */
  readonly fromCache?: boolean;
}): BacklogSourceStatus {
  const connected = input.connectionPhase === "connected";
  const coming = input.connectionPhase === "connecting" || input.connectionPhase === "reconnecting";
  if (input.hasBoard && input.fromCache) {
    if (connected && input.failed) return "error";
    return connected || coming ? "loading" : "stale";
  }
  if (input.hasBoard) return connected ? "live" : "stale";
  if (connected) return input.failed ? "error" : "loading";
  return coming ? "loading" : "unavailable";
}

/** The notice for a board shown from its last known state. */
export function backlogOfflineNotice(
  source: Pick<BacklogSource, "label" | "board">,
  formatTime: (iso: string) => string,
): string {
  const asOf = source.board?.asOf;
  return asOf === undefined
    ? `Offline — showing ${source.label}'s last known board; changes are disabled.`
    : `Offline — showing ${source.label}'s board as of ${formatTime(asOf)}; changes are disabled.`;
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

/** Live, and not a redirect left behind by a move to another machine. */
export function isBacklogRefWritable(
  ref: BacklogRef,
  sourceById: ReadonlyMap<EnvironmentId, Pick<BacklogSource, "status">>,
): boolean {
  const source = sourceById.get(ref.environmentId);
  return (
    source !== undefined && isBacklogSourceWritable(source) && ref.backlog.movedTo === undefined
  );
}

/** Ids of the backlogs on a board that moved away; their issues are read-only here. */
export function movedBacklogIds(board: BacklogBoardState | null): ReadonlySet<BacklogId> {
  return new Set(
    (board?.backlogs ?? [])
      .filter((backlog) => backlog.movedTo !== undefined)
      .map((backlog) => backlog.id),
  );
}

/**
 * A move leaves a redirect on the old machine with the same backlog id. Where the client also
 * sees the board itself, the redirect is left out so issues do not show twice.
 */
export function withoutSupersededRedirects(
  refs: ReadonlyArray<BacklogRef>,
): ReadonlyArray<BacklogRef> {
  const live = new Set(
    refs.filter((ref) => ref.backlog.movedTo === undefined).map((ref) => ref.backlog.id),
  );
  return refs.filter((ref) => ref.backlog.movedTo === undefined || !live.has(ref.backlog.id));
}

/**
 * Machines a project board can move to: connected ones, other than its home, without a board
 * of their own for the repository. Only a live project board with a repository moves.
 */
export function boardHomeTargets(
  ref: BacklogRef,
  sources: ReadonlyArray<BacklogSource>,
): ReadonlyArray<BacklogSource> {
  const { backlog } = ref;
  if (backlog.kind !== "project" || backlog.repositoryKey === null) return [];
  if (backlog.movedTo !== undefined) return [];
  const home = sources.find((source) => source.environmentId === ref.environmentId);
  if (home === undefined || !isBacklogSourceWritable(home)) return [];
  return sources.filter(
    (source) =>
      source.environmentId !== ref.environmentId &&
      isBacklogSourceWritable(source) &&
      !(source.board?.backlogs ?? []).some(
        (other) =>
          other.movedTo === undefined &&
          (other.id === backlog.id || other.repositoryKey === backlog.repositoryKey),
      ),
  );
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
  /** Why there is no create target, in words for the add field. Null when there is one. */
  readonly createBlockedReason: string | null;
  /** The logical project's member checkouts, so a project page can link straight here. */
  readonly projectRefs: ReadonlyArray<{
    readonly environmentId: EnvironmentId;
    readonly projectId: ProjectId;
  }>;
  /**
   * Set for an Inbox a machine kept from before it was linked to a hub. Listed while it holds
   * open issues, with the action that moves them to the hub's Inbox.
   */
  readonly legacyInbox: { readonly environmentId: EnvironmentId; readonly hubLabel: string } | null;
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

type CreateResolution = Pick<BacklogSwitcherEntry, "createTarget" | "createBlockedReason">;

function joinLabels(labels: ReadonlyArray<string>): string {
  return [...new Set(labels)].join(", ");
}

/**
 * Where a project's next issue goes. An existing backlog wins. Without one, the server creates
 * it from a project id, which is only safe once every machine with a checkout has shown its
 * board: a machine still loading, or offline, may hold the backlog already, and creating here
 * would split the project across two boards.
 */
function resolveProjectCreate(input: {
  readonly backlogs: ReadonlyArray<BacklogRef>;
  readonly projectRefs: ReadonlyArray<{
    readonly environmentId: EnvironmentId;
    readonly projectId: ProjectId;
  }>;
  readonly sourceById: ReadonlyMap<EnvironmentId, BacklogSource>;
  readonly primaryEnvironmentId: EnvironmentId | null;
}): CreateResolution {
  const { sourceById, primaryEnvironmentId } = input;
  const writable = (environmentId: EnvironmentId) => {
    const source = sourceById.get(environmentId);
    return source !== undefined && isBacklogSourceWritable(source);
  };
  const label = (environmentId: EnvironmentId) =>
    sourceById.get(environmentId)?.label ?? "Unknown machine";
  const existing = preferPrimary(
    input.backlogs.filter((ref) => ref.backlog.movedTo === undefined),
    writable,
    primaryEnvironmentId,
  );
  if (existing) {
    return {
      createTarget: { environmentId: existing.environmentId, backlogId: existing.backlog.id },
      createBlockedReason: null,
    };
  }
  const moved = input.backlogs.find((ref) => ref.backlog.movedTo !== undefined);
  if (moved !== undefined && moved.backlog.movedTo !== undefined) {
    return {
      createTarget: null,
      createBlockedReason: `This board moved to ${moved.backlog.movedTo.label}, which is not connected.`,
    };
  }
  if (input.backlogs.length > 0) {
    const holders = input.backlogs.map((ref) => label(ref.environmentId));
    return {
      createTarget: null,
      createBlockedReason: `${joinLabels(holders)} ${holders.length > 1 ? "hold" : "holds"} this backlog and ${holders.length > 1 ? "are" : "is"} offline.`,
    };
  }
  // A machine this client does not subscribe to (disabled, or without Backlog) cannot block.
  const checkouts = [...new Set(input.projectRefs.map((ref) => ref.environmentId))].flatMap(
    (environmentId) => {
      const source = sourceById.get(environmentId);
      return source ? [source] : [];
    },
  );
  const loading = checkouts.filter((source) => source.status === "loading");
  if (loading.length > 0) {
    return {
      createTarget: null,
      createBlockedReason: `Loading ${joinLabels(loading.map((source) => source.label))}…`,
    };
  }
  const failed = checkouts.find((source) => source.status === "error");
  if (failed) {
    return {
      createTarget: null,
      createBlockedReason: `Could not read the backlog on ${failed.label}.`,
    };
  }
  const offline = checkouts.filter((source) => source.status !== "live");
  if (offline.length > 0) {
    return {
      createTarget: null,
      createBlockedReason: `${joinLabels(offline.map((source) => source.label))} may hold this backlog and ${offline.length > 1 ? "are" : "is"} offline.`,
    };
  }
  const own = preferPrimary(input.projectRefs, writable, primaryEnvironmentId);
  return own
    ? {
        createTarget: { environmentId: own.environmentId, projectId: own.projectId },
        createBlockedReason: null,
      }
    : { createTarget: null, createBlockedReason: "No machine with this project is connected." };
}

/**
 * Where an Inbox idea goes. With a hub there is one Inbox for every machine: the hub's, reached
 * directly or through a machine linked to it, which forwards the idea. Without one, the primary
 * machine's Inbox, else any connected machine's.
 */
function resolveInboxCreate(input: {
  readonly inboxes: ReadonlyArray<BacklogRef>;
  readonly fleet: BacklogFleet | null;
  readonly sources: ReadonlyArray<BacklogSource>;
  readonly sourceById: ReadonlyMap<EnvironmentId, BacklogSource>;
  readonly primaryEnvironmentId: EnvironmentId | null;
}): CreateResolution {
  const { fleet, sources, sourceById, primaryEnvironmentId } = input;
  const writable = (environmentId: EnvironmentId) => {
    const source = sourceById.get(environmentId);
    return source !== undefined && isBacklogSourceWritable(source);
  };
  if (fleet !== null) {
    const { hub } = fleet;
    if (writable(hub.environmentId)) {
      const hubInbox = input.inboxes.find((ref) => ref.environmentId === hub.environmentId);
      return {
        createTarget: hubInbox
          ? { environmentId: hub.environmentId, backlogId: hubInbox.backlog.id }
          : { environmentId: hub.environmentId },
        createBlockedReason: null,
      };
    }
    const spoke = preferPrimary(
      sources.filter((source) => fleet.spokeEnvironmentIds.has(source.environmentId)),
      writable,
      primaryEnvironmentId,
    );
    if (spoke)
      return { createTarget: { environmentId: spoke.environmentId }, createBlockedReason: null };
    return {
      createTarget: null,
      createBlockedReason:
        sourceById.get(hub.environmentId)?.status === "loading"
          ? `Loading ${hub.label}…`
          : `The Inbox lives on ${hub.label}, which is not connected.`,
    };
  }
  const primaryInbox = preferPrimary(input.inboxes, writable, primaryEnvironmentId);
  const inboxSource = preferPrimary(
    sources.filter((source) => source.board !== null),
    writable,
    primaryEnvironmentId,
  );
  const createTarget: BacklogCreateTarget | null = primaryInbox
    ? { environmentId: primaryInbox.environmentId, backlogId: primaryInbox.backlog.id }
    : inboxSource
      ? { environmentId: inboxSource.environmentId }
      : null;
  const loadingSources = sources.filter((source) => source.status === "loading");
  return {
    createTarget,
    createBlockedReason:
      createTarget !== null
        ? null
        : loadingSources.length > 0
          ? `Loading ${joinLabels(loadingSources.map((source) => source.label))}…`
          : "No connected machine can take a new issue.",
  };
}

/**
 * The switcher across every connected environment: All, one merged Inbox, then one entry per
 * logical project (the same repository on several machines is one project), then any backlog
 * whose project this client cannot see.
 */
export function buildBacklogSwitcher(
  input: BacklogSwitcherInput,
): ReadonlyArray<BacklogSwitcherEntry> {
  return withBacklogOpenCounts(buildBacklogSwitcherEntries(input), input.sources);
}

export interface BacklogSwitcherInput {
  readonly sources: ReadonlyArray<BacklogSource>;
  readonly projects: ReadonlyArray<Project>;
  readonly groupingSettings: ProjectGroupingSettings;
  readonly primaryEnvironmentId: EnvironmentId | null;
}

/**
 * Whether two source lists build the same switcher, open counts aside. Issue deltas keep each
 * board's `backlogs` array, so this holds for them and the grouping need not be rebuilt.
 */
export function sameBacklogSwitcherSources(
  previous: ReadonlyArray<BacklogSource>,
  next: ReadonlyArray<BacklogSource>,
): boolean {
  return (
    previous.length === next.length &&
    previous.every((source, index) => {
      const other = next[index]!;
      return (
        source.environmentId === other.environmentId &&
        source.label === other.label &&
        source.status === other.status &&
        (source.board === null) === (other.board === null) &&
        source.board?.linkedHub?.environmentId === other.board?.linkedHub?.environmentId &&
        source.board?.backlogs === other.board?.backlogs
      );
    })
  );
}

/**
 * Open issues per entry, one pass over every board. Entries whose count holds keep identity; a
 * legacy Inbox with nothing open is dropped.
 */
export function withBacklogOpenCounts(
  entries: ReadonlyArray<BacklogSwitcherEntry>,
  sources: ReadonlyArray<BacklogSource>,
): ReadonlyArray<BacklogSwitcherEntry> {
  const openByBacklog = new Map<string, number>();
  for (const source of sources) {
    for (const issue of source.board?.issues ?? []) {
      if (isBacklogStatusClosed(issue.status)) continue;
      const key = `${source.environmentId}:${issue.backlogId}`;
      openByBacklog.set(key, (openByBacklog.get(key) ?? 0) + 1);
    }
  }
  return entries.flatMap((entry) => {
    let openCount = 0;
    for (const ref of entry.backlogs) {
      openCount += openByBacklog.get(`${ref.environmentId}:${ref.backlog.id}`) ?? 0;
    }
    if (entry.legacyInbox !== null && openCount === 0) return [];
    return [openCount === entry.openCount ? entry : { ...entry, openCount }];
  });
}

/** The switcher without open counts: depends on backlogs and connection state, not issues. */
export function buildBacklogSwitcherEntries(
  input: BacklogSwitcherInput,
): ReadonlyArray<BacklogSwitcherEntry> {
  const { sources, primaryEnvironmentId } = input;
  const labelByEnvironment = new Map(sources.map((source) => [source.environmentId, source.label]));
  const sourceById = new Map(sources.map((source) => [source.environmentId, source]));

  const allBacklogs = withoutSupersededRedirects(
    sources.flatMap((source) =>
      (source.board?.backlogs ?? []).map((backlog) => ({
        environmentId: source.environmentId,
        backlog,
      })),
    ),
  );
  // An Inbox on a machine linked to a hub is legacy: the hub's is the one for every machine.
  const linkedHubOf = (environmentId: EnvironmentId) =>
    sourceById.get(environmentId)?.board?.linkedHub ?? null;
  const inboxRefs = allBacklogs.filter((ref) => ref.backlog.kind === "inbox");
  const inboxes = inboxRefs.filter((ref) => linkedHubOf(ref.environmentId) === null);
  const legacyInboxes = inboxRefs.filter((ref) => linkedHubOf(ref.environmentId) !== null);
  const inboxCreate = resolveInboxCreate({
    inboxes,
    fleet: backlogFleet(sources),
    sources,
    sourceById,
    primaryEnvironmentId,
  });

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
      openCount: 0,
      ...resolveProjectCreate({
        backlogs,
        projectRefs: group.memberProjectRefs,
        sourceById,
        primaryEnvironmentId,
      }),
      projectRefs: group.memberProjectRefs,
      legacyInbox: null,
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
    openCount: 0,
    ...resolveProjectCreate({ backlogs: [ref], projectRefs: [], sourceById, primaryEnvironmentId }),
    projectRefs: [],
    legacyInbox: null,
  }));

  const legacyEntries = legacyInboxes.map((ref): BacklogSwitcherEntry => {
    const hubLabel = linkedHubOf(ref.environmentId)?.label ?? "the hub";
    return {
      key: backlogScopeKey({
        kind: "backlog",
        environmentId: ref.environmentId,
        backlogId: ref.backlog.id,
      }),
      scope: { kind: "backlog", environmentId: ref.environmentId, backlogId: ref.backlog.id },
      label: `Inbox on ${labelByEnvironment.get(ref.environmentId) ?? "Unknown machine"} (legacy)`,
      machineLabel: null,
      backlogs: [ref],
      openCount: 0,
      createTarget: null,
      createBlockedReason: `New ideas go to the ${hubLabel} Inbox.`,
      projectRefs: [],
      legacyInbox: { environmentId: ref.environmentId, hubLabel },
    };
  });

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
      openCount: 0,
      ...inboxCreate,
      projectRefs: [],
      legacyInbox: null,
    },
    {
      key: "inbox",
      scope: { kind: "inbox" },
      label: "Inbox",
      machineLabel: null,
      backlogs: inboxes,
      openCount: 0,
      ...inboxCreate,
      projectRefs: [],
      legacyInbox: null,
    },
    ...legacyEntries,
    ...disambiguated,
  ];
}

/**
 * Projects on one machine that a move may target by project id, creating their backlog there:
 * those with no backlog anywhere yet, and only once every machine with a checkout has answered.
 */
export function creatableProjectIdsOn(
  entries: ReadonlyArray<BacklogSwitcherEntry>,
  environmentId: EnvironmentId,
): ReadonlySet<ProjectId> {
  const ids = new Set<ProjectId>();
  for (const entry of entries) {
    if (entry.scope.kind !== "project" || entry.backlogs.length > 0) continue;
    if (entry.createTarget?.projectId === undefined) continue;
    for (const ref of entry.projectRefs) {
      if (ref.environmentId === environmentId) ids.add(ref.projectId);
    }
  }
  return ids;
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

/**
 * Drops moves the server has answered: its row moved on, or already shows the status. Returns the
 * same map when nothing changed, so a state setter can skip the render.
 */
export function prunePendingBacklogMoves(
  pendingMoves: ReadonlyMap<string, PendingBacklogMove>,
  sources: ReadonlyArray<BacklogSource>,
): ReadonlyMap<string, PendingBacklogMove> {
  if (pendingMoves.size === 0) return pendingMoves;
  let next: Map<string, PendingBacklogMove> | null = null;
  for (const source of sources) {
    if (!source.board) continue;
    for (const issue of source.board.issues) {
      const key = boardIssueKey(source.environmentId, issue.id);
      const move = pendingMoves.get(key);
      if (!move) continue;
      if (issue.updatedAt === move.fromUpdatedAt && issue.status !== move.status) continue;
      next ??= new Map(pendingMoves);
      next.delete(key);
    }
  }
  return next ?? pendingMoves;
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

/** Closed columns grow forever, so they draw the newest few and page in the rest. */
export const CLOSED_COLUMN_PAGE = { initial: 30, step: 50 } as const;

export function pageBacklogColumn(
  column: BacklogColumn,
  limit: number,
): { readonly visible: ReadonlyArray<BoardIssue>; readonly hidden: number } {
  if (!isBacklogStatusClosed(column.status) || column.issues.length <= limit) {
    return { visible: column.issues, hidden: 0 };
  }
  return { visible: column.issues.slice(0, limit), hidden: column.issues.length - limit };
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
 * has no backlog yet (the server creates it on the move) when `creatableProjectIds` allows it.
 * Inbox first, then by name. A machine linked to a hub offers no Inbox: its own is legacy.
 */
export function backlogMoveTargets(input: {
  readonly currentBacklogId: BacklogId;
  readonly backlogs: ReadonlyArray<Backlog>;
  readonly inboxIsLegacy?: boolean;
  readonly projects: ReadonlyArray<Pick<Project, "id" | "title">>;
  readonly creatableProjectIds: ReadonlySet<ProjectId>;
}): ReadonlyArray<BacklogMoveTarget> {
  const projectsWithBacklog = new Set(input.backlogs.map((backlog) => backlog.projectId));
  const existing = input.backlogs
    .filter(
      (backlog) =>
        backlog.id !== input.currentBacklogId &&
        backlog.movedTo === undefined &&
        !(input.inboxIsLegacy === true && backlog.kind === "inbox"),
    )
    .map((backlog): BacklogMoveTarget => ({
      value: `backlog:${backlog.id}`,
      label: backlog.kind === "inbox" ? "Inbox" : `${backlog.title} (${backlog.key})`,
      input: { backlogId: backlog.id },
    }));
  const fresh = input.projects
    .filter(
      (project) =>
        !projectsWithBacklog.has(project.id) && input.creatableProjectIds.has(project.id),
    )
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
