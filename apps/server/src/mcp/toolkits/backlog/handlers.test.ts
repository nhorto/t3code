import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationProjectShell,
  type OrchestrationV2ThreadShell,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import * as BacklogService from "../../../backlog/BacklogService.ts";
import * as ThreadManagement from "../../../orchestration-v2/ThreadManagementService.ts";
import { SqlitePersistenceMemory } from "../../../persistence/Layers/Sqlite.ts";
import * as Project from "../../../project/ProjectService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { BacklogHandlersLive } from "./handlers.ts";
import { BacklogToolkit } from "./tools.ts";

const environmentId = EnvironmentId.make("environment-a");
const projectId = ProjectId.make("project-cork");
const providerInstanceId = ProviderInstanceId.make("codex");

const shell = (id: string, title: string) =>
  ({
    id: ThreadId.make(id),
    projectId,
    title,
    providerInstanceId,
    modelSelection: { instanceId: providerInstanceId, model: "gpt-5" },
    runtimeMode: "full-access",
    interactionMode: "default",
    activeRunId: "run-1",
    archivedAt: null,
    deletedAt: null,
  }) as unknown as OrchestrationV2ThreadShell;

const threadsById = new Map([
  ["thread-orchestrator", shell("thread-orchestrator", "Plan onboarding")],
  ["thread-worker", shell("thread-worker", "Welcome screen")],
]);

const services = BacklogService.layer.pipe(
  Layer.provideMerge(
    Layer.mergeAll(
      NodeCrypto.layer,
      Layer.mock(Project.ProjectService)({
        getShell: (id) =>
          Effect.succeed(
            id === projectId
              ? Option.some({ id, title: "Cork & Note" } as unknown as OrchestrationProjectShell)
              : Option.none(),
          ),
      }),
      Layer.mock(ThreadManagement.ThreadManagementService)({
        getThreadShell: (threadId) => Effect.succeed(threadsById.get(threadId) ?? null),
      }),
    ),
  ),
  Layer.provide(SqlitePersistenceMemory),
);

type Tools = typeof BacklogToolkit.tools;

/** Calls a tool as the given thread; returns the success or the returned failure. */
const harness = Effect.gen(function* () {
  const context = yield* Effect.context<
    BacklogService.BacklogService | ThreadManagement.ThreadManagementService
  >();
  const toolkit = yield* BacklogToolkit.pipe(Effect.provide(BacklogHandlersLive));
  return <Name extends keyof Tools>(
    threadId: string,
    name: Name,
    params: Parameters<typeof toolkit.handle<Name>>[1],
    capabilities: ReadonlyArray<McpInvocationContext.McpCapability> = ["orchestration"],
  ) =>
    toolkit.handle(name, params).pipe(
      Stream.unwrap,
      Stream.runCollect,
      Effect.map((chunk) => chunk.at(-1)!),
      Effect.provideService(McpInvocationContext.McpInvocationContext, {
        environmentId,
        threadId: ThreadId.make(threadId),
        providerSessionId: "session",
        providerInstanceId,
        issuedAt: 0,
        capabilities: new Set(capabilities),
      }),
      Effect.provide(context),
    );
});

it.effect("files a bug into a project's backlog attributed to the calling thread", () =>
  Effect.gen(function* () {
    const call = yield* harness;
    const created = yield* call("thread-orchestrator", "backlog_create_issue", {
      projectId,
      title: "Paywall crashes on iPad",
      type: "bug",
    });
    expect(created.isFailure).toBe(false);
    expect(created.result).toMatchObject({
      key: "CN-1",
      status: "backlog",
      type: "bug",
      createdBy: {
        kind: "agent",
        environmentId,
        threadId: "thread-orchestrator",
        label: "Plan onboarding · gpt-5",
      },
    });

    const inbox = yield* call("thread-orchestrator", "backlog_create_issue", { title: "Idea" });
    expect(inbox.result).toMatchObject({ key: "INBOX-1", status: "inbox" });

    const read = yield* call("thread-orchestrator", "backlog_get_issue", { issue: "cn-1" });
    expect(read.result).toMatchObject({ issue: { title: "Paywall crashes on iPad" } });
  }).pipe(Effect.provide(services)),
);

it.effect("runs a spec through children, exclusive claims, a linked PR, and release", () =>
  Effect.gen(function* () {
    const call = yield* harness;
    const guide = yield* call("thread-orchestrator", "backlog_guide", {});
    expect((guide.result as { guide: string }).guide).toContain("tracer bullet");

    yield* call("thread-orchestrator", "backlog_create_issue", {
      projectId,
      title: "Onboarding",
      body: "Spec: welcome, then permissions.",
    });
    const children = yield* call("thread-orchestrator", "backlog_create_children", {
      parent: "CN-1",
      children: [
        { title: "Welcome screen", status: "ready" },
        { title: "Permissions", status: "ready", blockedBySiblings: [0] },
      ],
    });
    expect(children.result).toMatchObject({ issues: [{ key: "CN-2" }, { key: "CN-3" }] });

    const frontier = yield* call("thread-worker", "backlog_list_issues", { frontierOnly: true });
    expect(frontier.result).toMatchObject({ issues: [{ key: "CN-2" }], total: 1 });

    const claimed = yield* call("thread-worker", "backlog_claim_next", { parent: "CN-1" });
    expect(claimed.result).toMatchObject({
      claimed: {
        issue: { key: "CN-2", status: "in_progress" },
        parent: { body: "Spec: welcome, then permissions." },
      },
    });

    const contested = yield* call("thread-orchestrator", "backlog_claim", { issue: "CN-2" });
    expect(contested.isFailure).toBe(true);
    expect(contested.result).toMatchObject({ _tag: "BacklogError", code: "conflict" });

    const linked = yield* call("thread-worker", "backlog_link_pull_request", {
      url: "https://github.com/nhorto/cork-and-note/pull/7",
    });
    expect(linked.result).toMatchObject({
      issues: [
        {
          key: "CN-2",
          links: [
            { type: "thread", threadId: "thread-worker" },
            { type: "pull_request", url: "https://github.com/nhorto/cork-and-note/pull/7" },
          ],
        },
      ],
    });

    const notHolder = yield* call("thread-orchestrator", "backlog_release", {
      issue: "CN-2",
      status: "ready",
    });
    expect(notHolder.result).toMatchObject({ code: "conflict" });

    const released = yield* call("thread-worker", "backlog_release", {
      issue: "CN-2",
      status: "done",
      note: "Merged.",
    });
    expect(released.result).toMatchObject({ status: "done", claim: null });

    const unblocked = yield* call("thread-worker", "backlog_list_issues", { frontierOnly: true });
    expect(unblocked.result).toMatchObject({ issues: [{ key: "CN-3" }] });
  }).pipe(Effect.provide(services)),
);

it.effect("refuses a credential that cannot reach orchestration", () =>
  Effect.gen(function* () {
    const call = yield* harness;
    const denied = yield* call("thread-worker", "backlog_list_backlogs", {}, ["preview"]);
    expect(denied.isFailure).toBe(true);
    expect(denied.result).toMatchObject({
      _tag: "OrchestratorMcpFailure",
      code: "capability_denied",
    });
  }).pipe(Effect.provide(services)),
);
