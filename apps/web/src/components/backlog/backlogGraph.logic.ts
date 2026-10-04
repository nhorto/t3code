import { isBacklogStatusClosed, type BacklogIssue, type EnvironmentId } from "@t3tools/contracts";

import { boardIssueKey } from "./backlog.logic";

/**
 * Layout for the Backlog dependency graph: issues are nodes, blocked-by edges run left to right
 * (blocker -> blocked). Longest-path layering, a few barycenter sweeps to reduce crossings, and
 * the critical path (the longest chain of open issues). Everything here is pure and deterministic
 * for a given input order, so the view can memoize it on the issue list.
 */

export interface BacklogGraphInputNode {
  readonly id: string;
  /** Ids of the nodes that block this one. Ids not in the input are ignored. */
  readonly blockers: ReadonlyArray<string>;
  readonly open: boolean;
}

export interface BacklogGraphEdge {
  /** The blocker. */
  readonly from: string;
  /** The blocked issue. */
  readonly to: string;
}

export interface BacklogGraphLayoutNode {
  readonly id: string;
  readonly open: boolean;
  /** Column index; null for nodes with no edges, which sit in a grid below the graph. */
  readonly layer: number | null;
  readonly x: number;
  readonly y: number;
  readonly critical: boolean;
}

export interface BacklogGraphLayoutEdge extends BacklogGraphEdge {
  readonly critical: boolean;
  /** Closes a cycle. The server rejects cycles; drawn distinctly and ignored by the layout. */
  readonly cyclic: boolean;
  readonly x1: number;
  readonly y1: number;
  readonly x2: number;
  readonly y2: number;
}

export interface BacklogGraphLayout {
  readonly nodes: ReadonlyArray<BacklogGraphLayoutNode>;
  readonly edges: ReadonlyArray<BacklogGraphLayoutEdge>;
  /** Node ids along the critical path, blocker first. Empty when no chain is longer than one. */
  readonly criticalPath: ReadonlyArray<string>;
  /** Top of the unlinked grid, for its label; null when every node has an edge. */
  readonly looseTop: number | null;
  readonly width: number;
  readonly height: number;
}

export const BACKLOG_GRAPH_NODE_WIDTH = 208;
export const BACKLOG_GRAPH_NODE_HEIGHT = 52;
const COLUMN_GAP = 72;
const ROW_GAP = 16;
const PADDING = 16;
const LOOSE_SECTION_GAP = 40;
const LOOSE_LABEL_HEIGHT = 24;
const MIN_LOOSE_COLUMNS = 4;
const ORDERING_SWEEPS = 4;

