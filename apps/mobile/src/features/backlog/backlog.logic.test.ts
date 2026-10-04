import { EMPTY_BACKLOG_BOARD, type BacklogBoardState } from "@t3tools/client-runtime/state/backlog";
import {
  BacklogId,
  BacklogIssueId,
  EnvironmentId,
  ProjectId,
  type Backlog,
  type BacklogIssue,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  backlogMoveTargets,
  backlogReadOnlyReason,
  buildBacklogListItems,
  buildBacklogScopes,
  creatableProjectIdsOn,
  defaultQuickAddScopeKey,
  describeBacklogClaim,
  filterBacklogIssues,
  findBacklogScopeForProject,
  mergeBacklogIssuesById,
  reopenBacklogStatus,
  resolveBacklogCreateTarget,
  resolveBacklogScope,
  selectBacklogScopeIssues,
  type BacklogEnvironmentAvailability,
  type BacklogProjectGroup,
  type EnvironmentBacklogBoard,
} from "./backlog.logic";

const GEEKOM = EnvironmentId.make("geekom");
const LAPTOP = EnvironmentId.make("laptop");
const WINE_ON_GEEKOM = ProjectId.make("wine-geekom");
const WINE_ON_LAPTOP = ProjectId.make("wine-laptop");
const NOTES_ON_LAPTOP = ProjectId.make("notes-laptop");
const AT = "2026-10-04T10:00:00.000Z";

function backlog(
  id: string,
  kind: Backlog["kind"],
  title: string,
  projectId: ProjectId | null = null,
  repositoryKey: string | null = null,
): Backlog {
  return {
    id: BacklogId.make(id),
    kind,
    key: kind === "inbox" ? "INBOX" : title.toUpperCase().slice(0, 4),
    title,
    projectId,
    repositoryKey,
    createdAt: AT,
    updatedAt: AT,
  } as Backlog;
}

function issue(
  id: string,
  backlogId: string,
  overrides: Partial<Omit<BacklogIssue, "id" | "backlogId">> = {},
): BacklogIssue {
  return {
    id: BacklogIssueId.make(id),
    backlogId: BacklogId.make(backlogId),
    number: 1,
    key: `KEY-${id}`,
    title: `Issue ${id}`,
    type: "idea",
    status: "backlog",
    priority: null,
    parentId: null,
    blockedBy: [],
    claim: null,
    links: [],
    hasBody: false,
    createdBy: { kind: "user", environmentId: null, threadId: null, label: "Nick" },
    createdAt: AT,
    updatedAt: AT,
    closedAt: null,
    ...overrides,
  } as BacklogIssue;
}

function env(
  environmentId: EnvironmentId,
  state: BacklogEnvironmentAvailability["state"] = "ready",
): BacklogEnvironmentAvailability {
  return { environmentId, label: environmentId === GEEKOM ? "Geekom" : "Laptop", state };
}

function board(backlogs: Backlog[], issues: BacklogIssue[]): BacklogBoardState {
  return { backlogs, issues, issuesById: new Map(issues.map((entry) => [entry.id, entry])) };
}

const wineGroup: BacklogProjectGroup = {
  key: "repo:wine",
  label: "Cork & Note",
  projectRefs: [
    { environmentId: GEEKOM, projectId: WINE_ON_GEEKOM },
    { environmentId: LAPTOP, projectId: WINE_ON_LAPTOP },
  ],
  repositoryKeys: ["github.com/nhorto/cork-and-note"],
};
const notesGroup: BacklogProjectGroup = {
  key: "repo:notes",
  label: "Notes",
  projectRefs: [{ environmentId: LAPTOP, projectId: NOTES_ON_LAPTOP }],
  repositoryKeys: [],
};

