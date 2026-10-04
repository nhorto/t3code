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

import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import * as ProjectService from "../project/ProjectService.ts";
import { localBacklogHome, type BacklogHome } from "./BacklogHome.ts";
import * as BacklogHubClient from "./BacklogHubClient.ts";
import { BacklogRouter, layer as routerLayer } from "./BacklogRouter.ts";
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

const backlogService = (projects: typeof spokeProjects) =>
  serviceLayer.pipe(
    Layer.provide(
      Layer.mergeAll(
        NodeCrypto.layer,
        Layer.mock(ProjectService.ProjectService)({
          getShell: (projectId) => Effect.succeed(projectShell(projects, projectId)),
          listShells: () =>
            Effect.succeed(
              Object.keys(projects).flatMap((id) =>
                Option.toArray(projectShell(projects, ProjectId.make(id))),
              ),
            ),
        }),
        Layer.mock(ThreadManagementService.ThreadManagementService)({
          getThreadShell: () => Effect.succeed(null),
        }),
      ),
    ),
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
 * service, which is exactly what the hub's RPC handlers call.
 */
const fleet = (hubState: "up" | "down" | "not_linked") =>
  Effect.gen(function* () {
    const hub = Context.get(yield* Layer.build(backlogService({})), BacklogService);
    const spokeContext = yield* Layer.build(
      routerLayer.pipe(
        Layer.provideMerge(backlogService(spokeProjects)),
        Layer.provideMerge(
          Layer.mock(ProjectService.ProjectService)({
            getShell: (projectId) => Effect.succeed(projectShell(spokeProjects, projectId)),
          }),
        ),
        Layer.provide(
          Layer.mock(BacklogHubClient.BacklogHubClient)({
            linkedHub: Effect.succeed(
              hubState === "not_linked"
                ? Option.none()
                : Option.some({
                    environmentId: EnvironmentId.make("environment-geekom"),
                    label: "Geekom",
                  }),
            ),
            home: hubState === "down" ? unreachable : localBacklogHome(hub),
          }),
        ),
      ),
    );
    return {
      router: Context.get(spokeContext, BacklogRouter),
      local: Context.get(spokeContext, BacklogService),
      hub,
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
    yield* up.local.createIssue({ title: "Here" }, hubUser);
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
    yield* down.local.createIssue({ title: "Here" }, hubUser);
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
      [1, 1],
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
