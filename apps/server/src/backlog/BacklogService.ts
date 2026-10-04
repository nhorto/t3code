import {
  BACKLOG_CLAIM_LEASE_MS,
  Backlog,
  BacklogActivity,
  BacklogActor,
  BacklogError,
  BacklogIssue,
  BacklogIssueLink,
  compareBacklogIssuesForClaim,
  deriveBacklogKey,
  isBacklogStatusClosed,
  parseBacklogIssueKey,
  type BacklogActivityKind,
  type BacklogCommentInput,
  type BacklogCreateIssueInput,
  type BacklogGetIssueInput,
  type EnvironmentId,
  type BacklogId,
  type BacklogIssueDetail,
  type BacklogIssueId,
  type BacklogIssuePriority,
  type BacklogIssueStatus,
  type BacklogIssueType,
  type BacklogReleaseInput,
  type BacklogStreamEvent,
  type BacklogUpdateBacklogInput,
  type BacklogUpdateIssueInput,
  type ProjectId,
  type ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type * as Statement from "effect/unstable/sql/Statement";

import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as ProjectService from "../project/ProjectService.ts";
import { forkParked } from "../serverActivation.ts";

/** How often the lease keeper renews live holders' claims and expires the rest. */
export const LEASE_KEEPER_INTERVAL = "1 minute";

const INBOX_KEY = "INBOX";
const LEASE_KEEPER_ACTOR: BacklogActor = {
  kind: "system",
  environmentId: null,
  threadId: null,
  label: "Lease keeper",
};

export interface BacklogIssueFilters {
  readonly backlogId?: BacklogId | undefined;
  readonly status?: ReadonlyArray<BacklogIssueStatus> | undefined;
  readonly type?: BacklogIssueType | undefined;
  readonly parentId?: BacklogIssueId | undefined;
  /** Only ready, unblocked, unclaimed issues. */
  readonly frontierOnly?: boolean | undefined;
}

export interface BacklogChildInput {
  readonly title: string;
  readonly body?: string | undefined;
  readonly type?: BacklogIssueType | undefined;
  readonly priority?: BacklogIssuePriority | null | undefined;
  readonly status?: BacklogIssueStatus | undefined;
  /** Zero-based indexes of sibling children in the same batch that block this one. */
  readonly blockedBySiblings?: ReadonlyArray<number> | undefined;
  /** Existing issues that block this one. */
  readonly blockedBy?: ReadonlyArray<BacklogIssueId> | undefined;
}

export interface BacklogCreateChildrenInput {
  readonly parentId: BacklogIssueId;
  readonly children: ReadonlyArray<BacklogChildInput>;
}

export interface BacklogClaimInput {
  readonly issueId: BacklogIssueId;
}

export type BacklogClaimNextInput = Pick<BacklogIssueFilters, "backlogId" | "parentId" | "type">;

export interface BacklogRenewClaimsInput {
  readonly environmentId: EnvironmentId | null;
  readonly threadIds: ReadonlyArray<ThreadId>;
}

export interface BacklogAddLinkInput {
  readonly issueId: BacklogIssueId;
  readonly link: BacklogIssueLink;
}

export class BacklogService extends Context.Service<
  BacklogService,
  {
    readonly listBacklogs: () => Effect.Effect<ReadonlyArray<Backlog>, BacklogError>;
    /** Accepts a backlog id or its key, case-insensitive. */
    readonly resolveBacklogRef: (ref: string) => Effect.Effect<Backlog, BacklogError>;
    /** The project's backlog, created from the project title on first use. */
    readonly ensureProjectBacklog: (projectId: ProjectId) => Effect.Effect<Backlog, BacklogError>;
    readonly updateBacklog: (
      input: BacklogUpdateBacklogInput,
      actor: BacklogActor,
    ) => Effect.Effect<Backlog, BacklogError>;
    readonly listIssues: (
      filters?: BacklogIssueFilters,
    ) => Effect.Effect<ReadonlyArray<BacklogIssue>, BacklogError>;
    readonly getIssue: (
      input: BacklogGetIssueInput,
    ) => Effect.Effect<BacklogIssueDetail, BacklogError>;
    /** Accepts an issue id or a key such as WINE-12, case-insensitive. */
    readonly resolveIssueRef: (ref: string) => Effect.Effect<BacklogIssueId, BacklogError>;
    readonly createIssue: (
      input: BacklogCreateIssueInput,
      actor: BacklogActor,
    ) => Effect.Effect<BacklogIssue, BacklogError>;
    /** Creates a parent's breakdown and its blocking edges in one transaction. */
    readonly createChildren: (
      input: BacklogCreateChildrenInput,
      actor: BacklogActor,
    ) => Effect.Effect<ReadonlyArray<BacklogIssue>, BacklogError>;
    /** Omitted fields are preserved; blockedBy replaces the full list. */
    readonly updateIssue: (
      input: BacklogUpdateIssueInput,
      actor: BacklogActor,
    ) => Effect.Effect<BacklogIssue, BacklogError>;
    readonly comment: (
      input: BacklogCommentInput,
      actor: BacklogActor,
    ) => Effect.Effect<BacklogActivity, BacklogError>;
    /**
     * Claims a frontier issue exclusively and returns the detail with the parent
     * spec. Re-claiming an issue the actor already holds renews the lease, so a
     * retried call is safe.
     */
    readonly claim: (
      input: BacklogClaimInput,
      actor: BacklogActor,
    ) => Effect.Effect<BacklogIssueDetail, BacklogError>;
    /** Claims the best frontier issue matching the filters, or returns null when none is free. */
    readonly claimNext: (
      input: BacklogClaimNextInput,
      actor: BacklogActor,
    ) => Effect.Effect<BacklogIssueDetail | null, BacklogError>;
    /**
     * The holder (same environment and thread) releases its claim. A user
     * releases anyone's claim: that is the client's force-release.
     */
    readonly release: (
      input: BacklogReleaseInput,
      actor: BacklogActor,
    ) => Effect.Effect<BacklogIssue, BacklogError>;
    /** Extends every lease those threads hold. Not published: renewal is not a visible change. */
    readonly renewClaims: (input: BacklogRenewClaimsInput) => Effect.Effect<void, BacklogError>;
    readonly addLink: (
      input: BacklogAddLinkInput,
      actor: BacklogActor,
    ) => Effect.Effect<BacklogIssue, BacklogError>;
    /** Links a pull request to every issue the actor's thread currently holds. */
    readonly linkPullRequestToClaims: (
      input: { readonly url: string },
      actor: BacklogActor,
    ) => Effect.Effect<ReadonlyArray<BacklogIssue>, BacklogError>;
    /** One snapshot of every backlog and issue, then row deltas. */
    readonly subscribe: () => Stream.Stream<BacklogStreamEvent, BacklogError>;
  }
>()("t3/backlog/BacklogService") {}

interface BacklogRow {
  readonly id: string;
  readonly kind: string;
  readonly key: string;
  readonly title: string;
  readonly project_id: string | null;
  readonly repository_key: string | null;
  readonly next_number: number;
  readonly created_at: string;
  readonly updated_at: string;
}

interface IssueRow {
  readonly id: string;
  readonly backlog_id: string;
  readonly backlog_key: string;
  readonly number: number;
  readonly title: string;
  readonly type: string;
  readonly status: string;
  readonly priority: string | null;
  readonly parent_id: string | null;
  readonly claim_actor_json: string | null;
  readonly claimed_at: string | null;
  readonly lease_expires_at: string | null;
  readonly links_json: string;
  readonly has_body: number;
  readonly created_by_json: string;
  readonly created_at: string;
  readonly updated_at: string;
  readonly closed_at: string | null;
}

interface ActivityRow {
  readonly id: string;
  readonly issue_id: string;
  readonly kind: string;
  readonly actor_json: string;
  readonly at: string;
  readonly text: string | null;
  readonly from_status: string | null;
  readonly to_status: string | null;
}

const isBacklogError = Schema.is(BacklogError);
const encodeActorJson = Schema.encodeSync(Schema.fromJsonString(BacklogActor));
const encodeLinksJson = Schema.encodeSync(Schema.fromJsonString(Schema.Array(BacklogIssueLink)));
const decodeBacklog = Schema.decodeUnknownEffect(Backlog);
const decodeIssue = Schema.decodeUnknownEffect(BacklogIssue);
const decodeActivity = Schema.decodeUnknownEffect(BacklogActivity);
const decodeActorJson = Schema.decodeUnknownEffect(Schema.fromJsonString(BacklogActor));
const decodeLinksJson = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Array(BacklogIssueLink)),
);