describe("buildBacklogScopes", () => {
  it("lists All and Inbox first, then projects alphabetically, merging environments", () => {
    const boards: EnvironmentBacklogBoard[] = [
      {
        environmentId: GEEKOM,
        board: board(
          [
            backlog("inbox-g", "inbox", "Inbox"),
            backlog("wine", "project", "Cork & Note", WINE_ON_GEEKOM),
          ],
          [],
        ),
      },
      { environmentId: LAPTOP, board: board([backlog("inbox-l", "inbox", "Inbox")], []) },
    ];
    const scopes = buildBacklogScopes({ boards, projectGroups: [notesGroup, wineGroup] });

    expect(scopes.map((scope) => scope.label)).toEqual([
      "All backlogs",
      "Inbox",
      "Cork & Note",
      "Notes",
    ]);
    expect(scopes[1]!.backlogs.map((entry) => entry.backlog.id)).toEqual(["inbox-g", "inbox-l"]);
    expect(scopes[2]!.backlogs.map((entry) => entry.backlog.id)).toEqual(["wine"]);
    expect(scopes[3]!.backlogs).toEqual([]);
  });

  it("matches a backlog homed on another machine by repository", () => {
    const homed = backlog(
      "wine",
      "project",
      "Cork & Note",
      ProjectId.make("project-on-a-machine-we-do-not-list"),
      "github.com/nhorto/cork-and-note",
    );
    const scopes = buildBacklogScopes({
      boards: [{ environmentId: GEEKOM, board: board([homed], []) }],
      projectGroups: [wineGroup],
    });

    expect(scopes.map((scope) => scope.label)).toEqual(["All backlogs", "Inbox", "Cork & Note"]);
    expect(scopes[2]!.backlogs.map((entry) => entry.backlog.id)).toEqual(["wine"]);
  });

  it("keeps a backlog whose project is gone reachable under its own entry", () => {
    const orphan = backlog("old", "project", "Old project", ProjectId.make("deleted"));
    const scopes = buildBacklogScopes({
      boards: [{ environmentId: GEEKOM, board: board([orphan], []) }],
      projectGroups: [],
    });

    expect(scopes.map((scope) => scope.label)).toEqual(["All backlogs", "Inbox", "Old project"]);
    expect(scopes[2]!.backlogs.map((entry) => entry.backlog.id)).toEqual(["old"]);
  });

  it("finds a project's scope from any of its checkouts and falls back to All", () => {
    const scopes = buildBacklogScopes({ boards: [], projectGroups: [wineGroup] });

    expect(
      findBacklogScopeForProject(scopes, { environmentId: LAPTOP, projectId: WINE_ON_LAPTOP })
        ?.label,
    ).toBe("Cork & Note");
    expect(resolveBacklogScope(scopes, "missing").key).toBe("all");
  });
});

describe("selectBacklogScopeIssues", () => {
  const boards: EnvironmentBacklogBoard[] = [
    {
      environmentId: GEEKOM,
      board: board(
        [backlog("inbox-g", "inbox", "Inbox"), backlog("wine", "project", "Wine", WINE_ON_GEEKOM)],
        [issue("a", "inbox-g"), issue("b", "wine")],
      ),
    },
    {
      environmentId: LAPTOP,
      // The same issue reported twice is shown once.
      board: board(
        [backlog("inbox-l", "inbox", "Inbox")],
        [issue("c", "inbox-l"), issue("b", "wine")],
      ),
    },
  ];
  const scopes = buildBacklogScopes({ boards, projectGroups: [wineGroup] });

  it("shows every issue once for All", () => {
    const ids = selectBacklogScopeIssues(boards, resolveBacklogScope(scopes, "all")).map(
      (entry) => entry.issue.id,
    );
    expect(ids).toEqual(["a", "b", "c"]);
  });

  it("limits the Inbox and a project to their backlogs", () => {
    expect(
      selectBacklogScopeIssues(boards, resolveBacklogScope(scopes, "inbox")).map(
        (entry) => entry.issue.id,
      ),
    ).toEqual(["a", "c"]);
    expect(
      selectBacklogScopeIssues(boards, resolveBacklogScope(scopes, "project:repo:wine")).map(
        (entry) => `${entry.environmentId}/${entry.issue.id}`,
      ),
    ).toEqual(["geekom/b"]);
  });
});

