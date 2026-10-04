import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { assert, it } from "@effect/vitest";
import {
  EnvironmentId,
  ProjectId,
  ThreadId,
  type BacklogActor,
  type BacklogStreamEvent,
  type OrchestrationProjectShell,
  type OrchestrationV2ThreadShell,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import * as ProjectService from "../project/ProjectService.ts";
import { BacklogService, layer } from "./BacklogService.ts";

const environmentId = EnvironmentId.make("environment-a");
const user: BacklogActor = { kind: "user", environmentId, threadId: null, label: "You" };
const agent = (name: string): BacklogActor => ({
  kind: "agent",
  environmentId,
  threadId: ThreadId.make(`thread-${name}`),
  label: `Agent ${name}`,
});

const corkAndNote = ProjectId.make("project-cork");
const coolNotes = ProjectId.make("project-cool");
const corkAndNoteClone = ProjectId.make("project-cork-clone");
const projects: Record<string, { title: string; canonicalKey?: string }> = {
  [corkAndNote]: { title: "Cork & Note", canonicalKey: "github.com/nhorto/cork-and-note" },
  [coolNotes]: { title: "Cool Notes" },
  [corkAndNoteClone]: { title: "Cork and Note", canonicalKey: "github.com/nhorto/cork-and-note" },
};

/** Threads whose run is still active, so the lease keeper renews their claims. */
const runningThreads = new Set<string>([agent("live").threadId!]);

const testLayer = layer.pipe(
  Layer.provide(
    Layer.mergeAll(
      NodeCrypto.layer,
      Layer.mock(ProjectService.ProjectService)({
        getShell: (projectId) => {
          const project = projects[projectId];
          return Effect.succeed(
            project === undefined
              ? Option.none()
              : Option.some({
                  id: projectId,
                  title: project.title,
                  repositoryIdentity:
                    project.canonicalKey === undefined
                      ? null
                      : { canonicalKey: project.canonicalKey },
                } as unknown as OrchestrationProjectShell),
          );
        },
      }),
      Layer.mock(ThreadManagementService.ThreadManagementService)({
        getThreadShell: (threadId) =>
          Effect.succeed(
            runningThreads.has(threadId)
              ? ({
                  id: threadId,
                  activeRunId: "run-1",
                  archivedAt: null,
                  deletedAt: null,
                } as unknown as OrchestrationV2ThreadShell)
              : null,
          ),
      }),
    ),
  ),
);

const run = <A, E>(effect: Effect.Effect<A, E, BacklogService>) =>
  effect.pipe(Effect.provide(testLayer.pipe(Layer.provide(SqlitePersistenceMemory))));

it.effect("captures an untargeted idea in the Inbox and preserves omitted fields on update", () =>
  run(
    Effect.gen(function* () {
      const backlog = yield* BacklogService;
      const created = yield* backlog.createIssue(
        { title: "Voice capture", body: "Dictate from the phone." },
        user,
      );
      assert.equal(created.key, "INBOX-1");
      assert.equal(created.status, "inbox");
      assert.equal(created.type, "idea");
      assert.isTrue(created.hasBody);

      const [inbox] = yield* backlog.listBacklogs();
      assert.equal(inbox?.kind, "inbox");
      assert.equal(inbox?.title, "Inbox");
      assert.isNull(inbox?.repositoryKey);

      const updated = yield* backlog.updateIssue(
        { issueId: created.id, title: "Voice capture on iOS", priority: "p1" },
        user,
      );
      assert.equal(updated.title, "Voice capture on iOS");
      assert.equal(updated.priority, "p1");
      const detail = yield* backlog.getIssue({ issueId: created.id });
      assert.equal(detail.body, "Dictate from the phone.");
      assert.deepEqual(
        detail.activity.map((entry) => [entry.kind, entry.text]),
        [
          ["created", null],
          ["edited", "Edited title, priority"],
        ],
      );
      assert.deepEqual(
        (yield* backlog.listIssues()).map((issue) => issue.key),
        ["INBOX-1"],
      );
    }),
  ),
);

it.effect(
  "creates a project backlog on first use, keyed from the title and one per repository",
  () =>
    run(
      Effect.gen(function* () {
        const backlog = yield* BacklogService;
        const bug = yield* backlog.createIssue(
          { projectId: corkAndNote, title: "Paywall crashes on iPad", type: "bug" },
          agent("a"),
        );
        assert.equal(bug.key, "CN-1");
        assert.equal(bug.status, "backlog");
        assert.equal(bug.createdBy.label, "Agent a");

        const other = yield* backlog.createIssue({ projectId: coolNotes, title: "Tags" }, user);
        assert.equal(other.key, "CN2-1");

        const sameRepository = yield* backlog.createIssue(
          { projectId: corkAndNoteClone, title: "Dark mode" },
          user,
        );
        assert.equal(sameRepository.key, "CN-2");

        const backlogs = yield* backlog.listBacklogs();
        assert.deepEqual(
          backlogs.map((entry) => [entry.key, entry.title, entry.repositoryKey]),
          [
            ["INBOX", "Inbox", null],
            ["CN", "Cork & Note", "github.com/nhorto/cork-and-note"],
            ["CN2", "Cool Notes", null],
          ],
        );
        const missing = yield* backlog
          .createIssue({ projectId: ProjectId.make("project-missing"), title: "Nope" }, user)
          .pipe(Effect.flip);
        assert.equal(missing.code, "not_found");
      }),
    ),
);

it.effect("records status changes and comments in the issue history", () =>
  run(
    Effect.gen(function* () {
      const backlog = yield* BacklogService;
      const issue = yield* backlog.createIssue({ title: "Sync settings" }, user);
      yield* backlog.updateIssue({ issueId: issue.id, status: "ready" }, user);
      const comment = yield* backlog.comment(
        { issueId: issue.id, text: "Ricky wants this first." },
        agent("a"),
      );
      assert.equal(comment.actor.label, "Agent a");

      const { activity } = yield* backlog.getIssue({ issueId: issue.id });
      assert.deepEqual(
        activity.map((entry) => [entry.kind, entry.fromStatus, entry.toStatus, entry.text]),
        [
          ["created", null, "inbox", null],
          ["status_changed", "inbox", "ready", null],
          ["commented", null, null, "Ricky wants this first."],
        ],
      );
    }),
  ),
);

it.effect("keeps a parent open until its children close, and reopening clears closedAt", () =>
  run(
    Effect.gen(function* () {
      const backlog = yield* BacklogService;
      const spec = yield* backlog.createIssue(
        { projectId: corkAndNote, title: "Onboarding", body: "The spec.", status: "ready" },
        user,
      );
      const [first, second] = yield* backlog.createChildren(
        {
          parentId: spec.id,
          children: [
            { title: "Welcome screen", status: "ready" },
            { title: "Permissions", status: "ready", blockedBySiblings: [0] },
          ],
        },
        agent("orchestrator"),
      );
      assert.equal(first?.key, "CN-2");
      assert.equal(first?.parentId, spec.id);
      assert.deepEqual(second?.blockedBy, [first!.id]);

      const blocked = yield* backlog
        .updateIssue({ issueId: spec.id, status: "done" }, user)
        .pipe(Effect.flip);
      assert.equal(blocked.code, "conflict");

      const claimed = yield* backlog.claim({ issueId: first!.id }, agent("a"));
      assert.equal(claimed.parent?.body, "The spec.");
      yield* backlog.release({ issueId: first!.id, status: "done" }, agent("a"));
      yield* backlog.updateIssue({ issueId: second!.id, status: "wontfix" }, user);

      const done = yield* backlog.updateIssue({ issueId: spec.id, status: "done" }, user);
      assert.isNotNull(done.closedAt);
      const reopened = yield* backlog.updateIssue({ issueId: spec.id, status: "ready" }, user);
      assert.equal(reopened.status, "ready");
      assert.isNull(reopened.closedAt);
    }),
  ),
);

it.effect("puts an issue on the frontier only once its blockers close", () =>
  run(
    Effect.gen(function* () {
      const backlog = yield* BacklogService;
      const schema = yield* backlog.createIssue({ title: "Schema", status: "ready" }, user);
      const api = yield* backlog.createIssue(
        { title: "API", status: "ready", blockedBy: [schema.id] },
        user,
      );
      const frontier = () =>
        backlog
          .listIssues({ frontierOnly: true })
          .pipe(Effect.map((issues) => issues.map((issue) => issue.title)));

      assert.deepEqual(yield* frontier(), ["Schema"]);
      const refused = yield* backlog.claim({ issueId: api.id }, agent("a")).pipe(Effect.flip);
      assert.equal(refused.code, "conflict");

      yield* backlog.updateIssue({ issueId: schema.id, status: "done" }, user);
      assert.deepEqual(yield* frontier(), ["API"]);
    }),
  ),
);

it.effect("rejects self-blocks, blocker cycles, and parent cycles", () =>
  run(
    Effect.gen(function* () {
      const backlog = yield* BacklogService;
      const a = yield* backlog.createIssue({ title: "A" }, user);
      const b = yield* backlog.createIssue({ title: "B", blockedBy: [a.id] }, user);
      const c = yield* backlog.createIssue({ title: "C", blockedBy: [b.id] }, user);

      const self = yield* backlog
        .updateIssue({ issueId: a.id, blockedBy: [a.id] }, user)
        .pipe(Effect.flip);
      assert.equal(self.code, "invalid");
      const cycle = yield* backlog
        .updateIssue({ issueId: a.id, blockedBy: [c.id] }, user)
        .pipe(Effect.flip);
      assert.equal(cycle.code, "invalid");
      assert.deepEqual((yield* backlog.getIssue({ issueId: a.id })).issue.blockedBy, []);

      yield* backlog.updateIssue({ issueId: b.id, parentId: a.id }, user);
      const parentCycle = yield* backlog
        .updateIssue({ issueId: a.id, parentId: b.id }, user)
        .pipe(Effect.flip);
      assert.equal(parentCycle.code, "invalid");
    }),
  ),
);

it.effect("gives exactly one of two racing claimants the issue; the winner may re-claim", () =>
  run(
    Effect.gen(function* () {
      const backlog = yield* BacklogService;
      const issue = yield* backlog.createIssue({ title: "Race", status: "ready" }, user);
      const results = yield* Effect.all(
        [
          Effect.result(backlog.claim({ issueId: issue.id }, agent("a"))),
          Effect.result(backlog.claim({ issueId: issue.id }, agent("b"))),
        ],
        { concurrency: "unbounded" },
      );
      const winners = results.filter((result) => result._tag === "Success");
      const losers = results.flatMap((result) =>
        result._tag === "Failure" ? [result.failure] : [],
      );
      assert.equal(winners.length, 1);
      assert.equal(losers[0]?.code, "conflict");

      const detail = yield* backlog.getIssue({ issueId: issue.id });
      assert.equal(detail.issue.status, "in_progress");
      const holder = detail.issue.claim!.actor;
      assert.deepEqual(detail.issue.links, [
        { type: "thread", environmentId, threadId: holder.threadId! },
      ]);

      const retried = yield* backlog.claim({ issueId: issue.id }, holder);
      assert.equal(retried.issue.claim?.actor.threadId, holder.threadId);
      assert.equal(retried.activity.filter((entry) => entry.kind === "claimed").length, 1);
    }),
  ),
);

it.effect("claims next by priority, then age, skipping blocked and claimed issues", () =>
  run(
    Effect.gen(function* () {
      const backlog = yield* BacklogService;
      const gate = yield* backlog.createIssue({ title: "Gate" }, user);
      yield* backlog.createIssue({ title: "Unprioritized", status: "ready" }, user);
      yield* TestClock.adjust("1 second");
      yield* backlog.createIssue({ title: "Low", status: "ready", priority: "p2" }, user);
      yield* backlog.createIssue(
        { title: "Urgent but blocked", status: "ready", priority: "p0", blockedBy: [gate.id] },
        user,
      );
      yield* TestClock.adjust("1 second");
      yield* backlog.createIssue({ title: "Older p1", status: "ready", priority: "p1" }, user);
      yield* TestClock.adjust("1 second");
      yield* backlog.createIssue({ title: "Newer p1", status: "ready", priority: "p1" }, user);

      const order: Array<string | null> = [];
      for (let attempt = 0; attempt < 5; attempt++) {
        const next = yield* backlog.claimNext({}, agent("a"));
        order.push(next?.issue.title ?? null);
      }
      assert.deepEqual(order, ["Older p1", "Newer p1", "Low", "Unprioritized", null]);
    }),
  ),
);

it.effect("returns an issue to ready when its holder's lease expires, renewing live holders", () =>
  run(
    Effect.gen(function* () {
      const backlog = yield* BacklogService;
      const abandoned = yield* backlog.createIssue({ title: "Abandoned", status: "ready" }, user);
      const active = yield* backlog.createIssue({ title: "Active", status: "ready" }, user);
      yield* backlog.claim({ issueId: abandoned.id }, agent("dead"));
      yield* backlog.claim({ issueId: active.id }, agent("live"));

      const subscribed = yield* Deferred.make<void>();
      const expiry = yield* backlog.subscribe().pipe(
        Stream.tap((event) =>
          event.type === "snapshot" ? Deferred.succeed(subscribed, undefined) : Effect.void,
        ),
        Stream.filter(
          (event) =>
            event.type === "issueUpserted" &&
            event.issue.id === abandoned.id &&
            event.issue.status === "ready",
        ),
        Stream.runHead,
        Effect.forkChild,
      );
      yield* Deferred.await(subscribed);
      yield* TestClock.adjust("16 minutes");
      yield* Fiber.join(expiry);

      const expired = yield* backlog.getIssue({ issueId: abandoned.id });
      assert.equal(expired.issue.status, "ready");
      assert.isNull(expired.issue.claim);
      assert.equal(expired.activity.at(-1)?.kind, "lease_expired");

      const renewed = yield* backlog.getIssue({ issueId: active.id });
      assert.equal(renewed.issue.status, "in_progress");
      assert.equal(renewed.issue.claim?.actor.label, "Agent live");
    }),
  ),
);

it.effect("lets only the holder release, while a user can force-release or move the issue", () =>
  run(
    Effect.gen(function* () {
      const backlog = yield* BacklogService;
      const issue = yield* backlog.createIssue({ title: "Work", status: "ready" }, user);
      yield* backlog.claim({ issueId: issue.id }, agent("a"));

      const stranger = yield* backlog
        .release({ issueId: issue.id, status: "ready" }, agent("b"))
        .pipe(Effect.flip);
      assert.equal(stranger.code, "conflict");
      const strangerMove = yield* backlog
        .updateIssue({ issueId: issue.id, status: "review" }, agent("b"))
        .pipe(Effect.flip);
      assert.equal(strangerMove.code, "conflict");

      const released = yield* backlog.release(
        { issueId: issue.id, status: "review", note: "PR is up." },
        agent("a"),
      );
      assert.equal(released.status, "review");
      assert.isNull(released.claim);

      yield* backlog.updateIssue({ issueId: issue.id, status: "ready" }, user);
      yield* backlog.claim({ issueId: issue.id }, agent("b"));
      const forced = yield* backlog.release({ issueId: issue.id, status: "ready" }, user);
      assert.isNull(forced.claim);

      yield* backlog.claim({ issueId: issue.id }, agent("c"));
      const moved = yield* backlog.updateIssue({ issueId: issue.id, status: "backlog" }, user);
      assert.equal(moved.status, "backlog");
      assert.isNull(moved.claim);

      const { activity } = yield* backlog.getIssue({ issueId: issue.id });
      assert.deepEqual(
        activity.filter((entry) => entry.kind === "released").map((entry) => entry.text),
        [
          "PR is up.",
          "Force-released the claim held by Agent b",
          "Released the claim held by Agent c",
        ],
      );
    }),
  ),
);

it.effect("renumbers an issue triaged from the Inbox into a project backlog", () =>
  run(
    Effect.gen(function* () {
      const backlog = yield* BacklogService;
      yield* backlog.createIssue({ projectId: corkAndNote, title: "Existing" }, user);
      const idea = yield* backlog.createIssue({ title: "Wine pairing quiz" }, user);
      const project = yield* backlog.resolveBacklogRef("cn");

      const triaged = yield* backlog.updateIssue({ issueId: idea.id, backlogId: project.id }, user);
      assert.equal(triaged.id, idea.id);
      assert.equal(triaged.key, "CN-2");
      assert.equal(triaged.status, "backlog");
      const { activity } = yield* backlog.getIssue({ issueId: idea.id });
      assert.equal(
        activity.find((entry) => entry.kind === "moved")?.text,
        "Moved from INBOX-1 to CN-2",
      );

      // Triage by project resolves the project's backlog, creating it on first use.
      const other = yield* backlog.createIssue({ title: "Shared tags" }, user);
      const byProject = yield* backlog.updateIssue(
        { issueId: other.id, projectId: coolNotes },
        user,
      );
      assert.equal(byProject.key, "CN2-1");
      assert.equal(byProject.status, "backlog");
      // The same repository shares one board, whichever project names it.
      const shared = yield* backlog.createIssue({ title: "Cellar view" }, user);
      const viaClone = yield* backlog.updateIssue(
        { issueId: shared.id, projectId: corkAndNoteClone },
        user,
      );
      assert.equal(viaClone.key, "CN-3");
    }),
  ),
);

it.effect("re-keys a backlog's issues when its key is edited", () =>
  run(
    Effect.gen(function* () {
      const backlog = yield* BacklogService;
      const issue = yield* backlog.createIssue({ projectId: corkAndNote, title: "Labels" }, user);
      const project = yield* backlog.resolveBacklogRef("CN");

      const taken = yield* backlog
        .updateBacklog({ backlogId: project.id, key: "INBOX" }, user)
        .pipe(Effect.flip);
      assert.equal(taken.code, "conflict");

      const renamed = yield* backlog.updateBacklog({ backlogId: project.id, key: "WINE" }, user);
      assert.equal(renamed.key, "WINE");
      assert.equal((yield* backlog.getIssue({ issueId: issue.id })).issue.key, "WINE-1");
      assert.equal(yield* backlog.resolveIssueRef("wine-1"), issue.id);
      assert.equal(yield* backlog.resolveIssueRef(issue.id), issue.id);
      assert.equal((yield* backlog.resolveIssueRef("CN-1").pipe(Effect.flip)).code, "not_found");
    }),
  ),
);

it.effect("streams a snapshot, then a delta for every changed row", () =>
  run(
    Effect.gen(function* () {
      const backlog = yield* BacklogService;
      const first = yield* backlog.createIssue({ projectId: corkAndNote, title: "First" }, user);
      const subscribed = yield* Deferred.make<void>();
      const collected = yield* backlog.subscribe().pipe(
        Stream.tap((event) =>
          event.type === "snapshot" ? Deferred.succeed(subscribed, undefined) : Effect.void,
        ),
        Stream.take(4),
        Stream.runCollect,
        Effect.forkChild,
      );
      yield* Deferred.await(subscribed);
      const second = yield* backlog.createIssue({ title: "Second" }, user);
      const project = yield* backlog.resolveBacklogRef("CN");
      yield* backlog.updateBacklog({ backlogId: project.id, key: "WINE" }, user);

      const describe = (event: BacklogStreamEvent) =>
        event.type === "snapshot"
          ? `snapshot ${event.backlogs.length} backlogs, ${event.issues.map((issue) => issue.key).join(",")}`
          : event.type === "backlogUpserted"
            ? `backlog ${event.backlog.key}`
            : `issue ${event.issue.key}`;
      const events = Array.from(yield* Fiber.join(collected), describe);
      assert.deepEqual(events, [
        "snapshot 2 backlogs, CN-1",
        `issue ${second.key}`,
        "backlog WINE",
        "issue WINE-1",
      ]);
      assert.equal(first.key, "CN-1");
    }),
  ),
);
