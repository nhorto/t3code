import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/unstable/reactivity";
import { useState } from "react";
import { Alert, View } from "react-native";

import { AppText as Text } from "../../components/AppText";
import { backlogEnvironment } from "../../state/backlog";
import { useAtomCommand } from "../../state/use-atom-command";
import { SettingsActionRow } from "../settings/components/SettingsActionRow";
import { SettingsSection } from "../settings/components/SettingsSection";

/**
 * The environment's backlog hub link: its state and the way out. Linking takes
 * a pairing URL from the hub, which is pasted in Settings → Backlog on web or
 * desktop.
 */
export function BacklogHubSection({ environmentId }: { readonly environmentId: EnvironmentId }) {
  const result = useAtomValue(backlogEnvironment.hubLink({ environmentId, input: {} }));
  const unlinkHub = useAtomCommand(backlogEnvironment.unlinkHub);
  const [unlinking, setUnlinking] = useState(false);
  const status = Option.getOrNull(AsyncResult.value(result));
  // Servers without the fleet link, or sessions without admin access, show nothing.
  if (status === null) return null;
  const hub = status.hub;

  return (
    <SettingsSection title="Backlog hub">
      <View className="gap-1 p-4">
        <Text className="text-base text-foreground">
          {hub === null ? "Not linked" : `Linked to ${hub.label}`}
        </Text>
        <Text className="text-sm text-foreground-muted">
          {hub === null
            ? "Agents here only see this machine's backlogs. Link it from Settings → Backlog on the web or desktop app."
            : status.state === "connected"
              ? "Agents here can claim the hub's issues. New project backlogs go to the hub."
              : `The hub is unavailable: ${status.error?.message ?? "unreachable"}`}
        </Text>
      </View>
      {hub !== null ? (
        <SettingsActionRow
          icon="xmark.circle.fill"
          label="Unlink"
          tone="danger"
          loading={unlinking}
          disabled={unlinking}
          onPress={() =>
            Alert.alert(
              `Unlink ${hub.label}?`,
              "Agents here lose access to its backlogs. Linking again needs a new pairing URL from the hub. The hub keeps this machine's session until you revoke it in the hub's Settings → Connections.",
              [
                { text: "Cancel", style: "cancel" },
                {
                  text: "Unlink",
                  style: "destructive",
                  onPress: () => {
                    setUnlinking(true);
                    void unlinkHub({ environmentId, input: {} }).finally(() => setUnlinking(false));
                  },
                },
              ],
            )
          }
        />
      ) : null}
    </SettingsSection>
  );
}
