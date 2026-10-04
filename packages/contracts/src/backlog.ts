import * as Schema from "effect/Schema";

import {
  BacklogId,
  BacklogIssueId,
  EnvironmentId,
  IsoDateTime,
  ProjectId,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";

/** Lease length for an agent's claim; renewed while the claiming thread is alive. */
export const BACKLOG_CLAIM_LEASE_MS = 15 * 60_000;

export const BacklogIssueStatus = Schema.Literals([
  "inbox",
  "backlog",
  "ready",
  "in_progress",
  "review",
  "done",
  "wontfix",
]).annotate({
  description:
    "Board column. inbox: untriaged; backlog: accepted, not ready; ready: may be claimed; in_progress: claimed or being worked; review: work done, awaiting a human; done and wontfix: closed.",
});
export type BacklogIssueStatus = typeof BacklogIssueStatus.Type;

export const BACKLOG_ISSUE_STATUSES = BacklogIssueStatus.literals;
export const BACKLOG_CLOSED_STATUSES: ReadonlyArray<BacklogIssueStatus> = ["done", "wontfix"];

export const BacklogIssueType = Schema.Literals(["idea", "bug", "feature"]).annotate({
  description: "Issue type. Defaults to idea.",
});
export type BacklogIssueType = typeof BacklogIssueType.Type;

export const BacklogIssuePriority = Schema.Literals(["p0", "p1", "p2", "p3"]).annotate({
  description: "Priority, p0 most urgent. Null means unprioritized.",
});
export type BacklogIssuePriority = typeof BacklogIssuePriority.Type;

/** Short human key for a backlog, such as WINE. Issue keys append the number: WINE-12. */
export const BacklogKey = TrimmedNonEmptyString.check(
  Schema.isPattern(/^[A-Z][A-Z0-9]{0,9}$/),
).annotate({
  description: "Uppercase short key, 1-10 characters, starting with a letter. Example: WINE.",
});
export type BacklogKey = typeof BacklogKey.Type;

/** Who did something on a backlog. Agents carry their thread; users do not. */
export const BacklogActor = Schema.Struct({
  kind: Schema.Literals(["user", "agent", "system"]),
  environmentId: Schema.NullOr(EnvironmentId),
  threadId: Schema.NullOr(ThreadId),
  label: Schema.String,
});
export type BacklogActor = typeof BacklogActor.Type;

/** Where a backlog went when its home moved to another environment. */
export const BacklogMovedTo = Schema.Struct({
  environmentId: EnvironmentId,
  label: Schema.String,
  movedAt: IsoDateTime,
});
export type BacklogMovedTo = typeof BacklogMovedTo.Type;

export const Backlog = Schema.Struct({
  id: BacklogId,
  kind: Schema.Literals(["inbox", "project"]),
  key: BacklogKey,
  title: TrimmedNonEmptyString,
  /** Null for the Inbox. */
  projectId: Schema.NullOr(ProjectId),
  /**
   * The project's repository canonicalKey when it has one. Project ids are local to an
   * environment; this is how other machines find the backlog for the same repository.
   */
  repositoryKey: Schema.NullOr(TrimmedNonEmptyString),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  /**
   * Set once the backlog moved to another environment. This copy stays as a
   * read-only redirect; the board lives on there. Absent while it lives here.
   */
  movedTo: Schema.optional(BacklogMovedTo),
});
export type Backlog = typeof Backlog.Type;

export const BacklogIssueClaim = Schema.Struct({
  actor: BacklogActor,
  claimedAt: IsoDateTime,
  leaseExpiresAt: IsoDateTime,
});
export type BacklogIssueClaim = typeof BacklogIssueClaim.Type;

export const BacklogIssueLink = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("thread"),
    environmentId: Schema.NullOr(EnvironmentId),
    threadId: ThreadId,
  }),
  Schema.Struct({
    type: Schema.Literal("pull_request"),
    url: TrimmedNonEmptyString,
  }),
]);
export type BacklogIssueLink = typeof BacklogIssueLink.Type;

/**
 * Board row. Carries everything a board, list or graph needs, but not the
 * body, which can be a long spec; fetch it with `backlog.getIssue`.
 */
