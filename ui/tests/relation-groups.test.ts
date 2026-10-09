import { describe, expect, it } from 'vitest';
import { RATIO_TOL, RelationGroups, type RelationRow } from '../src/solver/relation-groups';

// The pure elimination behind exact relations: rows
// coefA·δ[slotA] + coefB·δ[slotB] = rhs grouped into lines δᵢ = pᵢ + kᵢ·t.

/** A gear row δb = g·δa (+ an optional start mismatch r0, rhs = −r0). */
function gear(id: string, a: number, b: number, g: number, r0 = 0): RelationRow {
  return { relationId: id, slotA: a, slotB: b, coefA: -g, coefB: 1, rhs: -r0 };
}

/** Every row holds at δ(t) for the given t. */
function holds(rows: RelationRow[], delta: Map<number, number>): boolean {
  return rows.every(r => Math.abs(r.coefA * delta.get(r.slotA)! + r.coefB * delta.get(r.slotB)! - r.rhs) < 1e-12);
}

function deltaAt(elim: ReturnType<typeof RelationGroups.eliminate>, t: number[]): Map<number, number> {
  const out = new Map<number, number>();
  elim.groups.forEach((g, i) => {
    for (const m of g.members) out.set(m.slot, m.p + m.k * (g.pinned ? 0 : t[i]));
  });
  return out;
}

describe('RelationGroups.eliminate', () => {
  it('a chain of relations leaves one free coordinate that drives every member in ratio', () => {
    const rows = [gear('a', 0, 1, -18 / 30), gear('b', 1, 2, 3)];
    const elim = RelationGroups.eliminate(rows, new Set());
    expect(elim.contradicted).toEqual([]);
    expect(elim.groups).toHaveLength(1);
    expect(elim.groups[0].pinned).toBe(false);
    expect(elim.groups[0].relationIds).toEqual(['a', 'b']);
    for (const t of [-2, 0.3, 7]) expect(holds(rows, deltaAt(elim, [t]))).toBe(true);
    const k = new Map(elim.groups[0].members.map(m => [m.slot, m.k]));
    expect(k.get(1)! / k.get(0)!).toBeCloseTo(-18 / 30, 12);
    expect(k.get(2)! / k.get(0)!).toBeCloseTo((-18 / 30) * 3, 12);
  });

  it('joining two existing groups re-expresses the second in the first one\'s coordinate', () => {
    // 0–1 and 2–3 grouped separately, then joined by 1–2.
    const rows = [gear('a', 0, 1, 2), gear('b', 2, 3, 0.5), gear('c', 1, 2, -4)];
    const elim = RelationGroups.eliminate(rows, new Set());
    expect(elim.groups).toHaveLength(1);
    expect(elim.groups[0].members.map(m => m.slot).sort()).toEqual([0, 1, 2, 3]);
    for (const t of [-1, 0.25, 3]) expect(holds(rows, deltaAt(elim, [t]))).toBe(true);
  });

  it('a consistent cycle is redundant: the closing relation is implied, the group keeps its freedom', () => {
    // The six-relation planetary shape: carrier→planet, carrier→sun, planet→sun agree.
    const rows = [gear('cp', 0, 1, -60 / 21), gear('cs', 0, 2, 78 / 18), gear('ps', 1, 2, (78 / 18) / (-60 / 21))];
    const elim = RelationGroups.eliminate(rows, new Set());
    expect(elim.contradicted).toEqual([]);
    expect(elim.groups).toHaveLength(1);
    expect(elim.groups[0].relationIds).toEqual(['cp', 'cs', 'ps']);
    for (const t of [-5, 1.5]) expect(holds(rows, deltaAt(elim, [t]))).toBe(true);
  });

  it('a contradictory cycle drops the relation that closes it, whatever the motion', () => {
    const rows = [gear('ab', 0, 1, 2), gear('bc', 1, 2, 3), gear('ca', 2, 0, 1 / 5)];
    for (const r0 of [0, 0.4]) {
      const elim = RelationGroups.eliminate([rows[0], rows[1], { ...rows[2], rhs: -r0 }], new Set());
      expect(elim.contradicted).toEqual(['ca']);
      expect(elim.groups).toHaveLength(1);
      expect(elim.groups[0].relationIds).toEqual(['ab', 'bc']);
    }
  });

  it('ratios agreeing within the tolerance are implied, not contradictory', () => {
    const g = 60 / 21;
    const near = [gear('a', 0, 1, g), gear('b', 1, 2, 1.5), gear('c', 0, 2, g * 1.5 * (1 + RATIO_TOL / 10))];
    expect(RelationGroups.eliminate(near, new Set()).contradicted).toEqual([]);
    const off = [gear('a', 0, 1, g), gear('b', 1, 2, 1.5), gear('c', 0, 2, g * 1.5 * (1 + RATIO_TOL * 10))];
    expect(RelationGroups.eliminate(off, new Set()).contradicted).toEqual(['c']);
  });

  it('a relation from a coordinate to itself is implied at ratio 1 and contradictory otherwise', () => {
    expect(RelationGroups.eliminate([gear('same', 0, 0, 1)], new Set()).contradicted).toEqual([]);
    expect(RelationGroups.eliminate([gear('same', 0, 0, 2)], new Set()).contradicted).toEqual(['same']);
  });

  it('a held coordinate pins its group: every member is fixed where the held one stays put', () => {
    // The driver moved slot 0 already (it is held there): r0 says slot 1 lags.
    const rows = [gear('a', 0, 1, 2, -0.3), gear('b', 1, 2, -1)];
    const elim = RelationGroups.eliminate(rows, new Set([0]));
    expect(elim.groups).toHaveLength(1);
    const g = elim.groups[0];
    expect(g.pinned).toBe(true);
    const d = new Map(g.members.map(m => [m.slot, m.p]));
    expect(d.get(0)).toBeCloseTo(0, 12);
    expect(d.get(1)).toBeCloseTo(0.3, 12);
    expect(d.get(2)).toBeCloseTo(-0.3, 12);
    expect(g.members.every(m => m.k === 0)).toBe(true);
    expect(holds(rows, d)).toBe(true);
  });

  it('the start of a free group is its least-motion point', () => {
    // δ1 = 2·δ0 + 1 (a mismatched start): minimize δ0² + δ1².
    const elim = RelationGroups.eliminate([gear('a', 0, 1, 2, -1)], new Set());
    const g = elim.groups[0];
    const at = (t: number) => g.members.reduce((s, m) => s + (m.p + m.k * t) ** 2, 0);
    expect(at(g.t0)).toBeLessThanOrEqual(at(g.t0 + 1e-4));
    expect(at(g.t0)).toBeLessThanOrEqual(at(g.t0 - 1e-4));
    expect(holds([gear('a', 0, 1, 2, -1)], deltaAt(elim, [g.t0]))).toBe(true);
  });

  it('separate trains stay separate groups', () => {
    const elim = RelationGroups.eliminate([gear('a', 0, 1, 2), gear('b', 2, 3, 2)], new Set());
    expect(elim.groups).toHaveLength(2);
  });
});

