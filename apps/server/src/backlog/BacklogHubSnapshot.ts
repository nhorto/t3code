/**
 * What a spoke last heard from its backlog hub, so its agents can still read
 * the hub's boards on a plane. Every read that reaches the hub refreshes the
 * snapshot (in memory and in this server's database); a read that cannot
 * reach it answers from the snapshot, and `track` reports how old that answer
 * is so the response can say `stale: true` with its `asOf`. Writes never fall
 * back: they keep failing with code unavailable.
 */
import {
  Backlog,
  BacklogIssue,
  BacklogIssueDetail,
  isBacklogIssueOnFrontier,
  type BacklogError,
  type BacklogIssueId,
  type BacklogListIssuesInput,
  type EnvironmentId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import type { BacklogHome } from "./BacklogHome.ts";

/** How old a stale answer is: the oldest snapshot row it used. */
export interface BacklogStaleMark {
  readonly asOf: string;
}

export class BacklogHubSnapshot extends Context.Service<
  BacklogHubSnapshot,
  {
    /** The hub's home with its reads recorded, and answered from the snapshot while unreachable. */
    readonly wrap: (hubEnvironmentId: EnvironmentId, home: BacklogHome) => BacklogHome;
    /** Runs `effect` and reports whether any read inside it was answered from the snapshot. */
    readonly track: <A, E, R>(
      effect: Effect.Effect<A, E, R>,
    ) => Effect.Effect<{ readonly value: A; readonly stale: BacklogStaleMark | null }, E, R>;
  }
>()("t3/backlog/BacklogHubSnapshot") {}

/** The oldest asOf among the snapshot answers of one tracked call. */
class StaleReads extends Context.Service<StaleReads, Ref.Ref<string | null>>()(
  "t3/backlog/BacklogHubSnapshot/StaleReads",
) {}

type Kind = "backlog" | "issue" | "detail";

interface Entry<A> {
  readonly value: A;
  readonly asOf: string;
}

interface HubCache {
  readonly backlogs: Map<string, Entry<Backlog>>;
  readonly issues: Map<string, Entry<BacklogIssue>>;
  readonly details: Map<string, Entry<BacklogIssueDetail>>;
}

const BacklogJson = Schema.fromJsonString(Backlog);
const IssueJson = Schema.fromJsonString(BacklogIssue);
const DetailJson = Schema.fromJsonString(BacklogIssueDetail);
const encodeBacklog = Schema.encodeSync(BacklogJson);
const encodeIssue = Schema.encodeSync(IssueJson);
const encodeDetail = Schema.encodeSync(DetailJson);
const decodeBacklog = Schema.decodeUnknownOption(BacklogJson);
const decodeIssue = Schema.decodeUnknownOption(IssueJson);
const decodeDetail = Schema.decodeUnknownOption(DetailJson);

const isUnavailable = (error: BacklogError) =>
  error.code === "unavailable" && error.reason !== "not_linked";

const oldest = (entries: ReadonlyArray<{ readonly asOf: string }>, fallback: string) =>
  entries.reduce((min, entry) => (entry.asOf < min ? entry.asOf : min), fallback);

/** The snapshot's answer to a listIssues call, as the hub would filter it. */
export function filterSnapshotIssues(
  issues: ReadonlyArray<BacklogIssue>,
  backlogs: ReadonlyArray<Backlog>,
  filters: BacklogListIssuesInput,
): ReadonlyArray<BacklogIssue> {
  const moved = new Set(
    backlogs.filter((backlog) => backlog.movedTo !== undefined).map((backlog) => backlog.id),
  );
  const byId = new Map(issues.map((issue) => [issue.id, issue] as const));
  return issues.filter(
    (issue) =>
      !moved.has(issue.backlogId) &&
      (filters.backlogId === undefined || issue.backlogId === filters.backlogId) &&
      (filters.status === undefined ||
        filters.status.length === 0 ||
        filters.status.includes(issue.status)) &&
      (filters.type === undefined || issue.type === filters.type) &&
      (filters.parentId === undefined || issue.parentId === filters.parentId) &&
      (filters.frontierOnly !== true || isBacklogIssueOnFrontier(issue, byId)),
  );
}

export const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE IF NOT EXISTS backlog_hub_snapshot (
      hub_environment_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      id TEXT NOT NULL,
      json TEXT NOT NULL,
      as_of TEXT NOT NULL,
      PRIMARY KEY (hub_environment_id, kind, id)
    )
  `;
  const caches = yield* Ref.make(new Map<string, HubCache>());
  const lock = yield* Semaphore.make(1);

  /** The hub's cache, loaded from the database on first use. */
  const cacheFor = (hubId: string) =>
    Effect.gen(function* () {
      const loaded = (yield* Ref.get(caches)).get(hubId);
      if (loaded !== undefined) return loaded;
      const rows = yield* sql<{ kind: Kind; id: string; json: string; as_of: string }>`
        SELECT kind, id, json, as_of FROM backlog_hub_snapshot WHERE hub_environment_id = ${hubId}
      `;
      const cache: HubCache = { backlogs: new Map(), issues: new Map(), details: new Map() };
      for (const row of rows) {
        if (row.kind === "backlog") {
          Option.map(decodeBacklog(row.json), (value) =>
            cache.backlogs.set(row.id, { value, asOf: row.as_of }),
          );
        } else if (row.kind === "issue") {
          Option.map(decodeIssue(row.json), (value) =>
            cache.issues.set(row.id, { value, asOf: row.as_of }),
          );
        } else {
          Option.map(decodeDetail(row.json), (value) =>
            cache.details.set(row.id, { value, asOf: row.as_of }),
          );
        }
      }
      yield* Ref.update(caches, (current) => new Map(current).set(hubId, cache));
      return cache;
    });

  const upsert = (hubId: string, kind: Kind, id: string, json: string, asOf: string) =>
    sql`
      INSERT INTO backlog_hub_snapshot (hub_environment_id, kind, id, json, as_of)
      VALUES (${hubId}, ${kind}, ${id}, ${json}, ${asOf})
      ON CONFLICT (hub_environment_id, kind, id) DO UPDATE SET json = excluded.json, as_of = excluded.as_of
    `;

  /**
   * Stores what the hub just said. Rows whose version is unchanged only get a
   * newer asOf in memory, so a busy agent's repeated lists cost no writes.
   */
  const record = (
    hubId: string,
    update: {
      readonly backlogs?: ReadonlyArray<Backlog>;
      readonly issues?: ReadonlyArray<BacklogIssue>;
      readonly detail?: BacklogIssueDetail;
    },
  ) =>
    lock
      .withPermits(1)(
        Effect.gen(function* () {
          const cache = yield* cacheFor(hubId);
          const asOf = DateTime.formatIso(yield* DateTime.now);
          const writes: Array<ReturnType<typeof upsert>> = [];
          if (update.backlogs !== undefined) {
            // A backlog list is complete, so a backlog missing from it is gone.
            const listed = new Set<string>(update.backlogs.map((backlog) => backlog.id));
            for (const id of [...cache.backlogs.keys()]) {
              if (listed.has(id)) continue;
              cache.backlogs.delete(id);
              writes.push(
                sql`DELETE FROM backlog_hub_snapshot WHERE hub_environment_id = ${hubId} AND kind = 'backlog' AND id = ${id}`,
              );
            }
            for (const backlog of update.backlogs) {
              const previous = cache.backlogs.get(backlog.id);
              cache.backlogs.set(backlog.id, { value: backlog, asOf });
              if (previous?.value.updatedAt !== backlog.updatedAt) {
                writes.push(upsert(hubId, "backlog", backlog.id, encodeBacklog(backlog), asOf));
              }
            }
          }
          const issues = [
            ...(update.issues ?? []),
            ...(update.detail === undefined
              ? []
              : [update.detail.issue, ...update.detail.children, ...update.detail.blockers]),
          ];
          for (const issue of issues) {
            const previous = cache.issues.get(issue.id);
            cache.issues.set(issue.id, { value: issue, asOf });
            if (previous?.value.updatedAt !== issue.updatedAt) {
              writes.push(upsert(hubId, "issue", issue.id, encodeIssue(issue), asOf));
            }
          }
          if (update.detail !== undefined) {
            const detail = update.detail;
            const previous = cache.details.get(detail.issue.id);
            cache.details.set(detail.issue.id, { value: detail, asOf });
            if (
              previous?.value.issue.updatedAt !== detail.issue.updatedAt ||
              previous.value.activity.length !== detail.activity.length
            ) {
              writes.push(upsert(hubId, "detail", detail.issue.id, encodeDetail(detail), asOf));
            }
          }
          if (writes.length > 0) yield* sql.withTransaction(Effect.all(writes, { discard: true }));
        }),
      )
      .pipe(
        // The snapshot is a convenience; failing to keep it must not fail the read.
        Effect.catchCause((cause) =>
          Effect.logWarning("Could not record the backlog hub snapshot", { cause }),
        ),
      );

  const markStale = (asOf: string) =>
    Effect.serviceOption(StaleReads).pipe(
      Effect.flatMap(
        Option.match({
          onNone: () => Effect.void,
          onSome: (ref) =>
            Ref.update(ref, (current) => (current === null || asOf < current ? asOf : current)),
        }),
      ),
    );

  /** The cached answer, or the original failure when the snapshot cannot answer. */
  const fromSnapshot = <A>(
    hubId: string,
    error: BacklogError,
    answer: (cache: HubCache) => { readonly value: A; readonly asOf: string } | null,
  ): Effect.Effect<A, BacklogError> =>
    Effect.gen(function* () {
      const cache = yield* cacheFor(hubId).pipe(Effect.orElseSucceed(() => null));
      const answered = cache === null ? null : answer(cache);
      if (answered === null) return yield* error;
      yield* markStale(answered.asOf);
      return answered.value;
    });

  /** The most recent time the hub answered anything, for an empty stale answer. */
  const lastContact = (cache: HubCache) =>
    [...cache.backlogs.values(), ...cache.issues.values()].reduce<string | null>(
      (max, entry) => (max === null || entry.asOf > max ? entry.asOf : max),
      null,
    );

  const wrap: BacklogHubSnapshot["Service"]["wrap"] = (hubEnvironmentId, home) => {
    const hubId = hubEnvironmentId;
    const orSnapshot =
      <A>(answer: (cache: HubCache) => { readonly value: A; readonly asOf: string } | null) =>
      (error: BacklogError) =>
        isUnavailable(error) ? fromSnapshot(hubId, error, answer) : Effect.fail(error);
    return {
      ...home,
      listBacklogs: () =>
        home.listBacklogs().pipe(
          Effect.tap((backlogs) => record(hubId, { backlogs })),
          Effect.catch(
            orSnapshot((cache) => {
              const entries = [...cache.backlogs.values()];
              if (entries.length === 0) return null;
              return {
                value: entries.map((entry) => entry.value),
                asOf: oldest(entries, entries[0]!.asOf),
              };
            }),
          ),
        ),
      listIssues: (input) =>
        home.listIssues(input).pipe(
          Effect.tap((issues) => record(hubId, { issues })),
          Effect.catch(
            orSnapshot((cache) => {
              const contact = lastContact(cache);
              if (contact === null) return null;
              const issues = filterSnapshotIssues(
                [...cache.issues.values()].map((entry) => entry.value),
                [...cache.backlogs.values()].map((entry) => entry.value),
                input,
              );
              return {
                value: issues,
                asOf: oldest(
                  issues.map((issue) => cache.issues.get(issue.id)!),
                  contact,
                ),
              };
            }),
          ),
        ),
      resolveIssue: (ref) =>
        home.resolveIssue(ref).pipe(
          Effect.catch(
            orSnapshot((cache) => {
              const wanted = ref.trim();
              for (const entry of cache.issues.values()) {
                if (entry.value.id === wanted || entry.value.key === wanted.toUpperCase()) {
                  return { value: entry.value.id, asOf: entry.asOf };
                }
              }
              return null;
            }),
          ),
        ),
      getIssue: (input) =>
        home.getIssue(input).pipe(
          Effect.tap((detail) => record(hubId, { detail })),
          Effect.catch(
            orSnapshot((cache) => {
              const cached = cache.details.get(input.issueId);
              const row = cache.issues.get(input.issueId);
              // The newer of the stored detail and the board row wins for the row itself.
              if (cached !== undefined) {
                return row !== undefined && row.asOf > cached.asOf
                  ? { value: { ...cached.value, issue: row.value }, asOf: cached.asOf }
                  : cached;
              }
              // Without a stored detail, only an issue with no body can be answered whole.
              if (row === undefined || row.value.hasBody) return null;
              return { value: detailFromRows(cache, row.value), asOf: row.asOf };
            }),
          ),
        ),
    };
  };

  const track: BacklogHubSnapshot["Service"]["track"] = (effect) =>
    Effect.gen(function* () {
      const reads = yield* Ref.make<string | null>(null);
      const value = yield* effect.pipe(Effect.provideService(StaleReads, reads));
      const asOf = yield* Ref.get(reads);
      return { value, stale: asOf === null ? null : { asOf } };
    });

  return BacklogHubSnapshot.of({ wrap, track });
});

/** A detail assembled from snapshot rows, for an issue whose detail was never read. */
function detailFromRows(cache: HubCache, issue: BacklogIssue): BacklogIssueDetail {
  const rows = [...cache.issues.values()].map((entry) => entry.value);
  const parent = issue.parentId === null ? undefined : cache.issues.get(issue.parentId)?.value;
  const parentBody = parent === undefined ? undefined : cache.details.get(parent.id)?.value.body;
  return {
    issue,
    body: "",
    parent:
      parent !== undefined && (parentBody !== undefined || !parent.hasBody)
        ? { issue: parent, body: parentBody ?? "" }
        : null,
    children: rows.filter((row) => row.parentId === issue.id),
    blockers: issue.blockedBy.flatMap((id: BacklogIssueId) => {
      const blocker = cache.issues.get(id)?.value;
      return blocker === undefined ? [] : [blocker];
    }),
    activity: [],
  };
}

export const layer = Layer.effect(BacklogHubSnapshot, make);
