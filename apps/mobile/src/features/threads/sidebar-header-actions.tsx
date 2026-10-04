import { SymbolView } from "../../components/AppSymbol";
import { Pressable, View } from "react-native";

export interface SidebarHeaderActionsProps {
  readonly onOpenSettings: () => void;
  readonly onOpenBacklog: () => void;
  readonly heldMessageCount?: number;
}

function FallbackHeaderButton(props: {
  readonly accessibilityLabel: string;
  readonly icon: "checklist" | "gearshape" | "square.and.pencil";
  readonly onPress: () => void;
  readonly badge?: boolean;
}) {
  return (
    <Pressable
      className="size-11 items-center justify-center rounded-full bg-subtle active:opacity-70"
      accessibilityLabel={props.accessibilityLabel}
      accessibilityRole="button"
      hitSlop={4}
      onPress={props.onPress}
    >
      <SymbolView
        name={props.icon}
        size={18}
        tintColorClassName="accent-foreground"
        type="monochrome"
      />
      {props.badge ? (
        <View
          pointerEvents="none"
          className="absolute top-2 right-2 size-2.5 rounded-full bg-warning"
        />
      ) : null}
    </Pressable>
  );
}

export function SidebarHeaderActions(props: SidebarHeaderActionsProps) {
  return (
    <View className="flex-row items-center gap-0.5">
      <FallbackHeaderButton
        accessibilityLabel={
          (props.heldMessageCount ?? 0) > 0
            ? `Open backlog, ${props.heldMessageCount} messages held`
            : "Open backlog"
        }
        icon="checklist"
        onPress={props.onOpenBacklog}
        badge={(props.heldMessageCount ?? 0) > 0}
      />
      <FallbackHeaderButton
        accessibilityLabel="Open settings"
        icon="gearshape"
        onPress={props.onOpenSettings}
      />
    </View>
  );
}
