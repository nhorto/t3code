import {
  BacklogId,
  BacklogIssueId,
  EnvironmentId,
  type BacklogIssue,
  type BacklogIssueStatus,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  assignBacklogGraphLayers,
  backlogGraphCriticalPath,
  backlogGraphEdges,
  backlogGraphNodes,
  countBacklogGraphCrossings,
  layoutBacklogGraph,
  orderBacklogGraphLayers,
  splitBacklogGraphCycles,
  type BacklogGraphInputNode,
} from "./backlogGraph.logic";

function node(id: string, blockers: string[] = [], open = true): BacklogGraphInputNode {
  return { id, blockers, open };
}

function byId(layout: ReturnType<typeof layoutBacklogGraph>) {
  return new Map(layout.nodes.map((entry) => [entry.id, entry]));
}

describe("backlog graph layering", () => {
  it("puts each issue one column right of its furthest blocker", () => {
    const nodes = [node("a"), node("b", ["a"]), node("c", ["a", "b"]), node("d", ["a"])];
    const edges = backlogGraphEdges(nodes);
    const layers = assignBacklogGraphLayers(
      nodes.map((entry) => entry.id),
      edges,
    );
    expect(Object.fromEntries(layers)).toEqual({ a: 0, b: 1, c: 2, d: 1 });

    const layout = byId(layoutBacklogGraph(nodes));
    expect(layout.get("a")!.x).toBeLessThan(layout.get("b")!.x);
    expect(layout.get("b")!.x).toBeLessThan(layout.get("c")!.x);
    expect(layout.get("b")!.x).toBe(layout.get("d")!.x);
  });

  it("ignores self-blocks, duplicates and blockers outside the graph", () => {
    const edges = backlogGraphEdges([node("a", ["a"]), node("b", ["a", "a", "missing"])]);
    expect(edges).toEqual([{ from: "a", to: "b" }]);
  });

  it("sets unlinked issues in a grid below the graph", () => {
    const layout = layoutBacklogGraph([node("a"), node("b", ["a"]), node("loose")]);
    const nodes = byId(layout);
    expect(nodes.get("loose")!.layer).toBeNull();
    expect(layout.looseTop).not.toBeNull();
    expect(nodes.get("loose")!.y).toBeGreaterThan(layout.looseTop!);
    expect(nodes.get("loose")!.y).toBeGreaterThan(nodes.get("a")!.y);
    expect(layout.height).toBeGreaterThan(nodes.get("loose")!.y);
  });

  it("lays out an empty scope as nothing", () => {
    expect(layoutBacklogGraph([])).toMatchObject({ nodes: [], edges: [], width: 0, height: 0 });
  });
});

describe("backlog graph cycles", () => {
  it("drops the edge that closes a cycle instead of failing", () => {
    const nodes = [node("a", ["c"]), node("b", ["a"]), node("c", ["b"])];
    const ids = nodes.map((entry) => entry.id);
    const { acyclic, cyclic } = splitBacklogGraphCycles(ids, backlogGraphEdges(nodes));
    expect(acyclic).toHaveLength(2);
    expect([...cyclic]).toEqual([{ from: "c", to: "a" }]);

    const layout = layoutBacklogGraph(nodes);
    expect(layout.edges.filter((edge) => edge.cyclic)).toHaveLength(1);
    for (const entry of layout.nodes) {
      expect(Number.isFinite(entry.x) && Number.isFinite(entry.y)).toBe(true);
    }
    expect(layout.criticalPath).toEqual(["a", "b", "c"]);
  });

  it("survives two issues blocking each other", () => {
    const layout = layoutBacklogGraph([node("a", ["b"]), node("b", ["a"])]);
    expect(layout.nodes).toHaveLength(2);
    expect(layout.edges.filter((edge) => edge.cyclic)).toHaveLength(1);
  });
});

