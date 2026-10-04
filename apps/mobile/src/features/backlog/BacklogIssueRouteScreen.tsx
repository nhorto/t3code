import type { MenuAction } from "@react-native-menu/menu";
import { StackActions, useNavigation, type StaticScreenProps } from "@react-navigation/native";
import {
  BACKLOG_ISSUE_STATUSES,
  BacklogIssueId,
  EnvironmentId,
  isBacklogIssueBlocked,
  isBacklogStatusClosed,
  type BacklogIssue,
  type BacklogIssueLink,
  type BacklogUpdateIssueInput,
} from "@t3tools/contracts";
import { useCallback, useMemo, useState, type ReactNode } from "react";
import { ActivityIndicator, Alert, Platform, Pressable, ScrollView, View } from "react-native";
import { KeyboardAvoidingView } from "react-native-keyboard-controller";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppText as Text, AppTextInput as TextInput } from "../../components/AppText";
import { SymbolView } from "../../components/AppSymbol";
import { ControlPill, ControlPillMenu } from "../../components/ControlPill";
import { EmptyState } from "../../components/EmptyState";
import { ScreenHeader } from "../../components/ScreenHeader";
import { tryOpenExternalUrl } from "../../lib/openExternalUrl";
import { relativeTime } from "../../lib/time";
import { backlogEnvironment } from "../../state/backlog";
import { useProjects } from "../../state/entities";
import { useEnvironments } from "../../state/environments";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { MarkdownContent } from "../files/FileMarkdownPreview";
import { SettingsSection } from "../settings/components/SettingsSection";
import {
  BACKLOG_PRIORITIES,
  BACKLOG_STATUS_LABELS,
  BACKLOG_TYPE_LABELS,
  BACKLOG_TYPES,
  backlogMoveTargets,
  describeBacklogActivity,
  describeBacklogClaim,
  findBacklog,
  reopenBacklogStatus,
} from "./backlog.logic";
import {
  alertBacklogFailure,
  BacklogBlockedPill,
  BacklogClaimPill,
  BacklogIssueRow,
} from "./backlog-components";

export type BacklogIssueRouteParams = {
  readonly environmentId: string;
  readonly issueId: string;
};

function parseParams(params: BacklogIssueRouteParams) {
  try {
    return {
      environmentId: EnvironmentId.make(params.environmentId),
      issueId: BacklogIssueId.make(params.issueId),
    };
  } catch {
    return null;
  }
}

export function BacklogIssueRouteScreen({ route }: StaticScreenProps<BacklogIssueRouteParams>) {
  const navigation = useNavigation();
  const target = useMemo(() => parseParams(route.params), [route.params]);
  if (target === null) {
    return (
      <View className="flex-1 bg-sheet">
        <ScreenHeader title="Issue" onBack={() => navigation.goBack()} />
        <View className="p-5">
          <EmptyState title="Issue not found" detail="This link does not name a backlog issue." />
        </View>
      </View>
    );
  }
  return <BacklogIssueScreen environmentId={target.environmentId} issueId={target.issueId} />;
}

