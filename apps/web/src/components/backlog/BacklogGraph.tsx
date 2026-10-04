import {
  isBacklogIssueBlocked,
  isBacklogStatusClosed,
  type BacklogIssue,
  type BacklogIssueId,
  type BacklogIssueStatus,
  type EnvironmentId,
} from "@t3tools/contracts";
import { BotIcon, LockIcon } from "lucide-react";
import { memo, useMemo, useState } from "react";

import { cn } from "../../lib/utils";
import { Switch } from "../ui/switch";
import {
  BACKLOG_STATUS_LABELS,
  boardIssueKey,
  type BacklogColumn,
  type BacklogSource,
} from "./backlog.logic";
import {
  BACKLOG_GRAPH_NODE_HEIGHT,
  BACKLOG_GRAPH_NODE_WIDTH,
  backlogGraphNodes,
  layoutBacklogGraph,
  type BacklogGraphIssue,
  type BacklogGraphLayoutEdge,
} from "./backlogGraph.logic";

const STATUS_DOT: Record<BacklogIssueStatus, string> = {
  inbox: "bg-muted-foreground/40",
  backlog: "bg-muted-foreground",
  ready: "bg-info",
  in_progress: "bg-warning",
  review: "bg-violet-500",
  done: "bg-success",
  wontfix: "bg-muted-foreground/30",
};

export interface BacklogGraphProps {
  /** The board's columns, already scoped and filtered; the graph shows the same issues. */
  readonly columns: ReadonlyArray<BacklogColumn>;
  readonly sources: ReadonlyArray<BacklogSource>;
  readonly selectedKey: string | null;
  readonly onOpen: (environmentId: EnvironmentId, issueId: BacklogIssueId) => void;
}

