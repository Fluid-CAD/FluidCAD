import { describe, it, expect } from "vitest";
import { setupOC, render, expectDisplayConsumed } from "../setup.js";
import sketch from "../../core/sketch.js";
import extrude from "../../core/extrude.js";
import hole from "../../core/hole.js";
import part from "../../core/part.js";
import connector from "../../core/connector.js";
import copy from "../../core/copy.js";
import select from "../../core/select.js";
import repeat from "../../core/repeat.js";
import { circle, line, point } from "../../core/2d/index.js";
import { face } from "../../filters/index.js";
import { testRect } from "../helpers/profiles.js";
import { Scene } from "../../rendering/scene.js";
import { SceneObject } from "../../common/scene-object.js";
import { Shape } from "../../common/shape.js";
import { ShapeProps } from "../../oc/props.js";
import { ExtrudeBase } from "../../features/extrude-base.js";
import { Hole } from "../../features/hole/hole.js";
import { Connector } from "../../features/connector.js";
import { resolveHoleDimensions, holeProfile } from "../../features/hole/hole-profile.js";
import { findFastenerSize, tapDrillFor } from "../../features/hole/fastener-tables.js";
import type { ISceneObject, ISelection } from "../../core/interfaces.js";
import type { SolvedCircle } from "../../features/2d/solved/circle.js";
import type { SolvedPoint } from "../../features/2d/solved/point.js";

const PLATE = { w: 60, d: 40, t: 10 };
const PLATE_VOLUME = PLATE.w * PLATE.d * PLATE.t;

function solidVolumes(scene: Scene): number[] {
  return scene.getSceneObjects()
    .filter(o => !o.isContainer())
    .flatMap(o => o.getShapes())
    .filter(sh => sh.isSolid())
    .map(sh => ShapeProps.getProperties(sh.getShape()).volumeMm3)
    .sort((a, b) => a - b);
}

/** A lazy accessor's shapes — built here the way a consuming statement would build it. */
function resolved(selection: ISelection): unknown[] {
  const lazy = selection as unknown as SceneObject;
  lazy.build();
  return lazy.getShapes();
}

function errorsOf(scene: Scene): string[] {
  return scene.getAllSceneObjects().flatMap(o => o.getError() ? [`${o.getType()}: ${o.getError()}`] : []);
}

function cylinderVolume(diameter: number, length: number): number {
  return Math.PI * (diameter / 2) ** 2 * length;
}

function coneVolume(diameter: number, height: number): number {
  return Math.PI * (diameter / 2) ** 2 * height / 3;
}

/**
 * A 60 × 40 × 10 plate inside a part with a connector at the centre of its
 * top face; `then` runs inside the part body (part callbacks are deferred to
 * the render, so the hole statement must live there too).
 */
function plateWithTopConnector(then: (plate: ExtrudeBase, top: Connector) => void): void {
  part("plate", () => {
    sketch("xy", () => {
      testRect(PLATE.w, PLATE.d, { at: [-PLATE.w / 2, -PLATE.d / 2] });
    });
    const plate = extrude(PLATE.t).new() as unknown as ExtrudeBase;
    const top = connector("top", select(face().planar().onPlane("xy", PLATE.t))) as unknown as Connector;
    then(plate, top);
  });
}

const BASE = { w: 60, d: 20, t: 20 };
const BASE_VOLUME = BASE.w * BASE.d * BASE.t;
const COVER = { t: 8 };
const COVER_VOLUME = BASE.w * BASE.d * COVER.t;

/**
 * A 60 × 20 × 20 base with an 8 thick cover of the same footprint on top — a
 * solid of its own — and two circles on the cover's top face, at x = ∓20,
 * whose centres seat the holes.
 */
function coverOnBase(): { base: ExtrudeBase; cover: ExtrudeBase; seat: { geometries: { l: SolvedCircle; r: SolvedCircle } } } {
  sketch("xy", () => {
    testRect(BASE.w, BASE.d, { at: [-BASE.w / 2, -BASE.d / 2] });
  });
  const base = extrude(BASE.t) as unknown as ExtrudeBase;
  sketch(base.endFaces(), () => {
    testRect(BASE.w, BASE.d, { at: [-BASE.w / 2, -BASE.d / 2] });
  });
  const cover = extrude(COVER.t).new() as unknown as ExtrudeBase;
  const seat = sketch(cover.endFaces(), () => ({ l: circle([-20, 0], 3), r: circle([20, 0], 3) }));
  return { base, cover, seat: seat as unknown as { geometries: { l: SolvedCircle; r: SolvedCircle } } };
}

const RAIL = { w: 60, d: 10, t: 20 };
const RAIL_VOLUME = RAIL.w * RAIL.d * RAIL.t;
const PLATE_ON_RAILS = { d: 30, t: 8 };
const PLATE_ON_RAILS_VOLUME = RAIL.w * PLATE_ON_RAILS.d * PLATE_ON_RAILS.t;

/**
 * Two 60 × 10 × 20 rails either side of the xz plane — two solids of one
 * extrude — under an 8 thick plate spanning both, a solid of its own, with
 * two circles on its top face, one over each rail at x = -20.
 */
