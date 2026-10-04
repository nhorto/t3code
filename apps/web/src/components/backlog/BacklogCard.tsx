import { useDraggable } from "@dnd-kit/core";
import type {
  BacklogIssue,
  BacklogIssueId,
  BacklogIssuePriority,
  BacklogIssueStatus,
  BacklogIssueType,
  EnvironmentId,
} from "@t3tools/contracts";
import {
  BotIcon,
  BugIcon,
  LightbulbIcon,
  LockIcon,
  SparklesIcon,
  type LucideIcon,
} from "lucide-react";
import { memo, type KeyboardEvent } from "react";

import { cn } from "../../lib/utils";
import { Badge } from "../ui/badge";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { BACKLOG_PRIORITY_LABELS, BACKLOG_TYPE_LABELS, boardIssueKey } from "./backlog.logic";

export const BACKLOG_TYPE_ICONS: Record<BacklogIssueType, LucideIcon> = {
  idea: LightbulbIcon,
  bug: BugIcon,
  feature: SparklesIcon,
};

export function BacklogPriorityBadge({ priority }: { priority: BacklogIssuePriority | null }) {
  if (priority === null) return null;
  return (
    <Badge
      size="sm"
      variant={priority === "p0" ? "error" : priority === "p1" ? "warning" : "secondary"}
    >
      {BACKLOG_PRIORITY_LABELS[priority]}
    </Badge>
  );
}

export function BacklogTypeIcon({ type }: { type: BacklogIssueType }) {
  const Icon = BACKLOG_TYPE_ICONS[type];
  return <Icon aria-label={BACKLOG_TYPE_LABELS[type]} className="size-3.5 shrink-0" />;
}

/** What a drag carries: enough to send the move and to recognise the server's answer. */
export interface BacklogDragData {
  readonly environmentId: EnvironmentId;
  readonly issue: BacklogIssue;
  /** The column the card is drawn in: a pending move's status before the server answers. */
  readonly status: BacklogIssueStatus;
}

export interface BacklogCardProps {
  readonly issue: BacklogIssue;
  readonly environmentId: EnvironmentId;
  /** Set when the board mixes machines. */
  readonly machineLabel: string | null;
  /** Open blockers, comma separated; empty when unblocked. */
  readonly blockerKeys: string;
  readonly childClosed: number;
  readonly childTotal: number;
  /** "agent label · machine" for a claimed issue. */
  readonly claimLabel: string | null;
  /** The column the card is drawn in. */
  readonly status: BacklogIssueStatus;
  readonly selected: boolean;
  readonly readOnly: boolean;
  readonly onOpen: (environmentId: EnvironmentId, issueId: BacklogIssueId) => void;
}

/** The card body, shared by the board and the drag overlay. */
export function BacklogCardContent({
  issue,
  machineLabel,
  blockerKeys,
  childClosed,
  childTotal,
  claimLabel,
}: Pick<
  BacklogCardProps,
  "issue" | "machineLabel" | "blockerKeys" | "childClosed" | "childTotal" | "claimLabel"
>) {
  return (
    <>
      <div className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
        <BacklogTypeIcon type={issue.type} />
        <span className="shrink-0 font-mono tabular-nums">{issue.key}</span>
        <BacklogPriorityBadge priority={issue.priority} />
        {machineLabel ? <span className="ml-auto min-w-0 truncate">{machineLabel}</span> : null}
      </div>
      <p className="line-clamp-3 text-sm text-foreground">{issue.title}</p>
      {blockerKeys || claimLabel || childTotal > 0 ? (
        <div className="flex min-w-0 flex-wrap items-center gap-1">
          {blockerKeys ? (
            <Badge size="sm" variant="warning" aria-label={`Blocked by ${blockerKeys}`}>
              <LockIcon aria-hidden />
              <span className="truncate">Blocked by {blockerKeys}</span>
            </Badge>
          ) : null}
          {claimLabel ? (
            <Tooltip>
              <TooltipTrigger
                render={<Badge size="sm" variant="info" aria-label={`Claimed by ${claimLabel}`} />}
              >
                <BotIcon aria-hidden />
                <span className="truncate">{claimLabel}</span>
              </TooltipTrigger>
              <TooltipPopup>
                Held by {claimLabel}. Release it to Ready from the issue to move it.
              </TooltipPopup>
            </Tooltip>
          ) : null}
          {childTotal > 0 ? (
            <Badge
              size="sm"
              variant={childClosed === childTotal ? "success" : "secondary"}
              aria-label={`${childClosed} of ${childTotal} children closed`}
            >
              {childClosed}/{childTotal}
            </Badge>
          ) : null}
        </div>
      ) : null}
    </>
  );
}

const CARD_CLASS =
  "flex w-full min-w-0 flex-col gap-1.5 rounded-lg border bg-card p-2.5 text-left text-card-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring";

export function BacklogCardOverlay(
  props: Omit<BacklogCardProps, "status" | "selected" | "readOnly" | "onOpen">,
) {
  return (
    <div className={cn(CARD_CLASS, "cursor-grabbing shadow-lg")}>
      <BacklogCardContent {...props} />
    </div>
  );
}

export const BacklogCard = memo(function BacklogCard({
  status,
  selected,
  readOnly,
  onOpen,
  ...content
}: BacklogCardProps) {
  const { issue, environmentId, claimLabel } = content;
  // A claimed card belongs to its agent; Release to Ready in the issue is the way to take it back.
  const held = claimLabel !== null;
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: boardIssueKey(environmentId, issue.id),
    data: { environmentId, issue, status } satisfies BacklogDragData,
    disabled: readOnly || held,
  });
  const open = () => onOpen(environmentId, issue.id);
  return (
    <div
      ref={setNodeRef}
      {...attributes}
      {...listeners}
      // dnd-kit's keyboard activator owns Space; Enter opens the issue.
      onKeyDown={(event: KeyboardEvent<HTMLDivElement>) => {
        if (event.key === "Enter") {
          event.preventDefault();
          open();
          return;
        }
        listeners?.onKeyDown?.(event);
      }}
      onClick={open}
      aria-pressed={selected}
      aria-label={
        held
          ? `${issue.key}: ${issue.title}. Held by ${claimLabel}; release it to Ready to move it`
          : `${issue.key}: ${issue.title}`
      }
      className={cn(
        CARD_CLASS,
        // Offscreen cards skip style, layout and paint, so a long column costs what is visible.
        "[contain-intrinsic-size:auto_76px] [content-visibility:auto]",
        readOnly || held ? "cursor-pointer" : "cursor-grab",
        selected ? "border-ring bg-accent" : "hover:bg-accent/50",
        isDragging && "opacity-40",
      )}
    >
      <BacklogCardContent {...content} />
    </div>
  );
});