describe("filterBacklogIssues", () => {
  const entries = [
    {
      environmentId: GEEKOM,
      issue: issue("1", "x", { key: "WINE-12", title: "Paywall crashes on iPad", type: "bug" }),
    },
    {
      environmentId: GEEKOM,
      issue: issue("2", "x", { key: "WINE-13", title: "Dark mode labels" }),
    },
  ];

  it("matches every word against the key or title", () => {
    expect(filterBacklogIssues(entries, { query: "ipad paywall", type: null })).toHaveLength(1);
    expect(filterBacklogIssues(entries, { query: "wine-13", type: null })[0]!.issue.id).toBe("2");
  });

  it("filters by type", () => {
    expect(
      filterBacklogIssues(entries, { query: "", type: "bug" }).map((entry) => entry.issue.id),
    ).toEqual(["1"]);
  });
});

describe("buildBacklogListItems", () => {
  const issues = [
    issue("ready-old", "x", { status: "ready", updatedAt: "2026-10-01T00:00:00.000Z" }),
    issue("ready-new", "x", {
      status: "ready",
      updatedAt: "2026-10-03T00:00:00.000Z",
      blockedBy: [BacklogIssueId.make("ready-old")],
    }),
    issue("done", "x", { status: "done" }),
  ];
  const entries = issues.map((entry) => ({ environmentId: GEEKOM, issue: entry }));
  const issuesById = new Map(issues.map((entry) => [entry.id, entry]));

  it("groups by status in board order, skips empty columns and collapses closed ones", () => {
    const items = buildBacklogListItems({ entries, issuesById, expandedClosedStatuses: new Set() });

    expect(
      items.map((item) =>
        item.type === "section" ? `[${item.label} ${item.count}]` : item.entry.issue.id,
      ),
    ).toEqual(["[Ready 2]", "ready-new", "ready-old", "[Done 1]"]);
    expect(items.find((item) => item.type === "section" && item.status === "done")).toMatchObject({
      collapsed: true,
    });
  });

  it("marks issues blocked by an open issue and expands closed columns on request", () => {
    const items = buildBacklogListItems({
      entries,
      issuesById,
      expandedClosedStatuses: new Set(["done"]),
    });
    const blocked = items.flatMap((item) =>
      item.type === "issue" && item.blocked ? [item.entry.issue.id] : [],
    );

    expect(blocked).toEqual(["ready-new"]);
    expect(items.at(-1)).toMatchObject({ type: "issue", isFirst: true, isLast: true });
  });

  it("resolves blockers across environments", () => {
    const other = issue("blocker", "y", { status: "in_progress" });
    const merged = mergeBacklogIssuesById([
      { environmentId: GEEKOM, board: board([], [issues[1]!]) },
      { environmentId: LAPTOP, board: board([], [other]) },
    ]);
    expect([...merged.keys()]).toEqual(["ready-new", "blocker"]);
  });
});

