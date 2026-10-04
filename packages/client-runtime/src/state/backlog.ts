import {
  BACKLOG_ISSUE_STATUSES,
  WS_METHODS,
  isBacklogIssueBlocked,
  type Backlog,
  type BacklogId,
  type BacklogIssue,
  type BacklogIssueId,
  type BacklogIssueStatus,
  type BacklogStreamEvent,
  type EnvironmentId,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import { AsyncResult, Atom, AtomRegistry } from "effect/unstable/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import {
  createAtomCommandScheduler,
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
  createEnvironmentRpcSubscriptionAtomFamily,
} from "./runtime.ts";

/** One environment's backlogs, folded from the `backlog.subscribe` snapshot and its deltas. */
export interface BacklogBoardState {
  readonly backlogs: ReadonlyArray<Backlog>;
  readonly issues: ReadonlyArray<BacklogIssue>;
  readonly issuesById: ReadonlyMap<BacklogIssueId, BacklogIssue>;
}

export const EMPTY_BACKLOG_BOARD: BacklogBoardState = {
  backlogs: [],
  issues: [],
  issuesById: new Map(),
};

function fromIssues(
  backlogs: ReadonlyArray<Backlog>,
  issues: ReadonlyArray<BacklogIssue>,
): BacklogBoardState {
  return { backlogs, issues, issuesById: new Map(issues.map((issue) => [issue.id, issue])) };
}

/** Apply one stream event. Unchanged slices keep their identity so selectors stay cheap. */
export function foldBacklogStreamEvent(
  state: BacklogBoardState,
  event: BacklogStreamEvent,
): BacklogBoardState {
  switch (event.type) {
    case "snapshot":
      return fromIssues(event.backlogs, event.issues);
    case "backlogUpserted": {
      const index = state.backlogs.findIndex((backlog) => backlog.id === event.backlog.id);
      const backlogs =
        index === -1
          ? [...state.backlogs, event.backlog]
          : state.backlogs.map((backlog, i) => (i === index ? event.backlog : backlog));
      return { ...state, backlogs };
    }
    case "issueUpserted": {
      const exists = state.issuesById.has(event.issue.id);
      const issues = exists
        ? state.issues.map((issue) => (issue.id === event.issue.id ? event.issue : issue))
        : [...state.issues, event.issue];
      const issuesById = new Map(state.issuesById);
      issuesById.set(event.issue.id, event.issue);
      return { ...state, issues, issuesById };
    }
  }
}

export function issuesForBacklog(
  state: BacklogBoardState,
  backlogId: BacklogId,
): ReadonlyArray<BacklogIssue> {
  return state.issues.filter((issue) => issue.backlogId === backlogId);
}

/** Group issues into board columns in status order; each column newest-updated first. */
export function groupBacklogIssuesByStatus(
  issues: ReadonlyArray<BacklogIssue>,
): ReadonlyMap<BacklogIssueStatus, ReadonlyArray<BacklogIssue>> {
  const groups = new Map<BacklogIssueStatus, BacklogIssue[]>(
    BACKLOG_ISSUE_STATUSES.map((status) => [status, []]),
  );
  for (const issue of issues) groups.get(issue.status)?.push(issue);
  for (const column of groups.values()) {
    column.sort((left, right) =>
      left.updatedAt === right.updatedAt
        ? right.number - left.number
        : left.updatedAt < right.updatedAt
          ? 1
          : -1,
    );
  }
  return groups;
}

/**
 * The question to ask before a client changes a claimed issue's status, or null when nobody holds
 * it. Force-releasing is the explicit override and does not ask.
 */
export function claimTakeoverMessage(issue: Pick<BacklogIssue, "key" | "claim">): string | null {
  if (issue.claim === null) return null;
  const holder = issue.claim.actor.label.trim() || "the agent holding it";
  return `This takes ${issue.key} away from ${holder}. Continue?`;
}

export function isIssueBlockedOnBoard(state: BacklogBoardState, issue: BacklogIssue): boolean {
  return isBacklogIssueBlocked(issue, state.issuesById);
}

const UNKNOWN_BACKLOG_RPC = /Unknown request tag: backlog\./;

