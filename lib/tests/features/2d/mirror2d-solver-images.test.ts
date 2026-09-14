// Constraint targeting of 2D mirror() images: every solver-backed source the
// mirror stamps registers an IMAGE entity rigidly tied to it across the
// mirror line (SketchSystem.addMirrorTie) at statement time, and
// `m.instance(src)` (with .start()/.end()/.center()) resolves to that entity
// as a constraint target. serialize() ships the entities[] payload joining
// image entities to the mirror's sceneShapes by source entity.
import { describe, it, expect } from "vitest";
import { setupOC, render } from "../../setup.js";
import { getSceneManager } from "../../../scene-manager.js";
import { SceneCompare } from "../../../rendering/scene-compare.js";
import sketch from "../../../core/sketch.js";
import copy from "../../../core/copy.js";
import mirror from "../../../core/mirror.js";
import { line, circle, arc, point, offset, origin, xAxis, yAxis } from "../../../core/2d/index.js";
import {
  parallel, perpendicular, horizontal, vertical, fix, distance, coincident, radius,
} from "../../../core/constraints/index.js";
import { Sketch } from "../../../features/2d/sketch.js";
import { MirrorShape2D } from "../../../features/mirror-shape2d.js";
import { Offset } from "../../../features/2d/offset.js";
import { Scene } from "../../../rendering/scene.js";
import { ShapeOps } from "../../../oc/shape-ops.js";
import type { ICopy, IMirror2D, ISceneObject, ISolvedLine } from "../../../core/interfaces.js";

type EntityRecord = { entityId: number; kind: string; shapeIndex: number; sourceEntityId: number };
type MirrorPayload = {
  entities?: EntityRecord[];
  sourceEntities?: number[];
  sourcesSolved?: boolean;
};

const payloadOf = (m: IMirror2D): MirrorPayload =>
  (m as unknown as MirrorShape2D).serialize() as MirrorPayload;

const entityIdOf = (obj: unknown): number => (obj as { entityId: number }).entityId;