export const BacklogIssue = Schema.Struct({
  id: BacklogIssueId,
  backlogId: BacklogId,
  number: Schema.Int.check(Schema.isGreaterThan(0)),
  /** Display key such as WINE-12. Follows the backlog key when it is edited. */
  key: TrimmedNonEmptyString,
  title: TrimmedNonEmptyString,
  type: BacklogIssueType,
  status: BacklogIssueStatus,
  priority: Schema.NullOr(BacklogIssuePriority),
  parentId: Schema.NullOr(BacklogIssueId),
  blockedBy: Schema.Array(BacklogIssueId),
  claim: Schema.NullOr(BacklogIssueClaim),
  links: Schema.Array(BacklogIssueLink),
  hasBody: Schema.Boolean,
  createdBy: BacklogActor,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  closedAt: Schema.NullOr(IsoDateTime),
});
export type BacklogIssue = typeof BacklogIssue.Type;

export const BacklogActivityKind = Schema.Literals([
  "created",
  "edited",
  "status_changed",
  "moved",
  "claimed",
  "released",
  "lease_expired",
  "commented",
  "linked",
]);
export type BacklogActivityKind = typeof BacklogActivityKind.Type;

export const BacklogActivity = Schema.Struct({
  id: TrimmedNonEmptyString,
  issueId: BacklogIssueId,
  kind: BacklogActivityKind,
  actor: BacklogActor,
  at: IsoDateTime,
  /** Comment text, or a short human summary for non-comment entries. */
  text: Schema.NullOr(Schema.String),
  fromStatus: Schema.NullOr(BacklogIssueStatus),
  toStatus: Schema.NullOr(BacklogIssueStatus),
});
export type BacklogActivity = typeof BacklogActivity.Type;

export const BacklogIssueDetail = Schema.Struct({
  issue: BacklogIssue,
  body: Schema.String,
  /** The parent spec, so an agent claiming a child has the context. */
  parent: Schema.NullOr(
    Schema.Struct({
      issue: BacklogIssue,
      body: Schema.String,
    }),
  ),
  children: Schema.Array(BacklogIssue),
  blockers: Schema.Array(BacklogIssue),
  activity: Schema.Array(BacklogActivity),
});
export type BacklogIssueDetail = typeof BacklogIssueDetail.Type;

/**
 * Why a backlog on another machine could not be reached. not_linked: this
 * machine has no hub link; protocol_mismatch: the hub runs a build without the
 * backlog link.
 */
export const BacklogUnavailableReason = Schema.Literals([
  "unreachable",
  "unauthorized",
  "protocol_mismatch",
  "not_linked",
]);
export type BacklogUnavailableReason = typeof BacklogUnavailableReason.Type;

/**
 * A claimed issue's detail. alreadyHeld is true when this thread already held
 * the claim: the call only renewed it. Agents sharing one thread (a provider's
 * built-in subagents) cannot tell each other apart, so seeing it unexpectedly
 * means another worker in this thread has the issue.
 */
export const BacklogClaimResult = Schema.Struct({
  ...BacklogIssueDetail.fields,
  alreadyHeld: Schema.Boolean,
});
export type BacklogClaimResult = typeof BacklogClaimResult.Type;

export class BacklogError extends Schema.TaggedError<BacklogError>()("BacklogError", {
  code: Schema.Literals(["not_found", "conflict", "invalid", "unavailable"]),
  message: Schema.String,
  issueId: Schema.optional(BacklogIssueId),
  /** Set with code unavailable. */
  reason: Schema.optional(BacklogUnavailableReason),
  /** Set with code conflict when the backlog moved to another environment. */
  movedTo: Schema.optional(BacklogMovedTo),
  cause: Schema.optional(Schema.Defect()),
}) {}

// Stream

export const BacklogStreamEvent = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("snapshot"),
    backlogs: Schema.Array(Backlog),
    issues: Schema.Array(BacklogIssue),
  }),
  Schema.Struct({ type: Schema.Literal("backlogUpserted"), backlog: Backlog }),
  Schema.Struct({ type: Schema.Literal("issueUpserted"), issue: BacklogIssue }),
]);
export type BacklogStreamEvent = typeof BacklogStreamEvent.Type;

// Inputs

export const BacklogSubscribeInput = Schema.Struct({});
export type BacklogSubscribeInput = typeof BacklogSubscribeInput.Type;

export const BacklogGetIssueInput = Schema.Struct({ issueId: BacklogIssueId });
export type BacklogGetIssueInput = typeof BacklogGetIssueInput.Type;

/**
 * Set by a linked server acting for one of its agents. Clients omit it and act
 * as this environment's user.
 */
