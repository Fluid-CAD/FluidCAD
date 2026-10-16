// Exact elimination of relation constraints over joint coordinates.
//
// A relation whose two sides are tree-edge joint coordinates of the loop
// relaxation (a revolute's angle, a slider's travel) is LINEAR in those
// coordinates: forward kinematics poses each tree edge's child from its
// own parameter, so a side's value is ± that coordinate plus a constant.
// Linearized at the start of the solve, each relation is one row
//
//     coefA·δ[slotA] + coefB·δ[slotB] = rhs        (δ = x − x0)
//
// and a set of rows is solved in closed form instead of being traded off
// against the drag pull in the least-squares cost (the planetary-drag
// bug: a grab point that a carrier turn AND a planet spin can both move
// let the LM break the mesh to reach the cursor).
//
// Rows form a graph over joint coordinates. Each connected group keeps ONE
// free coordinate t, every member is affine in it — δᵢ = pᵢ + kᵢ·t — and
// the LM varies t alone, so every relation in the group holds exactly at
// every LM step. Groups are built incrementally in relation (authored)
// order with a union-find:
//
//   - a row joining two groups re-expresses the second group's members in
//     the first group's t (kᵢ is a product of ± gear ratios, never zero);
//   - a row inside one group (a cycle) is REDUNDANT when its homogeneous
//     part vanishes on the group's motion, α_u·k_u + α_v·k_v ≈ 0 (the
//     six-relation planetary: each planet tied to both sun and ring) and is
//     then dropped as implied; otherwise its ratios CONTRADICT the others
//     around the cycle — it would lock the group — so it is dropped from
//     the exact set and reported, deterministically the later relation in
//     authored order that closes the cycle.
//
// The contradiction test looks at ratios only (k), never at the start
// values, so the verdict does not depend on how far anything moved.
// A group holding a FIXED coordinate (the joint a kinematic driver holds)
// is pinned: its t is solved so the fixed member stays put.

/** Ratio agreement (relative) below which a cycle-closing relation is implied, not contradictory. */
export const RATIO_TOL = 1e-6;

export type RelationRow = {
  relationId: string;
  slotA: number;
  slotB: number;
  coefA: number;
  coefB: number;
  rhs: number;
};

export type GroupMember = {
  slot: number;
  /** δ = p + k·t (k = 0 in a pinned group). */
  p: number;
  k: number;
};

export type RelationGroup = {
  members: GroupMember[];
  /** True when a fixed member pins the group: no free coordinate. */
  pinned: boolean;
  /**
   * Start value of t: the least-motion point of the group's line
   * (minimizes Σ δᵢ²), or 0 when pinned (unused).
   */
  t0: number;
  /** Ids of the relations the group enforces exactly (tree + implied chords). */
  relationIds: string[];
};

export type RelationElimination = {
  groups: RelationGroup[];
  /** Relations dropped because their ratios contradict others around a cycle. */
  contradicted: string[];
};

type Node = { group: number; p: number; k: number };

export class RelationGroups {
  /**
   * Build the groups from `rows` (in authored order). `fixedSlots` are the
   * coordinates a kinematic driver holds: a group containing one is pinned.
   */
  static eliminate(rows: RelationRow[], fixedSlots: ReadonlySet<number>): RelationElimination {
    const nodes = new Map<number, Node>();
    const groupMembers: number[][] = [];
    const groupRelations: string[][] = [];
    const contradicted: string[] = [];

    const nodeOf = (slot: number): Node => {
      let node = nodes.get(slot);
      if (!node) {
        node = { group: groupMembers.length, p: 0, k: 1 };
        nodes.set(slot, node);
        groupMembers.push([slot]);
        groupRelations.push([]);
      }
      return node;
    };

    for (const row of rows) {
      const u = nodeOf(row.slotA);
      const v = nodeOf(row.slotB);
      // A relation from a coordinate to itself: both sides share the node.
      const au = row.coefA;
      const av = row.coefB;
      if (u.group === v.group) {
        const h = row.slotA === row.slotB ? (au + av) * u.k : au * u.k + av * v.k;
        const scale = row.slotA === row.slotB
          ? (Math.abs(au) + Math.abs(av)) * Math.abs(u.k)
          : Math.abs(au * u.k) + Math.abs(av * v.k);
        if (Math.abs(h) > RATIO_TOL * scale) contradicted.push(row.relationId);
        else groupRelations[u.group].push(row.relationId);
        continue;
      }
      // Join: re-express v's group in u's t. With δ_u = p_u + k_u·t and
      // δ_v = p_v + k_v·s, the row fixes s = (c − a·t) / (av·k_v) where
      // c = rhs − au·p_u − av·p_v and a = au·k_u.
      const from = v.group;
      const into = u.group;
      const c = row.rhs - au * u.p - av * v.p;
      const a = au * u.k;
      const denom = av * v.k;
      for (const slot of groupMembers[from]) {
        const w = nodes.get(slot)!;
        w.p += (w.k * c) / denom;
        w.k = (-w.k * a) / denom;
        w.group = into;
      }
      groupMembers[into].push(...groupMembers[from]);
      groupMembers[from] = [];
      groupRelations[into].push(...groupRelations[from], row.relationId);
      groupRelations[from] = [];
    }

    const groups: RelationGroup[] = [];
    groupMembers.forEach((slots, g) => {
      if (slots.length === 0) return;
      const members = slots.map(slot => {
        const n = nodes.get(slot)!;
        return { slot, p: n.p, k: n.k };
      });
      const fixed = members.find(m => fixedSlots.has(m.slot));
      if (fixed) {
        // Pin: t such that the held coordinate does not move.
        const t = -fixed.p / fixed.k;
        for (const m of members) {
          m.p += m.k * t;
          m.k = 0;
        }
        groups.push({ members, pinned: true, t0: 0, relationIds: groupRelations[g] });
        return;
      }
      let pk = 0;
      let kk = 0;
      for (const m of members) {
        pk += m.p * m.k;
        kk += m.k * m.k;
      }
      groups.push({ members, pinned: false, t0: kk > 0 ? -pk / kk : 0, relationIds: groupRelations[g] });
    });
    return { groups, contradicted };
  }

  /**
   * The interval of t keeping every member inside its box, given each
   * member's start value `start(slot)` (at t = t0 − the member's own
   * branch) and bounds. Null bounds are unlimited. Returns [lo, hi]; lo >
   * hi when the boxes don't overlap along the group's line.
   */
  static tInterval(
    group: RelationGroup,
    bounds: (slot: number) => { min: number; max: number; offset: number } | null,
  ): [number, number] {
    let lo = -Infinity;
    let hi = Infinity;
    for (const m of group.members) {
      const b = bounds(m.slot);
      if (!b || m.k === 0) continue;
      // value(t) = offset + p + k·t ∈ [min, max]
      const t1 = (b.min - b.offset - m.p) / m.k;
      const t2 = (b.max - b.offset - m.p) / m.k;
      lo = Math.max(lo, Math.min(t1, t2));
      hi = Math.min(hi, Math.max(t1, t2));
    }
    return [lo, hi];
  }
}