describe("resolveBacklogCreateTarget", () => {
  const boards: EnvironmentBacklogBoard[] = [
    {
      environmentId: GEEKOM,
      board: board(
        [backlog("inbox-g", "inbox", "Inbox"), backlog("wine", "project", "Wine", WINE_ON_GEEKOM)],
        [],
      ),
    },
    { environmentId: LAPTOP, board: EMPTY_BACKLOG_BOARD },
  ];
  const scopes = buildBacklogScopes({ boards, projectGroups: [wineGroup, notesGroup] });

  it("sends Inbox ideas to the environment hosting an Inbox", () => {
    expect(
      resolveBacklogCreateTarget(resolveBacklogScope(scopes, "inbox"), [env(LAPTOP), env(GEEKOM)])
        .target,
    ).toEqual({ environmentId: GEEKOM, input: { backlogId: "inbox-g" } });
  });

  it("creates the Inbox on the first ready environment when none exists", () => {
    const empty = buildBacklogScopes({ boards: [], projectGroups: [] });
    expect(
      resolveBacklogCreateTarget(resolveBacklogScope(empty, "all"), [env(LAPTOP)]).target,
    ).toEqual({ environmentId: LAPTOP, input: {} });
    expect(resolveBacklogCreateTarget(resolveBacklogScope(empty, "inbox"), [])).toMatchObject({
      target: null,
      loading: false,
    });
    expect(
      resolveBacklogCreateTarget(resolveBacklogScope(empty, "inbox"), [env(LAPTOP, "loading")]),
    ).toEqual({ target: null, blockedReason: "Loading Laptop…", loading: true });
  });

  it("uses the project's existing backlog, else a checkout once every checkout has answered", () => {
    expect(
      resolveBacklogCreateTarget(resolveBacklogScope(scopes, "project:repo:wine"), [
        env(LAPTOP),
        env(GEEKOM),
      ]).target,
    ).toEqual({ environmentId: GEEKOM, input: { backlogId: "wine" } });
    const unseen = buildBacklogScopes({
      boards: [{ environmentId: LAPTOP, board: EMPTY_BACKLOG_BOARD }],
      projectGroups: [wineGroup, notesGroup],
    });
    const wine = resolveBacklogScope(unseen, "project:repo:wine");
    expect(resolveBacklogCreateTarget(wine, [env(LAPTOP), env(GEEKOM)]).target).toEqual({
      environmentId: LAPTOP,
      input: { projectId: WINE_ON_LAPTOP },
    });
    expect(
      resolveBacklogCreateTarget(resolveBacklogScope(unseen, "project:repo:notes"), [env(GEEKOM)]),
    ).toMatchObject({ target: null, loading: false });
  });

  it("never creates a second backlog while a checkout's board is loading or offline", () => {
    const unseen = buildBacklogScopes({
      boards: [{ environmentId: LAPTOP, board: EMPTY_BACKLOG_BOARD }],
      projectGroups: [wineGroup],
    });
    const wine = resolveBacklogScope(unseen, "project:repo:wine");
    expect(resolveBacklogCreateTarget(wine, [env(LAPTOP), env(GEEKOM, "loading")])).toEqual({
      target: null,
      blockedReason: "Loading Geekom…",
      loading: true,
    });
    expect(resolveBacklogCreateTarget(wine, [env(LAPTOP), env(GEEKOM, "offline")])).toEqual({
      target: null,
      blockedReason: "Geekom may hold this backlog and is offline.",
      loading: false,
    });
    expect([
      ...creatableProjectIdsOn(unseen, [env(LAPTOP), env(GEEKOM, "offline")], LAPTOP),
    ]).toEqual([]);
    expect([...creatableProjectIdsOn(unseen, [env(LAPTOP), env(GEEKOM)], LAPTOP)]).toEqual([
      WINE_ON_LAPTOP,
    ]);
  });

  it("defaults quick-add to the board's project, else the Inbox", () => {
    expect(defaultQuickAddScopeKey(resolveBacklogScope(scopes, "project:repo:wine"))).toBe(
      "project:repo:wine",
    );
    expect(defaultQuickAddScopeKey(resolveBacklogScope(scopes, "all"))).toBe("inbox");
  });
});

