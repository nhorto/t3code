/**
 * Routes an agent's backlog calls to the environment that owns the backlog:
 * this one, or the hub it is linked to. Refs (WINE-12, WINE, ids) resolve here
 * first and on the hub second. New project backlogs and Inbox ideas go to the
 * hub when linked, since it is the fleet's default host; a project's existing
 * backlog here stays here. Everything one call touches must live on one home.
 *
 * With a hub there is one Inbox for the fleet, the hub's: INBOX and INBOX-n
 * name it, and an Inbox left on this machine is legacy. Its issues stay
 * reachable by id until moveInboxToHub re-creates them on the hub.
 *
 * While the hub is unreachable, reads answer from the last snapshot of it
 * (BacklogHubSnapshot) and say so with `stale: true` and `asOf`; writes fail
 * with code unavailable. A backlog that moved away from this machine answers
 * with where it went, or is followed to the hub when it moved there.
 *
 * Clients do not route: they connect to every environment directly. They read
 * this machine's board through `subscribe`, which says which hub it is linked to.
 */
import {
  BACKLOG_INBOX_KEY,
  BacklogError,
  isBacklogStatusClosed,
  type Backlog,
  type BacklogActivity,
  type BacklogActor,
  type BacklogChildInput,
  type BacklogClaimResult,
  type BacklogId,
  type BacklogIssue,
  type BacklogIssueDetail,
  type BacklogIssuePriority,
  type BacklogIssueStatus,
  type BacklogIssueType,
  type BacklogListIssuesInput,
  type BacklogMoveInboxToHubResult,
  type BacklogReleaseStatus,
  type BacklogRepositoryTarget,
  type BacklogStreamEvent,
  type EnvironmentId,
  parseBacklogIssueKey,
  type ProjectId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import { localBacklogHome, type BacklogHome } from "./BacklogHome.ts";
import { BacklogOrchestration } from "./BacklogOrchestration.ts";
import * as BacklogHubClient from "./BacklogHubClient.ts";
import * as BacklogHubSnapshot from "./BacklogHubSnapshot.ts";
import * as BacklogService from "./BacklogService.ts";

/** Where a backlog or issue lives, from this environment's point of view. */
export type BacklogHost = "local" | "hub";

/** How the hub answered a merged listing; null when this machine has no hub. */
export interface BacklogHubNote {
  readonly label: string;
  readonly state: "connected" | "unavailable";
  readonly message: string | null;
}

/** Which machine an issue answer came from. */
export interface BacklogHostFields {
  readonly host: BacklogHost;
  /** The hub's label, or "this machine". */
  readonly machine: string;
}

/** Present when part of an answer came from the hub's last snapshot instead of the hub. */
export interface BacklogStaleFields {
  readonly stale?: true;
  readonly asOf?: string;
}

export interface RoutedCreateIssueInput {
  readonly backlog?: string | undefined;
  readonly projectId?: ProjectId | undefined;
  readonly parent?: string | undefined;
  readonly blockedBy?: ReadonlyArray<string> | undefined;
  readonly title: string;
  readonly body?: string | undefined;
  readonly type?: BacklogIssueType | undefined;
  readonly status?: BacklogIssueStatus | undefined;
  readonly priority?: BacklogIssuePriority | null | undefined;
}

export interface RoutedUpdateIssueInput {
  readonly issue: string;
  readonly backlog?: string | undefined;
  readonly projectId?: ProjectId | undefined;
  readonly parent?: string | null | undefined;
  readonly blockedBy?: ReadonlyArray<string> | undefined;
  readonly title?: string | undefined;
  readonly body?: string | undefined;
  readonly type?: BacklogIssueType | undefined;
  readonly status?: BacklogIssueStatus | undefined;
  readonly priority?: BacklogIssuePriority | null | undefined;
}

export interface RoutedListIssuesInput {
  readonly backlog?: string | undefined;
  readonly projectId?: ProjectId | undefined;
  readonly parent?: string | undefined;
  readonly status?: ReadonlyArray<BacklogIssueStatus> | undefined;
  readonly type?: BacklogIssueType | undefined;
  readonly frontierOnly?: boolean | undefined;
}

export interface RoutedClaimNextInput {
  readonly backlog?: string | undefined;
  readonly projectId?: ProjectId | undefined;
  readonly parent?: string | undefined;
  readonly type?: BacklogIssueType | undefined;
}

export type RoutedChildInput = Omit<BacklogChildInput, "blockedBy"> & {
  readonly blockedBy?: ReadonlyArray<string> | undefined;
};

export class BacklogRouter extends Context.Service<
  BacklogRouter,
  {
    readonly listBacklogs: () => Effect.Effect<
      {
        readonly backlogs: ReadonlyArray<Backlog & { readonly host: BacklogHost }>;
        readonly hub: BacklogHubNote | null;
      } & BacklogStaleFields,
      BacklogError
    >;
    readonly listIssues: (input: RoutedListIssuesInput) => Effect.Effect<
      {
        readonly issues: ReadonlyArray<BacklogIssue & { readonly host: BacklogHost }>;
        readonly hub: BacklogHubNote | null;
      } & BacklogStaleFields,
      BacklogError
    >;
    readonly getIssue: (
      ref: string,
    ) => Effect.Effect<BacklogIssueDetail & BacklogHostFields & BacklogStaleFields, BacklogError>;
    readonly createIssue: (
      input: RoutedCreateIssueInput,
      actor: BacklogActor,
    ) => Effect.Effect<BacklogIssue, BacklogError>;
    readonly createChildren: (
      input: { readonly parent: string; readonly children: ReadonlyArray<RoutedChildInput> },
      actor: BacklogActor,
    ) => Effect.Effect<ReadonlyArray<BacklogIssue>, BacklogError>;
    readonly updateIssue: (
      input: RoutedUpdateIssueInput,
      actor: BacklogActor,
    ) => Effect.Effect<BacklogIssue, BacklogError>;
    readonly claim: (
      ref: string,
      actor: BacklogActor,
    ) => Effect.Effect<BacklogClaimResult & BacklogHostFields, BacklogError>;
    readonly claimNext: (
      input: RoutedClaimNextInput,
      actor: BacklogActor,
    ) => Effect.Effect<(BacklogClaimResult & BacklogHostFields) | null, BacklogError>;
    readonly release: (
      input: {
        readonly issue: string;
        readonly status: BacklogReleaseStatus;
        readonly note?: string | undefined;
      },
      actor: BacklogActor,
    ) => Effect.Effect<BacklogIssue, BacklogError>;
    readonly comment: (
      input: { readonly issue: string; readonly text: string },
      actor: BacklogActor,
    ) => Effect.Effect<BacklogActivity, BacklogError>;
    /** With an issue, links it; without, every issue the actor's thread holds here and on the hub. */
    readonly linkPullRequest: (
      input: { readonly url: string; readonly issue?: string | undefined },
      actor: BacklogActor,
    ) => Effect.Effect<ReadonlyArray<BacklogIssue>, BacklogError>;
    /**
     * This machine's board stream for clients: the service's, with each
     * snapshot naming the hub this machine is linked to, and a new snapshot
     * whenever the link changes.
     */
    readonly subscribe: () => Stream.Stream<BacklogStreamEvent, BacklogError>;
    /**
     * Re-creates each open issue of this machine's legacy Inbox on the hub's
     * Inbox and closes it here as wontfix, noting where it went. Issues an
     * agent holds stay until released. Only while linked.
     */
    readonly moveInboxToHub: (
      actor: BacklogActor,
    ) => Effect.Effect<BacklogMoveInboxToHubResult, BacklogError>;
  }
>()("t3/backlog/BacklogRouter") {}

interface Target {
  readonly host: BacklogHost;
  readonly home: BacklogHome;
  readonly label: string;
  /** The hub's environment; null for this machine. */
  readonly environmentId: EnvironmentId | null;
}

/** Where a project's issues go: an existing backlog, or one to create on first use. */
type ProjectPlacement =
  | { readonly target: Target; readonly backlogId: BacklogId }
  | { readonly target: Target; readonly repository: BacklogRepositoryTarget }
  | { readonly target: Target; readonly projectId: ProjectId };

const isNotFound = (error: BacklogError) => error.code === "not_found";
const isMoved = (error: BacklogError) => error.movedTo !== undefined;
const notFound = (message: string) => new BacklogError({ code: "not_found", message });
const invalid = (message: string) => new BacklogError({ code: "invalid", message });

const withHost =
  (host: BacklogHost) =>
  <A extends object>(rows: ReadonlyArray<A>): ReadonlyArray<A & { readonly host: BacklogHost }> =>
    rows.map((row) => ({ ...row, host }));

const isInboxRef = (ref: string) => ref.trim().toUpperCase() === BACKLOG_INBOX_KEY;

/** Parents before their children, so a moved child can point at its moved parent. */
const parentsFirst = (issues: ReadonlyArray<BacklogIssue>) => {
  const byId = new Map(issues.map((issue) => [issue.id, issue]));
  const depth = (issue: BacklogIssue) => {
    let levels = 0;
    for (let parent = issue.parentId; parent !== null && levels < issues.length; levels++) {
      const above = byId.get(parent);
      if (above === undefined) break;
      parent = above.parentId;
    }
    return levels;
  };
  return issues.toSorted((left, right) => depth(left) - depth(right) || left.number - right.number);
};

const backlogMatches = (backlog: Backlog, ref: string) =>
  backlog.id === ref.trim() || backlog.key === ref.trim().toUpperCase();

const placementInput = (placement: ProjectPlacement) =>
  "backlogId" in placement
    ? { backlogId: placement.backlogId }
    : "repository" in placement
      ? { repository: placement.repository }
      : { projectId: placement.projectId };

const crossMachine = () =>
  invalid(
    "That would move an issue between machines, which is not supported yet. Create it on the other backlog instead.",
  );

export const make = Effect.gen(function* () {
  const service = yield* BacklogService.BacklogService;
  const hubClient = yield* BacklogHubClient.BacklogHubClient;
  const orchestration = yield* BacklogOrchestration;
  const snapshot = yield* BacklogHubSnapshot.BacklogHubSnapshot;

  const local: Target = {
    host: "local",
    home: localBacklogHome(service),
    label: "this machine",
    environmentId: null,
  };
  const hub = hubClient.linkedHub.pipe(
    Effect.map(
      Option.map((linked): Target => ({
        host: "hub",
        home: snapshot.wrap(linked.environmentId, hubClient.home),
        label: linked.label,
        environmentId: linked.environmentId,
      })),
    ),
  );
  /** The hub, when a backlog that moved away from here went to it. */
  const hubHolding = (backlog: Pick<Backlog, "movedTo">) =>
    hub.pipe(
      Effect.map(
        Option.filter(
          (target) =>
            backlog.movedTo !== undefined && target.environmentId === backlog.movedTo.environmentId,
        ),
      ),
    );
  /** Follows a moved backlog's redirect to the hub, or reports where it went. */
  const followMove = <A>(
    error: BacklogError,
    onHub: (target: Target) => Effect.Effect<A, BacklogError>,
  ) =>
    hubHolding({ movedTo: error.movedTo }).pipe(
      Effect.flatMap(
        Option.match({ onNone: () => Effect.fail(error), onSome: (target) => onHub(target) }),
      ),
    );
  /** Where new backlogs and Inbox ideas go: the hub when linked. */
  const defaultTarget = hub.pipe(Effect.map(Option.getOrElse(() => local)));

  const hostOf = (target: Target): BacklogHostFields => ({
    host: target.host,
    machine: target.label,
  });

  /**
   * A key that names something here and something else on the hub is
   * ambiguous (both machines have an INBOX, and keys are chosen per machine).
   * Ids are global, so they never are.
   */
  const unlessAlsoOnHub = (
    ref: string,
    localId: string,
    onHub: (target: Target) => Effect.Effect<string, BacklogError>,
  ) =>
    Effect.gen(function* () {
      const linked = yield* hub;
      if (Option.isNone(linked)) return;
      const there = yield* Effect.result(onHub(linked.value));
      if (there._tag === "Success" && there.success !== localId) {
        return yield* invalid(
          `${ref.trim()} is ambiguous: it names ${localId} on this machine and ${there.success} on ${linked.value.label}. Pass the id instead.`,
        );
      }
    });

  /**
   * Local first, then the hub. A key found on both is ambiguous, except
   * INBOX-n: with a hub it is always the hub's.
   */
  const resolveIssue = (ref: string) =>
    Effect.gen(function* () {
      if (parseBacklogIssueKey(ref)?.backlogKey === BACKLOG_INBOX_KEY) {
        const linked = yield* hub;
        if (Option.isSome(linked)) {
          const target = linked.value;
          return { target, id: yield* target.home.resolveIssue(ref) };
        }
      }
      return yield* resolveIssueHereOrOnHub(ref);
    });

  const resolveIssueHereOrOnHub = (ref: string) =>
    local.home.resolveIssue(ref).pipe(
      Effect.tap((id) =>
        parseBacklogIssueKey(ref) === null
          ? Effect.void
          : unlessAlsoOnHub(ref, id, (target) => target.home.resolveIssue(ref)),
      ),
      Effect.map((id) => ({ target: local, id })),
      Effect.catchIf(isNotFound, (localMiss) =>
        Effect.gen(function* () {
          const linked = yield* hub;
          if (Option.isNone(linked)) return yield* localMiss;
          const target = linked.value;
          const id = yield* target.home.resolveIssue(ref).pipe(
            Effect.mapError(
              (error) =>
                new BacklogError({
                  ...error,
                  message: `${ref} is not on this machine. On ${target.label}: ${error.message}`,
                }),
            ),
          );
          return { target, id };
        }),
      ),
      Effect.catchIf(isMoved, (moved) =>
        followMove(moved, (target) =>
          target.home.resolveIssue(ref).pipe(Effect.map((id) => ({ target, id }))),
        ),
      ),
    );

  const resolveIssueIn = (target: Target, refs: ReadonlyArray<string>) =>
    Effect.forEach(refs, (ref) =>
      target.home.resolveIssue(ref).pipe(
        Effect.mapError((error) =>
          error.code === "not_found" && target.host === "local"
            ? new BacklogError({
                ...error,
                message: `${error.message} Related issues must be on the same machine as the issue.`,
              })
            : error,
        ),
      ),
    );

  /** Like resolveIssue: INBOX is the hub's Inbox while linked. */
  const resolveBacklog = (ref: string) =>
    Effect.gen(function* () {
      if (isInboxRef(ref)) {
        const linked = yield* hub;
        if (Option.isSome(linked)) {
          const target = linked.value;
          const inbox = (yield* target.home.listBacklogs()).find(
            (backlog) => backlog.kind === "inbox",
          );
          if (inbox === undefined) {
            return yield* notFound(
              `${target.label} has no Inbox yet. Create an issue without a backlog to start it.`,
            );
          }
          return { target, backlogId: inbox.id };
        }
      }
      return yield* resolveBacklogHereOrOnHub(ref);
    });

  const resolveBacklogHereOrOnHub = (ref: string) =>
    service.resolveBacklogRef(ref).pipe(
      Effect.tap((backlog) =>
        backlog.id === ref.trim()
          ? Effect.void
          : unlessAlsoOnHub(ref, backlog.id, (target) =>
              target.home.listBacklogs().pipe(
                Effect.flatMap((backlogs) => {
                  const found = backlogs.find((candidate) => backlogMatches(candidate, ref));
                  return found === undefined
                    ? Effect.fail(notFound(`Backlog ${ref} is not on ${target.label}.`))
                    : Effect.succeed(found.id as string);
                }),
              ),
            ),
      ),
      Effect.map((backlog) => ({ target: local, backlogId: backlog.id })),
      Effect.catchIf(isNotFound, (localMiss) =>
        Effect.gen(function* () {
          const linked = yield* hub;
          if (Option.isNone(linked)) return yield* localMiss;
          const found = (yield* linked.value.home.listBacklogs()).find((backlog) =>
            backlogMatches(backlog, ref),
          );
          if (found === undefined) {
            return yield* notFound(
              `Backlog ${ref} is not on this machine or on ${linked.value.label}.`,
            );
          }
          return { target: linked.value, backlogId: found.id };
        }),
      ),
      Effect.catchIf(isMoved, (moved) =>
        followMove(moved, (target) =>
          target.home.listBacklogs().pipe(
            Effect.flatMap((backlogs) => {
              const found = backlogs.find((backlog) => backlogMatches(backlog, ref));
              return found === undefined
                ? Effect.fail(moved)
                : Effect.succeed({ target, backlogId: found.id });
            }),
          ),
        ),
      ),
    );

  /**
   * A project's backlog here wins. Otherwise, with a hub, the project's
   * repository names the backlog there, since project ids are local. With
   * `find`, nothing is created: a project without a backlog yields none.
   */
  const placeProject = (projectId: ProjectId, mode: "create" | "find") =>
    Effect.gen(function* () {
      const shell = yield* orchestration.getProject(projectId);
      if (Option.isNone(shell)) return yield* notFound("Project not found.");
      const repositoryKey = shell.value.repositoryIdentity?.canonicalKey ?? null;
      const own = (yield* service.listBacklogs()).find(
        (backlog) =>
          backlog.projectId === projectId ||
          (repositoryKey !== null && backlog.repositoryKey === repositoryKey),
      );
      // A backlog moved to the hub is placed there below, by repository.
      if (own !== undefined && Option.isNone(yield* hubHolding(own)))
        return Option.some<ProjectPlacement>({ target: local, backlogId: own.id });
      const linked = yield* hub;
      if (Option.isSome(linked) && repositoryKey !== null) {
        const target = linked.value;
        if (mode === "create") {
          return Option.some<ProjectPlacement>({
            target,
            repository: { key: repositoryKey, title: shell.value.title },
          });
        }
        const onHub = (yield* target.home.listBacklogs()).find(
          (backlog) => backlog.repositoryKey === repositoryKey,
        );
        return onHub === undefined
          ? Option.none<ProjectPlacement>()
          : Option.some<ProjectPlacement>({ target, backlogId: onHub.id });
      }
      return mode === "create"
        ? Option.some<ProjectPlacement>({ target: local, projectId })
        : Option.none<ProjectPlacement>();
    });

  const placeProjectForCreate = (projectId: ProjectId) =>
    placeProject(projectId, "create").pipe(
      Effect.flatMap(
        Option.match({
          onNone: () => Effect.fail(notFound("Project not found.")),
          onSome: Effect.succeed,
        }),
      ),
    );

  /** The hub's answer for a merged listing, or how it failed. */
  const listOnHub = <A>(list: (target: Target) => Effect.Effect<ReadonlyArray<A>, BacklogError>) =>
    Effect.gen(function* () {
      const linked = yield* hub;
      if (Option.isNone(linked)) return { rows: [] as ReadonlyArray<A>, note: null };
      const target = linked.value;
      const result = yield* Effect.result(list(target));
      if (result._tag === "Failure") {
        if (result.failure.code !== "unavailable") return yield* result.failure;
        return {
          rows: [] as ReadonlyArray<A>,
          note: { label: target.label, state: "unavailable", message: result.failure.message },
        } satisfies { rows: ReadonlyArray<A>; note: BacklogHubNote };
      }
      return {
        rows: result.success,
        note: { label: target.label, state: "connected", message: null },
      } satisfies { rows: ReadonlyArray<A>; note: BacklogHubNote };
    });

  const noteFor = (target: Target): BacklogHubNote | null =>
    target.host === "hub" ? { label: target.label, state: "connected", message: null } : null;

  /** Marks an answer that used the hub's snapshot, and its hub note with it. */
  const tracked = <A extends object>(effect: Effect.Effect<A, BacklogError>) =>
    snapshot.track(effect).pipe(
      Effect.map(({ value, stale }): A & BacklogStaleFields => {
        if (stale === null) return value;
        const note: BacklogHubNote | null | undefined =
          "hub" in value ? (value.hub as BacklogHubNote | null) : undefined;
        return {
          ...value,
          ...(note === undefined || note === null
            ? {}
            : {
                hub: {
                  label: note.label,
                  state: "unavailable",
                  message: `${note.label} is unreachable; its rows are what it last reported, as of ${stale.asOf}. Changes to them fail until it is back.`,
                } satisfies BacklogHubNote,
              }),
          stale: true,
          asOf: stale.asOf,
        };
      }),
    );

  const listBacklogs: BacklogRouter["Service"]["listBacklogs"] = () =>
    tracked(
      Effect.gen(function* () {
        const linked = Option.isSome(yield* hub);
        // A linked machine's own Inbox is legacy; INBOX names the hub's.
        const own = (yield* service.listBacklogs()).filter(
          (backlog) => !(linked && backlog.kind === "inbox"),
        );
        const remote = yield* listOnHub((target) => target.home.listBacklogs());
        return {
          backlogs: [...withHost("local")(own), ...withHost("hub")(remote.rows)],
          hub: remote.note,
        };
      }),
    );

  const listIssues: BacklogRouter["Service"]["listIssues"] = (input) =>
    tracked(
      Effect.gen(function* () {
        const filters: BacklogListIssuesInput = {
          status: input.status,
          type: input.type,
          frontierOnly: input.frontierOnly,
        };
        const scoped = (target: Target, backlogId: BacklogId | undefined) =>
          Effect.gen(function* () {
            const parentId =
              input.parent === undefined
                ? undefined
                : (yield* resolveIssueIn(target, [input.parent]))[0];
            const issues = yield* target.home.listIssues({ ...filters, backlogId, parentId });
            return { issues: withHost(target.host)(issues), hub: noteFor(target) };
          });
        if (input.backlog !== undefined) {
          const { target, backlogId } = yield* resolveBacklog(input.backlog);
          return yield* scoped(target, backlogId);
        }
        if (input.projectId !== undefined) {
          const placement = yield* placeProject(input.projectId, "find");
          if (Option.isNone(placement) || !("backlogId" in placement.value)) {
            return { issues: [], hub: null };
          }
          return yield* scoped(placement.value.target, placement.value.backlogId);
        }
        if (input.parent !== undefined) {
          const { target } = yield* resolveIssue(input.parent);
          return yield* scoped(target, undefined);
        }
        // Legacy Inbox issues would read as the hub's INBOX-n; they stay reachable by id.
        const own = yield* service.listIssues({
          ...filters,
          excludeInbox: Option.isSome(yield* hub),
        });
        const remote = yield* listOnHub((target) => target.home.listIssues(filters));
        return {
          issues: [...withHost("local")(own), ...withHost("hub")(remote.rows)],
          hub: remote.note,
        };
      }),
    );

  const getIssue: BacklogRouter["Service"]["getIssue"] = (ref) =>
    tracked(
      resolveIssue(ref).pipe(
        Effect.flatMap(({ target, id }) =>
          target.home
            .getIssue({ issueId: id })
            .pipe(Effect.map((detail) => ({ ...detail, ...hostOf(target) }))),
        ),
      ),
    );

  const createIssue: BacklogRouter["Service"]["createIssue"] = (
    { backlog, projectId, parent, blockedBy, ...fields },
    actor,
  ) =>
    Effect.gen(function* () {
      const placed =
        backlog !== undefined && isInboxRef(backlog)
          ? // The Inbox host creates its Inbox on first use.
            { target: yield* defaultTarget, where: {} }
          : backlog !== undefined
            ? yield* resolveBacklog(backlog).pipe(
                Effect.map(({ target, backlogId }) => ({ target, where: { backlogId } })),
              )
            : projectId !== undefined
              ? yield* placeProjectForCreate(projectId).pipe(
                  Effect.map((placement) => ({
                    target: placement.target,
                    where: placementInput(placement),
                  })),
                )
              : parent !== undefined
                ? // A child with no other target joins its parent's backlog.
                  yield* resolveIssue(parent).pipe(
                    Effect.flatMap(({ target, id }) =>
                      target.home.getIssue({ issueId: id }).pipe(
                        Effect.map((detail) => ({
                          target,
                          where: { backlogId: detail.issue.backlogId },
                        })),
                      ),
                    ),
                  )
                : { target: yield* defaultTarget, where: {} };
      const { target, where } = placed;
      return yield* target.home.createIssue(
        {
          ...fields,
          ...where,
          ...(parent === undefined
            ? {}
            : { parentId: (yield* resolveIssueIn(target, [parent]))[0]! }),
          ...(blockedBy === undefined
            ? {}
            : { blockedBy: yield* resolveIssueIn(target, blockedBy) }),
        },
        actor,
      );
    });

  const createChildren: BacklogRouter["Service"]["createChildren"] = (input, actor) =>
    Effect.gen(function* () {
      const { target, id } = yield* resolveIssue(input.parent);
      const children = yield* Effect.forEach(input.children, ({ blockedBy, ...child }) =>
        blockedBy === undefined
          ? Effect.succeed(child)
          : resolveIssueIn(target, blockedBy).pipe(
              Effect.map((ids) => ({ ...child, blockedBy: ids })),
            ),
      );
      return yield* target.home.createChildren({ parentId: id, children }, actor);
    });

  const updateIssue: BacklogRouter["Service"]["updateIssue"] = (
    { issue, backlog, projectId, parent, blockedBy, ...fields },
    actor,
  ) =>
    Effect.gen(function* () {
      const { target, id } = yield* resolveIssue(issue);
      let move: Record<string, unknown> = {};
      if (backlog !== undefined) {
        const destination = yield* resolveBacklog(backlog);
        if (destination.target.host !== target.host) return yield* crossMachine();
        move = { backlogId: destination.backlogId };
      } else if (projectId !== undefined) {
        const placement = yield* placeProjectForCreate(projectId);
        if (placement.target.host !== target.host) return yield* crossMachine();
        move = placementInput(placement);
      }
      return yield* target.home.updateIssue(
        {
          ...fields,
          ...move,
          issueId: id,
          ...(parent === undefined
            ? {}
            : {
                parentId: parent === null ? null : (yield* resolveIssueIn(target, [parent]))[0]!,
              }),
          ...(blockedBy === undefined
            ? {}
            : { blockedBy: yield* resolveIssueIn(target, blockedBy) }),
        },
        actor,
      );
    });

  const claim: BacklogRouter["Service"]["claim"] = (ref, actor) =>
    resolveIssue(ref).pipe(
      Effect.flatMap(({ target, id }) =>
        target.home
          .claim({ issueId: id }, actor)
          .pipe(Effect.map((claimed) => ({ ...claimed, ...hostOf(target) }))),
      ),
    );

  const claimNext: BacklogRouter["Service"]["claimNext"] = (input, actor) =>
    Effect.gen(function* () {
      const claimIn = (target: Target, backlogId: BacklogId | undefined) =>
        Effect.gen(function* () {
          const parentId =
            input.parent === undefined
              ? undefined
              : (yield* resolveIssueIn(target, [input.parent]))[0];
          const claimed = yield* target.home.claimNext(
            { backlogId, parentId, type: input.type },
            actor,
          );
          return claimed === null ? null : { ...claimed, ...hostOf(target) };
        });
      if (input.backlog !== undefined) {
        const { target, backlogId } = yield* resolveBacklog(input.backlog);
        return yield* claimIn(target, backlogId);
      }
      if (input.projectId !== undefined) {
        const placement = yield* placeProject(input.projectId, "find");
        if (Option.isNone(placement) || !("backlogId" in placement.value)) return null;
        return yield* claimIn(placement.value.target, placement.value.backlogId);
      }
      if (input.parent !== undefined) {
        return yield* claimIn((yield* resolveIssue(input.parent)).target, undefined);
      }
      const linked = yield* hub;
      const here = yield* service
        .claimNext({ type: input.type, excludeInbox: Option.isSome(linked) }, actor)
        .pipe(
          Effect.map((claimed) => (claimed === null ? null : { ...claimed, ...hostOf(local) })),
        );
      if (here !== null) return here;
      return Option.isNone(linked) ? null : yield* claimIn(linked.value, undefined);
    });

  const release: BacklogRouter["Service"]["release"] = ({ issue, status, note }, actor) =>
    resolveIssue(issue).pipe(
      Effect.flatMap(({ target, id }) =>
        target.home.release(
          { issueId: id, status, ...(note === undefined ? {} : { note }) },
          actor,
        ),
      ),
    );

  const comment: BacklogRouter["Service"]["comment"] = ({ issue, text }, actor) =>
    resolveIssue(issue).pipe(
      Effect.flatMap(({ target, id }) => target.home.comment({ issueId: id, text }, actor)),
    );

  const linkPullRequest: BacklogRouter["Service"]["linkPullRequest"] = ({ url, issue }, actor) =>
    issue !== undefined
      ? resolveIssue(issue).pipe(
          Effect.flatMap(({ target, id }) =>
            target.home.linkPullRequest({ url, issueId: id }, actor),
          ),
        )
      : Effect.gen(function* () {
          const own = yield* local.home.linkPullRequest({ url }, actor);
          const remote = yield* listOnHub((target) => target.home.linkPullRequest({ url }, actor));
          return [...own, ...remote.rows];
        });

  const subscribe: BacklogRouter["Service"]["subscribe"] = () =>
    hubClient.linkedHubChanges.pipe(
      Stream.changesWith(
        (left, right) =>
          Option.getOrNull(left)?.environmentId === Option.getOrNull(right)?.environmentId &&
          Option.getOrNull(left)?.label === Option.getOrNull(right)?.label,
      ),
      Stream.switchMap((linked) =>
        service
          .subscribe()
          .pipe(
            Stream.map((event): BacklogStreamEvent =>
              event.type === "snapshot" ? { ...event, linkedHub: Option.getOrNull(linked) } : event,
            ),
          ),
      ),
    );

  const moveLock = yield* Semaphore.make(1);
  const moveInboxToHub: BacklogRouter["Service"]["moveInboxToHub"] = (actor) =>
    moveLock.withPermits(1)(
      Effect.gen(function* () {
        const linked = yield* hub;
        if (Option.isNone(linked)) {
          return yield* invalid(
            "This machine is not linked to a hub; its Inbox is the one in use.",
          );
        }
        const target = linked.value;
        const inbox = (yield* service.listBacklogs()).find((backlog) => backlog.kind === "inbox");
        const open =
          inbox === undefined
            ? []
            : (yield* service.listIssues({ backlogId: inbox.id })).filter(
                (issue) => !isBacklogStatusClosed(issue.status),
              );
        const movedIds = new Map<string, BacklogIssue["id"]>();
        const moved: Array<{ from: string; to: string }> = [];
        const skipped: string[] = [];
        for (const issue of parentsFirst(open)) {
          if (issue.claim !== null) {
            skipped.push(issue.key);
            continue;
          }
          const { body } = yield* service.getIssue({ issueId: issue.id });
          const parentId = issue.parentId === null ? undefined : movedIds.get(issue.parentId);
          const created = yield* target.home.createIssue(
            {
              title: issue.title,
              body,
              type: issue.type,
              status: issue.status,
              priority: issue.priority,
              ...(parentId === undefined ? {} : { parentId }),
            },
            actor,
          );
          movedIds.set(issue.id, created.id);
          // Closed before the note, so a failure between them never leaves a duplicate open.
          yield* service.updateIssue({ issueId: issue.id, status: "wontfix" }, actor);
          yield* service.comment(
            { issueId: issue.id, text: `Moved to ${target.label} Inbox as ${created.key}.` },
            actor,
          );
          moved.push({ from: issue.key, to: created.key });
        }
        return { hub: target.label, moved, skipped };
      }),
    );

  return BacklogRouter.of({
    listBacklogs,
    listIssues,
    getIssue,
    createIssue,
    createChildren,
    updateIssue,
    claim,
    claimNext,
    release,
    comment,
    linkPullRequest,
    subscribe,
    moveInboxToHub,
  });
});

export const layer = Layer.effect(BacklogRouter, make);

/**
 * One Inbox per fleet: an unlinked machine creates its own at startup, while a
 * machine linked to a hub uses the hub's and creates none.
 */
export const inboxLayer = Layer.effectDiscard(
  Effect.gen(function* () {
    const hubClient = yield* BacklogHubClient.BacklogHubClient;
    const service = yield* BacklogService.BacklogService;
    if (Option.isSome(yield* hubClient.linkedHub)) return;
    yield* service
      .ensureInbox()
      .pipe(Effect.catch((cause) => Effect.logWarning("Could not create the Inbox", { cause })));
  }),
);

/** The router with the hub link and its lease renewal, for the server runtime. */
export const fleetLayer = Layer.mergeAll(layer, BacklogHubClient.renewalLayer, inboxLayer).pipe(
  Layer.provideMerge(BacklogHubClient.layer),
  Layer.provideMerge(BacklogHubSnapshot.layer),
);