const ActingActor = Schema.optional(BacklogActor);

/**
 * A backlog addressed by repository rather than by project: project ids are
 * local to one environment, so a linked server names the repository instead.
 * The hub uses its backlog for that repository, creating it on first use.
 */
export const BacklogRepositoryTarget = Schema.Struct({
  key: TrimmedNonEmptyString.annotate({ description: "The repository's canonicalKey." }),
  title: TrimmedNonEmptyString.annotate({ description: "Title for a newly created backlog." }),
});
export type BacklogRepositoryTarget = typeof BacklogRepositoryTarget.Type;

export const BacklogCreateIssueInput = Schema.Struct({
  backlogId: Schema.optional(BacklogId).annotate({
    description: "Target backlog. Takes precedence over projectId.",
  }),
  projectId: Schema.optional(ProjectId).annotate({
    description:
      "Target the project's backlog, creating it on first use. Omit both backlogId and projectId for the Inbox.",
  }),
  repository: Schema.optional(BacklogRepositoryTarget).annotate({
    description:
      "Target the repository's backlog. Used when neither backlogId nor projectId is set.",
  }),
  title: TrimmedNonEmptyString,
  body: Schema.optional(Schema.String).annotate({ description: "Markdown body." }),
  type: Schema.optional(BacklogIssueType),
  status: Schema.optional(BacklogIssueStatus).annotate({
    description: "Defaults to inbox in the Inbox and backlog in a project backlog.",
  }),
  priority: Schema.optional(Schema.NullOr(BacklogIssuePriority)),
  parentId: Schema.optional(Schema.NullOr(BacklogIssueId)),
  blockedBy: Schema.optional(Schema.Array(BacklogIssueId)),
  actor: ActingActor,
});
export type BacklogCreateIssueInput = typeof BacklogCreateIssueInput.Type;

/** Omitted fields are preserved. */
export const BacklogUpdateIssueInput = Schema.Struct({
  issueId: BacklogIssueId,
  title: Schema.optional(TrimmedNonEmptyString),
  body: Schema.optional(Schema.String),
  type: Schema.optional(BacklogIssueType),
  status: Schema.optional(BacklogIssueStatus),
  priority: Schema.optional(Schema.NullOr(BacklogIssuePriority)),
  parentId: Schema.optional(Schema.NullOr(BacklogIssueId)),
  blockedBy: Schema.optional(Schema.Array(BacklogIssueId)).annotate({
    description: "Replaces the full blocker list.",
  }),
  backlogId: Schema.optional(BacklogId).annotate({
    description: "Move the issue to another backlog, e.g. triaging from the Inbox to a project.",
  }),
  projectId: Schema.optional(ProjectId).annotate({
    description:
      "Move the issue to this project's backlog, creating it on first use. Ignored when backlogId is set.",
  }),
  repository: Schema.optional(BacklogRepositoryTarget).annotate({
    description:
      "Move the issue to the repository's backlog. Ignored when backlogId or projectId is set.",
  }),
  actor: ActingActor,
});
export type BacklogUpdateIssueInput = typeof BacklogUpdateIssueInput.Type;

export const BacklogCommentInput = Schema.Struct({
  issueId: BacklogIssueId,
  text: TrimmedNonEmptyString,
  actor: ActingActor,
});
export type BacklogCommentInput = typeof BacklogCommentInput.Type;

export const BacklogReleaseStatus = Schema.Literals(["ready", "review", "done", "backlog"]);
export type BacklogReleaseStatus = typeof BacklogReleaseStatus.Type;

/** From a client this is a force-release: it clears any holder's claim. */
export const BacklogReleaseInput = Schema.Struct({
  issueId: BacklogIssueId,
  status: BacklogReleaseStatus,
  note: Schema.optional(Schema.String),
  actor: ActingActor,
});
export type BacklogReleaseInput = typeof BacklogReleaseInput.Type;

export const BacklogUpdateBacklogInput = Schema.Struct({
  backlogId: BacklogId,
  key: Schema.optional(BacklogKey),
  title: Schema.optional(TrimmedNonEmptyString),
});
export type BacklogUpdateBacklogInput = typeof BacklogUpdateBacklogInput.Type;

