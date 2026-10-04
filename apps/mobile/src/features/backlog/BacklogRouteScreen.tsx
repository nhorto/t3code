import { LegendList } from "@legendapp/list/react-native";
import { useNavigation, type StaticScreenProps } from "@react-navigation/native";
import type { BacklogIssueStatus, BacklogIssueType } from "@t3tools/contracts";
import { useCallback, useMemo, useState } from "react";
import { ActivityIndicator, Pressable, View } from "react-native";

import { AppText as Text } from "../../components/AppText";
import { SymbolView } from "../../components/AppSymbol";
import { ControlPillMenu } from "../../components/ControlPill";
import { EmptyState } from "../../components/EmptyState";
import { ScreenHeader } from "../../components/ScreenHeader";
import { SettingsScreenContent } from "../settings/components/SettingsScreen";
import {
  BACKLOG_TYPE_LABELS,
  BACKLOG_TYPES,
  buildBacklogListItems,
  defaultQuickAddScopeKey,
  filterBacklogIssues,
  findBacklogScopeForProject,
  parseBacklogProjectRef,
  resolveBacklogCreateTarget,
  resolveBacklogScope,
  selectBacklogScopeIssues,
  type BacklogListItem,
} from "./backlog.logic";
import { heldAgentMessagesSummary } from "./agentMessages.logic";
import { BacklogIssueRow, BacklogSectionHeader } from "./backlog-components";
import { useHeldAgentMessageCount } from "./useAgentMessages";
import { useBacklogBoards, type BacklogEnvironmentNotice } from "./useBacklogBoards";

export type BacklogRouteParams = {
  /** A picker key such as "inbox" or "project:<group key>". */
  readonly scope?: string;
  /** Open the backlog of the project with this checkout. */
  readonly environmentId?: string;
  readonly projectId?: string;
};

export function BacklogRouteScreen({ route }: StaticScreenProps<BacklogRouteParams | undefined>) {
  const navigation = useNavigation();
  const {
    boards,
    scopes,
    issuesById,
    notices,
    unsupportedLabels,
    connectedEnvironmentIds,
    environmentAvailability,
    environmentLabel,
    isLoading,
  } = useBacklogBoards();
  const heldMessageCount = useHeldAgentMessageCount();
  const openMessages = useCallback(() => navigation.navigate("BacklogMessages"), [navigation]);
  const [selectedScopeKey, setSelectedScopeKey] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [typeFilter, setTypeFilter] = useState<BacklogIssueType | null>(null);
  const [expandedClosedStatuses, setExpandedClosedStatuses] = useState<
    ReadonlySet<BacklogIssueStatus>
  >(() => new Set());
  const requestedProject = useMemo(() => parseBacklogProjectRef(route.params), [route.params]);
  // Projects load after the screen mounts, so a requested project resolves lazily.
  const requestedScopeKey =
    route.params?.scope ??
    (requestedProject ? findBacklogScopeForProject(scopes, requestedProject)?.key : null);
  const scope = resolveBacklogScope(scopes, selectedScopeKey ?? requestedScopeKey);
  const scopeEntries = useMemo(() => selectBacklogScopeIssues(boards, scope), [boards, scope]);
  const filteredEntries = useMemo(
    () => filterBacklogIssues(scopeEntries, { query: searchQuery, type: typeFilter }),
    [scopeEntries, searchQuery, typeFilter],
  );
  const listItems = useMemo(
    () => buildBacklogListItems({ entries: filteredEntries, issuesById, expandedClosedStatuses }),
    [expandedClosedStatuses, filteredEntries, issuesById],
  );
  const canCreate =
    resolveBacklogCreateTarget(
      scope.kind === "project" ? scope : resolveBacklogScope(scopes, "inbox"),
      environmentAvailability,
    ).target !== null;
  const openQuickAdd = useCallback(() => {
    navigation.navigate("BacklogQuickAdd", { scope: defaultQuickAddScopeKey(scope) });
  }, [navigation, scope]);
  const toggleStatus = useCallback((status: BacklogIssueStatus) => {
    setExpandedClosedStatuses((current) => {
      const next = new Set(current);
      if (next.has(status)) next.delete(status);
      else next.add(status);
      return next;
    });
  }, []);

  const renderItem = useCallback(
    ({ item }: { item: BacklogListItem }) =>
      item.type === "section" ? (
        <BacklogSectionHeader
          label={item.label}
          count={item.count}
          collapsed={item.collapsed}
          onToggle={() => toggleStatus(item.status)}
        />
      ) : (
        <BacklogIssueRow
          issue={item.entry.issue}
          blocked={item.blocked}
          isFirst={item.isFirst}
          isLast={item.isLast}
          environmentLabel={environmentLabel}
          onPress={() =>
            navigation.navigate("BacklogIssue", {
              environmentId: item.entry.environmentId,
              issueId: item.entry.issue.id,
            })
          }
        />
      ),
    [environmentLabel, navigation, toggleStatus],
  );

  const isFiltered = searchQuery.trim().length > 0 || typeFilter !== null;
  const listEmpty =
    isLoading && boards.length === 0 ? (
      <View className="items-center py-16">
        <ActivityIndicator colorClassName="accent-icon" />
        <Text className="mt-3 text-sm text-foreground-muted">Loading backlog…</Text>
      </View>
    ) : connectedEnvironmentIds.length === 0 ? (
      <EmptyState
        title="No environment connected"
        detail="Backlogs live on your T3 Code environments. Connect one to see and add issues."
      />
    ) : isFiltered ? (
      <EmptyState title="No matching issues" detail="Try another search or type." />
    ) : (
      <EmptyState
        title={scope.kind === "project" ? `Nothing in ${scope.label} yet` : "No issues yet"}
        detail="Capture an idea or bug and it lands here, and on every client, right away."
        {...(canCreate ? { actionLabel: "Add an idea", onAction: openQuickAdd } : {})}
      />
    );

  return (
    <View collapsable={false} className="flex-1 bg-sheet">
      <ScreenHeader
        title="Backlog"
        subtitle={scope.label}
        onBack={navigation.canGoBack() ? () => navigation.goBack() : undefined}
        search={{
          value: searchQuery,
          onChangeText: setSearchQuery,
          placeholder: "Search issues",
          compactPlaceholder: "Search",
          mode: "inline",
        }}
        menus={[
          {
            title: "Filter issues",
            icon:
              typeFilter === null
                ? "line.3.horizontal.decrease.circle"
                : "line.3.horizontal.decrease.circle.fill",
            items: [
              {
                id: "type:all",
                title: "All types",
                selected: typeFilter === null,
                onPress: () => setTypeFilter(null),
              },
              ...BACKLOG_TYPES.map((type) => ({
                id: `type:${type}`,
                title: BACKLOG_TYPE_LABELS[type],
                selected: typeFilter === type,
                onPress: () => setTypeFilter(type),
              })),
            ],
          },
        ]}
        actions={[
          {
            accessibilityLabel:
              heldMessageCount > 0 ? `Agent messages, ${heldMessageCount} held` : "Agent messages",
            icon: "text.bubble",
            onPress: openMessages,
          },
          {
            accessibilityLabel: "Add to backlog",
            icon: "plus",
            onPress: openQuickAdd,
            disabled: !canCreate,
          },
        ]}
      />
      <SettingsScreenContent>
        <LegendList
          className="flex-1"
          contentContainerStyle={{ paddingBottom: 32, paddingHorizontal: 16, paddingTop: 4 }}
          contentInsetAdjustmentBehavior="automatic"
          data={listItems}
          estimatedItemSize={72}
          getItemType={(item) => item.type}
          keyboardDismissMode="on-drag"
          keyboardShouldPersistTaps="handled"
          keyExtractor={(item) => item.key}
          ListEmptyComponent={listEmpty}
          ListHeaderComponent={
            <BacklogBoardHeader
              scopeKey={scope.key}
              scopeLabel={scope.label}
              scopes={scopes}
              notices={notices}
              unsupportedLabels={unsupportedLabels}
              loadingMore={isLoading && boards.length > 0}
              heldMessageCount={heldMessageCount}
              onOpenMessages={openMessages}
              onSelectScope={setSelectedScopeKey}
            />
          }
          renderItem={renderItem}
          showsVerticalScrollIndicator={false}
        />
      </SettingsScreenContent>
    </View>
  );
}

