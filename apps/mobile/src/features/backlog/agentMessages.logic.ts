import type { AgentMessage, AgentMessageStatus, EnvironmentId } from "@t3tools/contracts";
import * as Cause from "effect/Cause";

export interface AgentMessageFeedSource {
  readonly environmentId: EnvironmentId;
  readonly feed: { readonly messages: ReadonlyArray<AgentMessage> } | null;
  readonly error: string | null;
  /** The server predates agent messages: it does not know the RPCs at all. */
  readonly unsupported: boolean;
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

const UNKNOWN_AGENT_MESSAGE_RPC = /Unknown request tag: agentMessages\./;

/**
 * Whether an agent message RPC failed because the server predates agent messages. Effect's
 * RpcServer answers an unknown tag with a defect, so an older server reads as unsupported.
 */
export function isAgentMessagesUnsupportedCause(cause: Cause.Cause<unknown>): boolean {
  return cause.reasons.some((reason) => {
    if (!Cause.isDieReason(reason)) return false;
    const defect = reason.defect;
    const message =
      typeof defect === "string" ? defect : defect instanceof Error ? defect.message : null;
    return message !== null && UNKNOWN_AGENT_MESSAGE_RPC.test(message);
  });
}

const byCreated = (left: AgentMessageRow, right: AgentMessageRow) =>
  left.message.createdAt === right.message.createdAt
    ? 0
    : left.message.createdAt < right.message.createdAt
      ? -1
      : 1;

/**
 * One feed across every connected machine. A message relayed between machines keeps its id on
 * both, so it shows once: the receiving machine's copy wins, since it knows whether the message
 * was delivered or held and is the one that can release it.
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
  const held: AgentMessageRow[] = [];
  const recent: AgentMessageRow[] = [];
  for (const row of byId.values()) {
    (row.message.status === "held" ? held : recent).push(row);
  }
  held.sort(byCreated);
  recent.sort((left, right) => byCreated(right, left));
  return { held, recent };
}

/** Where the message was logged, and the sender's machine when it came from another one. */
export function agentMessageMachineLabel(row: AgentMessageRow): string {
  const sender = row.message.from.machine;
  return sender && sender !== row.machineLabel
    ? `${sender} → ${row.machineLabel}`
    : row.machineLabel;
}

/** The message on one line, cut at a word near the limit. */
export function agentMessagePreview(text: string, limit = 200): string {
  const line = text.replace(/\s+/g, " ").trim();
  if (line.length <= limit) return line;
  const cut = line.slice(0, limit);
  const space = cut.lastIndexOf(" ");
  return `${(space > limit * 0.6 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

export function heldAgentMessagesSummary(count: number): string {
  return count === 1
    ? "1 agent message is held for you"
    : `${count} agent messages are held for you`;
}

export type AgentMessageListItem =
  | {
      readonly type: "section";
      readonly key: string;
      readonly label: string;
      readonly count: number;
    }
  | {
      readonly type: "message";
      readonly key: string;
      readonly row: AgentMessageRow;
      readonly held: boolean;
      readonly isFirst: boolean;
      readonly isLast: boolean;
    };

/** Flat list rows: held messages first, then recent, each under a header when both exist. */
export function buildAgentMessageListItems(view: AgentMessageFeedView): AgentMessageListItem[] {
  const items: AgentMessageListItem[] = [];
  const pushGroup = (rows: ReadonlyArray<AgentMessageRow>, held: boolean) =>
    rows.forEach((row, index) =>
      items.push({
        type: "message",
        key: row.key,
        row,
        held,
        isFirst: index === 0,
        isLast: index === rows.length - 1,
      }),
    );
  if (view.held.length > 0) {
    items.push({
      type: "section",
      key: "section:held",
      label: "Held for you",
      count: view.held.length,
    });
    pushGroup(view.held, true);
  }
  if (view.recent.length > 0) {
    if (view.held.length > 0) {
      items.push({
        type: "section",
        key: "section:recent",
        label: "Recent",
        count: view.recent.length,
      });
    }
    pushGroup(view.recent, false);
  }
  return items;
}

export interface AgentMessageEnvironment {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly connected: boolean;
}

export interface AgentMessageEnvironmentNotice {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly message: string;
}

/**
 * Honest status for each environment the feed covers: notices for failed or offline ones,
 * the names of servers without agent messages, and whether a connected one is still loading.
 */
export function describeAgentMessageEnvironments(input: {
  readonly environments: ReadonlyArray<AgentMessageEnvironment>;
  readonly sources: ReadonlyArray<AgentMessageFeedSource>;
}): {
  readonly notices: ReadonlyArray<AgentMessageEnvironmentNotice>;
  readonly unsupportedLabels: ReadonlyArray<string>;
  readonly loading: boolean;
} {
  const sourceById = new Map(input.sources.map((source) => [source.environmentId, source]));
  const notices: AgentMessageEnvironmentNotice[] = [];
  const unsupportedLabels: string[] = [];
  let loading = false;
  for (const environment of input.environments) {
    const source = sourceById.get(environment.environmentId);
    if (source === undefined) continue;
    if (source.unsupported) {
      unsupportedLabels.push(environment.label);
      continue;
    }
    const base = { environmentId: environment.environmentId, label: environment.label };
    if (source.error !== null) {
      notices.push({ ...base, message: source.error });
    } else if (!environment.connected) {
      notices.push({
        ...base,
        message:
          source.feed === null
            ? "Unavailable until it reconnects."
            : "Offline. Showing its last messages.",
      });
    } else if (source.feed === null) {
      loading = true;
    }
  }
  return { notices, unsupportedLabels, loading };
}
