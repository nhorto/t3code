import type { AgentMessage, AgentMessageStatus, EnvironmentId } from "@t3tools/contracts";

export interface AgentMessageFeedSource {
  readonly environmentId: EnvironmentId;
  readonly feed: { readonly messages: ReadonlyArray<AgentMessage> } | null;
}

export interface AgentMessageRow {
  readonly key: string;
  /** The environment that logged the message and can release it. */
  readonly environmentId: EnvironmentId;
  readonly machineLabel: string;
  readonly message: AgentMessage;
}

export interface AgentMessageFeedView {
  /** Waiting for the user, oldest first: the order they would be delivered in. */
  readonly held: ReadonlyArray<AgentMessageRow>;
  /** Everything else, newest first. */
  readonly recent: ReadonlyArray<AgentMessageRow>;
}

export const AGENT_MESSAGE_STATUS_LABELS: Record<AgentMessageStatus, string> = {
  delivered: "Delivered",
  held: "Held",
  released: "Released",
  dismissed: "Dismissed",
  failed: "Failed",
};

/** One feed across every connected machine. */
export function buildAgentMessageFeed(input: {
  readonly sources: ReadonlyArray<AgentMessageFeedSource>;
  readonly machineLabel: (environmentId: EnvironmentId) => string;
}): AgentMessageFeedView {
  const rows: AgentMessageRow[] = [];
  for (const source of input.sources) {
    if (source.feed === null) continue;
    const machineLabel = input.machineLabel(source.environmentId);
    for (const message of source.feed.messages) {
      rows.push({
        key: `${source.environmentId}:${message.id}`,
        environmentId: source.environmentId,
        machineLabel,
        message,
      });
    }
  }
  const byCreated = (left: AgentMessageRow, right: AgentMessageRow) =>
    left.message.createdAt === right.message.createdAt
      ? 0
      : left.message.createdAt < right.message.createdAt
        ? -1
        : 1;
  return {
    held: rows.filter((row) => row.message.status === "held").toSorted(byCreated),
    recent: rows
      .filter((row) => row.message.status !== "held")
      .toSorted((left, right) => byCreated(right, left)),
  };
}

export function countHeldAgentMessageRows(sources: ReadonlyArray<AgentMessageFeedSource>): number {
  let count = 0;
  for (const source of sources) {
    for (const message of source.feed?.messages ?? []) {
      if (message.status === "held") count++;
    }
  }
  return count;
}

/** The message on one line, cut at a word near the limit. */
export function agentMessagePreview(text: string, limit = 160): string {
  const line = text.replace(/\s+/g, " ").trim();
  if (line.length <= limit) return line;
  const cut = line.slice(0, limit);
  const space = cut.lastIndexOf(" ");
  return `${(space > limit * 0.6 ? cut.slice(0, space) : cut).trimEnd()}…`;
}
