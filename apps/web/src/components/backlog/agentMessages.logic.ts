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
  pending: "Sending",
  delivered: "Delivered",
  held: "Held",
  released: "Released",
  dismissed: "Dismissed",
  failed: "Failed",
};

/**
 * One feed across every connected machine. A message relayed between machines
 * keeps its id on both, so it shows once: the receiving machine's copy wins,
 * since it knows whether the message was delivered or held and is the one that
 * can release it.
 */
export function buildAgentMessageFeed(input: {
  readonly sources: ReadonlyArray<AgentMessageFeedSource>;
  readonly machineLabel: (environmentId: EnvironmentId) => string;
}): AgentMessageFeedView {
  const byId = new Map<string, AgentMessageRow>();
  for (const source of input.sources) {
    if (source.feed === null) continue;
    const machineLabel = input.machineLabel(source.environmentId);
    for (const message of source.feed.messages) {
      if (byId.has(message.id) && source.environmentId !== message.to.environmentId) continue;
      byId.set(message.id, {
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
  const rows = [...byId.values()];
  return {
    held: rows.filter((row) => row.message.status === "held").toSorted(byCreated),
    recent: rows
      .filter((row) => row.message.status !== "held")
      .toSorted((left, right) => byCreated(right, left)),
  };
}

/** Only the receiving machine's copy of a held message can be released or dismissed. */
export function canActOnAgentMessage(row: AgentMessageRow): boolean {
  return row.message.status === "held" && row.environmentId === row.message.to.environmentId;
}

/** Held messages across machines, counting a relayed message once. */
export function countHeldAgentMessageRows(sources: ReadonlyArray<AgentMessageFeedSource>): number {
  const held = new Set<string>();
  for (const source of sources) {
    for (const message of source.feed?.messages ?? []) {
      if (message.status === "held") held.add(message.id);
    }
  }
  return held.size;
}

/** Where the message was logged, and the sender's machine when it came from another one. */
export function agentMessageMachineLabel(row: AgentMessageRow): string {
  const sender = row.message.from.machine;
  return sender && sender !== row.machineLabel
    ? `${sender} → ${row.machineLabel}`
    : row.machineLabel;
}

/** The message on one line, cut at a word near the limit. */
export function agentMessagePreview(text: string, limit = 160): string {
  const line = text.replace(/\s+/g, " ").trim();
  if (line.length <= limit) return line;
  const cut = line.slice(0, limit);
  const space = cut.lastIndexOf(" ");
  return `${(space > limit * 0.6 ? cut.slice(0, space) : cut).trimEnd()}…`;
}
