import { LegendList } from "@legendapp/list/react-native";
import { useNavigation } from "@react-navigation/native";
import type { AgentMessageStatus, EnvironmentId, ThreadId } from "@t3tools/contracts";
import { useCallback, useMemo, useState } from "react";
import { ActivityIndicator, Alert, Pressable, View } from "react-native";

import { AppText as Text } from "../../components/AppText";
import { SymbolView } from "../../components/AppSymbol";
import { ControlPill } from "../../components/ControlPill";
import { EmptyState } from "../../components/EmptyState";
import { ScreenHeader } from "../../components/ScreenHeader";
import { StatusPill, type StatusTone } from "../../components/StatusPill";
import { cn } from "../../lib/cn";
import { relativeTime } from "../../lib/time";
import { agentMessageEnvironment } from "../../state/agentMessages";
import { useEnvironments } from "../../state/environments";
import { useAtomCommand } from "../../state/use-atom-command";
import { SettingsScreenContent } from "../settings/components/SettingsScreen";
import {
  AGENT_MESSAGE_STATUS_LABELS,
  agentMessageMachineLabel,
  agentMessagePreview,
  buildAgentMessageFeed,
  buildAgentMessageListItems,
  describeAgentMessageEnvironments,
  type AgentMessageListItem,
  type AgentMessageRow,
} from "./agentMessages.logic";
import { alertBacklogFailure, BacklogSectionHeader } from "./backlog-components";
import { useAgentMessageFeeds } from "./useAgentMessages";

const STATUS_TONES: Record<AgentMessageStatus, Omit<StatusTone, "label">> = {
  pending: { pillClassName: "bg-subtle", textClassName: "text-foreground-muted" },
  delivered: { pillClassName: "bg-subtle", textClassName: "text-foreground-muted" },
  held: { pillClassName: "bg-warning", textClassName: "text-warning-foreground" },
  released: {
    pillClassName: "bg-adaptive-emerald-500-a12-a16",
    textClassName: "text-adaptive-emerald-700-300",
  },
  dismissed: { pillClassName: "bg-subtle", textClassName: "text-foreground-tertiary" },
  failed: { pillClassName: "bg-danger", textClassName: "text-danger-foreground" },
};

