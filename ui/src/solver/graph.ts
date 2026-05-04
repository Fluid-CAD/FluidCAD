// Mate graph + BFS spanning tree.
//
// Replaces the per-mate-type ordering of warm-start invocations with a
// graph-aware schedule. For each connected component of the mate graph
// we pick a seed (grounded body if any, then dragged body if in
// component, then first body by input order), BFS to a spanning tree,
// and classify the remaining edges as closures.
//
// Stage 1 of the closed-loop solver uses only the tree edges:
// warm-starts run in BFS order (parent already laid out → child is the
// follower of this edge). Closure edges are detected and reported but
// not yet enforced — that's stage 2's LM relaxation pass.
//
// Edge tiebreak when two mates connect a frontier body to the same
// not-yet-visited neighbor: prefer the most rigid mate type (fastened
// > revolute = slider > cylindrical > planar > parallel > pin-slot).
// This matches the pre-rewrite per-type warm-start ordering for the
// common case of two mates between the same body pair, so the more
// rigid mate is honored as the tree edge and the looser one defers to
// LM as a closure.

import type { BodyState, ConnectorState, MateRecord } from './types.js';

export type TreeEdge = {
  parent: BodyState;
  child: BodyState;
  parentConn: ConnectorState;
  childConn: ConnectorState;
  mate: MateRecord;
};

export type Component = {
  /** Every body in this component, in BFS visitation order (seed first). */
  bodies: BodyState[];
  /** Tree edges in BFS visitation order. Length = bodies.length - 1. */
  treeEdges: TreeEdge[];
  /** Mates that close cycles (do not appear in treeEdges). */
  closureEdges: MateRecord[];
  /** Set of instance ids that lie on at least one cycle. */
  loopBodies: Set<string>;
  /** Root of the BFS. */
  seed: BodyState;
};

export type MateGraph = {
  components: Component[];
  /** instanceId → component index. */
  bodyComponent: Map<string, number>;
};

// Lower number = more rigid → preferred as tree edge.
const MATE_RIGIDITY: Record<MateRecord['type'], number> = {
  fastened: 0,
  revolute: 1,
  slider: 2,
  cylindrical: 3,
  planar: 4,
  'pin-slot': 5,
  parallel: 6,
};

type AdjEntry = {
  neighbor: BodyState;
  selfConn: ConnectorState;
  neighborConn: ConnectorState;
  mate: MateRecord;
  /** True when `selfConn` is mate.connectorA (i.e., the mate's A side
   *  is the body whose adjacency this entry belongs to). Lets the
   *  warm-start dispatcher reconstruct the right driver/follower pair
   *  no matter which way the BFS direction maps onto mate authorship. */
  selfIsA: boolean;
};

/**
 * Build the mate graph: connected components, BFS spanning tree per
 * component, closure edges, loop-body sets.
 *
 * Invalid mates (referencing missing bodies or connectors) are dropped
 * silently — they would be reported as failed by an upstream layer
 * before reaching the solver.
 */
