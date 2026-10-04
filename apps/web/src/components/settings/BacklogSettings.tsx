import {
  isAtomCommandInterrupted,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import type { BacklogHubLinkStatus, EnvironmentId } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";

import { backlogEnvironment, backlogFailureMessage } from "../../state/backlog";
import { useEnvironments } from "../../state/environments";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";

function describeHubLink(status: BacklogHubLinkStatus): string {
  if (status.hub === null) {
    return "Not linked. Agents here only see this machine's backlogs.";
  }
  const expires = new Date(status.hub.expiresAt).toLocaleDateString();
  if (status.state === "connected") {
    return `Linked to ${status.hub.label}. New project backlogs and Inbox ideas from agents here go there. Link expires ${expires}.`;
  }
  return `Linked to ${status.hub.label}, but it is unavailable: ${status.error?.message ?? "unreachable"}`;
}

function LinkHubDialog(props: {
  readonly environmentLabel: string;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly onLink: (pairingUrl: string) => Promise<boolean>;
}) {
  const [pairingUrl, setPairingUrl] = useState("");
  const [linking, setLinking] = useState(false);
  return (
    <Dialog
      open={props.open}
      onOpenChange={(open) => {
        props.onOpenChange(open);
        if (!open) setPairingUrl("");
      }}
    >
      <DialogPopup className="max-w-md">
        <DialogHeader>
          <DialogTitle>Link {props.environmentLabel} to a backlog hub</DialogTitle>
          <DialogDescription>
            On the hub, open Settings → Connections, create a link with the Backlog link
            permissions, and paste it here. Agents on {props.environmentLabel} can then read and
            claim the hub's issues.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <Input
            value={pairingUrl}
            onChange={(event) => setPairingUrl(event.target.value)}
            placeholder="https://hub.tailnet.ts.net/pair#token=…"
            disabled={linking}
            autoFocus
          />
        </DialogPanel>
        <DialogFooter variant="bare">
          <Button variant="outline" disabled={linking} onClick={() => props.onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            disabled={linking || pairingUrl.trim().length === 0}
            onClick={() => {
              setLinking(true);
              void props.onLink(pairingUrl.trim()).then((linked) => {
                setLinking(false);
                if (linked) {
                  setPairingUrl("");
                  props.onOpenChange(false);
                }
              });
            }}
          >
            {linking ? "Linking…" : "Link"}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

/** One environment's hub link: its state, and the way in and out. */
function EnvironmentHubLinkRow(props: {
  readonly environmentId: EnvironmentId;
  readonly label: string;
}) {
  const query = useEnvironmentQuery(
    backlogEnvironment.hubLink({ environmentId: props.environmentId, input: {} }),
  );
  const linkHub = useAtomCommand(backlogEnvironment.linkHub, {
    label: "backlog link hub",
    reportFailure: false,
  });
  const unlinkHub = useAtomCommand(backlogEnvironment.unlinkHub, {
    label: "backlog unlink hub",
    reportFailure: false,
  });
  const [linkOpen, setLinkOpen] = useState(false);
  const [confirmingUnlink, setConfirmingUnlink] = useState(false);
  const [unlinking, setUnlinking] = useState(false);

  const fail = (title: string, result: AtomCommandResult<unknown, unknown>) => {
    if (result._tag !== "Failure" || isAtomCommandInterrupted(result)) return;
    toastManager.add(
      stackedThreadToast({ type: "error", title, description: backlogFailureMessage(result) }),
    );
  };

  const status = query.data;
  const failureTag =
    typeof query.failure === "object" && query.failure !== null && "_tag" in query.failure
      ? query.failure._tag
      : null;
  const description =
    status !== null
      ? describeHubLink(status)
      : failureTag === "EnvironmentAuthorizationError"
        ? "Linking needs administrator access to this machine."
        : query.error !== null && /Unknown request tag/.test(query.error)
          ? "This machine runs a T3 Code without backlog links."
          : (query.error ?? "Checking…");

  return (
    <SettingsRow
      title={props.label}
      description={description}
      control={
        status === null ? (
          <Button size="sm" variant="outline" onClick={query.refresh}>
            Retry
          </Button>
        ) : status.hub === null ? (
          <>
            <Button size="sm" onClick={() => setLinkOpen(true)}>
              Link to a hub
            </Button>
            <LinkHubDialog
              environmentLabel={props.label}
              open={linkOpen}
              onOpenChange={setLinkOpen}
              onLink={async (pairingUrl) => {
                const result = await linkHub({
                  environmentId: props.environmentId,
                  input: { pairingUrl },
                });
                if (result._tag === "Success") return true;
                fail("Could not link to the hub", result);
                return false;
              }}
            />
          </>
        ) : (
          <div className="flex gap-2">
            {status.state === "disconnected" ? (
              <Button size="sm" variant="outline" onClick={query.refresh}>
                Check again
              </Button>
            ) : null}
            <Button
              size="sm"
              variant="destructive-outline"
              disabled={unlinking}
              onBlur={() => setConfirmingUnlink(false)}
              onClick={() => {
                // Relinking needs a new pairing URL from the hub, so ask once.
                if (!confirmingUnlink) {
                  setConfirmingUnlink(true);
                  return;
                }
                setUnlinking(true);
                void unlinkHub({ environmentId: props.environmentId, input: {} }).then((result) => {
                  setUnlinking(false);
                  setConfirmingUnlink(false);
                  if (result._tag !== "Success") fail("Could not unlink the hub", result);
                });
              }}
            >
              {unlinking ? "Unlinking…" : confirmingUnlink ? "Confirm unlink" : "Unlink"}
            </Button>
          </div>
        )
      }
    />
  );
}

export function BacklogSettings() {
  const navigate = useNavigate();
  const { environments } = useEnvironments();
  const connected = environments.filter(
    (environment) => environment.entry.enabled && environment.connection.phase === "connected",
  );

  return (
    <SettingsPageContainer>
      <SettingsSection {...searchableSetting("backlog-hub-link")}>
        {connected.length === 0 ? (
          <SettingsRow title="No connected machines" description="Connect a machine to link it." />
        ) : (
          connected.map((environment) => (
            <EnvironmentHubLinkRow
              key={environment.environmentId}
              environmentId={environment.environmentId}
              label={environment.label}
            />
          ))
        )}
      </SettingsSection>
      <SettingsSection title="Link another machine to this one">
        <SettingsRow
          title="Make this machine the hub"
          description="Create a pairing link with the Backlog link permissions in Connections, then paste it into the other machine's Backlog settings. The link only reaches backlogs and lasts a year; revoke it from Connections."
          control={
            <Button
              size="sm"
              variant="outline"
              onClick={() => void navigate({ to: "/settings/connections" })}
            >
              Open Connections
            </Button>
          }
        />
      </SettingsSection>
    </SettingsPageContainer>
  );
}
