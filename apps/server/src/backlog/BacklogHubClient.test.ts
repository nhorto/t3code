import { assert, it } from "@effect/vitest";
import {
  EnvironmentId,
  ThreadId,
  type BacklogRenewClaimsInput,
  type OrchestrationV2ThreadShell,
  type OrchestrationV2ThreadShellSnapshot,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as BacklogHubClient from "./BacklogHubClient.ts";

const spoke = EnvironmentId.make("environment-mac");
const running = ThreadId.make("thread-running");
const asking = ThreadId.make("thread-asking");

const thread = (id: string, overrides: Partial<Record<string, unknown>>) =>
  ({
    id: ThreadId.make(id),
    activeRunId: null,
    archivedAt: null,
    deletedAt: null,
    latestRunCompletedAt: null,
    updatedAt: DateTime.makeUnsafe(0),
    ...overrides,
  }) as unknown as OrchestrationV2ThreadShell;

it.effect(
  "renews this machine's hub leases every few minutes for threads still holding claims",
  () =>
    Effect.gen(function* () {
      const renewals: Array<BacklogRenewClaimsInput> = [];
      const connections = yield* PubSub.unbounded<void>();
      const renewed = yield* Queue.unbounded<BacklogRenewClaimsInput>();
      let linked = true;
      const layer = Layer.mergeAll(
        Layer.mock(BacklogHubClient.BacklogHubClient)({
          linkedHub: Effect.sync(() =>
            linked
              ? Option.some({
                  environmentId: EnvironmentId.make("environment-geekom"),
                  label: "Geekom",
                })
              : Option.none(),
          ),
          home: {} as BacklogHubClient.BacklogHubClient["Service"]["home"],
          renewClaims: (input) =>
            Effect.sync(() => void renewals.push(input)).pipe(
              Effect.andThen(Queue.offer(renewed, input)),
              Effect.asVoid,
            ),
          connections: () => Stream.fromPubSub(connections),
        }),
        Layer.mock(ThreadManagementService.ThreadManagementService)({
          getShellSnapshot: () =>
            Effect.succeed({
              threads: [
                thread("thread-running", { activeRunId: "run-1" }),
                // Asked the user a question at t=0: still holds its claims for two hours.
                thread("thread-asking", {}),
                thread("thread-archived", {
                  activeRunId: "run-2",
                  archivedAt: DateTime.makeUnsafe(0),
                }),
              ],
            } as unknown as OrchestrationV2ThreadShellSnapshot),
        }),
        Layer.mock(ServerEnvironment.ServerEnvironment)({
          getEnvironmentId: Effect.succeed(spoke),
        }),
      );

      const fiber = yield* BacklogHubClient.renewHubLeasesForever.pipe(
        Effect.provide(layer),
        Effect.forkChild,
      );
      yield* TestClock.adjust("4 minutes");
      assert.lengthOf(renewals, 0);
      yield* TestClock.adjust("1 minute");
      assert.deepEqual(renewals, [{ environmentId: spoke, threadIds: [running, asking] }]);

      // Past the idle grace only the running thread is renewed.
      yield* TestClock.adjust("2 hours");
      assert.deepEqual(renewals.at(-1), { environmentId: spoke, threadIds: [running] });

      // A reconnect renews at once instead of waiting out the interval.
      yield* Queue.clear(renewed);
      yield* PubSub.publish(connections, undefined);
      assert.deepEqual(yield* Queue.take(renewed), { environmentId: spoke, threadIds: [running] });

      // Unlinked: nothing is sent.
      linked = false;
      const sent = renewals.length;
      yield* TestClock.adjust("10 minutes");
      assert.lengthOf(renewals, sent);
      yield* Fiber.interrupt(fiber);
    }),
);
