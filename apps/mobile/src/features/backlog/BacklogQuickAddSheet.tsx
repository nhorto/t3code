import { useAtomValue } from "@effect/atom-react";
import { useNavigation, type StaticScreenProps } from "@react-navigation/native";
import type { BacklogIssueType } from "@t3tools/contracts";
import { Atom } from "effect/unstable/reactivity";
import { useMemo, useState } from "react";
import { Platform, Pressable, ScrollView, View } from "react-native";
import { KeyboardAvoidingView } from "react-native-keyboard-controller";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppText as Text, AppTextInput as TextInput } from "../../components/AppText";
import { SymbolView } from "../../components/AppSymbol";
import type { ComposerEditorSelection } from "../../components/ComposerEditor";
import { ControlPill, ControlPillMenu } from "../../components/ControlPill";
import { cn } from "../../lib/cn";
import { appAtomRegistry } from "../../state/atom-registry";
import { backlogEnvironment } from "../../state/backlog";
import { useAtomCommand } from "../../state/use-atom-command";
import {
  ComposerDictationCancelAction,
  ComposerDictationPrimaryAction,
  ComposerDictationStartAction,
  ComposerDictationStatus,
  ComposerDictationToolbar,
} from "../voice-input/ComposerDictationControl";
import { useVoiceInputController } from "../voice-input/useVoiceInputController";
import { resolveVoiceComposerPresentation } from "../voice-input/voiceInputPresentation";
import {
  BACKLOG_TYPE_LABELS,
  BACKLOG_TYPES,
  findBacklogScopeForProject,
  INBOX_BACKLOG_SCOPE_KEY,
  parseBacklogProjectRef,
  resolveBacklogCreateTarget,
  resolveBacklogScope,
} from "./backlog.logic";
import { alertBacklogFailure } from "./backlog-components";
import { useBacklogBoards } from "./useBacklogBoards";

export type BacklogQuickAddParams = {
  /** Picker key to save into; defaults to the Inbox. */
  readonly scope?: string;
  /** Save into the backlog of the project with this checkout. */
  readonly environmentId?: string;
  readonly projectId?: string;
};

interface QuickAddDraft {
  readonly title: string;
  readonly notes: string;
  readonly type: BacklogIssueType;
}

const EMPTY_DRAFT: QuickAddDraft = { title: "", notes: "", type: "idea" };

// Outlives the sheet, so a stray swipe-down or an in-flight dictation never loses an idea.
const quickAddDraftAtom = Atom.make<QuickAddDraft>(EMPTY_DRAFT).pipe(Atom.keepAlive);

function updateDraft(patch: Partial<QuickAddDraft>) {
  appAtomRegistry.set(quickAddDraftAtom, { ...appAtomRegistry.get(quickAddDraftAtom), ...patch });
}

const VOICE_OWNER_KEY = "backlog-quick-add";

