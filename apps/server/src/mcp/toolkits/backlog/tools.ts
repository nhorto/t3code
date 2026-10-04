import {
  Backlog,
  BacklogActivity,
  BacklogError,
  BacklogIssue,
  BacklogIssueDetail,
  BacklogIssuePriority,
  BacklogIssueStatus,
  BacklogIssueType,
  BacklogReleaseStatus,
  OrchestratorMcpFailure,
  ProjectId,
  TrimmedNonEmptyString,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/unstable/ai";

import * as BacklogService from "../../../backlog/BacklogService.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

const IssueRef = TrimmedNonEmptyString.annotate({
  description: "An issue id, or its key such as WINE-12 (case-insensitive).",
});
const BacklogRef = TrimmedNonEmptyString.annotate({
  description: "A backlog id, or its key such as WINE or INBOX (case-insensitive).",
});
const ProjectTarget = ProjectId.annotate({
  description:
    "A project id from t3_project_list. Targets that project's backlog, creating it on first use.",
});

const shared = {
  failure: Schema.Union([OrchestratorMcpFailure, BacklogError]),
  failureMode: "return" as const,
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    ThreadManagementService.ThreadManagementService,
    BacklogService.BacklogService,
  ],
};

const BacklogGuideTool = Tool.make("backlog_guide", {
  ...shared,
  description:
    "Read the playbook for planning and working through the Backlog: turning a spec into a parent issue with tracer-bullet children, and how subagents claim, implement, and release them. Call this before breaking down a spec or orchestrating backlog work.",
  success: Schema.Struct({ guide: Schema.String }),
})
  .annotate(Tool.Title, "Read the backlog playbook")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true);

const ListBacklogsTool = Tool.make("backlog_list_backlogs", {
  ...shared,
  description:
    "List the backlogs on this environment: the personal Inbox and one per project that has used one. Keys such as WINE prefix issue keys (WINE-12).",
  success: Schema.Struct({ backlogs: Schema.Array(Backlog) }),
})
  .annotate(Tool.Title, "List backlogs")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true);

const ListIssuesTool = Tool.make("backlog_list_issues", {
  ...shared,
  description:
    "List backlog issues as board rows without bodies; use backlog_get_issue for the body, children, blockers, and history. frontierOnly lists only issues an agent may claim: ready, unblocked, and unclaimed. An issue is blocked while any issue in blockedBy is not done or wontfix.",
  parameters: Schema.Struct({
    backlog: Schema.optional(BacklogRef),
    projectId: Schema.optional(ProjectTarget),
    status: Schema.optional(Schema.Array(BacklogIssueStatus)),
    type: Schema.optional(BacklogIssueType),
    parent: Schema.optional(IssueRef.annotate({ description: "Only children of this issue." })),
    frontierOnly: Schema.optional(Schema.Boolean),
    limit: Schema.optional(
      Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 500 })).annotate({
        description: "Maximum rows to return. Defaults to 100.",
      }),
    ),
  }),
  success: Schema.Struct({
    issues: Schema.Array(BacklogIssue),
    total: Schema.Int.annotate({ description: "Matching issues before the limit." }),
  }),
})
  .annotate(Tool.Title, "List backlog issues")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true);

const GetIssueTool = Tool.make("backlog_get_issue", {
  ...shared,
  description:
    "Read one issue with its markdown body, its parent's spec, its children, its blockers, and its full activity history.",
  parameters: Schema.Struct({ issue: IssueRef }),
  success: BacklogIssueDetail,
})
  .annotate(Tool.Title, "Read a backlog issue")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true);

const CreateIssueTool = Tool.make("backlog_create_issue", {
  ...shared,
  description:
    "Add an idea, bug, or feature to a backlog. Use this when the user says something like \"add a bug to Cork & Note: paywall crashes on iPad\": find the project's id with t3_project_list and pass it as projectId. Pass backlog to target a backlog by key or id instead. With neither, the issue lands in the personal Inbox for later triage. Keep the user's wording for the title; put detail in body. Status defaults to inbox in the Inbox and backlog in a project.",
  parameters: Schema.Struct({
    projectId: Schema.optional(ProjectTarget),
    backlog: Schema.optional(BacklogRef),
    title: TrimmedNonEmptyString,
    body: Schema.optional(Schema.String.annotate({ description: "Markdown body." })),
    type: Schema.optional(BacklogIssueType),
    status: Schema.optional(BacklogIssueStatus),
    priority: Schema.optional(Schema.NullOr(BacklogIssuePriority)),
    parent: Schema.optional(
      IssueRef.annotate({ description: "Parent spec issue; must be in the same backlog." }),
    ),
    blockedBy: Schema.optional(
      Schema.Array(IssueRef).annotate({ description: "Issues that must close before this one." }),
    ),
  }),
  success: BacklogIssue,
})
  .annotate(Tool.Title, "Create a backlog issue")
  .annotate(Tool.Destructive, false);

