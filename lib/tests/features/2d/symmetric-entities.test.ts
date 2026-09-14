// symmetric() between whole entities (two lines / two circles / two arcs)
// across a sketched line or a datum axis — the statement the constraint-
// native Mirror tool writes, one per mirrored entity.
import { describe, it, expect } from "vitest";
import { setupOC, render } from "../../setup.js";
import sketch from "../../../core/sketch.js";
import { line, circle, arc, yAxis } from "../../../core/2d/index.js";
import { symmetric, fix, distance, radius, vertical } from "../../../core/constraints/index.js";
import { Sketch } from "../../../features/2d/sketch.js";
import { Scene } from "../../../rendering/scene.js";
import type { ISceneObject, ISolvedCircle, ISolvedLine } from "../../../core/interfaces.js";

type SnapshotSystem = {
  entities: { id: number; kind: 'point' | 'line' | 'circle' | 'arc'; paramOffset: number }[];
  params: number[];
  outcome: string | null;
  dof: number | null;
  redundant: number[];
};
const PARAM_COUNT = { point: 2, line: 4, circle: 3, arc: 7 } as const;
const entityIdOf = (obj: unknown): number => (obj as { entityId: number }).entityId;
const snapshotOf = (sk: unknown): SnapshotSystem => (sk as Sketch).getState('solver-system') as SnapshotSystem;
function paramsOf(sk: unknown, entityId: number): number[] {
  const sys = snapshotOf(sk);
  const record = sys.entities.find(e => e.id === entityId)!;
  return sys.params.slice(record.paramOffset, record.paramOffset + PARAM_COUNT[record.kind]);
}
function renderedErrors(scene: Scene): string[] {
  return scene.getRenderedObjects().filter(r => r.errorMessage).map(r => `${r.uniqueType}: ${r.errorMessage}`);
}

describe("symmetric() entity forms", () => {
  setupOC();

  it("two lines across yAxis(): dimensioning the image drives the source", () => {
    let sk: unknown;
    let a: ISolvedLine;
    let b: ISolvedLine;
    sk = sketch('xy', () => {
      a = line([10, 0], [30, 6]);
      b = line([-10, 0], [-30, 6]);
      symmetric(a, b, yAxis());
      fix(b.start(), [-10, 0]);
      vertical(b);
      distance(b.start(), b.end(), 25);
    });
    const scene = render();
    expect(renderedErrors(scene)).toEqual([]);
    expect(snapshotOf(sk).outcome).toBe('solved');
    expect(snapshotOf(sk).dof).toBe(0);
    const pa = paramsOf(sk, entityIdOf(a!));
    expect(pa).toEqual([10, 0, 10, 25].map(v => expect.closeTo(v, 6)));
  });

  it("two arcs across a sketched guide line: exact rows, no redundancy, semicircles fine", () => {
    let sk: unknown;
    let img: ISceneObject;
    sk = sketch('xy', () => {
      const axis = line([0, -20], [0, 40]).guide();
      const src = arc([20, -10], [20, 10], [20, 0]);
      img = arc([-20, -10], [-20, 10], [-20, 0]).cw();
      symmetric(src, img, axis);
      fix(axis.start(), [0, -20]);
      fix(axis.end(), [0, 40]);
      fix(src.center(), [25, 3]);
      fix(src.start(), [25, -9]);
      distance(src.start(), src.end(), 20);
    });
    const scene = render();
    expect(renderedErrors(scene)).toEqual([]);
    const sys = snapshotOf(sk);
    expect(sys.outcome).toBe('solved');
    expect(sys.dof).toBe(0);
    expect(sys.redundant).toEqual([]);
    const p = paramsOf(sk, entityIdOf(img!));
    expect(p[0]).toBeCloseTo(-25, 6);
    expect(p[1]).toBeCloseTo(3, 6);
    expect(p[2]).toBeCloseTo(12, 6);
    expect(p[3]).toBeCloseTo(-25, 6);
    expect(p[4]).toBeCloseTo(-9, 6);
  });

  it("two circles: centers mirror and the radius dimension crosses over", () => {
    let sk: unknown;
    let a: ISolvedCircle;
    let b: ISolvedCircle;
    sk = sketch('xy', () => {
      a = circle([20, 5], 14);
      b = circle([-20, 5], 14);
      symmetric(a, b, yAxis());
      fix(a.center(), [22, 6]);
      radius(b, 9);
    });
    const scene = render();
    expect(renderedErrors(scene)).toEqual([]);
    expect(paramsOf(sk, entityIdOf(a!))[2]).toBeCloseTo(9, 6);
    expect(paramsOf(sk, entityIdOf(b!)).slice(0, 2)).toEqual([-22, 6].map(v => expect.closeTo(v, 6)));
  });

  it("mixed forms stash an honest error on the statement", () => {
    sketch('xy', () => {
      const a = line([10, 0], [30, 6]);
      const c = circle([-20, 5], 14);
      symmetric(a, c, yAxis());
    });
    const scene = render();
    expect(renderedErrors(scene).join('\n')).toMatch(/same kind/);
  });
});