function plateOnRails(): { seat: { geometries: { l: SolvedCircle; r: SolvedCircle } } } {
  sketch("xy", () => {
    testRect(RAIL.w, RAIL.d, { at: [-RAIL.w / 2, -15] });
    testRect(RAIL.w, RAIL.d, { at: [-RAIL.w / 2, 5] });
  });
  const rails = extrude(RAIL.t) as unknown as ExtrudeBase;
  sketch(rails.endFaces(), () => {
    testRect(RAIL.w, PLATE_ON_RAILS.d, { at: [-RAIL.w / 2, -PLATE_ON_RAILS.d / 2] });
  });
  const plate = extrude(PLATE_ON_RAILS.t).new() as unknown as ExtrudeBase;
  const seat = sketch(plate.endFaces(), () => ({ l: circle([-20, -10], 3), r: circle([-20, 10], 3) }));
  return { seat: seat as unknown as { geometries: { l: SolvedCircle; r: SolvedCircle } } };
}

describe("hole() geometry", () => {
  setupOC();

  it("drills a through hole at a connector, opposite the connector's normal", () => {
    let h!: Hole;
    plateWithTopConnector((_plate, top) => {
      h = hole(6, top) as unknown as Hole;
    });

    const scene = render();
    expect(errorsOf(scene)).toEqual([]);
    const volumes = solidVolumes(scene);
    expect(volumes.length).toBe(1);
    expect(volumes[0]).toBeCloseTo(PLATE_VOLUME - cylinderVolume(6, PLATE.t), 3);
    expect(h.getDimensions()?.diameter).toBe(6);
    expect(h.getFrames()[0].origin.z).toBeCloseTo(PLATE.t, 6);
    // The cut classified the new geometry: one cylindrical wall, rims top and bottom.
    expect(resolved(h.faces()).length).toBe(1);
    expect(resolved(h.startEdges()).length).toBe(1);
    expect(resolved(h.endEdges()).length).toBe(1);
    expect(resolved(h.edges()).length).toBe(3);
  });

  it("drills a blind hole with a 118° drill point", () => {
    plateWithTopConnector((_plate, top) => {
      hole(6, top).depth(5, 118);
    });

    const scene = render();
    expect(errorsOf(scene)).toEqual([]);
    const tip = 3 / Math.tan((118 / 2) * Math.PI / 180);
    const removed = cylinderVolume(6, 5) + coneVolume(6, tip);
    expect(solidVolumes(scene)[0]).toBeCloseTo(PLATE_VOLUME - removed, 3);
  });

  it("drills a flat-bottomed blind hole when no tip angle is given", () => {
    plateWithTopConnector((_plate, top) => {
      hole(6, top).depth(4);
    });

    const scene = render();
    expect(errorsOf(scene)).toEqual([]);
    expect(solidVolumes(scene)[0]).toBeCloseTo(PLATE_VOLUME - cylinderVolume(6, 4), 3);
  });

  it("reads the clearance and counterbore tables for a metric size", () => {
    let h!: Hole;
    plateWithTopConnector((_plate, top) => {
      h = hole('M6', top).clearance('close').counterbore() as unknown as Hole;
    });

    const scene = render();
    expect(errorsOf(scene)).toEqual([]);
    const dims = h.getDimensions()!;
    expect(dims.diameter).toBe(6.4);
    expect(dims.counterbore).toEqual({ diameter: 11, depth: 6.8 });
    expect(dims.fastener).toMatchObject({ standard: 'metric', label: 'M6', type: 'clearance', fit: 'close', major: 6 });
    const removed = cylinderVolume(6.4, PLATE.t) + cylinderVolume(11, 6.8) - cylinderVolume(6.4, 6.8);
    expect(solidVolumes(scene)[0]).toBeCloseTo(PLATE_VOLUME - removed, 3);
  });

  it("defaults a fastener size to a normal-fit clearance hole", () => {
    let h!: Hole;
    plateWithTopConnector((_plate, top) => {
      h = hole('M6', top) as unknown as Hole;
    });

    render();
    expect(h.getDimensions()?.diameter).toBe(6.6);
  });

  it("cuts a tapped hole at the tap drill diameter", () => {
    let h!: Hole;
    let fine!: Hole;
    plateWithTopConnector((_plate, top) => {
      h = hole('M6', top).tapped() as unknown as Hole;
      fine = hole('M8', top).tapped(1).depth(3) as unknown as Hole;
    });

    const scene = render();
    expect(errorsOf(scene)).toEqual([]);
    expect(h.getDimensions()?.diameter).toBe(5);
    expect(h.getDimensions()?.fastener).toMatchObject({ type: 'tapped', pitch: 1 });
    expect(fine.getDimensions()?.diameter).toBe(7);
    expect(fine.getDimensions()?.fastener).toMatchObject({ type: 'tapped', pitch: 1, label: 'M8' });
  });

  it("cuts an explicit countersink", () => {
    plateWithTopConnector((_plate, top) => {
      hole(6, top).countersink(12, 90);
    });

    const scene = render();
    expect(errorsOf(scene)).toEqual([]);
    // The cone from Ø12 at the surface down to Ø6, 3 deep at 90°.
    const depth = 3;
    const frustum = Math.PI * depth / 3 * (6 * 6 + 6 * 3 + 3 * 3);
    const removed = cylinderVolume(6, PLATE.t) + frustum - cylinderVolume(6, depth);
    expect(solidVolumes(scene)[0]).toBeCloseTo(PLATE_VOLUME - removed, 3);
  });

  it("converts inch table values into the file's unit", () => {
    const dims = resolveHoleDimensions({ size: '1/4', fastener: { type: 'clearance', fit: 'normal' }, style: { kind: 'countersink', diameter: null, angle: null }, depth: null, tipAngle: null }, 'mm');
    expect(dims.diameter).toBeCloseTo(0.266 * 25.4, 9);
    expect(dims.countersink).toEqual({ diameter: 0.507 * 25.4, angle: 82 });
    expect(dims.fastener?.major).toBeCloseTo(6.35, 9);

    const same = resolveHoleDimensions({ size: 'M6', fastener: null, style: null, depth: null, tipAngle: null }, 'in');
    expect(same.diameter).toBeCloseTo(6.6 / 25.4, 9);
  });

  it("refuses unknown sizes and table lookups without a size", () => {
    expect(() => resolveHoleDimensions({ size: 'M7', fastener: null, style: null, depth: null, tipAngle: null }, 'mm'))
      .toThrow(/unknown fastener size 'M7'/);
    expect(() => resolveHoleDimensions({ size: 5, fastener: null, style: { kind: 'counterbore', diameter: null, depth: null }, depth: null, tipAngle: null }, 'mm'))
      .toThrow(/needs a fastener size/);
    expect(() => resolveHoleDimensions({ size: 5, fastener: { type: 'tapped', pitch: null }, style: null, depth: null, tipAngle: null }, 'mm'))
      .toThrow(/numeric size is the drilled diameter/);
    expect(() => resolveHoleDimensions({ size: 'M6', fastener: null, style: { kind: 'counterbore', diameter: null, depth: null }, depth: 5, tipAngle: null }, 'mm'))
      .toThrow(/deeper than the hole depth/);
    expect(() => resolveHoleDimensions({ size: 'M6', fastener: { type: 'tapped', pitch: 1.5 }, style: null, depth: null, tipAngle: null }, 'mm'))
      .toThrow(/no 1.5 pitch/);
  });

  it("lists every table size with a coarse tap drill and a fit for each clearance", () => {
    for (const label of ['M3', 'M10', '#10', '3/8']) {
      const found = findFastenerSize(label)!;
      expect(found).not.toBeNull();
      expect(tapDrillFor(found.size, null)?.tapDrill).toBeGreaterThan(0);
      expect(found.size.clearance.close).toBeLessThan(found.size.clearance.normal);
      expect(found.size.clearance.normal).toBeLessThan(found.size.clearance.loose);
      expect(found.size.counterbore.diameter).toBeGreaterThan(found.size.clearance.loose);
    }
    expect(findFastenerSize('m6')?.size.label).toBe('M6');
  });

  it("builds the profile top to bottom on the axis at both ends", () => {
    const profile = holeProfile({
      diameter: 6, counterbore: { diameter: 11, depth: 5 }, countersink: null, depth: 20, tipAngle: 118, fastener: null,
    }, 20);
    expect(profile[0]).toEqual([0, 0]);
    expect(profile.slice(1, 4)).toEqual([[5.5, 0], [5.5, 5], [3, 5]]);
    expect(profile[4]).toEqual([3, 20]);
    expect(profile[5][0]).toBe(0);
    expect(profile[5][1]).toBeGreaterThan(20);
  });
});