export const BacklogListIssuesInput = Schema.Struct({
  backlogId: Schema.optional(BacklogId),
  status: Schema.optional(Schema.Array(BacklogIssueStatus)),
  type: Schema.optional(BacklogIssueType),
  parentId: Schema.optional(BacklogIssueId),
  /** Only ready, unblocked, unclaimed issues. */
  frontierOnly: Schema.optional(Schema.Boolean),
});
export type BacklogListIssuesInput = typeof BacklogListIssuesInput.Type;

export const BacklogResolveIssueInput = Schema.Struct({
  ref: TrimmedNonEmptyString.annotate({ description: "An issue id or a key such as WINE-12." }),
});
export type BacklogResolveIssueInput = typeof BacklogResolveIssueInput.Type;

export const BacklogChildInput = Schema.Struct({
  title: TrimmedNonEmptyString,
  body: Schema.optional(Schema.String),
  type: Schema.optional(BacklogIssueType),
  priority: Schema.optional(Schema.NullOr(BacklogIssuePriority)),
  status: Schema.optional(BacklogIssueStatus),
  /** Zero-based indexes of sibling children in the same batch that block this one. */
  blockedBySiblings: Schema.optional(Schema.Array(Schema.Int)),
  /** Existing issues that block this one. */
  blockedBy: Schema.optional(Schema.Array(BacklogIssueId)),
});
export type BacklogChildInput = typeof BacklogChildInput.Type;

export const BacklogCreateChildrenInput = Schema.Struct({
  parentId: BacklogIssueId,
  children: Schema.Array(BacklogChildInput),
  actor: ActingActor,
});
export type BacklogCreateChildrenInput = typeof BacklogCreateChildrenInput.Type;

export const BacklogClaimInput = Schema.Struct({
  issueId: BacklogIssueId,
  actor: ActingActor,
});
export type BacklogClaimInput = typeof BacklogClaimInput.Type;

export const BacklogClaimNextInput = Schema.Struct({
  backlogId: Schema.optional(BacklogId),
  parentId: Schema.optional(BacklogIssueId),
  type: Schema.optional(BacklogIssueType),
  actor: ActingActor,
});
export type BacklogClaimNextInput = typeof BacklogClaimNextInput.Type;

/** Extends every lease those threads of that environment hold. */
export const BacklogRenewClaimsInput = Schema.Struct({
  environmentId: Schema.NullOr(EnvironmentId),
  threadIds: Schema.Array(ThreadId),
});
export type BacklogRenewClaimsInput = typeof BacklogRenewClaimsInput.Type;

/** Links a pull request to one issue, or to every issue the actor's thread holds. */
export const BacklogLinkPullRequestInput = Schema.Struct({
  url: TrimmedNonEmptyString,
  issueId: Schema.optional(BacklogIssueId),
  actor: ActingActor,
});
export type BacklogLinkPullRequestInput = typeof BacklogLinkPullRequestInput.Type;

// Moving a backlog's home: export from the current home (which freezes it as
// moved), import on the target, and restore the original if the import fails.

/** One issue as it travels between environments: the board row plus its body. */
export const BacklogExportIssue = Schema.Struct({
  ...BacklogIssue.fields,
  body: Schema.String,
});
export type BacklogExportIssue = typeof BacklogExportIssue.Type;

/** Everything a backlog holds. Ids are global, so the target keeps them, numbers and keys. */
export const BacklogExport = Schema.Struct({
  backlog: Backlog,
  /** The number the next new issue takes. */
  nextNumber: Schema.Int.check(Schema.isGreaterThan(0)),
  issues: Schema.Array(BacklogExportIssue),
  activity: Schema.Array(BacklogActivity),
});
export type BacklogExport = typeof BacklogExport.Type;

export const BacklogExportInput = Schema.Struct({
  backlogId: BacklogId,
  /** The environment receiving it; this copy becomes a read-only redirect there. */
  to: Schema.Struct({ environmentId: EnvironmentId, label: Schema.String }),
});
export type BacklogExportInput = typeof BacklogExportInput.Type;

export const BacklogImportInput = Schema.Struct({ export: BacklogExport });
export type BacklogImportInput = typeof BacklogImportInput.Type;

/** Undoes an export whose import did not finish: the backlog lives here again. */
export const BacklogRestoreInput = Schema.Struct({ backlogId: BacklogId });
export type BacklogRestoreInput = typeof BacklogRestoreInput.Type;

// Fleet link: one environment (the spoke) links to another (the hub), whose
// backlogs its agents then reach through their backlog tools.

