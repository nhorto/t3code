import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { assert, it } from "@effect/vitest";
import {
  EnvironmentId,
  ProjectId,
  ThreadId,
  type BacklogActor,
  type BacklogError,
  type BacklogStreamEvent,
  type OrchestrationProjectShell,
  type OrchestrationV2ThreadShell,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Scope from "effect/Scope";
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
const inboxNamed = ProjectId.make("project-inbox");
const projects: Record<string, { title: string; canonicalKey?: string }> = {
  [corkAndNote]: { title: "Cork & Note", canonicalKey: "github.com/nhorto/cork-and-note" },
  [coolNotes]: { title: "Cool Notes" },
  [corkAndNoteClone]: { title: "Cork and Note", canonicalKey: "github.com/nhorto/cork-and-note" },
  [inboxNamed]: { title: "Inbox" },
};

function projectShell(projectId: ProjectId) {
  const project = projects[projectId];
  return project === undefined
    ? Option.none()
    : Option.some({
        id: projectId,
        title: project.title,
        repositoryIdentity:
          project.canonicalKey === undefined ? null : { canonicalKey: project.canonicalKey },
      } as unknown as OrchestrationProjectShell);
}

/** Threads whose run is still active, so the lease keeper renews their claims. */
const runningThreads = new Set<string>([agent("live").threadId!]);
/** Threads with no run, each with when it was last active (the test clock starts at 0). */
const idleThreads = new Map<string, number>([[agent("asking").threadId!, 0]]);

const testLayer = layer.pipe(
  Layer.provide(
    Layer.mergeAll(
      NodeCrypto.layer,
      Layer.mock(ProjectService.ProjectService)({
        getShell: (projectId) => Effect.succeed(projectShell(projectId)),
        listShells: () =>
          Effect.succeed(
            Object.keys(projects).flatMap((id) => Option.toArray(projectShell(ProjectId.make(id)))),
          ),
      }),
      Layer.mock(ThreadManagementService.ThreadManagementService)({
        getThreadShell: (threadId) =>
          Effect.succeed(
            runningThreads.has(threadId) || idleThreads.has(threadId)
              ? ({
                  id: threadId,
                  activeRunId: runningThreads.has(threadId) ? "run-1" : null,
                  updatedAt: DateTime.makeUnsafe(idleThreads.get(threadId) ?? 0),
                  latestRunCompletedAt: null,
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

it.effect("creates the Inbox on first use and keeps its key for it", () =>
  run(
    Effect.gen(function* () {
      const backlog = yield* BacklogService;
      // Nothing creates an Inbox at startup: a machine linked to a hub uses the hub's.
      assert.lengthOf(yield* backlog.listBacklogs(), 0);
      const project = yield* backlog.createIssue({ projectId: inboxNamed, title: "Plan" }, user);
      assert.equal(project.key, "INBOX2-1");

      const idea = yield* backlog.createIssue({ title: "Idea" }, user);
      assert.equal(idea.key, "INBOX-1");
      const inbox = yield* backlog.ensureInbox();
      assert.equal(inbox.id, idea.backlogId);
      assert.deepEqual(
        (yield* backlog.listBacklogs()).map((entry) => [entry.kind, entry.key]),
        [
          ["inbox", "INBOX"],
          ["project", "INBOX2"],
        ],
      );
      assert.lengthOf(yield* backlog.listIssues({ excludeInbox: true }), 1);
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

      yield* backlog.updateIssue({ issueId: c.id, parentId: a.id }, user);
      const parentCycle = yield* backlog
        .updateIssue({ issueId: a.id, parentId: c.id }, user)
        .pipe(Effect.flip);
      assert.equal(parentCycle.code, "invalid");
    }),
  ),
);

it.effect("never lets a child wait on its own ancestor, or stay open under a closed parent", () =>
  run(
    Effect.gen(function* () {
      const backlog = yield* BacklogService;
      const spec = yield* backlog.createIssue({ title: "Spec" }, user);
      const slice = yield* backlog.createIssue({ title: "Slice", parentId: spec.id }, user);
      const step = yield* backlog.createIssue({ title: "Step", parentId: slice.id }, user);

      // Blocked by a parent or grandparent, a child could never be worked.
      for (const blocker of [slice.id, spec.id]) {
        const error = yield* backlog
          .updateIssue({ issueId: step.id, blockedBy: [blocker] }, user)
          .pipe(Effect.flip);
        assert.equal(error.code, "invalid");
      }
      const blockedAtBirth = yield* backlog
        .createIssue({ title: "Late", parentId: spec.id, blockedBy: [spec.id] }, user)
        .pipe(Effect.flip);
      assert.equal(blockedAtBirth.code, "invalid");
      // Attaching under an issue that already blocks it is the same deadlock.
      const loose = yield* backlog.createIssue({ title: "Loose", blockedBy: [spec.id] }, user);
      const attach = yield* backlog
        .updateIssue({ issueId: loose.id, parentId: spec.id }, user)
        .pipe(Effect.flip);
      assert.equal(attach.code, "invalid");

      yield* backlog.updateIssue({ issueId: step.id, status: "done" }, user);
      yield* backlog.updateIssue({ issueId: slice.id, status: "done" }, user);
      yield* backlog.updateIssue({ issueId: spec.id, status: "done" }, user);

      const openChild = yield* backlog
        .createIssue({ title: "Afterthought", parentId: spec.id }, user)
        .pipe(Effect.flip);
      assert.equal(openChild.code, "conflict");
      const attachOpen = yield* backlog
        .updateIssue({ issueId: loose.id, blockedBy: [], parentId: spec.id }, user)
        .pipe(Effect.flip);
      assert.equal(attachOpen.code, "conflict");
      // Reopening a child does not quietly reopen its parent: reopen the parent first.
      const reopen = yield* backlog
        .updateIssue({ issueId: slice.id, status: "ready" }, user)
        .pipe(Effect.flip);
      assert.equal(reopen.code, "conflict");
      assert.include(reopen.message, "Reopen it");
      yield* backlog.updateIssue({ issueId: spec.id, status: "in_progress" }, user);
      const reopened = yield* backlog.updateIssue({ issueId: slice.id, status: "ready" }, user);
      assert.equal(reopened.status, "ready");
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

it.effect("expires a gone holder's claim, but keeps one whose thread runs or recently ran", () =>
  run(
    Effect.gen(function* () {
      const backlog = yield* BacklogService;
      const abandoned = yield* backlog.createIssue({ title: "Abandoned", status: "ready" }, user);
      const active = yield* backlog.createIssue({ title: "Active", status: "ready" }, user);
      const waiting = yield* backlog.createIssue({ title: "Waiting", status: "ready" }, user);
      yield* backlog.claim({ issueId: abandoned.id }, agent("dead"));
      yield* backlog.claim({ issueId: active.id }, agent("live"));
      // Ended its turn with a question for the user at t=0.
      yield* backlog.claim({ issueId: waiting.id }, agent("asking"));

      const subscribed = yield* Deferred.make<void>();
      const readyAgain = (issueId: string) =>
        backlog.subscribe().pipe(
          Stream.tap((event) =>
            event.type === "snapshot" ? Deferred.succeed(subscribed, undefined) : Effect.void,
          ),
          Stream.filter((event) => event.type !== "snapshot"),
          Stream.takeUntil(
            (event) =>
              event.type === "issueUpserted" &&
              event.issue.id === issueId &&
              event.issue.status === "ready",
          ),
          Stream.runCollect,
          Effect.forkChild,
        );
      const expiry = yield* readyAgain(abandoned.id);
      yield* Deferred.await(subscribed);
      yield* TestClock.adjust("16 minutes");
      const deltas = yield* Fiber.join(expiry);
      // Renewing a lease is not a visible change, so it sends no delta.
      assert.isFalse(
        deltas.some((event) => event.type === "issueUpserted" && event.issue.id !== abandoned.id),
      );

      const expired = yield* backlog.getIssue({ issueId: abandoned.id });
      assert.equal(expired.issue.status, "ready");
      assert.isNull(expired.issue.claim);
      assert.equal(expired.activity.at(-1)?.kind, "lease_expired");
      for (const kept of [active.id, waiting.id]) {
        const detail = yield* backlog.getIssue({ issueId: kept });
        assert.equal(detail.issue.status, "in_progress");
      }

      // Two hours after its last activity the waiting thread lets go too.
      const lapsed = yield* readyAgain(waiting.id);
      yield* TestClock.adjust("2 hours");
      yield* Fiber.join(lapsed);
      assert.isNull((yield* backlog.getIssue({ issueId: waiting.id })).issue.claim);
      assert.equal((yield* backlog.getIssue({ issueId: active.id })).issue.status, "in_progress");
    }),
  ),
);

it.effect("keeps a claim made through a linked server until that server stops renewing it", () =>
  run(
    Effect.gen(function* () {
      const backlog = yield* BacklogService;
      const remote: BacklogActor = {
        kind: "agent",
        environmentId: EnvironmentId.make("environment-spoke"),
        threadId: ThreadId.make("thread-on-the-spoke"),
        label: "Spoke agent",
      };
      const issue = yield* backlog.createIssue({ title: "Remote work", status: "ready" }, user);
      const claimed = yield* backlog.claim({ issueId: issue.id }, remote);
      assert.isFalse(claimed.alreadyHeld);
      assert.deepEqual(claimed.issue.links, [
        { type: "thread", environmentId: remote.environmentId, threadId: remote.threadId! },
      ]);
      // The same thread id on this machine is a different holder.
      const lookalike = yield* backlog
        .claim({ issueId: issue.id }, { ...remote, environmentId, label: "Local twin" })
        .pipe(Effect.flip);
      assert.equal(lookalike.code, "conflict");
      assert.isTrue((yield* backlog.claim({ issueId: issue.id }, remote)).alreadyHeld);

      // The spoke renews every few minutes; the hub's keeper cannot see its thread.
      for (let minute = 0; minute < 30; minute += 5) {
        yield* backlog.renewClaims({
          environmentId: remote.environmentId,
          threadIds: [remote.threadId!],
        });
        yield* TestClock.adjust("5 minutes");
      }
      assert.equal((yield* backlog.getIssue({ issueId: issue.id })).issue.status, "in_progress");

      const subscribed = yield* Deferred.make<void>();
      const expiry = yield* backlog.subscribe().pipe(
        Stream.tap((event) =>
          event.type === "snapshot" ? Deferred.succeed(subscribed, undefined) : Effect.void,
        ),
        Stream.filter((event) => event.type === "issueUpserted" && event.issue.status === "ready"),
        Stream.runHead,
        Effect.forkChild,
      );
      yield* Deferred.await(subscribed);
      yield* TestClock.adjust("16 minutes");
      yield* Fiber.join(expiry);
      const lapsed = yield* backlog.getIssue({ issueId: issue.id });
      assert.isNull(lapsed.issue.claim);
      assert.equal(lapsed.issue.status, "ready");

      const again = yield* backlog.claim({ issueId: issue.id }, remote);
      const released = yield* backlog.release({ issueId: issue.id, status: "review" }, remote);
      assert.isFalse(again.alreadyHeld);
      assert.equal(released.status, "review");
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
        ["PR is up.", "Force-released the claim held by Agent b", "Released Agent c's claim"],
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
        Stream.take(5),
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
      // The Inbox is created by its first issue, and streams like any new backlog.
      assert.deepEqual(events, [
        "snapshot 1 backlogs, CN-1",
        "backlog INBOX",
        `issue ${second.key}`,
        "backlog WINE",
        "issue WINE-1",
      ]);
      assert.equal(first.key, "CN-1");
    }),
  ),
);

/** Two machines' backlog services, each with its own database. */
const twoMachines = Effect.gen(function* () {
  const start = () =>
    Layer.build(testLayer.pipe(Layer.provide(SqlitePersistenceMemory))).pipe(
      Effect.map((context) => Context.get(context, BacklogService)),
    );
  return { laptop: yield* start(), geekom: yield* start() };
});
const toGeekom = { environmentId: EnvironmentId.make("environment-geekom"), label: "Geekom" };

it.effect("moves a board to another machine with its ids, numbers, edges and history", () =>
  Effect.gen(function* () {
    const { laptop, geekom } = yield* twoMachines;
    const spec = yield* laptop.createIssue(
      { projectId: corkAndNote, title: "Spec", body: "The plan", status: "ready" },
      user,
    );
    const [first, second] = yield* laptop.createChildren(
      {
        parentId: spec.id,
        children: [{ title: "First" }, { title: "Second", blockedBySiblings: [0] }],
      },
      user,
    );
    yield* laptop.comment({ issueId: first!.id, text: "Started thinking" }, user);
    const before = yield* laptop.getIssue({ issueId: second!.id });

    const exported = yield* laptop.exportBacklog({ backlogId: spec.backlogId, to: toGeekom });
    const imported = yield* geekom.importBacklog(exported);
    assert.equal(imported.id, spec.backlogId);
    assert.equal(imported.key, "CN");
    assert.isUndefined(imported.movedTo);

    const after = yield* geekom.getIssue({ issueId: second!.id });
    assert.deepEqual(after.issue, before.issue);
    assert.deepEqual(after.activity, before.activity);
    assert.equal(after.parent?.body, "The plan");
    assert.deepEqual(
      (yield* geekom.getIssue({ issueId: first!.id })).activity.map((entry) => entry.text),
      [null, "Started thinking"],
    );
    // Numbering carries on where it left off.
    const next = yield* geekom.createIssue({ backlogId: imported.id, title: "Third" }, user);
    assert.equal(next.key, "CN-4");
  }).pipe(Effect.scoped),
);

it.effect("leaves a read-only redirect behind that names where the board went", () =>
  Effect.gen(function* () {
    const { laptop, geekom } = yield* twoMachines;
    const issue = yield* laptop.createIssue(
      { projectId: corkAndNote, title: "Paywall", status: "ready" },
      user,
    );
    yield* geekom.importBacklog(
      yield* laptop.exportBacklog({ backlogId: issue.backlogId, to: toGeekom }),
    );

    const [redirect] = yield* laptop.listBacklogs();
    assert.equal(redirect?.movedTo?.label, "Geekom");
    // Clients still read the old copy; agents and every change are turned away.
    assert.equal((yield* laptop.getIssue({ issueId: issue.id })).issue.title, "Paywall");
    const attempts: ReadonlyArray<Effect.Effect<void, BacklogError>> = [
      laptop.updateIssue({ issueId: issue.id, status: "done" }, user).pipe(Effect.asVoid),
      laptop.claim({ issueId: issue.id }, agent("worker")).pipe(Effect.asVoid),
      laptop.comment({ issueId: issue.id, text: "Hello?" }, user).pipe(Effect.asVoid),
      laptop.createIssue({ projectId: corkAndNote, title: "New" }, user).pipe(Effect.asVoid),
      laptop.resolveIssueRef("CN-1").pipe(Effect.asVoid),
    ];
    for (const attempt of attempts) {
      const error = yield* Effect.flip(attempt);
      assert.equal(error.code, "conflict");
      assert.equal(error.movedTo?.environmentId, toGeekom.environmentId);
      assert.include(error.message, "moved to Geekom");
    }
    assert.lengthOf(yield* laptop.listIssues({ frontierOnly: true }), 0);
    assert.isNull(yield* laptop.claimNext({}, agent("worker")));
  }).pipe(Effect.scoped),
);

it.effect("refuses to move a board while an issue is claimed, or onto a machine that has one", () =>
  Effect.gen(function* () {
    const { laptop, geekom } = yield* twoMachines;
    const issue = yield* laptop.createIssue(
      { projectId: corkAndNote, title: "Paywall", status: "ready" },
      user,
    );
    yield* laptop.claim({ issueId: issue.id }, agent("worker"));
    const claimed = yield* laptop
      .exportBacklog({ backlogId: issue.backlogId, to: toGeekom })
      .pipe(Effect.flip);
    assert.equal(claimed.code, "conflict");
    assert.include(claimed.message, "CN-1");
    assert.isUndefined((yield* laptop.resolveBacklogRef("CN")).movedTo);

    yield* laptop.release({ issueId: issue.id, status: "ready" }, user);
    yield* geekom.createIssue({ projectId: corkAndNote, title: "Already here" }, user);
    const exported = yield* laptop.exportBacklog({ backlogId: issue.backlogId, to: toGeekom });
    const duplicate = yield* geekom.importBacklog(exported).pipe(Effect.flip);
    assert.equal(duplicate.code, "conflict");
    // The failed import is undone on the laptop, which then works as before.
    const restored = yield* laptop.restoreBacklog(issue.backlogId);
    assert.isUndefined(restored.movedTo);
    yield* laptop.comment({ issueId: issue.id, text: "Back" }, user);
  }).pipe(Effect.scoped),
);

it.effect("moves a board back, replacing the redirect it left", () =>
  Effect.gen(function* () {
    const { laptop, geekom } = yield* twoMachines;
    const issue = yield* laptop.createIssue({ projectId: corkAndNote, title: "Paywall" }, user);
    const toLaptop = { environmentId, label: "Laptop" };
    yield* geekom.importBacklog(
      yield* laptop.exportBacklog({ backlogId: issue.backlogId, to: toGeekom }),
    );
    yield* geekom.comment({ issueId: issue.id, text: "Worked on the Geekom" }, user);
    const back = yield* laptop.importBacklog(
      yield* geekom.exportBacklog({ backlogId: issue.backlogId, to: toLaptop }),
    );
    assert.isUndefined(back.movedTo);
    const detail = yield* laptop.getIssue({ issueId: issue.id });
    assert.equal(detail.activity.at(-1)?.text, "Worked on the Geekom");
    assert.equal(
      (yield* geekom.resolveBacklogRef(issue.backlogId).pipe(Effect.flip)).code,
      "conflict",
    );
  }).pipe(Effect.scoped),
);

it.effect("gives claims held on other machines one lease to renew after the hub restarts", () =>
  Effect.gen(function* () {
    const sql = yield* Layer.build(SqlitePersistenceMemory);
    const start = () =>
      Layer.build(testLayer.pipe(Layer.provide(Layer.succeedContext(sql)))).pipe(
        Effect.map((context) => Context.get(context, BacklogService)),
      );
    const remote: BacklogActor = {
      kind: "agent",
      environmentId: EnvironmentId.make("environment-spoke"),
      threadId: ThreadId.make("thread-on-the-spoke"),
      label: "Spoke agent",
    };
    const firstRun = yield* Scope.make();
    const before = yield* start().pipe(Scope.provide(firstRun));
    const issue = yield* before.createIssue({ title: "Remote work", status: "ready" }, user);
    yield* before.claim({ issueId: issue.id }, remote);
    yield* Scope.close(firstRun, Exit.void);

    // Down for longer than a lease: the spoke could not renew meanwhile.
    yield* TestClock.adjust("30 minutes");
    const after = yield* start();
    yield* TestClock.adjust("1 minute");
    assert.equal((yield* after.getIssue({ issueId: issue.id })).issue.status, "in_progress");

    // A spoke that never renews loses it one lease later.
    yield* TestClock.adjust("16 minutes");
    assert.isNull((yield* after.getIssue({ issueId: issue.id })).issue.claim);
  }).pipe(Effect.scoped),
);
