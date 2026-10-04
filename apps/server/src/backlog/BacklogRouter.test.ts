import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { assert, it } from "@effect/vitest";
import {
  EnvironmentId,
  ProjectId,
  ThreadId,
  type BacklogActor,
  type OrchestrationProjectShell,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { localBacklogHome, type BacklogHome } from "./BacklogHome.ts";
import * as BacklogHubClient from "./BacklogHubClient.ts";
import * as BacklogHubSnapshot from "./BacklogHubSnapshot.ts";
import { BacklogOrchestration } from "./BacklogOrchestration.ts";
import { BacklogRouter, inboxLayer, layer as routerLayer } from "./BacklogRouter.ts";
import { BacklogService, layer as serviceLayer } from "./BacklogService.ts";

const spoke = EnvironmentId.make("environment-mac");
const agent: BacklogActor = {
  kind: "agent",
  environmentId: spoke,
  threadId: ThreadId.make("thread-mac"),
  label: "Mac agent",
};
const hubUser: BacklogActor = { kind: "user", environmentId: null, threadId: null, label: "You" };

const corkAndNote = ProjectId.make("project-cork");
const scratch = ProjectId.make("project-scratch");
const CORK_REPOSITORY = "github.com/nhorto/cork-and-note";

/** The spoke's projects; the hub has none of its own. */
const spokeProjects: Record<string, { title: string; canonicalKey: string | null }> = {
  [corkAndNote]: { title: "Cork & Note", canonicalKey: CORK_REPOSITORY },
  [scratch]: { title: "Scratch", canonicalKey: null },
};

/** A machine's projects; none of its threads hold claims. */
const orchestration = (projects: typeof spokeProjects) =>
  Layer.mock(BacklogOrchestration)({
    getProject: (projectId) => Effect.succeed(projectShell(projects, projectId)),
    listProjects: () =>
      Effect.succeed(
        Object.keys(projects).flatMap((id) =>
          Option.toArray(projectShell(projects, ProjectId.make(id))),
        ),
      ),
    getThread: () => Effect.succeed(null),
  });

const backlogService = (projects: typeof spokeProjects) =>
  serviceLayer.pipe(
    Layer.provide(Layer.mergeAll(NodeCrypto.layer, orchestration(projects))),
    Layer.provide(SqlitePersistenceMemory),
  );

function projectShell(projects: typeof spokeProjects, projectId: ProjectId) {
  const project = projects[projectId];
  return project === undefined
    ? Option.none()
    : Option.some({
        id: projectId,
        title: project.title,
        repositoryIdentity:
          project.canonicalKey === null ? null : { canonicalKey: project.canonicalKey },
      } as unknown as OrchestrationProjectShell);
}

const unreachable: BacklogHome = (() => {
  const fail = () =>
    Effect.fail(BacklogHubClient.unavailable("unreachable", "Geekom is unreachable."));
  return {
    listBacklogs: fail,
    listIssues: fail,
    resolveIssue: fail,
    getIssue: fail,
    createIssue: fail,
    createChildren: fail,
    updateIssue: fail,
    comment: fail,
    claim: fail,
    claimNext: fail,
    release: fail,
    linkPullRequest: fail,
  };
})();

/**
 * A spoke linked to a hub. The fake hub client serves a second, real backlog
 * service, which is exactly what the hub's RPC handlers call. `setHubUp`
 * takes the hub off the network and back.
 */
const geekom = { environmentId: EnvironmentId.make("environment-geekom"), label: "Geekom" };

const fleet = (hubState: "up" | "down" | "not_linked") =>
  Effect.gen(function* () {
    const hub = Context.get(yield* Layer.build(backlogService({})), BacklogService);
    let hubUp = hubState === "up";
    const hubHome = localBacklogHome(hub);
    const switchable = Object.fromEntries(
      Object.keys(hubHome).map((name) => [
        name,
        (...args: ReadonlyArray<unknown>) =>
          ((hubUp ? hubHome : unreachable) as unknown as Record<string, Function>)[name]!(...args),
      ]),
    ) as unknown as BacklogHome;
    const linkedHub = hubState === "not_linked" ? Option.none() : Option.some(geekom);
    const spokeContext = yield* Layer.build(
      Layer.mergeAll(routerLayer, inboxLayer).pipe(
        Layer.provideMerge(backlogService(spokeProjects)),
        Layer.provideMerge(BacklogHubSnapshot.layer.pipe(Layer.provide(SqlitePersistenceMemory))),
        Layer.provideMerge(orchestration(spokeProjects)),
        Layer.provide(
          Layer.mock(BacklogHubClient.BacklogHubClient)({
            linkedHub: Effect.succeed(linkedHub),
            linkedHubChanges: Stream.make(linkedHub),
            home: switchable,
          }),
        ),
      ),
    );
    return {
      router: Context.get(spokeContext, BacklogRouter),
      local: Context.get(spokeContext, BacklogService),
      hub,
      setHubUp: (up: boolean) => {
        hubUp = up;
      },
    };
  });

it.effect("works an issue on this machine without asking the hub", () =>
  Effect.gen(function* () {
    const { router, local, hub } = yield* fleet("down");
    const backlog = yield* local.ensureProjectBacklog(corkAndNote);
    yield* local.createIssue({ backlogId: backlog.id, title: "Paywall", status: "ready" }, hubUser);

    const claimed = yield* router.claim("CN-1", agent);
    assert.equal(claimed.issue.status, "in_progress");
    // The project's existing local backlog wins over the hub default.
    const sibling = yield* router.createIssue({ projectId: corkAndNote, title: "Receipts" }, agent);
    assert.equal(sibling.key, "CN-2");
    assert.lengthOf(yield* hub.listIssues(), 0);
  }).pipe(Effect.scoped),
);

it.effect("claims an issue homed on the hub as this machine's agent, exclusively", () =>
  Effect.gen(function* () {
    const { router, hub } = yield* fleet("up");
    const created = yield* router.createIssue(
      { projectId: corkAndNote, title: "Paywall crashes on iPad", status: "ready" },
      agent,
    );
    const claimed = yield* router.claim(created.key, agent);
    assert.isFalse(claimed.alreadyHeld);

    const onHub = yield* hub.getIssue({ issueId: created.id });
    assert.deepEqual(onHub.issue.claim?.actor, agent);
    const rival = yield* hub
      .claim(
        { issueId: created.id },
        { ...agent, environmentId: EnvironmentId.make("environment-ex"), label: "EX agent" },
      )
      .pipe(Effect.flip);
    assert.equal(rival.code, "conflict");

    const released = yield* router.release({ issue: created.key, status: "review" }, agent);
    assert.equal(released.status, "review");
  }).pipe(Effect.scoped),
);

it.effect("creates a project's first backlog on the hub, keyed by its repository", () =>
  Effect.gen(function* () {
    const { router, local, hub } = yield* fleet("up");
    const first = yield* router.createIssue({ projectId: corkAndNote, title: "Paywall" }, agent);
    const second = yield* router.createIssue({ projectId: corkAndNote, title: "Receipts" }, agent);
    assert.deepEqual([first.key, second.key], ["CN-1", "CN-2"]);

    const hubBacklogs = yield* hub.listBacklogs();
    const cork = hubBacklogs.find((backlog) => backlog.key === "CN");
    assert.equal(cork?.repositoryKey, CORK_REPOSITORY);
    assert.isNull(cork?.projectId ?? null);
    assert.isUndefined((yield* local.listBacklogs()).find((backlog) => backlog.key === "CN"));

    // Inbox ideas go to the hub too; a project without a repository stays here.
    const idea = yield* router.createIssue({ title: "Voice capture" }, agent);
    assert.equal((yield* hub.getIssue({ issueId: idea.id })).issue.key, "INBOX-1");
    const local1 = yield* router.createIssue({ projectId: scratch, title: "Try it" }, agent);
    assert.equal((yield* local.getIssue({ issueId: local1.id })).issue.key, "SCRATC-1");
  }).pipe(Effect.scoped),
);

it.effect("reports an unreachable hub as unavailable instead of guessing", () =>
  Effect.gen(function* () {
    const { router } = yield* fleet("down");
    const claim = yield* router.claim("CN-1", agent).pipe(Effect.flip);
    assert.equal(claim.code, "unavailable");
    assert.equal(claim.reason, "unreachable");
    assert.include(claim.message, "CN-1 is not on this machine");

    const capture = yield* router.createIssue({ title: "Idea" }, agent).pipe(Effect.flip);
    assert.equal(capture.code, "unavailable");
  }).pipe(Effect.scoped),
);

it.effect("lists this machine's issues with the hub's, marking a down hub", () =>
  Effect.gen(function* () {
    const up = yield* fleet("up");
    yield* up.local.createIssue({ projectId: scratch, title: "Here" }, hubUser);
    yield* up.hub.createIssue({ title: "There" }, hubUser);
    const merged = yield* up.router.listIssues({});
    assert.deepEqual(
      merged.issues.map((issue) => [issue.title, issue.host]),
      [
        ["Here", "local"],
        ["There", "hub"],
      ],
    );
    assert.deepEqual(merged.hub, { label: "Geekom", state: "connected", message: null });

    const down = yield* fleet("down");
    yield* down.local.createIssue({ projectId: scratch, title: "Here" }, hubUser);
    const partial = yield* down.router.listIssues({});
    assert.deepEqual(
      partial.issues.map((issue) => issue.title),
      ["Here"],
    );
    assert.equal(partial.hub?.state, "unavailable");
  }).pipe(Effect.scoped),
);

it.effect("never creates a backlog to answer a read", () =>
  Effect.gen(function* () {
    const { router, local, hub } = yield* fleet("up");
    const listed = yield* router.listIssues({ projectId: corkAndNote, frontierOnly: true });
    assert.lengthOf(listed.issues, 0);
    assert.isNull(yield* router.claimNext({ projectId: corkAndNote }, agent));
    assert.deepEqual(
      [(yield* local.listBacklogs()).length, (yield* hub.listBacklogs()).length],
      [0, 0],
    );
  }).pipe(Effect.scoped),
);

it.effect("keeps everything on this machine when it has no hub", () =>
  Effect.gen(function* () {
    const { router, local } = yield* fleet("not_linked");
    const idea = yield* router.createIssue({ title: "Idea" }, agent);
    assert.equal((yield* local.getIssue({ issueId: idea.id })).issue.key, "INBOX-1");
    const missing = yield* router.getIssue("CN-9").pipe(Effect.flip);
    assert.equal(missing.code, "not_found");
    const listed = yield* router.listIssues({});
    assert.isNull(listed.hub);
  }).pipe(Effect.scoped),
);

it.effect("answers reads from the hub's last snapshot while it is down, marked stale", () =>
  Effect.gen(function* () {
    const { router, hub, setHubUp } = yield* fleet("up");
    const spec = yield* hub.createIssue({ title: "Spec", body: "The plan" }, hubUser);
    yield* hub.createIssue({ title: "Quick idea" }, hubUser);
    const live = yield* router.listIssues({});
    assert.isUndefined(live.stale);
    yield* router.getIssue(spec.key);

    setHubUp(false);
    const listed = yield* router.listIssues({});
    assert.deepEqual(
      listed.issues.map((issue) => [issue.title, issue.host]),
      [
        ["Spec", "hub"],
        ["Quick idea", "hub"],
      ],
    );
    assert.isTrue(listed.stale);
    assert.isString(listed.asOf);
    assert.equal(listed.hub?.state, "unavailable");

    const detail = yield* router.getIssue(spec.key);
    assert.equal(detail.body, "The plan");
    assert.isTrue(detail.stale);
    // A body never read cannot be made up; a row without one is answered whole.
    const idea = yield* router.getIssue("INBOX-2");
    assert.equal(idea.issue.title, "Quick idea");
    assert.isTrue(idea.stale);

    const write = yield* router
      .comment({ issue: spec.key, text: "Still here?" }, agent)
      .pipe(Effect.flip);
    assert.equal(write.code, "unavailable");

    setHubUp(true);
    assert.isUndefined((yield* router.listIssues({})).stale);
  }).pipe(Effect.scoped),
);

it.effect("follows a backlog that moved from this machine to the hub", () =>
  Effect.gen(function* () {
    const { router, local, hub } = yield* fleet("up");
    const backlog = yield* local.ensureProjectBacklog(corkAndNote);
    yield* local.createIssue({ backlogId: backlog.id, title: "Paywall", status: "ready" }, hubUser);
    const exported = yield* local.exportBacklog({
      backlogId: backlog.id,
      to: { environmentId: EnvironmentId.make("environment-geekom"), label: "Geekom" },
    });
    yield* hub.importBacklog(exported);

    const claimed = yield* router.claim("CN-1", agent);
    assert.equal(claimed.issue.status, "in_progress");
    assert.equal(
      (yield* hub.getIssue({ issueId: claimed.issue.id })).issue.claim?.actor.label,
      agent.label,
    );
    const next = yield* router.createIssue({ projectId: corkAndNote, title: "Receipts" }, agent);
    assert.equal(next.key, "CN-2");
    assert.equal((yield* hub.getIssue({ issueId: next.id })).issue.key, "CN-2");
  }).pipe(Effect.scoped),
);

it.effect("names where a backlog went when it moved somewhere this machine cannot follow", () =>
  Effect.gen(function* () {
    const { router, local } = yield* fleet("not_linked");
    const backlog = yield* local.ensureProjectBacklog(corkAndNote);
    yield* local.createIssue({ backlogId: backlog.id, title: "Paywall" }, hubUser);
    yield* local.exportBacklog({
      backlogId: backlog.id,
      to: { environmentId: EnvironmentId.make("environment-ex"), label: "EX" },
    });
    const read = yield* router.getIssue("CN-1").pipe(Effect.flip);
    assert.equal(read.code, "conflict");
    assert.include(read.message, "moved to EX");
    const write = yield* router
      .createIssue({ projectId: corkAndNote, title: "More" }, agent)
      .pipe(Effect.flip);
    assert.include(write.message, "moved to EX");
  }).pipe(Effect.scoped),
);

it.effect("refuses a key both machines use, and says which machine answered", () =>
  Effect.gen(function* () {
    const { router, local, hub } = yield* fleet("up");
    const here = yield* local.createIssue(
      { projectId: scratch, title: "Here", status: "ready" },
      hubUser,
    );
    const there = yield* hub.createIssue(
      {
        repository: { key: "github.com/someone/scratch", title: "Scratch" },
        title: "There",
        status: "ready",
      },
      hubUser,
    );
    assert.deepEqual([here.key, there.key], ["SCRATC-1", "SCRATC-1"]);

    const ambiguous = yield* router.getIssue("scratc-1").pipe(Effect.flip);
    assert.equal(ambiguous.code, "invalid");
    assert.include(ambiguous.message, here.id);
    assert.include(ambiguous.message, there.id);
    assert.include(ambiguous.message, "Geekom");
    assert.equal(
      (yield* router.listIssues({ backlog: "SCRATC" }).pipe(Effect.flip)).code,
      "invalid",
    );

    const read = yield* router.getIssue(there.id);
    assert.deepEqual([read.host, read.machine], ["hub", "Geekom"]);
    const claimed = yield* router.claim(here.id, agent);
    assert.deepEqual([claimed.host, claimed.machine], ["local", "this machine"]);
  }).pipe(Effect.scoped),
);

it.effect("keeps one Inbox for the fleet: a linked machine has none and INBOX is the hub's", () =>
  Effect.gen(function* () {
    const { router, local, hub } = yield* fleet("up");
    assert.lengthOf(yield* local.listBacklogs(), 0);
    const first = yield* router.createIssue({ title: "Voice capture" }, agent);
    const second = yield* router.createIssue({ backlog: "inbox", title: "Widgets" }, agent);
    assert.deepEqual([first.key, second.key], ["INBOX-1", "INBOX-2"]);
    assert.lengthOf(yield* local.listBacklogs(), 0);
    assert.equal((yield* hub.getIssue({ issueId: second.id })).issue.title, "Widgets");

    // An Inbox from before the link is legacy: INBOX-n still means the hub's.
    const legacy = yield* local.createIssue({ title: "Old idea", status: "ready" }, hubUser);
    assert.equal(legacy.key, "INBOX-1");
    const resolved = yield* router.getIssue("INBOX-1");
    assert.deepEqual([resolved.issue.id, resolved.host], [first.id, "hub"]);
    assert.equal((yield* router.listIssues({ backlog: "INBOX" })).issues.length, 2);
    // Its issues stay reachable by id, but leave listings and claim-next.
    assert.equal((yield* router.getIssue(legacy.id)).host, "local");
    assert.deepEqual(
      (yield* router.listIssues({})).issues.map((issue) => issue.id),
      [first.id, second.id],
    );
    assert.deepEqual(
      (yield* router.listBacklogs()).backlogs.map((backlog) => [backlog.key, backlog.host]),
      [["INBOX", "hub"]],
    );
    assert.isNull(yield* router.claimNext({}, agent));

    const snapshot = yield* router.subscribe().pipe(Stream.take(1), Stream.runCollect);
    const [event] = Array.from(snapshot);
    assert.deepEqual(event?.type === "snapshot" ? event.linkedHub : undefined, geekom);
  }).pipe(Effect.scoped),
);

it.effect("gives an unlinked machine its own Inbox at startup", () =>
  Effect.gen(function* () {
    const { router, local } = yield* fleet("not_linked");
    assert.deepEqual(
      (yield* local.listBacklogs()).map((backlog) => backlog.key),
      ["INBOX"],
    );
    const snapshot = yield* router.subscribe().pipe(Stream.take(1), Stream.runCollect);
    const [event] = Array.from(snapshot);
    assert.isNull(event?.type === "snapshot" ? event.linkedHub : undefined);
    const moved = yield* router.moveInboxToHub(hubUser).pipe(Effect.flip);
    assert.equal(moved.code, "invalid");
  }).pipe(Effect.scoped),
);

it.effect("moves a legacy Inbox's open issues to the hub's Inbox and closes them here", () =>
  Effect.gen(function* () {
    const { router, local, hub } = yield* fleet("up");
    yield* hub.createIssue({ title: "Already there" }, hubUser);
    const spec = yield* local.createIssue(
      { title: "Spec", body: "The plan", type: "feature", priority: "p1" },
      hubUser,
    );
    const child = yield* local.createIssue({ title: "Part", parentId: spec.id }, hubUser);
    const done = yield* local.createIssue({ title: "Shipped", status: "done" }, hubUser);
    const held = yield* local.createIssue({ title: "Busy", status: "ready" }, hubUser);
    yield* local.claim({ issueId: held.id }, agent);

    const result = yield* router.moveInboxToHub(hubUser);
    assert.deepEqual(result, {
      hub: "Geekom",
      moved: [
        { from: spec.key, to: "INBOX-2" },
        { from: child.key, to: "INBOX-3" },
      ],
      skipped: [held.key],
    });

    const movedSpec = yield* router.getIssue("INBOX-2");
    assert.deepEqual(
      [movedSpec.body, movedSpec.issue.type, movedSpec.issue.priority, movedSpec.issue.status],
      ["The plan", "feature", "p1", "inbox"],
    );
    assert.equal((yield* router.getIssue("INBOX-3")).issue.parentId, movedSpec.issue.id);

    const left = yield* local.getIssue({ issueId: spec.id });
    assert.equal(left.issue.status, "wontfix");
    assert.equal(left.activity.at(-1)?.text, "Moved to Geekom Inbox as INBOX-2.");
    assert.equal((yield* local.getIssue({ issueId: done.id })).issue.status, "done");
    assert.equal((yield* local.getIssue({ issueId: held.id })).issue.status, "in_progress");

    // Running it again moves nothing twice.
    const again = yield* router.moveInboxToHub(hubUser);
    assert.deepEqual([again.moved, again.skipped], [[], [held.key]]);
    assert.lengthOf(yield* hub.listIssues(), 3);
  }).pipe(Effect.scoped),
);
