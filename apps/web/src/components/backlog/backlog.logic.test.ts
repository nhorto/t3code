import {
  BacklogId,
  BacklogIssueId,
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  type Backlog,
  type BacklogIssue,
} from "@t3tools/contracts";
import type { BacklogBoardState } from "@t3tools/client-runtime/state/backlog";
import { describe, expect, it } from "vite-plus/test";

import type { Project } from "../../types";
import {
  EMPTY_BACKLOG_FILTERS,
  backlogChildProgress,
  backlogEntryForProject,
  backlogMoveTargets,
  backlogScopeKey,
  blockerCandidates,
  buildBacklogColumns,
  buildBacklogSwitcher,
  creatableProjectIdsOn,
  describeBacklogActivity,
  matchesBacklogFilters,
  normalizeBacklogKeyInput,
  openBlockerKeys,
  pageBacklogColumn,
  parseBacklogScope,
  prunePendingBacklogMoves,
  resolveBacklogSourceStatus,
  sameBacklogSwitcherSources,
  type BacklogSource,
} from "./backlog.logic";

const mac = EnvironmentId.make("env-mac");
const geekom = EnvironmentId.make("env-geekom");
const groupingSettings = {
  sidebarProjectGroupingMode: "repository" as const,
  sidebarProjectGroupingOverrides: {},
};
const wineRepository = {
  canonicalKey: "github.com/nhorto/cork-and-note",
  locator: {
    source: "git-remote" as const,
    remoteName: "origin",
    remoteUrl: "https://github.com/nhorto/cork-and-note.git",
  },
};

function project(overrides: Partial<Project> = {}): Project {
  return {
    id: ProjectId.make("project-wine-mac"),
    environmentId: mac,
    title: "Cork & Note",
    workspaceRoot: "/Users/nick/cork-and-note",
    repositoryIdentity: wineRepository,
    defaultModelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5-codex" },
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    scripts: [],
    ...overrides,
  };
}