/** Every agent-to-agent message across connected machines; held ones wait here for the user. */
export function BacklogMessagesRouteScreen() {
  const navigation = useNavigation();
  const feeds = useAgentMessageFeeds();
  const { environments } = useEnvironments();
  const labelById = useMemo(
    () =>
      new Map(
        environments.map((environment) => [environment.environmentId, environment.label] as const),
      ),
    [environments],
  );
  const view = useMemo(
    () =>
      buildAgentMessageFeed({
        sources: feeds,
        machineLabel: (environmentId) => labelById.get(environmentId) ?? "Unknown machine",
      }),
    [feeds, labelById],
  );
  const items = useMemo(() => buildAgentMessageListItems(view), [view]);
  const status = useMemo(
    () =>
      describeAgentMessageEnvironments({
        environments: environments.map((environment) => ({
          environmentId: environment.environmentId,
          label: environment.label,
          connected: environment.connection.phase === "connected",
        })),
        sources: feeds,
      }),
    [environments, feeds],
  );

  const release = useAtomCommand(agentMessageEnvironment.release, {
    label: "agent message release",
    reportFailure: false,
  });
  const dismiss = useAtomCommand(agentMessageEnvironment.dismiss, {
    label: "agent message dismiss",
    reportFailure: false,
  });
  const [pendingKeys, setPendingKeys] = useState<ReadonlySet<string>>(() => new Set());
  const act = useCallback(
    async (row: AgentMessageRow, command: typeof release, failureTitle: string) => {
      setPendingKeys((current) => new Set(current).add(row.key));
      try {
        const result = await command({
          environmentId: row.environmentId,
          input: { id: row.message.id },
        });
        alertBacklogFailure(failureTitle, result);
      } finally {
        setPendingKeys((current) => {
          const next = new Set(current);
          next.delete(row.key);
          return next;
        });
      }
    },
    [],
  );
  const releaseRow = useCallback(
    (row: AgentMessageRow) => void act(row, release, "Could not release the message"),
    [act, release],
  );
  const dismissRow = useCallback(
    (row: AgentMessageRow) =>
      Alert.alert(
        "Dismiss message?",
        `${row.message.from.label}'s message is dropped and never reaches ${row.message.to.label}.`,
        [
          { text: "Cancel", style: "cancel" },
          {
            text: "Dismiss",
            style: "destructive",
            onPress: () => void act(row, dismiss, "Could not dismiss the message"),
          },
        ],
      ),
    [act, dismiss],
  );
  const openThread = useCallback(
    (environmentId: EnvironmentId, threadId: ThreadId) =>
      navigation.navigate("Thread", { environmentId, threadId }),
    [navigation],
  );

  const renderItem = useCallback(
    ({ item }: { item: AgentMessageListItem }) =>
      item.type === "section" ? (
        <BacklogSectionHeader
          label={item.label}
          count={item.count}
          collapsed={null}
          onToggle={() => undefined}
        />
      ) : (
        <AgentMessageItem
          item={item}
          pending={pendingKeys.has(item.key)}
          onOpenThread={openThread}
          onRelease={releaseRow}
          onDismiss={dismissRow}
        />
      ),
    [dismissRow, openThread, pendingKeys, releaseRow],
  );

  const listEmpty = status.loading ? (
    <View className="items-center py-16">
      <ActivityIndicator colorClassName="accent-icon" />
      <Text className="mt-3 text-sm text-foreground-muted">Loading messages…</Text>
    </View>
  ) : (
    <EmptyState
      title="No agent messages yet"
      detail="Agents message each other with agent_message, for example to ask the holder of an issue a question. Messages over 10 agent wakes an hour wait here for you."
    />
  );

  return (
    <View collapsable={false} className="flex-1 bg-sheet">
      <ScreenHeader
        title="Messages"
        subtitle={view.held.length > 0 ? `${view.held.length} held` : undefined}
        onBack={navigation.canGoBack() ? () => navigation.goBack() : undefined}
      />
      <SettingsScreenContent>
        <LegendList
          className="flex-1"
          contentContainerStyle={{ paddingBottom: 32, paddingHorizontal: 16, paddingTop: 4 }}
          contentInsetAdjustmentBehavior="automatic"
          data={items}
          estimatedItemSize={96}
          extraData={pendingKeys}
          getItemType={(item) => (item.type === "section" ? "section" : "message")}
          keyExtractor={(item) => item.key}
          ListEmptyComponent={listEmpty}
          ListHeaderComponent={
            <AgentMessagesHeader
              notices={status.notices}
              unsupportedLabels={status.unsupportedLabels}
              heldCount={view.held.length}
            />
          }
          renderItem={renderItem}
          showsVerticalScrollIndicator={false}
        />
      </SettingsScreenContent>
    </View>
  );
}

function AgentMessagesHeader(props: {
  readonly notices: ReturnType<typeof describeAgentMessageEnvironments>["notices"];
  readonly unsupportedLabels: ReadonlyArray<string>;
  readonly heldCount: number;
}) {
  if (props.notices.length === 0 && props.unsupportedLabels.length === 0 && props.heldCount === 0) {
    return null;
  }
  return (
    <View className="gap-3 pt-2">
      {props.notices.map((notice) => (
        <View
          key={notice.environmentId}
          className="flex-row items-center gap-2 rounded-[16px] bg-subtle px-3 py-2"
        >
          <SymbolView
            name="wifi.slash"
            size={13}
            tintColorClassName="accent-icon-subtle"
            type="monochrome"
          />
          <Text className="min-w-0 flex-1 text-xs text-foreground-muted" numberOfLines={2}>
            <Text className="text-xs font-t3-bold text-foreground">{notice.label}</Text>
            {`  ${notice.message}`}
          </Text>
        </View>
      ))}
      {props.unsupportedLabels.length > 0 ? (
        <Text className="px-1 text-xs text-foreground-tertiary">
          {`${props.unsupportedLabels.join(", ")} ${props.unsupportedLabels.length > 1 ? "don't" : "doesn't"} support agent messages yet.`}
        </Text>
      ) : null}
      {props.heldCount > 0 ? (
        <Text className="px-1 text-xs text-foreground-muted">
          Each thread takes at most 10 agent wakes an hour. Release a held message to deliver it
          now, or dismiss it.
        </Text>
      ) : null}
    </View>
  );
}