/** Unique edges between known nodes, in input order. Self-loops and unknown blockers drop out. */
export function backlogGraphEdges(
  nodes: ReadonlyArray<BacklogGraphInputNode>,
): ReadonlyArray<BacklogGraphEdge> {
  const known = new Set(nodes.map((node) => node.id));
  const seen = new Set<string>();
  const edges: BacklogGraphEdge[] = [];
  for (const node of nodes) {
    for (const blocker of node.blockers) {
      if (blocker === node.id || !known.has(blocker)) continue;
      const key = `${blocker}\u0000${node.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      edges.push({ from: blocker, to: node.id });
    }
  }
  return edges;
}

/**
 * Splits edges into a DAG and the back edges that would close a cycle, via a DFS in input order.
 * The server rejects cycles, but a stale or merged snapshot must not hang or crash the view.
 */
export function splitBacklogGraphCycles(
  ids: ReadonlyArray<string>,
  edges: ReadonlyArray<BacklogGraphEdge>,
): {
  readonly acyclic: ReadonlyArray<BacklogGraphEdge>;
  readonly cyclic: ReadonlySet<BacklogGraphEdge>;
} {
  const outgoing = new Map<string, BacklogGraphEdge[]>(ids.map((id) => [id, []]));
  for (const edge of edges) outgoing.get(edge.from)?.push(edge);
  const state = new Map<string, "active" | "done">();
  const cyclic = new Set<BacklogGraphEdge>();
  for (const root of ids) {
    if (state.has(root)) continue;
    // Iterative DFS: each frame is a node and the index of its next outgoing edge.
    const stack: Array<{ id: string; next: number }> = [{ id: root, next: 0 }];
    state.set(root, "active");
    while (stack.length > 0) {
      const frame = stack[stack.length - 1]!;
      const out = outgoing.get(frame.id) ?? [];
      if (frame.next >= out.length) {
        state.set(frame.id, "done");
        stack.pop();
        continue;
      }
      const edge = out[frame.next]!;
      frame.next += 1;
      const target = state.get(edge.to);
      if (target === "active") cyclic.add(edge);
      else if (target === undefined) {
        state.set(edge.to, "active");
        stack.push({ id: edge.to, next: 0 });
      }
    }
  }
  return { acyclic: edges.filter((edge) => !cyclic.has(edge)), cyclic };
}

/** Longest-path layering: a node sits one column right of its furthest blocker. */
export function assignBacklogGraphLayers(
  ids: ReadonlyArray<string>,
  acyclic: ReadonlyArray<BacklogGraphEdge>,
): ReadonlyMap<string, number> {
  const incoming = new Map<string, number>(ids.map((id) => [id, 0]));
  const outgoing = new Map<string, string[]>(ids.map((id) => [id, []]));
  for (const edge of acyclic) {
    incoming.set(edge.to, (incoming.get(edge.to) ?? 0) + 1);
    outgoing.get(edge.from)?.push(edge.to);
  }
  const layers = new Map<string, number>(ids.map((id) => [id, 0]));
  const queue = ids.filter((id) => incoming.get(id) === 0);
  for (let index = 0; index < queue.length; index += 1) {
    const id = queue[index]!;
    const layer = layers.get(id)!;
    for (const next of outgoing.get(id) ?? []) {
      if (layers.get(next)! < layer + 1) layers.set(next, layer + 1);
      const remaining = incoming.get(next)! - 1;
      incoming.set(next, remaining);
      if (remaining === 0) queue.push(next);
    }
  }
  return layers;
}

function pushTo(map: Map<string, string[]>, key: string, value: string) {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}

/** Position of every node in its layer, centred so layers of different sizes compare. */
function centredPositions(order: ReadonlyArray<ReadonlyArray<string>>): Map<string, number> {
  const positions = new Map<string, number>();
  for (const layer of order) {
    const offset = (layer.length - 1) / 2;
    layer.forEach((id, index) => positions.set(id, index - offset));
  }
  return positions;
}

/** Pairs of edges that cross, among edges spanning the same pair of layers. */
export function countBacklogGraphCrossings(
  order: ReadonlyArray<ReadonlyArray<string>>,
  edges: ReadonlyArray<BacklogGraphEdge>,
): number {
  const layerOf = new Map<string, number>();
  const indexOf = new Map<string, number>();
  order.forEach((layer, layerIndex) =>
    layer.forEach((id, index) => {
      layerOf.set(id, layerIndex);
      indexOf.set(id, index);
    }),
  );
  const bySpan = new Map<string, Array<readonly [number, number]>>();
  for (const edge of edges) {
    const span = `${layerOf.get(edge.from)}:${layerOf.get(edge.to)}`;
    const list = bySpan.get(span) ?? [];
    list.push([indexOf.get(edge.from)!, indexOf.get(edge.to)!]);
    bySpan.set(span, list);
  }
  let crossings = 0;
  for (const list of bySpan.values()) {
    for (let i = 0; i < list.length; i += 1) {
      for (let j = i + 1; j < list.length; j += 1) {
        const [a1, a2] = list[i]!;
        const [b1, b2] = list[j]!;
        if ((a1 - b1) * (a2 - b2) < 0) crossings += 1;
      }
    }
  }
  return crossings;
}

/**
 * Orders each layer by the barycenter of its neighbours, sweeping right then left a few times
 * and keeping the ordering with the fewest crossings. Ties keep the current order, so the result
 * depends only on the input order.
 */
export function orderBacklogGraphLayers(
  layers: ReadonlyArray<ReadonlyArray<string>>,
  edges: ReadonlyArray<BacklogGraphEdge>,
): ReadonlyArray<ReadonlyArray<string>> {
  const blockers = new Map<string, string[]>();
  const blocked = new Map<string, string[]>();
  for (const edge of edges) {
    pushTo(blockers, edge.to, edge.from);
    pushTo(blocked, edge.from, edge.to);
  }
  const order = layers.map((layer) => [...layer]);
  let best = order.map((layer) => [...layer]);
  let bestCrossings = countBacklogGraphCrossings(best, edges);

  const sortLayer = (layerIndex: number, neighbours: Map<string, string[]>) => {
    const positions = centredPositions(order);
    const keyed = order[layerIndex]!.map((id) => {
      const around = neighbours.get(id) ?? [];
      const own = positions.get(id)!;
      const center =
        around.length === 0
          ? own
          : around.reduce((sum, other) => sum + positions.get(other)!, 0) / around.length;
      return { id, center, own };
    });
    keyed.sort((left, right) => left.center - right.center || left.own - right.own);
    order[layerIndex] = keyed.map((entry) => entry.id);
  };

  for (let sweep = 0; sweep < ORDERING_SWEEPS && bestCrossings > 0; sweep += 1) {
    for (let index = 1; index < order.length; index += 1) sortLayer(index, blockers);
    for (let index = order.length - 2; index >= 0; index -= 1) sortLayer(index, blocked);
    const crossings = countBacklogGraphCrossings(order, edges);
    if (crossings < bestCrossings) {
      bestCrossings = crossings;
      best = order.map((layer) => [...layer]);
    }
  }
  return best;
}

/**
 * The longest chain of open issues through blocking edges, blocker first. Ties go to the chain
 * that ends, and then steps back through, the node earliest in `ids`.
 */
export function backlogGraphCriticalPath(
  ids: ReadonlyArray<string>,
  acyclic: ReadonlyArray<BacklogGraphEdge>,
  open: ReadonlySet<string>,
): ReadonlyArray<string> {
  const layers = assignBacklogGraphLayers(ids, acyclic);
  const rank = new Map(ids.map((id, index) => [id, index]));
  // Layers increase along every edge, so layer-then-input order is a topological order.
  const topo = [...ids].sort(
    (left, right) => layers.get(left)! - layers.get(right)! || rank.get(left)! - rank.get(right)!,
  );
  const blockers = new Map<string, string[]>();
  for (const edge of acyclic) {
    if (open.has(edge.from) && open.has(edge.to)) pushTo(blockers, edge.to, edge.from);
  }
  const length = new Map<string, number>();
  const previous = new Map<string, string>();
  for (const id of topo) {
    if (!open.has(id)) continue;
    let bestLength = 0;
    let bestPrevious: string | undefined;
    for (const blocker of blockers.get(id) ?? []) {
      const candidate = length.get(blocker) ?? 0;
      if (
        candidate > bestLength ||
        (candidate === bestLength &&
          bestPrevious !== undefined &&
          rank.get(blocker)! < rank.get(bestPrevious)!)
      ) {
        bestLength = candidate;
        bestPrevious = blocker;
      }
    }
    length.set(id, bestLength + 1);
    if (bestPrevious !== undefined) previous.set(id, bestPrevious);
  }
  let end: string | undefined;
  for (const id of ids) {
    const candidate = length.get(id) ?? 0;
    if (candidate > (end === undefined ? 0 : length.get(end)!)) end = id;
  }
  if (end === undefined || length.get(end)! < 2) return [];
  const path: string[] = [];
  for (let id: string | undefined = end; id !== undefined; id = previous.get(id)) path.push(id);
  return path.toReversed();
}

export function layoutBacklogGraph(
  nodes: ReadonlyArray<BacklogGraphInputNode>,
): BacklogGraphLayout {
  const ids = nodes.map((node) => node.id);
  const edges = backlogGraphEdges(nodes);
  const { acyclic, cyclic } = splitBacklogGraphCycles(ids, edges);
  const linked = new Set(edges.flatMap((edge) => [edge.from, edge.to]));
  const linkedIds = ids.filter((id) => linked.has(id));
  const looseIds = ids.filter((id) => !linked.has(id));

  const layerOf = assignBacklogGraphLayers(linkedIds, acyclic);
  const layerCount = linkedIds.reduce((max, id) => Math.max(max, layerOf.get(id)! + 1), 0);
  const initial: string[][] = Array.from({ length: layerCount }, () => []);
  for (const id of linkedIds) initial[layerOf.get(id)!]!.push(id);
  const order = orderBacklogGraphLayers(initial, acyclic);

  const open = new Set(nodes.filter((node) => node.open).map((node) => node.id));
  const criticalPath = backlogGraphCriticalPath(linkedIds, acyclic, open);
  const criticalNodes = new Set(criticalPath);
  const criticalEdges = new Set(
    criticalPath.slice(1).map((id, index) => `${criticalPath[index]}\u0000${id}`),
  );

  const columnStep = BACKLOG_GRAPH_NODE_WIDTH + COLUMN_GAP;
  const rowStep = BACKLOG_GRAPH_NODE_HEIGHT + ROW_GAP;
  const tallest = order.reduce((max, layer) => Math.max(max, layer.length), 0);
  const graphHeight = tallest === 0 ? 0 : tallest * rowStep - ROW_GAP;
  const position = new Map<string, { x: number; y: number; layer: number | null }>();
  order.forEach((layer, layerIndex) => {
    const layerHeight = layer.length * rowStep - ROW_GAP;
    const top = PADDING + (graphHeight - layerHeight) / 2;
    layer.forEach((id, index) =>
      position.set(id, {
        x: PADDING + layerIndex * columnStep,
        y: top + index * rowStep,
        layer: layerIndex,
      }),
    );
  });

  const looseColumns = Math.max(layerCount, Math.min(looseIds.length, MIN_LOOSE_COLUMNS));
  const looseTop =
    looseIds.length === 0
      ? null
      : PADDING + (graphHeight > 0 ? graphHeight + LOOSE_SECTION_GAP : 0);
  if (looseTop !== null) {
    looseIds.forEach((id, index) =>
      position.set(id, {
        x: PADDING + (index % looseColumns) * columnStep,
        y: looseTop + LOOSE_LABEL_HEIGHT + Math.floor(index / looseColumns) * rowStep,
        layer: null,
      }),
    );
  }
  const looseRows = Math.ceil(looseIds.length / Math.max(looseColumns, 1));
  const contentBottom =
    looseTop !== null
      ? looseTop + LOOSE_LABEL_HEIGHT + looseRows * rowStep - ROW_GAP
      : PADDING + graphHeight;
  const columns = Math.max(layerCount, looseIds.length > 0 ? looseColumns : 0);

  return {
    nodes: nodes.map((node) => {
      const at = position.get(node.id)!;
      return {
        id: node.id,
        open: node.open,
        layer: at.layer,
        x: at.x,
        y: at.y,
        critical: criticalNodes.has(node.id),
      };
    }),
    edges: edges.map((edge) => {
      const from = position.get(edge.from)!;
      const to = position.get(edge.to)!;
      return {
        ...edge,
        critical: criticalEdges.has(`${edge.from}\u0000${edge.to}`),
        cyclic: cyclic.has(edge),
        x1: from.x + BACKLOG_GRAPH_NODE_WIDTH,
        y1: from.y + BACKLOG_GRAPH_NODE_HEIGHT / 2,
        x2: to.x,
        y2: to.y + BACKLOG_GRAPH_NODE_HEIGHT / 2,
      };
    }),
    criticalPath,
    looseTop,
    width: columns === 0 ? 0 : PADDING * 2 + columns * columnStep - COLUMN_GAP,
    height: ids.length === 0 ? 0 : contentBottom + PADDING,
  };
}

// Issues

export interface BacklogGraphIssue {
  readonly environmentId: EnvironmentId;
  readonly issue: BacklogIssue;
}

/**
 * Graph input for a scope's issues. Blockers live on the same backlog, so on the same machine.
 * Sorted by machine then issue number, which is what makes the layout stable across updates.
 */
export function backlogGraphNodes(
  items: ReadonlyArray<BacklogGraphIssue>,
): ReadonlyArray<BacklogGraphInputNode> {
  return items
    .toSorted(
      (left, right) =>
        (left.environmentId < right.environmentId
          ? -1
          : left.environmentId > right.environmentId
            ? 1
            : 0) ||
        (left.issue.backlogId < right.issue.backlogId
          ? -1
          : left.issue.backlogId > right.issue.backlogId
            ? 1
            : 0) ||
        left.issue.number - right.issue.number,
    )
    .map((item) => ({
      id: boardIssueKey(item.environmentId, item.issue.id),
      blockers: item.issue.blockedBy.map((blockerId) =>
        boardIssueKey(item.environmentId, blockerId),
      ),
      open: !isBacklogStatusClosed(item.issue.status),
    }));
}
