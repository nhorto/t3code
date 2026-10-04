import { useAtomValue } from "@effect/atom-react";
import { isAtomCommandInterrupted } from "@t3tools/client-runtime/state/runtime";
import type { BacklogIssue, BacklogIssueType, EnvironmentId, ProjectId } from "@t3tools/contracts";
import { Atom } from "effect/unstable/reactivity";
import { PlusIcon } from "lucide-react";
import { useCallback, useMemo, useRef, useState } from "react";

import { useParams } from "@tanstack/react-router";

import { useComposerDraftStore } from "../../composerDraftStore";
import { appAtomRegistry } from "../../rpc/atomRegistry";
import { useThreadShell } from "../../state/entities";
import { resolveThreadRouteTarget } from "../../threadRoutes";
import { backlogEnvironment, backlogFailureMessage } from "../../state/backlog";
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
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { stackedThreadToast, toastManager } from "../ui/toast";
import {
  BACKLOG_TYPE_LABELS,
  BACKLOG_TYPES,
  backlogEntryForProject,
  type BacklogCreateTarget,
  type BacklogSwitcherEntry,
} from "./backlog.logic";
import { BacklogTypeIcon } from "./BacklogCard";
import { useBacklogSwitcher } from "./useBacklogData";

/** Creates an issue at a switcher entry's target; reports failures itself. */
export function useCreateBacklogIssue() {
  const createIssue = useAtomCommand(backlogEnvironment.createIssue, {
    label: "backlog create issue",
    reportFailure: false,
  });
  return useCallback(
    async (
      target: BacklogCreateTarget,
      fields: { readonly title: string; readonly type: BacklogIssueType },
    ): Promise<BacklogIssue | null> => {
      const result = await createIssue({
        environmentId: target.environmentId,
        input: {
          title: fields.title,
          type: fields.type,
          ...(target.backlogId ? { backlogId: target.backlogId } : {}),
          ...(target.backlogId === undefined && target.projectId
            ? { projectId: target.projectId }
            : {}),
        },
      });
      if (result._tag === "Success") return result.value;
      if (!isAtomCommandInterrupted(result)) {
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Could not add the issue",
            description: backlogFailureMessage(result),
          }),
        );
      }
      return null;
    },
    [createIssue],
  );
}

function IssueTypeSelect({
  value,
  onChange,
  disabled,
}: {
  value: BacklogIssueType;
  onChange: (type: BacklogIssueType) => void;
  disabled?: boolean;
}) {
  return (
    <Select
      value={value}
      disabled={disabled}
      onValueChange={(next) => {
        if (next) onChange(next as BacklogIssueType);
      }}
    >
      <SelectTrigger size="sm" aria-label="Issue type" className="w-32 shrink-0">
        <SelectValue>
          <span className="flex items-center gap-1.5">
            <BacklogTypeIcon type={value} />
            {BACKLOG_TYPE_LABELS[value]}
          </span>
        </SelectValue>
      </SelectTrigger>
      <SelectPopup>
        {BACKLOG_TYPES.map((type) => (
          <SelectItem key={type} value={type}>
            <span className="flex items-center gap-1.5">
              <BacklogTypeIcon type={type} />
              {BACKLOG_TYPE_LABELS[type]}
            </span>
          </SelectItem>
        ))}
      </SelectPopup>
    </Select>
  );
}

/** Inline capture at the top of the board: type a title, Enter adds it to the open backlog. */
export function BacklogInlineQuickAdd({
  target,
  targetLabel,
}: {
  target: BacklogCreateTarget | null;
  targetLabel: string;
}) {
  const create = useCreateBacklogIssue();
  const [title, setTitle] = useState("");
  const [type, setType] = useState<BacklogIssueType>("idea");
  const [pending, setPending] = useState(false);
  // State lags a render, so a repeated Enter could add the same idea twice.
  const pendingRef = useRef(false);
  const submit = async () => {
    const trimmed = title.trim();
    if (!target || trimmed.length === 0 || pendingRef.current) return;
    pendingRef.current = true;
    setPending(true);
    const created = await create(target, { title: trimmed, type });
    pendingRef.current = false;
    setPending(false);
    if (created) setTitle("");
  };
  return (
    <div className="flex min-w-0 flex-1 items-center gap-2">
      <Input
        size="sm"
        className="min-w-0 flex-1"
        aria-label={`Add to ${targetLabel}`}
        placeholder={target ? `Add to ${targetLabel}…` : `${targetLabel} is unavailable`}
        disabled={target === null}
        value={title}
        onChange={(event) => setTitle(event.target.value)}
        onKeyDown={(event) => {
          if (event.key !== "Enter" || event.nativeEvent.isComposing) return;
          event.preventDefault();
          void submit();
        }}
      />
      <IssueTypeSelect value={type} onChange={setType} disabled={target === null} />
      <Button
        size="sm"
        variant="outline"
        disabled={target === null || pending || title.trim().length === 0}
        onClick={() => void submit()}
      >
        <PlusIcon />
        Add
      </Button>
    </div>
  );
}

// Quick-add dialog, reachable from the command palette and its keybinding anywhere in the app.

