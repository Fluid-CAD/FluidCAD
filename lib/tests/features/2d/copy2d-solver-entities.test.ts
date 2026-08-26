// Constraint targeting of 2D copy() instances: each stamped slot of a
// solver-backed source registers a duplicate entity rigidly tied to it
// (SketchSystem.addTransformTie) at STATEMENT time, `cp.instance(k)` (and
// its .start()/.end()/.center() accessors) resolves to that entity as a
// constraint target, and serialize() ships the entities[] payload joining
// duplicate entities to the copy's sceneShapes.
import { describe, it, expect } from "vitest";
import { setupOC, render } from "../../setup.js";
import { getSceneManager } from "../../../scene-manager.js";
import { SceneCompare } from "../../../rendering/scene-compare.js";
import sketch from "../../../core/sketch.js";
import copy from "../../../core/copy.js";
import { line, circle, point, offset, origin } from "../../../core/2d/index.js";
import {
  parallel, perpendicular, horizontal, vertical, fix, distance, tangent,
} from "../../../core/constraints/index.js";
import local from "../../../core/local.js";
import { Sketch } from "../../../features/2d/sketch.js";
import { Copy2DBase } from "../../../features/copy2d-base.js";
import { Offset } from "../../../features/2d/offset.js";
import { Scene } from "../../../rendering/scene.js";
import type { ICopy, ISceneObject, ISolvedLine } from "../../../core/interfaces.js";

type EntityRecord = { entityId: number; kind: string; slot: number; shapeIndex: number };
type CopyPayload = {
  entities?: EntityRecord[];
  sourceEntities?: number[];
  sourcesSolved?: boolean;
};

const payloadOf = (cp: ICopy): CopyPayload =>
  (cp as unknown as Copy2DBase).serialize() as CopyPayload;

const entityIdOf = (obj: unknown): number => (obj as { entityId: number }).entityId;

type SnapshotSystem = {
  entities: { id: number; kind: 'point' | 'line' | 'circle' | 'arc'; paramOffset: number }[];
  params: number[];
  outcome: string | null;
  dof: number | null;
};

const PARAM_COUNT = { point: 2, line: 4, circle: 3, arc: 7 } as const;

function snapshotOf(sk: unknown): SnapshotSystem {
  return (sk as Sketch).getState('solver-system') as SnapshotSystem;
}

function paramsOf(sk: unknown, entityId: number): number[] {
  const sys = snapshotOf(sk);
  const record = sys.entities.find(e => e.id === entityId)!;
  return sys.params.slice(record.paramOffset, record.paramOffset + PARAM_COUNT[record.kind]);
}

function renderedErrors(scene: Scene): Map<string, string> {
  const out = new Map<string, string>();
  for (const r of scene.getRenderedObjects()) {
    if (r.errorMessage) {
      out.set(r.uniqueType, r.errorMessage);
    }
  }
  return out;
}

