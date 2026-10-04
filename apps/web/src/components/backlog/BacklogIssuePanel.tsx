import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { claimTakeoverMessage } from "@t3tools/client-runtime/state/backlog";
import { isAtomCommandInterrupted } from "@t3tools/client-runtime/state/runtime";
import {
  isBacklogStatusClosed,
  type BacklogIssue,
  type BacklogIssueDetail,
  type BacklogIssueId,
  type BacklogIssuePriority,
  type BacklogIssueStatus,
  type BacklogIssueType,
  type BacklogUpdateIssueInput,
  type EnvironmentId,
  type ThreadId,
} from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { BotIcon, ExternalLinkIcon, MessageSquareIcon, RotateCcwIcon, XIcon } from "lucide-react";
import { useMemo, useState, type ReactNode } from "react";

import { readLocalApi } from "../../localApi";
import {
  backlogEnvironment,
  backlogFailureMessage,
  useBacklogIssueDetail,
} from "../../state/backlog";
import { useProjects } from "../../state/entities";
import { useEnvironment } from "../../state/environments";
import { useAtomCommand } from "../../state/use-atom-command";
import { buildThreadRouteParams } from "../../threadRoutes";
import { formatRelativeTimeLabel } from "../../timestampFormat";
import ChatMarkdown from "../ChatMarkdown";
import { PullRequestGlyph } from "../pullRequest/pullRequestIcons";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Skeleton } from "../ui/skeleton";
import { Textarea } from "../ui/textarea";
import { stackedThreadToast, toastManager } from "../ui/toast";
import {
  BACKLOG_PRIORITIES,
  BACKLOG_PRIORITY_LABELS,
  BACKLOG_STATUS_LABELS,
  BACKLOG_TYPE_LABELS,
  BACKLOG_TYPES,
  backlogMoveTargets,
  blockerCandidates,
  creatableProjectIdsOn,
  describeBacklogActivity,
  isBacklogSourceWritable,
  reopenStatusFor,
  type BacklogSource,
  type BacklogSwitcherEntry,
} from "./backlog.logic";
import { BacklogTypeIcon } from "./BacklogCard";

const STATUS_OPTIONS: ReadonlyArray<BacklogIssueStatus> = [
  "inbox",
  "backlog",
  "ready",
  "in_progress",
  "review",
  "done",
  "wontfix",
];

/** The themed confirm where the app shell hosts one, else the browser's. */
async function confirmAction(message: string): Promise<boolean> {
  const api = readLocalApi();
  return api ? api.dialogs.confirm(message) : window.confirm(message);
}

function reportFailure(title: string, result: Parameters<typeof backlogFailureMessage>[0]) {
  toastManager.add(
    stackedThreadToast({ type: "error", title, description: backlogFailureMessage(result) }),
  );
}

function useIssueCommands(environmentId: EnvironmentId) {
  const options = { reportFailure: false } as const;
  const update = useAtomCommand(backlogEnvironment.updateIssue, {
    label: "backlog update issue",
    ...options,
  });
  const release = useAtomCommand(backlogEnvironment.release, {
    label: "backlog release",
    ...options,
  });
  const comment = useAtomCommand(backlogEnvironment.comment, {
    label: "backlog comment",
    ...options,
  });
  return {
    update: async (input: BacklogUpdateIssueInput): Promise<boolean> => {
      const result = await update({ environmentId, input });
      if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
        reportFailure("Could not update the issue", result);
      }
      return result._tag === "Success";
    },
    forceRelease: async (issueId: BacklogIssueId): Promise<boolean> => {
      const result = await release({
        environmentId,
        input: { issueId, status: "ready", note: "Released from the board" },
      });
      if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
        reportFailure("Could not release the claim", result);
      }
      return result._tag === "Success";
    },
    comment: async (issueId: BacklogIssueId, text: string): Promise<boolean> => {
      const result = await comment({ environmentId, input: { issueId, text } });
      if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
        reportFailure("Could not post the comment", result);
      }
      return result._tag === "Success";
    },
  };
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-2">
      <h3 className="text-xs font-medium text-muted-foreground">{title}</h3>
      {children}
    </section>
  );
}