describe("hole() placements", () => {
  setupOC();

  it("places holes at exported sketch points: a circle centre and a point entity", () => {
    sketch("xy", () => {
      testRect(PLATE.w, PLATE.d, { at: [-PLATE.w / 2, -PLATE.d / 2] });
    });
    const plate = extrude(PLATE.t).new() as unknown as ExtrudeBase;
    const s = sketch(plate.endFaces(), () => {
      const c = circle([15, 5], 4);
      const p = point([-15, -5]);
      return { c, p };
    });
    const h = hole(3, (s.geometries.c as unknown as SolvedCircle).center(), s.geometries.p as unknown as SolvedPoint) as unknown as Hole;

    const scene = render();
    expect(errorsOf(scene)).toEqual([]);
    expect(solidVolumes(scene)[0]).toBeCloseTo(PLATE_VOLUME - 2 * cylinderVolume(3, PLATE.t), 3);
    const origins = h.getFrames().map(f => [f.origin.x, f.origin.y, f.origin.z].map(v => Math.round(v * 1e6) / 1e6));
    expect(origins).toEqual([[15, 5, PLATE.t], [-15, -5, PLATE.t]]);
    // The sketch is hidden for display only: later features still read its circle.
    expectDisplayConsumed(scene, s as unknown as SceneObject);
    const circleObj = s.geometries.c as unknown as ISceneObject & { getShapes(): unknown[] };
    expect(circleObj.getShapes().length).toBeGreaterThan(0);
  });

  it("hides a guide layout after placing holes on its corners, with an eye to show it again", () => {
    sketch("xy", () => {
      testRect(PLATE.w, PLATE.d, { at: [-PLATE.w / 2, -PLATE.d / 2] });
    });
    const plate = extrude(PLATE.t).new() as unknown as ExtrudeBase;
    const layout = sketch(plate.endFaces(), () => ({ g: line([-15, 5], [15, 5]).guide() }));
    const g = layout.geometries.g as unknown as { start(): never; end(): never };
    const h = hole(3, g.start(), g.end()) as unknown as SceneObject;

    const scene = render();
    expect(errorsOf(scene)).toEqual([]);
    expect(solidVolumes(scene)[0]).toBeCloseTo(PLATE_VOLUME - 2 * cylinderVolume(3, PLATE.t), 3);
    // The hole hides the sketch like an extrude does: the row names its
    // consumer (the timeline eye) and the guide leaves the screen.
    const row = scene.getRenderedObject(layout as unknown as SceneObject)!;
    expect(row.visible).toBe(false);
    expect(row.consumedBy).toBe(h.id);
    expect(scene.getRenderedObject(layout.geometries.g as unknown as SceneObject)!.sceneShapes).toEqual([]);
  });

  it("places holes on the guide of a sketch another feature consumed", () => {
    sketch("xy", () => {
      testRect(PLATE.w, PLATE.d, { at: [-PLATE.w / 2, -PLATE.d / 2] });
    });
    const plate = extrude(PLATE.t).new() as unknown as ExtrudeBase;
    const s = sketch(plate.endFaces(), () => {
      circle([0, 0], 4);
      return { g: line([-20, 10], [20, 10]).guide() };
    });
    const boss = extrude(5).new() as unknown as SceneObject;
    const g = s.geometries.g as unknown as { start(): never; end(): never };
    const h = hole(3, g.start(), g.end()) as unknown as Hole;

    const scene = render();
    expect(errorsOf(scene)).toEqual([]);
    expect(scene.getRenderedObject(s as unknown as SceneObject)!.consumedBy).toBe(boss.id);
    const origins = h.getFrames().map(f => [f.origin.x, f.origin.y, f.origin.z].map(v => Math.round(v * 1e6) / 1e6));
    expect(origins).toEqual([[-20, 10, PLATE.t], [20, 10, PLATE.t]]);
    expect(solidVolumes(scene).at(-1)).toBeCloseTo(PLATE_VOLUME - 2 * cylinderVolume(3, PLATE.t), 3);
  });

  it("places a hole at a face-centre anchor and consumes the anchor's selection", () => {
    sketch("xy", () => {
      testRect(PLATE.w, PLATE.d, { at: [-PLATE.w / 2, -PLATE.d / 2] });
    });
    const plate = extrude(PLATE.t).new() as unknown as ExtrudeBase;
    const anchor = plate.endFaces().center();
    hole(8, anchor);

    const scene = render();
    expect(errorsOf(scene)).toEqual([]);
    expect(solidVolumes(scene)[0]).toBeCloseTo(PLATE_VOLUME - cylinderVolume(8, PLATE.t), 3);
    expect(anchor.getShapes().length).toBe(0);
  });

  it("drills at a connector and at its copy, named by its slot", () => {
    let h!: Hole;
    plateWithTopConnector((_plate, top) => {
      copy("linear", "x", { count: 2, offset: 20 }, top);
      h = hole(6, top, top.instance(1)) as unknown as Hole;
    });

    const scene = render();
    expect(errorsOf(scene)).toEqual([]);
    expect(solidVolumes(scene)[0]).toBeCloseTo(PLATE_VOLUME - 2 * cylinderVolume(6, PLATE.t), 3);
    expect(h.getFrames().map(frame => frame.origin.x)).toEqual([
      expect.closeTo(0, 6),
      expect.closeTo(20, 6),
    ]);
  });

  it("drills out of the surface from a connector turned around", () => {
    plateWithTopConnector((_plate, top) => {
      hole(6, top.rotate("x", 180));
    });

    const scene = render();
    expect(errorsOf(scene)).toEqual([]);
    // Drilling up and away from the top face removes nothing.
    expect(solidVolumes(scene)[0]).toBeCloseTo(PLATE_VOLUME, 3);
  });

  it("cuts only the scoped solids", () => {
    sketch("xy", () => {
      testRect(20, 20, { at: [-10, -10] });
    });
    const lower = extrude(10).new() as unknown as ExtrudeBase;
    sketch("xy", () => {
      testRect(20, 20, { at: [-10, -10] });
    });
    const upper = extrude(30).new() as unknown as ExtrudeBase;
    hole(4, upper.endFaces().center()).scope(upper);

    const scene = render();
    expect(errorsOf(scene)).toEqual([]);
    const volumes = solidVolumes(scene);
    expect(volumes).toHaveLength(2);
    expect(volumes[0]).toBeCloseTo(20 * 20 * 10, 3);
    expect(volumes[1]).toBeCloseTo(20 * 20 * 30 - cylinderVolume(4, 30), 3);
    expect(lower.getShapes().length).toBe(1);
  });

  it("taps the next solid along the axis and keeps it out of the clearance cut", () => {
    sketch("xy", () => {
      testRect(20, 20, { at: [-10, -10] });
    });
    extrude(10).new();
    sketch("xy", () => {
      testRect(20, 20, { at: [-10, -10] });
    });
    const upper = extrude(30).new() as unknown as ExtrudeBase;
    const h = hole('M6', upper.endFaces().center()).clearance('normal').fasten() as unknown as Hole;

    const scene = render();
    expect(errorsOf(scene)).toEqual([]);
    expect(h.getDimensions()?.diameter).toBe(6.6);
    expect(h.getFastenDimensions()?.diameter).toBe(5);
    expect(h.getFastenDimensions()?.fastener).toMatchObject({ type: 'tapped', pitch: 1, label: 'M6' });
    const volumes = solidVolumes(scene);
    expect(volumes).toHaveLength(2);
    expect(volumes[0]).toBeCloseTo(20 * 20 * 10 - cylinderVolume(5, 10), 3);
    expect(volumes[1]).toBeCloseTo(20 * 20 * 30 - cylinderVolume(6.6, 30), 3);
    // Both bores are the hole's own: the clearance wall first, the tapped one after.
    expect(resolved(h.faces())).toHaveLength(2);
    expect(resolved(h.startEdges())).toHaveLength(2);
  });

  it("taps the first solid past an explicit scope at a fine pitch", () => {
    sketch("xy", () => {
      testRect(20, 20, { at: [-10, -10] });
    });
    extrude(10).new();
    sketch("xy", () => {
      testRect(20, 20, { at: [-10, -10] });
    });
    const upper = extrude(30).new() as unknown as ExtrudeBase;
    const h = hole('M8', upper.endFaces().center()).fasten(1).scope(upper) as unknown as Hole;

    const scene = render();
    expect(errorsOf(scene)).toEqual([]);
    expect(h.getFastenDimensions()?.diameter).toBe(7);
    const volumes = solidVolumes(scene);
    expect(volumes[0]).toBeCloseTo(20 * 20 * 10 - cylinderVolume(7, 10), 3);
    expect(volumes[1]).toBeCloseTo(20 * 20 * 30 - cylinderVolume(9, 30), 3);
  });

  it("taps the next solid to a blind depth from the face the axis enters it through", () => {
    sketch("xy", () => {
      testRect(20, 20, { at: [-10, -10] });
    });
    const lower = extrude(10).new() as unknown as ExtrudeBase;
    const top = sketch(lower.endFaces(), () => {
      testRect(20, 20, { at: [-10, -10] });
    });
    const upper = extrude(5, top).new() as unknown as ExtrudeBase;
    const h = hole('M6', upper.endFaces().center()).fasten(null, 4) as unknown as Hole;

    const scene = render();
    expect(errorsOf(scene)).toEqual([]);
    expect(h.getFastenDimensions()).toMatchObject({ diameter: 5, depth: 4 });
    const volumes = solidVolumes(scene);
    expect(volumes).toHaveLength(2);
    // The cover is cleared right through; the base is tapped 4 deep from its top face, 5 below the placement.
    expect(volumes[0]).toBeCloseTo(20 * 20 * 5 - cylinderVolume(6.6, 5), 3);
    expect(volumes[1]).toBeCloseTo(20 * 20 * 10 - cylinderVolume(5, 4), 3);
  });

  it("drills the blind tapped hole with a drill point, and refuses one on a through hole", () => {
    sketch("xy", () => {
      testRect(20, 20, { at: [-10, -10] });
    });
    const lower = extrude(10).new() as unknown as ExtrudeBase;
    const top = sketch(lower.endFaces(), () => {
      testRect(20, 20, { at: [-10, -10] });
    });
    const upper = extrude(5, top).new() as unknown as ExtrudeBase;
    const h = hole('M6', upper.endFaces().center()).fasten(null, 4, 118) as unknown as Hole;

    const scene = render();
    expect(errorsOf(scene)).toEqual([]);
    expect(h.getFastenDimensions()).toMatchObject({ diameter: 5, depth: 4, tipAngle: 118 });
    const volumes = solidVolumes(scene);
    // The depth runs to the shoulder; the 118° point reaches below it.
    const tip = 2.5 / Math.tan((118 / 2) * Math.PI / 180);
    expect(volumes[1]).toBeCloseTo(20 * 20 * 10 - cylinderVolume(5, 4) - coneVolume(5, tip), 3);
    expect(() => hole('M6', upper.endFaces().center()).fasten(null, null, 118)).toThrow(/only with a blind depth/);
  });

  it("keeps a through clearance hole out of the tapped solid inside a part", () => {
    let h!: Hole;
    part("bracket", () => {
      const s = sketch("xy", () => {
        testRect(140, 96, { at: [0, 0] });
      });
      extrude(10, s);
      const s2 = sketch("xy", () => {
        testRect(13, 110, { at: [140, 0] });
      });
      extrude(10, s2).new();
      // On the wall's outer face, drilling back through the wall into the base beside it.
      const seat = connector("seat", select(face().planar().onPlane("yz", 153))) as unknown as Connector;
      h = hole('M6', seat).clearance('normal').fasten(null, 4) as unknown as Hole;
    });

    const scene = render();
    expect(errorsOf(scene)).toEqual([]);
    const volumes = solidVolumes(scene);
    // The part container hands its children's solids out again: each is counted twice.
    const unique = [...new Set(volumes.map(v => v.toFixed(3)))].map(Number);
    expect(unique).toHaveLength(2);
    // The wall is cleared right through; the base only takes the 4 deep tap-drill bore.
    expect(unique[0]).toBeCloseTo(13 * 110 * 10 - cylinderVolume(6.6, 13), 2);
    expect(unique[1]).toBeCloseTo(140 * 96 * 10 - cylinderVolume(5, 4), 2);
    expect(h.getFastenDimensions()).toMatchObject({ diameter: 5, depth: 4 });
  });

  it("taps the solid under its axis when an earlier fastened hole already holds it", () => {
    const { cover, seat } = coverOnBase();
    hole('M6', seat.geometries.l.center()).fasten();
    // The first hole holds the drilled cover and the tapped base now; this
    // statement still names the cover by the extrude that built it.
    hole('M6', seat.geometries.r.center()).fasten().scope(cover);

    const scene = render();
    expect(errorsOf(scene)).toEqual([]);
    const volumes = solidVolumes(scene);
    expect(volumes).toHaveLength(2);
    expect(volumes[0]).toBeCloseTo(COVER_VOLUME - 2 * cylinderVolume(6.6, COVER.t), 3);
    expect(volumes[1]).toBeCloseTo(BASE_VOLUME - 2 * cylinderVolume(5, BASE.t), 3);
  });

  it("cuts only the scoped solid of the two an earlier hole holds", () => {
    const { cover, seat } = coverOnBase();
    hole('M6', seat.geometries.l.center()).fasten();
    hole(4, seat.geometries.r.center()).scope(cover);

    const scene = render();
    expect(errorsOf(scene)).toEqual([]);
    const volumes = solidVolumes(scene);
    expect(volumes).toHaveLength(2);
    // Through all, yet the base below takes only the first hole's tapped bore.
    expect(volumes[0]).toBeCloseTo(COVER_VOLUME - cylinderVolume(6.6, COVER.t) - cylinderVolume(4, COVER.t), 3);
    expect(volumes[1]).toBeCloseTo(BASE_VOLUME - cylinderVolume(5, BASE.t), 3);
  });

  it("taps the solid under each placement's own axis", () => {
    const { seat } = plateOnRails();
    hole('M6', seat.geometries.l.center(), seat.geometries.r.center()).fasten(null, 6);

    const scene = render();
    expect(errorsOf(scene)).toEqual([]);
    const volumes = solidVolumes(scene);
    expect(volumes).toHaveLength(3);
    expect(volumes[0]).toBeCloseTo(RAIL_VOLUME - cylinderVolume(5, 6), 3);
    expect(volumes[1]).toBeCloseTo(RAIL_VOLUME - cylinderVolume(5, 6), 3);
    expect(volumes[2]).toBeCloseTo(PLATE_ON_RAILS_VOLUME - 2 * cylinderVolume(6.6, PLATE_ON_RAILS.t), 3);
  });

  it("refuses .fasten() on a drilled or tapped hole, with a solid, and with nothing below the clearance", () => {
    sketch("xy", () => {
      testRect(20, 20, { at: [-10, -10] });
    });
    const lower = extrude(10).new() as unknown as ExtrudeBase;
    sketch("xy", () => {
      testRect(20, 20, { at: [40, 40] });
    });
    extrude(10).new();
    hole(6, lower.endFaces().center()).fasten();
    hole('M6', lower.endFaces().center()).tapped().fasten();
    // The solid beside the one the hole sits on is never on its axis.
    hole('M6', lower.endFaces().center()).fasten();
    expect(() => hole('M6', lower.endFaces().center()).fasten(lower as any)).toThrow(/takes no solid/);

    const errors = errorsOf(render());
    expect(errors).toHaveLength(3);
    expect(errors[0]).toMatch(/needs a fastener size/);
    expect(errors[1]).toMatch(/goes with a clearance hole/);
    expect(errors[2]).toMatch(/finds no solid along the hole axis past the solid the hole sits on/);
  });

  it("reports a missing placement and a bad size on the row", () => {
    expect(() => hole(6)).toThrow(/at least one placement/);
    expect(() => hole(6, {} as any)).toThrow(/placements must be connectors/);
    plateWithTopConnector((_plate, top) => {
      hole('M99', top);
    });

    const scene = render();
    expect(errorsOf(scene)).toEqual([expect.stringMatching(/hole: hole\(\): unknown fastener size 'M99'/)]);
  });
});