describe("issue actions", () => {
  it("offers the Inbox, then every project on the environment, creating backlogs as needed", () => {
    const wine = ProjectId.make("wine");
    const notes = ProjectId.make("notes");
    const apps = ProjectId.make("apps");
    const state = board(
      [
        backlog("inbox", "inbox", "Inbox"),
        backlog("wine-backlog", "project", "Wine", wine),
        backlog("apps-backlog", "project", "Apps", apps),
        backlog("old", "project", "Old project", ProjectId.make("deleted")),
      ],
      [],
    );
    const projects = [
      { id: wine, title: "Cork & Note" },
      { id: notes, title: "Notes" },
      { id: apps, title: "Apps" },
    ];

    const creatable = new Set([notes]);
    const fromInbox = backlogMoveTargets(
      state,
      { backlogId: BacklogId.make("inbox") },
      projects,
      creatable,
    );
    expect(fromInbox.map((target) => [target.label, target.patch])).toEqual([
      ["Apps", { backlogId: "apps-backlog" }],
      ["Cork & Note", { backlogId: "wine-backlog" }],
      ["Notes", { projectId: "notes" }],
      ["Old project", { backlogId: "old" }],
    ]);

    const fromWine = backlogMoveTargets(
      state,
      { backlogId: BacklogId.make("wine-backlog") },
      projects,
      creatable,
    );
    expect(fromWine.map((target) => target.label)).toEqual([
      "Inbox",
      "Apps",
      "Notes",
      "Old project",
    ]);
  });

  it("offers a project without a backlog only where creating one is safe", () => {
    const notes = ProjectId.make("notes");
    const targets = backlogMoveTargets(
      board([backlog("inbox", "inbox", "Inbox")], []),
      { backlogId: BacklogId.make("inbox") },
      [{ id: notes, title: "Notes" }],
      new Set(),
    );
    expect(targets).toEqual([]);
  });

  it("reopens to the column the issue would have started in", () => {
    expect(reopenBacklogStatus(backlog("inbox", "inbox", "Inbox"))).toBe("inbox");
    expect(reopenBacklogStatus(backlog("wine", "project", "Wine"))).toBe("backlog");
  });

  it("describes a claim by holder and machine", () => {
    const claim = {
      actor: { kind: "agent" as const, environmentId: GEEKOM, threadId: null, label: "Claude" },
      claimedAt: AT,
      leaseExpiresAt: AT,
    };
    expect(describeBacklogClaim(claim, (id) => (id === GEEKOM ? "Geekom" : null))).toBe(
      "Claude · Geekom",
    );
    expect(describeBacklogClaim(claim, () => null)).toBe("Claude");
  });
});

describe("offline and moved boards", () => {
  const formatTime = () => "2h ago";

  it("explains why an issue cannot change: out of reach, still loading, or moved away", () => {
    const saved = { asOf: AT, fromCache: true as const };
    expect(
      backlogReadOnlyReason({
        connected: false,
        board: saved,
        backlog: null,
        label: "Geekom",
        formatTime,
      }),
    ).toBe("Offline — showing Geekom's board as of 2h ago; changes are disabled.");
    expect(
      backlogReadOnlyReason({
        connected: true,
        board: saved,
        backlog: null,
        label: "Geekom",
        formatTime,
      }),
    ).toBe("Loading Geekom…");
    expect(
      backlogReadOnlyReason({
        connected: true,
        board: { asOf: AT },
        backlog: null,
        label: "Geekom",
        formatTime,
      }),
    ).toBeNull();
    expect(
      backlogReadOnlyReason({
        connected: true,
        board: { asOf: AT },
        backlog: {
          key: "WINE",
          movedTo: { environmentId: GEEKOM, label: "Geekom", movedAt: AT },
        },
        label: "Laptop",
        formatTime,
      }),
    ).toBe("WINE moved to Geekom. This copy is read-only.");
  });

  it("shows a moved board once, from its new home, and never adds to the redirect", () => {
    const wine = backlog(
      "wine",
      "project",
      "Cork & Note",
      WINE_ON_LAPTOP,
      "github.com/nhorto/cork-and-note",
    );
    const redirect = {
      ...wine,
      movedTo: { environmentId: GEEKOM, label: "Geekom", movedAt: AT },
    };
    const onLaptop: EnvironmentBacklogBoard = {
      environmentId: LAPTOP,
      board: board([redirect], [issue("a", "wine")]),
    };
    const onGeekom: EnvironmentBacklogBoard = {
      environmentId: GEEKOM,
      board: board([wine], [issue("a", "wine")]),
    };
    const both = resolveBacklogScope(
      buildBacklogScopes({ boards: [onLaptop, onGeekom], projectGroups: [wineGroup] }),
      "project:repo:wine",
    );
    expect(both.backlogs.map((entry) => entry.environmentId)).toEqual([GEEKOM]);
    expect(resolveBacklogCreateTarget(both, [env(LAPTOP), env(GEEKOM)]).target).toEqual({
      environmentId: GEEKOM,
      input: { backlogId: "wine" },
    });

    const alone = resolveBacklogScope(
      buildBacklogScopes({ boards: [onLaptop], projectGroups: [wineGroup] }),
      "project:repo:wine",
    );
    expect(resolveBacklogCreateTarget(alone, [env(LAPTOP), env(GEEKOM, "offline")])).toEqual({
      target: null,
      blockedReason: "Cork & Note moved to Geekom, which is not connected.",
      loading: false,
    });
  });
});

