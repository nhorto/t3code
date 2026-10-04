import { describe, expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import {
  BacklogKey,
  compareBacklogIssuesForClaim,
  deriveBacklogKey,
  isBacklogIssueBlocked,
  isBacklogIssueOnFrontier,
  parseBacklogIssueKey,
  type BacklogIssueStatus,
} from "./backlog.ts";
import { BacklogIssueId } from "./baseSchemas.ts";

const id = (value: string) => BacklogIssueId.make(value);
const statuses = (entries: Record<string, BacklogIssueStatus>) =>
  new Map(Object.entries(entries).map(([key, status]) => [id(key), { status }]));

describe("deriveBacklogKey", () => {
  it("uses initials for multi-word titles and the word for single words", () => {
    expect(deriveBacklogKey("Cork & Note")).toBe("CN");
    expect(deriveBacklogKey("NASCAR Pit Stop")).toBe("NPS");
    expect(deriveBacklogKey("wine")).toBe("WINE");
    expect(deriveBacklogKey("t3code")).toBe("T3CODE");
  });

  it("always yields a valid key", () => {
    for (const title of ["", "123", "a", "fripp-island", "Über app", "x".repeat(40)]) {
      expect(Schema.is(BacklogKey)(deriveBacklogKey(title))).toBe(true);
    }
  });
});

describe("parseBacklogIssueKey", () => {
  it("parses keys case-insensitively", () => {
    expect(parseBacklogIssueKey("wine-12")).toEqual({ backlogKey: "WINE", number: 12 });
    expect(parseBacklogIssueKey(" CN-3 ")).toEqual({ backlogKey: "CN", number: 3 });
  });

  it("rejects ids and malformed keys", () => {
    expect(parseBacklogIssueKey("WINE-0")).toBeNull();
    expect(parseBacklogIssueKey("WINE12")).toBeNull();
    expect(parseBacklogIssueKey("3f2a-12-xyz")).toBeNull();
  });
});

describe("blocked and frontier", () => {
  it("is blocked while any blocker is open or unknown", () => {
    const board = statuses({ a: "done", b: "in_progress" });
    expect(isBacklogIssueBlocked({ blockedBy: [id("a")] }, board)).toBe(false);
    expect(isBacklogIssueBlocked({ blockedBy: [id("a"), id("b")] }, board)).toBe(true);
    expect(isBacklogIssueBlocked({ blockedBy: [id("missing")] }, board)).toBe(true);
  });

  it("puts only ready, unblocked, unclaimed issues on the frontier", () => {
    const board = statuses({ open: "ready", closed: "wontfix" });
    const ready = { status: "ready" as const, blockedBy: [id("closed")], claim: null };
    expect(isBacklogIssueOnFrontier(ready, board)).toBe(true);
    expect(isBacklogIssueOnFrontier({ ...ready, status: "backlog" }, board)).toBe(false);
    expect(isBacklogIssueOnFrontier({ ...ready, blockedBy: [id("open")] }, board)).toBe(false);
  });
});

describe("compareBacklogIssuesForClaim", () => {
  it("orders by priority, unprioritized last, then oldest", () => {
    const issues = [
      { name: "none-old", priority: null, createdAt: "2026-01-01T00:00:00.000Z", number: 1 },
      { name: "p2-new", priority: "p2" as const, createdAt: "2026-03-01T00:00:00.000Z", number: 4 },
      { name: "p0", priority: "p0" as const, createdAt: "2026-05-01T00:00:00.000Z", number: 5 },
      { name: "p2-old", priority: "p2" as const, createdAt: "2026-02-01T00:00:00.000Z", number: 3 },
    ];
    expect(issues.toSorted(compareBacklogIssuesForClaim).map((issue) => issue.name)).toEqual([
      "p0",
      "p2-old",
      "p2-new",
      "none-old",
    ]);
  });
});