describe("hole() ownership", () => {
  setupOC();

  const POST = { w: 20, h: 30 };
  const POST_VOLUME = POST.w * POST.w * POST.h;

  /** A 60 × 40 × 10 plate with a 20 × 20 × 30 post standing on its top face: two bodies resting against each other. */
  function plateAndPost(): { plate: ExtrudeBase; post: ExtrudeBase } {
    sketch("xy", () => {
      testRect(PLATE.w, PLATE.d, { at: [-PLATE.w / 2, -PLATE.d / 2] });
    });
    const plate = extrude(PLATE.t).new() as unknown as ExtrudeBase;
    sketch(plate.endFaces(), () => {
      testRect(POST.w, POST.w, { at: [-POST.w / 2, -POST.w / 2] });
    });
    const post = extrude(POST.h).new() as unknown as ExtrudeBase;
    return { plate, post };
  }

  /** Whether `shape` is one of `shapes` — the same kernel sub-shape, whatever wrapper holds it. */
  function among(shape: Shape, shapes: Shape[]): boolean {
    return shapes.some(s => s.isSame(shape));
  }

  it("records the wall, the floor and their edges as its own, and none of the plate's", () => {
    sketch("xy", () => {
      testRect(PLATE.w, PLATE.d, { at: [-PLATE.w / 2, -PLATE.d / 2] });
    });
    const plate = extrude(PLATE.t).new() as unknown as ExtrudeBase;
    const s = sketch(plate.endFaces(), () => ({ p: point([0, 0]) }));
    const h = hole(4, s.geometries.p as unknown as SolvedPoint).depth(5) as unknown as Hole;

    const scene = render();
    expect(errorsOf(scene)).toEqual([]);
    const drilled = h.getShapes({}, 'solid')[0];
    expect(drilled.getSubShapes('face')).toHaveLength(8);

    // The cylinder wall and the flat floor; the rim, the floor's circle and
    // the wall's seam — the geometry the accessors hand out.
    expect(h.getAddedFaces()).toHaveLength(2);
    expect(h.getAddedEdges()).toHaveLength(3);
    expect(h.getAddedFaces().every(f => among(f, resolved(h.faces()) as Shape[]))).toBe(true);
    expect(h.getAddedEdges().every(e => among(e, resolved(h.edges()) as Shape[]))).toBe(true);

    // The plate's faces and edges stay the plate's. The five faces the hole
    // never reached are on the drilled solid as they were built, the twelve
    // edges too, and the top face it opened is the plate's own, modified.
    const built = plate.getAddedFaces();
    expect(built).toHaveLength(6);
    expect(built.filter(f => among(f, drilled.getSubShapes('face')))).toHaveLength(5);
    expect(plate.getAddedEdges().filter(e => among(e, drilled.getSubShapes('edge')))).toHaveLength(12);
    expect(h.getAddedFaces().some(f => among(f, built))).toBe(false);
    expect(h.getAddedEdges().some(e => among(e, plate.getAddedEdges()))).toBe(false);
    const modified = plate.getModifiedFaces();
    expect(modified).toHaveLength(1);
    expect(modified[0].modifiedBy).toBe(h);
    expect(among(modified[0].sources[0], built)).toBe(true);
    expect(among(modified[0].results[0], drilled.getSubShapes('face'))).toBe(true);
  });

  it("leaves the body it does not reach with the feature that built it", () => {
    const { plate, post } = plateAndPost();
    const h = hole(4, post.endFaces().center()).depth(5) as unknown as Hole;

    const scene = render();
    expect(errorsOf(scene)).toEqual([]);
    const volumes = solidVolumes(scene);
    expect(volumes).toHaveLength(2);
    expect(volumes[0]).toBeCloseTo(POST_VOLUME - cylinderVolume(4, 5), 3);
    expect(volumes[1]).toBeCloseTo(PLATE_VOLUME, 3);

    // The plate is the solid its extrude built, not a copy the hole handed
    // back — and nothing on it is recorded as the hole's doing.
    expect(plate.getShapes({}, 'solid')).toHaveLength(1);
    expect(plate.getShapes({}, 'solid')[0]).toBe(plate.getAddedShapes()[0]);
    expect(plate.getRemovedShapes()).toEqual([]);
    expect(plate.getModifiedFaces()).toEqual([]);
    expect(plate.getModifiedEdges()).toEqual([]);

    // The hole took the post alone, and changed only the face it entered:
    // resting on the plate rebuilt none of the post's other faces or edges.
    expect(h.getAddedShapes()).toHaveLength(1);
    expect(post.getShapes({}, 'solid')).toEqual([]);
    expect(post.getModifiedFaces()).toHaveLength(1);
    expect(post.getModifiedEdges()).toEqual([]);
    expect(post.getRemovedEdges()).toEqual([]);
  });

  it("cuts every body it runs through, each with a rim where it enters and where it leaves", () => {
    const { plate, post } = plateAndPost();
    const h = hole(4, post.endFaces().center()) as unknown as Hole;

    const scene = render();
    expect(errorsOf(scene)).toEqual([]);
    const volumes = solidVolumes(scene);
    expect(volumes).toHaveLength(2);
    expect(volumes[0]).toBeCloseTo(POST_VOLUME - cylinderVolume(4, POST.h), 3);
    expect(volumes[1]).toBeCloseTo(PLATE_VOLUME - cylinderVolume(4, PLATE.t), 3);

    expect(h.getAddedShapes()).toHaveLength(2);
    expect(plate.getShapes({}, 'solid')).toEqual([]);
    expect(post.getShapes({}, 'solid')).toEqual([]);
    // One wall per body; where the post stands on the plate the hole leaves
    // one and enters the other, a rim of each.
    expect(resolved(h.faces()).length).toBe(2);
    expect(resolved(h.startEdges()).length).toBe(2);
    expect(resolved(h.endEdges()).length).toBe(2);
  });

  it("leaves a body its tool only lands on", () => {
    // As deep as the post is tall: the tool's floor stops on the plate's top
    // face and takes nothing from the plate.
    const { plate, post } = plateAndPost();
    const h = hole(4, post.endFaces().center()).depth(POST.h) as unknown as Hole;

    const scene = render();
    expect(errorsOf(scene)).toEqual([]);
    const volumes = solidVolumes(scene);
    expect(volumes).toHaveLength(2);
    expect(volumes[0]).toBeCloseTo(POST_VOLUME - cylinderVolume(4, POST.h), 3);
    expect(volumes[1]).toBeCloseTo(PLATE_VOLUME, 3);

    expect(plate.getShapes({}, 'solid')[0]).toBe(plate.getAddedShapes()[0]);
    expect(plate.getModifiedFaces()).toEqual([]);
    expect(h.getAddedShapes()).toHaveLength(1);
    // The hole leaves the post through its bottom face: a rim of the post's.
    expect(resolved(h.startEdges()).length).toBe(1);
    expect(resolved(h.endEdges()).length).toBe(1);
  });

  it("repeats without taking the bodies its copies never reach", () => {
    const { plate, post } = plateAndPost();
    const s = sketch(post.endFaces(), () => {
      const c = circle([-5, 0], 2);
      return { c };
    });
    hole(3, (s.geometries.c as unknown as SolvedCircle).center()).depth(5);
    repeat("linear", "x", { count: 2, offset: 10 });

    const scene = render();
    expect(errorsOf(scene)).toEqual([]);
    const volumes = solidVolumes(scene);
    expect(volumes).toHaveLength(2);
    expect(volumes[0]).toBeCloseTo(POST_VOLUME - 2 * cylinderVolume(3, 5), 3);
    expect(volumes[1]).toBeCloseTo(PLATE_VOLUME, 3);

    // Every copy drills the post; the plate stays its extrude's throughout.
    expect(plate.getShapes({}, 'solid')[0]).toBe(plate.getAddedShapes()[0]);
    expect(plate.getRemovedShapes()).toEqual([]);
    expect(post.getShapes({}, 'solid')).toEqual([]);
    const owners = scene.getAllSceneObjects()
      .filter(o => !o.isContainer() && o.getShapes({}, 'solid').length > 0)
      .map(o => o.getType());
    expect(owners.sort()).toEqual(['extrude', 'hole']);
  });
});