function BacklogIssueScreen(props: {
  readonly environmentId: EnvironmentId;
  readonly issueId: BacklogIssueId;
}) {
  const { environmentId, issueId } = props;
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const { environments } = useEnvironments();
  const projects = useProjects();
  const environment = environments.find((entry) => entry.environmentId === environmentId);
  const connected = environment?.connection.phase === "connected";
  const environmentLabel = useCallback(
    (id: EnvironmentId) => environments.find((entry) => entry.environmentId === id)?.label ?? null,
    [environments],
  );
  const board = useEnvironmentQuery(
    connected ? backlogEnvironment.board({ environmentId, input: {} }) : null,
  );
  const detail = useEnvironmentQuery(
    connected ? backlogEnvironment.issueDetail({ environmentId, input: { issueId } }) : null,
  );
  const updateIssue = useAtomCommand(backlogEnvironment.updateIssue, {
    label: "backlog issue update",
    reportFailure: false,
  });
  const release = useAtomCommand(backlogEnvironment.release, {
    label: "backlog issue release",
    reportFailure: false,
  });
  const comment = useAtomCommand(backlogEnvironment.comment, {
    label: "backlog comment",
    reportFailure: false,
  });
  const [pending, setPending] = useState(false);
  const [commentText, setCommentText] = useState("");

  // The board row is live; the detail adds the body, relations and activity.
  const issue = board.data?.issuesById.get(issueId) ?? detail.data?.issue ?? null;
  const backlog = issue ? findBacklog(board.data, issue.backlogId) : null;
  const issuesById = board.data?.issuesById ?? new Map<BacklogIssueId, BacklogIssue>();
  const blocked = issue ? isBacklogIssueBlocked(issue, issuesById) : false;
  const closed = issue ? isBacklogStatusClosed(issue.status) : false;
  const environmentProjects = useMemo(
    () => projects.filter((project) => project.environmentId === environmentId),
    [environmentId, projects],
  );
  const moveTargets =
    issue && board.data ? backlogMoveTargets(board.data, issue, environmentProjects) : [];
  const disabled = pending || !connected || issue === null;
  const refreshDetail = detail.refresh;

  const runUpdate = async (
    patch: Omit<BacklogUpdateIssueInput, "issueId">,
    failureTitle: string,
  ) => {
    setPending(true);
    try {
      const result = await updateIssue({ environmentId, input: { issueId, ...patch } });
      // The board row's updatedAt changes, which refetches the detail on its own.
      alertBacklogFailure(failureTitle, result);
    } finally {
      setPending(false);
    }
  };

  const forceRelease = () => {
    if (!issue?.claim) return;
    Alert.alert(
      "Release claim?",
      `${describeBacklogClaim(issue.claim, environmentLabel)} loses this issue and it returns to Ready.`,
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Release",
          style: "destructive",
          onPress: () => {
            setPending(true);
            void release({ environmentId, input: { issueId, status: "ready" } })
              .then((result) => {
                alertBacklogFailure("Could not release the claim", result);
              })
              .finally(() => setPending(false));
          },
        },
      ],
    );
  };

  const sendComment = async () => {
    const text = commentText.trim();
    if (!text || disabled) return;
    setPending(true);
    try {
      const result = await comment({ environmentId, input: { issueId, text } });
      if (!alertBacklogFailure("Could not add the comment", result)) {
        setCommentText("");
        // A comment may not touch the row, so refetch the activity explicitly.
        refreshDetail();
      }
    } finally {
      setPending(false);
    }
  };

  const openIssue = useCallback(
    (next: BacklogIssue) =>
      navigation.dispatch(StackActions.push("BacklogIssue", { environmentId, issueId: next.id })),
    [environmentId, navigation],
  );
  const openLink = useCallback(
    (link: BacklogIssueLink) => {
      if (link.type === "pull_request") {
        void tryOpenExternalUrl(link.url, "pull-request");
        return;
      }
      navigation.navigate("Thread", {
        environmentId: link.environmentId ?? environmentId,
        threadId: link.threadId,
      });
    },
    [environmentId, navigation],
  );

  const header = (
    <ScreenHeader
      title={issue?.key ?? "Issue"}
      subtitle={backlog?.title}
      onBack={() => navigation.goBack()}
    />
  );

  if (issue === null) {
    return (
      <View className="flex-1 bg-sheet">
        {header}
        <View className="p-5">
          {!connected ? (
            <EmptyState
              title="Environment unavailable"
              detail={`${environment?.label ?? "The environment hosting this issue"} is not connected. The issue will load when it reconnects.`}
            />
          ) : detail.error ? (
            <EmptyState
              title="Issue unavailable"
              detail={detail.error}
              actionLabel="Try again"
              onAction={detail.refresh}
            />
          ) : (
            <View className="items-center py-16">
              <ActivityIndicator colorClassName="accent-icon" />
            </View>
          )}
        </View>
      </View>
    );
  }

  const children = detail.data?.children ?? [];
  const blockers = detail.data?.blockers ?? [];
  const activity = detail.data?.activity ?? [];
  const body = detail.data?.body ?? "";

  return (
    <View collapsable={false} className="flex-1 bg-sheet">
      {header}
      <KeyboardAvoidingView automaticOffset behavior="padding" className="flex-1">
        <ScrollView
          className="flex-1"
          contentInsetAdjustmentBehavior="automatic"
          keyboardDismissMode="interactive"
          keyboardShouldPersistTaps="handled"
          contentContainerClassName="gap-5 px-4 pt-4 pb-6"
          showsVerticalScrollIndicator={false}
        >
          {!connected ? (
            <Text className="px-1 text-sm text-danger-foreground">
              {environment?.label ?? "This environment"} is disconnected. Changes are paused until
              it reconnects.
            </Text>
          ) : null}

          <View className="gap-2 px-1">
            <Text className="text-xl font-t3-bold leading-snug text-foreground" selectable>
              {issue.title}
            </Text>
            {blocked || issue.claim ? (
              <View className="flex-row flex-wrap gap-1.5">
                {blocked ? <BacklogBlockedPill /> : null}
                {issue.claim ? (
                  <BacklogClaimPill label={describeBacklogClaim(issue.claim, environmentLabel)} />
                ) : null}
              </View>
            ) : null}
          </View>

          {issue.claim ? (
            <View className="flex-row items-center gap-3 rounded-[20px] bg-grouped-card px-4 py-3">
              <View className="min-w-0 flex-1 gap-0.5">
                <Text className="text-base font-t3-medium text-foreground" numberOfLines={1}>
                  Claimed by {describeBacklogClaim(issue.claim, environmentLabel)}
                </Text>
                <Text className="text-xs text-foreground-muted">
                  Claimed {relativeTime(issue.claim.claimedAt)} ago
                </Text>
              </View>
              <ControlPill
                label="Release"
                variant="danger"
                accessibilityLabel="Force-release claim"
                disabled={disabled}
                onPress={forceRelease}
              />
            </View>
          ) : null}

          {closed ? (
            <ControlPill
              label={`Reopen to ${BACKLOG_STATUS_LABELS[reopenBacklogStatus(backlog)]}`}
              icon="arrow.uturn.backward"
              variant="pill"
              className="self-start"
              disabled={disabled}
              onPress={() =>
                void runUpdate({ status: reopenBacklogStatus(backlog) }, "Could not reopen")
              }
            />
          ) : null}

          <SettingsSection>
            <SelectRow
              label="Status"
              value={BACKLOG_STATUS_LABELS[issue.status]}
              disabled={disabled}
              actions={BACKLOG_ISSUE_STATUSES.map((status) => ({
                id: status,
                title: BACKLOG_STATUS_LABELS[status],
                state: status === issue.status ? "on" : undefined,
              }))}
              onSelect={(id) => {
                const status = BACKLOG_ISSUE_STATUSES.find((entry) => entry === id);
                if (status && status !== issue.status)
                  void runUpdate({ status }, "Could not change the status");
              }}
            />
            <SelectRow
              label="Type"
              value={BACKLOG_TYPE_LABELS[issue.type]}
              disabled={disabled}
              borderTop
              actions={BACKLOG_TYPES.map((type) => ({
                id: type,
                title: BACKLOG_TYPE_LABELS[type],
                state: type === issue.type ? "on" : undefined,
              }))}
              onSelect={(id) => {
                const type = BACKLOG_TYPES.find((entry) => entry === id);
                if (type && type !== issue.type)
                  void runUpdate({ type }, "Could not change the type");
              }}
            />
            <SelectRow
              label="Priority"
              value={issue.priority ? issue.priority.toUpperCase() : "None"}
              disabled={disabled}
              borderTop
              actions={[
                { id: "none", title: "None", state: issue.priority === null ? "on" : undefined },
                ...BACKLOG_PRIORITIES.map((priority) => ({
                  id: priority,
                  title: priority.toUpperCase(),
                  state: priority === issue.priority ? ("on" as const) : undefined,
                })),
              ]}
              onSelect={(id) => {
                const priority = BACKLOG_PRIORITIES.find((entry) => entry === id) ?? null;
                if (priority !== issue.priority)
                  void runUpdate({ priority }, "Could not change the priority");
              }}
            />
            <SelectRow
              label={backlog?.kind === "inbox" ? "Move to project" : "Backlog"}
              value={backlog?.title ?? "Backlog"}
              disabled={disabled}
              borderTop
              actions={moveTargets.map((target) => ({ id: target.key, title: target.label }))}
              onSelect={(id) => {
                const destination = moveTargets.find((target) => target.key === id);
                if (destination) void runUpdate(destination.patch, "Could not move the issue");
              }}
            />
          </SettingsSection>

          <IssueSection title="Description">
            {body.trim().length > 0 ? (
              <View className="rounded-[20px] bg-grouped-card px-4 py-3">
                <MarkdownContent markdown={body} />
              </View>
            ) : (
              <Text className="px-1 text-sm text-foreground-muted">
                {detail.isPending && detail.data === null ? "Loading…" : "No description."}
              </Text>
            )}
          </IssueSection>

          {detail.data?.parent ? (
            <IssueSection title="Part of">
              <BacklogIssueRow
                issue={detail.data.parent.issue}
                blocked={false}
                isFirst
                isLast
                environmentLabel={environmentLabel}
                onPress={() => detail.data?.parent && openIssue(detail.data.parent.issue)}
              />
            </IssueSection>
          ) : null}

          <IssueList
            title="Children"
            issues={children}
            issuesById={issuesById}
            environmentLabel={environmentLabel}
            onPress={openIssue}
          />
          <IssueList
            title="Blocked by"
            issues={blockers}
            issuesById={issuesById}
            environmentLabel={environmentLabel}
            onPress={openIssue}
          />

          {issue.links.length > 0 ? (
            <IssueSection title="Links">
              <View className="overflow-hidden rounded-[20px] bg-grouped-card">
                {issue.links.map((link, index) => (
                  <Pressable
                    key={link.type === "thread" ? link.threadId : link.url}
                    accessibilityRole="link"
                    onPress={() => openLink(link)}
                    className={`flex-row items-center gap-3 px-4 py-3 active:opacity-70 ${index === 0 ? "" : "border-t border-separator"}`}
                  >
                    <SymbolView
                      name={link.type === "thread" ? "text.bubble" : "arrow.triangle.pull"}
                      size={14}
                      tintColorClassName="accent-icon-subtle"
                      type="monochrome"
                    />
                    <Text className="min-w-0 flex-1 text-sm text-foreground" numberOfLines={1}>
                      {link.type === "thread" ? "Thread" : link.url}
                    </Text>
                  </Pressable>
                ))}
              </View>
            </IssueSection>
          ) : null}

          <IssueSection title="Activity">
            {activity.length === 0 ? (
              <Text className="px-1 text-sm text-foreground-muted">
                {detail.isPending && detail.data === null ? "Loading…" : "No activity yet."}
              </Text>
            ) : (
              <View className="gap-3 px-1">
                {activity.map((entry) => (
                  <View key={entry.id} className="gap-0.5">
                    <Text className="text-xs text-foreground-tertiary">
                      {entry.actor.label || "Someone"} · {relativeTime(entry.at)}
                    </Text>
                    <Text
                      className={
                        entry.kind === "commented"
                          ? "text-base text-foreground"
                          : "text-sm text-foreground-muted"
                      }
                      selectable
                    >
                      {describeBacklogActivity(entry)}
                    </Text>
                  </View>
                ))}
              </View>
            )}
          </IssueSection>
        </ScrollView>
        <View
          className="flex-row items-end gap-2 border-t border-border bg-sheet px-4 pt-2"
          style={{ paddingBottom: Platform.OS === "android" ? Math.max(insets.bottom, 10) : 10 }}
        >
          <TextInput
            accessibilityLabel="Comment"
            placeholder="Add a comment"
            value={commentText}
            onChangeText={setCommentText}
            multiline
            editable={!disabled}
            className="max-h-32 min-h-11 min-w-0 flex-1 rounded-[20px] bg-grouped-card px-4 py-2.5 font-sans text-base text-foreground"
          />
          <ControlPill
            accessibilityLabel="Send comment"
            icon="arrow.up"
            variant="primary"
            disabled={disabled || commentText.trim().length === 0}
            onPress={() => void sendComment()}
          />
        </View>
      </KeyboardAvoidingView>
    </View>
  );
}