function IssueRowButton({
  issue,
  onOpen,
  trailing,
}: {
  issue: Pick<BacklogIssue, "key" | "title" | "status" | "type">;
  onOpen: () => void;
  trailing?: ReactNode;
}) {
  return (
    <div className="flex min-w-0 items-center gap-2">
      <Button variant="ghost" size="sm" className="min-w-0 flex-1 justify-start" onClick={onOpen}>
        <BacklogTypeIcon type={issue.type} />
        <span className="shrink-0 font-mono text-xs text-muted-foreground">{issue.key}</span>
        <span className="min-w-0 truncate">{issue.title}</span>
      </Button>
      <Badge size="sm" variant={isBacklogStatusClosed(issue.status) ? "success" : "secondary"}>
        {BACKLOG_STATUS_LABELS[issue.status]}
      </Badge>
      {trailing}
    </div>
  );
}

export interface BacklogIssuePanelProps {
  readonly environmentId: EnvironmentId;
  readonly issueId: BacklogIssueId;
  readonly source: BacklogSource | null;
  /** The switcher, to know which projects a move may create a backlog for. */
  readonly entries: ReadonlyArray<BacklogSwitcherEntry>;
  readonly onClose: () => void;
  readonly onOpenIssue: (environmentId: EnvironmentId, issueId: BacklogIssueId) => void;
}

/** The issue detail beside the board: edit, triage, claims, links, history. */
export function BacklogIssuePanel(props: BacklogIssuePanelProps) {
  const { environmentId, issueId, source, onClose } = props;
  const row = source?.board?.issuesById.get(issueId) ?? null;
  const { detail, error } = useBacklogIssueDetail({ environmentId, issueId });
  // The board row is live; the detail lags a refetch behind it, so prefer the row's fields.
  const issue = row ?? detail?.issue ?? null;

  return (
    <aside
      aria-label={issue ? `${issue.key} details` : "Issue details"}
      className="absolute inset-0 z-10 flex min-h-0 flex-col border-l bg-background md:static md:w-md md:shrink-0 lg:w-lg"
    >
      <div className="flex shrink-0 items-center gap-2 border-b px-4 py-2">
        {issue ? (
          <span className="font-mono text-xs text-muted-foreground">{issue.key}</span>
        ) : null}
        {source ? (
          <span className="truncate text-xs text-muted-foreground">{source.label}</span>
        ) : null}
        <Button
          size="icon-sm"
          variant="ghost"
          className="ml-auto"
          aria-label="Close issue"
          onClick={onClose}
        >
          <XIcon />
        </Button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {issue === null ? (
          error ? (
            <p className="p-4 text-sm text-muted-foreground">Could not load the issue: {error}</p>
          ) : source?.board ? (
            <p className="p-4 text-sm text-muted-foreground">
              This issue is no longer on the board.
            </p>
          ) : (
            <div className="flex flex-col gap-3 p-4">
              <Skeleton className="h-6 w-3/4" />
              <Skeleton className="h-24 w-full" />
            </div>
          )
        ) : (
          <IssueDetailBody {...props} issue={issue} detail={detail} detailError={error} />
        )}
      </div>
    </aside>
  );
}