/** Blocked-by edges as a left-to-right graph with the critical path highlighted. Static, no motion. */
export function BacklogGraph({ columns, sources, selectedKey, onOpen }: BacklogGraphProps) {
  const [hideClosed, setHideClosed] = useState(false);

  // A pending drag shows in its target column before the server answers; draw that status too.
  const items = useMemo(
    () =>
      columns
        .filter((column) => !hideClosed || !isBacklogStatusClosed(column.status))
        .flatMap((column) =>
          column.issues.map((item): BacklogGraphIssue =>
            item.issue.status === column.status
              ? item
              : {
                  environmentId: item.environmentId,
                  issue: { ...item.issue, status: column.status },
                },
          ),
        ),
    [columns, hideClosed],
  );
  const layout = useMemo(() => layoutBacklogGraph(backlogGraphNodes(items)), [items]);
  const itemsByKey = useMemo(
    () => new Map(items.map((item) => [boardIssueKey(item.environmentId, item.issue.id), item])),
    [items],
  );
  const boardsByEnvironment = useMemo(
    () => new Map(sources.map((source) => [source.environmentId, source.board])),
    [sources],
  );
  const openKeys = useMemo(
    () => new Set(layout.nodes.filter((node) => node.open).map((node) => node.id)),
    [layout],
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2">
      <div className="flex items-center gap-4 px-5 text-xs text-muted-foreground sm:px-6">
        <span>
          {layout.criticalPath.length > 0
            ? `Critical path: ${layout.criticalPath.length} open issues`
            : "No open chains"}
        </span>
        <label className="ml-auto flex items-center gap-2">
          Hide closed
          <Switch size="sm" checked={hideClosed} onCheckedChange={setHideClosed} />
        </label>
      </div>
      <div className="min-h-0 flex-1 overflow-auto px-5 pb-4 sm:px-6">
        {layout.nodes.length === 0 ? (
          <p className="py-6 text-center text-sm text-muted-foreground">
            {hideClosed ? "Every issue here is closed." : "No issues yet."}
          </p>
        ) : (
          <div className="relative" style={{ width: layout.width, height: layout.height }}>
            <svg
              aria-hidden
              className="pointer-events-none absolute inset-0"
              width={layout.width}
              height={layout.height}
            >
              <defs>
                <marker
                  id="backlog-graph-arrow"
                  viewBox="0 0 8 8"
                  refX="8"
                  refY="4"
                  markerWidth="6"
                  markerHeight="6"
                  orient="auto"
                >
                  <path d="M0,0 L8,4 L0,8 z" className="fill-muted-foreground/60" />
                </marker>
                <marker
                  id="backlog-graph-arrow-critical"
                  viewBox="0 0 8 8"
                  refX="8"
                  refY="4"
                  markerWidth="6"
                  markerHeight="6"
                  orient="auto"
                >
                  <path d="M0,0 L8,4 L0,8 z" className="fill-primary" />
                </marker>
              </defs>
              {layout.edges.map((edge) => (
                <BacklogGraphEdgePath
                  key={`${edge.from}>${edge.to}`}
                  edge={edge}
                  satisfied={!openKeys.has(edge.from)}
                />
              ))}
            </svg>
            {layout.looseTop !== null ? (
              <p
                className="absolute left-4 text-xs text-muted-foreground"
                style={{ top: layout.looseTop }}
              >
                Not linked
              </p>
            ) : null}
            {layout.nodes.map((node) => {
              const item = itemsByKey.get(node.id);
              if (!item) return null;
              const board = boardsByEnvironment.get(item.environmentId);
              return (
                <BacklogGraphNode
                  key={node.id}
                  issue={item.issue}
                  environmentId={item.environmentId}
                  x={node.x}
                  y={node.y}
                  critical={node.critical}
                  blocked={board ? isBacklogIssueBlocked(item.issue, board.issuesById) : false}
                  selected={node.id === selectedKey}
                  onOpen={onOpen}
                />
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

function edgePath(edge: BacklogGraphLayoutEdge): string {
  // A back edge (only from a cycle) runs right to left; give it a wider bow so it reads as one.
  const bow = edge.x2 > edge.x1 ? Math.max(24, (edge.x2 - edge.x1) / 2) : 80;
  return `M${edge.x1},${edge.y1} C${edge.x1 + bow},${edge.y1} ${edge.x2 - bow},${edge.y2} ${edge.x2},${edge.y2}`;
}

function BacklogGraphEdgePath({
  edge,
  satisfied,
}: {
  edge: BacklogGraphLayoutEdge;
  satisfied: boolean;
}) {
  return (
    <path
      d={edgePath(edge)}
      fill="none"
      strokeWidth={edge.critical ? 2 : 1.25}
      strokeDasharray={edge.cyclic ? "4 3" : undefined}
      markerEnd={`url(#${edge.critical ? "backlog-graph-arrow-critical" : "backlog-graph-arrow"})`}
      className={cn(
        edge.critical
          ? "stroke-primary"
          : edge.cyclic
            ? "stroke-destructive"
            : "stroke-muted-foreground/60",
        satisfied && !edge.critical && "opacity-40",
      )}
    />
  );
}

const BacklogGraphNode = memo(function BacklogGraphNode({
  issue,
  environmentId,
  x,
  y,
  critical,
  blocked,
  selected,
  onOpen,
}: {
  issue: BacklogIssue;
  environmentId: EnvironmentId;
  x: number;
  y: number;
  critical: boolean;
  blocked: boolean;
  selected: boolean;
  onOpen: (environmentId: EnvironmentId, issueId: BacklogIssueId) => void;
}) {
  const closed = isBacklogStatusClosed(issue.status);
  const claimLabel = issue.claim?.actor.label ?? null;
  const description = [
    `${issue.key}: ${issue.title}`,
    BACKLOG_STATUS_LABELS[issue.status],
    blocked ? "blocked" : null,
    claimLabel ? `claimed by ${claimLabel}` : null,
    critical ? "on the critical path" : null,
  ]
    .filter((part) => part)
    .join(", ");
  return (
    <button
      type="button"
      onClick={() => onOpen(environmentId, issue.id)}
      aria-pressed={selected}
      aria-label={description}
      style={{
        left: x,
        top: y,
        width: BACKLOG_GRAPH_NODE_WIDTH,
        height: BACKLOG_GRAPH_NODE_HEIGHT,
      }}
      className={cn(
        "absolute flex flex-col justify-center gap-0.5 rounded-lg border bg-card px-2.5 text-left text-card-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring",
        selected ? "border-ring bg-accent" : "hover:bg-accent/50",
        critical && !selected && "border-primary",
        closed && "opacity-50",
      )}
    >
      <span className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
        <span
          aria-hidden
          className={cn("size-2 shrink-0 rounded-full", STATUS_DOT[issue.status])}
        />
        <span className="shrink-0 font-mono tabular-nums">{issue.key}</span>
        <span className="ml-auto flex shrink-0 items-center gap-1">
          {blocked ? <LockIcon aria-hidden className="size-3.5 text-warning-foreground" /> : null}
          {claimLabel ? <BotIcon aria-hidden className="size-3.5 text-info-foreground" /> : null}
        </span>
      </span>
      <span className="truncate text-sm">{issue.title}</span>
    </button>
  );
});