describe("copy 2D solver instances (constraint targeting)", () => {
  setupOC();

  describe("entities[] payload", () => {
    it("ships one record per duplicate slot of a linear line copy", () => {
      let src: ISolvedLine;
      let cp: ICopy;
      sketch('xy', () => {
        src = line([0, 0], [20, 0]);
        cp = copy('linear', 'x', { count: 3, offset: 40 }, src);
      });
      render();

      const payload = payloadOf(cp!);
      // The original occupies slot 0 and is NOT in the array; duplicates
      // stamp in slot order, so shapeIndex follows addShape order.
      expect(payload.entities).toHaveLength(2);
      expect(payload.entities!.map(e => e.slot)).toEqual([1, 2]);
      expect(payload.entities!.map(e => e.shapeIndex)).toEqual([0, 1]);
      expect(payload.entities!.every(e => e.kind === 'line')).toBe(true);
      const srcId = entityIdOf(src!);
      for (const e of payload.entities!) {
        expect(e.entityId).toBeGreaterThanOrEqual(0);
        expect(e.entityId).not.toBe(srcId);
      }
      // The existing source-verdict keys stay intact alongside.
      expect(payload.sourceEntities).toEqual([srcId]);
      expect(payload.sourcesSolved).toBe(true);
    });

    it("keeps slot numbering through centered grids and skip holes", () => {
      let cp: ICopy;
      sketch('xy', () => {
        const src = line([0, 0], [20, 0]);
        // Centered count 4: the original sits at grid slot 2; slot 3 is
        // skipped, so only slots 0 and 1 stamp duplicates.
        cp = copy('linear', 'x', { count: 4, offset: 30, centered: true, skip: [[3]] }, src);
      });
      render();

      const payload = payloadOf(cp!);
      expect(payload.entities!.map(e => ({ slot: e.slot, shapeIndex: e.shapeIndex })))
        .toEqual([{ slot: 0, shapeIndex: 0 }, { slot: 1, shapeIndex: 1 }]);
    });

    it("ships circle duplicates of a circular copy at their rotated centers", () => {
      let sk: unknown;
      let cp: ICopy;
      sk = sketch('xy', () => {
        const c = circle([30, 0], 10);
        cp = copy('circular', [0, 0], { count: 3, offset: 120 }, c);
      });
      render();

      const payload = payloadOf(cp!);
      expect(payload.entities!.map(e => e.slot)).toEqual([1, 2]);
      expect(payload.entities!.every(e => e.kind === 'circle')).toBe(true);
      // Slot 1 sits 120° CCW around the origin: center (30·cos120, 30·sin120);
      // the radius (circle() takes a DIAMETER of 10) rides along unchanged.
      const dup1 = paramsOf(sk, payload.entities![0].entityId);
      expect(dup1[0]).toBeCloseTo(30 * Math.cos((2 * Math.PI) / 3), 6);
      expect(dup1[1]).toBeCloseTo(30 * Math.sin((2 * Math.PI) / 3), 6);
      expect(dup1[2]).toBeCloseTo(5, 6);
    });

    it("a non-solver source registers nothing but keeps the source-verdict keys", () => {
      let cp: ICopy;
      sketch('xy', () => {
        const c = circle([0, 0], 20);
        const o = offset(5, c) as unknown as Offset;
        cp = copy('linear', 'x', { count: 2, offset: 80 }, o as unknown as ISceneObject);
      });
      render();

      const payload = payloadOf(cp!);
      expect(payload.entities).toBeUndefined();
      expect(payload.sourcesSolved).toBe(false);
      expect(payload.sourceEntities).toEqual([]);
    });
  });

  describe("instances as constraint targets", () => {
    it("parallel on a duplicate orients the source, landing the duplicate at transform(source)", () => {
      let sk: unknown;
      let src: ISolvedLine;
      let cp: ICopy;
      sk = sketch('xy', () => {
        src = line([0, 0], [40, 3]);
        fix(src.start(), [0, 0]);
        distance(src.start(), src.end(), 40);
        cp = copy('linear', 'x', { count: 3, offset: 50 }, src);
        const b = line([0, 30], [40, 30]);
        horizontal(b);
        fix(b.start(), [0, 30]);
        parallel(cp.instance(1), b);
      });
      const scene = render();

      expect(renderedErrors(scene).size).toBe(0);
      expect(snapshotOf(sk).outcome).toBe('solved');
      // Paralleling the duplicate to a horizontal line flattened the SOURCE.
      const srcParams = paramsOf(sk, entityIdOf(src!));
      expect(srcParams[1]).toBeCloseTo(srcParams[3], 6);
      // And the duplicate sits exactly at source + (50, 0) — the tie.
      const dup1 = payloadOf(cp!).entities!.find(e => e.slot === 1)!;
      const dupParams = paramsOf(sk, dup1.entityId);
      expect(dupParams[0]).toBeCloseTo(srcParams[0] + 50, 6);
      expect(dupParams[1]).toBeCloseTo(srcParams[1], 6);
      expect(dupParams[2]).toBeCloseTo(srcParams[2] + 50, 6);
      expect(dupParams[3]).toBeCloseTo(srcParams[3], 6);
    });

    it("REGRESSION: a local('x') + length copy registers duplicates at statement time (tangent on an instance)", () => {
      // AxisFromSketch resolves its axis in build(), but duplicate
      // registration runs at statement time — reading getAxis() there
      // returned undefined, the throw was swallowed, and local('x') copies
      // silently registered no duplicate entities (dead picks in the UI).
      let sk: unknown;
      let src: ISceneObject;
      let cp: ICopy;
      sk = sketch('xy', () => {
        src = circle([-166.23, 0], 74.61);
        const l = line([95.09, 191.29], [223.37, 72.11]);
        cp = copy('linear', local('x'), { count: 3, length: 200 }, src);
        tangent(l, cp.instance(1));
      });
      const scene = render();

      expect(renderedErrors(scene).size).toBe(0);
      const payload = payloadOf(cp!);
      expect(payload.entities).toHaveLength(2);
      expect(payload.entities!.map(e => e.slot)).toEqual([1, 2]);
      expect(payload.entities!.every(e => e.kind === 'circle')).toBe(true);
      expect(snapshotOf(sk).outcome).toBe('solved');
      // length 200 over count 3 = 100 per slot; the tie held.
      const srcParams = paramsOf(sk, entityIdOf(src!));
      const dup1 = paramsOf(sk, payload.entities!.find(e => e.slot === 1)!.entityId);
      expect(dup1[0]).toBeCloseTo(srcParams[0] + 100, 6);
      expect(dup1[1]).toBeCloseTo(srcParams[1], 6);
      expect(dup1[2]).toBeCloseTo(srcParams[2], 6);
      // Tangency holds numerically: the line sits one radius (param 2 of
      // the circle layout) from the duplicate's center.
      const lSys = snapshotOf(sk);
      const lRec = lSys.entities.find(e => e.kind === 'line' && e.id >= 0)!;
      const [sx, sy, ex, ey] = lSys.params.slice(lRec.paramOffset, lRec.paramOffset + 4);
      const len = Math.hypot(ex - sx, ey - sy);
      const dist = Math.abs((ex - sx) * (sy - dup1[1]) - (sx - dup1[0]) * (ey - sy)) / len;
      expect(dist).toBeCloseTo(dup1[2], 5);
    });

    it("dimensions a duplicate's start() against the origin datum", () => {
      let sk: unknown;
      let src: ISolvedLine;
      let cp: ICopy;
      sk = sketch('xy', () => {
        src = line([1, 2], [20, 2]);
        horizontal(src);
        distance(src.start(), src.end(), 20);
        cp = copy('linear', 'x', { count: 3, offset: 30 }, src);
        distance(cp.instance(2).start(), origin(), 65);
      });
      const scene = render();

      expect(renderedErrors(scene).size).toBe(0);
      expect(snapshotOf(sk).outcome).toBe('solved');
      const srcParams = paramsOf(sk, entityIdOf(src!));
      const dup2 = payloadOf(cp!).entities!.find(e => e.slot === 2)!;
      const dupParams = paramsOf(sk, dup2.entityId);
      // The dimension held on the duplicate's start point …
      expect(Math.hypot(dupParams[0], dupParams[1])).toBeCloseTo(65, 5);
      // … which is the source's start displaced by the slot transform.
      expect(dupParams[0]).toBeCloseTo(srcParams[0] + 60, 6);
      expect(dupParams[1]).toBeCloseTo(srcParams[1], 6);
    });

    it("horizontal on a 90°-rotated circular duplicate makes the source vertical", () => {
      let sk: unknown;
      let src: ISolvedLine;
      let cp: ICopy;
      sk = sketch('xy', () => {
        src = line([30, 1], [50, 2]);
        distance(src.start(), src.end(), 20);
        fix(src.start(), [30, 0]);
        cp = copy('circular', [0, 0], { count: 2, offset: 90 }, src);
        horizontal(cp.instance(1));
      });
      const scene = render();

      expect(renderedErrors(scene).size).toBe(0);
      expect(snapshotOf(sk).outcome).toBe('solved');
      const srcParams = paramsOf(sk, entityIdOf(src!));
      expect(srcParams[0]).toBeCloseTo(srcParams[2], 6);
      // The duplicate is the source rotated 90° CCW about the origin.
      const dup1 = payloadOf(cp!).entities!.find(e => e.slot === 1)!;
      const dupParams = paramsOf(sk, dup1.entityId);
      expect(dupParams[0]).toBeCloseTo(-srcParams[1], 6);
      expect(dupParams[1]).toBeCloseTo(srcParams[0], 6);
      expect(dupParams[1]).toBeCloseTo(dupParams[3], 6);
    });

    it("the original's slot resolves to the source statement's own entity", () => {
      let src: ISolvedLine;
      let stmt: ISceneObject;
      sketch('xy', () => {
        src = line([0, 0], [40, 0]);
        const cp = copy('linear', 'x', { count: 2, offset: 50 }, src);
        const b = line([0, 20], [40, 25]);
        stmt = parallel(cp.instance(0), b);
      });
      const scene = render();

      expect(renderedErrors(scene).size).toBe(0);
      const spec = (stmt! as unknown as { serialize(): { spec: { a: { entity: number } } } })
        .serialize().spec;
      expect(spec.a.entity).toBe(entityIdOf(src!));
    });
  });

  describe("resolution errors (stashed on the constraint statement)", () => {
    it("multi-source, skipped, out-of-range and non-solver slots error honestly without crashing", () => {
      sketch('xy', () => {
        const a = line([0, 0], [40, 0]);
        const b = line([0, 10], [40, 10]);
        const ref = line([0, 50], [40, 50]);
        const cpMulti = copy('linear', 'x', { count: 2, offset: 60 }, a, b);
        const cpSkip = copy('linear', 'x', { count: 3, offset: 60, skip: [[2]] }, a);
        const o = offset(5, b) as unknown as Offset;
        const cpNoSolver = copy('linear', 'x', { count: 2, offset: 200 }, o as unknown as ISceneObject);
        parallel(cpMulti.instance(1), ref);
        horizontal(cpSkip.instance(2));
        vertical(cpSkip.instance(7));
        perpendicular(cpNoSolver.instance(1), ref);
      });
      const scene = render();

      const errors = renderedErrors(scene);
      expect(errors.get('constraint-parallel')).toMatch(/carries 2 edges — per-edge targeting is not supported yet/);
      expect(errors.get('constraint-horizontal')).toMatch(/instance\(2\) was skipped by this copy — valid slots: 0, 1/);
      expect(errors.get('constraint-vertical')).toMatch(/instance\(7\) is out of range — valid slots: 0, 1/);
      expect(errors.get('constraint-perpendicular')).toMatch(/no solver identity/);
      // The copies themselves stay clean — the errors belong to the
      // constraint statements alone.
      expect(errors.has('copy-linear-2d')).toBe(false);
    });

    it("names only the user constraints when pins across a tie conflict", () => {
      sketch('xy', () => {
        const p = point([10, 5]);
        fix(p, [10, 5]);
        const cp = copy('linear', 'x', { count: 2, offset: 30 }, p);
        // The tie forces the duplicate to (40, 5) — this pin conflicts.
        fix(cp.instance(1), [100, 100]);
      });
      const scene = render();

      const rows = scene.getRenderedObjects();
      const fixRows = rows.filter(r => r.uniqueType === 'constraint-fix');
      expect(fixRows).toHaveLength(2);
      const errored = fixRows.filter(r => r.errorMessage);
      expect(errored.length).toBeGreaterThanOrEqual(1);
      for (const row of errored) {
        expect(row.errorMessage).toMatch(/Constraint cannot be satisfied/);
        // Internal tie records are never named — conflicts speak in terms
        // of the other user constraint statements.
        expect(row.errorMessage).not.toMatch(/tie/);
      }
      const copyRow = rows.find(r => r.uniqueType === 'copy-linear-2d')!;
      expect(copyRow.errorMessage).toBeFalsy();
    });
  });

  describe("system accounting", () => {
    it("adding a copy leaves the sketch DOF unchanged (net-zero ties)", () => {
      let plain: unknown;
      let copied: unknown;
      plain = sketch('xy', () => {
        const l = line([0, 0], [30, 0]);
        horizontal(l);
      });
      copied = sketch('xy', () => {
        const l = line([0, 0], [30, 0]);
        horizontal(l);
        copy('linear', 'x', { count: 3, offset: 40 }, l);
      });
      render();

      const dofPlain = snapshotOf(plain).dof;
      expect(dofPlain).not.toBeNull();
      expect(snapshotOf(copied).dof).toBe(dofPlain);
    });

    it("the entities[] payload survives SceneCompare reuse (state-transferred shape join)", () => {
      // Solved sketches match container-atomically: an IDENTICAL sketch
      // across an incremental render reuses the copy (build skipped), and
      // serialize() must still join the fresh statement-time registration
      // to the TRANSFERRED build-time shape map.
      sketch('xy', () => {
        const l = line([0, 0], [20, 0]);
        copy('linear', 'x', { count: 3, offset: 40 }, l);
      });
      render();
      const previousScene = getSceneManager()!.currentScene;

      getSceneManager()!.startScene();
      let cp: ICopy;
      sketch('xy', () => {
        const l = line([0, 0], [20, 0]);
        cp = copy('linear', 'x', { count: 3, offset: 40 }, l);
      });
      SceneCompare.compare(previousScene, getSceneManager()!.currentScene);
      render();

      // The scenario is only real if the copy WAS reused (build skipped).
      expect(getSceneManager()!.currentScene.isCached(cp! as unknown as Copy2DBase)).toBe(true);
      const payload = payloadOf(cp!);
      expect(payload.entities).toHaveLength(2);
      expect(payload.entities!.map(e => ({ slot: e.slot, shapeIndex: e.shapeIndex })))
        .toEqual([{ slot: 1, shapeIndex: 0 }, { slot: 2, shapeIndex: 1 }]);
    });
  });
});
