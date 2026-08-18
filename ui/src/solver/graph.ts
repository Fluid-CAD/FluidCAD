// Mate graph + BFS spanning forest.
//
// Replaces the per-mate-type ordering of warm-start invocations with a
// graph-aware schedule. For each connected component of the mate graph
// we pick the BFS roots — ALL grounded bodies in the component, so no
// grounded body can ever become a tree-edge follower and be relocated
// by the solver; with no grounded body, the dragged body if in the
// component, else the first body by input order — then run a
// multi-source BFS to a spanning forest and classify the remaining
// edges as closures. Any mate reaching an already-visited body (which
// includes every grounded root from layer 0) is a closure edge.
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

import { mateSideIds, type BodyState, type ConnectorState, type MateRecord } from './types.js';
import { resolveContact } from './contact-model.js';

export type TreeEdge = {
  parent: BodyState;
  child: BodyState;
  parentConn: ConnectorState;
  childConn: ConnectorState;
  mate: MateRecord;
  /**
   * True when `parentConn` is the mate's connectorA — i.e., the BFS
   * traverses the mate in its authored direction. Mate options
   * (rotate/offset/flip/limits) are defined in connector A's frame, so
   * a reversed edge (`parentIsA: false`) must be posed through the
   * INVERSE of the authored relation. Without this, option semantics
   * silently depended on traversal direction (which part is grounded).
   */
  parentIsA: boolean;
};

export type Component = {
  /** Every body in this component, in BFS visitation order (roots first). */
  bodies: BodyState[];
  /**
   * Tree edges in BFS visitation order. The multi-source BFS produces a
   * spanning forest (one tree per root), so
   * length = bodies.length - roots.length.
   */
  treeEdges: TreeEdge[];
  /** Mates that close cycles (do not appear in treeEdges). */
  closureEdges: MateRecord[];
  /**
   * Tangent (contact) mates in this component. They count for component
   * connectivity but are NEVER spanning-forest edge candidates — they
   * contribute residual rows to the LM exactly like closure edges (kept
   * separate for clarity; LM treats both as row sources).
   */
  contactEdges: MateRecord[];
  /** Set of instance ids that lie on at least one cycle. */
  loopBodies: Set<string>;
  /**
   * Roots of the BFS forest: ALL grounded bodies in the component, plus
   * one root per tree-connected cluster the connector-mate BFS can't
   * reach (a body attached only through contact edges is un-parented by
   * the contact-free spanning forest and becomes an additional —
   * ungrounded — root). Components with no grounded body and no contact
   * edges keep the single fallback root (dragged body if present, else
   * first by input order).
   */
  roots: BodyState[];
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
  // Moot — contact edges never enter tree candidacy (kept for the
  // exhaustive-record type check).
  tangent: 7,
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

  // Adjacency (tree-edge candidates), with both directions stored so BFS
  // can walk either way. Contact (tangent) mates are EXCLUDED — they are
  // never spanning-forest candidates — and tracked separately below.
  const adjacency = new Map<string, AdjEntry[]>();
  for (const b of bodies) adjacency.set(b.instanceId, []);
  // Contact mates count for component CONNECTIVITY only (a ball touching
  // a grounded plate is one component — one LM problem).
  const contactNeighbors = new Map<string, BodyState[]>();
  for (const b of bodies) contactNeighbors.set(b.instanceId, []);
  const contactMates: MateRecord[] = [];
  for (const mate of mates) {
    if (mate.type === 'tangent') {
      // Both sides must resolve to a supported classified exposure —
      // unresolvable contact mates are dropped like invalid connector
      // mates (the record-build layer reports them loudly upstream).
      const rc = resolveContact(mate, byId);
      if (!rc) continue;
      contactMates.push(mate);
      contactNeighbors.get(rc.a.instanceId)!.push(rc.b);
      contactNeighbors.get(rc.b.instanceId)!.push(rc.a);
      continue;
    }
    if (!mate.connectorA || !mate.connectorB) continue;
    const aBody = byId.get(mate.connectorA.instanceId);
    const bBody = byId.get(mate.connectorB.instanceId);
    if (!aBody || !bBody) continue;
    const aConn = aBody.connectors.find(c => c.connectorId === mate.connectorA!.connectorId);
    const bConn = bBody.connectors.find(c => c.connectorId === mate.connectorB!.connectorId);
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
    // Contact mates count here — a ball touching a grounded plate is one
    // component — even though they never become tree edges below.
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
      for (const neighbor of contactNeighbors.get(b.instanceId)!) {
        if (!inComponent.has(neighbor.instanceId)) {
          discoverQueue.push(neighbor);
        }
      }
    }

    const contactEdges = contactMates.filter(m =>
      inComponent.has(m.geometryA!.instanceId));

    // Root selection. ALL grounded bodies are roots: pre-visiting every
    // grounded body means a mate reaching one classifies as a closure
    // edge, so the solver can never relocate a grounded body through a
    // tree-edge warm-start. Components without a grounded body get a
    // single root: dragged body if present, else first by input order.
    let roots = componentBodies.filter(b => b.grounded);
    if (roots.length === 0 && draggedInstanceId) {
      const dragged = componentBodies.find(b => b.instanceId === draggedInstanceId);
      if (dragged) roots = [dragged];
    }
    if (roots.length === 0) roots = [componentBodies[0]];

    // Multi-source BFS spanning forest from the roots, layer-by-layer so
    // we can resolve multi-edge tiebreaks within a layer by mate rigidity.
    const treeEdges: TreeEdge[] = [];
    const closureMates: MateRecord[] = [];
    const orderedBodies: BodyState[] = [...roots];
    const treeVisited = new Set<string>(roots.map(r => r.instanceId));
    const consumedMates = new Set<string>();

    let frontier: BodyState[] = [...roots];
    // Outer loop: the tree adjacency omits contact mates, so a component
    // held together only by contacts splits into several tree-connected
    // clusters. Each unreached cluster gets its own (ungrounded) root —
    // the LM gives every ungrounded forest root a 6-var pose block.
    for (;;) {
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
            parentIsA: treePick.selfIsA,
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

      // Seed the next contact-only cluster, preferring the dragged body
      // as its root (same policy as the ungrounded-component fallback).
      let extraRoot = componentBodies.find(b => !treeVisited.has(b.instanceId));
      if (!extraRoot) break;
      if (draggedInstanceId && !treeVisited.has(draggedInstanceId)) {
        const dragged = componentBodies.find(b => b.instanceId === draggedInstanceId);
        if (dragged) extraRoot = dragged;
      }
      roots.push(extraRoot);
      treeVisited.add(extraRoot.instanceId);
      orderedBodies.push(extraRoot);
      frontier = [extraRoot];
    }

    const loopBodies = identifyLoopBodies(closureMates, treeEdges);

    const componentIndex = components.length;
    components.push({
      bodies: orderedBodies,
      treeEdges,
      closureEdges: closureMates,
      contactEdges,
      loopBodies,
      roots,
    });
    for (const b of orderedBodies) {
      bodyComponent.set(b.instanceId, componentIndex);
      visited.add(b.instanceId);
    }
  }

  return { components, bodyComponent };
}