export function buildMateGraph(
  bodies: BodyState[],
  mates: MateRecord[],
  draggedInstanceId?: string,
): MateGraph {
  const byId = new Map(bodies.map(b => [b.instanceId, b]));

  // Adjacency, with both directions stored so BFS can walk either way.
  const adjacency = new Map<string, AdjEntry[]>();
  for (const b of bodies) adjacency.set(b.instanceId, []);
  for (const mate of mates) {
    const aBody = byId.get(mate.connectorA.instanceId);
    const bBody = byId.get(mate.connectorB.instanceId);
    if (!aBody || !bBody) continue;
    const aConn = aBody.connectors.find(c => c.connectorId === mate.connectorA.connectorId);
    const bConn = bBody.connectors.find(c => c.connectorId === mate.connectorB.connectorId);
    if (!aConn || !bConn) continue;
    adjacency.get(aBody.instanceId)!.push({
      neighbor: bBody, selfConn: aConn, neighborConn: bConn, mate, selfIsA: true,
    });
    adjacency.get(bBody.instanceId)!.push({
      neighbor: aBody, selfConn: bConn, neighborConn: aConn, mate, selfIsA: false,
    });
  }

  const visited = new Set<string>();
  const components: Component[] = [];
  const bodyComponent = new Map<string, number>();

  for (const startBody of bodies) {
    if (visited.has(startBody.instanceId)) continue;

    // Discover the component via plain BFS (any seed works for component
    // membership; spanning-tree BFS happens below from the chosen seed).
    const componentBodies: BodyState[] = [];
    const inComponent = new Set<string>();
    const discoverQueue: BodyState[] = [startBody];
    while (discoverQueue.length > 0) {
      const b = discoverQueue.shift()!;
      if (inComponent.has(b.instanceId)) continue;
      inComponent.add(b.instanceId);
      componentBodies.push(b);
      for (const adj of adjacency.get(b.instanceId)!) {
        if (!inComponent.has(adj.neighbor.instanceId)) {
          discoverQueue.push(adj.neighbor);
        }
      }
    }

    // Seed selection. Grounded > dragged > first by input order.
    let seed = componentBodies.find(b => b.grounded);
    if (!seed && draggedInstanceId) {
      seed = componentBodies.find(b => b.instanceId === draggedInstanceId);
    }
    if (!seed) seed = componentBodies[0];

    // BFS spanning tree from seed, layer-by-layer so we can resolve
    // multi-edge tiebreaks within a layer by mate rigidity.
    const treeEdges: TreeEdge[] = [];
    const closureMates: MateRecord[] = [];
    const orderedBodies: BodyState[] = [seed];
    const treeVisited = new Set<string>([seed.instanceId]);
    const consumedMates = new Set<string>();

    let frontier: BodyState[] = [seed];
    while (frontier.length > 0) {
      // Group candidate edges by target body so we can pick the most
      // rigid edge per target as the tree edge.
      type Candidate = AdjEntry & { from: BodyState };
      const candidatesByTarget = new Map<string, Candidate[]>();

      for (const fromBody of frontier) {
        for (const adj of adjacency.get(fromBody.instanceId)!) {
          if (consumedMates.has(adj.mate.mateId)) continue;
          if (treeVisited.has(adj.neighbor.instanceId)) {
            // Edge connects two already-visited bodies → closure edge.
            consumedMates.add(adj.mate.mateId);
            closureMates.push(adj.mate);
            continue;
          }
          const list = candidatesByTarget.get(adj.neighbor.instanceId) ?? [];
          list.push({ ...adj, from: fromBody });
          candidatesByTarget.set(adj.neighbor.instanceId, list);
        }
      }

      const nextFrontier: BodyState[] = [];
      for (const candidates of candidatesByTarget.values()) {
        candidates.sort((c1, c2) =>
          MATE_RIGIDITY[c1.mate.type] - MATE_RIGIDITY[c2.mate.type]);
        const treePick = candidates[0];
        consumedMates.add(treePick.mate.mateId);
        treeEdges.push({
          parent: treePick.from,
          child: treePick.neighbor,
          parentConn: treePick.selfConn,
          childConn: treePick.neighborConn,
          mate: treePick.mate,
        });
        treeVisited.add(treePick.neighbor.instanceId);
        orderedBodies.push(treePick.neighbor);
        nextFrontier.push(treePick.neighbor);

        // Other candidates to the same target are closure edges.
        for (let i = 1; i < candidates.length; i++) {
          if (consumedMates.has(candidates[i].mate.mateId)) continue;
          consumedMates.add(candidates[i].mate.mateId);
          closureMates.push(candidates[i].mate);
        }
      }
      frontier = nextFrontier;
    }

    const loopBodies = identifyLoopBodies(closureMates, treeEdges);

    const componentIndex = components.length;
    components.push({
      bodies: orderedBodies,
      treeEdges,
      closureEdges: closureMates,
      loopBodies,
      seed,
    });
    for (const b of orderedBodies) {
      bodyComponent.set(b.instanceId, componentIndex);
      visited.add(b.instanceId);
    }
  }

  return { components, bodyComponent };
}

/**
 * Identify the bodies that lie on at least one cycle in the component.
 * Walks parent links from each closure-edge endpoint up to their LCA.
 */
function identifyLoopBodies(
  closureMates: MateRecord[],
  treeEdges: TreeEdge[],
): Set<string> {
  if (closureMates.length === 0) return new Set();

  const parent = new Map<string, string>();
  for (const e of treeEdges) {
    parent.set(e.child.instanceId, e.parent.instanceId);
  }

  const loop = new Set<string>();
  for (const mate of closureMates) {
    const aId = mate.connectorA.instanceId;
    const bId = mate.connectorB.instanceId;

    const aPath: string[] = [];
    const aSet = new Set<string>();
    let cur: string | undefined = aId;
    while (cur !== undefined) {
      aPath.push(cur);
      aSet.add(cur);
      cur = parent.get(cur);
    }

    const bPath: string[] = [];
    cur = bId;
    while (cur !== undefined && !aSet.has(cur)) {
      bPath.push(cur);
      cur = parent.get(cur);
    }
    const lca = cur;

    for (const id of aPath) {
      loop.add(id);
      if (id === lca) break;
    }
    for (const id of bPath) loop.add(id);
    if (lca !== undefined) loop.add(lca);
  }
  return loop;
}