const decodeBacklogRow = (row: BacklogRow) =>
  decodeBacklog({
    id: row.id,
    kind: row.kind,
    key: row.key,
    title: row.title,
    projectId: row.project_id,
    repositoryKey: row.repository_key,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });

const decodeIssueRow = (row: IssueRow, blockedBy: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const claim =
      row.claim_actor_json === null
        ? null
        : {
            actor: yield* decodeActorJson(row.claim_actor_json),
            claimedAt: row.claimed_at,
            leaseExpiresAt: row.lease_expires_at,
          };
    return yield* decodeIssue({
      id: row.id,
      backlogId: row.backlog_id,
      number: row.number,
      key: `${row.backlog_key}-${row.number}`,
      title: row.title,
      type: row.type,
      status: row.status,
      priority: row.priority,
      parentId: row.parent_id,
      blockedBy,
      claim,
      links: yield* decodeLinksJson(row.links_json),
      hasBody: row.has_body === 1,
      createdBy: yield* decodeActorJson(row.created_by_json),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      closedAt: row.closed_at,
    });
  });

const decodeActivityRow = (row: ActivityRow) =>
  Effect.gen(function* () {
    return yield* decodeActivity({
      id: row.id,
      issueId: row.issue_id,
      kind: row.kind,
      actor: yield* decodeActorJson(row.actor_json),
      at: row.at,
      text: row.text,
      fromStatus: row.from_status,
      toStatus: row.to_status,
    });
  });

const ISSUE_COLUMNS = `
  i.id, i.backlog_id, b.key AS backlog_key, i.number, i.title, i.type, i.status, i.priority,
  i.parent_id, i.claim_actor_json, i.claimed_at, i.lease_expires_at, i.links_json,
  (i.body <> '') AS has_body, i.created_by_json, i.created_at, i.updated_at, i.closed_at`;

/** True while any blocker of `alias` is open or missing; mirrors isBacklogIssueBlocked. */
const openBlockerExists = (alias: string) => `EXISTS (
  SELECT 1 FROM backlog_issue_blockers edge
  LEFT JOIN backlog_issues blocker ON blocker.id = edge.blocker_id
  WHERE edge.issue_id = ${alias}.id
    AND (blocker.id IS NULL OR blocker.status NOT IN ('done', 'wontfix'))
)`;

const notFound = (message: string, issueId?: BacklogIssueId) =>
  new BacklogError({ code: "not_found", message, ...(issueId ? { issueId } : {}) });
const conflict = (message: string, issueId?: BacklogIssueId) =>
  new BacklogError({ code: "conflict", message, ...(issueId ? { issueId } : {}) });
const invalid = (message: string, issueId?: BacklogIssueId) =>
  new BacklogError({ code: "invalid", message, ...(issueId ? { issueId } : {}) });

/**
 * Storage and decode failures are defects: the contract's error codes describe
 * what a caller did wrong, and a broken database is not one of those.
 */
const backlogErrorsOnly = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.catch((error) => (isBacklogError(error) ? Effect.fail(error) : Effect.die(error))),
  );

const isHolder = (claimActor: BacklogActor, actor: BacklogActor) =>
  claimActor.threadId !== null &&
  claimActor.threadId === actor.threadId &&
  claimActor.environmentId === actor.environmentId;

const sameLink = (left: BacklogIssueLink, right: BacklogIssueLink) =>
  left.type === "thread"
    ? right.type === "thread" && right.threadId === left.threadId
    : right.type === "pull_request" && right.url === left.url;

interface Touched {
  readonly issues: Set<string>;
  readonly backlogs: Set<string>;
}