export function BacklogQuickAddSheet({
  route,
}: StaticScreenProps<BacklogQuickAddParams | undefined>) {
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const draft = useAtomValue(quickAddDraftAtom);
  const { scopes, environmentAvailability, environmentLabel } = useBacklogBoards();
  const [scopeKey, setScopeKey] = useState<string | null>(route.params?.scope ?? null);
  const requestedProject = useMemo(() => parseBacklogProjectRef(route.params), [route.params]);
  const [saving, setSaving] = useState(false);
  const [selection, setSelection] = useState<ComposerEditorSelection | null>(null);
  const createIssue = useAtomCommand(backlogEnvironment.createIssue, {
    label: "backlog quick add",
    reportFailure: false,
  });
  const pickerScopes = scopes.filter(
    (scope) => scope.kind !== "all" && scope.kind !== "legacyInbox",
  );
  // Projects load after the sheet opens, so a requested project resolves lazily.
  const scope = resolveBacklogScope(
    pickerScopes,
    scopeKey ??
      (requestedProject ? findBacklogScopeForProject(pickerScopes, requestedProject)?.key : null) ??
      INBOX_BACKLOG_SCOPE_KEY,
  );
  const resolution = resolveBacklogCreateTarget(scope, environmentAvailability);
  const target = resolution.target;
  const titleSelection = selection ?? { start: draft.title.length, end: draft.title.length };

  const voiceInput = useVoiceInputController({
    ownerKey: VOICE_OWNER_KEY,
    label: "Backlog idea",
    readDraftMessage: () => appAtomRegistry.get(quickAddDraftAtom).title,
    subscribeToDraftChanges: (onChange) => appAtomRegistry.subscribe(quickAddDraftAtom, onChange),
    selection: titleSelection,
    disabled: saving,
    onChangeDraftMessage: (title) => updateDraft({ title }),
    onChangeSelection: setSelection,
  });
  const voicePresentation = resolveVoiceComposerPresentation(
    voiceInput.state,
    voiceInput.elapsedSeconds,
  );
  const showsDictation = voicePresentation.statusLabel !== null;
  const canSave =
    !saving && !voiceInput.blocksSubmission && target !== null && draft.title.trim().length > 0;

  const save = async () => {
    if (!canSave || target === null) return;
    setSaving(true);
    try {
      const notes = draft.notes.trim();
      const result = await createIssue({
        environmentId: target.environmentId,
        input: {
          ...target.input,
          title: draft.title.trim(),
          type: draft.type,
          ...(notes ? { body: notes } : {}),
        },
      });
      if (alertBacklogFailure("Could not add to the backlog", result)) return;
      appAtomRegistry.set(quickAddDraftAtom, EMPTY_DRAFT);
      setSelection(null);
      navigation.goBack();
    } finally {
      setSaving(false);
    }
  };

  const destination =
    target === null
      ? resolution.blockedReason
      : `Saves to ${environmentLabel(target.environmentId) ?? "this environment"}`;

  return (
    <View className="flex-1 bg-sheet">
      <KeyboardAvoidingView automaticOffset behavior="padding" className="flex-1">
        <View
          className="flex-row items-center justify-between px-5 py-2"
          style={{ paddingTop: Platform.OS === "android" ? insets.top + 8 : 10 }}
        >
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Close"
            className="h-12 w-12 items-center justify-center rounded-full bg-subtle active:opacity-70"
            onPress={() => navigation.goBack()}
          >
            <SymbolView name="xmark" size={18} tintColorClassName="accent-icon" type="monochrome" />
          </Pressable>
          <Text className="text-lg font-t3-bold text-foreground">Add to backlog</Text>
          <View className="h-12 w-12" />
        </View>

        <ScrollView
          className="flex-1"
          keyboardShouldPersistTaps="handled"
          contentContainerClassName="gap-4 px-5 pt-2 pb-4"
          showsVerticalScrollIndicator={false}
        >
          <View className="gap-2 rounded-[22px] bg-grouped-card px-4 py-3">
            <View className="relative">
              <TextInput
                accessibilityLabel="Title"
                autoFocus
                multiline
                placeholder="What's the idea or bug?"
                value={draft.title}
                onChangeText={(title) => updateDraft({ title })}
                selection={selection ?? undefined}
                onSelectionChange={({ nativeEvent }) => setSelection(nativeEvent.selection)}
                readOnly={saving || voiceInput.freezesEditor}
                className="max-h-40 min-h-16 pr-12 font-sans text-lg text-foreground"
              />
              {voiceInput.isAvailable && !showsDictation ? (
                <View className="absolute right-0 bottom-0">
                  <ComposerDictationStartAction
                    state={voiceInput.state}
                    isAvailable={voiceInput.isAvailable}
                    disabled={saving}
                    onStart={voiceInput.start}
                    onCancel={voiceInput.cancel}
                  />
                </View>
              ) : null}
            </View>
            {showsDictation ? (
              <ComposerDictationToolbar showsDictation>
                <View className="h-11 flex-row items-center">
                  <ComposerDictationCancelAction
                    presentation={voicePresentation}
                    onCancel={voiceInput.cancel}
                  />
                  <ComposerDictationStatus
                    audioLevels={voiceInput.audioLevels}
                    elapsedSeconds={voiceInput.elapsedSeconds}
                    phase={voiceInput.state.phase}
                    presentation={voicePresentation}
                    onDismissError={voiceInput.cancel}
                  />
                  <ComposerDictationPrimaryAction
                    state={voiceInput.state}
                    presentation={voicePresentation}
                    isAvailable={voiceInput.isAvailable}
                    disabled={saving}
                    onStart={voiceInput.start}
                    onConfirm={voiceInput.stop}
                    onCancel={voiceInput.cancel}
                  />
                </View>
              </ComposerDictationToolbar>
            ) : null}
            <View className="border-t border-border-subtle pt-2">
              <TextInput
                accessibilityLabel="Notes"
                multiline
                placeholder="Notes (optional)"
                value={draft.notes}
                onChangeText={(notes) => updateDraft({ notes })}
                readOnly={saving}
                className="max-h-40 min-h-11 font-sans text-base text-foreground"
              />
            </View>
          </View>

          <View className="flex-row gap-2">
            {BACKLOG_TYPES.map((type) => {
              const selected = draft.type === type;
              return (
                <Pressable
                  key={type}
                  accessibilityRole="radio"
                  accessibilityState={{ selected }}
                  onPress={() => updateDraft({ type })}
                  className={cn(
                    "rounded-full px-4 py-2 active:opacity-70",
                    selected ? "bg-primary" : "bg-subtle",
                  )}
                >
                  <Text
                    className={cn(
                      "text-sm font-t3-bold",
                      selected ? "text-primary-foreground" : "text-foreground",
                    )}
                  >
                    {BACKLOG_TYPE_LABELS[type]}
                  </Text>
                </Pressable>
              );
            })}
          </View>

          <View className="gap-1.5">
            <ControlPillMenu
              actions={pickerScopes.map((option) => ({
                id: option.key,
                title: option.label,
                state: option.key === scope.key ? "on" : undefined,
              }))}
              onPressAction={({ nativeEvent }) => setScopeKey(nativeEvent.event)}
            >
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={`Backlog, ${scope.label}`}
                className="flex-row items-center gap-2 self-start rounded-full bg-subtle px-4 py-2.5 active:opacity-70"
              >
                <SymbolView
                  name="checklist"
                  size={14}
                  tintColorClassName="accent-icon"
                  type="monochrome"
                />
                <Text className="text-sm font-t3-bold text-foreground" numberOfLines={1}>
                  {scope.label}
                </Text>
                <SymbolView
                  name="chevron.down"
                  size={12}
                  tintColorClassName="accent-chevron"
                  type="monochrome"
                />
              </Pressable>
            </ControlPillMenu>
            <Text
              className={cn(
                "px-1 text-xs",
                target === null && !resolution.loading
                  ? "text-danger-foreground"
                  : "text-foreground-tertiary",
              )}
            >
              {destination}
            </Text>
          </View>
        </ScrollView>

        <View
          className="flex-row items-center justify-end border-t border-border bg-sheet px-5 pt-2"
          style={{ paddingBottom: Platform.OS === "android" ? Math.max(insets.bottom, 10) : 10 }}
        >
          <ControlPill
            accessibilityLabel="Add to backlog"
            icon="arrow.up"
            label={saving ? "Adding…" : "Add"}
            variant="primary"
            disabled={!canSave}
            onPress={() => void save()}
          />
        </View>
      </KeyboardAvoidingView>
    </View>
  );
}