function IssueSection(props: { readonly title: string; readonly children: ReactNode }) {
  return (
    <View className="gap-2">
      <Text className="px-1 text-xs font-t3-medium tracking-[0.5px] uppercase text-foreground-muted">
        {props.title}
      </Text>
      {props.children}
    </View>
  );
}

function IssueList(props: {
  readonly title: string;
  readonly issues: ReadonlyArray<BacklogIssue>;
  readonly issuesById: ReadonlyMap<BacklogIssueId, BacklogIssue>;
  readonly environmentLabel: (environmentId: EnvironmentId) => string | null;
  readonly onPress: (issue: BacklogIssue) => void;
}) {
  if (props.issues.length === 0) return null;
  return (
    <IssueSection title={`${props.title} · ${props.issues.length}`}>
      <View>
        {props.issues.map((entry, index) => (
          <BacklogIssueRow
            key={entry.id}
            issue={props.issuesById.get(entry.id) ?? entry}
            blocked={isBacklogIssueBlocked(entry, props.issuesById)}
            isFirst={index === 0}
            isLast={index === props.issues.length - 1}
            environmentLabel={props.environmentLabel}
            onPress={() => props.onPress(entry)}
          />
        ))}
      </View>
    </IssueSection>
  );
}

function SelectRow(props: {
  readonly label: string;
  readonly value: string;
  readonly actions: MenuAction[];
  readonly onSelect: (id: string) => void;
  readonly disabled?: boolean;
  readonly borderTop?: boolean;
}) {
  const rowClassName = props.borderTop
    ? "min-h-14 flex-row items-center gap-3 border-t border-border-subtle px-4 py-3"
    : "min-h-14 flex-row items-center gap-3 px-4 py-3";
  const value = (
    <Text className="min-w-0 flex-1 text-right text-base text-foreground-muted" numberOfLines={1}>
      {props.value}
    </Text>
  );
  if (props.disabled || props.actions.length === 0) {
    return (
      <View className={rowClassName}>
        <Text className="text-lg text-foreground">{props.label}</Text>
        {value}
      </View>
    );
  }
  return (
    <ControlPillMenu
      actions={props.actions}
      onPressAction={({ nativeEvent }) => props.onSelect(nativeEvent.event)}
    >
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${props.label}, ${props.value}`}
        className={`${rowClassName} active:opacity-70`}
      >
        <Text className="text-lg text-foreground">{props.label}</Text>
        {value}
        <SymbolView
          name="chevron.down"
          size={14}
          tintColorClassName="accent-chevron"
          type="monochrome"
        />
      </Pressable>
    </ControlPillMenu>
  );
}