/**
 * Whether a backlog RPC failed because the server predates Backlog. Effect's RpcServer answers an
 * unknown tag with a defect, "Unknown request tag: backlog.subscribe", so an older or upstream
 * server reads as unsupported rather than broken.
 */
export function isBacklogUnsupportedCause(cause: Cause.Cause<unknown>): boolean {
  return cause.reasons.some((reason) => {
    if (!Cause.isDieReason(reason)) return false;
    const defect = reason.defect;
    const message =
      typeof defect === "string" ? defect : defect instanceof Error ? defect.message : null;
    return message !== null && UNKNOWN_BACKLOG_RPC.test(message);
  });
}

export function createBacklogEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  const scheduler = createAtomCommandScheduler();
  const serialPerEnvironment = {
    mode: "serial",
    key: ({ environmentId }: { readonly environmentId: string }) => environmentId,
  } as const;

  /** Live board for one environment: every backlog and issue it hosts. */
  const board = createEnvironmentRpcSubscriptionAtomFamily(runtime, {
    label: "environment-data:backlog:board",
    tag: WS_METHODS.backlogSubscribe,
    // Drop scan's seed so the board stays loading until the snapshot, never falsely empty.
    transform: (stream) =>
      stream.pipe(Stream.scan(EMPTY_BACKLOG_BOARD, foldBacklogStreamEvent), Stream.drop(1)),
  });

  /** Changes whenever the issue's row changes, so its detail refetches. */
  const issueVersion = Atom.family((key: string) => {
    const [environmentId, issueId] = JSON.parse(key) as [EnvironmentId, BacklogIssueId];
    return Atom.make((get) => {
      const result = get(board({ environmentId, input: {} }));
      return Option.match(AsyncResult.value(result), {
        onNone: () => null,
        onSome: (state) => state.issuesById.get(issueId)?.updatedAt ?? null,
      });
    });
  });

  const issueDetail = createEnvironmentRpcQueryAtomFamily(runtime, {
    label: "environment-data:backlog:issue-detail",
    tag: WS_METHODS.backlogGetIssue,
    staleTimeMs: 0,
    refreshTrigger: ({ environmentId, input }) =>
      issueVersion(JSON.stringify([environmentId, input.issueId])),
  });

  /** The environment's backlog hub link, probed on read so the state is current. */
  const hubLink = createEnvironmentRpcQueryAtomFamily(runtime, {
    label: "environment-data:backlog:hub-link",
    tag: WS_METHODS.backlogGetHubLink,
    staleTimeMs: 0,
  });
  const refreshHubLink = (
    { environmentId }: { readonly environmentId: EnvironmentId },
    registry: AtomRegistry.AtomRegistry,
  ) => Effect.sync(() => registry.refresh(hubLink({ environmentId, input: {} })));

  return {
    board,
    issueDetail,
    hubLink,
    linkHub: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:backlog:link-hub",
      tag: WS_METHODS.backlogLinkHub,
      scheduler,
      concurrency: serialPerEnvironment,
      onSuccess: refreshHubLink,
    }),
    unlinkHub: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:backlog:unlink-hub",
      tag: WS_METHODS.backlogUnlinkHub,
      scheduler,
      concurrency: serialPerEnvironment,
      onSuccess: refreshHubLink,
    }),
    createIssue: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:backlog:create-issue",
      tag: WS_METHODS.backlogCreateIssue,
      scheduler,
      concurrency: serialPerEnvironment,
    }),
    updateIssue: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:backlog:update-issue",
      tag: WS_METHODS.backlogUpdateIssue,
      scheduler,
      concurrency: serialPerEnvironment,
    }),
    comment: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:backlog:comment",
      tag: WS_METHODS.backlogComment,
      scheduler,
      concurrency: serialPerEnvironment,
    }),
    release: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:backlog:release",
      tag: WS_METHODS.backlogRelease,
      scheduler,
      concurrency: serialPerEnvironment,
    }),
    updateBacklog: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:backlog:update-backlog",
      tag: WS_METHODS.backlogUpdateBacklog,
      scheduler,
      concurrency: serialPerEnvironment,
    }),
  };
}