function IssueDetailBody({
  environmentId,
  source,
  entries,
  onOpenIssue,
  issue,
  detail,
  detailError,
}: BacklogIssuePanelProps & {
  issue: BacklogIssue;
  detail: BacklogIssueDetail | null;
  detailError: string | null;
}) {
  const navigate = useNavigate();
  const projects = useProjects();
  const commands = useIssueCommands(environmentId);
  const writable = source !== null && isBacklogSourceWritable(source);
  const board = source?.board ?? null;
  const backlog = board?.backlogs.find((candidate) => candidate.id === issue.backlogId) ?? null;
  const closed = isBacklogStatusClosed(issue.status);
  const [editingBody, setEditingBody] = useState(false);
  const [bodyDraft, setBodyDraft] = useState("");
  // The row's version when editing began: a newer row means someone else may have edited it.
  const [bodyBaseUpdatedAt, setBodyBaseUpdatedAt] = useState<string | null>(null);
  const [commentDraft, setCommentDraft] = useState("");
  const [busy, setBusy] = useState(false);

  const run = async (action: () => Promise<boolean>) => {
    if (busy) return false;
    setBusy(true);
    const ok = await action();
    setBusy(false);
    return ok;
  };
  const update = (input: Omit<BacklogUpdateIssueInput, "issueId">) =>
    run(() => commands.update({ issueId: issue.id, ...input }));
  const changeStatus = async (status: BacklogIssueStatus) => {
    const takeover = claimTakeoverMessage(issue);
    if (takeover !== null && !(await confirmAction(takeover))) return;
    void update({ status });
  };
  const saveBody = async () => {
    if (
      bodyBaseUpdatedAt !== null &&
      bodyBaseUpdatedAt !== issue.updatedAt &&
      !(await confirmAction(
        `${issue.key} changed since you started editing. Save your description over it?`,
      ))
    ) {
      return;
    }
    if (await update({ body: bodyDraft })) setEditingBody(false);
  };

  const openThread = (threadEnvironmentId: EnvironmentId | null, threadId: ThreadId) => {
    void navigate({
      to: "/$environmentId/$threadId",
      params: buildThreadRouteParams(
        scopeThreadRef(threadEnvironmentId ?? environmentId, threadId),
      ),
    });
  };
  const openExternal = (url: string) => {
    const api = readLocalApi();
    if (api) void api.shell.openExternal(url).catch(() => undefined);
    else window.open(url, "_blank", "noopener,noreferrer");
  };

  const creatableProjectIds = useMemo(
    () => creatableProjectIdsOn(entries, environmentId),
    [entries, environmentId],
  );
  const moveTargets = backlogMoveTargets({
    currentBacklogId: issue.backlogId,
    backlogs: board?.backlogs ?? [],
    projects: projects.filter((project) => project.environmentId === environmentId),
    creatableProjectIds,
  });
  const blockers = issue.blockedBy.map(
    (blockerId) =>
      board?.issuesById.get(blockerId) ??
      detail?.blockers.find((candidate) => candidate.id === blockerId) ??
      null,
  );
  const candidates = board ? blockerCandidates(issue, board.issues) : [];
  const children = board
    ? board.issues.filter((candidate) => candidate.parentId === issue.id)
    : (detail?.children ?? []);
  const parent =
    issue.parentId === null
      ? null
      : (board?.issuesById.get(issue.parentId) ?? detail?.parent?.issue ?? null);
  const claim = issue.claim;
  const claimEnvironment = useEnvironment(claim?.actor.environmentId ?? null);
  const claimMachine = claim ? (claimEnvironment?.label ?? null) : null;

  return (
    <div className="flex flex-col gap-5 p-4">
      {!writable ? (
        <p className="rounded-lg border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
          {source?.label ?? "This machine"} is unreachable. Showing the last known state, read-only.
        </p>
      ) : null}

      <Input
        // Remount when the server's title changes so the field never shows a stale draft.
        key={`${issue.id}:${issue.title}`}
        aria-label="Title"
        defaultValue={issue.title}
        disabled={!writable}
        onBlur={(event) => {
          const next = event.currentTarget.value.trim();
          if (next.length === 0) {
            event.currentTarget.value = issue.title;
            return;
          }
          if (next !== issue.title) void update({ title: next });
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter") event.currentTarget.blur();
        }}
      />

      <div className="grid grid-cols-3 gap-2">
        <Select
          value={issue.status}
          disabled={!writable || busy}
          onValueChange={(next) => {
            if (next && next !== issue.status) void changeStatus(next as BacklogIssueStatus);
          }}
        >
          <SelectTrigger size="sm" aria-label="Status" className="min-w-0">
            <SelectValue>{BACKLOG_STATUS_LABELS[issue.status]}</SelectValue>
          </SelectTrigger>
          <SelectPopup>
            {STATUS_OPTIONS.map((status) => (
              <SelectItem key={status} value={status}>
                {BACKLOG_STATUS_LABELS[status]}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
        <Select
          value={issue.type}
          disabled={!writable || busy}
          onValueChange={(next) => {
            if (next && next !== issue.type) void update({ type: next as BacklogIssueType });
          }}
        >
          <SelectTrigger size="sm" aria-label="Type" className="min-w-0">
            <SelectValue>
              <span className="flex items-center gap-1.5">
                <BacklogTypeIcon type={issue.type} />
                {BACKLOG_TYPE_LABELS[issue.type]}
              </span>
            </SelectValue>
          </SelectTrigger>
          <SelectPopup>
            {BACKLOG_TYPES.map((type) => (
              <SelectItem key={type} value={type}>
                {BACKLOG_TYPE_LABELS[type]}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
        <Select
          value={issue.priority ?? "none"}
          disabled={!writable || busy}
          onValueChange={(next) => {
            const priority = next === "none" ? null : (next as BacklogIssuePriority);
            if (next && priority !== issue.priority) void update({ priority });
          }}
        >
          <SelectTrigger size="sm" aria-label="Priority" className="min-w-0">
            <SelectValue>
              {issue.priority ? BACKLOG_PRIORITY_LABELS[issue.priority] : "No priority"}
            </SelectValue>
          </SelectTrigger>
          <SelectPopup>
            <SelectItem value="none">No priority</SelectItem>
            {BACKLOG_PRIORITIES.map((priority) => (
              <SelectItem key={priority} value={priority}>
                {BACKLOG_PRIORITY_LABELS[priority]}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        {closed ? (
          <Button
            size="sm"
            variant="outline"
            disabled={!writable || busy}
            onClick={() => void update({ status: reopenStatusFor(backlog?.kind ?? "project") })}
          >
            <RotateCcwIcon />
            Reopen
          </Button>
        ) : null}
        {moveTargets.length > 0 ? (
          <Select
            value={null}
            disabled={!writable || busy}
            onValueChange={(next) => {
              const target = moveTargets.find((candidate) => candidate.value === next);
              if (target) void update(target.input);
            }}
          >
            <SelectTrigger size="sm" aria-label="Move to another backlog" className="w-auto">
              <SelectValue placeholder="Move to…" />
            </SelectTrigger>
            <SelectPopup>
              {moveTargets.map((target) => (
                <SelectItem key={target.value} value={target.value}>
                  {target.label}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        ) : null}
      </div>

      {claim ? (
        <Section title="Claim">
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <BotIcon aria-hidden className="size-4 text-muted-foreground" />
            <span className="min-w-0 truncate">
              {claim.actor.label}
              {claimMachine ? ` · ${claimMachine}` : ""}
            </span>
            <span className="text-xs text-muted-foreground">
              claimed {formatRelativeTimeLabel(claim.claimedAt)}
            </span>
          </div>
          <div className="flex flex-wrap gap-2">
            {claim.actor.threadId ? (
              <Button
                size="sm"
                variant="outline"
                onClick={() =>
                  openThread(claim.actor.environmentId, claim.actor.threadId as ThreadId)
                }
              >
                <MessageSquareIcon />
                Open thread
              </Button>
            ) : null}
            <Button
              size="sm"
              variant="destructive-outline"
              disabled={!writable || busy}
              onClick={() => void run(() => commands.forceRelease(issue.id))}
            >
              Release to Ready
            </Button>
          </div>
        </Section>
      ) : null}

      <Section title="Description">
        {editingBody ? (
          <div className="flex flex-col gap-2">
            <Textarea
              aria-label="Description"
              autoFocus
              value={bodyDraft}
              onChange={(event) => setBodyDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                  event.preventDefault();
                  void saveBody();
                }
                if (event.key === "Escape") {
                  event.preventDefault();
                  event.stopPropagation();
                  setEditingBody(false);
                }
              }}
            />
            <div className="flex justify-end gap-2">
              <Button size="sm" variant="ghost" onClick={() => setEditingBody(false)}>
                Cancel
              </Button>
              <Button size="sm" disabled={busy} onClick={() => void saveBody()}>
                Save
              </Button>
            </div>
          </div>
        ) : detail ? (
          <div className="flex flex-col gap-2">
            {detail.body.trim().length > 0 ? (
              <ChatMarkdown text={detail.body} cwd={undefined} environmentId={environmentId} />
            ) : (
              <p className="text-sm text-muted-foreground">No description.</p>
            )}
            {writable ? (
              <Button
                size="xs"
                variant="ghost-muted"
                className="self-start"
                onClick={() => {
                  setBodyDraft(detail.body);
                  setBodyBaseUpdatedAt(detail.issue.updatedAt);
                  setEditingBody(true);
                }}
              >
                Edit description
              </Button>
            ) : null}
          </div>
        ) : detailError ? (
          <p className="text-sm text-muted-foreground">Could not load: {detailError}</p>
        ) : (
          <Skeleton className="h-16 w-full" />
        )}
      </Section>

      {parent ? (
        <Section title="Parent">
          <IssueRowButton issue={parent} onOpen={() => onOpenIssue(environmentId, parent.id)} />
        </Section>
      ) : null}

      {children.length > 0 ? (
        <Section
          title={`Children · ${children.filter((child) => isBacklogStatusClosed(child.status)).length}/${children.length} closed`}
        >
          {children.map((child) => (
            <IssueRowButton
              key={child.id}
              issue={child}
              onOpen={() => onOpenIssue(environmentId, child.id)}
            />
          ))}
        </Section>
      ) : null}

      <Section title="Blocked by">
        {blockers.length === 0 ? (
          <p className="text-sm text-muted-foreground">Nothing blocks this issue.</p>
        ) : (
          blockers.map((blocker, index) =>
            blocker ? (
              <IssueRowButton
                key={blocker.id}
                issue={blocker}
                onOpen={() => onOpenIssue(environmentId, blocker.id)}
                trailing={
                  writable ? (
                    <Button
                      size="icon-xs"
                      variant="ghost-muted"
                      aria-label={`Remove blocker ${blocker.key}`}
                      disabled={busy}
                      onClick={() =>
                        void update({
                          blockedBy: issue.blockedBy.filter((id) => id !== blocker.id),
                        })
                      }
                    >
                      <XIcon />
                    </Button>
                  ) : null
                }
              />
            ) : (
              <p key={issue.blockedBy[index]} className="text-sm text-muted-foreground">
                An issue this board cannot see
              </p>
            ),
          )
        )}
        {writable && candidates.length > 0 ? (
          <Select
            value={null}
            disabled={busy}
            onValueChange={(next) => {
              if (next) {
                void update({ blockedBy: [...issue.blockedBy, next as BacklogIssueId] });
              }
            }}
          >
            <SelectTrigger size="sm" aria-label="Add a blocker" className="w-auto self-start">
              <SelectValue placeholder="Add blocker…" />
            </SelectTrigger>
            <SelectPopup>
              {candidates.map((candidate) => (
                <SelectItem key={candidate.id} value={candidate.id}>
                  {candidate.key} · {candidate.title}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        ) : null}
      </Section>

      {issue.links.length > 0 ? (
        <Section title="Links">
          {issue.links.map((link) =>
            link.type === "thread" ? (
              <Button
                key={`thread:${link.environmentId}:${link.threadId}`}
                size="sm"
                variant="ghost"
                className="justify-start"
                onClick={() => openThread(link.environmentId, link.threadId)}
              >
                <MessageSquareIcon />
                <span className="truncate">Thread {link.threadId}</span>
              </Button>
            ) : (
              <Button
                key={`pr:${link.url}`}
                size="sm"
                variant="ghost"
                className="justify-start"
                onClick={() => openExternal(link.url)}
              >
                <PullRequestGlyph.pullRequest />
                <span className="min-w-0 truncate">{link.url}</span>
                <ExternalLinkIcon />
              </Button>
            ),
          )}
        </Section>
      ) : null}

      <Section title="Activity">
        {detail ? (
          <ol className="flex flex-col gap-3">
            {detail.activity.map((entry) => (
              <li key={entry.id} className="flex flex-col gap-1 text-sm">
                <div className="flex min-w-0 items-baseline gap-1.5">
                  <span className="truncate font-medium">{entry.actor.label}</span>
                  <span className="min-w-0 truncate text-muted-foreground">
                    {describeBacklogActivity(entry)}
                  </span>
                  <span className="ml-auto shrink-0 text-xs text-muted-foreground">
                    {formatRelativeTimeLabel(entry.at)}
                  </span>
                </div>
                {entry.kind === "commented" && entry.text ? (
                  <div className="rounded-lg border px-3 py-2">
                    <ChatMarkdown
                      text={entry.text}
                      cwd={undefined}
                      environmentId={environmentId}
                      lineBreaks
                    />
                  </div>
                ) : null}
              </li>
            ))}
          </ol>
        ) : (
          <Skeleton className="h-10 w-full" />
        )}
        {writable ? (
          <div className="flex flex-col gap-2">
            <Textarea
              size="sm"
              aria-label="Comment"
              placeholder="Leave a comment"
              value={commentDraft}
              onChange={(event) => setCommentDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                  event.preventDefault();
                  const text = commentDraft.trim();
                  if (text) {
                    void run(() => commands.comment(issue.id, text)).then(
                      (ok) => ok && setCommentDraft(""),
                    );
                  }
                }
              }}
            />
            <Button
              size="sm"
              variant="outline"
              className="self-end"
              disabled={busy || commentDraft.trim().length === 0}
              onClick={() => {
                const text = commentDraft.trim();
                void run(() => commands.comment(issue.id, text)).then(
                  (ok) => ok && setCommentDraft(""),
                );
              }}
            >
              Comment
            </Button>
          </div>
        ) : null}
      </Section>
    </div>
  );
}