function BacklogBoardHeader(props: {
  readonly scopeKey: string;
  readonly scopeLabel: string;
  readonly scopes: ReturnType<typeof useBacklogBoards>["scopes"];
  readonly notices: ReadonlyArray<BacklogEnvironmentNotice>;
  readonly unsupportedLabels: ReadonlyArray<string>;
  readonly loadingMore: boolean;
  readonly heldMessageCount: number;
  readonly onOpenMessages: () => void;
  readonly onSelectScope: (key: string) => void;
}) {
  return (
    <View className="gap-3 pt-2">
      <ControlPillMenu
        actions={props.scopes.map((scope) => ({
          id: scope.key,
          title: scope.label,
          state: scope.key === props.scopeKey ? "on" : undefined,
        }))}
        onPressAction={({ nativeEvent }) => props.onSelectScope(nativeEvent.event)}
      >
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Backlog, ${props.scopeLabel}`}
          className="flex-row items-center gap-2 self-start rounded-full bg-subtle px-4 py-2.5 active:opacity-70"
        >
          <SymbolView
            name="checklist"
            size={14}
            tintColorClassName="accent-icon"
            type="monochrome"
          />
          <Text className="text-sm font-t3-bold text-foreground" numberOfLines={1}>
            {props.scopeLabel}
          </Text>
          <SymbolView
            name="chevron.down"
            size={12}
            tintColorClassName="accent-chevron"
            type="monochrome"
          />
        </Pressable>
      </ControlPillMenu>
      {props.heldMessageCount > 0 ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`${heldAgentMessagesSummary(props.heldMessageCount)}. Open messages`}
          onPress={props.onOpenMessages}
          className="flex-row items-center gap-2 rounded-[16px] bg-warning px-3 py-2 active:opacity-70"
        >
          <SymbolView
            name="text.bubble"
            size={13}
            tintColorClassName="accent-warning-foreground"
            type="monochrome"
          />
          <Text
            className="min-w-0 flex-1 text-xs font-t3-bold text-warning-foreground"
            numberOfLines={1}
          >
            {heldAgentMessagesSummary(props.heldMessageCount)}
          </Text>
          <SymbolView
            name="chevron.right"
            size={12}
            tintColorClassName="accent-warning-foreground"
            type="monochrome"
          />
        </Pressable>
      ) : null}
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
          {`${props.unsupportedLabels.join(", ")} ${props.unsupportedLabels.length > 1 ? "don't" : "doesn't"} support Backlog yet.`}
        </Text>
      ) : null}
      {props.loadingMore ? (
        <Text className="px-1 text-xs text-foreground-tertiary">Loading more environments…</Text>
      ) : null}
    </View>
  );
}