const CreateChildrenTool = Tool.make("backlog_create_children", {
  ...shared,
  description:
    "Break a parent spec issue into child issues in one call, with blocking edges between them. Each child should be a tracer bullet: a complete, demoable vertical slice that fits one agent's context window. blockedBySiblings lists zero-based indexes of other children in this same call; blockedBy lists existing issues. Children are not implicitly blocked by each other. Create them in backlog status, show the breakdown to the user, and move them to ready once approved; only ready issues can be claimed.",
  parameters: Schema.Struct({
    parent: IssueRef,
    children: Schema.Array(
      Schema.Struct({
        title: TrimmedNonEmptyString,
        body: Schema.optional(Schema.String.annotate({ description: "Markdown body." })),
        type: Schema.optional(BacklogIssueType),
        status: Schema.optional(BacklogIssueStatus),
        priority: Schema.optional(Schema.NullOr(BacklogIssuePriority)),
        blockedBySiblings: Schema.optional(
          Schema.Array(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
        ),
        blockedBy: Schema.optional(Schema.Array(IssueRef)),
      }),
    ).check(Schema.isMinLength(1), Schema.isMaxLength(50)),
  }),
  success: Schema.Struct({ issues: Schema.Array(BacklogIssue) }),
})
  .annotate(Tool.Title, "Create child issues")
  .annotate(Tool.Destructive, false);

const UpdateIssueTool = Tool.make("backlog_update_issue", {
  ...shared,
  description:
    "Edit an issue. Omitted fields are preserved; blockedBy replaces the whole blocker list; parent null detaches it. Move an issue to another backlog with backlog or projectId (for example triaging the Inbox into a project); it gets a new number there. A parent cannot be marked done while a child is open. Changing the status of an issue another agent has claimed fails; if you hold the claim, prefer backlog_release. Reopen a done or wontfix issue by setting another status.",
  parameters: Schema.Struct({
    issue: IssueRef,
    title: Schema.optional(TrimmedNonEmptyString),
    body: Schema.optional(Schema.String),
    type: Schema.optional(BacklogIssueType),
    status: Schema.optional(BacklogIssueStatus),
    priority: Schema.optional(Schema.NullOr(BacklogIssuePriority)),
    parent: Schema.optional(Schema.NullOr(IssueRef)),
    blockedBy: Schema.optional(Schema.Array(IssueRef)),
    backlog: Schema.optional(BacklogRef),
    projectId: Schema.optional(ProjectTarget),
  }),
  success: BacklogIssue,
})
  .annotate(Tool.Title, "Update a backlog issue")
  .annotate(Tool.Destructive, false);

const ClaimTool = Tool.make("backlog_claim", {
  ...shared,
  description:
    "Claim an issue for this thread before working on it. Only frontier issues (ready, unblocked, unclaimed) can be claimed, and a claim is exclusive across every agent and machine; a conflict means someone else has it, so pick another. Claiming moves the issue to in_progress, links this thread, and returns the issue with its parent's spec. The claim is a lease that renews while this thread runs and whenever it calls a backlog tool; it expires about 15 minutes after the thread stops. Re-claiming an issue you hold is safe.",
  parameters: Schema.Struct({ issue: IssueRef }),
  success: BacklogIssueDetail,
})
  .annotate(Tool.Title, "Claim a backlog issue")
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true);

const ClaimNextTool = Tool.make("backlog_claim_next", {
  ...shared,
  description:
    "Claim the next frontier issue: highest priority first, then oldest. Narrow it with backlog, projectId, parent (children of one spec), or type. Returns claimed: null when nothing is claimable. Same lease rules as backlog_claim.",
  parameters: Schema.Struct({
    backlog: Schema.optional(BacklogRef),
    projectId: Schema.optional(ProjectTarget),
    parent: Schema.optional(IssueRef),
    type: Schema.optional(BacklogIssueType),
  }),
  success: Schema.Struct({ claimed: Schema.NullOr(BacklogIssueDetail) }),
})
  .annotate(Tool.Title, "Claim the next backlog issue")
  .annotate(Tool.Destructive, false);

const ReleaseTool = Tool.make("backlog_release", {
  ...shared,
  description:
    "Release an issue this thread holds and choose where it goes: review when the work is done and awaits a human (the usual case, after linking its pull request), done when nothing needs review, ready to hand it back unfinished, or backlog to shelve it. Add a note saying what happened. Only the holder can release.",
  parameters: Schema.Struct({
    issue: IssueRef,
    status: BacklogReleaseStatus,
    note: Schema.optional(Schema.String),
  }),
  success: BacklogIssue,
})
  .annotate(Tool.Title, "Release a backlog issue")
  .annotate(Tool.Destructive, false);

const CommentTool = Tool.make("backlog_comment", {
  ...shared,
  description:
    "Add a comment to an issue's history, for findings, decisions, or questions for the user.",
  parameters: Schema.Struct({ issue: IssueRef, text: TrimmedNonEmptyString }),
  success: BacklogActivity,
})
  .annotate(Tool.Title, "Comment on a backlog issue")
  .annotate(Tool.Destructive, false);

const LinkPullRequestTool = Tool.make("backlog_link_pull_request", {
  ...shared,
  description:
    "Link a pull request URL to an issue. Without issue, links it to every issue this thread currently holds. link_pull_request already does this for held issues, so call this only for other issues.",
  parameters: Schema.Struct({
    url: TrimmedNonEmptyString.annotate({ description: "The pull request's web URL." }),
    issue: Schema.optional(IssueRef),
  }),
  success: Schema.Struct({ issues: Schema.Array(BacklogIssue) }),
})
  .annotate(Tool.Title, "Link a pull request to a backlog issue")
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true);

export const BacklogToolkit = Toolkit.make(
  BacklogGuideTool,
  ListBacklogsTool,
  ListIssuesTool,
  GetIssueTool,
  CreateIssueTool,
  CreateChildrenTool,
  UpdateIssueTool,
  ClaimTool,
  ClaimNextTool,
  ReleaseTool,
  CommentTool,
  LinkPullRequestTool,
);