// Fork-only feature: the tables are created idempotently instead of through a
// numbered migration. Effect's migrator only runs ids above the latest one
// recorded, so a fork migration would make these databases silently skip the
// upstream migration that later takes the same id.
const ensureSchema = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE IF NOT EXISTS backlogs (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      key TEXT NOT NULL UNIQUE,
      title TEXT NOT NULL,
      project_id TEXT UNIQUE,
      repository_key TEXT,
      next_number INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `;
  yield* sql`
    CREATE TABLE IF NOT EXISTS backlog_issues (
      id TEXT PRIMARY KEY,
      backlog_id TEXT NOT NULL,
      number INTEGER NOT NULL,
      title TEXT NOT NULL,
      body TEXT NOT NULL DEFAULT '',
      type TEXT NOT NULL,
      status TEXT NOT NULL,
      priority TEXT,
      parent_id TEXT,
      claim_actor_json TEXT,
      claim_environment_id TEXT,
      claim_thread_id TEXT,
      claimed_at TEXT,
      lease_expires_at TEXT,
      links_json TEXT NOT NULL DEFAULT '[]',
      created_by_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      closed_at TEXT,
      UNIQUE (backlog_id, number)
    )
  `;
  yield* sql`CREATE INDEX IF NOT EXISTS backlog_issues_parent ON backlog_issues (parent_id)`;
  yield* sql`CREATE INDEX IF NOT EXISTS backlog_issues_claim_thread ON backlog_issues (claim_thread_id)`;
  yield* sql`CREATE INDEX IF NOT EXISTS backlog_issues_status ON backlog_issues (status)`;
  yield* sql`
    CREATE TABLE IF NOT EXISTS backlog_issue_blockers (
      issue_id TEXT NOT NULL,
      blocker_id TEXT NOT NULL,
      PRIMARY KEY (issue_id, blocker_id)
    )
  `;
  yield* sql`CREATE INDEX IF NOT EXISTS backlog_issue_blockers_blocker ON backlog_issue_blockers (blocker_id)`;
  yield* sql`
    CREATE TABLE IF NOT EXISTS backlog_activity (
      id TEXT PRIMARY KEY,
      issue_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      actor_json TEXT NOT NULL,
      at TEXT NOT NULL,
      text TEXT,
      from_status TEXT,
      to_status TEXT
    )
  `;
  yield* sql`CREATE INDEX IF NOT EXISTS backlog_activity_issue ON backlog_activity (issue_id)`;
});

export const layer = Layer.effect(
  BacklogService,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const crypto = yield* Crypto.Crypto;
    const projects = yield* ProjectService.ProjectService;
    const threads = yield* ThreadManagementService.ThreadManagementService;
    const events = yield* PubSub.unbounded<BacklogStreamEvent>();
    // One writer at a time so deltas publish in commit order; the SQLite
    // transaction is exclusive anyway, so this costs no concurrency.
    const writeLock = yield* Semaphore.make(1);

    const newId = crypto.randomUUIDv4.pipe(Effect.orDie);
    const now = DateTime.now;

    // Reads

    const selectBacklogs = (where: Statement.Fragment) =>
      sql<BacklogRow>`
        SELECT * FROM backlogs WHERE ${where}
        ORDER BY CASE kind WHEN 'inbox' THEN 0 ELSE 1 END, created_at, rowid
      `.pipe(Effect.flatMap((rows) => Effect.forEach(rows, decodeBacklogRow)));

    const findBacklog = (id: string) =>
      selectBacklogs(sql`id = ${id}`).pipe(Effect.map((rows) => rows[0] ?? null));

    const loadBacklog = (id: string) =>
      findBacklog(id).pipe(
        Effect.flatMap((backlog) =>
          backlog === null ? Effect.fail(notFound("Backlog not found.")) : Effect.succeed(backlog),
        ),
      );

    /** Board rows (no bodies) matching `where`, in board order, with their blocker edges. */
    const selectIssues = Effect.fn("BacklogService.selectIssues")(function* (
      where: Statement.Fragment | null,
    ) {
      const rows = yield* sql<IssueRow>`
        SELECT ${sql.literal(ISSUE_COLUMNS)}
        FROM backlog_issues i JOIN backlogs b ON b.id = i.backlog_id
        WHERE ${where ?? sql.literal("1=1")}
        ORDER BY b.created_at, b.rowid, i.number
      `;
      if (rows.length === 0) return [];
      const edges = yield* sql<{ issue_id: string; blocker_id: string }>`
        SELECT issue_id, blocker_id FROM backlog_issue_blockers
        WHERE ${
          where === null
            ? sql.literal("1=1")
            : sql.in(
                "issue_id",
                rows.map((row) => row.id),
              )
        }
        ORDER BY rowid
      `;
      const blockedBy = new Map<string, string[]>();
      for (const edge of edges) {
        const list = blockedBy.get(edge.issue_id) ?? [];
        list.push(edge.blocker_id);
        blockedBy.set(edge.issue_id, list);
      }
      return yield* Effect.forEach(rows, (row) => decodeIssueRow(row, blockedBy.get(row.id) ?? []));
    });

    const findIssue = (id: string) =>
      selectIssues(sql`i.id = ${id}`).pipe(Effect.map((rows) => rows[0] ?? null));

    const loadIssue = (id: BacklogIssueId) =>
      findIssue(id).pipe(
        Effect.flatMap((issue) =>
          issue === null ? Effect.fail(notFound("Issue not found.", id)) : Effect.succeed(issue),
        ),
      );

    const selectBody = (id: string) =>
      sql<{ body: string }>`SELECT body FROM backlog_issues WHERE id = ${id}`.pipe(
        Effect.map((rows) => rows[0]?.body ?? ""),
      );

    const openChildCount = (id: string) =>
      sql<{ count: number }>`
        SELECT COUNT(*) AS count FROM backlog_issues
        WHERE parent_id = ${id} AND status NOT IN ('done', 'wontfix')
      `.pipe(Effect.map((rows) => rows[0]?.count ?? 0));

    const filterClauses = (filters: BacklogIssueFilters) => [
      ...(filters.backlogId === undefined ? [] : [sql`i.backlog_id = ${filters.backlogId}`]),
      ...(filters.status === undefined || filters.status.length === 0
        ? []
        : [sql.in("i.status", filters.status)]),
      ...(filters.type === undefined ? [] : [sql`i.type = ${filters.type}`]),
      ...(filters.parentId === undefined ? [] : [sql`i.parent_id = ${filters.parentId}`]),
      ...(filters.frontierOnly === true
        ? [
            sql.literal(
              `i.status = 'ready' AND i.claim_actor_json IS NULL AND NOT ${openBlockerExists("i")}`,
            ),
          ]
        : []),
    ];

    // Writes. Every write runs inside `mutate`, which commits, then publishes
    // the rows it touched as they are after the commit.

    const publishTouched = Effect.fn("BacklogService.publishTouched")(function* (touched: Touched) {
      const changed: BacklogStreamEvent[] = [];
      if (touched.backlogs.size > 0) {
        for (const backlog of yield* selectBacklogs(sql.in("id", [...touched.backlogs]))) {
          changed.push({ type: "backlogUpserted", backlog });
        }
      }
      if (touched.issues.size > 0) {
        for (const issue of yield* selectIssues(sql.in("i.id", [...touched.issues]))) {
          changed.push({ type: "issueUpserted", issue });
        }
      }
      if (changed.length > 0) yield* PubSub.publishAll(events, changed);
    });

    const mutate = <A, E, R>(body: (touched: Touched) => Effect.Effect<A, E, R>) =>
      writeLock.withPermits(1)(
        Effect.gen(function* () {
          const touched: Touched = { issues: new Set(), backlogs: new Set() };
          const result = yield* sql.withTransaction(body(touched));
          yield* publishTouched(touched);
          return result;
        }),
      );

    const recordActivity = Effect.fn("BacklogService.recordActivity")(function* (input: {
      readonly issueId: string;
      readonly kind: BacklogActivityKind;
      readonly actor: BacklogActor;
      readonly at: string;
      readonly text?: string | null;
      readonly fromStatus?: BacklogIssueStatus | null;
      readonly toStatus?: BacklogIssueStatus | null;
    }) {
      const id = yield* newId;
      yield* sql`INSERT INTO backlog_activity ${sql.insert({
        id,
        issue_id: input.issueId,
        kind: input.kind,
        actor_json: encodeActorJson(input.actor),
        at: input.at,
        text: input.text ?? null,
        from_status: input.fromStatus ?? null,
        to_status: input.toStatus ?? null,
      })}`;
      return id;
    });

    const takeNumber = (backlogId: string) =>
      sql<{ number: number }>`
        UPDATE backlogs SET next_number = next_number + 1
        WHERE id = ${backlogId}
        RETURNING next_number - 1 AS number
      `.pipe(
        Effect.flatMap((rows) =>
          rows[0] === undefined
            ? Effect.fail(notFound("Backlog not found."))
            : Effect.succeed(rows[0].number),
        ),
      );

    /** A parent must exist in the same backlog and must not descend from the child. */
    const validateParent = Effect.fn("BacklogService.validateParent")(function* (
      issueId: string | null,
      parentId: BacklogIssueId,
      backlogId: string,
    ) {
      if (parentId === issueId) return yield* invalid("An issue cannot be its own parent.");
      const parent = yield* findIssue(parentId);
      if (parent === null) return yield* notFound("Parent issue not found.", parentId);
      if (parent.backlogId !== backlogId) {
        return yield* invalid("A parent and its children must be in the same backlog.", parentId);
      }
      if (issueId === null) return;
      const cycle = yield* sql`
        WITH RECURSIVE ancestors(id) AS (
          SELECT parent_id FROM backlog_issues WHERE id = ${parentId}
          UNION
          SELECT i.parent_id FROM backlog_issues i JOIN ancestors a ON i.id = a.id
        )
        SELECT 1 FROM ancestors WHERE id = ${issueId}
      `;
      if (cycle.length > 0) return yield* invalid("That parent would create a cycle.", parentId);
    });

    /** Replaces an issue's blockers after checking they exist and close no cycle. */
    const replaceBlockers = Effect.fn("BacklogService.replaceBlockers")(function* (
      issueId: string,
      blockerIds: ReadonlyArray<string>,
    ) {
      const unique = [...new Set(blockerIds)];
      if (unique.includes(issueId)) return yield* invalid("An issue cannot block itself.");
      yield* sql`DELETE FROM backlog_issue_blockers WHERE issue_id = ${issueId}`;
      if (unique.length === 0) return;
      const existing = yield* sql<{ id: string }>`
        SELECT id FROM backlog_issues WHERE ${sql.in("id", unique)}
      `;
      const missing = unique.find((id) => !existing.some((row) => row.id === id));
      if (missing !== undefined) return yield* notFound(`Blocking issue ${missing} not found.`);
      // A cycle exists when this issue is reachable from any new blocker.
      const cycle = yield* sql`
        WITH RECURSIVE reachable(id) AS (
          SELECT id FROM backlog_issues WHERE ${sql.in("id", unique)}
          UNION
          SELECT edge.blocker_id FROM backlog_issue_blockers edge
          JOIN reachable r ON edge.issue_id = r.id
        )
        SELECT 1 FROM reachable WHERE id = ${issueId}
      `;
      if (cycle.length > 0) return yield* invalid("Those blockers would create a cycle.");
      yield* sql`INSERT INTO backlog_issue_blockers ${sql.insert(
        unique.map((blockerId) => ({ issue_id: issueId, blocker_id: blockerId })),
      )}`;
    });

    const insertIssue = Effect.fn("BacklogService.insertIssue")(function* (
      backlog: Backlog,
      input: {
        readonly title: string;
        readonly body?: string | undefined;
        readonly type?: BacklogIssueType | undefined;
        readonly status?: BacklogIssueStatus | undefined;
        readonly priority?: BacklogIssuePriority | null | undefined;
        readonly parentId?: BacklogIssueId | null | undefined;
      },
      actor: BacklogActor,
      at: string,
      touched: Touched,
    ) {
      const id = yield* newId;
      if (input.parentId) yield* validateParent(null, input.parentId, backlog.id);
      const status = input.status ?? (backlog.kind === "inbox" ? "inbox" : "backlog");
      const number = yield* takeNumber(backlog.id);
      yield* sql`INSERT INTO backlog_issues ${sql.insert({
        id,
        backlog_id: backlog.id,
        number,
        title: input.title,
        body: input.body ?? "",
        type: input.type ?? "idea",
        status,
        priority: input.priority ?? null,
        parent_id: input.parentId ?? null,
        links_json: "[]",
        created_by_json: encodeActorJson(actor),
        created_at: at,
        updated_at: at,
        closed_at: isBacklogStatusClosed(status) ? at : null,
      })}`;
      yield* recordActivity({ issueId: id, kind: "created", actor, at, toStatus: status });
      touched.issues.add(id);
      return id as BacklogIssueId;
    });

    const touchIssue = (id: string, at: string, touched: Touched) =>
      sql`UPDATE backlog_issues SET updated_at = ${at} WHERE id = ${id}`.pipe(
        Effect.tap(() => Effect.sync(() => touched.issues.add(id))),
      );

    const writeLinks = (issue: BacklogIssue, links: ReadonlyArray<BacklogIssueLink>) =>
      sql`UPDATE backlog_issues SET links_json = ${encodeLinksJson(links)} WHERE id = ${issue.id}`;

    const appendLink = Effect.fn("BacklogService.appendLink")(function* (
      issue: BacklogIssue,
      link: BacklogIssueLink,
      actor: BacklogActor,
      at: string,
      touched: Touched,
    ) {
      if (issue.links.some((existing) => sameLink(existing, link))) return false;
      yield* writeLinks(issue, [...issue.links, link]);
      yield* recordActivity({
        issueId: issue.id,
        kind: "linked",
        actor,
        at,
        text: link.type === "thread" ? `Thread ${link.threadId}` : link.url,
      });
      yield* touchIssue(issue.id, at, touched);
      return true;
    });

    const clearClaim = (id: string) => sql`
      UPDATE backlog_issues
      SET claim_actor_json = NULL, claim_environment_id = NULL, claim_thread_id = NULL,
          claimed_at = NULL, lease_expires_at = NULL
      WHERE id = ${id}
    `;

    const setStatus = (issue: BacklogIssue, status: BacklogIssueStatus, at: string) =>
      sql`
        UPDATE backlog_issues
        SET status = ${status},
            closed_at = ${isBacklogStatusClosed(status) ? (issue.closedAt ?? at) : null}
        WHERE id = ${issue.id}
      `;

    const assertParentMayClose = Effect.fn("BacklogService.assertParentMayClose")(function* (
      issue: BacklogIssue,
      status: BacklogIssueStatus,
    ) {
      if (status !== "done" || issue.status === "done") return;
      if ((yield* openChildCount(issue.id)) > 0) {
        return yield* conflict("Close every child before marking the parent done.", issue.id);
      }
    });

    const renewLeases = (
      environmentId: string | null,
      threadIds: ReadonlyArray<string>,
      current: DateTime.Utc,
    ) =>
      threadIds.length === 0
        ? Effect.succeed([])
        : sql<{ id: string }>`
            UPDATE backlog_issues
            SET lease_expires_at = ${DateTime.formatIso(
              DateTime.add(current, { milliseconds: BACKLOG_CLAIM_LEASE_MS }),
            )}
            WHERE claim_actor_json IS NOT NULL
              AND claim_environment_id IS ${environmentId}
              AND ${sql.in("claim_thread_id", threadIds)}
            RETURNING id
          `;

    /**
     * Claims inside the caller's transaction. The conditional UPDATE is the
     * guard: only a ready, unclaimed, unblocked row matches, so two racing
     * claimants get exactly one winner.
     */
    const claimInTransaction = Effect.fn("BacklogService.claimInTransaction")(function* (
      issueId: BacklogIssueId,
      actor: BacklogActor,
      touched: Touched,
    ) {
      const current = yield* now;
      const at = DateTime.formatIso(current);
      const claimed = yield* sql`
        UPDATE backlog_issues
        SET status = 'in_progress',
            claim_actor_json = ${encodeActorJson(actor)},
            claim_environment_id = ${actor.environmentId},
            claim_thread_id = ${actor.threadId},
            claimed_at = ${at},
            lease_expires_at = ${DateTime.formatIso(
              DateTime.add(current, { milliseconds: BACKLOG_CLAIM_LEASE_MS }),
            )},
            updated_at = ${at}
        WHERE id = ${issueId}
          AND status = 'ready'
          AND claim_actor_json IS NULL
          AND NOT ${sql.literal(openBlockerExists("backlog_issues"))}
        RETURNING id
      `;
      if (claimed.length === 0) {
        const issue = yield* findIssue(issueId);
        if (issue === null) return yield* notFound("Issue not found.", issueId);
        if (issue.claim !== null && isHolder(issue.claim.actor, actor)) {
          // A retried claim by the holder renews instead of failing.
          yield* renewLeases(actor.environmentId, [actor.threadId!], current);
          return;
        }
        if (issue.claim !== null) {
          return yield* conflict(
            `${issue.key} is already claimed by ${issue.claim.actor.label}.`,
            issueId,
          );
        }
        if (issue.status !== "ready") {
          return yield* conflict(
            `${issue.key} is ${issue.status}; only ready issues can be claimed.`,
            issueId,
          );
        }
        return yield* conflict(`${issue.key} is blocked by an open issue.`, issueId);
      }
      yield* recordActivity({
        issueId,
        kind: "claimed",
        actor,
        at,
        text: actor.label,
        fromStatus: "ready",
        toStatus: "in_progress",
      });
      touched.issues.add(issueId);
      if (actor.kind === "agent" && actor.threadId !== null) {
        const issue = yield* loadIssue(issueId);
        yield* appendLink(
          issue,
          { type: "thread", environmentId: actor.environmentId, threadId: actor.threadId },
          actor,
          at,
          touched,
        );
      }
    });

    // Inbox: one per environment, created on first start.
    yield* ensureSchema;
    yield* Effect.gen(function* () {
      const at = DateTime.formatIso(yield* now);
      const id = yield* newId;
      yield* sql`
        INSERT INTO backlogs (id, kind, key, title, project_id, repository_key, next_number, created_at, updated_at)
        SELECT ${id}, 'inbox', ${INBOX_KEY}, 'Inbox', NULL, NULL, 1, ${at}, ${at}
        WHERE NOT EXISTS (SELECT 1 FROM backlogs WHERE kind = 'inbox')
      `;
    }).pipe(sql.withTransaction);

    const inbox = Effect.gen(function* () {
      const rows = yield* selectBacklogs(sql`kind = 'inbox'`);
      if (rows[0] === undefined)
        return yield* Effect.die(new Error("The backlog Inbox is missing."));
      return rows[0];
    });

    // Service methods

    const listBacklogs: BacklogService["Service"]["listBacklogs"] = () =>
      selectBacklogs(sql.literal("1=1")).pipe(backlogErrorsOnly);

    const resolveBacklogRef: BacklogService["Service"]["resolveBacklogRef"] = (ref) =>
      Effect.gen(function* () {
        const trimmed = ref.trim();
        const rows = yield* selectBacklogs(sql`id = ${trimmed} OR key = ${trimmed.toUpperCase()}`);
        const backlog = rows.find((row) => row.id === trimmed) ?? rows[0];
        if (backlog === undefined) return yield* notFound(`Backlog ${trimmed} not found.`);
        return backlog;
      }).pipe(backlogErrorsOnly);

    const ensureProjectBacklog: BacklogService["Service"]["ensureProjectBacklog"] = (projectId) =>
      Effect.gen(function* () {
        const existing = yield* selectBacklogs(sql`project_id = ${projectId}`);
        if (existing[0] !== undefined) return existing[0];
        // Read the project before the transaction: the project service has its
        // own storage and must not run inside this one.
        const project = yield* projects.getShell(projectId);
        if (Option.isNone(project)) return yield* notFound("Project not found.");
        const repositoryKey = project.value.repositoryIdentity?.canonicalKey ?? null;
        const base = deriveBacklogKey(project.value.title);
        const id = yield* newId;
        return yield* mutate((touched) =>
          Effect.gen(function* () {
            // One board per repository: a second project for the same
            // repository shares the first one's backlog.
            const raced = yield* selectBacklogs(
              repositoryKey === null
                ? sql`project_id = ${projectId}`
                : sql`project_id = ${projectId} OR repository_key = ${repositoryKey}`,
            );
            if (raced[0] !== undefined) return raced[0];
            const taken = new Set(
              (yield* sql<{ key: string }>`SELECT key FROM backlogs`).map((row) => row.key),
            );
            let key = base;
            for (let suffix = 2; taken.has(key); suffix++) {
              const digits = String(suffix);
              key = `${base.slice(0, 10 - digits.length)}${digits}`;
            }
            const at = DateTime.formatIso(yield* now);
            yield* sql`INSERT INTO backlogs ${sql.insert({
              id,
              kind: "project",
              key,
              title: project.value.title,
              project_id: projectId,
              repository_key: repositoryKey,
              next_number: 1,
              created_at: at,
              updated_at: at,
            })}`;
            touched.backlogs.add(id);
            return yield* loadBacklog(id);
          }),
        );
      }).pipe(backlogErrorsOnly);

    const updateBacklog: BacklogService["Service"]["updateBacklog"] = (input, _actor) =>
      mutate((touched) =>
        Effect.gen(function* () {
          const backlog = yield* loadBacklog(input.backlogId);
          const key = input.key ?? backlog.key;
          const title = input.title ?? backlog.title;
          if (key === backlog.key && title === backlog.title) return backlog;
          if (key !== backlog.key) {
            const clash =
              yield* sql`SELECT 1 FROM backlogs WHERE key = ${key} AND id <> ${backlog.id}`;
            if (clash.length > 0) return yield* conflict(`The key ${key} is already in use.`);
            // Issue keys derive from the backlog key, so every row changes.
            const issueIds = yield* sql<{ id: string }>`
              SELECT id FROM backlog_issues WHERE backlog_id = ${backlog.id}
            `;
            for (const row of issueIds) touched.issues.add(row.id);
          }
          const at = DateTime.formatIso(yield* now);
          yield* sql`
            UPDATE backlogs SET key = ${key}, title = ${title}, updated_at = ${at}
            WHERE id = ${backlog.id}
          `;
          touched.backlogs.add(backlog.id);
          return yield* loadBacklog(backlog.id);
        }),
      ).pipe(backlogErrorsOnly);

    const listIssues: BacklogService["Service"]["listIssues"] = (filters = {}) =>
      selectIssues(sql.and(filterClauses(filters))).pipe(backlogErrorsOnly);

    const getIssue: BacklogService["Service"]["getIssue"] = ({ issueId }) =>
      Effect.gen(function* () {
        const issue = yield* loadIssue(issueId);
        const parentIssue = issue.parentId === null ? null : yield* findIssue(issue.parentId);
        const activityRows = yield* sql<ActivityRow>`
          SELECT * FROM backlog_activity WHERE issue_id = ${issueId} ORDER BY at, rowid
        `;
        return {
          issue,
          body: yield* selectBody(issueId),
          parent:
            parentIssue === null
              ? null
              : { issue: parentIssue, body: yield* selectBody(parentIssue.id) },
          children: yield* selectIssues(sql`i.parent_id = ${issueId}`),
          blockers:
            issue.blockedBy.length === 0
              ? []
              : yield* selectIssues(sql.in("i.id", issue.blockedBy)),
          activity: yield* Effect.forEach(activityRows, decodeActivityRow),
        } satisfies BacklogIssueDetail;
      }).pipe(backlogErrorsOnly);

    const resolveIssueRef: BacklogService["Service"]["resolveIssueRef"] = (ref) =>
      Effect.gen(function* () {
        const parsed = parseBacklogIssueKey(ref);
        const rows =
          parsed === null
            ? yield* sql<{ id: string }>`SELECT id FROM backlog_issues WHERE id = ${ref.trim()}`
            : yield* sql<{ id: string }>`
                SELECT i.id FROM backlog_issues i JOIN backlogs b ON b.id = i.backlog_id
                WHERE b.key = ${parsed.backlogKey} AND i.number = ${parsed.number}
                UNION ALL
                SELECT id FROM backlog_issues WHERE id = ${ref.trim()}
              `;
        if (rows[0] === undefined) return yield* notFound(`Issue ${ref.trim()} not found.`);
        return rows[0].id as BacklogIssueId;
      }).pipe(backlogErrorsOnly);

    const createIssue: BacklogService["Service"]["createIssue"] = (input, actor) =>
      Effect.gen(function* () {
        const backlog =
          input.backlogId !== undefined
            ? yield* loadBacklog(input.backlogId)
            : input.projectId !== undefined
              ? yield* ensureProjectBacklog(input.projectId)
              : yield* inbox;
        const id = yield* mutate((touched) =>
          Effect.gen(function* () {
            const at = DateTime.formatIso(yield* now);
            const id = yield* insertIssue(backlog, input, actor, at, touched);
            if (input.blockedBy !== undefined) yield* replaceBlockers(id, input.blockedBy);
            return id;
          }),
        );
        return yield* loadIssue(id);
      }).pipe(backlogErrorsOnly);

    const createChildren: BacklogService["Service"]["createChildren"] = (
      { parentId, children },
      actor,
    ) =>
      Effect.gen(function* () {
        const ids = yield* mutate((touched) =>
          Effect.gen(function* () {
            const parent = yield* loadIssue(parentId);
            const backlog = yield* loadBacklog(parent.backlogId);
            const at = DateTime.formatIso(yield* now);
            const ids: BacklogIssueId[] = [];
            for (const child of children) {
              ids.push(yield* insertIssue(backlog, { ...child, parentId }, actor, at, touched));
            }
            // Edges go in after every sibling exists, one issue at a time, so
            // each insert is cycle-checked against the edges before it.
            for (const [index, child] of children.entries()) {
              const siblings: BacklogIssueId[] = [];
              for (const sibling of child.blockedBySiblings ?? []) {
                const siblingId = ids[sibling];
                if (siblingId === undefined || sibling === index) {
                  return yield* invalid(
                    `Child ${index} lists sibling ${sibling}, which is not another child in this batch.`,
                  );
                }
                siblings.push(siblingId);
              }
              const blockers = [...siblings, ...(child.blockedBy ?? [])];
              if (blockers.length > 0) yield* replaceBlockers(ids[index]!, blockers);
            }
            return ids;
          }),
        );
        return yield* selectIssues(sql.in("i.id", ids)).pipe(
          Effect.map((issues) => ids.flatMap((id) => issues.filter((issue) => issue.id === id))),
        );
      }).pipe(backlogErrorsOnly);

    const updateIssue: BacklogService["Service"]["updateIssue"] = (input, actor) =>
      Effect.gen(function* () {
        // A project target resolves (and may create its backlog) before the
        // update's own transaction; backlogId wins when both are given.
        const targetId =
          input.backlogId ??
          (input.projectId === undefined
            ? undefined
            : (yield* ensureProjectBacklog(input.projectId)).id);
        const id = yield* mutate((touched) =>
          Effect.gen(function* () {
            const issue = yield* loadIssue(input.issueId);
            const at = DateTime.formatIso(yield* now);
            const target =
              targetId === undefined || targetId === issue.backlogId
                ? null
                : yield* loadBacklog(targetId);

            if (target !== null) {
              const children =
                yield* sql`SELECT 1 FROM backlog_issues WHERE parent_id = ${issue.id}`;
              if (children.length > 0) {
                return yield* invalid("Move or detach this issue's children first.", issue.id);
              }
            }
            const backlogId = target?.id ?? issue.backlogId;
            // A move drops a parent left behind in the old backlog.
            const parentId =
              input.parentId !== undefined
                ? input.parentId
                : target !== null
                  ? null
                  : issue.parentId;
            const status =
              input.status ??
              (target?.kind === "project" && issue.status === "inbox" ? "backlog" : issue.status);
            const statusChanged = status !== issue.status;

            if (statusChanged && issue.claim !== null && actor.kind === "agent") {
              if (!isHolder(issue.claim.actor, actor)) {
                return yield* conflict(
                  `${issue.key} is claimed by ${issue.claim.actor.label}; only the holder or a user can change its status.`,
                  issue.id,
                );
              }
            }
            if (parentId !== issue.parentId || (target !== null && parentId !== null)) {
              if (parentId !== null) yield* validateParent(issue.id, parentId, backlogId);
            }
            if (statusChanged) yield* assertParentMayClose(issue, status);

            const edited: string[] = [];
            if (input.title !== undefined && input.title !== issue.title) edited.push("title");
            if (input.body !== undefined && input.body !== (yield* selectBody(issue.id))) {
              edited.push("body");
            }
            if (input.type !== undefined && input.type !== issue.type) edited.push("type");
            if (input.priority !== undefined && input.priority !== issue.priority) {
              edited.push("priority");
            }
            if (parentId !== issue.parentId) edited.push("parent");
            if (input.blockedBy !== undefined) {
              const next = new Set(input.blockedBy);
              if (
                next.size !== issue.blockedBy.length ||
                issue.blockedBy.some((b) => !next.has(b))
              ) {
                edited.push("blockers");
                yield* replaceBlockers(issue.id, input.blockedBy);
              }
            }
            if (edited.length === 0 && !statusChanged && target === null) return issue.id;

            const number = target === null ? issue.number : yield* takeNumber(target.id);
            yield* sql`
              UPDATE backlog_issues
              SET backlog_id = ${backlogId},
                  number = ${number},
                  title = ${input.title ?? issue.title},
                  type = ${input.type ?? issue.type},
                  priority = ${input.priority !== undefined ? input.priority : issue.priority},
                  parent_id = ${parentId},
                  updated_at = ${at}
              WHERE id = ${issue.id}
            `;
            if (input.body !== undefined) {
              yield* sql`UPDATE backlog_issues SET body = ${input.body} WHERE id = ${issue.id}`;
            }
            if (edited.length > 0) {
              yield* recordActivity({
                issueId: issue.id,
                kind: "edited",
                actor,
                at,
                text: `Edited ${edited.join(", ")}`,
              });
            }
            if (target !== null) {
              yield* recordActivity({
                issueId: issue.id,
                kind: "moved",
                actor,
                at,
                text: `Moved from ${issue.key} to ${target.key}-${number}`,
              });
            }
            if (statusChanged) {
              // Changing the column ends the claim: a user overrides it, and the
              // holder moving its own issue is done holding it.
              if (issue.claim !== null) {
                yield* clearClaim(issue.id);
                yield* recordActivity({
                  issueId: issue.id,
                  kind: "released",
                  actor,
                  at,
                  text: `Released the claim held by ${issue.claim.actor.label}`,
                });
              }
              yield* setStatus(issue, status, at);
              yield* recordActivity({
                issueId: issue.id,
                kind: "status_changed",
                actor,
                at,
                fromStatus: issue.status,
                toStatus: status,
              });
            }
            touched.issues.add(issue.id);
            return issue.id;
          }),
        );
        return yield* loadIssue(id);
      }).pipe(backlogErrorsOnly);

    const comment: BacklogService["Service"]["comment"] = (input, actor) =>
      Effect.gen(function* () {
        const activityId = yield* mutate((touched) =>
          Effect.gen(function* () {
            yield* loadIssue(input.issueId);
            const at = DateTime.formatIso(yield* now);
            const id = yield* recordActivity({
              issueId: input.issueId,
              kind: "commented",
              actor,
              at,
              text: input.text,
            });
            // Bumping the row tells subscribers the detail changed.
            yield* touchIssue(input.issueId, at, touched);
            return id;
          }),
        );
        const rows =
          yield* sql<ActivityRow>`SELECT * FROM backlog_activity WHERE id = ${activityId}`;
        return yield* decodeActivityRow(rows[0]!);
      }).pipe(backlogErrorsOnly);

    const claim: BacklogService["Service"]["claim"] = ({ issueId }, actor) =>
      mutate((touched) => claimInTransaction(issueId, actor, touched)).pipe(
        Effect.andThen(getIssue({ issueId })),
        backlogErrorsOnly,
      );

    const claimNext: BacklogService["Service"]["claimNext"] = (filters, actor) =>
      Effect.gen(function* () {
        const claimed = yield* mutate((touched) =>
          Effect.gen(function* () {
            const frontier = yield* selectIssues(
              sql.and(filterClauses({ ...filters, frontierOnly: true })),
            );
            const next = [...frontier].sort(compareBacklogIssuesForClaim)[0];
            if (next === undefined) return null;
            yield* claimInTransaction(next.id, actor, touched);
            return next.id;
          }),
        );
        return claimed === null ? null : yield* getIssue({ issueId: claimed });
      }).pipe(backlogErrorsOnly);

    const release: BacklogService["Service"]["release"] = (input, actor) =>
      Effect.gen(function* () {
        yield* mutate((touched) =>
          Effect.gen(function* () {
            const issue = yield* loadIssue(input.issueId);
            if (issue.claim === null)
              return yield* conflict(`${issue.key} is not claimed.`, issue.id);
            const holder = isHolder(issue.claim.actor, actor);
            const forced = actor.kind === "user";
            if (!holder && !forced) {
              return yield* conflict(
                `${issue.key} is claimed by ${issue.claim.actor.label}; only the holder can release it.`,
                issue.id,
              );
            }
            yield* assertParentMayClose(issue, input.status);
            const at = DateTime.formatIso(yield* now);
            yield* clearClaim(issue.id);
            yield* setStatus(issue, input.status, at);
            yield* sql`UPDATE backlog_issues SET updated_at = ${at} WHERE id = ${issue.id}`;
            const note = input.note?.trim() ?? "";
            yield* recordActivity({
              issueId: issue.id,
              kind: "released",
              actor,
              at,
              text:
                note.length > 0
                  ? note
                  : holder
                    ? null
                    : `Force-released the claim held by ${issue.claim.actor.label}`,
              fromStatus: issue.status,
              toStatus: input.status,
            });
            touched.issues.add(issue.id);
          }),
        );
        return yield* loadIssue(input.issueId);
      }).pipe(backlogErrorsOnly);

    const renewClaims: BacklogService["Service"]["renewClaims"] = (input) =>
      Effect.gen(function* () {
        yield* renewLeases(input.environmentId, input.threadIds, yield* now);
      }).pipe(backlogErrorsOnly);

    const addLink: BacklogService["Service"]["addLink"] = ({ issueId, link }, actor) =>
      Effect.gen(function* () {
        yield* mutate((touched) =>
          Effect.gen(function* () {
            const issue = yield* loadIssue(issueId);
            yield* appendLink(issue, link, actor, DateTime.formatIso(yield* now), touched);
          }),
        );
        return yield* loadIssue(issueId);
      }).pipe(backlogErrorsOnly);

    const linkPullRequestToClaims: BacklogService["Service"]["linkPullRequestToClaims"] = (
      { url },
      actor,
    ) =>
      Effect.gen(function* () {
        if (actor.threadId === null) return [];
        const ids = yield* mutate((touched) =>
          Effect.gen(function* () {
            const held = yield* selectIssues(
              sql`i.claim_actor_json IS NOT NULL AND i.claim_thread_id = ${actor.threadId}
                AND i.claim_environment_id IS ${actor.environmentId}`,
            );
            const at = DateTime.formatIso(yield* now);
            for (const issue of held) {
              yield* appendLink(issue, { type: "pull_request", url }, actor, at, touched);
            }
            return held.map((issue) => issue.id);
          }),
        );
        return ids.length === 0 ? [] : yield* selectIssues(sql.in("i.id", ids));
      }).pipe(backlogErrorsOnly);

    const subscribe: BacklogService["Service"]["subscribe"] = () =>
      Stream.unwrap(
        Effect.gen(function* () {
          // Subscribe before taking the snapshot so a change landing between
          // the two is buffered by the subscription rather than dropped.
          const subscription = yield* PubSub.subscribe(events);
          const snapshot = Effect.all({
            backlogs: listBacklogs(),
            issues: selectIssues(null).pipe(backlogErrorsOnly),
          }).pipe(Effect.map((board): BacklogStreamEvent => ({ type: "snapshot", ...board })));
          return Stream.concat(Stream.fromEffect(snapshot), Stream.fromSubscription(subscription));
        }),
      );

    /**
     * Renews leases whose holder thread is running on this environment and
     * expires the rest once their deadline passes. Holders on other
     * environments keep their lease only by calling backlog tools, which renew.
     */
    const keepLeases = Effect.gen(function* () {
      const claimed = yield* sql<{ claim_thread_id: string | null }>`
        SELECT DISTINCT claim_thread_id FROM backlog_issues WHERE claim_actor_json IS NOT NULL
      `;
      const live: string[] = [];
      for (const { claim_thread_id: threadId } of claimed) {
        if (threadId === null) continue;
        const shell = yield* threads
          .getThreadShell(threadId as ThreadId)
          .pipe(Effect.orElseSucceed(() => null));
        if (
          shell !== null &&
          shell.deletedAt === null &&
          shell.archivedAt === null &&
          shell.activeRunId !== null
        ) {
          live.push(threadId);
        }
      }
      yield* mutate((touched) =>
        Effect.gen(function* () {
          const current = yield* now;
          const at = DateTime.formatIso(current);
          if (live.length > 0) {
            const renewed = yield* sql<{ id: string }>`
              UPDATE backlog_issues
              SET lease_expires_at = ${DateTime.formatIso(
                DateTime.add(current, { milliseconds: BACKLOG_CLAIM_LEASE_MS }),
              )}
              WHERE claim_actor_json IS NOT NULL AND ${sql.in("claim_thread_id", live)}
              RETURNING id
            `;
            for (const row of renewed) touched.issues.add(row.id);
          }
          const expired = yield* sql<{ id: string; status: string }>`
            SELECT id, status FROM backlog_issues
            WHERE claim_actor_json IS NOT NULL AND lease_expires_at <= ${at}
          `;
          for (const row of expired) {
            yield* clearClaim(row.id);
            yield* sql`
              UPDATE backlog_issues SET status = 'ready', closed_at = NULL, updated_at = ${at}
              WHERE id = ${row.id}
            `;
            yield* recordActivity({
              issueId: row.id,
              kind: "lease_expired",
              actor: LEASE_KEEPER_ACTOR,
              at,
              text: "The claim's lease expired; the issue is ready again.",
              fromStatus: row.status as BacklogIssueStatus,
              toStatus: "ready",
            });
            touched.issues.add(row.id);
          }
        }),
      );
    });

    yield* forkParked(
      Effect.sleep(LEASE_KEEPER_INTERVAL).pipe(
        Effect.andThen(
          keepLeases.pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("Backlog lease keeper failed", { cause }),
            ),
          ),
        ),
        Effect.forever,
      ),
    );

    return BacklogService.of({
      listBacklogs,
      resolveBacklogRef,
      ensureProjectBacklog,
      updateBacklog,
      listIssues,
      getIssue,
      resolveIssueRef,
      createIssue,
      createChildren,
      updateIssue,
      comment,
      claim,
      claimNext,
      release,
      renewClaims,
      addLink,
      linkPullRequestToClaims,
      subscribe,
    });
  }),
);
