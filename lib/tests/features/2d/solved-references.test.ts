// P6 fixed reference entities: project()/intersect() outputs inside a solved
// sketch register as LOCKED solver geometry — constraints target a projected
// bore or edge (the marquee capability), the references add zero DOF and
// never move, and everything resolves deferred (the OCCT geometry only
// exists at build time).
import { describe, it, expect } from "vitest";
import { setupOC, render } from "../../setup.js";
import { getSceneManager } from "../../../scene-manager.js";
import { SceneCompare } from "../../../rendering/scene-compare.js";
import sketch from "../../../core/sketch.js";
import extrude from "../../../core/extrude.js";
import { line, circle, arc, project, intersect } from "../../../core/2d/index.js";
import {
  coincident, horizontal, tangent, distance, radius, fix,
} from "../../../core/constraints/index.js";
import { Sketch } from "../../../features/2d/sketch.js";
import { Extrude } from "../../../features/extrude.js";
import { Scene } from "../../../rendering/scene.js";
import type { IReference } from "../../../core/interfaces.js";
import { testRect } from "../../helpers/profiles.js";

function renderedErrors(scene: Scene): Map<string, string> {
  const out = new Map<string, string>();
  for (const r of scene.getRenderedObjects()) {
    if (r.errorMessage) {
      out.set(r.uniqueType, r.errorMessage);
    }
  }
  return out;
}

function snapshotOf(sk: Sketch) {
  return sk.getState('solver-system') as {
    outcome?: string;
    dof?: number;
    conflicting: number[];
    redundant: number[];
    entities: { id: number; kind: string; fixed: boolean }[];
    params: number[];
  };
}

function solvedPayload(scene: Scene, uniqueType: string) {
  return scene.getRenderedObjects().filter(r => r.uniqueType === uniqueType).map(r => r.object);
}

/** An extruded circle standing on xy — its top face projects to a circle
 * of the given radius. */
function boreDonor(radiusValue = 20, height = 15) {
  sketch('xy', () => {
    circle([0, 0], radiusValue * 2);
  });
  return extrude(height) as Extrude;
}

