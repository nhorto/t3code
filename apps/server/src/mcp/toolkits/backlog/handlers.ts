import type { BacklogActor, BacklogError, BacklogId, ProjectId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import * as BacklogService from "../../../backlog/BacklogService.ts";
import { readCaller } from "../../threadAccess.ts";
import { BacklogToolkit } from "./tools.ts";

export const BACKLOG_PLAYBOOK = `# Backlog playbook

Plan in one place, then let agents work the frontier. Each backlog issue is either a spec (a parent) or one tracer-bullet slice of it (a child).

## Plan

1. Align first. Interview the user until you both agree on the problem, the outcome, and what is out of scope. Do not break work down before that.
2. Write one spec as a parent issue (backlog_create_issue, or backlog_update_issue on the issue the user pasted). The body says the problem, the solution, the decisions taken, and the test seams you agreed on.
3. Break the spec into children with backlog_create_children. Each child is a tracer bullet: a complete vertical path through every layer it touches, demoable on its own, small enough for one agent's context window. Prefer thin end-to-end slices over horizontal layers ("schema", "API", "UI").
4. Add blocking edges only where a slice truly needs another first (blockedBySiblings). Children are not implicitly ordered; unblocked slices can run in parallel.
5. Show the user the breakdown (keys, titles, edges) and wait for approval. Then move the approved children to ready with backlog_update_issue.

## Work the frontier

- The frontier is every ready, unblocked, unclaimed issue (backlog_list_issues with frontierOnly). Only frontier issues can be claimed.
- Fan out: give each subagent one issue. The subagent claims it itself (backlog_claim with the key, or backlog_claim_next with parent set to the spec), so the claim belongs to the thread doing the work. A conflict means another agent has it; take a different one.
- The claim response carries the parent's spec; read it before starting.
- Implement red to green at the agreed test seams: write the failing test for the slice's behavior, make it pass, keep the slice demoable.
- Open the pull request and link it (link_pull_request links it to the claimed issue too), then backlog_release with status review and a short note. Use ready to hand back unfinished work, with a note on what is left.
- Never modify the parent spec while working a child. Raise disagreements as a backlog_comment on the parent and tell the user.
- When a slice finishes, its dependents join the frontier. Repeat until the frontier is empty, then report what is in review.
- Claims are leases. They renew while your thread runs and expire about 15 minutes after it stops, returning the issue to ready. A user can force-release any claim.`;

/** The caller's thread is the actor, and any backlog call keeps its claims alive. */
const access = Effect.gen(function* () {
  const { scope, caller } = yield* readCaller();
  const backlog = yield* BacklogService.BacklogService;
  const actor: BacklogActor = {
    kind: "agent",
    environmentId: scope.environmentId,
    threadId: scope.threadId,
    label: `${caller.title} · ${caller.modelSelection.model}`,
  };
  yield* backlog.renewClaims({ environmentId: scope.environmentId, threadIds: [scope.threadId] });
  return { backlog, actor };
});

/** A backlog chosen by key/id or by project, or undefined when neither is given. */
const targetBacklog = (
  backlog: BacklogService.BacklogService["Service"],
  input: { readonly backlog?: string | undefined; readonly projectId?: ProjectId | undefined },
): Effect.Effect<BacklogId | undefined, BacklogError> =>
  input.backlog !== undefined
    ? backlog.resolveBacklogRef(input.backlog).pipe(Effect.map((found) => found.id))
    : input.projectId !== undefined
      ? backlog.ensureProjectBacklog(input.projectId).pipe(Effect.map((found) => found.id))
      : Effect.succeed(undefined);

export const BacklogHandlersLive = BacklogToolkit.toLayer({
  backlog_guide: () => access.pipe(Effect.as({ guide: BACKLOG_PLAYBOOK })),
  backlog_list_backlogs: () =>
    Effect.gen(function* () {
      const { backlog } = yield* access;
      return { backlogs: yield* backlog.listBacklogs() };
    }),
  backlog_list_issues: (input) =>
    Effect.gen(function* () {
      const { backlog } = yield* access;
      const issues = yield* backlog.listIssues({
        backlogId: yield* targetBacklog(backlog, input),
        status: input.status,
        type: input.type,
        parentId:
          input.parent === undefined ? undefined : yield* backlog.resolveIssueRef(input.parent),
        frontierOnly: input.frontierOnly,
      });
      return { issues: issues.slice(0, input.limit ?? 100), total: issues.length };
    }),
  backlog_get_issue: (input) =>
    Effect.gen(function* () {
      const { backlog } = yield* access;
      return yield* backlog.getIssue({ issueId: yield* backlog.resolveIssueRef(input.issue) });
    }),
  backlog_create_issue: ({ backlog: backlogRef, projectId, parent, blockedBy, ...input }) =>
    Effect.gen(function* () {
      const { backlog, actor } = yield* access;
      const backlogId = yield* targetBacklog(backlog, { backlog: backlogRef, projectId });
      return yield* backlog.createIssue(
        {
          ...input,
          ...(backlogId === undefined ? {} : { backlogId }),
          ...(parent === undefined ? {} : { parentId: yield* backlog.resolveIssueRef(parent) }),
          ...(blockedBy === undefined
            ? {}
            : { blockedBy: yield* Effect.forEach(blockedBy, backlog.resolveIssueRef) }),
        },
        actor,
      );
    }),
  backlog_create_children: (input) =>
    Effect.gen(function* () {
      const { backlog, actor } = yield* access;
      const children = yield* Effect.forEach(input.children, ({ blockedBy, ...child }) =>
        blockedBy === undefined
          ? Effect.succeed(child)
          : Effect.forEach(blockedBy, backlog.resolveIssueRef).pipe(
              Effect.map((ids) => ({ ...child, blockedBy: ids })),
            ),
      );
      const issues = yield* backlog.createChildren(
        { parentId: yield* backlog.resolveIssueRef(input.parent), children },
        actor,
      );
      return { issues };
    }),
  backlog_update_issue: ({ issue, parent, blockedBy, backlog: backlogRef, projectId, ...input }) =>
    Effect.gen(function* () {
      const { backlog, actor } = yield* access;
      const backlogId =
        backlogRef === undefined ? undefined : (yield* backlog.resolveBacklogRef(backlogRef)).id;
      return yield* backlog.updateIssue(
        {
          ...input,
          issueId: yield* backlog.resolveIssueRef(issue),
          ...(backlogId === undefined ? {} : { backlogId }),
          ...(projectId === undefined ? {} : { projectId }),
          ...(parent === undefined
            ? {}
            : { parentId: parent === null ? null : yield* backlog.resolveIssueRef(parent) }),
          ...(blockedBy === undefined
            ? {}
            : { blockedBy: yield* Effect.forEach(blockedBy, backlog.resolveIssueRef) }),
        },
        actor,
      );
    }),
  backlog_claim: (input) =>
    Effect.gen(function* () {
      const { backlog, actor } = yield* access;
      return yield* backlog.claim({ issueId: yield* backlog.resolveIssueRef(input.issue) }, actor);
    }),
  backlog_claim_next: (input) =>
    Effect.gen(function* () {
      const { backlog, actor } = yield* access;
      const claimed = yield* backlog.claimNext(
        {
          backlogId: yield* targetBacklog(backlog, input),
          parentId:
            input.parent === undefined ? undefined : yield* backlog.resolveIssueRef(input.parent),
          type: input.type,
        },
        actor,
      );
      return { claimed };
    }),
  backlog_release: (input) =>
    Effect.gen(function* () {
      const { backlog, actor } = yield* access;
      return yield* backlog.release(
        {
          issueId: yield* backlog.resolveIssueRef(input.issue),
          status: input.status,
          ...(input.note === undefined ? {} : { note: input.note }),
        },
        actor,
      );
    }),
  backlog_comment: (input) =>
    Effect.gen(function* () {
      const { backlog, actor } = yield* access;
      return yield* backlog.comment(
        { issueId: yield* backlog.resolveIssueRef(input.issue), text: input.text },
        actor,
      );
    }),
  backlog_link_pull_request: (input) =>
    Effect.gen(function* () {
      const { backlog, actor } = yield* access;
      if (input.issue === undefined) {
        return { issues: yield* backlog.linkPullRequestToClaims({ url: input.url }, actor) };
      }
      const issue = yield* backlog.addLink(
        {
          issueId: yield* backlog.resolveIssueRef(input.issue),
          link: { type: "pull_request", url: input.url },
        },
        actor,
      );
      return { issues: [issue] };
    }),
});