export const BacklogHubLinkStatus = Schema.Struct({
  /**
   * not_linked: no hub. connected: the last call reached the hub.
   * disconnected: linked, but the hub could not be reached; see error.
   */
  state: Schema.Literals(["not_linked", "connected", "disconnected"]),
  hub: Schema.NullOr(
    Schema.Struct({
      environmentId: EnvironmentId,
      label: Schema.String,
      httpBaseUrl: TrimmedNonEmptyString,
      linkedAt: IsoDateTime,
      expiresAt: IsoDateTime,
    }),
  ),
  error: Schema.NullOr(Schema.Struct({ reason: BacklogUnavailableReason, message: Schema.String })),
});
export type BacklogHubLinkStatus = typeof BacklogHubLinkStatus.Type;

export const BacklogLinkHubInput = Schema.Struct({
  pairingUrl: TrimmedNonEmptyString.annotate({
    description: "A pairing URL minted on the hub with the backlog link permissions.",
  }),
});
export type BacklogLinkHubInput = typeof BacklogLinkHubInput.Type;

// Derived helpers shared by server and clients.

/** The message for any change to a backlog that moved away. */
export function backlogMovedMessage(backlog: Pick<Backlog, "key" | "movedTo">): string {
  return backlog.movedTo === undefined
    ? `${backlog.key} lives here.`
    : `${backlog.key} moved to ${backlog.movedTo.label}. This copy is read-only; use the board there.`;
}

export function isBacklogStatusClosed(status: BacklogIssueStatus): boolean {
  return status === "done" || status === "wontfix";
}

/** Blocked while any blocker is still open. Unknown blockers count as open. */
export function isBacklogIssueBlocked(
  issue: Pick<BacklogIssue, "blockedBy">,
  issuesById: ReadonlyMap<BacklogIssueId, Pick<BacklogIssue, "status">>,
): boolean {
  return issue.blockedBy.some((blockerId) => {
    const blocker = issuesById.get(blockerId);
    return blocker === undefined || !isBacklogStatusClosed(blocker.status);
  });
}

/** The frontier: ready, unblocked and unclaimed. The only issues an agent may claim. */
export function isBacklogIssueOnFrontier(
  issue: Pick<BacklogIssue, "status" | "blockedBy" | "claim">,
  issuesById: ReadonlyMap<BacklogIssueId, Pick<BacklogIssue, "status">>,
): boolean {
  return (
    issue.status === "ready" && issue.claim === null && !isBacklogIssueBlocked(issue, issuesById)
  );
}

const PRIORITY_RANK: Record<BacklogIssuePriority, number> = { p0: 0, p1: 1, p2: 2, p3: 3 };

/** Claim-next order: priority first (unprioritized last), then oldest first, then number. */
export function compareBacklogIssuesForClaim(
  left: Pick<BacklogIssue, "priority" | "createdAt" | "number">,
  right: Pick<BacklogIssue, "priority" | "createdAt" | "number">,
): number {
  const leftRank = left.priority === null ? 4 : PRIORITY_RANK[left.priority];
  const rightRank = right.priority === null ? 4 : PRIORITY_RANK[right.priority];
  if (leftRank !== rightRank) return leftRank - rightRank;
  if (left.createdAt !== right.createdAt) return left.createdAt < right.createdAt ? -1 : 1;
  return left.number - right.number;
}

/** Derive a short key from a project title: "Cork & Note" -> "CN", "wine" -> "WINE". */
export function deriveBacklogKey(title: string): string {
  const words = title
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, " ")
    .trim()
    .split(" ")
    .filter((word) => word.length > 0);
  const lettersOnly = words.filter((word) => /^[A-Z]/.test(word));
  if (lettersOnly.length === 0) return "PROJ";
  const key =
    lettersOnly.length === 1
      ? lettersOnly[0]!.slice(0, 6)
      : lettersOnly
          .map((word) => word[0])
          .join("")
          .slice(0, 6);
  return key.length >= 2 ? key : lettersOnly[0]!.slice(0, 4);
}

/** Parse "wine-12" or "WINE-12" into its parts. */
export function parseBacklogIssueKey(
  value: string,
): { readonly backlogKey: string; readonly number: number } | null {
  const match = /^\s*([A-Za-z][A-Za-z0-9]{0,9})-(\d+)\s*$/.exec(value);
  if (match === null) return null;
  const number = Number(match[2]);
  return Number.isSafeInteger(number) && number > 0
    ? { backlogKey: match[1]!.toUpperCase(), number }
    : null;
}