describe("backlog graph critical path", () => {
  const ids = (nodes: BacklogGraphInputNode[]) => nodes.map((entry) => entry.id);

  it("follows the longest chain of open issues", () => {
    const nodes = [
      node("a"),
      node("b", ["a"]),
      node("c", ["b"]),
      node("d", ["c"]),
      node("x", ["a"]),
    ];
    const path = backlogGraphCriticalPath(
      ids(nodes),
      backlogGraphEdges(nodes),
      new Set(ids(nodes)),
    );
    expect(path).toEqual(["a", "b", "c", "d"]);

    const layout = layoutBacklogGraph(nodes);
    expect(layout.edges.filter((edge) => edge.critical).map((edge) => edge.to)).toEqual([
      "b",
      "c",
      "d",
    ]);
    expect(byId(layout).get("x")!.critical).toBe(false);
  });

  it("is broken by closed issues", () => {
    const nodes = [
      node("a"),
      node("b", ["a"], false),
      node("c", ["b"]),
      node("d", ["c"]),
      node("e", ["d"]),
      node("y"),
      node("z", ["y"]),
    ];
    expect(layoutBacklogGraph(nodes).criticalPath).toEqual(["c", "d", "e"]);
  });

  it("breaks ties toward the earliest issue", () => {
    const nodes = [node("a"), node("b"), node("c", ["a", "b"]), node("d", ["b"])];
    expect(layoutBacklogGraph(nodes).criticalPath).toEqual(["a", "c"]);
  });

  it("highlights nothing without a chain of two open issues", () => {
    expect(layoutBacklogGraph([node("a"), node("b", ["a"], false)]).criticalPath).toEqual([]);
    expect(layoutBacklogGraph([node("a"), node("b")]).criticalPath).toEqual([]);
  });
});

describe("backlog graph ordering", () => {
  it("uncrosses edges between two layers", () => {
    const layers = [
      ["a", "b"],
      ["c", "d"],
    ];
    const edges = [
      { from: "a", to: "d" },
      { from: "b", to: "c" },
    ];
    expect(countBacklogGraphCrossings(layers, edges)).toBe(1);
    const ordered = orderBacklogGraphLayers(layers, edges);
    expect(countBacklogGraphCrossings(ordered, edges)).toBe(0);
    expect(orderBacklogGraphLayers(layers, edges)).toEqual(ordered);
  });

  it("cuts crossings on a large random backlog, deterministically", () => {
    let seed = 7;
    const random = () => {
      seed = (seed * 1_103_515_245 + 12_345) % 2 ** 31;
      return seed / 2 ** 31;
    };
    const nodes: BacklogGraphInputNode[] = [];
    for (let index = 0; index < 200; index += 1) {
      const blockers: string[] = [];
      for (let edge = 0; edge < 2; edge += 1) {
        if (index > 0 && random() < 0.6) blockers.push(`n${Math.floor(random() * index)}`);
      }
      nodes.push(node(`n${index}`, blockers, random() < 0.8));
    }
    const ids = nodes.map((entry) => entry.id);
    const edges = backlogGraphEdges(nodes);
    const layerOf = assignBacklogGraphLayers(ids, edges);
    const layers: string[][] = [];
    for (const id of ids) (layers[layerOf.get(id)!] ??= []).push(id);
    const ordered = orderBacklogGraphLayers(layers, edges);
    expect(countBacklogGraphCrossings(ordered, edges)).toBeLessThan(
      countBacklogGraphCrossings(layers, edges),
    );
    expect(layoutBacklogGraph(nodes)).toEqual(layoutBacklogGraph(nodes));
  });
});

describe("backlogGraphNodes", () => {
  const environmentId = EnvironmentId.make("env-mac");
  function issue(number: number, blockedBy: number[], status: BacklogIssueStatus): BacklogIssue {
    return {
      id: BacklogIssueId.make(`issue-${number}`),
      backlogId: BacklogId.make("backlog-wine"),
      number,
      key: `WINE-${number}`,
      title: `Issue ${number}`,
      type: "feature",
      status,
      priority: null,
      parentId: null,
      blockedBy: blockedBy.map((blocker) => BacklogIssueId.make(`issue-${blocker}`)),
      claim: null,
      links: [],
      hasBody: false,
      createdBy: { kind: "user", environmentId: null, threadId: null, label: "Nick" },
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      closedAt: null,
    };
  }

  it("lays out the same however the issues arrive", () => {
    const items = [
      issue(1, [], "done"),
      issue(2, [1], "ready"),
      issue(3, [1], "backlog"),
      issue(4, [2, 3], "backlog"),
      issue(5, [], "inbox"),
    ].map((entry) => ({ environmentId, issue: entry }));
    const forward = layoutBacklogGraph(backlogGraphNodes(items));
    const shuffled = layoutBacklogGraph(
      backlogGraphNodes([items[3]!, items[0]!, items[4]!, items[2]!, items[1]!]),
    );
    expect(shuffled).toEqual(forward);
    expect(forward.nodes.find((entry) => entry.id.endsWith("issue-1"))!.open).toBe(false);
    expect(forward.criticalPath).toEqual([`${environmentId}:issue-2`, `${environmentId}:issue-4`]);
  });
});