describe("one Inbox for the fleet", () => {
  const hub = { environmentId: GEEKOM, label: "Geekom" };
  const laptopInbox = backlog("inbox-l", "inbox", "Inbox");
  const boards = (laptopIssues: BacklogIssue[]): EnvironmentBacklogBoard[] => [
    { environmentId: GEEKOM, board: board([backlog("inbox-g", "inbox", "Inbox")], []) },
    {
      environmentId: LAPTOP,
      board: { ...board([laptopInbox], laptopIssues), linkedHub: hub },
    },
  ];
  const scopesFor = (laptopIssues: BacklogIssue[]) =>
    buildBacklogScopes({
      boards: boards(laptopIssues),
      projectGroups: [],
      environmentLabel: (environmentId) => (environmentId === LAPTOP ? "Laptop" : "Geekom"),
    });

  it("lists the hub's Inbox once, with a linked machine's old Inbox under it while not empty", () => {
    const scopes = scopesFor([issue("old", "inbox-l", { status: "inbox" })]);
    expect(scopes.map((scope) => scope.label)).toEqual([
      "All backlogs",
      "Inbox",
      "Inbox on Laptop (legacy)",
    ]);
    expect(resolveBacklogScope(scopes, "inbox").backlogs.map((entry) => entry.backlog.id)).toEqual([
      "inbox-g",
    ]);
    const legacy = scopes[2]!;
    expect(legacy.legacyInbox).toEqual({ environmentId: LAPTOP, hubLabel: "Geekom" });
    expect(resolveBacklogCreateTarget(legacy, [env(LAPTOP), env(GEEKOM)])).toMatchObject({
      target: null,
      blockedReason: "New ideas go to the Geekom Inbox.",
    });
    expect(defaultQuickAddScopeKey(legacy)).toBe("inbox");

    const emptied = scopesFor([issue("old", "inbox-l", { status: "wontfix" })]);
    expect(emptied.some((scope) => scope.kind === "legacyInbox")).toBe(false);
  });

  it("sends Inbox ideas to the hub, or through a linked machine while the hub is away", () => {
    const inbox = resolveBacklogScope(scopesFor([]), "inbox");
    expect(resolveBacklogCreateTarget(inbox, [env(LAPTOP), env(GEEKOM)]).target).toEqual({
      environmentId: GEEKOM,
      input: { backlogId: "inbox-g" },
    });
    expect(resolveBacklogCreateTarget(inbox, [env(LAPTOP), env(GEEKOM, "offline")]).target).toEqual(
      { environmentId: LAPTOP, input: {} },
    );
    expect(
      resolveBacklogCreateTarget(inbox, [env(LAPTOP, "offline"), env(GEEKOM, "offline")]),
    ).toEqual({
      target: null,
      blockedReason: "The Inbox lives on Geekom, which is not connected.",
      loading: false,
    });
  });

  it("offers no move into a legacy Inbox", () => {
    const linkedBoard = boards([])[1]!.board;
    expect(
      backlogMoveTargets(linkedBoard, { backlogId: BacklogId.make("other") }, [], new Set()),
    ).toEqual([]);
  });
});
