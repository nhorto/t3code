import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import type { BacklogIssue, BacklogIssuePriority, EnvironmentId } from "@t3tools/contracts";
import { Alert, Pressable, View } from "react-native";

import { AppText as Text } from "../../components/AppText";
import { SymbolView } from "../../components/AppSymbol";
import { StatusPill, type StatusTone } from "../../components/StatusPill";
import { cn } from "../../lib/cn";
import { BACKLOG_TYPE_LABELS, describeBacklogClaim } from "./backlog.logic";

/** Shows a native alert for a failed command; interruptions stay silent. */
export function alertBacklogFailure(
  title: string,
  result: AtomCommandResult<unknown, unknown>,
): boolean {
  if (result._tag !== "Failure") return false;
  if (!isAtomCommandInterrupted(result)) {
    const error = squashAtomCommandFailure(result);
    Alert.alert(title, error instanceof Error ? error.message : String(error));
  }
  return true;
}

function priorityTone(priority: BacklogIssuePriority): StatusTone {
  const label = priority.toUpperCase();
  switch (priority) {
    case "p0":
      return { label, pillClassName: "bg-danger", textClassName: "text-danger-foreground" };
    case "p1":
      return { label, pillClassName: "bg-warning", textClassName: "text-warning-foreground" };
    default:
      return { label, pillClassName: "bg-subtle", textClassName: "text-foreground-muted" };
  }
}

export function BacklogPriorityPill(props: { readonly priority: BacklogIssuePriority }) {
  return <StatusPill size="compact" {...priorityTone(props.priority)} />;
}

export function BacklogBlockedPill() {
  return (
    <StatusPill
      size="compact"
      label="Blocked"
      pillClassName="bg-danger"
      textClassName="text-danger-foreground"
    />
  );
}

export function BacklogClaimPill(props: { readonly label: string }) {
  return (
    <StatusPill
      size="compact"
      label={props.label}
      pillClassName="bg-adaptive-emerald-500-a12-a16"
      textClassName="text-adaptive-emerald-700-300"
    />
  );
}

/** One issue in a grouped card: key, title, type, priority, blocked and claim badges. */
export function BacklogIssueRow(props: {
  readonly issue: BacklogIssue;
  readonly blocked: boolean;
  readonly isFirst: boolean;
  readonly isLast: boolean;
  readonly environmentLabel: (environmentId: EnvironmentId) => string | null;
  readonly onPress: () => void;
}) {
  const { issue } = props;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${issue.key}, ${issue.title}`}
      onPress={props.onPress}
      className={cn(
        "gap-1.5 bg-grouped-card px-4 py-3 active:opacity-70",
        props.isFirst && "rounded-t-[20px]",
        props.isLast ? "rounded-b-[20px]" : "border-b border-separator",
      )}
    >
      <View className="flex-row items-center gap-2">
        <Text className="font-mono text-2xs text-foreground-tertiary">{issue.key}</Text>
        <Text className="text-2xs text-foreground-tertiary">{BACKLOG_TYPE_LABELS[issue.type]}</Text>
        <View className="flex-1" />
        {issue.priority ? <BacklogPriorityPill priority={issue.priority} /> : null}
      </View>
      <Text className="text-base font-t3-medium leading-snug text-foreground" numberOfLines={2}>
        {issue.title}
      </Text>
      {props.blocked || issue.claim ? (
        <View className="flex-row flex-wrap items-center gap-1.5">
          {props.blocked ? <BacklogBlockedPill /> : null}
          {issue.claim ? (
            <BacklogClaimPill label={describeBacklogClaim(issue.claim, props.environmentLabel)} />
          ) : null}
        </View>
      ) : null}
    </Pressable>
  );
}

export function BacklogSectionHeader(props: {
  readonly label: string;
  readonly count: number;
  readonly collapsed: boolean | null;
  readonly onToggle: () => void;
}) {
  const content = (
    <>
      <Text className="text-xs font-t3-medium tracking-[0.5px] uppercase text-foreground-muted">
        {props.label}
      </Text>
      <Text className="text-xs tabular-nums text-foreground-tertiary">{props.count}</Text>
      <View className="flex-1" />
      {props.collapsed === null ? null : (
        <SymbolView
          name={props.collapsed ? "chevron.right" : "chevron.down"}
          size={12}
          tintColorClassName="accent-chevron"
          type="monochrome"
        />
      )}
    </>
  );
  if (props.collapsed === null) {
    return <View className="flex-row items-center gap-2 px-1 pt-5 pb-2">{content}</View>;
  }
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${props.label}, ${props.count} issues, ${props.collapsed ? "collapsed" : "expanded"}`}
      onPress={props.onToggle}
      className="flex-row items-center gap-2 px-1 pt-5 pb-2 active:opacity-70"
    >
      {content}
    </Pressable>
  );
}
