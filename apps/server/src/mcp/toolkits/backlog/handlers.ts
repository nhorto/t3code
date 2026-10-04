import type { BacklogActor } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { BacklogOrchestration } from "../../../backlog/BacklogOrchestration.ts";
import * as BacklogRouter from "../../../backlog/BacklogRouter.ts";
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
- Fan out: give each worker one issue. Every worker must be its own T3 thread (ask the user to start one per issue), never a provider's built-in subagent (such as Claude's Task tool): a claim belongs to a thread, and built-in subagents share yours, so they cannot hold separate claims. The worker claims the issue itself (backlog_claim with the key, or backlog_claim_next with parent set to the spec), so the claim belongs to the thread doing the work. A conflict means another agent has it; take a different one. alreadyHeld: true on a claim you did not make means another worker in your thread has it.
- The claim response carries the parent's spec; read it before starting.
- Implement red to green at the agreed test seams: write the failing test for the slice's behavior, make it pass, keep the slice demoable.
- Open the pull request and link it (link_pull_request links it to the claimed issue too), then backlog_release with status review and a short note. Use ready to hand back unfinished work, with a note on what is left.
- Never modify the parent spec while working a child. Raise disagreements as a backlog_comment on the parent and tell the user.
- When a slice finishes, its dependents join the frontier. Repeat until the frontier is empty, then report what is in review.
- Claims are leases. They hold while your thread is running or was active in the last 2 hours, so stopping to ask the user a question keeps them; after that they expire within about 15 minutes, returning the issue to ready. A user can force-release any claim.
- Issues may live on another machine: when this machine is linked to a backlog hub, keys resolve there too and every tool routes automatically. If the hub is unreachable, reads answer from what it last reported, marked stale: true with asOf, and changes fail with code unavailable; say so rather than working around it.
- A backlog can move to another machine. Its old copy stays as a read-only redirect: changes fail with a conflict naming where it went, and when it went to the linked hub, keys follow it there automatically.`;

/** The caller's thread is the actor, and any backlog call keeps its claims here alive. */
const access = Effect.gen(function* () {
  const { scope, caller } = yield* readCaller();
  const backlog = yield* BacklogService.BacklogService;
  const router = yield* BacklogRouter.BacklogRouter;
  const actor: BacklogActor = {
    kind: "agent",
    environmentId: scope.environmentId,
    threadId: scope.threadId,
    label: `${caller.title} · ${caller.model}`,
  };
  yield* backlog.renewClaims({ environmentId: scope.environmentId, threadIds: [scope.threadId] });
  return { router, actor, caller };
});

/** The playbook, then this machine's projects so an agent can target one by id. */
const guide = Effect.gen(function* () {
  const { caller } = yield* access;
  const projects = yield* (yield* BacklogOrchestration).listProjects();
  const lines = projects.map(
    (project) =>
      `- ${project.title}: ${project.id}${project.id === caller.projectId ? " (this thread's project)" : ""}`,
  );
  return {
    guide: `${BACKLOG_PLAYBOOK}\n\n## Projects on this machine\n\n${lines.length > 0 ? lines.join("\n") : "None."}`,
  };
});

export const BacklogHandlersLive = BacklogToolkit.toLayer({
  backlog_guide: () => guide,
  backlog_list_backlogs: () =>
    Effect.gen(function* () {
      const { router } = yield* access;
      return yield* router.listBacklogs();
    }),
  backlog_list_issues: ({ limit, ...input }) =>
    Effect.gen(function* () {
      const { router } = yield* access;
      const { issues, ...rest } = yield* router.listIssues(input);
      return { ...rest, issues: issues.slice(0, limit ?? 100), total: issues.length };
    }),
  backlog_get_issue: (input) =>
    Effect.gen(function* () {
      const { router } = yield* access;
      return yield* router.getIssue(input.issue);
    }),
  backlog_create_issue: (input) =>
    Effect.gen(function* () {
      const { router, actor } = yield* access;
      return yield* router.createIssue(input, actor);
    }),
  backlog_create_children: (input) =>
    Effect.gen(function* () {
      const { router, actor } = yield* access;
      return { issues: yield* router.createChildren(input, actor) };
    }),
  backlog_update_issue: (input) =>
    Effect.gen(function* () {
      const { router, actor } = yield* access;
      return yield* router.updateIssue(input, actor);
    }),
  backlog_claim: (input) =>
    Effect.gen(function* () {
      const { router, actor } = yield* access;
      return yield* router.claim(input.issue, actor);
    }),
  backlog_claim_next: (input) =>
    Effect.gen(function* () {
      const { router, actor } = yield* access;
      return { claimed: yield* router.claimNext(input, actor) };
    }),
  backlog_release: (input) =>
    Effect.gen(function* () {
      const { router, actor } = yield* access;
      return yield* router.release(input, actor);
    }),
  backlog_comment: (input) =>
    Effect.gen(function* () {
      const { router, actor } = yield* access;
      return yield* router.comment(input, actor);
    }),
  backlog_link_pull_request: (input) =>
    Effect.gen(function* () {
      const { router, actor } = yield* access;
      return { issues: yield* router.linkPullRequest(input, actor) };
    }),
});