type SnapshotSystem = {
  entities: { id: number; kind: 'point' | 'line' | 'circle' | 'arc'; paramOffset: number }[];
  constraints: { id: number; internal: boolean; spec: { kind: string } }[];
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

describe("mirror 2D solver images (constraint targeting)", () => {
  setupOC();

  describe("entities[] payload", () => {
    it("ships one record per solver-backed source, joined by source entity", () => {
      let src: ISolvedLine;
      let c: ISceneObject;
      let m: IMirror2D;
      sketch('xy', () => {
        src = line([10, 0], [30, 5]);
        c = circle([20, 20], 6);
        m = mirror(yAxis(), src, c);
      });
      render();

      const payload = payloadOf(m!);
      expect(payload.entities).toHaveLength(2);
      const byKind = Object.fromEntries(payload.entities!.map(e => [e.kind, e]));
      expect(byKind.line.sourceEntityId).toBe(entityIdOf(src!));
      expect(byKind.circle.sourceEntityId).toBe(entityIdOf(c!));
      // One stamped shape per source, in target order.
      expect(byKind.line.shapeIndex).toBe(0);
      expect(byKind.circle.shapeIndex).toBe(1);
      for (const e of payload.entities!) {
        expect(e.entityId).toBeGreaterThanOrEqual(0);
        expect(e.entityId).not.toBe(e.sourceEntityId);
      }
      // The existing source-verdict keys stay intact alongside.
      expect(payload.sourceEntities).toEqual([entityIdOf(src!), entityIdOf(c!)].sort((a, b) => a - b));
      expect(payload.sourcesSolved).toBe(true);
    });

    it("registers images at statement time even with no instance() call, guesses reflected", () => {
      let sk: unknown;
      let src: ISolvedLine;
      let m: IMirror2D;
      sk = sketch('xy', () => {
        src = line([10, 0], [30, 5]);
        m = mirror(xAxis(), src);
      });
      render();

      const image = payloadOf(m!).entities![0];
      const params = paramsOf(sk, image.entityId);
      expect(params).toEqual([10, -0, 30, -5].map(v => expect.closeTo(v, 9)));
    });

    it("the target-less form images every previous entity but never the mirror line itself", () => {
      let axisLine: ISolvedLine;
      let c: ISceneObject;
      let m: IMirror2D;
      sketch('xy', () => {
        axisLine = line([0, -10], [0, 60]).guide();
        c = circle([30, 20], 20);
        m = mirror(axisLine);
      });
      render();

      const payload = payloadOf(m!);
      expect(payload.entities!.map(e => e.sourceEntityId)).toEqual([entityIdOf(c!)]);
    });

    it("non-solver sources register nothing", () => {
      let m: IMirror2D;
      sketch('xy', () => {
        const c = circle([0, 0], 20);
        const o = offset(5, c) as unknown as Offset;
        m = mirror(yAxis(), o as unknown as ISceneObject);
      });
      render();

      const payload = payloadOf(m!);
      expect(payload.entities).toBeUndefined();
      expect(payload.sourcesSolved).toBe(false);
    });

    it("degrades honestly when the world axis is normal to the sketch plane", () => {
      let l: ISolvedLine;
      let m: IMirror2D;
      sketch('front', () => {
        l = line([10, 0], [30, 0]);
        m = mirror('y', l);
        horizontal(m.instance(l));
      });
      const scene = render();

      expect(payloadOf(m!).entities).toBeUndefined();
      expect(renderedErrors(scene).get('constraint-horizontal'))
        .toMatch(/no solver identity — the mirror axis is normal to the sketch plane/);
    });
  });

  describe("instances as constraint targets", () => {
    it("parallel on an image across yAxis() orients the source; the image is its reflection", () => {
      let sk: unknown;
      let src: ISolvedLine;
      let m: IMirror2D;
      sk = sketch('xy', () => {
        src = line([10, 0], [50, 3]);
        fix(src.start(), [10, 0]);
        distance(src.start(), src.end(), 40);
        m = mirror(yAxis(), src);
        const b = line([0, 30], [40, 30]);
        horizontal(b);
        fix(b.start(), [0, 30]);
        parallel(m.instance(src), b);
      });
      const scene = render();

      expect(renderedErrors(scene).size).toBe(0);
      expect(snapshotOf(sk).outcome).toBe('solved');
      const srcParams = paramsOf(sk, entityIdOf(src!));
      expect(srcParams[1]).toBeCloseTo(srcParams[3], 6);
      const image = paramsOf(sk, payloadOf(m!).entities![0].entityId);
      expect(image[0]).toBeCloseTo(-srcParams[0], 6);
      expect(image[1]).toBeCloseTo(srcParams[1], 6);
      expect(image[2]).toBeCloseTo(-srcParams[2], 6);
      expect(image[3]).toBeCloseTo(srcParams[3], 6);
    });

    it("a world-axis mirror on the XY plane ties through a constant line", () => {
      let sk: unknown;
      let src: ISolvedLine;
      let m: IMirror2D;
      sk = sketch('xy', () => {
        src = line([10, 2], [40, 12]);
        fix(src.start(), [10, 2]);
        distance(src.start(), src.end(), 30);
        m = mirror('x', src);
        horizontal(m.instance(src));
      });
      const scene = render();

      expect(renderedErrors(scene).size).toBe(0);
      const srcParams = paramsOf(sk, entityIdOf(src!));
      expect(srcParams[3]).toBeCloseTo(2, 6);
      const image = paramsOf(sk, payloadOf(m!).entities![0].entityId);
      expect(image[1]).toBeCloseTo(-2, 6);
      expect(image[3]).toBeCloseTo(-2, 6);
    });

    it("a SKETCHED mirror line is live: constraining the image moves the line, and the build follows", () => {
      let sk: unknown;
      let p: ISceneObject;
      let axisLine: ISolvedLine;
      let m: IMirror2D;
      sk = sketch('xy', () => {
        axisLine = line([0, -10], [0, 50]).guide();
        vertical(axisLine);
        distance(axisLine.start(), axisLine.end(), 60);
        p = point([10, 20]);
        fix(p, [10, 20]);
        m = mirror(axisLine, p);
        // The image must sit 40 from the pinned source: the vertical mirror
        // line has to slide to x = -10.
        distance(m.instance(p), p, 40);
      });
      const scene = render();

      expect([...renderedErrors(scene).entries()]).toEqual([]);
      expect(snapshotOf(sk).outcome).toBe('solved');
      const axisParams = paramsOf(sk, entityIdOf(axisLine!));
      expect(axisParams[0]).toBeCloseTo(-10, 5);
      expect(axisParams[2]).toBeCloseTo(-10, 5);
      const image = paramsOf(sk, payloadOf(m!).entities![0].entityId);
      expect(image[0]).toBeCloseTo(-30, 5);
      expect(image[1]).toBeCloseTo(20, 6);
      // The stamped shape sits where the solver put the image.
      const stamped = (m! as unknown as MirrorShape2D).getShapes();
      expect(stamped).toHaveLength(1);
      const bbox = ShapeOps.getBoundingBox(stamped[0]);
      expect(bbox.minX).toBeCloseTo(-30, 4);
      expect(bbox.minY).toBeCloseTo(20, 4);
    });

    it("dimensions an image's start() against the origin datum", () => {
      let sk: unknown;
      let src: ISolvedLine;
      let m: IMirror2D;
      sk = sketch('xy', () => {
        src = line([1, 2], [20, 2]);
        horizontal(src);
        distance(src.start(), src.end(), 20);
        m = mirror(yAxis(), src);
        distance(m.instance(src).start(), origin(), 65);
      });
      const scene = render();

      expect(renderedErrors(scene).size).toBe(0);
      const srcParams = paramsOf(sk, entityIdOf(src!));
      const image = paramsOf(sk, payloadOf(m!).entities![0].entityId);
      expect(Math.hypot(image[0], image[1])).toBeCloseTo(65, 5);
      expect(image[0]).toBeCloseTo(-srcParams[0], 6);
      expect(image[1]).toBeCloseTo(srcParams[1], 6);
    });

    it("arc images keep the radius and tie start→start; circle images take a radius dimension", () => {
      let sk: unknown;
      let a: ISceneObject;
      let c: ISceneObject;
      let m: IMirror2D;
      sk = sketch('xy', () => {
        a = arc([10, 0], [0, 10], [0, 0]);
        c = circle([30, 5], 4);
        m = mirror(xAxis(), a, c);
        fix(m.instance(a).center(), [0, 0]);
        fix(m.instance(a).end(), [0, -12]);
        radius(m.instance(c), 9);
      });
      const scene = render();

      expect(renderedErrors(scene).size).toBe(0);
      expect(snapshotOf(sk).outcome).toBe('solved');
      const arcParams = paramsOf(sk, entityIdOf(a!));
      expect(arcParams[5]).toBeCloseTo(0, 6);
      expect(arcParams[6]).toBeCloseTo(12, 6);
      expect(arcParams[2]).toBeCloseTo(12, 6);
      const circleParams = paramsOf(sk, entityIdOf(c!));
      expect(circleParams[2]).toBeCloseTo(9, 6);
      const byKind = Object.fromEntries(payloadOf(m!).entities!.map(e => [e.kind, e]));
      const circleImage = paramsOf(sk, byKind.circle.entityId);
      expect(circleImage[1]).toBeCloseTo(-circleParams[1], 6);
      expect(circleImage[2]).toBeCloseTo(9, 6);
    });

    it("a mirror of a copy images each duplicate: m.instance(cp.instance(k))", () => {
      let sk: unknown;
      let src: ISolvedLine;
      let cp: ICopy;
      let m: IMirror2D;
      sk = sketch('xy', () => {
        src = line([10, 1], [30, 1]);
        fix(src.start(), [10, 1]);
        distance(src.start(), src.end(), 20);
        cp = copy('linear', 'y', { count: 2, offset: 10 }, src);
        m = mirror(yAxis(), src, cp as unknown as ISceneObject);
        horizontal(m.instance(cp.instance(1)));
      });
      const scene = render();

      expect(renderedErrors(scene).size).toBe(0);
      expect(snapshotOf(sk).outcome).toBe('solved');
      // Source (and so its duplicate and both images) flattened.
      const srcParams = paramsOf(sk, entityIdOf(src!));
      expect(srcParams[3]).toBeCloseTo(1, 6);
      const payload = payloadOf(m!);
      expect(payload.entities).toHaveLength(2);
      const dupImage = payload.entities!.find(e => e.sourceEntityId !== entityIdOf(src!))!;
      const params = paramsOf(sk, dupImage.entityId);
      expect(params[0]).toBeCloseTo(-10, 6);
      expect(params[1]).toBeCloseTo(11, 6);
      expect(params[2]).toBeCloseTo(-30, 6);
    });

    it("instance() is also a whole-geometry operand (offset of an image)", () => {
      let o: Offset;
      sketch('xy', () => {
        const c = circle([30, 0], 10);
        const m = mirror(yAxis(), c);
        o = offset(3, m.instance(c) as unknown as ISceneObject) as unknown as Offset;
      });
      const scene = render();

      expect(renderedErrors(scene).size).toBe(0);
      const shapes = o!.getShapes();
      expect(shapes.length).toBeGreaterThan(0);
      // The offset ring sits around the IMAGE circle's center (-30, 0).
      const bbox = ShapeOps.getBoundingBox(shapes[0]);
      expect((bbox.minX + bbox.maxX) / 2).toBeCloseTo(-30, 1);
      expect((bbox.minY + bbox.maxY) / 2).toBeCloseTo(0, 1);
    });
  });

  describe("resolution errors (stashed on the constraint statement)", () => {
    it("names the not-mirrored, off-target, point-accessor and mirror-line cases honestly", () => {
      sketch('xy', () => {
        const axisLine = line([0, -10], [0, 60]).guide();
        const a = line([10, 0], [40, 0]);
        const b = line([10, 10], [40, 10]);
        const ref = line([0, 50], [40, 50]);
        const m = mirror(axisLine, a);
        const later = line([10, 20], [40, 20]);
        parallel(m.instance(later), ref);
        horizontal(m.instance(b));
        vertical(m.instance(a.start()));
        perpendicular(m.instance(axisLine), ref);
      });
      const scene = render();

      const errors = renderedErrors(scene);
      expect(errors.get('constraint-parallel')).toMatch(/line\(\) is not mirrored by this statement/);
      expect(errors.get('constraint-horizontal')).toMatch(/line\(\) is not mirrored by this statement/);
      expect(errors.get('constraint-vertical')).toMatch(/takes the mirrored statement, not one of its points/);
      expect(errors.get('constraint-perpendicular')).toMatch(/the mirror line is its own image/);
      expect(errors.has('mirror-shape-2d')).toBe(false);
    });

    it("a source without solver identity errors as a target", () => {
      sketch('xy', () => {
        const c = circle([0, 0], 20);
        const o = offset(5, c) as unknown as Offset;
        const ref = line([0, 50], [40, 50]);
        const m = mirror(yAxis(), o as unknown as ISceneObject);
        parallel(m.instance(o as unknown as ISceneObject), ref);
      });
      const scene = render();

      expect(renderedErrors(scene).get('constraint-parallel'))
        .toMatch(/expects a mirrored line\/arc\/circle\/point statement/);
    });

    it("names only the user constraints when pins across a tie conflict", () => {
      sketch('xy', () => {
        const p = point([10, 5]);
        fix(p, [10, 5]);
        const m = mirror(yAxis(), p);
        // The tie forces the image to (-10, 5) — this pin conflicts.
        fix(m.instance(p), [100, 100]);
      });
      const scene = render();

      const rows = scene.getRenderedObjects();
      const fixRows = rows.filter(r => r.uniqueType === 'constraint-fix');
      expect(fixRows).toHaveLength(2);
      const errored = fixRows.filter(r => r.errorMessage);
      expect(errored.length).toBeGreaterThanOrEqual(1);
      for (const row of errored) {
        expect(row.errorMessage).toMatch(/Constraint cannot be satisfied/);
        expect(row.errorMessage).not.toMatch(/tie/);
      }
      expect(rows.find(r => r.uniqueType === 'mirror-shape-2d')!.errorMessage).toBeFalsy();
    });
  });

  describe("system accounting", () => {
    it("adding a mirror leaves the sketch DOF unchanged (net-zero ties), for datum and drawn lines", () => {
      let plain: unknown;
      let datumMirror: unknown;
      let lineMirror: unknown;
      plain = sketch('xy', () => {
        const axisLine = line([0, -10], [0, 60]).guide();
        const l = line([10, 0], [30, 0]);
        horizontal(l);
        coincident(axisLine.start(), origin());
      });
      datumMirror = sketch('xy', () => {
        const axisLine = line([0, -10], [0, 60]).guide();
        const l = line([10, 0], [30, 0]);
        horizontal(l);
        coincident(axisLine.start(), origin());
        mirror(yAxis(), l);
      });
      lineMirror = sketch('xy', () => {
        const axisLine = line([0, -10], [0, 60]).guide();
        const l = line([10, 0], [30, 0]);
        horizontal(l);
        coincident(axisLine.start(), origin());
        mirror(axisLine, l);
      });
      render();

      const dofPlain = snapshotOf(plain).dof;
      expect(dofPlain).not.toBeNull();
      expect(snapshotOf(datumMirror).dof).toBe(dofPlain);
      expect(snapshotOf(lineMirror).dof).toBe(dofPlain);
      expect(snapshotOf(lineMirror).constraints.some(c => c.internal && c.spec.kind === 'mirror-tie')).toBe(true);
    });

    it("the entities[] payload survives SceneCompare reuse (state-transferred shape join)", () => {
      sketch('xy', () => {
        const l = line([10, 0], [30, 0]);
        mirror(yAxis(), l);
      });
      render();
      const previousScene = getSceneManager()!.currentScene;

      getSceneManager()!.startScene();
      let m: IMirror2D;
      let l: ISolvedLine;
      sketch('xy', () => {
        l = line([10, 0], [30, 0]);
        m = mirror(yAxis(), l);
      });
      SceneCompare.compare(previousScene, getSceneManager()!.currentScene);
      render();

      expect(getSceneManager()!.currentScene.isCached(m! as unknown as MirrorShape2D)).toBe(true);
      const payload = payloadOf(m!);
      expect(payload.entities).toHaveLength(1);
      expect(payload.entities![0]).toMatchObject({ kind: 'line', shapeIndex: 0, sourceEntityId: entityIdOf(l!) });
    });
  });
});
