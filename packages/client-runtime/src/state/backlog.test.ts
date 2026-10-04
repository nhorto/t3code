import { BacklogId, BacklogIssueId, type Backlog, type BacklogIssue } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { describe, expect, it } from "vite-plus/test";

import {
  EMPTY_BACKLOG_BOARD,
  claimTakeoverMessage,
  foldBacklogStreamEvent,
  groupBacklogIssuesByStatus,
  isBacklogUnsupportedCause,
  isIssueBlockedOnBoard,
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
