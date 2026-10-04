import {
  BacklogId,
  BacklogIssueId,
  EnvironmentId,
  type Backlog,
  type BacklogIssue,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { describe, expect, it } from "vite-plus/test";

import {
  BACKLOG_CACHE_MAX_ISSUES,
  EMPTY_BACKLOG_BOARD,
  backlogBoardForCache,
  backlogBoardFromCache,
  backlogFleet,
  claimTakeoverMessage,
  foldBacklogStreamEvent,
  groupBacklogIssuesByStatus,
  isBacklogUnsupportedCause,
  isIssueBlockedOnBoard,
  legacyBacklogInbox,
} from "./backlog.ts";

const backlog: Backlog = {
  id: BacklogId.make("backlog-wine"),
  kind: "project",
  key: "WINE",
  title: "Cork & Note",
  projectId: null,
  repositoryKey: null,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

function issue(id: string, overrides: Partial<BacklogIssue> = {}): BacklogIssue {
  return {
    id: BacklogIssueId.make(id),
    backlogId: backlog.id,
    number: 1,
    key: "WINE-1",
    title: "Paywall crashes on iPad",
    type: "bug",
    status: "backlog",
    priority: null,
    parentId: null,
    blockedBy: [],
    claim: null,
    links: [],
    hasBody: false,
    createdBy: { kind: "user", environmentId: null, threadId: null, label: "Nick" },
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    closedAt: null,
    ...overrides,
  };
}

describe("foldBacklogStreamEvent", () => {
  it("replaces everything with a snapshot", () => {
    const stale = foldBacklogStreamEvent(EMPTY_BACKLOG_BOARD, {
      type: "issueUpserted",
      issue: issue("old"),
    });
    const state = foldBacklogStreamEvent(stale, {
      type: "snapshot",
      backlogs: [backlog],
      issues: [issue("a")],
    });
    expect(state.backlogs).toEqual([backlog]);
    expect(state.issues.map((entry) => entry.id)).toEqual(["a"]);
    expect(state.issuesById.has(BacklogIssueId.make("old"))).toBe(false);
  });

  it("updates an issue in place and appends a new one", () => {
    const start = foldBacklogStreamEvent(EMPTY_BACKLOG_BOARD, {
      type: "snapshot",
      backlogs: [backlog],
      issues: [issue("a"), issue("b")],
    });
    const moved = foldBacklogStreamEvent(start, {
      type: "issueUpserted",
      issue: issue("a", { status: "ready" }),
    });
    expect(moved.issues.map((entry) => [entry.id, entry.status])).toEqual([
      ["a", "ready"],
      ["b", "backlog"],
    ]);
    expect(moved.issuesById.get(BacklogIssueId.make("a"))?.status).toBe("ready");
    // Untouched rows and backlogs keep their identity, so memoized cards do not re-render.
    expect(moved.issues[1]).toBe(start.issues[1]);
    expect(moved.backlogs).toBe(start.backlogs);

    const added = foldBacklogStreamEvent(moved, { type: "issueUpserted", issue: issue("c") });
    expect(added.issues.map((entry) => entry.id)).toEqual(["a", "b", "c"]);
  });

  it("upserts backlogs, so a renamed key replaces the old one", () => {
    const start = foldBacklogStreamEvent(EMPTY_BACKLOG_BOARD, {
      type: "snapshot",
      backlogs: [backlog],
      issues: [],
    });
    const renamed = foldBacklogStreamEvent(start, {
      type: "backlogUpserted",
      backlog: { ...backlog, key: "CN" },
    });
    expect(renamed.backlogs.map((entry) => entry.key)).toEqual(["CN"]);
    expect(renamed.issues).toBe(start.issues);
  });
});

describe("groupBacklogIssuesByStatus", () => {
  it("puts every status in a column, most recently updated first", () => {
    const groups = groupBacklogIssuesByStatus([
      issue("older", { status: "ready", updatedAt: "2026-01-01T00:00:00.000Z", number: 1 }),
      issue("newer", { status: "ready", updatedAt: "2026-01-02T00:00:00.000Z", number: 2 }),
      issue("tie-low", { status: "done", number: 3 }),
      issue("tie-high", { status: "done", number: 4 }),
    ]);
    expect([...groups.keys()]).toEqual([
      "inbox",
      "backlog",
      "ready",
      "in_progress",
      "review",
      "done",
      "wontfix",
    ]);
    expect(groups.get("ready")?.map((entry) => entry.id)).toEqual(["newer", "older"]);
    expect(groups.get("done")?.map((entry) => entry.id)).toEqual(["tie-high", "tie-low"]);
    expect(groups.get("inbox")).toEqual([]);
  });
});

describe("isIssueBlockedOnBoard", () => {
  it("is blocked until every blocker is closed", () => {
    const blocker = issue("blocker", { status: "in_progress" });
    const blocked = issue("blocked", { blockedBy: [blocker.id] });
    const open = foldBacklogStreamEvent(EMPTY_BACKLOG_BOARD, {
      type: "snapshot",
      backlogs: [backlog],
      issues: [blocker, blocked],
    });
    expect(isIssueBlockedOnBoard(open, blocked)).toBe(true);
    const closed = foldBacklogStreamEvent(open, {
      type: "issueUpserted",
      issue: { ...blocker, status: "wontfix" },
    });
    expect(isIssueBlockedOnBoard(closed, blocked)).toBe(false);
  });
});

describe("isBacklogUnsupportedCause", () => {
  it("reads a server without the backlog RPCs as unsupported, not broken", () => {
    expect(isBacklogUnsupportedCause(Cause.die("Unknown request tag: backlog.subscribe"))).toBe(
      true,
    );
    expect(
      isBacklogUnsupportedCause(Cause.die(new Error("Unknown request tag: backlog.subscribe"))),
    ).toBe(true);
  });

  it("keeps real failures as failures", () => {
    expect(isBacklogUnsupportedCause(Cause.die("Unknown request tag: git.status"))).toBe(false);
    expect(isBacklogUnsupportedCause(Cause.die(new Error("database is locked")))).toBe(false);
    expect(isBacklogUnsupportedCause(Cause.fail("Unknown request tag: backlog.subscribe"))).toBe(
      false,
    );
  });
});

describe("claims", () => {
  it("asks before taking a claimed issue from its agent", () => {
    expect(claimTakeoverMessage(issue("free", { key: "WINE-12" }))).toBeNull();
    expect(
      claimTakeoverMessage(
        issue("held", {
          key: "WINE-12",
          claim: {
            actor: { kind: "agent", environmentId: null, threadId: null, label: "Claude" },
            claimedAt: "2026-01-01T00:00:00.000Z",
            leaseExpiresAt: "2026-01-01T00:15:00.000Z",
          },
        }),
      ),
    ).toBe("This takes WINE-12 away from Claude. Continue?");
  });
});

describe("the offline copy of a board", () => {
  const geekom = EnvironmentId.make("environment-geekom");
  const nowMs = Date.parse("2026-10-04T12:00:00.000Z");

  it("keeps open work and recent history, but not issues closed over 30 days ago", () => {
    const board = foldBacklogStreamEvent(EMPTY_BACKLOG_BOARD, {
      type: "snapshot",
      backlogs: [backlog],
      issues: [
        issue("open"),
        issue("closed-last-week", { status: "done", closedAt: "2026-09-27T12:00:00.000Z" }),
        issue("closed-in-july", { status: "wontfix", closedAt: "2026-07-01T12:00:00.000Z" }),
      ],
    });
    const stored = backlogBoardForCache(
      geekom,
      { ...board, asOf: "2026-10-04T11:59:00.000Z" },
      nowMs,
    );
    expect(stored.issues.map((entry) => entry.id)).toEqual(["open", "closed-last-week"]);
    expect(stored.backlogs).toEqual([backlog]);
    expect(stored.asOf).toBe("2026-10-04T11:59:00.000Z");

    const restored = backlogBoardFromCache(stored);
    expect(restored.fromCache).toBe(true);
    expect(restored.asOf).toBe(stored.asOf);
    expect(restored.issuesById.get(BacklogIssueId.make("open"))?.title).toBe(
      "Paywall crashes on iPad",
    );
  });

  it("caps the copy at the most recently updated issues", () => {
    const issues = Array.from({ length: BACKLOG_CACHE_MAX_ISSUES + 5 }, (_, index) =>
      issue(`issue-${index}`, {
        updatedAt: `2026-01-01T${String(Math.floor(index / 60)).padStart(2, "0")}:${String(index % 60).padStart(2, "0")}:00.000Z`,
      }),
    );
    const board = foldBacklogStreamEvent(EMPTY_BACKLOG_BOARD, {
      type: "snapshot",
      backlogs: [backlog],
      issues,
    });
    const stored = backlogBoardForCache(geekom, board, nowMs);
    expect(stored.issues).toHaveLength(BACKLOG_CACHE_MAX_ISSUES);
    expect(stored.issues.some((entry) => entry.id === "issue-0")).toBe(false);
    expect(
      stored.issues.some((entry) => entry.id === `issue-${BACKLOG_CACHE_MAX_ISSUES + 4}`),
    ).toBe(true);
  });
});

describe("one Inbox per fleet", () => {
  const geekom = { environmentId: EnvironmentId.make("environment-geekom"), label: "Geekom" };
  const mac = EnvironmentId.make("environment-mac");
  const laptop = EnvironmentId.make("environment-laptop");
  const inbox: Backlog = {
    ...backlog,
    id: BacklogId.make("backlog-inbox"),
    kind: "inbox",
    key: "INBOX",
    title: "Inbox",
  };

  it("keeps the hub an environment is linked to from snapshots and the offline copy", () => {
    const linked = foldBacklogStreamEvent(EMPTY_BACKLOG_BOARD, {
      type: "snapshot",
      backlogs: [],
      issues: [],
      linkedHub: geekom,
    });
    const updated = foldBacklogStreamEvent(linked, { type: "backlogUpserted", backlog });
    expect(updated.linkedHub).toEqual(geekom);
    const restored = backlogBoardFromCache(backlogBoardForCache(mac, updated, 1_767_312_000_000));
    expect(restored.linkedHub).toEqual(geekom);
    // A server that predates the field reads as unlinked.
    expect(
      foldBacklogStreamEvent(linked, { type: "snapshot", backlogs: [], issues: [] }).linkedHub,
    ).toBeNull();
  });

  it("finds the hub and the environments linked to it, preferring a hub this client sees", () => {
    const other = {
      environmentId: EnvironmentId.make("environment-elsewhere"),
      label: "Elsewhere",
    };
    const fleet = backlogFleet([
      { environmentId: laptop, board: { linkedHub: other } },
      { environmentId: mac, board: { linkedHub: geekom } },
      { environmentId: geekom.environmentId, board: { linkedHub: null } },
    ]);
    expect(fleet?.hub).toEqual(geekom);
    expect([...(fleet?.spokeEnvironmentIds ?? [])]).toEqual([mac]);
    expect(backlogFleet([{ environmentId: mac, board: { linkedHub: null } }])).toBeNull();
  });

  it("calls a linked environment's own Inbox legacy and counts what is still open", () => {
    const issues = [
      issue("open", { backlogId: inbox.id, status: "inbox" }),
      issue("closed", { backlogId: inbox.id, status: "wontfix" }),
      issue("project"),
    ];
    const legacy = legacyBacklogInbox({ backlogs: [inbox, backlog], issues, linkedHub: geekom });
    expect(legacy).toEqual({ backlog: inbox, hub: geekom, openCount: 1 });
    expect(legacyBacklogInbox({ backlogs: [inbox], issues, linkedHub: null })).toBeNull();
  });
});