describe("hole() under repeat", () => {
  setupOC();

  it("repeats a hole placed at a connector without cloning the connector", () => {
    const out = {} as { top: Connector };
    part("flange", () => {
      sketch("xy", () => {
        circle([0, 0], 100);
      });
      const disc = extrude(10).new() as unknown as ExtrudeBase;
      const seat = sketch(disc.endFaces(), () => {
        const c = circle([35, 0], 6);
        return { c };
      });
      out.top = connector("bolt", (seat.geometries.c as unknown as SolvedCircle).center()) as unknown as Connector;
      hole('M6', out.top).clearance('normal');
      repeat("circular", "z", { count: 4, angle: 360 });
    });

    const scene = render();
    expect(errorsOf(scene)).toEqual([]);
    const volumes = solidVolumes(scene);
    expect(volumes).toHaveLength(1);
    expect(volumes[0]).toBeCloseTo(Math.PI * 50 * 50 * 10 - 4 * cylinderVolume(6.6, 10), 1);
    expect(scene.getAllSceneObjects().filter(o => o instanceof Connector)).toEqual([out.top]);
  });

  it("repeats a hole placed at a sketch point linearly", () => {
    sketch("xy", () => {
      testRect(PLATE.w, PLATE.d, { at: [-PLATE.w / 2, -PLATE.d / 2] });
    });
    const plate = extrude(PLATE.t).new() as unknown as ExtrudeBase;
    const s = sketch(plate.endFaces(), () => {
      const c = circle([-20, 0], 3);
      return { c };
    });
    hole(4, (s.geometries.c as unknown as SolvedCircle).center());
    repeat("linear", "x", { count: 3, offset: 20 });

    const scene = render();
    expect(errorsOf(scene)).toEqual([]);
    expect(solidVolumes(scene)[0]).toBeCloseTo(PLATE_VOLUME - 3 * cylinderVolume(4, PLATE.t), 3);
  });

  it("repeats a fastened hole, every copy tapping the solid the one before tapped", () => {
    const { seat } = coverOnBase();
    hole('M6', seat.geometries.l.center()).fasten();
    repeat("linear", "x", { count: 3, offset: 20 });

    const scene = render();
    expect(errorsOf(scene)).toEqual([]);
    const volumes = solidVolumes(scene);
    expect(volumes).toHaveLength(2);
    expect(volumes[0]).toBeCloseTo(COVER_VOLUME - 3 * cylinderVolume(6.6, COVER.t), 3);
    expect(volumes[1]).toBeCloseTo(BASE_VOLUME - 3 * cylinderVolume(5, BASE.t), 3);
  });

  it("repeats a fastened hole with an explicit scope", () => {
    const { cover, seat } = coverOnBase();
    hole('M6', seat.geometries.l.center()).fasten(null, 6).scope(cover);
    repeat("linear", "x", { count: 3, offset: 20 });

    const scene = render();
    expect(errorsOf(scene)).toEqual([]);
    const volumes = solidVolumes(scene);
    expect(volumes).toHaveLength(2);
    expect(volumes[0]).toBeCloseTo(COVER_VOLUME - 3 * cylinderVolume(6.6, COVER.t), 3);
    expect(volumes[1]).toBeCloseTo(BASE_VOLUME - 3 * cylinderVolume(5, 6), 3);
  });

  it("mirrors a repeated fastened hole, the mirrored copies tapping the solid under them", () => {
    const { seat } = plateOnRails();
    hole('M6', seat.geometries.l.center()).fasten(null, 6);
    const row = repeat("linear", "x", { count: 2, offset: 40 });
    repeat("mirror", "xz", row);

    const scene = render();
    expect(errorsOf(scene)).toEqual([]);
    const volumes = solidVolumes(scene);
    expect(volumes).toHaveLength(3);
    // The row taps one rail; its mirror image the other.
    expect(volumes[0]).toBeCloseTo(RAIL_VOLUME - 2 * cylinderVolume(5, 6), 3);
    expect(volumes[1]).toBeCloseTo(RAIL_VOLUME - 2 * cylinderVolume(5, 6), 3);
    expect(volumes[2]).toBeCloseTo(PLATE_ON_RAILS_VOLUME - 4 * cylinderVolume(6.6, PLATE_ON_RAILS.t), 3);
  });
});