describe('RelationGroups.tInterval', () => {
  it('intersects every limited member\'s box along the group\'s line, either sign of k', () => {
    const elim = RelationGroups.eliminate([gear('a', 0, 1, -2)], new Set());
    const g = elim.groups[0];
    // slot 0 in [−1, 3], slot 1 (= −2·δ0) in [−4, 1] ⇒ δ0 ∈ [−0.5, 2]: t ∈ [−0.5, 2] (k0 = 1).
    const [lo, hi] = RelationGroups.tInterval(g, slot => (slot === 0
      ? { min: -1, max: 3, offset: 0 }
      : { min: -4, max: 1, offset: 0 }));
    expect(lo).toBeCloseTo(-0.5, 12);
    expect(hi).toBeCloseTo(2, 12);
  });

  it('reports an empty interval when the boxes do not overlap along the line', () => {
    const g = RelationGroups.eliminate([gear('a', 0, 1, 1)], new Set()).groups[0];
    const [lo, hi] = RelationGroups.tInterval(g, slot => (slot === 0
      ? { min: 0, max: 1, offset: 0 }
      : { min: 2, max: 3, offset: 0 }));
    expect(lo).toBeGreaterThan(hi);
  });
});

describe('RelationGroups — randomized consistent graphs', () => {
  // Deterministic LCG so a failure reproduces.
  function rng(seed: number): () => number {
    let s = seed >>> 0;
    return () => {
      s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
      return s / 2 ** 32;
    };
  }

  it('every consistent relation graph (trees plus implied chords) is held exactly along its line', () => {
    for (let trial = 0; trial < 200; trial++) {
      const rand = rng(trial + 1);
      const n = 2 + Math.floor(rand() * 7);
      // Hidden per-coordinate gains: δᵢ = sᵢ·u for a common motion u.
      const s = Array.from({ length: n }, () => (rand() < 0.5 ? -1 : 1) * (0.2 + rand() * 4));
      const rows: RelationRow[] = [];
      // A random spanning tree in random order, then random chords; every
      // ratio is s_b / s_a so all of them agree.
      const order = Array.from({ length: n }, (_, i) => i).sort(() => rand() - 0.5);
      for (let i = 1; i < n; i++) {
        const a = order[Math.floor(rand() * i)];
        const b = order[i];
        rows.push(gear(`t${i}`, a, b, s[b] / s[a]));
      }
      const chords = Math.floor(rand() * 4);
      for (let c = 0; c < chords; c++) {
        const a = Math.floor(rand() * n);
        const b = Math.floor(rand() * n);
        rows.push(gear(`c${c}`, a, b, s[b] / s[a]));
      }
      rows.sort(() => rand() - 0.5);
      const elim = RelationGroups.eliminate(rows, new Set());
      expect(elim.contradicted).toEqual([]);
      expect(elim.groups).toHaveLength(1);
      const t = (rand() - 0.5) * 20;
      const d = deltaAt(elim, [t]);
      for (const r of rows) {
        const miss = r.coefA * d.get(r.slotA)! + r.coefB * d.get(r.slotB)! - r.rhs;
        expect(Math.abs(miss)).toBeLessThan(1e-9 * (1 + Math.abs(t)) * 50);
      }
    }
  });
});