describe("fixed reference entities (P6)", () => {
  setupOC();

  it("marquee: a free line goes tangent to a projected bore", () => {
    const donor = boreDonor(20);
    let bore: IReference;
    const sk = sketch('xy', () => {
      bore = project(donor.endFaces());
      const l = line([25, -30], [25, 30]);
      fix(l.start(), [30, -30]);
      tangent(bore, l);
    }) as unknown as Sketch;
    const scene = render();

    expect(renderedErrors(scene).size).toBe(0);

    // The projected circle registered fixed at the origin, r=20; the line's
    // solved position must sit exactly r away from the center.
    const snap = snapshotOf(sk);
    const fixedCircle = snap.entities.find(e => e.kind === 'circle' && e.fixed);
    expect(fixedCircle).toBeDefined();

    const linePayload = solvedPayload(scene, 'solved-line')[0] as {
      start: { x: number; y: number }; end: { x: number; y: number };
    };
    // Perpendicular distance from (0,0) to the solved line == radius.
    const dx = linePayload.end.x - linePayload.start.x;
    const dy = linePayload.end.y - linePayload.start.y;
    const len = Math.hypot(dx, dy);
    const dist = Math.abs(dx * (0 - linePayload.start.y) - dy * (0 - linePayload.start.x)) / len;
    expect(dist).toBeCloseTo(20, 5);
  });

  it("dimensions against a reference center and refuses all-fixed constraints", () => {
    const donor = boreDonor(15);
    const sk = sketch('xy', () => {
      const bore = project(donor.endFaces());
      const c = circle([40, 5], 20);
      distance(bore.center(), c.center(), 60);
      fix(c.center(), [60, 0]);
      // All-fixed: only the reference — must error on the statement, not
      // silently register.
      radius(bore, 5);
    }) as unknown as Sketch;
    const scene = render();

    const errors = renderedErrors(scene);
    expect(errors.get('constraint-radius')).toMatch(/fixed geometry/);
    // The distance solved: the circle center is 60 from the origin. The
    // donor's circle is a solved-circle too now — take the consumer's (last).
    const circlePayload = solvedPayload(scene, 'solved-circle').at(-1) as {
      center: { x: number; y: number };
    };
    expect(Math.hypot(circlePayload.center.x, circlePayload.center.y)).toBeCloseTo(60, 5);
    expect(snapshotOf(sk).outcome).toBe('solved');
  });

  it("references add zero DOF and their params never move", () => {
    const donor = boreDonor(10);
    let withRef: Sketch;
    sketch('xy', () => {
      project(donor.endFaces());
      const l = line([30, 0], [50, 0]);
      horizontal(l);
    });
    const sketches = getSceneManager()!.currentScene.getSceneObjects()
      .filter(o => o instanceof Sketch) as Sketch[];
    withRef = sketches[sketches.length - 1];
    render();

    const snap = snapshotOf(withRef);
    const fixedEntities = snap.entities.filter(e => e.fixed && e.id >= 0);
    expect(fixedEntities.length).toBeGreaterThan(0);
    // Free line: 4 params − 1 horizontal = 3 DOF. The reference adds none.
    expect(snap.dof).toBe(3);
  });

  it("projected arcs diagnose clean — no phantom redundants on a pure projection", () => {
    // Regression: fixed reference arcs used to register internal
    // arc-consistency rows that diagnose reported as redundant, so a
    // sketch holding nothing but a projected slot read "Fully
    // constrained · 2 redundant".
    sketch('xy', () => {
      // The legacy slot(80, 15) donor, lowered: two rails + two cap arcs.
      const top = line([0, 7.5], [80, 7.5]);
      const rightCap = arc([80, 7.5], [80, -7.5], [80, 0]).cw();
      const bottom = line([80, -7.5], [0, -7.5]);
      const leftCap = arc([0, -7.5], [0, 7.5], [0, 0]).cw();
      coincident(top.end(), rightCap.start());
      coincident(rightCap.end(), bottom.start());
      coincident(bottom.end(), leftCap.start());
      coincident(leftCap.end(), top.start());
    });
    const e = extrude(20) as Extrude;
    sketch(e.endFaces(), () => {
      project(e.endFaces());
    });
    const sketches = getSceneManager()!.currentScene.getSceneObjects()
      .filter(o => o instanceof Sketch) as Sketch[];
    const projSketch = sketches[sketches.length - 1];
    render();

    const snap = snapshotOf(projSketch);
    expect(snap.entities.filter(en => en.fixed && en.kind === 'arc').length).toBe(2);
    expect(snap.outcome).toBe('solved');
    expect(snap.dof).toBe(0);
    expect(snap.redundant).toEqual([]);
    expect(snap.conflicting).toEqual([]);
  });

  it("multi-edge references need .ref(i); bad indices error honestly", () => {
    sketch('xy', () => {
        testRect(60, 40);
      });
    const e = extrude(20) as Extrude;

    sketch('xy', () => {
      const outline = project(e.endFaces());
      const c = circle([100, 0], 20);
      // Whole-producer sugar is ambiguous over 4 edges.
      tangent(outline, c);
      // Out of range.
      coincident(c.center(), outline.ref(11).start());
      // A valid indexed reference: the circle center holds 50 off line 0.
      distance(outline.ref(0), c.center(), 50);
    });
    const scene = render();

    const errors = [...renderedErrors(scene).entries()];
    expect(errors.find(([k]) => k === 'constraint-tangent')?.[1]).toMatch(/4 constrainable edges/);
    expect(errors.find(([k]) => k === 'constraint-coincident')?.[1]).toMatch(/out of range/);
    expect(errors.find(([k]) => k === 'constraint-distance')).toBeUndefined();
  });

  it("intersect outputs register as fixed lines", () => {
    sketch('xy', () => {
        testRect(80, 50);
      });
    const e = extrude(30) as Extrude;

    const sk = sketch('xz', () => {
      const section = intersect(e);
      const l = line([5, 40], [70, 45]);
      horizontal(l);
      coincident(l.start(), section.ref(0).start());
    }) as unknown as Sketch;
    const scene = render();

    expect(renderedErrors(scene).size).toBe(0);
    const snap = snapshotOf(sk);
    expect(snap.entities.some(entity => entity.fixed && entity.kind === 'line' && entity.id >= 0)).toBe(true);
    expect(snap.outcome).toBe('solved');
  });

  it("caches the whole subtree when nothing changed, deferred constraints included", () => {
    const declare = () => {
      const donor = boreDonor(20);
      sketch('xy', () => {
        const bore = project(donor.endFaces());
        const l = line([25, -30], [25, 30]);
        fix(l.start(), [30, -30]);
        tangent(bore, l);
      });
    };
    declare();
    render();
    const previousScene = getSceneManager()!.currentScene;

    const newScene = getSceneManager()!.startScene();
    declare();
    SceneCompare.compare(previousScene, newScene);

    for (const obj of newScene.getSceneObjects()) {
      expect(newScene.isCached(obj)).toBe(true);
    }
  });

  it("demo chain (P6 exit criterion): project → constraints → extrude", () => {
    const donor = boreDonor(20);
    let profile: { getShapes(): { getType(): string }[] };
    sketch('xy', () => {
      const bore = project(donor.endFaces());
      const c = circle([50, 5], 24);
      distance(bore.center(), c.center(), 60);
      fix(c.center(), [60, 0]);
    });
    profile = extrude(8).new() as unknown as { getShapes(): { getType(): string }[] };
    const scene = render();

    expect(renderedErrors(scene).size).toBe(0);
    const solids = profile!.getShapes().filter(s => s.getType() === 'solid');
    expect(solids.length).toBeGreaterThan(0);
  });

  it("solves deterministically across recompute", () => {
    const donor = boreDonor(20);
    const sk = sketch('xy', () => {
      const bore = project(donor.endFaces());
      const l = line([25, -30], [25, 30]);
      fix(l.start(), [30, -30]);
      tangent(bore, l);
    }) as unknown as Sketch;
    render();
    const first = JSON.stringify(snapshotOf(sk).params);

    getSceneManager()!.startScene();
    const donor2 = boreDonor(20);
    const sk2 = sketch('xy', () => {
      const bore = project(donor2.endFaces());
      const l = line([25, -30], [25, 30]);
      fix(l.start(), [30, -30]);
      tangent(bore, l);
    }) as unknown as Sketch;
    render();
    expect(JSON.stringify(snapshotOf(sk2).params)).toBe(first);
  });
});