function backlog(overrides: Partial<Backlog> = {}): Backlog {
  return {
    id: BacklogId.make("backlog-inbox"),
    kind: "inbox",
    key: "INBOX",
    title: "Inbox",
    projectId: null,
    repositoryKey: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function issue(overrides: Omit<Partial<BacklogIssue>, "id"> & { id: string }): BacklogIssue {
  const { id, ...rest } = overrides;
  return {
    id: BacklogIssueId.make(id),
    backlogId: BacklogId.make("backlog-wine"),
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
    ...rest,
  };
}

function board(backlogs: Backlog[], issues: BacklogIssue[]): BacklogBoardState {
  return { backlogs, issues, issuesById: new Map(issues.map((entry) => [entry.id, entry])) };
}

function source(
  overrides: Partial<BacklogSource> & { environmentId: EnvironmentId },
): BacklogSource {
  return {
    label: overrides.environmentId === mac ? "MacBook" : "Geekom",
    isPrimary: overrides.environmentId === mac,
    status: "live",
    board: board([], []),
    error: null,
    ...overrides,
  };
}

const wineBacklog = backlog({
  id: BacklogId.make("backlog-wine"),
  kind: "project",
  key: "WINE",
  title: "Cork & Note",
  projectId: ProjectId.make("project-wine-geekom"),
  repositoryKey: wineRepository.canonicalKey,
});

describe("resolveBacklogSourceStatus", () => {
  it("never claims an empty board before the snapshot arrives", () => {
    expect(
      resolveBacklogSourceStatus({ connectionPhase: "connected", hasBoard: false, failed: false }),
    ).toBe("loading");
    expect(
      resolveBacklogSourceStatus({
        connectionPhase: "reconnecting",
        hasBoard: false,
        failed: false,
      }),
    ).toBe("loading");
  });

  it("keeps the last snapshot read-only while the machine is unreachable", () => {
    expect(
      resolveBacklogSourceStatus({ connectionPhase: "offline", hasBoard: true, failed: false }),
    ).toBe("stale");
    expect(
      resolveBacklogSourceStatus({ connectionPhase: "offline", hasBoard: false, failed: false }),
    ).toBe("unavailable");
  });

  it("reports a failed subscription on a connected machine", () => {
    expect(
      resolveBacklogSourceStatus({ connectionPhase: "connected", hasBoard: false, failed: true }),
    ).toBe("error");
  });
});

describe("backlog scope", () => {
  it("round-trips every scope through the URL", () => {
    for (const scope of [
      { kind: "all" } as const,
      { kind: "inbox" } as const,
      { kind: "project", projectKey: "github.com/nhorto/cork-and-note" } as const,
      { kind: "backlog", environmentId: mac, backlogId: BacklogId.make("backlog-x") } as const,
    ]) {
      expect(parseBacklogScope(backlogScopeKey(scope))).toEqual(scope);
    }
  });

  it("reads anything unrecognised as the whole fleet", () => {
    expect(parseBacklogScope(undefined)).toEqual({ kind: "all" });
    expect(parseBacklogScope("project:")).toEqual({ kind: "all" });
    expect(parseBacklogScope(42)).toEqual({ kind: "all" });
  });
});

describe("buildBacklogSwitcher", () => {
  it("serves a backlog homed on one machine to the same repository on another", () => {
    const entries = buildBacklogSwitcher({
      sources: [
        source({ environmentId: mac }),
        source({ environmentId: geekom, board: board([wineBacklog], []) }),
      ],
      projects: [project()],
      groupingSettings,
      primaryEnvironmentId: mac,
    });
    const wine = entries.find((entry) => entry.label === "Cork & Note");
    expect(wine?.backlogs.map((ref) => ref.environmentId)).toEqual([geekom]);
    // An existing backlog wins over creating a second one on the Mac.
    expect(wine?.createTarget).toEqual({ environmentId: geekom, backlogId: wineBacklog.id });
  });

  it("creates a project's first backlog on the project's own machine", () => {
    const entries = buildBacklogSwitcher({
      sources: [source({ environmentId: mac })],
      projects: [project()],
      groupingSettings,
      primaryEnvironmentId: mac,
    });
    const wine = entries.find((entry) => entry.label === "Cork & Note");
    expect(wine?.createTarget).toEqual({
      environmentId: mac,
      projectId: ProjectId.make("project-wine-mac"),
    });
  });

  it("merges every machine's Inbox and captures into the primary one", () => {
    const macInbox = backlog({ id: BacklogId.make("inbox-mac") });
    const geekomInbox = backlog({ id: BacklogId.make("inbox-geekom") });
    const entries = buildBacklogSwitcher({
      sources: [
        source({ environmentId: geekom, board: board([geekomInbox], []) }),
        source({ environmentId: mac, board: board([macInbox], []) }),
      ],
      projects: [],
      groupingSettings,
      primaryEnvironmentId: mac,
    });
    const inbox = entries.find((entry) => entry.key === "inbox");
    expect(inbox?.backlogs).toHaveLength(2);
    expect(inbox?.createTarget).toEqual({ environmentId: mac, backlogId: macInbox.id });
  });

  it("offers no create target while the only home is unreachable", () => {
    const entries = buildBacklogSwitcher({
      sources: [
        source({ environmentId: geekom, status: "stale", board: board([wineBacklog], []) }),
      ],
      projects: [project({ environmentId: geekom, id: ProjectId.make("project-wine-geekom") })],
      groupingSettings,
      primaryEnvironmentId: mac,
    });
    expect(entries.find((entry) => entry.label === "Cork & Note")?.createTarget).toBeNull();
  });

  describe("never splits a project across two backlogs", () => {
    // The Mac has a checkout; the Geekom has one too and may already hold the backlog.
    const projects = [
      project(),
      project({
        environmentId: geekom,
        id: ProjectId.make("project-wine-geekom"),
        workspaceRoot: "/srv/cork-and-note",
      }),
    ];
    const wineEntry = (geekomSource: BacklogSource) =>
      buildBacklogSwitcher({
        sources: [source({ environmentId: mac }), geekomSource],
        projects,
        groupingSettings,
        primaryEnvironmentId: mac,
      }).find((entry) => entry.label === "Cork & Note");

    it("waits while a machine with a checkout is still loading its board", () => {
      const wine = wineEntry(source({ environmentId: geekom, status: "loading", board: null }));
      expect(wine?.createTarget).toBeNull();
      expect(wine?.createBlockedReason).toBe("Loading Geekom…");
    });

    it("refuses while a machine with a checkout is offline and unseen", () => {
      const wine = wineEntry(source({ environmentId: geekom, status: "unavailable", board: null }));
      expect(wine?.createTarget).toBeNull();
      expect(wine?.createBlockedReason).toBe("Geekom may hold this backlog and is offline.");
    });

    it("names the offline machine that holds the backlog", () => {
      const wine = wineEntry(
        source({ environmentId: geekom, status: "stale", board: board([wineBacklog], []) }),
      );
      expect(wine?.createTarget).toBeNull();
      expect(wine?.createBlockedReason).toBe("Geekom holds this backlog and is offline.");
    });

    it("creates by project once every checkout has answered without one", () => {
      const wine = wineEntry(source({ environmentId: geekom }));
      expect(wine?.createTarget).toEqual({
        environmentId: mac,
        projectId: ProjectId.make("project-wine-mac"),
      });
      expect(wine?.createBlockedReason).toBeNull();
    });
  });

  it("says the Inbox is loading rather than unreachable", () => {
    const inbox = buildBacklogSwitcher({
      sources: [source({ environmentId: mac, status: "loading", board: null })],
      projects: [],
      groupingSettings,
      primaryEnvironmentId: mac,
    }).find((entry) => entry.key === "inbox");
    expect(inbox?.createTarget).toBeNull();
    expect(inbox?.createBlockedReason).toBe("Loading MacBook…");
  });

  it("counts open issues per entry", () => {
    const entries = buildBacklogSwitcher({
      sources: [
        source({
          environmentId: geekom,
          board: board(
            [wineBacklog],
            [
              issue({ id: "open" }),
              issue({ id: "ready", status: "ready" }),
              issue({ id: "shipped", status: "done" }),
            ],
          ),
        }),
      ],
      projects: [project({ environmentId: geekom, id: ProjectId.make("project-wine-geekom") })],
      groupingSettings,
      primaryEnvironmentId: mac,
    });
    expect(entries.find((entry) => entry.label === "Cork & Note")?.openCount).toBe(2);
    expect(entries.find((entry) => entry.key === "all")?.openCount).toBe(2);
  });

  it("rebuilds the grouping only when backlogs or connection state change", () => {
    const geekomBoard = board([wineBacklog], [issue({ id: "a" })]);
    const before = [source({ environmentId: geekom, board: geekomBoard })];
    // An issue delta keeps the backlogs array.
    const issueDelta = [
      source({
        environmentId: geekom,
        board: { ...geekomBoard, issues: [issue({ id: "a", status: "ready" })] },
      }),
    ];
    expect(sameBacklogSwitcherSources(before, issueDelta)).toBe(true);
    expect(
      sameBacklogSwitcherSources(before, [
        source({ environmentId: geekom, board: board([wineBacklog], []) }),
      ]),
    ).toBe(false);
    expect(
      sameBacklogSwitcherSources(before, [
        source({ environmentId: geekom, status: "stale", board: geekomBoard }),
      ]),
    ).toBe(false);
  });

  it("names machines only when two entries share a label", () => {
    const entries = buildBacklogSwitcher({
      sources: [source({ environmentId: mac }), source({ environmentId: geekom })],
      projects: [
        project({ id: ProjectId.make("a"), title: "web", repositoryIdentity: null }),
        project({
          id: ProjectId.make("b"),
          environmentId: geekom,
          title: "web",
          workspaceRoot: "/srv/web",
          repositoryIdentity: null,
        }),
        project({
          id: ProjectId.make("c"),
          title: "api",
          workspaceRoot: "/api",
          repositoryIdentity: null,
        }),
      ],
      groupingSettings,
      primaryEnvironmentId: mac,
    });
    expect(
      entries
        .filter((entry) => entry.scope.kind === "project")
        .map((entry) => [entry.label, entry.machineLabel]),
    ).toEqual([
      ["api", null],
      ["web", "MacBook"],
      ["web", "Geekom"],
    ]);
  });

  it("keeps a backlog whose project this client cannot see", () => {
    const entries = buildBacklogSwitcher({
      sources: [source({ environmentId: geekom, board: board([wineBacklog], []) })],
      projects: [],
      groupingSettings,
      primaryEnvironmentId: mac,
    });
    expect(entries.map((entry) => entry.key)).toContain(
      backlogScopeKey({ kind: "backlog", environmentId: geekom, backlogId: wineBacklog.id }),
    );
  });

  it("starts quick-add on the backlog of the project on screen, else the Inbox", () => {
    const entries = buildBacklogSwitcher({
      sources: [source({ environmentId: mac })],
      projects: [project()],
      groupingSettings,
      primaryEnvironmentId: mac,
    });
    expect(
      backlogEntryForProject(entries, {
        environmentId: mac,
        projectId: ProjectId.make("project-wine-mac"),
      })?.label,
    ).toBe("Cork & Note");
    expect(backlogEntryForProject(entries, null)?.key).toBe("inbox");
  });
});

describe("board columns", () => {
  const ready = (id: string, overrides: Partial<BacklogIssue> = {}) =>
    issue({ id, status: "ready", ...overrides });

  it("orders Ready the way an agent claims: priority, then oldest", () => {
    const issues = [
      ready("late-p1", { priority: "p1", createdAt: "2026-01-03T00:00:00.000Z", number: 3 }),
      ready("none", { createdAt: "2026-01-01T00:00:00.000Z", number: 1 }),
      ready("early-p1", { priority: "p1", createdAt: "2026-01-02T00:00:00.000Z", number: 2 }),
      ready("p0", { priority: "p0", createdAt: "2026-01-04T00:00:00.000Z", number: 4 }),
    ];
    const columns = buildBacklogColumns({
      sources: [source({ environmentId: mac, board: board([wineBacklog], issues) })],
      backlogs: [{ environmentId: mac, backlog: wineBacklog }],
      filters: EMPTY_BACKLOG_FILTERS,
      showWontfix: false,
      pendingMoves: new Map(),
    });
    expect(
      columns.find((column) => column.status === "ready")?.issues.map((item) => item.issue.id),
    ).toEqual(["p0", "early-p1", "late-p1", "none"]);
  });

  it("shows won't fix only when asked", () => {
    const issues = [issue({ id: "nope", status: "wontfix" })];
    const build = (showWontfix: boolean) =>
      buildBacklogColumns({
        sources: [source({ environmentId: mac, board: board([wineBacklog], issues) })],
        backlogs: [{ environmentId: mac, backlog: wineBacklog }],
        filters: EMPTY_BACKLOG_FILTERS,
        showWontfix,
        pendingMoves: new Map(),
      });
    expect(build(false).map((column) => column.status)).not.toContain("wontfix");
    expect(build(true).at(-1)?.issues).toHaveLength(1);
  });

  it("holds a dragged card in its new column until the server's row supersedes it", () => {
    const moved = issue({ id: "moved", status: "backlog", updatedAt: "2026-01-01T00:00:00.000Z" });
    const pendingMoves = new Map([
      [`${mac}:moved`, { status: "ready" as const, fromUpdatedAt: moved.updatedAt }],
    ]);
    const columnOf = (row: BacklogIssue) =>
      buildBacklogColumns({
        sources: [source({ environmentId: mac, board: board([wineBacklog], [row]) })],
        backlogs: [{ environmentId: mac, backlog: wineBacklog }],
        filters: EMPTY_BACKLOG_FILTERS,
        showWontfix: false,
        pendingMoves,
      }).find((column) => column.issues.length > 0)?.status;
    expect(columnOf(moved)).toBe("ready");
    // The server answered (say, it refused to close a parent): its row is the truth.
    expect(columnOf({ ...moved, updatedAt: "2026-01-01T00:00:01.000Z" })).toBe("backlog");
  });

  it("filters by type, priority, frontier and title or key", () => {
    const blocker = issue({ id: "blocker", key: "WINE-1", status: "ready" });
    const blocked = issue({
      id: "blocked",
      key: "WINE-2",
      title: "Ship the paywall",
      status: "ready",
      type: "feature",
      priority: "p1",
      blockedBy: [BacklogIssueId.make("blocker")],
    });
    const byId = new Map([blocker, blocked].map((entry) => [entry.id, entry]));
    const matches = (filters: Partial<typeof EMPTY_BACKLOG_FILTERS>, target: BacklogIssue) =>
      matchesBacklogFilters(target, { ...EMPTY_BACKLOG_FILTERS, ...filters }, byId);
    expect(matches({ types: ["feature"] }, blocked)).toBe(true);
    expect(matches({ types: ["bug"] }, blocked)).toBe(false);
    expect(matches({ priorities: ["none"] }, blocker)).toBe(true);
    expect(matches({ priorities: ["none"] }, blocked)).toBe(false);
    expect(matches({ frontierOnly: true }, blocker)).toBe(true);
    expect(matches({ frontierOnly: true }, blocked)).toBe(false);
    expect(matches({ query: "wine-2" }, blocked)).toBe(true);
    expect(matches({ query: "PAYWALL" }, blocked)).toBe(true);
    expect(matches({ query: "paywall" }, blocker)).toBe(true);
    expect(matches({ query: "nothing" }, blocker)).toBe(false);
  });
});

describe("closed columns", () => {
  const done = Array.from({ length: 95 }, (_, index) => ({
    environmentId: mac,
    issue: issue({ id: `done-${index}`, status: "done" }),
  }));

  it("draws the newest closed cards and counts the rest", () => {
    const page = pageBacklogColumn({ status: "done", issues: done }, 30);
    expect(page.visible).toHaveLength(30);
    expect(page.visible[0]?.issue.id).toBe("done-0");
    expect(page.hidden).toBe(65);
    expect(pageBacklogColumn({ status: "done", issues: done }, 130).hidden).toBe(0);
  });

  it("never pages an open column", () => {
    const ready = done.map((item) => ({
      ...item,
      issue: { ...item.issue, status: "ready" as const },
    }));
    expect(pageBacklogColumn({ status: "ready", issues: ready }, 30).hidden).toBe(0);
  });
});

describe("pending moves", () => {
  const row = issue({ id: "moved", status: "backlog", updatedAt: "2026-01-01T00:00:00.000Z" });
  const pending = new Map([
    [`${mac}:moved`, { status: "ready" as const, fromUpdatedAt: row.updatedAt }],
  ]);
  const sourcesWith = (moved: BacklogIssue) => [
    source({ environmentId: mac, board: board([wineBacklog], [moved]) }),
  ];

  it("keeps a move the server has not answered, without a new map", () => {
    expect(prunePendingBacklogMoves(pending, sourcesWith(row))).toBe(pending);
  });

  it("drops a move once the row moves on or already shows the status", () => {
    expect(
      prunePendingBacklogMoves(
        pending,
        sourcesWith({ ...row, updatedAt: "2026-01-01T00:00:01.000Z" }),
      ).size,
    ).toBe(0);
    expect(prunePendingBacklogMoves(pending, sourcesWith({ ...row, status: "ready" })).size).toBe(
      0,
    );
  });
});

describe("cards", () => {
  it("lists only open blockers, and counts an unknown one as open", () => {
    const done = issue({ id: "done", key: "WINE-1", status: "done" });
    const open = issue({ id: "open", key: "WINE-2", status: "in_progress" });
    const byId = new Map([done, open].map((entry) => [entry.id, entry]));
    expect(
      openBlockerKeys({ blockedBy: [done.id, open.id, BacklogIssueId.make("gone")] }, byId),
    ).toEqual(["WINE-2", "unknown issue"]);
  });

  it("rolls children up into their parent", () => {
    const parent = BacklogIssueId.make("spec");
    const progress = backlogChildProgress([
      { parentId: parent, status: "done" },
      { parentId: parent, status: "wontfix" },
      { parentId: parent, status: "ready" },
      { parentId: null, status: "done" },
    ]);
    expect(progress.get(parent)).toEqual({ closed: 2, total: 3 });
  });

  it("offers blockers from the same backlog, never itself or one already chosen", () => {
    const self = issue({ id: "self", number: 3, blockedBy: [BacklogIssueId.make("chosen")] });
    const candidates = blockerCandidates(self, [
      self,
      issue({ id: "chosen", number: 1 }),
      issue({ id: "other-backlog", number: 2, backlogId: BacklogId.make("elsewhere") }),
      issue({ id: "b", number: 5 }),
      issue({ id: "a", number: 4 }),
    ]);
    expect(candidates.map((candidate) => candidate.id)).toEqual(["a", "b"]);
  });
});

describe("editing", () => {
  it("accepts a typed key in any case and rejects what the server would", () => {
    expect(normalizeBacklogKeyInput(" wine ")).toBe("WINE");
    expect(normalizeBacklogKeyInput("cn2")).toBe("CN2");
    expect(normalizeBacklogKeyInput("2CN")).toBeNull();
    expect(normalizeBacklogKeyInput("WINE-1")).toBeNull();
    expect(normalizeBacklogKeyInput("ABCDEFGHIJK")).toBeNull();
    expect(normalizeBacklogKeyInput("")).toBeNull();
  });

  it("describes status moves and expiries in plain words", () => {
    expect(
      describeBacklogActivity({
        kind: "status_changed",
        text: null,
        fromStatus: "ready",
        toStatus: "in_progress",
      }),
    ).toBe("moved it Ready → In Progress");
    expect(
      describeBacklogActivity({
        kind: "lease_expired",
        text: null,
        fromStatus: "in_progress",
        toStatus: "ready",
      }),
    ).toBe("claim expired; returned to Ready");
  });
});

describe("backlogMoveTargets", () => {
  it("triages from the Inbox to existing backlogs and to projects that have none yet", () => {
    const inbox = backlog();
    const wine = backlog({
      id: BacklogId.make("backlog-wine"),
      kind: "project",
      key: "WINE",
      title: "Cork & Note",
      projectId: ProjectId.make("p-wine"),
    });
    const targets = backlogMoveTargets({
      currentBacklogId: inbox.id,
      backlogs: [inbox, wine],
      projects: [
        { id: ProjectId.make("p-wine"), title: "Cork & Note" },
        { id: ProjectId.make("p-fripp"), title: "Fripp Island" },
      ],
      creatableProjectIds: new Set([ProjectId.make("p-fripp")]),
    });
    expect(targets.map((target) => [target.label, target.input])).toEqual([
      ["Cork & Note (WINE)", { backlogId: wine.id }],
      ["Fripp Island", { projectId: ProjectId.make("p-fripp") }],
    ]);
  });

  it("offers the Inbox first when leaving a project backlog", () => {
    const targets = backlogMoveTargets({
      currentBacklogId: BacklogId.make("backlog-wine"),
      backlogs: [backlog({ id: BacklogId.make("backlog-wine"), kind: "project" }), backlog()],
      projects: [{ id: ProjectId.make("p-api"), title: "API" }],
      creatableProjectIds: new Set([ProjectId.make("p-api")]),
    });
    expect(targets.map((target) => target.label)).toEqual(["Inbox", "API"]);
  });

  it("moves by project only where that cannot split the project's backlog", () => {
    // The Mac's checkout has its backlog homed on the Geekom; the API has none anywhere yet.
    const entries = buildBacklogSwitcher({
      sources: [
        source({ environmentId: mac }),
        source({ environmentId: geekom, board: board([wineBacklog], []) }),
      ],
      projects: [
        project(),
        project({
          id: ProjectId.make("p-api"),
          title: "API",
          workspaceRoot: "/api",
          repositoryIdentity: null,
        }),
      ],
      groupingSettings,
      primaryEnvironmentId: mac,
    });
    const creatable = creatableProjectIdsOn(entries, mac);
    expect([...creatable]).toEqual([ProjectId.make("p-api")]);
    const targets = backlogMoveTargets({
      currentBacklogId: BacklogId.make("inbox-mac"),
      backlogs: [backlog({ id: BacklogId.make("inbox-mac") })],
      projects: [
        { id: ProjectId.make("project-wine-mac"), title: "Cork & Note" },
        { id: ProjectId.make("p-api"), title: "API" },
      ],
      creatableProjectIds: creatable,
    });
    expect(targets.map((target) => target.label)).toEqual(["API"]);
  });
});