/**
 * True iff the body's path through the component's spanning forest to
 * its root is entirely fastened tree edges AND that root is grounded —
 * i.e., the body has zero effective DOFs upstream and any drag on it
 * would drift its (non-locked) followers without moving the body
 * itself. A grounded body trivially qualifies (it is its own root).
 * Bodies whose tree root is not grounded are not locked.
 */
export function isFullyLocked(instanceId: string, component: Component): boolean {
  const parentByChild = new Map<string, TreeEdge>();
  for (const edge of component.treeEdges) {
    parentByChild.set(edge.child.instanceId, edge);
  }
  let current = instanceId;
  while (true) {
    const edge = parentByChild.get(current);
    if (!edge) {
      const root = component.roots.find(r => r.instanceId === current);
      return root !== undefined && root.grounded;
    }
    if (edge.mate.type !== 'fastened') return false;
    current = edge.parent.instanceId;
  }
}

/**
 * Convenience wrapper: looks up the body's component in the graph and
 * returns whether it is fully locked. Returns `false` for instance ids
 * not in the graph.
 */
export function isInstanceFullyLocked(instanceId: string, graph: MateGraph): boolean {
  const idx = graph.bodyComponent.get(instanceId);
  if (idx === undefined) return false;
  return isFullyLocked(instanceId, graph.components[idx]);
}

/**
 * Identify the bodies that lie on at least one cycle in the component.
 * Walks parent links from each closure-edge endpoint up to their LCA.
 * When the endpoints live in two different trees of the spanning forest
 * (a closure between two grounded roots' trees), there is no LCA — both
 * walks run to their respective roots and both full paths are marked.
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
    const sides = mateSideIds(mate);
    if (!sides) continue;
    const { aId, bId } = sides;

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