type ProjectRef = { readonly environmentId: EnvironmentId; readonly projectId: ProjectId };

interface QuickAddRequest {
  /** The project to start on. Absent, the picker follows the thread or draft on screen. */
  readonly projectRef: ProjectRef | null;
}

const backlogQuickAddAtom = Atom.make<QuickAddRequest | null>(null).pipe(
  Atom.keepAlive,
  Atom.withLabel("backlog:quick-add-dialog"),
);

export function openBacklogQuickAdd(projectRef: ProjectRef | null = null): void {
  appAtomRegistry.set(backlogQuickAddAtom, { projectRef });
}

/** The project behind the thread or draft on screen, if any. */
function useRouteProjectRef(): ProjectRef | null {
  const routeTarget = useParams({
    strict: false,
    select: (params) => resolveThreadRouteTarget(params),
  });
  const thread = useThreadShell(routeTarget?.kind === "server" ? routeTarget.threadRef : null);
  const draft = useComposerDraftStore((store) =>
    routeTarget?.kind === "draft"
      ? store.getDraftSession(routeTarget.draftId)
      : routeTarget?.kind === "server"
        ? store.getDraftThread(routeTarget.threadRef)
        : null,
  );
  if (thread) return { environmentId: thread.environmentId, projectId: thread.projectId };
  if (draft) return { environmentId: draft.environmentId, projectId: draft.projectId };
  return null;
}

/** Mounted once in the app shell. Subscribes to boards only while the dialog is open. */
export function BacklogQuickAddDialogHost() {
  const request = useAtomValue(backlogQuickAddAtom);
  if (request === null) return null;
  return (
    <BacklogQuickAddDialog
      request={request}
      onClose={() => appAtomRegistry.set(backlogQuickAddAtom, null)}
    />
  );
}

function entryOptionLabel(entry: BacklogSwitcherEntry): string {
  return entry.machineLabel ? `${entry.label} (${entry.machineLabel})` : entry.label;
}

function BacklogQuickAddDialog({
  request,
  onClose,
}: {
  request: QuickAddRequest;
  onClose: () => void;
}) {
  const { entries } = useBacklogSwitcher();
  const routeProjectRef = useRouteProjectRef();
  const projectRef = request.projectRef ?? routeProjectRef;
  const choices = useMemo(() => entries.filter((entry) => entry.scope.kind !== "all"), [entries]);
  const defaultEntry = useMemo(
    () => backlogEntryForProject(choices, projectRef),
    [choices, projectRef],
  );
  const [pickedKey, setPickedKey] = useState<string | null>(null);
  const entry =
    choices.find((candidate) => candidate.key === (pickedKey ?? defaultEntry?.key)) ?? null;
  const create = useCreateBacklogIssue();
  const [title, setTitle] = useState("");
  const [type, setType] = useState<BacklogIssueType>("idea");
  const [pending, setPending] = useState(false);
  const pendingRef = useRef(false);

  const submit = async () => {
    const trimmed = title.trim();
    if (!entry?.createTarget || trimmed.length === 0 || pendingRef.current) return;
    pendingRef.current = true;
    setPending(true);
    const created = await create(entry.createTarget, { title: trimmed, type });
    pendingRef.current = false;
    setPending(false);
    if (!created) return;
    toastManager.add({
      type: "success",
      title: `Added ${created.key}`,
      description: `${created.title} · ${entry.label}`,
    });
    onClose();
  };

  return (
    <Dialog open onOpenChange={(open) => (!open && !pending ? onClose() : undefined)}>
      <DialogPopup className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Add to backlog</DialogTitle>
          <DialogDescription>Capture an idea, bug or feature. Enter adds it.</DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <Select
            value={entry?.key ?? null}
            onValueChange={(next) => {
              if (next) setPickedKey(next);
            }}
          >
            <SelectTrigger size="sm" aria-label="Backlog">
              <SelectValue placeholder="Choose a backlog">
                {entry ? entryOptionLabel(entry) : null}
              </SelectValue>
            </SelectTrigger>
            <SelectPopup>
              {choices.map((choice) => (
                <SelectItem key={choice.key} value={choice.key} disabled={!choice.createTarget}>
                  {entryOptionLabel(choice)}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
          <div className="flex items-center gap-2">
            <Input
              autoFocus
              className="min-w-0 flex-1"
              aria-label="Title"
              placeholder="What is it?"
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              onKeyDown={(event) => {
                if (event.key !== "Enter" || event.nativeEvent.isComposing) return;
                event.preventDefault();
                void submit();
              }}
            />
            <IssueTypeSelect value={type} onChange={setType} />
          </div>
          {entry && !entry.createTarget ? (
            <p className="text-destructive text-xs">
              No machine holding this backlog is connected right now.
            </p>
          ) : null}
        </DialogPanel>
        <DialogFooter>
          <Button variant="outline" size="sm" disabled={pending} onClick={onClose}>
            Cancel
          </Button>
          <Button
            size="sm"
            disabled={pending || !entry?.createTarget || title.trim().length === 0}
            onClick={() => void submit()}
          >
            {pending ? "Adding…" : "Add"}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
