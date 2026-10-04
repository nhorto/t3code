import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { isAtomCommandInterrupted } from "@t3tools/client-runtime/state/runtime";
import type { AgentMessageId, EnvironmentId, ThreadId } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { ArrowRightIcon, MessagesSquareIcon, XIcon } from "lucide-react";
import { useCallback, useMemo, useState } from "react";

import { agentMessageEnvironment, useAgentMessageFeeds } from "../../state/agentMessages";
import { backlogFailureMessage } from "../../state/backlog";
import { useEnvironments } from "../../state/environments";
import { useAtomCommand } from "../../state/use-atom-command";
import { buildThreadRouteParams } from "../../threadRoutes";
import { formatRelativeTimeLabel } from "../../timestampFormat";
import { Badge } from "../ui/badge";
import { Button, InlineButton } from "../ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "../ui/empty";
import { stackedThreadToast, toastManager } from "../ui/toast";
import {
  AGENT_MESSAGE_STATUS_LABELS,
  agentMessageMachineLabel,
  agentMessagePreview,
  buildAgentMessageFeed,
  canActOnAgentMessage,
  type AgentMessageRow,
} from "./agentMessages.logic";

const STATUS_BADGE = {
  pending: "outline",
  delivered: "secondary",
  held: "warning",
  released: "info",
  dismissed: "outline",
  failed: "error",
} as const;

/** Every agent-to-agent message across connected machines; held ones wait here for the user. */
export function BacklogMessagesPanel({ onClose }: { readonly onClose: () => void }) {
  const navigate = useNavigate();
  const feeds = useAgentMessageFeeds();
  const { environments } = useEnvironments();
  const view = useMemo(() => {
    const labels = new Map(
      environments.map((environment) => [environment.environmentId, environment.label] as const),
    );
    return buildAgentMessageFeed({
      sources: feeds,
      machineLabel: (environmentId) => labels.get(environmentId) ?? "Unknown machine",
    });
  }, [environments, feeds]);
  const loading = feeds.length > 0 && feeds.every((feed) => feed.feed === null && !feed.error);
  const errors = feeds.filter((feed) => feed.error !== null);

  const openThread = useCallback(
    (environmentId: EnvironmentId, threadId: ThreadId) =>
      void navigate({
        to: "/$environmentId/$threadId",
        params: buildThreadRouteParams(scopeThreadRef(environmentId, threadId)),
      }),
    [navigate],
  );

  return (
    <aside
      aria-label="Agent messages"
      className="absolute inset-0 z-10 flex min-h-0 flex-col border-l bg-background md:static md:w-md md:shrink-0 lg:w-lg"
    >
      <div className="flex shrink-0 items-center gap-2 border-b px-4 py-2">
        <h2 className="text-sm font-medium">Messages</h2>
        <Button
          size="icon-sm"
          variant="ghost"
          className="ml-auto"
          aria-label="Close messages"
          onClick={onClose}
        >
          <XIcon />
        </Button>
      </div>
      <div className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto p-4">
        {errors.map((feed) => (
          <p key={feed.environmentId} className="text-xs text-muted-foreground">
            Could not read messages on{" "}
            {environments.find((environment) => environment.environmentId === feed.environmentId)
              ?.label ?? "a machine"}
            : {feed.error}
          </p>
        ))}
        {view.held.length > 0 ? (
          <section className="flex flex-col gap-2">
            <h3 className="text-xs font-medium text-muted-foreground">
              Held for you · over 10 agent wakes an hour
            </h3>
            {view.held.map((row) => (
              <AgentMessageItem
                key={row.key}
                row={row}
                onOpenThread={openThread}
                actions={canActOnAgentMessage(row)}
              />
            ))}
          </section>
        ) : null}
        {view.recent.length > 0 ? (
          <section className="flex flex-col gap-2">
            {view.held.length > 0 ? (
              <h3 className="text-xs font-medium text-muted-foreground">Recent</h3>
            ) : null}
            {view.recent.map((row) => (
              <AgentMessageItem key={row.key} row={row} onOpenThread={openThread} />
            ))}
          </section>
        ) : null}
        {!loading && view.held.length === 0 && view.recent.length === 0 ? (
          <Empty>
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <MessagesSquareIcon />
              </EmptyMedia>
              <EmptyTitle>No agent messages yet</EmptyTitle>
              <EmptyDescription>
                Agents message each other with agent_message, for example to ask the holder of an
                issue a question.
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : null}
      </div>
    </aside>
  );
}

function AgentMessageItem({
  row,
  onOpenThread,
  actions = false,
}: {
  readonly row: AgentMessageRow;
  readonly onOpenThread: (environmentId: EnvironmentId, threadId: ThreadId) => void;
  readonly actions?: boolean;
}) {
  const { message } = row;
  const [pending, setPending] = useState(false);
  const release = useAtomCommand(agentMessageEnvironment.release, {
    label: "agent message release",
    reportFailure: false,
  });
  const dismiss = useAtomCommand(agentMessageEnvironment.dismiss, {
    label: "agent message dismiss",
    reportFailure: false,
  });
  const act = async (
    command: typeof release,
    id: AgentMessageId,
    failureTitle: string,
  ): Promise<void> => {
    setPending(true);
    const result = await command({ environmentId: row.environmentId, input: { id } });
    setPending(false);
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: failureTitle,
          description: backlogFailureMessage(result),
        }),
      );
    }
  };

  return (
    <div className="flex flex-col gap-1.5 rounded-lg border px-3 py-2">
      <div className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-xs">
        <InlineButton
          onClick={() => onOpenThread(message.from.environmentId, message.from.threadId)}
        >
          {message.from.label}
        </InlineButton>
        <ArrowRightIcon aria-label="to" className="size-3 text-muted-foreground" />
        <InlineButton onClick={() => onOpenThread(message.to.environmentId, message.to.threadId)}>
          {message.to.label}
        </InlineButton>
        {message.issueKey ? (
          <span className="font-mono text-muted-foreground">{message.issueKey}</span>
        ) : null}
        {message.urgent ? <Badge variant="warning">Urgent</Badge> : null}
        <Badge variant={STATUS_BADGE[message.status]}>
          {AGENT_MESSAGE_STATUS_LABELS[message.status]}
        </Badge>
      </div>
      <p className="text-sm">{agentMessagePreview(message.text)}</p>
      {message.error ? <p className="text-xs text-destructive">{message.error}</p> : null}
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <span>
          {agentMessageMachineLabel(row)} · {formatRelativeTimeLabel(message.createdAt)}
        </span>
        {actions ? (
          <span className="ml-auto flex items-center gap-2">
            <Button
              size="xs"
              variant="ghost-muted"
              disabled={pending}
              onClick={() => void act(dismiss, message.id, "Could not dismiss the message")}
            >
              Dismiss
            </Button>
            <Button
              size="xs"
              disabled={pending}
              onClick={() => void act(release, message.id, "Could not release the message")}
            >
              Release
            </Button>
          </span>
        ) : null}
      </div>
    </div>
  );
}