function ThreadLink(props: {
  readonly label: string;
  readonly role: "From" | "To";
  readonly onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="link"
      accessibilityLabel={`${props.role} ${props.label}, open thread`}
      hitSlop={8}
      onPress={props.onPress}
      className="max-w-[45%] shrink active:opacity-60"
    >
      <Text className="text-sm font-t3-medium text-primary" numberOfLines={1}>
        {props.label}
      </Text>
    </Pressable>
  );
}

function AgentMessageItem(props: {
  readonly item: Extract<AgentMessageListItem, { type: "message" }>;
  readonly pending: boolean;
  readonly onOpenThread: (environmentId: EnvironmentId, threadId: ThreadId) => void;
  readonly onRelease: (row: AgentMessageRow) => void;
  readonly onDismiss: (row: AgentMessageRow) => void;
}) {
  const { row, held } = props.item;
  const { message } = row;
  return (
    <View
      className={cn(
        "gap-1.5 bg-grouped-card px-4 py-3",
        props.item.isFirst && "rounded-t-[20px]",
        props.item.isLast ? "rounded-b-[20px]" : "border-b border-separator",
      )}
    >
      <View className="flex-row items-center gap-1.5">
        <ThreadLink
          role="From"
          label={message.from.label}
          onPress={() => props.onOpenThread(message.from.environmentId, message.from.threadId)}
        />
        <SymbolView
          name="arrow.right"
          size={11}
          tintColorClassName="accent-icon-subtle"
          type="monochrome"
        />
        <ThreadLink
          role="To"
          label={message.to.label}
          onPress={() => props.onOpenThread(message.to.environmentId, message.to.threadId)}
        />
      </View>
      <View className="flex-row flex-wrap items-center gap-1.5">
        {message.issueKey ? (
          <Text className="font-mono text-2xs text-foreground-tertiary">{message.issueKey}</Text>
        ) : null}
        {message.urgent ? (
          <StatusPill
            size="compact"
            label="Urgent"
            pillClassName="bg-warning"
            textClassName="text-warning-foreground"
          />
        ) : null}
        <StatusPill
          size="compact"
          label={AGENT_MESSAGE_STATUS_LABELS[message.status]}
          {...STATUS_TONES[message.status]}
        />
      </View>
      <Text className="text-sm leading-snug text-foreground" numberOfLines={held ? 6 : 3}>
        {agentMessagePreview(message.text)}
      </Text>
      {message.error ? (
        <Text className="text-xs text-danger" numberOfLines={2}>
          {message.error}
        </Text>
      ) : null}
      <Text className="text-2xs text-foreground-tertiary">
        {`${agentMessageMachineLabel(row)} · ${relativeTime(message.createdAt)}`}
      </Text>
      {held ? (
        <View className="flex-row justify-end gap-2 pt-1">
          <ControlPill
            variant="pill"
            label="Dismiss"
            disabled={props.pending}
            onPress={() => props.onDismiss(row)}
          />
          <ControlPill
            variant="primary"
            label="Release"
            disabled={props.pending}
            onPress={() => props.onRelease(row)}
          />
        </View>
      ) : null}
    </View>
  );
}
