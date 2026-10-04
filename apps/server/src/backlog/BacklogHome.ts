import type {
  Backlog,
  BacklogActivity,
  BacklogActor,
  BacklogClaimInput,
  BacklogClaimNextInput,
  BacklogClaimResult,
  BacklogCommentInput,
  BacklogCreateChildrenInput,
  BacklogCreateIssueInput,
  BacklogError,
  BacklogGetIssueInput,
  BacklogIssue,
  BacklogIssueDetail,
  BacklogIssueId,
  BacklogLinkPullRequestInput,
  BacklogListIssuesInput,
  BacklogReleaseInput,
  BacklogUpdateIssueInput,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import type { BacklogService } from "./BacklogService.ts";

/**
 * One environment's backlogs as an agent tool sees them: this environment's
 * service, or the hub's over the fleet link. Everything one call touches lives
 * on one home.
 */
export interface BacklogHome {
  readonly listBacklogs: () => Effect.Effect<ReadonlyArray<Backlog>, BacklogError>;
  readonly listIssues: (
    input: BacklogListIssuesInput,
  ) => Effect.Effect<ReadonlyArray<BacklogIssue>, BacklogError>;
  /** Accepts an issue id or a key such as WINE-12. */
  readonly resolveIssue: (ref: string) => Effect.Effect<BacklogIssueId, BacklogError>;
  readonly getIssue: (
    input: BacklogGetIssueInput,
  ) => Effect.Effect<BacklogIssueDetail, BacklogError>;
  readonly createIssue: (
    input: BacklogCreateIssueInput,
    actor: BacklogActor,
  ) => Effect.Effect<BacklogIssue, BacklogError>;
  readonly createChildren: (
    input: BacklogCreateChildrenInput,
    actor: BacklogActor,
  ) => Effect.Effect<ReadonlyArray<BacklogIssue>, BacklogError>;
  readonly updateIssue: (
    input: BacklogUpdateIssueInput,
    actor: BacklogActor,
  ) => Effect.Effect<BacklogIssue, BacklogError>;
  readonly comment: (
    input: BacklogCommentInput,
    actor: BacklogActor,
  ) => Effect.Effect<BacklogActivity, BacklogError>;
  readonly claim: (
    input: BacklogClaimInput,
    actor: BacklogActor,
  ) => Effect.Effect<BacklogClaimResult, BacklogError>;
  readonly claimNext: (
    input: BacklogClaimNextInput,
    actor: BacklogActor,
  ) => Effect.Effect<BacklogClaimResult | null, BacklogError>;
  readonly release: (
    input: BacklogReleaseInput,
    actor: BacklogActor,
  ) => Effect.Effect<BacklogIssue, BacklogError>;
  /** With an issue, links that issue; without, every issue the actor's thread holds. */
  readonly linkPullRequest: (
    input: BacklogLinkPullRequestInput,
    actor: BacklogActor,
  ) => Effect.Effect<ReadonlyArray<BacklogIssue>, BacklogError>;
}

/** This environment's own backlog service as a home. */
export const localBacklogHome = (service: BacklogService["Service"]): BacklogHome => ({
  listBacklogs: service.listBacklogs,
  listIssues: service.listIssues,
  resolveIssue: service.resolveIssueRef,
  getIssue: service.getIssue,
  createIssue: service.createIssue,
  createChildren: service.createChildren,
  updateIssue: service.updateIssue,
  comment: service.comment,
  claim: service.claim,
  claimNext: service.claimNext,
  release: service.release,
  linkPullRequest: ({ url, issueId }, actor) =>
    issueId === undefined
      ? service.linkPullRequestToClaims({ url }, actor)
      : service
          .addLink({ issueId, link: { type: "pull_request", url } }, actor)
          .pipe(Effect.map((issue) => [issue])),
});
